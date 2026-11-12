/**
 * Crow Mail's sync engine: the one place that turns an adapter listing into stored rows. One folder
 * is one pass, one account is one list of passes, and every rule below exists to keep `highest_uid`
 * honest — it is a watermark, never a count, and everything else follows from it.
 *
 * A first sync (`highest_uid` 0 and `floor_uid` NULL, whatever `uid_validity` says) reads the window
 * the account asked for (`sinceDate = now - window_days`), stores what it finds, and then sets
 * `highest_uid` to the LISTING's `uidNext - 1` rather than the newest stored UID, so a window that
 * happens to hold nothing still moves the watermark forward. `floor_uid` is the lowest UID stored in
 * that window (or `uidNext` when nothing was), and it is the lower bound of every later expunge scan —
 * nothing older than the window is ever pruned.
 *
 * Every later sync lists `afterUid: highest_uid` and advances the watermark batch by batch, so a
 * failure halfway through a large arrival keeps the progress the batches before it made. UIDVALIDITY
 * is compared only after that list has succeeded, and a change empties the folder and starts over as a
 * first sync (the UIDs mean something else now, so nothing may be matched against them). Unknown is
 * never a change: only two positive integers are compared, so a listing that omits the value leaves
 * the stored one exactly as it was — a server that says nothing about UIDVALIDITY must not empty a
 * folder whose rows are still keyed on the UIDs it holds.
 *
 * Two behaviours of a real adapter shape the rest. `get()` may omit a UID it was asked for — one
 * expunged between the listing and the body fetch, or one left outside a download budget — and an
 * answer without the raw bytes is an omission too. An omitted UID is retried once on its own; when it
 * is still missing the pass STOPS there (`uid_omitted`), persists `lowest omitted UID - 1`, and still
 * reconciles flags and expunges below that line, because advancing past a UID that was never
 * delivered would lose it forever (the next listing starts above the watermark). The same stop
 * applies when one message cannot be stored. One UID nothing ever delivers must not freeze a folder
 * for ever, though, so a UID still missing on the third consecutive pass is `uid_skipped` instead:
 * nothing is stored for it, the pass advances past it, and the count behind that decision lives in
 * memory only (see `noteOmitted`). And a message the listing reports above MAX_RAW_BYTES, or one
 * whose bytes come back empty, is stored as a `too_large` placeholder without its bytes ever being
 * held.
 *
 * Everything reaching a log line is a code, a count or an id: a folder path is an opaque string that
 * may carry a mailbox name, and a message's subject, addresses and bytes belong to the sender. An
 * adapter failure aborts its folder with nothing deleted, and the four failures that end the whole
 * account pass (AUTH_FAILED, NETWORK, TLS and the pass's own deadline TIMEOUT) travel further than
 * their own folder: the folders after it are abandoned and the account is not stamped.
 *
 * Two on-demand reads reach outside the window without moving it. `fetchOlder` pages a folder's
 * history backwards from `floor_uid` by UID (never by date, which would skip a run of messages sharing
 * one INTERNALDATE) and lowers the floor only over a page that went through whole. `searchRemote`
 * stores a server-side search's hits, skips the ones already local, and leaves both watermarks alone.
 * A hit a search stored far below the window does not make the range between contiguous, which is why
 * the floor only ever follows a page a backfill handled — and never passes a UID it did not store.
 */
import { MailError, toMailError } from "../errors.js";
import { MAX_RAW_BYTES, parseRawMessage, placeholderMessage } from "../parse.js";
import { getAccount, updateAccount } from "../store/accounts.js";
import {
  applyFlags,
  deleteMissing,
  getFolder,
  listFolders,
  minUid,
  resetFolder,
  setFolderSyncState,
  storedUids,
  upsertFolders,
  upsertMessage,
} from "../store/messages.js";

/** UIDs per get() call, however small the messages are. */
export const SYNC_BATCH_MAX = 25;

/**
 * How long the on-demand read waits before one UID's stuck count may move again. `fetchOlder` is a
 * person clicking a button, and three quick clicks at a merely slow message are not three passes of a
 * stuck mailbox; a regular sync is spaced by the poll interval and counts every pass.
 */
export const LIVENESS_MIN_GAP_MS = 60 * 1000;

/**
 * UIDs per get() call for a search hit set, which carries no sizes at all: only a count bounds it, so
 * a batch of 25 could ask for 625 MB of bodies in one call. Four is the count a sizeless listing gets.
 */
export const SEARCH_BATCH_MAX = 4;

/** Raw bytes per get() call, counted from the sizes the listing reported. */
export const SYNC_BATCH_BYTES = 16 * 1024 * 1024;

/**
 * Virtual folders a server lists but that are views of mail already synced in a real folder: syncing
 * one would store every message a second time. Exactly these three, compared case-insensitively.
 */
export const SKIP_SPECIAL_USE = Object.freeze(["\\All", "\\Flagged", "\\Important"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;

/** UIDs one on-demand read (`fetchOlder`) asks for when the caller named no count. */
const DEFAULT_OLDER_LIMIT = 50;

/** The skipped three, lower-cased once: a special-use flag is case-insensitive (RFC 6154). */
const SKIPPED_SPECIAL_USE = new Set(SKIP_SPECIAL_USE.map((flag) => flag.toLowerCase()));

/** The codes that mean the connection itself is unusable, wherever the pass meets them. */
const PASS_ENDING_CODES = new Set(["AUTH_FAILED", "NETWORK", "TLS", "TIMEOUT"]);

/**
 * Does this failure end the whole account pass rather than one folder? The connection codes do — from
 * the folder listing or from any folder's own pass — and so does the engine's deadline TIMEOUT: that
 * one is the pass's clock, not a folder's, and its detail is `sync_deadline`. Any other TIMEOUT (a
 * socket an adapter gave up on) stays the folder's own, like every other code.
 */
function endsPass(mailErr) {
  return PASS_ENDING_CODES.has(mailErr.code)
    && (mailErr.code !== "TIMEOUT" || mailErr.detail === "sync_deadline");
}

/** A context's log default: a sync that was given no log sink says nothing. */
function noop() {}

/* --------------------------------------------------------------------- context */

/**
 * The one place ctx is read: defaults for `now`, `log` and `yieldFn`, and a check that the two things
 * a pass cannot run without are there.
 *
 * @param {{db: object, adapter: object, now?: Function, deadlineAt?: number|null,
 *          log?: Function, yieldFn?: Function}} ctx
 */
function contextOf(ctx) {
  if (ctx == null || typeof ctx !== "object") {
    throw new TypeError("sync needs a context object with {db, adapter}");
  }
  if (ctx.db == null || typeof ctx.db.execute !== "function") {
    throw new TypeError("sync needs a db client");
  }
  if (ctx.adapter == null || typeof ctx.adapter.list !== "function") {
    throw new TypeError("sync needs a mail adapter");
  }
  return {
    db: ctx.db,
    adapter: ctx.adapter,
    now: typeof ctx.now === "function" ? ctx.now : Date.now,
    deadlineAt: Number.isFinite(ctx.deadlineAt) ? Number(ctx.deadlineAt) : null,
    log: typeof ctx.log === "function" ? ctx.log : noop,
    yieldFn: typeof ctx.yieldFn === "function"
      ? ctx.yieldFn
      : () => new Promise((resolve) => { setImmediate(resolve); }),
  };
}

function accountIdOf(value) {
  if (typeof value !== "string" || value === "") throw new MailError("BAD_INPUT", "account_id");
  return value;
}

/** A caller-sized UID count: a positive integer, or the on-demand default when none was given. */
function onDemandLimit(value) {
  if (value == null) return DEFAULT_OLDER_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new MailError("BAD_INPUT", "limit");
  return n;
}

/** One mailbox's worth of work must fit in the pass's budget: past the deadline is a TIMEOUT. */
function checkDeadline(c) {
  if (c.deadlineAt == null) return;
  if (c.now() >= c.deadlineAt) throw new MailError("TIMEOUT", "sync_deadline");
}

/* ------------------------------------------------------------------- the shape */

/** A folder nothing has been stored for yet: the first-sync rule's own test. */
function isFirstSync(folder) {
  return Number(folder.highestUid) === 0 && folder.floorUid == null;
}

function folderIdOf(folder) {
  const id = Number(folder?.id);
  if (!Number.isInteger(id) || id <= 0) throw new MailError("BAD_INPUT", "folder");
  return id;
}

/**
 * A UIDVALIDITY as the engine compares it: a positive integer, or null for "nothing was said". Called
 * on BOTH sides before any Number() sees the value, because `Number(null)` is 0 — and a 0 that reads
 * as a validity is a folder emptied for a value the server never reported.
 */
function uidValidityOf(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sizeOf(item) {
  const size = Number(item?.size);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function ascending(items) {
  return [...items].sort((left, right) => Number(left.uid) - Number(right.uid));
}

/**
 * Split one listing into get() calls: at most SYNC_BATCH_MAX UIDs and about SYNC_BATCH_BYTES of
 * reported size each, in ascending UID order. A message bigger than the byte budget is a batch of its
 * own, so the budget can never starve it and it is never fetched beside anything else.
 *
 * @param {object[]} items listing items, already ascending
 * @param {number} [maxCount] UIDs per batch (SEARCH_BATCH_MAX for a sizeless search answer)
 * @returns {object[][]} batches
 */
function batchItems(items, maxCount = SYNC_BATCH_MAX) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && (current.length >= maxCount || bytes + size > SYNC_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The listing's `uidNext`, or the contract's own fallback (highest listed UID + 1) for a server and
 * adapter that left it out: a watermark of `uidNext - 1` must still be a number.
 */
function uidNextOf(listing, items) {
  const next = Number(listing?.uidNext);
  if (Number.isInteger(next) && next > 0) return next;
  return items.reduce((top, item) => {
    const uid = Number(item?.uid);
    return Number.isInteger(uid) && uid > top ? uid : top;
  }, 0) + 1;
}

/** A folder whose special-use flag is one of the three virtual views is never synced. */
function isSkippedSpecialUse(folder, entry) {
  const declared = typeof entry?.specialUse === "string" ? entry.specialUse : folder.specialUse;
  if (typeof declared !== "string") return false;
  return declared.split(/\s+/).some((token) => SKIPPED_SPECIAL_USE.has(token.trim().toLowerCase()));
}

/* ------------------------------------------------------------- adapter calls */

/** One listing, with any failure classified: the folder aborts, and the message is never stored. */
async function listOrThrow(c, folderPath, options) {
  let listing;
  try {
    listing = await c.adapter.list(folderPath, options);
  } catch (err) {
    throw toMailError(err);
  }
  if (listing == null || typeof listing !== "object") throw new MailError("PROTOCOL", "list");
  // A listing item whose UID is not a positive integer names no row and is dropped here, exactly as
  // the adapter contract drops one: everything below may key on the UID.
  const items = Array.isArray(listing.items) ? listing.items.flatMap((item) => {
    const uid = Number(item?.uid);
    return Number.isInteger(uid) && uid > 0 ? [{ ...item, uid }] : [];
  }) : [];
  return { uidValidity: listing.uidValidity ?? null, uidNext: listing.uidNext, items };
}

/** The raw bytes of the UIDs asked for: only the UIDs that came back are ever stored. */
async function getOrThrow(c, folderPath, uids) {
  try {
    const messages = await c.adapter.get(folderPath, uids);
    return Array.isArray(messages) ? messages.filter((message) => message && Number.isInteger(Number(message.uid))) : [];
  } catch (err) {
    throw toMailError(err);
  }
}

/** The flags a stored row takes: the delivered message's, else the listing item's. */
function flagsOf(entry) {
  const flags = Array.isArray(entry.message?.flags) ? entry.message.flags : entry.item?.flags;
  return Array.isArray(flags) ? flags.filter((flag) => typeof flag === "string") : [];
}

/** The internal date a stored row takes: the delivered message's, else the listing item's. */
function internalDateOf(entry) {
  const value = Number(entry.message?.internalDate ?? entry.item?.internalDate);
  return Number.isFinite(value) ? value : null;
}

/* --------------------------------------------------- liveness for a stuck UID */

/**
 * Consecutive passes that stopped on the same omitted (folder, uid), keyed `folderId:uid`, each with
 * the time its count last moved. Memory only: this is the engine's own note about its progress, not
 * mailbox state, so it never reaches a table and it starts empty on every process start.
 */
const STUCK_OMISSIONS = new Map();

/** Consecutive passes one omitted UID may stop before the pass gives up on that one UID. */
const LIVENESS_PASSES = 3;

const stuckKey = (folderId, uid) => `${folderId}:${uid}`;

/**
 * Note one pass that asked for `uid` and did not get it back, and answer how many passes in a row
 * have now done so. Without this a mailbox that never answers for one UID would hold that folder's
 * watermark for ever; on the third counted pass `fetchBatch` skips the UID instead of stopping.
 *
 * `minGapMs` is the on-demand read's own rule: the count only moves when at least that long has
 * passed since it last moved for this UID (its time from `ctx.now()`), so a person clicking `fetchOlder`
 * three times in a minute does not skip a message the server is merely slow about. A pass inside the
 * gap is not counted at all — it still stops at the UID — and the count stays where it was. A sync
 * pass is spaced by the poll interval, so it passes no gap and every pass counts.
 *
 * @returns {number} the counted consecutive passes (unchanged when the gap has not passed)
 */
function noteOmitted(folderId, uid, { minGapMs = 0, nowMs = 0 } = {}) {
  const key = stuckKey(folderId, uid);
  const entry = STUCK_OMISSIONS.get(key);
  if (entry && minGapMs > 0 && nowMs - entry.at < minGapMs) return entry.passes;
  const passes = (entry?.passes ?? 0) + 1;
  STUCK_OMISSIONS.set(key, { passes, at: nowMs });
  return passes;
}

/** The UID arrived (or was given up on): its count starts again from nothing. */
function clearOmitted(folderId, uid) {
  STUCK_OMISSIONS.delete(stuckKey(folderId, uid));
}

/** A pass that finished with nothing stuck leaves no count behind: delivered, or no longer listed. */
function clearFolderOmitted(folderId) {
  const prefix = `${folderId}:`;
  for (const key of [...STUCK_OMISSIONS.keys()]) {
    if (key.startsWith(prefix)) STUCK_OMISSIONS.delete(key);
  }
}

/**
 * Forget every stuck count. Tests only: the map is per process, and a folder id from one test's
 * scratch database must never lend its count to the next test's.
 */
export function resetSyncLivenessForTests() {
  STUCK_OMISSIONS.clear();
}

/* ------------------------------------------------------------------ the pass */

/**
 * The bytes of one batch's members, by UID. A member the listing reports above MAX_RAW_BYTES is here
 * already, marked so: its body is never asked for, and it is stored as too_large. A UID the first
 * get() left out gets exactly one more call on its own — an expunged message simply stays absent, and
 * one the adapter merely did not reach usually arrives there. A UID still missing after that is the
 * batch's `stopAtUid`: nothing at or above it may be stored. An answer without the raw bytes is an
 * omission too — a message with no body is not a message, and it is certainly not a too_large one.
 *
 * With `liveness` set (a sync pass), a UID that has now been missing on LIVENESS_PASSES consecutive
 * counted passes is logged as uid_skipped and passed over instead of stopping the pass. Nothing is
 * stored for it either way. `livenessGapMs` is `fetchOlder`'s slower clock (see `noteOmitted`): with
 * it set, a pass inside the gap stops at the UID without counting.
 *
 * With `skipOmissions` set (a search answer), a UID still missing after its one retry is passed over
 * and reported in `omitted` instead of stopping the batch: a search hit is not a watermark, so one it
 * can never deliver must not cost the folder every hit beside it.
 *
 * @param {object} c the resolved context
 * @param {object} folder the stored folder row
 * @param {object[]} batch ascending items (`{uid, size}` from a listing, or `{uid}` from a search)
 * @param {{liveness?: boolean, skipOmissions?: boolean, livenessGapMs?: number}} [options]
 * @returns {Promise<{delivered: Map<number, object>, stopAtUid: number|null, omitted: number[]}>}
 */
async function fetchBatch(c, folder, batch, {
  liveness = false, skipOmissions = false, livenessGapMs = 0,
} = {}) {
  const delivered = new Map();
  const omitted = [];
  const wanted = [];
  for (const item of batch) {
    if (sizeOf(item) > MAX_RAW_BYTES) delivered.set(item.uid, { item, tooLarge: true });
    else wanted.push(item);
  }

  let stopAtUid = null;
  if (wanted.length > 0) {
    const folderId = liveness ? folderIdOf(folder) : null;
    const got = new Map();
    for (const message of await getOrThrow(c, folder.path, wanted.map((item) => item.uid))) {
      // The UID is the key whatever type an implementation answered with, and a message that came
      // back without its bytes is not delivered: it is what an omission looks like from here.
      const uid = Number(message.uid);
      if (!Number.isInteger(uid) || uid <= 0 || !Buffer.isBuffer(message.raw)) continue;
      if (!got.has(uid)) got.set(uid, message);
    }
    for (const item of wanted) {
      if (got.has(item.uid)) continue;
      checkDeadline(c);
      const again = await getOrThrow(c, folder.path, [item.uid]);
      const found = again.find((message) => Number(message.uid) === item.uid
        && Buffer.isBuffer(message.raw));
      if (found) got.set(item.uid, found);
    }
    for (const item of wanted) {
      const message = got.get(item.uid);
      if (message) {
        if (liveness) clearOmitted(folderId, item.uid);
        delivered.set(item.uid, { item, message });
        continue;
      }
      // The third pass in a row that asked for this UID and got nothing: the mailbox is not going to
      // answer for it, so the folder moves on rather than never moving again. Nothing is stored for
      // the UID, and the count is forgotten so the next decision starts fresh.
      if (liveness && noteOmitted(folderId, item.uid, { minGapMs: livenessGapMs, nowMs: c.now() })
        >= LIVENESS_PASSES) {
        clearOmitted(folderId, item.uid);
        c.log({ event: "uid_skipped", folderId, uid: item.uid, code: "omitted" });
        continue;
      }
      // A search hit is nobody's watermark: pass over it and let the caller count it.
      if (skipOmissions) {
        omitted.push(item.uid);
        continue;
      }
      if (stopAtUid == null || item.uid < stopAtUid) stopAtUid = item.uid;
    }
  }

  return { delivered, stopAtUid, omitted };
}

/**
 * Store the delivered members of one batch in UID order, each in its own try/catch, because a hostile
 * message must never take its folder with it. Nothing at or above a UID this pass could not deliver or
 * store is written: the caller decides what that means for its watermark, but the hole is never closed
 * over. `stopReason` says which of the two it was — an omission from the adapter (`omitted`) or a write
 * that failed (`store_failed`) — so the caller can log the right thing.
 *
 * @param {object} c the resolved context
 * @param {object} folder the stored folder row
 * @param {object[]} batch ascending items
 * @param {Map<number, object>} delivered the batch's bytes, by UID (see fetchBatch)
 * @param {number|null} stopAtUid a UID fetchBatch could not deliver, if any
 * @returns {Promise<{added: number, lowestStoredUid: number|null, stopAtUid: number|null,
 *                    stopReason: string|null}>}
 */
async function storeBatch(c, folder, batch, delivered, stopAtUid) {
  const folderId = folderIdOf(folder);
  let added = 0;
  let lowestStoredUid = null;
  let stop = stopAtUid ?? null;
  let stopReason = stop == null ? null : "omitted";

  for (const item of batch) {
    if (stop != null && item.uid >= stop) break;
    checkDeadline(c);
    const entry = delivered.get(item.uid);
    if (!entry) continue;
    // Between messages, so a large arrival can never hold the event loop for the whole folder.
    await c.yieldFn();

    try {
      // fetchBatch only delivers bytes, so a null raw here is the listing's own too_large marker. An
      // empty body is how the adapter reports a message above the raw cap, so it is a too_large row
      // too — never an empty message that reads as one the sender left blank.
      const raw = entry.tooLarge ? null : entry.message.raw;
      const parsed = raw == null || raw.length === 0
        ? placeholderMessage("too_large")
        : await parseRawMessage(raw);
      const written = await upsertMessage(c.db, {
        ...parsed,
        accountId: folder.accountId,
        folderId,
        uid: item.uid,
        flags: flagsOf(entry),
        internalDate: internalDateOf(entry),
      });
      if (written.created) added += 1;
      if (lowestStoredUid == null || item.uid < lowestStoredUid) lowestStoredUid = item.uid;
    } catch (err) {
      // A message that cannot be stored holds the watermark, exactly like one get() left out: the
      // code is all a log may say about it.
      c.log({ event: "message_failed", folderId, uid: item.uid, code: toMailError(err).code });
      if (stop == null || item.uid < stop) {
        stop = item.uid;
        stopReason = "store_failed";
      }
      break;
    }
  }

  return { added, lowestStoredUid, stopAtUid: stop, stopReason };
}

/**
 * Fetch and store batches of items, stopping at the first UID the pass could not deliver or store.
 *
 * `afterBatch(batchTop)` runs after each completed batch, so a caller that owns a watermark can
 * persist its progress there: an interruption then leaves progress rather than work to redo. A pass
 * that stopped writes nothing for the batches after it, and nothing at or above its stop UID.
 * `liveness` is the sync pass's own rule (see fetchBatch): for the on-demand reads it stays off, so
 * they keep stopping on the first UID they cannot get — except a search answer, whose `skipOmissions`
 * passes the missing hits over and reports them in `omittedUids`, and `fetchOlder`, which turns it on
 * with `livenessGapMs` so a person's quick clicks never add up to a give-up.
 *
 * @param {object} c the resolved context
 * @param {object} folder the stored folder row
 * @param {object[][]} batches ascending items, grouped as batchItems returned them
 * @param {{afterBatch?: Function|null, liveness?: boolean, skipOmissions?: boolean,
 *          livenessGapMs?: number}} [options]
 * @returns {Promise<{added: number, stopAtUid: number|null, stopReason: string|null,
 *                    lowestStoredUid: number|null, highestUid: number, omittedUids: number[]}>}
 */
async function storeBatches(c, folder, batches, {
  afterBatch = null, liveness = false, skipOmissions = false, livenessGapMs = 0,
} = {}) {
  let added = 0;
  let lowestStoredUid = null;
  let stopAtUid = null;
  let stopReason = null;
  let highestUid = 0;
  let omittedUids = [];

  for (const batch of batches) {
    checkDeadline(c);
    const fetched = await fetchBatch(c, folder, batch, { liveness, skipOmissions, livenessGapMs });
    if (fetched.omitted.length > 0) omittedUids = omittedUids.concat(fetched.omitted);
    const stored = await storeBatch(c, folder, batch, fetched.delivered, fetched.stopAtUid);
    added += stored.added;
    if (stored.lowestStoredUid != null
      && (lowestStoredUid == null || stored.lowestStoredUid < lowestStoredUid)) {
      lowestStoredUid = stored.lowestStoredUid;
    }
    if (stored.stopAtUid != null) {
      stopAtUid = stored.stopAtUid;
      stopReason = stored.stopReason;
      break;
    }

    const batchTop = batch[batch.length - 1].uid;
    if (batchTop > highestUid) highestUid = batchTop;
    if (afterBatch) await afterBatch(batchTop);
  }

  return { added, stopAtUid, stopReason, lowestStoredUid, highestUid, omittedUids };
}

/**
 * Fetch and store one listing's items, and keep the watermark moving while it does.
 *
 * A batch is built from the reported sizes, its oversized members are stored without a get(), and
 * everything else is fetched and stored one message at a time in UID order. A completed batch of a
 * later sync persists its own highest UID, so an interruption leaves progress rather than work to
 * redo; a first sync writes its state once, at the end, so that an aborted one starts over cleanly.
 *
 * @param {object} c the resolved context
 * @param {object} folder the stored folder row
 * @param {object[]} items the listing's items
 * @param {{first: boolean, liveness?: boolean}} options a first sync writes its state once, at the end
 * @returns {Promise<{added: number, stopAtUid: number|null, stopReason: string|null,
 *                    lowestStoredUid: number|null, highestUid: number}>}
 */
async function storeItems(c, folder, items, { first, liveness = false }) {
  const folderId = folderIdOf(folder);
  const watermark = Math.max(0, Number(folder.highestUid) || 0);
  const outcome = await storeBatches(c, folder, batchItems(ascending(items)), {
    liveness,
    afterBatch: first
      ? null
      : (batchTop) => setFolderSyncState(c.db, folderId, { highestUid: Math.max(watermark, batchTop) }),
  });
  return { ...outcome, highestUid: Math.max(watermark, outcome.highestUid) };
}

/**
 * One line for the UID a pass stopped on when the reason was an omission. Only ids and a code: the
 * UID names no content, and the message that never arrived was never seen at all.
 */
function logOmitted(c, folderId, outcome) {
  if (outcome.stopAtUid == null || outcome.stopReason !== "omitted") return;
  c.log({ event: "uid_omitted", folderId, uid: outcome.stopAtUid, code: "omitted" });
}

/**
 * Rule 1, the first sync: the account's window, in batches, then one state write. An abort writes no
 * state at all (the next run is a first sync again, and the upserts make it idempotent); a pass that
 * stopped on an undeliverable UID writes what it did reach, so it does not fetch the window again.
 * The UIDVALIDITY is stored only when the listing reported one — a positive integer, never a 0 read
 * out of a null — so a server that says nothing leaves the column null; a later pass whose listing
 * DOES report one fills it in (see the state writes in `syncFolder`).
 */
async function firstSync(c, folder, { windowDays, nowMs }) {
  const listing = await listOrThrow(c, folder.path, { sinceDate: nowMs - windowDays * DAY_MS });
  const uidNext = uidNextOf(listing, listing.items);
  const outcome = await storeItems(c, folder, listing.items, { first: true, liveness: true });

  const highestUid = outcome.stopAtUid == null
    ? Math.max(outcome.highestUid, uidNext - 1)
    : Math.max(0, outcome.stopAtUid - 1);
  const patch = {
    highestUid,
    floorUid: outcome.lowestStoredUid ?? uidNext,
    lastSyncedAt: nowMs,
  };
  const uidValidity = uidValidityOf(listing.uidValidity);
  if (uidValidity != null) patch.uidValidity = uidValidity;
  await setFolderSyncState(c.db, folder.id, patch);
  logOmitted(c, folderIdOf(folder), outcome);

  // Nothing is stuck if the window went through clean; a stop keeps its own count for the next pass.
  if (outcome.stopAtUid == null) clearFolderOmitted(folderIdOf(folder));

  return { added: outcome.added };
}

/**
 * Rule 3: flags and expunges by UID, from the floor up. The listing is compared with the UIDVALIDITY
 * this pass already saw; a change here is a mailbox that moved under the pass, so the folder aborts
 * with nothing deleted. Only two positive integers are compared — the stored value and the listed one
 * are both normalised by uidValidityOf, so neither a null nor a 0 the server never sent can look like
 * a change. Rows below the floor are not asked about and never removed.
 *
 * @param {object} c the resolved context
 * @param {object} folder the stored folder row
 * @param {number|null} uidValidity this pass's UIDVALIDITY, a positive integer or null when unknown
 * @returns {Promise<number>} how many rows the expunge scan removed
 */
async function reconcileFlags(c, folder, uidValidity) {
  const folderId = folderIdOf(folder);
  const lo = await minUid(c.db, folderId);
  if (lo == null) return 0;

  const listing = await listOrThrow(c, folder.path, { fromUid: lo });
  const seen = uidValidityOf(listing.uidValidity);
  if (seen != null && uidValidity != null && seen !== uidValidity) {
    throw new MailError("PROTOCOL", "uidvalidity_changed");
  }
  checkDeadline(c);
  await applyFlags(c.db, folderId, listing.items);
  const present = listing.items.map((item) => item.uid);
  return deleteMissing(c.db, folderId, present, { minUid: lo });
}

/**
 * Sync one folder. The result counts what this pass changed: `added` is newly created rows, `removed`
 * is rows the expunge scan dropped, `reset` says a UIDVALIDITY change emptied the folder first.
 *
 * A pass that stops (a UID the adapter never delivered, or a message that could not be stored) still
 * reconciles flags and expunges: that scan only ever touches rows below the watermark, so it can
 * settle what this pass did store without reaching past the hole.
 *
 * @param {object} ctx `{db, adapter, now?, deadlineAt?, log?, yieldFn?}`
 * @param {string} accountId the account the folder belongs to
 * @param {object} folder a mail_folders row as the store returns it
 * @returns {Promise<{added: number, removed: number, reset: boolean}>}
 */
export async function syncFolder(ctx, accountId, folder) {
  const c = contextOf(ctx);
  folderIdOf(folder);
  checkDeadline(c);

  const account = await getAccount(c.db, accountId);
  const windowDays = Number.isInteger(account?.windowDays) && account.windowDays >= 1
    ? account.windowDays
    : DEFAULT_WINDOW_DAYS;
  const nowMs = c.now();
  const counts = { added: 0, removed: 0, reset: false };

  if (isFirstSync(folder)) {
    counts.added = (await firstSync(c, folder, { windowDays, nowMs })).added;
    return counts;
  }

  // Rule 2: everything above the watermark. UIDVALIDITY is compared only once this list succeeded —
  // a listing that failed says nothing about the mailbox — and only when both sides reported a
  // positive integer, because "unknown" is never a change.
  const listing = await listOrThrow(c, folder.path, { afterUid: folder.highestUid });
  const storedValidity = uidValidityOf(folder.uidValidity);
  const listedValidity = uidValidityOf(listing.uidValidity);
  if (storedValidity != null && listedValidity != null && listedValidity !== storedValidity) {
    // Every UID this folder holds means something else now: empty it and start over as a first sync.
    await resetFolder(c.db, folderIdOf(folder), listedValidity);
    // The new epoch's UIDs say nothing about the old one's, so a stuck count left behind would skip a
    // UID of the new epoch on that epoch's first pass. The count starts again from nothing.
    clearFolderOmitted(folderIdOf(folder));
    counts.reset = true;
    const restart = { ...folder, uidValidity: listedValidity, highestUid: 0, floorUid: null };
    counts.added = (await firstSync(c, restart, { windowDays, nowMs })).added;
    return counts;
  }
  const uidValidity = listedValidity ?? storedValidity;
  const uidNext = uidNextOf(listing, listing.items);

  const newItems = listing.items.filter((item) => Number(item.uid) > Number(folder.highestUid));
  const outcome = await storeItems(c, folder, newItems, { first: false, liveness: true });
  counts.added = outcome.added;
  const folderId = folderIdOf(folder);

  // A UIDVALIDITY the listing reported but the column does not hold yet (a first sync ran against a
  // server that stayed quiet) is written by whichever state write this pass makes: once it is known,
  // a later change can be compared against it.
  const validity = listedValidity != null ? { uidValidity: listedValidity } : {};

  if (outcome.stopAtUid != null) {
    // An undeliverable UID (or a store that failed) is where the watermark stops. The rows below it
    // are on disk and the next pass re-lists from here; nothing is ever skipped over. Only ids and a
    // code reach the log line: the uid names no content.
    await setFolderSyncState(c.db, folderId, {
      ...validity,
      highestUid: Math.max(outcome.highestUid, outcome.stopAtUid - 1),
    });
    logOmitted(c, folderId, outcome);
    counts.removed = await reconcileFlags(c, folder, uidValidity);
    return counts;
  }

  await setFolderSyncState(c.db, folderId, {
    ...validity,
    highestUid: Math.max(outcome.highestUid, uidNext - 1),
    lastSyncedAt: nowMs,
  });
  // The pass finished with nothing stuck: no omitted-UID count outlives it.
  clearFolderOmitted(folderId);
  counts.removed = await reconcileFlags(c, folder, uidValidity);
  return counts;
}

/* ------------------------------------------------------------- older history */

/**
 * Continue a folder's history backwards: the `limit` UIDs below `floor_uid`, stored, and the floor
 * lowered to what this call actually handled.
 *
 * Paging is by UID and never by date. INTERNALDATE has one-second resolution, so a whole run of
 * messages can share one date and a date bound would either repeat them or skip them; the UID range is
 * the only bound that walks a mailbox exactly once. The listing is asked for newest-first because that
 * is the shape the adapter offers for a bounded page, and the batches are built ascending from it.
 *
 * The floor is the lower bound of what Crow holds and what the expunge scan starts from, so it only
 * ever moves over a page that was handled whole. A batch stores ascending and STOPS at the first hole
 * — an omitted UID still missing after its one retry, or a message that could not be written — so the
 * UIDs ABOVE that hole in the same page are not stored: a floor of `hole + 1` would claim them, and
 * the expunge scan would then treat "below the floor" as a range it may delete from. Any stop
 * therefore leaves the floor exactly where it was, and the next page re-reads the same range below it
 * (the rows already stored are idempotent upserts, so re-reading costs nothing but bandwidth).
 * Otherwise the floor follows the lowest UID of the page, which with no stop is a UID this call either
 * stored — fetched and stored, or deliberately stored as a `too_large` placeholder — or skipped by the
 * liveness escape below; and it never rises. That escape is the only way past a permanent hole: a UID
 * still missing on the third COUNTED pass is skipped, and the page below it then completes. This read
 * is triggered by a person, so a pass only counts when LIVENESS_MIN_GAP_MS has passed since the last
 * count for that UID (see `noteOmitted`): three quick clicks at a slow message still stop, and the
 * message is never given up on for being slow once.
 * A UID a search stored far below the window lowers nothing, because the range between it and the
 * window is still a hole. Nothing here touches `highest_uid`, `uid_validity`, an existing row or
 * anything else.
 *
 * A listing whose UIDVALIDITY no longer matches the stored one is refused before a single body is
 * fetched: the UIDs mean something else now, and the next regular sync is what resets the folder.
 *
 * @param {object} ctx `{db, adapter, now?, deadlineAt?, log?, yieldFn?}`
 * @param {string} accountId the account the folder belongs to
 * @param {number} folderId a folder of that account
 * @param {{limit?: number}} [options] UIDs to ask for (50 by default)
 * @returns {Promise<{added: number, reachedStart: boolean}>} rows created, and whether the folder's
 *   history is now complete (fewer UIDs came back, or the floor reached the first message)
 */
export async function fetchOlder(ctx, accountId, folderId, { limit = DEFAULT_OLDER_LIMIT } = {}) {
  const c = contextOf(ctx);
  const account = accountIdOf(accountId);
  const wanted = onDemandLimit(limit);
  const id = Number(folderId);
  if (!Number.isInteger(id) || id <= 0) throw new MailError("BAD_INPUT", "folder_id");

  const folder = await getFolder(c.db, id);
  if (!folder || folder.accountId !== account) throw new MailError("NOT_FOUND", "folder");

  const lo = folder.floorUid;
  // Nothing local means nothing to page below: the folder's first sync sets the window and the floor.
  if (lo == null) return { added: 0, reachedStart: true };
  checkDeadline(c);

  const listing = await listOrThrow(c, folder.path, { beforeUid: lo, limit: wanted, newestFirst: true });
  const storedValidity = uidValidityOf(folder.uidValidity);
  const listedValidity = uidValidityOf(listing.uidValidity);
  if (storedValidity != null && listedValidity != null && listedValidity !== storedValidity) {
    throw new MailError("PROTOCOL", "uidvalidity_changed");
  }

  checkDeadline(c);

  // A backfill goes through the same liveness counter a sync pass does: one UID nothing ever delivers
  // must not hold the floor for ever. It counts on its own slower clock, though — this read is a
  // person clicking, and quick repeated clicks at a merely slow message must not skip it.
  const outcome = await storeBatches(c, folder, batchItems(ascending(listing.items)), {
    liveness: true,
    livenessGapMs: LIVENESS_MIN_GAP_MS,
  });

  // A pass that stopped for ANY reason leaves the floor untouched: the UIDs above the hole in this
  // page were never stored, so a floor there would claim rows nothing wrote.
  const stopped = outcome.stopAtUid != null;
  let floorUid = lo;
  if (!stopped) {
    const pageLow = listing.items.reduce((low, item) => (low == null || item.uid < low ? item.uid : low), null);
    if (pageLow != null) floorUid = Math.min(lo, pageLow);
  }
  if (floorUid !== lo) await setFolderSyncState(c.db, folder.id, { floorUid });

  return {
    added: outcome.added,
    reachedStart: !stopped && (listing.items.length < wanted || lo <= 1 || floorUid <= 1),
  };
}

/* ------------------------------------------------------------- remote search */

/**
 * Store what a server-side search found but the window never reached.
 *
 * The adapter answers with `{folderPath, uid}` pairs and no metadata at all, so each hit's body is
 * fetched (batched by count only — SEARCH_BATCH_MAX per get(), because no size is known to bound it by
 * bytes — under the same byte cap, omitted-UID rule and per-message try/catch as a sync) and the row
 * takes its flags, internal date and raw length from what came back; a body that is empty or over
 * MAX_RAW_BYTES is stored as `too_large`. Hits are matched to stored folders by exact path: one this
 * account has not stored is skipped, as is one of the three virtual views, and a UID already local is
 * never fetched again.
 *
 * A hit the adapter never delivers is retried once on its own and then skipped, and the rest of the
 * answer is still stored: a search hit is not a watermark, so one missing body is one missing row,
 * never the folder's reason to stop. The give-up is a log line carrying ids and a count only.
 *
 * A search that throws is classified and rethrown before anything is written, so the store is exactly
 * as it was. Nothing here changes `floor_uid` or `highest_uid`: a hit far below the window is one row,
 * not a contiguous range, and only a backfill (`fetchOlder`) may claim more.
 *
 * @param {object} ctx `{db, adapter, now?, deadlineAt?, log?, yieldFn?}`
 * @param {string} accountId
 * @param {string} query the person's words, passed to the adapter unchanged
 * @param {{limit?: number}} [options] the adapter's own result cap
 * @returns {Promise<{added: number}>} rows created
 */
export async function searchRemote(ctx, accountId, query, { limit } = {}) {
  const c = contextOf(ctx);
  const account = accountIdOf(accountId);
  if (typeof query !== "string" || query.trim() === "") throw new MailError("BAD_INPUT", "query");
  const cap = limit == null ? null : onDemandLimit(limit);
  checkDeadline(c);

  let hits;
  try {
    hits = await c.adapter.search(query, cap == null ? {} : { limit: cap });
  } catch (err) {
    throw toMailError(err);
  }
  if (!Array.isArray(hits)) throw new MailError("PROTOCOL", "search");

  // Folder paths are opaque: matched exactly as the store and the search gave them, never normalised.
  const byPath = new Map();
  for (const folder of await listFolders(c.db, account)) byPath.set(folder.path, folder);

  const pending = new Map();
  const localUids = new Map();
  for (const hit of hits) {
    const path = hit?.folderPath;
    const uid = Number(hit?.uid);
    if (typeof path !== "string" || !Number.isInteger(uid) || uid <= 0) continue;
    const folder = byPath.get(path);
    if (!folder || isSkippedSpecialUse(folder, null)) continue;

    let stored = localUids.get(folder.id);
    if (!stored) {
      stored = new Set(await storedUids(c.db, folder.id));
      localUids.set(folder.id, stored);
    }
    if (stored.has(uid)) continue;
    // A UID the search names twice is fetched once, in the page below.
    stored.add(uid);
    if (!pending.has(folder.id)) pending.set(folder.id, { folder, uids: [] });
    pending.get(folder.id).uids.push(uid);
  }

  let added = 0;
  for (const { folder, uids } of pending.values()) {
    checkDeadline(c);
    // No sizes are known here, so the count is the only bound on a batch.
    const items = ascending(uids.map((uid) => ({ uid })));
    const outcome = await storeBatches(c, folder, batchItems(items, SEARCH_BATCH_MAX), {
      skipOmissions: true,
    });
    added += outcome.added;
    if (outcome.omittedUids.length > 0) {
      // Ids and a count, never a subject or an address: the hit that never arrived was never seen.
      c.log({ event: "search_hit_omitted", folderId: folder.id, count: outcome.omittedUids.length });
    }
  }
  return { added };
}

/**
 * Sync every folder of one account.
 *
 * The folder listing is refreshed first (`upsertFolders` owns which folders may be deleted), then each
 * stored folder the listing still offers — selectable, and not one of the three virtual views — is
 * synced in turn. One folder's own failure is a log line and the next folder still runs; a failure
 * that means the connection itself is unusable, or that the pass ran out of its own time, ends the
 * whole pass instead: the folders after it are abandoned and `last_sync_at` is not stamped, because a
 * pass that stopped early is not a pass that succeeded.
 *
 * @param {object} ctx `{db, adapter, now?, deadlineAt?, log?, yieldFn?}`
 * @param {string} accountId
 * @returns {Promise<{folders: number, added: number}>} folders synced and rows created
 */
export async function syncAccount(ctx, accountId) {
  const c = contextOf(ctx);
  if (typeof accountId !== "string" || accountId === "") throw new MailError("BAD_INPUT", "account_id");
  checkDeadline(c);

  let listing;
  try {
    listing = await c.adapter.listFolders();
  } catch (err) {
    const mailErr = toMailError(err);
    if (endsPass(mailErr)) throw mailErr;
    c.log({ event: "folders_failed", code: mailErr.code });
    return { folders: 0, added: 0 };
  }
  if (!Array.isArray(listing)) {
    c.log({ event: "folders_failed", code: "PROTOCOL" });
    return { folders: 0, added: 0 };
  }
  c.log({ event: "folders_listed", count: listing.length });

  checkDeadline(c);
  const upserted = await upsertFolders(c.db, accountId, listing);
  if (upserted.deleted > 0) c.log({ event: "folders_deleted", count: upserted.deleted });
  if (upserted.deletesRefused) c.log({ event: "deletes_refused" });

  // Folder paths are opaque: matched exactly as the listing and the store gave them, never split or
  // normalised. The entry is what carries `selectable` and the special-use flag the store column
  // may have been refreshed from.
  const byPath = new Map();
  for (const entry of listing) {
    if (entry && typeof entry.path === "string") byPath.set(entry.path, entry);
  }

  let folders = 0;
  let added = 0;
  for (const folder of upserted.folders) {
    const entry = byPath.get(folder.path);
    if (!entry) continue;
    if (entry.selectable === false) continue;
    if (isSkippedSpecialUse(folder, entry)) continue;

    checkDeadline(c);
    try {
      const outcome = await syncFolder(c, accountId, folder);
      folders += 1;
      added += outcome.added;
      c.log({
        event: "folder_synced",
        folderId: folder.id,
        added: outcome.added,
        removed: outcome.removed,
        reset: outcome.reset,
      });
    } catch (err) {
      const mailErr = toMailError(err);
      if (endsPass(mailErr)) throw mailErr;
      c.log({ event: "folder_failed", folderId: folder.id, code: mailErr.code });
    }
  }

  // The stamp is bookkeeping, not a result: an account row that cannot take it changes nothing.
  try {
    await updateAccount(c.db, accountId, { lastSyncAt: c.now() });
  } catch {
    // A BAD_INPUT here would be an account id the caller invented; the pass itself did its work.
  }

  c.log({ event: "sync_done", folders, added });
  return { folders, added };
}