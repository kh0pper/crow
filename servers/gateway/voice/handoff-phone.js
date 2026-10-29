/**
 * A question sent to the operator's phone (voice hand-off PR 4, shared by PR 5): a kiosk, a shared display,
 * never takes a spoken yes, so a hand-off proposal (handoff.js proposeToPhone) and a stop (handoff-stop.js)
 * asked there become an `awaiting_phone` row and one high-priority push that opens the phone confirm page.
 * Imports only the store contract through `core`, so handoff.js and handoff-stop.js both read it with no cycle.
 *
 *  - One open phone question per kiosk and kind [rv2 m4]: while one is live, handoff_already_sent, no push,
 *    no row. A phone_open from the insert (a race) re-runs openPhone once, which moves out a row that has
 *    just expired, and retries the insert once; only a second phone_open is already-sent [rv3 m4].
 *  - "Sent" only when the push went out [rv1 C5]: a notify that returns null (the type is off) or throws moves
 *    the row to failed "not_sent" (markNotSent). Null says the alerts are off (handoff_phone_off); a throw
 *    says the phone could not be reached just now (handoff_phone_failed).
 */
import { voiceLine } from "./voice-lines.js";

/** The page a kiosk question's push opens (the phone confirm page, Task 4.2). */
export const phoneConfirmPath = (id) => "/dashboard/voice/handoffs/" + id;

/** How the push names the kiosk: its name, else handoff_display_fallback in `lang`. */
export function displayNameOf(device, lang) {
  const name = typeof device?.name === "string" ? device.name.trim() : "";
  return name || voiceLine("handoff_display_fallback", lang);
}

/**
 * The push did not go out: awaiting_phone → failed "not_sent", retried once. A row left awaiting_phone would
 * answer every next ask with "already sent" for the whole 30 min, so when both tries throw the row is moved to
 * expired instead (its own try); only that failing too is left to the sweep, and logged.
 */
async function markNotSent(core, db, id, log) {
  const { store } = core;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await store.transition(db, id, ["awaiting_phone"], "failed", { detail: "not_sent" }); return; }
    catch (err) { log(`[voice-handoff] ${id}: could not mark not_sent, try ${attempt} (${err?.message || err})`); }
  }
  try { await store.transition(db, id, ["awaiting_phone"], "expired", { detail: "not_sent" }); }
  catch (err) { log(`[voice-handoff] ${id}: could not expire the unsent row (${err?.message || err})`); }
}

/**
 * Send one question of `kind` ("handoff" | "stop") for `device` to the phone. `insert()` writes the
 * awaiting_phone row and resolves its id; `title` and `body` are the push's. → { code, say, id }, code one of
 * "sent_to_phone" | "phone_off" | "phone_failed" | "already_sent" (id null when nothing was inserted).
 */
export async function sendToPhone(core, db, { device, kind, lang, insert, title, body, log = core.log || console.warn }) {
  const { store } = core;
  const already = () => ({ code: "already_sent", say: voiceLine("handoff_already_sent", lang), id: null });
  if (await store.openPhone(db, device.id, kind)) return already();
  let id;
  try {
    id = await insert();
  } catch (err) {
    if (err?.code !== "phone_open") throw err;
    if (await store.openPhone(db, device.id, kind)) return already();
    try { id = await insert(); } catch (err2) { if (err2?.code === "phone_open") return already(); throw err2; }
  }
  let n = null;
  let threw = false;
  try {
    n = await core.notify(db, { type: "attention", priority: "high", title, body, action_url: phoneConfirmPath(id), source: "crow-voice" });
  } catch (err) { threw = true; log(`[voice-handoff] ${id}: phone notification failed (${err?.message || err})`); }
  if (n != null) return { code: "sent_to_phone", say: voiceLine("handoff_sent_to_phone", lang), id };
  await markNotSent(core, db, id, log);
  // A null is the type turned off (the operator can fix it); a throw is a passing failure: try again soon.
  return threw ? { code: "phone_failed", say: voiceLine("handoff_phone_failed", lang), id } : { code: "phone_off", say: voiceLine("handoff_phone_off", lang), id };
}
