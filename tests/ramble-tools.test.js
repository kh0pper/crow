import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createRambleServer } from "../bundles/ramble/server/server.js";
import { WARMTH_DEFAULTS, isoWeek } from "../bundles/ramble/server/eggs.js";
import { encodeGeohash } from "../bundles/ramble/server/anchors.js";
import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";

let db, h;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const handlers = {};
  const compressed = (s) => "02" + createHash("sha256").update(s).digest("hex");
  const fakeDerive = (seed, botId) => ({ secp256k1Pubkey: compressed(seed + botId), secp256k1Priv: Buffer.from(botId) });
  const identity = { crowId: "crow_T", secp256k1Pubkey: compressed("real"), secp256k1Priv: Buffer.from("real") };
  createRambleServer(db, { _exposeHandlers: handlers, identity, seed: "seed", _derive: fakeDerive, emit: async () => {} });
  h = handlers;
});

test("leave_mark then query_world returns it, attributed to the x-only world pseudonym", async () => {
  const r = await h.ramble_leave_mark({ lat: 30.2672, lon: -97.7431, text: "hello", visibility: "public", reveal: "open" });
  assert.ok(!r.isError);
  const q = await h.ramble_query_world({ lat: 30.2672, lon: -97.7431, visibility: "public" });
  const payload = JSON.parse(q.content[0].text);
  const m = payload.marks.find((m) => m.content_text === "hello");
  assert.ok(m);
  assert.match(m.author, /^[0-9a-f]{64}$/);
});

test("ramble_leave_mark with visibility:private succeeds and ramble_query_world({visibility:private}) returns it", async () => {
  const lat = 51.5074, lon = -0.1278;
  const r = await h.ramble_leave_mark({ lat, lon, text: "just me", visibility: "private" });
  assert.ok(!r.isError);
  const q = await h.ramble_query_world({ lat, lon, visibility: "private" });
  const payload = JSON.parse(q.content[0].text);
  const m = payload.marks.find((m) => m.content_text === "just me");
  assert.ok(m);
});

test("ramble_leave_mark rejects an unknown visibility such as 'friends'", async () => {
  const r = await h.ramble_leave_mark({ lat: 1, lon: 1, text: "nope", visibility: "friends" });
  assert.ok(r.isError);
});

test("ramble_block hides that persona's marks; ramble_unblock restores them", async () => {
  const lat = 40.7128, lon = -74.006;
  const leave = await h.ramble_leave_mark({ lat, lon, text: "block-me", visibility: "public", reveal: "open" });
  assert.ok(!leave.isError);

  const beforeBlock = JSON.parse((await h.ramble_query_world({ lat, lon, visibility: "public" })).content[0].text);
  const mark = beforeBlock.marks.find((m) => m.content_text === "block-me");
  assert.ok(mark);
  const author = mark.author;

  const blockRes = await h.ramble_block({ persona: author, reason: "test" });
  assert.ok(!blockRes.isError);

  const afterBlock = JSON.parse((await h.ramble_query_world({ lat, lon, visibility: "public" })).content[0].text);
  assert.ok(
    !afterBlock.marks.find((m) => m.content_text === "block-me"),
    "blocked author's mark must not appear in query_world, even though it's a local row",
  );

  const unblockRes = await h.ramble_unblock({ persona: author });
  assert.ok(!unblockRes.isError);

  const afterUnblock = JSON.parse((await h.ramble_query_world({ lat, lon, visibility: "public" })).content[0].text);
  assert.ok(afterUnblock.marks.find((m) => m.content_text === "block-me"), "unblocking restores visibility");
});

test("concurrent FIRST-call ramble_caw invocations resolve a single shared session identity", async () => {
  // A fresh server instance, with identityPromise/emitPromise still
  // unmemoized, so the two concurrent calls below race on the very first
  // resolution (the scenario the promise-memoization fix guards).
  const freshHandlers = {};
  const compressed = (s) => "02" + createHash("sha256").update(s).digest("hex");
  const fakeDerive = (seed, botId) => ({ secp256k1Pubkey: compressed(seed + botId), secp256k1Priv: Buffer.from(botId) });
  const identity = { crowId: "crow_T2", secp256k1Pubkey: compressed("real2"), secp256k1Priv: Buffer.from("real2") };
  createRambleServer(db, { _exposeHandlers: freshHandlers, identity, seed: "seed2", _derive: fakeDerive, emit: async () => {} });

  const [a, b] = await Promise.all([
    freshHandlers.ramble_caw({ lat: 51.5074, lon: -0.1278, text: "caw-a" }),
    freshHandlers.ramble_caw({ lat: 51.5074, lon: -0.1278, text: "caw-b" }),
  ]);
  assert.ok(!a.isError && !b.isError);
  const pa = JSON.parse(a.content[0].text);
  const pb = JSON.parse(b.content[0].text);
  // Same author_level "rotating" + kind "caw" => a per-session key derived
  // from the process's single sessionId. Two different sessionIds (the
  // promise-memoization race) would produce two different authors here.
  assert.equal(pa.author, pb.author);
});

test("ramble_pet_state returns the pet's current state", async () => {
  const r = await h.ramble_pet_state({});
  assert.ok(!r.isError);
  const state = JSON.parse(r.content[0].text);
  assert.ok(["happy", "tired", "alarmed"].includes(state.mood));
  assert.equal(typeof state.energy, "number");
  assert.equal(typeof state.places_week, "number");
  assert.equal(typeof state.unlocks_week, "number");
  assert.equal(typeof state.crows_week, "number");
});

test("ramble_unlock on an in-range open mark feeds unlock_mark (unlocks_week increments)", async () => {
  const lat = 35.0, lon = -80.0;
  const leave = await h.ramble_leave_mark({ lat, lon, text: "open note", visibility: "public", reveal: "open" });
  assert.ok(!leave.isError);
  const leavePayload = JSON.parse(leave.content[0].text);

  const before = JSON.parse((await h.ramble_pet_state({})).content[0].text);

  const unlockRes = await h.ramble_unlock({ mark_id: leavePayload.mark_id, lat, lon });
  assert.ok(!unlockRes.isError);
  const unlocked = JSON.parse(unlockRes.content[0].text);
  assert.equal(unlocked.unlocked, true);

  const after = JSON.parse((await h.ramble_pet_state({})).content[0].text);
  assert.equal(after.unlocks_week, before.unlocks_week + 1, "a successful unlock must feed unlock_mark");
});

test("ramble_egg_state returns a numeric egg.percent between 0 and 100", async () => {
  const r = await h.ramble_egg_state({});
  assert.ok(!r.isError);
  const payload = JSON.parse(r.content[0].text);
  assert.equal(typeof payload.egg.percent, "number");
  assert.ok(payload.egg.percent >= 0 && payload.egg.percent <= 100);
});

test("ramble_checkin credits once per local day; a second same-day call is not credited", async () => {
  const first = JSON.parse((await h.ramble_checkin({})).content[0].text);
  assert.equal(first.credited, true);
  const second = JSON.parse((await h.ramble_checkin({})).content[0].text);
  assert.equal(second.credited, false);
});

test("ramble_chore completes once per local day per kind; a second same-day call for the same kind is a no-op", async () => {
  const first = JSON.parse((await h.ramble_chore({ kind: "feed" })).content[0].text);
  assert.equal(first.done, true);
  const second = JSON.parse((await h.ramble_chore({ kind: "feed" })).content[0].text);
  assert.equal(second.done, false);
});

test("ramble_chore with an unknown kind returns isError", async () => {
  const r = await h.ramble_chore({ kind: "nap" });
  assert.ok(r.isError);
});

test("ramble_leave_mark feeds mark_left warmth into the egg (delta, not absolute)", async () => {
  const before = JSON.parse((await h.ramble_egg_state({})).content[0].text);
  const leave = await h.ramble_leave_mark({ lat: 10, lon: 10, text: "warmth-check", visibility: "public", reveal: "open" });
  assert.ok(!leave.isError);
  const after = JSON.parse((await h.ramble_egg_state({})).content[0].text);
  assert.equal(after.egg.warmth - before.egg.warmth, WARMTH_DEFAULTS.mark_left, "mark_left should credit WARMTH_DEFAULTS.mark_left");
});

test("ramble_pet_state includes an egg.percent number and a bird key (null before any hatch)", async () => {
  const r = await h.ramble_pet_state({});
  assert.ok(!r.isError);
  const state = JSON.parse(r.content[0].text);
  assert.equal(typeof state.egg.percent, "number");
  assert.equal(state.bird, null);
});

test("ramble_flock returns the roster shape", async () => {
  const r = await h.ramble_flock({});
  assert.ok(!r.isError);
  const s = JSON.parse(r.content[0].text);
  assert.ok(Array.isArray(s.birds) && Array.isArray(s.eggs));
  assert.equal(s.species_total, 8);
  assert.equal(s.eggs[0].status, "incubating");
});

test("ramble_nests lists deterministic nests nearest-first; ramble_claim_nest claims one, idempotently, then hits the daily limit", async () => {
  // The tools use the real clock, so nests depend on THIS week. A fixed box
  // is not a deterministic guarantee (2026-W06 has a single nest in a ±0.01°
  // box at 30.46/-98.08): derive two nest points from the formula instead.
  const week = isoWeek(Date.now());
  const found = [];
  for (let i = 0; i < 5000 && found.length < 2; i++) {
    const n = nestFor(encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7), week);
    if (n) found.push(n);
  }
  assert.equal(found.length, 2, "two nests within 5000 cells north of the start point");
  const [nest, other] = found;

  const one = JSON.parse((await h.ramble_nests({ lat: nest.lat, lon: nest.lon })).content[0].text);
  const two = JSON.parse((await h.ramble_nests({ lat: nest.lat, lon: nest.lon })).content[0].text);
  assert.deepEqual(one, two, "nests must be a pure function of place and week");
  assert.equal(one.week, week);
  assert.equal(one.nests[0].cell, nest.cell, "the nest we stand on is nearest");
  assert.equal(one.nests[0].distance_m, 0);
  assert.equal(one.nests[0].claimed, false);
  for (let i = 1; i < one.nests.length; i++) assert.ok(one.nests[i].distance_m >= one.nests[i - 1].distance_m);

  const eggBefore = JSON.parse((await h.ramble_egg_state({})).content[0].text);
  const petBefore = JSON.parse((await h.ramble_pet_state({})).content[0].text);

  const far = JSON.parse((await h.ramble_claim_nest({ lat: nest.lat + 0.01, lon: nest.lon, cell: nest.cell })).content[0].text);
  assert.deepEqual(far, { claimed: false, reason: "too-far" });

  const got = JSON.parse((await h.ramble_claim_nest({ lat: nest.lat, lon: nest.lon })).content[0].text);
  assert.equal(got.claimed, true); assert.equal(got.already, false);
  assert.equal(got.egg.status, "shelf"); assert.equal(got.egg.shelf_origin, "user"); assert.equal(got.egg.found_cell, nest.cell);
  const again = JSON.parse((await h.ramble_claim_nest({ lat: nest.lat, lon: nest.lon, cell: nest.cell })).content[0].text);
  assert.equal(again.already, true); assert.equal(again.egg.egg_id, got.egg.egg_id);

  const listed = JSON.parse((await h.ramble_nests({ lat: nest.lat, lon: nest.lon })).content[0].text);
  assert.equal(listed.nests[0].claimed, true);

  const limit = JSON.parse((await h.ramble_claim_nest({ lat: other.lat, lon: other.lon })).content[0].text);
  assert.deepEqual(limit, { claimed: false, reason: "daily-limit" });

  const flock = JSON.parse((await h.ramble_flock({})).content[0].text);
  assert.ok(flock.eggs.some((e) => e.egg_id === got.egg.egg_id && e.status === "shelf"));
  // A claim is not activity: neither the incubating egg's warmth nor the pet moved.
  const eggAfter = JSON.parse((await h.ramble_egg_state({})).content[0].text);
  const petAfter = JSON.parse((await h.ramble_pet_state({})).content[0].text);
  assert.equal(eggAfter.egg.warmth, eggBefore.egg.warmth);
  assert.equal(petAfter.energy, petBefore.energy);
});
