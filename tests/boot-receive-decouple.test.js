/**
 * R8 (never run deaf, L11): the Nostr receive path is wired even when
 * peerManager.start() rejects, and a wiring failure sets receiveWired=false
 * and schedules a bounded-backoff retry. Stub managers only — no sockets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSharingRuntime, wireNostrReceive, startNostrReceive } from "../servers/sharing/boot.js";
import { getReceiveHealth, _resetReceiveHealth } from "../servers/sharing/receive-health.js";

function stubManagers({ startRejects = false, incomingThrows = 0 } = {}) {
  const calls = { subscribeToContact: [], subscribeToIncoming: 0, joinContact: [], initContact: [] };
  let throwsLeft = incomingThrows;
  const contactsRows = [
    { id: 1, crow_id: "crow:full", display_name: "F", ed25519_pubkey: "ed1", secp256k1_pubkey: "02" + "a".repeat(64), request_status: null },
    { id: 2, crow_id: "crow:acc", display_name: "A", ed25519_pubkey: "", secp256k1_pubkey: "02" + "b".repeat(64), request_status: "accepted" },
    { id: 3, crow_id: "crow:pend", display_name: "P", ed25519_pubkey: "", secp256k1_pubkey: "02" + "c".repeat(64), request_status: "pending" },
  ];
  const db = {
    execute: async ({ sql }) =>
      /FROM contacts WHERE is_blocked = 0/.test(sql)
        ? { rows: contactsRows, rowsAffected: 0 }
        : { rows: [], rowsAffected: 0 },
  };
  const managers = {
    db,
    identity: { crowId: "crow:test", secp256k1Pubkey: "a".repeat(64), secp256k1Priv: new Uint8Array(32) },
    peerManager: {
      start: () => (startRejects ? Promise.reject(new Error("DHT boom")) : Promise.resolve()),
      joinContact: async (a) => { calls.joinContact.push(a); },
      joinInstanceSync: async () => {},
    },
    syncManager: { initContact: async (id) => { calls.initContact.push(id); } },
    instanceSyncManager: { localInstanceId: "inst-test" },
    nostrManager: {
      subscribeToContact: async (c) => { calls.subscribeToContact.push(c.crow_id); },
      subscribeToIncoming: async (onInvite, onSocial, onRequest) => {
        if (throwsLeft > 0) { throwsLeft--; throw new Error("relay wiring boom"); }
        calls.subscribeToIncoming++;
        calls.handlers = { onInvite, onSocial, onRequest }; // captured for ladder-scope tests
      },
    },
  };
  return { managers, calls };
}

// The scope-trap detector (review round 1): a too-narrow destructure in
// wireNostrReceive makes a ladder branch throw ReferenceError on its free
// variables (syncManager/peerManager/identity). Stub-db failures are tolerated;
// a ReferenceError is the bug.
async function assertNoReferenceError(fn, label) {
  try {
    await fn();
  } catch (err) {
    assert.ok(!(err instanceof ReferenceError), `${label}: ladder scope broken — ${err.message}`);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("wireNostrReceive subscribes non-pending contacts then incoming", async () => {
  _resetReceiveHealth();
  const { managers, calls } = stubManagers();
  await wireNostrReceive(managers);
  assert.deepEqual(calls.subscribeToContact.sort(), ["crow:acc", "crow:full"]); // pending skipped
  assert.equal(calls.subscribeToIncoming, 1);
});

test("R8: initSharingRuntime wires Nostr receive even when peerManager.start() rejects", async () => {
  _resetReceiveHealth();
  const { managers, calls } = stubManagers({ startRejects: true });
  await initSharingRuntime(managers, { applyProjectCloneBundle: async () => {}, buildProjectCloneBundle: async () => {} });
  for (let i = 0; i < 25 && calls.subscribeToIncoming === 0; i++) await tick();
  assert.equal(calls.subscribeToIncoming, 1, "subscribeToIncoming must run despite DHT failure");
  assert.equal(getReceiveHealth().receiveWired, true);
  // And the Hyperswarm-only work did NOT run (start rejected):
  assert.equal(calls.joinContact.length, 0);
});

test("startNostrReceive: wiring failure sets receiveWired=false and retries with backoff", async () => {
  _resetReceiveHealth();
  const { managers, calls } = stubManagers({ incomingThrows: 2 });
  const scheduled = [];
  // Capturing scheduler: records delay, runs the retry immediately.
  const schedule = (fn, ms) => { scheduled.push(ms); fn(); };
  await startNostrReceive(managers, { baseMs: 1000, maxMs: 8000, schedule });
  for (let i = 0; i < 25 && calls.subscribeToIncoming === 0; i++) await tick();
  assert.equal(calls.subscribeToIncoming, 1, "third attempt succeeds");
  assert.deepEqual(scheduled, [1000, 2000], "exponential backoff from baseMs");
  assert.equal(getReceiveHealth().receiveWired, true);
});

test("moved ladder keeps its free variables in scope (invite/social/request drive without ReferenceError)", async () => {
  _resetReceiveHealth();
  const { managers, calls } = stubManagers();
  await wireNostrReceive(managers);
  const h = calls.handlers;
  assert.ok(h, "stub must capture the three subscribeToIncoming callbacks");
  // invite_accepted → handleInviteAccepted(db, { syncManager, peerManager, nostrManager }, …)
  await assertNoReferenceError(
    () => h.onInvite({ type: "invite_accepted", crow_id: "crow:x", secp: "02" + "d".repeat(64) }, "d".repeat(64)),
    "onInviteAccepted",
  );
  // room_message → handleInboundRoomEnvelope({ db, nostrManager, identity, … }) — references `identity`
  await assertNoReferenceError(
    () => h.onSocial("room_message", {}, "d".repeat(64)),
    "onSocial(room_message)",
  );
  // bot_relay → early-returns on target_instance mismatch (exercises the
  // resolveLocalInstanceName/db path only; the `identity` free variable is
  // covered by the room_message drive above, which evaluates it in the
  // argument object before the callee runs)
  await assertNoReferenceError(
    () => h.onSocial("bot_relay", { target_instance: "nope", sender_instance: "x" }, "d".repeat(64)),
    "onSocial(bot_relay)",
  );
  // reaction → createNotification-only branch
  await assertNoReferenceError(
    () => h.onSocial("reaction", { emoji: "+1", sender_name: "X" }, "d".repeat(64)),
    "onSocial(reaction)",
  );
  // message-request fallback → handleIncomingRequest(db, managers, …) — references `managers`
  await assertNoReferenceError(
    () => h.onRequest("d".repeat(64), "plain text", { id: "evt1" }),
    "onMessageRequest",
  );
});

test("startNostrReceive: backoff is capped at maxMs and never rejects", async () => {
  _resetReceiveHealth();
  const { managers } = stubManagers({ incomingThrows: 6 });
  const scheduled = [];
  let pending = null;
  const schedule = (fn, ms) => { scheduled.push(ms); pending = fn; };
  await startNostrReceive(managers, { baseMs: 1000, maxMs: 4000, schedule });
  // Drive the retries manually: initial attempt scheduled push #1; 4 more
  // attempts (all still throwing) push #2-#5. 5 attempts total, throwsLeft 6→1.
  for (let i = 0; i < 4; i++) { const fn = pending; pending = null; await fn(); }
  assert.deepEqual(scheduled, [1000, 2000, 4000, 4000, 4000], "capped at maxMs");
  assert.equal(getReceiveHealth().receiveWired, false);
  assert.match(getReceiveHealth().lastError, /relay wiring boom/);
});
