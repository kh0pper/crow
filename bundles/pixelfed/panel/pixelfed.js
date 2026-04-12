/**
 * Crow's Nest Panel — Pixelfed: instance status + recent posts + federation peers.
 * XSS-safe (textContent / createElement only).
 */

export default {
  id: "pixelfed",
  name: "Pixelfed",
  icon: "image",
  route: "/dashboard/pixelfed",
  navOrder: 75,
  category: "federated-media",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="pf-panel">
        <h1>Pixelfed <span class="pf-subtitle">federated photo server</span></h1>

        <div class="pf-section">
          <h3>Status</h3>
          <div id="pf-status" class="pf-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="pf-section">
          <h3>Recent Posts (home timeline)</h3>
          <div id="pf-feed" class="pf-feed"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="pf-section pf-notes">
          <h3>Notes</h3>
          <ul>
            <li>Moderation is non-optional on a federated photo server. Configure an IFTAS or Bad Space blocklist before opening registration.</li>
            <li>Remote media cache prunes on a horizon schedule (<code>PIXELFED_MEDIA_RETENTION_DAYS</code>). Force a prune with <code>pf_media_prune</code>.</li>
            <li>Uploading copyrighted or illegal imagery is your legal responsibility.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "Pixelfed", content }));
  },
};

function script() {
  return `
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function row(label, value) {
      const r = document.createElement('div'); r.className = 'pf-row';
      const b = document.createElement('b'); b.textContent = label;
      const s = document.createElement('span'); s.textContent = value == null ? '—' : String(value);
      r.appendChild(b); r.appendChild(s); return r;
    }
    function err(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }

    async function loadStatus() {
      const el = document.getElementById('pf-status'); clear(el);
      try {
        const res = await fetch('/api/pixelfed/status'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        const card = document.createElement('div'); card.className = 'pf-card';
        card.appendChild(row('Instance', d.instance?.uri || d.hostname || '(unset)'));
        card.appendChild(row('Title', d.instance?.title || '—'));
        card.appendChild(row('Version', d.instance?.version || '—'));
        card.appendChild(row('Users', d.instance?.stats?.user_count ?? '—'));
        card.appendChild(row('Posts', d.instance?.stats?.status_count ?? '—'));
        card.appendChild(row('Federated peers', d.federated_peers ?? '—'));
        card.appendChild(row('Authenticated', d.authenticated_as ? d.authenticated_as.acct : '(no token)'));
        el.appendChild(card);
      } catch (e) { el.appendChild(err('Cannot reach Pixelfed.')); }
    }

    async function loadFeed() {
      const el = document.getElementById('pf-feed'); clear(el);
      try {
        const res = await fetch('/api/pixelfed/feed'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.items || d.items.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No recent posts. Follow some accounts to populate the home timeline.';
          el.appendChild(i); return;
        }
        for (const p of d.items) {
          const c = document.createElement('div'); c.className = 'pf-post';
          const h = document.createElement('div'); h.className = 'pf-post-head';
          const who = document.createElement('b'); who.textContent = '@' + (p.acct || 'unknown');
          h.appendChild(who);
          if (p.media_count > 0) {
            const m = document.createElement('span'); m.className = 'pf-badge';
            m.textContent = p.media_count + ' photo' + (p.media_count === 1 ? '' : 's');
            h.appendChild(m);
          }
          c.appendChild(h);
          if (p.content_excerpt) {
            const body = document.createElement('div'); body.className = 'pf-post-body';
            body.textContent = p.content_excerpt;
            c.appendChild(body);
          }
          const meta = document.createElement('div'); meta.className = 'pf-post-meta';
          meta.textContent = (p.favs || 0) + ' likes · ' + (p.replies || 0) + ' replies · ' + (p.visibility || 'public');
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
    .pf-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .pf-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .pf-section { margin-bottom: 1.8rem; }
    .pf-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .pf-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; }
    .pf-row { display: flex; justify-content: space-between; padding: .25rem 0; font-size: .9rem; color: var(--crow-text-primary); }
    .pf-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 160px; }
    .pf-post { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 8px; padding: .6rem .9rem; margin-bottom: .4rem; }
    .pf-post-head { display: flex; gap: .5rem; align-items: baseline; }
    .pf-post-head b { color: var(--crow-text-primary); font-size: .9rem; }
    .pf-badge { font-size: .7rem; color: var(--crow-accent);
                background: var(--crow-bg); padding: 1px 6px; border-radius: 10px; }
    .pf-post-body { font-size: .85rem; color: var(--crow-text-secondary); margin-top: .2rem; }
    .pf-post-meta { font-size: .75rem; color: var(--crow-text-muted); margin-top: .3rem; }
    .pf-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .pf-notes li { margin-bottom: .3rem; }
    .pf-notes code { font-family: ui-monospace, monospace; background: var(--crow-bg);
                     padding: 1px 4px; border-radius: 3px; font-size: .8em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
