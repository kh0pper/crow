/**
 * Studio panel — the transport bar's pure half.
 *
 * S3 builds the bar as its own inline classic script (panel/transport-bar.js);
 * S4 mounts it in the page and brings the page cases with it. The cases here
 * are the two helpers the page half is built on: the scene readout's label and
 * the reducer that keeps the scene waiting for the next bar.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextQueued, sceneLabel } from "../bundles/studio/panel/transport-bar.js";

test("sceneLabel names current and next and falls back to '-'", () => {
  const snap = {
    scenes: [
      { id: "verse", name: "Verse" },
      { id: "chorus", name: "Chorus" },
      { id: "untitled", name: "" },
    ],
  };
  assert.equal(sceneLabel(snap, "verse"), "Now: Verse");
  assert.equal(sceneLabel(snap, "chorus", "next"), "Next: Chorus");
  // A scene with no name falls back to its id rather than reading as a dash.
  assert.equal(sceneLabel(snap, "untitled"), "Now: untitled");
  // Nothing named, a scene this song does not have, and no snapshot at all.
  assert.equal(sceneLabel(snap, null), "-");
  assert.equal(sceneLabel(snap, ""), "-");
  assert.equal(sceneLabel(snap, "gone"), "-");
  assert.equal(sceneLabel(null, "verse"), "-");
  assert.equal(sceneLabel(undefined, undefined), "-");
});

test("queuedScene clears on stop, on a launched report, and a newer launch replaces it", () => {
  assert.equal(nextQueued(null, null), null);
  assert.equal(nextQueued(undefined, { type: "launch", scene_id: "verse" }), "verse");

  const queued = nextQueued("verse", { type: "launch", scene_id: "chorus" });
  assert.equal(queued, "chorus");

  // A launch that names no scene changes nothing.
  assert.equal(nextQueued(queued, { type: "launch" }), "chorus");
  assert.equal(nextQueued(queued, { type: "launch", scene_id: "" }), "chorus");

  assert.equal(nextQueued(queued, { type: "stop" }), null);
  // Any applied launch report clears it, whether or not it names the scene.
  assert.equal(nextQueued(queued, { type: "launched" }), null);
  assert.equal(nextQueued(queued, { type: "launched", scene_id: "chorus" }), null);
});