import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARK_KIND,
  CAW_KIND,
  RambleNotPublic,
  markToEvent,
  eventToMark,
} from "../bundles/ramble/server/nostr-map.js";

const NOW = 1735689600000; // fixed ms epoch for deterministic fixtures

function gTags(event) {
  return event.tags.filter((t) => t[0] === "g").map((t) => t[1]);
}

function tagValue(event, key) {
  return event.tags.find((t) => t[0] === key)?.[1] ?? null;
}

const openMarkRow = {
  mark_id: "mark-open-1",
  author: "pk1",
  author_level: "rotating",
  kind: "mark",
  anchor_kind: "geo",
  geohash: "9v6m2ab",
  lat: 30.2672,
  lon: -97.7431,
  accuracy_m: 75,
  visibility: "public",
  reveal: "open",
  content_text: "open coffee",
  content_kind: "none",
  content_ref: null,
  created_at: NOW,
  expires_at: NOW + 3600000,
  nostr_event_id: null,
};

const lockedMarkRow = {
  ...openMarkRow,
  mark_id: "mark-locked-1",
  reveal: "locked",
  content_text: "secret spot",
};

const cawRow = {
  mark_id: "caw-1",
  author: "pk1",
  author_level: "rotating",
  kind: "caw",
  anchor_kind: "geo",
  geohash: "9v6m2ab",
  lat: 30.2672,
  lon: -97.7431,
  accuracy_m: 75,
  visibility: "public",
  reveal: "open",
  content_text: "here now",
  content_kind: "none",
  content_ref: null,
  created_at: NOW,
  expires_at: NOW + 3600000,
  nostr_event_id: null,
};

test("open mark round-trips: MARK_KIND, full geohash g-tags, d tag, geohash preserved", () => {
  const event = markToEvent(openMarkRow);
  assert.equal(event.kind, MARK_KIND);
  assert.equal(event.created_at, Math.floor(NOW / 1000));

  const gs = gTags(event);
  assert.deepEqual(gs, ["9", "9v", "9v6", "9v6m", "9v6m2", "9v6m2a", "9v6m2ab"]);

  assert.equal(tagValue(event, "d"), "mark-open-1");
  assert.equal(tagValue(event, "k"), "geo");
  assert.equal(tagValue(event, "rv"), "open");
  assert.equal(tagValue(event, "expiration"), String(Math.floor(openMarkRow.expires_at / 1000)));
  assert.equal(tagValue(event, "crow"), null); // no crowId passed

  const content = JSON.parse(event.content);
  assert.equal(content.v, 1);
  assert.equal(content.text, "open coffee");
  assert.equal(content.content_kind, "none");
  assert.equal(content.locked, false);
  assert.equal("content_ref" in content, false);
  assert.equal(content.lat, 30.2672);
  assert.equal(content.lon, -97.7431);
  assert.equal(content.accuracy_m, 75);

  const row = eventToMark(event);
  assert.equal(row.geohash, openMarkRow.geohash);
  assert.equal(row.mark_id, openMarkRow.mark_id);
  assert.equal(row.kind, "mark");
});

test("locked mark ships text but marks content locked:true", () => {
  const event = markToEvent(lockedMarkRow);
  assert.equal(tagValue(event, "rv"), "locked");
  const content = JSON.parse(event.content);
  assert.equal(content.locked, true);
  assert.equal(content.text, "secret spot"); // phase-1: locked marks still ship text on the wire
});

test("caw: no d tag, CAW_KIND, no coordinates in content, g-tags truncated to precision", () => {
  const event = markToEvent(cawRow, { precision: 5 });
  assert.equal(event.kind, CAW_KIND);
  assert.equal(tagValue(event, "d"), null);

  const gs = gTags(event);
  assert.equal(gs.length, 5);
  assert.equal(gs[gs.length - 1], "9v6m2");
  assert.deepEqual(gs, ["9", "9v", "9v6", "9v6m", "9v6m2"]);

  const content = JSON.parse(event.content);
  assert.equal(content.v, 1);
  assert.equal(content.text, "here now");
  assert.equal(content.locked, false);
  assert.equal("lat" in content, false);
  assert.equal("lon" in content, false);
  assert.equal("accuracy_m" in content, false);
});

test("caw eventToMark: kind caw, mark_id falls back to event.id (no d tag)", () => {
  const event = markToEvent(cawRow, { precision: 5 });
  event.id = "synthetic-event-id-1";
  event.pubkey = "pk1";
  const row = eventToMark(event);
  assert.equal(row.kind, "caw");
  assert.equal(row.mark_id, "synthetic-event-id-1");
  assert.equal(row.geohash, "9v6m2");
});

test("expiration tag omitted when row has no expires_at", () => {
  const row = { ...openMarkRow, expires_at: null };
  const event = markToEvent(row);
  assert.equal(tagValue(event, "expiration"), null);
});

test("crow tag appears only when crowId is passed", () => {
  const withCrow = markToEvent(openMarkRow, { crowId: "crow-abc" });
  assert.equal(tagValue(withCrow, "crow"), "crow-abc");
  const withoutCrow = markToEvent(openMarkRow);
  assert.equal(tagValue(withoutCrow, "crow"), null);
});

test("markToEvent throws RambleNotPublic for non-public visibility", () => {
  const row = { ...openMarkRow, visibility: "contacts" };
  assert.throws(() => markToEvent(row), RambleNotPublic);
});

test("markToEvent throws a plain Error when geohash is missing", () => {
  const rowNoGeohash = { ...openMarkRow, geohash: null };
  assert.throws(
    () => markToEvent(rowNoGeohash),
    (err) => err instanceof Error && !(err instanceof RambleNotPublic),
  );
  const rowEmptyGeohash = { ...openMarkRow, geohash: "" };
  assert.throws(
    () => markToEvent(rowEmptyGeohash),
    (err) => err instanceof Error && !(err instanceof RambleNotPublic),
  );
});

test("markToEvent truncates content text to 2000 chars", () => {
  const longText = "x".repeat(3000);
  const row = { ...openMarkRow, content_text: longText };
  const event = markToEvent(row);
  const content = JSON.parse(event.content);
  assert.equal(content.text.length, 2000);
  assert.equal(content.text, "x".repeat(2000));
});

test("eventToMark: synthetic event with a crow tag yields author_level real and crow_id", () => {
  const event = {
    id: "evt-crow-1",
    pubkey: "pk-real",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"], ["d", "mark-x"], ["k", "geo"], ["rv", "open"], ["crow", "crow-xyz"]],
    content: JSON.stringify({ v: 1, text: "hi", content_kind: "none", lat: 1, lon: 2, accuracy_m: 5, locked: false }),
  };
  const row = eventToMark(event);
  assert.equal(row.author_level, "real");
  assert.equal(row.crow_id, "crow-xyz");
  assert.equal(row.author, "pk-real");
});

test("eventToMark: unknown kind returns null", () => {
  const event = {
    id: "evt-unknown",
    pubkey: "pk1",
    kind: 1, // plain text note, not a ramble kind
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"]],
    content: JSON.stringify({ v: 1, text: "hi" }),
  };
  assert.equal(eventToMark(event), null);
});

test("eventToMark: no g tag and unparseable content returns null", () => {
  const event = {
    id: "evt-bad-1",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["d", "mark-x"]],
    content: "not json at all",
  };
  assert.equal(eventToMark(event), null);
});

test("eventToMark: malformed JSON with a g tag still returns a row with null content fields", () => {
  const event = {
    id: "evt-bad-2",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"], ["d", "mark-x"]],
    content: "not json at all",
  };
  const row = eventToMark(event);
  assert.notEqual(row, null);
  assert.equal(row.geohash, "9v6m2");
  assert.equal(row.content_text, null);
  assert.equal(row.lat, null);
  assert.equal(row.lon, null);
  assert.equal(row.accuracy_m, null);
  assert.equal(row.content_kind, "none");
  assert.equal(row.reveal, "open");
});

test("eventToMark: truncates incoming text to 2000 chars and ignores non-string text", () => {
  const longTextEvent = {
    id: "evt-long",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"], ["d", "mark-x"]],
    content: JSON.stringify({ v: 1, text: "y".repeat(3000) }),
  };
  const row = eventToMark(longTextEvent);
  assert.equal(row.content_text.length, 2000);

  const nonStringTextEvent = {
    id: "evt-nonstring",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"], ["d", "mark-x"]],
    content: JSON.stringify({ v: 1, text: 12345 }),
  };
  const row2 = eventToMark(nonStringTextEvent);
  assert.equal(row2.content_text, null);
});

test("eventToMark: geohash is the longest g tag even if tags are out of order", () => {
  const event = {
    id: "evt-order",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2ab"], ["g", "9"], ["g", "9v6m2"], ["d", "mark-x"]],
    content: JSON.stringify({ v: 1, text: "hi" }),
  };
  const row = eventToMark(event);
  assert.equal(row.geohash, "9v6m2ab");
});

test("eventToMark: expiration tag converts seconds to ms", () => {
  const event = {
    id: "evt-exp",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"], ["d", "mark-x"], ["expiration", String(Math.floor((NOW + 3600000) / 1000))]],
    content: JSON.stringify({ v: 1, text: "hi" }),
  };
  const row = eventToMark(event);
  assert.equal(row.expires_at, Math.floor((NOW + 3600000) / 1000) * 1000);
});

test("eventToMark: fields marked origin/publish_state/visibility for wire-received rows", () => {
  const event = markToEvent(openMarkRow);
  event.id = "evt-fields";
  event.pubkey = "pk1";
  const row = eventToMark(event);
  assert.equal(row.origin, "remote");
  assert.equal(row.publish_state, "remote");
  assert.equal(row.visibility, "public");
  assert.equal(row.nostr_event_id, "evt-fields");
  assert.equal(row.created_at, Math.floor(NOW / 1000) * 1000);
});

test("eventToMark: non-numeric expiration tag yields expires_at null (never NaN)", () => {
  const event = {
    id: "evt-exp-bad",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"], ["d", "mark-x"], ["expiration", "not-a-number"]],
    content: JSON.stringify({ v: 1, text: "hi" }),
  };
  const row = eventToMark(event);
  assert.equal(row.expires_at, null);
  assert.equal(Number.isNaN(row.expires_at), false); // must fail closed to null, never NaN
});

test("eventToMark: empty-string expiration tag yields expires_at null", () => {
  const event = {
    id: "evt-exp-empty",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"], ["d", "mark-x"], ["expiration", ""]],
    content: JSON.stringify({ v: 1, text: "hi" }),
  };
  const row = eventToMark(event);
  assert.equal(row.expires_at, null);
});

test("caw geohash shorter than precision: no padding, no longer g tags, no coordinates", () => {
  const row = { ...cawRow, geohash: "9v6" };
  const event = markToEvent(row, { precision: 5 });
  const gs = gTags(event);
  assert.deepEqual(gs, ["9", "9v", "9v6"]);

  const content = JSON.parse(event.content);
  assert.equal("lat" in content, false);
  assert.equal("lon" in content, false);
});

test("eventToMark: MARK_KIND event with no d tag falls back to event.id for mark_id", () => {
  const event = {
    id: "evt-no-d",
    pubkey: "pk1",
    kind: MARK_KIND,
    created_at: Math.floor(NOW / 1000),
    tags: [["g", "9v6m2"]],
    content: JSON.stringify({ v: 1, text: "hi" }),
  };
  const row = eventToMark(event);
  assert.equal(row.mark_id, "evt-no-d");
});

test("markToEvent: precision clamps to 1..12 for caws", () => {
  const wideRow = { ...cawRow, geohash: "9v6m2ab9v6m2ab" }; // 14 chars, exceeds clamp ceiling
  const lowPrecision = markToEvent(wideRow, { precision: 0 });
  const lowGs = gTags(lowPrecision);
  assert.equal(lowGs.length, 1);
  assert.equal(lowGs[lowGs.length - 1].length, 1);

  const highPrecision = markToEvent(wideRow, { precision: 99 });
  const highGs = gTags(highPrecision);
  assert.equal(highGs.length, 12);
  assert.equal(highGs[highGs.length - 1].length, 12);
});

test("bird rides on public content when valid, is dropped when not", () => {
  const row = { mark_id: "m", kind: "mark", visibility: "public", geohash: "9v6m21h", lat: 30.46, lon: -98.08, reveal: "open", content_text: "hi", created_at: 1e12 };
  const ev = markToEvent(row, { bird: { species: "magpie", seed: 12 } });
  assert.deepEqual(JSON.parse(ev.content).bird, { species: "magpie", seed: 12 });
  assert.equal(JSON.parse(markToEvent(row, { bird: { species: "dodo", seed: 12 } }).content).bird, undefined);
  const back = eventToMark({ ...ev, id: "x".repeat(64), pubkey: "a".repeat(64), created_at: 1e9 });
  assert.equal(back.bird_species, "magpie"); assert.equal(back.bird_seed, 12);
  const bad = eventToMark({ ...ev, id: "y".repeat(64), pubkey: "a".repeat(64), created_at: 1e9, content: JSON.stringify({ v: 1, text: "t", bird: { species: "crow", seed: -5 } }) });
  assert.equal(bad.bird_species, null); assert.equal(bad.bird_seed, null);
});

test("caws also carry a valid bird, but never coordinates", () => {
  const event = markToEvent(cawRow, { precision: 5, bird: { species: "crow", seed: 3 } });
  const content = JSON.parse(event.content);
  assert.deepEqual(content.bird, { species: "crow", seed: 3 });
  assert.equal("lat" in content, false);
  assert.equal("lon" in content, false);
});
