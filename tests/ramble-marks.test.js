import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark, listMarks, unlockMark, expireMarks, insertRemoteMark, blockPersona, getMark } from "../bundles/ramble/server/marks.js";

let db;
before(async () => { db = createClient({ url: "file::memory:" }); await initRambleTables(db); });

test("open geo mark is listable and returns its text", async () => {
  await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 },
    content: { content_text: "open coffee", content_kind: "none" },
  });
  const rows = await listMarks(db, { visibility: "public" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content_text, "open coffee");
});

test("locked mark hides text in list, unlocks only in range", async () => {
  const m = await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "public", reveal: "locked",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 },
    content: { content_text: "secret spot", content_kind: "none" },
  });
  const listed = await listMarks(db, { visibility: "public" });
  assert.ok(!listed.find((r) => r.content_text === "secret spot")); // teaser strips content
  const far = await unlockMark(db, m.mark_id, { lat: 30.30, lon: -97.74 });
  assert.equal(far.unlocked, false);
  const near = await unlockMark(db, m.mark_id, { lat: 30.2673, lon: -97.7431 });
  assert.equal(near.unlocked, true);
  assert.equal(near.content.content_text, "secret spot");
});

test("expired marks are swept", async () => {
  await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "caw", visibility: "public", reveal: "open", ttlSeconds: -1,
    anchor: { anchor_kind: "geo", lat: 1, lon: 1 }, content: { content_text: "old" },
  });
  const swept = await expireMarks(db, Date.now());
  assert.ok(swept >= 1);
});

test("an expired open mark cannot be unlocked (the sweep may be up to a tick away)", async () => {
  const m = await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "public", reveal: "open", ttlSeconds: -1,
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 },
    content: { content_text: "stale secret", content_kind: "none" },
  });
  const res = await unlockMark(db, m.mark_id, { lat: 30.2672, lon: -97.7431 });
  assert.equal(res.unlocked, false);
  assert.equal(res.expired, true);
  assert.equal(res.content, null);
  await expireMarks(db, Date.now());
});

test("blocked personas are dropped on receipt and hidden in lists", async () => {
  const remote = { mark_id: "r1", author: "badpk", kind: "mark", anchor_kind: "geo", geohash: "9v6m2a", lat: 30.2672, lon: -97.7431, visibility: "public", reveal: "open", content_text: "spam", created_at: Date.now(), nostr_event_id: "ev1" };
  assert.equal((await insertRemoteMark(db, remote)).inserted, true);
  await blockPersona(db, "badpk", "spam");
  assert.ok(!(await listMarks(db, { visibility: "public" })).some((r) => r.author === "badpk")); // existing rows purged/hidden
  const again = await insertRemoteMark(db, { ...remote, mark_id: "r2", nostr_event_id: "ev2" });
  assert.equal(again.inserted, false);
  assert.equal(again.blocked, true);
});

test("insertRemoteMark accepts a sparse caw with no lat/lon", async () => {
  const result = await insertRemoteMark(db, {
    mark_id: "caw1", author: "pk2", kind: "caw", anchor_kind: "geo", geohash: "9v6m2",
    visibility: "public", reveal: "open", content_text: "here",
    created_at: Date.now(), expires_at: Date.now() + 3600000, nostr_event_id: "evcaw",
  });
  assert.equal(result.inserted, true);
  assert.equal(result.row.geohash, "9v6m2");
  assert.equal(result.row.lat, null);
});

test("insertRemoteMark stores bird_species/bird_seed when given", async () => {
  const result = await insertRemoteMark(db, {
    mark_id: "bird-remote-1", author: "pk3", kind: "mark", anchor_kind: "geo", geohash: "9v6m2c",
    lat: 30.2672, lon: -97.7431, visibility: "public", reveal: "open", content_text: "a bird left this",
    created_at: Date.now(), nostr_event_id: "ev-bird-1",
    bird_species: "crow", bird_seed: 5,
  });
  assert.equal(result.inserted, true);
  assert.equal(result.row.bird_species, "crow");
  assert.equal(result.row.bird_seed, 5);
});

test("createMark persists the author's active bird on the local row", async () => {
  const m = await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 },
    content: { content_text: "my own pin", content_kind: "none" },
    bird: { species: "raven", seed: 9 },
  });
  assert.equal(m.bird_species, "raven");
  assert.equal(m.bird_seed, 9);
});

test("createMark with no bird stores null bird_species/bird_seed", async () => {
  const m = await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "public", reveal: "open",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 },
    content: { content_text: "no bird yet", content_kind: "none" },
  });
  assert.equal(m.bird_species, null);
  assert.equal(m.bird_seed, null);
});

test("a private mark lists under visibility:private, is open by default, persists (no expiry), and never appears under visibility:public", async () => {
  const m = await createMark(db, {
    author: "pk1", author_level: "rotating", kind: "mark", visibility: "private",
    anchor: { anchor_kind: "geo", lat: 30.2672, lon: -97.7431, accuracy_m: 75 },
    content: { content_text: "just for me", content_kind: "none" },
  });
  assert.equal(m.reveal, "open");
  assert.equal(m.expires_at, null);

  const privateList = await listMarks(db, { visibility: "private" });
  assert.ok(privateList.find((r) => r.mark_id === m.mark_id));
  assert.equal(privateList.find((r) => r.mark_id === m.mark_id).content_text, "just for me");

  const publicList = await listMarks(db, { visibility: "public" });
  assert.ok(!publicList.find((r) => r.mark_id === m.mark_id));
});

test("insertRemoteMark rejects a private row — a remote row can never be private", async () => {
  const result = await insertRemoteMark(db, {
    mark_id: "remote-private-1", author: "pkremote", kind: "mark", anchor_kind: "geo",
    geohash: "9v6m2c", lat: 30.2672, lon: -97.7431, visibility: "private", reveal: "open",
    content_text: "sneaky", created_at: Date.now(), nostr_event_id: "ev-priv-1",
  });
  assert.equal(result.inserted, false);
  assert.equal(result.invalid, true);
  const stored = await getMark(db, "remote-private-1");
  assert.equal(stored, null);
});

test("a private mark synced in from the user's OWN other instance (origin='sync') is readable; one that somehow arrived as origin='remote' is not", async () => {
  // Mirrors applyRambleMark's INSERT shape (servers/sharing/instance-sync.js):
  // cols + origin/publish_state/lamport_ts, origin='sync' for a row that
  // replicated in from one of the user's own other instances.
  await db.execute({
    sql: `INSERT INTO ramble_marks (
            mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon,
            visibility, reveal, content_text, created_at, publish_state, origin, lamport_ts
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', 'sync', ?)`,
    args: [
      "sync-private-1", "pk1", "rotating", "mark", "geo", "9v6m2c", 30.2672, -97.7431,
      "private", "open", "synced from my other instance", Date.now(), 1,
    ],
  });
  // A private row that somehow arrived tagged as the Nostr wire origin
  // ('remote') must never be readable — that origin should never exist for
  // visibility='private' (insertRemoteMark rejects it), but this guards the
  // read path independently too.
  await db.execute({
    sql: `INSERT INTO ramble_marks (
            mark_id, author, author_level, kind, anchor_kind, geohash, lat, lon,
            visibility, reveal, content_text, created_at, publish_state, origin, lamport_ts
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote', 'remote', ?)`,
    args: [
      "wire-private-1", "pkbad", "rotating", "mark", "geo", "9v6m2c", 30.2672, -97.7431,
      "private", "open", "should never be readable", Date.now(), 1,
    ],
  });

  const privateList = await listMarks(db, { visibility: "private" });
  assert.ok(privateList.find((r) => r.mark_id === "sync-private-1"), "synced-from-own-instance private mark must be readable");
  assert.ok(!privateList.find((r) => r.mark_id === "wire-private-1"), "a private mark tagged origin=remote must never be readable");

  const noFilterList = await listMarks(db, {});
  assert.ok(noFilterList.find((r) => r.mark_id === "sync-private-1"), "synced-from-own-instance private mark must appear in the owner's overview");
  assert.ok(!noFilterList.find((r) => r.mark_id === "wire-private-1"), "a private mark tagged origin=remote must never appear in the owner's overview");
});

test("insertRemoteMark stores author_name and a locked teaser keeps it", async () => {
  const result = await insertRemoteMark(db, {
    mark_id: "named-remote-1", author: "pk9", kind: "mark", anchor_kind: "geo", geohash: "9v6m2c",
    lat: 30.2672, lon: -97.7431, visibility: "public", reveal: "locked", content_text: "named",
    created_at: Date.now(), nostr_event_id: "ev-named-1", author_name: "  Kevin\u202E ",
  });
  assert.equal(result.inserted, true);
  assert.equal(result.row.author_name, "Kevin", "sanitized at the store too");
  const listed = (await listMarks(db, { visibility: "public" })).find((r) => r.mark_id === "named-remote-1");
  assert.equal(listed.author_name, "Kevin", "the teaser allowlist carries the name");
  assert.equal(listed.content_text, undefined, "still a teaser");
});
