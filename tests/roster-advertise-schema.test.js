// tests/roster-advertise-schema.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";

// Mirrors the guarded-ALTER helper added to init-db.js. Kept inline so the test
// asserts the COLUMN EXISTS without bootstrapping the whole init-db script.
async function addColumnIfMissing(db, table, column, decl) {
  const { rows } = await db.execute(`PRAGMA table_info(${table})`);
  if (!rows.some((r) => r.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
  }
}

test("contacts.origin and bot_message_invites.kind are added idempotently", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT)`);
  await db.execute(`CREATE TABLE bot_message_invites (id INTEGER PRIMARY KEY, bot_id TEXT, token TEXT)`);

  // Running twice must not throw (idempotent).
  for (let i = 0; i < 2; i++) {
    await addColumnIfMissing(db, "contacts", "origin", "origin TEXT");
    await addColumnIfMissing(db, "bot_message_invites", "kind", "kind TEXT");
  }

  const c = await db.execute(`PRAGMA table_info(contacts)`);
  assert.ok(c.rows.some((r) => r.name === "origin"), "contacts.origin exists");
  const i = await db.execute(`PRAGMA table_info(bot_message_invites)`);
  assert.ok(i.rows.some((r) => r.name === "kind"), "bot_message_invites.kind exists");
});
