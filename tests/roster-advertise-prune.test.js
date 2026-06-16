// tests/roster-advertise-prune.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { pruneStaleAdvertisedContacts } from "../servers/gateway/dashboard/panels/messages/data-queries.js";

test("prunes advertised contacts with no history that are no longer advertised", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT)`);
  await db.execute(`CREATE TABLE messages (id INTEGER PRIMARY KEY, contact_id INTEGER)`);

  // 1) advertised, no history, NOT live  → pruned
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, secp256k1_pubkey, origin) VALUES (1,'a','02'||?,'advertised')", args: ["a".repeat(64)] });
  // 2) advertised, no history, STILL live → kept
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, secp256k1_pubkey, origin) VALUES (2,'b','02'||?,'advertised')", args: ["b".repeat(64)] });
  // 3) advertised, HAS history, not live → kept
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, secp256k1_pubkey, origin) VALUES (3,'c','02'||?,'advertised')", args: ["c".repeat(64)] });
  await db.execute("INSERT INTO messages (contact_id) VALUES (3)");
  // 4) manual contact, no history, not live → kept (origin NULL)
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, secp256k1_pubkey, origin) VALUES (4,'d','02'||?,NULL)", args: ["d".repeat(64)] });

  const live = new Set(["b".repeat(64)]);
  await pruneStaleAdvertisedContacts(db, live);

  const { rows } = await db.execute("SELECT id FROM contacts ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), [2, 3, 4], "only the stale advertised no-history contact is pruned");
});
