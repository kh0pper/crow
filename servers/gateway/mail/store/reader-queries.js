/**
 * The reader's questions about the mail store: which row a link means, what one conversation holds,
 * and which senders may show remote images on one account.
 *
 * A Message-ID is not an identity. It comes from the sender, so anyone can reuse one, and a link that
 * carried only a Message-ID could open a message the person never meant to open. Two rules follow.
 *
 * 1. A link carries the row id as a hint. The hint is used only when the row belongs to the account
 *    and — when the link also carries a Message-ID — the row's message_id is that id. A row id that a
 *    UIDVALIDITY reset or a re-sync invalidated is therefore ignored rather than trusted.
 * 2. A Message-ID lookup groups the account's candidate rows by (from_addr, date). The real message
 *    arrived first and a forged reuse arrives later, so the group holding the lowest id wins; inside
 *    that group the row in an inbox-role folder is preferred (a Gmail label copy is the same
 *    message), else the lowest id.
 *
 * A conversation lists one entry per logical message: rows that are copies of one another (the same
 * Message-ID, sender and date, in another folder — messages.js copyRows) collapse to one, and the
 * inbox-role row stands for the group. Two rows of the same folder that share all three are two
 * deliveries of one message, not copies, so both stay. Rows that share only a Message-ID stay
 * separate: they are different messages that happen to carry the same id. A row with no Message-ID
 * is its own entry, since there is nothing to match it on.
 *
 * Nothing here writes; every function is a read the message page and the panel may run on a GET.
 */
import { folderRole, getMessage } from "./messages.js";

/* The summary projection messages.js uses for a listing. It is not exported there, so the thread
 * query repeats it: an entry in a conversation is a MessageSummary, never a whole message. */
const SUMMARY_COLUMNS = `id, account_id, folder_id, thread_id, message_id, from_name, from_addr,
  subject, snippet, date, is_read, has_attachments`;

const MID_CANDIDATES_SQL = `SELECT ${SUMMARY_COLUMNS} FROM mail_messages
   WHERE account_id = ? AND message_id = ? ORDER BY id ASC`;

const THREAD_ROWS_SQL = `SELECT ${SUMMARY_COLUMNS} FROM mail_messages
   WHERE account_id = ? AND thread_id = ? ORDER BY date ASC, id ASC`;

const FOLDER_ROLE_SQL = "SELECT id, path, name, special_use FROM mail_folders WHERE account_id = ?";

const IMAGE_ALLOW_SQL = `SELECT DISTINCT lower(sender) AS sender FROM mail_image_allow
   WHERE account_id = ? ORDER BY sender ASC`;

/** An account id as the store holds it, or null when the caller handed over nothing usable. */
function accountOf(value) {
  return typeof value === "string" && value !== "" && value.length <= 80 ? value : null;
}

/** The Message-ID of a link: a non-empty string, else null (a link that names none). */
function messageIdOf(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The row id of a link's hint, taken from an id or from a row object; null when there is none. */
function rowIdOf(value) {
  const raw = value !== null && typeof value === "object" ? value.id : value;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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

/** The ids of an account's inbox-role folders: which copy of a message the reader stands on. */
async function inboxFolderIds(db, accountId) {
  const { rows } = await db.execute({ sql: FOLDER_ROLE_SQL, args: [accountId] });
  const ids = new Set();
  for (const row of rows) if (folderRole(row) === "inbox") ids.add(Number(row.id));
  return ids;
}

/**
 * The row that stands for a group of copies: its inbox-role row when it has one, else its lowest id.
 * `rows` are candidates of one message, so they already share the Message-ID, sender and date.
 */
function representative(rows, inboxIds) {
  const inbox = rows.find((row) => inboxIds.has(Number(row.folder_id)));
  if (inbox) return inbox;
  return rows.reduce((lowest, row) => (Number(row.id) < Number(lowest.id) ? row : lowest), rows[0]);
}

/**
 * When several stored rows carry the same Message-ID, the one the id means: the group of rows sharing
 * (from_addr, date) that holds the lowest id, then that group's inbox-role row (else its lowest id).
 */
async function findByMessageId(db, accountId, messageId) {
  const { rows } = await db.execute({ sql: MID_CANDIDATES_SQL, args: [accountId, messageId] });
  if (!rows.length) return null;

  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.from_addr ?? null, Number(row.date)]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  // Rows arrive in ascending id order, so the first group is the one holding the lowest id.
  const chosen = representative([...groups.values()][0], await inboxFolderIds(db, accountId));
  return getMessage(db, Number(chosen.id));
}

/**
 * The message a link means. `row` is the link's id hint and `mid` its Message-ID; a link carries both
 * (the hint is only a hint) or, for a message with no Message-ID, the row alone.
 *
 * @param {{accountId: string, mid?: string|null, row?: number|object|null}} ref
 * @returns {Promise<object|null>} the full message row getMessage returns, or null
 */
export async function resolveMessageRef(db, { accountId, mid = null, row = null } = {}) {
  const account = accountOf(accountId);
  if (!account) return null;
  const messageId = messageIdOf(mid);
  const rowId = rowIdOf(row);

  if (rowId !== null) {
    const hinted = await getMessage(db, rowId);
    if (hinted && hinted.accountId === account
      && (messageId === null || hinted.messageId === messageId)) {
      return hinted;
    }
  }
  if (messageId === null) return null;
  return findByMessageId(db, account, messageId);
}

/**
 * One conversation, oldest first: every stored row of the thread, with copies collapsed to the row
 * the reader stands on (see the module header). A thread that does not exist, or belongs to another
 * account, is an empty list.
 *
 * @returns {Promise<object[]>} MessageSummary rows, `date ASC, id ASC`
 */
export async function listThreadMessages(db, accountId, threadId) {
  const account = accountOf(accountId);
  const thread = Number(threadId);
  if (!account || !Number.isInteger(thread) || thread <= 0) return [];

  const { rows } = await db.execute({ sql: THREAD_ROWS_SQL, args: [account, thread] });
  if (!rows.length) return [];

  const groups = new Map();
  for (const row of rows) {
    const messageId = row.message_id ?? null;
    const key = messageId === null
      ? `row:${Number(row.id)}`
      : JSON.stringify([messageId, row.from_addr ?? null, Number(row.date)]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const inboxIds = await inboxFolderIds(db, account);
  const inboxFirst = (a, b) => Number(inboxIds.has(Number(b.folder_id)))
    - Number(inboxIds.has(Number(a.folder_id)))
    || Number(a.id) - Number(b.id);

  const entries = [];
  for (const group of groups.values()) {
    // Within one message's group, a row is a copy only of a row in another folder (copyRows' rule).
    // Rows that stay in the same folder as every row kept so far are their own entry.
    const kept = [];
    for (const row of [...group].sort(inboxFirst)) {
      const copied = kept.some((other) => Number(other.folder_id) !== Number(row.folder_id));
      if (!copied) kept.push(row);
    }
    for (const row of kept) entries.push(rowToSummary(row));
  }

  return entries.sort((a, b) => a.date - b.date || a.id - b.id);
}

/**
 * The senders whose remote images an account shows without asking, lower-cased and sorted. Senders
 * are stored lower-cased (accounts.js addImageAllow); lowering again here keeps a row written any
 * other way from missing its message's From address.
 *
 * @returns {Promise<string[]>}
 */
export async function listImageAllow(db, accountId) {
  const account = accountOf(accountId);
  if (!account) return [];
  const { rows } = await db.execute({ sql: IMAGE_ALLOW_SQL, args: [account] });
  return rows.map((row) => String(row.sender ?? "")).filter((sender) => sender !== "");
}