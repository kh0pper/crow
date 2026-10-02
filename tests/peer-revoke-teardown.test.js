/**
 * Revoke must stop sync — through the REAL replication path, in both
 * directions (review C1 + I2, 2026-10-02).
 *
 * Harness: tests/fixtures/sync-fleet.mjs — two real InstanceSyncManagers on
 * init-db scratch DBs, real Hypercore feeds, a real NoiseSecretStream link.
 * Every "nothing flows" assertion is preceded by a baseline proving the same
 * link DOES carry rows, so a silent no-flow can't pass vacuously.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  makeFleet, linkPeers, armAndPair, addPeerRow, until, sleep, hasMemory, writeAndEmit, SHARED_CROW_ID,
} from "./fixtures/sync-fleet.mjs";
import { revokePeer, _setSyncManagerResolverForTest } from "../servers/sharing/revoke-peer.js";
import { revokeInstance } from "../servers/gateway/instance-registry.js";
import { handleInstanceConnection } from "../servers/sharing/instance-connect.js";
import { setupTailnetSyncServer, PeerDialer } from "../servers/sharing/tailnet-sync.js";

// A quiet window several times the baseline delivery latency (which is
// tens of ms on loopback) — long enough that "nothing arrived" means it.
const QUIET_MS = 1500;

// getOrCreateLocalInstanceId (dashboard self-check) reads CROW_DATA_DIR.
const iidDir = mkdtempSync(join(tmpdir(), "revoke-iid-"));
writeFileSync(join(iidDir, "instance-id"), "instA\n");
const prevDataDir = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = iidDir;
after(() => {
  if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevDataDir;
  rmSync(iidDir, { recursive: true, force: true });
  _setSyncManagerResolverForTest(null);
});

async function baseline(fleet) {
  await writeAndEmit(fleet.a, 1001, "A→B before revoke");
  await writeAndEmit(fleet.b, 2001, "B→A before revoke");
  assert.ok(await until(() => hasMemory(fleet.b.db, 1001)), "baseline: A→B flows");
  assert.ok(await until(() => hasMemory(fleet.a.db, 2001)), "baseline: B→A flows");
}

test("C1: the dashboard Revoke tears down sync — A's writes stop reaching B and B's stop applying on A", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    link = await linkPeers(fleet.a, fleet.b);
    await baseline(fleet);

    _setSyncManagerResolverForTest(() => fleet.a.mgr);
    const { default: section } = await import("../servers/gateway/dashboard/settings/sections/paired-instances.js");
    let redirected = null;
    await section.handleAction({
      req: { body: { instance_id: fleet.b.id } },
      res: { redirectAfterPost: (u) => { redirected = u; } },
      db: fleet.a.db, action: "revoke_instance",
    });
    assert.match(redirected, /revoked=1/);
    assert.equal(fleet.a.mgr.outFeeds.has(fleet.b.id), false, "A's out-feed to B is closed");
    assert.equal(fleet.a.mgr.inFeeds.has(fleet.b.id), false, "A's in-feed from B is closed");

    // B keeps writing; A keeps writing.
    await writeAndEmit(fleet.a, 1002, "A after revoke");
    await writeAndEmit(fleet.b, 2002, "B after revoke");
    await sleep(QUIET_MS);
    assert.equal(await hasMemory(fleet.b.db, 1002), false, "nothing A writes reaches B");
    assert.equal(await hasMemory(fleet.a.db, 2002), false, "nothing B writes is applied on A");
  } finally {
    _setSyncManagerResolverForTest(null);
    link?.close();
    await fleet.cleanup();
  }
});

test("MUTUAL: A revokes B while B revokes A, both still writing — nothing flows either way", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    link = await linkPeers(fleet.a, fleet.b);
    await baseline(fleet);

    const writes = (async () => {
      for (let i = 0; i < 5; i++) {
        await writeAndEmit(fleet.a, 1100 + i, `A mutual ${i}`);
        await writeAndEmit(fleet.b, 2100 + i, `B mutual ${i}`);
        await sleep(20);
      }
    })();
    const [ra, rb] = await Promise.all([
      revokePeer(fleet.a.db, fleet.b.id, { instanceSyncManager: fleet.a.mgr }),
      revokePeer(fleet.b.db, fleet.a.id, { instanceSyncManager: fleet.b.mgr }),
    ]);
    await writes;
    assert.equal(ra.ok && rb.ok, true);

    // Writes made after both revokes landed.
    await writeAndEmit(fleet.a, 1200, "A after mutual revoke");
    await writeAndEmit(fleet.b, 2200, "B after mutual revoke");
    await sleep(QUIET_MS);
    assert.equal(await hasMemory(fleet.b.db, 1200), false);
    assert.equal(await hasMemory(fleet.a.db, 2200), false);
    const st = async (db, id) => (await db.execute({ sql: "SELECT status FROM crow_instances WHERE id = ?", args: [id] })).rows[0].status;
    assert.equal(await st(fleet.a.db, fleet.b.id), "revoked");
    assert.equal(await st(fleet.b.db, fleet.a.id), "revoked");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

test("cross-process revoke (row only, feeds still open — the stdio MCP door): the status row alone blocks both directions", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    link = await linkPeers(fleet.a, fleet.b);
    await baseline(fleet);

    await revokeInstance(fleet.a.db, fleet.b.id); // no teardown: another process did this
    assert.equal(fleet.a.mgr.outFeeds.has(fleet.b.id), true, "feeds deliberately left open");

    await writeAndEmit(fleet.a, 1300, "A after row-only revoke");
    await writeAndEmit(fleet.b, 2300, "B after row-only revoke");
    await sleep(QUIET_MS);
    assert.equal(await hasMemory(fleet.b.db, 1300), false, "emitChange never targets a revoked peer");
    assert.equal(await hasMemory(fleet.a.db, 2300), false, "a revoked peer's entries are never applied");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

// ── Hyperswarm connect handler (the function boot.js's onInstanceConnected calls) ──

test("connect handler: an advertised instance replicates only itself; a revoked sibling is never carried", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    await addPeerRow(a.db, "instC-revoked", { status: "revoked" });
    await addPeerRow(a.db, "instD-sibling", { status: "active" });
    // Both sides' rows share SHARED_CROW_ID with the peer rows from makeFleet.
    link = await armAndPair(a, b);
    const replicatedOnA = [];
    const realReplicate = a.mgr.replicate.bind(a.mgr);
    a.mgr.replicate = async (id, stream, opts) => { replicatedOnA.push(id); return realReplicate(id, stream, opts); };

    const onA = await handleInstanceConnection({ db: a.db, instanceSyncManager: a.mgr, crowId: SHARED_CROW_ID, conn: link.nsA, remoteInstanceId: b.id });
    await handleInstanceConnection({ db: b.db, instanceSyncManager: b.mgr, crowId: SHARED_CROW_ID, conn: link.nsB, remoteInstanceId: a.id });
    assert.deepEqual(onA, [b.id]);
    assert.deepEqual(replicatedOnA, [b.id], "no sibling feed rides B's connection");
    assert.equal(a.mgr.outFeeds.has("instC-revoked"), false, "the revoked sibling's feed is never armed");

    const rowsA = Object.fromEntries((await a.db.execute("SELECT id, status, last_seen_at FROM crow_instances")).rows.map((r) => [r.id, r]));
    assert.equal(rowsA["instC-revoked"].status, "revoked");
    assert.equal(rowsA["instC-revoked"].last_seen_at, "2000-01-01 00:00:00");
    assert.equal(rowsA["instD-sibling"].last_seen_at, "2000-01-01 00:00:00", "the sibling is not marked seen by B's connection");
    assert.notEqual(rowsA[b.id].last_seen_at, "2000-01-01 00:00:00");

    // The handler's real replication carries rows.
    await writeAndEmit(a, 1400, "via connect handler");
    assert.ok(await until(() => hasMemory(b.db, 1400)), "rows flow over the handler-wired connection");
  } finally {
    link?.close();
    await fleet.cleanup();
  }
});

test("connect handler: an advertised REVOKED instance gets nothing; an older peer (no instance_id) gets only live rows", async () => {
  const fleet = await makeFleet();
  try {
    const { a } = fleet;
    await addPeerRow(a.db, "instC-revoked", { status: "revoked" });
    await addPeerRow(a.db, "instD-sibling", { status: "active" });
    const seen = [];
    const fakeMgr = {
      localInstanceId: a.id,
      initInstance: async () => {},
      replicate: async (id) => { seen.push(id); },
    };
    assert.deepEqual(await handleInstanceConnection({ db: a.db, instanceSyncManager: fakeMgr, crowId: SHARED_CROW_ID, conn: {}, remoteInstanceId: "instC-revoked" }), []);
    const { rows } = await a.db.execute("SELECT status FROM crow_instances WHERE id = 'instC-revoked'");
    assert.equal(rows[0].status, "revoked");
    const legacy = await handleInstanceConnection({ db: a.db, instanceSyncManager: fakeMgr, crowId: SHARED_CROW_ID, conn: {} });
    assert.deepEqual(legacy.sort(), ["instB", "instD-sibling"]);
  } finally {
    await fleet.cleanup();
  }
});

// ── tailnet-sync: real WebSocket server + dialer ──

test("tailnet-sync: revoke destroys the dedicated socket, a redial is refused, and nothing flows either way (mutual)", async () => {
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const http = createServer();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;
  const quietLog = { warn: () => {} };
  setupTailnetSyncServer(http, { identity: fleet.identity, instanceSyncManager: b.mgr, db: b.db, log: quietLog });
  await a.db.execute({ sql: "UPDATE crow_instances SET gateway_url = ? WHERE id = ?", args: [`http://127.0.0.1:${port}`, b.id] });
  const peerRow = (await a.db.execute({ sql: "SELECT * FROM crow_instances WHERE id = ?", args: [b.id] })).rows[0];
  const dialer = new PeerDialer(peerRow, { identity: fleet.identity, instanceSyncManager: a.mgr, db: a.db, gatewayPort: port });
  const warn = console.warn; const log = console.log;
  console.warn = () => {}; console.log = () => {};
  try {
    dialer.start ? dialer.start() : dialer.connect();
    assert.ok(await until(() => a.mgr._activeStreams.has(b.id) && b.mgr._activeStreams.has(a.id)), "tailnet link up");
    await baseline(fleet);

    const [ra, rb] = await Promise.all([
      revokePeer(a.db, b.id, { instanceSyncManager: a.mgr }),
      revokePeer(b.db, a.id, { instanceSyncManager: b.mgr }),
    ]);
    assert.equal(ra.ok && rb.ok, true);
    assert.equal(a.mgr._activeStreams.has(b.id), false, "A's dedicated stream to B is gone");

    // Force an immediate redial: the client-side live-peer check must refuse
    // before arming any feed for the revoked server.
    dialer.retryMs = 10;
    await dialer.connect();
    await sleep(300);
    assert.equal(a.mgr.outFeeds.has(b.id), false, "a redial never re-arms the revoked peer's feed");

    await writeAndEmit(a, 1500, "A after tailnet revoke");
    await writeAndEmit(b, 2500, "B after tailnet revoke");
    await sleep(QUIET_MS);
    assert.equal(await hasMemory(b.db, 1500), false);
    assert.equal(await hasMemory(a.db, 2500), false);
  } finally {
    dialer.stop();
    console.warn = warn; console.log = log;
    await new Promise((r) => http.close(r));
    http.closeAllConnections?.();
    await fleet.cleanup();
  }
});
