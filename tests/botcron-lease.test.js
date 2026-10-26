import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { holdBotcronLease, releaseBotcronLease, tryBotcronLease, createBotcronTicker, botcronLeaseHeld } from "../scripts/pi-bots/botcron-lease.mjs";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "botcron-lease-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const leaseFile = () => join(dir, "botcron-ticker.lease.json");

test("first holder wins, a second holder within the TTL loses", async () => {
  assert.equal(await holdBotcronLease({ dir, holder: "a", now: 1000 }), true);
  assert.equal(await holdBotcronLease({ dir, holder: "b", now: 2000 }), false);
  const l = JSON.parse(readFileSync(leaseFile(), "utf8"));
  assert.equal(l.holder, "a");
  assert.equal(l.expires_at, 1000 + 180000);
  assert.equal(typeof l.pid, "number");
});

test("a second holder wins once the TTL has passed", async () => {
  await holdBotcronLease({ dir, holder: "a", now: 1000, ttlMs: 5000 });
  assert.equal(await holdBotcronLease({ dir, holder: "b", now: 6001, ttlMs: 5000 }), true);
});

test("a holder renews its own lease", async () => {
  await holdBotcronLease({ dir, holder: "a", now: 1000, ttlMs: 5000 });
  assert.equal(await holdBotcronLease({ dir, holder: "a", now: 4000, ttlMs: 5000 }), true);
  assert.equal(JSON.parse(readFileSync(leaseFile(), "utf8")).expires_at, 9000);
  assert.equal(await holdBotcronLease({ dir, holder: "b", now: 8000, ttlMs: 5000 }), false);
});

test("release by a non-holder is a no-op; by the holder frees the lease", async () => {
  await holdBotcronLease({ dir, holder: "a", now: 1000 });
  await releaseBotcronLease({ dir, holder: "b" });
  assert.equal(await holdBotcronLease({ dir, holder: "b", now: 2000 }), false);
  await releaseBotcronLease({ dir, holder: "a" });
  assert.equal(await holdBotcronLease({ dir, holder: "b", now: 2000 }), true);
});

test("a corrupt lease counts as expired", async () => {
  writeFileSync(leaseFile(), "{not json");
  assert.equal(await holdBotcronLease({ dir, holder: "a", now: 1000 }), true);
});

test("a busy lock returns false without throwing", async () => {
  const held = new Database(join(dir, "botcron-ticker.lock"));
  held.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(await holdBotcronLease({ dir, holder: "a", now: 1000, lockTimeoutMs: 100 }), false);
  } finally { held.exec("COMMIT"); held.close(); }
});

test("a lock file that is not a database is an error, not \"another holder\"; the ticker logs it once and logs recovery", async () => {
  writeFileSync(join(dir, "botcron-ticker.lock"), "this is not a sqlite database, just some text padding it out ".repeat(20));
  const r = await tryBotcronLease({ dir, holder: "a" });
  assert.equal(r.held, false);
  assert.match(r.error, /not a database/);
  assert.equal(await holdBotcronLease({ dir, holder: "a" }), false);

  const lines = [];
  const t = createBotcronTicker({ dir, holder: "a", log: (m) => lines.push(m), _tick: () => ({ fired: 0 }) });
  assert.equal((await t.sweep()).held, false);
  await t.sweep();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^cannot take the bot-cron lease: .*not a database.*; scheduled bot runs are paused on this instance$/);
  assert.ok(!lines.some((l) => l.startsWith("lease lost")));

  unlinkSync(join(dir, "botcron-ticker.lock"));
  assert.equal((await t.sweep()).held, true);
  assert.deepEqual(lines.slice(1).map((l) => l.split(";")[0].split(",")[0]), ["the bot-cron lease can be taken again", "lease acquired"]);
});

test("a read-only data dir is an error the ticker reports, never \"lease lost\"", { skip: process.getuid && process.getuid() === 0 ? "root ignores directory modes" : false }, async () => {
  const ro = join(dir, "ro");
  mkdirSync(ro);
  chmodSync(ro, 0o555);
  try {
    const r = await tryBotcronLease({ dir: ro, holder: "a" });
    assert.equal(r.held, false);
    assert.ok(r.error, "an error message is returned");
    const lines = [];
    const t = createBotcronTicker({ dir: ro, holder: "a", log: (m) => lines.push(m), _tick: () => ({ fired: 0 }) });
    await t.sweep(); await t.sweep();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^cannot take the bot-cron lease: /);
  } finally { chmodSync(ro, 0o755); }
});

test("the ticker passes its own last successful sweep time as aliveAt (null on the first sweep)", async () => {
  const seen = [];
  let fail = false;
  const t = createBotcronTicker({
    dir, holder: "h", _hold: async () => true, _release: async () => {},
    _tick: ({ aliveAt }) => { seen.push(aliveAt); if (fail) throw new Error("x"); return { fired: 0 }; },
  });
  const before = Date.now();
  await t.sweep();
  await t.sweep();
  fail = true; await t.sweep();
  fail = false; await t.sweep();
  assert.equal(seen[0], null);
  assert.ok(seen[1] >= before && seen[1] <= Date.now());
  assert.equal(seen[3], seen[2], "a failed sweep does not move aliveAt");
});

test("the ticker passes max(2 min, its poll interval) as the heartbeat slack", async () => {
  const seen = [];
  const mk = (pollMs) => createBotcronTicker({
    dir, holder: "h", pollMs, _hold: async () => true, _release: async () => {},
    _tick: ({ aliveSlackMs }) => { seen.push(aliveSlackMs); return { fired: 0 }; },
  });
  await mk(60000).sweep();
  await mk(600000).sweep();
  await mk(undefined).sweep();
  assert.deepEqual(seen, [120000, 600000, 120000]);
});

test("botcronLeaseHeld (read-only): missing, expired or dead-pid → false; live → true", async () => {
  const { spawnSync } = await import("node:child_process");
  assert.equal(botcronLeaseHeld({ dir }), false, "missing");
  writeFileSync(leaseFile(), JSON.stringify({ holder: "g", pid: process.pid, expires_at: Date.now() - 1 }));
  assert.equal(botcronLeaseHeld({ dir }), false, "expired");
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  writeFileSync(leaseFile(), JSON.stringify({ holder: "g", pid: dead, expires_at: Date.now() + 60000 }));
  assert.equal(botcronLeaseHeld({ dir }), false, "dead pid");
  writeFileSync(leaseFile(), JSON.stringify({ holder: "g", pid: process.pid, expires_at: Date.now() + 60000 }));
  assert.equal(botcronLeaseHeld({ dir }), true, "live");
  writeFileSync(leaseFile(), "{oops");
  assert.equal(botcronLeaseHeld({ dir }), false, "corrupt");
});
