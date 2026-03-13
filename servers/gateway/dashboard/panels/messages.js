/**
 * Messages Panel — Nostr inbox, threads, compose
 */

import { escapeHtml, statCard, statGrid, dataTable, section, formatDate, badge } from "../shared/components.js";

export default {
  id: "messages",
  name: "Messages",
  icon: "messages",
  route: "/dashboard/messages",
  navOrder: 10,

  async handler(req, res, { db, layout }) {
    // Get message stats
    const totalResult = await db.execute("SELECT COUNT(*) as c FROM messages");
    const unreadResult = await db.execute("SELECT COUNT(*) as c FROM messages WHERE is_read = 0 AND direction = 'received'");
    const contactsResult = await db.execute("SELECT COUNT(*) as c FROM contacts WHERE is_blocked = 0");

    const total = totalResult.rows[0]?.c || 0;
    const unread = unreadResult.rows[0]?.c || 0;
    const contacts = contactsResult.rows[0]?.c || 0;

    // Get recent messages grouped by contact
    const messages = await db.execute({
      sql: `SELECT m.id, m.content, m.direction, m.is_read, m.created_at, m.thread_id,
                   c.display_name, c.crow_id
            FROM messages m
            LEFT JOIN contacts c ON m.contact_id = c.id
            ORDER BY m.created_at DESC LIMIT 50`,
      args: [],
    });

    // Build stats
    const stats = statGrid([
      statCard("Total Messages", total, { delay: 0 }),
      statCard("Unread", unread, { delay: 50 }),
      statCard("Contacts", contacts, { delay: 100 }),
    ]);

    // Build message list
    let messageList;
    if (messages.rows.length === 0) {
      messageList = `<div class="empty-state">
        <img src="https://maestro.press/software/crow/icon-sharing.svg" alt="" width="48" height="48">
        <h3>Your inbox is empty</h3>
        <p>Messages from friends and shared items will appear here.</p>
      </div>`;
    } else {
      const rows = messages.rows.map((m) => {
        const dir = m.direction === "sent" ? "→" : "←";
        const readBadge = m.direction === "received" && !m.is_read ? badge("new", "published") : "";
        const name = escapeHtml(m.display_name || m.crow_id || "Unknown");
        const content = escapeHtml((m.content || "").slice(0, 100));
        return [
          `<span class="mono">${dir}</span> ${name} ${readBadge}`,
          content,
          `<span class="mono">${formatDate(m.created_at)}</span>`,
        ];
      });
      messageList = dataTable(["Contact", "Message", "Date"], rows);
    }

    const content = `
      ${stats}
      ${section("Recent Messages", messageList, { delay: 150 })}
    `;

    return layout({ title: "Messages", content });
  },
};
