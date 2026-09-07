/**
 * Phase 4 — around.js: everything the AR view can point at, around a point.
 * Rows come back AS STORED (teasers included) plus distance_m; a coarse row
 * is located at its cell centre and kept when the cell could hold a point in
 * range. No HTTP; the route's annotation (approx_lat, contact_name) is the
 * panel test's job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark, insertRemoteMark } from "../bundles/ramble/server/marks.js";
import { haversineMeters } from "../bundles/ramble/server/anchors.js";
import { isoWeek } from "../bundles/ramble/server/eggs.js";
import {
  AROUND_RADIUS_DEFAULT, AROUND_RADIUS_MIN, AROUND_RADIUS_MAX, bboxAround, locate, aroundPoint,
} from "../bundles/ramble/server/around.js";

const T0 = Date.UTC(2026, 8, 7, 12);
const HERE = { lat: 30.46, lon: -98.08 };
const NORTH_100 = { lat: 30.460898, lon: -98.08 };
const EAST_100 = { lat: 30.46, lon: -98.078958 };
const NORTH_900 = { lat: 30.4681, lon: -98.08 };
const PK = "ab".repeat(32);

async function freshDb() { const c = createClient({ url: "file::memory:" }); await initRambleTables(c); return c; }
function mark(db, at, text, extra = {}) {
  return createMark(db, {
    author: PK, author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: at.lat, lon: at.lon, accuracy_m: 12 },
    content: { content_text: text, content_kind: "none" }, ...extra,
  });
}

test("bboxAround: a box that holds the circle, symmetric in metres", () => {
  const b = bboxAround(HERE, 500);
  assert.ok(Math.abs(haversineMeters(HERE, { lat: b.north, lon: HERE.lon }) - 500) < 2);
  assert.ok(Math.abs(haversineMeters(HERE, { lat: HERE.lat, lon: b.east }) - 500) < 2);
  assert.ok(b.south < HERE.lat && b.west < HERE.lon);
  const pole = bboxAround({ lat: 89.999, lon: 0 }, 1000);
  assert.equal(pole.north, 90, "clamped at the pole");
});

test("locate: an exact anchor has no error; a teaser sits at its cell centre with the half-diagonal as err_m; junk is null", () => {
  assert.deepEqual(locate({ lat: 1, lon: 2 }), { lat: 1, lon: 2, err_m: 0 });
  const t = locate({ geohash: "9v6m21h" });
  assert.ok(Math.abs(t.lat - 30.46) < 0.001 && Math.abs(t.lon + 98.08) < 0.001);
  assert.ok(t.err_m > 90 && t.err_m < 115, `7-char half-diagonal ~101 m, got ${t.err_m}`);
  const c = locate({ geohash: "9v6m2" });
  assert.ok(c.err_m > 3000 && c.err_m < 3600, `5-char half-diagonal ~3.4 km, got ${c.err_m}`);
  assert.equal(locate({}), null);
  assert.equal(locate({ geohash: "" }), null);
  assert.equal(locate({ geohash: "a!" }), null);
});

test("aroundPoint: marks within the radius nearest first with distance_m, rows as stored; a locked teaser rides its cell; out of range is dropped", async () => {
  const db = await freshDb();
  const near = await mark(db, NORTH_100, "near north");
  const east = await mark(db, EAST_100, "locked east", { reveal: "locked" });
  await mark(db, NORTH_900, "far north");
  const out = await aroundPoint(db, { ...HERE, now: T0 });
  assert.deepEqual(out.here, HERE);
  assert.equal(out.radius_m, AROUND_RADIUS_DEFAULT);
  assert.deepEqual(out.marks.map((m) => m.mark_id), [near.mark_id, east.mark_id], "nearest first, the 900 m mark gone");
  const n = out.marks[0];
  assert.ok(Math.abs(n.distance_m - 100) <= 2, `distance ${n.distance_m}`);
  assert.deepEqual([n.lat, n.lon, n.accuracy_m, n.content_text], [NORTH_100.lat, NORTH_100.lon, 12, "near north"], "exactly as stored");
  const t = out.marks[1];
  assert.equal(t.content_text, undefined, "a locked row is still the teaser");
  assert.equal(t.lat, undefined);
  assert.equal(t.geohash, east.geohash);
  assert.ok(t.distance_m <= 250, `a teaser is measured to its cell centre (${t.distance_m} m)`);
  for (let i = 1; i < out.marks.length; i++) assert.ok(out.marks[i].distance_m >= out.marks[i - 1].distance_m);
});

test("aroundPoint: a coarse wire caw (5-char cell) is kept because its cell could hold a point in range; a coarse cell elsewhere is not", async () => {
  const db = await freshDb();
  await insertRemoteMark(db, { mark_id: "caw-here", author: "cd".repeat(32), kind: "caw", anchor_kind: "geo", geohash: "9v6m2", visibility: "public", reveal: "open", content_text: "hello", created_at: T0, nostr_event_id: "e1" });
  await insertRemoteMark(db, { mark_id: "caw-far", author: "cd".repeat(32), kind: "caw", anchor_kind: "geo", geohash: "9v6m8", visibility: "public", reveal: "open", content_text: "far", created_at: T0, nostr_event_id: "e2" });
  await insertRemoteMark(db, { mark_id: "caw-six", author: "cd".repeat(32), kind: "caw", anchor_kind: "geo", geohash: "9v6m21", visibility: "public", reveal: "open", content_text: "six", created_at: T0, nostr_event_id: "e3" });
  const out = await aroundPoint(db, { ...HERE, now: T0 });
  const ids = out.marks.map((m) => m.mark_id);
  assert.ok(ids.includes("caw-here"));
  assert.ok(!ids.includes("caw-far"));
  assert.ok(ids.includes("caw-six"), "a caw stored at a 6-char publish precision is listed (the map shows it too)");
  const c = out.marks.find((m) => m.mark_id === "caw-here");
  assert.equal(c.lat, null, "no position was invented for it");
  assert.equal(typeof c.distance_m, "number");
});

test("aroundPoint: this week's nests within the radius, nearest first; the radius clamps to 50..1000", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('nest.rate', '1')", args: [] });
  const out = await aroundPoint(db, { ...HERE, now: T0 });
  assert.equal(out.week, isoWeek(T0));
  assert.ok(out.nests.length >= 1, "rate 1 puts a nest in every cell, so the user's own cell has one within ~110 m");
  for (const n of out.nests) {
    assert.ok(n.distance_m <= 500);
    assert.ok(typeof n.cell === "string" && n.cell.length === 7 && typeof n.seed === "number" && n.claimed === false);
  }
  for (let i = 1; i < out.nests.length; i++) assert.ok(out.nests[i].distance_m >= out.nests[i - 1].distance_m);
  const wide = await aroundPoint(db, { ...HERE, radiusM: 5000, now: T0 });
  assert.equal(wide.radius_m, AROUND_RADIUS_MAX);
  assert.ok(wide.nests.length >= out.nests.length);
  const tight = await aroundPoint(db, { ...HERE, radiusM: 1, now: T0 });
  assert.equal(tight.radius_m, AROUND_RADIUS_MIN);
});

test("aroundPoint: works at high latitude (the cover grows with 1/cos) and refuses the pole rather than scanning the table", async () => {
  const db = await freshDb();
  await mark(db, { lat: 85.0009, lon: 10 }, "arctic north");
  const far = await aroundPoint(db, { lat: 85, lon: 10, now: T0 });
  assert.deepEqual(far.marks.map((m) => m.content_text), ["arctic north"], "the fine cover overflowed; the coarse pass still answers");
  assert.equal(far.radius_m, AROUND_RADIUS_DEFAULT);
  await assert.rejects(aroundPoint(db, { lat: 89.9, lon: 10, now: T0 }), (err) => err.code === "too-wide");
  await assert.rejects(aroundPoint(db, { lat: 90, lon: 0, now: T0 }), (err) => err.code === "too-wide");
});

test("aroundPoint: a nearby mark is never starved by 600 NEWER marks in the same cover (fine cell 662 m out, coarse cell 9v6m2)", async () => {
  const db = await freshDb();
  const near = await mark(db, NORTH_100, "near north");
  // 600 marks NEWER than the one above (createMark stamps Date.now(), so a
  // fixed T0 would be OLDER and the test would prove nothing), at
  // 30.4642/-98.0751: 662 m away — out of range — but in cell 9v6m21z, which
  // IS in the fine cover (the bbox corner), and in the coarse cell 9v6m2.
  // Each carries its own 7-char geohash exactly as a stored exact-anchor row
  // does. A single LIMIT 500 over either pass would drop "near north".
  const newer = Date.now() + 1000;
  const stmts = [];
  for (let i = 0; i < 600; i++) {
    stmts.push({
      sql: `INSERT INTO ramble_marks (mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon, accuracy_m, visibility, reveal, content_text, content_kind, created_at, publish_state, origin)
            VALUES (?, ?, 'rotating', 'mark', 'geo', ?, ?, ?, 5, 'public', 'open', ?, 'none', ?, 'published', 'remote')`,
      args: ["crowd-" + i, PK, "9v6m21z", 30.4642, -98.0751, "crowd " + i, newer + i],
    });
  }
  await db.batch(stmts);
  const out = await aroundPoint(db, { ...HERE, now: T0 });
  assert.deepEqual(out.marks.map((m) => m.mark_id), [near.mark_id]);
});
