/**
 * crow_project_file_list / _read / _write / _delete: the workspace file tools of the crow-projects
 * server (2026-11-18).
 *
 * What this covers, in the order the design lists it: path escapes (.., absolute, empty segments,
 * backslash, NUL, internal .git and bots folders), symlinks (a link file, a linked parent folder, and
 * the resolve-then-swap race), hard links (a write and, since N6, a read), non-regular files, the
 * read/write/list caps, the per-project quota, if_match_sha256, atomic writes (nothing half-written,
 * no temp left behind), the actor matrix (owner, unidentified caller, bot with no share, bot with a
 * read share, bot with a write share and write_files, bot with a write share but no write_files, peer
 * instance), the audit rows, an archived project, and a workspace folder outside `<data>/projects`
 * (I2: a folder elsewhere in the data dir, `history/` and `datasets/` included, is no workspace).
 *
 * Review round fixes carry their ids: B1 (the peer that reaches the file tools through /router/mcp,
 * where it exists only as a forwarded `_meta`; kind "peer" and the remote-bot form), I1 (a bot may
 * not write or delete a dot-entry or a top-level CLAUDE.md/AGENTS.md/GEMINI.md), I3 (parseRelPath
 * directly, and a hook that moves a folder out BETWEEN component opens so the post-open kernel-path
 * check is what refuses), N2 (the empty-folder delete re-checks its parent), N6 (hard-linked read).
 *
 * Scratch CROW_HOME + data dir with a real crow.db from scripts/init-db.js: nothing here touches
 * ~/.crow. The files are real files under a real workspace folder.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "project-files-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = join(dir, "crow");
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
delete process.env.CROW_PROJECT_FILE_QUOTA_MB;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const DB_FILE = join(DATA, "crow.db");

let db = null;
let createDbClient = null;
let OWNER = null;
let UNKNOWN = null;
let createProjectServer = null;
let createProjectSpace = null;
let Client = null;
let InMemoryTransport = null;

const BOT_NO = "files-bot-noaccess";
const BOT_RO = "files-bot-read";
const BOT_RW = "files-bot-write";

/** A project with its workspace folder on disk. */
const A = { id: null, workspaceDir: null }; // the bots' home project
const B = { id: null, workspaceDir: null }; // shared with BOT_RO (read) and BOT_RW (read_write)
const C = { id: null, workspaceDir: null }; // shared read_write with BOT_RW but WITHOUT write_files

const text = (r) => (r.content || []).map((c) => c.text || "").join("\n");
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const refused = async (r, re) => {
  assert.equal(r.isError, true, text(r));
  assert.match(text(r), /^Error: /, text(r));
  if (re) assert.match(text(r), re, text(r));
  return text(r);
};
const ws = (project, ...names) => join(project.workspaceDir, ...names);

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  ({ createDbClient } = await import("../servers/db.js"));
  db = createDbClient(DB_FILE);
  ({ OWNER, UNKNOWN } = await import("../servers/research/actor.js"));
  ({ createProjectServer } = await import("../servers/research/server.js"));
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
  Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client;
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));

  // Constructing one server readies the provenance/withdrawal columns this DB needs.
  createProjectServer(DB_FILE, { actor: OWNER }).close();

  const mkProject = async (target, name) => {
    const made = await createProjectSpace(db, { name });
    target.id = Number(made.id);
    target.workspaceDir = made.workspaceDir;
    mkdirSync(made.workspaceDir, { recursive: true, mode: 0o750 });
  };
  await mkProject(A, "Files Alpha");
  await mkProject(B, "Files Bravo");
  await mkProject(C, "Files Charlie");
  writeFileSync(ws(B, "readable.txt"), "shared read\n");

  for (const [botId, home] of [[BOT_NO, A.id], [BOT_RO, A.id], [BOT_RW, A.id]]) {
    await db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
      args: [botId, botId, "{}", home],
    });
  }
  await db.execute({
    sql: "INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,'read')",
    args: [B.id, BOT_RO],
  });
  await db.execute({
    sql: "INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,'read_write')",
    args: [B.id, BOT_RW],
  });
  await db.execute({
    sql: "INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,'read_write')",
    args: [C.id, BOT_RW],
  });
  // C's local owner loses write_files: the share alone must not be enough.
  await db.execute({
    sql: "UPDATE project_members SET capabilities = ? WHERE project_id = ? AND contact_id IS NULL",
    args: [JSON.stringify({ write_files: false }), C.id],
  });
});

after(async () => {
  try { db && db.close && db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

async function clientFor(actor, opts = {}) {
  const server = createProjectServer(DB_FILE, { actor, ...opts });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "project-files-test", version: "0" });
  await client.connect(ct);
  return client;
}

const owner = () => clientFor(OWNER);

// ---------------------------------------------------------------------------------------------
// Owner round trip, plain paths, audit
// ---------------------------------------------------------------------------------------------

test("owner: write (creating folders), list, read, delete — and each write/delete is audited", async () => {
  const c = await owner();

  const empty = await call(c, "crow_project_file_list", { project_id: A.id });
  assert.ok(!empty.isError, text(empty));
  assert.match(text(empty), /0 entries/);

  const w = await call(c, "crow_project_file_write", { project_id: A.id, path: "notes/first.md", content: "hello\n" });
  assert.ok(!w.isError, text(w));
  assert.match(text(w), /Created notes\/first\.md \(6 bytes, sha256 [0-9a-f]{64}\)/);
  assert.equal(readFileSync(ws(A, "notes", "first.md"), "utf8"), "hello\n");
  assert.equal(lstatSync(ws(A, "notes", "first.md")).mode & 0o777, 0o640, "the final mode is 0640");

  const listed = await call(c, "crow_project_file_list", { project_id: A.id, recursive: true });
  assert.ok(!listed.isError, text(listed));
  assert.match(text(listed), /dir +notes/);
  assert.match(text(listed), /file +notes\/first\.md +6 bytes/);

  const read = await call(c, "crow_project_file_read", { project_id: A.id, path: "notes/first.md" });
  assert.ok(!read.isError, text(read));
  assert.equal(text(read), "hello\n", "the whole file is returned as one text block");

  const overwritten = await call(c, "crow_project_file_write", { project_id: A.id, path: "notes/first.md", content: "hello again" });
  assert.ok(!overwritten.isError, text(overwritten));
  assert.match(text(overwritten), /^Wrote notes\/first\.md/, text(overwritten));

  const del = await call(c, "crow_project_file_delete", { project_id: A.id, path: "notes/first.md" });
  assert.ok(!del.isError, text(del));
  assert.match(text(del), /Deleted notes\/first\.md \(11 bytes\)/);

  const gone = await call(c, "crow_project_file_read", { project_id: A.id, path: "notes/first.md" });
  assert.equal(await refused(gone), "Error: There is nothing at that path.");

  const audit = (await db.execute({
    sql: "SELECT action, target, payload, actor_type FROM project_audit_log WHERE project_id = ? AND action IN ('file.write','file.delete') ORDER BY id",
    args: [A.id],
  })).rows;
  assert.deepEqual(audit.map((r) => r.action), ["file.write", "file.write", "file.delete"]);
  assert.equal(audit[0].target, "file:notes/first.md");
  assert.equal(audit[0].actor_type, "local");
  const payload = JSON.parse(audit[0].payload);
  assert.deepEqual(Object.keys(payload).sort(), ["path", "sha256", "size"]);
  assert.equal(payload.size, 6);
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(audit).includes("hello"), "the content is never audited");

  // An unlinked, unidentified local caller keeps full access, like every project tool.
  const unknown = await clientFor(UNKNOWN);
  const unknownList = await call(unknown, "crow_project_file_list", { project_id: A.id });
  assert.ok(!unknownList.isError, text(unknownList));
});

test("empty folder delete is allowed; a non-empty folder is refused", async () => {
  const c = await owner();
  mkdirSync(ws(A, "empty-dir"));
  assert.ok(!(await call(c, "crow_project_file_delete", { project_id: A.id, path: "empty-dir" })).isError);
  assert.throws(() => lstatSync(ws(A, "empty-dir")));

  mkdirSync(ws(A, "full-dir"));
  writeFileSync(ws(A, "full-dir", "kept.txt"), "kept\n");
  await refused(await call(c, "crow_project_file_delete", { project_id: A.id, path: "full-dir" }), /not empty/);
  assert.equal(readFileSync(ws(A, "full-dir", "kept.txt"), "utf8"), "kept\n");
});

// ---------------------------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------------------------

test("every escape and malformed shape is refused, and nothing outside the workspace is touched", async () => {
  const c = await owner();
  const outside = join(dir, "outside-paths");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "outside secret\n");

  const bad = [
    "../outside-paths/secret.txt",
    "notes/../../outside-paths/secret.txt",
    "/etc/passwd",
    "a//b.txt",
    "notes/",
    "./notes/x.txt",
    "notes/./x.txt",
    "notes\\x.txt",
    "nul\u0000.txt",
    "bots/some-bot/notes.txt",
    ".git/config",
    "notes/.git/HEAD",
    "Notes/.GIT/config",
  ];
  for (const path of bad) {
    const r = await refused(await call(c, "crow_project_file_read", { project_id: A.id, path }), /^Error: /);
    assert.match(r, /path|link|folder/i, path);
    await refused(await call(c, "crow_project_file_write", { project_id: A.id, path, content: "x" }));
    await refused(await call(c, "crow_project_file_delete", { project_id: A.id, path }));
    await refused(await call(c, "crow_project_file_list", { project_id: A.id, path }));
  }
  // A read/write needs a path at all.
  await refused(await call(c, "crow_project_file_read", { project_id: A.id, path: "" }), /A path is required/);
  await refused(await call(c, "crow_project_file_write", { project_id: A.id, path: "", content: "x" }), /A path is required/);

  // The internal folders are refused, and never listed.
  mkdirSync(ws(A, ".git"), { recursive: true });
  writeFileSync(ws(A, ".git", "config"), "[core]\n");
  mkdirSync(ws(A, "bots", "some-bot"), { recursive: true });
  writeFileSync(ws(A, "bots", "some-bot", "notes.txt"), "bot world\n");
  const listed = await call(c, "crow_project_file_list", { project_id: A.id, recursive: true });
  assert.ok(!listed.isError, text(listed));
  assert.ok(!text(listed).includes(".git"), text(listed));
  assert.ok(!text(listed).includes("bots"), text(listed));
  assert.ok(!text(listed).includes("bot world"), text(listed));
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "outside secret\n");
});

test("a workspace folder outside the instance data dir is refused", async () => {
  const { id } = await createProjectSpace(db, { name: "Files Elsewhere" });
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "x.txt"), "x\n");
  await db.execute({ sql: "UPDATE project_spaces SET workspace_dir = ? WHERE id = ?", args: [elsewhere, Number(id)] });

  const c = await owner();
  await refused(await call(c, "crow_project_file_list", { project_id: Number(id) }), /outside this instance's projects folder/);
  await refused(await call(c, "crow_project_file_read", { project_id: Number(id), path: "x.txt" }), /outside this instance/);
  await refused(await call(c, "crow_project_file_write", { project_id: Number(id), path: "y.txt", content: "y" }), /outside this instance/);
  assert.equal(readFileSync(join(elsewhere, "x.txt"), "utf8"), "x\n");
  assert.deepEqual(readdirSync(elsewhere), ["x.txt"]);
});

test("I2: a workspace row inside the data dir but outside <data>/projects (history/, datasets/) is refused", async () => {
  const c = await owner();
  for (const [name, sub] of [["Files History", ["history", "snapshots-workspace"]], ["Files Datasets", ["datasets", "ds-workspace"]]]) {
    const { id } = await createProjectSpace(db, { name });
    const notAWorkspace = join(DATA, ...sub);
    mkdirSync(notAWorkspace, { recursive: true });
    writeFileSync(join(notAWorkspace, "kept.txt"), "kept\n");
    await db.execute({ sql: "UPDATE project_spaces SET workspace_dir = ? WHERE id = ?", args: [notAWorkspace, Number(id)] });

    await refused(await call(c, "crow_project_file_list", { project_id: Number(id) }), /outside this instance's projects folder/);
    await refused(await call(c, "crow_project_file_read", { project_id: Number(id), path: "kept.txt" }), /outside this instance's projects folder/);
    await refused(await call(c, "crow_project_file_write", { project_id: Number(id), path: "pwn.txt", content: "pwn" }), /outside this instance's projects folder/);
    await refused(await call(c, "crow_project_file_delete", { project_id: Number(id), path: "kept.txt" }), /outside this instance's projects folder/);
    assert.deepEqual(readdirSync(notAWorkspace), ["kept.txt"], `${name}: nothing was written or deleted`);
    assert.equal(readFileSync(join(notAWorkspace, "kept.txt"), "utf8"), "kept\n");
  }
  // The projects folder itself is not a workspace either (strictly inside, not equal).
  const { id } = await createProjectSpace(db, { name: "Files Projects Root" });
  await db.execute({ sql: "UPDATE project_spaces SET workspace_dir = ? WHERE id = ?", args: [join(DATA, "projects"), Number(id)] });
  await refused(await call(c, "crow_project_file_list", { project_id: Number(id) }), /outside this instance's projects folder/);
});

// ---------------------------------------------------------------------------------------------
// Symlinks and the resolve-then-swap race
// ---------------------------------------------------------------------------------------------

test("symlinks are listed but never followed: a link file, a linked folder, and every write shape", async () => {
  const c = await owner();
  const outside = join(dir, "symlink-targets");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "symlink secret\n");
  mkdirSync(ws(A, "links"), { recursive: true });
  symlinkSync(join(outside, "secret.txt"), ws(A, "links", "file-link.txt"));
  symlinkSync(outside, ws(A, "links", "dir-link"));

  const listed = await call(c, "crow_project_file_list", { project_id: A.id, path: "links", recursive: true });
  assert.ok(!listed.isError, text(listed));
  assert.match(text(listed), /link +links\/file-link\.txt/);
  assert.match(text(listed), /link +links\/dir-link/);
  assert.ok(!text(listed).includes("secret.txt"), "a linked folder is never entered");
  assert.ok(!text(listed).includes("symlink secret"));

  for (const path of ["links/file-link.txt", "links/dir-link/secret.txt"]) {
    const r = await refused(await call(c, "crow_project_file_read", { project_id: A.id, path }), /link/);
    assert.ok(!r.includes("symlink secret"), r);
    await refused(await call(c, "crow_project_file_write", { project_id: A.id, path, content: "pwn" }), /link/);
    await refused(await call(c, "crow_project_file_delete", { project_id: A.id, path }), /link/);
  }
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "symlink secret\n");
  assert.deepEqual(readdirSync(outside), ["secret.txt"], "nothing was written through the links");
});

test("resolve-then-swap: a folder replaced by a symlink between resolve and open reads and writes nothing outside", async () => {
  const outside = join(dir, "swap-target");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "swap secret\n");
  mkdirSync(ws(A, "swap"), { recursive: true });
  writeFileSync(ws(A, "swap", "notes.txt"), "own notes\n");

  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    // The race: the path resolved fine, then the folder becomes a link to a folder outside.
    renameSync(ws(A, "swap"), join(dir, "swap-moved"));
    symlinkSync(outside, ws(A, "swap"));
  };
  const c = await clientFor(OWNER, { beforeFileOpen: swap });

  const read = await call(c, "crow_project_file_read", { project_id: A.id, path: "swap/secret.txt" });
  assert.equal(read.isError, true, text(read));
  assert.ok(!text(read).includes("swap secret"), text(read));
  assert.ok(swapped, "the hook really swapped the folder");

  const write = await call(c, "crow_project_file_write", { project_id: A.id, path: "swap/pwn.txt", content: "pwn" });
  assert.equal(write.isError, true, text(write));
  const del = await call(c, "crow_project_file_delete", { project_id: A.id, path: "swap/secret.txt" });
  assert.equal(del.isError, true, text(del));

  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "swap secret\n");
  assert.deepEqual(readdirSync(outside), ["secret.txt"], "nothing outside was written or deleted");
  // The real folder is untouched too (it moved, it was never deleted through the link).
  assert.equal(readFileSync(join(dir, "swap-moved", "notes.txt"), "utf8"), "own notes\n");
});

// ---------------------------------------------------------------------------------------------
// File kinds
// ---------------------------------------------------------------------------------------------

test("a hard-linked file is never overwritten; non-regular files are refused", async () => {
  const c = await owner();
  mkdirSync(ws(A, "kinds"), { recursive: true });
  writeFileSync(ws(A, "kinds", "one.txt"), "linked content\n");
  linkSync(ws(A, "kinds", "one.txt"), ws(A, "kinds", "two.txt"));

  await refused(await call(c, "crow_project_file_write", { project_id: A.id, path: "kinds/one.txt", content: "overwrite" }), /hard-linked/);
  assert.equal(readFileSync(ws(A, "kinds", "one.txt"), "utf8"), "linked content\n");
  assert.equal(readFileSync(ws(A, "kinds", "two.txt"), "utf8"), "linked content\n");
  // N6: a read is refused too — the same bytes are another name's, and that name need not be here.
  await refused(await call(c, "crow_project_file_read", { project_id: A.id, path: "kinds/one.txt" }), /hard-linked/);
  await refused(await call(c, "crow_project_file_read", { project_id: A.id, path: "kinds/two.txt" }), /hard-linked/);

  let hasFifo = true;
  try {
    execFileSync("mkfifo", [ws(A, "kinds", "pipe")], { stdio: "pipe" });
  } catch {
    hasFifo = false;
  }
  if (hasFifo) {
    await refused(await call(c, "crow_project_file_read", { project_id: A.id, path: "kinds/pipe" }), /not a regular file/);
    await refused(await call(c, "crow_project_file_write", { project_id: A.id, path: "kinds/pipe", content: "x" }), /not a regular file/);
    await refused(await call(c, "crow_project_file_delete", { project_id: A.id, path: "kinds/pipe" }), /not a regular file/);
  }

  // A folder is not a file to read, write or (when empty) delete as one.
  mkdirSync(ws(A, "kinds", "sub"), { recursive: true });
  await refused(await call(c, "crow_project_file_read", { project_id: A.id, path: "kinds/sub" }), /folder, not a file/);
  await refused(await call(c, "crow_project_file_write", { project_id: A.id, path: "kinds/sub", content: "x" }), /folder, not a file/);
});

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

test("size caps: reads stop at 1 MiB, writes over 5 MiB are refused, listings stop at the limit", async () => {
  const c = await owner();
  mkdirSync(ws(A, "limits"), { recursive: true });
  const big = "A".repeat(1024 * 1024 + 500);
  const wrote = await call(c, "crow_project_file_write", { project_id: A.id, path: "limits/big.txt", content: big });
  assert.ok(!wrote.isError, text(wrote));

  const first = await call(c, "crow_project_file_read", { project_id: A.id, path: "limits/big.txt" });
  assert.ok(!first.isError, text(first));
  assert.equal(first.content[0].text.length, 1024 * 1024);
  assert.match(text(first), /bytes 0-1048575/);

  const rest = await call(c, "crow_project_file_read", { project_id: A.id, path: "limits/big.txt", offset: 1024 * 1024, max_bytes: 1024 });
  assert.ok(!rest.isError, text(rest));
  assert.equal(rest.content.length, 2, "the header block says where the bytes came from");
  assert.equal(rest.content[0].text.length, 500);
  assert.match(text(rest), /bytes 1048576-1049075 of 1049076/);
  assert.ok(!text(rest).includes("call again"), "the last chunk offers no next offset");

  const tooBig = await call(c, "crow_project_file_write", {
    project_id: A.id, path: "limits/too-big.txt", content: "B".repeat(5 * 1024 * 1024 + 1),
  });
  await refused(tooBig, /larger than the 5 MiB limit/);
  assert.ok(!readdirSync(ws(A, "limits")).includes("too-big.txt"), "a refused write creates nothing");

  for (let i = 0; i < 6; i++) writeFileSync(ws(A, "limits", `n${i}.txt`), `${i}\n`);
  const capped = await call(c, "crow_project_file_list", { project_id: A.id, path: "limits", limit: 3 });
  assert.ok(!capped.isError, text(capped));
  assert.match(text(capped), /3 entries/);
  assert.match(text(capped), /stopped at 3 entries/);
});

test("the per-project quota (CROW_PROJECT_FILE_QUOTA_MB) refuses a write that would exceed it", async () => {
  const { id, workspaceDir } = await createProjectSpace(db, { name: "Files Quota" });
  mkdirSync(workspaceDir, { recursive: true });
  const c = await owner();
  process.env.CROW_PROJECT_FILE_QUOTA_MB = "0.001"; // 1048 bytes
  try {
    const small = await call(c, "crow_project_file_write", { project_id: Number(id), path: "small.txt", content: "s".repeat(500) });
    assert.ok(!small.isError, text(small));
    const over = await call(c, "crow_project_file_write", { project_id: Number(id), path: "over.txt", content: "o".repeat(1000) });
    await refused(over, /quota/);
    assert.ok(!readdirSync(workspaceDir).includes("over.txt"));
    // Replacing an existing file is measured net of what it already holds.
    const replace = await call(c, "crow_project_file_write", { project_id: Number(id), path: "small.txt", content: "s".repeat(1000) });
    assert.ok(!replace.isError, text(replace));
  } finally {
    delete process.env.CROW_PROJECT_FILE_QUOTA_MB;
  }
});

// ---------------------------------------------------------------------------------------------
// if_match_sha256 and atomicity
// ---------------------------------------------------------------------------------------------

test("if_match_sha256: a stale sha refuses the write, the current one allows it, and the file is never half-written", async () => {
  const c = await owner();
  mkdirSync(ws(A, "concurrency"), { recursive: true });
  const first = await call(c, "crow_project_file_write", { project_id: A.id, path: "concurrency/shared.md", content: "v1" });
  assert.ok(!first.isError, text(first));
  const sha1 = text(first).match(/sha256 ([0-9a-f]{64})/)[1];

  const read = await call(c, "crow_project_file_read", { project_id: A.id, path: "concurrency/shared.md" });
  assert.ok(!read.isError, text(read));

  // Someone else wrote in between.
  const other = await call(c, "crow_project_file_write", { project_id: A.id, path: "concurrency/shared.md", content: "v2 by another editor" });
  assert.ok(!other.isError, text(other));

  const stale = await call(c, "crow_project_file_write", {
    project_id: A.id, path: "concurrency/shared.md", content: "v3 clobber", if_match_sha256: sha1,
  });
  await refused(stale, /changed since it was read/);
  assert.equal(readFileSync(ws(A, "concurrency", "shared.md"), "utf8"), "v2 by another editor");

  const sha2 = text(other).match(/sha256 ([0-9a-f]{64})/)[1];
  const fresh = await call(c, "crow_project_file_write", {
    project_id: A.id, path: "concurrency/shared.md", content: "v3 ok", if_match_sha256: sha2,
  });
  assert.ok(!fresh.isError, text(fresh));
  assert.equal(readFileSync(ws(A, "concurrency", "shared.md"), "utf8"), "v3 ok");

  // A new file with if_match has nothing to match, and a garbage sha is refused.
  await refused(await call(c, "crow_project_file_write", {
    project_id: A.id, path: "concurrency/new.md", content: "x", if_match_sha256: sha2,
  }), /changed since it was read/);
  await refused(await call(c, "crow_project_file_write", {
    project_id: A.id, path: "concurrency/shared.md", content: "x", if_match_sha256: "not-a-sha",
  }), /64 hex characters/);

  // A refused write leaves no temp file behind and the old bytes in place.
  assert.deepEqual(readdirSync(ws(A, "concurrency")).filter((n) => n.startsWith(".crow-write-")), []);
});

test("base64 round trip, and a binary file is refused as utf8", async () => {
  const c = await owner();
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
  const w = await call(c, "crow_project_file_write", {
    project_id: A.id, path: "bin/data.bin", content: bytes.toString("base64"), encoding: "base64",
  });
  assert.ok(!w.isError, text(w));
  assert.deepEqual(readFileSync(ws(A, "bin", "data.bin")), bytes);

  await refused(await call(c, "crow_project_file_read", { project_id: A.id, path: "bin/data.bin" }), /looks binary/);
  const b64 = await call(c, "crow_project_file_read", { project_id: A.id, path: "bin/data.bin", encoding: "base64" });
  assert.ok(!b64.isError, text(b64));
  assert.deepEqual(Buffer.from(b64.content[0].text, "base64"), bytes);
});

// ---------------------------------------------------------------------------------------------
// Actor matrix
// ---------------------------------------------------------------------------------------------

test("owner: full access on any project, including one shared with a bot", async () => {
  const c = await owner();
  const w = await call(c, "crow_project_file_write", { project_id: B.id, path: "owner.txt", content: "owner\n" });
  assert.ok(!w.isError, text(w));
  assert.ok(!(await call(c, "crow_project_file_list", { project_id: B.id })).isError);
  assert.ok(!(await call(c, "crow_project_file_read", { project_id: B.id, path: "owner.txt" })).isError);
  assert.ok(!(await call(c, "crow_project_file_delete", { project_id: B.id, path: "owner.txt" })).isError);
});

test("a bot with no share of B is refused every file tool there, and works on its own project", async () => {
  const bot = await clientFor({ kind: "bot", id: BOT_NO });
  for (const [name, args] of [
    ["crow_project_file_list", { project_id: B.id }],
    ["crow_project_file_read", { project_id: B.id, path: "owner.txt" }],
    ["crow_project_file_write", { project_id: B.id, path: "nope.txt", content: "x" }],
    ["crow_project_file_delete", { project_id: B.id, path: "owner.txt" }],
  ]) {
    const r = await refused(await call(bot, name, args), /No share grants this bot access/);
    assert.ok(!r.includes("Files Bravo"), `${name} names no project: ${r}`);
  }
  // Its home project is its own: a write there is allowed.
  const home = await call(bot, "crow_project_file_write", { project_id: A.id, path: "bot-home.txt", content: "mine\n" });
  assert.ok(!home.isError, text(home));
  assert.equal(readFileSync(ws(A, "bot-home.txt"), "utf8"), "mine\n");
});

test("a bot with a READ share lists and reads B but cannot write or delete there", async () => {
  const bot = await clientFor({ kind: "bot", id: BOT_RO });
  const listed = await call(bot, "crow_project_file_list", { project_id: B.id, recursive: true });
  assert.ok(!listed.isError, text(listed));
  assert.match(text(listed), /readable\.txt/);

  const read = await call(bot, "crow_project_file_read", { project_id: B.id, path: "readable.txt" });
  assert.ok(!read.isError, text(read));
  assert.equal(text(read), "shared read\n");

  await refused(await call(bot, "crow_project_file_write", { project_id: B.id, path: "readable.txt", content: "pwn" }), /read-only/);
  await refused(await call(bot, "crow_project_file_delete", { project_id: B.id, path: "readable.txt" }), /read-only/);
  assert.equal(readFileSync(ws(B, "readable.txt"), "utf8"), "shared read\n");

  const audit = (await db.execute({
    sql: "SELECT target FROM project_audit_log WHERE project_id = ? AND action = 'share.refused' AND actor_id = ?",
    args: [B.id, BOT_RO],
  })).rows;
  assert.ok(audit.some((r) => r.target === "tool:crow_project_file_write"), JSON.stringify(audit));
});

test("a bot with a write share and write_files writes B, audited as the bot", async () => {
  const bot = await clientFor({ kind: "bot", id: BOT_RW });
  const w = await call(bot, "crow_project_file_write", { project_id: B.id, path: "by-bot.txt", content: "bot wrote this\n" });
  assert.ok(!w.isError, text(w));
  assert.equal(readFileSync(ws(B, "by-bot.txt"), "utf8"), "bot wrote this\n");

  const audit = (await db.execute({
    sql: "SELECT actor_type, actor_id, payload FROM project_audit_log WHERE project_id = ? AND action = 'file.write' AND target = ?",
    args: [B.id, "file:by-bot.txt"],
  })).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_type, "bot");
  assert.equal(audit[0].actor_id, BOT_RW);
  assert.equal(JSON.parse(audit[0].payload).path, "by-bot.txt");

  const del = await call(bot, "crow_project_file_delete", { project_id: B.id, path: "by-bot.txt" });
  assert.ok(!del.isError, text(del));
});

test("a write share without the project's write_files capability refuses the write and the delete", async () => {
  const bot = await clientFor({ kind: "bot", id: BOT_RW });
  await refused(await call(bot, "crow_project_file_write", { project_id: C.id, path: "x.txt", content: "x" }), /write_files/);
  await refused(await call(bot, "crow_project_file_delete", { project_id: C.id, path: "nope.txt" }), /write_files/);
  const listed = await call(bot, "crow_project_file_list", { project_id: C.id });
  assert.ok(!listed.isError, text(listed));
});

test("a peer instance is refused outright", async () => {
  const server = createProjectServer(DB_FILE, { actor: OWNER });
  try {
    const tool = server._registeredTools.crow_project_file_list;
    assert.ok(tool && typeof tool.handler === "function");
    const r = await tool.handler({ project_id: A.id }, { authInfo: { token: "peer-instance" } });
    assert.equal(r.isError, true, text(r));
    assert.match(text(r), /peer instance may not use them/);
    const write = await server._registeredTools.crow_project_file_write.handler(
      { project_id: A.id, path: "peer.txt", content: "x" }, { authInfo: { token: "peer-instance" } });
    assert.equal(write.isError, true, text(write));
    assert.ok(!readdirSync(A.workspaceDir).includes("peer.txt"));
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------------------------
// B1: the peer that arrives only as `_meta` (through the router's in-process client)
// ---------------------------------------------------------------------------------------------

test("B1: a peer is refused the file tools through /router/mcp, where no authInfo ever arrives", async () => {
  const { createRouterServer } = await import("../servers/gateway/router.js");
  const router = createRouterServer({ actor: OWNER });
  try {
    const tool = router._registeredTools.crow_projects;
    assert.ok(tool && typeof tool.handler === "function", "the router registers crow_projects");
    const viaRouter = (action, params, extra) => tool.handler({ action, params }, extra);

    // (a) the shape the peer MOUNT makes: the bearer token in authInfo. The router forwards it as
    // _meta {kind:"peer"} and its in-process client (InMemoryTransport) carries no authInfo at all,
    // which is exactly the hole: the project server used to read it as an unidentified local caller.
    const write = await viaRouter("crow_project_file_write", { project_id: A.id, path: "peer-router.txt", content: "pwn" },
      { authInfo: { token: "peer-instance" } });
    assert.equal(write.isError, true, text(write));
    assert.match(text(write), /peer instance may not use them/);
    const read = await viaRouter("crow_project_file_read", { project_id: A.id, path: "limits/big.txt" },
      { authInfo: { token: "peer-instance" } });
    assert.equal(read.isError, true, text(read));
    assert.match(text(read), /peer instance may not use them/);

    // (2) a peer marker that arrived as _meta is forwarded as-is and refused just the same.
    const forwarded = await viaRouter("crow_project_file_write", { project_id: A.id, path: "peer-router.txt", content: "pwn" },
      { _meta: { "crow/actor": { kind: "peer", instance: "peer-1", from: "delta" } } });
    assert.equal(forwarded.isError, true, text(forwarded));
    assert.match(text(forwarded), /peer instance may not use them/);

    assert.ok(!readdirSync(A.workspaceDir).includes("peer-router.txt"), "nothing was written for the peer");
  } finally {
    router.close();
  }
});

test("B1: a handler call carrying a peer marker in _meta is refused — kind peer and the remote-bot form", async () => {
  const server = createProjectServer(DB_FILE, { actor: OWNER });
  try {
    // (b) the ordinary peer form and (c) the remote-bot form a peer's gateway signs: kind "bot" WITH
    // an instance. A local bot's _meta carries no instance (forwardActorMeta strips it), so neither
    // shape can come from here.
    for (const extra of [
      { _meta: { "crow/actor": { kind: "peer" } } },
      { _meta: { "crow/actor": { kind: "peer", instance: "peer-1" } } },
      { _meta: { "crow/actor": { kind: "bot", id: "some-bot@peer-1", instance: "peer-1" } } },
    ]) {
      for (const [name, args] of [
        ["crow_project_file_read", { project_id: A.id, path: "limits/big.txt" }],
        ["crow_project_file_write", { project_id: A.id, path: "peer-direct.txt", content: "pwn" }],
        ["crow_project_file_delete", { project_id: A.id, path: "limits/big.txt" }],
      ]) {
        const r = await server._registeredTools[name].handler(args, extra);
        assert.equal(r.isError, true, `${name} ${JSON.stringify(extra)}: ${text(r)}`);
        assert.match(text(r), /peer instance may not use them/);
      }
    }
    assert.ok(!readdirSync(A.workspaceDir).includes("peer-direct.txt"));
    assert.ok(lstatSync(ws(A, "limits", "big.txt")).isFile(), "the peer's delete never ran");

    // A LOCAL bot's _meta is not a peer: the share gate answers, with its own message. (B is not
    // BOT_NO's home project and no share names it.)
    const localBot = await server._registeredTools.crow_project_file_read.handler(
      { project_id: B.id, path: "readable.txt" }, { _meta: { "crow/actor": { kind: "bot", id: BOT_NO } } });
    assert.equal(localBot.isError, true, text(localBot));
    assert.match(text(localBot), /No share grants this bot access/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Project state
// ---------------------------------------------------------------------------------------------

test("an archived project is refused", async () => {
  const { id, workspaceDir } = await createProjectSpace(db, { name: "Files Archived" });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "x.txt"), "x\n");
  await db.execute({ sql: "UPDATE project_spaces SET status = 'archived' WHERE id = ?", args: [Number(id)] });

  const c = await owner();
  await refused(await call(c, "crow_project_file_list", { project_id: Number(id) }), /archived/);
  await refused(await call(c, "crow_project_file_write", { project_id: Number(id), path: "y.txt", content: "y" }), /archived/);
  await refused(await call(c, "crow_project_file_read", { project_id: Number(id), path: "x.txt" }), /archived/);
  assert.equal(readFileSync(join(workspaceDir, "x.txt"), "utf8"), "x\n");
});

test("a project with no workspace folder yet says so instead of creating one", async () => {
  const { id, workspaceDir } = await createProjectSpace(db, { name: "Files No Workspace" });
  rmSync(workspaceDir, { recursive: true, force: true });
  const c = await owner();
  await refused(await call(c, "crow_project_file_list", { project_id: Number(id) }), /workspace folder/);
  await refused(await call(c, "crow_project_file_write", { project_id: Number(id), path: "a.txt", content: "a" }));
  assert.throws(() => lstatSync(workspaceDir), "the tools never create the workspace folder");
});

// ---------------------------------------------------------------------------------------------
// I1: a bot's writes and deletes cannot plant dot-entries or agent instruction files
// ---------------------------------------------------------------------------------------------

test("I1: a bot may not write or delete a dot-entry (any depth) or a top-level CLAUDE.md/AGENTS.md/GEMINI.md", async () => {
  const bot = await clientFor({ kind: "bot", id: BOT_RW }); // read_write on B, write_files included
  const BOT_PATH_RE = /dot-file or dot-folder/;
  const dotPaths = [".mcp.json", ".claude/settings.json", ".pi/agent.md", ".envrc", ".vscode/settings.json",
    "notes/.hidden.md", "docs/.claude/x.md", "a/b/.env.example"];
  for (const path of dotPaths) {
    const w = await refused(await call(bot, "crow_project_file_write", { project_id: B.id, path, content: "pwn" }), BOT_PATH_RE);
    assert.match(w, /top-level CLAUDE\.md, AGENTS\.md or GEMINI\.md/, "one fixed refusal for every shape");
    await refused(await call(bot, "crow_project_file_delete", { project_id: B.id, path }), BOT_PATH_RE);
  }
  for (const path of ["CLAUDE.md", "AGENTS.md", "agents.md", "Gemini.MD"]) {
    await refused(await call(bot, "crow_project_file_write", { project_id: B.id, path, content: "pwn" }), BOT_PATH_RE);
    await refused(await call(bot, "crow_project_file_delete", { project_id: B.id, path }), BOT_PATH_RE);
  }
  assert.deepEqual(readdirSync(B.workspaceDir).filter((n) => n.startsWith(".") || /^(claude|agents|gemini)\.md$/i.test(n)), [],
    "nothing the bot refused was created (and no delete leaked whether it existed)");

  // The bot keeps its ordinary writes and deletes.
  assert.ok(!(await call(bot, "crow_project_file_write", { project_id: B.id, path: "ordinary.md", content: "fine\n" })).isError);
  assert.ok(!(await call(bot, "crow_project_file_delete", { project_id: B.id, path: "ordinary.md" })).isError);

  // The owner is unchanged: the same paths, allowed.
  const own = await owner();
  const dot = await call(own, "crow_project_file_write", { project_id: B.id, path: ".mcp.json", content: "{}\n" });
  assert.ok(!dot.isError, text(dot));
  assert.equal(readFileSync(ws(B, ".mcp.json"), "utf8"), "{}\n");
  const agent = await call(own, "crow_project_file_write", { project_id: B.id, path: "CLAUDE.md", content: "# rules\n" });
  assert.ok(!agent.isError, text(agent));
  assert.equal(readFileSync(ws(B, "CLAUDE.md"), "utf8"), "# rules\n");
  assert.ok(!(await call(own, "crow_project_file_delete", { project_id: B.id, path: ".mcp.json" })).isError);
  assert.throws(() => lstatSync(ws(B, ".mcp.json")));
});

// ---------------------------------------------------------------------------------------------
// I3: the path rules and the between-opens race, exercised directly
// ---------------------------------------------------------------------------------------------

test("I3: parseRelPath refuses each shape on its own", async () => {
  const { parseRelPath, ProjectFileError } = await import("../servers/shared/project-files.js");
  const invalid = (value) => assert.throws(
    () => parseRelPath(value),
    (err) => err instanceof ProjectFileError && err.code === "invalid_path",
    `${JSON.stringify(value)} must be refused`,
  );
  for (const value of [
    "..", "../x", "x/../y", ".", "./x", "x/./y",       // no . or .. component, no relative prefix
    "/etc/passwd", "/",                                    // not absolute
    "a//b", "a/", "",                                      // no empty component
    "x\u0000y",                                            // NUL
    "x\\y", "x\\",                                        // no backslash
    "a\u0001b", "a\u007fb", "a\tb",                      // no control character
    ".GIT/config", "Notes/.Git/HEAD",                      // .git* at any depth
    "Bots/x", "bots/x",                                    // bots at the top level
    "x".repeat(256),                                       // component cap
  ]) invalid(value);
  // Not text at all.
  invalid(42);
  invalid(null);
  // A valid path, and the boundaries that are NOT parseRelPath's business.
  assert.deepEqual(parseRelPath("a/b/c.txt"), ["a", "b", "c.txt"]);
  assert.deepEqual(parseRelPath("docs/bots/x.txt"), ["docs", "bots", "x.txt"], "bots is internal only at the top");
  assert.deepEqual(parseRelPath(".env"), [".env"], "a dot-entry is allowed here; the bot rule is a separate check");
  assert.deepEqual(parseRelPath("notes/bots.txt"), ["notes", "bots.txt"], "the bots rule matches the name exactly");
  // allowEmpty is what a listing uses for "the workspace root".
  assert.deepEqual(parseRelPath("", { allowEmpty: true }), []);
  assert.deepEqual(parseRelPath(undefined, { allowEmpty: true }), []);
});

test("I3: a folder moved out of the workspace BETWEEN component opens is refused by the post-open kernelPath check", async () => {
  // The hook fires after the parent folder component was opened AND its kernel path verified, so the
  // open of the target itself still succeeds (it is fd-relative) and only the re-read of the opened
  // fd's kernel path can see that the folder is no longer in the workspace.
  //
  // MUTATION CHECK (for the orchestrator; not run here): in servers/shared/project-files.js read(),
  // delete the two lines
  //     const seen = kernelPath(fd);
  //     if (seen === null || !inside(seen, root.real)) fail("outside_root");
  // and the FIRST case below fails — the read returns the bytes. Deleting write()'s pre-rename
  // parent check fails case 2 (the bytes land in the moved folder), and deleting remove()'s
  // pre-rmdir parent check (N2) fails case 3 (the rmdir empties the moved folder).
  const moved = (from, to) => {
    let done = false;
    return { fired: () => done, hook: () => { if (done) return; done = true; renameSync(from, to); } };
  };

  // (1) read: the post-open check of the opened FILE is what refuses.
  mkdirSync(ws(A, "between-read"), { recursive: true });
  writeFileSync(ws(A, "between-read", "notes.txt"), "between content\n");
  const readMove = moved(ws(A, "between-read"), join(dir, "between-read-moved"));
  const reader = await clientFor(OWNER, { afterFileComponentOpen: readMove.hook });
  const read = await call(reader, "crow_project_file_read", { project_id: A.id, path: "between-read/notes.txt" });
  assert.equal(read.isError, true, text(read));
  assert.match(text(read), /outside the project's workspace folder/);
  assert.ok(!text(read).includes("between content"), "no byte was returned");
  assert.ok(readMove.fired(), "the hook really moved the folder out of the workspace");
  assert.equal(readFileSync(join(dir, "between-read-moved", "notes.txt"), "utf8"), "between content\n", "the file itself is untouched");

  // (2) write: the parent's re-check before the rename refuses, and no temp file is left behind.
  mkdirSync(ws(A, "between-write"), { recursive: true });
  const writeMove = moved(ws(A, "between-write"), join(dir, "between-write-moved"));
  const writer = await clientFor(OWNER, { afterFileComponentOpen: writeMove.hook });
  const write = await call(writer, "crow_project_file_write", { project_id: A.id, path: "between-write/pwn.txt", content: "pwn" });
  assert.equal(write.isError, true, text(write));
  assert.match(text(write), /outside the project's workspace folder/);
  assert.deepEqual(readdirSync(join(dir, "between-write-moved")), [], "nothing was written, and no temp file survived");

  // (3) delete of an EMPTY folder: N2's parent re-check refuses before the rmdir. Without it the
  // rmdir would go through the fd and empty the folder in its new place.
  mkdirSync(ws(A, "between-delete", "empty-sub"), { recursive: true });
  const deleteMove = moved(ws(A, "between-delete"), join(dir, "between-delete-moved"));
  const deleter = await clientFor(OWNER, { afterFileComponentOpen: deleteMove.hook });
  const del = await call(deleter, "crow_project_file_delete", { project_id: A.id, path: "between-delete/empty-sub" });
  assert.equal(del.isError, true, text(del));
  assert.match(text(del), /outside the project's workspace folder/);
  assert.ok(lstatSync(join(dir, "between-delete-moved", "empty-sub")).isDirectory(), "the folder was not removed outside the workspace");
});