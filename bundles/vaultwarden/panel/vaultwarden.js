/**
 * Crow's Nest Panel — Vaultwarden
 *
 * Status card + backup freshness + link to the web UI. Password managers
 * should open in a full browser window (not an iframe) so browser
 * extensions and autofill work correctly. Client-side JS uses
 * textContent + createElement only (XSS-safe).
 */

export default {
  id: "vaultwarden",
  name: "Vaultwarden",
  icon: "lock",
  route: "/dashboard/vaultwarden",
  navOrder: 44,
  category: "infrastructure",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const url = process.env.VAULTWARDEN_URL || "http://localhost:8097";

    const content = `
      <style>${vaultwardenStyles()}</style>
      <div class="vw-panel">
        <h1>Vaultwarden</h1>

        <div class="vw-hero">
          <p>Your self-hosted Bitwarden-compatible vault. Use the official Bitwarden browser extension or mobile app to read, create, and autofill credentials.</p>
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="vw-btn">Open Web Vault</a>
        </div>

        <div class="vw-section">
          <h3>Status</h3>
          <div id="vw-status" class="vw-status"><div class="np-loading">Checking...</div></div>
        </div>

        <div class="vw-section">
          <h3>Backup Freshness</h3>
          <div id="vw-backup" class="vw-backup"><div class="np-loading">Loading...</div></div>
          <div class="vw-hint">The data directory is the single source of truth. Losing it means losing every stored credential. Schedule recurring backups.</div>
        </div>
      </div>
      <script>${vaultwardenScript()}</script>
    `;

    res.send(layout({ title: "Vaultwarden", content }));
  },
};

function vaultwardenScript() {
  return `
    async function loadStatus() {
      const el = document.getElementById('vw-status');
      if (!el) return;
      try {
        const res = await fetch('/api/vaultwarden/status');
        const data = await res.json();
        el.textContent = '';
        const card = document.createElement('div');
        card.className = 'stat-card';
        const val = document.createElement('div');
        val.className = 'stat-value';
        val.textContent = data.reachable ? 'Online' : 'Offline';
        if (!data.reachable) card.classList.add('stat-warn');
        card.appendChild(val);
        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = data.url;
        card.appendChild(label);
        el.appendChild(card);
        if (data.error) {
          const err = document.createElement('div');
          err.className = 'np-error';
          err.textContent = data.error;
          el.appendChild(err);
        }
      } catch (e) {
        el.textContent = '';
        const err = document.createElement('div');
        err.className = 'np-error';
        err.textContent = 'Failed to reach status endpoint.';
        el.appendChild(err);
      }
    }

    function formatBytes(n) {
      if (!n) return '0 B';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
      return (n / 1073741824).toFixed(2) + ' GB';
    }

    async function loadBackup() {
      const el = document.getElementById('vw-backup');
      if (!el) return;
      try {
        const res = await fetch('/api/vaultwarden/backup');
        const data = await res.json();
        el.textContent = '';
        if (!data.exists) {
          const idle = document.createElement('div');
          idle.className = 'np-idle';
          idle.textContent = 'Data directory not found yet — Vaultwarden may not have been started.';
          el.appendChild(idle);
          return;
        }
        const sizeCard = document.createElement('div');
        sizeCard.className = 'stat-card';
        const sv = document.createElement('div');
        sv.className = 'stat-value';
        sv.textContent = formatBytes(data.total_bytes);
        sizeCard.appendChild(sv);
        const sl = document.createElement('div');
        sl.className = 'stat-label';
        sl.textContent = 'Data size';
        sizeCard.appendChild(sl);
        el.appendChild(sizeCard);

        if (data.last_modified) {
          const ageCard = document.createElement('div');
          ageCard.className = 'stat-card';
          const av = document.createElement('div');
          av.className = 'stat-value';
          av.textContent = new Date(data.last_modified).toLocaleString();
          ageCard.appendChild(av);
          const al = document.createElement('div');
          al.className = 'stat-label';
          al.textContent = 'Last write';
          ageCard.appendChild(al);
          el.appendChild(ageCard);
        }

        const pathCard = document.createElement('div');
        pathCard.className = 'stat-card stat-path';
        const pv = document.createElement('div');
        pv.className = 'stat-url';
        pv.textContent = data.data_dir;
        pathCard.appendChild(pv);
        const pl = document.createElement('div');
        pl.className = 'stat-label';
        pl.textContent = 'Data directory';
        pathCard.appendChild(pl);
        el.appendChild(pathCard);
      } catch (e) {
        el.textContent = '';
        const err = document.createElement('div');
        err.className = 'np-error';
        err.textContent = 'Failed to load backup info.';
        el.appendChild(err);
      }
    }

    loadStatus();
    loadBackup();
  `;
}

function vaultwardenStyles() {
  return `
    .vw-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .vw-hero { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 12px; padding: 1.2rem; margin-bottom: 1.5rem; }
    .vw-hero p { margin: 0 0 0.8rem; color: var(--crow-text-secondary); }
    .vw-btn { display: inline-block; padding: 0.5rem 1rem; background: var(--crow-accent);
              color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }
    .vw-btn:hover { filter: brightness(1.1); }

    .vw-section { margin-bottom: 1.5rem; }
    .vw-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    .vw-status, .vw-backup { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 160px; }
    .stat-card.stat-warn { border-color: var(--crow-error); }
    .stat-card.stat-warn .stat-value { color: var(--crow-error); }
    .stat-card.stat-path { flex: 1; min-width: 300px; }
    .stat-value { font-size: 1.1rem; font-weight: 700; color: var(--crow-accent); }
    .stat-url { font-size: 0.85rem; font-family: monospace; color: var(--crow-text-primary); word-break: break-all; }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.25rem; }

    .vw-hint { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.8rem;
               padding: 0.6rem; border-left: 2px solid var(--crow-accent);
               background: var(--crow-bg-elevated); border-radius: 4px; }

    .np-idle, .np-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .np-error { color: var(--crow-error); font-size: 0.9rem; padding: 0.8rem;
                background: var(--crow-bg-elevated); border-radius: 12px; margin-top: 0.5rem; }
  `;
}
