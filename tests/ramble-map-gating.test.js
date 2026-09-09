/**
 * Spec 2026-09-08 §2.1 + D4/D5: fog gates the PUBLIC overlay only. A public
 * mark in fog is absent; in the frontier it is a TYPED BEACON with no content;
 * in unlocked ground it is whole. A contact's or the user's own mark is never
 * gated, in any zone, because contacts are geographically spread and requiring
 * a visit to their area would be impractical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateForZones } from "../bundles/ramble/server/zones.js";
import { encodeGeohash, decodeGeohash } from "../bundles/ramble/server/anchors.js";
import { neighborhood } from "../bundles/ramble/server/zones.js";

const HOME = "9vk79ed";
const at = (cell) => decodeGeohash(cell);
const NEAR = neighborhood(HOME, 1)[0];
const FAR = encodeGeohash(0, 0, 7);

/* Built from the REAL ramble_marks columns, not invented ones: asserting that
 * a beacon lacks a field the product never sets would prove nothing. */
function mark(cell, extra = {}) {
  const p = at(cell);
  return {
    mark_id: "m-" + cell, kind: "mark", origin: "remote", visibility: "public",
    lat: p.lat, lon: p.lon, geohash: cell,
    content_text: "secret words", content_ref: "ref-1", thumb_enc: "enc", locked_blob: "blob",
    author: "f".repeat(64), author_name: "Stranger", author_level: "pseudonym",
    nostr_event_id: "e".repeat(64), bird_species: "crow", bird_seed: 7, created_at: 1,
    ...extra,
  };
}
const gate = (rows) => gateForZones(rows, { unlocked: new Set([HOME]), depth: 1, encode: encodeGeohash });

test("a PUBLIC mark: whole when unlocked, a typed beacon in the frontier, gone in fog", () => {
  const out = gate([mark(HOME), mark(NEAR), mark(FAR)]);
  assert.equal(out.length, 2, "the fogged mark is not sent at all");

  const [home, near] = out;
  assert.equal(home.content_text, "secret words", "unlocked ground is unchanged");
  assert.equal(home.mark_id, "m-" + HOME);

  assert.equal(near.beacon, true, "the frontier entry is flagged as a beacon");
  assert.equal(near.kind, "mark", "typed — you can tell a mark from a nest");
  assert.ok(Number.isFinite(near.lat) && Number.isFinite(near.lon), "it has somewhere to draw");
  for (const leak of ["content_text", "content_ref", "thumb_enc", "locked_blob", "geohash",
                      "author", "author_name", "author_level", "nostr_event_id",
                      "bird_species", "bird_seed", "mark_id", "created_at",
                      "contact_name", "contact_avatar", "visibility"]) {
    assert.ok(!(leak in near), `a beacon must not carry ${leak}`);
  }
  assert.deepEqual(Object.keys(near).sort(), ["beacon", "kind", "lat", "lon"],
    "a beacon is built from scratch, so a field added upstream can never start leaking");
});

test("a caw in the frontier is typed as a caw, not flattened into a mark", () => {
  const [beacon] = gate([mark(NEAR, { kind: "caw" })]);
  assert.equal(beacon.kind, "caw");
  assert.equal(beacon.beacon, true);
});

test("a contacts-visibility mark survives fog even when no contact row matches it", () => {
  // The regression this pins: gating on `origin` alone, or leaning on
  // contact_name, fogs a mark from a pending, blocked or deleted contact.
  const orphan = gate([mark(FAR, { visibility: "contacts" })]);
  assert.equal(orphan.length, 1, "a contacts mark is never fogged, contact row or not");
  assert.equal(orphan[0].content_text, "secret words");
  assert.ok(!orphan[0].beacon);
});

test("the user's own and a contact's marks are NEVER gated, in any zone", () => {
  const mine = gate([mark(FAR, { origin: "local" }), mark(FAR, { origin: "sync" })]);
  assert.equal(mine.length, 2, "own marks survive fog");
  assert.ok(mine.every((m) => m.content_text === "secret words" && !m.beacon));

  // "A contact's mark" means one delivered on the contacts channel, i.e.
  // visibility "contacts" — NOT merely a public mark that happens to come
  // from someone in your contact list. See the D4 ruling in Global
  // Constraints: a publicly published mark is public terrain whoever sent it,
  // and `contact_name` cannot be the test because it excludes pending,
  // blocked and deleted contacts.
  const contact = gate([mark(FAR, { visibility: "contacts", contact_name: "Dayane" })]);
  assert.equal(contact.length, 1, "a contacts-channel mark survives fog");
  assert.equal(contact[0].content_text, "secret words");
  assert.ok(!contact[0].beacon);

  const publicFromAContact = gate([mark(FAR, { contact_name: "Dayane" })]);   // visibility stays "public"
  assert.deepEqual(publicFromAContact, [], "a contact's PUBLIC mark is public terrain and fogs like any other");
});

test("with nothing unlocked, every public mark is fogged and nothing throws", () => {
  const out = gateForZones([mark(HOME), mark(FAR)], { unlocked: new Set(), depth: 3, encode: encodeGeohash });
  assert.deepEqual(out, []);
  assert.deepEqual(gateForZones(null, { unlocked: new Set([HOME]), depth: 1, encode: encodeGeohash }), []);
});

test("a row without usable coordinates is dropped rather than mis-zoned", () => {
  const out = gate([{ mark_id: "x", kind: "mark", origin: "remote", visibility: "public", lat: null, lon: null, content_text: "hi" }]);
  assert.deepEqual(out, []);
});
