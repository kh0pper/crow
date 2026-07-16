/**
 * Minor-pool item 3 (2026-07-16 spec): regression pin for the removed
 * "feed-key-announce" dead path. Nothing in the codebase ever SENT that
 * message type, and the handler passed state.remoteCrowId where
 * onInstanceKeyReceived (boot.js) requires an INSTANCE id — crow_id is shared
 * fleet-wide and can never key a crow_instances row. This pin fails if anyone
 * re-adds the wrong-keyed handler.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PeerManager } from "../servers/sharing/peer-manager.js";

test("feed-key-announce messages do NOT invoke onInstanceKeyReceived (dead path stays dead)", () => {
  const pm = new PeerManager({ crowId: "crow:test", ed25519Pubkey: "00".repeat(32), ed25519Priv: "00".repeat(32) });
  let called = null;
  pm.onInstanceKeyReceived = (id, key) => { called = [id, key]; };
  const conn = { write() {}, destroy() {} };
  pm._handleMessage(
    conn,
    { type: "feed-key-announce", feed_key_hex: "ab".repeat(32) },
    Buffer.alloc(32),
    { authenticated: true, remoteCrowId: "crow:test", isInstanceConn: true },
    () => {},
  );
  assert.equal(called, null, `feed-key-announce must be ignored; got onInstanceKeyReceived(${called?.[0]}) — a crow_id, not an instance id`);
});
