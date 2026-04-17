/**
 * Resolve a preset by name, overlaying any per-agent provider/model
 * overrides stored in `orchestrator_role_overrides`.
 *
 * Orphan handling: if an override points at a provider row that is disabled
 * or missing, the overlay for that agent is silently dropped and the preset
 * default takes over. We intentionally do NOT garbage-collect override rows
 * when their referenced provider disappears — the override survives bundle
 * reinstalls by design, so "the coder override I set yesterday" persists
 * across a `crow bundle reinstall`.
 *
 * Returns a deep-cloned copy so callers can mutate freely without
 * corrupting the module-level `presets` object.
 */

import { presets } from "./presets.js";

/**
 * @param {object} db  libsql client
 * @param {string} name  preset name (e.g. "research", "code_team")
 * @returns {Promise<object|null>} resolved preset, or null if the name is unknown
 */
export async function resolvePreset(db, name) {
  const base = presets[name];
  if (!base) return null;
  const resolved = structuredClone(base);

  let overrideRows = [];
  try {
    const res = await db.execute({
      sql: `SELECT o.agent_name, o.provider_id, o.model_id
            FROM orchestrator_role_overrides o
            LEFT JOIN providers p ON p.id = o.provider_id
            WHERE o.preset_name = ?
              AND o.provider_id IS NOT NULL
              AND (p.disabled IS NULL OR p.disabled = 0)`,
      args: [name],
    });
    overrideRows = res.rows || [];
  } catch {
    // orchestrator_role_overrides missing (pre-migration) → no overrides
    return resolved;
  }

  if (overrideRows.length === 0) return resolved;

  const byAgent = new Map(overrideRows.map((r) => [r.agent_name, r]));
  for (const agent of resolved.agents || []) {
    const ov = byAgent.get(agent.name);
    if (!ov) continue;
    agent.provider = ov.provider_id;
    if (ov.model_id) agent.model = ov.model_id;
  }
  return resolved;
}
