/**
 * runConversation, the live pi driver's parent: threads in order over one scratch Crow home,
 * against the protocol-speaking stub pi (tests/fixtures/live-pi-driver/stub-pi.mjs). Stub knobs
 * (PIBOT_TEST_*) reach the child through `parentEnv`, so process.env is never written except by
 * the R2 test, which restores it. Every process a run starts is checked by the run marker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  runConversation, DriverRefusal, SESSION_MISSING, TURN_SLACK_MS, survivorsByMarker, settledSurvivorsByMarker, bootSecNow,
} from "../scripts/lib/live-pi-driver.mjs";
import { makeScratch, makeTemplate } from "../scripts/research-eval/scratch.mjs";

const REPO = join(import.meta.dirname, "..");
const DRIVER = join(REPO, "scripts", "lib", "live-pi-driver.mjs");
const STUB = join(REPO, "tests", "fixtures", "live-pi-driver", "stub-pi.mjs");
const BOT = "drv-bot";

let template;
test.before(async () => { template = await makeTemplate({ botId: BOT }); });
test.after(() => template && template.cleanup());

const botDef = (over = {}) => ({
  id: BOT,
  display_name: "Driver Bot",
  system_prompt: "You are the driver-test bot.",
  models: { default: "stub/m1" },
  tools: { pi_builtin: ["read"], crow_mcp: [] },
  permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
  ...over,
});
const models = (baseUrl = "http://127.0.0.1:9/v1") => ({
  providers: { stub: { baseUrl, api: "openai-completions", models: [{ id: "m1" }] } },
});
const alive = (pid) => {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0] !== "Z"; } catch { return false; }
};
/** What a survivor is, for the failure message: its cmdline and whether its environ is readable. */
const describePid = (pid) => {
  let cmd = "?"; let env = "readable";
  try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "); } catch (e) { cmd = e.code; }
  try { readFileSync(`/proc/${pid}/environ`); } catch (e) { env = e.code; }
  return `${pid}: ${cmd} (environ ${env})`;
};
/** Cleanup signals only a pid whose environ positively carries the run marker, never an unreadable one. */
const carriesMarker = (pid, runId) => {
  try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`CROW_EVAL_RUN_ID=${runId}`); } catch { return false; }
};
const readLines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const twoThreads = () => [
  { id: "day-1", turns: [{ text: "first" }, { text: "second" }] },
  { id: "day-2", turns: [{ text: "third" }, { text: "fourth" }] },
];

/**
 * A scratch home plus the options for one run. `knobs` are PIBOT_TEST_* for the stub; the log
 * hook records every event and the run id comes back on the spawn events.
 */
async function setup(t, { knobs = {}, over = {} } = {}) {
  const s = await makeScratch({ botId: BOT, template });
  const capture = join(s.home, "capture.ndjson");
  const events = [];
  const sinceBootSec = bootSecNow();
  t.after(() => {
    const runIds = new Set(events.filter((e) => e.runId).map((e) => e.runId));
    for (const id of runIds) for (const pid of survivorsByMarker(id, { sinceBootSec })) if (carriesMarker(pid, id)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    const ours = (pid) => [...runIds].some((id) => carriesMarker(pid, id));
    for (const e of events) if (e.pid && ours(e.pid)) { try { process.kill(e.pid, "SIGKILL"); } catch {} }
    for (const c of readLines(capture)) if (c.pid && ours(c.pid)) { try { process.kill(c.pid, "SIGKILL"); } catch {} }
    s.cleanup();
  });
  const opts = {
    botDef: botDef(), models: models(), scratchHome: s.home, threads: twoThreads(), allowServers: [],
    piCli: STUB, wallMs: 120_000, turnTimeoutMs: 20_000, prodMaxPi: 99,
    parentEnv: { ...process.env, PIBOT_TEST_CAPTURE: capture, ...knobs },
    log: (e) => events.push({ ...e, t: Date.now() }),
    ...over,
  };
  const runIdOf = () => events.find((e) => e.runId)?.runId;
  const noSurvivors = async () => {
    const left = await settledSurvivorsByMarker(runIdOf(), { sinceBootSec });
    assert.deepEqual(left, [], left.map(describePid).join("\n"));
  };
  return { s, capture, events, opts, runIdOf, noSurvivors, sinceBootSec };
}

test("settledSurvivorsByMarker keeps a live marked process and drops it once dead", async () => {
  const id = `lpd-settle-${randomUUID()}`;
  const since = bootSecNow();
  const p = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", env: { ...process.env, CROW_EVAL_RUN_ID: id } });
  try {
    for (let i = 0; i < 100 && !carriesMarker(p.pid, id); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok((await settledSurvivorsByMarker(id, { sinceBootSec: since })).includes(p.pid));
  } finally { p.kill("SIGKILL"); }
  await new Promise((r) => p.on("exit", r));
  assert.deepEqual(await settledSurvivorsByMarker(id, { sinceBootSec: since }), []);
});

test("TURN_SLACK_MS and SESSION_MISSING values", () => {
  assert.equal(TURN_SLACK_MS, 140_000);
  assert.equal(SESSION_MISSING, "cannot find the pi session file for a completed turn; refusing to report it");
});

test("two threads: day 2 is a new pi session over the same DB", async (t) => {
  const ctx = await setup(t, { knobs: { PIBOT_TEST_REPLIES: JSON.stringify(["one", "two"]) } });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  assert.equal(r.contaminated, null);
  await ctx.noSurvivors();
  assert.deepEqual(r.threads.map((th) => th.id), ["day-1", "day-2"]);
  assert.deepEqual(r.threads.map((th) => th.turns.length), [2, 2]);
  const sids = r.threads.map((th) => [...new Set(th.turns.map((e) => e.piSessionId))]);
  assert.equal(sids[0].length, 1);
  assert.equal(sids[1].length, 1);
  assert.notEqual(sids[0][0], sids[1][0], "day 2 is a new pi session");
  for (const th of r.threads) {
    assert.equal(th.sessionPaths.length, 1);
    assert.ok(th.sessionPaths[0].startsWith(ctx.s.home + "/"), th.sessionPaths[0]);
    assert.ok(existsSync(th.sessionPaths[0]));
  }
  const d = new Database(ctx.s.dbPath, { readonly: true });
  const rows = d.prepare("SELECT gateway_thread_id, pi_session_id FROM bot_sessions WHERE bot_id = ? ORDER BY id").all(BOT);
  d.close();
  assert.deepEqual(rows.map((x) => x.gateway_thread_id), ["day-1", "day-2"]);
  // No global MCP servers reach the bot: the scratch HOME has no pi mcp.json.
  assert.equal(existsSync(join(ctx.s.home, ".pi", "agent", "mcp.json")), false);
  // models.json gets a stub apiKey; settings.json carries only the caller's packages.
  const written = JSON.parse(readFileSync(join(ctx.s.home, "pi-agent", "models.json"), "utf8"));
  assert.equal(written.providers.stub.apiKey, "stub");
  assert.deepEqual(JSON.parse(readFileSync(join(ctx.s.home, "pi-agent", "settings.json"), "utf8")), { packages: [] });
  assert.equal(typeof r.meta.crow_sha, "string");
  assert.match(r.meta.crow_sha, /^[0-9a-f]{40}$/);
});

test("extra env reaches the child", async (t) => {
  const ctx = await setup(t, { over: { env: { CROW_SESSION_BRIEFING: "0" } } });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  const starts = ctx.events.filter((e) => e.ev === "progress" && e.line.ev === "start");
  assert.equal(starts.length, 2);
  for (const s of starts) assert.deepEqual(s.line.flags, { CROW_SESSION_SUMMARIES: null, CROW_SESSION_BRIEFING: "0" });
  assert.deepEqual(r.meta.flags, { CROW_SESSION_SUMMARIES: null, CROW_SESSION_BRIEFING: "0" });
});

test("hung turn: bridge timeout path", async (t) => {
  const ctx = await setup(t, { knobs: { PIBOT_TEST_HANG: "1" }, over: { turnTimeoutMs: 1000 } });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, false);
  assert.match(r.contaminated, /^turn 1 action \S+/);
  assert.equal(r.threads.length, 1, "day 2 never runs");
  assert.equal(ctx.events.some((e) => e.ev === "kill"), false, "the bridge timed out first, not the parent");
  await ctx.noSurvivors();
});

test("hung turn is killed with its whole tree", async (t) => {
  const ctx = await setup(t, { knobs: { PIBOT_TEST_HANG: "1" }, over: { turnTimeoutMs: 600_000, turnSlackMs: 5000 - 600_000 } });
  // The capture file's appearance time, polled while the run is in flight.
  let capturedAt = null;
  const poll = setInterval(() => { if (capturedAt === null && existsSync(ctx.capture)) capturedAt = Date.now(); }, 20);
  let r;
  try { r = await runConversation(ctx.opts); } finally { clearInterval(poll); }
  assert.equal(r.ok, false);
  assert.match(r.contaminated, /^turn 1 of day-1 exceeded 5000 ms$/);
  const kill = ctx.events.find((e) => e.ev === "kill");
  assert.ok(kill, "the parent ran killTree");
  assert.ok(capturedAt !== null && capturedAt < kill.at, `pi had the prompt before the kill (captured ${capturedAt}, kill ${kill.at})`);
  const cap = readLines(ctx.capture)[0];
  assert.ok(cap && cap.pid);
  assert.equal(alive(cap.pid), false, "the stub pi is gone");
  assert.equal(r.threads.length, 1);
  await ctx.noSurvivors();
});

test("crashed pi mid-turn is contaminated", async (t) => {
  const ctx = await setup(t, { knobs: { PIBOT_TEST_CRASH: "1" } });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, false);
  assert.match(r.contaminated, /^turn 1 action error/);
  assert.ok(r.reason && r.reason.length > 0, "the stderr tail is in reason");
  await ctx.noSurvivors();
});

test("no request reaches /llm/acquire", async (t) => {
  const hits = [];
  const srv = createServer((req, res) => { hits.push(req.url); res.end("{}"); });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  t.after(() => srv.close());
  const port = srv.address().port;
  const saved = { ...process.env };
  try {
    process.env.CROW_GATEWAY_PORT = String(port);
    process.env.PIBOT_WARM_GATEWAY_URL = `http://127.0.0.1:${port}`;
    const ctx = await setup(t);
    delete ctx.opts.parentEnv; // the default path: the parent's own process.env
    const r = await runConversation(ctx.opts);
    assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
    assert.equal(r.threads.length, 2);
    await ctx.noSurvivors();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assert.deepEqual(hits, []);
});

test("package shas recorded", async (t) => {
  const pkg = mkdtempSync(join(tmpdir(), "lpd-pkg-"));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", ["-C", pkg, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(pkg, "package.json"), "{}");
  git("add", "package.json");
  git("commit", "-q", "-m", "init");
  const plain = mkdtempSync(join(tmpdir(), "lpd-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  const ctx = await setup(t, { over: { piPackages: [pkg, plain], threads: [{ id: "day-1", turns: [{ text: "hi" }] }] } });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  assert.deepEqual(r.meta.packages, [{ path: pkg, sha: git("rev-parse", "HEAD") }, { path: plain, sha: null }]);
  assert.deepEqual(JSON.parse(readFileSync(join(ctx.s.home, "pi-agent", "settings.json"), "utf8")), { packages: [pkg, plain] });
});

test("wall cap", async (t) => {
  const ctx = await setup(t, { knobs: { PIBOT_TEST_HANG: "1" }, over: { wallMs: 1500 } });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, false);
  assert.equal(r.contaminated, "conversation exceeded wallMs");
  assert.equal(r.threads.length, 1);
  await ctx.noSurvivors();
});

test("signal-killed child is contaminated", async (t) => {
  let killed = false;
  const ctx = await setup(t, { knobs: { PIBOT_TEST_HANG: "1" } });
  const inner = ctx.opts.log;
  ctx.opts.log = (e) => {
    inner(e);
    if (!killed && e.ev === "progress" && e.line.ev === "turn-start") {
      killed = true;
      const spawnEv = ctx.events.find((x) => x.ev === "spawn");
      process.kill(spawnEv.pid, "SIGKILL");
    }
  };
  const r = await runConversation(ctx.opts);
  assert.ok(killed);
  assert.equal(r.ok, false);
  assert.match(r.contaminated, /SIGKILL/);
  await ctx.noSurvivors();
});

test("missing session file is contaminated", async (t) => {
  const ctx = await setup(t, { knobs: { PIBOT_TEST_NO_JSONL: "1" } });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, false);
  assert.equal(r.contaminated, SESSION_MISSING);
  assert.equal(r.threads.length, 1);
  await ctx.noSurvivors();
});

test("refusal spawns nothing", async (t) => {
  const ctx = await setup(t, { over: { models: models("http://127.0.0.1:3001/v1") } });
  await assert.rejects(runConversation(ctx.opts), (e) => e instanceof DriverRefusal && /gateway port/.test(e.message));
  assert.equal(existsSync(ctx.capture), false);
  assert.equal(ctx.events.some((e) => e.ev === "spawn"), false);
});

test("pre-spawn refusals: piCli, piPackages, threads, wallMs", async (t) => {
  const ctx = await setup(t);
  const cases = [
    [{ piCli: join(ctx.s.home, "no-such-pi") }, /piCli/],
    [{ piPackages: ["relative/pkg"] }, /piPackages/],
    [{ piPackages: [join(ctx.s.home, "missing-pkg")] }, /piPackages/],
    [{ threads: [] }, /threads/],
    [{ threads: [{ id: "a", turns: [{ text: "x" }] }, { id: "a", turns: [{ text: "y" }] }] }, /unique/],
    [{ threads: [{ id: "../a", turns: [{ text: "x" }] }] }, /thread id/],
    [{ wallMs: undefined }, /wallMs/],
    [{ allowServers: undefined }, /allowServers/],
  ];
  for (const [over, re] of cases) {
    await assert.rejects(runConversation({ ...ctx.opts, ...over }), (e) => e instanceof DriverRefusal && re.test(e.message), JSON.stringify(over));
  }
  assert.equal(existsSync(ctx.capture), false);
  assert.equal(ctx.events.some((e) => e.ev === "spawn"), false);
  assert.equal(existsSync(join(ctx.s.home, "pi-agent", "models.json")), false, "nothing is written before the guards pass");
});

test("parentEnv never weakens the guards", async (t) => {
  const ctx = await setup(t);
  const saved = { ...process.env };
  const restore = () => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); };
  const parentEnv = { ...ctx.opts.parentEnv };
  delete parentEnv.CROW_GATEWAY_PORT;
  delete parentEnv.CROW_SUITE_PROTECTED_ROOTS;
  try {
    // The real process.env's gateway port is refused although parentEnv lacks it.
    process.env.CROW_GATEWAY_PORT = "3999";
    await assert.rejects(runConversation({ ...ctx.opts, parentEnv, models: models("http://127.0.0.1:3999/v1") }),
      (e) => e instanceof DriverRefusal && /port 3999 is a gateway port/.test(e.message));
    delete process.env.CROW_GATEWAY_PORT;
    // parentEnv's gateway port is refused too.
    await assert.rejects(runConversation({ ...ctx.opts, parentEnv: { ...parentEnv, CROW_GATEWAY_PORT: "3998" }, models: models("http://127.0.0.1:3998/v1") }),
      (e) => e instanceof DriverRefusal && /port 3998 is a gateway port/.test(e.message));
    // A protected root in the real process.env applies although parentEnv lacks it.
    process.env.CROW_SUITE_PROTECTED_ROOTS = [saved.CROW_SUITE_PROTECTED_ROOTS, ctx.s.home].filter(Boolean).join("\n");
    await assert.rejects(runConversation({ ...ctx.opts, parentEnv }), (e) => e instanceof DriverRefusal && /protected/.test(e.message));
  } finally { restore(); }
  assert.equal(existsSync(ctx.capture), false);
  assert.equal(ctx.events.some((e) => e.ev === "spawn"), false);
});

test("parent module loads no bridge or DB code", () => {
  const src = readFileSync(DRIVER, "utf8");
  const specs = [
    ...[...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]),
    ...[...src.matchAll(/^import\s+"([^"]+)"/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^export\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]),
    ...[...src.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]),
  ];
  assert.ok(specs.length > 0);
  for (const s of specs) assert.doesNotMatch(s, /pi-bots\/bridge|better-sqlite3|servers\/db/, `import ${s}`);
});
