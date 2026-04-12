/**
 * Crow's Nest Panel — WriteFreely: status + recent posts.
 * XSS-safe (textContent + createElement only).
 */

export default {
  id: "writefreely",
  name: "WriteFreely",
  icon: "file-text",
  route: "/dashboard/writefreely",
  navOrder: 71,
  category: "federated-social",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="wf-panel">
        <h1>WriteFreely <span class="wf-subtitle">federated blog</span></h1>

        <div class="wf-section">
          <h3>Status</h3>
          <div id="wf-status" class="wf-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="wf-section">
          <h3>Recent Posts</h3>
          <div id="wf-posts" class="wf-posts"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="wf-section wf-notes">
          <h3>Notes</h3>
          <ul>
            <li>WriteFreely has no comment system or likes. Engagement lives on the Mastodon / GoToSocial side.</li>
            <li>Posts not in a collection stay as private drafts. Publish via <code>wf_publish_post</code>.</li>
            <li>Actor signing keys live in <code>~/.crow/writefreely/</code>. Preserve via <code>scripts/backup.sh</code>.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "WriteFreely", content }));
  },
};

function script() {
  return `
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function row(label, value) {
      const r = document.createElement('div'); r.className = 'wf-row';
      const b = document.createElement('b'); b.textContent = label;
      const s = document.createElement('span'); s.textContent = value == null ? '—' : String(value);
      r.appendChild(b); r.appendChild(s); return r;
    }
    function err(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }

    async function loadStatus() {
      const el = document.getElementById('wf-status'); clear(el);
      try {
        const res = await fetch('/api/writefreely/status');
        const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        const card = document.createElement('div'); card.className = 'wf-card';
        card.appendChild(row('Instance', d.instance_url));
        card.appendChild(row('Authenticated', d.authenticated_as ? '@' + d.authenticated_as : '(no token — set WF_ACCESS_TOKEN)'));
        card.appendChild(row('Collections', d.collections.length));
        card.appendChild(row('Default collection', d.default_collection || '(none set)'));
        if (d.collections.length) {
          const list = document.createElement('div'); list.className = 'wf-coll-list';
          for (const c of d.collections) {
            const chip = document.createElement('div'); chip.className = 'wf-coll-chip';
            const al = document.createElement('b'); al.textContent = c.alias;
            const ti = document.createElement('span'); ti.className = 'wf-coll-title'; ti.textContent = c.title || '';
            const pc = document.createElement('span'); pc.className = 'wf-coll-count'; pc.textContent = (c.posts || 0) + ' posts';
            chip.appendChild(al); chip.appendChild(ti); chip.appendChild(pc);
            list.appendChild(chip);
          }
          card.appendChild(list);
        }
        el.appendChild(card);
      } catch (e) { el.appendChild(err('Cannot reach WriteFreely.')); }
    }

    async function loadPosts() {
      const el = document.getElementById('wf-posts'); clear(el);
      try {
        const res = await fetch('/api/writefreely/recent');
        const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.posts || d.posts.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No posts in ' + (d.collection || '(no collection)') + ' yet.';
          el.appendChild(i); return;
        }
        for (const p of d.posts) {
          const c = document.createElement('div'); c.className = 'wf-post';
          const h = document.createElement('div'); h.className = 'wf-post-head';
          const t = document.createElement('b'); t.textContent = p.title;
          h.appendChild(t);
          const when = document.createElement('span'); when.className = 'wf-post-when';
          when.textContent = new Date(p.created).toLocaleDateString();
          h.appendChild(when);
          c.appendChild(h);
          const m = document.createElement('div'); m.className = 'wf-post-meta';
          m.textContent = 'slug ' + p.slug + '  \u2022  views ' + (p.views || 0);
          c.appendChild(m);
          el.appendChild(c);
        }
      } catch (e) { el.appendChild(err('Cannot load posts: ' + e.message)); }
    }

    loadStatus();
    loadPosts();
  `;
}

function styles() {
  return `
    .wf-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .wf-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .wf-section { margin-bottom: 1.8rem; }
    .wf-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .wf-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; }
    .wf-row { display: flex; justify-content: space-between; padding: .25rem 0; font-size: .9rem; color: var(--crow-text-primary); }
    .wf-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 140px; }
    .wf-coll-list { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .6rem; }
    .wf-coll-chip { display: flex; align-items: center; gap: .5rem; background: var(--crow-bg);
                    border: 1px solid var(--crow-border); border-radius: 6px; padding: .3rem .6rem;
                    font-size: .85rem; }
    .wf-coll-chip b { color: var(--crow-accent); font-family: ui-monospace, monospace; }
    .wf-coll-title { color: var(--crow-text-primary); }
    .wf-coll-count { color: var(--crow-text-muted); font-size: .75rem; }
    .wf-post { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: .7rem 1rem; margin-bottom: .5rem; }
    .wf-post-head { display: flex; justify-content: space-between; margin-bottom: .2rem; }
    .wf-post-head b { color: var(--crow-text-primary); font-size: .9rem; }
    .wf-post-when { font-size: .75rem; color: var(--crow-text-muted); font-family: ui-monospace, monospace; }
    .wf-post-meta { font-size: .75rem; color: var(--crow-text-muted); }
    .wf-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .wf-notes li { margin-bottom: .3rem; }
    .wf-notes code { font-family: ui-monospace, monospace; background: var(--crow-bg);
                     padding: 1px 4px; border-radius: 3px; font-size: .8em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
