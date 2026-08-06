/**
 * Convergence unit tests — pure functions and module primitives.
 *
 * The two-instance integration gate lives in convergence-two-instance.test.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectedServers, healthSnapshot, addonsSettled, _markAddonsSettled } from "../servers/gateway/proxy.js";
import { execFileSync } from "node:child_process";
import { startAutoUpdate, stopAutoUpdate, _setDbForTest, instanceJitterMs } from "../servers/gateway/auto-update.js";
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

test("instanceJitterMs is stable per instance and differs between instances", () => {
  const a = instanceJitterMs("/home/kh0pp/.crow/data");
  const b = instanceJitterMs("/home/kh0pp/.crow-mpa/data");
  const c = instanceJitterMs("/home/kh0pp/.crow-r4/data");

  assert.equal(a, instanceJitterMs("/home/kh0pp/.crow/data"), "must be deterministic across calls");
  assert.notEqual(a, b, "co-hosted instances must not share a phase");
  assert.notEqual(b, c);
  assert.notEqual(a, c);

  // Range over many keys, not just the three above — a missing modulo would
  // pass a three-key check by luck.
  for (let i = 0; i < 500; i++) {
    const v = instanceJitterMs(`/tmp/inst-${i}/data`);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 600000, `jitter ${v} out of range for key ${i}`);
  }
});

test("the jitter is actually WIRED IN — the first-check delay differs per instance", async () => {
  // Without this, instanceJitterMs could be perfect and startAutoUpdate could
  // still use a fixed delay, leaving the de-phase-locking fix dead.
  const prevDataDir = process.env.CROW_DATA_DIR;
  const prevAuto = process.env.CROW_AUTO_UPDATE;
  delete process.env.CROW_AUTO_UPDATE;
  const seen = [];
  const origLog = console.log;
  console.log = (...a) => seen.push(a.join(" "));
  try {
    for (const dir of ["/tmp/jit-a/data", "/tmp/jit-b/data"]) {
      process.env.CROW_DATA_DIR = dir;
      await startAutoUpdate({
        execute: async ({ sql }) =>
          /^SELECT/i.test(sql) ? { rows: [{ key: "auto_update_enabled", value: "true" }] } : { rows: [] },
      }, {});
      stopAutoUpdate();
    }
  } finally {
    console.log = origLog;
    // RESTORE, never delete: run-suite.mjs sets CROW_DATA_DIR for the whole
    // process, and deleting it would make every later test resolve to ~/.crow.
    if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
    else process.env.CROW_DATA_DIR = prevDataDir;
    if (prevAuto !== undefined) process.env.CROW_AUTO_UPDATE = prevAuto;
    _setDbForTest(null);
  }

  const delays = seen.filter((l) => l.includes("first check in")).map((l) => l.match(/in (\d+)s/)?.[1]);
  assert.equal(delays.length, 2, "both starts must have logged a first-check delay");
  assert.notEqual(delays[0], delays[1], "two instances must not share a first-check phase");
});

test("a DISABLED instance still records its ACTUAL running sha", async () => {
  const prevAuto = process.env.CROW_AUTO_UPDATE;
  delete process.env.CROW_AUTO_UPDATE; // shouldStartAutoUpdate gates on this
  const writes = [];
  const db = {
    execute: async ({ sql, args }) => {
      if (/^SELECT/i.test(sql)) return { rows: [{ key: "auto_update_enabled", value: "false" }] };
      writes.push({ key: args[0], value: args[1] });
      return { rows: [] };
    },
  };
  try {
    await startAutoUpdate(db, {});
    stopAutoUpdate();
  } finally {
    if (prevAuto !== undefined) process.env.CROW_AUTO_UPDATE = prevAuto;
    _setDbForTest(null);
  }

  const v = writes.find((w) => w.key === "auto_update_current_version");
  assert.ok(v, "must record even when disabled — the r4 instance reported a version it had not run");
  const real = execFileSync("git", ["rev-parse", "--short", "HEAD"],
    { cwd: join(import.meta.dirname, "..") }).toString().trim();
  assert.equal(v.value, real,
    "must be THIS checkout's sha, not merely sha-shaped — a stale or origin/main sha would pass a regex");
});

test("CROW_DISABLE_CONVERGE short-circuits convergence entirely", async () => {
  const { convergeInstance } = await import("../servers/gateway/convergence.js");
  const prev = process.env.CROW_DISABLE_CONVERGE;
  process.env.CROW_DISABLE_CONVERGE = "1";
  try {
    // Bogus paths are deliberate: if the switch works, nothing touches the
    // filesystem or git, so they cannot fail.
    const r = await convergeInstance({
      appRoot: "/nonexistent",
      instance: { dataDir: "/nonexistent", dbPath: "/nonexistent/x.db", tasksDbPath: "/nonexistent/t.db" },
    });
    assert.equal(r.converged, false);
    assert.equal(r.skipped, "disabled");
  } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_CONVERGE;
    else process.env.CROW_DISABLE_CONVERGE = prev;
  }
});
