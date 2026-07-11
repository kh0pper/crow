/**
 * tailnet-sync dial-URL derivation + Funnel upgrade guard.
 *
 * Regression net for the L3 outage (2026-07-06): peerToWsUrl preferred the
 * port embedded in gateway_url — on this fleet that's a Tailscale Serve
 * HTTPS port (e.g. grackle 8444 → backend 3002) — and dialed it as plain
 * ws:// on the raw tailnet IP. Plain WS into a TLS-terminating Serve
 * listener fails (HTTP 400 / TLS alert), the error lands in a swallowed
 * ws.on("error"), and the dialer retries silently forever. Net effect: the
 * NAT-independent fallback transport never carried a single byte, so when
 * Hyperswarm's same-NAT hole-punch broke at the router, crow↔grackle
 * instance sync went fully dark.
 *
 * The fix derives the dial from gateway_url's scheme: https → wss://host:port
 * (Serve terminates TLS and proxies the upgrade to the backend; the HOSTNAME
 * is required — Serve needs SNI, raw-IP wss fails its handshake), http →
 * ws://host:port, port 443 skipped (public Funnel proxies only the curated
 * public path-list, which excludes /api/instance-sync/stream). A direct
 * ws://<tailscale_ip>:<backend fallbackPort> candidate is kept as a ladder
 * fallback for Serve-less peers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { peerToWsUrlCandidates, setupTailnetSyncServer } from "../servers/sharing/tailnet-sync.js";

const WS_PATH = "/api/instance-sync/stream";

test("https gateway_url with Serve port → wss on the HOSTNAME (grackle row shape)", () => {
  const urls = peerToWsUrlCandidates({
    gateway_url: "https://grackle.dachshund-chromatic.ts.net:8444",
    tailscale_ip: "100.121.254.89",
  });
  assert.equal(urls[0], `wss://grackle.dachshund-chromatic.ts.net:8444${WS_PATH}`);
  // Never the broken combination: plain ws into the Serve HTTPS port.
  assert.ok(!urls.includes(`ws://100.121.254.89:8444${WS_PATH}`));
});

test("tailnet-IP fallback candidate uses the backend fallbackPort, not the Serve port", () => {
  const urls = peerToWsUrlCandidates(
    {
      gateway_url: "https://grackle.dachshund-chromatic.ts.net:8444",
      tailscale_ip: "100.121.254.89",
    },
    3002
  );
  assert.deepEqual(urls, [
    `wss://grackle.dachshund-chromatic.ts.net:8444${WS_PATH}`,
    `ws://100.121.254.89:3002${WS_PATH}`,
    `ws://100.121.254.89:3001${WS_PATH}`,
  ]);
});

test("http gateway_url dials plain ws on its own port", () => {
  const urls = peerToWsUrlCandidates({ gateway_url: "http://10.0.0.21:3002" });
  assert.equal(urls[0], `ws://10.0.0.21:3002${WS_PATH}`);
});

test("port 443 (public Funnel) is never dialed — falls back to tailnet IP", () => {
  const urls = peerToWsUrlCandidates(
    { gateway_url: "https://grackle.dachshund-chromatic.ts.net", tailscale_ip: "100.121.254.89" },
    3002
  );
  assert.deepEqual(urls, [
    `ws://100.121.254.89:3002${WS_PATH}`,
    `ws://100.121.254.89:3001${WS_PATH}`,
  ]);
});

test("no gateway_url → tailnet IP + fallbackPort only", () => {
  const urls = peerToWsUrlCandidates({ tailscale_ip: "100.118.41.122" }, 3001);
  // #144 minor: the peer's backend port isn't advertised, so the ladder
  // tries the caller's own port plus the fleet-standard 3001/3002.
  assert.deepEqual(urls, [
    `ws://100.118.41.122:3001${WS_PATH}`,
    `ws://100.118.41.122:3002${WS_PATH}`,
  ]);
});

test("neither gateway_url nor tailscale_ip → no candidates", () => {
  assert.deepEqual(peerToWsUrlCandidates({}), []);
  assert.deepEqual(peerToWsUrlCandidates(null), []);
});

test("malformed gateway_url falls back to the tailnet IP candidate", () => {
  const urls = peerToWsUrlCandidates(
    { gateway_url: "not a url ::", tailscale_ip: "100.121.254.89" },
    3002
  );
  assert.deepEqual(urls, [
    `ws://100.121.254.89:3002${WS_PATH}`,
    `ws://100.121.254.89:3001${WS_PATH}`,
  ]);
});

test("candidates are deduped when gateway_url already IS the tailnet-IP dial", () => {
  const urls = peerToWsUrlCandidates(
    { gateway_url: "http://100.121.254.89:3002", tailscale_ip: "100.121.254.89" },
    3002
  );
  assert.deepEqual(urls, [
    `ws://100.121.254.89:3002${WS_PATH}`,
    `ws://100.121.254.89:3001${WS_PATH}`,
  ]);
});

test("non-standard caller port leads the fallback ladder, then the fleet-standard ports", () => {
  const urls = peerToWsUrlCandidates({ tailscale_ip: "100.118.41.122" }, 3006);
  assert.deepEqual(urls, [
    `ws://100.118.41.122:3006${WS_PATH}`,
    `ws://100.118.41.122:3001${WS_PATH}`,
    `ws://100.118.41.122:3002${WS_PATH}`,
  ]);
});

test("bare IPv6 tailscale_ip is bracketed in the direct candidates (#144 minor)", () => {
  const urls = peerToWsUrlCandidates({ tailscale_ip: "fd7a:115c:a1e0::1" }, 3001);
  assert.deepEqual(urls, [
    `ws://[fd7a:115c:a1e0::1]:3001${WS_PATH}`,
    `ws://[fd7a:115c:a1e0::1]:3002${WS_PATH}`,
  ]);
});

test("upgrade handler destroys Funnel-tagged sockets before any handshake", () => {
  const server = new EventEmitter();
  setupTailnetSyncServer(server, {
    identity: { ed25519Pubkey: "00".repeat(32), ed25519Priv: "00".repeat(64) },
    instanceSyncManager: { localInstanceId: "test-local" },
    db: { execute: async () => ({ rows: [] }) },
  });

  let destroyed = false;
  const socket = { destroy: () => { destroyed = true; }, write: () => {}, end: () => {} };
  server.emit(
    "upgrade",
    { url: WS_PATH, headers: { "tailscale-funnel-request": "1" }, socket: { remoteAddress: "1.2.3.4" } },
    socket,
    Buffer.alloc(0)
  );
  assert.equal(destroyed, true, "Funnel-tagged upgrade must be destroyed (network-exposure invariant)");
});

test("upgrade handler ignores non-matching paths (leaves socket alone)", () => {
  const server = new EventEmitter();
  setupTailnetSyncServer(server, {
    identity: { ed25519Pubkey: "00".repeat(32), ed25519Priv: "00".repeat(64) },
    instanceSyncManager: { localInstanceId: "test-local" },
    db: { execute: async () => ({ rows: [] }) },
  });
  let destroyed = false;
  const socket = { destroy: () => { destroyed = true; } };
  server.emit("upgrade", { url: "/other/ws", headers: {}, socket: {} }, socket, Buffer.alloc(0));
  assert.equal(destroyed, false);
});

test("backoff grows once per FULL ladder cycle, not per candidate (#144 minor)", async () => {
  const { PeerDialer } = await import("../servers/sharing/tailnet-sync.js");
  const d = new PeerDialer({ id: "peer-x" }, {});
  d._candCount = 3; // three candidates in the ladder
  const base = d.retryMs;

  // Attempts 1 and 2 (mid-cycle): retry delay stays at base for the untried
  // candidates — no exponential penalty inherited from earlier failures.
  d.attempt = 1; d.scheduleRetry(); assert.equal(d.retryMs, base, "mid-cycle attempt 1: no growth");
  d.attempt = 2; d.scheduleRetry(); assert.equal(d.retryMs, base, "mid-cycle attempt 2: no growth");
  // Attempt 3 completes the cycle → double.
  d.attempt = 3; d.scheduleRetry(); assert.equal(d.retryMs, base * 2, "full cycle → doubled");
  // Next full cycle doubles again; cap respected eventually.
  d.attempt = 6; d.scheduleRetry(); assert.equal(d.retryMs, base * 4, "second full cycle → doubled again");

  // Single-candidate ladder degenerates to the old per-attempt behavior.
  const d1 = new PeerDialer({ id: "peer-y" }, {});
  d1._candCount = 1;
  d1.attempt = 1; d1.scheduleRetry(); assert.equal(d1.retryMs, base * 2, "single candidate: doubles every retry");

  // Unset _candCount (retry before any connect) must not throw or divide by zero.
  const d2 = new PeerDialer({ id: "peer-z" }, {});
  d2.attempt = 0; d2.scheduleRetry(); assert.equal(d2.retryMs, base * 2);

  d.stop(); d1.stop(); d2.stop(); // clear pending timers so the test process exits
});
