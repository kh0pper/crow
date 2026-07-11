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

test("health-loop tick order: _refreshRelayHealth runs BEFORE the ensureHealthy sweep (M3 pin)", async () => {
  _resetReceiveHealth();
  const prev = process.env.CROW_NOSTR_HEALTH_MS;
  process.env.CROW_NOSTR_HEALTH_MS = "50";
  const mgr = new NostrManager(identity, null);
  try {
    const stub = { connected: true };
    mgr.relays.set("wss://stub", stub);

    // A FAKE subscription handle, not a real resilient sub — a real one's
    // ensureHealthy calls relay.connect() and would resurrect the dying
    // stub, hiding the very ordering bug this test exists to catch. This
    // handle only observes: it records the receive-health value at the
    // instant the sweep invokes it, and never touches mgr.relays.
    const recordings = [];
    mgr.subscriptions.set("fake:sub", {
      ensureHealthy: () => { recordings.push(getReceiveHealth().relaysConnected); },
    });

    mgr._startHealthLoop();
    assert.ok(await waitFor(() => recordings.length >= 1), "first tick reached the sweep");

    // Kill the stub's socket, then wait for the NEXT tick to record a value.
    // If _refreshRelayHealth runs first (current code), that tick's refresh
    // sees the death and sets relaysConnected=0 before ensureHealthy is ever
    // called, so the recording is 0. If ensureHealthy ran first (refresh
    // moved after the loop — the M3 mutation), it would still observe the
    // stale relaysConnected=1 from the previous tick's refresh.
    stub.connected = false;
    const countBeforeFlip = recordings.length;
    assert.ok(await waitFor(() => recordings.length > countBeforeFlip), "a tick ran after the flip");
    assert.equal(
      recordings[countBeforeFlip],
      0,
      "first post-flip ensureHealthy call must observe relaysConnected===0 — proves refresh ran before the sweep this same tick; refresh-after would still read 1",
    );

    await mgr.destroy();
  } finally {
    if (prev === undefined) delete process.env.CROW_NOSTR_HEALTH_MS; else process.env.CROW_NOSTR_HEALTH_MS = prev;
    await mgr.destroy().catch(() => {});
  }
});
