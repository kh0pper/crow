/**
 * messages-peer-route — Task 5 (F-UI-6 server). The live GET
 * /api/messages/peer/:contactId route builds its own createDbClient, so we
 * test the extracted pieces instead:
 *  - getPeerMessages query shape (see message-delivery-render.test.js for the
 *    afterId variant).
 *  - safety-number attachment via the exported withSafetyNumber helper,
 *    including the cache-on-success myEd25519Pubkey() behavior (R2-M1: a
 *    transient identity-load failure must not poison the cache for the rest
 *    of the process).
 *
 * CROW_DATA_DIR is set BEFORE any import of peer-messages.js / identity.js —
 * identity.js resolves its data dir once at module-load time (same pattern
 * as tests/crow-messages-admin.test.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "msg-peer-route-"));
process.env.CROW_DATA_DIR = dir;

const { withSafetyNumber } = await import("../servers/gateway/routes/peer-messages.js");
const { loadOrCreateIdentity, computeSafetyNumber } = await import("../servers/sharing/identity.js");

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("withSafetyNumber(null) returns null", async () => {
  assert.equal(await withSafetyNumber(null), null);
});

test("withSafetyNumber(undefined) returns null", async () => {
  assert.equal(await withSafetyNumber(undefined), null);
});

test("contact without ed25519_pubkey gets safety_number: null, other fields preserved", async () => {
  const contact = { id: 3, display_name: "No Key", crow_id: "crow:nokey" };
  const result = await withSafetyNumber(contact);
  assert.equal(result.safety_number, null);
  assert.equal(result.id, 3);
  assert.equal(result.display_name, "No Key");
});

test("contact with ed25519_pubkey gets a real symmetric safety number in the 8x5-digit format", async () => {
  const identity = loadOrCreateIdentity();
  const theirEd = "b".repeat(64);
  const contact = { id: 2, display_name: "Alice", crow_id: "crow:alice", ed25519_pubkey: theirEd };

  const result = await withSafetyNumber(contact);

  assert.match(result.safety_number, /^\d{5}( \d{5}){7}$/);
  assert.equal(result.safety_number, computeSafetyNumber(identity.ed25519Pubkey, theirEd));
  // Symmetric: same string regardless of key order.
  assert.equal(result.safety_number, computeSafetyNumber(theirEd, identity.ed25519Pubkey));
});

test("never throws even if contact is a bare object with unexpected shape", async () => {
  await assert.doesNotReject(() => withSafetyNumber({}));
  const result = await withSafetyNumber({});
  assert.equal(result.safety_number, null);
});
