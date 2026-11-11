/**
 * Version history, Task 6: a project's workspace FILES.
 *
 * Every test drives the real `git` binary against real temp directories: a
 * workspace folder, and a data dir holding the project's own git dir under
 * history/workspaces/<id>.git. Nothing here needs a gateway. Tests that need a
 * project row build a real crow.db with scripts/init-db.js (plus the
 * project_spaces.repo_path column the board migration adds), the same way
 * tests/history-api.test.js and tests/project-spaces-helper.test.js do.
 *
 * When git is not installed every test skips with a plain message instead of
 * failing: file history is optional at runtime, so it must not be a hard test
 * dependency either.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO = new URL("..", import.meta.url).pathname;

/** Real git, or every test skips with a clear reason. */
const GIT_OK = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const NO_GIT = GIT_OK ? false : "git is not installed on this machine";

const OWNER = { authorKind: "owner", authorId: "abcd1234", jobId: "session:abcd1234" };
const BOT = { authorKind: "bot", authorId: "hank", jobId: "card:7" };

/* ------------------------------------------------------------ environment */

const savedEnv = {};
function setEnv(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const disposers = [];
after(() => {
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch { /* best effort */ }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A temp root with a fresh data dir (and a workspace path inside it). */
function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const fx = {
    root,
    dataDir,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
  disposers.push(fx.dispose);
  return fx;
}

/**
 * A real crow.db from init-db.js, with the project_spaces.repo_path column the
 * board migration adds (init-db alone does not carry it). CROW_DATA_DIR points at
 * the data dir so project-spaces.js and the history module agree on where it is.
 */
async function dbFixture(prefix) {
  const fx = fixture(prefix);
  setEnv({ CROW_DATA_DIR: fx.dataDir, CROW_DB_PATH: undefined });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    cwd: REPO,
    env: { ...process.env, CROW_DATA_DIR: fx.dataDir, CROW_DB_PATH: "" },
    stdio: "pipe",
  });
  const dbPath = join(fx.dataDir, "crow.db");
  const raw = new Database(dbPath);
  raw.exec("ALTER TABLE project_spaces ADD COLUMN repo_path TEXT");
  raw.close();
  // The version table the History API reads for the database item types (the
  // production shape: this fixture only needs it for the "table types are
  // unchanged" assertions, not for anything about files).
  const { run: migrateItemVersions } = await import("../scripts/migrations/0024-item-versions.mjs");
  migrateItemVersions({ dbPath, log: () => {} });
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient(dbPath);
  disposers.push(() => {
    try { db.close(); } catch { /* already closed */ }
  });
  fx.db = db;
  fx.dbPath = dbPath;
  return fx;
}

/* ------------------------------------------------------------------- git */

/** Run git against a Crow git dir + work tree (test side; the module has its own). */
function gitIn(gitDir, workTree, args) {
  return execFileSync("git", ["--git-dir=" + gitDir, "--work-tree=" + workTree, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Run git against a Crow git dir, text out. */
const gitText = (gitDir, workTree, args) => gitIn(gitDir, workTree, args).toString("utf8");

/** Run git in a plain repository (the workspace's OWN repo, an outer repo). */
function plainGit(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

const plainCommit = (cwd, message) => plainGit(cwd, [
  "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid",
  "commit", "-m", message,
]);

/** A synthetic project row: the git side never reads anything else. */
const projectFor = (id, workspaceDir) => ({ id, workspace_dir: workspaceDir });

/** Write a workspace file and commit it as `ctx`. */
async function save(project, name, text, ctx, opts) {
  writeFileSync(join(project.workspace_dir, name), text);
  const { commitWorkspace } = await import("../servers/shared/history/workspace-history.js");
  return commitWorkspace(project, ctx, `Save ${name}`, opts);
}

const {
  commitWorkspace,
  ensureWorkspaceHistory,
  eraseExpiredWorkspaceFiles,
  eraseWorkspaceFile,
  listDeletedWorkspaceFiles,
  listWorkspaceVersions,
  removeWorkspaceHistory,
  restoreWorkspaceFile,
  sweepWorkspaces,
  workspaceGitDir,
} = await import("../servers/shared/history/workspace-history.js");

/* --------------------------------------------------------------- tests */

test("a new project gets its own file history beside the data dir, and two saves are two versions", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-new-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const created = await createProjectSpace(fx.db, { name: "Workspace History" });

  const gitDir = workspaceGitDir(created.id, { dataDir: fx.dataDir });
  assert.equal(gitDir, join(fx.dataDir, "history", "workspaces", `${created.id}.git`), "the git dir is derived from the project id");
  assert.ok(existsSync(join(gitDir, "HEAD")), "the file history exists");
  assert.equal(existsSync(join(gitDir, "hooks")), false, "an empty template means no sample hooks at all");

  const row = (await fx.db.execute({ sql: "SELECT repo_path FROM project_spaces WHERE id = ?", args: [created.id] })).rows[0];
  assert.equal(row.repo_path, gitDir, "repo_path records where the file history lives");

  mkdirSync(created.workspaceDir, { recursive: true });
  assert.equal(existsSync(join(created.workspaceDir, ".git")), false, "no .git inside the workspace");
  const project = projectFor(created.id, created.workspaceDir);

  const first = await save(project, "notes.txt", "first version\n", OWNER, { dataDir: fx.dataDir });
  assert.match(first, /^[0-9a-f]{40}$/);
  const second = await save(project, "notes.txt", "second version\n", OWNER, { dataDir: fx.dataDir });
  assert.match(second, /^[0-9a-f]{40}$/);
  assert.notEqual(first, second);

  const versions = await listWorkspaceVersions(project, "notes.txt", { dataDir: fx.dataDir });
  assert.deepEqual(versions.map((v) => v.op), ["update", "insert"], "newest first");
  assert.equal(versions[0].id, second);
  assert.equal(versions[1].id, first);
  assert.equal(versions[1].size, "first version\n".length);
  assert.equal(versions[0].size, "second version\n".length);
  assert.equal(versions[0].authorKind, "owner");
  assert.equal(versions[0].authorId, "abcd1234");
  assert.equal(versions[0].jobId, "session:abcd1234");
  assert.equal(existsSync(join(created.workspaceDir, ".git")), false, "still no .git inside the workspace");
});

test("a bot's save carries its author and job, and reads back as the bot's", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-bot-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(3, ws);

  await save(project, "report.md", "draft\n", BOT, { dataDir: fx.dataDir });
  const [version] = await listWorkspaceVersions(project, "report.md", { dataDir: fx.dataDir });
  assert.equal(version.authorKind, "bot");
  assert.equal(version.authorId, "hank");
  assert.equal(version.jobId, "card:7");

  // A kind Crow does not know is recorded as unattributed, never as the owner.
  writeFileSync(join(ws, "report.md"), "draft two\n");
  await commitWorkspace(project, { authorKind: "robot", authorId: "r2" }, "Unknown author", { dataDir: fx.dataDir });
  const [newest] = await listWorkspaceVersions(project, "report.md", { dataDir: fx.dataDir });
  assert.equal(newest.authorKind, "unattributed");
  assert.equal(newest.authorId, "r2");
});

test("an outside edit is swept in, attributed unattributed / outside-crow", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-sweep-");
  const ws = join(fx.dataDir, "projects", "swept-1", "workspace");
  mkdirSync(ws, { recursive: true });
  // A project that predates the feature: workspace set, repo_path NULL.
  await fx.db.execute({
    sql: "INSERT INTO project_spaces (id, slug, name, workspace_dir) VALUES (1, 'swept-1', 'Swept', ?)",
    args: [ws],
  });
  const project = projectFor(1, ws);
  writeFileSync(join(ws, "a.txt"), "before\n");

  const first = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30 });
  assert.deepEqual(first, { ensured: 1, committed: 1, erased: 0, failed: 0 });
  const row = (await fx.db.execute({ sql: "SELECT repo_path FROM project_spaces WHERE id = 1" })).rows[0];
  assert.equal(row.repo_path, workspaceGitDir(1, { dataDir: fx.dataDir }));

  let versions = await listWorkspaceVersions(project, "a.txt", { dataDir: fx.dataDir });
  assert.deepEqual(versions.map((v) => [v.op, v.authorKind, v.authorId]), [["insert", "unattributed", "outside-crow"]]);

  writeFileSync(join(ws, "a.txt"), "after\n");
  const second = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30 });
  assert.equal(second.committed, 1);
  versions = await listWorkspaceVersions(project, "a.txt", { dataDir: fx.dataDir });
  assert.deepEqual(versions.map((v) => [v.op, v.authorKind, v.authorId]), [
    ["update", "unattributed", "outside-crow"],
    ["insert", "unattributed", "outside-crow"],
  ]);

  // An idle project writes nothing.
  const third = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30 });
  assert.equal(third.committed, 0);
  assert.equal(third.ensured, 0);
});

test("restoring a version gives the old bytes, a new version, and keeps the later ones", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-restore-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(4, ws);

  const first = await save(project, "notes.txt", "first version\n", OWNER, { dataDir: fx.dataDir });
  const second = await save(project, "notes.txt", "second version\n", OWNER, { dataDir: fx.dataDir });

  const restored = await restoreWorkspaceFile(project, "notes.txt", first, BOT, { dataDir: fx.dataDir });
  assert.equal(restored.unchanged, false);
  assert.match(restored.newVersionId, /^[0-9a-f]{40}$/);
  assert.notEqual(restored.newVersionId, first);
  assert.notEqual(restored.newVersionId, second);
  assert.equal(readFileSync(join(ws, "notes.txt"), "utf8"), "first version\n", "the old bytes are back");

  const versions = await listWorkspaceVersions(project, "notes.txt", { dataDir: fx.dataDir });
  assert.equal(versions.length, 3, "a restore appends; nothing that came after is removed");
  assert.equal(versions[0].id, restored.newVersionId);
  assert.equal(versions[0].op, "update");
  assert.equal(versions[0].authorKind, "bot");
  assert.equal(versions[0].authorId, "hank");
  assert.deepEqual(versions.slice(1).map((v) => v.id), [second, first]);

  // Restoring what is already there writes and records nothing.
  const again = await restoreWorkspaceFile(project, "notes.txt", first, BOT, { dataDir: fx.dataDir });
  assert.deepEqual(again, { newVersionId: null, unchanged: true });
  assert.equal((await listWorkspaceVersions(project, "notes.txt", { dataDir: fx.dataDir })).length, 3);
});

test("a workspace that is its own repository keeps its HEAD, branch, log and index", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-ownrepo-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  plainGit(ws, ["init", "-q", "-b", "main"]);
  writeFileSync(join(ws, "mine.txt"), "my own project\n");
  plainGit(ws, ["add", "-A"]);
  plainCommit(ws, "my own first save");

  const head = plainGit(ws, ["rev-parse", "HEAD"]);
  const branch = plainGit(ws, ["symbolic-ref", "--short", "HEAD"]);
  const log = plainGit(ws, ["log", "--format=%H%x1f%s"]);
  const index = plainGit(ws, ["ls-files", "-s"]);

  const project = projectFor(5, ws);
  writeFileSync(join(ws, "crow-work.txt"), "written while the history runs\n");
  const sha = await commitWorkspace(project, OWNER, "Crow records the file", { dataDir: fx.dataDir });
  assert.match(sha, /^[0-9a-f]{40}$/);

  assert.equal(plainGit(ws, ["rev-parse", "HEAD"]), head, "the workspace's own HEAD is untouched");
  assert.equal(plainGit(ws, ["symbolic-ref", "--short", "HEAD"]), branch, "the branch is untouched");
  assert.equal(plainGit(ws, ["log", "--format=%H%x1f%s"]), log, "the workspace's own log is untouched");
  assert.equal(plainGit(ws, ["ls-files", "-s"]), index, "the workspace's own index is untouched");
  assert.ok(lstatSync(join(ws, ".git")).isDirectory(), "the workspace keeps its own .git");

  const gitDir = workspaceGitDir(project.id, { dataDir: fx.dataDir });
  assert.ok(existsSync(join(gitDir, "HEAD")), "Crow's history lives in its own git dir");
  assert.equal(existsSync(join(gitDir, "worktrees")), false);
  const crowTree = gitText(gitDir, ws, ["ls-tree", "-r", "--name-only", "HEAD"]);
  assert.ok(crowTree.split("\n").includes("crow-work.txt"));
  assert.ok(!crowTree.split("\n").some((name) => name.startsWith(".git")), "the workspace's own .git is never recorded");
  assert.equal((await listWorkspaceVersions(project, "crow-work.txt", { dataDir: fx.dataDir })).length, 1);
});

test("a workspace inside an outer repository leaves that repository alone", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-outer-");
  const outer = join(fx.root, "outer");
  mkdirSync(outer);
  plainGit(outer, ["init", "-q", "-b", "main"]);
  writeFileSync(join(outer, "README.md"), "outer\n");
  plainGit(outer, ["add", "-A"]);
  plainCommit(outer, "outer first save");
  const head = plainGit(outer, ["rev-parse", "HEAD"]);
  const index = plainGit(outer, ["ls-files", "-s"]);

  const ws = join(outer, "sub", "workspace");
  mkdirSync(ws, { recursive: true });
  const project = projectFor(6, ws);
  await save(project, "inside.txt", "inside the outer repo\n", OWNER, { dataDir: fx.dataDir });

  assert.equal(plainGit(outer, ["rev-parse", "HEAD"]), head, "the outer repository's HEAD is untouched");
  assert.equal(plainGit(outer, ["ls-files", "-s"]), index, "the outer repository's index is untouched");
  assert.equal(existsSync(join(ws, ".git")), false, "no .git anywhere inside the workspace");
  assert.ok(existsSync(join(workspaceGitDir(project.id, { dataDir: fx.dataDir }), "HEAD")));
});

test("a Trash file past the period is erased from history and from nowhere else", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-erase-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(7, ws);

  writeFileSync(join(ws, "keep.txt"), "keep me\n");
  writeFileSync(join(ws, "drop.txt"), "erase me entirely\n");
  const withBoth = await commitWorkspace(project, OWNER, "Add both", { dataDir: fx.dataDir });
  const gitDir = workspaceGitDir(project.id, { dataDir: fx.dataDir });
  const oldBlob = gitText(gitDir, ws, ["rev-parse", `${withBoth}:drop.txt`]).trim();

  unlinkSync(join(ws, "drop.txt"));
  await commitWorkspace(project, OWNER, "Delete drop", { dataDir: fx.dataDir });
  assert.equal(existsSync(join(ws, "drop.txt")), false);

  const trashed = await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir });
  assert.deepEqual(trashed.map((entry) => entry.path), ["drop.txt"]);
  assert.equal(trashed[0].authorKind, "owner");

  // A file that still exists is never erased.
  assert.deepEqual(await eraseWorkspaceFile(project, "keep.txt", { dataDir: fx.dataDir }), { erased: false, reason: "exists" });
  assert.equal(readFileSync(join(ws, "keep.txt"), "utf8"), "keep me\n");

  // Not yet past the period: nothing happens.
  assert.deepEqual(await eraseExpiredWorkspaceFiles(project, 30, { dataDir: fx.dataDir }), []);
  // Past the period: the deleted file goes.
  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  assert.deepEqual(await eraseExpiredWorkspaceFiles(project, 30, { dataDir: fx.dataDir, now: inAMonth }), ["drop.txt"]);

  assert.equal(gitText(gitDir, ws, ["log", "--all", "--format=%H", "--", "drop.txt"]).trim(), "", "no version mentions it any more");
  assert.equal(readFileSync(join(ws, "keep.txt"), "utf8"), "keep me\n", "other files' bytes are untouched");
  assert.match(gitText(gitDir, ws, ["log", "--format=%H", "--", "keep.txt"]).trim(), /^[0-9a-f]{40}/, "other files' history is intact");
  assert.equal(gitText(gitDir, ws, ["for-each-ref", "refs/original"]).trim(), "", "no backup ref keeps the old objects alive");

  let objectGone = false;
  try {
    gitIn(gitDir, ws, ["cat-file", "-e", oldBlob]);
  } catch {
    objectGone = true;
  }
  assert.equal(objectGone, true, "the erased bytes are really gone from the object store");
  assert.equal(existsSync(join(ws, "drop.txt")), false, "the erase never re-creates a file");
});

test("the ignore list keeps caches, dependencies and databases out of the history", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-ignore-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(8, ws);

  for (const [dir, file] of [["node_modules", "x.js"], ["__pycache__", "x.pyc"], [".venv", "pyvenv.cfg"], [".cache", "x"]]) {
    mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(ws, dir, file), "generated\n");
  }
  for (const file of ["a.db", "a.db-wal", "a.db-shm"]) writeFileSync(join(ws, file), "binary-ish\n");
  writeFileSync(join(ws, "notes.md"), "kept\n");

  const sha = await commitWorkspace(project, OWNER, "Add everything", { dataDir: fx.dataDir });
  assert.match(sha, /^[0-9a-f]{40}$/);
  const gitDir = workspaceGitDir(project.id, { dataDir: fx.dataDir });
  const tree = gitText(gitDir, ws, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  assert.deepEqual(tree, ["notes.md"], "only the real file is recorded");
});

test("a planted hook or attributes file in the workspace runs nothing and changes no stored bytes", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-hostile-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(9, ws);
  const hookMarker = join(fx.root, "hook-ran");
  const filterMarker = join(fx.root, "filter-ran");

  // A workspace that carries its own .git directory, complete with a hook and a
  // filter driver — the things a bot could plant if Crow ever ran git HERE.
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  writeFileSync(join(ws, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${hookMarker}\n`, { mode: 0o755 });
  writeFileSync(
    join(ws, ".git", "config"),
    `[core]\n\thooksPath = .git/hooks\n[filter "evil"]\n\tclean = /bin/sh -c 'touch ${filterMarker}'\n`,
  );
  writeFileSync(join(ws, ".gitattributes"), "* filter=evil\n* text eol=crlf\n");

  const crlf = "line one\r\nline two\r\n";
  writeFileSync(join(ws, "crlf.txt"), crlf);
  const sha = await commitWorkspace(project, OWNER, "Add a CRLF file", { dataDir: fx.dataDir });
  assert.match(sha, /^[0-9a-f]{40}$/);

  assert.equal(existsSync(hookMarker), false, "the planted hook never ran");
  assert.equal(existsSync(filterMarker), false, "the planted filter never ran");
  const gitDir = workspaceGitDir(project.id, { dataDir: fx.dataDir });
  const stored = gitIn(gitDir, ws, ["cat-file", "blob", `${sha}:crlf.txt`]);
  assert.deepEqual(Buffer.from(stored), Buffer.from(crlf), "the stored bytes are byte-exact");
  assert.equal(readFileSync(join(ws, "crlf.txt"), "utf8"), crlf);
});

test("a restore refuses paths that could escape the workspace, and writes nothing outside", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-paths-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(10, ws);
  const first = await save(project, "notes.txt", "first version\n", OWNER, { dataDir: fx.dataDir });
  await save(project, "notes.txt", "second version\n", OWNER, { dataDir: fx.dataDir });

  const outside = join(fx.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "target.txt"), "outside\n");
  symlinkSync(outside, join(ws, "escape"), "dir");
  symlinkSync(join(fx.root, "nowhere.txt"), join(ws, "dangling.txt"));

  const attempt = (path) => restoreWorkspaceFile(project, path, first, OWNER, { dataDir: fx.dataDir });
  const codeIs = (code) => (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  };
  await assert.rejects(() => attempt("../escape.txt"), codeIs("invalid_path"));
  await assert.rejects(() => attempt(join(fx.root, "absolute.txt")), codeIs("invalid_path"));
  await assert.rejects(() => attempt(".git/config"), codeIs("invalid_path"));
  await assert.rejects(() => attempt("escape/evil.txt"), codeIs("outside_workspace"));
  await assert.rejects(() => attempt("dangling.txt"), codeIs("invalid_path"));

  assert.equal(existsSync(join(outside, "evil.txt")), false, "nothing was written outside the workspace");
  assert.equal(existsSync(join(fx.root, "escape.txt")), false);
  assert.equal(existsSync(join(fx.root, "absolute.txt")), false);
  assert.equal(readFileSync(join(ws, "notes.txt"), "utf8"), "second version\n", "a refused restore changes nothing");
});

test("a version that holds a link cannot be restored", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-linkversion-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(11, ws);
  await save(project, "notes.txt", "a real file\n", OWNER, { dataDir: fx.dataDir });

  symlinkSync("notes.txt", join(ws, "alias.txt"));
  const linkVersion = await commitWorkspace(project, OWNER, "Add a link", { dataDir: fx.dataDir });
  unlinkSync(join(ws, "alias.txt"));
  await commitWorkspace(project, OWNER, "Remove the link", { dataDir: fx.dataDir });

  await assert.rejects(
    () => restoreWorkspaceFile(project, "alias.txt", linkVersion, OWNER, { dataDir: fx.dataDir }),
    (err) => err.code === "unsupported",
  );
  assert.equal(existsSync(join(ws, "alias.txt")), false, "no link was written back");
});

test("a missing binary degrades quietly: nothing throws, nothing is recorded", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-nogit-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "a.txt"), "a\n");
  const project = projectFor(12, ws);
  const missing = { dataDir: fx.dataDir, gitBin: join(fx.root, "no-such-git") };

  const fakeDb = { execute: async () => ({ rows: [], rowsAffected: 0 }) };
  const ensured = await ensureWorkspaceHistory(fakeDb, project, missing);
  assert.equal(ensured.disabled, true);
  assert.equal(ensured.reason, "git_missing");

  assert.equal(await commitWorkspace(project, OWNER, "nothing", missing), null);
  assert.deepEqual(await listWorkspaceVersions(project, "a.txt", missing), []);
  assert.deepEqual(await listDeletedWorkspaceFiles(project, missing), []);
  assert.deepEqual(await eraseWorkspaceFile(project, "a.txt", missing), { erased: false, reason: "no_history" });
  assert.deepEqual(await eraseExpiredWorkspaceFiles(project, 30, missing), []);
  await assert.rejects(
    () => restoreWorkspaceFile(project, "a.txt", "0".repeat(40), OWNER, missing),
    (err) => typeof err.code === "string",
  );

  // The same with an EMPTY PATH: the binary cannot be found at all.
  const emptyBin = join(fx.root, "empty-bin");
  mkdirSync(emptyBin);
  const noPath = { dataDir: fx.dataDir, env: { PATH: emptyBin } };
  const again = await ensureWorkspaceHistory(fakeDb, project, noPath);
  assert.equal(again.disabled, true);
  assert.equal(await commitWorkspace(project, OWNER, "nothing", noPath), null);
});

test("removing a project's file history removes only that project's", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-remove-");
  const one = join(fx.root, "one");
  const two = join(fx.root, "two");
  mkdirSync(one);
  mkdirSync(two);
  for (const project of [projectFor(21, one), projectFor(22, two)]) {
    const ensured = await ensureWorkspaceHistory(null, project, { dataDir: fx.dataDir });
    assert.ok(ensured.repoDir);
  }
  const dirOne = workspaceGitDir(21, { dataDir: fx.dataDir });
  const dirTwo = workspaceGitDir(22, { dataDir: fx.dataDir });
  assert.ok(existsSync(dirOne) && existsSync(dirTwo));

  assert.equal(removeWorkspaceHistory(21, { dataDir: fx.dataDir }), true);
  assert.equal(existsSync(dirOne), false, "the named project's history is gone");
  assert.ok(existsSync(dirTwo), "the other project's history is untouched");
  assert.equal(removeWorkspaceHistory(999, { dataDir: fx.dataDir }), true, "an absent one is not a failure");
});

test("the sweep covers projects in bounded batches, newest setups first", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-batch-");
  for (const id of [1, 2]) {
    const ws = join(fx.dataDir, "projects", `batch-${id}`, "workspace");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "f.txt"), `project ${id}\n`);
    await fx.db.execute({
      sql: "INSERT INTO project_spaces (id, slug, name, workspace_dir) VALUES (?, ?, ?, ?)",
      args: [id, `batch-${id}`, `Batch ${id}`, ws],
    });
  }
  const first = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, batch: 1 });
  assert.equal(first.ensured, 1, "one project per pass");
  const second = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, batch: 1 });
  assert.equal(second.ensured, 1, "the other one is picked up next");
  const third = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, batch: 1 });
  assert.equal(third.ensured, 0, "nothing left to set up");
  for (const id of [1, 2]) {
    assert.ok(existsSync(join(workspaceGitDir(id, { dataDir: fx.dataDir }), "HEAD")), `project ${id} has its history`);
  }
});

test("a permanent project delete removes its file history", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-delete-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const lifecycle = await import("../servers/shared/project-lifecycle.js");
  const created = await createProjectSpace(fx.db, { name: "History Delete" });
  const gitDir = workspaceGitDir(created.id, { dataDir: fx.dataDir });
  mkdirSync(created.workspaceDir, { recursive: true });
  const project = projectFor(created.id, created.workspaceDir);
  await save(project, "notes.txt", "some work\n", OWNER, { dataDir: fx.dataDir });
  assert.ok(existsSync(join(gitDir, "HEAD")), "the history exists before the delete");

  const result = await lifecycle.deleteProject(fx.db, created.id, {
    confirmName: "History Delete",
    storageDelete: async () => {},
    disconnectBackend: () => true,
    dataDir: fx.dataDir,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(existsSync(gitDir), false, "the project's file history is removed at once");
  assert.equal(result.partial, undefined, "removing it is not a partial step when it works");
});

test("the History API lists and restores a workspace file, and leaves the table types alone", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-api-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const { listVersions, restoreWorkspaceFileVersion } = await import("../servers/shared/history/api.js");
  const created = await createProjectSpace(fx.db, { name: "API Workspace" });
  mkdirSync(created.workspaceDir, { recursive: true });
  const project = projectFor(created.id, created.workspaceDir);

  await save(project, "notes.txt", "first version\n", BOT, { dataDir: fx.dataDir });
  await save(project, "notes.txt", "second!\n", OWNER, { dataDir: fx.dataDir });

  const itemId = `${created.id}:notes.txt`;
  const list = await listVersions(fx.db, { itemType: "workspace_file", itemId, dataDir: fx.dataDir });
  assert.equal(list.length, 2);
  const newest = list[0];
  assert.equal(typeof newest.id, "string", "a file version id is a version string, not an integer");
  assert.match(newest.id, /^[0-9a-f]{40}$/);
  assert.equal(newest.itemType, "workspace_file");
  assert.equal(newest.itemId, itemId);
  assert.equal(newest.op, "update");
  assert.equal(newest.authorKind, "owner");
  assert.equal(newest.authorId, "abcd1234");
  assert.equal(newest.jobId, "session:abcd1234");
  assert.equal(newest.originInstance, null);
  assert.equal(newest.redacted, false);
  assert.equal(typeof newest.createdAt, "string");
  assert.deepEqual(newest.snapshot, { size: "second!\n".length, path: "notes.txt" });
  assert.equal(list[1].op, "insert");

  // Paging by the oldest version id the caller already has.
  const page = await listVersions(fx.db, { itemType: "workspace_file", itemId, before: newest.id, dataDir: fx.dataDir });
  assert.deepEqual(page.map((v) => v.op), ["insert"]);
  await assert.rejects(
    () => listVersions(fx.db, { itemType: "workspace_file", itemId, before: "not-a-version" }),
    (err) => err.code === "invalid_request",
  );

  // A restore must name who is restoring it.
  await assert.rejects(
    () => restoreWorkspaceFileVersion(fx.db, { projectId: created.id, path: "notes.txt", versionId: list[1].id }),
    (err) => err.code === "invalid_context",
  );
  const restored = await restoreWorkspaceFileVersion(
    fx.db,
    { projectId: created.id, path: "notes.txt", versionId: list[1].id },
    OWNER,
    { dataDir: fx.dataDir },
  );
  assert.equal(restored.unchanged, false);
  assert.equal(readFileSync(join(created.workspaceDir, "notes.txt"), "utf8"), "first version\n");
  const after = await listVersions(fx.db, { itemType: "workspace_file", itemId, dataDir: fx.dataDir });
  assert.equal(after.length, 3, "all three versions are still listed");

  // The database item types are untouched: a table type still answers, and a
  // type that is not covered is still refused.
  assert.deepEqual(await listVersions(fx.db, { itemType: "memory", itemId: 1 }), []);
  await assert.rejects(
    () => listVersions(fx.db, { itemType: "memories", itemId: 1 }),
    (err) => err.code === "unsupported",
  );
  await assert.rejects(
    () => restoreWorkspaceFileVersion(fx.db, { projectId: 999999, path: "x", versionId: "0".repeat(40) }, OWNER),
    (err) => err.code === "not_found",
  );
});