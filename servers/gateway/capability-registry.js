/**
 * Local capability registry (F4a Layer 1). Single source of truth for "what
 * capabilities + bots exist on THIS instance," vocab-normalized, built by live
 * aggregation (a freshly-installed addon appears with no restart). Plus the
 * strict public-safe projectors -- the ONLY path from local data to the mesh
 * wire. Never emit a raw bot definition, addon block, env, or secret.
 */
import { TOOL_MANIFESTS } from "./tool-manifests.js";
import { listInstalledExtensions, voiceCategoryFor, resolveCrowHome } from "../../scripts/pi-bots/ext_registry.mjs";
import { skillDirs } from "../../scripts/pi-bots/skill_resolver.mjs";
import { normalizeSkillName } from "../../scripts/pi-bots/skill_proposals.mjs";
import { readdirSync } from "node:fs";
import { offSkills } from "../shared/skill-state.js";
import { getExposedCapabilities } from "./peer-exposure.js";
import { getExposureForPeer } from "./peer-exposure-store.js";
import { canonicalForCategory } from "./capability-ids.js";
import { getPeerManagedBots } from "./bot-management-exposure.js";
import { CROW_VOICE_BOT_ID } from "../shared/voice-bot.js";

// Canonical id shape lives in capability-ids.js (a leaf, so the peer-exposure
// gate can use it without a cycle); re-exported here because callers expect it
// from the catalog module.
export { canonicalForCategory };

// ---- public-safe projectors (security boundary) ----

export function toPublicTool(entry, exposedSet) {
  const canonicalId = entry.canonicalId;
  return {
    canonicalId,
    category: entry.category,
    name: entry.name,
    bundleId: entry.bundleId ?? null,
    toolCount: entry.toolCount ?? null,
    exposed: exposedSet instanceof Set ? exposedSet.has(canonicalId) : false,
  };
}

export function toPublicSkill(s) {
  return { name: typeof s === "string" ? s : s.name };
}

export function toPublicBot(row, managedSet) {
  let def = {};
  try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
  const crowMcp = (def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp : [];
  return {
    bot_id: row.bot_id,
    display_name: row.display_name,
    enabled: !!Number(row.enabled),
    project_id: row.project_id != null && Number.isFinite(Number(row.project_id)) ? Number(row.project_id) : null,
    // The tracker type lives in tracker_config (what the editor writes);
    // triggers.tracker_type is a legacy spelling nothing writes any more.
    tracker_type: (def.tracker_config && def.tracker_config.type) || (def.triggers && def.triggers.tracker_type) || "none",
    model: (def.models && def.models.default) || null,
    tool_count: crowMcp.length,
    peer_manageable: managedSet instanceof Set ? managedSet.has(row.bot_id) : false,
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
    try { for (const f of readdirSync(dir)) if (f.endsWith(".md") && normalizeSkillName(f) === f.slice(0, -3)) names.add(f.slice(0, -3)); }
    catch { /* dir missing */ }
  }
  // A skill switched off on this Crow won't load, so peers are not told about it.
  const off = offSkills(crowHome || resolveCrowHome());
  return [...names].filter((n) => !off.has(n)).sort().map((name) => ({ name }));
}

async function localBots(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT bot_id, display_name, enabled, project_id, definition FROM pi_bot_defs WHERE bot_id != ? ORDER BY bot_id",
      args: [CROW_VOICE_BOT_ID],
    });
    return rows || [];
  } catch { return []; }
}

/**
 * The local, vocab-normalized catalog with everything projected public-safe.
 *
 * N1b-8 review round 1 (S2): when the catalog is served to a VERIFIED peer,
 * pass `peerId` — a capability is then marked `exposed` if it is in the
 * all-trusted-peers allowlist OR that peer holds an active one-device grant.
 * Only THAT peer's grants are merged: another peer's allowance is never
 * visible here (the per-peer store is read for one id, never in bulk).
 *
 * @param {object} db
 * @param {{crowHome?: string, instanceId?: string|null, instanceName?: string|null, peerId?: string|null}} [opts]
 */
export async function getLocalCatalog(db, { crowHome = resolveCrowHome(), instanceId = null, instanceName = null, peerId = null } = {}) {
  const exposedSet = peerId
    ? await getExposureForPeer(db, peerId)
    : await getExposedCapabilities(db);
  const managedSet = await getPeerManagedBots(db);
  const tools = [...coreTools(), ...addonTools(crowHome)].map((e) => toPublicTool(e, exposedSet));
  const skills = localSkills(crowHome).map(toPublicSkill);
  const bots = (await localBots(db)).map((r) => toPublicBot(r, managedSet));
  return { instanceId, instanceName, tools, skills, bots };
}
