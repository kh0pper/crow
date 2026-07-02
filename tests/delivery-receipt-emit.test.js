/**
 * delivery-receipt-emit — R5 Task 3. _sendDeliveryReceipt publishes a
 * crow_social/delivery_receipt control envelope (via sendControl) naming the
 * received event id, to the contact it came from. Stubs sendControl; asserts
 * the envelope shape + that a sendControl failure never throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NostrManager } from "../servers/sharing/nostr.js";
import { DELIVERY_RECEIPT_SUBTYPE } from "../servers/sharing/retry-queue.js";

function mgr() {
  return new NostrManager({ secp256k1Pubkey: "b".repeat(64), secp256k1Priv: new Uint8Array(32) }, null);
}

test("_sendDeliveryReceipt sends a delivery_receipt envelope for the event id", async () => {
  const m = mgr();
  const sent = [];
  m.sendControl = async (contact, content) => { sent.push({ contact, content }); return { eventId: "ack1", relays: ["r"] }; };
  await m._sendDeliveryReceipt({ id: 7, secp256k1_pubkey: "02" + "a".repeat(64) }, "evtX");
  assert.equal(sent.length, 1);
  const env = JSON.parse(sent[0].content);
  assert.equal(env.type, "crow_social");
  assert.equal(env.subtype, DELIVERY_RECEIPT_SUBTYPE);
  assert.deepEqual(env.payload.event_ids, ["evtX"]);
  assert.equal(sent[0].contact.id, 7);
});

test("_sendDeliveryReceipt never throws when sendControl rejects", async () => {
  const m = mgr();
  m.sendControl = async () => { throw new Error("relay down"); };
  await m._sendDeliveryReceipt({ id: 1, secp256k1_pubkey: "02" + "a".repeat(64) }, "evtY"); // must resolve, not reject
});
