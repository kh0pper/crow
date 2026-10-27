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

/** What each "Start something" type needs: the bundle that makes it, and (Workspace files) the Blank kind. */
export const START_TYPES = [
  { id: "document", needs: "workspace", blank: "docx", labelKey: "shell.typeDocument", startKey: "shell.startDocument", tool: "ws_docs_create" },
  { id: "spreadsheet", needs: "workspace", blank: "xlsx", labelKey: "shell.typeSpreadsheet", startKey: "shell.startSpreadsheet", tool: "ws_sheets_create" },
  { id: "deck", needs: "workspace", blank: "pptx", labelKey: "shell.typeDeck", startKey: "shell.startDeck", tool: "ws_slides_create" },
  { id: "page", needs: "artifacts", blank: null, labelKey: "shell.typePage", startKey: "shell.startPage", tool: null },
  { id: "diagram", needs: "artifacts", blank: null, labelKey: "shell.typeDiagram", startKey: "shell.startDiagram", tool: null },
];

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
  if (workspace === "not_ready") out.push(offer(t("shell.workspaceNotReady", lang), t("shell.finishWorkspace", lang), "/dashboard/workspace"));
  return out.join("");
}

function when(iso, lang) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const text = new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  return `<time datetime="${esc(new Date(ms).toISOString())}">${esc(text)}</time>`;
}

/**
 * The tile's picture. ready: the stored capture. pending: the type tile, "Preview on its way", and
 * one re-check by client.js after 10 s. workspace: the type tile until Nextcloud's image loads
 * (client.js). Anything else: the type tile, with no line. Only make/previews.js builds the URLs.
 */
function previewBox(item, type, typeLabel, lang) {
  const attrs = `class="mk-preview mk-type-${esc(type)}" data-mk-preview="${esc(item.kind)}:${esc(item.ref)}" aria-hidden="true"`;
  const url = typeof item.previewUrl === "string" && item.previewUrl.startsWith("/dashboard/make/preview/") ? item.previewUrl : null;
  if (url && item.previewState === "ready") {
    return `<span ${attrs.replace('class="mk-preview ', 'class="mk-preview mk-preview-img ')}><img src="${esc(url)}" alt="" width="640" height="400" loading="lazy" decoding="async"></span>`;
  }
  if (url && item.previewState === "pending") {
    return `<span ${attrs} data-mk-pv-src="${esc(url)}" data-mk-pv-wait="10000">${esc(typeLabel)}<span class="mk-pending">${esc(t("shell.previewPending", lang))}</span></span>`;
  }
  if (url && item.previewState === "workspace") return `<span ${attrs} data-mk-pv-src="${esc(url)}" data-mk-pv-wait="0">${esc(typeLabel)}</span>`;
  return `<span ${attrs}>${esc(typeLabel)}</span>`;
}

/** Previews off: the switch, with what turning it on does. Previews on: at most one renderer line. */
function previewsBlock(previews, lang) {
  if (!previews) return "";
  if (!previews.enabled) {
    return `<div class="mk-previews-off"><p>${esc(t("shell.previewsNotEnabled", lang))}</p><p class="mk-disclosure">${esc(t("shell.previewsDisclosure", lang))}</p><form method="post" action="/dashboard/make/previews/enable"><input type="hidden" name="_csrf" value="${esc(previews.csrf || "")}"><input type="hidden" name="back" value="${esc(previews.back || ROUTE)}"><button type="submit" class="btn btn-secondary mk-start-act">${esc(t("shell.previewsEnable", lang))}</button></form></div>`;
  }
  return previews.lineKey ? `<p class="mk-notice mk-previews-line" role="status">${esc(t(previews.lineKey, lang))}</p>` : "";
}

function tile(item, lang) {
  const href = `${ROUTE}/open/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.ref)}`;
  const ws = item.kind === "workspace_file";
  const type = TYPES.includes(item.type) ? item.type : "other";
  const typeLabel = type === "other" ? "" : t(`shell.makeType.${type}`, lang);
  return `<li class="mk-cell" data-mk-kind="${esc(item.kind)}" data-mk-ref="${esc(item.ref)}" data-mk-title="${esc(item.title)}" data-mk-version="${esc(item.version ?? "")}" data-mk-project="${esc(item.projectId == null ? "unassigned" : item.projectId)}" data-mk-href="${esc(href)}"><a class="mk-tile${item.justMade ? " mk-just" : ""}" href="${esc(href)}"${ws ? ' target="_blank" rel="noopener"' : ""}>
    ${previewBox(item, type, typeLabel, lang)}
    <span class="mk-title">${esc(item.title)}</span>
    <span class="mk-meta">${item.justMade ? `<span class="mk-badge">${esc(t("shell.justMade", lang))}</span>` : ""}${item.cardId ? `<span class="mk-card">#${esc(item.cardId)}</span>` : ""}${when(item.updatedAt, lang)}</span>
  </a><button type="button" class="mk-more" data-mk-more aria-haspopup="dialog" aria-label="${esc(t("shell.moreFor", lang).split("{title}").join(item.title))}">⋮</button></li>`;
}

/** "installed" | "unavailable" count as usable (an unreachable Workspace is tried, and says so if it fails). */
function startState(type, artifacts, workspace) {
  const state = type.needs === "workspace" ? workspace : artifacts;
  if (state === "missing") return { href: `/dashboard/extensions?q=${type.needs}`, offerKey: type.needs === "workspace" ? "shell.getWorkspace" : "shell.getArtifacts" };
  if (state === "not_ready") return { href: "/dashboard/workspace", offerKey: "shell.finishWorkspace" };
  return null;
}

function startRow(type, artifacts, workspace, lang) {
  const label = esc(t(type.labelKey, lang));
  const off = startState(type, artifacts, workspace);
  if (off) {
    return `<li class="mk-start-row" data-mk-row="${type.id}"><span class="mk-start-name">${label}</span><a class="btn btn-secondary mk-start-act" href="${esc(off.href)}">${esc(t(off.offerKey, lang))}</a></li>`;
  }
  const blank = type.blank ? `<button type="button" class="btn btn-secondary mk-start-act" data-mk-blank="${type.blank}">${esc(t("shell.blank", lang))}</button>` : "";
  return `<li class="mk-start-row" data-mk-row="${type.id}"><button type="button" class="mk-start-type" data-mk-type="${type.id}">${label}</button>${blank}</li>`;
}

/** The "Start something" sheet: one row per type, then the composer (opened by client.js). */
export function renderStartSheet({ artifacts, workspace, project, lang }) {
  const proj = project || { id: "unassigned", name: t("shell.unassigned", lang) };
  const pills = START_TYPES.filter((ty) => !startState(ty, artifacts, workspace))
    .map((ty) => `<button type="button" class="mk-pill" data-mk-pill="${ty.id}">${esc(t(ty.labelKey, lang))}</button>`).join("");
  return `<dialog id="mk-start" class="mk-sheet" data-project="${esc(proj.id)}" aria-label="${esc(t("shell.start", lang))}">
    <div class="mk-sheet-inner">
      <div class="mk-sheet-head"><h2 class="mk-sheet-title">${esc(t("shell.start", lang))}</h2><button type="button" class="mk-sheet-close" data-mk-close aria-label="${esc(t("common.close", lang))}">&times;</button></div>
      <ul class="mk-start-list" data-mk-list>${START_TYPES.map((ty) => startRow(ty, artifacts, workspace, lang)).join("")}</ul>
      <form class="mk-composer" data-mk-composer hidden>
        <div class="mk-pills" data-mk-pills>${pills}</div>
        <span class="mk-project-chip" data-mk-chip>${esc(proj.name)}</span>
        <label class="mk-field mk-bot-field" data-mk-botrow>${esc(t("shell.bot", lang))}<select data-mk-bot></select></label>
        <label class="mk-field mk-title-field" data-mk-titlerow hidden>${esc(t("shell.blankTitle", lang))}<input type="text" maxlength="200" data-mk-title autocomplete="off"></label>
        <textarea class="mk-text" rows="4" data-mk-field aria-label="${esc(t("shell.start", lang))}"></textarea>
        <p class="mk-status" data-mk-status role="status"></p>
        <div class="mk-composer-actions"><button type="button" class="btn btn-secondary" data-mk-back>${esc(t("common.cancel", lang))}</button><button type="submit" class="btn btn-primary" data-mk-submit>${esc(t("shell.start", lang))}</button></div>
      </form>
    </div>
  </dialog>`;
}

/** The preview sheet (opened by a long press or the more button; filled by client.js). */
export function renderPreviewSheet({ projects, lang }) {
  const opts = [`<option value="unassigned">${esc(t("shell.unassigned", lang))}</option>`, ...(projects || []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)].join("");
  return `<dialog id="mk-preview" class="mk-sheet" aria-label="${esc(t("shell.preview", lang))}">
    <div class="mk-sheet-inner">
      <div class="mk-sheet-head"><h2 class="mk-sheet-title" data-mk-pv-title></h2><button type="button" class="mk-sheet-close" data-mk-pv-close aria-label="${esc(t("common.close", lang))}">&times;</button></div>
      <button type="button" class="mk-vline" data-mk-vline hidden></button>
      <ul class="mk-versions" data-mk-versions hidden></ul>
      <a class="btn btn-primary mk-start-act" data-mk-pv-open href="#">${esc(t("shell.open", lang))}</a>
      <label class="mk-field">${esc(t("shell.moveToProject", lang))}<select data-mk-pv-project>${opts}</select></label>
      <button type="button" class="btn btn-secondary mk-start-act" data-mk-pv-move>${esc(t("shell.moveToProject", lang))}</button>
      <p class="mk-status" data-mk-pv-status role="status"></p>
    </div>
  </dialog>`;
}

/** @param {{items: object[], artifacts: string, workspace: string}} model */
export function renderMakePage({ model, filter, lang, project, projects = [], previews = null }) {
  const { items, artifacts, workspace } = model;
  const bothMissing = artifacts === "missing" && workspace === "missing";
  const notice = workspace === "unavailable" ? `<p class="mk-notice" role="status">${esc(t("shell.workspaceUnavailable", lang))}</p>` : "";
  let body;
  if (bothMissing) body = `<div class="mk-empty">${offers(artifacts, workspace, lang)}</div>`;
  else if (!items.length) body = `${offers(artifacts, workspace, lang)}<p class="mk-empty-text">${esc(t("shell.makeEmpty", lang))}</p>`;
  else body = `${offers(artifacts, workspace, lang)}<ul class="mk-grid">${items.map((i) => tile(i, lang)).join("")}</ul>`;
  const startBtn = `<button type="button" class="btn btn-primary mk-start-btn" data-mk-open aria-haspopup="dialog">+ ${esc(t("shell.start", lang))}</button>`;
  const pv = bothMissing ? "" : previewsBlock(previews, lang);
  return `<div class="mk-page"><div class="mk-bar">${chips(filter, lang)}${startBtn}</div>${pv}${notice}${body}${renderStartSheet({ artifacts, workspace, project, lang })}${renderPreviewSheet({ projects, lang })}</div>`;
}
