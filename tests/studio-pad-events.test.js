/**
 * Studio pad events — the ring the audio thread fills and the page drains.
 *
 * `pad-events.js` is the one engine file whose whole job is bookkeeping, so it
 * is tested on its own here: the order, the fixed size, the oldest-goes-first
 * overflow rule and the promise that a push allocates nothing.
 *
 * It is a classic script, so it is loaded the way a Node caller loads it:
 * `require()` from inside the bundle, where `engine/package.json` marks the
 * directory CommonJS. That is the same file the worklet module concatenates, so
 * the second test evaluates it as one (a `vm` scope with no `module`, the way an
 * `AudioWorkletGlobalScope` has none) and reads the global it defines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const SOURCE = readFileSync(join(ENGINE_DIR, "pad-events.js"), "utf8");
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const StudioPadEvents = bundleRequire(join(ENGINE_DIR, "pad-events.js"));

const BANK = "bank-a";

/** Push one hit on one pad. */
function pushHit(ring, index, over = {}) {
  ring.push(
    over.frame === undefined ? 4800 : over.frame,
    over.track_id === undefined ? "track-1" : over.track_id,
    over.bank_id === undefined ? BANK : over.bank_id,
    index,
    StudioPadEvents.KIND_HIT,
    over.v === undefined ? 100 : over.v,
    0,
  );
}

test("PadEventRing drains in order and empties", () => {
  const ring = StudioPadEvents.create();
  pushHit(ring, 3, { frame: 4800, v: 100 });
  pushHit(ring, 7, { frame: 6000, v: 127 });
  pushHit(ring, 11, { frame: 6000, v: 1, track_id: "track-2", bank_id: "bank-b" });
  assert.equal(ring.size(), 3);

  const events = ring.drain();
  assert.deepEqual(
    events.map((event) => [event.frame, event.track_id, event.bank_id, event.index, event.kind, event.v]),
    [
      [4800, "track-1", "bank-a", 3, "hit", 100],
      [6000, "track-1", "bank-a", 7, "hit", 127],
      [6000, "track-2", "bank-b", 11, "hit", 1],
    ],
    "the events have to arrive in the order the voices started",
  );
  // A hit says nothing about a state, and a state nothing about a velocity.
  for (const event of events) assert.equal(Object.hasOwn(event, "state"), false);

  assert.equal(ring.size(), 0, "a drain empties the ring");
  assert.deepEqual(ring.drain(), [], "and there is nothing left for a second post");
});

test("a 257th push drops the oldest", () => {
  const ring = StudioPadEvents.create();
  const total = StudioPadEvents.RING_SIZE + 1;
  for (let index = 0; index < total; index += 1) pushHit(ring, index, { frame: index });

  const events = ring.drain();
  assert.equal(events.length, StudioPadEvents.RING_SIZE, "the ring holds one block's worth and no more");
  assert.equal(events[0].index, 1, "the oldest record (pad 0) went first");
  assert.equal(events[0].frame, 1, "and it took its own frame with it");
  assert.equal(events[events.length - 1].index, total - 1, "the newest record is the last one pushed");
  assert.equal(ring.size(), 0);
});

test("drain on an empty ring returns []", () => {
  const ring = StudioPadEvents.create();
  assert.equal(ring.size(), 0);
  const events = ring.drain();
  assert.deepEqual(events, [], "a ring with nothing in it posts nothing");
  assert.equal(Array.isArray(events), true);
  // It stays usable: an empty drain is not a reset the caller has to make.
  pushHit(ring, 5);
  assert.equal(ring.drain().length, 1);
});

test("push creates no new record object (record identity is stable across 1000 pushes)", () => {
  const ring = StudioPadEvents.create();
  const records = ring.records;
  const before = Array.from(records);
  assert.equal(records.length, StudioPadEvents.RING_SIZE, "every record is allocated once, in create()");

  for (let index = 0; index < 1000; index += 1) {
    pushHit(ring, index % 16, { frame: index * 128 });
    if (index % 3 === 0) ring.drain();
  }

  assert.equal(ring.records, records, "the ring keeps its own record array");
  assert.equal(records.length, StudioPadEvents.RING_SIZE, "and never grows it");
  for (let at = 0; at < records.length; at += 1) {
    assert.equal(records[at], before[at], `record ${at} is the very object it was at the start`);
  }
});

test("a state record carries its state code and no velocity", () => {
  const ring = StudioPadEvents.create();
  ring.push(12000, "track-1", BANK, 4, StudioPadEvents.KIND_STATE, 0, 2);
  const events = ring.drain();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    frame: 12000,
    track_id: "track-1",
    bank_id: BANK,
    index: 4,
    kind: "state",
    state: 2,
  });
});

test("the four state codes are off, on, loop and held, in that priority", () => {
  // The processor packs a pad's state in two bits and resolves a pad with more
  // than one voice by the HIGHEST code, so the order of these values is the
  // rule: held beats loop beats sounding beats off.
  assert.deepEqual(
    [StudioPadEvents.STATE_OFF, StudioPadEvents.STATE_ON, StudioPadEvents.STATE_LOOP, StudioPadEvents.STATE_HELD],
    [0, 1, 2, 3],
    "two bits hold these four codes, and their order is their priority",
  );

  // A ring carries each of them through untouched: the page reads the code the
  // scan packed, not a name the worklet had to build.
  const ring = StudioPadEvents.create();
  const codes = [
    StudioPadEvents.STATE_OFF,
    StudioPadEvents.STATE_ON,
    StudioPadEvents.STATE_LOOP,
    StudioPadEvents.STATE_HELD,
  ];
  for (let at = 0; at < codes.length; at += 1) {
    ring.push(128 * at, "track-1", BANK, at, StudioPadEvents.KIND_STATE, 0, codes[at]);
  }
  assert.deepEqual(
    Array.from(ring.drain(), (event) => [event.index, event.state]),
    [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ],
    "every state code survives the ring as it was pushed",
  );
});

test("the file evaluates as a classic script and as require()", async () => {
  // The way the worklet gets it: one module, no `module`, no imports.
  const vm = await import("node:vm");
  assert.equal(/^\s*(import|export)\b/m.test(SOURCE), false, "a classic script has no import or export statement");

  const scope = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(scope);
  vm.runInContext(SOURCE, scope, { filename: "pad-events.js" });
  const fromScript = scope.StudioPadEvents;
  assert.ok(fromScript, "the classic script defines globalThis.StudioPadEvents");

  // The way a Node caller gets it (the same file the worklet concatenates).
  assert.ok(StudioPadEvents, "require() hands back the same api");
  assert.equal(fromScript.RING_SIZE, StudioPadEvents.RING_SIZE);
  assert.equal(fromScript.KIND_HIT, StudioPadEvents.KIND_HIT);
  assert.equal(fromScript.KIND_STATE, StudioPadEvents.KIND_STATE);
  assert.equal(fromScript.STATE_OFF, StudioPadEvents.STATE_OFF);
  assert.equal(fromScript.STATE_ON, StudioPadEvents.STATE_ON);
  assert.equal(fromScript.STATE_LOOP, StudioPadEvents.STATE_LOOP);
  assert.equal(fromScript.STATE_HELD, StudioPadEvents.STATE_HELD);

  // And both copies behave the same, so a test's ring is the worklet's ring.
  // (Compared field by field: a `vm` scope's objects have that scope's
  // prototypes, so a deep-equal against this realm's literals is not the point.)
  const ring = fromScript.create();
  ring.push(96, "track-1", BANK, 1, fromScript.KIND_HIT, 64, 0);
  const events = ring.drain();
  assert.equal(events.length, 1);
  assert.deepEqual(
    [events[0].frame, events[0].track_id, events[0].bank_id, events[0].index, events[0].kind, events[0].v],
    [96, "track-1", BANK, 1, "hit", 64],
  );
});