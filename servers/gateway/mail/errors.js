/**
 * Crow Mail's error vocabulary. Every failure the mail code reports is one of these codes, and the
 * sentence a person or a log sees is the code's fixed text — never a library's message. imapflow and
 * nodemailer quote the server, the command and the username in `response`, `responseText`, `command`
 * and `message`, so `toMailError` reads only the fields the ruling allows (classification booleans,
 * `code`, `responseStatus`, `name`) and copies none of the free text. `detail` is kept only when it is
 * an allow-listed token (`ECONNRESET`, `NO`, `sync_deadline`), so a server string can never reach a
 * log, `mail_sync_state.error_code` or `mail_accounts.status_detail`.
 */
const DETAIL_RE = /^[A-Za-z0-9_]{1,40}$/;

export const MAIL_ERROR_CODES = Object.freeze([
  "AUTH_FAILED",
  "NETWORK",
  "TLS",
  "PROTOCOL",
  "NOT_FOUND",
  "BAD_INPUT",
  "CLAIMED_ELSEWHERE",
  "TOO_LARGE",
  "TIMEOUT",
  "CHANGED",
]);

/** The fixed sentence per code. `CHANGED` is plan 2's adapter-action failure. */
export const MAIL_ERROR_TEXT = Object.freeze({
  AUTH_FAILED: "Crow could not sign in to the mail server.",
  NETWORK: "Crow could not reach the mail server.",
  TLS: "The mail server's certificate could not be trusted.",
  PROTOCOL: "The mail server answered with something Crow could not use.",
  NOT_FOUND: "That item is not in this mailbox any more.",
  BAD_INPUT: "That mail setting is not valid.",
  CLAIMED_ELSEWHERE: "This account is connected on another Crow instance.",
  TOO_LARGE: "That message is too large for Crow to keep.",
  TIMEOUT: "The mail server took too long to answer.",
  CHANGED: "This message changed on the mail server. Crow is refreshing; try again.",
});

/** A detail survives only when it is a short token — never a sentence and never server text. */
function safeDetail(value) {
  return typeof value === "string" && DETAIL_RE.test(value) ? value : null;
}

export class MailError extends Error {
  /**
   * @param {string} code one of MAIL_ERROR_CODES
   * @param {string|null} [detail] an allow-listed token (a socket code, an IMAP status, `sync_deadline`)
   */
  constructor(code, detail = null) {
    if (typeof code !== "string" || !Object.hasOwn(MAIL_ERROR_TEXT, code)) {
      throw new TypeError(`unknown mail error code ${JSON.stringify(code)}`);
    }
    super(MAIL_ERROR_TEXT[code]);
    this.name = "MailError";
    this.code = code;
    this.detail = safeDetail(detail);
  }
}

/** TLS failures arrive as socket error codes with these prefixes, or as a nodemailer `ETLS`. */
const TLS_CODE_RE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO|UNABLE_TO_VERIFY|SELF_SIGNED)/;

const TIMEOUT_CODES = new Set(["ETIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT", "Timeout"]);
const TIMEOUT_NAMES = new Set(["Timeout", "TimeoutError"]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EPIPE", "ECONNABORTED",
  "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EHOSTDOWN", "EAI_AGAIN",
  "ESOCKET", "ECONNECTION", "EPROTO",
]);

/** The one token worth keeping: the library's code, else the IMAP status line. */
function detailFrom(err) {
  if (err == null || typeof err !== "object") return null;
  return safeDetail(err.code) ?? safeDetail(err.responseStatus);
}

/**
 * Classify a library or socket error into a MailError. A MailError passes through unchanged; anything
 * unrecognised is PROTOCOL. Never reads `message`, `response`, `responseText` or `command`.
 */
export function toMailError(err) {
  if (err instanceof MailError) return err;
  const detail = detailFrom(err);
  const field = (name) => (err != null && typeof err === "object" && typeof err[name] === "string" ? err[name] : "");
  const code = field("code");
  const name = field("name");

  if (err != null && typeof err === "object" && err.authenticationFailed === true) {
    return new MailError("AUTH_FAILED", detail);
  }
  if (code === "EAUTH") return new MailError("AUTH_FAILED", detail);
  if (TLS_CODE_RE.test(code) || code === "ETLS") return new MailError("TLS", detail);
  if (TIMEOUT_CODES.has(code) || TIMEOUT_NAMES.has(name)) return new MailError("TIMEOUT", detail);
  if (NETWORK_CODES.has(code)) return new MailError("NETWORK", detail);
  return new MailError("PROTOCOL", detail);
}