/**
 * Crow Mail thread assignment: which mail_threads row a newly synced message belongs to.
 *
 * `assignThread` only reads mail_messages and writes mail_threads (plus, when two threads turn out to
 * be one conversation, re-points mail_messages.thread_id). It never inserts the message itself: the
 * caller stores the row afterwards and then calls `refreshThreadCounts`, which is exported here for
 * that purpose.
 *
 * The rules, first match wins:
 *   0. this message is already stored (a Gmail label copy of the same message) -> its thread;
 *   1. a stored message_id equals this inReplyTo or is in these references (the parent is known);
 *   2. a stored in_reply_to or references_json names this messageId (the parent arrived late);
 *   3. ids but no known relative -> a thread keyed by the first reference, else inReplyTo, else
 *      messageId;
 *   4. no ids at all -> join a same-subject thread whose last message is within 14 days and which
 *      shares a participant, else a thread keyed by subject and UTC day. Never subject alone.
 *
 * Rules 3 and 4 are insert-or-join on (account_id, thread_key): an existing row with that key is
 * joined, never duplicated. Rules 1, 2 and every merge run in ONE transaction (db.runTransaction,
 * servers/db.js: read, compare and write with no await in between), so a merge can never be seen
 * half-done — messages moved but the emptied thread row still there, or counts stale.
 */

/** 14 days: how far apart two id-less messages with the same subject may be and still be one thread. */
const SUBJECT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 2 days: how far a child may predate the parent it references (clock skew between servers), and so
 * the lower date bound of the references_json scan in rule 2.
 */
const REFERENCE_SKEW_MS = 2 * 24 * 60 * 60 * 1000;

/** A leading reply/forward marker. `Remember: x` does not match; `RE : x` and `Re:x` do. */
const PREFIX_RE = /^(?:re|fwd|fw|aw)\s*:\s*/i;

/** A leading list tag such as `[crow-users]`. */
const TAG_RE = /^\[[^\]]*\]\s*/;

/**
 * The subject without its reply/forward markers and list tags, whitespace-collapsed, lower-cased.
 *
 * Prefixes and tags are stripped in a loop, so `Re: Re: Fwd: [list] Hi` normalizes like `Hi`. A tag
 * is stripped when a prefix has already been removed (`Re: [list] Hi`) or when it leads the subject
 * and the prefix is right behind it (`[list] Re: Hi`); a tag in the middle of a subject, or one that
 * leads a subject with no reply marker at all, is part of the subject and stays.
 */
export function normalizeSubject(subject) {
  let rest = typeof subject === "string" ? subject : "";
  let sawPrefix = false;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    const prefix = PREFIX_RE.exec(rest);
    if (prefix) {
      rest = rest.slice(prefix[0].length);
      sawPrefix = true;
      continue;
    }
    const tag = TAG_RE.exec(rest);
    if (tag) {
      const behind = rest.slice(tag[0].length).replace(/^\s+/, "");
      if (sawPrefix || PREFIX_RE.test(behind)) {
        rest = rest.slice(tag[0].length);
        continue;
      }
    }
    break;
  }
  return rest.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Recompute a thread's message_count, unread_count and last_date from its mail_messages rows.
 *
 * The same logical message stored in several folders (a Gmail label copy) is ONE message: rows are
 * grouped by (account_id, message_id), and a row with no message_id groups alone (its rowid keys it).
 * A thread with no rows keeps its row with zero counts and a null last_date — this deletes nothing.
 */
const REFRESH_COUNTS_SQL = `
  UPDATE mail_threads SET
    message_count = (
      SELECT COUNT(*) FROM (
        SELECT 1 AS one
          FROM mail_messages
         WHERE thread_id = ?
         GROUP BY CASE WHEN message_id IS NULL THEN 'row:' || id ELSE 'msg:' || message_id END
      )
    ),
    unread_count = (
      SELECT COUNT(*) FROM (
        SELECT 1 AS one
          FROM mail_messages
         WHERE thread_id = ? AND is_read = 0
         GROUP BY CASE WHEN message_id IS NULL THEN 'row:' || id ELSE 'msg:' || message_id END
      )
    ),
    last_date = (SELECT MAX(date) FROM mail_messages WHERE thread_id = ?)
  WHERE id = ?`;

/** The synchronous form, for use inside an open transaction. */
function refreshCounts(run, threadId) {
  run({ sql: REFRESH_COUNTS_SQL, args: [threadId, threadId, threadId, threadId] });
}

/** The caller-facing form: one statement, so it is atomic on its own. */
export async function refreshThreadCounts(db, threadId) {
  const id = Number(threadId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (!db || typeof db.runTransaction !== "function") {
    throw new Error("refreshThreadCounts needs a client with runTransaction (servers/db.js)");
  }
  return db.runTransaction((run) => { refreshCounts(run, id); });
}

const THREADS_WITH_PARENT_SQL = `SELECT DISTINCT thread_id FROM mail_messages
   WHERE account_id = ? AND thread_id IS NOT NULL AND message_id IS NOT NULL
     AND (message_id = ? OR message_id IN (SELECT value FROM json_each(?)))`;

const THREADS_WITH_CHILD_BY_REPLY_SQL = `SELECT DISTINCT thread_id FROM mail_messages
   WHERE account_id = ? AND thread_id IS NOT NULL AND in_reply_to = ?`;

/*
 * Rule 2's references lookup, and why it looks like this.
 *
 * references_json holds a JSON text array, so it cannot be indexed and no equality test is
 * available. The scan is therefore a substring test — instr(references_json, ?) — against the id
 * JSON-encoded (`JSON.stringify(messageId)`, quotes included, so "<b@x>" never matches "<ab@x>" and
 * no LIKE wildcards need escaping). It is bounded to the SAME account and to rows dated at or after
 * this message's date minus two days: idx_mail_messages_account_date then carries the scan, and a
 * child cannot predate its parent by more than clock skew, which caps the work a hostile id can ask
 * for. (in_reply_to is a plain column with idx_mail_messages_in_reply_to, so it is matched with
 * equality in its own query above.)
 */
const THREADS_WITH_CHILD_BY_REFERENCES_SQL = `SELECT DISTINCT thread_id FROM mail_messages
   WHERE account_id = ? AND thread_id IS NOT NULL AND date >= ? AND instr(references_json, ?) > 0`;

const SUBJECT_THREADS_SQL = `SELECT id, thread_key FROM mail_threads
   WHERE account_id = ? AND thread_key LIKE 'subj:%' AND last_date IS NOT NULL
     AND last_date >= ? AND last_date <= ?
   ORDER BY id`;

const THREAD_PARTICIPANTS_SQL = "SELECT from_addr, to_json, cc_json FROM mail_messages WHERE thread_id = ?";

const INSERT_THREAD_SQL = `INSERT INTO mail_threads
    (account_id, thread_key, subject, last_date, message_count, unread_count)
  VALUES (?, ?, ?, ?, 0, 0)
  ON CONFLICT(account_id, thread_key) DO NOTHING`;

const THREAD_BY_KEY_SQL = "SELECT id FROM mail_threads WHERE account_id = ? AND thread_key = ?";
const SET_SUBJECT_IF_EMPTY_SQL = "UPDATE mail_threads SET subject = COALESCE(subject, ?) WHERE id = ?";
const SET_LAST_DATE_SQL = "UPDATE mail_threads SET last_date = MAX(COALESCE(last_date, 0), ?) WHERE id = ?";
const MOVE_MESSAGES_SQL = "UPDATE mail_messages SET thread_id = ? WHERE thread_id = ?";
const DELETE_THREAD_SQL = "DELETE FROM mail_threads WHERE id = ?";
const THREAD_SUBJECT_SQL = "SELECT subject FROM mail_threads WHERE id = ?";

const rows = (run, sql, args) => run({ sql, args }).rows;

/** Thread ids named by a query, as positive integers (a null thread_id means "not assigned yet"). */
function threadIds(run, sql, args) {
  const out = [];
  for (const row of rows(run, sql, args)) {
    const id = Number(row.thread_id);
    if (Number.isInteger(id) && id > 0) out.push(id);
  }
  return out;
}

/** Every lower-cased address in a stored message's From, To and Cc. */
function addressesOf(row) {
  const out = [];
  const push = (value) => {
    if (typeof value !== "string") return;
    const address = value.trim().toLowerCase();
    if (address) out.push(address);
  };
  push(row.from_addr);
  for (const column of [row.to_json, row.cc_json]) {
    if (!column) continue;
    let parsed;
    try { parsed = JSON.parse(column); } catch { continue; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof item === "string") push(item);
      else if (item && typeof item.address === "string") push(item.address);
    }
  }
  return out;
}

function sharesParticipant(run, threadId, people) {
  if (people.size === 0) return false;
  for (const row of rows(run, THREAD_PARTICIPANTS_SQL, [threadId])) {
    for (const address of addressesOf(row)) if (people.has(address)) return true;
  }
  return false;
}

/**
 * Collapse several threads into the lowest id: move their messages, delete the emptied
 * mail_threads rows (keeping the first non-null subject), recompute the surviving thread's counts.
 */
function mergeThreads(run, ids) {
  const target = Math.min(...ids);
  for (const other of [...new Set(ids)].filter((id) => id !== target).sort((a, b) => a - b)) {
    const stale = rows(run, THREAD_SUBJECT_SQL, [other])[0];
    run({ sql: MOVE_MESSAGES_SQL, args: [target, other] });
    run({ sql: DELETE_THREAD_SQL, args: [other] });
    if (stale && stale.subject) run({ sql: SET_SUBJECT_IF_EMPTY_SQL, args: [stale.subject, target] });
  }
  refreshCounts(run, target);
  return target;
}

/** Join the thread that already holds `threadKey`, or create it. */
function joinOrCreate(run, accountId, threadKey, subject, at) {
  run({ sql: INSERT_THREAD_SQL, args: [accountId, threadKey, subject || null, at] });
  return Number(rows(run, THREAD_BY_KEY_SQL, [accountId, threadKey])[0].id);
}

/** The UTC day a message belongs to, for rule 4's key. */
function utcDay(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The thread a message belongs to, creating or merging threads as the rules require. The message's
 * row is NOT written here; the caller inserts it and then calls `refreshThreadCounts`.
 *
 * @param {object} db a client with runTransaction (servers/db.js)
 * @param {string} accountId
 * @param {{messageId?: string|null, inReplyTo?: string|null, references?: string[],
 *          subject?: string, date: number, participants?: string[]}} message
 *   `participants` are the message's own lower-cased From, To and Cc addresses.
 * @returns {Promise<number>} mail_threads.id
 */
export async function assignThread(db, accountId, message) {
  if (!db || typeof db.runTransaction !== "function") {
    throw new Error("assignThread needs a client with runTransaction (servers/db.js)");
  }
  const {
    messageId = null,
    inReplyTo = null,
    date,
    participants = [],
  } = message || {};
  const references = Array.isArray(message?.references)
    ? message.references.filter((ref) => typeof ref === "string" && ref)
    : [];
  const at = Number(date);
  if (!Number.isFinite(at)) throw new TypeError("assignThread needs a numeric date");
  const subject = typeof message?.subject === "string" ? message.subject : "";
  const normalized = normalizeSubject(subject);
  const people = new Set(
    (Array.isArray(participants) ? participants : [])
      .filter((address) => typeof address === "string")
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
  );

  /** Record the arriving message's date and subject on the thread, and recompute its counts. */
  const touch = (run, threadId) => {
    run({ sql: SET_SUBJECT_IF_EMPTY_SQL, args: [subject || null, threadId] });
    refreshCounts(run, threadId);
    run({ sql: SET_LAST_DATE_SQL, args: [at, threadId] });
    return threadId;
  };

  return db.runTransaction((run) => {
    // Rule 0 — this exact message is already stored (a label copy of the same message).
    if (messageId) {
      const known = threadIds(run,
        `SELECT thread_id FROM mail_messages
          WHERE account_id = ? AND message_id = ? AND thread_id IS NOT NULL
          ORDER BY thread_id LIMIT 1`,
        [accountId, messageId]);
      if (known.length) return known[0];
    }

    // Rule 1 — the parent is known: a stored message_id equals inReplyTo or is in references.
    if (inReplyTo || references.length) {
      const parents = threadIds(run, THREADS_WITH_PARENT_SQL,
        [accountId, inReplyTo || null, JSON.stringify(references)]);
      if (parents.length) return touch(run, mergeThreads(run, parents));
    }

    // Rule 2 — a child is known: a stored in_reply_to, or a stored references_json, names this id.
    if (messageId) {
      const children = threadIds(run, THREADS_WITH_CHILD_BY_REPLY_SQL, [accountId, messageId]);
      for (const id of threadIds(run, THREADS_WITH_CHILD_BY_REFERENCES_SQL,
        [accountId, at - REFERENCE_SKEW_MS, JSON.stringify(messageId)])) {
        if (!children.includes(id)) children.push(id);
      }
      if (children.length) return touch(run, mergeThreads(run, children));
    }

    // Rule 3 — ids but no known relative: key on the conversation root we can see.
    const keyedBy = references[0] || inReplyTo || messageId;
    if (keyedBy) {
      return touch(run, joinOrCreate(run, accountId, `mid:${keyedBy}`, subject, at));
    }

    // Rule 4 — no ids at all. Subject, time and a shared participant together, never subject alone.
    if (normalized) {
      const prefix = `subj:${normalized}:`;
      const candidates = rows(run, SUBJECT_THREADS_SQL,
        [accountId, at - SUBJECT_WINDOW_MS, at + SUBJECT_WINDOW_MS]);
      for (const candidate of candidates) {
        if (!String(candidate.thread_key).startsWith(prefix)) continue;
        if (!sharesParticipant(run, Number(candidate.id), people)) continue;
        return touch(run, Number(candidate.id));
      }
    }
    return touch(run, joinOrCreate(run, accountId, `subj:${normalized}:${utcDay(at)}`, subject, at));
  });
}