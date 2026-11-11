/**
 * Version history, Task 6: a project's workspace FILES.
 *
 * Every test drives the real `git` binary against real temp directories: a
 * workspace folder, and a data dir holding the project's own git dir under
 * history/workspaces/<id>-<uuid>.git. Nothing here needs a gateway. Tests that
 * need a project row build a real crow.db with scripts/init-db.js (plus the
 * project_spaces.repo_path column the board migration adds), the same way
 * tests/history-api.test.js and tests/project-spaces-helper.test.js do.
 *
 * When git is not installed every test skips with a plain message instead of
 * failing: file history is optional at runtime, so it must not be a hard test
 * dependency either.
 *
 * The tests that run no git at all (the deny list, the settings scope and the
 * job runner's commit hook) live in tests/history-workspace-hardening.test.js.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { utimesSync } from "node:fs";
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

/** A project's portable id for a synthetic row: 16 hex digits, one per id. */
const uuidFor = (id) => Number(id).toString(16).padStart(16, "0");

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

/** Move the Crow history's HEAD from outside the module: the racing writer. */
function externalCommit(gitDir, workTree, message) {
  const tree = gitText(gitDir, workTree, ["rev-parse", "HEAD^{tree}"]).trim();
  const parent = gitText(gitDir, workTree, ["rev-parse", "HEAD"]).trim();
  const made = execFileSync(
    "git",
    [
      "-c", "user.name=Outside", "-c", "user.email=outside@example.invalid",
      "--git-dir=" + gitDir, "--work-tree=" + workTree,
      "commit-tree", tree, "-p", parent, "-F", "-",
    ],
    { input: message, stdio: ["pipe", "pipe", "pipe"] },
  ).toString("utf8").trim();
  gitText(gitDir, workTree, ["update-ref", "HEAD", made, parent]);
  return made;
}

/** A synthetic project row: the git side never reads anything else. */
const projectFor = (id, workspaceDir, uuid = uuidFor(id)) => ({ id, uuid, workspace_dir: workspaceDir });

/** The project object for a project a test just created through the DB. */
async function projectOf(fx, created) {
  const row = (await fx.db.execute({
    sql: "SELECT uuid FROM project_spaces WHERE id = ?",
    args: [created.id],
  })).rows[0];
  return projectFor(created.id, created.workspaceDir, row.uuid);
}

/** The git dir a project's history lives in. */
const gitDirFor = (project, dataDir) => workspaceGitDir({ id: project.id, uuid: project.uuid }, { dataDir });

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
  const project = await projectOf(fx, created);

  const gitDir = gitDirFor(project, fx.dataDir);
  assert.equal(
    gitDir,
    join(fx.dataDir, "history", "workspaces", `${created.id}-${project.uuid}.git`),
    "the git dir is derived from the project id AND its portable id",
  );
  assert.ok(existsSync(join(gitDir, "HEAD")), "the file history exists");
  assert.equal(existsSync(join(gitDir, "hooks")), false, "an empty template means no sample hooks at all");

  const row = (await fx.db.execute({ sql: "SELECT repo_path FROM project_spaces WHERE id = ?", args: [created.id] })).rows[0];
  assert.equal(row.repo_path, gitDir, "repo_path records where the file history lives");

  mkdirSync(created.workspaceDir, { recursive: true });
  assert.equal(existsSync(join(created.workspaceDir, ".git")), false, "no .git inside the workspace");

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
  const project = projectFor(
    1,
    ws,
    (await fx.db.execute({ sql: "SELECT uuid FROM project_spaces WHERE id = 1", args: [] })).rows[0].uuid,
  );
  writeFileSync(join(ws, "a.txt"), "before\n");

  const first = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30 });
  assert.deepEqual(first, { ensured: 1, committed: 1, erased: 0, eraseTimedOut: 0, failed: 0 });
  const row = (await fx.db.execute({ sql: "SELECT repo_path FROM project_spaces WHERE id = 1" })).rows[0];
  assert.equal(row.repo_path, gitDirFor(project, fx.dataDir));

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

  const gitDir = gitDirFor(project, fx.dataDir);
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
  assert.ok(existsSync(join(gitDirFor(project, fx.dataDir), "HEAD")));
});

test("an empty nested repository, a .git FILE and a bot-written .gitignore hide nothing", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-nested-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(13, ws);

  // H1: `git init` (or cargo new / npm create) in a subfolder leaves a .git with
  // no commit. It must not stop the project's history.
  mkdirSync(join(ws, "crate", ".git"), { recursive: true });
  writeFileSync(join(ws, "crate", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(ws, "crate", "main.rs"), "fn main() {}\n");
  writeFileSync(join(ws, "top.txt"), "top\n");

  // H2: a `.git` FILE pointing at another repository, with real files beside it.
  mkdirSync(join(ws, "imported"));
  writeFileSync(join(ws, "imported", ".git"), "gitdir: /somewhere/else/.git\n");
  writeFileSync(join(ws, "imported", "inner.txt"), "beside the git file\n");

  // H2: a .gitignore a bot wrote cannot hide the bot's own edits.
  writeFileSync(join(ws, ".gitignore"), "*.log\nhidden.txt\n");
  writeFileSync(join(ws, "hidden.txt"), "recorded all the same\n");
  writeFileSync(join(ws, "build.log"), "recorded too\n");

  const first = await commitWorkspace(project, BOT, "First save", { dataDir: fx.dataDir });
  assert.match(first, /^[0-9a-f]{40}$/, "the nested repository does not break the commit");
  const gitDir = gitDirFor(project, fx.dataDir);
  const tree = gitText(gitDir, ws, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(tree, [
    ".gitignore",
    "build.log",
    "crate/main.rs",
    "hidden.txt",
    "imported/inner.txt",
    "top.txt",
  ]);

  // And a later edit inside the nested folder is still a new version.
  writeFileSync(join(ws, "crate", "main.rs"), "fn main() { println!(\"hi\"); }\n");
  const second = await commitWorkspace(project, BOT, "Second save", { dataDir: fx.dataDir });
  assert.match(second, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    (await listWorkspaceVersions(project, "crate/main.rs", { dataDir: fx.dataDir })).map((v) => v.op),
    ["update", "insert"],
  );
});

test("secrets, bot session files and build caches are never recorded", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-deny-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(14, ws);

  writeFileSync(join(ws, ".env"), "SECRET=1\n");
  writeFileSync(join(ws, ".env.local"), "SECRET=2\n");
  writeFileSync(join(ws, ".mcp.json"), "{}\n");
  writeFileSync(join(ws, "x.pem"), "key-ish\n");
  writeFileSync(join(ws, "id_rsa"), "key-ish\n");
  mkdirSync(join(ws, ".pi", "sessions"), { recursive: true });
  writeFileSync(join(ws, ".pi", "sessions", "s.json"), "{}\n");
  mkdirSync(join(ws, "sessions"), { recursive: true });
  writeFileSync(join(ws, "sessions", "s.jsonl"), "{}\n");
  mkdirSync(join(ws, "nested", "sessions"), { recursive: true });
  writeFileSync(join(ws, "nested", "sessions", "kept.txt"), "ordinary content\n");
  mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(ws, "node_modules", "pkg", "index.js"), "dep\n");
  writeFileSync(join(ws, "keep.txt"), "kept\n");

  const sha = await commitWorkspace(project, OWNER, "Record everything", { dataDir: fx.dataDir });
  assert.match(sha, /^[0-9a-f]{40}$/);
  const gitDir = gitDirFor(project, fx.dataDir);
  const tree = gitText(gitDir, ws, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(tree, ["keep.txt", "nested/sessions/kept.txt"], "only ordinary content is recorded");
});

test("a file name with a quote, a backslash and a control character is recorded verbatim", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-oddname-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(27, ws);

  // git reads `--stdin-paths` line by line and unquotes a line that starts with a
  // quote, so these names are fed C-quoted; a wrong quoting would lose the file.
  const names = [
    'quote"name.txt',
    "back\\slash.txt",
    `tab\there.txt`,
    `newline\nthere.txt`,
    "plain.txt",
  ];
  for (const name of names) writeFileSync(join(ws, name), `${name} bytes\n`);

  const sha = await commitWorkspace(project, OWNER, "Odd names", { dataDir: fx.dataDir });
  assert.match(sha, /^[0-9a-f]{40}$/);
  const gitDir = gitDirFor(project, fx.dataDir);
  const tree = gitText(gitDir, ws, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.deepEqual(tree, [...names].sort(), "every odd name is in the tree");
  for (const name of names) {
    assert.equal(
      gitText(gitDir, ws, ["cat-file", "blob", `${sha}:${name}`]),
      `${name} bytes\n`,
      `the bytes of ${JSON.stringify(name)} are exact`,
    );
  }

  // And a symlink is recorded as a symlink, with its target as the blob.
  symlinkSync("plain.txt", join(ws, "alias.txt"));
  const withLink = await commitWorkspace(project, OWNER, "Add a link", { dataDir: fx.dataDir });
  const entry = gitText(gitDir, ws, ["ls-tree", withLink, "--", "alias.txt"]).trim();
  assert.match(entry, /^120000 blob [0-9a-f]{40}\talias\.txt$/, "the link keeps its mode");
  assert.equal(gitText(gitDir, ws, ["cat-file", "blob", `${withLink}:alias.txt`]), "plain.txt");
});

test("a file over the size cap is skipped and counted for the caller", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-big-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(15, ws);

  writeFileSync(join(ws, "big.bin"), Buffer.alloc(26 * 1024 * 1024, 7));
  writeFileSync(join(ws, "small.txt"), "small\n");

  let seen = null;
  const sha = await commitWorkspace(project, OWNER, "A big file landed", {
    dataDir: fx.dataDir,
    onResult: (result) => { seen = result; },
  });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(seen.sha, sha);
  assert.equal(seen.skippedLarge, 1, "the oversized file is counted, not recorded");
  assert.equal(seen.skippedOther, 0);
  const gitDir = gitDirFor(project, fx.dataDir);
  assert.deepEqual(
    gitText(gitDir, ws, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean),
    ["small.txt"],
  );
});

test("a Trash file past the period is erased from history and from nowhere else", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-erase-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(7, ws);

  writeFileSync(join(ws, "keep.txt"), "keep me\n");
  writeFileSync(join(ws, "drop.txt"), "erase me entirely\n");
  const withBoth = await commitWorkspace(project, OWNER, "Add both", { dataDir: fx.dataDir });
  const gitDir = gitDirFor(project, fx.dataDir);
  const oldBlob = gitText(gitDir, ws, ["rev-parse", `${withBoth}:drop.txt`]).trim();

  unlinkSync(join(ws, "drop.txt"));
  await commitWorkspace(project, OWNER, "Delete drop", { dataDir: fx.dataDir });
  assert.equal(existsSync(join(ws, "drop.txt")), false);

  const trashed = await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir });
  assert.deepEqual(trashed.map((entry) => entry.path), ["drop.txt"]);
  assert.equal(trashed[0].authorKind, "owner");
  assert.equal(trashed[0].massDelete, false);

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

test("the deny list keeps caches, dependencies and databases out of the history", { skip: NO_GIT }, async () => {
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
  const gitDir = gitDirFor(project, fx.dataDir);
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
  const gitDir = gitDirFor(project, fx.dataDir);
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

test("a parent folder swapped for a link between the flush commit and the write refuses the restore", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-swap-");
  const ws = join(fx.root, "ws");
  mkdirSync(join(ws, "sub"), { recursive: true });
  const project = projectFor(16, ws);
  const first = await save(project, "sub/notes.txt", "first version\n", OWNER, { dataDir: fx.dataDir });
  await save(project, "sub/notes.txt", "second version\n", OWNER, { dataDir: fx.dataDir });

  const outside = join(fx.root, "outside");
  mkdirSync(outside);
  const swap = () => {
    renameSync(join(ws, "sub"), join(ws, "sub-moved"));
    symlinkSync(outside, join(ws, "sub"), "dir");
  };

  await assert.rejects(
    () => restoreWorkspaceFile(project, "sub/notes.txt", first, OWNER, {
      dataDir: fx.dataDir,
      _beforeWrite: async () => { swap(); },
    }),
    (err) => err.code === "outside_workspace",
  );
  assert.equal(existsSync(join(outside, "notes.txt")), false, "nothing was written outside the workspace");
  assert.deepEqual(readdirSync(outside), [], "no temporary file was left outside either");

  // Put the real folder back, then swap it at the LAST moment instead.
  rmSync(join(ws, "sub"), { force: true });
  renameSync(join(ws, "sub-moved"), join(ws, "sub"));
  await assert.rejects(
    () => restoreWorkspaceFile(project, "sub/notes.txt", first, OWNER, {
      dataDir: fx.dataDir,
      _beforeRename: async () => { swap(); },
    }),
    (err) => err.code === "outside_workspace",
  );
  assert.equal(existsSync(join(outside, "notes.txt")), false, "the rename never wrote outside the workspace");
  assert.equal(readFileSync(join(ws, "sub-moved", "notes.txt"), "utf8"), "second version\n", "the file is untouched");
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
  const dirOne = gitDirFor(projectFor(21, one), fx.dataDir);
  const dirTwo = gitDirFor(projectFor(22, two), fx.dataDir);
  assert.ok(existsSync(dirOne) && existsSync(dirTwo));

  assert.equal(await removeWorkspaceHistory(21, { dataDir: fx.dataDir }), true);
  assert.equal(existsSync(dirOne), false, "the named project's history is gone");
  assert.ok(existsSync(dirTwo), "the other project's history is untouched");
  assert.equal(await removeWorkspaceHistory(999, { dataDir: fx.dataDir }), true, "an absent one is not a failure");
});

test("a git dir under another name for the same id is a leftover, never reused", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-stale-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const stale = join(fx.dataDir, "history", "workspaces", "77-cafebabecafebabe.git");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "stale.txt"), "a deleted project's leftover\n");

  const project = projectFor(77, ws, uuidFor(99));
  const ensured = await ensureWorkspaceHistory(null, project, { dataDir: fx.dataDir });
  assert.ok(ensured.repoDir, "the history is set up");
  assert.equal(ensured.repoDir, gitDirFor(project, fx.dataDir));
  assert.equal(existsSync(stale), false, "the leftover is removed");

  await save(project, "new.txt", "a new project's work\n", OWNER, { dataDir: fx.dataDir });
  const tree = gitText(ensured.repoDir, ws, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  assert.deepEqual(tree, ["new.txt"], "nothing of the leftover was carried over");
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
    const row = (await fx.db.execute({ sql: "SELECT uuid FROM project_spaces WHERE id = ?", args: [id] })).rows[0];
    const project = projectFor(id, join(fx.dataDir, "projects", `batch-${id}`, "workspace"), row.uuid);
    assert.ok(existsSync(join(gitDirFor(project, fx.dataDir), "HEAD")), `project ${id} has its history`);
  }
});

test("a permanent project delete removes its file history", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-delete-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const lifecycle = await import("../servers/shared/project-lifecycle.js");
  const created = await createProjectSpace(fx.db, { name: "History Delete" });
  const project = await projectOf(fx, created);
  const gitDir = gitDirFor(project, fx.dataDir);
  mkdirSync(created.workspaceDir, { recursive: true });
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
  const project = await projectOf(fx, created);
  mkdirSync(created.workspaceDir, { recursive: true });

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

test("an archived project has no workspace file history to list or restore", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-archived-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const { listVersions, restoreWorkspaceFileVersion } = await import("../servers/shared/history/api.js");
  const created = await createProjectSpace(fx.db, { name: "Archived Workspace" });
  const project = await projectOf(fx, created);
  mkdirSync(created.workspaceDir, { recursive: true });
  const first = await save(project, "notes.txt", "first version\n", OWNER, { dataDir: fx.dataDir });

  await fx.db.execute({
    sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?",
    args: [created.id],
  });

  const itemId = `${created.id}:notes.txt`;
  assert.deepEqual(await listVersions(fx.db, { itemType: "workspace_file", itemId, dataDir: fx.dataDir }), []);
  await assert.rejects(
    () => restoreWorkspaceFileVersion(fx.db, { projectId: created.id, path: "notes.txt", versionId: first }, OWNER, { dataDir: fx.dataDir }),
    (err) => err.code === "not_found",
  );
});

test("`before` paging keeps its page size and refuses an unusable cursor", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-paging-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(17, ws);
  const ids = [];
  for (let i = 1; i <= 6; i++) {
    ids.push(await save(project, "notes.txt", `version ${i}\n`, OWNER, { dataDir: fx.dataDir }));
  }

  const newestPage = await listWorkspaceVersions(project, "notes.txt", { dataDir: fx.dataDir, limit: 2 });
  assert.deepEqual(newestPage.map((v) => v.id), [ids[5], ids[4]]);

  const nextPage = await listWorkspaceVersions(project, "notes.txt", {
    dataDir: fx.dataDir,
    limit: 2,
    before: ids[4],
  });
  assert.equal(nextPage.length, 2, "the page size is kept, not the whole log");
  assert.deepEqual(nextPage.map((v) => v.id), [ids[3], ids[2]]);

  assert.deepEqual(
    await listWorkspaceVersions(project, "notes.txt", { dataDir: fx.dataDir, before: "not-a-version" }),
    [],
    "a cursor that is not a version id is an empty page",
  );
  assert.deepEqual(
    await listWorkspaceVersions(project, "notes.txt", { dataDir: fx.dataDir, before: "f".repeat(40) }),
    [],
    "a cursor that is not in this history is an empty page",
  );
});

test("erasing many expired files is ONE rewrite", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-one-rewrite-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(18, ws);

  writeFileSync(join(ws, "keep.txt"), "keep\n");
  const drops = ["one.txt", "two.txt", "three.txt", "four.txt"];
  for (const name of drops) writeFileSync(join(ws, name), `${name}\n`);
  await commitWorkspace(project, OWNER, "Add everything", { dataDir: fx.dataDir });
  for (const name of drops) unlinkSync(join(ws, name));
  await commitWorkspace(project, OWNER, "Delete them all", { dataDir: fx.dataDir });

  let commitTrees = 0;
  let readTrees = 0;
  const shaBefore = gitText(gitDirFor(project, fx.dataDir), ws, ["rev-parse", "HEAD"]).trim();
  const commitsBefore = Number(gitText(gitDirFor(project, fx.dataDir), ws, ["rev-list", "--count", "HEAD"]).trim());
  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  const erased = await eraseExpiredWorkspaceFiles(project, 30, {
    dataDir: fx.dataDir,
    now: inAMonth,
    onSpawn: (argv) => {
      if (argv.includes("commit-tree")) commitTrees += 1;
      if (argv.includes("read-tree")) readTrees += 1;
    },
  });
  assert.deepEqual([...erased].sort(), [...drops].sort(), "every expired file is gone");
  assert.ok(commitTrees <= commitsBefore, `one replay: ${commitTrees} re-created commits for ${commitsBefore} original commits`);
  assert.ok(readTrees <= commitsBefore, `one replay: ${readTrees} replayed trees for ${commitsBefore} original commits`);
  assert.equal(readFileSync(join(ws, "keep.txt"), "utf8"), "keep\n");
  assert.notEqual(gitText(gitDirFor(project, fx.dataDir), ws, ["rev-parse", "HEAD"]).trim(), shaBefore);
});

test("an erase past its time cap stops with HEAD untouched", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-cap-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(19, ws);
  writeFileSync(join(ws, "keep.txt"), "keep\n");
  writeFileSync(join(ws, "drop.txt"), "drop\n");
  await commitWorkspace(project, OWNER, "Add both", { dataDir: fx.dataDir });
  unlinkSync(join(ws, "drop.txt"));
  await commitWorkspace(project, OWNER, "Delete drop", { dataDir: fx.dataDir });

  const gitDir = gitDirFor(project, fx.dataDir);
  const headBefore = gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim();
  let ticks = 0;
  const result = await eraseWorkspaceFile(project, "drop.txt", {
    dataDir: fx.dataDir,
    eraseCapMs: 10,
    clock: () => {
      ticks += 100;
      return ticks;
    },
  });
  assert.deepEqual(result, { erased: false, reason: "timeout" });
  assert.equal(gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim(), headBefore, "HEAD did not move");
  assert.equal(existsSync(join(gitDir, "crow-pending-gc")), false, "no prune marker was left behind");
});

test("a commit that lands during an erase is never overwritten", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-race-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(20, ws);
  writeFileSync(join(ws, "keep.txt"), "keep\n");
  writeFileSync(join(ws, "drop.txt"), "drop\n");
  await commitWorkspace(project, OWNER, "Add both", { dataDir: fx.dataDir });
  unlinkSync(join(ws, "drop.txt"));
  await commitWorkspace(project, OWNER, "Delete drop", { dataDir: fx.dataDir });

  const gitDir = gitDirFor(project, fx.dataDir);
  let racedInto = null;
  const result = await eraseWorkspaceFile(project, "drop.txt", {
    dataDir: fx.dataDir,
    onSpawn: (argv) => {
      // The compare-and-swap is about to run: another writer moves HEAD first.
      if (racedInto === null && argv.includes("update-ref")) {
        racedInto = externalCommit(gitDir, ws, "a commit made during the erase");
      }
    },
  });
  assert.notEqual(racedInto, null, "the racing commit happened");
  assert.equal(result.erased, false);
  assert.equal(result.reason, "changed", "the erase aborts rather than overwriting the other commit");
  assert.equal(gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim(), racedInto, "the racing commit survived");
});

test("rename-then-delete-then-erase removes the original blob too", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-rename-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(23, ws);

  writeFileSync(join(ws, "a.txt"), "the original bytes\n");
  const first = await commitWorkspace(project, OWNER, "Add a", { dataDir: fx.dataDir });
  const gitDir = gitDirFor(project, fx.dataDir);
  const oldBlob = gitText(gitDir, ws, ["rev-parse", `${first}:a.txt`]).trim();

  renameSync(join(ws, "a.txt"), join(ws, "b.txt"));
  await commitWorkspace(project, OWNER, "Rename a to b", { dataDir: fx.dataDir });
  unlinkSync(join(ws, "b.txt"));
  await commitWorkspace(project, OWNER, "Delete b", { dataDir: fx.dataDir });

  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  const erased = await eraseExpiredWorkspaceFiles(project, 30, { dataDir: fx.dataDir, now: inAMonth });
  assert.deepEqual([...erased].sort(), ["a.txt", "b.txt"], "both names are erased");
  assert.equal(gitText(gitDir, ws, ["log", "--all", "--format=%H", "--", "a.txt"]).trim(), "");
  assert.equal(gitText(gitDir, ws, ["log", "--all", "--format=%H", "--", "b.txt"]).trim(), "");
  let objectGone = false;
  try {
    gitIn(gitDir, ws, ["cat-file", "-e", oldBlob]);
  } catch {
    objectGone = true;
  }
  assert.equal(objectGone, true, "the original blob is gone, not just the new name");
});

test("an earlier name that is live again is not erased", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-name-in-use-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(24, ws);

  writeFileSync(join(ws, "a.txt"), "the original bytes\n");
  await commitWorkspace(project, OWNER, "Add a", { dataDir: fx.dataDir });
  renameSync(join(ws, "a.txt"), join(ws, "b.txt"));
  await commitWorkspace(project, OWNER, "Rename a to b", { dataDir: fx.dataDir });
  // A NEW file takes the old name and is recorded: it is not the erased one.
  writeFileSync(join(ws, "a.txt"), "a different file entirely\n");
  await commitWorkspace(project, OWNER, "Add a new a", { dataDir: fx.dataDir });
  unlinkSync(join(ws, "b.txt"));
  await commitWorkspace(project, OWNER, "Delete b", { dataDir: fx.dataDir });

  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  const erased = await eraseExpiredWorkspaceFiles(project, 30, { dataDir: fx.dataDir, now: inAMonth });
  assert.deepEqual(erased, ["b.txt"], "only the deleted name is erased");
  const gitDir = gitDirFor(project, fx.dataDir);
  assert.match(
    gitText(gitDir, ws, ["log", "--format=%H", "--", "a.txt"]).trim(),
    /^[0-9a-f]{40}/,
    "the live file's history is kept",
  );
});

test("a pending-gc marker left by an interrupted erase is cleared by the next sweep", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-marker-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const created = await createProjectSpace(fx.db, { name: "Interrupted Erase" });
  const project = await projectOf(fx, created);
  mkdirSync(created.workspaceDir, { recursive: true });

  writeFileSync(join(created.workspaceDir, "keep.txt"), "keep\n");
  writeFileSync(join(created.workspaceDir, "drop.txt"), "drop\n");
  const withBoth = await commitWorkspace(project, OWNER, "Add both", { dataDir: fx.dataDir });
  const gitDir = gitDirFor(project, fx.dataDir);
  const oldBlob = gitText(gitDir, created.workspaceDir, ["rev-parse", `${withBoth}:drop.txt`]).trim();
  unlinkSync(join(created.workspaceDir, "drop.txt"));
  await commitWorkspace(project, OWNER, "Delete drop", { dataDir: fx.dataDir });

  const result = await eraseWorkspaceFile(project, "drop.txt", {
    dataDir: fx.dataDir,
    _afterRefMove: async () => { throw new Error("the process died here"); },
  });
  assert.deepEqual(result, { erased: false, reason: "interrupted" });
  assert.ok(existsSync(join(gitDir, "crow-pending-gc")), "the marker is left behind, exactly like a crash");

  const swept = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir });
  assert.equal(swept.failed, 0);
  assert.equal(existsSync(join(gitDir, "crow-pending-gc")), false, "the next write finishes the prune");
  let objectGone = false;
  try {
    gitIn(gitDir, created.workspaceDir, ["cat-file", "-e", oldBlob]);
  } catch {
    objectGone = true;
  }
  assert.equal(objectGone, true, "the erased bytes are pruned by the recovery");
});

test("the scheduled erase is off by default, and the mass-delete guard holds", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-autoerase-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const created = await createProjectSpace(fx.db, { name: "Auto Erase" });
  const project = await projectOf(fx, created);
  const ws = created.workspaceDir;
  mkdirSync(ws, { recursive: true });

  writeFileSync(join(ws, "keep.txt"), "keep\n");
  writeFileSync(join(ws, "drop.txt"), "drop\n");
  await commitWorkspace(project, OWNER, "Add both", { dataDir: fx.dataDir });
  unlinkSync(join(ws, "drop.txt"));
  await commitWorkspace(project, OWNER, "Delete drop", { dataDir: fx.dataDir });

  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  const off = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30, now: inAMonth });
  assert.equal(off.erased, 0, "the scheduled erase is off unless it is switched on");
  assert.deepEqual(
    (await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir })).map((file) => file.path),
    ["drop.txt"],
    "the file is still restorable",
  );

  const on = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30, autoErase: true, now: inAMonth });
  assert.equal(on.erased, 1, "switched on, it erases past the Trash period");
  assert.deepEqual(await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir }), []);
});

/** A project with one file in its Trash, ready for a scheduled erase a month on. */
async function trashedFixture(prefix, name) {
  const fx = await dbFixture(prefix);
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const created = await createProjectSpace(fx.db, { name });
  const project = await projectOf(fx, created);
  const ws = created.workspaceDir;
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "keep.txt"), "keep\n");
  writeFileSync(join(ws, "drop.txt"), "drop\n");
  await commitWorkspace(project, OWNER, "Add both", { dataDir: fx.dataDir });
  unlinkSync(join(ws, "drop.txt"));
  await commitWorkspace(project, OWNER, "Delete drop", { dataDir: fx.dataDir });
  return { fx, project };
}

test("a slow commit before the scheduled erase does not eat the erase's time cap", { skip: NO_GIT }, async () => {
  const { fx, project } = await trashedFixture("hist-ws-sweepcap-", "Sweep Cap");
  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  let now = 5_000_000;
  let heads = 0;
  const swept = await sweepWorkspaces(fx.db, {
    dataDir: fx.dataDir,
    trashDays: 30,
    autoErase: true,
    now: inAMonth,
    clock: () => now,
    onSpawn: (argv) => {
      // The sweep's own commit step looks up HEAD first: make it take an hour.
      if (argv.includes("rev-parse") && argv.includes("--verify")) {
        heads += 1;
        if (heads === 1) now += 60 * 60 * 1000;
      }
    },
  });
  assert.equal(swept.eraseTimedOut, 0, "the erase was not starved by the commit");
  assert.equal(swept.erased, 1, "and it happened");
  assert.deepEqual(await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir }), []);
});

test("a scheduled erase that times out is warned about and counted, not silent", { skip: NO_GIT }, async () => {
  const { fx, project } = await trashedFixture("hist-ws-sweeptimeout-", "Sweep Timeout");
  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  let now = 5_000_000;
  let heads = 0;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let swept;
  try {
    swept = await sweepWorkspaces(fx.db, {
      dataDir: fx.dataDir,
      trashDays: 30,
      autoErase: true,
      now: inAMonth,
      clock: () => now,
      onSpawn: (argv) => {
        // The second HEAD lookup is the erase's own: the rewrite then runs an hour late.
        if (argv.includes("rev-parse") && argv.includes("--verify")) {
          heads += 1;
          if (heads === 2) now += 60 * 60 * 1000;
        }
      },
    });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(swept.eraseTimedOut, 1, "the timeout is counted");
  assert.equal(swept.erased, 0);
  assert.equal(swept.failed, 0, "it is not mistaken for a failed project");
  assert.ok(warnings.some((line) => /timed out/.test(line)), `a warning was logged: ${warnings.join(" | ")}`);
  assert.deepEqual(
    (await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir })).map((file) => file.path),
    ["drop.txt"],
    "nothing was erased, so the file is still restorable",
  );
});

test("a commit that deletes most of the workspace is never erased automatically", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-massdelete-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const created = await createProjectSpace(fx.db, { name: "Mass Delete" });
  const project = await projectOf(fx, created);
  const ws = created.workspaceDir;
  mkdirSync(ws, { recursive: true });

  const names = Array.from({ length: 22 }, (_, i) => `file-${i + 1}.txt`);
  for (const name of names) writeFileSync(join(ws, name), `${name}\n`);
  await commitWorkspace(project, OWNER, "Add twenty-two files", { dataDir: fx.dataDir });
  for (const name of names) unlinkSync(join(ws, name));
  await commitWorkspace(project, OWNER, "Everything is gone", { dataDir: fx.dataDir });

  const gitDir = gitDirFor(project, fx.dataDir);
  assert.match(gitText(gitDir, ws, ["log", "-1", "--format=%B"]), /Crow-Mass-Delete: yes/, "the trailer is recorded");
  const trashed = await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir });
  assert.equal(trashed.length, names.length);
  assert.equal(trashed.every((file) => file.massDelete === true), true, "every file carries the deleting commit's flag");

  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  const swept = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30, autoErase: true, now: inAMonth });
  assert.equal(swept.erased, 0, "the guard holds the whole set back");
  assert.equal((await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir })).length, names.length);
});

test("a project that is gone gets no git dir, and one purged mid-write loses it", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-gone-");
  const ws = join(fx.dataDir, "projects", "gone-1", "workspace");
  mkdirSync(ws, { recursive: true });
  const project = projectFor(31, ws, uuidFor(31));
  const gitDir = gitDirFor(project, fx.dataDir);
  const { makeDbLiveCheck } = await import("../servers/shared/history/workspace-history.js");

  // No row at all: nothing is created.
  const missing = makeDbLiveCheck(fx.db);
  assert.equal(await commitWorkspace(project, OWNER, "nothing", { dataDir: fx.dataDir, isLive: missing }), null);
  assert.equal(existsSync(gitDir), false);

  // The row disappears while the write waits for the lock: the just-made dir goes.
  let calls = 0;
  const goneAfterTheLock = async () => {
    calls += 1;
    return calls === 1 ? true : "gone";
  };
  assert.equal(await commitWorkspace(project, OWNER, "nothing", { dataDir: fx.dataDir, isLive: goneAfterTheLock }), null);
  assert.equal(calls, 2, "the check runs before and inside the lock");
  assert.equal(existsSync(gitDir), false, "no directory is left behind");
});

test("a sweep and a purge that run together leave no git dir", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-purge-race-");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const created = await createProjectSpace(fx.db, { name: "Purged" });
  const project = await projectOf(fx, created);
  mkdirSync(created.workspaceDir, { recursive: true });
  await save(project, "notes.txt", "some work\n", OWNER, { dataDir: fx.dataDir });
  const gitDir = gitDirFor(project, fx.dataDir);
  assert.ok(existsSync(join(gitDir, "HEAD")));

  await fx.db.execute({ sql: "DELETE FROM project_members WHERE project_id = ?", args: [created.id] });
  await fx.db.execute({ sql: "DELETE FROM project_spaces WHERE id = ?", args: [created.id] });
  await Promise.all([
    sweepWorkspaces(fx.db, { dataDir: fx.dataDir }),
    removeWorkspaceHistory(created.id, { dataDir: fx.dataDir }),
  ]);
  assert.equal(existsSync(gitDir), false, "nothing is left under history/workspaces");
});

test("a job-end commit and a workspace commit racing both land", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-children-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(25, ws);
  writeFileSync(join(ws, "one.txt"), "v0\n");
  await commitWorkspace(project, OWNER, "Start", { dataDir: fx.dataDir });

  // A barrier directory makes the overlap REAL, not lucky. Child one takes the lock
  // and, from inside it (the _afterWalk seam), writes `holding` and waits until
  // child two has written `attempting` and had time to queue on the lock. Child
  // two does not start its attempt until `holding` exists. So child two's commit
  // provably waited for child one's lock, and must land on top of it.
  const barrier = join(fx.root, "barrier");
  mkdirSync(barrier);
  const moduleUrl = new URL("../servers/shared/history/workspace-history.js", import.meta.url).href;
  const common = `
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { commitWorkspace } from ${JSON.stringify(moduleUrl)};
const project = ${JSON.stringify(project)};
const barrier = ${JSON.stringify(barrier)};
const until = async (name) => { for (let i = 0; i < 600 && !existsSync(join(barrier, name)); i++) await new Promise((r) => setTimeout(r, 25)); if (!existsSync(join(barrier, name))) throw new Error("barrier " + name + " never appeared"); };
`;
  const childOne = `${common}
writeFileSync(join(project.workspace_dir, "one.txt"), "from the first child\\n");
const sha = await commitWorkspace(project, { authorKind: "bot", authorId: "hank" }, "child one", {
  dataDir: ${JSON.stringify(fx.dataDir)},
  _afterWalk: async () => {
    writeFileSync(join(barrier, "holding"), "1");
    await until("attempting");
    await new Promise((r) => setTimeout(r, 400)); // child two is now queued on the lock
  },
});
process.stdout.write(String(sha));
`;
  const childTwo = `${common}
await until("holding");
writeFileSync(join(project.workspace_dir, "two.txt"), "from the second child\\n");
writeFileSync(join(barrier, "attempting"), "1");
const sha = await commitWorkspace(project, { authorKind: "bot", authorId: "ivy" }, "child two", { dataDir: ${JSON.stringify(fx.dataDir)} });
process.stdout.write(String(sha));
`;
  const runChild = (script) => new Promise((done, fail) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: REPO, env: { ...process.env, CROW_DB_PATH: "" } },
      (err, stdout, stderr) => {
        if (err) fail(new Error(`${err.message}\n${stderr}`));
        else done(stdout);
      },
    );
  });

  const [one, two] = await Promise.all([runChild(childOne), runChild(childTwo)]);
  assert.match(String(one), /^[0-9a-f]{40}$/, `first child: ${one}`);
  assert.match(String(two), /^[0-9a-f]{40}$/, `second child: ${two}`);
  assert.ok(existsSync(join(barrier, "holding")) && existsSync(join(barrier, "attempting")), "both sides reached the barrier");

  const gitDir = gitDirFor(project, fx.dataDir);
  assert.equal(
    gitText(gitDir, ws, ["rev-parse", `${String(two).trim()}^`]).trim(),
    String(one).trim(),
    "the second commit waited for the first lock and sits directly on top of it",
  );
  assert.equal(gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim(), String(two).trim());
  assert.equal(gitText(gitDir, ws, ["cat-file", "blob", "HEAD:one.txt"]), "from the first child\n");
  assert.equal(gitText(gitDir, ws, ["cat-file", "blob", "HEAD:two.txt"]), "from the second child\n");
});

test("a history is created as sha1 whatever git's default becomes", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-sha1-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(41, ws);
  writeFileSync(join(ws, "a.txt"), "a\n");
  // Ask git for sha256 by default: the history must still come out sha1.
  await commitWorkspace(project, OWNER, "Start", { dataDir: fx.dataDir, env: { GIT_DEFAULT_HASH: "sha256" } });
  const gitDir = gitDirFor(project, fx.dataDir);
  const config = readFileSync(join(gitDir, "config"), "utf8");
  assert.equal(/objectformat\s*=\s*sha256/i.test(config), false, "no sha256 object format");
  assert.match(gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim(), /^[0-9a-f]{40}$/, "a 40-hex sha1 id");
});

test("a damaged loose object already on disk is rewritten, not trusted", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-badobj-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(42, ws);
  writeFileSync(join(ws, "keep.txt"), "keep\n");
  await commitWorkspace(project, OWNER, "Start", { dataDir: fx.dataDir });
  const gitDir = gitDirFor(project, fx.dataDir);

  // The id the next file's blob will get, and an EMPTY file squatting at its path
  // (what a crash after the rename can leave).
  const text = "fresh content that was never recorded\n";
  const blobId = execFileSync("git", ["hash-object", "--stdin"], { input: text }).toString("utf8").trim();
  const objectPath = join(gitDir, "objects", blobId.slice(0, 2), blobId.slice(2));
  mkdirSync(join(gitDir, "objects", blobId.slice(0, 2)), { recursive: true });
  writeFileSync(objectPath, "");

  writeFileSync(join(ws, "fresh.txt"), text);
  const sha = await commitWorkspace(project, OWNER, "Add fresh", { dataDir: fx.dataDir });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(gitText(gitDir, ws, ["cat-file", "blob", blobId]), text, "the object was rewritten whole");
  assert.equal(gitText(gitDir, ws, ["cat-file", "blob", "HEAD:fresh.txt"]), text);
});

test("the erase cap counts from when the lock was taken, not from the rewrite", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-lockcap-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(43, ws);
  writeFileSync(join(ws, "keep.txt"), "keep\n");
  writeFileSync(join(ws, "drop.txt"), "drop\n");
  await commitWorkspace(project, OWNER, "Add both", { dataDir: fx.dataDir });
  unlinkSync(join(ws, "drop.txt"));
  await commitWorkspace(project, OWNER, "Delete drop", { dataDir: fx.dataDir });

  const gitDir = gitDirFor(project, fx.dataDir);
  const headBefore = gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim();
  // The clock jumps an hour on the first git call the erase makes AFTER the lock
  // is held (its HEAD lookup), long before the rewrite loop starts. A cap measured
  // from the loop's start would not notice; one measured from the lock does.
  let now = 1_000_000;
  let jumped = false;
  const result = await eraseWorkspaceFile(project, "drop.txt", {
    dataDir: fx.dataDir,
    clock: () => now,
    onSpawn: (argv) => {
      if (!jumped && argv.includes("rev-parse") && argv.includes("--verify")) {
        jumped = true;
        now += 60 * 60 * 1000;
      }
    },
  });
  assert.equal(jumped, true, "the erase's first call was seen");
  assert.deepEqual(result, { erased: false, reason: "timeout" });
  assert.equal(gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim(), headBefore, "HEAD did not move");
});

test("control characters in a bot's name cannot forge who made a change", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-control-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const project = projectFor(26, ws);

  const nasty = "hank\u0001\u001e\u001f\u007f\nCrow-Author-Kind: owner";
  writeFileSync(join(ws, "report.md"), "draft\n");
  const sha = await commitWorkspace(project, { authorKind: "bot", authorId: nasty }, "wrote\u001ea report\u001f", {
    dataDir: fx.dataDir,
  });
  assert.match(sha, /^[0-9a-f]{40}$/);

  const versions = await listWorkspaceVersions(project, "report.md", { dataDir: fx.dataDir });
  assert.equal(versions.length, 1, "the control characters did not forge an extra version");
  assert.equal(versions[0].authorKind, "bot", "the real author kind survives");
  assert.equal(versions[0].authorId.includes("\u001e"), false, "the id is one line with no control characters");

  const message = gitText(gitDirFor(project, fx.dataDir), ws, ["log", "-1", "--format=%B"]);
  const subject = message.split("\n")[0];
  assert.equal(/[\u0000-\u001f\u007f]/.test(subject), false, "the subject is one clean line");
  assert.equal((message.match(/^Crow-Author-Kind: /gm) || []).length, 1, "exactly one author-kind trailer");
});
test("only a confirmed purge removes a history folder: archive and a database error keep it", { skip: NO_GIT }, async () => {
  const fx = await dbFixture("hist-ws-keep-");
  const ws = join(fx.dataDir, "projects", "keep-1", "workspace");
  mkdirSync(ws, { recursive: true });
  await fx.db.execute({
    sql: "INSERT INTO project_spaces (id, slug, name, workspace_dir) VALUES (41, 'keep-1', 'Keep', ?)",
    args: [ws],
  });
  const uuid = (await fx.db.execute({ sql: "SELECT uuid FROM project_spaces WHERE id = 41", args: [] })).rows[0].uuid;
  const project = projectFor(41, ws, uuid);
  const gitDir = gitDirFor(project, fx.dataDir);
  const { makeDbLiveCheck } = await import("../servers/shared/history/workspace-history.js");
  const isLive = makeDbLiveCheck(fx.db);
  writeFileSync(join(ws, "a.txt"), "one\n");
  assert.ok(await commitWorkspace(project, OWNER, "first", { dataDir: fx.dataDir, isLive }));
  const tip = gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim();

  // Archived: not live, nothing recorded, nothing removed.
  await fx.db.execute({ sql: "UPDATE project_spaces SET archived_at = '2026-11-11T00:00:00Z' WHERE id = 41", args: [] });
  assert.equal(await isLive(project), false);
  writeFileSync(join(ws, "b.txt"), "two\n");
  assert.equal(await commitWorkspace(project, OWNER, "while archived", { dataDir: fx.dataDir, isLive }), null);
  assert.equal(existsSync(gitDir), true, "archive never erases");
  assert.equal(gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim(), tip);

  // A database error: no write, no removal.
  const broken = makeDbLiveCheck({ execute: async () => { throw new Error("database is locked"); } });
  assert.equal(await commitWorkspace(project, OWNER, "db error", { dataDir: fx.dataDir, isLive: broken }), null);
  assert.equal(existsSync(gitDir), true, "an unanswered check keeps the history");
  assert.equal(gitText(gitDir, ws, ["rev-parse", "HEAD"]).trim(), tip);

  // A uuid mismatch is a confirmed purge (the id was reused by a new project).
  await fx.db.execute({ sql: "UPDATE project_spaces SET archived_at = NULL WHERE id = 41", args: [] });
  const stranger = { ...project, uuid: "ffffffffffffffffffffffffffffffff" };
  assert.equal(await isLive(stranger), "gone");
  assert.equal(await commitWorkspace(stranger, OWNER, "stranger", { dataDir: fx.dataDir, isLive }), null);
  assert.equal(existsSync(gitDir), true, "the real project's folder is a different name");
  assert.equal(existsSync(gitDirFor(stranger, fx.dataDir)), false);

  // A missing row is a confirmed purge: the folder is removed.
  await fx.db.execute({ sql: "DELETE FROM project_spaces WHERE id = 41", args: [] });
  assert.equal(await isLive(project), "gone");
  assert.equal(await commitWorkspace(project, OWNER, "purged", { dataDir: fx.dataDir, isLive }), null);
  assert.equal(existsSync(gitDir), false, "a purged project loses its folder");
});

test("a file or folder swapped for a symlink after the walk never pulls outside bytes into history", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-swap-index-");
  const ws = join(fx.dataDir, "projects", "swap-index", "workspace");
  mkdirSync(join(ws, "sub"), { recursive: true });
  const outside = join(fx.dataDir, "outside-secret.txt");
  const SECRET = "TOP-SECRET-OUTSIDE-BYTES-12345";
  writeFileSync(outside, SECRET + "\n");
  writeFileSync(join(ws, "plain.txt"), "plain\n");
  writeFileSync(join(ws, "swapped.txt"), "original\n");
  writeFileSync(join(ws, "sub", "inner.txt"), "inner\n");
  const outsideDir = join(fx.dataDir, "outside-dir");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "inner.txt"), SECRET + " via folder\n");
  const project = projectFor(51, ws, uuidFor(51));
  const gitDir = gitDirFor(project, fx.dataDir);

  const _afterWalk = async () => {
    // The file becomes a symlink to a file outside the workspace.
    rmSync(join(ws, "swapped.txt"));
    symlinkSync(outside, join(ws, "swapped.txt"));
    // The folder becomes a symlink to a folder outside the workspace.
    rmSync(join(ws, "sub"), { recursive: true });
    symlinkSync(outsideDir, join(ws, "sub"));
  };
  assert.ok(await commitWorkspace(project, OWNER, "swap", { dataDir: fx.dataDir, _afterWalk }));

  // No blob in the whole object store holds the outside bytes.
  const objects = gitText(gitDir, ws, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"])
    .split("\n").filter((l) => l.endsWith(" blob")).map((l) => l.split(" ")[0]);
  for (const sha of objects) {
    const text = gitText(gitDir, ws, ["cat-file", "blob", sha]);
    assert.equal(text.includes("TOP-SECRET-OUTSIDE-BYTES"), false, "outside bytes never enter a blob");
  }
  const tree = gitText(gitDir, ws, ["ls-tree", "-r", "HEAD"]);
  assert.match(tree, /plain\.txt/);
  assert.doesNotMatch(tree, /swapped\.txt/, "the swapped file is dropped for this commit");
  assert.doesNotMatch(tree, /sub\/inner\.txt/, "the swapped folder's files are dropped");
});

test("a same-size edit with the mtime put back is still recorded as a new version", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-utimes-");
  const ws = join(fx.dataDir, "projects", "utimes", "workspace");
  mkdirSync(ws, { recursive: true });
  const file = join(ws, "a.txt");
  writeFileSync(file, "AAAA\n");
  const old = new Date(Date.now() - 3600_000);
  utimesSync(file, old, old);
  const project = projectFor(52, ws, uuidFor(52));
  const gitDir = gitDirFor(project, fx.dataDir);
  assert.ok(await commitWorkspace(project, OWNER, "first", { dataDir: fx.dataDir }));
  // Let the cache age past the racy window so only the key can protect us.
  const cacheFile = join(gitDir, "crow-hash-cache.json");
  const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
  cache.at = Date.now() + 3600_000;
  writeFileSync(cacheFile, JSON.stringify(cache));
  writeFileSync(file, "BBBB\n");
  utimesSync(file, old, old);
  assert.ok(await commitWorkspace(project, OWNER, "second", { dataDir: fx.dataDir }), "the edit is a new version");
  assert.equal(gitText(gitDir, ws, ["show", "HEAD:a.txt"]), "BBBB\n");
});

test("a git older than 2.29 disables file history with a reason, and says so", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-oldgit-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const res = await ensureWorkspaceHistory(null, { ...projectFor(61, ws) }, { dataDir: fx.dataDir, _gitVersion: () => [2, 28] });
    assert.equal(res.disabled, true);
    assert.match(res.reason, /git_too_old/);
    assert.ok(warnings.some((line) => /git_too_old/.test(line)), "and it was logged");
    assert.equal(existsSync(join(fx.dataDir, "history", "workspaces")), false, "no git dir was made");
    const ok = await ensureWorkspaceHistory(null, { ...projectFor(62, ws) }, { dataDir: fx.dataDir, _gitVersion: () => [2, 29] });
    assert.ok(ok.repoDir, "2.29 is enough");
  } finally {
    console.warn = realWarn;
  }
});

test("after a scheduled erase times out the project's scheduled erase pauses for 24 hours", { skip: NO_GIT }, async () => {
  const { fx, project } = await trashedFixture("hist-ws-backoff-", "Backoff");
  const inAMonth = () => new Date(Date.now() + 31 * 86_400_000);
  let now = 5_000_000;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    let heads = 0;
    const slow = {
      dataDir: fx.dataDir, trashDays: 30, autoErase: true, now: inAMonth, clock: () => now,
      onSpawn: (argv) => {
        if (argv.includes("rev-parse") && argv.includes("--verify")) {
          heads += 1;
          if (heads === 2) now += 60 * 60 * 1000;
        }
      },
    };
    const first = await sweepWorkspaces(fx.db, slow);
    assert.equal(first.eraseTimedOut, 1);
    // An hour on: paused, so no erase is even attempted.
    const second = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30, autoErase: true, now: inAMonth, clock: () => now });
    assert.equal(second.erased, 0);
    assert.equal(second.eraseTimedOut, 0);
    assert.deepEqual((await listDeletedWorkspaceFiles(project, { dataDir: fx.dataDir })).map((f) => f.path), ["drop.txt"], "still restorable");
    // A day and an hour later it tries again, and now it works.
    now += 24 * 60 * 60 * 1000;
    const third = await sweepWorkspaces(fx.db, { dataDir: fx.dataDir, trashDays: 30, autoErase: true, now: inAMonth, clock: () => now });
    assert.equal(third.erased, 1);
  } finally {
    console.warn = realWarn;
  }
});

test("a sweep removes hour-old temp and moved-aside names in the git dir, not fresh ones", { skip: NO_GIT }, async () => {
  const { fx, project } = await trashedFixture("hist-ws-leftovers-", "Leftovers");
  const gitDir = gitDirFor(project, fx.dataDir);
  const mk = (name, ageMs) => {
    const p = join(gitDir, name);
    writeFileSync(p, "x");
    const when = new Date(Date.now() - ageMs);
    utimesSync(p, when, when);
    return p;
  };
  const oldTmp = mk("crow-history.lock.tmp-1-aa", 2 * 3600_000);
  const oldStale = mk("crow-history.lock.stale-1-aa", 2 * 3600_000);
  const freshTmp = mk("crow-history.lock.tmp-2-bb", 60_000);
  await sweepWorkspaces(fx.db, { dataDir: fx.dataDir });
  assert.equal(existsSync(oldTmp), false);
  assert.equal(existsSync(oldStale), false);
  assert.equal(existsSync(freshTmp), true, "a fresh one may belong to a live writer");
});

test("a too-old git also makes the commit path return cleanly, with no git dir made", { skip: NO_GIT }, async () => {
  const fx = fixture("hist-ws-oldgit-commit-");
  const ws = join(fx.root, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "a.txt"), "a\n");
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const sha = await commitWorkspace(projectFor(63, ws), OWNER, "Start", { dataDir: fx.dataDir, _gitVersion: () => [2, 20] });
    assert.equal(sha, null);
    assert.equal(existsSync(gitDirFor(projectFor(63, ws), fx.dataDir)), false);
  } finally {
    console.warn = realWarn;
  }
});
