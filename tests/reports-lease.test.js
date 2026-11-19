// The reports gateway lease: who may run reports on one crow.db, when a lease is stale, and why a
// race between two gateways can never let both through.
//
// Harness: a real init-db'd scratch crow.db copied per test, and every lease dep injected (clock, pid,
// pid liveness, kernel boot id, run id), so nothing here depends on the test machine's own clock or
// pids.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reports-lease-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = join(root, "master", "crow.db");

const { createDbClient } = await import("../servers/db.js");
const { LEASE_KEY, LEASE_STALE_MS, releaseLease, takeLease } = await import(
  "../servers/gateway/reports/lease.js"
);

const NOW = 1_700_000_000_000;
const BOOT = "boot-aaaa";

const open = [];

after(() => {
  for (const db of open) { try { db.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
});

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: join(root, "master") },
    stdio: "pipe",
    cwd: REPO,
  });
});

let n = 0;

async function freshDb() {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db");
  copyFileSync(MASTER, crow);
  const db = createDbClient(crow);
  open.push(db);
  return db;
}

/** Lease deps for one process. */
function leaseDeps(over = {}) {
  return {
    now: () => NOW,
    pid: 4242,
    isPidAlive: () => true,
    kernelBootId: () => BOOT,
    runId: "run-mine",
    ...over,
  };
}

async function storedLease(db) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [LEASE_KEY],
  });
  if (!rows[0]) return null;
  return JSON.parse(rows[0].value);
}

async function writeLease(db, lease) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [LEASE_KEY, JSON.stringify(lease)],
  });
}

test("an absent lease is taken, and the row says who holds it", async () => {
  const db = await freshDb();
  const result = await takeLease(db, leaseDeps());
  assert.deepEqual(result, { held: true, reason: "none" });
  assert.deepEqual(await storedLease(db), { runId: "run-mine", pid: 4242, kernelBootId: BOOT, at: NOW });
});

test("its own lease is refreshed on every call", async () => {
  const db = await freshDb();
  assert.equal((await takeLease(db, leaseDeps())).held, true);
  let clock = NOW;
  const again = await takeLease(db, leaseDeps({ now: () => (clock += LEASE_STALE_MS * 10) }));
  assert.deepEqual(again, { held: true, reason: "ours" }, "an aged lease of ours is still ours");
  assert.equal((await storedLease(db)).at, clock, "the refresh moved the timestamp");
});

test("a live lease held by another process is not taken", async () => {
  const db = await freshDb();
  await writeLease(db, { runId: "run-other", pid: 999, kernelBootId: BOOT, at: NOW - 1000 });
  const result = await takeLease(db, leaseDeps({ isPidAlive: () => true }));
  assert.deepEqual(result, { held: false, reason: "live" });
  assert.equal((await storedLease(db)).runId, "run-other", "the holder's lease is untouched");
});

test("a lease whose pid is gone is stale: an auto-update restart never leaves reports off", async () => {
  const db = await freshDb();
  await writeLease(db, { runId: "run-old", pid: 999, kernelBootId: BOOT, at: NOW - 30_000 });
  const seen = [];
  const result = await takeLease(db, leaseDeps({ isPidAlive: (pid) => { seen.push(pid); return false; } }));
  assert.deepEqual(result, { held: true, reason: "pid-gone" });
  assert.deepEqual(seen, [999], "it asked about the holder's pid");
  assert.equal((await storedLease(db)).runId, "run-mine");
});

test("a lease older than three minutes is stale even when its pid is alive", async () => {
  const db = await freshDb();
  await writeLease(db, { runId: "run-other", pid: 999, kernelBootId: BOOT, at: NOW - LEASE_STALE_MS - 1 });
  assert.deepEqual(await takeLease(db, leaseDeps({ isPidAlive: () => true })), { held: true, reason: "aged-out" });
});

test("a lease from another kernel boot is stale even when its pid is alive here", async () => {
  const db = await freshDb();
  await writeLease(db, { runId: "run-other", pid: 999, kernelBootId: "boot-before-reboot", at: NOW });
  assert.deepEqual(await takeLease(db, leaseDeps({ isPidAlive: () => true })), { held: true, reason: "other-boot" });
});

test("two gateways racing for an empty lease: only one wins", async () => {
  const db = await freshDb();
  let raced = false;
  // The other gateway writes the lease in the moment between this call's read and its write.
  const racingDb = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (!raced && /INSERT INTO dashboard_settings/.test(sql)) {
        raced = true;
        await writeLease(db, { runId: "run-other", pid: 999, kernelBootId: BOOT, at: NOW });
      }
      return db.execute(arg);
    },
  };
  const result = await takeLease(racingDb, leaseDeps());
  assert.deepEqual(result, { held: false, reason: "raced" }, "the guarded write changed no row");
  assert.equal((await storedLease(db)).runId, "run-other", "the winner's lease stands");
});

test("a lease written under our own pid but another run id is stale: a restart reused the pid", async () => {
  const db = await freshDb();
  // A container restart (or a supervisor that hands out the same pid again) leaves a lease whose pid is
  // this process's number and whose run id is a dead one. The pid being alive says nothing about that
  // holder, so the lease must read stale.
  await writeLease(db, { runId: "run-run-previous", pid: 4242, kernelBootId: BOOT, at: NOW });
  const result = await takeLease(db, leaseDeps({ isPidAlive: () => true }));
  assert.deepEqual(result, { held: true, reason: "same-pid" });
  assert.equal((await storedLease(db)).runId, "run-mine");
});

test("two passes refreshing our own lease at once both report it held", async () => {
  const db = await freshDb();
  assert.deepEqual(await takeLease(db, leaseDeps()), { held: true, reason: "none" });
  // The second call's guarded write changes no row (the first already wrote this clock's value), and
  // the row still names this process, so that is not a lost race: the lease is held.
  const [first, second] = await Promise.all([
    takeLease(db, leaseDeps()),
    takeLease(db, leaseDeps()),
  ]);
  assert.equal(first.held, true);
  assert.deepEqual(second, { held: true, reason: "ours" }, "a lost write on our own lease is still ours");
  assert.equal((await storedLease(db)).runId, "run-mine");
});

test("release removes the lease only when it is ours", async () => {
  const db = await freshDb();
  await writeLease(db, { runId: "run-other", pid: 999, kernelBootId: BOOT, at: NOW });
  assert.equal(await releaseLease(db, leaseDeps()), false, "another process's lease is not ours to drop");
  assert.equal((await storedLease(db)).runId, "run-other");

  await writeLease(db, { runId: "run-mine", pid: 4242, kernelBootId: BOOT, at: NOW });
  assert.equal(await releaseLease(db, leaseDeps()), true);
  assert.equal(await storedLease(db), null);
  assert.equal(await releaseLease(db, leaseDeps()), false, "nothing left to release");
});

test("a stored value that is not a lease is treated as no lease", async () => {
  const db = await freshDb();
  await writeLease(db, "not-an-object");
  assert.deepEqual(await takeLease(db, leaseDeps()), { held: true, reason: "none" });
});

test("the real pid and boot-id readers answer without throwing", async () => {
  const db = await freshDb();
  // No pid / kernelBootId / runId injected: the module's own readers run.
  const result = await takeLease(db, { now: () => NOW, isPidAlive: () => true });
  assert.equal(result.held, true);
  const stored = await storedLease(db);
  assert.equal(stored.pid, process.pid);
  assert.equal(typeof stored.kernelBootId === "string" || stored.kernelBootId === null, true);
  assert.match(stored.runId, /^[0-9a-f]{32}$/, "the process's own gateway run id");
});

test("the default pid check counts this process as alive, a free pid as gone, and EPERM as alive", async () => {
  const db = await freshDb();
  const { takeLease: take } = await import("../servers/gateway/reports/lease.js");
  // A live lease held by a DIFFERENT pid (this box's init process is alive whatever the test runs as).
  await writeLease(db, { runId: "run-other", pid: 1, kernelBootId: "whatever-boot", at: NOW });
  const bootNow = await take(db, { now: () => NOW, pid: 4242, runId: "run-mine", kernelBootId: () => "whatever-boot" });
  assert.deepEqual(bootNow, { held: false, reason: "live" });

  // Our own pid under another run id: the number was reused, so the holder is gone (see the same-pid
  // rule above); the run id, never the pid alone, is what says "this is me".
  await writeLease(db, { runId: "run-other", pid: process.pid, kernelBootId: "whatever-boot", at: NOW });
  const reused = await take(db, { now: () => NOW, runId: "run-mine", kernelBootId: () => "whatever-boot" });
  assert.deepEqual(reused, { held: true, reason: "same-pid" });

  // A pid that cannot exist here: gone, so the lease is taken.
  await writeLease(db, { runId: "run-other", pid: 2_147_483_646, kernelBootId: "whatever-boot", at: NOW });
  const gonePid = await take(db, { now: () => NOW, runId: "run-mine", kernelBootId: () => "whatever-boot" });
  assert.equal(gonePid.held, true);
});