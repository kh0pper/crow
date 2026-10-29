/**
 * Settings Section: Integrations
 */

import { escapeHtml, badge } from "../../shared/components.js";
import { t, tJs, fill } from "../../shared/i18n.js";
import { getProxyStatus } from "../../../proxy.js";
import { legacyIntegrationsView, legacyEnvSources } from "../../../services/legacy-sources.js";
import { isSupervised } from "../../../../shared/supervisor.js";
import { servicesUiEnabled } from "../../../services/ui-flag.js";
import { listConnections } from "../../../../shared/service-connections.js";
import { serviceSecretKeys } from "../../../keychain/store.js";
import { childState, childStderr } from "../../../services/children.js";
import { serviceById } from "../../../../shared/service-catalog.js";

const CHILD_STATES = ["running", "stopped", "starting", "error", "cooling"];

/** Restart (Task 14, R8): POSTs the restart route (the layout's fetch wrapper adds CSRF) and shows
 * the child's new state or the fixed error line. No backticks: this is inside a template literal. */
function restartScript() {
  return `<script>
(function () {
  if (window.__crowIntRestartBound) return;
  window.__crowIntRestartBound = true;
  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-int-restart]') : null;
    if (!btn) return;
    ev.preventDefault();
    var row = btn.closest('[data-int-conn]');
    var stateEl = row ? row.querySelector('[data-int-child-state]') : null;
    var msgEl = row ? row.querySelector('[data-int-restart-msg]') : null;
    var labels = {};
    try { labels = JSON.parse(btn.getAttribute('data-labels') || '{}'); } catch (e) { labels = {}; }
    btn.disabled = true;
    if (stateEl && labels.starting) stateEl.textContent = labels.starting;
    if (msgEl) msgEl.textContent = '';
    fetch('/dashboard/services/api/connection/' + encodeURIComponent(btn.getAttribute('data-int-restart')) + '/restart', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        var b = res.body || {};
        var st = b.childState || (res.status === 200 ? 'running' : 'error');
        if (stateEl && labels[st]) stateEl.textContent = labels[st];
        if (res.status !== 200 && msgEl) msgEl.textContent = labels[b.error === 'busy' ? 'busy' : 'child_unavailable'] || '';
      })
      .catch(function () { if (msgEl) msgEl.textContent = labels.child_unavailable || ''; })
      .then(function () { btn.disabled = false; });
  });
})();
<\/script>`;
}

/** One connection's Advanced row: names and status only, the child's state, Restart, its redacted stderr. */
function connectionRow(c, keys, lang) {
  const status = t(`services.status.${c.status}`, lang);
  const state = childState(c.uuid);
  const name = serviceById(c.serviceId)?.name || c.serviceId;
  const labels = Object.fromEntries(CHILD_STATES.map((s) => [s, t(`services.child.${s}`, lang)]));
  labels.child_unavailable = fill(t("services.error.child_unavailable", lang), { service: name });
  labels.busy = t("services.error.busy", lang);
  const lines = childStderr(c.uuid);
  const stderr = lines.length
    ? `<details class="int-stderr"><summary>stderr (${lines.length})</summary><pre>${lines.map((l) => escapeHtml(l)).join("\n")}</pre></details>`
    : "";
  return `<li data-int-conn="${escapeHtml(c.uuid)}"><strong>${escapeHtml(c.serviceId)}</strong> ${escapeHtml(c.accountLabel)} <span class="int-note">${escapeHtml(status)}${c.lastError ? ` <code>${escapeHtml(c.lastError)}</code>` : ""}${keys.length ? ` · ${keys.map((k) => escapeHtml(k)).join(", ")}` : ""}</span>
      · <span class="int-note" data-int-child-state>${escapeHtml(t(`services.child.${state}`, lang))}</span>
      <button type="button" class="btn btn-sm" data-int-restart="${escapeHtml(c.uuid)}" data-labels="${escapeHtml(JSON.stringify(labels))}">${escapeHtml(t("settings.integrations.restartChild", lang))}</button>
      <span class="int-note" data-int-restart-msg role="status"></span>${stderr}</li>`;
}

/** Flag on: the "moved" note, a link to the current scope's Services page, and Advanced (names and status only, never a value). */
async function movedHtml({ scope, db, lang }) {
  let href = "/dashboard/projects";
  let label = t("settings.integrations.openProjects", lang);
  if (scope && scope.projectId != null && scope.slug && db) {
    try {
      const { rows } = await db.execute({ sql: "SELECT name FROM project_spaces WHERE id = ?", args: [Number(scope.projectId)] });
      if (rows[0]) {
        href = `/dashboard/project/${encodeURIComponent(scope.slug)}/services`;
        label = fill(t("settings.integrations.open", lang), { project: rows[0].name });
      }
    } catch (err) { console.warn("[settings] services link lookup failed:", err.message); }
  }
  const none = `<li class="int-note">${escapeHtml(t("settings.integrations.none", lang))}</li>`;
  const sources = legacyEnvSources().map((s) =>
    `<li><strong>${escapeHtml(s.name)}</strong> <code>${escapeHtml(s.id)}</code> <span class="int-note">${s.envVars.map((v) => escapeHtml(v)).join(", ")}</span></li>`).join("");
  let conns = "";
  if (db) {
    try {
      for (const c of await listConnections(db, {})) {
        const keys = [...(await serviceSecretKeys(db, c.uuid))].sort();
        conns += connectionRow(c, keys, lang);
      }
    } catch (err) { console.warn("[settings] connections listing failed:", err.message); }
  }
  return `<p class="int-note" data-int-moved>${escapeHtml(t("settings.integrations.moved", lang))}</p>
    <p><a class="int-link" href="${escapeHtml(href)}" data-int-services-link>${escapeHtml(label)}</a></p>
    <details class="int-advanced" data-int-advanced><summary>${escapeHtml(t("settings.integrations.advanced", lang))}</summary>
      <h4 class="int-cat-label">${escapeHtml(t("settings.integrations.sources", lang))}</h4><ul>${sources || none}</ul>
      <h4 class="int-cat-label">${escapeHtml(t("settings.integrations.connections", lang))}</h4><ul>${conns || none}</ul>
    </details>${conns ? restartScript() : ""}`;
}

export default {
  id: "integrations",
  group: "accounts",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  labelKey: "settings.section.integrations",
  navOrder: 30,

  async getPreview() {
    const proxyStatus = getProxyStatus();
    const connected = proxyStatus.filter(s => s.status === "connected").length;
    return `${connected} connected`;
  },

  async render({ req, db, lang } = {}) {
    // With CROW_SERVICES_UI on, services live in each project; this page only points there.
    if (servicesUiEnabled()) return movedHtml({ scope: req && req.crowScope, db, lang });
    const proxyStatus = getProxyStatus();
    const allIntegrations = legacyIntegrationsView();
    const categories = { productivity: [], communication: [], development: [] };
    const statusMap = new Map(proxyStatus.map((s) => [s.id, s]));
    for (const integration of allIntegrations) {
      const cat = integration.category || "development";
      const status = statusMap.get(integration.id);
      if (categories[cat]) {
        categories[cat].push({ ...integration, proxyStatus: status || null });
      }
    }

    const categoryLabels = { productivity: t("settings.productivity", lang), communication: t("settings.communication", lang), development: t("settings.development", lang) };

    let html = `<style>
      .int-cards { display:flex; flex-direction:column; gap:0.5rem; }
      .int-card { border:1px solid var(--crow-border); border-radius:8px; overflow:hidden; background:var(--crow-surface); }
      .int-card-header { display:flex; align-items:center; gap:0.75rem; padding:0.75rem 1rem; cursor:pointer; user-select:none; }
      .int-card-header:hover { background:color-mix(in srgb, var(--crow-surface) 90%, var(--crow-text) 10%); }
      .int-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
      .int-dot-green { background:var(--crow-success); }
      .int-dot-yellow { background:#e6a700; }
      .int-dot-gray { background:var(--crow-text-muted); }
      .int-card-info { flex:1; min-width:0; }
      .int-card-name { font-weight:600; font-size:0.95rem; color:var(--crow-text); }
      .int-card-desc { font-size:0.8rem; color:var(--crow-text-muted); margin-top:2px; }
      .int-chevron { transition:transform 0.2s; color:var(--crow-text-muted); font-size:0.8rem; }
      .int-chevron.open { transform:rotate(180deg); }
      .int-card-body { display:none; padding:0.75rem 1rem; border-top:1px solid var(--crow-border); }
      .int-card-body.open { display:block; }
      .int-field { margin-bottom:0.75rem; }
      .int-field label { display:block; font-size:0.8rem; color:var(--crow-text-muted); margin-bottom:4px; font-family:'JetBrains Mono',monospace; }
      .int-field input { width:100%; padding:0.5rem; background:var(--crow-background,#111); border:1px solid var(--crow-border); border-radius:4px; color:var(--crow-text); font-family:'JetBrains Mono',monospace; font-size:0.85rem; box-sizing:border-box; }
      .int-actions { display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:0.75rem; }
      .int-link { font-size:0.8rem; color:var(--crow-accent); text-decoration:none; }
      .int-link:hover { text-decoration:underline; }
      .int-note { font-size:0.8rem; color:var(--crow-text-muted); font-style:italic; }
      .int-cat-label { font-size:0.75rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--crow-text-muted); margin:1rem 0 0.5rem; font-weight:600; }
      .int-cat-label:first-child { margin-top:0; }
      .int-status-msg { font-size:0.8rem; margin-top:0.5rem; padding:0.4rem 0.6rem; border-radius:4px; }
    </style>`;

    for (const [catKey, items] of Object.entries(categories)) {
      if (items.length === 0) continue;
      html += `<div class="int-cat-label">${categoryLabels[catKey]}</div><div class="int-cards">`;
      for (const item of items) {
        const isConnected = item.proxyStatus?.status === "connected";
        const requiresMissing = item.proxyStatus?.requiresMissing || false;
        const hasEnvVars = item.envVars.length > 0;
        const dotClass = isConnected ? "int-dot-green" : (requiresMissing && !isConnected ? "int-dot-yellow" : "int-dot-gray");
        const connectedBadge = isConnected ? ` ${badge(t("settings.connected", lang), "connected")}` : "";
        const toolCount = item.proxyStatus?.toolCount ? ` <span class="mono" style="font-size:0.8rem;color:var(--crow-text-muted)">${item.proxyStatus.toolCount} ${t("settings.tools", lang)}</span>` : "";

        let bodyContent = "";
        if (hasEnvVars) {
          for (const envVar of item.envVars) {
            const currentVal = process.env[envVar] ? "••••••••" : "";
            bodyContent += `<div class="int-field">
              <label>${escapeHtml(envVar)}</label>
              <input type="password" name="${escapeHtml(envVar)}" placeholder="${currentVal || t("settings.notSet", lang)}" autocomplete="off">
            </div>`;
          }
        } else {
          bodyContent += `<p class="int-note">${t("settings.noConfigNeeded", lang)}</p>`;
        }

        if (requiresMissing) {
          bodyContent += `<p class="int-note">${t("settings.requires", lang)} ${item.requires.map((r) => `<code>${escapeHtml(r)}</code>`).join(", ")} (Python)</p>`;
        }

        let links = "";
        if (item.keyUrl) {
          links += `<a href="${escapeHtml(item.keyUrl)}" target="_blank" rel="noopener" class="int-link">${t("settings.getApiKey", lang)}</a>`;
        }
        if (item.docsUrl) {
          links += `<a href="${escapeHtml(item.docsUrl)}" target="_blank" rel="noopener" class="int-link">${t("settings.docs", lang)}</a>`;
        }

        const saveBtn = hasEnvVars ? `<button class="btn btn-primary btn-sm" onclick="saveIntegration('${escapeHtml(item.id)}',this)">${t("settings.save", lang)}</button>` : "";
        const removeBtn = isConnected ? `<button class="btn btn-secondary btn-sm" onclick="removeIntegration('${escapeHtml(item.id)}',this)">${t("settings.removeIntegration", lang)}</button>` : "";

        bodyContent += `<div class="int-actions">${saveBtn}${removeBtn}${links}</div>`;

        const instructions = item.steps.length > 0
          ? item.steps.map((k) => t(k, lang)).join(" → ")
          : item.toggleEnv
            ? fill(t("settings.legacyToggleHint", lang), { env: item.toggleEnv })
            : item.keyInstructions;
        if (instructions) {
          bodyContent += `<p class="int-note" style="margin-top:0.5rem">${escapeHtml(instructions)}</p>`;
        }

        html += `<div class="int-card" data-integration="${escapeHtml(item.id)}">
          <div class="int-card-header" onclick="toggleIntCard(this)">
            <span class="int-dot ${dotClass}"></span>
            <div class="int-card-info">
              <div class="int-card-name">${escapeHtml(item.name)}${connectedBadge}${toolCount}</div>
              <div class="int-card-desc">${escapeHtml(item.description)}</div>
            </div>
            <span class="int-chevron">&#9662;</span>
          </div>
          <div class="int-card-body">${bodyContent}</div>
        </div>`;
      }
      html += `</div>`;
    }

    html += `<script>
function toggleIntCard(header) {
  const body = header.nextElementSibling;
  const chevron = header.querySelector('.int-chevron');
  body.classList.toggle('open');
  chevron.classList.toggle('open');
}

async function saveIntegration(id, btn) {
  const card = btn.closest('.int-card');
  const inputs = card.querySelectorAll('input[name]');
  const params = new URLSearchParams();
  params.set('action', 'save_integration');
  params.set('integration_id', id);
  let hasValue = false;
  inputs.forEach(inp => { if (inp.value) { params.set(inp.name, inp.value); hasValue = true; } });
  if (!hasValue) return;

  btn.disabled = true;
  btn.textContent = '${tJs("settings.saving", lang)}';
  try {
    const res = await fetch('/dashboard/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    const msg = document.createElement('div');
    msg.className = 'int-status-msg';
    if (data.ok) {
      msg.style.color = 'var(--crow-success)';
      if (data.restarting) {
        msg.textContent = '${tJs("settings.savedRestarting", lang)}';
        setTimeout(() => { pollHealth(); }, 2000);
      } else {
        msg.textContent = '${tJs("settings.savedRestartNeeded", lang)} ';
        var restartBtn = document.createElement('button');
        restartBtn.type = 'button';
        restartBtn.className = 'btn btn-secondary btn-sm';
        restartBtn.textContent = '${tJs("settings.restartNow", lang)}';
        restartBtn.onclick = function() { restartCrowNow(restartBtn, msg); };
        msg.appendChild(restartBtn);
      }
    } else {
      msg.style.color = 'var(--crow-error)';
      msg.textContent = data.error || '${tJs("settings.saveFailed", lang)}';
    }
    const actions = card.querySelector('.int-actions');
    const oldMsg = card.querySelector('.int-status-msg');
    if (oldMsg) oldMsg.remove();
    actions.after(msg);
    inputs.forEach(inp => { inp.value = ''; inp.placeholder = '••••••••'; });
  } catch (e) {
    console.error(e);
  }
  btn.disabled = false;
  btn.textContent = '${tJs("settings.save", lang)}';
}

async function removeIntegration(id, btn) {
  if (!confirm('${tJs("settings.removeConfirm", lang)}')) return;
  btn.disabled = true;
  btn.textContent = '${tJs("settings.removing", lang)}';
  try {
    const params = new URLSearchParams();
    params.set('action', 'remove_integration');
    params.set('integration_id', id);
    const res = await fetch('/dashboard/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (data.ok) {
      if (data.restarting) {
        setTimeout(() => { pollHealth(); }, 2000);
      } else {
        location.reload();
      }
    }
  } catch (e) {
    console.error(e);
  }
  btn.disabled = false;
  btn.textContent = '${tJs("settings.removeIntegration", lang)}';
}

function restartCrowNow(btn, msg) {
  if (!confirm('${tJs("settings.restartConfirm", lang)}')) return;
  btn.disabled = true;
  btn.textContent = '${tJs("settings.restartingNow", lang)}';
  fetch('/bundles/api/restart', { method: 'POST' }).then(function(r) {
    if (!r.ok) throw new Error('restart request failed');
    setTimeout(function() { pollHealth(); }, 2000);
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = '${tJs("settings.restartNow", lang)}';
    var errEl = document.createElement('div');
    errEl.className = 'int-status-msg';
    errEl.style.color = 'var(--crow-error)';
    errEl.textContent = '${tJs("settings.restartFailed", lang)}';
    msg.after(errEl);
  });
}

function pollHealth(attempts) {
  attempts = attempts || 0;
  if (attempts > 15) { location.reload(); return; }
  fetch('/health').then(r => { if (r.ok) location.reload(); else throw 0; }).catch(() => {
    setTimeout(() => pollHealth(attempts + 1), 2000);
  });
}
<\/script>`;

    return html;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "save_integration") {
      const { integration_id } = req.body;
      const { resolveEnvPath, writeEnvVar, sanitizeEnvValue } = await import("../../../env-manager.js");

      const integration = legacyIntegrationsView().find((i) => i.id === integration_id);
      if (!integration) {
        res.json({ ok: false, error: "Unknown integration" });
        return true;
      }

      const envPath = resolveEnvPath();
      for (const envVar of integration.envVars) {
        const value = req.body[envVar];
        if (value !== undefined && value !== "") {
          writeEnvVar(envPath, envVar, sanitizeEnvValue(value));
        }
      }

      try {
        const { execFileSync } = await import("node:child_process");
        const { APP_ROOT } = await import("../../../env-manager.js");
        execFileSync("node", ["scripts/generate-mcp-config.js"], {
          cwd: APP_ROOT,
          stdio: "pipe",
          timeout: 10000,
        });
      } catch (e) {
        console.warn("[settings] Failed to regenerate .mcp.json:", e.message);
      }

      const supervised = isSupervised();
      res.json({ ok: true, restarting: supervised });
      if (supervised) {
        setTimeout(() => process.exit(0), 500);
      }
      return true;
    }

    if (action === "remove_integration") {
      const { integration_id } = req.body;
      const { resolveEnvPath, removeEnvVar } = await import("../../../env-manager.js");

      const integration = legacyIntegrationsView().find((i) => i.id === integration_id);
      if (!integration) {
        res.json({ ok: false, error: "Unknown integration" });
        return true;
      }

      const envPath = resolveEnvPath();
      for (const envVar of integration.envVars) {
        removeEnvVar(envPath, envVar);
      }

      try {
        const { execFileSync } = await import("node:child_process");
        const { APP_ROOT } = await import("../../../env-manager.js");
        execFileSync("node", ["scripts/generate-mcp-config.js"], {
          cwd: APP_ROOT,
          stdio: "pipe",
          timeout: 10000,
        });
      } catch (e) {
        console.warn("[settings] Failed to regenerate .mcp.json:", e.message);
      }

      const supervised = isSupervised();
      res.json({ ok: true, restarting: supervised });
      if (supervised) {
        setTimeout(() => process.exit(0), 500);
      }
      return true;
    }

    return false;
  },
};
