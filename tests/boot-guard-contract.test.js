/**
 * Contract tests for the boot guard (audit N1c-3, Layer 1).
 *
 * The launcher is a COPY installed outside the checkout, so it cannot import the
 * gateway's modules: the lock format, the quarantine marker and the alert spool
 * are re-implemented in-file. These tests are what keeps the two implementations
 * from drifting — and what keeps the launcher's import list to builtins, because
 * importing tree code would execute the sha it is about to judge.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

import {
  LOCK_STALE_MS, LOCK_WRITE_GRACE_MS, TRANSIENT_QUARANTINE_MS as LAUNCHER_TRANSIENT,
  acquireLockFile, buildUpdateQuarantine, gitChildEnv, gitRun, readUpdateQuarantineFile, readLockFile,
  releaseLockFile, lockIsStale as launcherLockIsStale, saveState, loadState, freshState, writeSpoolAlert,
  writeUpdateQuarantineFile,
} from "../scripts/boot-guard/crow-boot-guard.mjs";
import { _lockPrimitivesForTest } from "../servers/gateway/auto-update.js";
import {
  TRANSIENT_QUARANTINE_MS as GATEWAY_TRANSIENT, readUpdateQuarantine, writeUpdateQuarantine,
} from "../servers/shared/update-quarantine.js";
import { _setAlertsRootForTest, drainAlertSpool } from "../servers/shared/alert-spool.js";

const LAUNCHER = join(import.meta.dirname, "..", "scripts", "boot-guard", "crow-boot-guard.mjs");
const A = "a".repeat(40);
const B = "b".repeat(40);

const _dirs = [];
function scratch(prefix = "bg-contract-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  _dirs.push(dir);
  return dir;
}
after(() => {
  _setAlertsRootForTest(null);
  for (const d of _dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

/* ------------------------------------------------------------- imports */

test("the launcher imports node: builtins only", () => {
  const source = readFileSync(LAUNCHER, "utf8");
  const specifiers = [
    ...[...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/\bimport\s*\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
  ];
  assert.ok(specifiers.length >= 4, `expected several imports, found ${specifiers.length}`);
  for (const spec of specifiers) {
    assert.match(spec, /^node:/, `the installed launcher cannot resolve "${spec}"`);
  }
});

/* ---------------------------------------------------------------- git env */

test("every GIT_* variable is stripped from the git child environment", () => {
  // A unit environment that carries GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE would
  // otherwise point EVERY check at another repository (or at nothing).
  const root = scratch("bg-git-env-");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-b", "main", work], { stdio: "pipe" });

  const env = {
    ...process.env,
    GIT_DIR: join(root, "not-a-repo.git"),
    GIT_WORK_TREE: join(root, "elsewhere"),
    GIT_INDEX_FILE: join(root, "no-such-index"),
  };
  const r = gitRun(work, ["rev-parse", "--show-toplevel"], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(realpathSync(r.stdout), realpathSync(work), "GIT_DIR must not redirect the guard's own checks");
  assert.equal(gitChildEnv(env).GIT_DIR, undefined);
  assert.equal(gitChildEnv(env).GIT_TERMINAL_PROMPT, "0");
});

/* ---------------------------------------------------------------- lock */

test("the launcher's lock and auto-update's acquireLock exclude each other both ways", () => {
  const dir = scratch();
  const lockPath = join(dir, "crow-auto-update.lock");

  // Launcher holds → the gateway's acquireLock must refuse.
  const mine = acquireLockFile(lockPath);
  assert.equal(mine, lockPath, "the launcher should take a free lock");
  assert.equal(_lockPrimitivesForTest.acquireLock(lockPath), null, "the gateway took a live launcher's lock");
  // The body is pid\nISO\n, exactly what auto-update.js writes and reads.
  const [pidLine, tsLine] = readFileSync(lockPath, "utf8").split("\n");
  assert.equal(Number(pidLine), process.pid);
  assert.ok(Number.isFinite(Date.parse(tsLine)));
  releaseLockFile(lockPath);
  assert.equal(readLockFile(lockPath), null);

  // Gateway holds → the launcher must refuse.
  const theirs = _lockPrimitivesForTest.acquireLock(lockPath);
  assert.equal(theirs, lockPath);
  assert.equal(acquireLockFile(lockPath), null, "the launcher stole a live gateway's lock");
  _lockPrimitivesForTest.releaseLock(theirs);
});

test("lock staleness agrees with lockIsStale: dead pid, 30-minute age, no-pid grace, EPERM", () => {
  const dir = scratch();
  const lockPath = join(dir, "crow-auto-update.lock");
  const now = Date.now();
  const write = (body) => writeFileSync(lockPath, body);

  const cases = [
    ["dead pid", () => write(`999999\n${new Date(now).toISOString()}\n`)],
    ["30-minute-old live pid", () => write(`${process.pid}\n${new Date(now - LOCK_STALE_MS - 60_000).toISOString()}\n`)],
    ["no pid, fresh (write in progress)", () => write(`\n${new Date(now).toISOString()}\n`)],
    ["no pid, past the grace window", () => write(`\n${new Date(now - LOCK_WRITE_GRACE_MS - 60_000).toISOString()}\n`)],
    ["unparseable file", () => write("garbage\n")],
    // EPERM-as-alive: pid 1 exists but belongs to another user (or is init).
    ["foreign pid", () => write(`1\n${new Date(now).toISOString()}\n`)],
  ];
  for (const [label, make] of cases) {
    make();
    const info = readLockFile(lockPath);
    assert.equal(launcherLockIsStale(info, now), _lockPrimitivesForTest.lockIsStale(info),
      `staleness diverged for: ${label}`);
  }
  // And the two constants the rule is built from.
  assert.equal(LOCK_STALE_MS, 30 * 60 * 1000);
  assert.equal(LOCK_WRITE_GRACE_MS, 5000);
});

test("a 30-minute-old lock is reclaimed, a fresh one is not", () => {
  const dir = scratch();
  const lockPath = join(dir, "crow-auto-update.lock");
  writeFileSync(lockPath, `999999\n${new Date(Date.now() - LOCK_STALE_MS - 60_000).toISOString()}\n`);
  assert.equal(acquireLockFile(lockPath), lockPath, "a stale lock must be reclaimed");
  releaseLockFile(lockPath);
});

/* ----------------------------------------------------------- quarantine */

test("the update quarantine marker is byte-compatible with update-quarantine.js both ways", () => {
  const dir = scratch();
  // Launcher writes → the gateway's reader accepts it.
  const built = buildUpdateQuarantine({ sha: B, previous: A, reason: "startup-crash", now: Date.parse("2026-01-02T03:04:05Z") });
  assert.equal(writeUpdateQuarantineFile(dir, built), true);
  const readByGateway = readUpdateQuarantine({ gitDir: dir });
  assert.ok(readByGateway, "the gateway could not read the launcher's marker");
  assert.equal(readByGateway.sha, B);
  assert.equal(readByGateway.previous, A);
  assert.equal(readByGateway.reason, "startup-crash");
  assert.equal(readByGateway.by, "boot-guard");
  assert.equal(readByGateway.at, "2026-01-02T03:04:05.000Z");
  assert.equal(readByGateway.expires_at, undefined, "startup-crash has no TTL: it waits for main to move");

  // Gateway writes → the launcher's reader accepts it.
  writeUpdateQuarantine({ gitDir: dir, sha: A, previous: B, reason: "import-check" });
  const readByLauncher = readUpdateQuarantineFile(dir);
  assert.ok(readByLauncher, "the launcher could not read the gateway's marker");
  assert.equal(readByLauncher.sha, A);
  assert.equal(readByLauncher.reason, "import-check");
});

test("a HELD marker is byte-identical in both writers, and both readers see held (F2)", () => {
  // The boot guard writes HELD markers from a refusal (the bad commit is still
  // checked out); auto-update writes them when a rollback could not move the
  // tree. One format, or one side would silently drop the other's refusal.
  const now = Date.parse("2026-01-02T03:04:05Z");
  const launcher = buildUpdateQuarantine({ sha: B, previous: A, reason: "startup-crash", persist: true, now });
  const dir = scratch();
  writeUpdateQuarantineFile(dir, launcher);
  assert.deepEqual(readUpdateQuarantine({ gitDir: dir }), launcher, "the gateway reader must accept it verbatim");
  assert.equal(launcher.held, true);
  assert.equal(launcher.expires_at, undefined, "a held marker never times out");

  const other = scratch();
  const gateway = writeUpdateQuarantine({ gitDir: other, sha: B, previous: A, reason: "startup-crash", by: "boot-guard", persist: true, now });
  assert.deepEqual(gateway, launcher, "the two writers must produce the same record");
  assert.equal(readUpdateQuarantineFile(other).held, true, "the launcher's reader must see the gateway's held flag");
});

test("both implementations use the same transient TTL table", () => {
  assert.deepEqual({ ...LAUNCHER_TRANSIENT }, { ...GATEWAY_TRANSIENT });
  const dir = scratch();
  const now = Date.parse("2026-01-02T03:04:05Z");
  writeUpdateQuarantineFile(dir, buildUpdateQuarantine({ sha: B, previous: A, reason: "init-db-failed", now }));
  const marker = readUpdateQuarantine({ gitDir: dir });
  assert.equal(Date.parse(marker.expires_at) - now, GATEWAY_TRANSIENT["init-db-failed"]);
});

/* ---------------------------------------------------------------- spool */

test("the gateway's drainAlertSpool delivers a launcher-spooled alert to the bell", async () => {
  const crowHome = scratch("bg-spool-");
  mkdirSync(join(crowHome, "alerts"), { recursive: true });
  _setAlertsRootForTest(join(crowHome, "alerts"));

  const written = writeSpoolAlert({
    crowHome,
    code: "update-rolled-back",
    title: "Crow rolled back an update that would not start",
    body: `Commit ${B.slice(0, 9)} crashed on startup 3 times.`,
    at: "2026-01-02T03:04:05.000Z",
  });
  assert.ok(written, "the launcher must be able to spool an alert");
  const files = readdirSync(join(crowHome, "alerts", "pending"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^2026-01-02T03-04-05-000Z-update-rolled-back\.json$/);
  const record = JSON.parse(readFileSync(join(crowHome, "alerts", "pending", files[0]), "utf8"));
  assert.equal(record.code, "update-rolled-back");
  assert.equal(record.title, "Crow rolled back an update that would not start");

  const db = { async execute({ sql } = {}) { if (/SELECT id FROM notifications/.test(sql || "")) return { rows: [] }; return { rows: [] }; } };
  const created = [];
  const result = await drainAlertSpool(db, {
    createNotification: async (_db, n) => { created.push(n); return { id: created.length }; },
    log: () => {},
  });
  assert.equal(result.delivered, 1, "the gateway must drain the launcher's alert file");
  assert.equal(created.length, 1);
  assert.equal(created[0].source, "migrations");
  assert.equal(created[0].title, record.title);
  assert.equal(created[0].metadata.code, "update-rolled-back");
  assert.equal(readdirSync(join(crowHome, "alerts", "pending")).length, 0, "the file must move to delivered/");
});

test("the launcher refuses to spool through a symlinked alerts directory", () => {
  const crowHome = scratch("bg-spool-link-");
  const elsewhere = scratch("bg-spool-elsewhere-");
  mkdirSync(join(crowHome, "alerts"), { recursive: true });
  rmSync(join(crowHome, "alerts", "pending"), { recursive: true, force: true });
  symlinkSync(elsewhere, join(crowHome, "alerts", "pending"));
  const written = writeSpoolAlert({ crowHome, code: "x", title: "t" });
  assert.equal(written, null);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing may be written through the link");
});

/* -------------------------------------------------- gateway writer → reader */

test("a state file written by the gateway side loads under the launcher's reader", () => {
  const dir = scratch();
  const state = {
    ...freshState(),
    state: "pending",
    last_ok_sha: A,
    previous_sha: A,
    pending_sha: B,
    previous_proven: true,
    failures: 1,
    attempt: { id: "inv-9", started_at: "2026-01-02T03:04:05.000Z", planned_at: null, exit: null },
    db_path: "/home/u/.crow/data/crow.db",
  };
  assert.equal(saveState(dir, state), true);
  const loaded = loadState(dir);
  assert.equal(loaded.error, null);
  assert.equal(loaded.state.pending_sha, B);
  assert.equal(loaded.state.attempt.id, "inv-9");
});