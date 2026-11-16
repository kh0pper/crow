/**
 * Program stages (moves design, the stage program; private engineering notes):
 * a routine the player said "a little more" about climbs one stage at a time,
 * and never on its own.
 *
 * THREE PIECES OF BOOKKEEPING, none of them a balance:
 *   stage (wallet, key = routine id, delta = the stage reached, 1..STAGES_MAX)
 *        It only ever grows, and only acceptStage grows it, by compare-and-
 *        swap. Two instances answering the same offer therefore take one stage
 *        between them, and a lost race can only leave the stage lower than it
 *        might have been.
 *   local.moves.staged.<weekId>
 *        the staged routines finished in that week, a JSON list of routine
 *        ids. A `local.` key: this instance's own record, so it is written
 *        without an emit and never replicates.
 *   local.moves.stage.answered
 *        routine id -> the week id whose offer was answered, yes or no, so one
 *        week asks about a routine once.
 *
 * WHAT A STAGE MEANS TO A SESSION. The row holds how many stages have been
 * reached, so stageOf answers 1 for a routine the player has never taken
 * further. A session compiles the stage AT that number (`opts.stage`, a 0-based
 * index into the entry's `stages`, session.cjs): the program the player is
 * working on now, never the one they have just agreed to. Nothing here reads
 * the calendar except to name the two weeks an offer may come from — the week
 * of `now` and the week before it — and nothing but acceptStage raises a stage.
 *
 * An offer needs a WHOLE-BODY week: a `weekfull` wallet row for the week id
 * (wardrobe.js). A week that was not whole-body never asks for more, and a
 * whole-body week with nothing to offer falls through to the week before it:
 * the first week with an unanswered offer wins.
 */
import { STAGES_MAX } from "./library.js";
import { weekIdOf } from "./week.js";
import { casDelta, rowDelta } from "../steps.js";
import { readJson, writeJson } from "./today.js";
import { WEEKFULL_KIND } from "../wardrobe.js";

/** Wallet kind: key = routine id, delta = the stage reached (grows, 1..STAGES_MAX). */
export const STAGE_KIND = "stage";
/** Settings prefix for one week's staged routine ids: `local.` + the ISO week id. */
export const STAGED_PREFIX = "local.moves.staged.";
/** Settings key: routine id -> the week id whose offer was answered. */
export const ANSWERED_KEY = "local.moves.stage.answered";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function asAt(now) {
  return Number.isFinite(Number(now)) ? Number(now) : Date.now();
}

/** A stage number read as 1..STAGES_MAX: junk under it is the first stage, over it is the last. */
function clampStage(delta) {
  const value = Number(delta);
  if (!Number.isFinite(value)) return 1;
  const whole = Math.round(value);
  if (whole < 1) return 1;
  if (whole > STAGES_MAX) return STAGES_MAX;
  return whole;
}

/** A local-noon timestamp for "YYYY-MM-DD", or null when the string is not a real day. */
function noonOf(day) {
  if (typeof day !== "string" || !DAY_RE.test(day)) return null;
  const [year, month, date] = day.split("-").map(Number);
  const noon = new Date(year, month - 1, date, 12, 0, 0, 0);
  if (noon.getFullYear() !== year || noon.getMonth() !== month - 1 || noon.getDate() !== date) return null;
  return noon.getTime();
}

/** The local noon of the day an instant falls in, so date arithmetic never shifts a day. */
function noonOfAt(at) {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0).getTime();
}

/** The ISO week before the one a local-noon timestamp falls in: its day seven days earlier. */
function weekBefore(noonMs) {
  const date = new Date(noonMs);
  return weekIdOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 7, 12, 0, 0, 0).getTime());
}

/** The routine ids recorded in one week's staged list, junk dropped. A read. */
async function stagedOf(db, weekId) {
  const stored = await readJson(db, STAGED_PREFIX + weekId);
  if (!Array.isArray(stored)) return [];
  return stored.filter((id) => typeof id === "string" && id !== "");
}

/** The answers recorded so far, as routine id -> week id. A read. */
async function answeredOf(db) {
  const stored = await readJson(db, ANSWERED_KEY);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return stored;
}

/**
 * Record that a week's offer about a routine was answered. A `local.` key, so
 * it is written with no emit: nothing about it leaves this instance.
 */
async function noteAnswered(db, routineId, weekId) {
  const answered = await answeredOf(db);
  answered[routineId] = weekId;
  await writeJson(db, ANSWERED_KEY, answered);
}

/** The library entry a routine id names, or null. */
function entryOf(library, routineId) {
  if (!Array.isArray(library)) return null;
  for (const entry of library) {
    if (entry && typeof entry === "object" && entry.id === routineId) return entry;
  }
  return null;
}

/**
 * The stage a routine is at: the stage row's delta clamped to 1..STAGES_MAX, 1
 * when there is no row (or the id is not a non-empty string). A read.
 */
export async function stageOf(db, routineId) {
  if (typeof routineId !== "string" || routineId === "") return 1;
  try {
    return clampStage(await rowDelta(db, STAGE_KIND, routineId));
  } catch {
    return 1;
  }
}

/**
 * Forget the staged lists of every week but this one and the week before it:
 * only those two can still be offered, so the older rows would sit in the
 * settings table for good. Their keys carry an ISO week id, so the two wanted
 * keys are named outright and every other `local.moves.staged.` row goes.
 */
async function pruneStaged(db, weekId, previousId) {
  await db.execute({
    sql: "DELETE FROM ramble_settings WHERE key LIKE ? AND key <> ? AND key <> ?",
    args: [`${STAGED_PREFIX}%`, STAGED_PREFIX + weekId, STAGED_PREFIX + previousId],
  });
}

/**
 * A staged routine was finished on `day` ("YYYY-MM-DD"): remember its id in
 * that week's staged list. A repeat adds nothing, and recording it also drops
 * the staged lists of weeks older than the one before this one.
 *
 * Returns true when the id is recorded, false when there is nothing to record:
 * an entry with no string id, an entry with no stages, or a day that is not a
 * real day string writes nothing at all.
 */
export async function noteRoutineDone(db, { day, entry } = {}) {
  const noon = noonOf(day);
  if (noon === null) return false;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (typeof entry.id !== "string" || entry.id === "") return false;
  if (!Array.isArray(entry.stages) || entry.stages.length === 0) return false;

  const weekId = weekIdOf(noon);
  if (weekId === "") return false;

  const key = STAGED_PREFIX + weekId;
  const ids = await stagedOf(db, weekId);
  if (!ids.includes(entry.id)) ids.push(entry.id);
  // No emit: a `local.` key is this instance's own bookkeeping.
  await writeJson(db, key, ids);
  await pruneStaged(db, weekId, weekBefore(noon));
  return true;
}

/**
 * The offer the two candidate weeks hold, as `{ routineId, weekId }`, or null.
 *
 * The candidates are the week of `at` and the week before it, newest first, and
 * a week counts only when a `weekfull` wallet row carries its id — a whole-body
 * week. Each counting week is asked in turn, and within it the staged ids in
 * order: a routine is offered when the library has it with a `stages` array,
 * its stage is below min(STAGES_MAX, stages.length), and this week's offer about
 * it has not been answered yet. A counting week that holds no such routine falls
 * through to the one before it, so the first week with an unanswered offer wins.
 * A read: nothing is written.
 */
async function findOffer(db, { at, library } = {}) {
  const candidates = [weekIdOf(at), weekBefore(noonOfAt(at))];
  for (const weekId of candidates) {
    if (weekId === "") continue;
    // eslint-disable-next-line no-await-in-loop
    if ((await rowDelta(db, WEEKFULL_KIND, weekId)) === null) continue;

    const answered = await answeredOf(db);
    const ids = (await stagedOf(db, weekId)).sort();
    for (const routineId of ids) {
      const entry = entryOf(library, routineId);
      if (!entry || !Array.isArray(entry.stages)) continue;
      // eslint-disable-next-line no-await-in-loop
      if ((await stageOf(db, routineId)) >= Math.min(STAGES_MAX, entry.stages.length)) continue;
      if (answered[routineId] === weekId) continue;
      return { routineId, weekId };
    }
    // This week is whole-body but holds nothing to offer, so the week before it
    // is asked: the first week with an unanswered offer wins.
  }
  return null;
}

/**
 * The routine this player should be asked about now, or null. Read-only.
 *
 * `library` is the set the caller serves (an array of entries, matched by id);
 * `now` names the week, and the week before it is the only other candidate.
 */
export async function offerStage(db, { now, library } = {}) {
  const offer = await findOffer(db, { at: asAt(now), library });
  return offer ? offer.routineId : null;
}

/**
 * The player said yes. The stage row goes up by ONE, by compare-and-swap, and
 * only for a routine offerStage would name right now (`findOffer` above is that
 * same computation, and its routine id is what offerStage answers).
 *
 * `from` is the row as it stands (null when absent), `to` is one stage further,
 * so a routine at stage 1 reaches stage 2 and an absent row is inserted as 2.
 * A swap that loses — a second instance got there first — writes nothing and
 * answers `{ ok: false, reason: "lost" }`. The answered week is recorded only
 * after the stage row landed.
 */
export async function acceptStage(db, { routineId, now, library, emit } = {}) {
  const at = asAt(now);
  const offer = await findOffer(db, { at, library });
  if (!offer || offer.routineId !== routineId) return { ok: false, reason: "not-offered" };

  const from = await rowDelta(db, STAGE_KIND, routineId);
  const to = (await stageOf(db, routineId)) + 1;
  if (!(await casDelta(db, STAGE_KIND, routineId, from, to, at, emit))) {
    return { ok: false, reason: "lost" };
  }
  await noteAnswered(db, routineId, offer.weekId);
  return { ok: true, stage: to };
}

/**
 * The player said no for now. Records this week's answer and writes no stage
 * row at all, so the stage stays exactly where it was; a later whole-body week
 * asks again. A routine that is not currently offered is refused.
 */
export async function declineStage(db, { routineId, now, library } = {}) {
  const at = asAt(now);
  const offer = await findOffer(db, { at, library });
  if (!offer || offer.routineId !== routineId) return { ok: false, reason: "not-offered" };
  await noteAnswered(db, routineId, offer.weekId);
  return { ok: true };
}