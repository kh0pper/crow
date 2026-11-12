/**
 * Crow Mail's sync supervisor: one worker per account, the poll and idle loops, the back-off, and
 * the short-lived adapter an action borrows.
 *
 * The engine (engine.js) owns one pass over a mailbox and knows nothing about time. This module owns
 * everything the engine refuses to: when a pass runs, what happens after it fails, and whether this
 * Crow is still the instance that is allowed to talk to the account. Four rules shape it.
 *
 * **One in-flight sync per account.** A worker holds at most one run; a `syncNow` or `requestSync`
 * that arrives during it does not start a second one — it sets the dirty flag and returns that run's
 * promise, and the run's end starts exactly one more full sync. An IDLE report coalesces the same
 * way, but into one more pass over that one folder. Two runs of one account never overlap, so a
 * folder's `highest_uid` watermark can only ever be written by one pass at a time.
 *
 * **A run is bounded twice.** Every run carries `deadlineAt = now + SYNC_DEADLINE_MS`, so the engine
 * aborts between batches, and the supervisor arms its own hard timer at that instant. The timer is
 * what a deadline can actually rely on: it closes the adapter, which is what unblocks a socket that
 * never answers, records TIMEOUT on the back-off path and clears the in-flight entry, so a later
 * `syncNow` is not stuck behind a promise that will never settle. A fresh adapter is built after any
 * close, by the pinned `adapterFactory({account, credentials})`, which reads the keychain again.
 *
 * **Failures back off, and a lost watch never touches stored mail.** NETWORK, TLS, PROTOCOL and
 * TIMEOUT count up (`backoffDelay` doubles from five seconds to fifteen minutes with jitter), the
 * state is persisted in `mail_sync_state` so a restarted supervisor resumes the same ladder, and the
 * notice at the fifth consecutive failure is rate-limited to once a day by `last_notice_at`. A
 * dropped watch stops the watcher, closes the adapter and reconnects after the back-off; nothing is
 * deleted, reset or re-fetched from scratch. AUTH_FAILED is terminal until the owner acts: the
 * account is marked, one notice is written, and only `syncNow` clears it.
 *
 * **The claim comes first.** An account another Crow instance claimed is never synced here: a
 * losing worker stops its watcher and timers, closes its adapters and marks the account
 * `claimed_elsewhere`, and the light global tick re-evaluates it and restarts it once the claim
 * clears. `refreshClaim` rewrites our own claim at start and once a day.
 *
 * `withAdapter` is the seam plan 2's actions and attachment fetches use. It never borrows the sync
 * worker's connection: it keeps its own short-lived adapter, one call at a time per account, reusing
 * it for `ACTION_IDLE_KEEP_MS` so a burst costs one connection, and closing it at once when a call
 * fails, when the account restarts, when the claim is lost and on `stop()`. Every call has a hard
 * `ACTION_DEADLINE_MS` timer too.
 *
 * Nothing here logs or stores library text: a log line, `mail_sync_state.error_code` and
 * `mail_accounts.status_detail` carry a MailError code (and its allow-listed detail token) only.
 */
import { MailError, toMailError } from "../errors.js";
import { mailEnabled } from "../flag.js";
import {
  getAccount,
  getSyncState,
  listAccounts,
  setSyncState,
  updateAccount,
} from "../store/accounts.js";
import { folderRole, getFolder, listFolders } from "../store/messages.js";
import { syncAccount, syncFolder } from "./engine.js";
import { createNotification } from "../../../shared/notifications.js";

/** The poll interval: every non-idle folder is refreshed this often. */
export const POLL_MS = 15 * 60 * 1000;

/** The folder roles that are watched over IDLE — never more than these two paths. */
export const IDLE_ROLES = Object.freeze(["inbox", "sent"]);

/** The first back-off, doubled per consecutive failure. */
export const BACKOFF_BASE_MS = 5000;

/** The back-off ceiling. */
export const BACKOFF_MAX_MS = 15 * 60 * 1000;

/** The consecutive failure count that earns the owner one notice. */
export const FAILURES_BEFORE_NOTICE = 5;

/** One sync may take this long; past it the adapter is closed and the run is a TIMEOUT. */
export const SYNC_DEADLINE_MS = 10 * 60 * 1000;

/** Two notices about one account are never closer together than this. */
export const NOTICE_GAP_MS = 24 * 3600 * 1000;

/** Our own claim is rewritten this often. */
export const CLAIM_REFRESH_MS = 24 * 3600 * 1000;

/** One `withAdapter` call may take this long. */
export const ACTION_DEADLINE_MS = 60 * 1000;

/** A borrowed adapter stays open this long after a successful call, so a burst costs one connection. */
export const ACTION_IDLE_KEEP_MS = 30 * 1000;

/** The four codes a sync retries: the connection itself is what failed, not the account. */
const RETRYABLE_CODES = Object.freeze(["NETWORK", "TLS", "PROTOCOL", "TIMEOUT"]);

const RETRYABLE = new Set(RETRYABLE_CODES);

/** A watch this many milliseconds after a failure, jittered: the same ladder as everything else. */
function jitter(base, random) {
  const value = typeof random === "function" ? Number(random()) : 0.5;
  const safe = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
  return Math.round(base * (0.8 + 0.4 * safe));
}

/**
 * How long to wait after `failures` consecutive failures: five seconds, doubled per failure, capped
 * at fifteen minutes, then jittered by ±20% (`random` returns [0,1); 0.5 is exactly the base).
 *
 * @param {number} failures at least 1
 * @param {Function} [random]
 * @returns {number} milliseconds
 */
export function backoffDelay(failures, random = Math.random) {
  const count = Number.isFinite(failures) && failures >= 1 ? Math.floor(failures) : 1;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (count - 1));
  return jitter(base, random);
}

/**
 * Whether this process should run a mail supervisor at all: the flag is on, auth is not disabled,
 * and the owner has not turned sync off for this process.
 *
 * @param {{env?: object, noAuth?: boolean}} [options]
 * @returns {boolean}
 */
export function shouldRunMailSync({ env = process.env, noAuth = false } = {}) {
  if (!mailEnabled(env)) return false;
  if (noAuth === true) return false;
  return env == null || env.CROW_DISABLE_MAIL_SYNC !== "1";
}

/** No sink given: a supervisor that was handed no log says nothing. */
function silent() {}

/** Two path lists describe the same watch. Order is the folder order, so it is compared exactly. */
function samePaths(left, right) {
  if (left.length !== right.length) return false;
  return left.every((path, index) => path === right[index]);
}

/**
 * Build one supervisor. Nothing starts until `start()` is called; every timer goes through
 * `setTimer`/`clearTimer` so a test can drive time by hand.
 *
 * @param {object} options
 * @param {object} options.db the Crow db client
 * @param {object} options.credentials the keychain reader, passed to `adapterFactory`
 * @param {Function} options.adapterFactory `({account, credentials}) => adapter`
 * @param {Function} [options.now]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 * @param {Function} [options.random]
 * @param {Function} [options.notify] `(title, body) => Promise`, defaults to a mail notification
 * @param {Function} [options.log] `(line) => void`, a code/count/id object only
 * @param {Function} [options.isClaimedElsewhere] `(account) => Promise<boolean>`
 * @param {Function} [options.refreshClaim] `(account) => Promise<void>`
 */
export function createMailSupervisor(options = {}) {
  const {
    db,
    credentials = null,
    adapterFactory,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,
    notify = null,
    log = null,
    isClaimedElsewhere = async () => false,
    refreshClaim = async () => {},
  } = options;

  if (db == null || typeof db.execute !== "function") {
    throw new TypeError("mail supervisor needs a db client");
  }
  if (typeof adapterFactory !== "function") {
    throw new TypeError("mail supervisor needs an adapterFactory");
  }

  const logSink = typeof log === "function" ? log : silent;
  const notifyOwner = typeof notify === "function" ? notify : defaultNotify;

  /** The owner-facing notice when nothing else was injected: one in-app notification. */
  async function defaultNotify(title, body) {
    await createNotification(db, { title, body, type: "system", source: "mail", priority: "normal" });
  }

  /** accountId -> worker. A worker outlives a lost claim (the global tick restarts it). */
  const workers = new Map();

  /** accountId -> {adapter, timer}: the short-lived adapter a `withAdapter` call borrows. */
  const actionAdapters = new Map();

  /** accountId -> promise: the tail of that account's `withAdapter` queue. */
  const actionQueues = new Map();

  let started = false;
  let stopped = false;
  let claimTickTimer = null;
  let refreshTimer = null;

  /* ------------------------------------------------------------------- plumbing */

  const live = () => stopped !== true;
  const running = () => started === true && stopped !== true;

  function logEvent(event, extra = {}) {
    try {
      logSink({ event, ...extra });
    } catch {
      // A log sink that throws is not a sync failure.
    }
  }

  function logError(event, err, extra = {}) {
    logEvent(event, { ...extra, code: toMailError(err).code });
  }

  function arm(fn, ms) {
    const handle = setTimer(fn, ms);
    handle?.unref?.();
    return handle;
  }

  function disarm(handle) {
    if (handle == null) return null;
    try {
      clearTimer(handle);
    } catch {
      // A timer that already fired is not an error.
    }
    return null;
  }

  function workerFor(account) {
    let worker = workers.get(account.id);
    if (!worker) {
      worker = {
        accountId: account.id,
        adapter: null,
        watcher: null,
        watchPaths: [],
        pollTimer: null,
        backoffTimer: null,
        inflight: null,
        pending: { full: false, folders: new Set() },
        claimed: account.status === "claimed_elsewhere",
        authFailed: account.status === "auth_failed",
        syncable: account.status === "active",
        tick: 0,
      };
      workers.set(account.id, worker);
    }
    return worker;
  }

  async function accountOrNull(accountId) {
    try {
      return await getAccount(db, accountId);
    } catch (err) {
      logError("account_read_failed", err, { accountId });
      return null;
    }
  }

  async function stateOrNull(accountId) {
    try {
      return await getSyncState(db, accountId);
    } catch (err) {
      logError("state_read_failed", err, { accountId });
      return null;
    }
  }

  async function writeState(accountId, patch) {
    try {
      await setSyncState(db, accountId, patch);
      return true;
    } catch (err) {
      logError("state_write_failed", err, { accountId });
      return false;
    }
  }

  async function writeAccount(accountId, patch) {
    try {
      await updateAccount(db, accountId, patch);
      return true;
    } catch (err) {
      logError("account_write_failed", err, { accountId });
      return false;
    }
  }

  /* ------------------------------------------------------------------- adapters */

  /**
   * One adapter from the factory, connected. On any failure the half-made adapter is closed before
   * the MailError travels, so a connection is never leaked into the failure path.
   */
  async function openAdapter(account) {
    let adapter = null;
    try {
      adapter = await adapterFactory({ account, credentials });
      if (adapter == null || typeof adapter.list !== "function") {
        throw new MailError("PROTOCOL", "adapter");
      }
      if (typeof adapter.connect === "function") await adapter.connect();
      return adapter;
    } catch (err) {
      if (adapter != null && typeof adapter.close === "function") {
        try {
          await adapter.close();
        } catch {
          // The open failed already; the close's own failure changes nothing.
        }
      }
      throw toMailError(err);
    }
  }

  /** The sync worker's connection, made on demand and kept for the next run. */
  async function workerAdapter(worker) {
    if (worker.adapter) return worker.adapter;
    const account = await accountOrNull(worker.accountId);
    if (!account) throw new MailError("NOT_FOUND", "account");
    const adapter = await openAdapter(account);
    worker.adapter = adapter;
    return adapter;
  }

  async function closeWorkerAdapter(worker) {
    const adapter = worker.adapter;
    worker.adapter = null;
    if (adapter == null || typeof adapter.close !== "function") return;
    try {
      await adapter.close();
    } catch (err) {
      logError("adapter_close_failed", err, { accountId: worker.accountId });
    }
  }

  /* --------------------------------------------------------------------- watch */

  /** The stored paths whose role is one of the two IDLE roles, in folder order, never more than two. */
  async function watchPathsFor(worker) {
    const folders = await listFolders(db, worker.accountId);
    const paths = [];
    for (const folder of folders) {
      if (!IDLE_ROLES.includes(folderRole(folder))) continue;
      if (typeof folder.path !== "string" || folder.path === "") continue;
      if (paths.includes(folder.path)) continue;
      paths.push(folder.path);
      if (paths.length >= IDLE_ROLES.length) break;
    }
    return paths;
  }

  function stopWatcher(worker) {
    const watcher = worker.watcher;
    worker.watcher = null;
    worker.watchPaths = [];
    if (watcher != null && typeof watcher.stop === "function") {
      try {
        watcher.stop();
      } catch (err) {
        logError("watch_stop_failed", err, { accountId: worker.accountId });
      }
    }
  }

  /** (Re)arm the IDLE watch on INBOX and Sent, and only those two. Never throws. */
  async function ensureWatch(worker) {
    if (!live() || worker.claimed || worker.authFailed) return;
    // A watch is only reconnected after the back-off: the retry's own success lands here again.
    if (worker.backoffTimer != null) return;
    let paths;
    try {
      paths = await watchPathsFor(worker);
    } catch (err) {
      logError("watch_paths_failed", err, { accountId: worker.accountId });
      return;
    }
    if (paths.length === 0) {
      stopWatcher(worker);
      return;
    }
    if (worker.watcher != null && samePaths(worker.watchPaths, paths)) return;
    stopWatcher(worker);

    let adapter;
    try {
      adapter = await workerAdapter(worker);
    } catch (err) {
      logError("watch_connect_failed", err, { accountId: worker.accountId });
      return;
    }
    if (!live() || worker.claimed) return;

    let watcher;
    try {
      watcher = await adapter.watch(paths, {
        onChange: (event) => {
          void onIdleChange(worker, event);
        },
        onError: (err) => {
          void onWatchError(worker, err);
        },
      });
    } catch (err) {
      logError("watch_failed", err, { accountId: worker.accountId });
      await onWatchError(worker, err);
      return;
    }
    worker.watcher = watcher ?? null;
    worker.watchPaths = paths;
    logEvent("watch_armed", { accountId: worker.accountId, paths: paths.length });
  }

  /** A change the server reported: sync that one folder, coalesced with a run already going. */
  async function onIdleChange(worker, event) {
    try {
      if (!live() || worker.claimed || worker.authFailed || !worker.syncable) return;
      const folderPath = event != null && typeof event.folderPath === "string" ? event.folderPath : null;
      if (folderPath == null || folderPath === "") return;
      if (worker.backoffTimer != null) return;

      const folders = await listFolders(db, worker.accountId);
      const folder = folders.find((candidate) => candidate.path === folderPath);
      if (!folder) return;
      if (!IDLE_ROLES.includes(folderRole(folder))) return;
      startRun(worker, { kind: "folders", folderIds: [folder.id] });
    } catch (err) {
      logError("idle_change_failed", err, { accountId: worker.accountId });
    }
  }

  /**
   * The watch connection died. Nothing stored is touched: the watcher is dropped, the connection is
   * closed, and the back-off decides when it is reconnected. A run already in flight reports its own
   * outcome (and a success re-arms the watch), so it is left alone here.
   */
  async function onWatchError(worker, err) {
    stopWatcher(worker);
    if (!live() || worker.claimed || worker.authFailed || !worker.syncable) return;
    if (worker.inflight != null) return;
    await recordFailure(worker, toMailError(err));
  }

  /* ----------------------------------------------------------------------- runs */

  /** A request that arrived during a run: one more run afterwards, a full one winning over folders. */
  function noteRequest(worker, plan) {
    if (plan.kind === "account") {
      worker.pending.full = true;
      worker.pending.folders.clear();
      return;
    }
    if (worker.pending.full) return;
    for (const folderId of plan.folderIds) worker.pending.folders.add(folderId);
  }

  function takePending(worker) {
    const pending = { full: worker.pending.full, folders: [...worker.pending.folders] };
    clearPending(worker);
    return pending;
  }

  function clearPending(worker) {
    worker.pending.full = false;
    worker.pending.folders.clear();
  }

  /**
   * Start one run, or join the one already going. The returned promise settles when the run does —
   * including a run the hard deadline timer ended — and never rejects: a failed sync is reported in
   * `status()` and `mail_sync_state`, not thrown at the caller who asked for it.
   */
  function startRun(worker, plan) {
    if (worker.inflight != null) {
      noteRequest(worker, plan);
      return worker.inflight.settled;
    }
    const run = { plan, closedOut: false, timer: null, settled: null, resolve: null };
    run.settled = new Promise((resolve) => {
      run.resolve = resolve;
    });
    worker.inflight = run;
    void executeRun(worker, run);
    return run.settled;
  }

  async function executeRun(worker, run) {
    const deadlineAt = now() + SYNC_DEADLINE_MS;
    let failed = false;
    // Armed before the connection is opened, so the budget starts when the run does and a handshake
    // that never finishes is bounded by the same deadline as a listing that never answers.
    run.timer = arm(() => {
      onRunDeadline(worker, run);
    }, SYNC_DEADLINE_MS);
    try {
      const adapter = await workerAdapter(worker);
      if (run.closedOut) {
        if (worker.adapter === adapter) await closeWorkerAdapter(worker);
        return;
      }
      await runPlan(worker, adapter, run.plan, deadlineAt);
      if (run.closedOut || worker.inflight !== run) return;
      await onRunSuccess(worker);
    } catch (err) {
      if (run.closedOut || worker.inflight !== run) return;
      failed = true;
      await onRunFailure(worker, toMailError(err));
    } finally {
      if (!run.closedOut) {
        run.closedOut = true;
        run.timer = disarm(run.timer);
        if (worker.inflight === run) worker.inflight = null;
        const pending = takePending(worker);
        run.resolve();
        // A failed run keeps nothing: its retry is a full sync, so every queued folder is covered.
        if (!failed) void drainPending(worker, pending);
      }
    }
  }

  async function runPlan(worker, adapter, plan, deadlineAt) {
    const ctx = {
      db,
      adapter,
      now,
      deadlineAt,
      log: (line) => {
        try {
          logSink(line);
        } catch {
          // As in logEvent: a throwing sink is the sink's problem.
        }
      },
    };
    if (plan.kind !== "folders") {
      await syncAccount(ctx, worker.accountId);
      return;
    }
    for (const folderId of plan.folderIds) {
      const folder = await getFolder(db, folderId);
      if (!folder || folder.accountId !== worker.accountId) {
        logEvent("folder_missing", { accountId: worker.accountId, folderId });
        continue;
      }
      await syncFolder(ctx, worker.accountId, folder);
    }
  }

  async function drainPending(worker, pending) {
    if (worker.claimed || !live()) return;
    if (pending.full) {
      await startRun(worker, { kind: "account" });
      return;
    }
    if (pending.folders.length > 0) {
      await startRun(worker, { kind: "folders", folderIds: pending.folders });
    }
  }

  /** A run finished its pass: the ladder resets, the stamp is written, the watch and the poll return. */
  async function onRunSuccess(worker) {
    if (worker.claimed) return;
    worker.authFailed = false;
    worker.syncable = true;
    await writeState(worker.accountId, {
      state: "idle",
      errorCode: null,
      failures: 0,
      backoffUntil: null,
      lastSuccessAt: now(),
    });
    await writeAccount(worker.accountId, { lastSyncAt: now() });
    worker.backoffTimer = disarm(worker.backoffTimer);
    await ensureWatch(worker);
    armPoll(worker);
    logEvent("sync_ok", { accountId: worker.accountId });
  }

  /** A run failed: the connection is dropped and the code decides between back-off and AUTH_FAILED. */
  async function onRunFailure(worker, mailErr) {
    if (worker.claimed) return;
    await closeWorkerAdapter(worker);
    if (mailErr.code === "AUTH_FAILED") {
      await recordAuthFailure(worker, mailErr);
      return;
    }
    if (RETRYABLE.has(mailErr.code)) {
      await recordFailure(worker, mailErr);
      return;
    }
    // Not a connection failure and not a credential one: a code in the log is the whole report.
    logEvent("sync_failed", { accountId: worker.accountId, code: mailErr.code });
    await writeState(worker.accountId, { state: "idle", errorCode: mailErr.code });
  }

  /** The hard deadline: close the adapter (unblocking a hung socket) and take the back-off path. */
  function onRunDeadline(worker, run) {
    if (run.closedOut) return;
    run.closedOut = true;
    run.timer = disarm(run.timer);
    if (worker.inflight === run) worker.inflight = null;
    clearPending(worker);
    void (async () => {
      try {
        if (worker.claimed) return;
        await recordFailure(worker, new MailError("TIMEOUT", "sync_deadline"));
      } catch (err) {
        logError("deadline_failed", err, { accountId: worker.accountId });
      } finally {
        run.resolve();
      }
    })();
  }

  /* ------------------------------------------------------------------- failures */

  function armBackoff(worker, delay) {
    worker.backoffTimer = disarm(worker.backoffTimer);
    if (!live() || worker.claimed || worker.authFailed) return;
    worker.backoffTimer = arm(() => {
      worker.backoffTimer = null;
      void retryRun(worker);
    }, delay);
  }

  async function retryRun(worker) {
    if (!live() || worker.claimed || worker.authFailed) return;
    if (worker.inflight != null) {
      noteRequest(worker, { kind: "account" });
      return;
    }
    await startRun(worker, { kind: "account" });
  }

  /**
   * Count one consecutive failure, persist the ladder, write the one notice that is due, and arm the
   * retry. Nothing here deletes, resets or re-reads stored mail.
   */
  async function recordFailure(worker, mailErr) {
    stopWatcher(worker);
    await closeWorkerAdapter(worker);

    const previous = await stateOrNull(worker.accountId);
    const failures = Number(previous?.failures ?? 0) + 1;
    const delay = backoffDelay(failures, random);
    await writeState(worker.accountId, {
      state: "backoff",
      errorCode: mailErr.code,
      failures,
      backoffUntil: now() + delay,
    });
    if (failures >= FAILURES_BEFORE_NOTICE) await maybeNotice(worker, previous, "failing");
    armBackoff(worker, delay);
    logEvent("sync_backoff", { accountId: worker.accountId, code: mailErr.code, failures });
  }

  /** A refused sign-in is terminal until the owner acts: marked, noticed once, and never retried. */
  async function recordAuthFailure(worker, mailErr) {
    worker.authFailed = true;
    worker.syncable = false;
    worker.pollTimer = disarm(worker.pollTimer);
    worker.backoffTimer = disarm(worker.backoffTimer);
    stopWatcher(worker);
    await closeWorkerAdapter(worker);
    await writeAccount(worker.accountId, { status: "auth_failed", statusDetail: "AUTH_FAILED" });
    const previous = await stateOrNull(worker.accountId);
    await writeState(worker.accountId, {
      state: "auth_failed",
      errorCode: "AUTH_FAILED",
      backoffUntil: null,
    });
    await maybeNotice(worker, previous, "auth");
    logEvent("sync_auth_failed", { accountId: worker.accountId, code: mailErr.code });
  }

  /**
   * One fixed sentence, at most once a day per account — the gap is `last_notice_at`, persisted, so a
   * new supervisor within twenty-four hours stays quiet about the same outage.
   */
  async function maybeNotice(worker, previous, kind) {
    const last = Number(previous?.lastNoticeAt);
    if (Number.isFinite(last) && now() - last < NOTICE_GAP_MS) return;

    const account = await accountOrNull(worker.accountId);
    const label = typeof account?.label === "string" && account.label !== "" ? account.label : "this account";
    const title = kind === "auth" ? "Crow Mail cannot sign in" : "Mail sync is failing";
    const body = kind === "auth"
      ? `Crow could not sign in to "${label}". Check the app password.`
      : `Crow cannot sync "${label}" right now. It will keep trying.`;

    // The stamp is written before the notice: a notice that cannot be delivered must not be repeated
    // on every failure for the next twenty-four hours.
    await writeState(worker.accountId, { lastNoticeAt: now() });
    try {
      await notifyOwner(title, body);
      logEvent("notice_sent", { accountId: worker.accountId, kind });
    } catch (err) {
      logError("notice_failed", err, { accountId: worker.accountId });
    }
  }

  /* ---------------------------------------------------------------------- claim */

  async function claimCheck(worker) {
    const account = await accountOrNull(worker.accountId);
    if (!account) return false;
    let loser = false;
    try {
      loser = (await isClaimedElsewhere(account)) === true;
    } catch (err) {
      logError("claim_check_failed", err, { accountId: worker.accountId });
      return false;
    }
    if (!loser) return false;
    await becomeClaimed(worker);
    return true;
  }

  async function becomeClaimed(worker) {
    worker.claimed = true;
    worker.syncable = false;
    worker.pollTimer = disarm(worker.pollTimer);
    worker.backoffTimer = disarm(worker.backoffTimer);
    stopWatcher(worker);
    clearPending(worker);
    await closeWorkerAdapter(worker);
    await closeActionAdapter(worker.accountId);
    await writeAccount(worker.accountId, { status: "claimed_elsewhere", statusDetail: null });
    logEvent("claim_lost", { accountId: worker.accountId });
  }

  /** The claim cleared: the account goes back to active and its worker starts over from scratch. */
  async function restartFromClaim(worker) {
    worker.claimed = false;
    worker.authFailed = false;
    await writeAccount(worker.accountId, { status: "active", statusDetail: null });
    logEvent("claim_regained", { accountId: worker.accountId });
    await startWorker(worker);
  }

  /* ---------------------------------------------------------------------- loops */

  function armPoll(worker) {
    if (!running() || worker.pollTimer != null) return;
    if (worker.claimed || worker.authFailed || !worker.syncable) return;
    worker.pollTimer = arm(() => {
      worker.pollTimer = null;
      void pollTick(worker);
    }, POLL_MS);
  }

  /**
   * One poll: the claim is re-checked first (for a running worker too), then every non-idle folder is
   * synced, and INBOX and Sent ride along every second tick as a safety net. A run already going is
   * left alone — it is at least as fresh as this tick would be.
   */
  async function pollTick(worker) {
    try {
      if (!live() || worker.claimed) return;
      if (await claimCheck(worker)) return;
      if (!live() || worker.claimed || worker.authFailed || !worker.syncable) return;
      if (worker.backoffTimer != null || worker.inflight != null) return;

      worker.tick += 1;
      const folders = await listFolders(db, worker.accountId);
      const idleRoles = [];
      const otherRoles = [];
      for (const folder of folders) {
        if (IDLE_ROLES.includes(folderRole(folder))) idleRoles.push(folder);
        else otherRoles.push(folder);
      }
      const chosen = worker.tick % 2 === 0 ? [...otherRoles, ...idleRoles] : otherRoles;
      if (chosen.length === 0) return;
      startRun(worker, { kind: "folders", folderIds: chosen.map((folder) => folder.id) });
    } catch (err) {
      logError("poll_failed", err, { accountId: worker.accountId });
    } finally {
      armPoll(worker);
    }
  }

  /** The light global tick: a claimed account is re-evaluated, and a paused worker keeps its claim checked. */
  function armClaimTick() {
    if (!running() || claimTickTimer != null) return;
    claimTickTimer = arm(() => {
      claimTickTimer = null;
      void claimTick();
    }, POLL_MS);
  }

  async function claimTick() {
    try {
      for (const worker of [...workers.values()]) {
        if (!live()) return;
        if (worker.claimed) {
          const account = await accountOrNull(worker.accountId);
          if (!account) continue;
          let loser = true;
          try {
            loser = (await isClaimedElsewhere(account)) === true;
          } catch (err) {
            logError("claim_check_failed", err, { accountId: worker.accountId });
            continue;
          }
          if (!loser) await restartFromClaim(worker);
          continue;
        }
        // A worker with no poll of its own (AUTH_FAILED) still has its claim re-checked.
        if (worker.pollTimer == null) await claimCheck(worker);
      }
    } catch (err) {
      logError("claim_tick_failed", err);
    } finally {
      armClaimTick();
    }
  }

  /** Our own claim, rewritten at start and once a day after it. */
  function armRefreshTimer() {
    if (!running() || refreshTimer != null) return;
    refreshTimer = arm(() => {
      refreshTimer = null;
      void refreshTick();
    }, CLAIM_REFRESH_MS);
  }

  async function refreshTick() {
    try {
      const accounts = await listAccounts(db);
      for (const account of accounts) {
        if (!live()) return;
        if (account.status === "claimed_elsewhere") continue;
        try {
          await refreshClaim(account);
        } catch (err) {
          logError("claim_refresh_failed", err, { accountId: account.id });
        }
      }
    } catch (err) {
      logError("claim_refresh_failed", err);
    } finally {
      armRefreshTimer();
    }
  }

  /* ---------------------------------------------------------------------- start */

  async function startWorker(worker) {
    worker.claimed = false;
    worker.authFailed = false;
    worker.syncable = true;
    worker.tick = 0;
    await startRun(worker, { kind: "account" });
    if (!live() || worker.claimed) return;
    await ensureWatch(worker);
    armPoll(worker);
  }

  async function startAccount(account) {
    const worker = workerFor(account);
    if (account.status === "claimed_elsewhere") {
      worker.claimed = true;
      worker.syncable = false;
      logEvent("account_claimed", { accountId: account.id });
      return;
    }
    if (account.status === "auth_failed") {
      worker.authFailed = true;
      worker.syncable = false;
      return;
    }

    try {
      await refreshClaim(account);
    } catch (err) {
      logError("claim_refresh_failed", err, { accountId: account.id });
    }
    let loser = false;
    try {
      loser = (await isClaimedElsewhere(account)) === true;
    } catch (err) {
      logError("claim_check_failed", err, { accountId: account.id });
    }
    if (loser) {
      await becomeClaimed(worker);
      return;
    }
    await startWorker(worker);
  }

  /** Start every active account. Never throws: a failure is a code in the log, nothing more. */
  async function start() {
    if (started) return;
    started = true;
    stopped = false;
    armClaimTick();
    armRefreshTimer();
    try {
      const accounts = await listAccounts(db);
      for (const account of accounts) {
        if (!live()) return;
        try {
          await startAccount(account);
        } catch (err) {
          logError("account_start_failed", err, { accountId: account.id });
        }
      }
    } catch (err) {
      logError("accounts_failed", err);
    }
  }

  /* ----------------------------------------------------------------- actions */

  async function closeEntry(accountId, entry) {
    if (entry == null) return;
    entry.timer = disarm(entry.timer);
    if (actionAdapters.get(accountId) === entry) actionAdapters.delete(accountId);
    const adapter = entry.adapter;
    entry.adapter = null;
    if (adapter == null || typeof adapter.close !== "function") return;
    try {
      await adapter.close();
    } catch (err) {
      logError("action_close_failed", err, { accountId });
    }
  }

  async function closeActionAdapter(accountId) {
    await closeEntry(accountId, actionAdapters.get(accountId) ?? null);
  }

  /** Keep a borrowed adapter open a little longer: a burst of calls costs one connection. */
  function armActionKeep(accountId, entry) {
    entry.timer = disarm(entry.timer);
    if (!live()) {
      void closeEntry(accountId, entry);
      return;
    }
    entry.timer = arm(() => {
      entry.timer = null;
      void closeEntry(accountId, entry);
    }, ACTION_IDLE_KEEP_MS);
  }

  /**
   * Borrow a short-lived adapter for one action or attachment fetch. Never the sync worker's
   * connection; one call per account at a time; refused without connecting for a claimed or
   * signed-out account; and hard-bounded by `ACTION_DEADLINE_MS`.
   */
  function withAdapter(accountId, fn) {
    if (typeof fn !== "function") return Promise.reject(new MailError("BAD_INPUT", "fn"));
    const previous = actionQueues.get(accountId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => runAction(accountId, fn));
    actionQueues.set(accountId, next.catch(() => {}));
    return next;
  }

  async function runAction(accountId, fn) {
    const account = await getAccount(db, accountId).catch((err) => {
      logError("account_read_failed", err, { accountId });
      return null;
    });
    if (!account) throw new MailError("NOT_FOUND", "account");
    // Refused before any connection exists: a claimed or signed-out account must not be touched.
    if (account.status === "claimed_elsewhere") throw new MailError("CLAIMED_ELSEWHERE");
    if (account.status === "auth_failed") throw new MailError("AUTH_FAILED");

    let entry = actionAdapters.get(accountId) ?? null;
    if (entry != null && entry.adapter != null) {
      entry.timer = disarm(entry.timer);
    } else {
      entry = { adapter: await openAdapter(account), timer: null };
      actionAdapters.set(accountId, entry);
    }
    if (!live()) {
      await closeEntry(accountId, entry);
      throw new MailError("NETWORK", "stopped");
    }
    const adapter = entry.adapter;

    let timer = null;
    const deadline = new Promise((resolve, reject) => {
      timer = arm(() => {
        void closeEntry(accountId, entry);
        reject(new MailError("TIMEOUT", "action_deadline"));
      }, ACTION_DEADLINE_MS);
    });
    // The deadline may lose the race; a rejection nobody is waiting for must not be an unhandled one.
    deadline.catch(() => {});

    const work = Promise.resolve().then(() => fn(adapter));
    work.catch(() => {});
    try {
      const value = await Promise.race([work, deadline]);
      timer = disarm(timer);
      armActionKeep(accountId, entry);
      return value;
    } catch (err) {
      timer = disarm(timer);
      await closeEntry(accountId, entry);
      throw toMailError(err);
    }
  }

  /**
   * The keychain may have changed under us (a new app password): drop both connections so the next
   * factory call reads the secret again, and start the worker over.
   */
  async function restartAccount(accountId) {
    const account = await getAccount(db, accountId);
    if (!account) throw new MailError("NOT_FOUND", "account");
    const worker = workerFor(account);
    await closeActionAdapter(accountId);
    stopWatcher(worker);
    worker.backoffTimer = disarm(worker.backoffTimer);
    await closeWorkerAdapter(worker);
    worker.tick = 0;
    return startRun(worker, { kind: "account" });
  }

  /* --------------------------------------------------------------------- public */

  /** Everything a caller needs before syncing by hand: the account must exist and be ours. */
  async function prepare(accountId, { resume }) {
    const account = await getAccount(db, accountId);
    if (!account) throw new MailError("NOT_FOUND", "account");
    const worker = workerFor(account);

    if (worker.claimed || account.status === "claimed_elsewhere") {
      let loser = true;
      try {
        loser = (await isClaimedElsewhere(account)) === true;
      } catch (err) {
        logError("claim_check_failed", err, { accountId });
      }
      if (loser) {
        worker.claimed = true;
        throw new MailError("CLAIMED_ELSEWHERE");
      }
      worker.claimed = false;
      await writeAccount(accountId, { status: "active", statusDetail: null });
    }

    if (resume && (worker.authFailed || account.status === "auth_failed")) {
      worker.authFailed = false;
      worker.syncable = true;
      await writeAccount(accountId, { status: "active", statusDetail: null });
      await writeState(accountId, { state: "idle", errorCode: null, failures: 0, backoffUntil: null });
      armPoll(worker);
    }
    if (resume) worker.backoffTimer = disarm(worker.backoffTimer);
    return worker;
  }

  /** Sync one account now. A run already going is joined (and will be followed by one more). */
  async function syncNow(accountId) {
    const worker = await prepare(accountId, { resume: true });
    return startRun(worker, { kind: "account" });
  }

  /** Sync the given folders now, or the whole account when none were named. */
  async function requestSync(accountId, { folderIds } = {}) {
    const worker = await prepare(accountId, { resume: false });
    const ids = Array.isArray(folderIds)
      ? folderIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const plan = ids.length > 0 ? { kind: "folders", folderIds: ids } : { kind: "account" };
    return startRun(worker, plan);
  }

  /** Everything stored about one account's sync, plus whether this supervisor is working on it. */
  async function status(accountId) {
    const stored = await getSyncState(db, accountId).catch(() => null);
    const worker = workers.get(accountId) ?? null;
    return {
      accountId,
      state: stored?.state ?? "idle",
      errorCode: stored?.errorCode ?? null,
      failures: stored?.failures ?? 0,
      backoffUntil: stored?.backoffUntil ?? null,
      lastSuccessAt: stored?.lastSuccessAt ?? null,
      lastNoticeAt: stored?.lastNoticeAt ?? null,
      running: worker?.inflight != null,
      watching: worker?.watcher != null,
    };
  }

  /** A local action touched mail: a run already going does one more when it ends, and only then. */
  function noteChange(accountId) {
    const worker = workers.get(accountId) ?? null;
    if (!worker || worker.inflight == null) return;
    noteRequest(worker, { kind: "account" });
  }

  /** Stop everything: no timer, no watcher, no open adapter. Idempotent. */
  async function stop() {
    if (stopped) return;
    stopped = true;
    started = false;
    claimTickTimer = disarm(claimTickTimer);
    refreshTimer = disarm(refreshTimer);

    const closes = [];
    for (const worker of workers.values()) {
      worker.pollTimer = disarm(worker.pollTimer);
      worker.backoffTimer = disarm(worker.backoffTimer);
      stopWatcher(worker);
      clearPending(worker);
      const run = worker.inflight;
      if (run != null) {
        run.closedOut = true;
        run.timer = disarm(run.timer);
        worker.inflight = null;
        run.resolve();
      }
      const adapter = worker.adapter;
      worker.adapter = null;
      if (adapter != null && typeof adapter.close === "function") {
        closes.push(Promise.resolve().then(() => adapter.close()).catch(() => {}));
      }
    }
    for (const accountId of [...actionAdapters.keys()]) {
      closes.push(closeActionAdapter(accountId));
    }
    await Promise.all(closes);
    logEvent("stopped");
  }

  return {
    start,
    stop,
    syncNow,
    requestSync,
    status,
    withAdapter,
    restartAccount,
    noteChange,
  };
}