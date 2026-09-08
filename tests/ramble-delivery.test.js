/**
 * Phase 3 — delivery.js: the wire codecs (what a mark/egg/trade look like
 * inside a NIP-44 DM), audience resolution against the core contact tables,
 * and the LOCAL ramble_outbox queue. No Nostr here.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark } from "../bundles/ramble/server/marks.js";
import {
  isRambleEnvelope, eggPayload, parseEggPayload, markPayload, markEnvelope, payloadToMark,
  giftPayload, tradePayload, parseTradePayload,
  resolveContact, listAudiences, resolveAudience,
  enqueueDeliveries, enqueueMark, pendingDeliveries, deleteDelivery, noteDeliveryFailure, remainingDeliveries,
  MAX_DELIVERY_ATTEMPTS, MAX_WARMTH,
} from "../bundles/ramble/server/delivery.js";

const CORE_DDL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT NOT NULL UNIQUE, display_name TEXT,
    secp256k1_pubkey TEXT NOT NULL DEFAULT '', is_blocked INTEGER DEFAULT 0, request_status TEXT, is_bot INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS contact_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, group_uid TEXT, room_uid TEXT);
  CREATE TABLE IF NOT EXISTS contact_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, contact_id INTEGER NOT NULL);`;

const PK = "ab".repeat(32);
let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  await db.executeMultiple(CORE_DDL);
  await db.executeMultiple(`
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:full', 'Full', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:other', 'Other', '02${PK}');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_blocked) VALUES ('crow:blocked', 'Blocked', '02${PK}', 1);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, request_status) VALUES ('req:${PK}', NULL, '${PK}', 'pending');
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, is_bot) VALUES ('crow:bot', 'Bot', '02${PK}', 1);
    INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey) VALUES ('crow:nokey', 'NoKey', '');
    INSERT INTO contact_groups (name, group_uid) VALUES ('Walkers', 'grp-walk');
    INSERT INTO contact_groups (name, group_uid, room_uid) VALUES ('A room', 'grp-room', 'room-1');
    INSERT INTO contact_groups (name, group_uid) VALUES ('Legacy', NULL);
    INSERT INTO contact_group_members (group_id, contact_id) VALUES (1, 1), (1, 3), (1, 5);`);
});

test("egg payload never carries species/seed and parses back bounded", () => {
  const p = eggPayload({ egg_id: "e1", warmth: 40.7, found_cell: "9v6m21h", found_week: "2026-W37", species: "crow", seed: 9 });
  assert.deepEqual(p, { egg_id: "e1", warmth: 40, found_cell: "9v6m21h", found_week: "2026-W37" });
  assert.deepEqual(parseEggPayload({ ...p, species: "crow", seed: 1 }), p);
  assert.deepEqual(parseEggPayload({ egg_id: "e2", warmth: 40.5, found_cell: "bad", found_week: "W3" }), { egg_id: "e2", warmth: 0, found_cell: null, found_week: null }, "a non-integer warmth reads as 0; bad cell/week read as null");
  assert.deepEqual(parseEggPayload({ egg_id: "e3", warmth: MAX_WARMTH + 5 }), { egg_id: "e3", warmth: MAX_WARMTH, found_cell: null, found_week: null });
  assert.equal(parseEggPayload({ egg_id: "../x", warmth: 1 }), null);
  assert.equal(parseEggPayload(null), null);
  assert.equal(parseEggPayload("e1"), null);
  assert.deepEqual(giftPayload({ egg_id: "e1", warmth: 3 }), { type: "ramble.egg", v: 1, egg: { egg_id: "e1", warmth: 3, found_cell: null, found_week: null } });
});

test("mark payload round-trips through payloadToMark as a persistent contacts mark attributed to the sender", async () => {
  const row = await createMark(db, {
    author: "c".repeat(64), author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: 30.46, lon: -98.08, accuracy_m: 12 },
    visibility: "contacts", reveal: "locked",
    content: { content_text: "for my people", content_kind: "none" },
  });
  const env = markEnvelope(row, { bird: { species: "crow", seed: 5 } });
  assert.equal(env.type, "ramble.mark"); assert.equal(env.v, 1);
  assert.deepEqual(env.mark.bird, { species: "crow", seed: 5 });
  assert.ok(!("visibility" in env.mark) && !("author" in env.mark) && !("origin" in env.mark), "the recipient decides visibility/author/origin, never the wire");
  assert.equal(markPayload(row, { bird: { species: "dragon", seed: 1 } }).bird, undefined, "an invalid bird is dropped, not shipped");

  const back = payloadToMark(env.mark, { author: PK, eventId: "evt-1" });
  assert.equal(back.mark_id, row.mark_id);
  assert.equal(back.author, PK); assert.equal(back.author_level, "real");
  assert.equal(back.visibility, "contacts"); assert.equal(back.expires_at, null, "contacts marks are persistent (spec §4)");
  assert.equal(back.origin, "remote"); assert.equal(back.publish_state, "remote"); assert.equal(back.nostr_event_id, "evt-1");
  assert.equal(back.reveal, "locked"); assert.equal(back.content_text, "for my people");
  assert.equal(back.lat, 30.46); assert.equal(back.geohash, row.geohash);
  assert.deepEqual([back.bird_species, back.bird_seed], ["crow", 5]);

  // Bounds: text truncated, bad coords/ids/kinds rejected, no anchor at all rejected.
  const long = payloadToMark({ ...env.mark, content_text: "x".repeat(5000) }, { author: PK });
  assert.equal(long.content_text.length, 2000);
  assert.equal(payloadToMark({ ...env.mark, mark_id: "bad id" }, { author: PK }), null);
  assert.equal(payloadToMark({ ...env.mark, kind: "shout" }, { author: PK }), null);
  assert.equal(payloadToMark({ ...env.mark, lat: 91 }, { author: PK }).lat, null, "an out-of-range coordinate is dropped, not stored");
  assert.equal(payloadToMark({ ...env.mark, lat: null, lon: null, geohash: null }, { author: PK }), null, "nothing to pin");
  assert.equal(payloadToMark({ ...env.mark, bird: { species: "dragon", seed: 1 } }, { author: PK }).bird_species, null);
  assert.equal(payloadToMark(env.mark, { author: null }), null);
  assert.equal(payloadToMark("nope", { author: PK }), null);
});

test("trade payload builds and parses; malformed ids, states and eggs are rejected", () => {
  const p = tradePayload({ trade_id: "t1", state: "proposed", my_egg_id: "e1", want_egg_id: null }, { egg_id: "e1", warmth: 7 });
  assert.deepEqual(p, { type: "ramble.trade", v: 1, trade: { trade_id: "t1", state: "proposed", my_egg_id: "e1", want_egg_id: null }, egg: { egg_id: "e1", warmth: 7, found_cell: null, found_week: null } });
  assert.deepEqual(parseTradePayload(p), { trade_id: "t1", state: "proposed", my_egg_id: "e1", want_egg_id: null, egg: { egg_id: "e1", warmth: 7, found_cell: null, found_week: null } });
  const bare = tradePayload({ trade_id: "t1", state: "declined" });
  assert.equal(bare.egg, undefined);
  assert.deepEqual(parseTradePayload(bare), { trade_id: "t1", state: "declined", my_egg_id: null, want_egg_id: null, egg: null });
  assert.equal(parseTradePayload({ type: "ramble.trade", v: 1, trade: { trade_id: "t1", state: "stolen" } }), null);
  assert.equal(parseTradePayload({ type: "ramble.trade", v: 1, trade: { trade_id: "t 1", state: "proposed" } }), null);
  assert.equal(parseTradePayload({ type: "ramble.trade", v: 1, trade: { trade_id: "t1", state: "proposed", my_egg_id: "e/1" } }), null);
  assert.equal(parseTradePayload({ type: "ramble.trade", v: 1, trade: { trade_id: "t1", state: "proposed" }, egg: { warmth: 1 } }), null, "an egg without an id is malformed, not ignored");
  assert.equal(parseTradePayload({ type: "ramble.egg", v: 1, egg: {} }), null);
  assert.equal(isRambleEnvelope({ type: "ramble.mark" }), true);
  assert.equal(isRambleEnvelope({ type: "crow_social" }), false);
  assert.equal(isRambleEnvelope(["ramble.mark"]), false);
  assert.equal(isRambleEnvelope(null), false);
});

test("audience: full unblocked non-bot keyed contacts only; groups by group_uid, rooms and legacy groups excluded", async () => {
  assert.deepEqual((await resolveAudience(db, "contacts")), { ok: true, crowIds: ["crow:full", "crow:other"] });
  assert.deepEqual((await resolveAudience(db, "group:grp-walk")), { ok: true, crowIds: ["crow:full"] }, "blocked and bot members are skipped");
  assert.deepEqual(await resolveAudience(db, "group:grp-room"), { ok: false, reason: "unknown-group" }, "a room is not a plain group");
  assert.deepEqual(await resolveAudience(db, "group:nope"), { ok: false, reason: "unknown-group" });
  assert.deepEqual(await resolveAudience(db, "group:"), { ok: false, reason: "unknown-group" });
  assert.deepEqual(await resolveAudience(db, "public"), { ok: false, reason: "not-deliverable" });
  assert.deepEqual(await resolveAudience(db, "private"), { ok: false, reason: "not-deliverable" });
  const aud = await listAudiences(db);
  assert.deepEqual(aud.contacts, [{ crow_id: "crow:full", display_name: "Full" }, { crow_id: "crow:other", display_name: "Other" }]);
  assert.deepEqual(aud.groups, [{ group_uid: "grp-walk", name: "Walkers", member_count: 1 }]);
  assert.equal((await resolveContact(db, "crow:full")).display_name, "Full");
  assert.equal(await resolveContact(db, "crow:blocked"), null);
  assert.equal(await resolveContact(db, "crow:bot"), null);
  assert.equal(await resolveContact(db, "crow:nokey"), null);
  assert.equal(await resolveContact(db, `req:${PK}`), null);
  assert.equal(await resolveContact(db, "crow:no such"), null, "an id that fails CROW_ID_RE never reaches SQL");
});

test("outbox: one row per unique recipient, drain helpers, failure parking at MAX_DELIVERY_ATTEMPTS", async () => {
  const n = await enqueueDeliveries(db, { toCrowIds: ["crow:full", "crow:other", "crow:full", "bad id"], kind: "egg", refId: "e1", payload: giftPayload({ egg_id: "e1", warmth: 1 }), now: 100 });
  assert.equal(n, 2);
  let rows = await pendingDeliveries(db, 50);
  assert.deepEqual(rows.map((r) => [r.to_crow_id, r.kind, r.ref_id, r.attempts]), [["crow:full", "egg", "e1", 0], ["crow:other", "egg", "e1", 0]]);
  assert.equal(JSON.parse(rows[0].payload_json).type, "ramble.egg");
  assert.equal(await remainingDeliveries(db, "egg", "e1"), 2);
  await deleteDelivery(db, rows[0].id);
  assert.equal(await remainingDeliveries(db, "egg", "e1"), 1);
  let r = await noteDeliveryFailure(db, rows[1], MAX_DELIVERY_ATTEMPTS);
  assert.deepEqual(r, { parked: false, attempts: 1 });
  rows = await pendingDeliveries(db, 50);
  assert.equal(rows[0].attempts, 1);
  for (let i = 1; i < MAX_DELIVERY_ATTEMPTS - 1; i++) r = await noteDeliveryFailure(db, { ...rows[0], attempts: i }, MAX_DELIVERY_ATTEMPTS);
  assert.equal(r.parked, false);
  r = await noteDeliveryFailure(db, { ...rows[0], attempts: MAX_DELIVERY_ATTEMPTS - 1 }, MAX_DELIVERY_ATTEMPTS);
  assert.equal(r.parked, true);
  assert.equal(await remainingDeliveries(db, "egg", "e1"), 0, "a parked delivery leaves the queue");
  await assert.rejects(enqueueDeliveries(db, { toCrowIds: ["crow:full"], kind: "letter", refId: "x", payload: {} }));
  assert.equal(await enqueueDeliveries(db, { toCrowIds: [], kind: "egg", refId: "x", payload: {} }), 0);
});

test("enqueueMark fans a contacts mark out to every full contact and refuses an unknown group", async () => {
  const row = await createMark(db, {
    author: "c".repeat(64), author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: 30.46, lon: -98.08 },
    visibility: "contacts", reveal: "open", content: { content_text: "fan out" },
  });
  assert.deepEqual(await enqueueMark(db, row, { bird: null, now: 5 }), { ok: true, recipients: 2 });
  const rows = (await pendingDeliveries(db, 50)).filter((r) => r.kind === "mark" && r.ref_id === row.mark_id);
  assert.deepEqual(rows.map((r) => r.to_crow_id), ["crow:full", "crow:other"]);
  assert.equal(JSON.parse(rows[0].payload_json).mark.content_text, "fan out");
  assert.deepEqual(await enqueueMark(db, { ...row, mark_id: "m-g", visibility: "group:nope" }), { ok: false, reason: "unknown-group", recipients: 0 });
  assert.deepEqual(await enqueueMark(db, { ...row, mark_id: "m-g2", visibility: "group:grp-walk" }), { ok: true, recipients: 1 });
  assert.deepEqual(await enqueueMark(db, { ...row, mark_id: "m-p", visibility: "public" }), { ok: false, reason: "not-deliverable", recipients: 0 });
  // Trades and gifts jump the queue ahead of marks (C1: gated marks must never starve them).
  await enqueueDeliveries(db, { toCrowIds: ["crow:full"], kind: "trade", refId: "t-late", payload: {}, now: 9 });
  assert.equal((await pendingDeliveries(db, 1))[0].kind, "trade");
  // A mark with nobody to send to settles at once (S4).
  await db.execute("INSERT INTO contact_groups (name, group_uid) VALUES ('Empty', 'grp-empty')");
  const lonely = await createMark(db, {
    author: "c".repeat(64), author_level: "rotating", kind: "mark",
    anchor: { anchor_kind: "geo", lat: 30.46, lon: -98.08 },
    visibility: "group:grp-empty", reveal: "open", content: { content_text: "echo" },
  });
  assert.deepEqual(await enqueueMark(db, lonely), { ok: true, recipients: 0 });
  assert.equal((await db.execute({ sql: "SELECT publish_state FROM ramble_marks WHERE mark_id = ?", args: [lonely.mark_id] })).rows[0].publish_state, "published");
});

test("contacts marks never carry a world name in either direction", async () => {
  const row = await createMark(db, {
    author: "c".repeat(64), author_level: "pseudonym", kind: "mark",
    anchor: { anchor_kind: "geo", lat: 30.46, lon: -98.08, accuracy_m: 12 },
    visibility: "contacts", reveal: "open",
    content: { content_text: "for my people", content_kind: "none" },
  });
  const payload = markPayload({ ...row, author_name: "Kevin" });
  assert.equal(payload.author_name, undefined);
  assert.equal(payload.name, undefined);
  const back = payloadToMark({ ...payload, author_name: "Kevin", name: "Kevin" }, { author: PK, eventId: "evt-n" });
  assert.equal(back.author_name, undefined, "a contact is named from the contacts table, never from the payload");
});
