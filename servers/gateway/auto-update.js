/**
 * Auto-Update Module — Periodically pulls latest code from git
 *
 * Enabled by default. Users can toggle via Settings panel or CROW_AUTO_UPDATE env var.
 * Stores state in dashboard_settings DB table.
 *
 * On update: git pull → npm install → import check → init-db → restart (if supervised).
 * A failed npm install ends the tick there: rollback, no import check, no init-db,
 * no restart (N1c-4).
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, accessSync, existsSync, constants as fsConstants } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isSupervised } from "../shared/supervisor.js";
import { isInstallSetRunning } from "./install-lock.js";
import { classifyCheckRuns, parseGithubRemote, ciGateRuns, missingCiContexts, CI_GATE_CONTEXTS } from "../shared/ci-check-runs.js";
import { checkTreeImport, IMPORT_CHECK_ENV } from "./boot/import-check.js";
import {
  activeUpdateQuarantine, evaluateUpdateQuarantine, writeUpdateQuarantine, FULL_SHA_RE,
} from "../shared/update-quarantine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let APP_ROOT = dirname(dirname(__dirname));

/** The tree every git/npm call below runs in (the checkout auto-update pulls into). */
export function appRoot() {
  return APP_ROOT;
}

/** Test-only: retarget git/npm/lock operations at a fixture repo. */
export function _setAppRootForTest(dir) {
  APP_ROOT = dir;
}

const JITTER_WINDOW_MS = 10 * 60 * 1000;

/**
 * A stable per-instance offset for the first update check.
 *
 * Co-hosted gateways restart together, so a fixed 5-minute first check put all
 * of them on the same millisecond forever: their checks landed 475ms apart and
 * the same instance lost the lock every single tick. Deriving the offset from
 * the instance's data dir de-phases them permanently and survives restarts.
 *
 * This is robustness, not the fix — the fix is that the lock loser converges
 * anyway (see convergence.js). Jitter only makes contention rare.
 */
export function instanceJitterMs(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % JITTER_WINDOW_MS;
}

export const DEFAULT_INTERVAL_HOURS = 6;
export const MIN_INTERVAL_HOURS = 1;

/**
 * N4-3: how long after a tick whose CI is still RUNNING — the only missing
 * answer that earns a retry — the next check runs. On a day of frequent merges
 * every regular tick could land mid-CI, and a box sat on an old sha for a whole
 * day (two ticks in a row skipped on a real paired box). A red verdict, a no-ci
 * origin, an unreadable GitHub answer, a quarantine or any other skip is a
 * verdict, not a missing answer — those still wait for the regular tick.
 */
export const CI_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * Per-instance offset added to a retry (instanceJitterMs, narrowed) so
 * co-hosted gateways do not all re-ask GitHub on the same second, while the
 * whole chain still fits inside the regular interval.
 */
export const CI_RETRY_JITTER_MS = 60 * 1000;

/**
 * The ONLY skip that means "ask again shortly": a CI run still in progress
 * (`ci-pending`) — the one case where waiting for the regular tick can leave a
 * box on an old sha for a whole day.
 *
 * `ci-unavailable` is deliberately absent. Every such skip increments
 * `auto_update_ci_unavailable_count`, and the third in a row rings the "updates
 * paused" bell (CI_UNAVAILABLE_FAILURE_TICKS). Retrying at 30 minutes would
 * turn that bell into "GitHub was unreachable for about an hour" instead of
 * "unreadable for three regular ticks" — a change to alert behaviour this item
 * must not make. `ci-gate-unavailable` is absent for the same reason: it IS the
 * third failed read, already a failure that rings the bell, and a retry would
 * only repeat it.
 */
export const CI_RETRY_SKIPS = Object.freeze(["ci-pending"]);

/**
 * Every string this module writes to `auto_update_last_result`, classified ONCE
 * so the Nest's Updates card reads this table instead of matching the free text
 * in a second place (audit N1c-1). First matching prefix wins.
 *
 *   ok        — the tick did what it should. The two "Tree pull skipped" cases
 *               are the co-hosted by-design ones: this gateway never pulls the
 *               shared checkout, and the INSTANCE half still converges.
 *   transient — the tick retries on its own. The card waits 2x the interval
 *               before calling it stuck, so a CI run in progress never reads as
 *               a broken updater.
 *   failure   — updates stop until someone acts.
 *
 * An unrecognised string is a failure (code "other"), never ok: a new message
 * must be added here rather than silently read as fine. tests/health-signals
 * checks that every literal this file writes is covered.
 */
export const UPDATE_RESULT_PREFIXES = Object.freeze([
  { prefix: "Updated ", kind: "ok", code: "updated" },
  { prefix: "Up to date", kind: "ok", code: "up-to-date" },
  { prefix: "Tree pull skipped: the checkout is read-only", kind: "ok", code: "tree-external" },
  { prefix: "Tree pull skipped: another instance holds the checkout lock", kind: "ok", code: "tree-locked" },
  { prefix: "Skipped: CI still running", kind: "transient", code: "ci-pending" },
  // N1c-5 follow-up (review S2): GitHub answered, but without our three
  // required checks — a fork without this repo's CI. Its own verdict, so the
  // card names the fork case and the escape hatch instead of claiming a build
  // is still running for days. Review round 2 split it in two: a fork that
  // carries SOME of the checks (nothing still running) is the same unverified
  // case as one that carries none, and it used to read "still running" forever.
  // Both prefixes name the distinguishing sentence, so neither can swallow
  // another `Skipped: origin/main …` message (the old prefix was the bare
  // `Skipped: origin/main (`) and the sha — an interpolation, and therefore
  // invisible to the coverage test — cannot hide the words.
  { prefix: "Skipped: origin/main has none of the required CI checks", kind: "transient", code: "no-ci" },
  { prefix: "Skipped: origin/main has only some of the required CI checks", kind: "transient", code: "no-ci" },
  // N1c-5: GitHub could not be asked at all. The first two ticks of an outage
  // are transient (it usually clears itself); the third is a failure, so the
  // operator hears about an updater that is paused indefinitely.
  { prefix: "Skipped: CI status could not be read", kind: "transient", code: "ci-unavailable" },
  { prefix: "Skipped: CI status unreadable for ", kind: "failure", code: "ci-gate-unavailable" },
  { prefix: "Skipped: branch changed mid-update", kind: "transient", code: "branch-changed" },
  { prefix: "Skipped: not on main", kind: "failure", code: "not-on-main" },
  { prefix: "Skipped: cannot determine branch", kind: "failure", code: "branch-unknown" },
  { prefix: "Skipped: CI is RED", kind: "failure", code: "ci-red" },
  { prefix: "Skipped: migration quarantined", kind: "failure", code: "migration-quarantined" },
  { prefix: "Skipped: update quarantined", kind: "failure", code: "update-quarantined" },
  { prefix: "Update rollback blocked", kind: "failure", code: "update-rollback-blocked" },
  { prefix: "Rolled back: ", kind: "failure", code: "update-rolled-back" },
  { prefix: "Fetch failed", kind: "failure", code: "fetch-failed" },
  { prefix: "Pull failed", kind: "failure", code: "pull-failed" },
  { prefix: "Update error", kind: "failure", code: "update-error" },
  { prefix: "Migration quarantined", kind: "failure", code: "migration-quarantined" },
  { prefix: "Migration failed", kind: "failure", code: "migration-failed" },
  { prefix: "init-db failed", kind: "failure", code: "init-db-failed" },
]);

/**
 * Classify one `auto_update_last_result` value.
 *
 * @param {string|null|undefined} result
 * @returns {null|{kind: "ok"|"transient"|"failure", code: string}} null when
 *   nothing has been recorded yet.
 */
export function classifyUpdateResult(result) {
  // Only the leading space is trimmed: "Updated " ends in one, and a real result
  // is "Updated <a> → <b>".
  const value = String(result ?? "").trimStart();
  if (!value.trim()) return null;
  const hit = UPDATE_RESULT_PREFIXES.find((entry) => value.startsWith(entry.prefix));
  return hit ? { kind: hit.kind, code: hit.code } : { kind: "failure", code: "other" };
}

let updateTimer = null;
let retryTimer = null;
/** Set by startAutoUpdate() while the scheduler runs: the retry delay/budget
 *  plan for the CURRENT interval. Null when auto-update is not armed. */
let retryPlan = null;
/** True while a scheduled tick (regular or retry) is in flight. A retry tick can
 *  spend minutes in `npm install` and the restart; without this the interval
 *  firing meanwhile would run a second checkForUpdates() alongside it. */
let scheduledTickRunning = false;
let db = null;

/**
 * Get auto-update settings from DB
 */
async function getSettings() {
  const defaults = {
    auto_update_enabled: "true",
    auto_update_interval_hours: String(DEFAULT_INTERVAL_HOURS),
    auto_update_last_check: null,
    auto_update_last_result: null,
    auto_update_result_since: null,
    auto_update_current_version: null,
    auto_update_latest_version: null,
  };

  if (!db) return defaults;

  try {
    const rows = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'auto_update_%'",
      args: [],
    });
    const settings = { ...defaults };
    for (const row of rows.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  } catch {
    return defaults;
  }
}

/**
 * Timer-tick wrapper: re-reads auto_update_enabled each tick so a UI disable
 * takes effect within one interval, no restart. The gate lives HERE and NOT
 * in checkForUpdates() — the manual "Check for updates now" settings action
 * calls checkForUpdates() directly and must work while auto-update is
 * disabled (that is the point of a manual button). getSettings() cannot
 * throw: on DB error it returns defaults (enabled:"true"), indistinguishable
 * from a fresh install, so a blip proceeds for that one tick — consistent
 * with the boot gate's identical defaulting; self-corrects next tick.
 * `check` is injectable for tests only.
 */
export async function tickCheck(check = checkForUpdates) {
  // A collection install runs N installs against one job and ends in a single
  // deferred restart. An auto-update pull+exit here would kill that runner
  // mid-flight (partial collection, lost summary). Manual Check-now stays
  // ungated — that's explicit operator intent.
  if (isInstallSetRunning()) {
    console.log("[auto-update] Skipping scheduled check — a collection install is in progress");
    return null;
  }
  const settings = await getSettings();
  if (settings.auto_update_enabled !== "true") {
    console.log("[auto-update] Skipping scheduled check — disabled in settings");
    return null;
  }
  return check();
}

/** Test-only: inject the module-level db handle without starting timers. */
export function _setDbForTest(database) {
  db = database;
}

/**
 * Test-only: the CI-retry delay (`null` restores the default). Also pins the
 * jitter to zero, so a suite asserts the retry COUNT and ordering instead of
 * clock arithmetic, and never waits real minutes.
 */
let _ciRetryDelayOverride = null;
export function _setCiRetryDelayForTest(ms) {
  _ciRetryDelayOverride = ms;
}

/**
 * Test-only: run one scheduled tick exactly as the timers do, so a suite can
 * drive the retry chain without waiting five minutes for the first check.
 * `kind` is "regular" (first check / interval) or "retry".
 */
export function _runScheduledTickForTest(kind = "regular") {
  return scheduledTick(kind);
}

/**
 * Test-only: the check a SCHEDULED tick runs (production uses checkForUpdates,
 * which pulls, installs and restarts). tickCheck()'s own parameter stays for
 * direct callers.
 */
let _scheduledCheckForTest = null;
export function _setScheduledCheckForTest(fn) {
  _scheduledCheckForTest = fn;
}

/** Test-only: whether a retry timer is pending right now. */
export function _retryPendingForTest() {
  return retryTimer !== null;
}

/**
 * Test-only: the interval the retry chain is bounded by (`null` restores the
 * real one). The 1 h minimum (MIN_INTERVAL_HOURS) makes the wall-clock edge
 * unreachable with an injected sub-second delay, so a test narrows the interval
 * instead of waiting an hour. Inert unless set.
 */
let _retryIntervalOverride = null;
export function _setRetryIntervalForTest(ms) {
  _retryIntervalOverride = ms;
}

function retryDelayMs() {
  if (_ciRetryDelayOverride !== null) return _ciRetryDelayOverride;
  const jitter = instanceJitterMs(retryPlan?.jitterKey ?? "") % CI_RETRY_JITTER_MS;
  return CI_RETRY_DELAY_MS + jitter;
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** The skip a tick reported, read from the RESULT (never from message text —
 *  those messages interpolate a sha and are classified elsewhere). */
function skipCode(result) {
  return result && typeof result === "object" && typeof result.skipped === "string"
    ? result.skipped
    : null;
}

/**
 * Arm ONE extra check ~30 min out after a tick whose CI is still running. Bounded
 * to ceil(interval / 30 min) - 1 retries, so the chain always ends before the
 * next regular tick; the wall-clock check repeats that bound with the jitter
 * included. At most one retry timer is ever pending.
 */
function scheduleCiRetry() {
  if (!retryPlan) return;
  const delay = retryDelayMs();
  const intervalMs = _retryIntervalOverride ?? retryPlan.intervalMs;
  if (retryPlan.used >= retryPlan.budget) return;
  if (Date.now() - retryPlan.startedAt + delay >= intervalMs) return;
  retryPlan.used += 1;
  clearRetryTimer();
  console.log(`[auto-update] CI result not known yet; checking again in ${Math.round(delay / 60000)} min`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // tickCheck reaches runMigrations, which CAN reject; an unhandled rejection
    // in this timer would take the gateway down (same reason as the first-check
    // timer). A rejected retry simply does not schedule another one — the
    // regular interval still runs.
    scheduledTick("retry").catch((e) => console.error("[auto-update] retry tick failed:", e.message));
  }, delay);
  // A pending retry must never be the only thing keeping the process alive.
  retryTimer.unref?.();
}

/**
 * The body of EVERY scheduled check: the first-delay timer, the interval, and
 * each CI retry. A retry goes through tickCheck(), so the disabled and
 * install-set guards still apply to it.
 */
async function scheduledTick(kind) {
  // Scheduler ticks never stack: a slow tick (npm install, restart) must not be
  // overlapped by the interval — or by a retry — firing meanwhile. The manual
  // Check-now path calls checkForUpdates() directly and is deliberately NOT
  // gated by this flag.
  if (scheduledTickRunning) {
    console.log("[auto-update] a check is already running; skipping this one");
    return null;
  }
  scheduledTickRunning = true;
  try {
    if (kind === "regular") {
      // A regular tick supersedes a pending retry and restarts the retry budget.
      clearRetryTimer();
      if (retryPlan) {
        retryPlan.used = 0;
        retryPlan.startedAt = Date.now();
      }
    }
    const result = _scheduledCheckForTest ? await tickCheck(_scheduledCheckForTest) : await tickCheck();
    if (CI_RETRY_SKIPS.includes(skipCode(result))) scheduleCiRetry();
    return result;
  } finally {
    scheduledTickRunning = false;
  }
}

/**
 * Save a setting to DB
 *
 * `auto_update_last_result` is the one key with a companion: every tick rewrites
 * `auto_update_last_check`, so the age of THAT value says nothing about how long
 * the current result has been repeating — a CI run still in progress stays
 * "fresh" forever (audit N1c-1 follow-up). `auto_update_result_since` records
 * when the current result's CLASSIFICATION CODE first appeared, and the Nest's
 * Updates card ages a transient result from it.
 */
const RESULT_KEY = "auto_update_last_result";
const RESULT_SINCE_KEY = "auto_update_result_since";

/**
 * Auto-update failure bell (audit N1c-2): the ntfy/email sends below are
 * unconfigured by default, so "updates have stopped" only ever reached the
 * Settings → Updates card. These two keys are the 24 h cooldown, stored the
 * way every other auto-update key is (dashboard_settings).
 */
export const UPDATE_NOTIFIED_CODE_KEY = "auto_update_notified_code";
export const UPDATE_NOTIFIED_AT_KEY = "auto_update_notified_at";
export const UPDATE_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Cause + action per classification code, keyed by exactly the codes
 * classifyUpdateResult() yields, so a result prefix can never become a silent
 * failure (`other` is the floor). The recorded result is quoted on top of this
 * only for the codes in RESULT_TEXT_IS_SAFE below — those are our own fixed
 * sentences — because `Pull failed: …` and `Update error: …` embed git/npm
 * stderr, which can hold paths and secrets, and a bell is pushed off-device.
 * The full result text always stays in Settings → Updates and the log.
 */
const UPDATE_FAILURE_TEXT = Object.freeze({
  "not-on-main": ["Crow updates stopped: not on the main branch", "The checkout is on another branch, so updates are skipped. Switch it back to main, then run Check for updates now."],
  "branch-unknown": ["Crow updates stopped: branch could not be read", "The checkout could not report its branch (a broken or shallow git checkout). Repair the checkout, then run Check for updates now."],
  "ci-red": ["Crow updates stopped: CI is red", "Updates are held back because the latest build failed its required tests. Retries continue on their own; once main is green again the next check deploys it."],
  // Transient in practice (it never rings: notifyUpdateFailure only reads the
  // failure codes' rows), but keep the map keyed by every code so a future kind
  // change cannot land on the `other` text.
  "no-ci": ["Crow updates held back: main is missing required CI checks", "GitHub answered for the newest commit on main but reported only some or none of the required checks (suite, static-checks, audit) and nothing still running — usually a fork that does not carry this repo's CI, or a push whose workflow has not started yet. The commit stays undeployed while that is the case; set CROW_UPDATE_CI_GATE=0 in the environment and restart Crow to update without the gate."],
  "ci-gate-unavailable": ["Crow updates paused: the CI result could not be read", "GitHub could not be asked whether the newest commit on main passed its required tests, so that commit stays undeployed for as long as the answers keep failing — Crow keeps retrying on every check. If this machine can never read GitHub's API, set CROW_UPDATE_CI_GATE=0 in the environment and restart Crow."],
  "migration-quarantined": ["Crow updates paused: migration quarantined", "A migration damaged data and was rolled back, so that commit is quarantined. Updates resume by themselves when a fix lands on main; after 3 attempts the quarantine marker files have to be deleted."],
  "fetch-failed": ["Crow updates stopped: fetch failed", "The updater could not reach the git remote. Check network access and the remote URL, then run Check for updates now."],
  "pull-failed": ["Crow updates stopped: pull failed", "The update could not be applied, usually because local changes overlap it. Resolve them, then run Check for updates now."],
  "update-error": ["Crow updates stopped: update error", "The updater hit an unexpected error. See Settings → Updates and the gateway log for the exact result, then run Check for updates now."],
  "migration-failed": ["Crow updates stopped: migration failed", "The database migration after the pull failed, so the restart was withheld and the previous code is still running. Read the log, then run node scripts/guarded-init-db.mjs."],
  "init-db-failed": ["Crow updates stopped: init-db failed", "Database setup after the pull failed, so the restart was withheld and the previous code is still running. Read the log, then run node scripts/guarded-init-db.mjs."],
  // Cause-neutral: the same code covers a commit whose code does not load and
  // one whose dependencies could not be installed. The recorded result quoted
  // above it names which of the two happened.
  "update-rolled-back": ["Crow rolled back an update that would not start", "The pulled commit was rolled back automatically because it could not be used — its code does not load, or its dependencies could not be installed — so the previous version is still running. The commit is quarantined: updates resume by themselves when main moves past it, and a machine-side cause (a failed install) also retries after a few hours."],
  "update-quarantined": ["Crow updates paused: a commit is quarantined", "The newest commit on main was rolled back because it would not start, so it is skipped. Fix forward on main and the next check deploys it; a rollback taken for a machine-side reason retries after a few hours."],
  // Never "was rolled back" here: a blocked rollback means the bad commit is
  // STILL checked out, and the next restart boots it. Cause-neutral too (S3):
  // a failed `npm install` blocks this path just as a commit that does not load
  // does, and neither "will not start" nor "fails to load" is true for it.
  "update-rollback-blocked": ["Crow updates paused: a commit that could not be used is still checked out", "The pulled commit could not be used — its code does not load, or its dependencies could not be installed — and could not be rolled back (local changes overlap it, or the previous commit could not be determined). The restart is withheld, but the checkout still holds that commit, so the next restart or reboot boots it. Move main back in the checkout with git reset --keep, then run Check for updates now."],
  other: ["Crow updates stopped: unrecognised result", "The updater recorded a result it cannot classify. See Settings → Updates for the exact text and the gateway log for the cause."],
});

/**
 * The startup-crash variant of `update-rolled-back` (S3).
 *
 * Two different events share that code: the Layer 0 paths (a tree whose code does
 * not load, a failed `npm install`) and a Layer 1 boot-guard rollback, whose
 * result text starts `Rolled back: <sha> crashed on startup N times`. The code's
 * cause-neutral text is wrong for the second one — the commit was rolled back
 * because the SERVICE crashed, not because its code fails to load — and when the
 * alert-spool write failed this row is the only thing the operator sees.
 */
const UPDATE_ROLLED_BACK_CRASH_TEXT = Object.freeze([
  "Crow rolled back an update that would not start",
  "The pulled commit crashed on startup, so it was rolled back automatically and the previous version is running again. The commit is quarantined: updates resume by themselves when main moves past it.",
]);

/**
 * Codes whose recorded result is OUR fixed sentence, with no captured command
 * output, so it can be quoted in the bell verbatim — the same words Settings
 * shows. Everything else (fetch/pull/update-error, and any future code that
 * lands on `other`) gets the table text only: those strings embed git/npm
 * stderr, which can hold paths and secrets (audit N1c-2).
 */
const RESULT_TEXT_IS_SAFE = new Set([
  "not-on-main", "ci-red", "ci-gate-unavailable", "migration-quarantined", "migration-failed",
  "init-db-failed", "update-rolled-back", "update-quarantined", "update-rollback-blocked",
]);

/**
 * Ring the in-app bell for a FAILURE result, at most once per code per 24 h.
 * ok / transient / skip-by-design results never ring. Never throws: this runs
 * inside every result write and must not cost the updater its bookkeeping.
 *
 * @param {string} value the `auto_update_last_result` value being recorded
 * @param {number} [nowMs] clock seam
 * @returns {Promise<object|null>} the notification row, or null when silent
 */
async function notifyUpdateFailure(value, nowMs = Date.now()) {
  try {
    if (!db) return null;
    const klass = classifyUpdateResult(value);
    if (!klass || klass.kind !== "failure") return null;

    let lastCode = null;
    let lastAt = null;
    try {
      const { rows } = await db.execute({
        sql: "SELECT key, value FROM dashboard_settings WHERE key IN (?, ?)",
        args: [UPDATE_NOTIFIED_CODE_KEY, UPDATE_NOTIFIED_AT_KEY],
      });
      lastCode = rows?.find((r) => r.key === UPDATE_NOTIFIED_CODE_KEY)?.value ?? null;
      lastAt = rows?.find((r) => r.key === UPDATE_NOTIFIED_AT_KEY)?.value ?? null;
    } catch { /* unreadable cooldown: notify rather than stay silent */ }
    const lastAtMs = Date.parse(lastAt || "");
    if (lastCode === klass.code && Number.isFinite(lastAtMs) && nowMs - lastAtMs < UPDATE_NOTIFY_COOLDOWN_MS) {
      return null; // same condition, already rung within the window
    }

    const [title, action] = (klass.code === "update-rolled-back" && /crashed on startup/i.test(typeof value === "string" ? value : "")
      ? UPDATE_ROLLED_BACK_CRASH_TEXT
      : UPDATE_FAILURE_TEXT[klass.code]) || UPDATE_FAILURE_TEXT.other;
    const recorded = typeof value === "string" ? value.trim().slice(0, 300) : "";
    const body = RESULT_TEXT_IS_SAFE.has(klass.code) && recorded ? `${recorded}\n\n${action}` : action;
    const { createNotification } = await import("../shared/notifications.js");
    const row = await createNotification(db, {
      type: "system",
      priority: "high",
      source: "auto-update",
      title,
      body,
      action_url: "/dashboard/settings?section=updates",
      metadata: { code: klass.code },
    });
    // Stamped even when the type is switched off: the operator's preference is
    // a choice, and re-attempting every tick would not deliver it either.
    await saveSetting(UPDATE_NOTIFIED_CODE_KEY, klass.code);
    await saveSetting(UPDATE_NOTIFIED_AT_KEY, new Date(nowMs).toISOString());
    return row;
  } catch (err) {
    console.warn(`[auto-update] failure notification skipped: ${err?.message}`);
    return null;
  }
}

/**
 * Record an `auto_update_last_result` value from OUTSIDE the tick. The boot guard
 * (scripts/boot-guard/crow-boot-guard.mjs, via boot-guard-state.js) rolls a
 * crash-looping commit back before any gateway process exists, so its result has
 * no tick to travel on. Routing it through saveSetting keeps the classification,
 * the result-since stamp and the failure bell identical to every other path.
 *
 * `notify:false` is for a result whose event already rang the bell — the boot
 * guard spools the same rollback into the alert spool, which the drain delivers
 * as a notification. One event, one row (F4); the caller only passes false when
 * the spool file really was written, so a failed spool keeps the bell.
 *
 * @returns {Promise<boolean>} whether it was actually written (false when no db
 *   handle exists, e.g. auto-update disabled on this instance — the caller must
 *   then retry on the next boot rather than mark the record done).
 */
export async function recordUpdateResult(value, { notify = true } = {}) {
  if (!db) return false;
  await saveSetting(RESULT_KEY, value, { notify });
  return true;
}

/** One dashboard_settings value, or null when there is no db handle / no row. */
async function readSettingValue(key) {
  if (!db) return null;
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?",
      args: [key],
    });
    return rows?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function saveSetting(key, value, { notify = true } = {}) {
  if (!db) return;
  try {
    if (key === RESULT_KEY) {
      await stampResultSince(value);
      // Every result write funnels through here, so the failure bell covers
      // each branch (including the migration-guard ones) without a per-branch
      // call to forget (audit N1c-2).
      if (notify) await notifyUpdateFailure(value);
    }
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [key, value, value],
    });
  } catch (err) {
    console.warn(`[auto-update] Failed to save ${key}:`, err.message);
  }
}

/**
 * Stamp `auto_update_result_since` ONLY when the result's classification code
 * changes; the same code repeating keeps the first stamp. A changed message
 * inside one code (`Skipped: not on main (on 'a')` → `…(on 'b')`, both
 * not-on-main) is the same condition and must not restart the clock.
 *
 * Runs BEFORE the new result is written, so the SELECT still sees the previous
 * one. When the previous value cannot be read, the code cannot be compared, so
 * the stamp is reset — an old `since` must never outlive the result it described
 * and turn into a false warn.
 */
async function stampResultSince(nextValue) {
  if (!db) return;
  let prev;
  let hasSince = false;
  try {
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key IN (?, ?)",
      args: [RESULT_KEY, RESULT_SINCE_KEY],
    });
    prev = rows?.find((r) => r.key === RESULT_KEY)?.value ?? null;
    hasSince = Boolean(rows?.find((r) => r.key === RESULT_SINCE_KEY)?.value);
  } catch {
    prev = undefined; // unreadable: cannot compare, so re-stamp rather than age
  }
  const codeOf = (v) => classifyUpdateResult(v)?.code ?? null;
  // An install already stuck on a result when this shipped has no stamp yet:
  // stamp it on the next tick, or its wait would never start aging.
  if (prev !== undefined && hasSince && codeOf(prev) === codeOf(nextValue)) return;
  const now = new Date().toISOString();
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [RESULT_SINCE_KEY, now, now],
    });
  } catch (err) {
    console.warn(`[auto-update] Failed to save ${RESULT_SINCE_KEY}:`, err.message);
  }
}

/**
 * Run a command and return { stdout, stderr, code }. The 120 s default suits the
 * updater's own git/npm work; a read-only caller passes its own (shorter)
 * timeout, and the npm installs below need minutes rather than two.
 */
function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: APP_ROOT, timeout: 120000, ...options }, (err, stdout, stderr) => {
      resolve({
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
        code: err ? err.code || 1 : 0,
      });
    });
  });
}

const LOCK_STALE_MS = 30 * 60 * 1000;
/**
 * Every git command this module runs on the live checkout disables hooks and
 * fsmonitor. Live installs point `core.hooksPath` INTO the tree, so a `pull`,
 * `fetch` or `merge` would otherwise run the INCOMING commit's own hooks as the
 * updater's user — before any of the checks below has seen the sha (S10). One
 * helper prefixes the flags, so no call site can forget them.
 */
const GIT_HOOKS_OFF = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * Run git in this checkout with hooks and fsmonitor off. Exported for the Nest's
 * Integrity card, which reads the SAME tree the updater pulls into — a plain
 * `git` would run a live install's own hooks, which is the thing GIT_HOOKS_OFF
 * exists to prevent.
 */
export function git(args, options = {}) {
  return run("git", [...GIT_HOOKS_OFF, ...args], options);
}
/** acquireCheckoutLock's return for a read-only tree: observed free, not held. */
const OBSERVED_SUFFIX = "#observed";

async function lockPath(cwd) {
  const dir = await gitDirFor(cwd);
  if (!dir) return null; // not a git checkout → no lock possible
  return join(dir, "crow-auto-update.lock");
}

/**
 * The checkout's ABSOLUTE git dir, or null.
 *
 * `--absolute-git-dir`, never `--git-common-dir`: the checkout lock and the
 * update quarantine marker are per-checkout state and must sit together in the
 * one directory both co-hosted instances resolve identically.
 */
export async function gitDirFor(cwd = null) {
  const r = await git(["rev-parse", "--absolute-git-dir"], cwd ? { cwd } : {});
  return r.code === 0 && r.stdout ? r.stdout : null;
}

function readLock(path) {
  try {
    const [pidLine, tsLine] = readFileSync(path, "utf8").split("\n");
    let mtimeMs = NaN;
    try { mtimeMs = statSync(path).mtimeMs; } catch {}
    return { pid: parseInt(pidLine, 10), ts: Date.parse(tsLine || ""), mtimeMs };
  } catch { return null; }
}

/** A lock file with no pid yet is being written (wx create, then write): young = held. */
const LOCK_WRITE_GRACE_MS = 5000;

function lockIsStale(info) {
  if (!info) return true;
  if (!Number.isFinite(info.pid)) {
    return !(Number.isFinite(info.mtimeMs) && Date.now() - info.mtimeMs < LOCK_WRITE_GRACE_MS);
  }
  let alive = true;
  // EPERM: the pid exists but belongs to another user, so it is alive.
  try { process.kill(info.pid, 0); } catch (e) { alive = !!(e && e.code === "EPERM"); }
  const old = !Number.isFinite(info.ts) || Date.now() - info.ts > LOCK_STALE_MS;
  return !alive || old; // reclaim on (dead PID) OR (age>30min) — a wedged live updater must not block forever
}

/**
 * Is the checkout pulled by someone else? True when CROW_AUTO_UPDATE_TREE is
 * "external", or when this process cannot write the git dir (a hardened
 * co-hosted gateway that sees the shared checkout through a read-only bind:
 * ProtectHome= + BindReadOnlyPaths=). Such a gateway never pulls and never
 * takes the checkout lock; it only observes the lock and converges onto
 * whatever the tree holds (queue item 19, migration step 1).
 */
export async function treeIsExternal(cwd = null) {
  if (String(process.env.CROW_AUTO_UPDATE_TREE || "").trim().toLowerCase() === "external") return true;
  const lock = await lockPath(cwd);
  if (!lock) return false;
  try {
    accessSync(dirname(lock), fsConstants.W_OK);
    return false;
  } catch (err) {
    return err.code === "EROFS" || err.code === "EACCES" || err.code === "EPERM";
  }
}

/** Returns the lock file path on success, null when another updater holds it. */
function acquireLock(path) {
  // Sweep crash-orphaned quarantine files older than the staleness window.
  try {
    const dir = dirname(path);
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(basename(path) + ".stale.")) continue;
      const full = join(dir, f);
      try { if (Date.now() - statSync(full).mtimeMs > LOCK_STALE_MS) unlinkSync(full); } catch {}
    }
  } catch {}
  const body = `${process.pid}\n${new Date().toISOString()}\n`;
  try {
    writeFileSync(path, body, { flag: "wx" });
    return path;
  } catch (err) {
    if (err.code !== "EEXIST") return null;
  }
  const info = readLock(path);
  if (!lockIsStale(info)) return null; // live young holder → skip
  // Atomic reclaim: rename-quarantine — exactly one winner among reclaimers
  // racing the SAME stale inode (rename is NOT compare-and-swap; the lapping
  // residual is accepted in the spec with named backstops).
  const quarantine = `${path}.stale.${process.pid}`;
  try { renameSync(path, quarantine); } catch { return null; } // ENOENT = lost the race
  try { unlinkSync(quarantine); } catch {}
  try {
    writeFileSync(path, body, { flag: "wx" });
    return path;
  } catch { return null; } // a third party acquired meanwhile
}

/** Owner-checked release: never unlink a lock we no longer own. */
function releaseLock(path) {
  try {
    const info = readLock(path);
    if (info && info.pid === process.pid) unlinkSync(path);
  } catch {}
}

/**
 * Acquire the checkout lock, waiting for a holder to finish.
 *
 * The instance half needs this: the lock-loss path is reached ONLY while
 * another co-hosted gateway holds the lock, i.e. while it is between `git pull`
 * and its `npm install --omit=dev` (up to 5 minutes of rewriting the SHARED
 * node_modules) and its init-db. Converging and restarting into that window
 * boots a gateway against a half-written dependency tree.
 *
 * Returns the lock path on success, or null if it could not be acquired within
 * `waitMs` — in which case the caller must NOT converge; it retries next tick.
 */
export async function acquireCheckoutLock({ appRoot = null, waitMs = 6 * 60 * 1000, pollMs = 2000 } = {}) {
  // Resolve against the caller's root, not the module's APP_ROOT: convergence
  // is handed an explicit appRoot, and waiting on a lock for a DIFFERENT tree
  // would silently defeat the serialization.
  const lock = await lockPath(appRoot);
  if (!lock) return null;
  const deadline = Date.now() + waitMs;
  // A read-only (externally pulled) tree cannot take the lock, only observe
  // it: proceed once no live, young holder exists. The return carries
  // OBSERVED_SUFFIX, so releaseCheckoutLock() never removes it.
  const observeOnly = await treeIsExternal(appRoot);
  for (;;) {
    if (observeOnly) {
      // A lock that exists but cannot be read (another user's 0600 file) is held:
      // fail closed, never proceed into a pull that may be mid-write.
      const info = existsSync(lock) ? readLock(lock) : null;
      if (!existsSync(lock) || (info && lockIsStale(info))) return lock + OBSERVED_SUFFIX;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const held = acquireLock(lock);
    if (held) return held;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function releaseCheckoutLock(path) {
  // An observed (never held) lock is not ours to remove, whoever holds it now.
  if (path && !path.endsWith(OBSERVED_SUFFIX)) releaseLock(path);
}

/** Test-only: the lock primitives, unit-tested directly (they are not
 *  exported for production use — checkForUpdates()/runLockedUpdate() are the
 *  real callers). */
export const _lockPrimitivesForTest = { acquireLock, releaseLock, lockIsStale };

/**
 * Check for and apply updates
 * Returns { updated, from, to, error, skipped?, message?, branch? }
 */
export async function checkForUpdates({ instance = null } = {}) {
  const log = (msg) => console.log(`[auto-update] ${msg}`);
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.code !== 0 || branch.stdout !== "main") {
      const msg = branch.code !== 0
        ? `Skipped: cannot determine branch (${branch.stderr || "not a git checkout"})`
        : `Skipped: not on main (on '${branch.stdout}')`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "not-on-main", branch: branch.stdout, message: msg };
    }
    let treeResult = { updated: false };
    let pulled = false;
    const external = await treeIsExternal();
    const lock = external ? null : await lockPath();
    const held = lock ? acquireLock(lock) : null;

    if (external) {
      // Hardened co-hosted gateway: the shared checkout is read-only here and
      // another gateway pulls it. Skip the TREE half (no fetch, no lock) and
      // still run the INSTANCE half below.
      const msg = "Tree pull skipped: the checkout is read-only for this instance (a co-hosted gateway pulls it)";
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      treeResult = { updated: false, skipped: "read-only", message: msg };
      try {
        const om = await git(["rev-parse", "--short", "origin/main"]);
        if (om.code === 0 && om.stdout) await saveSetting("auto_update_latest_version", om.stdout);
      } catch {}
    } else if (lock && !held) {
      // NOT an error, and NOT a reason to stop. The tree is shared: another
      // co-hosted gateway is pulling it, which is exactly right. This instance
      // skips the PULL and still converges itself below. Before this split it
      // returned here — and since co-hosted gateways restart together, their
      // timers are phase-locked and the same instance lost every tick forever,
      // never migrating its own stores and never restarting into the new code.
      const info = readLock(lock);
      const msg = `Tree pull skipped: another instance holds the checkout lock (pid ${info?.pid ?? "unknown"})`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      treeResult = { updated: false, skipped: "locked", message: msg };

      // Record what the tree is moving to even though we did not pull it.
      // auto_update_latest_version is otherwise written ONLY inside
      // runLockedUpdate, which the loser never enters — which is exactly why
      // the primary's latest_version sat 16 commits BEHIND its own current
      // while last_result read "another updater is running". The holder has
      // just fetched, so origin/main is fresh.
      try {
        const om = await git(["rev-parse", "--short", "origin/main"]);
        if (om.code === 0 && om.stdout) await saveSetting("auto_update_latest_version", om.stdout);
      } catch {}
    } else {
      try {
        treeResult = await runLockedUpdate(log);
      } finally {
        if (held) releaseLock(held);
      }
      pulled = Boolean(treeResult?.updated);
    }

    // A process must honor its OWN refusal. runLockedUpdate returns
    // converge:false on every branch whose whole purpose is to withhold the
    // restart (a quarantined sha or migration, a blocked rollback, a branch that
    // changed mid-update); a peer may still converge (it refused nothing, and the
    // quarantine markers guard the genuinely-bad shas), but this process must not
    // restart into code it just declined. Its own skip code is kept
    // (`update-rollback-blocked`, `not-on-main`, …) — Settings and the bell
    // classification key off it. The CI gate deliberately does NOT set it: red
    // or pending CI (or an unreadable CI answer, N1c-5) refuses the NEXT commit
    // on main, not the tree already checked out, so a co-hosted peer must still
    // converge onto that tree.
    if (treeResult?.converge === false) {
      log("instance half skipped — this process's own update refused a restart");
      return { ...treeResult, pulled, converged: false, skipped: treeResult.skipped ?? "refused" };
    }

    // The INSTANCE half — for every gateway, lock or no lock. APP_ROOT is
    // passed explicitly: convergence's own fallback resolves from
    // import.meta.url, which is the real worktree even under a test fixture.
    const { convergeInstance } = await import("./convergence.js");
    const conv = await convergeInstance({ appRoot: APP_ROOT, instance, pulled, log });
    return { ...treeResult, pulled, converged: conv.converged, applied: conv.applied };
  } catch (err) {
    const msg = `Update error: ${err.message}`;
    console.error(`[auto-update] ${msg}`);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg };
  }
}

// Migration-quarantine re-alert cooldown (mirrors the audit-breaker pattern).
const QUARANTINE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let _quarantineAlertAt = 0;

// ---------------------------------------------------------------------------
// A5: CI gate — never pull a commit whose required CI is red or still running,
// and never pull one whose CI cannot be verified at all (N1c-5: a GitHub outage
// used to read as "not GitHub" and deploy the unverified sha).
// Q6 gates merges; this gates DEPLOYS (a direct admin push to main previously
// reached every instance within 6h regardless of CI state).
// ---------------------------------------------------------------------------

// classifyCheckRuns lives in shared/ci-check-runs.js (the satellite agent reuses it without
// loading this module); re-exported here unchanged.
export { classifyCheckRuns };

let _ciVerdictOverride = null;
/** Test hook: force the CI-gate verdict (fixture repos have non-GitHub
 *  remotes, so the real path answers "not-applicable"). */
export function _setCiVerdictForTest(v) { _ciVerdictOverride = v; }

let _ciFetch = null;
/** Test hook: replace the GitHub request, so the REAL resolveCiVerdict's failure
 *  mapping (503/403/timeout/bad JSON) is exercised without a network. */
export function _setCiFetchForTest(fn) { _ciFetch = fn; }

let _ciRemoteUrl = null;
/** Test hook: pretend `git remote get-url origin` printed this URL. A fixture
 *  origin has to stay a LOCAL bare repo for git to fetch it, and a local path
 *  containing `github.com/o/r` is exactly what parseGithubRemote (correctly)
 *  refuses, so the GitHub case is driven through this seam instead. */
export function _setCiRemoteUrlForTest(url) { _ciRemoteUrl = url; }

// Consecutive unreadable-CI ticks before the recorded result becomes a FAILURE
// (which is what rings the bell; its 24 h per-code cooldown prevents spam).
export const CI_UNAVAILABLE_FAILURE_TICKS = 3;
export const CI_UNAVAILABLE_COUNT_KEY = "auto_update_ci_unavailable_count";
export const CI_GATE_SETTING_KEY = "auto_update_ci_gate";

/**
 * Resolve the CI verdict for the sha the pull would land on.
 *
 * Five outcomes, and the difference between the last three is the whole point of
 * N1c-5 (plus review S2's no-ci):
 *   "green"/"red"/"pending" — GitHub answered.
 *   "not-applicable"        — the origin is NOT GitHub, so there is no CI to ask
 *                             and the gate can never apply: the tick proceeds.
 *   "unavailable"           — the origin IS GitHub and the answer could not be
 *                             read (network error, timeout, 403/429, any other
 *                             non-200, bad JSON). An unverified sha must not
 *                             deploy during an outage, so the tick skips.
 *   "no-ci"                — GitHub answered and carries none of our three
 *                             required checks (review S2). Never green, and its
 *                             own sentence: a fork without this repo's CI is not
 *                             a build that is still running. Review round 2:
 *                             the same for a fork carrying only SOME of them
 *                             once nothing is still running.
 *
 * The origin is parsed by the shared parseGithubRemote (review S1): the old
 * substring regex read a local path containing `github.com/o/r` as GitHub and
 * missed `ssh://git@ssh.github.com:443/o/r.git`, a trailing slash and an
 * uppercase host — and a miss means not-applicable, i.e. deploy unverified.
 *
 * classifyCheckRuns' own "unknown" (a payload carrying no run for our three
 * contexts) becomes "no-ci": unverified is never green, and retrying it is what
 * resolves a push race on the next tick. A GitHub origin that strips our CI now
 * reads as that instead of deploying unverified code; CROW_UPDATE_CI_GATE=0 is
 * the way out of it.
 *
 * One unauthenticated call per update tick — far under the anonymous limit.
 * `?per_page=100` (review S3): the default page of 30 could truncate a commit
 * with more runs, and a missing context now reads as pending forever.
 */
async function resolveCiGate(remoteUrl, sha) {
  if (_ciVerdictOverride) return { verdict: _ciVerdictOverride, missing: [] };
  const remote = parseGithubRemote(remoteUrl);
  if (!remote) return { verdict: "not-applicable", missing: [] };
  const doFetch = _ciFetch || ((...a) => fetch(...a));
  try {
    const resp = await doFetch(
      `https://api.github.com/repos/${remote.owner}/${remote.repo}/commits/${sha}/check-runs?per_page=100`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "crow-auto-update" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!resp.ok) return { verdict: "unavailable", missing: [] };
    // json() throwing (a rate-limit HTML page, a truncated body) lands in the
    // catch below, which is exactly where an unreadable answer belongs.
    const payload = await resp.json();
    const verdict = classifyCheckRuns(payload);
    const missing = missingCiContexts(payload);
    // Review round 2: "pending" has two shapes. Something still running means
    // the next tick may really see it finish — keep waiting. Nothing running
    // and a required context with NO run at all means nothing more is coming on
    // this origin (a fork that carries only some of our workflows), which is the
    // same unverifiable case as a payload with none of them: no-ci, with its own
    // "only some" sentence. The satellite stays green-only either way.
    const settledPartial = verdict === "pending" && missing.length > 0
      && ciGateRuns(payload).every((r) => r.status === "completed");
    if (verdict === "unknown" || settledPartial) return { verdict: "no-ci", missing };
    return { verdict, missing: [] };
  } catch {
    return { verdict: "unavailable", missing: [] };
  }
}

/**
 * The verdict alone — the shape the tick (and its tests) speak. The detail that
 * only the no-ci sentence needs comes from resolveCiGate.
 *
 * @returns {Promise<string>}
 */
async function resolveCiVerdict(remoteUrl, sha) {
  return (await resolveCiGate(remoteUrl, sha)).verdict;
}

/** Test-only: the real resolver, so the failure mapping can be exercised
 *  directly (the tick itself needs a git origin it can actually fetch). */
export const _resolveCiVerdictForTest = resolveCiVerdict;

// ---------------------------------------------------------------------------
// Layer 0 rollback (audit N1c-3): a pulled sha that does not load, or whose
// init-db failed without advancing the schema, is rolled back HERE, inside the
// old healthy process, before anything restarts into it.
// ---------------------------------------------------------------------------

let _importCheckImpl = null;
/** Test-only: force the import-check verdict (the timeout branch is produced by
 *  runImportCheck, which is exercised directly). */
export function _setImportCheckForTest(fn) { _importCheckImpl = fn; }

async function pulledTreeImportCheck() {
  if (_importCheckImpl) return _importCheckImpl();
  return checkTreeImport({ appRoot: APP_ROOT });
}

/**
 * `reset --keep`, never `--hard`: an overlapping tracked change makes git
 * REFUSE instead of destroying it, and the refusal is reported to the operator
 * as `update-rollback-blocked`. There is deliberately no blanket tracked-WIP
 * guard on this path (B3) — `--keep` is the guard.
 *
 * Hooks are disabled: live installs point core.hooksPath INTO the tree, so the
 * pulled sha's own hooks would otherwise run as the updater's user (S10).
 */
function resetKeep(previous) {
  return git(["reset", "--keep", previous]);
}

/**
 * Write the update quarantine, move the checkout back, put the deps back.
 *
 * The marker is written FIRST: a crash between the two must still leave the
 * record that stops every co-hosted instance from re-pulling the same sha.
 *
 * A previous sha that is not a full 40-hex commit is refused before any git
 * write: `reset --keep ""` fails with a message about overlapping local changes
 * and would blame the wrong thing (and a short sha could name the wrong
 * commit).
 *
 * `depsRestored` says what happened to node_modules: `true` when the reinstall
 * ran and succeeded, `false` when it RAN AND FAILED (the tree is back on the
 * previous commit but node_modules may hold a half-written tree, so the next
 * restart would boot it on the wrong dependencies), `null` when it never ran.
 *
 * A blocked rollback (nothing was reset) re-writes the marker as HELD (`held`,
 * no expiry): the checkout is still on the bad sha, so a TTL there would let the
 * next tick time out into "Up to date" with the commit still checked out. That
 * exemption ends with the checkout: once HEAD is no longer the marker's sha (the
 * operator moved main back), the evaluator gives a transient reason its TTL back.
 * A rollback that DID move the tree back writes an ordinary marker, so an
 * operator who later pulls that same commit by hand (after fixing the registry)
 * is not frozen out by it.
 *
 * @returns {Promise<{ok:boolean, marker:object|null, detail:string,
 *   depsRestored:boolean|null, blockedBy?:"reset-refused"|"no-previous"}>}
 */
async function quarantineAndRollBack({ gitDir, sha, previous, reason, depsChanged, log = () => {} }) {
  const marker = writeUpdateQuarantine({ gitDir, sha, previous, reason });
  if (!marker) log(`could not write the update quarantine marker for ${String(sha).slice(0, 9)}`);
  // Nothing was reset, so the checkout still holds the refused sha: make the
  // marker HELD and permanent whatever its reason was (S2). A machine-side
  // reason keeps its TTL only for a rollback that actually moved the tree back.
  const blocked = (blockedBy, detail) => {
    if (!writeUpdateQuarantine({ gitDir, sha, previous, reason, persist: true })) {
      log(`could not re-write the update quarantine marker for ${String(sha).slice(0, 9)} as held`);
    }
    return { ok: false, blockedBy, marker, detail, depsRestored: null };
  };
  if (!FULL_SHA_RE.test(String(previous || ""))) {
    log(`not resetting: the previous commit is not a full sha (${JSON.stringify(previous || "")})`);
    return blocked("no-previous", "the checkout's own HEAD could not be resolved to a full commit sha");
  }
  const reset = await resetKeep(previous);
  if (reset.code !== 0) {
    return blocked("reset-refused", reset.stderr || `git reset --keep exited ${reset.code}`);
  }
  let depsRestored = null;
  if (depsChanged) {
    // node_modules now hold the pulled sha's tree; the running code needs its own.
    const npmResult = await run("npm", ["install", "--omit=dev"], { timeout: 300000 });
    if (npmResult.code !== 0) {
      log(`npm install failed after the rollback (exit ${npmResult.code}): ${String(npmResult.stderr || "").slice(-400)}`);
      depsRestored = false;
    } else {
      depsRestored = true;
    }
  }
  return { ok: true, marker, detail: "", depsRestored };
}

/**
 * The one clause every Layer 0 rollback appends when its OWN `npm install`
 * failed. The old code silently left it in the log, so the result and the bell
 * claimed the previous commit was "still running with its own dependencies
 * reinstalled" — the next restart would have booted a half-written
 * `node_modules` against the last healthy commit, which the boot guard cannot
 * refuse (that commit IS the healthy one).
 */
const DEPS_NOT_RESTORED =
  "its dependencies could not be reinstalled — run npm install --omit=dev in the checkout before the next restart";

/** `"; …"` when the rollback's reinstall ran and failed, nothing otherwise. */
function depsRestoredClause(depsRestored) {
  return depsRestored === false ? `; ${DEPS_NOT_RESTORED}` : "";
}

/**
 * The Layer 0 rollback, shared by both "the pulled tree cannot be used" paths
 * (the import check and a failed `npm install`): quarantine the sha, move the
 * checkout back, and turn the outcome into this tick's result, bell and return
 * value, so the two paths cannot drift into different wording or a different
 * blocked-result shape.
 *
 * `cause` completes one clause of OUR own sentence ("fails to load
 * (import-check)", "— npm install failed"), never command output, so the
 * recorded result stays quotable in the bell. `next(rolled)` says what happens
 * to the sha afterwards (the marker's own TTL is part of it); `bell` is the
 * sentence for the notification — a string, or a function of `rolled` when it
 * depends on whether the previous commit's deps actually came back (S1).
 *
 * @returns {Promise<{updated:false, error:string, converge:false,
 *   rolledBack?:true, blocked?:true, sha:string}>}
 */
async function rollBackUnusableUpdate({
  gitDir, sha, previous, reason, cause, next, bell, depsChanged = false, log = () => {},
}) {
  const bad = String(sha).slice(0, 9);
  const good = FULL_SHA_RE.test(String(previous || "")) ? String(previous).slice(0, 9) : "the previous commit";
  const rolled = await quarantineAndRollBack({ gitDir, sha, previous, reason, depsChanged, log });
  if (!rolled.ok) {
    // `reset --keep` refused (local changes overlap the rollback), or the
    // previous sha could not be resolved: nothing was reset. The marker stays
    // (the sha is bad whatever the checkout does), the restart is withheld,
    // and the operator is told which of the two happened (B3).
    const because = rolled.blockedBy === "no-previous"
      ? `${good} could not be determined, so nothing was reset`
      : "local changes overlap it";
    const msg = `Update rollback blocked: ${bad} ${cause} and the checkout could not be reset to ${good} — ${because}; restart withheld`;
    log(msg);
    // One event, one bell: the result write below rings notifyUpdateFailure,
    // and the DB is healthy on this path, so no spool file (see fireUpdateAlert).
    await fireUpdateAlert({
      code: "update-rollback-blocked",
      title: "Crow updates paused: a commit that could not be used is still checked out",
      body: `The update to ${bad} ${cause} and the checkout could not be reset to ${good} because ${because} (${String(rolled.detail).slice(0, 200)}). It is quarantined, so it is not pulled again, but it is still checked out — the next restart boots it. Move main back in the checkout, then run Check for updates now.`,
    }, { spool: false });
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg, converge: false, blocked: true, sha };
  }
  // The previous code is back on disk. init-db NEVER ran, so the schema
  // question does not arise; the marker stops a re-pull. The deps are only
  // claimed back when the reinstall actually succeeded (S1).
  const depsNote = depsRestoredClause(rolled.depsRestored);
  const msg = `Rolled back: ${bad} ${cause}; running ${good}; ${next(rolled)}${depsNote}`;
  log(msg);
  // `bell` may be a function of the rollback outcome: whether node_modules hold
  // the old tree is only known after it ran.
  const bellText = (typeof bell === "function" ? bell(rolled) : String(bell || "")).replace(/\.+\s*$/, "");
  await fireUpdateAlert({
    code: "update-rolled-back",
    title: "Crow rolled back an update that would not start",
    body: `${bellText}${depsNote}.`,
  }, { spool: false });
  await saveSetting("auto_update_last_check", new Date().toISOString());
  await saveSetting("auto_update_last_result", msg);
  return { updated: false, error: msg, converge: false, rolledBack: true, sha };
}

/**
 * Are `scripts/init-db.js` byte-identical between two commits? Compared as blob
 * shas (`git rev-parse <sha>:path`), never by running anything from either tree.
 *
 * A changed init-db may rebuild or drop tables on DB SHAPE rather than on the
 * generation number, so a failed run of it says nothing about whether the old
 * code can still read the store (B1, plan S8).
 */
async function initDbUnchanged({ previous, pulled }) {
  if (!FULL_SHA_RE.test(String(previous || "")) || !FULL_SHA_RE.test(String(pulled || ""))) return false;
  const blobAt = async (sha) => (await git(["rev-parse", `${sha}:scripts/init-db.js`])).stdout;
  const before = await blobAt(previous);
  if (!before) return false; // unknown is never "unchanged"
  return before === await blobAt(pulled);
}

/**
 * L0.5: init-db failed. Quarantine the sha and roll the code back — but only
 * when NOTHING about the new tree can have reached the database. All four must
 * hold (B1):
 *   - the run was not a generation crossing;
 *   - `scripts/init-db.js` is byte-identical in both commits;
 *   - the DB is still readable after the failure;
 *   - `user_version` did not advance.
 *
 * Otherwise the tree is left where it is. Rolling old code onto a store the new
 * code already half-rebuilt is worse than the crash the rollback avoids: the
 * guard does NOT restore the backup on a non-zero exit, and the old code would
 * boot without re-running init-db because the stamp already matches its
 * generation.
 *
 * The result text is unchanged either way; the marker is what makes the NEXT
 * tick say "update quarantined" instead of "Up to date".
 *
 * @returns {Promise<{rolledBack:boolean, blocked:boolean, reason?:string, detail?:string}>}
 */
async function rollBackAfterInitDbFailure({
  gitDir, sha, previous, depsChanged, preState, newGeneration, postState, log = () => {},
}) {
  const from = Number(preState?.userVersion ?? 0);
  const refusals = [];
  if (newGeneration != null && from < Number(newGeneration)) {
    refusals.push(`the pull crosses a schema generation (${from} -> ${newGeneration})`);
  }
  if (!(await initDbUnchanged({ previous, pulled: sha }))) {
    refusals.push("scripts/init-db.js changed in the pull");
  }
  if (!postState?.readable) {
    refusals.push("the database could not be read after the failure");
  }
  if (schemaVersionAdvanced(preState, postState)) {
    refusals.push(`user_version advanced (${from} -> ${Number(postState?.userVersion ?? 0)})`);
  }
  if (refusals.length) {
    const reason = refusals.join("; ");
    log(`init-db failed — the tree is NOT rolled back: ${reason}`);
    return { rolledBack: false, blocked: false, reason };
  }
  const rolled = await quarantineAndRollBack({ gitDir, sha, previous, reason: "init-db-failed", depsChanged, log });
  if (!rolled.ok) {
    await fireUpdateAlert({
      code: "update-rollback-blocked",
      title: "Crow updates paused: rollback blocked",
      body: `init-db failed after the update to ${String(sha).slice(0, 9)} and the checkout could not be reset to ${String(previous).slice(0, 9)} (${String(rolled.detail).slice(0, 200)}). It is quarantined; fix the checkout by hand, then restart the gateway.`,
    });
    return { rolledBack: false, blocked: true, detail: rolled.detail, depsRestored: null };
  }
  log(`Rolled the checkout back to ${String(previous).slice(0, 9)} and quarantined ${String(sha).slice(0, 9)} (init-db failed, schema unchanged).`);
  return { rolledBack: true, blocked: false, depsRestored: rolled.depsRestored };
}

/**
 * The init-db failure alert, saying exactly what happened. The old text promised
 * "the next restart will retry via the boot gate" even after the tree had been
 * reset, where the next restart boots the PREVIOUS code (B1).
 */
function initDbFailureAlertBody({ exitCode, rollback, pulledSha, previousSha }) {
  const bad = String(pulledSha).slice(0, 9);
  const good = FULL_SHA_RE.test(String(previousSha || "")) ? String(previousSha).slice(0, 9) : "the previous commit";
  const head = `init-db exited ${exitCode} after pulling an update. `;
  // S1: the rollback's own reinstall may be what failed — say so instead of
  // letting the operator restart onto a half-written node_modules.
  const deps = rollback.depsRestored === false
    ? ` ${DEPS_NOT_RESTORED.charAt(0).toUpperCase()}${DEPS_NOT_RESTORED.slice(1)}.`
    : "";
  const tail = " Check the log, then run `node scripts/guarded-init-db.mjs`.";
  if (rollback.rolledBack) {
    return head + `The checkout was rolled back to ${good} and ${bad} is quarantined, so updates resume by themselves when ` +
      `main moves past it. The next restart boots ${good}, not ${bad}.` + deps + tail;
  }
  if (rollback.blocked) {
    return head + `The checkout could not be reset to ${good} (${String(rollback.detail || "git refused").slice(0, 200)}), ` +
      `so it is still at ${bad} and the restart is withheld; ${bad} is quarantined. The next restart boots ${bad}.` + tail;
  }
  return head + `The tree was left at ${bad} (${rollback.reason || "the schema may have changed"}), so the gateway keeps ` +
    `running the previous code and the next restart will retry via the boot gate.` + tail;
}

/** Did init-db move the schema generation forward? If it did, the old code may
 *  not understand the store, so the tree is left where it is (L0.5). */
function schemaVersionAdvanced(pre, post) {
  return Number(post?.userVersion ?? 0) > Number(pre?.userVersion ?? 0);
}

/**
 * A loud alert through the SAME rails the migration guard uses: the instance's
 * alert spool (drained into the in-app bell once the DB is up) plus ntfy/email.
 * Never throws.
 *
 * `spool:false` is for the auto-update rollback paths: there the DB is fine, so
 * the classified result write already rings the in-app bell through
 * notifyUpdateFailure — a spool file would ring the SAME event a second time.
 * The spool is kept only where the DB itself may be broken (the init-db
 * failure branches).
 */
async function fireUpdateAlert(payload, { spool = true } = {}) {
  try {
    const { fireMigrationAlert } = await import("../shared/migration-guard.js");
    await fireMigrationAlert({ ...payload, spool });
  } catch (err) {
    console.warn(`[auto-update] alert failed: ${err?.message}`);
  }
}

/** The mutating sequence; exported ONLY as the test seam for the under-lock
 *  branch re-check (spec D3b — the outer guard would abort a branch fixture
 *  before the lock). */
export async function runLockedUpdate(log = (m) => console.log(`[auto-update] ${m}`)) {
  // Get current version
  const currentRef = await git(["rev-parse", "--short", "HEAD"]);
  const currentVersion = currentRef.stdout;
  // Full sha alongside the short one: the quarantine marker and `reset --keep`
  // both need 40 hex (a prefix would name a different commit).
  const currentFullSha = (await git(["rev-parse", "HEAD"])).stdout;
  const gitDir = await gitDirFor();

  // Fetch latest from remote
  log("Checking for updates...");
  const fetchResult = await git(["fetch", "--quiet", "origin", "main"]);
  if (fetchResult.code !== 0) {
    const msg = `Fetch failed: ${fetchResult.stderr}`;
    log(msg);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg };
  }

  // A3 migration quarantine — evaluated UNDER the lock, after the fetch, so
  // both the 6h tick and the manual "Check now" button (which also lands here)
  // consult it with origin/main's fresh head sha, and co-hosted gateways
  // can't race the marker. A quarantined sha is never re-pulled; the marker
  // auto-clears when main moves (attempts-capped).
  try {
    const originHead = await git(["rev-parse", "origin/main"]);
    const { evaluateQuarantine, resolveGuardDbPath } = await import("../shared/migration-guard.js");
    const { resolveDataDir } = await import("../db.js");
    const q = evaluateQuarantine({
      appRoot: APP_ROOT,
      dbPath: resolveGuardDbPath(resolveDataDir),
      originHeadSha: originHead.stdout,
    });
    if (q.blocked) {
      const msg = `Skipped: migration quarantined (gen ${q.marker.fromGeneration}->${q.marker.toGeneration}, attempt ${q.marker.attempts}) — delete the quarantine marker files to override`;
      log(msg);
      if (Date.now() - _quarantineAlertAt > QUARANTINE_ALERT_COOLDOWN_MS) {
        _quarantineAlertAt = Date.now();
        const { fireMigrationAlert } = await import("../shared/migration-guard.js");
        await fireMigrationAlert({
          code: "migration-quarantined",
          title: "Crow updates paused: migration quarantined",
          body: `Auto-update is paused because a migration (schema gen ${q.marker.fromGeneration}->${q.marker.toGeneration}) damaged data and was rolled back. Updates resume automatically when a fix lands on main (attempt ${q.marker.attempts}/3).`,
        });
      }
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // converge:false — a quarantined migration is a refusal to run the code on
      // disk, so this process must not migrate its own store and restart into it
      // (the tree still holds that sha whenever the rollback was withheld or
      // failed). Restarting there re-runs the boot schema guard and init-db
      // against the store the migration just damaged, on a unit whose restart
      // policy cannot trip its own start limit.
      return { updated: false, skipped: "quarantined", message: msg, converge: false };
    }
    if (q.cleared) log(`Quarantine cleared — main moved past ${q.marker.sha.slice(0, 9)}; retrying the migration under guard`);
  } catch (err) {
    log(`quarantine check error (proceeding): ${err?.message}`);
  }

  // L0.3 update quarantine — same under-lock spot, same fresh origin head, so
  // the 6 h tick and the manual Check-now button both consult it. A sha this
  // host already rolled back is never re-pulled; the marker clears itself when
  // main moves past it (or expires, for a machine-side reason — and a HELD
  // marker, which a BLOCKED rollback writes, gets that TTL back once HEAD is no
  // longer its sha, i.e. once the operator has moved main back by hand).
  // NEITHER cleanup runs while a HELD marker's sha is local HEAD: the refused
  // commit is checked out, so the marker stays and the tick refuses. An ordinary
  // marker that happens to name HEAD is the operator's own choice (a manual
  // pull), so it clears exactly as it would off HEAD.
  let originHeadSha = "";
  try {
    originHeadSha = (await git(["rev-parse", "origin/main"])).stdout;
    // Local HEAD is what tells the evaluator whether a HELD (expiry-less) marker
    // is still sitting on the refused commit or may time out.
    const localHeadSha = (await git(["rev-parse", "HEAD"])).stdout;
    const uq = evaluateUpdateQuarantine({ gitDir, originHeadSha, localHeadSha });
    // A HELD marker naming the commit the checkout HOLDS is a refusal whatever
    // origin/main says: the refused sha is still checked out, so this tick
    // neither deletes the marker nor pulls a newer commit, and it withholds the
    // restart. `heldAtHead` comes from the evaluator — which never deletes a
    // HELD marker in that state — so the result cannot quote a marker that is
    // already gone. (The marker becomes ordinary again once HEAD is off its sha:
    // the operator's `git reset --keep` is what unfreezes updates.)
    if (uq.blocked || uq.heldAtHead) {
      const heldAtHead = uq.heldAtHead === true;
      // S5: a blocked rollback left the bad sha CHECKED OUT. Say so — the old
      // text ("waiting for a newer commit") hid that the next restart, reboot or
      // bundle install boots the sha this host already refused, and the bell
      // must not claim it "was rolled back".
      const msg = heldAtHead
        ? `Update rollback blocked: ${uq.marker.sha.slice(0, 9)} is still checked out; the next restart will boot it`
        : `Skipped: update quarantined (${uq.marker.sha.slice(0, 9)}, ${uq.marker.reason}); waiting for a newer commit on main`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // converge:false on both shapes: this tick refused to run the code on
      // disk, so this process must not migrate and restart into it.
      return {
        updated: false,
        skipped: heldAtHead ? "update-rollback-blocked" : "update-quarantined",
        blocked: heldAtHead,
        sha: uq.marker.sha,
        message: msg,
        converge: false,
      };
    }
    if (uq.cleared) log(`Update quarantine cleared — main moved past ${uq.marker.sha.slice(0, 9)}`);
    if (uq.expired) log(`Update quarantine for ${uq.marker.sha.slice(0, 9)} expired — no longer blocking on its own`);
  } catch (err) {
    log(`update quarantine check error (proceeding): ${err?.message}`);
  }

  // Check if there are new commits
  const behind = await git(["rev-list", "--count", "HEAD..origin/main"]);
  const behindCount = parseInt(behind.stdout, 10) || 0;

  await saveSetting("auto_update_current_version", currentVersion);

  if (behindCount === 0) {
    // S2 defence: the marker may still hold while the checkout sits on the commit
    // it names — "Up to date" there is the silent re-arm, because nothing is
    // pulled and npm never runs again. Only a HELD marker (a blocked rollback) is
    // permanent here; an ordinary one naming HEAD is the operator's own choice and
    // its TTL/"main moved" cleanup applies. Read the marker as it stands AFTER
    // evaluateUpdateQuarantine() ran in THIS tick: a marker the evaluator expired
    // and deleted (HEAD off its sha) must not come back out of a pre-evaluation
    // copy as a one-tick false "blocked" (and a false bell).
    const stale = activeUpdateQuarantine({ gitDir, localHeadSha: currentFullSha });
    if (stale?.held === true && stale.sha === currentFullSha) {
      const msg = `Update rollback blocked: ${stale.sha.slice(0, 9)} is still checked out; the next restart will boot it`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // converge:false — the commit this process just refused is still the one
      // checked out; migrating and restarting here would boot it.
      return {
        updated: false, skipped: "update-rollback-blocked",
        blocked: true, sha: stale.sha, message: msg, converge: false,
      };
    }
    log("Already up to date.");
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", "Up to date");
    await saveSetting("auto_update_latest_version", currentVersion);
    // N1 (review round 1): nothing is pending, so a leftover outage streak must
    // not survive. Without this, two unreadable ticks followed by a manual pull
    // left the count at 2, and the next single GitHub blip (days later) rang the
    // "paused" bell at once.
    //
    // The CI-gate reading is refreshed here, not blanked (review round 2):
    // "Up to date" is what a self-hosted origin records on nearly every tick, so
    // writing "" hid the not-applicable info line except between a pull and the
    // next tick. Re-reading the origin is a local git call — no network, no
    // GitHub request — and it is the same parse the gate uses, so a non-GitHub
    // origin keeps "not-applicable" while a GitHub origin (or a changed origin)
    // clears a stale reading.
    const originRemote = _ciRemoteUrl ?? (await git(["remote", "get-url", "origin"])).stdout;
    await saveSetting(CI_UNAVAILABLE_COUNT_KEY, "0");
    await saveSetting(CI_GATE_SETTING_KEY, parseGithubRemote(originRemote) ? "" : "not-applicable");
    return { updated: false };
  }

  log(`${behindCount} new commit(s) available. Updating...`);

  // A5: consult the target sha's required check-runs before pulling. Red or
  // still-running CI skips this tick (self-heals when main is fixed or CI
  // completes); a non-GitHub origin has no CI to ask and proceeds; GitHub
  // failing to answer skips too — an unverified sha is not a green one (N1c-5),
  // and so does a payload with none of our three checks (review S2, "no-ci").
  // CROW_UPDATE_CI_GATE=0 disables.
  if (process.env.CROW_UPDATE_CI_GATE !== "0") {
    // `_ciRemoteUrl` is a test seam only: a fixture origin must stay a local
    // bare repo, and a local path containing `github.com/o/r` is not GitHub.
    const remote = _ciRemoteUrl ?? (await git(["remote", "get-url", "origin"])).stdout;
    const targetSha = (await git(["rev-parse", "origin/main"])).stdout;
    // `missing` is only populated for no-ci: the required contexts GitHub has no
    // run for, which is what the sentence must say (none or only some).
    const ci = await resolveCiGate(remote, targetSha);
    // Recorded for the Nest's Updates card; reset on every verdict that is not
    // "unavailable", so the 3-in-a-row pause needs three CONSECUTIVE ones.
    await saveSetting(CI_GATE_SETTING_KEY, ci.verdict);
    if (ci.verdict !== "unavailable") await saveSetting(CI_UNAVAILABLE_COUNT_KEY, "0");

    if (ci.verdict === "not-applicable") {
      // Self-hosted origins (a bare repo on disk, another host) have no GitHub
      // check-runs at all — the gate cannot apply and they must keep updating.
      log("CI gate not applicable (origin is not GitHub)");
    } else if (ci.verdict === "unavailable") {
      // GitHub could not be asked: 403/429 rate limits, an outage, a timeout.
      // Skipping is the whole fix — one bad answer used to deploy the sha.
      // Same shape as the pending branch below and for the same reason, so NO
      // converge:false: this refuses the NEXT commit on main, not the tree
      // already checked out, and a co-hosted peer must still converge onto it.
      const n = (parseInt(await readSettingValue(CI_UNAVAILABLE_COUNT_KEY), 10) || 0) + 1;
      await saveSetting(CI_UNAVAILABLE_COUNT_KEY, String(n));
      // The first two ticks of an outage are transient (GitHub usually answers
      // again on its own); the third is a failure, which is what rings the bell.
      const msg = n >= CI_UNAVAILABLE_FAILURE_TICKS
        ? `Skipped: CI status unreadable for ${n} checks in a row — updates are paused until GitHub answers (or set CROW_UPDATE_CI_GATE=0)`
        : `Skipped: CI status could not be read for origin/main (${targetSha.slice(0, 9)}) — will retry next tick`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "ci-unavailable", message: msg, ciUnavailableCount: n };
    }

    if (ci.verdict === "no-ci") {
      // GitHub answered without the full set of required checks (review S2): a
      // fork that does not carry this repo's CI, or a push whose workflow has
      // not registered yet. Review round 2 adds the partial fork: one or two of
      // the three present and nothing still running means the rest will never
      // report here either, which is the same unverified case. Unverified is
      // never green, so this tick is skipped — and, like pending, WITHOUT
      // converge:false (the refusal is about the NEXT commit on main, not the
      // tree already checked out). Its own sentence, so nothing keeps claiming a
      // build is still running for days.
      const shaShort = targetSha.slice(0, 9);
      const msg = ci.missing.length > 0 && ci.missing.length < CI_GATE_CONTEXTS.length
        ? `Skipped: origin/main has only some of the required CI checks (${shaShort}; missing ${ci.missing.join(", ")} — a fork without this repo's full CI?) — not deploying an unverified commit; set CROW_UPDATE_CI_GATE=0 to update without the gate`
        : `Skipped: origin/main has none of the required CI checks (${shaShort}; a fork without this repo's CI?) — not deploying an unverified commit; set CROW_UPDATE_CI_GATE=0 to update without the gate`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "no-ci", message: msg, missingCi: ci.missing };
    }

    if (ci.verdict === "red" || ci.verdict === "pending") {
      const msg = ci.verdict === "red"
        ? `Skipped: CI is RED on origin/main (${targetSha.slice(0, 9)}) — not deploying a failing build; will retry next tick`
        : `Skipped: CI still running on origin/main (${targetSha.slice(0, 9)}) — will retry next tick`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // Deliberately NO converge:false here (round 4). Red or pending CI refuses
      // the NEXT commit on main, not the tree already checked out: a co-hosted
      // peer whose boot sha differs from HEAD must still migrate and restart into
      // what the shared checkout holds, or the whole host stays skewed for as long
      // as main's CI is red. The refusals that DO withhold the restart are the
      // ones about code on disk (quarantines, a blocked rollback, not-on-main).
      return { updated: false, skipped: ci.verdict === "red" ? "ci-red" : "ci-pending", message: msg };
    }
  } else {
    // N1 (review round 1): the gate is off, so no CI verdict was consulted.
    // Clear both keys — a count left over from before the switch would ring on
    // the first blip after it is turned back on, and a stale verdict would keep
    // the card's notice alive for a check this tick never ran. (The up-to-date
    // branch still records not-applicable on a non-GitHub origin: that reading
    // is about the ORIGIN, not about whether this tick consulted the gate.)
    await saveSetting(CI_UNAVAILABLE_COUNT_KEY, "0");
    await saveSetting(CI_GATE_SETTING_KEY, "");
  }

  // D3b: re-check the branch UNDER the lock, immediately before the pull —
  // a parallel session's raw `git checkout` races the outer guard across the
  // fetch window, and `pull --ff-only origin main` on an ancestor feature
  // branch FAST-FORWARDS that ref (R1 empirically proved it).
  const recheck = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (recheck.stdout !== "main") {
    const msg = `Skipped: branch changed mid-update (now '${recheck.stdout}')`;
    log(msg);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    // converge:false — the tree now holds another branch's code; a restart here
    // would run code this tick refused to update to.
    return { updated: false, skipped: "not-on-main", branch: recheck.stdout, message: msg, converge: false };
  }

  // D2: pull directly — NO stash. `git pull --ff-only` refuses only when the
  // incoming diff overlaps a locally-modified file; disjoint local WIP
  // survives untouched.
  const pullResult = await git(["pull", "--ff-only", "origin", "main"]);
  if (pullResult.code !== 0) {
    const msg = `Pull failed (local changes may conflict with the update — resolve manually): ${pullResult.stderr}`;
    log(msg);
    await saveSetting("auto_update_last_check", new Date().toISOString());
    await saveSetting("auto_update_last_result", msg);
    return { updated: false, error: msg };
  }

  // Install deps (only if package-lock changed)
  const changedFiles = await git(["diff", "--name-only", `${currentVersion}..HEAD`]);
  const depsChanged =
    changedFiles.stdout.includes("package-lock.json") || changedFiles.stdout.includes("package.json");
  // A failed install leaves node_modules half-written and says nothing about the
  // commit (a registry outage is not a bad sha), but the update cannot continue:
  // the import check would judge a tree whose dependencies nobody installed, and
  // init-db would migrate for a sha that may never boot. The satellite updater
  // aborts on the same signal (servers/satellite/update.js).
  let npmFailed = false;
  if (depsChanged) {
    log("Dependencies changed — running npm install...");
    const npmResult = await run("npm", ["install", "--omit=dev"], { timeout: 300000 });
    if (npmResult.code !== 0) {
      npmFailed = true;
      // npm's stderr names paths, so it goes to the log (clipped) and never into
      // the recorded result or the bell.
      log(`npm install failed (exit ${npmResult.code}): ${String(npmResult.stderr || "").slice(-400)}`);
    }
  }

  // L0.2 import check — AFTER npm, BEFORE init-db. Both halves matter: init-db
  // must not run its new-schema pass for a sha that will never boot, and the
  // rollback must happen while the deps still match the tree it resets to.
  const pulledSha = (await git(["rev-parse", "HEAD"])).stdout;
  if (npmFailed) {
    // `deps-failed` is a machine-side reason, so a rollback that MOVED the tree
    // back carries the 6 h TTL: main is retried even if it never moves (S4). A
    // BLOCKED one re-writes the marker without an expiry instead (S2) — the bad
    // sha is still checked out, so it must never time out into "Up to date".
    // No import check, no init-db, no restart — the tree is unusable until npm
    // succeeds.
    return await rollBackUnusableUpdate({
      gitDir, sha: pulledSha, previous: currentFullSha, reason: "deps-failed", depsChanged, log,
      cause: "— npm install failed",
      next: () => "retried after 6 h or when main moves",
      // A function: whether the previous commit's dependencies are back is only
      // known after the rollback ran, and the old text claimed they were (S1).
      bell: (rolled) => `The dependencies for the update to ${pulledSha.slice(0, 9)} could not be installed (npm install failed), so the update was abandoned before the import check and before init-db ran; npm's own output is in the gateway log. ` +
        `${currentFullSha.slice(0, 9)} is still running${rolled.depsRestored === true ? " with its own dependencies reinstalled" : ""}, and ${pulledSha.slice(0, 9)} is quarantined — updates are retried after 6 hours or when main moves past it.`,
    });
  }
  const importCheck = await pulledTreeImportCheck();
  if (importCheck.skipped === "no-seam") {
    // S2: a sha from before the seam existed cannot answer the check, and
    // running its gateway here would START a full server. Skip; Layer 1
    // (the boot guard) is the backstop for it.
    log(`import check unavailable in ${pulledSha.slice(0, 9)} (no ${IMPORT_CHECK_ENV} seam) — relying on the boot guard`);
  } else if (importCheck.ok !== true) {
    const reason = importCheck.reason || "import-check";
    return await rollBackUnusableUpdate({
      gitDir, sha: pulledSha, previous: currentFullSha, reason, depsChanged, log,
      cause: `fails to load (${reason})`,
      next: (rolled) => `updates resume when main moves past it${rolled.marker?.expires_at ? "; the quarantine also expires in 6h" : ""}`,
      bell: `The update to ${pulledSha.slice(0, 9)} was rolled back before it was ever restarted into: its gateway code fails to load (${reason}). ${currentFullSha.slice(0, 9)} is still running, and ${pulledSha.slice(0, 9)} is quarantined — updates resume by themselves when main moves past it.`,
    });
  }

  // Run init-db for any schema changes — guarded (A3) when the run carries
  // migration risk: the pulled range crosses a schema generation OR touches
  // scripts/init-db.js (state-conditional rebuilds fire on DB shape, not
  // generation). Non-crossing, init-db-unchanged runs keep the bare call.
  log("Running database migrations...");
  const guard = await import("../shared/migration-guard.js");
  const { resolveDataDir: _rdd } = await import("../db.js");
  const dbPath = guard.resolveGuardDbPath(_rdd);
  const newGeneration = guard.readTreeGeneration(APP_ROOT);
  const preState = guard.readSchemaState(dbPath);
  const armed =
    (newGeneration != null && preState.readable && preState.userVersion < newGeneration) ||
    changedFiles.stdout.split("\n").includes("scripts/init-db.js");
  if (armed) {
    const headSha = (await git(["rev-parse", "HEAD"])).stdout;
    const res = await guard.runGuardedInitDb({
      dbPath, appRoot: APP_ROOT, sha: headSha, newGeneration,
      log: (m) => log(`[migration-guard] ${m}`),
    });
    if (res.verdict === "loss") {
      if (!res.restored) {
        // Restore failed or no backup existed: the (damaged) migrated DB is
        // what's on disk and the running code matches it. Do NOT roll code
        // back or restart into a state the alert just told the operator to
        // repair by hand — keep running, quarantined, loudly.
        const msg = `Migration quarantined: data loss detected, automatic restore NOT possible — manual recovery required (${(res.report?.losses || []).join("; ")})`;
        log(msg);
        await saveSetting("auto_update_last_check", new Date().toISOString());
        await saveSetting("auto_update_last_result", msg);
        return { updated: false, error: msg, quarantined: true, converge: false };
      }
      // Fail closed: the guard restored the backup and quarantined the sha.
      // Roll the code back to match the restored schema — but never destroy
      // local WIP on a possibly-false verdict (quarantined boot handles the
      // code-newer-than-schema case).
      const porcelain = await git(["status", "--porcelain"]);
      const trackedWip = porcelain.stdout.split("\n").filter((l) => l && !l.startsWith("??"));
      // Same three values as quarantineAndRollBack: `null` when the reinstall
      // never ran (no dependency change, or the tree was left at the new sha).
      let depsRestored = null;
      if (trackedWip.length === 0) {
        await git(["reset", "--hard", currentVersion]);
        if (depsChanged) {
          // The tree is back on the old commit, so its own node_modules are the
          // ones the next restart needs. A failure here is REPORTED, not
          // swallowed: the restart happens straight after, onto a possibly
          // half-written tree (S1, same clause as the other rollbacks).
          const npmResult = await run("npm", ["install", "--omit=dev"], { timeout: 300000 });
          if (npmResult.code !== 0) {
            log(`npm install failed after the data-loss rollback (exit ${npmResult.code}): ${String(npmResult.stderr || "").slice(-400)}`);
            depsRestored = false;
          } else {
            depsRestored = true;
          }
        }
        log(`Rolled code back to ${currentVersion} to match the restored database.`);
      } else {
        log("Local WIP present — code left at the new sha; next boot is quarantined (old schema, data intact).");
      }
      const msg = `Migration quarantined: data loss detected and rolled back (${(res.report?.losses || []).join("; ")})` +
        depsRestoredClause(depsRestored);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // The live process's DB handles still pin the pre-restore inode —
      // restart IMMEDIATELY so the process reopens the restored file.
      scheduleSupervisedRestart(log, "Restarting to reopen the restored database...");
      return { updated: false, error: msg, quarantined: true, converge: false };
    }
    if (res.initDbExit !== 0) {
      // L0.5 — roll the tree back only when nothing about the new tree can have
      // reached the DB (see rollBackAfterInitDbFailure, B1). The alert and the
      // result are composed AFTER the decision so they can never promise a
      // restart retry after the checkout was reset — and never claim the deps
      // were reinstalled when the rollback's own npm failed (S1).
      const rollback = await rollBackAfterInitDbFailure({
        gitDir, sha: pulledSha, previous: currentFullSha, depsChanged, log,
        preState, newGeneration, postState: guard.readSchemaState(dbPath),
      });
      const msg = `Migration failed (init-db exit ${res.initDbExit}) — restart withheld, running code unchanged` +
        depsRestoredClause(rollback.depsRestored);
      log(msg);
      await guard.fireMigrationAlert({
        code: "migration-failed",
        title: "Crow migration failed during auto-update",
        body: initDbFailureAlertBody({
          exitCode: res.initDbExit, rollback, pulledSha, previousSha: currentFullSha,
        }),
      });
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // converge:false — this branch exists to WITHHOLD the restart. Without
      // the flag, convergence restarts into a sha whose init-db just failed and
      // the boot guard exits 1. Note the units here run RestartSec=5 against a
      // 10s StartLimitInterval, so StartLimitBurst=5 can never trip: the result
      // is an UNBOUNDED crash loop, not a stopped unit. Each iteration re-enters
      // the boot schema guard and re-runs init-db against a live store.
      return { updated: false, error: msg, converge: false };
    }
  } else {
    // Pinned to the running instance's DB (queue item 33): the pulled code may
    // resolve the data dir differently from the code that is running.
    const initRes = await run("node", ["scripts/init-db.js"], { env: guard.initDbChildEnv(dbPath) });
    if (initRes.code !== 0) {
      // L0.5, same rules as the guarded branch above (B1): only a DB the new
      // tree provably never touched is safe to put the old code back on. Same
      // ordering too: the result quotes the rollback's dependency outcome (S1).
      const rollback = await rollBackAfterInitDbFailure({
        gitDir, sha: pulledSha, previous: currentFullSha, depsChanged, log,
        preState, newGeneration, postState: guard.readSchemaState(dbPath),
      });
      const msg = `init-db failed (exit ${initRes.code}) — restart withheld, running code unchanged` +
        depsRestoredClause(rollback.depsRestored);
      log(msg);
      await guard.fireMigrationAlert({
        code: "init-db-failed",
        title: "Crow init-db failed during auto-update",
        body: initDbFailureAlertBody({
          exitCode: initRes.code, rollback, pulledSha, previousSha: currentFullSha,
        }),
      });
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      // converge:false — this branch exists to WITHHOLD the restart. Without
      // the flag, convergence restarts into a sha whose init-db just failed and
      // the boot guard exits 1. Note the units here run RestartSec=5 against a
      // 10s StartLimitInterval, so StartLimitBurst=5 can never trip: the result
      // is an UNBOUNDED crash loop, not a stopped unit. Each iteration re-enters
      // the boot schema guard and re-runs init-db against a live store.
      return { updated: false, error: msg, converge: false };
    }
  }

  const newRef = await git(["rev-parse", "--short", "HEAD"]);
  const newVersion = newRef.stdout;

  await saveSetting("auto_update_last_check", new Date().toISOString());
  await saveSetting("auto_update_last_result", `Updated ${currentVersion} → ${newVersion}`);
  await saveSetting("auto_update_current_version", newVersion);
  await saveSetting("auto_update_latest_version", newVersion);

  log(`Updated: ${currentVersion} → ${newVersion}`);

  // NOTE: the restart is NOT scheduled here. convergeInstance() owns it, and
  // schedules it only AFTER running this instance's migrations and writing the
  // boot cookie. Restarting here would fire a 1.5s exit timer while those
  // migrations are still running — an interrupted ALTER on a live store — and
  // the cookie, which must exist before the restart, might never be written.
  // (The restart on the migration-guard LOSS path below stays: it exists to
  // reopen a restored DB file and is unrelated to convergence.)
  return { updated: true, from: currentVersion, to: newVersion };
}

/** Supervised-restart machinery, shared by the normal update path and the
 *  migration-guard loss path (which must reopen the restored DB file).
 *  No-op without a supervisor. */
export function scheduleSupervisedRestart(log, message) {
  if (!isSupervised()) return;
  log(message);
  // Close the HTTP server first to release the port, then exit
  // so the supervisor's restart doesn't hit EADDRINUSE.
  // exitCode is preset so that if the loop drains before the inner timer
  // fires (manual check-now path: crow:shutdown closes the only ref'd
  // handle), node still exits nonzero — Restart=on-failure needs it.
  // Both timers are unref'd so a pending restart chain can never hold open
  // or kill a process whose loop otherwise finished (test runners).
  process.exitCode = 1;
  const outer = setTimeout(() => {
    process.emit("crow:shutdown");
    setTimeout(() => process.exit(1), 1000).unref();
  }, 1500);
  outer.unref();
}

/**
 * D4: whether auto-update should even attempt to start. The
 * CROW_AUTO_UPDATE=0|false kill switch always wins. Otherwise, a --no-auth
 * gateway (an unauthenticated scratch/dev surface) defaults OFF and requires
 * an explicit CROW_AUTO_UPDATE=1|true opt-in; every other gateway defaults
 * ON (existing behavior preserved).
 */
export function shouldStartAutoUpdate({ env = {}, noAuth = false } = {}) {
  if (env.CROW_AUTO_UPDATE === "0" || env.CROW_AUTO_UPDATE === "false") return false;
  if (noAuth) return env.CROW_AUTO_UPDATE === "1" || env.CROW_AUTO_UPDATE === "true";
  return true;
}

/**
 * Start the auto-update timer
 */
export async function startAutoUpdate(database, { noAuth = false } = {}) {
  // Re-arm safety: a second call must never leave the previous interval or
  // retry timer running next to the new ones (a doubled updater pulls the same
  // checkout twice a tick).
  stopAutoUpdate();
  db = database;

  if (!shouldStartAutoUpdate({ env: process.env, noAuth })) {
    console.log(
      noAuth
        ? "[auto-update] Disabled: --no-auth gateway defaults auto-update OFF (set CROW_AUTO_UPDATE=1 to opt in)"
        : "[auto-update] Disabled via CROW_AUTO_UPDATE env var",
    );
    return;
  }

  const settings = await getSettings();

  // Record the sha this process is ACTUALLY running, BEFORE any early return.
  // This used to sit below the disabled-in-settings return, so a disabled
  // instance froze its reported version at whatever it was when it was last
  // enabled — while continuing to run whatever the shared checkout moved to.
  // The bookkeeping and the running code disagreed and nothing detected it.
  try {
    const ref = await git(["rev-parse", "--short", "HEAD"]);
    if (ref.code === 0 && ref.stdout) await saveSetting("auto_update_current_version", ref.stdout);
  } catch {}

  if (settings.auto_update_enabled !== "true") {
    console.log("[auto-update] Disabled in settings");
    return;
  }

  const hours = Math.max(MIN_INTERVAL_HOURS, parseInt(settings.auto_update_interval_hours, 10) || DEFAULT_INTERVAL_HOURS);
  const intervalMs = hours * 60 * 60 * 1000;

  const { resolveDataDir } = await import("../db.js");
  const dataDir = resolveDataDir();
  const firstDelay = 5 * 60 * 1000 + instanceJitterMs(dataDir);
  console.log(`[auto-update] Enabled — checking every ${hours}h (first check in ${Math.round(firstDelay / 1000)}s)`);

  // N4-3: a "verdict not known yet" tick gets extra checks between two regular
  // ticks. Bounded so retries can never run into the next one.
  retryPlan = {
    intervalMs,
    budget: Math.max(0, Math.ceil(intervalMs / CI_RETRY_DELAY_MS) - 1),
    used: 0,
    startedAt: Date.now(),
    jitterKey: dataDir,
  };

  // First check after ~5 minutes plus a per-instance offset (let the gateway
  // fully start, and keep co-hosted instances off the same millisecond).
  updateTimer = setTimeout(async () => {
    // tickCheck now reaches runMigrations, which CAN reject; an unhandled
    // rejection in this timer would take the gateway down.
    await scheduledTick("regular").catch((e) => console.error("[auto-update] tick failed:", e.message));
    updateTimer = setInterval(() => { scheduledTick("regular").catch(() => {}); }, intervalMs);
  }, firstDelay);
}

/**
 * Stop the auto-update timer
 */
export function stopAutoUpdate() {
  if (updateTimer) {
    clearTimeout(updateTimer);
    clearInterval(updateTimer);
    updateTimer = null;
  }
  clearRetryTimer();
  retryPlan = null;
}

/**
 * Get current status for the Settings panel
 */
export async function getUpdateStatus() {
  const settings = await getSettings();
  return {
    enabled: settings.auto_update_enabled === "true",
    intervalHours: parseInt(settings.auto_update_interval_hours, 10) || DEFAULT_INTERVAL_HOURS,
    lastCheck: settings.auto_update_last_check,
    lastResult: settings.auto_update_last_result,
    resultSince: settings.auto_update_result_since,
    currentVersion: settings.auto_update_current_version,
    latestVersion: settings.auto_update_latest_version,
  };
}
