#!/usr/bin/env node
/**
 * Crow Bot Builder — unattended bridge tick (Phase 1).
 *
 * The bridge's OWN timer (NOT schedules / pipeline-runner — plan §2). Run by
 * pibot-bridge.timer every ~1 min, mirroring mpa-router. For each pi_bot_def
 * with a gmail gateway: search that bot's +alias recipient for threads whose
 * NEWEST message is an un-processed user inbound (To contains the +alias),
 * then drive bridge.handleInbound once with the real gmail sendReply.
 *
 * "Processed" = bot_sessions.updated_at for (bot_id,thread) >= the newest
 * inbound message's date. handleInbound bumps updated_at, so the next tick
 * skips until a NEWER user reply arrives. flock guards against overlap.
 * No Gmail filter/label needed (search-based); a label is a Phase-2 optim.
 */
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { openSync, closeSync, existsSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleInbound } from "./bridge.mjs";
import { reapStalePi } from "./pi_lifecycle.mjs";
import { gmailSenderAllowed } from "./gateways/base.mjs";
import { botsDbPath } from "./instance-paths.mjs";
import { botRuntimeEnabledSync } from "./runtime-gate.mjs";

// gmail_io.mjs is dependency-free and lives beside this file — run it with
// the SAME node running this tick (process.execPath) and derive its path from
// our own location, never from an assumed /home/<user>/crow checkout.
const NODE = process.execPath;
const GIO = fileURLToPath(new URL("./gmail_io.mjs", import.meta.url));
const CROW_DB = botsDbPath();
const LOCK = "/tmp/pibot-bridge-tick.lock";

function db() { const d = new Database(CROW_DB); d.pragma("busy_timeout = 10000"); return d; }
function gio(args, ms = 90000) {
  return new Promise((res) => execFile(NODE, [GIO, ...args], { timeout: ms, maxBuffer: 8e6 },
    (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: so || "", err: se || "" })));
}
function parseResult(out) {
  const m = out.match(/RESULT (\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try { const r = JSON.parse(m[1]); return r.text ? JSON.parse(r.text) : r; } catch { return null; }
}

// crude single-instance guard (systemd already serializes Type=oneshot, this
// is belt-and-suspenders): refuse if a fresh lock file exists.
function acquireLock() {
  try {
    if (existsSync(LOCK)) {
      const age = Date.now() - (statSync(LOCK).mtimeMs);
      if (age < 9 * 60 * 1000) return false; // a tick from <9min ago may still run
    }
    closeSync(openSync(LOCK, "w"));
    return true;
  } catch { return true; }
}

(async () => {
  if (!acquireLock()) { console.log("[tick] another tick holds the lock — skip"); process.exit(0); }
  // F3b: respect the per-instance runtime toggle. Timer keeps firing; when the
  // operator has bot_runtime off, the tick is a no-op (release lock + exit).
  {
    const _g = db();
    let on = false;
    try { on = botRuntimeEnabledSync(_g); } finally { _g.close(); }
    if (!on) { try { unlinkSync(LOCK); } catch {} console.log("[tick] bot_runtime off — skip"); process.exit(0); }
  }
  // Pre-flight: reap any abandoned/stuck/runaway pi from a previously crashed
  // tick before doing more work (plan §10 risk #4). Runs every ~1 min via the
  // existing timer — no extra systemd unit. The pure-bash backstop in
  // ~/bin/memory-watchdog.sh is the independent 5-min safety net.
  try {
    const sweep = reapStalePi({ log: (m) => console.log("[tick] " + m) });
    if (sweep.reaped.length) console.log(`[tick] reaped ${sweep.reaped.length} stale pi (scanned ${sweep.scanned})`);
  } catch (e) { console.error("[tick] reaper error (non-fatal): " + (e && e.message || e)); }
  const d = db();
  let defs = [];
  try {
    defs = d.prepare("SELECT bot_id, definition FROM pi_bot_defs WHERE enabled=1").all();
  } catch { console.log("[tick] pi_bot_defs missing — nothing to do"); process.exit(0); }

  let processed = 0;
  for (const row of defs) {
    let def; try { def = JSON.parse(row.definition || "{}"); } catch { continue; }
    const gw = (def.gateways || []).find((g) => g.type === "gmail" && g.address);
    if (!gw) continue;
    const alias = gw.address;                         // e.g. user+<x>@example.com
    const plus = (alias.match(/\+([^@]+)@/) || [])[1]; // <x>

    const srch = await gio(["search", "--query", `to:${alias} newer_than:2d`, "--max", "10"]);
    const sres = parseResult(srch.out);
    const threads = (sres && (sres.data?.threads || sres.threads)) || [];
    for (const th of threads) {
      const tid = th.id || th.thread_id || th.threadId;
      if (!tid) continue;
      const tr = await gio(["thread", "--id", tid], 60000);
      const tres = parseResult(tr.out);
      const msgs = (tres && (tres.data?.messages || tres.messages)) || [];
      if (!msgs.length) continue;
      const newest = msgs[msgs.length - 1];
      const to = String(newest.to || (newest.headers && newest.headers.to) || "");
      const isUserInbound = to.includes("+" + plus + "@");
      if (!isUserInbound) continue;                   // newest is a bot reply -> nothing to do
      // Gmail MCP returns the full plain-text body under `body_text` (current
       // field name) or `plaintext_body` (legacy). Both ~unlimited length.
       // `snippet` is Gmail's 200-char preview — last-resort fallback ONLY
       // when both full-body fields are absent. Previously this read
       // plaintext_body || snippet, which silently truncated EVERY inbound to
       // ~200 chars (bot only saw the message preview, not what the user typed).
      const body = (newest.body_text || newest.plaintext_body || newest.snippet || "").trim();
      const msgDate = Date.parse(newest.date || (newest.headers && newest.headers.date) || "") || Date.now();

      // Reply-recipient = actual sender of `newest` (so the bot's reply lands
      // back in the user's inbox, not the bot's own mailbox — it was once
      // hardcoded to the operator's address, which routed replies to the bot
      // itself). The sender wall derives from the bot def's per-gateway
      // allowlist (gw.allowlist — the same field the Bot Builder edits) and
      // FAILS CLOSED when unconfigured: an empty allowlist means nobody can
      // trigger a bot reply, never everybody. That's the safety wall against
      // a third party emailing the +alias and getting a bot reply.
      const fromHeader = String(newest.from || (newest.headers && newest.headers.from) || "");
      const fromMatch = fromHeader.match(/<([^>]+)>/);
      const replyTo = (fromMatch ? fromMatch[1] : fromHeader).trim().toLowerCase();
      if (!gmailSenderAllowed(gw.allowlist, replyTo)) {
        console.log(`[tick] skip thread=${tid} — sender '${replyTo}' not in this gateway's allowlist${Array.isArray(gw.allowlist) && gw.allowlist.length ? "" : " (no allowlist configured — set one on the bot's Gateways tab)"}`);
        continue;
      }

      const sess = d.prepare("SELECT updated_at, status FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(row.bot_id, tid);
      const sessTs = sess ? Date.parse(sess.updated_at + "Z") || 0 : 0;
      if (sess && sess.status !== "stopped" && sessTs >= msgDate) continue; // already processed this inbound
      if (sess && sess.status === "stopped" && !/\bresume\b/i.test(body)) {
        // honor stop until the user explicitly says resume
        continue;
      }

      console.log(`[tick] bot=${row.bot_id} thread=${tid} from=${replyTo} -> handleInbound (${body.slice(0, 50)})`);
      try {
        const r = await handleInbound({
          bot_id: row.bot_id, gateway_thread_id: tid, user_message: body,
          sendReply: async (text) => {
            // --reply-to <alias> sets the Reply-To: header on the outbound
            // so when the user clicks Reply in Gmail, it routes back to the
            // bot's +alias (which bridge_tick monitors) rather than the
            // bot's bare From: address (which nothing monitors). Without
            // this, the user's reply lands at the bot's bare From: address
            // and the bot never sees the follow-up.
            await gio(["reply", "--to", replyTo,
              "--reply-to", alias,
              "--subject", "Re: " + (newest.subject || (newest.headers && newest.headers.subject) || "pibot"),
              "--thread", tid, "--body", text]);
          },
          log: (m) => console.log("  [bridge] " + m),
        });
        processed++;
        console.log(`[tick] done thread=${tid} action=${r.action}`);
      } catch (e) {
        console.error(`[tick] handleInbound failed thread=${tid}: ${e.message}`);
      }
    }
  }
  // Background-job drain (Plan B Part 1 Stage 2). On a Gmail-only deployment with
  // NO pibot-gateways host, this is the only place queued bot_jobs get run +
  // delivered. Where a gateways host IS present it's the primary runner; the
  // atomic single-row claim + the reserved-slot gate inside tickJobs make running
  // here too safe (whoever claims first wins, never exceeding the pi budget). One
  // job per invocation keeps this oneshot tick bounded; a long job (up to the 10-
  // min JOB_TIMEOUT) holds the tick's lock, delaying the next mail poll — the
  // accepted tradeoff for a host with no dedicated job runner.
  try {
    const { tickJobs } = await import("./job_runner.mjs");
    const { makeChannelDeliverer } = await import("./gateways/deliver.mjs");
    const deliverChannel = makeChannelDeliverer({ log: (m) => console.log("[tick:deliver] " + m) });
    const jr = await tickJobs({ log: (m) => console.log("[tick:jobs] " + m), deliverChannel });
    if (jr && jr.ran) console.log(`[tick] background job ${jr.ran} → ${jr.status}`);
  } catch (e) { console.error("[tick] job drain error (non-fatal): " + (e && e.message || e)); }

  try { unlinkSync(LOCK); } catch {}
  console.log(`[tick] complete — processed ${processed} inbound`);
  process.exit(0);
})().catch((e) => { try { unlinkSync(LOCK); } catch {} console.error("[tick] CRASH " + (e && e.stack || e)); process.exit(1); });
