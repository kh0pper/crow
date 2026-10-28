/**
 * U-4: the challenge-response downgrade guard fails CLOSED when the local
 * instance id is missing. Without a local id the guard cannot look up a CR
 * pin, so "no id" must mean "CR required" — a CR-less (legacy) hello is
 * refused instead of being served as if the peer were unpinned.
 *
 * Driven through the real server entry point (setupTailnetSyncServer via the
 * sync-gateway fixture), with a hand-driven WebSocket client.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { makeFleet, sleep } from "./fixtures/sync-fleet.mjs";
import { startGateway } from "./fixtures/sync-gateway.mjs";
import { _setAllowLoopbackAddressesForTest } from "../servers/sharing/tailnet-sync.js";
import { sign } from "../servers/sharing/identity.js";

const WS_PATH = "/api/instance-sync/stream";
before(() => _setAllowLoopbackAddressesForTest(true));
after(() => _setAllowLoopbackAddressesForTest(false));

async function openRaw(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  const frames = [];
  let closeCode = null; let closeReason = "";
  ws.on("message", (d, bin) => { if (!bin) frames.push(JSON.parse(d.toString())); });
  const closed = new Promise((r) => ws.on("close", (c, why) => { closeCode = c; closeReason = String(why || ""); r(); }));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  return { ws, frames, closed, close: () => ws.terminate(), code: () => closeCode, reason: () => closeReason };
}

function legacyHello(identity, asId) {
  const nonce = randomBytes(16).toString("hex");
  return { instance_id: asId, nonce_hex: nonce, sig_hex: sign(`${asId}:${nonce}`, identity.ed25519Priv) };
}

test("U-4: with no local instance id, a legacy-only (CR-less) hello is refused; with the id set and no pin, the same legacy hello is served", async () => {
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  // The real manager with only its local id hidden.
  const idless = new Proxy(b.mgr, {
    get: (t, k) => (k === "localInstanceId" ? undefined : Reflect.get(t, k, t)),
  });
  const B0 = await startGateway(fleet, b, { instanceSyncManager: idless });
  const B1 = await startGateway(fleet, b);
  try {
    // No local id: the guard cannot read a pin, so it must refuse.
    const c = await openRaw(B0.port);
    c.ws.send(JSON.stringify(legacyHello(identity, a.id)));
    await Promise.race([c.closed, sleep(3000)]);
    assert.equal(c.code(), 1008, "legacy hello refused when the local id is missing");
    assert.equal(c.reason(), "challenge required");
    assert.equal(c.frames.length, 0, "nothing is sent to the refused hello");
    c.close();

    // Positive control: local id set, peer not pinned → legacy still works.
    const ok = await openRaw(B1.port);
    ok.ws.send(JSON.stringify(legacyHello(identity, a.id)));
    const t0 = Date.now();
    while (ok.frames.length < 2 && ok.code() === null && Date.now() - t0 < 3000) await sleep(25);
    assert.equal(ok.frames[0]?.instance_id, b.id, "legacy client gets the server hello");
    assert.ok("feed_key_hex" in (ok.frames[1] || {}), "legacy client gets the feed key");
    ok.close();
  } finally {
    await B0.close();
    await B1.close();
    await fleet.cleanup();
  }
});
