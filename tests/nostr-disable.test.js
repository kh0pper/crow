/**
 * CROW_DISABLE_NOSTR kill-switch (follow-up pool): every relay dial funnels
 * through NostrManager.connectRelays, and scratch/test gateways were dialing
 * the baked-in public DEFAULT_RELAYS on every boot. With the flag set,
 * connectRelays returns [] without touching the network — combined with
 * CROW_DISABLE_INSTANCE_SYNC (hyperswarm/feeds), a test gateway boots fully
 * offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NostrManager, nostrDisabled, DEFAULT_RELAYS } from "../servers/sharing/nostr.js";

test("nostrDisabled: pure predicate on CROW_DISABLE_NOSTR", () => {
  assert.equal(nostrDisabled({ CROW_DISABLE_NOSTR: "1" }), true);
  assert.equal(nostrDisabled({ CROW_DISABLE_NOSTR: "0" }), false);
  assert.equal(nostrDisabled({}), false);
  assert.equal(nostrDisabled({ CROW_DISABLE_NOSTR: "true" }), false, "only the literal '1' disables");
});

test("connectRelays with CROW_DISABLE_NOSTR=1 returns [] and never populates the relay map", async () => {
  const prev = process.env.CROW_DISABLE_NOSTR;
  process.env.CROW_DISABLE_NOSTR = "1";
  try {
    const mgr = new NostrManager({ secp256k1Pubkey: "ab".repeat(33) }, null);
    // db=null would otherwise fall back to DEFAULT_RELAYS and DIAL them —
    // the gate must short-circuit first (and fast: no 10s connect timeouts).
    const t0 = Date.now();
    const urls = await mgr.connectRelays();
    assert.deepEqual(urls, []);
    assert.equal(mgr.relays.size, 0, "no relay connections were made");
    assert.ok(Date.now() - t0 < 2000, "returned immediately — no dial attempts");
    assert.ok(DEFAULT_RELAYS.length > 0, "sanity: the default relay floor exists and was skipped");
    // Second call stays gated and quiet.
    assert.deepEqual(await mgr.connectRelays(), []);
  } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_NOSTR;
    else process.env.CROW_DISABLE_NOSTR = prev;
  }
});
