/**
 * Perch Hub P1, Task C-6 — per-session tool narrowing + the `kind` plumb.
 *
 * Three layers, deliberately separate:
 *   A. `applySessionNarrowing()` as a pure function (intersection semantics).
 *   B. `PiRpc` — proof that narrowing reaches the REAL spawn argv, applied to
 *      the FINAL csv (after the `subagent` append). A stub "pi" records the
 *      argv it was actually handed; nothing here asserts on the intent.
 *   C. `handleInbound()` end to end against a scratch crow.db — the hot-path
 *      regression (a gmail turn with no narrowing and no `kind` opt must spawn
 *      byte-identical args and land `kind='chat'`) and the perch case.
 *
 * No real pi is ever spawned: PIBOT_PI_CLI points at a stub that writes its
 * argv and exits, so the turn fails fast through the bridge's own error path
 * AFTER the session upsert and the spawn — which is exactly what is under test.
 * CROW_DATA_DIR/CROW_HOME are scratch, so the operator's ~/.crow is untouchable.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-narrowing-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
// The bridge reads these at module load / spawn time.
process.env.PIBOT_MAX_PI = "99";               // never defer on a busy dev box
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1"; // refused instantly; warm is non-fatal
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "4000";
process.env.PI_MODELS_JSON = join(dir, "models.json");
mkdirSync(process.env.CROW_HOME, { recursive: true });
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
  providers: { stub: { models: [{ id: "m1" }] }, "zai-coding": { models: [{ id: "glm-5" }] } },
}));

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;
const ARGV_OUT = join(dir, "spawn-argv.json");

// A stub "pi": records the argv it was handed, then dies. PiRpc's exit-fast
// surface turns that into a rejected prompt, which handleInbound reports via
// sendReply — every step BEFORE it (session upsert, arg construction) has
// already happened by then.
const STUB_PI = join(dir, "stub-pi.mjs");
writeFileSync(
  STUB_PI,
  'import { writeFileSync } from "node:fs";\n' +
  'writeFileSync(process.env.PIBOT_TEST_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n' +
  'console.error("stub pi: exiting");\n' +
  'process.exit(9);\n'
);
process.env.PIBOT_PI_CLI = STUB_PI;
process.env.PIBOT_TEST_ARGV_OUT = ARGV_OUT;

const { applySessionNarrowing, PiRpc, handleInbound } =
  await import("../scripts/pi-bots/bridge.mjs");

function raw() { return new Database(DB_FILE); }

/** Spawn a PiRpc with the stub and return the argv the child actually got. */
async function spawnArgs(opts) {
  if (existsSync(ARGV_OUT)) rmSync(ARGV_OUT);
  const sessionDir = mkdtempSync(join(dir, "pirpc-"));
  mkdirSync(join(sessionDir, "sessions"), { recursive: true });
  const pi = new PiRpc(Object.assign({
    sessionDir,
    resolved: { provider: "stub", model: "m1", key: "stub/m1" },
    nodeBin: process.execPath,
    cliPath: STUB_PI,
  }, opts));
  await pi.exited;
  await pi.close();
  return JSON.parse(readFileSync(ARGV_OUT, "utf8"));
}

/** The value passed to `--tools`, or `null` when the flag is absent. */
function toolsFlag(argv) {
  const i = argv.indexOf("--tools");
  return i < 0 ? null : argv[i + 1];
}

// ---------------------------------------------------------------------------
// A. the pure helper
// ---------------------------------------------------------------------------

test("narrowing removes exactly the listed tools", () => {
  assert.equal(
    applySessionNarrowing("read,bash,mcp__crow-tasks__tasks_list", '["bash"]'),
    "read,mcp__crow-tasks__tasks_list"
  );
  assert.equal(
    applySessionNarrowing("read,bash,mcp__crow-tasks__tasks_list", '["read","mcp__crow-tasks__tasks_list"]'),
    "bash"
  );
});

test("narrowing can remove `subagent` — it is part of the FINAL csv", () => {
  assert.equal(applySessionNarrowing("read,bash,subagent", '["subagent"]'), "read,bash");
});

test("ids that are not in the allowlist are a no-op — narrowing can only remove", () => {
  assert.equal(applySessionNarrowing("read,bash", '["teleport"]'), "read,bash");
  // The union interpretation would have produced "read,bash,teleport".
  assert.ok(!applySessionNarrowing("read,bash", '["teleport"]').includes("teleport"));
});

test("malformed narrowing JSON falls open to the full def allowlist, never wider", () => {
  const csv = "read,bash";
  assert.equal(applySessionNarrowing(csv, "{not json"), csv);
  assert.equal(applySessionNarrowing(csv, "null"), csv);
  assert.equal(applySessionNarrowing(csv, '"bash"'), csv, "a bare string is not a disable list");
  assert.equal(applySessionNarrowing(csv, '{"disabled":["bash"]}'), csv, "an object is not a disable list");
});

test("absent / empty narrowing is a no-op", () => {
  const csv = "read,bash";
  assert.equal(applySessionNarrowing(csv, null), csv);
  assert.equal(applySessionNarrowing(csv, undefined), csv);
  assert.equal(applySessionNarrowing(csv, ""), csv);
  assert.equal(applySessionNarrowing(csv, "[]"), csv);
});

test("a fully narrowed session resolves to the empty string — deliberately", () => {
  // "" is the correct answer, not a bug: the session asked for no tools at all.
  // PiRpc turns it into `--tools ""` (see the spawn test below), which pi parses
  // as an empty allowlist. Returning the full csv here would be a widening.
  assert.equal(applySessionNarrowing("read,bash", '["read","bash"]'), "");
  assert.equal(applySessionNarrowing("subagent", '["subagent"]'), "");
});

// ---------------------------------------------------------------------------
// B. enforcement at the spawn
// ---------------------------------------------------------------------------

const MA_DEF = {
  tools: { pi_builtin: ["read", "bash"], crow_mcp: ["crow-tasks/tasks_list"] },
  permission_policy: { multi_agent: true, bash: "deny", write_paths: [] },
};
const MA_RESOLVED = { provider: "zai-coding", model: "glm-5", key: "zai-coding/glm-5" };

test("PiRpc without narrowing spawns the def envelope unchanged (hot-path regression)", async () => {
  const argv = await spawnArgs({ def: MA_DEF, resolved: MA_RESOLVED });
  assert.equal(toolsFlag(argv), "read,bash,mcp__crow-tasks__tasks_list,subagent");
});

test("PiRpc applies narrowing to the FINAL csv, after the subagent append", async () => {
  const argv = await spawnArgs({
    def: MA_DEF, resolved: MA_RESOLVED,
    narrowedTools: '["bash","subagent"]',
  });
  const tools = toolsFlag(argv);
  assert.equal(tools, "read,mcp__crow-tasks__tasks_list");
  assert.ok(!tools.split(",").includes("subagent"), "subagent must be narrowable");
  assert.ok(!tools.split(",").includes("bash"));
});

test("a fully narrowed session pins `--tools \"\"` instead of dropping the flag", async () => {
  const argv = await spawnArgs({
    def: { tools: { pi_builtin: ["read", "bash"] } },
    narrowedTools: '["read","bash"]',
  });
  // Dropping the flag would hand pi its FULL default tool surface — narrowing
  // would widen. `--tools ""` parses to an empty allowlist (pi 0.82.0
  // dist/cli/args.js:85-89 -> dist/core/sdk.js:133-136).
  assert.equal(toolsFlag(argv), "", "the flag must be present with an empty value");
  assert.ok(argv.includes("--tools"));
});

test("malformed narrowing at the spawn keeps the def envelope", async () => {
  const argv = await spawnArgs({
    def: { tools: { pi_builtin: ["read", "bash"] } },
    narrowedTools: "{not json",
  });
  assert.equal(toolsFlag(argv), "read,bash");
});

test("a toolless def with no narrowing now pins --tools \"\" instead of omitting the flag", async () => {
  // `{tools: {}}` is the empty envelope — the exact case Task 3 fixes.
  // toolAllowlist() returns "" for it, and omitting the flag would hand pi
  // its full default surface (bash, edit, write, every inherited MCP tool).
  const argv = await spawnArgs({ def: { tools: {} } });
  assert.equal(toolsFlag(argv), "");
});

// ---------------------------------------------------------------------------
// C. handleInbound: narrowing read from the row + the `kind` plumb
// ---------------------------------------------------------------------------

const BOT_DEF = {
  gateways: [{ type: "perch" }],
  tools: { pi_builtin: ["read", "bash"], crow_mcp: ["crow-tasks/tasks_list"] },
  models: { default: "stub/m1" },
  permission_policy: { multi_agent: false, bash: "deny", write_paths: [] },
};
const FULL_CSV = "read,bash,mcp__crow-tasks__tasks_list";

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)")
    .run("narrowbot", "Narrow Bot", JSON.stringify({ ...BOT_DEF, session_dir: join(dir, "bots", "narrowbot") }), 1);
  c.close();
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  if (existsSync(ARGV_OUT)) rmSync(ARGV_OUT);
  const c = raw();
  c.prepare("DELETE FROM bot_sessions").run();
  c.close();
});

/** One turn against the stub pi. Always resolves — the stub's death is
 * reported through sendReply, after the upsert and the spawn. */
async function turn(opts) {
  const replies = [];
  const r = await handleInbound(Object.assign({
    bot_id: "narrowbot",
    user_message: "hello",
    sendReply: async (t) => { replies.push(t); },
    log: () => {},
  }, opts));
  return { result: r, replies, argv: JSON.parse(readFileSync(ARGV_OUT, "utf8")) };
}

function sessionRow(threadId) {
  const c = raw();
  const r = c.prepare("SELECT * FROM bot_sessions WHERE bot_id='narrowbot' AND gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
  c.close();
  return r;
}

test("REGRESSION: a gmail turn with no narrowing and no kind opt is unchanged", async () => {
  const { result, argv } = await turn({ gateway_thread_id: "gmail-1", gateway_type: "gmail" });
  assert.equal(result.action, "error", "the stub pi dies — the turn still ran the spawn path");
  assert.equal(toolsFlag(argv), FULL_CSV, "a NULL narrowed_tools row must not touch the csv");
  const row = sessionRow("gmail-1");
  assert.equal(row.gateway_type, "gmail");
  assert.equal(row.kind, "chat", "callers that declare no kind still land 'chat'");
  assert.equal(row.narrowed_tools, null);
});

test("a perch turn writes kind='perch' on the row it creates", async () => {
  await turn({ gateway_thread_id: "perch-1", gateway_type: "perch", kind: "perch" });
  const row = sessionRow("perch-1");
  assert.equal(row.gateway_type, "perch");
  assert.equal(row.kind, "perch");
});

test("a saved narrowing on the session row is enforced at the spawn", async () => {
  const c = raw();
  // Exactly the row shape POST /narrow leaves behind (routes/perch.js saveNarrowing).
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control,narrowed_tools) " +
    "VALUES ('narrowbot','perch','perch-2','perch','waiting-user','run',?)"
  ).run('["bash"]');
  c.close();

  const { argv } = await turn({ gateway_thread_id: "perch-2", gateway_type: "perch", kind: "perch" });
  const tools = toolsFlag(argv);
  assert.equal(tools, "read,mcp__crow-tasks__tasks_list");
  assert.ok(!tools.split(",").includes("bash"), "the narrowed tool must be ABSENT from the spawn argv");
  // The narrowing survives the turn's own upsert — it is Perch's state, not the turn's.
  assert.equal(sessionRow("perch-2").narrowed_tools, '["bash"]');
});

test("an unknown id saved on the row cannot widen the turn", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control,narrowed_tools) " +
    "VALUES ('narrowbot','perch','perch-3','perch','waiting-user','run',?)"
  ).run('["teleport"]');
  c.close();
  const { argv } = await turn({ gateway_thread_id: "perch-3", gateway_type: "perch", kind: "perch" });
  assert.equal(toolsFlag(argv), FULL_CSV);
});

test("a turn from a caller with no kind opt never rewrites an existing row's kind", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control) " +
    "VALUES ('narrowbot','perch','perch-4','perch','waiting-user','run')"
  ).run();
  c.close();
  await turn({ gateway_thread_id: "perch-4", gateway_type: "perch" }); // no kind
  assert.equal(sessionRow("perch-4").kind, "perch", "the default must not clobber a real kind");
});
