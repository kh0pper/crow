/**
 * Crow's Nest Panel — GoToSocial: status + recent timeline preview
 *
 * Read-only view. Moderation queue confirmation UI lands with F.11/F.12;
 * until then the operator confirms queued actions via direct DB edits or
 * a follow-up panel enhancement.
 *
 * XSS-safe: textContent / createElement only.
 */

export default {
  id: "gotosocial",
  name: "GoToSocial",
  icon: "globe",
  route: "/dashboard/gotosocial",
  navOrder: 70,
  category: "federated-social",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="gts-panel">
        <h1>GoToSocial <span class="gts-subtitle">fediverse microblog</span></h1>

        <div class="gts-section">
          <h3>Status</h3>
          <div id="gts-status" class="gts-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="gts-section">
          <h3>Recent Timeline</h3>
          <div class="gts-toggle">
            <button id="gts-tl-public" type="button" class="gts-tab-active">Public</button>
            <button id="gts-tl-home" type="button">Home</button>
          </div>
          <div id="gts-timeline" class="gts-timeline"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="gts-section gts-notes">
          <h3>Notes</h3>
          <ul>
            <li>Moderation actions (defederate, block_domain, import_blocklist) queue pending rows in <code>moderation_actions</code>. Operator confirmation UI lands in a later release.</li>
            <li>Remote media cache prunes daily via <code>scripts/media-prune.sh</code>. Override retention via <code>GTS_MEDIA_RETENTION_DAYS</code>.</li>
            <li>Exposed via Caddy. Verify TLS with <code>caddy_cert_health</code>.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "GoToSocial", content }));
  },
};

function script() {
  return `
    function clearNode(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function row(label, value) {
      const r = document.createElement('div');
      r.className = 'gts-row';
      const b = document.createElement('b');
      b.textContent = label;
      r.appendChild(b);
      const s = document.createElement('span');
      s.textContent = value == null ? '—' : String(value);
      r.appendChild(s);
      return r;
    }
    function errorNode(msg) {
      const d = document.createElement('div');
      d.className = 'np-error';
      d.textContent = msg;
      return d;
    }

    async function loadStatus() {
      const el = document.getElementById('gts-status');
      clearNode(el);
      try {
        const res = await fetch('/api/gotosocial/status');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const card = document.createElement('div');
        card.className = 'gts-card';
        card.appendChild(row('Instance', d.uri));
        card.appendChild(row('Title', d.title));
        card.appendChild(row('Version', d.version));
        card.appendChild(row('Users', d.stats?.user_count));
        card.appendChild(row('Statuses', d.stats?.status_count));
        card.appendChild(row('Federated peers', d.federated_peers));
        card.appendChild(row('Authenticated as', d.account ? '@' + d.account.acct : '(none — set GTS_ACCESS_TOKEN)'));
        el.appendChild(card);
      } catch (e) {
        el.appendChild(errorNode('Cannot reach GoToSocial API.'));
      }
    }

    async function loadTimeline(source) {
      const el = document.getElementById('gts-timeline');
      clearNode(el);
      try {
        const res = await fetch('/api/gotosocial/timeline?source=' + encodeURIComponent(source) + '&limit=10');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        if (!d.items || d.items.length === 0) {
          const e = document.createElement('div');
          e.className = 'np-idle';
          e.textContent = 'Timeline is empty.';
          el.appendChild(e);
          return;
        }
        for (const it of d.items) {
          const card = document.createElement('div');
          card.className = 'gts-toot';
          const head = document.createElement('div');
          head.className = 'gts-toot-head';
          const author = document.createElement('b');
          author.textContent = '@' + (it.acct || 'unknown');
          head.appendChild(author);
          const when = document.createElement('span');
          when.className = 'gts-toot-when';
          when.textContent = new Date(it.created_at).toLocaleString();
          head.appendChild(when);
          card.appendChild(head);
          const body = document.createElement('div');
          body.className = 'gts-toot-body';
          body.textContent = it.content_excerpt || '';
          card.appendChild(body);
          const meta = document.createElement('div');
          meta.className = 'gts-toot-meta';
          meta.textContent = 'reblogs ' + (it.reblogs || 0) + '  \u2022  favs ' + (it.favs || 0);
          card.appendChild(meta);
          el.appendChild(card);
        }
      } catch (e) {
        el.appendChild(errorNode('Cannot load timeline: ' + e.message));
      }
    }

    document.getElementById('gts-tl-public').addEventListener('click', function () {
      document.getElementById('gts-tl-public').className = 'gts-tab-active';
      document.getElementById('gts-tl-home').className = '';
      loadTimeline('public');
    });
    document.getElementById('gts-tl-home').addEventListener('click', function () {
      document.getElementById('gts-tl-home').className = 'gts-tab-active';
      document.getElementById('gts-tl-public').className = '';
      loadTimeline('home');
    });
    loadStatus();
    loadTimeline('public');
  `;
}

function styles() {
  return `
    .gts-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .gts-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .gts-section { margin-bottom: 1.8rem; }
    .gts-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                      letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .gts-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                border-radius: 10px; padding: 1rem; }
    .gts-row { display: flex; justify-content: space-between; gap: 1rem; padding: .25rem 0;
               font-size: .9rem; color: var(--crow-text-primary); }
    .gts-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 140px; }
    .gts-toggle { display: flex; gap: .4rem; margin-bottom: .7rem; }
    .gts-toggle button { background: var(--crow-bg-elevated); color: var(--crow-text-muted);
                         border: 1px solid var(--crow-border); border-radius: 6px;
                         padding: .3rem .7rem; font-size: .85rem; cursor: pointer; }
    .gts-tab-active { background: var(--crow-accent) !important; color: #0b0d10 !important;
                      border-color: var(--crow-accent) !important; }
    .gts-toot { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                border-radius: 10px; padding: .8rem 1rem; margin-bottom: .5rem; }
    .gts-toot-head { display: flex; justify-content: space-between; margin-bottom: .3rem; }
    .gts-toot-head b { font-size: .9rem; color: var(--crow-text-primary); }
    .gts-toot-when { font-size: .75rem; color: var(--crow-text-muted); font-family: ui-monospace, monospace; }
    .gts-toot-body { font-size: .9rem; color: var(--crow-text-primary); line-height: 1.4; }
    .gts-toot-meta { font-size: .75rem; color: var(--crow-text-muted); margin-top: .4rem; }
    .gts-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .gts-notes li { margin-bottom: .3rem; }
    .gts-notes code { font-family: ui-monospace, monospace; background: var(--crow-bg);
                      padding: 1px 4px; border-radius: 3px; font-size: .8em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: var(--crow-error, #ef4444); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
