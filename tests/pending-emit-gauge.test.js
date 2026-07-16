/**
 * G-F5-1 (2c follow-up pool, spec §F5 / plan T6): `_pendingPeerEmits` RAM
 * observability — public `pendingEmitStats()` on InstanceSyncManager plus a
 * gauge line in tailnet-sync's 60s refresh() loop.
 *
 * Contract under test:
 *   - pendingEmitStats() returns a plain object {peerId: count} for NON-EMPTY
 *     slots only, and is FULLY SYNCHRONOUS (spec R1-5.2: the map's only
 *     writers are _chainAppendTask microtasks — a synchronous read cannot
 *     interleave with a mutation).
 *   - refresh() logs the gauge AFTER the per-peer loop (R2 Q7: a zero-peer
 *     refresh still reaches it), ONLY when non-empty, peer ids truncated to
 *     12 chars, and inside its OWN try/catch (post-C1b the process-level
 *     nostr crash guard RETHROWS non-nostr errors — an escaped throw here
 *     would crash the gateway). Optional chaining guards managers that lack
 *     the method (older/stub managers).
 *
 * Harness idiom from tests/backfill-drain-caps.test.js / lamport-reemit.test.js:
 * per-test mkdtemp CROW_DATA_DIR + real init-db, mgr.dataDir = scratch,
 * mgr.feedsDisabled = false; entries park via the REAL _appendToPeer path
 * (peer NOT in outFeeds → parks). Gauge cases drive the exported
 * __refreshForTest with a stub manager (the feed-rotation.test.js C4 idiom).
 * NEVER point this file at ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { startTailnetSyncClients } from "../servers/sharing/tailnet-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const LOCAL_ID = "inst-eeee-0000-0000-0000-00000000000e";
const PEER_ID = "peer-ffff-0000-0000-0000-00000000000f";
const OTHER_ID = "peer-0000-1111-2222-3333-444444444444";

async function makeIdentity() {
  const priv = Buffer.alloc(32, 0x2c);
  const pub = Buffer.from(await ed.getPublicKey(priv)).toString("hex");
  return { ed25519Priv: priv, ed25519Pubkey: pub };
}

/** Real manager on a scratch DB (backfill-drain-caps idiom). */
async function makeRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-f5-gauge-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    // CROW_DB_PATH outranks CROW_DATA_DIR in init-db — blank it, or a shell
    // exporting it would run the migration against the REAL DB (PR #180).
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" },
    stdio: "pipe",
  });
  const db = createDbClient(join(dir, "crow.db"));
  const mgr = new InstanceSyncManager(await makeIdentity(), db, LOCAL_ID);
  mgr.dataDir = join(dir, "instance-sync"); // MUST: keep test feeds out of ~/.crow
  mgr.feedsDisabled = false;                // MUST: scratch env disables feeds (2c C6)
  return {
    dir, db, mgr,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Capture console.warn lines; restore() puts the original back. */
function captureWarn() {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}

const gaugeLines = (lines) => lines.filter((l) => l.includes("pending emit queues"));

// ── pendingEmitStats unit (real manager, real park path) ────────────────────

test("G-F5-1a: pendingEmitStats counts entries parked via the real _appendToPeer path, non-empty slots only; drain -> {}", async () => {
  const rig = await makeRig("unit");
  try {
    assert.deepEqual(rig.mgr.pendingEmitStats(), {}, "fresh manager: empty plain object");

    // Park via the REAL _appendToPeer path: PEER_ID is NOT in outFeeds → parks.
    await rig.mgr._appendToPeer(PEER_ID, { table: "memories", op: "insert", row: { id: 990001 } });
    await rig.mgr._appendToPeer(PEER_ID, { table: "memories", op: "insert", row: { id: 990002 } });
    await rig.mgr._appendToPeer(PEER_ID, { table: "memories", op: "insert", row: { id: 990003 } });
    const stats = rig.mgr.pendingEmitStats();
    assert.deepEqual(stats, { [PEER_ID]: 3 }, "three parked entries counted for the peer");
    assert.equal(typeof stats.then, "undefined", "synchronous: a plain object, not a promise");

    // Non-empty slots ONLY (mutation target M2): an empty slot in the map is omitted.
    rig.mgr._pendingPeerEmits.set(OTHER_ID, []);
    assert.deepEqual(rig.mgr.pendingEmitStats(), { [PEER_ID]: 3 }, "empty slot omitted from stats");

    // Drain onto a now-armed feed → stats back to {} (empty object, not null).
    const drained = [];
    rig.mgr.outFeeds.set(PEER_ID, { append: async (e) => drained.push(e) });
    const n = await rig.mgr._drainPendingEmits(PEER_ID);
    assert.equal(n, 3, "drain appended all three parked entries");
    // OTHER_ID's empty slot is still in the map — the include-empty mutant
    // returns {OTHER_ID: 0} here and goes red.
    assert.deepEqual(rig.mgr.pendingEmitStats(), {}, "drained -> empty object");
  } finally {
    rig.cleanup();
  }
});

// ── Gauge through refresh() (stub manager, feed-rotation C4 idiom) ───────────

test("G-F5-1b: refresh() emits ONE gauge line when stats are non-empty -- zero-peer refresh still reaches it; ids truncated to 12 chars", async () => {
  const stubMgr = {
    localInstanceId: "me",
    pendingEmitStats: () => ({ "peer-aaaaaaaabbbbbbbb": 12, "peerB": 256 }),
  };
  // ZERO peer rows: the gauge must sit AFTER the per-peer loop (R2 Q7) — an
  // in-loop placement never runs here and this test goes red.
  const stubDb = { execute: async () => ({ rows: [] }) };
  const cap = captureWarn();
  let clients;
  try {
    clients = await startTailnetSyncClients({ db: stubDb, instanceSyncManager: stubMgr, identity: {} });
    cap.lines.length = 0; // discard the boot refresh; assert the driven one
    await clients.__refreshForTest();
    const gauge = gaugeLines(cap.lines);
    assert.equal(gauge.length, 1, `exactly one gauge line per refresh (got ${JSON.stringify(cap.lines)})`);
    assert.equal(gauge[0], "[instance-sync] pending emit queues: peer-aaaaaaa=12, peerB=256",
      "gauge format: [instance-sync] prefix, 12-char-truncated ids, count per peer");
  } finally {
    cap.restore();
    clients?.stop();
  }
});

test("G-F5-1c: refresh() emits NO gauge line when stats are empty", async () => {
  const stubMgr = { localInstanceId: "me", pendingEmitStats: () => ({}) };
  const stubDb = { execute: async () => ({ rows: [] }) };
  const cap = captureWarn();
  let clients;
  try {
    clients = await startTailnetSyncClients({ db: stubDb, instanceSyncManager: stubMgr, identity: {} });
    await clients.__refreshForTest();
    // Boot refresh AND driven refresh both ran — neither may emit the gauge.
    assert.deepEqual(gaugeLines(cap.lines), [], "no gauge line for empty stats");
  } finally {
    cap.restore();
    clients?.stop();
  }
});

test("G-F5-1d: a manager WITHOUT pendingEmitStats never throws (optional chaining) and emits no gauge", async () => {
  const stubMgr = { localInstanceId: "me" }; // older/stub manager: no method
  const stubDb = { execute: async () => ({ rows: [] }) };
  const cap = captureWarn();
  let clients;
  try {
    clients = await startTailnetSyncClients({ db: stubDb, instanceSyncManager: stubMgr, identity: {} });
    await clients.__refreshForTest(); // completing without a throw IS the assertion
    assert.deepEqual(gaugeLines(cap.lines), [], "no gauge line without the method");
  } finally {
    cap.restore();
    clients?.stop();
  }
});

test("G-F5-1e: a THROWING pendingEmitStats is contained by the gauge's own try/catch (refresh must not throw)", async () => {
  const stubMgr = {
    localInstanceId: "me",
    pendingEmitStats: () => { throw new Error("boom-gauge"); },
  };
  const stubDb = { execute: async () => ({ rows: [] }) };
  const cap = captureWarn();
  let clients;
  try {
    clients = await startTailnetSyncClients({ db: stubDb, instanceSyncManager: stubMgr, identity: {} });
    // refresh runs on a bare setInterval in prod and the nostr crash guard
    // RETHROWS non-nostr errors — an escape here would crash the gateway.
    // Resolving without a throw IS the assertion.
    await clients.__refreshForTest();
    assert.deepEqual(gaugeLines(cap.lines), [], "no gauge line when stats threw");
  } finally {
    cap.restore();
    clients?.stop();
  }
});
