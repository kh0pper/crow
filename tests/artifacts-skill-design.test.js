// Artifacts skill + manifest for the Design kit (spec §4.3, §8 PR 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../bundles/artifacts/skills/artifacts.md", import.meta.url), "utf8");
const man = JSON.parse(readFileSync(new URL("../bundles/artifacts/manifest.json", import.meta.url), "utf8"));

test("the skill names both modes by the spawn line and the new source shapes", () => {
  assert.match(skill, /Design kit: installed/);
  assert.match(skill, /Design kit: not installed/);
  assert.doesNotMatch(skill, /skill is in your instructions/, "mode never inferred from skill presence (review H2)");
  assert.match(skill, /kit_missing/);
  assert.match(skill, /`libs`/);
  assert.match(skill, /\{ engine, source \}/);
  assert.match(skill, /house style/i);
  assert.match(skill, /no network/i, "the no-network rule stays");
});

test("the skill states the hand-written diagram, engine and fallback rules", () => {
  assert.match(skill, /design-frontend/);
  assert.match(skill, /<a>/);
  assert.match(skill, /__lib\//);
  assert.match(skill, /front matter/i);
  assert.match(skill, /`icon`/);
  assert.match(skill, /inline data/i);
  assert.match(skill, /usermeta/);
  assert.match(skill, /renderer/i);
  assert.match(skill, /at most (2|two)/i);
});

test("the manifest is bumped from 0.5.5", () => {
  assert.equal(man.version, "0.6.0");
  assert.equal(man.optional_bundles, undefined, "no reader exists for optional_bundles (review L12)");
});
