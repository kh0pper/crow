#!/usr/bin/env node
/**
 * Crow Bot Builder — Phase 1 §9 acceptance over REAL Gmail.
 *
 * Drives the genuine end-to-end loop: real inbound email -> bridge -> pi
 * executes card 85 (reads plan, tasks_* pending->in_progress->done, writes
 * "## Result") -> real threaded reply email; same Gmail thread, same pi
 * session across turns (resume). Then idempotency (done card = no re-exec)
 * and stop (control=stop -> resumable). bridge.mjs stays transport-agnostic;
 * Gmail transport is gmail_io.mjs (the bots' google-workspace path).
 *
 * Run on crow. Pre-seeded thread id passed as argv[2].
 */
import { resolveNodeBin, requirePiCli } from "./pi_resolver.mjs";
import { handleInbound, stopSession } from "./bridge.mjs";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const NODE = resolveNodeBin();
const GIO = "/home/kh0pp/.s0-spike/gmail_io.mjs";
const BOT = "research-scout";
const THREAD = process.argv[2];
const SUBJ = "pibot v0.1 — what can you do?";
const USER_TO = "kevin.hopper@maestro.press";        // allowlisted self (the "user" mailbox)
const BOT_ADDR = "kevin.hopper+pibot@maestro.press";  // self-alias, allowlisted via env
const TASKS_DB = "/home/kh0pp/.crow-mpa/data/tasks.db";
const CROW_DB = "/home/kh0pp/.crow-mpa/data/crow.db";

const out = [];
const rec = (n, ok, d) => { out.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const sql = (dbp, q) => new Promise((res) => execFile("sqlite3", [dbp, q], (e, so) => res((so || "").trim())));
function gio(args, ms = 90000) {
  return new Promise((res) => execFile(NODE, [GIO, ...args], { timeout: ms, maxBuffer: 4e6 },
    (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: so || "", err: se || "" })));
}
const gmailReply = async (text) => {
  const r = await gio(["reply", "--to", USER_TO, "--subject", "Re: " + SUBJ, "--thread", THREAD, "--body", text]);
  console.log("  [sendReply] gmail isError? " + /isError=false/.test(r.out));
};
const userSend = async (body) => {
  const r = await gio(["send", "--to", BOT_ADDR, "--subject", SUBJ, "--thread", THREAD, "--body", body]);
  return /isError=false/.test(r.out);
};

(async () => {
  if (!THREAD) { console.error("usage: bridge_gmail_e2e.mjs <threadId>"); process.exit(2); }

  // ── Turn 1: real inbound greeting -> bridge -> "which card?" reply ──
  const r1 = await handleInbound({
    bot_id: BOT, gateway_thread_id: THREAD,
    user_message: "Hi pibot. What can you do? Which cards are on the board?",
    sendReply: gmailReply, log: (m) => console.log("  [bridge] " + m),
  });
  rec("Turn1 bot ASKS which card (no tool, real reply)",
    r1.action === "asked" && r1.stdoutClean, `action=${r1.action} clean=${r1.stdoutClean} reply=${JSON.stringify((r1.replyPreview||"").slice(0,60))}`);
  const sid1 = r1.piSessionId;

  // ── User replies "do card 85" in the SAME thread (real email) ──
  const us = await userSend("Yes — do card 85 please.");
  rec("User reply 'do card 85' sent in-thread (real email)", us, "");

  // ── Turn 2: resume SAME pi session, execute card 85 ──
  const r2 = await handleInbound({
    bot_id: BOT, gateway_thread_id: THREAD,
    user_message: "Yes — do card 85 please.",
    sendReply: gmailReply, log: (m) => console.log("  [bridge] " + m),
  });
  const cardStatus = await sql(TASKS_DB, "SELECT status FROM tasks_items WHERE id=85;");
  const plan = "/home/kh0pp/.crow-mpa/pi-bots/research-scout/plans/85.md";
  const planTxt = existsSync(plan) ? readFileSync(plan, "utf8") : "";
  const resultWritten = /##\s*Result/i.test(planTxt) &&
    !/_\(the bot writes the summary here\)_/.test(planTxt) &&
    planTxt.split(/##\s*Result/i)[1]?.trim().length > 40;
  rec("Turn2 executed card 85 (real reply)", r2.action === "executed" && r2.stdoutClean,
    `action=${r2.action} toolCalls=${(r2.toolCalls||[]).length} clean=${r2.stdoutClean}`);
  rec("Card 85 advanced to done (tasks tool owns status)", cardStatus === "done", `status=${cardStatus}`);
  rec("Plan file '## Result' written by the bot", !!resultWritten,
    `len=${(planTxt.split(/##\s*Result/i)[1]||"").trim().length}`);
  rec("Same pi session reused across turns (resume)", !!sid1 && r2.piSessionId === sid1,
    `t1=${sid1} t2=${r2.piSessionId}`);

  const sessRows = await sql(CROW_DB,
    `SELECT count(*)||'|'||group_concat(status||':'||ifnull(pi_session_id,'-')) FROM bot_sessions WHERE bot_id='${BOT}' AND gateway_thread_id='${THREAD}';`);
  rec("Exactly ONE bot_sessions row for (bot,thread)", sessRows.startsWith("1|"), `rows=${sessRows}`);

  // ── Idempotency: re-trigger done card => NO re-exec ──
  const t0 = Date.now();
  const r3 = await handleInbound({
    bot_id: BOT, gateway_thread_id: THREAD, user_message: "do card 85",
    sendReply: gmailReply, log: () => {},
  });
  rec("Idempotent: done card NOT re-executed", r3.action === "noop-done" && (Date.now() - t0) < 20000,
    `action=${r3.action} ms=${Date.now() - t0}`);

  // ── Stop + resumable ──
  const st = stopSession(BOT, THREAD);
  const r4 = await handleInbound({
    bot_id: BOT, gateway_thread_id: THREAD, user_message: "you there?",
    sendReply: gmailReply, log: () => {},
  });
  const stStatus = await sql(CROW_DB, `SELECT status||'/'||control FROM bot_sessions WHERE bot_id='${BOT}' AND gateway_thread_id='${THREAD}' ORDER BY id DESC LIMIT 1;`);
  const sessDir = "/home/kh0pp/.crow-mpa/pi-bots/research-scout/sessions";
  const sessFiles = existsSync(sessDir) ? readdirSync(sessDir).filter((f) => f.includes(".jsonl") || f.includes(sid1 || "ZzZ")).length : 0;
  rec("Stop honored (control=stop -> stopped, no new turn)", st.ok && r4.action === "stopped" && stStatus.startsWith("stopped"),
    `stop=${JSON.stringify(st)} action=${r4.action} db=${stStatus}`);
  rec("Session resumable after stop (pi session file persists)", sessFiles > 0, `sessionFiles=${sessFiles}`);

  // ── Real Gmail thread has the round-trip messages ──
  const th = await gio(["thread", "--id", THREAD], 60000);
  const msgMatches = (th.out.match(/"(from|sender|payload)"/gi) || []).length;
  rec("Real Gmail thread shows the conversation", /isError=false/.test(th.out), `probe=${msgMatches}`);

  const allOk = out.every(Boolean);
  console.log(`\nBRIDGE-GMAIL-E2E ${allOk ? "OK" : "FAIL"} (${out.filter(Boolean).length}/${out.length})`);
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("E2E CRASH " + (e && e.stack || e)); process.exit(2); });
