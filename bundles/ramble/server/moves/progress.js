/**
 * Chunk progress for the moves cards (moves design Task 4; private engineering
 * notes): a card is paid by the active minutes it actually logged, a little at
 * a time as the player goes, and its ledger row only ever grows.
 *
 * WHAT A CARD IS. `cardKey` is the FULL wallet key of one card: `<day>:<slot>`
 * for one of the day's own cards, later `<day>:x:<entryId>:<startedAtSeconds>`
 * for an extra beyond them. This module treats it as an opaque string and keys
 * the `ramble_wallet` rows by exactly it, so two cards of one day never share a
 * row. Building the extra shape and rewriting a stale day belong to the caller.
 *
 * THREE WRITES, THREE PURPOSES.
 *   local.moves.started.<cardKey>   JSON { startedAt, plannedSeconds } — written
 *       ONCE, and the wall-clock anchor the accepted seconds are clamped
 *       against. A second start for the same key keeps the first record.
 *   local.moves.best.<cardKey>      a JSON number — the high-water of accepted
 *       seconds, only ever raised, so a late lower post still reports the same
 *       `done` and never re-pays.
 *   movecard / movemin              the wallet rows (below).
 * The two settings rows are `local.` keys: they never replicate, and they are
 * never emitted. They are this instance's own bookkeeping about a session in
 * progress, not a fact about the player.
 *
 * ⚠ EVERY ramble_wallet ROW WRITTEN HERE IS A CONSTANT OR GROWS, because
 * applyRambleWallet merges a key conflict with MAX(delta) (instance-sync.js).
 *   movecard  key = the card key, delta = the Health this card has paid in all.
 *             Grown by compare-and-swap only, by the increase over what it
 *             already holds.
 *   movemin   key = the card key's day (its first ten characters), delta = the
 *             whole minutes accepted that day across its cards. Grown by the
 *             increase in `floor(accepted / 60)` when a card's high-water
 *             minute rises. A lost compare-and-swap there is IGNORED: it counts
 *             minutes, it does not pay, so it must never hold a pay back.
 *
 * THE PAY RULE, the same shape as ledger.js: the day's budget is claimed FIRST
 * (`claimIndoor`, or the outdoor budget for an outdoor entry); the card's row is
 * then grown by compare-and-swap to what it has already paid plus what the claim
 * allowed; only then is the pet fed, after `petState` has applied the decay the
 * bird was already owed. A lost compare-and-swap, an exhausted budget or a crash
 * between the writes pays 0 — every failure mode under-pays, never over-pays.
 *
 * ⚠ SERIALIZED PER CARD IN THIS PROCESS. Two posts for the same card arrive out
 * of order all the time (a retry, a second tab), so they run one after another
 * and the second reads what the first wrote. The compare-and-swap stays as the
 * backstop for a second process — another instance of the same user.
 */
import { createRequire } from "node:module";
import { casDelta, rowDelta } from "../steps.js";
import { feed as petFeed, petState } from "../pet.js";
import { claimCapped, claimIndoor } from "./indoor-cap.js";
import {
  chunkPoints, entryIsOutdoor, MovesInputError, MOVE_OUTDOOR_KIND, OUTDOOR_DAILY_CAP,
} from "./ledger.js";

// session.cjs is a dual Node/browser classic script (no ESM syntax), so
// `import()` cannot load it; `createRequire` can. Loaded lazily and cached, the
// way eggs.js loads bird-svg.cjs.
const require = createRequire(import.meta.url);
let sessionModule = null;
function sessionApi() {
  if (!sessionModule) sessionModule = require("./session.cjs");
  return sessionModule;
}

/** Wallet kind: key = the card key, delta = the Health this card has paid. Grows. */
export const MOVE_CARD_KIND = "movecard";
/** Wallet kind: key = the card key's day, delta = whole minutes accepted that day. Grows. */
export const MOVE_MIN_KIND = "movemin";

/** `local.` prefixes: this instance's own session bookkeeping, never replicated. */
const STARTED_PREFIX = "local.moves.started.";
const BEST_PREFIX = "local.moves.best.";

/** A card's accepted seconds may run this far ahead of the wall clock. */
const WALL_SLACK = 1.1;

/** The longest card key the ledger accepts. */
const CARD_KEY_MAX = 80;

function asAt(now) {
  return Number.isFinite(Number(now)) ? Number(now) : Date.now();
}

/** A card key is an opaque wallet key: non-empty, and short enough to store. */
function requireCardKey(cardKey) {
  if (typeof cardKey !== "string" || cardKey === "" || cardKey.length > CARD_KEY_MAX) {
    throw new MovesInputError(`cardKey must be a non-empty string of at most ${CARD_KEY_MAX} characters`);
  }
  return cardKey;
}

/** A JSON setting, or null when absent/unreadable/junk. */
async function readJson(db, key) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM ramble_settings WHERE key = ?",
      args: [key],
    });
    const value = rows[0]?.value;
    if (typeof value !== "string") return null;
    return JSON.parse(value);
  } catch { return null; }
}

/**
 * Raise a JSON-number setting to `value` and never lower it. No emit: a `local.`
 * key is this instance's own, so nothing about it leaves the box.
 */
async function raiseSetting(db, key, value, current) {
  if (!Number.isFinite(value) || value <= current) return;
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
          WHERE CAST(excluded.value AS REAL) > CAST(COALESCE(ramble_settings.value, '0') AS REAL)`,
    args: [key, JSON.stringify(value)],
  });
}

/**
 * Grow the day's whole-minute row by the minutes a card's high-water just
 * gained. Best effort: a lost compare-and-swap (another card of the same day,
 * or another process) leaves the count short, which under-counts and never
 * blocks a pay. Nothing here pays anything.
 */
async function growMinutes(db, cardKey, fromSeconds, toSeconds, { now, emit }) {
  const increase = Math.floor(toSeconds / 60) - Math.floor(fromSeconds / 60);
  if (!(increase > 0)) return;
  const day = cardKey.slice(0, 10);
  try {
    const held = await rowDelta(db, MOVE_MIN_KIND, day);
    const from = held === null ? null : Math.max(0, Number(held) || 0);
    await casDelta(db, MOVE_MIN_KIND, day, from, (from ?? 0) + increase, now, emit);
  } catch (err) {
    try { console.warn("[ramble moves] movemin write failed:", err?.message); } catch {}
  }
}

/* ------------------------------------------------------------------ start */

/**
 * Open a chunk: record when it started, once. A second call for the same card
 * returns the record the first one wrote and writes nothing, so a retried start
 * keeps the session's original anchor and its planned length.
 *
 * `plannedSeconds` is the length the compiled session gives this chunk, or null
 * when the caller has none (then `isChunkDone` can never be true for the card).
 * `day` is the card's day, kept in the signature for the day rule the caller
 * owns; the record itself is keyed by the card key alone.
 */
export async function startChunk(db, { cardKey, plannedSeconds = null, now = Date.now() } = {}) {
  const key = requireCardKey(cardKey);
  const at = asAt(now);
  const planned = Number.isFinite(Number(plannedSeconds)) && plannedSeconds !== null
    ? Math.max(0, Math.round(Number(plannedSeconds)))
    : null;
  const settingKey = STARTED_PREFIX + key;
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO NOTHING`,
    args: [settingKey, JSON.stringify({ startedAt: at, plannedSeconds: planned })],
  });
  const stored = await readJson(db, settingKey);
  const startedAt = Number(stored?.startedAt);
  return { startedAt: Number.isFinite(startedAt) ? startedAt : at };
}

/* --------------------------------------------------------------- progress */

/**
 * One post for one card, run under the card's own queue.
 *
 * `accepted` is the high-water of what the player may be credited with:
 * `max(storedBest, min(activeSeconds, (now - startedAt) / 1000 x 1.1))`, floored
 * and never below 0 — a client cannot claim more than the wall clock allows,
 * and a late lower post cannot take an accepted minute back.
 *
 * Returns `{ paid, total, done, capped, accepted }`: `paid` what THIS call
 * added to the bird, `total` what the card's row now holds, `done` whether the
 * card has passed its half-way mark, `capped` whether a daily budget cut the
 * claim short.
 */
export async function recordProgress(db, {
  day, cardKey, entry, plannedSeconds, activeSeconds, now = Date.now(), emit,
} = {}) {
  const key = requireCardKey(cardKey);
  const at = asAt(now);
  const active = Number(activeSeconds);
  if (typeof activeSeconds !== "number" || !Number.isFinite(active) || active < 0) {
    throw new MovesInputError("activeSeconds must be a number of seconds, zero or more");
  }
  // The start record is read inside the queue, so a post that arrives while the
  // start is still being written waits for it instead of failing.
  return serialize(key, () => payCard(db, {
    day, cardKey: key, entry, plannedSeconds, activeSeconds: active, now: at, emit,
  }));
}

async function payCard(db, { day, cardKey, entry, plannedSeconds, activeSeconds, now, emit }) {
  const started = await readJson(db, STARTED_PREFIX + cardKey);
  const startedAt = Number(started?.startedAt);
  if (!Number.isFinite(startedAt)) throw new MovesInputError("start the chunk first");

  const bestKey = BEST_PREFIX + cardKey;
  const storedBest = Number(await readJson(db, bestKey));
  const bestSeconds = Number.isFinite(storedBest) ? Math.max(0, storedBest) : 0;

  const wallAllowed = Math.max(0, ((now - startedAt) / 1000) * WALL_SLACK);
  const accepted = Math.max(0, Math.floor(Math.max(bestSeconds, Math.min(activeSeconds, wallAllowed))));

  // A caller's planned length wins; otherwise the one the start wrote; and a
  // card with neither has no half-way mark to pass.
  const planned = plannedSeconds === undefined || plannedSeconds === null
    ? (Number.isFinite(Number(started?.plannedSeconds)) ? Number(started.plannedSeconds) : null)
    : (Number.isFinite(Number(plannedSeconds)) ? Math.round(Number(plannedSeconds)) : null);
  const done = sessionApi().isChunkDone(planned, accepted);

  const target = chunkPoints(Math.floor(accepted / 60));
  const existing = await rowDelta(db, MOVE_CARD_KIND, cardKey);
  const alreadyPaid = Math.max(0, Number(existing) || 0);
  const want = Math.max(0, target - alreadyPaid);

  let paid = 0;
  let capped = false;
  if (want > 0) {
    const claim = entryIsOutdoor(entry)
      ? await claimCapped(db, {
        kind: MOVE_OUTDOOR_KIND, cap: OUTDOOR_DAILY_CAP, day, points: want, now, emit,
      })
      : await claimIndoor(db, { day, points: want, now, emit });
    capped = !!claim.capped;
    if (claim.paid > 0) {
      const grew = await casDelta(
        db, MOVE_CARD_KIND, cardKey, existing === null ? null : alreadyPaid, alreadyPaid + claim.paid, now, emit,
      );
      if (grew) {
        // Apply the pet's owed lazy decay first: decay landing afterwards would
        // clamp the Health just paid away (the rule in ledger.js `pay`).
        await petState(db, { now });
        await petFeed(db, { type: "move", amount: claim.paid }, { now, emit });
        paid = claim.paid;
      }
    }
  }

  const held = Number(await rowDelta(db, MOVE_CARD_KIND, cardKey));
  const total = Number.isFinite(held) ? Math.max(0, held) : 0;

  await raiseSetting(db, bestKey, accepted, bestSeconds);
  await growMinutes(db, cardKey, bestSeconds, accepted, { now, emit });

  return { paid, total, done, capped, accepted };
}

/* ------------------------------------------------------------- in-process queue */

/**
 * One queue per card key: a call starts only after the previous call for the
 * same card has settled, and the entry is dropped again once the queue is
 * idle. Keys are opaque, so the map is bounded by the cards in flight, not by
 * the day's play.
 */
const queues = new Map();

function serialize(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  const idle = next.then(() => {}, () => {});
  queues.set(key, idle);
  idle.then(() => { if (queues.get(key) === idle) queues.delete(key); });
  return next;
}

/* ------------------------------------------------------------- planned time */

/**
 * The planned length of one chunk of a session, in seconds: the compiled
 * chunk's own count when `chain` names it, else the entry's stated minutes.
 *
 * A chain the compiler refuses (an unknown id, an entry that is not a card, a
 * broken chain) is not an error here — the entry's minutes are still an honest
 * plan, and the half-way mark only has to be reachable.
 */
export function plannedSecondsFor({ chain, entryId, library, entry } = {}) {
  if (Array.isArray(chain) && chain.length > 0) {
    try {
      const compiled = sessionApi().compileSession(chain, library);
      const chunk = (compiled?.chunks || []).find((c) => c && c.chunkId === entryId);
      if (chunk && Number.isFinite(Number(chunk.plannedSeconds))) return Number(chunk.plannedSeconds);
    } catch { /* fall through to the entry's own minutes */ }
  }
  const minutes = Number(entry?.minutes);
  return Number.isFinite(minutes) ? Math.round(minutes * 60) : null;
}