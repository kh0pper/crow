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
import { mkdtempSync, writeFileSync, existsSync, readFileSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  readReservation, isStartAllowed, writeReservation, clearReservation,
  ReservedError, DEFAULT_ALLOW, DEFAULT_MAX_HOLD_MS, reservationPath,
  schedulePath, lockPath, withReservationLock, withReservationLockAsync,
  activateHold, renewHold, releaseHold, HoldConflictError, startDecision,
  processStartMs, _activateHoldLocked, _renewHoldLocked, _releaseHoldLocked,
  _setProcessStartForTest, _setBeforeEmptyLockStealForTest,
} from "../servers/gateway/box-reservation.js";

// The box-calendar lock lives beside the CALENDAR file, and the activate /
// renew / release wrappers take it on every call. Point the calendar (and so
// the lock) into a scratch directory before anything here touches a hold, so
// no lock file can ever land in the real state directory.
const STATE_DIR = mkdtempSync(join(tmpdir(), "box-res-state-"));
process.env.CROW_BOX_SCHEDULE_PATH = join(STATE_DIR, "box-schedule.json");

/** A hold file, and a lock file, both in a directory of their own. */
function freshHold() {
  const d = mkdtempSync(join(tmpdir(), "box-hold-"));
  return { dir: d, path: join(d, "r.json"), lock: { path: join(d, "crow-box-schedule.lock"), timeoutMs: 2000 } };
}

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

test("a freshly created empty lock file is not stolen, an old empty one is", () => {
  // The creator does openSync("wx") and only then writes its pid; between
  // those two calls the file is empty. Stealing it there would hand the lock
  // to two processes at once.
  const d = mkdtempSync(join(tmpdir(), "box-lock-empty-"));
  const lockFile = join(d, "crow-box-schedule.lock");
  writeFileSync(lockFile, "");
  assert.throws(
    () => withReservationLock(() => "must not run", { path: lockFile, timeoutMs: 300 }),
    (e) => e && e.code === "box_lock_timeout",
    "a young empty lock file is waited for, not broken",
  );
  assert.equal(existsSync(lockFile), true, "the young empty lock file is left in place");
  const past = new Date(Date.now() - 10_000);
  utimesSync(lockFile, past, past);
  assert.equal(withReservationLock(() => "inside", { path: lockFile, timeoutMs: 2000 }), "inside");
  assert.equal(existsSync(lockFile), false, "the old empty lock was broken and then released");
});

// --- owner-checked activate / renew / release -------------------------------

test("activate refuses a foreign unexpired hold", () => {
  const h = freshHold();
  activateHold({ owner: "win", reason: "bench", minutes: 60, path: h.path, now: T0, lock: h.lock });
  assert.throws(
    () => activateHold({ owner: "casey", reason: "mine", minutes: 60, path: h.path, now: T0 + 60_000, lock: h.lock }),
    (e) => e instanceof HoldConflictError
      && e.code === "box_held"
      && e.holder === "win"
      && e.message.includes("win")
      && e.message.includes(iso(T0 + 3_600_000)),
    "names the holder and its expiry",
  );
  assert.equal(readReservation({ path: h.path, now: T0 + 60_000 }).owner, "win", "the holder's record is untouched");
  assert.equal(readReservation({ path: h.path, now: T0 + 60_000 }).expires_at, iso(T0 + 3_600_000));
  // A file we cannot read fails closed the same way, with holder "unknown".
  writeFileSync(h.path, "{not json");
  assert.throws(
    () => activateHold({ owner: "casey", minutes: 5, path: h.path, now: T0, lock: h.lock }),
    (e) => e instanceof HoldConflictError && e.code === "box_held" && e.holder === "unknown",
  );
});

test("activate over an expired foreign hold succeeds", () => {
  const h = freshHold();
  writeFileSync(h.path, JSON.stringify({
    owner: "win", reason: "yesterday", started_at: iso(T0 - 3_600_000), expires_at: iso(T0 - 1000), allow: [],
  }));
  const rec = activateHold({ owner: "casey", reason: "tonight", minutes: 30, path: h.path, now: T0, lock: h.lock });
  assert.equal(rec.owner, "casey");
  assert.equal(rec.started_at, iso(T0));
  assert.equal(rec.expires_at, iso(T0 + 1_800_000));
  const back = readReservation({ path: h.path, now: T0 });
  assert.equal(back.owner, "casey");
  assert.equal(back.reason, "tonight");
});

test("activate by the same owner replaces its own hold", () => {
  const h = freshHold();
  const first = activateHold({ owner: "win", minutes: 60, path: h.path, now: T0, lock: h.lock });
  const second = activateHold({ owner: "win", minutes: 30, path: h.path, now: T0 + 600_000, lock: h.lock });
  assert.equal(first.started_at, iso(T0));
  assert.equal(second.started_at, iso(T0 + 600_000), "a re-activate starts a fresh record");
  assert.equal(second.expires_at, iso(T0 + 600_000 + 1_800_000));
  assert.equal(readReservation({ path: h.path, now: T0 + 600_000 }).expires_at, iso(T0 + 2_400_000));
});

test("renew keeps started_at and the notice key", () => {
  const h = freshHold();
  activateHold({
    owner: "gpujob-7f3a", reason: "render batch", minutes: 20, mode: "beside", kind: "gpu-job",
    booking_id: "bk_0123456789ab", job_id: "job_42", gtt_mb: 50000, host_ram_mb: 32768, hip_procs: 4,
    allow: ["crow-embed"], path: h.path, now: T0, lock: h.lock,
  });
  const before = readReservation({ path: h.path, now: T0 });
  const rec = renewHold({ owner: "gpujob-7f3a", minutes: 20, path: h.path, now: T0 + 300_000, lock: h.lock });
  const after = readReservation({ path: h.path, now: T0 + 300_000 });
  assert.equal(after.key, before.key, "the notice key is owner@started_at and does not move");
  assert.equal(after.started_at, iso(T0));
  assert.equal(after.expires_at, iso(T0 + 300_000 + 1_200_000));
  assert.notEqual(after.expires_at, before.expires_at, "the expiry moved");
  assert.equal(rec.expires_at, after.expires_at);
  assert.equal(after.reason, "render batch");
  assert.equal(after.mode, "beside");
  assert.equal(after.kind, "gpu-job");
  assert.equal(after.booking_id, "bk_0123456789ab");
  assert.equal(after.job_id, "job_42");
  assert.equal(after.gtt_mb, 50000);
  assert.equal(after.host_ram_mb, 32768);
  assert.equal(after.hip_procs, 4);
  assert.deepEqual(after.allow, before.allow);
});

test("renew by a non-holder throws box_held", () => {
  const h = freshHold();
  activateHold({ owner: "win", minutes: 60, path: h.path, now: T0, lock: h.lock });
  assert.throws(
    () => renewHold({ owner: "casey", minutes: 20, path: h.path, now: T0 + 60_000, lock: h.lock }),
    (e) => e instanceof HoldConflictError && e.code === "box_held" && e.holder === "win",
  );
  const back = readReservation({ path: h.path, now: T0 + 60_000 });
  assert.equal(back.owner, "win");
  assert.equal(back.expires_at, iso(T0 + 3_600_000), "the holder's expiry is untouched");
});

test("renew past notAfter throws renew_past_next_booking", () => {
  const h = freshHold();
  activateHold({ owner: "win", minutes: 60, path: h.path, now: T0, lock: h.lock });
  assert.throws(
    () => renewHold({
      owner: "win", minutes: 60, notAfter: T0 + 30 * 60_000, path: h.path, now: T0 + 10 * 60_000, lock: h.lock,
    }),
    (e) => e instanceof RangeError && e.message.includes("renew_past_next_booking"),
  );
  assert.equal(readReservation({ path: h.path, now: T0 + 10 * 60_000 }).expires_at, iso(T0 + 3_600_000));
  const rec = renewHold({
    owner: "win", minutes: 20, notAfter: T0 + 60 * 60_000, path: h.path, now: T0 + 10 * 60_000, lock: h.lock,
  });
  assert.equal(rec.expires_at, iso(T0 + 30 * 60_000), "an extension that ends before notAfter is fine");
});

test("renew after rm -f (legacy teardown) throws box_held with holder null", () => {
  const h = freshHold();
  activateHold({ owner: "win", minutes: 60, path: h.path, now: T0, lock: h.lock });
  unlinkSync(h.path);
  assert.throws(
    () => renewHold({ owner: "win", minutes: 20, path: h.path, now: T0 + 60_000, lock: h.lock }),
    (e) => e instanceof HoldConflictError && e.code === "box_held" && e.holder === null,
  );
  assert.equal(existsSync(h.path), false, "renew never recreates a removed hold");
});

test("release by a non-holder returns false and leaves the file", () => {
  const h = freshHold();
  activateHold({ owner: "win", minutes: 60, path: h.path, now: T0, lock: h.lock });
  const before = readFileSync(h.path, "utf8");
  assert.equal(releaseHold({ owner: "casey", path: h.path, lock: h.lock }), false);
  assert.equal(existsSync(h.path), true);
  assert.equal(readFileSync(h.path, "utf8"), before, "the holder's record is byte-for-byte unchanged");
  assert.equal(releaseHold({ owner: "win", path: h.path, lock: h.lock }), true, "the holder may release");
  assert.equal(existsSync(h.path), false);
  assert.equal(releaseHold({ owner: "win", path: h.path, lock: h.lock }), false, "no hold -> false");
});

test("release --force removes any hold", () => {
  const h = freshHold();
  activateHold({ owner: "win", minutes: 60, path: h.path, now: T0, lock: h.lock });
  assert.equal(releaseHold({ owner: "casey", force: true, path: h.path, lock: h.lock }), true);
  assert.equal(existsSync(h.path), false);
  // Removing one's own already-expired hold is still a release.
  activateHold({ owner: "win", minutes: 5, path: h.path, now: T0, lock: h.lock });
  assert.equal(releaseHold({ owner: "win", path: h.path, now: T0 + 10 * 60_000, lock: h.lock }), true);
  assert.equal(existsSync(h.path), false);
});

test("the 8 h cap applies per call and to a non-gpu-job's total span", () => {
  const h = freshHold();
  assert.throws(
    () => activateHold({ owner: "win", minutes: 481, path: h.path, now: T0, lock: h.lock }),
    (e) => e instanceof RangeError && /8h/.test(e.message),
  );
  assert.equal(existsSync(h.path), false, "a refused activate writes nothing");
  // No `kind`: the legacy record, capped on its total span.
  activateHold({ owner: "win", reason: "window", minutes: 480, path: h.path, now: T0, lock: h.lock });
  assert.throws(
    () => renewHold({ owner: "win", minutes: 481, path: h.path, now: T0 + 60_000, lock: h.lock }),
    (e) => e instanceof RangeError && /8h/.test(e.message),
    "per call",
  );
  assert.throws(
    () => renewHold({ owner: "win", minutes: 20, path: h.path, now: T0 + 470 * 60_000, lock: h.lock }),
    (e) => e instanceof RangeError && /8h/.test(e.message),
    "total span from started_at",
  );
  const rec = renewHold({ owner: "win", minutes: 20, force: true, path: h.path, now: T0 + 470 * 60_000, lock: h.lock });
  assert.equal(rec.expires_at, iso(T0 + 490 * 60_000), "force allows both caps to be exceeded");
  assert.equal(rec.started_at, iso(T0));
  // A named non-gpu-job kind is capped the same way.
  const h2 = freshHold();
  activateHold({ owner: "win", kind: "window", minutes: 470, path: h2.path, now: T0, lock: h2.lock });
  assert.throws(
    () => renewHold({ owner: "win", minutes: 30, path: h2.path, now: T0 + 460 * 60_000, lock: h2.lock }),
    (e) => e instanceof RangeError && /8h/.test(e.message),
  );
});

test("gpu-job hold renews past 8 h of total span", () => {
  const h = freshHold();
  activateHold({
    owner: "gpujob-9c1d", reason: "render batch", minutes: 480, mode: "beside", kind: "gpu-job",
    booking_id: "bk_0123456789ab", job_id: "job_7", gtt_mb: 50000, host_ram_mb: 32768, hip_procs: 4,
    path: h.path, now: T0, lock: h.lock,
  });
  let now = T0;
  for (let i = 0; i < 120; i++) { // 600 min of wall clock in 5 min steps, 20 min leases
    now += 5 * 60_000;
    const rec = renewHold({ owner: "gpujob-9c1d", minutes: 20, path: h.path, now, lock: h.lock });
    assert.equal(rec.started_at, iso(T0));
  }
  const back = readReservation({ path: h.path, now });
  assert.equal(back.kind, "gpu-job");
  assert.equal(back.owner, "gpujob-9c1d");
  assert.ok(
    Date.parse(back.expires_at) - T0 > DEFAULT_MAX_HOLD_MS,
    `renewed past 8 h of total span (${Date.parse(back.expires_at) - T0} ms)`,
  );
});

// --- beside mode: what a start may do while a render/video job shares the box --
//
// Everything here is pure: no file, no sysfs. `live` is the sampler's last
// snapshot, `peak` the provider's declared footprint from the host profile.

const PROFILE = { safety_margin_mb: 8192, ram_floor_mb: 12288, gtt_total_mb: 131072 };
// These fixtures describe a hold that began at T0 while this process has been
// up since a minute before it, so the admitted-peak tally counts as known. The
// gateway-restart case sets its own process start (see the test below).
const PROC = T0 - 60_000;
_setProcessStartForTest(PROC);

/** A beside hold whose job has booked 50000 mb of GTT and 30000 mb of RAM. */
function besideReservation(over = {}) {
  return {
    owner: "gpujob-7f3a", reason: "render batch", started_at: iso(T0), expires_at: iso(T0 + 3_600_000),
    allow: ["crow-embed"], corrupt: false, key: "gpujob-7f3a@" + iso(T0),
    mode: "beside", kind: "gpu-job", booking_id: "bk_0123456789ab", job_id: "job_42",
    gtt_mb: 50000, host_ram_mb: 30000,
    gtt_used_at_activation_mb: null, mem_available_at_activation_mb: null,
    hip_procs: 4,
    ...over,
  };
}

const LIVE = Object.freeze({ gttUsedMb: 20000, gttTotalMb: 131072, memAvailableMb: 110000 });
const liveAt = (at, over = {}) => ({ ...LIVE, at, ...over });
// A 35B-class provider: 26000 mb of GTT and of host RAM.
const PEAK = Object.freeze({ gtt_peak_mb: 26000, host_ram_peak_mb: 26000 });

test("startDecision: exclusive hold behaves like isStartAllowed and ignores live", () => {
  const boom = new Proxy({}, {
    get(_t, prop) { throw new Error(`an exclusive hold must never read ${String(prop)}`); },
  });
  const exclusive = { owner: "win", expires_at: iso(T0 + 3_600_000), allow: ["crow-embed"], corrupt: false, mode: "exclusive" };
  assert.deepEqual(
    startDecision(exclusive, "crow-embed", { peak: boom, live: boom, profile: boom, now: T0 }),
    { allowed: true, reason: null },
  );
  assert.deepEqual(
    startDecision(exclusive, "crow-chat", { peak: boom, live: boom, profile: boom, now: T0 }),
    { allowed: false, reason: "reserved" },
  );
  // A legacy record has no mode at all; it reads as exclusive.
  assert.deepEqual(startDecision({ allow: ["crow-embed"], corrupt: false }, "crow-chat", { now: T0 }), { allowed: false, reason: "reserved" });
  // Undefined live/peak/profile are fine on this path too.
  assert.deepEqual(startDecision(exclusive, "crow-embed", {}), { allowed: true, reason: null });
  // No reservation, and a corrupt one (fail closed).
  assert.deepEqual(startDecision(null, "crow-chat", {}), { allowed: true, reason: null });
  assert.deepEqual(startDecision({ corrupt: true, allow: [] }, "crow-embed", {}), { allowed: false, reason: "reserved" });
});

test("startDecision beside: a provider whose peak fits is allowed", () => {
  const d = startDecision(besideReservation(), "crow-chat", { peak: PEAK, live: liveAt(T0), profile: PROFILE, now: T0 });
  assert.deepEqual(d, { allowed: true, reason: null });
});

test("startDecision beside: a provider whose peak does not fit is refused with reason gpu_job_beside", () => {
  const tooBig = { gtt_peak_mb: 80000, host_ram_peak_mb: 26000 };
  assert.deepEqual(
    startDecision(besideReservation(), "crow-chat", { peak: tooBig, live: liveAt(T0), profile: PROFILE, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  // RAM alone can refuse a start that fits in GTT.
  const ramHog = { gtt_peak_mb: 1000, host_ram_peak_mb: 100000 };
  assert.deepEqual(
    startDecision(besideReservation(), "crow-chat", { peak: ramHog, live: liveAt(T0), profile: PROFILE, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
});

test("startDecision beside: unknown peak is refused", () => {
  assert.deepEqual(
    startDecision(besideReservation(), "crow-chat", { peak: null, live: liveAt(T0), profile: PROFILE, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  assert.deepEqual(
    startDecision(besideReservation(), "crow-chat", { peak: undefined, live: null, profile: PROFILE, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
});

test("startDecision beside: allow[] providers always start", () => {
  // No peak, no snapshot, no profile: the allow list alone decides.
  assert.deepEqual(
    startDecision(besideReservation(), "crow-embed", { peak: null, live: null, profile: null, now: T0 }),
    { allowed: true, reason: null },
  );
});

test("during the job's load phase a 35B-sized start is refused although live GTT alone would fit", () => {
  // Activation: the job began when 20000 mb were already in use.
  const r = besideReservation({ gtt_mb: 90000, gtt_used_at_activation_mb: 20000, host_ram_mb: 30000, mem_available_at_activation_mb: 100000 });
  // The job is half loaded: 60000 mb in use, 40000 mb of its 90000 still coming.
  const live = { gttUsedMb: 60000, gttTotalMb: 131072, memAvailableMb: 90000, at: T0 };
  const budget = live.gttTotalMb - PROFILE.safety_margin_mb;
  assert.ok(live.gttUsedMb + PEAK.gtt_peak_mb <= budget, "live GTT plus the peak alone would fit");
  assert.ok(live.gttUsedMb + 50000 + PEAK.gtt_peak_mb > budget, "with the job's remaining growth it does not");
  assert.deepEqual(
    startDecision(r, "crow-chat", { peak: PEAK, live, profile: PROFILE, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  // A provider small enough for the job's final footprint still starts: the
  // gate sizes the start, it does not refuse every start.
  const small = { gtt_peak_mb: 5000, host_ram_peak_mb: 2000 };
  assert.deepEqual(
    startDecision(r, "crow-embed-small", { peak: small, live, profile: PROFILE, now: T0 }),
    { allowed: true, reason: null },
  );
});

test("a prod provider started beside an active hold doesn't eat the hold's remainder", () => {
  // The job booked 40000 mb of GTT and began when 60000 mb were already in use.
  const r = besideReservation({
    gtt_mb: 40000, host_ram_mb: 30000,
    gtt_used_at_activation_mb: 60000, mem_available_at_activation_mb: 100000,
  });
  // A prod provider was admitted beside it (declared peak 10000) and the job
  // itself has taken 5000 since activation: 60000 + 10000 + 5000 = 75000.
  const admitted = { gtt_peak_mb: 10000, host_ram_peak_mb: 4000 };
  const live = { gttUsedMb: 75000, gttTotalMb: 131072, memAvailableMb: 96000, at: T0 };
  const budget = live.gttTotalMb - PROFILE.safety_margin_mb; // 122880
  // The job's own growth is 5000, so 35000 mb of its booking is still to come.
  const fits = { gtt_peak_mb: budget - live.gttUsedMb - 35000, host_ram_peak_mb: 1000 };
  assert.equal(fits.gtt_peak_mb, 12880);
  assert.deepEqual(
    startDecision(r, "crow-chat", { peak: fits, live, profile: PROFILE, admitted, now: T0 }),
    { allowed: true, reason: null },
  );
  assert.deepEqual(
    startDecision(r, "crow-chat", { peak: { ...fits, gtt_peak_mb: fits.gtt_peak_mb + 1 }, live, profile: PROFILE, admitted, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  // Without `admitted` the prod provider's growth is charged to the job, which
  // then looks like it has only 25000 still to come: this peak would be let
  // through although the job's booking leaves 10000 mb less room than that.
  const tooBig = { gtt_peak_mb: 20000, host_ram_peak_mb: 1000 };
  assert.deepEqual(
    startDecision(r, "crow-chat", { peak: tooBig, live, profile: PROFILE, admitted, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  assert.deepEqual(
    startDecision(r, "crow-chat", { peak: tooBig, live, profile: PROFILE, now: T0 }),
    { allowed: true, reason: null },
  );
});

test("the job growing past its booking is refused and flagged", () => {
  const r = besideReservation({
    gtt_mb: 40000, host_ram_mb: 30000,
    gtt_used_at_activation_mb: 60000, mem_available_at_activation_mb: 100000,
  });
  // 105000 - 60000 = 45000 mb of growth, more than the 40000 mb it booked.
  const live = { gttUsedMb: 105000, gttTotalMb: 131072, memAvailableMb: 97000, at: T0 };
  const small = { gtt_peak_mb: 1000, host_ram_peak_mb: 1000 };
  assert.deepEqual(
    startDecision(r, "crow-chat", { peak: small, live, profile: PROFILE, now: T0 }),
    { allowed: false, reason: "gpu_job_beside", job_over_budget: true },
  );
  // The allow list still starts (it never reads the live counters here).
  assert.deepEqual(
    startDecision(r, "crow-embed", { peak: PEAK, live, profile: PROFILE, now: T0 }),
    { allowed: true, reason: null },
  );
  // The flag follows the job's OWN growth: with 6000 mb of that growth coming
  // from a provider admitted beside the hold, 39000 mb went to the job and the
  // booking still holds.
  const admitted = { gtt_peak_mb: 6000, host_ram_peak_mb: 3000 };
  const d = startDecision(r, "crow-chat", { peak: { gtt_peak_mb: 16000, host_ram_peak_mb: 1000 }, live, profile: PROFILE, admitted, now: T0 });
  assert.deepEqual(d, { allowed: true, reason: null });
  assert.equal(d.job_over_budget, undefined);
});

test("stale snapshot refuses beside starts", () => {
  const now = T0 + 60_000;
  assert.deepEqual(
    startDecision(besideReservation(), "crow-chat", { peak: PEAK, live: liveAt(now), profile: PROFILE, now }),
    { allowed: true, reason: null },
  );
  assert.deepEqual(
    startDecision(besideReservation(), "crow-chat", { peak: PEAK, live: liveAt(now - 14_999), profile: PROFILE, now }),
    { allowed: true, reason: null },
  );
  assert.deepEqual(
    startDecision(besideReservation(), "crow-chat", { peak: PEAK, live: liveAt(now - 15_001), profile: PROFILE, now }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  // A snapshot with no usable timestamp is stale by definition.
  assert.deepEqual(
    startDecision(besideReservation(), "crow-chat", { peak: PEAK, live: { ...LIVE }, profile: PROFILE, now }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  // The allow list still wins on a stale snapshot.
  assert.deepEqual(
    startDecision(besideReservation(), "crow-embed", { peak: PEAK, live: liveAt(now - 600_000), profile: PROFILE, now }),
    { allowed: true, reason: null },
  );
});

test("activateHold beside records the activation baselines", () => {
  const h = freshHold();
  activateHold({
    owner: "gpujob-7f3a", reason: "render batch", minutes: 20, mode: "beside", kind: "gpu-job",
    booking_id: "bk_0123456789ab", job_id: "job_42", gtt_mb: 90000, host_ram_mb: 30000, hip_procs: 4,
    gtt_used_at_activation_mb: 12345, mem_available_at_activation_mb: 67890,
    path: h.path, now: T0, lock: h.lock,
  });
  const r = readReservation({ path: h.path, now: T0 });
  assert.equal(r.mode, "beside");
  assert.equal(r.gtt_used_at_activation_mb, 12345);
  assert.equal(r.mem_available_at_activation_mb, 67890);
  const raw = JSON.parse(readFileSync(h.path, "utf8"));
  assert.equal(raw.gtt_used_at_activation_mb, 12345);
  assert.equal(raw.mem_available_at_activation_mb, 67890);
  // A record written without the baselines reads them back as null, not 0.
  const h2 = freshHold();
  writeFileSync(h2.path, JSON.stringify({
    owner: "win", reason: "bench", started_at: iso(T0), expires_at: iso(T0 + 1000), allow: [],
  }));
  const legacy = readReservation({ path: h2.path, now: T0 });
  assert.equal(legacy.gtt_used_at_activation_mb, null);
  assert.equal(legacy.mem_available_at_activation_mb, null);
  assert.equal(readReservation({ path: join(h2.dir, "corrupt.json"), now: T0 }), null);
  writeFileSync(join(h2.dir, "corrupt.json"), "{bad");
  const corrupt = readReservation({ path: join(h2.dir, "corrupt.json"), now: T0 });
  assert.equal(corrupt.corrupt, true);
  assert.equal(corrupt.gtt_used_at_activation_mb, null);
  assert.equal(corrupt.mem_available_at_activation_mb, null);
});

test("ReservedError carries reason", () => {
  const plain = new ReservedError({ owner: "win", expires_at: iso(T0) }, "crow-chat");
  assert.equal(plain.reason, "reserved");
  assert.match(plain.message, /box reserved by win until /);
  const beside = new ReservedError(
    { owner: "gpujob-7f3a", expires_at: iso(T0), job_id: "job_42", decisionReason: "gpu_job_beside" },
    "crow-chat",
  );
  assert.equal(beside.reason, "gpu_job_beside");
  assert.equal(beside.code, "box_reserved");
  assert.match(beside.message, /render\/video job/);
  assert.match(beside.message, /gpujob-7f3a/);
  assert.match(beside.message, /job_42/);
  assert.match(beside.message, /crow-chat/);
  assert.doesNotMatch(beside.message, /box reserved by/);
  const explicit = new ReservedError({ owner: "win", expires_at: iso(T0) }, "crow-chat", "gpu_job_beside");
  assert.equal(explicit.reason, "gpu_job_beside", "the third argument wins over the reservation");
});

test("inner locked functions run under one outer lock without box_lock_timeout", () => {
  const h = freshHold();
  const out = withReservationLock(() => {
    const activated = _activateHoldLocked({ owner: "win", reason: "composed", minutes: 20, path: h.path, now: T0 });
    const renewed = _renewHoldLocked({ owner: "win", minutes: 20, path: h.path, now: T0 + 60_000 });
    const released = _releaseHoldLocked({ owner: "win", path: h.path });
    return { activated, renewed, released };
  }, h.lock);
  assert.equal(out.activated.owner, "win");
  assert.equal(out.renewed.started_at, iso(T0));
  assert.equal(out.renewed.expires_at, iso(T0 + 60_000 + 1_200_000));
  assert.equal(out.released, true);
  assert.equal(existsSync(h.path), false);
});

// --- a gateway restart under a live beside hold -----------------------------

test("restart under a live beside hold sizes the job at its full booking", () => {
  assert.equal(processStartMs(), PROC, "the seam is what the beside fixtures rely on");
  // The hold began a minute before this gateway process did. Providers started
  // beside it before the restart are not in the admitted tally, so the growth
  // the counters show since activation cannot be told apart from the job's own.
  const r = besideReservation({
    gtt_mb: 60000, host_ram_mb: 30000,
    gtt_used_at_activation_mb: 20000, mem_available_at_activation_mb: 100000,
  });
  const live = { gttUsedMb: 70000, gttTotalMb: 131072, memAvailableMb: 95000, at: T0 };
  const processStart = T0 + 60_000;
  const budget = live.gttTotalMb - PROFILE.safety_margin_mb;
  // Read as the job's own progress, 50000 of its 60000 would look taken and
  // this peak would be admitted into room the job has not taken yet.
  assert.ok(live.gttUsedMb + 10000 + PEAK.gtt_peak_mb <= budget, "the understated reading would admit it");
  assert.deepEqual(
    startDecision(r, "crow-chat", { peak: PEAK, live, profile: PROFILE, now: T0, processStart }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  // The over-budget report is suppressed for the same reason: that growth is
  // not the job's to answer for.
  const tight = besideReservation({
    gtt_mb: 40000, host_ram_mb: 30000,
    gtt_used_at_activation_mb: 20000, mem_available_at_activation_mb: 100000,
  });
  const small = { gtt_peak_mb: 1000, host_ram_peak_mb: 1000 };
  const d = startDecision(tight, "crow-chat", { peak: small, live, profile: PROFILE, now: T0, processStart });
  assert.deepEqual(d, { allowed: true, reason: null });
  assert.equal(d.job_over_budget, undefined, "never called over budget on an unknown tally");
  // The full booking still sizes the start, and a hold that began while this
  // process was up keeps the tally.
  assert.deepEqual(
    startDecision(r, "crow-chat", { peak: { gtt_peak_mb: 20000, host_ram_peak_mb: 1000 }, live, profile: PROFILE, now: T0, processStart }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  assert.deepEqual(
    startDecision(r, "crow-small", { peak: { gtt_peak_mb: 5000, host_ram_peak_mb: 1000 }, live, profile: PROFILE, now: T0, processStart: PROC }),
    { allowed: true, reason: null },
  );
});

// --- a start admitted but not yet loaded still reserves its room ------------

test("A admitted, snapshot unchanged, B refused", () => {
  // The job was activated before either provider loaded: nothing has moved in
  // the live counters, so its whole booking is still to come.
  const r = besideReservation({
    gtt_mb: 60000, host_ram_mb: 30000,
    gtt_used_at_activation_mb: 20000, mem_available_at_activation_mb: 110000,
  });
  const live = { gttUsedMb: 20000, gttTotalMb: 131072, memAvailableMb: 110000, at: T0 };
  const peak = { gtt_peak_mb: 30000, host_ram_peak_mb: 2000 };
  const budget = live.gttTotalMb - PROFILE.safety_margin_mb;
  assert.ok(live.gttUsedMb + 60000 + peak.gtt_peak_mb <= budget, "A fits beside the job");
  assert.deepEqual(
    startDecision(r, "crow-a", { peak, live, profile: PROFILE, now: T0 }),
    { allowed: true, reason: null },
  );
  // A was admitted and has not loaded yet (the snapshot has not moved), so its
  // peak is committed: 20000 (baseline) + 60000 (job) + 30000 (A) + 30000 (B).
  assert.deepEqual(
    startDecision(r, "crow-b", { peak, live, profile: PROFILE, admitted: peak, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
});

// --- a hold with no activation baseline still counts what it admitted ------

test("no activation baseline still counts admitted providers", () => {
  // No baseline was recorded (an older writer, or the counters were unreadable
  // at activation): the whole booking is read as still to come, and a provider
  // admitted beside the hold has spoken for its room even before it loads.
  const r = besideReservation();
  assert.equal(r.gtt_used_at_activation_mb, null);
  assert.equal(r.mem_available_at_activation_mb, null);
  const live = { gttUsedMb: 20000, gttTotalMb: 131072, memAvailableMb: 110000, at: T0 };
  const peak = { gtt_peak_mb: 30000, host_ram_peak_mb: 30000 };
  const budget = live.gttTotalMb - PROFILE.safety_margin_mb; // 122880
  assert.ok(
    live.gttUsedMb + r.gtt_mb + peak.gtt_peak_mb <= budget,
    "on its own the job's booking leaves room for this start",
  );
  assert.deepEqual(
    startDecision(r, "crow-a", { peak, live, profile: PROFILE, now: T0 }),
    { allowed: true, reason: null },
  );
  // 20000 (in use) + 50000 (the job's booking) + 30000 (admitted) + 30000.
  assert.deepEqual(
    startDecision(r, "crow-b", { peak, live, profile: PROFILE, admitted: peak, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  // The same on the RAM side: 110000 - 30000 (booking) - 30000 (admitted)
  // leaves 50000, so this peak fits until the admitted provider is counted.
  const ramPeak = { gtt_peak_mb: 1000, host_ram_peak_mb: 50000 };
  assert.deepEqual(
    startDecision(r, "crow-c", { peak: ramPeak, live, profile: PROFILE, now: T0 }),
    { allowed: true, reason: null },
  );
  assert.deepEqual(
    startDecision(r, "crow-d", { peak: ramPeak, live, profile: PROFILE, admitted: peak, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
  // Only the GTT baseline missing is enough: that side is sized from the live
  // reading, and the admitted peak counts there too.
  const gttOnly = besideReservation({ gtt_used_at_activation_mb: null, mem_available_at_activation_mb: 110000 });
  assert.deepEqual(
    startDecision(gttOnly, "crow-b", { peak, live, profile: PROFILE, admitted: peak, now: T0 }),
    { allowed: false, reason: "gpu_job_beside" },
  );
});

// --- a beside hold without a footprint reserves nothing --------------------

test("a beside hold without a footprint is refused", () => {
  const h = freshHold();
  for (const over of [{}, { gtt_mb: 50000 }, { host_ram_mb: 30000 }, { gtt_mb: 0, host_ram_mb: 30000 }]) {
    assert.throws(
      () => activateHold({
        owner: "gpujob-7f3a", minutes: 20, mode: "beside", kind: "gpu-job",
        path: h.path, now: T0, lock: h.lock, ...over,
      }),
      (e) => e && e.code === "beside_needs_footprint",
      JSON.stringify(over),
    );
  }
  assert.equal(existsSync(h.path), false, "a refused beside hold writes nothing");
  const rec = activateHold({
    owner: "gpujob-7f3a", minutes: 20, mode: "beside", kind: "gpu-job",
    gtt_mb: 50000, host_ram_mb: 30000, path: h.path, now: T0, lock: h.lock,
  });
  assert.equal(rec.mode, "beside");
  // An exclusive hold never needs a footprint.
  const h2 = freshHold();
  assert.equal(activateHold({ owner: "alex", minutes: 20, path: h2.path, now: T0, lock: h2.lock }).owner, "alex");
});

test("startDecision refuses a beside hold with no footprint", () => {
  for (const over of [{ gtt_mb: null }, { host_ram_mb: null }, { gtt_mb: null, host_ram_mb: null }]) {
    assert.deepEqual(
      startDecision(besideReservation(over), "crow-chat", { peak: PEAK, live: liveAt(T0), profile: PROFILE, now: T0 }),
      { allowed: false, reason: "gpu_job_beside" },
      JSON.stringify(over),
    );
  }
  // The allow list does not depend on the job's footprint.
  assert.deepEqual(
    startDecision(besideReservation({ gtt_mb: null }), "crow-embed", { peak: null, live: null, profile: null, now: T0 }),
    { allowed: true, reason: null },
  );
});

// --- the lock across a reboot, the empty-lock steal, and re-entrancy --------

test("a lock file older than 60 s is stale even when its pid is alive", () => {
  const d = mkdtempSync(join(tmpdir(), "box-lock-old-"));
  const lockFile = join(d, "crow-box-schedule.lock");
  // A rebooted box's leftover lock: the pid still exists (an unrelated
  // process), but no critical section lasts a minute.
  writeFileSync(lockFile, String(process.pid));
  const past = new Date(Date.now() - 90_000);
  utimesSync(lockFile, past, past);
  const started = Date.now();
  assert.equal(withReservationLock(() => "inside", { path: lockFile, timeoutMs: 2000 }), "inside");
  assert.ok(Date.now() - started < 1000, `took the lock at once (${Date.now() - started} ms)`);
  assert.equal(existsSync(lockFile), false, "the stolen lock was released again");
});

test("an empty lock replaced between the age check and the steal is put back", () => {
  // The steal's rename is content-blind: a racer (or a creator finishing its
  // pid write) can put a NEW file at the path in that window, and destroying it
  // would hand the lock to two processes.
  const d = mkdtempSync(join(tmpdir(), "box-lock-replaced-"));
  const lockFile = join(d, "crow-box-schedule.lock");
  writeFileSync(lockFile, "");
  const past = new Date(Date.now() - 10_000);
  utimesSync(lockFile, past, past);
  let swaps = 0;
  _setBeforeEmptyLockStealForTest(() => {
    swaps++;
    unlinkSync(lockFile);
    writeFileSync(lockFile, ""); // young again: someone else's lock
  });
  try {
    assert.throws(
      () => withReservationLock(() => "must not run", { path: lockFile, timeoutMs: 400 }),
      (e) => e && e.code === "box_lock_timeout",
    );
  } finally {
    _setBeforeEmptyLockStealForTest(null);
  }
  assert.equal(swaps, 1, "only the genuinely old file was considered for a steal");
  assert.equal(existsSync(lockFile), true, "the young lock was put back, not destroyed");
});

test("the sync lock refuses to wait on itself (re-entrancy)", () => {
  const d = mkdtempSync(join(tmpdir(), "box-lock-reentrant-"));
  const lockFile = join(d, "crow-box-schedule.lock");
  let inner = null;
  const started = Date.now();
  withReservationLock(() => {
    try {
      withReservationLock(() => "must not run", { path: lockFile, timeoutMs: 5000 });
    } catch (e) {
      inner = e;
    }
  }, { path: lockFile, timeoutMs: 5000 });
  assert.ok(inner, "the nested acquire must not be silent");
  assert.equal(inner.code, "box_lock_reentrant");
  assert.ok(Date.now() - started < 1000, `it said so at once (${Date.now() - started} ms)`);
});
