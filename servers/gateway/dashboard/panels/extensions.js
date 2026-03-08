/**
 * Extensions Panel — Browse, install, and manage add-ons
 */

import { escapeHtml, statCard, statGrid, section, badge, formatDate } from "../shared/components.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const REGISTRY_URL = "https://raw.githubusercontent.com/kh0pper/crow-addons/main/registry/add-ons.json";
const CROW_DIR = join(homedir(), ".crow");
const INSTALLED_PATH = join(CROW_DIR, "installed.json");

function getInstalled() {
  try {
    if (existsSync(INSTALLED_PATH)) {
      return JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
    }
  } catch {}
  return {};
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

    // Try to fetch registry (with timeout)
    let registry = { "add-ons": [] };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        registry = await resp.json();
      }
    } catch {
      // Registry unavailable — show installed only
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
        return `<div class="card" style="animation-delay:${i * 50}ms;margin-bottom:0.75rem">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <div>
              <h4 style="font-family:'Fraunces',serif;font-size:1rem;margin-bottom:0.25rem">${escapeHtml(id)}</h4>
              <div style="font-size:0.8rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace">
                ${badge(info.type || "unknown", "connected")} v${escapeHtml(info.version || "?")} · ${formatDate(info.installed_at)}
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
        const tags = (addon.tags || []).map((t) =>
          `<span style="font-size:0.7rem;color:var(--crow-accent);background:var(--crow-accent-muted);padding:0.1rem 0.4rem;border-radius:4px;margin-right:0.25rem">${escapeHtml(t)}</span>`
        ).join("");

        return `<div class="card" style="animation-delay:${(i + installedCount) * 50}ms">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem">
            <h4 style="font-family:'Fraunces',serif;font-size:1rem">${escapeHtml(addon.name)}</h4>
            <div>${statusBadge} ${typeBadge}</div>
          </div>
          <p style="color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:0.5rem">${escapeHtml(addon.description)}</p>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>${tags}</div>
            <div style="font-size:0.75rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace">
              v${escapeHtml(addon.version || "1.0.0")} · ${escapeHtml(addon.author || "community")}
            </div>
          </div>
        </div>`;
      }).join("");
      availableHtml = `<div class="card-grid">${cards}</div>`;
    }

    const content = `
      ${stats}
      ${section("Installed", installedHtml, { delay: 100 })}
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
