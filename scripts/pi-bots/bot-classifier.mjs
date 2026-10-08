/**
 * The bot `auto` bash policy's safety classifier, read for a spawn.
 *
 * Synchronous over the bridge's better-sqlite3 connection: the
 * `bot_safety_classifier` setting (this instance's override first, then the
 * global value — readSetting's order) and the providers rows, handed to the
 * pure resolver in servers/shared/bot-bash-policy.js. Never throws: any
 * failure is "no classifier", which pi-lab treats as fail-closed.
 */
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";
import { CLASSIFIER_SETTING_KEY, selectBotClassifier } from "../../servers/shared/bot-bash-policy.js";
import { getOwnAddresses } from "../../servers/shared/locality.js";

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
    return selectBotClassifier({ setting: row ? row.value : null, providers, ownAddresses, ownInstanceId: localId || null });
  } catch (e) {
    return { ok: false, reason: "read-failed", detail: String((e && e.message) || e).slice(0, 200) };
  }
}
