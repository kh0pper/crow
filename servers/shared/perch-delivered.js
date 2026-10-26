/**
 * The gateway-owned staging dir for files a bot SENT (send_user_file):
 * <CROW_HOME>/secrets/perch-delivered/<sessionId>/<name>.
 *
 * The copy runs on the host, outside the bot's sandbox, so it must never
 * write through anything the bot can steer. The bot's own outputs dir is
 * writable by the bot (and so are its parents), so delivered copies live here
 * instead:
 *   - it sits INSIDE the instance's secrets dir (700, owned by this user),
 *     which the pi sandbox hides from bubblewrapped bots (a read-only tmpfs),
 *     so a bot can neither see nor plant there;
 *   - the root is created and opened through the secrets dir's anchored fd
 *     (secret-values.js anchoredPath) when the engine starts, and its own fd
 *     is held open: every later open goes through that fd, so a root (or an
 *     ancestor) renamed away and replaced is never used;
 *   - every component below the root is opened from the anchored root fd with
 *     O_DIRECTORY|O_NOFOLLOW (through /proc/self/fd/<fd>), and files are
 *     created with O_CREAT|O_EXCL|O_NOFOLLOW: no path is resolved twice.
 * The workspace route serves from here (perch-interactive-api.js).
 */
import { closeSync, constants as fs, fstatSync, mkdirSync, openSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { anchoredPath, secretsDir } from "./secret-values.js";

export const DELIVERED_DIRNAME = "perch-delivered";

let anchor = null;   // { fd, dev, ino }

/** Where the staging root lives (for the sandbox's hide list and docs). */
export function deliveredRootPath(crowHome) {
  return join(secretsDir({ CROW_HOME: crowHome }), DELIVERED_DIRNAME);
}

/** A session id as one safe path component. */
function safeComponent(name) {
  const s = String(name || "");
  return /^[A-Za-z0-9._-]{1,128}$/.test(s) && s !== "." && s !== "..";
}

/**
 * Create (700) and anchor the staging root; its fd stays open. Called once by
 * the engine at start with the instance env (the root is made through the
 * anchored secrets dir), or with a plain dir path (test seams). Refuses a
 * root that is not a real directory owned by this user.
 */
export function registerDeliveredRoot(envOrRoot) {
  const root = typeof envOrRoot === "string" ? envOrRoot : anchoredPath(envOrRoot, DELIVERED_DIRNAME);
  if (!root) throw new Error("no anchored secrets dir");
  try { mkdirSync(root, { mode: 0o700, recursive: typeof envOrRoot === "string" }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const fd = openSync(root, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW);
  const st = fstatSync(fd);
  if (!st.isDirectory() || st.uid !== process.getuid()) { closeSync(fd); throw new Error("staging root is not this user's directory"); }
  if (anchor) { try { closeSync(anchor.fd); } catch { /* closed */ } }
  anchor = { fd, dev: st.dev, ino: st.ino };
  return anchor;
}

export function deliveredAnchor() { return anchor; }

/** A fresh fd on the anchored root (re-opened through the held fd). */
function openRoot() {
  if (!anchor) throw new Error("no staging root");
  const fd = openSync("/proc/self/fd/" + anchor.fd, fs.O_RDONLY | fs.O_DIRECTORY);
  const st = fstatSync(fd);
  if (st.dev !== anchor.dev || st.ino !== anchor.ino) { closeSync(fd); throw new Error("staging root moved"); }
  return fd;
}

/**
 * The session's staging dir as an fd. `create`: make it (700) if missing,
 * through the root fd. Caller closes the fd.
 */
export function openDeliveredDir(sessionId, { create = false } = {}) {
  if (!safeComponent(sessionId)) throw new Error("bad session id");
  const root = openRoot();
  try {
    const p = "/proc/self/fd/" + root + "/" + sessionId;
    if (create) { try { mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
    return openSync(p, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW);
  } finally { closeSync(root); }
}

/** Open one delivered file (flat name, never a symlink) for reading; caller closes. */
export function openDeliveredFile(sessionId, name) {
  const n = String(name || "");
  if (!n || n.length > 255 || n.includes("/") || n.includes("\0") || n.startsWith(".")) throw new Error("bad name");
  const dfd = openDeliveredDir(sessionId);
  try {
    return openSync("/proc/self/fd/" + dfd + "/" + n, fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_NONBLOCK);
  } finally { closeSync(dfd); }
}

/** The session's staging dir path for display / snapshots (never opened by path). */
export function deliveredDirPath(sessionId) {
  if (!anchor) return null;
  try { return join(readlinkSync("/proc/self/fd/" + anchor.fd), String(sessionId)); } catch { return null; }
}

/** Test seam. */
export function _resetDeliveredForTest() {
  if (anchor) { try { closeSync(anchor.fd); } catch { /* closed */ } }
  anchor = null;
}
