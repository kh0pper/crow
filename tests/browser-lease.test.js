/**
 * The shared browser lease (servers/shared/browser-lease.js): one advisory
 * lease file that bots' browser MCP servers and the gateway use to take turns
 * on the one shared page. The lease directory is bot-writable, so these tests
 * also plant hostile content (oversized, malformed, symlinks, stale locks).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, utimesSync,
  existsSync, lstatSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  leaseDir, readLease, acquire, beginCall, endCall, release,
  takeOperator, handBack, heartbeat, isFree, renewIfHeld,
} from "../servers/shared/browser-lease.js";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", "servers", "shared", "browser-lease.js");
const LEASE = "browser-lease.json";
const LOCK = "lease.lock";
const T0 = 1_800_000_000_000;

function tmp() {
  const root = mkdtempSync(join(tmpdir(), "browser-lease-"));
  const dir = join(root, "browser-lease");
  mkdirSync(dir, { mode: 0o700 });
  return { root, dir };
}
const bot = (sessionId, botId = "bot-" + sessionId) => ({ kind: "bot", sessionId, botId });
const alive = () => true;
const dead = () => false;

test("leaseDir resolves the browser-lease state dir", () => {
  assert.equal(leaseDir((n) => "/state/" + n), "/state/browser-lease");
});

test("acquire on a free lease takes it and bumps gen", async () => {
  const { dir } = tmp();
  assert.equal(await readLease(dir), null);
  const r = await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000 });
  assert.equal(r.ok, true);
  assert.equal(r.lease.gen, 1);
  assert.deepEqual(r.lease.holder, { kind: "bot", sessionId: "s1", botId: "bot-s1" });
  assert.deepEqual(r.lease.inCall, []);
  assert.equal(r.lease.releaseOnCallEnd, false);
  assert.equal(r.lease.since, T0);
  assert.equal(r.lease.renewedAt, T0);
  assert.equal(r.lease.ttlMs, 120000);
  assert.equal(r.genChanged, false);
  assert.deepEqual((await readLease(dir)).holder, r.lease.holder);
});

test("same session renews without bumping gen", async () => {
  const { dir } = tmp();
  await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000 });
  const r = await acquire(dir, bot("s1"), { now: T0 + 5000, ttlMs: 120000 });
  assert.equal(r.ok, true);
  assert.equal(r.lease.gen, 1);
  assert.equal(r.lease.since, T0);
  assert.equal(r.lease.renewedAt, T0 + 5000);
  assert.equal(r.genChanged, false);
});

test("another bot gets busy", async () => {
  const { dir } = tmp();
  await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000 });
  const r = await acquire(dir, bot("s2"), { now: T0 + 1000, ttlMs: 120000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "busy");
  assert.equal(r.lease.holder.sessionId, "s1");
  assert.equal((await readLease(dir)).holder.sessionId, "s1");
});

test("operator holds → reason operator", async () => {
  const { dir } = tmp();
  const op = await takeOperator(dir, { now: T0 });
  assert.equal(op.holder.kind, "operator");
  const r = await acquire(dir, bot("s1"), { now: T0 + 1000, ttlMs: 120000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "operator");
  // The operator's heartbeat keeps it; hand back frees it.
  const hb = await heartbeat(dir, { now: T0 + 200000 });
  assert.equal(hb.renewedAt, T0 + 200000);
  assert.equal((await acquire(dir, bot("s1"), { now: T0 + 400000, ttlMs: 120000 })).reason, "operator");
  const back = await handBack(dir);
  assert.equal(back.holder, null);
  assert.equal((await acquire(dir, bot("s1"), { now: T0 + 400001, ttlMs: 120000 })).ok, true);
});

test("stale lease is free after ttl", async () => {
  const { dir } = tmp();
  await acquire(dir, bot("external:4242"), { now: T0, ttlMs: 120000 });
  const early = await acquire(dir, bot("s2"), { now: T0 + 120000, ttlMs: 120000 });
  assert.equal(early.ok, false, "not expired at exactly the ttl");
  const r = await acquire(dir, bot("s2"), { now: T0 + 120001, ttlMs: 120000 });
  assert.equal(r.ok, true);
  assert.equal(r.lease.holder.sessionId, "s2");
  assert.equal(r.lease.gen, 2);
  assert.equal(r.genChanged, true);
});

test("genChanged is true after another holder had it", async () => {
  const { dir } = tmp();
  await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000 });
  assert.equal(await release(dir, "s1", { isAlive: alive, now: T0 + 10 }), "released");
  // The same session coming back with nobody in between: no change.
  const again = await acquire(dir, bot("s1"), { now: T0 + 20, ttlMs: 120000 });
  assert.equal(again.genChanged, false);
  assert.equal(again.lease.gen, 1);
  await release(dir, "s1", { isAlive: alive, now: T0 + 30 });

  const b = await acquire(dir, bot("s2"), { now: T0 + 40, ttlMs: 120000 });
  assert.equal(b.genChanged, true);
  assert.equal(b.lease.gen, 2);
  await release(dir, "s2", { isAlive: alive, now: T0 + 50 });

  const a = await acquire(dir, bot("s1"), { now: T0 + 60, ttlMs: 120000 });
  assert.equal(a.genChanged, true);
  assert.equal(a.lease.gen, 3);

  // The operator taking it and handing back also counts.
  await takeOperator(dir, { now: T0 + 70 });
  await handBack(dir);
  const a2 = await acquire(dir, bot("s1"), { now: T0 + 80, ttlMs: 120000 });
  assert.equal(a2.genChanged, true);
  assert.equal(a2.lease.gen, 5);
});

test("release defers while a live pid is in a call, then endCall releases", async () => {
  const { dir } = tmp();
  const h = bot("s1");
  await acquire(dir, h, { now: T0, ttlMs: 120000 });
  const l1 = await beginCall(dir, h, { callId: "c1", pid: 5001, targetId: "T-1", now: T0 + 1 });
  assert.deepEqual(l1.inCall, [{ callId: "c1", pid: 5001 }]);
  assert.equal(l1.targetId, "T-1");
  assert.equal(await release(dir, "s1", { isAlive: alive, now: T0 + 2 }), "deferred");
  const mid = await readLease(dir);
  assert.equal(mid.releaseOnCallEnd, true);
  assert.equal(mid.holder.sessionId, "s1");
  assert.equal((await acquire(dir, bot("s2"), { now: T0 + 3, ttlMs: 120000 })).reason, "busy");
  const after = await endCall(dir, h, { callId: "c1", now: T0 + 4 });
  assert.equal(after.holder, null);
  assert.deepEqual(after.inCall, []);
  assert.equal(after.releaseOnCallEnd, false);
  assert.equal((await acquire(dir, bot("s2"), { now: T0 + 5, ttlMs: 120000 })).ok, true);
});

test("endCall without a pending release keeps the lease", async () => {
  const { dir } = tmp();
  const h = bot("s1");
  await acquire(dir, h, { now: T0, ttlMs: 120000 });
  await beginCall(dir, h, { callId: "c1", pid: 5001, targetId: "T-1", now: T0 + 1 });
  await beginCall(dir, h, { callId: "c2", pid: 5002, now: T0 + 2 });
  const l = await endCall(dir, h, { callId: "c1", now: T0 + 3 });
  assert.equal(l.holder.sessionId, "s1");
  assert.deepEqual(l.inCall, [{ callId: "c2", pid: 5002 }]);
  assert.equal(l.targetId, "T-1");
});

test("renewIfHeld renews only a live holding of this holder, never takes one", async () => {
  const { dir } = tmp();
  assert.equal(await renewIfHeld(dir, bot("s1"), { now: T0 }), null, "free: nothing taken");
  assert.equal(await readLease(dir), null);
  const r = await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000 });
  await beginCall(dir, bot("s1"), { callId: "c1", pid: 5001, now: T0 + 1 });
  const l = await renewIfHeld(dir, bot("s1"), { now: T0 + 10000 });
  assert.equal(l.renewedAt, T0 + 10000);
  assert.equal(l.gen, r.lease.gen, "no gen bump");
  assert.deepEqual(l.inCall, [{ callId: "c1", pid: 5001 }], "in-flight calls kept");
  assert.equal(await renewIfHeld(dir, bot("s2"), { now: T0 + 10001 }), null, "another holder's lease is untouched");
  assert.equal((await readLease(dir)).holder.sessionId, "s1");
  assert.equal(await renewIfHeld(dir, bot("s1"), { now: T0 + 10000 + 120001 }), null, "expired: not revived");
  await release(dir, "s1", { isAlive: dead, now: T0 + 20000 });
  assert.equal(await renewIfHeld(dir, bot("s1"), { now: T0 + 20001 }), null, "released: not re-taken");
  assert.equal((await readLease(dir)).holder, null);
  await takeOperator(dir, { now: T0 + 30000 });
  assert.equal(await renewIfHeld(dir, bot("s1"), { now: T0 + 30001 }), null);
  assert.equal((await readLease(dir)).holder.kind, "operator");
});

test("a dead pid releases at once", async () => {
  const { dir } = tmp();
  const h = bot("s1");
  await acquire(dir, h, { now: T0, ttlMs: 120000 });
  await beginCall(dir, h, { callId: "c1", pid: 5001, now: T0 + 1 });
  assert.equal(await release(dir, "s1", { isAlive: dead, now: T0 + 2 }), "released");
  assert.equal((await readLease(dir)).holder, null);
});

test("orphan cap 120 s releases", async () => {
  const { dir } = tmp();
  const h = bot("s1");
  await acquire(dir, h, { now: T0, ttlMs: 120000 });
  await beginCall(dir, h, { callId: "c1", pid: 5001, now: T0 });
  assert.equal(await release(dir, "s1", { isAlive: alive, now: T0 + 1000 }), "deferred");
  assert.equal(await release(dir, "s1", { isAlive: alive, now: T0 + 119000 }), "deferred");
  assert.equal(await release(dir, "s1", { isAlive: alive, now: T0 + 120001 }), "released");
  assert.equal((await readLease(dir)).holder, null);
  assert.equal(await release(dir, "s1", { isAlive: alive, now: T0 + 120002 }), "none");
  assert.equal(await release(dir, "nobody", { isAlive: alive, now: T0 }), "none");
});

test("an over-4KB or malformed lease reads as free", async () => {
  const { dir } = tmp();
  const good = (await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000 })).lease;
  const big = { ...good, pad: "x".repeat(5000) };
  writeFileSync(join(dir, LEASE), JSON.stringify(big));
  assert.equal(await readLease(dir), null);
  const bad = [
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...good, gen: -1 }),
    JSON.stringify({ ...good, gen: "1" }),
    JSON.stringify({ ...good, holder: { kind: "root", sessionId: "s1" } }),
    JSON.stringify({ ...good, holder: { kind: "bot", sessionId: "../x" } }),
    JSON.stringify({ ...good, inCall: [{ callId: "c", pid: -3 }] }),
    JSON.stringify({ ...good, inCall: "c1" }),
    JSON.stringify({ ...good, releaseOnCallEnd: "yes" }),
    JSON.stringify({ ...good, ttlMs: 1e15 }),
    JSON.stringify({ ...good, renewedAt: null }),
  ];
  for (const text of bad) {
    writeFileSync(join(dir, LEASE), text);
    assert.equal(await readLease(dir), null, text.slice(0, 80));
    // ...and a writer treats it as free.
    const r = await acquire(dir, bot("s2"), { now: T0 + 1, ttlMs: 120000 });
    assert.equal(r.ok, true, text.slice(0, 80));
  }
  // Only schema fields come back.
  writeFileSync(join(dir, LEASE), JSON.stringify({ ...good, extra: "drop me" }));
  assert.equal("extra" in (await readLease(dir)), false);
  // A missing dir is free too.
  assert.equal(await readLease(join(dir, "nope")), null);
});

test("a planted symlink at the lease or temp name is never followed", async () => {
  const { root, dir } = tmp();
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "precious");
  symlinkSync(outside, join(dir, LEASE));
  assert.equal(await readLease(dir), null, "a symlinked lease is not read");
  const r = await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000 });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(outside, "utf8"), "precious");
  assert.equal(lstatSync(join(dir, LEASE)).isSymbolicLink(), false, "the link itself was replaced");

  // A symlinked lock (pointing outside) is never written through; once stale it is removed, not its target.
  rmSync(join(dir, LEASE));
  symlinkSync(outside, join(dir, LOCK));
  const old = new Date(Date.now() - 60000);
  const { lutimesSync } = await import("node:fs");
  lutimesSync(join(dir, LOCK), old, old);
  const r2 = await acquire(dir, bot("s2"), { now: T0, ttlMs: 120000, isAlive: dead });
  assert.equal(r2.ok, true);
  assert.equal(readFileSync(outside, "utf8"), "precious");
  assert.equal(existsSync(join(dir, LOCK)), false);

  // The lease dir itself as a symlink is refused for writes and reads as free.
  const real = join(root, "elsewhere");
  mkdirSync(real);
  const linked = join(root, "linked-lease");
  symlinkSync(real, linked);
  assert.equal(await readLease(linked), null);
  await assert.rejects(acquire(linked, bot("s3"), { now: T0, ttlMs: 120000 }));
  assert.equal(existsSync(join(real, LEASE)), false);
});

test("a stale lock is broken only when its pid is dead", async () => {
  const { dir } = tmp();
  const old = new Date(Date.now() - 10000);
  writeFileSync(join(dir, LOCK), "999999\n");
  utimesSync(join(dir, LOCK), old, old);
  // Old but its pid is alive: never broken.
  await assert.rejects(
    acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: alive, lockTimeoutMs: 150 }),
    (e) => e.code === "ELEASELOCKED",
  );
  assert.equal(readFileSync(join(dir, LOCK), "utf8"), "999999\n");
  // Fresh with a dead pid: not yet (under 5 s).
  writeFileSync(join(dir, LOCK), "999999\n");
  await assert.rejects(
    acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: dead, lockTimeoutMs: 150 }),
    (e) => e.code === "ELEASELOCKED",
  );
  // Old and dead: broken.
  utimesSync(join(dir, LOCK), old, old);
  let asked = null;
  const r = await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: (pid) => { asked = pid; return false; } });
  assert.equal(r.ok, true);
  assert.equal(asked, 999999);
  assert.equal(existsSync(join(dir, LOCK)), false, "our own lock is gone after the write");
});

test("a lock reused at the same inode between check and unlink is not broken", async () => {
  const { dir } = tmp();
  const lock = join(dir, LOCK);
  const old = new Date(Date.now() - 10000);
  writeFileSync(lock, "999999\n");
  utimesSync(lock, old, old);
  const ino = lstatSync(lock).ino;
  let fired = 0;
  // Another breaker removed the stale lock and its fresh lock landed on the same inode:
  // simulated by rewriting the file in place (same dev/ino, new mtime/ctime).
  const reuse = () => { if (fired++ === 0) writeFileSync(lock, "123456\n"); };
  await assert.rejects(
    acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: dead, lockTimeoutMs: 150, _onBeforeBreak: reuse }),
    (e) => e.code === "ELEASELOCKED",
  );
  assert.equal(fired, 1);
  assert.equal(lstatSync(lock).ino, ino);
  assert.equal(readFileSync(lock, "utf8"), "123456\n", "the fresh lock survives");
});

test("forceBreakAfterMs breaks an old lock whatever its pid", async () => {
  const { dir } = tmp();
  const lock = join(dir, LOCK);
  writeFileSync(lock, "1\n");
  const tenAgo = new Date(Date.now() - 10000);
  utimesSync(lock, tenAgo, tenAgo);
  await assert.rejects(
    acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: alive, forceBreakAfterMs: 30000, lockTimeoutMs: 150 }),
    (e) => e.code === "ELEASELOCKED",
    "under the force threshold a live pid still holds",
  );
  const fortyAgo = new Date(Date.now() - 40000);
  utimesSync(lock, fortyAgo, fortyAgo);
  const r = await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: alive, forceBreakAfterMs: 30000 });
  assert.equal(r.ok, true);
  assert.equal(existsSync(lock), false);
  // Every write function takes the option.
  writeFileSync(lock, "1\n");
  utimesSync(lock, fortyAgo, fortyAgo);
  const l = await heartbeat(dir, { now: T0, isAlive: alive, forceBreakAfterMs: 30000 });
  assert.equal(l.holder.sessionId, "s1");
});

test("a lock planted with a future mtime is stale and force-breakable", async () => {
  const { dir } = tmp();
  const lock = join(dir, LOCK);
  writeFileSync(lock, "1\n");
  const future = new Date(Date.now() + 3600000);
  utimesSync(lock, future, future);
  // Not forced: stale, but its pid is alive, so it holds.
  await assert.rejects(
    acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: alive, lockTimeoutMs: 150 }),
    (e) => e.code === "ELEASELOCKED",
  );
  // Dead pid: broken as stale.
  assert.equal((await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: dead })).ok, true);
  // Forced: broken whatever its pid.
  writeFileSync(lock, "1\n");
  utimesSync(lock, future, future);
  assert.equal((await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: alive, forceBreakAfterMs: 30000 })).ok, true);
  assert.equal(existsSync(lock), false);
});

test("a planted directory at the lock name gives ELEASELOCKED, and a forced break removes it only when empty", async () => {
  const { dir } = tmp();
  const lock = join(dir, LOCK);
  const old = new Date(Date.now() - 60000);
  mkdirSync(lock);
  writeFileSync(join(lock, "keep"), "x");
  utimesSync(lock, old, old);
  for (const opts of [{ isAlive: dead }, { isAlive: alive, forceBreakAfterMs: 30000 }]) {
    await assert.rejects(
      acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, lockTimeoutMs: 150, ...opts }),
      (e) => e.code === "ELEASELOCKED",
    );
  }
  assert.equal(readFileSync(join(lock, "keep"), "utf8"), "x", "never recursive");
  // Empty: unforced still leaves it, forced removes it.
  rmSync(join(lock, "keep"));
  utimesSync(lock, old, old);
  await assert.rejects(
    acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, lockTimeoutMs: 150, isAlive: dead }),
    (e) => e.code === "ELEASELOCKED",
  );
  assert.equal((await acquire(dir, bot("s1"), { now: T0, ttlMs: 120000, isAlive: alive, forceBreakAfterMs: 30000 })).ok, true);
  assert.equal(existsSync(lock), false);
});

test("endCall on an expired lease drops the call without renewing it", async () => {
  const { dir } = tmp();
  const h = bot("s1");
  await acquire(dir, h, { now: T0, ttlMs: 120000 });
  await beginCall(dir, h, { callId: "c1", pid: 5001, now: T0 });
  const l = await endCall(dir, h, { callId: "c1", now: T0 + 200000 });
  assert.deepEqual(l.inCall, []);
  assert.equal(l.renewedAt, T0);
  assert.equal(isFree(await readLease(dir), T0 + 200000), true);
  assert.equal((await acquire(dir, bot("s2"), { now: T0 + 200001, ttlMs: 120000 })).ok, true);
});

test("release never frees an operator holding", async () => {
  const { dir } = tmp();
  await takeOperator(dir, { now: T0 });
  assert.equal(await release(dir, "operator", { isAlive: alive, now: T0 + 1 }), "none");
  assert.equal((await readLease(dir)).holder.kind, "operator");
  assert.equal((await handBack(dir)).holder, null);
});

test("concurrent acquirers: exactly one wins", async () => {
  const N = 6;
  for (let round = 0; round < 3; round++) {
    const { dir } = tmp();
    const startAt = Date.now() + 400;
    const script = `
      const m = await import(${JSON.stringify(pathToFileURL(MODULE).href)});
      const [dir, sid, startAt] = process.argv.slice(1);
      while (Date.now() < Number(startAt)) {}
      const r = await m.acquire(dir, { kind: "bot", sessionId: sid, botId: null }, { ttlMs: 120000 });
      process.stdout.write(JSON.stringify({ sid, ok: r.ok }));
    `;
    const runs = Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, "racer" + i, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${i} exited ${code}: ${err}`)));
    }));
    const results = await Promise.all(runs);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    const lease = await readLease(dir);
    assert.equal(lease.holder.sessionId, winners[0].sid);
    assert.equal(lease.gen, 1);
    assert.equal(existsSync(join(dir, LOCK)), false);
  }
});
