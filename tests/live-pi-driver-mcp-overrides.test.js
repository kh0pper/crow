/**
 * The eval-only MCP override seam in handleInbound (scripts/pi-bots/bridge.mjs): the fixture
 * research server in place of servers/research/index.js, refused unless THIS process is an eval
 * scratch. Each test runs one handleInbound in a process of its own (bridge-seam-child.mjs), so the
 * REAL env decides, and the stub pi shows what pi was actually handed (fd and file delivery).
 *
 * Nothing here spawns the fixture server: the stub pi never starts an MCP client, so the override is
 * only checked where it lands — the config pi received and the world .mcp.json on disk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import Database from "better-sqlite3";
import { childEnv } from "../scripts/lib/live-pi-driver.mjs";
import { FIXTURE_SERVER } from "../scripts/lib/eval-guard.mjs";
import { realish } from "../scripts/lib/protected-paths.mjs";
import { makeScratch, makeTemplate } from "../scripts/research-eval/scratch.mjs";

const REPO = join(import.meta.dirname, "..");
const BRIDGE = join(REPO, "scripts", "pi-bots", "bridge.mjs");
const STUB = join(REPO, "tests", "fixtures", "live-pi-driver", "stub-pi.mjs");
const SEAM_CHILD = join(REPO, "tests", "fixtures", "live-pi-driver", "bridge-seam-child.mjs");
const BOT = "rr-seam-bot";
let thread = 0;
const nextThread = () => `evalseam-${String(++thread).padStart(4, "0")}`;

let template;
test.before(async () => { template = await makeTemplate({ botId: BOT }); });
test.after(() => template && template.cleanup());

/** The def selects TWO servers, so "only the target block changed" means something. */
const botDef = () => ({
  id: BOT,
  display_name: "Eval Seam Bot",
  system_prompt: "You are the eval-seam test bot.",
  models: { default: "stub/m1" },
  tools: { pi_builtin: ["read"], crow_mcp: ["crow-projects/crow_list_projects", "crow-memory/crow_search_memories"] },
  permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
});

/** The only override the eval seam accepts, for one scratch home. */
const overrideFor = (home) => ({
  "crow-projects": {
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: {
      CROW_RESEARCH_EVAL: "1", CROW_HOME: home, CROW_RESEARCH_EVAL_CASE: join(home, "case.json"),
      CROW_RESEARCH_EVAL_FETCH_LOG: join(home, "fetch.jsonl"), TMPDIR: tmpdir(),
    },
  },
});

const run = (args, env) => new Promise((res) => {
  execFile(process.execPath, args, { env, cwd: REPO, timeout: 60_000 }, (err, stdout, stderr) => res({ err, stdout, stderr }));
});

/** One handleInbound in its own process under `env` → { error, action, called, loaded, overrode }. */
async function seamCall(dir, env, opts) {
  const optsPath = join(dir, `opts-${randomUUID()}.json`);
  const out = join(dir, `out-${randomUUID()}.json`);
  writeFileSync(optsPath, JSON.stringify(opts));
  const r = await run([SEAM_CHILD, optsPath, out], env);
  assert.ok(existsSync(out), `the seam child wrote nothing: ${r.stderr}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

test("S1: --inject refuses a payload with a __proto__ (or constructor/prototype) own key", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lpd-inject-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = nonEvalEnv(dir, join(dir, "capture.ndjson"));
  const inject = (raw) => run([BRIDGE, "--inject", raw], env);
  // JSON.parse makes "__proto__" an OWN key. Before the fix the rest spread kept it and
  // Object.assign ran the prototype setter, so handleInbound read mcpOverrides off the prototype
  // and answered "eval-only seam refused" — the strip never applied. The payload never being
  // handed on at all is what this asserts.
  const proto = await inject('{"bot_id":"b","gateway_thread_id":"t","user_message":"hi","__proto__":{"mcpOverrides":{"crow-projects":{}}}}');
  assert.match(proto.stderr, /refuses a payload with a __proto__ key/);
  assert.doesNotMatch(proto.stderr, /eval-only seam refused/, "the payload never reached the seam's read");
  assert.equal(proto.err && proto.err.code, 2);
  for (const key of ["constructor", "prototype"]) {
    const r = await inject(`{"bot_id":"b","${key}":{"mcpOverrides":{}}}`);
    assert.match(r.stderr, new RegExp(`refuses a payload with a ${key} key`), key);
  }
  // A non-object payload is refused too (JSON.parse can return null, a string or an array).
  assert.match((await inject("[1,2]")).stderr, /needs a JSON object/);
});

/** A real env that is NOT an eval scratch, with the stub pi wired. */
function nonEvalEnv(dir, capture) {
  const home = join(dir, "home");
  mkdirSync(join(home, "data"), { recursive: true });
  return {
    PATH: process.env.PATH, HOME: home, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_DB_PATH: join(home, "data", "crow.db"),
    PIBOT_PI_CLI: STUB, PIBOT_TEST_CAPTURE: capture, PIBOT_WARM_GATEWAY_URL: "http://127.0.0.1:1", PIBOT_MAX_PI: "99",
    ...(process.env.NODE_TEST_CONTEXT !== undefined ? { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT } : {}),
  };
}

const GUARD_URL = /\/scripts\/lib\/eval-guard\.mjs$/;
const readLines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A real eval scratch with the bot seeded, the driver child's env, and its capture file. */
async function evalScratch(t, { delivery = "fd", knobs = {} } = {}) {
  const s = await makeScratch({ botId: BOT, template });
  t.after(() => s.cleanup());
  const capture = join(s.home, "capture.ndjson");
  const env = {
    ...childEnv({ home: s.home, botId: BOT, runId: randomUUID(), piCli: STUB, turnTimeoutMs: 20_000, parent: { ...process.env, PIBOT_TEST_CAPTURE: capture, ...knobs } }),
    PIBOT_MCP_CONFIG_DELIVERY: delivery,
  };
  const agentDir = join(s.home, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "stub", models: [{ id: "m1" }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  mkdirSync(join(s.home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(s.home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));
  const c = new Database(s.dbPath);
  const { id, ...rest } = botDef();
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?, ?, ?, 1)").run(id, "Eval Seam Bot", JSON.stringify(rest));
  c.close();
  return { s, env, capture };
}

/** The world .mcp.json files a scratch home carries (never the global pi agent one). */
function worldMcpFiles(home) {
  if (!existsSync(home)) return [];
  return readdirSync(home, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name === ".mcp.json")
    .map((d) => join(d.parentPath ?? d.path, d.name))
    .filter((p) => p !== join(home, ".pi", "agent", "mcp.json"));
}

test("mcpOverrides refuses outside an eval scratch, before buildBotWorld: no pi, no .mcp.json", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lpd-mcpo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "capture.ndjson");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const out = await seamCall(dir, nonEvalEnv(dir, capture), {
    bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi", mcpOverrides: overrideFor(home),
  });
  assert.match(String(out.error), /^eval-only seam refused: CROW_RESEARCH_EVAL must be "1"/);
  assert.equal(out.action, null);
  assert.equal(out.overrode, null);
  assert.equal(existsSync(capture), false, "no pi was spawned");
  assert.deepEqual(worldMcpFiles(home), [], "no world .mcp.json was written");
});

test("forged eval-looking options cannot pass the mcpOverrides seam", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lpd-mcpo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "capture.ndjson");
  const fake = join(dir, "fake-home");
  const forged = { CROW_RESEARCH_EVAL: "1", CROW_HOME: fake, CROW_DB_PATH: join(fake, "crow.db"), CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: BOT };
  const out = await seamCall(dir, nonEvalEnv(dir, capture), {
    bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi", mcpOverrides: overrideFor(fake),
    env: forged, processEnv: forged, crowHome: fake, CROW_HOME: fake, CROW_RESEARCH_EVAL: "1",
  });
  assert.match(String(out.error), /^eval-only seam refused/);
  assert.equal(existsSync(capture), false);
  assert.deepEqual(worldMcpFiles(fake), []);
});

test("the guard loads before anything else on a refused call", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lpd-mcpo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "capture.ndjson");
  const out = await seamCall(dir, nonEvalEnv(dir, capture), { bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi", mcpOverrides: overrideFor(dir) });
  assert.match(String(out.error), /^eval-only seam refused/);
  const at = out.loaded.findIndex((u) => GUARD_URL.test(u));
  assert.ok(at >= 0, "the guard was loaded");
  const after = out.loaded.slice(at).filter((u) => !u.startsWith("node:") && !/\/scripts\/lib\/(eval-guard|protected-paths)\.mjs$/.test(u));
  assert.deepEqual(after, []);
});

test("absent or null mcpOverrides never loads eval-guard", async (t) => {
  const { s, env } = await evalScratch(t);
  for (const opts of [{}, { mcpOverrides: null }]) {
    const out = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi", ...opts });
    assert.equal(out.error, null);
    assert.equal(out.action, "asked");
    assert.equal(out.overrode, null, "no receipt without the seam");
    assert.equal(out.loaded.some((u) => GUARD_URL.test(u)), false, "the plain path loaded eval-guard.mjs");
  }
});

test("in an eval scratch pi gets the fixture server in place of crow-projects (fd delivery)", async (t) => {
  const { s, env, capture } = await evalScratch(t, { delivery: "fd" });
  const out = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi", mcpOverrides: overrideFor(s.home) });
  assert.equal(out.error, null);
  assert.equal(out.action, "asked");
  assert.deepEqual(out.overrode, ["crow-projects"]);
  assert.ok(out.loaded.some((u) => GUARD_URL.test(u)), "the seam path loads the guard");
  const [line] = readLines(capture);
  const block = line.mcpConfig.mcpServers["crow-projects"];
  assert.equal(block.command, process.execPath);
  assert.deepEqual(block.args, [FIXTURE_SERVER]);
  assert.equal(block.env.CROW_RESEARCH_EVAL, "1");
  assert.equal(block.env.CROW_HOME, s.home);
  assert.equal(block.env.CROW_RESEARCH_EVAL_CASE, join(s.home, "case.json"));
  assert.equal(realish(block.env.CROW_DB_PATH), realish(join(s.home, "data", "crow.db")), "the scratch DB is still the block's");
  assert.equal(block.url, undefined, "an fd-mode block is still a stdio block");
  assert.deepEqual(worldMcpFiles(s.home), [], "fd delivery writes no file");
});

test("file delivery: the world .mcp.json on disk is the overridden one", async (t) => {
  const { s, env, capture } = await evalScratch(t, { delivery: "file" });
  const out = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi", mcpOverrides: overrideFor(s.home) });
  assert.equal(out.error, null);
  assert.equal(out.action, "asked");
  const files = worldMcpFiles(s.home);
  assert.equal(files.length, 1, `world .mcp.json files: ${files.join(", ")}`);
  const written = JSON.parse(readFileSync(files[0], "utf8"));
  assert.deepEqual(written.mcpServers["crow-projects"].args, [FIXTURE_SERVER]);
  assert.equal(written.mcpServers["crow-projects"].env.CROW_RESEARCH_EVAL, "1");
  // pi also received the overridden config (the bridge passes the same object to the spawn).
  const [line] = readLines(capture);
  assert.deepEqual(line.mcpConfig.mcpServers["crow-projects"].args, [FIXTURE_SERVER]);
});

test("the override leaves every other block, the actor env and the --tools csv unchanged", async (t) => {
  const { s, env, capture } = await evalScratch(t, { delivery: "fd" });
  const plainThread = nextThread();
  const seamThread = nextThread();
  const plain = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: plainThread, user_message: "hi" });
  const seam = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: seamThread, user_message: "hi", mcpOverrides: overrideFor(s.home) });
  assert.equal(plain.error, null);
  assert.equal(seam.error, null);
  const [before, after] = readLines(capture);
  const g = (l) => l.mcpConfig.mcpServers;
  // The thread is the turn's own; everything else in the untouched block is byte-equal.
  const withoutThread = (b) => ({ ...b, env: { ...b.env, CROW_ACTOR_THREAD: undefined } });
  assert.deepEqual(withoutThread(g(after)["crow-memory"]), withoutThread(g(before)["crow-memory"]), "the other block is equal");
  assert.equal(g(after)["crow-memory"].env.CROW_ACTOR_THREAD, seamThread);
  assert.equal(g(after)["crow-projects"].env.CROW_ACTOR_KIND, "bot");
  assert.equal(g(after)["crow-projects"].env.CROW_ACTOR_BOT_ID, BOT);
  assert.equal(g(after)["crow-projects"].env.CROW_ACTOR_THREAD, seamThread, "the actor env survives the override");
  assert.equal(g(after)["crow-projects"].env.CROW_JOURNAL_MODE, "DELETE");
  assert.deepEqual(Object.keys(g(after)).sort(), Object.keys(g(before)).sort(), "the block set is unchanged");
  assert.equal(after.toolsCsv, before.toolsCsv, "--tools is unchanged");
  assert.match(String(after.toolsCsv), /mcp__crow-projects__crow_list_projects/);
});

test("a malformed override in an eval scratch refuses before pi spawns", async (t) => {
  const { s, env, capture } = await evalScratch(t);
  const cases = [
    [{ "crow-projects": { command: process.execPath, args: ["servers/research/index.js"] } }, /args must be exactly the fixture server/],
    [{ "crow-projects": { command: "/bin/sh", args: [FIXTURE_SERVER] } }, /command must be this node/],
    [{ "crow-memory": overrideFor(s.home)["crow-projects"] }, /may not be overridden/],
    [{ ...overrideFor(s.home), "crow-memory": overrideFor(s.home)["crow-projects"] }, /exactly one server override/],
  ];
  for (const [overrides, re] of cases) {
    const out = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi", mcpOverrides: overrides });
    assert.match(String(out.error), /^eval mcp override refused: /, JSON.stringify(overrides));
    assert.match(String(out.error), re);
  }
  assert.equal(existsSync(capture), false, "no refused override ever reached pi");
});

test("handleInbound returns mcpOverridden only when the seam ran", async (t) => {
  const { s, env } = await evalScratch(t);
  const plain = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi" });
  assert.equal(plain.overrode, null);
  const seam = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: nextThread(), user_message: "hi", mcpOverrides: overrideFor(s.home) });
  assert.deepEqual(seam.overrode, ["crow-projects"]);
});

test("bridge.mjs: the mcpOverrides block opens with the guard, the option is read once, no env var names an override", () => {
  const src = readFileSync(join(REPO, "scripts", "pi-bots", "bridge.mjs"), "utf8");
  // Read once, into a const, before anything else in the seam.
  assert.equal((src.match(/opts\.mcpOverrides/g) || []).length, 1, "exactly one read of the option");
  // Object.hasOwn: a plain read would also take a __proto__-injected value off the prototype.
  assert.match(src, /const mcpOverridesOpt = Object\.hasOwn\(opts, "mcpOverrides"\) \? opts\.mcpOverrides : undefined; \/\/ read once/);
  const HEAD = "if (mcpOverridesOpt !== undefined && mcpOverridesOpt !== null) {";
  assert.equal(src.split(HEAD).length - 1, 1, "exactly one seam block");
  const body = src.slice(src.indexOf(HEAD) + HEAD.length).replace(/^\s*/, "");
  assert.ok(body.startsWith('const guard = await import("../lib/eval-guard.mjs");'), "the guard is the first statement of the block");
  assert.ok(src.indexOf(HEAD) < src.indexOf("await buildBotWorld("), "the seam runs before buildBotWorld");
  // The override lands after bindWorldSession and before warmModel / the spawn transform.
  const at = src.indexOf("applyMcpOverrides(world.mcpConfig");
  assert.ok(at > src.indexOf("if (await bindWorldSession(world, session))"));
  assert.ok(at < src.indexOf("await warmModel("));
  assert.ok(at < src.indexOf("if (evalSeam !== null) {"), "the spawn transform sees the overridden config");
  // No environment variable can name an override, and no bot-def field is read.
  assert.doesNotMatch(src, /process\.env\.[A-Z_]*MCP_OVERRIDE|env\[["'][A-Z_]*MCP_OVERRIDE/);
  assert.doesNotMatch(src, /def\.mcpOverrides|definition\.mcpOverrides|bot\.mcpOverrides/);
  assert.match(src, /no env var names an override/, "the reason is written down where the seam is");
  // The --inject CLI refuses a payload with a prototype key, strips both eval-only seams out of
  // anything else, and builds the opts with a spread (no Object.assign prototype setter).
  const inject = src.slice(src.indexOf('const inj = a[a.indexOf("--inject") + 1];'));
  assert.match(inject, /for \(const k of \["__proto__", "constructor", "prototype"\]\)/);
  assert.match(inject, /if \(Object\.hasOwn\(payload, k\)\)/);
  assert.match(inject, /const \{ mcpOverrides: _mcpOverrides, evalSpawnTransform: _evalSpawnTransform, \.\.\.rest \} = payload;/);
  assert.match(inject, /handleInbound\(\{ \.\.\.rest,/);
  assert.doesNotMatch(inject, /Object\.assign\(/, "no Object.assign: a spread defines own properties");
});

test("S5: only live-pi-driver-child passes mcpOverrides to handleInbound; no def field is read, in servers/ and bundles/ too", () => {
  /** Every .mjs/.js source file under one repo directory (no node_modules, no generated vendor js). */
  const sourceFiles = (dir) => readdirSync(join(REPO, dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.(mjs|js)$/.test(d.name))
    .map((d) => join(d.parentPath ?? d.path, d.name))
    .filter((p) => !p.includes("node_modules") && !p.includes(`${sep}public${sep}vendor${sep}`));
  // servers/ and bundles/ are live code a future caller could sit in: a gateway route or a bundle
  // server passing mcpOverrides would be exactly the hole this test exists to catch.
  const files = [...sourceFiles("scripts"), ...sourceFiles("servers"), ...sourceFiles("bundles")];
  // The scan really reaches all three trees: without this the servers/ and bundles/ sweep would be
  // a comment (the old test scanned scripts/ alone and called itself "only caller").
  assert.deepEqual([...new Set(files.map((f) => f.slice(REPO.length + 1).split(sep)[0]))].sort(), ["bundles", "scripts", "servers"]);
  assert.ok(files.some((f) => f.endsWith(join("servers", "gateway", "index.js"))), "servers/ is scanned");
  assert.ok(files.some((f) => f.endsWith(join("bundles", "meta-glasses", "server", "device-store.js"))), "bundles/ is scanned");
  const hits = files.filter((f) => /mcpOverrides/.test(readFileSync(f, "utf8"))).map((f) => f.slice(REPO.length + 1)).sort();
  // The seam, its table, the driver, its child, and live.mjs (which builds the override). Nothing else.
  assert.deepEqual(hits, [
    "scripts/lib/eval-guard.mjs", "scripts/lib/live-pi-driver-child.mjs", "scripts/lib/live-pi-driver.mjs",
    "scripts/pi-bots/bridge.mjs", "scripts/research-eval/live.mjs",
  ]);
  const child = readFileSync(join(REPO, "scripts", "lib", "live-pi-driver-child.mjs"), "utf8");
  assert.match(child, /mcpOverrides: job\.mcpOverrides,/);
  // job.mcpOverrides is the only source: never a bot-def field.
  const driver = readFileSync(join(REPO, "scripts", "lib", "live-pi-driver.mjs"), "utf8");
  assert.match(driver, /mcpOverrides: checkedOverrides/);
  assert.doesNotMatch(driver + child, /botDef\.mcpOverrides|def\.mcpOverrides/);
});