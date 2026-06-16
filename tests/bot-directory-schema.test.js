// tests/bot-directory-schema.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";

// Mirrors the REAL init-db.js helper EXACTLY: signature (table, column,
// definition) and DDL `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`.
async function addColumnIfMissing(db, table, column, definition) {
  const { rows } = await db.execute(`PRAGMA table_info(${table})`);
  if (!rows.some((r) => r.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

test("contacts.is_bot is added idempotently and backfills origin='advertised'", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, origin TEXT)`);
  await db.execute(`INSERT INTO contacts (crow_id, origin) VALUES ('crow:bot1','advertised')`);
  await db.execute(`INSERT INTO contacts (crow_id, origin) VALUES ('crow:human1', NULL)`);

  for (let i = 0; i < 2; i++) {
    await addColumnIfMissing(db, "contacts", "is_bot", "INTEGER DEFAULT 0");
    await db.execute("UPDATE contacts SET is_bot = 1 WHERE origin = 'advertised' AND is_bot = 0");
  }

  const cols = await db.execute(`PRAGMA table_info(contacts)`);
  assert.ok(cols.rows.some((r) => r.name === "is_bot"), "contacts.is_bot exists");
  const bot = await db.execute("SELECT is_bot FROM contacts WHERE crow_id='crow:bot1'");
  assert.equal(Number(bot.rows[0].is_bot), 1, "advertised contact backfilled to is_bot=1");
  const human = await db.execute("SELECT is_bot FROM contacts WHERE crow_id='crow:human1'");
  assert.equal(Number(human.rows[0].is_bot), 0, "non-advertised contact stays is_bot=0");
});
