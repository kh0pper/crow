/**
 * servers/sharing/data-hygiene.js + Settings › Data hygiene.
 *
 *  - Orphaned messages (crow carried 17 `messages` rows with contact_id 0):
 *    scan is read-only, the purge is dry-run unless confirmed, refuses when
 *    the count moved since the operator looked, and never touches a message
 *    whose contact exists.
 *  - Junk contacts by name: preview never writes; the confirmed bulk delete
 *    runs every row through deleteContactLocal, and — over a REAL
 *    two-instance replication link — the peer converges (the rows are
 *    deleted there too), while non-matching and protected rows survive on
 *    both sides.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeRealDb, makeFleet, linkPeers, until, sleep } from "./fixtures/sync-fleet.mjs";
import {
  scanOrphanedMessages, purgeOrphanedMessages, namePatternToLike, previewContactsByName, bulkDeleteContactsByName,
} from "../servers/sharing/data-hygiene.js";
import { __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import section from "../servers/gateway/dashboard/settings/sections/data-hygiene.js";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); __setEmitSinkForTest(null); });

async function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-"));
  dirs.push(dir);
  const db = await makeRealDb(dir);
  return { dir, db, path: join(dir, "crow.db") };
}

/** Seed through a raw handle with FKs OFF — exactly how the orphans arose. */
function seedRaw(path, sql) {
  const raw = new Database(path);
  try { raw.pragma("foreign_keys = OFF"); raw.exec(sql); } finally { raw.close(); }
}

const contactSql = (id, crowId, name, origin = null) =>
  `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (${id}, '${crowId}', '${name}', 'ed', 'secp', ${origin ? `'${origin}'` : "NULL"});`;

test("orphaned messages: scan is read-only, purge is dry-run by default, guarded by the shown count, and spares live contacts", async () => {
  const { db, path } = await scratchDb();
  seedRaw(path, `
    ${contactSql(1, "crow:alice", "Alice")}
    INSERT INTO messages (contact_id, nostr_event_id, content, direction) VALUES (1, 'e1', 'hi', 'received'), (1, 'e2', 'yo', 'sent');
    INSERT INTO messages (contact_id, nostr_event_id, content, direction) VALUES (0, 'o1', 'x', 'received'), (0, 'o2', 'x', 'received'), (0, 'o3', 'x', 'sent');
    INSERT INTO messages (contact_id, nostr_event_id, content, direction) VALUES (99, 'o4', 'x', 'received');
    INSERT INTO message_retry_queue (nostr_event_id, contact_id, raw_event, next_attempt_at, created_at) VALUES ('q1', 99, '{}', 0, 0), ('q2', 1, '{}', 0, 0);
  `);
  const scan = await scanOrphanedMessages(db);
  assert.equal(scan.messages, 4);
  assert.equal(scan.retryQueue, 1);
  assert.deepEqual(scan.byContact.map((r) => [r.contact_id, r.n]), [[0, 3], [99, 1]]);

  const dry = await purgeOrphanedMessages(db);
  assert.equal(dry.dryRun, true);
  assert.equal((await scanOrphanedMessages(db)).messages, 4, "default call deletes nothing");

  const moved = await purgeOrphanedMessages(db, { confirm: true, expected: 3 });
  assert.equal(moved.refused, "count_changed");
  assert.equal((await scanOrphanedMessages(db)).messages, 4, "a stale count deletes nothing");

  const done = await purgeOrphanedMessages(db, { confirm: true, expected: 4 });
  assert.deepEqual(done.deleted, { messages: 4, retryQueue: 1 });
  const left = (await db.execute("SELECT nostr_event_id FROM messages ORDER BY nostr_event_id")).rows.map((r) => r.nostr_event_id);
  assert.deepEqual(left, ["e1", "e2"]);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM message_retry_queue")).rows[0].n, 1);
  assert.deepEqual(await scanOrphanedMessages(db), { messages: 0, retryQueue: 0, byContact: [] });
});

test("settings section: render is a dry run; the confirmed POST purges and redirects with the counts", async () => {
  const { db, path } = await scratchDb();
  seedRaw(path, `INSERT INTO messages (contact_id, nostr_event_id, content, direction) VALUES (0, 'o1', 'x', 'received');`);
  const html = await section.render({ req: { query: {}, csrfToken: "tok" }, db, lang: "en" });
  assert.match(html, /purge_orphan_messages/);
  assert.match(html, /name="expected" value="1"/);
  assert.equal((await scanOrphanedMessages(db)).messages, 1, "render wrote nothing");

  let to = null;
  const res = { redirectAfterPost: (u) => { to = u; } };
  assert.equal(await section.handleAction({ req: { body: { confirm: "0", expected: "1" } }, res, db, action: "purge_orphan_messages" }), true);
  assert.match(to, /purge_refused=1/);
  assert.equal((await scanOrphanedMessages(db)).messages, 1, "unconfirmed POST deletes nothing");
  await section.handleAction({ req: { body: { confirm: "1", expected: "1" } }, res, db, action: "purge_orphan_messages" });
  assert.match(to, /purged=1/);
  assert.equal((await scanOrphanedMessages(db)).messages, 0);
  assert.equal(await section.handleAction({ req: { body: {} }, res, db, action: "something_else" }), false);
});

test("namePatternToLike: substring by default, * wildcard, LIKE metacharacters escaped, too-broad patterns refused", () => {
  assert.equal(namePatternToLike("streamable"), "%streamable%");
  assert.equal(namePatternToLike("stream*ble"), "stream%ble");
  assert.equal(namePatternToLike("50%_off"), "%50\\%\\_off%");
  for (const bad of ["", "*", "ab", "**a*", " a b ", null, "x".repeat(101)]) assert.equal(namePatternToLike(bad), null, String(bad));
});

test("bulk delete by name: preview writes nothing; the confirmed delete tombstones + broadcasts and the PEER converges; non-matching, renamed and local-bot rows survive", async () => {
  const fleet = await makeFleet();
  const { a, b } = fleet;
  let link;
  const warn = console.warn;
  console.warn = () => {};
  try {
    // The same user's contacts exist on both instances (they sync).
    const seed = `
      ${contactSql(11, "crow:junk1", "streamable")}
      ${contactSql(12, "crow:junk2", "streamable")}
      ${contactSql(13, "crow:junk3", "Streamable test")}
      ${contactSql(14, "crow:alice", "Alice")}
      ${contactSql(15, "crow:renamed", "streamable")}`;
    for (const side of [a, b]) {
      for (const stmt of seed.split(";").map((x) => x.trim()).filter(Boolean)) await side.db.execute(stmt);
    }
    await a.db.execute(contactSql(16, "crow:bot", "streamable bot", "local-bot").replace(/;$/, ""));
    link = await linkPeers(a, b);
    __setEmitSinkForTest(a.mgr, a.db);

    const pv = await previewContactsByName(a.db, "streamable");
    assert.deepEqual(pv.matches.map((r) => r.id), [11, 12, 13, 15]);
    assert.deepEqual(pv.protected.map((r) => r.id), [16]);

    const unconfirmed = await bulkDeleteContactsByName(a.db, {}, { pattern: "streamable", ids: [11, 12, 13, 15] });
    assert.equal(unconfirmed.ok, false);
    assert.equal((await a.db.execute("SELECT COUNT(*) AS n FROM contacts")).rows[0].n, 6, "nothing deleted without confirm");

    // Between preview and confirm, one contact was renamed: it must survive.
    await a.db.execute("UPDATE contacts SET display_name = 'Real Person' WHERE id = 15");
    const r = await bulkDeleteContactsByName(a.db, {}, { pattern: "streamable", ids: [11, 12, 13, 15, 14, 16], confirm: true });
    assert.equal(r.ok, true);
    assert.equal(r.deleted, 3);
    assert.deepEqual(r.skipped.map((x) => x.id).sort(), [14, 15, 16]);

    const leftA = (await a.db.execute("SELECT crow_id FROM contacts ORDER BY crow_id")).rows.map((x) => x.crow_id);
    assert.deepEqual(leftA, ["crow:alice", "crow:bot", "crow:renamed"]);
    const tombs = (await a.db.execute("SELECT crow_id, kind FROM contact_tombstones ORDER BY crow_id")).rows;
    assert.deepEqual(tombs.map((x) => [x.crow_id, x.kind]), [["crow:junk1", null], ["crow:junk2", null], ["crow:junk3", null]], "authoritative tombstones");

    // The peer converges over the real link.
    const bGone = async () => (await b.db.execute("SELECT COUNT(*) AS n FROM contacts WHERE crow_id LIKE 'crow:junk%'")).rows[0].n === 0;
    assert.ok(await until(bGone, 5000), "B deleted the junk contacts too");
    const leftB = (await b.db.execute("SELECT crow_id FROM contacts ORDER BY crow_id")).rows.map((x) => x.crow_id);
    assert.deepEqual(leftB, ["crow:alice", "crow:renamed"]);
    await sleep(200);
  } finally {
    console.warn = warn;
    __setEmitSinkForTest(null);
    link?.close();
    await fleet.cleanup();
  }
});
