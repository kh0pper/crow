/**
 * Bot Builder — the Crow voice editor (PR 1). `?bot=crow.voice` renders this
 * page whatever `tab` says: the reserved voice bot answers every voice
 * surface and takes none of the generic Bot Builder actions (api-handlers.js
 * refuses them with voice_bot_readonly). Its two writes are its own:
 *
 *   voice_bot_save    the switch, model, escalation, persona and name, the Routine section (calendar, reminders, tasks, confirm),
 *                     speaking voice and speech recognition, memory tools
 *   voice_bot_preset  rebuild the model, escalation and the preset's tool
 *                     entries from voiceBotDefinition (Memory tools stay as
 *                     the operator set them); "Reset to preset"
 *                     also puts back the persona and the bare preset tool list
 *
 * Both are a compare-and-swap on the row the page showed (`rev`, voiceRev): a
 * stale page gets error=stale and writes nothing. Neither touches another
 * bot's row, a device record or a setting. Everything the saves do not own
 * (routine, handoff, migrated_from, permission_policy, the carried-over
 * tools) is kept as stored.
 *
 * The controls of both forms sit in one ordered page through the `form`
 * attribute, so the sections read in the order the operator thinks in. The
 * only script is the abilities line (voice-use.js): no strings in markup
 * scripts, no backticks, no dollar-brace.
 */
import { escapeHtml, section } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { t, fill } from "../../shared/i18n.js";
import { readSetting } from "../../settings/registry.js";
import { listProvidersAll } from "../../../../shared/providers-db.js";
import {
  CROW_VOICE_BOT_ID, VOICE_PRESETS, DEFAULT_PERSONA, voiceBotDefinition, normalizeVoiceSettings,
  ROUTINE_BACKENDS, CONFIRM_LEVELS,
} from "../../../../shared/voice-bot.js";
import { resolveRoutineBackends } from "../../../voice/own-tools.js";
import { connectedAddonToolNames, createToolExecutor } from "../../../ai/tool-executor.js";
import { loadModelOptions } from "./data-queries.js";
import { rowRev, defRev } from "./def-adapter.js";
import { emitBotDefsChanged } from "./defs-changed.js";
import { abilityLineHtml, voiceAbilityScript } from "./voice-use.js";
import { VOICE_EDITOR_HREF } from "./voice-bot-card.js";

const NAME_MAX = 40;
const PROMPT_MAX = 4000;
const ID_MAX = 200;
// The three memory selections the "Memory tools" switch adds back (the preset's own). Off removes
// EVERY crow-memory/ entry: any one of them keeps the memory category, and with it the whole
// crow_memory proxy (tool-executor.js).
const MEMORY_TOOLS = voiceBotDefinition({ preset: "fast_local", fastKey: "x/y" }).tools.crow_mcp.filter((x) => x.startsWith("crow-memory/"));
const isMemoryTool = (x) => x.startsWith("crow-memory/");

/** ?error= codes these saves give (the panel banner maps them to text: bot-builder.js). */
export const VOICE_ERROR_KEYS = {
  stale: "botbuilder.staleForm",
  voice_missing: "botbuilder.voiceErrMissing",
  voice_corrupt: "botbuilder.voiceErrCorrupt",
  voice_name_invalid: "botbuilder.voiceErrName",
  voice_prompt_too_long: "botbuilder.voiceErrPrompt",
  voice_model_invalid: "botbuilder.voiceErrModel",
  voice_profile_invalid: "botbuilder.voiceErrProfile",
  voice_escalation_invalid: "botbuilder.voiceErrEscalation",
  voice_preset_invalid: "botbuilder.voiceErrPreset",
  voice_cloud_model_required: "botbuilder.voiceErrCloudModel",
};

/**
 * The voice editor's revision of the row it showed: the generic rowRev (definition, name,
 * project) plus `enabled`, which this editor also writes, so a stale tab cannot flip the switch.
 */
export function voiceRev(row) {
  return defRev(rowRev(row) + "\u0000" + String(Number(row?.enabled) ? 1 : 0));
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const crowMcpOf = (def) => (Array.isArray(def?.tools?.crow_mcp) ? def.tools.crow_mcp.filter((x) => typeof x === "string" && x) : []);

async function loadVoiceRow(db) {
  try {
    return (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [CROW_VOICE_BOT_ID] })).rows[0] || null;
  } catch { return null; }
}
const parseDef = (row) => { try { const d = JSON.parse(row.definition || ""); return d && typeof d === "object" && !Array.isArray(d) ? d : null; } catch { return null; } };

/** The voice profiles of this instance ({ id, name }), from the settings the Kiosk and the voice turn read. */
async function loadProfiles(db, key) {
  try {
    const list = JSON.parse((await readSetting(db, key)) || "[]");
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && p.id).map((p) => ({ id: p.id, name: String(p.name || p.id) })) : [];
  } catch { return []; }
}

/** The compare-and-swap every voice write uses: lands only if the row still holds what the page showed (voiceRev's columns). */
async function casWrite(db, row, { definition, displayName = row.display_name, enabled = row.enabled }) {
  const r = await db.execute({
    sql: "UPDATE pi_bot_defs SET definition=?, display_name=?, enabled=?, updated_at=datetime('now') WHERE bot_id=? AND definition IS ? AND display_name IS ? AND project_id IS ? AND enabled = ?",
    args: [definition, displayName, Number(enabled) ? 1 : 0, CROW_VOICE_BOT_ID, row.definition ?? null, row.display_name ?? null, row.project_id ?? null, Number(row.enabled) ? 1 : 0],
  });
  return Number(r && r.rowsAffected) > 0;
}

const back = (res, q) => res.redirectAfterPost(`${VOICE_EDITOR_HREF}&${q}`);

/** Read the row and check the page's rev. → { row, def } or a redirect already sent (null). */
async function freshRow(req, res, db) {
  const row = await loadVoiceRow(db);
  const def = row ? parseDef(row) : null;
  if (!row) { back(res, "error=voice_missing"); return null; }
  if (!def) { back(res, "error=voice_corrupt"); return null; }
  const rev = (req.body || {}).rev;
  if (typeof rev !== "string" || !rev || rev !== voiceRev(row)) { back(res, "error=stale"); return null; }
  return { row, def };
}

/**
 * The Routine fields of the save, applied onto `next` (only voice.confirm and routine.* move). Every
 * field is optional: absent, or a value that is not allowed, keeps what is stored (an invalid confirm
 * never loosens). Ids are free text: trimmed, capped, and empty clears them. The project must exist.
 */
async function applyRoutine(db, b, def, next) {
  const cur = normalizeVoiceSettings(def);
  const pick = (v, allowed, stored) => (typeof v === "string" && allowed.includes(v) ? v : stored);
  const text = (v, stored) => (typeof v === "string" ? (Array.from(v.trim()).slice(0, ID_MAX).join("") || null) : stored);
  let projectId = cur.routine.tasks.project_id;
  const pv = b.routine_tasks_project_id;
  if (typeof pv === "string") {
    if (pv.trim() === "") projectId = null;
    else if (/^\d+$/.test(pv.trim())) {
      try {
        const id = Number(pv.trim());
        const r = await db.execute({ sql: "SELECT id FROM project_spaces WHERE id=?", args: [id] });
        if (r.rows[0]) projectId = id;
      } catch { /* keep the stored one */ }
    }
  }
  next.voice = { ...obj(next.voice), confirm: pick(b.confirm, CONFIRM_LEVELS, cur.confirm) };
  next.routine = {
    ...obj(def.routine),
    calendar: { ...obj(obj(def.routine).calendar), backend: pick(b.routine_calendar_backend, ROUTINE_BACKENDS.calendar, cur.routine.calendar.backend), calendar: text(b.routine_calendar_id, cur.routine.calendar.calendar) },
    reminders: { ...obj(obj(def.routine).reminders), backend: pick(b.routine_reminders_backend, ROUTINE_BACKENDS.reminders, cur.routine.reminders.backend) },
    tasks: { ...obj(obj(def.routine).tasks), backend: pick(b.routine_tasks_backend, ROUTINE_BACKENDS.tasks, cur.routine.tasks.backend), list: text(b.routine_tasks_list, cur.routine.tasks.list), project_id: projectId },
  };
}

export async function handleVoiceBotSave(req, res, { db }) {
  const b = req.body || {};
  const got = await freshRow(req, res, db);
  if (!got) return;
  const { row, def } = got;
  const name = String(b.display_name ?? "").trim();
  if (!name || Array.from(name).length > NAME_MAX) return back(res, "error=voice_name_invalid");
  const prompt = String(b.system_prompt ?? "").replace(/\r\n?/g, "\n");
  if (prompt.length > PROMPT_MAX) return back(res, "error=voice_prompt_too_long");
  const model = String(b.fast_voice_model ?? "").trim();
  const { opts } = await loadModelOptions(db);
  if (!opts.some((o) => o.key === model)) return back(res, "error=voice_model_invalid");
  const escalation = String(b.escalation ?? "");
  if (escalation !== "default" && escalation !== "off") return back(res, "error=voice_escalation_invalid");
  const profile = async (field, key) => {
    const v = String(b[field] ?? "");
    if (!v) return { ok: true, id: null };
    return (await loadProfiles(db, key)).some((p) => p.id === v) ? { ok: true, id: v } : { ok: false };
  };
  const tts = await profile("tts_profile_id", "tts_profiles");
  const stt = await profile("stt_profile_id", "stt_profiles");
  if (!tts.ok || !stt.ok) return back(res, "error=voice_profile_invalid");

  let tools = crowMcpOf(def);
  if (b.memory_tools === "on") { for (const m of MEMORY_TOOLS) if (!tools.includes(m)) tools.push(m); }
  else tools = tools.filter((x) => !isMemoryTool(x));
  const next = {
    ...def,
    fast_voice_model: model,
    system_prompt: prompt,
    voice: { ...obj(def.voice), escalation, tts_profile_id: tts.id, stt_profile_id: stt.id },
    tools: { ...obj(def.tools), crow_mcp: tools },
  };
  await applyRoutine(db, b, def, next);
  if (!(await casWrite(db, row, { definition: JSON.stringify(next), displayName: name, enabled: b.enabled === "on" ? 1 : 0 }))) return back(res, "error=stale");
  emitBotDefsChanged(CROW_VOICE_BOT_ID);
  return back(res, "saved=1");
}

export async function handleVoiceBotPreset(req, res, { db }) {
  const b = req.body || {};
  const preset = String(b.preset ?? "");
  if (!VOICE_PRESETS.includes(preset)) return back(res, "error=voice_preset_invalid");
  const got = await freshRow(req, res, db);
  if (!got) return;
  const { row, def } = got;
  let cloudKey = null;
  if (preset === "cloud") {
    cloudKey = String(b.cloud_model ?? "").trim();
    const { opts } = await loadModelOptions(db);
    if (!opts.some((o) => o.key === cloudKey)) return back(res, "error=voice_cloud_model_required");
  }
  // The quick local model the gateway routes voice turns to (the same key the boot-time create uses).
  const { VOICE_ROUTE_KEYS } = await import("../../../routes/llm-router.js");
  let base;
  try { base = voiceBotDefinition({ preset, fastKey: VOICE_ROUTE_KEYS.fast, cloudKey }); }
  catch { return back(res, "error=voice_cloud_model_required"); }
  const presetTools = base.tools.crow_mcp;
  const reset = b.reset === "1";
  // A preset switch keeps the tools the migration carried (entries beyond the preset list) and the
  // Memory tools switch as it stands (absent memory entries stay absent); Reset to preset
  // deliberately goes back to the bare preset list and the default persona.
  const current = crowMcpOf(def);
  const carried = current.filter((x) => !presetTools.includes(x));
  const memoryOff = !current.some(isMemoryTool);
  const rebuilt = memoryOff ? presetTools.filter((x) => !isMemoryTool(x)) : [...presetTools];
  const next = {
    ...def,
    preset: base.preset,
    fast_voice_model: base.fast_voice_model,
    voice: { ...obj(def.voice), escalation: base.voice.escalation },
    tools: { ...obj(def.tools), crow_mcp: reset ? [...presetTools] : [...rebuilt, ...carried] },
  };
  if (reset) next.system_prompt = DEFAULT_PERSONA;
  if (!(await casWrite(db, row, { definition: JSON.stringify(next) }))) return back(res, "error=stale");
  emitBotDefsChanged(CROW_VOICE_BOT_ID);
  return back(res, "saved=1");
}

// ---- the page ----

const opt = (value, label, selected) => `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;

function modelSelect(name, form, opts, current, { blank = false } = {}) {
  const byProv = {};
  for (const o of opts) (byProv[o.provider] = byProv[o.provider] || []).push(o);
  const known = opts.some((o) => o.key === current);
  return `<select name="${name}" id="btb-v-${name}" form="${form}">` +
    (blank || !known ? opt("", "—", !known) : "") +
    Object.keys(byProv).map((p) => `<optgroup label="${escapeHtml(p)}">` + byProv[p].map((o) => opt(o.key, o.label, o.key === current)).join("") + `</optgroup>`).join("") +
    `</select>`;
}

function profileSelect(name, profiles, current, lang) {
  const known = profiles.some((p) => p.id === current);
  return `<select name="${name}" id="btb-v-${name}" form="btb-vsave">` +
    opt("", t("botbuilder.voiceProfileDefault", lang), !known) +
    profiles.map((p) => opt(p.id, p.name, p.id === current)).join("") + `</select>`;
}

const RESOLVED_KEY = { workspace: "botbuilder.voiceRoutineWorkspace", google: "botbuilder.voiceRoutineGoogle", crow: "botbuilder.voiceRoutineCrow", board: "botbuilder.voiceRoutineBoard" };

/** How long the editor waits for a Workspace listing before it renders without one. */
const LIST_WAIT_MS = 4000;
/** The Workspace calendars or task lists ({ id, name, owner, writable, shared }), or null when they can't be read now. */
async function listWorkspace(tool, key) {
  let ex = null;
  try {
    ex = createToolExecutor();
    const call = ex.executeToolCalls([{ id: "editor-" + tool, name: tool, arguments: {} }]);
    const [r] = await Promise.race([call, new Promise((res) => { const t = setTimeout(() => res([null]), LIST_WAIT_MS); t.unref?.(); })]);
    if (!r || r.isError) return null;
    const body = JSON.parse(String(r.result));
    const items = body?.success === true ? body.data?.[key] : null;
    return Array.isArray(items) ? items.filter((x) => x && typeof x.id === "string" && x.id) : null;
  } catch { return null; } finally { try { await ex?.close?.(); } catch {} }
}

/**
 * Where an unchosen "auto"/"workspace" add really goes, from the listing (own-tools.js resolveTarget, PR 2.1 Task 6):
 * Crow's own (shared === false; a missing field counts as shared) → as resolved; else calendar auto with Google → google,
 * task auto → board; else "ask". Unchanged when nothing is listed or an id is chosen.
 */
function effectiveRoutine(resolved, kind, chosen, auto, items, conn) {
  const r = resolved[kind];
  if (r !== "workspace" || chosen || !items) return r;
  if (items.some((x) => x.writable === true && x.shared === false)) return r;
  if (auto && kind === "calendar" && conn.has("gcal_create_event")) return "google";
  if (auto && kind === "tasks") return "board";
  return "ask";
}

/** The Routine section: where Crow's own calendar, reminder and task tools write, and how often it asks. */
async function routineSection(db, v, lang, sec, hint) {
  const conn = connectedAddonToolNames();
  const resolved = resolveRoutineBackends(v, conn);
  const cals = resolved.calendar === "workspace" && conn.has("ws_cal_list_calendars") ? await listWorkspace("ws_cal_list_calendars", "calendars") : null;
  const lists = resolved.tasks === "workspace" && conn.has("ws_tasks_list_lists") ? await listWorkspace("ws_tasks_list_lists", "lists") : null;
  const calNow = effectiveRoutine(resolved, "calendar", v.routine.calendar.calendar, v.routine.calendar.backend === "auto", cals, conn);
  const taskNow = effectiveRoutine(resolved, "tasks", v.routine.tasks.list, v.routine.tasks.backend === "auto", lists, conn);
  // Each writable one, marked "yours" (Crow bot's own) or "shared by <owner>".
  const whose = (items, keys) => {
    const rows = (items || []).filter((x) => x.writable === true);
    if (!rows.length) return "";
    return `<p class="btb-hint">${escapeHtml(t(keys.head, lang))}</p><ul class="btb-hint">` + rows.map((x) => {
      const mark = x.shared === false ? t(keys.yours, lang) : x.owner ? fill(t(keys.by, lang), { owner: String(x.owner) }) : t(keys.unknown, lang);
      return `<li>${escapeHtml(String(x.name || x.id))} (${escapeHtml(x.id)}): ${escapeHtml(mark)}</li>`;
    }).join("") + `</ul>`;
  };
  const calWhose = whose(cals, { head: "botbuilder.voiceRoutineCalendarsHere", yours: "botbuilder.voiceRoutineYoursCal", by: "botbuilder.voiceRoutineSharedBy", unknown: "botbuilder.voiceRoutineSharedUnknown" });
  const listWhose = whose(lists, { head: "botbuilder.voiceRoutineListsHere", yours: "botbuilder.voiceRoutineYoursList", by: "botbuilder.voiceRoutineSharedListBy", unknown: "botbuilder.voiceRoutineSharedListUnknown" });
  const nowLine = (r) => `<p class="btb-hint">${escapeHtml(fill(t("botbuilder.voiceRoutineNow", lang), { backend: t(RESOLVED_KEY[r] || "botbuilder.voiceRoutineNone", lang) }))}</p>`;
  const optLabel = { auto: "botbuilder.voiceRoutineAuto", off: "botbuilder.voiceRoutineOff", workspace: "botbuilder.voiceRoutineOptWorkspace", google: "botbuilder.voiceRoutineOptGoogle", crow: "botbuilder.voiceRoutineOptCrow", board: "botbuilder.voiceRoutineOptBoard" };
  const select = (name, list, cur) => `<select name="${name}" id="btb-v-${name}" form="btb-vsave">` + list.map((x) => opt(x, t(optLabel[x], lang), x === cur)).join("") + `</select>`;
  const textIn = (name, labelKey, val) => `<label for="btb-v-${name}">${escapeHtml(t(labelKey, lang))}</label>` +
    `<input type="text" id="btb-v-${name}" name="${name}" form="btb-vsave" maxlength="${ID_MAX}" value="${escapeHtml(val || "")}">`;
  let projects = [];
  try { projects = (await db.execute({ sql: "SELECT id, name FROM project_spaces WHERE archived_at IS NULL ORDER BY id", args: [] })).rows; } catch { projects = []; }
  const curProject = v.routine.tasks.project_id;
  const projOpts = opt("", t("botbuilder.voiceRoutineProjectNone", lang), curProject == null) +
    (curProject != null && !projects.some((p) => String(p.id) === String(curProject)) ? opt(String(curProject), "#" + curProject, true) : "") +
    projects.map((p) => opt(String(p.id), String(p.name || "#" + p.id), String(p.id) === String(curProject))).join("");
  const label = (id, key) => `<label for="btb-v-${id}">${escapeHtml(t(key, lang))}</label>`;
  return sec("botbuilder.voiceRoutineTitle",
    hint("botbuilder.voiceRoutineWritesWhere") +
    label("routine_calendar_backend", "botbuilder.voiceRoutineCalendar") + select("routine_calendar_backend", ROUTINE_BACKENDS.calendar, v.routine.calendar.backend) +
    (calNow === "ask" ? nowLine(resolved.calendar) + hint("botbuilder.voiceRoutineWillAskCalendar") : nowLine(calNow)) + calWhose +
    // The reminder offer exists only while reminders resolve somewhere; with them off, say a calendar event can't be added.
    (resolved.calendar ? "" : hint(resolved.reminders ? "botbuilder.voiceRoutineNoCalendar" : "botbuilder.voiceRoutineNoCalendarNoReminder")) +
    textIn("routine_calendar_id", "botbuilder.voiceRoutineCalendarId", v.routine.calendar.calendar) +
    label("routine_reminders_backend", "botbuilder.voiceRoutineReminders") + select("routine_reminders_backend", ROUTINE_BACKENDS.reminders, v.routine.reminders.backend) + nowLine(resolved.reminders) +
    label("routine_tasks_backend", "botbuilder.voiceRoutineTasks") + select("routine_tasks_backend", ROUTINE_BACKENDS.tasks, v.routine.tasks.backend) +
    (taskNow === "ask" ? nowLine(resolved.tasks) + hint("botbuilder.voiceRoutineWillAskList") : nowLine(taskNow)) + listWhose +
    textIn("routine_tasks_list", "botbuilder.voiceRoutineTaskList", v.routine.tasks.list) +
    label("routine_tasks_project_id", "botbuilder.voiceRoutineProject") + `<select name="routine_tasks_project_id" id="btb-v-routine_tasks_project_id" form="btb-vsave">${projOpts}</select>` +
    label("confirm", "botbuilder.voiceRoutineConfirm") +
    `<select name="confirm" id="btb-v-confirm" form="btb-vsave">` + opt("standard", t("botbuilder.voiceConfirmStandard", lang), v.confirm === "standard") + opt("strict", t("botbuilder.voiceConfirmStrict", lang), v.confirm === "strict") + `</select>`);
}

export async function renderVoiceBotEditor(req, res, { db, layout, lang = "en", PAGE_CSS = "", notice = "", kioskAvailable = false }) {
  const backLink = `<p><a href="/dashboard/bot-builder">&larr; ${t("botbuilder.noticeAllBots", lang)}</a></p>`;
  const row = await loadVoiceRow(db);
  const def = row ? parseDef(row) : null;
  if (!row || !def) {
    // A row that is there but can't be read is kept as it is (ensureVoiceBot never rewrites it).
    const key = row ? "botbuilder.voiceErrCorrupt" : "botbuilder.voiceErrMissing";
    return res.send(layout({
      title: "Bot Builder",
      content: PAGE_CSS + section(t("botbuilder.voiceEditorTitle", lang), backLink + notice + `<p>${escapeHtml(t(key, lang))}</p>`),
    }));
  }
  const v = normalizeVoiceSettings(def);
  const rev = voiceRev(row);
  const { opts } = await loadModelOptions(db);
  let providerRows = [];
  try { providerRows = await listProvidersAll(db); } catch { providerRows = []; }
  const ttsProfiles = await loadProfiles(db, "tts_profiles");
  const sttProfiles = await loadProfiles(db, "stt_profiles");
  const model = v.fast_voice_model || "";
  const provId = model.includes("/") ? model.slice(0, model.indexOf("/")) : "";
  const provRow = providerRows.find((p) => p && p.id === provId);
  const cloud = !!provRow && provRow.host === "cloud";
  const memoryOn = crowMcpOf(def).some(isMemoryTool);
  const name = row.display_name || "Crow";
  const sec = (key, body) => `<div class="btb-vsec"><h3>${escapeHtml(t(key, lang))}</h3>${body}</div>`;
  const hint = (key) => `<p class="btb-hint">${escapeHtml(t(key, lang))}</p>`;
  const hidden = (action) => `<input type="hidden" name="action" value="${action}">` +
    `<input type="hidden" name="bot_id" value="${escapeHtml(CROW_VOICE_BOT_ID)}">` +
    `<input type="hidden" name="rev" value="${rev}">${csrfInput(req)}`;

  const forms = `<form method="POST" action="/dashboard/bot-builder" id="btb-vsave">${hidden("voice_bot_save")}</form>` +
    `<form method="POST" action="/dashboard/bot-builder" id="btb-vpreset">${hidden("voice_bot_preset")}</form>`;

  const onSec = sec("botbuilder.voiceOnTitle",
    `<label class="btb-vcheck"><input type="checkbox" name="enabled" value="on" form="btb-vsave"${Number(row.enabled) ? " checked" : ""}> ` +
    `${escapeHtml(t("botbuilder.voiceOnTitle", lang))}</label>` + hint("botbuilder.voiceOnHint"));

  const presetCard = (id, labelKey, hintKey) =>
    `<label class="btb-vpreset"><input type="radio" name="preset" value="${id}" form="btb-vpreset"${v.preset === id ? " checked" : ""}>` +
    `<span><b>${escapeHtml(t(labelKey, lang))}</b><small>${escapeHtml(t(hintKey, lang))}</small></span></label>`;
  const presetSec = sec("botbuilder.voicePresetTitle",
    `<div class="btb-vpresets">` + presetCard("fast_local", "botbuilder.voicePresetFast", "botbuilder.voicePresetFastHint") +
    presetCard("cloud", "botbuilder.voicePresetCloud", "botbuilder.voicePresetCloudHint") + `</div>` +
    `<label for="btb-v-cloud_model">${escapeHtml(t("botbuilder.voicePresetCloudModel", lang))}</label>` +
    modelSelect("cloud_model", "btb-vpreset", opts, v.preset === "cloud" ? model : "", { blank: true }) +
    `<p><button type="submit" class="btn btn-secondary btn-sm" form="btb-vpreset">${escapeHtml(t("botbuilder.voicePresetApply", lang))}</button> ` +
    `<button type="submit" class="btn btn-secondary btn-sm" form="btb-vpreset" name="reset" value="1">${escapeHtml(t("botbuilder.voicePresetReset", lang))}</button></p>` +
    hint("botbuilder.voicePresetResetHint"));

  const cloudWarn = cloud
    ? `<p class="btb-notice-warn">${escapeHtml(t("botbuilder.voiceCloudSlower", lang))}</p>` +
      `<p class="btb-notice-warn">${escapeHtml(fill(t("botbuilder.voiceCloudLeaves", lang), { provider: provId }))}</p>`
    : "";
  const modelSec = sec("botbuilder.voiceModelTitle",
    `<label for="btb-v-fast_voice_model">${escapeHtml(t("botbuilder.voiceFastModel", lang))}</label>` +
    modelSelect("fast_voice_model", "btb-vsave", opts, model) +
    `<label for="btb-v-escalation">${escapeHtml(t("botbuilder.voiceEscTitle", lang))}</label>` +
    `<select name="escalation" id="btb-v-escalation" form="btb-vsave">` +
    opt("default", t("botbuilder.voiceEscDefault", lang), v.escalation === "default") +
    opt("off", t("botbuilder.voiceEscOff", lang), v.escalation === "off") + `</select>` + cloudWarn);

  const personaSec = sec("botbuilder.voicePersonaTitle",
    `<label for="btb-v-name">${escapeHtml(t("botbuilder.voiceName", lang))}</label>` +
    `<input type="text" id="btb-v-name" name="display_name" form="btb-vsave" required maxlength="${NAME_MAX}" value="${escapeHtml(name)}">` +
    `<label for="btb-v-prompt">${escapeHtml(t("botbuilder.voicePrompt", lang))}</label>` +
    `<textarea id="btb-v-prompt" name="system_prompt" form="btb-vsave" rows="6" maxlength="${PROMPT_MAX}">${escapeHtml(typeof def.system_prompt === "string" ? def.system_prompt : "")}</textarea>`);

  const ttsSec = sec("botbuilder.voiceTtsTitle", profileSelect("tts_profile_id", ttsProfiles, v.tts_profile_id, lang));
  const sttSec = sec("botbuilder.voiceSttTitle", profileSelect("stt_profile_id", sttProfiles, v.stt_profile_id, lang));
  const memSec = sec("botbuilder.voiceMemoryTitle",
    `<label class="btb-vcheck"><input type="checkbox" name="memory_tools" value="on" form="btb-vsave"${memoryOn ? " checked" : ""}> ` +
    `${escapeHtml(t("botbuilder.voiceMemoryLabel", lang))}</label>`);
  const routineSec = await routineSection(db, v, lang, sec, hint);
  const saveBar = `<p><button type="submit" class="btn btn-primary" form="btb-vsave">${escapeHtml(t("common.save", lang))}</button></p>`;
  const abilSec = kioskAvailable ? sec("botbuilder.voiceAbilTitle", abilityLineHtml(CROW_VOICE_BOT_ID)) + voiceAbilityScript(lang) : "";

  return res.send(layout({
    title: "Bot Builder — " + name,
    content: PAGE_CSS + section(t("botbuilder.voiceEditorTitle", lang),
      backLink + notice + `<p>${escapeHtml(t("botbuilder.voiceEditorIntro", lang))}</p>` + forms +
      onSec + presetSec + modelSec + personaSec + ttsSec + sttSec + memSec + routineSec + saveBar + abilSec),
  }));
}
