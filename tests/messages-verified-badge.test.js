/**
 * messages-verified-badge — P2/C4 Task 5.
 *
 * The Contacts panel already shows a "✓ verified" badge (safety-number
 * comparison, `contacts.verified` column, SCHEMA_GEN 3->4). This closes the
 * same signal on the Messages conversation header, which is rendered
 * CLIENT-SIDE from server-fetched data — so the thing that actually needs
 * coverage is the SERVER BOUNDARY: do the two reads the client depends on
 * (the open-thread contact fetch, and the unified conversation list) carry
 * `verified` at all? If either SELECT drops the column, the header can never
 * show the badge no matter what client.js does.
 *
 * (a) getUnifiedConversationList (data-queries.js) — peer rows carry a
 *     `verified` boolean sourced from `c.verified`.
 * (b) GET /api/messages/peer/:contactId (peer-messages.js) — the contact
 *     object in the response carries `verified` (real express route, real
 *     sqlite db via CROW_DATA_DIR, matching the crow-messages-admin.test.js
 *     pattern — the route calls the module-level createDbClient() directly,
 *     so there's no injectable db to stub).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "msg-verified-badge-"));
process.env.CROW_DATA_DIR = dir;

const PKA = "a".repeat(64);
const PKB = "b".repeat(64);

let db = null;
let server = null;
let baseUrl = "";
let getUnifiedConversationList = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });

  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();

  ({ getUnifiedConversationList } = await import(
    "../servers/gateway/dashboard/panels/messages/data-queries.js"
  ));
  const { default: peerMessagesRouter } = await import(
    "../servers/gateway/routes/peer-messages.js"
  );

  const app = express();
  app.use(express.json());
  // Passthrough auth — dashboard session auth is out of scope for this test.
  const noAuth = (req, res, next) => next();
  app.use(peerMessagesRouter(noAuth, { sharingClientFactory: async () => ({ close: async () => {} }) }));

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function mkContact(crowId, { verified = 0, displayName = null } = {}) {
  const r = await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, ed25519_pubkey, contact_type, verified)
          VALUES (?,?,?,?, 'crow', ?)`,
    args: [crowId, displayName, "02" + PKA, "e".repeat(64), verified],
  });
  return Number(r.lastInsertRowid);
}

// --- (a) getUnifiedConversationList carries `verified` ---

test("getUnifiedConversationList: peer rows carry verified (true for verified contact, false otherwise)", async () => {
  const verifiedId = await mkContact("crow:verified1", { verified: 1, displayName: "Verified Vera" });
  const unverifiedId = await mkContact("crow:unverified1", { verified: 0, displayName: "Plain Pete" });

  const { items } = await getUnifiedConversationList(db);
  const verifiedItem = items.find((i) => i.id === verifiedId);
  const unverifiedItem = items.find((i) => i.id === unverifiedId);

  assert.ok(verifiedItem, "verified contact present in unified list");
  assert.ok(unverifiedItem, "unverified contact present in unified list");
  assert.equal(verifiedItem.verified, true, "verified contact flagged verified:true");
  assert.equal(unverifiedItem.verified, false, "unverified contact flagged verified:false");
});

// --- (b) GET /api/messages/peer/:contactId carries `verified` on the contact ---

test("GET /api/messages/peer/:contactId: contact object carries verified:1 for a verified contact", async () => {
  const id = await mkContact("crow:route-verified", { verified: 1, displayName: "Route Verified" });
  const r = await fetch(`${baseUrl}/api/messages/peer/${id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.contact, "contact returned");
  assert.equal(Number(body.contact.verified), 1, "contact.verified is 1 for a verified contact");
});

test("GET /api/messages/peer/:contactId: contact object carries verified:0 by default (unverified contact)", async () => {
  const id = await mkContact("crow:route-unverified", { verified: 0, displayName: "Route Unverified" });
  const r = await fetch(`${baseUrl}/api/messages/peer/${id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.contact, "contact returned");
  assert.equal(Number(body.contact.verified), 0, "contact.verified is 0 by default");
});
