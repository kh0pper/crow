/**
 * Convergence unit tests — pure functions and module primitives.
 *
 * The two-instance integration gate lives in convergence-two-instance.test.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectedServers, healthSnapshot, addonsSettled, _markAddonsSettled } from "../servers/gateway/proxy.js";
import { compareHealth } from "../servers/gateway/convergence.js";

// The suite must never believe it is supervised — code under test would arm
// real restart/exit paths inside this process.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

// NOTE: addonsSettled() is module state that resolves ONCE. This test must run
// before anything else marks it, so it is deliberately first in the file.
test("addonsSettled starts pending and resolves when marked", async () => {
  let resolved = false;
  addonsSettled().then(() => { resolved = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, "must not be resolved before the addon loader finishes");

  _markAddonsSettled();
  await addonsSettled();
  assert.equal(resolved, true, "must resolve once marked");

  // Idempotent: marking again must not throw or hang.
  _markAddonsSettled();
  await addonsSettled();
});

test("healthSnapshot reports ADDONS ONLY, reading the real status field", () => {
  connectedServers.clear();
  connectedServers.set("tasks", { status: "connected", isAddon: true });
  connectedServers.set("bots-sql-mcp", { status: "error", isAddon: true });
  connectedServers.set("instance-peer", { status: "offline", isRemote: true }); // federation peer
  connectedServers.set("some-integration", { status: "connected" });            // integration
  try {
    assert.deepEqual(
      healthSnapshot(),
      { tasks: "connected", "bots-sql-mcp": "error" },
      "a remote crow rebooting must never look like a LOCAL regression",
    );
  } finally {
    connectedServers.clear();
  }
});

test("compareHealth flags only REGRESSIONS, never pre-existing breakage", () => {
  // The Aug 3-5 state: tasks and bots-sql-mcp were already down for an unrelated
  // native-ABI reason. An absolute "all green" gate would have quarantined every
  // good sha for that entire window.
  const before = { tasks: "error", "bots-sql-mcp": "error", "pm-workspace": "connected" };

  assert.equal(compareHealth(before, { ...before }).ok, true,
    "already-broken addons must NOT count as a regression");
  assert.equal(compareHealth(before, { ...before, tasks: "connected" }).ok, true,
    "an addon getting BETTER is not a regression");

  const broke = compareHealth(before, { ...before, "pm-workspace": "error" });
  assert.equal(broke.ok, false, "a connected addon going to error IS a regression");
  assert.deepEqual(broke.regressions, [{ id: "pm-workspace", was: "connected", now: "error" }]);

  // "disconnected" is the transport.onclose path — the likeliest real regression.
  assert.equal(compareHealth(before, { ...before, "pm-workspace": "disconnected" }).ok, false);

  const vanished = compareHealth(before, { tasks: "error", "bots-sql-mcp": "error" });
  assert.equal(vanished.ok, false, "an addon that disappears entirely is a regression");
  assert.deepEqual(vanished.regressions, [{ id: "pm-workspace", was: "connected", now: "missing" }]);

  const multi = compareHealth({ a: "connected", b: "connected" }, { a: "error", b: "error" });
  assert.equal(multi.regressions.length, 2, "every regression must be reported, not just the first");

  assert.equal(compareHealth({}, { anything: "error" }).ok, true,
    "an empty baseline never regresses — the correct fail-open reading");
  assert.equal(compareHealth(null, null).ok, true, "null inputs must not throw");
});
