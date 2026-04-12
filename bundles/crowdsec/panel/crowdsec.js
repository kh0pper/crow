/**
 * Crow's Nest Panel — CrowdSec: alerts feed + active-decisions table.
 * XSS-safe: textContent + createElement only.
 */

export default {
  id: "crowdsec",
  name: "CrowdSec",
  icon: "shield",
  route: "/dashboard/crowdsec",
  navOrder: 67,
  category: "infrastructure",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="cs-panel">
        <h1>CrowdSec <span class="cs-subtitle">intrusion detection</span></h1>

        <div class="cs-section">
          <h3>Status</h3>
          <div id="cs-status"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="cs-section">
          <h3>Recent Alerts (24h)</h3>
          <div id="cs-alerts"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="cs-section">
          <h3>Active Decisions</h3>
          <div id="cs-decisions"><div class="np-loading">Loading…</div></div>
        </div>

        <div class="cs-section cs-notes">
          <h3>Notes</h3>
          <ul>
            <li>Detection only — decisions are visible here but nothing enforces them until a bouncer is installed (PR 4.5).</li>
            <li>Generate the bouncer API key: <code>docker exec crow-crowdsec cscli bouncers add crow-mcp</code></li>
            <li>Console UI enrollment (optional): <code>docker exec crow-crowdsec cscli console enroll &lt;token&gt;</code></li>
          </ul>
        </div>
      </div>
      <script>${script()}</script>
    `;
    res.send(layout({ title: "CrowdSec", content }));
  },
};

function script() {
  return `
    function clearNode(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function errorNode(msg) { const d = document.createElement('div'); d.className = 'np-error'; d.textContent = msg; return d; }
    function idleNode(msg) { const d = document.createElement('div'); d.className = 'np-idle'; d.textContent = msg; return d; }

    function statCard(label, value, warnClass) {
      const c = document.createElement('div');
      c.className = 'cs-card' + (warnClass ? ' ' + warnClass : '');
      const v = document.createElement('div');
      v.className = 'cs-val';
      v.textContent = value == null ? '—' : String(value);
      c.appendChild(v);
      const l = document.createElement('div');
      l.className = 'cs-label';
      l.textContent = label;
      c.appendChild(l);
      return c;
    }

    async function loadStatus() {
      const el = document.getElementById('cs-status');
      clearNode(el);
      try {
        const res = await fetch('/api/crowdsec/status');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const grid = document.createElement('div');
        grid.className = 'cs-grid';
        grid.appendChild(statCard('LAPI', d.reachable ? 'OK' : 'Unreachable', d.reachable ? '' : 'cs-warn'));
        grid.appendChild(statCard('API key', d.api_key_configured ? 'Set' : 'Not set', d.api_key_configured ? '' : 'cs-warn'));
        grid.appendChild(statCard('Active Decisions', d.active_decisions ?? 0));
        grid.appendChild(statCard('Alerts (24h)', d.alerts_last_24h ?? 0));
        el.appendChild(grid);
      } catch (e) { el.appendChild(errorNode('Cannot reach CrowdSec.')); }
    }

    async function loadAlerts() {
      const el = document.getElementById('cs-alerts');
      clearNode(el);
      try {
        const res = await fetch('/api/crowdsec/alerts');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const rows = d.alerts || [];
        if (rows.length === 0) { el.appendChild(idleNode('No alerts in the last 24 hours.')); return; }
        rows.forEach(function (a) {
          const card = document.createElement('div');
          card.className = 'cs-alert';
          const t = document.createElement('div');
          t.className = 'cs-alert-title';
          t.textContent = (a.scenario || 'unknown') + ' — ' + (a.source_ip || '?');
          card.appendChild(t);
          const m = document.createElement('div');
          m.className = 'cs-alert-meta';
          m.textContent = [a.source_cn, a.source_as, (a.events_count || 0) + ' events', a.created_at].filter(Boolean).join(' · ');
          card.appendChild(m);
          el.appendChild(card);
        });
      } catch (e) { el.appendChild(errorNode('Failed to load alerts.')); }
    }

    async function loadDecisions() {
      const el = document.getElementById('cs-decisions');
      clearNode(el);
      try {
        const res = await fetch('/api/crowdsec/decisions');
        const d = await res.json();
        if (d.error) { el.appendChild(errorNode(d.error)); return; }
        const rows = d.decisions || [];
        if (rows.length === 0) { el.appendChild(idleNode('No active decisions.')); return; }
        rows.forEach(function (x) {
          const card = document.createElement('div');
          card.className = 'cs-decision';
          const t = document.createElement('div');
          t.className = 'cs-dec-title';
          t.textContent = x.type.toUpperCase() + '  ' + x.scope + ': ' + x.value;
          card.appendChild(t);
          const m = document.createElement('div');
          m.className = 'cs-dec-meta';
          m.textContent = 'until ' + (x.until || '?') + ' · origin: ' + (x.origin || '?');
          card.appendChild(m);
          el.appendChild(card);
        });
      } catch (e) { el.appendChild(errorNode('Failed to load decisions.')); }
    }

    loadStatus();
    loadAlerts();
    loadDecisions();
  `;
}

function styles() {
  return `
    .cs-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .cs-subtitle { font-size: .85rem; color: var(--crow-text-muted); font-weight: 400; margin-left: .5rem; }
    .cs-section { margin-bottom: 1.6rem; }
    .cs-section h3 { font-size: .8rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: .05em; margin: 0 0 .6rem; }
    .cs-grid { display: flex; gap: 1rem; flex-wrap: wrap; }
    .cs-card { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
               border-radius: 10px; padding: 1rem 1.2rem; min-width: 130px; text-align: center; }
    .cs-card.cs-warn { border-color: #f59e0b; }
    .cs-card.cs-warn .cs-val { color: #f59e0b; }
    .cs-val { font-size: 1.3rem; font-weight: 700; color: var(--crow-accent); }
    .cs-label { font-size: .8rem; color: var(--crow-text-muted); margin-top: .2rem; }
    .cs-alert, .cs-decision { background: var(--crow-bg-elevated); border: 1px solid var(--crow-border);
                              border-radius: 10px; padding: .8rem 1rem; margin-bottom: .5rem; }
    .cs-alert-title, .cs-dec-title { font-weight: 600; color: var(--crow-text-primary); font-size: .92rem; }
    .cs-alert-meta, .cs-dec-meta { font-size: .8rem; color: var(--crow-text-muted); margin-top: .2rem; }
    .cs-notes ul { margin: 0; padding-left: 1.2rem; font-size: .88rem; color: var(--crow-text-secondary); }
    .cs-notes code { background: var(--crow-bg-elevated); padding: .1rem .4rem; border-radius: 4px;
                     font-size: .82rem; font-family: ui-monospace, monospace; }
    .np-idle, .np-loading { color: var(--crow-text-muted); padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
    .np-error { color: #ef4444; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 10px; text-align: center; }
  `;
}
