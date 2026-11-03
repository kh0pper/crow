/**
 * A sibling whose onInstanceConnected handler is slow (a DB read, a cold
 * Hypercore open, an initInstance queued behind another) must not lose the
 * peer's first Protomux frames. The peer starts replicating as soon as it is
 * mutually admitted; any frame that arrives before this side has a Protomux
 * on the stream is consumed by the line parser only, and the peer's next
 * channel open then fails with "Invalid open message", destroying the link.
 * The fix attaches the muxer at admission, before our `authenticated` frame
 * goes out, so the peer cannot send a Protomux frame we would miss.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NoiseSecretStream from "@hyperswarm/secret-stream";

import {
  makeRealDb, socketPair, until, sleep, makeSharedIdentity, addPeerRow, hasMemory, writeAndEmit, SHARED_CROW_ID,
} from "./fixtures/sync-fleet.mjs";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { wireInstanceSync } from "../servers/sharing/instance-connect.js";
import { PeerManager } from "../servers/sharing/peer-manager.js";
import { wireContactBinding } from "../servers/sharing/contact-binding.js";

const realLog = console.log, realWarn = console.warn;
console.log = () => {}; console.warn = () => {};
process.on("exit", () => { console.log = realLog; console.warn = realWarn; });

// "connect": the slow side's onInstanceConnected (its replicate()) runs late.
// "feedkey": its getFeedKeyForInstance is slow, so the peer is already
// replicating while our admission frames (instance-key) are still to come.
for (const [slow, where] of [["a", "connect"], ["b", "connect"], ["a", "feedkey"], ["b", "feedkey"]]) {
  test(`sibling ${slow} is slow (${where}): entries still replicate both ways and the link stays open`, { timeout: 30_000 }, async (t) => {
    const identity = await makeSharedIdentity();
    const sides = [];
    for (const n of ["a", "b"]) {
      const dir = mkdtempSync(join(tmpdir(), `mux-late-${n}-`));
      const db = await makeRealDb(dir);
      const id = `inst-${n}-${randomBytes(3).toString("hex")}`;
      const mgr = new InstanceSyncManager(identity, db, id);
      mgr.dataDir = join(dir, "instance-sync");
      mgr.feedsDisabled = false;
      t.after(async () => { try { await mgr.close(); } catch {} try { db.close?.(); } catch {} rmSync(dir, { recursive: true, force: true }); });
      sides.push({ name: n, id, db, mgr, pairKeys: new Map() });
    }
    const [a, b] = sides;
    await addPeerRow(a.db, b.id, { crowId: SHARED_CROW_ID });
    await addPeerRow(b.db, a.id, { crowId: SHARED_CROW_ID });
    const pairKey = randomBytes(32).toString("hex");
    a.pairKeys.set(b.id, pairKey); b.pairKeys.set(a.id, pairKey);

    const node = (side) => {
      const pm = new PeerManager(identity, {});
      pm.p2pDisabled = true;
      pm.localInstanceId = side.id;
      wireContactBinding(pm, { db: side.db, localInstanceId: () => side.id });
      wireInstanceSync(pm, { db: side.db, instanceSyncManager: side.mgr, pairKeyLookup: (id) => side.pairKeys.get(id) ?? null, mode: "auto" });
      const done = { connected: false };
      const gf = pm.getFeedKeyForInstance;
      pm.getFeedKeyForInstance = async (...q) => {
        if (side.name === slow && where === "feedkey") await sleep(300);
        return gf(...q);
      };
      const ic = pm.onInstanceConnected;
      pm.onInstanceConnected = async (...x) => {
        // The slow side: its handler reaches replicate() well after the
        // other side has opened its channels.
        if (side.name === slow && where === "connect") await sleep(300);
        await ic(...x);
        done.connected = true;
      };
      return { pm, done };
    };
    const A = node(a), B = node(b);
    const [s1, s2] = await socketPair();
    const x = new NoiseSecretStream(true, s1), y = new NoiseSecretStream(false, s2);
    x.on("error", () => {}); y.on("error", () => {});
    let closed = false;
    x.once("close", () => { closed = true; }); y.once("close", () => { closed = true; });
    A.pm._handleConnection(x, {});
    B.pm._handleConnection(y, {});
    t.after(() => { x.destroy(); y.destroy(); });

    // Wait for both handlers to FINISH (replicate attached), not just start.
    // (The instance-key both ways is implied by the in-feeds opening.)
    assert.ok(await until(() => A.done.connected && B.done.connected, 8000), "both siblings replicating");
    assert.ok(await until(() => a.mgr.inFeeds.has(b.id) && b.mgr.inFeeds.has(a.id), 5000), "in-feeds open");
    await writeAndEmit(a, 770001, "from a");
    await writeAndEmit(b, 770002, "from b");
    assert.ok(await until(() => hasMemory(b.db, 770001), 5000), "a -> b replicates");
    assert.ok(await until(() => hasMemory(a.db, 770002), 5000), "b -> a replicates");
    await sleep(200);
    assert.equal(closed, false, "the sibling link stays open");
  });
}
