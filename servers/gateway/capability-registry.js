/**
 * Local capability registry (F4a Layer 1). Single source of truth for "what
 * capabilities + bots exist on THIS instance," vocab-normalized, built by live
 * aggregation (a freshly-installed addon appears with no restart). Plus the
 * strict public-safe projectors -- the ONLY path from local data to the mesh
 * wire. Never emit a raw bot definition, addon block, env, or secret.
 */
import { TOOL_MANIFESTS } from "./tool-manifests.js";
import { listInstalledExtensions, extensionSkills, voiceCategoryFor, resolveCrowHome } from "../../scripts/pi-bots/ext_registry.mjs";
import { skillDirs } from "../../scripts/pi-bots/skill_resolver.mjs";
import { readdirSync } from "node:fs";

/** Canonical server id for a core manifest category (crow-memory, etc.). */
export function canonicalForCategory(category) {
  return `crow-${category}`;
}

// ---- public-safe projectors (security boundary) ----

export function toPublicTool(entry) {
  return {
    canonicalId: entry.canonicalId,
    category: entry.category,
    name: entry.name,
    bundleId: entry.bundleId ?? null,
    toolCount: entry.toolCount ?? null,
  };
}

export function toPublicSkill(s) {
  return { name: typeof s === "string" ? s : s.name };
}

export function toPublicBot(row) {
  let def = {};
  try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
  const crowMcp = (def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp : [];
  return {
    bot_id: row.bot_id,
    display_name: row.display_name,
    enabled: row.enabled === 1 || row.enabled === true,
    project_id: row.project_id ?? null,
    tracker_type: (def.triggers && def.triggers.tracker_type) || "none",
    model: (def.models && def.models.default) || null,
    tool_count: crowMcp.length,
  };
}

// ---- local catalog (live aggregation) ----

function coreTools() {
  const out = [];
  for (const [category, manifest] of Object.entries(TOOL_MANIFESTS)) {
    const names = Object.keys(manifest.tools || {});
    out.push({
      canonicalId: canonicalForCategory(category),
      category,
      name: manifest.displayName || category,
      bundleId: null,
      toolCount: names.length,
    });
  }
  return out;
}

function addonTools(crowHome) {
  const out = [];
  try {
    for (const ext of listInstalledExtensions(crowHome)) {
      const category = voiceCategoryFor(ext.id) || "extension";
      const toolCount = ext.capabilities && Array.isArray(ext.capabilities.tools)
        ? ext.capabilities.tools.length : null;
      out.push({ canonicalId: ext.id, category, name: ext.name || ext.id, bundleId: ext.id, toolCount });
    }
  } catch { /* addon listing unavailable on this instance */ }
  return out;
}

function localSkills(crowHome) {
  const names = new Set();
  for (const dir of skillDirs(crowHome)) {
    try { for (const f of readdirSync(dir)) if (f.endsWith(".md")) names.add(f.replace(/\.md$/, "")); }
    catch { /* dir missing */ }
  }
  return [...names].sort().map((name) => ({ name }));
}

async function localBots(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT bot_id, display_name, enabled, project_id, definition FROM pi_bot_defs ORDER BY bot_id",
      args: [],
    });
    return rows || [];
  } catch { return []; }
}

/**
 * The local, vocab-normalized catalog with everything projected public-safe.
 */
export async function getLocalCatalog(db, { crowHome = resolveCrowHome(), instanceId = null, instanceName = null } = {}) {
  const tools = [...coreTools(), ...addonTools(crowHome)].map(toPublicTool);
  const skills = localSkills(crowHome).map(toPublicSkill);
  const bots = (await localBots(db)).map(toPublicBot);
  return { instanceId, instanceName, tools, skills, bots };
}
