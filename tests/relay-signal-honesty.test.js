/**
 * Cluster D (F-HEALTH-2) — relaysConnected mirrors LIVE socket state:
 * refreshed on every health tick (before the ensureHealthy sweep) and at
 * connect; a throwing stub can't kill the interval; destroy zeroes the count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicKey } from "nostr-tools";
import { NostrManager } from "../servers/sharing/nostr.js";
import { getReceiveHealth, _resetReceiveHealth } from "../servers/sharing/receive-health.js";

const ourPriv = new Uint8Array(32).fill(1);
const identity = { secp256k1Pubkey: getPublicKey(ourPriv), secp256k1Priv: ourPriv };

const waitFor = async (fn, ms = 3000, step = 25) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, step)); }
  return fn();
};

test("_refreshRelayHealth counts only live sockets (not map size)", async () => {
  _resetReceiveHealth();
  const mgr = new NostrManager(identity, null);
  mgr.relays.set("wss://a", { connected: true });
  mgr.relays.set("wss://b", { connected: true });
  mgr.relays.set("wss://c", { connected: false });
  mgr.relays.set("wss://d", null);
  mgr._refreshRelayHealth();
  assert.equal(getReceiveHealth().relaysConnected, 2, "2 live of 4 entries");
  await mgr.destroy();
});

test("_doConnectRelays end-state uses the live count (direct call — the connectRelays wrapper early-returns on a non-empty map)", async () => {
  _resetReceiveHealth();
  const mgr = new NostrManager(identity, null);
  mgr.relays.set("wss://dead", { connected: false }); // survives the empty connect loop
  await mgr._doConnectRelays([]);
  assert.equal(getReceiveHealth().relaysConnected, 0, "size===1 but live===0 — the size-count mutation reddens here");
  await mgr.destroy();
});

test("health-loop tick refreshes the count both ways; throwing getter never kills the loop; destroy zeroes", async () => {
  _resetReceiveHealth();
  const prev = process.env.CROW_NOSTR_HEALTH_MS;
  process.env.CROW_NOSTR_HEALTH_MS = "50";
  const mgr = new NostrManager(identity, null);
  try {
    const stub = { connected: true };
    mgr.relays.set("wss://stub", stub);
    // A hostile entry whose getter throws — the tick must survive it (HARD REQ).
    mgr.relays.set("wss://evil", { get connected() { throw new Error("boom"); } });
    // Start the loop DIRECTLY with no registered subscription — a registered
    // resilient sub's ensureHealthy would call stub.connect() and resurrect it.
    mgr._startHealthLoop();
    assert.ok(await waitFor(() => getReceiveHealth().relaysConnected === 1), "tick counts the one live stub (evil getter swallowed)");
    stub.connected = false;
    assert.ok(await waitFor(() => getReceiveHealth().relaysConnected === 0), "tick notices the post-boot socket death (F-HEALTH-2)");
    stub.connected = true;
    assert.ok(await waitFor(() => getReceiveHealth().relaysConnected === 1), "tick recovers after reconnect");
    await mgr.destroy();
    assert.equal(getReceiveHealth().relaysConnected, 0, "destroy zeroes the count");
  } finally {
    if (prev === undefined) delete process.env.CROW_NOSTR_HEALTH_MS; else process.env.CROW_NOSTR_HEALTH_MS = prev;
    await mgr.destroy().catch(() => {});
  }
});
