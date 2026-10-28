/**
 * The shared browser lease: one advisory lease file through which bots'
 * browser MCP servers and the gateway take turns on the one shared page.
 *
 * Advisory, not a privacy boundary: a bot with a shell can reach CDP directly,
 * and nothing private depends on this file.
 *
 * The lease directory (stateDir("browser-lease")) is writable by bots (the
 * browser MCP server runs inside the bot's sandbox), so:
 *   - every byte read from it is untrusted: reads are capped at 4 KB and
 *     schema-validated; anything invalid reads as a free lease;
 *   - the directory is opened once per operation (O_DIRECTORY|O_NOFOLLOW,
 *     must be this user's) and every name inside it is reached through that
 *     fd (/proc/self/fd/<fd>/<name>, the idiom of perch-delivered.js), never
 *     by re-resolving the path;
 *   - no name in it is ever followed: reads open O_NOFOLLOW, writes go to a
 *     random temp name created O_CREAT|O_EXCL|O_NOFOLLOW and renamed over
 *     browser-lease.json (rename replaces a planted symlink, never its target);
 *   - read-modify-write is serialised by lease.lock (O_CREAT|O_EXCL|O_NOFOLLOW,
 *     holding the writer's pid). A lock is broken only when it is older than
 *     5 s AND the pid in it is dead (unreadable content counts as dead).
 *
 * `gen` increases each time the lease passes to a different holder than the
 * one that last had it (kept as lastHolderKey); renewals, releases and the
 * same holder coming back do not bump it.
 */
import {
  closeSync, constants as fs, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

export const LEASE_NAME = "browser-lease.json";
export const LOCK_NAME = "lease.lock";
export const LEASE_READ_CAP = 4096;
export const EXTERNAL_TTL_MS = 120000;
export const OPERATOR_TTL_MS = 300000;   // operator heartbeat loss tolerance: 5 min
export const ORPHAN_CAP_MS = 120000;
export const LOCK_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 2000;
const MAX_TTL_MS = 600000;
const FUTURE_SKEW_MS = 60000;
const MAX_IN_CALL = 8;
const OPERATOR_HOLDER = Object.freeze({ kind: "operator", sessionId: "operator", botId: null });

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,128}$/;

/** The lease directory for an instance: stateDirFn("browser-lease"). */
export function leaseDir(stateDirFn) {
  return stateDirFn("browser-lease");
}

/** Default liveness check: process.kill(pid, 0) semantics (EPERM = alive). */
function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// ─── Validation (everything read from the dir is untrusted) ───

const isSession = (v) => typeof v === "string" && SESSION_RE.test(v) && v !== "." && v !== "..";
const isToken = (v) => typeof v === "string" && TOKEN_RE.test(v);
const isTime = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isPid = (v) => Number.isSafeInteger(v) && v > 0 && v <= 0x3fffffff;

function normHolder(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return undefined;
  if (h.kind !== "bot" && h.kind !== "operator") return undefined;
  if (!isSession(h.sessionId)) return undefined;
  const botId = h.botId == null ? null : h.botId;
  if (botId !== null && !isToken(botId)) return undefined;
  return { kind: h.kind, sessionId: h.sessionId, botId };
}

const holderKey = (h) => h ? h.kind + ":" + h.sessionId : null;

/** A validated, schema-only copy of a parsed lease, or null. */
function validate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Number.isSafeInteger(raw.gen) || raw.gen < 0) return null;
  let holder = null;
  if (raw.holder !== null) { holder = normHolder(raw.holder); if (!holder) return null; }
  if (!Array.isArray(raw.inCall) || raw.inCall.length > MAX_IN_CALL) return null;
  const inCall = [];
  for (const c of raw.inCall) {
    if (!c || typeof c !== "object" || !isToken(c.callId) || !isPid(c.pid)) return null;
    inCall.push({ callId: c.callId, pid: c.pid });
  }
  if (typeof raw.releaseOnCallEnd !== "boolean") return null;
  if (raw.targetId !== null && !isToken(raw.targetId)) return null;
  if (!isTime(raw.since) || !isTime(raw.renewedAt)) return null;
  if (!isTime(raw.ttlMs) || raw.ttlMs <= 0 || raw.ttlMs > MAX_TTL_MS) return null;
  const lastHolderKey = raw.lastHolderKey == null ? null : raw.lastHolderKey;
  if (lastHolderKey !== null && (typeof lastHolderKey !== "string" || lastHolderKey.length > 160)) return null;
  return {
    gen: raw.gen, holder, inCall, releaseOnCallEnd: raw.releaseOnCallEnd,
    targetId: raw.targetId, since: raw.since, renewedAt: raw.renewedAt, ttlMs: raw.ttlMs,
    lastHolderKey,
  };
}

/** Held and not expired at `now` (a renewal stamped far in the future counts as expired). */
function isHeld(lease, now) {
  if (!lease || !lease.holder) return false;
  if (lease.renewedAt > now + FUTURE_SKEW_MS) return false;
  return now - lease.renewedAt <= lease.ttlMs;
}

/** Whether a lease read at `now` is free (null, released, expired or invalid). */
export function isFree(lease, now = Date.now()) {
  return !isHeld(lease, now);
}

// ─── fd-anchored file I/O ───

const at = (dfd, name) => "/proc/self/fd/" + dfd + "/" + name;

/** The lease dir as an fd (never a symlink; must be this user's dir). Caller closes. */
function openDir(dir, { create = false } = {}) {
  if (create) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  const fd = openSync(dir, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW);
  const st = fstatSync(fd);
  if (!st.isDirectory() || st.uid !== process.getuid()) {
    closeSync(fd);
    throw new Error("lease dir is not this user's directory");
  }
  return fd;
}

/** Read at most `cap` bytes of a regular file `name` in the dir (no follow), or null. */
function readCapped(dfd, name, cap) {
  let fd;
  try { fd = openSync(at(dfd, name), fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > cap) return null;
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > cap) return null;
    return buf.subarray(0, n).toString("utf8");
  } catch { return null; } finally { closeSync(fd); }
}

function readFromDir(dfd) {
  const text = readCapped(dfd, LEASE_NAME, LEASE_READ_CAP);
  if (text == null) return null;
  try { return validate(JSON.parse(text)); } catch { return null; }
}

function writeToDir(dfd, lease) {
  const tmp = "." + LEASE_NAME + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp";
  const fd = openSync(at(dfd, tmp), fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600);
  try {
    try { writeSync(fd, JSON.stringify(lease)); } finally { closeSync(fd); }
    renameSync(at(dfd, tmp), at(dfd, LEASE_NAME));
  } catch (e) {
    try { unlinkSync(at(dfd, tmp)); } catch { /* already gone */ }
    throw e;
  }
}

/** Remove a lock older than LOCK_STALE_MS whose pid is dead. True when it is gone. */
function breakStaleLock(dfd, isAlive) {
  let st;
  try { st = lstatSync(at(dfd, LOCK_NAME)); } catch (e) { return e.code === "ENOENT"; }
  if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
  const text = st.isFile() ? readCapped(dfd, LOCK_NAME, 64) : null;
  const m = text && /^(\d{1,10})\n?$/.exec(text);
  const pid = m ? Number(m[1]) : null;
  if (pid !== null && isPid(pid) && isAlive(pid)) return false;
  try {
    const again = lstatSync(at(dfd, LOCK_NAME));
    if (again.ino !== st.ino || again.dev !== st.dev) return false;   // replaced meanwhile: re-check next round
    unlinkSync(at(dfd, LOCK_NAME));
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn(current, dfd)` under lease.lock. `fn` returns the lease to write
 * (or undefined to leave the file alone) and the result to return.
 */
async function withLock(dir, opts, fn) {
  const isAlive = opts.isAlive || defaultIsAlive;
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const dfd = openDir(dir, { create: true });
  try {
    const deadline = Date.now() + lockTimeoutMs;
    let lockId = null;
    for (;;) {
      try {
        const fd = openSync(at(dfd, LOCK_NAME), fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600);
        try {
          writeSync(fd, process.pid + "\n");
          const st = fstatSync(fd);
          lockId = { dev: st.dev, ino: st.ino };
        } finally { closeSync(fd); }
        break;
      } catch (e) {
        if (lockId) throw e;
        if (e.code !== "EEXIST") throw e;
      }
      if (breakStaleLock(dfd, isAlive)) continue;
      if (Date.now() >= deadline) {
        const err = new Error("the browser lease is locked");
        err.code = "ELEASELOCKED";
        throw err;
      }
      await sleep(5 + Math.floor(Math.random() * 15));
    }
    try {
      const { write, result } = fn(readFromDir(dfd));
      if (write) writeToDir(dfd, write);
      return result;
    } finally {
      try {
        const st = lstatSync(at(dfd, LOCK_NAME));
        if (st.ino === lockId.ino && st.dev === lockId.dev) unlinkSync(at(dfd, LOCK_NAME));
      } catch { /* broken by someone else; nothing of ours to remove */ }
    }
  } finally { closeSync(dfd); }
}

function freeRecord(cur) {
  return {
    gen: cur ? cur.gen : 0, holder: null, inCall: [], releaseOnCallEnd: false,
    targetId: null, since: cur ? cur.since : 0, renewedAt: cur ? cur.renewedAt : 0,
    ttlMs: cur ? cur.ttlMs : EXTERNAL_TTL_MS, lastHolderKey: cur ? cur.lastHolderKey : null,
  };
}

/** `cur` handed to `holder` at `now`: renew the same holder, or a new holding. */
function take(cur, holder, now, ttlMs) {
  const key = holderKey(holder);
  if (cur && isHeld(cur, now) && holderKey(cur.holder) === key) {
    return { lease: { ...cur, holder, releaseOnCallEnd: false, renewedAt: now, ttlMs, lastHolderKey: key }, genChanged: false };
  }
  const prevKey = cur ? (cur.holder ? holderKey(cur.holder) : cur.lastHolderKey) : null;
  const changed = prevKey !== key;
  const gen = (cur ? cur.gen : 0) + (changed ? 1 : 0);
  const lease = {
    gen, holder, inCall: [], releaseOnCallEnd: false, targetId: null,
    since: now, renewedAt: now, ttlMs, lastHolderKey: key,
  };
  return { lease, genChanged: changed && prevKey !== null };
}

function checkHolder(holder) {
  const h = normHolder(holder);
  if (!h) throw new Error("bad lease holder");
  return h;
}

function checkTtl(ttlMs) {
  if (!isTime(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new Error("bad lease ttl");
  return ttlMs;
}

// ─── Public API ───

/** The current lease, lock-free (atomic rename gives whole files); invalid or missing → null (free). */
export async function readLease(dir) {
  let dfd;
  try { dfd = openDir(dir); } catch { return null; }
  try { return readFromDir(dfd); } finally { closeSync(dfd); }
}

/**
 * Take or renew the lease for `holder` ({ kind, sessionId, botId? }).
 * → { ok: true, lease, genChanged } | { ok: false, reason: "busy"|"operator", lease }
 * genChanged: someone else had the lease since this holder last did.
 */
export async function acquire(dir, holder, { now = Date.now(), ttlMs = EXTERNAL_TTL_MS, ...opts } = {}) {
  const h = checkHolder(holder);
  checkTtl(ttlMs);
  return withLock(dir, opts, (cur) => {
    if (cur && isHeld(cur, now) && holderKey(cur.holder) !== holderKey(h)) {
      return { result: { ok: false, reason: cur.holder.kind === "operator" ? "operator" : "busy", lease: cur } };
    }
    const { lease, genChanged } = take(cur, h, now, ttlMs);
    return { write: lease, result: { ok: true, lease, genChanged } };
  });
}

/** Mark a tool call in flight for the holder (and record its page's targetId). Throws when not the holder. */
export async function beginCall(dir, holder, { callId, pid, targetId, now = Date.now(), ...opts } = {}) {
  const h = checkHolder(holder);
  if (!isToken(callId) || !isPid(pid)) throw new Error("bad call");
  if (targetId != null && !isToken(targetId)) throw new Error("bad target id");
  return withLock(dir, opts, (cur) => {
    if (!cur || !isHeld(cur, now) || holderKey(cur.holder) !== holderKey(h)) {
      const err = new Error("not the lease holder");
      err.code = "ENOTHOLDER";
      throw err;
    }
    const inCall = cur.inCall.filter((c) => c.callId !== callId);
    inCall.push({ callId, pid });
    while (inCall.length > MAX_IN_CALL) inCall.shift();
    const lease = { ...cur, inCall, renewedAt: now, targetId: targetId != null ? targetId : cur.targetId };
    return { write: lease, result: lease };
  });
}

/**
 * The call ended. Releases the lease when a release was deferred
 * (releaseOnCallEnd) and no other call is in flight. When the holder changed
 * meanwhile (the operator took over), the lease is returned untouched.
 */
export async function endCall(dir, holder, { callId, now = Date.now(), ...opts } = {}) {
  const h = checkHolder(holder);
  return withLock(dir, opts, (cur) => {
    if (!cur || !cur.holder || holderKey(cur.holder) !== holderKey(h)) return { result: cur };
    const inCall = cur.inCall.filter((c) => c.callId !== callId);
    if (cur.releaseOnCallEnd && inCall.length === 0) {
      const lease = freeRecord(cur);
      return { write: lease, result: lease };
    }
    const lease = { ...cur, inCall, renewedAt: Math.max(cur.renewedAt, now) };
    return { write: lease, result: lease };
  });
}

/**
 * Release the session's lease → "released" | "deferred" | "none".
 * A call still in flight with a live pid defers it (releaseOnCallEnd); a dead
 * pid, or orphanCapMs since the last renewal, releases it anyway.
 */
export async function release(dir, sessionId, { orphanCapMs = ORPHAN_CAP_MS, isAlive = defaultIsAlive, now = Date.now(), ...opts } = {}) {
  return withLock(dir, { ...opts, isAlive }, (cur) => {
    if (!cur || !cur.holder || cur.holder.sessionId !== sessionId) return { result: "none" };
    const live = cur.inCall.filter((c) => isAlive(c.pid));
    if (live.length > 0 && now - cur.renewedAt <= orphanCapMs) {
      return { write: { ...cur, inCall: live, releaseOnCallEnd: true }, result: "deferred" };
    }
    return { write: freeRecord(cur), result: "released" };
  });
}

/** The operator takes the lease (in-flight calls are dropped from it; their endCall sees the change). */
export async function takeOperator(dir, { now = Date.now(), ...opts } = {}) {
  return withLock(dir, opts, (cur) => {
    const { lease } = take(cur, { ...OPERATOR_HOLDER }, now, OPERATOR_TTL_MS);
    return { write: lease, result: lease };
  });
}

/** The operator hands the browser back (the lease becomes free). → the lease, or null when there is none. */
export async function handBack(dir, opts = {}) {
  return withLock(dir, opts, (cur) => {
    if (!cur || !cur.holder || cur.holder.kind !== "operator") return { result: cur };
    const lease = freeRecord(cur);
    return { write: lease, result: lease };
  });
}

/** The operator's heartbeat renews an operator holding. → the lease, or null when there is none. */
export async function heartbeat(dir, { now = Date.now(), ...opts } = {}) {
  return withLock(dir, opts, (cur) => {
    if (!cur || !cur.holder || cur.holder.kind !== "operator" || !isHeld(cur, now)) return { result: cur };
    const lease = { ...cur, renewedAt: now };
    return { write: lease, result: lease };
  });
}
