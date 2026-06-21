#!/usr/bin/env node
/**
 * Crow Bot Builder — async background-job runner (Plan B Part 1).
 *
 * The replacement for the retired orchestrator's crow_orchestrate: a way to run
 * a pi bot DETACHED on a goal, returning a job id immediately and delivering the
 * result later. The gateway (crow_delegate) or the bot cron scheduler INSERTs a
 * 'queued' bot_jobs row; this runner — hosted in the long-lived pi-bots process
 * (gateway_runner.mjs), and also drained by bridge_tick.mjs — polls, atomically
 * claims one job, drives a real bot pi turn on the goal, captures the assistant
 * result, and delivers it (Crow memory / channel reply / poll-only).
 *
 * Design (review-hardened):
 *  - The bot_jobs TABLE is the cross-process IPC channel: the gateway and
 *    scripts/pi-bots/ open the SAME crow.db. journal_mode is RAM-dependent
 *    (resolveJournalMode: WAL on >2 GiB hosts — crow/mpa/grackle — DELETE only on
 *    ≤2 GiB like black-swan); a single UPDATE...RETURNING claim is atomic in BOTH
 *    modes (SQLite serializes writers). We NEVER hold a transaction across the
 *    (minutes-long) pi spawn — claim is one brief sync UPDATE, run is
 *    connection-free, finalize is one brief UPDATE.
 *  - CONCURRENCY (C3): jobs ride the same countLivePi()/maxPi budget as live
 *    turns + skill reviews, but with a RESERVED slot — a job is claimed only when
 *    countLivePi() < maxPi-1 (on a 2-slot node: only when idle), so a background
 *    job can never starve an interactive user turn.
 *  - REAPER (C3): a job pi is a normal `--mode rpc` child, so reapStalePi() culls
 *    it if it wedges past the 30-min hard age cap. JOB_TIMEOUT_MS is kept well
 *    under that cap so a healthy job closes itself first. A job whose host died
 *    mid-run is recovered (re-queued) up to MAX_JOB_ATTEMPTS, then failed — no
 *    infinite re-run loop.
 *  - PiRpc is imported LAZILY (avoids the static import cycle with bridge.mjs),
 *    exactly as skill_review.mjs does.
 */
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countLivePi, LIFECYCLE_DEFAULTS } from "./pi_lifecycle.mjs";
import { resolveModel } from "./model_resolver.mjs";
import { resolveSkills } from "./skill_resolver.mjs";
import { resolveCrowHome } from "./ext_registry.mjs";
import { writeBotMcp } from "./mcp_writer.mjs";
import { botsDbPath } from "./instance-paths.mjs";
import { BOT_JOBS_DDL } from "./bot-jobs-schema.mjs";
import { warmModel } from "./warm.mjs";
import { meterBotTurn } from "./metering.mjs";

const JOB_TIMEOUT_MS = Number(process.env.PIBOT_JOB_TIMEOUT_MS || 600000); // 10 min, < 30-min reaper cap
const MAX_JOB_ATTEMPTS = Number(process.env.PIBOT_MAX_JOB_ATTEMPTS || 3);  // caps re-enqueue of abandoned jobs

// crow.db opened with busy_timeout only, NEVER a journal_mode pragma (a stray
// WAL flip is the documented SQLITE_BUSY trap — memory crowdb-wal-flip-new-consumers).
// Path resolved per call so CROW_DB_PATH (tests / MPA pinning) is always honored.
// Lazy self-heal: create bot_jobs on first connection in this process so installs
// that predate the table (init-db only re-runs on the 3-table completeness miss)
// work after a runner restart — mirrors pipeline-runner's ensurePipelineRunsTable.
// Idempotent (CREATE … IF NOT EXISTS); guarded so it runs at most once per process.
let _botJobsEnsured = false;
function dbConn() {
  const d = new Database(botsDbPath());
  d.pragma("busy_timeout = 10000");
  if (!_botJobsEnsured) { try { d.exec(BOT_JOBS_DDL); _botJobsEnsured = true; } catch {} }
  return d;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function generateJobId() {
  return "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/**
 * Enqueue a background job. Returns the job id. Callable from any process that
 * shares crow.db (the gateway's crow_delegate does its own libsql INSERT; this
 * is for the pi-bots side, the cron scheduler, and the CLI).
 * @param {{bot_id, goal, deliver_to?, source?, schedule_id?, escalate?, job_id?}} opts
 */
export function enqueueJob(opts) {
  const c = dbConn();
  try {
    const job_id = opts.job_id || generateJobId();
    const deliver_to = opts.deliver_to == null ? null
      : (typeof opts.deliver_to === "string" ? opts.deliver_to : JSON.stringify(opts.deliver_to));
    c.prepare(
      "INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source, schedule_id, escalate) " +
      "VALUES (?,?,?,'queued',?,?,?,?)"
    ).run(job_id, opts.bot_id, opts.goal, deliver_to, opts.source || "manual",
      opts.schedule_id == null ? null : opts.schedule_id, opts.escalate ? 1 : 0);
    return job_id;
  } finally { c.close(); }
}

/** Read a job's status (the crow_job_status path). */
export function jobStatus(job_id) {
  const c = dbConn();
  try {
    return c.prepare(
      "SELECT job_id, bot_id, status, result, error, tool_calls, attempts, created_at, started_at, ended_at " +
      "FROM bot_jobs WHERE job_id=?"
    ).get(job_id) || null;
  } finally { c.close(); }
}

/**
 * Atomically claim the oldest queued job (one statement → safe under DELETE-mode
 * single-writer serialization). Returns the claimed row, or null if none queued.
 */
export function claimNextJob(workerPid = process.pid) {
  const c = dbConn();
  try {
    return c.prepare(`
      UPDATE bot_jobs
         SET status='running', worker_pid=?, started_at=datetime('now'),
             claimed_at=datetime('now'), attempts=attempts+1
       WHERE job_id = (SELECT job_id FROM bot_jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
      RETURNING *
    `).get(workerPid) || null;
  } finally { c.close(); }
}

/**
 * Recover jobs left 'running' by a host that died mid-run (worker_pid not alive):
 * re-queue up to MAX_JOB_ATTEMPTS, then fail. A still-alive worker's job is left
 * untouched (it's legitimately running). This is what prevents the reaper-kill →
 * re-run infinite loop: a wedged/reaped job's host is usually still alive, so it
 * is NOT re-queued here; only genuinely abandoned jobs are, and only up to the cap.
 */
export function recoverStaleClaims(log = () => {}) {
  const c = dbConn();
  try {
    const rows = c.prepare("SELECT job_id, worker_pid, attempts FROM bot_jobs WHERE status='running'").all();
    for (const r of rows) {
      if (isAlive(r.worker_pid)) continue; // host still running it — leave alone
      if (r.attempts < MAX_JOB_ATTEMPTS) {
        c.prepare("UPDATE bot_jobs SET status='queued', worker_pid=NULL, started_at=NULL, claimed_at=NULL WHERE job_id=?").run(r.job_id);
        log(`recovered abandoned job ${r.job_id} (worker pid ${r.worker_pid} dead) → re-queued (attempt ${r.attempts}/${MAX_JOB_ATTEMPTS})`);
      } else {
        c.prepare("UPDATE bot_jobs SET status='failed', error=?, ended_at=datetime('now') WHERE job_id=?")
          .run("abandoned: worker died, max attempts reached", r.job_id);
        log(`job ${r.job_id} failed — abandoned, ${r.attempts} attempts`);
      }
    }
  } finally { c.close(); }
}

export function finalizeJob(job_id, { status, result, error, tool_calls, pi_session_id }) {
  const c = dbConn();
  try {
    c.prepare(
      "UPDATE bot_jobs SET status=?, result=?, error=?, tool_calls=?, pi_session_id=?, ended_at=datetime('now') WHERE job_id=?"
    ).run(status, result == null ? null : result, error == null ? null : error,
      tool_calls == null ? null : tool_calls, pi_session_id == null ? null : pi_session_id, job_id);
  } finally { c.close(); }
}

function buildJobPrompt(goal) {
  return [
    "You are running a BACKGROUND job for the user — no one is waiting on this exact",
    "reply in real time, so do the work thoroughly before answering. Use your tools",
    "as needed to accomplish the goal.",
    "",
    "GOAL:",
    String(goal || "").slice(0, 8000),
    "",
    "When finished, reply with a concise summary of the outcome (what you did and the",
    "result). If a result is meant to be read back to the user, make the summary",
    "self-contained.",
  ].join("\n");
}

/**
 * Drive one bot pi turn on the job's goal, detached, and capture the result.
 * Runs the bot with its REAL persona/skills/tools (writeBotMcp + def tools) in a
 * throwaway session dir (clean, isolated — like skill_review). Never holds a DB
 * connection. Returns { result, toolCalls, sessionId, model }.
 */
export async function runJob(job, { log = () => {} } = {}) {
  // loadBot is exported from bridge.mjs (S1). Lazy-import the whole module so we
  // also get PiRpc without a static cycle.
  const bridge = await import("./bridge.mjs");
  const bot = bridge.loadBot(job.bot_id); // throws on unknown/disabled
  const def = bot.def;
  const crowHome = resolveCrowHome();
  const sessionDir = mkdtempSync(join(tmpdir(), "pibot-job-"));
  mkdirSync(join(sessionDir, "sessions"), { recursive: true });
  try {
    const sysFile = join(sessionDir, "job-sys.md");
    writeFileSync(sysFile, def.system_prompt || "You are a Crow bot.", { mode: 0o600 });
    const { sections } = resolveSkills(def.skills || [], { crowHome });
    for (const s of sections) appendFileSync(sysFile, "\n\n" + s.text);

    // Per-job .mcp.json so the bot has its configured tools. Remote disabled for
    // background jobs (no peer fan-out without an explicit live operator turn).
    try {
      writeBotMcp(def, { sessionDir, crowHome, remoteEnabled: false, peerGatewayUrls: {} });
    } catch (e) { log("job mcp.json write skipped (non-fatal): " + ((e && e.message) || e)); }

    const resolved = await resolveModel(def, { escalate: !!job.escalate });
    log(`job ${job.job_id} bot=${job.bot_id} model=${resolved.key}`);

    // Warm the bundle (no-op for cloud/already-resident) before the turn.
    await warmModel(resolved.provider, log);

    const pi = new bridge.PiRpc({
      def, sessionDir, resolved, selfAuthoringDir: null,
      piSessionId: null, appendSystemPromptFile: sysFile,
    });
    try {
      const st0 = await pi.getState().catch(() => null);
      const stats0 = await pi.getSessionStats().catch(() => null);
      await pi.prompt(buildJobPrompt(job.goal), JOB_TIMEOUT_MS);
      const st1 = await pi.getState().catch(() => null);
      const stats1 = await pi.getSessionStats().catch(() => null);
      const sessionId = (st1 && st1.data && st1.data.sessionId)
        || (st0 && st0.data && st0.data.sessionId) || null;
      // Phase 1.4: meter the scheduled job turn (surface=bot). Best-effort —
      // never fails the job. dbConn() is busy_timeout-only (no WAL flip).
      try {
        const mconn = dbConn();
        try {
          await meterBotTurn({
            conn: mconn, statsBefore: stats0 && stats0.data, statsAfter: stats1 && stats1.data,
            resolved, surface: "bot", requestId: sessionId, log,
          });
        } finally { mconn.close(); }
      } catch (e) {
        log("[metering] job usage record failed (non-fatal): " + ((e && e.message) || e));
      }
      const text = pi.assistantText() || "(no reply)";
      const calls = pi.toolCalls();
      return { result: text, toolCalls: calls.length, sessionId, model: resolved.key };
    } finally {
      await pi.close();
    }
  } finally {
    if (existsSync(sessionDir)) { try { rmSync(sessionDir, { recursive: true, force: true }); } catch {} }
  }
}

/**
 * Deliver a completed job's result per deliver_to JSON:
 *   { kind: "memory", memory_category? }                 → store as a Crow memory (inline)
 *   { kind: "poll" } | null                              → no push; caller reads bot_jobs.result
 *   { kind: "gmail",   to, reply_to?, subject?, thread } → reply on the Gmail thread
 *   { kind: "gateway", gateway_type, gateway_thread_id } → post to the socket channel
 *
 * memory/poll are transport-free and handled here. The CHANNEL kinds (gmail +
 * the socket gateways) are delegated to `deliverChannel` — the host-provided
 * callback (see gateways/deliver.makeChannelDeliverer) that owns the actual
 * Gmail CLI / SDK-REST send. When no deliverChannel is injected (e.g. a bare
 * detached worker), the result simply stays in bot_jobs.result for poll
 * retrieval rather than being lost.
 */
export async function deliverResult(job, text, { log = () => {}, deliverChannel = null } = {}) {
  let spec = null;
  try { spec = job.deliver_to ? JSON.parse(job.deliver_to) : null; } catch { spec = null; }
  const kind = (spec && spec.kind) || "poll";
  if (kind === "poll") return { delivered: "poll" };
  if (kind === "memory") {
    const c = dbConn();
    try {
      c.prepare("INSERT INTO memories (content, category, importance, tags, source) VALUES (?,?,?,?,?)")
        .run(text, (spec && spec.memory_category) || "bot-job", 6, "bot-job,automated", "bot-job:" + job.bot_id);
      log(`job ${job.job_id} → delivered to Crow memory`);
    } finally { c.close(); }
    return { delivered: "memory" };
  }
  if (kind === "gmail" || kind === "gateway") {
    if (!deliverChannel) {
      log(`job ${job.job_id} → ${kind} delivery deferred (no channel deliverer in this process); result kept for poll`);
      return { delivered: "deferred" };
    }
    return await deliverChannel(job, spec, text);
  }
  return { delivered: "none" };
}

/**
 * One poll tick: recover stale claims, then — only if interactive capacity is
 * spare (reserved-slot gate) — claim and run ONE job to completion, finalize,
 * and deliver. Async; holds no DB connection across the pi run.
 */
export async function tickJobs({ log = () => {}, deliverChannel = null } = {}) {
  recoverStaleClaims(log);

  const maxPi = LIFECYCLE_DEFAULTS.maxPi;
  const reserve = Math.max(1, maxPi - 1); // leave >=1 slot for an interactive turn
  const live = countLivePi();
  if (live >= reserve) return { skipped: "busy", live, reserve };

  const job = claimNextJob();
  if (!job) return { idle: true };
  log(`claimed job ${job.job_id} (bot=${job.bot_id}, attempt ${job.attempts})`);

  let outcome;
  try {
    const r = await runJob(job, { log });
    outcome = { status: "completed", result: r.result, error: null, tool_calls: r.toolCalls, pi_session_id: r.sessionId };
  } catch (e) {
    outcome = { status: "failed", result: null, error: String((e && e.message) || e), tool_calls: null, pi_session_id: null };
  }
  finalizeJob(job.job_id, outcome);
  log(`job ${job.job_id} → ${outcome.status}${outcome.error ? " (" + outcome.error + ")" : ""}`);

  if (outcome.status === "completed") {
    try { await deliverResult(job, outcome.result, { log, deliverChannel }); }
    catch (e) { log(`delivery failed for ${job.job_id}: ${(e && e.message) || e}`); }
  }
  return { ran: job.job_id, status: outcome.status };
}

// CLI: enqueue / inspect / drain. Used for manual ops + the §verification spike.
if (import.meta.url === "file://" + process.argv[1]) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const log = (m) => console.error("[job-runner] " + m);
  (async () => {
    if (a.includes("--enqueue")) {
      const payload = JSON.parse(flag("--enqueue"));
      const id = enqueueJob(payload);
      console.log(JSON.stringify({ job_id: id }));
      process.exit(0);
    }
    if (a.includes("--status")) {
      console.log(JSON.stringify(jobStatus(flag("--status")), null, 2));
      process.exit(0);
    }
    // Manual ops deliver for real too (so a CLI --tick can post to a channel).
    const mkDeliver = async () =>
      (await import("./gateways/deliver.mjs")).makeChannelDeliverer({ log });
    if (a.includes("--tick")) {
      console.log(JSON.stringify(await tickJobs({ log, deliverChannel: await mkDeliver() })));
      process.exit(0);
    }
    if (a.includes("--run-once")) {
      // Claim + run one job IGNORING the reserved-slot gate (manual/testing).
      recoverStaleClaims(log);
      const job = claimNextJob();
      if (!job) { console.log(JSON.stringify({ idle: true })); process.exit(0); }
      let outcome;
      try {
        const r = await runJob(job, { log });
        outcome = { status: "completed", result: r.result, error: null, tool_calls: r.toolCalls, pi_session_id: r.sessionId };
      } catch (e) {
        outcome = { status: "failed", result: null, error: String((e && e.message) || e), tool_calls: null, pi_session_id: null };
      }
      finalizeJob(job.job_id, outcome);
      if (outcome.status === "completed") await deliverResult(job, outcome.result, { log, deliverChannel: await mkDeliver() }).catch(() => {});
      console.log(JSON.stringify({ ran: job.job_id, status: outcome.status }));
      process.exit(0);
    }
    console.error("usage: job_runner.mjs --enqueue '<json>' | --status <job_id> | --tick | --run-once");
    process.exit(2);
  })().catch((e) => { console.error("[job-runner] CRASH " + (e && e.stack || e)); process.exit(2); });
}
