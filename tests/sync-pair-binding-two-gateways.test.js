/**
 * PT-2a multi-instance gate (private engineering notes: sync pair binding,
 * Task 7): REAL gateway processes, paired through the REAL pairing CLI, with
 * instance sync over the real tailnet transport on 127.0.0.1, mixed with an
 * older tree (the pre-PT-2a main, PT3_SHA) where a leg needs one.
 *
 * Every child: scratch home, 127.0.0.1 only (useLoopbackSync), Hyperswarm
 * instance sync off (CROW_INSTANCE_SYNC_HYPERSWARM=0), an isolated loopback
 * DHT with no bootstrap (tests/fixtures/gateway-local-dht.mjs), no Nostr, and
 * a wall-clock cap (the fixture's SIGTERM→SIGKILL stop, plus every test's
 * timeout). Markers are memories written through the real stdio door
 * (writeMarker: the tree's own memory MCP server, queued in sync_outbox) and
 * delivered by the gateway's outbox drain over the sync link.
 *
 * Every negative follows a positive control on the same link. A "blocked"
 * marker is asserted only after the author's drain appended it to the peer's
 * out-feed (markerDrained), so its absence on the peer is the link's doing;
 * where the leg allows, the same marker is then seen to arrive once the link
 * is allowed again.
 *
 * The dashboard rendering of the Nest items is not on this branch, so the
 * Nest state is asserted through the gateway's log lines (decideAndRecordPairBinding
 * logs every refusal, every bound handshake, and the first legacy decision
 * per peer per process).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  REPO, PT3_SHA, SYNC_TIMING, bootPair, pairInto, until, useLoopbackSync, writeMarker, hasMarker, markerDrained, outboxDiag, pairPinned, settingsRevoke,
} from "./fixtures/peer-pair.mjs";
import { oldTree } from "./fixtures/old-tree.mjs";
import { makeRealDb, addPeerRow, writeAndEmit } from "./fixtures/sync-fleet.mjs";
import { startGateway } from "./fixtures/sync-gateway.mjs";
import { PeerDialer } from "../servers/sharing/tailnet-sync.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { deriveInstanceIdentity, loadInstanceSeed } from "../servers/sharing/identity.js";

const T = { timeout: 900_000 };
// A marker waits for the author's outbox drain tick plus the dialer's backoff
// after a refusal. New-tree children run both on SYNC_TIMING; an old-tree
// child drains on it too (tests/fixtures/old-tree-timing.mjs) but keeps
// production's dial backoff (capped at 60 s), which this bound covers.
const FLOW_MS = 180_000;
// How long a drained marker must stay absent on the peer: several drain
// ticks and several capped dial retries of a new-tree child.
const QUIET_MS = 3 * Math.max(SYNC_TIMING.CROW_TEST_SYNC_DRAIN_MS, SYNC_TIMING.CROW_TEST_TAILNET_RETRY_MAX_MS);
const tag = () => randomBytes(4).toString("hex");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const bound = (peerId, side) => new RegExp(`\\[tailnet-sync\\] pair-bound handshake with ${esc(peerId)} \\(${side} side\\)`);
const refused = (peerId, side, reason) => new RegExp(`\\[tailnet-sync\\] pair binding failed for ${esc(peerId)} \\(${side} side\\): ${reason}`);
const legacy = (peerId, side) => new RegExp(`\\[tailnet-sync\\] ${esc(peerId)} syncs without pair binding \\(${side} side`);
const anyRefusal = /\[tailnet-sync\] pair binding failed/;
const anyLegacy = /syncs without pair binding/;
const sinceLog = (inst, from) => inst.log.slice(from);
/** The sync lines of a log (failure messages; the rest of a gateway's boot is noise). */
const syncLines = (text) => text.split("\n").filter((l) => /\[(tailnet-sync|instance-sync|sync-outbox-drain|sync-pair-binding)\]/.test(l)).slice(-40).join("\n");

async function logShows(inst, re, from = 0, ms = FLOW_MS) {
  return until(() => re.test(sinceLog(inst, from)), ms, 250);
}

/** A marker written on `from` reaches `to`. */
async function flows(from, to, label) {
  const text = `pt2a ${label} ${from.name}->${to.name} ${tag()}`;
  await writeMarker(from, text);
  assert.ok(await until(() => hasMarker(to, text), FLOW_MS, 500), `${label}: ${from.name}'s marker never reached ${to.name}\n--- ${from.name}\n${syncLines(from.log)}\n--- ${to.name}\n${syncLines(to.log)}`);
  return text;
}

/** Markers both ways, waited on together (one drain tick each). */
async function flowsBoth(a, b, label) {
  const ta = `pt2a ${label} ${a.name}->${b.name} ${tag()}`;
  const tb = `pt2a ${label} ${b.name}->${a.name} ${tag()}`;
  await writeMarker(a, ta);
  await writeMarker(b, tb);
  assert.ok(await until(() => hasMarker(b, ta) && hasMarker(a, tb), FLOW_MS, 500),
    `${label}: markers did not flow both ways (a->b ${hasMarker(b, ta)}, b->a ${hasMarker(a, tb)})\n--- ${a.name}\n${syncLines(a.log)}\n--- ${b.name}\n${syncLines(b.log)}`);
}

/** A marker written on `from` is drained into its out-feed for `to`, and still never reaches `to`. */
async function blocked(from, to, label) {
  // The drain only counts once this marker's outbox row was recorded queued
  // (otherwise an outbox query that never matches would read as "drained").
  // writeMarker reads the scratch DB's trigger-fed audit copy of sync_outbox,
  // so the gateway's timed drain cannot race it; a row that never queued fails.
  const text = `pt2a ${label} ${from.name}->${to.name} ${tag()}`;
  assert.ok((await writeMarker(from, text)).queued, `${label}: the marker on ${from.name} was never queued in sync_outbox (the drain check would be vacuous)\n${outboxDiag(from, text)}`);
  assert.ok(await until(() => markerDrained(from, text), FLOW_MS, 500), `${label}: ${from.name} never drained its marker (no out-feed for ${to.name}?)`);
  await new Promise((r) => setTimeout(r, QUIET_MS));
  assert.equal(hasMarker(to, text), false, `${label}: ${from.name}'s marker reached ${to.name} over a refused link`);
  return text;
}

/** `inst`'s applied-seq record for `peerId` (sync_state), or null. */
function appliedSeq(inst, peerId) {
  const blob = inst.sql("SELECT last_applied_seq_per_peer AS b FROM sync_state WHERE instance_id = ?", [inst.id])[0]?.b;
  try { return JSON.parse(blob || "{}")[peerId] ?? null; } catch { return null; }
}

/**
 * A re-paired link starts behind PT-1's re-pair fence (`ff: 1`): the first
 * apply run fast-forwards past whatever the peer had appended, so the first
 * markers after a re-pair are consumed, not applied (by design). Prime
 * the link with one sacrificial marker each way and wait until both sides'
 * records show the fence consumed; only then do the legs' markers count.
 */
async function primeLink(a, b) {
  const up = (n) => /replicating with peer/.test(n.log);
  assert.ok(await until(() => up(a) && up(b), FLOW_MS, 250), `the link came up\n--- ${a.name}\n${syncLines(a.log)}\n--- ${b.name}\n${syncLines(b.log)}`);
  const fenced = (x, y) => Number(appliedSeq(x, y.id)?.ff) === 1;
  if (!fenced(a, b) && !fenced(b, a)) return; // a first pairing carries no fence
  const open = (x, y) => { const r = appliedSeq(x, y.id); return r && typeof r === "object" && Number(r.ff) !== 1 && Number(r.s) > 0; };
  await writeMarker(a, `pt2a prime ${a.name}->${b.name} ${tag()}`);
  await writeMarker(b, `pt2a prime ${b.name}->${a.name} ${tag()}`);
  assert.ok(await until(() => open(a, b) && open(b, a), FLOW_MS, 500), `the re-pair fence was consumed on both sides (${JSON.stringify(appliedSeq(a, b.id))} / ${JSON.stringify(appliedSeq(b, a.id))})`);
}

function pinCli(inst, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, ["scripts/cli/sync-pair-pin.js", ...args], { cwd: inst.repo, env: inst.env, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

/**
 * An impostor in THIS process: A's Crow ID seed (copied from A's identity.json),
 * claiming instance id `claimId`, with its own scratch DB holding a trusted row
 * for A and no credential store (pairKeyLookup returns what the test says).
 * Same harness pieces as the in-process sync tests (tests/fixtures/sync-fleet.mjs).
 */
async function makeImpostor(A, claimId) {
  const identity = deriveInstanceIdentity(loadInstanceSeed(A.dataDir));
  const dir = mkdtempSync(join(tmpdir(), "pt2a-impostor-"));
  let db = null, mgr = null;
  try {
    db = await makeRealDb(dir);
    await addPeerRow(db, A.id, { crowId: identity.crowId, gatewayUrl: `http://127.0.0.1:${A.port}` });
    mgr = new InstanceSyncManager(identity, db, claimId);
    mgr.dataDir = join(dir, "instance-sync"); // keep feeds out of any real home
    mgr.feedsDisabled = false;                // the suite env disables feeds
    await mgr.initInstance(A.id, null);
  } catch (err) {
    // The caller never receives a handle on failure: close and remove here.
    try { await mgr?.close(); } catch {}
    try { db?.close?.(); } catch {}
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  let key = null;
  const side = { mgr, db, dir, id: claimId, pairKeyLookup: () => key };
  return {
    identity, side, mgr, db,
    setKey(hex) { key = hex; },
    async marker(label) {
      const text = `pt2a ${label} impostor ${tag()}`;
      // memories.id is an INTEGER key: a random id far above anything A holds.
      await writeAndEmit(side, 9_000_000_000_000 + randomBytes(4).readUInt32BE(0), text);
      return text;
    },
    async cleanup() {
      try { await mgr.close(); } catch {}
      try { db.close?.(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let old;
before(async () => { old = await oldTree(PT3_SHA); }, { timeout: 600_000 });
after(() => { old?.cleanup(); });

// ---------------------------------------------------------------- one pair: T1, T6, T5, T8, T7
describe("new↔new pair (T1, T6, then T5, T8, T7 on the same link)", () => {
  let P;
  before(async () => {
    P = await bootPair({ sameIdentity: true });
    assert.ok(P.A.id < P.B.id, "A is the elected dialer");
    await useLoopbackSync(P.A, P.B);
    await P.B.boot();
    await P.A.boot();
    await primeLink(P.A, P.B);
  }, { timeout: 600_000 });
  after(async () => { await P?.cleanup(); }, { timeout: 120_000 });

  test("T1 new↔new: markers both ways, both sides pinned, the log shows pair-bound (not legacy)", T, async () => {
    const { A, B } = P;
    await flowsBoth(A, B, "t1");
    assert.ok(await until(() => pairPinned(A, B.id) && pairPinned(B, A.id), 15_000), "sync_pair_bound: on both sides");
    assert.match(A.log, bound(B.id, "client"));
    assert.match(B.log, bound(A.id, "server"));
    for (const n of [A, B]) {
      assert.doesNotMatch(n.log, anyRefusal, `${n.name}: no refusal`);
      assert.doesNotMatch(n.log, anyLegacy, `${n.name}: never legacy`);
    }
  });

  test("T6 Hyperswarm off: no instance topic joined, tailnet still carries markers", T, async () => {
    const { A, B } = P;
    for (const n of [A, B]) {
      // Positive control: the sharing runtime ran and reached the topic join.
      assert.match(n.log, /Hyperswarm instance sync is off \(CROW_INSTANCE_SYNC_HYPERSWARM=0\)/, `${n.name}: the switch was read`);
      assert.match(n.log, /\[gateway-local-dht\] active/, `${n.name}: the local-DHT preload ran`);
      assert.doesNotMatch(n.log, /Joined instance sync topic/, `${n.name}: joined no instance topic`);
      assert.doesNotMatch(n.log, /\[gateway-local-dht-guard\]/, `${n.name}: no DHT left the box`);
    }
    await flows(B, A, "t6");
    // 127.0.0.1 only: after live handshakes neither side learned a tailnet
    // address back, so the loopback URL is still the only dial candidate.
    for (const [x, y] of [[A, B], [B, A]]) {
      const row = x.row(y.id);
      assert.equal(row.gateway_url, `http://127.0.0.1:${y.port}`);
      assert.equal(row.tailscale_ip, null, `${x.name} learned no tailnet address for ${y.name}`);
    }
  });

  test("T5 pinned downgrade: B restarted on the old tree is refused, its markers stop; back on new code they resume", T, async () => {
    const { A, B } = P;
    await flows(B, A, "t5 control");
    let from = A.log.length;
    await B.boot({ repo: old.dir });
    assert.ok(await logShows(A, refused(B.id, "client", "pb_required_pinned"), from), `A refuses old B\n${syncLines(sinceLog(A, from))}`);
    const stuck = await blocked(B, A, "t5 old");
    from = A.log.length;
    await B.boot({ repo: REPO });
    assert.ok(await until(() => hasMarker(A, stuck), FLOW_MS, 500), "the held marker arrives once B runs new code again");
    assert.ok(await logShows(A, bound(B.id, "client"), from), "bound again");
  });

  test("T8 one-sided rollback: old B refused; clearing A's pin restores sync as legacy; B on new code re-pins", T, async () => {
    const { A, B } = P;
    await flows(B, A, "t8 control"); // positive control before the rollback
    assert.equal(pairPinned(A, B.id), true);
    const from = A.log.length;
    await B.boot({ repo: old.dir });
    assert.ok(await logShows(A, refused(B.id, "client", "pb_required_pinned"), from), "A refuses old B");
    const stuck = await blocked(B, A, "t8 old");

    // The documented escape, with A running: the owner clears A's pin.
    const cl = await pinCli(A, ["--clear", B.id]);
    assert.equal(cl.code, 0, cl.out);
    assert.equal(pairPinned(A, B.id), false);
    assert.ok(await until(() => hasMarker(A, stuck), FLOW_MS, 500), "the held marker flows after the clear (A's next handshake, normal backoff)");
    await flowsBoth(A, B, "t8 cleared");
    assert.ok(await logShows(A, legacy(B.id, "client"), from), "A raises the 'syncs without pair binding' item");

    const from2 = A.log.length;
    await B.boot({ repo: REPO });
    assert.ok(await logShows(A, bound(B.id, "client"), from2), "bound again");
    assert.ok(await until(() => pairPinned(A, B.id), 15_000), "re-pinned");
  });

  test("T7 store mode 0644 on A: refused with 'no pair key', no crash; chmod 600 recovers without a restart", T, async () => {
    const { A, B } = P;
    await flows(B, A, "t7 control");
    const pid = A.child.pid;
    chmodSync(A.tokensPath, 0o644);
    let from = A.log.length;
    try {
      await B.boot(); // a fresh handshake; A keeps running
      assert.ok(await logShows(A, new RegExp(`${refused(B.id, "client", "pb_required_pinned").source}; this side holds no pair key for it`), from),
        `A refuses with no pair key\n${syncLines(sinceLog(A, from))}`);
      const stuck = await blocked(B, A, "t7 loose");
      assert.equal(A.child?.pid, pid, "A did not restart");
      assert.equal(A.child.exitCode, null, "A did not crash");
      from = A.log.length;
      chmodSync(A.tokensPath, 0o600);
      assert.ok(await logShows(A, bound(B.id, "client"), from), "bound again (the store is re-read per handshake)");
      assert.ok(await until(() => hasMarker(A, stuck), FLOW_MS, 500), "the held marker arrives");
      assert.equal(A.child?.pid, pid, "still the same A process");
    } finally {
      chmodSync(A.tokensPath, 0o600);
    }
  });
});

// ---------------------------------------------------------------- T2
describe("T2 a seed holder without a pairing", () => {
  let P, imp;
  const dialers = [];
  before(async () => {
    // Ids chosen so B sorts first: B (and so the impostor claiming B) is the elected dialer.
    const h = tag();
    P = await bootPair({ sameIdentity: true, ids: { a: `inst-y-a-${h}`, b: `inst-x-b-${h}` } });
    assert.ok(P.B.id < P.A.id);
    await useLoopbackSync(P.A, P.B);
    await P.A.boot();
    await P.B.boot();
    await primeLink(P.A, P.B);
  }, { timeout: 600_000 });
  after(async () => {
    for (const d of dialers) d.stop();
    await imp?.cleanup();
    await P?.cleanup();
  }, { timeout: 120_000 });

  test("T2 A refuses a dialer holding A's seed but no pair key; the same dialer with B's real key is accepted", T, async () => {
    const { A, B } = P;
    // Positive control on the link: the real B binds, A pins it.
    await flowsBoth(A, B, "t2 control");
    assert.ok(await until(() => pairPinned(A, B.id), 15_000));
    assert.match(A.log, bound(B.id, "server"));
    const realKey = B.tokens()[A.id]?.signing_key;
    assert.ok(realKey, "B's store holds the pair key");
    await B.stop();

    imp = await makeImpostor(A, B.id);
    const ctx = {
      identity: imp.identity, instanceSyncManager: imp.mgr, db: imp.db, gatewayPort: A.port,
      standardPorts: [], lookupTailnetIp: async () => null, selfAddress: async () => null, idleRecheckMs: 200,
      pairKeyLookup: imp.side.pairKeyLookup, log: { warn: () => {}, log: () => {} },
    };
    const peerRow = { id: A.id, name: "a", gateway_url: `http://127.0.0.1:${A.port}`, tailscale_ip: null, sync_url: null, status: "active" };
    const held = await imp.marker("t2 no-key");
    let from = A.log.length;
    const d1 = new PeerDialer(peerRow, ctx);
    dialers.push(d1);
    d1.start();
    assert.ok(await logShows(A, refused(B.id, "server", "pb_required_pinned"), from, 60_000), `A refuses the key-less dialer\n${syncLines(sinceLog(A, from))}`);
    await new Promise((r) => setTimeout(r, QUIET_MS));
    assert.equal(hasMarker(A, held), false, "the impostor's marker never reaches A");
    assert.doesNotMatch(sinceLog(A, from), /replicating with peer/, "no replication was set up");
    d1.stop();

    // The same dialer and manager, given B's real key from B's store: accepted.
    imp.setKey(realKey);
    from = A.log.length;
    const d2 = new PeerDialer(peerRow, ctx);
    dialers.push(d2);
    d2.start();
    assert.ok(await logShows(A, bound(B.id, "server"), from, 60_000), `A accepts with the real key\n${syncLines(sinceLog(A, from))}`);
    assert.ok(await until(() => hasMarker(A, held), 60_000, 500), "with the key, the same manager's marker does reach A");
  });
});

// ---------------------------------------------------------------- T3
describe("T3 a stale key after re-pair", () => {
  let P, imp, gw;
  before(async () => {
    P = await bootPair({ sameIdentity: true });
    assert.ok(P.A.id < P.B.id, "A is the elected dialer");
    await useLoopbackSync(P.A, P.B);
    await P.B.boot();
    await P.A.boot();
    await primeLink(P.A, P.B);
  }, { timeout: 600_000 });
  after(async () => {
    await gw?.close();
    await imp?.cleanup();
    await P?.cleanup();
  }, { timeout: 120_000 });

  test("T3 after revoke + re-pair, the old key K1 is refused as pb_invalid; markers written while revoked never replay", T, async () => {
    const { A, B } = P;
    await flowsBoth(A, B, "t3 control");
    assert.ok(await until(() => pairPinned(A, B.id) && pairPinned(B, A.id), 15_000));
    const K1 = B.tokens()[A.id]?.signing_key;
    assert.ok(K1);

    const rv = await settingsRevoke(A, B.id);
    assert.equal(rv.status, 303, JSON.stringify(rv));
    assert.equal(A.row(B.id).status, "revoked");
    const whileRevoked = await blocked(B, A, "t3 revoked");

    // Re-pair (A allows it), with sync off while the CLI rewrites the rows.
    A.sync = false; B.sync = false;
    await B.boot();
    await A.boot();
    const allow = await A.pairCli(["--allow-re-pair", B.id]);
    assert.equal(allow.code, 0, allow.out);
    const rp = await pairInto(B, A, ["--peer-id", A.id]);
    assert.equal(rp.code, 0, rp.out);
    const K2 = B.tokens()[A.id]?.signing_key;
    assert.ok(K2 && K2 !== K1, "a new pair key");
    assert.equal(A.tokens()[B.id]?.signing_key, K2);
    await useLoopbackSync(A, B);
    await B.boot();
    let from = 0;
    await A.boot();

    // Positive control: B with K2 binds and syncs (past the re-pair fence,
    // which is what keeps the revoked-era marker from replaying).
    assert.ok(await logShows(A, bound(B.id, "client"), from), "B with K2 binds");
    await primeLink(A, B);
    await flowsBoth(A, B, "t3 re-paired");
    assert.equal(hasMarker(A, whileRevoked), false, "the marker B wrote while revoked does not replay (PT-1 fence)");

    // The impostor holds the seed and K1, and claims B. The row is trusted again.
    const row = A.row(B.id);
    assert.equal(row.status, "active");
    assert.equal(Number(row.trusted), 1);
    await B.stop();
    imp = await makeImpostor(A, B.id);
    imp.setKey(K1);
    gw = await startGateway({ identity: imp.identity }, imp.side);
    const held = await imp.marker("t3 k1");
    // A's row for B now points at the impostor (address only; A must dial it:
    // a conforming dialer holding K1 would detect the mismatch itself and
    // never send its MAC, so only A verifying the impostor's MAC shows A's refusal).
    await A.stop();
    A.sql("UPDATE crow_instances SET gateway_url = ? WHERE id = ?", [`http://127.0.0.1:${gw.port}`, B.id]);
    from = 0;
    await A.boot();
    assert.ok(await logShows(A, refused(B.id, "client", "pb_invalid"), from, 90_000), `A refuses K1 as pb_invalid\n${syncLines(A.log)}`);
    assert.doesNotMatch(A.log, /is not a live paired peer here|unknown peer/, "the refusal is pair binding, not the PT-1 row gate");
    await new Promise((r) => setTimeout(r, QUIET_MS));
    assert.equal(hasMarker(A, held), false, "the K1 impostor's marker never reaches A");

    // The same link with K2 (positive control after): accepted.
    from = A.log.length;
    imp.setKey(K2);
    assert.ok(await logShows(A, bound(B.id, "client"), from), "the same endpoint with K2 binds");
    assert.ok(await until(() => hasMarker(A, held), FLOW_MS, 500), "and its marker arrives");
    assert.equal(hasMarker(A, whileRevoked), false, "still no replay of the revoked-era marker");
  });
});

// ---------------------------------------------------------------- T4
for (const oldSide of ["B", "A"]) {
  describe(`T4 mixed: old ${oldSide}`, () => {
    let P;
    before(async () => {
      P = await bootPair({ sameIdentity: true, ...(oldSide === "B" ? { repoB: old.dir } : { repoA: old.dir }) });
      assert.ok(P.A.id < P.B.id, "A is the elected dialer");
      await useLoopbackSync(P.A, P.B);
      await P.B.boot();
      await P.A.boot();
      await primeLink(P.A, P.B);
    }, { timeout: 600_000 });
    after(async () => { await P?.cleanup(); }, { timeout: 120_000 });

    test(`T4 old ${oldSide}: auto flows (legacy item), require refuses, auto flows again`, T, async () => {
      const { A, B } = P;
      // The new side decides; the old side never speaks pair binding.
      const [newer, older, side] = oldSide === "B" ? [A, B, "client"] : [B, A, "server"];
      await flowsBoth(A, B, "t4 auto");
      assert.match(newer.log, legacy(older.id, side), "the new side raises the 'syncs without pair binding' item");
      assert.equal(pairPinned(newer, older.id), false, "never pinned");
      assert.doesNotMatch(newer.log, anyRefusal);

      let from = 0;
      await newer.boot({ extraEnv: { CROW_SYNC_PAIR_BINDING: "require" } });
      assert.ok(await logShows(newer, refused(older.id, side, "pb_required"), from), `require refuses the old side\n${syncLines(newer.log)}`);
      const stuck = await blocked(older, newer, "t4 require");

      from = 0;
      await newer.boot();
      assert.ok(await until(() => hasMarker(newer, stuck), FLOW_MS, 500), "back to auto: the held marker arrives");
      await flows(newer, older, "t4 auto again");
      assert.match(newer.log, legacy(older.id, side));
    });
  });
}
