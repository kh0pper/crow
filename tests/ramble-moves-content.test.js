/**
 * P5 content — the shipped moves library (private engineering notes §5.1).
 *
 * This file reads the shipped directory only: every approved entry, the pins
 * that hold its bytes still, and the counts the picker needs (enough chunks per
 * area, every balancing pair, and six outdoor heart chunks). Nothing here
 * builds a fixture entry; the shape checks belong to the library tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AREAS, BALANCE_AREAS, isChunk, validateDrafts,
} from "../bundles/ramble/server/moves/library.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED_LIBRARY = join(HERE, "..", "bundles", "ramble", "server", "moves", "library");
const PINS = JSON.parse(readFileSync(join(HERE, "ramble-moves-content.pins.json"), "utf8"));

const FILES = readdirSync(SHIPPED_LIBRARY).filter((n) => n.endsWith(".json")).sort();
const ENTRIES = FILES.map((file) => ({
  file,
  entry: JSON.parse(readFileSync(join(SHIPPED_LIBRARY, file), "utf8")),
}));
const CHUNKS = ENTRIES.map((e) => e.entry).filter(isChunk);
const tagged = (area) => CHUNKS.filter((e) => e.areas.includes(area));

test("the shipped file names are exactly the pinned ones", () => {
  assert.deepEqual(FILES, Object.keys(PINS).sort());
});

test("every shipped file still hashes to its pin", () => {
  for (const file of FILES) {
    const digest = createHash("sha256")
      .update(readFileSync(join(SHIPPED_LIBRARY, file)))
      .digest("hex");
    assert.equal(digest, PINS[file], `${file} has changed since it was pinned`);
  }
});

test("every shipped entry is reviewed and names its areas", () => {
  assert.ok(ENTRIES.length > 0, "the shipped library is not empty");
  for (const { file, entry } of ENTRIES) {
    assert.equal(entry.reviewed, true, `${file} is not reviewed`);
    assert.ok(Array.isArray(entry.areas) && entry.areas.length > 0, `${file} names no areas`);
    for (const area of entry.areas) {
      assert.ok(AREAS.includes(area), `${file} names an unknown area: ${area}`);
    }
  }
});

test("the shipped directory drafts cleanly", () => {
  assert.deepEqual(validateDrafts(SHIPPED_LIBRARY), { ok: true, errors: [] });
});

test("every chunk carries its cover: a routine both blocks, a flow its poses", () => {
  assert.ok(CHUNKS.length > 0, "the library offers at least one card");
  for (const entry of CHUNKS) {
    if (entry.kind === "routine") {
      assert.ok(Array.isArray(entry.blocks?.warmup) && entry.blocks.warmup.length > 0,
        `${entry.id} has no warm-up`);
      assert.ok(Array.isArray(entry.blocks?.cooldown) && entry.blocks.cooldown.length > 0,
        `${entry.id} has no cool-down`);
    }
    if (entry.kind === "flow") {
      assert.ok(Array.isArray(entry.flow) && entry.flow.length > 0, `${entry.id} has no poses`);
    }
  }
});

test("there are enough chunks for every area the picker offers", () => {
  assert.ok(tagged("mobility").length >= 4, `mobility chunks: ${tagged("mobility").length}`);
  assert.ok(tagged("core").length >= 2, `core chunks: ${tagged("core").length}`);
  assert.ok(tagged("upper").length >= 2, `upper chunks: ${tagged("upper").length}`);
  assert.ok(tagged("lower").length >= 2, `lower chunks: ${tagged("lower").length}`);

  const outdoorHeart = CHUNKS.filter((e) => e.areas.includes("heart") && e.indoor === false);
  assert.ok(outdoorHeart.length >= 6, `outdoor heart chunks: ${outdoorHeart.length}`);
});

test("every pair of balance areas is covered, and one chunk carries all four", () => {
  for (let i = 0; i < BALANCE_AREAS.length; i += 1) {
    for (let j = i + 1; j < BALANCE_AREAS.length; j += 1) {
      const [a, b] = [BALANCE_AREAS[i], BALANCE_AREAS[j]];
      assert.ok(CHUNKS.some((e) => e.areas.includes(a) && e.areas.includes(b)),
        `no chunk tags both ${a} and ${b}`);
    }
  }
  assert.ok(CHUNKS.some((e) => BALANCE_AREAS.every((area) => e.areas.includes(area))),
    "no chunk tags all four balance areas");
});