/**
 * The mailbox routes of the private mail API — message lists, one message with its sanitised body,
 * the per-sender image allow list, search and older mail.
 *
 * These are Task 19's guards, helpers and error shape, used rather than rebuilt: every route here
 * runs behind the same flag, owner and 64 KB body-parser chain (`mail-api.js` mounts it before this
 * function registers anything), opens its database client through `ctx.openDb`, logs a failure by
 * code only, and answers with the fixed sentence for its MailError code. Nothing in a response is a
 * library's text, a raw stored body, a header or a credential: a message carries `bodyForDisplay`'s
 * sanitised html and never `body_html` itself, and its attachments are metadata only.
 *
 * Adapter work is never done here. Every route that talks to a server goes through the supervisor's
 * `withAdapter`, which refuses a `claimed_elsewhere` or an `auth_failed` account without connecting
 * and bounds one call with its own hard timer; the route adds the per-call deadline the engine
 * honours between batches (ten seconds to search one account's server, a minute to page one folder's
 * history) and its own hard cap around the whole call, so a server that stalls inside a batch still
 * answers. One account runs one of these at a time: a second call while it is in flight is 409
 * `busy`. A search of the server is a WRITE — its hits are stored — so it is a POST; `GET /search`
 * is local only and refuses a `remote` parameter instead of writing on a read.
 */
import { MailError, toMailError, MAIL_ERROR_TEXT } from "../mail/errors.js";
import { bodyForDisplay } from "../mail/sanitize.js";
import {
  addImageAllow,
  getAccount,
  isImageAllowed,
  listAccounts,
  removeImageAllow,
} from "../mail/store/accounts.js";
import {
  FOLDER_ROLES,
  getFolder,
  getMessage,
  listMessages,
  searchLocal,
} from "../mail/store/messages.js";
import { fetchOlder, searchRemote } from "../mail/sync/engine.js";
// The mount point Task 19 sets on the same router. It is read when routes are registered (after that
// module has finished evaluating), never at module load: the two files import each other.
import { MAIL_API_PREFIX } from "./mail-api.js";

/** A page of a list or a search: what the reader's list asks for, and the ceiling. */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

/** A person's words: cut here, because anything longer is not a query. */
const QUERY_MAX_CHARS = 200;

/** How long one account's server-side search may take, and one folder's backfill. */
const REMOTE_SEARCH_DEADLINE_MS = 10 * 1000;
const OLDER_DEADLINE_MS = 60 * 1000;

/** The answer for a second call of a route already running for one account. */
const BUSY_TEXT = "That is already running.";

/** The caps in force when `registerMessageRoutes`' own ctx names none (see `setMessageRouteCaps`). */
let defaultCaps = Object.freeze({
  remoteSearchCapMs: REMOTE_SEARCH_DEADLINE_MS,
  olderCapMs: OLDER_DEADLINE_MS,
});

/**
 * Replace the default wall-clock caps for the routes registered afterwards. A `registerMessageRoutes`
 * ctx option of the same name wins over these; boot sets neither, so production runs the constants
 * above. A test uses a few milliseconds instead of waiting out a real cap.
 */
export function setMessageRouteCaps({ remoteSearchCapMs, olderCapMs } = {}) {
  defaultCaps = Object.freeze({
    remoteSearchCapMs: capMs(remoteSearchCapMs, REMOTE_SEARCH_DEADLINE_MS),
    olderCapMs: capMs(olderCapMs, OLDER_DEADLINE_MS),
  });
}

/** How many server-side hits one account's search may bring back. */
const DEFAULT_REMOTE_SEARCH_LIMIT = 50;

/** A sender address is at most this long, and the store refuses more. */
const ADDRESS_MAX = 254;

const BLANK_OR_CONTROL_RE = /[\s\u0000-\u001f\u007f<>]/;

/**
 * A page size from the query string: the default when absent, clamped to 1..100, and null when the
 * value is not a number at all (the caller answers bad_input rather than a silently wrong page).
 */
function readLimit(value, fallback = DEFAULT_PAGE) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(n)));
}

/** A trimmed query cut at QUERY_MAX_CHARS, or null when there is nothing to search for. */
function readQuery(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, QUERY_MAX_CHARS);
  return text === "" ? null : text;
}

/** One plain mailbox address, lower-cased: one `@`, no whitespace, no angle brackets. */
function readPlainAddress(value) {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  if (!address || address.length > ADDRESS_MAX) return null;
  if (BLANK_OR_CONTROL_RE.test(address)) return null;
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1) return null;
  return address;
}

/** Whether a stored sender can be handed to the allow-list store without it being refused. */
function looksLikeSender(value) {
  return typeof value === "string"
    && value !== ""
    && value.length <= ADDRESS_MAX
    && !BLANK_OR_CONTROL_RE.test(value);
}

/** One attachment as a reader sees it in the list: no bytes, no content id, no disposition. */
function attachmentSummary(entry) {
  const size = Number(entry?.size);
  return {
    filename: typeof entry?.filename === "string" ? entry.filename : "",
    contentType: typeof entry?.contentType === "string" ? entry.contentType : "",
    size: Number.isFinite(size) && size >= 0 ? size : 0,
  };
}

/** `{name, address}` for each addressee, keeping the store's shape. */
function addressList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => ({
    name: typeof entry?.name === "string" ? entry.name : "",
    address: typeof entry?.address === "string" ? entry.address : "",
  }));
}

/** One cap in milliseconds: the configured value when it is a positive number, else the default. */
function capMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * One server round-trip under a hard wall-clock cap, because the per-call deadline the engine honours
 * is only checked between batches: a server that never answers, or one that stalls inside a batch,
 * would hold the request for as long as its socket lives. The cap answers TIMEOUT (the supervisor
 * closes the adapter under the call), and the timer is cleared whether the call or the cap won, so a
 * finished request leaves nothing armed.
 */
async function withCap(ms, run, detail) {
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new MailError("TIMEOUT", detail)), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The mail API's mailbox routes, registered on the router `mail-api.js` already guards.
 *
 * @param {import("express").Router} router the mail API router (prefix `/dashboard/mail/api`)
 * @param {object} ctx the guards and per-request helpers, as mail-api.js builds them:
 *   `{route, sendError, supervisor, logCode, ...}`
 */
export function registerMessageRoutes(router, ctx) {
  const { route, sendError, logCode } = ctx;
  const base = MAIL_API_PREFIX;
  const remoteSearchCapMs = capMs(ctx.remoteSearchCapMs ?? defaultCaps.remoteSearchCapMs, REMOTE_SEARCH_DEADLINE_MS);
  const olderCapMs = capMs(ctx.olderCapMs ?? defaultCaps.olderCapMs, OLDER_DEADLINE_MS);

  // One call per account at a time on each server-touching route: a second click while the first
  // still runs is answered busy instead of opening another connection for the same mailbox.
  const inFlightRemoteSearch = new Set();
  const inFlightOlder = new Set();

  /** The 409 for a route already running for that account. */
  const sendBusy = (res) => sendError(res, 409, "busy", BUSY_TEXT);

  /**
   * Which account a list or a search covers: `all` (or nothing) means every account, an id means that
   * one, and an id that names no stored account is the same 404 an unknown folder gets.
   */
  async function accountScope(db, value) {
    if (value == null || value === "" || value === "all") return { ok: true, account: null };
    if (typeof value !== "string") return { ok: false, account: null };
    const account = await getAccount(db, value);
    if (!account) return { ok: false, account: null };
    return { ok: true, account };
  }

  /** The running supervisor, or null when boot started no sync in this process. */
  const supervisorNow = () => {
    const supervisor = typeof ctx.supervisor === "function" ? ctx.supervisor() : null;
    return supervisor && typeof supervisor.withAdapter === "function" ? supervisor : null;
  };

  /* ------------------------------------------------------------------ messages */

  // GET /messages — one keyset page of summaries, never a body: the reader asks for the message it
  // opens. `folder` is one folder, `role` every folder of that role (with `account=all`, the unified
  // view), `account` one account or all of them.
  router.get(`${base}/messages`, route("GET /messages", async (db, req, res) => {
    const query = req.query ?? {};
    const scope = await accountScope(db, query.account);
    if (!scope.ok) return sendError(res, 404, "not_found");
    const limit = readLimit(query.limit);
    if (limit === null) return sendError(res, 400, "bad_input");

    let folderId = null;
    if (query.folder != null && query.folder !== "") {
      const folder = await getFolder(db, query.folder);
      if (!folder) return sendError(res, 404, "not_found");
      if (scope.account != null && folder.accountId !== scope.account.id) return sendError(res, 404, "not_found");
      folderId = folder.id;
    }

    let role = null;
    if (query.role != null && query.role !== "") {
      if (typeof query.role !== "string" || !FOLDER_ROLES.includes(query.role)) {
        return sendError(res, 400, "bad_input");
      }
      role = query.role;
    }

    const cursor = typeof query.cursor === "string" && query.cursor !== "" ? query.cursor : null;
    let page;
    try {
      page = await listMessages(db, {
        accountId: scope.account?.id ?? null,
        folderId,
        role,
        limit,
        cursor,
      });
    } catch (err) {
      // The cursor is the only request value the store inspects: an opaque token it cannot read is a
      // bad request, not a silent first page.
      const mailErr = toMailError(err);
      if (mailErr.code === "BAD_INPUT" && mailErr.detail === "cursor") return sendError(res, 400, "bad_input");
      throw err;
    }
    res.json({ items: page.items, nextCursor: page.nextCursor });
  }));

  // GET /messages/:id — one message: its sanitised body, its attachment metadata, and whether remote
  // images were shown. The raw stored html, the raw text beyond what the sanitiser returns, the
  // headers and the flags never leave here.
  router.get(`${base}/messages/:id`, route("GET /messages/:id", async (db, req, res) => {
    const message = await getMessage(db, req.params.id);
    if (!message) return sendError(res, 404, "not_found");
    const account = await getAccount(db, message.accountId);
    if (!account) return sendError(res, 404, "not_found");

    const imagesShown = (req.query?.images === "1")
      || (looksLikeSender(message.fromAddr) && await isImageAllowed(db, account.id, message.fromAddr));
    const body = bodyForDisplay(message, { allowRemoteImages: imagesShown });
    const from = message.fromAddr || message.fromName
      ? { name: message.fromName, address: message.fromAddr }
      : null;

    res.json({
      id: message.id,
      accountId: message.accountId,
      folderId: message.folderId,
      threadId: message.threadId,
      subject: message.subject,
      from,
      to: addressList(message.to),
      cc: addressList(message.cc),
      date: message.date,
      isRead: message.isRead,
      attachments: (Array.isArray(message.attachments) ? message.attachments : []).map(attachmentSummary),
      body: {
        html: body.html,
        source: body.source,
        remoteImageCount: body.remoteImageCount,
        blockedRemoteImageCount: body.blockedRemoteImageCount,
        imagesShown,
      },
      parseError: message.parseError ?? null,
    });
  }));

  /* --------------------------------------------------------------- image allow */

  // POST /image-allow — show one sender's remote images on one account, from now on. Idempotent.
  router.post(`${base}/image-allow`, route("POST /image-allow", async (db, req, res) => {
    const input = readImageAllowBody(req.body);
    if (!input) return sendError(res, 400, "bad_input");
    const account = await getAccount(db, input.accountId);
    if (!account) return sendError(res, 404, "not_found");
    await addImageAllow(db, account.id, input.sender);
    res.json({ ok: true, allowed: true });
  }));

  // DELETE /image-allow — forget one sender's allowance, so its images are blocked again. Idempotent.
  router.delete(`${base}/image-allow`, route("DELETE /image-allow", async (db, req, res) => {
    const input = readImageAllowBody(req.body);
    if (!input) return sendError(res, 400, "bad_input");
    const account = await getAccount(db, input.accountId);
    if (!account) return sendError(res, 404, "not_found");
    await removeImageAllow(db, account.id, input.sender);
    res.json({ ok: true, allowed: false });
  }));

  /* -------------------------------------------------------------------- search */

  // GET /search — the local index only. A GET must not write, and searching the server stores what it
  // finds, so a `remote` parameter is refused rather than obeyed.
  router.get(`${base}/search`, route("GET /search", async (db, req, res) => {
    const query = req.query ?? {};
    if (Object.hasOwn(query, "remote")) return sendError(res, 400, "bad_input");
    const text = readQuery(query.q);
    if (!text) return sendError(res, 400, "bad_input");
    const scope = await accountScope(db, query.account);
    if (!scope.ok) return sendError(res, 404, "not_found");
    const limit = readLimit(query.limit);
    if (limit === null) return sendError(res, 400, "bad_input");

    // toFtsQuery quotes every term, so a quote, a `NEAR(`, a `*` or a 10,000-character query is text a
    // person typed, never FTS5 syntax: this call answers a list, not an error.
    const items = await searchLocal(db, { q: text, accountId: scope.account?.id ?? null, limit });
    res.json({ items });
  }));

  // POST /search/remote — ask each account's server, and store what it finds. A write, so a POST:
  // CSRF is the dashboard's, and each account's failure is reported beside the others' successes
  // instead of failing the call.
  router.post(`${base}/search/remote`, route("POST /search/remote", async (db, req, res) => {
    const body = req.body != null && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const text = readQuery(body.q);
    if (!text) return sendError(res, 400, "bad_input");
    const limit = readLimit(body.limit, DEFAULT_REMOTE_SEARCH_LIMIT);
    if (limit === null) return sendError(res, 400, "bad_input");

    const supervisor = supervisorNow();
    if (!supervisor) return sendError(res, 503, "unavailable");

    const scope = await accountScope(db, body.account);
    if (!scope.ok) return sendError(res, 404, "not_found");
    // A named account is searched even if it is not `active` (the supervisor refuses a claimed or a
    // signed-out one without connecting); with no account named, only the accounts this instance may
    // talk to are asked.
    const targets = scope.account
      ? [scope.account]
      : (await listAccounts(db)).filter((account) => account.status === "active");

    if (targets.some((account) => inFlightRemoteSearch.has(account.id))) return sendBusy(res);
    for (const account of targets) inFlightRemoteSearch.add(account.id);

    let added = 0;
    const failures = [];
    try {
      for (const account of targets) {
        try {
          const result = await withCap(remoteSearchCapMs, () => supervisor.withAdapter(account.id, (adapter, control) => searchRemote(
            {
              db,
              adapter,
              now: Date.now,
              deadlineAt: Date.now() + remoteSearchCapMs,
              // The supervisor's own stop, so a search it closed out (a delete) ends the pass instead
              // of storing the batch that is already in its hands.
              cancelled: control?.cancelled,
              log: logEngineEvent,
            },
            account.id,
            text,
            { limit },
          )), "remote_search_cap");
          added += Number(result?.added) || 0;
        } catch (err) {
          // One account's refusal is that account's row in `failures`, in the code's own sentence; the
          // accounts after it still run, and the answer still reports the rows the others stored.
          const mailErr = toMailError(err);
          failures.push({ accountId: account.id, error: MAIL_ERROR_TEXT[mailErr.code] });
          logCode("POST /search/remote", mailErr);
        }
      }
    } finally {
      for (const account of targets) inFlightRemoteSearch.delete(account.id);
    }
    res.json({ added, failures });
  }));

  /* --------------------------------------------------------------------- older */

  // POST /folders/:id/older — continue one folder's history backwards, below the lowest UID Crow
  // holds. Its failure is a MailError like any other, so the shared helper answers the code's status
  // and its fixed sentence, and nothing else.
  router.post(`${base}/folders/:id/older`, route("POST /folders/:id/older", async (db, req, res) => {
    const folder = await getFolder(db, req.params.id);
    if (!folder) return sendError(res, 404, "not_found");
    const account = await getAccount(db, folder.accountId);
    if (!account) return sendError(res, 404, "not_found");

    const supervisor = supervisorNow();
    if (!supervisor) return sendError(res, 503, "unavailable");

    if (inFlightOlder.has(folder.accountId)) return sendBusy(res);
    inFlightOlder.add(folder.accountId);
    try {
      const outcome = await withCap(olderCapMs, () => supervisor.withAdapter(folder.accountId, (adapter, control) => fetchOlder(
        {
          db,
          adapter,
          now: Date.now,
          deadlineAt: Date.now() + olderCapMs,
          // The supervisor's own stop, so a page it closed out (a delete) ends the pass instead of
          // storing the batch of bodies it had already fetched.
          cancelled: control?.cancelled,
        },
        folder.accountId,
        folder.id,
      )), "older_cap");
      res.json({ added: Number(outcome?.added) || 0, reachedStart: outcome?.reachedStart === true });
    } finally {
      inFlightOlder.delete(folder.accountId);
    }
  }));
}

/** The allow-list body, or null. The sender is a plain address, lower-cased before it is stored. */
function readImageAllowBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  if (typeof body.accountId !== "string" || body.accountId === "") return null;
  const sender = readPlainAddress(body.sender);
  if (!sender) return null;
  return { accountId: body.accountId, sender };
}

/**
 * The engine's own log sink for a route: an event name and a code, which is all a sync line may carry
 * (a folder id or a count is fine too, and never a subject, an address or a library's text).
 */
function logEngineEvent(line) {
  try {
    const event = typeof line?.event === "string" ? line.event : "event";
    const code = typeof line?.code === "string" ? ` ${line.code}` : "";
    console.warn(`[mail-api] remote_search: ${event}${code}`);
  } catch {
    // A log line is never worth failing a request over.
  }
}

export default registerMessageRoutes;