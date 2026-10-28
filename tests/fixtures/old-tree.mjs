/**
 * An older checkout of this repo, for mixed-version tests.
 *
 * oldTree(sha) adds a detached git worktree for `sha` in a scratch dir under
 * os.tmpdir(), links node_modules to this checkout's when package-lock.json is
 * unchanged between `sha` and HEAD (else runs `npm ci --ignore-scripts`), and
 * returns { dir, importModule(rel), cleanup() }. It never skips: a missing
 * object is fetched (`git fetch --depth=1 origin <sha>`), and any failure
 * throws. Memoised per sha within a process. Callers MUST call cleanup() in
 * after(); it removes the worktree and the scratch dir.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const git = (args, opts = {}) => execFileSync("git", args, { cwd: REPO, stdio: "pipe", encoding: "utf8", ...opts });

const memo = new Map();

function hasObject(sha) {
  try { git(["cat-file", "-e", `${sha}^{commit}`]); return true; } catch { return false; }
}

async function build(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`oldTree: a full 40-hex sha is required, got ${sha}`);
  if (!hasObject(sha)) git(["fetch", "--depth=1", "origin", sha], { timeout: 120_000 });
  const scratch = mkdtempSync(join(tmpdir(), "crow-old-tree-"));
  const dir = join(scratch, "tree");
  git(["worktree", "add", "--detach", dir, sha], { timeout: 120_000 });
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    memo.delete(sha);
    try { git(["worktree", "remove", "--force", dir]); } catch {}
    rmSync(scratch, { recursive: true, force: true });
    try { git(["worktree", "prune"]); } catch {}
  };
  try {
    let lockSame = false;
    try { git(["diff", "--quiet", sha, "HEAD", "--", "package-lock.json"]); lockSame = true; } catch {}
    const here = join(REPO, "node_modules");
    if (lockSame && existsSync(here)) {
      symlinkSync(realpathSync(here), join(dir, "node_modules"), "dir");
    } else {
      execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "pipe", timeout: 600_000 });
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  return {
    dir,
    importModule: (rel) => import(pathToFileURL(join(dir, rel)).href),
    cleanup,
  };
}

export function oldTree(sha) {
  if (!memo.has(sha)) {
    const p = build(sha);
    p.catch(() => memo.delete(sha));
    memo.set(sha, p);
  }
  return memo.get(sha);
}
