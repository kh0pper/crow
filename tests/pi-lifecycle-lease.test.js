// C-14 — reaper lease exemption. `perch-interactive.js` writes a per-instance
// lease file (`servers/gateway/perch-interactive.js` writeLeases()) while a
// long-lived interactive child is awake so the host-global pi reaper
// (pi_lifecycle.mjs reapStalePi()) doesn't kill it for merely being old. The
// exemption applies to the hardAgeSec rule ONLY — orphan (ppid 1) and RSS
// rules still apply to leased pids unchanged.
//
// All fixture pids are in the nonexistent range (> 4_194_304, the Linux
// pid_max ceiling) so isAlive()'s real `process.kill(pid, 0)` liveness check
// reliably reports "gone" without ever touching a real process, and every
// SIGTERM/SIGKILL send is routed through the `opts._kill` seam so no signal
// is ever actually delivered.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reapStalePi, readFreshLeases } from "../scripts/pi-bots/pi_lifecycle.mjs";

const NOW = 1_700_000_000_000;
const PID_UNLEASED = 4_194_305;
const PID_LEASED = 4_194_306;
const PID_OTHER = 4_194_307;

/** Fresh scratch dir for lease-file fixtures, cleaned up after the test. */
function scratchDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `pi-lifecycle-lease-${label}-`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function leaseFile(dir, name, contents) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

function proc(pid, overrides = {}) {
  return Object.assign(
    { pid, ppid: 999, etimes: 100, rssKb: 10_000, args: "..." },
    overrides
  );
}

/** No-op kill recorder — never sends a real signal. */
function fakeKill() {
  const calls = [];
  const fn = (pid, signal) => {
    calls.push({ pid, signal });
  };
  fn.calls = calls;
  return fn;
}

const DEFAULT_HARD_AGE = 1800; // LIFECYCLE_DEFAULTS.hardAgeSec
const DEFAULT_ORPHAN_GRACE = 90; // LIFECYCLE_DEFAULTS.orphanGraceSec
const DEFAULT_RSS_CEILING = 4_194_304; // LIFECYCLE_DEFAULTS.rssCeilingKb

// ---------------------------------------------------------------------------
// (a) leased pid past hard age survives; an identical unleased pid is reaped.
// ---------------------------------------------------------------------------
test("hard-age: leased pid survives, unleased pid is reaped stuck", () => {
  const dir = scratchDir("a");
  const file = leaseFile(dir, "leases.json", {
    version: 1,
    leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 60_000 } },
  });
  const procs = [
    proc(PID_LEASED, { etimes: 3000 }),
    proc(PID_UNLEASED, { etimes: 3000 }),
  ];
  const kill = fakeKill();
  const r = reapStalePi({
    _procs: procs,
    leaseFiles: [file],
    now: NOW,
    _kill: kill,
    log: () => {},
  });
  const reapedPids = r.reaped.map((v) => v.pid);
  assert.ok(!reapedPids.includes(PID_LEASED), "leased pid must survive hard-age");
  assert.ok(reapedPids.includes(PID_UNLEASED), "unleased pid must be reaped");
  const unleasedEntry = r.reaped.find((v) => v.pid === PID_UNLEASED);
  assert.match(unleasedEntry.reason, /^stuck /);
});

// ---------------------------------------------------------------------------
// (b) an EXPIRED lease does not protect.
// ---------------------------------------------------------------------------
test("hard-age: expired lease does not protect", () => {
  const dir = scratchDir("b");
  const file = leaseFile(dir, "leases.json", {
    version: 1,
    leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW - 1_000 } },
  });
  const procs = [proc(PID_LEASED, { etimes: 3000 })];
  const r = reapStalePi({
    _procs: procs,
    leaseFiles: [file],
    now: NOW,
    _kill: fakeKill(),
    log: () => {},
  });
  const reapedPids = r.reaped.map((v) => v.pid);
  assert.ok(reapedPids.includes(PID_LEASED), "expired lease must not exempt the pid");
});

// ---------------------------------------------------------------------------
// (c) leased pid with ppid 1 past orphan grace IS reaped — orphan rule
//     applies to leased pids unchanged.
// ---------------------------------------------------------------------------
test("orphan rule still applies to a leased pid", () => {
  const dir = scratchDir("c");
  const file = leaseFile(dir, "leases.json", {
    version: 1,
    leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 60_000 } },
  });
  const procs = [
    proc(PID_LEASED, { ppid: 1, etimes: DEFAULT_ORPHAN_GRACE + 10 }),
  ];
  const r = reapStalePi({
    _procs: procs,
    leaseFiles: [file],
    now: NOW,
    _kill: fakeKill(),
    log: () => {},
  });
  assert.equal(r.reaped.length, 1);
  assert.equal(r.reaped[0].pid, PID_LEASED);
  assert.match(r.reaped[0].reason, /^orphan /);
});

// ---------------------------------------------------------------------------
// (d) leased pid over the RSS ceiling IS reaped — RSS rule applies to
//     leased pids unchanged.
// ---------------------------------------------------------------------------
test("RSS ceiling rule still applies to a leased pid", () => {
  const dir = scratchDir("d");
  const file = leaseFile(dir, "leases.json", {
    version: 1,
    leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 60_000 } },
  });
  const procs = [
    proc(PID_LEASED, { etimes: 100, rssKb: DEFAULT_RSS_CEILING + 1 }),
  ];
  const r = reapStalePi({
    _procs: procs,
    leaseFiles: [file],
    now: NOW,
    _kill: fakeKill(),
    log: () => {},
  });
  assert.equal(r.reaped.length, 1);
  assert.equal(r.reaped[0].pid, PID_LEASED);
  assert.match(r.reaped[0].reason, /^runaway /);
});

// ---------------------------------------------------------------------------
// (e) missing/corrupt lease files behave exactly as today (empty set).
// ---------------------------------------------------------------------------
test("missing and corrupt lease files are excluded, never throw", () => {
  const dir = scratchDir("e");
  const missing = join(dir, "does-not-exist.json");
  const corrupt = join(dir, "corrupt.json");
  writeFileSync(corrupt, "{ not valid json");

  const fresh = readFreshLeases([missing, corrupt], NOW);
  assert.equal(fresh.size, 0);

  const procs = [proc(PID_UNLEASED, { etimes: 3000 })];
  const r = reapStalePi({
    _procs: procs,
    leaseFiles: [missing, corrupt],
    now: NOW,
    _kill: fakeKill(),
    log: () => {},
  });
  assert.equal(r.reaped.length, 1);
  assert.equal(r.reaped[0].pid, PID_UNLEASED);
  assert.match(r.reaped[0].reason, /^stuck /);
});

// ---------------------------------------------------------------------------
// (f) cross-instance: a lease in a SECOND `.crow-x` home fixture protects
//     its pid — leaseFiles must be unioned across every file, not just the
//     first.
// ---------------------------------------------------------------------------
test("cross-instance: a lease in a second lease file protects its pid", () => {
  const dir = scratchDir("f");
  const fileA = leaseFile(dir, "instance-a-leases.json", {
    version: 1,
    leases: { [String(PID_OTHER)]: { sessionId: "other", expiresAt: NOW + 60_000 } },
  });
  const fileB = leaseFile(dir, "instance-b-leases.json", {
    version: 1,
    leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 60_000 } },
  });
  const procs = [proc(PID_LEASED, { etimes: 3000 })];
  const r = reapStalePi({
    _procs: procs,
    leaseFiles: [fileA, fileB],
    now: NOW,
    _kill: fakeKill(),
    log: () => {},
  });
  assert.equal(r.reaped.length, 0, "pid leased in the second file must be exempt");
});

// ---------------------------------------------------------------------------
// readFreshLeases direct unit coverage.
// ---------------------------------------------------------------------------
test("readFreshLeases unions fresh leases across files and drops expired ones", () => {
  const dir = scratchDir("union");
  const fileA = leaseFile(dir, "a.json", {
    version: 1,
    leases: {
      [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 1000 },
      [String(PID_OTHER)]: { sessionId: "s2", expiresAt: NOW - 1000 }, // expired
    },
  });
  const fileB = leaseFile(dir, "b.json", {
    version: 1,
    leases: { [String(PID_UNLEASED)]: { sessionId: "s3", expiresAt: NOW + 1000 } },
  });
  const fresh = readFreshLeases([fileA, fileB], NOW);
  assert.ok(fresh.has(PID_LEASED));
  assert.ok(fresh.has(PID_UNLEASED));
  assert.ok(!fresh.has(PID_OTHER));
});

// ---------------------------------------------------------------------------
// The escalation busy-loop must not block ~3s in tests: nonexistent-range
// fixture pids make isAlive() report "gone" immediately, so the loop exits
// after its first tick rather than spinning to the deadline.
// ---------------------------------------------------------------------------
test("escalation loop does not spin to the 3s deadline for already-gone pids", () => {
  const procs = [proc(PID_UNLEASED, { etimes: 3000 })];
  const kill = fakeKill();
  const started = Date.now();
  const r = reapStalePi({
    _procs: procs,
    leaseFiles: [],
    now: NOW,
    _kill: kill,
    log: () => {},
  });
  const elapsed = Date.now() - started;
  assert.equal(r.reaped.length, 1);
  assert.ok(elapsed < 1500, `expected a quick exit, took ${elapsed}ms`);
  // SIGTERM was sent via the seam; SIGKILL never fires because isAlive()
  // (real process.kill(pid,0) on a nonexistent-range pid) reports false
  // right away.
  assert.ok(kill.calls.some((c) => c.pid === PID_UNLEASED && c.signal === "SIGTERM"));
  assert.ok(!kill.calls.some((c) => c.signal === "SIGKILL"));
});
