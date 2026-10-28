/**
 * Model roles seed: on boot, each core role with a known default gets a
 * `model_role.<id>` row marked `seeded: true` that follows that default
 * (today's env/route constants and pi's own config) until the user edits the
 * role. A user-written row (no `seeded`) is never touched.
 *
 * Writes go straight to dashboard_settings (instance scope, never emitted).
 */
import os from "node:os";
import { join } from "node:path";
import { CORE_ROLES, bindingKey, parseBindingValue } from "./model-roles.js";
import { splitKey } from "../../scripts/pi-bots/model_resolver.mjs";
import { roleBindingAuthority, invalidateRoleContext } from "./model-roles-store.js";
import { str, readJsonFile, effectiveAgentModel } from "./pi-agent-config.js";
import { VOICE_ROUTE_DEFAULTS } from "./voice-route-defaults.js";
import { isDefaultCrowHome } from "./crow-home.js";

const CORE_IDS = new Set(CORE_ROLES.map((r) => r.id));
const ALWAYS_NULL = ["vision", "embed", "rerank", "safety", "stt", "tts", "image", "video"];

/** pi's top-level session model: defaultModel as is when it carries a provider, else defaultProvider/defaultModel. */
function piDefaultModel(settings) {
  const model = str(settings?.defaultModel);
  if (!model) return null;
  if (model.includes("/")) return model;
  const provider = str(settings?.defaultProvider);
  return provider ? `${provider}/${model}` : null;
}

/**
 * Where each core role's seed comes from (I1). pi sources are read only on
 * the host-default home: a co-hosted instance never seeds from the host's pi.
 * @returns {{[roleId:string]: string|null}}
 */
export function defaultSeedSources({ env = process.env, homeDir = os.homedir() } = {}) {
  const out = {
    voice: str(env.COMPANION_FAST_MODEL) || VOICE_ROUTE_DEFAULTS.fast,
    everyday: str(env.COMPANION_ESCALATION_MODEL) || VOICE_ROUTE_DEFAULTS.escalate,
    quick: null, deep: null, coordinator: null, critic: null, expert: null,
  };
  for (const id of ALWAYS_NULL) out[id] = null;
  if (!isDefaultCrowHome(env, homeDir)) return out;

  const piAgentDir = str(env.PI_CODING_AGENT_DIR) || join(homeDir, ".pi", "agent");
  const settings = readJsonFile(join(piAgentDir, "settings.json"));
  out.quick = effectiveAgentModel(piAgentDir, "scout");
  out.deep = effectiveAgentModel(piAgentDir, "planner");
  out.coordinator = piDefaultModel(settings);
  out.critic = str(settings?.critic?.refuteModel);
  out.expert = effectiveAgentModel(piAgentDir, "adversary");
  return out;
}

const isRawKey = (k) => { const { provider, model } = splitKey(k); return !!(provider && model); };

/**
 * Insert or reseed every core role with a non-null source (in `sources` key
 * order) whose authority is self. An existing row is changed only while it is still `seeded: true`, by
 * a compare-and-set on its exact old value; a lost CAS (the user wrote in
 * between) is silent. `beforeUpdate(roleId)` is a test seam between the read
 * and the CAS.
 * @returns {Promise<{inserted:string[], reseeded:string[]}>}
 */
export async function seedRoleBindings(db, { sources = defaultSeedSources(), log = console.log, beforeUpdate, authority = roleBindingAuthority } = {}) {
  const inserted = [], reseeded = [];
  for (const id of Object.keys(sources || {})) {
    if (!CORE_IDS.has(id)) continue;
    const src = sources[id];
    if (src == null) continue;
    if (!isRawKey(src)) { log(`[roles] seed source for ${id} is not a provider/model key; skipped`); continue; }
    const key = bindingKey(id);
    if ((await authority(db, key))?.kind !== "self") continue;
    const value = JSON.stringify({ model: src, seeded: true, at: new Date().toISOString() });

    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
    if (!rows.length) {
      const r = await db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO NOTHING",
        args: [key, value],
      });
      if (Number(r.rowsAffected) === 1) inserted.push(id);
      continue;
    }
    const oldRaw = rows[0].value;
    const old = parseBindingValue(oldRaw);
    if (!old || old.seeded !== true || old.model === src) continue;
    if (beforeUpdate) await beforeUpdate(id);
    const r = await db.execute({
      sql: "UPDATE dashboard_settings SET value = ?, updated_at = datetime('now') WHERE key = ? AND value = ?",
      args: [value, key, oldRaw],
    });
    if (Number(r.rowsAffected) === 1) {
      reseeded.push(id);
      log(`[roles] reseeded ${id}: ${old.model} → ${src}`);
    }
  }
  if (inserted.length || reseeded.length) invalidateRoleContext();
  return { inserted, reseeded };
}
