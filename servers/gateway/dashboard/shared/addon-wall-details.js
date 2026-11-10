/**
 * The one add-on's wall lines, for the Extensions page's detail modal.
 *
 * The modal shows what the add-on can reach from its LIVE profile — the profile
 * the wall decided with when the entry carries one, else one derived now from
 * the add-on's own mcp-addons.json entry and today's manifest. Nothing here
 * spawns an add-on or probes bubblewrap: it reads the entry snapshot proxy.js
 * publishes (`addonWallEntries()`), the two files and the registry.
 *
 * Any profile that cannot be built gives `line: null` — the modal says nothing
 * rather than something untrue.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileFor } from "../../../../scripts/addon-sandbox/profile.mjs";
import { sandboxLine, wallWord } from "../../../../scripts/addon-sandbox/words.mjs";
import { addonWallWord } from "./addon-wall-status.js";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** `{ [id]: { line, word, wordKey, ownerUnwalled } }` for every connected add-on. */
export function addonWallDetails({ crowHome, appRoot, entries = [], env = process.env } = {}) {
  if (!crowHome || !appRoot) return {};
  const list = Array.isArray(entries) ? entries : [];
  const pastDefaultsDoc = appRoot ? readJson(join(appRoot, "registry", "addon-past-defaults.json")) : null;
  const pastDefaultsAll = pastDefaultsDoc && typeof pastDefaultsDoc.defaults === "object" && pastDefaultsDoc.defaults
    ? pastDefaultsDoc.defaults
    : {};
  const mcpAddons = (crowHome && readJson(join(crowHome, "mcp-addons.json"))) || {};
  const out = {};

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || entry.kind !== "addon" || typeof entry.id !== "string") continue;
    const wall = entry.wall && typeof entry.wall === "object" ? entry.wall : null;
    // `walled` decides the line's opening, so an add-on the host switched off
    // never reads as if a limit were in force.
    const walled = wall?.mode === "walled";

    let profile = wall?.profile && typeof wall.profile === "object" ? wall.profile : null;
    if (!profile) {
      try {
        profile = profileFor({
          id: entry.id,
          entry: mcpAddons[entry.id] && typeof mcpAddons[entry.id] === "object" ? mcpAddons[entry.id] : {},
          appBundlesDir: join(appRoot, "bundles"),
          installedBundlesDir: join(crowHome, "bundles"),
          pastDefaultsAll,
        });
      } catch {
        profile = null;
      }
    }

    let line = null;
    if (profile) {
      try {
        const opts = {
          walled,
          residuals: Array.isArray(wall?.residuals) ? wall.residuals : [],
        };
        line = { en: sandboxLine(profile, "en", opts), es: sandboxLine(profile, "es", opts) };
      } catch {
        line = null;
      }
    }

    const wordKey = addonWallWord(entry, { env });
    out[entry.id] = {
      line,
      word: wordKey ? { en: wallWord(wordKey, "en"), es: wallWord(wordKey, "es") } : null,
      wordKey: wordKey || null,
      // The owner said "run it without the wall" for this add-on: offer it back.
      ownerUnwalled: !walled && wall?.source === "owner",
    };
  }

  return out;
}