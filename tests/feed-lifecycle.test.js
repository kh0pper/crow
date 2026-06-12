/**
 * Tests for W4-4 commit 1: Hypercore feed lifecycle (close-on-revoke).
 *
 * Uses stub feed objects (close() tracking) rather than real Hypercores to
 * keep the test in-process and free of FD/disk overhead. The load-bearing
 * invariants under test are:
 *   - closeContactFeeds: closes + removes both out and in feeds for a contact
 *   - closeContactFeeds: serialized through _initLocks tail (S2)
 *   - closeInstanceFeeds: closes + removes both out and in feeds for an instance
 *   - closeInstanceFeeds: serialized through _initLocks tail (S2)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncManager } from "../servers/sharing/sync.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";

// Minimal stub feed — tracks close() calls; never throws.
function stubFeed() {
  let closeCalls = 0;
  return {
    get closeCalls() { return closeCalls; },
    async close() { closeCalls++; },
  };
}

// Minimal identity stub (SyncManager stores it but doesn't use it in close paths).
const IDENTITY = { crowId: "test-crow-id" };

// Minimal db stub (InstanceSyncManager stores it but doesn't use it in close paths).
const DB_STUB = {};

// ── SyncManager tests ─────────────────────────────────────────────────────────

test("closeContactFeeds: closes both out and in feeds, clears Map entries", async () => {
  const sm = new SyncManager(IDENTITY);
  const out = stubFeed();
  const inn = stubFeed();
  sm.outFeeds.set(42, out);
  sm.inFeeds.set(42, inn);

  await sm.closeContactFeeds(42);

  assert.equal(out.closeCalls, 1, "outFeed.close() called once");
  assert.equal(inn.closeCalls, 1, "inFeed.close() called once");
  assert.equal(sm.outFeeds.has(42), false, "outFeeds entry removed");
  assert.equal(sm.inFeeds.has(42), false, "inFeeds entry removed");
});

test("closeContactFeeds: no-ops gracefully when contact has no feeds", async () => {
  const sm = new SyncManager(IDENTITY);
  // Should not throw even if no feeds exist for the contact.
  await sm.closeContactFeeds(99);
  assert.equal(sm.outFeeds.size, 0);
  assert.equal(sm.inFeeds.size, 0);
});

test("closeContactFeeds: only removes target contact, leaves others intact", async () => {
  const sm = new SyncManager(IDENTITY);
  const out1 = stubFeed(); const in1 = stubFeed();
  const out2 = stubFeed(); const in2 = stubFeed();
  sm.outFeeds.set(1, out1); sm.inFeeds.set(1, in1);
  sm.outFeeds.set(2, out2); sm.inFeeds.set(2, in2);

  await sm.closeContactFeeds(1);

  assert.equal(out1.closeCalls, 1, "contact 1 out closed");
  assert.equal(in1.closeCalls, 1, "contact 1 in closed");
  assert.equal(sm.outFeeds.has(1), false, "contact 1 out removed");
  assert.equal(sm.inFeeds.has(1), false, "contact 1 in removed");
  assert.equal(sm.outFeeds.has(2), true, "contact 2 out still present");
  assert.equal(sm.inFeeds.has(2), true, "contact 2 in still present");
  assert.equal(out2.closeCalls, 0, "contact 2 out not closed");
  assert.equal(in2.closeCalls, 0, "contact 2 in not closed");
});

test("closeContactFeeds: serialized — second call awaits first via _initLocks", async () => {
  const sm = new SyncManager(IDENTITY);

  // Inject a slow-closing feed to verify serialization.
  // Use a barrier-promise: the feed's close() signals when it starts, then
  // waits for an external release before completing.
  let resolveRelease;
  const releaseBarrier = new Promise((r) => { resolveRelease = r; });
  const closeStarted = new Promise((r) => {
    sm.outFeeds.set(10, {
      async close() {
        r(); // signal "started"
        await releaseBarrier; // wait for external release
      },
    });
  });

  // Start first close (holds at the barrier).
  const p1 = sm.closeContactFeeds(10);
  // Wait until close() is actually called.
  await closeStarted;

  // Now inject a second feed — p2 must not race with p1.
  const in2 = stubFeed();
  sm.inFeeds.set(10, in2);

  // Start second close — must be queued behind p1 (won't run until p1's close resolves).
  const p2 = sm.closeContactFeeds(10);

  // Release the first close.
  resolveRelease();
  await p1;
  await p2;

  // After serialization, the second close should have seen and cleared in2.
  assert.equal(in2.closeCalls, 1, "second close ran after first completed");
  assert.equal(sm.outFeeds.has(10), false, "outFeeds cleared");
  assert.equal(sm.inFeeds.has(10), false, "inFeeds cleared");
});

// ── InstanceSyncManager tests ─────────────────────────────────────────────────

test("closeInstanceFeeds: closes both out and in feeds, clears Map entries", async () => {
  const ism = new InstanceSyncManager(IDENTITY, DB_STUB, "local-inst");
  const out = stubFeed();
  const inn = stubFeed();
  const remoteId = "remote-inst-abc";
  ism.outFeeds.set(remoteId, out);
  ism.inFeeds.set(remoteId, inn);

  await ism.closeInstanceFeeds(remoteId);

  assert.equal(out.closeCalls, 1, "outFeed.close() called once");
  assert.equal(inn.closeCalls, 1, "inFeed.close() called once");
  assert.equal(ism.outFeeds.has(remoteId), false, "outFeeds entry removed");
  assert.equal(ism.inFeeds.has(remoteId), false, "inFeeds entry removed");
});

test("closeInstanceFeeds: no-ops gracefully when instance has no feeds", async () => {
  const ism = new InstanceSyncManager(IDENTITY, DB_STUB, "local-inst");
  await ism.closeInstanceFeeds("nonexistent");
  assert.equal(ism.outFeeds.size, 0);
  assert.equal(ism.inFeeds.size, 0);
});

test("closeInstanceFeeds: only removes target instance, leaves others intact", async () => {
  const ism = new InstanceSyncManager(IDENTITY, DB_STUB, "local-inst");
  const out1 = stubFeed(); const in1 = stubFeed();
  const out2 = stubFeed(); const in2 = stubFeed();
  ism.outFeeds.set("inst-a", out1); ism.inFeeds.set("inst-a", in1);
  ism.outFeeds.set("inst-b", out2); ism.inFeeds.set("inst-b", in2);

  await ism.closeInstanceFeeds("inst-a");

  assert.equal(ism.outFeeds.has("inst-a"), false, "inst-a out removed");
  assert.equal(ism.inFeeds.has("inst-a"), false, "inst-a in removed");
  assert.equal(ism.outFeeds.has("inst-b"), true, "inst-b out still present");
  assert.equal(ism.inFeeds.has("inst-b"), true, "inst-b in still present");
  assert.equal(out2.closeCalls, 0, "inst-b out not closed");
  assert.equal(in2.closeCalls, 0, "inst-b in not closed");
});

test("closeInstanceFeeds: serialized — second call awaits first via _initLocks", async () => {
  const ism = new InstanceSyncManager(IDENTITY, DB_STUB, "local-inst");

  let resolveRelease;
  const releaseBarrier = new Promise((r) => { resolveRelease = r; });
  const closeStarted = new Promise((r) => {
    ism.outFeeds.set("slow-inst", {
      async close() {
        r(); // signal started
        await releaseBarrier;
      },
    });
  });

  const p1 = ism.closeInstanceFeeds("slow-inst");
  await closeStarted;

  // Inject a second feed — p2 must not race with p1.
  const in2 = stubFeed();
  ism.inFeeds.set("slow-inst", in2);

  const p2 = ism.closeInstanceFeeds("slow-inst");

  resolveRelease();
  await p1;
  await p2;

  assert.equal(in2.closeCalls, 1, "second close ran after first completed");
  assert.equal(ism.outFeeds.has("slow-inst"), false, "outFeeds cleared");
  assert.equal(ism.inFeeds.has("slow-inst"), false, "inFeeds cleared");
});
