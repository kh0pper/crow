/**
 * Bot Builder: the state of the safety classifier that bash policy "auto"
 * depends on — for the hint under the bash setting (and any other surface
 * that offers "auto", e.g. the simplified Abilities tab).
 *
 *   ready           a local classifier is configured and answered /models
 *   not-responding  configured (setting or installed candidate) but down —
 *                   start it on the Models page
 *   missing         nothing installed — install the candidate (one click on
 *                   the Models page; size from the model catalog)
 *   misconfigured   the bot_safety_classifier setting names something that
 *                   is gone, disabled, not local, or not served
 *
 * Without a ready classifier "auto" still works fail-closed: in a Perch chat
 * every command asks, in a channel every command is refused.
 */
import { readFileSync } from "node:fs";
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSetting } from "../../settings/registry.js";
import { getOwnAddresses } from "../../../../shared/locality.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { CLASSIFIER_SETTING_KEY, selectBotClassifier, resolveClassifierEndpoint } from "../../../../shared/bot-bash-policy.js";

const CATALOG = join(dirname(fileURLToPath(import.meta.url)), "../../../../../registry/model-catalog.json");

/** Default-quant download size (MB) and licence of a catalog model, or null. */
export function catalogInstallInfo(modelId, catalogPath = CATALOG) {
  try {
    const cat = JSON.parse(readFileSync(catalogPath, "utf8"));
    const m = (cat.models || []).find((x) => x.id === modelId);
    if (!m) return null;
    const q = (m.quants || []).find((x) => x.quant === m.default_quant) || (m.quants || [])[0];
    return { modelId, sizeMb: q ? Math.round(q.size_mb) : null, minRamMb: q ? q.min_ram_mb || null : null, license: m.license || null };
  } catch { return null; }
}

export async function getClassifierStatus(db, { probe = true, fetchImpl = fetch, timeoutMs = 1500, lookup } = {}) {
  let setting = null;
  let providers = [];
  try { setting = await readSetting(db, CLASSIFIER_SETTING_KEY); } catch { setting = null; }
  try {
    providers = (await db.execute("SELECT id, base_url, host, provider_type, models, disabled, gpu_policy, instance_id FROM providers")).rows;
  } catch { providers = []; }
  let ownAddresses = null, ownInstanceId = null;
  try { ownAddresses = getOwnAddresses(); } catch {}
  try { ownInstanceId = getOrCreateLocalInstanceId(); } catch {}
  const sel = await resolveClassifierEndpoint(selectBotClassifier({ setting, providers, ownAddresses, ownInstanceId }), { lookup });
  if (!sel.ok) {
    return {
      state: sel.reason === "none" ? "missing" : "misconfigured",
      reason: sel.reason, ref: sel.ref || null,
      install: catalogInstallInfo(sel.installModel),
    };
  }
  const base = { providerId: sel.providerId || sel.where, model: sel.model, source: sel.source, where: sel.where, here: sel.here };
  if (!probe) return { state: "ready", ...base };
  try {
    // Never follow a redirect (same rule as pi-lab's classifier call).
    const r = await fetchImpl(`${sel.url}/models`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    return { state: r.ok ? "ready" : "not-responding", ...base };
  } catch {
    return { state: "not-responding", ...base };
  }
}

/**
 * The status line under Run commands when Auto is chosen: where commands are
 * checked, or why there is no safety check and what to do about it.
 */
export async function classifierStatusHtml(db, lang, opts = {}) {
  let st;
  try { st = await getClassifierStatus(db, opts); } catch { st = { state: "missing", install: null }; }
  const where = st.where ? (st.here ? `${st.where} (${t("botbuilder.classifierThisMachine", lang)})` : st.where) : "?";
  let msg;
  if (st.state === "ready") {
    msg = fill(t("botbuilder.classifierReady", lang), { model: st.model, provider: st.providerId, where });
  } else if (st.state === "not-responding") {
    msg = fill(t("botbuilder.classifierNotResponding", lang), { model: st.model, provider: st.providerId, where });
  } else if (st.state === "misconfigured") {
    msg = fill(t("botbuilder.classifierMisconfigured", lang), { ref: st.ref || "?", reason: st.reason || "?" });
  } else {
    const size = st.install && st.install.sizeMb ? `${(st.install.sizeMb / 1024).toFixed(1)} GB` : "?";
    msg = fill(t("botbuilder.classifierMissing", lang), { model: (st.install && st.install.modelId) || "qwen3.5-4b", size });
  }
  const link = st.state === "ready" ? "" : ` <a href="/dashboard/models">${escapeHtml(t("botbuilder.classifierOpenModels", lang))}</a>`;
  return `<p class="btb-hint" data-testid="classifier-status" data-state="${escapeHtml(st.state)}">${escapeHtml(msg)}${link}</p>`;
}
