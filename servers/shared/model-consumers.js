/**
 * Model roles: read-only scan of every place a model key is used, so the UI
 * can show "Used by", warn before a role change, and convert matching bots.
 * Writes nothing anywhere.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isRoleRef, roleIdOf, CORE_ROLES, resolveRoleKey } from "./model-roles.js";
import { VOICE_ROUTE_DEFAULTS } from "./voice-route-defaults.js";
import { parseClassifierSetting, CLASSIFIER_SETTING_KEY } from "./bot-bash-policy.js";
import { readSetting } from "../gateway/dashboard/settings/registry.js";
import { DEFAULT_ROUTES } from "../gateway/ai/smart-router.js";
import { MULTI_AGENT_CAPABLE } from "../../scripts/pi-bots/pi_extensions_allowlist.mjs";
import { LOCAL_FALLBACK } from "../../scripts/pi-bots/model_resolver.mjs";
import { resolveSqlitePath, tasksDbPath } from "../../scripts/pi-bots/instance-paths.mjs";

// Same string as BOTCRON_PREFIX in scripts/pi-bots/bot_scheduler.mjs. Not
// imported: that module opens databases and pulls in the job runner.
const BOTCRON_PREFIX = "pipeline:botcron:";

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const parseJson = (v, fb) => { try { return v == null ? fb : JSON.parse(v); } catch { return fb; } };

// ---- unattended (R9) ------------------------------------------------------

/** True when the bot can act with nobody watching. In doubt, true: a false positive only adds a confirm. */
export function isUnattended(def, ctx = {}) {
  if (ctx.botcron || ctx.registryRow) return true;
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

async function defaultTasksDbPaths(db) {
  let uris = [];
  try {
    const { rows } = await db.execute("SELECT tasks_db_uri FROM project_spaces");
    uris = rows.map((r) => r.tasks_db_uri).filter(Boolean);
  } catch { /* no project_spaces: instance store only */ }
  let main = null;
  try { main = tasksDbPath(); } catch { main = null; }
  return projectStorePaths(uris, main);
}

function countAssignedCards(path, botId) {
  if (!existsSync(path)) return 0;
  let h;
  try {
    h = new Database(path, { readonly: true, fileMustExist: true });
    return h.prepare("SELECT COUNT(*) AS n FROM tasks_items WHERE assigned_bot = ? AND archived_at IS NULL").get(botId).n;
  } catch { return 0; } finally { try { h?.close(); } catch { /* ignore */ } }
}

async function count(db, sql, args) {
  try { const { rows } = await db.execute({ sql, args }); return Number(rows[0]?.n) || 0; } catch { return 0; }
}

/** Gather the unattended signals for one bot. Every lookup is best-effort. */
export async function loadUnattendedContext(db, botId, { tasksDbPaths } = {}) {
  const botcron = (await count(db, "SELECT COUNT(*) AS n FROM schedules WHERE task = ?", [BOTCRON_PREFIX + botId])) > 0;
  const openJobs = await count(db, "SELECT COUNT(*) AS n FROM bot_jobs WHERE bot_id = ? AND status IN ('queued','running')", [botId]);
  const registryRow = (await count(db, "SELECT COUNT(*) AS n FROM bot_registry WHERE bot_id = ?", [botId])) > 0;
  const paths = tasksDbPaths ?? (await defaultTasksDbPaths(db));
  let assignedCards = 0;
  for (const p of paths) assignedCards += countAssignedCards(p, botId);
  return { botcron, openJobs, assignedCards, registryRow };
}

// ---- pi sub-agent / config helpers ----------------------------------------

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** Minimal frontmatter parse: the leading `---` block, `key: value` lines. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function agentModels(piAgentDir) {
  const dir = join(piAgentDir, "agents");
  const out = {};
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return out; }
  for (const f of names) {
    let fm;
    try { fm = frontmatter(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    const model = str(fm.model);
    if (model) out[f.slice(0, -3)] = model;
  }
  return out;
}

const providerOf = (key) => {
  const s = str(key);
  if (!s) return null;
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i) : s;
};

/** Provider ids mentioned in pi config and in code constants -> where they appear. */
export function piConfigRefs(piAgentDir) {
  const refs = {};
  const add = (key, label) => {
    const p = providerOf(key);
    if (!p) return;
    (refs[p] ||= []);
    if (!refs[p].includes(label)) refs[p].push(label);
  };
  if (piAgentDir) {
    const st = readJsonFile(join(piAgentDir, "settings.json")) || {};
    add(st.defaultModel, "setting:defaultModel");
    for (const [k, v] of Object.entries(st.planMode || {})) if (typeof v === "string") add(v, `setting:planMode.${k}`);
    for (const [k, v] of Object.entries(st.critic || {})) if (typeof v === "string") add(v, `setting:critic.${k}`);
    for (const k of Object.keys(st.localModels || {})) add(k, `setting:localModels.${k}`);
    for (const [name, v] of Object.entries(st.subagent?.modelOverrides || {})) add(v, `subagent:${name}`);
    for (const [name, v] of Object.entries(agentModels(piAgentDir))) add(v, `agent:${name}`);
  }
  for (const k of MULTI_AGENT_CAPABLE) add(k, "code:MULTI_AGENT_CAPABLE");
  add(LOCAL_FALLBACK, "code:LOCAL_FALLBACK");
  return refs;
}

// ---- slot scan -----------------------------------------------------------

/**
 * @returns {Promise<Array<{kind:string,id:string,label:string,field:string,value:*,unattended:boolean,peerManaged:boolean,dead?:boolean,pinnedInPi?:boolean,providerOnly?:boolean,dynamic?:boolean}>>}
 */
export async function scanSlots(db, { includeSubagents = false, piAgentDir = null, tasksDbPaths } = {}) {
  const slots = [];
  let managed = [];
  try {
    const a = parseJson(await readSetting(db, "remote_managed_bots"), []);
    if (Array.isArray(a)) managed = a.map(String);
  } catch { /* none */ }

  let bots = [];
  try { bots = (await db.execute("SELECT bot_id, display_name, definition FROM pi_bot_defs ORDER BY bot_id")).rows; } catch { /* none */ }
  const paths = tasksDbPaths ?? (await defaultTasksDbPaths(db));
  for (const b of bots) {
    const def = parseJson(b.definition, {}) || {};
    const ctx = await loadUnattendedContext(db, b.bot_id, { tasksDbPaths: paths });
    const unattended = isUnattended(def, ctx);
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
  const job = (id, label, field, value, extra = {}) =>
    slots.push({ kind: "job", id, label, field, value, unattended: true, peerManaged: false, ...extra });
  const envOr = (name, dflt, id, label) => {
    const e = str(process.env[name]);
    job(id, label, e ? `env:${name}` : "default", e || dflt);
  };
  envOr("COMPANION_FAST_MODEL", VOICE_ROUTE_DEFAULTS.fast, "llm-router:fast", "Voice router (fast)");
  envOr("COMPANION_ESCALATION_MODEL", VOICE_ROUTE_DEFAULTS.escalate, "llm-router:escalate", "Voice router (escalate)");
  for (const [tier, value] of Object.entries(DEFAULT_ROUTES)) {
    if (!value) continue;
    const e = str(process.env[`CROW_SMART_ROUTER_${tier.toUpperCase()}`]);
    job(`smart-router:${tier}`, `Smart router (${tier})`, e ? `env:CROW_SMART_ROUTER_${tier.toUpperCase()}` : "default", value, { providerOnly: true });
  }
  const setting = async (k) => { try { return str(await readSetting(db, k)); } catch { return null; } };
  for (const [id, label, envName, key] of [
    ["embed", "Memory embeddings", "CROW_EMBED_PROVIDER", "embed_provider"],
    ["rerank", "Memory rerank", "CROW_RERANK_PROVIDER", "rerank_provider"],
  ]) {
    const e = str(process.env[envName]);
    const s = e ? null : await setting(key);
    if (e || s) job(id, label, e ? `env:${envName}` : `setting:${key}`, e || s, { providerOnly: true });
    else job(id, label, `setting:${key}`, null, { dynamic: true, providerOnly: true });
  }
  const cls = parseClassifierSetting(await setting(CLASSIFIER_SETTING_KEY));
  const clsValue = cls?.provider ? `${cls.provider}/${cls.model}` : cls?.url ? cls.model : null;
  if (clsValue) job("safety", "Bot safety classifier", `setting:${CLASSIFIER_SETTING_KEY}`, clsValue);
  else job("safety", "Bot safety classifier", `setting:${CLASSIFIER_SETTING_KEY}`, null, { dynamic: true });

  for (const key of ["phone_local_model", "phone_cloud_model"]) {
    const v = await setting(key);
    if (v) slots.push({ kind: "phone", id: key, label: key, field: key, value: v, unattended: false, peerManaged: false });
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

/** Slots whose value is role:<roleId>, plus those of every role whose fallback chain reaches roleId. */
export function consumersOfRole(slots, roleId, { bindings = {}, customDefs = {} } = {}) {
  const ids = new Set([roleId]);
  const known = new Set([...CORE_ROLES.map((r) => r.id), ...Object.keys(bindings), ...Object.keys(customDefs)]);
  for (const s of slots) if (isRoleRef(s.value)) known.add(roleIdOf(s.value));
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of known) {
      if (ids.has(r)) continue;
      if (chainOf(r, { bindings, customDefs }).some((f) => ids.has(f))) { ids.add(r); grew = true; }
    }
  }
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
