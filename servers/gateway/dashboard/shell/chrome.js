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
import { needsYouLabel } from "../panels/board/needs-you-label.js";

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
  // The classic home. A bare /dashboard/nest sends a new-mode device to Chat,
  // so this way in asks for the nest explicitly (?open=1).
  { id: "nest", fallback: "Crow's Nest", route: "/dashboard/nest?open=1" },
].map((e) => ({ route: `/dashboard/${e.id}`, key: `nav.${e.id}`, ...e }));

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
export function tabTargets(getPanel = registryGetPanel, projectSlug = null) {
  const q = projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : "";
  return [
    { id: "chat", href: projectSlug ? `/dashboard/project/${encodeURIComponent(projectSlug)}` : "/dashboard/perch", key: "shell.tabChat" },
    { id: "board", href: getPanel("board") ? `/dashboard/board${q}` : "/dashboard/bot-board", key: "shell.tabBoard" },
    { id: "make", href: getPanel("make") ? `/dashboard/make${q}` : getPanel("artifacts") ? "/dashboard/artifacts" : "/dashboard/extensions?q=artifacts", key: "shell.tabMake" },
  ];
}

/**
 * A project's colour: one of six fixed custom properties (defined in css.js,
 * each at least 3:1 against the drawer background in light and dark), chosen
 * by an FNV-1a hash of the slug so a project keeps its colour everywhere.
 */
export function projectColor(slug) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(String(slug ?? ""), "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `var(--shell-project-c${(h % 6) + 1})`;
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
 * The project rows, one form POSTing /dashboard/scope for the Everything and
 * Unassigned buttons; each project is a link to its home. `return` is filled
 * by the client with the current path so a scope change lands back here.
 * The hidden _csrf is filled from the crow_csrf cookie at submit time for the
 * Turbo-off case (with Turbo on, the layout's submit hook sends the header).
 */
function projectForm({ scope, projects, lang, counts, homeSlug, extraClass = "" }) {
  const cur = currentValue(scope, projects);
  const btn = (value, text, sub = "") =>
    `<button type="submit" class="shell-project${value === cur ? " is-current" : ""}" name="scope" value="${escapeHtml(value)}"${value === cur ? ' aria-current="true"' : ""}><span class="shell-project-text"><span class="shell-project-name">${escapeHtml(text)}</span>${sub ? `<span class="shell-project-sub">${escapeHtml(sub)}</span>` : ""}</span></button>`;
  // Projects that share a display name (case-insensitive, trimmed) show their
  // slug as a muted second line so the rows can be told apart.
  const nameKey = (p) => String(p.name ?? "").trim().toLowerCase();
  const nameCount = new Map();
  for (const p of projects || []) nameCount.set(nameKey(p), (nameCount.get(nameKey(p)) || 0) + 1);
  const link = (p) => {
    const slug = projectValue(p);
    const dup = nameCount.get(nameKey(p)) > 1;
    const slugLine = dup ? `<span class="shell-project-sub shell-project-slug">${escapeHtml(slug)}</span>` : "";
    // On a project's home its link is the current page; elsewhere the project
    // the scope points at is marked the same way, as the current item only.
    const open = homeSlug != null && homeSlug === slug;
    const scoped = !open && homeSlug == null && cur === slug;
    const lbl = counts instanceof Map && counts.has(Number(p.id)) ? needsYouLabel(counts.get(Number(p.id)), lang) : null;
    const mark = open ? ' aria-current="page"' : scoped ? ' aria-current="true"' : "";
    return `<a href="/dashboard/project/${encodeURIComponent(slug)}" class="shell-project${open || scoped ? " is-current" : ""}"${mark}><span class="shell-project-dot" style="background:${projectColor(slug)}" aria-hidden="true"></span><span class="shell-project-text"><span class="shell-project-name">${escapeHtml(p.name)}</span>${slugLine}${lbl ? `<span class="shell-project-sub">${lbl === "?" ? `<span aria-hidden="true">?</span><span class="shell-sr">${escapeHtml(t("shell.cantCount", lang))}</span>` : escapeHtml(lbl)}</span>` : ""}</span></a>`;
  };
  const edge = (href, text) => `<a href="${href}" class="shell-project shell-project--edge"><span class="shell-project-text"><span class="shell-project-name">${escapeHtml(text)}</span></span></a>`;
  const rows = [
    btn("all", t("shell.everything", lang), t("shell.everythingSub", lang)),
    ...(projects || []).map(link),
    btn("unassigned", t("shell.unassigned", lang)),
    edge("/dashboard/projects?new=1", t("shell.newProject", lang)),
  ].join("");
  return `<form class="shell-projects${extraClass}" method="post" action="/dashboard/scope"><input type="hidden" name="return" value=""><input type="hidden" name="_csrf" value="">${rows}</form>`;
}

/** The "More of Crow" row: a details whose summary names the first four entries. */
function moreDetails({ lang, getPanel }) {
  // Labels follow the classic sidebar's rule: the nav.<id> translation, else
  // the panel's own manifest name, else a plain fallback.
  const entries = MORE_ENTRIES.map((e) => ({ e, panel: getPanel(e.id) })).filter((x) => x.panel)
    .map(({ e, panel }) => ({ e, text: label(e.key, panel.name || e.fallback, lang) }));
  if (!entries.length) return "";
  const sub = entries.slice(0, 4).map((x) => x.text).join(", ") + "…";
  const grid = entries.map(({ e, text }) => `<a href="${e.route}" class="shell-more-item">${escapeHtml(text)}</a>`).join("");
  return `<details class="shell-more-row"><summary class="shell-project"><span class="shell-project-text"><span class="shell-project-name">${escapeHtml(t("shell.more", lang))}</span><span class="shell-project-sub">${escapeHtml(sub)}</span></span></summary><div class="shell-more">${grid}</div></details>`;
}

/** The archived-projects link, the last row. */
function archivedLink(lang) {
  return `<a href="/dashboard/projects?status=archived" class="shell-project shell-project--edge"><span class="shell-project-text"><span class="shell-project-name">${escapeHtml(t("shell.archivedProjects", lang))}</span></span></a>`;
}

/** The Chat / Board / Make nav, rendered right after </main>. */
export function shellTabsNav({ tab, scope, projects, lang, counts, homeSlug, getPanel = registryGetPanel }) {
  const sp = scopedProject(scope, projects);
  // "Board · N" counts the scoped project's cards needing you, so it matches
  // the Board; "Chat · N" its chats waiting on you (the counts Map's `.parts`).
  // Without the split (an older Map), the Board shows the total as before.
  // An unknown count or 0 shows none.
  const total = sp && counts instanceof Map ? counts.get(Number(sp.id)) : null;
  const part = sp && counts instanceof Map && counts.parts instanceof Map ? counts.parts.get(Number(sp.id)) : null;
  const badge = { board: part ? part.cards : total, chat: part ? part.chats : null };
  const links = tabTargets(getPanel, sp ? projectValue(sp) : null).map((tt) => {
    const current = tt.id === tab ? ' aria-current="page"' : "";
    const n = badge[tt.id];
    const text = t(tt.key, lang) + (typeof n === "number" && n > 0 ? ` · ${n}` : "");
    return `<a href="${tt.href}" class="shell-tab" data-shell-tab="${tt.id}"${current}>${TAB_ICONS[tt.id]}<span>${escapeHtml(text)}</span></a>`;
  }).join("");
  return `<nav class="shell-tabs" aria-label="Crow">
      <div class="shell-rail-mark">${crowMarkSvg({ size: 32 })}<span>Crow</span></div>
      <div class="shell-tab-list">${links}</div>
      <div class="shell-rail-projects">
        <h3 class="shell-heading">${escapeHtml(t("shell.projects", lang))}</h3>
        ${projectForm({ scope, projects, lang, counts, homeSlug, extraClass: " shell-projects--rail" })}
        ${moreDetails({ lang, getPanel })}
        ${archivedLink(lang)}
      </div>
    </nav>`;
}

/**
 * One launcher tile: an app (data-app-id/-kind; a desktop app may open as a
 * tile in the open session, shell/client.js) or an extra tile
 * (apps/extra-tiles.js, always a page link). `icon` is trusted markup from
 * shared/app-icons.js. A direct-mode app carries its port and path, and the
 * client points the link at https://<hostname>:<port><path>; the href here is
 * its no-JS fallback. A link out of the dashboard skips Turbo.
 */
export function launcherTileHtml(x, { extra = false } = {}) {
  const href = String(x.href || "/dashboard/extensions");
  const attrs = extra
    ? ` data-launcher-tile="${escapeHtml(x.id)}"`
    : ` data-app-id="${escapeHtml(x.id)}" data-app-kind="${x.kind === "desktop" ? "desktop" : "page"}"` +
      (x.directPort != null ? ` data-direct-port="${escapeHtml(String(x.directPort))}" data-direct-path="${escapeHtml(String(x.path || "/"))}"` : "");
  const turbo = href.startsWith("/dashboard/") ? "" : ' data-turbo="false"';
  return `<a href="${escapeHtml(href)}" class="shell-app${extra ? " shell-app--extra" : ""}"${attrs}${turbo}><span class="shell-app-icon" aria-hidden="true">${x.icon || ""}</span><span class="shell-app-label">${escapeHtml(x.label)}</span></a>`;
}

/** A grid's tiles: the apps, an empty line when there are none, then the extra tiles. */
export function launcherGridHtml({ apps, tiles, view, lang }) {
  const list = Array.isArray(apps) ? apps : [];
  let empty = "";
  if (!list.length) {
    empty = view === "project"
      ? `<p class="shell-apps-empty">${escapeHtml(t("shell.appsEmptyProject", lang))} · <button type="button" class="shell-apps-goto" data-apps-goto="all">${escapeHtml(t("shell.appsAll", lang))}</button></p>`
      : `<p class="shell-apps-empty">${escapeHtml(t("shell.appsEmptyAll", lang))} · <a href="/dashboard/extensions">${escapeHtml(label("nav.extensions", "Extensions", lang))}</a></p>`;
  }
  return list.map((a) => launcherTileHtml(a)).join("") + empty + (Array.isArray(tiles) ? tiles : []).map((x) => launcherTileHtml(x, { extra: true })).join("");
}

/**
 * The drawer's Apps section (new mode): a This project / All apps switch
 * (This project only when the scope is one project) over a 4-column grid,
 * rendered for the current scope (apps/launcher.js launcherFor). All, under a
 * project scope, is fetched on the first switch (GET /dashboard/shell-api/apps).
 */
function appsSection({ apps, lang }) {
  if (!apps || typeof apps !== "object") return "";
  const isProject = apps.scope === "project" && apps.projectSlug;
  const view = isProject ? "project" : "all";
  const chip = (v, key, on) =>
    `<button type="button" class="shell-apps-chip" data-apps-view="${v}" aria-pressed="${on ? "true" : "false"}">${escapeHtml(t(key, lang))}</button>`;
  const chips = isProject
    ? `<div class="shell-apps-chips" role="group" aria-label="${escapeHtml(t("shell.appsShow", lang))}">${chip("project", "shell.appsThisProject", true)}${chip("all", "shell.appsAll", false)}</div>`
    : `<div class="shell-apps-chips" role="group" aria-label="${escapeHtml(t("shell.appsShow", lang))}">${chip("all", "shell.appsAll", true)}</div>`;
  const grid = `<div class="shell-apps-grid" data-apps-grid="${view}" data-loaded="1">${launcherGridHtml({ apps: apps.apps, tiles: apps.tiles, view, lang })}</div>`;
  const allGrid = isProject ? '<div class="shell-apps-grid" data-apps-grid="all" hidden></div>' : "";
  return `<section class="shell-apps" aria-labelledby="shell-apps-title" data-apps-loading="${escapeHtml(t("shell.appsLoading", lang))}" data-apps-failed="${escapeHtml(t("shell.appsLoadFailed", lang))}" data-apps-empty-all="${escapeHtml(t("shell.appsEmptyAll", lang))}">
        <h3 class="shell-heading" id="shell-apps-title">${escapeHtml(t("shell.apps", lang))}</h3>
        ${chips}${grid}${allGrid}
      </section>`;
}

/** The drawer: projects, the Apps launcher (new mode), then the "More of Crow" grid. */
export function shellDrawer({ scope, projects, lang, counts, homeSlug, apps, getPanel = registryGetPanel }) {
  return `<dialog id="shell-drawer" class="shell-sheet shell-drawer" aria-labelledby="shell-drawer-title">
    <div class="shell-sheet-inner">
      ${closeButton(lang)}
      <h3 class="shell-heading" id="shell-drawer-title">${escapeHtml(t("shell.projects", lang))}</h3>
      ${projectForm({ scope, projects, lang, counts, homeSlug })}
      ${appsSection({ apps, lang })}
      ${moreDetails({ lang, getPanel })}
      ${archivedLink(lang)}
    </div>
  </dialog>`;
}

/**
 * The account sheet: Settings, Models, What Crow can reach, and the classic
 * switch. With `tray` (the header bird's or bell's notifications tray,
 * notifications.js, trusted server markup) it is the ONE "Notifications and
 * settings" sheet the mascot opens (phone review 2026-10-29): the tray first,
 * then the settings links, and no separate avatar button exists.
 */
export function shellAvatarSheet({ lang, tray }) {
  const settings = label("nav.settings", "Settings", lang);
  const merged = typeof tray === "string" && tray !== "";
  const name = escapeHtml(t(merged ? "shell.notifSettings" : "shell.account", lang));
  return `<dialog id="shell-avatar" class="shell-sheet shell-avatar-sheet${merged ? " shell-crow-sheet" : ""}" aria-label="${name}">
    <div class="shell-sheet-inner">
      ${closeButton(lang)}${merged ? `
      <section class="shell-attention" data-shell-attention></section>
      <h3 class="shell-heading shell-crow-heading">${escapeHtml(t("notif.notifications", lang))}</h3>
      <div class="shell-crow-tray">${tray}</div>
      <hr class="shell-crow-sep">` : ""}
      <a href="/dashboard/settings" class="shell-sheet-link">${escapeHtml(settings)}</a>
      <a href="/dashboard/settings?section=models" class="shell-sheet-link">${escapeHtml(t("settings.section.models", lang))}</a>
      <a href="/dashboard/settings?section=integrations" class="shell-sheet-link">${escapeHtml(t("shell.reach", lang))}</a>
      <form method="post" action="/dashboard/mode" class="shell-mode-form"><input type="hidden" name="_csrf" value=""><input type="hidden" name="mode" value="classic"><button type="submit" class="shell-sheet-link shell-mode-btn">${escapeHtml(t("shell.useClassic", lang))}</button></form>
    </div>
  </dialog>`;
}

/**
 * The one-time "Try the new Crow" card, shown above a classic page's content
 * while crow_try_new is "pending". "Try it" switches this device to the new
 * shell; "Not now" dismisses the card for good. The hidden _csrf is filled
 * from the crow_csrf cookie at submit time (the Turbo-off path).
 */
export function tryNewCardHtml(lang) {
  const fill = "var f=this.querySelector('input[name=_csrf]');var m=document.cookie.match(/(?:^|;\\s*)crow_csrf=([^;]*)/);if(f&&m)f.value=decodeURIComponent(m[1]);";
  const style = "display:flex;flex-wrap:wrap;align-items:center;gap:0.75rem 1rem;padding:1rem;margin-bottom:1rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card)";
  const btn = "min-height:44px;padding:0 1rem;border-radius:var(--crow-radius-control);font:inherit;cursor:pointer";
  return `<aside class="try-new-card" style="${style}">
    <div style="flex:1;min-width:200px"><strong>${escapeHtml(t("shell.tryTitle", lang))}</strong><div style="color:var(--crow-text-secondary);font-size:0.9rem">${escapeHtml(t("shell.tryBody", lang))}</div></div>
    <form method="post" action="/dashboard/mode" onsubmit="${escapeHtml(fill)}" style="margin:0"><input type="hidden" name="_csrf" value=""><input type="hidden" name="mode" value="new"><button type="submit" style="${btn};background:var(--crow-accent);color:var(--crow-accent-contrast);border:0">${escapeHtml(t("shell.tryNow", lang))}</button></form>
    <form method="post" action="/dashboard/mode/try-dismiss" onsubmit="${escapeHtml(fill + "this.return.value=location.pathname+location.search;")}" style="margin:0"><input type="hidden" name="_csrf" value=""><input type="hidden" name="return" value=""><button type="submit" style="${btn};background:transparent;color:var(--crow-text-secondary);border:1px solid var(--crow-border)">${escapeHtml(t("shell.notNow", lang))}</button></form>
  </aside>`;
}
