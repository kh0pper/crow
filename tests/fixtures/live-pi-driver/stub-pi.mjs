#!/usr/bin/env node
/**
 * A protocol-speaking stub pi for the live pi driver tests (grown from the one in
 * tests/bridge-board-rail.test.js). It speaks pi's RPC mode on stdio and writes a pi-shaped
 * session file `<--session-dir>/<ts>_<id>.jsonl`: a header, then a user and an assistant
 * message per prompt. `--session <id>` appends to that id's existing file.
 *
 * `--list-models` prints pi's table (header row, then `stub  m1`, i.e. the key stub/m1) and
 * exits 0, so checkPiModel never waits out its 15 s listing timeout.
 *
 * Env knobs (the bridge passes PIBOT_TEST_* through to pi):
 *   PIBOT_TEST_REPLIES     JSON array of reply texts, one per prompt of the session
 *                          (the last one repeats; absent = "ok")
 *   PIBOT_TEST_HANG=1      ack the prompt and never end the turn
 *   PIBOT_TEST_CRASH=1     ack the prompt, then exit 1
 *   PIBOT_TEST_NO_JSONL=1  write no session file (not "..._NO_SESSION": SECRET_NAME_RE matches
 *                          SESSION, so childEnv and the bridge's env scrub would drop it)
 *   PIBOT_TEST_IGNORE_TERM=1 ignore SIGTERM and stdin EOF (only SIGKILL stops it)
 *   PIBOT_TEST_MODEL_ERROR_ON_TURN=N  the Nth prompt of the session (1-based) records a failed
 *                          model call the way real pi does: an assistant message with no content,
 *                          stopReason "error" and an errorMessage
 *   PIBOT_TEST_FRESH_ID_ON_RESUME=1  ignore --session: a resume starts a new pi session id and file
 *   PIBOT_TEST_SKIP_USER_ON_TURN=N   the Nth prompt of the session (1-based) records no user message
 *   PIBOT_TEST_CRASH_ON_TURN=N       ack the Nth prompt of the session (1-based), then exit 1
 *   (none of these say "SESSION": SECRET_NAME_RE would strip the knob)
 *   PIBOT_TEST_CAPTURE     a file that gets one JSON line { prompt, sessionId, pid, ignoresTerm, runMarker } per prompt
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes("--list-models")) {
  process.stdout.write("provider  model\nstub  m1\n");
  process.exit(0);
}
// Ignoring SIGTERM also means outliving stdin EOF (the bridge's close() ends stdin), so only a
// SIGKILL can stop this stub.
if (process.env.PIBOT_TEST_IGNORE_TERM === "1") { process.on("SIGTERM", () => {}); setInterval(() => {}, 60_000); }

const env = process.env;
const sessionDir = arg("--session-dir");
const writeSession = env.PIBOT_TEST_NO_JSONL !== "1" && !!sessionDir;
let replies = [];
try { replies = JSON.parse(env.PIBOT_TEST_REPLIES || "[]"); } catch { /* none */ }

const resumeId = env.PIBOT_TEST_FRESH_ID_ON_RESUME === "1" ? undefined : arg("--session");
const sessionId = resumeId || randomUUID();
let sessionFile = null;
if (writeSession && resumeId) {
  const hit = existsSync(sessionDir) ? readdirSync(sessionDir).find((n) => n.endsWith(`_${resumeId}.jsonl`)) : null;
  if (hit) sessionFile = join(sessionDir, hit);
}
let lastId = null;
const now = () => new Date().toISOString();

/** Prompts already in the session file (selects the reply index across per-turn processes). */
function priorPrompts() {
  if (!sessionFile || !existsSync(sessionFile)) return 0;
  let n = 0;
  for (const l of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o.type === "message" && o.message && o.message.role === "user") n++; if (o.id) lastId = o.id; } catch { /* skip */ }
  }
  return n;
}

function record(role, text, failed = null) {
  if (!writeSession) return;
  if (!sessionFile) {
    mkdirSync(sessionDir, { recursive: true });
    sessionFile = join(sessionDir, `${now().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    appendFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now(), cwd: process.cwd() }) + "\n");
  }
  const id = randomUUID().slice(0, 8);
  const message = role === "user"
    ? { role, content: [{ type: "text", text }], timestamp: Date.now() }
    : failed
      ? { role, content: [], provider: "stub", model: "m1", stopReason: "error", errorMessage: failed, timestamp: Date.now() }
      : { role, content: [{ type: "text", text }], provider: "stub", model: "m1", stopReason: "stop", timestamp: Date.now() };
  appendFileSync(sessionFile, JSON.stringify({ type: "message", id, parentId: lastId, timestamp: now(), message }) + "\n");
  lastId = id;
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "get_state") {
      out({ type: "response", command: "get_state", id: m.id, success: true, data: { sessionId } });
    } else if (m.type === "get_session_stats") {
      out({ type: "response", command: "get_session_stats", id: m.id, success: true, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });
    } else if (m.type === "prompt") {
      const n = priorPrompts();
      if (env.PIBOT_TEST_CAPTURE) appendFileSync(env.PIBOT_TEST_CAPTURE, JSON.stringify({ prompt: m.message, sessionId, pid: process.pid, ignoresTerm: env.PIBOT_TEST_IGNORE_TERM === "1", runMarker: env.CROW_EVAL_RUN_ID ?? null }) + "\n");
      if (Number(env.PIBOT_TEST_SKIP_USER_ON_TURN) !== n + 1) record("user", m.message);
      out({ type: "response", command: "prompt", id: m.id, success: true });
      if (env.PIBOT_TEST_CRASH === "1" || Number(env.PIBOT_TEST_CRASH_ON_TURN) === n + 1) process.exit(1);
      if (env.PIBOT_TEST_HANG === "1") continue;
      if (Number(env.PIBOT_TEST_MODEL_ERROR_ON_TURN) === n + 1) {
        const failed = `400: stub model error on turn ${n + 1}`;
        record("assistant", "", failed);
        out({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: failed }] });
        continue;
      }
      const text = replies.length ? String(replies[Math.min(n, replies.length - 1)]) : "ok";
      record("assistant", text);
      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
    } else if (m.type === "abort") {
      out({ type: "response", command: "abort", id: m.id, success: true });
    }
  }
});
process.stdin.resume();
