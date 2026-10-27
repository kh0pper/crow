/**
 * Make panel: the gallery page. Pure HTML from the model sources.js builds; no file or DB access.
 * Filter chips are plain links (?filter=), so they work with Turbo and without JS. Every tile is a
 * link to the open route, which decides where it really goes; a Workspace tile opens in a new tab
 * so Make stays where it was.
 */
import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";

const esc = (v) => escapeHtml(v === null || v === undefined ? "" : String(v));
const ROUTE = "/dashboard/make";

export const FILTERS = [
  { id: "all", key: "shell.makeAll" },
  { id: "documents", key: "shell.makeDocs" },
  { id: "pages", key: "shell.makePages" },
  { id: "shared", key: "shell.makeShared" },
];
const TYPES = ["document", "spreadsheet", "deck", "page", "diagram"];

function chips(active, lang) {
  return `<nav class="mk-chips" aria-label="${esc(t("shell.tabMake", lang))}">${FILTERS.map((f) => {
    const on = f.id === active;
    const href = f.id === "all" ? ROUTE : `${ROUTE}?filter=${f.id}`;
    return `<a class="mk-chip${on ? " mk-chip-on" : ""}" href="${href}"${on ? ' aria-current="page"' : ""}>${esc(t(f.key, lang))}</a>`;
  }).join("")}</nav>`;
}

function offer(text, label, href) {
  return `<div class="mk-offer"><p>${esc(text)}</p><a class="btn btn-primary" href="${esc(href)}">${esc(label)}</a></div>`;
}

function offers(artifacts, workspace, lang) {
  const out = [];
  if (artifacts === "missing") out.push(offer(t("shell.needArtifacts", lang), t("shell.getArtifacts", lang), "/dashboard/extensions?q=artifacts"));
  if (workspace === "missing") out.push(offer(t("shell.needWorkspace", lang), t("shell.getWorkspace", lang), "/dashboard/extensions?q=workspace"));
  if (workspace === "not_ready") out.push(offer(t("shell.finishWorkspace", lang), t("shell.finishWorkspace", lang), "/dashboard/workspace"));
  return out.join("");
}

function when(iso, lang) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const text = new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  return `<time datetime="${esc(new Date(ms).toISOString())}">${esc(text)}</time>`;
}

function tile(item, lang) {
  const href = `${ROUTE}/open/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.ref)}`;
  const ws = item.kind === "workspace_file";
  const type = TYPES.includes(item.type) ? item.type : "other";
  const typeLabel = type === "other" ? "" : t(`shell.makeType.${type}`, lang);
  return `<li class="mk-cell"><a class="mk-tile${item.justMade ? " mk-just" : ""}" href="${esc(href)}"${ws ? ' target="_blank" rel="noopener"' : ""}>
    <span class="mk-preview mk-type-${esc(type)}" data-mk-preview="${esc(item.kind)}:${esc(item.ref)}" aria-hidden="true">${esc(typeLabel)}</span>
    <span class="mk-title">${esc(item.title)}</span>
    <span class="mk-meta">${item.justMade ? `<span class="mk-badge">${esc(t("shell.justMade", lang))}</span>` : ""}${item.cardId ? `<span class="mk-card">#${esc(item.cardId)}</span>` : ""}${when(item.updatedAt, lang)}</span>
  </a></li>`;
}

/** @param {{items: object[], artifacts: string, workspace: string}} model */
export function renderMakePage({ model, filter, lang }) {
  const { items, artifacts, workspace } = model;
  const bothMissing = artifacts === "missing" && workspace === "missing";
  const notice = workspace === "unavailable" ? `<p class="mk-notice" role="status">${esc(t("shell.workspaceUnavailable", lang))}</p>` : "";
  let body;
  if (bothMissing) body = `<div class="mk-empty">${offers(artifacts, workspace, lang)}</div>`;
  else if (!items.length) body = `${offers(artifacts, workspace, lang)}<p class="mk-empty-text">${esc(t("shell.makeEmpty", lang))}</p>`;
  else body = `${offers(artifacts, workspace, lang)}<ul class="mk-grid">${items.map((i) => tile(i, lang)).join("")}</ul>`;
  return `<div class="mk-page">${chips(filter, lang)}${notice}${body}</div>`;
}
