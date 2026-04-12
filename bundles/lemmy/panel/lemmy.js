/**
 * Crow's Nest Panel — Lemmy: instance status + subscribed communities + hot posts.
 * XSS-safe (textContent / createElement only).
 */

export default {
  id: "lemmy",
  name: "Lemmy",
  icon: "message-circle",
  route: "/dashboard/lemmy",
  navOrder: 76,
  category: "federated-social",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="lm-panel">
        <h1>Lemmy <span class="lm-subtitle">federated link aggregator</span></h1>

        <div class="lm-section">
          <h3>Status</h3>
          <div id="lm-status" class="lm-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="lm-section">
          <h3>Local Communities</h3>
          <div id="lm-communities" class="lm-communities"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="lm-section">
          <h3>Hot Posts (local)</h3>
          <div id="lm-posts" class="lm-posts"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="lm-section lm-notes">
          <h3>Notes</h3>
          <ul>
            <li>Lemmy federation is community-scoped. A single large federated community can pull heavy content; monitor disk.</li>
            <li>Moderation reports from all federated instances land in your admin queue. Review regularly.</li>
            <li>pict-rs cache grows with federated image content. Tune retention via <code>lemmy_media_prune</code>.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "Lemmy", content }));
  },
};

function script() {
  return `
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function row(label, value) {
      const r = document.createElement('div'); r.className = 'lm-row';
      const b = document.createElement('b'); b.textContent = label;
      const s = document.createElement('span'); s.textContent = value == null ? '—' : String(value);
      r.appendChild(b); r.appendChild(s); return r;
    }
    function err(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }

    async function loadStatus() {
      const el = document.getElementById('lm-status'); clear(el);
      try {
        const res = await fetch('/api/lemmy/status'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        const card = document.createElement('div'); card.className = 'lm-card';
        card.appendChild(row('Site name', d.site_name || '(unset)'));
        card.appendChild(row('Hostname', d.hostname || '—'));
        card.appendChild(row('Version', d.version || '—'));
        card.appendChild(row('Users', d.users ?? '—'));
        card.appendChild(row('Posts', d.posts ?? '—'));
        card.appendChild(row('Communities', d.communities ?? '—'));
        card.appendChild(row('Federation', d.federation_enabled ? 'enabled' : 'disabled'));
        card.appendChild(row('Registration', d.registration_mode || '—'));
        card.appendChild(row('Authenticated', d.my_user || '(no JWT)'));
        el.appendChild(card);
      } catch (e) { el.appendChild(err('Cannot reach Lemmy.')); }
    }

    async function loadCommunities() {
      const el = document.getElementById('lm-communities'); clear(el);
      try {
        const res = await fetch('/api/lemmy/communities'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.communities || d.communities.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No local communities yet. Create one in the web UI.';
          el.appendChild(i); return;
        }
        for (const c of d.communities) {
          const li = document.createElement('div'); li.className = 'lm-community';
          const t = document.createElement('b'); t.textContent = c.title || c.name;
          li.appendChild(t);
          const meta = document.createElement('div'); meta.className = 'lm-community-meta';
          meta.textContent = '!' + c.name + ' · ' + (c.subscribers || 0) + ' subs · ' + (c.posts || 0) + ' posts';
          li.appendChild(meta);
          el.appendChild(li);
        }
      } catch (e) { el.appendChild(err('Cannot load communities: ' + e.message)); }
    }

    async function loadPosts() {
      const el = document.getElementById('lm-posts'); clear(el);
      try {
        const res = await fetch('/api/lemmy/posts'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.posts || d.posts.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No posts yet.';
          el.appendChild(i); return;
        }
        for (const p of d.posts) {
          const c = document.createElement('div'); c.className = 'lm-post';
          const t = document.createElement('b'); t.textContent = p.name;
          c.appendChild(t);
          const meta = document.createElement('div'); meta.className = 'lm-post-meta';
          meta.textContent = '!' + (p.community || '?') + ' · ' + (p.score || 0) + ' pts · ' + (p.comments || 0) + ' comments · ' + (p.creator || '?');
          c.appendChild(meta);
          el.appendChild(c);
        }
      } catch (e) { el.appendChild(err('Cannot load posts: ' + e.message)); }
    }

    loadStatus();
    loadCommunities();
    loadPosts();
  `;
}

function styles() {
  return `
    .lm-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .lm-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .lm-section { margin-bottom: 1.8rem; }
    .lm-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .lm-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; }
    .lm-row { display: flex; justify-content: space-between; padding: .25rem 0; font-size: .9rem; color: var(--crow-text-primary); }
    .lm-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 160px; }
    .lm-community, .lm-post { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                               border-radius: 8px; padding: .6rem .9rem; margin-bottom: .4rem; }
    .lm-community b, .lm-post b { color: var(--crow-text-primary); font-size: .9rem; }
    .lm-community-meta, .lm-post-meta { font-size: .75rem; color: var(--crow-text-muted); margin-top: .2rem; font-family: ui-monospace, monospace; }
    .lm-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .lm-notes li { margin-bottom: .3rem; }
    .lm-notes code { font-family: ui-monospace, monospace; background: var(--crow-bg);
                     padding: 1px 4px; border-radius: 3px; font-size: .8em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
