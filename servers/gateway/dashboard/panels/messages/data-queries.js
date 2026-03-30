/**
 * Messages Panel — Data Queries
 *
 * DB queries for the unified conversation list, peer messages, and status polling.
 */

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

  // CrowClaw bots (running)
  try {
    const { rows: botRows } = await db.execute(`
      SELECT b.id, b.name, b.display_name, b.status,
             (SELECT MAX(m.created_at) FROM crowclaw_bot_messages m WHERE m.bot_id = b.id) as last_activity
      FROM crowclaw_bots b
      WHERE b.status = 'running'
      ORDER BY last_activity DESC NULLS LAST
    `);

    for (const row of botRows) {
      items.push({
        type: "bot",
        id: row.id,
        displayName: row.display_name || row.name,
        botName: row.name,
        lastActivity: row.last_activity || null,
        unread: 0,
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
