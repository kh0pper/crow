/**
 * Crow's Nest — Calls Panel
 *
 * Contact list with "Start Call" buttons and active call management.
 * This is an add-on panel (installed to ~/.crow/panels/).
 */

export default {
  id: "calls",
  name: "Calls",
  icon: "phone",
  route: "/dashboard/calls",
  navOrder: 25,
  hidden: false,
  category: "social",

  async handler(req, res, { db, lang, layout }) {
    // Fetch incoming call notifications (last hour, undismissed)
    let incomingCalls = [];
    try {
      const { rows } = await db.execute({
        sql: `SELECT id, title, body, action_url, created_at FROM notifications
              WHERE source = 'sharing:room_invite' AND is_dismissed = 0
                AND created_at > datetime('now', '-1 hour')
              ORDER BY created_at DESC`,
        args: [],
      });
      incomingCalls = rows;
    } catch {
      // notifications table may not exist yet
    }

    // Fetch contacts
    const { rows: contacts } = await db.execute({
      sql: "SELECT id, crow_id, display_name, is_blocked, last_seen FROM contacts WHERE is_blocked = 0 ORDER BY last_seen DESC",
      args: [],
    });

    const gatewayUrl = process.env.CROW_GATEWAY_URL || "";

    const content = `
<style>
  .calls-panel { padding: 24px; max-width: 600px; margin: 0 auto; }
  .calls-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  .calls-header h2 { font-size: 18px; font-weight: 600; color: var(--text-primary, #e7e5e4); }
  .incoming-section { margin-bottom: 24px; }
  .incoming-label {
    font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    color: #22c55e; margin-bottom: 8px;
  }
  .incoming-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; background: rgba(34,197,94,0.06);
    border: 1px solid rgba(34,197,94,0.25); border-radius: 10px;
  }
  .incoming-row + .incoming-row { margin-top: 8px; }
  .incoming-info { flex: 1; min-width: 0; }
  .incoming-title { font-size: 14px; font-weight: 600; color: var(--text-primary, #e7e5e4); }
  .incoming-time { font-size: 11px; color: var(--text-muted, #78716c); margin-top: 2px; }
  .join-btn {
    padding: 8px 16px; font-size: 12px; font-weight: 600;
    color: #22c55e; background: rgba(34,197,94,0.1);
    border: 1px solid rgba(34,197,94,0.3); border-radius: 8px;
    text-decoration: none; cursor: pointer; transition: background 0.15s;
  }
  .join-btn:hover { background: rgba(34,197,94,0.2); }
  .contact-list { display: flex; flex-direction: column; gap: 8px; }
  .contact-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; background: var(--surface-secondary, rgba(26,26,46,0.5));
    border-radius: 10px; border: 1px solid var(--border-subtle, rgba(61,61,77,0.4));
  }
  .contact-info { display: flex; align-items: center; gap: 12px; }
  .contact-avatar {
    width: 36px; height: 36px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; color: #fff;
    background: var(--accent, #818cf8);
  }
  .contact-name { font-size: 14px; font-weight: 600; color: var(--text-primary, #e7e5e4); }
  .contact-id { font-size: 11px; color: var(--text-muted, #78716c); }
  .call-btn {
    padding: 8px 16px; font-size: 12px; font-weight: 600;
    color: #22c55e; background: rgba(34,197,94,0.1);
    border: 1px solid rgba(34,197,94,0.3); border-radius: 8px;
    cursor: pointer; transition: background 0.15s;
  }
  .call-btn:hover { background: rgba(34,197,94,0.2); }
  .empty-state {
    text-align: center; padding: 48px 24px; color: var(--text-muted, #78716c);
    font-size: 14px;
  }
</style>
<div class="calls-panel">
  <div class="calls-header">
    <h2>Calls</h2>
  </div>
  ${incomingCalls.length > 0 ? `
    <div class="incoming-section">
      <div class="incoming-label">Incoming</div>
      ${incomingCalls.map(c => {
        const timeIso = c.created_at || "";
        return `
          <div class="incoming-row">
            <div class="incoming-info">
              <div class="incoming-title">${escapeHtml(c.title || "Incoming call")}</div>
              <div class="incoming-time">${escapeHtml(timeIso)}</div>
            </div>
            <a class="join-btn" href="${escapeHtml(c.action_url || "#")}" target="_blank">Join</a>
          </div>`;
      }).join("")}
    </div>
  ` : ""}
  ${contacts.length === 0
    ? '<div class="empty-state">No contacts yet. Share an invite code to connect with other Crow users.</div>'
    : '<div class="contact-list">' + contacts.map(c => {
        const name = c.display_name || c.crow_id || "Unknown";
        const initial = name.charAt(0).toUpperCase();
        return `
          <div class="contact-row">
            <div class="contact-info">
              <div class="contact-avatar">${escapeHtml(initial)}</div>
              <div>
                <div class="contact-name">${escapeHtml(name)}</div>
                <div class="contact-id">${escapeHtml(c.crow_id || "")}</div>
              </div>
            </div>
            <button class="call-btn" data-contact="${escapeHtml(c.display_name || c.crow_id || c.id)}">
              Call
            </button>
          </div>`;
      }).join("") + '</div>'
  }
</div>
<script>
(function() {
  var buttons = document.querySelectorAll(".call-btn");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function() {
      var contact = this.getAttribute("data-contact");
      this.disabled = true;
      this.textContent = "Creating...";
      var btn = this;
      fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact, hostName: "Host" }),
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.callUrl) {
            window.open(data.callUrl, "_blank");
          }
          btn.disabled = false;
          btn.textContent = "Call";
        })
        .catch(function() {
          btn.disabled = false;
          btn.textContent = "Call";
        });
    });
  }
})();
</script>`;

    return layout({
      title: "Calls",
      content,
    });
  },
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
