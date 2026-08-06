/**
 * Convergence unit tests — pure functions and module primitives.
 *
 * The two-instance integration gate lives in convergence-two-instance.test.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectedServers, healthSnapshot, addonsSettled, _markAddonsSettled } from "../servers/gateway/proxy.js";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareHealth,
  writePending, readPending, clearPending, classifyPending,
  writeConvQuarantine, readConvQuarantine, clearConvQuarantine,
  PENDING_TTL_MS, QUARANTINE_TTL_MS,
} from "../servers/gateway/convergence.js";

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

test("the tuned constants are pinned to their justified values", () => {
  // Asserting `now + PENDING_TTL_MS` uses the same constant on both sides and
  // proves nothing. Pin the literals, with the reasoning in the message.
  assert.equal(PENDING_TTL_MS, 15 * 60 * 1000,
    "must exceed a guarded SCHEMA_GENERATION migration plus a full SEQUENTIAL addon-connect pass");
  assert.equal(QUARANTINE_TTL_MS, 24 * 60 * 60 * 1000,
    "hard expiry so no failure mode ends in a host recoverable only by manual file deletion");
});

test("boot cookie round-trips atomically and clears", () => {
  const d = mkdtempSync(join(tmpdir(), "cookie-"));
  try {
    const now = Date.parse("2026-08-06T12:00:00Z");
    writePending(d, { sha: "abc1234", baseline: { tasks: "connected" }, now });

    const p = readPending(d);
    assert.equal(p.sha, "abc1234");
    assert.deepEqual(p.baseline, { tasks: "connected" });
    assert.equal(Date.parse(p.deadline), now + 15 * 60 * 1000); // literal, not the constant

    // The tmp file must be renamed away, never left behind.
    assert.deepEqual(readdirSync(d), ["convergence-pending.json"]);

    clearPending(d);
    assert.equal(readPending(d), null);
    assert.equal(existsSync(join(d, "convergence-pending.json")), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("classifyPending covers every boot case including the crash-loop", () => {
  const now = Date.parse("2026-08-06T12:00:00Z");
  const fresh   = { sha: "new1234", baseline: {}, deadline: new Date(now + 60_000).toISOString() };
  const expired = { sha: "new1234", baseline: {}, deadline: new Date(now - 1).toISOString() };
  const exact   = { sha: "new1234", baseline: {}, deadline: new Date(now).toISOString() };

  assert.equal(classifyPending(null, "new1234", now), "none");
  assert.equal(classifyPending(fresh, "new1234", now), "verify");
  assert.equal(classifyPending(expired, "new1234", now), "failed",
    "crash-loop: booted the target sha but died before verifying");
  assert.equal(classifyPending(expired, "old9999", now), "failed",
    "never booted the target sha at all");
  assert.equal(classifyPending(fresh, "old9999", now), "stale");
  assert.equal(classifyPending(exact, "new1234", now), "failed", "the deadline boundary is inclusive");
});

test("convergence quarantine is its OWN namespace and hard-expires", () => {
  const root = mkdtempSync(join(tmpdir(), "convq-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  try {
    const now = Date.parse("2026-08-06T12:00:00Z");
    writeConvQuarantine({ appRoot: root, dataDir, sha: "bad1234", regressions: [{ id: "x" }], why: "broke x", now });

    // It must NOT land where migration-guard's readers look: index.js reads that
    // marker and would boot the gateway SKIPPING init-db entirely — on an empty
    // database, that means serving with no tables at all.
    assert.equal(existsSync(join(root, ".crow-migration-quarantine.json")), false,
      "convergence must never write a migration-guard marker");
    assert.ok(existsSync(join(root, ".crow-convergence-quarantine.json")), "repo-level marker for peers");
    assert.ok(existsSync(join(dataDir, ".crow-convergence-quarantine.json")), "data-level marker");

    assert.equal(readConvQuarantine({ appRoot: root, dataDir, now: now + 1000 }).sha, "bad1234");
    assert.equal(readConvQuarantine({ appRoot: root, dataDir, now: now + 23 * 3600_000 }).sha, "bad1234");
    assert.equal(readConvQuarantine({ appRoot: root, dataDir, now: now + 25 * 3600_000 }), null,
      "a quarantine older than 24h must be ignored — no permanent wedge");

    clearConvQuarantine({ appRoot: root, dataDir });
    assert.equal(readConvQuarantine({ appRoot: root, dataDir, now: now + 1000 }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
