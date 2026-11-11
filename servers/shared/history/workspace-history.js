/**
 * workspace-history.js — a project's file history, kept in its OWN git dir.
 *
 * Every project's workspace gets a separate git directory under
 * `<data dir>/history/workspaces/<project id>-<project uuid>.git`, driven with
 * `--work-tree=<workspace_dir>`. That is true WHETHER OR NOT the workspace is
 * already a repository (the operator's ruling): a bot works inside the
 * workspace, so a `.git` placed there would let it plant hooks, an fsmonitor, a
 * filter/textconv driver or configuration that Crow's own git calls would then
 * execute. Keeping the git dir outside means Crow never reads anything the bot
 * can write, and a workspace that is already its own repository keeps its HEAD,
 * its branch, its log and its index completely untouched. The directory is
 * derived from the project id AND its portable uuid every time (a deleted
 * project's id is reused by the next one, so the id alone would eventually name
 * a stranger's history); project_spaces.repo_path records it as a note for the
 * owner and for backup, never as a path this module trusts.
 *
 * HARDENED INVOCATION, ONE PLACE. Every git call goes through `runGit`, which
 * uses execFile with an argv array — there is no shell anywhere, so no path, ref
 * or message is ever parsed by one. The environment is built FROM SCRATCH (never
 * inherited): PATH, HOME under Crow's own `<data dir>/history/home`,
 * GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0 and a
 * C locale, with no inherited GIT_* variable. Every call carries the same -c
 * overrides (hooks off, no fsmonitor, no signing, literal pathspecs, no
 * autocrlf/quotepath surprises, gc.auto=0, no NTFS/HFS name protection) and an
 * explicit --git-dir / --work-tree, and every call has a timeout. The git dir is
 * created with `init --bare --template=` (an EMPTY template, so no sample hooks
 * exist) and then told `core.bare=false`; `info/attributes` pins `* -text -filter
 * -diff -merge -ident -working-tree-encoding`, so a `.gitattributes` INSIDE the
 * workspace cannot make a filter run or rewrite bytes on the way into the object
 * database.
 *
 * THE COMMIT'S TREE IS OURS, NOT GIT'S. `git add -A` let the workspace decide
 * what history held: an empty nested repository broke it outright, a nested repo
 * with commits became a gitlink, and a `.gitignore` a bot wrote hid its own
 * edits. So the walker in workspace-index.js selects the files (its deny list is
 * workspace-deny.js), hashes them in batches, and assembles a SCRATCH index —
 * the real index is never read or written, and nothing is checked out. The commit
 * is `commit-tree` plus `update-ref HEAD <new> <old>`, a compare-and-swap, so a
 * commit that lands between our read and our write is never overwritten.
 *
 * ONE LOCK PER PROJECT, IN EVERY PROCESS. The sweep, a job-end commit, a restore
 * and an erase all want the same git dir, and they run in different processes
 * (the gateway and the pi-bots runners). So every write takes the in-process
 * promise chain (withProjectLock) AND the cross-process lock file inside the git
 * dir (workspace-lock.js), in that order, through `withGitWriteLock`.
 *
 * A PROJECT THAT IS GONE IS NEVER RECORDED. `opts.isLive` is checked before the
 * lock and again inside it; a project that fails it gets no git dir at all, and
 * one that fails the second check has its git dir removed rather than left
 * behind by a sweep racing a permanent delete.
 *
 * NOTHING HERE MAY BREAK THE CALLER. A missing binary, a timeout, a permission
 * error, a busy lock: `ensureWorkspaceHistory` reports `{ disabled: true, reason }`
 * once, `commitWorkspace` returns null, and the list functions return []. Project
 * creation, a bot's job and gateway boot must never fail because file history is
 * unavailable.
 *
 * ERASE WITHOUT A HISTORY REWRITE TOOL. History here is Crow's alone and linear,
 * so erasing paths is done with plumbing and a scratch index: replay the history
 * from the first commit that touched any of them, drop every target from each
 * tree, write the tree, and re-create the commit with its original author,
 * committer, dates and message. Commits whose tree did not change collapse into
 * their parent, the whole set of paths is one rewrite, and a wall-clock cap
 * aborts cleanly with the ref unmoved. Earlier names of a deleted file (a rename)
 * are erased too — but a name that is live again is somebody else's file and is
 * left alone. The work tree is never touched and no shell is involved. Before the
 * ref moves a marker is written, so a crash between the ref move and the prune is
 * finished by the next write to the same git dir instead of leaving the erased
 * bytes in the object database for good.
 *
 * Only a DELETED file is erased: if the path exists on disk or in the newest
 * tree, the erase is refused.
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { resolveDataDir } from "../../db.js";
import { AUTHOR_KINDS } from "./write-context.js";
import { buildWorkspaceTree, EMPTY_TREE_ID } from "./workspace-index.js";
import { acquireGitDirLock } from "./workspace-lock.js";

/** Every author kind a commit trailer may name; anything else is unattributed. */
const COMMIT_KINDS = [...AUTHOR_KINDS, "unattributed"];

/** The codes restoreWorkspaceFile may throw with (the History API maps them). */
const RESTORE_CODES = new Set(["invalid_path", "not_found", "unsupported", "outside_workspace", "invalid_context"]);

/** The code a refusal carries when the path is unusable for an erase. */
const ERASE_PATH_CODES = new Set(["invalid_path"]);

const MS_PER_DAY = 86_400_000;

/** The default whole-wait budget for a write's locks (ms). */
const DEFAULT_LOCK_WAIT_MS = 120_000;

/** The default wall-clock cap for one erase rewrite (ms). */
const DEFAULT_ERASE_CAP_MS = 10 * 60 * 1000;

/** The longest string a project uuid may be, and the shortest. */
const UUID_RE = /^[0-9a-f-]{16,64}$/;

/** A plain refusal with a machine-readable code (the History API passes it on). */
function workspaceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/* ------------------------------------------------------------- the data dir */

/**
 * The instance data dir, by the same rule servers/shared/project-spaces.js uses:
 * the directory holding CROW_DB_PATH when that is set, else resolveDataDir().
 * Keeping the two in step is what makes `historyDataDir()` name the same place a
 * project's creation just wrote its git dir to.
 */
export function historyDataDir() {
  if (process.env.CROW_DB_PATH) return resolve(process.env.CROW_DB_PATH, "..");
  return resolveDataDir();
}

/** The folder every project's history lives under. */
function workspacesRoot(opts = {}) {
  const root = opts.dataDir ? resolve(opts.dataDir) : historyDataDir();
  return join(root, "history", "workspaces");
}

/** The name every git dir of one project must match (a uuid is optional). */
function gitDirNameMatcher(id) {
  return new RegExp(`^${String(id)}(-[0-9a-f-]+)?\\.git$`);
}

/**
 * The Crow git dir for one project. Derived from the project id AND uuid EVERY
 * time — never read from a column, so a stale or hand-edited repo_path can never
 * point an erase (or a delete) at another directory, and an id reused by a
 * deleted project's successor can never inherit the old history.
 *
 * @param {{id: number, uuid: string}} project
 * @param {{dataDir?: string}} [opts]
 */
export function workspaceGitDir(project, { dataDir } = {}) {
  const id = Number(project && project.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw workspaceError("invalid_project", "a project's file history needs a positive project id");
  }
  const uuid = project && typeof project.uuid === "string" ? project.uuid.trim() : "";
  if (!UUID_RE.test(uuid)) {
    throw workspaceError("invalid_project", "a project's file history needs the project's portable id");
  }
  return join(dataDir ? resolve(dataDir) : historyDataDir(), "history", "workspaces", `${id}-${uuid}.git`);
}

/** The project id as a positive integer, or a refusal. */
function projectIdOf(project) {
  const id = Number(project && project.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw workspaceError("invalid_project", "a project's file history needs a positive project id");
  }
  return id;
}

/** The project's portable uuid, or null when the caller did not pass one. */
function projectUuidOf(project) {
  const uuid = project && typeof project.uuid === "string" ? project.uuid.trim() : "";
  return UUID_RE.test(uuid) ? uuid : null;
}

/** The workspace dir when it exists and is a directory; null otherwise. */
function workspaceDirOf(project) {
  const ws = project && project.workspace_dir;
  if (typeof ws !== "string" || ws === "") return null;
  try {
    return statSync(ws).isDirectory() ? ws : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ invoking git */

/** One git call's ceiling when the caller does not say (ms). */
const GIT_TIMEOUT_MS = 30_000;

/** The ceiling for the two genuinely slow calls (reflog expiry, gc) (ms). */
const GIT_SLOW_TIMEOUT_MS = 120_000;

/** Config every call carries, so nothing in the environment or a file changes it. */
const COMMON_CONFIG = Object.freeze([
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "commit.gpgsign=false",
  "-c", "core.quotePath=false",
  "-c", "core.autocrlf=false",
  "-c", "core.safecrlf=false",
  "-c", "gc.auto=0",
  "-c", "safe.directory=*",
  // Names are recorded, never checked out, so a name that looks odd to NTFS or
  // HFS must not make the index load fail.
  "-c", "core.protectNTFS=false",
  "-c", "core.protectHFS=false",
]);

/** info/attributes outranks a .gitattributes in the workspace, so bytes stay bytes. */
const ATTRIBUTES = "* -text -filter -diff -merge -ident -working-tree-encoding\n";

/** The root the instance's history lives under, resolved once per call. */
function gitRoot(opts = {}) {
  return opts.dataDir ? resolve(opts.dataDir) : historyDataDir();
}

/** The binary to run: `git`, unless a caller (a test) names another. */
function gitBinOf(opts = {}) {
  return typeof opts.gitBin === "string" && opts.gitBin !== "" ? opts.gitBin : "git";
}

/**
 * Build the full argv for one call: the shared -c overrides, the explicit git
 * dir (and work tree), literal pathspecs, then the subcommand's own arguments.
 */
function gitArgv(repoDir, workTree, rest) {
  const argv = [...COMMON_CONFIG, `--git-dir=${repoDir}`];
  if (workTree) argv.push(`--work-tree=${workTree}`);
  argv.push("--literal-pathspecs", ...rest);
  return argv;
}

/** The reason a failure carries, in plain codes (no git vocabulary in the UI). */
function failureReason(err) {
  if (err && err.code === "ENOENT") return "git_missing";
  if (err && typeof err.code === "string" && /^[a-z][a-z0-9_]*$/.test(err.code)) return err.code;
  return "git_failed";
}

/** Log an unavailable-file-history reason once per process, never repeatedly. */
const loggedReasons = new Set();
function noteFailure(reason) {
  if (loggedReasons.has(reason)) return;
  loggedReasons.add(reason);
  console.warn(`[history] a project's file history is unavailable (${reason})`);
}

/**
 * Run one git command. execFile only — never a shell — with an environment built
 * from scratch. Resolves with `{ code, text, stdout, stderr, timedOut }`; throws
 * (with a plain code) unless `allowFail` asked for the exit code instead.
 *
 * The `env` option is the test seam: it is merged OVER the from-scratch base, so
 * a test can point PATH somewhere empty and prove a missing binary degrades
 * quietly. `onSpawn` is called with the argv before every spawn, so a test can
 * count the calls a rewrite makes. Nothing else is inherited.
 */
async function runGit(argv, opts = {}) {
  const home = join(gitRoot(opts), "history", "home");
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    /* a home we cannot create is reported by the call itself */
  }
  const base = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
  };
  if (opts.indexFile) base.GIT_INDEX_FILE = opts.indexFile;
  const env = { ...base, ...(opts.env || {}) };

  if (typeof opts.onSpawn === "function") {
    try {
      opts.onSpawn(argv);
    } catch {
      /* a counting seam must never change the outcome */
    }
  }

  const res = await new Promise((done) => {
    let child;
    const finish = (err, stdout, stderr) => done({
      err,
      stdout: stdout ? Buffer.from(stdout) : Buffer.alloc(0),
      stderr: stderr ? Buffer.from(stderr).toString("utf8") : "",
    });
    try {
      child = execFile(
        gitBinOf(opts),
        argv,
        {
          cwd: tmpdir(),
          env,
          timeout: opts.timeout ?? GIT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          encoding: "buffer",
          windowsHide: true,
        },
        finish,
      );
    } catch (err) {
      done({ err, stdout: Buffer.alloc(0), stderr: "" });
      return;
    }
    // commit-tree reads its message from stdin; everything else gets an
    // immediately closed stdin so git never waits on a terminal. A command that
    // exited without reading it makes the write raise EPIPE asynchronously —
    // swallow it on the stream itself, because the call's own result is what the
    // caller cares about.
    try {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin == null ? "" : String(opts.stdin));
    } catch {
      /* the call reports its own failure */
    }
  });

  const code = res.err ? (typeof res.err.code === "number" ? res.err.code : -1) : 0;
  const timedOut = Boolean(res.err && (res.err.killed || res.err.signal));
  if (res.err && !opts.allowFail) {
    const reason = res.err.code === "ENOENT" ? "git_missing" : timedOut ? "timeout" : "git_failed";
    const err = new Error(
      `the file history call failed (${reason}): ${String(res.stderr || res.err.message || "").slice(0, 300)}`,
    );
    err.code = reason;
    throw err;
  }
  return { code, timedOut, stdout: res.stdout, text: res.stdout.toString("utf8"), stderr: res.stderr };
}

/* --------------------------------------------------------------- the lock */

/** The per-project promise chain that serializes every write to one git dir. */
const projectLocks = new Map();

/** The clock a caller injected, or the wall clock. */
function clockOf(opts) {
  return typeof opts?.clock === "function" ? opts.clock : Date.now;
}

/** The whole-wait budget a caller asked for. */
function lockBudgetOf(opts) {
  const n = Number(opts?.lockWaitMs);
  return Number.isFinite(n) ? Math.max(0, n) : DEFAULT_LOCK_WAIT_MS;
}

/**
 * Wait for a promise, but not past `waitMs`: resolves true when it settled and
 * false when the budget ran out. The timer is NOT unref'd: a short-lived process
 * (a bot's job-end commit) whose only remaining work is this wait must stay up
 * for it rather than exit with an unsettled await.
 */
function waitForSettle(promise, waitMs, clock) {
  return new Promise((done) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, waitMs));
    promise.then(() => finish(true), () => finish(true));
  });
}

/**
 * Run `work` with no other work for this project in flight IN THIS PROCESS.
 *
 * A Map of promise chains keyed by project id: each caller waits for the one
 * before it and holds the next slot until its own promise settles. The wait is
 * bounded by `waitMs` — a predecessor that never settles (a hung git call) must
 * not park every later job behind it. When the budget runs out this call throws
 * `busy` and releases its own gate at once, so the chain continues without it.
 * The entry is dropped when it is the tail again, so the map does not grow with
 * every project that ever ran.
 */
async function withProjectLock(projectId, work, { waitMs = DEFAULT_LOCK_WAIT_MS, clock = Date.now } = {}) {
  const key = String(projectId);
  const previous = projectLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const chained = previous.then(() => gate, () => gate);
  projectLocks.set(key, chained);
  try {
    const free = await waitForSettle(previous.catch(() => {}), waitMs, clock);
    if (!free) throw workspaceError("busy", "another change to this project's files is still running");
    return await work();
  } finally {
    release();
    if (projectLocks.get(key) === chained) projectLocks.delete(key);
  }
}

/**
 * The live verdict: `true` (record), `false` (not live right now: archived, or
 * the check could not answer — nothing is written and NOTHING IS DELETED), or
 * `"gone"` (the check read the table and the row is missing or carries another
 * uuid: a confirmed purge, the only verdict that may remove a history folder).
 * A thrown error is `false`, never `"gone"`.
 */
async function isLiveNow(opts, project) {
  if (typeof opts.isLive !== "function") return true;
  try {
    const verdict = await opts.isLive(project);
    if (verdict === "gone") return "gone";
    return verdict !== false;
  } catch {
    return false;
  }
}

/**
 * Everything that writes takes this: the in-process lock, then the live check,
 * then the cross-process lock file inside the git dir, then the live check again
 * (a purge may have won the race while we waited). A project that is gone gets no
 * git dir at all, and one that has just gone has the directory removed.
 *
 * Step (5) prepares the git dir and step (6) finishes a prune a crash left behind;
 * only then does `work(repoDir)` run.
 *
 * @returns {Promise<{live: false} | {live: true, value: any}>}
 */
async function withGitWriteLock(project, opts, work) {
  const id = projectIdOf(project);
  const clock = clockOf(opts);
  const budget = lockBudgetOf(opts);
  const startedAt = clock();
  return withProjectLock(id, async () => {
    const early = await isLiveNow(opts, project);
    const repoDir = workspaceGitDir(project, opts);
    // A confirmed purge with a folder still on disk goes on to the lock, which
    // removes it; every other not-live answer touches nothing.
    if (early !== true && !(early === "gone" && existsSync(repoDir))) return { live: false };
    mkdirSync(dirname(repoDir), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const remaining = Math.max(0, budget - (clock() - startedAt));
    let lock;
    try {
      lock = await acquireGitDirLock(repoDir, { waitMs: remaining, clock });
    } catch (err) {
      // The directory vanished between our mkdir and the lock: a purge won.
      if (err && (err.code === "gone" || err.code === "ENOENT")) return { live: false };
      throw err;
    }
    // The erase's wall-clock cap runs from here: the whole hold stays bounded.
    const lockedAt = clock();
    try {
      const verdict = await isLiveNow(opts, project);
      if (verdict !== true) {
        // Only a confirmed purge removes the folder; an archived project or an
        // unanswered check keeps its history (archive never erases).
        if (verdict === "gone") {
          try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        return { live: false };
      }
      await initGitDir(project, opts);
      await recoverPendingGc(repoDir, opts);
      return { live: true, value: await work(repoDir, lockedAt) };
    } finally {
      try { lock.release(); } catch { /* never let the release fail the work */ }
    }
  }, { waitMs: budget, clock });
}

/* ------------------------------------------------------------ init + ensure */

/**
 * Remove another directory under history/workspaces that carries this project's
 * id but a different (or absent) uuid: the leftover of a deleted project whose id
 * this one now holds, or of a history created before the uuid was in the name.
 * It is never reused — it holds a stranger's files.
 */
function removeStaleSiblings(repoDir, id) {
  const root = dirname(repoDir);
  const matcher = gitDirNameMatcher(id);
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(root, name);
    if (full === repoDir) continue;
    if (!matcher.test(name)) continue;
    try { rmSync(full, { recursive: true, force: true }); } catch { /* reported by the next ensure */ }
  }
}

/**
 * Finish a prune a crash interrupted: the marker is written before an erase moves
 * the ref and removed after the gc, so finding it means the erased objects are
 * still reachable through the reflog and must be dropped now.
 */
async function recoverPendingGc(repoDir, opts) {
  const marker = join(repoDir, "crow-pending-gc");
  if (!existsSync(marker)) return;
  const run = (rest, extra) => runGit(gitArgv(repoDir, null, rest), { ...opts, ...extra });
  try {
    await run(["reflog", "expire", "--expire=now", "--all"], { timeout: GIT_SLOW_TIMEOUT_MS });
    await run(["gc", "--prune=now", "--quiet"], { timeout: GIT_SLOW_TIMEOUT_MS });
    try { rmSync(join(repoDir, "crow-hash-cache.json"), { force: true }); } catch { /* best effort */ }
    rmSync(marker, { force: true });
  } catch (err) {
    // Leave the marker: the next write to this git dir tries again.
    noteFailure(failureReason(err));
  }
}

/**
 * Create (or refresh) the Crow git dir for a project. Idempotent: an existing
 * HEAD is left alone, the attributes file is rewritten (it is Crow's own
 * setting, not workspace content), and the workspace dir is never created — a
 * project can have its history ready before it has any files.
 */
async function initGitDir(project, opts) {
  const id = projectIdOf(project);
  const repoDir = workspaceGitDir(project, opts);
  if (!existsSync(join(repoDir, "HEAD"))) {
    // A history under another name for this id is a leftover, never a base.
    removeStaleSiblings(repoDir, id);
    mkdirSync(dirname(repoDir), { recursive: true });
    // An EMPTY template: no sample hooks can end up in a directory Crow's own
    // calls use. --bare puts the repository AT this path (not a .git inside it),
    // and the next call turns it back into a work-tree-backed repository.
    await runGit([...COMMON_CONFIG, "init", "--bare", "--object-format=sha1", "--template=", repoDir], opts);
    await runGit([...COMMON_CONFIG, `--git-dir=${repoDir}`, "config", "core.bare", "false"], opts);
  }
  mkdirSync(join(repoDir, "info"), { recursive: true });
  writeFileSync(join(repoDir, "info", "attributes"), ATTRIBUTES, { mode: 0o600 });
  return repoDir;
}

/**
 * Give one project a file history, and record where it is on the project row.
 *
 * Idempotent, and safe to call before the workspace exists. The uuid is read
 * from project_spaces when the caller did not pass one (a project's creation path
 * knows only its id and workspace dir). Never throws: a missing binary or a
 * failing call comes back as `{ disabled: true, reason }` and is logged once, so
 * project creation and boot carry on.
 *
 * @returns {Promise<{repoDir: string} | {disabled: true, reason: string}>}
 */
export async function ensureWorkspaceHistory(db, project, { dataDir, env, gitBin, isLive, lockWaitMs, clock } = {}) {
  const opts = { dataDir, env, gitBin, isLive, lockWaitMs, clock };
  try {
    const id = projectIdOf(project);
    if (project && project.type === "learner_profile") {
      return { disabled: true, reason: "not_covered" };
    }
    let uuid = projectUuidOf(project);
    if (uuid === null && db && typeof db.execute === "function") {
      const { rows } = await db.execute({ sql: "SELECT uuid FROM project_spaces WHERE id = ?", args: [id] });
      uuid = projectUuidOf({ uuid: rows[0]?.uuid });
    }
    if (uuid === null) throw workspaceError("invalid_project", "a project's file history needs the project's portable id");
    const full = { id, uuid, workspace_dir: project?.workspace_dir ?? null };
    const gate = await withGitWriteLock(full, opts, (repoDir) => repoDir);
    if (!gate.live) return { disabled: true, reason: "gone" };
    const repoDir = gate.value;
    if (db && typeof db.execute === "function") {
      try {
        await db.execute({ sql: "UPDATE project_spaces SET repo_path = ? WHERE id = ?", args: [repoDir, id] });
      } catch (err) {
        // An older row shape without the column (the migration has not run):
        // the git dir works anyway, it just is not noted on the row.
        if (!/no such column/i.test(String(err && err.message))) {
          console.warn("[history] the project's file history path could not be recorded:", err && err.message);
        }
      }
    }
    return { repoDir };
  } catch (err) {
    const reason = failureReason(err);
    noteFailure(reason);
    return { disabled: true, reason };
  }
}

/* ------------------------------------------------------------- the commit */

/**
 * A value as one line: EVERY C0 control character and DEL becomes a space (not
 * only CR/LF — a stray \x01 or \x1f is how a display name could otherwise forge
 * a record boundary in a listing), then trimmed and collapsed.
 */
function singleLine(value) {
  if (value === null || value === undefined) return null;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return clean === "" ? null : clean;
}

/** The author a commit records: a known kind, plus one-line ids. */
function normalizeCtx(ctx) {
  const kind = isObject(ctx) && typeof ctx.authorKind === "string" && COMMIT_KINDS.includes(ctx.authorKind)
    ? ctx.authorKind
    : "unattributed";
  return { authorKind: kind, authorId: singleLine(ctx && ctx.authorId), jobId: singleLine(ctx && ctx.jobId) };
}

/**
 * The message a Crow commit carries: a one-line subject, a blank line, then the
 * trailers `Crow-Author-Kind`, `Crow-Author` and `Crow-Job` (the latter two only
 * when the context names them), plus `Crow-Mass-Delete: yes` when this commit
 * deleted most of what was tracked (the guard that keeps a mistaken commit from
 * being erased automatically). Trailer values are one line each, always.
 */
function commitMessage(message, ctx, { massDelete = false } = {}) {
  const subject = (singleLine(message) || "Update").slice(0, 200);
  const { authorKind, authorId, jobId } = normalizeCtx(ctx);
  const lines = [`Crow-Author-Kind: ${authorKind}`];
  if (authorId) lines.push(`Crow-Author: ${authorId}`);
  if (jobId) lines.push(`Crow-Job: ${jobId}`);
  if (massDelete) lines.push("Crow-Mass-Delete: yes");
  return `${subject}\n\n${lines.join("\n")}\n`;
}

/**
 * The trailers a stored message carries: ONLY the last paragraph's lines of the
 * form `Crow-Author-Kind: v`, `Crow-Author: v`, `Crow-Job: v` and
 * `Crow-Mass-Delete: v`. A message with no trailers is unattributed — never the
 * owner (the design's rule).
 */
function parseTrailers(message) {
  const out = { authorKind: "unattributed", authorId: null, jobId: null, massDelete: false };
  const text = String(message || "").replace(/\s+$/, "");
  if (text === "") return out;
  const paragraphs = text.split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1] || "";
  let authorKind = null;
  for (const raw of last.split("\n")) {
    const m = /^(Crow-Author-Kind|Crow-Author|Crow-Job|Crow-Mass-Delete):[ \t]*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const value = singleLine(m[2]);
    if (m[1] === "Crow-Author-Kind") authorKind = value;
    else if (m[1] === "Crow-Author") out.authorId = value;
    else if (m[1] === "Crow-Job") out.jobId = value;
    else out.massDelete = String(value || "").toLowerCase() === "yes";
  }
  out.authorKind = authorKind !== null && COMMIT_KINDS.includes(authorKind) ? authorKind : "unattributed";
  return out;
}

/** The number of NUL-separated names in a `-z` listing. */
function countNulNames(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer ?? "");
  return text.split("\0").filter((name) => name !== "").length;
}

/** The number of `-z` name-status tokens that are exactly `status`. */
function countStatusTokens(buffer, status) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer ?? "");
  return text.split("\0").filter((token) => token === status).length;
}

/**
 * Would this commit delete most of what was tracked? More than half of the
 * tracked files AND more than 20 of them: the shape of a workspace that was
 * unmounted, emptied or copied over, not of a person tidying up.
 */
async function isMassDelete(run, old, tree) {
  const tracked = countNulNames((await run(["ls-tree", "-r", "--name-only", "-z", "HEAD"])).stdout);
  if (tracked === 0) return false;
  const diff = await run(["diff-tree", "-r", "--name-status", "-z", "HEAD", tree]);
  const deleted = countStatusTokens(diff.stdout, "D");
  return deleted > 20 && deleted * 2 > tracked;
}

/** One `commit-tree` call with the given parent (none for a root commit). */
async function makeCommit(run, tree, parent, message, opts) {
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-F", "-");
  const made = await run(args, {
    stdin: message,
    env: {
      ...(opts.env || {}),
      GIT_AUTHOR_NAME: "Crow",
      GIT_AUTHOR_EMAIL: "history@localhost",
      GIT_COMMITTER_NAME: "Crow",
      GIT_COMMITTER_EMAIL: "history@localhost",
    },
  });
  return made.text.trim();
}

/**
 * Commit the workspace as it is now, as `ctx`, with `message`.
 *
 * Lazily creates the git dir (no database needed), builds the tree from the
 * workspace walk, and commits only when the tree differs from the newest commit
 * (or when there is no commit yet and the tree is not empty) — so a sweep over an
 * idle project writes nothing. The ref moves with a compare-and-swap; a commit
 * that landed in between is retried once, and a second loss is reported as a
 * conflict rather than overwriting it. Returns the new commit's id, or null when
 * there was nothing to record, the history is unavailable, or the project is
 * gone. Never throws.
 *
 * @returns {Promise<string|null>}
 */
export async function commitWorkspace(project, ctx, message, {
  dataDir, env, gitBin, isLive, lockWaitMs, clock, onResult, onNote, _afterWalk,
} = {}) {
  const opts = { dataDir, env, gitBin, isLive, lockWaitMs, clock, onResult, onNote, _afterWalk };
  try {
    if (workspaceDirOf(project) === null) return null; // no folder on disk: nothing to record
    projectIdOf(project);
    const gate = await withGitWriteLock(project, opts, (repoDir) => commitInRepo(project, repoDir, ctx, message, opts));
    return gate.live ? gate.value : null;
  } catch (err) {
    const reason = failureReason(err);
    if (reason === "busy" && typeof onNote === "function") {
      try { onNote("busy"); } catch { /* a note must never fail a commit */ }
    }
    noteFailure(reason);
    return null;
  }
}

/**
 * commitWorkspace's body, already inside the git write lock: the whole commit is
 * one tree, one compare-and-swap and (after one retry) the new id or null.
 */
async function commitInRepo(project, repoDir, ctx, message, opts) {
  const workspaceDir = workspaceDirOf(project);
  if (workspaceDir === null) return null;
  const run = (rest, extra) => runGit(gitArgv(repoDir, workspaceDir, rest), { ...opts, ...extra });
  const indexFile = join(repoDir, "crow-commit-" + process.pid + ".index");
  const zeros = "0".repeat(40);
  try {
    const built = await buildWorkspaceTree(run, workspaceDir, {
      indexFile,
      objectsDir: join(repoDir, "objects"),
      cacheFile: join(repoDir, "crow-hash-cache.json"),
      _afterWalk: opts._afterWalk,
    });
    const tree = built.tree;
    const report = (sha) => {
      if (typeof opts.onResult === "function") {
        try { opts.onResult({ sha, skippedLarge: built.skippedLarge, skippedOther: built.skippedOther }); } catch { /* best effort */ }
      }
      return sha;
    };

    let parent = null;
    const head = await run(["rev-parse", "--verify", "HEAD"], { allowFail: true });
    if (head.code === 0) {
      parent = head.text.trim() || null;
      const headTree = (await run(["rev-parse", "HEAD^{tree}"])).text.trim();
      if (headTree === tree) return report(null);
    } else if (tree === EMPTY_TREE_ID) {
      return report(null);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const massDelete = parent ? await isMassDelete(run, parent, tree) : false;
      const body = commitMessage(message, ctx, { massDelete });
      const newSha = await makeCommit(run, tree, parent, body, opts);
      const moved = await run(["update-ref", "HEAD", newSha, parent || zeros], { allowFail: true });
      if (moved.code === 0) return report(newSha);

      // Someone else moved HEAD between our read and our write.
      const again = await run(["rev-parse", "--verify", "HEAD"], { allowFail: true });
      const now = again.code === 0 ? (again.text.trim() || null) : null;
      if (now) {
        const nowTree = (await run(["rev-parse", "HEAD^{tree}"])).text.trim();
        if (nowTree === tree) return report(null); // it recorded the same thing
      } else if (tree === EMPTY_TREE_ID) {
        return report(null);
      }
      parent = now;
    }
    if (typeof opts.onNote === "function") {
      try { opts.onNote("conflict"); } catch { /* a note must never fail a commit */ }
    }
    return report(null);
  } finally {
    try { rmSync(indexFile, { force: true }); } catch { /* a leftover scratch index is harmless */ }
  }
}

/* -------------------------------------------------------------- the reader */

/** A relative path split into its parts, or a refusal. */
function normalizeRelPath(relPath) {
  if (typeof relPath !== "string" || relPath === "" || relPath.includes("\0")) {
    throw workspaceError("invalid_path", "a file path is required");
  }
  if (isAbsolute(relPath)) throw workspaceError("invalid_path", "a relative file path is required");
  const parts = [];
  for (const raw of relPath.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") throw workspaceError("invalid_path", "a file path may not step up a folder");
    parts.push(raw);
  }
  if (parts.length === 0) throw workspaceError("invalid_path", "a file path is required");
  if (/^\.git$/i.test(parts[0])) {
    throw workspaceError("invalid_path", "that path belongs to the folder's own history");
  }
  return parts;
}

/** The op one parsed status entry maps to (anything not A or D is an update). */
function statusOp(status) {
  const code = String((status && status.status) || "").charAt(0);
  if (code === "A") return "insert";
  if (code === "D") return "delete";
  return "update";
}

/** The path a status entry names IN THAT COMMIT (the destination of a rename). */
function statusPath(status, fallback) {
  const path = status && typeof status.path === "string" ? status.path : "";
  return path === "" ? fallback : path;
}

/**
 * Parse the real bytes of `git log [--follow] -z --format=… --name-status`
 * positionally: NOT by splitting on sentinel characters, because a path may
 * contain one and the only thing that cannot appear in a path is NUL.
 *
 * Each record is `<header fields, NUL separated>` then a run of NUL/LF, then
 * name-status tokens, each NUL-terminated, until the next `\x01` (or the end):
 * `A\0<path>\0`, `D\0<path>\0`, `M\0<path>\0`, `R100\0<old>\0<new>\0` (a rename
 * or copy has TWO paths; the destination is `path`, the source `oldPath`).
 *
 * @param {Buffer|string} input
 * @param {{fields?: string[]}} [opts] the header field names, in git's order
 * @returns {{sha: string, createdAt: string, message: string,
 *   statuses: {status: string, path: string, oldPath?: string}[]}[]}
 */
function parseLog(input, { fields = ["sha", "createdAt", "message"] } = {}) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  const SOH = 0x01;
  const NUL = 0x00;
  const LF = 0x0a;
  const out = [];
  let i = 0;
  const readTo = (byte) => {
    const start = i;
    while (i < data.length && data[i] !== byte) i++;
    const slice = data.subarray(start, i);
    if (i < data.length) i++;
    return slice;
  };
  while (i < data.length) {
    if (data[i] !== SOH) break;
    i++;
    const record = { sha: "", createdAt: "", message: "", statuses: [] };
    for (const field of fields) {
      const value = readTo(NUL).toString("utf8");
      record[field] = value;
    }
    if (!/^[0-9a-f]{40}$/.test(record.sha)) break;
    while (i < data.length && (data[i] === NUL || data[i] === LF)) i++;
    let done = false;
    while (i < data.length && data[i] !== SOH) {
      const token = readTo(NUL).toString("utf8");
      if (!/^[A-Z][0-9]*$/.test(token)) {
        // Anything else is not a record we understand: stop, keep what we have.
        done = true;
        break;
      }
      if (token.startsWith("R") || token.startsWith("C")) {
        const oldPath = readTo(NUL).toString("utf8");
        const path = readTo(NUL).toString("utf8");
        record.statuses.push({ status: token, path, oldPath });
      } else {
        record.statuses.push({ status: token, path: readTo(NUL).toString("utf8") });
      }
    }
    out.push(record);
    if (done) break;
  }
  return out;
}

/** The size of a path's blob at one commit, or null when it has none there. */
async function blobSize(repoDir, workTree, commit, path, opts) {
  try {
    const res = await runGit(gitArgv(repoDir, workTree, ["cat-file", "-s", `${commit}:${path}`]), {
      ...opts,
      allowFail: true,
    });
    if (res.code !== 0) return null;
    const n = Number(res.text.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * One file's versions, newest first.
 *
 * `before` is the id of the oldest version the caller already has (a commit id,
 * not an offset), so a page never skips or repeats a version; the page always
 * keeps its `--max-count`, and a `before` that is not a commit id (or whose
 * parent does not resolve) is an empty page rather than the whole log. Every
 * entry carries the op, the trailers' author and job, the commit's time and the
 * size of the file at that version (null for the commit that deleted it).
 */
export async function listWorkspaceVersions(project, relPath, { limit = 100, before = null, dataDir, env, gitBin } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    projectIdOf(project);
    const path = normalizeRelPath(relPath).join("/");
    const repoDir = workspaceGitDir(project, opts);
    if (!existsSync(join(repoDir, "HEAD"))) return [];
    const max = Math.max(1, Math.min(Math.trunc(Number(limit)) || 100, 500));
    const workTree = workspaceDirOf(project);
    const run = (rest, extra) => runGit(gitArgv(repoDir, workTree, rest), { ...opts, ...extra });

    let start = null;
    if (before !== null && before !== undefined && String(before) !== "") {
      const cursor = String(before).trim();
      if (!/^[0-9a-f]{40}$/.test(cursor)) return [];
      const parent = await run(["rev-parse", "--verify", `${cursor}^`], { allowFail: true });
      if (parent.code !== 0) return [];
      start = `${cursor}^`;
    }

    const args = ["log", "--follow", "-z", "--format=%x01%H%x00%cI%x00%B%x00", "--name-status", `--max-count=${max}`];
    if (start) args.push(start);
    args.push("--", path);

    const res = await run(args);
    const out = [];
    for (const commit of parseLog(res.stdout).slice(0, max)) {
      const status = commit.statuses[0] || null;
      const op = statusOp(status);
      const at = statusPath(status, path);
      const size = op === "delete" ? null : await blobSize(repoDir, workTree, commit.sha, at, opts);
      const trailers = parseTrailers(commit.message);
      out.push({
        id: commit.sha,
        op,
        authorKind: trailers.authorKind,
        authorId: trailers.authorId,
        jobId: trailers.jobId,
        createdAt: commit.createdAt,
        size,
      });
    }
    return out;
  } catch (err) {
    noteFailure(failureReason(err));
    return [];
  }
}

/**
 * listDeletedWorkspaceFiles' body, already past the git-dir resolution: every
 * path whose newest commit deleted it and that is not in the newest tree — the
 * project's Trash. Each entry carries whether that commit deleted most of what
 * was tracked (`massDelete`), which the automatic erase refuses.
 */
async function listDeletedInRepo(project, repoDir, opts) {
  const workTree = workspaceDirOf(project);
  const run = (rest, extra) => runGit(gitArgv(repoDir, workTree, rest), { ...opts, ...extra });
  const head = await run(["rev-parse", "--verify", "HEAD"], { allowFail: true });
  if (head.code !== 0) return [];

  const names = await run(["log", "--all", "--diff-filter=D", "--name-only", "-z", "--format="], { allowFail: true });
  if (names.code !== 0) return [];
  const candidates = [...new Set(
    names.stdout.toString("utf8")
      .split("\0")
      .map((name) => name.replace(/^[\r\n]+|[\r\n]+$/g, ""))
      .filter(Boolean),
  )].sort();

  const out = [];
  for (const path of candidates) {
    if (out.length >= 200) break;
    // A file that is back in the newest tree is not in the Trash.
    const inHead = await run(["cat-file", "-e", `HEAD:${path}`], { allowFail: true });
    if (inHead.code === 0) continue;
    const last = await run([
      "log", "-1", "-z", "--format=%x01%H%x00%cI%x00%B%x00", "--name-status", "--", path,
    ], { allowFail: true });
    if (last.code !== 0) continue;
    const [commit] = parseLog(last.stdout);
    if (!commit) continue;
    const first = commit.statuses[0] || null;
    if (!String((first && first.status) || "").startsWith("D")) continue;
    const trailers = parseTrailers(commit.message);
    out.push({
      path,
      deletedAt: commit.createdAt,
      authorKind: trailers.authorKind,
      authorId: trailers.authorId,
      massDelete: trailers.massDelete === true,
    });
  }
  return out;
}

/**
 * Files whose newest commit deleted them and that are not in the newest tree —
 * the project's Trash. Nothing here reads or writes the work tree.
 */
export async function listDeletedWorkspaceFiles(project, { dataDir, env, gitBin, limit = 200 } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    projectIdOf(project);
    const repoDir = workspaceGitDir(project, opts);
    if (!existsSync(join(repoDir, "HEAD"))) return [];
    const max = Math.max(1, Math.trunc(Number(limit)) || 200);
    return (await listDeletedInRepo(project, repoDir, opts)).slice(0, max);
  } catch (err) {
    noteFailure(failureReason(err));
    return [];
  }
}

/* -------------------------------------------------------------- the restore */

/** Is this real path the workspace root or inside it? */
function insideWorkspace(real, workspaceReal) {
  return real === workspaceReal || real.startsWith(workspaceReal + sep);
}

/** The real path of the folder a write would land in, refused unless contained. */
function writeParentReal(workspaceReal, target, expectedReal) {
  let now;
  try {
    now = realpathSync(dirname(target));
  } catch {
    throw workspaceError("outside_workspace", "that path leads outside the workspace folder");
  }
  if (!insideWorkspace(now, workspaceReal)) {
    throw workspaceError("outside_workspace", "that path leads outside the workspace folder");
  }
  if (expectedReal !== undefined && now !== expectedReal) {
    throw workspaceError("outside_workspace", "the folder holding that path changed while it was being written");
  }
  return now;
}

/**
 * The ancestor the containment check ran against must still BE that folder: a
 * parent swapped for a link resolves somewhere else, and then the write could
 * leave the workspace.
 */
function checkBaseReal(baseReal, workspaceReal) {
  let now;
  try {
    now = realpathSync(baseReal);
  } catch {
    throw workspaceError("outside_workspace", "that path leads outside the workspace folder");
  }
  if (now !== baseReal || !insideWorkspace(now, workspaceReal)) {
    throw workspaceError("outside_workspace", "the folder holding that path changed while it was being written");
  }
}

/**
 * Create the folders a restored file needs, ONE component at a time (never
 * recursive), checking each component: a link is allowed only while it resolves
 * inside the workspace, and a path that is not a folder is refused.
 *
 * @returns {string} the real path of the folder the file will be written into
 */
function ensureParentChain(workspaceReal, parts) {
  let cur = workspaceReal;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]);
    let st = null;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw workspaceError("invalid_path", "a folder in that path cannot be read");
    }
    if (st === null) {
      try {
        mkdirSync(cur);
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw workspaceError("invalid_path", "a folder in that path could not be made");
      }
      try {
        st = lstatSync(cur);
      } catch {
        throw workspaceError("invalid_path", "a folder in that path could not be read");
      }
    }
    if (st.isSymbolicLink()) {
      let real;
      try {
        real = realpathSync(cur);
      } catch {
        throw workspaceError("invalid_path", "a folder in that path cannot be resolved");
      }
      if (!insideWorkspace(real, workspaceReal)) {
        throw workspaceError("outside_workspace", "that path leads outside the workspace folder");
      }
      continue;
    }
    if (!st.isDirectory()) throw workspaceError("invalid_path", "a folder in that path is not a folder");
  }
  return writeParentReal(workspaceReal, join(workspaceReal, ...parts));
}

/**
 * The absolute target of a restore inside the workspace, with every escape
 * checked: the path is already relative and normalized, the target itself must
 * not be a link, and the deepest ancestor that EXISTS must resolve to a place
 * inside the workspace (a symlinked folder may not lead out of it). The resolved
 * ancestor is returned so the write can re-check that it is still that folder.
 */
function containedTarget(project, parts) {
  const ws = project && project.workspace_dir;
  if (typeof ws !== "string" || ws === "") {
    throw workspaceError("invalid_path", "this project has no workspace folder");
  }
  let workspaceReal;
  try {
    workspaceReal = realpathSync(ws);
  } catch {
    throw workspaceError("not_found", "this project's workspace folder is gone");
  }
  const target = join(workspaceReal, ...parts);
  let existing = null;
  try {
    existing = lstatSync(target);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw workspaceError("invalid_path", "that path cannot be read");
  }
  if (existing) {
    if (existing.isSymbolicLink()) throw workspaceError("invalid_path", "that path is a link");
    if (existing.isDirectory()) throw workspaceError("invalid_path", "that path is a folder");
  }
  let probe = dirname(target);
  let baseReal = null;
  while (baseReal === null) {
    try {
      baseReal = realpathSync(probe);
    } catch {
      const up = dirname(probe);
      if (up === probe) throw workspaceError("invalid_path", "that path cannot be resolved");
      probe = up;
    }
  }
  if (!insideWorkspace(baseReal, workspaceReal)) {
    throw workspaceError("outside_workspace", "that path leads outside the workspace folder");
  }
  return { workspaceReal, target, baseReal };
}

/** A blob's tree mode and object id at one commit, or null when absent there. */
async function blobAt(repoDir, workTree, commit, path, opts) {
  const res = await runGit(gitArgv(repoDir, workTree, ["ls-tree", commit, "--", path]), opts);
  const line = res.text.split("\n").map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  const m = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t/.exec(line);
  if (!m) return null;
  return { mode: m[1], type: m[2], blob: m[3] };
}

/**
 * Put one earlier version's bytes back, as a new commit.
 *
 * Path safety first: the path must be relative and normalized, must not lead out
 * of the workspace (through `..` or a link), and must not presently be a link or
 * a folder. The version must be a commit that is an ancestor of the newest one
 * and that actually touched the path; a stored link or a nested-folder entry is
 * refused as unsupported. Pending outside changes are committed first
 * (unattributed / outside-crow), so the restore's own commit holds exactly its
 * change; then the folder holding the file is re-resolved, the bytes are written
 * through a temporary file created with O_NOFOLLOW inside the REAL parent, the
 * parent is checked once more and the temporary file is renamed into place. A
 * folder swapped for a link in between refuses the restore and writes nothing.
 * Restoring what is already there writes and commits nothing (`unchanged: true`).
 *
 * @returns {Promise<{newVersionId: string|null, unchanged: boolean}>}
 */
export async function restoreWorkspaceFile(project, relPath, sha, ctx, opts = {}) {
  const settings = {
    dataDir: opts.dataDir,
    env: opts.env,
    gitBin: opts.gitBin,
    isLive: opts.isLive,
    lockWaitMs: opts.lockWaitMs,
    clock: opts.clock,
    _beforeWrite: opts._beforeWrite,
    _beforeRename: opts._beforeRename,
  };
  try {
    projectIdOf(project);
    if (!isObject(ctx) || !AUTHOR_KINDS.includes(ctx.authorKind)) {
      throw workspaceError(
        "invalid_context",
        "a restore must name who is restoring it (authorKind owner, bot, peer or system)",
      );
    }
    const version = String(sha == null ? "" : sha).trim();
    if (!/^[0-9a-f]{40}$/.test(version)) throw workspaceError("not_found", "that is not a version of this file");
    const parts = normalizeRelPath(relPath);
    const gate = await withGitWriteLock(project, settings, (repoDir) => restoreInRepo(project, repoDir, parts, version, ctx, settings));
    if (!gate.live) throw workspaceError("not_found", "this project has no file history yet");
    return gate.value;
  } catch (err) {
    if (err && RESTORE_CODES.has(err.code)) throw err;
    noteFailure(failureReason(err));
    throw workspaceError("not_found", "that version could not be restored");
  }
}

/** restoreWorkspaceFile's body, already inside the git write lock. */
async function restoreInRepo(project, repoDir, parts, version, ctx, opts) {
  const path = parts.join("/");
  const { workspaceReal, target, baseReal } = containedTarget(project, parts);
  const workTree = project.workspace_dir;
  const run = (rest, extra) => runGit(gitArgv(repoDir, workTree, rest), { ...opts, ...extra });

  const head = await run(["rev-parse", "--verify", "HEAD"], { allowFail: true });
  if (head.code !== 0) throw workspaceError("not_found", "this project has no file history yet");
  const ancestor = await run(["merge-base", "--is-ancestor", version, "HEAD"], { allowFail: true });
  if (ancestor.code !== 0) throw workspaceError("not_found", "that is not a version of this file");
  const touched = await run(["log", "--follow", "--format=%H", "--", path]);
  if (!touched.text.split("\n").map((s) => s.trim()).includes(version)) {
    throw workspaceError("not_found", "that is not a version of this file");
  }

  const at = await blobAt(repoDir, workTree, version, path, opts);
  if (at === null) throw workspaceError("not_found", "that version does not hold this file");
  if (at.mode === "120000" || at.mode === "160000") {
    throw workspaceError("unsupported", "that version holds a link or a nested folder, which cannot be restored");
  }
  if (at.type !== "blob") throw workspaceError("unsupported", "that version does not hold a file");
  const bytes = (await run(["cat-file", "blob", at.blob])).stdout;

  // Pending outside changes belong to their own earlier version, not to this one.
  await commitInRepo(project, repoDir, { authorKind: "unattributed", authorId: "outside-crow" }, "Update", opts);

  let unchanged = false;
  try {
    unchanged = readFileSync(target).equals(bytes);
  } catch {
    unchanged = false;
  }
  if (unchanged) return { newVersionId: null, unchanged: true };

  if (typeof opts._beforeWrite === "function") await opts._beforeWrite();

  const mode = at.mode === "100755" ? 0o755 : 0o644;
  checkBaseReal(baseReal, workspaceReal);
  const parentReal = ensureParentChain(workspaceReal, parts);

  const temp = join(parentReal, `.crow-restore-${randomBytes(6).toString("hex")}`);
  let fd = -1;
  try {
    fd = openSync(
      temp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      mode,
    );
    writeSync(fd, bytes);
    closeSync(fd);
    fd = -1;
    chmodSync(temp, mode);

    if (typeof opts._beforeRename === "function") await opts._beforeRename();
    checkBaseReal(baseReal, workspaceReal);
    writeParentReal(workspaceReal, target, parentReal);
    renameSync(temp, target);
  } catch (err) {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* nothing was written */ }
    if (err && RESTORE_CODES.has(err.code)) throw err;
    throw workspaceError("invalid_path", `that file could not be written (${failureReason(err)})`);
  }

  const newVersionId = await commitInRepo(project, repoDir, ctx, `Restored ${path}`, opts);
  return { newVersionId, unchanged: false };
}

/* ---------------------------------------------------------------- the erase */

/** A timestamp in ms from a Date, a number, a function or nothing at all. */
function nowMs(now) {
  if (typeof now === "function") {
    const value = now();
    return value instanceof Date ? value.getTime() : Number(value);
  }
  if (now instanceof Date) return now.getTime();
  if (now !== null && now !== undefined && Number.isFinite(Number(now))) return Number(now);
  return Date.now();
}

/**
 * Parse `git log --reverse -z --format=%H%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B`
 * output: exactly eight NUL-terminated fields per commit, the last terminator
 * supplied by -z. A chunk whose first field is not a commit id means the stream
 * is not what we asked for, so the rewrite refuses rather than guessing.
 */
function parseCommitMeta(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  const fields = data.toString("utf8").split("\0");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  const out = [];
  for (let i = 0; i + 7 < fields.length; i += 8) {
    const chunk = fields.slice(i, i + 8);
    if (!/^[0-9a-f]{40}$/.test(chunk[0])) {
      throw Object.assign(new Error("the file history could not be read"), { code: "git_failed" });
    }
    out.push({
      sha: chunk[0],
      authorName: chunk[1],
      authorEmail: chunk[2],
      authorDate: chunk[3],
      committerName: chunk[4],
      committerEmail: chunk[5],
      committerDate: chunk[6],
      message: chunk[7],
    });
  }
  return out;
}

/** Paths in chunks of at most `size`. */
function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every name one path has had, following renames back through the history: the
 * path itself plus each `path`/`oldPath` a status entry names. Erasing a renamed
 * file must erase the names it used to have, or the blob stays reachable under
 * the original one.
 */
async function followNames(run, path) {
  const names = new Set([path]);
  const res = await run(["log", "--follow", "-M", "-z", "--format=%x01%H%x00", "--name-status", "--", path], {
    allowFail: true,
  });
  if (res.code !== 0) return [...names];
  for (const commit of parseLog(res.stdout, { fields: ["sha"] })) {
    for (const status of commit.statuses) {
      if (status.oldPath) names.add(status.oldPath);
      if (status.path) names.add(status.path);
    }
  }
  return [...names];
}

/** Is this path in the work tree, or in the newest tree? Then it is not deleted. */
async function livePath(run, workTree, name) {
  if (typeof workTree === "string" && workTree !== "") {
    try {
      lstatSync(join(workTree, ...name.split("/")));
      return true;
    } catch {
      /* absent from the work tree: good */
    }
  }
  const inHead = await run(["cat-file", "-e", `HEAD:${name}`], { allowFail: true });
  return inHead.code === 0;
}

/** The earliest commit (in `rev-list --reverse HEAD` order) touching any path. */
async function firstTouchingCommit(run, paths, order) {
  const position = new Map(order.map((sha, i) => [sha, i]));
  let best = null;
  let bestAt = Infinity;
  for (const chunk of chunked(paths, 200)) {
    const res = await run(["rev-list", "--reverse", "HEAD", "--", ...chunk], { allowFail: true });
    if (res.code !== 0) continue;
    const first = res.text.split("\n").map((s) => s.trim()).find(Boolean);
    if (!first) continue;
    const at = position.has(first) ? position.get(first) : Infinity;
    if (at < bestAt) {
      bestAt = at;
      best = first;
    }
  }
  return best;
}

/** One re-created commit with its original author, committer, dates and message. */
async function rewriteCommit(run, tree, parentId, info, opts) {
  const args = ["commit-tree", tree];
  if (parentId) args.push("-p", parentId);
  args.push("-F", "-");
  const made = await run(args, {
    stdin: info.message,
    env: {
      ...(opts.env || {}),
      GIT_AUTHOR_NAME: info.authorName,
      GIT_AUTHOR_EMAIL: info.authorEmail,
      GIT_AUTHOR_DATE: info.authorDate,
      GIT_COMMITTER_NAME: info.committerName,
      GIT_COMMITTER_EMAIL: info.committerEmail,
      GIT_COMMITTER_DATE: info.committerDate,
    },
  });
  return made.text.trim();
}

/**
 * Remove a set of deleted paths from a project's file history, in ONE rewrite.
 *
 * Per path: refused unless it is DELETED (not on disk, not in the newest tree).
 * Refused paths are reported in `skipped` with their reason; the rest proceed.
 * Every earlier name of a path (a rename) is a target too — unless that name is
 * live again, in which case it is another file's history and is reported as
 * `name_in_use` and left alone.
 *
 * The rewrite starts at the first commit that touches any target: commits before
 * it are reused untouched, and every commit from there is replayed in a scratch
 * index with all targets dropped, re-created with its original metadata, and
 * collapsed into its parent when its tree did not change. A wall-clock cap
 * (`eraseCapMs`) throws `timeout` with the ref unmoved. The ref then moves with a
 * compare-and-swap (`changed` when someone else moved it first), the erased
 * objects are pruned, and a pending-gc marker covers a crash in between. The work
 * tree is never touched.
 *
 * @returns {Promise<{erased: boolean, reason?: string, erasedPaths: string[],
 *   skipped: {path: string, reason: string}[]}>}
 */
export async function eraseWorkspacePaths(project, relPaths, opts = {}) {
  const settings = {
    dataDir: opts.dataDir,
    env: opts.env,
    gitBin: opts.gitBin,
    isLive: opts.isLive,
    lockWaitMs: opts.lockWaitMs,
    clock: opts.clock,
    eraseCapMs: opts.eraseCapMs,
    onSpawn: opts.onSpawn,
    _afterRefMove: opts._afterRefMove,
  };
  const list = Array.isArray(relPaths) ? relPaths : [relPaths];
  const skipped = [];
  const targets = [];
  for (const rel of list) {
    try {
      targets.push(normalizeRelPath(rel).join("/"));
    } catch (err) {
      const reason = err && ERASE_PATH_CODES.has(err.code) ? err.code : "invalid_path";
      skipped.push({ path: String(rel), reason });
    }
  }
  if (targets.length === 0) {
    return { erased: false, reason: skipped[0]?.reason || "invalid_path", erasedPaths: [], skipped };
  }
  try {
    // Nothing has ever been recorded for this project: no rewrite, and no git dir
    // created just to find that out.
    const repoDir = workspaceGitDir(project, settings);
    if (!existsSync(join(repoDir, "HEAD"))) {
      return { erased: false, reason: "no_history", erasedPaths: [], skipped };
    }
    const gate = await withGitWriteLock(project, settings, (dir, lockedAt) => eraseInRepo(project, dir, targets, { ...settings, lockedAt }));
    if (!gate.live) return { erased: false, reason: "gone", erasedPaths: [], skipped };
    return { ...gate.value, skipped: [...skipped, ...(gate.value.skipped || [])] };
  } catch (err) {
    const reason = failureReason(err);
    noteFailure(reason);
    return { erased: false, reason, erasedPaths: [], skipped };
  }
}

/** eraseWorkspacePaths' body, already inside the git write lock. */
async function eraseInRepo(project, repoDir, targets, opts) {
  const workTree = project && project.workspace_dir;
  const run = (rest, extra) => runGit(gitArgv(repoDir, workTree, rest), { ...opts, ...extra });
  const clock = clockOf(opts);
  const capMs = Number.isFinite(Number(opts.eraseCapMs)) ? Math.max(0, Number(opts.eraseCapMs)) : DEFAULT_ERASE_CAP_MS;

  const head = await run(["rev-parse", "--verify", "HEAD"], { allowFail: true });
  if (head.code !== 0) {
    return { erased: false, reason: "no_history", erasedPaths: [], skipped: targets.map((path) => ({ path, reason: "no_history" })) };
  }
  const oldTip = head.text.trim();

  const skipped = [];
  const dead = new Set();
  for (const target of targets) {
    if (await livePath(run, workTree, target)) {
      skipped.push({ path: target, reason: "exists" });
      continue;
    }
    for (const name of await followNames(run, target)) {
      if (name === target) {
        dead.add(name);
        continue;
      }
      if (await livePath(run, workTree, name)) {
        skipped.push({ path: name, reason: "name_in_use" });
        continue;
      }
      dead.add(name);
    }
  }
  if (dead.size === 0) {
    return { erased: false, reason: skipped[0]?.reason || "no_history", erasedPaths: [], skipped };
  }
  const paths = [...dead];

  const listed = await run(["rev-list", "--reverse", "HEAD"]);
  const order = listed.text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (order.length === 0) return { erased: false, reason: "no_history", erasedPaths: [], skipped };

  const firstSha = await firstTouchingCommit(run, paths, order);
  if (!firstSha) return { erased: false, reason: "no_history", erasedPaths: [], skipped };
  const startAt = order.indexOf(firstSha);

  const meta = await run([
    "log", "--reverse", "-z", "--format=%H%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B",
  ]);
  const bySha = new Map(parseCommitMeta(meta.stdout).map((commit) => [commit.sha, commit]));

  const indexFile = join(repoDir, "crow-erase.index");
  const marker = join(repoDir, "crow-pending-gc");
  try { rmSync(indexFile, { force: true }); } catch { /* stale scratch index */ }
  // The cap counts from when the lock was taken, not from the rewrite's start.
  const deadline = (Number.isFinite(Number(opts.lockedAt)) ? Number(opts.lockedAt) : clock()) + capMs;

  try {
    let parentId = startAt > 0 ? order[startAt - 1] : null;
    let parentTree = parentId === null
      ? null
      : (await run(["rev-parse", `${parentId}^{tree}`])).text.trim();
    let made = 0;

    for (let i = startAt; i < order.length; i++) {
      if (clock() > deadline) {
        throw workspaceError("timeout", "erasing that file history took too long and was stopped");
      }
      const sha = order[i];
      const info = bySha.get(sha);
      if (!info) throw Object.assign(new Error("the file history could not be read"), { code: "git_failed" });

      // A scratch index per commit: replay that commit's tree, drop every target,
      // write the tree back. Nothing here can update a work-tree file.
      await run(["read-tree", sha], { indexFile });
      await run(["update-index", "--force-remove", "-z", "--stdin"], {
        indexFile,
        stdin: paths.map((path) => `${path}\0`).join(""),
      });
      const tree = (await run(["write-tree"], { indexFile })).text.trim();

      const isRoot = parentId === null;
      if (!isRoot && tree === parentTree) continue; // held nothing but erased paths
      parentId = await rewriteCommit(run, tree, parentId, info, opts);
      parentTree = tree;
      made += 1;
    }

    if (made === 0 || parentId === null || parentId === oldTip) {
      return { erased: false, reason: "no_change", erasedPaths: [], skipped };
    }

    // A crash between the ref move and the prune must not leave the erased bytes
    // reachable for good, so the marker goes down first.
    writeFileSync(marker, String(clock()), { mode: 0o600 });
    const moved = await run(["update-ref", "HEAD", parentId, oldTip], { allowFail: true });
    if (moved.code !== 0) {
      try { rmSync(marker, { force: true }); } catch { /* nothing moved */ }
      return { erased: false, reason: "changed", erasedPaths: [], skipped };
    }

    try {
      if (typeof opts._afterRefMove === "function") await opts._afterRefMove();
    } catch {
      // Stop here, leaving the marker behind exactly as a crash would: the next
      // write to this git dir finishes the prune.
      return { erased: false, reason: "interrupted", erasedPaths: [], skipped };
    }

    // Never created by this code (there is no rewrite helper involved), but a
    // leftover backup ref would keep the erased object alive: delete any.
    const backups = await run(["for-each-ref", "--format=%(refname)", "refs/original/"]);
    for (const ref of backups.text.split("\n").map((s) => s.trim()).filter(Boolean)) {
      await run(["update-ref", "-d", ref]);
    }
    await run(["reflog", "expire", "--expire=now", "--all"], { timeout: GIT_SLOW_TIMEOUT_MS });
    await run(["gc", "--prune=now", "--quiet"], { timeout: GIT_SLOW_TIMEOUT_MS });
    try { rmSync(join(repoDir, "crow-hash-cache.json"), { force: true }); } catch { /* best effort */ }
    try { rmSync(marker, { force: true }); } catch { /* the next write clears it */ }
    return { erased: true, erasedPaths: paths, skipped };
  } finally {
    try { rmSync(indexFile, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Remove ONE deleted path from Crow's history for this project, and from nothing
 * else. A thin wrapper over eraseWorkspacePaths, which does the rewrite.
 *
 * @returns {Promise<{erased: boolean, reason?: string}>}
 */
export async function eraseWorkspaceFile(project, relPath, opts = {}) {
  const result = await eraseWorkspacePaths(project, [relPath], opts);
  if (result.erased) return { erased: true };
  const firstSkipped = (result.skipped || []).find((entry) => entry.reason) || null;
  return { erased: false, reason: result.reason || firstSkipped?.reason || "no_history" };
}

/** Every path already in the Trash longer than `trashDays`, one rewrite. */
async function eraseExpiredInRepo(project, repoDir, trashDays, opts, now) {
  const days = Number(trashDays);
  if (!Number.isFinite(days) || days <= 0) return [];
  const cutoff = nowMs(now) - days * MS_PER_DAY;
  const deleted = await listDeletedInRepo(project, repoDir, opts);
  const expired = [];
  for (const file of deleted) {
    // A commit that deleted most of what was tracked is never the basis for an
    // automatic erase: that is how a workspace emptied by mistake would vanish.
    if (file.massDelete === true) continue;
    const at = Date.parse(file.deletedAt);
    if (!Number.isFinite(at) || at > cutoff) continue;
    expired.push(file.path);
  }
  if (expired.length === 0) return [];
  const outcome = await eraseInRepo(project, repoDir, expired, opts);
  return outcome.erased ? outcome.erasedPaths : [];
}

/**
 * Erase every file already in the Trash longer than the Trash period, in ONE
 * rewrite for the whole set (never one replay per file). A file that still exists
 * is never touched, and a file whose deleting commit took most of the workspace
 * with it is held back for good. Returns the paths erased, oldest first.
 */
export async function eraseExpiredWorkspaceFiles(project, trashDays, opts = {}) {
  const settings = {
    dataDir: opts.dataDir,
    env: opts.env,
    gitBin: opts.gitBin,
    isLive: opts.isLive,
    lockWaitMs: opts.lockWaitMs,
    clock: opts.clock,
    eraseCapMs: opts.eraseCapMs,
    onSpawn: opts.onSpawn,
  };
  try {
    projectIdOf(project);
    const days = Number(trashDays);
    if (!Number.isFinite(days) || days <= 0) return [];
    const gate = await withGitWriteLock(project, settings, (repoDir, lockedAt) => eraseExpiredInRepo(project, repoDir, days, { ...settings, lockedAt }, opts.now));
    return gate.live ? gate.value : [];
  } catch (err) {
    if (err && err.code === "timeout") {
      console.warn("[history] erasing expired workspace files timed out and was stopped; it will be retried");
    }
    noteFailure(failureReason(err));
    return [];
  }
}

/* -------------------------------------------------------------- the sweep */

/** Where the round-robin walk of already-set-up projects continues (per handle). */
const sweepCursors = new WeakMap();

/**
 * A live check over the project table for the sweep and the History API: the row
 * must exist, carry the same portable id, and not be archived. Nothing is created
 * for a project this says no to.
 */
export function makeDbLiveCheck(db) {
  if (!db || typeof db.execute !== "function") return null;
  return async (project) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT uuid, archived_at FROM project_spaces WHERE id = ?",
        args: [Number(project.id)],
      });
      const row = rows[0];
      if (!row || String(row.uuid) !== String(project.uuid)) return "gone";
      return row.archived_at == null || row.archived_at === "" ? true : false;
    } catch {
      // A database hiccup is "cannot tell": nothing is written, nothing removed.
      return false;
    }
  };
}

/**
 * One bounded pass over the projects that have a workspace.
 *
 * Projects whose history is not set up yet (no repo_path, or no git dir under its
 * exact name) go FIRST, so a project that predates this feature is picked up on
 * the next sweep — and the pass commits its current files as the unattributed
 * baseline. The rest go round-robin from an in-process cursor, so a host with more
 * projects than `batch` still covers them all over successive passes. Each project
 * stands alone: one failure is counted and the pass carries on, and a project that
 * is gone by the time its turn comes gets no git dir at all.
 *
 * `trashDays` alone does not erase anything: the automatic erase is OFF unless
 * `autoErase === true` (the local `history.workspace_auto_erase` setting), because
 * until the Trash page lists workspace files the history copy is the only copy.
 *
 * @returns {Promise<{ensured: number, committed: number, erased: number, eraseTimedOut: number, failed: number}>}
 */
export async function sweepWorkspaces(db, { dataDir, env, gitBin, batch = 20, trashDays, autoErase = false, now, lockWaitMs, clock, eraseCapMs, onSpawn } = {}) {
  const result = { ensured: 0, committed: 0, erased: 0, eraseTimedOut: 0, failed: 0 };
  if (!db || typeof db.execute !== "function") return result;
  const base = { dataDir, env, gitBin, lockWaitMs, clock, eraseCapMs, onSpawn };
  const isLive = makeDbLiveCheck(db);
  const eraseOn = autoErase === true && typeof trashDays === "number" && Number.isFinite(trashDays);

  let rows = [];
  try {
    const res = await db.execute({
      sql: `SELECT id, uuid, workspace_dir, repo_path FROM project_spaces
             WHERE workspace_dir IS NOT NULL AND workspace_dir != ''
               AND archived_at IS NULL
               AND (type IS NULL OR type != 'learner_profile')
             ORDER BY id`,
      args: [],
    });
    rows = res.rows || [];
  } catch (err) {
    noteFailure(failureReason(err));
    return result;
  }
  if (rows.length === 0) return result;

  const max = Math.max(1, Math.trunc(Number(batch)) || 20);
  const pendingSetup = [];
  const covered = [];
  for (const row of rows) {
    let canonical = null;
    try {
      canonical = workspaceGitDir({ id: Number(row.id), uuid: row.uuid }, base);
    } catch {
      canonical = null;
    }
    const ready = canonical !== null && existsSync(join(canonical, "HEAD")) && String(row.repo_path || "") === canonical;
    (ready ? covered : pendingSetup).push(row);
  }

  const picked = [];
  const setupNow = pendingSetup.slice(0, max);
  picked.push(...setupNow);
  if (picked.length < max && covered.length > 0) {
    const cursor = Number(sweepCursors.get(db) || 0) % covered.length;
    const take = Math.min(covered.length, max - picked.length);
    for (let i = 0; i < take; i++) picked.push(covered[(cursor + i) % covered.length]);
    sweepCursors.set(db, (cursor + take) % covered.length);
  }

  for (const row of picked) {
    const project = { id: Number(row.id), uuid: row.uuid, workspace_dir: row.workspace_dir };
    const isNew = setupNow.includes(row);
    const settings = { ...base, isLive };
    try {
      const gate = await withGitWriteLock(project, settings, async (repoDir, lockedAt) => {
        let committed = 0;
        let erased = 0;
        if (String(row.repo_path || "") !== repoDir) {
          try {
            await db.execute({ sql: "UPDATE project_spaces SET repo_path = ? WHERE id = ?", args: [repoDir, project.id] });
          } catch (err) {
            if (!/no such column/i.test(String(err && err.message))) throw err;
          }
        }
        // The baseline for a project picked up now, and any outside edit for one
        // already covered: unattributed, never the owner.
        const sha = await commitInRepo(
          project,
          repoDir,
          { authorKind: "unattributed", authorId: "outside-crow" },
          "Update",
          settings,
        );
        if (sha) committed += 1;
        let eraseTimedOut = 0;
        if (eraseOn) {
          // The erase's cap starts here, so a slow commit above never eats it.
          try {
            erased += (await eraseExpiredInRepo(project, repoDir, trashDays, { ...settings, lockedAt: clockOf(settings)() }, now)).length;
          } catch (err) {
            if (!err || err.code !== "timeout") throw err;
            // Never silent: the erase did not happen, and the next sweep retries.
            eraseTimedOut = 1;
            console.warn(`[history] a scheduled erase of workspace files timed out for project ${project.id}; it will be retried`);
          }
        }
        return { committed, erased, eraseTimedOut };
      });
      if (!gate.live) continue;
      if (isNew) result.ensured += 1;
      result.committed += gate.value.committed;
      result.erased += gate.value.erased;
      result.eraseTimedOut += gate.value.eraseTimedOut;
    } catch (err) {
      result.failed += 1;
      noteFailure(failureReason(err));
    }
  }
  return result;
}

/* ------------------------------------------------------------- the removal */

/**
 * Delete one project's file history: EVERY directory under history/workspaces
 * whose name is that project id (with a uuid, or without one from before the uuid
 * was in the name) and nothing else. A permanent project delete must leave
 * nothing behind, including a leftover under an older name; the directory is
 * removed under its own cross-process lock, so an in-flight commit is not pulled
 * out from under, and a lock that cannot be taken means "try again later" rather
 * than a half delete.
 *
 * @param {number} projectId
 * @param {{dataDir?: string, uuid?: string, lockWaitMs?: number}} [opts]
 * @returns {Promise<boolean>} true when none remains
 */
export async function removeWorkspaceHistory(projectId, { dataDir, lockWaitMs } = {}) {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const root = workspacesRoot({ dataDir });
  const matcher = gitDirNameMatcher(id);
  let names = [];
  try {
    names = readdirSync(root);
  } catch (err) {
    if (err && err.code === "ENOENT") return true;
    return false;
  }
  for (const name of names) {
    if (!matcher.test(name)) continue;
    const dir = join(root, name);
    let lock = null;
    try {
      lock = await acquireGitDirLock(dir, { waitMs: lockWaitMs });
    } catch (err) {
      if (err && err.code === "gone") continue; // already removed
      if (err && err.code === "busy") return false; // a write is in flight
      return false;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      return false;
    } finally {
      try { lock.release(); } catch { /* the directory is already gone */ }
    }
  }
  try {
    return readdirSync(root).every((name) => !matcher.test(name));
  } catch (err) {
    return Boolean(err) && err.code === "ENOENT";
  }
}