import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  getExposedCapabilities,
  getPeerGrantedCapabilities,
  getPeerExposures,
  isCapabilityExposedToPeer,
} from "../servers/gateway/peer-exposure.js";

let dir, db, remedy;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fixit-remedy-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
  remedy = (await import("../servers/gateway/fix-it/remedies/expose-capability.js")).default;
});

after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

/**
 * A card's peer must still be a trusted peer for the Allow remedy (review round
 * 2, N-a); in production only a peer that authenticated raises a card, so the
 * tests that expect a grant give it a row.
 */
async function trustPeer(...ids) {
  for (const id of ids) {
    await db.execute({
      sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, ?, 'active', 1)",
      args: [id, `Peer ${id}`, "crow-test"],
    });
  }
}

test("expose-capability grants the capability to the requesting peer ONLY (idempotent), marks resolved", async () => {
  await trustPeer("peer-a");
  const r1 = await remedy({ capability: "funkwhale", requestingInstance: "peer-a", days: 30 }, { db });
  assert.equal(r1.resolved, true);
  const granted = await getPeerGrantedCapabilities(db, "peer-a");
  assert.ok(granted.has("funkwhale"));
  // Idempotent: a second identical click re-grants, it does not duplicate.
  const r2 = await remedy({ capability: "funkwhale", requestingInstance: "peer-a", days: 30 }, { db });
  assert.equal(r2.resolved, true);
  assert.deepEqual([...((await getPeerExposures(db)).get("peer-a").keys())], ["funkwhale"]);
  // N1b-8: the all-trusted-peers allowlist is never touched by a card.
  assert.ok(!(await getExposedCapabilities(db)).has("funkwhale"), "a card must not expose the capability to every peer");
  // …and no other peer is granted by it.
  assert.equal(await isCapabilityExposedToPeer(db, "funkwhale", "peer-b"), false);
});

test("no verified requesting peer → refused, and NOTHING is exposed to every peer", async () => {
  const before = await getExposedCapabilities(db);
  for (const requestingInstance of [undefined, null, "", "Some Device", { id: "peer-a" }]) {
    const r = await remedy({ capability: "crow-memory", requestingInstance }, { db });
    assert.equal(r.resolved, false, `refused for ${JSON.stringify(requestingInstance)}`);
  }
  const after = await getExposedCapabilities(db);
  assert.deepEqual([...after].sort(), [...before].sort(), "the all-peer allowlist is unchanged");
  assert.ok(!after.has("crow-memory"), "fail closed: never widened to all peers");
});

test("a blank capability or a peer that is not trusted here → refused, nothing written", async () => {
  const blank = await remedy({ capability: "", requestingInstance: "peer-a" }, { db });
  assert.equal(blank.resolved, false);

  // Review round 2 (N-a): a peer whose row fails the one trust predicate
  // (`trusted = 1 AND status IN ('active','offline')`) is refused, with a reason.
  await db.execute({
    sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, ?, 'revoked', 1)",
    args: ["peer-revoked", "Revoked Peer", "crow-test"],
  });
  const revoked = await remedy({ capability: "crow-memory", requestingInstance: "peer-revoked", days: 30 }, { db });
  assert.equal(revoked.resolved, false);
  assert.match(revoked.message, /trusted peer/);
  assert.equal(await isCapabilityExposedToPeer(db, "crow-memory", "peer-revoked"), false);
  assert.equal((await getPeerExposures(db)).has("peer-revoked"), false);
});

test("a federation peer's proxy key (instance-<id>) is never exposed (queue item 38)", async () => {
  const r = await remedy({ capability: "instance-p2", requestingInstance: "peer-a" }, { db });
  assert.equal(r.resolved, false);
  assert.ok(!(await getExposedCapabilities(db)).has("instance-p2"));
  assert.equal(await isCapabilityExposedToPeer(db, "instance-p2", "peer-a"), false);
});

test("duration: 7 days expires, untilRemoved never does; the grant records expires_at", async () => {
  await trustPeer("peer-7");
  const now = Date.now();
  await remedy({ capability: "crow-blog", requestingInstance: "peer-7", days: 7 }, { db });
  const grant = (await getPeerExposures(db)).get("peer-7").get("crow-blog");
  assert.ok(grant.expiresAt && Date.parse(grant.expiresAt) > now + 6 * DAY);
  assert.equal(await isCapabilityExposedToPeer(db, "crow-blog", "peer-7", { now: now + 6 * DAY }), true);
  assert.equal(await isCapabilityExposedToPeer(db, "crow-blog", "peer-7", { now: now + 8 * DAY }), false);

  await remedy({ capability: "crow-storage", requestingInstance: "peer-7", untilRemoved: true }, { db });
  const forever = (await getPeerExposures(db)).get("peer-7").get("crow-storage");
  assert.equal(forever.expiresAt, null, "until I remove it stores no expiry");
  assert.equal(await isCapabilityExposedToPeer(db, "crow-storage", "peer-7", { now: now + 3650 * DAY }), true);
});