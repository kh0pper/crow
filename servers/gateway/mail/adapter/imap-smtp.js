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
 * - **A send has one deadline for the whole exchange.** `sendMs` covers the sign-in, the connect, the
 *   greeting and the transmission, and the same deadline travels in the nodemailer message as its
 *   `signal`. nodemailer's `socketTimeout` measures silence, so a server that dribbles one response
 *   line per second never trips it; the deadline is what ends such a send.
 * - **At most three connections.** One read connection, plus one IDLE connection per watched folder,
 *   and `watch` takes at most two folders (Inbox and Sent); a third folder, or a second watcher, is
 *   BAD_INPUT rather than a silent extra TLS session.
 * - **Every failure is a fixed sentence.** A library or socket error becomes a MailError through the
 *   shared classifier, so imapflow's `response`, `command` and `message` — which quote the server and
 *   the username — never travel. imapflow's own `*_TIMEOUT` codes are TIMEOUT rather than PROTOCOL, a
 *   mailbox the server says does not exist is NOT_FOUND, and every command path runs its rejection
 *   through the same wrapper so no raw library error can escape from a listing, a fetch or a search.
 *   One fault is deliberately not a MailError: a keychain key that is not on this machine
 *   (`KeychainKeyMissingError`) travels unchanged, because it is the key's fault rather than a bad
 *   password, and reporting it as AUTH_FAILED would send the owner to reset a working password.
 *
 * `list` filters `afterUid`, `beforeUid` and `fromUid` itself instead of trusting the server: a UID
 * search from a UID past the mailbox's own range still answers with the last message, so the range the
 * server was asked for and the range the caller asked for are not the same thing. `uidNext` is read
 * from the SELECT, then from `STATUS (UIDNEXT)`, and only then from the highest UID seen, because the
 * sync engine advances `highest_uid` to `uidNext - 1`.
 *
 * `send` is the one path by which a message leaves Crow, and it is the strictest one. `validateOutgoing`
 * runs before a transport exists — a refused message therefore opens no socket — and the nodemailer
 * message is built from its returned fields and from nothing else: no caller-supplied header map, no
 * file or URL source, no attachment key beyond a filename, a media type and the bytes, one transport
 * kind (never a pooled one), `disableFileAccess` and `disableUrlAccess` both closed, `logger` and
 * `debug` both off. nodemailer derives the SMTP recipient list from the To/Cc/Bcc headers it is handed
 * and leaves Bcc out of the bytes it transmits, so a blind recipient is delivered without being
 * published. The Message-ID is generated here as `<random@sender-domain>`, with the domain taken from
 * the From address, and handed to nodemailer as the message's id, so the copy Crow stores and the copy
 * the server relays carry the same one. TLS follows the account's SMTP security exactly as the IMAP
 * side follows its own, a recipient the server refuses comes back in `rejected` instead of as an
 * error, and every failure is a fixed sentence through the same classifier.
 *
 * `saveDraft` appends the caller's bytes to the `\Drafts` folder over the read connection, inside the
 * command deadline and its error wrapping, with `\Draft` and `\Seen` set; a mailbox without a
 * `\Drafts` folder is NOT_FOUND rather than a note filed in some folder Crow chose by name.
 *
 * @typedef {import("./interface.js").AdapterFolder} AdapterFolder
 * @typedef {import("./interface.js").AdapterItem} AdapterItem
 * @typedef {import("./interface.js").AdapterListing} AdapterListing
 * @typedef {import("./interface.js").AdapterMessage} AdapterMessage
 * @typedef {import("./interface.js").AdapterDraftRef} AdapterDraftRef
 * @typedef {import("./interface.js").AdapterSendResult} AdapterSendResult
 * @typedef {import("./interface.js").OutgoingMessage} OutgoingMessage
 */
import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { MailError, toMailError } from "../errors.js";
import { authFor } from "../credentials.js";
import { KeychainKeyMissingError } from "../../keychain/store.js";
import { assertAdapter, validateOutgoing } from "./interface.js";
import { MAX_RAW_BYTES } from "../parse.js";

/**
 * The wall-clock budget per phase, in milliseconds. `sendMs` is not a phase but a send's whole
 * exchange — sign-in included — because nothing shorter bounds a server that keeps talking.
 */
const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 15_000,
  greetingMs: 15_000,
  socketMs: 60_000,
  commandMs: 120_000,
  sendMs: 300_000,
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

/**
 * The special-use flag that names the drafts mailbox, lower-cased because RFC 6154 flags are
 * case-insensitive, and the flags a saved draft carries.
 */
const DRAFTS_SPECIAL_USE = "\\drafts";
const DRAFT_FLAGS = Object.freeze(["\\Draft", "\\Seen"]);

/** A domain a Message-ID can carry: what is left of the From domain once nothing else survives. */
const MESSAGE_ID_DOMAIN_STRIP = /[^A-Za-z0-9.-]/g;
const MESSAGE_ID_FALLBACK_DOMAIN = "localhost";
const MESSAGE_ID_MAX_DOMAIN = 253;

/** Headroom above `maxRawBytes` for one IMAP literal, so a message at the cap still fits its framing. */
const LITERAL_HEADROOM = 1024 * 1024;

/**
 * A response line longer than this is a server that never sent a line terminator. It is generous
 * because a SEARCH over a large mailbox answers with every matching UID on one line.
 */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * One `get()` call downloads at most this many times `maxRawBytes` of raw data. The engine batches,
 * so a call that would exceed it reports the rest in a later call rather than holding them all.
 */
const GET_BUDGET_FACTOR = 4;

/** imapflow's own timeout codes, which the shared classifier does not know by name. */
const IMAP_TIMEOUT_CODES = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]);

/** TLS failures arrive as socket codes with these prefixes, the same list the shared classifier uses. */
const TLS_CODE_RE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO|UNABLE_TO_VERIFY|SELF_SIGNED)/;

/** The response codes a server refuses a message by for its size: RFC 7889 and RFC 4469. */
const TOO_LARGE_CODES = new Set(["APPENDLIMIT", "TOOBIG"]);

const META_QUERY = Object.freeze({ uid: true, flags: true, internalDate: true, size: true });

/* ------------------------------------------------------------------------------ helpers */

/**
 * The response code (RFC 3501 `[NONEXISTENT]`, RFC 7889 `[APPENDLIMIT]`) a refusal carries. It is read
 * as one fixed token — imapflow's own `serverResponseCode`, a plain `responseCode`, or the parsed reply
 * section — and never from the reply's free text, so nothing of the server's sentence rides along.
 */
function responseCodeOf(err) {
  if (err == null || typeof err !== "object") return "";
  for (const value of [err.serverResponseCode, err.responseCode]) {
    if (typeof value === "string" && value.trim()) return value.trim().toUpperCase();
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
 * through, and a missing keychain key (a `KeychainKeyMissingError`) is the key's fault rather than the
 * server's. imapflow's `*_TIMEOUT` codes are the socket and greeting deadlines, so they are TIMEOUT
 * and not PROTOCOL; a refused mailbox is NOT_FOUND rather than PROTOCOL, so the caller can say the
 * folder is gone; a message the server refused for its size is TOO_LARGE; a STARTTLS upgrade that
 * could not happen is TLS, because that is the protection it lost, and so is a certificate OpenSSL
 * refused (nodemailer keeps that code in `originalCode` after overwriting `code` with `ESOCKET`). A
 * send the deadline cancelled is TIMEOUT rather than a protocol fault.
 */
function asMailError(err) {
  if (err instanceof MailError) return err;
  if (err instanceof KeychainKeyMissingError) return err;
  if (isMissingMailbox(err)) return new MailError("NOT_FOUND");
  const responseCode = responseCodeOf(err);
  if (TOO_LARGE_CODES.has(responseCode)) return new MailError("TOO_LARGE", responseCode);
  if (err != null && typeof err === "object" && err.tlsFailed === true) {
    return new MailError("TLS", err.code);
  }
  const originalCode = err != null && typeof err === "object" ? err.originalCode : null;
  if (typeof originalCode === "string" && TLS_CODE_RE.test(originalCode)) {
    return new MailError("TLS", originalCode);
  }
  if (err != null && typeof err === "object" && (err.code === "EABORT" || err.name === "AbortError")) {
    return new MailError("TIMEOUT", err.code === "EABORT" ? "EABORT" : "send_deadline");
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

/**
 * Await one step of a send under the send's one deadline. nodemailer honours the same signal by closing
 * its connection, and racing it here also bounds the sign-in, which nodemailer never sees. The losing
 * promise keeps a rejection handler, so a failure that arrives after the deadline cannot escape.
 */
function withSendDeadline(signal, run) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      finish(value);
    };
    function onAbort() {
      settle(reject, new MailError("TIMEOUT", "send_deadline"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    Promise.resolve().then(run).then(
      (value) => settle(resolve, value),
      (err) => settle(reject, err),
    );
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

/**
 * One endpoint of the account row (`imap` or `smtp`), checked here rather than trusted. The account
 * store refuses a malformed host, port or security value on the way in, and this checks again because
 * the same object can arrive from anywhere. A cleartext connection is loopback-only for the same reason
 * on both: there is no wire to listen on when both ends are this machine.
 *
 * @param {object} account a mail_accounts row
 * @param {"imap"|"smtp"} kind
 * @returns {{host: string, port: number, security: string}}
 */
function endpointFor(account, kind) {
  const endpoint = account == null ? null : account[kind];
  if (endpoint == null || typeof endpoint !== "object") throw new MailError("BAD_INPUT", kind);
  const { host, port, security } = endpoint;
  if (typeof host !== "string" || !host) throw new MailError("BAD_INPUT", `${kind}_host`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError("BAD_INPUT", `${kind}_port`);
  if (!SECURITIES.has(security)) throw new MailError("BAD_INPUT", `${kind}_security`);
  if (security === "none" && !LOOPBACK_HOSTS.has(host.trim().toLowerCase())) {
    // No TLS here, so the password would travel in the clear: only a loopback address, where there is
    // no wire to listen on, may be reached this way.
    throw new MailError("BAD_INPUT", `${kind}_security`);
  }
  return { host, port, security };
}

/**
 * A Message-ID this adapter owns: random local part, domain from the From address, both reduced to what
 * an id may carry. An internationalised domain is converted to its ASCII (punycode) form first, which
 * is the form other mail software compares; the strip then only removes what an id may not carry at
 * all. It is fixed here and handed to nodemailer as the message's id so the stored copy and the
 * transmitted copy agree, and nothing the caller sends can set it.
 *
 * @param {string} fromAddress the validated From addr-spec
 * @returns {string}
 */
export function messageIdFor(fromAddress) {
  const at = String(fromAddress).lastIndexOf("@");
  const rawDomain = at < 0 ? "" : String(fromAddress).slice(at + 1).toLowerCase();
  const asciiDomain = rawDomain ? domainToASCII(rawDomain) || "" : "";
  const domain = asciiDomain.replace(MESSAGE_ID_DOMAIN_STRIP, "");
  const host = domain && domain.length <= MESSAGE_ID_MAX_DOMAIN ? domain : MESSAGE_ID_FALLBACK_DOMAIN;
  return `<${randomBytes(16).toString("hex")}@${host}>`;
}

/** The addresses nodemailer reports back, as a list of clean strings and nothing else. */
function addressListOf(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry !== "");
}

/** One validated address as nodemailer wants it: a display name when there is one, else the address. */
function smtpAddress(entry) {
  return entry.name ? { name: entry.name, address: entry.address } : { address: entry.address };
}

/**
 * An attachment's bytes as nodemailer takes them: the string as it is, or a Buffer over the same memory.
 * Nothing else of the caller's attachment object travels — no path, no URL, no header map — which is
 * also why the two access flags on the transport are closed rather than merely unused.
 */
function contentBytes(content) {
  if (typeof content === "string") return content;
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

/**
 * The message handed to nodemailer, built from `validateOutgoing`'s output field by field. Every key
 * below is one of those fields, plus the adapter's own `messageId` and the send's deadline `signal`;
 * there is no way for a header map, a recipient list off the headers, or any other transport option to
 * arrive from the caller.
 */
function smtpMessage(outgoing, messageId, signal) {
  const message = {
    messageId,
    from: smtpAddress(outgoing.from),
    to: outgoing.to.map(smtpAddress),
    subject: outgoing.subject,
    text: outgoing.text,
    // The transport's own cancel route: an abort closes the connection and fails the send with EABORT.
    signal,
  };
  // A Bcc recipient is delivered and never written into the headers nodemailer emits.
  if (outgoing.cc.length) message.cc = outgoing.cc.map(smtpAddress);
  if (outgoing.bcc.length) message.bcc = outgoing.bcc.map(smtpAddress);
  if (outgoing.html != null) message.html = outgoing.html;
  if (outgoing.inReplyTo) message.inReplyTo = outgoing.inReplyTo;
  if (outgoing.references.length) message.references = [...outgoing.references];
  if (outgoing.attachments.length) {
    message.attachments = outgoing.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: contentBytes(attachment.content),
    }));
  }
  return message;
}

/**
 * The nodemailer transport for one account. TLS is fixed here exactly as it is on the IMAP side: `ssl`
 * is TLS from the first byte, `starttls` must upgrade or the send fails, `none` is loopback-only
 * cleartext, and `tls.rejectUnauthorized` is `true` — no account field can turn it off. Nothing is
 * logged (`logger` and `debug` both off), the transport is never pooled, file and URL sources are
 * closed, and every phase is bounded by the adapter's own timeouts.
 */
function smtpTransportOptions(endpoint, auth, timeouts) {
  const options = {
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.security === "ssl",
    auth: auth.accessToken
      ? { type: "OAuth2", user: auth.user, accessToken: auth.accessToken }
      : { user: auth.user, pass: auth.pass },
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    pool: false,
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    tls: { rejectUnauthorized: true },
  };
  if (endpoint.security === "starttls") options.requireTLS = true;
  if (endpoint.security === "none") options.ignoreTLS = true;
  return options;
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

  /**
   * The body fetch of one UID: the server is asked to stop one byte past the cap, so a message whose
   * reported size was short cannot send more than that many bytes through this connection. A source
   * longer than the cap is an oversized message, not a message to keep.
   */
  const sourceQuery = () => ({ uid: true, source: { maxLength: rawLimit + 1 } });

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
    const { host, port, security } = endpointFor(account, "imap");

    // The parser's own bounds, so a server cannot make Crow buffer what Crow would never keep: one
    // literal sits at the raw cap plus the framing headroom, one response total sits above the
    // literal cap (as the parser documents), and a line without a terminator is stopped at the line
    // cap rather than buffered forever.
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
   * Every folder the server lists. A name Crow cannot safely quote into a command — a path carrying a
   * control character — is still listed, with `selectable: false`, rather than dropped: the folder
   * store treats an unlisted folder as removed from the server and would delete the messages it holds.
   * `selectable` is the field that keeps such a name out of a sync and out of every command. A
   * special-use flag carrying a control character is reported as no flag at all, because the flag is a
   * label rather than the folder: the folder itself is still usable.
   *
   * @returns {Promise<AdapterFolder[]>}
   */
  async function listFolders() {
    return runCommand(async (client) => {
      const entries = await client.list();
      if (!Array.isArray(entries)) throw new MailError("PROTOCOL", "list");
      const folders = [];
      for (const entry of entries) {
        // A folder with no name at all names nothing a store row could hold, so there is nothing to keep.
        if (typeof entry.path !== "string" || entry.path === "") continue;
        const path = entry.path;
        const specialUse = typeof entry.specialUse === "string" && !CONTROL_CHARS.test(entry.specialUse)
          ? entry.specialUse
          : null;
        folders.push({
          path,
          name: typeof entry.name === "string" ? entry.name : path,
          specialUse,
          delimiter: typeof entry.delimiter === "string" ? entry.delimiter : "/",
          selectable: listedFolderPath(path) != null && isSelectable(entry),
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
   * *reported* above the limit (its body is never asked for) and one whose bytes arrive larger than the
   * size the server gave (the body fetch stops one byte past the cap, and bytes past it are dropped).
   *
   * One call downloads at most `GET_BUDGET_FACTOR × maxRawBytes` of raw data. A UID this call does not
   * reach — one left outside the budget, one whose body arrived after the budget was spent, or one
   * expunged between the metadata and the body fetch — is **absent from the result**, never reported
   * with an empty Buffer, so it cannot be mistaken for an oversized message: a uid omitted by get() may
   * be retried; the sync engine must not advance highest_uid past an omitted uid.
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

        // Two kinds of "no bytes", kept apart: `oversized` means the message itself is over the cap and
        // is reported with an empty Buffer, `absent` means this call did not deliver it and says nothing.
        const oversized = new Set(
          [...meta.values()].filter((item) => item.size > rawLimit).map((item) => item.uid),
        );
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

        const bodies = new Map();
        let used = 0;
        download: for (const chunk of chunks(attempts, FETCH_CHUNK)) {
          for await (const message of client.fetch(chunk.join(","), sourceQuery(), { uid: true })) {
            const uid = Number(message.uid);
            if (!attempted.has(uid)) continue;
            if (!Buffer.isBuffer(message.source)) continue;
            const source = message.source;
            if (source.length > rawLimit) {
              // The server's reported size was below the real one: the bytes are dropped here and the
              // message is reported as oversized, exactly like one the server admitted to.
              oversized.add(uid);
              continue;
            }
            if (used + source.length > budget) {
              // This body would take the call past its budget, so the call stops here. Whatever else was
              // asked for is left out below, in whatever order the server delivers it: an empty Buffer
              // would read as an empty message rather than as one to fetch again.
              break download;
            }
            used += source.length;
            bodies.set(uid, source);
          }
        }
        for (const uid of attempts) {
          if (!bodies.has(uid) && !oversized.has(uid)) absent.add(uid);
        }

        const messages = [];
        for (const item of [...meta.values()].sort((left, right) => left.uid - right.uid)) {
          if (absent.has(item.uid)) continue;
          const raw = bodies.get(item.uid) ?? (oversized.has(item.uid) ? Buffer.alloc(0) : null);
          if (raw == null) continue;
          messages.push({
            uid: item.uid,
            flags: item.flags,
            internalDate: item.internalDate,
            raw,
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

  /**
   * Append a draft to the mailbox the server marks `\Drafts`, with `\Draft` and `\Seen` set. The
   * folder is found by its special-use flag and never by its name, so a server that calls it
   * "Entwürfe" still works, and a server with no such folder is NOT_FOUND rather than a note filed
   * somewhere Crow picked. The bytes travel over the read connection inside `runCommand`, so the
   * append carries the command deadline and the same error wrapping as every other command.
   *
   * `uid` is the UID the server reported for the appended message, or `null` when it reported none
   * (a server without UIDPLUS); the draft is stored either way. A drafts folder whose own path carries
   * a control character is listed by `listFolders` but not one Crow commands, so it is not picked — a
   * server refusal for size (APPENDLIMIT or TOOBIG) comes back as TOO_LARGE rather than as a protocol
   * fault.
   *
   * @param {Buffer|string} raw the RFC 822 message
   * @returns {Promise<AdapterDraftRef>}
   */
  async function saveDraft(raw) {
    let bytes;
    if (Buffer.isBuffer(raw)) bytes = raw;
    else if (typeof raw === "string") bytes = Buffer.from(raw, "utf8");
    else throw new MailError("BAD_INPUT", "draft");
    if (bytes.length === 0) throw new MailError("BAD_INPUT", "draft");
    if (bytes.length > rawLimit) throw new MailError("TOO_LARGE", "draft");

    return runCommand(async (client) => {
      const folders = await listFolders();
      const drafts = folders.find((folder) => typeof folder.specialUse === "string"
        && folder.specialUse.trim().toLowerCase() === DRAFTS_SPECIAL_USE
        && listedFolderPath(folder.path) != null);
      if (!drafts) throw new MailError("NOT_FOUND", "drafts");
      const response = await client.append(drafts.path, bytes, [...DRAFT_FLAGS]);
      const uid = Number(response && response.uid);
      return {
        folderPath: drafts.path,
        uid: Number.isSafeInteger(uid) && uid > 0 ? uid : null,
      };
    });
  }

  /**
   * Send one message.
   *
   * `validateOutgoing` runs first and runs whole: a message with a key Crow does not send, an address
   * that is not one clean addr-spec, a message id or media type carrying a control character, or a
   * header value that could add a line is refused before a transport exists, so nothing is opened for
   * it. Everything after that is built from the validated fields (see `smtpMessage`).
   *
   * One deadline covers the whole exchange — the sign-in, the connect, the greeting and the
   * transmission. nodemailer's `socketTimeout` only measures silence, so it is not a bound on a server
   * that answers slowly but never stops answering; `sendMs` is. The deadline travels to nodemailer as
   * the message's `signal`, which closes the connection and fails the send with `EABORT`, and the
   * `authFor` step — which runs before any transport exists — is raced against the same signal.
   *
   * A refused OAuth sign-in is retried once with a forced token refresh, exactly as `openClient` does:
   * AUTH is the first exchange of a send, so nothing has been transmitted and the retry cannot deliver
   * the message twice. Nothing else is retried, because a bad password must not be hammered at a server.
   *
   * The recipient list nodemailer reports comes back in two lists, so a server that refuses one
   * recipient of several is reported to the caller rather than thrown; a send whose every recipient is
   * refused is a failure with a fixed sentence, because nothing was transmitted for the lists to
   * describe. A failure of any other kind is a fixed sentence through the shared classifier too: no
   * server text, no command line, no credential and no address travels with it. nodemailer opens one
   * connection for one message — never a pool — and closes it itself before the send settles;
   * `transporter.close()` below only releases the transport's own listeners.
   *
   * @param {OutgoingMessage} message
   * @returns {Promise<AdapterSendResult>}
   */
  async function send(message) {
    const outgoing = validateOutgoing(message);
    const endpoint = endpointFor(account, "smtp");
    const messageId = messageIdFor(outgoing.from.address);
    const deadline = AbortSignal.timeout(timeouts.sendMs);
    const payload = smtpMessage(outgoing, messageId, deadline);

    let transporter = null;
    let retried = false;
    try {
      for (;;) {
        try {
          const auth = await withSendDeadline(deadline, () => authFor(account, {
            credentials,
            tokenProvider,
            forceRefresh: retried,
            rotation: typeof onTokenRotated === "function"
              ? async (accountId, { refreshToken } = {}) => { await onTokenRotated(refreshToken); }
              : undefined,
          }));
          transporter = nodemailer.createTransport(smtpTransportOptions(endpoint, auth, timeouts));
          if (transporter == null || typeof transporter.sendMail !== "function") {
            throw new MailError("PROTOCOL", "transport");
          }
          const info = await withSendDeadline(deadline, () => transporter.sendMail(payload));
          return {
            // The id handed to nodemailer as the Message-ID header, so the stored copy and the sent copy
            // carry the same one.
            messageId,
            accepted: addressListOf(info && info.accepted),
            rejected: addressListOf(info && info.rejected),
          };
        } catch (err) {
          const mail = asMailError(err);
          const canRefresh = !retried && mail.code === "AUTH_FAILED" &&
            account.authKind === "xoauth2" && typeof tokenProvider === "function";
          if (!canRefresh) throw mail;
          retried = true;
          if (transporter) {
            try {
              transporter.close();
            } catch {
              // a transport whose connection is already gone has nothing to release
            }
            transporter = null;
          }
        }
      }
    } finally {
      if (transporter) {
        try {
          transporter.close();
        } catch {
          // as above: the send's own connection was already closed by nodemailer
        }
      }
    }
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