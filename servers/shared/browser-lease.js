/**
 * The shared browser lease: one advisory lease file through which bots'
 * browser MCP servers and the gateway take turns on the one shared page.
 *
 * Advisory, not a privacy boundary: a bot with a shell can reach CDP directly,
 * and nothing private depends on this file.
 *
 * The lease directory (stateDir("browser-lease"), or "app-lease-<id>" for
 * another desktop app: leaseDir) is writable by bots (the
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
 * one that last had it (kept as lastHolderKey). By design it does NOT bump on
 * release, on renewal, or when the same holder takes it again after a release
 * or an expiry: only a change of hands moves it.
 *
 * Two clocks: lease times (since, renewedAt, ttl and orphan checks) use the
 * caller's `now` (injectable for tests); lock staleness uses the real clock
 * (Date.now() against the lock file's mtime), since it is about real
 * processes racing on real files.
 *
 * Lock-breaking options (every write function takes them in its options):
 *   - isAlive(pid): liveness check (default process.kill(pid, 0) semantics);
 *   - lockTimeoutMs: how long to wait for the lock before ELEASELOCKED (2 s);
 *   - forceBreakAfterMs: a lock older than this is broken whatever its pid
 *     (the gateway passes 30000). Pid liveness alone can be fooled: a pid can
 *     be reused by an unrelated live process, or a bot can plant a lock naming
 *     a live pid, so without this a lock may never be broken.
 */
import {
  closeSync, constants as fs, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, rmdirSync, unlinkSync, writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

export const LEASE_NAME = "browser-lease.json";
export const LOCK_NAME = "lease.lock";
export const LEASE_READ_CAP = 4096;
export const EXTERNAL_TTL_MS = 120000;
export const OPERATOR_TTL_MS = 300000;   // operator heartbeat loss tolerance: 5 min
export const ORPHAN_CAP_MS = 120000;
export const LOCK_STALE_MS = 5000;
/** A take-over request waits ≤ 30 s for an in-flight call; its flag is honoured this long after it was last set. */
export const PENDING_OPERATOR_TTL_MS = 35000;
const LOCK_FUTURE_SKEW_MS = 2000;
const LOCK_TIMEOUT_MS = 2000;
const MAX_TTL_MS = 600000;
const FUTURE_SKEW_MS = 60000;
const MAX_IN_CALL = 8;
const OPERATOR_HOLDER = Object.freeze({ kind: "operator", sessionId: "operator", botId: null });

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,128}$/;

/** An app id a lease directory may be named after (R1.2 PR 5). */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The lease directory for an instance's app. "browser" (the default) keeps
 * stateDirFn("browser-lease"), so nothing installed moves; any other app gets
 * stateDirFn("app-lease-" + appId). A bad app id throws.
 */
export function leaseDir(stateDirFn, appId = "browser") {
  if (appId === "browser") return stateDirFn("browser-lease");
  if (typeof appId !== "string" || !APP_ID_RE.test(appId)) {
    throw Object.assign(new Error("bad app id"), { code: "EBADAPPID" });
  }
  return stateDirFn("app-lease-" + appId);
}

/**
 * enforced.json: a bundle whose server enforces the lease says so at startup
 * ({ v: 1, bundleVersion, at }). Bots can write this directory too, so the
 * marker is never trusted alone: a forged one could make the UI claim the
 * operator holds an app the bot still drives. The gateway offers Take over
 * only for apps on its own allowlist of known enforcers
 * (servers/gateway/apps/app-tile.js LEASE_ENFORCERS), at or past their first
 * enforcing version, AND with this marker for the installed version.
 */
export const ENFORCED_NAME = "enforced.json";
const ENFORCED_CAP = 512;
const VERSION_RE = /^[0-9A-Za-z.+_-]{1,64}$/;

/** Write enforced.json atomically (temp + rename, never through a planted name). Throws on failure. */
export function writeEnforced(dir, { bundleVersion, now = Date.now() } = {}) {
  if (typeof bundleVersion !== "string" || !VERSION_RE.test(bundleVersion)) throw new Error("bad bundle version");
  const dfd = openDir(dir, { create: true });
  try {
    const tmp = "." + ENFORCED_NAME + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp";
    const fd = openSync(at(dfd, tmp), fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600);
    try {
      try { writeSync(fd, JSON.stringify({ v: 1, bundleVersion, at: now })); } finally { closeSync(fd); }
      renameSync(at(dfd, tmp), at(dfd, ENFORCED_NAME));
    } catch (e) {
      try { unlinkSync(at(dfd, tmp)); } catch { /* already gone */ }
      throw e;
    }
  } finally { closeSync(dfd); }
}

/** enforced.json, schema-checked: { v: 1, bundleVersion, at } or null (missing, too big, invalid). */
export function readEnforced(dir) {
  let dfd;
  try { dfd = openDir(dir); } catch { return null; }
  try {
    const text = readCapped(dfd, ENFORCED_NAME, ENFORCED_CAP);
    if (text == null) return null;
    let raw;
    try { raw = JSON.parse(text); } catch { return null; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1) return null;
    if (typeof raw.bundleVersion !== "string" || !VERSION_RE.test(raw.bundleVersion)) return null;
    if (!isTime(raw.at)) return null;
    return { v: 1, bundleVersion: raw.bundleVersion, at: raw.at };
  } finally { closeSync(dfd); }
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
  if (raw.pendingOperator != null && !isTime(raw.pendingOperator)) return null;
  const out = {
    gen: raw.gen, holder, inCall, releaseOnCallEnd: raw.releaseOnCallEnd,
    targetId: raw.targetId, since: raw.since, renewedAt: raw.renewedAt, ttlMs: raw.ttlMs,
    lastHolderKey,
  };
  // Present only while the operator's take-over waits (absent = none).
  if (raw.pendingOperator != null) out.pendingOperator = raw.pendingOperator;
  return out;
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

/** A take-over request is waiting for the in-flight calls to end (set at most 35 s ago; a far-future stamp does not count). */
export function isPendingOperator(lease, now = Date.now()) {
  const t = lease ? lease.pendingOperator : null;
  if (!isTime(t) || t > now + FUTURE_SKEW_MS) return false;
  return now - t <= PENDING_OPERATOR_TTL_MS;
}

/** No new bot call may start: the operator holds the browser, or is about to. */
export function operatorBlocks(lease, now = Date.now()) {
  if (!lease) return false;
  if (lease.holder && lease.holder.kind === "operator" && isHeld(lease, now)) return true;
  return isPendingOperator(lease, now);
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
/**
 * A lock's age on the real clock. An mtime more than LOCK_FUTURE_SKEW_MS in
 * the future can only be planted (we always write "now"), so it counts as
 * infinitely old: stale, and force-breakable.
 */
function lockAge(st) {
  const age = Date.now() - st.mtimeMs;
  return age < -LOCK_FUTURE_SKEW_MS ? Infinity : age;
}

function breakStaleLock(dfd, { isAlive, forceBreakAfterMs, onBeforeBreak }) {
  let st;
  try { st = lstatSync(at(dfd, LOCK_NAME)); } catch (e) { return e.code === "ENOENT"; }
  if (lockAge(st) <= LOCK_STALE_MS) return false;
  const forced = forceBreakAfterMs != null && lockAge(st) > forceBreakAfterMs;
  // A planted directory is never ours: only a forced break removes it, and
  // only when it is empty (rmdir, never recursive).
  if (st.isDirectory() && !forced) return false;
  if (!forced) {
    // Pid liveness can be fooled by pid reuse (or a planted live pid): see forceBreakAfterMs.
    const text = st.isFile() ? readCapped(dfd, LOCK_NAME, 64) : null;
    const m = text && /^(\d{1,10})\n?$/.exec(text);
    const pid = m ? Number(m[1]) : null;
    if (pid !== null && isPid(pid) && isAlive(pid)) return false;
  }
  if (onBeforeBreak) onBeforeBreak();   // test seam: the race window between the check and the unlink
  try {
    const again = lstatSync(at(dfd, LOCK_NAME));
    // Same file AND unchanged AND still stale: inodes are reused (ext4), so a
    // fresh lock another breaker just created can carry the same dev/ino.
    if (again.ino !== st.ino || again.dev !== st.dev || again.mtimeMs !== st.mtimeMs
        || again.ctimeMs !== st.ctimeMs || lockAge(again) <= LOCK_STALE_MS) return false;
    if (again.isDirectory()) rmdirSync(at(dfd, LOCK_NAME));
    else unlinkSync(at(dfd, LOCK_NAME));
  } catch (e) {
    // Not removable (non-empty dir, EPERM, ...): not broken; the waiter ends in ELEASELOCKED.
    return e.code === "ENOENT";
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn(current, dfd)` under lease.lock. `fn` returns the lease to write
 * (or undefined to leave the file alone) and the result to return.
 */
async function withLock(dir, opts, fn) {
  const breakOpts = {
    isAlive: opts.isAlive || defaultIsAlive,
    forceBreakAfterMs: opts.forceBreakAfterMs ?? null,
    onBeforeBreak: opts._onBeforeBreak || null,
  };
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const dfd = openDir(dir, { create: true });
  try {
    const deadline = Date.now() + lockTimeoutMs;
    let lockId = null;
    for (;;) {
      try {
        const fd = openSync(at(dfd, LOCK_NAME), fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW, 0o600);
        let mine = null;
        try {
          const st = fstatSync(fd);
          mine = { dev: st.dev, ino: st.ino };
          writeSync(fd, process.pid + "\n");
          lockId = mine;
        } catch (e) {
          // Created but not usable: remove our own lock (only if it is still ours) before rethrowing.
          try {
            const cur = lstatSync(at(dfd, LOCK_NAME));
            if (!mine || (cur.ino === mine.ino && cur.dev === mine.dev)) unlinkSync(at(dfd, LOCK_NAME));
          } catch { /* gone */ }
          e.lockCreated = true;
          throw e;
        } finally { closeSync(fd); }
        break;
      } catch (e) {
        if (e.lockCreated || e.code !== "EEXIST") throw e;
      }
      if (breakStaleLock(dfd, breakOpts)) continue;
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
  const out = {
    gen: cur ? cur.gen : 0, holder: null, inCall: [], releaseOnCallEnd: false,
    targetId: null, since: cur ? cur.since : 0, renewedAt: cur ? cur.renewedAt : 0,
    ttlMs: cur ? cur.ttlMs : EXTERNAL_TTL_MS, lastHolderKey: cur ? cur.lastHolderKey : null,
  };
  // A waiting take-over survives the release, so no other bot slips in before the switch.
  if (cur && cur.pendingOperator != null) out.pendingOperator = cur.pendingOperator;
  return out;
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
 * The current lease read UNDER the lock (no write): what the gateway checks
 * before its final shot (spec §4.5), so no writer is mid-change while it decides.
 */
export async function readLeaseLocked(dir, opts = {}) {
  return withLock(dir, opts, (cur) => ({ result: cur }));
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
    // The operator asked for the browser: no new bot call starts (it waits like an operator holding).
    if (h.kind !== "operator" && isPendingOperator(cur, now)) {
      return { result: { ok: false, reason: "operator", lease: cur } };
    }
    const { lease, genChanged } = take(cur, h, now, ttlMs);
    return { write: lease, result: { ok: true, lease, genChanged } };
  });
}

/**
 * Renew the holder's lease only if it still holds it (checked under the lock).
 * → the renewed lease, or null when it is free, expired or someone else's
 * (never takes a lease).
 */
export async function renewIfHeld(dir, holder, { now = Date.now(), ttlMs = EXTERNAL_TTL_MS, ...opts } = {}) {
  const h = checkHolder(holder);
  checkTtl(ttlMs);
  return withLock(dir, opts, (cur) => {
    if (!cur || !isHeld(cur, now) || holderKey(cur.holder) !== holderKey(h)) return { result: null };
    const lease = { ...cur, renewedAt: Math.max(cur.renewedAt, now), ttlMs };
    return { write: lease, result: lease };
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
    // A take-over is waiting: only a call already in flight may update its entry.
    if (isPendingOperator(cur, now) && !cur.inCall.some((c) => c.callId === callId)) {
      const err = new Error("the operator is taking the browser");
      err.code = "EPENDINGOPERATOR";
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
    // Renew only a live holding; an expired lease just loses the call.
    const lease = isHeld(cur, now) ? { ...cur, inCall, renewedAt: Math.max(cur.renewedAt, now) } : { ...cur, inCall };
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
    // Never frees an operator holding: the operator's path is handBack only.
    if (!cur || !cur.holder || cur.holder.kind === "operator" || cur.holder.sessionId !== sessionId) return { result: "none" };
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

/**
 * The operator takes the lease only when no bot call is in flight (checked
 * under the lock, so a call cannot begin between the check and the take).
 * → { taken: true, lease } | { taken: false, lease } (a live bot holding with
 * a live pid in inCall). Dead pids do not count. An expired or free lease, or
 * the operator's own, is taken (renewed).
 *
 * allowHolderSession (a "?take-over=1" link's chat): when given, another
 * bot's live holding (a bot whose sessionId is not this one) is refused
 * here, under the lock → { taken: false, reason: "other_bot", lease }, with
 * nothing written (no take, no pending flag). Decided at take time, so a bot
 * that acquires after the link's own check still keeps its browser. Absent:
 * exactly the behaviour above.
 */
export async function takeOperatorIfIdle(dir, { now = Date.now(), isAlive = defaultIsAlive, allowHolderSession, ...opts } = {}) {
  return withLock(dir, { ...opts, isAlive }, (cur) => {
    if (typeof allowHolderSession === "string" && cur && isHeld(cur, now)
        && cur.holder.kind === "bot" && cur.holder.sessionId !== allowHolderSession) {
      return { result: { taken: false, reason: "other_bot", lease: cur } };
    }
    if (cur && isHeld(cur, now) && cur.holder.kind !== "operator" && cur.inCall.some((c) => isAlive(c.pid))) {
      // Not yet: mark the request, so no NEW bot call starts while this one finishes.
      const lease = { ...cur, pendingOperator: now };
      return { write: lease, result: { taken: false, lease } };
    }
    const { lease } = take(cur, { ...OPERATOR_HOLDER }, now, OPERATOR_TTL_MS);
    return { write: lease, result: { taken: true, lease } };
  });
}

/** The take-over request ended without taking the browser: drop its flag. → the lease (or null). */
export async function clearPendingOperator(dir, opts = {}) {
  return withLock(dir, opts, (cur) => {
    if (!cur || cur.pendingOperator == null) return { result: cur };
    const lease = { ...cur };
    delete lease.pendingOperator;
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
