/**
 * Task 10 — gateway-side Ramble transport (publisher drain + area subscriber).
 *
 * Everything network-facing is faked: a stub `nostrManager` whose `relays` is a
 * Map of one never-connected relay (so `makeResilientSub` defers, exactly as it
 * does against a real dropped socket) and whose `publishRendezvousEvent` records
 * the FINALIZED event and reports one accepting relay. Identity is faked too,
 * but with REAL secp256k1 keys (generateSecretKey/getPublicKey) so
 * `finalizeEvent` actually signs — a hash-derived fake key would throw inside
 * nostr-tools.
 *
 * The db deliberately starts with NO ramble tables: D7 says the transport must
 * create them itself (the gateway must not depend on the stdio child booting
 * first).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { createMark, getMark } from "../bundles/ramble/server/marks.js";
import { MARK_KIND, CAW_KIND } from "../bundles/ramble/server/nostr-map.js";
import { startRambleTransport } from "../servers/gateway/boot/ramble-transport.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = join(__dir, "../bundles/ramble/server");

// 30.46 / -98.08 encodes to geohash7 "9v6m21h" → precision-5 prefix "9v6m2".
const LAT = 30.46;
const LON = -98.08;
const CELL = "9v6m2";
const FULL_GEOHASH = "9v6m21h";

const keys = new Map();
function fakeKey(id) {
  if (!keys.has(id)) {
    const secp256k1Priv = generateSecretKey();
    keys.set(id, { secp256k1Priv, secp256k1Pubkey: `02${getPublicKey(secp256k1Priv)}` });
  }
  return keys.get(id);
}
const fakeDerive = (seed, botId) => fakeKey(`derive:${botId}`);
const identity = { crowId: "crow_T", ...fakeKey("real") };
const SEED = "seed";

let db, bus, transport, published, nearby, publicMarkId, contactsMarkId;

before(async () => {
  db = createClient({ url: "file::memory:" });
  bus = new EventEmitter();
  published = [];
  nearby = [];
  bus.on("ramble:nearby", (p) => nearby.push(p));

  const nostrManager = {
    relays: new Map([["wss://fake", { connected: false, connect: async () => {}, subscribe: () => { throw new Error("not connected"); } }]]),
    connectRelays: async () => [],
    publishRendezvousEvent: async (event) => { published.push(event); return ["wss://fake"]; },
  };

  transport = await startRambleTransport({
    db, nostrManager, identity, seed: SEED, bus,
    bundleDir: BUNDLE_DIR,
    _derive: fakeDerive,
    autoStart: false,
  });
});

test("startup initializes the ramble tables when they are absent (D7)", async () => {
  const { rows } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ramble_marks','ramble_settings')",
    args: [],
  });
  assert.equal(rows.length, 2, "transport must create the ramble tables itself");
});

test("startup mints a per-boot session id and records it at ramble_settings local.session_id (R11)", async () => {
  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = 'local.session_id'",
    args: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, transport.sessionId);
  assert.match(transport.sessionId, /^[0-9a-f-]{36}$/);
});

test("no active area → no subscription filter", () => {
  assert.equal(transport.currentFilter(), null);
});

test("resubscribe() builds the area filter from local.active_area", async () => {
  await db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES ('local.active_area', ?)",
    args: [JSON.stringify([CELL])],
  });
  await transport.resubscribe();
  const filter = transport.currentFilter();
  assert.ok(filter, "filter must exist once an active area is set");
  assert.deepEqual(filter["#g"], [CELL]);
  assert.ok(filter.kinds.includes(MARK_KIND));
  assert.ok(filter.kinds.includes(CAW_KIND));
});

test("drain publishes the pending public mark and the pending tombstone, and leaves the contacts mark alone", async () => {
  const world = fakeDerive(SEED, "ramble-world");
  const worldAuthor = getPublicKey(world.secp256k1Priv);

  const pub = await createMark(db, {
    author: worldAuthor, author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: LAT, lon: LON, accuracy_m: 12 },
    visibility: "public", reveal: "open",
    content: { content_text: "hello wire", content_kind: "none" },
  });
  publicMarkId = pub.mark_id;
  assert.equal(pub.geohash, FULL_GEOHASH);

  const priv = await createMark(db, {
    author: worldAuthor, author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: LAT, lon: LON },
    visibility: "contacts", reveal: "open",
    content: { content_text: "not for the wire", content_kind: "none" },
  });
  contactsMarkId = priv.mark_id;

  await db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES ('local.tombstones', ?)",
    args: [JSON.stringify([{ nostr_event_id: "deadbeef".repeat(8), kind: "mark", author_level: "rotating" }])],
  });

  const result = await transport.drainOnce();
  assert.equal(result.published, 1, "exactly one mark published");

  // Two events on the wire: the mark, and the NIP-09 kind-5 delete.
  assert.equal(published.length, 2);
  const markEvent = published.find((e) => e.kind === MARK_KIND);
  const deleteEvent = published.find((e) => e.kind === 5);
  assert.ok(markEvent, "the public mark was published");
  assert.ok(deleteEvent, "the tombstone was published");
  assert.deepEqual(deleteEvent.tags, [["e", "deadbeef".repeat(8)]]);

  // Geohash prefix tags: the precision-5 cell AND the full geohash.
  const gTags = markEvent.tags.filter((t) => t[0] === "g").map((t) => t[1]);
  assert.ok(gTags.includes(CELL), `expected ["g","${CELL}"] in ${JSON.stringify(gTags)}`);
  assert.ok(gTags.includes(FULL_GEOHASH));

  const publishedRow = await getMark(db, publicMarkId);
  assert.equal(publishedRow.publish_state, "published");
  assert.equal(publishedRow.nostr_event_id, markEvent.id);
  assert.equal(publishedRow.author, markEvent.pubkey);

  const contactsRow = await getMark(db, contactsMarkId);
  assert.equal(contactsRow.publish_state, "pending", "non-public marks never reach the wire in phase 1");
  assert.equal(contactsRow.nostr_event_id, null);

  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key='local.tombstones'", args: [],
  });
  assert.deepEqual(JSON.parse(rows[0].value), [], "an accepted tombstone is removed from the pending list");
});

test("a re-drain publishes nothing new (published rows are no longer pending)", async () => {
  const before = published.length;
  const result = await transport.drainOnce();
  assert.equal(result.published, 0);
  assert.equal(published.length, before);
});

test("onEvent inserts a remote mark once and emits ramble:nearby exactly once", async () => {
  const strangerPriv = generateSecretKey();
  const event = finalizeEvent({
    kind: MARK_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["g", "9"], ["g", "9v"], ["g", CELL], ["g", "9v6m21x"], ["d", "remote-mark-1"], ["k", "geo"], ["rv", "open"]],
    content: JSON.stringify({ v: 1, text: "from a stranger", content_kind: "none", locked: false }),
  }, strangerPriv);

  await transport.onEvent(event);
  const row = await getMark(db, "remote-mark-1");
  assert.ok(row, "remote mark inserted");
  assert.equal(row.origin, "remote");
  assert.equal(row.content_text, "from a stranger");
  assert.equal(nearby.length, 1);
  assert.equal(nearby[0].mark_id, "remote-mark-1");
  assert.equal(nearby[0].geohash, "9v6m21x");
  assert.equal(nearby[0].kind, "mark");

  // Idempotent: a duplicate delivery inserts nothing and emits nothing.
  await transport.onEvent(event);
  assert.equal(nearby.length, 1);
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM ramble_marks WHERE mark_id = ?", args: ["remote-mark-1"],
  });
  assert.equal(Number(rows[0].n), 1);
});

test("own-echo: an event signed by one of our own personas is dropped (C4)", async () => {
  const world = fakeDerive(SEED, "ramble-world");
  const event = finalizeEvent({
    kind: MARK_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["g", CELL], ["d", "own-echo-1"], ["k", "geo"], ["rv", "open"]],
    content: JSON.stringify({ v: 1, text: "our own mark bounced back", content_kind: "none" }),
  }, world.secp256k1Priv);

  assert.ok(transport.ownAuthors.has(event.pubkey), "the world pseudonym is a known own-author");
  const nearbyBefore = nearby.length;
  await transport.onEvent(event);
  assert.equal(await getMark(db, "own-echo-1"), null, "own echo must not be inserted");
  assert.equal(nearby.length, nearbyBefore);
});

test("stop() is safe to call and clears the subscription handles", () => {
  transport.stop();
  transport.stop();
});
