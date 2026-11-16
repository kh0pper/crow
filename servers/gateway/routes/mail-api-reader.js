/**
 * Crow Mail's reader routes: one message body as an opaque-origin document, and the account's
 * remote-image allow list.
 *
 * These are plan 1's guards, helpers and error shape, used rather than rebuilt: `mail-api.js` mounts
 * the flag, owner and body-parser chain on this router's prefix before this function registers
 * anything, so the frame and the allow list answer 404 while `CROW_MAIL` is unset, 403
 * `{error:"owner_only"}` for any session that is not this machine's own password session, and
 * `not_found` for an id that names no stored row. `ctx.route` opens one database client per request
 * and closes it in `finally`, and a failure is logged by code only.
 *
 * The frame is not a page: its own `Content-Security-Policy` (with the one pinned helper script and a
 * sandbox without `allow-same-origin`) is set here, in the handler, after the gateway's global
 * middleware, so it replaces the dashboard page's policy instead of adding to it. The body comes from
 * `bodyForDisplay`, never from stored html, so the sanitiser runs on every load and the answer is
 * always this load's decision on remote images.
 */
import { bodyForDisplay } from "../mail/sanitize.js";
import { frameHeaders, renderFrameDocument } from "../mail/reader/frame-doc.js";
import { getAccount, isImageAllowed } from "../mail/store/accounts.js";
import { getMessage } from "../mail/store/messages.js";
import { listImageAllow } from "../mail/store/reader-queries.js";
// The mount point plan 1's mail-api.js sets on this same router. It is read when routes are
// registered (that module has finished evaluating by then), never at module load: the two files
// import each other.
import { MAIL_API_PREFIX } from "./mail-api.js";

/** A sender address is at most this long, and the allow-list store refuses more. */
const ADDRESS_MAX = 254;

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

/**
 * Crow Mail's reader routes, registered on the router `mail-api.js` already guards.
 *
 * @param {import("express").Router} router the mail API router (prefix `/dashboard/mail/api`)
 * @param {object} ctx the guards and per-request helpers, as mail-api.js builds them: `{route, sendError}`
 */
export function registerReaderRoutes(router, ctx) {
  const { route, sendError } = ctx;
  const base = MAIL_API_PREFIX;

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