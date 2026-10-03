/**
 * DIALER-RETRY / BLACKSWAN-TRANSPORT gate (2026-10-03): a peer with no usable
 * dial address is a health condition, a missing address is learned from the
 * peer's SIGNED handshake, and sync resumes once it is — with no restart.
 *
 * Root cause on the fleet: crow (id sorts first, so the elected dialer) had a
 * crow_instances row for black-swan with gateway_url on :443 (never dialed)
 * and tailscale_ip empty. PeerDialer.connect() returned silently and was never
 * scheduled again; black-swan, not elected, waited passively forever. 928
 * entries queued for six weeks with no signal anywhere.
 *
 * Harness: tests/fixtures/sync-fleet.mjs — two REAL InstanceSyncManagers on
 * init-db scratch DBs with real Hypercore feeds, each behind its own REAL
 * http server running setupTailnetSyncServer, each running the REAL
 * startTailnetSyncClients refresh loop. Rows move only over the real
 * WebSocket → Noise → Hypercore path. Every "nothing flows" assertion is
 * paired with a later "it flows" on the SAME fleet and the SAME rows, so a
 * dead harness cannot pass the negative half vacuously.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { makeFleet, until, sleep, hasMemory, writeAndEmit } from "./fixtures/sync-fleet.mjs";
import {
  setupTailnetSyncServer, startTailnetSyncClients, backfillPeerAddress, verifiedAdvertisedAddress,
  _setAllowLoopbackAddressesForTest, describeMissingDialAddress,
} from "../servers/sharing/tailnet-sync.js";
import { sign } from "../servers/sharing/identity.js";
import { getPeerDialHealth, _resetPeerDialHealth } from "../servers/shared/peer-dial-health.js";
import {
  collectHealthSignals, invalidateHealthCache, runHealthNotifyCycle, NO_DIAL_ADDRESS_WARN_MS,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { createNotification } from "../servers/shared/notifications.js";

const QUIET_MS = 1200;
const IDLE_MS = 40;
const FALLBACK_MS = 500;
const WS_PATH = "/api/instance-sync/stream";

// Both "hosts" are 127.0.0.1 here; production rejects loopback advertisements.
before(() => _setAllowLoopbackAddressesForTest(true));
after(() => _setAllowLoopbackAddressesForTest(false));

const realWarn = console.warn;
const realLog = console.log;
function quiet() { if (process.env.TEST_LOUD) return; console.warn = () => {}; console.log = () => {}; }
function loud() { console.warn = realWarn; console.log = realLog; }

/** One gateway: http server + tailnet accept side; clients started later. */
async function gateway(fleet, side) {
  const http = createServer();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;
  const g = {
    side, http, port, clients: null, advertise: null,
    ctx: {
      identity: fleet.identity, instanceSyncManager: side.mgr, db: side.db, gatewayPort: port,
      idleRecheckMs: IDLE_MS, fallbackDialAfterMs: FALLBACK_MS, log: { warn: () => {} },
      // Never ladder onto 3001/3002: on a dev box those are LIVE gateways.
      standardPorts: [],
      selfAddress: async () => g.advertise,
    },
  };
  setupTailnetSyncServer(http, g.ctx);
  // Upgraded sockets leave the http server's connection tracking, so
  // http.close() would wait on a live inbound link forever.
  const upgraded = new Set();
  http.on("upgrade", (_req, socket) => { upgraded.add(socket); socket.once("close", () => upgraded.delete(socket)); });
  g.startClients = async () => { g.clients = await startTailnetSyncClients(g.ctx); };
  g.stopClients = () => { g.clients?.stop(); g.clients = null; };
  g.close = async () => {
    g.stopClients();
    for (const sock of upgraded) sock.destroy();
    http.closeAllConnections?.();
    await new Promise((r) => http.close(r));
  };
  return g;
}

const linked = (a, b) => a.mgr.hasDedicatedStream(b.id) && b.mgr.hasDedicatedStream(a.id);
const unlinked = (a, b) => !a.mgr.hasDedicatedStream(b.id) && !b.mgr.hasDedicatedStream(a.id);

async function row(db, id) {
  return (await db.execute({ sql: "SELECT gateway_url, tailscale_ip FROM crow_instances WHERE id = ?", args: [id] })).rows[0];
}

/** Health issues as the monitor would see them, `aheadMs` in the future. */
async function dialIssues(db, aheadMs = NO_DIAL_ADDRESS_WARN_MS + 60_000) {
  invalidateHealthCache();
  const { issues } = await collectHealthSignals(db, { now: () => Date.now() + aheadMs });
  invalidateHealthCache();
  return issues.filter((i) => i.id.startsWith("peers-dial:"));
}

async function notifyRows(db) {
  return (await db.execute({ sql: "SELECT title, source FROM notifications WHERE source LIKE 'health-monitor:peers-dial:%'", args: [] })).rows;
}

test("ONE-SIDED (black-swan shape): the elected side has a :443 URL and no tailscale_ip — the peer's fallback dial links, the address is learned, and the elected side then dials it itself", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet; // instA < instB → A is the elected dialer
  const A = await gateway(fleet, a);
  const B = await gateway(fleet, b);
  quiet();
  try {
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = 'https://instb.example.ts.net', tailscale_ip = NULL WHERE id = ?", args: [b.id] });
    await b.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${A.port}`, a.id] });
    // A advertises NOTHING — the shape of a peer still on the old code.
    A.advertise = null;
    // B advertises its tailnet IP and its own backend port (signed).
    B.advertise = { gateway_url: "https://instb.example.ts.net:8444", tailscale_ip: "127.0.0.1", sync_port: B.port };

    await A.startClients();
    await B.startClients();

    // Before the fallback grace: no link, and A reports the missing address.
    await sleep(150);
    assert.ok(unlinked(a, b), "no link before the fallback grace");
    const h0 = getPeerDialHealth()[b.id];
    assert.ok(h0?.noAddressSince != null, "A records 'no dial address' for B");
    assert.ok(h0.missing.some((m) => /port 443/.test(m)), `names the :443 URL (${h0.missing})`);
    assert.ok(h0.missing.includes("tailscale_ip is empty"));
    const issues0 = await dialIssues(a.db);
    assert.equal(issues0.length, 1);
    assert.equal(issues0[0].id, `peers-dial:${b.id}`);
    assert.match(issues0[0].label, /instB/);
    assert.match(issues0[0].label, /tailscale_ip is empty/);
    assert.equal((await dialIssues(a.db, 0)).length, 0, "no warn inside the boot grace");

    // Writes made while there is no transport.
    await writeAndEmit(a, 1101, "A→B while unreachable");
    await writeAndEmit(b, 2101, "B→A while unreachable");

    // B (not elected) dials as a fallback after the grace; sync resumes.
    assert.ok(await until(() => linked(a, b), 8000), "fallback link comes up");
    await sleep(300);
    assert.equal(a.mgr._activeStreams.get(b.id)?.size, 1, "exactly one link (no duplicate from the elected side)");
    assert.equal(getPeerDialHealth()[a.id]?.lastAttemptRole, "fallback", "the link is B's fallback dial");
    assert.ok(await until(() => hasMemory(b.db, 1101)), "A→B flows after the link");
    assert.ok(await until(() => hasMemory(a.db, 2101)), "B→A flows after the link");

    // A learned B's tailscale_ip from B's signed handshake; the operator-set
    // gateway_url is NOT overwritten.
    const ra = await row(a.db, b.id);
    assert.equal(ra.tailscale_ip, "127.0.0.1");
    assert.equal(ra.gateway_url, "https://instb.example.ts.net");
    const portRow = (await a.db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [`tailnet_sync_port:${b.id}`, a.id] })).rows[0];
    assert.equal(Number(portRow?.value), B.port, "B's backend port learned (local override, never synced)");
    assert.equal(getPeerDialHealth()[b.id].noAddressSince, null, "health condition cleared");
    assert.equal((await dialIssues(a.db)).length, 0, "no warn once linked");

    // Prove A can now reach B BY ITSELF with the learned address: B stops
    // dialing entirely, the link drops, and A (elected) re-establishes it.
    // (A re-dials within one idle tick, so the brief unlinked gap is not
    // asserted — the direction flip from inbound to outbound proves it.)
    assert.equal(getPeerDialHealth()[b.id].linkDirection, "inbound");
    B.stopClients();
    assert.ok(await until(() => getPeerDialHealth()[b.id]?.linkDirection === "outbound" && linked(a, b), 8000), "A re-dials B on the learned address");
    const h1 = getPeerDialHealth()[b.id];
    assert.equal(h1.linkDirection, "outbound");
    assert.ok(h1.lastAttemptUrl.includes(`127.0.0.1:${B.port}`), h1.lastAttemptUrl);
    await writeAndEmit(a, 1102, "A→B over A's own dial");
    await writeAndEmit(b, 2102, "B→A over A's own dial");
    assert.ok(await until(() => hasMemory(b.db, 1102)));
    assert.ok(await until(() => hasMemory(a.db, 2102)));
  } finally {
    loud();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("MUTUAL: neither side has the other's address — both raise the health notification and nothing flows; once ONE side learns it (no restart) sync resumes both ways and the other side backfills", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await gateway(fleet, a);
  const B = await gateway(fleet, b);
  quiet();
  try {
    // Fixture rows: gateway_url NULL, tailscale_ip NULL on both sides.
    A.advertise = { gateway_url: `http://127.0.0.1:${A.port}` };
    B.advertise = { gateway_url: `http://127.0.0.1:${B.port}` };
    await A.startClients();
    await B.startClients();

    await writeAndEmit(a, 1201, "A→B while neither knows the other");
    await writeAndEmit(b, 2201, "B→A while neither knows the other");
    // Well past the fallback grace and many idle re-checks.
    await sleep(FALLBACK_MS + QUIET_MS);
    assert.ok(unlinked(a, b), "no link either way");
    assert.equal(await hasMemory(b.db, 1201), false, "nothing reached B");
    assert.equal(await hasMemory(a.db, 2201), false, "nothing reached A");

    // Both sides raise it, and the monitor's notify path really notifies.
    for (const [side, peer] of [[a, b], [b, a]]) {
      const issues = await dialIssues(side.db);
      assert.deepEqual(issues.map((i) => i.id), [`peers-dial:${peer.id}`]);
      assert.match(issues[0].label, new RegExp(peer.id));
      assert.match(issues[0].label, /gateway_url is empty/);
      const cycle = await runHealthNotifyCycle({
        issues, lastMap: {}, nowMs: Date.now(),
        notify: (issue) => createNotification(side.db, { type: "system", source: `health-monitor:${issue.id}`, priority: "high", title: issue.label }),
      });
      assert.deepEqual(cycle.pushed, [`peers-dial:${peer.id}`]);
      const rows = await notifyRows(side.db);
      assert.equal(rows.length, 1);
      assert.match(rows[0].title, new RegExp(peer.id));
    }

    // The operator fixes ONE side only (A's row for B) — the running dialer
    // picks it up on the next refresh, no restart.
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${B.port}`, b.id] });
    await A.clients.__refreshForTest();
    assert.ok(await until(() => linked(a, b), 5000), "link up after the address is learned");
    assert.ok(await until(() => hasMemory(b.db, 1201)), "the stranded A→B write arrives");
    assert.ok(await until(() => hasMemory(a.db, 2201)), "the stranded B→A write arrives");

    // B learned A's address from A's signed handshake.
    assert.equal((await row(b.db, a.id)).gateway_url, `http://127.0.0.1:${A.port}`);
    assert.equal(getPeerDialHealth()[a.id].backfilled.fields.join(), "gateway_url");
    assert.equal((await dialIssues(a.db)).length, 0, "A's warning cleared");
    assert.equal((await dialIssues(b.db)).length, 0, "B's warning cleared");

    // Prove B's LEARNED address is usable: A stops dialing; B's fallback
    // dial (after the grace) re-links on the backfilled URL.
    assert.equal(getPeerDialHealth()[a.id].linkDirection, "inbound", "B's side of A's outbound link");
    A.stopClients();
    assert.ok(await until(() => getPeerDialHealth()[a.id]?.linkDirection === "outbound" && linked(a, b), 8000), "B re-links via the learned address");
    assert.equal(getPeerDialHealth()[a.id].lastAttemptRole, "fallback");
    await writeAndEmit(a, 1202, "A→B over B's fallback dial");
    await writeAndEmit(b, 2202, "B→A over B's fallback dial");
    assert.ok(await until(() => hasMemory(b.db, 1202)));
    assert.ok(await until(() => hasMemory(a.db, 2202)));
  } finally {
    loud();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

/** Drive the accept side by hand: a raw client handshake as `asId`. */
async function rawHandshake(port, identity, asId, { addr = null, addrSigOverride = null } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  const frames = [];
  let closeCode = null;
  ws.on("message", (d, bin) => { if (!bin) frames.push(JSON.parse(d.toString())); });
  const closed = new Promise((r) => ws.on("close", (c) => { closeCode = c; r(); }));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const nonce = randomBytes(16).toString("hex");
  const hs = { instance_id: asId, nonce_hex: nonce, sig_hex: sign(`${asId}:${nonce}`, identity.ed25519Priv) };
  if (addr) {
    const canon = JSON.stringify({ gateway_url: addr.gateway_url ?? null, tailscale_ip: addr.tailscale_ip ?? null, sync_port: addr.sync_port ?? null });
    hs.addr = addr;
    hs.addr_sig = addrSigOverride ?? sign(`addr:${asId}:${nonce}:${canon}`, identity.ed25519Priv);
  }
  ws.send(JSON.stringify(hs));
  await sleep(300);
  return { ws, frames, closed, closeCode: () => closeCode, nonce, hs };
}

test("only SIGNED peer data is learned: a tampered address block is ignored; a correctly signed one fills ONLY empty columns", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const B = await gateway(fleet, b);
  quiet();
  try {
    // Tampered: signature over a DIFFERENT address than the one sent.
    const otherCanon = JSON.stringify({ gateway_url: "https://evil.example.ts.net:8444", tailscale_ip: null, sync_port: null });
    const bad = await rawHandshake(B.port, fleet.identity, a.id, {
      addr: { gateway_url: "https://a1.example.ts.net:8444", tailscale_ip: "100.64.1.2" },
      addrSigOverride: sign(`addr:${a.id}:deadbeef:${otherCanon}`, fleet.identity.ed25519Priv),
    });
    bad.ws.terminate();
    assert.deepEqual(await row(b.db, a.id), { gateway_url: null, tailscale_ip: null }, "tampered address never written");

    // Correctly signed but NOT tailnet (RFC1918, metadata, public): never written.
    const offnet = await rawHandshake(B.port, fleet.identity, a.id, { addr: { gateway_url: "http://169.254.169.254:80", tailscale_ip: "10.9.9.9" } });
    offnet.ws.terminate();
    const offnet2 = await rawHandshake(B.port, fleet.identity, a.id, { addr: { gateway_url: "https://example.com:8444", tailscale_ip: "8.8.8.8" } });
    offnet2.ws.terminate();
    assert.deepEqual(await row(b.db, a.id), { gateway_url: null, tailscale_ip: null }, "non-tailnet addresses never written");

    // Positive control on the same rows: a correctly signed tailnet block IS learned.
    const good = await rawHandshake(B.port, fleet.identity, a.id, { addr: { gateway_url: "https://a1.example.ts.net:8444", tailscale_ip: "100.64.1.2" } });
    good.ws.terminate();
    assert.deepEqual(await row(b.db, a.id), { gateway_url: "https://a1.example.ts.net:8444", tailscale_ip: "100.64.1.2" });

    // Never overwrites: a later signed advertisement of a different address.
    const later = await rawHandshake(B.port, fleet.identity, a.id, { addr: { gateway_url: "https://a2.example.ts.net:8444", tailscale_ip: "100.64.9.9" } });
    later.ws.terminate();
    assert.deepEqual(await row(b.db, a.id), { gateway_url: "https://a1.example.ts.net:8444", tailscale_ip: "100.64.1.2" });

    // An UNPAIRED instance with the identity learns nothing: no reply handshake.
    const stranger = await rawHandshake(B.port, fleet.identity, "instZ");
    await Promise.race([stranger.closed, sleep(2000)]);
    assert.equal(stranger.frames.length, 0, "no handshake (and no address) sent to an unknown peer");
    assert.equal(stranger.closeCode(), 1008);
  } finally {
    loud();
    await B.close();
    await fleet.cleanup();
  }
});

test("accept side refuses a FALLBACK dial (from the higher id) while a tailnet link is already up — one link per pair", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const A = await gateway(fleet, a);
  const B = await gateway(fleet, b);
  quiet();
  try {
    await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${B.port}`, b.id] });
    await A.startClients();
    assert.ok(await until(() => linked(a, b), 5000), "elected link up");
    // B (higher id) dials A by hand while the link is up.
    const dup = await rawHandshake(A.port, fleet.identity, b.id);
    await Promise.race([dup.closed, sleep(2000)]);
    assert.equal(dup.closeCode(), 1013, "refused with 1013 already linked");
    assert.equal(a.mgr._activeStreams.get(b.id)?.size, 1, "still exactly one stream on A");
  } finally {
    loud();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("unit: verifiedAdvertisedAddress rejects a block spliced from another nonce, loopback in production mode, and :443 URLs", async () => {
  const fleet = await makeFleet();
  try {
    const { identity } = fleet;
    const mk = (nonce, addr, signNonce = nonce) => {
      const canon = JSON.stringify({ gateway_url: addr.gateway_url ?? null, tailscale_ip: addr.tailscale_ip ?? null, sync_port: addr.sync_port ?? null });
      return { instance_id: "instA", nonce_hex: nonce, addr, addr_sig: sign(`addr:instA:${signNonce}:${canon}`, identity.ed25519Priv) };
    };
    const addr = { gateway_url: "https://a.example.ts.net:8444", tailscale_ip: "100.64.0.7" };
    assert.deepEqual(verifiedAdvertisedAddress(mk("n1", addr), identity.ed25519Pubkey), addr);
    assert.equal(verifiedAdvertisedAddress(mk("n2", addr, "n1"), identity.ed25519Pubkey), null, "spliced from another connection");
    assert.equal(verifiedAdvertisedAddress({ ...mk("n1", addr), addr_sig: "zz" }, identity.ed25519Pubkey), null, "garbage sig");
    assert.equal(verifiedAdvertisedAddress(mk("n1", { gateway_url: "http://10.0.0.21:3002", tailscale_ip: "192.168.1.5" }), identity.ed25519Pubkey), null, "LAN addresses are not tailnet");
    assert.deepEqual(verifiedAdvertisedAddress(mk("n1", { tailscale_ip: "fd7a:115c:a1e0::1", sync_port: 3009 }), identity.ed25519Pubkey), { tailscale_ip: "fd7a:115c:a1e0::1", sync_port: 3009 });
    assert.deepEqual(
      verifiedAdvertisedAddress(mk("n1", { gateway_url: "https://a.example.ts.net", tailscale_ip: "100.64.0.7" }), identity.ed25519Pubkey),
      { tailscale_ip: "100.64.0.7" }, ":443 URL is not a dial address",
    );
    _setAllowLoopbackAddressesForTest(false);
    try {
      assert.equal(verifiedAdvertisedAddress(mk("n1", { gateway_url: "http://127.0.0.1:3001", tailscale_ip: "127.0.0.1" }), identity.ed25519Pubkey), null);
    } finally {
      _setAllowLoopbackAddressesForTest(true);
    }
    assert.deepEqual(describeMissingDialAddress({ gateway_url: null, tailscale_ip: null }), ["gateway_url is empty", "tailscale_ip is empty"]);
    // backfillPeerAddress refuses a revoked row.
    await fleet.a.db.execute({ sql: "UPDATE crow_instances SET status = 'revoked' WHERE id = ?", args: [fleet.b.id] });
    const w = await backfillPeerAddress({ db: fleet.a.db }, fleet.b.id, { tailscale_ip: "100.64.0.9" });
    assert.deepEqual(w, {});
  } finally {
    await fleet.cleanup();
  }
});

test("Instances page: the Sync link cell shows link / no-address / last attempt + error, escaped", async () => {
  const { renderSyncLinkCell } = await import("../servers/gateway/dashboard/settings/sections/paired-instances.js");
  const t0 = Date.UTC(2026, 9, 3, 12, 0);
  const noAddr = renderSyncLinkCell({ noAddressSince: t0, missing: ["tailscale_ip is empty", "<script>"], lastAttemptAt: null, lastError: null, linkedAt: null, linkClosedAt: null }, "en");
  assert.match(noAddr, /no dial address since 2026-10-03 12:00: tailscale_ip is empty; &lt;script&gt;/);
  const err = renderSyncLinkCell({ lastAttemptAt: t0, lastAttemptUrl: "wss://b.example.ts.net:8444/x", lastError: "ECONNREFUSED", lastErrorAt: t0, linkedAt: null, linkClosedAt: null }, "en");
  assert.match(err, /last dial 2026-10-03 12:00 → wss:\/\/b\.example\.ts\.net:8444\/x/);
  assert.match(err, /last error 2026-10-03 12:00: ECONNREFUSED/);
  const up = renderSyncLinkCell({ linkedAt: t0, linkDirection: "inbound", linkClosedAt: null, lastError: "old", lastErrorAt: t0 - 1000, backfilled: { fields: ["tailscale_ip"] } }, "en");
  assert.match(up, /linked \(inbound\) since 2026-10-03 12:00/);
  assert.doesNotMatch(up, /last error/, "an error older than the live link is not shown");
  assert.match(up, /learned tailscale_ip from its signed handshake/);
  assert.match(renderSyncLinkCell(undefined, "en"), /no dial attempt yet/);
});

test("the dialer refuses an instance that answers for ANOTHER peer (no silent adoption)", async () => {
  _resetPeerDialHealth();
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const B = await gateway(fleet, b);
  const A = await gateway(fleet, a);
  quiet();
  try {
    // A believes "instC" lives at B's address (a co-hosted mix-up).
    await a.db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, status, trusted, gateway_url) VALUES ('instC', 'instC', ?, 'active', 1, ?)", args: ["crow:fleet-test", `http://127.0.0.1:${B.port}`] });
    await A.startClients();
    assert.ok(await until(() => /different instance/.test(getPeerDialHealth().instC?.lastError || ""), 5000), "failure recorded for instC");
    await sleep(200);
    assert.equal(a.mgr.hasDedicatedStream("instB"), false, "B was not adopted under instC's dial");
    assert.equal(a.mgr.hasDedicatedStream("instC"), false);
  } finally {
    loud();
    await A.close();
    await B.close();
    await fleet.cleanup();
  }
});

test("health: a peer with dial candidates whose every dial fails, with no link, also warns (after the grace and a minimum of attempts)", async () => {
  _resetPeerDialHealth();
  const { recordDialFailure, recordLinkUp } = await import("../servers/shared/peer-dial-health.js");
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    for (let i = 0; i < 4; i++) recordDialFailure(b.id, "ws://100.64.0.9:3002: ECONNREFUSED");
    assert.equal((await dialIssues(a.db, 31 * 60_000)).length, 0, "below the attempt floor");
    recordDialFailure(b.id, "ws://100.64.0.9:3002: ECONNREFUSED");
    assert.equal((await dialIssues(a.db, 5 * 60_000)).length, 0, "inside the grace");
    const issues = await dialIssues(a.db, 31 * 60_000);
    assert.equal(issues.length, 1);
    assert.match(issues[0].label, /every dial has failed for 3\d min \(last error: ws:\/\/100\.64\.0\.9:3002: ECONNREFUSED\)/);
    recordLinkUp(b.id, { direction: "outbound" });
    assert.equal((await dialIssues(a.db, 31 * 60_000)).length, 0, "a link clears it");
  } finally {
    await fleet.cleanup();
  }
});
