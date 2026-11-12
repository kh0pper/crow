/**
 * Crow Mail's IMAP adapter: the one implementation of the provider-neutral contract that talks to a
 * real mail server. `imapflow` carries the protocol, this module carries the policy — the login, the
 * deadline on every command, the honest `uidNext`, and the rule that no library sentence and no
 * credential ever leaves it.
 *
 * What this file will not do, and where each refusal comes from:
 *
 * - **TLS is never negotiable.** `tls.rejectUnauthorized` is `true` on every connection and nothing
 *   in the account row can change it; `ssl` means implicit TLS and `starttls` means `doSTARTTLS: true`,
 *   so a stripped STARTTLS capability aborts the connection instead of sending the password in
 *   cleartext. `none` is only what the account store already allows for a server on this machine, and
 *   this module checks that itself: a cleartext sign-in to any host that is not loopback is refused
 *   before a socket exists.
 * - **Nothing is logged.** `logger: false` and `emitLogs: false`, and this module has no console call
 *   of its own, so a credential cannot reach a log even by accident.
 * - **Every connection has an `error` listener before `connect()`.** imapflow emits `error` when a
 *   server drops an idle session, and an unhandled `error` event takes the whole gateway process with
 *   it. The listener marks that connection dead and closes it; a read connection then rejects its
 *   next call instead of silently reconnecting, and a watch reports once and ends (reconnecting is the
 *   supervisor's decision, not the adapter's).
 * - **Every command is raced against `commandMs`.** The expiry closes the socket, which is the only
 *   reliable way to unblock a server that answered nothing, and the call rejects TIMEOUT.
 * - **At most three connections.** One read connection, plus one IDLE connection per watched folder,
 *   and `watch` takes at most two folders (Inbox and Sent); a third folder, or a second watcher, is
 *   BAD_INPUT rather than a silent extra TLS session.
 * - **Every failure is a fixed sentence.** A library or socket error becomes a MailError through the
 *   shared classifier, so imapflow's `response`, `command` and `message` — which quote the server and
 *   the username — never travel. imapflow's own `*_TIMEOUT` codes are TIMEOUT rather than PROTOCOL, a
 *   mailbox the server says does not exist is NOT_FOUND, and every command path runs its rejection
 *   through the same wrapper so no raw library error can escape from a listing, a fetch or a search.
 *   One fault is deliberately not a MailError: a keychain key that is not on this machine
 *   (`KEYCHAIN_KEY_MISSING`) travels unchanged, because it is the key's fault rather than a bad
 *   password, and reporting it as AUTH_FAILED would send the owner to reset a working password.
 *
 * `list` filters `afterUid`, `beforeUid` and `fromUid` itself instead of trusting the server: a UID
 * search from a UID past the mailbox's own range still answers with the last message, so the range the
 * server was asked for and the range the caller asked for are not the same thing. `uidNext` is read
 * from the SELECT, then from `STATUS (UIDNEXT)`, and only then from the highest UID seen, because the
 * sync engine advances `highest_uid` to `uidNext - 1`.
 *
 * `saveDraft` and `send` are declared and refuse until the SMTP task fills them in, so `assertAdapter`
 * accepts this implementation and the contract can run with those two steps skipped.
 *
 * @typedef {import("./interface.js").AdapterFolder} AdapterFolder
 * @typedef {import("./interface.js").AdapterItem} AdapterItem
 * @typedef {import("./interface.js").AdapterListing} AdapterListing
 * @typedef {import("./interface.js").AdapterMessage} AdapterMessage
 * @typedef {import("./interface.js").AdapterDraftRef} AdapterDraftRef
 * @typedef {import("./interface.js").AdapterSendResult} AdapterSendResult
 * @typedef {import("./interface.js").OutgoingMessage} OutgoingMessage
 */
import { ImapFlow } from "imapflow";
import { MailError, toMailError } from "../errors.js";
import { authFor } from "../credentials.js";
import { assertAdapter } from "./interface.js";
import { MAX_RAW_BYTES } from "../parse.js";

/** The wall-clock budget per phase, in milliseconds. */
const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 15_000,
  greetingMs: 15_000,
  socketMs: 60_000,
  commandMs: 120_000,
});

/** Inbox and Sent are the two folders the supervisor idles on, so a watch never exceeds that. */
const MAX_WATCH_FOLDERS = 2;

/** UIDs per FETCH. A listing can carry a whole window, and one command line has a length limit. */
const FETCH_CHUNK = 200;

/** A remote search term longer than this is not a search, it is an attack on the server's parser. */
const MAX_QUERY_CHARS = 1000;

/** How long `close()` waits for a graceful LOGOUT before it drops the socket. */
const CLOSE_TIMEOUT_MS = 2000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SECURITIES = new Set(["ssl", "starttls", "none"]);

/** The only hosts a cleartext (`security: "none"`) sign-in may reach: this machine, and only it. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Headroom above `maxRawBytes` for one IMAP literal, so a message at the cap still fits its framing. */
const LITERAL_HEADROOM = 1024 * 1024;

/** A response line longer than this is a server that never sent a line terminator. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * One `get()` call downloads at most this many times `maxRawBytes` of raw data. The engine batches,
 * so a call that would exceed it reports the rest in a later call rather than holding them all.
 */
const GET_BUDGET_FACTOR = 4;

/** imapflow's own timeout codes, which the shared classifier does not know by name. */
const IMAP_TIMEOUT_CODES = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]);

/** A keychain key fault is not a mail failure: it travels unchanged so the caller can say so. */
const KEYCHAIN_KEY_MISSING = "KEYCHAIN_KEY_MISSING";

const META_QUERY = Object.freeze({ uid: true, flags: true, internalDate: true, size: true });
const SOURCE_QUERY = Object.freeze({ uid: true, source: true });

/* ------------------------------------------------------------------------------ helpers */

/**
 * The bracketed response code (RFC 3501 `[NONEXISTENT]`) a refusal carries. It is read as one fixed
 * token out of the parsed reply — the reply's free text is never touched — so nothing of the server's
 * sentence can ride along with it.
 */
function responseCodeOf(err) {
  if (err == null || typeof err !== "object") return "";
  if (typeof err.responseCode === "string" && err.responseCode.trim()) {
    return err.responseCode.trim().toUpperCase();
  }
  const response = err.response;
  const section = response != null && typeof response === "object" && response.attributes &&
    response.attributes[0] && response.attributes[0].section;
  const value = section && section[0] && typeof section[0].value === "string" ? section[0].value : "";
  return value.trim().toUpperCase();
}

/** A mailbox that is not there: imapflow marks it on the SELECT failure, or the server named it. */
function isMissingMailbox(err) {
  if (err == null || typeof err !== "object") return false;
  return err.mailboxMissing === true || responseCodeOf(err) === "NONEXISTENT";
}

/**
 * A library error as a MailError, except two cases that must keep their meaning: a MailError passes
 * through, and a missing keychain key is the key's fault rather than the server's. imapflow's
 * `*_TIMEOUT` codes are the socket and greeting deadlines, so they are TIMEOUT and not PROTOCOL; a
 * refused mailbox is NOT_FOUND rather than PROTOCOL, so the caller can say the folder is gone; a
 * STARTTLS upgrade that could not happen is TLS, because that is the protection it lost.
 */
function asMailError(err) {
  if (err instanceof MailError) return err;
  if (err != null && typeof err === "object" && err.code === KEYCHAIN_KEY_MISSING) return err;
  if (isMissingMailbox(err)) return new MailError("NOT_FOUND");
  if (err != null && typeof err === "object" && err.tlsFailed === true) {
    return new MailError("TLS", err.code);
  }
  if (err != null && typeof err === "object" && IMAP_TIMEOUT_CODES.has(err.code)) {
    return new MailError("TIMEOUT", err.code);
  }
  return toMailError(err);
}

/** Close a connection the way the failure paths need it: never throws, never waits. */
function safeClose(client) {
  if (!client) return;
  try {
    client.close();
  } catch {
    // the socket is already gone; there is nothing left to close
  }
}

/**
 * Race one unit of work against a deadline. On expiry the connection is closed — a server that never
 * answers will not answer `DONE` either, so the socket is the only thing that unblocks the caller —
 * and the call rejects TIMEOUT. The raced promise keeps its rejection handler either way.
 */
function withDeadline(run, ms, onExpire, detail) {
  let timer = null;
  const expiry = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timer = null;
      try {
        onExpire();
      } catch {
        // closing a broken connection must not replace the reason it was closed
      }
      reject(new MailError("TIMEOUT", detail));
    }, ms);
  });
  return Promise.race([Promise.resolve().then(run), expiry]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function normalizeTimeouts(overrides) {
  if (overrides == null) return { ...DEFAULT_TIMEOUTS };
  if (typeof overrides !== "object") throw new TypeError("timeouts must be an object");
  const timeouts = { ...DEFAULT_TIMEOUTS };
  for (const key of Object.keys(DEFAULT_TIMEOUTS)) {
    const value = overrides[key];
    if (value == null) continue;
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`timeouts.${key} must be a positive integer`);
    timeouts[key] = value;
  }
  return timeouts;
}

/**
 * A path Crow will run a command for, or `null` when the value is not one: empty, oversized, or
 * carrying a control character no folder name has. A server that lists such a name offers nothing
 * Crow can select, so the caller skips it instead of quoting it into a command.
 */
function safeFolderPath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!path || path.length > 1024 || CONTROL_CHARS.test(path)) return null;
  return path;
}

/**
 * The same rule for a name the server itself listed, without the trim a caller's argument gets: the
 * name has to be used exactly as the server wrote it, or the next command selects another mailbox.
 */
function listedFolderPath(value) {
  if (typeof value !== "string") return null;
  if (!value || value.length > 1024 || CONTROL_CHARS.test(value)) return null;
  return value;
}

function requireFolderPath(value, detail = "folder") {
  const path = safeFolderPath(value);
  if (path == null) throw new MailError("BAD_INPUT", detail);
  return path;
}

function optionalUid(value, name, min) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < min) throw new MailError("BAD_INPUT", name);
  return value;
}

function chunks(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

/** An INTERNALDATE as epoch ms: imapflow hands back a Date, or the server's own text if V8 could not
 * read it — and an unreadable date is 0 rather than NaN, so a filter never drops a row by accident. */
function internalTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return Number.isFinite(value) ? Number(value) : 0;
}

/** One FETCH row as the contract's `AdapterItem`; a server field that is missing is not a NaN. */
function toItem(message) {
  return {
    uid: Number(message.uid),
    flags: message.flags ? [...message.flags] : [],
    internalDate: internalTime(message.internalDate),
    size: Number.isFinite(message.size) ? Number(message.size) : 0,
  };
}

function normalizeListOptions(options) {
  if (options == null) return normalizeListOptions({});
  if (typeof options !== "object") throw new MailError("BAD_INPUT", "options");

  const afterUid = optionalUid(options.afterUid, "afterUid", 0);
  const fromUid = optionalUid(options.fromUid, "fromUid", 1);
  const beforeUid = optionalUid(options.beforeUid, "beforeUid", 1);
  const limit = optionalUid(options.limit, "limit", 1);

  let sinceDate = null;
  if (options.sinceDate != null) {
    const value = options.sinceDate instanceof Date ? options.sinceDate.getTime() : options.sinceDate;
    if (!Number.isFinite(value)) throw new MailError("BAD_INPUT", "sinceDate");
    sinceDate = Number(value);
  }

  // One UID range carries every bound: the server narrows, the adapter then filters what came back.
  let lowUid = 1;
  if (afterUid != null) lowUid = Math.max(lowUid, afterUid + 1);
  if (fromUid != null) lowUid = Math.max(lowUid, fromUid);
  const highUid = beforeUid == null ? null : beforeUid - 1;

  return {
    afterUid,
    fromUid,
    beforeUid,
    sinceDate,
    limit,
    newestFirst: options.newestFirst === true,
    lowUid,
    highUid,
    empty: highUid != null && highUid < lowUid,
  };
}

function requireSearchQuery(value) {
  if (typeof value !== "string") throw new MailError("BAD_INPUT", "query");
  const query = value.trim();
  if (!query || query.length > MAX_QUERY_CHARS || CONTROL_CHARS.test(query)) {
    throw new MailError("BAD_INPUT", "query");
  }
  return query;
}

function requireUidList(value) {
  if (!Array.isArray(value)) throw new MailError("BAD_INPUT", "uids");
  const seen = new Set();
  const uids = [];
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || entry < 1) throw new MailError("BAD_INPUT", "uids");
    if (seen.has(entry)) continue;
    seen.add(entry);
    uids.push(entry);
  }
  return uids;
}

function requireWatchPaths(value) {
  if (!Array.isArray(value) || value.length === 0) throw new MailError("BAD_INPUT", "folder");
  const paths = [];
  for (const entry of value) {
    const path = requireFolderPath(entry);
    if (!paths.includes(path)) paths.push(path);
  }
  if (paths.length > MAX_WATCH_FOLDERS) throw new MailError("BAD_INPUT", "folders");
  return paths;
}

const isSelectable = (entry) => !(entry.flags instanceof Set && entry.flags.has("\\Noselect"));

/**
 * The IMAP adapter over one account.
 *
 * `clientFactory(options)` returns an ImapFlow-shaped client and is the test seam: everything below
 * calls it exactly once per connection, so a test can wrap the client without the adapter knowing.
 * `credentials` is the keychain reader from credentials.js and is the only place a plaintext secret is
 * read; `tokenProvider` is the OAuth provider contract and `onTokenRotated` receives a refresh token a
 * provider hands back.
 *
 * @param {object} options
 * @param {object} options.account a mail_accounts row (no secret field)
 * @param {object} [options.credentials] the keychain reader (`getSecrets`)
 * @param {Function|null} [options.tokenProvider] OAuth access-token provider
 * @param {Function|null} [options.onTokenRotated] receives a rotated refresh token
 * @param {Function|null} [options.clientFactory] `(options) => ImapFlow`, the test seam
 * @param {object|null} [options.timeouts] overrides for connect/greeting/socket/command budgets
 * @param {number} [options.maxRawBytes] a message above this is reported without its bytes
 */
export function createImapSmtpAdapter(options = {}) {
  const {
    account,
    credentials = null,
    tokenProvider = null,
    onTokenRotated = null,
    clientFactory = null,
    timeouts: timeoutOverrides = null,
    maxRawBytes = MAX_RAW_BYTES,
  } = options;

  if (account == null || typeof account !== "object" || Array.isArray(account)) {
    throw new TypeError("createImapSmtpAdapter needs an account row");
  }
  if (!Number.isFinite(maxRawBytes) || maxRawBytes < 1) {
    throw new TypeError("maxRawBytes must be a positive number of bytes");
  }

  const timeouts = normalizeTimeouts(timeoutOverrides);
  const rawLimit = Math.floor(maxRawBytes);
  const makeClient = typeof clientFactory === "function" ? clientFactory : (clientOptions) => new ImapFlow(clientOptions);

  /** The read connection: `{client, dead}` once open, plus its in-flight connect promise. */
  let readState = null;
  let readConnecting = null;
  let activeWatcher = null;
  let closed = false;

  /* --------------------------------------------------------------------- connecting */

  /**
   * The imapflow options for one sign-in. TLS validation is fixed here and cannot be influenced by the
   * account row: `ssl` is implicit TLS, `starttls` refuses to continue without the upgrade, and both
   * carry `rejectUnauthorized: true`. A cleartext sign-in is refused for every host but this machine's
   * loopback, before a socket is opened.
   */
  function clientOptions(auth) {
    const endpoint = account.imap;
    if (endpoint == null || typeof endpoint !== "object") throw new MailError("BAD_INPUT", "imap");
    const { host, port, security } = endpoint;
    if (typeof host !== "string" || !host) throw new MailError("BAD_INPUT", "imap_host");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError("BAD_INPUT", "imap_port");
    if (!SECURITIES.has(security)) throw new MailError("BAD_INPUT", "imap_security");
    if (security === "none" && !LOOPBACK_HOSTS.has(host.trim().toLowerCase())) {
      // No TLS here, so the password would travel in the clear: only a loopback address, where there
      // is no wire to listen on, may be reached this way.
      throw new MailError("BAD_INPUT", "imap_security");
    }

    // The parser's own bounds, so a server cannot make Crow buffer what Crow would never keep: one
    // literal sits at the raw cap plus the framing headroom, one response total sits above the
    // literal cap (as the parser documents), and a line without a terminator is stopped a few MiB in.
    const maxLiteralSize = rawLimit + LITERAL_HEADROOM;

    const options_ = {
      host,
      port,
      secure: security === "ssl",
      auth: auth.accessToken
        ? { user: auth.user, accessToken: auth.accessToken }
        : { user: auth.user, pass: auth.pass },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      tls: { rejectUnauthorized: true },
      connectionTimeout: timeouts.connectMs,
      greetingTimeout: timeouts.greetingMs,
      socketTimeout: timeouts.socketMs,
      maxLiteralSize,
      maxResponseSize: maxLiteralSize + LITERAL_HEADROOM,
      maxLineLength: MAX_LINE_BYTES,
    };
    if (security === "starttls") options_.doSTARTTLS = true;
    if (security === "none") options_.doSTARTTLS = false;
    return options_;
  }

  /**
   * One connection, signed in, with its `error` listener attached before `connect()` runs. A refused
   * OAuth sign-in is retried once with a forced token refresh; nothing else is retried, because a bad
   * password must not be hammered at the server.
   *
   * `onDead` is called once per connection when it errors or closes, and never receives any library
   * text — only a MailError built from an allow-listed code.
   */
  async function openClient(onDead = () => {}) {
    let retried = false;
    for (;;) {
      let auth;
      try {
        auth = await authFor(account, {
          credentials,
          tokenProvider,
          forceRefresh: retried,
          rotation: typeof onTokenRotated === "function"
            // The writer is awaited: a writer that rejects is caught by authFor (which reports it as
            // `rotationFailed`) instead of escaping as an unhandled rejection of a dropped promise.
            ? async (accountId, { refreshToken } = {}) => { await onTokenRotated(refreshToken); }
            : undefined,
        });
      } catch (err) {
        throw asMailError(err);
      }

      // authFor reports a failed rotation write as `rotationFailed` rather than throwing, because the
      // access token in hand is the one this connection signs in with. The sign-in therefore goes
      // ahead, and the writer's own failure text is never read, kept or reported here.
      const connectOptions = clientOptions(auth);
      let client;
      try {
        client = makeClient(connectOptions);
      } catch (err) {
        throw asMailError(err);
      }
      if (client == null || typeof client.on !== "function" || typeof client.connect !== "function") {
        throw new MailError("PROTOCOL", "client_factory");
      }

      const state = { client, dead: null };
      // RF8: before connect(), so a drop while idle or during the handshake is never an unhandled
      // `error` event. The first MailError wins, so a server sentence can never be the one kept.
      client.on("error", (err) => {
        const mail = state.dead ?? asMailError(err);
        state.dead = mail;
        safeClose(client);
        onDead(state, mail);
      });
      client.on("close", () => {
        const mail = state.dead ?? new MailError("NETWORK");
        state.dead = mail;
        onDead(state, mail);
      });

      try {
        await withDeadline(
          () => client.connect(),
          timeouts.commandMs,
          () => safeClose(client),
          "connect_deadline",
        );
        if (!client.usable) throw state.dead ?? new MailError("NETWORK");
        return state;
      } catch (err) {
        const mail = state.dead ?? asMailError(err);
        safeClose(client);
        const canRefresh = !retried && mail.code === "AUTH_FAILED" &&
          account.authKind === "xoauth2" && typeof tokenProvider === "function";
        if (!canRefresh) throw mail;
        retried = true;
      }
    }
  }

  /** The read connection, opened once. A dead one stays dead and rejects; it is not re-dialled. */
  async function readConnection() {
    if (closed) throw new MailError("NETWORK", "closed");
    if (readState) {
      if (readState.dead) throw readState.dead;
      if (readState.client && readState.client.usable) return readState;
      readState.dead = new MailError("NETWORK");
      throw readState.dead;
    }
    if (!readConnecting) {
      readConnecting = (async () => {
        const state = await openClient((deadState) => safeClose(deadState.client));
        if (closed) {
          safeClose(state.client);
          throw new MailError("NETWORK", "closed");
        }
        if (state.dead) throw state.dead;
        readState = state;
        return state;
      })();
    }
    const pending = readConnecting;
    try {
      return await pending;
    } finally {
      if (readConnecting === pending) readConnecting = null;
    }
  }

  /**
   * One command group on the read connection, under the command deadline. Every rejection leaves as a
   * MailError: a listing, a fetch or a search that fails reports a fixed sentence and an allow-listed
   * code, never the library error — whose `response`, `responseText` and `executedCommand` quote the
   * server and the command line.
   */
  async function runCommand(work) {
    try {
      const state = await readConnection();
      if (state.dead) throw state.dead;
      return await withDeadline(
        () => work(state.client, state),
        timeouts.commandMs,
        () => {
          state.dead = state.dead ?? new MailError("TIMEOUT", "command_deadline");
          safeClose(state.client);
        },
        "command_deadline",
      );
    } catch (err) {
      throw asMailError(err);
    }
  }

  /** The UIDNEXT of the open mailbox, from the SELECT, then STATUS, then the highest UID seen. */
  async function uidNextFor(client, path, box, seenUids) {
    const fromSelect = Number(box && box.uidNext);
    if (Number.isSafeInteger(fromSelect) && fromSelect > 0) return fromSelect;
    let status = null;
    try {
      status = await client.status(path, { uidNext: true });
    } catch (err) {
      const mail = asMailError(err);
      // A dead connection is the caller's failure; only a refused STATUS falls back to the UID guess.
      if (mail.code !== "PROTOCOL") throw mail;
    }
    const fromStatus = Number(status && status.uidNext);
    if (Number.isSafeInteger(fromStatus) && fromStatus > 0) return fromStatus;
    // A loop rather than `Math.max(...seenUids)`: a large mailbox would spread the whole array into
    // the argument list, and a uid that is not a safe integer must not turn the answer into NaN.
    let highest = 0;
    for (const uid of seenUids) {
      if (Number.isSafeInteger(uid) && uid > highest) highest = uid;
    }
    return highest + 1;
  }

  /* ------------------------------------------------------------------------ the contract */

  async function connect() {
    if (closed) throw new MailError("NETWORK", "closed");
    if (readState && readState.dead) throw readState.dead;
    await readConnection();
  }

  async function close() {
    if (closed) return;
    closed = true;
    const watcher = activeWatcher;
    activeWatcher = null;
    if (watcher) {
      try {
        watcher.stop();
      } catch {
        // a watcher that is already gone needs no second stop
      }
    }
    // A connect that is still in flight owns a socket no other path can reach yet. It closes that
    // socket itself the moment it settles (the `closed` check in readConnection), and its rejection is
    // handled here so a close() during a connect leaves no unhandled promise behind.
    const connecting = readConnecting;
    readConnecting = null;
    if (connecting) connecting.catch(() => {});
    const state = readState;
    readState = null;
    if (!state || !state.client) return;
    try {
      await withDeadline(
        () => state.client.logout(),
        CLOSE_TIMEOUT_MS,
        () => safeClose(state.client),
        "logout_deadline",
      );
    } catch {
      safeClose(state.client);
    }
  }

  /**
   * Every folder the server lists, minus the names Crow will not run a command for: a path carrying a
   * control character is skipped rather than reported and later quoted into a SELECT.
   *
   * @returns {Promise<AdapterFolder[]>}
   */
  async function listFolders() {
    return runCommand(async (client) => {
      const entries = await client.list();
      if (!Array.isArray(entries)) throw new MailError("PROTOCOL", "list");
      const folders = [];
      for (const entry of entries) {
        const path = listedFolderPath(entry.path);
        if (path == null) continue;
        const specialUse = entry.specialUse ?? null;
        if (specialUse != null && (typeof specialUse !== "string" || CONTROL_CHARS.test(specialUse))) continue;
        folders.push({
          path,
          name: typeof entry.name === "string" ? entry.name : path,
          specialUse,
          delimiter: typeof entry.delimiter === "string" ? entry.delimiter : "/",
          selectable: isSelectable(entry),
        });
      }
      return folders;
    });
  }

  /**
   * One folder's messages as UIDs, flags, internal dates and sizes.
   *
   * @param {string} folderPath
   * @param {{sinceDate?: number|Date, afterUid?: number, beforeUid?: number, fromUid?: number,
   *   limit?: number, newestFirst?: boolean}} [options]
   * @returns {Promise<AdapterListing>}
   */
  async function list(folderPath, options = {}) {
    const path = requireFolderPath(folderPath);
    const opts = normalizeListOptions(options);
    return runCommand(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        const box = client.mailbox || {};
        const uidValidity = Number(box.uidValidity);
        if (!Number.isSafeInteger(uidValidity) || uidValidity <= 0) {
          throw new MailError("PROTOCOL", "uidvalidity");
        }

        let uids = [];
        if (!opts.empty) {
          const query = { uid: `${opts.lowUid}:${opts.highUid == null ? "*" : opts.highUid}` };
          if (opts.sinceDate != null) query.since = new Date(opts.sinceDate);
          const found = await client.search(query, { uid: true });
          if (found === false) throw new MailError("PROTOCOL", "search_refused");
          if (!Array.isArray(found)) throw new MailError("PROTOCOL", "search");
          uids = found
            .map((uid) => Number(uid))
            .filter((uid) => Number.isSafeInteger(uid) && uid > 0);
        }

        const items = [];
        for (const chunk of chunks(uids, FETCH_CHUNK)) {
          for await (const message of client.fetch(chunk.join(","), META_QUERY, { uid: true })) {
            const item = toItem(message);
            // A row whose UID is not a positive safe integer names no message Crow could store or ask
            // for again, so it is dropped here and never reaches `uidNext` or the caller.
            if (!Number.isSafeInteger(item.uid) || item.uid < 1) continue;
            items.push(item);
          }
        }

        // The server's SINCE is day-granular and its UID range can answer past the bound (a UID search
        // from past the end answers with the last message), so the caller's bounds are applied to what
        // came back. INTERNALDATE carries whole seconds — RFC 3501 has no fractional part — so the date
        // bound is as exact as the server can report, which is what the contract's caller needs.
        const filtered = items.filter((item) => {
          if (opts.afterUid != null && item.uid <= opts.afterUid) return false;
          if (opts.fromUid != null && item.uid < opts.fromUid) return false;
          if (opts.beforeUid != null && item.uid >= opts.beforeUid) return false;
          if (opts.sinceDate != null && item.internalDate < opts.sinceDate) return false;
          return true;
        });
        filtered.sort((left, right) => (opts.newestFirst ? right.uid - left.uid : left.uid - right.uid));
        const limited = opts.limit == null ? filtered : filtered.slice(0, opts.limit);

        return {
          uidValidity,
          uidNext: await uidNextFor(client, path, box, items.map((item) => item.uid)),
          items: limited,
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * The raw bytes of the UIDs the caller asked for. A UID the mailbox does not have is absent; a
   * message above `maxRawBytes` is reported with its metadata and an empty Buffer, so the engine can
   * store a `too_large` row without Crow ever holding the bytes. That covers both a message the server
   * *reported* above the limit (its body is never asked for) and one that arrives larger than the size
   * the server gave (the bytes are dropped as they arrive).
   *
   * One call downloads at most `GET_BUDGET_FACTOR × maxRawBytes` of raw data. A UID that does not fit
   * that budget is **absent from the result** — not reported with an empty Buffer, so it cannot be
   * mistaken for an oversized message — and the caller asks for it again in a later call.
   *
   * @param {string} folderPath
   * @param {number[]} uids
   * @returns {Promise<AdapterMessage[]>}
   */
  async function get(folderPath, uids) {
    const path = requireFolderPath(folderPath);
    const wanted = requireUidList(uids);
    if (wanted.length === 0) return [];
    const budget = rawLimit * GET_BUDGET_FACTOR;
    return runCommand(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        const meta = new Map();
        for (const chunk of chunks(wanted, FETCH_CHUNK)) {
          for await (const message of client.fetch(chunk.join(","), META_QUERY, { uid: true })) {
            const item = toItem(message);
            if (!Number.isSafeInteger(item.uid) || item.uid < 1) continue;
            meta.set(item.uid, item);
          }
        }

        // Ask only for the bodies the reported sizes say fit this call's budget, in UID order; a
        // server that under-reports is caught below, on the bytes that actually arrived.
        const candidates = [...meta.values()]
          .filter((item) => item.size <= rawLimit)
          .sort((left, right) => left.uid - right.uid);
        const attempts = [];
        let planned = 0;
        for (const item of candidates) {
          if (planned + item.size > budget) break;
          attempts.push(item.uid);
          planned += item.size;
        }
        const attempted = new Set(attempts);
        const absent = new Set(candidates.filter((item) => !attempted.has(item.uid)).map((item) => item.uid));

        const raws = new Map();
        let used = 0;
        let stoppedAt = null;
        download: for (const chunk of chunks(attempts, FETCH_CHUNK)) {
          for await (const message of client.fetch(chunk.join(","), SOURCE_QUERY, { uid: true })) {
            const uid = Number(message.uid);
            if (!meta.has(uid)) continue;
            const source = Buffer.isBuffer(message.source) ? message.source : Buffer.alloc(0);
            if (source.length > rawLimit) {
              // The server's reported size was below the real one: the bytes are dropped here and the
              // message is reported as oversized, exactly like one the server admitted to.
              raws.set(uid, Buffer.alloc(0));
              continue;
            }
            if (used + source.length > budget) {
              // This body would take the call past its budget: it and every larger UID are left out,
              // so the caller asks for them again rather than Crow holding them in this call.
              stoppedAt = uid;
              break download;
            }
            used += source.length;
            raws.set(uid, source);
          }
        }
        if (stoppedAt != null) {
          for (const uid of attempts) {
            if (uid >= stoppedAt && !raws.has(uid)) absent.add(uid);
          }
        }

        const messages = [];
        for (const item of [...meta.values()].sort((left, right) => left.uid - right.uid)) {
          if (absent.has(item.uid)) continue;
          messages.push({
            uid: item.uid,
            flags: item.flags,
            internalDate: item.internalDate,
            raw: raws.get(item.uid) ?? Buffer.alloc(0),
          });
        }
        return messages;
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Server-side search by text, in one folder or across every selectable folder.
   *
   * @param {string} query
   * @param {{folderPath?: string, limit?: number}} [options]
   * @returns {Promise<{folderPath: string, uid: number}[]>}
   */
  async function search(query, options = {}) {
    const text = requireSearchQuery(query);
    const opts = options == null ? {} : options;
    if (typeof opts !== "object") throw new MailError("BAD_INPUT", "options");
    const folderPath = opts.folderPath == null ? null : requireFolderPath(opts.folderPath);
    const limit = optionalUid(opts.limit, "limit", 1);

    return runCommand(async (client) => {
      let paths;
      if (folderPath) {
        paths = [folderPath];
      } else {
        const entries = await client.list();
        if (!Array.isArray(entries)) throw new MailError("PROTOCOL", "list");
        paths = [];
        for (const entry of entries) {
          if (!isSelectable(entry)) continue;
          // A listed name with a control character is not one Crow selects; it is skipped rather than
          // quoted into a command, the same rule `listFolders` applies to what it reports.
          const listed = listedFolderPath(entry.path);
          if (listed != null) paths.push(listed);
        }
      }

      const hits = [];
      for (const path of paths) {
        const lock = await client.getMailboxLock(path);
        try {
          const found = await client.search({ text }, { uid: true });
          if (found === false) throw new MailError("PROTOCOL", "search_refused");
          if (!Array.isArray(found)) continue;
          for (const uid of found) {
            const value = Number(uid);
            if (!Number.isSafeInteger(value) || value < 1) continue;
            hits.push({ folderPath: path, uid: value });
            if (limit != null && hits.length >= limit) return hits;
          }
        } finally {
          lock.release();
        }
      }
      return hits;
    });
  }

  /** Task 13 fills this in: the SMTP task appends the draft to the \Drafts folder. */
  async function saveDraft() {
    throw new MailError("PROTOCOL", "not_implemented");
  }

  /** Task 13 fills this in: the SMTP task builds and sends the message. */
  async function send() {
    throw new MailError("PROTOCOL", "not_implemented");
  }

  /**
   * Watch one or two folders over IDLE. Each folder is its own connection, because an IMAP session
   * idles in one selected mailbox; together with the read connection that is the three-connection
   * budget. A lost connection reports once through `onError` and ends the watcher — nothing here
   * reconnects, because back-off and retry are the supervisor's.
   *
   * @param {string[]} folderPaths
   * @param {{onChange?: Function, onError?: Function}} handlers
   * @returns {Promise<{stop: Function}>}
   */
  async function watch(folderPaths, handlers = {}) {
    if (closed) throw new MailError("NETWORK", "closed");
    const paths = requireWatchPaths(folderPaths);
    if (activeWatcher) throw new MailError("BAD_INPUT", "watch");
    const onChange = handlers && typeof handlers.onChange === "function" ? handlers.onChange : null;
    const onError = handlers && typeof handlers.onError === "function" ? handlers.onError : null;

    const sessions = [];
    let stopped = false;
    let failed = false;

    const handle = {
      stop() {
        if (stopped) return;
        stopped = true;
        if (activeWatcher === handle) activeWatcher = null;
        for (const session of sessions) safeClose(session.client);
      },
    };
    activeWatcher = handle;

    const reportError = (err) => {
      if (stopped || failed) return;
      failed = true;
      const mail = asMailError(err);
      handle.stop();
      if (!onError) return;
      try {
        onError(mail);
      } catch {
        // a caller's handler must not be able to break the adapter
      }
    };

    const emit = (folderPath, reason) => {
      if (stopped || failed || !onChange) return;
      try {
        onChange({ folderPath, reason });
      } catch {
        // as above: the handler's problem, not the connection's
      }
    };

    try {
      for (const folderPath of paths) {
        const session = { client: null, armed: false };
        const state = await openClient((deadState, mail) => {
          // A failure during setup is thrown by watch() itself; only an armed session reports.
          if (!session.armed) return;
          reportError(mail);
        });
        session.client = state.client;
        sessions.push(session);
        if (stopped) {
          safeClose(state.client);
          break;
        }

        state.client.on("exists", () => emit(folderPath, "exists"));
        state.client.on("expunge", () => emit(folderPath, "expunge"));
        state.client.on("flags", () => emit(folderPath, "flags"));

        await withDeadline(
          () => state.client.mailboxOpen(folderPath),
          timeouts.commandMs,
          () => safeClose(state.client),
          "watch_deadline",
        );
        session.armed = true;

        // IDLE does not resolve until it ends, so it is started and left running; a rejection is a
        // connection that went away, which the error listener has already reported.
        const idling = state.client.idle();
        if (idling && typeof idling.catch === "function") idling.catch((err) => reportError(err));
      }
    } catch (err) {
      const mail = asMailError(err);
      handle.stop();
      throw mail;
    }

    return handle;
  }

  return assertAdapter({
    connect,
    close,
    listFolders,
    list,
    get,
    search,
    saveDraft,
    send,
    watch,
  });
}