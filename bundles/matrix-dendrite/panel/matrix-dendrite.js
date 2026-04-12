/**
 * Crow's Nest Panel — Matrix-Dendrite: status + rooms + federation health.
 * XSS-safe (textContent + createElement only).
 */

export default {
  id: "matrix-dendrite",
  name: "Matrix (Dendrite)",
  icon: "message-circle",
  route: "/dashboard/matrix-dendrite",
  navOrder: 72,
  category: "federated-comms",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="mx-panel">
        <h1>Matrix <span class="mx-subtitle">Dendrite homeserver</span></h1>

        <div class="mx-section">
          <h3>Status</h3>
          <div id="mx-status" class="mx-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="mx-section">
          <h3>Federation Health</h3>
          <div id="mx-fed" class="mx-fed"><div class="np-loading">Checking…</div></div>
        </div>

        <div class="mx-section">
          <h3>Joined Rooms</h3>
          <div id="mx-rooms" class="mx-rooms"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="mx-section mx-notes">
          <h3>Notes</h3>
          <ul>
            <li>Federation needs either port 8448 forwarded OR .well-known/matrix/server delegation on the apex. <code>matrix_federation_health</code> surfaces both paths.</li>
            <li>Message posting via MCP sends plaintext. E2EE rooms need a real Matrix client (Element) that holds device keys.</li>
            <li>Backup includes the signing key — loss = identity loss, leak = impersonation. Encrypt the archive.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "Matrix", content }));
  },
};

function script() {
  return `
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function row(label, value) {
      const r = document.createElement('div'); r.className = 'mx-row';
      const b = document.createElement('b'); b.textContent = label;
      const s = document.createElement('span'); s.textContent = value == null ? '—' : String(value);
      r.appendChild(b); r.appendChild(s); return r;
    }
    function err(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }

    async function loadStatus() {
      const el = document.getElementById('mx-status'); clear(el);
      try {
        const res = await fetch('/api/matrix-dendrite/status'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        const card = document.createElement('div'); card.className = 'mx-card';
        card.appendChild(row('Server name', d.server_name || '(unset)'));
        card.appendChild(row('Internal URL', d.url));
        card.appendChild(row('Client-server API versions', (d.versions || []).join(', ') || '—'));
        card.appendChild(row('Authenticated', d.whoami?.user_id || (d.has_token ? '(token set but whoami failed)' : '(no token)')));
        el.appendChild(card);
      } catch (e) { el.appendChild(err('Cannot reach Dendrite.')); }
    }

    async function loadFederation() {
      const el = document.getElementById('mx-fed'); clear(el);
      try {
        const res = await fetch('/api/matrix-dendrite/federation-health'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        const card = document.createElement('div'); card.className = 'mx-card';
        const badge = document.createElement('span');
        badge.className = 'mx-fed-badge ' + (d.federation_ok ? 'mx-fed-ok' : 'mx-fed-bad');
        badge.textContent = d.federation_ok ? 'FEDERATION OK' : 'FEDERATION ISSUES';
        card.appendChild(badge);
        card.appendChild(row('Server name', d.server_name));
        card.appendChild(row('.well-known m.server', d.well_known || '(none — using :8448 direct)'));
        if (d.errors && d.errors.length) {
          const eh = document.createElement('div'); eh.className = 'mx-errors-head'; eh.textContent = 'Errors:';
          card.appendChild(eh);
          for (const er of d.errors) {
            const li = document.createElement('div'); li.className = 'mx-err-item';
            li.textContent = typeof er === 'string' ? er : JSON.stringify(er);
            card.appendChild(li);
          }
        }
        if (d.warnings && d.warnings.length) {
          const wh = document.createElement('div'); wh.className = 'mx-warn-head'; wh.textContent = 'Warnings:';
          card.appendChild(wh);
          for (const w of d.warnings) {
            const li = document.createElement('div'); li.className = 'mx-warn-item';
            li.textContent = typeof w === 'string' ? w : JSON.stringify(w);
            card.appendChild(li);
          }
        }
        el.appendChild(card);
      } catch (e) { el.appendChild(err('Federation tester failed: ' + e.message)); }
    }

    async function loadRooms() {
      const el = document.getElementById('mx-rooms'); clear(el);
      try {
        const res = await fetch('/api/matrix-dendrite/rooms'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.rooms || d.rooms.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No joined rooms yet. Try matrix_join_room { room: "#matrix:matrix.org" }.';
          el.appendChild(i); return;
        }
        for (const r of d.rooms) {
          const c = document.createElement('div'); c.className = 'mx-room';
          const h = document.createElement('div'); h.className = 'mx-room-head';
          const t = document.createElement('b'); t.textContent = r.name || r.alias || '(unnamed)';
          h.appendChild(t);
          if (r.alias && r.alias !== (r.name || '')) {
            const a = document.createElement('span'); a.className = 'mx-room-alias'; a.textContent = r.alias;
            h.appendChild(a);
          }
          c.appendChild(h);
          const id = document.createElement('div'); id.className = 'mx-room-id'; id.textContent = r.room_id;
          c.appendChild(id);
          el.appendChild(c);
        }
        if (d.count > d.rooms.length) {
          const more = document.createElement('div'); more.className = 'mx-more';
          more.textContent = 'Showing ' + d.rooms.length + ' of ' + d.count + ' rooms.';
          el.appendChild(more);
        }
      } catch (e) { el.appendChild(err('Cannot load rooms: ' + e.message)); }
    }

    loadStatus();
    loadFederation();
    loadRooms();
  `;
}

function styles() {
  return `
    .mx-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .mx-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .mx-section { margin-bottom: 1.8rem; }
    .mx-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .mx-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; }
    .mx-row { display: flex; justify-content: space-between; padding: .25rem 0; font-size: .9rem; color: var(--crow-text-primary); }
    .mx-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 160px; }
    .mx-fed-badge { display: inline-block; font-size: .8rem; font-weight: 600; padding: .3rem .6rem;
                    border-radius: 6px; letter-spacing: .05em; margin-bottom: .7rem; }
    .mx-fed-ok { background: rgba(34,197,94,.15); color: #22c55e; }
    .mx-fed-bad { background: rgba(239,68,68,.15); color: #ef4444; }
    .mx-errors-head, .mx-warn-head { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em;
                                     margin: .6rem 0 .2rem; color: var(--crow-text-muted); }
    .mx-err-item { font-size: .8rem; color: #ef4444; font-family: ui-monospace, monospace; padding: .15rem 0; }
    .mx-warn-item { font-size: .8rem; color: #eab308; font-family: ui-monospace, monospace; padding: .15rem 0; }
    .mx-room { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 8px; padding: .6rem .9rem; margin-bottom: .4rem; }
    .mx-room-head { display: flex; gap: .5rem; align-items: baseline; }
    .mx-room-head b { color: var(--crow-text-primary); font-size: .9rem; }
    .mx-room-alias { font-size: .8rem; color: var(--crow-accent); font-family: ui-monospace, monospace; }
    .mx-room-id { font-size: .7rem; color: var(--crow-text-muted); font-family: ui-monospace, monospace; margin-top: .2rem; }
    .mx-more { font-size: .8rem; color: var(--crow-text-muted); text-align: center; padding: .4rem 0; }
    .mx-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .mx-notes li { margin-bottom: .3rem; }
    .mx-notes code { font-family: ui-monospace, monospace; background: var(--crow-bg);
                     padding: 1px 4px; border-radius: 3px; font-size: .8em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
