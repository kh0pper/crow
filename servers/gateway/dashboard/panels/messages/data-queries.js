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
      SELECT c.id as contact_id, c.crow_id, c.display_name, c.last_seen, c.is_blocked,
             MAX(m.created_at) as last_msg_at,
             SUM(CASE WHEN m.is_read = 0 AND m.direction = 'received' THEN 1 ELSE 0 END) as unread
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id
      WHERE c.is_blocked = 0
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
 * Get peer messages for a specific contact.
 */
export async function getPeerMessages(db, contactId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await db.execute({
    sql: `SELECT m.id, m.content, m.direction, m.is_read, m.created_at,
                 m.thread_id, m.nostr_event_id, m.attachments,
                 c.display_name, c.crow_id
          FROM messages m
          LEFT JOIN contacts c ON m.contact_id = c.id
          WHERE m.contact_id = ?
          ORDER BY m.id DESC
          LIMIT ? OFFSET ?`,
    args: [contactId, limit, offset],
  });

  return rows.reverse().map((m) => ({
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
 * Advertised bots from paired instances, as read-only "available" Messages
 * entries. Excludes self + revoked/paused/untrusted peers (via getTrustedInstances),
 * dedups by messaging pubkey, and omits any bot already materialized as a local
 * contact. Never throws — a bad peer is silently dropped by the cache.
 */
export async function getAdvertisedBotItems(db) {
  // Pubkeys we already have a contact for (trailing-64, lowercased). This
  // includes BLOCKED contacts on purpose: a bot you blocked should NOT
  // reappear in the advertised "available" list, so we keep its pubkey here
  // to suppress it.
  const known = new Set();
  try {
    const { rows } = await db.execute("SELECT secp256k1_pubkey FROM contacts WHERE secp256k1_pubkey IS NOT NULL");
    for (const r of rows) {
      const h = String(r.secp256k1_pubkey || "");
      if (h.length >= 64) known.add(h.slice(-64).toLowerCase());
    }
  } catch {}

  let localId = null;
  try { localId = getOrCreateLocalInstanceId(); } catch {}

  // Trusted + active/offline peers only (same set every federation fan-out uses).
  // This already excludes revoked, paused, untrusted, and the __local_mcp__
  // pseudo-instance; we additionally drop self.
  let peerIds = [];
  try {
    const insts = await getTrustedInstances(db);
    peerIds = insts.map((i) => i.id).filter((id) => id && id !== localId);
  } catch {}

  const settled = await Promise.allSettled(peerIds.map((id) => getPeerAdvertisedBots(db, id)));
  const items = [];
  const seen = new Set();
  const live = new Set();
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value || s.value.status !== "ok") continue;
    for (const b of s.value.bots) {
      live.add(b.messaging_pubkey);
      if (known.has(b.messaging_pubkey) || seen.has(b.messaging_pubkey)) continue;
      seen.add(b.messaging_pubkey);
      items.push({
        type: "advertised",
        botId: b.bot_id,
        displayName: b.display_name,
        instanceId: b.instance_id,
        instanceLabel: b.instance_label,
        messagingPubkey: b.messaging_pubkey,
        inviteCode: b.invite_code,
      });
    }
  }
  await pruneStaleAdvertisedContacts(db, live);
  return items;
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
