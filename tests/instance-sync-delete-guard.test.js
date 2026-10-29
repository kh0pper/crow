/**
 * The generic sync delete never removes a row by a per-instance id.
 *
 * Synced tables that reach the generic applier (_applyDelete) are keyed by an
 * id column, and most of them are INTEGER AUTOINCREMENT: the same number
 * names unrelated rows on two siblings. DELETE_KEY_POLICY says, per table,
 * which key an inbound delete may use: "id" (portable, or a legacy path kept
 * on purpose), "uuid" (research_notes: delete by the note's uuid, never by
 * the id), or null (refuse every inbound delete).
 *
 * Real init-db stores and real InstanceSyncManagers (tests/fixtures/sync-fleet.mjs),
 * entries signed and applied through the real inbound path (_applyEntry).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SYNCED_TABLES, DELETE_KEY_POLICY, NATURAL_KEY_TABLES } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import { makeFleet } from "./fixtures/sync-fleet.mjs";
import { restoreConflict } from "../servers/sharing/sync-conflict-resolve.js";

const X = "11111111111111111111111111111111";
const Y = "22222222222222222222222222222222";

function signed(identity, instanceId, entry) {
  const e = { ...entry, instance_id: instanceId };
  return { ...e, signature: sign(JSON.stringify(e), identity.ed25519Priv) };
}

async function errors(fn) {
  const seen = [];
  const orig = console.error;
  console.error = (...a) => { seen.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.error = orig; }
  return seen;
}

async function ids(db, table) {
  const { rows } = await db.execute(`SELECT id FROM ${table} ORDER BY id`);
  return rows.map((r) => Number(r.id));
}

async function withFleet(fn) {
  const fleet = await makeFleet();
  try { await fn(fleet); } finally { await fleet.cleanup(); }
}

test("research_notes delete by id is refused", () => withFleet(async ({ a, b, identity }) => {
  await b.db.execute({ sql: "INSERT INTO research_notes (id, content, uuid) VALUES (5, 'B note', ?)", args: [X] });
  const seen = await errors(() => b.mgr._applyEntry(a.id, signed(identity, a.id, { table: "research_notes", op: "delete", row: { id: 5 }, lamport_ts: 50 })));
  assert.deepEqual(await ids(b.db, "research_notes"), [5], "note 5 is still there");
  assert.ok(seen.some((l) => /REFUSED inbound delete on research_notes/.test(l)), JSON.stringify(seen));
}));

test("research_notes delete by uuid removes the uuid's row only, whatever id the sender had", () => withFleet(async ({ a, b, identity }) => {
  await b.db.execute({ sql: "INSERT INTO research_notes (id, content, uuid) VALUES (5, 'note X', ?)", args: [X] });
  await b.db.execute({ sql: "INSERT INTO research_notes (id, content, uuid) VALUES (9, 'note Y', ?)", args: [Y] });
  await b.mgr._applyEntry(a.id, signed(identity, a.id, { table: "research_notes", op: "delete", row: { id: 9, uuid: X }, lamport_ts: 50 }));
  assert.deepEqual(await ids(b.db, "research_notes"), [9], "id 5 (uuid X) gone, id 9 (uuid Y) kept");
  // A uuid this instance does not hold deletes nothing.
  await b.mgr._applyEntry(a.id, signed(identity, a.id, { table: "research_notes", op: "delete", row: { id: 9, uuid: "33333333333333333333333333333333" }, lamport_ts: 51 }));
  assert.deepEqual(await ids(b.db, "research_notes"), [9]);
  // A non-string uuid is refused.
  await b.mgr._applyEntry(a.id, signed(identity, a.id, { table: "research_notes", op: "delete", row: { id: 9, uuid: 9 }, lamport_ts: 52 }));
  assert.deepEqual(await ids(b.db, "research_notes"), [9]);
}));

test("a stale uuid delete is checked against the uuid's row, not the sender's id", () => withFleet(async ({ a, b, identity }) => {
  // B's note X is newer (lamport 100) than the incoming delete (50): it survives
  // and the conflict names B's local id for X, not the sender's id 9.
  await b.db.execute({ sql: "INSERT INTO research_notes (id, content, uuid, lamport_ts) VALUES (5, 'note X', ?, 100)", args: [X] });
  await b.db.execute({ sql: "INSERT INTO research_notes (id, content, uuid, lamport_ts) VALUES (9, 'note Y', ?, 0)", args: [Y] });
  await b.mgr._applyEntry(a.id, signed(identity, a.id, { table: "research_notes", op: "delete", row: { id: 9, uuid: X }, lamport_ts: 50 }));
  assert.deepEqual(await ids(b.db, "research_notes"), [5, 9], "the newer local note X survives");
  const { rows } = await b.db.execute("SELECT id, row_id FROM sync_conflicts WHERE table_name = 'research_notes'");
  assert.deepEqual(rows.map((r) => String(r.row_id)), ["5"]);

  // Accepting the delete from the conflict screen sends it to peers by uuid
  // (a bare { id } would be refused there).
  const sent = [];
  const stub = { feedsDisabled: false, emitChange: async (table, op, row) => { sent.push({ table, op, row }); return 1; } };
  const outcome = await restoreConflict(b.db, rows[0].id, { instanceSync: stub });
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  assert.deepEqual(await ids(b.db, "research_notes"), [9]);
  assert.deepEqual(sent, [{ table: "research_notes", op: "delete", row: { id: "5", uuid: X } }], "the conflict row_id (a string) plus the uuid");
}));

test("tables without a portable key refuse every inbound delete", () => withFleet(async ({ a, b, identity }) => {
  await b.db.execute("INSERT INTO glasses_note_sessions (id, device_id, mode) VALUES (4, 'dev', 'dictation')");
  await b.db.execute("INSERT INTO relay_config (id, relay_url, relay_type) VALUES (4, 'wss://relay.example', 'nostr')");
  await b.db.execute("INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (40, 'crow:del-guard', 'alex', 'ed', 'secp')");
  await b.db.execute("INSERT INTO shared_items (id, contact_id, share_type, item_id, direction) VALUES (4, 40, 'memory', 1, 'sent')");
  for (const table of ["glasses_note_sessions", "relay_config", "shared_items"]) {
    const seen = await errors(() => b.mgr._applyEntry(a.id, signed(identity, a.id, { table, op: "delete", row: { id: 4 }, lamport_ts: 50 })));
    assert.deepEqual(await ids(b.db, table), [4], `${table}: row kept`);
    assert.ok(seen.some((l) => l.includes(`REFUSED inbound delete on ${table}`)), `${table}: ${JSON.stringify(seen)}`);
  }
}));

test("memories delete by id still applies (legacy, unchanged)", () => withFleet(async ({ a, b, identity }) => {
  await b.db.execute("INSERT INTO memories (id, content) VALUES (77, 'bye')");
  await b.mgr._applyEntry(a.id, signed(identity, a.id, { table: "memories", op: "delete", row: { id: 77 }, lamport_ts: 50 }));
  const { rows } = await b.db.execute("SELECT id FROM memories WHERE id = 77");
  assert.equal(rows.length, 0);
}));

test("every generic-path synced table has a delete-key policy", () => {
  assert.ok(Object.isFrozen(DELETE_KEY_POLICY));
  for (const t of NATURAL_KEY_TABLES) assert.ok(SYNCED_TABLES.includes(t), `${t} is synced`);
  for (const t of SYNCED_TABLES) {
    if (NATURAL_KEY_TABLES.includes(t)) continue;
    assert.ok(Object.hasOwn(DELETE_KEY_POLICY, t), `${t} reaches _applyDelete: it needs a DELETE_KEY_POLICY entry`);
  }
  for (const [t, p] of Object.entries(DELETE_KEY_POLICY)) assert.ok([null, "id", "uuid"].includes(p), `${t}: ${p}`);
});
