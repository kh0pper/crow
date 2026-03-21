/**
 * Crow's Nest Panel — Contacts management (list, block/unblock, invite, discovery)
 */

import { escapeHtml, dataTable, section, badge } from "../shared/components.js";

export default {
  id: "contacts",
  name: "Contacts",
  icon: "contacts",
  route: "/dashboard/contacts",
  navOrder: 12,
  hidden: false,
  category: "core",

  async handler(req, res, { db, layout }) {
    // --- Handle POST actions ---
    if (req.method === "POST") {
      const { action, crow_id } = req.body;

      if (action === "block" && crow_id) {
        await db.execute({
          sql: "UPDATE contacts SET is_blocked = 1 WHERE crow_id = ?",
          args: [crow_id],
        });
        return res.redirect("/dashboard/contacts");
      }

      if (action === "unblock" && crow_id) {
        await db.execute({
          sql: "UPDATE contacts SET is_blocked = 0 WHERE crow_id = ?",
          args: [crow_id],
        });
        return res.redirect("/dashboard/contacts");
      }
    }

    // --- Fetch data ---
    const [contactsResult, discoveryResult] = await Promise.all([
      db.execute("SELECT * FROM contacts ORDER BY is_blocked ASC, last_seen DESC"),
      db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_enabled'",
        args: [],
      }),
    ]);

    const contacts = contactsResult.rows;
    const discoveryEnabled = discoveryResult.rows[0]?.value === "true";

    // --- Contact list ---
    let contactListHtml;
    if (contacts.length === 0) {
      contactListHtml = `
        <div style="text-align:center;padding:2rem;color:var(--crow-text-muted)">
          <p style="font-size:1.1rem;margin-bottom:0.5rem">No contacts yet</p>
          <p style="font-size:0.85rem">Ask your AI to generate an invite code with "create an invite" or use the sharing skill.</p>
        </div>`;
    } else {
      const rows = contacts.map((c) => {
        const name = escapeHtml(c.display_name || c.crow_id.substring(0, 16) + "...");
        const crowId = `<code style="font-size:0.75rem;color:var(--crow-text-muted)">${escapeHtml(c.crow_id.substring(0, 24))}...</code>`;

        const statusBadge = c.is_blocked
          ? badge("Blocked", "error")
          : c.last_seen
            ? badge("Active", "connected")
            : badge("Pending", "draft");

        const lastSeenStr = c.last_seen
          ? new Date(c.last_seen).toLocaleDateString()
          : "Never";

        const actionBtn = c.is_blocked
          ? `<form method="POST" style="display:inline">
               <input type="hidden" name="action" value="unblock">
               <input type="hidden" name="crow_id" value="${escapeHtml(c.crow_id)}">
               <button type="submit" class="btn btn-sm btn-secondary">Unblock</button>
             </form>`
          : `<form method="POST" style="display:inline" onsubmit="return confirm('Block this contact? They won\\'t be able to message or share with you.')">
               <input type="hidden" name="action" value="block">
               <input type="hidden" name="crow_id" value="${escapeHtml(c.crow_id)}">
               <button type="submit" class="btn btn-sm btn-secondary" style="color:var(--crow-error)">Block</button>
             </form>`;

        return [name + "<br>" + crowId, statusBadge, lastSeenStr, actionBtn];
      });

      contactListHtml = dataTable(
        ["Contact", "Status", "Last Seen", "Actions"],
        rows
      );
    }

    // --- Invite section ---
    const inviteHtml = `
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin-bottom:0.75rem">
        To add a contact, ask your AI: <em>"Generate an invite code"</em> or <em>"Invite someone to my Crow network"</em>.
        Share the resulting code with the person you want to connect with.
      </p>
      <p style="color:var(--crow-text-muted);font-size:0.85rem">
        To accept an invite, ask: <em>"Accept this invite: [paste code]"</em>
      </p>`;

    const content = `
      ${section("Contacts", contactListHtml, { delay: 200 })}
      ${section("Add a Contact", inviteHtml, { delay: 250 })}
    `;

    return layout({ title: "Contacts", content });
  },
};
