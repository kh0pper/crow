/**
 * Task 10 — gateway-side Ramble transport (publisher drain + area subscriber).
 *
 * Everything network-facing is faked: a stub `nostrManager` whose `relays` is a
 * Map of one relay stubbed just far enough for `makeResilientSub` (a `connected`
 * flag, `connect()`, and a `subscribe()` returning a closable handle) and whose
 * `publishRendezvousEvent` records the FINALIZED event and reports which relays
 * accepted. Identity is faked too, but with REAL secp256k1 keys
 * (generateSecretKey/getPublicKey) so `finalizeEvent` actually signs — a
 * hash-derived fake key would throw inside nostr-tools.
 *
 * Every harness db deliberately starts with NO ramble tables: D7 says the
 * transport must create them itself (the gateway must not depend on the stdio
 * child booting first).
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
import { setMaster, setCell } from "../bundles/ramble/server/grid.js";
import { isoWeek } from "../bundles/ramble/server/eggs.js";
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
const WORLD_AUTHOR = getPublicKey(fakeDerive(SEED, "ramble-world").secp256k1Priv);

/**
 * A fresh db + bus + transport with a scriptable relay/publisher.
 * `state` is mutable mid-test: `accept` (does a relay take the event),
 * `throwErr` (publish rejects), `delayMs` (publish is slow — for re-entrancy).
 */
async function makeHarness({ shouldPublish, autoStart = false, emit } = {}) {
  const db = createClient({ url: "file::memory:" });
  const bus = new EventEmitter();
  const published = [];
  const closedSubs = [];
  const state = { accept: true, throwErr: null, delayMs: 0 };

  const relay = {
    connected: true,
    connect: async () => {},
    // Minimal nostr-tools Relay surface makeResilientSub touches.
    subscribe: () => {
      const handle = { close: () => closedSubs.push(handle) };
      return handle;
    },
  };
  const nostrManager = {
    relays: new Map([["wss://fake", relay]]),
    connectRelays: async () => [],
    publishRendezvousEvent: async (event) => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.throwErr) throw new Error(state.throwErr);
      published.push(event);
      return state.accept ? ["wss://fake"] : [];
    },
  };

  const transport = await startRambleTransport({
    db, nostrManager, identity, seed: SEED, bus,
    bundleDir: BUNDLE_DIR,
    _derive: fakeDerive,
    shouldPublish,
    autoStart,
    ...(emit ? { emit } : {}),
  });
  return { db, bus, published, closedSubs, state, transport, relay };
}

/** One pending public mark at the fixture coordinates. */
function seedPublicMark(db, text = "hello wire", extra = {}) {
  return createMark(db, {
    author: WORLD_AUTHOR, author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: LAT, lon: LON, accuracy_m: 12 },
    visibility: "public", reveal: "open",
    content: { content_text: text, content_kind: "none" },
    ...extra,
  });
}

function seedTombstone(db, nostr_event_id) {
  return db.execute({
    sql: `INSERT INTO ramble_tombstones (nostr_event_id, mark_id, kind, author_level, created_at)
          VALUES (?, ?, 'mark', 'rotating', ?)`,
    args: [nostr_event_id, "gone-mark", Date.now()],
  });
}

async function tombstoneCount(db) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM ramble_tombstones");
  return Number(rows[0].n);
}

// ---------------------------------------------------------------------------
// The main sequential harness: startup, filter, one full drain, incoming events.
// ---------------------------------------------------------------------------

let H, nearby, publicMarkId, contactsMarkId;

before(async () => {
  H = await makeHarness();
  // Task 11: the drain's default gate is now the privacy grid, which starts
  // fully off (master false, every cell false). Enable exactly the
  // (public, geo) cell so this harness's existing publish assertions —
  // written under Task 10's always-true stub gate — still hold.
  await setMaster(H.db, true);
  await setCell(H.db, "public", "geo", true);
  nearby = [];
  H.bus.on("ramble:nearby", (p) => nearby.push(p));
});

test("startup initializes the ramble tables when they are absent (D7)", async () => {
  const { rows } = await H.db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table'
          AND name IN ('ramble_marks','ramble_settings','ramble_tombstones')`,
    args: [],
  });
  assert.equal(rows.length, 3, "transport must create the ramble tables itself");
});

test("startup mints a per-boot session id and records it at ramble_settings local.session_id (R11)", async () => {
  const { rows } = await H.db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = 'local.session_id'",
    args: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, H.transport.sessionId);
  assert.match(H.transport.sessionId, /^[0-9a-f-]{36}$/);
});

test("no active area → no subscription filter", async () => {
  await H.transport.resubscribe(); // settle the fire-and-forget boot subscribe
  assert.equal(H.transport.currentFilter(), null);
});

test("resubscribe() builds the area filter from local.active_area", async () => {
  await H.db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES ('local.active_area', ?)",
    args: [JSON.stringify([CELL])],
  });
  await H.transport.resubscribe();
  const filter = H.transport.currentFilter();
  assert.ok(filter, "filter must exist once an active area is set");
  assert.deepEqual(filter["#g"], [CELL]);
  assert.ok(filter.kinds.includes(MARK_KIND));
  assert.ok(filter.kinds.includes(CAW_KIND));
});

test("drain publishes the pending public mark and the pending tombstone, and leaves the contacts mark alone", async () => {
  const pub = await seedPublicMark(H.db);
  publicMarkId = pub.mark_id;
  assert.equal(pub.geohash, FULL_GEOHASH);

  const priv = await createMark(H.db, {
    author: WORLD_AUTHOR, author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: LAT, lon: LON },
    visibility: "contacts", reveal: "open",
    content: { content_text: "not for the wire", content_kind: "none" },
  });
  contactsMarkId = priv.mark_id;

  const doomed = "deadbeef".repeat(8);
  await seedTombstone(H.db, doomed);

  const result = await H.transport.drainOnce();
  assert.equal(result.published, 1, "exactly one mark published");

  // Two events on the wire: the mark, and the NIP-09 kind-5 delete.
  assert.equal(H.published.length, 2);
  const markEvent = H.published.find((e) => e.kind === MARK_KIND);
  const deleteEvent = H.published.find((e) => e.kind === 5);
  assert.ok(markEvent, "the public mark was published");
  assert.ok(deleteEvent, "the tombstone was published");
  assert.deepEqual(deleteEvent.tags, [["e", doomed]]);

  // Geohash prefix tags: the precision-5 cell AND the full geohash.
  const gTags = markEvent.tags.filter((t) => t[0] === "g").map((t) => t[1]);
  assert.ok(gTags.includes(CELL), `expected ["g","${CELL}"] in ${JSON.stringify(gTags)}`);
  assert.ok(gTags.includes(FULL_GEOHASH));

  const publishedRow = await getMark(H.db, publicMarkId);
  assert.equal(publishedRow.publish_state, "published");
  assert.equal(publishedRow.nostr_event_id, markEvent.id);
  assert.equal(publishedRow.author, markEvent.pubkey);

  const contactsRow = await getMark(H.db, contactsMarkId);
  assert.equal(contactsRow.publish_state, "pending", "non-public marks never reach the wire in phase 1");
  assert.equal(contactsRow.nostr_event_id, null);

  assert.equal(await tombstoneCount(H.db), 0, "an accepted tombstone row is deleted");
});

test("a re-drain publishes nothing new (published rows are no longer pending)", async () => {
  const before = H.published.length;
  const result = await H.transport.drainOnce();
  assert.equal(result.published, 0);
  assert.equal(H.published.length, before);
});

test("onEvent inserts a remote mark once and emits ramble:nearby exactly once", async () => {
  const strangerPriv = generateSecretKey();
  const event = finalizeEvent({
    kind: MARK_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["g", "9"], ["g", "9v"], ["g", CELL], ["g", "9v6m21x"], ["d", "remote-mark-1"], ["k", "geo"], ["rv", "open"]],
    content: JSON.stringify({ v: 1, text: "from a stranger", content_kind: "none", locked: false }),
  }, strangerPriv);

  await H.transport.onEvent(event);
  const row = await getMark(H.db, "remote-mark-1");
  assert.ok(row, "remote mark inserted");
  assert.equal(row.origin, "remote");
  assert.equal(row.content_text, "from a stranger");
  assert.equal(nearby.length, 1);
  assert.equal(nearby[0].mark_id, "remote-mark-1");
  assert.equal(nearby[0].geohash, "9v6m21x");
  assert.equal(nearby[0].kind, "mark");

  // Idempotent: a duplicate delivery inserts nothing and emits nothing.
  await H.transport.onEvent(event);
  assert.equal(nearby.length, 1);
  const { rows } = await H.db.execute({
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

  assert.ok(H.transport.ownAuthors.has(event.pubkey), "the world pseudonym is a known own-author");
  const nearbyBefore = nearby.length;
  await H.transport.onEvent(event);
  assert.equal(await getMark(H.db, "own-echo-1"), null, "own echo must not be inserted");
  assert.equal(nearby.length, nearbyBefore);
});

// ---------------------------------------------------------------------------
// Accept guard, gate, re-entrancy, poison pills, teardown — own harnesses.
// ---------------------------------------------------------------------------

test("no relay accepted → the mark stays pending and the tombstone row survives; a later accepting drain clears both", async () => {
  const h = await makeHarness();
  await setMaster(h.db, true);
  await setCell(h.db, "public", "geo", true);
  h.state.accept = false;
  const mark = await seedPublicMark(h.db, "nobody took it");
  await seedTombstone(h.db, "ab".repeat(32));

  const first = await h.transport.drainOnce();
  assert.equal(first.published, 0);
  assert.equal(first.failed, 1);
  let row = await getMark(h.db, mark.mark_id);
  assert.equal(row.publish_state, "pending", "a rejected publish must never flip the row");
  assert.equal(row.nostr_event_id, null);
  assert.equal(await tombstoneCount(h.db), 1, "a rejected tombstone stays queued");

  h.state.accept = true;
  const second = await h.transport.drainOnce();
  assert.equal(second.published, 1);
  row = await getMark(h.db, mark.mark_id);
  assert.equal(row.publish_state, "published");
  assert.ok(row.nostr_event_id);
  assert.equal(await tombstoneCount(h.db), 0);
});

test("shouldPublish gate: a row the gate rejects is never published and stays pending", async () => {
  const h = await makeHarness({ shouldPublish: async () => false });
  const mark = await seedPublicMark(h.db, "gated off");

  const result = await h.transport.drainOnce();
  assert.equal(result.published, 0);
  assert.equal(result.skipped, 1);
  assert.equal(h.published.length, 0, "the gate must run before signing/publishing");
  const row = await getMark(h.db, mark.mark_id);
  assert.equal(row.publish_state, "pending");
});

test("default gate (Task 11): with the grid at defaults, a pending public mark is skipped, not published", async () => {
  const h = await makeHarness(); // no shouldPublish override -- exercises the real makePublishGate(db) default
  const mark = await seedPublicMark(h.db, "grid says no");

  const result = await h.transport.drainOnce();
  assert.equal(result.published, 0);
  assert.equal(result.skipped, 1);
  assert.equal(h.published.length, 0, "the default grid gate must run before signing/publishing");
  const row = await getMark(h.db, mark.mark_id);
  assert.equal(row.publish_state, "pending");
});

test("R19: the drain tick sweeps expired marks BEFORE publishing, and the delete rides the sync emit hook", async () => {
  const emitted = [];
  const h = await makeHarness({ emit: (table, op, row) => { emitted.push([table, op, row]); } });
  // Grid fully ON: if the sweep did not run first, this row WOULD be published.
  await setMaster(h.db, true);
  await setCell(h.db, "public", "geo", true);
  const doomed = await seedPublicMark(h.db, "already stale", { ttlSeconds: -1 });
  const live = await seedPublicMark(h.db, "still fresh");

  const result = await h.transport.drainOnce();

  assert.equal(result.expired, 1, "the tick must report the row it swept");
  assert.equal(await getMark(h.db, doomed.mark_id), null, "the expired row must be gone from the table");
  assert.ok(await getMark(h.db, live.mark_id), "a live row must survive the sweep");

  const deletes = emitted.filter(([table, op]) => table === "ramble_marks" && op === "delete");
  assert.equal(deletes.length, 1, "exactly one delete on the sync emit hook");
  assert.equal(deletes[0][2].mark_id, doomed.mark_id, "the delete must carry the swept row");

  // Nothing expired reached the wire; the live row still did.
  assert.equal(result.published, 1);
  assert.equal(h.published.length, 1);
  const stale = h.published.find((e) => (e.content ?? "").includes("already stale"));
  assert.equal(stale, undefined, "an expired mark must never be published");
});

test("re-entrancy: two concurrent drains publish the one pending mark exactly once", async () => {
  const h = await makeHarness();
  await setMaster(h.db, true);
  await setCell(h.db, "public", "geo", true);
  h.state.delayMs = 25;
  await seedPublicMark(h.db, "publish me once");

  const [a, b] = await Promise.all([h.transport.drainOnce(), h.transport.drainOnce()]);
  assert.equal(a.published + b.published, 1, "only one drain may do the work");
  assert.equal(h.published.length, 1, "the mark must reach the wire exactly once");
});

test("poison pill: a pending public mark with no geohash is excluded by the drain SQL", async () => {
  const h = await makeHarness();
  await h.db.execute({
    sql: `INSERT INTO ramble_marks (mark_id, author, author_level, kind, anchor_kind, geohash,
            visibility, reveal, content_text, created_at, publish_state, origin)
          VALUES (?, ?, 'rotating', 'mark', 'geo', NULL, 'public', 'open', 'no anchor', ?, 'pending', 'local')`,
    args: ["no-geohash-1", WORLD_AUTHOR, Date.now()],
  });

  const result = await h.transport.drainOnce();
  assert.equal(result.published, 0);
  assert.equal(result.failed, 0, "a geohash-less row must not even be selected");
  assert.equal(h.published.length, 0);
  const row = await getMark(h.db, "no-geohash-1");
  assert.equal(row.publish_state, "pending");
});

test("poison pill: a mark whose publish keeps throwing is parked as failed after 20 attempts", async () => {
  const h = await makeHarness();
  await setMaster(h.db, true);
  await setCell(h.db, "public", "geo", true);
  h.state.throwErr = "relay exploded";
  const mark = await seedPublicMark(h.db, "cursed");

  for (let i = 0; i < 19; i++) {
    // eslint-disable-next-line no-await-in-loop
    await h.transport.drainOnce();
    // eslint-disable-next-line no-await-in-loop
    const mid = await getMark(h.db, mark.mark_id);
    assert.equal(mid.publish_state, "pending", `still retrying after ${i + 1} attempts`);
  }
  await h.transport.drainOnce(); // 20th
  const row = await getMark(h.db, mark.mark_id);
  assert.equal(row.publish_state, "failed", "the row leaves the pending set at the attempt cap");

  // And it is no longer picked up.
  const after = await h.transport.drainOnce();
  assert.equal(after.failed, 0);
});

test("stop(): clears the filter, closes every sub handle, and removes its bus listeners", async () => {
  const bus = new EventEmitter();
  const drainListenersBefore = bus.listenerCount("ramble:drain");
  const areaListenersBefore = bus.listenerCount("ramble:area");

  // A transport of our own on this bus, so the listener counts are ours alone.
  const closed = [];
  const relay = {
    connected: true,
    connect: async () => {},
    subscribe: () => { const handle = { close: () => closed.push(handle) }; return handle; },
  };
  const db = createClient({ url: "file::memory:" });
  const transport = await startRambleTransport({
    db,
    nostrManager: {
      relays: new Map([["wss://fake", relay]]),
      connectRelays: async () => [],
      publishRendezvousEvent: async () => ["wss://fake"],
    },
    identity, seed: SEED, bus, bundleDir: BUNDLE_DIR, _derive: fakeDerive, autoStart: false,
  });

  assert.equal(bus.listenerCount("ramble:drain"), drainListenersBefore + 1);
  assert.equal(bus.listenerCount("ramble:area"), areaListenersBefore + 1);

  await db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES ('local.active_area', ?)",
    args: [JSON.stringify([CELL])],
  });
  await transport.resubscribe();
  assert.ok(transport.currentFilter(), "a live subscription exists before stop()");
  assert.equal(closed.length, 0);

  transport.stop();
  assert.equal(transport.currentFilter(), null, "stop() clears the filter");
  assert.equal(closed.length, 1, "stop() closes the relay subscription handle");
  assert.equal(bus.listenerCount("ramble:drain"), drainListenersBefore);
  assert.equal(bus.listenerCount("ramble:area"), areaListenersBefore);

  // Idempotent, and a post-stop drain is a no-op.
  transport.stop();
  const result = await transport.drainOnce();
  assert.deepEqual(result, { published: 0, skipped: 0, failed: 0, expired: 0 });
});

// ---------------------------------------------------------------------------
// Task 7 — the active bird rides on the public wire, and receipt credits
// meet_crow warmth.
// ---------------------------------------------------------------------------

test("Task 7: an active hatched bird rides in the published event's content", async () => {
  const h = await makeHarness();
  await setMaster(h.db, true);
  await setCell(h.db, "public", "geo", true);

  const eggId = "egg-active-1";
  const now = Date.now();
  await h.db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at)
          VALUES (?, 'hatched', 100, 'crow', 5, ?, ?)`,
    args: [eggId, now, now],
  });
  await h.db.execute({
    sql: "INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', ?)",
    args: [eggId],
  });

  await seedPublicMark(h.db, "with a bird");
  const result = await h.transport.drainOnce();
  assert.equal(result.published, 1, "the mark still publishes");

  const event = h.published.find((e) => e.kind === MARK_KIND);
  assert.ok(event, "the mark event was published");
  const content = JSON.parse(event.content);
  assert.deepEqual(content.bird, { species: "crow", seed: 5 });
});

test("Task 7: onEvent credits ramble_credits with one meet_crow row per (pubkey, isoWeek), deduped across different marks", async () => {
  const h = await makeHarness();
  const strangerPriv = generateSecretKey();
  const strangerPub = getPublicKey(strangerPriv);

  const makeEvent = (dTag) => finalizeEvent({
    kind: MARK_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["g", CELL], ["d", dTag], ["k", "geo"], ["rv", "open"]],
    content: JSON.stringify({ v: 1, text: "hi", content_kind: "none" }),
  }, strangerPriv);

  await h.transport.onEvent(makeEvent("meet-crow-mark-1"));

  const week = isoWeek(Date.now());
  const key = `${strangerPub}:${week}`;
  const { rows: after1 } = await h.db.execute({
    sql: "SELECT * FROM ramble_credits WHERE kind = 'meet_crow' AND key = ?",
    args: [key],
  });
  assert.equal(after1.length, 1, "exactly one meet_crow credit row after the first receipt");

  // A second, DIFFERENT event (new id via a new d tag) from the same pubkey,
  // same week -- must NOT add a second credit row (a byte-identical replay
  // would be deduped before feedAll even runs and would prove nothing).
  await h.transport.onEvent(makeEvent("meet-crow-mark-2"));

  const { rows: after2 } = await h.db.execute({
    sql: "SELECT * FROM ramble_credits WHERE kind = 'meet_crow' AND key = ?",
    args: [key],
  });
  assert.equal(after2.length, 1, "still exactly one meet_crow credit row for the same persona+week");
});
