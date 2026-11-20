/**
 * Crow Messages' draft routes: the owner's own HTTP surface for a draft of a message to a
 * conversation (a contact or a room), under `/dashboard/messages/api/drafts`.
 *
 * A bot's message is ALWAYS a draft in v1. This is the door the owner's card uses to read it, autosave
 * an edit, send it and throw it away — and the same routes create and edit the owner's own drafts.
 *
 * Every request passes the same chain, in this order, and each step refuses before the next can read
 * anything:
 *
 *   1. `dashboardAuth` on this router's own prefix, so the API is closed wherever it is mounted.
 *   2. `Cache-Control: no-store` — a draft holds who a message is for and the words of it.
 *   3. the owner: `isLocalPasswordSessionOn` (this machine's own password sign-in, from the owner's
 *      client). A peer's single-sign-on session, a session minted by a login on this machine, a
 *      signed peer call and this machine's own console all get 403 `{error:"owner_only"}` with no
 *      data; no row is read before the verdict.
 *   4. the fetch-metadata rail on every state-changing method: `isSameOriginRequest`
 *      (dashboard/same-origin.js) refuses a request a browser says another site sent
 *      (`Sec-Fetch-Site: cross-site`, or an `Origin` that is not this gateway) with 403
 *      `{error:"cross_site"}`. A request carrying neither header is not a browser page and passes —
 *      the CSRF token below is what stands in front of it, exactly as on every other /dashboard route.
 *   5. this router's own `express.json({limit:"64kb"})`: a bigger body is 413 `{error:"too_large"}` and
 *      a malformed one 400 `{error:"bad_input"}`, from here rather than from the gateway's global 1mb
 *      parser (the prefix is in `servers/gateway/index.js`'s `_hasOwnParser`, so the global parser
 *      never sees a draft body first).
 *
 * CSRF is the dashboard's `csrfMiddleware`, which already guards every unsafe method on this mount
 * (dashboard/index.js mounts this router after it), so no route here handles a token itself.
 *
 * Nothing is decided here. Every route parses a body, calls one store function (and, for a send, one
 * delivery function) and maps its answer:
 *
 *   - `GET  /`               — the conversation's open draft, or the drafts a filter names. The rows
 *                              are `draftRowViews` (servers/gateway/messages/drafts-rows.js) — the
 *                              SAME display rows the panel's server render draws (`kind`, `label`,
 *                              `preview`, `botName`, `version`, `updatedAt`, `body`), because the
 *                              panel's live redraw feeds this answer straight into the row builder.
 *                              Replying with the store's raw columns loses the name and the kind, and
 *                              a room draft's row then opens a contact thread with the room's id.
 *   - `GET  /:id`            — one draft and its audit trail (ids and hashes only).
 *   - `PUT  /`               — create the owner's draft for a conversation. `expectVersion: 0` is
 *                              CREATE ONLY: an open draft already there is 409 `changed` WITH it, and
 *                              the client adopts that row instead of overwriting words it never read.
 *                              A positive `expectVersion` is the compare-and-set of an upsert. The
 *                              route writes `origin: "owner"` and takes no origin from the body — a
 *                              bot's draft comes through the bot door (part 2), not through here.
 *   - `PATCH /:id/body`      — the autosave. `expectVersion` is the compare-and-set; a lost race is
 *                              409 `{error:"changed", version, draft}` with the row as it now is.
 *   - `POST /:id/send`       — send the POSTED text through the Messages send path for this
 *                              conversation kind (drafts-send.js). Before anything moves: the seal
 *                              must verify (`seal_invalid`), the audience must still be the same
 *                              people (`recipients_changed`), each of them must still be unblocked
 *                              (`blocked`) with the key the draft sealed (`pubkey_changed`), and the
 *                              conversation must still exist (`conversation_gone`). The delivery is
 *                              handed the sealed audience and re-checks it by primary id immediately
 *                              before it hands the text to a transport, so the same three codes can
 *                              also come back from that handoff — a row that moved in the window
 *                              between this check and the send never receives the words. A delivery
 *                              that does not land answers 502 WITH the reopened draft and its
 *                              version, so the client can try again rather than collide with the row.
 *   - `POST /:id/discard`    — throw it away (`open` -> `discarded`; the row stays for the audit).
 *
 * The text is sent as posted. Nothing appends a "Sent by …" line — an owner's draft goes out as the
 * owner's words, and a bot's part in it lives on the row (`origin`, `bot_id`) and in the audit trail.
 *
 * Every write pokes the gateway's event bus with `message-drafts:changed` (ids only) from the store,
 * which is what part 2's SSE route and the panel's client listen for.
 *
 * Error bodies are `{error, message}` with a fixed sentence per code; no store detail, no library
 * message and no message text ever reaches one. Dependencies arrive through `deps` (`openDb`,
 * `ownerCheck`) or the module-level runtime `setMessagesDraftsRuntime({loadSeed, now, send, managers})`
 * — the seams a test uses.
 *
 * A draft a BOT wrote answers with `botName` (its `pi_bot_defs.display_name`, or its id when the
 * definition is gone) so the panel can draw "Draft by <bot>" without a second lookup of its own;
 * an owner's draft answers `botName: null`. See servers/gateway/messages/drafts-bots.js.
 */
import { Router, json as jsonParserOf } from "express";
import { createDbClient } from "../../db.js";
import { isLocalPasswordSessionOn } from "../dashboard/local-session.js";
import { isSameOriginRequest } from "../dashboard/same-origin.js";
import { CONVERSATION_KINDS, audienceKeyChanges, resolveConversation, sameAudience } from "../messages/conversations.js";
import { draftsWithBotNames } from "../messages/drafts-bots.js";
import { draftRowViews } from "../messages/drafts-rows.js";
import { loadDraftSealSeed, verifyRecipients } from "../messages/drafts-seal.js";
import {
  DRAFT_STATES,
  DraftError,
  beginSend,
  createDraft,
  discardDraft,
  getDraft,
  getOpenDraft,
  listAudit,
  listDrafts,
  markSendFailed,
  markSent,
  markSentLate,
  sealFieldsFor,
  updateBody,
} from "../messages/drafts-store.js";
import { sendDraftMessage } from "../messages/drafts-send.js";

/** The mount point. The gateway's global JSON parser skips this prefix (see index.js `_hasOwnParser`). */
export const MESSAGES_DRAFTS_API_PREFIX = "/dashboard/messages/api/drafts";

/** The fixed sentences a card can show. Codes without one answer their code alone. */
const FIXED_TEXT = Object.freeze({
  not_found: "Not found.",
  owner_only: "Only the owner can see this.",
  cross_site: "That request came from another site.",
  too_large: "That request is too large.",
  bad_input: "That request is not valid.",
  changed: "This draft changed while you were looking at it.",
  not_open: "This draft is no longer open.",
  seal_invalid: "This draft's recipients could not be verified, so nothing was sent.",
  recipients_changed: "Who this message would reach has changed. Open the draft again before sending.",
  pubkey_changed: "One of the recipients' keys changed since this draft was written, so nothing was sent.",
  blocked: "One of the recipients is blocked, so nothing was sent.",
  conversation_gone: "That conversation is gone.",
  delivery_failed: "The message could not be delivered. The draft is still here to try again.",
  send_failed: "The message could not be sent. The draft is still here to try again.",
  seal_unavailable: "This Crow has no usable key to seal a draft's recipients, so nothing was saved.",
  no_recipients: "This conversation has nobody in it to receive a message yet.",
  internal: "Something went wrong.",
});

/** The body keys each route accepts, and nothing else. The create takes no origin: this door writes
 *  the OWNER's drafts, and a bot's draft comes through the bot door (part 2). */
const CREATE_KEYS = Object.freeze([
  "conversationKind", "conversationId", "body", "expectVersion",
]);
const BODY_KEYS = Object.freeze(["body", "expectVersion"]);
const DISCARD_KEYS = Object.freeze(["expectVersion"]);

/* ------------------------------------------------------------------- runtime */

const EMPTY_RUNTIME = Object.freeze({ loadSeed: null, now: null, send: null, managers: null });

let runtime = EMPTY_RUNTIME;

/**
 * Replace the injectable half of the routes' seam: the seal seed loader, the clock, the delivery
 * function and the room send's `managers` (boot sets none of them; a test sets all four).
 *
 * @param {{loadSeed?: Function, now?: Function|number, send?: Function, managers?: object|Function|null}} [next]
 */
export function setMessagesDraftsRuntime(next = {}) {
  runtime = {
    loadSeed: typeof next?.loadSeed === "function" ? next.loadSeed : null,
    now: typeof next?.now === "function" || Number.isFinite(next?.now) ? next.now : null,
    send: typeof next?.send === "function" ? next.send : null,
    managers: typeof next?.managers === "function" || (next?.managers != null && typeof next.managers === "object")
      ? next.managers
      : null,
  };
}

/** Forget the seam: shutdown, and a test that must not inherit another test's clock or sender. */
export function clearMessagesDraftsRuntime() {
  runtime = EMPTY_RUNTIME;
}

/** The store options one call gets: the injected clock and seed loader, when there are any. */
function storeOpts(extra = {}) {
  const opts = { ...extra };
  if (runtime.now != null) opts.now = runtime.now;
  if (typeof runtime.loadSeed === "function") opts.loadSeed = runtime.loadSeed;
  return opts;
}

/** The room send's `managers`: the seam's, else this process's sharing runtime (null when none). */
async function managersFor() {
  if (typeof runtime.managers === "function") return runtime.managers();
  if (runtime.managers != null) return runtime.managers;
  try {
    const mod = await import("../../sharing/managers.js");
    return mod.getManagersOrNull?.() ?? null;
  } catch {
    return null;
  }
}

/** The seed a send verifies with: the seam's loader, else this instance's keychain key. */
async function seedFor() {
  if (typeof runtime.loadSeed === "function") return await runtime.loadSeed();
  return loadDraftSealSeed();
}

/* ------------------------------------------------------------------ answers */

function messageFor(code) {
  return FIXED_TEXT[code] || FIXED_TEXT.internal;
}

/** One JSON error: a fixed sentence, never a caller's text. */
function sendError(res, status, code, message = null) {
  if (res.headersSent) return;
  res.status(status).json({ error: code, message: message || messageFor(code) });
}

/** A store refusal mapped to its status: the store's own code, and a field name at most. */
function sendDraftError(res, err) {
  if (err instanceof DraftError) {
    if (err.code === "NOT_FOUND") return sendError(res, 404, "not_found");
    if (err.code === "SEAL_UNAVAILABLE") return sendError(res, 409, "seal_unavailable");
    return sendError(res, 400, "bad_input");
  }
  sendError(res, 500, "internal");
}

/** A compare-and-set that lost: 409 with the row as it now is, including its current version. */
async function sendRefused(db, res, outcome) {
  const draft = outcome?.draft ?? null;
  const code = outcome?.refused === "not_open" ? "not_open" : "changed";
  return res.status(409).json({
    error: code,
    message: messageFor(code),
    version: draft?.version ?? null,
    draft: await viewOne(db, draft),
  });
}

/**
 * A send the route itself refused (a seal, an audience or a delivery that did not hold): the fixed
 * sentence for the code, AND the row with its current version. The row is the whole point — a client
 * that retries with the version it still holds would otherwise collide with a row that never moved
 * out of `open` — and `draft.state` tells it whether there is anything left to try again with.
 */
async function sendRefusal(db, res, status, code, draftId) {
  const row = draftId ? await getDraft(db, draftId) : null;
  return res.status(status).json({
    error: code,
    message: messageFor(code),
    version: row?.version ?? null,
    draft: await viewOne(db, row),
  });
}

/* ------------------------------------------------------------------ validation */

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** The body as an object, or null when it is not one. An absent body is the empty object. */
function bodyOf(req) {
  if (req.body == null) return {};
  return isPlainObject(req.body) ? req.body : null;
}

/** Every key of `body` is one of `keys`: an unknown one is the caller's input, not a fault. */
function keysWithin(body, keys) {
  for (const key of Object.keys(body)) if (!keys.includes(key)) return false;
  return true;
}

/** A body could carry at most this much text; the parser's own 64 KB is the ceiling above it. */
const BODY_FIELD_MAX = 60_000;

/**
 * The autosave/send body, or null: the text and the version it was drawn from. BOTH are required —
 * a write without the version it came from is a blind overwrite, which is the one thing the
 * compare-and-set exists to stop.
 */
function readBodyWrite(body) {
  if (!keysWithin(body, BODY_KEYS)) return null;
  if (typeof body.body !== "string" || body.body.length > BODY_FIELD_MAX) return null;
  if (!Number.isInteger(body.expectVersion) || body.expectVersion < 1) return null;
  return { body: body.body, expectVersion: body.expectVersion };
}

/**
 * The create body, or null. `expectVersion` is REQUIRED and may be `0`: that is the composer's
 * "create only, there is nothing here yet" — an open draft already in the conversation is 409
 * `changed` with that row, never an overwrite of words this caller has not read. A positive value is
 * the compare-and-set of an upsert. The route takes no `origin`: it writes the owner's drafts only.
 */
function readCreateBody(body) {
  if (!keysWithin(body, CREATE_KEYS)) return null;
  if (typeof body.conversationKind !== "string" || !CONVERSATION_KINDS.includes(body.conversationKind)) return null;
  if (!Number.isInteger(body.conversationId) || body.conversationId <= 0) return null;
  if (body.body !== undefined && typeof body.body !== "string") return null;
  if (body.body !== undefined && body.body.length > BODY_FIELD_MAX) return null;
  if (!Number.isInteger(body.expectVersion) || body.expectVersion < 0) return null;
  return {
    conversationKind: body.conversationKind,
    conversationId: body.conversationId,
    body: typeof body.body === "string" ? body.body : "",
    expectVersion: body.expectVersion,
  };
}

/**
 * One draft as the routes answer it: the store's row, plus the display name of the bot that wrote it
 * (`botName`, looked up from `pi_bot_defs`; null for an owner's draft) and nothing derived from the
 * key. The name is resolved here, on the server, so the panel never has to know a bot id is a
 * definition row, and every surface names a bot the same way.
 */
async function viewOne(db, draft) {
  if (!draft) return draft;
  const [view] = await draftsWithBotNames(db, [draft]);
  return view;
}

/* -------------------------------------------------------------------- the router */

/**
 * The drafts router.
 *
 * @param {Function} dashboardAuth the dashboard's auth middleware
 * @param {{openDb?: Function, ownerCheck?: Function}} [deps]
 *   `openDb` mints the request's crow.db client (one per request, closed in `finally`);
 *   `ownerCheck` defaults to `isLocalPasswordSessionOn`.
 * @returns {import("express").Router}
 */
export function messagesDraftsRouter(dashboardAuth, deps = {}) {
  const router = Router();
  const openDb = typeof deps.openDb === "function" ? deps.openDb : () => createDbClient();
  const ownerCheck = typeof deps.ownerCheck === "function" ? deps.ownerCheck : isLocalPasswordSessionOn;
  const jsonParser = jsonParserOf({ limit: "64kb" });
  const base = MESSAGES_DRAFTS_API_PREFIX;

  /** One client per request, closed in `finally`; a handler that throws answers its own code. */
  const route = (handler) => async (req, res) => {
    const db = openDb();
    try {
      await handler(db, req, res);
    } catch (err) {
      sendDraftError(res, err);
    } finally {
      try {
        db.close();
      } catch {
        // Already closed is the only failure a per-request client has here.
      }
    }
  };

  router.use(base, dashboardAuth);

  /** Never cached: a draft holds who a message is for and the words of it. */
  router.use(base, (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  /** The owner: this instance's own password session, from the owner's own client. */
  router.use(base, async (req, res, next) => {
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
  });

  /** A browser that says another site sent this, or names another origin, is refused before a body
   *  is parsed. Read-only methods are untouched: they change nothing. */
  router.use(base, (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!isSameOriginRequest(req)) return sendError(res, 403, "cross_site");
    next();
  });

  /** 64 KB is far above any message a person types and far below a mailbox; the answers are ours. */
  router.use(base, (req, res, next) => jsonParser(req, res, (err) => {
    if (!err) return next();
    const status = Number(err.status || err.statusCode || 0);
    if (status === 413 || err.type === "entity.too.large") return sendError(res, 413, "too_large");
    return sendError(res, 400, "bad_input");
  }));

  /* ------------------------------------------------------------------- reads */

  // GET / — the drafts a filter names, newest first. `?conversation=contact:12` (or `room:7`) is the
  // card's own lookup; `?state=open` is the default when a conversation is named, and `state=all`
  // lists every state. Without a conversation the answer is every draft of that state.
  router.get(base, route(async (db, req, res) => {
    const filter = {};
    const rawConversation = req.query?.conversation;
    if (rawConversation !== undefined) {
      if (typeof rawConversation !== "string") return sendError(res, 400, "bad_input");
      const match = /^(contact|room):(\d{1,12})$/.exec(rawConversation);
      if (!match) return sendError(res, 400, "bad_input");
      filter.conversationKind = match[1];
      filter.conversationId = Number(match[2]);
    }
    const rawState = req.query?.state;
    if (rawState !== undefined) {
      if (typeof rawState !== "string") return sendError(res, 400, "bad_input");
      if (rawState !== "all") {
        if (!DRAFT_STATES.includes(rawState)) return sendError(res, 400, "bad_input");
        filter.state = rawState;
      }
    } else if (filter.conversationKind != null) {
      filter.state = "open";
    }
    const rawLimit = req.query?.limit;
    if (rawLimit !== undefined) {
      const limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1) return sendError(res, 400, "bad_input");
      filter.limit = limit;
    }
    res.json({ drafts: await draftRowViews(db, await listDrafts(db, filter)) });
  }));

  // GET /:id — one draft and its audit trail, oldest first (ids and hashes only).
  router.get(`${base}/:id`, route(async (db, req, res) => {
    const draft = await getDraft(db, String(req.params.id ?? ""));
    if (!draft) return sendError(res, 404, "not_found");
    res.json({ draft: await viewOne(db, draft), audit: await listAudit(db, draft.id) });
  }));

  /* ------------------------------------------------------------------ writes */

  // PUT / — create the owner's draft for a conversation. `expectVersion: 0` is CREATE ONLY (the
  // composer's first keystroke): an open draft already there is a 409 with that row, and the client
  // adopts it — words another view saved are never replaced by words typed in ignorance of them. The
  // audience is derived from the LIVE conversation (keys included) and sealed by the store, so a
  // caller never supplies it. `origin` is not accepted: a bot's draft comes through the bot door.
  router.put(base, route(async (db, req, res) => {
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readCreateBody(body);
    if (input == null) return sendError(res, 400, "bad_input");

    const conversation = await resolveConversation(db, {
      kind: input.conversationKind,
      id: input.conversationId,
    });
    if (!conversation.ok) {
      return sendError(res, conversation.reason === "bad_kind" ? 400 : 404,
        conversation.reason === "bad_kind" ? "bad_input" : "not_found");
    }
    // A draft is sealed over who it reaches, so a conversation with nobody in it has nothing to seal.
    if (conversation.recipients.length === 0) return sendError(res, 409, "no_recipients");

    const outcome = await createDraft(db, {
      conversationKind: conversation.kind,
      conversationId: conversation.id,
      body: input.body,
      recipients: conversation.recipients,
      origin: "owner",
      botId: null,
      botName: null,
      expectVersion: input.expectVersion,
    }, storeOpts());
    if (!outcome.ok) return sendRefused(db, res, outcome);
    res.status(outcome.created ? 201 : 200).json({
      draft: await viewOne(db, outcome.draft),
      created: outcome.created,
      label: conversation.label,
    });
  }));

  // PATCH /:id/body — the autosave. `expectVersion` is required: an autosave without the version it
  // was drawn from is a blind overwrite, and a stale one is 409 `{error:"changed", version, draft}`.
  router.patch(`${base}/:id/body`, route(async (db, req, res) => {
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readBodyWrite(body);
    if (input == null) return sendError(res, 400, "bad_input");

    const outcome = await updateBody(db, String(req.params.id ?? ""), input, storeOpts());
    if (!outcome.ok) return sendRefused(db, res, outcome);
    res.json({ draft: await viewOne(db, outcome.draft) });
  }));

  // POST /:id/send — the tap. The posted text is what is sent, exactly, through the send path this
  // conversation kind already has. Before anything moves, and in this order:
  //   1. the row must still be `open`;
  //   2. its seal must verify under this instance's key — a row somebody edited by hand (a bot
  //      writing the table directly, a draft whose origin or bot was rewritten) fails here;
  //   3. the audience is re-derived from the LIVE conversation: the same PEOPLE (`recipients_changed`
  //      when a room's membership moved), none of them blocked (`blocked`), and each one still holding
  //      the KEY the draft sealed (`pubkey_changed`);
  //   4. the conversation must still exist (`conversation_gone`).
  // Every refusal answers with the row and its version, so the client never retries against a stale
  // version. Then the compare-and-set (`beginSend`) takes the row into `sending`; a delivery that
  // lands is `sent`, one that does not is put back to `open` with a reason code and answered 502 WITH
  // the reopened row, so the text is still there to try again. A delivery that lands on a row somebody
  // moved out from under it (the boot pass reopened it while the send was in flight) is closed with the
  // sent message id anyway (`markSentLate`): the message went out, so the row must not stay open
  // holding text the next tap would send a second time.
  router.post(`${base}/:id/send`, route(async (db, req, res) => {
    const id = String(req.params.id ?? "");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readBodyWrite(body);
    if (input == null) return sendError(res, 400, "bad_input");
    if (input.body.trim() === "") return sendError(res, 400, "bad_input");

    const draft = await getDraft(db, id);
    if (!draft) return sendError(res, 404, "not_found");
    if (draft.state !== "open") {
      return res.status(409).json({
        error: "not_open", message: messageFor("not_open"), version: draft.version,
        draft: await viewOne(db, draft),
      });
    }

    const seed = await seedFor();
    if (!seed) return sendError(res, 409, "seal_unavailable");
    if (!verifyRecipients(sealFieldsFor(draft), draft.recipientsSeal, seed)) {
      return sendRefusal(db, res, 409, "seal_invalid", id);
    }

    const conversation = await resolveConversation(db, {
      kind: draft.conversationKind,
      id: draft.conversationId,
    });
    if (!conversation.ok) return sendRefusal(db, res, 409, "conversation_gone", id);
    if (!sameAudience(conversation.recipients, draft.recipients)) {
      return sendRefusal(db, res, 409, "recipients_changed", id);
    }
    const changedKeys = audienceKeyChanges(draft.recipients, conversation.recipients);
    if (!changedKeys.ok) return sendRefusal(db, res, 409, changedKeys.reason, id);

    const begun = await beginSend(db, id, input, storeOpts());
    if (!begun.ok) return sendRefused(db, res, begun);

    const send = typeof runtime.send === "function" ? runtime.send : sendDraftMessage;
    let result;
    try {
      result = await send(db, begun.draft, input.body, { managers: await managersFor() });
    } catch {
      result = { ok: false, reason: "send_failed" };
    }
    if (!result?.ok) {
      await markSendFailed(db, id, { reason: result?.reason || "send_failed" }, storeOpts());
      // A handoff refusal (the row about to receive the text is not the one the draft sealed) is a
      // 409 with its own code and sentence, exactly as the pre-send checks answer it: nothing was
      // sent, and the card must not read it as a failed delivery to retry.
      const refused = result?.reason === "recipients_changed" || result?.reason === "pubkey_changed"
        || result?.reason === "blocked";
      const code = refused
        ? result.reason
        : result?.reason === "conversation_gone"
          ? "conversation_gone"
          : result?.reason === "delivery_failed" ? "delivery_failed" : "send_failed";
      // The row is `open` again (or parked as `failed` when a newer draft took the conversation):
      // answering with it and its version is what makes "try again" a retry instead of a 409.
      const status = code === "delivery_failed" || code === "send_failed" ? 502 : 409;
      return sendRefusal(db, res, status, code, id);
    }

    const landed = await markSent(db, id, { messageId: result.messageId ?? null }, storeOpts());
    if (!landed) {
      // The message DID go out, but the row was no longer `sending` — the boot pass reopened it (or
      // parked it) while this send was in flight, in this process or in another gateway sharing
      // crow.db. Leaving it open would offer the words that just left as a draft to send again, so the
      // row is closed on the sent id and the audit says why ("sent-late").
      await markSentLate(db, id, { messageId: result.messageId ?? null }, storeOpts());
    }
    const sent = await getDraft(db, id);
    res.json({ ok: true, draft: await viewOne(db, sent) });
  }));

  // POST /:id/discard — throw it away. `expectVersion` is optional: the card sends the version it was
  // drawn from, and a stale one is the same 409 as a stale edit.
  router.post(`${base}/:id/discard`, route(async (db, req, res) => {
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    if (!keysWithin(body, DISCARD_KEYS)) return sendError(res, 400, "bad_input");
    if (body.expectVersion !== undefined && (!Number.isInteger(body.expectVersion) || body.expectVersion < 1)) {
      return sendError(res, 400, "bad_input");
    }
    const outcome = await discardDraft(
      db,
      String(req.params.id ?? ""),
      { expectVersion: body.expectVersion ?? null },
      storeOpts(),
    );
    if (!outcome.ok) return sendRefused(db, res, outcome);
    res.json({ ok: true, draft: await viewOne(db, outcome.draft) });
  }));

  return router;
}

/**
 * The open draft of one conversation, for a caller (part 2's panel render) that already holds a db
 * client and must not go through HTTP for it.
 */
export async function openDraftFor(db, conversationKind, conversationId) {
  return getOpenDraft(db, conversationKind, conversationId);
}

export default messagesDraftsRouter;