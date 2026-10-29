/**
 * Credential card (R1.2 spec §10, §10.5 option 1): the pending secret requests.
 *
 * A bot's `crow_request_secret` call (secrets/mcp.js) creates one request here; the operator's
 * card answers it (Task 3's submit route claims it, then hands the value to its target,
 * secrets/targets.js). What the bot learns comes back as fixed lines on its next turn
 * (takeSecretNotes, prefixed by the Perch /message route like the card-offer notes).
 *
 * Rules (spec §10.3 item 4):
 *  - In memory only. Nothing here is ever written to the DB or a file, and a gateway restart
 *    drops every request (the card dies with the process; the bot's next turn simply gets no note).
 *  - A request never holds a value: the value exists only as an argument inside a target's
 *    `deliver` (targets.js). This store keeps the request's metadata and nothing else.
 *  - One open request per session. The id is 128 random bits (32 hex characters), single use,
 *    bound to the session; it expires 10 minutes after it is made.
 *  - Expiry is lazy (every entry point sweeps first), so no timer keeps the process alive and a
 *    test can drive the clock (_setClockForTest).
 */
import { randomBytes } from "node:crypto";
import { getTarget } from "./targets.js";

export const SECRET_REQUEST_TTL_MS = 10 * 60 * 1000;

/** The fixed lines a bot can be told about a request. Never bot text, never a value. */
export const SECRET_NOTES = Object.freeze({
  closed: "You closed the form. Nothing was sent.",
  expired: "The password request expired. Nothing was sent.",
  notAvailable: "That kind of request isn't available yet.",
});

const ID_RE = /^[0-9a-f]{32}$/;
const LABEL_MAX = 80;

let clock = () => Date.now();
const requests = new Map(); // id -> frozen request
const notes = new Map(); // sessionId -> string[]

export class SecretRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A bot-supplied label as a short single line, or null. Control characters are dropped. */
export function cleanLabel(v) {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX).trim();
  return t || null;
}

/** Queue one fixed line for the session's next turn. */
export function addSecretNote(sessionId, line) {
  const sid = String(sessionId);
  const list = notes.get(sid) || [];
  list.push(String(line));
  notes.set(sid, list);
}

function expire(r) {
  requests.delete(r.id);
  addSecretNote(r.sessionId, SECRET_NOTES.expired);
}

/** Drop every request past its expiry, each with its expired note. */
export function sweepExpired(now = clock()) {
  for (const r of [...requests.values()]) if (now >= r.expiresAt) expire(r);
}

/** The session's open request, or null. */
export function openRequestFor(sessionId) {
  sweepExpired();
  const sid = String(sessionId);
  for (const r of requests.values()) if (r.sessionId === sid) return r;
  return null;
}

/** One request's metadata (no value is ever held), or null when it is gone. */
export function getSecretRequest(id) {
  sweepExpired();
  return (typeof id === "string" && requests.get(id)) || null;
}

/**
 * Make a request. Returns `{ id }`. Throws SecretRequestError:
 *  - `one_open`: this session already has an open request;
 *  - `bad_target`: the kind or target is not one the registry takes (the message is the fixed
 *    "That kind of request isn't available yet.").
 */
export function createSecretRequest({ sessionId, threadId, botId, kind = "password", target, label } = {}) {
  if (sessionId == null || String(sessionId) === "" || botId == null || String(botId) === "") {
    throw new SecretRequestError("bad_request", "A request needs a session and a bot.");
  }
  sweepExpired();
  const sid = String(sessionId);
  const t = typeof target === "string" ? getTarget(target) : null;
  const req = {
    sessionId: sid,
    threadId: threadId == null ? sid : String(threadId),
    botId: String(botId),
    kind: String(kind),
    target: typeof target === "string" ? target : "",
    label: cleanLabel(label),
  };
  let valid = false;
  try { valid = kind === "password" && !!t && t.validate(req) === true; } catch { valid = false; }
  if (!valid) throw new SecretRequestError("bad_target", SECRET_NOTES.notAvailable);
  if (openRequestFor(sid)) throw new SecretRequestError("one_open", "A password card is already open in this chat.");
  const id = randomBytes(16).toString("hex");
  const createdAt = clock();
  requests.set(id, Object.freeze({ id, ...req, createdAt, expiresAt: createdAt + SECRET_REQUEST_TTL_MS }));
  return { id };
}

/** Look a request up for one session: { outcome, request? }. Never consumes on a mismatch. */
function lookup(id, sessionId) {
  if (typeof id !== "string" || !ID_RE.test(id)) return { outcome: "not_found" };
  const r = requests.get(id);
  if (!r) return { outcome: "not_found" };
  if (clock() >= r.expiresAt) {
    expire(r);
    return { outcome: "expired" };
  }
  if (sessionId == null || String(sessionId) !== r.sessionId) return { outcome: "wrong_session" };
  return { outcome: "ok", request: r };
}

/**
 * The single-use claim. `{ outcome: "ok", request }` removes the request, so a second claim of
 * the same id is `not_found`. The other outcomes are `expired` (the request is dropped, with its
 * note), `not_found` and `wrong_session` (another session's id: refused, and the request stays,
 * so a wrong claim can never burn someone else's card).
 */
export function claimSecret(id, { sessionId } = {}) {
  const r = lookup(id, sessionId);
  if (r.outcome === "ok") requests.delete(id);
  return r;
}

/** The fixed line when a target throws: no error text ever reaches the bot or the log. */
export const SECRET_DELIVER_FAILED = "The password couldn't be used. Nothing was sent.";

/**
 * Hand a CLAIMED request's value to its target, then queue the target's note for the bot's next
 * turn. Returns `{ ok, note }`. The value is only passed through: it is never stored, logged or
 * put in an error. A throwing target gives the fixed SECRET_DELIVER_FAILED note and one fixed
 * log line naming the target and the error's class only.
 */
export async function deliverSecret(request, value, ctx = {}) {
  const t = request ? getTarget(request.target) : null;
  let out;
  if (!t) out = { ok: false, note: SECRET_NOTES.notAvailable };
  else {
    try {
      const r = await t.deliver(request, value, ctx);
      out = { ok: !!(r && r.ok), note: r && typeof r.note === "string" ? r.note : SECRET_DELIVER_FAILED };
      if (r && r.entryId != null) out.entryId = r.entryId;
    } catch (e) {
      console.warn(`[secrets] ${request.target} delivery failed: ${(e && e.name) || "Error"}`);
      out = { ok: false, note: SECRET_DELIVER_FAILED };
    }
  }
  if (request) addSecretNote(request.sessionId, out.note);
  return out;
}

/** The operator closed the card: the request goes, and the bot is told so on its next turn. */
export function cancelSecret(id, sessionId) {
  const r = lookup(id, sessionId);
  if (r.outcome !== "ok") return { outcome: r.outcome };
  requests.delete(id);
  addSecretNote(r.request.sessionId, SECRET_NOTES.closed);
  return { outcome: "ok", note: SECRET_NOTES.closed };
}

/** Drop a request with no note (the card could not be shown, so the bot was told at once). */
export function discardSecret(id) {
  requests.delete(id);
}

/** The session's queued lines, removed as they are taken: each goes out once. */
export function takeSecretNotes(sessionId) {
  sweepExpired();
  const sid = String(sessionId);
  const list = notes.get(sid) || [];
  notes.delete(sid);
  return list;
}

/** Hand lines back (the turn they were taken for never started), ahead of any newer ones. */
export function returnSecretNotes(sessionId, lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  const sid = String(sessionId);
  notes.set(sid, [...lines, ...(notes.get(sid) || [])]);
}

/** Test seams. */
export function _setClockForTest(fn) { clock = typeof fn === "function" ? fn : () => Date.now(); }
export function _resetSecretStoreForTest() { requests.clear(); notes.clear(); clock = () => Date.now(); }
