/**
 * Crow's Nest Panel — Funkwhale: pod status + libraries + recent listens.
 * XSS-safe (textContent / createElement only).
 */

export default {
  id: "funkwhale",
  name: "Funkwhale",
  icon: "music",
  route: "/dashboard/funkwhale",
  navOrder: 74,
  category: "federated-media",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="fw-panel">
        <h1>Funkwhale <span class="fw-subtitle">federated music pod</span></h1>

        <div class="fw-section">
          <h3>Status</h3>
          <div id="fw-status" class="fw-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="fw-section">
          <h3>Libraries</h3>
          <div id="fw-libs" class="fw-libs"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="fw-section">
          <h3>Recent Listens</h3>
          <div id="fw-listens" class="fw-listens"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="fw-section fw-notes">
          <h3>Notes</h3>
          <ul>
            <li>Federation is over ActivityPub — your channels appear to remote Mastodon/Pixelfed followers as regular fediverse actors.</li>
            <li>Uploading copyrighted material you don't own is your legal responsibility. Major hubs may defederate pods known for piracy.</li>
            <li>Cache growth: federated audio caches prune on a celerybeat schedule (default 14 days). Manual: <code>fw_media_prune</code>.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "Funkwhale", content }));
  },
};

function script() {
  return `
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function row(label, value) {
      const r = document.createElement('div'); r.className = 'fw-row';
      const b = document.createElement('b'); b.textContent = label;
      const s = document.createElement('span'); s.textContent = value == null ? '—' : String(value);
      r.appendChild(b); r.appendChild(s); return r;
    }
    function err(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }

    async function loadStatus() {
      const el = document.getElementById('fw-status'); clear(el);
      try {
        const res = await fetch('/api/funkwhale/status'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        const card = document.createElement('div'); card.className = 'fw-card';
        card.appendChild(row('Hostname', d.hostname || '(unset)'));
        card.appendChild(row('Software', (d.software || 'funkwhale') + ' ' + (d.version || '?')));
        card.appendChild(row('Federation', d.federation_enabled ? 'enabled' : 'disabled'));
        card.appendChild(row('Users', d.usage_users?.total ?? '—'));
        card.appendChild(row('Authenticated', d.whoami ? d.whoami.username + (d.whoami.is_superuser ? ' (admin)' : '') : '(no token)'));
        el.appendChild(card);
      } catch (e) { el.appendChild(err('Cannot reach Funkwhale.')); }
    }

    async function loadLibraries() {
      const el = document.getElementById('fw-libs'); clear(el);
      try {
        const res = await fetch('/api/funkwhale/libraries'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.libraries || d.libraries.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No owned libraries yet. Create one in Settings → Content → Libraries.';
          el.appendChild(i); return;
        }
        for (const l of d.libraries) {
          const c = document.createElement('div'); c.className = 'fw-lib';
          const t = document.createElement('b'); t.textContent = l.name || '(unnamed)';
          c.appendChild(t);
          const meta = document.createElement('div'); meta.className = 'fw-lib-meta';
          meta.textContent = (l.uploads_count || 0) + ' tracks · ' + (l.privacy_level || 'private');
          c.appendChild(meta);
          el.appendChild(c);
        }
      } catch (e) { el.appendChild(err('Cannot load libraries: ' + e.message)); }
    }

    async function loadListens() {
      const el = document.getElementById('fw-listens'); clear(el);
      try {
        const res = await fetch('/api/funkwhale/listens'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.listens || d.listens.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No recent listens.';
          el.appendChild(i); return;
        }
        for (const l of d.listens) {
          const c = document.createElement('div'); c.className = 'fw-listen';
          const t = document.createElement('b'); t.textContent = l.track_title || '(unknown)';
          c.appendChild(t);
          const meta = document.createElement('div'); meta.className = 'fw-listen-meta';
          meta.textContent = (l.artist || 'unknown artist') + (l.album ? ' — ' + l.album : '');
          c.appendChild(meta);
          el.appendChild(c);
        }
      } catch (e) { el.appendChild(err('Cannot load listens: ' + e.message)); }
    }

    loadStatus();
    loadLibraries();
    loadListens();
  `;
}

function styles() {
  return `
    .fw-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .fw-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .fw-section { margin-bottom: 1.8rem; }
    .fw-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .fw-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; }
    .fw-row { display: flex; justify-content: space-between; padding: .25rem 0; font-size: .9rem; color: var(--crow-text-primary); }
    .fw-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 160px; }
    .fw-lib, .fw-listen { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                          border-radius: 8px; padding: .6rem .9rem; margin-bottom: .4rem; }
    .fw-lib b, .fw-listen b { color: var(--crow-text-primary); font-size: .9rem; }
    .fw-lib-meta, .fw-listen-meta { font-size: .8rem; color: var(--crow-text-muted); margin-top: .2rem; }
    .fw-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .fw-notes li { margin-bottom: .3rem; }
    .fw-notes code { font-family: ui-monospace, monospace; background: var(--crow-bg);
                     padding: 1px 4px; border-radius: 3px; font-size: .8em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
