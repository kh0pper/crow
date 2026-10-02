/**
 * Two-instance sync harness: real init-db scratch DBs, real
 * InstanceSyncManagers with real Hypercore feeds, one shared identity (a
 * user's instances share one), linked over a real NoiseSecretStream socket
 * pair. Same mechanism as tests/feed-rotation.test.js's makeFleet/linkPeers,
 * lifted into a fixture so revoke tests can drive the real replication path.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { createDbClient } from "../../servers/db.js";
import { InstanceSyncManager } from "../../servers/sharing/instance-sync.js";
import * as ed from "../../node_modules/@noble/ed25519/index.js";

export const SHARED_CROW_ID = "crow:fleet-test";

export async function makeSharedIdentity() {
  const priv = Buffer.alloc(32, 0x3d);
  const pub = Buffer.from(await ed.getPublicKey(priv)).toString("hex");
  return { ed25519Priv: priv, ed25519Pubkey: pub, crowId: SHARED_CROW_ID };
}

export async function makeRealDb(dir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" },
    stdio: "pipe",
  });
  return createDbClient(join(dir, "crow.db"));
}

export async function addPeerRow(db, id, { status = "active", crowId = SHARED_CROW_ID, gatewayUrl = null, trusted = 1 } = {}) {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status, trusted, gateway_url, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, '2000-01-01 00:00:00')",
    args: [id, id, crowId, status, trusted, gatewayUrl],
  });
}

async function makeSide(identity, id) {
  const dir = mkdtempSync(join(tmpdir(), `fleet-${id}-`));
  const db = await makeRealDb(dir);
  const mgr = new InstanceSyncManager(identity, db, id);
  mgr.dataDir = join(dir, "instance-sync"); // keep feeds out of ~/.crow
  mgr.feedsDisabled = false;                // the suite env disables feeds
  return { mgr, db, dir, id };
}

export async function makeFleet({ ids = ["instA", "instB"] } = {}) {
  const identity = await makeSharedIdentity();
  const [a, b] = [await makeSide(identity, ids[0]), await makeSide(identity, ids[1])];
  await addPeerRow(a.db, b.id);
  await addPeerRow(b.db, a.id);
  return {
    identity, a, b,
    async cleanup() {
      try { await a.mgr.close(); } catch {}
      try { await b.mgr.close(); } catch {}
      try { a.db.close?.(); } catch {}
      try { b.db.close?.(); } catch {}
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    },
  };
}

export function socketPair() {
  return new Promise((resolve, reject) => {
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

/** Exchange feed keys (both directions), return a linked Noise stream pair. */
export async function armAndPair(a, b) {
  await a.mgr.initInstance(b.id, b.mgr.getOutFeedKey(a.id));
  await b.mgr.initInstance(a.id, a.mgr.getOutFeedKey(b.id));
  await a.mgr.initInstance(b.id, b.mgr.getOutFeedKey(a.id));
  const [sockA, sockB] = await socketPair();
  const nsA = new NoiseSecretStream(true, sockA);
  const nsB = new NoiseSecretStream(false, sockB);
  nsA.on("error", () => {}); nsB.on("error", () => {});
  return { nsA, nsB, close: () => { nsA.destroy(); nsB.destroy(); } };
}

export async function linkPeers(a, b) {
  const link = await armAndPair(a, b);
  await a.mgr.replicate(b.id, link.nsA);
  await b.mgr.replicate(a.id, link.nsB);
  return link;
}

export async function until(fn, ms = 5000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function hasMemory(db, id) {
  const { rows } = await db.execute({ sql: "SELECT id FROM memories WHERE id = ?", args: [id] });
  return rows.length === 1;
}

/** Write a memory locally (so the row exists on the author) and emit it. */
export async function writeAndEmit(side, id, content) {
  await side.db.execute({ sql: "INSERT INTO memories (id, content) VALUES (?, ?)", args: [id, content] });
  await side.mgr.emitChange("memories", "insert", { id, content, lamport_ts: null });
}
