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
import { feed as petFeed } from "./pet.js";
import { SEED_KIND } from "./wallet.js";

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
        const text = String(r.value ?? "").trim();
        const n = /^\d+$/.test(text) ? Number(text) : NaN;
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

/**
 * Settle today (spec §6): pay step energy in chunks up to the day's target,
 * the seed bonus once the counted steps reach the goal, and the `walked` fact
 * once R6 holds. Runs after a credited reading, a check-in, or a goal change.
 * The energy ledger is written BEFORE the feed, by compare-and-swap: a lost
 * race or a crash between the two can only under-pay.
 */
export async function settleDay(db, { now = Date.now(), emit } = {}) {
  const s = await readStepSettings(db);
  const day = localDay(now);
  const steps = await stepsToday(db, now, s);
  const checkedIn = (await rowDelta(db, WALK_CHECKIN_KIND, day)) !== null;

  const stepTarget = Math.floor(s.energyFull * Math.min(1, steps / s.goal));
  const floor = checkedIn ? s.checkinEnergy : 0;
  const target = Math.max(stepTarget, floor);
  const paid = await rowDelta(db, STEP_ENERGY_KIND, day);
  const inc = target - (paid ?? 0);
  let energyPaid = 0;
  if (inc > 0 && (inc >= s.energyChunk || target >= s.energyFull || target === floor)) {
    if (await casDelta(db, STEP_ENERGY_KIND, day, paid, target, now, emit)) {
      await petFeed(db, { type: "steps", amount: inc }, { now, emit });
      energyPaid = inc;
    }
  }

  let seedBonus = 0;
  if (steps >= s.goal && s.goalSeed > 0
    && await insertOnce(db, SEED_KIND, STEP_SEED_PREFIX + day, s.goalSeed, now, emit)) {
    seedBonus = s.goalSeed;
  }

  const walked = checkedIn || steps >= Math.min(s.goal, s.badgeMin);
  const walkedNew = walked ? await insertOnce(db, WALKED_KIND, day, 1, now, emit) : false;
  return { day, steps, energyPaid, seedBonus, walked: walked || (await rowDelta(db, WALKED_KIND, day)) !== null, walkedNew };
}

/** "I walked today" (spec §7): idempotent per day; mood only, never seed. */
export async function recordWalkCheckin(db, { now = Date.now(), emit } = {}) {
  const fresh = await insertOnce(db, WALK_CHECKIN_KIND, localDay(now), 1, now, emit);
  const settled = await settleDay(db, { now, emit });
  return { already: !fresh, ...settled };
}

export async function walkedToday(db, { now = Date.now() } = {}) {
  return (await rowDelta(db, WALKED_KIND, localDay(now))) !== null;
}

/** The day as the panel shows it. Read-only. */
export async function stepsState(db, { now = Date.now() } = {}) {
  const s = await readStepSettings(db);
  const day = localDay(now);
  const steps = await stepsToday(db, now, s);
  const { rows } = await db.execute({
    sql: `SELECT kind, delta FROM ramble_wallet
          WHERE (kind IN (?, ?, ?) AND key = ?) OR (kind = ? AND key = ?)`,
    args: [WALK_CHECKIN_KIND, WALKED_KIND, STEP_ENERGY_KIND, day, SEED_KIND, STEP_SEED_PREFIX + day],
  });
  const of = (kind) => rows.find((r) => r.kind === kind);
  const { rows: dev } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = ? AND key LIKE ?",
    args: [STEPS_KIND, day + ":%"],
  });
  return {
    day,
    goal: s.goal,
    steps,
    progress: Math.min(1, steps / s.goal),
    goal_met: steps >= s.goal,
    checked_in: !!of(WALK_CHECKIN_KIND),
    walked: !!of(WALKED_KIND),
    energy_today: Number(of(STEP_ENERGY_KIND)?.delta ?? 0),
    energy_full: s.energyFull,
    seed_today: Number(of(SEED_KIND)?.delta ?? 0),
    goal_seed: s.goalSeed,
    counted_devices: Number(dev[0]?.n ?? 0),
    settings: { goal: s.goal, nudge: s.nudge, nudge_weekends: s.nudgeWeekends },
  };
}

/** The three user-facing settings. Replicated LWW via ramble_settings. */
export async function writeStepSettings(db, patch, { now = Date.now(), emit } = {}) {
  if (!patch || typeof patch !== "object") throw new StepsInputError("settings must be an object");
  const writes = [];
  if (patch.goal !== undefined) {
    if (!Number.isInteger(patch.goal) || patch.goal < GOAL_MIN || patch.goal > GOAL_MAX) {
      throw new StepsInputError(`goal must be a whole number from ${GOAL_MIN} to ${GOAL_MAX}`);
    }
    writes.push(["steps.goal", String(patch.goal)]);
  }
  for (const [field, key] of [["nudge", "steps.nudge"], ["nudge_weekends", "steps.nudge.weekends"]]) {
    if (patch[field] === undefined) continue;
    if (typeof patch[field] !== "boolean") throw new StepsInputError(`${field} must be true or false`);
    writes.push([key, patch[field] ? "1" : "0"]);
  }
  if (!writes.length) throw new StepsInputError("nothing to change");
  for (const [key, value] of writes) {
    // eslint-disable-next-line no-await-in-loop
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [key, value],
    });
    // eslint-disable-next-line no-await-in-loop
    await safeEmit(emit, "ramble_settings", "update", { key, value });
  }
  const settled = await settleDay(db, { now, emit });
  return { ...(await stepsState(db, { now })), settled };
}

/** R8: this instance is where the player walks from. Local key, never emitted. */
export async function touchHome(db, { now = Date.now() } = {}) {
  try {
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [HOME_KEY, String(now)],
    });
  } catch { /* a marker, never worth failing a request over */ }
}

export const HOME_WINDOW_MS = 3 * 24 * 3600 * 1000;
export const ENGAGED_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** A counter reading older than this means the server may simply not have SEEN today's walk. */
export const STALE_READING_MS = 3 * 3600 * 1000;

/**
 * The bird's voice. No numbers: a lock screen is public. (R10: en/es.)
 * `low`    — the count is fresh and really is under half the goal.
 * `unseen` — this player counts steps with the app, but no reading has
 *            arrived for hours: they may well have walked. Ask to be shown,
 *            never imply they did not walk (S1: never punish).
 */
export const NUDGE_TEXT = Object.freeze({
  en: Object.freeze({
    low: Object.freeze({ title: "Your bird is by the door", body: "A short walk would cheer you both up." }),
    unseen: Object.freeze({ title: "Your bird wants to hear about your day", body: "Open Ramble so it can count today's steps, or take a short walk together." }),
  }),
  es: Object.freeze({
    low: Object.freeze({ title: "Tu pájaro te espera en la puerta", body: "Una caminata corta los alegraría a los dos." }),
    unseen: Object.freeze({ title: "Tu pájaro quiere saber de tu día", body: "Abre Ramble para que cuente los pasos de hoy, o den juntos una caminata corta." }),
  }),
});
export function nudgeText(lang, variant = "low") {
  const set = Object.hasOwn(NUDGE_TEXT, lang) ? NUDGE_TEXT[lang] : NUDGE_TEXT.en;
  return Object.hasOwn(set, variant) ? set[variant] : set.low;
}

/**
 * Should THIS instance nudge now (spec §9)? Every condition must hold; the
 * first that fails is the reason. Read-only.
 */
export async function nudgeDecision(db, { now = Date.now() } = {}) {
  const s = await readStepSettings(db);
  if (!s.nudge) return { send: false, reason: "off" };
  const d = new Date(now);
  const dow = d.getDay();
  if (!s.nudgeWeekends && (dow === 0 || dow === 6)) return { send: false, reason: "weekend" };
  const hour = d.getHours();
  if (hour < s.nudgeHour || hour >= s.nudgeUntil) return { send: false, reason: "hour" };
  const { rows: home } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [HOME_KEY] });
  const seen = Number(home[0]?.value);
  if (!Number.isFinite(seen) || now - seen > HOME_WINDOW_MS) return { send: false, reason: "not-home" };
  const day = localDay(now);
  if ((await rowDelta(db, NUDGE_KIND, day)) !== null) return { send: false, reason: "already" };
  // Engagement by the DAY KEY, not created_at: applyRambleWallet merges
  // created_at to the MIN of two instances' values, so it is not a reliable
  // clock (eggs.js warns against ordering by it). Keys are YYYY-MM-DD[:dev],
  // so a string compare against the window's first day is exact.
  const since = localDay(now - ENGAGED_WINDOW_MS);
  const { rows: used } = await db.execute({
    sql: "SELECT 1 FROM ramble_wallet WHERE kind IN (?, ?) AND key >= ? LIMIT 1",
    args: [STEPS_KIND, WALK_CHECKIN_KIND, since],
  });
  if (!used.length) return { send: false, reason: "not-engaged" };
  if ((await rowDelta(db, WALK_CHECKIN_KIND, day)) !== null) return { send: false, reason: "walked" };
  const steps = await stepsToday(db, now, s);
  if (steps * 100 >= s.goal * s.nudgeBelow) return { send: false, reason: "on-track" };
  // Steps only arrive when the panel is opened. A counter player whose last
  // reading on THIS instance is hours old may have walked plenty: ask to be
  // shown rather than say "you haven't walked".
  const { rows: dev } = await db.execute({ sql: "SELECT MAX(last_read_at) AS t FROM ramble_step_devices", args: [] });
  const lastRead = Number(dev[0]?.t);
  const variant = Number.isFinite(lastRead) && lastRead > 0 && now - lastRead > STALE_READING_MS ? "unseen" : "low";
  return { send: true, reason: "due", day, variant };
}

/** Claim today's nudge BEFORE sending. True only for the claim that created the row. */
export async function markNudged(db, day, { now = Date.now(), emit } = {}) {
  return insertOnce(db, NUDGE_KIND, day, 1, now, emit);
}
