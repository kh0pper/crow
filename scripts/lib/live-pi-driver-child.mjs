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
 *        mcpOverrides, runId, pr4, quickModel, thread: { id, summariseAfter?, briefingBefore?, projectId?,
 *        turns: [{ text, answers?: [{ when, text }], otherwise? }] } }
 * `capacityCount` is a test-only stand-in for countLivePi() (null in a real run).
 *
 * PR 4 (`pr4`: some thread of the run summarises or is briefed) mirrors Perch's call sequence:
 * the scratch `providers` table is the run's registry (a mirror of PI_MODELS_JSON, so the roles
 * store, the privacy ranks and the summary's model call resolve as they do in a gateway), the
 * quick role is bound through the roles store, and a summarised or briefed thread is a Perch
 * session in the DB (kind perch-live, filed under its projectId the way Perch's spawn route files
 * one). The briefing is built the way that route builds it (targetRankOf the bot's model, then
 * buildBriefing, briefingText, briefingRefs, pruneBriefing), applied through handleInbound's
 * eval-only evalSpawnTransform on every spawn (a resume is a Perch wake, which re-reads it from the row), and recorded on
 * the row after the first turn (recordBriefing, reconcileBriefing). The summary is the close
 * hook's summarizeSessionByThread call, after the last turn.
 *
 * Progress (one appended, synced line per event): start, briefing ({ chars, sha256, rank }, never
 * the text), turn-start, turn-end, capacity, rank ({ recall }: the recall gate's askerRank),
 * summary ({ written, reason, detail?, transport: "injected" }, never the text), done.
 * Exit codes: 0 all turns ran; 1 guard refusal (including a thread id that already has a
 * bot_sessions row) or crash; 4 a turn's action was not asked/executed (its turn-end is
 * written first); 5 the parent died; 6 prod pi capacity (R6).
 *
 * Why the order matters: bridge.mjs reads CROW_DB, TASKS_DB, the turn timeout and the warm
 * target from env at IMPORT time. So the static imports below are node built-ins and the guard
 * alone (and the path helpers it uses); assertEvalEnv runs first, and everything else is imported only after it passes (the
 * research-eval fixture-server pattern). A refused start has loaded no server code.
 */
import { createHash } from "node:crypto";
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
  if (!Number.isInteger(job.prodMaxPi) || job.prodMaxPi < 2) throw refuse("job.prodMaxPi must be an integer >= 2");
  if (job.capacityCount !== undefined && job.capacityCount !== null) {
    if (env.NODE_TEST_CONTEXT === undefined) throw refuse("job.capacityCount is test-only (no NODE_TEST_CONTEXT)");
    if (!Number.isInteger(job.capacityCount) || job.capacityCount < 0) throw refuse("job.capacityCount must be a non-negative integer");
  }
  if (!thread || typeof thread.id !== "string" || !thread.id) throw refuse("job.thread.id must be a non-empty string");
  if (job.pr4 !== undefined && typeof job.pr4 !== "boolean") throw refuse("job.pr4 must be a boolean");
  if (job.quickModel !== undefined && job.quickModel !== null && (typeof job.quickModel !== "string" || !job.quickModel.includes("/"))) throw refuse("job.quickModel must be provider/id");
  for (const k of ["summariseAfter", "briefingBefore"]) {
    if (thread[k] !== undefined && typeof thread[k] !== "boolean") throw refuse(`job.thread.${k} must be a boolean`);
    if (thread[k] === true && job.pr4 !== true) throw refuse(`job.thread.${k} needs job.pr4`);
  }
  if (thread.projectId !== undefined && (!Number.isInteger(thread.projectId) || thread.projectId < 1)) throw refuse("job.thread.projectId must be a positive integer");
  if (thread.briefingBefore === true && thread.projectId === undefined) throw refuse("job.thread.briefingBefore needs a projectId");
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
    if (job.pr4 === true) {
      // The registry: exactly the endpoints pi gets (PI_MODELS_JSON, written and checked by the parent).
      const want = registryRows(env);
      if (n === 0) {
        const ins = conn.prepare("INSERT INTO providers (id, base_url, api_key, host, models) VALUES (?, ?, ?, 'local', ?)");
        for (const r of want) ins.run(r.id, r.base_url, r.api_key, r.models);
      } else {
        const have = conn.prepare("SELECT id, base_url, api_key, host, models, disabled FROM providers ORDER BY id").all();
        const same = have.length === want.length && have.every((h, i) => h.id === want[i].id && h.base_url === want[i].base_url
          && h.api_key === want[i].api_key && h.host === "local" && h.models === want[i].models && !h.disabled);
        if (!same) throw refuse(`the scratch DB providers table must be empty or this run's registry (has ${n} other rows)`);
      }
    } else if (n !== 0) throw refuse(`the scratch DB providers table must be empty (has ${n} rows)`);

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
  // handleInbound resumes any existing (bot, thread) row's pi session: a used id is never run.
  if (getSession(job.botDef.id, thread)) throw refuse(`thread ${thread} already exists in this scratch`);

  // PR 4: the hooks, the quick role and the thread's filing (the parent probed the imports).
  const perch = job.thread.summariseAfter === true || job.thread.briefingBefore === true;
  let pdb = null;
  let hooks = null;
  if (job.pr4 === true) {
    // One namespace per module: a name two modules share can never shadow the other.
    hooks = {
      db: await import("../../servers/db.js"),
      summary: await import("../../servers/gateway/perch/session-summary.js"),
      briefing: await import("../../servers/gateway/perch/briefing.js"),
      recall: await import("../../servers/memory/summary-recall.js"),
      roles: await import("../../servers/shared/model-roles-store.js"),
      shell: await import("../../servers/shared/shell-items.js"),
      paths: await import("../pi-bots/instance-paths.mjs"),
    };
    pdb = hooks.db.createDbClient(env.CROW_DB_PATH);
  }
  try {
    if (pdb && job.quickModel) {
      const b = await hooks.roles.setBinding(pdb, "quick", { model: job.quickModel }, { actor: "live-pi-driver" });
      if (!b.ok) throw refuse(`cannot bind the quick role: ${b.reason}`);
    }
    if (pdb && job.thread.projectId !== undefined) {
      // The spawn route's order: the project must be live, then the new thread is filed under it.
      try { await hooks.shell.assertLiveProject(pdb, job.thread.projectId); } catch (e) { throw refuse(`project ${job.thread.projectId}: ${e.message}`); }
      await hooks.shell.ensureItem(pdb, "perch_thread", thread, { projectId: job.thread.projectId, setBy: "operator" });
    }
    await runThread({ job, env, thread, perch, pdb, hooks, handleInbound, getSession, countLivePi, progressPath });
  } finally { if (pdb) { try { pdb.close(); } catch { /* closed */ } } }
}

/** The run's checked models: PI_MODELS_JSON, written by the parent strictly inside the scratch home. */
function readModelsJson(env) {
  const home = realish(env.CROW_HOME);
  const path = env.PI_MODELS_JSON;
  if (typeof path !== "string" || !within(realish(path), home) || realish(path) === home) throw refuse("PI_MODELS_JSON must be inside CROW_HOME");
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw refuse(`PI_MODELS_JSON unreadable: ${e.message}`); }
}

/** The provider registry rows for this run: one per PI_MODELS_JSON provider (the scratch's own file). */
function registryRows(env) {
  const m = readModelsJson(env);
  const providers = (m && m.providers) || {};
  return Object.keys(providers).sort().map((id) => ({
    id, base_url: String(providers[id].baseUrl), api_key: providers[id].apiKey == null ? null : String(providers[id].apiKey),
    models: JSON.stringify(providers[id].models || []),
  }));
}

const SUMMARY_CODE_RE = /^[a-z_]{1,32}$/;
// llm-router.js: provider kinds (or ollama's port) that load a model on the first request.
const LAZY_LOADER_RE = /ollama|llama[-_ ]?swap|lemonade|lm[-_ ]?studio|localai/i;
const LAZY_LOADER_PORT_RE = /:11434(\/|$)/;

/**
 * The summary job's model call (session-summary.js deps.complete), injected in place of
 * llm-router's completeText with the same contract: ({ model, prompt, maxTokens, timeoutMs }) ->
 * the reply text, thinking tags stripped; a fixed-code skip carries `reason` (lazy_loader); every
 * failure throws a message that never quotes the prompt or the reply. The endpoint comes from the
 * run's checked models and only `quickModel` may be called. It never goes through llm-router, so
 * it neither reads the host's box reservation nor meters usage.
 */
function injectedComplete(models, quickModel) {
  return async ({ model, prompt, maxTokens = 400, timeoutMs = 60_000 } = {}) => {
    if (!model || typeof prompt !== "string") throw new Error("completeText: model and prompt are required");
    if (String(model) !== quickModel) throw new Error("completeText: refused, not the run's quick model");
    const i = String(model).indexOf("/");
    const p = models && models.providers && models.providers[String(model).slice(0, i)];
    if (!p || !p.baseUrl) throw new Error("completeText: no base url for the model");
    const baseUrl = String(p.baseUrl).replace(/\/$/, "");
    if (LAZY_LOADER_RE.test(String(p.providerType || p.provider_type || "")) || LAZY_LOADER_PORT_RE.test(baseUrl)) {
      throw Object.assign(new Error("completeText: skipped, lazy_loader"), { reason: "lazy_loader" });
    }
    const apiKey = p.apiKey;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey && apiKey !== "none" ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: String(model).slice(i + 1), messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.2, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`completeText: upstream status ${res.status}`);
    let json;
    try { json = await res.json(); } catch { throw new Error("completeText: invalid upstream body"); }
    const content = json?.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : (Array.isArray(content) ? content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("") : "");
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
  };
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

async function runThread({ job, env, thread, perch, pdb, hooks, handleInbound, getSession, countLivePi, progressPath }) {

  const fd = openSync(progressPath, "a");
  const emit = (o) => { if (dying) return; writeSync(fd, JSON.stringify(o) + "\n"); fsyncSync(fd); };
  try {
    emit({ ev: "start", thread, flags: { CROW_SESSION_SUMMARIES: env.CROW_SESSION_SUMMARIES ?? null, CROW_SESSION_BRIEFING: env.CROW_SESSION_BRIEFING ?? null } });

    // The briefing, built the way Perch's spawn route builds it (the flag is read per use there too).
    let brief = null;
    let recorded = false;
    if (job.thread.briefingBefore === true && hooks.briefing.briefingEnabled()) {
      const rank = await hooks.briefing.targetRankOf(pdb, job.botDef.models.default);
      const fragments = await hooks.briefing.buildBriefing(pdb, { projectId: job.thread.projectId, targetRank: rank }, { tasksDbPath: hooks.paths.tasksDbPath() });
      let text = hooks.briefing.briefingText(fragments) || null;
      let refs = text ? hooks.briefing.briefingRefs(fragments) : [];
      // The engine's spawn: drop a summary forgotten since the route built the block.
      if (text && refs.length) { const p = await hooks.briefing.pruneBriefing(pdb, text, refs); text = p.text || null; refs = p.refs; }
      brief = { text, rank, refs };
      emit({ ev: "briefing", thread, chars: text ? text.length : 0, sha256: text ? sha256(text) : null, rank });
    }
    // A first spawn takes the built text; every later one is a wake, which reads the row (startChild).
    const briefingFor = async () => {
      if (!brief || !brief.text || !hooks.briefing.briefingEnabled()) return null;
      if (!recorded) return brief.text;
      const row = await hooks.briefing.sessionBriefing(pdb, thread);
      return row ? row.text : null;
    };

    // Perch's placement (startChild): the block appended to a copy of the system prompt at
    // <CROW_HOME>/perch-briefings/<bot>/<thread>.system-prompt.md, applied by handleInbound's
    // eval-only spawn transform right before pi. Fails loudly: never a row without its briefing.
    const briefingTransform = (text) => (piRpcOpts) => {
      const file = hooks.briefing.briefingPromptFile(env.CROW_HOME, job.botDef.id, thread);
      const out = hooks.briefing.applyBriefing(piRpcOpts, text, { file });
      if (out.appendSystemPromptFile !== file) throw new Error("eval briefing was not applied");
      return out;
    };

    /** One handleInbound turn; resolves to its turn-end record, or throws an exit for 4/6. */
    const runTurn = async (turn, text, injected) => {
      const live = job.capacityCount ?? countLivePi();
      if (live >= job.prodMaxPi - 1) { emit({ ev: "capacity", live, max: job.prodMaxPi }); throw fail(6, `prod pi capacity ${live}/${job.prodMaxPi}`); }
      emit({ ev: "turn-start", thread, turn, injected });
      const replies = [];
      const briefingText = await briefingFor();
      const r = await handleInbound({
        bot_id: job.botDef.id, gateway_thread_id: thread, gateway_type: job.gatewayType || "perch", user_message: text,
        sendReply: async (t) => { replies.push(String(t)); },
        log: (m) => console.error(`[bridge] ${m}`),
        mcpOverrides: job.mcpOverrides,
        ...(perch ? { kind: "perch-live" } : {}),
        ...(briefingText ? { evalSpawnTransform: briefingTransform(briefingText) } : {}),
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
      if (briefingText && !recorded) {
        // Perch records the block once the row exists (after startChild), then reconciles a Forget.
        recorded = await hooks.briefing.recordBriefing(pdb, thread, brief.text, brief.rank, brief.refs);
        if (!recorded) throw fail(1, "the briefing could not be recorded on the thread's row");
        await hooks.briefing.reconcileBriefing(pdb, thread);
      }
      return end;
    };

    for (const [i, turn] of job.thread.turns.entries()) {
      const end = await runTurn(i, turn.text, false);
      const answer = pickAnswer(end.reply, turn);
      if (answer !== null) await runTurn(i, answer, true); // never more than one per scripted turn
    }
    if (job.pr4 === true) {
      // The recall gate's rank for this bot as an asker on this thread (unknown counts as cloud).
      emit({ ev: "rank", thread, recall: await hooks.recall.askerRank(pdb, { kind: "bot", id: job.botDef.id }, { threadId: thread }) });
    }
    if (job.thread.summariseAfter === true) {
      // Perch's close hook: the model the session is on, trigger "close". The job reads the flag.
      const row = getSession(job.botDef.id, thread);
      const r = await hooks.summary.summarizeSessionByThread(pdb, thread, {
        trigger: "close", sessionModelKey: (row && row.model) || null, complete: injectedComplete(readModelsJson(env), job.quickModel),
      });
      const detail = r && typeof r.detail === "string" && SUMMARY_CODE_RE.test(r.detail) ? { detail: r.detail } : {};
      // A missing or malformed result is reported as "missing" (the parent contaminates it).
      const reason = r && typeof r.reason === "string" && SUMMARY_CODE_RE.test(r.reason) ? r.reason : "missing";
      emit({ ev: "summary", thread, written: !!(r && r.written === true), reason, ...detail, transport: "injected" });
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
