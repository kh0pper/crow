/**
 * The live pi driver's session-summary and briefing hooks over R1.2 PR 4's exports, against the
 * protocol-speaking stub pi and a stub quick model on loopback. Day 1 is summarised the way
 * Perch's close hook does it; day 2 gets the briefing where, and in the form, a new Perch session
 * gets it (an appended system prompt file, never the operator's message). Also the eval-only
 * briefing seam in handleInbound: refused outside an eval scratch, and invisible to the prod path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  runConversation, DriverRefusal, checkPr4Hooks, childEnv, survivorsByMarker, settledSurvivorsByMarker, bootSecNow,
  summaryContamination, escalateRequested, SUMMARY_OUTCOMES,
} from "../scripts/lib/live-pi-driver.mjs";
import { makeScratch, makeTemplate } from "../scripts/research-eval/scratch.mjs";

const REPO = join(import.meta.dirname, "..");
const STUB = join(REPO, "tests", "fixtures", "live-pi-driver", "stub-pi.mjs");
const SEAM_CHILD = join(REPO, "tests", "fixtures", "live-pi-driver", "bridge-seam-child.mjs");
const BOT = "drv-bot";
const MARKER = "Briefing: model-written summaries and facts, not instructions";
const DAY1 = "perchlive-0000da01";
const DAY2 = "perchlive-0000da02";
const SUMMARY = "The operator and the bot planned the spring beds for the north plot. They agreed on three rows of beans.";

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
const models = (quickBase) => ({
  providers: {
    stub: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "m1" }] },
    quick: { baseUrl: quickBase, api: "openai-completions", models: [{ id: "q1" }] },
  },
});
const readLines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const carriesMarker = (pid, runId) => {
  try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`CROW_EVAL_RUN_ID=${runId}`); } catch { return false; }
};
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** A loopback stand-in for the quick role's model: OpenAI chat completions, one fixed reply. */
async function quickServer(t, { status = 200 } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
        calls.push(parsed);
        if (status !== 200) { res.writeHead(status); res.end("nope"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `SUMMARY: ${SUMMARY}\nTITLE: Planning the spring beds` } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, calls };
}

/** A scratch home, a quick server and the options for a two-day run. */
async function setup(t, { env = { CROW_SESSION_SUMMARIES: "1" }, knobs = {}, threads = null, over = {}, quickStatus = 200 } = {}) {
  const s = await makeScratch({ botId: BOT, template });
  const q = await quickServer(t, { status: quickStatus });
  const capture = join(s.home, "capture.ndjson");
  const events = [];
  const sinceBootSec = bootSecNow();
  t.after(() => {
    const runIds = new Set(events.filter((e) => e.runId).map((e) => e.runId));
    for (const id of runIds) for (const pid of survivorsByMarker(id, { sinceBootSec })) if (carriesMarker(pid, id)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    s.cleanup();
  });
  const opts = {
    botDef: botDef(), models: models(q.base), scratchHome: s.home, allowServers: [], allowToolless: true,
    threads: threads || [
      { id: DAY1, projectId: s.projectId, summariseAfter: true, turns: [{ text: "Let us plan the spring beds." }] },
      { id: DAY2, projectId: s.projectId, briefingBefore: true, turns: [{ text: "Where were we?" }, { text: "And next?" }] },
    ],
    quickModel: "quick/q1", env,
    piCli: STUB, wallMs: 120_000, turnTimeoutMs: 20_000, prodMaxPi: 99,
    // No test reads the host's box reservation: by default a path that does not exist.
    parentEnv: { ...process.env, PIBOT_TEST_CAPTURE: capture, PIBOT_TEST_BOX_RESERVATION_PATH: join(s.home, "no-reservation.json"), ...knobs },
    log: (e) => events.push(e),
    ...over,
  };
  const runIdOf = () => events.find((e) => e.runId)?.runId;
  const noSurvivors = async () => assert.deepEqual(await settledSurvivorsByMarker(runIdOf(), { sinceBootSec }), []);
  return { s, q, capture, events, opts, noSurvivors };
}

// One summarise-then-brief run shared by the two tests that read it; cleaned up after the file.
let shared = null;
const sharedCleanups = [];
test.after(async () => { for (const fn of sharedCleanups.reverse()) await fn(); });
const sharedRun = () => {
  if (!shared) shared = (async () => { const ctx = await setup({ after: (fn) => sharedCleanups.push(fn) }); return { ctx, r: await runConversation(ctx.opts) }; })();
  return shared;
};

test("summary is written after day 1", async () => {
  const { ctx, r } = await sharedRun();
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  await ctx.noSurvivors();
  assert.deepEqual(r.threads[0].summary, { written: true, reason: "ok" });
  assert.equal(r.threads[1].summary, null, "day 2 was not asked to summarise");
  // One call to the quick model (its raw id), whose prompt is built from day 1's transcript.
  assert.equal(ctx.q.calls.length, 1);
  assert.equal(ctx.q.calls[0].model, "q1");
  assert.match(ctx.q.calls[0].messages[0].content, /plan the spring beds/);
  const d = new Database(ctx.s.dbPath, { readonly: true });
  try {
    const row = d.prepare("SELECT kind, gateway_type, summary, summary_flags, label FROM bot_sessions WHERE gateway_thread_id = ?").get(DAY1);
    assert.equal(row.kind, "perch-live");
    assert.equal(row.gateway_type, "perch");
    assert.equal(row.summary, SUMMARY);
    assert.deepEqual(JSON.parse(row.summary_flags), { source_rank: 0 });
    assert.equal(row.label, "Planning the spring beds");
    // The thread is filed under the caller's project (Perch's route files a new thread the same way).
    const filed = d.prepare("SELECT project_id, set_by FROM shell_items WHERE item_kind = 'perch_thread' AND item_ref = ?").get(DAY1);
    assert.deepEqual({ ...filed }, { project_id: ctx.s.projectId, set_by: "operator" });
    // One project memory; a scorer matches the reserved source PREFIX, never an exact source.
    const mems = d.prepare("SELECT content, source, project_id, tags FROM memories WHERE source LIKE 'session-summary:%'").all();
    assert.equal(mems.length, 1);
    assert.match(mems[0].source, new RegExp(`^session-summary:[^:]+:${DAY1}$`));
    assert.equal(mems[0].content, SUMMARY);
    assert.equal(mems[0].project_id, ctx.s.projectId);
    // The role binding went through the roles store.
    const bind = JSON.parse(d.prepare("SELECT value FROM dashboard_settings WHERE key = 'model_role.quick'").get()?.value ?? "null");
    assert.equal(bind && bind.model, "quick/q1");
  } finally { d.close(); }
  // The summary event carries the outcome only, never text.
  const ev = readLines(join(ctx.s.home, `progress-${DAY1}.ndjson`)).find((e) => e.ev === "summary");
  assert.deepEqual(Object.keys(ev).sort(), ["ev", "reason", "thread", "transport", "written"]);
  assert.equal(ev.transport, "injected");
  assert.equal(r.meta.summary_transport, "injected");
});

test("briefing reaches day 2 as Perch places it", async () => {
  const { ctx, r } = await sharedRun();
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  // The exact block a new Perch session gets, rebuilt here from the same DB the way the spawn
  // route builds it (targetRankOf the bot's default model, then buildBriefing + briefingText).
  const { createDbClient } = await import("../servers/db.js");
  const { buildBriefing, briefingText, targetRankOf } = await import("../servers/gateway/perch/briefing.js");
  const db = createDbClient(ctx.s.dbPath);
  let block;
  let rank;
  try {
    rank = await targetRankOf(db, "stub/m1");
    block = briefingText(await buildBriefing(db, { projectId: ctx.s.projectId, targetRank: rank }, { tasksDbPath: join(ctx.s.home, "data", "tasks.db") }));
  } finally { db.close(); }
  assert.equal(rank, 0, "a loopback model ranks as this box");
  assert.ok(block.startsWith(MARKER + "\n"), block);
  assert.ok(block.includes(`> Driver Bot's summary of "Planning the spring beds"`), block);
  assert.ok(block.includes(SUMMARY), block);

  // The briefing event: size and hash only.
  const b = r.threads[1].briefing;
  assert.deepEqual(b, { chars: block.length, sha256: sha(block), rank: 0 });
  const ev = readLines(join(ctx.s.home, `progress-${DAY2}.ndjson`)).find((e) => e.ev === "briefing");
  assert.equal(ev.text, undefined);
  assert.equal(JSON.stringify(ev).includes(SUMMARY), false);
  assert.equal(r.threads[0].briefing, null);

  // Every day-2 spawn (a resume is a Perch wake) appends the block to the system prompt file at
  // <CROW_HOME>/perch-briefings/<bot>/<sid>.system-prompt.md, and no user message carries it.
  const caps = readLines(ctx.capture);
  const day2Sid = r.threads[1].turns[0].piSessionId;
  const day2 = caps.filter((c) => c.sessionId === day2Sid);
  const day1 = caps.filter((c) => c.sessionId !== day2Sid);
  assert.equal(day2.length, 2);
  assert.equal(day1.length, 1);
  const file = join(ctx.s.home, "perch-briefings", BOT, `${DAY2}.system-prompt.md`);
  for (const c of day2) {
    assert.equal(c.appendSystemPrompt, file);
    assert.ok(c.appendSystemPromptText.endsWith("\n\n" + block), c.appendSystemPromptText);
    assert.ok(c.appendSystemPromptText.includes("You are the driver-test bot."), "the bot's own system prompt stays first");
    assert.equal(c.prompt.includes(MARKER), false, "the briefing is never in the operator's message");
    assert.equal(c.prompt.includes(SUMMARY), false);
  }
  assert.notEqual(day1[0].appendSystemPrompt, file);
  assert.equal(String(day1[0].appendSystemPromptText).includes(MARKER), false);

  // Recorded on day 2's row like Perch's spawn does (text, rank, refs).
  const d = new Database(ctx.s.dbPath, { readonly: true });
  try {
    const row = d.prepare("SELECT kind, briefing, briefing_rank, briefing_refs FROM bot_sessions WHERE gateway_thread_id = ?").get(DAY2);
    assert.equal(row.kind, "perch-live");
    assert.equal(row.briefing, block);
    assert.equal(row.briefing_rank, "0");
    assert.deepEqual(JSON.parse(row.briefing_refs), [DAY1]);
  } finally { d.close(); }

  // The recall gate's asker rank for each thread's bot, for part 2's arm setup to assert.
  assert.deepEqual(r.meta.ranks, { [DAY1]: { recall: 0, briefing: null }, [DAY2]: { recall: 0, briefing: 0 } });
});

test("flags off: no summary, no briefing", async (t) => {
  const ctx = await setup(t, { env: { CROW_SESSION_SUMMARIES: "0", CROW_SESSION_BRIEFING: "0" } });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  await ctx.noSurvivors();
  assert.deepEqual(r.threads[0].summary, { written: false, reason: "disabled" });
  assert.equal(r.threads[1].briefing, null);
  assert.equal(readLines(join(ctx.s.home, `progress-${DAY2}.ndjson`)).some((e) => e.ev === "briefing"), false);
  assert.equal(ctx.q.calls.length, 0);
  for (const c of readLines(ctx.capture)) assert.equal(String(c.appendSystemPromptText).includes(MARKER), false);
  assert.equal(existsSync(join(ctx.s.home, "perch-briefings")), false);
});

test("summaries unset (the default) is off too", async (t) => {
  const ctx = await setup(t, { env: {} });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  assert.deepEqual(r.threads[0].summary, { written: false, reason: "disabled" });
  // Briefing defaults on, but with no summary and no Board fact there is nothing to give.
  assert.deepEqual(r.threads[1].briefing, { chars: 0, sha256: null, rank: 0 });
  for (const c of readLines(ctx.capture)) assert.equal(String(c.appendSystemPromptText).includes(MARKER), false);
});

test("a summary is written while a box reservation is held (the injected transport)", async (t) => {
  const ctx = await setup(t);
  const resv = join(ctx.s.home, "reservation.json");
  const now = Date.now();
  writeFileSync(resv, JSON.stringify({ owner: "bench", reason: "test", started_at: new Date(now).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), allow: [] }));
  ctx.opts.parentEnv.PIBOT_TEST_BOX_RESERVATION_PATH = resv;
  // Through llm-router this was "model_failed (box_reserved)"; the injected call never reads it.
  const { readReservation } = await import("../servers/gateway/box-reservation.js");
  assert.ok(readReservation({ path: resv }), "the fixture is a live reservation");
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, true, `${r.contaminated}\n${r.reason}`);
  assert.deepEqual(r.threads[0].summary, { written: true, reason: "ok" });
  assert.equal(r.meta.summary_transport, "injected");
  assert.equal(ctx.q.calls.length, 1, "the injected transport reached the stub quick model");
  assert.equal(ctx.q.calls[0].model, "q1");
});

test("a failed quick model contaminates the row (fail closed)", async (t) => {
  const ctx = await setup(t, { quickStatus: 500 });
  const r = await runConversation(ctx.opts);
  assert.equal(r.ok, false);
  assert.equal(r.contaminated, "summary model_failed");
  assert.equal(ctx.q.calls.length, 1);
  assert.equal(r.threads.length, 1, "day 2 does not run on a contaminated day 1");
});

test("summaryContamination: only the known outcomes pass", () => {
  for (const reason of SUMMARY_OUTCOMES) assert.equal(summaryContamination({ written: reason === "ok", reason }), null, reason);
  assert.equal(summaryContamination(null), null, "not asked to summarise");
  assert.equal(summaryContamination({ reason: null }), "summary missing");
  assert.equal(summaryContamination({ written: false }), "summary missing");
  assert.equal(summaryContamination({ written: false, reason: "undefined" }), "summary undefined");
  assert.equal(summaryContamination({ written: false, reason: "something_new" }), "summary something_new");
  assert.equal(summaryContamination({ written: false, reason: "model_failed", detail: "box_reserved" }), "summary model_failed (box_reserved)");
  assert.equal(summaryContamination({ reason: "ok" }), "summary ok", "a result without a boolean written is not trusted");
});

test("the driver's escalation predicate is the bridge's", async () => {
  const { escalateRequested: bridgeEscalate } = await import("../scripts/pi-bots/model_resolver.mjs");
  const src = readFileSync(join(REPO, "scripts", "pi-bots", "model_resolver.mjs"), "utf8");
  const drv = readFileSync(join(REPO, "scripts", "lib", "live-pi-driver.mjs"), "utf8");
  const re = /const ESCALATE_RE = (\/.*\/[a-z]*);/;
  assert.equal(re.exec(drv)[1], re.exec(src)[1], "the copied regex literal");
  assert.match(readFileSync(join(REPO, "scripts", "pi-bots", "bridge.mjs"), "utf8"), /import \{[^}]*\bescalateRequested\b[^}]*\} from "\.\/model_resolver\.mjs"/);
  for (const m of ["!escalate", "please !escalate now", "!ESCALATE", "x\n!escalate", "!escalated", "a!escalate", "escalate", "", null, "!escalate\tthis"]) {
    assert.equal(escalateRequested(m), bridgeEscalate(m), JSON.stringify(m));
  }
});

test("PR 4 options are refused when misconfigured, before anything spawns", async (t) => {
  const ctx = await setup(t);
  const T = (over) => ({ id: DAY2, projectId: ctx.s.projectId, turns: [{ text: "x" }], ...over });
  const bad = [
    [{ threads: [T({ briefingBefore: "yes" })] }, /briefingBefore must be a boolean/],
    [{ threads: [T({ summariseAfter: 1 })] }, /summariseAfter must be a boolean/],
    [{ threads: [T({ briefingBefore: true, projectId: undefined })] }, /briefingBefore needs a projectId/],
    [{ threads: [T({ briefingBefore: true, id: "day-2" })] }, /perchlive-/],
    [{ threads: [T({ projectId: 0, summariseAfter: true })] }, /projectId must be a positive integer/],
    [{ threads: [T({})] }, /projectId is only for a thread with summariseAfter or briefingBefore/],
    [{ threads: [T({ summariseAfter: true })], quickModel: null }, /summariseAfter needs quickModel/],
    [{ threads: [T({ summariseAfter: true })], quickModel: "quick/nope" }, /quickModel names unknown model/],
    [{ threads: [T({ summariseAfter: true })], gatewayType: "gmail" }, /gatewayType "perch"/],
    [{ threads: [{ id: "plain", turns: [{ text: "x" }] }], quickModel: "quick/q1" }, /quickModel needs a thread with summariseAfter/],
    [{ threads: [T({ summariseAfter: true })], quickModel: "nope/q1" }, /quickModel provider nope is not in models/],
    // A briefed thread can reach no model but the one its briefing was built for.
    [{ threads: [T({ briefingBefore: true })], botDef: botDef({ models: { default: "stub/m1", escalation: "quick/q1" } }) }, /only "default" \(has escalation\)/],
    [{ threads: [T({ briefingBefore: true, turns: [{ text: "go !escalate" }] })] }, /asks to !escalate/],
    [{ threads: [T({ briefingBefore: true, turns: [{ text: "x", answers: [{ when: "\\?", text: "!escalate" }] }] })] }, /asks to !escalate/],
    [{ threads: [T({ briefingBefore: true, turns: [{ text: "x", otherwise: "!ESCALATE please" }] })] }, /asks to !escalate/],
  ];
  for (const [over, re] of bad) {
    await assert.rejects(runConversation({ ...ctx.opts, ...over }), (e) => e instanceof DriverRefusal && re.test(e.message), `${JSON.stringify(over)}`);
  }
  assert.equal(existsSync(ctx.capture), false);
  assert.equal(ctx.events.some((e) => e.ev === "spawn"), false);
});

test("checkPr4Hooks refuses when PR 4's modules cannot be imported", () => {
  const home = mkdtempSync(join(tmpdir(), "lpd-pr4-"));
  try {
    assert.doesNotThrow(() => checkPr4Hooks({ cwd: home, env: { PATH: process.env.PATH } }));
    assert.throws(() => checkPr4Hooks({ cwd: home, env: { PATH: process.env.PATH }, modules: [[join(REPO, "servers", "gateway", "perch", "no-such-module.js"), ["x"]]] }),
      (e) => e instanceof DriverRefusal && /PR 4 hooks not available/.test(e.message));
    assert.throws(() => checkPr4Hooks({ cwd: home, env: { PATH: process.env.PATH }, modules: [[join(REPO, "servers", "gateway", "perch", "briefing.js"), ["noSuchExport"]]] }),
      (e) => e instanceof DriverRefusal && /PR 4 hooks not available/.test(e.message));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- the bridge seam ---------------------------------------------------------------------------

const run = (args, env) => new Promise((res) => {
  execFile(process.execPath, args, { env, cwd: REPO, timeout: 60_000 }, (err, stdout, stderr) => res({ err, stdout, stderr }));
});

/** Run one handleInbound in its own process under `env`; returns { error, action, loaded }. */
async function seamCall(dir, env, opts) {
  const optsPath = join(dir, `opts-${randomUUID()}.json`);
  const out = join(dir, `out-${randomUUID()}.json`);
  writeFileSync(optsPath, JSON.stringify(opts));
  const r = await run([SEAM_CHILD, optsPath, out], env);
  assert.ok(existsSync(out), `seam child wrote nothing: ${r.stderr}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

/** A real env that is NOT an eval scratch (no CROW_RESEARCH_EVAL), with the stub pi wired. */
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
const BRIEFING_URL = /\/servers\/gateway\/perch\/briefing\.js$/;

test("the seam refuses outside an eval scratch, before the transform is called", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lpd-seam-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "capture.ndjson");
  const out = await seamCall(dir, nonEvalEnv(dir, capture), { bot_id: BOT, gateway_thread_id: DAY2, user_message: "hi", transform: "spy" });
  assert.match(String(out.error), /^eval-only seam refused: CROW_RESEARCH_EVAL must be "1"/);
  assert.equal(out.action, null);
  assert.equal(out.called, false, "the transform was never invoked");
  assert.equal(existsSync(capture), false, "no pi was spawned");
});

test("the seam refuses from assertEvalSeam before anything else loads", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lpd-seam-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "capture.ndjson");
  const out = await seamCall(dir, nonEvalEnv(dir, capture), { bot_id: BOT, gateway_thread_id: DAY2, user_message: "hi", transform: "spy" });
  assert.match(String(out.error), /^eval-only seam refused/);
  assert.equal(out.called, false);
  const at = out.loaded.findIndex((u) => GUARD_URL.test(u));
  assert.ok(at >= 0, "the guard was loaded");
  assert.equal(out.loaded.some((u) => BRIEFING_URL.test(u)), false, "briefing.js never loaded");
  // After the guard: only the guard's own graph (built-ins and protected-paths.mjs).
  const after = out.loaded.slice(at).filter((u) => !u.startsWith("node:") && !/\/scripts\/lib\/(eval-guard|protected-paths)\.mjs$/.test(u));
  assert.deepEqual(after, []);
  assert.equal(existsSync(capture), false);
});

test("forged eval-looking options cannot pass the seam", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lpd-seam-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "capture.ndjson");
  const fake = join(dir, "fake-home");
  mkdirSync(fake, { recursive: true });
  const forged = {
    CROW_RESEARCH_EVAL: "1", CROW_HOME: fake, CROW_DB_PATH: join(fake, "crow.db"), CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: BOT,
  };
  const out = await seamCall(dir, nonEvalEnv(dir, capture), {
    bot_id: BOT, gateway_thread_id: DAY2, user_message: "hi", transform: "spy",
    env: forged, processEnv: forged, crowHome: fake, CROW_HOME: fake, CROW_RESEARCH_EVAL: "1",
  });
  assert.match(String(out.error), /^eval-only seam refused/);
  assert.equal(out.called, false);
  assert.equal(existsSync(capture), false, "the stub pi's capture file is never created");
});

/** A real eval scratch with the bot seeded, the env the driver's child gets, and its capture file. */
async function evalSeamScratch(t) {
  const s = await makeScratch({ botId: BOT, template });
  t.after(() => s.cleanup());
  const capture = join(s.home, "capture.ndjson");
  const env = childEnv({ home: s.home, botId: BOT, runId: randomUUID(), piCli: STUB, turnTimeoutMs: 20_000, parent: { ...process.env, PIBOT_TEST_CAPTURE: capture } });
  const agentDir = join(s.home, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "stub", models: [{ id: "m1" }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  mkdirSync(join(s.home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(s.home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));
  const c = new Database(s.dbPath);
  const { id, ...rest } = botDef();
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?, ?, ?, 1)").run(id, "Driver Bot", JSON.stringify(rest));
  c.close();
  return { s, env, capture };
}

test("the plain path never loads the eval guard or briefing.js (and the transform path loads the guard)", async (t) => {
  const { s, env, capture } = await evalSeamScratch(t);
  const plain = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: "perchlive-0000aa01", user_message: "hi" });
  assert.equal(plain.error, null);
  assert.equal(plain.action, "asked");
  assert.ok(plain.loaded.length > 50, "the hook saw the bridge's module graph");
  assert.equal(plain.loaded.some((u) => GUARD_URL.test(u)), false, "the plain path loaded eval-guard.mjs");
  assert.equal(plain.loaded.some((u) => BRIEFING_URL.test(u)), false, "the plain path loaded briefing.js");
  const first = readLines(capture);
  assert.equal(first.length, 1);
  assert.equal(String(first[0].appendSystemPromptText).includes("EVAL-TRANSFORM-MARK"), false);

  const file = join(s.home, "transformed.system-prompt.md");
  const out = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: "perchlive-0000aa02", user_message: "hi", transform: `file:${file}` });
  assert.equal(out.error, null);
  assert.equal(out.action, "asked");
  assert.equal(out.called, true);
  assert.ok(out.loaded.some((u) => GUARD_URL.test(u)), "positive control: the transform path loads the guard");
  assert.equal(out.loaded.some((u) => BRIEFING_URL.test(u)), false, "bridge.mjs never imports briefing.js");
  const second = readLines(capture)[1];
  assert.equal(second.appendSystemPrompt, file, "pi got the transformed prompt file");
  assert.ok(second.appendSystemPromptText.endsWith("\n\nEVAL-TRANSFORM-MARK"));
});

test("a transform may change only appendSystemPromptFile, inside the scratch", async (t) => {
  const { s, env, capture } = await evalSeamScratch(t);
  const outside = mkdtempSync(join(tmpdir(), "lpd-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const cases = [
    ["narrowedTools", /key narrowedTools was changed/],
    ["tools", /key tools was added/],
    ["def", /key def was changed/],
    ["newKey", /key extraEnv was (added|changed)/],
    ["remove", /key mcpConfig was removed/],
    ["nonObject", /the result must be a plain object/],
    [`file:${join(outside, "sys.md")}`, /appendSystemPromptFile must be a path strictly inside CROW_HOME/],
    ["mutateInPlace", /key tools was added|key narrowedTools was changed|key def was changed/],
    ["mutateSpread", /key def was changed/],
    ["getter", /key def must be a data property/],
    ["proxy", /the result must not be a Proxy/],
    ["symbol", /key Symbol\(x\) was added/],
  ];
  let n = 0;
  for (const [transform, re] of cases) {
    const out = await seamCall(s.home, env, { bot_id: BOT, gateway_thread_id: `perchlive-0000bb${String(n++).padStart(2, "0")}`, user_message: "hi", transform });
    assert.equal(out.called, true, transform);
    assert.match(String(out.error), /^eval spawn transform refused: /, transform);
    assert.match(String(out.error), re, transform);
  }
  assert.equal(existsSync(capture), false, "no refused transform ever reached pi");
});

test("checkEvalSpawnOpts: the re-review's bypasses are refused and the original is never touched", async () => {
  const { cloneSpawnOpts, checkEvalSpawnOpts } = await import("../scripts/lib/eval-guard.mjs");
  const home = process.env.CROW_HOME; // the suite's scratch home under tmp
  mkdirSync(join(home, "x"), { recursive: true });
  const fn = function f() {};
  const mk = () => ({ def: { id: "b", permission_policy: { bash: "deny" } }, narrowedTools: ["read"], appendSystemPromptFile: "/base.md", mcpConfig: { a: 1 }, fn });
  const run = (f) => {
    const original = mk();
    const snapshot = mk();
    const clone = cloneSpawnOpts(original);
    assert.notEqual(clone.def, original.def, "the clone is deep");
    assert.equal(clone.fn, original.fn, "functions by reference");
    let res;
    try { res = { f: checkEvalSpawnOpts(original, clone, f(clone)) }; } catch (e) { res = { error: e.message }; }
    assert.deepStrictEqual(original, snapshot, "the original is never touched");
    return res;
  };
  const refused = {
    getter: (o) => { let n = 0; const out = { ...o }; Object.defineProperty(out, "narrowedTools", { enumerable: true, get() { return n++ < 1 ? o.narrowedTools : ["bash"]; } }); return out; },
    proxy: (o) => { let n = 0; return new Proxy({ ...o }, { get(tg, k) { return k === "narrowedTools" && n++ >= 1 ? ["bash"] : tg[k]; } }); },
    proto: (o) => Object.assign(Object.create({ tools: ["bash"] }), o),
    jsonRoundTrip: (o) => JSON.parse(JSON.stringify({ ...o, fn: undefined })),
    symbol: (o) => ({ ...o, [Symbol("x")]: 1 }),
    mutateInPlace: (o) => { o.narrowedTools.push("bash"); o.def.permission_policy.bash = "allow"; o.tools = ["bash"]; return o; },
    mutateInPlaceNoNewKey: (o) => { o.narrowedTools.push("bash"); return o; },
    mutateAndSpread: (o) => { o.narrowedTools.push("bash"); return { ...o }; },
    fnChanged: (o) => ({ ...o, fn: () => 1 }),
    getterFile: (o) => { const out = { ...o }; Object.defineProperty(out, "appendSystemPromptFile", { enumerable: true, get: () => join(home, "x", "ok.md") }); return out; },
    nonStringFile: (o) => ({ ...o, appendSystemPromptFile: { toString: () => join(home, "x", "ok.md") } }),
    dotdot: (o) => ({ ...o, appendSystemPromptFile: join(home, "x", "..", "..", "etc", "passwd") }),
    homeItself: (o) => ({ ...o, appendSystemPromptFile: home }),
    outside: (o) => ({ ...o, appendSystemPromptFile: "/etc/passwd" }),
    removed: (o) => { const { mcpConfig, ...rest } = o; return rest; },
  };
  for (const [name, f] of Object.entries(refused)) {
    const r = run(f);
    assert.match(String(r.error), /^eval spawn transform refused: /, `${name} passed: ${JSON.stringify(r)}`);
  }
  // A symlinked directory inside the home that points out of it is followed, then refused.
  const { symlinkSync } = await import("node:fs");
  const out = mkdtempSync(join(tmpdir(), "lpd-link-"));
  try {
    symlinkSync(out, join(home, "x", "dirlink"));
    assert.match(String(run((o) => ({ ...o, appendSystemPromptFile: join(home, "x", "dirlink", "sys.md") })).error), /strictly inside CROW_HOME/);
  } finally { rmSync(join(home, "x", "dirlink"), { force: true }); rmSync(out, { recursive: true, force: true }); }
  // Allowed: only the path changes, inside the home; or nothing changes at all.
  assert.deepEqual(run((o) => ({ ...o, appendSystemPromptFile: join(home, "x", "ok.md") })), { f: join(home, "x", "ok.md") });
  assert.deepEqual(run((o) => o), { f: "/base.md" });
});

test("bridge.mjs: the evalSpawnTransform block opens with the guard, and nothing imports perch or the guard statically", () => {
  const src = readFileSync(join(REPO, "scripts", "pi-bots", "bridge.mjs"), "utf8");
  const HEAD = 'if (typeof opts.evalSpawnTransform === "function") {';
  assert.equal(src.split(HEAD).length - 1, 1, "exactly one seam block");
  const body = src.slice(src.indexOf(HEAD) + HEAD.length);
  assert.ok(body.replace(/^\s*/, "").startsWith('(await import("../lib/eval-guard.mjs")).assertEvalSeam();'), "the first statement is the guard; nothing precedes it");
  assert.doesNotMatch(src, /^\s*import\s[^;]*eval-guard/m, "no static import of eval-guard");
  assert.doesNotMatch(src, /^\s*import\s+["'][^"']*eval-guard/m, "no static import of eval-guard");
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm)) {
    assert.doesNotMatch(m[1], /perch\//, `bridge.mjs imports ${m[1]}`);
  }
  // Every read of the option is the guarded check or the call right before pi.
  assert.deepEqual([...src.matchAll(/opts\.evalSpawnTransform/g)].length, 2);
  assert.doesNotMatch(src, /briefing/i, "bridge.mjs carries no briefing strings");
  // The transform gets a clone; the spawn options are built from the untouched original.
  assert.match(src, /const next = await opts\.evalSpawnTransform\(clone\);/);
  assert.match(src, /spawnPrep\.piRpcOpts = Object\.assign\(\{\}, original, \{ appendSystemPromptFile: f \}\);/);
  assert.doesNotMatch(src, /piRpcOpts = next\b|Object\.assign\([^)]*\bnext\b/, "the transform's object is never used");
});
