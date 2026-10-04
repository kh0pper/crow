import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const B = require("../bundles/ramble/server/bird-svg.cjs");
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/bird-svg-golden.json", import.meta.url), "utf8"));
const genome = (seed, sp, outfit) => (outfit ? B.applyOutfit(B.rollGenome(seed, sp), outfit) : B.rollGenome(seed, sp));
const FULL = { hat: "beanie", scarf: "stripe", glasses: "shades" };

test("default output is byte-identical to 0.13.0, outfits included (golden)", () => {
  for (const g of GOLDEN) assert.equal(B.drawBird(genome(g.seed, g.sp, g.outfit), g.mood), g.svg, `${g.sp}/${g.seed}/${g.mood}/${JSON.stringify(g.outfit)}`);
});

test("hooks output carries every class hook", () => {
  const svg = B.drawBird(genome(7, "crow", FULL), "happy", { hooks: true });
  for (const c of ["rb-bird", "rb-feet", "rb-tail", "rb-body", "rb-wing", "rb-head", "rb-eye", "rb-beak", "rb-beak-upper", "rb-beak-lower"]) assert.ok(svg.includes(`class="${c}"`), c);
  assert.ok(svg.indexOf('class="rb-eye"') < svg.indexOf("r=\"10.5\""), "glasses sit outside the eye group (a blink never squashes them)");
});

const prims = (svg) => (svg.match(/<(ellipse|circle|path|rect|text)\b[^>]*>/g) || []).map((s) => s.replace(/ class="[^"]*"/, ""));
const BEAK_DS = [B.PARTS.beak, B.PARTS.longbeak, B.PARTS.beakUpper, B.PARTS.beakLower, B.PARTS.longbeakUpper, B.PARTS.longbeakLower];
const notBeak = (p) => !BEAK_DS.some((d) => p.includes(`d="${d}"`));

test("hooks output has the same geometry apart from the split beak (dressed and undressed)", () => {
  for (const sp of B.ROSTER) for (const seed of [0, 42, 304]) for (const mood of ["happy", "tired", "alarmed"]) for (const outfit of [null, FULL]) {
    const g = genome(seed, sp, outfit);
    assert.deepEqual(prims(B.drawBird(g, mood, { hooks: true })).filter(notBeak).sort(), prims(B.drawBird(g, mood)).filter(notBeak).sort(), `${sp}/${seed}/${mood}/${!!outfit}`);
  }
});

/** shoelace area of "M x y l dx dy l dx dy z" */
function area(d) {
  const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const p = [[n[0], n[1]]]; p.push([p[0][0] + n[2], p[0][1] + n[3]]); p.push([p[1][0] + n[4], p[1][1] + n[5]]);
  return Math.abs((p[0][0] * (p[1][1] - p[2][1]) + p[1][0] * (p[2][1] - p[0][1]) + p[2][0] * (p[0][1] - p[1][1])) / 2);
}
test("beak halves tile the original beak exactly", () => {
  assert.equal(area(B.PARTS.beakUpper) + area(B.PARTS.beakLower), area(B.PARTS.beak));
  assert.equal(area(B.PARTS.longbeakUpper) + area(B.PARTS.longbeakLower), area(B.PARTS.longbeak));
});

test("hooked bird size: ≤ 2,048 B undressed, ≤ 2,560 B fully dressed (ruling R18)", () => {
  let plain = 0, dressed = 0;
  for (const sp of B.ROSTER) for (let s = 0; s < 200; s++) for (const m of ["happy", "tired", "alarmed"]) {
    plain = Math.max(plain, B.drawBird(genome(s, sp), m, { hooks: true }).length);
    dressed = Math.max(dressed, B.drawBird(genome(s, sp, FULL), m, { hooks: true }).length);
  }
  assert.ok(plain <= 2048, `undressed max ${plain}`);
  assert.ok(dressed <= 2560, `dressed max ${dressed}`);
});
