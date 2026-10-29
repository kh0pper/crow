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
 * @returns {Promise<RoleConsumers>}
 */
export async function listRoleConsumers(db, roleId, { slots, bindings, customDefs, env = process.env, isPrimary, roleCtx } = {}) {
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
  return out;
}
