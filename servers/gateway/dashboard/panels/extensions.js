/**
 * Extensions Panel — App store-style add-on browser
 *
 * Security note: All dynamic content is server-side escaped via escapeHtml().
 * Client-side modal content uses DOM manipulation with textContent for user data.
 * The Crow's Nest is auth-protected and only accessible on local/Tailscale networks.
 */

import { escapeHtml, badge, formatDate } from "../shared/components.js";
import { t, tJs } from "../shared/i18n.js";
import { getAddonLogo } from "../shared/logos.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const REGISTRY_URL = "https://raw.githubusercontent.com/kh0pper/crow-addons/main/registry.json";
const CROW_DIR = join(homedir(), ".crow");
const INSTALLED_PATH = join(CROW_DIR, "installed.json");
const STORES_PATH = join(CROW_DIR, "stores.json");

// Local fallback registry path
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_REGISTRY = join(__dirname, "../../../../registry/add-ons.json");

const ICON_MAP = {
  brain: "\u{1F9E0}",
  cloud: "\u2601\uFE0F",
  image: "\u{1F5BC}\uFE0F",
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
  "check-square": "\u2705",
  dollar: "\u{1F4B0}",
  document: "\u{1F4D1}",
  activity: "\u{1F4C8}",
  git: "\u{1F33F}",
  lock: "\u{1F512}",
  search: "\u{1F50D}",
  shield: "\u{1F6E1}\uFE0F",
};

const CATEGORY_COLORS = {
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
  other:          { bg: "rgba(161,161,170,0.12)", color: "#a1a1aa" },
};

const CATEGORY_LABELS = {
  ai: "extensions.categoryAi",
  media: "extensions.categoryMedia",
  productivity: "extensions.categoryProductivity",
  storage: "extensions.categoryStorage",
  "smart-home": "extensions.categorySmartHome",
  networking: "extensions.categoryNetworking",
  gaming: "extensions.categoryGaming",
  data: "extensions.categoryData",
  social: "extensions.categorySocial",
  finance: "extensions.categoryFinance",
  infrastructure: "extensions.categoryInfrastructure",
  automation: "extensions.categoryAutomation",
  other: "extensions.categoryOther",
};

function getInstalled() {
  try {
    if (existsSync(INSTALLED_PATH)) {
      const data = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
      if (Array.isArray(data)) {
        const obj = {};
        for (const item of data) obj[item.id] = item;
        return obj;
      }
      return data;
    }
  } catch {}
  return {};
}

function getStores() {
  try {
    if (existsSync(STORES_PATH)) {
      return JSON.parse(readFileSync(STORES_PATH, "utf8"));
    }
  } catch {}
  return [];
}

function saveStores(stores) {
  writeFileSync(STORES_PATH, JSON.stringify(stores, null, 2));
}

/** Fetch add-ons from a community store GitHub repo */
async function fetchCommunityStore(storeUrl) {
  try {
    const match = storeUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return { addons: [], store: null };

    const rawUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/registry.json`;
    const storeMetaUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/crow-store.json`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let store = null;
    try {
      const metaResp = await fetch(storeMetaUrl, { signal: controller.signal });
      if (metaResp.ok) store = await metaResp.json();
    } catch {}

    const resp = await fetch(rawUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return { addons: [], store };

    const data = await resp.json();
    const addons = (data["add-ons"] || []).map((a) => ({
      ...a,
      _community: true,
      _storeName: store?.name || match[1],
      _storeUrl: storeUrl,
    }));
    return { addons, store };
  } catch {
    return { addons: [], store: null };
  }
}

function formatResources(requires) {
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
  return parts.length > 0
    ? `<span class="ext-card__resources">${parts.join(" · ")}</span>`
    : "";
}

function getCategoryColor(category) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
}

/**
 * Render an add-on icon with 3-step fallback:
 * 1. SVG logo from logos.js
 * 2. Emoji from ICON_MAP
 * 3. First-letter circle with category color
 */
function renderIcon(addon, size) {
  const logo = getAddonLogo(addon.id, size);
  if (logo) return logo;

  const emoji = ICON_MAP[addon.icon];
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

/** Scoped CSS for the extensions panel */
function extensionStyles() {
  return `<style>
/* ─── Extensions Store ─── */
.ext-search { position:relative; margin-bottom:1.5rem; }
.ext-search__icon {
  position:absolute; left:0.85rem; top:50%;
  transform:translateY(-50%);
  width:16px; height:16px;
  color:var(--crow-text-muted); pointer-events:none;
}
.ext-search__input {
  width:100%; box-sizing:border-box;
  padding:0.65rem 0.75rem 0.65rem 2.5rem;
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  background:var(--crow-bg-surface);
  color:var(--crow-text-primary);
  font-size:0.9rem;
  font-family:'DM Sans',sans-serif;
  transition:border-color 0.15s;
}
.ext-search__input:focus { outline:none; border-color:var(--crow-accent); }
.ext-search__input::placeholder { color:var(--crow-text-muted); }

/* Installed strip */
.ext-section-label {
  font-size:0.75rem; font-weight:600;
  text-transform:uppercase; letter-spacing:0.08em;
  color:var(--crow-text-muted);
  margin:0 0 0.6rem 0.1rem;
}
.ext-installed-toggle {
  display:flex; align-items:center; justify-content:space-between;
  padding:0.6rem 1rem;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  cursor:pointer; user-select:none;
  font-size:0.85rem; font-weight:600;
  color:var(--crow-text-secondary);
  margin-bottom:0.5rem;
  transition:border-color 0.15s;
}
.ext-installed-toggle:hover { border-color:var(--crow-accent); }
.ext-installed-toggle__chevron { transition:transform 0.2s; font-size:0.8rem; }
.ext-installed-toggle__chevron--open { transform:rotate(180deg); }
.ext-installed__list { display:none; flex-direction:column; gap:0.5rem; margin-bottom:1.5rem; }
.ext-installed__list--open { display:flex; }
.ext-installed__item {
  display:flex; align-items:center; gap:0.75rem;
  padding:0.65rem 1rem;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  transition:border-color 0.15s;
}
.ext-installed__item:hover { border-color:var(--crow-accent); }
.ext-installed__icon { flex-shrink:0; width:36px; height:36px; display:flex; align-items:center; justify-content:center; }
.ext-installed__info { flex:1; min-width:0; display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
.ext-installed__name { font-family:'Fraunces',serif; font-size:0.95rem; font-weight:600; }
.ext-installed__meta { font-size:0.75rem; font-family:'JetBrains Mono',monospace; color:var(--crow-text-muted); }
.ext-installed__actions { display:flex; gap:0.4rem; align-items:center; flex-shrink:0; }

/* Category tabs */
.ext-tabs {
  display:flex; gap:0.5rem;
  margin-bottom:1.25rem;
  overflow-x:auto; scrollbar-width:none;
  padding-bottom:0.25rem;
  -webkit-overflow-scrolling:touch;
}
.ext-tabs::-webkit-scrollbar { display:none; }
.ext-tab {
  flex-shrink:0;
  padding:0.4rem 0.9rem;
  border-radius:var(--crow-radius-pill, 8px);
  background:transparent;
  border:1px solid var(--crow-border);
  color:var(--crow-text-secondary);
  font-size:0.8rem; font-weight:500;
  cursor:pointer;
  transition:all 0.15s;
  white-space:nowrap;
  font-family:'DM Sans',sans-serif;
}
.ext-tab:hover { border-color:var(--crow-accent); color:var(--crow-text-primary); }
.ext-tab--active {
  background:var(--crow-accent-muted);
  color:var(--crow-accent);
  border-color:var(--crow-accent);
}

/* Browse grid */
.ext-grid {
  display:grid;
  grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));
  gap:1rem;
  margin-bottom:1.5rem;
}

/* Add-on card (vertical) */
.ext-card {
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  padding:1.25rem 1rem;
  display:flex; flex-direction:column; align-items:center;
  text-align:center;
  transition:transform 0.15s, border-color 0.15s, box-shadow 0.15s;
  cursor:default;
}
.ext-card:hover {
  transform:translateY(-3px);
  border-color:var(--crow-accent);
  box-shadow:0 8px 24px rgba(0,0,0,0.2);
}
.ext-card__icon {
  width:64px; height:64px;
  border-radius:16px;
  display:flex; align-items:center; justify-content:center;
  margin-bottom:0.75rem;
  transition:transform 0.2s ease;
}
.ext-card:hover .ext-card__icon { transform:scale(1.06); }
.ext-card__icon > div { width:32px; height:32px; }
.ext-card__body { flex:1; display:flex; flex-direction:column; align-items:center; width:100%; }
.ext-card__name {
  font-family:'Fraunces',serif;
  font-size:0.95rem; font-weight:600;
  margin-bottom:0.35rem;
  color:var(--crow-text-primary);
}
.ext-card__desc {
  font-size:0.8rem;
  color:var(--crow-text-secondary);
  line-height:1.45;
  margin-bottom:0.5rem;
  display:-webkit-box;
  -webkit-line-clamp:2;
  -webkit-box-orient:vertical;
  overflow:hidden;
}
.ext-card__meta { display:flex; flex-wrap:wrap; gap:0.25rem; justify-content:center; margin-bottom:0.4rem; }
.ext-card__badge {
  font-size:0.6rem; font-weight:500;
  padding:0.1rem 0.4rem; border-radius:4px;
  text-transform:uppercase; letter-spacing:0.02em;
}
.ext-card__badge--official { color:var(--crow-accent); background:var(--crow-accent-muted); }
.ext-card__badge--community { color:#f0ad4e; background:rgba(240,173,78,0.15); border:1px solid rgba(240,173,78,0.3); }
.ext-card__badge--type { color:var(--crow-text-muted); background:var(--crow-bg-elevated); }
.ext-card__resources { font-size:0.7rem; color:var(--crow-text-muted); margin-bottom:0.2rem; }
.ext-card__version { font-size:0.7rem; color:var(--crow-text-muted); font-family:'JetBrains Mono',monospace; }
.ext-card__footer { margin-top:auto; padding-top:0.6rem; width:100%; }
.ext-card__footer .btn { width:100%; justify-content:center; }
.ext-card__footer .badge { display:block; text-align:center; }

/* Community stores (collapsible) */
.ext-stores { margin-bottom:1.5rem; }
.ext-stores__header {
  display:flex; align-items:center; gap:0.5rem;
  padding:0.75rem 1rem;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  cursor:pointer;
  font-size:0.9rem; font-weight:500;
  color:var(--crow-text-secondary);
  transition:border-color 0.15s;
  user-select:none;
}
.ext-stores__header:hover { border-color:var(--crow-accent); }
.ext-stores__chevron { margin-left:auto; transition:transform 0.2s; font-size:0.8rem; }
.ext-stores__chevron--open { transform:rotate(180deg); }
.ext-stores__body {
  display:none;
  padding:1rem;
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-top:none;
  border-radius:0 0 var(--crow-radius-card, 12px) var(--crow-radius-card, 12px);
}
.ext-stores__body--open { display:block; }

/* Help card */
.ext-help {
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  padding:1rem 1.25rem;
  color:var(--crow-text-muted);
  font-size:0.85rem;
}

/* Modal overlay */
#modal-overlay {
  display:none; position:fixed;
  top:0; left:0; width:100%; height:100%;
  background:rgba(0,0,0,0.6);
  z-index:1000;
  align-items:center; justify-content:center;
  backdrop-filter:blur(4px);
  -webkit-backdrop-filter:blur(4px);
}
#modal-content {
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  padding:1.5rem;
  max-width:500px; width:90%;
  max-height:80vh; overflow-y:auto; overflow-x:hidden;
  box-sizing:border-box; word-wrap:break-word;
  box-shadow:0 20px 60px rgba(0,0,0,0.5);
}

/* Glass overrides */
.theme-glass .ext-card,
.theme-glass .ext-installed__item,
.theme-glass .ext-installed-toggle,
.theme-glass .ext-stores__header,
.theme-glass .ext-stores__body {
  backdrop-filter:var(--crow-glass-blur);
  -webkit-backdrop-filter:var(--crow-glass-blur);
}
.theme-glass .ext-card:hover { box-shadow:0 8px 32px rgba(0,0,0,0.3); }
.theme-glass .ext-search__input {
  backdrop-filter:var(--crow-glass-blur);
  -webkit-backdrop-filter:var(--crow-glass-blur);
}

/* Detail modal */
#modal-content { position:relative; }
.ext-detail__header { display:flex; gap:1rem; align-items:flex-start; margin-bottom:1rem; }
.ext-detail__icon { flex-shrink:0; width:64px; height:64px; border-radius:16px; display:flex; align-items:center; justify-content:center; }
.ext-detail__info { flex:1; min-width:0; }
.ext-detail__title { font-family:'Fraunces',serif; font-size:1.15rem; font-weight:600; margin:0 0 0.25rem; color:var(--crow-text-primary); }
.ext-detail__author { font-size:0.75rem; font-family:'JetBrains Mono',monospace; color:var(--crow-text-muted); }
.ext-detail__badges { display:flex; flex-wrap:wrap; gap:0.3rem; margin:0.75rem 0; }
.ext-detail__desc { font-size:0.9rem; color:var(--crow-text-secondary); line-height:1.6; margin-bottom:1rem; }
.ext-detail__section { margin-bottom:1rem; }
.ext-detail__section-title { font-size:0.7rem; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:var(--crow-text-muted); margin-bottom:0.4rem; }
.ext-detail__tags { display:flex; flex-wrap:wrap; gap:0.3rem; }
.ext-detail__tag { font-size:0.7rem; padding:0.15rem 0.5rem; border-radius:4px; background:var(--crow-bg-elevated); color:var(--crow-text-secondary); }
.ext-detail__notes { font-size:0.85rem; color:var(--crow-text-secondary); background:var(--crow-bg-deep); border-radius:8px; padding:0.75rem 1rem; line-height:1.5; }
.ext-detail__req { display:flex; flex-wrap:wrap; gap:0.4rem; }
.ext-detail__req-chip { padding:0.2rem 0.6rem; border-radius:4px; background:var(--crow-bg-elevated); font-family:'JetBrains Mono',monospace; font-size:0.75rem; color:var(--crow-text-secondary); }
.ext-detail__actions { display:flex; gap:0.5rem; justify-content:flex-end; margin-top:1.25rem; padding-top:1rem; border-top:1px solid var(--crow-border); }
.ext-detail__close { position:absolute; top:0.5rem; right:0.75rem; background:none; border:none; color:var(--crow-text-muted); font-size:1.4rem; cursor:pointer; padding:0.25rem; line-height:1; transition:color 0.15s; }
.ext-detail__close:hover { color:var(--crow-text-primary); }

@media (max-width:480px) {
  .ext-detail__header { flex-direction:column; align-items:center; text-align:center; }
  .ext-detail__badges { justify-content:center; }
  .ext-detail__actions { flex-direction:column; }
  .ext-detail__actions .btn { width:100%; justify-content:center; }
}

/* Responsive */
@media (max-width:600px) {
  .ext-grid { grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:0.75rem; }
  .ext-card { padding:1rem 0.75rem; }
  .ext-card__icon { width:48px; height:48px; border-radius:12px; }
  .ext-installed__item { flex-wrap:wrap; }
  .ext-installed__actions { width:100%; justify-content:flex-end; margin-top:0.25rem; }
}
</style>`;
}

export default {
  id: "extensions",
  name: "Extensions",
  icon: "extensions",
  route: "/dashboard/extensions",
  navOrder: 80,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
    // Handle POST for store management
    if (req.method === "POST" && req.body) {
      const { action, store_url } = req.body;
      if (action === "add_store" && store_url) {
        const stores = getStores();
        if (!stores.find((s) => s.url === store_url)) {
          stores.push({ url: store_url, addedAt: new Date().toISOString() });
          saveStores(stores);
        }
        return res.redirect("/dashboard/extensions");
      }
      if (action === "remove_store" && store_url) {
        const stores = getStores().filter((s) => s.url !== store_url);
        saveStores(stores);
        return res.redirect("/dashboard/extensions");
      }
    }

    const installed = getInstalled();
    const installedCount = Object.keys(installed).length;

    // Load remote registry + merge with local (local entries override/supplement remote)
    let remoteAddons = [];
    let localAddons = [];
    let registrySource = "none";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        const remote = await resp.json();
        remoteAddons = remote["add-ons"] || [];
        registrySource = "remote";
      }
    } catch {}

    try {
      if (existsSync(LOCAL_REGISTRY)) {
        const local = JSON.parse(readFileSync(LOCAL_REGISTRY, "utf8"));
        localAddons = local["add-ons"] || [];
        if (registrySource === "none") registrySource = "local";
        else registrySource += "+local";
      }
    } catch {}

    // Merge: local entries override remote for matching IDs, new local entries are appended
    const localIds = new Set(localAddons.map((a) => a.id));
    const mergedAddons = [
      ...remoteAddons.filter((a) => !localIds.has(a.id)),
      ...localAddons,
    ];

    // Merge official add-ons with community store add-ons
    const officialAddons = mergedAddons.map((a) => ({ ...a, _community: false }));
    const communityStores = getStores();
    const communityResults = await Promise.all(communityStores.map((s) => fetchCommunityStore(s.url)));
    const communityAddons = communityResults.flatMap((r) => r.addons);

    const officialIds = new Set(officialAddons.map((a) => a.id));
    const dedupedCommunity = communityAddons.filter((a) => !officialIds.has(a.id));
    const available = [...officialAddons, ...dedupedCommunity];
    available.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    // Detect docker compose command variant
    let composeCmd = null;
    try {
      execFileSync("docker", ["compose", "version"], { timeout: 3000 });
      composeCmd = { cmd: "docker", prefix: ["compose"] };
    } catch {
      try {
        execFileSync("python3", ["-m", "compose", "version"], { timeout: 3000 });
        composeCmd = { cmd: "python3", prefix: ["-m", "compose"] };
      } catch {
        try {
          execFileSync("docker-compose", ["version"], { timeout: 3000 });
          composeCmd = { cmd: "docker-compose", prefix: [] };
        } catch {}
      }
    }

    // Fetch live container status for installed Docker bundles
    let bundleStatus = {};
    if (composeCmd) {
      try {
        const bundlesDir = join(CROW_DIR, "bundles");
        for (const [id] of Object.entries(installed)) {
          const composePath = join(bundlesDir, id, "docker-compose.yml");
          if (existsSync(composePath)) {
            try {
              const out = execFileSync(composeCmd.cmd, [...composeCmd.prefix, "ps", "--format", "json"], {
                cwd: join(bundlesDir, id),
                timeout: 5000,
              }).toString().trim();
              const containers = out.split("\n").filter(Boolean).map((line) => {
                try { return JSON.parse(line); } catch { return null; }
              }).filter(Boolean);
              bundleStatus[id] = {
                running: containers.some((c) => c.State === "running"),
                containers: containers.length,
              };
            } catch {
              bundleStatus[id] = { running: false, containers: 0 };
            }
          }
        }
      } catch {}
    }

    // ─── Search bar ───
    const searchHtml = `<div class="ext-search">
      <svg class="ext-search__icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input class="ext-search__input" type="text" placeholder="${t("extensions.searchPlaceholder", lang)}" id="ext-search">
    </div>`;

    // ─── Installed strip ───
    let installedHtml = "";
    if (installedCount > 0) {
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
        actions += `<button class="btn btn-sm btn-secondary bundle-uninstall" data-id="${escapeHtml(id)}" data-name="${escapeHtml(name)}" data-docker="${isDocker}">${t("extensions.remove", lang)}</button>`;

        return `<div class="ext-installed__item" data-addon-id="${escapeHtml(id)}" style="animation:fadeInUp 0.4s ease-out ${Math.min(i * 30, 300)}ms both">
          <div class="ext-installed__icon">${iconHtml}</div>
          <div class="ext-installed__info">
            <span class="ext-installed__name">${escapeHtml(name)}</span>
            ${statusBadge}
            <span class="ext-installed__meta">v${escapeHtml(info.version || registryEntry?.version || "?")} · ${t("extensions.installedDate", lang)} ${formatDate(info.installed_at || info.installedAt)}</span>
          </div>
          <div class="ext-installed__actions">${actions}</div>
          <div id="status-${escapeHtml(id)}" style="font-size:0.8rem;margin-top:0.4rem;display:none;width:100%"></div>
        </div>`;
      }).join("");

      installedHtml = `
        <div class="ext-installed-toggle" onclick="(function(){var b=document.getElementById('installed-list');var c=document.getElementById('installed-chevron');b.classList.toggle('ext-installed__list--open');c.classList.toggle('ext-installed-toggle__chevron--open')})()">
          <span>${t("extensions.installedSection", lang)} (${installedCount})</span>
          <span class="ext-installed-toggle__chevron" id="installed-chevron">&#9662;</span>
        </div>
        <div class="ext-installed__list" id="installed-list">${items}</div>`;
    }

    // ─── Category tabs ───
    const categories = [...new Set(available.map((a) => a.category || "other"))].sort();
    const categoryCounts = {};
    for (const cat of categories) {
      categoryCounts[cat] = available.filter((a) => (a.category || "other") === cat).length;
    }

    const tabsHtml = `<div class="ext-tabs" id="ext-tabs">
      <button class="ext-tab ext-tab--active" data-category="all">${t("extensions.categoryAll", lang)} (${available.length})</button>
      ${categories.map((cat) => {
        const labelKey = CATEGORY_LABELS[cat] || "extensions.categoryOther";
        return `<button class="ext-tab" data-category="${escapeHtml(cat)}">${t(labelKey, lang)} (${categoryCounts[cat]})</button>`;
      }).join("")}
    </div>`;

    // ─── Available add-on cards (grid) ───
    let gridHtml;
    if (available.length === 0) {
      gridHtml = `<div style="text-align:center;padding:2rem;color:var(--crow-text-muted)">
        <h3>${t("extensions.registryUnavailable", lang)}</h3>
        <p>${t("extensions.registryUnavailableDesc", lang)}</p>
      </div>`;
    } else {
      const cards = available.map((addon, i) => {
        const isInstalled = installed[addon.id];
        const cat = addon.category || "other";
        const catColor = getCategoryColor(cat);
        const iconHtml = renderIcon(addon, 32);

        const communityBadge = addon._community
          ? `<span class="ext-card__badge ext-card__badge--community" title="${t("extensions.communityNotVerified", lang)}">${t("extensions.community", lang)}</span>`
          : `<span class="ext-card__badge ext-card__badge--official">${t("extensions.official", lang)}</span>`;

        const typeBadge = `<span class="ext-card__badge ext-card__badge--type">${escapeHtml(addon.type)}</span>`;
        const resources = formatResources(addon.requires);

        let installButton;
        if (isInstalled) {
          installButton = badge(t("extensions.installedBadge", lang), "published");
        } else {
          const envVarsAttr = escapeHtml(JSON.stringify(addon.env_vars || []));
          const minRam = addon.requires?.min_ram_mb || 0;
          const minDisk = addon.requires?.min_disk_mb || 0;
          installButton = `<button class="btn btn-sm btn-primary bundle-install" data-id="${escapeHtml(addon.id)}" data-name="${escapeHtml(addon.name)}" data-envvars="${envVarsAttr}" data-minram="${minRam}" data-mindisk="${minDisk}" data-community="${addon._community ? "true" : "false"}">${t("extensions.install", lang)}</button>`;
        }

        const tags = (addon.tags || []).join(",");
        const delay = Math.min(i * 30, 300);

        return `<div class="ext-card addon-card" data-addon-id="${escapeHtml(addon.id)}" data-addon-type="${escapeHtml(addon.type)}" data-addon-category="${escapeHtml(cat)}" data-addon-name="${escapeHtml((addon.name || "").toLowerCase())}" data-addon-desc="${escapeHtml((addon.description || "").toLowerCase())}" data-addon-tags="${escapeHtml(tags.toLowerCase())}" style="animation:fadeInUp 0.4s ease-out ${delay}ms both">
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
      }).join("");

      gridHtml = `<div class="ext-grid" id="addon-grid">${cards}</div>`;
    }

    const sourceNote = registrySource === "local"
      ? `<div style="font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:0.5rem">${t("extensions.localRegistry", lang)}</div>`
      : "";

    // ─── Community stores (collapsible) ───
    const storesHtml = `<div class="ext-stores">
      <div class="ext-stores__header" onclick="(function(e){var b=document.getElementById('stores-body');var c=document.getElementById('stores-chevron');b.classList.toggle('ext-stores__body--open');c.classList.toggle('ext-stores__chevron--open')})()" >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
        ${t("extensions.communityStores", lang)} (${communityStores.length})
        <span class="ext-stores__chevron" id="stores-chevron">&#9662;</span>
      </div>
      <div class="ext-stores__body" id="stores-body">
        ${communityStores.length > 0 ? communityStores.map((s) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--crow-border)">
            <span style="font-size:0.85rem;color:var(--crow-text-secondary);font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">${escapeHtml(s.url)}</span>
            <form method="POST" style="margin:0">
              <input type="hidden" name="action" value="remove_store">
              <input type="hidden" name="store_url" value="${escapeHtml(s.url)}">
              <button type="submit" class="btn btn-sm" style="color:var(--crow-text-muted);border-color:var(--crow-border);font-size:0.75rem">${t("extensions.remove", lang)}</button>
            </form>
          </div>
        `).join("") : `<p style="font-size:0.85rem;color:var(--crow-text-muted);margin-bottom:0.75rem">${t("extensions.noStoresConfigured", lang)}</p>`}
        <form method="POST" style="display:flex;gap:0.5rem;margin-top:0.75rem">
          <input type="hidden" name="action" value="add_store">
          <input type="text" name="store_url" placeholder="https://github.com/user/crow-store" style="flex:1;padding:0.4rem 0.6rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);font-size:0.85rem;font-family:'JetBrains Mono',monospace;box-sizing:border-box">
          <button type="submit" class="btn btn-sm btn-primary">${t("extensions.addStore", lang)}</button>
        </form>
      </div>
    </div>`;

    // ─── Help card ───
    const helpHtml = `<div class="ext-help">
      ${t("extensions.askAi", lang)} <code>"install the [name] add-on"</code><br>
      ${t("extensions.toCreateOwn", lang)} <a href="/crow/developers/creating-addons" style="color:var(--crow-accent)">${t("extensions.devGuide", lang)}</a>.
    </div>`;

    // ─── Addon registry blob for client-side detail modal ───
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
        tags: addon.tags || [],
        notes: addon.notes || "",
        ports: addon.ports || [],
        webUI: addon.webUI || null,
        requires: addon.requires || {},
        env_vars: (addon.env_vars || []).map(ev => ({
          name: ev.name, description: ev.description,
          default: ev.secret ? "" : (ev.default || ""), required: ev.required, secret: !!ev.secret,
        })),
        official: !addon._community,
        _iconHtml: renderIcon(addon, 48),
        _iconBg: catColor.bg,
        _iconColor: catColor.color,
        _installed: !!installed[addon.id],
      };
    }
    const addonRegistryJson = JSON.stringify(addonMap).replace(/<\//g, "<\\/");
    const addonRegistryScript = `<script id="addon-registry" type="application/json">${addonRegistryJson}<\/script>`;

    // ─── Modal + client-side JavaScript ───
    // Modal JS preserved verbatim from original; filter + search JS rewritten
    const interactiveScript = `
    <div id="modal-overlay">
      <div id="modal-content"></div>
    </div>

    <script>
      (function() {
        var API = "/dashboard/bundles/api";

        // --- Modal helpers ---
        function showModal() { document.getElementById("modal-overlay").style.display = "flex"; }
        function hideModal() { document.getElementById("modal-overlay").style.display = "none"; }
        document.getElementById("modal-overlay").addEventListener("click", function(e) {
          if (e.target === this) hideModal();
        });

        function setModalContent(el) {
          var mc = document.getElementById("modal-content");
          mc.replaceChildren();
          mc.appendChild(el);
        }

        function showStatus(id, msg, type) {
          var el = document.getElementById("status-" + id);
          if (el) {
            el.style.display = "block";
            el.style.color = type === "error" ? "var(--crow-error, #e74c3c)" : "var(--crow-accent)";
            el.textContent = msg;
          }
        }

        function apiCall(endpoint, body) {
          return fetch(API + "/" + endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); });
        }

        // --- Bundle start/stop ---
        document.querySelectorAll(".bundle-action").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var action = this.dataset.action;
            var id = this.dataset.id;
            showStatus(id, action === "start" ? '${tJs("extensions.starting", lang)}' : '${tJs("extensions.stopping", lang)}', "info");
            apiCall(action, { bundle_id: id }).then(function(res) {
              if (res.ok) {
                showStatus(id, res.data.message || '${tJs("extensions.done", lang)}', "info");
                setTimeout(function() { location.reload(); }, 1500);
              } else {
                showStatus(id, res.data.error || '${tJs("extensions.failed", lang)}', "error");
              }
            }).catch(function(err) {
              showStatus(id, '${tJs("extensions.networkError", lang)}', "error");
            });
          });
        });

        // --- Install modal (extracted as named function) ---
        function showInstallModal(id, name, envVars, minRam, minDisk, isCommunity) {
            var frag = document.createElement("div");

            var h3 = document.createElement("h3");
            h3.style.cssText = "font-family:Fraunces,serif;margin-bottom:0.75rem";
            h3.textContent = '${tJs("extensions.installTitle", lang)}' + " " + name;
            frag.appendChild(h3);

            // PR 0: Consent gate. Before showing env config, check whether the bundle
            // requires server-validated consent (privileged or consent_required).
            // If yes, render a warning box with capability list and gate the install
            // button until the user checks "I understand" (and types INSTALL for privileged).
            // The consent_token returned from /consent-challenge is passed to /install.
            var consentToken = null;       // populated on /consent-challenge if required
            var consentSatisfied = true;   // false until user passes the gate (only when consent required)
            var installBtnRef = null;      // forward ref so consent UI can enable/disable it

            function refreshInstallBtnState() {
              if (!installBtnRef) return;
              installBtnRef.disabled = !consentSatisfied;
            }

            // Async: fetch consent challenge (non-blocking; install button starts disabled if required)
            fetch(API + "/consent-challenge/" + encodeURIComponent(id) + "?lang=" + encodeURIComponent('${lang}'))
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (!data || data.required === false) return; // no consent required
                consentSatisfied = false; // gate the install button
                refreshInstallBtnState();
                consentToken = data.token;

                var box = document.createElement("div");
                var isPriv = data.privileged === true;
                var bg = isPriv ? "rgba(231,76,60,0.10)" : "rgba(240,173,78,0.10)";
                var bd = isPriv ? "rgba(231,76,60,0.35)" : "rgba(240,173,78,0.35)";
                var color = isPriv ? "#e74c3c" : "#f0ad4e";
                box.style.cssText = "background:" + bg + ";border:1px solid " + bd + ";border-radius:6px;padding:0.85rem 1rem;margin-bottom:1rem";

                var title = document.createElement("div");
                title.style.cssText = "font-weight:600;color:" + color + ";margin-bottom:0.5rem;font-size:0.95rem";
                title.textContent = isPriv
                  ? "Privileged bundle — explicit consent required"
                  : "Consent required";
                box.appendChild(title);

                var msg = document.createElement("div");
                msg.style.cssText = "color:var(--crow-text-secondary);font-size:0.85rem;line-height:1.5;margin-bottom:0.6rem;white-space:pre-wrap";
                msg.textContent = data.message || "";
                box.appendChild(msg);

                if (Array.isArray(data.capabilities) && data.capabilities.length > 0) {
                  var capLabel = document.createElement("div");
                  capLabel.style.cssText = "font-size:0.78rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin:0.5rem 0 0.25rem";
                  capLabel.textContent = "Capabilities";
                  box.appendChild(capLabel);

                  var capList = document.createElement("ul");
                  capList.style.cssText = "margin:0 0 0.5rem 1.25rem;color:var(--crow-text-secondary);font-size:0.85rem;line-height:1.5";
                  data.capabilities.forEach(function(c) {
                    var li = document.createElement("li");
                    li.textContent = c;
                    capList.appendChild(li);
                  });
                  box.appendChild(capList);
                }

                if (Array.isArray(data.prereqs) && data.prereqs.length > 0) {
                  var preqLabel = document.createElement("div");
                  preqLabel.style.cssText = "font-size:0.78rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin:0.5rem 0 0.25rem";
                  preqLabel.textContent = "Required bundles";
                  box.appendChild(preqLabel);

                  var anyMissing = false;
                  var preqList = document.createElement("ul");
                  preqList.style.cssText = "margin:0 0 0.5rem 1.25rem;font-size:0.85rem;line-height:1.5";
                  data.prereqs.forEach(function(p) {
                    var li = document.createElement("li");
                    li.style.color = p.installed ? "var(--crow-success, #2ecc71)" : "var(--crow-error, #e74c3c)";
                    li.textContent = (p.installed ? "✓ " : "✗ ") + p.id + (p.installed ? " (installed)" : " (NOT installed — install this first)");
                    if (!p.installed) anyMissing = true;
                    preqList.appendChild(li);
                  });
                  box.appendChild(preqList);
                  if (anyMissing) {
                    consentSatisfied = false;
                    refreshInstallBtnState();
                  }
                }

                // Consent gate: checkbox + (for privileged) typed confirmation
                var gate = document.createElement("div");
                gate.style.cssText = "margin-top:0.5rem";

                var checkLabel = document.createElement("label");
                checkLabel.style.cssText = "display:flex;align-items:center;gap:0.4rem;font-size:0.88rem;color:var(--crow-text-secondary);cursor:pointer;margin-bottom:0.4rem";
                var check = document.createElement("input");
                check.type = "checkbox";
                checkLabel.appendChild(check);
                checkLabel.appendChild(document.createTextNode(" I understand and consent"));
                gate.appendChild(checkLabel);

                var confirmInput = null;
                if (isPriv) {
                  var confirmLabel = document.createElement("label");
                  confirmLabel.style.cssText = "display:block;font-size:0.78rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin:0.4rem 0 0.2rem";
                  confirmLabel.textContent = 'Type "INSTALL" to confirm';
                  gate.appendChild(confirmLabel);
                  confirmInput = document.createElement("input");
                  confirmInput.type = "text";
                  confirmInput.placeholder = "INSTALL";
                  confirmInput.style.cssText = "width:100%;padding:0.45rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);font-family:JetBrains Mono,monospace;font-size:0.85rem;box-sizing:border-box";
                  gate.appendChild(confirmInput);
                }

                function evaluateGate() {
                  var ok = check.checked;
                  if (isPriv && confirmInput) {
                    ok = ok && (confirmInput.value || "").trim().toLowerCase() === "install";
                  }
                  // dependents must also be installed
                  if (Array.isArray(data.prereqs)) {
                    for (var i = 0; i < data.prereqs.length; i++) {
                      if (!data.prereqs[i].installed) ok = false;
                    }
                  }
                  consentSatisfied = ok;
                  refreshInstallBtnState();
                }

                check.addEventListener("change", evaluateGate);
                if (confirmInput) confirmInput.addEventListener("input", evaluateGate);
                box.appendChild(gate);

                // Insert consent box right after the heading
                frag.insertBefore(box, frag.children[1] || null);
              })
              .catch(function() {
                // Network error — leave install enabled (fail-open). The server will reject
                // the install if consent is actually required (no token) so it's safe.
              });

            if (isCommunity) {
              var communityWarn = document.createElement("div");
              communityWarn.style.cssText = "background:rgba(240,173,78,0.1);border:1px solid rgba(240,173,78,0.3);border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem";
              var cwTitle = document.createElement("div");
              cwTitle.style.cssText = "font-weight:600;color:#f0ad4e;margin-bottom:0.25rem;font-size:0.85rem";
              cwTitle.textContent = '${tJs("extensions.communityWarningTitle", lang)}';
              communityWarn.appendChild(cwTitle);
              var cwText = document.createElement("div");
              cwText.style.cssText = "color:var(--crow-text-secondary);font-size:0.8rem";
              cwText.textContent = '${tJs("extensions.communityWarningDesc", lang)}';
              communityWarn.appendChild(cwText);
              frag.appendChild(communityWarn);
            }

            var desc = document.createElement("p");
            desc.style.cssText = "color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:1rem";
            desc.textContent = '${tJs("extensions.installDesc", lang)}';
            frag.appendChild(desc);

            if (minRam > 0 || minDisk > 0) {
              var warnDiv = document.createElement("div");
              warnDiv.id = "resource-warning";
              warnDiv.style.cssText = "font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.75rem";
              warnDiv.textContent = '${tJs("extensions.working", lang)}';
              frag.appendChild(warnDiv);
              fetch(API + "/status").then(function(r) { return r.json(); }).catch(function() { return null; }).then(function() {
                fetch("/api/health").then(function(r) { return r.json(); }).then(function(h) {
                  var warnings = [];
                  if (minRam > 0 && h && h.ram_free_mb && h.ram_free_mb < minRam) {
                    warnings.push('${tJs("extensions.needsRam", lang)}' + minRam + '${tJs("extensions.ramFree", lang)}' + " " + h.ram_free_mb + '${tJs("extensions.mbFree", lang)}');
                  }
                  if (minDisk > 0 && h && h.disk_free_mb && h.disk_free_mb < minDisk) {
                    warnings.push('${tJs("extensions.needsDisk", lang)}' + minDisk + '${tJs("extensions.diskFree", lang)}' + " " + h.disk_free_mb + '${tJs("extensions.mbFree", lang)}');
                  }
                  if (warnings.length > 0) {
                    warnDiv.style.cssText = "font-size:0.8rem;color:var(--crow-warning, #f0ad4e);background:rgba(240,173,78,0.1);padding:0.75rem;border-radius:4px;margin-bottom:0.75rem;border:1px solid rgba(240,173,78,0.3)";
                    warnDiv.textContent = warnings.join(" ") + " " + '${tJs("extensions.installMayCauseInstability", lang)}';
                  } else {
                    warnDiv.style.display = "none";
                  }
                }).catch(function() { warnDiv.style.display = "none"; });
              });
            }

            var envNames = [];
            if (envVars.length > 0) {
              var configH = document.createElement("h4");
              configH.style.cssText = "margin:0 0 0.5rem;font-size:0.9rem;color:var(--crow-text-secondary)";
              configH.textContent = '${tJs("extensions.configuration", lang)}';
              frag.appendChild(configH);

              envVars.forEach(function(ev) {
                envNames.push(ev.name);
                var wrap = document.createElement("div");
                wrap.style.marginBottom = "0.75rem";

                var label = document.createElement("label");
                label.style.cssText = "display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem;text-transform:uppercase;letter-spacing:0.05em";
                label.textContent = ev.name + (ev.required ? " *" : "");
                wrap.appendChild(label);

                var input = document.createElement("input");
                input.type = ev.secret ? "password" : "text";
                input.id = "env_" + ev.name;
                input.value = ev.default || "";
                input.placeholder = ev.description || "";
                input.style.cssText = "width:100%;padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);font-family:JetBrains Mono,monospace;font-size:0.85rem;box-sizing:border-box";
                wrap.appendChild(input);

                var hint = document.createElement("div");
                hint.style.cssText = "font-size:0.7rem;color:var(--crow-text-muted);margin-top:0.2rem";
                hint.textContent = ev.description || "";
                wrap.appendChild(hint);

                frag.appendChild(wrap);
              });
            }

            var statusDiv = document.createElement("div");
            statusDiv.id = "install-status";
            statusDiv.style.cssText = "font-size:0.85rem;margin:0.75rem 0;display:none";
            frag.appendChild(statusDiv);

            var btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem";

            var cancelBtn = document.createElement("button");
            cancelBtn.className = "btn btn-secondary";
            cancelBtn.textContent = '${tJs("common.cancel", lang)}';
            cancelBtn.addEventListener("click", hideModal);
            btnRow.appendChild(cancelBtn);

            var installBtn = document.createElement("button");
            installBtn.className = "btn btn-primary";
            installBtn.textContent = '${tJs("extensions.install", lang)}';
            installBtnRef = installBtn;
            // Start disabled if consent is required (will be enabled when gate is satisfied);
            // initial value of consentSatisfied is true and gets flipped by the consent fetch.
            refreshInstallBtnState();
            installBtn.addEventListener("click", function() {
              installBtn.disabled = true;
              installBtn.textContent = '${tJs("extensions.installing", lang)}';
              statusDiv.style.display = "block";
              statusDiv.style.color = "var(--crow-accent)";
              statusDiv.textContent = '${tJs("extensions.copyingFiles", lang)}';

              var envData = {};
              envNames.forEach(function(n) {
                var inp = document.getElementById("env_" + n);
                if (inp && inp.value) envData[n] = inp.value;
              });

              var payload = { bundle_id: id, env_vars: envData };
              if (consentToken) payload.consent_token = consentToken;

              apiCall("install", payload).then(function(res) {
                if (res.ok && res.data.job_id) {
                  pollJob(res.data.job_id, statusDiv, installBtn);
                } else if (res.data && res.data.consent_expired) {
                  // PR 0: Consent token expired (e.g., slow image pull). Mint a fresh token
                  // silently and retry the install with the same env config preserved.
                  statusDiv.style.color = "var(--crow-warning, #f0ad4e)";
                  statusDiv.textContent = "Consent expired — refreshing and retrying...";
                  fetch(API + "/consent-challenge/" + encodeURIComponent(id) + "?lang=" + encodeURIComponent('${lang}'))
                    .then(function(r) { return r.json(); })
                    .then(function(d) {
                      if (d && d.token) {
                        consentToken = d.token;
                        installBtn.click();
                      } else {
                        statusDiv.style.color = "var(--crow-error, #e74c3c)";
                        statusDiv.textContent = "Could not refresh consent. Retry manually.";
                        installBtn.disabled = false;
                        installBtn.textContent = '${tJs("extensions.retry", lang)}';
                      }
                    });
                } else {
                  statusDiv.style.color = "var(--crow-error, #e74c3c)";
                  statusDiv.textContent = res.data.error || '${tJs("extensions.installFailed", lang)}';
                  installBtn.disabled = false;
                  installBtn.textContent = '${tJs("extensions.retry", lang)}';
                }
              }).catch(function() {
                statusDiv.style.color = "var(--crow-error, #e74c3c)";
                statusDiv.textContent = '${tJs("extensions.networkError", lang)}';
                installBtn.disabled = false;
                installBtn.textContent = '${tJs("extensions.retry", lang)}';
              });
            });
            btnRow.appendChild(installBtn);
            frag.appendChild(btnRow);

            setModalContent(frag);
            showModal();
        }

        document.querySelectorAll(".bundle-install").forEach(function(btn) {
          btn.addEventListener("click", function(e) {
            e.stopPropagation();
            showInstallModal(this.dataset.id, this.dataset.name,
              JSON.parse(this.dataset.envvars || "[]"),
              parseInt(this.dataset.minram || "0", 10),
              parseInt(this.dataset.mindisk || "0", 10),
              this.dataset.community === "true");
          });
        });

        // --- Uninstall modal ---
        document.querySelectorAll(".bundle-uninstall").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var id = this.dataset.id;
            var name = this.dataset.name;
            var isDocker = this.dataset.docker === "true";

            var frag = document.createElement("div");

            var h3 = document.createElement("h3");
            h3.style.cssText = "font-family:Fraunces,serif;margin-bottom:0.75rem";
            h3.textContent = '${tJs("extensions.remove", lang)}' + " " + name + "?";
            frag.appendChild(h3);

            var warnBox = document.createElement("div");
            warnBox.style.cssText = "background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.25);border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;box-sizing:border-box";

            var warnTitle = document.createElement("div");
            warnTitle.style.cssText = "font-weight:600;color:var(--crow-error, #e74c3c);margin-bottom:0.35rem;font-size:0.9rem";
            warnTitle.textContent = '${tJs("extensions.cannotBeUndone", lang)}';
            warnBox.appendChild(warnTitle);

            var warnText = document.createElement("div");
            warnText.style.cssText = "color:var(--crow-text-secondary);font-size:0.85rem;line-height:1.5";
            warnText.textContent = isDocker
              ? '${tJs("extensions.uninstallDockerDesc", lang)}'
              : '${tJs("extensions.uninstallDesc", lang)}';
            warnBox.appendChild(warnText);
            frag.appendChild(warnBox);

            var checkId = null;
            if (isDocker) {
              var dataBox = document.createElement("div");
              dataBox.style.cssText = "background:rgba(240,173,78,0.08);border:1px solid rgba(240,173,78,0.25);border-radius:6px;padding:0.75rem 1rem;margin-bottom:0.75rem;box-sizing:border-box";

              var hint = document.createElement("div");
              hint.style.cssText = "font-size:0.8rem;color:var(--crow-text-secondary);margin-bottom:0.5rem";
              hint.textContent = '${tJs("extensions.dataDeleteHint", lang)}';
              dataBox.appendChild(hint);

              var label = document.createElement("label");
              label.style.cssText = "display:inline-flex;align-items:center;gap:0.4rem;font-size:0.85rem;color:var(--crow-text-secondary);cursor:pointer;margin:0";
              var check = document.createElement("input");
              check.type = "checkbox";
              check.id = "delete-data-check";
              checkId = check.id;
              label.appendChild(check);
              label.appendChild(document.createTextNode('${tJs("extensions.deleteStoredData", lang)}'));
              dataBox.appendChild(label);

              frag.appendChild(dataBox);
            }

            var statusDiv = document.createElement("div");
            statusDiv.style.cssText = "font-size:0.85rem;margin:0.75rem 0;display:none";
            frag.appendChild(statusDiv);

            var btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem";

            var cancelBtn = document.createElement("button");
            cancelBtn.className = "btn btn-secondary";
            cancelBtn.textContent = '${tJs("common.cancel", lang)}';
            cancelBtn.addEventListener("click", hideModal);
            btnRow.appendChild(cancelBtn);

            var removeBtn = document.createElement("button");
            removeBtn.style.cssText = "background:var(--crow-error, #e74c3c);color:white;border:none";
            removeBtn.className = "btn";
            removeBtn.textContent = '${tJs("extensions.remove", lang)}';
            removeBtn.addEventListener("click", function() {
              var deleteData = checkId ? document.getElementById(checkId).checked : false;
              removeBtn.disabled = true;
              removeBtn.textContent = '${tJs("extensions.removing", lang)}';
              statusDiv.style.display = "block";
              statusDiv.style.color = "var(--crow-accent)";
              statusDiv.textContent = '${tJs("extensions.stoppingAndRemoving", lang)}';

              apiCall("uninstall", { bundle_id: id, delete_data: deleteData }).then(function(res) {
                if (res.ok && res.data.job_id) {
                  pollJob(res.data.job_id, statusDiv, removeBtn);
                } else {
                  statusDiv.style.color = "var(--crow-error, #e74c3c)";
                  statusDiv.textContent = res.data.error || '${tJs("extensions.removalFailed", lang)}';
                  removeBtn.disabled = false;
                  removeBtn.textContent = '${tJs("extensions.retry", lang)}';
                }
              }).catch(function() {
                statusDiv.style.color = "var(--crow-error, #e74c3c)";
                statusDiv.textContent = '${tJs("extensions.networkError", lang)}';
                removeBtn.disabled = false;
                removeBtn.textContent = '${tJs("extensions.retry", lang)}';
              });
            });
            btnRow.appendChild(removeBtn);
            frag.appendChild(btnRow);

            setModalContent(frag);
            showModal();
          });
        });

        // --- Wait for gateway restart ---
        function waitForRestart(statusEl) {
          statusEl.style.color = "var(--crow-accent)";
          statusEl.textContent = '${tJs("extensions.gatewayRestarting", lang)}';
          setTimeout(function pollRestart() {
            fetch("/health").then(function(r) {
              if (r.ok) location.reload();
              else setTimeout(pollRestart, 2000);
            }).catch(function() { setTimeout(pollRestart, 2000); });
          }, 3000);
        }

        // --- Job polling ---
        function pollJob(jobId, statusEl, btn) {
          fetch(API + "/jobs/" + jobId).then(function(r) { return r.json(); }).then(function(job) {
            statusEl.textContent = job.log[job.log.length - 1] || '${tJs("extensions.working", lang)}';
            if (job.status === "complete") {
              statusEl.style.color = "var(--crow-accent)";
              statusEl.textContent = '${tJs("extensions.done", lang)}';
              setTimeout(function() { location.reload(); }, 1500);
            } else if (job.status === "complete_restart") {
              statusEl.style.color = "var(--crow-accent)";
              var lastLog = job.log[job.log.length - 1] || "";
              var aiChatMsg = job.log.find(function(l) { return l.indexOf("AI Chat") !== -1; });
              if (aiChatMsg) {
                statusEl.textContent = aiChatMsg + " — " + '${tJs("extensions.restartingGatewayChanges", lang)}';
              } else {
                statusEl.textContent = '${tJs("extensions.gatewayRestarting", lang)}';
              }
              fetch(API + "/restart", { method: "POST", headers: { "Content-Type": "application/json" } }).catch(function() {});
              waitForRestart(statusEl);
            } else if (job.status === "failed") {
              statusEl.style.color = "var(--crow-error, #e74c3c)";
              statusEl.textContent = '${tJs("extensions.failed", lang)}' + " " + (job.log[job.log.length - 1] || '${tJs("extensions.unknownError", lang)}');
              btn.disabled = false;
              btn.textContent = '${tJs("extensions.retry", lang)}';
            } else {
              setTimeout(function() { pollJob(jobId, statusEl, btn); }, 1000);
            }
          }).catch(function() {
            waitForRestart(statusEl);
          });
        }

        // --- Category filter tabs ---
        function applyFilters() {
          var activeTab = document.querySelector(".ext-tab--active");
          var cat = activeTab ? activeTab.dataset.category : "all";
          var searchInput = document.getElementById("ext-search");
          var q = searchInput ? searchInput.value.toLowerCase().trim() : "";

          document.querySelectorAll(".addon-card").forEach(function(card) {
            var catMatch = cat === "all" || card.dataset.addonCategory === cat;
            var searchMatch = !q
              || (card.dataset.addonName || "").indexOf(q) !== -1
              || (card.dataset.addonDesc || "").indexOf(q) !== -1
              || (card.dataset.addonTags || "").indexOf(q) !== -1;
            card.style.display = (catMatch && searchMatch) ? "" : "none";
          });
        }

        document.querySelectorAll(".ext-tab").forEach(function(btn) {
          btn.addEventListener("click", function() {
            document.querySelectorAll(".ext-tab").forEach(function(b) { b.classList.remove("ext-tab--active"); });
            this.classList.add("ext-tab--active");
            applyFilters();
          });
        });

        // --- Search ---
        var searchInput = document.getElementById("ext-search");
        if (searchInput) {
          searchInput.addEventListener("input", applyFilters);
        }

        // --- Detail modal ---
        var ADDON_DATA = (function() {
          var el = document.getElementById("addon-registry");
          if (!el) return {};
          try { return JSON.parse(el.textContent); } catch(e) { return {}; }
        })();

        function showDetailModal(addon) {
          var frag = document.createElement("div");
          frag.style.position = "relative";

          // Close button
          var closeBtn = document.createElement("button");
          closeBtn.className = "ext-detail__close";
          closeBtn.textContent = "\\u00D7";
          closeBtn.addEventListener("click", hideModal);
          frag.appendChild(closeBtn);

          // Header: icon + info
          var header = document.createElement("div");
          header.className = "ext-detail__header";

          var iconWrap = document.createElement("div");
          iconWrap.className = "ext-detail__icon";
          iconWrap.style.cssText = "background:" + (addon._iconBg || "var(--crow-bg-elevated)") + ";color:" + (addon._iconColor || "var(--crow-accent)");
          // Safety: _iconHtml is server-generated from hardcoded SVG dictionary in logos.js.
          // getAddonLogo() returns null for unknown IDs; community addons get emoji/letter fallback.
          // No user-supplied content reaches innerHTML here.
          iconWrap.innerHTML = addon._iconHtml || "";
          header.appendChild(iconWrap);

          var info = document.createElement("div");
          info.className = "ext-detail__info";

          var title = document.createElement("h3");
          title.className = "ext-detail__title";
          title.textContent = addon.name || addon.id;
          info.appendChild(title);

          var author = document.createElement("div");
          author.className = "ext-detail__author";
          author.textContent = "v" + (addon.version || "1.0.0") + " \\u00B7 " + (addon.author || "community");
          info.appendChild(author);

          header.appendChild(info);
          frag.appendChild(header);

          // Badges
          var badges = document.createElement("div");
          badges.className = "ext-detail__badges";

          var catBadge = document.createElement("span");
          catBadge.className = "ext-card__badge";
          catBadge.style.cssText = "color:" + (addon._iconColor || "var(--crow-accent)") + ";background:" + (addon._iconBg || "var(--crow-accent-muted)");
          catBadge.textContent = addon.category || "other";
          badges.appendChild(catBadge);

          var typeBadge = document.createElement("span");
          typeBadge.className = "ext-card__badge ext-card__badge--type";
          typeBadge.textContent = addon.type || "bundle";
          badges.appendChild(typeBadge);

          var officialBadge = document.createElement("span");
          officialBadge.className = addon.official ? "ext-card__badge ext-card__badge--official" : "ext-card__badge ext-card__badge--community";
          officialBadge.textContent = addon.official ? '${tJs("extensions.official", lang)}' : '${tJs("extensions.community", lang)}';
          badges.appendChild(officialBadge);

          frag.appendChild(badges);

          // Description
          var descP = document.createElement("p");
          descP.className = "ext-detail__desc";
          descP.textContent = addon.description || "";
          frag.appendChild(descP);

          // Tags
          if (addon.tags && addon.tags.length > 0) {
            var tagSection = document.createElement("div");
            tagSection.className = "ext-detail__section";
            var tagTitle = document.createElement("div");
            tagTitle.className = "ext-detail__section-title";
            tagTitle.textContent = '${tJs("extensions.tags", lang)}';
            tagSection.appendChild(tagTitle);
            var tagWrap = document.createElement("div");
            tagWrap.className = "ext-detail__tags";
            addon.tags.forEach(function(tag) {
              var chip = document.createElement("span");
              chip.className = "ext-detail__tag";
              chip.textContent = tag;
              tagWrap.appendChild(chip);
            });
            tagSection.appendChild(tagWrap);
            frag.appendChild(tagSection);
          }

          // Requirements
          var req = addon.requires || {};
          if (req.min_ram_mb || req.min_disk_mb || req.gpu) {
            var reqSection = document.createElement("div");
            reqSection.className = "ext-detail__section";
            var reqTitle = document.createElement("div");
            reqTitle.className = "ext-detail__section-title";
            reqTitle.textContent = '${tJs("extensions.requirements", lang)}';
            reqSection.appendChild(reqTitle);
            var reqWrap = document.createElement("div");
            reqWrap.className = "ext-detail__req";
            if (req.min_ram_mb) {
              var ramChip = document.createElement("span");
              ramChip.className = "ext-detail__req-chip";
              ramChip.textContent = (req.min_ram_mb >= 1024 ? Math.floor(req.min_ram_mb / 1024) + "GB" : req.min_ram_mb + "MB") + " RAM";
              reqWrap.appendChild(ramChip);
            }
            if (req.min_disk_mb) {
              var diskChip = document.createElement("span");
              diskChip.className = "ext-detail__req-chip";
              diskChip.textContent = (req.min_disk_mb >= 1024 ? Math.floor(req.min_disk_mb / 1024) + "GB" : req.min_disk_mb + "MB") + " disk";
              reqWrap.appendChild(diskChip);
            }
            if (req.gpu) {
              var gpuChip = document.createElement("span");
              gpuChip.className = "ext-detail__req-chip";
              gpuChip.style.cssText = "color:var(--crow-accent);border:1px solid var(--crow-accent)";
              gpuChip.textContent = '${tJs("extensions.gpuRequired", lang)}';
              reqWrap.appendChild(gpuChip);
            }
            reqSection.appendChild(reqWrap);
            frag.appendChild(reqSection);
          }

          // Ports
          if (addon.ports && addon.ports.length > 0) {
            var portSection = document.createElement("div");
            portSection.className = "ext-detail__section";
            var portTitle = document.createElement("div");
            portTitle.className = "ext-detail__section-title";
            portTitle.textContent = '${tJs("extensions.ports", lang)}';
            portSection.appendChild(portTitle);
            var portWrap = document.createElement("div");
            portWrap.className = "ext-detail__req";
            addon.ports.forEach(function(p) {
              var chip = document.createElement("span");
              chip.className = "ext-detail__req-chip";
              chip.textContent = p;
              portWrap.appendChild(chip);
            });
            portSection.appendChild(portWrap);
            frag.appendChild(portSection);
          }

          // Web UI
          if (addon.webUI) {
            var uiSection = document.createElement("div");
            uiSection.className = "ext-detail__section";
            var uiTitle = document.createElement("div");
            uiTitle.className = "ext-detail__section-title";
            uiTitle.textContent = '${tJs("extensions.webInterface", lang)}';
            uiSection.appendChild(uiTitle);
            var uiChip = document.createElement("span");
            uiChip.className = "ext-detail__req-chip";
            uiChip.textContent = (addon.webUI.label || "Web UI") + " :" + (addon.webUI.port || "") + (addon.webUI.path || "/");
            uiSection.appendChild(uiChip);
            frag.appendChild(uiSection);
          }

          // Notes
          if (addon.notes) {
            var noteSection = document.createElement("div");
            noteSection.className = "ext-detail__section";
            var noteTitle = document.createElement("div");
            noteTitle.className = "ext-detail__section-title";
            noteTitle.textContent = '${tJs("extensions.notes", lang)}';
            noteSection.appendChild(noteTitle);
            var noteBox = document.createElement("div");
            noteBox.className = "ext-detail__notes";
            noteBox.textContent = addon.notes;
            noteSection.appendChild(noteBox);
            frag.appendChild(noteSection);
          }

          // Actions
          var actions = document.createElement("div");
          actions.className = "ext-detail__actions";

          var closeAction = document.createElement("button");
          closeAction.className = "btn btn-secondary";
          closeAction.textContent = '${tJs("extensions.close", lang)}';
          closeAction.addEventListener("click", hideModal);
          actions.appendChild(closeAction);

          if (!addon._installed) {
            var installAction = document.createElement("button");
            installAction.className = "btn btn-primary";
            installAction.textContent = '${tJs("extensions.install", lang)}';
            installAction.addEventListener("click", function() {
              hideModal();
              showInstallModal(addon.id, addon.name, addon.env_vars || [],
                (addon.requires || {}).min_ram_mb || 0,
                (addon.requires || {}).min_disk_mb || 0,
                !addon.official);
            });
            actions.appendChild(installAction);
          } else {
            var installedBadge = document.createElement("span");
            installedBadge.className = "badge badge--published";
            installedBadge.style.cssText = "display:flex;align-items:center;padding:0.3rem 0.8rem;font-size:0.85rem";
            installedBadge.textContent = '${tJs("extensions.installedBadge", lang)}';
            actions.appendChild(installedBadge);
          }

          frag.appendChild(actions);
          setModalContent(frag);
          showModal();
        }

        // --- Card click → detail modal ---
        document.querySelectorAll(".addon-card").forEach(function(card) {
          card.style.cursor = "pointer";
          card.addEventListener("click", function(e) {
            if (e.target.closest(".bundle-install") || e.target.closest(".btn")) return;
            var id = card.dataset.addonId;
            var addon = ADDON_DATA[id];
            if (addon) showDetailModal(addon);
          });
        });

        document.querySelectorAll(".ext-installed__item").forEach(function(item) {
          item.style.cursor = "pointer";
          item.addEventListener("click", function(e) {
            if (e.target.closest(".bundle-action") || e.target.closest(".bundle-uninstall") || e.target.closest(".btn")) return;
            var id = item.dataset.addonId;
            var addon = ADDON_DATA[id];
            if (addon) showDetailModal(addon);
          });
        });

        // --- Escape key ---
        document.addEventListener("keydown", function(e) {
          if (e.key === "Escape" && document.getElementById("modal-overlay").style.display === "flex") {
            hideModal();
          }
        });
      })();
    <\/script>`;

    const content = `
      ${extensionStyles()}
      ${searchHtml}
      ${installedHtml}
      ${sourceNote}
      ${tabsHtml}
      ${gridHtml}
      ${storesHtml}
      ${helpHtml}
      ${addonRegistryScript}
      ${interactiveScript}
    `;

    return layout({ title: t("extensions.pageTitle", lang), content });
  },
};
