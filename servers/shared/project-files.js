/**
 * project-files.js — the path-safety and I/O core behind the crow-projects
 * server's `crow_project_file_list` / `_read` / `_write` / `_delete` tools.
 *
 * No MCP coupling: a tool handler resolves the caller, the project row and the
 * audit row, then hands this module a workspace folder. Everything here is a
 * plain function of (workspace folder, relative path, bytes), so it can be
 * unit-tested directly and cannot be widened by a future tool.
 *
 * THE FOLDER. A project's files live in `project_spaces.workspace_dir`
 * (`<data dir>/projects/<slug>-<id>/workspace`). Before anything is opened the
 * folder is realpath'd and required to sit INSIDE this instance's data dir: a
 * row naming `/etc` (a hand-edited DB, a restored backup) is refused rather
 * than read.
 *
 * PATH RULES. A caller's `path` is relative to that folder and is checked as a
 * list of components: no absolute path, no NUL, no backslash, no empty
 * component (so no trailing slash and no `//`), no `.` or `..`, no control
 * character, no component starting with `.git`, and no `bots` as the TOP-level
 * component (`<workspace>/bots/<id>` is a bot's own world, not project
 * content). The history git dir lives outside the workspace
 * (`<data>/history/workspaces/<id>-<uuid>.git`), so the `.git` rule covers a
 * workspace that is itself a repository.
 *
 * RACE SAFETY. Realpath-then-open is a two-step, and a path component can be
 * swapped for a symlink in between. So no path is ever resolved twice:
 *
 *   - the workspace root is opened once with O_RDONLY|O_DIRECTORY|O_NOFOLLOW
 *     and its fd's kernel path (`/proc/self/fd/<fd>`) must still be the root;
 *   - every component below it is opened FROM THE PARENT'S FD
 *     (`/proc/self/fd/<parent fd>/<name>`) with O_NOFOLLOW, so a link is
 *     refused (ELOOP) instead of followed, and a directory swapped after it
 *     was opened is still the directory that was checked;
 *   - each opened fd's kernel path is re-read and must be under the root: a
 *     directory renamed out of the workspace (or deleted) is refused, because
 *     readlink then answers a path outside the root (or `… (deleted)`).
 *
 * Writes follow the atomic recipe the rest of the repo uses: a temp file in
 * the SAME directory, created O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW at 0600,
 * written, fsynced, fchmod'd to 0640, then renamed onto the target through the
 * same directory fd. A symlink, a folder, a FIFO, a device or a hard-linked
 * file at the target refuses the write; nothing is truncated in place, so a
 * failed write (quota, size cap, conflict, I/O error) leaves the old file
 * exactly as it was.
 *
 * QUOTA. `CROW_PROJECT_FILE_QUOTA_MB` (default 500) caps the total bytes in
 * one workspace. It is measured with a bounded walk (entry and time capped);
 * a walk that cannot finish refuses the write instead of guessing. The walk is
 * a measurement, not a security boundary: it never enters a symlink, so a
 * planted link can hide bytes from the count, never add reachable ones.
 */

import {
  closeSync,
  constants as FS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { resolveDataDir } from "../db.js";

/** Every limit a call obeys. Sized for an MCP round trip, not for bulk sync. */
export const PROJECT_FILE_LIMITS = Object.freeze({
  /** Bytes one read may return. Use offset + max_bytes for more. */
  readBytes: 1024 * 1024,
  /** Bytes one write may carry. */
  writeBytes: 5 * 1024 * 1024,
  /** Entries one listing may return. */
  listEntries: 2000,
  /** Folder depth a recursive listing descends (below the listed folder). */
  listDepth: 8,
  /** Default per-project quota, in MiB (CROW_PROJECT_FILE_QUOTA_MB overrides). */
  quotaMb: 500,
  /** Longest accepted relative path, in characters. */
  pathChars: 4096,
  /** Longest accepted single component, in characters. */
  componentChars: 255,
  /** A file bigger than this is refused for an if_match_sha256 comparison. */
  hashBytes: 32 * 1024 * 1024,
  /** The quota walk gives up (and the write is refused) past these. */
  quotaWalkEntries: 200_000,
  quotaWalkMs: 1000,
});

/** The encodings the read/write tools accept. */
export const PROJECT_FILE_ENCODINGS = Object.freeze(["utf8", "base64"]);

/** The top-level folder of bot worlds: never project content. */
export const INTERNAL_TOP_DIR = "bots";

/** A fixed, project-name-free message per code; the tool result carries `.message`. */
const MESSAGES = Object.freeze({
  invalid_path: "That path is not a relative path inside the project's workspace.",
  not_found: "There is nothing at that path.",
  not_directory: "A part of that path is not a folder.",
  not_file: "That path is not a regular file.",
  not_empty: "That folder is not empty; deleting folders recursively is not available.",
  no_workspace: "This project has no usable workspace folder.",
  outside_root: "That path leads outside the project's workspace folder.",
  forbidden: "That path cannot be opened.",
  unavailable: "That path could not be read or written.",
  too_large: "That request is larger than the file tools allow.",
  quota: "This project's workspace is over its size quota.",
  conflict: "That file changed since it was read; read it again before writing.",
  invalid_argument: "That argument is not valid for this call.",
});

/** A refusal the tools turn into `Error: <message>`; `code` is for logs and tests. */
export class ProjectFileError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || MESSAGES.invalid_argument);
    this.name = "ProjectFileError";
    this.code = Object.prototype.hasOwnProperty.call(MESSAGES, code) ? code : "invalid_argument";
  }
}

function fail(code, message) {
  throw new ProjectFileError(code, message);
}

/** The instance data dir, resolved the way project creation resolves it. */
export function projectFileDataDir(env = process.env) {
  const e = env || {};
  // services/shared/project-spaces.js writes workspace_dir under
  // dirname(CROW_DB_PATH) when that env names a database, else under
  // resolveDataDir(): the containment check must use the same rule or a custom
  // CROW_DB_PATH install would refuse its own workspaces.
  return e.CROW_DB_PATH ? resolve(e.CROW_DB_PATH, "..") : resolveDataDir();
}

/** The per-project quota in bytes: CROW_PROJECT_FILE_QUOTA_MB, default 500 MiB. */
export function projectFileQuotaBytes(env = process.env) {
  const raw = Number((env || {}).CROW_PROJECT_FILE_QUOTA_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : PROJECT_FILE_LIMITS.quotaMb;
  return Math.floor(mb * 1024 * 1024);
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Is `name` one of the internal entries a listing omits and a path may not name? */
export function isInternalName(name, { top = false } = {}) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  if (n.startsWith(".git")) return true;
  return top && n === INTERNAL_TOP_DIR;
}

/**
 * A caller's relative path as its components. Throws ProjectFileError
 * `invalid_path` for anything the rules above refuse. `allowEmpty` accepts ""
 * or undefined as "the workspace root" (a listing of nothing in particular).
 *
 * @param {string|undefined|null} value
 * @param {{allowEmpty?: boolean}} [opts]
 * @returns {string[]}
 */
export function parseRelPath(value, { allowEmpty = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (allowEmpty) return [];
    fail("invalid_path", "A path is required.");
  }
  if (typeof value !== "string") fail("invalid_path", "A path must be text.");
  if (value.length > PROJECT_FILE_LIMITS.pathChars) fail("invalid_path", "That path is too long.");
  if (value.includes("\u0000")) fail("invalid_path", "That path contains a null byte.");
  if (value.includes("\\")) fail("invalid_path", "A path uses / as its separator; backslashes are not allowed.");
  if (isAbsolute(value)) fail("invalid_path", "A path is relative to the project's workspace folder, not absolute.");
  const parts = value.split("/");
  for (const part of parts) {
    if (part === "") fail("invalid_path", "That path has an empty component; leave out the trailing slash and any double slash.");
    if (part === "." || part === "..") fail("invalid_path", "That path contains a . or .. component.");
    if (part.length > PROJECT_FILE_LIMITS.componentChars) fail("invalid_path", "A component of that path is too long.");
    if (CONTROL_RE.test(part)) fail("invalid_path", "That path contains a control character.");
  }
  for (let i = 0; i < parts.length; i++) {
    if (isInternalName(parts[i], { top: i === 0 })) {
      fail("invalid_path", "That path names a folder the project's file tools keep out of reach.");
    }
  }
  return parts;
}

/** A sha256 argument: 64 lowercase hex characters. */
export function normalizeSha256(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) fail("invalid_argument", "if_match_sha256 must be a sha256 as 64 hex characters.");
  return s;
}

const errnoOf = (err) => (err && typeof err.code === "string" ? err.code : "");

/** `child` is `parent` or below it (both absolute, neither trailing-slashed). */
function inside(child, parent) {
  const p = parent.endsWith(sep) ? parent.slice(0, -sep.length) : parent;
  return child === p || child.startsWith(p + sep);
}

function strictlyInside(child, parent) {
  const p = parent.endsWith(sep) ? parent.slice(0, -sep.length) : parent;
  return child !== p && child.startsWith(p + sep);
}

function realOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const procPath = (fd) => "/proc/self/fd/" + fd;
const fdPath = (fd, name) => "/proc/self/fd/" + fd + "/" + name;

/** The path the kernel holds for an open fd; null when it cannot be read. */
function kernelPath(fd) {
  try {
    return readlinkSync(procPath(fd));
  } catch {
    return null;
  }
}

/** The fds one call opened, closed in reverse order whatever happened. */
class FdSet {
  constructor() {
    this.fds = [];
  }

  track(fd) {
    this.fds.push(fd);
    return fd;
  }

  close() {
    while (this.fds.length) {
      const fd = this.fds.pop();
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * The workspace root for one call: realpath'd, checked inside this instance's
 * data dir, opened O_DIRECTORY|O_NOFOLLOW with its kernel path confirmed.
 */
function openWorkspaceRoot(workspaceDir, dataDir) {
  if (typeof workspaceDir !== "string" || workspaceDir.trim() === "") fail("no_workspace");
  if (!isAbsolute(workspaceDir)) fail("no_workspace", "This project's workspace folder is not an absolute path.");
  const dataReal = realOf(resolve(String(dataDir || ".")));
  if (!dataReal) fail("no_workspace", "This instance's data folder is not available.");
  const rootReal = realOf(resolve(workspaceDir));
  if (!rootReal) fail("no_workspace", "This project's workspace folder is missing.");
  if (!strictlyInside(rootReal, dataReal)) {
    fail("outside_root", "This project's workspace folder is outside this instance's data folder.");
  }
  let fd;
  try {
    fd = openSync(rootReal, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  } catch {
    fail("no_workspace", "This project's workspace folder cannot be opened.");
  }
  if (kernelPath(fd) !== rootReal) {
    try { closeSync(fd); } catch { /* closed */ }
    fail("outside_root", "This project's workspace folder moved while it was opened.");
  }
  return { fd, real: rootReal };
}

/** Open one directory component from its parent's fd, never following a link. */
function openDirComponent(parentFd, name) {
  try {
    return openSync(fdPath(parentFd, name), FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT") fail("not_found", "There is no such folder in the project's workspace.");
    if (code === "ELOOP" || code === "ENOTDIR") {
      // O_NOFOLLOW on a symlink answers ELOOP, and with O_DIRECTORY in the
      // flags Linux answers ENOTDIR (the link itself is not a folder). Read the
      // name to say which it was; the call is refused either way.
      const st = statEntry(parentFd, name);
      if (st && st.isSymbolicLink()) {
        fail("invalid_path", "A folder in that path is a link, which the file tools do not follow.");
      }
      if (code === "ENOTDIR") fail("not_directory");
      fail("invalid_path", "A folder in that path is a link, which the file tools do not follow.");
    }
    if (code === "EACCES" || code === "EPERM") fail("forbidden");
    fail("unavailable", "That folder could not be opened.");
  }
}

/**
 * The same, with the fd's kernel path checked: a directory renamed (or
 * deleted) after it was opened is refused instead of used.
 */
function openDirAt(fds, parentFd, name, rootReal) {
  const fd = fds.track(openDirComponent(parentFd, name));
  const seen = kernelPath(fd);
  if (seen === null || !inside(seen, rootReal)) fail("outside_root");
  return fd;
}

/** lstat an entry through a directory fd: never the link's target. */
function statEntry(dirFd, name) {
  try {
    return lstatSync(fdPath(dirFd, name), { throwIfNoEntry: false }) || null;
  } catch {
    fail("unavailable", "That path could not be read.");
  }
}

/** A fresh read-only fd on an already-open directory (no path re-resolution). */
function openAt(fds, parentFd, name) {
  let fd;
  try {
    fd = openSync(fdPath(parentFd, name), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT") fail("not_found");
    if (code === "ELOOP") fail("invalid_path", "That path is a link, which the file tools do not follow.");
    if (code === "EACCES" || code === "EPERM") fail("forbidden");
    fail("unavailable", "That file could not be opened.");
  }
  return fds.track(fd);
}

/** The file's stat, or null; refuses links, folders and non-regular files. */
function statRegularFile(dirFd, name) {
  const st = statEntry(dirFd, name);
  if (!st) return null;
  if (st.isSymbolicLink()) fail("invalid_path", "That path is a link, which the file tools do not follow.");
  if (st.isDirectory()) fail("not_file", "That path is a folder, not a file.");
  if (!st.isFile()) fail("not_file", "That path is not a regular file.");
  return st;
}

/** sha256 of an open regular file, streamed; refuses one over the comparison cap. */
function hashOpenFile(fd) {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    let n;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch {
      fail("unavailable", "That file could not be read.");
    }
    if (n <= 0) break;
    total += n;
    if (total > PROJECT_FILE_LIMITS.hashBytes) {
      fail("too_large", "That file is too large to compare; read it again before writing.");
    }
    hash.update(buf.subarray(0, n));
  }
  return hash.digest("hex");
}

/** Bytes under a folder: a bounded walk that never enters a symlink. null = unmeasured. */
function walkBytes(rootReal) {
  let rootStat;
  try {
    rootStat = lstatSync(rootReal);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;
  const rootDev = rootStat.dev;
  const deadline = Date.now() + PROJECT_FILE_LIMITS.quotaWalkMs;
  const stack = [rootReal];
  let total = 0;
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (++seen > PROJECT_FILE_LIMITS.quotaWalkEntries || Date.now() > deadline) return null;
      const path = dir + sep + entry.name;
      let st;
      try {
        st = lstatSync(path, { throwIfNoEntry: false });
      } catch {
        return null;
      }
      if (!st) continue;
      if (entry.isDirectory()) {
        if (st.dev === rootDev) stack.push(path);
      } else {
        total += st.size;
      }
    }
  }
  return total;
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeEncoding(value) {
  if (value === undefined || value === null || value === "") return "utf8";
  const e = String(value).toLowerCase();
  if (!PROJECT_FILE_ENCODINGS.includes(e)) {
    fail("invalid_argument", `encoding must be one of ${PROJECT_FILE_ENCODINGS.join(", ")}.`);
  }
  return e;
}

/** Is this buffer binary? A NUL byte in the returned window is the tell. */
const looksBinary = (buf) => buf.includes(0);

/**
 * The file tools for ONE project folder.
 *
 * @param {{workspaceDir?: string, dataDir?: string, env?: object,
 *          hooks?: {beforeOpen?: Function}}} [opts]
 *   `hooks.beforeOpen({kind, path})` is awaited after the workspace root is
 *   opened and before any component is: a test seam for the resolve-then-swap
 *   race (it is also useful for a future instrumentation point).
 */
export function createProjectFileStore({ workspaceDir, dataDir, env = process.env, hooks = {} } = {}) {
  const hook = hooks && typeof hooks.beforeOpen === "function" ? hooks.beforeOpen : null;

  /** Open the root (and run the hook), returning the fd set the caller closes. */
  async function begin(kind, relPath) {
    const root = openWorkspaceRoot(workspaceDir, dataDir);
    const fds = new FdSet();
    fds.track(root.fd);
    if (hook) {
      try {
        await hook({ kind, path: relPath });
      } catch (err) {
        fds.close();
        throw err;
      }
    }
    return { root, fds };
  }

  /**
   * The folder `parts` names, opened component by component from the root fd.
   * With `createDirs`, a missing folder is made (0750) through its parent's fd
   * first; a name that is a link or a file then refuses in the open.
   */
  function openFolder(fds, root, parts, { createDirs = false } = {}) {
    let fd = root.fd;
    for (const name of parts) {
      try {
        fd = openDirAt(fds, fd, name, root.real);
      } catch (err) {
        if (!createDirs || !(err instanceof ProjectFileError) || err.code !== "not_found") throw err;
        try {
          mkdirSync(fdPath(fd, name), { mode: 0o750 });
        } catch (mkErr) {
          const code = errnoOf(mkErr);
          // EEXIST: something appeared between the open and the mkdir — the
          // open below decides whether it may be used (a link never is).
          if (code !== "EEXIST") {
            if (code === "EACCES" || code === "EPERM") fail("forbidden");
            fail("unavailable", "That folder could not be created.");
          }
        }
        fd = openDirAt(fds, fd, name, root.real);
      }
    }
    return fd;
  }

  return {
    /**
     * One folder's entries (or, with `recursive`, its tree to depth 8).
     * Symlinks are reported as type "link" and never entered; internal
     * folders (.git*, a top-level bots/) are omitted.
     *
     * @returns {Promise<{entries: Array<{path: string, type: string, size: number|null,
     *   mtime: string}>, truncated: boolean, path: string}>}
     */
    async list({ path = "", recursive = false, limit } = {}) {
      const parts = parseRelPath(path, { allowEmpty: true });
      const max = clampInt(limit, { min: 1, max: PROJECT_FILE_LIMITS.listEntries, fallback: 200 });
      const base = parts.join("/");
      const { root, fds } = await begin("list", base);
      try {
        const dirFd = openFolder(fds, root, parts);
        const entries = [];
        let truncated = false;
        // Breadth-first, so a limit cuts the deepest entries first and a
        // recursive listing always returns its own folder whole.
        const queue = [{ fd: dirFd, rel: base, depth: 0 }];
        while (queue.length) {
          const cur = queue.shift();
          let dirents;
          try {
            dirents = readdirSync(procPath(cur.fd), { withFileTypes: true });
          } catch {
            if (cur.depth === 0) fail("unavailable", "That folder could not be read.");
            continue;
          }
          dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          for (const dirent of dirents) {
            if (isInternalName(dirent.name, { top: cur.depth === 0 && base === "" })) continue;
            const rel = cur.rel ? `${cur.rel}/${dirent.name}` : dirent.name;
            const st = statEntry(cur.fd, dirent.name);
            if (!st) continue;
            const type = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
            if (entries.length >= max) {
              truncated = true;
              break;
            }
            entries.push({ path: rel, type, size: st.size, mtime: st.mtime.toISOString() });
            if (!recursive || type !== "dir" || cur.depth + 1 > PROJECT_FILE_LIMITS.listDepth) continue;
            let childFd;
            try {
              childFd = openDirAt(fds, cur.fd, dirent.name, root.real);
            } catch {
              childFd = null; // became a link / vanished: listed, never entered
            }
            if (childFd !== null) queue.push({ fd: childFd, rel, depth: cur.depth + 1 });
          }
          if (truncated) break;
        }
        entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return { entries, truncated, path: base };
      } finally {
        fds.close();
      }
    },

    /**
     * Bytes of one file. UTF-8 text unless `encoding` is "base64"; a binary
     * file is refused as utf8 rather than returned as mojibake.
     *
     * @returns {Promise<{path: string, size: number, offset: number, bytes: number,
     *   encoding: string, content: string, truncated: boolean}>}
     */
    async read({ path, offset = 0, maxBytes, encoding } = {}) {
      const parts = parseRelPath(path);
      const enc = normalizeEncoding(encoding);
      const start = clampInt(offset, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
      const want = clampInt(maxBytes, { min: 1, max: PROJECT_FILE_LIMITS.readBytes, fallback: PROJECT_FILE_LIMITS.readBytes });
      const name = parts[parts.length - 1];
      const rel = parts.join("/");
      const { root, fds } = await begin("read", rel);
      try {
        const parentFd = openFolder(fds, root, parts.slice(0, -1));
        const st = statRegularFile(parentFd, name);
        if (!st) fail("not_found");
        const fd = openAt(fds, parentFd, name);
        const seen = kernelPath(fd);
        if (seen === null || !inside(seen, root.real)) fail("outside_root");
        const fst = fstatSync(fd);
        if (!fst.isFile()) fail("not_file", "That path is not a regular file.");
        const size = fst.size;
        const from = Math.min(start, size);
        const length = Math.min(want, PROJECT_FILE_LIMITS.readBytes, size - from);
        const buf = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          let n;
          try {
            n = readSync(fd, buf, got, length - got, from + got);
          } catch {
            fail("unavailable", "That file could not be read.");
          }
          if (n <= 0) break;
          got += n;
        }
        const chunk = buf.subarray(0, got);
        if (enc === "utf8" && looksBinary(chunk)) {
          fail("invalid_argument", "That file looks binary; pass encoding \"base64\" to read it.");
        }
        return {
          path: rel,
          size,
          offset: from,
          bytes: got,
          encoding: enc,
          content: enc === "base64" ? chunk.toString("base64") : chunk.toString("utf8"),
          truncated: from + got < size,
        };
      } finally {
        fds.close();
      }
    },

    /**
     * Write one file atomically, optionally only when the current bytes are the
     * version the caller saw (`ifMatchSha256`).
     *
     * @returns {Promise<{path: string, size: number, sha256: string, created: boolean}>}
     */
    async write({ path, content, encoding, createDirs = true, ifMatchSha256 } = {}) {
      const parts = parseRelPath(path);
      const enc = normalizeEncoding(encoding);
      const expect = normalizeSha256(ifMatchSha256);
      if (typeof content !== "string") fail("invalid_argument", "content must be text.");
      let bytes;
      if (enc === "base64") {
        const cleaned = content.replace(/[\r\n\t ]/g, "");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) fail("invalid_argument", "content is not valid base64.");
        bytes = Buffer.from(cleaned, "base64");
      } else {
        bytes = Buffer.from(content, "utf8");
      }
      if (bytes.length > PROJECT_FILE_LIMITS.writeBytes) {
        fail("too_large", `That content is larger than the ${PROJECT_FILE_LIMITS.writeBytes / (1024 * 1024)} MiB limit for one write.`);
      }
      const name = parts[parts.length - 1];
      const rel = parts.join("/");
      const { root, fds } = await begin("write", rel);
      let tmpName = null;
      let parentFd = null;
      try {
        parentFd = openFolder(fds, root, parts.slice(0, -1), { createDirs: createDirs !== false });
        const existing = statRegularFile(parentFd, name);
        if (existing && existing.nlink > 1) {
          fail("invalid_path", "That path is hard-linked to another name, so it is never overwritten.");
        }
        if (expect !== null) {
          const current = existing ? hashOpenFile(openAt(fds, parentFd, name)) : null;
          if (current !== expect) fail("conflict");
        }
        const used = walkBytes(root.real);
        if (used === null) fail("quota", "This project's file usage could not be measured, so nothing was written.");
        const after = used - (existing ? existing.size : 0) + bytes.length;
        if (after > projectFileQuotaBytes(env)) {
          fail("quota", `This project's workspace would grow past its ${Math.round(projectFileQuotaBytes(env) / (1024 * 1024))} MiB quota.`);
        }

        tmpName = `.crow-write-${randomBytes(12).toString("hex")}`;
        let tmpFd;
        try {
          tmpFd = openSync(fdPath(parentFd, tmpName), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
        } catch {
          tmpName = null;
          fail("unavailable", "A temporary file could not be created next to that path.");
        }
        try {
          let written = 0;
          while (written < bytes.length) {
            let n;
            try {
              n = writeSync(tmpFd, bytes, written, bytes.length - written);
            } catch {
              fail("unavailable", "That file could not be written.");
            }
            if (n <= 0) fail("unavailable", "That file could not be written.");
            written += n;
          }
          fsyncSync(tmpFd);
          fchmodSync(tmpFd, 0o640);
        } catch (err) {
          try { closeSync(tmpFd); } catch { /* closed */ }
          throw err;
        }
        closeSync(tmpFd);
        // The parent must still be the folder that was checked, right before the
        // rename that makes the new bytes visible under the target's name.
        const seen = kernelPath(parentFd);
        if (seen === null || !inside(seen, root.real)) fail("outside_root");
        try {
          renameSync(fdPath(parentFd, tmpName), fdPath(parentFd, name));
        } catch {
          fail("unavailable", "That file could not be replaced.");
        }
        tmpName = null;
        return {
          path: rel,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          created: !existing,
        };
      } finally {
        // The temp goes first: it is in the SAME folder as the target, through
        // that folder's fd, before any fd is closed.
        if (tmpName !== null && parentFd !== null) {
          try { unlinkSync(fdPath(parentFd, tmpName)); } catch { /* already renamed or gone */ }
        }
        fds.close();
      }
    },

    /**
     * Delete one file, or one EMPTY folder. Never recursive.
     *
     * @returns {Promise<{path: string, type: "file"|"dir", size: number|null, sha256: string|null}>}
     */
    async remove({ path, ifMatchSha256 } = {}) {
      const parts = parseRelPath(path);
      const expect = normalizeSha256(ifMatchSha256);
      const name = parts[parts.length - 1];
      const rel = parts.join("/");
      const { root, fds } = await begin("delete", rel);
      try {
        const parentFd = openFolder(fds, root, parts.slice(0, -1));
        const st = statEntry(parentFd, name);
        if (!st) fail("not_found");
        if (st.isSymbolicLink()) fail("invalid_path", "That path is a link, which the file tools do not follow.");
        if (st.isDirectory()) {
          if (expect !== null) fail("conflict", "A folder has no sha256 to compare.");
          let rest;
          try {
            rest = readdirSync(fdPath(parentFd, name));
          } catch {
            fail("unavailable", "That folder could not be read.");
          }
          if (rest.length > 0) fail("not_empty");
          try {
            rmdirSync(fdPath(parentFd, name));
          } catch {
            fail("unavailable", "That folder could not be removed.");
          }
          return { path: rel, type: "dir", size: null, sha256: null };
        }
        if (!st.isFile()) fail("not_file", "That path is not a regular file.");
        let sha = null;
        if (expect !== null) {
          sha = hashOpenFile(openAt(fds, parentFd, name));
          if (sha !== expect) fail("conflict");
        }
        const seen = kernelPath(parentFd);
        if (seen === null || !inside(seen, root.real)) fail("outside_root");
        try {
          unlinkSync(fdPath(parentFd, name));
        } catch {
          fail("unavailable", "That file could not be removed.");
        }
        return { path: rel, type: "file", size: st.size, sha256: sha };
      } finally {
        fds.close();
      }
    },
  };
}