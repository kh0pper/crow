// tests/roster-advertise-aggregate.test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { getAdvertisedBotItems } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { _setFetchImpl, _resetCache } from "../servers/gateway/dashboard/advertised-bots-cache.js";

const PK_NEW = "b".repeat(64);
const PK_KNOWN = "c".repeat(64);

async function seed(db) {
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT)`);
  // Columns getTrustedInstances reads: trusted + status (+ is_home/name for ORDER BY).
  await db.execute(`CREATE TABLE crow_instances (id TEXT PRIMARY KEY, crow_id TEXT, status TEXT, trusted INTEGER, is_home INTEGER, name TEXT)`);
  await db.execute("INSERT INTO crow_instances (id, crow_id, status, trusted) VALUES ('peer1','u','active', 1)");
  await db.execute("INSERT INTO crow_instances (id, crow_id, status, trusted) VALUES ('peer2','u','offline',1)");
  await db.execute("INSERT INTO crow_instances (id, crow_id, status, trusted) VALUES ('gone', 'u','revoked',1)");   // status excluded
  await db.execute("INSERT INTO crow_instances (id, crow_id, status, trusted) VALUES ('paused','u','paused', 1)");  // status excluded
  await db.execute("INSERT INTO crow_instances (id, crow_id, status, trusted) VALUES ('untr', 'u','active', 0)");   // untrusted excluded
  await db.execute({ sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey) VALUES ('crow:known', ?)", args: ["02" + PK_KNOWN] });
}

beforeEach(() => { _resetCache(); _setFetchImpl(null); });

test("aggregates advertised bots, drops revoked/paused/untrusted peers, dedups, excludes materialized", async () => {
  const db = createClient({ url: ":memory:" });
  await seed(db);
  _setFetchImpl(async (_db, instanceId) => {
    if (instanceId === "peer1") return { ok: true, body: { bots: [
      { bot_id: "n1", display_name: "New", instance_label: "Phone", messaging_pubkey: PK_NEW, invite_code: "crow:n.e.w" },
      { bot_id: "kn", display_name: "Known", instance_label: "Phone", messaging_pubkey: PK_KNOWN, invite_code: "crow:k.n.o" },
    ] } };
    if (instanceId === "peer2") return { ok: true, body: { bots: [
      { bot_id: "n1dup", display_name: "Dup", instance_label: "Laptop", messaging_pubkey: PK_NEW, invite_code: "crow:d.u.p" },
    ] } };
    return { ok: false, error: "should-not-be-called" };
  });

  const items = await getAdvertisedBotItems(db);
  assert.equal(items.length, 1, "one unique, non-materialized bot");
  assert.equal(items[0].type, "advertised");
  assert.equal(items[0].messagingPubkey, PK_NEW);
  assert.equal(items[0].inviteCode, "crow:n.e.w");
});
