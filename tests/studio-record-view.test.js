/**
 * Studio record view — the lanes' pure rules (`panel/record-view.js`).
 *
 * Every case drives the very string the page inlines: the emitted classic script
 * is evaluated with `new Function`, the way the page's own `<script>` tag runs
 * it, and the module's named exports are the same evaluation, so a case can
 * check the two against each other.
 *
 * What they pin: the inline-script rules, a level that floors at -60 dB and is
 * never NaN, a meter fill that runs from nothing at -60 to full at 0, a peak
 * that holds and then falls at 20 dB a second without ever dropping under the
 * live reading, a draw ring whose arrays are made once and never again, the
 * pass-to-column mapping (start is column 0, the last frame is the last column,
 * anything outside is -1), a chain label that only names an amp really in the
 * chain, and a source label that says the input and mono or stereo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DB_FLOOR,
  DB_TOP,
  PEAK_FALL_DB_PER_SECOND,
  PeakHold,
  RECORD_VIEW_SCRIPT,
  SOURCE_LABEL_MAX,
  WaveRing,
  chainLabel,
  columnX,
  dbOf,
  meterFill,
  sourceLabel,
} from "../bundles/studio/panel/record-view.js";

/** The page's copy: the very text the handler inlines, run as the page runs it. */
function pageApi() {
  return new Function("window", `${RECORD_VIEW_SCRIPT}\nreturn window.StudioRecordView;`)({});
}

/** The middot a lane label puts between its parts. */
const DOT = "\u00b7";

test("the emitted script follows the panel's inline rules and exposes one global", () => {
  assert.equal(RECORD_VIEW_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(RECORD_VIEW_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(RECORD_VIEW_SCRIPT.includes('"'), false, "no double quote in the emitted text");
  assert.equal(RECORD_VIEW_SCRIPT.includes("\\"), false, "no backslash in the emitted text");
  assert.equal(RECORD_VIEW_SCRIPT.includes("</script"), false, "it cannot close its own tag");
  assert.doesNotThrow(() => new Function("window", RECORD_VIEW_SCRIPT), "it parses as a classic script");

  const page = pageApi();
  assert.equal(typeof page.dbOf, "function", "the page gets the level rule");
  assert.equal(typeof page.meterFill, "function", "and the meter fill");
  assert.equal(typeof page.PeakHold, "function", "and the peak hold");
  assert.equal(typeof page.WaveRing, "function", "and the draw ring");
  assert.equal(typeof page.columnX, "function", "and the pass-to-column mapping");
  assert.equal(typeof page.chainLabel, "function", "and the chain label");
  assert.equal(typeof page.sourceLabel, "function", "and the source label");
  assert.equal(page.DB_FLOOR, DB_FLOOR, "the floor travels");
  assert.equal(page.DB_TOP, DB_TOP, "with the top of the meter");
  assert.equal(page.PEAK_FALL_DB_PER_SECOND, PEAK_FALL_DB_PER_SECOND, "and the fall rate");

  assert.equal(DB_FLOOR, -60, "the meter bottoms out at -60 dB");
  assert.equal(DB_TOP, 0, "and tops out at full scale");
  assert.equal(PEAK_FALL_DB_PER_SECOND, 20, "a held peak falls 20 dB a second");
  assert.equal(SOURCE_LABEL_MAX, 24, "a device name is cut to one short line");
});

test("dbOf floors at -60 dB and is never NaN", () => {
  const page = pageApi();
  assert.equal(dbOf(0), -60, "digital silence reads as the floor");
  assert.equal(dbOf(1), 0, "full scale reads 0 dB");
  assert.equal(dbOf(NaN), -60, "a NaN sample reads as the floor");
  assert.equal(dbOf(-Infinity), -60, "so does minus infinity");
  assert.equal(dbOf(null), -60, "and a missing reading");
  assert.equal(dbOf(-1), 0, "a negative sample is its own magnitude");
  assert.ok(Math.abs(dbOf(0.5) + 6.0206) < 0.001, "half scale is about -6 dB");
  assert.equal(dbOf(0.0005), -60, "a reading below the floor answers the floor");
  assert.ok(Math.abs(dbOf(0.001) + 60) < 1e-6, "a thousandth is the floor");
  assert.ok(dbOf(2) > 0, "a reading over full scale is not clamped on top");

  for (const value of [0, 1e-9, 1e-6, 0.5, 1, 2, -0.5, NaN, Infinity, -Infinity, undefined, null, "0.25", "abc", {}, [], true]) {
    const reading = dbOf(value);
    assert.ok(Number.isFinite(reading), `dbOf(${String(value)}) is a finite number`);
    assert.ok(reading >= -60, `dbOf(${String(value)}) is not under the floor`);
    assert.equal(page.dbOf(value), reading, `the page agrees on ${String(value)}`);
  }
});

test("meterFill runs from nothing at -60 dB to full at 0 dB", () => {
  const page = pageApi();
  assert.equal(meterFill(-60), 0, "-60 dB fills nothing");
  assert.equal(meterFill(0), 1, "0 dB fills the meter");
  assert.equal(meterFill(-30), 0.5, "halfway down is halfway full");
  assert.equal(meterFill(-90), 0, "a reading under the floor fills nothing");
  assert.equal(meterFill(-Infinity), 0, "so does minus infinity");
  assert.equal(meterFill(6), 1, "and a reading over full scale is clamped");
  assert.equal(meterFill(Infinity), 1, "so is plus infinity");
  assert.equal(meterFill(NaN), 0, "a NaN fills nothing");

  for (const value of [-200, -60, -42.5, -30, -1, 0, 1, 40, NaN, Infinity, -Infinity, undefined, "x"]) {
    const fill = meterFill(value);
    assert.ok(fill >= 0 && fill <= 1, `meterFill(${String(value)}) is ${fill}, inside 0..1`);
    assert.equal(page.meterFill(value), fill, `the page agrees on ${String(value)}`);
  }
});

test("PeakHold holds for holdMs then falls at 20 dB a second", () => {
  const page = pageApi();
  const hold = new PeakHold(1000);
  assert.equal(hold.update(-12, 0), -12, "the first reading is the held peak");
  assert.equal(hold.update(-40, 500), -12, "inside the hold the peak stands still");
  assert.equal(hold.update(-40, 1000), -12, "and it still stands at the end of the hold");
  assert.equal(hold.update(-40, 1050), -13, "50 ms later it has fallen a dB");
  assert.equal(hold.update(-40, 2000), -32, "a second past the hold it is 20 dB down");
  assert.equal(hold.update(-40, 2100), -34, "and it keeps falling at 20 dB a second");
  assert.equal(hold.update(-5, 2200), -5, "a new higher reading replaces it");
  assert.equal(hold.update(-40, 2700), -5, "and starts a hold of its own");
  assert.equal(hold.update(-40, 3200), -5, "which stands for its own holdMs");
  assert.equal(hold.update(-40, 3300), -7, "then falls again");

  // It never drops under what the input is doing now.
  assert.equal(hold.update(-40, 100000), -40, "a long fall stops at the live reading");
  // And never under the floor.
  const floor = new PeakHold(0);
  floor.update(0, 0);
  assert.equal(floor.update(NaN, 100000), -60, "the fall stops at the floor");
  assert.equal(floor.update(undefined, 200000), -60, "and a broken reading is the floor too");

  hold.reset();
  assert.equal(hold.update(-30, 0), -30, "reset forgets the held peak");

  const pageHold = new page.PeakHold(1000);
  assert.equal(pageHold.update(-12, 0), -12, "the page holds a peak the same way");
  assert.equal(pageHold.update(-40, 2000), -32, "and falls at the same rate");
});

test("WaveRing keeps width columns on arrays it makes once", () => {
  const page = pageApi();
  const ring = new page.WaveRing(4);
  assert.equal(ring.width, 4, "the ring is as wide as it was asked to be");

  const frames = ring.frames;
  const mins = ring.mins;
  const maxs = ring.maxs;
  const filled = ring.filled;
  assert.equal(mins.length, 4, "one minimum per column");
  assert.equal(maxs.length, 4, "and one maximum");
  assert.equal(ring.read(0).min, 0, "an empty column reads as silence");

  ring.pushColumn(100, -0.5, 0.5);
  assert.equal(ring.read(0).min, -0.5, "the first column is the first pushed");
  assert.equal(ring.read(0).max, 0.5, "with its own maximum");
  assert.equal(ring.read(1).max, 0, "and the column beside it is still silent");
  ring.pushColumn(200, 0.25, -0.75);
  assert.equal(ring.read(1).min, -0.75, "a column pushed the wrong way round is still a min and a max");

  // A rolling ring wraps: the newest column is always on the right of the slot
  // order, and no push ever grows the ring.
  for (let at = 0; at < 10000; at += 1) {
    const value = ((at * 37) % 100) / 100;
    ring.pushColumn(at, -value, value);
    assert.equal(ring.mins.length, 4, `push ${at} did not resize the ring`);
  }
  assert.equal(ring.frames, frames, "the frames array is the same array after 10000 pushes");
  assert.equal(ring.mins, mins, "so is the minima");
  assert.equal(ring.maxs, maxs, "so is the maxima");
  assert.equal(ring.filled, filled, "and the filled flags");
  assert.ok(ring.count <= ring.width, "the ring never holds more columns than it has");
  assert.equal(ring.count, 4, "and a full ring says it is full");

  ring.reset();
  assert.equal(ring.count, 0, "reset empties the ring");
  assert.equal(ring.read(3).max, 0, "every column reads silence again");
  assert.equal(ring.mins, mins, "and reset allocated nothing");
});

test("WaveRing draws a pass: its start is column 0 and a gap is silence", () => {
  const page = pageApi();
  const ring = new page.WaveRing(8);
  ring.setPass(1000, 800);
  assert.equal(ring.passStartFrame, 1000, "the ring keeps the pass it draws");
  assert.equal(ring.passFrames, 800, "and its length");

  assert.equal(ring.pushColumn(1000, -0.5, 0.5), true, "the pass start is a column");
  assert.equal(ring.read(0).max, 0.5, "the first column is the pass start");
  assert.equal(ring.pushColumn(1799, -0.25, 0.75), true, "the last frame of the pass is a column");
  assert.equal(ring.read(7).max, 0.75, "and it is the last column");
  assert.equal(ring.pushColumn(999, -1, 1), false, "a frame before the pass is no column");
  assert.equal(ring.pushColumn(1800, -1, 1), false, "and neither is one past its end");
  assert.equal(ring.read(0).max, 0.5, "the refused columns changed nothing");

  ring.fillTo(1000 + 250);
  assert.equal(ring.read(1).min, 0, "the gap is filled with silence");
  assert.equal(ring.read(2).max, 0, "every column up to the playhead is silence");
  assert.equal(ring.read(0).max, 0.5, "and the column that held audio is left alone");
  assert.equal(ring.read(3).max, 0, "a column past the playhead is still empty");
  assert.equal(ring.filled[3], 0, "which the drawer can see");

  ring.setPass(2000, 1600);
  assert.equal(ring.read(0).max, 0, "a new pass starts from an empty picture");
  assert.equal(ring.count, 0, "with nothing in it");
});

test("columnX maps the pass onto the lane and nothing outside it", () => {
  const page = pageApi();
  assert.equal(columnX(1000, 1000, 800, 8), 0, "the pass start is column 0");
  assert.equal(columnX(1799, 1000, 800, 8), 7, "the pass's last frame is the last column");
  assert.equal(columnX(1099, 1000, 800, 8), 0, "a frame inside the first column stays in it");
  assert.equal(columnX(1100, 1000, 800, 8), 1, "and the next one starts the second");
  assert.equal(columnX(999, 1000, 800, 8), -1, "a frame before the pass is -1");
  assert.equal(columnX(1800, 1000, 800, 8), -1, "a frame at the pass end is -1");
  assert.equal(columnX(1000, 1000, 0, 8), -1, "a pass of no length has no columns");
  assert.equal(columnX(1000, 1000, 800, 0), -1, "and neither does a lane of no width");
  assert.equal(columnX(NaN, 1000, 800, 8), -1, "a broken frame is no column");

  // Every frame of one pass lands inside the lane, and every column is reachable.
  for (let frame = 500; frame < 1500; frame += 1) {
    const column = columnX(frame, 500, 1000, 100);
    assert.ok(column >= 0 && column < 100, `frame ${frame} lands in a column, got ${column}`);
    assert.equal(page.columnX(frame, 500, 1000, 100), column, `the page agrees on frame ${frame}`);
  }
  const seen = new Set();
  for (let frame = 500; frame < 1500; frame += 1) seen.add(columnX(frame, 500, 1000, 100));
  assert.equal(seen.size, 100, "a pass of a thousand frames fills a hundred columns");
});

test("chainLabel names an amp only when the chain really holds one", () => {
  const page = pageApi();
  const snap = {
    inserts: {
      ampGtr: { id: "ampGtr", owner: "track:gtr", kind: "amp", order: 1, bypass: false },
      ampKeys: { id: "ampKeys", owner: "track:keys", kind: "amp", order: 1, bypass: false },
      eq: { id: "eq", owner: "track:gtr", kind: "eq", order: 2, bypass: false },
    },
  };
  assert.equal(chainLabel(snap, "gtr", true), "amp on", "an amp with monitoring on says so");
  assert.equal(chainLabel(snap, "gtr", false), "amp off", "the same amp with monitoring off says that");
  assert.equal(chainLabel(snap, "keys", false), "amp off", "another track's amp is its own");
  assert.equal(chainLabel(snap, "bass", true), "", "a track with no chain says nothing");
  assert.equal(page.chainLabel(snap, "gtr", true), "amp on", "the page agrees");

  const bypassed = {
    inserts: { amp: { id: "amp", owner: "track:gtr", kind: "amp", order: 1, bypass: true } },
  };
  assert.equal(chainLabel(bypassed, "gtr", true), "", "a bypassed amp is not in the chain");

  const proposed = {
    inserts: { amp: { id: "amp", owner: "track:gtr", kind: "amp", order: 1, proposed: true } },
  };
  assert.equal(chainLabel(proposed, "gtr", true), "", "an amp nobody accepted plays nothing, so it is not named");

  const bare = { inserts: { amp: { id: "amp", owner: "gtr", kind: "amp", order: 1 } } };
  assert.equal(chainLabel(bare, "gtr", true), "amp on", "and a chain named by its id alone still counts");

  for (const empty of [null, undefined, {}, { inserts: null }, { inserts: {} }]) {
    assert.equal(chainLabel(empty, "gtr", true), "", `${String(empty)} has no amp`);
  }
});

test("sourceLabel says the input and mono or stereo", () => {
  const page = pageApi();
  assert.equal(sourceLabel({ label: "Input 1", channels: 1 }, 0), `Input 1 ${DOT} mono`,
    "a mono arm says mono");
  assert.equal(sourceLabel({ label: "Input 1", channels: 2 }, 0), `Input 1 ${DOT} stereo`,
    "a stereo arm says stereo");
  assert.equal(page.sourceLabel({ label: "Input 1", channels: 1 }, 0), `Input 1 ${DOT} mono`,
    "the page agrees");

  assert.equal(sourceLabel({ channels: 2 }, 0), `input 1 ${DOT} stereo`,
    "an arm the browser has not named yet is the first input");
  assert.equal(sourceLabel({ channels: 1 }, 3), `input 4 ${DOT} mono`,
    "and it is numbered from where the track sits");
  assert.equal(sourceLabel(null, 0), `input 1 ${DOT} stereo`, "no arm at all is the first input, stereo");
  assert.equal(sourceLabel({ label: "   " }, 1), `input 2 ${DOT} stereo`, "a blank name is no name");

  assert.equal(sourceLabel({ label: "Microphone (Realtek(R) Audio)", channels: 2 }, 0),
    `Microphone ${DOT} stereo`, "the driver description in brackets is dropped");
  assert.equal(sourceLabel({ label: "  Line  in  ", channels: 1 }, 0), `Line in ${DOT} mono`,
    "runs of spaces and the ends go");
  assert.equal(sourceLabel({ label: "A very long interface name indeed", channels: 2 }, 0),
    `A very long interface\u2026 ${DOT} stereo`, "a long name is cut at a word and ended with an ellipsis");
});