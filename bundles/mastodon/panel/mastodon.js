/**
 * Crow's Nest Panel — Mastodon: instance status + home timeline + peer count.
 * XSS-safe (textContent / createElement only).
 */

export default {
  id: "mastodon",
  name: "Mastodon",
  icon: "globe",
  route: "/dashboard/mastodon",
  navOrder: 77,
  category: "federated-social",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="md-panel">
        <h1>Mastodon <span class="md-subtitle">flagship federated microblog</span></h1>

        <div class="md-section">
          <h3>Status</h3>
          <div id="md-status" class="md-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="md-section">
          <h3>Recent (home timeline)</h3>
          <div id="md-feed" class="md-feed"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="md-section md-notes">
          <h3>Notes</h3>
          <ul>
            <li>LOCAL_DOMAIN is immutable — changing it after first boot abandons federation identity.</li>
            <li>Remote media cache can reach 10-100 GB within weeks. Sidekiq runs a scheduled prune at <code>MEDIA_CACHE_RETENTION_PERIOD</code>.</li>
            <li>Admin tools need the OAuth token to carry <code>admin:read</code> + <code>admin:write</code> scopes.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "Mastodon", content }));
  },
};

function script() {
  return `
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function row(label, value) {
      const r = document.createElement('div'); r.className = 'md-row';
      const b = document.createElement('b'); b.textContent = label;
      const s = document.createElement('span'); s.textContent = value == null ? '—' : String(value);
      r.appendChild(b); r.appendChild(s); return r;
    }
    function err(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }

    async function loadStatus() {
      const el = document.getElementById('md-status'); clear(el);
      try {
        const res = await fetch('/api/mastodon/status'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        const card = document.createElement('div'); card.className = 'md-card';
        card.appendChild(row('Domain', d.local_domain || d.title || '(unset)'));
        card.appendChild(row('Version', d.version || '—'));
        card.appendChild(row('Users', d.users ?? '—'));
        card.appendChild(row('Statuses', d.statuses ?? '—'));
        card.appendChild(row('Known domains', d.domains ?? '—'));
        card.appendChild(row('Federated peers', d.federated_peers ?? '—'));
        card.appendChild(row('Registrations', d.registrations_open ? 'open' : 'closed'));
        card.appendChild(row('Authenticated', d.authenticated_as ? d.authenticated_as.acct : '(no token)'));
        el.appendChild(card);
      } catch (e) { el.appendChild(err('Cannot reach Mastodon.')); }
    }

    async function loadFeed() {
      const el = document.getElementById('md-feed'); clear(el);
      try {
        const res = await fetch('/api/mastodon/feed'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.items || d.items.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No recent posts. Follow some accounts to populate the home timeline.';
          el.appendChild(i); return;
        }
        for (const p of d.items) {
          const c = document.createElement('div'); c.className = 'md-post';
          const h = document.createElement('div'); h.className = 'md-post-head';
          const who = document.createElement('b'); who.textContent = '@' + (p.acct || 'unknown');
          h.appendChild(who);
          if (p.media_count > 0) {
            const m = document.createElement('span'); m.className = 'md-badge';
            m.textContent = p.media_count + ' media';
            h.appendChild(m);
          }
          c.appendChild(h);
          if (p.content_excerpt) {
            const body = document.createElement('div'); body.className = 'md-post-body';
            body.textContent = p.content_excerpt;
            c.appendChild(body);
          }
          const meta = document.createElement('div'); meta.className = 'md-post-meta';
          meta.textContent = (p.favs || 0) + ' favs · ' + (p.replies || 0) + ' replies · ' + (p.reblogs || 0) + ' boosts · ' + (p.visibility || 'public');
          c.appendChild(meta);
          el.appendChild(c);
        }
      } catch (e) { el.appendChild(err('Cannot load feed: ' + e.message)); }
    }

    loadStatus();
    loadFeed();
  `;
}

function styles() {
  return `
    .md-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .md-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .md-section { margin-bottom: 1.8rem; }
    .md-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .md-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; }
    .md-row { display: flex; justify-content: space-between; padding: .25rem 0; font-size: .9rem; color: var(--crow-text-primary); }
    .md-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 160px; }
    .md-post { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 8px; padding: .6rem .9rem; margin-bottom: .4rem; }
    .md-post-head { display: flex; gap: .5rem; align-items: baseline; }
    .md-post-head b { color: var(--crow-text-primary); font-size: .9rem; }
    .md-badge { font-size: .7rem; color: var(--crow-accent);
                background: var(--crow-bg); padding: 1px 6px; border-radius: 10px; }
    .md-post-body { font-size: .85rem; color: var(--crow-text-secondary); margin-top: .2rem; }
    .md-post-meta { font-size: .75rem; color: var(--crow-text-muted); margin-top: .3rem; }
    .md-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .md-notes li { margin-bottom: .3rem; }
    .md-notes code { font-family: ui-monospace, monospace; background: var(--crow-bg);
                     padding: 1px 4px; border-radius: 3px; font-size: .8em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
