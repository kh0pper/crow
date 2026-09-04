// tests/box-reservation.test.js
//
// The box-reservation file is the shared signal between unattended GPU
// windows (pi-lab dsv4-window.sh writes it) and the gateway's
// gpu-orchestrator (reads it before ANY model start). Spec:
// docs/superpowers/specs/2026-09-04-box-reservation-scheduling-scope.md §3.1.
//
// Contract pinned here: missing/expired -> null; corrupt -> reserved (fail
// closed); DEFAULT_ALLOW always unioned in; 8h default max hold unless force.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReservation, isStartAllowed, writeReservation, clearReservation,
  ReservedError, DEFAULT_ALLOW, DEFAULT_MAX_HOLD_MS, reservationPath,
} from "../servers/gateway/box-reservation.js";

const dir = mkdtempSync(join(tmpdir(), "box-res-"));
const path = join(dir, "r.json");
const T0 = Date.parse("2026-09-04T20:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

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
