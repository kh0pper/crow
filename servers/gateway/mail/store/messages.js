/**
 * Crow Mail's folder and message store: mail_folders, mail_messages, the mail_messages_fts index over
 * them, and the keyset paging and search the reader asks for. Local-only tables, never synced.
 *
 * Two rules shape everything here.
 *
 * 1. A row that keeps its uid is written with `INSERT ... ON CONFLICT(folder_id, uid) DO UPDATE`,
 *    never `INSERT OR REPLACE` / `REPLACE` and never a DELETE + INSERT. recursive_triggers is off, so
 *    REPLACE's implicit DELETE does not fire mail_messages_ad and the replaced row's terms stay in the
 *    FTS index pointing at a rowid the content table no longer has (the schema header explains it).
 *
 * 2. The same message in several folders (a Gmail label copy) is ONE logical message. Search and
 *    thread counts dedupe by (account_id, message_id) with a null id counting alone, and search
 *    returns the newest row of each group. A folder's counts dedupe within that folder, so a folder
 *    counts exactly what it lists; its message list still shows every row it holds.
 *
 * Read-then-write units (allocating a thread id, detecting `created`, collecting the threads a delete
 * touched) run in db.runTransaction: one synchronous transaction on one connection, no await in the
 * middle (servers/db.js). Statements that only follow a write — the exported refreshThreadCounts, the
 * per-folder resync — run after that transaction.
 */
import { MailError } from "../errors.js";
import { assignThread, refreshThreadCounts } from "../thread-key.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A parsed Date this far from the server's internal date is the sender's, not the server's: the
 *  server's is used instead (a hostile 1970 or 2099 Date header must not reorder the mailbox). */
const DATE_WINDOW_MS = 2 * DAY_MS;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** Below this many local folders a listing may delete folders it omits (a handful of folders is not
 *  a mailbox that half-disappeared). Above it, at least half the local folders must be listed. */
const MIN_FOLDERS_FOR_DELETE = 4;

/** toFtsQuery: at most this many terms, each cut to this many characters. */
const MAX_FTS_TOKENS = 8;
const MAX_FTS_TOKEN_CHARS = 64;

export const FOLDER_ROLES = Object.freeze(["inbox", "sent", "drafts", "trash", "spam", "archive", "other"]);

const FOLDER_COLUMNS = `id, account_id, path, name, special_use, delimiter, uid_validity, highest_uid,
  floor_uid, last_synced_at`;

const SUMMARY_COLUMNS = `id, account_id, folder_id, thread_id, message_id, from_name, from_addr,
  subject, snippet, date, is_read, has_attachments`;

const SPECIAL_USE_ROLES = new Map([
  ["\\sent", "sent"],
  ["\\drafts", "drafts"],
  ["\\trash", "trash"],
  ["\\junk", "spam"],
  ["\\spam", "spam"],
  ["\\archive", "archive"],
]);

/** Fallbacks by folder name, for a server that reports no special-use flag. */
const NAME_ROLES = Object.freeze([
  [/^(?:inbox)$/, "inbox"],
  [/^(?:sent|sent items|sent messages|sent mail|sentmail)$/, "sent"],
  [/^(?:drafts?|draft messages)$/, "drafts"],
  [/^(?:trash|deleted|deleted items|deleted messages|bin)$/, "trash"],
  [/^(?:junk|junk email|junk e-?mail|spam|bulk mail)$/, "spam"],
  [/^(?:archive|archives)$/, "archive"],
]);

function fail(field) {
  throw new MailError("BAD_INPUT", field);
}

const rowsOf = (run, sql, args) => run({ sql, args }).rows;

function positiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(field);
  return n;
}

function accountIdOf(value, field = "account_id") {
  if (typeof value !== "string" || !value || value.length > 80) fail(field);
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function limitOf(value) {
  if (value == null) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** `\Seen` in any case: an IMAP flag list, or the string a caller kept. */
function hasSeen(flags) {
  return Array.isArray(flags) && flags.some((flag) => typeof flag === "string" && flag.toLowerCase() === "\\seen");
}

/**
 * `flags_json` with `\Seen` added (read) or removed (unread), the other flags kept in order. A row
 * whose flags were never written is tolerated: marking it read writes `["\\Seen"]`, marking it unread
 * leaves the null as it was.
 */
function flagsForRead(flagsJson, isRead) {
  if ((flagsJson == null || flagsJson === "") && !isRead) return flagsJson ?? null;
  const parsed = parseJson(flagsJson, []);
  const flags = (Array.isArray(parsed) ? parsed : []).filter((flag) => typeof flag === "string");
  const seen = flags.some((flag) => flag.toLowerCase() === "\\seen");
  if (isRead === seen) return JSON.stringify(flags);
  return JSON.stringify(isRead ? [...flags, "\\Seen"] : flags.filter((flag) => flag.toLowerCase() !== "\\seen"));
}

function parseJson(text, fallback) {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/* ---------------------------------------------------------------------- folders */

/**
 * Which well-known folder this is, from its path (INBOX), its special-use flag, or its name. `\\All`,
 * `\\Flagged` and `\\Important` are virtual folders with no role of their own — they are "other".
 */
export function folderRole(folder) {
  if (!folder || typeof folder !== "object") return "other";
  const path = typeof folder.path === "string" ? folder.path.trim() : "";
  if (path.toLowerCase() === "inbox") return "inbox";

  const specialUse = folder.specialUse ?? folder.special_use;
  if (typeof specialUse === "string") {
    for (const token of specialUse.split(/\s+/)) {
      const role = SPECIAL_USE_ROLES.get(token.trim().toLowerCase());
      if (role) return role;
    }
  }

  const name = typeof folder.name === "string" && folder.name.trim() !== ""
    ? folder.name.trim()
    : (lastPathSegment(folder) ?? "");
  const lower = name.toLowerCase();
  for (const [pattern, role] of NAME_ROLES) if (pattern.test(lower)) return role;
  return "other";
}

/** The name a folder is known by when the server sent none: the last segment of its path, split on
 *  its own delimiter when it declared one. */
function lastPathSegment(folder) {
  const path = typeof folder.path === "string" ? folder.path.trim() : "";
  const delimiter = typeof folder.delimiter === "string" && folder.delimiter !== "" ? folder.delimiter : null;
  const parts = delimiter ? path.split(delimiter) : path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function rowToFolder(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: row.account_id,
    path: row.path,
    name: row.name ?? null,
    specialUse: row.special_use ?? null,
    delimiter: row.delimiter ?? null,
    uidValidity: row.uid_validity == null ? null : Number(row.uid_validity),
    highestUid: Number(row.highest_uid),
    floorUid: row.floor_uid == null ? null : Number(row.floor_uid),
    lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
    role: folderRole(row),
  };
}

function folderName(folder) {
  if (typeof folder.name === "string" && folder.name.trim() !== "") return folder.name.trim();
  return lastPathSegment(folder) || String(folder.path);
}

const UPSERT_FOLDER_SQL = `INSERT INTO mail_folders (account_id, path, name, special_use, delimiter)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(account_id, path) DO UPDATE SET
    name = excluded.name, special_use = excluded.special_use, delimiter = excluded.delimiter`;

const SELECT_FOLDERS_SQL = `SELECT ${FOLDER_COLUMNS} FROM mail_folders WHERE account_id = ? ORDER BY path`;

/**
 * How many logical messages each folder holds, and how many of them are unread.
 *
 * The dedupe is per folder: a message re-delivered into one folder under several uids (the same
 * message_id) is counted once there, and a Gmail label copy in another folder is counted in that
 * folder too, so a folder's counts describe exactly the rows it lists. A row with no message_id
 * groups alone. Cross-folder dedupe stays where the reader is a mailbox-wide view (search) or a
 * conversation (mail_threads).
 */
const FOLDER_COUNTS_SQL = `
  SELECT folder_id,
         COUNT(*) AS total,
         SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
    FROM (
      SELECT folder_id, is_read,
             ROW_NUMBER() OVER (
               PARTITION BY folder_id,
                 CASE WHEN message_id IS NULL THEN 'row:' || id ELSE 'msg:' || message_id END
               ORDER BY date DESC, id DESC) AS rn
        FROM mail_messages
       WHERE account_id = ?
    )
   WHERE rn = 1
   GROUP BY folder_id`;

/** Drop one folder's messages (the FTS trigger follows), its row, and any thread left empty. The
 *  thread ids come back so the survivors' counts can be refreshed after the transaction. */
function dropFolder(run, folder) {
  const threadIds = rowsOf(run,
    `SELECT DISTINCT thread_id FROM mail_messages
      WHERE folder_id = ? AND thread_id IS NOT NULL`, [folder.id])
    .map((r) => Number(r.thread_id));
  run({ sql: "DELETE FROM mail_messages WHERE folder_id = ?", args: [folder.id] });
  run({ sql: "DELETE FROM mail_folders WHERE id = ?", args: [folder.id] });
  for (const threadId of new Set(threadIds)) {
    const left = Number(rowsOf(run, "SELECT COUNT(*) AS n FROM mail_messages WHERE thread_id = ?",
      [threadId])[0].n);
    if (left === 0) run({ sql: "DELETE FROM mail_threads WHERE id = ?", args: [threadId] });
  }
  return threadIds;
}

/** Refresh the counts of the threads a write touched, skipping ids that are not positive. */
async function refreshThreads(db, threadIds) {
  const seen = new Set();
  for (const value of threadIds) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    await refreshThreadCounts(db, id);
  }
}

/**
 * Make the local folder rows match one listing. Folders the listing omits are deleted — with their
 * messages, their FTS entries and any thread left empty — but only when the listing is trustworthy:
 * it must contain an inbox-role folder, and either the mailbox is small (fewer than four local
 * folders) or at least half the local folders are listed. Otherwise an IMAP hiccup that returns a
 * partial LIST cannot wipe the mailbox: new folders are added, nothing is removed, and
 * `deletesRefused` says so.
 *
 * The sync columns (uid_validity, highest_uid, floor_uid, last_synced_at) are never touched here.
 *
 * @returns {Promise<{folders: object[], deleted: number, deletesRefused: boolean}>}
 */
export async function upsertFolders(db, accountId, folders = []) {
  const id = accountIdOf(accountId);
  const listing = Array.isArray(folders)
    ? folders.filter((folder) => folder && typeof folder.path === "string" && folder.path.trim() !== "")
    : [];

  const outcome = await db.runTransaction((run) => {
    const local = rowsOf(run, SELECT_FOLDERS_SQL, [id]);
    const listedPaths = new Set(listing.map((folder) => folder.path));
    const missing = local.filter((folder) => !listedPaths.has(folder.path));
    const listedLocal = local.filter((folder) => listedPaths.has(folder.path)).length;
    const hasInbox = listing.some((folder) => folderRole(folder) === "inbox");
    const mayDelete = hasInbox
      && (local.length < MIN_FOLDERS_FOR_DELETE || listedLocal * 2 >= local.length);

    let deleted = 0;
    const threadIds = [];
    if (mayDelete) {
      for (const folder of missing) {
        threadIds.push(...dropFolder(run, folder));
        deleted += 1;
      }
    }

    for (const folder of listing) {
      run({
        sql: UPSERT_FOLDER_SQL,
        args: [
          id,
          folder.path,
          folderName(folder),
          typeof folder.specialUse === "string" && folder.specialUse !== "" ? folder.specialUse : null,
          typeof folder.delimiter === "string" && folder.delimiter !== "" ? folder.delimiter : null,
        ],
      });
    }
    return {
      folders: rowsOf(run, SELECT_FOLDERS_SQL, [id]),
      deleted,
      deletesRefused: !mayDelete && missing.length > 0,
      threadIds,
    };
  });

  await refreshThreads(db, outcome.threadIds);
  return {
    folders: outcome.folders.map(rowToFolder),
    deleted: outcome.deleted,
    deletesRefused: outcome.deletesRefused,
  };
}

/** Every folder of one account, with unread and total counts deduped within each folder. */
export async function listFolders(db, accountId) {
  const id = accountIdOf(accountId);
  const { rows } = await db.execute({ sql: SELECT_FOLDERS_SQL, args: [id] });
  const counts = new Map();
  const { rows: counted } = await db.execute({ sql: FOLDER_COUNTS_SQL, args: [id] });
  for (const row of counted) {
    counts.set(Number(row.folder_id), {
      total: Number(row.total),
      unread: Number(row.unread ?? 0),
    });
  }
  return rows.map((row) => {
    const folder = rowToFolder(row);
    const count = counts.get(folder.id);
    return { ...folder, unreadCount: count?.unread ?? 0, totalCount: count?.total ?? 0 };
  });
}

/** One folder row, or null. */
export async function getFolder(db, id) {
  const folderId = Number(id);
  if (!Number.isInteger(folderId) || folderId <= 0) return null;
  const { rows } = await db.execute({ sql: `SELECT ${FOLDER_COLUMNS} FROM mail_folders WHERE id = ?`, args: [folderId] });
  return rowToFolder(rows[0]);
}

const SYNC_STATE_FIELDS = new Set(["uidValidity", "highestUid", "floorUid", "lastSyncedAt"]);

/**
 * Write the sync bookkeeping of one folder. `floorUid` may be null (nothing synced yet); the others
 * are non-negative integers. Returns the updated folder, or null when the id names no row.
 */
export async function setFolderSyncState(db, id, patch = {}) {
  const folderId = positiveInt(id, "folder_id");
  for (const key of Object.keys(patch || {})) if (!SYNC_STATE_FIELDS.has(key)) fail("field");

  const sets = [];
  const args = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const column = {
      uidValidity: "uid_validity", highestUid: "highest_uid", floorUid: "floor_uid", lastSyncedAt: "last_synced_at",
    }[key];
    let stored;
    if (key === "floorUid" && value == null) stored = null;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) fail("field");
      stored = n;
    }
    sets.push(`${column} = ?`);
    args.push(stored);
  }
  if (!sets.length) return getFolder(db, folderId);
  args.push(folderId);
  await db.execute({ sql: `UPDATE mail_folders SET ${sets.join(", ")} WHERE id = ?`, args });
  return getFolder(db, folderId);
}

/**
 * A UIDVALIDITY reset: every UID the folder held now means something else, so the messages go (the
 * FTS trigger forgets them), threads left empty go, and the UID bookkeeping starts over — highest_uid
 * 0 and floor_uid NULL, which is what makes the engine run its first-sync rule again.
 *
 * @returns {Promise<{messages: number, deletedThreads: number}>}
 */
export async function resetFolder(db, id, newUidValidity) {
  const folderId = positiveInt(id, "folder_id");
  const validity = newUidValidity == null ? null : Number(newUidValidity);
  if (validity !== null && (!Number.isInteger(validity) || validity < 0)) fail("uid_validity");

  const outcome = await db.runTransaction((run) => {
    const folder = rowsOf(run, `SELECT ${FOLDER_COLUMNS} FROM mail_folders WHERE id = ?`, [folderId])[0];
    if (!folder) return { messages: 0, deletedThreads: 0, threadIds: [] };

    const threadIds = rowsOf(run,
      `SELECT DISTINCT thread_id FROM mail_messages
        WHERE folder_id = ? AND thread_id IS NOT NULL`, [folderId])
      .map((r) => Number(r.thread_id));
    const removed = Number(rowsOf(run, "SELECT COUNT(*) AS n FROM mail_messages WHERE folder_id = ?",
      [folderId])[0].n);
    run({ sql: "DELETE FROM mail_messages WHERE folder_id = ?", args: [folderId] });

    const surviving = [];
    let deletedThreads = 0;
    for (const threadId of new Set(threadIds)) {
      const left = Number(rowsOf(run, "SELECT COUNT(*) AS n FROM mail_messages WHERE thread_id = ?",
        [threadId])[0].n);
      if (left === 0) {
        run({ sql: "DELETE FROM mail_threads WHERE id = ? AND account_id = ?", args: [threadId, folder.account_id] });
        deletedThreads += 1;
      } else {
        surviving.push(threadId);
      }
    }

    run({
      sql: "UPDATE mail_folders SET uid_validity = ?, highest_uid = 0, floor_uid = NULL WHERE id = ?",
      args: [validity, folderId],
    });
    return { messages: removed, deletedThreads, threadIds: surviving };
  });

  await refreshThreads(db, outcome.threadIds);
  return { messages: outcome.messages, deletedThreads: outcome.deletedThreads };
}

/* --------------------------------------------------------------------- messages */

/**
 * The date a message is stored under: the sender's Date header when it is within two days of the
 * server's INTERNALDATE, and the server's own date otherwise. A missing or wildly wrong Date header
 * must not sort a message into 1970 or 2099, and the server's date is the one the mailbox sorts by.
 * Exported so a caller can compute the date a row would get without storing one.
 */
export function storedDate(parsedDate, internalDate) {
  const internal = Number.isFinite(internalDate) ? Number(internalDate) : null;
  const parsed = Number.isFinite(parsedDate) ? Number(parsedDate) : null;
  if (parsed === null) return internal ?? Date.now();
  if (internal === null) return parsed;
  return Math.abs(parsed - internal) <= DATE_WINDOW_MS ? parsed : internal;
}

/** `{name, address}` entries with string fields and lower-cased addresses. */
function addressArray(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    out.push({
      name: typeof entry.name === "string" ? entry.name : "",
      address: typeof entry.address === "string" ? entry.address.trim().toLowerCase() : "",
    });
  }
  return out;
}

/** "name address", or whichever half exists — the searchable text of one address. */
function addressText(entry) {
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const address = typeof entry.address === "string" ? entry.address.trim().toLowerCase() : "";
  if (name && address) return `${name} ${address}`;
  return name || address;
}

/** One write of a message row, keyed on (folder_id, uid). A real UPDATE on conflict, never REPLACE:
 *  the FTS update trigger then re-indexes the four searchable columns (see the module header). */
const UPSERT_MESSAGE_SQL = `INSERT INTO mail_messages
    (account_id, folder_id, uid, thread_id, message_id, in_reply_to, references_json, subject,
     from_name, from_addr, from_text, to_json, cc_json, reply_to_json, to_text, date, flags_json,
     is_read, has_attachments, attachments_json, snippet, body_text, body_html, truncated, parse_error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(folder_id, uid) DO UPDATE SET
    account_id = excluded.account_id,
    thread_id = excluded.thread_id,
    message_id = excluded.message_id,
    in_reply_to = excluded.in_reply_to,
    references_json = excluded.references_json,
    subject = excluded.subject,
    from_name = excluded.from_name,
    from_addr = excluded.from_addr,
    from_text = excluded.from_text,
    to_json = excluded.to_json,
    cc_json = excluded.cc_json,
    reply_to_json = excluded.reply_to_json,
    to_text = excluded.to_text,
    date = excluded.date,
    flags_json = excluded.flags_json,
    is_read = excluded.is_read,
    has_attachments = excluded.has_attachments,
    attachments_json = excluded.attachments_json,
    snippet = excluded.snippet,
    body_text = excluded.body_text,
    body_html = excluded.body_html,
    truncated = excluded.truncated,
    parse_error = excluded.parse_error`;

const MESSAGE_BY_FOLDER_UID_SQL = "SELECT id, thread_id FROM mail_messages WHERE folder_id = ? AND uid = ?";
const MESSAGE_COLUMNS = `id, account_id, folder_id, uid, thread_id, message_id, in_reply_to,
  references_json, subject, from_name, from_addr, from_text, to_json, cc_json, reply_to_json, to_text,
  date, flags_json, is_read, has_attachments, attachments_json, snippet, body_text, body_html,
  truncated, parse_error`;

function rowToSummary(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: row.account_id,
    folderId: Number(row.folder_id),
    threadId: row.thread_id == null ? null : Number(row.thread_id),
    messageId: row.message_id ?? null,
    fromName: row.from_name ?? null,
    fromAddr: row.from_addr ?? null,
    subject: row.subject ?? "",
    snippet: row.snippet ?? "",
    date: Number(row.date),
    isRead: Boolean(row.is_read),
    hasAttachments: Boolean(row.has_attachments),
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: row.account_id,
    folderId: Number(row.folder_id),
    uid: Number(row.uid),
    threadId: row.thread_id == null ? null : Number(row.thread_id),
    messageId: row.message_id ?? null,
    inReplyTo: row.in_reply_to ?? null,
    references: parseJson(row.references_json, []),
    subject: row.subject ?? "",
    fromName: row.from_name ?? null,
    fromAddr: row.from_addr ?? null,
    fromText: row.from_text ?? "",
    to: parseJson(row.to_json, []),
    cc: parseJson(row.cc_json, []),
    replyTo: parseJson(row.reply_to_json, []),
    toText: row.to_text ?? "",
    date: Number(row.date),
    flags: parseJson(row.flags_json, []),
    isRead: Boolean(row.is_read),
    hasAttachments: Boolean(row.has_attachments),
    attachments: parseJson(row.attachments_json, []),
    snippet: row.snippet ?? "",
    bodyText: row.body_text ?? "",
    bodyHtml: row.body_html ?? null,
    truncated: Boolean(row.truncated),
    parseError: row.parse_error ?? null,
  };
}

/**
 * Store one synced message. The thread is assigned first (assignThread may merge threads, which is
 * its own transaction), then the row is written and the thread's counts are recomputed. A re-upsert
 * that moves the row to a different thread (another message_id at the same uid) drops the thread it
 * left when the write emptied it, and refreshes its counts when it did not.
 *
 * `created` is true only for the first write of a (folder, uid): the row is read inside the same
 * transaction as the upsert, so the answer cannot come from a read that raced another writer.
 *
 * @param {object} db a client with runTransaction (servers/db.js)
 * @param {object} stored a ParsedMessage plus {accountId, folderId, uid, flags, internalDate,
 *   parseError?}
 * @returns {Promise<{id: number, threadId: number, created: boolean}>}
 */
export async function upsertMessage(db, stored = {}) {
  const accountId = accountIdOf(stored.accountId);
  const folderId = positiveInt(stored.folderId, "folder_id");
  const uid = positiveInt(stored.uid, "uid");

  const internalDate = Number.isFinite(stored.internalDate) ? Number(stored.internalDate) : null;
  const date = storedDate(stored.date, internalDate);
  const messageId = optionalString(stored.messageId);
  const inReplyTo = optionalString(stored.inReplyTo);
  const references = Array.isArray(stored.references)
    ? stored.references.filter((ref) => typeof ref === "string" && ref !== "")
    : [];
  const subject = typeof stored.subject === "string" ? stored.subject : "";

  const from = stored.from && typeof stored.from === "object" ? stored.from : null;
  const fromAddr = from && typeof from.address === "string" && from.address.trim() !== ""
    ? from.address.trim().toLowerCase()
    : null;
  const fromName = from && typeof from.name === "string" && from.name.trim() !== ""
    ? from.name.trim()
    : null;
  const to = addressArray(stored.to);
  const cc = addressArray(stored.cc);
  const replyTo = addressArray(stored.replyTo);
  const fromText = addressText({ name: fromName ?? "", address: fromAddr ?? "" });
  const toText = [...to, ...cc].map(addressText).filter(Boolean).join(" ");

  const flags = Array.isArray(stored.flags) ? stored.flags.filter((flag) => typeof flag === "string") : [];
  const attachments = Array.isArray(stored.attachments) ? stored.attachments : [];

  const threadId = await assignThread(db, accountId, {
    messageId,
    inReplyTo,
    references,
    subject,
    date,
    participants: [fromAddr ?? "", ...to.map((a) => a.address), ...cc.map((a) => a.address)].filter(Boolean),
  });

  const written = await db.runTransaction((run) => {
    const previous = rowsOf(run, MESSAGE_BY_FOLDER_UID_SQL, [folderId, uid])[0];
    run({
      sql: UPSERT_MESSAGE_SQL,
      args: [
        accountId, folderId, uid, threadId, messageId, inReplyTo, JSON.stringify(references), subject,
        fromName, fromAddr, fromText, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(replyTo),
        toText, date, JSON.stringify(flags), hasSeen(flags) ? 1 : 0, attachments.length > 0 ? 1 : 0,
        JSON.stringify(attachments),
        typeof stored.snippet === "string" ? stored.snippet : "",
        typeof stored.text === "string" ? stored.text : "",
        typeof stored.html === "string" ? stored.html : null,
        stored.truncated ? 1 : 0,
        optionalString(stored.parseError),
      ],
    });
    const id = previous
      ? Number(previous.id)
      : Number(rowsOf(run, MESSAGE_BY_FOLDER_UID_SQL, [folderId, uid])[0].id);
    // A row that moved to another thread leaves the old one behind: delete it when the write left
    // it empty, otherwise hand it back so its counts are recomputed after the transaction.
    let survivingPreviousThreadId = null;
    if (previous?.thread_id != null) {
      const previousThreadId = Number(previous.thread_id);
      if (previousThreadId !== threadId) {
        const left = Number(rowsOf(run, "SELECT COUNT(*) AS n FROM mail_messages WHERE thread_id = ?",
          [previousThreadId])[0].n);
        if (left === 0) run({ sql: "DELETE FROM mail_threads WHERE id = ?", args: [previousThreadId] });
        else survivingPreviousThreadId = previousThreadId;
      }
    }
    return { id, created: !previous, survivingPreviousThreadId };
  });

  await refreshThreads(db, [threadId, written.survivingPreviousThreadId]);
  return { id: written.id, threadId, created: written.created };
}

/**
 * The rows that are the same message as `row`: the row itself plus every row of the same account with
 * the same non-null message_id, the same sender address and the same stored date, in another folder.
 * Message-ID alone is sender-controlled and can be reused, so it is never the only test. This is the
 * one definition of "the same message in several folders" that plan 2's actions use.
 *
 * @returns {Promise<object[]>} full message rows, the row first, copies after it
 */
export async function copyRows(db, row) {
  const id = Number(row?.id);
  if (!Number.isInteger(id) || id <= 0) return [];
  const { rows: own } = await db.execute({ sql: `SELECT ${MESSAGE_COLUMNS} FROM mail_messages WHERE id = ?`, args: [id] });
  const self = own[0];
  if (!self) return [];
  const out = [rowToMessage(self)];
  if (!self.message_id) return out;
  const { rows: others } = await db.execute({
    sql: `SELECT ${MESSAGE_COLUMNS} FROM mail_messages
           WHERE account_id = ? AND message_id = ? AND from_addr IS ? AND date = ?
             AND folder_id <> ? AND id <> ?
           ORDER BY folder_id, id`,
    args: [self.account_id, self.message_id, self.from_addr, self.date, self.folder_id, self.id],
  });
  return out.concat(others.map(rowToMessage));
}

/**
 * Remove one stored message: the row (the FTS delete trigger follows it), the thread if that left it
 * empty, and the thread's counts if it did not. The folder's counts are computed on read, so there is
 * nothing stored to update for them.
 */
export async function deleteMessageRow(db, id) {
  const target = Number(id);
  if (!Number.isInteger(target) || target <= 0) return;

  const outcome = await db.runTransaction((run) => {
    const found = rowsOf(run, "SELECT thread_id FROM mail_messages WHERE id = ?", [target])[0];
    if (!found) return null;
    run({ sql: "DELETE FROM mail_messages WHERE id = ?", args: [target] });
    if (found.thread_id == null) return { threadId: null, dropped: false };
    const threadId = Number(found.thread_id);
    const left = Number(rowsOf(run, "SELECT COUNT(*) AS n FROM mail_messages WHERE thread_id = ?",
      [threadId])[0].n);
    if (left === 0) run({ sql: "DELETE FROM mail_threads WHERE id = ?", args: [threadId] });
    return { threadId, dropped: left === 0 };
  });

  if (outcome && outcome.threadId !== null && !outcome.dropped) {
    await refreshThreadCounts(db, outcome.threadId);
  }
}

/**
 * Mark every copy of one message read or unread (see copyRows for what a copy is), keeping flags_json
 * in step: `\Seen` is added when a copy is marked read and removed when it is marked unread. A row
 * that only shares the Message-ID — another sender, another date, a reused id — is a different
 * message and is left alone.
 *
 * @returns {Promise<number>} how many rows changed read state
 */
export async function setReadForCopies(db, row, isRead) {
  const copies = await copyRows(db, row);
  if (!copies.length) return 0;
  const value = isRead ? 1 : 0;
  const ids = copies.map((copy) => copy.id);

  const changed = await db.runTransaction((run) => {
    let n = 0;
    for (const id of ids) {
      const current = rowsOf(run, "SELECT is_read, flags_json FROM mail_messages WHERE id = ?", [id])[0];
      if (!current) continue;
      const readChanged = Number(current.is_read) !== value;
      const nextFlags = flagsForRead(current.flags_json, isRead);
      if (readChanged) n += 1;
      if (!readChanged && nextFlags === current.flags_json) continue;
      run({
        sql: "UPDATE mail_messages SET is_read = ?, flags_json = ? WHERE id = ?",
        args: [value, nextFlags, id],
      });
    }
    return n;
  });

  await refreshThreads(db, copies.map((copy) => copy.threadId));
  return changed;
}

/**
 * Write the flags a server reported for a folder's uids: flags_json and is_read, never the FTS
 * columns (the update trigger does not fire for them, so the index is untouched). Uids Crow does not
 * hold are passed over. Returns how many rows changed.
 *
 * @param {object[]} items `{uid, flags}[]` as the adapter's list returns them
 */
export async function applyFlags(db, folderId, items) {
  const id = positiveInt(folderId, "folder_id");
  const list = Array.isArray(items) ? items : [];

  const outcome = await db.runTransaction((run) => {
    let changed = 0;
    const threadIds = [];
    for (const item of list) {
      const uid = Number(item?.uid);
      if (!Number.isInteger(uid) || uid <= 0) continue;
      const flags = Array.isArray(item.flags) ? item.flags.filter((flag) => typeof flag === "string") : [];
      const result = run({
        sql: `UPDATE mail_messages SET flags_json = ?, is_read = ?
               WHERE folder_id = ? AND uid = ?
               RETURNING thread_id`,
        args: [JSON.stringify(flags), hasSeen(flags) ? 1 : 0, id, uid],
      });
      for (const row of result.rows) {
        changed += 1;
        if (row.thread_id != null) threadIds.push(Number(row.thread_id));
      }
    }
    return { changed, threadIds };
  });

  await refreshThreads(db, outcome.threadIds);
  return outcome.changed;
}

const ABSENT_UIDS_SQL = `folder_id = ? AND uid >= ?
  AND uid NOT IN (SELECT value FROM json_each(?))`;

/**
 * Expunge reconciliation: remove the folder's rows at or above `minUid` that the server no longer
 * lists, dropping threads the deletions emptied and refreshing the ones that survived. Rows below
 * minUid are not looked at — they are older mail the caller did not ask the server about. FTS entries
 * go with their rows through the delete trigger.
 *
 * `options.minUid` is the lower bound of the scan. When it is given it must be a non-negative
 * integer: a caller that hands over `"12"` or `-1` has a bug, and treating it as 0 would delete a
 * folder's whole history, so it is refused (BAD_INPUT) instead. Null and undefined mean 0.
 *
 * @returns {Promise<number>} how many rows were removed
 */
export async function deleteMissing(db, folderId, presentUids, options = {}) {
  const id = positiveInt(folderId, "folder_id");
  const present = (Array.isArray(presentUids) ? presentUids : [])
    .map((uid) => Number(uid))
    .filter((uid) => Number.isInteger(uid) && uid > 0);
  const given = options?.minUid;
  let minUid = 0;
  if (given != null) {
    if (typeof given !== "number" || !Number.isInteger(given) || given < 0) fail("min_uid");
    minUid = given;
  }

  const outcome = await db.runTransaction((run) => {
    const threadIds = rowsOf(run,
      `SELECT DISTINCT thread_id FROM mail_messages
        WHERE ${ABSENT_UIDS_SQL} AND thread_id IS NOT NULL`,
      [id, minUid, JSON.stringify(present)])
      .map((row) => Number(row.thread_id));
    const result = run({
      sql: `DELETE FROM mail_messages WHERE ${ABSENT_UIDS_SQL}`,
      args: [id, minUid, JSON.stringify(present)],
    });

    const surviving = [];
    for (const threadId of new Set(threadIds)) {
      const left = Number(rowsOf(run, "SELECT COUNT(*) AS n FROM mail_messages WHERE thread_id = ?",
        [threadId])[0].n);
      if (left === 0) run({ sql: "DELETE FROM mail_threads WHERE id = ?", args: [threadId] });
      else surviving.push(threadId);
    }
    return { deleted: Number(result.rowsAffected ?? 0), threadIds: surviving };
  });

  await refreshThreads(db, outcome.threadIds);
  return outcome.deleted;
}

/** The lowest stored uid in a folder, or null when it holds no messages: the expunge scan's bound. */
export async function minUid(db, folderId) {
  const id = positiveInt(folderId, "folder_id");
  const { rows } = await db.execute({ sql: "SELECT MIN(uid) AS uid FROM mail_messages WHERE folder_id = ?", args: [id] });
  const value = rows[0]?.uid;
  return value == null ? null : Number(value);
}

/** Every stored uid in a folder, ascending. */
export async function storedUids(db, folderId) {
  const id = positiveInt(folderId, "folder_id");
  const { rows } = await db.execute({
    sql: "SELECT uid FROM mail_messages WHERE folder_id = ? ORDER BY uid ASC",
    args: [id],
  });
  return rows.map((row) => Number(row.uid));
}

/* --------------------------------------------------------------- paging & search */

const ROLE_NAMES = new Set(FOLDER_ROLES);

function encodeCursor(row) {
  return Buffer.from(`${Number(row.date)}:${Number(row.id)}`, "utf8").toString("base64url");
}

/** `date:id` in base64url, opaque to the caller. Anything else is BAD_INPUT, never a silent page 1. */
function decodeCursor(cursor) {
  if (cursor == null || cursor === "") return null;
  const text = Buffer.from(String(cursor), "base64url").toString("utf8");
  const match = /^(\d{1,16}):(\d{1,16})$/.exec(text);
  if (!match) fail("cursor");
  return { date: Number(match[1]), id: Number(match[2]) };
}

/** The folder ids that have `role`, for one account or every account (the unified view). */
async function folderIdsForRole(db, role, accountId) {
  const sql = accountId
    ? "SELECT id, path, name, special_use FROM mail_folders WHERE account_id = ?"
    : "SELECT id, path, name, special_use FROM mail_folders";
  const { rows } = await db.execute({ sql, args: accountId ? [accountId] : [] });
  return rows.filter((row) => folderRole(row) === role).map((row) => Number(row.id));
}

const LIST_SQL = (where) => `SELECT ${SUMMARY_COLUMNS} FROM mail_messages
  ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  ORDER BY date DESC, id DESC LIMIT ?`;

/**
 * One page of message summaries, newest first, with a keyset cursor of `date:id`.
 *
 * `folderId` is one folder; `role` is every folder with that role (with an `accountId`: that
 * account's; without one: every account's — the unified view); `accountId` alone is every folder of
 * the account. A `folderId` that names another account's folder (or no folder at all) answers an
 * empty page, never that folder's mail. The cursor is the `(date, id)` pair of the last item, so a
 * message arriving between pages never shifts an older page: the comparison is strict and both keys
 * descend together.
 *
 * @returns {Promise<{items: object[], nextCursor: string|null}>}
 */
export async function listMessages(db, { accountId = null, folderId = null, role = null, limit, cursor } = {}) {
  const cap = limitOf(limit);
  const after = decodeCursor(cursor);
  const account = accountId == null ? null : accountIdOf(accountId);
  const where = [];
  const args = [];

  if (folderId != null) {
    const folder = positiveInt(folderId, "folder_id");
    if (account) {
      const { rows: owner } = await db.execute({
        sql: "SELECT account_id FROM mail_folders WHERE id = ?",
        args: [folder],
      });
      if (!owner[0] || owner[0].account_id !== account) return { items: [], nextCursor: null };
    }
    where.push("folder_id = ?");
    args.push(folder);
  } else if (role != null) {
    if (typeof role !== "string" || !ROLE_NAMES.has(role)) fail("role");
    const folderIds = await folderIdsForRole(db, role, account);
    if (!folderIds.length) return { items: [], nextCursor: null };
    where.push("folder_id IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(folderIds));
  } else if (account) {
    where.push("account_id = ?");
    args.push(account);
  }

  if (after) {
    where.push("(date < ? OR (date = ? AND id < ?))");
    args.push(after.date, after.date, after.id);
  }
  args.push(cap + 1);

  const { rows } = await db.execute({ sql: LIST_SQL(where), args });
  const page = rows.slice(0, cap);
  const nextCursor = rows.length > cap ? encodeCursor(page[page.length - 1]) : null;
  return { items: page.map(rowToSummary), nextCursor };
}

/** One stored message with its parsed JSON columns, or null. */
export async function getMessage(db, id) {
  const messageId = Number(id);
  if (!Number.isInteger(messageId) || messageId <= 0) return null;
  const { rows } = await db.execute({ sql: `SELECT ${MESSAGE_COLUMNS} FROM mail_messages WHERE id = ?`, args: [messageId] });
  return rowToMessage(rows[0]);
}

/**
 * An FTS5 query from a person's words: split on everything that is not a letter or a digit, at most
 * eight terms of 64 characters, each one a quoted prefix (`"term"*`). Quoting is why a `"`, a `*`, a
 * `NEAR(` or an `AND` in the input can never be read as FTS5 syntax, and why the query cannot raise.
 * Null when there is nothing to search for.
 */
export function toFtsQuery(q) {
  if (typeof q !== "string") return null;
  const tokens = [];
  for (const token of q.split(/[^\p{L}\p{N}]+/u)) {
    if (!token) continue;
    tokens.push(token.slice(0, MAX_FTS_TOKEN_CHARS));
    if (tokens.length >= MAX_FTS_TOKENS) break;
  }
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token}"*`).join(" ");
}

/*
 * Search: FTS5 rank first, then the newest row. Rows are grouped into logical messages (account_id
 * plus message_id; a row with no message_id groups alone) and the group's best rank orders it; within
 * a group the newest row (date, then id) stands for it, so a Gmail label copy is one result, not two.
 */
const SEARCH_SQL = `
  WITH hits AS (
    SELECT m.id AS id, m.account_id AS account_id, m.folder_id AS folder_id, m.thread_id AS thread_id,
           m.message_id AS message_id, m.from_name AS from_name, m.from_addr AS from_addr,
           m.subject AS subject, m.snippet AS snippet, m.date AS date, m.is_read AS is_read,
           m.has_attachments AS has_attachments, mail_messages_fts.rank AS rank,
           CASE WHEN m.message_id IS NULL THEN 'row:' || m.id ELSE 'msg:' || m.message_id END AS grp
      FROM mail_messages_fts
      JOIN mail_messages AS m ON m.id = mail_messages_fts.rowid
     WHERE mail_messages_fts MATCH ?
       AND (? = '' OR m.account_id = ?)
  ),
  grouped AS (
    SELECT hits.*,
           MIN(rank) OVER (PARTITION BY account_id, grp) AS group_rank,
           ROW_NUMBER() OVER (
             PARTITION BY account_id, grp
             ORDER BY date DESC, id DESC, rank ASC) AS rn
      FROM hits
  )
  SELECT id, account_id, folder_id, thread_id, message_id, from_name, from_addr, subject, snippet,
         date, is_read, has_attachments
    FROM grouped
   WHERE rn = 1
   ORDER BY group_rank ASC, date DESC, id DESC
   LIMIT ?`;

/**
 * Local full-text search over subject, sender, recipients and body, ranked by FTS5 relevance then
 * date. One result per logical message (see the module header). A query with no searchable term
 * returns an empty list, never an error.
 *
 * @returns {Promise<object[]>} MessageSummary rows
 */
export async function searchLocal(db, { q, accountId = null, limit } = {}) {
  const query = toFtsQuery(q);
  if (!query) return [];
  const account = accountId == null ? "" : accountIdOf(accountId);
  const { rows } = await db.execute({
    sql: SEARCH_SQL,
    args: [query, account, account, limitOf(limit)],
  });
  return rows.map(rowToSummary);
}