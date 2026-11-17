/**
 * Crow Mail's draft routes: the owner's own HTTP surface for one draft card, under
 * `/dashboard/mail/api/drafts`.
 *
 * These are plan 1's guards, used rather than rebuilt: `mail-api.js` mounts the flag, owner,
 * no-store and 64 KB body-parser chain on this router's prefix before this function registers
 * anything (and `servers/gateway/index.js`'s `_hasOwnParser` already hands every
 * `/dashboard/mail/api/` path to that parser), so every route here answers 404 while `CROW_MAIL` is
 * unset, 403 `{error:"owner_only"}` for any session that is not this machine's own password session,
 * and a body over 64 KB is 413 `{error:"too_large"}` from the mail router's own parser. CSRF is the
 * dashboard's middleware, already on this mount.
 *
 * Nothing is decided here. Every route parses a body, calls one service and maps its answer:
 * `requestSend`, `undoSend`, `scheduleDraft`, `cancelSchedule`, `addRevision`, `transition`,
 * `discardDraft`, `createDraft`, `deriveReply`, `deriveForward` and `preflight` as their own modules
 * export them. A tap always carries the hash the card was drawn from (`expectHash` for an edit,
 * `hash` for send and schedule), because the guarded UPDATE behind the service is the compare-and-set
 * that refuses a draft that changed under the person's eyes. The send and schedule services are the
 * only code that can enter `holding`/`scheduled`; this file never writes a state itself.
 *
 * Two deliberate refusals of the plan's first sketch, both issued by the controller:
 *   - `POST /:id/revisions` always tells the store `cancelSchedule: true`, so a hand edit of a
 *     scheduled draft returns it to `draft` and the person re-schedules it. The 409
 *     `{error:"scheduled", needsCancel:true}` branch exists only for `cancelSchedule: false`, which
 *     this route never sends, so it is not here.
 *   - `POST /:id/revise`, `POST /:id/comments` and `POST /:id/save-draft` belong to later tasks and
 *     are not registered here.
 *
 * Error bodies are `{error, message}`: `changed` answers `CHANGED_SENTENCE`, a tap's own refusal
 * passes the service's sentence through, a preflight refusal answers the `bad_input` (or
 * `too_large`) fixed sentence with the reason beside it, and `confirm_needed` answers the sentence
 * the unknown state carries. A refusal whose copy the plan does not fix answers its code alone
 * (`frozen`, `not_scheduled`, `not_discardable`) — the card owns that text, not the server.
 *
 * Dependencies are the seam: the running supervisor's `withAdapter`/`requestSync` when this process
 * has one, the two attachment readers (`drafts/readers.js`), and — for a test, or for a caller that
 * needs a different clock — whatever `setMailDraftsRuntime` set. A send or schedule gets that bundle; a
 * drafting turn gets only its clock (`turnDeps`), because a turn never reaches an adapter. A drafting
 * turn is `startDraftingTurn` from `drafts/turn.js` if it was injected, otherwise that module is
 * imported on the first `/turn` request; while it does not exist the answer is 503
 * `{error:"unavailable"}`.
 */
import { MAIL_ERROR_TEXT } from "../mail/errors.js";
import { getAccount } from "../mail/store/accounts.js";
import { resolveMessageRef } from "../mail/store/reader-queries.js";
import {
  DRAFT_MODES,
  addRevision,
  createDraft,
  discardDraft,
  getDraft,
  listComments,
  listRevisions,
} from "../mail/drafts/store.js";
import { preflight } from "../mail/drafts/preflight.js";
import { deriveForward, deriveReply } from "../mail/drafts/recipients.js";
import { makeDraftReaders } from "../mail/drafts/readers.js";
import {
  CHANGED_SENTENCE,
  SEND_FAIL_REASONS,
  UNKNOWN_STATE_SENTENCE,
  requestSend,
  undoSend,
} from "../mail/send/send-service.js";
import { cancelSchedule, parseRouteDueAt, scheduleDraft } from "../mail/send/schedule-service.js";
import { instanceZone } from "../../shared/schedule-store.js";
// The mount point mail-api.js sets on this same router. It is read when routes are registered (that
// module has finished evaluating by then), never at module load: the two files import each other.
import { MAIL_API_PREFIX } from "./mail-api.js";

/** A draft id, exactly what the store mints. Anything else is a 404 here. */
export const MAIL_DRAFT_ID_RE = /^md-[0-9a-f]{16}$/;

/** The states a bot may draft on: the store's own editable set (`addRevision`'s rule). */
const EDITABLE_STATES = Object.freeze(["draft", "failed", "missed"]);

/** The keys each body may carry, and nothing else: no `from`, no `headers`, no `envelope`. */
const CREATE_KEYS = Object.freeze(["accountId", "mode", "replyToMid", "projectId", "botId", "audience"]);
const REVISION_KEYS = Object.freeze([
  "expectHash", "to", "cc", "subject", "body", "attachments", "cancelSchedule",
]);
const SEND_KEYS = Object.freeze(["hash", "confirmUnknown"]);
const SCHEDULE_KEYS = Object.freeze(["hash", "dueAt"]);
const TURN_KEYS = Object.freeze(["botId", "instruction"]);

/* --------------------------------------------------------------------- the seam */

const EMPTY_RUNTIME = Object.freeze({
  loadKey: null,
  schedule: null,
  now: null,
  startDraftingTurn: null,
  readMessageRaw: null,
  readStorageFile: null,
});

let runtime = EMPTY_RUNTIME;

/**
 * Replace the injectable half of the routes' seam (boot sets nothing; a test sets a fake clock, a
 * seed and a drafting turn).
 *
 * @param {{loadKey?: Function, schedule?: Function, now?: Function, startDraftingTurn?: Function,
 *   readMessageRaw?: Function, readStorageFile?: Function}} [next]
 */
export function setMailDraftsRuntime(next = {}) {
  const pick = (key) => (typeof next?.[key] === "function" ? next[key] : null);
  runtime = {
    loadKey: pick("loadKey"),
    schedule: pick("schedule"),
    now: pick("now"),
    startDraftingTurn: pick("startDraftingTurn"),
    readMessageRaw: pick("readMessageRaw"),
    readStorageFile: pick("readStorageFile"),
  };
}

/** Forget the seam: shutdown, and a test that must not inherit another test's clock or turn. */
export function clearMailDraftsRuntime() {
  runtime = EMPTY_RUNTIME;
}

/**
 * The deps one service call gets: the running supervisor's borrowed connection when this process has
 * one (an absent supervisor is left absent, so the send service's own `sendRuntimeReady` answer is
 * the truth), the two attachment readers, and whatever the seam injected.
 */
function serviceDeps(db, supervisor) {
  const readers = makeDraftReaders({ db, supervisor });
  const deps = {
    readMessageRaw: runtime.readMessageRaw ?? readers.readMessageRaw,
    readStorageFile: runtime.readStorageFile ?? readers.readStorageFile,
  };
  if (supervisor != null) {
    deps.withAdapter = (accountId, fn) => supervisor.withAdapter(accountId, fn);
    if (typeof supervisor.requestSync === "function") {
      deps.requestSync = (accountId) => supervisor.requestSync(accountId);
    }
  }
  for (const key of ["loadKey", "schedule", "now"]) {
    if (typeof runtime[key] === "function") deps[key] = runtime[key];
  }
  return deps;
}

/**
 * The deps one drafting turn gets. A turn reads the draft's thread through its own MCP tools and
 * starts one pi spawn: it never sends, so it gets no adapter, no sync and no key — only the clock the
 * seam injected. Everything else `startDraftingTurn` needs it imports or defaults itself.
 *
 * @returns {{now?: Function}}
 */
function turnDeps() {
  return typeof runtime.now === "function" ? { now: runtime.now } : {};
}

/* ------------------------------------------------------------------ the bodies */

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

function isStringOrAbsent(value) {
  return value === undefined || value === null || typeof value === "string";
}

function isArrayOrAbsent(value) {
  return value === undefined || value === null || Array.isArray(value);
}

/** The create body, or null: an account, a mode, and the optional ids a card may already carry. */
function readCreateBody(body) {
  if (!keysWithin(body, CREATE_KEYS)) return null;
  if (typeof body.accountId !== "string" || body.accountId === "") return null;
  if (typeof body.mode !== "string" || !DRAFT_MODES.includes(body.mode)) return null;
  for (const key of ["replyToMid", "botId", "audience"]) {
    if (!isStringOrAbsent(body[key])) return null;
  }
  if (body.projectId !== undefined && body.projectId !== null && !Number.isInteger(body.projectId)) return null;
  return {
    accountId: body.accountId,
    mode: body.mode,
    replyToMid: typeof body.replyToMid === "string" && body.replyToMid !== "" ? body.replyToMid : null,
    projectId: body.projectId ?? null,
    botId: typeof body.botId === "string" && body.botId !== "" ? body.botId : null,
    audience: typeof body.audience === "string" && body.audience !== "" ? body.audience : null,
  };
}

/** The hand-edit body, or null. `cancelSchedule` is accepted and ignored: this route always cancels. */
function readRevisionBody(body) {
  if (!keysWithin(body, REVISION_KEYS)) return null;
  if (typeof body.expectHash !== "string" || body.expectHash === "") return null;
  if (!isArrayOrAbsent(body.to) || !isArrayOrAbsent(body.cc) || !isArrayOrAbsent(body.attachments)) return null;
  if (!isStringOrAbsent(body.subject) || !isStringOrAbsent(body.body)) return null;
  return {
    expectHash: body.expectHash,
    to: Array.isArray(body.to) ? body.to : [],
    cc: Array.isArray(body.cc) ? body.cc : [],
    subject: typeof body.subject === "string" ? body.subject : "",
    body: typeof body.body === "string" ? body.body : "",
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
  };
}

/** The send body, or null: the hash the card was drawn from, and an optional confirm. */
function readSendBody(body) {
  if (!keysWithin(body, SEND_KEYS)) return null;
  if (typeof body.hash !== "string" || body.hash === "") return null;
  if (body.confirmUnknown !== undefined && typeof body.confirmUnknown !== "boolean") return null;
  return { hash: body.hash, confirmUnknown: body.confirmUnknown === true };
}

/** The turn body, or null: a bot and the instruction the person typed. */
function readTurnBody(body) {
  if (!keysWithin(body, TURN_KEYS)) return null;
  if (typeof body.botId !== "string" || body.botId === "") return null;
  if (typeof body.instruction !== "string" || body.instruction.trim() === "") return null;
  return { botId: body.botId, instruction: body.instruction };
}

/** The schedule body, or null: the hash and the due time, which must be text (see `parseRouteDueAt`). */
function readScheduleBody(body) {
  if (!keysWithin(body, SCHEDULE_KEYS)) return null;
  if (typeof body.hash !== "string" || body.hash === "") return null;
  return { hash: body.hash, dueAt: body.dueAt };
}

/* --------------------------------------------------------------- the answers */

/**
 * A preflight refusal: 413 for size, 400 for everything else, each with the fixed sentence of the
 * code it answers and the preflight's own reason beside it.
 */
function answerPreflight(res, refusal) {
  const body = { preflight: typeof refusal?.code === "string" ? refusal.code : "bad_input" };
  if (Array.isArray(refusal?.detail)) body.detail = refusal.detail;
  if (body.preflight === "too_large") {
    return res.status(413).json({ error: "too_large", message: MAIL_ERROR_TEXT.TOO_LARGE, ...body });
  }
  return res.status(400).json({ error: "bad_input", message: MAIL_ERROR_TEXT.BAD_INPUT, ...body });
}

/**
 * A tap's refusal, as the route answers it. Answers true when it answered; false leaves the caller to
 * answer the internal sentence (a shape neither service is expected to produce).
 */
function answerTapFailure(res, sendError, out) {
  switch (out?.code) {
    case "changed":
      sendError(res, 409, "changed", CHANGED_SENTENCE);
      return true;
    case "not_found":
      sendError(res, 404, "not_found");
      return true;
    case "auth_failed":
      sendError(res, 400, "AUTH_FAILED");
      return true;
    case "claimed_elsewhere":
      sendError(res, 409, "CLAIMED_ELSEWHERE", out.sentence ?? null);
      return true;
    case "not_sendable":
      // The service's own reason and sentence: a unit with no mail connection, or no keychain key.
      res.status(409).json({
        error: out.reason === "keychain_key_missing" ? "keychain_key_missing" : "not_sendable",
        message: out.sentence ?? SEND_FAIL_REASONS[out.reason] ?? SEND_FAIL_REASONS.supervisor_missing,
        reason: out.reason ?? null,
      });
      return true;
    case "confirm_needed":
      res.status(409).json({
        error: "confirm_needed",
        message: UNKNOWN_STATE_SENTENCE,
        reason: out.reason ?? null,
      });
      return true;
    case "preflight":
      answerPreflight(res, out.preflight);
      return true;
    case "bad_input":
      res.status(400).json({ error: "bad_input", message: MAIL_ERROR_TEXT.BAD_INPUT });
      return true;
    case "past":
    case "too_far":
      // The sheet's own copy for these two windows belongs to the schedule sheet, not here.
      res.status(400).json({ error: "bad_input", message: MAIL_ERROR_TEXT.BAD_INPUT, reason: out.code });
      return true;
    case "frozen":
      // No fixed sentence exists for a draft in a state no tap may be taken from.
      res.status(409).json({ error: "frozen", state: out.state ?? null });
      return true;
    default:
      return false;
  }
}

/* -------------------------------------------------------------------- the routes */

/**
 * The draft routes, registered on the router `mail-api.js` already guards.
 *
 * @param {import("express").Router} router the mail API router (prefix `/dashboard/mail/api`)
 * @param {object} ctx the guards and per-request helpers mail-api.js builds: `{route, sendError,
 *   logCode, supervisor, openDb}` — `supervisor()` answers the running supervisor, or null.
 */
export function registerDraftRoutes(router, ctx) {
  const { route, sendError } = ctx;
  const base = `${MAIL_API_PREFIX}/drafts`;

  /** The running supervisor, or null when boot started no sync in this process. */
  const supervisorNow = () => {
    const supervisor = typeof ctx.supervisor === "function" ? ctx.supervisor() : null;
    return supervisor && typeof supervisor.withAdapter === "function" ? supervisor : null;
  };

  /** One draft id from the path: a real id, else null (the 404 the caller answers). */
  const draftIdOf = (req) => {
    const id = String(req.params.id ?? "");
    return MAIL_DRAFT_ID_RE.test(id) ? id : null;
  };

  /** The draft a request names, or null: a route that needs a row asks for it once. */
  const draftFor = async (db, req) => {
    const id = draftIdOf(req);
    if (id == null) return null;
    return getDraft(db, id);
  };

  /** One frozen draft: 409, and Cancel send when there is a schedule to give up first. */
  const answerFrozen = (res, draft) => {
    const body = { error: "frozen", state: draft?.state ?? null };
    if (draft?.state === "scheduled") body.needsCancel = true;
    return res.status(409).json(body);
  };

  /** The 500 every unexpected shape answers: the mail API's own internal sentence, nothing else. */
  const internal = (res) => {
    if (res.headersSent) return;
    sendError(res, 500, "internal");
  };

  /* ------------------------------------------------------------------ create */

  // POST / — one draft and its first revision, from the reply's own derivation when the mode names a
  // message. No bot is started here; the card starts a turn when the person asks for one.
  router.post(base, route("POST /drafts", async (db, req, res) => {
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readCreateBody(body);
    if (input == null) return sendError(res, 400, "bad_input");

    const account = await getAccount(db, input.accountId);
    if (!account) return sendError(res, 404, "not_found");

    let parent = null;
    if (input.mode !== "new") {
      if (input.replyToMid == null) return sendError(res, 400, "bad_input");
      parent = await resolveMessageRef(db, { accountId: account.id, mid: input.replyToMid });
      if (!parent) return sendError(res, 404, "not_found");
    }

    const first = firstRevisionFor(input.mode, parent, account);
    const draft = await createDraft(db, {
      accountId: account.id,
      mode: input.mode,
      // A blank draft answers no message, so a stray `replyToMid` on it is not stored.
      replyToMid: input.mode === "new" ? null : input.replyToMid,
      threadKey: await threadKeyFor(db, parent),
      projectId: input.projectId,
      botId: input.botId,
      audience: input.audience,
      first,
      author: "user",
    }, runtime.now == null ? {} : { now: runtime.now });
    res.json({ draft });
  }));

  /* ------------------------------------------------------------------- reads */

  // GET /:id — the card: the row, the head revision, the flags preflight marks, every comment and the
  // history line per revision. The flags are null when the draft does not pass preflight (nothing is
  // invented for it here): the card's own refusal copy is the panel's.
  router.get(`${base}/:id`, route("GET /drafts/:id", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const revisions = await listRevisions(db, draft.id);
    const head = revisions.find((entry) => entry.rev === draft.headRev) ?? null;

    let flags = null;
    if (head) {
      try {
        const readers = makeDraftReaders({ db, supervisor: supervisorNow() });
        const checked = await preflight(db, draft, head, {
          accountId: draft.accountId,
          deps: {
            readMessageRaw: runtime.readMessageRaw ?? readers.readMessageRaw,
            readStorageFile: runtime.readStorageFile ?? readers.readStorageFile,
          },
        });
        if (checked.ok) flags = checked.flags;
      } catch {
        // A card that cannot be checked still opens: the flags are the only thing missing.
        flags = null;
      }
    }

    res.json({
      draft,
      head,
      flags,
      comments: await listComments(db, draft.id),
      history: revisions.map((entry) => ({
        rev: entry.rev,
        author: entry.author,
        created_at: entry.createdAt,
        note: entry.note ?? null,
      })),
    });
  }));

  // GET /:id/revisions/:rev — one revision, for the "Draft history" view.
  router.get(`${base}/:id/revisions/:rev`, route("GET /drafts/:id/revisions/:rev", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const rev = Number(req.params.rev);
    if (!Number.isInteger(rev) || rev < 1) return sendError(res, 404, "not_found");
    const revisions = await listRevisions(db, draft.id);
    const revision = revisions.find((entry) => entry.rev === rev) ?? null;
    if (!revision) return sendError(res, 404, "not_found");
    res.json({ revision });
  }));

  /* ----------------------------------------------------------------- writes */

  // POST /:id/revisions — the person's own edit. The store's compare-and-set on `expectHash` is the
  // guard, and `cancelSchedule: true` is what returns a scheduled draft to `draft` (so the edit is
  // never silently lost to a frozen row) and clears the tap seal in the same transaction. The body
  // changes words, recipients and attachments only: the head revision's `bcc`, `inReplyTo` and
  // `references` are carried over (as `mail_draft_propose` carries them), so a hand-edited reply stays
  // threaded and keeps the audience the card showed.
  router.post(`${base}/:id/revisions`, route("POST /drafts/:id/revisions", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readRevisionBody(body);
    if (input == null) return sendError(res, 400, "bad_input");

    const revisions = await listRevisions(db, draft.id);
    const head = revisions.find((entry) => entry.rev === draft.headRev) ?? null;
    if (!head) return sendError(res, 404, "not_found");

    const outcome = await addRevision(db, draft.id, {
      to: input.to,
      cc: input.cc,
      // Carried from the head revision, exactly as `mail_draft_propose` does: a hand edit changes the
      // words, never the audience or the threading. The request body cannot name them (REVISION_KEYS).
      bcc: head.bcc,
      subject: input.subject,
      body: input.body,
      inReplyTo: head.inReplyTo,
      references: head.references,
      attachments: input.attachments,
    }, {
      author: "user",
      expectHash: input.expectHash,
      cancelSchedule: true,
      ...(runtime.now == null ? {} : { now: runtime.now }),
    });
    if (outcome.refused === "changed") return sendError(res, 409, "changed", CHANGED_SENTENCE);
    if (outcome.refused === "frozen") return res.status(409).json({ error: "frozen", state: draft.state });
    if (!Number.isInteger(outcome.rev)) return internal(res);
    res.json({ rev: outcome.rev, hash: outcome.hash });
  }));

  // POST /:id/turn — one drafting turn over this draft. The card's note box is this route too: the
  // instruction is the person's feedback, and the bot's answer is a revision they read before tapping
  // anything. A draft no bot may touch is refused before a turn is started, and a turn that refuses
  // while it starts answers by its own code: `frozen` 409 (with the cancel the card needs to offer
  // when the draft is scheduled), `cloud_drafting_off` and `local_models_only` 403 with the code alone.
  router.post(`${base}/:id/turn`, route("POST /drafts/:id/turn", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readTurnBody(body);
    if (input == null) return sendError(res, 400, "bad_input");
    if (!EDITABLE_STATES.includes(draft.state)) return answerFrozen(res, draft);

    const start = await draftingTurnFor();
    if (typeof start !== "function") return res.status(503).json({ error: "unavailable" });
    try {
      const started = await start(db, turnDeps(), {
        draftId: draft.id,
        botId: input.botId,
        instruction: input.instruction,
      });
      res.json({ turnId: started?.turnId ?? null });
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : "";
      if (code === "frozen") return answerFrozen(res, (await getDraft(db, draft.id)) ?? draft);
      if (code === "cloud_drafting_off" || code === "local_models_only") {
        // No sentence exists for either yet: the card owns that copy, so the code goes alone.
        return res.status(403).json({ error: code });
      }
      if (code === "NOT_FOUND") return sendError(res, 404, "not_found");
      if (code === "BAD_INPUT") return sendError(res, 400, "bad_input");
      return internal(res);
    }
  }));

  // POST /:id/send — the tap. The hash the card was drawn from is the one thing that may move the
  // row into `holding`; the ten-second hold, the seal and the delivery are the send service's.
  router.post(`${base}/:id/send`, route("POST /drafts/:id/send", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readSendBody(body);
    if (input == null) return sendError(res, 400, "bad_input");

    const out = await requestSend(db, serviceDeps(db, supervisorNow()), {
      draftId: draft.id,
      hash: input.hash,
      confirmUnknown: input.confirmUnknown,
    });
    if (out?.ok) return res.json({ ok: true, holdUntil: out.holdUntil });
    if (!answerTapFailure(res, sendError, out)) internal(res);
  }));

  // POST /:id/undo — the ten-second window, closed by the claim. A row already claimed answers the
  // send service's fixed sentence.
  router.post(`${base}/:id/undo`, route("POST /drafts/:id/undo", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const out = await undoSend(db, serviceDeps(db, supervisorNow()), { draftId: draft.id });
    if (out?.ok) return res.json({ ok: true });
    if (typeof out?.sentence === "string") {
      return res.status(409).json({ error: "too_late", message: out.sentence, state: out.state ?? null });
    }
    res.status(409).json({ error: "not_holding", state: out?.state ?? null });
  }));

  // POST /:id/schedule — the schedule tap. The due time arrives zone-qualified by text and nothing
  // else: `parseRouteDueAt` refuses a number and a bare local time with the caller's own 400.
  router.post(`${base}/:id/schedule`, route("POST /drafts/:id/schedule", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readScheduleBody(body);
    if (input == null) return sendError(res, 400, "bad_input");

    let dueAt;
    try {
      dueAt = parseRouteDueAt(input.dueAt, { zone: await instanceZone(db) });
    } catch {
      // The parser's own refusal (a number, a bare local time) is this route's bad input, not a mail
      // code: the body says which.
      return res.status(400).json({ error: "bad_input", message: MAIL_ERROR_TEXT.BAD_INPUT });
    }
    const out = await scheduleDraft(db, serviceDeps(db, supervisorNow()), {
      draftId: draft.id,
      hash: input.hash,
      dueAt,
    });
    if (out?.ok) return res.json({ ok: true, dueAt: out.dueAt });
    if (!answerTapFailure(res, sendError, out)) internal(res);
  }));

  // POST /:id/cancel-schedule — give the schedule up: `scheduled -> draft`, seal cleared.
  router.post(`${base}/:id/cancel-schedule`, route("POST /drafts/:id/cancel-schedule", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const out = await cancelSchedule(db, {
      draftId: draft.id,
      ...(runtime.now == null ? {} : { now: Math.floor(Number(runtime.now())) }),
    });
    if (out?.ok) return res.json({ ok: true });
    res.status(409).json({ error: "not_scheduled", state: out?.state ?? null });
  }));

  // POST /:id/discard — throw the draft away. `holding`, `scheduled` and `sending` are the send
  // service's states and are refused here.
  router.post(`${base}/:id/discard`, route("POST /drafts/:id/discard", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const out = await discardDraft(db, draft.id, runtime.now == null ? {} : { now: runtime.now });
    if (out?.ok) return res.json({ ok: true });
    res.status(409).json({ error: "not_discardable", state: out?.state ?? null });
  }));

  /** The drafting turn: the injected one, else the module that owns it (absent until its task lands). */
  async function draftingTurnFor() {
    if (typeof runtime.startDraftingTurn === "function") return runtime.startDraftingTurn;
    try {
      const module = await import("../mail/drafts/turn.js");
      return typeof module.startDraftingTurn === "function" ? module.startDraftingTurn : null;
    } catch {
      return null;
    }
  }
}

/* ---------------------------------------------------------------- derivation */
/**
 * The first revision of a new draft. A reply or a reply-all starts from `deriveReply`, a forward from
 * `deriveForward` (its quoted body and every thread attachment), and a blank one from nothing at all:
 * the person fills it or hands it to a bot.
 */
function firstRevisionFor(mode, parent, account) {
  if (mode === "forward") {
    const derived = deriveForward(parent);
    return {
      to: [],
      cc: [],
      bcc: [],
      subject: derived.subject,
      body: derived.quotedBody,
      attachments: derived.attachments,
    };
  }
  if (mode === "reply" || mode === "reply_all") {
    const derived = deriveReply(parent, account, { all: mode === "reply_all" });
    return {
      to: derived.to,
      cc: derived.cc,
      bcc: [],
      subject: derived.subject,
      body: "",
      inReplyTo: derived.inReplyTo,
      references: derived.references,
      attachments: [],
    };
  }
  return { to: [], cc: [], bcc: [], subject: "", body: "", attachments: [] };
}

/**
 * The thread key a drafting turn reads this draft's thread through: the stored thread's own key when
 * the message it answers is in one (the store's `mid:` key is the fallback for a message no thread
 * has claimed yet). No parent, no key: a blank draft has no thread.
 */
async function threadKeyFor(db, parent) {
  if (!parent) return null;
  const threadId = Number(parent.threadId);
  if (Number.isInteger(threadId) && threadId > 0) {
    try {
      const { rows } = await db.execute({
        sql: "SELECT thread_key FROM mail_threads WHERE id = ?",
        args: [threadId],
      });
      const key = rows[0]?.thread_key;
      if (typeof key === "string" && key !== "") return key;
    } catch {
      // A thread table that cannot be read leaves the fallback below, never a failed draft.
    }
  }
  return typeof parent.messageId === "string" && parent.messageId !== "" ? `mid:${parent.messageId}` : null;
}

export default registerDraftRoutes;