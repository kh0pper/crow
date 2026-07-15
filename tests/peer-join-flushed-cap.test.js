/**
 * G-F2-4 (2c follow-ups spec §F2/C2c): peerManager.joinContact must bound its
 * `await discovery.flushed()` (DHT announce confirmation) with a cap. An
 * unresponsive DHT must not wedge the boot per-contact join loop
 * (boot.js:737) or the sync apply chain (wireFullContact,
 * contact-promote.js:83).
 *
 * Vacuity note (spec G-F2-4): the stub boundary is the SWARM, not joinContact.
 * joinContact's real code (computeTopic, topics.set, swarm.join) executes;
 * only flushed() hangs. A stubbed joinContact would prove nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

// PeerManager computes p2pDisabled from process.env/argv at construction —
// make the gate deterministic for this test process.
delete process.env.CROW_DISABLE_INSTANCE_SYNC;

const { PeerManager } = await import("../servers/sharing/peer-manager.js");

test("G-F2-4: joinContact returns within the flushed() cap when DHT confirmation never resolves", async () => {
  const pm = new PeerManager({
    ed25519Pubkey: "a".repeat(64),
    crowId: "crow:test-local",
  });
  assert.equal(
    pm.p2pDisabled,
    false,
    "p2p must be enabled or joinContact early-returns and the test is vacuous"
  );

  // Stub swarm: join() runs for real and returns a discovery whose flushed()
  // NEVER resolves (no timers — must not keep the event loop alive).
  const joinCalls = [];
  pm.swarm = {
    join(topic, opts) {
      joinCalls.push({ topic, opts });
      return { flushed: () => new Promise(() => {}) };
    },
  };

  const contact = { crowId: "crow:remote-peer", ed25519Pubkey: "b".repeat(64) };

  // Race deadline: against uncapped (old) code joinContact hangs forever, so
  // the deadline wins and the assertion below goes red. Against capped code
  // the small injectable cap (100ms) wins well inside the deadline.
  const TEST_DEADLINE_MS = 2_000;
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve("__test_deadline__"), TEST_DEADLINE_MS);
  });

  const result = await Promise.race([
    pm.joinContact(contact, { flushedCapMs: 100 }),
    deadline,
  ]);
  clearTimeout(deadlineTimer);

  assert.notEqual(
    result,
    "__test_deadline__",
    "joinContact hung past the test deadline — flushed() await is uncapped"
  );
  assert.ok(Buffer.isBuffer(result), "joinContact must still return the topic buffer");
  assert.equal(joinCalls.length, 1, "swarm.join must have executed for real");
  assert.ok(
    joinCalls[0].topic.equals(result),
    "the joined topic must be the returned topic"
  );

  // The announce path completed: topics map contains the contact's topic.
  const topic = pm.topics.get("crow:remote-peer");
  assert.ok(topic, "topics map must contain the contact's topic after a capped join");
  assert.ok(topic.equals(result), "registered topic must match the returned topic");
});

test("G-F2-4b: joinInstanceSync returns within the flushed() cap when DHT confirmation never resolves", async () => {
  const pm = new PeerManager({
    ed25519Pubkey: "a".repeat(64),
    crowId: "crow:test-local",
  });
  assert.equal(
    pm.p2pDisabled,
    false,
    "p2p must be enabled or joinInstanceSync early-returns and the test is vacuous"
  );

  const joinCalls = [];
  pm.swarm = {
    join(topic, opts) {
      joinCalls.push({ topic, opts });
      return { flushed: () => new Promise(() => {}) };
    },
  };

  const TEST_DEADLINE_MS = 2_000;
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve("__test_deadline__"), TEST_DEADLINE_MS);
  });

  const result = await Promise.race([
    pm.joinInstanceSync({ flushedCapMs: 100 }),
    deadline,
  ]);
  clearTimeout(deadlineTimer);

  assert.notEqual(
    result,
    "__test_deadline__",
    "joinInstanceSync hung past the test deadline — flushed() await is uncapped"
  );
  assert.ok(Buffer.isBuffer(result), "joinInstanceSync must still return the topic buffer");
  assert.equal(joinCalls.length, 1, "swarm.join must have executed for real");
  assert.ok(
    joinCalls[0].topic.equals(result),
    "the joined topic must be the returned topic"
  );

  // Registration before the flush: joinInstanceSync sets this.instanceSyncTopic
  // BEFORE swarm.join / flushed() — assert it survived the capped join.
  assert.ok(
    Buffer.isBuffer(pm.instanceSyncTopic),
    "instanceSyncTopic must be registered after a capped join"
  );
  assert.ok(
    pm.instanceSyncTopic.equals(result),
    "registered instanceSyncTopic must match the returned topic"
  );
});
