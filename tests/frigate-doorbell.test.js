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
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_NAME_RE,
  _setOpenForTest,
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

/**
 * A FIFO at `file`, or false when this box has no `mkfifo` to make one with (Windows, a stripped
 * image), so the caller can skip instead of asserting on something it could not set up.
 */
function makeFifo(file) {
  try {
    execFileSync("mkfifo", [file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Removes a FIFO a case planted, whether or not the case got as far as asserting. */
function dropFifo(file) {
  try {
    unlinkSync(file);
  } catch {
    // Nothing left to remove.
  }
}

/**
 * `work`, but the test fails if it has not settled in two seconds — an open that blocks on a FIFO
 * with no writer never settles at all, and the runner would sit there until its own timeout.
 */
function boundedBy2s(work) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("the read did not settle within 2 s")), 2000);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * A handle whose stat() reports a small regular file while read() hands out `content` — the file
 * growing between the check and the read, as seen from the reader's side.
 */
function growingHandle(content) {
  const closed = { count: 0 };
  const handle = {
    stat: async () => ({ isFile: () => true, size: 4 }),
    read: async (buffer, offset, length, position) => {
      const slice = content.subarray(position, Math.min(position + length, content.length));
      slice.copy(buffer, offset);
      return { bytesRead: slice.length };
    },
    close: async () => {
      closed.count += 1;
    },
  };
  return { handle, closed };
}

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

test("a symlink in the folder is refused, for a still and for its sidecar", async () => {
  const dir = freshDir();
  const elsewhereJpg = join(outside, "hidden.jpg");
  writeFileSync(elsewhereJpg, "bytes-from-outside-the-folder");
  symlinkSync(elsewhereJpg, join(dir, "borrowed.jpg"));
  assert.equal(await readSnapshot(dir, "borrowed"), null, "a symlinked still is not read");

  const elsewhereJson = join(outside, "hidden.json");
  writeFileSync(elsewhereJson, JSON.stringify({ timestamp: 1_600_000_500, type: "ding" }));
  jpg(dir, "linked_side", "a-real-still");
  utimesSync(join(dir, "linked_side.jpg"), 1_600_000_000, 1_600_000_000);
  symlinkSync(elsewhereJson, join(dir, "linked_side.json"));

  const listed = await listSnapshotCameras(dir);
  assert.deepEqual(listed.map((entry) => entry.name), ["linked_side"], "the still itself is listed");
  assert.equal(listed[0].type, null, "a symlinked sidecar contributes no reason");
  assert.equal(listed[0].timestamp, 1_600_000_000, "a symlinked sidecar contributes no time");
  const read = await readSnapshot(dir, "linked_side");
  assert.ok(read && read.bytes.toString() === "a-real-still", "the plain still still reads");
});

test("a FIFO planted at a still or sidecar path does not block the reader", async (t) => {
  const stillDir = freshDir();
  const sideDir = freshDir();
  const stillFifo = join(stillDir, "planted.jpg");
  const sideFifo = join(sideDir, "planted_side.json");
  if (!makeFifo(stillFifo) || !makeFifo(sideFifo)) {
    dropFifo(stillFifo);
    dropFifo(sideFifo);
    return t.skip("mkfifo is not available here");
  }
  try {
    assert.equal(await boundedBy2s(readSnapshot(stillDir, "planted")), null, "a FIFO is not a still");

    jpg(sideDir, "planted_side", "a-real-still");
    utimesSync(join(sideDir, "planted_side.jpg"), 1_600_000_000, 1_600_000_000);
    const listed = await boundedBy2s(listSnapshotCameras(sideDir));
    assert.deepEqual(listed.map((entry) => entry.name), ["planted_side"], "the plain still is listed");
    assert.equal(listed[0].type, null, "a FIFO sidecar contributes no reason");
    assert.equal(listed[0].timestamp, 1_600_000_000, "a FIFO sidecar contributes no time");
    const read = await boundedBy2s(readSnapshot(sideDir, "planted_side"));
    assert.ok(read && read.bytes.toString() === "a-real-still", "the plain still still reads");
  } finally {
    dropFifo(stillFifo);
    dropFifo(sideFifo);
  }
});

test("a still that grows past the cap between the stat and the read is refused", async () => {
  const dir = freshDir();
  jpg(dir, "growing");
  const { handle, closed } = growingHandle(Buffer.alloc(SNAPSHOT_MAX_BYTES + 10, 0x41));
  _setOpenForTest(async () => handle);
  try {
    assert.equal(await readSnapshot(dir, "growing"), null);
  } finally {
    _setOpenForTest(null);
  }
  assert.equal(closed.count, 1, "the handle is closed on the refusing path");
  const after = await readSnapshot(dir, "growing");
  assert.ok(after && after.bytes.toString() === "jpeg-bytes", "the real reader is back");
});

test("a sidecar that grows past its cap between the stat and the read is ignored", async () => {
  const dir = freshDir();
  jpg(dir, "growing_side");
  utimesSync(join(dir, "growing_side.jpg"), 1_600_000_000, 1_600_000_000);
  const { handle, closed } = growingHandle(Buffer.alloc(4096 + 10, 0x20));
  _setOpenForTest(async () => handle);
  let listed;
  try {
    listed = await listSnapshotCameras(dir);
  } finally {
    _setOpenForTest(null);
  }
  assert.deepEqual(listed.map((entry) => entry.name), ["growing_side"]);
  assert.equal(listed[0].type, null, "the over-long sidecar is not parsed");
  assert.equal(listed[0].timestamp, 1_600_000_000, "and the still keeps its mtime");
  assert.equal(closed.count, 1, "the handle is closed on the refusing path");
});

test("the happy path is unchanged: the bytes come back and the sidecar is read", async () => {
  const dir = freshDir();
  jpg(dir, "porch", "porch-picture");
  sidecar(dir, "porch", { timestamp: 1_700_000_400, type: "ding" });
  const read = await readSnapshot(dir, "porch");
  assert.ok(read && Buffer.isBuffer(read.bytes));
  assert.equal(read.bytes.toString(), "porch-picture");
  const listed = await listSnapshotCameras(dir);
  assert.deepEqual(listed.map((entry) => entry.name), ["porch"]);
  assert.deepEqual({ timestamp: listed[0].timestamp, type: listed[0].type }, { timestamp: 1_700_000_400, type: "ding" });
  assert.equal(snapshotLabel(listed[0], 1_700_000_400_000, "en"), "doorbell - just now");

  // Exactly at the cap is still a still; one byte over is not.
  const atCap = freshDir();
  writeFileSync(join(atCap, "at_cap.jpg"), "");
  truncateSync(join(atCap, "at_cap.jpg"), SNAPSHOT_MAX_BYTES);
  const capped = await readSnapshot(atCap, "at_cap");
  assert.ok(capped && capped.bytes.length === SNAPSHOT_MAX_BYTES, "a still at the cap is read whole");
  writeFileSync(join(atCap, "over_cap.jpg"), "");
  truncateSync(join(atCap, "over_cap.jpg"), SNAPSHOT_MAX_BYTES + 1);
  assert.equal(await readSnapshot(atCap, "over_cap"), null);
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