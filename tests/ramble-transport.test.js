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
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { createMark, getMark } from "../bundles/ramble/server/marks.js";
import { MARK_KIND, CAW_KIND, eventToMark } from "../bundles/ramble/server/nostr-map.js";
import { setMaster, setCell } from "../bundles/ramble/server/grid.js";
import { isoWeek } from "../bundles/ramble/server/eggs.js";
import { startRambleTransport } from "../servers/gateway/boot/ramble-transport.js";
import { enqueueMark, pendingDeliveries } from "../bundles/ramble/server/delivery.js";
import { giftEgg, proposeSwap, acceptSwap } from "../bundles/ramble/server/trades.js";

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

/** The scriptable relay/publisher stub, on its own so two transports can share one (Task 3, phase 4). */
function makeManager() {
  const published = [];
  const sent = [];
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
    sendControl: async (contact, content) => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.throwErr) throw new Error(state.throwErr);
      sent.push({ contact, content: JSON.parse(content) });
      return { eventId: "ctl-" + sent.length, relays: state.accept ? ["wss://fake"] : [] };
    },
  };
  return { nostrManager, published, sent, closedSubs, state, relay };
}

/**
 * A fresh db + bus + transport with a scriptable relay/publisher.
 * `state` is mutable mid-test: `accept` (does a relay take the event),
 * `throwErr` (publish rejects), `delayMs` (publish is slow — for re-entrancy).
 * `bus` / `manager` may be injected so two "instances" share one identity's
 * inbound door and one outbound sink (phase 4, Task 3).
 */
async function makeHarness({ shouldPublish, autoStart = false, emit, bus: sharedBus, manager } = {}) {
  const db = createClient({ url: "file::memory:" });
  const bus = sharedBus ?? new EventEmitter();
  const m = manager ?? makeManager();
  const transport = await startRambleTransport({
    db, nostrManager: m.nostrManager, identity, seed: SEED, bus,
    bundleDir: BUNDLE_DIR,
    _derive: fakeDerive,
    shouldPublish,
    autoStart,
    ...(emit ? { emit } : {}),
  });
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
      secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS contact_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
    CREATE TABLE IF NOT EXISTS contact_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);`);
  return { db, bus, published: m.published, sent: m.sent, closedSubs: m.closedSubs, state: m.state, transport, relay: m.relay };
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
  assert.equal(contactsRow.publish_state, "pending", "a bare createMark (no enqueueMark) queues nothing, so the row stays pending");
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
  assert.deepEqual(result, { published: 0, skipped: 0, failed: 0, expired: 0, delivered: 0 });
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

// ---------------------------------------------------------------------------
// Phase 3 — contacts delivery (outbox drain), gifts/swaps, inbound envelopes.
// ---------------------------------------------------------------------------

const PK = "cd".repeat(32);
async function seedContacts(db) {
  await db.executeMultiple(`
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:one', 'One', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:two', 'Two', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_blocked) VALUES ('crow:blocked', 'Blk', '02${PK}', 1);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, request_status) VALUES ('req:${PK}', NULL, '${PK}', 'pending');`);
}
function seedContactsMark(db, text = "for my contacts") {
  return createMark(db, {
    author: WORLD_AUTHOR, author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: LAT, lon: LON, accuracy_m: 5 },
    visibility: "contacts", reveal: "open", content: { content_text: text, content_kind: "none" },
  });
}

test("phase 3: a contacts mark fans out one DM per full contact, then flips to published", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  await setMaster(h.db, true);
  await setCell(h.db, "contacts", "geo", true);
  const row = await seedContactsMark(h.db);
  assert.deepEqual(await enqueueMark(h.db, row, { bird: null }), { ok: true, recipients: 2 });
  const result = await h.transport.drainOnce();
  assert.equal(result.delivered, 2);
  assert.equal(result.published, 0, "nothing went to the public relays");
  assert.equal(h.published.length, 0);
  assert.deepEqual(h.sent.map((s) => s.contact.crow_id).sort(), ["crow:one", "crow:two"]);
  assert.equal(h.sent[0].contact.secp256k1_pubkey, "02" + PK);
  assert.equal(h.sent[0].content.type, "ramble.mark");
  assert.equal(h.sent[0].content.mark.mark_id, row.mark_id);
  assert.equal(h.sent[0].content.mark.content_text, "for my contacts");
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "published");
  assert.equal((await pendingDeliveries(h.db, 50)).length, 0);
});

test("phase 3: the grid gates contacts marks (they wait, queued); gifts are never gated", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  const row = await seedContactsMark(h.db);
  await enqueueMark(h.db, row, { bird: null });
  await h.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('g1','shelf','user',9,1)", args: [] });
  assert.equal((await giftEgg(h.db, { eggId: "g1", toCrowId: "crow:one", now: Date.now() })).ok, true);
  let result = await h.transport.drainOnce();
  assert.equal(result.delivered, 1, "only the gift went");
  assert.equal(h.sent[0].content.type, "ramble.egg");
  assert.equal((await pendingDeliveries(h.db, 50)).length, 2, "the two mark rows are still queued");
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "pending");
  await setMaster(h.db, true);
  await setCell(h.db, "contacts", "geo", true);
  result = await h.transport.drainOnce();
  assert.equal(result.delivered, 2);
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "published");
});

test("phase 3: a relay refusal retries and parks at MAX attempts; a vanished recipient or deleted mark drops the row", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  await setMaster(h.db, true);
  await setCell(h.db, "contacts", "geo", true);
  const row = await seedContactsMark(h.db);
  await enqueueMark(h.db, row, { bird: null });
  h.state.accept = false;
  let result = await h.transport.drainOnce();
  assert.equal(result.delivered, 0);
  let rows = await pendingDeliveries(h.db, 50);
  assert.deepEqual(rows.map((r) => r.attempts), [1, 1]);
  await h.db.execute({ sql: "UPDATE ramble_outbox SET attempts = 19 WHERE to_crow_id = 'crow:two'", args: [] });
  await h.transport.drainOnce();
  rows = await pendingDeliveries(h.db, 50);
  assert.deepEqual(rows.map((r) => [r.to_crow_id, r.attempts]), [["crow:one", 2]], "twenty refusals park the delivery");
  h.state.accept = true;
  await h.db.execute({ sql: "DELETE FROM contacts WHERE crow_id = 'crow:one'", args: [] });
  await h.transport.drainOnce();
  assert.equal((await pendingDeliveries(h.db, 50)).length, 0, "no contact, no delivery");
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "published", "every row left the queue");
  // A mark deleted before the drain never goes out.
  const doomed = await seedContactsMark(h.db, "doomed");
  await enqueueMark(h.db, doomed, { bird: null });
  await h.db.execute({ sql: "DELETE FROM ramble_marks WHERE mark_id = ?", args: [doomed.mark_id] });
  const before = h.sent.length;
  await h.transport.drainOnce();
  assert.equal(h.sent.length, before);
  assert.equal((await pendingDeliveries(h.db, 50)).length, 0);
});

test("phase 3: an inbound ramble.mark envelope lands as a persistent contacts mark, pokes ramble:nearby and credits meet_crow", async () => {
  const h = await makeHarness();
  const nearby = []; const trades = [];
  h.bus.on("ramble:nearby", (p) => nearby.push(p));
  h.bus.on("ramble:trade", (p) => trades.push(p));
  const mark = { mark_id: "friend-mark", kind: "mark", anchor_kind: "geo", geohash: FULL_GEOHASH, lat: LAT, lon: LON, reveal: "open", content_text: "from a friend", content_kind: "none", created_at: Date.now(), bird: { species: "magpie", seed: 8 } };
  // Through the bus, exactly as NostrManager delivers it (the listener is
  // async and not awaited by emit, so poll for the row).
  h.bus.emit("ramble:envelope", { crowId: "crow:one", contactId: 1, pubkey: PK, payload: { type: "ramble.mark", v: 1, mark }, eventId: "ev-m" });
  for (let i = 0; i < 200 && !(await getMark(h.db, "friend-mark")); i++) await new Promise((r) => setTimeout(r, 10));
  const stored = await getMark(h.db, "friend-mark");
  assert.ok(stored, "the mark was stored via the bus listener");
  // A second copy (re-delivery), awaited directly: a no-op.
  await h.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, payload: { type: "ramble.mark", v: 1, mark }, eventId: "ev-m2" });
  assert.deepEqual([stored.visibility, stored.expires_at, stored.origin, stored.author, stored.bird_species], ["contacts", null, "remote", PK, "magpie"]);
  assert.equal(nearby.length, 1);
  assert.deepEqual(nearby[0], { geohash: FULL_GEOHASH, mark_id: "friend-mark", kind: "mark" });
  const creditKey = `${PK}:${isoWeek(Date.now())}`;
  const credits = async () => (await h.db.execute({ sql: "SELECT * FROM ramble_credits WHERE kind = 'meet_crow' AND key = ?", args: [creditKey] })).rows.length;
  for (let i = 0; i < 200 && (await credits()) === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await credits(), 1);
  assert.equal(trades.length, 0);
});

test("phase 4: a re-sent mark that is pruned on arrival credits meet_crow but pokes no ramble:nearby", async () => {
  const h = await makeHarness();
  const nearby = [];
  h.bus.on("ramble:nearby", (p) => nearby.push(p));
  const mk = (i) => ({ mark_id: "flood-" + i, kind: "mark", anchor_kind: "geo", geohash: FULL_GEOHASH, lat: LAT, lon: LON, reveal: "open", content_text: "n" + i, content_kind: "none", created_at: 1700000000000 + i * 1000 });
  for (let i = 0; i < 50; i++) {
    // eslint-disable-next-line no-await-in-loop
    await h.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, payload: { type: "ramble.mark", v: 1, mark: mk(i) }, eventId: "fl-" + i });
  }
  assert.equal(nearby.length, 50);
  await h.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, payload: { type: "ramble.mark", v: 1, mark: mk(-5) }, eventId: "fl-old" });
  assert.equal(nearby.length, 50, "an old mark pruned on arrival is not announced");
  assert.equal(await getMark(h.db, "flood--5"), null);
  const { rows } = await h.db.execute({ sql: "SELECT count(*) AS n FROM ramble_marks WHERE author = ?", args: [PK] });
  assert.equal(Number(rows[0].n), 50);
});

test("phase 3: an inbound gift lands as received and pokes ramble:trade; an accepted swap completes and its reply drains immediately", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  const trades = [];
  h.bus.on("ramble:trade", (p) => trades.push(p));
  await h.transport.onEnvelope({ crowId: "crow:one", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "gift-in", warmth: 12, found_cell: null, found_week: null } } });
  const { rows } = await h.db.execute({ sql: "SELECT status, shelf_origin, from_crow_id FROM ramble_eggs WHERE egg_id = 'gift-in'", args: [] });
  assert.deepEqual(rows[0], { status: "received", shelf_origin: "user", from_crow_id: "crow:one" });
  assert.deepEqual(trades, [{ kind: "gift", trade_id: null, egg_id: "gift-in", state: "received" }]);

  await h.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('mine','shelf','user',3,1)", args: [] });
  const p = await proposeSwap(h.db, { eggId: "mine", toCrowId: "crow:one", now: Date.now() });
  await h.transport.drainOnce(); // the proposal goes out
  assert.equal(h.sent.at(-1).content.trade.state, "proposed");
  await h.transport.onEnvelope({ crowId: "crow:one", pubkey: PK, payload: { type: "ramble.trade", v: 1, trade: { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "theirs", want_egg_id: "mine" }, egg: { egg_id: "theirs", warmth: 40, found_cell: null, found_week: null } } });
  assert.deepEqual(trades.at(-1), { kind: "trade", trade_id: p.trade.trade_id, egg_id: "theirs", state: "completed" });
  assert.ok(await new Promise((r) => setTimeout(() => r(h.sent.at(-1).content.trade.state === "completed"), 50)), "the completion reply drained without waiting for a tick");
  assert.equal((await h.db.execute("SELECT status FROM ramble_eggs WHERE egg_id='mine'")).rows[0].status, "gifted");
  assert.equal((await h.db.execute("SELECT status FROM ramble_eggs WHERE egg_id='theirs'")).rows[0].status, "received");
});

test("phase 3 S3: a reply queued while a drain is in flight goes out right after it, not a tick later", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  await h.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('slow','shelf','user',3,1)", args: [] });
  const p = await proposeSwap(h.db, { eggId: "slow", toCrowId: "crow:one", now: Date.now() });
  h.state.delayMs = 120;
  const inFlight = h.transport.drainOnce(); // sends the proposal, slowly
  await new Promise((r) => setTimeout(r, 20));
  await h.transport.onEnvelope({ crowId: "crow:one", pubkey: PK, eventId: "acc-1", payload: { type: "ramble.trade", v: 1, trade: { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "theirs-2", want_egg_id: "slow" }, egg: { egg_id: "theirs-2", warmth: 4, found_cell: null, found_week: null } } });
  await inFlight;
  h.state.delayMs = 0;
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(h.sent.map((x) => x.content.trade.state), ["proposed", "completed"], "the completion rode the redrain, with no manual second drain");
});

test("phase 3 C1: sixty gated mark rows do not starve a gift behind them", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  // Grid closed for contacts: every mark row is skipped but stays queued.
  for (let i = 0; i < 30; i++) {
    // eslint-disable-next-line no-await-in-loop
    const row = await seedContactsMark(h.db, "gated " + i);
    // eslint-disable-next-line no-await-in-loop
    await enqueueMark(h.db, row, { bird: null });
  }
  assert.equal((await pendingDeliveries(h.db, 100)).length, 60);
  await h.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('late-gift','shelf','user',1,1)", args: [] });
  assert.equal((await giftEgg(h.db, { eggId: "late-gift", toCrowId: "crow:one", now: Date.now() })).ok, true);
  const result = await h.transport.drainOnce();
  assert.equal(result.delivered, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].content.type, "ramble.egg");
});

test("phase 3: an open group audience behind a closed contacts backlog still goes out", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  await h.db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Walkers', 'grp-walk')", args: [] });
  await h.db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (1, 1)", args: [] });
  await setMaster(h.db, true);
  await setCell(h.db, "groups", "geo", true);
  // contacts×geo left OFF: every contacts mark row below stays queued.
  for (let i = 0; i < 30; i++) {
    // eslint-disable-next-line no-await-in-loop
    const row = await seedContactsMark(h.db, "gated " + i);
    // eslint-disable-next-line no-await-in-loop
    await enqueueMark(h.db, row, { bird: null });
  }
  const groupMark = await createMark(h.db, {
    author: WORLD_AUTHOR, author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: LAT, lon: LON, accuracy_m: 5 },
    visibility: "group:grp-walk", reveal: "open", content: { content_text: "walkers only", content_kind: "none" },
  });
  assert.deepEqual(await enqueueMark(h.db, groupMark, { bird: null }), { ok: true, recipients: 1 });
  const result = await h.transport.drainOnce();
  assert.equal(result.delivered, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].content.mark.content_text, "walkers only");
  assert.equal((await pendingDeliveries(h.db, 100)).length, 60);
});

test("phase 3 C5: the same envelope arriving from several relays is applied once", async () => {
  const h = await makeHarness();
  const trades = [];
  h.bus.on("ramble:trade", (p) => trades.push(p));
  const msg = { crowId: "crow:one", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "dup-gift", warmth: 1, found_cell: null, found_week: null } }, eventId: "same-event" };
  await Promise.all([h.transport.onEnvelope(msg), h.transport.onEnvelope({ ...msg }), h.transport.onEnvelope({ ...msg })]);
  assert.equal(trades.length, 1, "one ramble:trade for three copies of one DM");
  // A different event id with the same egg is still idempotent at the row level.
  await h.transport.onEnvelope({ ...msg, eventId: "other-event" });
  assert.equal(trades.length, 1);
  assert.equal((await h.db.execute("SELECT count(*) AS n FROM ramble_eggs WHERE egg_id='dup-gift'")).rows[0].n, 1);
});

test("phase 3: stop() detaches the envelope listener; a malformed envelope never throws", async () => {
  const h = await makeHarness();
  const before = h.bus.listenerCount("ramble:envelope");
  assert.ok(before >= 1);
  await assert.doesNotReject(h.transport.onEnvelope({ crowId: "crow:one", pubkey: PK, payload: "junk" }));
  await assert.doesNotReject(h.transport.onEnvelope(null));
  h.transport.stop();
  assert.equal(h.bus.listenerCount("ramble:envelope"), before - 1);
});

test("phase 3: a delivery that parks by THROWING still settles its mark", async () => {
  const h = await makeHarness();
  await seedContacts(h.db);
  await setMaster(h.db, true);
  await setCell(h.db, "contacts", "geo", true);
  const row = await seedContactsMark(h.db);
  await enqueueMark(h.db, row, { bird: null });
  h.state.throwErr = "boom";
  await h.db.execute({ sql: "UPDATE ramble_outbox SET attempts = 19", args: [] });
  await h.transport.drainOnce();
  assert.equal((await pendingDeliveries(h.db, 50)).length, 0);
  assert.equal((await getMark(h.db, row.mark_id)).publish_state, "published");
});

test("phase 3: a bundle copy without the phase-3 modules still runs the public drain (contacts delivery disabled)", async () => {
  const stale = mkdtempSync(join(tmpdir(), "ramble-stale-"));
  cpSync(BUNDLE_DIR, stale, { recursive: true });
  rmSync(join(stale, "delivery.js"));
  rmSync(join(stale, "trades.js"));
  try {
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
      identity, seed: SEED, bus: new EventEmitter(), bundleDir: stale, _derive: fakeDerive, autoStart: false,
    });
    await setMaster(db, true);
    await setCell(db, "public", "geo", true);
    await seedPublicMark(db, "still public on a stale bundle");

    const result = await transport.drainOnce();
    assert.equal(result.published, 1, "the public drain still runs without the phase-3 modules");
    assert.equal(result.delivered, 0, "contacts delivery is disabled");

    await assert.doesNotReject(transport.onEnvelope({ crowId: "crow:one", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "x", warmth: 1 } }, eventId: "s-1" }));

    transport.stop();
  } finally {
    rmSync(stale, { recursive: true, force: true });
  }
});

/** Copy whole rows between two in-memory dbs — the test's stand-in for instance sync. */
async function copyRows(from, to, table, cols) {
  const { rows } = await from.execute({ sql: `SELECT ${cols.join(", ")} FROM ${table}`, args: [] });
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await to.execute({ sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => r[c] ?? null) });
  }
}

test("phase 4: two of a user's instances over one bus and identity both apply one 'accepted'; the counterpart applies the duplicate replies once", async () => {
  // Round-2 Q1 (phase 3): all of a user's instances share one Nostr identity
  // (servers/sharing/nostr.js:155), so ONE DM from a contact is decrypted by
  // every instance's contact subscription. Modelled here as one bus emit two
  // transports hear, and one sendControl sink both reply through.
  const shared = makeManager();
  const bus = new EventEmitter();
  const A1 = await makeHarness({ bus, manager: shared });
  const A2 = await makeHarness({ bus, manager: shared });
  const B = await makeHarness();
  for (const h of [A1, A2, B]) await seedContacts(h.db);
  const now = Date.now();

  await A1.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('mine','shelf','user',3,?)", args: [now] });
  const p = await proposeSwap(A1.db, { eggId: "mine", toCrowId: "crow:one", now });
  assert.equal(p.ok, true);
  // "Instance sync": A2 holds the same egg and trade rows; only the authoring instance holds outbox rows.
  await copyRows(A1.db, A2.db, "ramble_eggs", ["egg_id", "status", "shelf_origin", "warmth", "found_cell", "found_week", "from_crow_id", "created_at"]);
  await copyRows(A1.db, A2.db, "ramble_trades", ["trade_id", "counterpart", "role", "my_egg_id", "their_egg_id", "offer_json", "state", "created_at", "updated_at", "expires_at"]);

  await A1.transport.drainOnce();
  await A2.transport.drainOnce();
  assert.equal(shared.sent.length, 1, "only the authoring instance sends the proposal");
  assert.equal(shared.sent[0].content.trade.state, "proposed");

  // B receives the proposal, answers with its own egg; its 'accepted' goes out once.
  await B.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, eventId: "prop-1", payload: shared.sent[0].content });
  await B.db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES ('theirs','shelf','user',8,?)", args: [now] });
  assert.equal((await acceptSwap(B.db, { tradeId: p.trade.trade_id, eggId: "theirs", now })).ok, true);
  await B.transport.drainOnce();
  assert.equal(B.sent.length, 1);
  const accepted = B.sent[0].content;
  assert.equal(accepted.trade.state, "accepted");

  // ONE DM reaches the user; both instances hear it, each completes and each replies.
  const tradeEvents = [];
  bus.on("ramble:trade", (e) => tradeEvents.push(e));
  bus.emit("ramble:envelope", { crowId: "crow:one", contactId: 1, pubkey: PK, payload: accepted, eventId: "acc-1" });
  for (let i = 0; i < 300 && shared.sent.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(shared.sent.length, 3, "the proposal plus one 'completed' from EACH instance");
  for (const h of [A1, A2]) {
    const t = (await h.db.execute({ sql: "SELECT state, their_egg_id FROM ramble_trades WHERE trade_id = ?", args: [p.trade.trade_id] })).rows[0];
    assert.deepEqual([t.state, t.their_egg_id], ["completed", "theirs"]);
    const eggs = (await h.db.execute("SELECT egg_id, status FROM ramble_eggs ORDER BY egg_id")).rows.map((r) => [r.egg_id, r.status]);
    assert.deepEqual(eggs, [["mine", "gifted"], ["theirs", "received"]], "one completed trade and one egg per instance");
    assert.equal((await pendingDeliveries(h.db, 50)).length, 0, "each instance's reply drained");
  }
  assert.equal(tradeEvents.filter((e) => e.state === "completed").length, 2, "one ramble:trade per instance");

  // B receives BOTH copies (two real DMs, two event ids); the second changes nothing.
  const bEvents = [];
  B.bus.on("ramble:trade", (e) => bEvents.push(e));
  const replies = shared.sent.slice(1).map((s) => s.content);
  assert.deepEqual(replies.map((r) => r.trade.state), ["completed", "completed"]);
  await B.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, eventId: "done-1", payload: replies[0] });
  await B.transport.onEnvelope({ crowId: "crow:one", contactId: 1, pubkey: PK, eventId: "done-2", payload: replies[1] });
  assert.equal(bEvents.length, 1, "the duplicate completion is a no-op");
  assert.equal((await B.db.execute({ sql: "SELECT state FROM ramble_trades WHERE trade_id = ?", args: [p.trade.trade_id] })).rows[0].state, "completed");
  const bEggs = (await B.db.execute("SELECT egg_id, status FROM ramble_eggs ORDER BY egg_id")).rows.map((r) => [r.egg_id, r.status]);
  assert.deepEqual(bEggs, [["mine", "received"], ["theirs", "gifted"]], "one egg per side on the counterpart, no duplicate rows");
  assert.equal(B.sent.length, 1, "B never replies to a completion");

  A1.transport.stop(); A2.transport.stop(); B.transport.stop();
});

test("world name rides only pseudonym/real rows: a rotating row never carries it; eventToMark round-trips it", async () => {
  const h = await makeHarness();
  await setMaster(h.db, true);
  await setCell(h.db, "public", "geo", true);
  await h.db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('world.name', ?)", args: ["Kevin"] });
  const rot = await seedPublicMark(h.db, "rotating row", { author_level: "rotating" });
  const pseud = await seedPublicMark(h.db, "pseudonym row", { author_level: "pseudonym" });
  const real = await seedPublicMark(h.db, "real row", { author_level: "real" });
  await h.transport.drainOnce();
  const byText = (t) => h.published.find((e) => JSON.parse(e.content).text === t);
  assert.equal(JSON.parse(byText("rotating row").content).name, undefined);
  assert.equal(JSON.parse(byText("pseudonym row").content).name, "Kevin");
  assert.equal(JSON.parse(byText("real row").content).name, "Kevin");
  assert.equal(eventToMark(byText("pseudonym row")).author_name, "Kevin");
  // A row with no level of its own follows the instance level (createMark stores author_level ?? null).
  await h.db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('public_identity_level', 'pseudonym') ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [] });
  const bare = await seedPublicMark(h.db, "bare row", { author_level: null });
  await h.transport.drainOnce();
  assert.equal(JSON.parse(byText("bare row").content).name, "Kevin");
  void rot; void pseud; void real; void bare;
});
