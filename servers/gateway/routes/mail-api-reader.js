/**
 * Crow Mail's reader routes: one message body as an opaque-origin document, one attachment's bytes as
 * a download, and the account's remote-image allow list.
 *
 * These are plan 1's guards, helpers and error shape, used rather than rebuilt: `mail-api.js` mounts
 * the flag, owner and body-parser chain on this router's prefix before this function registers
 * anything, so the frame, the attachment and the allow list answer 404 while `CROW_MAIL` is unset,
 * 403 `{error:"owner_only"}` for any session that is not this machine's own password session, and
 * `not_found` for an id that names no stored row. `ctx.route` opens one database client per request
 * and closes it in `finally`, and a failure is logged by code only.
 *
 * The frame is not a page: its own `Content-Security-Policy` (with the one pinned helper script and a
 * sandbox without `allow-same-origin`) is set here, in the handler, after the gateway's global
 * middleware, so it replaces the dashboard page's policy instead of adding to it. The body comes from
 * `bodyForDisplay`, never from stored html, so the sanitiser runs on every load and the answer is
 * always this load's decision on remote images.
 *
 * The attachment route is the one seam that talks to the mail server: it borrows the supervisor's
 * short-lived adapter, fetches the opened row's one UID and compares what came back with the row
 * before serving a byte of it — a UIDVALIDITY reset can leave a different message at the same UID and
 * `get` takes no UIDVALIDITY argument, so the content is the check. A mismatch is the fixed
 * `changed_on_server` answer and a full sync; an empty Buffer is the adapter's way of saying the
 * message is over plan 1's raw-size limit, and that answer and the `MAX_ATTACHMENT_BYTES` check share
 * one approved sentence naming the limit a person actually meets. Every failure is one of plan 1's
 * codes and fixed sentences: a server's text, a filename's markup and a sender's type never reach a
 * header here.
 *
 * The password route is the account page's one write: the new app password joins the masking set
 * first (as the connect route does), an account another instance claimed is refused before anything
 * is dialled, and the secret is proved against the server (the probe runs on a credentials reader
 * holding only the new secret) and only then replaces the sealed one. It is never echoed, never
 * logged and never compared here; a refused sign-in leaves the stored secret and the account exactly
 * as they were. An account removed while the probe runs stores nothing and answers `not_found`. An
 * OAuth account is refused — plan 5's wizards reconnect one — and an accepted password restarts the
 * account, whose restart is itself a full sync, so neither the sync worker nor a borrowed adapter can
 * keep speaking with the old secret.
 */
import { MAIL_ERROR_TEXT, toMailError } from "../mail/errors.js";
import { parseRawMessageFull } from "../mail/parse.js";
import {
  MAX_ATTACHMENT_BYTES,
  encodeRfc5987,
  extractAttachmentFromParsed,
  safeAttachmentName,
} from "../mail/reader/attachments.js";
import { bodyForDisplay } from "../mail/sanitize.js";
import { probeAccount } from "../mail/probe.js";
import { frameHeaders, renderFrameDocument } from "../mail/reader/frame-doc.js";
import { getAccount, isImageAllowed, updateAccount } from "../mail/store/accounts.js";
import { getFolder, getMessage, storedDate } from "../mail/store/messages.js";
import { listImageAllow } from "../mail/store/reader-queries.js";
import { withoutWriteContext } from "../../shared/history/write-context.js";
// The mount point plan 1's mail-api.js sets on this same router. It is read when routes are
// registered (that module has finished evaluating by then), never at module load: the two files
// import each other.
import { MAIL_ACCOUNT_ID_RE, MAIL_API_PREFIX } from "./mail-api.js";

/** A sender address is at most this long, and the allow-list store refuses more. */
const ADDRESS_MAX = 254;

/** The most a password may be: the same ceiling plan 1's connect route reads. */
const PASSWORD_MAX = 1024;

/**
 * The sentence both `too_large` answers carry (operator-approved copy). The limit a person meets here
 * is plan 1's raw-size rule, not `MAX_ATTACHMENT_BYTES`: a 20 MB part is about 27 MB once
 * base64-encoded, so the raw cap refuses it first, and roughly 18 MB of attachment is what fits under
 * it.
 */
const ATTACHMENT_TOO_LARGE_TEXT = "This attachment is over about 18 MB, too large to download here.";

const BLANK_OR_CONTROL_RE = /[\s\u0000-\u001f\u007f<>]/;

/** Whether a stored sender can be handed to the allow-list store without it being refused. */
function looksLikeSender(value) {
  return typeof value === "string"
    && value !== ""
    && value.length <= ADDRESS_MAX
    && !BLANK_OR_CONTROL_RE.test(value);
}

/** The document's language, from the client's own preference; English for anything else. */
const langOf = (req) => (/^\s*es\b/i.test(String(req.headers?.["accept-language"] ?? "")) ? "es" : "en");

/** An attachment index as the reader links it: decimal digits, so no sign, no fraction, no exponent. */
const ATTACHMENT_INDEX_RE = /^[0-9]{1,6}$/;

/** The body's password: a non-empty string within the limit, else null. It is never logged. */
function readPassword(value) {
  if (typeof value !== "string" || value === "" || value.length > PASSWORD_MAX) return null;
  return value;
}

/** The bytes an adapter reported, whatever binary flavour it used; null for anything that is not bytes. */
function rawBufferOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/**
 * A filename as the quoted `filename=` parameter: printable ASCII only, with the quote and the
 * backslash replaced, so the parameter cannot end early or escape anything. The name a modern client
 * reads is the `filename*` form beside it.
 */
function asciiFilename(name) {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0);
    out += code >= 0x20 && code <= 0x7e && ch !== "\"" && ch !== "\\" ? ch : "_";
  }
  return out === "" ? "attachment" : out;
}

/** The lowercase sender an identity check compares, or null when the message names none. */
function senderAddressOf(parsed) {
  const address = parsed?.from?.address;
  return typeof address === "string" && address.trim() !== "" ? address.trim().toLowerCase() : null;
}

/**
 * Ask for a full sync without holding the answer open: a refresh outlives the request that asked for
 * it, so it is opened with no write context and its failure is the supervisor's to report.
 */
function requestSyncInBackground(supervisor, accountId, logCode, label) {
  if (!supervisor || typeof supervisor.requestSync !== "function") return;
  withoutWriteContext(() => {
    Promise.resolve()
      .then(() => supervisor.requestSync(accountId))
      .catch((err) => logCode(label, err));
  });
}

/**
 * Crow Mail's reader routes, registered on the router `mail-api.js` already guards.
 *
 * @param {import("express").Router} router the mail API router (prefix `/dashboard/mail/api`)
 * @param {object} ctx the guards and per-request helpers, as mail-api.js builds them: `{route,
 *   sendError, logCode, supervisor}` — `supervisor()` answers the running supervisor, or null.
 */
export function registerReaderRoutes(router, ctx) {
  const { route, sendError } = ctx;
  const logCode = typeof ctx.logCode === "function" ? ctx.logCode : () => {};
  // The masking seam mail-api.js hands both the connect route and this one: a value it is given is
  // redacted from later log lines. Absent, it is a no-op rather than a failed request.
  const recordSecrets = typeof ctx.recordSecrets === "function" ? ctx.recordSecrets : async () => {};
  const base = MAIL_API_PREFIX;

  /** The running supervisor, or null when boot started no sync in this process. */
  const supervisorNow = () => {
    const supervisor = typeof ctx.supervisor === "function" ? ctx.supervisor() : null;
    return supervisor && typeof supervisor.withAdapter === "function" ? supervisor : null;
  };

  /* ------------------------------------------------------------------- frame */

  // GET /messages/:id/frame — one message body as a standalone document. `images=1` shows remote
  // images for this load only (nothing is stored, and the page is never asked); an allow-listed
  // sender's images show without asking. A message the store has no row for, or one whose account
  // is gone, is the fixed JSON 404 — never an empty document. A row with no body at all (a parse
  // failure) still renders the framed document, with an empty body: the reader shows the message's
  // header and says nothing about the mail's text rather than inventing a sentence for it.
  router.get(`${base}/messages/:id/frame`, route("GET /messages/:id/frame", async (db, req, res) => {
    const message = await getMessage(db, req.params.id);
    if (!message) return sendError(res, 404, "not_found");
    const account = await getAccount(db, message.accountId);
    if (!account) return sendError(res, 404, "not_found");

    const asked = req.query?.images === "1";
    const allowedSender = looksLikeSender(message.fromAddr)
      && await isImageAllowed(db, account.id, message.fromAddr);
    const allowImages = asked || allowedSender;

    const body = bodyForDisplay(message, { allowRemoteImages: allowImages });
    const document = renderFrameDocument(body.html, {
      blockedRemoteImageCount: body.blockedRemoteImageCount,
      lang: langOf(req),
    });

    for (const [name, value] of Object.entries(frameHeaders({ allowImages }))) res.setHeader(name, value);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(document);
  }));

  /* -------------------------------------------------------------- attachment */

  // GET /messages/:id/attachments/:index — one attachment's bytes, fetched from the account's server
  // for this one download (nothing is stored locally). The row, its folder and the fetched message
  // are cross-checked first: the UID is only meaningful with the UIDVALIDITY the row was stored
  // under, and `get` has no argument for one, so a message whose Message-ID, From or Date differs is
  // refused and a full sync is asked for. The sender's own type is never echoed: every answer is
  // `application/octet-stream`, with a disposition that downloads it and a policy that cannot render it.
  router.get(`${base}/messages/:id/attachments/:index`, route(
    "GET /messages/:id/attachments/:index",
    async (db, req, res) => {
      const message = await getMessage(db, req.params.id);
      if (!message) return sendError(res, 404, "not_found");
      const folder = await getFolder(db, message.folderId);
      if (!folder || folder.accountId !== message.accountId) return sendError(res, 404, "not_found");
      const account = await getAccount(db, message.accountId);
      if (!account) return sendError(res, 404, "not_found");
      const index = String(req.params.index ?? "");
      if (!ATTACHMENT_INDEX_RE.test(index)) return sendError(res, 404, "not_found");

      const supervisor = supervisorNow();
      if (!supervisor) return sendError(res, 503, "unavailable");

      // A supervisor converts a library failure into a MailError already; this makes the answer the
      // same fixed sentence when a supervisor hands back anything else.
      let fetched;
      try {
        fetched = await supervisor.withAdapter(account.id, (adapter) => adapter.get(folder.path, [message.uid]));
      } catch (err) {
        throw toMailError(err);
      }
      const items = Array.isArray(fetched) ? fetched : [];
      const item = items.find((entry) => Number(entry?.uid) === Number(message.uid));
      if (!item) return sendError(res, 404, "not_found");
      const raw = rawBufferOf(item.raw);
      if (!raw) return sendError(res, 404, "not_found");
      // The adapter answers an empty Buffer for a message over its own raw-size limit, and reports no
      // bytes at all for a UID it did not deliver: an empty one here is that limit, not an empty file.
      if (raw.length === 0) return sendError(res, 413, "too_large", ATTACHMENT_TOO_LARGE_TEXT);

      // One parse answers both questions: the identity check below reads `parsed`, and the part the
      // download serves is read out of the same answer by index, so the two can never disagree.
      const full = await parseRawMessageFull(raw);
      const parsed = full.parsed;
      const internalDate = Number(item.internalDate);
      const date = storedDate(parsed.date, Number.isFinite(internalDate) ? internalDate : null);
      const rowFrom = typeof message.fromAddr === "string" && message.fromAddr !== ""
        ? message.fromAddr.toLowerCase()
        : null;
      const sameMessage = (parsed.messageId ?? null) === (message.messageId ?? null)
        && senderAddressOf(parsed) === rowFrom
        && date === message.date;
      if (!sameMessage) {
        requestSyncInBackground(supervisor, account.id, logCode, "GET /messages/:id/attachments/:index");
        return sendError(res, 409, "changed_on_server", MAIL_ERROR_TEXT.CHANGED);
      }

      const attachment = extractAttachmentFromParsed(full, Number(index));
      if (!attachment) return sendError(res, 404, "not_found");
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        return sendError(res, 413, "too_large", ATTACHMENT_TOO_LARGE_TEXT);
      }

      const name = safeAttachmentName(attachment.filename);
      res.status(200);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition",
        `attachment; filename="${asciiFilename(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`);
      res.setHeader("Content-Length", String(attachment.content.length));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      res.setHeader("Cache-Control", "no-store");
      res.end(attachment.content);
    },
  ));

  /* ------------------------------------------------------------ password update */

  // PUT /accounts/:id/password — one new app password. It joins the masking set first, so no later
  // log line can carry it; an account another instance holds is refused before anything is dialled;
  // the probe runs before anything is stored, so a refused sign-in changes nothing; an accepted one
  // replaces the sealed secret, marks the account active and restarts it (the old password's run and
  // both of its connections go, and the restart's own full sync is the one that follows). The answer
  // holds no secret and no server text.
  router.put(`${base}/accounts/:id/password`, route("PUT /accounts/:id/password", async (db, req, res) => {
    const id = String(req.params.id);
    if (!MAIL_ACCOUNT_ID_RE.test(id)) return sendError(res, 404, "not_found");
    const account = await getAccount(db, id);
    if (!account) return sendError(res, 404, "not_found");
    // An OAuth account has no password to replace: plan 5's wizards reconnect it.
    if (account.authKind !== "password") return sendError(res, 400, "bad_input");
    const password = readPassword(req.body?.password);
    if (password === null) return sendError(res, 400, "bad_input");

    // Before the probe can reach a log line: a recorder that cannot write its file is logged by code
    // and must neither fail the update nor echo the value.
    try {
      await recordSecrets([password]);
    } catch (err) {
      logCode("record_secret", err);
    }

    // A mailbox another instance claimed is not synced or re-keyed here, and the password could well
    // be right for it: nothing is stored, and the status the row already carries is left as it is.
    if (account.status === "claimed_elsewhere") return sendError(res, 409, "CLAIMED_ELSEWHERE");

    // The credentials reader is the shape plan 1's adapter factory takes, holding only the password
    // just typed: the probe signs in with the new secret and keeps nothing of it.
    await probeAccount({
      adapterFactory: ctx.adapterFactory,
      account,
      credentials: { getSecrets: async () => ({ MAIL_PASSWORD: password }) },
    });

    // The probe outlives nothing: the row may have been removed while it ran, and an id that names no
    // account has nothing to store a secret for.
    if (!(await getAccount(db, id))) return sendError(res, 404, "not_found");

    const credentials = ctx.credentials(db);
    await credentials.saveSecret(id, "MAIL_PASSWORD", password);
    const updated = await updateAccount(db, id, { status: "active", statusDetail: null });
    if (!updated) {
      // Removed between the read above and this write: the secret goes the way the account-delete path
      // takes it, so nothing new is left behind under an id nothing owns.
      try {
        await credentials.deleteSecrets(id);
      } catch (err) {
        logCode("PUT /accounts/:id/password", err);
      }
      return sendError(res, 404, "not_found");
    }

    // `restartAccount` ends the old password's run, drops both connections and starts one fresh full
    // sync of its own; a supervisor with no restart gets the sync on its own. A sync outlives the
    // request that asked for it, so it is opened with no write context; its failure is the supervisor's
    // to report, never this answer's.
    const supervisor = typeof ctx.supervisor === "function" ? ctx.supervisor() : null;
    if (supervisor) {
      const restart = typeof supervisor.restartAccount === "function" ? supervisor.restartAccount.bind(supervisor) : null;
      const syncNow = !restart && typeof supervisor.syncNow === "function" ? supervisor.syncNow.bind(supervisor) : null;
      withoutWriteContext(() => {
        Promise.resolve()
          .then(() => (restart ? restart(id) : syncNow ? syncNow(id) : undefined))
          .catch((err) => logCode("PUT /accounts/:id/password", err));
      });
    }

    res.json({ ok: true });
  }));

  /* --------------------------------------------------------------- image allow */

  // GET /image-allow?account=<id> — the senders whose remote images show unasked on one account,
  // read through the reader queries so the settings page and this route answer the same list.
  router.get(`${base}/image-allow`, route("GET /image-allow", async (db, req, res) => {
    const id = req.query?.account;
    if (typeof id !== "string" || id === "") return sendError(res, 400, "bad_input");
    const account = await getAccount(db, id);
    if (!account) return sendError(res, 404, "not_found");
    res.json({ senders: await listImageAllow(db, account.id) });
  }));
}

export default registerReaderRoutes;