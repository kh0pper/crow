/**
 * Delivery for a Crow Messages draft: hand the text to the send path that ALREADY exists for its
 * conversation kind, and nothing else.
 *
 * There are two kinds, and each one has exactly one sender in this codebase:
 *
 *   - `contact` — the 1:1 peer chat. The sender is `handlePeerSend`
 *     (servers/gateway/routes/peer-messages.js), the function behind
 *     `POST /api/messages/peer/:contactId/send`: it resolves the contact, calls the sharing server's
 *     `crow_send_message`, treats a 0-relay result as a failure the caller must see, and reads back
 *     the row it wrote. It is called here with a bare request/response pair because that is the
 *     function's own interface; nothing about the delivery (relay feedback, the failed-row retry
 *     bookkeeping) is re-implemented on this side, so a draft send and a typed send cannot drift.
 *   - `room` — the multi-party chat. The sender is `sendOperatorRoomMessage`
 *     (servers/gateway/dashboard/panels/messages/room-send.js), the same function the room panel's
 *     composer calls: it stores the local row and fans the envelope out to the members (or to the
 *     host, when this instance is a participant).
 *
 * THE TEXT GOES OUT EXACTLY AS POSTED, MINUS THE WHITESPACE THE EXISTING PATH ALREADY DROPS.
 * Nothing here appends a signature, a provenance line or a "Sent by …" line: an owner's draft goes
 * out as the owner's words. A draft a bot wrote carries its `origin` and `bot_id` (and the sealed
 * name) on the row and in the audit trail, which is where a bot's part in it is recorded — never
 * inside the message a person receives. (The panel is free to draw that provenance beside the text;
 * the wire is not.)
 *
 * The one transformation is `trim()`, and it is here because the two send paths this module drives
 * already do it themselves: `POST /api/messages/peer/:contactId/send` calls `crow_send_message` with
 * `message.trim()`, and the room route hands `sendOperatorRoomMessage` `message.trim()` as well. A
 * draft that is sent therefore reads exactly like the same words typed into the composer — no
 * trailing newline the composer's textarea collects and a typed message does not. Nothing else about
 * the text is touched, and a draft that is only whitespace is refused before anything is attempted.
 *
 * The caller has already checked the seal and the live recipient set
 * (servers/gateway/routes/messages-drafts-api.js), so this module does one thing: deliver, and say
 * whether it landed. Every reason it answers is a fixed code — never a library's or a relay's text —
 * because the route's answer goes back to a card.
 *
 * THE DELIVERY IS TO THE PEOPLE THE DRAFT NAMED, NOT TO THEIR NAMES. Both send paths resolve a
 * destination by an identifier a person types (`crow_send_message` matches `crow_id = ? OR
 * display_name = ?`; a room fan-out re-lists the room's members), and that resolution can land on a
 * different row than the one the draft was checked against — a contact whose display name is another
 * contact's crow id, a member re-keyed between the check and the send. So the sealed audience rides
 * along into the delivery: the peer send is called in STRICT mode (the row is read by primary id,
 * its id / crow id / secp256k1 key are compared with the snapshot, it is named by its unique crow
 * id, and that same snapshot is handed to `crow_send_message` itself as an internal, non-argument
 * guard so the tool refuses if its own lookup resolves any other row), and the room send gets
 * `expectedRecipients` (the member rows are checked by primary id right before the fan-out). A
 * refusal before the handoff comes back as its own reason — `recipients_changed`, `pubkey_changed`,
 * `blocked` — and nothing is sent.
 */
import { handlePeerSend } from "../routes/peer-messages.js";
import { sendOperatorRoomMessage } from "../dashboard/panels/messages/room-send.js";

/** The reasons a DELIVERY answers when the handoff check refused: the route shows them as its own
 *  codes (`recipients_changed`, `pubkey_changed`, `blocked`), never as a failed delivery. */
const HANDOFF_REFUSALS = Object.freeze(["recipients_changed", "pubkey_changed", "blocked"]);

/**
 * A bare response object for `handlePeerSend`: it only ever answers with `status(code).json(body)`,
 * and the pair below records what it said. Never touches a real socket.
 */
function answerRecorder() {
  // Express answers 200 unless the handler says otherwise: `handlePeerSend`'s success path calls
  // `res.json(...)` with no `res.status(200)` first, so the recorder starts at 200.
  const out = { status: 200, body: null };
  const res = {
    headersSent: false,
    status(code) {
      out.status = code;
      return res;
    },
    json(body) {
      out.body = body;
      res.headersSent = true;
      return res;
    },
  };
  return { res, out };
}

/**
 * Deliver one draft's text.
 *
 * @param {object} db
 * @param {object} draft the store's draft row (`conversationKind`, `conversationId`)
 * @param {string} text the exact text to send
 * @param {{managers?: object|null, sharingClientFactory?: Function}} [deps] the room send's
 *   `managers` (this instance's sharing runtime, or null in a test) and the peer send's client
 *   factory seam (tests inject a stub; production uses the real in-memory sharing client)
 * @returns {Promise<{ok: true, messageId: string|null}|{ok: false, reason: string}>}
 */
export async function sendDraftMessage(db, draft, text, deps = {}) {
  const message = String(text ?? "").trim();
  if (!message) return { ok: false, reason: "empty" };

  if (draft.conversationKind === "contact") {
    // The recipient the draft sealed, found by the conversation's own contact id — the only person a
    // 1:1 draft can be for. No snapshot means the row was rewritten out from under its seal (the
    // route would have refused it earlier): never send to a row this draft did not name.
    const sealed = (Array.isArray(draft.recipients) ? draft.recipients : [])
      .find((entry) => Number(entry?.contactId) === Number(draft.conversationId)) || null;
    if (!sealed) return { ok: false, reason: "recipients_changed" };
    const { res, out } = answerRecorder();
    try {
      await handlePeerSend(
        { params: { contactId: String(draft.conversationId) }, body: { message } },
        res,
        {
          db,
          strictRecipient: sealed,
          ...(typeof deps.sharingClientFactory === "function"
            ? { sharingClientFactory: deps.sharingClientFactory }
            : {}),
        },
      );
    } catch {
      return { ok: false, reason: "send_failed" };
    }
    if (out.status === 404) return { ok: false, reason: "conversation_gone" };
    if (out.status === 400) return { ok: false, reason: "bad_input" };
    if (out.status === 200 && out.body?.ok) {
      return { ok: true, messageId: out.body.id == null ? null : String(out.body.id) };
    }
    // The handoff check refused: the row about to receive the text is not the one the draft sealed.
    if (out.status === 409 && HANDOFF_REFUSALS.includes(out.body?.error)) {
      return { ok: false, reason: out.body.error };
    }
    // A 502 from the peer path is a delivery that reached no relay: the draft stays to try again.
    return { ok: false, reason: "delivery_failed" };
  }

  if (draft.conversationKind === "room") {
    try {
      const result = await sendOperatorRoomMessage({
        db,
        managers: deps.managers ?? null,
        groupId: draft.conversationId,
        message,
        expectedRecipients: Array.isArray(draft.recipients) ? draft.recipients : [],
      });
      if (result?.ok) return { ok: true, messageId: null };
      // The member rows the fan-out was about to reach are not the ones the draft sealed.
      if (HANDOFF_REFUSALS.includes(result?.error)) return { ok: false, reason: result.error };
      return { ok: false, reason: result?.error === "no such room" ? "conversation_gone" : "send_failed" };
    } catch {
      return { ok: false, reason: "send_failed" };
    }
  }

  return { ok: false, reason: "bad_conversation" };
}