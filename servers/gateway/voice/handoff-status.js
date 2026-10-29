/**
 * "How's it going?" (PR 5, Task 5.3): the operator asks about a handed-off job and Crow answers from the
 * hand-off log, the card's result and the bot's Perch session, never from the model. The answer is
 * reconciled with the real session, so a bot that ended its session without reporting, or has gone quiet,
 * is reported truthfully; the minute sweep runs the same reconcile over the open rows (P13), so a dead
 * session is not re-claimed at every boot. Never imports handoff.js; handoff.js wires `status` onto the core
 * and dispatches the fast path here.
 *
 *   status(core, db, { device, surface, transcript, lang, bot, pending })  → { say, verb } | null
 *   answerRow(core, db, row, { device, surface, lang })                     the spoken state of one row
 *   reconcileRow(core, db, row, { tdb, eng })                               → the state's line key (or null)
 *   reconcileOpen(core, db)                                                 the sweep's pass over started/quiet rows
 *   rowsInScope(store, db, device, surface, now), resolveRows(transcript, rows, bots)   shared with 5.4 (P20, P23)
 *
 * Scope (P23): a kiosk sees only its own device's rows; a phone or the glasses sees every personal row. Both
 * see the open rows plus the ones that ended in the last HANDOFF_ENDED_WINDOW_MS.
 *
 * Subject (P16): the fast path never takes ordinary speech. It answers when (a) a bot is named (`status_none`
 * when that bot has nothing in scope: truthful, never left to the model), or when (b) the work is named
 * (namesWork) or (c) the question is bare (a status phrase and filler only) within HANDOFF_TOPIC_EXCHANGES of
 * the last hand-off spoken of on this device, and for (b) and (c) only with something in scope. "Any news on
 * the election", "how's the game going", "is the timer done?" and a bare "how's it going?" with no recent
 * topic all go to the model.
 *
 * State, read in this order [rv1 S]: the row's status; for a started, queued or quiet row the card's newest
 * final board result (success or failure: a partial is progress, P12), which ends the row; then the newest
 * perch-live bot_sessions row (by gateway_thread_id, else by card, P11): `stopped` with no result ends the
 * row as failed "session_ended_no_result" and the CAS winner sends ONE handoff_ended_no_result notification
 * plus the heads-up [rv5 m3]; a question waiting on the operator (engine.waitingOnCard, P10: never adopts) is
 * needs-you, never quiet; `waiting-user` older than HANDOFF_QUIET_AFTER_MS moves the row to `quiet` (the claim
 * is kept), and an `active` session moves a quiet row back to `started` [rv2 N2].
 */
import { HANDOFF_OPEN, HANDOFF_QUIET_AFTER_MS } from "./handoff-constants.js";
import { wantsHandoffStatus, mayAskStatus, namesWork, isBareStatus, namedBots } from "./handoff-intent.js";
import { voiceLine } from "./voice-lines.js";
import { botName, langOf, notifyRow } from "./handoff-confirm.js";
import { rememberTopic, topicFor } from "./handoff-topic.js";
import { releaseResult } from "../board/result-requesters.js";
import { normalizeVoiceSettings } from "../../shared/voice-bot.js";

/** A hand-off that ended this long ago is still in scope: "how's it going?" → "Writer finished …". */
export const HANDOFF_ENDED_WINDOW_MS = 60 * 60_000;
/** The detail of a row whose session ended with no result (the sweep or a status read found it). */
export const SESSION_ENDED_NO_RESULT = "session_ended_no_result";

const PERSONAL_SURFACES = new Set(["phone", "glasses"]);
/** The statuses a card result can end, and the ones the session check reconciles (the sweep's set). */
const RESULT_STATUSES = Object.freeze(["started", "queued", "quiet"]);
const SESSION_STATUSES = Object.freeze(["started", "quiet"]);
const FINAL = new Set(["success", "failure"]);
const OPEN = new Set(HANDOFF_OPEN);
/** A stopped row whose stop has not reached a session yet: a stop that landed before the session existed
 * (5.4's `pending_start`), or an engine stop the sweep is still retrying (`stop_pending`). */
const STOP_PENDING = new Set(["pending_start", "stop_pending"]);
const SAFE_BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DETAIL_MAX = 300;

const cut = (s, max) => (typeof s === "string" && s.length > max ? s.slice(0, max) : typeof s === "string" ? s : "");
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/** A SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO string, as epoch ms; null when unreadable (P11). */
export function utcMs(s) {
  if (typeof s !== "string" || !s) return null;
  const t = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? Date.parse(s.replace(" ", "T") + "Z") : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** releaseResult, guarded (P9): a row without a card has no claim. */
function release(cardId) {
  const n = Number(cardId);
  if (Number.isInteger(n) && n > 0) releaseResult(n);
}

/** The open rows and the recently ended ones this surface may hear about (P23), hand-off rows only. */
export async function rowsInScope(store, db, device, surface, now) {
  const kiosk = !PERSONAL_SURFACES.has(surface);
  const open = kiosk ? await store.openForDevice(db, device.id) : await store.openPersonal(db);
  const ended = await store.endedSince(db, now - HANDOFF_ENDED_WINDOW_MS, kiosk ? { deviceId: device.id } : { personal: true });
  const handoff = (r) => r.kind === "handoff";
  return { open: open.filter(handoff), ended: ended.filter(handoff) };
}

/**
 * The rows the transcript is about (P20): a named bot (a whole name or id) → that bot's rows; nothing
 * named → every row given. `bots` is [{ bot_id, name }]. → { named: [bot ids], rows }.
 */
export function resolveRows(transcript, rows, bots) {
  const named = namedBots(transcript, bots);
  if (!named.length) return { named, rows };
  const set = new Set(named);
  return { named, rows: rows.filter((r) => set.has(r.bot_id)) };
}

/** The newest perch-live session row for a hand-off: by its session id, else the bot's newest for the card. */
async function sessionFor(db, row) {
  if (row.session_id) {
    const { rows } = await db.execute({
      sql: "SELECT status, updated_at FROM bot_sessions WHERE kind = 'perch-live' AND gateway_thread_id = ? ORDER BY id DESC LIMIT 1",
      args: [String(row.session_id)],
    });
    if (rows[0]) return rows[0];
  }
  if (row.card_id != null) {
    const { rows } = await db.execute({
      sql: "SELECT status, updated_at FROM bot_sessions WHERE kind = 'perch-live' AND card_id = ? AND bot_id = ? ORDER BY id DESC LIMIT 1",
      args: [Number(row.card_id), String(row.bot_id)],
    });
    if (rows[0]) return rows[0];
  }
  return null;
}

/** The card's newest board result, or null (a tasks.db without the table counts as none). */
async function newestResult(tdb, cardId) {
  try {
    const { rows } = await tdb.execute({ sql: "SELECT outcome, summary_md FROM board_results WHERE item_id = ? ORDER BY id DESC LIMIT 1", args: [Number(cardId)] });
    return rows[0] || null;
  } catch (err) {
    if (/no such table/i.test(String(err?.message || err))) return null;
    throw err;
  }
}

/** The line key for a row that is no longer open (or still starting), from its status alone. */
function keyOfEnded(row) {
  switch (row?.status) {
    case "done": return "status_done";
    case "failed": return row.detail === SESSION_ENDED_NO_RESULT ? "status_ended_quiet" : "status_failed";
    case "stopped": return STOP_PENDING.has(row.detail) ? "status_stopping" : "status_stopped";
    case "starting": return "status_starting";
    default: return null;
  }
}

/** The one handoff_ended_no_result notification (handoff_start_failed's shape, in the row's language) plus the heads-up. */
async function notifyEnded(core, db, row) {
  const h = { id: row.id, lang: langOf(row.lang), name: await botName(db, row.bot_id), task: row.task, deviceId: row.device_id, cardId: row.card_id ?? null };
  await notifyRow(core, db, h, { titleKey: "handoff_ended_no_result", spokenKey: "handoff_ended_no_result", kioskSpokenKey: "ended_no_result_spoken_kiosk", label: "ended-no-result" });
}

/**
 * The row's state as a line key, reconciled with the card's result and the session (see the header); the
 * reconcile writes the row (a CAS each time) as a side effect. `tdb` is an open tasks.db client (null skips
 * the result check), `eng` the engine (null: no needs-you). A CAS that loses answers from the row as it is
 * now. null for a row that was never open (proposed, declined…).
 */
export async function reconcileRow(core, db, row, { tdb = null, eng = null } = {}) {
  const { store } = core;
  const ended = keyOfEnded(row);
  if (ended) return ended;
  if (!RESULT_STATUSES.includes(row.status)) return null;
  const lost = async () => keyOfEnded(await store.get(db, row.id)) || "status_running";

  // 2. The card's newest final result wins [rv3 m3]; a partial is progress, not an end (P12).
  if (row.card_id != null && tdb) {
    const r = await newestResult(tdb, row.card_id);
    if (r && FINAL.has(r.outcome)) {
      const to = r.outcome === "success" ? "done" : "failed";
      if (!(await store.transition(db, row.id, RESULT_STATUSES, to, { outcome: r.outcome, detail: cut(r.summary_md, DETAIL_MAX) }))) return lost();
      release(row.card_id);
      return to === "done" ? "status_done" : "status_failed";
    }
  }
  if (row.status === "queued") return "status_queued";

  // 3. The session. Only active, waiting-user and stopped are written by perch-live; anything else is an end.
  const s = await sessionFor(db, row);
  if (s && s.status !== "active" && s.status !== "waiting-user") {
    if (!(await store.transition(db, row.id, SESSION_STATUSES, "failed", { detail: SESSION_ENDED_NO_RESULT }))) return lost();
    release(row.card_id);
    // Only the transition that moved the row sends it, so it goes out once per row [rv5 m3].
    await notifyEnded(core, db, row);
    return "status_ended_quiet";
  }
  // 4. A question waiting on the operator (P10: waitingOnCard reads memory, adopting nothing): never quiet.
  if (row.card_id != null && eng && typeof eng.waitingOnCard === "function" && safe(() => eng.waitingOnCard(row.card_id), false) === true) return "status_needs_you";
  if (!s) return row.status === "quiet" ? "status_waiting_quiet" : "status_running";
  if (s.status === "active") {
    if (row.status === "quiet") await store.transition(db, row.id, ["quiet"], "started");
    return "status_running";
  }
  if (row.status === "quiet") return "status_waiting_quiet";
  const at = utcMs(s.updated_at);
  if (at != null && core.now() - at >= HANDOFF_QUIET_AFTER_MS) {
    await store.transition(db, row.id, ["started"], "quiet");
    return "status_waiting_quiet";
  }
  return "status_running";
}

/** The engine without minting one; null when this process has none (or it cannot load). */
async function engineOf(core) {
  try { return await core.engine({ createIfMissing: false }); } catch { return null; }
}

/**
 * The sweep's reconcile (P13): every started or quiet hand-off row, against its card's result and its
 * session. A row still in flight (a confirm settling) is left alone; a row that throws is logged and the rest
 * go on. tasks.db is opened only when there is a row to read. → { rows, ended, quiet, resumed, done }.
 */
export async function reconcileOpen(core, db) {
  const out = { rows: 0, ended: 0, quiet: 0, resumed: 0, done: 0 };
  const rows = (await core.store.openRows(db, { statuses: SESSION_STATUSES })).filter((r) => !core.inFlight.has(r.id));
  if (!rows.length) return out;
  let tdb = null;
  try { tdb = core.openTasksDb(); } catch (err) { core.log(`[voice-handoff] reconcile: tasks.db could not be opened (${err?.message || err})`); }
  const eng = await engineOf(core);
  try {
    for (const row of rows) {
      out.rows++;
      let key;
      try { key = await reconcileRow(core, db, row, { tdb, eng }); }
      catch (err) { core.log(`[voice-handoff] ${row.id}: reconcile failed (${err?.message || err})`); continue; }
      if (key === "status_ended_quiet") out.ended++;
      else if (key === "status_waiting_quiet" && row.status === "started") out.quiet++;
      else if (key === "status_running" && row.status === "quiet") out.resumed++;
      else if (key === "status_done" || key === "status_failed") out.done++;
    }
  } finally {
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
  return out;
}

/** The candidates' names and ids (the hand-off tool's list), or none when hand-offs are off or `bot` is not the voice bot. */
async function candidatesOf(core, db, bot) {
  try {
    if (!bot || !normalizeVoiceSettings(bot).handoff.enabled) return [];
    return (await core.summaries.get(db, bot)).filter((c) => SAFE_BOT_ID.test(c.bot_id)).map((c) => ({ bot_id: c.bot_id, name: c.name }));
  } catch { return []; }
}

/** "Writer and Helper", "Writer, Helper and Plain" (list_and). */
function joinAnd(names, lang) {
  if (names.length <= 1) return names[0] || "";
  return voiceLine("list_and", lang, { rest: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

/**
 * The spoken state of `row` on this surface, in the turn's language, and the row becomes the device's last
 * topic. On a kiosk the task text is never spoken (status_task_kiosk). → { say, verb }.
 */
export async function answerRow(core, db, row, { device, surface, lang } = {}) {
  const speak = langOf(lang);
  let tdb = null;
  if (row.card_id != null && RESULT_STATUSES.includes(row.status)) {
    try { tdb = core.openTasksDb(); } catch (err) { core.log(`[voice-handoff] ${row.id}: tasks.db could not be opened for the status (${err?.message || err})`); }
  }
  let key;
  try { key = await reconcileRow(core, db, row, { tdb, eng: await engineOf(core) }); }
  finally { if (tdb) { try { tdb.close(); } catch { /* already closed */ } } }
  if (!key) return null;
  if (device?.id) rememberTopic(core, device.id, row.id, { inTurn: true });
  const task = PERSONAL_SURFACES.has(surface) ? row.task : voiceLine("status_task_kiosk", speak);
  return { say: voiceLine(key, speak, { bot: await botName(db, row.bot_id), task }), verb: key };
}

/**
 * Among the rows the question is about: the one open row; the newest open one when they are all the same
 * bot's; the newest ended one when none is open; and `null` with a `which` list when several bots have
 * open work. → { row } | { which: [{ bot_id, name, id }] }.
 */
async function pickRow(db, rows) {
  const open = rows.filter((r) => OPEN.has(r.status));
  if (!open.length) return { row: rows[0] || null };
  const bots = [...new Set(open.map((r) => r.bot_id))];
  if (bots.length === 1) return { row: open[0] };
  const which = [];
  for (const bot of bots) which.push({ bot_id: bot, name: await botName(db, bot), id: open.find((r) => r.bot_id === bot).id });
  return { which };
}

/**
 * core.status: the fast path for a status question (the header's subject rules). `bot` is the turn's voice
 * bot (its candidates may be named); `pending` the device's pending store for a "which one?" (purpose
 * "status", P18). → { say, verb } or null (the model's turn). Never a model call.
 */
export async function status(core, db, { device, surface, transcript, lang, bot = null, pending = null } = {}) {
  if (!db || !device?.id || typeof transcript !== "string" || !mayAskStatus(transcript)) return null;
  const speak = langOf(lang);
  const { open, ended } = await rowsInScope(core.store, db, device, surface, core.now());
  const rows = [...open, ...ended];
  const bots = new Map((await candidatesOf(core, db, bot)).map((c) => [c.bot_id, c.name]));
  for (const r of rows) if (!bots.has(r.bot_id)) bots.set(r.bot_id, await botName(db, r.bot_id));
  const botList = [...bots].map(([bot_id, name]) => ({ bot_id, name }));
  if (!wantsHandoffStatus(transcript, botList.flatMap((b) => [b.name, b.bot_id]))) return null;

  const { named, rows: mine } = resolveRows(transcript, rows, botList);
  let about;
  if (named.length) {
    if (!mine.length) return { say: voiceLine("status_none", speak), verb: "status_none" };
    about = mine;
  } else if (namesWork(transcript)) {
    if (!rows.length) return null;
    about = rows;
  } else if (isBareStatus(transcript)) {
    const topic = topicFor(core, device.id);
    const row = topic ? rows.find((r) => r.id === topic.id) : null;
    if (!row) return null;
    about = [row];
  } else {
    return null;
  }
  const picked = await pickRow(db, about);
  if (picked.which) {
    if (pending && typeof pending.set === "function") pending.set(device.id, { kind: "which", purpose: "status", options: picked.which, asked: transcript });
    return { say: voiceLine("status_which", speak, { list: joinAnd(picked.which.map((w) => w.name), speak) }), verb: "status_which" };
  }
  return picked.row ? answerRow(core, db, picked.row, { device, surface, lang: speak }) : null;
}
