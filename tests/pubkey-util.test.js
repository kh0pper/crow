/**
 * pubkey-util — normalizePubkey + findContactByPubkey (L6 message-requests
 * groundwork, Task 1). Exercises normalization of the 66-hex-compressed vs
 * 64-hex-x-only secp256k1 pubkey mismatch, and the shared contacts lookup
 * against a real init-db-built DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { normalizePubkey, findContactByPubkey } from "../servers/sharing/pubkey-util.js";

test("normalizePubkey: 66-hex compressed and its 64-hex x-only tail normalize equal, case-insensitive", () => {
  const xonly = "a1b2c3d4e5f6".padEnd(64, "0"); // 64 hex chars
  const compressed02 = "02" + xonly; // 66 hex chars, 02-prefixed
  const compressed03Upper = "03" + xonly.toUpperCase(); // 66 hex chars, different prefix + case

  assert.equal(normalizePubkey(compressed02), xonly.toLowerCase());
  assert.equal(normalizePubkey(xonly), xonly.toLowerCase());
  assert.equal(normalizePubkey(compressed02), normalizePubkey(xonly));
  assert.equal(normalizePubkey(compressed03Upper), normalizePubkey(xonly), "case-insensitive + prefix-agnostic");
});

test("normalizePubkey never throws on null/undefined/short input", () => {
  assert.doesNotThrow(() => normalizePubkey(null));
  assert.doesNotThrow(() => normalizePubkey(undefined));
  assert.doesNotThrow(() => normalizePubkey(""));
  assert.doesNotThrow(() => normalizePubkey("ab"));
  assert.equal(typeof normalizePubkey(null), "string");
  assert.equal(typeof normalizePubkey(undefined), "string");
});

let dir, db;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "pubkeyutil-test-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
});

after(() => {
  try { db.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("contacts table has a nullable request_status column", async () => {
  const { rows } = await db.execute("PRAGMA table_info(contacts)");
  const col = rows.find((r) => r.name === "request_status");
  assert.ok(col, "request_status column missing");
  assert.equal(Number(col.notnull), 0, "request_status must be nullable");
});

test("findContactByPubkey: 66-hex compressed key stored, found by its 64-hex x-only form; unknown key -> null", async () => {
  const xonly = "b".repeat(64);
  const compressed = "02" + xonly;

  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)",
    args: ["crow:pubkeyutil-test", "Test Contact", "ed25519-placeholder", compressed],
  });

  const found = await findContactByPubkey(db, xonly);
  assert.ok(found, "expected contact to be found by x-only tail");
  assert.equal(found.crow_id, "crow:pubkeyutil-test");
  assert.equal(found.secp256k1_pubkey, compressed);

  // Also findable by the stored compressed form itself.
  const foundByCompressed = await findContactByPubkey(db, compressed);
  assert.ok(foundByCompressed);
  assert.equal(foundByCompressed.crow_id, "crow:pubkeyutil-test");

  const notFound = await findContactByPubkey(db, "c".repeat(64));
  assert.equal(notFound, null, "unknown key must resolve to null");
});

test("findContactByPubkey: multi-row pubkey match resolves deterministically — real crow: row beats req: placeholder, then lowest id", async () => {
  // No unique index on secp256k1_pubkey (documented at instance-sync.js §GC
  // tombstone notes): a real `crow:` contact and a `req:<secp>` placeholder
  // legitimately coexist on the same key. Every boot.js caller wants the REAL
  // contact (block status, receipts, display-name all live there; the
  // catch-all DM path double-stores if it picks the placeholder).
  const xonly = "d".repeat(64);
  const compressed = "02" + xonly;

  // Insert the placeholder FIRST so natural scan order would return it.
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES (?,?,?,?,?)",
    args: ["req:" + xonly, "Request placeholder", "", compressed, "pending"],
  });
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)",
    args: ["crow:pubkeyutil-real", "Real Contact", "ed25519-placeholder", compressed],
  });

  const found = await findContactByPubkey(db, xonly);
  assert.ok(found, "expected a contact");
  assert.equal(found.crow_id, "crow:pubkeyutil-real", "real crow: row must beat the req: placeholder");

  // Two real rows on the same key → lowest id wins (stable tiebreak, the
  // contact-promote.js ORDER BY id ASC precedent).
  const xonly2 = "e".repeat(64);
  const a = await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)",
    args: ["crow:pubkeyutil-a", "A", "", "02" + xonly2],
  });
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)",
    args: ["crow:pubkeyutil-b", "B", "", "03" + xonly2],
  });
  const picked = await findContactByPubkey(db, xonly2);
  assert.equal(Number(picked.id), Number(a.lastInsertRowid), "lowest id must win among equal-rank rows");
});

test("findContactByPubkey never throws on null/short input", async () => {
  assert.equal(await findContactByPubkey(db, null), null);
  assert.equal(await findContactByPubkey(db, ""), null);
  assert.equal(await findContactByPubkey(db, "ab"), null);
});
