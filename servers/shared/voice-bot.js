/**
 * The reserved Crow voice bot: definition, presets and settings normalization,
 * plus ensureVoiceBot (the one-time boot create). The module imports nothing;
 * ensureVoiceBot does its I/O through the db client and readers it is handed.
 */

export const CROW_VOICE_BOT_ID = "crow.voice";
export const VOICE_PRESETS = ["fast_local", "cloud"];
export const CONFIRM_LEVELS = ["standard", "strict"];
export const ROUTINE_BACKENDS = {
  calendar: ["auto", "workspace", "google", "off"],
  reminders: ["auto", "crow", "off"],
  tasks: ["auto", "workspace", "board", "off"],
};

/** Tools the voice bot never gets: bot-to-bot work and schedules belong to the handoff, not to a voice turn. */
export const VOICE_DENY_TOOLS = Object.freeze([
  "crow_delegate", "crow_job_status", "crow_schedule_bot",
  "crow_list_bot_schedules", "crow_delete_bot_schedule", "crow_discover",
]);

export const DEFAULT_PERSONA =
  "You are Crow, the user's voice assistant. Answer in one or two short spoken sentences, in the user's language. " +
  "Use your own tools for calendar events, reminders and tasks. Bigger work (research, documents, automations) goes " +
  "to one of the user's bots; never do that work yourself, and never say a bot has started: the server says that.";

const FAST_LOCAL_CROW_MCP = [
  "crow-memory/crow_store_memory",
  "crow-memory/crow_search_memories",
  "crow-memory/crow_recall_by_context",
  "funkwhale/fw_search",
  "funkwhale/fw_play",
  "funkwhale/fw_play_album",
  "funkwhale/fw_pause",
  "funkwhale/fw_resume",
  "funkwhale/fw_next_track",
  "funkwhale/fw_stop_playback",
  "funkwhale/fw_now_playing",
  "media/crow_media_briefing",
  "media/crow_media_listen",
];

export const isVoiceBotId = (id) => id === CROW_VOICE_BOT_ID;
export const isVoiceBotDef = (def) => def?.kind === "voice";

export function voiceBotDefinition({ preset, fastKey, cloudKey = null, migratedFrom = null }) {
  if (!VOICE_PRESETS.includes(preset)) throw new Error("unknown_voice_preset");
  if (preset === "cloud" && !cloudKey) throw new Error("cloud_model_required");
  const def = {
    kind: "voice",
    engine: "voice",
    preset,
    gateways: [],
    tracker_config: { type: "none" },
    fast_voice_model: preset === "cloud" ? cloudKey : fastKey,
    system_prompt: DEFAULT_PERSONA,
    skills: [],
    tools: { pi_builtin: [], crow_mcp: [...FAST_LOCAL_CROW_MCP] },
    permission_policy: {
      bash: "deny", bash_allow: [], write_paths: [], external_send: "draft_only",
      confirm: [], deny: [], self_authoring: false, skill_learning: "off",
    },
    voice: {
      escalation: preset === "cloud" ? "off" : "default",
      tts_profile_id: null, stt_profile_id: null, confirm: "standard",
      // Opt-in troubleshooting view (voice/transcript-buffer.js): in memory only, off unless explicitly true.
      transcript_buffer: false,
      // Opt-in one-week log of what STT heard (voice/transcript-log.js): on this instance's disk only, off unless explicitly true.
      transcript_log: false,
    },
    routine: {
      calendar: { backend: "auto", calendar: null },
      reminders: { backend: "auto" },
      tasks: { backend: "auto", list: null, project_id: null },
    },
    handoff: { enabled: true, allowed_bots: [] },
  };
  if (migratedFrom) def.migrated_from = migratedFrom;
  return def;
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const nonEmptyStr = (v) => (typeof v === "string" && v.length > 0 ? v : null);

export function normalizeVoiceSettings(def) {
  const d = obj(def);
  const voice = obj(d.voice);
  const routine = obj(d.routine);
  const cal = obj(routine.calendar);
  const rem = obj(routine.reminders);
  const tasks = obj(routine.tasks);
  const handoff = obj(d.handoff);
  const projectId = typeof tasks.project_id === "number" && Number.isFinite(tasks.project_id)
    ? tasks.project_id : nonEmptyStr(tasks.project_id);
  return {
    preset: oneOf(d.preset, VOICE_PRESETS, "fast_local"),
    fast_voice_model: nonEmptyStr(d.fast_voice_model),
    escalation: oneOf(voice.escalation, ["default", "off"], "default"),
    tts_profile_id: nonEmptyStr(voice.tts_profile_id),
    stt_profile_id: nonEmptyStr(voice.stt_profile_id),
    confirm: oneOf(voice.confirm, CONFIRM_LEVELS, "standard"),
    transcript_buffer: voice.transcript_buffer === true,
    transcript_log: voice.transcript_log === true,
    routine: {
      calendar: { backend: oneOf(cal.backend, ROUTINE_BACKENDS.calendar, "auto"), calendar: nonEmptyStr(cal.calendar) },
      reminders: { backend: oneOf(rem.backend, ROUTINE_BACKENDS.reminders, "auto") },
      tasks: {
        backend: oneOf(tasks.backend, ROUTINE_BACKENDS.tasks, "auto"),
        list: nonEmptyStr(tasks.list),
        project_id: projectId,
      },
    },
    handoff: {
      enabled: typeof handoff.enabled === "boolean" ? handoff.enabled : true,
      allowed_bots: Array.isArray(handoff.allowed_bots) && handoff.allowed_bots.every((b) => typeof b === "string" && b)
        ? [...handoff.allowed_bots] : [],
    },
  };
}

const SESSION_BOT_SETTING = "kiosk_dashboard_bot_id";

const parseDef = (text) => { try { const d = JSON.parse(text); return d && typeof d === "object" ? d : null; } catch { return null; } };
const toolName = (entry) => String(entry).slice(String(entry).lastIndexOf("/") + 1);
const deniedTool = (entry) => { const n = toolName(entry); return VOICE_DENY_TOOLS.includes(n) || n.startsWith("crow_glasses_"); };
const crowMcpOf = (def) => (Array.isArray(def?.tools?.crow_mcp) ? def.tools.crow_mcp.filter((t) => typeof t === "string" && t) : []);
const policyList = (def, key) => (Array.isArray(def?.permission_policy?.[key]) ? def.permission_policy[key].filter((e) => typeof e === "string" && e) : []);
/**
 * Does a permission_policy deny/confirm entry name this "server/tool" entry?
 * Exact names only (neither runtime has wildcards): the voice turn matches the
 * bare tool name and its crow_-prefixed form (turn.js), pi matches
 * mcp__<server>__<tool> (Bot Builder's def-adapter.js stores both); the
 * "server/tool" key itself also counts.
 */
function voiceTurnNames(key) {
  const name = toolName(key);
  return name.startsWith("crow_") ? [name] : [name, `crow_${name}`];
}
function policyEntryMatches(entry, key) {
  const k = String(key);
  const i = k.lastIndexOf("/");
  const names = [k, ...voiceTurnNames(k)];
  if (i > 0) names.push(`mcp__${k.slice(0, i)}__${k.slice(i + 1)}`);
  return names.includes(entry);
}
const isVoiceRow = (row) => isVoiceBotId(String(row.bot_id)) || isVoiceBotDef(parseDef(row.definition));

/**
 * A "<provider_id>/<model_id>" key names a real model when an enabled provider
 * row lists that model id (a "role:<id>" ref: when the role resolves to one) (the Bot Builder's loadModelOptions rule: a models
 * entry is a string id or an object with .id). Split on the first "/" only.
 */
async function isProviderModel(db, key) {
  if (typeof key !== "string") return false;
  // A `role:` ref names a real model when the full role walk lands on one. Lazy: this module stays a no-import leaf (I4).
  if (key.startsWith("role:")) {
    try {
      const { resolveRole } = await import("./model-roles-store.js");
      // A bare "role:" is no role (isRoleRef): the resolver hands it back as "raw", never a model.
      const r = await resolveRole(db, key, { need: "chat" });
      return !!r?.key && r.reason !== "raw";
    } catch { return false; }
  }
  const i = key.indexOf("/");
  if (i <= 0 || i === key.length - 1) return false;
  const pid = key.slice(0, i), mid = key.slice(i + 1);
  const row = (await db.execute({ sql: "SELECT models, disabled FROM providers WHERE id = ?", args: [pid] })).rows[0];
  if (!row || row.disabled) return false;
  let models = [];
  try { models = JSON.parse(row.models || "[]"); } catch { models = []; }
  return Array.isArray(models) && models.some((m) => (typeof m === "string" ? m : m?.id) === mid);
}

/**
 * Create the reserved Crow voice bot once. An existing row (enabled or not,
 * parseable or not) is never touched. The new row records what the old voice
 * bindings were (migrated_from) without editing any device, setting or bot.
 *
 * The effective previous voice bot: the kiosk_dashboard_bot_id setting when it
 * names an enabled non-voice bot; else "Automatic" (the first enabled non-voice
 * bot by id, as the kiosk's resolveSessionBot with no fit check); else the bound
 * bot of the most recently seen device.
 *
 * Tool carry-over: an added crow_mcp entry is carried only when it passes the
 * voice denylist, no source bot that selects it denies it, and the injected
 * toolEffect (servers/gateway/voice/action-claims.js) calls it "read", and its
 * server maps (injected voiceCategoryFor, scripts/pi-bots/ext_registry.mjs) to
 * no voice category or to one the preset already opens. With either dep
 * missing nothing extra is carried (fail closed). Source confirm entries
 * for a carried tool are copied onto the voice bot's permission_policy.confirm.
 *
 * @returns {Promise<{created: boolean, corrupt?: true}>}
 */
export async function ensureVoiceBot(db, { fastKey, readSetting, listDevices, toolEffect = null, voiceCategoryFor = null, log = () => {} } = {}) {
  if (typeof fastKey !== "string" || !fastKey) throw new Error("fast_model_required");

  const existing = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [CROW_VOICE_BOT_ID] })).rows[0];
  if (existing) return parseDef(existing.definition) ? { created: false } : { created: false, corrupt: true };

  let setting = null;
  try { setting = (await readSetting(db, SESSION_BOT_SETTING)) || null; } catch { setting = null; }
  if (setting !== null) setting = String(setting);

  let devices = [];
  try { devices = (await listDevices(db)) || []; } catch { devices = []; }
  if (!Array.isArray(devices)) devices = [];

  const rows = (await db.execute({ sql: "SELECT bot_id, definition, enabled FROM pi_bot_defs ORDER BY bot_id", args: [] })).rows;
  const byId = new Map(rows.map((r) => [String(r.bot_id), r]));
  const usable = (r) => r && Number(r.enabled) === 1 && !isVoiceRow(r);

  let effective = null;
  if (setting && usable(byId.get(setting))) effective = setting;
  if (!effective) effective = rows.find(usable)?.bot_id ?? null;
  if (!effective) {
    let best = null, bestAt = -Infinity;
    for (const d of devices) {
      const b = typeof d?.bound_bot_id === "string" ? d.bound_bot_id : "";
      if (!b || isVoiceBotId(b)) continue;
      const r = byId.get(b);
      if (r && isVoiceRow(r)) continue;
      const at = d.last_seen ? Date.parse(d.last_seen) : NaN;
      const t = Number.isFinite(at) ? at : -Infinity;
      if (best === null || t > bestAt) { best = b; bestAt = t; }
    }
    effective = best;
  }
  if (effective !== null) effective = String(effective);
  const effectiveDef = effective && byId.get(effective) ? parseDef(byId.get(effective).definition) : null;

  const boundDevices = {};
  for (const d of devices) {
    if (d && typeof d.id === "string" && typeof d.bound_bot_id === "string" && d.bound_bot_id) boundDevices[d.id] = d.bound_bot_id;
  }

  const def = voiceBotDefinition({ preset: "fast_local", fastKey });
  const carried = effectiveDef?.fast_voice_model;
  if (await isProviderModel(db, carried)) def.fast_voice_model = carried;

  // Source bots: the effective dashboard bot, then every glasses-bound bot (device order).
  const sources = [effectiveDef];
  for (const d of devices) {
    if (!d || (d.device_kind || "glasses") !== "glasses" || typeof d.bound_bot_id !== "string") continue;
    const r = byId.get(d.bound_bot_id);
    if (r && !isVoiceRow(r)) sources.push(parseDef(r.definition));
  }

  // Candidate additions in first-seen order, each with every source bot that selects it.
  const tools = [...def.tools.crow_mcp];
  const preset = new Set(tools);
  // A crow_mcp entry on one of Crow's core servers opens that server's whole
  // voice category proxy (every action, writes included), so a carried entry
  // may only land in a category the preset already opens. Fail closed: with no
  // category map nothing extra is carried.
  const hasCategoryMap = typeof voiceCategoryFor === "function";
  const categoryOf = (key) => { const i = key.indexOf("/"); return i > 0 ? voiceCategoryFor(key.slice(0, i)) : null; };
  const presetCategories = new Set(hasCategoryMap ? tools.map(categoryOf).filter(Boolean) : []);
  const candidates = new Map();
  for (const src of sources) {
    for (const t of crowMcpOf(src)) {
      if (preset.has(t)) continue;
      if (!candidates.has(t)) candidates.set(t, []);
      if (src && !candidates.get(t).includes(src)) candidates.get(t).push(src);
    }
  }
  const added = [], skipped = [], confirm = [];
  for (const [t, srcs] of candidates) {
    let reason = null;
    if (deniedTool(t)) reason = "voice_denied";
    else if (srcs.some((src) => policyList(src, "deny").some((e) => policyEntryMatches(e, t)))) reason = "denied_by_source";
    else if (!hasCategoryMap) reason = "core_category";
    else if (categoryOf(t) && !presetCategories.has(categoryOf(t))) reason = "core_category";
    else if (typeof toolEffect !== "function" || toolEffect(toolName(t)) !== "read") reason = "not_read_only";
    if (reason) { skipped.push({ tool: t, reason }); continue; }
    tools.push(t); added.push(t);
    let voiceSeesConfirm = false, matched = false;
    for (const src of srcs) {
      for (const e of policyList(src, "confirm")) {
        if (!policyEntryMatches(e, t)) continue;
        matched = true;
        if (voiceTurnNames(t).includes(e)) voiceSeesConfirm = true;
        if (!confirm.includes(e)) confirm.push(e);
      }
    }
    // The voice turn checks only the bare name and its crow_ form: a confirm
    // stored only as mcp__<server>__<tool> (or server/tool) also gets the bare name.
    if (matched && !voiceSeesConfirm && !confirm.includes(toolName(t))) confirm.push(toolName(t));
  }
  for (const e of confirm) if (!def.permission_policy.confirm.includes(e)) def.permission_policy.confirm.push(e);
  def.tools.crow_mcp = tools;
  def.migrated_from = {
    at: new Date().toISOString(),
    dashboard_bot: effective,
    dashboard_setting: setting,
    devices: boundDevices,
    tools: added,
    skipped_tools: skipped,
  };

  const res = await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?, 'Crow', ?, 1, NULL) ON CONFLICT(bot_id) DO NOTHING",
    args: [CROW_VOICE_BOT_ID, JSON.stringify(def)],
  });
  const created = Number(res.rowsAffected) === 1;
  if (created) log(`[voice] created the Crow voice bot (fast model ${def.fast_voice_model}, carried from ${effective || "nothing"})`);
  return { created };
}
