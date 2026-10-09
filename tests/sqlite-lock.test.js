// R2-H2: the OS-released cross-process lock (servers/shared/sqlite-lock.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSqliteLock } from "../servers/shared/sqlite-lock.js";

const CHILD = new URL("./fixtures/sqlite-lock-child.mjs", import.meta.url).pathname;
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.on("exit", () => resolve(out.trim()));
});

test("8 processes contending: never two inside at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-lock-"));
  try {
    const res = await Promise.all(Array.from({ length: 8 }, () => run(["contend", join(dir, "l.db"), join(dir, "inside"), "25"])));
    assert.deepEqual(res, Array(8).fill("ok"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a holder killed with SIGKILL mid-hold releases the lock (OS-released, no stale detection)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-lock-"));
  try {
    const lock = join(dir, "l.db");
    const p = spawn(process.execPath, [CHILD, "hold", lock], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((r) => p.stdout.on("data", (d) => { if (String(d).includes("held")) r(); }));
    await assert.rejects(withSqliteLock(lock, async () => {}, { timeoutMs: 300 }), (e) => e.code === "busy", "held by the child");
    p.kill("SIGKILL");
    await new Promise((r) => p.on("exit", r));
    const t0 = Date.now();
    assert.equal(await withSqliteLock(lock, async () => "mine", { timeoutMs: 2000 }), "mine");
    assert.ok(Date.now() - t0 < 1000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no pid anywhere (the reused-pid wedge cannot exist); two holders in ONE process are serialised too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-lock-"));
  try {
    const lock = join(dir, "l.db");
    await withSqliteLock(lock, async () => {});
    assert.doesNotMatch(readFileSync(lock).toString("latin1"), new RegExp(String(process.pid)), "the file holds no pid");
    let inside = 0, max = 0;
    await Promise.all(Array.from({ length: 4 }, () => withSqliteLock(lock, async () => { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 10)); inside--; })));
    assert.equal(max, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an empty lock file works; a corrupt one fails closed at once with lock_corrupt (never deleted)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-lock-"));
  try {
    const empty = join(dir, "empty.db"); writeFileSync(empty, "");
    assert.equal(await withSqliteLock(empty, async () => 1), 1);
    const bad = join(dir, "bad.db"); writeFileSync(bad, "this is not a database file at all, just text ".repeat(100));
    const t0 = Date.now();
    await assert.rejects(withSqliteLock(bad, async () => 1), (e) => e.code === "lock_corrupt");
    assert.ok(Date.now() - t0 < 1000, "no 30 s wedge");
    assert.match(readFileSync(bad, "utf8"), /not a database/, "left in place for the operator");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R3-L4: a WAL-mode lock file is refused with lock_wal (never a silent hard-failure mode)", async () => {
  const Database = (await import("better-sqlite3")).default;
  const dir = mkdtempSync(join(tmpdir(), "sqlite-lock-"));
  try {
    const p = join(dir, "wal.db");
    const d = new Database(p); d.pragma("journal_mode = WAL"); d.close();
    await assert.rejects(withSqliteLock(p, async () => 1), (e) => e.code === "lock_wal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
