/**
 * Crow Mail's sync supervisor: one worker per account, the poll and idle loops, the back-off, and
 * the short-lived adapter an action borrows.
 *
 * The engine (engine.js) owns one pass over a mailbox and knows nothing about time. This module owns
 * everything the engine refuses to: when a pass runs, what happens after it fails, and whether this
 * Crow is still the instance that is allowed to talk to the account. Five rules shape it.
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
 * **A run ended on purpose is never a failure.** `stop()`, the deadline timer and `restartAccount`
 * all end a run the same way: it is closed out first (its timer disarmed, its in-flight entry
 * cleared, its promise resolved) and the connection goes afterwards, so the rejection the close
 * causes is ignored — no failure count, no back-off and no notice. `restartAccount` closes the old
 * password's run out BEFORE closing the adapter and then starts one fresh full sync through the same
 * path a manual sync takes, so the run that follows is always built with the secret just stored.
 *
 * **Failures back off, and a lost watch never touches stored mail.** Every failure but AUTH_FAILED
 * counts up the same ladder (`backoffDelay` doubles from five seconds to fifteen minutes with
 * jitter) — a connection fault and a code the engine raised for a bad setting, a missing item or a
 * changed message are treated alike, so a fault that does not clear by itself still earns a retry
 * and, at the threshold, one notice. The state is persisted in `mail_sync_state` so a restarted
 * supervisor resumes the same ladder (a `backoff_until` still in the future delays the first
 * attempt), and the notice at the fifth consecutive failure is gated by `last_notice_at`, repeated
 * once a day while the ladder stays high. A dropped watch stops the watcher, closes the adapter and
 * reconnects after the back-off; nothing is deleted, reset or re-fetched from scratch. AUTH_FAILED
 * is terminal until the owner acts: the account is marked, one notice is written on the transition
 * into `auth_failed` (so an earlier "sync is failing" notice can never silence it), and only
 * `syncNow` or a restart clears it.
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
 * `ACTION_DEADLINE_MS` timer too, armed before the connection is opened — a handshake that never
 * answers is bounded like a call that never does, and the connection it finally gets is closed.
 *
 * **A handler that was overtaken does nothing.** Every failure path awaits — a close, a state read, a
 * write, a notice — and any of those may span a `restartAccount`, a `stop()` or a lost claim. A
 * worker therefore carries an `epoch`: `restartAccount`, `stop()` and `becomeClaimed` bump it, and a
 * handler that compares against an older value returns without further effect the moment it no
 * longer matches (or the supervisor is no longer live, or the worker has lost its claim). The epoch
 * a handler compares is the one its run or its watch was built with — stamped into the run when it
 * is created, captured when the watch is armed — never the worker's value read when the handler
 * starts: `restartAccount` bumps the epoch and closes the run out in one synchronous step, and a
 * failure that surfaces inside that step belongs to the run that was ended, not to the one that
 * follows. A stale handler never counts a failure on top of the fresh worker's state, never arms a
 * back-off, never writes a status and never notifies; it never closes the connection, clears a
 * back-off timer or arms a watch either, because `worker.adapter` and the timers are the fresh run's
 * by then.
 *
 * **A stopped supervisor opens nothing.** After `stop()` the adapters, watchers and timers are gone
 * for good: `syncNow`, `requestSync` and `restartAccount` resolve without touching an account,
 * `withAdapter` refuses with NETWORK/`stopped` before it connects, and a connection that finishes
 * opening after the stop is closed rather than adopted.
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

/** Two failing-sync notices about one account are never closer together than this. */
export const NOTICE_GAP_MS = 24 * 3600 * 1000;

/** Our own claim is rewritten this often. */
export const CLAIM_REFRESH_MS = 24 * 3600 * 1000;

/** One `withAdapter` call may take this long. */
export const ACTION_DEADLINE_MS = 60 * 1000;

/** A borrowed adapter stays open this long after a successful call, so a burst costs one connection. */
export const ACTION_IDLE_KEEP_MS = 30 * 1000;

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

  /** This worker is being torn down and started over: everything suspended in it is stale now. */
  function supersede(worker) {
    worker.epoch += 1;
  }

  /**
   * Whether a handler that was built with `epoch` may still act on this worker: the supervisor is
   * live, the worker has not been torn down or replaced since, and it has not lost its claim. A
   * claim taken without a supersede (the re-check in `prepare`) is enough to end a suspended handler.
   */
  function current(worker, epoch) {
    return live() && worker.claimed !== true && worker.epoch === epoch;
  }

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
        // Bumped whenever this worker is torn down and started over (a restart, `stop()`, a lost
        // claim): a failure handler that captured an older value is stale and must not write again.
        epoch: 0,
        // Per-kind notice stamps in memory, beside the one persisted `last_notice_at` column.
        noticeAt: { failing: null, auth: null },
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

  /** Close an adapter this module holds on its own (never the worker's), swallowing its failure. */
  async function closeAdapterValue(adapter, accountId) {
    if (adapter == null || typeof adapter.close !== "function") return;
    try {
      await adapter.close();
    } catch (err) {
      logError("adapter_close_failed", err, { accountId });
    }
  }

  /**
   * The sync worker's connection, made on demand and kept for the next run.
   *
   * A connection is adopted only while it is still wanted. A run that was closed out while its
   * handshake was in flight (its deadline fired, `stop()`, or `restartAccount`) must not store the
   * connection it finally got: that would resurrect a stopped worker, and by then a later run may
   * already hold its own connection. Such a late connection is closed here instead.
   */
  async function workerAdapter(worker, run = null) {
    if (worker.adapter) return worker.adapter;
    const account = await accountOrNull(worker.accountId);
    if (!account) throw new MailError("NOT_FOUND", "account");
    const adapter = await openAdapter(account);
    // A run closed out while its handshake was in flight (a restart, `stop()`, the deadline) never
    // adopts the connection it finally got — not even when a later run has already stored one, which
    // is that later run's connection and not this run's. It is closed here and the late run ends with
    // NETWORK/`run_closed`, so it can never carry on into a pass beside the fresh run.
    if (run != null && run.closedOut === true) {
      await closeAdapterValue(adapter, worker.accountId);
      throw new MailError("NETWORK", "run_closed");
    }
    if (!live() || worker.adapter != null) {
      await closeAdapterValue(adapter, worker.accountId);
      // A run-less caller (ensureWatch) or a live run that lost a benign race takes the connection
      // the worker already holds instead of replacing it.
      if (worker.adapter != null) return worker.adapter;
      throw new MailError("NETWORK", "stopped");
    }
    worker.adapter = adapter;
    return adapter;
  }

  async function closeWorkerAdapter(worker) {
    const adapter = worker.adapter;
    worker.adapter = null;
    // A closed connection cannot carry a watch: dropping the watcher here is what lets the next
    // ensureWatch re-arm IDLE on the fresh adapter instead of trusting a dead one.
    stopWatcher(worker);
    await closeAdapterValue(adapter, worker.accountId);
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

  /** Stop one watcher handle. Never throws: a watch that is already gone is not an error. */
  function stopWatcherValue(watcher, accountId) {
    if (watcher == null || typeof watcher.stop !== "function") return;
    try {
      watcher.stop();
    } catch (err) {
      logError("watch_stop_failed", err, { accountId });
    }
  }

  function stopWatcher(worker) {
    const watcher = worker.watcher;
    worker.watcher = null;
    worker.watchPaths = [];
    stopWatcherValue(watcher, worker.accountId);
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
    // The connect may have outlived the supervisor or the worker's own connection: `stop()` and a
    // failure both close the adapter and null it, so a connection that is no longer the worker's is
    // never watched.
    if (!live() || worker.claimed || worker.adapter !== adapter) return;

    // Captured when the watch is armed, not when the adapter reports: a watch on a connection a
    // restart has since replaced may still report a change, or its own death, and that report belongs
    // to the worker that armed it, never to the one that now holds a watch of its own.
    const epoch = worker.epoch;
    let watcher;
    try {
      watcher = await adapter.watch(paths, {
        onChange: (event) => {
          void onIdleChange(worker, event, epoch);
        },
        onError: (err) => {
          void onWatchError(worker, err, epoch);
        },
      });
    } catch (err) {
      logError("watch_failed", err, { accountId: worker.accountId });
      await onWatchError(worker, err, epoch);
      return;
    }
    // The watch may have outlived the supervisor, the connection it was made on, or the arm that came
    // before it: a watcher created after `stop()` or after a failure closed the adapter is stopped
    // here and never stored.
    if (!live() || worker.claimed || worker.adapter !== adapter || worker.watcher != null) {
      stopWatcherValue(watcher, worker.accountId);
      return;
    }
    worker.watcher = watcher ?? null;
    worker.watchPaths = paths;
    logEvent("watch_armed", { accountId: worker.accountId, paths: paths.length });
  }

  /** A change the server reported: sync that one folder, coalesced with a run already going. */
  async function onIdleChange(worker, event, epoch = worker.epoch) {
    try {
      if (!current(worker, epoch)) return;
      if (worker.claimed || worker.authFailed || !worker.syncable) return;
      const folderPath = event != null && typeof event.folderPath === "string" ? event.folderPath : null;
      if (folderPath == null || folderPath === "") return;
      if (worker.backoffTimer != null) return;

      const folders = await listFolders(db, worker.accountId);
      if (!current(worker, epoch)) return;
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
   * `epoch` is the value the watch was armed with. A report that arrives after a restart comes from a
   * connection this worker no longer owns: it is dropped here, before it can stop the fresh watch.
   */
  async function onWatchError(worker, err, epoch = worker.epoch) {
    if (!current(worker, epoch)) return;
    stopWatcher(worker);
    if (worker.claimed || worker.authFailed || !worker.syncable) return;
    if (worker.inflight != null) return;
    await recordFailure(worker, toMailError(err), epoch);
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
    // A stopped supervisor has no timers and no connections: nothing may start behind it.
    if (!live()) return Promise.resolve();
    if (worker.inflight != null) {
      noteRequest(worker, plan);
      return worker.inflight.settled;
    }
    const run = { plan, epoch: worker.epoch, closedOut: false, timer: null, settled: null, resolve: null };
    run.settled = new Promise((resolve) => {
      run.resolve = resolve;
    });
    worker.inflight = run;
    void executeRun(worker, run);
    return run.settled;
  }

  /**
   * End the worker's in-flight run from the outside, without reporting anything about it: the run is
   * marked closed out, its deadline timer disarmed, the in-flight entry cleared and its promise
   * resolved, so whoever joined it is not left waiting for a run that is over. The run's own later
   * rejection — the adapter it was using is about to close under it — is ignored by `executeRun`,
   * which is the point: a run this module ended on purpose is never a failure (no count, no back-off,
   * no notice). `stop()` and `restartAccount` both end a run this way.
   */
  function closeOutRun(worker) {
    const run = worker.inflight;
    if (run == null) return null;
    run.closedOut = true;
    run.timer = disarm(run.timer);
    worker.inflight = null;
    run.resolve();
    return run;
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
      const adapter = await workerAdapter(worker, run);
      await runPlan(worker, adapter, run.plan, deadlineAt);
      if (run.closedOut || worker.inflight !== run) return;
      await onRunSuccess(worker, run);
    } catch (err) {
      if (run.closedOut || worker.inflight !== run) return;
      failed = true;
      // The epoch this run was created with, not the worker's as the failure surfaces: a restart may
      // already have bumped it while the failing call was still in the adapter.
      await onRunFailure(worker, toMailError(err), run.epoch);
    } finally {
      if (!run.closedOut) {
        run.closedOut = true;
        run.timer = disarm(run.timer);
        if (worker.inflight === run) worker.inflight = null;
        // A failed run keeps its pending request: a request that arrived while it was going must not
        // be lost. The retry after the back-off is a full sync, so that retry covers it (and clears
        // the flag when it starts).
        const pending = failed ? null : takePending(worker);
        run.resolve();
        if (pending != null) void drainPending(worker, pending);
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
  async function onRunSuccess(worker, run) {
    const epoch = run.epoch;
    if (!current(worker, epoch) || worker.claimed) return;
    worker.authFailed = false;
    worker.syncable = true;
    await writeState(worker.accountId, {
      state: "idle",
      errorCode: null,
      failures: 0,
      backoffUntil: null,
      lastSuccessAt: now(),
    });
    // Every await above and below may span a restart: the fresh worker has its own timers, its own
    // watch and its own state, and this run may not clear or arm any of them.
    if (!current(worker, epoch)) return;
    await writeAccount(worker.accountId, { lastSyncAt: now() });
    if (!current(worker, epoch)) return;
    worker.backoffTimer = disarm(worker.backoffTimer);
    await ensureWatch(worker);
    if (!current(worker, epoch)) return;
    armPoll(worker);
    logEvent("sync_ok", { accountId: worker.accountId });
  }

  /** A run failed: the connection is dropped and the code decides between AUTH_FAILED and the ladder. */
  async function onRunFailure(worker, mailErr, epoch = worker.epoch) {
    if (!current(worker, epoch) || worker.claimed) return;
    await closeWorkerAdapter(worker);
    // The close may have spanned a restart or a stop: the connection it dropped was the old run's,
    // and nothing about the worker that replaced it may be touched from here.
    if (!current(worker, epoch)) return;
    if (mailErr.code === "AUTH_FAILED") {
      await recordAuthFailure(worker, mailErr, epoch);
      return;
    }
    // Everything else — a connection fault, a bad setting, a missing item, a changed message — takes
    // the same ladder. A fault that does not clear on its own then still gets a retry and, at the
    // threshold, one notice, instead of being logged once and forgotten.
    await recordFailure(worker, mailErr, epoch);
  }

  /** The hard deadline: close the adapter (unblocking a hung socket) and take the back-off path. */
  function onRunDeadline(worker, run) {
    if (run.closedOut) return;
    run.closedOut = true;
    run.timer = disarm(run.timer);
    if (worker.inflight === run) worker.inflight = null;
    // The pending flag is kept, exactly as for a run that threw: the retry after the back-off is a
    // full sync, so a request that arrived during the hung run is covered by it.
    const epoch = run.epoch;
    void (async () => {
      try {
        if (worker.claimed) return;
        await recordFailure(worker, new MailError("TIMEOUT", "sync_deadline"), epoch);
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
    // The retry is a full sync: whatever a failed run left pending is covered by it.
    clearPending(worker);
    await startRun(worker, { kind: "account" });
  }

  /**
   * Count one consecutive failure, persist the ladder, write the one notice that is due, and arm the
   * retry. Nothing here deletes, resets or re-reads stored mail.
   *
   * `epoch` is the one the failing run was created with (never this worker's value read here); every
   * await below can span a restart, a stop or a lost claim, and each one is followed by the same
   * guard. A superseded handler stops there: the fresh worker's state, timers and connection are not
   * its to touch.
   */
  async function recordFailure(worker, mailErr, epoch = worker.epoch) {
    if (!current(worker, epoch)) return;
    stopWatcher(worker);
    await closeWorkerAdapter(worker);
    if (!current(worker, epoch)) return;

    const previous = await stateOrNull(worker.accountId);
    if (!current(worker, epoch)) return;
    const failures = Number(previous?.failures ?? 0) + 1;
    const delay = backoffDelay(failures, random);
    await writeState(worker.accountId, {
      state: "backoff",
      errorCode: mailErr.code,
      failures,
      backoffUntil: now() + delay,
    });
    if (!current(worker, epoch)) return;
    // At the threshold and on every failure after it: from here on the gap is what decides whether a
    // notice goes out (see maybeFailingNotice), so a long outage is mentioned about once a day.
    if (failures >= FAILURES_BEFORE_NOTICE) {
      await maybeFailingNotice(worker, previous, epoch);
      if (!current(worker, epoch)) return;
    }
    armBackoff(worker, delay);
    logEvent("sync_backoff", { accountId: worker.accountId, code: mailErr.code, failures });
  }

  /** A refused sign-in is terminal until the owner acts: marked, noticed once, and never retried. */
  async function recordAuthFailure(worker, mailErr, epoch = worker.epoch) {
    if (!current(worker, epoch)) return;
    const before = await accountOrNull(worker.accountId);
    if (!current(worker, epoch)) return;
    // The notice belongs to the transition into auth_failed, not to the outage the account was
    // already in: a password the owner has just re-entered gets its own notice, even when a
    // "sync is failing" notice went out a minute earlier.
    const enteringAuthFailed = worker.authFailed !== true && before?.status !== "auth_failed";
    worker.authFailed = true;
    worker.syncable = false;
    worker.pollTimer = disarm(worker.pollTimer);
    worker.backoffTimer = disarm(worker.backoffTimer);
    stopWatcher(worker);
    await closeWorkerAdapter(worker);
    if (!current(worker, epoch)) return;
    await writeAccount(worker.accountId, { status: "auth_failed", statusDetail: "AUTH_FAILED" });
    if (!current(worker, epoch)) return;
    await writeState(worker.accountId, {
      state: "auth_failed",
      errorCode: "AUTH_FAILED",
      backoffUntil: null,
    });
    if (!current(worker, epoch)) return;
    if (enteringAuthFailed) await sendNotice(worker, "auth", epoch);
    if (!current(worker, epoch)) return;
    logEvent("sync_auth_failed", { accountId: worker.accountId, code: mailErr.code });
  }

  /**
   * One fixed sentence per kind. There are two kinds and one persisted stamp: `mail_sync_state` has
   * no per-kind column and the schema does not change, so the failing-sync notice is gated by
   * `last_notice_at` (plus its own in-memory stamp) while the AUTH_FAILED notice is sent on the
   * transition into `auth_failed` only and never consults the gap. Both kinds write that one shared
   * `last_notice_at` column.
   */
  async function sendNotice(worker, kind, epoch = worker.epoch) {
    if (!current(worker, epoch)) return;
    // The in-memory stamp goes down BEFORE the first await. Two failures recorded at the same moment
    // both reach the gate before either has written the persisted stamp, and this is what makes the
    // second one see that the notice is already going out and stay quiet. A handler that turns out to
    // be superseded puts it back: a swallowed notice must not silence the fresh worker for a day.
    const previousStamp = worker.noticeAt[kind] ?? null;
    const stampAt = now();
    worker.noticeAt[kind] = stampAt;
    const account = await accountOrNull(worker.accountId);
    const label = typeof account?.label === "string" && account.label !== "" ? account.label : "this account";
    const title = kind === "auth" ? "Crow Mail cannot sign in" : "Mail sync is failing";
    const body = kind === "auth"
      ? `Crow could not sign in to "${label}". Check the app password.`
      : `Crow cannot sync "${label}" right now. It will keep trying.`;

    // The stamp is written before the notice: a notice that cannot be delivered must not be repeated
    // on every failure for the next twenty-four hours. The stale check sits BEFORE that write, and a
    // handler that fails it puts the in-memory stamp back: a swallowed notice must not persist a
    // stamp, nor keep one in memory, that would silence the fresh worker's own notice for a day.
    if (!current(worker, epoch)) {
      worker.noticeAt[kind] = previousStamp;
      return;
    }
    await writeState(worker.accountId, { lastNoticeAt: stampAt });
    if (!current(worker, epoch)) return;
    try {
      await notifyOwner(title, body);
      logEvent("notice_sent", { accountId: worker.accountId, kind });
    } catch (err) {
      logError("notice_failed", err, { accountId: worker.accountId });
    }
  }

  /**
   * The failing-sync notice gate: at most once per NOTICE_GAP_MS.
   *
   * It INTENTIONALLY REPEATS, which is a deviation from "one notice at the fifth consecutive failure":
   * once failures are at or above FAILURES_BEFORE_NOTICE every later failure reaches this gate, and
   * only the gap decides whether a notice goes out, so an account that keeps failing is mentioned
   * roughly once a day rather than once and never again. That is deliberate — the retry is still
   * failing and the owner should hear it again — and it is why the gap, not the count, is the gate.
   *
   * `mail_sync_state.last_notice_at` is ONE stamp SHARED BY BOTH KINDS (the schema has no per-kind
   * column and does not change): this gate compares it (and its own in-memory stamp) against the gap;
   * the AUTH_FAILED notice never consults them, so a "sync is failing" notice cannot silence it.
   */
  async function maybeFailingNotice(worker, previous, epoch = worker.epoch) {
    if (!current(worker, epoch)) return;
    const stored = Number(previous?.lastNoticeAt);
    const memory = Number(worker.noticeAt?.failing);
    const last = Math.max(Number.isFinite(stored) ? stored : 0, Number.isFinite(memory) ? memory : 0);
    if (last > 0 && now() - last < NOTICE_GAP_MS) return;
    await sendNotice(worker, "failing", epoch);
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
    // This worker is being torn down for good: a failure handler suspended in it has no effect now.
    supersede(worker);
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

  /** A claimed worker: has the claim cleared? Nothing else is done while it still stands. */
  async function regainIfFree(worker) {
    const account = await accountOrNull(worker.accountId);
    if (!account) return;
    let loser = true;
    try {
      loser = (await isClaimedElsewhere(account)) === true;
    } catch (err) {
      logError("claim_check_failed", err, { accountId: worker.accountId });
      return;
    }
    if (!loser) await restartFromClaim(worker);
  }

  async function claimTick() {
    try {
      // Concurrently, like start(): a server that never answers holds up only its own account.
      const tasks = [];
      for (const worker of [...workers.values()]) {
        if (!live()) break;
        if (worker.claimed) {
          tasks.push(regainIfFree(worker));
          continue;
        }
        // A worker with no poll of its own (AUTH_FAILED) still has its claim re-checked.
        if (worker.pollTimer == null) tasks.push(claimCheck(worker));
      }
      await Promise.allSettled(tasks.map((task) => task.catch((err) => {
        logError("claim_tick_failed", err);
      })));
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
    if (!live()) return;
    worker.claimed = false;
    worker.authFailed = false;
    worker.syncable = true;
    worker.tick = 0;
    // A restarted supervisor resumes the ladder where it left off: a stored `backoff_until` still in
    // the future delays the first attempt instead of syncing (and maybe failing) at once.
    const stored = await stateOrNull(worker.accountId);
    const until = Number(stored?.backoffUntil);
    if (Number.isFinite(until) && until > now()) {
      armBackoff(worker, until - now());
      logEvent("sync_resume_backoff", {
        accountId: worker.accountId,
        failures: Number(stored?.failures ?? 0),
      });
      return;
    }
    await startRun(worker, { kind: "account" });
    if (!live() || worker.claimed) return;
    await ensureWatch(worker);
    armPoll(worker);
  }

  async function startAccount(account) {
    if (!live()) return;
    const worker = workerFor(account);
    if (account.status === "claimed_elsewhere") {
      worker.claimed = true;
      worker.syncable = false;
      logEvent("account_claimed", { accountId: account.id });
      return;
    }

    // Our own claim is rewritten at start for every account this instance may talk to — a signed-out
    // one included, exactly as the refresh tick does — so an account that cannot sync yet still
    // belongs to this instance.
    try {
      await refreshClaim(account);
    } catch (err) {
      logError("claim_refresh_failed", err, { accountId: account.id });
    }
    if (!live()) return;

    if (account.status === "auth_failed") {
      worker.authFailed = true;
      worker.syncable = false;
      return;
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

  /** Start every account at once. Never throws: a failure is a code in the log, nothing more. */
  async function start() {
    if (started) return;
    started = true;
    stopped = false;
    armClaimTick();
    armRefreshTimer();
    let accounts;
    try {
      accounts = await listAccounts(db);
    } catch (err) {
      logError("accounts_failed", err);
      return;
    }
    // Concurrently: one account whose server never answers must not hold up the others.
    await Promise.allSettled(accounts.map(async (account) => {
      try {
        await startAccount(account);
      } catch (err) {
        logError("account_start_failed", err, { accountId: account.id });
      }
    }));
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
    // Refused before the queue and before any connection: a stopped supervisor has neither.
    if (!live()) return Promise.reject(new MailError("NETWORK", "stopped"));
    const previous = actionQueues.get(accountId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => runAction(accountId, fn));
    const tail = next.catch(() => {});
    actionQueues.set(accountId, tail);
    // The entry lives only while a call is queued or running for the account.
    void tail.then(() => {
      if (actionQueues.get(accountId) === tail) actionQueues.delete(accountId);
    });
    return next;
  }

  /**
   * One call through a borrowed adapter. Refused without connecting for a claimed or signed-out
   * account. The `ACTION_DEADLINE_MS` timer is armed before the connection is opened, so a handshake
   * that never answers is bounded like a call that never does: it rejects TIMEOUT, closes whatever
   * was opened — a connection that lands after the deadline included — and settles this account's
   * queue, so the next call is never stuck behind it.
   */
  async function runAction(accountId, fn) {
    if (!live()) throw new MailError("NETWORK", "stopped");
    const account = await getAccount(db, accountId).catch((err) => {
      logError("account_read_failed", err, { accountId });
      return null;
    });
    if (!account) throw new MailError("NOT_FOUND", "account");
    // Refused before any connection exists: a claimed or signed-out account must not be touched.
    if (account.status === "claimed_elsewhere") throw new MailError("CLAIMED_ELSEWHERE");
    if (account.status === "auth_failed") throw new MailError("AUTH_FAILED");

    let entry = actionAdapters.get(accountId) ?? null;
    let timer = null;
    let expired = false;
    const deadline = new Promise((resolve, reject) => {
      timer = arm(() => {
        expired = true;
        reject(new MailError("TIMEOUT", "action_deadline"));
      }, ACTION_DEADLINE_MS);
    });
    // The deadline may lose the race; a rejection nobody is waiting for must not be an unhandled one.
    deadline.catch(() => {});

    // The borrowed adapter: the one already kept, or a fresh connection that may still be opening.
    const borrow = (async () => {
      if (entry != null && entry.adapter != null) {
        entry.timer = disarm(entry.timer);
        return entry.adapter;
      }
      const adapter = await openAdapter(account);
      // The deadline (or `stop()`) may have fired while the handshake was in flight: the connection
      // is not adopted, it is closed here, so nothing is left open behind a call that gave up.
      if (expired || !live()) {
        await closeAdapterValue(adapter, accountId);
        throw expired ? new MailError("TIMEOUT", "action_deadline") : new MailError("NETWORK", "stopped");
      }
      entry = { adapter, timer: null };
      actionAdapters.set(accountId, entry);
      return adapter;
    })();
    borrow.catch(() => {});

    try {
      const adapter = await Promise.race([borrow, deadline]);
      const work = Promise.resolve().then(() => fn(adapter));
      work.catch(() => {});
      const value = await Promise.race([work, deadline]);
      timer = disarm(timer);
      armActionKeep(accountId, entry);
      return value;
    } catch (err) {
      timer = disarm(timer);
      if (entry != null) await closeEntry(accountId, entry);
      throw toMailError(err);
    }
  }

  /**
   * The keychain may have changed under us (a new app password): end the run in flight, drop both
   * connections so the next factory call reads the secret again, and start the worker over through
   * the same preparation a manual sync does — so a claim is re-checked and a signed-out account is
   * retried and marked active again. A resolved promise means "nothing to do here" (stopped, or the
   * claim still stands).
   */
  async function restartAccount(accountId) {
    if (!live()) return undefined;
    const account = await getAccount(db, accountId);
    if (!account) throw new MailError("NOT_FOUND", "account");
    const worker = workerFor(account);
    // One synchronous step, before anything below awaits: the run in flight belongs to the OLD
    // password, so it is ended here, before its connection is closed, exactly as `stop()` ends one.
    // Its rejection — the close that follows is what causes it — is then ignored by executeRun: no
    // failure count, no back-off and no notice, so nothing is armed that could delay the fresh sync
    // this restart is about to start (which would keep using the old secret). Bumping the epoch on its
    // own would leave that run in flight and still open for as long as the borrowed adapter's close
    // takes, and a failure surfacing in that window would look current to its own handler.
    supersede(worker);
    closeOutRun(worker);
    await closeActionAdapter(accountId);
    worker.backoffTimer = disarm(worker.backoffTimer);
    // The request that run was still carrying is dropped rather than drained: the fresh run below is
    // a full sync and covers it.
    clearPending(worker);
    await closeWorkerAdapter(worker);
    worker.tick = 0;

    let prepared;
    try {
      prepared = await prepare(accountId, { resume: true });
    } catch (err) {
      // A claim that still stands is not an error here: there is nothing for this instance to do.
      if (toMailError(err).code === "CLAIMED_ELSEWHERE") return undefined;
      throw err;
    }
    if (prepared == null || !live()) return undefined;
    return startRun(prepared, { kind: "account" });
  }

  /* --------------------------------------------------------------------- public */

  /**
   * Everything a caller needs before syncing by hand: the account must exist and be ours. A claimed
   * account is only synced when its claim has cleared; `resume` is the owner's own nudge, which
   * clears a stored back-off and retries a signed-out account. Null when the supervisor is stopped.
   */
  async function prepare(accountId, { resume }) {
    // A stopped supervisor opens nothing and writes nothing: callers read null as "nothing to do".
    if (!live()) return null;
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

  /**
   * Sync one account now. A run already going is joined (and will be followed by one more). Resolves
   * when the run settles and never rejects because the sync failed: a failure is reported in
   * `status()` and `mail_sync_state`, not thrown at the caller who asked for it (plan 2's callers
   * read `status()`). After `stop()` it is a no-op.
   *
   * A caller joined to a run that `restartAccount` ends resolves at the restart, not when the fresh
   * full sync that follows settles: the fresh run covers the joined caller's request.
   */
  async function syncNow(accountId) {
    const worker = await prepare(accountId, { resume: true });
    if (worker == null || !live()) return undefined;
    return startRun(worker, { kind: "account" });
  }

  /**
   * Sync the given folders now, or the whole account when none were named. Like `syncNow` it
   * resolves when the run settles and never rejects because the sync failed (read `status()`), and
   * after `stop()` it is a no-op.
   */
  async function requestSync(accountId, { folderIds } = {}) {
    const worker = await prepare(accountId, { resume: false });
    if (worker == null || !live()) return undefined;
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
      supersede(worker);
      worker.pollTimer = disarm(worker.pollTimer);
      worker.backoffTimer = disarm(worker.backoffTimer);
      stopWatcher(worker);
      clearPending(worker);
      closeOutRun(worker);
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