/**
 * The bot `auto` bash policy's safety classifier, read for a spawn.
 *
 * Synchronous over the bridge's better-sqlite3 connection: the
 * `bot_safety_classifier` setting (this instance's override first, then the
 * global value — readSetting's order) and the providers rows, handed to the
 * pure resolver in servers/shared/bot-bash-policy.js. Between the setting and
 * the automatic pick sits a CHOSEN `safety` role (a seeded binding never
 * counts; a cloud or broken one falls to the automatic pick). Never throws:
 * any failure is "no classifier", which pi-lab treats as fail-closed.
 */
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";
import { CLASSIFIER_SETTING_KEY, selectClassifierWithRole } from "../../servers/shared/bot-bash-policy.js";
import { getOwnAddresses } from "../../servers/shared/locality.js";
import { resolveChosenRoleKey, isCloudKey } from "../../servers/shared/model-roles.js";
import { modelsFromRows, loadModelsFromFile } from "./model_resolver.mjs";
import { loadRoleContextSync } from "./role_context.mjs";

/** The chosen safety role's raw key and the camelCase providers isCloud needs; never throws. */
function safetyRole(conn, rows, localId) {
  try {
    const fromDb = modelsFromRows(rows.filter((r) => !Number(r.disabled || 0)));
    // loadModels()'s rule, synchronously: the DB's enabled rows when any parse, else models.json.
    const models = fromDb && Object.keys(fromDb.providers).length ? fromDb : loadModelsFromFile();
    // ctx.providers: every row (SELECT *) through providerRowToObject, so the
    // door walk sees bundle_id/gpu_policy; an unreadable table gives [] and
    // isCloudKey then refuses the role (fail closed to the automatic pick).
    const ctx = loadRoleContextSync(conn, { models, ownInstanceId: () => localId });
    return { roleKey: resolveChosenRoleKey("role:safety", { need: "chat", ...ctx }).key, providers: ctx.providers };
  } catch {
    return { roleKey: null, providers: [] };
  }
}

export function readBotClassifierSync(conn, { localInstanceId } = {}) {
  try {
    let localId = localInstanceId;
    if (localId === undefined) { try { localId = getOrCreateLocalInstanceId(); } catch { localId = null; } }
    let row = null;
    if (localId) {
      try {
        row = conn.prepare("SELECT value FROM dashboard_settings_overrides WHERE key=? AND instance_id=?").get(CLASSIFIER_SETTING_KEY, localId);
      } catch { row = null; }
    }
    if (!row) row = conn.prepare("SELECT value FROM dashboard_settings WHERE key=?").get(CLASSIFIER_SETTING_KEY);
    const providers = conn.prepare(
      "SELECT id, base_url, host, provider_type, models, disabled, gpu_policy, instance_id FROM providers").all();
    let ownAddresses = null;
    try { ownAddresses = getOwnAddresses(); } catch { ownAddresses = null; }
    const setting = row ? row.value : null;
    const role = setting != null && String(setting).trim() !== "" ? { roleKey: null, providers: [] } : safetyRole(conn, providers, localId || null);
    return selectClassifierWithRole({
      setting, roleKey: role.roleKey, rows: providers, ownAddresses, ownInstanceId: localId || null,
      isCloud: (k) => isCloudKey(k, { providers: role.providers, ownAddrs: ownAddresses }),
    });
  } catch (e) {
    return { ok: false, reason: "read-failed", detail: String((e && e.message) || e).slice(0, 200) };
  }
}
