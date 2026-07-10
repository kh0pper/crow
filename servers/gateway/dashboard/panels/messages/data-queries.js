/**
 * Messages Panel — Data Queries
 *
 * DB queries for the unified conversation list, peer messages, and status polling.
 */

import { getPeerAdvertisedBots } from "../../advertised-bots-cache.js";
import { getTrustedInstances } from "../nest/data-queries.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";

/**
 * Get a unified conversation list merging AI chats and peer contacts.
 * Sorted by last activity descending.
 */
export async function getUnifiedConversationList(db) {
  const items = [];
  let totalUnread = 0;

  // AI conversations
  try {
    const { rows: aiRows } = await db.execute(`
      SELECT c.id, c.title, c.provider, c.model, c.updated_at, c.created_at,
             (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as msg_count
      FROM chat_conversations c
      ORDER BY c.updated_at DESC
      LIMIT 100
    `);

    for (const row of aiRows) {
      items.push({
        type: "ai",
        id: row.id,
        displayName: row.title || "Untitled Chat",
        provider: row.provider,
        model: row.model,
        lastActivity: row.updated_at || row.created_at,
        msgCount: row.msg_count,
        unread: 0,
      });
    }
  } catch {}

  // Peer contacts with message activity
  try {
    const { rows: peerRows } = await db.execute(`
      SELECT c.id as contact_id, c.crow_id, c.display_name, c.last_seen, c.is_blocked, c.is_bot, c.verified,
             MAX(m.created_at) as last_msg_at,
             SUM(CASE WHEN m.is_read = 0 AND m.direction = 'received' THEN 1 ELSE 0 END) as unread
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id
      WHERE c.is_blocked = 0 AND (c.origin IS NULL OR c.origin != 'local-bot')
        AND (c.request_status IS NULL OR c.request_status = 'accepted')
      GROUP BY c.id
      ORDER BY last_msg_at DESC NULLS LAST, c.created_at DESC
    `);

    for (const row of peerRows) {
      const unread = Number(row.unread) || 0;
      totalUnread += unread;
      items.push({
        type: "peer",
        id: row.contact_id,
        crowId: row.crow_id,
        displayName: row.display_name || (row.crow_id ? row.crow_id.substring(0, 16) + "..." : "Unknown"),
        lastActivity: row.last_msg_at || row.last_seen || null,
        lastSeen: row.last_seen,
        isBot: !!Number(row.is_bot),
        verified: !!Number(row.verified),
        unread,
      });
    }
  } catch {}


  // Rooms (multi-party). A contact_group with a room_uid is a room.
  try {
    const { rows: roomRows } = await db.execute(`
      SELECT g.id AS group_id, g.name, g.room_uid, g.mode,
             MAX(rm.created_at) AS last_msg_at,
             SUM(CASE WHEN rm.is_read = 0 AND rm.direction = 'received' THEN 1 ELSE 0 END) AS unread,
             (SELECT COUNT(*) FROM contact_group_members gm WHERE gm.group_id = g.id) AS member_count
      FROM contact_groups g
      LEFT JOIN room_messages rm ON rm.group_id = g.id
      WHERE g.room_uid IS NOT NULL
      GROUP BY g.id
      ORDER BY last_msg_at DESC NULLS LAST, g.id DESC
    `);
    for (const row of roomRows) {
      const unread = Number(row.unread) || 0;
      totalUnread += unread;
      items.push({
        type: "room",
        id: "room-" + row.group_id,
        groupId: Number(row.group_id),
        roomUid: row.room_uid,
        displayName: row.name || "Room",
        mode: row.mode || "addressed",
        memberCount: Number(row.member_count) || 0,
        lastActivity: row.last_msg_at || null,
        unread,
      });
    }
  } catch {}

  // Sort all items by last activity
  items.sort((a, b) => {
    const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bTime - aTime;
  });

  return { items, totalUnread };
}

/**
 * Get pending message requests (unknown-sender DMs, L6). Each is a minimal
 * `contacts` row tagged `request_status='pending'` with its stored messages.
 * Returns the newest-first list the "Requests (N)" inbox renders, each with a
 * short display, the latest message as a preview, the message count, and the
 * contact/created timestamps. 'accepted' and full (NULL) contacts are excluded.
 * Never throws.
 */
export async function getMessageRequests(db) {
  try {
    const { rows } = await db.execute(`
      SELECT c.id, c.crow_id, c.display_name, c.created_at,
             COUNT(m.id) AS msg_count,
             MAX(m.created_at) AS last_msg_at,
             (SELECT content FROM messages WHERE contact_id = c.id ORDER BY id DESC LIMIT 1) AS preview
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id
      WHERE c.request_status = 'pending'
      GROUP BY c.id
      ORDER BY last_msg_at DESC NULLS LAST, c.created_at DESC
    `);
    return rows.map((r) => {
      const crowId = String(r.crow_id || "");
      // `req:<64-hex pubkey>` → a compact `req:<first 10>…`; other ids → prefix.
      let shortId;
      if (crowId.startsWith("req:")) {
        shortId = "req:" + crowId.slice(4, 14) + "…";
      } else {
        shortId = crowId.length > 16 ? crowId.substring(0, 16) + "…" : crowId;
      }
      return {
        id: Number(r.id),
        crowId,
        displayName: r.display_name || shortId,
        shortId,
        preview: r.preview || "",
        msgCount: Number(r.msg_count) || 0,
        createdAt: r.created_at,
        lastMsgAt: r.last_msg_at,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get peer messages for a specific contact. One query owner for the live
 * route AND the panel (F-UI-6: the route's private copy dropped
 * delivery_status, so receipts vanished on reload).
 *  - afterId > 0: ascending rows with id > afterId (poll/live incremental).
 *  - else: latest window (descending LIMIT/OFFSET), returned oldest-first.
 */
export async function getPeerMessages(db, contactId, { limit = 50, offset = 0, afterId = 0 } = {}) {
  const cols = `m.id, m.content, m.direction, m.is_read, m.created_at,
                m.thread_id, m.nostr_event_id, m.attachments, m.delivery_status,
                c.display_name, c.crow_id, c.last_seen`;
  let rows;
  if (afterId > 0) {
    ({ rows } = await db.execute({
      sql: `SELECT ${cols} FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            WHERE m.contact_id = ? AND m.id > ?
            ORDER BY m.id ASC
            LIMIT ?`,
      args: [contactId, afterId, limit],
    }));
  } else {
    ({ rows } = await db.execute({
      sql: `SELECT ${cols} FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            WHERE m.contact_id = ?
            ORDER BY m.id DESC
            LIMIT ? OFFSET ?`,
      args: [contactId, limit, offset],
    }));
    rows = rows.reverse();
  }
  return rows.map((m) => ({
    ...m,
    attachments: m.attachments ? JSON.parse(m.attachments) : null,
  }));
}

/**
 * Lightweight status for polling — unread counts and last activity.
 */
export async function getMessageStatus(db) {
  const { rows: peerRows } = await db.execute(`
    SELECT m.contact_id as contactId,
           SUM(CASE WHEN m.is_read = 0 AND m.direction = 'received' THEN 1 ELSE 0 END) as unread,
           MAX(m.created_at) as lastActivity
    FROM messages m
    GROUP BY m.contact_id
  `);

  const { rows: aiRows } = await db.execute(`
    SELECT id as convId, updated_at as lastActivity
    FROM chat_conversations
    ORDER BY updated_at DESC LIMIT 50
  `);

  return {
    peers: peerRows.map((r) => ({ contactId: r.contactId, unread: Number(r.unread) || 0, lastActivity: r.lastActivity })),
    ai: aiRows.map((r) => ({ convId: r.convId, lastActivity: r.lastActivity })),
  };
}

/**
 * Cross-instance bot directory: all advertised bots across trusted peers,
 * grouped by instance, each marked added/contactId via a pubkey match against
 * contacts (includes blocked — a blocked bot is still "known"). Shows ALL bots
 * (added ones are badged, not hidden). Never throws.
 */
export async function getBotDirectory(db) {
  const known = new Map(); // trailing-64 lowercased x-only pubkey -> contact id
  try {
    const { rows } = await db.execute("SELECT id, secp256k1_pubkey FROM contacts WHERE secp256k1_pubkey IS NOT NULL AND request_status IS NULL");
    for (const r of rows) {
      const h = String(r.secp256k1_pubkey || "");
      if (h.length >= 64) known.set(h.slice(-64).toLowerCase(), Number(r.id));
    }
  } catch {}

  let localId = null;
  try { localId = getOrCreateLocalInstanceId(); } catch {}
  let insts = [];
  try { insts = await getTrustedInstances(db); } catch {}
  const peerIds = insts.map((i) => i.id).filter((id) => id && id !== localId);

  const settled = await Promise.allSettled(peerIds.map((id) => getPeerAdvertisedBots(db, id)));
  const seen = new Set();
  const live = new Set();
  const groupsByInst = new Map();
  let total = 0, notAddedCount = 0;
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value || s.value.status !== "ok") continue;
    for (const b of s.value.bots) {
      live.add(b.messaging_pubkey);
      if (seen.has(b.messaging_pubkey)) continue;
      seen.add(b.messaging_pubkey);
      const contactId = known.get(b.messaging_pubkey) ?? null;
      const added = contactId != null;
      total += 1;
      if (!added) notAddedCount += 1;
      const g = groupsByInst.get(b.instance_id) || { instanceId: b.instance_id, instanceLabel: b.instance_label || null, bots: [] };
      g.bots.push({
        botId: b.bot_id,
        displayName: b.display_name,
        description: b.description || null,
        instanceId: b.instance_id,
        instanceLabel: b.instance_label || null,
        messagingPubkey: b.messaging_pubkey,
        inviteCode: b.invite_code,
        added,
        contactId,
      });
      groupsByInst.set(b.instance_id, g);
    }
  }
  if (live.size > 0) { try { await pruneStaleAdvertisedContacts(db, live); } catch {} }
  return { groups: Array.from(groupsByInst.values()), total, notAddedCount };
}

/**
 * Delete origin='advertised' contacts that have no message history AND are no
 * longer advertised (not in `livePubkeys`, a Set of trailing-64 lowercased
 * x-only keys). Contacts with history are always kept. Never throws.
 */
export async function pruneStaleAdvertisedContacts(db, livePubkeys) {
  try {
    const { rows } = await db.execute(`
      SELECT c.id, c.secp256k1_pubkey
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id
      WHERE c.origin = 'advertised'
      GROUP BY c.id
      HAVING COUNT(m.id) = 0`);
    for (const r of rows) {
      const h = String(r.secp256k1_pubkey || "");
      const pk = h.length >= 64 ? h.slice(-64).toLowerCase() : "";
      if (!livePubkeys.has(pk)) {
        await db.execute({ sql: "DELETE FROM contacts WHERE id = ?", args: [r.id] });
      }
    }
  } catch {}
}
