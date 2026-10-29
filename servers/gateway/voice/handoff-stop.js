/**
 * "Stop it" (PR 5, Task 5.4): the operator asks Crow to stop a handed-off job. Crow confirms first, always: a
 * spoken yes on a phone or the glasses (a pending `stop` entry), or the phone confirm page for a kiosk (an
 * `awaiting_phone` stop row, decided through core.decideStop by the PR 4 route). Then the bot's session is
 * stopped and everything it made is kept: the card stays where it is, nothing is archived, moved, deleted or
 * rolled back. Never imports handoff.js; handoff.js wires `stop` and `decideStop` onto the core and dispatches
 * the fast path here.
 *
 *   stop(core, db, id, via)                 → { status: "stopped"|"stopping"|"pending_start"|"already"|"none", say } [rv3 m5]
 *   decideStop(core, db, stopId, decision)  → { status: "done"|"declined"|"failed"|"expired"|"already"|"none"|"wrong_kind"|"bad_decision", … } [rv1 C4]
 *   stopIntent(core, db, ctx)               the fast path for a stop request (wantsHandoffStop) → { say, verb } | null
 *   stopConfirmed(core, db, ctx, entry)     the spoken yes on a pending stop entry
 *   proposeStop(core, db, ctx, row)         ask to stop `row`: the spoken question, or the phone page on a kiosk
 *
 * Which hand-off (P20, P23): the scope is the status scope (handoff-status.js rowsInScope: a kiosk sees its own
 * device's rows, a personal surface every device's), open rows only, and the matchers fire only with one open.
 * A named bot takes that bot's open rows (`stop_already` when it only just ended, `stop_none` when it has
 * none); a work target ("stop the research") takes every open row; a pronoun ("stop it") only the device's
 * last hand-off topic within HANDOFF_TOPIC_EXCHANGES, else null and the media path has it as today. Several
 * bots with open work ask which (a `which` entry with purpose "stop", P18).
 *
 * Media (P21): a pronoun stop while media or a timer is active on the surface (ctx.mediaActive(); an absent
 * or throwing flag counts as active) asks `stop_propose_media`; its yes is the confirmation, anything else
 * falls through to the media path. A named stop never asks that.
 *
 * core.stop, the steps [rv3 m2]: CAS first, then re-read, and `session_id` decides.
 *   1. starting → stopped (detail "pending_start"). Won with no session yet: `pending_start` [rv2 N1]: the
 *      in-flight finishStart loses its own CAS and stops the session the moment it exists (it never waits on
 *      the spawn, which can take the whole model warm). Won with a session (finishStart already lost and
 *      wrote it): step 2. Else started/quiet/queued → stopped; won without a session (a queued card):
 *      `stopped` said as stopped_queued; with one: step 2. Both lost: `already` (`none` without a row).
 *   2. The session must still hold this card and bot (P25: a re-attached session is never stopped for the
 *      wrong work): otherwise detail "session_moved", no engine call, `already`. Then engine.stop;
 *      no_such_session counts as stopped; any other throw leaves detail "stop_pending" for the sweep's retry
 *      and answers `stopping` [rv3 m1].
 *   3. One board mutation handoff_stopped (DASHBOARD_ACTOR; via and the hand-off id) on the card [rv1 S].
 *   4. The result claim is released (guarded on a card, P9).
 */
import { PERSONAL_SURFACES } from "./handoff-constants.js";
import { wantsHandoffStop, stopShape } from "./handoff-intent.js";
import { voiceLine } from "./voice-lines.js";
import { botName, langOf } from "./handoff-confirm.js";
import { rowsInScope, resolveRows, candidatesOf } from "./handoff-status.js";
import { rememberTopic, topicFor } from "./handoff-topic.js";
import { sendToPhone, displayNameOf } from "./handoff-phone.js";
import { releaseResult } from "../board/result-requesters.js";
import { recordMutation } from "../board/card-service.js";
import { DASHBOARD_ACTOR } from "../board/give-service.js";

/** The core.stop statuses on which a phone-confirmed stop row is `done` [rv2 m6, rv3 m5]. */
const STOP_DONE = new Set(["stopped", "stopping", "pending_start"]);
const OPEN_FROM = Object.freeze(["started", "quiet", "queued"]);
const DETAIL_MAX = 60;

/** releaseResult, guarded (P9): a row without a card has no claim. */
function release(cardId) {
  const n = Number(cardId);
  if (Number.isInteger(n) && n > 0) releaseResult(n);
}

/** Steps 3 and 4: the card's handoff_stopped mutation (its failure is logged: the stop happened) and the claim release. */
async function endedOnCard(core, db, row, via, reason = null) {
  if (row.card_id == null) return;
  let tdb = null;
  try {
    tdb = core.openTasksDb();
    await recordMutation(tdb, { itemId: Number(row.card_id), verb: "handoff_stopped", actor: DASHBOARD_ACTOR, detail: { via, handoff_id: row.id, ...(reason ? { reason } : {}) } });
  } catch (err) {
    core.log(`[voice-handoff] ${row.id}: could not record the stop on card ${row.card_id} (${err?.message || err})`);
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
  release(row.card_id);
}

/** P25: the session's perch-live row names another card or bot than the hand-off's (true), or still this work (false). */
async function sessionMoved(db, row) {
  const { rows } = await db.execute({
    sql: "SELECT card_id, bot_id FROM bot_sessions WHERE kind = 'perch-live' AND gateway_thread_id = ? ORDER BY id DESC LIMIT 1",
    args: [String(row.session_id)],
  });
  const s = rows[0];
  if (!s) return false;
  const sameCard = (s.card_id == null ? null : Number(s.card_id)) === (row.card_id == null ? null : Number(row.card_id));
  return !sameCard || String(s.bot_id) !== String(row.bot_id);
}

/** Step 2: stop the row's session, then the card's record and claim. `now` is the row as re-read after the CAS. */
async function stopSession(core, db, now, via, line) {
  if (await sessionMoved(db, now)) {
    await core.store.setFields(db, now.id, { detail: "session_moved" });
    await endedOnCard(core, db, now, via, "session_moved");
    return { status: "already", say: line("stop_already") };
  }
  let pendingStop = false;
  try {
    const eng = await core.engine();
    await eng.stop(now.session_id);
  } catch (err) {
    if (err?.code !== "no_such_session") {
      pendingStop = true;
      core.log(`[voice-handoff] ${now.id}: stop of ${now.session_id} failed, left pending for the sweep (${err?.message || err})`);
    }
  }
  // The detail is the stop's state now: a pending retry, or nothing (a start-race mark is cleared).
  if (pendingStop) await core.store.setFields(db, now.id, { detail: "stop_pending" });
  else if (now.detail === "pending_start" || now.detail === "stop_pending") await core.store.setFields(db, now.id, { detail: null });
  await endedOnCard(core, db, now, via);
  return pendingStop ? { status: "stopping", say: line("stop_requested") } : { status: "stopped", say: line("stopped") };
}

/** core.stop(db, id, via): see the header. `via` is "voice" (a spoken yes) or "phone" (the phone page). */
export async function stop(core, db, id, via) {
  const { store } = core;
  const row = await store.get(db, id);
  if (!row || row.kind !== "handoff") return { status: "none", say: voiceLine("stop_none", langOf(row?.lang)) };
  const lang = langOf(row.lang);
  const vars = { bot: await botName(db, row.bot_id), task: row.task };
  const line = (key) => voiceLine(key, lang, vars);

  if (await store.transition(db, id, ["starting"], "stopped", { detail: "pending_start" })) {
    const now = await store.get(db, id);
    // A session here means finishStart lost to us and already stopped it: our engine.stop is a harmless
    // second call (no_such_session, or a no-op on a stopped session).
    if (now?.session_id) return stopSession(core, db, now, via, line);
    await endedOnCard(core, db, now ?? row, via, "pending_start");
    return { status: "pending_start", say: line("stop_pending_start") };
  }
  if (await store.transition(db, id, OPEN_FROM, "stopped")) {
    const now = await store.get(db, id);
    if (now?.session_id) return stopSession(core, db, now, via, line);
    await endedOnCard(core, db, now ?? row, via);
    return { status: "stopped", say: line("stopped_queued") };
  }
  if (!(await store.get(db, id))) return { status: "none", say: line("stop_none") };
  return { status: "already", say: line("stop_already") };
}

/** A decide CAS that lost: the row is past its TTL (still awaiting the phone) → expired; otherwise it was decided already. */
async function lostDecide(store, db, stopId) {
  const now = await store.get(db, stopId);
  if (!now) return { status: "none" };
  if (now.status === "awaiting_phone") {
    await store.transition(db, stopId, ["awaiting_phone"], "expired");
    return { status: "expired" };
  }
  return { status: "already" };
}

/**
 * core.decideStop(db, stopId, decision): the phone page's answer on a kiosk's stop row [rv1 C4]. Checked before any
 * write (P24): the row is a `stop` row (else wrong_kind; none without one), the decision exactly yes or no
 * (else bad_decision), and the target a `handoff` row of the same device and bot (else the stop row is
 * failed "bad_target"). no → declined. yes → the stop row is claimed (awaiting_phone → starting, the TTL inside
 * the CAS), core.stop runs on the target, and the stop row is `done` only on stopped, stopping or
 * pending_start [rv2 m6, rv3 m5]; already or none fail it with that detail, a throw with its code. It never
 * calls confirm or creates anything. → { status, detail? | stop? }.
 */
export async function decideStop(core, db, stopId, decision) {
  const { store } = core;
  const row = await store.get(db, stopId);
  if (!row) return { status: "none" };
  if (row.kind !== "stop") return { status: "wrong_kind" };
  if (decision !== "yes" && decision !== "no") return { status: "bad_decision" };
  const from = ["awaiting_phone"];
  const target = row.target_id ? await store.get(db, row.target_id) : null;
  if (!target || target.kind !== "handoff" || String(target.device_id) !== String(row.device_id) || String(target.bot_id) !== String(row.bot_id)) {
    if (await store.transition(db, stopId, from, "failed", { detail: "bad_target" }, { live: true })) return { status: "failed", detail: "bad_target" };
    return lostDecide(store, db, stopId);
  }
  if (decision === "no") {
    if (await store.transition(db, stopId, from, "declined", {}, { live: true })) return { status: "declined" };
    return lostDecide(store, db, stopId);
  }
  if (!(await store.transition(db, stopId, from, "starting", {}, { live: true }))) return lostDecide(store, db, stopId);
  let r;
  try {
    r = await core.stop(db, row.target_id, "phone");
  } catch (err) {
    const detail = String(err?.code || err?.message || "error").slice(0, DETAIL_MAX);
    await store.transition(db, stopId, ["starting"], "failed", { detail });
    return { status: "failed", detail };
  }
  if (STOP_DONE.has(r?.status)) {
    await store.transition(db, stopId, ["starting"], "done", { detail: r.status });
    return { status: "done", stop: r.status };
  }
  const detail = String(r?.status || "error").slice(0, DETAIL_MAX);
  await store.transition(db, stopId, ["starting"], "failed", { detail });
  return { status: "failed", detail };
}

/** The device's pending entry replaced by a stop question: anything but our own kinds is logged, never silently lost. */
function takeForeign(core, pending, deviceId) {
  const prev = pending.take(deviceId);
  if (prev && !["handoff", "which", "stop"].includes(prev.kind)) core.log(`[voice-handoff] ${deviceId}: a pending ${prev.kind} question was dropped for a stop`);
}

/** The kiosk branch: the stop row for `row` and its push, through the phone page. ctx: { device, lang, transcript }. */
async function stopToPhone(core, db, ctx, row, name) {
  const lang = langOf(ctx.lang);
  const r = await sendToPhone(core, db, {
    device: ctx.device, kind: "stop", lang, log: core.log,
    insert: () => core.store.insert(db, {
      kind: "stop", surface: "kiosk", device_id: ctx.device.id, device_name: ctx.device.name ?? null, bot_id: row.bot_id,
      task: row.task, asked: typeof ctx.transcript === "string" ? ctx.transcript : null, status: "awaiting_phone", target_id: row.id, lang,
    }),
    title: voiceLine("handoff_stop_phone_title", lang, { display: displayNameOf(ctx.device, lang), bot: name }),
    body: row.task,
  });
  return { say: r.say, verb: "stop_" + r.code };
}

/**
 * Ask to stop `row` (an open hand-off in scope). A personal surface: the pending stop entry and `stop_propose`
 * (its yes → stopConfirmed). A kiosk: the phone page (stopToPhone). ctx: { device, surface, lang, transcript,
 * pending }. The entry carries `phone: true` on a kiosk, so a media ask's yes there goes to the phone too.
 */
export async function proposeStop(core, db, ctx, row, { media = false } = {}) {
  const { device, pending } = ctx;
  const lang = langOf(ctx.lang);
  const name = await botName(db, row.bot_id);
  const kiosk = !PERSONAL_SURFACES.has(ctx.surface);
  if (kiosk && !media) return stopToPhone(core, db, ctx, row, name);
  takeForeign(core, pending, device.id);
  pending.set(device.id, { kind: "stop", id: row.id, bot_id: row.bot_id, name, task: row.task, phone: kiosk, media });
  if (media) return { say: voiceLine("stop_propose_media", lang, { bot: name }), verb: "stop_propose_media" };
  return { say: voiceLine("stop_propose", lang, { bot: name, task: row.task }), verb: "stop_propose" };
}

/**
 * The spoken yes on a pending stop entry (the entry is already taken). A kiosk's (a media ask there) goes to
 * the phone, after a re-read that the target is still open; a personal surface's runs core.stop and the row
 * becomes the device's topic. → { say, verb }.
 */
export async function stopConfirmed(core, db, ctx, entry) {
  const lang = langOf(ctx.lang);
  if (entry.phone === true) {
    const row = await core.store.get(db, entry.id);
    if (!row || row.kind !== "handoff") return { say: voiceLine("stop_none", lang), verb: "stop_none" };
    return stopToPhone(core, db, ctx, row, entry.name);
  }
  const r = await core.stop(db, entry.id, "voice");
  if (ctx.device?.id) rememberTopic(core, ctx.device.id, entry.id, { inTurn: true });
  return { say: r.say, verb: "stop_" + r.status };
}

/** "Writer and Helper" (list_and). */
function joinAnd(names, lang) {
  if (names.length <= 1) return names[0] || "";
  return voiceLine("list_and", lang, { rest: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

/** The flag says media or a timer is active, or cannot say (absent, or throwing): the pronoun stop asks (P21). */
function mediaMayBeActive(mediaActive) {
  if (typeof mediaActive !== "function") return true;
  try { return mediaActive() !== false; } catch { return true; }
}

/**
 * core's fast path for a stop request. ctx: { device, surface, transcript, lang, bot (the voice def, so its
 * candidates may be named), pending, mediaActive }. → { say, verb } or null (the media path or the model's
 * turn). Never a model call; the log is read only once a stop matcher fires.
 */
export async function stopIntent(core, db, { device, surface, transcript, lang, bot = null, pending = null, mediaActive = null } = {}) {
  if (!db || !device?.id || !pending || typeof transcript !== "string") return null;
  const speak = langOf(lang);
  const bots = new Map((await candidatesOf(core, db, bot)).map((c) => [c.bot_id, c.name]));
  const names = (m) => [...m].flatMap(([id, name]) => [name, id]);
  // The cached candidates and the stop check come first; a stop about something the candidates cannot name
  // ("stop writer" with writer no longer a candidate, or hand-offs turned off) still reaches the log when it
  // has a stop's shape (stopShape): the row bots' names are then tried too. Anything else is the model's.
  let kind = wantsHandoffStop(transcript, names(bots));
  if (!kind && !stopShape(transcript)) return null;
  const { open, ended } = await rowsInScope(core.store, db, device, surface, core.now());
  // The carried gate: a stop fires only with an open hand-off in scope; otherwise the words are the room's.
  if (!open.length) return null;
  for (const r of [...open, ...ended]) if (!bots.has(r.bot_id)) bots.set(r.bot_id, await botName(db, r.bot_id));
  if (!kind) kind = wantsHandoffStop(transcript, names(bots));
  if (!kind) return null;
  const ctx = { device, surface, lang: speak, transcript, pending };

  if (kind === "pronoun") {
    const topic = topicFor(core, device.id);
    const row = topic ? open.find((r) => r.id === topic.id) : null;
    if (!row) return null;
    return proposeStop(core, db, ctx, row, { media: mediaMayBeActive(mediaActive) });
  }

  const botList = [...bots].map(([bot_id, name]) => ({ bot_id, name }));
  const { named, rows } = resolveRows(transcript, open, botList);
  let about = open;
  if (named.length) {
    if (!rows.length) {
      const was = ended.find((r) => named.includes(r.bot_id));
      return was ? { say: voiceLine("stop_already", speak, { bot: bots.get(was.bot_id) }), verb: "stop_already" } : { say: voiceLine("stop_none", speak), verb: "stop_none" };
    }
    about = rows;
  }
  // The device's last topic when it is among them; else the one bot's newest; else which (purpose stop, P18).
  const topic = topicFor(core, device.id);
  const topical = topic ? about.find((r) => r.id === topic.id) : null;
  if (topical) return proposeStop(core, db, ctx, topical);
  const ids = [...new Set(about.map((r) => r.bot_id))];
  if (ids.length === 1) return proposeStop(core, db, ctx, about[0]);
  const which = ids.map((id) => ({ bot_id: id, name: bots.get(id), id: about.find((r) => r.bot_id === id).id }));
  takeForeign(core, pending, device.id);
  pending.set(device.id, { kind: "which", purpose: "stop", options: which, asked: transcript });
  return { say: voiceLine("status_which", speak, { list: joinAnd(which.map((w) => w.name), speak) }), verb: "status_which" };
}
