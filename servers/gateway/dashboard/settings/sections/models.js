/**
 * Settings Section: Models (roles Phase 2, the simple view).
 *
 * One page with every role: what fills it, where that runs and its status.
 * Changing a role (the Change buttons) and Add a provider are wired by later
 * work; this page is the server render. Advanced is today's LLM page
 * (`?section=llm`), still deep-linkable but no longer in the menu.
 *
 * Search ranking stays out of the list until something fills it on purpose;
 * "Show search ranking" (`?section=models&show=rerank`) renders it anyway.
 */
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { buildRoleRows, ROLE_GROUPS, FILLED_STATUSES } from "./models/rows.js";

const WHERE_CODES = new Set(["here", "other_box", "cloud", "unproven", "missing"]);

function statusText(row, lang) {
  const code = row.status?.code || "not_set";
  if (code === "fallback") {
    const via = row.status.role;
    return fill(t("models.status.fallback", lang), { role: via ? t(`settings.roles.${via}`, lang) : "?" });
  }
  return t(`models.status.${code}`, lang);
}

function whereChip(where, lang) {
  const w = WHERE_CODES.has(where) ? where : "unproven";
  return `<span class="mr-where mr-where-${w}">${escapeHtml(t(`models.where.${w}`, lang))}</span>`;
}

function rowHtml(row, lang) {
  const model = row.model
    ? `<div class="mr-model"><span class="mr-model-label">${escapeHtml(row.model.label || row.model.key || "")}</span>${whereChip(row.model.where, lang)}</div>`
    : "";
  const note = (row.voiceBot
    ? `<p class="mr-note">${escapeHtml(fill(t("models.ui.voiceBotUses", lang), { name: row.voiceBot.name }))}</p>`
    : "") + (row.refused
    ? `<p class="mr-note mr-refused">${escapeHtml(fill(t("models.warn.refused", lang), { consumer: t(row.labelKey, lang) }))}</p>`
    : "");
  const details = row.detailsHref
    ? `<a class="mr-details" href="/dashboard/settings${escapeHtml(row.detailsHref)}" data-turbo-frame="_top">${escapeHtml(t("models.ui.details", lang))}</a>`
    : "";
  const code = row.status?.code || "not_set";
  return `<article class="mr-row" data-row-id="${escapeHtml(row.id)}" data-status="${escapeHtml(code)}">
      <div class="mr-text">
        <h3 class="mr-label">${escapeHtml(t(row.labelKey, lang))}</h3>
        <p class="mr-job">${escapeHtml(t(row.jobKey, lang))}</p>
        ${model}
        <p class="mr-status mr-status-${escapeHtml(code)}">${escapeHtml(statusText(row, lang))}</p>
        ${note}
      </div>
      <div class="mr-actions">
        ${details}
        <button type="button" class="mr-change" data-role="${escapeHtml(row.id)}">${escapeHtml(t("models.ui.change", lang))}</button>
      </div>
    </article>`;
}

const STYLE = `<style>
  .mr-top { display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem 1rem; justify-content:space-between; margin-bottom:1rem; }
  .mr-top-links { display:flex; flex-wrap:wrap; gap:0.5rem 1rem; }
  .mr-btn, .mr-change { min-height:44px; padding:0 1rem; border-radius:var(--crow-radius-control); font:inherit; cursor:pointer; }
  .mr-add { background:var(--crow-accent); color:var(--crow-accent-contrast); border:0; }
  .mr-change { background:transparent; color:var(--crow-text-primary); border:1px solid var(--crow-border); }
  .mr-link { display:inline-flex; align-items:center; min-height:44px; color:var(--crow-accent); text-decoration:none; }
  .mr-group { margin-bottom:1.25rem; }
  .mr-group-title { font-size:0.8rem; text-transform:uppercase; letter-spacing:0.04em; color:var(--crow-text-muted); margin:0 0 0.5rem; }
  .mr-rows { display:flex; flex-direction:column; gap:0.5rem; }
  .mr-row { display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem 1rem; padding:0.85rem 1rem; background:var(--crow-bg-elevated); border:1px solid var(--crow-border); border-radius:var(--crow-radius-card); }
  .mr-text { flex:1 1 220px; min-width:0; }
  .mr-label { font-size:1rem; margin:0; }
  .mr-job { margin:0.15rem 0 0; font-size:0.85rem; color:var(--crow-text-secondary); }
  .mr-model { display:flex; flex-wrap:wrap; align-items:center; gap:0.4rem; margin-top:0.4rem; overflow-wrap:anywhere; }
  .mr-where { font-size:0.75rem; padding:0.1rem 0.5rem; border-radius:999px; border:1px solid var(--crow-border); color:var(--crow-text-secondary); }
  .mr-where-cloud, .mr-where-unproven, .mr-where-missing { color:var(--crow-text-primary); }
  .mr-status { margin:0.35rem 0 0; font-size:0.85rem; color:var(--crow-text-muted); }
  .mr-note { margin:0.25rem 0 0; font-size:0.8rem; color:var(--crow-text-muted); }
  .mr-actions { display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem; }
  .mr-details { display:inline-flex; align-items:center; min-height:44px; color:var(--crow-accent); text-decoration:none; font-size:0.9rem; }
</style>`;

/** The page from built rows (pure; `show` lists hidden roles to render anyway). */
export function renderModelsPage(rows, { lang = "en", show = [] } = {}) {
  const wanted = new Set(show);
  const visible = rows.filter((r) => !r.hidden || wanted.has(r.id));
  const groups = ROLE_GROUPS.map((g) => {
    const rs = visible.filter((r) => r.group === g.id);
    if (!rs.length) return "";
    return `<section class="mr-group" data-group="${escapeHtml(g.id)}">
      <h2 class="mr-group-title">${escapeHtml(t(g.id === "custom" ? "models.ui.yourRoles" : `models.group.${g.id}`, lang))}</h2>
      <div class="mr-rows">${rs.map((r) => rowHtml(r, lang)).join("")}</div>
    </section>`;
  }).join("");
  const showRerank = rows.some((r) => r.id === "rerank" && r.hidden && !wanted.has("rerank"))
    ? `<a class="mr-link" href="/dashboard/settings?section=models&amp;show=rerank" data-turbo-frame="_top">${escapeHtml(t("models.ui.showRerank", lang))}</a>`
    : "";
  return `${STYLE}
    <div class="mr-top">
      <button type="button" class="mr-btn mr-add" data-models-add>${escapeHtml(t("models.add.title", lang))}</button>
      <div class="mr-top-links">
        <a class="mr-link" href="/dashboard/settings?section=llm" data-turbo-frame="_top">${escapeHtml(t("models.ui.advanced", lang))}</a>
      </div>
    </div>
    ${groups}
    ${showRerank}`;
}

function showParam(req) {
  const s = req?.query?.show;
  return (Array.isArray(s) ? s : typeof s === "string" ? s.split(",") : []).map((x) => String(x).trim()).filter(Boolean);
}

/**
 * The menu preview never waits on DNS: a classifier named by hostname is
 * counted as configured without resolving it (the page itself resolves it).
 * Any address passes the tailnet check, so a name that would resolve off the
 * tailnet can overcount by one; the page shows the true state.
 */
export const noNetworkLookup = async () => [{ address: "127.0.0.1", family: 4 }];

/** "{n} of {total} roles ready" without any network wait. */
export async function modelsPreview(db, lang = "en", { classifierStatusFn } = {}) {
  const rows = await buildRoleRows(db, { classifierLookup: noNetworkLookup, ...(classifierStatusFn ? { classifierStatusFn } : {}) });
  const n = rows.filter((r) => FILLED_STATUSES.includes(r.status?.code)).length;
  return fill(t("models.ui.readyCount", lang), { n, total: rows.length });
}

export default {
  id: "models",
  group: "ai",
  navOrder: 1,
  // A view over role bindings and profiles; every write goes through /api/roles.
  scope: "mixed",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>`,
  labelKey: "settings.section.models",

  async getPreview({ db, lang = "en" }) {
    try { return await modelsPreview(db, lang); } catch { return ""; }
  },

  async render({ req, db, lang = "en" }) {
    const rows = await buildRoleRows(db, { lang });
    return renderModelsPage(rows, { lang, show: showParam(req) });
  },
};
