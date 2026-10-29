/**
 * The voice hand-off (PR 3, Tasks 3.7 and 3.8): the `crow_handoff` tool the voice model calls to propose giving
 * a bigger job to one of the operator's bots, to ask "which one?", or to say none can, and the spoken yes that
 * hands it over. The tool never creates a card: it writes a `proposed` row (handoff-store.js) and a pending
 * entry, and the server speaks the proposal. The yes (fastPath → core.confirm) creates the card as a hand-made
 * Give card and starts the bot truthfully: "on it" is said only once the bot really started, inside the start
 * budget, on a model that was up; otherwise "starting up", and a first turn that fails is reported once.
 *
 *   getHandoffCore()                  the process singleton: { store, summaries, availability, loadVoiceDef, give,
 *                                     engine, openTasksDb, notify, announce, inFlight, lastHandoffTopic, exchanges,
 *                                     forTurn, confirm, completion, status }
 *   registerVoiceResultKind()         the "voice" result kind (handoff-completion.js), registered once at boot
 *   createHandoffCore(seams)          the same, built from seams (tests)
 *   createHandoffVoiceActions(...)    the runner's deps.voiceActions member (pending.js chainVoiceActions)
 *   proposeHandoff(ctx, task, botId)  the propose branch (the "which" answer re-proposes through it); on a
 *                                     kiosk (PR 4) it pushes the proposal to the operator's phone instead
 *   startHandoffSweep(...)            the minute sweep over the log, armed once at boot
 *
 * The capability summaries live only in the tool description, never in the system message (prefix cache).
 * A bot id reaches the description only in slug form; everything else in a line is bot-summaries.js's one
 * clean line.
 */
import { wantsHandoff } from "./handoff-intent.js";
import { voiceLine } from "./voice-lines.js";
import { createHandoffStore, findHandoffCard } from "./handoff-store.js";
import { createSummaryCache } from "./bot-summaries.js";
import { createVoiceBotLoader } from "./crow-voice.js";
import { botDefsGeneration } from "./defs-generation.js";
import { modelAvailability } from "./model-availability-voice.js";
import { matchYesNo, changesContent } from "./pending.js";
import { matchChoice } from "./own-tools.js";
import { phraseWords, listMatches } from "./tool-families.js";
import { HANDOFF_TASK_MAX_CHARS } from "./handoff-constants.js";
import { confirm, langOf, botName, surfaceLabel, announceHandoff } from "./handoff-confirm.js";
import { createHandoffCompletion } from "./handoff-completion.js";
import { status as handoffStatus, answerRow, reconcileOpen } from "./handoff-status.js";
import { rememberTopic, bumpExchange } from "./handoff-topic.js";
import { registerResultKind } from "../board/result-requesters.js";

// Re-exported so every existing import of these from handoff.js keeps working.
export { botName, surfaceLabel };
import { normalizeVoiceSettings } from "../../shared/voice-bot.js";
import { createNotification } from "../../shared/notifications.js";
import { createDbClient } from "../../db.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { createTaskForBot, startAfterGive, fileStartedThread } from "../board/give-service.js";

export const HANDOFF_TOOL_NAME = "crow_handoff";
/** The pending kinds this module owns (a hand-off proposal, a "which one?"). */
const OWN_KINDS = new Set(["handoff", "which"]);
// The entries a relay turn's afterTurn clears here (R15: own-tools.js clears routine and which_calendar).
const RELAY_KINDS = new Set(["handoff", "which", "stop"]);
/** A bot id as the model may read it (the pi-bots BOT_ID_RE): anything else is never offered. */
const SAFE_BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Where a spoken yes is the operator's (a dashboard tab speaks as "phone"). */
const PERSONAL_SURFACES = new Set(["phone", "glasses"]);
/** Any other surface, a missing one included, is a shared display: "kiosk" (its hand-off is confirmed on the phone). */
const handoffSurface = (surface) => (PERSONAL_SURFACES.has(surface) ? surface : "kiosk");
/** The page a kiosk hand-off's push opens (the phone confirm page, Task 4.2). */
export const phoneConfirmPath = (id) => "/dashboard/voice/handoffs/" + id;

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

const done = (code, say) => ({ ok: true, final: true, effect: false, code, say });

/**
 * Whatever the device was waiting on is no longer the question: a pending hand-off's proposed row goes to
 * expired and the entry is taken. A correction ("no, give it to helper") is the model calling crow_handoff
 * again, so this is how the old row ends [rv1 S]. Another kind's entry (a routine confirm, a which-calendar) is
 * taken too, and logged, never silently overwritten. A failed expire is logged; the call still goes ahead.
 */
async function retirePending(ctx) {
  const { core, pending, db, device } = ctx;
  const prev = pending.take(device.id);
  if (!prev) return;
  if (!OWN_KINDS.has(prev.kind)) {
    (ctx.log || console.warn)(`[voice-handoff] ${device.id}: a pending ${prev.kind} question was dropped for a hand-off`);
    return;
  }
  if (prev.kind === "handoff" && prev.id) {
    try { await core.store.transition(db, prev.id, ["proposed"], "expired"); }
    catch (err) { (ctx.log || console.warn)(`[voice-handoff] could not expire ${prev.id} (${err?.message || err})`); }
  }
}

/**
 * The kiosk branch (PR 4): a shared display never takes a spoken yes. The proposal becomes an `awaiting_phone`
 * row and one high-priority push that opens the phone confirm page; no pending entry is set, so a "yes" in the
 * room is an ordinary turn. Whatever the device was waiting on (a "which" this answers) is retired first.
 *  - One open phone confirmation per kiosk [rv2 m4]: while one is live, handoff_already_sent, no push, no row.
 *    A phone_open from the insert (a race) re-runs openPhone once, which moves out a row that has just expired,
 *    and retries the insert once; only a second phone_open is already-sent [rv3 m4].
 *  - "Sent" only when the push went out [rv1 C5]: a notify that returns null (the type is off) or throws moves
 *    the row to failed "not_sent" (markNotSent). Null says the alerts are off (handoff_phone_off); a throw says
 *    the phone could not be reached just now (handoff_phone_failed).
 */
async function proposeToPhone(ctx, task, target, lang) {
  const { core, db, device, transcript } = ctx;
  const { store } = core;
  await retirePending(ctx);
  const already = () => done("already_sent", voiceLine("handoff_already_sent", lang));
  if (await store.openPhone(db, device.id, "handoff")) return already();
  const avail = await core.availability(db, target.model_key);
  const insert = () => store.insert(db, {
    kind: "handoff", surface: "kiosk", device_id: device.id, device_name: device.name ?? null, bot_id: target.bot_id,
    task, asked: typeof transcript === "string" ? transcript : null, status: "awaiting_phone",
    model_key: target.model_key ?? null, start_now: target.perch && avail !== "unavailable" ? 1 : 0, lang,
  });
  let id;
  try {
    id = await insert();
  } catch (err) {
    if (err?.code !== "phone_open") throw err;
    if (await store.openPhone(db, device.id, "handoff")) return already();
    try { id = await insert(); } catch (err2) { if (err2?.code === "phone_open") return already(); throw err2; }
  }
  const name = typeof device.name === "string" ? device.name.trim() : "";
  const display = name || voiceLine("handoff_display_fallback", lang);
  let n = null;
  let threw = false;
  try {
    n = await core.notify(db, {
      type: "attention", priority: "high", title: voiceLine("handoff_phone_title", lang, { display, bot: target.name }),
      body: task, action_url: phoneConfirmPath(id), source: "crow-voice",
    });
  } catch (err) { threw = true; (ctx.log || console.warn)(`[voice-handoff] ${id}: phone notification failed (${err?.message || err})`); }
  if (n != null) return done("sent_to_phone", voiceLine("handoff_sent_to_phone", lang));
  await markNotSent(ctx, id);
  // A null is the type turned off (the operator can fix it); a throw is a passing failure: try again soon.
  return threw ? done("phone_failed", voiceLine("handoff_phone_failed", lang)) : done("phone_off", voiceLine("handoff_phone_off", lang));
}

/**
 * The push did not go out: awaiting_phone → failed "not_sent", retried once. A row left awaiting_phone would
 * answer every next ask with "already sent" for the whole 30 min, so when both tries throw the row is moved to
 * expired instead (its own try); only that failing too is left to the sweep, and logged.
 */
async function markNotSent(ctx, id) {
  const { store } = ctx.core;
  const log = ctx.log || console.warn;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await store.transition(ctx.db, id, ["awaiting_phone"], "failed", { detail: "not_sent" }); return; }
    catch (err) { log(`[voice-handoff] ${id}: could not mark not_sent, try ${attempt} (${err?.message || err})`); }
  }
  try { await store.transition(ctx.db, id, ["awaiting_phone"], "expired", { detail: "not_sent" }); }
  catch (err) { log(`[voice-handoff] ${id}: could not expire the unsent row (${err?.message || err})`); }
}

/**
 * The propose branch: a `proposed` row (asked = the transcript, lang and device from the turn), the pending
 * entry 3.8's yes reads, and the server's spoken proposal. On a kiosk, or any surface but a phone or the
 * glasses, the proposal goes to the phone instead (proposeToPhone), for the tool and the "which" answer alike.
 * ctx: { core, pending, db, device, surface, lang, transcript, candidates }. botId must be one of the candidates.
 * → { ok: true, final: true, effect: false, code: "proposed" | "sent_to_phone" | "phone_off" | "phone_failed" | "already_sent", say }
 */
export async function proposeHandoff(ctx, task, botId) {
  const { core, pending, db, device, transcript, candidates } = ctx;
  const lang = langOf(ctx.lang);
  const target = candidates.find((c) => c.bot_id === botId);
  if (!target) throw new Error(`proposeHandoff: ${JSON.stringify(botId)} is not a candidate`);
  const surface = handoffSurface(ctx.surface);
  if (surface === "kiosk") return proposeToPhone(ctx, task, target, lang);
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
  if (!task) { await retirePending(ctx); return { ok: false, code: "bad_args" }; }
  const ids = new Set(ctx.candidates.map((c) => c.bot_id));
  const bot = typeof a.bot === "string" ? a.bot.trim() : "";
  const botOk = ids.has(bot);
  const others = [...new Set((Array.isArray(a.candidates) ? a.candidates : [])
    .filter((x) => typeof x === "string").map((x) => x.trim()).filter((x) => ids.has(x) && x !== bot))];
  if (botOk && !others.length) return proposeHandoff(ctx, task, bot);
  const lang = langOf(ctx.lang);
  const optionIds = [...(botOk ? [bot] : []), ...others];
  await retirePending(ctx);
  if (!optionIds.length) return done("none", voiceLine("handoff_none", lang));
  const options = optionIds.map((id) => {
    const c = ctx.candidates.find((x) => x.bot_id === id);
    return { bot_id: c.bot_id, name: c.name };
  });
  ctx.pending.set(ctx.device.id, { kind: "which", task, asked: typeof ctx.transcript === "string" ? ctx.transcript : null, options });
  // The entry keeps every valid option; the spoken question names the first two.
  const say = options.length >= 2
    ? voiceLine("handoff_which", lang, { a: options[0].name, b: options[1].name })
    : voiceLine("handoff_which_one", lang, { a: options[0].name });
  return done("which", say);
}

/**
 * The turn's crow_handoff tool, or [] when there is none: hand-offs off on the voice bot, or no candidate. It is
 * built on every surface; any surface but a phone or the glasses (a missing one too) is a kiosk, whose proposal
 * goes to the phone (proposeToPhone). The tool is offered (when) on a hand-off request (wantsHandoff, with the
 * candidates' names and ids) or while this device waits on a hand-off or a which; an offered turn starts the
 * candidates' model probes so the proposal finds them warm.
 * ctx: { db, device, surface, lang, bot, transcript, pending }
 */
async function forTurn(core, ctx) {
  const { db, device, bot, pending } = ctx || {};
  if (!db || !device?.id || !pending) return [];
  const surface = handoffSurface(ctx.surface);
  if (!normalizeVoiceSettings(bot).handoff.enabled) return [];
  // Every voice turn runs this: it must stay cached-only (the summary cache; the probes below are not awaited).
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
    agents: names,   // turn.js: "<one of these>'s on it" is a claim (action-claims.js)
    execute: async (args) => JSON.stringify(await runHandoffCall(call, args)),
  }];
}

// ---- The core and its seams ---------------------------------------------------------------------------------

/** The interactive engine; `createIfMissing: false` gives null when this process never minted one. */
async function defaultEngine({ createIfMissing = true } = {}) {
  const { getInteractiveEngine } = await import("../perch-interactive.js");
  return getInteractiveEngine({ createIfMissing });
}

/** A short-lived crow.db client for work that outlives the voice turn (the detached start, the turn-1 report). */
async function defaultWithDb(fn) {
  const db = createDbClient();
  try { return await fn(db); } finally { try { db.close(); } catch { /* already closed */ } }
}

function defaultWait(ms) {
  return new Promise((res) => { const t = setTimeout(res, ms); if (t && typeof t.unref === "function") t.unref(); });
}

/** presence.announce (PR 5, Task 5.2): spoken on a live voice surface. A presence that cannot load says nothing. */
async function defaultAnnounce(args) {
  let mod;
  try { mod = await import("./presence.js"); } catch { return { spokenOn: null }; }
  return typeof mod.announce === "function" ? mod.announce(args) : { spokenOn: null };
}

/**
 * A hand-off core from its seams. `give` is the give-service (createTaskForBot, startAfterGive,
 * fileStartedThread), `engine` an async getter for the interactive engine (`{ createIfMissing }`), `openTasksDb` the tasks.db client
 * a confirm opens and closes, `notify` createNotification, `withDb` a short-lived crow.db for detached work,
 * `wait` the start-budget timer, `announce` presence's (PR 5). `completion` is the "voice" result kind
 * (handoff-completion.js), built on the same store and announce seam; `status` answers "how's it going?"
 * (handoff-status.js). 5.4 adds stop.
 */
export function createHandoffCore({
  store = createHandoffStore(),
  summaries = createSummaryCache(),
  availability = modelAvailability,
  loadVoiceDef = createVoiceBotLoader({ generation: botDefsGeneration }),
  give = { createTaskForBot, startAfterGive, fileStartedThread },
  engine = defaultEngine,
  openTasksDb = () => createDbClient(tasksDbPath()),
  notify = createNotification,
  withDb = defaultWithDb,
  wait = defaultWait,
  announce = defaultAnnounce,
  now = Date.now,
  log = (m) => console.warn(m),
} = {}) {
  // lastHandoffTopic (P31) and exchanges (P17, handoff-topic.js): device id → { id, exchange, at }, the hand-off
  // last spoken about there (a confirm, a status answer, a heads-up), and the turn count that dates it; on the
  // core, so they are shared like the core itself (P30).
  const core = { store, summaries, availability, loadVoiceDef, give, engine, openTasksDb, notify, withDb, wait, announce, now, inFlight: new Set(), lastHandoffTopic: new Map(), exchanges: new Map(), log };
  core.forTurn = (ctx) => forTurn(core, ctx);
  core.confirm = (db, id, decision, via) => confirm(core, db, id, decision, via);
  core.status = (db, ctx) => handoffStatus(core, db, ctx);
  // The announce is read through the core at call time, so a seam set later (tests, 5.2) is the one spoken.
  core.completion = createHandoffCompletion({ store, announce: (args) => announceHandoff(core, args?.handoffId ?? null, args), log });
  return core;
}

/**
 * Register the hand-off as the "voice" result kind (result-requesters.js): a claimed card's final report
 * sends the completion notice instead of the board's generic one. Boot does this once (post-listen), before
 * the warm-up restore.
 */
export function registerVoiceResultKind({ core = getHandoffCore() } = {}) {
  registerResultKind("voice", core.completion);
}

/**
 * The minute sweep over the log (handoff-store.js sweep): stale proposals expire, a stuck start is recovered
 * (an in-flight confirm is left alone), a pending stop is retried through the engine's stop, old verbatim
 * speech is scrubbed; then the started and quiet rows are reconciled with their card's result and their
 * session (handoff-status.js reconcileOpen, P13: it needs tasks.db, the engine, notify and announce, so it
 * runs here, not in the store). Armed once per core; unref'd. → { runOnce, stop }; runOnce resolves to the
 * store's counts plus `reconciled`.
 */
export function startHandoffSweep({ core = getHandoffCore(), intervalMs = 60_000, openDb = () => createDbClient() } = {}) {
  if (core.sweep) return core.sweep;
  // No engine in this process means no session to stop: the pending stop is settled, never an engine minted.
  const retryStop = async (sid) => {
    const eng = await core.engine({ createIfMissing: false });
    if (!eng) throw Object.assign(new Error("no_such_session"), { code: "no_such_session" });
    return eng.stop(sid);
  };
  const runOnce = async () => {
    const db = openDb();
    try {
      const out = await core.store.sweep(db, { inFlight: core.inFlight, findCard: findHandoffCard, retryStop });
      // The reconcile rides the same pass; its failure is logged and never loses the store sweep's counts.
      try { out.reconciled = await reconcileOpen(core, db); }
      catch (err) { out.reconciled = null; core.log(`[voice-handoff] reconcile failed (${err?.message || err})`); }
      return out;
    } finally { try { db.close(); } catch { /* already closed */ } }
  };
  const timer = setInterval(() => { runOnce().catch((err) => core.log(`[voice-handoff] sweep failed (${err?.message || err})`)); }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  core.sweep = { runOnce, stop: () => { clearInterval(timer); core.sweep = null; } };
  return core.sweep;
}

// On a globalThis symbol (P30): a second module instance (a bundle-loaded copy under another APP_ROOT)
// shares the one store clock, in-flight set, sweep and result kind.
const SHARED = Symbol.for("crow.voice.handoff-core");
/** The process-wide hand-off core (lazy). */
export function getHandoffCore() {
  globalThis[SHARED] ??= createHandoffCore();
  return globalThis[SHARED];
}

/** The transcript names one of the OTHER candidates (a whole-name hit): a correction, whatever else it says. */
function namesAnother(transcript, names) {
  const words = phraseWords(transcript);
  const bots = (Array.isArray(names) ? names : []).map((n) => phraseWords(String(n ?? ""))).filter((w) => w.length);
  return words.length > 0 && listMatches(words, bots);
}

/**
 * The runner's deps.voiceActions member, sharing the runner's pending store (pending.js chainVoiceActions).
 *   fastPath     a pending hand-off: yes → core.confirm (the server speaks what really happened), no → declined;
 *                a transcript naming another candidate is a correction (null, even after "no": the model
 *                re-proposes). A pending which: an answer naming one option re-proposes through proposeHandoff
 *                (purpose "handoff", or none), or answers that bot's status (purpose "status", P18); a no
 *                declines. With nothing of its own pending: a status question (core.status, handoff-status.js)
 *                answered from the log, never the model. Anything else → null. The entry is taken only when it
 *                is answered. Never on a relay turn (turn.js skips fastPath there).
 *   turnContext  a pending hand-off or which: "[Hand-off] Waiting for a yes or no: …", pending (an action turn,
 *                so a reply claiming the bot started is held and replaced); it reads only the entry [rv1 C6]
 *   afterTurn    every turn counts one exchange on the device (handoff-topic.js). A turn that left a pending
 *                hand-off or which unanswered (no crow_handoff call) takes it and expires its row; a routine or
 *                which_calendar entry is never touched. A relay turn (relay: true, turn.js's relay contract)
 *                takes a pending hand-off, which or stop whatever was called, and expires a hand-off's row
 */
export function createHandoffVoiceActions({ core, pending } = {}) {
  const statusOf = (ctx) => core.status(ctx.db, { ...ctx, pending });
  return {
    async fastPath({ db, device, surface, transcript, lang, bot } = {}) {
      const id = device?.id;
      if (!id || !db) return null;
      const peek = pending.get(id);
      if (!peek || !OWN_KINDS.has(peek.kind)) return statusOf({ db, device, surface, transcript, lang, bot });
      const speak = langOf(lang);
      if (peek.kind === "handoff") {
        if (namesAnother(transcript, peek.names)) return null;
        const answer = matchYesNo(transcript, { otherBots: peek.names });
        if (!answer) return null;
        // A no that changes the task ("no, have writer write a summary instead", "no, make it about radio drama")
        // is a correction too: the model re-proposes. Only the OTHER bots' names count for the work check, so
        // naming this bot in a refusal ("no, writer doesn't need to") still declines, as does a bare no.
        if (answer === "no" && (wantsHandoff(transcript, peek.names || []) || changesContent(transcript))) return null;
        const entry = pending.take(id);   // act on what take() returned, never the earlier copy
        if (!entry || entry.kind !== "handoff" || entry.id !== peek.id) return null;
        const r = await core.confirm(db, entry.id, answer, "voice");
        // The yes makes this hand-off the device's topic: a bare "how's it going?" soon after is about it (P17).
        if (answer === "yes") rememberTopic(core, id, entry.id, { inTurn: true });
        return { say: r.say || voiceLine("handoff_failed", speak, { bot: entry.name }), verb: "handoff_" + r.status };
      }
      const pick = matchChoice(transcript, peek.options.map((o) => ({ ...o, match: o.bot_id })));
      if (peek.purpose === "status") {
        // "Which one?" after a status question (P18): the named bot's row is answered; a fresh status question
        // ("how's writer doing?") answers too; a no lets it go. Nothing of this proposes a hand-off.
        if (pick) {
          const entry = pending.take(id);
          if (!entry || entry.kind !== "which" || entry.purpose !== "status") return null;
          const row = await core.store.get(db, pick.id);
          return row ? answerRow(core, db, row, { device, surface, lang: speak }) : { say: voiceLine("status_none", speak), verb: "status_none" };
        }
        const asked = await statusOf({ db, device, surface, transcript, lang, bot });
        if (asked) { if (asked.verb !== "status_which") pending.take(id); return asked; }
        if (matchYesNo(transcript) !== "no") return null;
        pending.take(id);
        return { say: voiceLine("declined", speak), verb: "handoff_declined" };
      }
      if (!pick) {
        if (matchYesNo(transcript) !== "no") return null;
        pending.take(id);
        return { say: voiceLine("declined", speak), verb: "handoff_declined" };
      }
      const candidates = bot ? (await core.summaries.get(db, bot)).filter((c) => SAFE_BOT_ID.test(c.bot_id)) : [];
      if (!candidates.some((c) => c.bot_id === pick.bot_id)) {
        pending.take(id);
        return { say: voiceLine("handoff_failed", speak, { bot: pick.name }), verb: "handoff_failed" };
      }
      // proposeHandoff retires the which entry itself (the entry is replaced by the proposal's).
      // The card's "Operator's words" is the original request, not the answer to "which one?".
      const out = await proposeHandoff({ core, pending, db, device, surface, lang: speak, transcript: peek.asked ?? transcript, candidates, log: core.log }, peek.task, pick.bot_id);
      return { say: out.say, verb: "handoff_which" };
    },
    turnContext({ device } = {}) {
      const e = device?.id ? pending.get(device.id) : null;
      if (!e || !OWN_KINDS.has(e.kind)) return null;
      if (e.kind === "which" && e.purpose === "status") {
        return { text: `[Hand-off] Waiting for which bot's task the user is asking about: ${e.options.map((o) => o.name).join(" or ")}. Do not guess at its progress.`, pending: true };
      }
      const what = e.kind === "handoff" ? `${e.name}: ${e.task}` : `${e.options.map((o) => o.name).join(" or ")}: ${e.task}`;
      return { text: `[Hand-off] Waiting for a yes or no: ${what}. If the user changes the bot or the task, call crow_handoff again with the change.`, pending: true };
    },
    async afterTurn({ db, device, calledTools = [], relay = false } = {}) {
      if (!device?.id) return;
      bumpExchange(core, device.id);
      const e = pending.get(device.id);
      if (!e) return;
      if (relay === true ? !RELAY_KINDS.has(e.kind) : !OWN_KINDS.has(e.kind) || calledTools.includes(HANDOFF_TOOL_NAME)) return;
      pending.take(device.id);
      if (e.kind === "handoff" && e.id) await core.store.transition(db, e.id, ["proposed"], "expired");
    },
  };
}
