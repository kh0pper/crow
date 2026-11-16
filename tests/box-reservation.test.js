// tests/box-reservation.test.js
//
// The box-reservation file is the shared signal between unattended GPU
// windows (pi-lab dsv4-window.sh writes it) and the gateway's
// gpu-orchestrator (reads it before ANY model start). Spec:
// the private engineering notes §3.1.
//
// Contract pinned here: missing/expired -> null; corrupt -> reserved (fail
// closed); DEFAULT_ALLOW always unioned in; 8h default max hold unless force.
//
// The second layer (the booking calendar) is written elsewhere; here we pin
// only the one lock that guards both files and the optional v2 hold fields,
// so a legacy writer's record keeps reading byte-for-byte as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  readReservation, isStartAllowed, writeReservation, clearReservation,
  ReservedError, DEFAULT_ALLOW, DEFAULT_MAX_HOLD_MS, reservationPath,
  schedulePath, lockPath, withReservationLock, withReservationLockAsync,
} from "../servers/gateway/box-reservation.js";

const dir = mkdtempSync(join(tmpdir(), "box-res-"));
const path = join(dir, "r.json");
const T0 = Date.parse("2026-09-04T20:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const MODULE_URL = new URL("../servers/gateway/box-reservation.js", import.meta.url).href;

/** Spawn a node child running an ESM `-e` script; collect stdout/stderr. */
function spawnNodeEsm(script, env = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, stdout: () => out, stderr: () => err };
}

async function waitUntil(pred, timeoutMs, label) {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("no file -> null; expired -> null; live -> record with default allow + stable key", () => {
  assert.equal(readReservation({ path, now: T0 }), null);
  writeFileSync(path, JSON.stringify({
    owner: "win", reason: "bench", started_at: iso(T0), expires_at: iso(T0 + 1000), allow: [],
  }));
  assert.equal(readReservation({ path, now: T0 + 2000 }), null, "expired reads as absent");
  const r = readReservation({ path, now: T0 + 500 });
  assert.equal(r.owner, "win");
  assert.equal(r.reason, "bench");
  assert.equal(r.corrupt, false);
  assert.deepEqual(r.allow, DEFAULT_ALLOW);
  assert.equal(r.key, "win@" + iso(T0));
});

test("file allow is unioned with DEFAULT_ALLOW (deduped)", () => {
  writeFileSync(path, JSON.stringify({
    owner: "k", reason: "serve", started_at: iso(T0), expires_at: iso(T0 + 60_000), allow: ["my-heavy", DEFAULT_ALLOW[0]],
  }));
  const r = readReservation({ path, now: T0 });
  assert.deepEqual([...r.allow].sort(), [...new Set([...DEFAULT_ALLOW, "my-heavy"])].sort());
});

test("corrupt file -> reserved (fail closed) and flagged; missing expires_at -> corrupt too", () => {
  writeFileSync(path, "{not json");
  const r = readReservation({ path, now: T0 });
  assert.equal(r.corrupt, true);
  assert.equal(r.owner, "unknown");
  assert.equal(r.key, "corrupt");
  assert.equal(isStartAllowed(r, "crow-chat"), false);
  writeFileSync(path, JSON.stringify({ owner: "x", reason: "y" }));
  assert.equal(readReservation({ path, now: T0 }).corrupt, true, "no expiry = unbounded hold = refuse");
});

test("readReservation caches by mtime for a moment but never caches a corrupt read", () => {
  writeFileSync(path, "{bad");
  assert.equal(readReservation({ path, now: T0 }).corrupt, true);
  writeFileSync(path, JSON.stringify({ owner: "ok", reason: "r", started_at: iso(T0), expires_at: iso(T0 + 60_000) }));
  assert.equal(readReservation({ path, now: T0 }).owner, "ok", "a fixed file is seen immediately");
});

test("isStartAllowed: null reservation allows; allow list membership decides", () => {
  assert.equal(isStartAllowed(null, "crow-chat"), true);
  assert.equal(isStartAllowed(undefined, "crow-chat"), true);
  const r = { allow: ["crow-embed", "my-heavy"], corrupt: false };
  assert.equal(isStartAllowed(r, "my-heavy"), true);
  assert.equal(isStartAllowed(r, "crow-embed"), true);
  assert.equal(isStartAllowed(r, "crow-chat"), false);
  assert.equal(isStartAllowed(r, ""), false);
});

test("writeReservation enforces the 8h default max unless force; atomic write; clearReservation removes", () => {
  assert.equal(DEFAULT_MAX_HOLD_MS, 8 * 60 * 60 * 1000);
  assert.throws(() => writeReservation({ owner: "k", reason: "serve", minutes: 9 * 60, path, now: T0 }), RangeError);
  assert.equal(existsSync(path) && readFileSync(path, "utf8").includes('"k"'), false, "refused hold writes nothing");
  const rec = writeReservation({ owner: "k", reason: "serve", minutes: 9 * 60, force: true, allow: ["h"], path, now: T0 });
  assert.equal(rec.expires_at, iso(T0 + 9 * 3600 * 1000));
  assert.equal(rec.started_at, iso(T0));
  assert.deepEqual(rec.allow, ["h"]);
  const back = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(back.owner, "k");
  assert.equal(readReservation({ path, now: T0 + 60_000 }).owner, "k");
  assert.equal(clearReservation({ path }), true);
  assert.equal(existsSync(path), false);
  assert.equal(clearReservation({ path }), false);
});

test("writeReservation defaults minutes to 480 and rejects empty owner", () => {
  const rec = writeReservation({ owner: "k", reason: "r", path, now: T0 });
  assert.equal(rec.expires_at, iso(T0 + 480 * 60_000));
  assert.throws(() => writeReservation({ owner: "", reason: "r", path, now: T0 }), /owner/);
  clearReservation({ path });
});

test("ReservedError carries code/http/owner/expires_at/provider and a readable message", () => {
  const e = new ReservedError({ owner: "win", expires_at: "2026-09-04T21:00:00.000Z" }, "crow-chat");
  assert.equal(e.code, "box_reserved");
  assert.equal(e.http, 503);
  assert.equal(e.owner, "win");
  assert.equal(e.provider, "crow-chat");
  assert.equal(e.expires_at, "2026-09-04T21:00:00.000Z");
  assert.match(e.message, /reserved by win until 2026-09-04T21:00:00\.000Z/);
  assert.ok(e instanceof Error);
});

test("reservationPath honors CROW_BOX_RESERVATION_PATH and defaults under /run/user/<uid>", () => {
  const prev = process.env.CROW_BOX_RESERVATION_PATH;
  try {
    process.env.CROW_BOX_RESERVATION_PATH = "/tmp/x/r.json";
    assert.equal(reservationPath(), "/tmp/x/r.json");
    delete process.env.CROW_BOX_RESERVATION_PATH;
    assert.match(reservationPath(), /^\/run\/user\/\d+\/crow-box-reservation\.json$/);
  } finally {
    if (prev === undefined) delete process.env.CROW_BOX_RESERVATION_PATH; else process.env.CROW_BOX_RESERVATION_PATH = prev;
  }
});

// --- v2 hold fields: a legacy record still reads exactly as before ----------

test("legacy record reads as exclusive with null v2 fields", () => {
  const d = mkdtempSync(join(tmpdir(), "box-legacy-"));
  const p = join(d, "reservation.json");
  // The shape a shell-script window writes: no mode, no kind, no booking.
  writeFileSync(p, JSON.stringify({
    owner: "dsv4-window-20260904",
    reason: "dsv4 nightly benchmark",
    started_at: iso(T0),
    expires_at: iso(T0 + 8 * 3600_000),
    allow: ["my-heavy"],
  }, null, 2) + "\n");
  const r = readReservation({ path: p, now: T0 });
  assert.equal(r.corrupt, false);
  assert.equal(r.owner, "dsv4-window-20260904");
  assert.equal(r.key, "dsv4-window-20260904@" + iso(T0));
  assert.equal(r.mode, "exclusive");
  assert.equal(r.kind, null);
  assert.equal(r.booking_id, null);
  assert.equal(r.job_id, null);
  assert.equal(r.gtt_mb, null);
  assert.equal(r.host_ram_mb, null);
  assert.equal(r.hip_procs, null);
  assert.ok(r.allow.includes("crow-embed"));
  assert.ok(r.allow.includes("my-heavy"));
});

test("v2 beside record round-trips", () => {
  const d = mkdtempSync(join(tmpdir(), "box-beside-"));
  const p = join(d, "reservation.json");
  writeFileSync(p, JSON.stringify({
    owner: "gpujob-7f3a",
    reason: "render batch",
    started_at: iso(T0),
    expires_at: iso(T0 + 3_600_000),
    allow: ["crow-embed"],
    mode: "beside",
    kind: "gpu-job",
    booking_id: "bk_0123456789ab",
    job_id: "job_42",
    gtt_mb: 50000,
    host_ram_mb: 32768,
    hip_procs: 4,
  }));
  const r = readReservation({ path: p, now: T0 });
  assert.equal(r.corrupt, false);
  assert.equal(r.mode, "beside");
  assert.equal(r.kind, "gpu-job");
  assert.equal(r.booking_id, "bk_0123456789ab");
  assert.equal(r.job_id, "job_42");
  assert.equal(r.gtt_mb, 50000);
  assert.equal(r.host_ram_mb, 32768);
  assert.equal(r.hip_procs, 4);
  assert.equal(r.owner, "gpujob-7f3a");
  assert.equal(isStartAllowed(r, "crow-chat"), false, "a beside hold still needs the gate to decide");
});

test("an unknown mode string fails closed", () => {
  const d = mkdtempSync(join(tmpdir(), "box-badmode-"));
  const p = join(d, "reservation.json");
  writeFileSync(p, JSON.stringify({
    owner: "x", reason: "r", started_at: iso(T0), expires_at: iso(T0 + 60_000), mode: "weird",
  }));
  const r = readReservation({ path: p, now: T0 });
  assert.equal(r.corrupt, true);
  assert.equal(r.mode, "exclusive");
  assert.equal(r.kind, null);
  assert.equal(isStartAllowed(r, "crow-embed"), false);
});

// --- the lock --------------------------------------------------------------

test("withReservationLock serialises two processes", async () => {
  const d = mkdtempSync(join(tmpdir(), "box-lock-two-"));
  const lockFile = join(d, "crow-box-schedule.lock");
  const log = join(d, "sections.txt");
  const script = `
import { withReservationLock } from ${JSON.stringify(MODULE_URL)};
import { appendFileSync } from "node:fs";
const id = process.env.CHILD_ID;
for (let i = 0; i < 200; i++) {
  withReservationLock(() => {
    appendFileSync(process.env.CHILD_LOG, id + ":start\\n");
    appendFileSync(process.env.CHILD_LOG, id + ":end\\n");
  }, { path: process.env.CHILD_LOCK, timeoutMs: 60000 });
}
`;
  const a = spawnNodeEsm(script, { CHILD_ID: "a", CHILD_LOG: log, CHILD_LOCK: lockFile });
  const b = spawnNodeEsm(script, { CHILD_ID: "b", CHILD_LOG: log, CHILD_LOCK: lockFile });
  let ra;
  let rb;
  try {
    [ra, rb] = await Promise.all([a.exited, b.exited]);
  } finally {
    a.child.kill();
    b.child.kill();
  }
  assert.deepEqual(ra, { code: 0, signal: null }, "child a: " + a.stderr());
  assert.deepEqual(rb, { code: 0, signal: null }, "child b: " + b.stderr());
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 800);
  assert.equal(lines.filter((l) => l.startsWith("a:")).length, 400);
  assert.equal(lines.filter((l) => l.startsWith("b:")).length, 400);
  for (let i = 0; i < lines.length; i += 2) {
    const id = lines[i].split(":")[0];
    assert.equal(lines[i], id + ":start", `line ${i} must open a critical section`);
    assert.equal(lines[i + 1], id + ":end", `line ${i + 1} must close the same child's section`);
  }
  assert.equal(existsSync(lockFile), false, "the last unlock leaves no lock file");
});

test("a stale lock from a dead pid is broken", () => {
  const d = mkdtempSync(join(tmpdir(), "box-lock-stale-"));
  const lockFile = join(d, "crow-box-schedule.lock");
  writeFileSync(lockFile, "999999");
  const started = Date.now();
  const got = withReservationLock(() => "inside", { path: lockFile, timeoutMs: 1000 });
  assert.equal(got, "inside");
  assert.ok(Date.now() - started < 1000, `took the lock at once (${Date.now() - started} ms)`);
  assert.equal(existsSync(lockFile), false);
});

test("a live foreign lock times out", async () => {
  const d = mkdtempSync(join(tmpdir(), "box-lock-live-"));
  const lockFile = join(d, "crow-box-schedule.lock");
  const script = `
import { withReservationLockAsync } from ${JSON.stringify(MODULE_URL)};
await withReservationLockAsync(async () => {
  process.stdout.write("held\\n");
  await new Promise((r) => setTimeout(r, 3000));
}, { path: process.env.CHILD_LOCK, timeoutMs: 60000 });
`;
  const holder = spawnNodeEsm(script, { CHILD_LOCK: lockFile });
  try {
    await waitUntil(() => holder.stdout().includes("held"), 5000, "the holder child");
    const started = Date.now();
    let err = null;
    try {
      withReservationLock(() => "must not run", { path: lockFile, timeoutMs: 500 });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - started;
    assert.ok(err, "the lock must not be taken while the child holds it");
    assert.equal(err.code, "box_lock_timeout");
    assert.ok(elapsed >= 450, `waited about timeoutMs (${elapsed} ms)`);
    assert.ok(elapsed < 2500, `gave up before the child released (${elapsed} ms)`);
  } finally {
    holder.child.kill();
  }
});

test("withReservationLockAsync does not block the event loop", async () => {
  const d = mkdtempSync(join(tmpdir(), "box-lock-async-"));
  const lockFile = join(d, "crow-box-schedule.lock");
  const script = `
import { withReservationLockAsync } from ${JSON.stringify(MODULE_URL)};
await withReservationLockAsync(async () => {
  process.stdout.write("held\\n");
  await new Promise((r) => setTimeout(r, 800));
}, { path: process.env.CHILD_LOCK, timeoutMs: 60000 });
`;
  const holder = spawnNodeEsm(script, { CHILD_LOCK: lockFile });
  let ticks = 0;
  let timer = null;
  try {
    await waitUntil(() => holder.stdout().includes("held"), 5000, "the holder child");
    timer = setInterval(() => { ticks++; }, 10);
    const got = await withReservationLockAsync(() => "inside", { path: lockFile, timeoutMs: 5000 });
    assert.equal(got, "inside");
  } finally {
    if (timer) clearInterval(timer);
    holder.child.kill();
  }
  assert.ok(ticks >= 5, `timers kept firing while waiting (${ticks} ticks)`);
});

test("the lock path follows the schedule path, not the hold path", () => {
  const prevSchedule = process.env.CROW_BOX_SCHEDULE_PATH;
  const prevHold = process.env.CROW_BOX_RESERVATION_PATH;
  const base = mkdtempSync(join(tmpdir(), "box-lock-path-"));
  try {
    process.env.CROW_BOX_SCHEDULE_PATH = join(base, "a", "box-schedule.json");
    process.env.CROW_BOX_RESERVATION_PATH = join(base, "hold", "reservation.json");
    assert.equal(schedulePath(), join(base, "a", "box-schedule.json"));
    assert.equal(lockPath(), join(base, "a", "crow-box-schedule.lock"));
    assert.equal(lockPath(join(base, "b", "custom.lock")), join(base, "b", "custom.lock"), "an explicit path IS the lock file");
  } finally {
    if (prevSchedule === undefined) delete process.env.CROW_BOX_SCHEDULE_PATH; else process.env.CROW_BOX_SCHEDULE_PATH = prevSchedule;
    if (prevHold === undefined) delete process.env.CROW_BOX_RESERVATION_PATH; else process.env.CROW_BOX_RESERVATION_PATH = prevHold;
  }
});
