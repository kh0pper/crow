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
import { wallsOnForHost } from "../../../../scripts/addon-sandbox/host-switch.mjs";
import { wallModeOverride } from "../../../shared/addon-walls-file.js";
import { addonWallWord } from "./addon-wall-status.js";

/**
 * Whether the wall can govern this entry at all: a local child (`mcp-addons.json`
 * entry with a command) it can wrap, or a built-in that already went through a
 * decision. An HTTP add-on has no local child, so no wall and no wall controls.
 */
function wallable(entry, wall, mcpAddons) {
  if (entry.kind === "builtin") return wall !== null;
  const config = mcpAddons[entry.id];
  return !!config && typeof config === "object" && typeof config.command === "string" && config.command !== "";
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** What the decision needs, read once per render: walls on, the home, the add-ons file. */
function decisionContext({ crowHome, env } = {}) {
  return {
    wallsOn: wallsOnForHost(env),
    crowHome: crowHome || null,
    mcpAddons: (crowHome && readJson(join(crowHome, "mcp-addons.json"))) || {},
  };
}

/**
 * The rule behind "Wall it again": this add-on is unwalled because the OWNER
 * (or the Fix-it remedy, or the file they hand-edited) said so, on a host where
 * walls are on at all.
 *
 * Two records can say so. The entry's own `wall` is the decision THIS run got
 * (source "owner" for any `addon-walls.json` mode — the Fix-it remedy and a
 * hand edit alike). But that snapshot is only as fresh as the last connect: a
 * mode written while walls were off here, or before a walls rollout, leaves it
 * reading "default" (or absent) even though the file — the decision every new
 * connect obeys — says unwalled. The file is therefore read as well, and only
 * for an add-on the wall can actually govern.
 *
 * With walls off for this computer (the operator's kill switch, or a per-host
 * default of off) there is nothing to re-arm for any add-on, so every add-on
 * answers false — the honest answer for that host.
 */
function ownerUnwalled(entry, ctx) {
  if (!ctx || !ctx.wallsOn) return false;
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string") return false;
  const wall = entry.wall && typeof entry.wall === "object" ? entry.wall : null;
  if (wall?.mode === "walled") return false;
  if (wall?.source === "owner") return true;
  const canWall = wallable(entry, wall, ctx.mcpAddons || {});
  return canWall && wallModeOverride(ctx.crowHome, entry.id) === "unwalled";
}

/**
 * The ids of the add-ons a decision of the owner's left unwalled — the ones a
 * surface may link to "Wall it again". Same rule as `addonWallDetails` below,
 * but no profile is derived and no manifest read, so a health surface can ask
 * it cheaply and still never point at a button that is not there.
 */
export function addonWallOwnerUnwalledIds({ crowHome, entries = [], env = process.env } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const ctx = decisionContext({ crowHome, env });
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
    // A data backend is not walled by this rule, and an entry of no known kind
    // has no wall story.
    if (entry.kind !== "addon" && entry.kind !== "builtin") continue;
    if (ownerUnwalled(entry, ctx)) out.push(entry.id);
  }
  return out;
}

/** `{ [id]: { line, word, wordKey, ownerUnwalled } }` for every connected add-on. */
export function addonWallDetails({ crowHome, appRoot, entries = [], env = process.env } = {}) {
  if (!crowHome || !appRoot) return {};
  const list = Array.isArray(entries) ? entries : [];
  const pastDefaultsDoc = appRoot ? readJson(join(appRoot, "registry", "addon-past-defaults.json")) : null;
  const pastDefaultsAll = pastDefaultsDoc && typeof pastDefaultsDoc.defaults === "object" && pastDefaultsDoc.defaults
    ? pastDefaultsDoc.defaults
    : {};
  // Walls on for this computer, the home and the add-ons file, decided in one
  // place so this page and the Nest's rows can never disagree.
  const ctx = decisionContext({ crowHome, env });
  const { mcpAddons } = ctx;
  const out = {};

  for (const entry of list) {
    // A data backend is not walled by this rule, and an entry of no known kind has
    // no wall story: only a bundle add-on or a built-in is described here.
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
    if (entry.kind !== "addon" && entry.kind !== "builtin") continue;
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
    // The owner said "run it without the wall" for this add-on: offer it back
    // (see `ownerUnwalled` above for the rule).
    out[entry.id] = {
      line,
      word: wordKey ? { en: wallWord(wordKey, "en"), es: wallWord(wordKey, "es") } : null,
      wordKey: wordKey || null,
      ownerUnwalled: ownerUnwalled(entry, ctx),
    };
  }

  return out;
}