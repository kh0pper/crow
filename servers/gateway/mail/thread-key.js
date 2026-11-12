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
 *   4. no ids at all -> join the nearest same-subject thread that shares a participant and whose
 *      last message is within 14 days; otherwise a new thread. With a subject the key is
 *      subj:<normalized>:<UTC day>, and when that day's key is already taken by people this message
 *      shares nothing with, the new key gains a participant (or random) suffix. No normalized
 *      subject at all -> a fresh thread keyed anon:<random hex>. A subject alone never joins.
 *
 * Rules 3 and 4 insert-or-join on (account_id, thread_key) and a collision never raises a UNIQUE
 * error. Rule 3 joins the existing row with that key; rule 4 joins it only when a participant is
 * shared, and otherwise adds a suffix so the row is new. Rules 1, 2 and every merge run in ONE
 * transaction (db.runTransaction, servers/db.js: read, compare and write with no await in between),
 * so a merge can never be seen half-done — messages moved but the emptied thread row still there,
 * or counts stale.
 */
import { randomBytes } from "node:crypto";

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

/** The day a subject key carries on its face, and the normalized subject in front of it. */
const SUBJECT_KEY_RE = /^(.*):(\d{4}-\d{2}-\d{2})(?::(.*))?$/;

/** The longest instant a Date can hold; beyond it toISOString throws. */
const MAX_TIME_MS = 8.64e15;

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

/** The thread already holding `threadKey`, as an id, or null. */
function findByKey(run, accountId, threadKey) {
  const row = rows(run, THREAD_BY_KEY_SQL, [accountId, threadKey])[0];
  return row ? Number(row.id) : null;
}

/**
 * A `subj:` key split into its normalized subject and its day, or null when it is not one.
 *
 * The subject is matched from the left, greedily, so a subject that itself contains a date-shaped
 * run keeps it (`subj:meeting 2026-01-05:2026-01-06` is the subject "meeting 2026-01-05" on the
 * 6th), and a participant-suffixed key still parses. Comparing this subject with === is what keeps
 * a thread for "Meeting: agenda" from answering for "Meeting".
 */
function parseSubjectKey(threadKey) {
  if (typeof threadKey !== "string" || !threadKey.startsWith("subj:")) return null;
  const match = SUBJECT_KEY_RE.exec(threadKey.slice("subj:".length));
  if (!match) return null;
  return { subject: match[1], day: match[2] };
}

/** A short random key suffix, for an id-less thread with no participant to name it after. */
function randomSuffix() {
  return randomBytes(8).toString("hex");
}

/**
 * Rule 4's new thread for a non-empty subject on a given day.
 *
 * The plain `subj:<normalized>:<day>` key belongs to the first pair who wrote that subject that day.
 * A second, unrelated pair writing it must not be folded into their conversation, so the key gains
 * `:<first participant>` (or a random suffix when the message names nobody), which the same pair
 * then reuses. A key that is somehow already there is joined only when a participant is shared.
 */
function subjectThread(run, accountId, normalized, subject, at, people) {
  const base = `subj:${normalized}:${utcDay(at)}`;
  const existing = findByKey(run, accountId, base);
  if (existing === null) return joinOrCreate(run, accountId, base, subject, at);
  if (sharesParticipant(run, existing, people)) return existing;

  const preferred = people.values().next().value;
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = attempt === 0 && preferred ? `${base}:${preferred}` : `${base}:${randomSuffix()}`;
    const found = findByKey(run, accountId, key);
    if (found === null) return joinOrCreate(run, accountId, key, subject, at);
    if (sharesParticipant(run, found, people)) return found;
  }
  return joinOrCreate(run, accountId, `${base}:${randomSuffix()}`, subject, at);
}

/** The UTC day a message belongs to, for rule 4's key. A finite date outside what a Date can hold
 *  falls back to the epoch day: a sender's malformed Date header must not throw out of a sync. */
function utcDay(at) {
  const ms = Number.isFinite(at) && Math.abs(at) <= MAX_TIME_MS ? at : 0;
  return new Date(ms).toISOString().slice(0, 10);
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
    // First match wins: a message whose parent and child sit in different threads joins the
    // parent's thread here and does not merge the child's.
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
    if (!normalized) {
      // An empty normalized subject is no join key at all: every such message is its own thread.
      return touch(run, joinOrCreate(run, accountId, `anon:${randomSuffix()}`, subject, at));
    }
    const candidates = rows(run, SUBJECT_THREADS_SQL,
      [accountId, at - SUBJECT_WINDOW_MS, at + SUBJECT_WINDOW_MS]);
    for (const candidate of candidates) {
      const parsed = parseSubjectKey(candidate.thread_key);
      if (!parsed || parsed.subject !== normalized) continue;
      const id = Number(candidate.id);
      if (!sharesParticipant(run, id, people)) continue;
      return touch(run, id);
    }
    return touch(run, subjectThread(run, accountId, normalized, subject, at, people));
  });
}