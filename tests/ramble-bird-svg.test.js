import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Bird = require("../bundles/ramble/server/bird-svg.cjs");

test("roster is the lab flock and species table is complete", () => {
  assert.deepEqual(Bird.ROSTER, ["crow","raven","grackle","magpie","mockingbird","hummingbird","penguin","blackswan"]);
  for (const id of Bird.ROSTER) assert.ok(Bird.SPECIES[id] && Bird.SPECIES[id].name, id);
});

test("genome + drawing are deterministic and species/seed-sensitive", () => {
  const a = Bird.rollGenome(123456, "crow"), b = Bird.rollGenome(123456, "crow");
  assert.deepEqual(a, b);
  assert.equal(Bird.drawBird(a), Bird.drawBird(b));
  assert.notEqual(Bird.drawBird(Bird.rollGenome(123457, "crow")), Bird.drawBird(a));
  assert.notEqual(Bird.drawBird(Bird.rollGenome(123456, "raven")), Bird.drawBird(a));
  assert.ok(Bird.drawBird(a).startsWith("<g"));
});

test("moods change the drawing; invalid inputs throw", () => {
  const g = Bird.rollGenome(7, "magpie");
  assert.notEqual(Bird.drawBird(g, "tired"), Bird.drawBird(g, "happy"));
  assert.notEqual(Bird.drawBird(g, "alarmed"), Bird.drawBird(g, "happy"));
  assert.throws(() => Bird.rollGenome(7, "dodo"));
  assert.throws(() => Bird.rollGenome(-1, "crow"));
  assert.throws(() => Bird.rollGenome(2 ** 32, "crow"));
});

test("isValidBird gates the wire shape", () => {
  assert.equal(Bird.isValidBird({ species: "crow", seed: 1 }), true);
  assert.equal(Bird.isValidBird({ species: "dodo", seed: 1 }), false);
  assert.equal(Bird.isValidBird({ species: "crow", seed: 1.5 }), false);
  assert.equal(Bird.isValidBird({ species: "crow", seed: 2 ** 32 }), false);
  assert.equal(Bird.isValidBird(null), false);
});

test("drawEgg is deterministic per seed", () => {
  assert.equal(Bird.drawEgg(5), Bird.drawEgg(5));
  assert.notEqual(Bird.drawEgg(5), Bird.drawEgg(6));
  assert.throws(() => Bird.drawEgg(-1));
});

test("drawWalkingEgg is deterministic per seed and differs from drawEgg", () => {
  assert.equal(Bird.drawWalkingEgg(5), Bird.drawWalkingEgg(5));
  assert.notEqual(Bird.drawWalkingEgg(5), Bird.drawEgg(5));
  assert.throws(() => Bird.drawWalkingEgg(-1));
});

test("parts are overridable by name (asset-pack seam)", () => {
  const g = Bird.rollGenome(42, "penguin");
  const before = Bird.drawBird(g);
  const saved = Bird.PARTS.beak;
  Bird.PARTS.beak = "M0 0 h1"; // an override
  try { assert.notEqual(Bird.drawBird(g), before); } finally { Bird.PARTS.beak = saved; }
});

test("no ESM syntax (must load as a classic browser script)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bundles/ramble/server/bird-svg.cjs", import.meta.url), "utf8");
  assert.ok(!/^\s*(import|export)\s/m.test(src));
});

test("drawSeed: a grain that reads as food, not as another UI dot", () => {
  const svg = Bird.drawSeed();
  assert.match(svg, /<ellipse/, "the husk");
  assert.ok(svg.includes("#e8b256"), "warm against a blue-grey map, which is what makes it findable");
  assert.ok(!svg.includes("var(--"), "the engine draws with literals — it has no stylesheet");
  assert.ok(!/[`]/.test(svg), "no backtick can reach a panel script through the engine");

  // mountSeed must set the viewBox itself, like every other mount* in here:
  // callers hand it a bare <svg> and the art is meaningless without one.
  const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, set innerHTML(v) { this.html = v; } };
  Bird.mountSeed(el);
  assert.equal(el.attrs.viewBox, "0 0 24 24");
  assert.equal(el.html, svg);
});
