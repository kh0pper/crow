// tests/contact-verified-column.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";

test("SCHEMA_GENERATION covers the verified column (gen >= 4)", () => {
  // The verified column shipped in generation 4; later features bump further
  // (5 = contact_groups.group_uid/lamport_ts). Exact-equality here broke on
  // every subsequent legitimate bump — assert the floor instead.
  assert.ok(SCHEMA_GENERATION >= 4, `expected >= 4, got ${SCHEMA_GENERATION}`);
});

// In-memory contacts+messages db stub (contact-promote.test.js pattern).
function makeDb() {
  const contacts = [];
  let nextId = 1;
  const messages = [];
  const norm = (k) => String(k || "").toLowerCase().slice(-64);
  return {
    contacts, messages,
    async execute({ sql, args = [] }) {
      if (/^SELECT \* FROM contacts WHERE crow_id = \?/.test(sql)) {
        return { rows: contacts.filter((c) => c.crow_id === args[0]) };
      }
      if (/lower\(substr\(secp256k1_pubkey,-64\)\) = \?/.test(sql)) {
        return { rows: contacts.filter((c) => norm(c.secp256k1_pubkey) === args[0]).sort((a, b) => a.id - b.id) };
      }
      if (/^SELECT \* FROM contacts WHERE id = \?/.test(sql)) {
        return { rows: contacts.filter((c) => c.id === args[0]) };
      }
      if (/^INSERT INTO contacts/.test(sql)) {
        const row = { id: nextId++, crow_id: args[0], display_name: args[1], ed25519_pubkey: args[2], secp256k1_pubkey: args[3], request_status: null, verified: 0, contact_type: "crow" };
        contacts.push(row);
        return { rows: [], lastInsertRowid: row.id };
      }
      if (/^UPDATE contacts SET/.test(sql)) {
        // crude apply: match the trailing "WHERE id = ?"
        const id = args[args.length - 1];
        const row = contacts.find((c) => c.id === id);
        if (row) {
          if (/verified = 0/.test(sql)) row.verified = 0;
          if (/request_status = NULL/.test(sql)) row.request_status = null;
          if (/crow_id = \?/.test(sql)) row.crow_id = args[0];
          if (/secp256k1_pubkey = \?/.test(sql) && /crow_id = \?/.test(sql)) row.secp256k1_pubkey = args[1];
        }
        return { rows: [] };
      }
      if (/^UPDATE messages SET contact_id/.test(sql)) return { rows: [] };
      if (/^DELETE FROM contacts WHERE id = \?/.test(sql)) {
        const i = contacts.findIndex((c) => c.id === args[0]);
        if (i >= 0) contacts.splice(i, 1);
        return { rows: [] };
      }
      throw new Error("unexpected sql: " + sql);
    },
  };
}

const SECP_A = "a".repeat(64);
const SECP_B = "b".repeat(64);
const ED = "c".repeat(64);

test("CREATE defaults verified to 0", async () => {
  const db = makeDb();
  const r = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  assert.equal(r.outcome, "created");
  assert.equal(db.contacts.find((c) => c.id === r.contactId).verified, 0);
});

test("NOOP preserves a verified badge (same crow_id + same secp)", async () => {
  const db = makeDb();
  const { contactId } = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  db.contacts.find((c) => c.id === contactId).verified = 1; // user marked verified
  const r = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  assert.equal(r.outcome, "noop");
  assert.equal(db.contacts.find((c) => c.id === contactId).verified, 1, "verified survives a noop re-accept");
});

test("PROMOTE resets verified to 0 on a key rebind", async () => {
  const db = makeDb();
  // A full contact with crow:old + SECP_A, marked verified.
  const { contactId } = await upsertFullContact(db, {}, { crowId: "crow:old", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  db.contacts.find((c) => c.id === contactId).verified = 1;
  // Re-accept the SAME secp under a DIFFERENT crow_id → PROMOTE (crow_id rebind).
  const r = await upsertFullContact(db, {}, { crowId: "crow:new", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  assert.equal(r.outcome, "promoted");
  assert.equal(db.contacts.find((c) => c.id === r.contactId).verified, 0, "key change clears verified");
});

test("MERGE resets verified to 0", async () => {
  const db = makeDb();
  // Owner row: crow:aaa with a DIFFERENT secp, verified.
  const owner = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_B, displayName: "Alice" });
  db.contacts.find((c) => c.id === owner.contactId).verified = 1;
  // A separate row sharing SECP_A but no crow owner (simulate a request row).
  db.contacts.push({ id: 99, crow_id: "req:x", display_name: "req:x", ed25519_pubkey: "", secp256k1_pubkey: SECP_A, request_status: "accepted", verified: 0, contact_type: "crow" });
  // Now upsert crow:aaa with SECP_A → owner exists AND row 99 shares SECP_A → MERGE.
  const r = await upsertFullContact(db, {}, { crowId: "crow:aaa", ed25519Pub: ED, secp256k1Pub: SECP_A, displayName: "Alice" });
  assert.equal(r.outcome, "merged");
  assert.equal(db.contacts.find((c) => c.id === r.contactId).verified, 0, "merge clears verified");
});
