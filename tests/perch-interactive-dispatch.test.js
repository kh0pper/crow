/**
 * Track 3 Task 6 — card binding, synchronous occupancy, the dispatch brief,
 * per-session outputs/uploads dirs, the free-chat cwd refusal, and the
 * per-bot world-build mutex.
 *
 * Harness: the SAME shape as tests/perch-interactive.test.js (a real init-db'd
 * scratch crow.db, since occupancy/card_id are real SQL through the gateway's
 * own createDbClient; an injected fake bridge seam for the engine's own
 * lazily-resolved modules; injected timers/clock). Distinct card ids are used
 * per test — the scratch DB is shared across every test in this file (one
 * `before()`), so a stale row from an earlier test must never collide with a
 * later test's occupancy check.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// card-brief.mjs is pure/DB-free (no module-level env reads) — a static
// import is safe. bridge.mjs is NOT: it computes `export const CROW_DB =
// botsDbPath()` at MODULE EVALUATION time, and ESM static imports are
// hoisted — evaluated before this file's own `process.env.CROW_DATA_DIR =
// dir` line below ever runs. A static `import {projectContextBlock} from
// ".../bridge.mjs"` here would bake the AMBIENT (run-suite scratch) env's
// CROW_DATA_DIR into CROW_DB for the rest of the process, not this file's
// scratch dir — bridge.mjs is imported dynamically in before() instead,
// after the env below is set, exactly like perch-interactive.test.js's own
// CARRIED 1/2 tests do.
import { cardBriefBlock } from "../scripts/pi-bots/card-brief.mjs";

const dir = mkdtempSync(join(tmpdir(), "perch-interactive-dispatch-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let createInteractiveEngine, _resetInteractiveEngineForTest, projectContextBlock;

function raw() {
  return new Database(DB_FILE);
}

function rowFor(threadId) {
  const c = raw();
  const r = c.prepare("SELECT * FROM bot_sessions WHERE gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
  c.close();
  return r || null;
}

/** Seed a bot_sessions row directly (bypassing the engine) for occupancy
 * fixtures — mirrors board-lock.js's own consumer-test idiom. */
function seedSession({ botId, cardId, kind, status }) {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control,card_id) VALUES (?,?,?,?,?,?,?)"
  ).run(botId, "perch", "seed-" + botId + "-" + Math.random().toString(36).slice(2), kind, status, "run", cardId);
  c.close();
}

/** Seed a bot_jobs row directly. */
function seedJob({ cardId, status }) {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_jobs (job_id,bot_id,goal,status,card_id,card_action) VALUES (?,?,?,?,?,?)"
  ).run("job-" + Math.random().toString(36).slice(2), "jobber", "do the card", status, cardId, "execute");
  c.close();
}

// ---------------------------------------------------------------------------
// fake clock + timers (same shape as perch-interactive.test.js)
// ---------------------------------------------------------------------------

function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: t + Number(ms) });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let pick = null;
        for (const [id, e] of timers) {
          if (e.at <= target && (pick === null || e.at < pick.entry.at)) pick = { id, entry: e };
        }
        if (!pick) break;
        timers.delete(pick.id);
        t = pick.entry.at;
        pick.entry.fn();
      }
      t = target;
    },
  };
}

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// fake bridge seam
// ---------------------------------------------------------------------------

let pidSeq = 800000;

function makeBridge(opts = {}) {
  const state = {
    worlds: [],
    instances: [],
    warm: [],
    meter: [],
    audit: [],
    livePi: opts.livePi == null ? 0 : opts.livePi,
    maxPi: opts.maxPi == null ? 4 : opts.maxPi,
    projectId: opts.projectId === undefined ? 7 : opts.projectId,
    projectSpace: opts.projectSpace === undefined ? null : opts.projectSpace,
    projectMembers: opts.projectMembers === undefined ? [] : opts.projectMembers,
    worldGate: null,
    getStateGate: null,
    // Fix round 1: inject exactly ONE buildBotWorld rejection for a given
    // botId, then self-clear — proves a transient failure doesn't poison
    // that bot's world-build queue for later spawns.
    worldRejectFor: null,
    worldRejectError: null,
    modelKey: opts.modelKey || "crow-local/qwen3.6-35b-a3b",
    // Dispatch-brief seams (Track 3 Task 6) — deliberately simple fakes, NOT
    // real tasks.db reads: cardBriefBlock is DB-free by design (Task 2), so
    // the composition test can build its own golden with the SAME fakes.
    plan: opts.plan === undefined ? "PLAN BODY" : opts.plan,
    cardStatusVal: opts.cardStatusVal || "todo",
    vocab: opts.vocab || { statuses: ["todo", "doing", "done"], terminals: ["done"] },
  };

  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.sent = [];
      this.closed = 0;
      this.trimmed = 0;
      this.turns = [];
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.statsSeq = 0;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() {
      if (state.getStateGate) return state.getStateGate;
      return { data: { sessionId: this.piSessionId } };
    }
    async getSessionStats() {
      this.statsSeq += 1;
      return { data: { tokens: { input: 10 * this.statsSeq, output: 5 * this.statsSeq, cacheRead: 0 } } };
    }
    promptTurn(message, ms, images) {
      const rec = { message, ms, images };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() { this.trimmed += 1; }
    async abortSince() { return null; }
    send(o) { this.sent.push(o); }
    async close() { this.closed += 1; this.exit(0); }
    exit(code = 0) {
      if (this._exitCode != null) return;
      this._exitCode = code;
      this._done(code);
    }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ") before responding"); }
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
  }

  const seam = {
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { get maxPi() { return state.maxPi; } },
    countLivePi: () => state.livePi,
    async buildBotWorld(args) {
      state.worlds.push(args);
      if (state.worldRejectFor === args.botId) {
        state.worldRejectFor = null;
        throw state.worldRejectError || new Error("build failed");
      }
      if (state.worldGate) await state.worldGate;
      return {
        def: { session_dir: join(dir, "bots", args.botId), permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId },
        crowHome: CROW_HOME,
        projectId: state.projectId,
        projectSpace: state.projectSpace,
        projectMembers: state.projectMembers,
        sessionDir: join(dir, "bots", args.botId),
        tasksDbPath: join(dir, "tasks.db"),
        remoteEnabled: false,
        peerGatewayUrls: {},
        session: null,
        narrowedTools: null,
        gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
      const resolved = {
        provider: state.modelKey.split("/")[0],
        model: state.modelKey.split("/").slice(1).join("/"),
        key: state.modelKey,
        escalated: false,
        source: "default",
        escalationRequestedButUnavailable: false,
      };
      return {
        sysFile: join(dir, "sys.md"),
        selfAuthoringDir: null,
        resolved,
        piRpcOpts: {
          def: world.def,
          sessionDir: world.sessionDir,
          resolved,
          selfAuthoringDir: null,
          remoteEnabled: world.remoteEnabled,
          narrowedTools: world.narrowedTools,
          appendSystemPromptFile: join(dir, "sys.md"),
        },
      };
    },
    async warmModel(provider) { state.warm.push(provider); },
    async meterTurn(args) { state.meter.push(args); return { recorded: true }; },
    appendAudit(projectId, o) { state.audit.push({ projectId, ...o }); },
    planForCard: () => state.plan,
    projectContextBlock,
    cardStatus: () => state.cardStatusVal,
    boardVocab: () => state.vocab,
    cardText: () => ({ title: "T", description: null }),
  };
  return seam;
}

function makeEngine(o = {}) {
  const clock = makeClock();
  const bridge = o.bridge || makeBridge(o.bridgeOpts);
  const env = Object.assign({ CROW_HOME }, o.env);
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME,
    env,
    bridge,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
  });
  return { engine, clock, bridge, env, state: bridge._state };
}

async function spawned(engine, opts) {
  const r = await engine.spawn(opts);
  await tick();
  return r;
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  mkdirSync(CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
    providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } },
  }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
  const B = await import("../scripts/pi-bots/bridge.mjs");
  projectContextBlock = B.projectContextBlock;
});

beforeEach(() => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// 1. spawn({cardId}) — row write
// ---------------------------------------------------------------------------

test("spawn with cardId writes card_id on the bot_sessions row", async () => {
  const { engine } = makeEngine();
  const r = await spawned(engine, { botId: "carded", cardId: 101 });
  const row = rowFor(r.threadId);
  assert.equal(row.card_id, 101);
  assert.equal((await engine.get(r.sessionId)).cardId, 101);
});

test("spawn without cardId leaves card_id NULL", async () => {
  const { engine } = makeEngine();
  const r = await spawned(engine, { botId: "chatty" });
  const row = rowFor(r.threadId);
  assert.equal(row.card_id, null);
  assert.equal((await engine.get(r.sessionId)).cardId, null);
});

// ---------------------------------------------------------------------------
// 2. synchronous card claim
// ---------------------------------------------------------------------------

test("two concurrent spawn({cardId:102}) on different bots: exactly one wins synchronously, the loser gets card_occupied, and the winner's own async work is provably still stalled when the loser rejects", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  // The async part (startChild's own trailing getState()) is gated open —
  // proving the exclusion is decided by the SYNCHRONOUS claim, not by which
  // spawn happens to finish first.
  let releaseGetState;
  state.getStateGate = new Promise((r) => { releaseGetState = r; });
  let outcomeA = null, outcomeB = null;
  const p1 = engine.spawn({ botId: "a", cardId: 102 }).then((r) => { outcomeA = { ok: true, r }; }, (e) => { outcomeA = { ok: false, e }; });
  const p2 = engine.spawn({ botId: "b", cardId: 102 }).then((r) => { outcomeB = { ok: true, r }; }, (e) => { outcomeB = { ok: false, e }; });
  await tick();

  const outcomes = [outcomeA, outcomeB];
  const rejected = outcomes.filter((o) => o && o.ok === false);
  const pending = outcomes.filter((o) => o === null);
  assert.equal(rejected.length, 1, "exactly one spawn is settled — and it's a rejection");
  assert.equal(rejected[0].e.code, "card_occupied");
  assert.equal(pending.length, 1, "the winner's own spawn has NOT settled — it is genuinely stalled in getState(), not just fast");
  // Only the winner ever reached PiRpc construction — the loser is excluded
  // before startChild is ever called.
  assert.equal(state.instances.length, 1);
  releaseGetState({ data: { sessionId: "released" } });
  await Promise.allSettled([p1, p2]);
});

// ---------------------------------------------------------------------------
// 3. checkCardFree — DB occupancy
// ---------------------------------------------------------------------------

test("checkCardFree: an active chat-kind row occupies the card", async () => {
  const { engine } = makeEngine();
  seedSession({ botId: "x", cardId: 201, kind: "chat", status: "active" });
  await assert.rejects(() => engine.checkCardFree(201), (e) => e.code === "card_occupied");
});

test("checkCardFree: a stale waiting-user chat-kind row leaves the card free", async () => {
  const { engine } = makeEngine();
  seedSession({ botId: "x", cardId: 202, kind: "chat", status: "waiting-user" });
  await engine.checkCardFree(202); // resolves — must not throw
});

test("checkCardFree: a hibernating perch-live row for the card occupies it", async () => {
  const { engine } = makeEngine();
  seedSession({ botId: "x", cardId: 203, kind: "perch-live", status: "waiting-user" });
  await assert.rejects(() => engine.checkCardFree(203), (e) => e.code === "card_occupied");
});

test("checkCardFree: a stopped perch-live row for the card leaves it free", async () => {
  const { engine } = makeEngine();
  seedSession({ botId: "x", cardId: 204, kind: "perch-live", status: "stopped" });
  await engine.checkCardFree(204);
});

test("checkCardFree: a running job row occupies the card", async () => {
  const { engine } = makeEngine();
  seedJob({ cardId: 205, status: "running" });
  await assert.rejects(() => engine.checkCardFree(205), (e) => e.code === "card_occupied");
});

test("checkCardFree: an unclaimed card is free", async () => {
  const { engine } = makeEngine();
  await engine.checkCardFree(206);
});

test("checkCardFree: excludeSessionId skips the CALLING session's own perch-live row (fix round 1)", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, { botId: "self-check", cardId: 207 });
  // Hibernate so the row lands on the perch-live rail (kind='perch-live',
  // status != 'stopped') rather than rail (a)'s status='active' — the exact
  // rail the fix targets.
  await engine._hibernateForTest(s.sessionId);
  await assert.rejects(() => engine.checkCardFree(207), (e) => e.code === "card_occupied",
    "without exclusion, the session's own row still occupies the card");
  await engine.checkCardFree(207, { excludeSessionId: s.sessionId }); // resolves — must not throw
});

test("checkCardFree: excludeSessionId does NOT skip a DIFFERENT session's perch-live row for the same card (fix round 1)", async () => {
  const { engine } = makeEngine();
  const holder = await spawned(engine, { botId: "real-holder", cardId: 208 });
  await engine._hibernateForTest(holder.sessionId);
  await assert.rejects(
    () => engine.checkCardFree(208, { excludeSessionId: "some-other-session-id" }),
    (e) => e.code === "card_occupied",
    "excluding a DIFFERENT sessionId must not blanket-bypass the real holder's claim"
  );
});

// ---------------------------------------------------------------------------
// 4. dispatch brief composition
// ---------------------------------------------------------------------------

test("dispatch: spawn stores the brief; the FIRST message() composes header+brief with the note mid-block; the SECOND sends raw text", async () => {
  const { engine, state } = makeEngine({ bridgeOpts: { plan: "PLAN BODY", cardStatusVal: "in_progress", vocab: { statuses: ["todo", "in_progress", "done"], terminals: ["done"] } } });
  const r = await spawned(engine, { botId: "dispatchbot", cardId: 301 });
  const pi = state.instances[0];
  const snap = await engine.get(r.sessionId);
  assert.ok(snap.outputsDir, "precondition: outputsDir is known before dispatch composes its footer");

  await engine.message(r.sessionId, "note text");
  assert.equal(pi.turns.length, 1);

  const expectedHeader = projectContextBlock(null, []); // the fake's default projectSpace is null
  const expectedBody = cardBriefBlock({
    cardId: 301,
    tasksDbPath: join(dir, "tasks.db"),
    userLine: "note text",
    planForCard: () => "PLAN BODY",
    cardStatus: () => "in_progress",
    boardVocab: () => ({ statuses: ["todo", "in_progress", "done"], terminals: ["done"] }),
    cardText: () => ({ title: "T", description: null }),
  });
  const expected = expectedHeader + "\n\n" + expectedBody + "\n\nDeliverables you produce as files go in: " + snap.outputsDir;
  assert.equal(pi.turns[0].message, expected, "the composed prompt is byte-identical to a directly-built cardBriefBlock golden");
  assert.match(pi.turns[0].message, /User said: "note text"/, "the operator's note lands mid-block, inside the brief");

  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();

  await engine.message(r.sessionId, "raw follow-up");
  assert.equal(pi.turns.length, 2);
  assert.equal(pi.turns[1].message, "raw follow-up", "the brief is cleared after its one use — a second message is unwrapped");
});

test("dispatch: an EMPTY operator note defaults the brief's userLine to 'Work this card.'", async () => {
  const { engine, state } = makeEngine();
  const r = await spawned(engine, { botId: "quietdispatch", cardId: 302 });
  await engine.message(r.sessionId, "");
  const pi = state.instances[0];
  assert.match(pi.turns[0].message, /User said: "Work this card\."/);
});

test("a free-chat spawn (no cardId) never composes a brief — message() sends raw text on the very first turn", async () => {
  const { engine, state } = makeEngine();
  const r = await spawned(engine, { botId: "freechat" });
  await engine.message(r.sessionId, "hello");
  assert.equal(state.instances[0].turns[0].message, "hello");
});

// ---------------------------------------------------------------------------
// 5. per-session dirs
// ---------------------------------------------------------------------------

test("startChild passes extraWritePaths=[outputsDir] and both outputs/uploads dirs exist on disk", async () => {
  const { engine, state } = makeEngine();
  const r = await spawned(engine, { botId: "dirsbot" });
  const snap = await engine.get(r.sessionId);
  const expectedOutputs = join(dir, "bots", "dirsbot", "outputs", r.sessionId);
  const expectedUploads = join(dir, "bots", "dirsbot", ".pi", "uploads", r.sessionId);
  assert.equal(snap.outputsDir, expectedOutputs);
  assert.equal(snap.uploadsDir, expectedUploads);
  assert.ok(existsSync(expectedOutputs), "outputsDir must exist on disk after spawn");
  assert.ok(existsSync(expectedUploads), "uploadsDir must exist on disk after spawn");
  assert.deepEqual(state.instances[0].opts.extraWritePaths, [expectedOutputs]);
});

// ---------------------------------------------------------------------------
// 6. free-chat cwd refusal (bot-world.mjs)
// ---------------------------------------------------------------------------

test("buildBotWorld with no def.session_dir and no project workspace throws code no_session_dir", async () => {
  const { buildBotWorld } = await import("../scripts/pi-bots/bot-world.mjs");
  const botId = "nowhereBot";
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)")
    .run(botId, "Nowhere Bot", JSON.stringify({
      system_prompt: "You are a test bot.",
      models: { default: "crow-local/qwen3.6-35b-a3b" },
      tools: { pi_builtin: ["read"] },
      // deliberately no session_dir
    }), 1);
  c.close();

  await assert.rejects(
    () => buildBotWorld({ botId, threadId: "perchlive-nowhere", gatewayType: "perch" }),
    (e) => e.code === "no_session_dir"
  );
});

// ---------------------------------------------------------------------------
// 7. per-bot world-build mutex
// ---------------------------------------------------------------------------

test("per-bot world-build mutex: two concurrent spawns of ONE bot never overlap buildBotWorld — the second call is not even invoked until the first settles", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  let release;
  state.worldGate = new Promise((r) => { release = r; });
  const p1 = engine.spawn({ botId: "sharedworld" });
  const p2 = engine.spawn({ botId: "sharedworld" });
  p1.catch(() => {}); p2.catch(() => {});
  await tick();
  assert.equal(state.worlds.length, 1, "the second buildBotWorld call must not be invoked while the first is still gated");
  release();
  await tick();
  await Promise.all([p1, p2]);
  assert.equal(state.worlds.length, 2, "…but runs once the first settles");
  assert.equal(state.instances.length, 2);
});

test("per-bot world-build mutex: one buildBotWorld rejection does NOT poison the bot's queue for later spawns (fix round 1)", async () => {
  const { engine, state } = makeEngine();
  const boom = new Error("transient build failure");
  state.worldRejectFor = "flaky";
  state.worldRejectError = boom;

  await assert.rejects(
    () => engine.spawn({ botId: "flaky" }),
    (e) => e === boom,
    "the caller sees the REAL rejection of its own build"
  );
  assert.equal(state.worlds.filter((w) => w.botId === "flaky").length, 1, "the failing build was invoked exactly once");
  assert.equal(state.worldRejectFor, null, "the injected rejection is one-shot — self-cleared after firing");

  // A second spawn for the SAME bot must invoke buildBotWorld AGAIN — a
  // poisoned queue (the pre-fix `prev.then(build)` formula) would instead
  // silently inherit the first failure forever, never calling build() again.
  const r = await spawned(engine, { botId: "flaky" });
  assert.equal(r.state, "awake");
  assert.equal(state.worlds.filter((w) => w.botId === "flaky").length, 2, "buildBotWorld ran again — the queue recovered");
});

// ---------------------------------------------------------------------------
// 8. claim lifecycle: stop() releases, hibernation keeps
// ---------------------------------------------------------------------------

test("stop() releases the card claim — a fresh spawn can reuse the same card immediately", async () => {
  const { engine } = makeEngine();
  const first = await spawned(engine, { botId: "releaser", cardId: 401 });
  await engine.stop(first.sessionId);
  const second = await spawned(engine, { botId: "releaser2", cardId: 401 });
  assert.equal((await engine.get(second.sessionId)).cardId, 401);
});

test("a hibernating card-bound session KEEPS its claim — a second spawn for the same card is refused in-memory", async () => {
  const { engine, clock } = makeEngine();
  const first = await spawned(engine, { botId: "sleeper", cardId: 402 });
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(first.sessionId)).state, "hibernating");
  await assert.rejects(() => engine.spawn({ botId: "intruder", cardId: 402 }), (e) => e.code === "card_occupied");
});

// ---------------------------------------------------------------------------
// 9. adoptRow restores the claim across a restart
// ---------------------------------------------------------------------------

test("restart: adoptRow restores cardId and re-registers the claim — a second process refuses a fresh spawn for the same card, and stop() on the ghost frees it", async () => {
  const A = makeEngine();
  const first = await spawned(A.engine, { botId: "ghostowner", cardId: 403 });
  await A.engine.stopAll({ timeoutMs: 500 });

  const B = makeEngine();
  // get() adopts the row — restoring s.cardId and re-registering the claim.
  const snap = await B.engine.get(first.sessionId);
  assert.equal(snap.cardId, 403);
  await assert.rejects(() => B.engine.spawn({ botId: "newclaimant", cardId: 403 }), (e) => e.code === "card_occupied");

  await B.engine.stop(first.sessionId);
  const third = await spawned(B.engine, { botId: "freeatlast", cardId: 403 });
  assert.equal((await B.engine.get(third.sessionId)).cardId, 403);
});

// M2 (final review): adoptRow's cardClaims.set() had no conflict check — a
// stale non-stopped row's cardId could steal the in-memory claim from a
// session that ALREADY legitimately holds it, in the SAME process. The DB
// rail (checkCardFree) 409s correctly regardless, so this is provable only
// through the internal cardClaims map itself — see
// _cardClaimHolderForTest's own doc.
test("M2: adopting a stale non-stopped row must NOT steal the in-memory card claim from a session that already holds it", async () => {
  const { engine } = makeEngine();
  const holder = await spawned(engine, { botId: "legit-holder", cardId: 777 });
  assert.equal(engine._cardClaimHolderForTest(777), holder.sessionId, "test setup sanity: the legit session holds the claim");

  // A ghost row this process has never touched — some other stale row that
  // (for whatever reason) still carries card_id=777 and a non-stopped
  // status, i.e. exactly the shape adoptRow's `s.state !== "stopped"` guard
  // lets through.
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control,card_id) VALUES (?,?,?,?,?,?,?)"
  ).run("ghost-bot", "perch", "ghost-m2-session", "perch-live", "waiting-user", "run", 777);
  c.close();

  // get() on the ghost id triggers resolveSession -> adopt() -> adoptRow —
  // the ONLY code path that writes cardClaims without going through
  // claimCard()'s own conflict guard.
  const ghostSnap = await engine.get("ghost-m2-session");
  assert.equal(ghostSnap.cardId, 777, "adoptRow still restores the GHOST session's OWN cardId field — only the shared-map set is guarded");
  assert.equal(
    engine._cardClaimHolderForTest(777), holder.sessionId,
    "the in-memory claim must still belong to the session that legitimately holds it, not the newly-adopted ghost"
  );

  // Real consequence, not just a direct-accessor assertion: stop()ping the
  // LEGITIMATE holder must still actually free the card (releaseCard's
  // current-holder gate only fires if cardClaims still points at it) — if
  // the ghost had stolen the claim, this release would silently no-op and
  // card 777 could never be freed again through the legitimate holder.
  await engine.stop(holder.sessionId);
  assert.equal(engine._cardClaimHolderForTest(777), null, "stopping the legit holder must free the card in-memory");
});

// ---------------------------------------------------------------------------
// 10. attachCard (Track 3 Task 9) — bind an ALREADY-SPAWNED session to a card
// ---------------------------------------------------------------------------

test("attachCard: binds a free-chat session to a card — cardId + row write, botId echoed back", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, { botId: "attacher" });
  assert.equal((await engine.get(s.sessionId)).cardId, null);
  const result = await engine.attachCard(s.sessionId, 501);
  assert.deepEqual(result, { ok: true, cardId: 501, botId: "attacher" });
  assert.equal((await engine.get(s.sessionId)).cardId, 501);
  assert.equal(rowFor(s.threadId).card_id, 501);
});

test("attachCard: refuses card_occupied — the sync claim excludes a SECOND session for the same card", async () => {
  const { engine } = makeEngine();
  const holder = await spawned(engine, { botId: "holder", cardId: 502 });
  const other = await spawned(engine, { botId: "other" });
  await assert.rejects(() => engine.attachCard(other.sessionId, 502), (e) => e.code === "card_occupied");
  // The refused attempt must not have touched the holder's own claim/row.
  assert.equal((await engine.get(holder.sessionId)).cardId, 502);
  assert.equal((await engine.get(other.sessionId)).cardId, null);
});

test("attachCard: refuses session_stopped on a stopped session", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, { botId: "stopper" });
  await engine.stop(s.sessionId);
  await assert.rejects(() => engine.attachCard(s.sessionId, 503), (e) => e.code === "session_stopped");
});

test("attachCard: refuses no_such_session for an unknown sessionId", async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.attachCard("ghost-session", 504), (e) => e.code === "no_such_session");
});

test("attachCard: re-attaching to a DIFFERENT card releases the old claim — a later session can claim it", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, { botId: "reattacher", cardId: 505 });
  await engine.attachCard(s.sessionId, 506);
  assert.equal((await engine.get(s.sessionId)).cardId, 506);
  assert.equal(rowFor(s.threadId).card_id, 506);
  // 505 is free again — a fresh session can claim it in-memory (spawn's own
  // synchronous claim would 409 if the old claim had leaked).
  const claimant = await spawned(engine, { botId: "claimant505", cardId: 505 });
  assert.equal((await engine.get(claimant.sessionId)).cardId, 505);
});

test("attachCard: idempotent reassert of the SAME card is a no-op — no claim churn, no error", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, { botId: "reasserter", cardId: 507 });
  const result = await engine.attachCard(s.sessionId, 507);
  assert.deepEqual(result, { ok: true, cardId: 507, botId: "reasserter" });
  assert.equal((await engine.get(s.sessionId)).cardId, 507);
});
