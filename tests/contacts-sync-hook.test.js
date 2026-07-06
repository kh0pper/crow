/**
 * Phase 3 PR-A — Task 3: the onContactSynced wire hook.
 * wireSyncedContact(managers, row): subscribes a keyed non-blocked non-local-bot
 * contact; unsubscribes a newly-blocked one; no-ops keyless (manual); never throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireSyncedContact } from "../servers/sharing/contact-promote.js";

function spyManagers() {
  const calls = { subscribe: [], join: [], init: [], close: [], leave: [] };
  return {
    calls,
    nostrManager: { subscribeToContact: async (c) => { calls.subscribe.push(c.crow_id); } },
    peerManager: { joinContact: async (c) => { calls.join.push(c.crowId); }, leaveContact: async (id) => { calls.leave.push(id); } },
    syncManager: { initContact: async (id) => { calls.init.push(id); }, closeContactFeeds: async (id) => { calls.close.push(id); } },
  };
}
const SECP = "a".repeat(64);

test("wireSyncedContact: subscribes a keyed, non-blocked contact", async () => {
  const m = spyManagers();
  await wireSyncedContact(m, { id: 1, crow_id: "crow:x", secp256k1_pubkey: SECP, ed25519_pubkey: "e", is_blocked: 0 });
  assert.deepEqual(m.calls.subscribe, ["crow:x"]);
  assert.deepEqual(m.calls.join, ["crow:x"]);
});

test("wireSyncedContact: newly-blocked contact unsubscribes, does not subscribe", async () => {
  const m = spyManagers();
  await wireSyncedContact(m, { id: 2, crow_id: "crow:b", secp256k1_pubkey: SECP, is_blocked: 1 });
  assert.deepEqual(m.calls.subscribe, []);
  assert.deepEqual(m.calls.close, [2]);
  assert.deepEqual(m.calls.leave, ["crow:b"]);
});

test("wireSyncedContact: keyless (manual) + local-bot contacts do not subscribe", async () => {
  const m = spyManagers();
  await wireSyncedContact(m, { id: 3, crow_id: "manual:x", secp256k1_pubkey: "", contact_type: "manual" });
  await wireSyncedContact(m, { id: 4, crow_id: "crow:lb", secp256k1_pubkey: SECP, origin: "local-bot" });
  assert.deepEqual(m.calls.subscribe, []);
});

test("wireSyncedContact: never throws on null managers", async () => {
  await wireSyncedContact(null, { id: 5, crow_id: "crow:n", secp256k1_pubkey: SECP });
});
