/**
 * Model roles: everything that follows a role, grouped for the change
 * warning on the Models page. Read-only; writes nothing anywhere.
 *
 * May import model-consumers.js and ai/smart-router.js; model-roles-store.js
 * must not (tests/model-roles-import-graph.test.js).
 */
import { scanSlots, consumersOfRole, rolePathsTo, rolesReaching } from "./model-consumers.js";
import { SMART_TIER_ROLES } from "../gateway/ai/smart-router.js";
import { SUBAGENT_MAP_KEY, isRoleRef, roleIdOf, resolveRoleKey } from "./model-roles.js";
import { loadRoleContext } from "./model-roles-store.js";
import { readSetting } from "../gateway/dashboard/settings/registry.js";
import { isDefaultCrowHome } from "./crow-home.js";

export { rolesReaching };

/** Job slot id -> the role that job follows. */
export const JOB_ROLES = Object.freeze({
  "llm-router:fast": "voice",
  "llm-router:escalate": "everyday",
  ...Object.fromEntries(Object.entries(SMART_TIER_ROLES).map(([tier, role]) => [`smart-router:${tier}`, role])),
  embed: "embed",
  rerank: "rerank",
  safety: "safety",
});

const parseObject = (raw) => {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
};

/** One line per failure; the list is still returned (a lookup that failed lists nothing extra). */
const warn = (what, e) => console.warn(`[roles] listRoleConsumers: ${what}: ${String(e?.message || e)}`);

const entry = (s, via) => ({
  kind: s.kind, id: s.id, label: s.label,
  ...(s.labelKey ? { labelKey: s.labelKey } : {}),
  field: s.field, via,
  ...(s.peerManaged ? { peerManaged: true } : {}),
});

/**
 * @typedef {{kind:string, id:string, label:string, labelKey?:string, field:string, via:string[], peerManaged?:boolean}} RoleConsumer
 * @typedef {{unattended:RoleConsumer[], bots:RoleConsumer[], subagents:RoleConsumer[], jobs:RoleConsumer[], otherCrows:RoleConsumer[], notAffected:RoleConsumer[], keepsOwnModel:RoleConsumer[]}} RoleConsumers
 *
 * `via` is the role path from the consumer's role to roleId. Pass `slots`
 * from one `scanSlots(db, {withUnattended: true, includeSubagents: false})`;
 * without them this scans once itself. `roleCtx` (a RoleContext) defaults to
 * loadRoleContext(db); `bindings`/`customDefs` default to its own.
 * `smartChat: false` drops the smart-router tiers: the router reads no tier
 * while feature_flags.smart_chat is off (undefined keeps them).
 * Each group lists a consumer (kind + id) once.
 * @returns {Promise<RoleConsumers>}
 */
export async function listRoleConsumers(db, roleId, { slots, bindings, customDefs, env = process.env, isPrimary, roleCtx, smartChat } = {}) {
  const rc = roleCtx || await loadRoleContext(db);
  bindings ??= rc.bindings || {};
  customDefs ??= rc.customDefs || {};
  slots ??= await scanSlots(db, { withUnattended: true, includeSubagents: false, env });
  isPrimary ??= isDefaultCrowHome(env);

  const extraIds = slots.filter((s) => isRoleRef(s.value)).map((s) => roleIdOf(s.value));
  const paths = rolePathsTo(roleId, { bindings, customDefs, extraIds });
  const out = { unattended: [], bots: [], subagents: [], jobs: [], otherCrows: [], notAffected: [], keepsOwnModel: [] };

  // A dead slot (gateways[i].fast_voice_model) is read by nothing: never listed.
  slots = slots.filter((s) => !s.dead);

  for (const s of consumersOfRole(slots, roleId, { bindings, customDefs })) {
    const e = entry(s, paths.get(roleIdOf(s.value)));
    if (s.kind === "phone") out.jobs.push(e);
    else if (s.unattended === true) out.unattended.push(e);
    else out.bots.push(e);
  }

  for (const s of slots) {
    if (s.kind !== "job") continue;
    if (smartChat === false && String(s.id).startsWith("smart-router:")) continue;
    const via = paths.get(JOB_ROLES[s.id]);
    if (!via) continue;
    (String(s.field).startsWith("env:") ? out.notAffected : out.jobs).push(entry(s, via));
  }

  if (isPrimary) {
    let map = {};
    try { map = parseObject(await readSetting(db, SUBAGENT_MAP_KEY)); } catch (e) { warn("sub-agent map unreadable", e); map = {}; }
    for (const [name, v] of Object.entries(map)) {
      const via = typeof v?.role === "string" ? paths.get(v.role) : undefined;
      if (via) out.subagents.push({ kind: "subagent", id: name, label: name, field: SUBAGENT_MAP_KEY, via });
    }
  }

  // otherCrows stays empty in Phase 2: satellites following this box's roles
  // wait for satellite Part 2.

  let resolved = null;
  try { resolved = resolveRoleKey(`role:${roleId}`, { ...rc, bindings, customDefs })?.key || null; } catch (e) { warn(`role:${roleId} did not resolve`, e); resolved = null; }
  if (resolved) {
    for (const s of slots) if (s.kind === "bot" && s.value === resolved) out.keepsOwnModel.push(entry(s, []));
  }
  for (const g of Object.keys(out)) {
    const seen = new Set();
    out[g] = out[g].filter((c) => {
      const k = `${c.kind}|${c.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return out;
}

/**
 * What names `role:<roleId>` directly (the custom-role delete check): bot,
 * gateway and phone slots whose value is the ref (a dead slot is read by
 * nothing and does not count), and sub-agents mapped to the role. Roles that
 * name it are the store's own check (deleteCustomRole). Reads this db only:
 * no tasks store is opened (unattended detection is off), so it is safe
 * inside the delete's transaction. Keep it that way: it runs between BEGIN
 * IMMEDIATE and COMMIT, where a real async wait could stall the event loop
 * (the warning in deleteCustomRole).
 * @returns {Promise<Array<{kind:string, id:string, label:string, labelKey?:string}>>}
 */
export async function customRoleConsumers(db, roleId, { env = process.env } = {}) {
  const ref = `role:${roleId}`;
  const slots = await scanSlots(db, { withUnattended: false, includeSubagents: false, env });
  // Fail closed: a scan that could not read everything cannot prove the role unused.
  if (slots.incomplete) throw new Error("consumer scan incomplete");
  const out = [];
  const seen = new Set();
  const add = (c) => {
    const k = `${c.kind}|${c.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (const s of slots) {
    if (s.dead || s.value !== ref) continue;
    add({ kind: s.kind, id: s.id, label: s.label, ...(s.labelKey ? { labelKey: s.labelKey } : {}) });
  }
  let map = {};
  map = parseObject(await readSetting(db, SUBAGENT_MAP_KEY)); // a read error fails the delete closed
  for (const [name, v] of Object.entries(map)) {
    if (v?.role === roleId) add({ kind: "subagent", id: name, label: name });
  }
  return out;
}
