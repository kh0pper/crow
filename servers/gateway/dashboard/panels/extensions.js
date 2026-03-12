/**
 * Extensions Panel — Browse, install, and manage add-ons
 */

import { escapeHtml, statCard, statGrid, section, badge, formatDate } from "../shared/components.js";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const REGISTRY_URL = "https://raw.githubusercontent.com/kh0pper/crow-addons/main/registry/add-ons.json";
const CROW_DIR = join(homedir(), ".crow");
const INSTALLED_PATH = join(CROW_DIR, "installed.json");

// Local fallback registry path
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_REGISTRY = join(__dirname, "../../../../registry/add-ons.json");

const ICON_MAP = {
  brain: "\u{1F9E0}",
  cloud: "\u2601\uFE0F",
  image: "\u{1F5BC}\uFE0F",
  book: "\u{1F4D6}",
  home: "\u{1F3E0}",
};

function getInstalled() {
  try {
    if (existsSync(INSTALLED_PATH)) {
      const data = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
      // Handle both array format (from CLI) and object format
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
    ? `<span style="font-size:0.75rem;color:var(--crow-text-muted)">${parts.join(" · ")}</span>`
    : "";
}

export default {
  id: "extensions",
  name: "Extensions",
  icon: "extensions",
  route: "/dashboard/extensions",
  navOrder: 80,

  async handler(req, res, { db, layout }) {
    const installed = getInstalled();
    const installedCount = Object.keys(installed).length;

    // Try remote registry, fall back to local
    let registry = { "add-ons": [] };
    let registrySource = "none";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        registry = await resp.json();
        registrySource = "remote";
      }
    } catch {
      // Remote unavailable — try local fallback
    }

    if (registrySource === "none") {
      try {
        if (existsSync(LOCAL_REGISTRY)) {
          registry = JSON.parse(readFileSync(LOCAL_REGISTRY, "utf8"));
          registrySource = "local";
        }
      } catch {}
    }

    const available = registry["add-ons"] || [];

    const stats = statGrid([
      statCard("Installed", installedCount, { delay: 0 }),
      statCard("Available", available.length, { delay: 50 }),
    ]);

    // Installed add-ons
    let installedHtml;
    if (installedCount === 0) {
      installedHtml = `<div class="empty-state"><h3>No add-ons installed</h3><p>Browse available add-ons below, or ask your AI: "What add-ons are available?"</p></div>`;
    } else {
      const cards = Object.entries(installed).map(([id, info], i) => {
        // Find matching registry entry for richer display
        const registryEntry = available.find((a) => a.id === id);
        const name = registryEntry?.name || id;
        const icon = ICON_MAP[registryEntry?.icon] || "";

        return `<div class="card" style="animation-delay:${i * 50}ms;margin-bottom:0.75rem">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <div>
              <h4 style="font-family:'Fraunces',serif;font-size:1rem;margin-bottom:0.25rem">${icon ? icon + " " : ""}${escapeHtml(name)}</h4>
              <div style="font-size:0.8rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace">
                ${badge(info.type || registryEntry?.type || "unknown", "connected")} v${escapeHtml(info.version || registryEntry?.version || "?")} · installed ${formatDate(info.installed_at || info.installedAt)}
              </div>
            </div>
          </div>
        </div>`;
      }).join("");
      installedHtml = cards;
    }

    // Available add-ons (card grid)
    let availableHtml;
    if (available.length === 0) {
      availableHtml = `<div class="empty-state"><h3>Registry unavailable</h3><p>Could not reach the add-on registry. Check your internet connection.</p></div>`;
    } else {
      const cards = available.map((addon, i) => {
        const isInstalled = installed[addon.id];
        const statusBadge = isInstalled ? badge("Installed", "published") : "";
        const typeBadge = badge(addon.type, "connected");
        const icon = ICON_MAP[addon.icon] || "";
        const tags = (addon.tags || []).slice(0, 4).map((t) =>
          `<span style="font-size:0.7rem;color:var(--crow-accent);background:var(--crow-accent-muted);padding:0.1rem 0.4rem;border-radius:4px;margin-right:0.25rem">${escapeHtml(t)}</span>`
        ).join("");
        const resources = formatResources(addon.requires);
        const envCount = (addon.env_vars || addon.requires?.env || []).length;
        const envNote = envCount > 0
          ? `<span style="font-size:0.75rem;color:var(--crow-text-muted)">${envCount} env var${envCount > 1 ? "s" : ""}</span>`
          : "";
        const notes = addon.notes
          ? `<div style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.4rem;font-style:italic">${escapeHtml(addon.notes)}</div>`
          : "";

        return `<div class="card" style="animation-delay:${(i + installedCount) * 50}ms">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem">
            <h4 style="font-family:'Fraunces',serif;font-size:1rem">${icon ? icon + " " : ""}${escapeHtml(addon.name)}</h4>
            <div style="display:flex;gap:0.25rem">${statusBadge} ${typeBadge}</div>
          </div>
          <p style="color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:0.5rem">${escapeHtml(addon.description)}</p>
          <div style="display:flex;flex-wrap:wrap;gap:0.25rem;margin-bottom:0.4rem">${tags}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem">
            <div style="display:flex;gap:0.75rem;align-items:center">
              ${resources}
              ${envNote}
            </div>
            <div style="font-size:0.75rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace">
              v${escapeHtml(addon.version || "1.0.0")} · ${escapeHtml(addon.author || "community")}
            </div>
          </div>
          ${notes}
        </div>`;
      }).join("");
      availableHtml = `<div class="card-grid">${cards}</div>`;
    }

    const sourceNote = registrySource === "local"
      ? `<div style="font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:0.5rem">Showing local registry (remote unavailable)</div>`
      : "";

    const content = `
      ${stats}
      ${section("Installed", installedHtml, { delay: 100 })}
      ${sourceNote}
      ${section("Available Add-ons", availableHtml, { delay: 150 })}
      <div class="card" style="animation-delay:250ms">
        <p style="color:var(--crow-text-muted);font-size:0.85rem">
          To install an add-on, ask your AI: <code>"install the [name] add-on"</code><br>
          To create your own, see the <a href="/crow/developers/creating-addons">developer guide</a>.
        </p>
      </div>
    `;

    return layout({ title: "Extensions", content });
  },
};
