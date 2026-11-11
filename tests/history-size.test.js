/**
 * The History size line counts all three places History keeps data (crow.db
 * versions, tasks.db card versions, project file history folders), degrades one
 * part at a time, never follows a symlink, and warns when History is more than a
 * tenth of the free space on the data volume.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "hist-size-"));
process.env.CROW_HOME = join(root, "home");
process.env.CROW_DATA_DIR = root;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_DB_PATH;
delete process.env.CROW_TASKS_DB_PATH;
after(() => rmSync(root, { recursive: true, force: true }));

const { createDbClient } = await import("../servers/db.js");
const { historyFootprint, folderBytes, WARN_SHARE_OF_FREE } = await import("../servers/shared/history/size.js");
const { translations, t, fill } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { sizeLines } = await import("../servers/gateway/dashboard/settings/sections/history.js");

const VERSIONS_DDL = "CREATE TABLE item_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_json TEXT NOT NULL)";

function storeWith(path, snapshots) {
  const raw = new Database(path);
  raw.exec(VERSIONS_DDL);
  const ins = raw.prepare("INSERT INTO item_versions (snapshot_json) VALUES (?)");
  for (const s of snapshots) ins.run(s);
  raw.close();
}

function freshDir(name) {
  const d = join(root, name);
  mkdirSync(join(d, "history", "workspaces"), { recursive: true });
  return d;
}

test("crow.db versions, tasks.db card versions and workspace folders are all counted", async () => {
  const dir = freshDir("all");
  storeWith(join(dir, "crow.db"), ["a".repeat(100), "b".repeat(50)]);
  storeWith(join(dir, "tasks.db"), ["c".repeat(30)]);
  writeFileSync(join(dir, "history", "workspaces", "1-x.git-file"), Buffer.alloc(4000));
  mkdirSync(join(dir, "history", "workspaces", "2-y.git", "objects"), { recursive: true });
  writeFileSync(join(dir, "history", "workspaces", "2-y.git", "objects", "o"), Buffer.alloc(1000));
  const db = createDbClient(join(dir, "crow.db"));
  try {
    const fp = await historyFootprint(db, { tasksDbPath: join(dir, "tasks.db"), dataDir: dir, free: null });
    assert.equal(fp.versions, 2);
    assert.equal(fp.bytes, 150);
    assert.deepEqual(fp.cards, { versions: 1, bytes: 30 });
    assert.equal(fp.workspaceBytes, 5000);
    assert.equal(fp.totalBytes, 5180);
    assert.equal(fp.partial, false);
    assert.equal(fp.warn, false, "free space unknown: never warns on a guess");
  } finally {
    db.close();
  }
});

test("missing tables and folders are zeros, and a missing tasks.db is not created", async () => {
  const dir = join(root, "empty");
  mkdirSync(dir, { recursive: true });
  const db = createDbClient(join(dir, "crow.db"));
  try {
    const fp = await historyFootprint(db, { tasksDbPath: join(dir, "tasks.db"), dataDir: dir, free: 1e9 });
    assert.equal(fp.versions, 0);
    assert.deepEqual(fp.cards, { versions: 0, bytes: 0 });
    assert.equal(fp.workspaceBytes, 0);
    assert.equal(fp.totalBytes, 0);
    assert.equal(fp.warn, false);
    assert.equal(new Set((await import("node:fs")).readdirSync(dir)).has("tasks.db"), false);
  } finally {
    db.close();
  }
});

test("the warning shows past a tenth of free space and hides at or under it", async () => {
  const dir = freshDir("warn");
  writeFileSync(join(dir, "history", "workspaces", "f"), Buffer.alloc(1000));
  const db = createDbClient(join(dir, "crow.db"));
  try {
    const at = await historyFootprint(db, { tasksDbPath: join(dir, "none.db"), dataDir: dir, free: 1000 / WARN_SHARE_OF_FREE });
    assert.equal(at.warn, false, "exactly the share is not over it");
    const over = await historyFootprint(db, { tasksDbPath: join(dir, "none.db"), dataDir: dir, free: 1000 / WARN_SHARE_OF_FREE - 1 });
    assert.equal(over.warn, true);
    const roomy = await historyFootprint(db, { tasksDbPath: join(dir, "none.db"), dataDir: dir, free: 1e12 });
    assert.equal(roomy.warn, false);
  } finally {
    db.close();
  }
});

test("a symlink in a history folder is not followed", () => {
  const dir = freshDir("link");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "big"), Buffer.alloc(100000));
  symlinkSync(outside, join(dir, "history", "workspaces", "dirlink"));
  symlinkSync(join(outside, "big"), join(dir, "history", "workspaces", "filelink"));
  const bytes = folderBytes(join(dir, "history", "workspaces"));
  assert.ok(bytes < 1000, `symlink targets must not be counted, got ${bytes}`);
});

test("a walk past its cap is unknown (null), not a wrong number", () => {
  const dir = freshDir("cap");
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, "history", "workspaces", `f${i}`), "x");
  assert.equal(folderBytes(join(dir, "history", "workspaces"), { maxEntries: 3 }), null);
  let tick = 0;
  assert.equal(folderBytes(join(dir, "history", "workspaces"), { maxMs: 10, now: () => (tick += 100) }), null);
  assert.equal(folderBytes(join(dir, "nope")), 0);
});

test("an unreadable card store marks the total partial instead of reading as empty", async () => {
  const dir = freshDir("bad");
  writeFileSync(join(dir, "tasks.db"), "this is not a database");
  const db = createDbClient(join(dir, "crow.db"));
  try {
    const fp = await historyFootprint(db, { tasksDbPath: join(dir, "tasks.db"), dataDir: dir, free: null });
    assert.equal(fp.cards, null);
    assert.equal(fp.partial, true);
    assert.ok(Number.isFinite(fp.totalBytes));
  } finally {
    db.close();
  }
});

test("the size strings exist in en and es", () => {
  for (const key of ["settings.historyWorkspaceSize", "settings.historyWorkspaceUnknown", "settings.historySizeUnknown", "settings.historySizePartial", "settings.historySizeWarn"]) {
    for (const lang of ["en", "es"]) assert.ok(translations[key]?.[lang]?.length > 0, `${key} ${lang}`);
  }
  assert.match(fill(t("settings.historySizeWarn", "en"), { size: "1 GB", free: "5 GB" }), /1 GB.*5 GB/);
});

test("the page lines: card versions join the count, the warning and unknown parts render, nothing breaks on null", () => {
  const base = { versions: 2, bytes: 150, cards: { versions: 3, bytes: 50 }, workspaceBytes: 2048, totalBytes: 2248, partial: false, freeBytes: 10000, warn: false };
  const ok = sizeLines(base, "en");
  assert.match(ok, /5 versions, about 200 B\./);
  assert.match(ok, /About 2\.0 KB\./);
  assert.doesNotMatch(ok, /history-size-warning|history-size-partial/);
  const warn = sizeLines({ ...base, warn: true }, "es");
  assert.match(warn, /id="history-size-warning"/);
  assert.match(warn, /2\.2 KB/);
  const unknown = sizeLines({ ...base, cards: null, workspaceBytes: null, partial: true }, "en");
  assert.match(unknown, /could not be measured/);
  assert.match(unknown, /id="history-size-partial"/);
  assert.match(sizeLines({ ...base, workspaceBytes: 0 }, "en"), /Not used yet\./);
  assert.match(sizeLines(null, "en"), /could not be measured/);
});

test("without an injected free value the real data volume is measured", async () => {
  const dir = freshDir("statfs");
  const db = createDbClient(join(dir, "crow.db"));
  try {
    const fp = await historyFootprint(db, { tasksDbPath: join(dir, "none.db"), dataDir: dir });
    assert.ok(fp.freeBytes > 0, `expected a positive free-space figure, got ${fp.freeBytes}`);
  } finally {
    db.close();
  }
});
