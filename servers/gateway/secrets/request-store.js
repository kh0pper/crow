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
 *  - Expiry: every entry point sweeps first, and an unref'd timer per request also expires it at
 *    `expiresAt` while nobody calls in, so the card flips to "expired" on its own. The timer never
 *    keeps the process alive and is cleared on claim, cancel, discard and forgetSession; a test
 *    drives both the clock (_setClockForTest) and the timers (_setTimersForTest).
 *  - The card hook seam lives here (setEmitSecretCard / emitSecretCard; secrets/mcp.js re-exports
 *    it): the boot wires it to the Perch engine's allowlisted `secret_request` frame, and the
 *    expiry timer and the submit route both emit through it.
 */
import { randomBytes } from "node:crypto";
import { getTarget } from "./targets.js";

export const SECRET_REQUEST_TTL_MS = 10 * 60 * 1000;
/** A queued note nobody took (the chat was never used again) is dropped after this. */
export const SECRET_NOTE_TTL_MS = 24 * 60 * 60 * 1000;

/** The fixed lines a bot can be told about a request. Never bot text, never a value. */
export const SECRET_NOTES = Object.freeze({
  closed: "You closed the form. Nothing was sent.",
  expired: "The password request expired. Nothing was sent.",
  notAvailable: "That kind of request isn't available yet.",
});

const ID_RE = /^[0-9a-f]{32}$/;
const LABEL_MAX = 80;

let clock = () => Date.now();
let setTimer = (fn, ms) => { const h = setTimeout(fn, ms); if (h && typeof h.unref === "function") h.unref(); return h; };
let clearTimer = (h) => clearTimeout(h);
const requests = new Map(); // id -> frozen request
const timers = new Map(); // id -> expiry timer handle
const notes = new Map(); // sessionId -> [{ line, at }]
const MAX_TIMER_MS = 2 ** 31 - 1;

// The card hook: (sessionId, frame, { botId }) => { delivered } | undefined. Installed once at
// boot (boot/mcp-mounts.js) with the engine's emitSecretCardToResident; absent, it is a no-op.
let installedCardHook = null;
/** Install (or, with null, remove) the process's card hook. */
export function setEmitSecretCard(fn) { installedCardHook = typeof fn === "function" ? fn : null; }
/** The default card hook: the installed one, or a no-op (undefined) when none is installed. */
export function emitSecretCard(sessionId, frame, opts) {
  return installedCardHook ? installedCardHook(sessionId, frame, opts) : undefined;
}

/** The card frame for a request (primitives only, never a value). */
export function secretFrame(r, state) {
  return { type: "secret_request", id: r.id, label: r.label, state };
}

/** Emit a frame through the hook, never throwing: a card update is display only. */
function emitQuietly(r, state) {
  try {
    const out = emitSecretCard(r.sessionId, secretFrame(r, state), { botId: r.botId });
    if (out && typeof out.then === "function") out.then(null, () => {});
  } catch { /* display only */ }
}

function dropTimer(id) {
  const h = timers.get(id);
  if (h !== undefined) { timers.delete(id); try { clearTimer(h); } catch { /* gone */ } }
}

function remove(id) {
  requests.delete(id);
  dropTimer(id);
}

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
  list.push({ line: String(line), at: clock() });
  notes.set(sid, list);
}

function expire(r, { emit = true } = {}) {
  remove(r.id);
  addSecretNote(r.sessionId, SECRET_NOTES.expired);
  if (emit) emitQuietly(r, "expired");
}

/** Drop every request past its expiry (each with its expired note), then every note older
 *  than SECRET_NOTE_TTL_MS, so the queue of a chat that is never used again cannot grow. */
export function sweepExpired(now = clock()) {
  for (const r of [...requests.values()]) if (now >= r.expiresAt) expire(r);
  for (const [sid, list] of [...notes.entries()]) {
    const fresh = list.filter((n) => now - n.at < SECRET_NOTE_TTL_MS);
    if (!fresh.length) notes.delete(sid);
    else if (fresh.length !== list.length) notes.set(sid, fresh);
  }
}

/** The session stopped or was archived: drop its requests and its queued notes (no note). */
export function forgetSession(sessionId) {
  const sid = String(sessionId);
  for (const r of [...requests.values()]) if (r.sessionId === sid) remove(r.id);
  notes.delete(sid);
}

/**
 * The session's child is gone (hibernated, exited, shut down) but the chat goes on: its open
 * request expires now, with the expired note for the bot's next turn, and any queued notes
 * (a "Saved in the keychain" the bot has not seen yet) are kept. The engine draws the card
 * change itself, so nothing is emitted through the hook. Returns the expired requests.
 */
export function expireSessionRequests(sessionId) {
  const sid = String(sessionId);
  const out = [];
  for (const r of [...requests.values()]) if (r.sessionId === sid) { expire(r, { emit: false }); out.push(r); }
  return out;
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
  timers.set(id, setTimer(() => { timers.delete(id); sweepExpired(); }, Math.min(SECRET_REQUEST_TTL_MS, MAX_TIMER_MS)));
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
  if (r.outcome === "ok") remove(id);
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
  remove(id);
  addSecretNote(r.request.sessionId, SECRET_NOTES.closed);
  return { outcome: "ok", note: SECRET_NOTES.closed, request: r.request };
}

/** Drop a request with no note (the card could not be shown, so the bot was told at once). */
export function discardSecret(id) {
  remove(id);
}

/** The session's queued lines, removed as they are taken: each goes out once. */
export function takeSecretNotes(sessionId) {
  sweepExpired();
  const sid = String(sessionId);
  const list = notes.get(sid) || [];
  notes.delete(sid);
  return list.map((n) => n.line);
}

/** Hand lines back (the turn they were taken for never started), ahead of any newer ones. */
export function returnSecretNotes(sessionId, lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  const sid = String(sessionId);
  const at = clock();
  notes.set(sid, [...lines.map((line) => ({ line: String(line), at })), ...(notes.get(sid) || [])]);
}

/** Test seams. */
export function _setClockForTest(fn) { clock = typeof fn === "function" ? fn : () => Date.now(); }
/** Replace the expiry timers ({ setTimer(fn, ms) -> handle, clearTimer(handle) }); null restores. */
export function _setTimersForTest(t) {
  if (t && typeof t.setTimer === "function" && typeof t.clearTimer === "function") { setTimer = t.setTimer; clearTimer = t.clearTimer; return; }
  setTimer = (fn, ms) => { const h = setTimeout(fn, ms); if (h && typeof h.unref === "function") h.unref(); return h; };
  clearTimer = (h) => clearTimeout(h);
}
export function _resetSecretStoreForTest() {
  for (const id of [...timers.keys()]) dropTimer(id);
  requests.clear(); notes.clear(); clock = () => Date.now();
}
