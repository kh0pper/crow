/**
 * Extensions Panel — HTML Builders
 *
 * ICON_MAP, CATEGORY_COLORS, helper functions, and
 * the full page-content HTML builder for the extensions/add-ons store panel.
 */

import { escapeHtml, badge, formatDate } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { getAddonLogo } from "../../shared/logos.js";
import { detectGpuArch, checkGpuArchCompatible, detectGpuVramGb } from "../../../gpu-arch.js";
import { DISPLAY_GROUPS, groupAddons, groupForCategory } from "./groups.js";

/** Add-ons shown per group before "Show all" — a fixed count, deliberately not
 *  "two grid rows" (which would need viewport-dependent column measurement). */
export const GROUP_SHOWN = 8;

export const ICON_MAP = {
  brain: "\u{1F9E0}",
  cloud: "☁️",
  image: "\u{1F5BC}️",
  book: "\u{1F4D6}",
  home: "\u{1F3E0}",
  archive: "\u{1F4E6}",
  mic: "\u{1F3A4}",
  music: "\u{1F3B5}",
  rss: "\u{1F4F0}",
  "message-circle": "\u{1F4AC}",
  gamepad: "\u{1F3AE}",
  "file-text": "\u{1F4C4}",
  "phone-video": "\u{1F4F9}",
  bell: "\u{1F514}",
  radio: "\u{1F4E1}",
  bookmark: "\u{1F516}",
  "check-square": "✅",
  dollar: "\u{1F4B0}",
  document: "\u{1F4D1}",
  activity: "\u{1F4C8}",
  git: "\u{1F33F}",
  lock: "\u{1F512}",
  search: "\u{1F50D}",
  shield: "\u{1F6E1}️",
  activity: "\u{1F4C8}",
  eye: "\u{1F441}️",
  "graduation-cap": "\u{1F393}",
  cpu: "\u{1F9EE}",
};

/**
 * Emoji for an icon name — own-property lookup only.
 * A bare `ICON_MAP[name]` inherits from Object.prototype, so an icon of
 * "constructor" or "toString" would return a *function* that stringifies into
 * the page. Registry data is repo-shipped today; community stores are not.
 * @returns {string|null}
 */
export function iconEmoji(name) {
  if (typeof name !== "string") return null;
  return Object.hasOwn(ICON_MAP, name) ? ICON_MAP[name] : null;
}

/** Collection card icon, with the generic-package default. */
function collectionIcon(name) {
  return iconEmoji(name) || "\u{1F4E6}";
}

export const CATEGORY_COLORS = {
  ai:           { bg: "rgba(168,85,247,0.12)", color: "#a855f7" },
  media:        { bg: "rgba(251,191,36,0.12)", color: "#fbbf24" },
  productivity: { bg: "rgba(59,130,246,0.12)", color: "#3b82f6" },
  storage:      { bg: "rgba(34,197,94,0.12)",  color: "#22c55e" },
  "smart-home": { bg: "rgba(251,146,60,0.12)", color: "#fb923c" },
  networking:   { bg: "rgba(56,189,248,0.12)", color: "#38bdf8" },
  gaming:       { bg: "rgba(244,63,94,0.12)",  color: "#f43f5e" },
  data:         { bg: "rgba(14,165,233,0.12)",  color: "#0ea5e9" },
  social:         { bg: "rgba(236,72,153,0.12)", color: "#ec4899" },
  finance:        { bg: "rgba(245,158,11,0.12)", color: "#f59e0b" },
  infrastructure: { bg: "rgba(148,163,184,0.12)", color: "#94a3b8" },
  automation:     { bg: "rgba(45,212,191,0.12)", color: "#2dd4bf" },
  education:      { bg: "rgba(132,204,22,0.12)",  color: "#84cc16" },
  "federated-social": { bg: "rgba(217,70,239,0.12)",  color: "#d946ef" },
  "federated-media":  { bg: "rgba(236,72,153,0.12)",  color: "#f472b6" },
  "federated-comms":  { bg: "rgba(167,139,250,0.12)", color: "#a78bfa" },
  cameras:        { bg: "rgba(239,68,68,0.12)",   color: "#ef4444" },
  other:          { bg: "rgba(161,161,170,0.12)", color: "#a1a1aa" },
};

export function formatResources(requires) {
  if (!requires) return "";
  const parts = [];
  if (requires.min_ram_mb) {
    const ram = requires.min_ram_mb >= 1024
      ? `${(requires.min_ram_mb / 1024).toFixed(0)}GB`
      : `${requires.min_ram_mb}MB`;
    parts.push(`${ram} RAM`);
  }
  if (requires.min_disk_mb) {
    const disk = requires.min_disk_mb >= 1024
      ? `${(requires.min_disk_mb / 1024).toFixed(0)}GB`
      : `${requires.min_disk_mb}MB`;
    parts.push(`${disk} disk`);
  }
  if (requires.min_vram_gb) {
    parts.push(`${requires.min_vram_gb}GB VRAM`);
  }
  return parts.length > 0
    ? `<span class="ext-card__resources">${parts.join(" · ")}</span>`
    : "";
}

export function getCategoryColor(category) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
}

/**
 * Render an add-on icon with 3-step fallback:
 * 1. SVG logo from logos.js
 * 2. Emoji from ICON_MAP
 * 3. First-letter circle with category color
 */
export function renderIcon(addon, size) {
  const logo = getAddonLogo(addon.id, size);
  if (logo) return logo;

  const emoji = iconEmoji(addon.icon);
  if (emoji) {
    const emojiSize = size >= 48 ? "1.75rem" : "1.25rem";
    return `<span style="font-size:${emojiSize}">${emoji}</span>`;
  }

  // First-letter circle fallback
  const cat = getCategoryColor(addon.category);
  const initial = escapeHtml((addon.name || "?").charAt(0).toUpperCase());
  const radius = size >= 48 ? "14px" : "10px";
  const fontSize = size >= 48 ? "1.1rem" : "0.85rem";
  return `<div style="width:${size}px;height:${size}px;border-radius:${radius};background:${cat.bg};color:${cat.color};display:flex;align-items:center;justify-content:center;font-size:${fontSize};font-weight:600">${initial}</div>`;
}

/**
 * Build the extensions page content.
 *
 * The store is two views (Browse / Installed) behind a segmented control, and
 * Browse reads top-down: starter collections → featured → grouped sections.
 * Everything wraps; nothing scrolls sideways (the old 19-tab nowrap row is what
 * inflated the whole dashboard to 2555px).
 *
 * PURE: plain data in, strings out. It must never call needsConfigKeys itself —
 * `needsConfig` is computed in panels/extensions.js and handed in (defaulted, so the
 * render unit tests keep passing). Computing it here would make those tests read the
 * operator's real ~/.crow.
 *
 * @param {Record<string,string[]>} [needsConfig] id → still-missing required key NAMES
 * @returns {{viewsHtml:string, addonRegistryScript:string, collectionsScript:string}}
 */
export function buildExtensionsHTML({
  installed,
  available,
  collections = [],
  registrySource,
  communityStores,
  bundleStatus,
  needsConfig = {},
  lang,
}) {
  const installedCount = Object.keys(installed).length;
  const hostArches = detectGpuArch();
  const hostVramGb = detectGpuVramGb();

  // ─── Add-on card (shared by Featured and the group sections) ───
  const addonCard = (addon, i, hidden) => {
    const isInstalled = installed[addon.id];
    const cat = addon.category || "other";
    const group = groupForCategory(addon.category);
    const catColor = getCategoryColor(cat);
    const iconHtml = renderIcon(addon, 32);

    const communityBadge = addon._community
      ? `<span class="ext-card__badge ext-card__badge--community" title="${t("extensions.communityNotVerified", lang)}">${t("extensions.community", lang)}</span>`
      : `<span class="ext-card__badge ext-card__badge--official">${t("extensions.official", lang)}</span>`;
    const typeBadge = `<span class="ext-card__badge ext-card__badge--type">${escapeHtml(addon.type)}</span>`;
    const resources = formatResources(addon.requires);

    let installButton;
    const gpuCompat = checkGpuArchCompatible(addon, hostArches, hostVramGb);
    if (isInstalled) {
      installButton = badge(t("extensions.installedBadge", lang), "published");
    } else if (!gpuCompat.ok) {
      const tip = `${gpuCompat.reason || t("extensions.incompatibleGpuArch", lang)}`;
      const label = gpuCompat.kind === "vram" ? t("extensions.insufficientVram", lang) : t("extensions.incompatibleHost", lang);
      installButton = `<span class="ext-card__badge ext-card__badge--type" title="${escapeHtml(tip)}" style="opacity:0.85">${escapeHtml(label)}</span>`;
    } else {
      const envVarsAttr = escapeHtml(JSON.stringify(addon.env_vars || []));
      const minRam = addon.requires?.min_ram_mb || 0;
      const minDisk = addon.requires?.min_disk_mb || 0;
      installButton = `<button class="btn btn-sm btn-primary bundle-install" data-id="${escapeHtml(addon.id)}" data-name="${escapeHtml(addon.name)}" data-envvars="${envVarsAttr}" data-minram="${minRam}" data-mindisk="${minDisk}" data-community="${addon._community ? "true" : "false"}">${t("extensions.install", lang)}</button>`;
    }

    const tags = (addon.tags || []).join(",");
    // Overflow cards are hidden by the CLASS (.ext-card--overflow { display:none }),
    // never by an inline style: the search filter assigns card.style.display, which
    // would clobber an inline hide and reveal every card past index 8 on the first
    // keystroke. A class-driven hide survives that; "Show all" removes the class.
    const cls = `ext-card addon-card${hidden ? " ext-card--overflow" : ""}`;
    const style = hidden
      ? ""
      : ` style="animation:fadeInUp 0.4s ease-out ${Math.min(i * 30, 300)}ms both"`;

    return `<div class="${cls}" data-addon-id="${escapeHtml(addon.id)}" data-addon-type="${escapeHtml(addon.type)}" data-addon-category="${escapeHtml(cat)}" data-addon-group="${escapeHtml(group)}" data-addon-name="${escapeHtml((addon.name || "").toLowerCase())}" data-addon-desc="${escapeHtml((addon.description || "").toLowerCase())}" data-addon-tags="${escapeHtml(tags.toLowerCase())}"${style}>
          <div class="ext-card__icon" style="background:${catColor.bg};color:${catColor.color}">${iconHtml}</div>
          <div class="ext-card__body">
            <div class="ext-card__name">${escapeHtml(addon.name)}</div>
            <p class="ext-card__desc">${escapeHtml(addon.description)}</p>
            <div class="ext-card__meta">
              ${communityBadge}
              ${typeBadge}
            </div>
            ${resources}
            <span class="ext-card__version">v${escapeHtml(addon.version || "1.0.0")} · ${escapeHtml(addon.author || "community")}</span>
          </div>
          <div class="ext-card__footer">${installButton}</div>
        </div>`;
  };

  // ─── Segmented control ───
  const viewTabsHtml = `<div class="ext-viewtabs" id="ext-viewtabs" role="tablist" aria-label="${t("extensions.pageTitle", lang)}">
      <button type="button" class="ext-viewtab ext-viewtab--active" data-view="browse" role="tab" aria-selected="true" aria-controls="ext-view-browse">${t("extensions.viewBrowse", lang)}</button>
      <button type="button" class="ext-viewtab" data-view="installed" role="tab" aria-selected="false" aria-controls="ext-view-installed">${t("extensions.viewInstalled", lang)} <span class="ext-viewtab__count">${installedCount}</span></button>
    </div>`;

  // ─── Search ───
  const searchHtml = `<div class="ext-search">
      <svg class="ext-search__icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input class="ext-search__input" type="text" placeholder="${t("extensions.searchPlaceholder", lang)}" id="ext-search" autocomplete="off">
    </div>`;

  const sourceNote = registrySource === "local"
    ? `<div class="ext-sourcenote">${t("extensions.localRegistry", lang)}</div>`
    : "";

  // ─── Starter collections ───
  const collectionCard = (c) => `<button type="button" class="ext-collection-card" data-collection-id="${escapeHtml(c.id)}">
        <span class="ext-collection-card__icon">${collectionIcon(c.icon)}</span>
        <span class="ext-collection-card__name">${escapeHtml(c.name)}</span>
        <span class="ext-collection-card__desc">${escapeHtml(c.description)}</span>
        <span class="ext-collection-card__count">${c.members.length} ${t("extensions.collectionMembers", lang)}</span>
      </button>`;

  const collectionsHtml = collections.length > 0
    ? `<section class="ext-section ext-collections" id="ext-collections">
      <h2 class="ext-section-title ext-section-title--lead">${t("extensions.collectionsTitle", lang)}</h2>
      <p class="ext-section-sub">${t("extensions.collectionsSubtitle", lang)}</p>
      <div class="ext-collections__row">${collections.map(collectionCard).join("")}</div>
    </section>`
    : "";

  // ─── Featured ───
  const featured = available.filter((a) => a.featured && !a._community);
  const featuredHtml = featured.length > 0
    ? `<section class="ext-section ext-featured" id="ext-featured">
      <h2 class="ext-section-title ext-section-title--feature">${t("extensions.featuredTitle", lang)}</h2>
      <div class="ext-grid">${featured.map((a, i) => addonCard(a, i, false)).join("")}</div>
    </section>`
    : "";

  // ─── Group chips + group sections ───
  let groupsHtml = "";
  let chipsHtml = "";
  if (available.length === 0) {
    const isDoubleFailure = registrySource === "none";
    groupsHtml = isDoubleFailure
      ? `<div class="callout callout-error" role="status" style="margin:1rem 0">
            <strong>${t("extensions.serviceUnavailable", lang)}</strong>
            <p style="margin:0.25rem 0 0">${t("extensions.serviceUnavailableDesc", lang)}</p>
          </div>`
      : `<div class="ext-empty">
            <h3>${t("extensions.registryUnavailable", lang)}</h3>
            <p>${t("extensions.registryUnavailableDesc", lang)}</p>
          </div>`;
  } else {
    const grouped = groupAddons(available);

    chipsHtml = `<div class="ext-group-chips" id="ext-group-chips">
        ${DISPLAY_GROUPS.filter((g) => grouped.has(g.id)).map((g) =>
          `<button type="button" class="ext-group-chip" data-group="${escapeHtml(g.id)}">${t(g.labelKey, lang)} <span class="ext-group-chip__count">${grouped.get(g.id).length}</span></button>`,
        ).join("")}
      </div>`;

    groupsHtml = DISPLAY_GROUPS.filter((g) => grouped.has(g.id)).map((g) => {
      const addons = grouped.get(g.id);
      const more = addons.length > GROUP_SHOWN
        ? `<button type="button" class="btn btn-sm btn-secondary ext-group-more" data-group="${escapeHtml(g.id)}">${t("extensions.showAll", lang)} (${addons.length})</button>`
        : "";
      return `<section class="ext-group-section" data-group="${escapeHtml(g.id)}">
        <h3 class="ext-section-title">${t(g.labelKey, lang)} <span class="ext-section-count">${addons.length}</span></h3>
        <div class="ext-grid">${addons.map((a, i) => addonCard(a, i, i >= GROUP_SHOWN)).join("")}</div>
        ${more}
      </section>`;
    }).join("");
  }

  const noResultsHtml = `<p class="ext-empty" id="ext-no-results" style="display:none">${t("extensions.noResults", lang)}</p>`;

  // ─── Installed view ───
  let installedListHtml;
  if (installedCount === 0) {
    installedListHtml = `<div class="ext-empty">
        <h3>${t("extensions.noAddonsInstalled", lang)}</h3>
        <p>${t("extensions.browseBelow", lang)}</p>
      </div>`;
  } else {
    const items = Object.entries(installed).map(([id, info], i) => {
      const registryEntry = available.find((a) => a.id === id);
      const name = registryEntry?.name || id;
      const iconHtml = renderIcon(registryEntry || { id, name, icon: registryEntry?.icon, category: registryEntry?.category }, 32);
      const status = bundleStatus[id];
      const isDocker = !!status;
      const isRunning = status?.running;

      const statusBadge = isDocker
        ? (isRunning ? badge(t("extensions.runningBadge", lang), "published") : badge(t("extensions.stoppedBadge", lang), "draft"))
        : badge(t("extensions.mcpServer", lang), "connected");

      // Required keys still empty in this bundle's EFFECTIVE env (server-computed).
      // The wrapper span is a DOM hook, not a style: the client removes it (and the
      // Configure button) when a save comes back with an empty needs_config.
      const missingKeys = needsConfig[id] || [];
      const needsSetupBadge = missingKeys.length > 0
        ? `<span class="ext-installed__needsconfig">${badge(t("extensions.needsSetup", lang), "draft")}</span>`
        : "";

      let actions = "";
      if (isDocker) {
        if (isRunning) {
          actions = `
              <button class="btn btn-sm btn-secondary bundle-action" data-action="stop" data-id="${escapeHtml(id)}">${t("extensions.stop", lang)}</button>
              <button class="btn btn-sm btn-secondary bundle-action" data-action="start" data-id="${escapeHtml(id)}" title="${t("extensions.restart", lang)}">${t("extensions.restart", lang)}</button>`;
        } else {
          actions = `<button class="btn btn-sm btn-primary bundle-action" data-action="start" data-id="${escapeHtml(id)}">${t("extensions.start", lang)}</button>`;
        }
      }
      if (missingKeys.length > 0) {
        actions += `<button class="btn btn-sm btn-primary bundle-configure" data-id="${escapeHtml(id)}" data-keys="${escapeHtml(missingKeys.join(","))}">${t("extensions.configure", lang)}</button>`;
      }
      actions += `<button class="btn btn-sm btn-secondary bundle-uninstall" data-id="${escapeHtml(id)}" data-name="${escapeHtml(name)}" data-docker="${isDocker}">${t("extensions.remove", lang)}</button>`;

      return `<div class="ext-installed__item" data-addon-id="${escapeHtml(id)}" style="animation:fadeInUp 0.4s ease-out ${Math.min(i * 30, 300)}ms both">
          <div class="ext-installed__icon">${iconHtml}</div>
          <div class="ext-installed__info">
            <span class="ext-installed__name">${escapeHtml(name)}</span>
            ${statusBadge}
            ${needsSetupBadge}
            <span class="ext-installed__meta">v${escapeHtml(info.version || registryEntry?.version || "?")} · ${t("extensions.installedDate", lang)} ${formatDate(info.installed_at || info.installedAt)}</span>
          </div>
          <div class="ext-installed__actions">${actions}</div>
          <div id="status-${escapeHtml(id)}" style="font-size:0.8rem;margin-top:0.4rem;display:none;width:100%"></div>
        </div>`;
    }).join("");
    installedListHtml = `<div class="ext-installed__list" id="installed-list">${items}</div>`;
  }

  // ─── Community stores (collapsible; lives in the Installed view) ───
  const storesHtml = `<div class="ext-stores">
      <div class="ext-stores__header" onclick="(function(e){var b=document.getElementById('stores-body');var c=document.getElementById('stores-chevron');b.classList.toggle('ext-stores__body--open');c.classList.toggle('ext-stores__chevron--open')})()" >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
        ${t("extensions.communityStores", lang)} (${communityStores.length})
        <span class="ext-stores__chevron" id="stores-chevron">&#9662;</span>
      </div>
      <div class="ext-stores__body" id="stores-body">
        ${communityStores.length > 0 ? communityStores.map((s) => `
          <div class="ext-stores__row">
            <span class="ext-stores__url">${escapeHtml(s.url)}</span>
            <form method="POST" style="margin:0">
              <input type="hidden" name="action" value="remove_store">
              <input type="hidden" name="store_url" value="${escapeHtml(s.url)}">
              <button type="submit" class="btn btn-sm" style="color:var(--crow-text-muted);border-color:var(--crow-border);font-size:0.75rem">${t("extensions.remove", lang)}</button>
            </form>
          </div>
        `).join("") : `<p style="font-size:0.85rem;color:var(--crow-text-muted);margin-bottom:0.75rem">${t("extensions.noStoresConfigured", lang)}</p>`}
        <form method="POST" style="display:flex;gap:0.5rem;margin-top:0.75rem">
          <input type="hidden" name="action" value="add_store">
          <input type="text" name="store_url" placeholder="https://github.com/user/crow-store" style="flex:1;min-width:0;padding:0.4rem 0.6rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);font-size:0.85rem;font-family:'JetBrains Mono',monospace;box-sizing:border-box">
          <button type="submit" class="btn btn-sm btn-primary">${t("extensions.addStore", lang)}</button>
        </form>
      </div>
    </div>`;

  // ─── Help card ───
  const helpHtml = `<div class="ext-help">
      ${t("extensions.askAi", lang)} <code>"install the [name] add-on"</code><br>
      ${t("extensions.toCreateOwn", lang)} <a href="/crow/developers/creating-addons" style="color:var(--crow-accent)">${t("extensions.devGuide", lang)}</a>.
    </div>`;

  const viewsHtml = `${viewTabsHtml}
    <div class="ext-view" id="ext-view-browse" role="tabpanel">
      ${searchHtml}
      ${sourceNote}
      ${collectionsHtml}
      ${featuredHtml}
      ${chipsHtml}
      ${noResultsHtml}
      ${groupsHtml}
    </div>
    <div class="ext-view ext-view--hidden" id="ext-view-installed" role="tabpanel" hidden>
      ${installedListHtml}
      ${storesHtml}
      ${helpHtml}
    </div>`;

  // ─── Add-on registry blob for the client-side detail modal ───
  const addonMap = {};
  for (const addon of available) {
    const catColor = getCategoryColor(addon.category);
    addonMap[addon.id] = {
      id: addon.id,
      name: addon.name,
      description: addon.description,
      type: addon.type,
      version: addon.version,
      author: addon.author,
      category: addon.category,
      group: groupForCategory(addon.category),
      tags: addon.tags || [],
      notes: addon.notes || "",
      ports: addon.ports || [],
      webUI: addon.webUI || null,
      requires: addon.requires || {},
      env_vars: (addon.env_vars || []).map((ev) => ({
        name: ev.name, description: ev.description,
        default: ev.secret ? "" : (ev.default || ""), required: ev.required, secret: !!ev.secret,
      })),
      official: !addon._community,
      featured: !!addon.featured,
      _iconHtml: renderIcon(addon, 48),
      _iconBg: catColor.bg,
      _iconColor: catColor.color,
      _installed: !!installed[addon.id],
    };
  }
  const addonRegistryJson = JSON.stringify(addonMap).replace(/<\//g, "<\\/");
  const addonRegistryScript = `<script id="addon-registry" type="application/json">${addonRegistryJson}<\/script>`;

  // ─── Collection blob for the client-side install-set modal (Task 11) ───
  const collectionsJson = JSON.stringify(
    collections.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      icon: c.icon,
      members: (c.members || []).map((m) => ({
        id: m.id,
        kind: m.kind,
        you_need: m.you_need || "",
        name: available.find((a) => a.id === m.id)?.name || m.id,
        installed: !!installed[m.id],
      })),
    })),
  ).replace(/<\//g, "<\\/");
  const collectionsScript = `<script id="collection-registry" type="application/json">${collectionsJson}<\/script>`;

  return { viewsHtml, addonRegistryScript, collectionsScript };
}
