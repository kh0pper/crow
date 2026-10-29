#!/usr/bin/env node
/**
 * The live pi driver's child: ONE thread of handleInbound() turns inside a scratch Crow home.
 * The parent (live-pi-driver.mjs) spawns one of these per thread, detached, with a childEnv()
 * environment and stdout/stderr as files it opened, and owns every limit (turn timeout, wall
 * cap, tree kill, reading the session file).
 *
 *   node live-pi-driver-child.mjs <job.json> <progress.ndjson>
 *
 * Job: { botDef, gatewayType, allowServers, allowSkills, allowToolless, prodMaxPi, capacityCount,
 *        mcpOverrides, runId, thread: { id, turns: [{ text, answers?: [{ when, text }], otherwise? }] } }
 * `capacityCount` is a test-only stand-in for countLivePi() (null in a real run).
 *
 * Progress (one appended, synced line per event): start, turn-start, turn-end, capacity, done.
 * Exit codes: 0 all turns ran; 1 guard refusal or crash; 4 a turn's action was not
 * asked/executed (its turn-end is written first); 5 the parent died; 6 prod pi capacity (R6).
 *
 * Why the order matters: bridge.mjs reads CROW_DB, TASKS_DB, the turn timeout and the warm
 * target from env at IMPORT time. So the static imports below are node built-ins and the guard
 * alone (and the path helpers it uses); assertEvalEnv runs first, and everything else is imported only after it passes (the
 * research-eval fixture-server pattern). A refused start has loaded no server code.
 */
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertEvalEnv } from "./eval-guard.mjs";
import { realish, within } from "./protected-paths.mjs";

const OK_ACTIONS = new Set(["asked", "executed"]);
const PARENT_POLL_MS = 1000;

const fail = (code, msg) => Object.assign(new Error(msg), { exitCode: code });
const refuse = (msg) => fail(1, `live pi driver child refused: ${msg}`);

/** The job file, shape-checked. Anything malformed is a refusal (exit 1), never a guess. */
function readJob(path, env) {
  let job;
  try { job = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw refuse(`job file unreadable: ${e.message}`); }
  if (!job || typeof job !== "object") throw refuse("job must be an object");
  const { botDef, thread } = job;
  if (!botDef || typeof botDef.id !== "string" || !botDef.id) throw refuse("job.botDef.id must be a non-empty string");
  if (botDef.id !== env.CROW_ACTOR_BOT_ID) throw refuse("job.botDef.id must equal CROW_ACTOR_BOT_ID");
  if (typeof job.runId !== "string" || job.runId !== env.CROW_EVAL_RUN_ID) throw refuse("job.runId must equal CROW_EVAL_RUN_ID");
  if (job.allowToolless !== undefined && typeof job.allowToolless !== "boolean") throw refuse("job.allowToolless must be a boolean");
  if (job.gatewayType !== undefined && (typeof job.gatewayType !== "string" || !job.gatewayType)) throw refuse("job.gatewayType must be a string");
  if (!Number.isInteger(job.prodMaxPi) || job.prodMaxPi < 1) throw refuse("job.prodMaxPi must be a positive integer");
  if (job.capacityCount !== undefined && job.capacityCount !== null) {
    if (env.NODE_TEST_CONTEXT === undefined) throw refuse("job.capacityCount is test-only (no NODE_TEST_CONTEXT)");
    if (!Number.isInteger(job.capacityCount) || job.capacityCount < 0) throw refuse("job.capacityCount must be a non-negative integer");
  }
  if (!thread || typeof thread.id !== "string" || !thread.id) throw refuse("job.thread.id must be a non-empty string");
  if (!Array.isArray(thread.turns) || !thread.turns.length) throw refuse("job.thread.turns must be a non-empty array");
  for (const [i, t] of thread.turns.entries()) {
    if (!t || typeof t.text !== "string") throw refuse(`turn ${i} text must be a string`);
    if (t.otherwise !== undefined && typeof t.otherwise !== "string") throw refuse(`turn ${i} otherwise must be a string`);
    if (t.answers !== undefined && !Array.isArray(t.answers)) throw refuse(`turn ${i} answers must be an array`);
    for (const a of t.answers || []) {
      if (!a || typeof a.when !== "string" || typeof a.text !== "string") throw refuse(`turn ${i} answers need string when and text`);
      try { new RegExp(a.when, "i"); } catch { throw refuse(`turn ${i} answer regex ${a.when} is invalid`); }
    }
  }
  return job;
}

/** The canned reply to a question, or null: only when the reply's last non-empty line ends with "?". */
export function pickAnswer(reply, turn) {
  const lines = String(reply || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines.at(-1).endsWith("?")) return null;
  const hit = (turn.answers || []).find((a) => new RegExp(a.when, "i").test(reply));
  if (hit) return hit.text;
  return typeof turn.otherwise === "string" ? turn.otherwise : null;
}

async function main(argv, env) {
  assertEvalEnv(env);
  const [jobPath, progressPath] = argv;
  // The guard proved CROW_HOME is a scratch home; both files must live strictly inside it.
  const home = realish(env.CROW_HOME);
  for (const [name, p] of [["job", jobPath], ["progress", progressPath]]) {
    if (typeof p !== "string" || !p) throw refuse(`${name} path is required`);
    const r = realish(p);
    if (r === home || !within(r, home)) throw refuse(`${name} path must be strictly inside CROW_HOME`);
  }
  const job = readJob(jobPath, env);
  const thread = job.thread.id;

  // Only now the driver helpers (crow-home.js, bot-env.js, pi_lifecycle.mjs: no DB, no bridge).
  const { checkToolSurface, checkToolGrant, killTree } = await import("./live-pi-driver.mjs");
  installDeathWatch(killTree);

  // Pre-spawn asserts (R2, R7): no warm target, and the static tool surface.
  if (env.PIBOT_WARM_GATEWAY_URL !== "http://127.0.0.1:1") throw refuse('PIBOT_WARM_GATEWAY_URL must be "http://127.0.0.1:1"');
  const surface = { allowServers: job.allowServers, allowSkills: job.allowSkills ?? [], scratchHome: env.CROW_HOME };
  try { checkToolSurface(job.botDef, surface); } catch (e) { throw refuse(e.message); }

  const { default: Database } = await import("better-sqlite3");
  const conn = new Database(env.CROW_DB_PATH);
  try {
    conn.pragma("busy_timeout = 10000");
    // model_resolver prefers DB provider rows over PI_MODELS_JSON (model_resolver.mjs loadModels).
    let n;
    try { n = conn.prepare("SELECT count(*) AS n FROM providers").get().n; } catch (e) { throw refuse(`providers table unreadable: ${e.message}`); }
    if (n !== 0) throw refuse(`the scratch DB providers table must be empty (has ${n} rows)`);

    // The EFFECTIVE tool surface: the def plus its skills' declared tools, checked again in full.
    const { withSkillTools } = await import("../pi-bots/bot-world.mjs");
    const effective = await withSkillTools(job.botDef, { crowHome: env.CROW_HOME, log: (m) => console.error(`[child] ${m}`) });
    try {
      checkToolSurface(effective, surface);
      checkToolGrant(effective, { allowToolless: job.allowToolless === true });
    } catch (e) { throw refuse(`effective tools: ${e.message}`); }

    // Seed the bot (D6), after the guard.
    const { id, ...rest } = job.botDef;
    conn.prepare(`INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?, ?, ?, 1)
      ON CONFLICT(bot_id) DO UPDATE SET display_name = excluded.display_name, definition = excluded.definition, enabled = 1`)
      .run(id, String(job.botDef.display_name || id), JSON.stringify(rest));
  } finally { conn.close(); }

  const { countLivePi } = await import("../pi-bots/pi_lifecycle.mjs");
  const { handleInbound, getSession } = await import("../pi-bots/bridge.mjs");

  const fd = openSync(progressPath, "a");
  const emit = (o) => { if (dying) return; writeSync(fd, JSON.stringify(o) + "\n"); fsyncSync(fd); };
  try {
    emit({ ev: "start", thread, flags: { CROW_SESSION_SUMMARIES: env.CROW_SESSION_SUMMARIES ?? null, CROW_SESSION_BRIEFING: env.CROW_SESSION_BRIEFING ?? null } });

    /** One handleInbound turn; resolves to its turn-end record, or throws an exit for 4/6. */
    const runTurn = async (turn, text, injected) => {
      const live = job.capacityCount ?? countLivePi();
      if (live >= job.prodMaxPi - 1) { emit({ ev: "capacity", live, max: job.prodMaxPi }); throw fail(6, `prod pi capacity ${live}/${job.prodMaxPi}`); }
      emit({ ev: "turn-start", thread, turn, injected });
      const replies = [];
      const r = await handleInbound({
        bot_id: job.botDef.id, gateway_thread_id: thread, gateway_type: job.gatewayType || "perch", user_message: text,
        sendReply: async (t) => { replies.push(String(t)); },
        log: (m) => console.error(`[bridge] ${m}`),
        mcpOverrides: job.mcpOverrides,
      });
      if (dying) await new Promise(() => {}); // the parent-death cleanup owns the exit now
      const session = getSession(job.botDef.id, thread);
      const end = {
        ev: "turn-end", thread, turn, injected, action: r && r.action, reply: replies.join("\n"),
        piSessionId: (r && r.piSessionId) || null, sessionDir: (session && session.pi_session_dir) || null,
        toolCalls: (r && r.toolCalls) || [],
      };
      emit(end);
      if (!OK_ACTIONS.has(end.action)) throw fail(4, `turn ${turn} ended with action ${end.action}${r && r.error ? `: ${r.error}` : ""}`);
      return end;
    };

    for (const [i, turn] of job.thread.turns.entries()) {
      const end = await runTurn(i, turn.text, false);
      const answer = pickAnswer(end.reply, turn);
      if (answer !== null) await runTurn(i, answer, true); // never more than one per scripted turn
    }
    emit({ ev: "done", thread });
  } finally { closeSync(fd); }
}

// --- Parent death and crashes -------------------------------------------------------------------
// The parent is detached from us and may die without signalling (SIGKILL). Reparenting is the
// tell: then kill our own descendants (pi runs in its own group) and exit 5.
let dying = false;
let killTreeFn = null;
const startPpid = process.ppid;

async function dieWith(code, why) {
  if (dying) return;
  dying = true;
  console.error(`live pi driver child: ${why}; killing the tree`);
  try { if (killTreeFn) await killTreeFn(process.pid, { includeRoot: false }); } catch (e) { console.error(`killTree failed: ${e.message}`); }
  process.exit(code);
}

function installDeathWatch(killTree) {
  killTreeFn = killTree;
  setInterval(() => { if (process.ppid !== startPpid) dieWith(5, "parent died"); }, PARENT_POLL_MS).unref();
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  process.on("uncaughtException", (e) => dieWith(1, `uncaught exception: ${e && e.stack || e}`));
  process.on("unhandledRejection", (e) => dieWith(1, `unhandled rejection: ${e && e.stack || e}`));
  let code = 0;
  try {
    await main(process.argv.slice(2), process.env);
  } catch (err) {
    code = Number.isInteger(err && err.exitCode) ? err.exitCode : 1;
    console.error(`Error: ${err && err.message}`);
  }
  if (!dying) {
    // A clean end still reaps anything a turn left behind; bridge timers must not hold us open.
    if (killTreeFn) { try { await killTreeFn(process.pid, { includeRoot: false }); } catch { /* best effort */ } }
    process.exit(code);
  }
}
