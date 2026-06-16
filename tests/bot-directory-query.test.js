// tests/bot-directory-query.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { getBotDirectory } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { _setFetchImpl, _resetCache } from "../servers/gateway/dashboard/advertised-bots-cache.js";

const PKA = "a".repeat(64), PKB = "b".repeat(64);

async function seedDb(contactRows = []) {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT, is_bot INTEGER DEFAULT 0)`);
  for (const c of contactRows) {
    await db.execute({ sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, origin) VALUES (?,?,?)", args: [c.crow_id, c.pk, c.origin || null] });
  }
  await db.execute(`CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT, crow_id TEXT, trusted INTEGER, status TEXT, is_home INTEGER, gateway_url TEXT)`);
  await db.execute(`INSERT INTO crow_instances (id,name,crow_id,trusted,status,is_home) VALUES ('phone','Phone','crow:p',1,'active',0)`);
  return db;
}

test("getBotDirectory groups by instance and marks already-added bots", async () => {
  _resetCache();
  _setFetchImpl(async () => ({ ok: true, body: { bots: [
    { bot_id: "b1", display_name: "Helper", instance_label: "Phone", messaging_pubkey: "02" + PKA, invite_code: "crow:a.b.c", description: "tag A" },
    { bot_id: "b2", display_name: "Chef", instance_label: "Phone", messaging_pubkey: "03" + PKB, invite_code: "crow:a.b.c" },
  ] } }));
  const db = await seedDb([{ crow_id: "crow:bot1", pk: "02" + PKA, origin: "advertised" }]);
  const dir = await getBotDirectory(db);
  assert.equal(dir.groups.length, 1, "one instance group");
  assert.equal(dir.groups[0].instanceLabel, "Phone");
  const byId = Object.fromEntries(dir.groups[0].bots.map((b) => [b.botId, b]));
  assert.equal(byId.b1.added, true, "PKA already a contact → added");
  assert.equal(byId.b2.added, false, "PKB not a contact");
  assert.equal(dir.total, 2);
  assert.equal(dir.notAddedCount, 1);
  _setFetchImpl(null);
});

test("getBotDirectory never throws when a peer fetch fails", async () => {
  _resetCache();
  _setFetchImpl(async () => { throw new Error("boom"); });
  const db = await seedDb([]);
  const dir = await getBotDirectory(db);
  assert.deepEqual(dir.groups, []);
  assert.equal(dir.total, 0);
  _setFetchImpl(null);
});
