/**
 * workspace-index.js — build a commit's tree from the workspace OURSELVES.
 *
 * The history used to be committed with `git add -A`, which asks git to select
 * the files. That gave three ways to lose history, and they are what this walker
 * exists to close:
 *
 *   - an EMPTY nested repository (a bot runs `git init`, `cargo new`, `npm
 *     create`) made `add -A` fail with exit 128 ("does not have a commit checked
 *     out"), so the project silently stopped recording anything;
 *   - a nested repo WITH commits was stored as a gitlink — only the other repo's
 *     HEAD sha, never the files, and a `.git` FILE (`gitdir: <any repo>`) did the
 *     same for any repository on the host;
 *   - the workspace's own `.gitignore` kept new files out of the history, so a
 *     bot could write one and its edits were never recorded or blamed.
 *
 * So the selection is a plain `lstat` walk: every entry that is not `.git`, not
 * denied (workspace-deny.js), not over the size cap and not a socket/fifo/device
 * is recorded — a symlink as a symlink (its target string is the blob), a file by
 * its exact bytes. `.gitignore` and `.gitattributes` are never consulted, and an
 * entry named `.git` is skipped while its SIBLINGS (and the files in its parent)
 * are still recorded.
 *
 * Bytes come in through `hash-object -w --no-filters` (no filters: an attributes
 * file cannot rewrite them), one call per batch of 2000 absolute paths read from
 * `--stdin-paths`. A path with a control character, a quote or a backslash is
 * C-quoted, because git unquotes a stdin line that starts with `"`, and absolute
 * paths are used so a clean path can never start with one.
 *
 * The index is then assembled in a SCRATCH index file (never the real one, which
 * this module does not use at all): `read-tree --empty`, then
 * `update-index --replace -z --index-info` fed `<mode> <sha>\t<path>\0` records,
 * then `write-tree`. Nothing is checked out and nothing reads the work tree again.
 */
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { isDeniedEntry, MAX_FILE_BYTES } from "./workspace-deny.js";

/** How many file paths one hash-object call is fed. */
const HASH_BATCH = 2000;

/** The empty tree's id: the tree of a workspace with nothing in it. */
export const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** git's own index modes for the two kinds of entry this walker records. */
const MODE_FILE = "100644";
const MODE_EXECUTABLE = "100755";
const MODE_SYMLINK = "120000";

/**
 * One path as a line git's `--stdin-paths` reads: verbatim unless it carries a
 * character that would change how git reads the line. A leading `"` makes git
 * unquote the line, so every such path is written as a C-style quoted string.
 * Control characters, DEL, a quote and a backslash are the characters that must
 * be escaped; everything else (including non-ASCII bytes) is written as is.
 */
export function stdinPath(path) {
  const text = String(path);
  const needsQuoting = /["\\\x00-\x1f\x7f]/.test(text);
  if (!needsQuoting) return text;
  let out = "\"";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === "\\") out += "\\\\";
    else if (char === "\"") out += "\\\"";
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += char;
  }
  return out + "\"";
}

/** The mode a regular file is recorded with: any exec bit set means 100755. */
function fileMode(st) {
  const exec = (Number(st.mode) & 0o111) !== 0;
  return exec ? MODE_EXECUTABLE : MODE_FILE;
}

/** An entry the walker does not record: a socket, a fifo, a device, or a type
 *  it does not know. */
function isSpecial(st) {
  return st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice();
}

/** Paths in chunks of at most `size`. */
function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Walk the workspace and hash what it holds.
 *
 * Iterative (a deep tree cannot blow the stack), never following a symlink, and
 * staying on the root's device: a folder that is a mount point on another
 * filesystem is skipped instead of descending into a machine's whole disk.
 *
 * @returns {{files: {path: string, abs: string, mode: string}[], links: {path: string, target: string}[],
 *   skippedLarge: number, skippedOther: number}}
 */
function collect(workspaceDir, maxEntries) {
  const files = [];
  const links = [];
  let skippedLarge = 0;
  let skippedOther = 0;
  let rootDev;
  try {
    rootDev = statSync(workspaceDir, { bigint: true }).dev;
  } catch {
    rootDev = null;
  }
  const stack = [{ abs: workspaceDir, rel: "" }];
  while (stack.length > 0) {
    const dir = stack.pop();
    let names;
    try {
      names = readdirSync(dir.abs);
    } catch {
      skippedOther += 1;
      continue;
    }
    for (const name of names) {
      // `.git` is never recorded, never descended into — but a `.git` FILE is
      // skipped the same way, so a nested repo cannot hide its parent's files.
      if (name.toLowerCase() === ".git") continue;
      const rel = dir.rel === "" ? name : `${dir.rel}/${name}`;
      const abs = join(dir.abs, name);
      let st;
      try {
        st = lstatSync(abs, { bigint: true });
      } catch {
        skippedOther += 1;
        continue;
      }
      const isDir = st.isDirectory();
      if (isDeniedEntry(rel, isDir)) continue;
      if (isDir) {
        // A folder on another device (a mount) is not this workspace's content.
        if (rootDev !== null && st.dev !== rootDev) continue;
        stack.push({ abs, rel });
        continue;
      }
      if (st.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(abs);
        } catch {
          skippedOther += 1;
          continue;
        }
        links.push({ path: rel, target });
      } else if (st.isFile()) {
        if (Number(st.size) > MAX_FILE_BYTES) {
          skippedLarge += 1;
          continue;
        }
        files.push({ path: rel, abs, mode: fileMode(st), dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs });
      } else if (isSpecial(st)) {
        continue;
      } else {
        skippedOther += 1;
        continue;
      }
      if (files.length + links.length > maxEntries) {
        const err = new Error("this workspace has too many files to record");
        err.code = "too_large";
        throw err;
      }
    }
  }
  return { files, links, skippedLarge, skippedOther };
}

/**
 * Write one blob as a loose object ourselves (sha1, zlib, temp file + rename) and
 * return its id. Git never opens a workspace path: Node reads the bytes (below)
 * and this stores them, so a bot swapping a file or a folder for a symlink cannot
 * make git read anything outside the workspace.
 */
function writeBlob(objectsDir, bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  const sha = createHash("sha1").update(header).update(bytes).digest("hex");
  const dir = join(objectsDir, sha.slice(0, 2));
  const path = join(dir, sha.slice(2));
  if (existsSync(path)) return sha;
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `tmp_obj_${process.pid}_${randomBytes(6).toString("hex")}`);
  writeFileSync(temp, deflateSync(Buffer.concat([header, bytes])), { flag: "wx", mode: 0o444 });
  try {
    renameSync(temp, path);
  } catch (err) {
    if (!existsSync(path)) throw err;
  }
  return sha;
}

/** The object file a blob id lives in (loose objects only; used for the cache). */
function blobPath(objectsDir, sha) {
  return join(objectsDir, sha.slice(0, 2), sha.slice(2));
}

/**
 * Read one walked file safely. The folder must still resolve (realpath) to the
 * place the walk found it inside the workspace; the file is opened O_NOFOLLOW; the
 * opened descriptor must be a regular file with the SAME device and inode the walk
 * recorded and within the size cap. Anything else returns null (the entry is
 * dropped): a swapped file or folder never redirects the read.
 */
function readWalkedFile(workspaceReal, entry) {
  const relDir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
  const expected = relDir === "" ? workspaceReal : join(workspaceReal, ...relDir.split("/"));
  try {
    if (realpathSync(dirname(entry.abs)) !== expected) return null;
  } catch {
    return null;
  }
  let fd = null;
  try {
    fd = openSync(entry.abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== entry.dev || st.ino !== entry.ino) return null;
    if (Number(st.size) > MAX_FILE_BYTES) return null;
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_FILE_BYTES) return null;
    return { bytes, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, size: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

function loadCache(cacheFile) {
  if (!cacheFile) return {};
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object" && Number.isFinite(parsed.at)) {
      return parsed;
    }
    return { at: 0, entries: {} };
  } catch {
    return { at: 0, entries: {} };
  }
}

function saveCache(cacheFile, cache) {
  if (!cacheFile) return;
  const temp = `${cacheFile}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ at: Date.now(), entries: cache }));
    renameSync(temp, cacheFile);
  } catch { /* the cache is an optimisation only */ }
}

/**
 * Build one tree object from the workspace as it is now.
 *
 * @param {(argvRest: string[], extraOpts?: object) => Promise<{code: number, text: string, stdout: Buffer}>} run
 *   the caller's git runner, already bound to the project's git dir
 * @param {string} workspaceDir  the absolute workspace folder
 * @param {{indexFile: string, maxEntries?: number}} opts
 * @returns {Promise<{tree: string, skippedLarge: number, skippedOther: number, entries: number}>}
 */
export async function buildWorkspaceTree(run, workspaceDir, { indexFile, objectsDir, cacheFile, maxEntries = 200000, _afterWalk } = {}) {
  if (typeof workspaceDir !== "string" || workspaceDir === "") {
    const err = new Error("a workspace folder is required");
    err.code = "invalid_path";
    throw err;
  }
  const max = Number.isFinite(Number(maxEntries)) ? Math.max(1, Math.trunc(Number(maxEntries))) : 200000;
  const { files, links, skippedLarge, skippedOther } = collect(workspaceDir, max);

  if (typeof objectsDir !== "string" || objectsDir === "") {
    const err = new Error("an objects folder is required");
    err.code = "invalid_path";
    throw err;
  }
  if (typeof _afterWalk === "function") await _afterWalk({ files, links });
  let workspaceReal;
  try {
    workspaceReal = realpathSync(workspaceDir);
  } catch {
    workspaceReal = workspaceDir;
  }

  const records = [];
  let dropped = 0;
  const oldCache = loadCache(cacheFile);
  const newCache = {};
  for (const entry of files) {
    const key = [String(entry.dev), String(entry.ino), String(entry.size), String(entry.mtimeNs), String(entry.ctimeNs)].join(":");
    const hit = oldCache.entries[entry.path];
    // ctime cannot be set by unprivileged code, so a same-size edit with the
    // mtime reset still changes the key; and a file touched within two seconds of
    // the previous cache write is re-read (git's "racy clean" rule).
    const newestMs = Number((entry.mtimeNs > entry.ctimeNs ? entry.mtimeNs : entry.ctimeNs) / 1_000_000n);
    const racy = newestMs >= oldCache.at - 2000;
    if (hit && !racy && hit.key === key && /^[0-9a-f]{40}$/.test(hit.sha) && existsSync(blobPath(objectsDir, hit.sha))) {
      // Same file (device, inode, size, mtime to the nanosecond): reuse its blob.
      // Identity was checked by the walk's lstat; no path is opened.
      records.push({ mode: entry.mode, sha: hit.sha, path: entry.path });
      newCache[entry.path] = hit;
      continue;
    }
    const read = readWalkedFile(workspaceReal, entry);
    if (read === null) {
      dropped += 1;
      continue;
    }
    const sha = writeBlob(objectsDir, read.bytes);
    records.push({ mode: entry.mode, sha, path: entry.path });
    // Cache only when the file did not change between the walk and the read.
    if (String(read.mtimeNs) === String(entry.mtimeNs) && String(read.ctimeNs) === String(entry.ctimeNs) && String(read.size) === String(entry.size)) {
      newCache[entry.path] = { key, sha };
    }
  }
  saveCache(cacheFile, newCache);

  // A symlink's blob is its target string.
  for (const link of links) {
    records.push({ mode: MODE_SYMLINK, sha: writeBlob(objectsDir, Buffer.from(link.target)), path: link.path });
  }

  await run(["read-tree", "--empty"], { indexFile });
  if (records.length > 0) {
    const info = records.map((r) => `${r.mode} ${r.sha}\t${r.path}\0`).join("");
    await run(["update-index", "--replace", "-z", "--index-info"], { indexFile, stdin: info });
  }
  const tree = (await run(["write-tree"], { indexFile })).text.trim();
  return { tree, skippedLarge, skippedOther: skippedOther + dropped, entries: records.length };
}