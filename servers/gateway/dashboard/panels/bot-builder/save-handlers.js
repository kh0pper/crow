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
import { loadModelOptions, loadRoleRefs } from "./data-queries.js";
import { normalizeGatewayFields, buildCrowMessagesGatewayConfig, missingGatewayFields } from "./gateway-fields.js";
import { normalizeSkillName } from "../../../../../scripts/pi-bots/skill_proposals.mjs";
import { parseReadPathsInput } from "../../../../../scripts/pi-bots/bot-read-paths.mjs";
import { t, fill } from "../../shared/i18n.js";
import { applyFilesMode, applySourceModes, applyLearningMode, applyConfirm } from "./def-adapter.js";
import { applyCommandsMode } from "./bash-mode.js";
import { selectedWriteTools, toolsFromKeys } from "./sources.js";
import { normText } from "./ui.js";
import { oneLine } from "../../shared/bot-display.js";
import { lines } from "./data-queries.js";
import { addCompanionsGuarded, grantsArtifactUpdate } from "../../../../../scripts/pi-bots/artifacts-companions.mjs";
import { skillRequiredTools, skillDeclaredRepoTools, withSkillRequiredTools, addSkillToolsGuarded, unionMayGrant } from "../../../../../scripts/pi-bots/skill-tools.mjs";
import { isVoiceBotDef } from "../../../../shared/voice-bot.js";
import { resolveCrowHome } from "../../../../shared/crow-home.js";

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
    // Retired: glasses answer as Crow, so a glasses save binds nothing and writes no device. A stored glasses
    // record is kept exactly as it is (it renders read-only); only a type switch replaces it, above.
    return { changed: false };
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
  // "What it's for": one clean line Crow reads when it picks a bot to hand work to; "" removes it.
  if (typeof b.bot_description === "string" && changed("bot_description")) {
    const v = oneLine(b.bot_description, 140);
    if (v && v !== def.description) def.description = v;
    else if (!v && def.description !== undefined) delete def.description;
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
      const roles = await loadRoleRefs(ctx.db);
      const bad = [def.models && def.models.default, def.models && def.models.escalation, def.fast_voice_model].filter((k) => k && !valid.has(k) && !roles.known(k));
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

export async function saveAbilities(def, b, { lang, changed, companionBudget = null, crowHome = undefined, repoSkillsDir = undefined }) {
  const out = {};
  const prevMcp = def.tools && Array.isArray(def.tools.crow_mcp) ? def.tools.crow_mcp.slice() : [];
  const prevHadMcp = !!(def.tools && Array.isArray(def.tools.crow_mcp));
  const prevSkills = Array.isArray(def.skills) ? def.skills.slice() : [];
  // what the services card was rendered from (tab-abilities.js): the stored
  // list plus the repo skills' tools, unless the model's cap refused them
  const home = crowHome || resolveCrowHome();
  const skillOpts = { crowHome: home, repoSkillsDir };
  const budgetFor = async (d) => (companionBudget ? await companionBudget(d) : null);
  const voice = isVoiceBotDef(def);
  // A failure here (a model that cannot be resolved, an unreadable skill)
  // must not fail an unrelated Abilities save: carry on without the union.
  let priorRefused = false, skillToolsBroken = false;
  if (!voice) {
    try { priorRefused = (await addSkillToolsGuarded(def, { ...skillOpts, budget: await budgetFor(def) })).refused; }
    catch (e) { skillToolsBroken = true; console.warn("[bot-builder] skill tools skipped on save: " + ((e && e.message) || e)); }
  }
  let posted = null, catalog = null;
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
    catalog = {};
    for (const [server, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      catalog[server] = list.filter((x) => Array.isArray(x) && typeof x[0] === "string")
        .map(([name, access]) => ({ name, access: access === "read" ? "read" : "write" }));
    }
    posted = {};
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
  // S2a (artifacts smoke fixes, review M7): a def granting artifact_update
  // also gets artifact_find + artifact_attach (the needs_link recovery path),
  // written into the def itself — but never past the model's tool cap, and
  // ONLY when Update goes from off to on in this save (PR review 2): once
  // Update is granted, the owner's own ticks rule, so a deliberate untick of
  // Find or Attach is never silently undone. Ticked companions are posted
  // like any tool, so explicit entries survive a save and unticking Update
  // never removes them.
  if (Array.isArray(def.tools.crow_mcp) && !grantsArtifactUpdate(prevMcp) && grantsArtifactUpdate(def.tools.crow_mcp)) {
    const r = await addCompanionsGuarded(def, { budget: companionBudget ? await companionBudget(def) : null });
    if (r.refused) out.warn = [t("botbuilder.abArtifactsCompanionsCapped", lang)];
    else if (r.added.length) def.tools.crow_mcp = r.def.tools.crow_mcp;
  }
  if (b.skills_rendered && changed("skills")) {
    const prev = Array.isArray(def.skills) ? def.skills : [];
    // a stored name is kept exactly as stored (case included: skill files are
    // looked up by name on a case-sensitive disk); only new names are normalised
    const norm = arr(b.skills).map((s) => (prev.includes(s) ? s : normalizeSkillName(s))).filter(Boolean);
    const setEq = norm.length === prev.length && norm.every((s) => prev.includes(s));
    if (!setEq) def.skills = [...new Set(norm)];
  }
  if (!voice && !skillToolsBroken) {
    // work on a copy of tools so a throw half-way leaves the save as the owner posted it
    const tools0 = JSON.parse(JSON.stringify(def.tools));
    try { await applySkillTools(def, { prevMcp, prevHadMcp, prevSkills, posted, catalog, priorRefused, skillOpts, budgetFor, lang, out }); }
    catch (e) { def.tools = tools0; console.warn("[bot-builder] skill tools skipped on save: " + ((e && e.message) || e)); }
  }
  return out;
}

/** Was `entry` ticked in the posted services row (per its mode)? null = the row could not show it. */
function tickedInPost(entry, posted, catalog) {
  const [server, tool] = entry.split("/");
  const p = posted && posted[server];
  const cat = catalog && catalog[server];
  if (!p || !cat) return null;
  const item = cat.find((x) => x.name === tool);
  if (!item) return null;
  if (p.mode === "custom") return p.custom.includes(entry);
  if (p.mode === "all") return true;
  if (p.mode === "read") return item.access === "read";
  return false;
}

/**
 * A selected repo skill's declared tools (skill-tools.mjs), after the skills
 * block so it sees the final def.skills:
 *  - a skill kept from before: each required tool the posted services row left
 *    unticked goes into tools.skill_tools_declined, each ticked one leaves it.
 *    Ticked ones stay OUT of crow_mcp when only the union put them on the page
 *    (the union keeps granting them), so an untouched save is byte-identical
 *    and the mode the owner stored is not rewritten.
 *  - a skill newly selected: its tools are written into crow_mcp (cap-guarded,
 *    abSkillToolsCapped when they do not fit); no declines.
 *  - a dropped skill: its declines are cleared.
 * The services card not posted, or the page rendered over the cap: declines stay.
 */
async function applySkillTools(def, { prevMcp, prevHadMcp, prevSkills, posted, catalog, priorRefused, skillOpts, budgetFor, lang, out }) {
  const finalSkills = Array.isArray(def.skills) ? def.skills : [];
  const kept = finalSkills.filter((s) => prevSkills.includes(s));
  const added = finalSkills.filter((s) => !prevSkills.includes(s));
  const dropped = prevSkills.filter((s) => !finalSkills.includes(s));
  const prevDeclined = Array.isArray(def.tools.skill_tools_declined) ? def.tools.skill_tools_declined.filter((x) => typeof x === "string") : [];
  const declined = new Set(prevDeclined);
  const keptReq = [...new Set(kept.flatMap((s) => skillRequiredTools(s, skillOpts)))];
  const finalReq = new Set(finalSkills.flatMap((s) => skillDeclaredRepoTools(s, skillOpts)));
  let mcp = Array.isArray(def.tools.crow_mcp) ? def.tools.crow_mcp.slice() : [];

  if (posted && !priorRefused) {
    for (const entry of keptReq) {
      const [server] = entry.split("/");
      if (mcp.includes(server)) continue; // a whole-server grant: nothing to decline
      const on = tickedInPost(entry, posted, catalog);
      if (on === true) declined.delete(entry);
      // unticked counts as a decline only where the union would grant it
      // (a source left in Read-only mode is not declining its write tools)
      else if (on === false && unionMayGrant(mcp, entry)) declined.add(entry);
    }
  }
  for (const s of dropped) for (const entry of skillDeclaredRepoTools(s, skillOpts)) if (!finalReq.has(entry)) declined.delete(entry);
  // Ticked only because the union put them on the page: the union keeps
  // granting them, so they stay out of the stored list. Never when the page
  // was rendered over the cap (the union showed nothing, so a tick there is
  // the owner's own), and only where the union still grants it afterwards.
  const shown = priorRefused ? [] : withSkillRequiredTools(prevMcp, kept, { ...skillOpts, declined: prevDeclined }).added;
  const strip = shown.filter((e) => !declined.has(e) && mcp.includes(e) && !prevMcp.includes(e));
  if (strip.length) {
    const without = mcp.filter((x) => !strip.includes(x));
    const back = new Set(withSkillRequiredTools(without, kept, { ...skillOpts, declined: [...declined] }).added);
    mcp = mcp.filter((x) => !strip.includes(x) || !back.has(x));
  }
  if (added.length) {
    const r = withSkillRequiredTools(mcp, added, { ...skillOpts, declined: [...declined] });
    if (r.added.length) {
      const full = withSkillRequiredTools(r.list, kept, { ...skillOpts, declined: [...declined] }).list;
      const candidate = { ...def, tools: { ...def.tools, crow_mcp: full } };
      const b = (await budgetFor(def)) || (await (await import("../../../../../scripts/pi-bots/artifacts-companions.mjs")).defaultCompanionBudget(def));
      if (Number.isInteger(b.cap) && b.cap > 0 && b.countFor(candidate) > b.cap) {
        out.warn = [...(out.warn || []), t("botbuilder.abSkillToolsCapped", lang)];
      } else mcp = r.list;
    }
  }
  // same set as stored: keep the stored array (and its order) exactly
  if (prevHadMcp && mcp.length === prevMcp.length && mcp.every((x) => prevMcp.includes(x))) def.tools.crow_mcp = prevMcp;
  else if (prevHadMcp || mcp.length || Array.isArray(def.tools.crow_mcp)) def.tools.crow_mcp = mcp;
  const nextDeclined = [...declined].sort();
  if (!same(nextDeclined, [...prevDeclined].sort())) {
    if (nextDeclined.length) def.tools.skill_tools_declined = nextDeclined;
    else delete def.tools.skill_tools_declined;
  }
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
