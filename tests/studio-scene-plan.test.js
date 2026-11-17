/**
 * Studio scene plan — the arrangement read as named bar ranges
 * (`panel/scene-plan.js`).
 *
 * Every case drives the very string the page inlines: the emitted classic
 * script is evaluated with `new Function`, the way the page's own `<script>`
 * tag runs it, and the module's named exports are that same evaluation, so a
 * case can put the two side by side.
 *
 * What they cover: the inline-script rules, a song with sections giving one
 * block per section, placements grouped by the scene their clip plays, the bars
 * outside every section, a placement split around a section, an earlier scene
 * keeping bars a later one also covers, whole bars, blocks in order and never
 * overlapping, a null or nonsense snapshot reading as an empty plan, and the two
 * rulers — the block a bar falls in and the block after it, with a bar at an
 * end_bar belonging to the block that starts there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIP_KEY_PREFIX,
  CLIP_LABEL,
  SCENE_PLAN_SCRIPT,
  SECTION_LABEL,
  blockAt,
  nextBlock,
  planOf,
} from "../bundles/studio/panel/scene-plan.js";

/** The page's copy: the very text the handler inlines, run as the page runs it. */
function pageApi() {
  return new Function("window", `${SCENE_PLAN_SCRIPT}\nreturn window.StudioScenePlan;`)({});
}

/** A song snapshot with the arrangement the case cares about. */
function snapshot(parts = {}) {
  return {
    meta: { title: "Song", bpm: 120 },
    tracks: [{ id: "gtr" }, { id: "keys" }],
    scenes: parts.scenes || [],
    clips: parts.clips || {},
    takes: {},
    arrangement: {
      placements: parts.placements || {},
      markers: parts.markers || {},
      sections: parts.sections || {},
    },
  };
}

test("a song with sections gives one block per section named by it", () => {
  const page = pageApi();
  const snap = snapshot({
    scenes: [{ id: "verse", name: "Verse" }],
    clips: { c1: { id: "c1", track_id: "gtr", scene_id: "verse", name: "Guitar" } },
    placements: { p1: { id: "p1", track_id: "gtr", clip_id: "c1", start_bar: 0, bars: 16 } },
    sections: {
      s1: { id: "s1", start_bar: 0, end_bar: 4, name: "Intro" },
      s2: { id: "s2", start_bar: 4, end_bar: 12, name: "Verse" },
      s3: { id: "s3", start_bar: 12, end_bar: 16, name: "   " },
    },
  });
  const blocks = [
    { start_bar: 0, end_bar: 4, label: "Intro", scene_id: null, section_id: "s1" },
    { start_bar: 4, end_bar: 12, label: "Verse", scene_id: null, section_id: "s2" },
    { start_bar: 12, end_bar: 16, label: SECTION_LABEL, scene_id: null, section_id: "s3" },
  ];
  assert.deepEqual(planOf(snap), blocks, "one block per section, in bar order");
  assert.deepEqual(page.planOf(snap), blocks, "and the page reads the same plan");

  // Two sections that overlap (data from a peer that overlapped them) never give
  // two blocks over one bar: the later one starts where the earlier one ended.
  const overlapped = snapshot({
    sections: {
      a: { id: "a", start_bar: 0, end_bar: 8, name: "Long" },
      b: { id: "b", start_bar: 4, end_bar: 12, name: "Late" },
      c: { id: "c", start_bar: 6, end_bar: 7, name: "Nothing left" },
    },
  });
  assert.deepEqual(planOf(overlapped), [
    { start_bar: 0, end_bar: 8, label: "Long", scene_id: null, section_id: "a" },
    { start_bar: 8, end_bar: 12, label: "Late", scene_id: null, section_id: "b" },
  ]);
});

test("a song with placements and no sections groups consecutive placements of one scene", () => {
  const page = pageApi();
  const snap = snapshot({
    scenes: [{ id: "verse", name: "Verse" }, { id: "chorus", name: "Chorus" }],
    clips: {
      g1: { id: "g1", track_id: "gtr", scene_id: "verse", name: "Verse guitar" },
      k1: { id: "k1", track_id: "keys", scene_id: "verse", name: "Verse keys" },
      c1: { id: "c1", track_id: "gtr", scene_id: "chorus", name: "Chorus guitar" },
    },
    placements: {
      p1: { clip_id: "g1", start_bar: 0, bars: 4 },
      p2: { clip_id: "k1", start_bar: 4, bars: 4 },
      p3: { clip_id: "c1", start_bar: 8, bars: 8 },
      p4: { clip_id: "g1", start_bar: 16, bars: 4 },
      p5: { clip_id: "k1", start_bar: 18, bars: 4 },
    },
  });
  const blocks = [
    { start_bar: 0, end_bar: 8, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 8, end_bar: 16, label: "Chorus", scene_id: "chorus", section_id: null },
    { start_bar: 16, end_bar: 22, label: "Verse", scene_id: "verse", section_id: null },
  ];
  assert.deepEqual(planOf(snap), blocks, "one scene over consecutive bars is one block");
  assert.deepEqual(page.planOf(snap), blocks, "and the page agrees");
});

test("a placement straddling a section is split around it", () => {
  const snap = snapshot({
    scenes: [{ id: "verse", name: "Verse" }],
    clips: { v1: { id: "v1", track_id: "gtr", scene_id: "verse", name: "Verse guitar" } },
    placements: { p1: { clip_id: "v1", start_bar: 0, bars: 12 } },
    sections: { s1: { id: "s1", start_bar: 4, end_bar: 8, name: "Chorus" } },
  });
  assert.deepEqual(planOf(snap), [
    { start_bar: 0, end_bar: 4, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 4, end_bar: 8, label: "Chorus", scene_id: null, section_id: "s1" },
    { start_bar: 8, end_bar: 12, label: "Verse", scene_id: "verse", section_id: null },
  ]);

  // A placement wholly inside a section adds nothing of its own.
  const inside = snapshot({
    scenes: [{ id: "verse", name: "Verse" }],
    clips: { v1: { id: "v1", track_id: "gtr", scene_id: "verse", name: "Verse guitar" } },
    placements: { p1: { clip_id: "v1", start_bar: 5, bars: 2 } },
    sections: { s1: { id: "s1", start_bar: 4, end_bar: 8, name: "Chorus" } },
  });
  assert.deepEqual(planOf(inside), [
    { start_bar: 4, end_bar: 8, label: "Chorus", scene_id: null, section_id: "s1" },
  ]);
});

test("two scenes over the same bars give the earlier one the bars", () => {
  const page = pageApi();
  const snap = snapshot({
    scenes: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    clips: {
      ca: { id: "ca", track_id: "gtr", scene_id: "a", name: "A clip" },
      cb: { id: "cb", track_id: "keys", scene_id: "b", name: "B clip" },
    },
    placements: {
      first: { clip_id: "ca", start_bar: 0, bars: 4 },
      second: { clip_id: "cb", start_bar: 2, bars: 6 },
      covered: { clip_id: "ca", start_bar: 1, bars: 2 },
    },
  });
  const blocks = [
    { start_bar: 0, end_bar: 4, label: "A", scene_id: "a", section_id: null },
    { start_bar: 4, end_bar: 8, label: "B", scene_id: "b", section_id: null },
  ];
  assert.deepEqual(planOf(snap), blocks, "the earlier start wins and the later one is trimmed");
  assert.deepEqual(page.planOf(snap), blocks, "and the page agrees");

  // A placement another one covers entirely leaves nothing behind.
  const covered = snapshot({
    scenes: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    clips: {
      ca: { id: "ca", track_id: "gtr", scene_id: "a", name: "A clip" },
      cb: { id: "cb", track_id: "keys", scene_id: "b", name: "B clip" },
    },
    placements: {
      wide: { clip_id: "ca", start_bar: 0, bars: 8 },
      narrow: { clip_id: "cb", start_bar: 2, bars: 2 },
    },
  });
  assert.deepEqual(planOf(covered), [
    { start_bar: 0, end_bar: 8, label: "A", scene_id: "a", section_id: null },
  ]);
});

test("blocks never overlap and are sorted", () => {
  const snap = snapshot({
    scenes: [{ id: "verse", name: "Verse" }, { id: "chorus", name: "Chorus" }],
    clips: {
      v1: { id: "v1", track_id: "gtr", scene_id: "verse", name: "Verse guitar" },
      c1: { id: "c1", track_id: "keys", scene_id: "chorus", name: "Chorus keys" },
    },
    placements: {
      p1: { clip_id: "v1", start_bar: 0, bars: 12 },
      p2: { clip_id: "c1", start_bar: 2, bars: 8 },
      p3: { clip_id: "c1", start_bar: 20, bars: 4 },
      p4: { clip_id: "v1", start_bar: 20, bars: 2 },
    },
    sections: {
      s1: { id: "s1", start_bar: 4, end_bar: 8, name: "Chorus" },
      s2: { id: "s2", start_bar: 6, end_bar: 10, name: "Bridge" },
      s3: { id: "s3", start_bar: 10, end_bar: 10.5, name: "Tail" },
    },
  });
  const before = JSON.stringify(snap);
  const blocks = planOf(snap);
  assert.equal(JSON.stringify(snap), before, "the snapshot is read, never changed");

  assert.deepEqual(blocks, [
    { start_bar: 0, end_bar: 4, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 4, end_bar: 8, label: "Chorus", scene_id: null, section_id: "s1" },
    { start_bar: 8, end_bar: 10, label: "Bridge", scene_id: null, section_id: "s2" },
    { start_bar: 10, end_bar: 11, label: "Tail", scene_id: null, section_id: "s3" },
    { start_bar: 11, end_bar: 12, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 20, end_bar: 22, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 22, end_bar: 24, label: "Chorus", scene_id: "chorus", section_id: null },
  ]);

  for (let at = 1; at < blocks.length; at += 1) {
    const previous = blocks[at - 1];
    const block = blocks[at];
    assert.ok(block.start_bar >= previous.start_bar, `block ${at} is in bar order`);
    assert.ok(block.start_bar >= previous.end_bar, `block ${at} starts at or after the one before it ends`);
    assert.ok(block.end_bar > block.start_bar, `block ${at} covers a bar`);
  }
});

test("bars are whole numbers: a start rounds down and an end rounds up", () => {
  const snap = snapshot({
    scenes: [{ id: "verse", name: "Verse" }],
    clips: { v1: { id: "v1", track_id: "gtr", scene_id: "verse", name: "Verse guitar" } },
    placements: {
      ragged: { clip_id: "v1", start_bar: 2.5, bars: 2 },
      grown: { clip_id: "v1", start_bar: 8, bars: 1.25 },
    },
  });
  assert.deepEqual(planOf(snap), [
    { start_bar: 2, end_bar: 5, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 8, end_bar: 10, label: "Verse", scene_id: "verse", section_id: null },
  ]);
});

test("an empty arrangement gives []", () => {
  const page = pageApi();
  assert.deepEqual(planOf(snapshot()), [], "no placements and no sections is no plan");
  assert.deepEqual(planOf({ arrangement: {} }), [], "an arrangement with no maps is no plan");
  assert.deepEqual(
    planOf({ arrangement: { placements: {}, markers: {}, sections: {} } }),
    [],
    "three empty maps are no plan",
  );
  assert.deepEqual(planOf(snapshot({ scenes: [{ id: "verse", name: "Verse" }] })), [],
    "a song with scenes and nothing placed anywhere is no plan");
  assert.deepEqual(page.planOf(snapshot()), [], "and the page agrees");
  assert.deepEqual(page.planOf({}), []);
});

test("a placement whose clip has no scene is labelled by its clip name", () => {
  const page = pageApi();
  const snap = snapshot({
    clips: {
      a1: { id: "a1", track_id: "gtr", scene_id: null, name: "Guitar take" },
      a2: { id: "a2", track_id: "keys", scene_id: "", name: "  " },
    },
    placements: {
      p1: { clip_id: "a1", start_bar: 0, bars: 4 },
      p2: { clip_id: "a2", start_bar: 4, bars: 4 },
      p3: { clip_id: "gone", start_bar: 8, bars: 4 },
    },
  });
  const blocks = [
    { start_bar: 0, end_bar: 4, label: "Guitar take", scene_id: null, section_id: null },
    { start_bar: 4, end_bar: 8, label: CLIP_LABEL, scene_id: null, section_id: null },
    { start_bar: 8, end_bar: 12, label: CLIP_LABEL, scene_id: null, section_id: null },
  ];
  assert.deepEqual(planOf(snap), blocks, "a clip with no scene is its own block, named by the clip");
  assert.deepEqual(page.planOf(snap), blocks, "and the page agrees");
  assert.equal(CLIP_LABEL, "Clip", "a clip with no name is a clip");
  assert.equal(CLIP_KEY_PREFIX, "clip:", "and its bars are keyed by the clip");
});

test("blockAt and nextBlock at the edges (bar equal to end_bar belongs to the next block)", () => {
  const page = pageApi();
  const snap = snapshot({
    scenes: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
    clips: {
      ca: { id: "ca", track_id: "gtr", scene_id: "a", name: "A clip" },
      cb: { id: "cb", track_id: "gtr", scene_id: "b", name: "B clip" },
      cc: { id: "cc", track_id: "gtr", scene_id: "c", name: "C clip" },
    },
    placements: {
      p1: { clip_id: "ca", start_bar: 0, bars: 4 },
      p2: { clip_id: "cb", start_bar: 4, bars: 4 },
      p3: { clip_id: "cc", start_bar: 12, bars: 4 },
    },
  });
  const blocks = planOf(snap);
  assert.equal(blocks.length, 3);
  const first = blocks[0];
  const second = blocks[1];
  const third = blocks[2];

  assert.equal(blockAt(blocks, 0), first, "the first bar is in the first block");
  assert.equal(blockAt(blocks, 3.5), first, "a fractional bar is in the block it falls in");
  assert.equal(blockAt(blocks, 4), second, "a bar at an end_bar belongs to the next block");
  assert.equal(blockAt(blocks, 7.999), second);
  assert.equal(blockAt(blocks, 8), null, "a bar in a gap belongs to no block");
  assert.equal(blockAt(blocks, 12), third);
  assert.equal(blockAt(blocks, 15.999), third);
  assert.equal(blockAt(blocks, 16), null, "the last block ends at its end_bar");
  assert.equal(blockAt(blocks, -1), null, "nothing covers a bar before the plan");
  assert.equal(blockAt(blocks, NaN), null, "no number is no block");
  assert.equal(blockAt(blocks, null), null);
  assert.equal(blockAt(null, 4), null);
  assert.equal(blockAt("blocks", 4), null);
  assert.equal(blockAt({ length: 3 }, 4), null, "a plan is an array and nothing else");
  assert.equal(blockAt([null, 7, "x"], 4), null, "and an entry that is not a block is skipped");

  assert.equal(nextBlock(blocks, -1), first, "before the plan it is the first block");
  assert.equal(nextBlock(blocks, 0), second, "inside a block it is the block after it");
  assert.equal(nextBlock(blocks, 3.5), second);
  assert.equal(nextBlock(blocks, 4), third, "a bar at an end_bar already belongs to the next block");
  assert.equal(nextBlock(blocks, 8), third, "in a gap it is the block that starts next");
  assert.equal(nextBlock(blocks, 11.5), third);
  assert.equal(nextBlock(blocks, 12), null, "nothing starts after the last block");
  assert.equal(nextBlock(blocks, 40), null);
  assert.equal(nextBlock(blocks, NaN), null);
  assert.equal(nextBlock(blocks, undefined), null);
  assert.equal(nextBlock(null, 0), null);
  assert.equal(nextBlock([], 0), null);

  assert.equal(page.blockAt(blocks, 4), second, "the page finds the block a bar is in");
  assert.equal(page.nextBlock(blocks, 0), second, "and the block after it");
});

test("a null or nonsense snapshot gives []", () => {
  const page = pageApi();
  for (const bad of [null, undefined, 0, "", "song", [], true, false, NaN]) {
    assert.deepEqual(planOf(bad), [], `planOf(${String(bad)}) is no plan`);
    assert.deepEqual(page.planOf(bad), [], `the page agrees on ${String(bad)}`);
  }

  // Entries a snapshot cannot mean are skipped, never thrown on, and a number
  // that arrives as text is still a number.
  const broken = {
    scenes: [null, 7, { id: "verse", name: "Verse" }],
    clips: { c1: null, c2: "no", c3: { id: "c3", scene_id: "verse" } },
    arrangement: {
      placements: {
        ok: { clip_id: "c3", start_bar: 0, bars: 4 },
        noStart: { clip_id: "c3", bars: 4 },
        noBars: { clip_id: "c3", start_bar: 4 },
        shortBars: { clip_id: "c3", start_bar: 4, bars: 0 },
        nan: { clip_id: "c3", start_bar: NaN, bars: 4 },
        text: { clip_id: "c3", start_bar: "8", bars: "4" },
        nothing: "nope",
        oddClip: { clip_id: "c1", start_bar: 20, bars: 2 },
      },
      sections: {
        missing: { start_bar: 40 },
        nameless: { start_bar: 0, end_bar: 1 },
      },
    },
  };
  assert.deepEqual(planOf(broken), [
    { start_bar: 0, end_bar: 1, label: SECTION_LABEL, scene_id: null, section_id: "nameless" },
    { start_bar: 1, end_bar: 4, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 8, end_bar: 12, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 20, end_bar: 22, label: CLIP_LABEL, scene_id: null, section_id: null },
  ]);
});

test("the exported functions and the page's copy agree", () => {
  const page = pageApi();
  const snap = snapshot({
    scenes: [{ id: "verse", name: "Verse" }, { id: "chorus", name: "Chorus" }],
    clips: {
      v1: { id: "v1", track_id: "gtr", scene_id: "verse", name: "Verse guitar" },
      c1: { id: "c1", track_id: "keys", scene_id: "chorus", name: "Chorus keys" },
    },
    placements: {
      p1: { clip_id: "v1", start_bar: 0, bars: 8 },
      p2: { clip_id: "c1", start_bar: 8, bars: 4 },
      p3: { clip_id: "v1", start_bar: 16, bars: 4 },
    },
    sections: { s1: { id: "s1", start_bar: 4, end_bar: 6, name: "Lift" } },
  });
  const mine = planOf(snap);
  const theirs = page.planOf(snap);
  assert.deepEqual(theirs, mine, "the page builds the same plan");
  assert.deepEqual(mine, [
    { start_bar: 0, end_bar: 4, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 4, end_bar: 6, label: "Lift", scene_id: null, section_id: "s1" },
    { start_bar: 6, end_bar: 8, label: "Verse", scene_id: "verse", section_id: null },
    { start_bar: 8, end_bar: 12, label: "Chorus", scene_id: "chorus", section_id: null },
    { start_bar: 16, end_bar: 20, label: "Verse", scene_id: "verse", section_id: null },
  ]);
  for (const bar of [-1, 0, 3.5, 4, 5, 6, 8, 11, 12, 16, 19.75, 20, 40, NaN]) {
    assert.deepEqual(page.blockAt(theirs, bar), blockAt(mine, bar), `blockAt agrees at ${String(bar)}`);
    assert.deepEqual(page.nextBlock(theirs, bar), nextBlock(mine, bar), `nextBlock agrees at ${String(bar)}`);
  }
});

test("the script has no backtick, dollar-brace, double quote or backslash", () => {
  assert.equal(SCENE_PLAN_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(SCENE_PLAN_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(SCENE_PLAN_SCRIPT.includes('"'), false, "no double quote in the emitted text");
  assert.equal(SCENE_PLAN_SCRIPT.includes("\\"), false, "no backslash in the emitted text");
  assert.equal(SCENE_PLAN_SCRIPT.includes("</script"), false, "it cannot close its own tag");
  assert.doesNotThrow(() => new Function("window", SCENE_PLAN_SCRIPT), "it parses as a classic script");

  const page = pageApi();
  assert.equal(typeof page.planOf, "function", "the page gets the plan");
  assert.equal(typeof page.blockAt, "function", "and the block a bar is in");
  assert.equal(typeof page.nextBlock, "function", "and the block after it");
  assert.equal(page.SECTION_LABEL, SECTION_LABEL, "the section fallback name travels");
  assert.equal(page.CLIP_LABEL, CLIP_LABEL, "with the clip fallback name");
  assert.equal(page.CLIP_KEY_PREFIX, CLIP_KEY_PREFIX, "and the clip key prefix");
  assert.equal(SECTION_LABEL, "Section", "an unnamed section is a section");
});