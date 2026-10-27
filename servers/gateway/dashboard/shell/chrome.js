/**
 * The new shell's chrome (redesign P2): the project chip and avatar button
 * that sit in the dashboard's own .content-header, the Chat / Board / Make
 * tab bar (a bottom bar on phones, a left rail with the project list on
 * desktop), the drawer (projects + "More of Crow") and the avatar sheet.
 *
 * renderLayout({ variant: "shell" }) composes these around the SAME
 * .main-content › .content-header › instance strip › .content-body chain the
 * classic layout renders, so panels, the header bird (tap → tray, long-press
 * → Talk to Crow), the player bar and the toasts all keep working unchanged.
 *
 * Every piece here is plain server-rendered HTML; shell/client.js wires the
 * two <dialog>s. All user-supplied text (project names) is escaped.
 */

import { escapeHtml } from "../shared/components.js";
import { t } from "../shared/i18n.js";
import { crowMarkSvg } from "../shared/crow-mark.js";
import { getPanel as registryGetPanel } from "../panel-registry.js";

// Inline 24px stroke icons, decorative (the label carries the meaning).
const ICON_ATTRS = 'width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const TAB_ICONS = {
  chat: `<svg ${ICON_ATTRS}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>`,
  board: `<svg ${ICON_ATTRS}><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/></svg>`,
  make: `<svg ${ICON_ATTRS}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>`,
};
const AVATAR_ICON = `<svg ${ICON_ATTRS}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`;
const CLOSE_ICON = `<svg ${ICON_ATTRS}><path d="M18 6L6 18M6 6l12 12"/></svg>`;
const CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><polyline points="6 9 12 15 18 9"/></svg>';

/**
 * The "More of Crow" grid. An entry renders only when its panel is
 * registered on this gateway, so the drawer never links to a 404.
 */
const MORE_ENTRIES = [
  { id: "messages", fallback: "Messages" },
  { id: "bot-builder", fallback: "Bots" },
  { id: "schedule", fallback: "Schedules" },
  { id: "memory", fallback: "Memory" },
  { id: "media", fallback: "Media" },
  { id: "ramble", fallback: "Ramble" },
  { id: "extensions", fallback: "Extensions" },
  { id: "model-catalog", fallback: "Models" },
].map((e) => ({ ...e, route: `/dashboard/${e.id}`, key: `nav.${e.id}` }));

/** The sheet's own close button (Escape and a backdrop tap also close it). */
function closeButton(lang) {
  return `<button type="button" class="shell-sheet-close" aria-label="${escapeHtml(t("common.close", lang))}">${CLOSE_ICON}</button>`;
}

function label(key, fallback, lang) {
  const v = t(key, lang);
  return v === key ? fallback : v;
}

/** The scope's value in the /dashboard/scope form ("all" | "unassigned" | slug). */
function projectValue(p) {
  return p.slug != null && p.slug !== "" ? String(p.slug) : String(p.id);
}

/** The project the scope points at, or null. Accepts parseScope's shape or a slug. */
function scopedProject(scope, projects) {
  if (!scope || scope.all || scope.unassigned) return null;
  return (projects || []).find((p) =>
    (scope.projectId != null && Number(p.id) === Number(scope.projectId)) ||
    (scope.slug != null && p.slug === scope.slug)) || null;
}

/** The chip's text: the project's name, "Everything" or "Unassigned". */
export function scopeLabel(scope, projects, lang) {
  if (scope && scope.unassigned) return t("shell.unassigned", lang);
  const p = scopedProject(scope, projects);
  return p ? String(p.name) : t("shell.everything", lang);
}

/** The value of the scope currently in force ("all" | "unassigned" | slug). */
function currentValue(scope, projects) {
  if (scope && scope.unassigned) return "unassigned";
  const p = scopedProject(scope, projects);
  return p ? projectValue(p) : "all";
}

/**
 * Board and Make fall back to today's panels until P3/P4 register theirs.
 * Artifacts is a bundle, so with neither make nor artifacts installed the
 * Make tab points at the Extensions page, filtered to it.
 */
export function tabTargets(getPanel = registryGetPanel) {
  return [
    { id: "chat", href: "/dashboard/perch", key: "shell.tabChat" },
    { id: "board", href: getPanel("board") ? "/dashboard/board" : "/dashboard/bot-board", key: "shell.tabBoard" },
    { id: "make", href: getPanel("make") ? "/dashboard/make" : getPanel("artifacts") ? "/dashboard/artifacts" : "/dashboard/extensions?q=artifacts", key: "shell.tabMake" },
  ];
}

/** The project chip, rendered inside .content-header (before the header icons). */
export function shellHeaderChip({ scope, projects, lang }) {
  const text = escapeHtml(scopeLabel(scope, projects, lang));
  const switchLabel = escapeHtml(t("shell.switchScope", lang));
  return `<button type="button" class="shell-scope" aria-haspopup="dialog" aria-controls="shell-drawer" title="${switchLabel}" data-shell-open="shell-drawer"><span class="shell-scope-name">${text}</span>${CHEVRON}</button>`;
}

/** The avatar button, the header's last item; opens the avatar sheet. */
export function shellAvatarButton({ lang }) {
  return `<button type="button" class="shell-avatar" aria-haspopup="dialog" aria-controls="shell-avatar" aria-label="${escapeHtml(t("shell.account", lang))}" data-shell-open="shell-avatar">${AVATAR_ICON}</button>`;
}

/**
 * The project buttons, one form POSTing /dashboard/scope. `return` is filled
 * by the client with the current path so the scope change lands back here.
 * The hidden _csrf is filled from the crow_csrf cookie at submit time for the
 * Turbo-off case (with Turbo on, the layout's submit hook sends the header).
 */
function projectForm({ scope, projects, lang, extraClass = "" }) {
  const cur = currentValue(scope, projects);
  const btn = (value, text) =>
    `<button type="submit" class="shell-project${value === cur ? " is-current" : ""}" name="scope" value="${escapeHtml(value)}"${value === cur ? ' aria-current="true"' : ""}>${escapeHtml(text)}</button>`;
  const rows = [
    btn("all", t("shell.everything", lang)),
    ...(projects || []).map((p) => btn(projectValue(p), p.name)),
    btn("unassigned", t("shell.unassigned", lang)),
  ].join("");
  return `<form class="shell-projects${extraClass}" method="post" action="/dashboard/scope"><input type="hidden" name="return" value=""><input type="hidden" name="_csrf" value="">${rows}</form>`;
}

/** The Chat / Board / Make nav, rendered right after </main>. */
export function shellTabsNav({ tab, scope, projects, lang, getPanel = registryGetPanel }) {
  const links = tabTargets(getPanel).map((tt) => {
    const current = tt.id === tab ? ' aria-current="page"' : "";
    return `<a href="${tt.href}" class="shell-tab"${current}>${TAB_ICONS[tt.id]}<span>${escapeHtml(t(tt.key, lang))}</span></a>`;
  }).join("");
  return `<nav class="shell-tabs" aria-label="Crow">
      <div class="shell-rail-mark">${crowMarkSvg({ size: 32 })}<span>Crow</span></div>
      <div class="shell-tab-list">${links}</div>
      <div class="shell-rail-projects">
        <h3 class="shell-heading">${escapeHtml(t("shell.projects", lang))}</h3>
        ${projectForm({ scope, projects, lang, extraClass: " shell-projects--rail" })}
      </div>
    </nav>`;
}

/** The drawer: projects, then the "More of Crow" grid. */
export function shellDrawer({ scope, projects, lang, getPanel = registryGetPanel }) {
  // Labels follow the classic sidebar's rule: the nav.<id> translation, else
  // the panel's own manifest name, else a plain fallback.
  const more = MORE_ENTRIES.map((e) => ({ e, panel: getPanel(e.id) })).filter((x) => x.panel).map(({ e, panel }) =>
    `<a href="${e.route}" class="shell-more-item">${escapeHtml(label(e.key, panel.name || e.fallback, lang))}</a>`).join("");
  return `<dialog id="shell-drawer" class="shell-sheet shell-drawer" aria-labelledby="shell-drawer-title">
    <div class="shell-sheet-inner">
      ${closeButton(lang)}
      <h3 class="shell-heading" id="shell-drawer-title">${escapeHtml(t("shell.projects", lang))}</h3>
      ${projectForm({ scope, projects, lang })}
      ${more ? `<h3 class="shell-heading">${escapeHtml(t("shell.more", lang))}</h3>
      <div class="shell-more">${more}</div>` : ""}
    </div>
  </dialog>`;
}

/** The avatar sheet: Settings, What Crow can reach, and the classic switch. */
export function shellAvatarSheet({ lang }) {
  const settings = label("nav.settings", "Settings", lang);
  return `<dialog id="shell-avatar" class="shell-sheet shell-avatar-sheet" aria-label="${escapeHtml(t("shell.account", lang))}">
    <div class="shell-sheet-inner">
      ${closeButton(lang)}
      <a href="/dashboard/settings" class="shell-sheet-link">${escapeHtml(settings)}</a>
      <a href="/dashboard/settings?section=integrations" class="shell-sheet-link">${escapeHtml(t("shell.reach", lang))}</a>
      <form method="post" action="/dashboard/mode" class="shell-mode-form"><input type="hidden" name="_csrf" value=""><input type="hidden" name="mode" value="classic"><button type="submit" class="shell-sheet-link shell-mode-btn">${escapeHtml(t("shell.useClassic", lang))}</button></form>
    </div>
  </dialog>`;
}
