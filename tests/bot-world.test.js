/**
 * Perch Hub P2, Task C-11 — GOLDEN FIXTURE for the per-turn world assembly.
 *
 * This file exists to pin the EXACT spawn surface of the hottest path in the
 * product (every gmail/discord/telegram/slack/perch bot turn, plus the
 * job-runner's background turns) so the world-builder extraction into
 * `scripts/pi-bots/bot-world.mjs` can be proven byte-identical rather than
 * argued to be.
 *
 * Methodology (deliberately unusual — read before editing):
 *   1. The goldens below were GENERATED from a real run against the
 *      UNREFACTORED bridge (`BOT_WORLD_GOLDEN_DUMP=<path> node --test …`,
 *      then pasted in verbatim). They are therefore a recording of the
 *      pre-refactor behavior, not a restatement of the intended behavior.
 *   2. A stub pi (PIBOT_PI_CLI env seam — pi_resolver.mjs:48 — the only seam
 *      handleInbound exposes) records what the child was ACTUALLY handed:
 *      argv, every PI_ and PIBOT_ env var, the sha256 of the (normalized)
 *      --append-system-prompt file, and the prompt text delivered over the
 *      rpc channel.
 *   3. The stub SPEAKS THE PROTOCOL (prompt ack -> agent_end, get_state with a
 *      sessionId, get_session_stats). A dump-and-die stub would only ever drive
 *      the bridge's error path, which never persists pi_session_id — and the
 *      resume leg (`--session <id>`) would be unwritable.
 *   4. Volatile values are normalized to tokens: the scratch dir -> __TMP__,
 *      os tmpdir -> __OSTMP__, the repo -> __REPO__, $HOME -> __HOME__, and the
 *      random mkdtemp suffixes -> pibot-XXXXXX / pibot-job-XXXXXX.
 *
 * Legs: gmail fresh, gmail resume, discord, and one job_runner.runJob spawn
 * (job_runner.mjs is the SECOND live consumer of bridge.mjs and rides the same
 * soak, so its spawn surface is in scope too).
 *
 * To regenerate after an INTENTIONAL change:
 *   BOT_WORLD_GOLDEN_DUMP=/tmp/g.json npm test -- tests/bot-world.test.js
 * then paste /tmp/g.json into GOLDENS. Never regenerate to make a red test
 * green without understanding the diff — that is the entire point of the file.
 *
 * CROW_DATA_DIR/CROW_HOME are scratch, so the operator's ~/.crow is untouchable.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

// Hermetic env: an ambient PI_*/PIBOT_* var from the operator's shell would
// otherwise leak into the child and into the golden. Clear them all FIRST.
for (const k of Object.keys(process.env)) {
  if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
}

const dir = mkdtempSync(join(tmpdir(), "bot-world-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PIBOT_MAX_PI = "99";                            // never defer on a busy dev box
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";  // refused instantly; warm is non-fatal
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
// Bound every wait: a stub that fails to answer must redden fast, never sit on
// the bridge's 10-minute production turn timeout.
process.env.PIBOT_TURN_TIMEOUT_MS = "5000";
process.env.PIBOT_JOB_TIMEOUT_MS = "5000";
process.env.PI_MODELS_JSON = join(dir, "models.json");
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
  providers: { stub: { models: [{ id: "m1" }] } },
}));

// Skills must resolve inside the SCRATCH crowHome: skill_resolver falls back to
// ~/.crow/skills and ~/crow/skills, whose contents differ per host — the
// sysFile sha would not be reproducible in CI.
writeFileSync(join(process.env.CROW_HOME, "skills", "golden-skill.md"), "# Golden Skill\n\nDo the golden thing.\n");
writeFileSync(join(process.env.CROW_HOME, "skills", "skill-writing.md"), "# Skill Writing\n\nHow to write a skill.\n");

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HOME = process.env.HOME || homedir();
const DUMP = process.env.BOT_WORLD_GOLDEN_DUMP || null;
const dumped = {};

// ---------------------------------------------------------------------------
// the protocol-speaking stub pi
// ---------------------------------------------------------------------------
const STUB_PI = join(dir, "stub-pi.mjs");
writeFileSync(STUB_PI, [
  'import { writeFileSync, readFileSync } from "node:fs";',
  'import { createHash } from "node:crypto";',
  'const argv = process.argv.slice(2);',
  'const env = {};',
  'for (const k of Object.keys(process.env).sort()) if (/^(PI_|PIBOT_)/.test(k)) env[k] = process.env[k];',
  'let sysText = null;',
  'const si = argv.indexOf("--append-system-prompt");',
  'if (si >= 0) { try { sysText = readFileSync(argv[si + 1], "utf8"); }',
  '               catch (e) { sysText = "ERR:" + (e && e.code); } }',
  'const cap = { argv, env, sysText, prompt: null };',
  'const flush = () => writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify(cap));',
  'flush();',
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let statsSeq = 0, buf = "";',
  'process.stdin.on("data", (chunk) => {',
  '  buf += chunk.toString("utf8");',
  '  let nl;',
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    if (!line.trim()) continue;',
  '    let m; try { m = JSON.parse(line); } catch { continue; }',
  '    if (m.type === "get_state") {',
  '      out({ type: "response", command: "get_state", data: { sessionId: "golden-uuid" } });',
  '    } else if (m.type === "get_session_stats") {',
  '      statsSeq++;',
  '      out({ type: "response", command: "get_session_stats", id: m.id,',
  '            data: { tokens: { input: 100 * statsSeq, output: 10 * statsSeq, cacheRead: 0 } } });',
  '    } else if (m.type === "prompt") {',
  '      cap.prompt = m.message; flush();',
  '      out({ type: "response", command: "prompt" });',
  '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "golden reply" }] }] });',
  '    } else if (m.type === "abort") {',
  '      out({ type: "response", command: "abort" });',
  '    }',
  '  }',
  '});',
  'process.stdin.resume();',
  '',
].join("\n"));
process.env.PIBOT_PI_CLI = STUB_PI;

const { handleInbound } = await import("../scripts/pi-bots/bridge.mjs");
const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");

// ---------------------------------------------------------------------------
// normalization + capture
// ---------------------------------------------------------------------------
function normalize(v) {
  let t = String(v);
  t = t.split(dir).join("__TMP__");
  t = t.split(tmpdir()).join("__OSTMP__");
  t = t.split(REPO).join("__REPO__");
  if (HOME) t = t.split(HOME).join("__HOME__");
  t = t.replace(/pibot-job-[A-Za-z0-9]{6}/g, "pibot-job-XXXXXX");
  t = t.replace(/pibot-[A-Za-z0-9]{6}/g, "pibot-XXXXXX");
  return t;
}

let captureFile = null;
/** Point the next spawn's capture at a fresh, leg-named file. */
function armCapture(leg) {
  captureFile = join(dir, "capture-" + leg + ".json");
  if (existsSync(captureFile)) rmSync(captureFile);
  process.env.PIBOT_TEST_CAPTURE = captureFile;
}
function readCapture() {
  const raw = JSON.parse(readFileSync(captureFile, "utf8"));
  const env = {};
  for (const k of Object.keys(raw.env).sort()) env[k] = normalize(raw.env[k]);
  return {
    argv: raw.argv.map(normalize),
    env,
    // sha256 of the NORMALIZED --append-system-prompt file. It must be
    // normalized first: the self-authoring block embeds the absolute staging
    // dir, which lives under the per-run scratch mkdtemp — the raw file's sha
    // is different on every run. This hash is what catches a reordering of the
    // system_prompt / skills / skill-writing / self-authoring appends.
    sysSha: raw.sysText == null ? null
      : createHash("sha256").update(normalize(raw.sysText)).digest("hex"),
    prompt: raw.prompt == null ? null : normalize(raw.prompt),
  };
}
/** Compare against the recorded golden — or record it under DUMP. */
function check(name, cap) {
  if (DUMP) { dumped[name] = cap; return; }
  assert.deepEqual(cap, GOLDENS[name]);
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------
const BOT_DEF = {
  system_prompt: "You are the golden bot.",
  skills: ["golden-skill"],
  models: { default: "stub/m1" },
  tools: { pi_builtin: ["read", "write"], crow_mcp: ["crow-tasks/tasks_list"] },
  // self_authoring:true is deliberate — it makes the sysFile a THREE-part
  // append (system_prompt, skills, skill-writing + self-authoring block), so a
  // reordering of those appends changes the recorded sha256.
  permission_policy: { bash: "deny", write_paths: [], multi_agent: false, self_authoring: true },
  gateways: [{ type: "gmail" }, { type: "discord" }],
  // C-12 named this key: PIBOT_*/PI_BOT_* spawn_env keys are now stripped
  // before the child env is assembled (spawn_env hygiene, r1 S3), so a
  // PIBOT_-prefixed marker here would silently vanish. PI_GOLDEN_MARKER
  // keeps the "does an arbitrary spawn_env value reach the child" coverage
  // this fixture exists for while staying outside the stripped prefixes
  // (only PI_BOT_*/PIBOT_* are stripped, not PI_* generally).
  spawn_env: { PI_GOLDEN_MARKER: "1" },
};

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  const c = new Database(DB_FILE);
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)")
    .run("goldenbot", "Golden Bot",
      JSON.stringify({ ...BOT_DEF, session_dir: join(dir, "bots", "goldenbot") }), 1);
  c.close();
});

after(() => {
  if (DUMP) writeFileSync(DUMP, JSON.stringify(dumped, null, 2));
  rmSync(dir, { recursive: true, force: true });
});

async function turn(leg, opts) {
  armCapture(leg);
  const replies = [];
  const result = await handleInbound(Object.assign({
    bot_id: "goldenbot",
    sendReply: async (t) => { replies.push(t); },
    log: () => {},
  }, opts));
  return { result, replies, cap: readCapture() };
}

function sessionRow(threadId) {
  const c = new Database(DB_FILE);
  const r = c.prepare("SELECT * FROM bot_sessions WHERE bot_id='goldenbot' AND gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
  c.close();
  return r;
}

// ---------------------------------------------------------------------------
// the goldens
// ---------------------------------------------------------------------------
const GOLDENS = {
  "gmail-fresh": {
    "argv": [
      "--mode",
      "rpc",
      "--no-approve",
      "--provider",
      "stub",
      "--model",
      "m1",
      "--session-dir",
      "__TMP__/bots/goldenbot/sessions",
      "--tools",
      "read,write,mcp__crow-tasks__tasks_list",
      "--append-system-prompt",
      "__OSTMP__/pibot-XXXXXX/sys.md"
    ],
    "env": {
      "PIBOT_JOB_TIMEOUT_MS": "5000",
      "PIBOT_MAX_PI": "99",
      "PIBOT_PI_CLI": "__TMP__/stub-pi.mjs",
      "PIBOT_PROMPT_ACK_TIMEOUT_MS": "8000",
      "PIBOT_SUBAGENT_DEPTH": "0",
      "PIBOT_TEST_CAPTURE": "__TMP__/capture-gmail-fresh.json",
      "PIBOT_TURN_TIMEOUT_MS": "5000",
      "PIBOT_WARM_GATEWAY_URL": "http://127.0.0.1:1",
      "PIBOT_WARM_TIMEOUT_MS": "1500",
      "PI_BOT_PERMISSION_POLICY": "{\"bash\":\"deny\",\"write_paths\":[\"__TMP__/bots/goldenbot/proposed-skills\"],\"multi_agent\":false,\"self_authoring\":true,\"model_capable\":false}",
      "PI_GOLDEN_MARKER": "1",
      "PI_MODELS_JSON": "__TMP__/models.json",
      "PI_PROVIDER": "stub"
    },
    "sysSha": "af0c6e8d1327a77f81b48d35d905539e2527c1c91f0d6d69e07484d19def86f3",
    "prompt": "PROJECT: (none)\nGATEWAY THREAD: gmail thread_id=gmail-golden — pass this verbatim as thread_id when drafting your reply via gmail_create_draft.\n\nKanban:\n(no project linked)\n\nUser said: \"hello golden\"\n\nReply on the gateway thread. Use tools as needed per your system prompt: if the user asks a simple question (criteria, status, specific employer), call the appropriate query tools and answer; if the user asks for work to be done, run the workflow; if they're just saying hi, reply briefly without tools. Don't ask 'which card?' unless their message is genuinely ambiguous."
  },
  "gmail-resume": {
    "argv": [
      "--mode",
      "rpc",
      "--no-approve",
      "--provider",
      "stub",
      "--model",
      "m1",
      "--session-dir",
      "__TMP__/bots/goldenbot/sessions",
      "--tools",
      "read,write,mcp__crow-tasks__tasks_list",
      "--append-system-prompt",
      "__OSTMP__/pibot-XXXXXX/sys.md",
      "--session",
      "golden-uuid"
    ],
    "env": {
      "PIBOT_JOB_TIMEOUT_MS": "5000",
      "PIBOT_MAX_PI": "99",
      "PIBOT_PI_CLI": "__TMP__/stub-pi.mjs",
      "PIBOT_PROMPT_ACK_TIMEOUT_MS": "8000",
      "PIBOT_SUBAGENT_DEPTH": "0",
      "PIBOT_TEST_CAPTURE": "__TMP__/capture-gmail-resume.json",
      "PIBOT_TURN_TIMEOUT_MS": "5000",
      "PIBOT_WARM_GATEWAY_URL": "http://127.0.0.1:1",
      "PIBOT_WARM_TIMEOUT_MS": "1500",
      "PI_BOT_PERMISSION_POLICY": "{\"bash\":\"deny\",\"write_paths\":[\"__TMP__/bots/goldenbot/proposed-skills\"],\"multi_agent\":false,\"self_authoring\":true,\"model_capable\":false}",
      "PI_GOLDEN_MARKER": "1",
      "PI_MODELS_JSON": "__TMP__/models.json",
      "PI_PROVIDER": "stub"
    },
    "sysSha": "af0c6e8d1327a77f81b48d35d905539e2527c1c91f0d6d69e07484d19def86f3",
    "prompt": "PROJECT: (none)\nGATEWAY THREAD: gmail thread_id=gmail-golden — pass this verbatim as thread_id when drafting your reply via gmail_create_draft.\n\nKanban:\n(no project linked)\n\nUser said: \"second turn\"\n\nReply on the gateway thread. Use tools as needed per your system prompt: if the user asks a simple question (criteria, status, specific employer), call the appropriate query tools and answer; if the user asks for work to be done, run the workflow; if they're just saying hi, reply briefly without tools. Don't ask 'which card?' unless their message is genuinely ambiguous."
  },
  "discord": {
    "argv": [
      "--mode",
      "rpc",
      "--no-approve",
      "--provider",
      "stub",
      "--model",
      "m1",
      "--session-dir",
      "__TMP__/bots/goldenbot/sessions",
      "--tools",
      "read,write,mcp__crow-tasks__tasks_list",
      "--append-system-prompt",
      "__OSTMP__/pibot-XXXXXX/sys.md"
    ],
    "env": {
      "PIBOT_JOB_TIMEOUT_MS": "5000",
      "PIBOT_MAX_PI": "99",
      "PIBOT_PI_CLI": "__TMP__/stub-pi.mjs",
      "PIBOT_PROMPT_ACK_TIMEOUT_MS": "8000",
      "PIBOT_SUBAGENT_DEPTH": "0",
      "PIBOT_TEST_CAPTURE": "__TMP__/capture-discord.json",
      "PIBOT_TURN_TIMEOUT_MS": "5000",
      "PIBOT_WARM_GATEWAY_URL": "http://127.0.0.1:1",
      "PIBOT_WARM_TIMEOUT_MS": "1500",
      "PI_BOT_PERMISSION_POLICY": "{\"bash\":\"deny\",\"write_paths\":[\"__TMP__/bots/goldenbot/proposed-skills\"],\"multi_agent\":false,\"self_authoring\":true,\"model_capable\":false}",
      "PI_GOLDEN_MARKER": "1",
      "PI_MODELS_JSON": "__TMP__/models.json",
      "PI_PROVIDER": "stub"
    },
    "sysSha": "af0c6e8d1327a77f81b48d35d905539e2527c1c91f0d6d69e07484d19def86f3",
    "prompt": "PROJECT: (none)\nGATEWAY: discord — your reply text is sent to the Discord channel automatically. Do NOT use gmail tools. (thread ref: discord-golden)\n\nKanban:\n(no project linked)\n\nUser said: \"hello golden\"\n\nReply on the gateway thread. Use tools as needed per your system prompt: if the user asks a simple question (criteria, status, specific employer), call the appropriate query tools and answer; if the user asks for work to be done, run the workflow; if they're just saying hi, reply briefly without tools. Don't ask 'which card?' unless their message is genuinely ambiguous."
  },
  "runjob": {
    "argv": [
      "--mode",
      "rpc",
      "--no-approve",
      "--provider",
      "stub",
      "--model",
      "m1",
      "--session-dir",
      "__OSTMP__/pibot-job-XXXXXX/sessions",
      "--tools",
      "read,write,mcp__crow-tasks__tasks_list",
      "--append-system-prompt",
      "__OSTMP__/pibot-job-XXXXXX/job-sys.md"
    ],
    "env": {
      "PIBOT_JOB_TIMEOUT_MS": "5000",
      "PIBOT_MAX_PI": "99",
      "PIBOT_PI_CLI": "__TMP__/stub-pi.mjs",
      "PIBOT_PROMPT_ACK_TIMEOUT_MS": "8000",
      "PIBOT_SUBAGENT_DEPTH": "0",
      "PIBOT_TEST_CAPTURE": "__TMP__/capture-runjob.json",
      "PIBOT_TURN_TIMEOUT_MS": "5000",
      "PIBOT_WARM_GATEWAY_URL": "http://127.0.0.1:1",
      "PIBOT_WARM_TIMEOUT_MS": "1500",
      "PI_BOT_PERMISSION_POLICY": "{\"bash\":\"deny\",\"write_paths\":[],\"multi_agent\":false,\"self_authoring\":true,\"model_capable\":false}",
      "PI_GOLDEN_MARKER": "1",
      "PI_MODELS_JSON": "__TMP__/models.json",
      "PI_PROVIDER": "stub"
    },
    "sysSha": "66843c3964a23920bd9387c39dd784412794164448bd79c9dc586b0a2fff10cb",
    "prompt": "You are running a BACKGROUND job for the user — no one is waiting on this exact\nreply in real time, so do the work thoroughly before answering. Use your tools\nas needed to accomplish the goal.\n\nGOAL:\ndo the golden job\n\nWhen finished, reply with a concise summary of the outcome (what you did and the\nresult). If a result is meant to be read back to the user, make the summary\nself-contained."
  }
};

// ---------------------------------------------------------------------------
// legs
// ---------------------------------------------------------------------------

test("GOLDEN: gmail turn, fresh session", async () => {
  const { result, cap } = await turn("gmail-fresh", {
    gateway_thread_id: "gmail-golden", gateway_type: "gmail", user_message: "hello golden",
  });
  // The protocol-speaking stub means this is the SUCCESS path, not the error
  // path — which is what makes pi_session_id persist for the resume leg.
  assert.equal(result.action, "asked");
  assert.equal(result.piSessionId, "golden-uuid");
  assert.equal(sessionRow("gmail-golden").pi_session_id, "golden-uuid");
  assert.ok(!cap.argv.includes("--session"), "a fresh turn must not resume");
  check("gmail-fresh", cap);
});

test("GOLDEN: gmail turn, resumed session (--session)", async () => {
  const { result, cap } = await turn("gmail-resume", {
    gateway_thread_id: "gmail-golden", gateway_type: "gmail", user_message: "second turn",
  });
  assert.equal(result.action, "asked");
  assert.equal(cap.argv[cap.argv.indexOf("--session") + 1], "golden-uuid",
    "the persisted pi_session_id must reach the child as --session");
  check("gmail-resume", cap);
});

test("GOLDEN: discord turn (gateway-hint byte-stability)", async () => {
  const { result, cap } = await turn("discord", {
    gateway_thread_id: "discord-golden", gateway_type: "discord", user_message: "hello golden",
  });
  assert.equal(result.action, "asked");
  // Same spawn envelope as gmail; the gateway type shows up in the PROMPT.
  assert.ok(cap.prompt.includes("Discord") || cap.prompt.includes("discord"),
    "the discord gateway hint must reach the prompt");
  check("discord", cap);
});

test("GOLDEN: job_runner.runJob spawn (the second bridge consumer)", async () => {
  armCapture("runjob");
  const r = await runJob({ job_id: "job-golden", bot_id: "goldenbot", goal: "do the golden job", escalate: 0 },
    { log: () => {} });
  assert.equal(r.result, "golden reply");
  assert.equal(r.sessionId, "golden-uuid");
  check("runjob", readCapture());
});
