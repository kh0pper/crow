// D7 — one-shot providers backfill per peer generation (new-pairing counterpart
// to D2's no-op suppression). Outgoing sync feeds are per-peer Hypercores born
// EMPTY at first pairing (no history replay); before this branch the boot
// reconciler's unconditional re-emit was accidentally how a new peer ever
// learned this instance's provider rows. D2 killed that — this backfill is the
// deliberate delivery channel, flagged PER PEER so every future pairing (not
// just the deploy transition) gets one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

// Capturing out-feed stub: emitChange broadcasts the SIGNED entry to every
// armed peer feed via feed.append(entry) — the appended entries ARE the wire.
function captureFeed() {
  const entries = [];
  return { entries, append: async (e) => entries.push(e) };
}

function freshMgr(label, id) {
  const d = mkdtempSync(join(tmpdir(), `crow-prov-backfill-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe" });
  after(() => rmSync(d, { recursive: true, force: true }));
  const m = new InstanceSyncManager(IDENTITY, createDbClient(join(d, "crow.db")), id);
  m.feedsDisabled = false;
  return m;
}

const FLAG = (peerId) => `__providers_backfill_v1:${peerId}`;

async function flagValue(db, peerId) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [FLAG(peerId)],
  });
  return rows[0]?.value ?? null;
}

test("backfillProvidersForNewPeers: fresh peer → syncable (tailnet) row appended, loopback dropped by shouldSyncRow, flag done:*; second run is a no-op", async () => {
  const m = freshMgr("fresh", "local-1");
  const feed = captureFeed();
  m.outFeeds.set("peer-1", feed);
  await m.db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES ('prov-tailnet', 'http://100.118.41.122:8003/v1', '[\"m1\"]')" });
  await m.db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES ('prov-loop', 'http://127.0.0.1:9999/v1', '[\"m2\"]')" });

  const n = await m.backfillProvidersForNewPeers();
  assert.equal(n, 1, "only the tailnet row counts as emitted (loopback dropped inside emitChange)");
  assert.equal(feed.entries.length, 1, "exactly one entry appended to the peer feed");
  assert.equal(feed.entries[0].table, "providers");
  assert.equal(feed.entries[0].row.id, "prov-tailnet");
  assert.ok(!feed.entries.some((e) => e.row.id === "prov-loop"), "loopback row never rides the wire");
  // Wire hygiene rides along (D3): bookkeeping columns stripped by emitChange.
  assert.equal(feed.entries[0].row.created_at, undefined, "EXCLUDED_COLUMNS strip applies to the backfill emit too");
  assert.match(await flagValue(m.db, "peer-1"), /^done:1$/, "per-peer flag written as done:<emitted>");

  // (b) Second call: flag is terminal → 0 emitted, feed length unchanged.
  assert.equal(await m.backfillProvidersForNewPeers(), 0, "flag-guarded second run is a no-op");
  assert.equal(feed.entries.length, 1, "no re-append on the guarded second run");
});

test("backfillProvidersForNewPeers: no armed peers → returns 0, NO flag written (retryable); backfills once feeds arm", async () => {
  const m = freshMgr("nopeers", "local-2");
  await m.db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES ('prov-a', 'http://100.118.41.122:8003/v1', '[]')" });
  assert.equal(await m.backfillProvidersForNewPeers(), 0);
  const { rows } = await m.db.execute({ sql: "SELECT key FROM dashboard_settings WHERE key LIKE '__providers_backfill_v1:%'" });
  assert.equal(rows.length, 0, "peerless run writes NO flags — boot can race feed-init (contacts lesson)");
  // Feeds arm later (e.g. next boot) → the backfill runs then.
  const feed = captureFeed();
  m.outFeeds.set("peer-1", feed);
  assert.equal(await m.backfillProvidersForNewPeers(), 1, "retry with armed feeds must backfill");
  assert.equal(feed.entries.length, 1);
  assert.match(await flagValue(m.db, "peer-1"), /^done:1$/);
});

test("backfillProvidersForNewPeers: flag semantics — only 'done:*' is terminal; a stale non-done value is overwritten (UPSERT)", async () => {
  const m = freshMgr("staleflag", "local-3");
  const feed = captureFeed();
  m.outFeeds.set("peer-1", feed);
  await m.db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES ('prov-a', 'http://100.118.41.122:8003/v1', '[]')" });
  // A stale non-done flag (pre-fix code class of bug) must NOT be terminal.
  await m.db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, 'no-peers', datetime('now'))",
    args: [FLAG("peer-1")],
  });
  assert.equal(await m.backfillProvidersForNewPeers(), 1, "stale non-done flag is not terminal — backfill runs");
  assert.match(await flagValue(m.db, "peer-1"), /^done:1$/, "done-mark UPSERTs over the stale row");
  assert.equal(await m.backfillProvidersForNewPeers(), 0, "terminal after the real run");
  assert.equal(feed.entries.length, 1);
});

test("backfillProvidersForNewPeers: two peers, one already done → runs for the new peer; broadcast reaches BOTH feeds (accepted re-delivery cost); done peer's flag untouched", async () => {
  const m = freshMgr("twopeers", "local-4");
  const oldFeed = captureFeed();
  const newFeed = captureFeed();
  m.outFeeds.set("peer-old", oldFeed);
  m.outFeeds.set("peer-new", newFeed);
  await m.db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES ('prov-a', 'http://100.118.41.122:8003/v1', '[]')" });
  await m.db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, 'done:5', datetime('now'))",
    args: [FLAG("peer-old")],
  });

  assert.equal(await m.backfillProvidersForNewPeers(), 1, "one unflagged peer arms the backfill");
  assert.equal(newFeed.entries.length, 1, "new peer receives the backfill");
  // emitChange broadcasts to ALL peers — the already-done peer receives the
  // re-emit too. That is the ACCEPTED cost (same as the contacts backfill):
  // an already-current peer converges it as re-delivery noise (rowsEquivalent
  // → silent skip, or a plain newer-lamport UPDATE with identical values).
  assert.equal(oldFeed.entries.length, 1, "broadcast also appends to the already-done peer's feed (documented accepted cost)");
  assert.match(await flagValue(m.db, "peer-new"), /^done:1$/, "new peer's flag written");
  assert.equal(await flagValue(m.db, "peer-old"), "done:5", "already-done peer's flag left untouched");
});

test("backfillProvidersForNewPeers: disabled provider rows ARE emitted — disabled=1 is a synced fact (disableProvider emits it)", async () => {
  const m = freshMgr("disabled", "local-5");
  const feed = captureFeed();
  m.outFeeds.set("peer-1", feed);
  await m.db.execute({ sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES ('prov-off', 'http://100.121.254.89:8004/v1', '[]', 1)" });
  assert.equal(await m.backfillProvidersForNewPeers(), 1, "disabled row still emitted — the peer must learn the disabled state");
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].row.id, "prov-off");
  assert.equal(Number(feed.entries[0].row.disabled), 1, "disabled state rides the wire");
});
