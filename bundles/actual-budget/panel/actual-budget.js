/**
 * Crow's Nest Panel — Actual Budget: account balances, spending overview, web UI embed
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Note: Client-side JS uses textContent-based escapeH() for safe HTML rendering,
 * matching the pattern used by other Crow panels (kodi, jellyfin, iptv).
 */

export default {
  id: "actual-budget",
  name: "Actual Budget",
  icon: "dollar",
  route: "/dashboard/actual-budget",
  navOrder: 40,
  category: "finance",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const tab = req.query.tab || "overview";

    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "webui", label: "Web UI" },
    ];

    const tabBar = `<div class="ab-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="ab-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";

    if (tab === "webui") {
      const actualUrl = process.env.ACTUAL_URL || "http://localhost:5006";
      body = `
        <div class="ab-webui">
          <iframe src="${escapeHtml(actualUrl)}" class="ab-iframe" allow="fullscreen"></iframe>
        </div>
      `;
    } else {
      body = renderOverview();
    }

    const content = `
      <style>${actualStyles()}</style>
      <div class="ab-panel">
        <h1>Actual Budget</h1>
        ${tabBar}
        <div class="ab-body">${body}</div>
      </div>
      <script>${actualScript()}</script>
    `;

    res.send(layout({ title: "Actual Budget", content }));
  },
};

function renderOverview() {
  return `
    <div class="ab-overview">
      <div class="ab-section">
        <h3>Account Balances</h3>
        <div id="ab-accounts" class="ab-accounts">
          <div class="ab-loading">Loading accounts...</div>
        </div>
      </div>

      <div class="ab-section">
        <h3>Monthly Summary</h3>
        <div id="ab-summary" class="ab-summary">
          <div class="ab-loading">Loading summary...</div>
        </div>
      </div>

      <div class="ab-section">
        <h3>Recent Transactions</h3>
        <div id="ab-recent" class="ab-recent-list">
          <div class="ab-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function actualScript() {
  return `
    // Safe HTML escaper using textContent
    function escapeH(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    function formatCents(cents) {
      if (cents == null) return '$0.00';
      var neg = cents < 0;
      var abs = Math.abs(cents);
      var dollars = Math.floor(abs / 100);
      var remainder = abs % 100;
      return (neg ? '-' : '') + '$' + dollars.toLocaleString() + '.' + String(remainder).padStart(2, '0');
    }

    async function loadAccounts() {
      var el = document.getElementById('ab-accounts');
      if (!el) return;
      try {
        var res = await fetch('/api/actual-budget/accounts');
        var data = await res.json();
        if (data.error) {
          el.textContent = '';
          var errDiv = document.createElement('div');
          errDiv.className = 'ab-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        var accounts = data.accounts || [];
        el.textContent = '';

        if (accounts.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'ab-idle';
          empty.textContent = 'No accounts found';
          el.appendChild(empty);
          return;
        }

        // Total balance card
        var totalCard = document.createElement('div');
        totalCard.className = 'stat-card stat-card-total';
        var totalVal = document.createElement('div');
        totalVal.className = 'stat-value';
        totalVal.textContent = formatCents(data.total_cents || 0);
        totalCard.appendChild(totalVal);
        var totalLabel = document.createElement('div');
        totalLabel.className = 'stat-label';
        totalLabel.textContent = 'Net Worth';
        totalCard.appendChild(totalLabel);
        el.appendChild(totalCard);

        accounts.forEach(function(a) {
          if (a.closed) return;
          var card = document.createElement('div');
          card.className = 'stat-card';
          var valEl = document.createElement('div');
          valEl.className = 'stat-value' + (a.balance_cents < 0 ? ' negative' : '');
          valEl.textContent = formatCents(a.balance_cents);
          card.appendChild(valEl);
          var labelEl = document.createElement('div');
          labelEl.className = 'stat-label';
          labelEl.textContent = a.name;
          card.appendChild(labelEl);
          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        var errDiv = document.createElement('div');
        errDiv.className = 'ab-error';
        errDiv.textContent = 'Cannot reach Actual Budget.';
        el.appendChild(errDiv);
      }
    }

    async function loadSummary() {
      var el = document.getElementById('ab-summary');
      if (!el) return;
      try {
        var res = await fetch('/api/actual-budget/summary');
        var data = await res.json();
        if (data.error) {
          el.textContent = '';
          var errDiv = document.createElement('div');
          errDiv.className = 'ab-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        el.textContent = '';
        var stats = [
          { label: 'Income', value: formatCents(data.income_cents || 0), positive: true },
          { label: 'Expenses', value: formatCents(data.expense_cents || 0), negative: true },
          { label: 'Net', value: formatCents(data.net_cents || 0), isNet: true },
          { label: 'Transactions', value: String(data.transaction_count || 0) },
        ];

        stats.forEach(function(s) {
          var card = document.createElement('div');
          card.className = 'stat-card';
          var valEl = document.createElement('div');
          valEl.className = 'stat-value';
          if (s.negative) valEl.classList.add('negative');
          if (s.isNet && data.net_cents < 0) valEl.classList.add('negative');
          if (s.positive) valEl.classList.add('positive');
          valEl.textContent = s.value;
          card.appendChild(valEl);
          var labelEl = document.createElement('div');
          labelEl.className = 'stat-label';
          labelEl.textContent = s.label;
          card.appendChild(labelEl);
          el.appendChild(card);
        });
      } catch (e) {
        el.textContent = '';
        var errDiv = document.createElement('div');
        errDiv.className = 'ab-error';
        errDiv.textContent = 'Cannot load summary.';
        el.appendChild(errDiv);
      }
    }

    async function loadRecent() {
      var el = document.getElementById('ab-recent');
      if (!el) return;
      try {
        var res = await fetch('/api/actual-budget/recent');
        var data = await res.json();
        if (data.error) {
          el.textContent = '';
          var errDiv = document.createElement('div');
          errDiv.className = 'ab-error';
          errDiv.textContent = data.error;
          el.appendChild(errDiv);
          return;
        }

        var txns = data.transactions || [];
        el.textContent = '';

        if (txns.length === 0) {
          var idle = document.createElement('div');
          idle.className = 'ab-idle';
          idle.textContent = 'No recent transactions';
          el.appendChild(idle);
          return;
        }

        txns.forEach(function(t) {
          var row = document.createElement('div');
          row.className = 'txn-row';

          var left = document.createElement('div');
          left.className = 'txn-left';

          var payee = document.createElement('div');
          payee.className = 'txn-payee';
          payee.textContent = t.payee || 'Unknown';
          left.appendChild(payee);

          var meta = document.createElement('div');
          meta.className = 'txn-meta';
          var parts = [t.date];
          if (t.category) parts.push(t.category);
          if (t.account) parts.push(t.account);
          meta.textContent = parts.join(' · ');
          left.appendChild(meta);

          row.appendChild(left);

          var amountEl = document.createElement('div');
          amountEl.className = 'txn-amount' + (t.amount_cents < 0 ? ' negative' : ' positive');
          amountEl.textContent = formatCents(t.amount_cents);
          row.appendChild(amountEl);

          el.appendChild(row);
        });
      } catch (e) {
        el.textContent = '';
        var errDiv = document.createElement('div');
        errDiv.className = 'ab-error';
        errDiv.textContent = 'Failed to load transactions.';
        el.appendChild(errDiv);
      }
    }

    // Init
    loadAccounts();
    loadSummary();
    loadRecent();
  `;
}

function actualStyles() {
  return `
    .ab-panel h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .ab-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--crow-border); margin-bottom: 1.5rem; }
    .ab-tab { padding: 0.6rem 1.2rem; color: var(--crow-text-secondary); text-decoration: none;
              border-bottom: 2px solid transparent; transition: all 0.2s; }
    .ab-tab:hover { color: var(--crow-text-primary); }
    .ab-tab.active { color: var(--crow-accent); border-bottom-color: var(--crow-accent); }

    .ab-overview { display: flex; flex-direction: column; gap: 1.5rem; }
    .ab-section h3 { font-size: 0.85rem; color: var(--crow-text-muted); text-transform: uppercase;
                     letter-spacing: 0.05em; margin: 0 0 0.8rem; }

    /* Stats */
    .ab-accounts, .ab-summary { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat-card { background: var(--crow-bg-elevated); border-radius: 10px; padding: 1rem 1.2rem;
                 border: 1px solid var(--crow-border); min-width: 100px; text-align: center; }
    .stat-card-total { border-color: var(--crow-accent); }
    .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--crow-accent); }
    .stat-value.negative { color: var(--crow-error, #e74c3c); }
    .stat-value.positive { color: var(--crow-success, #27ae60); }
    .stat-label { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.2rem; }

    /* Transactions */
    .ab-recent-list { display: flex; flex-direction: column; gap: 0.4rem; }
    .txn-row { display: flex; justify-content: space-between; align-items: center;
               background: var(--crow-bg-elevated); border-radius: 10px; padding: 0.8rem 1rem;
               border: 1px solid var(--crow-border); }
    .txn-left { flex: 1; min-width: 0; }
    .txn-payee { font-weight: 600; color: var(--crow-text-primary); font-size: 0.95rem;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .txn-meta { font-size: 0.8rem; color: var(--crow-text-muted); margin-top: 0.15rem; }
    .txn-amount { font-weight: 700; font-size: 1rem; flex-shrink: 0; margin-left: 1rem; }
    .txn-amount.negative { color: var(--crow-error, #e74c3c); }
    .txn-amount.positive { color: var(--crow-success, #27ae60); }

    .ab-idle, .ab-loading { color: var(--crow-text-muted); font-size: 0.9rem; padding: 1rem;
                            background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }
    .ab-error { color: var(--crow-error); font-size: 0.9rem; padding: 1rem;
                background: var(--crow-bg-elevated); border-radius: 12px; text-align: center; }

    /* Web UI iframe */
    .ab-webui { width: 100%; height: calc(100vh - 200px); min-height: 500px; }
    .ab-iframe { width: 100%; height: 100%; border: none; border-radius: 12px;
                 background: var(--crow-bg-elevated); }

    @media (max-width: 600px) {
      .ab-accounts, .ab-summary { flex-direction: column; }
      .txn-row { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
      .txn-amount { margin-left: 0; }
    }
  `;
}
