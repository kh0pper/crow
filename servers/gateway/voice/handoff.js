/**
 * The voice hand-off (PR 3, Tasks 3.7 and 3.8): the `crow_handoff` tool the voice model calls to propose giving
 * a bigger job to one of the operator's bots, to ask "which one?", or to say none can, and the spoken yes that
 * hands it over. The tool never creates a card: it writes a `proposed` row (handoff-store.js) and a pending
 * entry, and the server speaks the proposal. The yes (fastPath → core.confirm) creates the card as a hand-made
 * Give card and starts the bot truthfully: "on it" is said only once the bot really started, inside the start
 * budget, on a model that was up; otherwise "starting up", and a first turn that fails is reported once.
 *
 *   getHandoffCore()                  the process singleton: { store, summaries, availability, loadVoiceDef, give,
 *                                     engine, openTasksDb, notify, inFlight, forTurn, confirm }
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
import { createSummaryCache, listHandoffCandidates, cleanName } from "./bot-summaries.js";
import { createVoiceBotLoader } from "./crow-voice.js";
import { botDefsGeneration } from "./defs-generation.js";
import { modelAvailability } from "./model-availability-voice.js";
import { matchYesNo, changesContent } from "./pending.js";
import { matchChoice } from "./own-tools.js";
import { phraseWords, listMatches } from "./tool-families.js";
import { HANDOFF_TASK_MAX_CHARS, HANDOFF_START_BUDGET_MS } from "./handoff-constants.js";
import { normalizeVoiceSettings } from "../../shared/voice-bot.js";
import { createNotification } from "../../shared/notifications.js";
import { createDbClient } from "../../db.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { createTaskForBot, startAfterGive, fileStartedThread } from "../board/give-service.js";
import { claimResult } from "../board/result-requesters.js";
import { cardDrawerHref } from "../board/card-link.js";

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

const langOf = (lang) => (lang === "es" ? "es" : "en");
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

// ---- The spoken yes: core.confirm ------------------------------------------------------------------------

const TITLE_MAX = 120;
/** How the card names the surface the yes came from (the device name is never written into a card). */
const SURFACE_LABELS = { phone: "phone", glasses: "glasses", kiosk: "kiosk" };
export const surfaceLabel = (surface) => SURFACE_LABELS[surface] || "voice";

/** The task cut at `max` characters on a word boundary. */
function cutOnWord(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  return (at > 0 ? head.slice(0, at) : s.slice(0, max)).trimEnd();
}

/** The card description: the task, the operator's words, and where the ask came from. */
function cardDescription(row, now) {
  const asked = row.asked == null ? row.task : row.asked;
  return `${row.task}\n\nOperator's words: "${asked}"\n\nAsked by voice (Crow, ${surfaceLabel(row.surface)}) on ${new Date(now).toISOString().slice(0, 10)}. `
    + "When you are done, call board_report_result. Keep anything you write; nothing is undone if this task is stopped.";
}

/** The bot's display name for the spoken lines and the phone page, whatever its state now (a refused bot is still named). */
export async function botName(db, botId) {
  try {
    const row = (await db.execute({ sql: "SELECT display_name FROM pi_bot_defs WHERE bot_id = ?", args: [botId] })).rows[0];
    return cleanName(row && row.display_name, botId);
  } catch { return String(botId); }
}

/**
 * The target as the CURRENT settings allow it, or null: the voice bot enabled, hand-offs on, and the bot still
 * a candidate (enabled, board on, allowed). listHandoffCandidates is read uncached here: a setting saved one
 * second before the yes counts, and the 60 s summary cache never answers a confirm.
 */
async function allowedTarget(core, db, botId) {
  const v = await core.loadVoiceDef(db);
  const def = v && v.def;
  if (!def || !normalizeVoiceSettings(def).handoff.enabled) return null;
  return (await listHandoffCandidates(db, def)).find((c) => c.bot_id === botId) || null;
}

/** starting → `to` (failed or queued) with its detail. A stop that landed first keeps the row stopped and is said so. */
async function settle(core, db, h, to, detail, key) {
  const vars = { bot: h.name, task: h.task };
  if (await core.store.transition(db, h.id, ["starting"], to, { detail })) return { status: to, say: voiceLine(key, h.lang, vars) };
  const now = await core.store.get(db, h.id);
  if (now && now.status === "stopped") return { status: "stopped", say: voiceLine("status_stopped", h.lang, vars) };
  return { status: to, say: voiceLine(key, h.lang, vars) };
}

/** A confirm CAS that lost: the row is past its TTL (still in `from`) → expired (a no still just declines);
 * otherwise it was decided already. */
async function lostConfirm(core, db, h, from, decision) {
  const now = await core.store.get(db, h.id);
  if (!now) return { status: "none" };
  const vars = { bot: h.name, task: h.task };
  if (from.includes(now.status)) {
    await core.store.transition(db, h.id, from, "expired");
    return { status: "expired", say: decision === "no" ? voiceLine("declined", h.lang) : voiceLine("handoff_failed", h.lang, vars) };
  }
  return { status: "already", say: voiceLine("handoff_already", h.lang, vars) };
}

/**
 * The start could not be reported by the yes itself (it was said "starting up"): one high-priority
 * notification that opens the card, unless Perch's own push already went out (`skipNotify`), plus the spoken
 * heads-up on a live voice surface (presence.js, PR 5; a no-op until it exists).
 */
async function notifyStartFailed(core, db, h, { skipNotify = false } = {}) {
  const vars = { bot: h.name, task: h.task };
  if (!skipNotify) {
    try {
      await core.notify(db, { type: "attention", priority: "high", title: voiceLine("handoff_start_failed", h.lang, vars), action_url: await cardDrawerHref(db, h.cardId) });
    } catch (err) { core.log(`[voice-handoff] ${h.id}: start-failed notification failed (${err?.message || err})`); }
  }
  Promise.resolve().then(() => core.announce({
    originDeviceId: h.deviceId,
    lineFor: (surface) => voiceLine(surface === "kiosk" ? "start_failed_spoken_kiosk" : "handoff_start_failed", h.lang, vars),
  })).catch((err) => core.log(`[voice-handoff] ${h.id}: announce failed (${err?.message || err})`));
}

/**
 * Watch the session's first counted turn: a turn 1 that fails, stalls, exits or is refused moves the row
 * started → queued ("turn1_<outcome>") and reports it once. The watcher is registered synchronously, right
 * after the started CAS, and the engine replays a turn 1 that already ended (replay: true). First and
 * synchronously it drops the turn's own away push, so Perch's "turn failed" is not a second notification; a
 * replayed turn that already pushed (alreadyPushed) gets no second one from here either.
 */
function watchFirstTurn(core, eng, h, sessionId) {
  try {
    eng.watchTurns(sessionId, (ctx) => {
      if (ctx.outcome === "ok") return;
      ctx.suppressPush();
      core.withDb(async (db) => {
        if (!(await core.store.transition(db, h.id, ["started"], "queued", { detail: "turn1_" + ctx.outcome }))) return;
        await notifyStartFailed(core, db, h, { skipNotify: ctx.alreadyPushed === true });
      }).catch((err) => core.log(`[voice-handoff] ${h.id}: first-turn report failed (${err?.message || err})`));
    }, { first: true });
  } catch (err) {
    core.log(`[voice-handoff] ${h.id}: could not watch the first turn of ${sessionId} (${err?.code || err?.message || err})`);
  }
}

/**
 * The spawn settled (inside the budget, or detached): true when the starting → started CAS won. A CAS lost to
 * a stop stops the session that just appeared (engine.stop first, then the session id is written, in separate
 * tries; a stop error leaves detail "stop_pending" for the sweep to retry) and registers no watcher. A CAS lost
 * to the sweep writes the session id and leaves the session running (the card exists, and the result still
 * reaches the operator). A spawn that did not start queues the row and reports it.
 */
async function finishStart(core, db, getEng, h, r) {
  const { store } = core;
  if (r.started !== true) {
    if (await store.transition(db, h.id, ["starting"], "queued", { detail: String(r.code || "start_failed") })) await notifyStartFailed(core, db, h);
    return false;
  }
  const ids = { session_id: r.sessionId, thread_id: r.threadId ?? null };
  const eng = await getEng();   // started, so dispatchCard already resolved it: this is the memoized singleton
  if (await store.transition(db, h.id, ["starting"], "started", ids)) {
    watchFirstTurn(core, eng, h, r.sessionId);   // before any other await: the engine replays a turn 1 that already ended
    if (r.threadId) await core.give.fileStartedThread(db, { threadId: r.threadId, projectId: h.projectId });
    return true;
  }
  const now = await store.get(db, h.id);
  const fields = { ...ids };
  if (now && now.status === "stopped") {
    try {
      await eng.stop(r.sessionId);
    } catch (err) {
      if (err?.code !== "no_such_session") {
        fields.detail = "stop_pending";
        core.log(`[voice-handoff] ${h.id}: stop of ${r.sessionId} failed, left pending for the sweep (${err?.message || err})`);
      }
    }
  }
  try { await store.setFields(db, h.id, fields); }
  catch (err) { core.log(`[voice-handoff] ${h.id}: could not record session ${r.sessionId} (${err?.message || err})`); }
  return false;
}

/**
 * core.confirm(db, id, decision, via) → { status, say }. `via` is "voice" (a spoken yes; a dashboard tab too) or
 * "phone" (the phone confirm page, PR 4); each confirms only its own row state. Statuses: declined | started |
 * starting | stopped | queued | failed | already | expired | wrong_kind | none | bad_decision (anything but "yes"/"no"). Every line is in the row's language.
 *
 *  1. Only a `handoff` row; a stop row is never confirmed here (wrong_kind, no write).
 *  2. no → declined (live: an expired row is not declined, it is expired).
 *  3. The CAS proposed/awaiting_phone → starting, the TTL inside it; the id is in `inFlight` from the win
 *     until the start settles (the sweep leaves an in-flight row alone).
 *  4. The current settings are re-checked (allowedTarget) → failed "not_allowed".
 *  5. The card, synchronously: createTaskForBot (a hand-made Give card: the bot's project, the builtin
 *     autonomy, tags crow-voice), card_id on the row, the result claimed for the voice rail.
 *  6. No start (start_now 0, or the model unavailable now) → queued.
 *  7. The spawn is detached and raced against HANDOFF_START_BUDGET_MS. Settled, started, on an `up` model →
 *     finishStart; "on it" only when its CAS won. Settled and not started → queued. Otherwise "starting up",
 *     and the detached chain finishes the start and reports a failure; it ends in catch(log).finally(...).
 */
async function confirm(core, db, id, decision, via) {
  const { store } = core;
  const row = await store.get(db, id);
  if (!row) return { status: "none" };
  if (row.kind !== "handoff") return { status: "wrong_kind" };
  const from = via === "phone" ? ["awaiting_phone"] : ["proposed"];
  const h = { id, lang: langOf(row.lang), name: await botName(db, row.bot_id), task: row.task, deviceId: row.device_id, cardId: null, projectId: null };
  if (decision !== "yes" && decision !== "no") return { status: "bad_decision" };
  if (decision === "no") {
    if (await store.transition(db, id, from, "declined", {}, { live: true })) return { status: "declined", say: voiceLine("declined", h.lang) };
    return lostConfirm(core, db, h, from, "no");
  }
  if (!(await store.transition(db, id, from, "starting", {}, { live: true }))) return lostConfirm(core, db, h, from, "yes");
  core.inFlight.add(id);
  let detached = false;
  let tdb = null;
  const closeTasks = () => { if (tdb) { try { tdb.close(); } catch { /* already closed */ } tdb = null; } };
  try {
    const target = await allowedTarget(core, db, row.bot_id);
    if (!target) return await settle(core, db, h, "failed", "not_allowed", "handoff_failed");
    h.name = target.name;

    let created;
    try {
      tdb = core.openTasksDb();
      created = await core.give.createTaskForBot(db, tdb, row.bot_id, {
        title: cutOnWord(row.task, TITLE_MAX), description: cardDescription(row, core.now()), tags: "crow-voice",
        audit: { via: "voice", surface: row.surface, handoff_id: id },
      });
    } catch (err) {
      // No card: a give refusal keeps its code; anything else (the tasks store could not be opened or written)
      // is "tasks_db". The row settles now, never left `starting` for the sweep.
      if (err?.cardId == null) return await settle(core, db, h, "failed", err?.http && err?.code ? String(err.code) : "tasks_db", "handoff_failed");
      // The card exists (the audit row after it failed): it is on the board, and it waits there.
      h.cardId = err.cardId;
      await store.setFields(db, id, { card_id: err.cardId });
      claimResult(err.cardId, "voice");
      core.log(`[voice-handoff] ${id}: card ${err.cardId} created, give audit failed (${err?.message || err})`);
      return await settle(core, db, h, "queued", String(err?.code || "audit_failed"), "handoff_queued");
    }
    h.cardId = created.cardId;
    h.projectId = Number(created.row.project_id);
    await store.setFields(db, id, { card_id: created.cardId });
    claimResult(created.cardId, "voice");

    const avail = await core.availability(db, row.model_key);
    if (!(row.start_now === 1 && avail !== "unavailable")) {
      return await settle(core, db, h, "queued", !target.perch ? "perch_not_attached" : "model_unavailable", "handoff_queued");
    }

    // Lazy and memoized: the engine singleton is minted only when dispatchCard gets past its own checks.
    let engP = null;
    const getEng = () => (engP ??= core.engine());
    // ctx.db is the assignment guard's crow.db read (dispatchCard); it is used only before the spawn.
    const p = core.give.startAfterGive({ db, tdb }, { row: created.row, getEng, botId: row.bot_id, cardId: created.cardId, start: true, note: "" });
    const raced = await Promise.race([p.then((r) => ({ r })), core.wait(HANDOFF_START_BUDGET_MS).then(() => null)]);
    const vars = { bot: h.name, task: h.task };
    if (raced && raced.r.started !== true) return await settle(core, db, h, "queued", String(raced.r.code || "start_failed"), "handoff_queued");
    if (raced && avail === "up") {
      const won = await finishStart(core, db, getEng, h, raced.r);
      return won ? { status: "started", say: voiceLine("handoff_started", h.lang, vars) } : { status: "stopped", say: voiceLine("status_stopped", h.lang, vars) };
    }
    detached = true;
    p.then((r) => core.withDb((d) => finishStart(core, d, getEng, h, r)))
      .catch((err) => core.log(`[voice-handoff] ${id}: the detached start failed (${err?.message || err})`))
      .finally(() => { core.inFlight.delete(id); closeTasks(); });
    return { status: "starting", say: voiceLine("handoff_starting_up", h.lang, vars) };
  } finally {
    if (!detached) { core.inFlight.delete(id); closeTasks(); }
  }
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

/** presence.announce (PR 5): spoken on a live voice surface. Until the module exists, nothing. */
async function defaultAnnounce(args) {
  let mod;
  try { mod = await import("./presence.js"); } catch { return null; }
  return typeof mod.announce === "function" ? mod.announce(args) : null;
}

/**
 * A hand-off core from its seams. `give` is the give-service (createTaskForBot, startAfterGive,
 * fileStartedThread), `engine` an async getter for the interactive engine (`{ createIfMissing }`), `openTasksDb` the tasks.db client
 * a confirm opens and closes, `notify` createNotification, `withDb` a short-lived crow.db for detached work,
 * `wait` the start-budget timer, `announce` presence's (PR 5). 5.3 and 5.4 add status and stop.
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
  const core = { store, summaries, availability, loadVoiceDef, give, engine, openTasksDb, notify, withDb, wait, announce, now, inFlight: new Set(), log };
  core.forTurn = (ctx) => forTurn(core, ctx);
  core.confirm = (db, id, decision, via) => confirm(core, db, id, decision, via);
  return core;
}

/**
 * The minute sweep over the log (handoff-store.js sweep): stale proposals expire, a stuck start is recovered
 * (an in-flight confirm is left alone), a pending stop is retried through the engine's stop, old verbatim
 * speech is scrubbed. Armed once per core; unref'd. → { runOnce, stop }.
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
    try { return await core.store.sweep(db, { inFlight: core.inFlight, findCard: findHandoffCard, retryStop }); }
    finally { try { db.close(); } catch { /* already closed */ } }
  };
  const timer = setInterval(() => { runOnce().catch((err) => core.log(`[voice-handoff] sweep failed (${err?.message || err})`)); }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  core.sweep = { runOnce, stop: () => { clearInterval(timer); core.sweep = null; } };
  return core.sweep;
}

let shared = null;
/** The process-wide hand-off core (lazy). */
export function getHandoffCore() {
  shared ??= createHandoffCore();
  return shared;
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
 *                re-proposes). A pending which: an answer naming one option re-proposes through proposeHandoff,
 *                a no declines. Anything else → null. The entry is taken only when it is answered.
 *   turnContext  a pending hand-off or which: "[Hand-off] Waiting for a yes or no: …", pending (an action turn,
 *                so a reply claiming the bot started is held and replaced); it reads only the entry [rv1 C6]
 *   afterTurn    a turn that left a pending hand-off or which unanswered (no crow_handoff call) takes it and
 *                expires its row; a routine or which_calendar entry is never touched. A relay turn (relay: true,
 *                turn.js's relay contract) takes a pending hand-off, which or stop whatever was called, and
 *                expires a hand-off's row
 */
export function createHandoffVoiceActions({ core, pending } = {}) {
  return {
    async fastPath({ db, device, surface, transcript, lang, bot } = {}) {
      const id = device?.id;
      if (!id || !db) return null;
      const peek = pending.get(id);
      if (!peek || !OWN_KINDS.has(peek.kind)) return null;
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
        return { say: r.say || voiceLine("handoff_failed", speak, { bot: entry.name }), verb: "handoff_" + r.status };
      }
      const pick = matchChoice(transcript, peek.options.map((o) => ({ ...o, match: o.bot_id })));
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
      const what = e.kind === "handoff" ? `${e.name}: ${e.task}` : `${e.options.map((o) => o.name).join(" or ")}: ${e.task}`;
      return { text: `[Hand-off] Waiting for a yes or no: ${what}. If the user changes the bot or the task, call crow_handoff again with the change.`, pending: true };
    },
    async afterTurn({ db, device, calledTools = [], relay = false } = {}) {
      if (!device?.id) return;
      const e = pending.get(device.id);
      if (!e) return;
      if (relay === true ? !RELAY_KINDS.has(e.kind) : !OWN_KINDS.has(e.kind) || calledTools.includes(HANDOFF_TOOL_NAME)) return;
      pending.take(device.id);
      if (e.kind === "handoff" && e.id) await core.store.transition(db, e.id, ["proposed"], "expired");
    },
  };
}
