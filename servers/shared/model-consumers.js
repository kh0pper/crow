/**
 * Model roles: read-only scan of every place a model key is used, so the UI
 * can show "Used by", warn before a role change, and convert matching bots.
 * Writes nothing anywhere.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isRoleRef, roleIdOf, CORE_ROLES, resolveRoleKey } from "./model-roles.js";
import { VOICE_ROUTE_DEFAULTS } from "./voice-route-defaults.js";
import { parseClassifierSetting, CLASSIFIER_SETTING_KEY } from "./bot-bash-policy.js";
import { readSetting } from "../gateway/dashboard/settings/registry.js";
import { DEFAULT_ROUTES, SMART_TIER_ROLES } from "../gateway/ai/smart-router.js";
import { MULTI_AGENT_CAPABLE } from "../../scripts/pi-bots/pi_extensions_allowlist.mjs";
import { LOCAL_FALLBACK } from "../../scripts/pi-bots/model_resolver.mjs";
import { str, readJsonFile, agentModels } from "./pi-agent-config.js";
import { resolveSqlitePath, tasksDbPath } from "../../scripts/pi-bots/instance-paths.mjs";

// Same string as BOTCRON_PREFIX in scripts/pi-bots/bot_scheduler.mjs. Not
// imported: that module opens databases and pulls in the job runner.
const BOTCRON_PREFIX = "pipeline:botcron:";

const parseJson = (v, fb) => { try { return v == null ? fb : JSON.parse(v); } catch { return fb; } };

// ---- unattended (R9) ------------------------------------------------------

/** True when the bot can act with nobody watching. In doubt, true: a false positive only adds a confirm. */
export function isUnattended(def, ctx = {}) {
  if (ctx.unknown || ctx.botcron || ctx.registryRow) return true;
  if ((ctx.openJobs || 0) > 0 || (ctx.assignedCards || 0) > 0) return true;
  const gws = Array.isArray(def?.gateways) ? def.gateways : [];
  return gws.some((g) => g && g.type !== "perch");
}

function projectStorePaths(projectUris, mainPath) {
  const out = [];
  const seen = new Set();
  for (const uri of [mainPath, ...projectUris]) {
    let real = null;
    try { real = uri ? resolveSqlitePath(String(uri)) : null; } catch { real = null; }
    if (!real || seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

// Only a missing table means "genuinely nothing there". Anything else (busy,
// corrupt, not a database, permissions, a missing column) is unknown, and
// unknown counts as unattended.
const ABSENT_RE = /no such table/i;
const isAbsent = (e) => ABSENT_RE.test(String(e?.message || e));

/** @returns {Promise<{paths:string[], unknown:boolean}>} unknown: the store list itself could not be established. */
async function defaultTasksDbPaths(db) {
  let uris = [];
  let unknown = false;
  try {
    const { rows } = await db.execute("SELECT tasks_db_uri FROM project_spaces");
    uris = rows.map((r) => r.tasks_db_uri).filter(Boolean);
  } catch (e) { if (!isAbsent(e)) unknown = true; } // no project_spaces table: instance store only
  let main = null;
  try { main = tasksDbPath(); } catch { unknown = true; }
  return { paths: projectStorePaths(uris, main), unknown };
}

/** The one way a tasks store is opened here: read-only, so a scan can never write. */
export function openTasksStoreReadonly(path) {
  const h = new Database(path, { readonly: true, fileMustExist: true });
  h.pragma("busy_timeout = 2000");
  return h;
}

/** @returns {{n:number, unknown:boolean}} */
function countAssignedCards(path, botId) {
  if (!existsSync(path)) return { n: 0, unknown: false }; // a missing store holds no cards
  let h;
  try {
    h = openTasksStoreReadonly(path);
    const n = h.prepare("SELECT COUNT(*) AS n FROM tasks_items WHERE assigned_bot = ? AND archived_at IS NULL").get(botId).n;
    return { n, unknown: false };
  } catch (e) {
    // A store with no tasks_items table has no cards. A missing column is
    // ambiguous (archived_at predates every migrated store, but not a stale
    // one), so it is unknown rather than zero.
    if (/no such table/i.test(String(e?.message || e))) return { n: 0, unknown: false };
    return { n: 0, unknown: true };
  } finally { try { h?.close(); } catch { /* ignore */ } }
}

/** @returns {{n:number, unknown:boolean}} */
async function count(db, sql, args) {
  try { const { rows } = await db.execute({ sql, args }); return { n: Number(rows[0]?.n) || 0, unknown: false }; }
  catch (e) { return isAbsent(e) ? { n: 0, unknown: false } : { n: 0, unknown: true }; }
}

/** Gather the unattended signals for one bot. A lookup that fails for any reason but "absent" sets ctx.unknown. */
export async function loadUnattendedContext(db, botId, { tasksDbPaths } = {}) {
  const cron = await count(db, "SELECT COUNT(*) AS n FROM schedules WHERE task = ?", [BOTCRON_PREFIX + botId]);
  const jobs = await count(db, "SELECT COUNT(*) AS n FROM bot_jobs WHERE bot_id = ? AND status IN ('queued','running')", [botId]);
  const reg = await count(db, "SELECT COUNT(*) AS n FROM bot_registry WHERE bot_id = ?", [botId]);
  const found = tasksDbPaths ? { paths: tasksDbPaths, unknown: false } : await defaultTasksDbPaths(db);
  const paths = found.paths;
  let assignedCards = 0;
  let unknown = cron.unknown || jobs.unknown || reg.unknown || found.unknown;
  for (const p of paths) {
    const r = countAssignedCards(p, botId);
    assignedCards += r.n;
    unknown ||= r.unknown;
  }
  return { botcron: cron.n > 0, openJobs: jobs.n, assignedCards, registryRow: reg.n > 0, unknown };
}

// ---- pi sub-agent / config helpers ----------------------------------------

const providerOf = (key) => {
  const s = str(key);
  if (!s) return null;
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i) : s;
};

/**
 * Provider ids mentioned in pi config and in code constants -> where they
 * appear, as translatable refs `{labelKey, labelParams?}` (plain language; the
 * strings live in i18n.js under settings.providers.pi.*).
 */
export function piConfigRefs(piAgentDir) {
  const refs = {};
  const add = (key, labelKey, params) => {
    const p = providerOf(key);
    if (!p) return;
    const list = (refs[p] ||= []);
    const dup = list.some((r) => r.labelKey === labelKey && r.labelParams?.name === params?.name);
    if (!dup) list.push(params ? { labelKey, labelParams: params } : { labelKey });
  };
  if (piAgentDir) {
    const st = readJsonFile(join(piAgentDir, "settings.json")) || {};
    add(st.defaultModel, "settings.providers.pi.defaultModel");
    for (const v of Object.values(st.planMode || {})) if (typeof v === "string") add(v, "settings.providers.pi.planMode");
    for (const v of Object.values(st.critic || {})) if (typeof v === "string") add(v, "settings.providers.pi.critic");
    for (const k of Object.keys(st.localModels || {})) add(k, "settings.providers.pi.localModels");
    for (const [name, v] of Object.entries(st.subagent?.modelOverrides || {})) add(v, "settings.providers.pi.subagent", { name });
    for (const [name, v] of Object.entries(agentModels(piAgentDir))) add(v, "settings.providers.pi.agent", { name });
  }
  for (const k of MULTI_AGENT_CAPABLE) add(k, "settings.providers.pi.multiAgent");
  add(LOCAL_FALLBACK, "settings.providers.pi.fallback");
  return refs;
}

// ---- slot scan -----------------------------------------------------------

/**
 * Every place a model key is used. The returned array carries an `incomplete`
 * property: true when any source failed for a reason other than "table
 * absent", i.e. the list may be missing entries (callers must not read an
 * empty list as "nothing uses it").
 *
 * Slots from job/phone sources carry `labelKey` (an i18n.js key) next to the
 * English `label`; bot slots label with the bot's display name.
 *
 * `withUnattended: false` skips the unattended detection entirely (no tasks
 * store is opened) and slots carry `unattended: null`.
 *
 * @returns {Promise<Array<{kind:string,id:string,label:string,labelKey?:string,field:string,value:*,unattended:boolean|null,peerManaged:boolean,dead?:boolean,pinnedInPi?:boolean,providerOnly?:boolean,dynamic?:boolean}> & {incomplete:boolean}>}
 */
export async function scanSlots(db, { includeSubagents = false, piAgentDir = null, tasksDbPaths, withUnattended = true } = {}) {
  const slots = [];
  let incomplete = false;
  const note = (e) => { if (!isAbsent(e)) incomplete = true; };
  let managed = [];
  try {
    const a = parseJson(await readSetting(db, "remote_managed_bots"), []);
    if (Array.isArray(a)) managed = a.map(String);
  } catch (e) { note(e); }

  let bots = [];
  try { bots = (await db.execute("SELECT bot_id, display_name, definition FROM pi_bot_defs ORDER BY bot_id")).rows; } catch (e) { note(e); }
  let found = null;
  if (withUnattended && bots.length) found = tasksDbPaths ? { paths: tasksDbPaths, unknown: false } : await defaultTasksDbPaths(db);
  for (const b of bots) {
    const def = parseJson(b.definition, {}) || {};
    let unattended = null;
    if (found) {
      const ctx = await loadUnattendedContext(db, b.bot_id, { tasksDbPaths: found.paths });
      if (found.unknown) ctx.unknown = true;
      unattended = isUnattended(def, ctx);
    }
    const peerManaged = managed.includes(b.bot_id);
    const label = b.display_name || b.bot_id;
    const push = (kind, field, value, extra = {}) => {
      const v = str(value);
      if (v) slots.push({ kind, id: b.bot_id, label, field, value: v, unattended, peerManaged, ...extra });
    };
    push("bot", "models.default", def.models?.default);
    push("bot", "models.escalation", def.models?.escalation);
    push("bot", "fast_voice_model", def.fast_voice_model);
    (Array.isArray(def.gateways) ? def.gateways : []).forEach((g, i) => {
      push("gateway", `gateways[${i}].fast_voice_model`, g?.fast_voice_model, { dead: true });
    });
  }

  // Job slots: today's effective RAW keys, read without side effects.
  const job = (id, label, labelKey, field, value, extra = {}) =>
    slots.push({ kind: "job", id, label, labelKey, field, value, unattended: true, peerManaged: false, ...extra });
  const envOr = (name, dflt, id, label, labelKey) => {
    const e = str(process.env[name]);
    job(id, label, labelKey, e ? `env:${name}` : "default", e || dflt);
  };
  envOr("COMPANION_FAST_MODEL", VOICE_ROUTE_DEFAULTS.fast, "llm-router:fast", "Voice router (fast)", "settings.providers.job.voiceFast");
  envOr("COMPANION_ESCALATION_MODEL", VOICE_ROUTE_DEFAULTS.escalate, "llm-router:escalate", "Voice router (escalate)", "settings.providers.job.voiceEscalate");
  // One slot per tier that a role can name (I11), so binding `vision` lists the
  // vision tier too. A tier with no baked default (vision) is dynamic: null.
  for (const tier of Object.keys(SMART_TIER_ROLES)) {
    // `default` has no env reader in smart-router.js (it is not run through tierDefault).
    const e = tier === "default" ? null : str(process.env[`CROW_SMART_ROUTER_${tier.toUpperCase()}`]);
    const value = e || str(DEFAULT_ROUTES[tier]);
    const field = e ? `env:CROW_SMART_ROUTER_${tier.toUpperCase()}` : "default";
    job(`smart-router:${tier}`, `Smart router (${tier})`, `settings.providers.job.smart.${tier}`, field, value, value ? { providerOnly: true } : { providerOnly: true, dynamic: true });
  }
  const setting = async (k) => { try { return str(await readSetting(db, k)); } catch (e) { note(e); return null; } };
  for (const [id, label, labelKey, envName, key] of [
    ["embed", "Memory embeddings", "settings.providers.job.embed", "CROW_EMBED_PROVIDER", "embed_provider"],
    ["rerank", "Memory rerank", "settings.providers.job.rerank", "CROW_RERANK_PROVIDER", "rerank_provider"],
  ]) {
    const e = str(process.env[envName]);
    const s = e ? null : await setting(key);
    if (e || s) job(id, label, labelKey, e ? `env:${envName}` : `setting:${key}`, e || s, { providerOnly: true });
    else job(id, label, labelKey, `setting:${key}`, null, { dynamic: true, providerOnly: true });
  }
  const cls = parseClassifierSetting(await setting(CLASSIFIER_SETTING_KEY));
  const clsValue = cls?.provider ? `${cls.provider}/${cls.model}` : cls?.url ? cls.model : null;
  const SAFETY = "settings.providers.job.safety";
  if (clsValue) job("safety", "Bot safety classifier", SAFETY, `setting:${CLASSIFIER_SETTING_KEY}`, clsValue);
  else job("safety", "Bot safety classifier", SAFETY, `setting:${CLASSIFIER_SETTING_KEY}`, null, { dynamic: true });

  for (const [key, label, labelKey] of [
    ["phone_local_model", "Phone calls (local model)", "settings.providers.phone.local"],
    ["phone_cloud_model", "Phone calls (cloud model)", "settings.providers.phone.cloud"],
  ]) {
    const v = await setting(key);
    if (v) slots.push({ kind: "phone", id: key, label, labelKey, field: key, value: v, unattended: false, peerManaged: false });
  }

  if (includeSubagents && piAgentDir) {
    const st = readJsonFile(join(piAgentDir, "settings.json")) || {};
    const overrides = st.subagent?.modelOverrides || {};
    const pins = st.subagent?.rolePins || {};
    const effective = { ...agentModels(piAgentDir) };
    for (const [n, v] of Object.entries(overrides)) if (str(v)) effective[n] = v;
    for (const [name, value] of Object.entries(effective)) {
      slots.push({
        kind: "subagent", id: name, label: name,
        field: overrides[name] ? "subagent.modelOverrides" : "frontmatter:model",
        value, unattended: false, peerManaged: false,
        ...(pins[name] === false ? { pinnedInPi: true } : {}),
      });
    }
  }
  slots.incomplete = incomplete;
  return slots;
}

// ---- consumers ------------------------------------------------------------

const bareId = (x) => (isRoleRef(x) ? roleIdOf(x) : x);

/** Role ids a role can reach in one step: its bound model when that is a role ref, then its fallbacks. */
function chainOf(roleId, { bindings = {}, customDefs = {} } = {}) {
  const b = bindings[roleId] || {};
  const out = [];
  if (isRoleRef(b.model)) out.push(roleIdOf(b.model));
  const fb = Array.isArray(b.fallback) ? b.fallback
    : Array.isArray(customDefs[roleId]?.fallback) ? customDefs[roleId].fallback
    : CORE_ROLES.find((r) => r.id === roleId)?.defaultFallback || [];
  for (const f of fb) out.push(bareId(f));
  return out;
}

/**
 * Every role that can reach roleId -> the role path from it to roleId (the
 * shortest found; roleId itself maps to [roleId]). A role reaches through its
 * bound `role:` ref or its fallback chain (stored, or the default when none is
 * stored), transitively. Known roles: the core ones, every bound or custom id,
 * and `extraIds` (e.g. role refs found in slots).
 */
export function rolePathsTo(roleId, { bindings = {}, customDefs = {}, extraIds = [] } = {}) {
  const paths = new Map([[roleId, [roleId]]]);
  const known = new Set([...CORE_ROLES.map((r) => r.id), ...Object.keys(bindings), ...Object.keys(customDefs), ...extraIds]);
  // Level by level, so each path is a shortest one.
  let grew = true;
  while (grew) {
    grew = false;
    const level = new Map(paths);
    for (const r of known) {
      if (paths.has(r)) continue;
      const next = chainOf(r, { bindings, customDefs }).find((f) => level.has(f));
      if (next !== undefined) { paths.set(r, [r, ...level.get(next)]); grew = true; }
    }
  }
  return paths;
}

/**
 * The role plus every role whose bound ref or fallback chain reaches it,
 * transitively. Potential reach: for a consumer that follows only a chosen
 * role this over-approximates, which only makes a warning broader.
 * @returns {Set<string>}
 */
export function rolesReaching(roleId, ctx = {}) {
  return new Set(rolePathsTo(roleId, ctx).keys());
}

/** Slots whose value is role:<roleId>, plus those of every role whose fallback chain reaches roleId. */
export function consumersOfRole(slots, roleId, { bindings = {}, customDefs = {} } = {}) {
  const extraIds = slots.filter((s) => isRoleRef(s.value)).map((s) => roleIdOf(s.value));
  const ids = rolesReaching(roleId, { bindings, customDefs, extraIds });
  return slots.filter((s) => isRoleRef(s.value) && ids.has(roleIdOf(s.value)));
}

/**
 * Slots using `key` directly, plus slots on roles that resolve to it. Pass
 * `resolveCtx` (providers, models, catalog, ownInstanceId, ...) for the exact
 * configured-aware answer; without it a role matches when `key` is reachable
 * through its bound model, indirection or fallbacks (an over-approximation,
 * which only makes a warning broader).
 */
export function consumersOfModel(slots, key, { bindings = {}, customDefs = {}, resolveCtx = null } = {}) {
  const out = new Set(slots.filter((s) => s.value === key));
  const reaches = (id, depth, seen) => {
    if (depth > 4 || seen.has(id)) return false;
    seen.add(id);
    const b = bindings[id] || {};
    if (b.model === key) return true;
    return chainOf(id, { bindings, customDefs }).some((n) => reaches(n, depth + 1, seen));
  };
  const roleIds = new Set(slots.filter((s) => isRoleRef(s.value)).map((s) => roleIdOf(s.value)));
  for (const id of roleIds) {
    let hit;
    if (resolveCtx) {
      try { hit = resolveRoleKey(`role:${id}`, { bindings, customDefs, ...resolveCtx })?.key === key; } catch { hit = false; }
    } else hit = reaches(id, 0, new Set());
    if (hit) for (const s of slots) if (s.value === `role:${id}`) out.add(s);
  }
  return [...out];
}
