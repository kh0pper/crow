/**
 * The Frigate bundle's doorbell snapshots (server/doorbell.js).
 *
 * Why these assertions: the folder those files live in is written by another process and its
 * names end up in a route path, so a listing must never be talked into reading anything but a
 * plain, small `.jpg` directly in that folder — and a broken sidecar must cost the reason and
 * the time, not the picture. The label is the only thing the widget shows next to the still, so
 * its wording (both languages) and its "no timestamp" behaviour are pinned here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_NAME_RE,
  isSnapshotName,
  listSnapshotCameras,
  readSnapshot,
  snapshotLabel,
} from "../bundles/frigate/server/doorbell.js";

const scratch = mkdtempSync(join(tmpdir(), "crow-frigate-doorbell-"));
const outside = mkdtempSync(join(tmpdir(), "crow-frigate-outside-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

let dirCounter = 0;
/** A fresh folder per case, so one case's files cannot answer for another's. */
function freshDir() {
  const dir = join(scratch, `dir-${++dirCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const jpg = (dir, name, body = "jpeg-bytes") => writeFileSync(join(dir, `${name}.jpg`), body);
const sidecar = (dir, name, value) =>
  writeFileSync(join(dir, `${name}.json`), typeof value === "string" ? value : JSON.stringify(value));

// ─── names ────────────────────────────────────────────────────────────────

test("a snapshot name is lowercase, dot-free, slash-free and at most 64 chars", () => {
  for (const good of ["front_door", "a", "a-b_c", "0", "x".repeat(64)]) {
    assert.equal(isSnapshotName(good), true, good);
  }
  for (const bad of ["", "Front_door", "front.door", "front door", "..", "../x", "a/b", "%2e%2e", "x".repeat(65), "ñ", null, undefined, 42, {}, ["a"]]) {
    assert.equal(isSnapshotName(bad), false, String(bad));
  }
  assert.ok(SNAPSHOT_NAME_RE instanceof RegExp);
  assert.equal(SNAPSHOT_MAX_BYTES, 5 * 1024 * 1024);
});

// ─── listing ──────────────────────────────────────────────────────────────

test("only regex-valid, regular, non-empty, small jpgs are listed — nothing else in the folder", async () => {
  const dir = freshDir();
  jpg(dir, "front_door");
  jpg(dir, "side_gate");
  jpg(dir, "Front_Upper"); // uppercase
  jpg(dir, "dot.ted"); // dotted
  jpg(dir, "space name"); // space
  writeFileSync(join(dir, "empty.jpg"), "");
  writeFileSync(join(dir, "huge.jpg"), "");
  truncateSync(join(dir, "huge.jpg"), SNAPSHOT_MAX_BYTES + 1);
  mkdirSync(join(dir, "sub.jpg"), { recursive: true });
  writeFileSync(join(outside, "elsewhere.jpg"), "not ours");
  symlinkSync(join(outside, "elsewhere.jpg"), join(dir, "linked.jpg"));
  writeFileSync(join(dir, "notes.txt"), "not a still");
  writeFileSync(join(dir, "front_door.png"), "wrong suffix");

  const listed = await listSnapshotCameras(dir);
  assert.deepEqual(listed.map((entry) => entry.name), ["front_door", "side_gate"]);
  for (const entry of listed) {
    assert.equal(typeof entry.mtimeMs, "number");
    assert.ok(entry.mtimeMs > 0);
    assert.equal(entry.type, null, "no sidecar means no reason");
    assert.equal(entry.timestamp, Math.floor(entry.mtimeMs / 1000), "no sidecar means the mtime");
  }
});

test("a sidecar supplies the time and the reason, and a bad one is ignored without losing the still", async () => {
  const dir = freshDir();
  jpg(dir, "a_ding");
  sidecar(dir, "a_ding", { timestamp: 1_700_000_000, type: "ding" });
  jpg(dir, "b_motion");
  sidecar(dir, "b_motion", { timestamp: 1_700_000_100, type: "motion" });
  jpg(dir, "c_broken");
  sidecar(dir, "c_broken", "{ this is not json");
  jpg(dir, "d_unknown");
  sidecar(dir, "d_unknown", { timestamp: 1_700_000_200, type: "party" });
  jpg(dir, "e_no_time");
  sidecar(dir, "e_no_time", { type: "interval" });
  jpg(dir, "f_string_time");
  sidecar(dir, "f_string_time", { timestamp: "soon", type: "on-demand" });
  jpg(dir, "g_negative");
  sidecar(dir, "g_negative", { timestamp: -5 });
  jpg(dir, "h_oversized");
  sidecar(dir, "h_oversized", { timestamp: 1_700_000_300, type: "ding", pad: "x".repeat(5 * 1024) });
  jpg(dir, "i_array");
  sidecar(dir, "i_array", "[1,2,3]");

  // Give every still a known mtime, so the fallback is checkable.
  for (const name of ["c_broken", "d_unknown", "e_no_time", "f_string_time", "g_negative", "h_oversized", "i_array"]) {
    utimesSync(join(dir, `${name}.jpg`), 1_600_000_000, 1_600_000_000);
  }

  const byName = new Map((await listSnapshotCameras(dir)).map((entry) => [entry.name, entry]));
  assert.deepEqual(
    [...byName.keys()],
    ["a_ding", "b_motion", "c_broken", "d_unknown", "e_no_time", "f_string_time", "g_negative", "h_oversized", "i_array"],
    "sorted by name",
  );
  assert.deepEqual({ timestamp: byName.get("a_ding").timestamp, type: byName.get("a_ding").type }, { timestamp: 1_700_000_000, type: "ding" });
  assert.equal(byName.get("b_motion").type, "motion");
  assert.equal(byName.get("c_broken").timestamp, 1_600_000_000, "bad json falls back to the mtime");
  assert.equal(byName.get("c_broken").type, null);
  assert.equal(byName.get("d_unknown").timestamp, 1_700_000_200);
  assert.equal(byName.get("d_unknown").type, null, "an unknown reason is no reason");
  assert.equal(byName.get("e_no_time").timestamp, 1_600_000_000, "a missing timestamp falls back to the mtime");
  assert.equal(byName.get("e_no_time").type, "interval");
  assert.equal(byName.get("f_string_time").timestamp, 1_600_000_000, "a non-numeric timestamp falls back");
  assert.equal(byName.get("f_string_time").type, "on-demand");
  assert.equal(byName.get("g_negative").timestamp, 1_600_000_000, "a non-positive timestamp falls back");
  assert.equal(byName.get("h_oversized").timestamp, 1_600_000_000, "an oversized sidecar is not read");
  assert.equal(byName.get("i_array").type, null, "a json array is not a sidecar");
});

test("a missing, unreadable or absent folder has no cameras and does not throw", async () => {
  assert.deepEqual(await listSnapshotCameras(join(scratch, "does-not-exist")), []);
  assert.deepEqual(await listSnapshotCameras(null), []);
  assert.deepEqual(await listSnapshotCameras(undefined), []);
  assert.deepEqual(await listSnapshotCameras(""), []);
  assert.deepEqual(await listSnapshotCameras(42), []);
  const file = join(scratch, "not-a-dir");
  writeFileSync(file, "x");
  assert.deepEqual(await listSnapshotCameras(file), []);
});

// ─── reading one still ────────────────────────────────────────────────────

test("a still's bytes are returned, and every unsafe name or file shape is refused", async () => {
  const dir = freshDir();
  jpg(dir, "front_door", "the-picture");
  const read = await readSnapshot(dir, "front_door");
  assert.ok(read && Buffer.isBuffer(read.bytes));
  assert.equal(read.bytes.toString(), "the-picture");

  writeFileSync(join(outside, "elsewhere.jpg"), "someone else's");
  symlinkSync(join(outside, "elsewhere.jpg"), join(dir, "linked.jpg"));
  writeFileSync(join(dir, "empty.jpg"), "");
  writeFileSync(join(dir, "huge.jpg"), "");
  truncateSync(join(dir, "huge.jpg"), SNAPSHOT_MAX_BYTES + 1);

  for (const name of ["../x", "a/b", "..", "%2e%2e", "", "Front", "dot.ted", "x".repeat(65), null, undefined, 42, {}, "linked", "empty", "huge", "missing"]) {
    assert.equal(await readSnapshot(dir, name), null, `refused: ${String(name)}`);
  }
  assert.equal(await readSnapshot(null, "front_door"), null, "no folder, no read");
  assert.equal(await readSnapshot("", "front_door"), null);
});

// ─── the label ────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000; // seconds: 1_700_000_000
const ago = (seconds) => NOW / 1000 - seconds;

test("the label is the reason and the relative time, in English", () => {
  assert.equal(snapshotLabel({ type: "motion", timestamp: ago(10) }, NOW, "en"), "motion - just now");
  assert.equal(snapshotLabel({ type: "ding", timestamp: ago(44) }, NOW, "en"), "doorbell - just now");
  assert.equal(snapshotLabel({ type: "interval", timestamp: ago(50) }, NOW, "en"), "scheduled - 50 s ago");
  assert.equal(snapshotLabel({ type: "on-demand", timestamp: ago(3 * 60) }, NOW, "en"), "on request - 3 min ago");
  assert.equal(snapshotLabel({ type: "motion", timestamp: ago(60 * 60) }, NOW, "en"), "motion - 1 h ago");
  assert.equal(snapshotLabel({ type: "motion", timestamp: ago(2 * 60 * 60) }, NOW, "en"), "motion - 2 h ago");
  assert.equal(snapshotLabel({ type: "ding", timestamp: ago(24 * 60 * 60) }, NOW, "en"), "doorbell - 1 d ago");
  assert.equal(snapshotLabel({ type: "ding", timestamp: ago(5 * 24 * 60 * 60) }, NOW, "en"), "doorbell - 5 d ago");
  assert.equal(snapshotLabel({ type: "ding", timestamp: ago(-30) }, NOW, "en"), "doorbell - just now", "a future time reads as now");
});

test("the label is Spanish for es, and English for anything else", () => {
  assert.equal(snapshotLabel({ type: "motion", timestamp: ago(10) }, NOW, "es"), "movimiento - ahora mismo");
  assert.equal(snapshotLabel({ type: "ding", timestamp: ago(3 * 60) }, NOW, "es"), "timbre - hace 3 min");
  assert.equal(snapshotLabel({ type: "interval", timestamp: ago(2 * 60 * 60) }, NOW, "es"), "programada - hace 2 h");
  assert.equal(snapshotLabel({ type: "on-demand", timestamp: ago(24 * 60 * 60) }, NOW, "es"), "a pedido - hace 1 d");
  assert.equal(snapshotLabel({ type: "ding", timestamp: ago(-10) }, NOW, "es"), "timbre - ahora mismo");
  for (const lang of ["fr", "", null, undefined, "EN", "es-ES"]) {
    assert.equal(snapshotLabel({ type: "ding", timestamp: ago(60) }, NOW, lang), "doorbell - 1 min ago", String(lang));
  }
});

test("without a reason the label is just the time, and a label never throws on junk", () => {
  assert.equal(snapshotLabel({ type: null, timestamp: ago(3 * 60) }, NOW, "en"), "3 min ago");
  assert.equal(snapshotLabel({ timestamp: ago(3 * 60) }, NOW, "es"), "hace 3 min");
  assert.equal(snapshotLabel({ type: "party", timestamp: ago(10) }, NOW, "en"), "just now");
  assert.equal(snapshotLabel({ type: "constructor", timestamp: ago(10) }, NOW, "en"), "just now");
  assert.equal(snapshotLabel({ type: null, timestamp: null }, NOW, "en"), "");
  assert.equal(snapshotLabel({}, NOW, "en"), "");
  assert.equal(snapshotLabel(null, NOW, "en"), "");
  assert.equal(snapshotLabel(undefined, undefined, "en"), "");
  assert.equal(snapshotLabel({ type: "ding", timestamp: "soon" }, NOW, "en"), "doorbell");
});