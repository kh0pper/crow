/**
 * Crow Messages rooms store (libsql / gateway side). A room IS a contact_groups
 * row with a non-NULL room_uid; members reuse contact_group_members. The 1:1
 * `messages` table is untouched — room messages live in `room_messages`.
 */
import { randomBytes } from "node:crypto";

function normMode(mode) { return mode === "always" ? "always" : "addressed"; }

/** Create a host-side room. Assigns a stable room_uid. Returns { groupId, roomUid }. */
export async function createRoom(db, { name, memberContactIds = [], mode = "addressed", hostCrowId = null }) {
  const roomUid = randomBytes(16).toString("hex"); // 32 hex chars
  const res = await db.execute({
    sql: "INSERT INTO contact_groups (name, room_uid, host_crow_id, mode) VALUES (?,?,?,?)",
    args: [name, roomUid, hostCrowId, normMode(mode)],
  });
  const groupId = Number(res.lastInsertRowid);
  for (const cid of memberContactIds) {
    await db.execute({ sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?,?)", args: [groupId, cid] });
  }
  return { groupId, roomUid };
}

/** Materialize a local room row for a room hosted elsewhere (participant side). Idempotent on room_uid. Returns groupId. */
export async function ensureLocalRoomForUid(db, { roomUid, name = "Room", hostCrowId = null, mode = "addressed" }) {
  const { rows } = await db.execute({ sql: "SELECT id FROM contact_groups WHERE room_uid = ?", args: [roomUid] });
  if (rows.length) return Number(rows[0].id);
  const res = await db.execute({
    sql: "INSERT INTO contact_groups (name, room_uid, host_crow_id, mode) VALUES (?,?,?,?)",
    args: [name, roomUid, hostCrowId, normMode(mode)],
  });
  return Number(res.lastInsertRowid);
}

/** A room by its contact_groups id, or null. Only returns rows that ARE rooms (room_uid not null). */
export async function getRoom(db, groupId) {
  const { rows } = await db.execute({ sql: "SELECT id, name, room_uid, host_crow_id, mode, created_at FROM contact_groups WHERE id = ? AND room_uid IS NOT NULL", args: [groupId] });
  return rows[0] || null;
}

/** A room by its shared room_uid, or null. */
export async function getRoomByUid(db, roomUid) {
  const { rows } = await db.execute({ sql: "SELECT id, name, room_uid, host_crow_id, mode, created_at FROM contact_groups WHERE room_uid = ?", args: [roomUid] });
  return rows[0] || null;
}

/** All rooms (room_uid not null), newest first. */
export async function listRooms(db) {
  const { rows } = await db.execute("SELECT id, name, room_uid, host_crow_id, mode, created_at FROM contact_groups WHERE room_uid IS NOT NULL ORDER BY id DESC");
  return rows;
}

/** Member contacts of a room (joined to contacts for pubkey/name/is_bot). */
export async function listRoomMembers(db, groupId) {
  const { rows } = await db.execute({
    sql: `SELECT c.id, c.crow_id, c.display_name, c.is_bot, c.secp256k1_pubkey, c.is_blocked
          FROM contact_group_members gm JOIN contacts c ON c.id = gm.contact_id
          WHERE gm.group_id = ? AND c.is_blocked = 0`,
    args: [groupId],
  });
  return rows;
}

export async function addMember(db, groupId, contactId) {
  await db.execute({ sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?,?)", args: [groupId, contactId] });
}
export async function removeMember(db, groupId, contactId) {
  await db.execute({ sql: "DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?", args: [groupId, contactId] });
}
export async function setMode(db, groupId, mode) {
  await db.execute({ sql: "UPDATE contact_groups SET mode = ? WHERE id = ? AND room_uid IS NOT NULL", args: [normMode(mode), groupId] });
}
export async function renameRoom(db, groupId, name) {
  await db.execute({ sql: "UPDATE contact_groups SET name = ? WHERE id = ? AND room_uid IS NOT NULL", args: [name, groupId] });
}
export async function deleteRoom(db, groupId) {
  // FK ON DELETE CASCADE does not fire at runtime (foreign_keys pragma is off on the
  // request-path client), so explicitly remove room messages + memberships to avoid
  // orphan rows. Guard on getRoom so a plain organizational group is never touched.
  const room = await getRoom(db, groupId);
  if (!room) return;
  await db.execute({ sql: "DELETE FROM room_messages WHERE group_id = ?", args: [groupId] });
  await db.execute({ sql: "DELETE FROM contact_group_members WHERE group_id = ?", args: [groupId] });
  await db.execute({ sql: "DELETE FROM contact_groups WHERE id = ?", args: [groupId] });
}

/** Insert a room message. Returns true if newly inserted, false if a dup (group, msg_uid). */
export async function insertRoomMessage(db, { groupId, msgUid, senderContactId = null, senderLabel = null, authorKind = "human", content, direction, nostrEventId = null }) {
  const res = await db.execute({
    sql: `INSERT OR IGNORE INTO room_messages
            (group_id, msg_uid, sender_contact_id, sender_label, author_kind, content, direction, nostr_event_id)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [groupId, msgUid, senderContactId, senderLabel, authorKind === "bot" ? "bot" : "human", content, direction, nostrEventId],
  });
  return (res.rowsAffected || 0) > 0;
}

/** Room messages, oldest-first, joined to the sender contact for display. */
export async function getRoomMessages(db, groupId, { limit = 200 } = {}) {
  const { rows } = await db.execute({
    sql: `SELECT rm.id, rm.msg_uid, rm.content, rm.author_kind, rm.direction, rm.is_read, rm.created_at,
                 rm.sender_label, c.display_name AS sender_name, c.is_bot AS sender_is_bot
          FROM room_messages rm
          LEFT JOIN contacts c ON c.id = rm.sender_contact_id
          WHERE rm.group_id = ?
          ORDER BY rm.id ASC
          LIMIT ?`,
    args: [groupId, limit],
  });
  return rows;
}

/**
 * Which bots in `botRoster` a human message addresses. Matches an explicit
 * `@name` OR a whole-word occurrence of the bot's display name (case-insensitive).
 * NEVER substring ("maximum" must not match "Max"). botRoster: [{contactId,name}].
 */
export function computeAddressedTo(text, botRoster) {
  const out = [];
  const lc = String(text || "").toLowerCase();
  for (const b of botRoster) {
    const name = String(b.name || "").trim();
    if (!name) continue;
    const nl = name.toLowerCase();
    const esc = nl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const at = lc.includes("@" + nl);
    const word = new RegExp("(^|[^a-z0-9])" + esc + "([^a-z0-9]|$)").test(lc);
    if (at || word) out.push(name);
  }
  return out;
}
