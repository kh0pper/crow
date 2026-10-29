/**
 * Confirming a hand-off (split out of handoff.js, Task 5.0): the spoken or phone yes (core.confirm), the start
 * that follows it, the first-turn watch and the start-failed report. It never imports handoff.js; handoff.js
 * imports it. Behaviour is unchanged by the move.
 */
import { voiceLine } from "./voice-lines.js";
import { listHandoffCandidates, cleanName } from "./bot-summaries.js";
import { HANDOFF_START_BUDGET_MS } from "./handoff-constants.js";
import { normalizeVoiceSettings } from "../../shared/voice-bot.js";
import { claimResult, releaseResult } from "../board/result-requesters.js";
import { cardDrawerHref } from "../board/card-link.js";
import { rememberTopic } from "./handoff-topic.js";

export const langOf = (lang) => (lang === "es" ? "es" : "en");

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
 * The spoken heads-up for hand-off `handoffId` (presence.announce through the core's seam). When it was really
 * spoken, the device it was spoken on records the hand-off as its last topic (P31: on the shared core), so a
 * follow-up "how's it going?" there is about this one. Said between turns (`inTurn: false`): the next exchange
 * is the first after it (handoff-topic.js counts the exchanges). → the announce result.
 */
export async function announceHandoff(core, handoffId, args) {
  const r = await core.announce({ ...args, handoffId });
  const on = r && typeof r.spokenOn === "string" && r.spokenOn ? r.spokenOn : null;
  if (on && handoffId != null) rememberTopic(core, on, handoffId, { inTurn: false });
  return r;
}

/** Fire the heads-up without waiting for it; a failure is logged, never thrown. */
export function announceLater(core, handoffId, args) {
  Promise.resolve().then(() => announceHandoff(core, handoffId, args))
    .catch((err) => core.log(`[voice-handoff] ${handoffId}: announce failed (${err?.message || err})`));
}

/**
 * The start could not be reported by the yes itself (it was said "starting up"): one high-priority
 * notification that opens the card, unless Perch's own push already went out (`skipNotify`), plus the spoken
 * heads-up on a live voice surface (presence.js). The heads-up says "the details are on your phone", so it is
 * spoken only once the phone really has them: after a notification that was sent (not turned off, not failed),
 * or after Perch's own push (`skipNotify`).
 */
export async function notifyRow(core, db, h, { titleKey, spokenKey = titleKey, kioskSpokenKey = spokenKey, skipNotify = false, label = "start-failed" } = {}) {
  const vars = { bot: h.name, task: h.task };
  let sent = skipNotify;
  if (!skipNotify) {
    try {
      sent = (await core.notify(db, { type: "attention", priority: "high", title: voiceLine(titleKey, h.lang, vars), action_url: await cardDrawerHref(db, h.cardId) })) != null;
    } catch (err) { core.log(`[voice-handoff] ${h.id}: ${label} notification failed (${err?.message || err})`); }
  }
  if (!sent) return;
  announceLater(core, h.id, {
    originDeviceId: h.deviceId,
    lineFor: (surface) => voiceLine(surface === "kiosk" ? kioskSpokenKey : spokenKey, h.lang, vars),
  });
}

/** The start-failed report: the one notification that opens the card, plus the spoken heads-up. */
const notifyStartFailed = (core, db, h, opts = {}) => notifyRow(core, db, h, {
  titleKey: "handoff_start_failed", spokenKey: "handoff_start_failed", kioskSpokenKey: "start_failed_spoken_kiosk", ...opts,
});

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
 * The spawn settled (inside the budget, or detached): { won: true } when the starting → started CAS won, else
 * { won: false, status } with the row's status as re-read. A CAS lost to a stop stops the session that just
 * appeared (engine.stop first, then the session id is written, in separate tries; a stop error leaves detail
 * "stop_pending" for the sweep to retry), releases the card's result claim (P32: the hand-off is over) and
 * registers no watcher. A CAS lost to the sweep, or to a report that landed inside the budget (the row is done
 * or failed already), writes the session id and leaves the session as it is (the card exists, and the result
 * still reaches the operator). A spawn that did not start queues the row and reports it.
 */
async function finishStart(core, db, getEng, h, r) {
  const { store } = core;
  if (r.started !== true) {
    if (await store.transition(db, h.id, ["starting"], "queued", { detail: String(r.code || "start_failed") })) await notifyStartFailed(core, db, h);
    return { won: false, status: "queued" };
  }
  const ids = { session_id: r.sessionId, thread_id: r.threadId ?? null };
  const eng = await getEng();   // started, so dispatchCard already resolved it: this is the memoized singleton
  if (await store.transition(db, h.id, ["starting"], "started", ids)) {
    watchFirstTurn(core, eng, h, r.sessionId);   // before any other await: the engine replays a turn 1 that already ended
    if (r.threadId) await core.give.fileStartedThread(db, { threadId: r.threadId, projectId: h.projectId });
    return { won: true };
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
    if (h.cardId != null) releaseResult(h.cardId);
  }
  try { await store.setFields(db, h.id, fields); }
  catch (err) { core.log(`[voice-handoff] ${h.id}: could not record session ${r.sessionId} (${err?.message || err})`); }
  return { won: false, status: now?.status ?? null };
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
 *     finishStart; "on it" when its CAS won, or when it lost to anything but a stop (a report inside the
 *     budget ended the row: the bot did start); a stop is said so. Settled and not started → queued. Otherwise "starting up",
 *     and the detached chain finishes the start and reports a failure; it ends in catch(log).finally(...).
 */
export async function confirm(core, db, id, decision, via) {
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
    // Project services: a hand-off is not the owner's own turn yet (rev 4 H3; owner ruling 2026-10-29: phone-confirmed
    // and glasses hand-offs become the owner's in roadmap PR 10, the kiosk never), so no connected accounts.
    const p = core.give.startAfterGive({ db, tdb }, { row: created.row, getEng, botId: row.bot_id, cardId: created.cardId, start: true, note: "", principal: "other" });
    const raced = await Promise.race([p.then((r) => ({ r })), core.wait(HANDOFF_START_BUDGET_MS).then(() => null)]);
    const vars = { bot: h.name, task: h.task };
    if (raced && raced.r.started !== true) return await settle(core, db, h, "queued", String(raced.r.code || "start_failed"), "handoff_queued");
    if (raced && avail === "up") {
      const fin = await finishStart(core, db, getEng, h, raced.r);
      // "On it" only when the CAS won [rv3 m2]; a stop that landed inside the budget is said so. A row already
      // done or failed (a report landed inside the budget) did start: it is "on it", never "stopped" (5.1 carry).
      if (fin.won || fin.status !== "stopped") return { status: "started", say: voiceLine("handoff_started", h.lang, vars) };
      return { status: "stopped", say: voiceLine("status_stopped", h.lang, vars) };
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
