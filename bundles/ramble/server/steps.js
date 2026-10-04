/**
 * Ramble steps (spec 2026-10-04-ramble-steps-design.md).
 *
 * The Android app reads the phone's hardware step counter (it accumulates
 * since boot) and hands us {device_id, counter, elapsed_ms, boot_count}. All
 * arithmetic is here (R1): a LOCAL per-device baseline (ramble_step_devices),
 * a reboot guard, plausibility and daily caps, and ledger rows in
 * ramble_wallet for everything that replicates.
 *
 * ⚠ EVERY ROW THIS MODULE WRITES TO ramble_wallet IS A CONSTANT OR GROWS.
 * applyRambleWallet merges a key conflict with MAX(delta), which converges
 * exactly for that class. Never write a shrinking or negative delta here.
 *
 * ⚠ PRIVACY (R11): step counts replicate to the user's OWN instances only.
 * Nothing here may feed a contact-facing payload except the boolean `walked`
 * fact, which core turns into artwork.
 */
import { localDay, startOfLocalDay } from "./eggs.js";

export const STEPS_KIND = "steps";               // key `<day>:<device>`, delta = steps credited that day (grows)
export const STEP_ENERGY_KIND = "stepenergy";    // key `<day>`, delta = energy paid from walking that day (grows)
export const WALKED_KIND = "walked";             // key `<day>`, delta 1 — the contacts badge
export const WALK_CHECKIN_KIND = "walkcheck";    // key `<day>`, delta 1 — "I walked today"
export const NUDGE_KIND = "nudge";               // key `<day>`, delta 1 — the evening nudge was sent
export const STEP_SEED_PREFIX = "steps:";        // kind 'seed', key `steps:<day>` — the goal bonus (R7)
export const HOME_KEY = "local.steps.seen_at";   // R8; `local.` keys never replicate

export const GOAL_MIN = 2000;
export const GOAL_MAX = 30000;
export const STEPS_DEFAULTS = Object.freeze({
  goal: 6000,
  maxDay: 40000,
  maxPerMin: 250,
  devicesPerDay: 4,
  energyFull: 30,
  energyChunk: 5,
  checkinEnergy: 15,
  goalSeed: 3,
  badgeMin: 2000,
  nudge: true,
  nudgeWeekends: true,
  nudgeHour: 18,
  nudgeUntil: 21,
  nudgeBelow: 50,
});

/** key -> [field, min, max] for the integer settings (spec §4.3). */
const INT_SETTINGS = {
  "steps.goal": ["goal", GOAL_MIN, GOAL_MAX],
  "steps.max.day": ["maxDay", 1000, 200000],
  "steps.max.per.min": ["maxPerMin", 60, 1000],
  "steps.devices.per.day": ["devicesPerDay", 1, 16],
  "steps.energy.full": ["energyFull", 0, 100],
  "steps.energy.chunk": ["energyChunk", 1, 100],
  "steps.checkin.energy": ["checkinEnergy", 0, 100],
  "steps.goal.seed": ["goalSeed", 0, 100],
  "steps.badge.min": ["badgeMin", 1, 200000],
  "steps.nudge.hour": ["nudgeHour", 0, 23],
  "steps.nudge.until": ["nudgeUntil", 1, 24],
  "steps.nudge.below": ["nudgeBelow", 0, 100],
};
const BOOL_SETTINGS = { "steps.nudge": "nudge", "steps.nudge.weekends": "nudgeWeekends" };

const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const COUNTER_MAX = 100_000_000;
const ELAPSED_MAX = 10 * 365 * 24 * 3600 * 1000;
/** A boot estimated this long after the last reading is a reboot (network + clock slop). */
const BOOT_SLACK_MS = 2 * 60 * 1000;

export class StepsInputError extends Error {
  constructor(message) { super(message); this.name = "StepsInputError"; }
}

/** Validate a reading from the client. Only these four fields are ever read. */
export function parseReading(r) {
  if (!r || typeof r !== "object") throw new StepsInputError("a reading is required");
  if (typeof r.device_id !== "string" || !DEVICE_RE.test(r.device_id)) {
    throw new StepsInputError("device_id must be 8-64 letters, digits or dashes");
  }
  if (!Number.isInteger(r.counter) || r.counter < 0 || r.counter > COUNTER_MAX) {
    throw new StepsInputError("counter must be a whole number from 0 to 100000000");
  }
  if (!Number.isInteger(r.elapsed_ms) || r.elapsed_ms < 0 || r.elapsed_ms > ELAPSED_MAX) {
    throw new StepsInputError("elapsed_ms must be a whole number of milliseconds since boot");
  }
  let boot = null;
  if (r.boot_count !== undefined && r.boot_count !== null) {
    if (!Number.isInteger(r.boot_count) || r.boot_count < 0) throw new StepsInputError("boot_count must be a whole number or null");
    boot = r.boot_count;
  }
  return { device_id: r.device_id, counter: r.counter, elapsed_ms: r.elapsed_ms, boot_count: boot };
}

/** Live settings, each falling back to its default on junk or out-of-range values. */
export async function readStepSettings(db) {
  const out = { ...STEPS_DEFAULTS };
  try {
    const keys = [...Object.keys(INT_SETTINGS), ...Object.keys(BOOL_SETTINGS)];
    const { rows } = await db.execute({
      sql: `SELECT key, value FROM ramble_settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
      args: keys,
    });
    for (const r of rows || []) {
      const key = String(r.key);
      if (Object.hasOwn(INT_SETTINGS, key)) {
        const [field, lo, hi] = INT_SETTINGS[key];
        const n = Number(r.value);
        if (Number.isInteger(n) && n >= lo && n <= hi) out[field] = n;
      } else if (Object.hasOwn(BOOL_SETTINGS, key)) {
        if (r.value === "1" || r.value === "0") out[BOOL_SETTINGS[key]] = r.value === "1";
      }
    }
  } catch { /* defaults */ }
  return out;
}

/** Mirrors eggs.js/wallet.js: an emit must never be able to fail the write. */
export async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble steps] emit ${table} failed:`, err?.message); } catch {} }
}

/** The delta stored under (kind, key), or null when there is no row. */
export async function rowDelta(db, kind, key) {
  const { rows } = await db.execute({ sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?", args: [kind, key] });
  return rows.length ? Number(rows[0].delta) : null;
}

/** Insert a fact once. True only for the call that created it (which also emits). */
export async function insertOnce(db, kind, key, delta, now, emit) {
  const res = await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING",
    args: [kind, key, delta, now],
  });
  if (Number(res.rowsAffected) !== 1) return false;
  await safeEmit(emit, "ramble_wallet", "update", { kind, key, delta, created_at: now });
  return true;
}

/**
 * Compare-and-swap a growing row from `from` (null = absent) to `to`. False
 * when somebody else (a concurrent request, or a sync apply) moved it first —
 * the caller then pays nothing, which can only ever under-pay.
 */
export async function casDelta(db, kind, key, from, to, now, emit) {
  const res = from === null
    ? await db.execute({
      sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING",
      args: [kind, key, to, now],
    })
    : await db.execute({
      sql: "UPDATE ramble_wallet SET delta = ? WHERE kind = ? AND key = ? AND delta = ?",
      args: [to, kind, key, from],
    });
  if (Number(res.rowsAffected) !== 1) return false;
  const { rows } = await db.execute({ sql: "SELECT created_at FROM ramble_wallet WHERE kind = ? AND key = ?", args: [kind, key] });
  await safeEmit(emit, "ramble_wallet", "update", { kind, key, delta: to, created_at: Number(rows[0]?.created_at ?? now) });
  return true;
}

async function rawStepsForDay(db, day) {
  const { rows } = await db.execute({
    sql: "SELECT COALESCE(SUM(delta), 0) AS n FROM ramble_wallet WHERE kind = ? AND key LIKE ?",
    args: [STEPS_KIND, day + ":%"],
  });
  return Number(rows[0]?.n) || 0;
}

/**
 * Today's steps across every device, CAPPED at steps.max.day. Two instances
 * that each capped locally can exceed the cap in sum after a merge; every
 * reader goes through this, so nothing downstream ever sees more than the cap.
 */
export async function stepsToday(db, now, settings) {
  const s = settings || await readStepSettings(db);
  return Math.min(await rawStepsForDay(db, localDay(now)), s.maxDay);
}

/**
 * Credit one reading (spec §5). The baseline is claimed with a compare-and-
 * swap BEFORE anything is credited, so of two racing readings exactly one
 * credits. The baseline always advances to the new counter — clamped excess
 * is discarded, never banked.
 *
 * ⚠ FOREIGN CREDIT GUARD. `last_total`/`last_day` remember what this
 * device's row for the day held right after THIS instance last touched it. If
 * the row has since grown, another of the user's instances credited the same
 * phone in between (the phone switched gateways and came back): diffing
 * against our stale baseline would count that range twice. Re-baseline and
 * credit nothing — this can only under-count. Known benign false positive:
 * two concurrent requests for the SAME device on THIS instance (two tabs) can
 * see the other's write between its claim and its last_total update and drop
 * a delta; the panel's single in-flight read makes that rare, and it too only
 * under-counts. The "unseen" nudge wording (Task 6) likewise looks at this
 * instance's freshest device only.
 */
export async function recordStepReading(db, reading, { now = Date.now(), emit } = {}) {
  const r = parseReading(reading);
  const s = await readStepSettings(db);
  const day = localDay(now);
  const key = `${day}:${r.device_id}`;
  const bootAt = now - r.elapsed_ms;

  const { rows } = await db.execute({
    sql: "SELECT boot_count, last_counter, last_read_at, last_total, last_day FROM ramble_step_devices WHERE device_id = ?",
    args: [r.device_id],
  });
  const prev = rows[0]
    ? {
      boot_count: rows[0].boot_count == null ? null : Number(rows[0].boot_count),
      last_counter: Number(rows[0].last_counter),
      last_read_at: Number(rows[0].last_read_at),
      last_total: Number(rows[0].last_total) || 0,
      last_day: rows[0].last_day == null ? null : String(rows[0].last_day),
    }
    : null;
  const current = (await rowDelta(db, STEPS_KIND, key)) ?? 0;

  let raw;
  let overMs;
  let reason;
  if (!prev) {
    if (bootAt >= startOfLocalDay(now)) {
      // Every step on the counter was walked today. Another of the user's
      // instances may already have credited some of them (the phone moved
      // here mid-day, spec §4.1): only the part it has not seen is new.
      raw = r.counter - current;
      overMs = r.elapsed_ms;
      reason = "booted-today";
    } else {
      raw = 0;
      overMs = 0;
      reason = "baseline";
    }
  } else if (current > (prev.last_day === day ? prev.last_total : 0)) {
    raw = 0;
    overMs = 0;
    reason = "foreign";
  } else if ((r.boot_count !== null && prev.boot_count !== null && r.boot_count !== prev.boot_count)
    || r.counter < prev.last_counter
    || bootAt > prev.last_read_at + BOOT_SLACK_MS) {
    raw = r.counter;
    overMs = r.elapsed_ms;
    reason = "reboot";
  } else {
    raw = r.counter - prev.last_counter;
    overMs = Math.max(0, now - prev.last_read_at);
    reason = "delta";
  }

  const claim = prev
    ? await db.execute({
      sql: `UPDATE ramble_step_devices SET boot_count = ?, last_counter = ?, last_read_at = ?
            WHERE device_id = ? AND last_counter = ? AND last_read_at = ?`,
      args: [r.boot_count, r.counter, now, r.device_id, prev.last_counter, prev.last_read_at],
    })
    : await db.execute({
      sql: `INSERT INTO ramble_step_devices (device_id, boot_count, last_counter, last_read_at, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO NOTHING`,
      args: [r.device_id, r.boot_count, r.counter, now, now],
    });
  if (Number(claim.rowsAffected) !== 1) return { credited: 0, reason: "raced", clamped: false, day };

  let credit = Math.max(0, raw);
  let clamped = false;
  const allowed = Math.ceil(s.maxPerMin * Math.max(1, overMs / 60000));
  if (credit > allowed) { credit = allowed; clamped = true; }

  if (credit > 0 && current === 0 && (await rowDelta(db, STEPS_KIND, key)) === null) {
    const { rows: d } = await db.execute({
      sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = ? AND key LIKE ?",
      args: [STEPS_KIND, day + ":%"],
    });
    if (Number(d[0]?.n) >= s.devicesPerDay) { credit = 0; reason = "device-limit"; }
  }
  if (credit > 0) {
    const room = Math.max(0, s.maxDay - await rawStepsForDay(db, day));
    if (credit > room) { credit = room; clamped = true; }
  }
  let total = current;
  if (credit > 0) {
    // Locally ADD; the emitted row carries the full total, and a peer takes MAX.
    await db.execute({
      sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, key) DO UPDATE SET delta = ramble_wallet.delta + excluded.delta`,
      args: [STEPS_KIND, key, credit, now],
    });
    const { rows: w } = await db.execute({
      sql: "SELECT delta, created_at FROM ramble_wallet WHERE kind = ? AND key = ?",
      args: [STEPS_KIND, key],
    });
    total = Number(w[0].delta);
    await safeEmit(emit, "ramble_wallet", "update", {
      kind: STEPS_KIND, key, delta: total, created_at: Number(w[0].created_at),
    });
  }
  // Remember what the row held after OUR turn (the foreign-credit guard above).
  await db.execute({
    sql: "UPDATE ramble_step_devices SET last_total = ?, last_day = ? WHERE device_id = ?",
    args: [total, day, r.device_id],
  });
  return { credited: credit, reason, clamped, day };
}
