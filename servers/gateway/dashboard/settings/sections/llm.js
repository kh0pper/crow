/**
 * Settings Section: LLM Orchestrator (consolidated)
 *
 * One page that replaces ai-provider / ai-profiles / providers / tts-profiles /
 * stt-profiles / vision-profiles. Four internal tabs keyed by ?tab=:
 *   - providers (default) — DB-backed provider registry, Add-cloud, Sync button
 *   - roles                — 12 preset-agent override rows w/ compat check
 *   - profiles             — chat/TTS/STT/vision (links into live sections for v1)
 *   - health               — /api/providers/health matrix + re-probe
 *
 * During rollout this section ships alongside the six it will replace.
 * Phase 7 (deletion) flips panels/settings.js to drop the old ones.
 */

import { escapeHtml } from "../../shared/components.js";
import providersTab from "./llm/providers-tab.js";
import rolesTab from "./llm/roles-tab.js";
import profilesTab from "./llm/profiles-tab.js";
import healthTab from "./llm/health-tab.js";

const TABS = [
  { id: "providers", label: "Providers", render: providersTab.render, handleAction: providersTab.handleAction },
  { id: "roles",     label: "Agent roles", render: rolesTab.render,   handleAction: rolesTab.handleAction },
  { id: "profiles",  label: "Profiles",   render: profilesTab.render, handleAction: profilesTab.handleAction },
  { id: "health",    label: "Health",     render: healthTab.render,   handleAction: healthTab.handleAction },
];

function resolveTab(req) {
  const t = (req.query?.tab || "providers").toLowerCase();
  return TABS.find((x) => x.id === t) || TABS[0];
}

export default {
  id: "llm",
  group: "ai",
  navOrder: 5, // above ai-provider (10) during the dual-ship window
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`,
  labelKey: "settings.section.llm",

  async getPreview({ db }) {
    try {
      const { rows } = await db.execute("SELECT COUNT(*) AS n FROM providers WHERE disabled = 0");
      const n = Number(rows[0]?.n || 0);
      return `${n} provider${n === 1 ? "" : "s"}`;
    } catch { return "LLM orchestrator"; }
  },

  async render({ req, db, lang }) {
    const active = resolveTab(req);
    const tabsHtml = TABS.map((t) => {
      const activeAttr = t.id === active.id ? ' aria-current="page"' : '';
      return `<a class="llm-tab${t.id === active.id ? " llm-tab-active" : ""}" href="?section=llm&tab=${t.id}" data-turbo-frame="_top"${activeAttr}>${escapeHtml(t.label)}</a>`;
    }).join("");
    const body = await active.render({ req, db, lang });
    return `<style>
      .llm-tabs { display:flex; gap:0.25rem; border-bottom:1px solid var(--crow-border); margin-bottom:1.25rem; padding-left:0.25rem; }
      .llm-tab {
        padding:0.55rem 0.95rem;
        color:var(--crow-text-secondary);
        text-decoration:none;
        font-size:0.9rem;
        border-bottom:2px solid transparent;
        margin-bottom:-1px;
        transition:color 120ms ease, border-color 120ms ease;
      }
      .llm-tab:hover { color:var(--crow-text-primary); }
      .llm-tab-active {
        color:var(--crow-text-primary);
        border-bottom-color:var(--crow-accent);
        font-weight:600;
      }
      .llm-section-hint {
        font-size:0.82rem;
        color:var(--crow-text-muted);
        margin-bottom:0.85rem;
        line-height:1.45;
      }
    </style>
    <nav class="llm-tabs">${tabsHtml}</nav>
    <div class="llm-tab-body">${body}</div>`;
  },

  async handleAction({ req, res, db, action }) {
    // Tab handlers are tried in order; first match wins. Each handler is
    // responsible for using res.redirectAfterPost('?section=llm&tab=<id>')
    // so Turbo keeps the user on the current tab after a POST.
    for (const tab of TABS) {
      if (!tab.handleAction) continue;
      const handled = await tab.handleAction({ req, res, db, action });
      if (handled) return true;
    }
    return false;
  },
};
