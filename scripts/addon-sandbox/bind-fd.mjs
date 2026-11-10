/**
 * The checked open of one bind source (plan review item 5, review focus 5).
 *
 * An add-on's own data folder, its state folders, an owner-set token file and
 * the parent folder of a sign-in file all sit in trees that add-on code can
 * write — or in the owner's home. Binding such a path by NAME would follow
 * whatever symlink was planted between the check and the bind. So the source is
 * opened one component at a time from `/`, never following a symlink
 * (`O_PATH | O_NOFOLLOW`, plus `O_DIRECTORY` for every component but the leaf),
 * every component's owner is checked, the real path is read back through
 * `/proc/self/fd/<n>` and checked again against the caller's refuse list, and
 * the caller then binds THE FD (`--bind-fd` / `--ro-bind-fd`), never the name.
 *
 * Node has no openat(2), so each step opens `"/proc/self/fd/<parentFd>/<name>"`:
 * the kernel resolves that against the already-open parent directory, so a
 * rename or a symlink swapped in under us cannot redirect the walk.
 *
 * On Linux `O_PATH|O_NOFOLLOW|O_DIRECTORY` on a symlink fails with ENOTDIR, and
 * `O_PATH|O_NOFOLLOW` on a symlink leaf SUCCEEDS and returns the link itself —
 * hence the `isSymbolicLink()` check on the leaf's fstat.
 *
 * Every problem is a ContainRefused and never a partial result: every fd this
 * function opened is closed before it throws. The caller owns the returned fd.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readlinkSync } from "node:fs";
import { resolve, sep } from "node:path";

import { ContainRefused } from "../pi-bots/pi_contain.mjs";

/** Linux `O_PATH` (0o10000000): not in `fs.constants`, so the kernel value is named here. */
const O_PATH = 0o10000000;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const O_DIRECTORY = fsConstants.O_DIRECTORY;

/** `p` is `root` or inside it. */
const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

const codeOf = (err) => (err && err.code ? String(err.code) : "error");

/** The shape a failed component open failed in — never a guessed success. */
function describeOpenFailure(full, err) {
  let isLink = false;
  try { isLink = lstatSync(full).isSymbolicLink(); } catch { isLink = false; }
  if (isLink) return "refused: a symlink in the path (" + full + ")";
  const code = codeOf(err);
  if (code === "ENOTDIR") return "refused: " + full + " is not a directory";
  if (code === "ENOENT") return "refused: " + full + " does not exist";
  return "refused: " + full + " cannot be opened (" + code + ")";
}

/**
 * Open one bind source with every check the wall needs.
 *
 * @param {string} path  the source, absolute (normalised with `resolve`)
 * @param {object} opts
 *   `uid`     the gateway uid (root is always accepted, except at or inside `home`)
 *   `home`    the owner's home: every component at or inside it must be `uid`'s
 *   `refuse`  `(realPath) => reason | null`, the caller's refuse list
 *   `expect`  `"any"` (default), `"dir"` or `"file"`
 * @returns {{fd: number, realPath: string, isDir: boolean}}
 * @throws {ContainRefused}
 */
export function openCheckedBindSource(path, { uid = process.getuid(), home = null, refuse = () => null, expect = "any" } = {}) {
  if (typeof path !== "string" || !path) throw new ContainRefused("refused: no bind source was named");
  if (expect !== "any" && expect !== "dir" && expect !== "file") throw new ContainRefused("refused: unknown expectation " + String(expect));
  const target = resolve(path);
  const homePath = typeof home === "string" && home ? resolve(home) : null;
  const parts = target.split(sep).filter(Boolean);

  /** Every fd opened so far, in open order. */
  const opened = [];
  let leafFd = null;
  let leafIsDir = false;
  const closeAll = () => {
    while (opened.length) {
      const fd = opened.pop();
      try { closeSync(fd); } catch { /* already closed */ }
    }
  };
  const fail = (reason) => { closeAll(); throw new ContainRefused(String(reason)); };

  try {
    let cur;
    try { cur = openSync("/", O_PATH | O_DIRECTORY); }
    catch (err) { fail("refused: cannot open / (" + codeOf(err) + ")"); }
    opened.push(cur);
    let walked = "";

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLeaf = i === parts.length - 1;
      const full = walked + "/" + name;
      const flags = O_PATH | O_NOFOLLOW | (isLeaf ? 0 : O_DIRECTORY);
      let fd;
      try {
        // Resolved by the KERNEL against the already-open parent directory.
        fd = openSync("/proc/self/fd/" + cur + "/" + name, flags);
      } catch (err) {
        fail(describeOpenFailure(full, err));
      }
      opened.push(fd);

      let st;
      try { st = fstatSync(fd); }
      catch (err) { fail("refused: cannot stat " + full + " (" + codeOf(err) + ")"); }
      if (st.isSymbolicLink()) fail("refused: a symlink in the path (" + full + ")");

      const insideHome = !!homePath && (full === homePath || under(full, homePath));
      if (insideHome ? st.uid !== uid : st.uid !== 0 && st.uid !== uid) {
        fail("refused: " + full + " is owned by another user");
      }

      if (isLeaf) {
        if (expect === "dir" && !st.isDirectory()) fail("refused: " + full + " is not a directory");
        if (expect === "file" && !st.isFile()) fail("refused: " + full + " is not a regular file");
        let realPath;
        try { realPath = readlinkSync("/proc/self/fd/" + fd); }
        catch (err) { fail("refused: cannot read back " + full + " (" + codeOf(err) + ")"); }
        if (realPath !== target) fail("refused: the path changed while it was opened (" + full + ")");
        const why = refuse(realPath);
        if (why) fail(why);
        leafFd = fd;
        leafIsDir = st.isDirectory();
      }
      cur = fd;
      walked = full;
    }

    if (leafFd === null) {
      // "/" itself: no component to walk to, so the only fd is the leaf.
      let st;
      try { st = fstatSync(cur); }
      catch (err) { fail("refused: cannot stat / (" + codeOf(err) + ")"); }
      if (expect === "dir" && !st.isDirectory()) fail("refused: / is not a directory");
      if (expect === "file") fail("refused: / is not a regular file");
      const why = refuse(target);
      if (why) fail(why);
      leafFd = cur;
      leafIsDir = st.isDirectory();
    }

    // The caller owns the leaf; every other fd was ours to close.
    for (let i = opened.length - 1; i >= 0; i--) {
      const fd = opened[i];
      opened.splice(i, 1);
      if (fd === leafFd) continue;
      try { closeSync(fd); } catch { /* already closed */ }
    }
    return { fd: leafFd, realPath: target, isDir: leafIsDir };
  } catch (err) {
    closeAll();
    if (err instanceof ContainRefused) throw err;
    throw new ContainRefused("refused: " + target + " could not be opened (" + (err && err.message ? err.message : String(err)) + ")");
  }
}