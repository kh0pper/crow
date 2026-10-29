/**
 * The live pi driver child: one thread of handleInbound turns in a scratch Crow home, against
 * the protocol-speaking stub pi (tests/fixtures/live-pi-driver/stub-pi.mjs). Each test builds
 * its own scratch from a shared template and spawns the child exactly as the parent will:
 * detached, stdout/stderr as files in the scratch home, never pipes. Every process a test
 * starts is killed in t.after, found by the run marker as well as by pid.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { childEnv, survivorsByMarker, settledSurvivorsByMarker, bootSecNow, KILL_GRACE_MS } from "../scripts/lib/live-pi-driver.mjs";
import { makeScratch, makeTemplate } from "../scripts/research-eval/scratch.mjs";

const REPO = join(import.meta.dirname, "..");
const CHILD = join(REPO, "scripts", "lib", "live-pi-driver-child.mjs");
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

const alive = (pid) => {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0] !== "Z"; } catch { return false; }
};
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() >= end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * One scratch home with models.json, settings.json, a job file and the child env. `knobs` are
 * PIBOT_TEST_* values handed to the child through childEnv's test-context passthrough.
 */
async function setup(t, { job = {}, knobs = {}, extraEnv = {}, turnTimeoutMs = 20000 } = {}) {
  const s = await makeScratch({ botId: BOT, template });
  const runId = `lpd-child-${randomUUID()}`;
  const sinceBootSec = bootSecNow();
  t.after(() => {
    // Only a pid whose environ positively carries the marker: an unreadable one may be anything.
    for (const pid of survivorsByMarker(runId, { sinceBootSec })) {
      let mine = false;
      try { mine = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`CROW_EVAL_RUN_ID=${runId}`); } catch {}
      if (mine) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
    s.cleanup();
  });
  const agentDir = join(s.home, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { stub: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "m1" }] } },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const capture = join(s.home, "capture.ndjson");
  const env = childEnv({
    home: s.home, botId: BOT, runId, piCli: STUB, turnTimeoutMs, extraEnv,
    parent: { ...process.env, PIBOT_TEST_CAPTURE: capture, ...knobs },
  });
  const jobPath = join(s.home, "job.json");
  const progressPath = join(s.home, "progress.ndjson");
  const fullJob = {
    botDef: botDef(), gatewayType: "perch", allowServers: [], allowSkills: [], allowToolless: true, prodMaxPi: 99,
    capacityCount: null, mcpOverrides: null, runId, thread: { id: "thread-1", turns: [{ text: "hello" }] }, ...job,
  };
  writeFileSync(jobPath, JSON.stringify(fullJob));
  const files = { out: join(s.home, "driver-thread-1.out"), err: join(s.home, "driver-thread-1.err") };
  return { s, runId, sinceBootSec, env, jobPath, progressPath, capture, files };
}

/** Spawn the child as the parent will (detached, file fds) and wait for its exit. */
function runChild(t, ctx, envOver = {}) {
  const outFd = openSync(ctx.files.out, "a");
  const errFd = openSync(ctx.files.err, "a");
  const env = { ...ctx.env, ...envOver };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const c = spawn(process.execPath, [CHILD, ctx.jobPath, ctx.progressPath], { cwd: ctx.s.home, env, stdio: ["ignore", outFd, errFd], detached: true });
  closeSync(outFd); closeSync(errFd);
  t.after(() => { try { process.kill(c.pid, "SIGKILL"); } catch {} });
  return new Promise((res) => c.on("exit", (code, signal) => res({ code, signal })));
}

const progress = (ctx) => (existsSync(ctx.progressPath)
  ? readFileSync(ctx.progressPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const captured = (ctx) => (existsSync(ctx.capture)
  ? readFileSync(ctx.capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const stderr = (ctx) => (existsSync(ctx.files.err) ? readFileSync(ctx.files.err, "utf8") : "");
/** After an exit, nothing carrying the run marker may be left (pi carries it: CROW_BOT_ENV_ALLOW). */
const assertNoSurvivors = async (ctx) => assert.deepEqual(await settledSurvivorsByMarker(ctx.runId, { sinceBootSec: ctx.sinceBootSec }), []);
const turnEnds = (ctx) => progress(ctx).filter((e) => e.ev === "turn-end");

test("refuses a live warm target", async (t) => {
  const ctx = await setup(t);
  const r = await runChild(t, ctx, { PIBOT_WARM_GATEWAY_URL: "http://127.0.0.1:3001" });
  assert.equal(r.code, 1, stderr(ctx));
  await assertNoSurvivors(ctx);
  assert.equal(existsSync(ctx.capture), false, "no pi may start");
  assert.match(stderr(ctx), /PIBOT_WARM_GATEWAY_URL/);
});

test("refuses when prod capacity is at max - 1", async (t) => {
  const ctx = await setup(t, { job: { prodMaxPi: 2, capacityCount: 1 } });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 6, stderr(ctx));
  await assertNoSurvivors(ctx);
  const evs = progress(ctx);
  assert.deepEqual(evs.find((e) => e.ev === "capacity"), { ev: "capacity", live: 1, max: 2 });
  assert.equal(evs.some((e) => e.ev === "turn-start" || e.ev === "turn-end"), false);
  assert.equal(existsSync(ctx.capture), false, "no pi may start");
});

test("refuses a test-only capacityCount outside a test context (R-1)", async (t) => {
  const ctx = await setup(t, { job: { capacityCount: 0 } });
  const r = await runChild(t, ctx, { NODE_TEST_CONTEXT: undefined });
  assert.equal(r.code, 1, stderr(ctx));
  await assertNoSurvivors(ctx);
  assert.match(stderr(ctx), /capacityCount/);
  assert.equal(existsSync(ctx.capture), false);
});

test("refuses a non-scratch env", async (t) => {
  const ctx = await setup(t);
  const r = await runChild(t, ctx, { CROW_HOME: homedir() });
  assert.equal(r.code, 1, stderr(ctx));
  await assertNoSurvivors(ctx);
  assert.equal(existsSync(ctx.progressPath), false, "nothing is written before the guard");
  // The guard's own rule text: the refusal came from assertEvalEnv, before any bridge import.
  assert.match(stderr(ctx), /refused: CROW_HOME must be strictly below the temp dir/);
});

test("refuses job and progress paths outside CROW_HOME", async (t) => {
  const ctx = await setup(t);
  const outside = join(ctx.s.home, "..", `lpd-outside-${randomUUID()}.ndjson`);
  const r = await new Promise((res) => {
    const errFd = openSync(ctx.files.err, "a");
    const c = spawn(process.execPath, [CHILD, ctx.jobPath, outside], { cwd: ctx.s.home, env: ctx.env, stdio: ["ignore", "ignore", errFd], detached: true });
    closeSync(errFd);
    c.on("exit", (code) => res({ code }));
  });
  assert.equal(r.code, 1);
  await assertNoSurvivors(ctx);
  assert.equal(existsSync(outside), false);
  assert.match(stderr(ctx), /strictly inside CROW_HOME/);
});

test("refuses a non-empty providers table", async (t) => {
  const ctx = await setup(t);
  const d = new Database(ctx.s.dbPath);
  d.prepare("INSERT INTO providers (id, base_url, models) VALUES (?, ?, ?)").run("stub", "http://127.0.0.1:9/v1", JSON.stringify([{ id: "m1" }]));
  d.close();
  const r = await runChild(t, ctx);
  assert.equal(r.code, 1, stderr(ctx));
  await assertNoSurvivors(ctx);
  assert.match(stderr(ctx), /providers/);
  assert.equal(existsSync(ctx.capture), false);
});

test("refuses a tool surface outside allowServers", async (t) => {
  const ctx = await setup(t, { job: { botDef: botDef({ tools: { pi_builtin: ["read"], crow_mcp: ["memory/crow_recall"] } }) } });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 1, stderr(ctx));
  await assertNoSurvivors(ctx);
  assert.match(stderr(ctx), /crow_mcp server memory is not in allowServers/);
  assert.equal(existsSync(ctx.capture), false);
});

test("refuses an effective tool grant with no server/tool entry", async (t) => {
  const ctx = await setup(t, { job: { allowToolless: false } });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 1, stderr(ctx));
  await assertNoSurvivors(ctx);
  assert.match(stderr(ctx), /effective tools: .*server\/tool/);
  assert.equal(existsSync(ctx.capture), false);
});

test("refuses a non-boolean allowToolless", async (t) => {
  const ctx = await setup(t, { job: { allowToolless: "yes" } });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 1, stderr(ctx));
  assert.match(stderr(ctx), /allowToolless must be a boolean/);
  assert.equal(existsSync(ctx.capture), false);
});

test("refuses a thread id that already has a session row in this scratch", async (t) => {
  const ctx = await setup(t);
  const first = await runChild(t, ctx);
  assert.equal(first.code, 0, stderr(ctx));
  assert.equal(captured(ctx).length, 1);
  const r = await runChild(t, ctx);
  assert.equal(r.code, 1, stderr(ctx));
  await assertNoSurvivors(ctx);
  assert.match(stderr(ctx), /refused: thread thread-1 already exists in this scratch/);
  assert.equal(captured(ctx).length, 1, "no second pi may start");
  assert.equal(progress(ctx).filter((e) => e.ev === "start").length, 1, "the refused run emits nothing");
});

test("runs three turns on one pi session", async (t) => {
  const ctx = await setup(t, {
    job: { thread: { id: "thread-1", turns: [{ text: "first" }, { text: "second" }, { text: "third" }] } },
    knobs: { PIBOT_TEST_REPLIES: JSON.stringify(["one", "two", "three"]) },
    extraEnv: { CROW_SESSION_SUMMARIES: "1" },
  });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 0, stderr(ctx));
  await assertNoSurvivors(ctx);
  // The run marker reaches pi itself (childEnv pins CROW_BOT_ENV_ALLOW=CROW_EVAL_RUN_ID).
  const caps = captured(ctx);
  assert.equal(caps.length, 3);
  assert.ok(caps.every((c) => c.runMarker === ctx.runId), JSON.stringify(caps.map((c) => c.runMarker)));
  const evs = progress(ctx);
  assert.deepEqual(evs[0], { ev: "start", thread: "thread-1", flags: { CROW_SESSION_SUMMARIES: "1", CROW_SESSION_BRIEFING: null } });
  assert.deepEqual(evs.at(-1), { ev: "done", thread: "thread-1" });
  const ends = turnEnds(ctx);
  assert.equal(ends.length, 3);
  assert.deepEqual(ends.map((e) => [e.turn, e.injected, e.action, e.reply]), [[0, false, "asked", "one"], [1, false, "asked", "two"], [2, false, "asked", "three"]]);
  const sid = ends[0].piSessionId;
  assert.ok(sid, "a pi session id");
  assert.ok(ends.every((e) => e.piSessionId === sid), "every turn resumed the same pi session");
  const sessionDir = join(ctx.s.home, "pi-bots", BOT, "sessions");
  assert.ok(ends.every((e) => e.sessionDir === sessionDir));
  const files = readdirSync(sessionDir).filter((n) => n.endsWith(`_${sid}.jsonl`));
  assert.equal(files.length, 1, "one session file for the thread");
  const lines = readFileSync(join(sessionDir, files[0]), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.type === "message" && l.message.role === "user").length, 3);
});

test("injects the matching canned answer", async (t) => {
  const ctx = await setup(t, {
    job: { thread: { id: "thread-1", turns: [
      { text: "draft the memo", answers: [{ when: "which draft", text: "B" }] }, { text: "next" }, { text: "last" },
    ] } },
    knobs: { PIBOT_TEST_REPLIES: JSON.stringify(["Which draft, A or B?", "ok", "ok", "ok"]) },
  });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 0, stderr(ctx));
  const ends = turnEnds(ctx);
  assert.deepEqual(ends.map((e) => [e.turn, e.injected]), [[0, false], [0, true], [1, false], [2, false]]);
  const prompts = captured(ctx).map((c) => c.prompt);
  assert.equal(prompts.length, 4);
  assert.match(prompts[1], /User said: "B"/);
});

test("at most one injected answer per turn", async (t) => {
  const ctx = await setup(t, {
    job: { thread: { id: "thread-1", turns: [{ text: "one", otherwise: "go on" }, { text: "two", otherwise: "go on" }] } },
    knobs: { PIBOT_TEST_REPLIES: JSON.stringify(["Really?"]) },
  });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 0, stderr(ctx));
  assert.deepEqual(turnEnds(ctx).map((e) => [e.turn, e.injected]), [[0, false], [0, true], [1, false], [1, true]]);
});

test("unexpected question gets otherwise", async (t) => {
  const ctx = await setup(t, {
    job: { thread: { id: "thread-1", turns: [{ text: "go", answers: [{ when: "which draft", text: "B" }], otherwise: "Yes, proceed." }] } },
    knobs: { PIBOT_TEST_REPLIES: JSON.stringify(["Shall I proceed?", "Done."]) },
  });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 0, stderr(ctx));
  const ends = turnEnds(ctx);
  assert.deepEqual(ends.map((e) => [e.injected, e.reply]), [[false, "Shall I proceed?"], [true, "Done."]]);
  assert.match(captured(ctx)[1].prompt, /User said: "Yes, proceed\."/);
});

test("non-asked action stops the thread with exit 4", async (t) => {
  const ctx = await setup(t, {
    job: { thread: { id: "thread-1", turns: [{ text: "first" }, { text: "second" }] } },
    knobs: { PIBOT_TEST_CRASH: "1" },
  });
  const r = await runChild(t, ctx);
  assert.equal(r.code, 4, stderr(ctx));
  await assertNoSurvivors(ctx);
  const evs = progress(ctx);
  const ends = evs.filter((e) => e.ev === "turn-end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].action, "error");
  assert.equal(evs.some((e) => e.ev === "turn-start" && e.turn === 1), false, "turn 2 never runs");
  assert.equal(evs.some((e) => e.ev === "done"), false);
  assert.equal(captured(ctx).length, 1);
});

// An intermediate node spawns the child exactly as runConversation does (same fds, same detached
// flag), then the test SIGKILLs the intermediate mid-turn.
const INTERMEDIATE = `
const fs = require("node:fs"); const { spawn } = require("node:child_process");
const [child, job, prog, outP, errP, envP, cwd] = process.argv.slice(1);
const out = fs.openSync(outP, "a"); const err = fs.openSync(errP, "a");
const c = spawn(process.execPath, [child, job, prog], { cwd, env: JSON.parse(fs.readFileSync(envP, "utf8")), stdio: ["ignore", out, err], detached: true });
console.log(c.pid);
setInterval(() => {}, 60000);`;

for (const variant of [{ name: "child dies with its parent", knobs: {} }, { name: "child dies with its parent (stub pi ignores SIGTERM)", knobs: { PIBOT_TEST_IGNORE_TERM: "1" } }]) {
  test(variant.name, async (t) => {
    const ctx = await setup(t, { knobs: { PIBOT_TEST_HANG: "1", ...variant.knobs }, turnTimeoutMs: 120000 });
    const envPath = join(ctx.s.home, "child-env.json");
    writeFileSync(envPath, JSON.stringify(ctx.env));
    const mid = spawn(process.execPath, ["-e", INTERMEDIATE, CHILD, ctx.jobPath, ctx.progressPath, ctx.files.out, ctx.files.err, envPath, ctx.s.home],
      { stdio: ["ignore", "pipe", "ignore"] });
    t.after(() => { try { mid.kill("SIGKILL"); } catch {} });
    const childPid = await new Promise((res, rej) => {
      let buf = "";
      mid.stdout.on("data", (d) => { buf += d; const m = buf.match(/^(\d+)\n/); if (m) res(Number(m[1])); });
      mid.on("exit", () => rej(new Error("intermediate exited early")));
    });
    t.after(() => { try { process.kill(childPid, "SIGKILL"); } catch {} });
    const cap = await until(() => captured(ctx)[0], 20000);
    assert.ok(cap, `the stub pi got the prompt (stderr: ${stderr(ctx)})`);
    t.after(() => { try { process.kill(cap.pid, "SIGKILL"); } catch {} });
    assert.ok(alive(cap.pid) && alive(childPid));
    assert.equal(cap.runMarker, ctx.runId, "pi carries the run marker");
    assert.ok(survivorsByMarker(ctx.runId, { sinceBootSec: ctx.sinceBootSec }).includes(cap.pid), "the marker scan sees the stub pi");
    assert.equal(cap.ignoresTerm, !!variant.knobs.PIBOT_TEST_IGNORE_TERM, "the variant knob reached the stub pi");
    const killedAt = Date.now();
    mid.kill("SIGKILL");
    // The child notices within 1 s; a SIGTERM-ignoring pi costs the full kill grace on top.
    const budget = 5000 + (variant.knobs.PIBOT_TEST_IGNORE_TERM ? KILL_GRACE_MS : 0);
    const clear = await until(() => !survivorsByMarker(ctx.runId, { sinceBootSec: ctx.sinceBootSec }).length && !alive(cap.pid) && !alive(childPid), budget);
    assert.ok(clear, `survivors: ${survivorsByMarker(ctx.runId, { sinceBootSec: ctx.sinceBootSec })}, stub alive ${alive(cap.pid)}, child alive ${alive(childPid)}`);
    assert.match(stderr(ctx), /parent died/);
    // Only a SIGKILL after the grace can stop a SIGTERM-ignoring stub (nothing signals the child itself).
    if (variant.knobs.PIBOT_TEST_IGNORE_TERM) assert.ok(Date.now() - killedAt >= KILL_GRACE_MS - 500, "the stub outlived SIGTERM");
    assert.equal(turnEnds(ctx).length, 0, "the killed turn writes no turn-end");
  });
}

test("the child's static imports are node built-ins and the guard alone", () => {
  const src = readFileSync(CHILD, "utf8");
  const specs = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(s.startsWith("node:") || ["./eval-guard.mjs", "./protected-paths.mjs"].includes(s), `static import ${s}`);
});
