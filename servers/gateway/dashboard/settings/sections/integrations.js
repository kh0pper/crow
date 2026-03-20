/**
 * Settings Section: Integrations
 */

import { escapeHtml, badge } from "../../shared/components.js";
import { t, tJs } from "../../shared/i18n.js";
import { getProxyStatus } from "../../../proxy.js";

export default {
  id: "integrations",
  group: "connections",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  labelKey: "settings.section.integrations",
  navOrder: 30,

  async getPreview() {
    const proxyStatus = getProxyStatus();
    const connected = proxyStatus.filter(s => s.status === "connected").length;
    return `${connected} connected`;
  },

  async render({ lang }) {
    const proxyStatus = getProxyStatus();
    const { INTEGRATIONS: allIntegrations } = await import("../../../integrations.js");
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

        if (item.keyInstructions) {
          bodyContent += `<p class="int-note" style="margin-top:0.5rem">${escapeHtml(item.keyInstructions)}</p>`;
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
      msg.textContent = data.restarting ? '${tJs("settings.savedRestarting", lang)}' : '${tJs("settings.savedRestartNeeded", lang)}';
      if (data.restarting) {
        setTimeout(() => { pollHealth(); }, 2000);
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
      const { INTEGRATIONS } = await import("../../../integrations.js");
      const { resolveEnvPath, writeEnvVar, sanitizeEnvValue } = await import("../../../env-manager.js");

      const integration = INTEGRATIONS.find((i) => i.id === integration_id);
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

      const isSystemd = !!process.env.INVOCATION_ID;
      res.json({ ok: true, restarting: isSystemd });
      if (isSystemd) {
        setTimeout(() => process.exit(0), 500);
      }
      return true;
    }

    if (action === "remove_integration") {
      const { integration_id } = req.body;
      const { INTEGRATIONS } = await import("../../../integrations.js");
      const { resolveEnvPath, removeEnvVar } = await import("../../../env-manager.js");

      const integration = INTEGRATIONS.find((i) => i.id === integration_id);
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

      const isSystemd = !!process.env.INVOCATION_ID;
      res.json({ ok: true, restarting: isSystemd });
      if (isSystemd) {
        setTimeout(() => process.exit(0), 500);
      }
      return true;
    }

    return false;
  },
};
