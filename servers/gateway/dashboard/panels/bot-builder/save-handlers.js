/**
 * Bot Builder — saves for the simplified editor (save_basics,
 * save_abilities, save_safety, save_advanced).
 *
 * Each save merges only its own tab's fields into the stored definition, and
 * inside a tab only the controls the operator changed (preserve-unless-
 * changed, def-adapter.js). Re-saving an untouched tab leaves the stored
 * definition byte-identical — that is the whole migration story for
 * existing bots.
 *
 * Each handler mutates `def` and returns { error?, warn?, column? } —
 * `error` refuses the whole save (nothing written), `column` carries
 * column updates (display_name).
 */
import { loadModelOptions } from "./data-queries.js";
import { normalizeGatewayFields, buildCrowMessagesGatewayConfig, missingGatewayFields } from "./gateway-fields.js";
import { normalizeSkillName } from "../../../../../scripts/pi-bots/skill_proposals.mjs";
import { parseReadPathsInput } from "../../../../../scripts/pi-bots/bot-read-paths.mjs";
import { t, fill } from "../../shared/i18n.js";
import { applyFilesMode, applySourceModes, applyLearningMode, applyConfirm } from "./def-adapter.js";
import { applyCommandsMode } from "./bash-mode.js";
import { selectedWriteTools, toolsFromKeys } from "./sources.js";
import { normText } from "./ui.js";
import { lines } from "./data-queries.js";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const arr = (v) => (v == null ? [] : [].concat(v)).filter((x) => typeof x === "string");

// ---------------------------------------------------------------- basics

/**
 * Channel save. Returns { changed:boolean, warn?:string }. Nothing about the
 * channel is touched — no record rewrite, no device re-bind, no profile
 * write — unless a channel control changed (form snapshot, ui.js).
 */
async function saveChannel(def, b, { db, botId, changed }) {
  const gwType = String(b.gw_type || "").trim();
  if (!gwType) return { changed: false };
  if (changed.hasSnapshot && !changed("gw_type") && !changed.anyStartingWith("gw_")) return { changed: false };
  const prior = Array.isArray(def.gateways) ? def.gateways : [];
  const priorGw = prior[0] || null;
  const sameType = !!priorGw && (priorGw.type || "gmail") === gwType;
  // replace only the first record; keep any other records and, for the same
  // type, keys this editor does not show
  const put = (rec, owned = []) => {
    let merged = rec;
    if (sameType && rec) {
      merged = { ...priorGw, ...rec };
      for (const k of owned) if (!(k in rec)) delete merged[k];
      merged = JSON.parse(JSON.stringify(merged));
    }
    const next = rec ? [merged, ...prior.slice(1)] : prior.slice(1);
    if (same(next, prior)) return false;
    def.gateways = next;
    return true;
  };
  const simple = normalizeGatewayFields(gwType, b);
  if (simple) {
    if (simple.length === 0 && def.gateways === undefined) return { changed: false };
    return { changed: put(simple[0] || null) };
  }
  if (gwType === "crow-messages") return { changed: put(buildCrowMessagesGatewayConfig(b)) };
  if (gwType === "glasses") {
    const deviceId = String(b.gw_device_id || "").trim();
    const wasGlasses = priorGw && priorGw.type === "glasses";
    const priorDeviceId = wasGlasses && priorGw.device_id ? String(priorGw.device_id) : "";
    // The voice model lives in def.fast_voice_model only (Basics → Model); a
    // gw.fast_voice_model written by the old editor rides along untouched.
    const rec = { type: "glasses", ...(deviceId ? { device_id: deviceId } : {}) };
    const recChanged = put(rec, ["device_id"]);
    const bindChanged = recChanged || changed("gw_device_id") || changed("gw_type");
    const profileKeys = { gw_tts_profile_id: "tts_profile_id", gw_stt_profile_id: "stt_profile_id", gw_vision_profile_id: "vision_profile_id" };
    // Device-store effects run only after the definition write succeeded
    // (a refused save — stale page, engine gate, policy guard, compare-and-
    // swap — must change nothing, devices included).
    const after = async () => {
      const { updateDeviceProfiles, unbindBotFromOtherDevices } = await import("../../../../shared/device-store.js");
      if (deviceId) {
        const patch = {};
        for (const [field, col] of Object.entries(profileKeys)) {
          if (field in b && changed(field)) patch[col] = String(b[field] || "").trim();
        }
        if (bindChanged) {
          await unbindBotFromOtherDevices(db, botId, deviceId);
          if (priorDeviceId && priorDeviceId !== deviceId) await updateDeviceProfiles(db, priorDeviceId, { bound_bot_id: "" });
          patch.bound_bot_id = botId;
        }
        if (Object.keys(patch).length) await updateDeviceProfiles(db, deviceId, patch);
      } else if (priorDeviceId && bindChanged) {
        await updateDeviceProfiles(db, priorDeviceId, { bound_bot_id: "" });
      }
    };
    return { changed: recChanged, after, afterLabel: "device binding incomplete: " };
  }
  if (gwType === "companion") {
    let deviceId = String(b.gw_device_id || "").trim();
    let warn;
    let pairNew = null; // a kiosk to pair once the write succeeded
    const newKioskName = String(b.gw_new_kiosk_name || "").trim();
    if (!deviceId && newKioskName) {
      try {
        const { listDevices } = await import("../../../../shared/device-store.js");
        const baseId = ("kiosk-" + newKioskName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)).replace(/-$/, "") || "kiosk";
        const taken = new Set((await listDevices(db).catch(() => [])).map((d) => String(d.id)));
        let newId = baseId;
        for (let n = 2; taken.has(newId); n++) newId = `${baseId}-${n}`;
        pairNew = { id: newId, name: newKioskName, generation: "unknown", device_kind: "companion" };
        deviceId = newId;
      } catch (err) {
        warn = "could not create kiosk device: " + err.message;
      }
    }
    // Only the features whose control changed are written; everything else in
    // the stored features (hearing_style, voice_idle_timeout, an absent
    // face_tracking that means "on") stays exactly as stored.
    const on = (k) => b[k] === "on" || b[k] === "true";
    const priorFeatures = def.companion_features && typeof def.companion_features === "object" ? def.companion_features : {};
    const features = { ...priorFeatures };
    const fieldMap = { gw_avatar_animation: "avatar_animation", gw_pet_mode: "pet_mode", gw_social_chat: "social_chat",
      gw_memory_integration: "memory_integration", gw_face_tracking: "face_tracking" };
    const typeSwitched = !(priorGw && priorGw.type === "companion");
    for (const [field, key] of Object.entries(fieldMap)) {
      if (typeSwitched || changed(field)) features[key] = on(field);
    }
    if (typeSwitched || changed("gw_avatar_model")) {
      const v = String(b.gw_avatar_model || "").trim();
      if (v) features.avatar_model = v; else delete features.avatar_model;
    }
    const wasCompanion = priorGw && priorGw.type === "companion";
    const priorDeviceId = wasCompanion && priorGw.device_id ? String(priorGw.device_id) : "";
    const featuresChanged = !same(features, def.companion_features ?? (typeSwitched ? undefined : {}));
    const recChanged = put({ type: "companion", ...(deviceId ? { device_id: deviceId } : {}) }, ["device_id"]);
    if (!recChanged && !featuresChanged) return { changed: false, warn };
    if (featuresChanged) def.companion_features = features;
    const after = async () => {
      const { updateDeviceProfiles, unbindBotFromOtherDevices, pairDevice } = await import("../../../../shared/device-store.js");
      if (pairNew) await pairDevice(db, pairNew);
      if (deviceId) {
        if (recChanged) {
          await unbindBotFromOtherDevices(db, botId, deviceId);
          if (priorDeviceId && priorDeviceId !== deviceId) await updateDeviceProfiles(db, priorDeviceId, { bound_bot_id: "" });
        }
        await updateDeviceProfiles(db, deviceId, { ...(recChanged ? { bound_bot_id: botId, device_kind: "companion" } : {}), companion_features: def.companion_features });
      } else if (priorDeviceId) {
        await updateDeviceProfiles(db, priorDeviceId, { bound_bot_id: "" });
      }
    };
    return { changed: true, warn, after, afterLabel: "companion binding incomplete: " };
  }
  // a type this editor does not manage: leave the stored record alone
  return { changed: false };
}

export async function saveBasics(def, b, ctx) {
  const out = { warn: [], column: {} };
  const { lang, changed } = ctx;
  if (typeof b.display_name === "string" && changed("display_name")) {
    const name = b.display_name.trim().slice(0, 80);
    if (!name) return { error: t("botbuilder.bxNameRequired", lang) };
    if (name !== (ctx.row.display_name || "")) out.column.display_name = name;
  }
  if (typeof b.system_prompt === "string" && changed("system_prompt") && normText(b.system_prompt) !== normText(def.system_prompt)) {
    def.system_prompt = b.system_prompt.trim();
  }
  // Model pickers: only a changed picker writes; an empty choice means
  // "not set" (escalation / voice) or "instance default" (default model).
  let modelsTouched = false;
  const setModel = (field, get, set, del) => {
    if (typeof b[field] !== "string" || !changed(field)) return;
    const v = b[field].trim();
    if (v && v !== get()) { set(v); modelsTouched = true; }
    else if (!v && get() !== undefined) { del(); modelsTouched = true; }
  };
  const models = () => (def.models = def.models || {});
  setModel("model_default", () => def.models && def.models.default, (v) => { models().default = v; }, () => { delete models().default; });
  setModel("model_escalation", () => def.models && def.models.escalation, (v) => { models().escalation = v; }, () => { delete models().escalation; });
  setModel("fast_voice_model", () => def.fast_voice_model, (v) => { def.fast_voice_model = v; }, () => { delete def.fast_voice_model; });
  if (def.models && !Object.keys(def.models).length) delete def.models;
  if (modelsTouched) {
    try {
      const { opts } = await loadModelOptions(ctx.db);
      const valid = new Set(opts.map((o) => o.key));
      const bad = [def.models && def.models.default, def.models && def.models.escalation, def.fast_voice_model].filter((k) => k && !valid.has(k));
      if (bad.length) out.warn.push(fill(t("botbuilder.bxModelsUnavailable", lang), { models: bad.join(", ") }));
    } catch { /* validation never blocks a save */ }
  }
  const ch = await saveChannel(def, b, ctx);
  if (ch.warn) out.warn.push(ch.warn);
  out.channelChanged = ch.changed;
  if (ch.after) { out.after = ch.after; out.afterLabel = ch.afterLabel; }
  return out;
}

// ---------------------------------------------------------------- abilities

export function saveAbilities(def, b, { lang, changed }) {
  def.tools = def.tools || {};
  if (b.files_mode) {
    const r = applyFilesMode(def, { mode: String(b.files_mode), was: String(b.files_mode__was || "") });
    if (!r.ok) return { error: t("botbuilder.abInvalidChoice", lang) };
  }
  if (b.cmd_mode) {
    const r = applyCommandsMode(def, { mode: String(b.cmd_mode), was: String(b.cmd_mode__was || "") });
    if (!r.ok) return { error: t(r.reason === "mode_not_available" ? "botbuilder.abCmdNotAvailable" : "botbuilder.abInvalidChoice", lang) };
  }
  if (typeof b.src_catalog === "string") {
    let raw = {};
    try { raw = JSON.parse(b.src_catalog) || {}; } catch { raw = {}; }
    const catalog = {};
    for (const [server, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      catalog[server] = list.filter((x) => Array.isArray(x) && typeof x[0] === "string")
        .map(([name, access]) => ({ name, access: access === "read" ? "read" : "write" }));
    }
    const posted = {};
    for (const server of Object.keys(catalog)) {
      const mode = b[`src__${server}`];
      if (typeof mode !== "string") continue;
      if (!["off", "read", "all", "custom"].includes(mode)) return { error: t("botbuilder.abInvalidChoice", lang) };
      posted[server] = { mode, was: String(b[`src__${server}__was`] || ""), custom: arr(b[`tool__${server}`]) };
    }
    const before = Array.isArray(def.tools.crow_mcp) ? def.tools.crow_mcp : [];
    const next = applySourceModes(before, catalog, posted);
    if (!same(next, before) && !(def.tools.crow_mcp === undefined && next.length === 0)) def.tools.crow_mcp = next;
  }
  if (b.skills_rendered && changed("skills")) {
    const prev = Array.isArray(def.skills) ? def.skills : [];
    // a stored name is kept exactly as stored (case included: skill files are
    // looked up by name on a case-sensitive disk); only new names are normalised
    const norm = arr(b.skills).map((s) => (prev.includes(s) ? s : normalizeSkillName(s))).filter(Boolean);
    const setEq = norm.length === prev.length && norm.every((s) => prev.includes(s));
    if (!setEq) def.skills = [...new Set(norm)];
  }
  return {};
}

// ---------------------------------------------------------------- safety

export function saveSafety(def, b, { lang, changed }) {
  def.permission_policy = def.permission_policy || {};
  const pp = def.permission_policy;
  if (b.email_mode && b.email_mode !== b.email_mode__was) {
    if (b.email_mode !== "draft_only" && b.email_mode !== "allow") return { error: t("botbuilder.abInvalidChoice", lang) };
    pp.external_send = b.email_mode;
  }
  if (typeof b.pp_read_paths === "string" && changed("pp_read_paths")) {
    const rp = parseReadPathsInput(b.pp_read_paths);
    if (rp.invalid.length) return { error: fill(t("botbuilder.readPathsInvalid", lang), { paths: rp.invalid.join(", ") }) };
    const prev = Array.isArray(pp.read_paths) ? pp.read_paths : [];
    if (!same(rp.paths, prev)) pp.read_paths = rp.paths;
  }
  if (typeof b.pp_write_paths === "string" && changed("pp_write_paths")) {
    const next = lines(b.pp_write_paths);
    const prev = Array.isArray(pp.write_paths) ? pp.write_paths : [];
    if (!same(next, prev)) pp.write_paths = next;
  }
  if (b.confirm_rendered && (changed("confirm_tool") || changed("confirm_other"))) {
    // the tools the page offered (same classification the page used)
    let offered = null;
    try { offered = typeof b.confirm_offered === "string" ? JSON.parse(b.confirm_offered) : null; } catch { offered = null; }
    const tools = offered ? toolsFromKeys(offered, def) : selectedWriteTools(def);
    const prev = Array.isArray(pp.confirm) ? pp.confirm : [];
    const next = applyConfirm(prev, tools, { checked: arr(b.confirm_tool), otherText: b.confirm_other });
    if (!same(next, prev)) pp.confirm = next;
  }
  return {};
}

// ---------------------------------------------------------------- advanced

export async function saveAdvanced(def, b, { db, lang, remoteInvocationOn, row, changed }) {
  def.permission_policy = def.permission_policy || {};
  def.tools = def.tools || {};
  const sec = String(b.adv_section || "");
  if (sec === "learning") {
    const r = applyLearningMode(def.permission_policy, { mode: String(b.learn_mode || ""), was: String(b.learn_mode__was || "") });
    if (!r.ok) return { error: t("botbuilder.abInvalidChoice", lang) };
  } else if (sec === "helpers") {
    const now = b.multi_agent === "on" || b.multi_agent === "true";
    const was = b.multi_agent__was === "on";
    if (now !== was) def.permission_policy.multi_agent = now;
  } else if (sec === "commands") {
    const was = String(b.cmd_mode__was || "off");
    const wantList = b.cmd_list === "on" || b.cmd_list === "true";
    const mode = wantList ? "list" : (was === "list" ? "off" : was);
    const r = applyCommandsMode(def, { mode, was, allowText: typeof b.pp_bash_allow === "string" ? b.pp_bash_allow : undefined });
    if (!r.ok) return { error: t("botbuilder.abCmdNotAvailable", lang) };
  } else if (sec === "peers") {
    if (await remoteInvocationOn(db)) {
      const next = [...new Set(arr(b.remote_mcp).filter((x) => x.includes("::")))];
      const prev = Array.isArray(def.tools.remote_mcp) ? def.tools.remote_mcp : [];
      if (!same(next, prev)) def.tools.remote_mcp = next;
    }
  } else if (sec === "board") {
    // Only changed board controls write. An archived project or a deleted
    // custom board is rendered selected, so an untouched save keeps it.
    const out = { column: {} };
    if (changed("project_id")) {
      const cur = row && row.project_id != null ? Number(row.project_id) : null;
      const next = b.project_id ? Number(b.project_id) : null;
      if (next !== cur) out.column.project_id = next;
    }
    const tc = def.tracker_config && typeof def.tracker_config === "object" ? def.tracker_config : {};
    const curType = tc.type || "kanban";
    const typeChanged = changed("tracker_type") && String(b.tracker_type || curType) !== curType;
    const ttype = typeChanged ? String(b.tracker_type) : curType;
    if (!["kanban", "task-list", "custom", "none"].includes(ttype)) return { error: t("botbuilder.abInvalidChoice", lang) };
    const ntc = { ...tc };
    let dirty = false;
    if (typeChanged) { ntc.type = ttype; dirty = true; }
    if (ttype === "custom") {
      if (changed("tracker_slug")) { ntc.tracker_slug = String(b.tracker_slug || "").trim(); dirty = true; }
      if (changed("context_fields")) { ntc.context_fields = String(b.context_fields || "").split(",").map((x) => x.trim()).filter(Boolean); dirty = true; }
      if (changed("queue_filter_key") || changed("queue_filter_value")) {
        const qk = String(b.queue_filter_key || "").trim();
        const qv = String(b.queue_filter_value || "").trim();
        if (qk && qv) ntc.queue_filter = { [qk]: qv }; else delete ntc.queue_filter;
        dirty = true;
      }
    } else if (typeChanged) {
      delete ntc.tracker_slug; delete ntc.context_fields; delete ntc.queue_filter;
    }
    if (dirty && !same(ntc, tc)) def.tracker_config = ntc;
    return out;
  } else {
    return { error: t("botbuilder.abInvalidChoice", lang) };
  }
  return {};
}

export { missingGatewayFields };
