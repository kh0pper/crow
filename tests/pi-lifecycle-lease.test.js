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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
// defaultLeaseFiles() — the ONLY path the two real production callers
// exercise (bridge_tick_lib.mjs sweep and the module's own CLI `reap`, both
// of which pass NO leaseFiles override). Exercised FOR REAL below: no
// leaseFiles injection; homedir/env come in through the `_homedir`/`_env`
// seams (same opts idiom as `_procs`/`_kill`).
// ---------------------------------------------------------------------------

// (g) HOME nonexistent (readdir throws — the scratch-harness shape) + a
//     valid CROW_HOME lease: the CROW_HOME source must survive the readdir
//     failure independently, so the leased pid is exempt.
//     Mutation check: re-merging the two try/catches into one makes the
//     readdir throw drop the CROW_HOME file too -> pid reaped -> this fails.
test("defaultLeaseFiles: nonexistent HOME still honors a valid CROW_HOME lease", () => {
  const dir = scratchDir("g");
  const crowHome = join(dir, "crow-home");
  mkdirSync(crowHome);
  writeFileSync(
    join(crowHome, "perch-interactive-leases.json"),
    JSON.stringify({
      version: 1,
      leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 60_000 } },
    })
  );
  const procs = [proc(PID_LEASED, { etimes: 3000 })];
  const r = reapStalePi({
    _procs: procs,
    // NO leaseFiles override — defaultLeaseFiles() is the code under test.
    _homedir: () => join(dir, "no-such-home"),
    _env: { CROW_HOME: crowHome },
    now: NOW,
    _kill: fakeKill(),
    log: () => {},
  });
  assert.equal(
    r.reaped.length,
    0,
    "CROW_HOME lease must exempt the pid even when HOME does not exist"
  );
});

// (h) CROW_HOME at a SIBLING path of home (`<x>/home2/.crow` next to
//     `<x>/home`): a bare string-prefix check would treat it as "under
//     home" and silently drop its lease file. The boundary-safe check must
//     read it.
//     Mutation check: reverting to bare `crowHome.startsWith(home)` drops
//     the file -> pid reaped -> this fails.
test("defaultLeaseFiles: sibling-prefix CROW_HOME lease file IS read", () => {
  const dir = scratchDir("h");
  const home = join(dir, "home");
  mkdirSync(home);
  const crowHome = join(dir, "home2", ".crow"); // sibling: startsWith(home) is true
  mkdirSync(crowHome, { recursive: true });
  assert.ok(crowHome.startsWith(home), "fixture must be a bare-prefix sibling");
  writeFileSync(
    join(crowHome, "perch-interactive-leases.json"),
    JSON.stringify({
      version: 1,
      leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 60_000 } },
    })
  );
  const procs = [proc(PID_LEASED, { etimes: 3000 })];
  const r = reapStalePi({
    _procs: procs,
    // NO leaseFiles override — defaultLeaseFiles() is the code under test.
    _homedir: () => home,
    _env: { CROW_HOME: crowHome },
    now: NOW,
    _kill: fakeKill(),
    log: () => {},
  });
  assert.equal(
    r.reaped.length,
    0,
    "a sibling-path CROW_HOME lease must exempt the pid"
  );
});

// (i) sanity on the same default path: CROW_HOME genuinely under home is
//     NOT double-added (the readdir source already covers `~/.crow*`), and
//     a `.crow*` dir found by the readdir loop still protects its pid.
test("defaultLeaseFiles: readdir source still finds ~/.crow* leases", () => {
  const dir = scratchDir("i");
  const home = join(dir, "home");
  const crowDir = join(home, ".crow-test");
  mkdirSync(crowDir, { recursive: true });
  writeFileSync(
    join(crowDir, "perch-interactive-leases.json"),
    JSON.stringify({
      version: 1,
      leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 60_000 } },
    })
  );
  const procs = [proc(PID_LEASED, { etimes: 3000 })];
  const r = reapStalePi({
    _procs: procs,
    _homedir: () => home,
    _env: { CROW_HOME: crowDir }, // under home -> covered by readdir source
    now: NOW,
    _kill: fakeKill(),
    log: () => {},
  });
  assert.equal(r.reaped.length, 0);
});

// ---------------------------------------------------------------------------
// readFreshLeases version gate: absent version tolerated (covered by the
// tests above implicitly using version:1); a DIFFERENT declared version is
// skipped rather than half-parsed.
// ---------------------------------------------------------------------------
test("readFreshLeases skips files declaring a version other than 1", () => {
  const dir = scratchDir("version");
  const v2 = leaseFile(dir, "v2.json", {
    version: 2,
    leases: { [String(PID_LEASED)]: { sessionId: "s1", expiresAt: NOW + 60_000 } },
  });
  const noVersion = leaseFile(dir, "no-version.json", {
    leases: { [String(PID_OTHER)]: { sessionId: "s2", expiresAt: NOW + 60_000 } },
  });
  const fresh = readFreshLeases([v2, noVersion], NOW);
  assert.ok(!fresh.has(PID_LEASED), "version:2 file must be skipped");
  assert.ok(fresh.has(PID_OTHER), "absent version must be tolerated");
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
