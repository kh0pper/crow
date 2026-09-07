import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createMark, listMarks, unlockMark, expireMarks, insertRemoteMark, blockPersona } from "../bundles/ramble/server/marks.js";

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
