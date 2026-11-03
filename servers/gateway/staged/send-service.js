/**
 * Staged sends (spec §12.3): the operator's Send, Edit and Not now on a bot's Gmail draft, and the
 * one fixed line the bot learns afterwards.
 *
 * The routes in routes/perch-interactive-api.js are thin on purpose: owner check, body parser, HTTP
 * mapping. Every decision — and every write — is here, so the same send/edit/discard can be tested
 * without an HTTP server.
 *
 * SEND is claimed before anything leaves. `claimSend(db, id, postedHash)` is one compare-and-set on
 * (state, content_hash): of two racing taps (a double tap, two devices) exactly one takes the row,
 * so exactly one `drafts.send` is issued, and a snapshot the operator did not see can never be
 * claimed. Only then is the provider's draft re-read:
 *   - unreadable (404) → `failed`, "This draft is gone from Gmail";
 *   - a shape we cannot rebuild (an attachment, a Reply-To, an unclean address) → `failed`,
 *     "This draft can only be sent from Gmail";
 *   - a different canonical hash → nothing is sent; the card's row is REPLACED with the provider's
 *     own snapshot and the answer is `changed` plus the new row's id and hash, so the operator
 *     reviews the text Gmail actually holds (see sendStaged).
 * What actually leaves is rebuilt from the ROW's approved snapshot (gmail-client.js `sendDraft`),
 * never from the provider's stored draft, so even a bot edit that raced this read cannot ride along.
 * A row with no credential reference ("Open in Gmail to send") is never sent and never edited: Crow
 * cannot name the account, and guessing one would send from the wrong inbox.
 *
 * EDIT validates and canonicalises the posted { to, cc, bcc, subject, body }, rewrites the provider
 * draft, and only then replaces the row (store.replaceWith: the old row becomes `replaced`,
 * atomically). Each posted address field is an ARRAY of single clean addresses (`parseSingleAddressList`):
 * a display name, a group, a second address or a CR/LF refuses the whole edit with `bad_address` and
 * changes nothing, provider included. An edit also refuses a draft the provider holds in a shape we
 * cannot rebuild (`open_in_gmail`): rewriting that draft would silently drop an attachment.
 *
 * An edit takes a short claim of its own first (store.claimEdit bumps `updated_at`) and every write it
 * makes afterwards is a CAS on that stamp. It is NOT a send: nothing it does may leave `sending`, and
 * a send that claims the row while the edit is waiting on the provider wins — the edit then answers
 * `changed` and writes nothing, so a failed `updateDraft` can never reopen a row whose send is in
 * flight (which would let the operator's next tap send twice).
 *
 * The bot is told through a fixed line per session, queued here and claimed by the Perch /message
 * route after the card-offer and password lines (the same in-memory, taken-once queue as
 * secrets/request-store.js's notes). A bridge or job row has no chat to tell — its `sessionId` is
 * null — and its note is dropped there (see queueNote: a known deviation, not an oversight).
 *
 * Nothing in this file puts a body, an address or a subject in a response, a log line, an audit row
 * or a note. The bot learns a recipient COUNT and the provider's message id; the audit row carries
 * the staged id, the channel and the state.
 */
import { auditLog } from "../../db.js";
import { canonicalSnapshot, contentHash, findPlaceholders, parseAddressList, parseSingleAddressList } from "./canonical.js";
import { createGmailClient } from "./gmail-client.js";
import { newRecipients } from "./new-recipients.js";
import {
  claimEdit, claimSend, discard, failEdit, getStaged, listStaged, reconcileStale, replaceWith,
  setNewRecipients, settle,
} from "./store.js";

/** The operator-facing reason a send failed, per provider outcome. Never derived from a provider body. */
export const SEND_FAILED = Object.freeze({
  gone: "This draft is gone from Gmail",
  unfaithful: "This draft can only be sent from Gmail",
  auth: "Gmail did not accept the credential for this draft",
  rate: "Gmail is rate limiting sends; try again shortly",
  other: "Gmail could not send this draft",
  // Not a provider code: an interrupted send whose draft is no longer there (Gmail deletes a sent
  // draft), so it was sent from elsewhere or deleted by hand — and there is no message id either way.
  sentOrDeleted: "Sent or deleted in Gmail",
});

/**
 * A `sending` row older than this was interrupted (the gateway or the provider died mid-send). Ten
 * minutes, well above a whole send's timeout budget (three 20 s HTTP calls: token, read, send): a
 * send that is merely slow is still a send, and putting it back on the card would let the operator
 * tap Send a second time.
 */
export const STALE_SENDING_MS = 10 * 60 * 1000;

/** At most this many interrupted sends are re-read per list request. */
const RECONCILE_MAX = 20;

/** A queued note nobody claimed (the chat was never used again) is dropped after a day. */
export const STAGED_NOTE_TTL_MS = 24 * 60 * 60 * 1000;

/** The fixed lines a bot can be told about its draft. Never bot text, never an address. */
export const STAGED_NOTES = Object.freeze({
  edited: "The operator edited your draft before sending.",
  discarded: "The operator discarded your draft.",
});

/** The "sent" line: the recipient count and the provider message id, and nothing else. */
export function stagedSentNote(snapshot, messageId) {
  const n = recipientCount(snapshot);
  const tail = messageId ? ` (message ${String(messageId)})` : "";
  return `The operator sent your draft to ${n} recipients${tail}.`;
}

/** Distinct recipients across to/cc/bcc (a bcc is a recipient of the message all the same). */
function recipientCount(snapshot) {
  const all = new Set([
    ...parseAddressList(snapshot?.to),
    ...parseAddressList(snapshot?.cc),
    ...parseAddressList(snapshot?.bcc),
  ]);
  return all.size;
}

/* ------------------------------------------------------------------ notes */

const notes = new Map(); // sessionId -> [{ line, at }]
let noteClock = () => Date.now();

/** Store a session's queue, evicting the entry when nothing is left in it: a chat that had one note
 *  and took it must not keep an empty array for the life of the process. */
function setNotes(sid, list) {
  if (list.length) notes.set(sid, list);
  else notes.delete(sid);
}

/** Queue one fixed line for a session's next turn. */
export function addStagedNote(sessionId, line) {
  const sid = sessionId == null ? "" : String(sessionId);
  if (!sid || !line) return;
  const at = noteClock();
  const list = (notes.get(sid) || []).filter((n) => at - n.at <= STAGED_NOTE_TTL_MS);
  list.push({ line: String(line), at });
  setNotes(sid, list);
}

/** The session's queued lines, removed as they are taken: each goes out once. */
export function claimStagedNotes(sessionId) {
  const sid = String(sessionId);
  const list = notes.get(sid) || [];
  setNotes(sid, []);
  const at = noteClock();
  return list.filter((n) => at - n.at <= STAGED_NOTE_TTL_MS).map((n) => n.line);
}

/** Hand lines back (the turn they were taken for never started), ahead of any newer ones. */
export function returnStagedNotes(sessionId, lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  const sid = String(sessionId);
  const at = noteClock();
  setNotes(sid, [...lines.map((line) => ({ line: String(line), at })), ...(notes.get(sid) || [])]);
}

/** Test seams. */
export function _setStagedNoteClockForTest(fn) { noteClock = typeof fn === "function" ? fn : () => Date.now(); }
export function _resetStagedNotesForTest() { notes.clear(); noteClock = () => Date.now(); }
/** The raw queue for a session (null when nothing is queued), so a test can prove eviction. */
export function _stagedNotesForTest(sessionId) {
  const list = notes.get(String(sessionId));
  return list ? list.map((n) => ({ ...n })) : null;
}

/**
 * Queue a note for the row's own chat. A bridge or job row (`sessionId` null) has no chat here: its
 * note is DROPPED, by design and knowingly — a known deviation from the spec, which wants the bot
 * told on its next turn in that thread. Those runs live in another process (the pi bridge, or a
 * job), and this queue is the gateway's memory, so nothing here could ever reach them; the card
 * (and its notification) is the record for those rows. Closing the gap means a durable queue the
 * bridge also reads, which is not this task.
 */
function queueNote(row, line) {
  if (!row || row.sessionId == null) return;
  addStagedNote(row.sessionId, line);
}

/* -------------------------------------------------------------- gmail seam */

/**
 * The Gmail client for a row's credential, or null when there is none.
 * `factory` is the route's test seam — `(credRef) => client`; without one the real client (token
 * file resolved from operator config through cred-ref.js) is used.
 */
export function gmailClientFor(credRef, factory = null) {
  if (credRef == null) return null;
  try {
    if (typeof factory === "function") return factory(credRef) || null;
    return createGmailClient({ credRef });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ audit */

/** One audit row: the staged id, the channel and the state. Nothing else is recorded anywhere. */
async function audit(db, event, row, state, injected) {
  const write = typeof injected === "function" ? injected : auditLog;
  await write(db, event, { details: { staged_id: row.id, channel: row.channel, state } });
}

/* ------------------------------------------------------------------- send */

/**
 * `settle` is a compare-and-set: false means the row moved on under us (a second tap, a sweeper, a
 * retry). It is never silent — the line is fixed (`[staged] settle lost <id>`) and carries nothing
 * of the draft. The caller still answers what actually happened: a message that was sent WAS sent.
 */
async function settleRow(db, id, opts) {
  const ok = await settle(db, id, opts);
  if (!ok) console.warn("[staged] settle lost " + String(id));
  return ok;
}

/** The fixed reason for a provider failure (a GmailError code, or "other" for anything else). */
function reasonFor(err) {
  const code = err && typeof err.code === "string" ? err.code : "other";
  return Object.hasOwn(SEND_FAILED, code) ? SEND_FAILED[code] : SEND_FAILED.other;
}

/** Settle the claimed row `failed` with a fixed reason, audit it, and report it to the caller. */
async function failSend(db, row, reason, auditFn, err = null) {
  await settleRow(db, row.id, { state: "failed", failReason: reason });
  if (err && err.name !== "GmailError") {
    // A non-provider error could carry anything; log its class only (never its message).
    console.warn("[staged] send failed: " + (err.name || "Error"));
  }
  await audit(db, "staged_send", row, "failed", auditFn);
  return { outcome: "failed", failReason: reason };
}

/**
 * Send the staged draft exactly once, for the snapshot whose hash the operator approved.
 *
 * Answers (all fixed strings, no draft content):
 *   { outcome: "sent", messageId, recipients }
 *   { outcome: "failed", failReason }
 *   { outcome: "changed", id?, contentHash? }   the provider's draft is not what the card showed (or
 *                                 the claim was lost to an older snapshot). When the draft is one we
 *                                 can rebuild, the card's row is REPLACED with the provider's own
 *                                 snapshot + hash and this answer carries the new row's id and hash,
 *                                 so the operator reviews the new text.
 *   { outcome: "already_sent" }   the row is `sending`/`sent` already
 *   { outcome: "placeholders" }   unfilled `[brackets]` in the stored snapshot: refused server-side
 *   { outcome: "open_in_gmail" }  no credential reference: Crow cannot send it
 *   { outcome: "unsupported_channel" }  the row is not a Gmail draft (nothing else ships yet)
 *   { outcome: "not_found" }
 *
 * `gmail` is the client factory seam (credRef → client); `audit` replaces auditLog.
 */
export async function sendStaged(db, id, postedHash, { gmail = null, audit: auditFn = null } = {}) {
  const row = await getStaged(db, id);
  if (!row) return { outcome: "not_found" };
  // Gmail is the only channel this client can rebuild and send. A row of another channel is not a
  // draft Crow knows how to claim; refusing it is the honest answer, not a guess.
  if (row.channel !== "gmail") return { outcome: "unsupported_channel" };
  // "Open in Gmail to send": the recorder could not name the account (an unreadable credential, a
  // failed re-read, a draft we cannot rebuild). Nothing here may move such a row.
  if (row.credRef == null) return { outcome: "open_in_gmail" };

  // 1. The placeholder rule enforced on the RECORD, not only in the card: a client that re-enables
  // a disabled button cannot send `[Client Name]` to anyone.
  if (findPlaceholders(row.snapshot).length) return { outcome: "placeholders" };

  // 2. One claim wins, and only for the hash the operator saw.
  if (!(await claimSend(db, id, postedHash))) {
    const now = await getStaged(db, id);
    const state = now ? now.state : null;
    return { outcome: state === "sent" || state === "sending" ? "already_sent" : "changed" };
  }

  const client = gmailClientFor(row.credRef, gmail);
  if (!client) {
    // The claim was taken and nothing was sent: put the row back exactly where it was.
    await settleRow(db, id, { state: "staged" });
    return { outcome: "open_in_gmail" };
  }

  try {
    // 3. What does the provider hold NOW?
    const draft = await client.getDraft(row.providerDraftId);
    if (draft.faithful === false) return await failSend(db, row, SEND_FAILED.unfaithful, auditFn);
    if (contentHash(draft.snapshot) !== row.contentHash) {
      // The bot (or the operator, in Gmail) changed it after the card was shown. Nothing was sent,
      // and the card goes back to review — but around the NEW text, not the stale one: the row is
      // replaced with what Gmail holds now (replaceWith keeps the credential, the thread, the
      // session and the card), and the answer names the new row so the client re-renders it. A
      // replacement that loses the race (the row moved on) is simply "changed" with no new row.
      await settleRow(db, id, { state: "staged" });
      let newId = null;
      try {
        newId = await replaceWith(db, id, { providerDraftId: row.providerDraftId, snapshot: draft.snapshot });
      } catch (err) {
        if (!err || err.code !== "not_replaceable") throw err;
      }
      const fresh = newId ? await getStaged(db, newId) : null;
      return { outcome: "changed", id: fresh ? fresh.id : null, contentHash: fresh ? fresh.contentHash : null };
    }

    // 4. Send the approved snapshot (the client rebuilds the message from the row, not from Gmail).
    const sent = await client.sendDraft(row.providerDraftId, { snapshot: row.snapshot, threadId: row.providerThreadId });
    const messageId = sent && sent.messageId != null ? String(sent.messageId) : null;
    // A lost settle does not unsend anything: the message left, so the answer is "sent" either way
    // (the row it lost to is logged, and the note still reaches the bot).
    await settleRow(db, id, { state: "sent", providerMessageId: messageId });
    queueNote(row, stagedSentNote(row.snapshot, messageId));
    await audit(db, "staged_send", row, "sent", auditFn);
    return { outcome: "sent", messageId, recipients: recipientCount(row.snapshot) };
  } catch (err) {
    // 5. Every provider failure ends the row `failed` with a fixed reason and stays retryable. A
    // failure after the request reached Gmail is indistinguishable from one before it; a retry is
    // the operator's call, and `reconcileStale` settles the interrupted rows (a sent draft is gone,
    // so a retry's re-read is a 404, never a second send).
    return await failSend(db, row, reasonFor(err), auditFn, err);
  }
}

/* ------------------------------------------------------------------- edit */

/** The states an edit starts from (the same two a send claim starts from). */
const EDITABLE = Object.freeze(["staged", "failed"]);

/**
 * The edit's honest failure: write it only if the row is still the one this edit claimed, and audit
 * it only if the write landed. A refused write means a send took the row while the edit was away —
 * the edit is over, nothing was written, and the card must re-read the row (`changed`).
 */
async function failEdited(db, row, at, reason, auditFn) {
  if (!(await failEdit(db, row.id, { at, failReason: reason }))) return { outcome: "changed" };
  await audit(db, "staged_edit", row, "failed", auditFn);
  return { outcome: "failed", failReason: reason };
}

/**
 * Rewrite the draft from the operator's edit, then replace the row.
 *
 * Answers:
 *   { outcome: "edited", id, contentHash, state }   the NEW row's id and hash
 *   { outcome: "failed", failReason }               the provider refused the read or the update
 *                                                   (the row is `failed`, still editable)
 *   { outcome: "bad_address" }                      an address field is not an array of single clean
 *                                                   addresses (nothing written, provider included)
 *   { outcome: "not_editable" }                     the row is sent, replaced or discarded
 *   { outcome: "changed" }                          the row was claimed for a send mid-edit, so this
 *                                                   edit wrote nothing
 *   { outcome: "open_in_gmail" } | { outcome: "not_found" }
 *
 * `open_in_gmail` also covers a current draft we cannot rebuild faithfully (an attachment, a
 * Reply-To): rewriting it from an edit would drop what the operator never saw in the card.
 */
export async function editStaged(db, id, posted = {}, { gmail = null, audit: auditFn = null } = {}) {
  const row = await getStaged(db, id);
  if (!row) return { outcome: "not_found" };
  if (row.credRef == null) return { outcome: "open_in_gmail" };
  if (!EDITABLE.includes(row.state)) return { outcome: "not_editable" };

  const body = posted && typeof posted === "object" && !Array.isArray(posted) ? posted : {};

  // Every address must be ONE clean addr-spec before anything is written: the card posts one entry
  // per address, so a display name, a group (`Team: a@x;`), a second address, a CR/LF or any other
  // control character is a client we cannot trust to have shown the operator who this goes to, and
  // the whole edit is refused — Gmail and the row both unchanged.
  const to = parseSingleAddressList(body.to);
  const cc = body.cc == null ? [] : parseSingleAddressList(body.cc);
  const bcc = body.bcc == null ? [] : parseSingleAddressList(body.bcc);
  if (!to || !cc || !bcc || !to.length) return { outcome: "bad_address" };
  const snapshot = canonicalSnapshot({ to, cc, bcc, subject: body.subject, body: body.body });

  const client = gmailClientFor(row.credRef, gmail);
  if (!client) return { outcome: "open_in_gmail" };

  // The edit's own claim — NOT a send's (`claimEdit` never touches `state`). From here every write
  // is a CAS on `editAt`, so a send that claims the row while the provider is answering wins.
  const editAt = await claimEdit(db, id);
  if (editAt == null) return { outcome: "changed" };

  let current;
  try {
    current = await client.getDraft(row.providerDraftId);
  } catch (err) {
    return await failEdited(db, row, editAt, reasonFor(err), auditFn);
  }
  // An attachment (or a shape we cannot rebuild) is the operator's to keep: an edit rebuilds the
  // whole message from the card's five fields, so rewriting this draft would silently drop it.
  if (current.faithful === false) return { outcome: "open_in_gmail" };

  try {
    await client.updateDraft(row.providerDraftId, snapshot);
  } catch (err) {
    const reason = reasonFor(err);
    // The row keeps its old snapshot (the operator can retry the edit); `failed` is still editable
    // and still claimable, so nothing is lost either way.
    return await failEdited(db, row, editAt, reason, auditFn);
  }

  let newId;
  try {
    // The new row keeps the thread/session/card/bot and the credential; only the snapshot changes.
    newId = await replaceWith(db, id, { providerDraftId: row.providerDraftId, snapshot });
  } catch (err) {
    // A send claimed the row between the check and here: the message that goes out is still the
    // row's own approved snapshot, never this edit. Nothing was replaced.
    if (err && err.code === "not_replaceable") return { outcome: "changed" };
    throw err;
  }

  const fresh = await getStaged(db, newId);
  queueNote(row, STAGED_NOTES.edited);
  await audit(db, "staged_edit", { id: newId, channel: row.channel }, "staged", auditFn);
  return {
    outcome: "edited",
    id: newId,
    contentHash: fresh ? fresh.contentHash : null,
    state: fresh ? fresh.state : "staged",
  };
}

/* ---------------------------------------------------------------- discard */

/** "Not now": `staged`/`failed` → `discarded`. A row that already went (or never existed) is `changed`. */
export async function discardStaged(db, id, { audit: auditFn = null } = {}) {
  const row = await getStaged(db, id);
  if (!row) return { outcome: "not_found" };
  if (!(await discard(db, id))) return { outcome: "changed" };
  queueNote(row, STAGED_NOTES.discarded);
  await audit(db, "staged_discard", row, "discarded", auditFn);
  return { outcome: "discarded" };
}

/* ------------------------------------------------------------------- list */

/**
 * Settle the `sending` rows a crash left behind, before the card answers. A row that is still
 * readable went nowhere (the claim never reached `drafts.send`), so it goes back to `staged` for
 * review; a 404 means the draft was sent (Gmail deletes a sent draft) or deleted by hand, and there
 * is no message id either way. A row we cannot read at all (auth, network) is left alone — its
 * `updated_at` is not touched, so the very next list read tries it again.
 *
 * Every settle here is a CAS on the stamp this function READ (`expectedUpdatedAt`): a row that was
 * touched since — a claim settled, the operator's retry claimed it again — is left alone. Only a
 * row nothing has touched for `STALE_SENDING_MS` is ever a candidate, so a send still in flight is
 * never put back on the card (which is what would let it be sent a second time).
 */
async function reconcileInterrupted(db, { gmail, now }) {
  let ids;
  try {
    ids = await reconcileStale(db, { olderThanMs: STALE_SENDING_MS, now });
  } catch {
    return; // a locked DB never blocks the card
  }
  for (const id of ids.slice(0, RECONCILE_MAX)) {
    try {
      const row = await getStaged(db, id);
      if (!row || row.state !== "sending") continue;
      const client = gmailClientFor(row.credRef, gmail);
      if (!client) continue;
      try {
        await client.getDraft(row.providerDraftId);
      } catch (err) {
        if (err && err.code === "gone") {
          await settleRow(db, id, { state: "failed", failReason: SEND_FAILED.sentOrDeleted, expectedUpdatedAt: row.updatedAt });
        }
        continue;
      }
      await settleRow(db, id, { state: "staged", expectedUpdatedAt: row.updatedAt });
    } catch { /* one row's problem never blocks the list */ }
  }
}

/**
 * The session's open rows (staged/sending/failed) as the card reads them:
 * `{ id, state, snapshot, contentHash, placeholders, newRecipients, sendable, failReason, tainted }`.
 * Never `raw`, never the credential reference, never a token path.
 *
 * The new-recipient hint is computed on the first read of a sendable row and cached on it — the
 * whole answer, `[]` included ("none of these is new" is an answer too, and asking Gmail again for
 * it on every card read is what the cap exists to prevent). Only `null` (the search could not be
 * made) is left uncached, so an outage is retried rather than remembered.
 */
export async function listStagedForSession(db, sessionId, { gmail = null, now = Date.now() } = {}) {
  await reconcileInterrupted(db, { gmail, now });
  const rows = await listStaged(db, { sessionId: String(sessionId) });
  const items = [];
  for (const row of rows) {
    let newOnes = Array.isArray(row.newRecipients) ? row.newRecipients : [];
    if (row.credRef != null && row.newRecipients == null) {
      const client = gmailClientFor(row.credRef, gmail);
      const found = client ? await newRecipients(db, row.snapshot, { gmail: client }) : null;
      if (found) {
        try { await setNewRecipients(db, row.id, found); } catch { /* the hint is not worth a failed read */ }
        newOnes = found;
      }
    }
    items.push({
      id: row.id,
      state: row.state,
      snapshot: row.snapshot,
      contentHash: row.contentHash,
      placeholders: findPlaceholders(row.snapshot),
      newRecipients: newOnes,
      sendable: row.credRef != null,
      failReason: row.failReason,
      tainted: row.tainted,
    });
  }
  return items;
}