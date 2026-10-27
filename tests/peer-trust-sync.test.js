/**
 * PT-1 distributed-state gates on the real replication path (private
 * engineering notes: peer-trust fix §3 T12, T13): two real init-db scratch
 * DBs, two real InstanceSyncManagers with real Hypercore feeds, replicating
 * over a real NoiseSecretStream socket pair (tests/fixtures/sync-fleet.mjs).
 * Both Hyperswarm and tailnet-sync apply through _processNewEntriesInner, so
 * one fence covers both transports.
 *
 * Every negative assertion follows a positive control on the same link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeFleet, linkPeers, until, sleep, hasMemory, writeAndEmit } from "./fixtures/sync-fleet.mjs";
import { revokePeer } from "../servers/sharing/revoke-peer.js";
import { reactivateOnRepair, getInstance } from "../servers/gateway/instance-registry.js";

const QUIET_MS = 1500;

async function appliedRecord(side, peerId) {
  const { rows } = await side.db.execute({ sql: "SELECT last_applied_seq_per_peer AS b FROM sync_state WHERE instance_id = ?", args: [side.id] });
  return rows[0]?.b ? JSON.parse(rows[0].b)[peerId] ?? null : null;
}

/** Revoke B on A (gateway door: A's manager tears down its feeds), B keeps writing K markers. */
async function revokeAndWriteWhileRevoked(fleet, link, base, K) {
  const { a, b } = fleet;
  const r = await revokePeer(a.db, b.id, { instanceSyncManager: a.mgr });
  assert.equal(r.ok, true);
  link.close();
  for (let i = 0; i < K; i++) await writeAndEmit(b, base + i, `written while revoked ${i}`);
}

/** Re-pair: A reactivates B (fence), both sides re-arm and re-link. */
async function repairAndRelink(fleet) {
  const { a, b } = fleet;
  await reactivateOnRepair(a.db, b.id, { authTokenHash: "ab".repeat(32), localInstanceId: a.id });
  assert.equal((await appliedRecord(a, b.id))?.ff, 1, "fence written with the reactivation");
  return linkPeers(a, b);
}

async function fenceConsumed(a, bId) {
  return until(async () => { const r = await appliedRecord(a, bId); return r && !r.ff; }, 15_000);
}

test("T12: a re-pair does not replay what the peer wrote while revoked; post-fence writes apply", { timeout: 90_000 }, async () => {
  const fleet = await makeFleet();
  const { a, b } = fleet;
  let link;
  const K = 5;
  try {
    link = await linkPeers(a, b);
    await writeAndEmit(b, 9000, "baseline");
    assert.equal(await until(() => hasMemory(a.db, 9000)), true, "positive control: B's write reaches A");

    await revokeAndWriteWhileRevoked(fleet, link, 9100, K);
    link = await repairAndRelink(fleet);
    assert.equal(await fenceConsumed(a, b.id), true, "the fence is consumed once the remote length is known");
    const rec = await appliedRecord(a, b.id);
    assert.ok(rec.s >= K + 1, `fast-forwarded past the revoked window (s=${rec.s})`);

    await writeAndEmit(b, 9200, "after the fence");
    assert.equal(await until(() => hasMemory(a.db, 9200), 10_000), true, "positive control: a post-fence write applies");
    await sleep(QUIET_MS * 2);
    for (let i = 0; i < K; i++) assert.equal(await hasMemory(a.db, 9100 + i), false, `revoked-window write ${i} never applied`);
  } finally { link?.close(); await fleet.cleanup(); }
});

test("T12(a): a DB error in the trust check while the peer is live applies nothing and does not advance the seq", { timeout: 60_000 }, async () => {
  const fleet = await makeFleet();
  const { a, b } = fleet;
  let link;
  try {
    link = await linkPeers(a, b);
    await writeAndEmit(b, 9300, "baseline");
    assert.equal(await until(() => hasMemory(a.db, 9300)), true);
    const before = (await appliedRecord(a, b.id)).s;
    const real = a.mgr.db;
    a.mgr.db = new Proxy(real, {
      get(t, k) {
        if (k === "execute") return async (st) => { if (/FROM crow_instances/.test(st?.sql || "")) throw new Error("database disk image is malformed"); return t.execute(st); };
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await writeAndEmit(b, 9301, "during the DB fault");
    await sleep(QUIET_MS);
    assert.equal(await hasMemory(a.db, 9301), false, "nothing applies while the trust check fails");
    assert.equal((await appliedRecord(a, b.id)).s, before, "the seq did not advance");
    a.mgr.db = real;
    await writeAndEmit(b, 9302, "after recovery");
    assert.equal(await until(() => hasMemory(a.db, 9302), 10_000), true, "recovery: entries apply again");
    assert.equal(await hasMemory(a.db, 9301), true, "the blocked entry was not consumed, so it applies after recovery");
  } finally { link?.close(); await fleet.cleanup(); }
});

test("T12(b): no prior applied-seq record — the revoked-window writes still never apply", { timeout: 90_000 }, async () => {
  const fleet = await makeFleet();
  const { a, b } = fleet;
  let link;
  const K = 3;
  try {
    link = await linkPeers(a, b);
    await writeAndEmit(b, 9400, "baseline");
    assert.equal(await until(() => hasMemory(a.db, 9400)), true);
    await revokeAndWriteWhileRevoked(fleet, link, 9410, K);
    await a.db.execute({ sql: "UPDATE sync_state SET last_applied_seq_per_peer = json_remove(last_applied_seq_per_peer, ?) WHERE instance_id = ?", args: [`$."${b.id}"`, a.id] });
    assert.equal(await appliedRecord(a, b.id), null);
    link = await repairAndRelink(fleet);
    assert.equal(await fenceConsumed(a, b.id), true);
    await writeAndEmit(b, 9420, "after the fence");
    assert.equal(await until(() => hasMemory(a.db, 9420), 10_000), true);
    await sleep(QUIET_MS);
    for (let i = 0; i < K; i++) assert.equal(await hasMemory(a.db, 9410 + i), false);
  } finally { link?.close(); await fleet.cleanup(); }
});

test("T12(c): B rotates its out-feed right after the re-pair — the fence survives, revoked-window writes never apply, post-rotation writes do", { timeout: 90_000 }, async () => {
  const fleet = await makeFleet();
  const { a, b } = fleet;
  let link;
  const K = 3;
  try {
    link = await linkPeers(a, b);
    await writeAndEmit(b, 9500, "baseline");
    assert.equal(await until(() => hasMemory(a.db, 9500)), true);
    await revokeAndWriteWhileRevoked(fleet, link, 9510, K);
    await reactivateOnRepair(a.db, b.id, { authTokenHash: "ab".repeat(32), localInstanceId: a.id });
    // Rotation before the first post-re-pair run: B wipes its out-feed to A and mints a new key.
    await b.mgr.closeInstanceFeeds(a.id);
    rmSync(join(b.mgr.dataDir, a.id, "out"), { recursive: true, force: true });
    await b.mgr.initInstance(a.id, null);
    // The revoked-window entries are re-emitted onto the NEW feed only if B
    // re-sends them; write them again there so a missing fence would show.
    for (let i = 0; i < K; i++) await writeAndEmit(b, 9520 + i, `pre-fence on the new feed ${i}`);
    await a.mgr.initInstance(b.id, b.mgr.getOutFeedKey(a.id)); // A sees a new key: _reconcileAppliedSeqAtOpen
    assert.equal((await appliedRecord(a, b.id))?.ff, 1, "the feed-key change kept the fence");
    link = await linkPeers(a, b);
    assert.equal(await fenceConsumed(a, b.id), true);
    await writeAndEmit(b, 9530, "post-rotation, post-fence");
    assert.equal(await until(() => hasMemory(a.db, 9530), 10_000), true, "positive control: post-rotation writes DO arrive");
    await sleep(QUIET_MS);
    for (let i = 0; i < K; i++) {
      assert.equal(await hasMemory(a.db, 9510 + i), false);
      assert.equal(await hasMemory(a.db, 9520 + i), false);
    }
  } finally { link?.close(); await fleet.cleanup(); }
});

test("T13: a peer cannot change trust or status over sync (a forged crow_instances entry is never applied)", { timeout: 60_000 }, async () => {
  const fleet = await makeFleet();
  const { a, b } = fleet;
  let link;
  try {
    // A also knows a revoked sibling C, and B's own row on A is trusted/active.
    await a.db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, status, trusted) VALUES ('instC', 'C', 'crow:fleet-test', 'revoked', 1)", args: [] });
    link = await linkPeers(a, b);
    await writeAndEmit(b, 9600, "baseline");
    assert.equal(await until(() => hasMemory(a.db, 9600)), true, "positive control: B's entries apply on A");

    // emitChange refuses crow_instances outbound, so forge the entries the way
    // a hostile peer would: signed with the shared identity, appended straight
    // onto B's out-feed toward A.
    const { sign } = await import("../servers/sharing/identity.js");
    const forge = async (row) => {
      const entry = { table: "crow_instances", op: "update", row, lamport_ts: Date.now() * 1000, instance_id: b.id };
      entry.signature = sign(JSON.stringify(entry), fleet.identity.ed25519Priv);
      await b.mgr._appendToPeer(a.id, entry);
    };
    await forge({ id: "instC", name: "C", status: "active", trusted: 1, auth_token_hash: "cd".repeat(32) });
    await forge({ id: b.id, name: "forged", status: "active", trusted: 1, gateway_url: "http://203.0.113.9:1" });
    await writeAndEmit(b, 9601, "after the forgery");
    assert.equal(await until(() => hasMemory(a.db, 9601), 10_000), true, "positive control: entries after the forgery arrive (so the forged ones were processed)");

    const c = await getInstance(a.db, "instC");
    assert.equal(c.status, "revoked", "a revoked sibling stays revoked");
    assert.equal(c.auth_token_hash, null);
    const self = await getInstance(a.db, b.id);
    assert.equal(self.name, b.id, "B's own row is not rewritten by B");
    assert.equal(self.gateway_url, null);
  } finally { link?.close(); await fleet.cleanup(); }
});
