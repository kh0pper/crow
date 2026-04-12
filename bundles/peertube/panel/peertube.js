/**
 * Crow's Nest Panel — PeerTube: instance status + recent videos + transcoding queue.
 * XSS-safe (textContent / createElement only).
 */

export default {
  id: "peertube",
  name: "PeerTube",
  icon: "phone-video",
  route: "/dashboard/peertube",
  navOrder: 78,
  category: "federated-media",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="pt-panel">
        <h1>PeerTube <span class="pt-subtitle">federated video platform</span></h1>

        <div class="pt-section">
          <h3>Status</h3>
          <div id="pt-status" class="pt-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="pt-section">
          <h3>Recent Local Videos</h3>
          <div id="pt-videos" class="pt-videos"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="pt-section pt-notes">
          <h3>Notes</h3>
          <ul>
            <li>Video transcoding is RAM-hot (3-5 GB per concurrent upload). Keep <code>PEERTUBE_TRANSCODING_CONCURRENCY</code> low unless this host has headroom.</li>
            <li>Storage is unbounded without S3 — enable it via <code>PEERTUBE_S3_*</code> before publishing anything meaningful.</li>
            <li>Hosting copyrighted video is a legal fast-track to defederation and takedown notices.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "PeerTube", content }));
  },
};

function script() {
  return `
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function row(label, value) {
      const r = document.createElement('div'); r.className = 'pt-row';
      const b = document.createElement('b'); b.textContent = label;
      const s = document.createElement('span'); s.textContent = value == null ? '—' : String(value);
      r.appendChild(b); r.appendChild(s); return r;
    }
    function err(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }
    function fmtDur(s) {
      if (s == null) return '—';
      const m = Math.floor(s / 60); const sec = s % 60;
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    async function loadStatus() {
      const el = document.getElementById('pt-status'); clear(el);
      try {
        const res = await fetch('/api/peertube/status'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        const card = document.createElement('div'); card.className = 'pt-card';
        card.appendChild(row('Instance', d.instance_name || d.hostname || '(unset)'));
        card.appendChild(row('Version', d.version || '—'));
        card.appendChild(row('Local videos', d.stats?.videos ?? '—'));
        card.appendChild(row('Video views', d.stats?.video_views ?? '—'));
        card.appendChild(row('Federated peers', d.stats?.instance_following ?? '—'));
        card.appendChild(row('Transcoding', d.transcoding_enabled ? 'enabled' : 'disabled'));
        card.appendChild(row('Object storage', d.object_storage?.enabled ? 'S3 enabled' : 'on-disk'));
        card.appendChild(row('Signup', d.signup_enabled ? 'open' : 'closed'));
        card.appendChild(row('Authenticated', d.authenticated_as ? d.authenticated_as.username + ' (' + (d.authenticated_as.role || '') + ')' : '(no token)'));
        el.appendChild(card);
      } catch (e) { el.appendChild(err('Cannot reach PeerTube.')); }
    }

    async function loadVideos() {
      const el = document.getElementById('pt-videos'); clear(el);
      try {
        const res = await fetch('/api/peertube/videos'); const d = await res.json();
        if (d.error) { el.appendChild(err(d.error)); return; }
        if (!d.videos || d.videos.length === 0) {
          const i = document.createElement('div'); i.className = 'np-idle';
          i.textContent = 'No local videos yet. Upload via pt_upload_video or the web UI.';
          el.appendChild(i); return;
        }
        for (const v of d.videos) {
          const c = document.createElement('div'); c.className = 'pt-video';
          const t = document.createElement('b'); t.textContent = v.name;
          c.appendChild(t);
          const meta = document.createElement('div'); meta.className = 'pt-video-meta';
          meta.textContent = (v.channel || '?') + ' · ' + fmtDur(v.duration_seconds) + ' · ' + (v.views || 0) + ' views · ' + (v.likes || 0) + ' likes';
          c.appendChild(meta);
          el.appendChild(c);
        }
      } catch (e) { el.appendChild(err('Cannot load videos: ' + e.message)); }
    }

    loadStatus();
    loadVideos();
  `;
}

function styles() {
  return `
    .pt-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .pt-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .pt-section { margin-bottom: 1.8rem; }
    .pt-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .pt-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; }
    .pt-row { display: flex; justify-content: space-between; padding: .25rem 0; font-size: .9rem; color: var(--crow-text-primary); }
    .pt-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 160px; }
    .pt-video { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                border-radius: 8px; padding: .6rem .9rem; margin-bottom: .4rem; }
    .pt-video b { color: var(--crow-text-primary); font-size: .9rem; }
    .pt-video-meta { font-size: .75rem; color: var(--crow-text-muted); margin-top: .2rem; }
    .pt-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .pt-notes li { margin-bottom: .3rem; }
    .pt-notes code { font-family: ui-monospace, monospace; background: var(--crow-bg);
                     padding: 1px 4px; border-radius: 3px; font-size: .8em; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
