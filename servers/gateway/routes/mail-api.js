/**
 * Crow Mail's private JSON API: `/dashboard/mail/api`, owner-only, never via Funnel, and a 404 for
 * every route while `CROW_MAIL` is unset.
 *
 * Every request passes the same chain, in this order, and each step refuses before the next can read
 * anything:
 *
 *   1. `dashboardAuth` on this router's own prefix, so the API is closed wherever it is mounted.
 *   2. `Cache-Control: no-store` — a mailbox list or an address must not sit in a cache.
 *   3. the flag: `mailEnabled()` false answers 404 `{error:"not_found"}`, the same answer for every
 *      route, before a database client is opened.
 *   4. the owner: `isLocalPasswordSessionOn` (this machine's own password sign-in, from the owner's
 *      client). A peer's single-sign-on session, a session minted by a login on this machine, a
 *      signed peer call and this machine's own console all get 403 `{error:"owner_only"}` with no
 *      data; no row is read before the verdict.
 *   5. this router's own `express.json({limit:"64kb"})`: a bigger body is 413 `{error:"too_large"}` and
 *      a malformed one 400 `{error:"bad_input"}`, from here rather than from the gateway's global 1mb
 *      parser (the path is in `servers/gateway/index.js`'s `_hasOwnParser`, so the global parser never
 *      sees a mail body first).
 *
 * Errors are JSON `{error, message}`. A mail failure carries its MailError code and the fixed sentence
 * from `MAIL_ERROR_TEXT`; the request-shape answers carry the codes the plan names (`not_found`,
 * `owner_only`, `too_large`, `bad_input`, `duplicate_address`). A library's `message`, a server's reply,
 * a password and a username never reach a response or a log line: a failed route logs its code only.
 *
 * CSRF is the dashboard's `csrfMiddleware`, which already guards every unsafe method on this mount, so
 * no route here handles a token itself.
 *
 * Dependencies arrive two ways, and a test may use either: through `deps`, or from the module-level set
 * `setMailApiRuntime({supervisor, adapterFactory})` makes when boot starts the supervisor (Task 21's
 * boot; `clearMailApiRuntime()` for tests and shutdown). What is absent falls back to the real thing:
 * a fresh `createDbClient()` per request closed in `finally`, `createMailCredentials({db})`, the real
 * IMAP/SMTP adapter factory, and this instance's own id and registry name. A route that needs a
 * supervisor skips it when none is set (a manual sync answers "not started", a connect stores the
 * account and starts no background sync) — it never throws because sync is not running.
 */
import { Router, json as jsonParserOf } from "express";
import { createDbClient } from "../../db.js";
import { cleanPeerName } from "../../shared/peer-label.js";
import { recordServiceSecretValues } from "../../shared/secret-values.js";
import { withoutWriteContext } from "../../shared/history/write-context.js";
import { isLocalPasswordSessionOn } from "../dashboard/local-session.js";
import { getInstance, getOrCreateLocalInstanceId } from "../instance-registry.js";
import { createImapSmtpAdapter } from "../mail/adapter/imap-smtp.js";
import { accountsOverview } from "../mail/accounts-overview.js";
import { checkClaim, claimedElsewhereSentence, releaseClaim, writeClaim } from "../mail/claims.js";
import { createMailCredentials } from "../mail/credentials.js";
import { MailError, MAIL_ERROR_TEXT, toMailError } from "../mail/errors.js";
import { mailEnabled } from "../mail/flag.js";
import { probeAccount } from "../mail/probe.js";
import { createAccount, deleteAccount, getAccount, listAccounts, updateAccount } from "../mail/store/accounts.js";
import { listFolders } from "../mail/store/messages.js";
import { SKIP_SPECIAL_USE } from "../mail/sync/engine.js";
import { registerMessageRoutes } from "./mail-api-messages.js";

/** The mount point. The gateway's global JSON parser skips this prefix (see index.js `_hasOwnParser`). */
export const MAIL_API_PREFIX = "/dashboard/mail/api";

/** A mail account id, exactly what the account store mints. Anything else is a 404 here. */
export const MAIL_ACCOUNT_ID_RE = /^ma-[0-9a-f]{16}$/;

/** The status a mail failure answers with. A refused sign-in is the owner's input (400), not a fault. */
const STATUS_BY_CODE = Object.freeze({
  AUTH_FAILED: 400,
  BAD_INPUT: 400,
  NOT_FOUND: 404,
  CLAIMED_ELSEWHERE: 409,
  CHANGED: 409,
  TOO_LARGE: 413,
  TIMEOUT: 504,
  NETWORK: 502,
  TLS: 502,
  PROTOCOL: 502,
});

/** The answers that are not a MailError code. */
const FIXED_TEXT = Object.freeze({
  not_found: "Not found.",
  owner_only: "Only the owner can see this.",
  too_large: "That request is too large.",
  bad_input: "That request is not valid.",
  duplicate_address: "That address is already connected on this Crow.",
  keychain_key_missing: "The keychain key for this password is not on this machine.",
  internal: "Something went wrong.",
});

const SECURITIES = new Set(["ssl", "starttls", "none"]);
const PASSWORD_MAX = 1024;
const LABEL_MAX = 120;
const USERNAME_MAX = 254;
const HOST_MAX = 253;
const ADDRESS_MAX = 254;
const DIGEST_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const PATCH_FIELDS = new Set(["label", "localModelsOnly", "digestOptIn", "digestTime"]);
const SKIPPED_SPECIAL_USE = new Set(SKIP_SPECIAL_USE.map((flag) => flag.toLowerCase()));

/* ------------------------------------------------------------------- runtime */

/** What boot sets once, so every request shares the running supervisor and its adapter factory. */
let runtime = { supervisor: null, adapterFactory: null };

/**
 * The running supervisor and adapter factory (Task 21's boot calls this). Either may be null.
 * @param {{supervisor?: object|null, adapterFactory?: Function|null}} [options]
 */
export function setMailApiRuntime({ supervisor = null, adapterFactory = null } = {}) {
  runtime = { supervisor: supervisor ?? null, adapterFactory: typeof adapterFactory === "function" ? adapterFactory : null };
}

/** Forget the runtime: shutdown, and a test that must not inherit another test's supervisor. */
export function clearMailApiRuntime() {
  runtime = { supervisor: null, adapterFactory: null };
}

/* -------------------------------------------------------------- error shape */

function messageFor(code) {
  return MAIL_ERROR_TEXT[code] || FIXED_TEXT[code] || FIXED_TEXT.internal;
}

/** One JSON error. `message` is a fixed sentence, never a caller's or a library's text. */
function sendError(res, status, code, message = null) {
  if (res.headersSent) return;
  res.status(status).json({ error: code, message: message || messageFor(code) });
}

/** A thrown mail failure as its own code and sentence: never `err.message`, never a detail sentence. */
function sendMailError(res, err) {
  // The keychain's key-missing fault is not a mail error and must not be reported as a bad password;
  // its own fixed sentence says which fault it is, and carries no path and no value.
  if (err && err.code === "KEYCHAIN_KEY_MISSING") return sendError(res, 409, "keychain_key_missing");
  // Anything else that is not a MailError is this Crow's own fault — a database write that failed, say
  // — and it answers the internal sentence: a mail-server sentence would blame the wrong machine, and
  // the failure's own text is never repeated to anybody.
  if (!(err instanceof MailError)) return sendError(res, 500, "internal");
  sendError(res, STATUS_BY_CODE[err.code] ?? 500, err.code);
}

/** A route's failure in the log: the code only, so no value can travel with it. */
function logCode(route, err) {
  try {
    console.warn(`[mail-api] ${route}: ${toMailError(err).code}`);
  } catch {
    // A log line is never worth failing a request over.
  }
}

/* ------------------------------------------------------------- validation */

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL_CHARS_RE.test(trimmed)) return null;
  return trimmed;
}

/** One plain mailbox address: one `@`, no whitespace, no control characters, no angle brackets. */
function readPlainAddress(value) {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  if (!address || address.length > ADDRESS_MAX) return null;
  if (/[\s\u0000-\u001f\u007f<>]/.test(address)) return null;
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1) return null;
  return address;
}

function readEndpoint(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const host = typeof value.host === "string" ? value.host.trim().toLowerCase() : "";
  if (!host || host.length > HOST_MAX || /[\s\u0000-\u001f\u007f<>]/.test(host)) return null;
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
  if (!SECURITIES.has(value.security)) return null;
  return { host, port: value.port, security: value.security };
}

/** The connect body, or null. The account store validates it again; this is what keeps a probe from
 *  being opened for a shape the store would refuse. */
function readAccountInput(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  const label = cleanText(body.label, LABEL_MAX);
  if (!label) return null;
  const address = readPlainAddress(body.address);
  if (!address) return null;
  let username = null;
  if (body.username !== undefined && body.username !== null && body.username !== "") {
    if (typeof body.username !== "string") return null;
    const trimmed = body.username.trim();
    if (!trimmed || trimmed.length > USERNAME_MAX || /[\s\u0000-\u001f\u007f<>]/.test(trimmed)) return null;
    username = trimmed;
  }
  const password = body.password;
  if (typeof password !== "string" || password === "" || password.length > PASSWORD_MAX) return null;
  const imap = readEndpoint(body.imap);
  const smtp = readEndpoint(body.smtp);
  if (!imap || !smtp) return null;
  return { label, address, username, password, imap, smtp };
}

/** The settings body, or null on an unknown key or a value of the wrong type. */
function readAccountPatch(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!PATCH_FIELDS.has(key)) return null;
    if (key === "label") {
      const label = cleanText(value, LABEL_MAX);
      if (!label) return null;
      patch.label = label;
    } else if (key === "digestTime") {
      if (typeof value !== "string" || !DIGEST_TIME_RE.test(value)) return null;
      patch.digestTime = value;
    } else {
      if (typeof value !== "boolean") return null;
      patch[key] = value;
    }
  }
  return patch;
}

/* ------------------------------------------------------------------ helpers */

/** What a connect or a settings write answers with: the row's own fields, nothing derived, no secret. */
function accountSummary(account) {
  return {
    id: account.id,
    label: account.label,
    address: account.address,
    status: account.status,
    statusDetail: account.statusDetail,
    localModelsOnly: account.localModelsOnly,
    digestOptIn: account.digestOptIn,
    digestTime: account.digestTime,
  };
}

function isDuplicateAddress(err) {
  return err instanceof MailError && err.code === "BAD_INPUT" && err.detail === "address";
}

/**
 * Is this address already connected here? The same identity the store's UNIQUE COLLATE NOCASE column
 * enforces, checked before anything is dialled: a second account for one mailbox is the owner's input,
 * not a server's verdict, so the probe at the far end of the world need not be asked at all.
 */
async function addressTaken(db, address) {
  const wanted = String(address).trim().toLowerCase();
  for (const account of await listAccounts(db)) {
    if (String(account.address).trim().toLowerCase() === wanted) return true;
  }
  return false;
}

/** This instance's id and the name its own registry row carries (never an address or a mailbox host). */
async function defaultLocalInstance(db) {
  const instanceId = getOrCreateLocalInstanceId();
  let instanceName = "";
  try {
    const row = await getInstance(db, instanceId);
    instanceName = cleanPeerName(row?.name);
  } catch {
    instanceName = "";
  }
  return { instanceId, instanceName };
}

function localInstanceFor(db, deps) {
  if (typeof deps.localInstance === "function") return deps.localInstance(db);
  if (deps.localInstance != null) return Promise.resolve(deps.localInstance);
  return defaultLocalInstance(db);
}

function credentialsFor(db, deps) {
  if (deps.credentials != null) return deps.credentials;
  return createMailCredentials({ db });
}

function adapterFactoryFor(deps) {
  if (typeof deps.adapterFactory === "function") return deps.adapterFactory;
  if (typeof runtime.adapterFactory === "function") return runtime.adapterFactory;
  const tokenProvider = typeof deps.tokenProvider === "function" ? deps.tokenProvider : null;
  return ({ account, credentials }) => createImapSmtpAdapter({ account, credentials, tokenProvider });
}

/** The supervisor, or null: a build without sync running still serves reads and still connects. */
function supervisorFor(deps) {
  const supervisor = deps.supervisor !== undefined ? deps.supervisor : runtime.supervisor;
  return supervisor ?? null;
}

/**
 * A sync outlives the request that asked for it, so it is opened with no write context: otherwise
 * every row it wrote later would be attributed to the sign-in that happened to click Connect (see the
 * `withoutWriteContext` note in servers/gateway/dashboard/auth.js). Its failure is the supervisor's to
 * report, not this route's.
 */
function startBackgroundSync(deps, accountId) {
  const supervisor = supervisorFor(deps);
  if (!supervisor || typeof supervisor.syncNow !== "function") return;
  withoutWriteContext(() => {
    Promise.resolve()
      .then(() => supervisor.syncNow(accountId))
      .catch((err) => logCode("background_sync", err));
  });
}

/** Undo a connect that could not be finished: the secret, then the account. Best effort, code-logged. */
async function undoConnect(db, credentials, accountId) {
  try {
    await credentials.deleteSecrets(accountId);
  } catch (err) {
    logCode("undo_secret", err);
  }
  try {
    await deleteAccount(db, accountId);
  } catch (err) {
    logCode("undo_account", err);
  }
}

async function releaseClaimQuietly(db, address, localInstanceId) {
  try {
    await releaseClaim(db, address, { localInstanceId });
  } catch (err) {
    logCode("undo_claim", err);
  }
}

/**
 * Retire the account's sync worker BEFORE its rows go, and wait for it: the worker's run, timers,
 * watcher and both of its connections are gone by the time this resolves, so nothing of the deleted
 * account can write an orphan folder, message or sync state afterwards, or send a notice about it.
 *
 * The call is opened with no write context — the worker's own writes long outlive this request — and
 * it never throws: a supervisor without the call, or one whose stop failed, must not hold up a delete
 * the owner asked for. A supervisor that is not running simply has nothing to stop.
 */
async function stopWorkerForDelete(deps, accountId) {
  const supervisor = supervisorFor(deps);
  if (!supervisor || typeof supervisor.stopAccount !== "function") return;
  try {
    await withoutWriteContext(() => supervisor.stopAccount(accountId));
  } catch (err) {
    logCode("delete_worker", err);
  }
}

/**
 * The same, for the other half of the delete: while the id is in the supervisor's removal set no
 * worker, run or borrowed adapter may be built for it, so a `syncNow`, a `requestSync` or a
 * `withAdapter` that lands between the stop and the rows' removal cannot write after the delete (no
 * mail table row carries a foreign key). Both calls are optional and never throw: a supervisor from an
 * older build, or a fake one, must not hold up a delete.
 */
function beginRemovalFor(deps, accountId) {
  const supervisor = supervisorFor(deps);
  if (!supervisor || typeof supervisor.beginRemoval !== "function") return false;
  try {
    supervisor.beginRemoval(accountId);
    return true;
  } catch (err) {
    logCode("delete_removal_begin", err);
    return false;
  }
}

function endRemovalFor(deps, accountId, started) {
  if (started !== true) return;
  const supervisor = supervisorFor(deps);
  if (!supervisor || typeof supervisor.endRemoval !== "function") return;
  try {
    supervisor.endRemoval(accountId);
  } catch (err) {
    logCode("delete_removal_end", err);
  }
}

/* -------------------------------------------------------------------- router */

/**
 * The mail API router.
 *
 * @param {Function} dashboardAuth the dashboard's auth middleware
 * @param {{openDb?: Function, adapterFactory?: Function, supervisor?: object|null,
 *   credentials?: object, localInstance?: object|Function, tokenProvider?: Function,
 *   recordSecrets?: Function, ownerCheck?: Function}} [deps]
 *   `openDb` mints the request's crow.db client; `recordSecrets(values)` records masked values and
 *   defaults to `recordServiceSecretValues`; `ownerCheck` defaults to `isLocalPasswordSessionOn`.
 * @returns {import("express").Router}
 */
export function mailApiRouter(dashboardAuth, deps = {}) {
  const router = Router();
  const openDb = typeof deps.openDb === "function" ? deps.openDb : () => createDbClient();
  const ownerCheck = typeof deps.ownerCheck === "function" ? deps.ownerCheck : isLocalPasswordSessionOn;
  const recordSecrets = typeof deps.recordSecrets === "function" ? deps.recordSecrets : recordServiceSecretValues;
  // 64KB is generous for a connect (an address, two endpoints, a password) and small enough that a
  // mailbox body never travels through this route. The 413 and the 400 are this router's own.
  const jsonParser = jsonParserOf({ limit: "64kb" });

  /** One client per request, closed in `finally`; a handler that throws answers its MailError code. */
  const route = (label, handler) => async (req, res) => {
    const db = openDb();
    try {
      await handler(db, req, res);
    } catch (err) {
      logCode(label, err);
      sendMailError(res, err);
    } finally {
      try {
        db.close();
      } catch {
        // Already closed is the only failure a per-request client has here.
      }
    }
  };

  router.use(MAIL_API_PREFIX, dashboardAuth);

  /** Never cached: a mailbox list or an address must not sit in a cache. */
  const guardHeaders = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };

  /** The flag: one answer for every route, and no database client is opened for it. */
  const flagGuard = (req, res, next) => {
    if (!mailEnabled()) return sendError(res, 404, "not_found");
    next();
  };

  /** The owner: this instance's own password session, from the owner's own client. No row is read
   *  before the verdict, so a refused request carries no data at all. */
  const ownerGuard = async (req, res, next) => {
    const db = openDb();
    try {
      let owner = false;
      try {
        owner = (await ownerCheck(db, req)) === true;
      } catch {
        owner = false;
      }
      if (!owner) return sendError(res, 403, "owner_only");
      next();
    } finally {
      try {
        db.close();
      } catch {
        // Already closed is the only failure a per-request client has here.
      }
    }
  };

  router.use(MAIL_API_PREFIX, guardHeaders);
  router.use(MAIL_API_PREFIX, flagGuard);
  router.use(MAIL_API_PREFIX, ownerGuard);
  router.use(MAIL_API_PREFIX, jsonBodyParser(jsonParser));

  /* ------------------------------------------------------------------ reads */

  // GET /accounts — the owner's accounts and the addresses held elsewhere, both without a hash.
  router.get(`${MAIL_API_PREFIX}/accounts`, route("GET /accounts", async (db, req, res) => {
    const local = await localInstanceFor(db, deps);
    res.json(await accountsOverview(db, { localInstanceId: local.instanceId }));
  }));

  // GET /accounts/:id/folders — the folders the reader's drawer shows, without the virtual ones.
  router.get(`${MAIL_API_PREFIX}/accounts/:id/folders`, route("GET /accounts/:id/folders", async (db, req, res) => {
    const id = String(req.params.id);
    if (!MAIL_ACCOUNT_ID_RE.test(id)) return sendError(res, 404, "not_found");
    const account = await getAccount(db, id);
    if (!account) return sendError(res, 404, "not_found");
    const folders = await listFolders(db, id);
    res.json({
      folders: folders
        .filter((folder) => !isSkippedFolder(folder))
        .map((folder) => ({
          id: folder.id,
          path: folder.path,
          name: folder.name ?? folder.path,
          role: folder.role,
          unreadCount: folder.unreadCount,
          totalCount: folder.totalCount,
        })),
    });
  }));

  /* ------------------------------------------------------------------ writes */

  // POST /accounts — a duplicate is refused before anything dials, the probe comes before anything is
  // stored, then one claim; a claim that is lost afterwards is undone whole, so an address is never
  // half-connected.
  router.post(`${MAIL_API_PREFIX}/accounts`, route("POST /accounts", async (db, req, res) => {
    const input = readAccountInput(req.body);
    if (!input) return sendError(res, 400, "bad_input");
    // Before the probe and before the secret is even masked: one mailbox is one account here, and the
    // store's own identity rule (lower-cased) is this rule.
    if (await addressTaken(db, input.address)) return sendError(res, 409, "duplicate_address");
    const local = await localInstanceFor(db, deps);

    // The new password joins the masking set before any path can write it to a log. A recorder that
    // cannot write its file is logged by code and must not fail the connect or echo the value.
    try {
      await recordSecrets([input.password]);
    } catch (err) {
      logCode("record_secret", err);
    }

    const claim = await checkClaim(db, input.address, { localInstanceId: local.instanceId });
    if (!claim.ok) return sendError(res, 409, "CLAIMED_ELSEWHERE", claimedElsewhereSentence(claim.instanceName));

    // Before anything is stored: a refused sign-in leaves no account, no secret and no claim behind.
    await probeAccount({
      adapterFactory: adapterFactoryFor(deps),
      account: probeRow(input),
      credentials: probeCredentials(input.password),
    });

    let account;
    try {
      account = await createAccount(db, {
        label: input.label,
        address: input.address,
        username: input.username,
        authKind: "password",
        imap: input.imap,
        smtp: input.smtp,
      });
    } catch (err) {
      if (isDuplicateAddress(err)) return sendError(res, 409, "duplicate_address");
      throw err;
    }

    const credentials = credentialsFor(db, deps);
    try {
      await credentials.saveSecret(account.id, "MAIL_PASSWORD", input.password);
      await writeClaim(db, input.address, { localInstanceId: local.instanceId, instanceName: local.instanceName });
    } catch (err) {
      await undoConnect(db, credentials, account.id);
      throw err;
    }

    // A claim written a moment ago can still lose to one another instance wrote concurrently: the
    // winner is computed from the whole set, and on a loss nothing of this connect may remain.
    const after = await checkClaim(db, input.address, { localInstanceId: local.instanceId });
    if (!after.ok) {
      await undoConnect(db, credentials, account.id);
      await releaseClaimQuietly(db, input.address, local.instanceId);
      return sendError(res, 409, "CLAIMED_ELSEWHERE", claimedElsewhereSentence(after.instanceName));
    }

    startBackgroundSync(deps, account.id);
    res.status(201).json({ account: accountSummary(account) });
  }));

  // PATCH /accounts/:id — only the settings a person edits here.
  router.patch(`${MAIL_API_PREFIX}/accounts/:id`, route("PATCH /accounts/:id", async (db, req, res) => {
    const id = String(req.params.id);
    if (!MAIL_ACCOUNT_ID_RE.test(id)) return sendError(res, 404, "not_found");
    const patch = readAccountPatch(req.body);
    if (!patch) return sendError(res, 400, "bad_input");
    const account = await updateAccount(db, id, patch);
    if (!account) return sendError(res, 404, "not_found");
    res.json({ account: accountSummary(account) });
  }));

  // DELETE /accounts/:id — the id is marked as being removed, then the worker (awaited: its run,
  // timers, watcher and both of its connections are gone before the rows are touched), then the rows,
  // the secret and the claim; the mark goes in a `finally`, so a delete that fails still frees the id. A
  // keychain or claim failure after the row is gone is logged by code: the secret of a deleted account
  // is never served again, and a claim row that cannot be tombstoned still expires with this
  // instance's liveness.
  router.delete(`${MAIL_API_PREFIX}/accounts/:id`, route("DELETE /accounts/:id", async (db, req, res) => {
    const id = String(req.params.id);
    if (!MAIL_ACCOUNT_ID_RE.test(id)) return sendError(res, 404, "not_found");
    const account = await getAccount(db, id);
    if (!account) return sendError(res, 404, "not_found");
    const local = await localInstanceFor(db, deps);
    const credentials = credentialsFor(db, deps);

    const removalBegan = beginRemovalFor(deps, id);
    try {
      await stopWorkerForDelete(deps, id);
      const removed = await deleteAccount(db, id);
      try {
        await credentials.deleteSecrets(id);
      } catch (err) {
        logCode("delete_secret", err);
      }
      await releaseClaimQuietly(db, account.address, local.instanceId);
      res.json({ ok: true, messages: removed.messages });
    } finally {
      endRemovalFor(deps, id, removalBegan);
    }
  }));

  // POST /accounts/:id/sync — the owner's nudge. The run is the supervisor's; the answer says whether
  // one was started, never the sync's own outcome (the panel reads status for that).
  router.post(`${MAIL_API_PREFIX}/accounts/:id/sync`, route("POST /accounts/:id/sync", async (db, req, res) => {
    const id = String(req.params.id);
    if (!MAIL_ACCOUNT_ID_RE.test(id)) return sendError(res, 404, "not_found");
    const account = await getAccount(db, id);
    if (!account) return sendError(res, 404, "not_found");
    const supervisor = supervisorFor(deps);
    const started = Boolean(supervisor && typeof supervisor.syncNow === "function");
    if (started) startBackgroundSync(deps, id);
    res.status(started ? 202 : 200).json({ ok: true, started });
  }));

  // Task 20 fills the mailbox routes on this same router, with these same guards and helpers.
  registerMessageRoutes(router, {
    guards: { flag: flagGuard, owner: ownerGuard },
    openDb,
    credentials: (db) => credentialsFor(db, deps),
    supervisor: () => supervisorFor(deps),
    adapterFactory: adapterFactoryFor(deps),
    localInstance: (db) => localInstanceFor(db, deps),
    sendError,
    sendMailError,
    logCode,
    route,
  });

  return router;
}

/** A folder the sync engine skips (a server's virtual view of mail stored in a real folder). */
function isSkippedFolder(folder) {
  const specialUse = typeof folder.specialUse === "string" ? folder.specialUse : "";
  if (!specialUse) return false;
  return specialUse.split(/\s+/).some((token) => SKIPPED_SPECIAL_USE.has(token.trim().toLowerCase()));
}

/** The account row a probe connects: the values just typed, with no stored id behind them. */
function probeRow(input) {
  return {
    id: "probe",
    label: input.label,
    address: input.address,
    username: input.username,
    authKind: "password",
    imap: input.imap,
    smtp: input.smtp,
  };
}

/** The credentials reader a probe is handed: the password just typed, for that one connect. */
function probeCredentials(password) {
  return { getSecrets: async () => ({ MAIL_PASSWORD: password }) };
}

/** A body above 64KB is `too_large`; anything else the parser refuses is `bad_input`. Neither answer
 *  repeats the parser's own message. */
function jsonBodyParser(parser) {
  return (req, res, next) => parser(req, res, (err) => {
    if (!err) return next();
    const status = Number(err.status || err.statusCode || 0);
    if (status === 413 || err.type === "entity.too.large") return sendError(res, 413, "too_large");
    return sendError(res, 400, "bad_input");
  });
}

export default mailApiRouter;