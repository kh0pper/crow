/**
 * The voice hand-off (PR 3, Task 3.7): the `crow_handoff` tool the voice model calls to propose giving a bigger
 * job to one of the operator's bots, to ask "which one?", or to say none can. The tool never creates a card:
 * it writes a `proposed` row (handoff-store.js) and a pending entry, and the server speaks the proposal. The
 * spoken yes that creates the card is Task 3.8 (fastPath, core.confirm).
 *
 *   getHandoffCore()                  the process singleton: { store, summaries, availability, loadVoiceDef, inFlight, forTurn }
 *   createHandoffCore(seams)          the same, built from seams (tests)
 *   createHandoffVoiceActions(...)    the runner's deps.voiceActions member (pending.js chainVoiceActions)
 *   proposeHandoff(ctx, task, botId)  the propose branch (3.8's "which" answer re-proposes through it)
 *
 * The capability summaries live only in the tool description, never in the system message (prefix cache).
 * A bot id reaches the description only in slug form; everything else in a line is bot-summaries.js's one
 * clean line.
 */
import { wantsHandoff } from "./handoff-intent.js";
import { voiceLine } from "./voice-lines.js";
import { createHandoffStore } from "./handoff-store.js";
import { createSummaryCache } from "./bot-summaries.js";
import { createVoiceBotLoader } from "./crow-voice.js";
import { botDefsGeneration } from "./defs-generation.js";
import { modelAvailability } from "./model-availability-voice.js";
import { HANDOFF_TASK_MAX_CHARS } from "./handoff-constants.js";
import { normalizeVoiceSettings } from "../../shared/voice-bot.js";

export const HANDOFF_TOOL_NAME = "crow_handoff";
/** The pending kinds this module owns (a hand-off proposal, a "which one?"). */
const OWN_KINDS = new Set(["handoff", "which"]);
/** A bot id as the model may read it (the pi-bots BOT_ID_RE): anything else is never offered. */
const SAFE_BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A "which one?" names two bots: the spoken question has room for two. */
const MAX_OPTIONS = 2;
/** Where a spoken yes is the operator's (a dashboard tab speaks as "phone"); a kiosk joins in PR 4. */
const PERSONAL_SURFACES = new Set(["phone", "glasses"]);

const DESCRIPTION_HEAD = "Hand a bigger job (research, a document, an automation) to one of the user's bots. It runs in the background. Do not do the job yourself. Pick the bot that fits from this list; if two could fit or you are not sure, leave bot empty and put both in candidates.\nBots:\n";

/** The tool definition for these candidates (each `- <bot_id>: <summary>`). */
export function handoffToolDefinition(candidates) {
  return {
    name: HANDOFF_TOOL_NAME,
    description: DESCRIPTION_HEAD + candidates.map((c) => `- ${c.bot_id}: ${c.summary}`).join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the bot should do, as a short phrase starting with a verb, e.g. 'research the history of community radio and write it up as a document'." },
        bot: { type: "string", description: "The bot id from the list." },
        candidates: { type: "array", items: { type: "string" }, description: "Two or three bot ids when you are not sure." },
      },
      required: ["task"],
    },
  };
}

/** The task line: control characters dropped, whitespace collapsed, at most HANDOFF_TASK_MAX_CHARS. "" when none. */
export function cleanTask(task) {
  if (typeof task !== "string") return "";
  const s = task.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
  if (s.length <= HANDOFF_TASK_MAX_CHARS) return s;
  let head = s.slice(0, HANDOFF_TASK_MAX_CHARS);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head.trimEnd();
}

const langOf = (lang) => (lang === "es" ? "es" : "en");
const done = (code, say) => ({ ok: true, final: true, effect: false, code, say });

/**
 * The device's pending hand-off (or which) is replaced: its proposed row goes to expired, and the entry is
 * cleared. A correction ("no, give it to helper") is the model calling crow_handoff again, so this is how the
 * old row ends [rv1 S]. A failed expire is logged; the new proposal still goes ahead.
 */
async function retirePending(ctx) {
  const { core, pending, db, device } = ctx;
  const prev = pending.get(device.id);
  if (!prev || !OWN_KINDS.has(prev.kind)) return;
  pending.clear(device.id);
  if (prev.kind === "handoff" && prev.id) {
    try { await core.store.transition(db, prev.id, ["proposed"], "expired"); }
    catch (err) { (ctx.log || console.warn)(`[voice-handoff] could not expire ${prev.id} (${err?.message || err})`); }
  }
}

/**
 * The propose branch: a `proposed` row (asked = the transcript, lang and device from the turn), the pending
 * entry 3.8's yes reads, and the server's spoken proposal.
 * ctx: { core, pending, db, device, surface, lang, transcript, candidates }. botId must be one of the candidates.
 * → { ok: true, final: true, effect: false, code: "proposed", say }
 */
export async function proposeHandoff(ctx, task, botId) {
  const { core, pending, db, device, surface, transcript, candidates } = ctx;
  const lang = langOf(ctx.lang);
  const target = candidates.find((c) => c.bot_id === botId);
  if (!target) throw new Error(`proposeHandoff: ${JSON.stringify(botId)} is not a candidate`);
  await retirePending(ctx);
  const avail = await core.availability(db, target.model_key);
  const startNow = target.perch && avail !== "unavailable" ? 1 : 0;
  const id = await core.store.insert(db, {
    kind: "handoff", surface, device_id: device.id, device_name: device.name ?? null, bot_id: target.bot_id,
    task, asked: typeof transcript === "string" ? transcript : null, status: "proposed",
    model_key: target.model_key ?? null, start_now: startNow, lang,
  });
  // The other candidates' names: a yes that names one of them is a correction, not a yes (pending.js matchYesNo).
  const names = [...new Set(candidates.filter((c) => c.bot_id !== target.bot_id).flatMap((c) => [c.name, c.bot_id]))]
    .filter((n) => n !== target.name && n !== target.bot_id);
  pending.set(device.id, { kind: "handoff", id, bot_id: target.bot_id, name: target.name, task, names });
  const vars = { bot: target.name, task };
  let say = voiceLine(startNow ? "handoff_propose" : "handoff_propose_queued", lang, vars);
  if (startNow && avail === "on_demand") say += voiceLine("handoff_model_starts", lang, vars);
  return done("proposed", say);
}

/** What one crow_handoff call does (an object; the tool's execute returns it as JSON). */
async function runHandoffCall(ctx, args) {
  const a = args && typeof args === "object" ? args : {};
  const task = cleanTask(a.task);
  if (!task) return { ok: false, code: "bad_args" };
  const ids = new Set(ctx.candidates.map((c) => c.bot_id));
  const bot = typeof a.bot === "string" ? a.bot.trim() : "";
  const botOk = ids.has(bot);
  const others = [...new Set((Array.isArray(a.candidates) ? a.candidates : [])
    .filter((x) => typeof x === "string").map((x) => x.trim()).filter((x) => ids.has(x) && x !== bot))];
  if (botOk && !others.length) return proposeHandoff(ctx, task, bot);
  const lang = langOf(ctx.lang);
  const optionIds = [...(botOk ? [bot] : []), ...others].slice(0, MAX_OPTIONS);
  // The model asked again: whatever this device was waiting on is no longer the question.
  await retirePending(ctx);
  if (!optionIds.length) return done("none", voiceLine("handoff_none", lang));
  const options = optionIds.map((id) => {
    const c = ctx.candidates.find((x) => x.bot_id === id);
    return { bot_id: c.bot_id, name: c.name };
  });
  ctx.pending.set(ctx.device.id, { kind: "which", task, asked: typeof ctx.transcript === "string" ? ctx.transcript : null, options });
  const say = options.length >= 2
    ? voiceLine("handoff_which", lang, { a: options[0].name, b: options[1].name })
    : voiceLine("handoff_which_one", lang, { a: options[0].name });
  return done("which", say);
}

/**
 * The turn's crow_handoff tool, or [] when there is none: a kiosk (or an unknown surface: PR 4 gives the kiosk
 * its phone confirm), hand-offs off on the voice bot, or no candidate. The tool is offered (when) on a hand-off
 * request (wantsHandoff, with the candidates' names and ids) or while this device waits on a hand-off or a
 * which; an offered turn starts the candidates' model probes so the proposal finds them warm.
 * ctx: { db, device, surface, lang, bot, transcript, pending }
 */
async function forTurn(core, ctx) {
  const { db, device, surface, bot, pending } = ctx || {};
  if (!db || !device?.id || !pending || !PERSONAL_SURFACES.has(surface)) return [];
  if (!normalizeVoiceSettings(bot).handoff.enabled) return [];
  const candidates = (await core.summaries.get(db, bot)).filter((c) => SAFE_BOT_ID.test(c.bot_id));
  if (!candidates.length) return [];
  const names = [...new Set(candidates.flatMap((c) => [c.name, c.bot_id]))];
  const when = (t) => wantsHandoff(t, names) || OWN_KINDS.has(pending.get(device.id)?.kind);
  if (when(ctx.transcript)) {
    for (const c of candidates) {
      Promise.resolve().then(() => core.availability(db, c.model_key)).catch(() => {});
    }
  }
  const call = { core, pending, db, device, surface, lang: ctx.lang, transcript: ctx.transcript, candidates, log: core.log };
  return [{
    definition: handoffToolDefinition(candidates),
    when,
    execute: async (args) => JSON.stringify(await runHandoffCall(call, args)),
  }];
}

/**
 * A hand-off core from its seams. 3.8 adds confirm (and the card and engine seams it needs); 5.3 and 5.4 add
 * status and stop.
 */
export function createHandoffCore({
  store = createHandoffStore(),
  summaries = createSummaryCache(),
  availability = modelAvailability,
  loadVoiceDef = createVoiceBotLoader({ generation: botDefsGeneration }),
  log = (m) => console.warn(m),
} = {}) {
  const core = { store, summaries, availability, loadVoiceDef, inFlight: new Set(), log };
  core.forTurn = (ctx) => forTurn(core, ctx);
  return core;
}

let shared = null;
/** The process-wide hand-off core (lazy). */
export function getHandoffCore() {
  shared ??= createHandoffCore();
  return shared;
}

/**
 * The runner's deps.voiceActions member, sharing the runner's pending store (pending.js chainVoiceActions).
 *   fastPath     null for now: the spoken yes is 3.8
 *   turnContext  a pending hand-off or which: "[Hand-off] Waiting for a yes or no: …", pending (an action turn,
 *                so a reply claiming the bot started is held and replaced); it reads only the entry [rv1 C6]
 *   afterTurn    a turn that left a pending hand-off or which unanswered (no crow_handoff call) takes it and
 *                expires its row; a routine or which_calendar entry is never touched
 */
export function createHandoffVoiceActions({ core, pending, now = Date.now } = {}) {
  void now;   // 3.8's confirm reads the clock
  return {
    async fastPath() { return null; },
    turnContext({ device } = {}) {
      const e = device?.id ? pending.get(device.id) : null;
      if (!e || !OWN_KINDS.has(e.kind)) return null;
      const what = e.kind === "handoff" ? `${e.name}: ${e.task}` : `${e.options.map((o) => o.name).join(" or ")}: ${e.task}`;
      return { text: `[Hand-off] Waiting for a yes or no: ${what}. If the user changes the bot or the task, call crow_handoff again with the change.`, pending: true };
    },
    async afterTurn({ db, device, calledTools = [] } = {}) {
      if (!device?.id) return;
      const e = pending.get(device.id);
      if (!e || !OWN_KINDS.has(e.kind) || calledTools.includes(HANDOFF_TOOL_NAME)) return;
      pending.take(device.id);
      if (e.kind === "handoff" && e.id) await core.store.transition(db, e.id, ["proposed"], "expired");
    },
  };
}
