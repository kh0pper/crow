/**
 * workspace-history.js — a project's file history, kept in its OWN git dir.
 *
 * Every project's workspace gets a separate git directory under
 * `<data dir>/history/workspaces/<project_id>.git`, driven with
 * `--work-tree=<workspace_dir>`. That is true WHETHER OR NOT the workspace is
 * already a repository (the operator's ruling): a bot works inside the
 * workspace, so a `.git` placed there would let it plant hooks, an fsmonitor, a
 * filter/textconv driver or configuration that Crow's own git calls would then
 * execute. Keeping the git dir outside means Crow never reads anything the bot
 * can write, and a workspace that is already its own repository keeps its HEAD,
 * its branch, its log and its index completely untouched (review focus 5 of the
 * version history design). The chosen directory is recorded in
 * project_spaces.repo_path, which is a note for the owner (and for backup), never
 * a path this module trusts: `workspaceGitDir(id)` derives it from the project
 * id every time.
 *
 * HARDENED INVOCATION, ONE PLACE. Every git call goes through `runGit`, which
 * uses execFile with an argv array — there is no shell anywhere, so no path, ref
 * or message is ever parsed by one. The environment is built FROM SCRATCH (never
 * inherited): PATH, HOME under Crow's own `<data dir>/history/home`,
 * GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0 and a
 * C locale, with no inherited GIT_* variable. Every call carries the same -c
 * overrides (hooks off, no fsmonitor, no signing, literal pathspecs, no
 * autocrlf/quotepath surprises, gc.auto=0) and an explicit --git-dir /
 * --work-tree, and every call has a timeout. The git dir is created with
 * `init --bare --template=` (an EMPTY template, so no sample hooks exist) and
 * then told `core.bare=false`; the Crow ignore list goes to its `info/exclude`
 * and `info/attributes` pins `* -text -filter -diff -merge -ident
 * -working-tree-encoding`, so a `.gitattributes` INSIDE the workspace cannot make
 * a filter run or rewrite bytes on the way into the object database.
 *
 * ONE LOCK PER PROJECT. The sweep, a job-end commit, a restore and an erase all
 * want the same index, so each works inside a per-project promise chain
 * (`withProjectLock`). Without it, two of them race on index.lock and one call
 * loses for no good reason.
 *
 * NOTHING HERE MAY BREAK THE CALLER. A missing binary, a timeout, a permission
 * error: `ensureWorkspaceHistory` reports `{ disabled: true, reason }` once,
 * `commitWorkspace` returns null, and the list functions return []. Project
 * creation and gateway boot must never fail because file history is unavailable.
 *
 * ERASE WITHOUT A HISTORY REWRITE TOOL. History here is Crow's alone and linear,
 * so erasing one path is done with plumbing and a temporary index: replay each
 * commit oldest to newest in a scratch index, drop the path, write the tree, and
 * re-create the commit with its original author, committer, dates and message.
 * Commits whose tree did not change collapse into their parent. The work tree is
 * never touched (only the real index is refreshed, without -u), no shell is
 * involved, and the path never becomes part of a command line that a shell could
 * see. Only a DELETED file is erased: if the path exists on disk or in the newest
 * tree, the erase is refused.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { resolveDataDir } from "../../db.js";
import { AUTHOR_KINDS } from "./write-context.js";

/** Every author kind a commit trailer may name; anything else is unattributed. */
const COMMIT_KINDS = [...AUTHOR_KINDS, "unattributed"];

/** The codes restoreWorkspaceFile may throw with (the History API maps them). */
const RESTORE_CODES = new Set(["invalid_path", "not_found", "unsupported", "outside_workspace", "invalid_context"]);

/** The code a refusal carries when the path is unusable for an erase. */
const ERASE_PATH_CODES = new Set(["invalid_path"]);

const MS_PER_DAY = 86_400_000;

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

/**
 * The Crow git dir for one project. Derived from the project id EVERY time —
 * never read from a column, so a stale or hand-edited repo_path can never point
 * an erase (or a delete) at another directory.
 */
export function workspaceGitDir(projectId, { dataDir } = {}) {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) {
    throw workspaceError("invalid_project", "a project's file history needs a positive project id");
  }
  const root = dataDir ? resolve(dataDir) : historyDataDir();
  return join(root, "history", "workspaces", `${id}.git`);
}

/** The project id as a positive integer, or a refusal. */
function projectIdOf(project) {
  const id = Number(project && project.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw workspaceError("invalid_project", "a project's file history needs a positive project id");
  }
  return id;
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
]);

/** The Crow ignore list, written to the git dir's own info/exclude. */
const IGNORE_LIST = [
  "# Crow's own list for this project's file history. Not a workspace file.",
  ".venv/",
  "node_modules/",
  "__pycache__/",
  "*.db",
  "*.db-wal",
  "*.db-shm",
  ".cache/",
  "",
].join("\n");

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
 * quietly. Nothing else is inherited.
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
    // commit and commit-tree read their message from stdin; everything else gets
    // an immediately closed stdin so git never waits on a terminal. A command
    // that exited without reading it (init, add, ...) makes the write raise EPIPE
    // asynchronously — swallow it on the stream itself, because the call's own
    // result is what the caller cares about.
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

/**
 * Run `work` with no other work for this project in flight. A Map of promise
 * chains keyed by project id: each caller waits for the one before it and holds
 * the next slot until its own promise settles. The entry is dropped when it is
 * the tail again, so the map does not grow with every project that ever ran.
 */
async function withProjectLock(projectId, work) {
  const key = String(projectId);
  const previous = projectLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const chained = previous.then(() => gate, () => gate);
  projectLocks.set(key, chained);
  try {
    await previous.catch(() => {});
    return await work();
  } finally {
    release();
    if (projectLocks.get(key) === chained) projectLocks.delete(key);
  }
}

/* ------------------------------------------------------------ init + ensure */

/**
 * Create (or refresh) the Crow git dir for a project. Idempotent: an existing
 * HEAD is left alone, the ignore list and the attributes file are rewritten (they
 * are Crow's own settings, not workspace content), and the workspace dir is never
 * created — a project can have its history ready before it has any files.
 */
async function initGitDir(project, opts) {
  const id = projectIdOf(project);
  const repoDir = workspaceGitDir(id, opts);
  if (!existsSync(join(repoDir, "HEAD"))) {
    mkdirSync(dirname(repoDir), { recursive: true });
    // An EMPTY template: no sample hooks can end up in a directory Crow's own
    // calls use. --bare puts the repository AT this path (not a .git inside it),
    // and the next call turns it back into a work-tree-backed repository.
    await runGit([...COMMON_CONFIG, "init", "--bare", "--template=", repoDir], opts);
    await runGit([...COMMON_CONFIG, `--git-dir=${repoDir}`, "config", "core.bare", "false"], opts);
  }
  mkdirSync(join(repoDir, "info"), { recursive: true });
  writeFileSync(join(repoDir, "info", "exclude"), IGNORE_LIST, { mode: 0o600 });
  writeFileSync(join(repoDir, "info", "attributes"), ATTRIBUTES, { mode: 0o600 });
  return repoDir;
}

/**
 * Give one project a file history, and record where it is on the project row.
 *
 * Idempotent, and safe to call before the workspace exists. Never throws: a
 * missing binary or a failing call comes back as `{ disabled: true, reason }`
 * and is logged once, so project creation and boot carry on.
 *
 * @returns {Promise<{repoDir: string} | {disabled: true, reason: string}>}
 */
export async function ensureWorkspaceHistory(db, project, { dataDir, env, gitBin } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    const id = projectIdOf(project);
    const repoDir = await withProjectLock(id, () => initGitDir(project, opts));
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

/** A value as one line: CR/LF stripped, trimmed, empty as null. */
function singleLine(value) {
  if (value === null || value === undefined) return null;
  const line = String(value).replace(/[\r\n]+/g, " ").trim();
  return line === "" ? null : line;
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
 * when the context names them). Trailer values are one line each, always.
 */
function commitMessage(message, ctx) {
  const subject = (singleLine(message) || "Update").slice(0, 200);
  const { authorKind, authorId, jobId } = normalizeCtx(ctx);
  const lines = [`Crow-Author-Kind: ${authorKind}`];
  if (authorId) lines.push(`Crow-Author: ${authorId}`);
  if (jobId) lines.push(`Crow-Job: ${jobId}`);
  return `${subject}\n\n${lines.join("\n")}\n`;
}

/**
 * The trailers a stored message carries: ONLY the last paragraph's lines of the
 * form `Crow-Author-Kind: v`, `Crow-Author: v`, `Crow-Job: v`. A message with no
 * trailers is unattributed — never the owner (the design's rule).
 */
function parseTrailers(message) {
  const text = String(message || "").replace(/\s+$/, "");
  if (text === "") return { authorKind: "unattributed", authorId: null, jobId: null };
  const paragraphs = text.split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1] || "";
  let authorKind = null;
  let authorId = null;
  let jobId = null;
  for (const raw of last.split("\n")) {
    const m = /^(Crow-Author-Kind|Crow-Author|Crow-Job):[ \t]*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const value = singleLine(m[2]);
    if (m[1] === "Crow-Author-Kind") authorKind = value;
    else if (m[1] === "Crow-Author") authorId = value;
    else jobId = value;
  }
  if (authorKind === null || !COMMIT_KINDS.includes(authorKind)) authorKind = "unattributed";
  return { authorKind, authorId, jobId };
}

/**
 * Commit the workspace as it is now, as `ctx`, with `message`.
 *
 * Lazily creates the git dir (no database needed), runs `add -A`, and commits only
 * when the index actually differs from the newest commit (or when there is no
 * commit yet and the index is not empty) — so a sweep over an idle project writes
 * nothing. Returns the new commit's id, or null when there was nothing to record
 * or the history is unavailable. Never throws.
 */
export async function commitWorkspace(project, ctx, message, { dataDir, env, gitBin } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    const id = projectIdOf(project);
    return await withProjectLock(id, () => commitUnlocked(project, ctx, message, opts));
  } catch (err) {
    noteFailure(failureReason(err));
    return null;
  }
}

/** commitWorkspace's body, already inside the project's lock. */
async function commitUnlocked(project, ctx, message, opts) {
  const workspaceDir = workspaceDirOf(project);
  if (workspaceDir === null) return null; // no folder on disk: nothing to record
  const repoDir = await initGitDir(project, opts);
  const run = (rest, extra) => runGit(gitArgv(repoDir, workspaceDir, rest), { ...opts, ...extra });

  await run(["add", "-A"]);

  const head = await run(["rev-parse", "--verify", "HEAD"], { allowFail: true });
  if (head.code === 0) {
    // --cached: compare the INDEX with the newest commit only. The index is what
    // add -A just wrote, so work-tree stat noise cannot fake a change.
    const diff = await run(["diff-index", "--cached", "--quiet", "HEAD", "--"], { allowFail: true });
    if (diff.code === 0) return null;
    if (diff.code !== 1) throw Object.assign(new Error("the file history could not be compared"), { code: "git_failed" });
  } else {
    const staged = await run(["ls-files", "--cached"]);
    if (staged.text.trim() === "") return null;
  }

  await run(
    ["-c", "user.name=Crow", "-c", "user.email=history@localhost",
      "commit", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-F", "-"],
    { stdin: commitMessage(message, ctx) },
  );
  const tip = await run(["rev-parse", "--verify", "HEAD"]);
  return tip.text.trim() || null;
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

/** The op a `--name-status` entry maps to (anything not A or D is an update). */
function statusOp(status) {
  const code = String(status || "").charAt(0);
  if (code === "A") return "insert";
  if (code === "D") return "delete";
  return "update";
}

/** The path a status entry names IN THAT COMMIT (the destination of a rename). */
function statusPath(status, fallback) {
  const fields = String(status || "").split("\t");
  if (fields.length >= 3) return fields[fields.length - 1];
  if (fields.length === 2) return fields[1];
  return fallback;
}

/**
 * Parse `--format=%H%x1f%cI%x1f%B%x1e --name-status` output into commits, oldest
 * last (git's own order). The status lines follow the message and precede the
 * next header, which is why they are recognised by shape rather than position.
 */
function parseLog(text) {
  const out = [];
  let rest = String(text || "");
  while (rest.length) {
    const header = /^([0-9a-f]{40})\x1f/.exec(rest);
    if (!header) break;
    rest = rest.slice(41);
    const isoAt = rest.indexOf("\x1f");
    if (isoAt < 0) break;
    const createdAt = rest.slice(0, isoAt);
    rest = rest.slice(isoAt + 1);
    const messageAt = rest.indexOf("\x1e");
    if (messageAt < 0) break;
    const message = rest.slice(0, messageAt);
    rest = rest.slice(messageAt + 1);
    const statuses = [];
    for (;;) {
      const nl = rest.indexOf("\n");
      const line = nl < 0 ? rest : rest.slice(0, nl);
      if (/^[A-Z][0-9]*\t/.test(line)) {
        statuses.push(line);
        rest = nl < 0 ? "" : rest.slice(nl + 1);
        continue;
      }
      if (line.trim() === "") {
        if (nl < 0) {
          rest = "";
          break;
        }
        rest = rest.slice(nl + 1);
        continue;
      }
      break;
    }
    out.push({ sha: header[1], createdAt, message, statuses });
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
 * not an offset), so a page never skips or repeats a version. Every entry carries
 * the op, the trailers' author and job, the commit's time and the size of the
 * file at that version (null for the commit that deleted it).
 */
export async function listWorkspaceVersions(project, relPath, { limit = 100, before = null, dataDir, env, gitBin } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    const id = projectIdOf(project);
    const parts = normalizeRelPath(relPath);
    const path = parts.join("/");
    const repoDir = workspaceGitDir(id, opts);
    if (!existsSync(join(repoDir, "HEAD"))) return [];
    const max = Math.max(1, Math.min(Math.trunc(Number(limit)) || 100, 500));
    const args = ["log", "--follow", "--format=%H%x1f%cI%x1f%B%x1e", "--name-status"];
    if (!before) args.push(`--max-count=${max}`);
    args.push("--", path);
    const workTree = workspaceDirOf(project);
    const res = await runGit(gitArgv(repoDir, workTree, args), opts);
    let commits = parseLog(res.text);
    if (before) {
      const at = commits.findIndex((c) => c.sha === String(before));
      commits = at < 0 ? [] : commits.slice(at + 1);
    }
    commits = commits.slice(0, max);
    const out = [];
    for (const commit of commits) {
      const status = commit.statuses[0] || "";
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
 * Files whose newest commit deleted them and that are not in the newest tree —
 * the project's Trash. Nothing here reads or writes the work tree.
 */
export async function listDeletedWorkspaceFiles(project, { dataDir, env, gitBin, limit = 200 } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    const id = projectIdOf(project);
    const repoDir = workspaceGitDir(id, opts);
    if (!existsSync(join(repoDir, "HEAD"))) return [];
    const workTree = workspaceDirOf(project);
    const run = (rest, extra) => runGit(gitArgv(repoDir, workTree, rest), { ...opts, ...extra });
    const head = await run(["rev-parse", "--verify", "HEAD"], { allowFail: true });
    if (head.code !== 0) return [];
    const max = Math.max(1, Math.trunc(Number(limit)) || 200);

    const names = await run(["log", "--all", "--diff-filter=D", "--name-only", "--format="]);
    const candidates = [...new Set(names.text.split("\n").map((s) => s.trim()).filter(Boolean))].sort();

    const out = [];
    for (const path of candidates) {
      if (out.length >= max) break;
      // A file that is back in the newest tree is not in the Trash.
      const inHead = await run(["cat-file", "-e", `HEAD:${path}`], { allowFail: true });
      if (inHead.code === 0) continue;
      const last = await run(["log", "-1", "--format=%H%x1f%cI%x1f%B%x1e", "--name-status", "--", path]);
      const [commit] = parseLog(last.text);
      if (!commit) continue;
      if (!String(commit.statuses[0] || "").startsWith("D")) continue;
      const trailers = parseTrailers(commit.message);
      out.push({
        path,
        deletedAt: commit.createdAt,
        authorKind: trailers.authorKind,
        authorId: trailers.authorId,
      });
    }
    return out;
  } catch (err) {
    noteFailure(failureReason(err));
    return [];
  }
}

/* -------------------------------------------------------------- the restore */

/**
 * The absolute target of a restore inside the workspace, with every escape
 * checked: the path is already relative and normalized, the target itself must
 * not be a link, and the deepest ancestor that EXISTS must resolve to a place
 * inside the workspace (a symlinked folder may not lead out of it).
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
  let probeReal = null;
  while (probeReal === null) {
    try {
      probeReal = realpathSync(probe);
    } catch {
      const up = dirname(probe);
      if (up === probe) throw workspaceError("invalid_path", "that path cannot be resolved");
      probe = up;
    }
  }
  if (probeReal !== workspaceReal && !probeReal.startsWith(workspaceReal + sep)) {
    throw workspaceError("outside_workspace", "that path leads outside the workspace folder");
  }
  return { workspaceReal, target };
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
 * and that actually touched the path; a stored link or a nested-repository entry
 * is refused as unsupported. Pending outside changes are committed first
 * (unattributed / outside-crow), so the restore's own commit holds exactly its
 * change; then the bytes are written through a temporary file in the same folder
 * and renamed into place, and the result is committed as `ctx`. Restoring what is
 * already there writes and commits nothing (`unchanged: true`).
 *
 * @returns {Promise<{newVersionId: string|null, unchanged: boolean}>}
 */
export async function restoreWorkspaceFile(project, relPath, sha, ctx, { dataDir, env, gitBin } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    const id = projectIdOf(project);
    if (!isObject(ctx) || !AUTHOR_KINDS.includes(ctx.authorKind)) {
      throw workspaceError(
        "invalid_context",
        "a restore must name who is restoring it (authorKind owner, bot, peer or system)",
      );
    }
    const version = String(sha == null ? "" : sha).trim();
    if (!/^[0-9a-f]{40}$/.test(version)) throw workspaceError("not_found", "that is not a version of this file");
    return await withProjectLock(id, () => restoreUnlocked(project, relPath, version, ctx, opts));
  } catch (err) {
    if (err && RESTORE_CODES.has(err.code)) throw err;
    noteFailure(failureReason(err));
    throw workspaceError("not_found", "that version could not be restored");
  }
}

/** restoreWorkspaceFile's body, already inside the project's lock. */
async function restoreUnlocked(project, relPath, version, ctx, opts) {
  const id = projectIdOf(project);
  const parts = normalizeRelPath(relPath);
  const path = parts.join("/");
  const { target } = containedTarget(project, parts);

  const repoDir = workspaceGitDir(id, opts);
  if (!existsSync(join(repoDir, "HEAD"))) throw workspaceError("not_found", "this project has no file history yet");
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
  await commitUnlocked(project, { authorKind: "unattributed", authorId: "outside-crow" }, "Update", opts);

  let unchanged = false;
  try {
    unchanged = readFileSync(target).equals(bytes);
  } catch {
    unchanged = false;
  }
  if (unchanged) return { newVersionId: null, unchanged: true };

  const mode = at.mode === "100755" ? 0o755 : 0o644;
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.crow-restore-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temp, bytes, { flag: "wx" });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (err) {
    try { rmSync(temp, { force: true }); } catch {}
    throw workspaceError("invalid_path", `that file could not be written (${failureReason(err)})`);
  }

  const newVersionId = await commitUnlocked(project, ctx, `Restored ${path}`, opts);
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

/** Parse `%H %an %ae %aI %cn %ce %cI %B` records into commit metadata. */
function parseCommitMeta(text) {
  const out = [];
  for (const part of String(text || "").split("\x1e")) {
    const block = part.replace(/^\n+/, "");
    if (block === "") continue;
    const m = /^([0-9a-f]{40})\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([\s\S]*)$/.exec(block);
    if (!m) continue;
    out.push({
      sha: m[1],
      authorName: m[2],
      authorEmail: m[3],
      authorDate: m[4],
      committerName: m[5],
      committerEmail: m[6],
      committerDate: m[7],
      message: m[8],
    });
  }
  return out;
}

/**
 * Remove one deleted path from Crow's history for this project, and from nothing
 * else.
 *
 * Refused unless the path is a DELETED file: present in the work tree, or present
 * in the newest tree, means it is not in the Trash and stays. The rewrite replays
 * the linear history with plumbing and a temporary index — the work tree is never
 * touched — re-creating each kept commit with its original author, committer,
 * dates and message, and dropping the commits whose tree did not change. Then the
 * old objects are made unreachable and pruned, and only the real index is
 * refreshed (without -u).
 *
 * @returns {Promise<{erased: boolean, reason?: string}>}
 */
export async function eraseWorkspaceFile(project, relPath, { dataDir, env, gitBin } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    const id = projectIdOf(project);
    return await withProjectLock(id, () => eraseUnlocked(project, relPath, opts));
  } catch (err) {
    const reason = failureReason(err);
    noteFailure(reason);
    return { erased: false, reason };
  }
}

/** eraseWorkspaceFile's body, already inside the project's lock. */
async function eraseUnlocked(project, relPath, opts) {
  const id = projectIdOf(project);
  let parts;
  try {
    parts = normalizeRelPath(relPath);
  } catch (err) {
    if (err && ERASE_PATH_CODES.has(err.code)) return { erased: false, reason: err.code };
    throw err;
  }
  const path = parts.join("/");
  const repoDir = workspaceGitDir(id, opts);
  if (!existsSync(join(repoDir, "HEAD"))) return { erased: false, reason: "no_history" };
  const workTree = project && project.workspace_dir;

  // Only a DELETED file is erased: anything still on disk stays, untouched.
  if (typeof workTree === "string" && workTree !== "") {
    try {
      lstatSync(join(workTree, ...parts));
      return { erased: false, reason: "exists" };
    } catch {
      /* absent from the work tree: good */
    }
  }
  const inHead = await runGit(gitArgv(repoDir, workTree, ["cat-file", "-e", `HEAD:${path}`]), { ...opts, allowFail: true });
  if (inHead.code === 0) return { erased: false, reason: "exists" };

  const indexFile = join(repoDir, "crow-erase.index");
  try { rmSync(indexFile, { force: true }); } catch {}
  try {
    const listed = await runGit(gitArgv(repoDir, workTree, ["rev-list", "--reverse", "HEAD"]), opts);
    const order = listed.text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (order.length === 0) return { erased: false, reason: "no_history" };

    const meta = await runGit(
      gitArgv(repoDir, workTree, [
        "log", "--reverse", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B%x1e",
      ]),
      opts,
    );
    const bySha = new Map(parseCommitMeta(meta.text).map((c) => [c.sha, c]));

    let parentId = null;
    let parentTree = null;
    for (const sha of order) {
      const info = bySha.get(sha);
      if (!info) throw Object.assign(new Error("the file history could not be read"), { code: "git_failed" });
      // A scratch index per commit: replay that commit's tree, drop the path,
      // write the tree back. Nothing here can update a work-tree file.
      await runGit(gitArgv(repoDir, workTree, ["read-tree", sha]), { ...opts, indexFile });
      await runGit(gitArgv(repoDir, workTree, ["rm", "--cached", "--ignore-unmatch", "--", path]), { ...opts, indexFile });
      const tree = (await runGit(gitArgv(repoDir, workTree, ["write-tree"]), { ...opts, indexFile })).text.trim();

      const isRoot = parentId === null;
      if (!isRoot && tree === parentTree) {
        // This commit held nothing but the erased path: it collapses into its
        // parent, i.e. it keeps pointing at the last KEPT commit's new id.
        continue;
      }
      const args = ["commit-tree", tree];
      if (!isRoot) args.push("-p", parentId);
      args.push("-F", "-");
      const made = await runGit(gitArgv(repoDir, workTree, args), {
        ...opts,
        indexFile,
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
      parentId = made.text.trim();
      parentTree = tree;
    }
    if (!parentId) return { erased: false, reason: "no_history" };

    await runGit(gitArgv(repoDir, workTree, ["update-ref", "HEAD", parentId]), opts);
    // Never created by this code (there is no rewrite helper involved), but a
    // leftover backup ref would keep the erased object alive: delete any.
    const backups = await runGit(gitArgv(repoDir, workTree, ["for-each-ref", "--format=%(refname)", "refs/original/"]), opts);
    for (const ref of backups.text.split("\n").map((s) => s.trim()).filter(Boolean)) {
      await runGit(gitArgv(repoDir, workTree, ["update-ref", "-d", ref]), opts);
    }
    await runGit(gitArgv(repoDir, workTree, ["reflog", "expire", "--expire=now", "--all"]), {
      ...opts,
      timeout: GIT_SLOW_TIMEOUT_MS,
    });
    await runGit(gitArgv(repoDir, workTree, ["gc", "--prune=now", "--quiet"]), {
      ...opts,
      timeout: GIT_SLOW_TIMEOUT_MS,
    });
    // Only the real index is refreshed, and WITHOUT -u: the work tree is untouched.
    await runGit(gitArgv(repoDir, workTree, ["read-tree", "HEAD"]), opts);
    return { erased: true };
  } finally {
    try { rmSync(indexFile, { force: true }); } catch {}
  }
}

/**
 * Erase every file already in the Trash longer than the Trash period. A file that
 * still exists is never touched (eraseUnlocked refuses it). Returns the paths
 * erased, oldest first.
 */
export async function eraseExpiredWorkspaceFiles(project, trashDays, { dataDir, env, gitBin, now } = {}) {
  const opts = { dataDir, env, gitBin };
  try {
    const id = projectIdOf(project);
    return await withProjectLock(id, () => eraseExpiredUnlocked(project, trashDays, opts, now));
  } catch (err) {
    noteFailure(failureReason(err));
    return [];
  }
}

/** eraseExpiredWorkspaceFiles' body, already inside the project's lock. */
async function eraseExpiredUnlocked(project, trashDays, opts, now) {
  const days = Number(trashDays);
  if (!Number.isFinite(days) || days <= 0) return [];
  const cutoff = nowMs(now) - days * MS_PER_DAY;
  const deleted = await listDeletedWorkspaceFiles(project, opts);
  const erased = [];
  for (const file of deleted) {
    const at = Date.parse(file.deletedAt);
    if (!Number.isFinite(at) || at > cutoff) continue;
    const outcome = await eraseUnlocked(project, file.path, opts);
    if (outcome.erased) erased.push(file.path);
  }
  return erased;
}

/* -------------------------------------------------------------- the sweep */

/** Where the round-robin walk of already-set-up projects continues (per handle). */
const sweepCursors = new WeakMap();

/**
 * One bounded pass over the projects that have a workspace.
 *
 * Projects whose history is not set up yet (no repo_path, or no git dir on disk)
 * go FIRST, so a project that predates this feature is picked up on the next
 * sweep — and the pass commits its current files as the unattributed baseline.
 * The rest go round-robin from an in-process cursor, so a host with more projects
 * than `batch` still covers them all over successive passes. Each project stands
 * alone: one failure is counted and the pass carries on. When `trashDays` is a
 * number, each visited project also erases the files that have been in its Trash
 * longer than that.
 *
 * @returns {Promise<{ensured: number, committed: number, erased: number, failed: number}>}
 */
export async function sweepWorkspaces(db, { dataDir, env, gitBin, batch = 20, trashDays, now } = {}) {
  const result = { ensured: 0, committed: 0, erased: 0, failed: 0 };
  const opts = { dataDir, env, gitBin };
  if (!db || typeof db.execute !== "function") return result;

  let rows = [];
  try {
    const res = await db.execute({
      sql: `SELECT id, workspace_dir, repo_path FROM project_spaces
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
      canonical = workspaceGitDir(Number(row.id), opts);
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
    const project = { id: Number(row.id), workspace_dir: row.workspace_dir };
    const isNew = setupNow.includes(row);
    try {
      await withProjectLock(project.id, async () => {
        const repoDir = await initGitDir(project, opts);
        if (isNew) result.ensured += 1;
        if (String(row.repo_path || "") !== repoDir) {
          try {
            await db.execute({ sql: "UPDATE project_spaces SET repo_path = ? WHERE id = ?", args: [repoDir, project.id] });
          } catch (err) {
            if (!/no such column/i.test(String(err && err.message))) throw err;
          }
        }
        // The baseline for a project picked up now, and any outside edit for one
        // already covered: unattributed, never the owner.
        const sha = await commitUnlocked(
          project,
          { authorKind: "unattributed", authorId: "outside-crow" },
          "Update",
          opts,
        );
        if (sha) result.committed += 1;
        if (typeof trashDays === "number" && Number.isFinite(trashDays)) {
          result.erased += (await eraseExpiredUnlocked(project, trashDays, opts, now)).length;
        }
      });
    } catch (err) {
      result.failed += 1;
      noteFailure(failureReason(err));
    }
  }
  return result;
}

/* ------------------------------------------------------------- the removal */

/**
 * Delete one project's file history. EXACTLY `workspaceGitDir(projectId)` — never
 * a path from a column — so a permanent project delete can never remove anything
 * else. Returns false when the directory could not be removed.
 */
export function removeWorkspaceHistory(projectId, { dataDir } = {}) {
  try {
    rmSync(workspaceGitDir(projectId, { dataDir }), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}