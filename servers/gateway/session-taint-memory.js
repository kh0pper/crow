/**
 * D22 fail-closed fallback (plan re-check 2, R3-M1): sessions whose outside-
 * text taint could NOT be written to the DB. In-process memory, so it cannot
 * fail the way the write did.
 *
 * MONOTONIC (security review): entries are only ever added — there is no
 * delete, no reset, no eviction, no size cap, not even a test seam that clears
 * it. It is NEVER a source of "clean": trust.js asks it only "is this session
 * known-tainted?" and otherwise re-reads the DB record every time (a missing or
 * unreadable record = untrusted). A gateway restart empties it; that is safe
 * because the session is stopped when it lands here and the DB is re-read.
 */
const unrecorded = new Set();
const key = (botId, threadId) => JSON.stringify([String(botId), String(threadId)]);
export function markTaintUnrecorded(botId, threadId) { unrecorded.add(key(botId, threadId)); }
export function isTaintUnrecorded(botId, threadId) { return unrecorded.has(key(botId, threadId)); }
