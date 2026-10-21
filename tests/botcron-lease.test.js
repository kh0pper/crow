import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { holdBotcronLease, releaseBotcronLease } from "../scripts/pi-bots/botcron-lease.mjs";

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
