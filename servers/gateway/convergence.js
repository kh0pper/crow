// servers/gateway/convergence.js
//
// An instance's job is to converge to the tree, not to pull.
//
// Three gateways (primary, MPA, r4) run from ONE shared ~/crow checkout with
// three separate data dirs. Pulling is a TREE operation — exactly one winner,
// guarded by the checkout-scoped lock in auto-update.js. Migrating and
// restarting are INSTANCE operations that every gateway must perform with its
// own env. Conflating the two is why the lock loser used to skip everything:
// its own migrations and its own restart-into-new-code, forever, because
// co-hosted gateways restart together and their 6h timers are phase-locked.

/**
 * A REGRESSION check, not an absolute one.
 *
 * "Every addon connected" would quarantine a perfectly good sha on any host
 * that already had a broken addon — precisely crow's state Aug 3-5 2026, when
 * `tasks` and `bots-sql-mcp` were down for an unrelated native-ABI reason. The
 * gate must answer "did this update break something?", not "is everything
 * perfect?".
 *
 * An addon that was already unhealthy is ignored. An addon that has vanished
 * from the snapshot entirely counts as `missing`, which IS a regression when it
 * was previously connected.
 *
 * @param {Record<string,string>|null} before pre-convergence snapshot
 * @param {Record<string,string>|null} after  post-restart snapshot
 * @returns {{ok: boolean, regressions: Array<{id: string, was: string, now: string}>}}
 */
export function compareHealth(before, after) {
  const regressions = [];
  for (const [id, was] of Object.entries(before || {})) {
    if (was !== "connected") continue; // already unhealthy — not ours to blame
    const now = (after || {})[id] ?? "missing";
    if (now !== "connected") regressions.push({ id, was, now });
  }
  return { ok: regressions.length === 0, regressions };
}

import { readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

/** How long a convergence has to boot and verify before we call it failed.
 *  Must exceed the worst realistic boot: a guarded SCHEMA_GENERATION migration
 *  plus a full SEQUENTIAL addon-connect pass (60s per addon, unbounded in
 *  count). Too short quarantines healthy slow boots. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/** Hard expiry on a convergence quarantine. No failure mode may end in a state
 *  recoverable only by deleting files by hand. */
export const QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000;

const PENDING_FILE = "convergence-pending.json";
const QUARANTINE_FILE = ".crow-convergence-quarantine.json";

/**
 * Atomic write. Two properties matter:
 *  - rename(2) is atomic, so a crash mid-write cannot leave torn JSON that
 *    readPending would silently swallow as "nothing pending";
 *  - the tmp path is PER-PROCESS. The repo-root quarantine marker has three
 *    writers (one per co-hosted gateway). With a shared `${path}.tmp`, P2's
 *    O_TRUNC can land in the middle of P1's write and P1 then renames the
 *    resulting byte-salad into place atomically — every peer's JSON.parse
 *    throws, readConvQuarantine returns null, and the canary's failure is
 *    silently discarded.
 */
function writeAtomic(path, obj) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/* ------------------------------------------------------------- boot cookie */

export function writePending(dataDir, { sha, baseline, now = Date.now() }) {
  const rec = { sha, baseline: baseline || {}, deadline: new Date(now + PENDING_TTL_MS).toISOString() };
  writeAtomic(join(dataDir, PENDING_FILE), rec);
  return rec;
}

export function readPending(dataDir) {
  return readJson(join(dataDir, PENDING_FILE));
}

export function clearPending(dataDir) {
  try { unlinkSync(join(dataDir, PENDING_FILE)); } catch {}
}

/**
 * What a booting process should do about the cookie it finds.
 *
 *   none   — nothing pending.
 *   verify — we ARE the boot this cookie was written for, with time left:
 *            wait for addons to settle, snapshot, compare.
 *   failed — the deadline passed with the cookie uncleared. Either the target
 *            never booted, or it booted and died before verifying. Both mean
 *            the convergence did not prove itself.
 *   stale  — a live cookie for a sha we are not running; unrelated, discard.
 *
 * The deadline is checked FIRST and inclusively: a crash-looping gateway boots
 * the target sha repeatedly, so "same sha" alone cannot distinguish healthy
 * from wedged.
 */
export function classifyPending(pending, bootSha, now = Date.now()) {
  if (!pending) return "none";
  if (Date.parse(pending.deadline) <= now) return "failed";
  return pending.sha === bootSha ? "verify" : "stale";
}

/* ------------------------------------------------------ convergence quarantine */

/**
 * Convergence quarantine — its OWN namespace, deliberately NOT the markers in
 * servers/shared/migration-guard.js.
 *
 * Two existing readers consume those with no knowledge of why they were
 * written: the boot guard in index.js would boot the gateway SKIPPING init-db
 * (on an empty database, that means serving with no tables at all), and
 * auto-update.js would block updates host-wide while printing
 * `gen undefined->undefined` at the operator. An addon flapping must not be
 * able to disable schema initialization.
 *
 * Written at BOTH repo and data level: the repo-level file is what co-hosted
 * peers sharing the checkout read.
 */
export function writeConvQuarantine({ appRoot, dataDir, sha, regressions = [], why = "", now = Date.now() }) {
  const marker = { sha, why, regressions, at: new Date(now).toISOString() };
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    try { writeAtomic(p, marker); } catch {}
  }
  return marker;
}

/** The active marker, or null. Anything past QUARANTINE_TTL_MS is ignored, so
 *  no failure mode wedges the host permanently. */
export function readConvQuarantine({ appRoot, dataDir, now = Date.now() }) {
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    const m = readJson(p);
    if (!m) continue;
    if (now - Date.parse(m.at) > QUARANTINE_TTL_MS) continue;
    return m;
  }
  return null;
}

export function clearConvQuarantine({ appRoot, dataDir }) {
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    try { unlinkSync(p); } catch {}
  }
}

/* --------------------------------------------------------- instance identity */

import { execFile } from "node:child_process";

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 120000 }, (err, so, se) =>
      resolve({ stdout: (so || "").trim(), stderr: (se || "").trim(), code: err ? err.code || 1 : 0 }));
  });
}

/** This process's store paths, resolved exactly as the stores themselves are. */
export async function resolveInstance() {
  const { resolveDataDir } = await import("../db.js");
  const { resolveGuardDbPath } = await import("../shared/migration-guard.js");
  const { tasksDbPath } = await import("../../scripts/pi-bots/instance-paths.mjs");
  return {
    dataDir: resolveDataDir(),
    dbPath: resolveGuardDbPath(resolveDataDir),
    tasksDbPath: tasksDbPath(),
  };
}

/**
 * The sha this process booted on. Convergence compares against THIS, never
 * against `pulled`: runLockedUpdate returns updated:false on several branches
 * AFTER the tree has already moved, so a peer deciding on that flag would sit
 * on stale code indefinitely just because it did not personally pull.
 */
let BOOT_SHA = null;
export function setBootSha(sha) { BOOT_SHA = sha || null; }
export function getBootSha() { return BOOT_SHA; }

/* ------------------------------------------------------------------- seams */

let _restartImpl = null;
/** Test-only: capture restarts instead of arming a real process exit.
 *  scheduleSupervisedRestart sets process.exitCode = 1 and schedules a real
 *  process.exit(1), and it is reached through a frozen ESM namespace object so
 *  it cannot be monkeypatched. run-suite.mjs scrubs INVOCATION_ID/CROW_SUPERVISED
 *  suite-wide precisely so code under test never arms those paths. */
export function _setRestartForTest(fn) { _restartImpl = fn; }

let _lockWaitOpts = null;
/** Test-only: shorten the wait for the tree to go quiescent. */
export function _setLockWaitForTest(opts) { _lockWaitOpts = opts; }

let _supervisedImpl = null;
/** Test-only: the harness deliberately runs unsupervised, but the convergence
 *  path still has to be exercisable. */
export function _setSupervisedForTest(fn) { _supervisedImpl = fn; }

async function restart(log, msg) {
  if (_restartImpl) return _restartImpl(log, msg);
  const au = await import("./auto-update.js");
  return au.scheduleSupervisedRestart(log, msg);
}

async function supervised() {
  if (_supervisedImpl) return _supervisedImpl();
  const { isSupervised } = await import("../shared/supervisor.js");
  return isSupervised();
}

/* ------------------------------------------------------------- convergence */

/**
 * Can this instance safely restart into the code now on disk?
 *
 * Returns true when the store needs no schema init, or when a guarded init-db
 * brings it current. Returns false when the schema is behind and cannot be
 * migrated — the caller must then keep the live process rather than restart
 * into a boot guard that will exit(1).
 */
async function schemaReadyForRestart({ appRoot, dbPath, log }) {
  try {
    const { SCHEMA_GENERATION, needsSchemaInit } = await import("../shared/schema-version.js");
    const guard = await import("../shared/migration-guard.js");
    const state = guard.readSchemaState(dbPath);
    if (!needsSchemaInit({
      coreTableCount: state.coreTableCount,
      userVersion: state.userVersion,
      schemaGeneration: SCHEMA_GENERATION,
    })) return true;

    log(`schema behind (user_version=${state.userVersion} < ${SCHEMA_GENERATION}) — running guarded init-db before restart`);
    const res = await guard.runGuardedInitDb({
      dbPath, appRoot, sha: null, newGeneration: SCHEMA_GENERATION,
      log: (m) => log(`[migration-guard] ${m}`),
    });
    if (res.verdict === "loss" || res.initDbExit !== 0) return false;

    const after = guard.readSchemaState(dbPath);
    return !needsSchemaInit({
      coreTableCount: after.coreTableCount,
      userVersion: after.userVersion,
      schemaGeneration: SCHEMA_GENERATION,
    });
  } catch (err) {
    // Cannot determine: do not restart on a guess.
    log(`schema pre-flight error (${err?.message}) — treating as not ready`);
    return false;
  }
}

/**
 * Make ONE instance current with the checkout it runs from.
 *
 * The pull is a TREE operation and stays behind the checkout-scoped lock in
 * auto-update.js — exactly one co-hosted gateway performs it. Everything here
 * is an INSTANCE operation and runs unconditionally, including for the gateway
 * that lost that lock. Before this split the loser returned early and therefore
 * never migrated its own stores and never restarted into the new code; with all
 * gateways restarting together their timers are phase-locked, so the same
 * instance lost every tick, forever.
 */
export async function convergeInstance({ appRoot, instance = null, pulled = false, log = () => {} } = {}) {
  if (process.env.CROW_DISABLE_CONVERGE === "1" || process.env.CROW_DISABLE_CONVERGE === "true") {
    log("convergence disabled via CROW_DISABLE_CONVERGE");
    return { pulled, converged: false, skipped: "disabled", sha: null, applied: [] };
  }

  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = appRoot || dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const inst = instance || (await resolveInstance());

  const head = (await git(root, ["rev-parse", "HEAD"])).stdout;
  const boot = getBootSha();

  // A null sha is a REFUSAL, not a licence. setBootSha is best-effort; treating
  // null as "not current" would converge and restart on every tick forever, and
  // the health gate could not stop it (classifyPending with a null bootSha
  // returns "stale", clearing the cookie without ever verifying).
  if (!head) return { pulled, converged: false, skipped: "no-head", sha: null, applied: [] };
  if (!boot) return { pulled, converged: false, skipped: "no-boot-sha", sha: head, applied: [] };
  if (boot === head) return { pulled, converged: false, skipped: "current", sha: head, applied: [] };

  // Peers honor a quarantine written by whichever instance converged first —
  // that instance is the canary by construction. This gates the MIGRATE AND
  // RESTART only; the tree half above has already run, so the checkout can
  // always move past a bad sha and the marker's expiry can fire.
  const q = readConvQuarantine({ appRoot: root, dataDir: inst.dataDir });
  if (q && q.sha === head) {
    log(`refusing to converge: ${head.slice(0, 9)} is quarantined (${q.why})`);
    return { pulled, converged: false, skipped: "quarantined", sha: head, applied: [] };
  }

  // Serialize the instance half against the TREE half. This path is reached
  // only while another co-hosted gateway holds the checkout lock — i.e. while
  // it is between `git pull` and its `npm install --omit=dev` (up to 5 minutes
  // rewriting the SHARED node_modules) and its init-db. Migrating and
  // restarting into that window boots a gateway against a half-written
  // dependency tree, and `Restart=on-failure` with RestartSec=5 against a 10s
  // StartLimitInterval means the resulting crash loop is UNBOUNDED.
  //
  // Failing to acquire is not an error: skip this tick and retry on the next.
  const au = await import("./auto-update.js");
  const lock = await au.acquireCheckoutLock({ appRoot: root, ...(_lockWaitOpts || {}) });
  if (!lock) {
    log("could not acquire the checkout lock — deferring convergence to the next tick");
    return { pulled, converged: false, skipped: "tree-busy", sha: head, applied: [] };
  }

  try {
    const { runMigrations } = await import("../../scripts/migrations/runner.mjs");
    const { join: joinPath } = await import("node:path");
    var res = await runMigrations({
      migrationsDir: joinPath(root, "scripts", "migrations"),
      dbPath: inst.dbPath,
      tasksDbPath: inst.tasksDbPath,
      sha: head,
      log,
    });

    // Schema pre-flight, BEFORE committing to a restart.
    //
    // The registry only handles additive changes. A SCHEMA_GENERATION bump is
    // validated by whichever instance ran init-db — against ITS data. This
    // instance's store may differ (a backfill or unique index that passed on a
    // smaller dataset can fail here). Discovering that AFTER restarting means
    // the boot guard exits 1 on a process we had just killed for no reason.
    // Check now, and if the schema cannot be brought current, keep serving the
    // live process instead.
    const ok = await schemaReadyForRestart({ appRoot: root, dbPath: inst.dbPath, log });
    if (!ok) {
      log("schema pre-flight failed — restart withheld, this instance keeps running its current code");
      return { pulled, converged: false, skipped: "schema-not-ready", sha: head, applied: res.applied };
    }
  } finally {
    au.releaseCheckoutLock(lock);
  }

  // Without a supervisor, the restart is a silent no-op. Writing a
  // deadline-bearing cookie and then not restarting means the deadline passes
  // and the next boot — hours later, on code that ran fine the whole time —
  // classifies it "failed" and quarantines a healthy sha for every instance
  // sharing this checkout.
  if (!(await supervised())) {
    log(`migrations applied for ${head.slice(0, 9)}; no supervisor — restart manually to load the new code`);
    return { pulled, converged: false, skipped: "unsupervised", sha: head, applied: res.applied };
  }

  // Baseline BEFORE the restart, from the still-live process, handed across in
  // the cookie. An empty baseline never regresses — the correct fail-open read.
  let baseline = {};
  try {
    const p = await import("./proxy.js");
    baseline = p.healthSnapshot();
  } catch { /* proxy not initialized — fail open */ }

  writePending(inst.dataDir, { sha: head, baseline });
  await restart(log, `Restarting to run ${head.slice(0, 9)}...`);

  return { pulled, converged: true, sha: head, applied: res.applied };
}

/* -------------------------------------------------------- boot verification */

/**
 * Called at boot. Decides what the cookie left behind by the previous
 * convergence means, and quarantines the sha if that convergence did not prove
 * itself healthy.
 *
 * `snapshot` and `settled` are injected so tests need not wait on the real
 * addon-connect loop.
 */
export async function verifyPendingConvergence({
  dataDir, appRoot, bootSha, snapshot, settled,
  now = Date.now(), log = () => {},
}) {
  const pending = readPending(dataDir);
  const verdict = classifyPending(pending, bootSha, now);

  if (verdict === "none") return { verdict: "none" };
  if (verdict === "stale") { clearPending(dataDir); return { verdict: "stale" }; }

  const quarantine = async (sha, regressions, why) => {
    writeConvQuarantine({ appRoot, dataDir, sha, regressions, why });
    clearPending(dataDir);
    try {
      const { fireMigrationAlert } = await import("../shared/migration-guard.js");
      await fireMigrationAlert({
        title: "Crow update quarantined: convergence failed",
        body:
          `This instance converged to ${String(sha).slice(0, 9)} and ${why}. That sha is ` +
          `quarantined for 24h — no gateway on this host will converge to it, so the first ` +
          `instance to try is the only one affected. The tree was NOT rolled back: ` +
          `co-hosted instances may be running it healthily.`,
      });
    } catch { /* alerting must never turn a quarantine into a crash */ }
    log(`convergence to ${String(sha).slice(0, 9)} quarantined — ${why}`);
    return { verdict: "quarantined", regressions };
  };

  if (verdict === "failed") {
    return quarantine(pending.sha, [], "never completed a healthy boot before its deadline");
  }

  // verdict === "verify". Everything below is wrapped: an unhandled rejection
  // would take the gateway down on Node 22 and leave the outer promise
  // unsettled, and the gate must fail OPEN when it cannot determine status —
  // a false quarantine is worse than no gate at all.
  try {
    await settled();
    const after = snapshot();
    const cmp = compareHealth(pending.baseline, after);
    if (cmp.ok) {
      clearPending(dataDir);
      // Clear any expired marker we may have left on a previous attempt, so
      // stale files do not accumulate in a shared checkout.
      clearConvQuarantine({ appRoot, dataDir });
      log(`convergence to ${String(pending.sha).slice(0, 9)} verified healthy`);
      return { verdict: "ok" };
    }
    return await quarantine(
      pending.sha, cmp.regressions,
      `broke ${cmp.regressions.map((r) => r.id).join(", ")}`,
    );
  } catch (err) {
    clearPending(dataDir);
    log(`health gate indeterminate (${err.message}) — failing open, not quarantining`);
    return { verdict: "unknown" };
  }
}
