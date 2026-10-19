/**
 * Pi bot turns (Gmail/Discord/Telegram/Slack bridge) get a [Dates] line when the USER's own words name a relative
 * day ("move my dentist to Monday"): pi's system prompt has no date and is cached per session, so the user-message
 * tail is the only safe place. An echo of the line is stripped from the reply before it is sent.
 *
 * Harness: the protocol-speaking stub pi of tests/bot-world.test.js (PIBOT_PI_CLI seam), scratch CROW_DATA_DIR /
 * CROW_HOME / HOME, so the operator's ~/.crow is untouchable.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { relativeDatesContext } from "../servers/shared/relative-dates.js";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];

const dir = mkdtempSync(join(tmpdir(), "pibot-dates-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "5000";
process.env.PI_MODELS_JSON = join(dir, "models.json");
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));

const STUB_PI = join(dir, "stub-pi.mjs");
writeFileSync(STUB_PI, [
  'import { writeFileSync } from "node:fs";',
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let buf = "";',
  'process.stdin.on("data", (chunk) => {',
  '  buf += chunk.toString("utf8");',
  '  let nl;',
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    if (!line.trim()) continue;',
  '    let m; try { m = JSON.parse(line); } catch { continue; }',
  '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "dates-uuid" } });',
  '    else if (m.type === "get_session_stats") out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
  '    else if (m.type === "prompt") {',
  '      writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify({ prompt: m.message }));',
  '      out({ type: "response", command: "prompt" });',
  '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: process.env.PIBOT_TEST_REPLY || "ok" }] }] });',
  '    } else if (m.type === "abort") out({ type: "response", command: "abort" });',
  '  }',
  '});',
  'process.stdin.resume();',
  '',
].join("\n"));
process.env.PIBOT_PI_CLI = STUB_PI;

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { handleInbound } = await import("../scripts/pi-bots/bridge.mjs");

const THU = Date.UTC(2026, 9, 15, 21, 57);
const DATES = relativeDatesContext(THU, null);

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)").run("datebot", "Date Bot", JSON.stringify({
    system_prompt: "You are the date-test bot.", models: { default: "stub/m1" },
    tools: { pi_builtin: ["read"], crow_mcp: [] }, permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
    gateways: [{ type: "gmail" }], session_dir: join(dir, "bots", "datebot"),
  }), 1);
  c.close();
});
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
async function turn(user_message, reply = "ok") {
  const capture = join(dir, `capture-${++n}.json`);
  process.env.PIBOT_TEST_CAPTURE = capture;
  process.env.PIBOT_TEST_REPLY = reply;
  const replies = [];
  const result = await handleInbound({ bot_id: "datebot", gateway_thread_id: `thread-${n}`, user_message, now: THU, sendReply: async (t) => { replies.push(t); }, log: () => {} });
  return { result, replies, prompt: JSON.parse(readFileSync(capture, "utf8")).prompt };
}

test("the user names a relative day → the prompt ends with a blank line and the [Dates] line", async () => {
  const { prompt, result } = await turn("move my dentist to Monday");
  assert.equal(result.action, "asked", JSON.stringify(result));
  assert.ok(prompt.endsWith(`\n\n${DATES}`), prompt.slice(-400));
});

test("a plain user line → no [Dates] line", async () => {
  const { prompt } = await turn("hello there");
  assert.doesNotMatch(prompt, /\[Dates\]/);
});

test("an echo of the [Dates] line is stripped before the reply is sent", async () => {
  const { replies } = await turn("anything on Friday?", `${DATES}\nYes, Friday the 16th.`);
  assert.deepEqual(replies, ["Yes, Friday the 16th."]);
});
