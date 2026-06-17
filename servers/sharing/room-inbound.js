/**
 * Crow Messages room inbound (phase 3a). Routed from boot.js onSocialMessage for
 * the `room_join` and `room_message` subtypes. In 3a THIS instance is always the
 * host of rooms it created; a room_message therefore arrives from one of our own
 * members (a local bot's reply or a remote human's reply) — we authorize the
 * signer is a member, store once, and re-fan to everyone else. room_join is the
 * participant path: materialize the local room a remote host invited us into.
 */
import {
  ensureLocalRoomForUid, getRoomByUid, listRoomMembers,
  insertRoomMessage, computeAddressedTo,
} from "../gateway/dashboard/panels/messages/rooms-store.js";
import { buildRoomMessageEnvelope, fanOut } from "./room-fanout.js";

function xOnly(hex) { const h = String(hex || ""); return h.length === 66 ? h.slice(2) : h; }
function pubkeyMatches(storedCompressed, signerXOnly) {
  const a = String(storedCompressed || "");
  return a.length >= 64 && a.slice(-64).toLowerCase() === String(signerXOnly || "").toLowerCase();
}

export async function handleInboundRoomEnvelope({ db, nostrManager, identity, subtype, payload, senderPubkey, log = () => {} }) {
  const pk = xOnly(senderPubkey);

  if (subtype === "room_join") {
    // Trust: only a KNOWN contact (the host) may pull us into a room. Fail-closed —
    // prevents an unknown sender from auto-creating room rows in our list.
    const { rows: known } = await db.execute("SELECT secp256k1_pubkey FROM contacts WHERE secp256k1_pubkey IS NOT NULL AND is_blocked = 0");
    if (!known.some((r) => pubkeyMatches(r.secp256k1_pubkey, pk))) { log("room_join drop: unknown signer"); return; }
    const groupId = await ensureLocalRoomForUid(db, {
      roomUid: payload.room_uid, name: payload.room_name, hostCrowId: payload.host_crow_id,
    });
    // Best-effort: add any members we already know as contacts (matched by crow_id).
    if (Array.isArray(payload.members)) {
      for (const m of payload.members) {
        if (!m || !m.crow_id) continue;
        const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [m.crow_id] });
        if (rows[0]?.id != null) await db.execute({ sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?,?)", args: [groupId, rows[0].id] });
      }
    }
    return;
  }

  if (subtype === "room_message") {
    const room = await getRoomByUid(db, payload.room_uid);
    if (!room) { log("room_message: unknown room " + payload.room_uid); return; }
    const members = await listRoomMembers(db, room.id);
    const author = payload.author || {};
    const weAreHost = !room.host_crow_id || room.host_crow_id === identity.crowId;

    // Authorize the SIGNER: a room member (host side, where members relay to us) OR
    // the room's host (participant side, where the host relays to us). Fail-closed.
    const signerMember = members.find((m) => pubkeyMatches(m.secp256k1_pubkey, pk));
    let authorized = !!signerMember;
    if (!authorized && room.host_crow_id) {
      const { rows } = await db.execute({ sql: "SELECT secp256k1_pubkey FROM contacts WHERE crow_id = ?", args: [room.host_crow_id] });
      if (rows[0] && pubkeyMatches(rows[0].secp256k1_pubkey, pk)) authorized = true;
    }
    if (!authorized) { log("room_message drop: signer not member/host of " + payload.room_uid); return; }

    // Attribute the message to the CRYPTOGRAPHICALLY-VERIFIED author, never the
    // spoofable payload labels. Two legs:
    //   - signer IS a room member (host-receive leg, the member relays their own
    //     message): trust the verified signer; IGNORE payload author entirely.
    //   - signer is null (participant leg, the room's host relays someone else's
    //     text): the host already attributed it, so honor the payload author for
    //     display, resolving the contact by crow_id (fallback to display_name).
    let authorContactId = null, authorLabel = null, resolvedAuthor;
    if (signerMember) {
      authorContactId = signerMember.id;
      authorLabel = signerMember.display_name;
      resolvedAuthor = {
        kind: Number(signerMember.is_bot) === 1 ? "bot" : "human",
        crow_id: signerMember.crow_id,
        display_name: signerMember.display_name,
      };
    } else {
      resolvedAuthor = {
        kind: author.kind === "bot" ? "bot" : "human",
        crow_id: author.crow_id || null,
        display_name: author.display_name || null,
      };
      authorLabel = author.display_name || null;
      if (author.crow_id) {
        const { rows } = await db.execute({ sql: "SELECT id, display_name FROM contacts WHERE crow_id = ?", args: [author.crow_id] });
        if (rows[0]) { authorContactId = rows[0].id; authorLabel = rows[0].display_name || authorLabel; }
      }
    }

    const inserted = await insertRoomMessage(db, {
      groupId: room.id, msgUid: payload.msg_uid, senderContactId: authorContactId,
      senderLabel: authorLabel,
      authorKind: resolvedAuthor.kind,
      content: payload.text || "", direction: "received", nostrEventId: null,
    });
    if (!inserted) return; // duplicate msg_uid — already handled

    // ONLY the host relays. A participant just stored the message for display.
    if (!weAreHost) return;

    // Host re-fan to all OTHER members. For human-authored messages the host
    // computes addressed_to (authoritative); bot-authored messages address no one.
    const botRoster = members.filter((m) => Number(m.is_bot) === 1).map((m) => ({ contactId: m.id, name: m.display_name || m.crow_id }));
    const addressedTo = resolvedAuthor.kind === "human"
      ? (room.mode === "always" ? botRoster.map((b) => b.name) : computeAddressedTo(payload.text || "", botRoster))
      : [];
    const envelope = buildRoomMessageEnvelope({
      roomUid: room.room_uid, roomName: room.name, hostCrowId: identity.crowId,
      msgUid: payload.msg_uid, author: resolvedAuthor, text: payload.text || "", addressedTo, ts: payload.ts || null,
    });
    // Exclude the transport origin (the member who sent it) from the re-fan.
    await fanOut({ nostrManager, members, envelope, excludeContactId: signerMember ? signerMember.id : null, log });
    return;
  }
}
