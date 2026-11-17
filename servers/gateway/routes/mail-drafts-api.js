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
 *
 * `POST /:id/save-draft` (Task 12) files the head revision in the provider's own Drafts folder through
 * plan 1's `saveDraft(raw)`: preflight, `composeRaw` with the Bcc kept, one borrowed adapter, one
 * append. It is not a send and not an edit — the row keeps its state and writes no revision — and the
 * answer names the folder the copy landed in, never its content. A draft a tap or a schedule has
 * frozen cannot be filed; a mailbox with no Drafts folder answers the mail `NOT_FOUND` sentence.
 *
 * `GET /:id/attachable` (Task 12) is the card's attachment picker: the thread's own parts, read from
 * the store's attachment metadata and never from the network, and the owner's newest Crow files, by
 * id — the default bucket's rows, minus any recorded as over the send cap, so the list is what the
 * storage reader would actually read. It also carries the head revision's raw attachment total
 * against the send ceiling, so the card can show how much of it a draft already uses.
 *
 * `PATCH /:id/audience` is the card's one-tap audience chip: one word from the store's `DRAFT_AUDIENCES`
 * list, written to the draft's `audience` column (or null, to clear it). It is neither a tap nor a
 * revision — no state moves, no hash is compared — and a frozen draft answers its state.
 *
 * The revision loop is `drafts/revise.js`'s (Task 9): `POST /:id/comments` queues one comment on one
 * line (a comment on a revision the draft has left is 409 `changed`) and revises at once when it is
 * the only one waiting; `POST /:id/revise` carries every queued comment in one turn; and
 * `POST /:id/turn` with `reviseFrom` is the card's note box — the wording the person typed, handed to
 * the bot as theirs. A revise or a turn on a frozen draft is 409 `frozen`, with `needsCancel` when
 * there is a schedule to give up first.
 *
 * `GET /bot-options` (Task 11) is the reader's reply-slot picker: every enabled bot whose model may
 * draft for this account (`allowDraftModel`, the same verdict a turn is held to), the projects those
 * bots belong to, and the one bot the thread's filing suggests. A bot that may not draft is never
 * listed, so the picker cannot offer a bot the turn would then refuse; when every bot is refused the
 * answer carries the refusal code instead and the slot shows the sentence the panel drew for it.
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
 * `{error:"unavailable"}`. A turn the runtime could not start because this host delivers bot MCP
 * configs as files instead of over the fd answers 503 `{error:"delivery_unsupported"}` — the code
 * alone, because the card owns that copy.
 */
import { MAIL_ERROR_TEXT, MailError } from "../mail/errors.js";
import { getAccount } from "../mail/store/accounts.js";
import { folderRole, getFolder } from "../mail/store/messages.js";
import { defaultBucket } from "../../storage/s3-client.js";
import { listThreadMessages, resolveMessageRef } from "../mail/store/reader-queries.js";
import { composeRaw } from "../mail/adapter/compose.js";
import { safeAttachmentName } from "../mail/reader/attachments.js";
import {
  DRAFT_AUDIENCES,
  DRAFT_MODES,
  addRevision,
  createDraft,
  discardDraft,
  getDraft,
  getVoice,
  listComments,
  listRevisions,
  setAudience,
} from "../mail/drafts/store.js";
import { MAX_SEND_BYTES, preflight } from "../mail/drafts/preflight.js";
import { deriveForward, deriveReply } from "../mail/drafts/recipients.js";
import { queueComment, reviseNow } from "../mail/drafts/revise.js";
import { makeDraftReaders } from "../mail/drafts/readers.js";
import {
  CHANGED_SENTENCE,
  SEND_FAIL_REASONS,
  UNKNOWN_STATE_SENTENCE,
  requestSend,
  undoSend,
} from "../mail/send/send-service.js";
import {
  SCHEDULE_MAX_AHEAD_MS,
  SCHEDULE_MIN_LEAD_MS,
  cancelSchedule,
  localTimeToInstant,
  parseRouteDueAt,
  scheduleDraft,
  schedulePresets,
  wallClockAt,
  zoneOffsetMinutesAt,
} from "../mail/send/schedule-service.js";
import { instanceZone } from "../../shared/schedule-store.js";
// The mount point mail-api.js sets on this same router. It is read when routes are registered (that
// module has finished evaluating by then), never at module load: the two files import each other.
import { MAIL_API_PREFIX } from "./mail-api.js";
import { CROW_VOICE_BOT_ID } from "../../shared/voice-bot.js";

/** A draft id, exactly what the store mints. Anything else is a 404 here. */
export const MAIL_DRAFT_ID_RE = /^md-[0-9a-f]{16}$/;

/** The states a bot may draft on: the store's own editable set (`addRevision`'s rule). */
const EDITABLE_STATES = Object.freeze(["draft", "failed", "missed"]);

/** The keys each body may carry, and nothing else: no `from`, no `headers`, no `envelope`. */
const CREATE_KEYS = Object.freeze(["accountId", "mode", "replyToMid", "projectId", "botId", "audience"]);
const REVISION_KEYS = Object.freeze([
  "expectHash", "to", "cc", "bcc", "subject", "body", "attachments", "cancelSchedule",
]);
const SEND_KEYS = Object.freeze(["hash", "confirmUnknown"]);
const SCHEDULE_KEYS = Object.freeze(["hash", "dueAt"]);
const TURN_KEYS = Object.freeze(["botId", "instruction", "reviseFrom"]);
const COMMENT_KEYS = Object.freeze(["rev", "lineIndex", "quote", "text"]);
const REVISE_KEYS = Object.freeze(["expectHash", "chatNote"]);
const SAVE_DRAFT_KEYS = Object.freeze(["expectHash"]);
const AUDIENCE_KEYS = Object.freeze(["audience"]);

/** How many of the owner's Crow files the attachment picker lists: the newest, and no more. */
const ATTACHABLE_STORAGE_LIMIT = 50;

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

/**
 * The deps one revise gets: the turn's own seam, plus the drafting turn the seam injects (a test, or
 * a caller that spawns turns its own way). A revise turns into one drafting turn and nothing else, so
 * it gets no adapter, no sync and no key either.
 *
 * @returns {{now?: Function, startDraftingTurn?: Function}}
 */
function reviseDeps() {
  const deps = {};
  if (typeof runtime.now === "function") deps.now = runtime.now;
  if (typeof runtime.startDraftingTurn === "function") deps.startDraftingTurn = runtime.startDraftingTurn;
  return deps;
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

/**
 * The hand-edit body, or null. `cancelSchedule` is accepted and ignored: this route always cancels.
 * `bcc` is an address list like `to` and `cc`, and absent is not the same as empty: absent leaves the
 * head revision's Bcc alone (a client that does not carry the field never drops it silently), an
 * empty list clears it. `null` for `bcc` says the field was not sent at all.
 */
function readRevisionBody(body) {
  if (!keysWithin(body, REVISION_KEYS)) return null;
  if (typeof body.expectHash !== "string" || body.expectHash === "") return null;
  if (!isArrayOrAbsent(body.to) || !isArrayOrAbsent(body.cc) || !isArrayOrAbsent(body.bcc)) return null;
  if (!isArrayOrAbsent(body.attachments)) return null;
  if (!isStringOrAbsent(body.subject) || !isStringOrAbsent(body.body)) return null;
  return {
    expectHash: body.expectHash,
    to: Array.isArray(body.to) ? body.to : [],
    cc: Array.isArray(body.cc) ? body.cc : [],
    bcc: Array.isArray(body.bcc) ? body.bcc : null,
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

/** The turn body, or null: a bot and the instruction the person typed, and their own wording if any. */
function readTurnBody(body) {
  if (!keysWithin(body, TURN_KEYS)) return null;
  if (typeof body.botId !== "string" || body.botId === "") return null;
  if (typeof body.instruction !== "string" || body.instruction.trim() === "") return null;
  if (!isStringOrAbsent(body.reviseFrom)) return null;
  return {
    botId: body.botId,
    instruction: body.instruction,
    reviseFrom: typeof body.reviseFrom === "string" && body.reviseFrom.trim() !== "" ? body.reviseFrom : null,
  };
}

/** The comment body, or null: the revision and line it points at, the words quoted, and the ask. */
function readCommentBody(body) {
  if (!keysWithin(body, COMMENT_KEYS)) return null;
  if (!Number.isInteger(body.rev) || body.rev < 1) return null;
  if (typeof body.text !== "string" || body.text.trim() === "") return null;
  if (body.lineIndex !== undefined && body.lineIndex !== null && !Number.isInteger(body.lineIndex)) return null;
  if (body.lineIndex != null && body.lineIndex < 0) return null;
  if (!isStringOrAbsent(body.quote)) return null;
  return {
    rev: body.rev,
    lineIndex: body.lineIndex ?? null,
    quote: typeof body.quote === "string" && body.quote !== "" ? body.quote : null,
    text: body.text,
  };
}

/** The revise body, or null: the hash the card was drawn from, and the note the person typed. */
function readReviseBody(body) {
  if (!keysWithin(body, REVISE_KEYS)) return null;
  if (typeof body.expectHash !== "string" || body.expectHash === "") return null;
  if (!isStringOrAbsent(body.chatNote)) return null;
  return {
    expectHash: body.expectHash,
    chatNote: typeof body.chatNote === "string" && body.chatNote.trim() !== "" ? body.chatNote : null,
  };
}

/** The schedule body, or null: the hash and the due time, which must be text (see `parseRouteDueAt`). */
function readScheduleBody(body) {
  if (!keysWithin(body, SCHEDULE_KEYS)) return null;
  if (typeof body.hash !== "string" || body.hash === "") return null;
  return { hash: body.hash, dueAt: body.dueAt };
}

/** The save-draft body, or null: only the hash the card was drawn from. */
function readSaveDraftBody(body) {
  if (!keysWithin(body, SAVE_DRAFT_KEYS)) return null;
  if (typeof body.expectHash !== "string" || body.expectHash === "") return null;
  return { expectHash: body.expectHash };
}

/** The audience body, or null: one word from the store's own list, or null to clear it. */
function readAudienceBody(body) {
  if (!keysWithin(body, AUDIENCE_KEYS)) return null;
  if (!Object.hasOwn(body, "audience")) return null;
  if (body.audience === null) return { audience: null };
  if (typeof body.audience !== "string" || !DRAFT_AUDIENCES.includes(body.audience)) return null;
  return { audience: body.audience };
}

/* ------------------------------------------------------------- the presets */

/** The zone's own wall clock at one instant, as the zone-qualified ISO text the sheet posts back. */
function zonedIso(instant, zone) {
  const wall = wallClockAt(instant, zone);
  const offset = zoneOffsetMinutesAt(instant, zone);
  const two = (value) => String(value).padStart(2, "0");
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${wall.year}-${two(wall.month)}-${two(wall.day)}T${two(wall.hour)}:${two(wall.minute)}:${two(wall.second)}`
    + `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/**
 * A wall time the sheet's date and time inputs name (`2026-11-12T07:30`), as the instant the instance
 * zone shows it, or null. The zone's own helpers do the arithmetic (`localTimeToInstant`), and the
 * instant is only accepted when the zone really shows that wall clock: an hour a spring-forward skips
 * and a date the calendar does not have are both refused rather than moved.
 *
 * @param {string} text `yyyy-mm-ddThh:mm`, the bare wall time and nothing else
 * @param {string} zone the instance zone
 * @returns {number|null} epoch ms
 */
function wallTimeAt(text, zone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  let instant;
  try {
    instant = localTimeToInstant(parts, zone);
  } catch {
    return null;
  }
  const shown = wallClockAt(instant, zone);
  if (shown.year !== parts.year || shown.month !== parts.month || shown.day !== parts.day
    || shown.hour !== parts.hour || shown.minute !== parts.minute) {
    return null;
  }
  return instant;
}

/**
 * One preset as the sheet reads it: the zone-qualified instant it stands for, and the short label of
 * its clock time, formatted here in the instance zone. The label is the time alone — the sheet already
 * names the day in its own words (Tomorrow morning, Next work day) — so it carries no weekday a second
 * language would have to agree with.
 */
function presetAnswer(date, zone) {
  const instant = date instanceof Date ? date.getTime() : Number(date);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instant));
  return { iso: zonedIso(instant, zone), label };
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

  // PATCH /:id/audience — the card's one-tap audience chip: one word from `DRAFT_AUDIENCES`, written
  // to the draft's `audience` column (what a drafting turn reads as the draft's audience) or null to
  // clear it. It is not a tap and not a revision: no state moves and the hash is not needed, because
  // nothing a person reads before pressing Send changes. A draft a tap or a schedule has frozen
  // answers 409 with its state, like the other write routes.
  router.patch(`${base}/:id/audience`, route("PATCH /drafts/:id/audience", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readAudienceBody(body);
    if (input == null) return sendError(res, 400, "bad_input");
    const out = await setAudience(db, draft.id, input.audience, runtime.now == null ? {} : { now: runtime.now });
    if (out?.ok) return res.json({ ok: true, audience: out.audience });
    res.status(409).json({ error: "frozen", state: out?.state ?? null });
  }));

  /* ------------------------------------------------------------------- reads */

  // GET /schedule-presets — the schedule sheet's two shortcuts, the instant each one stands for and
  // the window a schedule may fall in. Registered BEFORE GET /:id: a route below would read this path
  // as a draft id. The sheet never computes a time, so `iso` is produced here, in the instance zone,
  // and `label` is its short clock time formatted here too.
  //
  // With `?at=<local yyyy-mm-ddThh:mm>` the same route answers `{iso}` for that wall time in the
  // instance zone — the picked date and time of the sheet's third option — or 400 `bad_input`. A wall
  // time the zone does not show (the hour a spring-forward skips, a date no calendar has) is a refusal,
  // never a quietly moved instant: the offset the tap will be stored with must be the one the person
  // saw. The client therefore posts text the server built and never carries an offset of its own.
  router.get(`${base}/schedule-presets`, route("GET /drafts/schedule-presets", async (db, req, res) => {
    const zone = await instanceZone(db);
    const raw = req.query?.at;
    const at = typeof raw === "string" ? raw.trim() : raw == null ? "" : null;
    // A repeated `at` is not one wall time: refused rather than answered with the shortcuts.
    if (at === null) return sendError(res, 400, "bad_input");
    if (at !== "") {
      const instant = wallTimeAt(at, zone);
      if (instant == null) return sendError(res, 400, "bad_input");
      return res.json({ iso: zonedIso(instant, zone) });
    }
    const now = Math.floor(Number(typeof runtime.now === "function" ? runtime.now() : Date.now()));
    const presets = await schedulePresets(db, { now, zone });
    res.json({
      zone,
      tomorrowMorning: presetAnswer(presets.tomorrowMorning, zone),
      nextWorkDay: presetAnswer(presets.nextWorkDay, zone),
      minLeadMs: SCHEDULE_MIN_LEAD_MS,
      maxAheadMs: SCHEDULE_MAX_AHEAD_MS,
    });
  }));

  // GET /bot-options — the reply slot's picker (Task 11): the bots whose model may draft for this
  // account, the projects those bots belong to, and the one bot a thread's filing suggests. Registered
  // BEFORE GET /:id, which would read this path as a draft id. Every bot is filtered here, by the same
  // rule a turn is held to (`allowDraftModel`): a bot that may not draft is never listed, so the picker
  // can never offer a bot the turn would then refuse. When every bot is refused the answer carries the
  // refusal code instead, and the slot shows the sentence the panel drew for it.
  router.get(`${base}/bot-options`, route("GET /drafts/bot-options", async (db, req, res) => {
    const raw = req.query?.accountId;
    const accountId = typeof raw === "string" ? raw : "";
    if (accountId === "") return sendError(res, 400, "bad_input");
    const account = await getAccount(db, accountId);
    if (!account) return sendError(res, 404, "not_found");
    const rawMid = req.query?.mid;
    const mid = typeof rawMid === "string" && rawMid !== "" ? rawMid : null;
    res.json(await botOptionsFor(db, { account, mid }));
  }));


  // GET /:id — the card: the row, the head revision, the flags preflight marks, every comment, the
  // history line per revision and the head revision's voice note (null while plan 4 has not checked
  // it, which is what the card's "Not checked for voice" line reads). The flags are null when the
  // draft does not pass preflight (nothing is invented for it here): the card's own refusal copy is
  // the panel's.
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
      // A sent draft's receipt: when, which Message-ID, from which account, and the reader link once
      // the Sent copy is in the store (until then the card says "Sent, syncing...").
      receipt: await receiptFor(db, draft),
      // The head revision's voice note, or null: the card says "Not checked for voice" while plan 4
      // has written none. Part of the card's one read, so the card never guesses.
      voice: await getVoice(db, draft.id, draft.headRev),
    });
  }));

  // GET /:id/attachable — the card's attachment picker: the draft's own thread parts, from the stored
  // attachment metadata and never from a mailbox, and the owner's newest Crow files. The head
  // revision's raw attachment total rides along, against the send ceiling the card shows.
  router.get(`${base}/:id/attachable`, route("GET /drafts/:id/attachable", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const revisions = await listRevisions(db, draft.id);
    const head = revisions.find((entry) => entry.rev === draft.headRev) ?? null;
    res.json({
      thread: await threadAttachables(db, draft),
      storage: await storageAttachables(db, draft),
      totalBytes: attachmentBytes(head),
      maxBytes: MAX_SEND_BYTES,
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
  // changes words, every recipient list (To, Cc and Bcc alike) and attachments only: the head
  // revision's `inReplyTo` and `references` are carried over (as `mail_draft_propose` carries them),
  // so a hand-edited reply stays threaded. A body with no `bcc` keeps the head revision's Bcc; an
  // empty list clears it.
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
      // Absent keeps the Bcc the card showed; an empty list is the person clearing it.
      bcc: input.bcc === null ? head.bcc : input.bcc,
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

  /**
   * A drafting turn that refused while it started, answered by its own code: `frozen` (409, with the
   * cancel a scheduled draft needs), the two cloud gates and this host's delivery mode with the code
   * alone (the card owns that copy), and the store's own two codes.
   */
  const answerTurnError = async (db, res, draft, err) => {
    const code = err && typeof err.code === "string" ? err.code : "";
    if (code === "frozen") return answerFrozen(res, (await getDraft(db, draft.id)) ?? draft);
    if (code === "cloud_drafting_off" || code === "local_models_only") {
      // No sentence exists for either yet: the card owns that copy, so the code goes alone.
      return res.status(403).json({ error: code });
    }
    if (code === "delivery_unsupported" || code === "unavailable") {
      // A drafting turn is fd-only (the bridge refuses the file mode before it spawns anything,
      // because that mode would write the turn's token to disk), and a host with no drafting turn to
      // start answers `unavailable`. No copy here either: the code alone.
      return res.status(503).json({ error: code });
    }
    if (code === "NOT_FOUND") return sendError(res, 404, "not_found");
    if (code === "BAD_INPUT") return sendError(res, 400, "bad_input");
    if (code === "CHANGED") return sendError(res, 409, "changed", CHANGED_SENTENCE);
    return internal(res);
  };

  // POST /:id/turn — one drafting turn over this draft. The card's note box is this route too: the
  // instruction is the person's feedback, `reviseFrom` is the wording they wrote themselves, and the
  // bot's answer is a revision they read before tapping anything. A draft no bot may touch is refused
  // before a turn is started, and a turn that refuses while it starts answers by its own code.
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
        reviseFrom: input.reviseFrom,
      });
      res.json({ turnId: started?.turnId ?? null });
    } catch (err) {
      await answerTurnError(db, res, draft, err);
    }
  }));

  // POST /:id/comments — one comment on one line of the draft. A comment on a revision the draft has
  // left is 409 `changed` (the card the person was reading has moved). When this is the only comment
  // waiting it revises at once (D-c): a second comment queues until Revise. A revise that refuses here
  // never costs the comment — it is queued, and its code rides back so the card can say why nothing
  // started.
  router.post(`${base}/:id/comments`, route("POST /drafts/:id/comments", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readCommentBody(body);
    if (input == null) return sendError(res, 400, "bad_input");

    let comment;
    try {
      comment = await queueComment(db, draft.id, input, runtime.now == null ? {} : { now: runtime.now });
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : "";
      if (code === "CHANGED") return sendError(res, 409, "changed", CHANGED_SENTENCE);
      if (code === "NOT_FOUND") return sendError(res, 404, "not_found");
      if (code === "BAD_INPUT") return sendError(res, 400, "bad_input");
      return internal(res);
    }

    let turnId = null;
    let refused = null;
    const waiting = await listComments(db, draft.id, { state: "queued" });
    if (waiting.length === 1 && EDITABLE_STATES.includes(draft.state)) {
      try {
        const out = await reviseNow(db, reviseDeps(), { draftId: draft.id, expectHash: draft.headHash });
        turnId = out?.turnId ?? null;
        refused = out?.refused ?? null;
      } catch (err) {
        // The comment is queued either way; a revise that cannot start says so by its code alone.
        refused = typeof err?.code === "string" ? err.code : "error";
      }
    }
    const answer = { comment, turnId };
    if (refused) answer.error = refused;
    res.json(answer);
  }));

  // POST /:id/revise — Revise: every queued comment in one turn, with the note the person typed in
  // the card's note box when there is one. The hash the card was drawn from is required, as it is for
  // send and schedule: a revise never falls back to the draft's own head. A frozen draft is refused
  // with the code alone, and a scheduled one with the cancel it needs first.
  router.post(`${base}/:id/revise`, route("POST /drafts/:id/revise", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readReviseBody(body);
    if (input == null) return sendError(res, 400, "bad_input");
    if (!EDITABLE_STATES.includes(draft.state)) return answerFrozen(res, draft);

    try {
      const out = await reviseNow(db, reviseDeps(), {
        draftId: draft.id,
        expectHash: input.expectHash,
        chatNote: input.chatNote,
      });
      if (out?.refused === "changed") return sendError(res, 409, "changed", CHANGED_SENTENCE);
      if (out?.refused === "frozen") return answerFrozen(res, (await getDraft(db, draft.id)) ?? draft);
      res.json({ turnId: out?.turnId ?? null });
    } catch (err) {
      await answerTurnError(db, res, draft, err);
    }
  }));

  // POST /:id/save-draft — Save as draft (Task 12): file the head revision in the provider's own
  // Drafts folder. Preflight, then `composeRaw` with the Bcc kept, then ONE borrowed adapter and ONE
  // `saveDraft(raw)`. Nothing is sent, no revision is written and the row keeps the state it had, so
  // this is not a tap: it carries the hash only to prove the card and the row agree. The answer names
  // the folder the copy landed in and never its content; a mailbox with no Drafts folder answers the
  // mail NOT_FOUND sentence, and a Crow with no mail connection answers the send service's own
  // `not_sendable` refusal.
  router.post(`${base}/:id/save-draft`, route("POST /drafts/:id/save-draft", async (db, req, res) => {
    const draft = await draftFor(db, req);
    if (!draft) return sendError(res, 404, "not_found");
    const body = bodyOf(req);
    if (body == null) return sendError(res, 400, "bad_input");
    const input = readSaveDraftBody(body);
    if (input == null) return sendError(res, 400, "bad_input");
    if (!EDITABLE_STATES.includes(draft.state)) return answerFrozen(res, draft);
    // The row's own head hash is the guard a save needs: nothing moves either way, so a stale card is
    // told to look again rather than filing a revision the person never saw.
    if (input.expectHash !== draft.headHash) return sendError(res, 409, "changed", CHANGED_SENTENCE);

    const revisions = await listRevisions(db, draft.id);
    const head = revisions.find((entry) => entry.rev === draft.headRev) ?? null;
    if (!head) return sendError(res, 404, "not_found");

    const supervisor = supervisorNow();
    if (!supervisor) {
      return answerTapFailure(res, sendError, { code: "not_sendable", reason: "supervisor_missing" });
    }

    const deps = serviceDeps(db, supervisor);
    const checked = await preflight(db, draft, head, {
      accountId: draft.accountId,
      deps: { readMessageRaw: deps.readMessageRaw, readStorageFile: deps.readStorageFile },
    });
    if (!checked.ok) return answerPreflight(res, checked);

    let raw;
    try {
      // The Drafts copy is a copy: it keeps the Bcc the person put on the draft (Task 2's rule).
      raw = await composeRaw(checked.message, { keepBcc: true });
    } catch (err) {
      if (err instanceof MailError && err.code === "BAD_INPUT") return answerPreflight(res, { code: "bad_input" });
      throw err;
    }

    let saved;
    try {
      saved = await supervisor.withAdapter(draft.accountId, (adapter) => adapter.saveDraft(raw));
    } catch (err) {
      // Only a mailbox with no Drafts folder says the mail NOT_FOUND sentence. Any other NOT_FOUND —
      // the account going away under the tap, say — is a missing row and nothing more.
      if (err instanceof MailError && err.code === "NOT_FOUND") {
        if (err.detail === "drafts") return sendError(res, 404, "not_found", MAIL_ERROR_TEXT.NOT_FOUND);
        return sendError(res, 404, "not_found");
      }
      throw err;
    }

    res.json({ ok: true, folder: typeof saved?.folderPath === "string" ? saved.folderPath : null });
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

/* -------------------------------------------------------------- the bot picker */

/**
 * The two rules a drafting turn is held to, loaded once per picker read: `readDraftingSettings` (the
 * owner's cloud-drafting switch and the provider rows) and `allowDraftModel` (the one verdict on a
 * bot's model). They live in the module that owns a turn, so the picker can never drift from the
 * refusal a turn would give; a build without that module lists nothing at all.
 *
 * `allowDraftModel` reads the bot def's default model, which is the same key the turn checks first.
 * A bot whose turn would pick another model (an escalation) is still checked again by the bridge, so
 * a listed bot is one the turn may legitimately start.
 */
async function draftingRulesFor(db) {
  try {
    const turn = await import("../mail/drafts/turn.js");
    if (typeof turn.readDraftingSettings !== "function" || typeof turn.allowDraftModel !== "function") return null;
    return { settings: await turn.readDraftingSettings(db), allow: turn.allowDraftModel };
  } catch {
    return null;
  }
}

/** A stored bot definition as the object it holds, or an empty one: a corrupt def proves nothing. */
function parseBotDef(value) {
  if (value == null) return {};
  let def = value;
  if (typeof value === "string") {
    try {
      def = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return def != null && typeof def === "object" && !Array.isArray(def) ? def : {};
}

/**
 * The project a mail thread was filed under, or null. The store is the only source: today's schema
 * records no filing for a thread (mail_threads carries no project), so this answers null and the
 * picker suggests nothing — a reason is never invented for a bot the store does not point at.
 *
 * @param {object} db
 * @param {{accountId: string, mid?: string|null}} args
 * @returns {Promise<number|null>}
 */
async function suggestedProjectFor(db, { accountId, mid = null } = {}) {
  if (mid == null || mid === "") return null;
  let threadId = null;
  try {
    const message = await resolveMessageRef(db, { accountId, mid });
    const id = Number(message?.threadId);
    if (Number.isInteger(id) && id > 0) threadId = id;
  } catch {
    return null;
  }
  if (threadId == null) return null;
  try {
    const { rows } = await db.execute({ sql: "SELECT project_id FROM mail_threads WHERE id = ?", args: [threadId] });
    const value = Number(rows[0]?.project_id);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    // A thread table with no filing column is a store that records none.
    return null;
  }
}

/** A project's name, or null: the only text a suggestion's reason is ever built from. */
async function projectNameFor(db, projectId) {
  try {
    const { rows } = await db.execute({ sql: "SELECT name FROM project_spaces WHERE id = ?", args: [projectId] });
    const name = typeof rows[0]?.name === "string" ? rows[0].name.trim() : "";
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

/**
 * The picker's answer: every enabled bot whose model may draft for this account, the projects those
 * bots belong to, and the one bot a thread's filing suggests.
 *
 * `bots` is ordered with the suggested bot first, and `projects` with the suggested bot's project
 * first, so the picker draws the suggestion at the top with its reason (the project's own name). A bot
 * is grouped under its home project; a bot in no project (or one whose project row is gone) is drawn
 * under the picker's always-present "No project" group. `refused` is present only when the owner may
 * use no bot at all, and carries the code of the first refusal — the cloud gate's code wins, because
 * switching it on is what would offer those bots.
 *
 * @param {object} db
 * @param {{account: object, mid?: string|null}} args
 * @returns {Promise<{bots: object[], projects: object[], refused?: string}>}
 */
async function botOptionsFor(db, { account, mid = null } = {}) {
  const rules = await draftingRulesFor(db);
  if (!rules || !account) return { bots: [], projects: [] };

  let rows = [];
  try {
    const read = await db.execute({
      sql: `SELECT bot_id, display_name, definition, project_id FROM pi_bot_defs
             WHERE enabled = 1 AND bot_id != ?`,
      args: [CROW_VOICE_BOT_ID],
    });
    rows = read.rows ?? [];
  } catch {
    return { bots: [], projects: [] };
  }

  const projectIdOf = (row) => {
    const value = Number(row?.project_id);
    return Number.isInteger(value) && value > 0 ? value : null;
  };

  const usable = [];
  const refusalCodes = [];
  for (const row of rows) {
    const id = typeof row?.bot_id === "string" ? row.bot_id : "";
    if (id === "") continue;
    const verdict = rules.allow(parseBotDef(row.definition), account, rules.settings);
    if (!verdict?.ok) {
      if (typeof verdict?.code === "string") refusalCodes.push(verdict.code);
      continue;
    }
    const name = typeof row.display_name === "string" ? row.display_name.trim() : "";
    usable.push({ id, name: name === "" ? id : name, projectId: projectIdOf(row) });
  }

  const suggestedProject = await suggestedProjectFor(db, { accountId: account.id, mid });
  const suggestedName = suggestedProject == null ? null : await projectNameFor(db, suggestedProject);

  usable.sort((a, b) => {
    const leftSuggested = a.projectId !== null && a.projectId === suggestedProject ? 0 : 1;
    const rightSuggested = b.projectId !== null && b.projectId === suggestedProject ? 0 : 1;
    if (leftSuggested !== rightSuggested) return leftSuggested - rightSuggested;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const bots = usable.map((bot) => {
    const suggested = suggestedProject != null && bot.projectId === suggestedProject;
    return {
      id: bot.id,
      name: bot.name,
      suggested,
      // The reason is the project's name and nothing else; a filing whose project row is gone names
      // nothing, so that bot is suggested with no reason rather than with an invented one.
      reason: suggested ? suggestedName : null,
    };
  });

  // The projects the listed bots belong to, the suggested one first; a name the store does not have
  // leaves its bots under "No project" instead of a group with a blank heading.
  const groups = new Map();
  for (const bot of usable) {
    if (bot.projectId === null) continue;
    if (!groups.has(bot.projectId)) groups.set(bot.projectId, []);
    groups.get(bot.projectId).push(bot.id);
  }
  const projects = [];
  const orderedIds = [...groups.keys()].sort((a, b) => {
    if (a === suggestedProject) return -1;
    if (b === suggestedProject) return 1;
    return a - b;
  });
  for (const id of orderedIds) {
    const name = id === suggestedProject && suggestedName != null ? suggestedName : await projectNameFor(db, id);
    if (name == null) continue;
    projects.push({ id, name, bots: groups.get(id) });
  }

  const answer = { bots, projects };
  if (bots.length === 0 && refusalCodes.length > 0) {
    answer.refused = refusalCodes.includes("cloud_drafting_off") ? "cloud_drafting_off" : refusalCodes[0];
  }
  return answer;
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

/* -------------------------------------------------------- attachments and receipt */

/**
 * The thread id this draft's attachment picker reads: the stored thread the draft's key names, else
 * the thread the message it answers is in. A draft with neither (a blank one) has no thread to read.
 */
async function threadIdFor(db, draft) {
  const key = typeof draft?.threadKey === "string" ? draft.threadKey : "";
  if (key !== "") {
    try {
      const { rows } = await db.execute({
        sql: "SELECT id FROM mail_threads WHERE account_id = ? AND thread_key = ?",
        args: [draft.accountId, key],
      });
      const id = Number(rows[0]?.id);
      if (Number.isInteger(id) && id > 0) return id;
    } catch {
      // A thread table that cannot be read leaves the reply's own row below, never a failed read.
    }
  }
  if (typeof draft?.replyToMid === "string" && draft.replyToMid !== "") {
    const row = await resolveMessageRef(db, { accountId: draft.accountId, mid: draft.replyToMid });
    const id = Number(row?.threadId);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

/** A stored `attachments_json` value as the list it holds, or an empty list. */
function parseParts(value) {
  if (value == null) return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Every part of every message in the draft's thread, as the picker's own reference: the message's
 * Message-ID, the part's index and the metadata the store kept. Read from `mail_messages` only — no
 * mailbox is asked anything, so the list costs no network and works while the server is away.
 *
 * @returns {Promise<Array<{mid: string, index: number, filename: string, size: number|null,
 *   contentType: string}>>}
 */
async function threadAttachables(db, draft) {
  const threadId = await threadIdFor(db, draft);
  if (threadId == null) return [];
  const messages = await listThreadMessages(db, draft.accountId, threadId);
  const out = [];
  for (const message of messages) {
    const mid = typeof message.messageId === "string" ? message.messageId : "";
    if (mid === "") continue;
    let parts = [];
    try {
      const { rows } = await db.execute({
        sql: "SELECT attachments_json FROM mail_messages WHERE id = ?",
        args: [message.id],
      });
      parts = parseParts(rows[0]?.attachments_json);
    } catch {
      parts = [];
    }
    parts.forEach((part, index) => {
      out.push({
        mid,
        index,
        filename: safeAttachmentName(part?.filename),
        size: Number.isInteger(part?.size) ? part.size : null,
        contentType: typeof part?.contentType === "string" ? part.contentType : "",
      });
    });
  }
  return out;
}

/**
 * The owner's own Crow files the picker may offer: the newest `ATTACHABLE_STORAGE_LIMIT` rows that
 * are unscoped or scoped to this draft's project. A file of another project is never listed, exactly
 * as the storage reader never reads one, and `fileId` is the digits-only id that reader accepts. The
 * list is what the reader would actually accept: the default bucket's rows only, and no row recorded
 * as over the send cap (a row with no recorded size is listed, and preflight is where its real size
 * is measured).
 */
async function storageAttachables(db, draft) {
  const projectId = draft?.projectId == null ? null : Number(draft.projectId);
  const scope = projectId == null ? "project_id IS NULL" : "(project_id IS NULL OR project_id = ?)";
  const args = projectId == null ? [] : [projectId];
  try {
    const { rows } = await db.execute({
      sql: `SELECT id, original_name, mime_type, size_bytes FROM storage_files
             WHERE bucket = ? AND (size_bytes IS NULL OR size_bytes <= ?) AND ${scope}
             ORDER BY id DESC
             LIMIT ${ATTACHABLE_STORAGE_LIMIT}`,
      args: [defaultBucket(), MAX_SEND_BYTES, ...args],
    });
    return rows.map((row) => {
      const size = Number(row.size_bytes);
      return {
        fileId: String(row.id),
        filename: safeAttachmentName(row.original_name),
        size: Number.isFinite(size) && size > 0 ? size : 0,
        contentType: typeof row.mime_type === "string" && row.mime_type !== "" ? row.mime_type : null,
      };
    });
  } catch {
    return [];
  }
}

/**
 * The raw bytes the head revision's attachments add up to, as the card shows them against the cap.
 * `totalBytes` is a display figure, from the sizes the revision recorded; preflight enforces the real
 * cap on the bytes themselves.
 */
function attachmentBytes(head) {
  let total = 0;
  for (const ref of Array.isArray(head?.attachments) ? head.attachments : []) {
    const size = Number(ref?.size);
    if (Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

/**
 * The reader link a sent draft's receipt carries, or null: the plan-2 message link, built only once a
 * copy of the Message-ID sits in one of this account's Sent-role folders. A send to self leaves the
 * same Message-ID in INBOX as well, and `resolveMessageRef` prefers the inbox row of such a pair, so
 * the account's rows for the id are asked which one is in a Sent folder and the link is built from
 * that copy. Before the Sent copy is synced the card says "Sent, syncing..." rather than linking a
 * message that is not here.
 */
async function readerLinkFor(db, draft, messageId) {
  if (messageId == null) return null;
  try {
    const { rows } = await db.execute({
      sql: `SELECT id, folder_id FROM mail_messages
             WHERE account_id = ? AND message_id = ? ORDER BY id ASC`,
      args: [draft.accountId, messageId],
    });
    for (const row of rows) {
      const folder = await getFolder(db, row.folder_id);
      if (folder && folderRole(folder) === "sent") {
        return `/dashboard/mail?view=message&a=${encodeURIComponent(draft.accountId)}&mid=${encodeURIComponent(messageId)}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A sent draft's receipt — when, which Message-ID, from which account and where it is readable — or
 * null for every other state. The account label is the display name the row carries, else its
 * address; nothing here reads the content of the message that went out.
 */
async function receiptFor(db, draft) {
  if (draft?.state !== "sent") return null;
  const messageId = typeof draft.messageId === "string" && draft.messageId !== "" ? draft.messageId : null;
  let accountLabel = null;
  try {
    const account = await getAccount(db, draft.accountId);
    if (account) {
      const name = typeof account.displayName === "string" ? account.displayName.trim() : "";
      accountLabel = name !== "" ? name : account.address;
    }
  } catch {
    accountLabel = null;
  }
  return {
    sentAt: draft.sentAt ?? null,
    messageId,
    accountLabel,
    readerLink: await readerLinkFor(db, draft, messageId),
  };
}

export default registerDraftRoutes;