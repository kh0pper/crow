/**
 * The reserved Crow voice bot: definition, presets and settings normalization.
 * Pure module, no I/O.
 */

export const CROW_VOICE_BOT_ID = "crow.voice";
export const VOICE_PRESETS = ["fast_local", "cloud"];
export const CONFIRM_LEVELS = ["standard", "strict"];
export const ROUTINE_BACKENDS = {
  calendar: ["auto", "workspace", "google", "off"],
  reminders: ["auto", "crow", "off"],
  tasks: ["auto", "workspace", "board", "off"],
};

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
