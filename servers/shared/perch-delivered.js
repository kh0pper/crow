/**
 * The gateway-owned staging dir for files a bot SENT (send_user_file):
 * <CROW_HOME>/perch-delivered/<sessionId>/<name>.
 *
 * The copy runs on the host, outside the bot's sandbox, so it must never
 * write through anything the bot can steer. The bot's own outputs dir is
 * writable by the bot (and so are its parents), so delivered copies live here
 * instead:
 *   - the pi sandbox hides this root from bubblewrapped bots (a read-only
 *     tmpfs, like <CROW_HOME>/secrets), so a bot can neither see nor plant;
 *   - the root is ANCHORED by (dev, ino) when the engine starts; every later
 *     open checks the fd against the anchor, so a root renamed away and
 *     replaced (the bot renaming an ancestor on the host) is refused;
 *   - every component below the root is opened from the anchored root fd with
 *     O_DIRECTORY|O_NOFOLLOW (through /proc/self/fd/<fd>), and files are
 *     created with O_CREAT|O_EXCL|O_NOFOLLOW: no path is resolved twice.
 * The workspace route serves from here (perch-interactive-api.js).
 */
import { closeSync, constants as fs, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

export const DELIVERED_DIRNAME = "perch-delivered";

let anchor = null;   // { path, dev, ino }

export function deliveredRootPath(crowHome) {
  return join(crowHome, DELIVERED_DIRNAME);
}

/** A session id as one safe path component. */
function safeComponent(name) {
  const s = String(name || "");
  return /^[A-Za-z0-9._-]{1,128}$/.test(s) && s !== "." && s !== "..";
}

/**
 * Create (700) and anchor the staging root. Called once by the engine at
 * start. Refuses a root that is not a real directory owned by this user.
 */
export function registerDeliveredRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error("staging root is not this user's directory");
  anchor = { path: root, dev: st.dev, ino: st.ino };
  return anchor;
}

export function deliveredAnchor() { return anchor; }

/** The anchored root's fd (O_DIRECTORY|O_NOFOLLOW), checked against the anchor. */
function openRoot() {
  if (!anchor) throw new Error("no staging root");
  const fd = openSync(anchor.path, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW);
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
  return anchor ? join(anchor.path, String(sessionId)) : null;
}

/** Test seam. */
export function _resetDeliveredForTest() { anchor = null; }
