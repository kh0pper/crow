/**
 * A --no-auth companion gateway (e.g. grackle's loopback crow-mcp-bridge) must
 * NOT initialize instance-sync Hypercore feeds — otherwise it grabs the feed
 * lock and starves the PRIMARY gateway ("File descriptor could not be locked"),
 * so the primary can't receive cross-instance sync. Same class as QW1
 * (shouldRunHealthMonitor). This gates feed init + emit on the --no-auth flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager, shouldInitInstanceSync } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

test("shouldInitInstanceSync: enabled by default, disabled on --no-auth or kill-switch", () => {
  assert.equal(shouldInitInstanceSync({ argv: ["node", "index.js"], env: {} }), true, "default enabled");
  assert.equal(shouldInitInstanceSync({ argv: ["node", "index.js", "--no-auth"], env: {} }), false, "--no-auth disables");
  assert.equal(shouldInitInstanceSync({ argv: ["node", "index.js"], env: { CROW_DISABLE_INSTANCE_SYNC: "1" } }), false, "env kill-switch disables");
});

test("feedsDisabled manager: initInstance + emitChange are no-ops (no feed dir, no throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noauth-isync-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe" });
  const db = createDbClient(join(dir, "crow.db"));
  const priv = Buffer.alloc(32, 0x11);
  const identity = { ed25519Priv: priv, ed25519Pubkey: Buffer.from(await ed.getPublicKey(priv)).toString("hex") };
  const mgr = new InstanceSyncManager(identity, db, "local-0000");
  mgr.feedsDisabled = true; // simulate --no-auth
  const peerId = "peer-1111-2222-3333-444444444444";

  const r = await mgr.initInstance(peerId, null);
  assert.equal(r, null, "initInstance returns null when feeds disabled");
  assert.equal(mgr.outFeeds.size, 0, "no outfeed opened");
  assert.equal(mgr.inFeeds.size, 0, "no infeed opened");
  assert.equal(existsSync(join(dir, "instance-sync", peerId)), false, "no on-disk feed dir created");

  // emitChange must be a guarded no-op (does not advance lamport or throw)
  await mgr.emitChange("contacts", "insert", { crow_id: "crow:x", secp256k1_pubkey: "a".repeat(64), ed25519_pubkey: "" });

  rmSync(dir, { recursive: true, force: true });
});

test("PeerManager: p2pDisabled skips swarm start + DHT joins", async () => {
  const { PeerManager } = await import("../servers/sharing/peer-manager.js");
  const pm = new PeerManager({ ed25519Pubkey: "ab".repeat(32), crowId: "crow:x" });
  pm.p2pDisabled = true; // simulate --no-auth companion
  await pm.start();
  assert.equal(pm.swarm, null, "no Hyperswarm created");
  assert.equal(await pm.joinContact({ crowId: "crow:y", ed25519Pubkey: "cd".repeat(32) }), null, "joinContact no-op");
  assert.equal(await pm.joinInstanceSync(), null, "joinInstanceSync no-op");
});

test("SyncManager: p2pDisabled skips per-contact feed init", async () => {
  const { SyncManager } = await import("../servers/sharing/sync.js");
  const sm = new SyncManager({ ed25519Pubkey: "ab".repeat(32) });
  sm.p2pDisabled = true;
  assert.equal(await sm.initContact(123, null), null, "initContact no-op");
  assert.equal(sm.outFeeds.size, 0, "no per-contact feed opened");
});

test("enabled manager still opens an outfeed (regression guard)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-isync-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe" });
  const db = createDbClient(join(dir, "crow.db"));
  const priv = Buffer.alloc(32, 0x22);
  const identity = { ed25519Priv: priv, ed25519Pubkey: Buffer.from(await ed.getPublicKey(priv)).toString("hex") };
  const mgr = new InstanceSyncManager(identity, db, "local-0000");
  mgr.dataDir = join(dir, "instance-sync"); // isolate from process default
  mgr.feedsDisabled = false;
  const peerId = "peer-5555-6666-7777-888888888888";
  await mgr.initInstance(peerId, null);
  assert.equal(mgr.outFeeds.size, 1, "outfeed opened when enabled");
  // close to release the lock so the tmp dir can be removed cleanly
  try { await mgr.outFeeds.get(peerId)?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});
