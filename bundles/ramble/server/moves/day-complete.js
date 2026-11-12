/**
 * Day completion (moves design; private engineering notes): whether a day's
 * cards are all finished. DERIVED from the wallet rows, never stored.
 *
 * The wallet sync applies a row from another instance by plain MIN/MAX with no
 * callback, so nothing runs at the moment a row arrives — a stored "complete"
 * flag would be wrong on whichever instance did not write the last row. Every
 * answer here is computed from the rows themselves, the way the streak and the
 * week's balance already are.
 *
 * The rows the rule reads:
 *   moveneed   key `<day>`, delta 1-3 — how many cards the day asks for. A row
 *              stating anything else (absent, 0, 5, not a whole number) leaves
 *              the day incomplete: the day made no readable demand.
 *   moveslot   key `<day>:<slot>`, one row per finished slot, the slot being one
 *              of morning|midday|evening. A row for another day, or for a name
 *              that is not a slot, counts for nothing.
 *   movebal    key `<day>` — the day was balanced.
 *   moveall    key `<day>` — a CACHE a write path may keep. Never read here:
 *              completion cannot depend on a row that may not have been
 *              written, and the rule is the same on every instance without it.
 *
 * A stand-in is recorded with its slot's `moveslot` row by the writer, so a
 * `movestand` row alone never completes a day.
 *
 * The caller may pass the day's picks-capped need (`opts.need`, from the day's
 * cards, see slots.js): a day whose slots could not all be filled asks for
 * fewer. The cap only ever LOWERS the requirement, and a value that is not a
 * whole number from 1 up is no cap at all.
 *
 * Nothing here writes, so a read of a day is always a read.
 */

/** Wallet kind: key `<day>`, delta 1-3 — how many cards the day asks for. */
export const MOVE_NEED_KIND = "moveneed";
/** Wallet kind: key `<day>:<slot>`, one row per finished slot. Grows, MAX. */
export const MOVE_SLOT_KIND = "moveslot";
/** Wallet kind: key `<day>:<slot>`, a stand-in for that slot (written with its slot row). */
export const MOVE_STAND_KIND = "movestand";
/** Wallet kind: key `<day>` — the day's balance was settled. */
export const MOVE_BAL_KIND = "movebal";
/** Wallet kind: key `<day>` — a completion cache a write path may keep. Never read here. */
export const MOVE_ALL_KIND = "moveall";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The slot names a `moveslot` row may name, and the most cards a day can ask for. */
const SLOT_NAMES = Object.freeze(["morning", "midday", "evening"]);

/** Whether `day` is a day string this module will answer about. */
function isDay(day) {
  return typeof day === "string" && DAY_RE.test(day);
}

/** The card count a `moveneed` delta states, or null when it states none we can use. */
function needOf(delta) {
  if (delta === null || delta === undefined) return null;
  const n = Number(delta);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > SLOT_NAMES.length) return null;
  return n;
}

/** The rows of a query result, or an empty list when there is none. */
function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

/**
 * Whether `day` is complete: its `moveneed` row states a card count, that many
 * of its slot names carry a `moveslot` row, and its `movebal` row exists.
 *
 * `opts.need` (a whole number from 1 up) caps the requirement at the day's
 * picks-capped card count; anything else leaves the stated count in force. The
 * requirement is never raised above what the day asked for.
 */
export async function isDayComplete(db, day, { need } = {}) {
  if (!isDay(day)) return false;

  const needRows = rowsOf(await db.execute({
    sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?",
    args: [MOVE_NEED_KIND, day],
  }));
  const stated = needOf(needRows[0]?.delta);
  if (stated === null) return false;
  const required = Number.isInteger(need) && need >= 1 ? Math.min(stated, need) : stated;

  const slotRows = rowsOf(await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? AND key IN (?, ?, ?)",
    args: [MOVE_SLOT_KIND, ...SLOT_NAMES.map((slot) => `${day}:${slot}`)],
  }));
  const have = new Set();
  for (const row of slotRows) {
    const key = String(row?.key ?? "");
    const slot = key.slice(day.length + 1);
    if (key.slice(0, day.length + 1) !== `${day}:`) continue;
    if (!SLOT_NAMES.includes(slot)) continue;
    have.add(slot);
  }
  if (have.size < required) return false;

  const balRows = rowsOf(await db.execute({
    sql: "SELECT 1 FROM ramble_wallet WHERE kind = ? AND key = ? LIMIT 1",
    args: [MOVE_BAL_KIND, day],
  }));
  return balRows.length > 0;
}

/**
 * Every complete day in `from`..`to` (both day strings, inclusive, compared as
 * strings), as a Set. The same rule as isDayComplete with no cap, answered over
 * the whole range in three queries: the range's `moveneed` rows, its `moveslot`
 * rows, and its `movebal` rows.
 *
 * A range that is not two day strings, or whose `from` comes after its `to`,
 * answers an empty Set. Nothing here writes.
 */
export async function completeDays(db, { from, to } = {}) {
  const done = new Set();
  if (!isDay(from) || !isDay(to) || from > to) return done;

  const needs = new Map();
  const needRows = rowsOf(await db.execute({
    sql: "SELECT key, delta FROM ramble_wallet WHERE kind = ? AND key >= ? AND key <= ?",
    args: [MOVE_NEED_KIND, from, to],
  }));
  for (const row of needRows) {
    const key = String(row?.key ?? "");
    if (!isDay(key)) continue;
    const n = needOf(row?.delta);
    if (n === null) continue;
    needs.set(key, n);
  }

  // The slot keys of the range are exactly `<day>:<slot>` with no key of
  // another kind folded in, so the upper bound is the day after `to`.
  const slots = new Map();
  const slotRows = rowsOf(await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? AND key >= ? AND key < ?",
    args: [MOVE_SLOT_KIND, from, `${to}~`],
  }));
  for (const row of slotRows) {
    const key = String(row?.key ?? "");
    const day = key.slice(0, 10);
    const slot = key.slice(11);
    if (!isDay(day) || day < from || day > to) continue;
    if (key[10] !== ":") continue;
    if (!SLOT_NAMES.includes(slot)) continue;
    if (!slots.has(day)) slots.set(day, new Set());
    slots.get(day).add(slot);
  }

  const bals = new Set();
  const balRows = rowsOf(await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? AND key >= ? AND key <= ?",
    args: [MOVE_BAL_KIND, from, to],
  }));
  for (const row of balRows) bals.add(String(row?.key ?? ""));

  for (const [day, required] of needs) {
    if (!bals.has(day)) continue;
    const have = slots.get(day);
    if (!have || have.size < required) continue;
    done.add(day);
  }
  return done;
}
