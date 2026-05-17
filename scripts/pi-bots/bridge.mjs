#!/usr/bin/env node
/**
 * Crow Bot Builder — Bot Session Bridge (Phase 1, Gmail-shaped, thin).
 *
 * Maps {bot, gateway thread} <-> a resumable pi session, relays one turn,
 * persists bot_sessions, supports stop. The spawn / line-buffered-NDJSON /
 * SIGTERM->SIGKILL core is the S1/S2-verified subagent pattern (spawn with an
 * explicit argv array, NO shell — execFile-safe); pi is driven over the
 * S2-proven `--mode rpc` JSONL protocol (prompt / get_state / abort /
 * --session resume). Transport-agnostic: handleInbound() takes the exact
 * {bot_id, gateway_thread_id, user_message} shape router_dispatch.mjs hands
 * off, plus an injectable sendReply. The real Gmail adapter (router_dispatch
 * reuse) is a thin wrapper added when a human runs the live §9 E2E; the core
 * loop is proven here via --inject / bridge_e2e.mjs with a capturing sendReply.
 *
 * Authorities (plan §1): bot_sessions.status = runtime (this module owns it);
 * tasks_items.status = board (the tasks tool owns it, via pi); plan file =
 * work content. crow.db opened with busy_timeout only, NO journal_mode pragma;
 * pi spawned with CROW_JOURNAL_MODE=DELETE (memory crowdb-wal-flip-new-consumers).
 */
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countLivePi, LIFECYCLE_DEFAULTS } from "./pi_lifecycle.mjs";

const HOME = "/home/kh0pp";
const NODE = HOME + "/.nvm/versions/node/v20.20.2/bin/node";
const PI_CLI = HOME + "/.nvm/versions/node/v20.20.2/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js";
const CROW_DB = process.env.CROW_DB_PATH || HOME + "/.crow-mpa/data/crow.db";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
const TURN_TIMEOUT_MS = Number(process.env.PIBOT_TURN_TIMEOUT_MS || 600000);

function db(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }

function toolAllowlist(def) {
  const builtin = (def.tools && def.tools.pi_builtin) || [];
  const mcp = ((def.tools && def.tools.crow_mcp) || []).map((s) => "mcp__" + s.replace("/", "__"));
  return [...builtin, ...mcp].join(",");
}

class PiRpc {
  constructor(opts) {
    const def = opts.def, sessionDir = opts.sessionDir;
    const modelKey = (def.models && def.models.default ? def.models.default : "crow-local/qwen3.6-35b-a3b").split("/").pop();
    const args = [PI_CLI, "--mode", "rpc", "--provider", "crow-local", "--model", modelKey,
      "--session-dir", sessionDir + "/sessions"];
    const tools = toolAllowlist(def);
    if (tools) args.push("--tools", tools);
    if (opts.appendSystemPromptFile) args.push("--append-system-prompt", opts.appendSystemPromptFile);
    if (opts.piSessionId) args.push("--session", opts.piSessionId);
    const env = Object.assign({}, process.env,
      { PATH: HOME + "/.nvm/versions/node/v20.20.2/bin:" + (process.env.PATH || ""), PI_PROVIDER: "crow-local" },
      def.spawn_env || {});
    this.proc = spawn(NODE, args, { cwd: sessionDir, env, stdio: ["pipe", "pipe", "pipe"] });
    this.events = []; this.responses = []; this.stderr = ""; this._b = ""; this._w = []; this.badStdout = 0;
    this.proc.stdout.on("data", (c) => {
      this._b += c.toString("utf8");
      let nl;
      while ((nl = this._b.indexOf("\n")) >= 0) {
        let ln = this._b.slice(0, nl); this._b = this._b.slice(nl + 1);
        if (ln.endsWith("\r")) ln = ln.slice(0, -1);
        if (!ln) continue;
        let m; try { m = JSON.parse(ln); } catch { this.badStdout++; continue; }
        (m.type === "response" ? this.responses : this.events).push(m);
        for (const w of this._w.slice()) if (w.p(m)) { this._w.splice(this._w.indexOf(w), 1); w.r(m); }
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
    this.exited = new Promise((res) => this.proc.on("exit", (c) => res(c == null ? -1 : c)));
  }
  send(o) { this.proc.stdin.write(JSON.stringify(o) + "\n"); }
  waitFor(p, ms, label) {
    return new Promise((resolve, reject) => {
      const hit = this.events.find(p) || this.responses.find(p);
      if (hit) return resolve(hit);
      const w = { p, r: resolve }; this._w.push(w);
      setTimeout(() => { const i = this._w.indexOf(w); if (i >= 0) { this._w.splice(i, 1); reject(new Error("timeout:" + label + " (stderr " + this.stderr.slice(-200) + ")")); } }, ms);
    });
  }
  async prompt(message, ms) {
    this.send({ type: "prompt", message });
    await this.waitFor((m) => m.type === "response" && m.command === "prompt", 20000, "prompt-ack");
    return this.waitFor((m) => m.type === "agent_end", ms, "agent_end");
  }
  async getState() { this.send({ type: "get_state" }); return this.waitFor((m) => m.type === "response" && m.command === "get_state", 15000, "get_state"); }
  async abort() { this.send({ type: "abort" }); return this.waitFor((m) => m.type === "response" && m.command === "abort", 15000, "abort").catch(() => null); }
  assistantText() {
    let last = null; for (const e of this.events) if (e.type === "agent_end") last = e;
    const ms = last ? last.messages : this.events.filter((e) => e.type === "message_end").map((e) => e.message);
    let t = ""; for (const mm of ms || []) if (mm && mm.role === "assistant" && Array.isArray(mm.content))
      t += mm.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return t.trim();
  }
  toolCalls() { return this.events.filter((e) => e.type === "tool_execution_end").map((e) => ({ tool: e.toolName, isError: !!e.isError })); }
  async close() { try { this.proc.stdin.end(); } catch (e) {} this.proc.kill("SIGTERM");
    const k = setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch (e) {} }, 5000); await this.exited; clearTimeout(k); }
}

function loadBot(botId) {
  const c = db(CROW_DB);
  const row = c.prepare("SELECT bot_id, display_name, definition, enabled FROM pi_bot_defs WHERE bot_id=?").get(botId);
  c.close();
  if (!row) throw new Error("unknown bot " + botId);
  if (!row.enabled) throw new Error("bot " + botId + " disabled");
  return Object.assign({}, row, { def: JSON.parse(row.definition || "{}") });
}
function kanbanText(projectId) {
  if (projectId == null) return "(no project linked)";
  const t = db(TASKS_DB);
  const rows = t.prepare("SELECT id,title,status FROM tasks_items WHERE project_id=? AND parent_id IS NULL ORDER BY id").all(projectId);
  t.close();
  return rows.length ? rows.map((r) => "  #" + r.id + " [" + r.status + "] " + r.title).join("\n") : "  (no cards)";
}
function cardStatus(cardId) { const t = db(TASKS_DB); const r = t.prepare("SELECT status FROM tasks_items WHERE id=?").get(cardId); t.close(); return r ? r.status : null; }
function planFor(def, cardId) {
  const p = def.session_dir + "/plans/" + cardId + ".md";
  return { path: p, exists: existsSync(p), text: existsSync(p) ? readFileSync(p, "utf8") : "" };
}
function getSession(botId, threadId) {
  const c = db(CROW_DB);
  const r = c.prepare("SELECT * FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(botId, threadId);
  c.close(); return r || null;
}
function upsertSession(s) {
  const c = db(CROW_DB);
  if (s.id) {
    c.prepare("UPDATE bot_sessions SET pi_session_id=?, pi_session_dir=?, project_id=?, card_id=?, plan_path=?, status=?, control=?, updated_at=datetime('now') WHERE id=?")
      .run(s.pi_session_id == null ? null : s.pi_session_id, s.pi_session_dir == null ? null : s.pi_session_dir, s.project_id == null ? null : s.project_id, s.card_id == null ? null : s.card_id, s.plan_path == null ? null : s.plan_path, s.status, s.control, s.id);
  } else {
    const info = c.prepare("INSERT INTO bot_sessions (bot_id,pi_session_id,pi_session_dir,gateway_type,gateway_thread_id,project_id,card_id,plan_path,status,control) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(s.bot_id, s.pi_session_id == null ? null : s.pi_session_id, s.pi_session_dir == null ? null : s.pi_session_dir, s.gateway_type || "gmail", s.gateway_thread_id, s.project_id == null ? null : s.project_id, s.card_id == null ? null : s.card_id, s.plan_path == null ? null : s.plan_path, s.status, s.control || "run");
    s.id = info.lastInsertRowid;
  }
  c.close(); return s;
}
function parseCardIntent(msg) {
  const m = /\b(?:do\s+)?card\s*#?\s*(\d+)\b/i.exec(msg) || /\bexecute\s+#?(\d+)\b/i.exec(msg);
  return m ? Number(m[1]) : null;
}

export async function handleInbound(opts) {
  const bot_id = opts.bot_id, gateway_thread_id = opts.gateway_thread_id, user_message = opts.user_message;
  const sendReply = opts.sendReply, log = opts.log || function () {};
  const bot = loadBot(bot_id);
  const def = bot.def;
  const projectId = def.project_id == null ? null : def.project_id;
  mkdirSync(def.session_dir + "/sessions", { recursive: true });

  let session = getSession(bot_id, gateway_thread_id);
  if (session && session.control === "stop") {
    session.status = "stopped"; upsertSession(session);
    await sendReply("Session is stopped. Reply 'resume' to continue.");
    return { action: "stopped" };
  }

  const wantCard = parseCardIntent(user_message);
  const resume = !!(session && session.pi_session_id);

  if (wantCard != null) {
    const st = cardStatus(wantCard);
    if (st === "done") {
      log("card " + wantCard + " already done — no re-exec");
      if (!session) session = upsertSession({ bot_id, gateway_thread_id, project_id: projectId, status: "waiting-user" });
      await sendReply("Card #" + wantCard + " is already done — nothing to do.");
      return { action: "noop-done", cardId: wantCard };
    }
  }

  // Global pi concurrency gate (plan §10 risk #4). Spawn-per-turn normally
  // keeps <=1 live pi; refuse to pile on past the cap. Return WITHOUT mutating
  // bot_sessions so the next bridge tick reprocesses this same inbound (the
  // tick keys "processed" off bot_sessions.updated_at, which we leave stale).
  const livePi = countLivePi();
  if (livePi >= LIFECYCLE_DEFAULTS.maxPi) {
    log("pi capacity reached (" + livePi + "/" + LIFECYCLE_DEFAULTS.maxPi + ") — deferring; tick will retry");
    return { action: "deferred", reason: "pi-capacity", livePi };
  }

  const sysFile = join(mkdtempSync(join(tmpdir(), "pibot-")), "sys.md");
  writeFileSync(sysFile, def.system_prompt || "You are a Crow bot.", { mode: 0o600 });

  const cardId = wantCard != null ? wantCard : (session ? session.card_id : null);
  const plan = cardId != null ? planFor(def, cardId) : { path: null, exists: false, text: "" };

  let promptText;
  if (wantCard == null && !resume) {
    promptText = "A user messaged you over the gateway. Project #" + projectId + " Kanban:\n" +
      kanbanText(projectId) + "\n\nUser said: \"" + user_message + "\"\n\n" +
      "Reply briefly: greet, list the card numbers above, and ask which card to do. Do NOT call any tool yet.";
  } else if (cardId != null) {
    promptText = "Work the following card for project #" + projectId + ".\n\nCARD #" + cardId +
      " (current board status: " + cardStatus(cardId) + ").\nPLAN FILE (" + plan.path + "):\n---\n" +
      (plan.text || "(plan file missing)") + "\n---\n\nUser said: \"" + user_message + "\"\n\n" +
      "Do the work the plan describes. Use the tasks_* tools (scoped to project " + projectId +
      ") to set this card in_progress, then done. Use the write/edit tools to record your result " +
      "under the plan file's \"## Result\" section. When finished, reply with a short summary for " +
      "the gateway thread. One card only.";
  } else {
    promptText = "Project #" + projectId + " Kanban:\n" + kanbanText(projectId) + "\n\nUser said: \"" +
      user_message + "\"\n\nReply briefly and ask which card number to do. Do NOT call any tool.";
  }

  session = upsertSession(Object.assign({}, session || {}, {
    bot_id, gateway_thread_id, project_id: projectId,
    card_id: cardId == null ? null : cardId, plan_path: plan.path,
    pi_session_dir: def.session_dir + "/sessions", status: "active", control: "run",
  }));

  const pi = new PiRpc({ def, sessionDir: def.session_dir, piSessionId: resume ? session.pi_session_id : null, appendSystemPromptFile: sysFile });
  let result;
  try {
    const st0 = await pi.getState().catch(() => null);
    await pi.prompt(promptText, TURN_TIMEOUT_MS);
    const st1 = await pi.getState().catch(() => null);
    const piSessionId = (st1 && st1.data && st1.data.sessionId) || (st0 && st0.data && st0.data.sessionId) || session.pi_session_id || null;
    const text = pi.assistantText() || "(no reply)";
    const calls = pi.toolCalls();
    const newCardStatus = cardId != null ? cardStatus(cardId) : null;
    const status = newCardStatus === "done" ? "done" : "waiting-user";
    session.pi_session_id = piSessionId;
    session.status = status; session.control = "run";
    upsertSession(session);
    await sendReply(text);
    result = { action: cardId != null ? "executed" : "asked", cardId, cardStatus: newCardStatus,
      piSessionId, toolCalls: calls, replyPreview: text.slice(0, 120), stdoutClean: pi.badStdout === 0 };
    log("turn done: action=" + result.action + " card=" + cardId + " status=" + newCardStatus + " tools=" + calls.length + " clean=" + result.stdoutClean);
  } catch (e) {
    session.status = "error"; upsertSession(session);
    await sendReply("(bridge error: " + e.message + ")");
    result = { action: "error", error: e.message };
  } finally {
    await pi.close();
  }
  return result;
}

export function stopSession(botId, threadId) {
  const s = getSession(botId, threadId);
  if (!s) return { ok: false, reason: "no session" };
  s.control = "stop"; s.status = "stopped"; upsertSession(s);
  return { ok: true, sessionId: s.id };
}

if (import.meta.url === "file://" + process.argv[1]) {
  const a = process.argv.slice(2);
  if (a.includes("--stop")) {
    const bot = a[a.indexOf("--bot") + 1], thread = a[a.indexOf("--thread") + 1];
    console.log(JSON.stringify(stopSession(bot, thread))); process.exit(0);
  }
  const inj = a[a.indexOf("--inject") + 1];
  if (!inj) { console.error("usage: bridge.mjs --inject '<json>' | --stop --bot B --thread T"); process.exit(2); }
  const payload = JSON.parse(inj);
  handleInbound(Object.assign({}, payload, {
    log: (m) => console.error("[bridge] " + m),
    sendReply: async (t) => console.log("REPLY>>>\n" + t + "\n<<<REPLY"),
  })).then((r) => { console.log("RESULT " + JSON.stringify(r)); process.exit(r.action === "error" ? 1 : 0); })
    .catch((e) => { console.error("BRIDGE CRASH " + e.stack); process.exit(2); });
}
