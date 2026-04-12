/**
 * Crow's Nest Panel — Caddy: list sites, add-site form, cert status
 *
 * Bundle-compatible: uses dynamic imports with appRoot so the panel works
 * both from the repo and when installed to ~/.crow/panels/.
 *
 * Client-side rendering uses textContent / createElement only (no innerHTML)
 * to match Crow's XSS-safe pattern (see jellyfin, kodi, iptv panels).
 */

export default {
  id: "caddy",
  name: "Caddy",
  icon: "shield",
  route: "/dashboard/caddy",
  navOrder: 62,
  category: "infrastructure",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const content = `
      <style>${styles()}</style>
      <div class="cd-panel">
        <h1>Caddy <span class="cd-subtitle">reverse proxy &middot; automatic HTTPS</span></h1>

        <div class="cd-section">
          <h3>Status</h3>
          <div id="cd-status" class="cd-status"><div class="np-loading">Loading status…</div></div>
        </div>

        <div class="cd-section">
          <h3>Certificate Health</h3>
          <div id="cd-certs" class="cd-certs"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="cd-section">
          <h3>Sites</h3>
          <div id="cd-sites" class="cd-sites"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="cd-section">
          <h3>Add Site</h3>
          <form id="cd-add" class="cd-form">
            <label>
              <span>Domain</span>
              <input type="text" name="domain" required maxlength="253" placeholder="example.com" autocomplete="off" />
            </label>
            <label>
              <span>Upstream</span>
              <input type="text" name="upstream" required maxlength="500" placeholder="localhost:3001" autocomplete="off" />
            </label>
            <button type="submit">Add Site</button>
            <div id="cd-add-msg" class="cd-msg"></div>
          </form>
        </div>

        <div class="cd-section cd-notes">
          <h3>Notes</h3>
          <ul>
            <li>Caddy requests a real Let's Encrypt certificate the first time a domain is requested. The domain's A/AAAA record must point to this host.</li>
            <li>Ports 80 and 443 must be open on the firewall/router. HTTP-01 uses port 80; TLS-ALPN-01 uses port 443.</li>
            <li>Hand-edits to ${escapeHtml("~/.crow/caddy/Caddyfile")} are preserved. Run "Reload" after editing.</li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;

    res.send(layout({ title: "Caddy", content }));
  },
};

function script() {
  // Intentionally uses textContent / createElement only. No template literals
  // interpolated into innerHTML. Hook-enforced XSS-safe pattern.
  return `
    function makeRow(label, value, extraClass) {
      const row = document.createElement('div');
      row.className = 'cd-row';
      const b = document.createElement('b');
      b.textContent = label;
      row.appendChild(b);
      const s = document.createElement('span');
      if (extraClass) s.className = extraClass;
      s.textContent = value == null ? '' : String(value);
      row.appendChild(s);
      return row;
    }

    function clearNode(el) { while (el.firstChild) el.removeChild(el.firstChild); }

    function errorNode(msg) {
      const d = document.createElement('div');
      d.className = 'np-error';
      d.textContent = msg;
      return d;
    }

    async function loadStatus() {
      const el = document.getElementById('cd-status');
      clearNode(el);
      try {
        const res = await fetch('/api/caddy/status');
        const data = await res.json();
        if (data.error) { el.appendChild(errorNode(data.error)); return; }

        const card = document.createElement('div');
        card.className = 'cd-card';

        card.appendChild(makeRow('Admin API', data.admin_api + '  (reachable)'));
        card.appendChild(makeRow('Caddyfile', data.caddyfile_path));
        card.appendChild(makeRow('Sites (file)', data.sites_in_caddyfile ?? 0));
        card.appendChild(makeRow('Routes (loaded)', data.routes_loaded ?? 0));
        card.appendChild(makeRow('Listen', (data.listen || []).join(', ') || '—'));
        card.appendChild(makeRow('ACME emails', (data.acme_emails || []).join(', ') || '—'));

        const actions = document.createElement('div');
        actions.className = 'cd-actions';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Reload Caddyfile';
        btn.addEventListener('click', cdReload);
        actions.appendChild(btn);
        card.appendChild(actions);

        el.appendChild(card);
      } catch (e) {
        el.appendChild(errorNode('Cannot reach Caddy API.'));
      }
    }

    async function loadSites() {
      const el = document.getElementById('cd-sites');
      clearNode(el);
      try {
        const res = await fetch('/api/caddy/sites');
        const data = await res.json();
        if (data.error) { el.appendChild(errorNode(data.error)); return; }

        const sites = data.sites || [];
        if (sites.length === 0) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'No sites yet. Add one below or edit the Caddyfile directly.';
          el.appendChild(idle);
          return;
        }

        sites.forEach(function (s) {
          const card = document.createElement('div');
          card.className = 'cd-card';

          const row = document.createElement('div');
          row.className = 'cd-row';
          const b = document.createElement('b');
          b.textContent = s.address;
          row.appendChild(b);
          const up = document.createElement('span');
          up.className = 'cd-up';
          up.textContent = s.upstream || '(no reverse_proxy)';
          row.appendChild(up);
          card.appendChild(row);

          const actions = document.createElement('div');
          actions.className = 'cd-actions';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'cd-btn-danger';
          btn.textContent = 'Remove';
          btn.addEventListener('click', function () { cdRemove(s.address); });
          actions.appendChild(btn);
          card.appendChild(actions);

          el.appendChild(card);
        });
      } catch (e) {
        el.appendChild(errorNode('Failed to load sites.'));
      }
    }

    async function cdReload() {
      try {
        const res = await fetch('/api/caddy/reload', { method: 'POST' });
        const data = await res.json();
        alert(data.ok ? 'Caddy reloaded.' : ('Reload failed: ' + (data.error || 'unknown')));
        loadStatus(); loadSites();
      } catch (e) { alert('Reload failed: ' + e.message); }
    }

    async function cdAdd(ev) {
      ev.preventDefault();
      const form = ev.target;
      const domain = form.domain.value.trim();
      const upstream = form.upstream.value.trim();
      const msg = document.getElementById('cd-add-msg');
      msg.textContent = 'Adding…';
      try {
        const res = await fetch('/api/caddy/sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: domain, upstream: upstream })
        });
        const data = await res.json();
        if (data.ok) {
          msg.textContent = 'Added ' + domain + '.';
          form.reset();
          loadStatus(); loadSites();
        } else {
          msg.textContent = 'Error: ' + (data.error || 'unknown');
        }
      } catch (e) { msg.textContent = 'Error: ' + e.message; }
      return false;
    }

    async function cdRemove(domain) {
      if (!confirm('Remove site "' + domain + '" from the Caddyfile?')) return;
      try {
        const res = await fetch('/api/caddy/sites/' + encodeURIComponent(domain), { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) { loadStatus(); loadSites(); }
        else alert('Remove failed: ' + (data.error || 'unknown'));
      } catch (e) { alert('Remove failed: ' + e.message); }
    }

    async function loadCerts() {
      const el = document.getElementById('cd-certs');
      clearNode(el);
      try {
        const res = await fetch('/api/caddy/cert-health');
        const data = await res.json();
        if (data.error) { el.appendChild(errorNode(data.error)); return; }
        if (!data.results || data.results.length === 0) {
          const d = document.createElement('div');
          d.className = 'np-idle';
          d.textContent = 'No sites configured yet — add one below and Caddy will request a certificate on first request.';
          el.appendChild(d);
          return;
        }
        const card = document.createElement('div');
        card.className = 'cd-card';
        const summary = document.createElement('div');
        summary.className = 'cd-cert-summary cd-cert-' + data.summary;
        summary.textContent = 'Overall: ' + data.summary.toUpperCase();
        card.appendChild(summary);

        for (const r of data.results) {
          const row = document.createElement('div');
          row.className = 'cd-cert-row cd-cert-' + r.status;
          const head = document.createElement('div');
          head.className = 'cd-cert-head';
          const dot = document.createElement('span');
          dot.className = 'cd-cert-dot cd-cert-dot-' + r.status;
          dot.textContent = r.status === 'ok' ? '\u2713' : r.status === 'warning' ? '!' : '\u2717';
          head.appendChild(dot);
          const dom = document.createElement('b');
          dom.textContent = r.domain;
          head.appendChild(dom);
          row.appendChild(head);

          const meta = document.createElement('div');
          meta.className = 'cd-cert-meta';
          meta.textContent = r.issuer + (r.expires_at ? '  \u2022  expires ' + new Date(r.expires_at).toLocaleDateString() : '');
          row.appendChild(meta);

          if (r.problems && r.problems.length) {
            const p = document.createElement('div');
            p.className = 'cd-cert-problems';
            p.textContent = r.problems.join('; ');
            row.appendChild(p);
          }
          card.appendChild(row);
        }
        el.appendChild(card);
      } catch (e) {
        el.appendChild(errorNode('Cannot load cert health: ' + e.message));
      }
    }

    document.getElementById('cd-add').addEventListener('submit', cdAdd);
    loadStatus();
    loadSites();
    loadCerts();
  `;
}

function styles() {
  return `
    .cd-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .cd-subtitle { font-size: 0.85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .cd-section { margin-bottom: 1.8rem; }
    .cd-section h3 { font-size: 0.8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.7rem; }
    .cd-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem; margin-bottom: .7rem; }
    .cd-row { display: flex; justify-content: space-between; gap: 1rem; padding: .25rem 0;
              font-size: .9rem; color: var(--crow-text-primary); }
    .cd-row b { color: var(--crow-text-muted); font-weight: 500; min-width: 140px; }
    .cd-up { font-family: ui-monospace, monospace; color: var(--crow-accent); }
    .cd-actions { margin-top: .6rem; display: flex; gap: .5rem; }
    .cd-actions button, .cd-form button { background: var(--crow-accent); color: #0b0d10;
               border: none; border-radius: 6px; padding: .5rem 1rem; font-weight: 600; cursor: pointer; }
    .cd-btn-danger { background: #ef4444 !important; color: #fff !important; }
    .cd-form { display: grid; gap: .6rem; max-width: 520px; }
    .cd-form label { display: grid; gap: .3rem; font-size: .85rem; color: var(--crow-text-muted); }
    .cd-form input { background: var(--crow-bg); border: 1px solid var(--crow-border); color: var(--crow-text-primary);
                     border-radius: 6px; padding: .55rem .7rem; font-family: ui-monospace, monospace; }
    .cd-msg { min-height: 1.2rem; font-size: .85rem; color: var(--crow-text-muted); }
    .cd-notes ul { margin: 0; padding-left: 1.2rem; color: var(--crow-text-secondary); font-size: .88rem; }
    .cd-notes li { margin-bottom: .3rem; }
    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: var(--crow-error, #ef4444); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }

    .cd-cert-summary { font-size: .85rem; font-weight: 600; text-transform: uppercase;
                       letter-spacing: .05em; padding: .35rem .6rem; border-radius: 6px;
                       display: inline-block; margin-bottom: .8rem; }
    .cd-cert-summary.cd-cert-ok { background: rgba(34,197,94,.15); color: #22c55e; }
    .cd-cert-summary.cd-cert-warning { background: rgba(234,179,8,.15); color: #eab308; }
    .cd-cert-summary.cd-cert-error { background: rgba(239,68,68,.15); color: #ef4444; }
    .cd-cert-row { padding: .6rem 0; border-top: 1px solid var(--crow-border); }
    .cd-cert-row:first-of-type { border-top: none; }
    .cd-cert-head { display: flex; align-items: center; gap: .5rem; }
    .cd-cert-head b { font-size: .95rem; color: var(--crow-text-primary); }
    .cd-cert-dot { display: inline-flex; align-items: center; justify-content: center;
                   width: 1.2rem; height: 1.2rem; border-radius: 50%; font-size: .75rem;
                   font-weight: bold; }
    .cd-cert-dot-ok { background: #22c55e; color: #0b0d10; }
    .cd-cert-dot-warning { background: #eab308; color: #0b0d10; }
    .cd-cert-dot-error { background: #ef4444; color: #fff; }
    .cd-cert-meta { font-size: .8rem; color: var(--crow-text-muted); margin-top: .2rem;
                    margin-left: 1.7rem; font-family: ui-monospace, monospace; }
    .cd-cert-problems { font-size: .8rem; color: #ef4444; margin-top: .15rem; margin-left: 1.7rem; }
  `;
}
