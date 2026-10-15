/**
 * Artifacts smoke fixes S2a (review M7): write artifact_find and
 * artifact_attach into stored bot defs that grant artifact_update, so the
 * needs_link recovery path is actually offered. Two writers only:
 *   1. a one-time boot migration over the local pi_bot_defs (marker
 *      `artifacts_companions_v1` in dashboard_settings), and
 *   2. the Bot Builder Abilities save.
 * Peer (federation) patches are NEVER augmented: a peer granting Update
 * grants exactly that, and the migration runs once, so later patches stay as
 * sent. The runtime toolAllowlist is unchanged (explicit entries only).
 *
 * Cap guard: before adding, the def is counted the way the spawn preflight
 * counts it (bridge.mjs buildToolsCsv, the interactive Perch surface — the
 * widest) against the model's cap (tool-budget.mjs capFor). Over the cap the
 * companions are NOT added and the caller says why. An unresolvable model or
 * an unknown cap adds them: they are explicit, so a later budget refusal
 * names them like any ticked tool.
 */
import { withArtifactsCompanions } from "./bot-world.mjs";

export const MIGRATION_KEY = "artifacts_companions_v1";

/** Does this crow_mcp list grant artifact_update per tool (either spelling)? */
export function grantsArtifactUpdate(list) {
  return Array.isArray(list) && (list.includes("artifacts/artifact_update") || list.includes("artifacts__artifact_update"));
}

/** {cap, countFor(def)} for this def's resolved default model. Fails open (cap null). */
export async function defaultCompanionBudget(def) {
  try {
    const [{ resolveModel }, { capFor, countCsvTools }, { buildToolsCsv }] = await Promise.all([
      import("./model_resolver.mjs"), import("./tool-budget.mjs"), import("./bridge.mjs"),
    ]);
    const resolved = await resolveModel(def);
    const cap = capFor(resolved);
    return { cap, countFor: (d) => countCsvTools(buildToolsCsv(d, { resolved, interactive: true }).csv) || 0 };
  } catch {
    return { cap: null, countFor: () => 0 };
  }
}

/**
 * @returns {Promise<{def: object, added: string[], refused: boolean}>} a NEW def
 *   (the input is never mutated); `refused` = the companions would pass the cap.
 */
export async function addCompanionsGuarded(def, { budget = null } = {}) {
  const list = (def && def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp : [];
  const next = withArtifactsCompanions(list);
  const added = next.filter((x) => !list.includes(x));
  if (!added.length) return { def, added: [], refused: false };
  const candidate = { ...def, tools: { ...(def.tools || {}), crow_mcp: next } };
  const b = budget || (await defaultCompanionBudget(def));
  if (Number.isInteger(b.cap) && b.cap > 0 && b.countFor(candidate) > b.cap) return { def, added: [], refused: true };
  return { def: candidate, added, refused: false };
}

/**
 * The one-time boot migration. Never throws; a DB that cannot be read leaves
 * the marker unset (retried next boot). A bot whose model cannot take two
 * more tools is NOT retried (review 4): the owner gets ONE notification
 * naming it (the migration runs once), and Bot Builder's save adds them when
 * they re-tick Update after making room.
 */
export async function migrateArtifactsCompanions(db, { log = (m) => console.log(m), budgetFor = defaultCompanionBudget, notify = null } = {}) {
  const out = { skipped: false, updated: [], refused: [] };
  try {
    const done = (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key=?", args: [MIGRATION_KEY] })).rows[0];
    if (done) return { ...out, skipped: true };
    const rows = (await db.execute({ sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs", args: [] })).rows;
    for (const r of rows) {
      let def;
      try { def = JSON.parse(r.definition || "{}"); } catch { continue; }
      if (!def || typeof def !== "object") continue;
      const res = await addCompanionsGuarded(def, { budget: await budgetFor(def) });
      if (res.refused) {
        out.refused.push(String(r.bot_id));
        log(`[artifacts] ${r.bot_id}: Find and Attach were not added — this model's tool limit is reached`);
        if (typeof notify === "function") {
          const name = String(r.display_name || r.bot_id);
          try {
            await notify({
              title: `${name} cannot ask to link artifacts`,
              body: `Find and Attach were not added to ${name}: its model's tool limit is reached. Without them it cannot ask to link an artifact to a chat, so it cannot change artifacts from chats that are not linked. In Bot Builder, remove a tool, then untick and re-tick Update in Artifacts and save.`,
              type: "system", source: "artifacts",
            });
          } catch { /* a lost notice never fails the migration */ }
        }
      } else if (res.added.length) {
        await db.execute({ sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?", args: [JSON.stringify(res.def), r.bot_id] });
        out.updated.push(String(r.bot_id));
        log(`[artifacts] ${r.bot_id}: added ${res.added.join(", ")} (the needs_link recovery tools)`);
      }
    }
    await db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))", args: [MIGRATION_KEY, new Date().toISOString()] });
  } catch (e) {
    log(`[artifacts] companion migration skipped: ${e.message}`);
  }
  return out;
}
