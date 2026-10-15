/**
 * Nest Panel — HTML Template
 *
 * Renders the home screen: greeting + pinned row + app grid.
 * Phone-style — clean, breathable, focused on navigation.
 */

import { escapeHtml, statCard, statGrid } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { getVisiblePanels } from "../../panel-registry.js";
import { CROW_HERO_SVG } from "../../shared/crow-hero.js";
import { getAddonLogo } from "../../shared/logos.js";
import { isSafeDestPath } from "../../../../shared/sso-ticket.js";
import { appIconSvg } from "../../shared/app-icons.js";

// ─── Icons ───
// One shared stroke set (shared/app-icons.js). Icon strings from manifests and
// peers are lookup keys only — an unknown key gets a fallback glyph, never
// its own text in the markup.

const FALLBACK_ICON = appIconSvg("default");
const PACKAGE_ICON = appIconSvg("package");

function getTileIcon(key) {
  return appIconSvg(key) || FALLBACK_ICON;
}

// Peer-advertised icon keys. overview-cache.js applies the same allowlist
// (isAppIconKey) before a tile reaches this renderer; appIconSvg resolving
// only allowlisted keys is the second layer.
function resolvePeerIcon(iconKey) {
  return appIconSvg(iconKey) || FALLBACK_ICON;
}

// Nest-only order: the apps people open most come first. navOrder still
// drives the sidebar and the federation tiles, so it is left alone; panels
// not listed here follow in navOrder, then the bundle tiles.
const NEST_PRIORITY = [
  "perch", "messages", "artifacts", "contacts", "memory", "projects", "files",
  "bot-board", "bot-builder", "blog", "skills", "knowledge-base", "model-catalog",
];

function nestRank(id) {
  const i = NEST_PRIORITY.indexOf(id);
  return i === -1 ? Infinity : i;
}

function statusDotHtml(isRunning, lang) {
  return `<span class="nest-app-status" style="background:${isRunning ? "var(--crow-success)" : "var(--crow-text-muted)"}" title="${isRunning ? t("health.runningStatus", lang) : t("health.stoppedStatus", lang)}"></span>`;
}

/**
 * Disambiguate colliding peer names by appending a short hostname suffix.
 * Two peers both named "crow" → "crow (grackle-a)" and "crow (node-b21)".
 */
function disambiguatePeerNames(peerOverviews, trustedInstances) {
  const nameCounts = new Map();
  for (const p of peerOverviews) {
    const n = p?.instance?.name || "peer";
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  return peerOverviews.map((p, i) => {
    const name = p?.instance?.name || trustedInstances[i]?.name || "peer";
    if (nameCounts.get(name) <= 1) return { ...p, displayName: name };
    const hostname = p?.instance?.hostname || trustedInstances[i]?.hostname || "";
    const suffix = hostname.split(".")[0].slice(0, 8);
    return { ...p, displayName: suffix ? `${name} (${suffix})` : name };
  });
}

function buildPeerTileHref(gatewayUrl, hostname, pathname, port) {
  // NEVER trust a peer-supplied URL. All base-URL material comes from the
  // LOCAL crow_instances row — gateway_url is operator-configured at pair
  // time and is the canonical way to reach the peer. pathname has already
  // passed regex validation in overview-cache.js.
  //
  // Construction rules:
  //  - Bundle-direct (port != null)      → scheme+host from gateway_url,
  //                                         tile's port, tile's pathname.
  //  - Everything else (port == null)    → gateway_url's scheme+host+port,
  //                                         tile's pathname (replaces
  //                                         gateway_url's path component).
  //  - gateway_url missing or malformed  → fall back to https://<hostname>
  //                                         (pre-gateway_url behavior).
  const fallback = () => {
    const safeHost = String(hostname || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeHost) return null;
    const portPart = port && Number.isInteger(port) ? `:${port}` : "";
    return `https://${safeHost}${portPart}${pathname}`;
  };

  if (gatewayUrl) {
    try {
      const u = new URL(gatewayUrl);
      if (port && Number.isInteger(port)) {
        u.port = String(port);
      }
      u.pathname = pathname;
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch {
      return fallback();
    }
  }
  return fallback();
}

/**
 * Render the health strip that appears above the panel grid.
 * Shown only when healthSignals is provided.
 *
 * @param {{ok: boolean, issues: Array, details: Array}|null} health
 * @param {string} lang
 * @param {string|null} flash  — flash param from query string after backup action
 */
function buildHealthStrip(health, lang, flash) {
  // Flash banner (shown after POST backup redirect)
  let flashHtml = "";
  if (flash === "backup_ok") {
    flashHtml = `<div class="nest-flash nest-flash--success">${escapeHtml(t("health.backupDone", lang))}</div>`;
  } else if (flash === "backup_fail") {
    flashHtml = `<div class="nest-flash nest-flash--error">${escapeHtml(t("health.backupFailed", lang))}</div>`;
  } else if (flash === "fixit_fixed") {
    flashHtml = `<div class="nest-flash nest-flash--success">Done — it's shared now.</div>`;
  } else if (flash === "fixit_dismissed") {
    flashHtml = `<div class="nest-flash nest-flash--success">Dismissed for now.</div>`;
  } else if (flash === "fixit_error") {
    flashHtml = `<div class="nest-flash nest-flash--error">Couldn't apply that fix.</div>`;
  }

  if (!health) return flashHtml;

  // Detail cards
  const detailCards = (health.details || []).map(d => {
    const valClass = `nest-health-detail-value--${d.state || "off"}`;
    return `<div class="nest-health-detail-card">
      <div class="nest-health-detail-label">${escapeHtml(d.label)}</div>
      <div class="nest-health-detail-value ${valClass}">${escapeHtml(String(d.value ?? ""))}</div>
    </div>`;
  }).join("");

  const detailGrid = `<div class="nest-health-detail-grid">${detailCards}</div>`;
  const detailsEl = `<details class="nest-health-details">
    <summary>&#9654; ${escapeHtml(t("health.statusDetails", lang))}</summary>
    ${detailGrid}
  </details>`;

  let bodyHtml;
  if (health.ok) {
    bodyHtml = `<div class="nest-health-allgood">
      <span class="nest-health-allgood-dot" aria-hidden="true"></span>
      ${escapeHtml(t("health.allgood", lang))}
    </div>`;
  } else {
    const issueLines = (health.issues || []).map(issue => {
      const dotClass = issue.severity === "warn"
        ? "nest-health-issue-dot--warn"
        : "nest-health-issue-dot--info";

      let actionHtml = "";
      if (issue.actionLabel && issue.actionHref) {
        // Backup action gets a POST form; all others are simple links
        if (issue.actionHref === "/dashboard/nest?action=backup") {
          actionHtml = `<form class="nest-health-backup-form" method="POST" action="/dashboard/nest/backup">
            <button class="nest-health-backup-btn" type="submit">${escapeHtml(issue.actionLabel)}</button>
          </form>`;
        } else {
          actionHtml = `<a class="nest-health-issue-action" href="${escapeHtml(issue.actionHref)}">${escapeHtml(issue.actionLabel)}</a>`;
        }
      }

      return `<div class="nest-health-issue">
        <span class="nest-health-issue-dot ${dotClass}" aria-hidden="true"></span>
        <span class="nest-health-issue-label">${escapeHtml(issue.label)}</span>
        ${actionHtml}
      </div>`;
    }).join("");
    bodyHtml = `<div class="nest-health-issues">${issueLines}</div>`;
  }

  const warnClass = health.ok ? "nest-health-strip--ok" : "nest-health-strip--warn";
  const stripHtml = `<div class="nest-health-strip ${warnClass}" aria-live="polite" aria-label="${escapeHtml(t("health.stripLabel", lang))}">
    ${bodyHtml}
    ${detailsEl}
  </div>`;

  return flashHtml + stripHtml;
}

export function buildNestHTML(data, lang) {
  const { pinnedItems, bundles, instances, trustedInstances, peerOverviews, ssoEnabled, healthSignals, flash, fixItHtml } = data;
  const carouselMode = Array.isArray(peerOverviews) && peerOverviews.length > 0;

  let tileIndex = 0;

  // --- Welcome Header (light, floating — no card wrapper) ---
  const dateStr = new Date().toLocaleDateString(
    lang === "es" ? "es-ES" : "en-US",
    { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  );

  const welcomeHtml = `<div class="nest-welcome">
    <div class="nest-welcome-crow">${CROW_HERO_SVG}</div>
    <div class="nest-greeting">${t("health.welcome", lang)}</div>
    <div class="nest-date">${dateStr}</div>
  </div>`;

  // --- Pinned Row (shown above grid only if items exist) ---
  let pinnedHtml = "";
  if (pinnedItems.length > 0) {
    const pinnedItemsHtml = pinnedItems.map(p => {
      const iconKey = p.type === "conversation" ? "conversation" : p.type === "blog_draft" ? "blog_draft" : p.type === "project" ? "folder" : "memory";
      const icon = getTileIcon(iconKey);
      return `<a href="${escapeHtml(p.href)}" class="nest-pinned-item">
        <form method="POST" class="nest-pinned-unpin" onclick="event.stopPropagation()">
          <input type="hidden" name="action" value="unpin">
          <input type="hidden" name="item_type" value="${escapeHtml(p.type)}">
          <input type="hidden" name="item_id" value="${escapeHtml(p.id)}">
          <button type="submit" style="all:inherit;cursor:pointer">&times;</button>
        </form>
        ${icon}
        ${escapeHtml(p.label)}
      </a>`;
    }).join("");

    pinnedHtml = `<div class="nest-pinned">
      <div class="nest-pinned-label">${t("nest.pinned", lang)}</div>
      <div class="nest-pinned-row">${pinnedItemsHtml}</div>
    </div>`;
  }

  // --- Panel Tiles ---
  // A bundle that registers a visible panel gets ONE tile (the panel's); its
  // running dot comes along only when the bundle ships a container, since a
  // container-less bundle has no running state to report.
  const panels = getVisiblePanels()
    .filter(p => p.id !== "nest")
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (nestRank(a.p.id) - nestRank(b.p.id)) || (a.i - b.i))
    .map(x => x.p);
  const panelIds = new Set(panels.map(p => p.id));
  const bundleById = new Map(bundles.map(b => [b.id, b]));
  const panelTiles = panels.map(p => {
    const icon = appIconSvg(p.icon) || appIconSvg(p.id) || PACKAGE_ICON;
    const label = t("nav." + p.id, lang) !== "nav." + p.id ? t("nav." + p.id, lang) : p.name;
    const bundle = bundleById.get(p.id);
    const dot = bundle && bundle.hasContainer ? statusDotHtml(bundle.isRunning, lang) : "";
    const delay = tileIndex++ * 40;
    return `<a href="${escapeHtml(p.route)}" class="nest-app nest-app--panel" style="animation-delay:${delay}ms">
      <div class="nest-app-icon">${dot}${icon}</div>
      <div class="nest-app-label">${escapeHtml(label)}</div>
    </a>`;
  }).join("");

  // --- Bundle Tiles (icon: branded logo → manifest icon → package glyph) ---
  const bundleTiles = bundles.filter(b => !panelIds.has(b.id)).map(b => {
    const logo = getAddonLogo(b.id, 32);
    const iconHtml = logo || `<div class="nest-bundle-glyph">${appIconSvg(b.icon) || PACKAGE_ICON}</div>`;
    const statusDot = b.hasContainer ? statusDotHtml(b.isRunning, lang) : "";
    const hasWebUI = !!b.webUI;
    const isDirect = hasWebUI && b.webUI.proxyMode === "direct";
    // Direct-mode: use HTTPS + hostname + port (Tailscale serve provides TLS)
    // Subpath proxy: use /proxy/<id>/ through the gateway (inherits TLS)
    const directUrl = `'https://'+location.hostname+':${hasWebUI ? b.webUI.port : ""}${hasWebUI ? (b.webUI.path || "/") : ""}'`;
    const proxyUrl = `'/proxy/${b.id}${hasWebUI ? (b.webUI.path || "/") : ""}'`;
    const href = hasWebUI && !isDirect ? `/proxy/${b.id}${b.webUI.path || "/"}` : "/dashboard/extensions";
    const onclick = hasWebUI ? ` onclick="window.open(${isDirect ? directUrl : proxyUrl},'_blank');return false"` : "";
    const delay = tileIndex++ * 40;
    return `<a href="${escapeHtml(href)}" class="nest-app nest-app--bundle" style="animation-delay:${delay}ms"${onclick}>
      <div class="nest-app-icon">${statusDot}${iconHtml}</div>
      <div class="nest-app-label">${escapeHtml(b.name)}</div>
    </a>`;
  }).join("");

  // --- Instance Tiles (shown only if instances are registered) ---
  let instancesHtml = "";
  if (instances && instances.length > 0) {
    const instanceIcon = getTileIcon("instance");
    const instanceTiles = instances.map(inst => {
      const statusColor = inst.status === "active" ? "var(--crow-success)"
        : inst.status === "offline" ? "var(--crow-error)"
        : "var(--crow-text-muted)";
      const homeLabel = inst.is_home ? ` <span style="font-size:0.6rem;opacity:0.7;text-transform:uppercase;letter-spacing:0.05em">home</span>` : "";
      const statusDot = `<span class="nest-app-status" style="background:${statusColor}" title="${escapeHtml(inst.status)}"></span>`;
      // Route through local SSO launch when enabled + the peer is trusted and
      // paired; otherwise the legacy direct cross-origin link (prompts for the
      // peer's password). SSO navigates same-tab so the destination session
      // cookie lands in this (PWA/WebView) cookie jar.
      const useSso = ssoEnabled && Number(inst.trusted) === 1 && inst.paired && inst.gateway_url;
      const href = useSso
        ? `/dashboard/sso/launch?target=${encodeURIComponent(inst.id)}&to=${encodeURIComponent("/dashboard/nest")}`
        : (inst.gateway_url ? `${inst.gateway_url}/dashboard/nest` : "#");
      const targetAttr = useSso ? "" : (inst.gateway_url ? ` target="_blank"` : "");
      const delay = tileIndex++ * 40;
      return `<a href="${escapeHtml(href)}" class="nest-app nest-app--instance" style="animation-delay:${delay}ms"${targetAttr}>
        <div class="nest-app-icon">${statusDot}${instanceIcon}</div>
        <div class="nest-app-label">${escapeHtml(inst.name)}${homeLabel}</div>
        <div class="nest-app-meta" style="font-size:0.6rem;color:var(--crow-text-muted);margin-top:2px">${escapeHtml(inst.hostname || "")}</div>
      </a>`;
    }).join("");

    instancesHtml = `<div class="nest-section-label" style="padding:0.5rem 1rem 0;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--crow-text-muted);font-weight:600">${t("nest.instances", lang)}</div>
    <div class="nest-grid nest-grid--instances">${instanceTiles}</div>`;
  }

  // --- App Grid (panels + bundles, no quick actions) ---
  const gridHtml = `<div class="nest-grid">
    ${panelTiles}${bundleTiles}
  </div>`;

  // --- Health Strip ---
  const healthStripHtml = buildHealthStrip(healthSignals || null, lang, flash || null);

  // --- Unified carousel (Phase 2) ---
  // Active when the handler wrapper has passed peer overviews. One
  // `<section>` per trusted peer + one for the local instance (the local
  // section is the existing panel/bundle grid above, wrapped). Remote tiles
  // are absolute cross-origin links to the peer's own hostname — no
  // fragment-embedding, no POST-forwarding.
  if (carouselMode) {
    const disambiguated = disambiguatePeerNames(peerOverviews, trustedInstances || []);

    const sections = [];
    // Local section first. In carousel mode we INTENTIONALLY skip the
    // legacy instancesHtml — the tabs strip + per-instance sections ARE
    // the multi-instance view; rendering both is redundant and confusing.
    sections.push(
      `<section class="nest-instance-section" data-instance="local" role="tabpanel" aria-labelledby="crow-instance-tab-local">
        ${gridHtml}
      </section>`
    );

    for (let i = 0; i < disambiguated.length; i++) {
      const peer = disambiguated[i];
      const ti = trustedInstances?.[i] || {};
      const sectionId = escapeHtml(ti.id || `peer-${i}`);
      const displayName = escapeHtml(peer.displayName || ti.name || "peer");

      // Full-mesh visibility (F5): an instance we learned about via a trusted
      // peer's gossip roster, but for which we hold no credentials. We can't
      // fetch its tiles or SSO into it — render a single link-out to its
      // public gateway so the operator can still reach it from any node.
      if (peer.status === "discovered") {
        const openUrl = ti.gateway_url || "";
        const openLabel = escapeHtml(t("nest.openInstance", lang) || "Open");
        sections.push(
          `<section class="nest-instance-section nest-instance-section--discovered" data-instance="${sectionId}" role="tabpanel" aria-labelledby="crow-instance-tab-${sectionId}">
            <div class="nest-section-label" style="padding:0.5rem 1rem 0;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--crow-text-muted);font-weight:600">${displayName}</div>
            <div class="nest-grid">
              ${openUrl ? `<a href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer" class="nest-app nest-app--instance">
                <div class="nest-app-icon">${resolvePeerIcon("instance")}</div>
                <div class="nest-app-label">${openLabel} ${displayName}</div>
              </a>` : ""}
            </div>
          </section>`
        );
        continue;
      }

      if (peer.status !== "ok") {
        const lastSeen = ti.last_seen_at
          ? new Date(ti.last_seen_at).toLocaleString(lang === "es" ? "es-ES" : "en-US")
          : null;
        const msg = lastSeen
          ? `${t("nest.offlineSince", lang) || "offline since"} ${escapeHtml(lastSeen)}`
          : (t("nest.offline", lang) || "offline");
        sections.push(
          `<section class="nest-instance-section nest-instance-section--offline" data-instance="${sectionId}" role="tabpanel" aria-labelledby="crow-instance-tab-${sectionId}">
            <div class="nest-section-label" style="padding:0.5rem 1rem 0;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--crow-text-muted);font-weight:600">${displayName}</div>
            <div class="nest-instance-offline">
              <p>${msg}</p>
              <button type="button" class="nest-instance-retry" data-instance-id="${sectionId}">${escapeHtml(t("nest.retry", lang) || "Retry")}</button>
            </div>
          </section>`
        );
        continue;
      }

      const peerHostname = ti.hostname || peer.instance?.hostname || "";
      const peerGatewayUrl = ti.gateway_url || null;
      // SSO is only useful for tiles served on the peer's gateway origin
      // (no custom port → it shares the cookie the SSO accept sets). Direct
      // cross-port bundles bypass the gateway session entirely, so leave them
      // as plain new-tab links.
      const peerSsoOk = ssoEnabled && ti.paired && peerGatewayUrl;
      const peerTiles = peer.tiles.map(tile => {
        let href, attrs;
        if (peerSsoOk && !tile.port && isSafeDestPath(tile.pathname)) {
          href = `/dashboard/sso/launch?target=${encodeURIComponent(ti.id)}&to=${encodeURIComponent(tile.pathname)}`;
          attrs = ""; // same-tab so the SSO session cookie lands in this jar
        } else {
          href = buildPeerTileHref(peerGatewayUrl, peerHostname, tile.pathname, tile.port);
          if (!href) return "";
          attrs = ` target="_blank" rel="noopener noreferrer"`;
        }
        const icon = resolvePeerIcon(tile.icon);
        const klass = tile.category === "bundle" ? "nest-app nest-app--bundle" : "nest-app nest-app--panel";
        const delay = tileIndex++ * 40;
        return `<a href="${escapeHtml(href)}" class="${klass}"${attrs} style="animation-delay:${delay}ms">
          <div class="nest-app-icon">${icon}</div>
          <div class="nest-app-label">${escapeHtml(tile.name)}</div>
        </a>`;
      }).join("");

      sections.push(
        `<section class="nest-instance-section" data-instance="${sectionId}" role="tabpanel" aria-labelledby="crow-instance-tab-${sectionId}">
          <div class="nest-section-label" style="padding:0.5rem 1rem 0;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--crow-text-muted);font-weight:600">${displayName}</div>
          <div class="nest-grid">${peerTiles}</div>
        </section>`
      );
    }

    const carousel = `<div class="nest-instance-carousel" role="region" aria-live="polite">${sections.join("")}</div>`;
    return `${welcomeHtml}${healthStripHtml}${fixItHtml || ""}${pinnedHtml}${carousel}`;
  }

  return `${welcomeHtml}${healthStripHtml}${fixItHtml || ""}${pinnedHtml}${instancesHtml}${gridHtml}`;
}
