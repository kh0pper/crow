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
 * first sync (the UIDs mean something else now, so nothing may be matched against them).
 *
 * Two behaviours of a real adapter shape the rest. `get()` may omit a UID it was asked for — one
 * expunged between the listing and the body fetch, or one left outside a download budget. An omitted
 * UID is retried once on its own; when it is still missing the pass STOPS there and persists
 * `lowest omitted UID - 1`, because advancing past a UID that was never delivered would lose it
 * forever (the next listing starts above the watermark). The same stop applies when one message
 * cannot be stored. And a message the listing reports above MAX_RAW_BYTES, or one whose bytes come
 * back empty, is stored as a `too_large` placeholder without its bytes ever being held.
 *
 * Everything reaching a log line is a code, a count or an id: a folder path is an opaque string that
 * may carry a mailbox name, and a message's subject, addresses and bytes belong to the sender. An
 * adapter failure aborts its folder with nothing deleted, and only the four failures that end the whole
 * pass (AUTH_FAILED, NETWORK, TLS and a deadline TIMEOUT) travel further than their own folder.
 */
import { MailError, toMailError } from "../errors.js";
import { MAX_RAW_BYTES, parseRawMessage, placeholderMessage } from "../parse.js";
import { getAccount, updateAccount } from "../store/accounts.js";
import {
  applyFlags,
  deleteMissing,
  minUid,
  resetFolder,
  setFolderSyncState,
  upsertFolders,
  upsertMessage,
} from "../store/messages.js";

/** UIDs per get() call, however small the messages are. */
export const SYNC_BATCH_MAX = 25;

/** Raw bytes per get() call, counted from the sizes the listing reported. */
export const SYNC_BATCH_BYTES = 16 * 1024 * 1024;

/**
 * Virtual folders a server lists but that are views of mail already synced in a real folder: syncing
 * one would store every message a second time. Exactly these three, compared case-insensitively.
 */
export const SKIP_SPECIAL_USE = Object.freeze(["\\All", "\\Flagged", "\\Important"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;

/** The skipped three, lower-cased once: a special-use flag is case-insensitive (RFC 6154). */
const SKIPPED_SPECIAL_USE = new Set(SKIP_SPECIAL_USE.map((flag) => flag.toLowerCase()));

/** The codes that end the whole pass when the folder LISTING itself fails. */
const PASS_ENDING_CODES = new Set(["AUTH_FAILED", "NETWORK", "TLS", "TIMEOUT"]);

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
 * @returns {object[][]} batches
 */
function batchItems(items) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && (current.length >= SYNC_BATCH_MAX || bytes + size > SYNC_BATCH_BYTES)) {
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

/* ------------------------------------------------------------------ the pass */

/**
 * Fetch and store one listing's items, and keep the watermark moving while it does.
 *
 * A batch is built from the reported sizes, its oversized members are stored without a get(), and
 * everything else is fetched and stored one message at a time in UID order — each message in its own
 * try/catch, because a hostile message must never take its folder with it. A completed batch of a
 * later sync persists its own highest UID, so an interruption leaves progress rather than work to
 * redo. An omitted UID (after its one retry) or a failed store stops the pass at that UID.
 *
 * @param {object} c the resolved context
 * @param {object} folder the stored folder row
 * @param {object[]} items the listing's items
 * @param {{first: boolean}} options a first sync writes its state once, at the end
 * @returns {Promise<{added: number, stopAtUid: number|null, lowestStoredUid: number|null,
 *                    highestUid: number}>}
 */
async function storeItems(c, folder, items, { first }) {
  const folderId = folderIdOf(folder);
  let added = 0;
  let lowestStoredUid = null;
  let stopAtUid = null;
  let highestUid = Math.max(0, Number(folder.highestUid) || 0);

  for (const batch of batchItems(ascending(items))) {
    checkDeadline(c);

    // The bytes of each batch member, by UID. A message the listing reports above MAX_RAW_BYTES is
    // here already, marked so: its body is never asked for, and it is stored as too_large.
    const delivered = new Map();
    const wanted = [];
    for (const item of batch) {
      if (sizeOf(item) > MAX_RAW_BYTES) delivered.set(item.uid, { item, tooLarge: true });
      else wanted.push(item);
    }

    if (wanted.length > 0) {
      const got = new Map();
      for (const message of await getOrThrow(c, folder.path, wanted.map((item) => item.uid))) {
        if (!got.has(message.uid)) got.set(message.uid, message);
      }
      // A UID the first get() left out gets exactly one more call on its own: an expunged message
      // simply stays absent, and one the adapter merely did not reach usually arrives here.
      for (const item of wanted) {
        if (got.has(item.uid)) continue;
        checkDeadline(c);
        const again = await getOrThrow(c, folder.path, [item.uid]);
        const found = again.find((message) => message.uid === item.uid);
        if (found) got.set(item.uid, found);
      }
      for (const item of wanted) {
        const message = got.get(item.uid);
        if (message) delivered.set(item.uid, { item, message });
        else if (stopAtUid == null || item.uid < stopAtUid) stopAtUid = item.uid;
      }
    }

    for (const item of batch) {
      // Nothing above the lowest UID this pass could not deliver is stored: the next sync re-lists
      // from the watermark and picks it up, and a hole in the folder is what the rule avoids.
      if (stopAtUid != null && item.uid >= stopAtUid) break;
      checkDeadline(c);
      const entry = delivered.get(item.uid);
      if (!entry) continue;
      // Between messages, so a large arrival can never hold the event loop for the whole folder.
      await c.yieldFn();

      try {
        const raw = entry.tooLarge ? null : entry.message?.raw;
        // An empty body is how the adapter reports a message above the raw cap, so it is a too_large
        // row too — never an empty message that reads as one the sender left blank.
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
        if (stopAtUid == null || item.uid < stopAtUid) stopAtUid = item.uid;
        break;
      }
    }

    if (stopAtUid != null) break;

    const batchTop = batch[batch.length - 1].uid;
    if (batchTop > highestUid) highestUid = batchTop;
    // Fine-grained progress is what makes an interrupted arrival cheap: only a later sync writes it,
    // because a first sync's state is written once so that an aborted one starts over cleanly.
    if (!first) await setFolderSyncState(c.db, folderId, { highestUid });
  }

  return { added, stopAtUid, lowestStoredUid, highestUid };
}

/**
 * Rule 1, the first sync: the account's window, in batches, then one state write. An abort writes no
 * state at all (the next run is a first sync again, and the upserts make it idempotent); a pass that
 * stopped on an undeliverable UID writes what it did reach, so it does not fetch the window again.
 */
async function firstSync(c, folder, { windowDays, nowMs }) {
  const listing = await listOrThrow(c, folder.path, { sinceDate: nowMs - windowDays * DAY_MS });
  const uidNext = uidNextOf(listing, listing.items);
  const outcome = await storeItems(c, folder, listing.items, { first: true });

  const highestUid = outcome.stopAtUid == null
    ? Math.max(outcome.highestUid, uidNext - 1)
    : Math.max(0, outcome.stopAtUid - 1);
  const patch = {
    highestUid,
    floorUid: outcome.lowestStoredUid ?? uidNext,
    lastSyncedAt: nowMs,
  };
  const uidValidity = Number(listing.uidValidity);
  if (Number.isInteger(uidValidity)) patch.uidValidity = uidValidity;
  await setFolderSyncState(c.db, folder.id, patch);

  return { added: outcome.added };
}

/**
 * Rule 3: flags and expunges by UID, from the floor up. The listing is compared with the UIDVALIDITY
 * this pass already saw; a change here is a mailbox that moved under the pass, so the folder aborts
 * with nothing deleted. Rows below the floor are not asked about and never removed.
 *
 * @returns {Promise<number>} how many rows the expunge scan removed
 */
async function reconcileFlags(c, folder, uidValidity) {
  const folderId = folderIdOf(folder);
  const lo = await minUid(c.db, folderId);
  if (lo == null) return 0;

  const listing = await listOrThrow(c, folder.path, { fromUid: lo });
  const seen = Number(listing.uidValidity);
  if (Number.isInteger(seen) && Number.isInteger(uidValidity) && seen !== uidValidity) {
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
  // a listing that failed says nothing about the mailbox.
  const listing = await listOrThrow(c, folder.path, { afterUid: folder.highestUid });
  const storedValidity = Number(folder.uidValidity);
  const listedValidity = Number(listing.uidValidity);
  if (Number.isInteger(storedValidity) && Number.isInteger(listedValidity) && listedValidity !== storedValidity) {
    // Every UID this folder holds means something else now: empty it and start over as a first sync.
    await resetFolder(c.db, folderIdOf(folder), listedValidity);
    counts.reset = true;
    const restart = { ...folder, uidValidity: listedValidity, highestUid: 0, floorUid: null };
    counts.added = (await firstSync(c, restart, { windowDays, nowMs })).added;
    return counts;
  }
  const uidValidity = Number.isInteger(listedValidity) ? listedValidity : storedValidity;
  const uidNext = uidNextOf(listing, listing.items);

  const newItems = listing.items.filter((item) => Number(item.uid) > Number(folder.highestUid));
  const outcome = await storeItems(c, folder, newItems, { first: false });
  counts.added = outcome.added;

  if (outcome.stopAtUid != null) {
    // An undeliverable UID (or a store that failed) is where the watermark stops. The rows below it
    // are on disk and the next pass re-lists from here; nothing is ever skipped over.
    await setFolderSyncState(c.db, folderIdOf(folder), {
      highestUid: Math.max(outcome.highestUid, outcome.stopAtUid - 1),
    });
    return counts;
  }

  await setFolderSyncState(c.db, folderIdOf(folder), {
    highestUid: Math.max(outcome.highestUid, uidNext - 1),
    lastSyncedAt: nowMs,
  });
  counts.removed = await reconcileFlags(c, folder, uidValidity);
  return counts;
}

/**
 * Sync every folder of one account.
 *
 * The folder listing is refreshed first (`upsertFolders` owns which folders may be deleted), then each
 * stored folder the listing still offers — selectable, and not one of the three virtual views — is
 * synced in turn. One folder's failure is a log line and the next folder still runs; only the four
 * codes that mean the connection itself is unusable (and this pass's own deadline) travel further.
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
    if (PASS_ENDING_CODES.has(mailErr.code)) throw mailErr;
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
      if (PASS_ENDING_CODES.has(mailErr.code) && mailErr.detail === "sync_deadline") throw mailErr;
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