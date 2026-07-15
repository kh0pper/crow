/**
 * Item 2d gate: feed-key rotation (spec 2026-07-15-feed-key-rotation-design.md §7).
 * REAL Hypercores + REAL replication over NoiseSecretStream on a TCP socketpair —
 * the existing suites apply entries directly and cannot see replication-layer
 * defects (that blindness is what let D1/D2 ship).
 *
 * HARNESS: two real instances (each its own mkdtemp CROW_DATA_DIR + real init-db +
 * real InstanceSyncManager), joined by a real NoiseSecretStream pair over a real
 * TCP socketpair — adapted from tests/lamport-reemit.test.js's newFleet() pattern
 * (per-side real init-db SQLite, one SHARED identity object, crow_instances peer
 * row seeding), but replicating over the actual wire instead of a fake out-feed.
 *
 * NEVER point this file at ~/.crow — it opens real Hypercore feeds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

// ── shared identity ──────────────────────────────────────────────────────────
// instance-sync verifies every entry against `this.identity.ed25519Pubkey`, and
// a user's instances share one identity — both managers MUST use the same object
// (tests/lamport-reemit.test.js pattern). getPublicKey is async, so resolve it
// once into the identity shape InstanceSyncManager expects.
async function makeSharedIdentity() {
  const TEST_PRIV = Buffer.alloc(32, 0x2c);
  const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
  return { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
}

/** Real init-db.js run against a fresh dir — same mechanism as lamport-reemit.test.js. */
async function makeRealDb(dir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    // CROW_DB_PATH outranks CROW_DATA_DIR in init-db (init-db.js:11) — blank it, or
    // a shell exporting it would run the migration against the REAL DB.
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" },
    stdio: "pipe",
  });
  return createDbClient(join(dir, "crow.db"));
}

/** Seed `db`'s crow_instances with peerId as an active paired peer. */
async function registerPeerRow(db, peerId) {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, ?, 'active')",
    args: [peerId, peerId, `crow:${peerId}`],
  });
}

async function makeSide(identity, id) {
  const dir = mkdtempSync(join(tmpdir(), `rot-${id}-`));
  const db = await makeRealDb(dir); // ← same helper style as lamport-reemit.test.js
  const mgr = new InstanceSyncManager(identity, db, id);
  mgr.dataDir = join(dir, "instance-sync"); // MUST: keep test feeds out of ~/.crow
  mgr.feedsDisabled = false;                // MUST: scratch env disables feeds (2c C6)
  return { mgr, db, dir, id };
}

export async function makeFleet() {
  const identity = await makeSharedIdentity(); // same object for both sides
  const a = await makeSide(identity, "instA");
  const b = await makeSide(identity, "instB");
  // Register each other in crow_instances so eager/boot paths see a paired row.
  await registerPeerRow(a.db, b.id);
  await registerPeerRow(b.db, a.id);
  return {
    a, b,
    async cleanup() {
      await a.mgr.close(); await b.mgr.close();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    },
  };
}

/** Real socketpair: two net.Sockets connected through an ephemeral local server. */
function socketPair() {
  return new Promise((resolve, reject) => {
    // Declared here (not inside the listen callback below) so both callbacks —
    // siblings, not nested — close over the SAME binding. `var` inside the
    // listen callback would hoist only to that inner function's scope and
    // leave the reference in the connection callback unbound.
    let clientSide;
    const server = net.createServer((serverSide) => {
      server.close();
      resolve([serverSide, clientSide]);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      clientSide = net.connect(server.address().port, "127.0.0.1");
      clientSide.on("error", reject);
    });
  });
}

export async function linkPeers(a, b) {
  const [sockA, sockB] = await socketPair();
  const nsA = new NoiseSecretStream(true, sockA);
  const nsB = new NoiseSecretStream(false, sockB);
  nsA.on("error", () => {}); nsB.on("error", () => {});
  // Exchange feed keys the way the real handshake does, then replicate.
  await a.mgr.initInstance(b.id, b.mgr.getOutFeedKey(a.id));
  await b.mgr.initInstance(a.id, a.mgr.getOutFeedKey(b.id));
  await a.mgr.replicate(b.id, nsA);
  await b.mgr.replicate(a.id, nsB);
  return { streams: [nsA, nsB], close: () => { nsA.destroy(); nsB.destroy(); } };
}

/** Await until fn() is truthy or the deadline passes — condition-based, no bare sleeps. */
export async function until(fn, ms = 5000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

test("G0 baseline: real replication applies an emitted row across the socketpair", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    // Arm feeds by exchanging real keys BEFORE linking (linkPeers does both).
    link = await linkPeers(fleet.a, fleet.b);
    // memories.id is INTEGER PRIMARY KEY AUTOINCREMENT (real schema, scripts/init-db.js) —
    // a text id like "rot-g0" throws SQLITE datatype mismatch on the receiving INSERT,
    // so the emitted row's id must be a real integer (adapted from the brief's literal
    // string id, which does not survive against the real table).
    const G0_ID = 700001;
    await fleet.a.mgr.emitChange("memories", "insert",
      { id: G0_ID, content: "rot-g0 hello", lamport_ts: null });
    const applied = await until(async () => {
      const { rows } = await fleet.b.db.execute({
        sql: "SELECT id FROM memories WHERE id = ?", args: [G0_ID] });
      return rows.length === 1;
    });
    assert.equal(applied, true, "row emitted on A must apply on B via real replication");
  } finally {
    // link.close() BEFORE fleet.cleanup() regardless of pass/fail — an assertion
    // throw must not strand the NoiseSecretStream/TCP sockets open (they held the
    // whole process open past a failing run in early iteration of this harness).
    if (link) link.close();
    await fleet.cleanup();
  }
});
