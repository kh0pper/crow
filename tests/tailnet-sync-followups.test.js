/**
 * Sync follow-ups to #415 (2026-10-04), each gated on the REAL two-instance
 * harness (tests/fixtures/sync-fleet.mjs + sync-gateway.mjs: real
 * InstanceSyncManagers on init-db scratch DBs, real Hypercore feeds, real
 * http servers running setupTailnetSyncServer, real startTailnetSyncClients).
 * Every negative assertion is paired with a positive one on the SAME fleet or
 * an explicit control, so a dead harness cannot pass vacuously.
 *
 *   1. ROOT CAUSE: the :443 dial address. Pairing handed peers
 *      CROW_GATEWAY_URL (the public :443 door) — now the derived tailnet
 *      address; boot repair fixes rows that already hold a :443 URL.
 *   2. Half-open links: a heartbeat terminates a silent link; the dialer
 *      re-dials.
 *   3. Challenge-response: a replayed hello (client or server) gets no feed
 *      key; a CR-less hello from a peer that has done CR is refused.
 *   4. Both sides dial at once: exactly one link, every time.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { makeFleet, until, sleep, hasMemory, writeAndEmit, makeRealDb } from "./fixtures/sync-fleet.mjs";
import { startGateway, startBlackholeRelay } from "./fixtures/sync-gateway.mjs";
import { _setAllowLoopbackAddressesForTest, repairUndialablePeerRows } from "../servers/sharing/tailnet-sync.js";
import { sign } from "../servers/sharing/identity.js";
import { getPeerDialHealth, _resetPeerDialHealth } from "../servers/shared/peer-dial-health.js";
import {
  serveUrlForPort, deriveSelfDialAddress, lookupTailnetIpForHost, isDialableGatewayUrl, pickPeerGatewayUrl,
} from "../servers/shared/self-dial-address.js";
import { ensureLocalInstanceRegistered, selfPairingAddress } from "../servers/gateway/instance-registry.js";
import { instanceEnrollRouter } from "../servers/gateway/routes/instance-enroll.js";
import { writeRepairAllowance } from "../servers/shared/enroll-guard.js";

const WS_PATH = "/api/instance-sync/stream";

before(() => _setAllowLoopbackAddressesForTest(true));
after(() => _setAllowLoopbackAddressesForTest(false));

const realWarn = console.warn;
const realLog = console.log;
function quiet() { if (process.env.TEST_LOUD) return; console.warn = () => {}; console.log = () => {}; }
function loud() { console.warn = realWarn; console.log = realLog; }

const linked = (a, b) => a.mgr.hasDedicatedStream(b.id) && b.mgr.hasDedicatedStream(a.id);
const unlinked = (a, b) => !a.mgr.hasDedicatedStream(b.id) && !b.mgr.hasDedicatedStream(a.id);
const streams = (x, y) => x.mgr._activeStreams.get(y.id)?.size ?? 0;

async function row(db, id) {
  return (await db.execute({ sql: "SELECT gateway_url, tailscale_ip FROM crow_instances WHERE id = ?", args: [id] })).rows[0];
}

/* ------------------------------------------------- 1. the :443 root cause */

// `tailscale serve status --json` shapes taken from the live fleet (2026-10-04).
const CROW_SERVE = {
  TCP: { 443: { HTTPS: true }, 8444: { HTTPS: true }, 8449: { HTTPS: true } },
  Web: {
    "crow.example.ts.net:443": { Handlers: { "/blog": { Proxy: "http://127.0.0.1:3001/blog" } } },
    "crow.example.ts.net:8444": { Handlers: { "/": { Proxy: "http://localhost:3001" } } },
    "crow.example.ts.net:8449": { Handlers: { "/": { Proxy: "http://localhost:3008" } } },
  },
  AllowFunnel: { "crow.example.ts.net:443": true },
};
const BLACKSWAN_SERVE = { // a PRIVATE Serve on :443, proxying "/" to the gateway
  TCP: { 443: { HTTPS: true } },
  Web: { "black-swan.example.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:3001" } } } },
};
const FUNNEL_ON_8444 = {
  Web: { "x.example.ts.net:8444": { Handlers: { "/": { Proxy: "http://localhost:3001" } } } },
  AllowFunnel: { "x.example.ts.net:8444": true },
};

function fakeTailscale({ serve = null, ip = "100.64.0.5", status = null } = {}) {
  return (bin, args) => {
    if (bin !== "tailscale") throw new Error("unexpected binary");
    if (args[0] === "ip") { if (!ip) throw new Error("no ip"); return `${ip}\n`; }
    if (args[0] === "serve") { if (!serve) throw new Error("serve not configured"); return JSON.stringify(serve); }
    if (args[0] === "status") { if (!status) throw new Error("not running"); return JSON.stringify(status); }
    throw new Error(`unexpected tailscale ${args.join(" ")}`);
  };
}

test("unit: the derived self dial address is never the :443 door (crow / black-swan / funnel shapes)", () => {
  assert.equal(serveUrlForPort(CROW_SERVE, 3001), "https://crow.example.ts.net:8444", "crow: the :8444 Serve for its port, not the Funnel :443");
  assert.equal(serveUrlForPort(CROW_SERVE, 3008), "https://crow.example.ts.net:8449", "r4 on the same host gets ITS Serve port");
  assert.equal(serveUrlForPort(BLACKSWAN_SERVE, 3001), "https://black-swan.example.ts.net", "black-swan: its PRIVATE :443 Serve is a fine browser/HTTP URL");
  assert.equal(serveUrlForPort({ ...BLACKSWAN_SERVE, Web: { ...BLACKSWAN_SERVE.Web, "black-swan.example.ts.net:8460": { Handlers: { "/": { Proxy: "http://127.0.0.1:3001" } } } } }, 3001),
    "https://black-swan.example.ts.net:8460", "a non-443 private Serve is preferred");
  assert.equal(serveUrlForPort(FUNNEL_ON_8444, 3001), null, "a Funnel-enabled host:port is never advertised");

  const env = { CROW_GATEWAY_URL: "https://crow.example.ts.net" };
  const crow = deriveSelfDialAddress({ port: 3001, env, execFileSyncImpl: fakeTailscale({ serve: CROW_SERVE, ip: "100.64.20.1" }) });
  assert.deepEqual(crow, { gateway_url: "https://crow.example.ts.net:8444", tailscale_ip: "100.64.20.1", sync_port: 3001, source: "serve" });
  const bs = deriveSelfDialAddress({ port: 3001, env: { CROW_GATEWAY_URL: "https://black-swan.example.ts.net" }, execFileSyncImpl: fakeTailscale({ serve: BLACKSWAN_SERVE, ip: "100.64.20.3" }) });
  assert.deepEqual(bs, { gateway_url: "https://black-swan.example.ts.net", tailscale_ip: "100.64.20.3", sync_port: 3001, source: "serve" });
  const bare = deriveSelfDialAddress({ port: 3009, env: {}, execFileSyncImpl: fakeTailscale({ serve: null, ip: "100.64.20.4" }) });
  assert.deepEqual(bare, { gateway_url: "http://100.64.20.4:3009", tailscale_ip: "100.64.20.4", sync_port: 3009, source: "tailnet-ip" }, "no Serve → the direct backend");
  const pinned = deriveSelfDialAddress({ port: 3001, env, configuredUrl: "https://pin.example.ts.net:9000", execFileSyncImpl: fakeTailscale({ serve: CROW_SERVE }) });
  assert.equal(pinned.gateway_url, "https://pin.example.ts.net:9000", "CROW_PEER_GATEWAY_URL stays the explicit override");
  assert.equal(deriveSelfDialAddress({ port: 3001, env: {}, execFileSyncImpl: fakeTailscale({ ip: null }) }).gateway_url, null, "no tailnet → nothing advertised");

  assert.equal(isDialableGatewayUrl("https://crow.example.ts.net"), false);
  assert.equal(isDialableGatewayUrl("https://crow.example.ts.net:443"), false);
  assert.equal(isDialableGatewayUrl("http://localhost:3001"), false);
  assert.equal(isDialableGatewayUrl("https://crow.example.ts.net:8444"), true);
  assert.equal(isDialableGatewayUrl("http://100.64.20.3:3001"), true);
  assert.equal(pickPeerGatewayUrl("https://b.example.ts.net", "https://b.example.ts.net:8444/"), "https://b.example.ts.net:8444");
  assert.equal(pickPeerGatewayUrl("http://100.64.0.9:3001", "https://b.example.ts.net:8444"), "http://100.64.0.9:3001");

  const status = {
    Self: { DNSName: "crow.example.ts.net.", TailscaleIPs: ["100.64.20.1", "fd7a:115c:a1e0::1"] },
    Peer: { k: { DNSName: "black-swan.example.ts.net.", TailscaleIPs: ["fd7a:115c:a1e0::2", "100.64.20.3"] } },
  };
  assert.equal(lookupTailnetIpForHost("black-swan.example.ts.net", { status }), "100.64.20.3");
  assert.equal(lookupTailnetIpForHost("BLACK-SWAN.example.ts.net", { status }), "100.64.20.3");
  assert.equal(lookupTailnetIpForHost("nope.example.ts.net", { status }), null);
  assert.equal(lookupTailnetIpForHost("example.com", { status }), null, "only MagicDNS names are looked up");
});

async function withScratchSelf(selfUrl, fn, { tailscaleIp = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sync-self-"));
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  writeFileSync(join(dir, "instance-id"), "self\n");
  const db = await makeRealDb(dir);
  try {
    if (selfUrl !== undefined) {
      await db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, gateway_url, tailscale_ip, status) VALUES ('self', 'me', 'c', ?, ?, 'active')", args: [selfUrl, tailscaleIp] });
    }
    await fn(db);
  } finally {
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("self row: a self row with NO usable address (empty / localhost) is repaired at boot with the derived one; a usable row — even a private :443 Serve URL — is never overwritten", async () => {
  await withScratchSelf("http://localhost:3001", async (db) => {
    await ensureLocalInstanceRegistered(db, { crowId: "c", gatewayUrl: "http://100.64.20.4:3009", tailscaleIp: "100.64.20.4" });
    assert.deepEqual({ ...(await row(db, "self")) }, { gateway_url: "http://100.64.20.4:3009", tailscale_ip: "100.64.20.4" });
  });
  await withScratchSelf("https://black-swan.example.ts.net", async (db) => {
    await ensureLocalInstanceRegistered(db, { crowId: "c", gatewayUrl: "http://100.64.20.3:3001", tailscaleIp: "100.64.20.3" });
    assert.deepEqual({ ...(await row(db, "self")) }, { gateway_url: "https://black-swan.example.ts.net", tailscale_ip: "100.64.20.3" }, "browser URL kept; tailscale_ip filled");
  });
  await withScratchSelf("https://r4.example.ts.net:8448", async (db) => {
    await ensureLocalInstanceRegistered(db, { crowId: "c", gatewayUrl: "http://100.64.0.5:3008" });
    assert.equal((await row(db, "self")).gateway_url, "https://r4.example.ts.net:8448", "usable row kept");
  });
  await withScratchSelf("http://localhost:3001", async (db) => {
    await ensureLocalInstanceRegistered(db, { crowId: "c", gatewayUrl: "http://localhost:3001" });
    assert.equal((await row(db, "self")).gateway_url, "http://localhost:3001", "never 'repaired' to another unusable URL");
  });
});

test("pairing (enroll route + selfPairingAddress) advertises the tailnet dial address, NEVER CROW_GATEWAY_URL, and stores the source's tailscale_ip + port", async () => {
  const saved = { ...process.env };
  process.env.CROW_ENROLL_ENABLED = "1";
  process.env.CROW_GATEWAY_URL = "https://crow.example.ts.net"; // the public Funnel door
  delete process.env.CROW_PEER_GATEWAY_URL;
  process.env.CROW_ENROLL_OTC = "otc-one-xxxxxxxxxxxxxxxxxxxxxxxx"; // mandatory since ENROLL-OTC-OPTIONAL
  delete process.env.CROW_TAILNET_IP;
  process.env.PORT = "3001";
  try {
    await withScratchSelf(undefined, async (db) => {
      // Black-swan's host shape: only a :443 Serve, no self row yet.
      const exec = fakeTailscale({ serve: BLACKSWAN_SERVE, ip: "100.64.20.3" });
      const before = await selfPairingAddress(db, { execFileSyncImpl: exec });
      assert.deepEqual(before, { gateway_url: "https://black-swan.example.ts.net", tailscale_ip: "100.64.20.3", sync_port: 3001 },
        "its private Serve for HTTP + the tailnet IP and port sync will dial");

      // Crow's host shape through the REAL route, over real HTTP.
      const app = express();
      app.use(instanceEnrollRouter(db, { execFileSyncImpl: fakeTailscale({ serve: CROW_SERVE, ip: "100.64.20.1" }) }));
      const srv = createServer(app);
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      try {
        const post = async (body) => {
          const res = await fetch(`http://127.0.0.1:${srv.address().port}/instance/enroll-request`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "100.64.20.3" }, body: JSON.stringify(body), // as Serve forwards it
          });
          return { status: res.status, body: await res.json() };
        };
        let otc = process.env.CROW_ENROLL_OTC;
        const base = { source_instance_id: "peerB", source_name: "B", source_outbound_bearer: "x".repeat(40), shared_signing_key: "k".repeat(40), get otc() { return otc; } };
        // peerB is trusted after the first enroll: every later one needs a
        // fresh single-use code AND the local operator's re-pair allowance.
        const allowRePair = async (n) => {
          otc = `otc-${n}-xxxxxxxxxxxxxxxxxxxxxxxxx`;
          process.env.CROW_ENROLL_OTC = otc;
          await writeRepairAllowance(db, "self", "peerB", { minutes: 5 });
        };
        const r1 = await post({ ...base, source_gateway_url: "http://100.64.20.3:3001", source_tailscale_ip: "100.64.20.3", source_sync_port: 3001 });
        assert.equal(r1.status, 200);
        assert.equal(r1.body.peer_gateway_url, "https://crow.example.ts.net:8444", "the private Serve endpoint, not the Funnel URL");
        assert.notEqual(r1.body.peer_gateway_url, process.env.CROW_GATEWAY_URL);
        assert.equal(r1.body.peer_tailscale_ip, "100.64.20.1");
        assert.equal(r1.body.peer_sync_port, 3001);
        assert.deepEqual({ ...(await row(db, "peerB")) }, { gateway_url: "http://100.64.20.3:3001", tailscale_ip: "100.64.20.3" });
        const port = (await db.execute("SELECT value FROM dashboard_settings_overrides WHERE key = 'tailnet_sync_port:peerB' AND instance_id = 'self'")).rows[0];
        assert.equal(port?.value, "3001", "the source's backend port is remembered");

        // An inbound enroll request for a PINNED peer must leave the
        // challenge-response pin intact — otherwise anyone who can reach the
        // endpoint while enrollment is on could downgrade the peer.
        await db.execute("INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES ('tailnet_sync_cr:peerB', 'self', '1', datetime('now'))");
        await allowRePair(2);
        assert.equal((await post({ ...base, source_gateway_url: "http://100.64.20.3:3001" })).status, 200, "the enroll itself succeeds (pairing semantics unchanged)");
        assert.equal((await db.execute("SELECT value FROM dashboard_settings_overrides WHERE key = 'tailnet_sync_cr:peerB' AND instance_id = 'self'")).rows[0]?.value, "1", "CR pin intact after an inbound enroll");

        // An OLD peer re-pairing with its :443 CROW_GATEWAY_URL never replaces a dialable row.
        await allowRePair(3);
        const r2 = await post({ ...base, source_gateway_url: "https://black-swan.example.ts.net", source_tailscale_ip: "8.8.8.8" });
        assert.equal(r2.status, 200);
        assert.deepEqual({ ...(await row(db, "peerB")) }, { gateway_url: "http://100.64.20.3:3001", tailscale_ip: "100.64.20.3" }, "dialable row kept; non-tailnet IP ignored");
      } finally {
        await new Promise((r) => srv.close(r));
      }
    });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("MUTUAL :443 repair: both rows hold only a :443 URL (no tailscale_ip) — nothing flows; after a restart the boot repair resolves both hosts over the tailnet, the link forms, sync flows both ways, both sides learn the other's port, and the :443 browser URLs are kept", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const tailnet = new Map(); // MagicDNS host → tailnet IP, as tailscaled would answer
  const lookup = async (host) => tailnet.get(host) ?? null;
  // Each side's backend sits on a "standard" port the ladder tries (the
  // fleet's 3001/3002) — here the other side's ephemeral test port.
  const A = await startGateway(fleet, a, { lookupTailnetIp: lookup });
  const B = await startGateway(fleet, b, { lookupTailnetIp: lookup });
  A.ctx.gatewayPort = B.port;
  B.ctx.gatewayPort = A.port;
  A.advertise = { gateway_url: `http://127.0.0.1:${A.port}`, tailscale_ip: "127.0.0.1", sync_port: A.port };
  B.advertise = { gateway_url: `http://127.0.0.1:${B.port}`, tailscale_ip: "127.0.0.1", sync_port: B.port };
  quiet();
  try {
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = 'https://instb.example.ts.net', tailscale_ip = NULL WHERE id = ?", args: [b.id] });
    await b.db.execute({ sql: "UPDATE crow_instances SET gateway_url = 'https://insta.example.ts.net', tailscale_ip = NULL WHERE id = ?", args: [a.id] });

    // Boot 1: tailscaled cannot resolve either host (the pre-fix world).
    await A.startClients();
    await B.startClients();
    await writeAndEmit(a, 3101, "A→B while both rows are :443");
    await writeAndEmit(b, 3201, "B→A while both rows are :443");
    await sleep(A.ctx.fallbackDialAfterMs + 1200);
    assert.ok(unlinked(a, b), "no link either way");
    assert.equal(await hasMemory(b.db, 3101), false);
    assert.equal(await hasMemory(a.db, 3201), false);
    assert.ok(getPeerDialHealth()[b.id]?.missing?.some((m) => /port 443/.test(m)), "A reports B's :443 URL");
    assert.ok(getPeerDialHealth()[a.id]?.missing?.some((m) => /port 443/.test(m)), "B reports A's :443 URL");

    // Boot 2 (gateway restart): the tailnet now knows both hosts.
    A.stopClients(); B.stopClients();
    tailnet.set("insta.example.ts.net", "127.0.0.1");
    tailnet.set("instb.example.ts.net", "127.0.0.1");
    await A.startClients();
    await B.startClients();
    assert.ok(await until(() => linked(a, b), 8000), "link forms after the boot repair");
    assert.ok(await until(() => hasMemory(b.db, 3101)), "stranded A→B arrives");
    assert.ok(await until(() => hasMemory(a.db, 3201)), "stranded B→A arrives");
    // Both rows: tailscale_ip from the repair, the peer's backend port from
    // its signed handshake (both directions — B learned on accept), and the
    // :443 gateway_url kept as the browser/HTTP URL.
    const portOf = async (side, peer) => Number((await side.db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [`tailnet_sync_port:${peer.id}`, side.id] })).rows[0]?.value);
    assert.ok(await until(async () => (await portOf(a, b)) === B.port), "A learned B's port");
    assert.ok(await until(async () => (await portOf(b, a)) === A.port), "B learned A's port");
    assert.deepEqual({ ...(await row(a.db, b.id)) }, { gateway_url: "https://instb.example.ts.net", tailscale_ip: "127.0.0.1" });
    assert.deepEqual({ ...(await row(b.db, a.id)) }, { gateway_url: "https://insta.example.ts.net", tailscale_ip: "127.0.0.1" });
    assert.equal(streams(a, b), 1);

    // Prove B's repaired row is dialable BY B: A stops dialing, B's
    // fallback re-links over the learned tailscale_ip + port.
    A.stopClients();
    assert.ok(await until(() => getPeerDialHealth()[a.id]?.lastAttemptRole === "fallback" && linked(a, b), 8000), "B re-links on its own");
    await writeAndEmit(a, 3102, "A→B over B's dial");
    assert.ok(await until(() => hasMemory(b.db, 3102)));
  } finally {
    loud();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("repairUndialablePeerRows: fills ONLY an empty tailscale_ip, ONLY with a tailnet address, ONLY for :443 rows", async () => {
  const fleet = await makeFleet({ ids: ["instA", "instB"] });
  const { a } = fleet;
  _setAllowLoopbackAddressesForTest(false);
  quiet();
  try {
    await a.db.execute("INSERT INTO crow_instances (id, name, crow_id, status, gateway_url, tailscale_ip) VALUES ('p1','p1','c','active','https://p1.example.ts.net',NULL), ('p2','p2','c','active','https://p2.example.ts.net','100.64.9.9'), ('p3','p3','c','active','https://p3.example.ts.net:8444',NULL), ('p4','p4','c','active','https://p4.example.ts.net',NULL), ('p5','p5','c','revoked','https://p5.example.ts.net',NULL)");
    const answers = { "p1.example.ts.net": "100.64.1.1", "p2.example.ts.net": "100.64.2.2", "p3.example.ts.net": "100.64.3.3", "p4.example.ts.net": "10.0.0.4", "p5.example.ts.net": "100.64.5.5" };
    const repaired = await repairUndialablePeerRows({ db: a.db, instanceSyncManager: a.mgr, lookupTailnetIp: async (h) => answers[h] ?? null });
    assert.deepEqual(repaired, ["p1"]);
    assert.equal((await row(a.db, "p1")).tailscale_ip, "100.64.1.1");
    assert.equal((await row(a.db, "p2")).tailscale_ip, "100.64.9.9", "existing ip kept");
    assert.equal((await row(a.db, "p3")).tailscale_ip, null, "dialable URL left alone");
    assert.equal((await row(a.db, "p4")).tailscale_ip, null, "non-tailnet answer refused");
    assert.equal((await row(a.db, "p5")).tailscale_ip, null, "revoked row untouched");
  } finally {
    _setAllowLoopbackAddressesForTest(true);
    loud();
    await fleet.cleanup();
  }
});

/* ----------------------------------------------------- 2. half-open links */

async function halfOpenScenario(heartbeatMs) {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  // Only A dials (B's fallback disabled), through a relay we can blackhole.
  const A = await startGateway(fleet, a, { heartbeatMs, idleRecheckMs: 40 });
  const B = await startGateway(fleet, b, { heartbeatMs, fallbackDialAfterMs: 3_600_000 });
  const relay = await startBlackholeRelay(B.port);
  await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${relay.port}`, b.id] });
  await A.startClients();
  await B.startClients();
  return { fleet, a, b, A, B, relay };
}

test("HALF-OPEN control (heartbeat OFF): a link whose path silently drops stays 'linked' with nothing flowing — the harness really produces the stuck state", async () => {
  quiet();
  const s = await halfOpenScenario(0);
  try {
    assert.ok(await until(() => linked(s.a, s.b), 5000), "link up");
    await writeAndEmit(s.a, 3301, "before blackhole");
    assert.ok(await until(() => hasMemory(s.b.db, 3301)), "flows before the blackhole");
    s.relay.blackhole();
    await writeAndEmit(s.a, 3302, "after blackhole");
    await sleep(1500);
    assert.ok(linked(s.a, s.b), "both sides still believe the link is up");
    assert.equal(await hasMemory(s.b.db, 3302), false, "nothing flows");
    assert.equal(s.relay.accepted, 1, "and nobody re-dials");
  } finally {
    loud();
    await s.A.close(); await s.B.close(); await s.relay.close(); await s.fleet.cleanup();
  }
});

test("HALF-OPEN (heartbeat ON): the missed pong terminates the silent link on both ends, the dialer re-dials, and the write made during the outage arrives", async () => {
  quiet();
  const s = await halfOpenScenario(150);
  try {
    assert.ok(await until(() => linked(s.a, s.b), 5000), "link up");
    await writeAndEmit(s.a, 3401, "before blackhole");
    assert.ok(await until(() => hasMemory(s.b.db, 3401)), "flows before the blackhole");
    // Steady state: heartbeats keep a HEALTHY link up across many intervals.
    await sleep(700);
    assert.equal(s.relay.accepted, 1, "a healthy link is not torn down by the heartbeat");
    s.relay.blackhole();
    await writeAndEmit(s.a, 3402, "after blackhole");
    assert.ok(await until(() => /half-open/.test(getPeerDialHealth()[s.b.id]?.lastError || ""), 5000), "A detected the half-open link");
    assert.ok(await until(() => /half-open/.test(getPeerDialHealth()[s.a.id]?.lastError || ""), 5000), "B detected it too (its end is just as dead)");
    assert.ok(await until(() => s.relay.accepted >= 2 && linked(s.a, s.b), 10_000), "A re-dialed and the link is back");
    assert.ok(await until(() => hasMemory(s.b.db, 3402), 8000), "the outage write arrives over the new link");
    assert.equal(streams(s.a, s.b), 1, "the dead stream was dropped, one live stream");
  } finally {
    loud();
    await s.A.close(); await s.B.close(); await s.relay.close(); await s.fleet.cleanup();
  }
});

/* ------------------------------------------------- 3. challenge-response */

/** A hand-driven client connection that records every text frame. */
async function openRaw(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  const frames = [];
  let closeCode = null; let closeReason = "";
  const waiters = [];
  ws.on("message", (d, bin) => {
    if (bin) return;
    frames.push(JSON.parse(d.toString()));
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise((r) => ws.on("close", (c, why) => { closeCode = c; closeReason = String(why || ""); r(); for (const w of waiters.splice(0)) w(); }));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const nextFrame = async (n, ms = 3000) => {
    const t0 = Date.now();
    while (frames.length < n && closeCode === null && Date.now() - t0 < ms) await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    return frames[n - 1];
  };
  return { ws, frames, closed, nextFrame, close: () => ws.terminate(), code: () => closeCode, reason: () => closeReason };
}

function hello(identity, asId, { cr = true, nonce = randomBytes(16).toString("hex") } = {}) {
  const h = { instance_id: asId, nonce_hex: nonce, sig_hex: sign(`${asId}:${nonce}`, identity.ed25519Priv) };
  if (cr) h.cr = 1;
  return h;
}

test("CR, server side: a REPLAYED client hello (plus its old proof) gets no feed key; the downgrade to a CR-less hello is refused once CR was used — each with a positive control", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  const B = await startGateway(fleet, b);
  quiet();
  try {
    // Positive control (legacy, before B has seen CR from A): a CR-less hello
    // IS answered with B's hello AND its feed key — the old protocol works.
    const legacy = await openRaw(B.port);
    legacy.ws.send(JSON.stringify(hello(identity, a.id, { cr: false })));
    const lh = await legacy.nextFrame(1);
    assert.equal(lh?.instance_id, b.id);
    assert.equal(lh.cr_sig, undefined, "no CR offered → none answered");
    assert.ok("feed_key_hex" in (await legacy.nextFrame(2)), "legacy client receives the feed key");
    legacy.close();

    // Genuine CR handshake as A: B's reply is bound to our nonce; our proof
    // over B's nonce unlocks the feed key.
    const h1 = hello(identity, a.id);
    const c1 = await openRaw(B.port);
    c1.ws.send(JSON.stringify(h1));
    const s1 = await c1.nextFrame(1);
    assert.equal(typeof s1.cr_sig, "string", "B answers the challenge");
    assert.equal(c1.frames.length, 1, "no feed key before the proof");
    const proof1 = { cr_proof: sign(`cr-proof:${a.id}:${b.id}:${s1.nonce_hex}:${h1.nonce_hex}`, identity.ed25519Priv) };
    c1.ws.send(JSON.stringify(proof1));
    assert.ok("feed_key_hex" in (await c1.nextFrame(2)), "a valid proof unlocks the feed key");
    c1.close();
    await sleep(100);

    // REPLAY: the exact same hello frame and the old proof, on a new socket.
    const c2 = await openRaw(B.port);
    c2.ws.send(JSON.stringify(h1));
    const s2 = await c2.nextFrame(1);
    assert.notEqual(s2.nonce_hex, s1.nonce_hex, "B challenges with a FRESH nonce");
    c2.ws.send(JSON.stringify(proof1));
    await Promise.race([c2.closed, sleep(3000)]);
    assert.equal(c2.code(), 1008);
    assert.equal(c2.reason(), "bad proof");
    assert.equal(c2.frames.length, 1, "the replayer never receives a feed key");

    // Silence instead of a proof: also no feed key (handshake timeout path
    // is long; just verify nothing arrives promptly).
    const c3 = await openRaw(B.port);
    c3.ws.send(JSON.stringify(h1));
    await c3.nextFrame(1);
    await sleep(500);
    assert.equal(c3.frames.length, 1, "no proof → no feed key");
    c3.close();

    // DOWNGRADE: A has done CR with B, so a CR-less hello as A (a replayed
    // pre-upgrade capture) is refused before ANY frame.
    const c4 = await openRaw(B.port);
    c4.ws.send(JSON.stringify(hello(identity, a.id, { cr: false })));
    await Promise.race([c4.closed, sleep(3000)]);
    assert.equal(c4.code(), 1008);
    assert.equal(c4.reason(), "challenge required");
    assert.equal(c4.frames.length, 0, "nothing at all is sent to a downgraded hello");
  } finally {
    loud();
    await B.close();
    await fleet.cleanup();
  }
});

test("CR, client side: a server that REPLAYS a recorded server hello is refused and never receives the dialer's feed key", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  const B = await startGateway(fleet, b);
  quiet();
  // Record a genuine B hello (with cr_sig bound to some OTHER client nonce).
  const rec = await openRaw(B.port);
  rec.ws.send(JSON.stringify(hello(identity, a.id)));
  const recorded = await rec.nextFrame(1);
  rec.close();
  assert.equal(typeof recorded.cr_sig, "string");
  // An impostor endpoint that answers every hello with the recording.
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  const got = [];
  wss.on("connection", (ws) => {
    ws.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      got.push(m);
      if (m.instance_id) ws.send(JSON.stringify(recorded));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const A = await startGateway(fleet, a);
  try {
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${http.address().port}`, b.id] });
    await A.startClients();
    assert.ok(await until(() => /challenge response invalid/.test(getPeerDialHealth()[b.id]?.lastError || ""), 5000), getPeerDialHealth()[b.id]?.lastError);
    await sleep(200);
    assert.ok(got.some((m) => m.instance_id === a.id && m.cr === 1), "the dialer DID reach the impostor and offered CR");
    assert.ok(!got.some((m) => "feed_key_hex" in m || "cr_proof" in m), "no proof and no feed key leaked to the impostor");
    assert.equal(a.mgr.hasDedicatedStream(b.id), false);

    // Positive control on the same dialer: repoint at the REAL B → links.
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${B.port}`, b.id] });
    await A.clients.__refreshForTest();
    assert.ok(await until(() => linked(a, b), 15_000), "the real B links");
  } finally {
    loud();
    await A.close();
    await B.close();
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => http.close(r));
    await fleet.cleanup();
  }
});

test("CR mixed versions over the real dialer: legacy↔new links both ways; after a CR link, a legacy (downgraded) side is refused", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { legacyHandshake: true }); // old dialer
  const B = await startGateway(fleet, b);                              // new server
  quiet();
  try {
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${B.port}`, b.id] });
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 5000), "old dialer → new server links");
    await writeAndEmit(a, 3501, "legacy dial");
    assert.ok(await until(() => hasMemory(b.db, 3501)));
    A.stopClients();
    assert.ok(await until(() => unlinked(a, b), 5000));

    // New dialer → old server.
    A.ctx.legacyHandshake = false;
    B.ctx.legacyHandshake = true;
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 5000), "new dialer → old server links");
    await writeAndEmit(b, 3502, "to new dialer");
    assert.ok(await until(() => hasMemory(a.db, 3502)));
    A.stopClients();
    assert.ok(await until(() => unlinked(a, b), 5000));

    // Both new: CR completes, both sides store the peer's CR flag.
    B.ctx.legacyHandshake = false;
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 5000), "new ↔ new links with CR");
    const flag = async (side, peer) => (await side.db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [`tailnet_sync_cr:${peer.id}`, side.id] })).rows[0]?.value;
    assert.equal(await flag(a, b), "1");
    assert.equal(await flag(b, a), "1");
    A.stopClients();
    assert.ok(await until(() => unlinked(a, b), 5000));

    // A rolls back to the old protocol: B refuses it (downgrade guard reached
    // through the REAL dialer, not a hand-built frame).
    A.ctx.legacyHandshake = true;
    await A.startClients();
    assert.ok(await until(() => /challenge required/.test(getPeerDialHealth()[b.id]?.lastError || ""), 5000), getPeerDialHealth()[b.id]?.lastError);
    assert.equal(a.mgr.hasDedicatedStream(b.id), false);
  } finally {
    loud();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/* ---------------------------------------------- 4. both sides dial at once */

test("SIMULTANEOUS DIAL: both sides know each other and dial at the same instant (B's fallback grace = 0) — over many rounds there is exactly ONE link, both directions flow, and both sides really dialed", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await startGateway(fleet, a, { idleRecheckMs: 20 });
  const B = await startGateway(fleet, b, { idleRecheckMs: 20, fallbackDialAfterMs: 0 });
  await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${B.port}`, b.id] });
  await b.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${A.port}`, a.id] });
  quiet();
  const ROUNDS = 8;
  let collisions = 0;
  let dialedA = 0;
  try {
    for (let i = 0; i < ROUNDS; i++) {
      const upA0 = A.upgrades; const upB0 = B.upgrades;
      await Promise.all([A.startClients(), B.startClients()]);
      assert.ok(await until(() => linked(a, b), 5000), `round ${i}: link up`);
      await sleep(250); // many idle ticks for a duplicate to appear
      assert.equal(streams(a, b), 1, `round ${i}: exactly one stream on A`);
      assert.equal(streams(b, a), 1, `round ${i}: exactly one stream on B`);
      // Independent evidence (server-side upgrade counters) that BOTH sides dialed.
      const dialsByB = A.upgrades - upA0; // B → A
      const dialsByA = B.upgrades - upB0; // A → B
      if (dialsByA >= 1) dialedA += 1;
      if (dialsByA >= 1 && dialsByB >= 1) collisions += 1;
      await writeAndEmit(a, 3600 + i * 2, `A→B round ${i}`);
      await writeAndEmit(b, 3601 + i * 2, `B→A round ${i}`);
      assert.ok(await until(() => hasMemory(b.db, 3600 + i * 2)), `round ${i}: A→B flows`);
      assert.ok(await until(() => hasMemory(a.db, 3601 + i * 2)), `round ${i}: B→A flows`);
      A.stopClients(); B.stopClients();
      assert.ok(await until(() => unlinked(a, b), 5000), `round ${i}: torn down`);
    }
    // The gate is vacuous unless the two dials really collided: require that
    // B's dial reached A in (nearly) every round, not just once.
    // (Either side may legitimately win a given round — B's 0-grace dial can
    // land before A's dialer exists — so the totals, not each round, carry it.)
    assert.ok(dialedA >= ROUNDS / 2, `A dialed in ${dialedA}/${ROUNDS} rounds`);
    assert.ok(collisions >= ROUNDS / 2, `both sides dialed in ${collisions}/${ROUNDS} rounds`);
  } finally {
    loud();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("CR, client side downgrade: after CR with B, an endpoint answering B's id WITHOUT cr_sig (a recorded pre-upgrade hello) is refused — no proof, no feed key leaks; positive control: before the flag, the same CR-less answer is accepted as an old server", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  // An "old server" endpoint signing as B (we hold the identity in tests):
  // a legacy hello, then a feed-key frame — exactly origin/main's ordering.
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  const got = [];
  wss.on("connection", (ws) => {
    ws.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      got.push(m);
      if (m.instance_id) {
        ws.send(JSON.stringify(hello(identity, b.id, { cr: false })));
        ws.send(JSON.stringify({ feed_key_hex: null }));
      }
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const A = await startGateway(fleet, a);
  quiet();
  try {
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${http.address().port}`, b.id] });
    // Positive control: no flag yet → treated as an old server; A proceeds
    // past the hello and sends its own feed-key frame.
    await A.startClients();
    assert.ok(await until(() => got.some((m) => "feed_key_hex" in m), 5000), "old-server answer accepted before any CR");
    A.stopClients();
    for (const c of wss.clients) c.terminate();
    // The far end closed before any Noise handshake: the stream must not
    // linger as a phantom link (it parked the dialer forever).
    assert.ok(await until(() => !a.mgr.hasDedicatedStream(b.id), 3000), "a socket closed mid-Noise-handshake leaves no phantom link");
    got.length = 0;

    // A has since completed CR with B.
    await a.db.execute({ sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, '1', datetime('now'))", args: [`tailnet_sync_cr:${b.id}`, a.id] });
    _resetPeerDialHealth();
    await A.startClients();
    assert.ok(await until(() => /downgrade refused/.test(getPeerDialHealth()[b.id]?.lastError || ""), 5000), getPeerDialHealth()[b.id]?.lastError);
    await sleep(200);
    assert.ok(got.some((m) => m.instance_id === a.id), "the dialer reached the endpoint");
    assert.ok(!got.some((m) => "feed_key_hex" in m || "cr_proof" in m), "nothing leaked after the downgrade");
  } finally {
    loud();
    await A.close();
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => http.close(r));
    await fleet.cleanup();
  }
});

test("a replayed hello that never proves does NOT park our dialer (inbound 'pending' starts only after the proof)", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  const A = await startGateway(fleet, a);
  const B = await startGateway(fleet, b, { fallbackDialAfterMs: 3_600_000 });
  quiet();
  const raws = [];
  try {
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${B.port}`, b.id] });
    // A captured CR hello "from B", replayed to A and left hanging (the
    // replayer cannot produce the proof). Before the fix this held A's
    // inbound-pending mark for the whole 10 s handshake timeout.
    const h = hello(identity, b.id);
    for (let i = 0; i < 3; i++) {
      const r = await openRaw(A.port);
      r.ws.send(JSON.stringify(h));
      assert.equal(typeof (await r.nextFrame(1))?.cr_sig, "string", "the replay reached the CR wait");
      raws.push(r);
    }
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 3000), "A's elected dial links while the replays hang");
  } finally {
    loud();
    for (const r of raws) r.close();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("Hyperswarm handshake is no signing oracle: it signs only a 32-byte hex challenge — never a tailnet-sync hello or CR message chosen by the caller", async () => {
  const { PeerManager } = await import("../servers/sharing/peer-manager.js");
  const fleet = await makeFleet();
  try {
    const pm = new PeerManager(fleet.identity);
    const run = async (challenge) => {
      const writes = []; let destroyed = false;
      const conn = { write: (d) => writes.push(JSON.parse(String(d))), destroy: () => { destroyed = true; } };
      pm._handleMessage(conn, { type: "challenge", challenge }, Buffer.alloc(32), {}, () => {});
      await sleep(20);
      return { writes, destroyed };
    };
    for (const evil of [`instA:${"ab".repeat(16)}`, `cr-proof:instA:instB:${"cd".repeat(16)}:${"ef".repeat(16)}`, "AB".repeat(32), 42]) {
      const r = await run(evil);
      assert.equal(r.writes.length, 0, `nothing signed for ${String(evil).slice(0, 20)}`);
      assert.equal(r.destroyed, true);
    }
    // Positive control: a genuine challenge is still answered.
    const ok = await run(randomBytes(32).toString("hex"));
    assert.equal(ok.writes[0]?.type, "challenge-response");
    assert.equal(typeof ok.writes[0].signature, "string");
  } finally {
    await fleet.cleanup();
  }
});

test("DOWNGRADE, garbled CR fields: a PINNED peer whose hello carries a malformed `cr` (string, 0, float, null) is refused on the accept side, and a pinned server whose reply carries a malformed `cr_sig` is refused on the dial side; an UNPINNED peer sending the same malformed `cr` is still served as legacy", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b, identity } = fleet;
  const B = await startGateway(fleet, b);
  quiet();
  const bad = ["1", 0, 1.5, null, true, { v: 1 }];
  try {
    // Unpinned control: malformed cr → treated as legacy, gets hello + feed key.
    for (const cr of bad) {
      const c = await openRaw(B.port);
      c.ws.send(JSON.stringify({ ...hello(identity, a.id, { cr: false }), cr }));
      assert.equal((await c.nextFrame(1))?.instance_id, b.id, `unpinned, cr=${JSON.stringify(cr)}: hello`);
      assert.ok("feed_key_hex" in ((await c.nextFrame(2)) || {}), `unpinned, cr=${JSON.stringify(cr)}: legacy feed key`);
      c.close();
    }
    // Pin A on B.
    await b.db.execute({ sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, '1', datetime('now'))", args: [`tailnet_sync_cr:${a.id}`, b.id] });
    for (const cr of bad) {
      const c = await openRaw(B.port);
      c.ws.send(JSON.stringify({ ...hello(identity, a.id, { cr: false }), cr }));
      await Promise.race([c.closed, sleep(3000)]);
      assert.equal(c.code(), 1008, `pinned, cr=${JSON.stringify(cr)}: refused`);
      assert.equal(c.reason(), "challenge required");
      assert.equal(c.frames.length, 0, `pinned, cr=${JSON.stringify(cr)}: nothing sent`);
    }
  } finally {
    loud();
    await B.close();
  }

  // Dial side: A pinned for B; an endpoint answering as B with a garbled cr_sig.
  for (const crSig of [null, "", "zz", 42]) {
    _resetPeerDialHealth();
    const http = createServer();
    const wss = new WebSocketServer({ server: http, path: WS_PATH });
    const got = [];
    wss.on("connection", (ws) => ws.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString()); got.push(m);
      if (m.instance_id) { ws.send(JSON.stringify({ ...hello(identity, b.id, { cr: false }), cr_sig: crSig })); ws.send(JSON.stringify({ feed_key_hex: null })); }
    }));
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    await a.db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, '1', datetime('now'))", args: [`tailnet_sync_cr:${b.id}`, a.id] });
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${http.address().port}`, b.id] });
    const A = await startGateway(fleet, a);
    quiet();
    try {
      await A.startClients();
      assert.ok(await until(() => /challenge response invalid|downgrade refused/.test(getPeerDialHealth()[b.id]?.lastError || ""), 5000), `cr_sig=${JSON.stringify(crSig)}: ${getPeerDialHealth()[b.id]?.lastError}`);
      await sleep(150);
      assert.ok(got.some((m) => m.instance_id === a.id), "reached the endpoint");
      assert.ok(!got.some((m) => "feed_key_hex" in m || "cr_proof" in m), `cr_sig=${JSON.stringify(crSig)}: nothing leaked`);
      assert.equal(a.mgr.hasDedicatedStream(b.id), false);
    } finally {
      loud();
      await A.close();
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => http.close(r));
    }
  }
  await fleet.cleanup();
});
