/**
 * The Models page's rows (roles Phase 2, simple view): every role, what fills
 * it, where that runs and its status, in the page's groups and order.
 *
 * Statuses come from the resolver's reasons and the operator overrides, never
 * from liveness ("configured, not live"). No row carries a provider or
 * profile API key: speech profiles are read without keys, and a model is
 * shown by its key, display name and where-chip only.
 *
 * Env vars that fill a whole role (COMPANION_FAST_MODEL for Voice,
 * CROW_EMBED_PROVIDER, CROW_RERANK_PROVIDER) show "env"; the setting pins
 * (LEGACY_PINS) show "pinned". Env vars that override one consumer of a role
 * (COMPANION_ESCALATION_MODEL, CROW_SMART_ROUTER_<TIER>) do not change the
 * role's row: the change preview lists those consumers as not affected.
 */
import { CORE_ROLES, ROLE_LABEL_KEYS, ROLE_JOB_KEYS, resolveRoleKey, resolveChosenRoleKey, whereItRuns } from "../../../../../shared/model-roles.js";
import { loadRoleContext } from "../../../../../shared/model-roles-store.js";
import { LEGACY_PINS } from "../../../../../shared/role-change.js";
import { pickProviderByTask, EMBED_TASKS, RERANK_TASKS } from "../../../../../shared/provider-task.js";
import { speechProfileWhere } from "../../../../../shared/speech-where.js";
import { CROW_VOICE_BOT_ID, normalizeVoiceSettings } from "../../../../../shared/voice-bot.js";
import { resolveVoiceKeys } from "../../../../routes/llm-router.js";
import { getClassifierStatus } from "../../../panels/bot-builder/classifier-status.js";
import { getDefaultTtsProfile, getTtsProfiles } from "../../../../ai/tts/index.js";
import { getDefaultSttProfile, getSttProfiles } from "../../../../ai/stt/index.js";
import { friendlyModel } from "../../../shared/bot-display.js";
import { readSetting } from "../../registry.js";

/** Page groups, in order. `custom` is filled by the custom-roles work (Task 18). */
export const ROLE_GROUPS = Object.freeze([
  Object.freeze({ id: "thinking", roles: Object.freeze(["coordinator", "quick", "deep", "everyday", "expert", "critic"]) }),
  Object.freeze({ id: "speech", roles: Object.freeze(["voice", "stt", "tts"]) }),
  Object.freeze({ id: "seeing", roles: Object.freeze(["vision", "embed", "rerank"]) }),
  Object.freeze({ id: "safety", roles: Object.freeze(["safety"]) }),
  Object.freeze({ id: "making", roles: Object.freeze(["image", "video"]) }),
  Object.freeze({ id: "custom", roles: Object.freeze([]) }),
]);

/** Roles hidden unless something fills them on purpose (a binding, a pin or an env var). */
const HIDDEN_UNLESS_BOUND = new Set(["rerank"]);
/** Roles with a consumer default: unset shows that consumer's current pick as "Crow's default". */
const CONSUMER_DEFAULT = new Set(["safety", "embed", "rerank"]);
/** Env vars that fill the whole role (the value is a model key for voice, a provider id otherwise). */
const ROLE_ENV = Object.freeze({ voice: "COMPANION_FAST_MODEL", embed: LEGACY_PINS.embed.env, rerank: LEGACY_PINS.rerank.env });
const TASKS = Object.freeze({ embed: EMBED_TASKS, rerank: RERANK_TASKS });
const NEED = Object.freeze({ embed: "embed", rerank: "score", vision: "vision" });
const SPEECH = Object.freeze({
  stt: { getDefault: getDefaultSttProfile, list: getSttProfiles, field: "stt_profile_id" },
  tts: { getDefault: getDefaultTtsProfile, list: getTtsProfiles, field: "tts_profile_id" },
});
/** Statuses where something fills the role (the menu preview's "ready" count). */
export const FILLED_STATUSES = Object.freeze(["ready", "default", "fallback", "env", "pinned"]);

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const providerById = (providers, id) => (providers || []).find((p) => p && p.id === id) || null;

function modelsOf(p) {
  if (Array.isArray(p?.models)) return p.models;
  if (typeof p?.models === "string") { try { const m = JSON.parse(p.models); return Array.isArray(m) ? m : []; } catch { return []; } }
  return [];
}

/**
 * {key, label, where} for a raw `provider/model` key. `where` is any of
 * whereItRuns' answers, "missing" included (an env value naming no row).
 */
function modelOf(key, ctx, whereOpts) {
  if (!key) return null;
  let where = "missing";
  try { where = whereItRuns(key, { providers: ctx.providers, ...whereOpts }); } catch { where = "missing"; }
  return { key, label: friendlyModel(key, ctx.providers) || key, where };
}

/** A task provider (embed/rerank) as a model: its first model for the task, as the consumer serves it. */
function providerModel(providerId, roleId, ctx, whereOpts) {
  if (!providerId) return null;
  const want = new Set(TASKS[roleId] || []);
  const m = modelsOf(providerById(ctx.providers, providerId)).find((x) => x && typeof x === "object" && want.has(x.task));
  const key = `${providerId}/${m?.id || "-"}`;
  const out = modelOf(key, ctx, whereOpts);
  return m ? out : { ...out, label: providerId };
}

async function readPin(db, roleId) {
  const legacy = LEGACY_PINS[roleId];
  if (!legacy?.setting) return null;
  try {
    const v = str(await readSetting(db, legacy.setting));
    return v ? { source: "setting", name: legacy.setting, value: v } : null;
  } catch (e) {
    console.warn(`[models] pin ${legacy.setting} unreadable: ${e?.message}`);
    return null;
  }
}

/** The classifier's current pick (the setting, a chosen role, else the automatic pick), never probed. */
async function classifierModel(db, ctx, whereOpts, classifierStatusFn) {
  try {
    const st = await classifierStatusFn(db, { probe: false });
    if (st?.state !== "ready" || !st.providerId || !st.model) return null;
    return modelOf(`${st.providerId}/${st.model}`, ctx, whereOpts);
  } catch (e) {
    console.warn(`[models] classifier status failed: ${e?.message}`);
    return null;
  }
}

async function voiceBotDef(db) {
  try {
    const r = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [CROW_VOICE_BOT_ID] })).rows[0];
    return r?.definition ? JSON.parse(r.definition) : null;
  } catch { return null; }
}

/** A chat-style row (thinking, voice, seeing, safety). */
async function chatRow(db, def, ctx, { env, whereOpts, voiceKeys, classifierStatusFn }) {
  const id = def.id;
  const b = ctx.bindings?.[id] || null;
  const seeded = !!(b && b.model != null && b.seeded === true);
  const chosen = !!(b && b.model != null && !b.seeded);
  const row = { id, kind: "chat", hidden: false, model: null, status: { code: "not_set" }, chosen, seeded };

  const envName = ROLE_ENV[id] || null;
  const envValue = envName ? str(env?.[envName]) : null;
  const pin = envValue ? null : await readPin(db, id);

  if (envValue) {
    row.pin = { source: "env", name: envName, value: envValue };
    row.status = { code: "env" };
    row.model = id === "voice" ? modelOf(voiceKeys?.fast || envValue, ctx, whereOpts) : providerModel(envValue, id, ctx, whereOpts);
  } else if (pin) {
    row.pin = pin;
    row.status = { code: "pinned" };
    row.model = id === "safety" ? await classifierModel(db, ctx, whereOpts, classifierStatusFn) : providerModel(pin.value, id, ctx, whereOpts);
  } else {
    let r;
    try { r = resolveRoleKey(`role:${id}`, { ...ctx, need: NEED[id] || def.capability }); } catch (e) {
      console.warn(`[models] resolve ${id} failed: ${e?.message}`);
      r = { key: null, chain: [], reason: "error" };
    }
    if (r.reason === "bound") {
      row.status = { code: seeded ? "default" : "ready" };
      row.model = modelOf(id === "voice" ? voiceKeys?.fast || r.key : r.key, ctx, whereOpts);
    } else if (r.reason === "fallback") {
      row.status = { code: "fallback", role: r.chain[r.chain.length - 1] };
      row.model = modelOf(r.key, ctx, whereOpts);
    } else if (r.reason === "unset") {
      if (CONSUMER_DEFAULT.has(id)) {
        const m = id === "safety"
          ? await classifierModel(db, ctx, whereOpts, classifierStatusFn)
          : providerModel(pickProviderByTask(ctx.providers || [], TASKS[id]), id, ctx, whereOpts);
        if (m) { row.status = { code: "default" }; row.model = m; }
      }
    } else {
      row.status = { code: "not_available" };
    }
  }

  if (HIDDEN_UNLESS_BOUND.has(id)) row.hidden = !(b && b.model != null) && !row.pin;
  return row;
}

async function speechRow(db, def, { whereOpts, voiceDef }) {
  const id = def.id;
  const s = SPEECH[id];
  const row = {
    id, kind: "speech", hidden: false, model: null, status: { code: "not_set" }, chosen: false, seeded: false,
    detailsHref: `?section=llm&tab=profiles&subtab=${id}`,
  };
  let profile = null;
  try { profile = await s.getDefault(db); } catch (e) { console.warn(`[models] ${id} profiles unreadable: ${e?.message}`); }
  if (profile) {
    let where = "missing";
    try { where = speechProfileWhere(profile, whereOpts); } catch { where = "missing"; }
    const name = typeof profile.name === "string" && profile.name ? profile.name : String(profile.id || id);
    row.model = { key: String(profile.id || ""), label: name, where };
    row.status = { code: "ready" };
    row.chosen = true;
  }
  // The Crow voice bot may speak or listen with its own profile instead of the default.
  const own = voiceDef ? normalizeVoiceSettings(voiceDef)[s.field] : null;
  if (own && own !== profile?.id) {
    let name = own;
    try {
      const p = (await s.list(db)).find((x) => x && x.id === own);
      if (p && typeof p.name === "string" && p.name) name = p.name;
    } catch { /* the id is shown */ }
    row.voiceBot = { profileId: own, name };
  }
  return row;
}

/**
 * @param {object} db
 * @param {object} [opts]
 * @param {object} [opts.env]               env for pins and overrides (default process.env)
 * @param {string} [opts.lang]              accepted for the callers' symmetry; rows carry codes, not copy
 * @param {Set<string>} [opts.ownAddrs]     this box's addresses (default: probed)
 * @param {object} [opts.localMarks]
 * @param {() => string} [opts.localInstanceId]  test seam for the role context
 * @param {Function} [opts.classifierStatusFn]   test seam (default getClassifierStatus)
 * @returns {Promise<Array<object>>} RoleRow[] in page order, each with its `group`
 */
export async function buildRoleRows(db, { env = process.env, ownAddrs, localMarks, localInstanceId, classifierStatusFn = getClassifierStatus } = {}) {
  const ctx = await loadRoleContext(db, { maxAgeMs: 0, ...(localInstanceId ? { getOrCreateLocalInstanceId: localInstanceId } : {}) });
  const whereOpts = { ...(ownAddrs ? { ownAddrs } : {}), ...(localMarks ? { localMarks } : {}) };
  // Voice keys from the same context the rows use.
  const resolveRoleFn = async (_db, key, { need, chosenOnly } = {}) => (chosenOnly ? resolveChosenRoleKey : resolveRoleKey)(key, { ...ctx, need });
  let voiceKeys = null;
  try { voiceKeys = await resolveVoiceKeys(db, { env, resolveRoleFn }); } catch (e) { console.warn(`[models] voice keys failed: ${e?.message}`); }
  const voiceDef = await voiceBotDef(db);
  const byId = new Map(CORE_ROLES.map((r) => [r.id, r]));
  const rows = [];
  for (const g of ROLE_GROUPS) {
    for (const id of g.roles) {
      const def = byId.get(id);
      if (!def) continue;
      let row;
      if (id === "image" || id === "video") {
        row = { id, kind: "media", hidden: false, model: null, status: { code: "not_set_up" }, chosen: false, seeded: false };
      } else if (SPEECH[id]) {
        row = await speechRow(db, def, { whereOpts, voiceDef });
      } else {
        row = await chatRow(db, def, ctx, { env, whereOpts, voiceKeys, classifierStatusFn });
      }
      rows.push({ ...row, group: g.id, labelKey: ROLE_LABEL_KEYS[id], jobKey: ROLE_JOB_KEYS[id] });
    }
  }
  return rows;
}
