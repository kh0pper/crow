/**
 * The Frigate bundle's cameras widget (widgets/cameras.js).
 *
 * Why these assertions: the widget used to be Frigate's camera list and nothing else, so a Frigate
 * that was down (or a doorbell camera Frigate does not carry) left the card empty. Now a still in
 * the snapshot folder is a camera on its own, a camera with a live source gets a row that leads to
 * the panel, and none of that may duplicate a tile or drag a stream address onto the page. The
 * loader's answer is what the gateway validates and renders, so the shape and the limits are
 * checked here as well.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAMERA_LIMIT, FRIGATE_PANEL_HREF, _resetForTest, _setFetchForTest, load } from "../bundles/frigate/widgets/cameras.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "crow-frigate-widget-"));
const ENV_KEYS = ["FRIGATE_SNAPSHOT_DIR", "FRIGATE_LIVE_SOURCES"];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

after(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(SCRATCH, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const RTSP = "rtsp://someone:hunter2@100.64.20.7:8554/front_door_live";

let dirCounter = 0;

/** A snapshot folder with the given stills, and JSON live sources for the given names. */
function withSnapshotFolder(names, liveNames = [], dirName = undefined) {
  const dir = join(SCRATCH, dirName || `dir-${++dirCounter}`);
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, `${name}.jpg`), "jpeg-bytes");
  const sources = {};
  for (const name of liveNames) sources[name] = RTSP;
  process.env.FRIGATE_SNAPSHOT_DIR = dir;
  process.env.FRIGATE_LIVE_SOURCES = liveNames.length ? JSON.stringify(sources) : "";
  return dir;
}

/** No snapshot folder and no live sources: the widget as it was before the doorbell. */
function withoutSnapshotFolder() {
  delete process.env.FRIGATE_SNAPSHOT_DIR;
  delete process.env.FRIGATE_LIVE_SOURCES;
}

/** A Frigate that answers /api/config with these camera names. */
function frigateWith(names) {
  const cameras = {};
  for (const name of names) cameras[name] = {};
  _setFetchForTest(async () => ({ cameras }));
}

/** A Frigate that cannot be reached at all. */
function frigateDown() {
  _setFetchForTest(async () => { throw new Error("connection refused"); });
}

const images = (summary) => summary.items.filter((item) => typeof item.image === "string" && item.image);
const rows = (summary) => summary.items.filter((item) => !item.image);

// ─── the snapshot folder on its own ───────────────────────────────────────

test("a snapshot folder with Frigate down still draws its doorbell, and its live row", async () => {
  _resetForTest();
  withSnapshotFolder(["front_door"], ["front_door"]);
  writeFileSync(join(process.env.FRIGATE_SNAPSHOT_DIR, "front_door.json"), JSON.stringify({
    timestamp: NOW / 1000 - 180,
    type: "ding",
  }));
  frigateDown();

  const summary = await load({ lang: "en", now: NOW });

  assert.equal(summary.state, "ok", "a Frigate that cannot be read is no longer the whole card");
  assert.equal(summary.more_href, FRIGATE_PANEL_HREF);
  const still = summary.items.find((item) => item.image);
  assert.ok(still, "the still in the folder is drawn");
  assert.equal(still.image, "/api/frigate/snap/front_door.jpg", "from its own file, through the gateway");
  assert.equal(still.title, "Front Door - doorbell - 3 min ago", "the name, the reason and the time");
  assert.equal(still.kind, "camera");

  const live = summary.items.find((item) => item.kind === "live");
  assert.ok(live, "a camera with a live source gets its row");
  assert.equal(live.title, "Watch live");
  assert.equal(live.href, "/dashboard/frigate?live=front_door", "a same-site link the widget can draw");
  assert.equal(live.image, undefined, "the row is text, not a still");
});

test("without a sidecar the title carries the time only", async () => {
  _resetForTest();
  withSnapshotFolder(["side_gate"], []);
  frigateDown();
  const summary = await load({ lang: "en", now: NOW });
  const still = summary.items.find((item) => item.image);
  assert.ok(still, "the still is still drawn");
  assert.match(still.title, /^Side Gate - /, "the name is turned into a heading");
  assert.doesNotMatch(still.title, /undefined/);
});

test("no folder and Frigate down is still the cell's error, as it was", async () => {
  _resetForTest();
  withoutSnapshotFolder();
  frigateDown();
  await assert.rejects(() => load({ lang: "en", now: NOW }), /connection refused/);
});

test("no folder and a Frigate list is exactly the widget it was", async () => {
  _resetForTest();
  withoutSnapshotFolder();
  frigateWith(["front", "driveway"]);

  const summary = await load({ lang: "en", now: NOW });
  assert.equal(summary.state, "ok");
  assert.equal(summary.headline, "");
  assert.equal(summary.more_href, FRIGATE_PANEL_HREF);
  assert.deepEqual(summary.items, [
    { key: "front", kind: "camera", title: "front", image: "/api/frigate/front/latest.jpg" },
    { key: "driveway", kind: "camera", title: "driveway", image: "/api/frigate/driveway/latest.jpg" },
  ]);
  assert.equal(summary.items.length, 2);
});

test("a Frigate list that is empty is an empty card, not an error", async () => {
  _resetForTest();
  withoutSnapshotFolder();
  frigateWith([]);
  const summary = await load({ lang: "en", now: NOW });
  assert.equal(summary.state, "empty");
  assert.deepEqual(summary.items, []);
  assert.equal(summary.more_href, FRIGATE_PANEL_HREF);
});

test("a camera switched off in Frigate is still left out", async () => {
  _resetForTest();
  withoutSnapshotFolder();
  _setFetchForTest(async () => ({ cameras: { front: {}, off: { enabled: false } } }));
  const summary = await load({ lang: "en", now: NOW });
  assert.deepEqual(summary.items.map((item) => item.title), ["front"]);
});

// ─── the two lists together ───────────────────────────────────────────────

test("a snapshot camera is never drawn twice", async () => {
  _resetForTest();
  withSnapshotFolder(["front_door", "porch"], []);
  frigateWith(["front_door", "driveway"]);

  const summary = await load({ lang: "en", now: NOW });
  const titles = summary.items.map((item) => item.title);
  assert.equal(titles.filter((title) => title === "front_door").length, 0, "Frigate's copy of it is dropped");
  assert.ok(titles.some((title) => title.startsWith("Front Door - ")), "the snapshot copy is drawn instead");
  assert.ok(summary.items.some((item) => item.image === "/api/frigate/driveway/latest.jpg"),
    "the Frigate camera that is not a snapshot camera is drawn");
  assert.equal(summary.items.filter((item) => item.key === "front_door").length, 1, "one item for that camera");
});

test("a live source with no still gives no row and no camera", async () => {
  _resetForTest();
  withSnapshotFolder(["front_door"], ["front_door", "not_there"]);
  frigateWith([]);
  const summary = await load({ lang: "en", now: NOW });
  assert.deepEqual(summary.items.filter((item) => item.kind === "live").map((item) => item.key), ["front_door-live"]);
});

test("the widget speaks Spanish when the page does", async () => {
  _resetForTest();
  withSnapshotFolder(["front_door"], ["front_door"]);
  writeFileSync(join(process.env.FRIGATE_SNAPSHOT_DIR, "front_door.json"), JSON.stringify({
    timestamp: NOW / 1000 - 180,
    type: "ding",
  }));
  frigateWith([]);

  const summary = await load({ lang: "es", now: NOW });
  const still = summary.items.find((item) => item.image);
  assert.equal(still.title, "Front Door - timbre - hace 3 min", "the label is Spanish like the rest of the page");
  assert.equal(summary.items.find((item) => item.kind === "live").title, "Ver en vivo");
});

// ─── what never reaches the page ──────────────────────────────────────────

test("no item carries a stream address or a credential", async () => {
  _resetForTest();
  withSnapshotFolder(["front_door", "side_gate"], ["front_door", "side_gate"]);
  frigateWith(["front_door", "side_gate", "driveway"]);

  const summary = await load({ lang: "en", now: NOW });
  const serialized = JSON.stringify(summary);
  for (const secret of ["rtsp", "rtsps", "hunter2", "user:pass", "100.64.20.7", "someone:"]) {
    assert.ok(!serialized.includes(secret), `no part of the answer carries ${secret}`);
  }
});

// ─── the limits the grid and the gateway enforce ──────────────────────────

test("node count, image count and title length stay inside what the grid draws", async () => {
  _resetForTest();
  const many = ["cam_a", "cam_b", "cam_c", "cam_d", "cam_e", "cam_f"];
  withSnapshotFolder(many, many);
  frigateWith(many);

  const summary = await load({ lang: "en", now: NOW });
  assert.ok(summary.items.length <= 12, "at most 12 items, as the gateway keeps");
  assert.ok(images(summary).length <= CAMERA_LIMIT, "the stills are one 2x2 block");
  assert.equal(images(summary).length, CAMERA_LIMIT, "and the block is filled from the snapshot folder first");
  assert.equal(rows(summary).length, CAMERA_LIMIT, "one live row per drawn snapshot camera");
  for (const item of summary.items) {
    assert.ok(item.title.length <= 120, `a title the gateway will not have to cut: ${item.title}`);
    assert.ok(typeof item.key === "string");
  }
  const keys = summary.items.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length, "every item has its own key");
});

test("a name that is not a snapshot name never becomes an item", async () => {
  _resetForTest();
  const dir = withSnapshotFolder([], [], "odd-names");
  // Written past the loader's own listing rules on purpose: the widget must not invent a title.
  writeFileSync(join(dir, "Front_Door.jpg"), "jpeg-bytes");
  frigateWith([]);
  const summary = await load({ lang: "en", now: NOW });
  assert.deepEqual(summary.items, []);
  assert.equal(summary.state, "empty");
});

test("bad live-source JSON means no rows, not a broken card", async () => {
  _resetForTest();
  withSnapshotFolder(["front_door"], []);
  process.env.FRIGATE_LIVE_SOURCES = "{ this is not json";
  frigateWith([]);
  const summary = await load({ lang: "en", now: NOW });
  assert.equal(summary.items.filter((item) => item.kind === "live").length, 0);
  assert.equal(images(summary).length, 1, "the still is unaffected");

  for (const value of ["[1,2,3]", "\"rtsp://x\"", "null", "42"]) {
    process.env.FRIGATE_LIVE_SOURCES = value;
    _resetForTest();
    frigateWith([]);
    const again = await load({ lang: "en", now: NOW });
    assert.equal(again.items.filter((item) => item.kind === "live").length, 0, `no rows for ${value}`);
  }
});

test("a failed read is remembered for a minute, and the snapshots keep drawing meanwhile", async () => {
  _resetForTest();
  withSnapshotFolder(["front_door"], []);
  let calls = 0;
  _setFetchForTest(async () => { calls += 1; throw new Error("connection refused"); });

  const first = await load({ lang: "en", now: NOW });
  assert.equal(calls, 1);
  assert.equal(images(first).length, 1, "the snapshot camera is drawn anyway");

  const second = await load({ lang: "en", now: NOW + 30_000 });
  assert.equal(calls, 1, "inside the minute nothing is asked again");
  assert.equal(images(second).length, 1);

  const third = await load({ lang: "en", now: NOW + 61_000 });
  assert.equal(calls, 2, "past the minute the list is tried once more");
});