/**
 * boot/mail-boot.js — decide whether this gateway runs Crow Mail's sync supervisor, build it, and
 * publish it where the private API can find it.
 *
 * Three things gate it, and all three are read here rather than in the supervisor: `CROW_MAIL=1`
 * (the feature flag), a real dashboard gateway (`--no-auth` runs no owner's mail), and
 * `CROW_DISABLE_MAIL_SYNC !== "1"`. Behind a closed gate nothing is built at all — no adapter
 * factory, no credentials reader, no supervisor, no claim lookup — so an instance that never turned
 * mail on opens no connection and writes no row.
 *
 * When the gate is open this module:
 *
 *   1. reads the keychain (`createMailCredentials({db})`), which is the only plaintext path and is
 *      handed to the supervisor, which in turn hands it to the adapter factory;
 *   2. builds `adapterFactory({account, credentials})` — the pinned supervisor signature — as the real
 *      IMAP/SMTP adapter, with the rotation writer for an OAuth refresh token plan 5 will supply;
 *   3. wraps the claims module for the supervisor's two hooks. `makeIsClaimedElsewhere` answers
 *      `{claimed, instanceName}` while the supervisor tests `=== true`, so a loser is `true` from this
 *      side; `refreshClaim(db, address, …)` takes an address while the supervisor passes a whole
 *      account, so it is bound here with this instance's id and name. Claims are written when an
 *      account is connected (the API's route), never here — a refresh only rewrites our own live row;
 *   4. starts the supervisor WITHOUT awaiting the first full sync. `start()` already never throws and
 *      runs each account concurrently, so one unreachable server neither delays boot nor stops another
 *      account; the rejection is caught here anyway and logged as a code;
 *   5. calls `setMailApiRuntime({supervisor, adapterFactory})` so every later request shares this
 *      running supervisor instead of building its own;
 *   6. publishes the same supervisor to the send service (`setMailSendSupervisor`) and, only when
 *      `mailEnabled()`, registers the `mail-send` scheduler hook that delivers held and scheduled
 *      sends and the account-removal guard (`onAccountDeleting`, which cancels an account's unsent
 *      mail before its rows go). `stop()` unregisters both, clears the supervisor and then closes what
 *      it opened, so no tick outlives the connection it would borrow and no removal runs against a
 *      stopped mail service.
 *
 * `startMailSync` never throws: every failure is caught and reported through the log sink as an event
 * name and a MailError code, never as an error's text (a library's message can quote a server reply or
 * a username, and a password must never reach a log).
 *
 * One start at a time: the start in flight is published before its first await, so two concurrent
 * calls build one supervisor and receive the same handle. `stopMailSync` closes a gate that a start
 * still awaiting something checks after that await — it stops what it built and reports
 * `started: false` instead of publishing a supervisor the shutdown drain would not wait for.
 *
 * The handle it returns carries `stop()`: the supervisor is stopped (its timers, watchers and
 * connections), the API runtime is cleared, and a db client this module opened itself is closed.
 * `stop()` is idempotent, and the shutdown path in servers/gateway/index.js reaches it through
 * `stopMailSync()`, which stops whatever handle is current. `post-listen.js` is the only caller of
 * `startMailSync`, and it calls it after the server is listening.
 *
 * Every dependency is injectable (a supervisor factory, an adapter factory, a credentials reader, the
 * local instance, the clock and timers, the runtime setters) so the decision and the wiring are
 * testable without a gateway or a mailbox.
 */
import { createDbClient } from "../../db.js";
import { cleanPeerName } from "../../shared/peer-label.js";
import { createNotification } from "../../shared/notifications.js";
import { getInstance, getOrCreateLocalInstanceId } from "../instance-registry.js";
import { createImapSmtpAdapter } from "../mail/adapter/imap-smtp.js";
import { makeIsClaimedElsewhere, refreshClaim as refreshOwnClaimInDb } from "../mail/claims.js";
import { createMailCredentials, createRotationWriter } from "../mail/credentials.js";
import { ACCOUNT_REMOVED_REASON, transition } from "../mail/drafts/store.js";
import { mailEnabled } from "../mail/flag.js";
import { toMailError } from "../mail/errors.js";
import { onAccountDeleting } from "../mail/store/accounts.js";
import { createMailSupervisor, shouldRunMailSync } from "../mail/sync/supervisor.js";
import { registerMailSendHook } from "../mail/send/hook.js";
// The two attachment readers the sweep's own preflight needs (a thread attachment's raw bytes, and
// Crow storage's, which has no owner-checked read yet). Bound here to this start's db client and
// supervisor so a held or scheduled send resolves an attachment exactly as the routes do.
import { makeDraftReaders } from "../mail/drafts/readers.js";
import { setMailSendSupervisor } from "../mail/send/send-service.js";
import { clearMailApiRuntime, setMailApiRuntime } from "../routes/mail-api.js";

/** The current handle, so the shutdown path can reach the supervisor `startMailSync` started. */
let currentHandle = null;

/**
 * The start in flight, or null. Published before the first await so two concurrent calls build one
 * supervisor and hand back one handle instead of one each.
 */
let starting = null;

/**
 * Set by `stopMailSync` and cleared at the top of a start: a start that is still awaiting something
 * when shutdown begins must not publish a runtime or leave a supervisor running behind the drain.
 */
let shuttingDown = false;

/**
 * The mail-send scheduler hook this boot registered, or null. Kept here rather than in the handle
 * because the shutdown path reaches it through `stopMailSync` as well as through the handle's `stop()`.
 */
let currentMailSendHook = null;

/** Take back the scheduler hook this module registered, if any. Idempotent, and never a reason to fail. */
function stopMailSendHook() {
  const hook = currentMailSendHook;
  currentMailSendHook = null;
  if (hook == null) return;
  try {
    hook.unregister();
  } catch {
    // Unregistering is bookkeeping at shutdown; the process is going down either way.
  }
}

/** One log line: an event name and, when there is one, an allow-listed code. Nothing else. */
function defaultLog(line) {
  const event = typeof line?.event === "string" ? line.event : "event";
  const code = typeof line?.code === "string" ? ` ${line.code}` : "";
  const reason = typeof line?.reason === "string" ? ` ${line.reason}` : "";
  console.log(`[mail] ${event}${reason}${code}`);
}

/** Why the gate is closed, in the words the handle reports. */
function gateReason({ env, noAuth }) {
  if (!mailEnabled(env)) return "disabled";
  if (noAuth === true) return "no_auth";
  return "sync_disabled";
}

/** This instance's id and display name: given, computed by the caller, or read from the registry. */
async function resolveLocalInstance(db, given) {
  if (typeof given === "function") {
    const value = await given(db);
    return {
      instanceId: value?.instanceId ?? null,
      instanceName: cleanPeerName(value?.instanceName),
    };
  }
  if (given != null && typeof given === "object") {
    return {
      instanceId: given.instanceId ?? null,
      instanceName: cleanPeerName(given.instanceName),
    };
  }
  const instanceId = getOrCreateLocalInstanceId();
  let instanceName = "";
  try {
    instanceName = cleanPeerName((await getInstance(db, instanceId))?.name);
  } catch {
    // A missing registry row is not a reason to refuse to sync: the claim just carries no name.
    instanceName = "";
  }
  return { instanceId, instanceName };
}

/**
 * The production adapter factory, in the pinned supervisor shape: `({account, credentials})` in, an
 * adapter out. The credentials reader comes from the supervisor (it passes the reader it was built
 * with); the rotation writer stores a refresh token a provider rotates, and is inert on the password
 * path.
 */
function defaultAdapterFactory(credentials, tokenProvider) {
  const onTokenRotated = createRotationWriter(credentials);
  return function adapterFactory({ account, credentials: reader } = {}) {
    return createImapSmtpAdapter({
      account,
      credentials: reader ?? credentials,
      tokenProvider: typeof tokenProvider === "function" ? tokenProvider : null,
      onTokenRotated,
    });
  };
}

/**
 * The title of the one bell an account's removal rings. The text never carries an address, a subject
 * or a body, and the title says only which part of Crow is speaking (the schedule service's own
 * `MISSED_TITLE`, kept here too so this module needs no send or schedule service on its import path).
 */
export const MAIL_NOTIFICATION_TITLE = "Crow Mail";

/**
 * The bell a removal rings: it says what Crow did to the account's unsent mail and nothing about the
 * mail itself.
 *
 * TODO(copy): pending operator copy — the plan fixes no sentence for this bell.
 */
export const ACCOUNT_REMOVED_BELL_BODY = "Unsent mail for a removed account was cancelled.";

/**
 * The `fail_reason` a discarded draft carries once its account is gone (Q2 option 1: the mail is
 * cancelled and one bell says so).
 */
export const ACCOUNT_REMOVED_DISCARD_REASON = "Account removed";

/** The states a removal turns into `discarded`: everything still waiting on the person or on a tick. */
const REMOVABLE_DRAFT_STATES = Object.freeze(["draft", "failed", "missed", "holding", "scheduled"]);

/**
 * The account-removal guard (plan 3, Task 13; Q2 option 1: cancel the unsent mail and say so, never
 * block the removal). Registered with `onAccountDeleting`, so it runs before `deleteAccount` opens its
 * transaction, while the account and its drafts are still whole.
 *
 * In order:
 *
 *  1. every `draft|failed|missed|holding|scheduled` draft of the account becomes `discarded` through
 *     the store's guarded `transition()`, with the fixed reason above — a `holding` or `scheduled`
 *     one loses its tap seal in the same UPDATE, so nothing a person tapped can still go out;
 *  2. a row that is `sending` cannot be confirmed either way, so it becomes `unknown` with the
 *     `account_removed` reason, and so does every row that was already `unknown`. No reconcile can run
 *     for them (there is no adapter for an account that is gone), so the sweep skips them and the card
 *     keeps its "we could not confirm" line. A send still in flight can settle its own row by its
 *     `claim_token` after this, which is the honest outcome;
 *  3. one bell, `source: "mail"`, whose text carries no address, subject or body. A settings filter
 *     that drops the type (a null from `createNotification`) is fine: nothing depends on the bell;
 *  4. the drafts this hook discarded are deleted with their revisions, voice notes and comments — the
 *     `unknown` ones are kept, because they are the only thing that can still tell the person a
 *     message may have gone out. `sent` rows stay too: the daily retention prune owns them.
 *
 * Nothing here refuses and nothing here throws for a live draft: removal is never blocked. A draft row
 * that moves under the loop (a delivery claiming it, a person discarding it) simply fails its own
 * guarded write and is left as it is. `mark` is the run's own account of what it did.
 *
 * @param {object} db the crow.db client `deleteAccount` was handed
 * @param {string} accountId the account about to be removed
 * @param {{now?: number|(() => number), createNotification?: Function}} [deps] the test seam
 * @returns {Promise<{discarded: number, unknown: number, deleted: number}>}
 */
export async function guardAccountRemoval(db, accountId, deps = {}) {
  const result = { discarded: 0, unknown: 0, deleted: 0 };
  if (typeof accountId !== "string" || !accountId) return result;
  const clock = deps.now ?? Date.now;
  const read = Number(typeof clock === "function" ? clock() : clock);
  // A clock a caller injected badly is never a reason to block a removal: the system clock answers.
  const now = Number.isFinite(read) && read >= 0 ? Math.floor(read) : Date.now();
  const ring = typeof deps.createNotification === "function" ? deps.createNotification : createNotification;

  const { rows } = await db.execute({
    sql: "SELECT id, state, fail_reason FROM mail_drafts WHERE account_id = ?",
    args: [accountId],
  });
  for (const raw of rows) {
    const id = String(raw.id);
    const state = String(raw.state);
    if (REMOVABLE_DRAFT_STATES.includes(state)) {
      const moved = await transition(db, id, [state], "discarded",
        { fail_reason: ACCOUNT_REMOVED_DISCARD_REASON }, { now });
      if (moved) result.discarded += 1;
      continue;
    }
    if (state === "sending") {
      const moved = await transition(db, id, ["sending"], "unknown",
        { fail_reason: ACCOUNT_REMOVED_REASON }, { now });
      if (moved) result.unknown += 1;
      continue;
    }
    if (state === "unknown" && raw.fail_reason !== ACCOUNT_REMOVED_REASON) {
      // The reason is the row's own record that no check will ever run for it; a row that already
      // carries it is left alone, so a second guard on the same account changes nothing.
      const marked = await db.execute({
        sql: `UPDATE mail_drafts SET fail_reason = ?, updated_at = ?
               WHERE id = ? AND state = 'unknown' AND (fail_reason IS NULL OR fail_reason <> ?)`,
        args: [ACCOUNT_REMOVED_REASON, now, id, ACCOUNT_REMOVED_REASON],
      });
      if (marked.rowsAffected === 1) result.unknown += 1;
    }
  }

  if (result.discarded + result.unknown > 0) {
    // One bell for the account, and a filtered type or a failing creator is not a failed removal.
    try {
      await ring(db, {
        title: MAIL_NOTIFICATION_TITLE,
        body: ACCOUNT_REMOVED_BELL_BODY,
        type: "attention",
        source: "mail",
        priority: "normal",
      });
    } catch {
      // Nothing depends on the bell: the cards carry the states.
    }
  }

  // The drafts this hook discarded go with their revisions, voice notes and comments, in one
  // transaction. The `unknown` rows stay (with their own children): they are the only record that a
  // message may have gone out, and the card still has to be able to say so.
  const doomed = await db.execute({
    sql: "SELECT id FROM mail_drafts WHERE account_id = ? AND state = 'discarded'",
    args: [accountId],
  });
  if (doomed.rows.length) {
    result.deleted = await db.runTransaction((run) => {
      let deleted = 0;
      for (const raw of doomed.rows) {
        const id = String(raw.id);
        const removed = run({
          sql: "DELETE FROM mail_drafts WHERE id = ? AND state = 'discarded'",
          args: [id],
        });
        if (removed.rowsAffected !== 1) continue;
        run({ sql: "DELETE FROM mail_draft_comments WHERE draft_id = ?", args: [id] });
        run({ sql: "DELETE FROM mail_draft_voice WHERE draft_id = ?", args: [id] });
        run({ sql: "DELETE FROM mail_draft_revisions WHERE draft_id = ?", args: [id] });
        deleted += 1;
      }
      return deleted;
    });
  }
  return result;
}

/** The account-removal hook this module registered, or null. */
let currentAccountRemovalHook = null;

/** Register the removal guard once. Idempotent, so a restart does not stack the same hook twice. */
function startAccountRemovalHook() {
  if (currentAccountRemovalHook != null) return currentAccountRemovalHook;
  currentAccountRemovalHook = onAccountDeleting((db, accountId) => guardAccountRemoval(db, accountId));
  return currentAccountRemovalHook;
}

/** Take the removal guard back. Idempotent, and never a reason to fail a shutdown. */
function stopAccountRemovalHook() {
  const off = currentAccountRemovalHook;
  currentAccountRemovalHook = null;
  if (off == null) return;
  try {
    off();
  } catch {
    // Bookkeeping at shutdown; the process is going down either way.
  }
}

/** The gate is closed: a handle that says so and does nothing. */
function stoppedHandle(reason) {
  return {
    started: false,
    reason,
    supervisor: undefined,
    async stop() {},
  };
}

/**
 * Start Crow Mail's sync supervisor, if this process should run one at all.
 *
 * @param {object} [options]
 * @param {object} [options.db] the crow.db client; one is opened (and later closed) when absent
 * @param {object} [options.env] `process.env` by default
 * @param {boolean} [options.noAuth] the `--no-auth` gateway flag
 * @param {(line: object) => void} [options.log] receives `{event, code?}` lines only
 * @param {Function} [options.createSupervisor] `createMailSupervisor`; the test seam
 * @param {Function} [options.adapterFactory] `({account, credentials}) => adapter`
 * @param {object} [options.credentials] the keychain reader; `createMailCredentials({db})` by default
 * @param {string} [options.crowHome] passed to the keychain when this module builds the reader
 * @param {Function|null} [options.tokenProvider] OAuth provider (plan 5)
 * @param {object|Function} [options.localInstance] `{instanceId, instanceName}` or `(db) => …`
 * @param {Function} [options.now]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 * @param {Function} [options.random]
 * @param {Function} [options.notify] `(title, body) => Promise`
 * @param {Function} [options.openDb] `createDbClient`; used only when `db` is absent
 * @param {Function} [options.setRuntime]
 * @param {Function} [options.clearRuntime]
 * @returns {Promise<{started: boolean, supervisor?: object, reason?: string, stop: Function}>}
 *   never rejects
 */
export async function startMailSync(options = {}) {
  // One supervisor per process: a second call adopts the running handle, or joins the start already
  // in flight, instead of opening a second worker per account (the boot path calls this once, and the
  // tests must not leak one into the next).
  if (currentHandle != null && currentHandle.started === true) return currentHandle;
  if (starting != null) return starting;
  const attempt = beginStart(options);
  starting = attempt;
  try {
    return await attempt;
  } finally {
    if (starting === attempt) starting = null;
  }
}

/** The body of one start, after the module-level gate that keeps it to one at a time. */
async function beginStart(options) {
  const noAuth = options.noAuth === true;
  const log = typeof options.log === "function" ? options.log : defaultLog;
  const openDb = typeof options.openDb === "function" ? options.openDb : createDbClient;
  const publishRuntime = typeof options.setRuntime === "function" ? options.setRuntime : setMailApiRuntime;
  const unpublishRuntime = typeof options.clearRuntime === "function"
    ? options.clearRuntime
    : clearMailApiRuntime;

  const env = options.env ?? process.env;
  // A start re-opens the gate a shutdown closed, whatever the previous start left behind.
  shuttingDown = false;
  // A log sink that throws is never a reason to fail boot or a shutdown.
  const say = (line) => {
    try {
      log(line);
    } catch {
      // Nothing to say about a sink that cannot take a line.
    }
  };

  if (!shouldRunMailSync({ env, noAuth })) {
    const reason = gateReason({ env, noAuth });
    say({ event: "not_started", reason });
    return stoppedHandle(reason);
  }

  let db = options.db ?? null;
  let ownsDb = false;
  let supervisor = null;

  /** Undo what this start built: stop its supervisor and close a db client it opened itself. */
  async function unwind() {
    if (supervisor != null && typeof supervisor.stop === "function") {
      try {
        await supervisor.stop();
      } catch {
        // The start is being abandoned; a stop that fails too changes nothing.
      }
    }
    if (ownsDb && db != null) {
      try {
        db.close();
      } catch {
        // As above.
      }
    }
    if (currentHandle != null && currentHandle.supervisor === supervisor) currentHandle = null;
  }

  try {
    if (db == null) {
      db = openDb();
      ownsDb = true;
    }
    const credentials = options.credentials
      ?? createMailCredentials({ db, crowHome: options.crowHome });
    const adapterFactory = typeof options.adapterFactory === "function"
      ? options.adapterFactory
      : defaultAdapterFactory(credentials, options.tokenProvider);
    const local = await resolveLocalInstance(db, options.localInstance);
    // Shutdown may have started while this awaited: nothing is built for a process that is going down.
    if (shuttingDown) {
      await unwind();
      say({ event: "not_started", reason: "shutting_down" });
      return stoppedHandle("shutting_down");
    }

    // The supervisor's hooks, in its own shapes (see the module comment): a strict boolean for the
    // claim check, and a one-account refresh bound to this instance's id and name.
    const claimOf = makeIsClaimedElsewhere(db, { localInstanceId: local.instanceId });
    const isClaimedElsewhere = async (account) => (await claimOf(account)).claimed === true;
    const refreshClaim = async (account) => {
      if (account == null || typeof account.address !== "string" || account.address === "") return;
      await refreshOwnClaimInDb(db, account.address, {
        localInstanceId: local.instanceId,
        instanceName: local.instanceName,
      });
    };

    const supervisorOptions = {
      db,
      credentials,
      adapterFactory,
      isClaimedElsewhere,
      refreshClaim,
      log: (line) => {
        say(line && typeof line === "object" ? line : { event: "event" });
      },
    };
    for (const key of ["now", "setTimer", "clearTimer", "random", "notify"]) {
      if (options[key] !== undefined) supervisorOptions[key] = options[key];
    }
    const createSupervisor = typeof options.createSupervisor === "function"
      ? options.createSupervisor
      : createMailSupervisor;
    supervisor = createSupervisor(supervisorOptions);

    // The last check before anything is published: a supervisor built while shutdown began is
    // stopped here rather than handed a first sync the drain will not wait for.
    if (shuttingDown) {
      await unwind();
      say({ event: "not_started", reason: "shutting_down" });
      return stoppedHandle("shutting_down");
    }

    const handle = {
      started: true,
      supervisor,
      reason: undefined,
      stopped: false,
      stop,
    };
    currentHandle = handle;

    // The routes read the runtime per request, so this must happen before the first account is
    // reachable from the API.
    publishRuntime({ supervisor, adapterFactory });

    // Started, not awaited: a first full sync can run for minutes, and `start()` already runs each
    // account on its own and never throws. A rejection is caught here all the same and logged by code.
    Promise.resolve()
      .then(() => supervisor.start())
      .catch((err) => say({ event: "start_failed", code: toMailError(err).code }));

    // The send service's own defaults (`withAdapter`, `requestSync`) are this running supervisor's, so
    // held and scheduled sends deliver through the same borrowed connections the sync uses.
    setMailSendSupervisor(supervisor);

    // The scheduler tick that delivers those sends is registered only when mail is really on: behind a
    // closed gate nothing registers, and an instance that never turned mail on never looks at a draft
    // table. Its claim answer is the wrapper above, whose shape is `{claimed, instanceName}` — the
    // supervisor's own copy of it is the strict boolean underneath.
    if (mailEnabled(env)) {
      // The account-removal guard rides the same gate as the tick: with mail off there are no drafts
      // to cancel, and a removal must not go looking at tables a mail-free box never built.
      startAccountRemovalHook();
      if (currentMailSendHook == null) {
        try {
          currentMailSendHook = registerMailSendHook(db, {
            isClaimedElsewhere: claimOf,
            ...makeDraftReaders({ db, supervisor }),
          });
        } catch (err) {
          // A hook that cannot register is a gateway without scheduled sends, never a failed boot.
          say({ event: "hook_failed", code: toMailError(err).code });
        }
      }
    }

    say({ event: "started" });
    return handle;

    /** Stop the supervisor, clear the runtime and close what this module opened. Idempotent. */
    async function stop() {
      if (handle.stopped === true) return;
      handle.stopped = true;
      if (currentHandle === handle) currentHandle = null;
      // The hook first: no tick may reach a supervisor this stop is taking away, or a db it closes.
      stopMailSendHook();
      stopAccountRemovalHook();
      try {
        if (typeof supervisor.stop === "function") await supervisor.stop();
      } catch (err) {
        say({ event: "stop_failed", code: toMailError(err).code });
      }
      setMailSendSupervisor(null);
      try {
        unpublishRuntime();
      } catch {
        // Clearing the runtime is bookkeeping: it must not fail a shutdown.
      }
      if (ownsDb) {
        try {
          db.close();
        } catch {
          // Already closed is the only failure a client this module owns can have here.
        }
      }
    }
  } catch (err) {
    const code = toMailError(err).code;
    say({ event: "start_failed", code });
    await unwind();
    return stoppedHandle("error");
  }
}

/**
 * Stop the supervisor `startMailSync` started, if there is one. The gateway's shutdown path calls
 * this beside `stopScheduler()`, so no timer, watcher or connection outlives the drain window.
 *
 * A start still in flight is told to shut down here (it then stops what it built and reports
 * `started: false`); this returns whether a handle was there to stop, so it is `false` for that case.
 *
 * @returns {Promise<boolean>} whether a handle was there to stop
 */
export async function stopMailSync() {
  // Set before the handle is read: a start cannot slip a handle in after this line, because every
  // await in it is followed by a `shuttingDown` check.
  shuttingDown = true;
  const handle = currentHandle;
  currentHandle = null;
  if (handle == null) {
    // Nothing was started, so nothing may still point at a supervisor or a hook.
    stopMailSendHook();
    stopAccountRemovalHook();
    setMailSendSupervisor(null);
    return false;
  }
  await handle.stop();
  return true;
}