import { test } from "node:test";
import assert from "node:assert/strict";
import { teaser, revealContent } from "../bundles/ramble/server/reveal.js";

const locked = { mark_id: "m1", reveal: "locked", anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75, geohash: "9v6m2a", content_text: "secret spot", content_kind: "none" };
const open   = { ...locked, mark_id: "m2", reveal: "open" };

test("teaser strips content for locked, keeps it for open", () => {
  assert.equal(teaser(locked).content_text, undefined);
  assert.equal(teaser(locked).geohash, "9v6m2a"); // existence + coarse location survive
  assert.equal(teaser(open).content_text, "secret spot");
});

test("revealContent gates locked content on range, open is always revealed", () => {
  assert.equal(revealContent(locked, { lat: 30.30, lon: -97.74 }).unlocked, false);
  assert.equal(revealContent(locked, { lat: 30.2673, lon: -97.7431 }).content.content_text, "secret spot");
  assert.equal(revealContent(open, null).unlocked, true);
});

test("teaser locked allowlist excludes exact coordinates and anchor_ref", () => {
  const teasered = teaser(locked);
  assert.equal(teasered.lat, undefined, "lat must be withheld");
  assert.equal(teasered.lon, undefined, "lon must be withheld");
  assert.equal(teasered.anchor_ref, undefined, "anchor_ref must be withheld");
  assert.equal(teasered.content_text, undefined, "content_text must be withheld");
});

test("teaser treats reveal:undefined as locked", () => {
  const noReveal = { ...locked, reveal: undefined };
  const teasered = teaser(noReveal);
  assert.equal(teasered.lat, undefined, "undefined reveal is locked");
  assert.equal(teasered.content_text, undefined);
});
