/**
 * Transport-free voice turn (kiosk spec 2026-10-03 §7.1, D14). The reusable
 * core of the Meta Glasses loop: STT → the voice bot (persona, botVoiceScope,
 * permission policy, fast_voice_model) → route (chooseVoiceRoute; escalation
 * with filler + 8 s cold fallback) → streamed tool loop with the <think> gate
 * → sentence-chunked TTS. Every dependency is injected (defaultVoiceDeps()
 * wires the real ones) so tests run on fakes. Glasses does NOT use this yet.
 *
 * NO AUDIO IS STORED: `opts.audio` is handed to the STT adapter and dropped.
 */
import {
  createThinkGate, createSentenceChunker, createConfirmGate, createConvoStore, degenerateTranscript, createToolSyntaxGate, stripToolSyntax,
  negotiatePcm, pcmStream, isDestructiveTool, describeDestructiveAction, SENTENCE_END,
  isProxyCall, executedProxyArgs, proxyArgsConflict, reliesOnFlatFallback, canonicalArgsHash,
} from "./turn-helpers.js";
import { zoneContext, PAST_DAY_RULE } from "../../shared/relative-dates.js";
import { withTurnContext, createContextEchoGate, stripContextEcho, stripContextEchoDeep, TURN_CONTEXT_NOTE } from "./context-echo.js";
import { estimatePromptTokens, requestFits, choosePromptFit, dropOldestExchange } from "./prompt-fit.js";
import { claimsAction, claimsReminder, claimsBeyondMemory, toolEffect, needsSpokenYes } from "./action-claims.js";
import { classifyTools, phraseWords, normalizeIntentLists, listMatches } from "./tool-families.js";
import { sttRewrite } from "./stt-rewrite.js";
import { voiceAbilities } from "./voice-abilities.js";
import { ROUTINE_OBJECTS, ROUTINE_OBJECT_LISTS, namesRoutineObjects } from "./routine-objects.js";
import { createVoiceMemory, VOICE_MODE_WINDOW_MS } from "./voice-memory.js";
import { lastWriteRecap } from "./own-tools.js";
import { CROW_VOICE_BOT_ID, normalizeVoiceSettings, isVoiceBotDef } from "../../shared/voice-bot.js";

/**
 * A voice bot (kind "voice") also asks a spoken yes before these: a schedule or a change to the
 * user's context sections (direct, or as the matching action of the crow_memory proxy), and a
 * change to the notification settings (VOICE_NOTIFICATION_TOOL; its "get" is a read and stays free).
 */
export const VOICE_CONFIRM_TOOLS = Object.freeze(["crow_create_schedule", "crow_update_schedule", "crow_add_context_section", "crow_update_context_section"]);
const VOICE_SCHEDULE_TOOLS = new Set(["crow_create_schedule", "crow_update_schedule"]);
const VOICE_NOTIFICATION_TOOL = "crow_notification_settings";
/** A schedule task that starts background bot work (bot_scheduler's "pipeline:botcron:<bot>" and every other "pipeline:" row). */
const scheduleArgs = (args) => {
  const a = args && typeof args === "object" ? args : {};
  const p = a.params && typeof a.params === "object" ? a.params : {};
  return [a, p, p.arguments && typeof p.arguments === "object" ? p.arguments : {}];
};
/**
 * crow_notification_settings asked for anything but a read. The object the executor runs with decides
 * (executedProxyArgs: a direct call's args, a proxy's params). Fail safe: every OTHER action field present
 * (top level unless it is the proxy's selector, params, params.arguments) must be "get" too.
 */
const changesNotifications = (tc) => {
  const a = tc.arguments && typeof tc.arguments === "object" ? tc.arguments : {};
  const p = a.params && typeof a.params === "object" ? a.params : {};
  const pa = p.arguments && typeof p.arguments === "object" ? p.arguments : {};
  const runs = (executedProxyArgs(tc) || {}).action;
  const layers = isProxyCall(tc) ? [p, pa] : [a, p, pa];
  return runs !== "get" || layers.some((l) => "action" in l && l.action !== "get");
};
const VOICE_ARGS_CONFLICT = "This call names one value at the top and another in params, so it cannot be confirmed by voice. Tell the user you couldn't do that, then end your turn — do not call another tool.";
const VOICE_ARGS_FLAT = "This call puts its values beside the action instead of in params, so it cannot be confirmed by voice. Tell the user you couldn't do that, then end your turn — do not call another tool.";
const startsPipeline = (args) => scheduleArgs(args).some((x) => typeof x.task === "string" && /^\s*pipeline:/i.test(x.task));
/** Turning a schedule back on without naming its task: it may be a pipeline: row (the gate cannot see the stored task). */
const reenablesUnseen = (args) => scheduleArgs(args).some((x) => (x.enabled === true || x.enabled === 1 || x.enabled === "true") && x.task === undefined);
const VOICE_NO_REENABLE = "A schedule cannot be turned back on by voice. Tell the user to turn it on in the Crow's Nest, then end your turn — do not call another tool.";
const VOICE_NO_PIPELINE = "Background bot work cannot be scheduled by voice. Tell the user to set it up in Bot Builder, then end your turn — do not call another tool.";

export const ESCALATION_READY_TIMEOUT_MS = 8000;
export const ESCALATION_PROBE_EVERY_MS = 500;
export const FILLER_TEXT = "One moment.";
export const BOT_CACHE_TTL_MS = 30_000;
/** What a turn records as timings.surface; anything else (or nothing) is "kiosk". */
export const VOICE_SURFACES = Object.freeze(["phone", "kiosk", "glasses"]);
/** Spoken + captioned when a turn ends with no answer (tool loop, empty reply, budget); callers pass a localized one. */
export const FALLBACK_TEXT = "Sorry, I got stuck on that one. Try asking again.";
/**
 * The STT prompt bias (opts.sttPrompt): one line of names the speaker is likely to say. Whisper reads
 * at most ~224 prompt tokens and a long prompt can be "heard" in silence, so it is cut to
 * STT_PROMPT_MAX characters at a comma; control characters go. A function is called once per turn with
 * the STT profile; one that throws, or anything that is not a string, gives no prompt.
 */
export const STT_PROMPT_MAX = 200;
export function sttPromptText(p, profile = null) {
  let v = p;
  if (typeof v === "function") { try { v = v(profile); } catch { v = null; } }
  if (typeof v !== "string") return "";
  let t = "";
  for (const ch of v.slice(0, 1000)) { const c = ch.codePointAt(0); t += c < 32 || (c >= 127 && c < 160) ? " " : ch; }
  t = t.replace(/\s+/g, " ").trim();
  if (t.length <= STT_PROMPT_MAX) return t;
  const cut = t.lastIndexOf(",", STT_PROMPT_MAX);
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, STT_PROMPT_MAX)).trim();
}

/** opts.sttHotwords → faster-whisper's `hotwords` (a few call-sign words; kiosk r7): control characters gone, six words at most. */
export const STT_HOTWORDS_MAX_WORDS = 6;
export function sttHotwordsText(p, profile = null) {
  let v = p;
  if (typeof v === "function") { try { v = v(profile); } catch { v = null; } }
  if (typeof v !== "string") return "";
  return v.slice(0, 200).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").split(/\s+/).filter(Boolean).slice(0, STT_HOTWORDS_MAX_WORDS).join(" ");
}

/** Spoken + captioned INSTEAD of a model call when the bound bot's prompt cannot fit the model even without its skills; callers pass a localized one. */
export const BOT_TOO_LARGE_TEXT = "This assistant is too large for the quick voice model. Choose another assistant for this display in the Kiosk settings.";
/** Rides on the last tool result before the forced final round (kept off the saved conversation). */
export const STOP_TOOLS_NOTE = "Tool limit reached for this question. Answer the user now from what you already have, in one or two short sentences. Do not call another tool.";
const DEGRADED_NOTE = "The larger model is not available right now. Answer with what you have, and call a tool directly if one is needed.";
// A denied discovery call keeps the turn going: the schemas are already in the tool list.
const SOFT_DENY = { crow_discover: "Tool discovery is not needed here: every tool you can use is already listed with its parameters. Call the right tool directly, or answer from what you know." };
// An extra tool with when(transcript) is offered only on turns that need it; a forced call on any other turn gets this.
const EXTRA_NOT_NEEDED = "Not needed for this question: nothing was done. Answer the user aloud now, in one or two short sentences. Do not call another tool.";
// Memories are on for this display, but opts.memoryWhen said this question does not ask for them.
const MEMORY_NOT_ASKED = "The user did not ask to remember or recall anything, so memory was not used. Answer the user aloud now from what you know. Do not call another tool.";
/*
 * Action turns (opts.actionWhen, queue item 29): the user asked the assistant to DO something (add to the
 * calendar, remind, send…), or the turn right after one ("move it to 9"). A reply on such a turn must never
 * claim an action no tool did:
 *  - an action request on a turn with NO tool is answered with CANT_DO_TEXT and no model call;
 *  - an action request whose tools were withheld from the quick model escalates; when the larger model
 *    cannot be had, NOT_READY_TEXT is spoken (the quick model is never handed the whole tool set);
 *  - otherwise the model's text is held until a tool really changed something (a remote call to a tool that
 *    changes things — toolEffect() "write" — that returned ok, or, on a turn whose words ask for the display or
 *    name what it holds, a display call with an effect). After an ok call of unknown effect a claim is
 *    replaced by UNSURE_TEXT, never by "nothing was changed". Text still held at the end is checked, and a claim of an action — done,
 *    promised or offered — is replaced by NOT_DONE_TEXT (CANT_DO_TEXT on a turn with no tool; MEMO_ONLY_TEXT
 *    when only a memory was saved and the reply promised a reminder);
 *  - the first-audio budget running out after such a change was sent speaks UNSURE_TEXT, not "try again".
 * The turn right after an action request is an action turn when opts.actionFollowWhen(transcript) says it
 * changes that request ("move it to 9 instead").
 * Callers pass localized lines (cantDoText, notDoneText, notReadyText, memoOnlyText, unsureText, partlyDoneText, hintText).
 */
/** Rides on a tool-less action turn's context block (tagged: an echo of it is never heard); never saved. */
export const ACTION_NOTE = "[Tools] No tool is available on this turn: nothing can be added, created, scheduled, sent, changed, deleted, saved, looked up or set as a reminder. Never say you did or will do any of that, and don't offer reminders or follow-ups; if the user asks for it, say in one short sentence, in the user's language, that you can't do it from here.";
export const CANT_DO_TEXT = "Sorry, I can't do that from here: this assistant has no tool for it.";
export const NOT_DONE_TEXT = "Sorry, I couldn't do that from here, so nothing was changed.";
/**
 * No dead end after a blocked claim (PR 2.1 [r2 C3]): what can be said by voice instead. Spoken when an add request's
 * claim was blocked and the one retry could not run or made no call, and when a change or cancel was claimed (Crow's own
 * tools only add). Callers pass a localized one (opts.hintText).
 */
export const HINT_TEXT = "I can only add new items by voice. Try: add lunch next Tuesday at noon.";
// Rides on the user message for the retry round only (restored before saving; the round's text is held as usual).
const claimRetryNote = (names) => `[Tools] Nothing has been added yet: no tool ran on this turn. To add it, call ${names.join(" or ")} now with the title and time the user gave. Never say it is done before the tool has run.`;
// A change, cancel or question about what was done is never retried as an add (en and es, accents dropped).
// A change verb counts only with a referent after it ("move it", "cancel my …", "cambia la hora") or with the surface's
// follow-up reading (actionFollowWhen); a Spanish verb with its object pronoun attached ("cámbiala") is its own referent.
// An add verb that leads ("add move the couch…", "remind me to cancel netflix") is an add, whatever follows.
const CHANGE_WORDS = new Set(["move", "change", "cancel", "delete", "remove", "reschedule", "cambia", "mueve", "cancela", "borra", "quita", "reprograma", "reprogramar"]);
const CHANGE_CLITIC = new Set(["cambialo", "cambiala", "muevelo", "muevela", "cancelalo", "cancelala", "borralo", "borrala", "quitalo", "quitala", "reprogramalo", "reprogramala"]);
const CHANGE_REFERENTS = new Set(["it", "that", "this", "them", "those", "these", "the", "my", "our", "his", "her", "their",
  "lo", "la", "los", "las", "eso", "esa", "ese", "esto", "el", "mi", "mis", "tu", "tus"]);
const ADD_LEADS = new Set(["add", "remind", "put", "create", "schedule", "anade", "agrega", "anademe", "agregame", "recuerdame", "pon", "apunta", "crea"]);
const ADD_LEAD_IN = new Set(["please", "can", "could", "would", "you", "hey", "crow", "ok", "okay", "por", "favor", "puedes"]);
const QUESTION_PHRASES = ["did you", "was it", "is it", "have you", "can you check"];
const leadsWithAdd = (ws) => { let i = 0; while (i < ws.length && i < 4 && ADD_LEAD_IN.has(ws[i])) i++; return ADD_LEADS.has(ws[i]); };
const asksChange = (t, followUp = false) => {
  const ws = phraseWords(t);
  if (leadsWithAdd(ws)) return false;
  return ws.some((w, i) => CHANGE_CLITIC.has(w) || (CHANGE_WORDS.has(w) && (followUp || CHANGE_REFERENTS.has(ws[i + 1]))));
};
const asksQuestion = (t) => { const s = ` ${phraseWords(t).join(" ")} `; return QUESTION_PHRASES.some((p) => s.includes(` ${p} `)) || /¿\s*(lo|ya)\b/i.test(String(t)); };
/** Same tool, same title (case-insensitive, trimmed), same start → one key (a forced retry never writes it twice). */
const writeKey = (tool, title, start) => {
  const t = String(title ?? "").trim().toLowerCase();
  if (!tool || !t) return null;
  const ms = Date.parse(start);
  return `${tool}|${t}|${Number.isFinite(ms) ? ms : String(start ?? "").trim()}`;
};
const argsWrite = (a) => ({ title: a?.title ?? a?.text, start: a?.start ?? a?.at ?? a?.due ?? null });
/** Some of Crow's own calls on this turn worked and some did not (spoken after the ok calls' own lines). */
export const PARTLY_DONE_TEXT = "I did part of that, but the rest didn't go through.";
/**
 * Own-tool result codes that mean the call itself was malformed or could not stand (own-tools.js validate()), not that a
 * write failed; a later ok own call clears them. past_time: a surface or a future tool that refuses a past date (Crow's
 * own tools ask about the next one instead). Only bad_args steps up.
 */
const OWN_VALIDATION_CODES = new Set(["bad_args", "no_tz", "past_time"]);
/** The [Dates] line without its rule for the past (a write-tool turn: own-tools checks a past date and asks instead). */
const dropPastRule = (s) => (typeof s === "string" ? s.split(` ${PAST_DAY_RULE}`).join("").split(PAST_DAY_RULE).join("") : s);
export const NOT_READY_TEXT = "The assistant that can do that isn't ready yet. Try again in a moment.";
/** A memory was saved, but the reply promised a reminder no tool set. */
export const MEMO_ONLY_TEXT = "I saved a note, but I can't set reminders from here.";
/** The first-audio budget ran out after a change was sent to a tool: it may still go through. */
export const UNSURE_TEXT = "I'm not sure that went through. Please check before you ask again.";
/** max_tokens for a held tool-less action turn: the answer is one short sentence, and nothing is heard until it ends. */
export const ACTION_HELD_MAX_TOKENS = 150;
/** Spoken + captioned when a must-run display tool never succeeded: the turn must not end on a claim that something is on the screen. Callers pass a localized one. */
export const DISPLAY_MISSED_TEXT = "Sorry, I couldn't put that on the screen.";
// The corrective round's note when the must-run tool brings none of its own (rides on the last message, never saved).
const MUST_RUN_NOTE = "Nothing has been done yet: the required tool has not run successfully in this turn. Call it now with the real content, or say plainly that you could not.";
const outcomeCode = (v, fallback) => (typeof v === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(v) ? v : fallback);
const logName = (n) => String(n ?? "").replace(/[^\w.-]/g, "_").slice(0, 48) || "_";
// opts.familiesOnIntent: a tool whose family is not on offer this turn is never run; a forced call gets this.
const FAMILY_NOT_OFFERED = "That tool is not on offer for this question: nothing was done. Answer the user aloud now from what you know, in one or two short sentences. Do not call another tool.";
// Without deps.toolForcing (tests, other callers) the 0.1.8 behaviour stands: named, then required, then none.
/*
 * The words a claim about the last own write may use without naming another item (turn.js recap): pronouns,
 * articles, claim verbs, openers, and day and time words, en and es (accents dropped, as phraseWords gives them).
 * Any other word of three letters or more that the write's title does not hold makes the claim about something else.
 */
const RECAP_FILLER = new Set(("yes yeah yep okay sure great alright all right done got have has had been the and for you your yours its "
  + "this that there here now just also already added add adding put set scheduled booked created saved noted made moved changed updated "
  + "will can going let calendar list tasks task reminder reminders schedule agenda event appointment meeting today tomorrow tonight "
  + "morning afternoon evening noon midnight next week day o clock oclock monday tuesday wednesday thursday friday saturday sunday "
  + "january february march april may june july august september october november december "
  + "una uno los las del para por con que esta esto eso ese hoy manana tarde noche semana dia ya listo lista anadido agregado "
  + "puesto programado guardado anotado apuntado agendado anadi agregue tu tus calendario tarea tareas recordatorio cita evento "
  + "lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre "
  + "las vale claro perfecto hecho").split(" "));
const objectWord = (w) => Object.values(ROUTINE_OBJECT_LISTS).some((lists) => listMatches([w], lists));
const LEGACY_FORCING = Object.freeze({ named: true, required: true, engine: "legacy" });
const WEAKER = { named: 2, required: 1, none: 0 };
// A step-down learned from a refused request is forgotten after this long (the server may have been replaced).
const LEARNED_TTL_MS = 10 * 60 * 1000;
// How long a turn that offered (on intent) or used one of Crow's own tools keeps a vague follow-up on them (voice-memory.js).
export { VOICE_MODE_WINDOW_MS };
const MEMORY_OFF = "Memory is turned off on this display. Tell the user you can't use saved memories here, then end your turn — do not call another tool.";
/** Rides on the user message of a calendar-fallback turn (tagged: never heard, never saved). */
const calendarFallbackNote = (names) => `[Tools] No calendar is installed here, so nothing can be added to a calendar. Offer the user a reminder at the time they asked for instead, by calling ${names.join(" or ")}. Never say it was added to a calendar.`;

/**
 * Only a tool OFFERED on this turn may run. The model can name any tool, and a photo, a page or a
 * tool result can tell it which (an injected "call crow_create_project" must never reach the
 * executor). A call counts as offered when:
 *  - its own name is in the turn's tool list (a category tool, an add-on tool, an endpoint's extra);
 *  - it names a core action whose category tool is in the list (small models call
 *    `crow_search_memories` instead of `crow_memory {action}`; both reach the same server);
 *  - it names a selected add-on tool directly while the `crow_tools` wrapper is offered.
 * offered: Set of tool names sent with the request. categoryOf(name) → core category | null.
 * selectedAddon(name) → true for an add-on tool the bound bot selected.
 */
export function wasOffered(tc, offered, { categoryOf = () => null, selectedAddon = () => false } = {}) {
  const name = String(tc?.name || "");
  if (!name) return false;
  if (offered.has(name)) return true;
  const cat = categoryOf(name);
  if (cat && offered.has(`crow_${cat}`)) return true;
  return offered.has("crow_tools") && selectedAddon(name) === true;
}

export function createVoiceTurnRunner(deps) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const convo = deps.convo || createConvoStore({ now });
  const confirm = deps.confirm || createConfirmGate({ now });
  const botCache = new Map();
  // deps.ensureVoiceBot runs at most once per runner (a missing Crow voice bot), whatever happens after.
  let voiceEnsured = false;
  const fillerCache = new Map();
  // Saved-history messages the router must not count as "recent tool context":
  // in-process display-tool calls and calls the gate REFUSED (denied tools such as
  // crow_discover, policy/confirm refusals). The convo store keeps these objects
  // by reference, so the mark survives into later turns (smoke 2026-10-04: a
  // refused/looping crow_discover escalated the next three plain questions).
  const routeNeutral = new WeakSet();
  const fitLogged = new Set();
  // Per model: the strongest tool_choice form the backend has not refused ("named" → "required" → "none"), with when it was learned.
  const toolChoiceMode = new Map();
  // Tool families (opts.familiesOnIntent): what the previous turn on each display used ({ set, at }: it expires after
  // VOICE_MODE_WINDOW_MS, like every carry-over), and which "no intent list" notes were already logged.
  const lastFamilies = new Map();
  const lastFamiliesOf = (id) => {
    const e = lastFamilies.get(id);
    return e && now() - e.at <= VOICE_MODE_WINDOW_MS ? e.set : null;
  };
  // The voice bot's per-device memory (voice-memory.js, PR 2.1): own families carried over for the window, the last
  // own write, the last action request. Separate from lastOwn / lastAction / lastFamilies, whose meanings stay.
  const memory = createVoiceMemory({ now });
  // deviceId → when its previous turn was offered one of Crow's own tools on intent (or used one): a follow-up
  // ("move it to 3") within VOICE_MODE_WINDOW_MS may still need one, so a withheld own tool counts toward escalating it.
  const lastOwn = new Map();
  // Displays whose previous turn was an action request (opts.actionWhen): the next turn is an action turn too.
  const lastAction = new Set();
  const famLogged = new Set();
  const NO_FAMILIES = new Set();

  /** The tool list a turn advertises (also what the bind-time fit check counts). */
  function turnTools(bot, { memoryOn, extra, deny }) {
    const extraNames = new Set(extra.map((x) => x.definition.name));
    return deps.getChatTools({ botDef: bot })
      .filter((t) => !deny.has(t.name) && (memoryOn || t.name !== "crow_memory") && !extraNames.has(t.name))
      .concat(extra.map((x) => x.definition));
  }
  // The camera tool is refused unless THIS turn's endpoint supplies it as an extra tool (a session with a camera).
  const turnDeny = (denyTools, extra = []) => new Set([
    ...(extra.some((x) => x?.definition?.name === "crow_glasses_capture_photo") ? [] : ["crow_glasses_capture_photo"]),
    ...(Array.isArray(denyTools) ? denyTools : []),
  ]);
  const withSuffix = (system, suffix) => (suffix ? `${system}\n\n${suffix}` : system);

  /**
   * The fit ladder for one bot on one model (prompt-fit.js): the full system message, else the
   * one without the bot's skill bodies, else too large. `full` = an already-built full message.
   */
  async function promptFit({ db, bot, tools, promptSuffix, key, full }) {
    const ctx = await deps.contextLenFor(key, db);
    return choosePromptFit({
      ctx, tools,
      full: full ?? withSuffix(await deps.generateSystemPrompt({ botDef: bot }), promptSuffix),
      lean: async () => withSuffix(await deps.generateSystemPrompt({ botDef: bot, omitSkills: true }), promptSuffix),
    });
  }

  /**
   * Bind-time check (Kiosk panel): would this bot's voice prompt fit its quick voice model?
   * Runs the turn's own tool filter and ladder. null = no such enabled bot.
   * → { level: "full" | "no_skills" | "too_large", ctx (null = unknown), est_tokens, est_no_skills_tokens, reserve_tokens, model }
   */
  async function assessBot({ db, botId, memoryOn = false, extraTools, denyTools, promptSuffix }) {
    const bot = await loadBot(db, botId);
    if (!bot) return null;
    const key = bot.fast_voice_model || deps.fastKey;
    const extra = Array.isArray(extraTools) ? extraTools : [];
    const tools = turnTools(bot, { memoryOn, extra, deny: turnDeny(denyTools, extra) });
    const fit = await promptFit({ db, bot, tools, promptSuffix, key });
    return { level: fit.level, ctx: fit.ctx, est_tokens: fit.est, est_no_skills_tokens: fit.est_no_skills, reserve_tokens: fit.reserve, model: key };
  }

  /**
   * "By voice on displays: …" (Bot Builder card, Kiosk panel): what this bot can do by voice on a display that
   * turns on tool families (familiesOnIntent), decided by the turn's own classifier on a fixed request per
   * ability (voice-abilities.js). Cheap at render: the bot row, the tool list and the family index — never a
   * system prompt, a context length, a model start, a probe or a chat adapter. The larger model's key is
   * resolved (a provider-table read) only to know whether an escalation could happen at all.
   * extraTools / denyTools: as for assessBot (the display's own tools are never an ability; they only keep a
   * request they would take on the quick model). displayObjectWhen(transcript): the display could hold what
   * the request names — taken as if a card or a timer were open (the line may understate, never overstate).
   * null = no such enabled bot, or no tool families on this gateway.
   * → { items: [{ id, quick, label? }], none }
   */
  async function abilitiesOf({ db, botId, memoryOn = false, extraTools, denyTools, displayObjectWhen }) {
    const fam = deps.toolFamilies;
    if (!fam) return null;
    const bot = await loadBot(db, botId);
    if (!bot) return null;
    const extra = Array.isArray(extraTools) ? extraTools : [];
    const extraNames = new Set(extra.map((x) => x?.definition?.name));
    const deny = turnDeny(denyTools, extra);
    const tools = turnTools(bot, { memoryOn: false, extra, deny }).filter((t) => !extraNames.has(t.name));
    const policy = bot.permission_policy || {};
    const allowed = (n) => !deny.has(n)
      && !(Array.isArray(policy.deny) && policy.deny.includes(n))
      && !(policy.external_send === "draft_only" && typeof deps.isExternalSendTool === "function" && deps.isExternalSendTool(n));
    let hidden = [];
    if (tools.some((t) => t.name === "crow_tools") && typeof deps.connectedAddonTools === "function") {
      const scope = deps.botVoiceScope(bot);
      const direct = new Set(tools.map((t) => t.name));
      hidden = [...deps.connectedAddonTools()].filter((n) => !direct.has(n) && (!scope || scope.selectedToolNames.has(n)));
    }
    let escalates = false;
    if (deps.escalateKey && typeof deps.toolEscalationEnabled === "function" && deps.toolEscalationEnabled() === true) {
      try { escalates = !!(await deps.resolveKey(deps.escalateKey))?.baseUrl; } catch { escalates = false; }
    }
    // As the turn reads it (displayAsked / displayBacks); a display tool that throws is taken as taking the request.
    const displayBacks = (t) => {
      try {
        return extra.some((x) => (typeof x.when !== "function" || x.when(t) === true)
          && ((typeof x.holdText === "function" && x.holdText(t) === true) || (typeof x.must === "function" && x.must(t) === true)))
          || (extra.length > 0 && typeof displayObjectWhen === "function" && displayObjectWhen(t) === true);
      } catch { return true; }
    };
    const classify = (transcript) => classifyTools({ baseTools: tools, fam, transcript, isMemoryTool: (n) => deps.isMemoryTool(n) });
    // "Remembers things" only when the turn would really offer crow_memory (the bot has it, the display does
    // not deny it) and the bot's policy lets it store a memory.
    const memTool = memoryOn === true && turnTools(bot, { memoryOn: true, extra, deny }).some((t) => t.name === "crow_memory");
    return voiceAbilities({ tools, hidden, classify, escalates, displayBacks, families: fam, memoryOn: memTool && allowed("crow_store_memory"), allowed });
  }

  async function loadBot(db, botId) {
    if (!botId) return null;
    // deps.botDefsGeneration(): bumped on every bot-def save (pibots:defs-changed), so a Bot Builder
    // save applies on the next turn instead of after the 30 s cache.
    const gen = typeof deps.botDefsGeneration === "function" ? deps.botDefsGeneration() : 0;
    const hit = botCache.get(botId);
    if (hit && hit.gen === gen && now() - hit.at < BOT_CACHE_TTL_MS) return hit.def;
    let def = null;
    try {
      const row = await deps.loadBotRow(db, botId);
      if (row && row.enabled) {
        def = JSON.parse(row.definition);
        if (def) def.bot_id = row.bot_id;
      }
    } catch { def = null; }
    botCache.set(botId, { def, at: now(), gen });
    return def;
  }

  async function openTts(db, device) {
    const profile = await deps.getTtsProfile(db, device);
    if (!profile) return null;
    const adapter = await deps.createTtsAdapter(profile);
    return { profile, adapter, neg: negotiatePcm(adapter.name), voice: profile.defaultVoice };
  }

  /**
   * A speaker bound to one turn: emits tts_start once, then audio; non-PCM = one buffer per sentence.
   * `mute` (optional AbortSignal) silences the ANSWER (say/filler) when the turn's first-audio budget
   * runs out; say.force() ignores it, so the fallback line still plays. `signal` (barge-in/close) stops both.
   */
  function makeSpeaker(tts, sink, signal, onChunk, mute = null) {
    let started = false;
    let answered = false;
    const both = mute ? (signal ? AbortSignal.any([signal, mute]) : mute) : signal;
    const off = (hard) => signal?.aborted === true || (!hard && mute?.aborted === true);
    const begin = () => {
      if (started) return;
      started = true;
      sink.event({ type: "tts_start", codec: tts.neg ? "pcm" : "mp3", sample_rate: tts.neg ? tts.neg.sampleRate : 24000 });
    };
    const emit = (buf, hard, answer) => { if (off(hard) || !buf.length) return; onChunk(); if (answer) answered = true; sink.audio(buf); };
    async function collect(text, hard) {
      const parts = [];
      const sig = hard ? signal : both;
      const stream = tts.neg ? pcmStream(tts.adapter, text, tts.voice, tts.neg, { signal: sig }) : tts.adapter.synthesize(text, tts.voice, { signal: sig });
      for await (const c of stream) {
        if (off(hard)) return null;
        if (tts.neg) { begin(); emit(Buffer.isBuffer(c) ? c : Buffer.from(c), hard, true); } else parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
      return tts.neg ? null : Buffer.concat(parts);
    }
    let chars = 0;
    const speak = async (text, hard) => {
      const t = String(text || "").trim();
      if (!t || off(hard)) return;
      chars += t.length;
      const mp3 = await collect(t, hard);
      if (mp3 && !off(hard)) { begin(); emit(mp3, hard, true); }
    };
    const say = (text) => speak(text, false);
    /** Speaks even after the answer was muted (the fallback line); a barge-in still stops it. */
    say.force = (text) => speak(text, true);
    /** Whether any answer audio (not the filler) has left the server this turn. */
    say.answered = () => answered;
    /** Characters handed to TTS this turn (the filler excluded): a reply's length for the metrics line (kiosk r7b H3). */
    say.chars = () => chars;
    say.filler = async () => {
      if (off(false)) return;
      const key = `${tts.profile.id}|${tts.voice}|${tts.adapter.name}`;
      let buf = fillerCache.get(key);
      if (!buf) {
        const parts = [];
        const stream = tts.neg ? pcmStream(tts.adapter, FILLER_TEXT, tts.voice, tts.neg, { signal: both }) : tts.adapter.synthesize(FILLER_TEXT, tts.voice, { signal: both });
        for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        if (off(false)) return;
        buf = Buffer.concat(parts);
        fillerCache.set(key, buf);
      }
      if (off(false)) return;
      begin();
      emit(buf, false, false);
    };
    let ended = false;
    say.end = () => { if (started && !ended) { ended = true; sink.event({ type: "tts_end" }); } };
    return say;
  }

  async function readyEscalation(key, db, signal) {
    const providerId = String(key).split("/")[0];
    let up;
    try { up = await deps.resolveKey(key); } catch { return { reason: "unresolved" }; }
    let refused = null;
    // maybeAcquireLocalProvider blocks until the model is ready, so it runs in
    // the background and we PROBE instead (ruling R14). A cold start keeps
    // going after we give up (the gateway's on-demand start, CROW-SCHEDULE.md).
    Promise.resolve().then(() => deps.acquire(providerId)).then((ok) => { if (ok === false) refused = Object.assign(new Error("acquire returned false"), { code: "acquire_failed" }); }).catch((err) => { refused = err || new Error("acquire failed"); });
    const deadline = now() + ESCALATION_READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (signal?.aborted) return { reason: "aborted" };
      await new Promise((r) => setImmediate(r));   // lets a background acquire rejection/false land before the first probe
      if (refused) {
        const code = refused.code;
        return { reason: code === "box_reserved" ? "box_reserved" : code === "serving_class_refused" ? "serving_class" : "acquire_failed" };
      }
      if (await deps.probeReady(up.baseUrl)) return { adapter: await deps.createChatAdapter(key, db) };
      await sleep(ESCALATION_PROBE_EVERY_MS);
    }
    return { reason: "cold_timeout" };
  }

  /** STT only (the kiosk's early transcription, lever D). The WAV is handed to the adapter and dropped. */
  async function transcribe({ db, device, audio, signal, sttModel, sttPrompt, sttHotwords }) {
    const sttProfile = await deps.getSttProfile(db, device);
    if (!sttProfile) throw Object.assign(new Error("no STT profile"), { code: "no_stt_profile" });
    const stt = await deps.createSttAdapter(sttProfile);
    const model = typeof sttModel === "function" ? sttModel(sttProfile) : null;
    const prompt = sttPromptText(sttPrompt, sttProfile);
    const hotwords = sttHotwordsText(sttHotwords, sttProfile);
    const r = await stt.transcribe(audio, { filename: "turn.wav", contentType: "audio/wav", language: sttProfile.language || undefined, signal, ...(model ? { model } : {}), ...(prompt ? { prompt } : {}), ...(hotwords ? { hotwords } : {}) });
    return { text: String(r?.text || "").trim(), hotwords: !!hotwords };   // r7c N3: whether hotwords went (never the words)
  }

  /**
   * deps.voiceActions (optional; Crow voice's pending confirmations), every member optional:
   * - fastPath({ db, device, surface, transcript, lang, tz, bot, executor }) → Promise<null | { say, verb, events? }>:
   *   runs after STT and the TTS open, before opts.fastPaths. bot and executor are null when the bot cannot be
   *   loaded (it is never ensured here). A non-null result is spoken and saved like a fast path. A throw is
   *   logged and taken as null.
   * - turnContext({ device }) → { text, pending } | string: SYNCHRONOUS (a returned Promise is logged and
   *   ignored). The text joins the turn's context line on the user message only, never saved; write it as
   *   "[Tag] …" lines so the echo gate recognises and strips a read-back. pending: true makes the turn an
   *   action turn (the action guard holds the reply and replaces an unbacked claim). A throw is logged and ignored.
   * - afterTurn({ device, calledTools }): called in finally on every outcome; calledTools lists every tool name
   *   the model called, refused and gated calls included. A throw is logged.
   *
   * opts (beyond the transport): maxToolRounds — tool-calling rounds before a forced, tool-free
   * final answer (default deps.maxToolRounds); firstAudioBudgetMs — wall-clock from the turn start
   * to the first ANSWER audio (the filler does not count), after which the answer is cut and the
   * fallback spoken (default: none); fallbackText — the localized fallback line; tooLargeText —
   * the localized line for a bot whose prompt cannot fit the model (default BOT_TOO_LARGE_TEXT);
   * memoryWhen(transcript) — with memories on, whether THIS question asks for them (default: always);
   * displayMissedText — the localized line for a must-run tool that never succeeded;
   * memoryOn (boolean) — whether memory tools may be used on this endpoint at all (default: the
   * display's kiosk_settings.memory_integration);
   * onToolResult({ name, tool, result, isError }) → string | undefined — a caller may REPLACE a remote
   * tool's result before the model reads it (and before it is saved). `name` is the tool the model
   * called, `tool` the one that really ran (a proxy call unwrapped). Never called for the caller's own
   * extraTools or for a refused call; a hook that throws, or returns anything but a string, changes nothing.
   *
   * extraTools[i] = { definition, execute(args, { transcript }) → JSON string, when?, must?, mustNote?, mustDone? }:
   *   when(transcript) false → not offered this turn (a forced call is refused, never run);
   *   must(transcript) true  → the turn must end with a successful call of this tool ({ ok: true }, or
   *     mustDone(result) when the tool says which results count):
   *     tool_choice requires it while it is the only tool offered; text is held back (not spoken)
   *     until it has run; a turn that ends without it gets ONE corrective round with mustNote on
   *     the last message; if it still has not run, displayMissedText is spoken instead of the text.
   *
   * result.failed: null | "tool_rounds" | "tool_repeat" | "no_text" | "budget" | "error"
   *   | "bot_too_large" (the bot's prompt does not fit the model even without its skills: no model call)
   *   | "context_full" (this request would not fit the context even with no saved history: not sent)
   *   | "display_missed" (a must-run tool never succeeded: the truthful line was spoken).
   * timings.prompt_fit: "no_skills" | "too_large" when the full prompt did not fit (absent when it did).
   * timings.tools: one entry per tool round, "name:code" per call joined by "+" — code is ok, error,
   *   the tool's own code (e.g. placeholder), or not_offered / refused_policy / needs_confirm. Never arguments.
   * timings.tool_choice ("named" | "required" | "none"), display_corrected, display_missed: must-run turns only.
   */
  async function runVoiceTurn(opts) {
    const { db, device, sink, signal } = opts;
    // opts.startedAt: when the turn really began (the kiosk's turn_end), so an early-STT wait counts.
    const t0 = Number.isFinite(opts.startedAt) ? opts.startedAt : now();
    const timings = { surface: VOICE_SURFACES.includes(opts.surface) ? opts.surface : "kiosk" };
    const result = { transcript: "", route: null, fastPath: false, escalated: false, degraded: null, aborted: false, failed: null, timings };
    const mark = (k) => { if (timings[k] == null) timings[k] = now() - t0; };
    const aborted = () => signal?.aborted === true;
    const fail = (code, recoverable = true, message) => sink.event({ type: "error", code, recoverable, ...(message ? { message } : {}) });
    const log = deps.log || ((m) => console.log(m));
    const defaultFallbackText = String(opts.fallbackText || FALLBACK_TEXT);
    // The first-audio budget cuts the answer (LLM stream, tool wait, answer TTS) through `mute`;
    // the session `signal` (barge-in/close) is never touched by it.
    const mute = new AbortController();
    const llmSignal = signal ? AbortSignal.any([signal, mute.signal]) : mute.signal;
    let budgetHit = false;
    let budgetTimer = null;
    let budgetFired = null;
    const budgetP = new Promise((res) => { budgetFired = res; });
    let say = null;
    let history = null;
    let executor = null;
    let executorBot = null;     // the bot the executor was made for
    let usedFamilies = null;
    let ownOffered = false;   // an own tool was offered on intent this turn (arms lastOwn; an escalation offering every family does not)
    let actionAsked = false;
    let voiceKind = false;        // the turn's bot is the voice bot (kind "voice"): the voice memory and the sentence gate apply
    let ownStamp = [];
    const ownOkFams = new Set();  // own families whose call returned ok this turn (stamped into the voice memory)            // own families this turn offered on intent (stamped into the voice memory; a carried one never is)
    const calledTools = [];       // every tool name the model called this turn (deps.voiceActions.afterTurn)
    const voiceActions = deps.voiceActions && typeof deps.voiceActions === "object" ? deps.voiceActions : null;
    /** Speak + caption a fixed line instead of a model call, and save the exchange (the plain transcript and the line). */
    const speakLine = async (line) => {
      sink.event({ type: "caption_delta", text: line });
      await say(line);
      if (aborted()) { result.aborted = true; return; }
      say.end();
      convo.save(device.id, [...(history || []), { role: "user", content: result.transcript }, { role: "assistant", content: line }]);
    };
    /** Speak + caption the fallback, record the failure, and save a clean exchange (no looping tool chatter). */
    const speakFallback = async (why, spokenBefore, fallbackText = defaultFallbackText) => {
      result.failed = why;
      timings.failed = why;
      log(`[voice-turn] ${device?.id} turn failed (${why})${timings.tools ? `; tools by round: ${timings.tools.join(" → ")}` : ""}`);
      if (aborted()) { result.aborted = true; result.failed = null; delete timings.failed; return; }
      if (!say) return;
      sink.event({ type: "caption_delta", text: spokenBefore ? ` ${fallbackText}` : fallbackText });
      await say.force(fallbackText);
      // A barge-in over the apology: the turn was interrupted, not failed (the gate excludes it anyway).
      if (aborted()) { result.aborted = true; result.failed = null; delete timings.failed; return; }
      say.end();
      if (history) convo.save(device.id, [...history, { role: "user", content: result.transcript }, { role: "assistant", content: fallbackText }]);
    };
    try {
      // 1. STT (the WAV is only ever passed to the adapter; never written anywhere)
      let transcript = opts.transcript;
      if (opts.sttEarly) {
        timings.stt_early = opts.sttEarly.used ? "used" : "none";
        if (opts.sttEarly.discards) { timings.stt_early_discards = opts.sttEarly.discards; timings.stt_early_discard_ms = opts.sttEarly.discard_ms || 0; }
        if (opts.sttEarly.used && Number.isFinite(opts.sttEarly.ms)) timings.stt_early_ms = opts.sttEarly.ms;
      }
      // r7c N3 (counts only): whether STT hotwords were sent for the transcript this turn uses.
      timings.stt_hotwords = opts.sttEarly?.used === true && opts.sttEarly.hotwords === true;
      if (transcript != null && opts.sttEarly?.used) mark("stt_ms");   // = how long the turn waited for the early transcript
      if (transcript == null) {
        const sttProfile = await deps.getSttProfile(db, device);
        if (!sttProfile) { fail("no_stt_profile", false); return result; }
        const stt = await deps.createSttAdapter(sttProfile);
        // opts.sttModel(profile): a per-display model override (kiosk: tiny.en), or null for the profile's own.
        const model = typeof opts.sttModel === "function" ? opts.sttModel(sttProfile) : null;
        // opts.sttPrompt: words this endpoint expects to hear (a display's station names), as the STT's
        // prompt bias. A string or a function returning one; bounded by sttPromptText.
        const prompt = sttPromptText(opts.sttPrompt, sttProfile);
        // opts.sttHotwords: a few words (call signs) as faster-whisper's `hotwords`; other adapters ignore it.
        const hotwords = sttHotwordsText(opts.sttHotwords, sttProfile);
        timings.stt_hotwords = !!hotwords;
        const r = await stt.transcribe(opts.audio, { filename: "turn.wav", contentType: "audio/wav", language: sttProfile.language || undefined, signal, ...(model ? { model } : {}), ...(prompt ? { prompt } : {}), ...(hotwords ? { hotwords } : {}) });
        transcript = String(r?.text || "").trim();
        mark("stt_ms");
      }
      // The voice bot (step 3 below loads and requires it): opts.botId, else deps.voiceBotId, else the device's bound bot.
      const botId = typeof opts.botId === "string" && opts.botId ? opts.botId : (deps.voiceBotId || device.bound_bot_id);
      // A misheard leading "add" ("Had coffee Tuesday at 9", PR 2.1 [r2 I6]) is put back once, here, before any reader
      // of the words (the fast paths, actionWhen, the intent lists, the model): the caption and the saved conversation
      // keep the rewritten text. The voice bot only, never while a question waits for a yes (stt-rewrite.js: English only).
      const rw = transcript ? sttRewrite(transcript, { lang: opts.lang }) : null;
      if (rw) {
        let waiting = false;
        try { waiting = voiceActions?.turnContext?.({ device })?.pending === true; } catch { waiting = false; }
        let rwBot = null;
        if (!waiting) { try { rwBot = await loadBot(db, botId); } catch { rwBot = null; } }
        if (!waiting && isVoiceBotDef(rwBot)) { transcript = rw.text; timings.stt_rewrite = rw.from; }
      }
      result.transcript = transcript;
      sink.event({ type: "transcript_final", text: transcript });
      if (aborted()) { result.aborted = true; return result; }
      if (!transcript) { fail("empty_transcript"); return result; }
      // An STT repetition loop is a failed transcription, not a question: no fast path, no model (r7 G4).
      if (degenerateTranscript(transcript)) { timings.stt_degenerate = true; fail("empty_transcript"); return result; }

      const tts = await openTts(db, device);
      if (!tts) { fail("no_tts_profile", false); return result; }
      say = makeSpeaker(tts, sink, signal, () => mark("tts_first_chunk_ms"), mute.signal);

      // 2. Fast paths (no LLM). deps.voiceActions.fastPath first (a pending confirmation answered by a yes or
      // a no), then opts.fastPaths. The voice-actions path gets the bot and an executor; a bot that cannot be
      // loaded is passed as null (it never stops the path), and nothing is ensured here.
      let fp = null;
      if (typeof voiceActions?.fastPath === "function") {
        // Nothing here may stop "pause": a failure is logged and the path is skipped (null).
        let vaBot = null;
        try { vaBot = await loadBot(db, botId); } catch (err) { log(`[voice-turn] ${device.id} voice actions: bot not loaded (${err?.message || err})`); }
        if (vaBot) {
          try { executor = deps.createToolExecutor({ botDef: vaBot }); executorBot = vaBot; } catch (err) { executor = null; log(`[voice-turn] ${device.id} voice actions: no executor (${err?.message || err})`); }
        }
        try { fp = await voiceActions.fastPath({ db, device, surface: timings.surface, transcript, lang: opts.lang, tz: opts.tz, bot: vaBot, executor }); } catch (err) { fp = null; log(`[voice-turn] ${device.id} voice actions fastPath failed (${err?.message || err})`); }
      }
      if (!fp && typeof opts.fastPaths === "function") fp = await opts.fastPaths(transcript);
      if (fp) {
        result.fastPath = true;
        if (fp.tier === "t0" || fp.tier === "t1") timings.tier = fp.tier;
        // The verb a no-model path acted on ("pause", "resume", "play"…): a fixed word, never the transcript.
        // It is how a smoke tells "STT heard play" from a state disagreement (kiosk smoke 2026-10-06 F4).
        if (typeof fp.verb === "string" && /^[a-z_]{1,24}$/.test(fp.verb)) timings.verb = fp.verb;
        for (const ev of fp.events || []) sink.event(ev);
        if (fp.say) { sink.event({ type: "caption_delta", text: fp.say }); await say(fp.say); }
        // A held own call confirmed by a spoken yes wrote something (own-tools.js fastPath): it is on record.
        if (fp.write && typeof fp.write.tool === "string") {
          memory.noteWrite(device.id, { ...fp.write, say: fp.say || "", lang: opts.lang, tz: opts.tz });
          if (typeof fp.write.family === "string") memory.noteOwn(device.id, [fp.write.family]);
        }
        say.end();
        // A path with nothing to say (a transport verb) leaves no exchange behind: an empty
        // assistant message would only confuse the next turn's chat template.
        if (fp.say) convo.save(device.id, [...convo.get(device.id), { role: "user", content: transcript }, { role: "assistant", content: fp.say }]);
        return result;
      }

      // 3. The voice bot drives the turn (ruling R11: no profile fallback): opts.botId (the kiosk's turn
      // check, the eval harness), else deps.voiceBotId (the Crow voice bot), else the device's bound bot.
      // Required (and ensured) only after the fast paths, so a missing or disabled voice bot never stops "pause"
      // or the clock. deps.voiceActions.fastPath may have read it already (cached), but never ensures or requires it.
      let bot = await loadBot(db, botId);
      if (!bot && botId === CROW_VOICE_BOT_ID && !voiceEnsured && typeof deps.ensureVoiceBot === "function") {
        voiceEnsured = true;
        try { await deps.ensureVoiceBot(db); } catch (err) { log(`[voice-turn] Crow voice bot not created (${err?.message || err})`); }
        botCache.delete(botId);   // the cached miss; a bot created just now answers this turn
        bot = await loadBot(db, botId);
      }
      if (!bot) { fail("no_bound_bot", false); return result; }
      voiceKind = isVoiceBotDef(bot);
      history = convo.get(device.id);
      // First-audio budget (smoke 2026-10-04 #19: a 24.5 s silent tool loop). Counted from the turn
      // start; only answer audio stops it, so an escalation's "One moment." is followed by the fallback.
      if (Number.isFinite(opts.firstAudioBudgetMs) && opts.firstAudioBudgetMs > 0) {
        const left = Math.max(0, opts.firstAudioBudgetMs - (now() - t0));
        budgetTimer = (deps.setTimeout || setTimeout)(() => {
          if (say.answered() || aborted()) return;
          budgetHit = true;
          mute.abort();
          budgetFired();
        }, left);
      }
      // opts.memoryOn (boolean): the endpoint's own answer; without it, the display setting decides as before.
      const memoryOn = typeof opts.memoryOn === "boolean" ? opts.memoryOn : device.kiosk_settings?.memory_integration === true;
      const extra = Array.isArray(opts.extraTools) ? opts.extraTools : [];
      const extraByName = new Map(extra.map((x) => [x.definition.name, x]));
      // denyTools (kiosk: crow_delegate, crow_job_status — review C3): never advertised AND
      // refused by the gate below even if force-called, so a room cannot hand work to
      // another bot (crow_delegate's `bot` arg accepts ANY enabled bot) or read it back.
      const deny = turnDeny(opts.denyTools, extra);
      // extraTools[i].when(transcript) (kiosk: crow_wm): offered only when the PLAIN transcript
      // needs it. Live test 2026-10-04: with the display tool on every turn the 4B answered plain
      // questions through it — two tool rounds, 7 s, and a card repeating the spoken answer.
      const offered = new Set(extra.filter((x) => typeof x.when !== "function" || x.when(transcript) === true).map((x) => x.definition.name));
      // Crow's own tools (PR 2): in-process routine tools (a calendar event, a reminder, a task), one tool family
      // each. opts.ownTools (an array: tests, overrides) wins; else, for the voice bot only, deps.ownTools(...)
      // → { tools, unavailable }. A turn with a must-run extra tool (the glasses camera, a must-run display tool)
      // carries only what it carries today ([rev2 C2]); opts.noOwnTools forces the same. An own tool runs as
      // execute(args, { transcript, executor, db, device, fallback? }): the device holds a strict-confirm question.
      const mustOffered = extra.some((x) => offered.has(x.definition.name) && typeof x.must === "function" && x.must(transcript) === true);
      const ownByName = new Map();
      const ownUnavailable = new Set();
      if (!mustOffered && opts.noOwnTools !== true) {
        let src = null;
        if (Array.isArray(opts.ownTools)) src = opts.ownTools;
        else if (typeof deps.ownTools === "function" && isVoiceBotDef(bot)) {
          try { src = await deps.ownTools({ db, bot, surface: timings.surface, lang: opts.lang, tz: opts.tz, now: now() }); }
          catch (err) { log(`[voice-turn] ${device.id} own tools not loaded (${err?.message || err})`); }
        }
        for (const id of Array.isArray(src?.unavailable) ? src.unavailable : []) if (Object.hasOwn(ROUTINE_OBJECTS, id)) ownUnavailable.add(id);
        const policyDeny = Array.isArray(bot.permission_policy?.deny) ? bot.permission_policy.deny : [];
        for (const o of Array.isArray(src) ? src : Array.isArray(src?.tools) ? src.tools : []) {
          const n = o?.definition?.name;
          if (typeof n !== "string" || !n || typeof o.execute !== "function" || deny.has(n) || policyDeny.includes(n) || extraByName.has(n) || ownByName.has(n)) continue;
          ownByName.set(n, { ...o, family: typeof o.family === "string" && /^own:[a-z_]{1,24}$/.test(o.family) ? o.family : "own:tools" });
        }
      }
      const allTools = turnTools(bot, { memoryOn, extra, deny }).filter((t) => !ownByName.has(t.name)).concat([...ownByName.values()].map((o) => o.definition));
      // Memories on: the memory tool is offered only when the question asks to remember or recall
      // (live re-test 2026-10-04: "what's today's date" went to memory twice — 11.5 s).
      const memoryOffered = memoryOn && (typeof opts.memoryWhen !== "function" || opts.memoryWhen(transcript) === true);
      const baseTools = allTools.filter((t) => (!extraByName.has(t.name) || offered.has(t.name)) && (memoryOffered || t.name !== "crow_memory"));
      // Tool families on intent: the quick model is offered a family only when the plain transcript
      // asks for it, or the previous turn used it (one follow-up). Extra (display) tools and memory
      // keep their own gates above. A plain question therefore goes out with no tools at all.
      // Own tools join as their own families (a per-turn wrapper; deps.toolFamilies is never changed): offered on
      // their intent lists, withheld (and so escalated on an action request) otherwise. Families off: every round.
      const famBase = opts.familiesOnIntent === true && deps.toolFamilies ? deps.toolFamilies : null;
      const ownLists = new Map();
      for (const o of ownByName.values()) ownLists.set(o.family, [...(ownLists.get(o.family) || []), ...normalizeIntentLists(o.intent)]);
      // An own tool's optional intentWhen(transcript) → boolean (PR 2.1 [r2 I8], the calendar's "add coffee Tuesday at 9"):
      // read beside its intent list, here and nowhere else. It yields to the display (opts.displayObjectWhen: "add two
      // minutes" stays a timer), and a match is an action request (actionAsked).
      const ownWhen = new Map();
      for (const o of ownByName.values()) if (typeof o.intentWhen === "function") ownWhen.set(o.family, [...(ownWhen.get(o.family) || []), o.intentWhen]);
      const displayObject = (t) => { try { return typeof opts.displayObjectWhen === "function" && opts.displayObjectWhen(t) === true; } catch { return false; } };
      const whenHit = (f, t) => { try { return (ownWhen.get(f) || []).some((fn) => fn(t) === true); } catch { return false; } };
      const ownWants = (f, t) => listMatches(phraseWords(t), ownLists.get(f)) || (whenHit(f, t) && !displayObject(t));
      const fam = famBase && ownByName.size ? {
        ...famBase,
        familyOf: (n) => ownByName.get(String(n ?? ""))?.family ?? famBase.familyOf(n),
        hasList: (f) => ownLists.has(f) || famBase.hasList(f),
        wants: (f, t) => (ownLists.has(f) ? ownWants(f, t) : famBase.wants(f, t)),
      } : famBase;
      const ownWhenAsked = [...ownWhen.keys()].some((f) => whenHit(f, transcript)) && !displayObject(transcript);
      actionAsked = (typeof opts.actionWhen === "function" && opts.actionWhen(transcript) === true) || ownWhenAsked;
      // Rule 6 ([rev2 I11], rev 2.1): an action request that names only routine objects with no backend. A calendar
      // with a Crow reminder tool at hand is a fallback turn (the reminder is offered, no escalation); anything else
      // is the can't-do line, below.
      let noBackend = null;
      let calendarFallback = false;
      // Only when no other family is wanted for this request ("text her the meeting moved to three" is a message,
      // not a calendar request): the turn's family classifier, on the non-own families of this turn's tools.
      const classifier = famBase || deps.toolFamilies || null;
      const otherWanted = () => !!classifier && baseTools.some((t) => {
        if (ownByName.has(t.name) || extraByName.has(t.name) || deps.isMemoryTool(t.name)) return false;
        const id = classifier.familyOf(t.name);
        return !!id && classifier.wants(id, transcript);
      });
      if (actionAsked && ownUnavailable.size && !otherWanted()) {
        // The routine objects the request names (routine-objects.js; kept in step with the kiosk's action intent).
        const named = namesRoutineObjects(transcript);
        if (named.length && named.every((id) => ownUnavailable.has(id))) {
          if (named.includes("calendar") && [...ownByName.values()].some((o) => o.family === "own:reminders")) calendarFallback = true;
          else noBackend = named[0];
        }
      }
      // Offered on intent: the classifier wants an own family for this transcript (or the calendar fallback offers one).
      // The own families' intent lists (the same test fam.wants runs for an own family, families on or off).
      const ownIntent = [...ownLists.keys()].some((f) => ownWants(f, transcript));
      if (calendarFallback || (fam && ownIntent)) ownOffered = true;
      const fallbackNames = calendarFallback ? [...ownByName.values()].filter((o) => o.family === "own:reminders").map((o) => o.definition.name) : [];
      const prevBase = calendarFallback
        ? new Set([...(lastFamiliesOf(device.id) || NO_FAMILIES), "own:reminders"])
        : lastFamiliesOf(device.id) || NO_FAMILIES;
      if (fam && ownIntent) ownStamp = [...ownLists.keys()].filter((f) => ownWants(f, transcript));
      if (calendarFallback) ownStamp.push("own:reminders");
      // The voice bot's own families still inside the window (voice memory) are offered too: offered only, never a
      // reason to arm the full hold, to escalate or to count as tools for the router (decided on cls0 below, as before).
      const carried = voiceKind && fam ? [...memory.carried(device.id)].filter((f) => ownLists.has(f) && !prevBase.has(f)) : [];
      const prevFam = carried.length ? new Set([...prevBase, ...carried]) : prevBase;
      // The classification is shared with the Bot Builder's "By voice on displays" line (tool-families.js classifyTools).
      const classify = (prev) => classifyTools({ baseTools, fam, transcript, prevFam: prev, isExtraTool: (n) => extraByName.has(n), isMemoryTool: (n) => deps.isMemoryTool(n) });
      const cls = classify(prevFam);
      const cls0 = carried.length ? classify(prevBase) : cls;
      const { famWanted, famOf, quickTools, famIds, unlisted } = cls;
      let tools = quickTools;
      let famAll = false;   // an escalated turn is offered every family
      if (fam) usedFamilies = new Set();
      // The family a call belongs to: the ADVERTISED tool's family first (a category call's expanded
      // name can also be an add-on's tool name), then the expanded name's.
      const callFamily = (tc, names) => {
        const ids = [fam.familyOf(tc.name), ...names.map((n) => fam.familyOf(n))].filter(Boolean);
        return ids.find((id) => id !== "addons") || ids[0] || "other";
      };
      // A must-run tool (kiosk: crow_wm on "show me …"): see the opts doc above.
      const mustX = extra.find((x) => offered.has(x.definition.name) && typeof x.must === "function" && x.must(transcript) === true) || null;
      const mustName = mustX?.definition.name;
      // The voice-actions path may have made one for this bot already (a cached bot is the same object).
      if (executor && executorBot !== bot) { try { await executor.close(); } catch {} executor = null; }
      if (!executor) executor = deps.createToolExecutor({ botDef: bot });
      // No deviceId: generateSystemPrompt stamps it as a "glasses device_id" for
      // crow_glasses_* tools, and no kiosk tool takes a device_id.
      const system = await deps.generateSystemPrompt({ botDef: bot });
      // The system message stays byte-stable turn to turn (vLLM prefix cache, review M6);
      // live state (e.g. open windows) rides on THIS turn's user message only, closed by a note
      // line, and is dropped from the saved conversation. A small model may still read it back
      // (live 2026-10-05): echoGuard lists every injected line the echo gate removes from what is
      // spoken, captioned, saved and put on a card. opts.turnContext may be a function of the plain
      // transcript: the context STRING is computed first, then wrapped and guarded.
      const optsCtx = typeof opts.turnContext === "function" ? String(opts.turnContext(transcript) || "") : opts.turnContext;
      // deps.voiceActions.turnContext({ device }) → { text, pending } (a bare string is { text }): its text joins the
      // context line (on the user message, echo-guarded, never saved); pending makes this an action turn.
      let vaCtx = null;
      if (typeof voiceActions?.turnContext === "function") {
        let v = null;
        try { v = voiceActions.turnContext({ device }); } catch (err) { log(`[voice-turn] ${device.id} voice actions turnContext failed (${err?.message || err})`); }
        if (v && typeof v.then === "function") {
          v.catch?.(() => {});
          log(`[voice-turn] ${device.id} voice actions turnContext returned a Promise (it must be synchronous); ignored`);
          v = null;
        }
        vaCtx = typeof v === "string" ? { text: v, pending: false } : v && typeof v === "object" ? { text: String(v.text || ""), pending: v.pending === true } : null;
      }
      let ctxLine = [optsCtx, vaCtx?.text].filter(Boolean).join("\n") || optsCtx;
      const userMsg = { role: "user", content: withTurnContext(ctxLine, transcript) };
      const echoGuard = [ctxLine ? TURN_CONTEXT_NOTE : null, ctxLine, mustX?.mustNote];
      const messages = [
        { role: "system", content: withSuffix(system, opts.promptSuffix) },
        ...history,
        userMsg,
      ];

      // 4. Route — on a view WITHOUT in-process display-tool turns (review M5): a
      // crow_wm timer must not make the next 2-3 plain questions "recent tool context"
      // and send them to the (possibly cold) 35B.
      const isExtraCall = (m) => {
        if (routeNeutral.has(m)) return true;
        // Own-tool calls are route-neutral too ([rev2 I2]): the next plain question stays on the quick model.
        if (m.role === "tool") return extraByName.has(m.tool_name) || ownByName.has(m.tool_name);
        if (m.role !== "assistant" || !m.tool_calls) return false;
        try { const tc = JSON.parse(m.tool_calls); return Array.isArray(tc) && tc.length > 0 && tc.every((c) => extraByName.has(c.name) || ownByName.has(c.name)); } catch { return false; }
      };
      // The router sees the PLAIN transcript, never the turnContext prefix: "[Display] Open windows: …"
      // matched TOOL_INTENT_RE ("open") and escalated every kiosk turn to the 35B (smoke 2026-10-04).
      const routeView = messages.filter((m) => !isExtraCall(m)).map((m) => (m === userMsg ? { ...m, content: transcript } : m));
      // A must-run tool that needs only a few words and an enumeration (play, open) is forced on the
      // quick model instead of being escalated: mustRoute "fast".
      // opts.noEscalate (the kiosk's post-deploy turn check): never the router, never an escalation, so the
      // turn can never start a model and its result does not depend on which model is resident.
      // Action turns (see ACTION_NOTE above). The add-on wrapper (crow_tools) is never in famIds: when the quick
      // model is not offered it, the assistant still has tools, and the router must know.
      // The voice bot also keeps an action request inside the window (voice memory actionAt) for a follow-up phrase.
      const actionTurn = actionAsked || vaCtx?.pending === true || (typeof opts.actionWhen === "function"
        && (lastAction.has(device.id) || (voiceKind && memory.actionAt(device.id) != null))
        && typeof opts.actionFollowWhen === "function" && opts.actionFollowWhen(transcript) === true);
      // A display tool offered because a window is open (or music plays) is not what this request asks for:
      // only one whose holdText/must reads the transcript as a display request is.
      const displayAsked = extra.some((x) => offered.has(x.definition.name)
        && ((typeof x.holdText === "function" && x.holdText(transcript) === true) || (typeof x.must === "function" && x.must(transcript) === true)));
      // …or, with a display tool on offer (a card or a timer is up), the request names a thing the display holds
      // ("put eggs on the list", "add two minutes"): opts.displayObjectWhen (kiosk: list, timer, card, minutes).
      const displayBacks = displayAsked || (offered.size > 0 && typeof opts.displayObjectWhen === "function" && opts.displayObjectWhen(transcript) === true);
      const wrapperWithheld = cls0.wrapperWithheld;
      // Escalate an action request when the quick model got no family tool but the assistant has some — and no
      // display tool is on offer (a display command such as "add two minutes" stays on the quick model).
      // quickBacked ([rev2 I11]): an own tool or the hand-off tool is on offer to the quick model, which can act on it.
      const quickBacked = cls0.quickTools.some((t) => ownByName.has(t.name) || t.name === "crow_handoff");
      // An own tool counts only when the request names a routine object (calendar, reminder, task…) or follows a
      // turn that was offered or used one; otherwise "email my landlord" would escalate on the reminder tool alone.
      const ownAt = lastOwn.get(device.id);
      const ownRecent = ownAt != null && now() - ownAt <= VOICE_MODE_WINDOW_MS;
      const ownCounts = namesRoutineObjects(transcript).length > 0 || ownRecent || [...prevBase].some((f) => String(f).startsWith("own:"));
      const actionWithheld = cls0.actionWithheld(actionAsked, displayBacks, (t) => ownCounts || !ownByName.has(t.name)) && !quickBacked;
      if (actionAsked) timings.action_intent = true;
      // A routine object with no backend: no model call and no escalation (a calendar falls back to a reminder instead).
      if (noBackend) {
        timings.action_no_backend = true;
        await speakLine(String(opts.cantDoText || CANT_DO_TEXT));
        return result;
      }
      if (calendarFallback) {
        // Per-turn, on the user message (the system message stays byte-stable); dropped before saving.
        timings.calendar_fallback = true;
        const note = calendarFallbackNote(fallbackNames);
        ctxLine = ctxLine ? `${ctxLine}\n${note}` : note;
        userMsg.content = withTurnContext(ctxLine, transcript);
        echoGuard.push(note, TURN_CONTEXT_NOTE);
      }
      // A voice bot with escalation off (Bot Builder) is taken as opts.noEscalate.
      const noEscalate = opts.noEscalate === true || normalizeVoiceSettings(bot).escalation === "off";
      const decision = mustX?.mustRoute === "fast" || noEscalate || calendarFallback
        ? { route: "fast", reason: noEscalate ? "no-escalate" : calendarFallback ? "calendar-fallback" : "must-fast", key: bot.fast_voice_model || deps.fastKey }
        : deps.chooseVoiceRoute(routeView, { hasTools: cls0.quickTools.length > 0 || unlisted.length > 0 || wrapperWithheld || actionWithheld, actionIntent: actionWithheld });
      // A quick-model turn that will end on the no-tool can't-do below makes no adapter at all (no model is touched).
      const noToolAhead = decision.route !== "escalate" && actionAsked && !displayBacks && !quickTools.some((t) => !extraByName.has(t.name));
      let chat = noToolAhead ? null : await deps.createChatAdapter(bot.fast_voice_model || deps.fastKey, db);
      result.route = "fast";
      if (decision.route === "escalate") {
        // The filler runs alongside the (real-timer) readiness wait. A handler is attached NOW
        // so a rejection during that wait is never an unhandledRejection (which would exit the
        // gateway); the error is kept, logged below, and the turn carries on without the filler.
        let fillerErr = null;
        const filler = say.filler().catch((err) => { fillerErr = err; });
        const ready = await readyEscalation(decision.key, db, llmSignal);
        await filler;
        if (fillerErr && !aborted() && !mute.signal.aborted) {
          console.warn(`[voice-turn] filler TTS failed: ${fillerErr.message}`);
          timings.filler_error = String(fillerErr.message || fillerErr);
        }
        if (ready.adapter) { chat = ready.adapter; result.route = "escalate"; result.escalated = true; }
        // Qwen chat templates reject a system message anywhere but first (review C1):
        // the note joins the leading system message.
        else if (budgetHit) result.degraded = "budget";   // cut by the first-audio budget, not a barge-in
        else { result.degraded = ready.reason; messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${DEGRADED_NOTE}` }; }
      }
      if (aborted()) { result.aborted = true; return result; }
      if (budgetHit) { await speakFallback("budget", false); return result; }
      // A turn the router escalated (or that fell back from an escalation) is offered every family.
      // An action-intent escalation that could not get the larger model: say so, never hand the quick model
      // every tool (with the add-on wrapper that is hundreds of tool names) to guess with.
      if (decision.reason === "action-intent" && !result.escalated) {
        timings.action_not_ready = true;
        await speakLine(String(opts.notReadyText || NOT_READY_TEXT));
        return result;
      }
      if (fam && (result.escalated || result.degraded)) { tools = baseTools; famAll = true; }
      if (fam) {
        const on = new Set(tools.map(famOf).filter((id) => typeof id === "string"));
        const all = baseTools.some((t) => famOf(t) === "addons") ? [...famIds, "addons"] : famIds;
        on.delete("addons");
        if (tools.some((t) => famOf(t) === "addons")) on.add("addons");
        timings.families = { offered: [...on].sort(), withheld: all.filter((id) => !on.has(id)).sort() };
      }
      // An action request on a turn with no tool at all: no model call. The quick model, given nothing to act
      // with, role-plays success ("I've added your appointment … I'll remind you", queue item 29).
      // "No tool" = nothing but display tools the request does not ask for (and no memory tool on offer).
      const actionable = tools.filter((t) => !extraByName.has(t.name));
      if (actionAsked && actionable.length === 0 && !displayBacks) {
        timings.action_no_tool = true;
        await speakLine(String(opts.cantDoText || CANT_DO_TEXT));
        return result;
      }
      // An own tool on offer takes a date-time with the zone's UTC offset: the zone and its offset now ride on the
      // user message (never the system message, which stays byte-stable), so the quick model can write it.
      const zoneLine = tools.some((t) => ownByName.has(t.name)) ? zoneContext(now(), opts.tz) : null;
      if (zoneLine) {
        ctxLine = ctxLine ? `${ctxLine}\n${zoneLine}` : zoneLine;
        userMsg.content = withTurnContext(ctxLine, transcript);
        echoGuard.push(zoneLine, TURN_CONTEXT_NOTE);
      }
      // The [Dates] line's "for something already past, it is the previous one" told the quick model to write last
      // Tuesday for a mistranscribed "had coffee Tuesday" (2026-10-21). On a turn that offers a write tool (Crow's own,
      // or any remote one that is not a known read: the add-on wrapper crow_tools can write) the rule is dropped from the context and from the echo guard; the
      // surfaces build the line before tools are chosen, so it is removed here, and other callers keep it.
      if (ctxLine && ctxLine.includes(PAST_DAY_RULE)
        && tools.some((t) => ownByName.has(t.name) || (!extraByName.has(t.name) && toolEffect(t.name) !== "read"))) {
        ctxLine = dropPastRule(ctxLine);
        userMsg.content = withTurnContext(ctxLine, transcript);
        for (let i = 0; i < echoGuard.length; i += 1) echoGuard[i] = dropPastRule(echoGuard[i]);
      }
      if (!chat) chat = await deps.createChatAdapter(bot.fast_voice_model || deps.fastKey, db);
      if (unlisted.length) {
        const once = `${bot.bot_id}|${unlisted.join(",")}`;
        if (!famLogged.has(once)) { famLogged.add(once); log(`[voice-turn] ${device.id} bot ${bot.bot_id}: tool families with no voice intent list are offered only on escalated turns: ${unlisted.join(", ")}`); }
      }

      // 4b. Prompt fit, against the model this turn really uses. A bound bot's skills are inlined
      // in the system message; a general assistant with many skills was ~41k tokens against the
      // 4B's 8,192 and every turn failed. Full prompt → the one without skill bodies → no call.
      const modelKey = result.escalated ? decision.key : (bot.fast_voice_model || deps.fastKey);
      // Decided on allTools (every extra counted, as the panel does), so an extra tool that is
      // hidden this turn never flips the level — and the system message — between turns.
      const fit = await promptFit({ db, bot, tools: allTools, promptSuffix: opts.promptSuffix, key: modelKey, full: withSuffix(system, opts.promptSuffix) });
      const ctx = fit.ctx;
      if (fit.level !== "full") {
        timings.prompt_fit = fit.level;
        const nums = `~${fit.est} prompt tokens with skills, ~${fit.est_no_skills} without, +${fit.reserve} reserved for the turn, context ${ctx}`;
        if (fit.level === "too_large") {
          result.failed = "bot_too_large";
          timings.failed = "bot_too_large";
          timings.est_prompt_tokens = fit.est_no_skills;
          log(`[voice-turn] ${device.id} bot ${bot.bot_id} is too large for ${modelKey} even without its skills (${nums}); no model call`);
          const line = String(opts.tooLargeText || BOT_TOO_LARGE_TEXT);
          sink.event({ type: "caption_delta", text: line });
          try { await say.force(line); } catch (err) { log(`[voice-turn] ${device.id} could not speak the too-large line: ${err.message}`); }
          // A barge-in over the line: aborted, but failed stays — the assistant still cannot answer here.
          if (aborted()) { result.aborted = true; return result; }
          say.end();
          fail("bot_too_large", false);
          return result;
        }
        // A degraded escalation's note joined the full message above; it joins the lean one the same way.
        messages[0] = { ...messages[0], content: result.degraded ? `${fit.system}\n\n${DEGRADED_NOTE}` : fit.system };
        const once = `${device.id}|${bot.bot_id}|${modelKey}`;
        if (!fitLogged.has(once)) {
          fitLogged.add(once);
          log(`[voice-turn] ${device.id} bot ${bot.bot_id} runs without its skills on ${modelKey}: the full prompt does not fit (${nums})`);
        }
      }

      // 5. Streamed tool loop
      const scope = deps.botVoiceScope(bot);
      const policy = bot.permission_policy || {};
      const shortName = (n) => String(n || "").replace(/^crow_/, "").replace(/_/g, " ");
      // → null (run it) or { code, message, neutral }: `code` goes to the log, `message` to the model;
      // neutral = the tool is simply not on this display / not offered (invisible to the router).
      const refuse = (code, message, neutral = false) => ({ code, message, neutral });
      // What was sent with THIS round's request (set again each round below: a narrowed first round sends one tool).
      let offeredNames = new Set(tools.map((t) => t.name));
      const offeredCheck = {
        categoryOf: typeof deps.toolCategory === "function" ? deps.toolCategory : () => null,
        selectedAddon: (n) => !!scope && scope.selectedToolNames.has(n) && deps.isConnectedAddonTool(n),
      };
      const policyGate = (tc) => {
        // Crow's own tools run in-process and are offered by name: none of the remote-tool checks below (spoken
        // yes, proxy args) apply; they confirm through the voice bot's own settings (Task 2.5).
        if (ownByName.has(tc.name)) {
          return wasOffered(tc, offeredNames) ? null
            : refuse("not_offered", `"${shortName(tc.name)}" is not available here. Tell the user you can't do that here, then end your turn — do not call another tool.`, true);
        }
        const eff = deps.effectiveToolName(tc);
        // The executor resolves a bare name (`search_memories`) to `crow_<name>`
        // (tool-executor resolveToolCategory), so every check sees both spellings.
        const names = eff && !String(eff).startsWith("crow_") ? [eff, `crow_${eff}`] : [eff];
        const soft = SOFT_DENY[tc.name] || names.map((n) => SOFT_DENY[n]).find(Boolean);
        if (soft && (deny.has(tc.name) || names.some((n) => deny.has(n)))) return refuse("refused_policy", soft, true);
        if (names.some((n) => deny.has(n)) || deny.has(tc.name)) return refuse("refused_policy", `"${shortName(eff)}" is not available on this display. Tell the user, then end your turn — do not call another tool.`, true);
        if (names.some((n) => deps.isMemoryTool(n))) {
          if (!memoryOn) return refuse("refused_policy", MEMORY_OFF, true);
          if (!memoryOffered) return refuse("not_offered", MEMORY_NOT_ASKED, true);
        }
        // A family that is not on offer this turn is never run, whatever the model calls (saved history
        // holds earlier calls, and a small model repeats them).
        if (fam && !extraByName.has(tc.name) && !names.some((n) => deps.isMemoryTool(n))) {
          const id = callFamily(tc, names);
          const on = famAll || (id === "addons" || id === "other" ? tools.some((t) => t.name === tc.name) : famWanted(id));
          if (!on) return refuse("not_offered", FAMILY_NOT_OFFERED, true);
        }
        // Never run a tool this round did not offer (an endpoint's extra tools have their own not-offered path below).
        if (!extraByName.has(tc.name) && !wasOffered(tc, offeredNames, offeredCheck)) {
          return refuse("not_offered", `"${shortName(eff)}" is not available here. Tell the user you can't do that here, then end your turn — do not call another tool.`, true);
        }
        if (scope && deps.isConnectedAddonTool(eff) && !scope.selectedToolNames.has(eff)) {
          return refuse("refused_policy", `This assistant isn't allowed to use "${shortName(eff)}" by voice. Tell the user and end your turn — do not call another tool.`);
        }
        if (policy.external_send === "draft_only" && deps.isExternalSendTool(eff)) {
          return refuse("refused_policy", `This assistant is draft-only by voice and cannot send "${shortName(eff)}" externally. Tell the user it was not sent. Then end your turn — do not call another tool.`);
        }
        if (Array.isArray(policy.deny) && names.some((n) => policy.deny.includes(n))) {
          return refuse("refused_policy", `This assistant is not permitted to use "${shortName(eff)}" by voice. Tell the user and end your turn — do not call another tool.`);
        }
        // The voice bot (kind "voice"): never schedules background bot work, and asks a spoken yes
        // before anything that deletes, changes or sends, and before a schedule or a context change.
        // A proxied call runs with params alone: a top-level copy that disagrees would make the question name
        // values that never run (a spoofed yes). Refused outright, before any question.
        const via = isProxyCall(tc) ? tc.name : null;
        if (voiceKind && via && proxyArgsConflict(tc)) return refuse("refused_policy", VOICE_ARGS_CONFLICT);
        if (voiceKind && names.some((n) => VOICE_SCHEDULE_TOOLS.has(n)) && startsPipeline(tc.arguments)) return refuse("refused_policy", VOICE_NO_PIPELINE);
        if (voiceKind && names.includes("crow_update_schedule") && reenablesUnseen(tc.arguments)) return refuse("refused_policy", VOICE_NO_REENABLE);
        // A turn whose words were rewritten ("had …" heard, "add …" taken: timings.stt_rewrite) asks before anything
        // that is not a known read, a remote create included: the rewrite may have turned a past-tense remark into a
        // request. Display tools are never held (they are not routine writes). A call already waiting for a yes on
        // this device (same name and args) goes through the gate on every later turn too: only a yes runs it.
        const rewritten = timings.stt_rewrite != null && !extraByName.has(tc.name);
        const confirmName = names.find((n) => isDestructiveTool(n) || (Array.isArray(policy.confirm) && policy.confirm.includes(n))
          || (voiceKind && (needsSpokenYes(n) || VOICE_CONFIRM_TOOLS.includes(n)
            || (n === VOICE_NOTIFICATION_TOOL && changesNotifications(tc))
            || (rewritten && (toolEffect(n) !== "read" || toolEffect(tc.name) === "write")))))
          || names.find((n) => typeof confirm.has === "function" && confirm.has({ deviceId: device.id, eff: n, args: tc.arguments }));
        if (!confirmName) return null;
        // A question will be asked: every field it can name (ids, the recipient) must agree with what runs too.
        if (voiceKind && via && proxyArgsConflict(tc, { asking: true })) return refuse("refused_policy", VOICE_ARGS_CONFLICT);
        // crow_tools' flat fallback runs locally but not on its remote route: a yes could confirm values that never run.
        if (voiceKind && reliesOnFlatFallback(tc)) return refuse("refused_policy", VOICE_ARGS_FLAT);
        if (confirm.check({ deviceId: device.id, eff: confirmName, args: tc.arguments, transcript }) === "allow") return null;
        return refuse("needs_confirm", `Confirmation required. Tell the user: "Are you sure you want to ${describeDestructiveAction({ name: confirmName, arguments: tc.arguments }, { via })}? Say yes to proceed." Then end your turn — do not call another tool.`);
      };

      // First chunk = first clause (latency lever 3); later chunks are whole sentences. On a sentence-gated turn
      // (gateOn, below) every chunk passes the gate first: it is captioned and spoken only when it claims nothing.
      const chunker = createSentenceChunker((s) => (gateOn ? gateChunk(s) : say(s)), { firstClause: opts.firstClause !== false });
      // Tool rounds are capped (kiosk: 3). When the cap is hit — or the model calls the same tool(s)
      // twice in a row with nothing user-visible in between (no speech, no display change) — one
      // final round runs with the SAME tool list (the prefix cache stays warm) and a stop note on
      // the last tool result; any call it makes is ignored. No text from it → the fallback.
      const maxRounds = Number.isInteger(opts.maxToolRounds) && opts.maxToolRounds > 0 ? opts.maxToolRounds : (deps.maxToolRounds || 10);
      let rounds = 0;
      let toolRounds = 0;
      let nextMax = 600;
      let spokenChars = 0;
      let displayProgress = false;
      // Speech that reads as an ANSWER, not a preamble: any words after the first tool round, or a
      // long first round. A silent forced final round after a real answer is not a failure.
      let answeredChars = 0;
      let cut = null;
      let finalRound = false;
      let finalSpoken = 0;
      let lastStuckSig = null;
      const restores = [];           // notes appended to a message for one request: undone before saving
      const appendNote = (msg, note) => {
        restores.push({ msg, content: msg.content });
        msg.content = `${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}\n\n${note}`;
      };
      let overflow = false;
      let mustDone = !mustX;         // the must-run tool has succeeded this turn (true when there is none)
      let corrected = false;
      const toolLog = [];
      // On a must-run turn the first (and the corrective) round offers only the must-run tool, so a
      // forced call can be used where the engine honours one — unless another tool family is on
      // offer this turn (the model may need to fetch before it shows).
      // Which forced-call forms this model's engine honours (never "required" where it is not known to).
      let forcing = LEGACY_FORCING;
      if (mustX && typeof deps.toolForcing === "function") { try { forcing = (await deps.toolForcing(modelKey, db)) || LEGACY_FORCING; } catch { forcing = { named: true, required: false, engine: "unknown" }; } }
      const firstMode = forcing.named ? "named" : forcing.required ? "required" : "none";
      const narrow = !!mustX && (typeof mustX.narrow !== "function" || mustX.narrow(transcript) !== false)
        && (mustX.mustRoute === "fast" || tools.every((t) => extraByName.has(t.name)));
      // On a turn whose words ask a display tool for something (holdText), a round's text is DEFERRED:
      // not captioned and not spoken until that round's calls are known. No display call → the text is
      // released. A display call → the text is dropped, and the tool's result says what really happened.
      const holdIntent = extra.some((x) => offered.has(x.definition.name) && typeof x.holdText === "function" && x.holdText(transcript) === true);
      // holdToEnd (a compound request, "close the timer and then show me a list"): nothing the model says is
      // heard until the turn is over. The turn then ends on the server's own lines for the display calls
      // that did something; the model's closing sentence could claim the half that never happened. With
      // no such call, the model's last text is released at the end (a plain answer, only later).
      const holdEnd = extra.some((x) => offered.has(x.definition.name) && typeof x.holdToEnd === "function" && x.holdToEnd(transcript) === true);
      const endLines = [];
      let heldLast = "";
      let endedFinal = false;
      timings.tools_offered = tools.length;
      // The action guard (see ACTION_NOTE above). A must-run or hold-to-end display turn has its own truth rules.
      // Own tools are offered on turns the display's actionWhen does not read as actions ("put buy milk on my
      // tasks", "move it to 3", families off), and a model streams its words BEFORE the round's calls run. So the
      // guard is also on from the first word when the turn targets an own tool on offer: an own family's intent,
      // a named routine object, or a follow-up inside the own-tool window (families on or off). A turn that is
      // only offered the own tools ("what's the capital of Peru") is not held. It also turns on mid-turn when an
      // own call fails or is refused (armGuard below); then only what the model says in LATER rounds is held.
      // Once any own call has failed (and was not cleared: see ownFails below), the guard keeps holding even after
      // another call succeeded, and the turn ends on what really happened (ownEndLine), also when the first-audio
      // budget has run out: released held text that claims nothing, each ok own call's success line, the failure
      // line (the failed tool's own say, else PARTLY_DONE_TEXT when something was done, else NOT_DONE_TEXT), and
      // last a confirmation question still waiting for a yes. A held claim is never heard.
      let actionGuard = actionTurn && !mustX && !holdEnd;
      const armGuard = () => { if (!actionGuard && !mustX && !holdEnd) { actionGuard = true; timings.action_guard = true; } };
      const ownOnOffer = tools.some((t) => ownByName.has(t.name));
      // The full hold on an own tool: only when the transcript itself reads as one (PR 2.1 [r2 C1]). This is the one
      // place a further reading of the words joins: ownIntent carries each own tool's intentWhen (the calendar's
      // add-matcher). The voice bot no longer arms it on the own-tool window alone (ownRecent): a turn that only
      // carries context gets the sentence gate below instead, so plain questions keep streaming. Any other bot keeps
      // the window as a reason (it has no sentence gate).
      const ownActionWords = ownIntent || namesRoutineObjects(transcript).length > 0;
      if (ownOnOffer && (ownActionWords || (!voiceKind && ownRecent))) armGuard();
      // The voice bot, an own tool on offer only because its family carried over (the voice memory, or the previous
      // turn's lastFamilies), on a turn that is not an add request: a stray call on it never steps up to the larger
      // model, and a write asks first (the routine confirm; nothing is written until a spoken yes). A real follow-up
      // (the words, actionFollowWhen) is not carried-only and runs directly.
      const ownCarriedOnly = voiceKind && !!fam && !ownActionWords && !actionTurn && !actionAsked
        && tools.some((t) => ownByName.has(t.name) && !fam.wants(ownByName.get(t.name).family, transcript));
      const ownDone = new Map();   // name|canonical args → the result of an own call that returned ok (never run twice)
      // The one retry after a blocked claim (PR 2.1 [r2 C3, I4]): only on an add request (the words, never a change, a
      // cancel or a question about what was done), with an own tool on offer and none called, never carried-only. It
      // forces the own tool where the engine honours that (named, then required), else steps up to the larger model
      // once; its text is held as usual. A forced call that repeats a write on record writes nothing.
      let followUp = false;
      try { followUp = typeof opts.actionFollowWhen === "function" && opts.actionFollowWhen(transcript) === true; } catch { followUp = false; }
      // The calendar's add-matcher (intentWhen) reading the words as an add overrides a change word.
      const changeAsked = !ownWhenAsked && asksChange(transcript, followUp);
      const addAsked = (actionAsked || ownIntent) && !changeAsked && !asksQuestion(transcript);
      let retryRound = 0;          // the round the retry runs in (0: none)
      let retryTools = null;       // what the retry round offers (the own tools the words want)
      let retryName = null;        // the named choice for it (one own tool)
      let retryMode = "none";
      let retryTried = false;      // the retry was due: it ran, or could not (no forcing and no step-up)
      const turnWrites = new Map();   // writeKey → the result of an own write that returned ok this turn
      let backed = false;          // a tool really did something this turn
      let memoryBacked = false;    // only a memory call did (a saved note is not a reminder)
      let unsureBacked = false;    // an ok call to a tool that is neither a known read nor a known write
      let guardHeld = "";
      // Own calls that were not ok, by name|canonical args → { name, say, validation, round }. An ok own call clears
      // the same call's failure. A validation failure (bad_args, no_tz) is also cleared by a later ok call of the
      // SAME tool (the corrected retry) or by an own call that really RAN ok in a LATER round (the step-up picking
      // another tool), never by another tool's ok call in the same round, nor by a replay from the turn's cache. A backend error or a refusal on other args stays.
      const ownFails = new Map();
      const ownOkSays = new Map(); // name|canonical args → the success line of an ok own call that changed something
      let ownAsk = "";             // the last own confirmation question that really ran (needs_confirm): the live pending entry
      let ownEndLead = "";         // a final display line that the own-tool ending speaks first
      const holding = () => actionGuard && (!backed || ownFails.size > 0 || !!ownAsk);   // a pending question keeps the hold: it ends the turn
      // The own-tool ending (an own call failed): held text that claims nothing, the ok own calls' lines, the failure
      // line (the failed tool's own say, else partly done when something was done, else not done), and LAST the
      // confirmation question, if one is waiting for a yes.
      const ownEndLine = (released = "") => {
        let failLine = null;
        for (const f of ownFails.values()) if (!failLine && f.say) failLine = f.say;
        if (ownFails.size > 0) failLine ||= String(backed || memoryBacked ? (opts.partlyDoneText || PARTLY_DONE_TEXT)
          : unsureBacked ? (opts.unsureText || UNSURE_TEXT) : (opts.notDoneText || NOT_DONE_TEXT));
        return [...new Set([released, ownEndLead, ...ownOkSays.values(), failLine, ownAsk].filter(Boolean))].join(" ");
      };
      let actionSent = false;      // a change was sent to a remote tool (it may still complete after a budget cut)
      let steppedUp = false;       // the own-tool step-up to the larger model (at most once per turn)
      const toolEscalationOn = typeof deps.toolEscalationEnabled !== "function" || deps.toolEscalationEnabled() === true;
      const heldMsgs = new Set();  // assistant messages whose text was held (unheard unless released)
      // What is kept as said is what was heard: held text that is not heard never reaches the saved conversation.
      // keep(m) → true keeps an assistant message as it is; any other loses its text (a tool-call message) or goes.
      const dropHeld = (keep) => {
        for (let i = messages.length - 1; i > messages.indexOf(userMsg); i--) {
          const m = messages[i];
          if (m.role !== "assistant" || keep(m)) continue;
          if (m.tool_calls) messages[i] = { ...m, content: "" };
          else messages.splice(i, 1);
        }
      };
      // The sentence gate (PR 2.1 [r2 C2], #499): every other voice-bot turn while the voice memory holds an own entry
      // inside the window. The text streams sentence by sentence; each one is captioned and spoken only after
      // claimsAction() reads it. The first claim no tool backs mutes the rest (the guard is armed, so later rounds are
      // held too) while the round finishes and its calls still run; the ending then says what is true (see the end).
      const gateOn = voiceKind && !actionGuard && !mustX && !holdEnd && !!device?.id && memory.active(device.id);
      let gateHit = false;         // a sentence was blocked this turn
      let gateRound = 0;           // the round it was blocked in (that round's text keeps going through the chunker, in order)
      let gateBlocked = "";        // the first blocked sentence (what a recap must refer to)
      let gateHeard = "";          // the model text that passed the gate (heard and captioned)
      let gatePending = "";        // the current sentence's part that already passed (a first clause)
      let gateAfter = false;       // model text was heard after the block
      let roundMuted = 0;          // characters the gate muted this round
      const gateLines = [];        // the server's lines spoken after the block (saved after what was heard)
      const gateRouting = () => gateOn && gateHit && gateRound === rounds;
      const gateChunk = async (chunk) => {
        if (gateHit && holding()) { guardHeld += chunk; roundMuted += chunk.trim().length; return; }
        const sentence = gatePending + chunk;
        if (!backed && (memoryBacked ? claimsBeyondMemory(sentence) : claimsAction(sentence))) {
          if (!gateHit) {
            gateHit = true;
            gateBlocked = sentence;
            timings.claim_blocked = true;
            timings.claim_gate = "sentence";
            log(`[voice-turn] ${device.id} bot ${bot.bot_id}: a sentence claiming an action no tool did was muted`);
          }
          gateRound = rounds;
          armGuard();
          guardHeld += chunk;
          roundMuted += chunk.trim().length;
          gatePending = "";
          return;
        }
        gatePending = SENTENCE_END.test(`${chunk.trimEnd()} `) ? "" : sentence;
        if (gateHit) gateAfter = true;
        gateHeard += chunk;
        sink.event({ type: "caption_delta", text: chunk });
        await say(chunk);
      };
      // (ii) The truthful recap of the last own write, when the blocked sentence refers to it: the same object, a word
      // of its title, or "it"/"that". "" otherwise.
      const RECAP_OBJECT = { crow_calendar_add_event: "calendar", crow_reminder_add: "reminders", crow_task_add: "tasks" };
      // Spanish "lo"/"la" are also articles and other objects' pronouns ("la he enviado"): only "eso" refers here.
      const RECAP_REFS = new Set(["it", "that", "eso"]);
      const recapFor = (text) => {
        const w = memory.lastWrite(device.id);
        if (!w) return "";
        const words = phraseWords(text);
        const obj = RECAP_OBJECT[w.tool];
        const titleWords = phraseWords(w.title || "").filter((x) => x.length >= 3);
        const refers = (obj && listMatches(words, ROUTINE_OBJECT_LISTS[obj])) || words.some((x) => RECAP_REFS.has(x) || titleWords.includes(x));
        // A content word the record does not hold ("Added coffee…" after a lunch write) is another item: no recap.
        const foreign = words.some((x) => x.length >= 3 && !RECAP_FILLER.has(x) && !/^\d/.test(x) && !titleWords.includes(x) && !objectWord(x));
        return refers && !foreign ? lastWriteRecap(w, opts.lang || w.lang) : "";
      };
      // The claim retry is due (see changeAsked above): a claim was blocked (the full hold's held text, or the sentence
      // gate) and nothing was done, on an add request with an own tool on offer and none called.
      const retryDue = () => addAsked && retryWanted().length > 0 && !ownCarriedOnly && !mustX && !holdEnd && !calendarFallback && !finalRound
        && !backed && !memoryBacked && !unsureBacked && !actionSent && !calledTools.some((n) => ownByName.has(n))
        && (gateHit || (actionGuard && claimsAction(guardHeld.trim())));
      // The hint instead of the not-done line: the retry was due (it ran with no call, or could not run), or the claim was
      // about a change or a cancel, with an own tool on offer (Crow's own tools only add).
      // "I can only add new items by voice" is false while another write tool is on offer: then the not-done line.
      const otherWrite = tools.some((t) => !ownByName.has(t.name) && !extraByName.has(t.name) && !deps.isMemoryTool(t.name) && toolEffect(t.name) !== "read");
      const hintDue = () => ownOnOffer && !otherWrite && (retryTried || changeAsked);
      const hintLine = () => { timings.claim_hint = true; return String(opts.hintText || HINT_TEXT); };
      // Only the own tools the words want: a request no own family reads as its own ("send a text to mom") is never forced
      // onto one, and never steps up for one.
      const retryWanted = () => tools.filter((t) => ownByName.has(t.name) && ownWants(ownByName.get(t.name).family, transcript));
      // → true when the retry round is set up (the loop goes on), false when it cannot run (the hint ends the turn).
      const startRetry = async (claimMsg) => {
        const pick = retryWanted();
        let rf = LEGACY_FORCING;
        if (typeof deps.toolForcing === "function") { try { rf = (await deps.toolForcing(modelKey, db)) || LEGACY_FORCING; } catch { rf = { named: true, required: false, engine: "unknown" }; } }
        const name = pick.length === 1 ? pick[0].name : null;
        const first = rf.named && name ? "named" : rf.required ? "required" : "none";
        // The step-down this model already showed (named → required → none) is reused.
        const seen = toolChoiceMode.get(modelKey);
        const learned = seen && now() - seen.at < LEARNED_TTL_MS ? seen.mode : null;
        const mode = learned && WEAKER[learned] < WEAKER[first] && (learned !== "required" || rf.required === true) ? learned : first;
        if (mode === "none") {
          // Nothing can be forced here (llama.cpp): the own-tool step-up, once, with its filler, where it may run.
          if (steppedUp || result.escalated || result.degraded || noEscalate || !toolEscalationOn || budgetHit) return false;
          steppedUp = true;
          let fillerErr = null;
          const filler = say.filler().catch((err) => { fillerErr = err; });
          const ready = await readyEscalation(deps.escalateKey ?? decision.key, db, llmSignal);
          await filler;
          if (fillerErr && !aborted() && !mute.signal.aborted) {
            log(`[voice-turn] ${device.id} filler TTS failed: ${fillerErr.message}`);
            timings.filler_error = String(fillerErr.message || fillerErr);
          }
          if (aborted() || budgetHit || !ready.adapter) { if (!ready.adapter) timings.step_up_degraded = ready.reason; return false; }
          chat = ready.adapter;
          result.route = "escalate";
          result.escalated = true;
          timings.claim_retry = "step_up";
        } else forcing = rf;
        retryMode = mode;
        retryName = name;
        retryTools = pick;
        retryRound = rounds + 1;
        // The blocked claim is not what the model reads back before its retry (it was never heard either).
        if (claimMsg && !claimMsg.tool_calls && messages.at(-1) === claimMsg) messages.pop();
        const note = claimRetryNote(pick.map((t) => t.name));
        echoGuard.push(note);
        appendNote(userMsg, note);
        log(`[voice-turn] ${device.id} bot ${bot.bot_id}: a blocked claim with no call; one retry (${mode === "none" ? "step_up" : mode})`);
        return true;
      };
      if (actionGuard) {
        timings.action_guard = true;
        if (actionable.length === 0) {
          // A follow-up with no tool: told so in the context block, and kept short (it is held to the end).
          userMsg.content = withTurnContext(ctxLine ? `${ctxLine}\n${ACTION_NOTE}` : ACTION_NOTE, transcript);
          echoGuard.push(ACTION_NOTE, TURN_CONTEXT_NOTE);
          nextMax = Math.min(nextMax, ACTION_HELD_MAX_TOKENS);
        }
      }
      while (!budgetHit) {
        rounds++;
        const think = createThinkGate();
        const toolText = createToolSyntaxGate();   // r7 G3: tool-call syntax written as text is never heard
        const echo = createContextEchoGate(echoGuard);
        let content = "";
        let roundSpoken = 0;
        let roundHeld = 0;           // characters the action guard held this round
        roundMuted = 0;
        let calls = [];
        // Until the must-run tool has succeeded, nothing the model says is captioned or spoken:
        // "I've displayed the list" is only true after the call.
        const hold = !mustDone || holdEnd;
        const defer = !hold && holdIntent && !finalRound;
        let deferred = "";
        let heldRound = "";
        const retrying = retryRound === rounds;
        const roundTools = retrying ? retryTools : narrow && !mustDone && !finalRound ? [mustX.definition] : tools;
        offeredNames = new Set(roundTools.map((t) => t.name));   // the offered-tools guard checks what this request really carried
        let roundText = "";
        let finalRes = null;
        const roundMax = nextMax;
        nextMax = 600;
        // Keep prompt + completion inside the model's context (review M6: the 4B is 8192;
        // tool schemas alone are ~5k tokens). ~3.2 chars/token is a deliberate over-estimate.
        let estPrompt = estimatePromptTokens(messages, roundTools);
        // Never send a request that cannot fit (every round: history and tool results grow). Saved
        // history goes first, oldest exchange first; the system message and this turn stay.
        for (let n; !requestFits(estPrompt, ctx) && (n = dropOldestExchange(messages, userMsg)) > 0;) {
          timings.history_dropped = (timings.history_dropped || 0) + n;
          estPrompt = estimatePromptTokens(messages, roundTools);
        }
        timings.est_prompt_tokens = estPrompt;
        if (!requestFits(estPrompt, ctx)) {
          log(`[voice-turn] ${device.id} round ${rounds} not sent: ~${estPrompt} prompt tokens do not fit ${modelKey} (context ${ctx}) with no saved history left`);
          overflow = true;
          break;
        }
        const maxTokens = ctx ? Math.max(64, Math.min(roundMax, ctx - estPrompt - 128)) : roundMax;
        timings.max_tokens = maxTokens;   // with est_prompt_tokens in [kiosk-metrics]; the smoke records both
        // tool_choice requires the must-run tool while it is the ONLY tool offered (with others the
        // model may need to fetch first; the backstop below still applies). Backends differ: a vLLM
        // server honours a named choice; the llama.cpp builds in use accept and ignore it.
        const seen = toolChoiceMode.get(modelKey);
        const learned = seen && now() - seen.at < LEARNED_TTL_MS ? seen.mode : null;
        // A learned "required" is used only while the engine is still known to honour it (the model key may
        // now be served by another engine).
        const usable = learned && WEAKER[learned] < WEAKER[firstMode] && (learned !== "required" || forcing.required === true);
        let choiceMode = retrying ? retryMode : !mustDone && !finalRound && roundTools.length === 1 ? (usable ? learned : firstMode) : "none";
        // The round's forced name: the must-run tool, or the own tool the claim retry forces.
        const forcedName = retrying ? retryName : mustName;
        let steppedDown = false;
        for (;;) {
          const toolChoice = choiceMode === "named" ? { name: forcedName } : choiceMode === "required" ? "required" : null;
          let started = false;
          try {
            for await (const ev of chat.chatStream(messages, roundTools, { temperature: 0.7, maxTokens, chatTemplateKwargs: { enable_thinking: false }, signal: llmSignal, ...(toolChoice ? { toolChoice } : {}) })) {
              started = true;
              if (aborted() || budgetHit) break;
              if (ev.type === "content_delta" && ev.text) {
                mark("llm_first_token_ms");
                content += ev.text;
                const spoken = echo.feed(toolText.feed(think.feed(ev.text)));
                // The round the sentence gate muted keeps going through the chunker, so its text stays in order.
                if (spoken && holding() && !gateRouting()) { guardHeld += spoken; roundHeld += spoken.trim().length; }
                else if (spoken && defer) deferred += spoken;
                else if (spoken && holdEnd) heldRound += spoken;
                else if (spoken && !hold) {
                  roundText += spoken;
                  if (spoken.trim()) { roundSpoken += spoken.trim().length; spokenChars += spoken.trim().length; }
                  if (!gateOn) sink.event({ type: "caption_delta", text: spoken });   // gated: captioned sentence by sentence
                  await chunker.push(spoken);
                }
              } else if (ev.type === "tool_call") {
                mark("llm_first_token_ms");
                // A display card's text gets the same guard as speech (kept that way in the saved call).
                calls.push({ id: ev.id, name: ev.name, arguments: extraByName.has(ev.name) ? stripContextEchoDeep(ev.arguments, echoGuard) : ev.arguments });
              } else if (ev.type === "done") break;
            }
          } catch (err) {
            if (budgetHit) break;   // the budget's own abort surfacing from the provider fetch
            // The backend refused the request (400/422 before any output) and it carried a tool_choice:
            // step down and send the same round again. The step is remembered for this model only
            // once the weaker request goes through — that is what shows tool_choice was the cause.
            if (toolChoice && !started && !aborted() && err?.code === "provider_error" && (err.status === 400 || err.status === 422)) {
              const next = choiceMode === "named" && forcing.required ? "required" : "none";
              log(`[voice-turn] ${device.id} ${modelKey} refused a request with tool_choice ${choiceMode} (HTTP ${err.status}); trying ${next}`);
              choiceMode = next;
              steppedDown = true;
              content = ""; calls = [];
              continue;
            }
            throw err;
          }
          if (steppedDown) toolChoiceMode.set(modelKey, { mode: choiceMode, at: now() });
          break;
        }
        if (mustX && timings.tool_choice === undefined) timings.tool_choice = choiceMode;
        if (retrying && timings.claim_retry !== "step_up") timings.claim_retry = choiceMode;   // "none": a refused forced request stepped down
        // Text the gates still held (it could have been the start of tool syntax or of an echo) is decided now.
        const held = toolText.flush();
        if (toolText.cut) { timings.tool_text = true; content = stripToolSyntax(content); }
        const tail = (held ? echo.feed(held) : "") + echo.flush();
        if (tail && holding() && !gateRouting()) { guardHeld += tail; roundHeld += tail.trim().length; }
        else if (tail && !hold && !aborted() && !budgetHit) {
          if (tail.trim()) { roundSpoken += tail.trim().length; spokenChars += tail.trim().length; }
          if (!gateOn) sink.event({ type: "caption_delta", text: tail });
          await chunker.push(tail);
        }
        // What is kept as said is what was heard: an echo saved in the history invites the next one.
        content = stripContextEcho(content, echoGuard);
        if (aborted()) { result.aborted = true; break; }
        if (budgetHit) break;
        if (holdEnd) heldLast = heldRound;
        const displayCall = calls.some((c) => extraByName.has(c.name));
        if (defer && deferred && !displayCall) {
          // No display call came with it: the deferred text is the answer after all.
          roundText += deferred;
          if (deferred.trim()) { roundSpoken += deferred.trim().length; spokenChars += deferred.trim().length; }
          if (!gateOn) sink.event({ type: "caption_delta", text: deferred });
          await chunker.push(deferred);
        }
        // A gated turn decides each round's text before its calls run: the last part of a sentence is read now.
        if (gateOn && !aborted() && !budgetHit) await chunker.flush();
        if (finalRound) {
          // The forced answer: its text is kept, any call it still makes is ignored (never executed,
          // never saved — an unanswered tool call would break the next turn's template).
          finalSpoken = roundSpoken;
          if (calls.length) log(`[voice-turn] ${device.id} final round ignored tool call(s): ${calls.map((c) => c.name).join(", ")}`);
          if (content) messages.push({ role: "assistant", content });
          break;
        }
        let assistantMsg = null;
        const kept = hold || (defer && displayCall) ? "" : content;   // held or dropped text was never heard: it is not kept as something said
        if (kept || calls.length) {
          assistantMsg = { role: "assistant", content: kept };
          if (calls.length) assistantMsg.tool_calls = JSON.stringify(calls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })));
          messages.push(assistantMsg);
          if (roundHeld > 0) heldMsgs.add(assistantMsg);
        }
        if (!calls.length) {
          if (mustDone && !retryRound && !retryTried && retryDue()) {
            retryTried = true;
            if (await startRetry(assistantMsg)) continue;
            break;
          }
          if (mustDone) break;
          // The model's turn ended with nothing on the screen. Its text was held back and is dropped
          // (never spoken, never saved). One corrective round, then the truthful line (after the loop).
          if (corrected) break;
          corrected = true;
          timings.display_corrected = true;
          log(`[voice-turn] ${device.id} round ${rounds}: no ${logName(mustName)} call on a turn that needs one; one corrective round`);
          appendNote(messages.at(-1), mustX.mustNote || MUST_RUN_NOTE);
          continue;
        }
        toolRounds++;
        for (const c of calls) calledTools.push(String(c.name));
        const roundSig = [...new Set(calls.map((c) => String(c.name)))].sort().join("+");
        timings.tool_rounds = toolRounds;
        // Each call's OUTCOME — name:code, never arguments or result text — in the log and in
        // timings.tools (live re-test 2026-10-04: a display call changed nothing and nobody could say why).
        const outcome = new Map();
        const noteRound = () => {
          const parts = calls.map((c) => `${logName(c.name)}:${outcome.get(c) || "pending"}`);
          toolLog.push(parts.join("+"));
          timings.tools = toolLog.slice();
          log(`[voice-turn] ${device.id} round ${rounds}: ${parts.join(", ")}`);
        };
        const local = [];
        const remote = [];
        let roundDisplay = false;
        // Route-neutral = in-process display tools + calls refused because the tool is not on this
        // display (deny list / memory off). Confirm and policy refusals still count as tool context:
        // the "yes" that follows a confirmation must keep its escalation (review I3).
        let neutralCalls = 0;
        let ownBadArgs = false;
        for (const tc of calls) {
          if (tc === calls.at(-1)) finalRes = null;
          const gate = policyGate(tc);
          if (gate) {
            if (ownByName.has(tc.name)) { armGuard(); ownFails.set(`${tc.name}|${canonicalArgsHash(tc.arguments || {})}`, { name: tc.name, say: null, validation: false, round: rounds }); }   // an own call refused: the model's next words may still claim it
            if (gate.neutral) neutralCalls++;
            outcome.set(tc, gate.code);
            local.push({ id: tc.id, name: tc.name, result: gate.message, neutral: gate.neutral });
            continue;
          }
          // Crow's own tool: run in-process, before the remote list. Route-neutral, like a display tool.
          const own = ownByName.get(tc.name);
          if (own) {
            neutralCalls++;
            // The same call (name + canonical args) that already returned ok this turn — a parallel duplicate, or a
            // re-run after a step-up — gets the earlier result back and is never executed again (no second row).
            const dupKey = `${tc.name}|${canonicalArgsHash(tc.arguments || {})}`;
            let out = ownDone.get(dupKey);
            // From the claim retry on, a call that repeats a write on record (this turn's, or the last own write inside the
            // window: same tool, title and start) gets that write's result back and writes nothing ([r2 I4]).
            const wk = writeKey(tc.name, argsWrite(tc.arguments).title, argsWrite(tc.arguments).start);
            if (out === undefined && retryRound && wk) {
              const lw = voiceKind && device?.id ? memory.lastWrite(device.id) : null;
              out = turnWrites.get(wk);
              if (out === undefined && lw && writeKey(lw.tool, lw.title, lw.start) === wk) {
                out = JSON.stringify({ ok: true, code: "duplicate", effect: false, final: true, say: lw.say || lastWriteRecap(lw, opts.lang || lw.lang) });
              }
              if (out !== undefined) timings.claim_dedupe = true;
            }
            const ran = out === undefined;   // a cached result never re-asks: its question is no longer the pending one
            if (ran) {
              try { out = await own.execute(tc.arguments || {}, { transcript, executor, db, device, ...(calendarFallback ? { fallback: "calendar" } : {}), ...(ownCarriedOnly || timings.stt_rewrite != null ? { confirm: true } : {}) }); }
              catch (err) { out = JSON.stringify({ ok: false, code: "error", message: String(err?.message || err) }); }
              if (typeof out !== "string") out = JSON.stringify({ ok: false, code: "error" });
            }
            let res = null;
            try { res = JSON.parse(out); } catch {}
            const ok = res?.ok === true;
            const code = outcomeCode(res?.code, ok ? "ok" : "error");
            outcome.set(tc, code);
            if (ok) ownDone.set(dupKey, out);
            if (ran && ok && wk && res.effect !== false) turnWrites.set(wk, out);
            const resSay = typeof res?.say === "string" && res.say.trim() ? res.say.trim() : null;
            if (ok) {
              ownFails.delete(dupKey);
              for (const [k, f] of ownFails) if (f.validation && (f.name === tc.name || (ran && f.round < rounds))) ownFails.delete(k);
            } else ownFails.set(dupKey, { name: tc.name, say: resSay, validation: OWN_VALIDATION_CODES.has(code), round: rounds });
            if (ok && res.effect !== false && resSay) ownOkSays.set(dupKey, resSay);
            if (ran && ok && code === "needs_confirm" && resSay) ownAsk = resSay;
            // A failed own call (no_tz, bad_args, backend_error…), or a question with no line to speak: from here on
            // the model's words are held and checked (#499). Text streamed in THIS round was already held when the
            // guard was on from the first word (a turn aimed at an own tool, above); otherwise it may have been
            // heard, and only what the model says in later rounds is checked against what the tools really did.
            if (!ok || code === "needs_confirm") armGuard();
            if (ok && res.effect !== false) { backed = true; actionSent = true; }
            // The voice bot keeps the last own write on record (voice memory lastWrite): what a later recap may say.
            if (voiceKind && ran && ok && res.effect !== false) {
              const a = tc.arguments && typeof tc.arguments === "object" ? tc.arguments : {};
              const w = res.write && typeof res.write === "object" ? res.write : { title: a.title ?? a.text, start: a.start ?? a.at ?? a.due ?? null };
              memory.noteWrite(device.id, { tool: tc.name, title: typeof w.title === "string" ? w.title : "", start: w.start ?? null, say: resSay || "", lang: opts.lang, tz: opts.tz });
            }
            if (code === "bad_args") ownBadArgs = true;
            if (usedFamilies) usedFamilies.add(own.family);
            if (ok) ownOkFams.add(own.family);   // only an ok call stamps the voice memory (a failed stray call does not)
            ownOffered = true;   // used (families on or off): arms the follow-up window
            // A cached question is not the pending one any more: a final question line is always the live one (ownAsk).
            finalRes = tc === calls.at(-1) && res && res.final === true && typeof res.say === "string" && res.say.trim()
              ? { name: tc.name, say: (code === "needs_confirm" && ownAsk) || res.say.trim(), code, effect: ok && res.effect !== false } : null;
            local.push({ id: tc.id, name: tc.name, result: out, neutral: true });
            continue;
          }
          const x = extraByName.get(tc.name);
          if (x) {
            neutralCalls++;
            let out;
            if (!offered.has(tc.name)) out = JSON.stringify({ action: "error", code: "not_offered", message: EXTRA_NOT_NEEDED });   // never run
            else try { out = await x.execute(tc.arguments || {}, { transcript }); } catch (err) { out = JSON.stringify({ action: "error", message: err.message }); }
            let res = null;
            try { res = JSON.parse(out); } catch {}
            const ok = res?.ok === true;
            // The log code: why (reason), else what happened (outcome), else the 0.1.8 rule.
            const code = outcomeCode(res?.reason, null) || outcomeCode(res?.outcome, null) || (ok ? "ok" : outcomeCode(res?.code, "error"));
            outcome.set(tc, code);
            // effect: the call changed something (a no-op success such as "nothing is open" sets effect: false).
            finalRes = tc === calls.at(-1) && offered.has(tc.name) && res && res.final === true && typeof res.say === "string" && res.say.trim()
              ? { name: tc.name, say: res.say.trim(), code, effect: ok && res.effect !== false } : null;
            // A display tool that changed the screen is user-visible progress.
            if (ok) roundDisplay = true;
            if (ok && res.effect !== false && displayBacks) backed = true;
            if (holdEnd && ok && res.effect !== false && typeof res.say === "string" && res.say.trim()) endLines.push(res.say.trim());
            if (tc.name === mustName && (typeof mustX.mustDone === "function" ? mustX.mustDone(res) === true : ok)) mustDone = true;
            local.push({ id: tc.id, name: tc.name, result: out, neutral: true });
            continue;
          }
          remote.push(tc);
        }
        // The budget also bounds a slow remote tool: the race stops waiting (the call itself runs on).
        let remoteResults = [];
        // A sentence-gated turn tracks what its tools did too: a later claim is checked against it.
        if ((actionGuard || gateOn) && remote.some((tc) => toolEffect(deps.effectiveToolName(tc) || tc.name) !== "read" && !deps.isMemoryTool(tc.name))) actionSent = true;
        try { if (remote.length) remoteResults = await Promise.race([executor.executeToolCalls(remote), budgetP.then(() => null)]); }
        catch (err) { noteRound(); throw err; }   // the round is still in the log when a tool run throws
        (remoteResults || []).forEach((r, i) => {
          if (!remote[i]) return;
          outcome.set(remote[i], r?.isError ? "error" : "ok");
          if (!r?.isError && (actionGuard || gateOn)) {
            const eff = deps.effectiveToolName(remote[i]) || remote[i].name;
            const effect = toolEffect(eff);
            // A memory note is not a reminder; a scheduled job or notification is (crow_create_schedule…).
            const memo = (deps.isMemoryTool(remote[i].name) || deps.isMemoryTool(eff)) && !/schedule|notification/.test(String(eff));
            if (effect === "write") { if (memo) memoryBacked = true; else backed = true; }
            else if (effect === "unknown") unsureBacked = true;
          }
          if (usedFamilies && !r?.isError) {
            const eff = deps.effectiveToolName(remote[i]);
            const id = callFamily(remote[i], eff ? [eff] : []);
            if (id !== "addons" && id !== "other") usedFamilies.add(id);
          }
        });
        noteRound();
        // A final result ends the turn only when no must-run tool is still owed, or when it comes from the
        // must-run tool itself. A final result from ANOTHER tool on a must-run turn is just a result: the
        // model gets it back, and the turn still has to end with the must-run call or the could-not line.
        const endsFinal = !!finalRes && (mustDone || finalRes.name === mustName);
        if ((budgetHit || remoteResults == null) && !endsFinal) break;
        if (roundDisplay) displayProgress = true;
        if (roundSpoken > 0 && (toolRounds > 1 || roundSpoken >= 40)) answeredChars += roundSpoken;
        // A text-free assistant turn whose every call was refused/in-process is neutral too.
        if (assistantMsg && !kept.trim() && neutralCalls === calls.length) routeNeutral.add(assistantMsg);
        // opts.onToolResult: what the model reads (and what is saved) for a remote result may be replaced.
        const replaced = new Map();
        if (typeof opts.onToolResult === "function") {
          for (const [i, r] of (remoteResults || []).entries()) {
            if (!remote[i] || !r) continue;
            try {
              const rep = await opts.onToolResult({ name: r.name, tool: deps.effectiveToolName(remote[i]) || r.name, result: r.result, isError: r.isError === true });
              if (typeof rep === "string") replaced.set(r, rep);
            } catch (err) { log(`[voice-turn] ${device.id} onToolResult failed for ${logName(r.name)}: ${err?.message || err}`); }
          }
        }
        // Neutrality rides on the local result object, never on the call id (ids may be "" — review M7).
        let lastToolMsg = null;
        for (const r of [...local, ...(remoteResults || [])]) {
          const content = replaced.has(r) ? replaced.get(r) : r.result;
          const toolMsg = { role: "tool", content, tool_call_id: r.id, tool_name: r.name };
          if (r.neutral === true && local.includes(r)) routeNeutral.add(toolMsg);
          messages.push(toolMsg);
          lastToolMsg = toolMsg;
          if (typeof content === "string" && content.length > 500) nextMax = 4000;
        }
        if (endsFinal) {
          // The turn ends on the server's own line: no further model round. What the display hears:
          //  - nothing was spoken in this round (the usual case: text was held or deferred) → the server's line;
          //  - the model had already spoken a full sentence AND the call had an effect → that sentence stands;
          //  - the model had already spoken and the call did nothing or failed → the server's line as well,
          //    because what was said is not what happened.
          // The line is short and already known, so it is spoken even when the first-audio budget has run out.
          timings.final = `${logName(finalRes.name)}:${finalRes.code}`;
          if (budgetTimer) { (deps.clearTimeout || clearTimeout)(budgetTimer); budgetTimer = null; }
          if (actionGuard && (ownFails.size > 0 || (ownAsk && finalRes.say !== ownAsk))) {
            // An own call failed this turn, or a question is waiting that is not this line: not the last call's line
            // alone, the own-tool ending after the loop (it ends on the question).
            if (!ownByName.has(finalRes.name)) ownEndLead = finalRes.say;
            break;
          }
          // A retry's text was held: it was never heard, so it is not saved either.
          if (retryRound) dropHeld((m) => !heldMsgs.has(m));
          // A sentence the gate muted was not heard: the server's line is.
          const spokeSentence = !gateHit && roundSpoken > 0 && SENTENCE_END.test(`${roundText.trim()} `);
          if (!(spokeSentence && finalRes.effect)) {
            await chunker.flush();
            sink.event({ type: "caption_delta", text: (gateOn ? gateHeard.trim() : spokenChars > 0) ? ` ${finalRes.say}` : finalRes.say });
            await (budgetHit ? say.force(finalRes.say) : say(finalRes.say));
            spokenChars += finalRes.say.length;
            if (gateHit) gateLines.push(finalRes.say);
          }
          messages.push({ role: "assistant", content: finalRes.say });
          endedFinal = true;
          break;
        }
        // The step-up (the larger model as the middle step): an own tool said its arguments were bad. The next
        // round re-runs the same messages on the larger model, once per turn, through the router's escalation path.
        let stepped = false;
        if (ownBadArgs && !ownCarriedOnly && !steppedUp && !result.escalated && !result.degraded && !noEscalate && !calendarFallback && toolEscalationOn) {
          steppedUp = true;
          let fillerErr = null;
          const filler = say.filler().catch((err) => { fillerErr = err; });
          const ready = await readyEscalation(deps.escalateKey ?? decision.key, db, llmSignal);
          await filler;
          if (fillerErr && !aborted() && !mute.signal.aborted) {
            log(`[voice-turn] ${device.id} filler TTS failed: ${fillerErr.message}`);
            timings.filler_error = String(fillerErr.message || fillerErr);
          }
          if (aborted()) { result.aborted = true; break; }
          if (ready.adapter) {
            chat = ready.adapter;
            result.route = "escalate";
            result.escalated = true;
            timings.step_up = "own_tool";
            tools = baseTools;
            if (fam) famAll = true;
            stepped = true;
          } else timings.step_up_degraded = ready.reason;
        }
        // Stuck: the same tool(s) twice in a row with no user-visible progress in either round.
        const progress = roundSpoken > 0 || roundDisplay || roundHeld > 0 || roundMuted > 0;
        if (!progress && !stepped && roundSig === lastStuckSig) cut = "tool_repeat";
        lastStuckSig = progress || stepped ? null : roundSig;
        if (!cut && toolRounds >= maxRounds) cut = "tool_rounds";
        if (cut) {
          // A must-run tool that failed again (or never ran before the cap): no forced answer round —
          // its text could only be dropped. The truthful line follows the loop.
          if (!mustDone) { log(`[voice-turn] ${device.id} stopping tools (${cut}) after ${toolRounds} round(s); ${logName(mustName)} never succeeded`); break; }
          log(`[voice-turn] ${device.id} stopping tools (${cut}) after ${toolRounds} round(s); forcing an answer`);
          finalRound = true;
          if (lastToolMsg) appendNote(lastToolMsg, STOP_TOOLS_NOTE);
        }
      }
      for (const r of restores.reverse()) r.msg.content = r.content;
      if (aborted()) {
        result.aborted = true;
      } else if (budgetHit && !endedFinal && ((actionGuard && ownFails.size > 0) || ownAsk)) {
        // The own outcome is known (a failure, or a question waiting for a yes): the server's own ending, spoken past
        // the budget (say.force), never "try again". A pending question is always the last thing heard.
        if (ownFails.size > 0) timings.own_failed = true;
        await speakFallback("budget", spokenChars > 0, ownEndLine());
        return result;
      } else if (budgetHit && !endedFinal) {
        await speakFallback("budget", spokenChars > 0, actionSent ? String(opts.unsureText || UNSURE_TEXT) : undefined);
        return result;
      } else {
        if (actionGuard && !overflow && !endedFinal && !aborted()) {
          // Text held on an action turn: a claim no tool backs is replaced; text held before a tool changed
          // something (a preamble) is heard only when nothing else was said.
          const said = guardHeld.trim();
          let line = backed ? (spokenChars === 0 ? said : "") : said;
          const claim = !backed && !!said && (memoryBacked ? claimsBeyondMemory(said) : claimsAction(said));
          if (gateHit) {
            // The sentence gate muted a claim. (i) a write backed it: the held text is released when nothing was heard
            // after it (an own write's success line ended the turn already); an own failure or a waiting question: the
            // own-tool ending. (ii) the recap of the last own write it refers to. (iii) the not-done line. Saved = heard
            // (the gate's own save, after the loop).
            if (ownFails.size > 0 || ownAsk) {
              if (ownFails.size > 0) timings.own_failed = true;
              line = ownEndLine(said && !claimsAction(said) ? said : "");
            } else if (!claim) line = gateAfter ? "" : said;
            else if (unsureBacked) line = String(opts.unsureText || UNSURE_TEXT);
            else if (memoryBacked && claimsReminder(said)) line = String(opts.memoOnlyText || MEMO_ONLY_TEXT);
            else if (hintDue()) line = hintLine();
            else {
              const recap = recapFor(gateBlocked);
              if (recap) timings.claim_recap = true;
              line = recap || String(opts.notDoneText || NOT_DONE_TEXT);
            }
            if (line) gateLines.push(line);
          } else if (ownFails.size > 0 || ownAsk) {
            // An own call failed, or a question waits for a yes (see the action guard above): held text that claims
            // nothing, the ok own calls' lines, the failure line (if any), then the question. Saved = heard.
            const claimed = !!said && claimsAction(said);
            if (claimed) {
              timings.claim_blocked = true;
              log(`[voice-turn] ${device.id} bot ${bot.bot_id}: a reply claiming an action an own tool failed was replaced`);
            }
            if (ownFails.size > 0) timings.own_failed = true;
            line = ownEndLine(said && !claimed ? said : "");
            dropHeld((m) => !heldMsgs.has(m));
            messages.push({ role: "assistant", content: line });
          } else if (claim) {
            // After an ok call to a tool of unknown effect the truth is "not sure", never "nothing was changed".
            line = String(unsureBacked ? (opts.unsureText || UNSURE_TEXT)
              : memoryBacked && claimsReminder(said) ? (opts.memoOnlyText || MEMO_ONLY_TEXT)
              : actionable.length === 0 ? (opts.cantDoText || CANT_DO_TEXT) : hintDue() ? hintLine() : (opts.notDoneText || NOT_DONE_TEXT));
            timings.claim_blocked = true;
            log(`[voice-turn] ${device.id} bot ${bot.bot_id}: a reply claiming an action no tool did was replaced`);
            dropHeld(() => false);
            messages.push({ role: "assistant", content: line });
          } else if (!line && said) dropHeld((m) => !heldMsgs.has(m));
          if (line) {
            sink.event({ type: "caption_delta", text: (gateOn ? gateHeard.trim() : spokenChars > 0) ? ` ${line}` : line });
            await say(line);
            spokenChars += line.length;
            // The guard's line IS the answer: a cut turn (repeat / round cap) does not add the stuck line after it.
            finalSpoken += line.length;
            answeredChars += line.length;
          }
        }
        if (holdEnd && !overflow && !endedFinal) {
          // The end of a held compound turn: what the display really did, in the server's words; else the
          // model's last text when no display call did anything and nothing was owed.
          const line = endLines.join(" ") || (mustDone ? heldLast.trim() : "");
          if (line) {
            sink.event({ type: "caption_delta", text: spokenChars > 0 ? ` ${line}` : line });
            await say(line);
            spokenChars += line.length;
            messages.push({ role: "assistant", content: line });
          }
        }
        await chunker.flush();
        if (aborted()) result.aborted = true;
        // The budget can fire while the last chunk is still synthesizing (the stream already ended). A known own
        // outcome (a failure, or a question waiting for a yes) is re-spoken past the budget, so the question stays last.
        else if (budgetHit && !endedFinal && !say.answered() && ((actionGuard && ownFails.size > 0) || ownAsk)) { await speakFallback("budget", spokenChars > 0, ownEndLine()); return result; }
        else if (budgetHit && !endedFinal && !say.answered()) { await speakFallback("budget", spokenChars > 0, actionSent ? String(opts.unsureText || UNSURE_TEXT) : undefined); return result; }
        else if (overflow) { await speakFallback("context_full", spokenChars > 0); return result; }
        else if (!mustDone && !endedFinal) {
          // Never end on a claim that something is on the screen when nothing was put there.
          timings.display_missed = true;
          await speakFallback("display_missed", spokenChars > 0, String(mustX?.missedText || opts.displayMissedText || DISPLAY_MISSED_TEXT));
          return result;
        }
        else if (cut && finalSpoken === 0 && answeredChars === 0 && !displayProgress) { await speakFallback(cut, spokenChars > 0); return result; }
        else if (spokenChars === 0 && !displayProgress) { await speakFallback("no_text", false); return result; }
      }
      say.end();
      if (gateHit) {
        // The sentence gate's save: what was heard, and nothing else (the muted text never reaches the conversation).
        dropHeld(() => false);
        const heard = [gateHeard.trim(), ...gateLines].filter(Boolean).join(" ");
        if (heard) messages.push({ role: "assistant", content: heard });
      }
      const userIdx = messages.indexOf(userMsg);
      if (userIdx >= 0) messages[userIdx] = { role: "user", content: transcript };
      convo.save(device.id, messages);
      return result;
    } catch (err) {
      if (aborted()) { result.aborted = true; return result; }
      if (budgetHit) { await speakFallback("budget", true).catch(() => {}); return result; }
      result.failed = "error";
      timings.failed = "error";
      // The cause used to reach the client only; the gateway log is where it gets diagnosed.
      log(`[voice-turn] ${device?.id} turn failed (error): ${err?.message || err}`);
      fail("turn_failed", true, err.message);
      return result;
    } finally {
      if (budgetTimer) (deps.clearTimeout || clearTimeout)(budgetTimer);
      if (opts.familiesOnIntent === true && device?.id && result.transcript) {
        if (usedFamilies && usedFamilies.size) lastFamilies.set(device.id, { set: usedFamilies, at: now() }); else lastFamilies.delete(device.id);
      }
      if (typeof opts.actionWhen === "function" && device?.id && result.transcript) {
        if (actionAsked) lastAction.add(device.id); else lastAction.delete(device.id);
      }
      if (device?.id && result.transcript) {
        if (ownOffered || [...(usedFamilies || [])].some((f) => String(f).startsWith("own:"))) lastOwn.set(device.id, now()); else lastOwn.delete(device.id);
      }
      // The voice memory: own families offered on intent or used are stamped (a carried-only one never is), and an
      // action request is kept for the window.
      if (voiceKind && device?.id && result.transcript) {
        if (ownStamp.length || ownOkFams.size) memory.noteOwn(device.id, [...ownStamp, ...ownOkFams]);
        if (actionAsked) memory.noteAction(device.id);
      }
      timings.total_ms = now() - t0;
      if (say) timings.spoken_chars = say.chars();
      if (executor) { try { await executor.close(); } catch {} }
      if (typeof voiceActions?.afterTurn === "function" && device?.id) {
        try { await voiceActions.afterTurn({ device, calledTools: calledTools.slice() }); } catch (err) { log(`[voice-turn] ${device.id} voice actions afterTurn failed (${err?.message || err})`); }
      }
    }
  }

  /** Speak text outside a turn (announce, timer done). */
  async function speakText({ db, device, text, sink, signal }) {
    const tts = await openTts(db, device);
    if (!tts) return false;
    const say = makeSpeaker(tts, sink, signal, () => {});
    await say(text);
    say.end();
    return true;
  }

  return { runVoiceTurn, speakText, transcribe, assessBot, abilitiesOf, convo };
}

// One pibots:defs-changed subscription per process, however many runners defaultVoiceDeps() feeds.
let botDefsGeneration = 0;
let botDefsSubscribed = false;
async function subscribeBotDefsChanged() {
  if (botDefsSubscribed) return;
  botDefsSubscribed = true;
  try {
    const bus = (await import("../../shared/event-bus.js")).default;
    bus.on("pibots:defs-changed", () => { botDefsGeneration++; });
  } catch { botDefsSubscribed = false; }
}

/** The real dependencies (gateway process). Lazy so tests never load them. */
export async function defaultVoiceDeps() {
  await subscribeBotDefsChanged();
  const { ensureCrowVoiceBot } = await import("./ensure-voice-bot.js");
  const stt = await import("../ai/stt/index.js");
  const tts = await import("../ai/tts/index.js");
  const provider = await import("../ai/provider.js");
  const tx = await import("../ai/tool-executor.js");
  const sp = await import("../ai/system-prompt.js");
  const router = await import("../routes/llm-router.js");
  const orch = await import("../gpu-orchestrator.js");
  const { TOOL_MANIFESTS } = await import("../tool-manifests.js");
  const { createToolForcing } = await import("./tool-forcing.js");
  const { createToolFamilies } = await import("./tool-families.js");
  const { createPendingStore, chainVoiceActions } = await import("./pending.js");
  const { createOwnTools } = await import("./own-tools.js");
  const ext = await import("../../../scripts/pi-bots/ext_registry.mjs");
  const proxy = await import("../proxy.js");
  const memoryTools = new Set(Object.keys(TOOL_MANIFESTS.memory?.tools || {}));
  // One pending store and one set of Crow's own tools per runner. The own tools reach the voice bot only
  // (turn.js asks deps.ownTools for it alone); their Workspace and Google calls go through the turn's executor.
  const pending = createPendingStore();
  const ownTools = createOwnTools({ pending, log: (m) => console.warn(m), connected: () => tx.connectedAddonToolNames() });
  const byId = (list, id) => list.find((p) => p.id === id) || null;
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Every voice turn answers as the Crow voice bot (created on the first turn that finds it missing).
    voiceBotId: CROW_VOICE_BOT_ID,
    ensureVoiceBot: async (db) => { await ensureCrowVoiceBot(db); },
    botDefsGeneration: () => botDefsGeneration,
    loadBotRow: async (db, botId) => (await db.execute({ sql: "SELECT bot_id, definition, enabled FROM pi_bot_defs WHERE bot_id = ?", args: [botId] })).rows[0] || null,
    getSttProfile: async (db, device) => (device.stt_profile_id
      ? byId(await stt.getSttProfiles(db, { includeKeys: true }), device.stt_profile_id)
      : stt.getDefaultSttProfile(db, { includeKeys: true })),
    createSttAdapter: async (p) => (await stt.createSttAdapter(p)).adapter,
    getTtsProfile: async (db, device) => (device.tts_profile_id
      ? byId(await tts.getTtsProfiles(db, { includeKeys: true }), device.tts_profile_id)
      : tts.getDefaultTtsProfile(db, { includeKeys: true })),
    createTtsAdapter: async (p) => (await tts.createTtsAdapter(p)).adapter,
    createChatAdapter: async (key, db) => {
      const i = String(key).indexOf("/");
      const provider_id = i >= 0 ? key.slice(0, i) : key;
      const model_id = i >= 0 ? key.slice(i + 1) : "";
      return (await provider.createAdapterFromProfile({ provider_id, model_id }, null, db)).adapter;
    },
    resolveKey: router.resolveVoiceKey,
    toolFamilies: createToolFamilies({ manifests: TOOL_MANIFESTS, listExtensions: () => ext.listInstalledExtensions(), connected: () => proxy.connectedServers || new Map() }),
    toolForcing: createToolForcing({
      resolveKey: router.resolveVoiceKey,
      modelEntry: async (key, db) => {
        try {
          const i = String(key).indexOf("/");
          const row = (await db.execute({ sql: "SELECT models FROM providers WHERE id = ?", args: [i >= 0 ? key.slice(0, i) : key] })).rows[0];
          return JSON.parse(row?.models || "[]").find((x) => x && (x.id === key.slice(i + 1) || i < 0)) || null;
        } catch { return null; }
      },
      log: (m) => console.warn(m),
    }),
    probeReady: router.probeVoiceReady,
    acquire: (providerId) => orch.maybeAcquireLocalProvider(providerId, { requester: "kiosk" }),
    chooseVoiceRoute: router.chooseVoiceRoute,
    fastKey: router.VOICE_ROUTE_KEYS.fast,
    // The ability line ("By voice on displays"): may an action escalate, and to which model.
    escalateKey: router.VOICE_ROUTE_KEYS.escalate,
    toolEscalationEnabled: router.toolEscalationEnabled,
    getChatTools: tx.getChatTools,
    toolCategory: tx.toolCategoryOf,
    createToolExecutor: tx.createToolExecutor,
    maxToolRounds: tx.MAX_TOOL_ROUNDS,
    effectiveToolName: tx.effectiveToolName,
    isExternalSendTool: tx.isExternalSendTool,
    isConnectedAddonTool: tx.isConnectedAddonTool,
    connectedAddonTools: () => tx.connectedAddonToolNames(),
    ownTools: ownTools.forTurn,
    // A chain: Crow's own tools now; the hand-off joins after them (PR 3).
    voiceActions: chainVoiceActions([ownTools]),
    botVoiceScope: tx.botVoiceScope,
    generateSystemPrompt: sp.generateSystemPrompt,
    isMemoryTool: (n) => n === "crow_memory" || memoryTools.has(n),
    contextLenFor: async (key, db) => {
      try {
        const i = String(key).indexOf("/");
        const row = (await db.execute({ sql: "SELECT models FROM providers WHERE id = ?", args: [i >= 0 ? key.slice(0, i) : key] })).rows[0];
        const m = JSON.parse(row?.models || "[]").find((x) => x && (x.id === key.slice(i + 1) || i < 0));
        return Number.isFinite(m?.contextLen) ? m.contextLen : null;
      } catch { return null; }
    },
  };
}
