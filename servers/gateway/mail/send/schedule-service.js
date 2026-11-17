/**
 * Crow Mail's scheduling: the two presets the sheet offers, the tap that freezes a draft until its due
 * time, and the scheduler tick that delivers held and scheduled sends, marks the ones whose time has
 * gone as missed, and hands the interrupted and unconfirmed ones to the send service's reconcile.
 *
 * A schedule is a tap like a send is: `scheduleDraft` runs the same preflight, the same account checks
 * and the same claim check a send does, then writes the state, the due time and a seal over the due
 * time, the account, the From address and a fresh per-tap id in ONE guarded UPDATE that carries the
 * head hash the person was looking at. It is the only caller besides `requestSend` that may enter a tap
 * state, and `deliver` re-checks the seal before it claims anything, so a row a writer revived cannot
 * go out.
 *
 * The due time arrives as zone-qualified ISO text (`2026-11-12T07:30:00-06:00`), because the sheet is
 * drawn in the instance's own zone and a bare wall time would mean a different instant on a box that
 * moved. Its offset must be the instance zone's offset at that instant, or the schedule is refused
 * `bad_input` — a silent send at the wrong hour is the failure this check exists to prevent. Epoch ms
 * (the plan's own signature) is accepted as it stands and stored as it is; every time is compared in ms.
 *
 * The tick never waits for SMTP: `sweepMailSends` starts each due delivery as a detached promise in a
 * module-level set (the hook runs inside the gateway's reminder scheduler, and a slow send must not
 * hold it), and only touches rows it can claim with the same guarded UPDATE `deliver` uses, so two
 * ticks — or two Crows on one file — produce one send. Rows past the grace window are `missed` and ring
 * one bell whose text is the spec's, with no recipient, subject or body in it; `notified_at` is written
 * only when a notification was really created, and the `missed` card state is the primary signal
 * either way.
 *
 * Every sentence is fixed: a `fail_reason` is one of `SEND_FAIL_REASONS`' phrases (plus the one reason
 * the sweep adds, below) and nothing else, a log line carries an event name and a code, and the bell
 * never carries mail content.
 */
import { MailError } from "../errors.js";
import { getAccount } from "../store/accounts.js";
import { claimedElsewhereSentence, makeIsClaimedElsewhere } from "../claims.js";
import { getDraft, listRevisions, transition } from "../drafts/store.js";
import { preflight } from "../drafts/preflight.js";
import { newTapId, sealFor } from "../drafts/seal.js";
import { loadKeychainKey } from "../../keychain/key.js";
import { createNotification } from "../../../shared/notifications.js";
import { instanceZone } from "../../../shared/schedule-store.js";
import { validTimeZone } from "../../../shared/relative-dates.js";
import {
  GRACE_MS, KEYCHAIN_KEY_MISSING_SENTENCE, SEND_FAIL_REASONS, STALE_SENDING_MS,
  deliver, inFlight as sendInFlight, isStaleSending, nextReconcileAt, reconcileUnknown,
} from "./send-service.js";

/** The soonest a message may be scheduled for: one minute ahead, so no tap is already late. */
export const SCHEDULE_MIN_LEAD_MS = 60 * 1000;

/** The furthest ahead a message may be scheduled for: ninety days (the sheet's own limit). */
export const SCHEDULE_MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

/** The title of every bell this module rings. The text carries no mail content, so the title says which. */
export const MISSED_TITLE = "Crow Mail";

/**
 * The one reason the sweep adds to Task 5's table: the account a scheduled message was made from is
 * gone, so there is no mailbox left to send from. The plan names the key (`account_removed`) but gives
 * no sentence for it, and Task 5's table is not this task's to edit; the fixed `not_found` phrase is
 * the plan's own wording for a mailbox that is no longer there, so that is what the row carries. The
 * key moves into `SEND_FAIL_REASONS` when that module is next opened.
 */
export const SCHEDULE_FAIL_REASONS = Object.freeze({
  account_removed: SEND_FAIL_REASONS.not_found,
});

/** The states a schedule may be taken from. */
const SCHEDULABLE_STATES = Object.freeze(["draft", "failed", "missed"]);

/** The two states a scheduled or held row may be in when the tick looks at it. */
const TAP_STATES = Object.freeze(["holding", "scheduled"]);

/** The due-time text: a zone-qualified ISO instant, with an explicit offset or `Z`. */
const ZONED_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

/* ------------------------------------------------------------------ the seam */

function defaultLoadKey() {
  const key = loadKeychainKey();
  return key?.seed ?? null;
}

/**
 * The whole seam, with the real implementation behind every key a caller did not pass. `deps` is
 * passed on to the send service unchanged, so one object drives the tap, the delivery and the reconcile;
 * `zone` is the instance zone (`instanceZone(db)`) unless a caller injects one.
 */
function resolveDeps(db, deps) {
  const given = deps == null ? {} : deps;
  const fn = (key, fallback) => (typeof given[key] === "function" ? given[key] : fallback);
  return {
    ...given,
    isClaimedElsewhere: fn("isClaimedElsewhere", makeIsClaimedElsewhere(db)),
    createNotification: fn("createNotification", createNotification),
    loadKey: fn("loadKey", defaultLoadKey),
    zone: typeof given.zone === "function" ? given.zone : () => instanceZone(db),
    now: fn("now", Date.now),
    inFlight: given.inFlight instanceof Map ? given.inFlight : sendInFlight,
  };
}

function nowOf(d, options) {
  const value = options?.now ?? (typeof d.now === "function" ? d.now() : d.now);
  const ms = Math.floor(Number(value));
  if (!Number.isFinite(ms) || ms < 0) throw new MailError("BAD_INPUT", "now");
  return ms;
}

/** The reading options `preflight` takes: the two attachment readers, passed through. */
function readerDeps(d) {
  return { readMessageRaw: d.readMessageRaw, readStorageFile: d.readStorageFile };
}

/** One log line: an event name and a code. Never a message, an address or a subject. */
function logCode(event, code) {
  console.warn(`[mail-schedule] ${event} ${code}`);
}

/** The failure phrase for a reason key; an unlisted key still says something true and fixed. */
function phraseFor(reason) {
  return SCHEDULE_FAIL_REASONS[reason] ?? SEND_FAIL_REASONS[reason] ?? SEND_FAIL_REASONS.send_failed;
}

/** Zones already validated, so the repeated reads below validate each one once. */
const knownZones = new Set();

/** A zone this runtime knows, or BAD_INPUT: a zone nothing can be scheduled in is a refusal. */
function requireZone(zone) {
  if (typeof zone === "string" && knownZones.has(zone)) return zone;
  const valid = validTimeZone(zone);
  if (!valid) throw new MailError("BAD_INPUT", "zone");
  knownZones.add(valid);
  return valid;
}

/** The instance zone, resolved once per call and never read from a bundle's own zone setting. */
async function zoneOf(d) {
  return requireZone(await d.zone());
}

/* ---------------------------------------------------------------- zone arithmetic */

const formatters = new Map();

function formatterFor(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/**
 * The wall clock in `zone` at `instant`: numbers, hour 0-23. The one read of a zone this module does,
 * so every rule below (a preset, a gap, an offset) is computed the same way.
 *
 * @param {number} instant epoch ms
 * @param {string} zone an IANA zone
 */
export function wallClockAt(instant, zone) {
  const valid = requireZone(zone);
  const parts = formatterFor(valid).formatToParts(new Date(Number(instant)));
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") % 24,
    minute: pick("minute"),
    second: pick("second"),
  };
}

/**
 * The zone's offset from UTC at one instant, in minutes (negative west of Greenwich). This is what a
 * zone-qualified due time is checked against.
 */
export function zoneOffsetMinutesAt(instant, zone) {
  const at = Math.floor(Number(instant));
  const w = wallClockAt(at, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - at) / 60_000);
}

/** The wall clock as minutes since the epoch, so two wall times compare as numbers. */
function wallMinutes(wall) {
  return Math.floor(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) / 60_000);
}

/**
 * One local wall time in one zone as epoch ms. A time that does not exist — the hour a spring-forward
 * skips — moves to the first valid minute after it, and a time that happens twice (a fall-back) takes
 * the first of the two. The direct guess is tried first; the minute scan is the fallback that makes the
 * gap and the repeat exact.
 *
 * @param {{year: number, month: number, day: number, hour: number, minute: number}} parts
 * @param {string} zone
 * @returns {number} epoch ms
 */
export function localTimeToInstant(parts, zone) {
  const valid = requireZone(zone);
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / 60_000;
  if (!Number.isFinite(target)) throw new MailError("BAD_INPUT", "time");
  const guess = target * 60_000 - zoneOffsetMinutesAt(target * 60_000, valid) * 60_000;
  if (Number.isFinite(guess) && wallMinutes(wallClockAt(guess, valid)) === target) return guess;
  // A zone's offset is within -12 h..+14 h of UTC, so the wall time is reached inside this span.
  for (let t = (target - 15 * 60) * 60_000; t <= (target + 14 * 60) * 60_000; t += 60_000) {
    const wall = wallMinutes(wallClockAt(t, valid));
    if (wall === target) return t;
    if (wall > target) return t;
  }
  throw new MailError("BAD_INPUT", "time");
}

/** A calendar day shifted by whole days, so a month or year end carries correctly. */
function addDays(wall, days) {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + days * 24 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** 0 = Sunday .. 6 = Saturday. */
function weekdayOf(wall) {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/** `H:MM` in the instance zone, 24-hour, no leading zero on the hour (the spec's notice text). */
export function hourMinute(instant, zone) {
  const w = wallClockAt(instant, zone);
  return `${w.hour}:${String(w.minute).padStart(2, "0")}`;
}

/**
 * The missed notice, exactly as the spec words it: the due time in the instance zone, 24-hour `H:MM`.
 *
 * @param {number} dueAt epoch ms
 * @param {string} zone
 */
export function missedNoticeText(dueAt, zone) {
  return `A message was due at ${hourMinute(dueAt, zone)} and did not go out. Open Crow Mail to send now, pick a new time, or cancel.`;
}

/* ---------------------------------------------------------------------- the presets */

/**
 * The two presets the schedule sheet offers, when no working hours are set (the only branch plan 3
 * has): tomorrow morning at 7:30 local, and the next work day at 8:00 local, skipping Saturday and
 * Sunday. "Next work day" is the earliest work day whose 08:00 is still ahead, so on a Thursday morning
 * it is that morning and on a Friday afternoon it is Monday.
 *
 * Both are Date objects of the exact instant, computed in the instance zone (`instanceZone(db)`) — a
 * bundle's own zone setting is never consulted — and a wall time the zone skips moves forward to the
 * first minute that exists.
 *
 * @param {object} db
 * @param {{now?: number, zone?: string}} [options]
 * @returns {Promise<{tomorrowMorning: Date, nextWorkDay: Date}>}
 */
export async function schedulePresets(db, options = {}) {
  const at = Math.floor(Number(options?.now ?? Date.now()));
  if (!Number.isFinite(at) || at < 0) throw new MailError("BAD_INPUT", "now");
  const zone = options?.zone != null ? requireZone(options.zone) : requireZone(await instanceZone(db));
  const today = wallClockAt(at, zone);
  const tomorrow = addDays(today, 1);
  const tomorrowMorning = localTimeToInstant({ ...tomorrow, hour: 7, minute: 30 }, zone);

  let nextWorkDay = null;
  for (let step = 0; step <= 7 && nextWorkDay == null; step += 1) {
    const day = addDays(today, step);
    const weekday = weekdayOf(day);
    if (weekday === 0 || weekday === 6) continue;
    const morning = localTimeToInstant({ ...day, hour: 8, minute: 0 }, zone);
    if (morning > at) nextWorkDay = morning;
  }
  if (nextWorkDay == null) throw new MailError("BAD_INPUT", "zone");

  return { tomorrowMorning: new Date(tomorrowMorning), nextWorkDay: new Date(nextWorkDay) };
}

/* ------------------------------------------------------------------------ the tap */

/**
 * A due time as epoch ms. Epoch ms (the plan's own signature) is taken as it stands; text must be a
 * zone-qualified ISO instant whose offset is the instance zone's offset at that instant, and whose wall
 * clock is the wall clock that instant really shows in the zone (so a date the calendar does not have,
 * and a wall time a DST gap skips, are both refused rather than reinterpreted).
 *
 * @param {number|string} value
 * @param {string} zone
 * @returns {number} epoch ms
 */
export function dueAtInstant(value, zone) {
  const valid = requireZone(zone);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new MailError("BAD_INPUT", "due_at");
    return Math.floor(value);
  }
  if (typeof value !== "string") throw new MailError("BAD_INPUT", "due_at");
  const match = ZONED_ISO.exec(value.trim());
  if (!match) throw new MailError("BAD_INPUT", "due_at");
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const offsetMinutes = offset === "Z"
    ? 0
    : (offset.startsWith("-") ? -1 : 1)
      * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const millis = Number((fraction ?? "0").padEnd(3, "0"));
  const wallMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute),
    Number(second ?? 0), millis);
  if (!Number.isFinite(wallMs)) throw new MailError("BAD_INPUT", "due_at");
  const instant = wallMs - offsetMinutes * 60_000;
  if (zoneOffsetMinutesAt(instant, valid) !== offsetMinutes) throw new MailError("BAD_INPUT", "due_at");
  const shown = wallClockAt(instant, valid);
  if (shown.year !== Number(year) || shown.month !== Number(month) || shown.day !== Number(day)
    || shown.hour !== Number(hour) || shown.minute !== Number(minute)) {
    throw new MailError("BAD_INPUT", "due_at");
  }
  return instant;
}

/**
 * Freeze one draft until a due time: the person's tap, taken with the hash their card was drawn from.
 *
 * The checks are a send's checks, run now so a doomed schedule is refused up front rather than at the
 * hour it was meant to go out: the head hash, the scheduling window, the account (present, signed in,
 * connected here) and the draft's own preflight (placeholders, recipients, size, attachments). Then one
 * guarded UPDATE moves the row into `scheduled` — `state IN (the state it was in)` AND `head_hash = the
 * tapped hash` — carrying `due_at`, a fresh per-tap id and the seal over the due time, the account and
 * the From address. A missing or empty hash is refused `changed` before anything is read or written; a
 * hash that is no longer the head loses the UPDATE and is refused `changed` with nothing written.
 *
 * @param {object} db
 * @param {object} deps see the module note
 * @param {{draftId: string, hash: string, dueAt: number|string, now?: number|Function}} options
 * @returns {Promise<{ok: true, dueAt: number}|{ok: false, code: string, reason?: string,
 *   state?: string, sentence?: string, preflight?: object}>}
 */
export async function scheduleDraft(db, deps, options = {}) {
  const d = resolveDeps(db, deps);
  const now = nowOf(d, options);
  const draftId = options?.draftId;
  const hash = options?.hash;
  // An absent hash is never a permission: it is the one thing the tap is, so it is refused first.
  if (typeof hash !== "string" || !hash) return { ok: false, code: "changed" };
  if (typeof draftId !== "string" || !draftId) return { ok: false, code: "not_found" };

  const row = await getDraft(db, draftId);
  if (!row) return { ok: false, code: "not_found" };
  if (!SCHEDULABLE_STATES.includes(row.state)) return { ok: false, code: "frozen", state: row.state };

  const zone = await zoneOf(d);
  let dueAt;
  try {
    dueAt = dueAtInstant(options?.dueAt, zone);
  } catch (err) {
    if (err instanceof MailError && err.code === "BAD_INPUT") {
      return { ok: false, code: "bad_input", detail: err.detail ?? null };
    }
    throw err;
  }
  if (dueAt < now + SCHEDULE_MIN_LEAD_MS) return { ok: false, code: "past" };
  if (dueAt > now + SCHEDULE_MAX_AHEAD_MS) return { ok: false, code: "too_far" };

  const account = await getAccount(db, row.accountId);
  if (!account) return { ok: false, code: "not_found" };
  if (account.status === "auth_failed") return { ok: false, code: "auth_failed" };
  if (account.status === "claimed_elsewhere") {
    return { ok: false, code: "claimed_elsewhere", sentence: claimedElsewhereSentence(null) };
  }

  // No key, no seal: the tap cannot be written at all, so nothing is frozen and nothing will be sent.
  const seed = await d.loadKey();
  if (!seed) {
    return {
      ok: false, code: "not_sendable", reason: "keychain_key_missing",
      sentence: KEYCHAIN_KEY_MISSING_SENTENCE,
    };
  }

  const rev = (await listRevisions(db, row.id)).find((entry) => entry.rev === row.headRev) ?? null;
  if (!rev) return { ok: false, code: "not_found" };
  let checked;
  try {
    checked = await preflight(db, row, rev, { accountId: row.accountId, deps: readerDeps(d) });
  } catch (err) {
    if (err instanceof MailError && err.code === "NOT_FOUND") return { ok: false, code: "not_found" };
    throw err;
  }
  if (!checked.ok) return { ok: false, code: "preflight", preflight: checked };

  // Is this instance the one connected to the address? Answered at tap time, like a send's.
  const claim = await d.isClaimedElsewhere(account);
  if (claim && claim.claimed) {
    return {
      ok: false, code: "claimed_elsewhere",
      instanceName: claim.instanceName ?? null,
      sentence: claimedElsewhereSentence(claim.instanceName),
    };
  }

  const tapId = newTapId();
  const seal = sealFor({
    draftId: row.id,
    headHash: hash,
    action: "schedule",
    when: dueAt,
    attachDigest: checked.attachDigest,
    accountId: row.accountId,
    fromAddress: checked.fromAddress,
    tapId,
  }, seed);
  const moved = await transition(db, row.id, [row.state], "scheduled", {
    due_at: dueAt,
    tap_seal: seal,
    tap_id: tapId,
    tap_action: "schedule",
    attach_digest: checked.attachDigest,
  }, { now, expectHash: hash });
  if (!moved) return { ok: false, code: "changed" };
  return { ok: true, dueAt };
}

/**
 * Give up a schedule: `scheduled -> draft` through `transition()`, which clears the seal and the due
 * time in the same UPDATE. Too late once the row is `sending` (or anything else).
 *
 * @param {object} db
 * @param {{draftId: string, now?: number|Function}} options
 * @returns {Promise<{ok: true}|{ok: false, state: string|null}>}
 */
export async function cancelSchedule(db, options = {}) {
  const now = nowOf({ now: Date.now }, options);
  const draftId = options?.draftId;
  if (typeof draftId !== "string" || !draftId) return { ok: false, state: null };
  if (await transition(db, draftId, ["scheduled"], "draft", { due_at: null }, { now })) return { ok: true };
  const row = await getDraft(db, draftId);
  return { ok: false, state: row?.state ?? null };
}

/* ------------------------------------------------------------------ the tick */

/**
 * The deliveries this process has started from a tick. Module state on purpose, beside the send
 * service's own in-flight map: the tick returns promptly and a test (or a shutdown) can wait for what
 * it started.
 */
export const sweepInFlight = new Set();

/** Start one delivery as a detached promise, tracked until it settles. */
function trackDelivery(db, d, draftId, now) {
  const work = deliver(db, d, draftId, { now })
    .catch((err) => {
      const code = err instanceof MailError ? err.code : "unknown";
      logCode("deliver_failed", code);
    })
    .finally(() => {
      sweepInFlight.delete(work);
    });
  sweepInFlight.add(work);
  return work;
}

/** Wait for every delivery a tick started. The seam a test (and a shutdown drain) uses. */
export async function _drainForTests() {
  while (sweepInFlight.size > 0) await Promise.allSettled([...sweepInFlight]);
}

/** Forget the started deliveries: what a restarted process's tick would see. */
export function _resetSweepForTests() {
  sweepInFlight.clear();
}

/** One bell, created through the injected creator; a creator that throws rings nothing. */
async function ring(d, db, options) {
  try {
    return await d.createNotification(db, options);
  } catch {
    return null;
  }
}

/** The bell a missed send rings: the spec's text, no recipient, no subject, no body. */
async function ringMissed(d, db, when, zone) {
  return ring(d, db, {
    title: MISSED_TITLE,
    body: missedNoticeText(when, zone),
    type: "attention",
    source: "mail",
    priority: "normal",
  });
}

/**
 * Why a due row must not be handed to the adapter, or null when it may be. The account is the one the
 * schedule was made from: gone, signed out, or connected on another Crow — each a fixed reason and no
 * socket. The auth failure rings a bell (the title only: the plan fixes no sentence for it).
 *
 * @returns {Promise<null|{reason: string, sentence: string, notify?: boolean}>}
 */
async function deliveryBlock(d, db, accountId) {
  const account = await getAccount(db, accountId);
  if (!account) {
    return { reason: "account_removed", sentence: phraseFor("account_removed") };
  }
  if (account.status === "auth_failed") {
    return { reason: "auth_failed", sentence: phraseFor("auth_failed"), notify: true };
  }
  if (account.status === "claimed_elsewhere") {
    return { reason: "claimed_elsewhere", sentence: claimedElsewhereSentence(null) };
  }
  const claim = await d.isClaimedElsewhere(account);
  if (claim && claim.claimed) {
    return { reason: "claimed_elsewhere", sentence: claimedElsewhereSentence(claim.instanceName ?? null) };
  }
  return null;
}

/** Leave a due row in `failed` with a fixed phrase, and ring the bell the reason carries. */
async function failDue(db, d, row, now, block) {
  const moved = await transition(db, row.id, TAP_STATES, "failed",
    { fail_reason: phraseFor(block.reason) }, { now });
  if (!moved) return null;
  if (block.notify) {
    await ring(d, db, { title: MISSED_TITLE, type: "attention", source: "mail", priority: "normal" });
  }
  return { draftId: row.id, reason: block.reason, sentence: block.sentence };
}

/**
 * The scheduler tick's mail work, in the plan's order:
 *
 *   (1) rows held or scheduled and due inside the grace window: start `deliver` for each as a detached,
 *       tracked promise, so the tick returns promptly and the reminder scheduler is never held by SMTP;
 *   (2) the same states past the grace window: `missed`, one bell, `notified_at` only when a
 *       notification was really created;
 *   (3) `sending` rows this process is not sending whose attempt is older than `STALE_SENDING_MS`:
 *       `unknown`, with the reconcile pointed at its first check;
 *   (4) `unknown` rows whose reconcile is due and whose account still exists: one Sent-folder check;
 *   (5) the daily prune — a no-op placeholder this task leaves for Task 13.
 *
 * Before a delivery it refuses the row outright when the account is gone (`account_removed`), signed out
 * (`auth_failed`, with a bell) or connected on another Crow (`claimed_elsewhere`) — never a socket, never
 * a silent drop. Two ticks seeing the same due row produce one claim and one send, because `deliver`'s
 * claim is the same single guarded UPDATE this sweep leaves to it.
 *
 * @param {object} db
 * @param {object} deps see the module note
 * @param {{now?: number|Function}} [options]
 * @returns {Promise<{delivered: number, missed: number, reconciled: number, unknown: number,
 *   failed: Array<{draftId: string, reason: string, sentence: string}>}>}
 */
export async function sweepMailSends(db, deps, options = {}) {
  const d = resolveDeps(db, deps);
  const now = nowOf(d, options);
  const counts = { delivered: 0, missed: 0, reconciled: 0, unknown: 0, failed: [] };

  const { rows } = await db.execute({
    sql: `SELECT id, account_id, state, due_at, hold_until FROM mail_drafts
           WHERE state IN ('holding', 'scheduled')`,
    args: [],
  });
  const dueTime = (row) => {
    const value = row.state === "scheduled" ? row.due_at : row.hold_until;
    return value == null ? null : Number(value);
  };

  // ---- (1) due, inside the grace window.
  for (const row of rows) {
    const when = dueTime(row);
    if (when == null || when > now || now - when > GRACE_MS) continue;
    const block = await deliveryBlock(d, db, row.account_id);
    if (block) {
      const failed = await failDue(db, d, row, now, block);
      if (failed) counts.failed.push(failed);
      continue;
    }
    trackDelivery(db, d, row.id, now);
    counts.delivered += 1;
  }

  // ---- (2) the same states, past the grace window: missed, and one bell.
  let zone = null;
  for (const row of rows) {
    const when = dueTime(row);
    if (when == null || when > now || now - when <= GRACE_MS) continue;
    const moved = await transition(db, row.id, TAP_STATES, "missed",
      { fail_reason: SEND_FAIL_REASONS.missed }, { now });
    if (!moved) continue;
    counts.missed += 1;
    if (zone == null) zone = await zoneOf(d);
    const created = await ringMissed(d, db, when, zone);
    if (created != null) {
      // Only a bell that really exists is recorded: the missed card state is the primary signal.
      await transition(db, row.id, ["missed"], "missed", { notified_at: now }, { now });
    }
  }

  // ---- (3) a claimed send this process is not running and has not run for the cutoff.
  const sending = await db.execute({
    sql: "SELECT id, state, attempt_at, claimed_at FROM mail_drafts WHERE state = 'sending'",
    args: [],
  });
  for (const raw of sending.rows) {
    const row = {
      id: String(raw.id),
      state: String(raw.state),
      attemptAt: raw.attempt_at == null ? null : Number(raw.attempt_at),
      claimedAt: raw.claimed_at == null ? null : Number(raw.claimed_at),
    };
    if (!isStaleSending(row, now, d.inFlight)) continue;
    const moved = await transition(db, row.id, ["sending"], "unknown", {
      fail_reason: SEND_FAIL_REASONS.send_failed,
      reconcile_count: 0,
      next_reconcile_at: nextReconcileAt(now, 0),
    }, { now });
    if (moved) counts.unknown += 1;
  }

  // ---- (4) one Sent-folder check for each unknown row whose check is due, where the account exists.
  const unknown = await db.execute({
    sql: `SELECT id, account_id FROM mail_drafts
           WHERE state = 'unknown' AND next_reconcile_at IS NOT NULL AND next_reconcile_at <= ?`,
    args: [now],
  });
  for (const row of unknown.rows) {
    const account = await getAccount(db, String(row.account_id));
    // A removed account's row stays terminal: there is no Sent folder left to look in (Task 13).
    if (!account) continue;
    const outcome = await reconcileUnknown(db, d, String(row.id), { now });
    if (outcome.outcome === "sent" || outcome.outcome === "unknown") counts.reconciled += 1;
  }

  // ---- (5) the daily prune: Task 13 fills this in.
  await pruneMailDrafts(db, { now });

  return counts;
}

/**
 * The daily prune of old drafts, their revisions and their comments — a placeholder, and the sweep's
 * last step. Task 13 fills it in when the retention rule is decided; this module invents no rule of its
 * own, so it removes nothing and says so.
 *
 * @returns {Promise<{pruned: number}>}
 */
export async function pruneMailDrafts(db, options = {}) {
  return { pruned: 0 };
}