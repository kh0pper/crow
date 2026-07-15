# Item 2d — Feed-Key Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a paired instance's outbound Hypercore feed key changes, the peer swaps its in-feed live (no restart) and its applied-seq record follows the feed it was earned on — closing defects D1–D4 of spec `docs/superpowers/specs/2026-07-15-feed-key-rotation-design.md` (rev 4, READY; read it first — §3 is the contract, §7 the gate, §11 the review record with three R3 must-fixes already folded).

**Architecture:** Key-aware `_initInstanceInner` (swap = detach listener → unmap → bounded close → open new core in the same multi-core store dir → reconcile applied-seq → attach to live streams), feed-keyed `{k,s}` applied-seq records with the legacy decision frozen at feed-open, stream tracking for late-key attach, a 60s heal loop, and boot-time backfill-flag premise reset. No schema bump.

**Tech Stack:** Node 20, hypercore 11.27.7 (vendored), @hyperswarm/secret-stream, node:test, SQLite (libsql client), ws.

## Global Constraints

- **Suite runs on scratch env ONLY** (prod-contamination incidents on record):
  `T=$(mktemp -d); CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1 node --test tests/<file>.test.js`
- Real `initInstance` in tests REQUIRES `mgr.dataDir = <mkdtemp>` (else it writes `~/.crow/data/instance-sync/`).
- Managers built by test harnesses must force-enable feeds (`mgr.feedsDisabled = false`) because the scratch env sets `CROW_DISABLE_INSTANCE_SYNC=1` (2c C6 lesson).
- Suite baseline: **1953 pass / 2 known fails (both bundles-validate-install) / 0 skips.** Any third failure is yours.
- Git: positional-path commits only (`git add <newfile>` first, then `git commit <paths> -m ...`); verify `git show --stat HEAD` after every commit; never `--amend`; no backticks in `-m`; never attribute Claude.
- Every guard gets a **mutation check**: comment it out, watch the NAMED test go red, restore. Record the matrix.
- **No new unbounded awaits reachable from boot** (2c boot-liveness lesson). The only new boot await is the 5s-capped close.
- Branch: `feat/item2d-feed-key-rotation` (spec revs already on it).
- Barriers and wrapped promises in tests, never sleeps (R3 F-G).

## File Structure

- Modify: `servers/sharing/instance-sync.js` — C1 swap + C2 seq format/reconcile + C3 streams + C5 flag reset + shared key validation (the file is the established home of all feed lifecycle logic).
- Modify: `servers/sharing/tailnet-sync.js` — `:238` null-key init (F3), C4 refresh heal, client-side validate-before-init.
- Modify: `servers/sharing/boot.js` — validation before persist in `onInstanceKeyReceived`.
- Modify: `servers/gateway/boot/mcp-mounts.js` — C5 call between eager-init and the once-backfills.
- Create: `tests/feed-rotation.test.js` — the executable gate (G1–G13), real feeds + real replication.
- Modify: `tests/instance-sync.test.js` — F6 migration (stub-feed `.key`, new signatures, Test-3 non-vacuity comment).

---

### Task 1: Rotation harness + baseline real-replication proof

**Files:**
- Create: `tests/feed-rotation.test.js`
- Reference (read, don't copy blindly): `tests/lamport-reemit.test.js` (its `newFleet()` builds two managers on real init-db SQLite), `tests/instance-sync.test.js:40-107`.

**Interfaces:**
- Produces: `makeFleet()` → `{ a, b, cleanup }` where each side is `{ mgr, db, dir, id }`; `linkPeers(a, b)` → `{ streams: [nsA, nsB], close() }` — real NoiseSecretStream pair over a real TCP socketpair, both managers replicating. Later tasks build every G-case on these two helpers.
- Consumes: `InstanceSyncManager`, `initDb` (however `lamport-reemit.test.js` obtains per-side DBs — reuse its exact mechanism), `deriveIdentity` or the identity shape used there (both managers MUST share one identity — entries are verified against the shared ed25519).

- [ ] **Step 1: Write the harness + a baseline test that must FAIL only because the file is new (it exercises existing behavior, so it should PASS once the harness is right — the "red" here is harness bugs, which you fix until green).**

```js
/**
 * Item 2d gate: feed-key rotation (spec 2026-07-15-feed-key-rotation-design.md §7).
 * REAL Hypercores + REAL replication over NoiseSecretStream on a TCP socketpair —
 * the existing suites apply entries directly and cannot see replication-layer
 * defects (that blindness is what let D1/D2 ship).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
// DB + identity setup: copy the exact per-side mechanism from tests/lamport-reemit.test.js
// (real init-db SQLite per side, one SHARED identity object for both managers).

async function makeSide(identity, id) {
  const dir = mkdtempSync(join(tmpdir(), `rot-${id}-`));
  const db = await makeRealDb(dir); // ← same helper style as lamport-reemit.test.js
  const mgr = new InstanceSyncManager(identity, db, id);
  mgr.dataDir = join(dir, "instance-sync"); // MUST: keep test feeds out of ~/.crow
  mgr.feedsDisabled = false;                // MUST: scratch env disables feeds (2c C6)
  return { mgr, db, dir, id };
}

export async function makeFleet() {
  const identity = makeSharedIdentity(); // same object for both sides
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
    const server = net.createServer((serverSide) => {
      server.close();
      resolve([serverSide, clientSide]);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      var clientSide = net.connect(server.address().port, "127.0.0.1");
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
  try {
    // Arm feeds by exchanging real keys BEFORE linking (linkPeers does both).
    const link = await linkPeers(fleet.a, fleet.b);
    await fleet.a.mgr.emitChange("memories", "insert",
      { id: "rot-g0", content: "hello", lamport_ts: null });
    const applied = await until(async () => {
      const { rows } = await fleet.b.db.execute({
        sql: "SELECT id FROM memories WHERE id = ?", args: ["rot-g0"] });
      return rows.length === 1;
    });
    assert.equal(applied, true, "row emitted on A must apply on B via real replication");
    link.close();
  } finally { await fleet.cleanup(); }
});
```

Fill `makeRealDb` / `makeSharedIdentity` / `registerPeerRow` from `tests/lamport-reemit.test.js`'s working pattern — do NOT invent a parallel mechanism; that harness already solved per-side init-db, the shared identity, and the `crow_instances` row shape.

- [ ] **Step 2: Run it**

Run: `T=$(mktemp -d); CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1 node --test tests/feed-rotation.test.js`
Expected: `G0` PASS (iterate on harness bugs until it does; typical failures: identity not shared → signature warns; dataDir not set → feeds land in `$T` fine but assert it, never `~/.crow`).

- [ ] **Step 3: Commit**

```bash
git add tests/feed-rotation.test.js
git commit tests/feed-rotation.test.js -m "test(sync): 2d gate harness -- two managers, real hypercores, real NoiseSecretStream replication over a TCP socketpair (G0 baseline)"
```

---

### Task 2: C2 storage format — feed-keyed `{k,s}` applied-seq + F6 suite migration

**Files:**
- Modify: `servers/sharing/instance-sync.js:2649-2699` (`_getLastAppliedSeq`, `_setLastAppliedSeq`), `:2704-2721` (`getSyncStatus`), `:1404-1420` (`_processNewEntriesInner`).
- Modify: `tests/instance-sync.test.js` (`makeStubFeed` :98-107; direct seq callers :243, :270, :288-293, :354; every `_processNewEntries` call on a stub feed — ~20 sites).

**Interfaces:**
- Produces: `_setLastAppliedSeq(remoteInstanceId, seq, feedKeyHex)` (writes `{"k":feedKeyHex,"s":seq}` via `json(?)`); `_getLastAppliedSeq(remoteInstanceId, feed)` (key-gated; `feed=null` → coerce both shapes to a number); `_appliedSeqRecord(remoteInstanceId)` (internal: returns the raw parsed record or null). `_processNewEntriesInner` bails at entry when `this.inFeeds.get(id) !== feed` **unless the feed was passed explicitly by a caller that isn't tracking inFeeds (the existing test suite drives stub feeds)** — implement the bail as: `const current = this.inFeeds.get(remoteInstanceId); if (current !== undefined && current !== feed) return;` (an unmapped peer — `undefined` — still processes, preserving the stub-feed tests' semantics; a REPLACED feed bails).
- Consumes: Task 1's harness (for one integration case); the rest are unit-level in the existing file's style.

- [ ] **Step 1: Write failing unit tests (append to `tests/feed-rotation.test.js` — unit section)**

```js
test("C2 unit: set writes {k,s} object; get is key-gated; null-feed coerces both shapes", async () => {
  const fleet = await makeFleet();
  try {
    const { mgr, db } = fleet.a;
    const PEER = fleet.b.id;
    const keyX = "aa".repeat(32), keyY = "bb".repeat(32);
    await mgr._setLastAppliedSeq(PEER, 7, keyX);
    // Raw storage shape: a JSON object, not a string (spec C2 SQL note / R2 #7).
    const { rows } = await db.execute({
      sql: "SELECT last_applied_seq_per_peer AS b FROM sync_state WHERE instance_id = ?",
      args: [mgr.localInstanceId] });
    const rec = JSON.parse(rows[0].b)[PEER];
    assert.equal(typeof rec, "object", "must store an object, not a JSON string");
    assert.equal(rec.k, keyX); assert.equal(rec.s, 7);
    // Key-gated reads:
    assert.equal(await mgr._getLastAppliedSeq(PEER, { key: Buffer.from(keyX, "hex") }), 7);
    assert.equal(await mgr._getLastAppliedSeq(PEER, { key: Buffer.from(keyY, "hex") }), 0,
      "foreign-key record must read 0");
    // Display path (feed=null) coerces the object:
    assert.equal(await mgr._getLastAppliedSeq(PEER, null), 7);
    // Legacy numeric display coercion (R3 F-F): write a bare number the old way.
    await db.execute({
      sql: `UPDATE sync_state SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer,'{}'), ?, 42) WHERE instance_id = ?`,
      args: [`$."${PEER}"`, mgr.localInstanceId] });
    assert.equal(await mgr._getLastAppliedSeq(PEER, null), 42, "legacy bare number coerces");
  } finally { await fleet.cleanup(); }
});
```

- [ ] **Step 2: Run — expect FAIL** (`_setLastAppliedSeq` takes 2 args today; stored shape is numeric).

- [ ] **Step 3: Implement.** Replace the two methods (keep the `"` guard and `json_set` atomicity comment):

```js
  /**
   * Applied-seq record, keyed to the feed it was earned on (2d C2).
   * Shape: {"k": "<feedKeyHex>", "s": <nextUnprocessedSeq>}. Legacy bare
   * numbers exist on disk until _reconcileAppliedSeqAtOpen upgrades them.
   */
  async _appliedSeqRecord(remoteInstanceId) {
    try {
      const { rows } = await this.db.execute({
        sql: "SELECT last_applied_seq_per_peer FROM sync_state WHERE instance_id = ?",
        args: [this.localInstanceId],
      });
      if (rows.length > 0 && rows[0].last_applied_seq_per_peer) {
        const rec = JSON.parse(rows[0].last_applied_seq_per_peer)[remoteInstanceId];
        return rec === undefined ? null : rec;
      }
    } catch {}
    return null;
  }

  /**
   * Key-gated read (2d C2). feed=null is the display path: coerce BOTH shapes
   * (legacy bare number → itself; {k,s} → s) — never used to gate application.
   * A record whose k differs from the feed's key belongs to a dead feed → 0.
   * A legacy numeric reaching a keyed read is treated as foreign (defensive;
   * reconcile-at-open makes it unreachable in production).
   */
  async _getLastAppliedSeq(remoteInstanceId, feed = null) {
    const rec = await this._appliedSeqRecord(remoteInstanceId);
    if (rec === null) return 0;
    if (feed == null) return typeof rec === "number" ? rec : Number(rec.s) || 0;
    if (typeof rec !== "object") return 0;
    const feedKeyHex = feed.key ? Buffer.from(feed.key).toString("hex") : null;
    return rec.k === feedKeyHex ? Number(rec.s) || 0 : 0;
  }

  async _setLastAppliedSeq(remoteInstanceId, seq, feedKeyHex) {
    if (remoteInstanceId.includes('"')) {
      console.warn(`[instance-sync] _setLastAppliedSeq: skipping id with quote char: ${remoteInstanceId}`);
      return;
    }
    try {
      await this._ensureCounter();
      // json(?) — NOT CAST — so the object lands as JSON, not a quoted string
      // (spec C2 SQL note): json_set with a plain string param stores a string
      // and every reader's .k/.s would be undefined.
      await this.db.execute({
        sql: `UPDATE sync_state
              SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer, '{}'), ?, json(?)),
                  updated_at = datetime('now')
              WHERE instance_id = ?`,
        args: [`$."${remoteInstanceId}"`, JSON.stringify({ k: feedKeyHex ?? null, s: Number(seq) }), this.localInstanceId],
      });
    } catch (err) {
      console.warn(`[instance-sync] Failed to update checkpoint for ${remoteInstanceId}:`, err.message);
    }
  }
```

In `_processNewEntriesInner` (`:1404`):

```js
  async _processNewEntriesInner(remoteInstanceId, feed) {
    // 2d C1/C2 (R1 F1): a run bound to a REPLACED feed must not read or stamp
    // the successor's record. `undefined` (peer unmapped / stub-feed harness)
    // still processes — only a swapped-out feed bails.
    const current = this.inFeeds.get(remoteInstanceId);
    if (current !== undefined && current !== feed) return;
    const feedKeyHex = feed.key ? Buffer.from(feed.key).toString("hex") : null;
    const lastSeq = await this._getLastAppliedSeq(remoteInstanceId, feed);
    for (let seq = lastSeq; seq < feed.length; seq++) {
      try {
        const entry = await feed.get(seq);
        await this._applyEntry(remoteInstanceId, entry);
      } catch (err) {
        console.warn(`[instance-sync] Failed to process entry ${seq} from ${remoteInstanceId}:`, err.message);
      }
      // Stamp with the PROCESSED feed's key (2d C2 / R1 F1) — never "the
      // current in-feed": a stale run must leave a record the successor's
      // key-gated reads ignore.
      await this._setLastAppliedSeq(remoteInstanceId, seq + 1, feedKeyHex);
    }
  }
```

In `getSyncStatus` (`:2704`), replace the `_getLastAppliedSeq(instanceId)` call with `_getLastAppliedSeq(instanceId, inFeed ?? null)`.

- [ ] **Step 4: Migrate `tests/instance-sync.test.js` (F6, scope per spec §7).**
  - `makeStubFeed` gains a key:
    ```js
    function makeStubFeed(keyHex = randomBytes(32).toString("hex")) {
      const feed = {
        key: Buffer.from(keyHex, "hex"),
        entries: [],
        get length() { return feed.entries.length; },
        async get(seq) { return feed.entries[seq]; },
        push(entry) { feed.entries.push(entry); return feed.entries.length - 1; },
      };
      return feed;
    }
    ```
    (add `randomBytes` to the file's `node:crypto` import).
  - Direct callers: `_setLastAppliedSeq(PEER, n)` → `_setLastAppliedSeq(PEER, n, "aa".repeat(32))` (or the driving feed's key where one exists); `_getLastAppliedSeq(PEER)` → `_getLastAppliedSeq(PEER, feed)` where the test has a feed, else `(PEER, null)`.
  - **Test 3 non-vacuity (spec §7 / R2 #3):** its `feed2` MUST be built with the SAME key as `feed` — `const feed2 = makeStubFeed(feed.key.toString("hex"))` — with the comment: `// SAME key as feed: different keys would make the key-gate return 0 and the "seqs 0-1 not re-applied" assertion pass vacuously (2a vacuous-test tell).`
  - Any test seeding a checkpoint by raw SQL keeps working via the reader's both-shape coercion — leave those as legacy-shape coverage.

- [ ] **Step 5: Run both files**

Run: `T=$(mktemp -d); CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1 node --test tests/feed-rotation.test.js tests/instance-sync.test.js`
Expected: all PASS (Test 3 must still exercise resumption — eyeball its assertions ran non-vacuously by temporarily giving `feed2` a different key and watching it still pass for the WRONG reason, then restoring the same-key line; that manual check is the mutation for this task).

- [ ] **Step 6: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/feed-rotation.test.js tests/instance-sync.test.js -m "feat(sync): feed-keyed applied-seq records -- {k,s} via json(), key-gated reads, processed-feed stamping, stub-feed suite migration (2d C2 core)"
```

---

### Task 3: C2 reconcile-at-open — the frozen legacy/rotation decision

**Files:**
- Modify: `servers/sharing/instance-sync.js` — new `_reconcileAppliedSeqAtOpen`; call it in `_initInstanceInner`'s in-feed open path (between `await inFeed.ready()` and wiring the `append` listener).
- Test: `tests/feed-rotation.test.js` (G4a, G4b, G4c, G6b).

**Interfaces:**
- Produces: `_reconcileAppliedSeqAtOpen(remoteInstanceId, feed)` — freezes the record for this feed exactly once per open. Task 4's swap path relies on it running on EVERY open (it does — it's in the open path, and rotation opens go through the same path).
- Consumes: Task 2's record shape + accessors.

- [ ] **Step 1: Failing tests**

```js
test("G4a/G4b: legacy numeric adopted when n <= length at open; reset when n > length", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    // Build a real feed pair, replicate 3 entries so B's in-feed has length 3.
    const link = await linkPeers(a, b);
    for (let i = 0; i < 3; i++) {
      await a.mgr.emitChange("memories", "insert", { id: `g4-${i}`, content: "x", lamport_ts: null });
    }
    await until(async () => (b.mgr.inFeeds.get(a.id)?.length ?? 0) >= 3);
    link.close();
    // Simulate legacy state: overwrite B's record with a bare number, then
    // force a re-open (close feeds, re-init) — reconcile must run at open.
    const K = b.mgr.inFeeds.get(a.id).key.toString("hex");
    await b.db.execute({
      sql: `UPDATE sync_state SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer,'{}'), ?, 2) WHERE instance_id = ?`,
      args: [`$."${a.id}"`, b.mgr.localInstanceId] });
    await b.mgr.closeInstanceFeeds(a.id);
    await b.mgr.initInstance(a.id, Buffer.from(K, "hex"));   // n=2 <= length 3 → adopt
    let rec = await b.mgr._appliedSeqRecord(a.id);
    assert.deepEqual({ k: rec.k, s: rec.s }, { k: K, s: 2 }, "G4a: adopted as {k, s:n}");
    // G4b: n > length → provably foreign → reset to 0.
    await b.db.execute({
      sql: `UPDATE sync_state SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer,'{}'), ?, 99) WHERE instance_id = ?`,
      args: [`$."${a.id}"`, b.mgr.localInstanceId] });
    await b.mgr.closeInstanceFeeds(a.id);
    await b.mgr.initInstance(a.id, Buffer.from(K, "hex"));
    rec = await b.mgr._appliedSeqRecord(a.id);
    assert.deepEqual({ k: rec.k, s: rec.s }, { k: K, s: 0 }, "G4b: impossible mark reset to 0");
  } finally { await fleet.cleanup(); }
});

test("G4c burst-crossing: legacy n vs fresh rotated feed that replicates a backlog past n in one link", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    // A pre-populates FIVE entries in its out-feed to B while UNLINKED (so the
    // whole backlog arrives as one burst after B opens its fresh in-feed).
    await a.mgr.initInstance(b.id, null);
    for (let i = 0; i < 5; i++) {
      await a.mgr.emitChange("memories", "insert", { id: `g4c-${i}`, content: "x", lamport_ts: null });
    }
    // B holds a stale legacy mark n=3 for A (as if earned on a long-dead feed).
    await b.db.execute({
      sql: `UPDATE sync_state SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer,'{}'), ?, 3) WHERE instance_id = ?`,
      args: [`$."${a.id}"`, b.mgr.localInstanceId] });
    // B opens A's feed fresh (length 0 at open → reset to {k,s:0}), THEN the
    // burst replicates. Lazy evaluation would flip to "trust 3" once length=5.
    const link = await linkPeers(a, b);
    const allApplied = await until(async () => {
      const { rows } = await b.db.execute({
        sql: "SELECT COUNT(*) AS n FROM memories WHERE id LIKE 'g4c-%'" });
      return Number(rows[0].n) === 5;
    });
    assert.equal(allApplied, true, "entries 0..2 must NOT be skipped (burst-crossing, R1 F2)");
    link.close();
  } finally { await fleet.cleanup(); }
});

test("G6b: a restarted manager (same dirs+DB, new objects) completes a rotation via reconcile", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: "g6b-pre", content: "x", lamport_ts: null });
    await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id='g6b-pre'" })).rows.length === 1);
    link.close();
    // A "rotates": wipe its out-feed dir for B and re-init → new key minted.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    // B "restarts": build a NEW manager over B's same db+dataDir, sync_url = new key.
    await b.mgr.close();
    const b2mgr = new (b.mgr.constructor)(b.mgr.identity, b.db, b.mgr.localInstanceId);
    b2mgr.dataDir = b.mgr.dataDir; b2mgr.feedsDisabled = false;
    await b2mgr.initInstance(a.id, newKey); // reconcile: k differs → {k:new, s:0}
    const rec = await b2mgr._appliedSeqRecord(a.id);
    assert.equal(rec.k, newKey.toString("hex"));
    assert.equal(rec.s, 0, "restart completes rotation: record reset for the new feed");
    await b2mgr.close();
    b.mgr = b2mgr; // let cleanup close the live one
  } finally { await fleet.cleanup(); }
});
```

- [ ] **Step 2: Run — expect G4a/G4b/G4c/G6b FAIL** (no reconcile exists; legacy numeric is treated as foreign → G4a fails; G4c may pass accidentally — verify it fails for the right reason by checking the record after open; if it passes, tighten: assert the record equals `{k,s:0}` immediately after `linkPeers` opened the feed and before the burst lands).

- [ ] **Step 3: Implement** — in `instance-sync.js`, next to the seq accessors:

```js
  /**
   * Freeze the applied-seq decision for THIS feed, once, at open (2d C2 /
   * R1 F2). Runs inside the _initLocks chain before the append listener is
   * wired, so feed.length cannot grow concurrently:
   *   {k,s} k matches   → keep (normal restart)
   *   {k,s} k differs   → rotated → {k: this feed, s: 0}
   *   legacy numeric n  → n <= length: plausibly ours → adopt {k, s:n}
   *                       n >  length: provably foreign (a mark earned on F
   *                       satisfies n <= F.length) → {k, s:0}
   * NEVER re-derived later: lazy evaluation flips to "trust" once a burst
   * pushes length past n (R1 F2's hole).
   */
  async _reconcileAppliedSeqAtOpen(remoteInstanceId, feed) {
    const feedKeyHex = feed.key ? Buffer.from(feed.key).toString("hex") : null;
    const rec = await this._appliedSeqRecord(remoteInstanceId);
    if (rec === null) { await this._setLastAppliedSeq(remoteInstanceId, 0, feedKeyHex); return; }
    if (typeof rec === "object") {
      if (rec.k === feedKeyHex) return; // normal restart — keep
      console.warn(`[instance-sync] applied-seq record for ${remoteInstanceId.slice(0,12)}… belonged to a dead feed — reset to 0`);
      await this._setLastAppliedSeq(remoteInstanceId, 0, feedKeyHex);
      return;
    }
    const n = Number(rec) || 0;
    const adopted = n <= feed.length ? n : 0;
    if (adopted !== n) {
      console.warn(`[instance-sync] legacy applied-seq ${n} > feed length ${feed.length} for ${remoteInstanceId.slice(0,12)}… — provably foreign, reset to 0`);
    }
    await this._setLastAppliedSeq(remoteInstanceId, adopted, feedKeyHex);
  }
```

Call it in `_initInstanceInner`'s in-feed branch, after `await inFeed.ready()` and **before** `inFeed.on("append", ...)`:

```js
      await inFeed.ready();
      // 2d C2: freeze the applied-seq decision for this feed BEFORE any
      // replication can grow it (listener not wired yet; feed unattached).
      await this._reconcileAppliedSeqAtOpen(remoteInstanceId, inFeed);
```

- [ ] **Step 4: Run — expect PASS.** Then the **mutation checks** (do each, watch the NAMED test go red, restore):
  1. Remove the legacy-adopt branch (always reset) → **G4a red**.
  2. Remove the `n > length` impossibility check (always adopt) → **G4b red**.
  3. Re-introduce lazy evaluation: skip `_reconcileAppliedSeqAtOpen` and instead put the legacy rule inside `_getLastAppliedSeq` → **G4c red**.
  4. Remove reconcile call entirely → **G6b red**.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/feed-rotation.test.js -m "feat(sync): applied-seq reconcile frozen at feed open -- legacy adopt/reset by length impossibility, rotation reset on key mismatch (2d C2, gates G4a/G4b/G4c/G6b)"
```

---

### Task 4: C1 — the live swap (rotation branch, bounded close, defer machinery)

**Files:**
- Modify: `servers/sharing/instance-sync.js` — constructor (`:286-314`: add `this._inFeedListeners = new Map()`, `this._deferredRotations = new Set()`), `_initInstanceInner` (`:439-474`: rotation branch + try/catch open + listener refs), `_closeInstanceFeedsInner` (`:2747`: clear `_inFeedListeners` + `_deferredRotations`), new `boundedClose` helper.
- Test: `tests/feed-rotation.test.js` (G1, G5, G6, G6c, G12).

**Interfaces:**
- Produces: the rotation behavior itself; `_deferredRotations: Set<peerId>`; `_inFeedListeners: Map<peerId, fn>`. Task 6 attaches streams inside the same open path; Task 7's G13 and Task 8's C4 both go through `initInstance` unchanged.
- Consumes: Tasks 2-3 (reconcile + key-gated records).

- [ ] **Step 1: Failing tests**

```js
test("G1: live rotation single actor -- B swaps without restart, new emits apply, conflicts flat", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    let link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: "g1-pre", content: "x", lamport_ts: null });
    await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id='g1-pre'" })).rows.length === 1);
    const conflictsBefore = Number((await b.db.execute({ sql: "SELECT COUNT(*) AS n FROM sync_conflicts" })).rows[0].n);
    link.close();
    // A rotates its out-feed to B (storage wiped, new key minted).
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    const oldFeed = b.mgr.inFeeds.get(a.id);
    // Key delivered to B live (as every receipt point does) — NO b restart:
    await b.mgr.initInstance(a.id, newKey);
    assert.notEqual(b.mgr.inFeeds.get(a.id), oldFeed, "in-feed object must be swapped");
    assert.equal(b.mgr.inFeeds.get(a.id).key.toString("hex"), newKey.toString("hex"));
    // Replication resumes on a fresh link; post-rotation emit applies.
    link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: "g1-post", content: "y", lamport_ts: null });
    const applied = await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id='g1-post'" })).rows.length === 1);
    assert.equal(applied, true, "post-rotation emit must apply with no restart on B");
    const conflictsAfter = Number((await b.db.execute({ sql: "SELECT COUNT(*) AS n FROM sync_conflicts" })).rows[0].n);
    assert.equal(conflictsAfter, conflictsBefore, "sync_conflicts flat");
    link.close();
  } finally { await fleet.cleanup(); }
});

test("G5: same-key re-exchange is a no-op -- feed identity and seq preserved", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: "g5", content: "x", lamport_ts: null });
    await until(async () => (await b.mgr._getLastAppliedSeq(a.id, b.mgr.inFeeds.get(a.id))) >= 1);
    const feedBefore = b.mgr.inFeeds.get(a.id);
    const seqBefore = await b.mgr._getLastAppliedSeq(a.id, feedBefore);
    await b.mgr.initInstance(a.id, a.mgr.getOutFeedKey(b.id)); // same key again
    assert.equal(b.mgr.inFeeds.get(a.id), feedBefore, "same feed object");
    assert.equal(await b.mgr._getLastAppliedSeq(a.id, feedBefore), seqBefore, "seq untouched");
    link.close();
  } finally { await fleet.cleanup(); }
});

test("G6/G6c: hung close defers boundedly; reopen attempts do not throw; settle (resolve OR reject) un-defers and heals", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    const oldFeed = b.mgr.inFeeds.get(a.id);
    // Injection seam (R3 F-G): wrap the REAL feed's close in a controllable promise.
    let settle;
    const gate = new Promise((res) => { settle = res; });
    const realClose = oldFeed.close.bind(oldFeed);
    oldFeed.close = () => gate.then(() => realClose());
    // Rotate A, deliver the new key to B: close hangs → defer within the cap.
    link.close();
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    const t0 = Date.now();
    await b.mgr.initInstance(a.id, newKey);          // must return, not hang
    assert.ok(Date.now() - t0 < 8000, "G6: bounded (5s cap + slack), no hang");
    assert.equal(b.mgr.inFeeds.has(a.id), false, "deferred: no in-feed mapped");
    assert.ok(b.mgr._deferredRotations.has(a.id), "deferred set");
    // G6c: subsequent attempts (the C4-interval shape) must NOT throw.
    await assert.doesNotReject(() => b.mgr.initInstance(a.id, newKey));
    assert.equal(b.mgr.inFeeds.has(a.id), false, "still suppressed while lock held");
    // Now the slow close settles → un-defer → next call completes the rotation.
    settle();
    await until(() => !b.mgr._deferredRotations.has(a.id));
    await b.mgr.initInstance(a.id, newKey);
    assert.equal(b.mgr.inFeeds.get(a.id)?.key.toString("hex"), newKey.toString("hex"), "healed after settle");
  } finally { await fleet.cleanup(); }
});

test("G6c-reject: a REJECTING close un-defers with no unhandled rejection", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    let link = await linkPeers(a, b);
    link.close();
    const oldFeed = b.mgr.inFeeds.get(a.id);
    let reject;
    const gate = new Promise((_, rej) => { reject = rej; });
    oldFeed.close = () => gate; // close() = pending, then REJECTS
    const unhandled = [];
    const onUR = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUR);
    try {
      await a.mgr.closeInstanceFeeds(b.id);
      rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
      await a.mgr.initInstance(b.id, null);
      const newKey = a.mgr.getOutFeedKey(b.id);
      await b.mgr.initInstance(a.id, newKey);           // defers
      reject(new Error("close blew up"));               // the R3 F-A case
      await until(() => !b.mgr._deferredRotations.has(a.id));
      await new Promise((r) => setImmediate(r));        // let any UR surface
      assert.equal(unhandled.length, 0, "no unhandled rejection from the abandoned close");
      assert.equal(b.mgr._deferredRotations.has(a.id), false, "reject also un-defers (.finally)");
    } finally { process.off("unhandledRejection", onUR); }
  } finally { await fleet.cleanup(); }
});

test("G12: in-flight old-feed processing across the swap cannot corrupt the new record", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    // Seed 2 entries and let B apply them (record {k:old, s:2}).
    for (let i = 0; i < 2; i++) await a.mgr.emitChange("memories", "insert", { id: `g12-${i}`, content: "x", lamport_ts: null });
    await until(async () => (await b.mgr._getLastAppliedSeq(a.id, b.mgr.inFeeds.get(a.id))) >= 2);
    // Trap B's _applyEntry so the NEXT processing run parks mid-loop.
    let releaseApply; const applyGate = new Promise((r) => { releaseApply = r; });
    const realApply = b.mgr._applyEntry.bind(b.mgr);
    let trapped = false;
    b.mgr._applyEntry = async (...args) => { if (!trapped) { trapped = true; await applyGate; } return realApply(...args); };
    // Third entry arrives → old-feed run starts and parks inside _applyEntry.
    await a.mgr.emitChange("memories", "insert", { id: "g12-2", content: "x", lamport_ts: null });
    await until(() => trapped);
    link.close();
    // Swap while the old-feed run is mid-flight.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    await b.mgr.initInstance(a.id, newKey);
    releaseApply();                                    // old run resumes, stamps {k:old}
    await new Promise((r) => setTimeout(r, 100));      // let it finish its write
    // The record must be usable by the NEW feed: either {k:new,...} already, or
    // {k:old,...} which the key-gated read maps to 0 — NEVER {k:new, s:oldMark}.
    const rec = await b.mgr._appliedSeqRecord(a.id);
    if (rec.k === newKey.toString("hex")) {
      assert.equal(rec.s, 0, "a new-key record written during the race must be the reset, not the old mark");
    }
    const effective = await b.mgr._getLastAppliedSeq(a.id, b.mgr.inFeeds.get(a.id));
    assert.equal(effective === 0 || rec.k === newKey.toString("hex"), true,
      "new feed must start from 0 -- the old run's stamp must not masquerade under the new key");
    // And a queued post-swap run on the OLD feed must bail with no stamp:
    const before = JSON.stringify(await b.mgr._appliedSeqRecord(a.id));
    const oldFeedRef = { key: Buffer.from("cc".repeat(32), "hex"), length: 50, async get() { throw new Error("n/a"); } };
    await b.mgr._processNewEntries(a.id, oldFeedRef);  // replaced feed → entry bail
    assert.equal(JSON.stringify(await b.mgr._appliedSeqRecord(a.id)), before, "bailed run stamps nothing");
  } finally { await fleet.cleanup(); }
});
```

- [ ] **Step 2: Run — expect G1/G6/G6c/G6c-reject FAIL** (no rotation branch exists; today's `initInstance` no-ops). G5 passes today (it pins the fast path so the swap can't regress it); G12's bail half fails.

- [ ] **Step 3: Implement.** Constructor additions (after `:314`):

```js
    this._inFeedListeners = new Map();  // remoteInstanceId → append handler (2d C1: removable on swap)
    this._deferredRotations = new Set(); // remoteInstanceId → swap deferred, old close still pending (2d C1)
```

`boundedClose` helper (near the class top or as a module function):

```js
/** Race a feed close against a cap. Returns true if it settled in time.
 *  2d C1: the abandoned promise gets .finally-based cleanup at the call site
 *  (.finally, NOT .then — a rejecting close must also un-defer and must not
 *  become an unhandled rejection; R3 F-A). */
async function boundedClose(feed, capMs) {
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(false), capMs); timer.unref?.(); });
  const closed = feed.close().then(() => true, () => true); // settle either way
  const result = await Promise.race([closed, timeout]);
  clearTimeout(timer);
  return result;
}
```

`_initInstanceInner` in-feed section becomes:

```js
    // 2d C1: key-aware — a changed key swaps the open in-feed live.
    const currentIn = this.inFeeds.get(remoteInstanceId);
    if (currentIn && theirFeedKey && !Buffer.from(currentIn.key).equals(theirFeedKey)) {
      const oldKey8 = Buffer.from(currentIn.key).toString("hex").slice(0, 8);
      const newKey8 = theirFeedKey.toString("hex").slice(0, 8);
      const handler = this._inFeedListeners.get(remoteInstanceId);
      if (handler) currentIn.removeListener("append", handler);
      this._inFeedListeners.delete(remoteInstanceId);
      currentIn.on("error", () => {}); // swallow late close-races (R3/R2 #9)
      this.inFeeds.delete(remoteInstanceId); // entry-bail kills queued runs (R1 F1)
      const closePromise = currentIn.close();
      // .finally, NOT .then: a REJECTING close must also un-defer, and the
      // derived promise must never become an unhandled rejection (R3 F-A).
      closePromise.catch(() => {}).finally(() => this._deferredRotations.delete(remoteInstanceId));
      const closed = await Promise.race([
        closePromise.then(() => true, () => true),
        new Promise((res) => { const t = setTimeout(() => res(false), this._rotationCloseCapMs ?? 5000); t.unref?.(); }),
      ]);
      if (!closed) {
        // rocksdb lock still held by the zombie session — a same-dir open
        // would throw. Defer loudly; sync_url is persisted, so a later settle
        // (via the .finally above) or a restart completes the rotation.
        console.error(`[instance-sync] ROTATION DEFERRED for ${remoteInstanceId.slice(0,12)}…: old in-feed close timed out (cap ${this._rotationCloseCapMs ?? 5000}ms); will retry after close settles or on restart`);
        this._deferredRotations.add(remoteInstanceId);
        return this.outFeeds.get(remoteInstanceId);
      }
      console.warn(`[instance-sync] in-feed ROTATED for ${remoteInstanceId.slice(0,12)}…: ${oldKey8}… → ${newKey8}…`);
    }

    if (!this.inFeeds.has(remoteInstanceId) && theirFeedKey
        && !this._deferredRotations.has(remoteInstanceId)) {
      let inFeed = null;
      try {
        inFeed = new Hypercore(resolve(dir, "in"), theirFeedKey, { valueEncoding: "json" });
        await inFeed.ready();
        // 2d C2: freeze the applied-seq decision BEFORE wiring the listener.
        await this._reconcileAppliedSeqAtOpen(remoteInstanceId, inFeed);
        const onAppend = async () => { await this._processNewEntries(remoteInstanceId, inFeed); };
        inFeed.on("append", onAppend);
        this._inFeedListeners.set(remoteInstanceId, onAppend);
        this.inFeeds.set(remoteInstanceId, inFeed);
      } catch (err) {
        // 2d C1 (R2 #1): open failure degrades to out-only — NEVER throws out
        // of initInstance (a still-held lock after a deferred rotation would
        // otherwise kill the tailnet client handshake and, on the C4 interval,
        // crash the gateway via unhandled rejection).
        console.error(`[instance-sync] in-feed open failed for ${remoteInstanceId.slice(0,12)}…: ${err.message} — continuing out-only`);
        if (inFeed) inFeed.close().catch(() => {}); // release partial handle/fd (R3 F-D)
      }
    }
```

(The existing plain open block is replaced by this; note the `_rotationCloseCapMs` field enables the gate to shrink the cap — set `this._rotationCloseCapMs = 200` in G6/G6c tests to keep the suite fast; default 5000 in the constructor.)

`_closeInstanceFeedsInner` additions (with the existing deletions):

```js
    this._inFeedListeners.delete(remoteInstanceId);
    // 2d C1 (R3 F-B): a deferred peer that is revoked then re-paired must not
    // stay suppressed forever.
    this._deferredRotations.delete(remoteInstanceId);
```

- [ ] **Step 4: Run — expect PASS.** Then **mutation checks**:
  1. Remove the key-compare (make the swap branch unreachable) → **G1 red**.
  2. Remove the equality fast-path semantics (force swap even on equal keys — e.g. compare against a wrong buffer) → **G5 red**.
  3. Remove the `Promise.race` cap (await the close directly) → **G6 red** (timeout).
  4. Remove the open try/catch (let open throw) → **G6c red** (`doesNotReject` fails).
  5. Replace `.finally` un-defer with `.then(onFulfilled-only)` → **G6c-reject red**.
  6. Remove the un-defer entirely → **G6c red** (never heals after settle).
  7. Stamp `_setLastAppliedSeq` with the current in-feed's key instead of the processed feed's → **G12 red**.
  8. Remove `_processNewEntriesInner`'s entry bail → **G12 red** (bailed-run half).

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/feed-rotation.test.js -m "feat(sync): live in-feed swap on key change -- bounded close, defer-with-finally un-defer, out-only degrade on open failure (2d C1, gates G1/G5/G6/G6c/G12)"
```

---

### Task 5: Shared feed-key validation at all three receipt points

**Files:**
- Modify: `servers/sharing/instance-sync.js` — new method `validateIncomingFeedKey(remoteInstanceId, feedKeyHex)` → `Buffer | null`.
- Modify: `servers/sharing/boot.js:850-874` (`onInstanceKeyReceived` — validate before persist), `servers/sharing/tailnet-sync.js:249-260` (server) and `:433-452` (client — validate before the `:435` init AND the persist).
- Test: `tests/feed-rotation.test.js` (G11, G11b).

**Interfaces:**
- Produces: `validateIncomingFeedKey(remoteInstanceId, feedKeyHex)` — returns the parsed 32-byte Buffer, or null (logged) for: non-string, non-hex, length ≠ 64 chars, or equal to OUR out-feed key for that peer (self-echo, R1 F7).
- Consumes: `getOutFeedKey` (existing).

- [ ] **Step 1: Failing tests**

```js
test("G11/G11b: malformed and self-echoed feed keys are rejected -- no persist-shape swap, no crash", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    await b.mgr.initInstance(a.id, null); // arm out-feed so self-key exists
    for (const bad of ["zz".repeat(32), "aa".repeat(16), "aa".repeat(33), "", null, 42]) {
      assert.equal(b.mgr.validateIncomingFeedKey(a.id, bad), null, `rejects ${String(bad).slice(0,8)}`);
    }
    const selfKey = b.mgr.getOutFeedKey(a.id).toString("hex");
    assert.equal(b.mgr.validateIncomingFeedKey(a.id, selfKey), null, "G11b: self-echo rejected");
    const good = "ab".repeat(32);
    const buf = b.mgr.validateIncomingFeedKey(a.id, good);
    assert.equal(buf?.toString("hex"), good, "valid key parses");
  } finally { await fleet.cleanup(); }
});
```

- [ ] **Step 2: Run — expect FAIL** (method missing).

- [ ] **Step 3: Implement** in `instance-sync.js`:

```js
  /**
   * Validate a peer-advertised feed key BEFORE persisting or opening (2d C1;
   * R2 #8 persist-gating, R1 F7 self-echo). Returns Buffer or null.
   */
  validateIncomingFeedKey(remoteInstanceId, feedKeyHex) {
    if (typeof feedKeyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(feedKeyHex)) {
      console.warn(`[instance-sync] rejecting malformed feed key from ${String(remoteInstanceId).slice(0,12)}…`);
      return null;
    }
    const ours = this.getOutFeedKey(remoteInstanceId);
    if (ours && ours.toString("hex") === feedKeyHex.toLowerCase()) {
      console.warn(`[instance-sync] rejecting self-echoed feed key from ${String(remoteInstanceId).slice(0,12)}… (would re-apply our own history)`);
      return null;
    }
    return Buffer.from(feedKeyHex, "hex");
  }
```

Wire it (each site: validate FIRST; on null, skip persist AND init):
- `boot.js` `onInstanceKeyReceived`: after the paired-row check (`:856`), before the `sync_url` compare: `const keyBuf = instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, feedKeyHex); if (!keyBuf) return;` — then use `keyBuf` in the `initInstance` call.
- `tailnet-sync.js` server block `:249`: `if (peerKeyMsg?.feed_key_hex && peerKeyMsg.feed_key_hex !== peerRow.sync_url) { const keyBuf = instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, peerKeyMsg.feed_key_hex); if (keyBuf) { …persist…; await instanceSyncManager.initInstance(remoteInstanceId, keyBuf); } }`
- `tailnet-sync.js` client: before `:435` — `const incomingKeyBuf = peerKeyMsg?.feed_key_hex ? instanceSyncManager.validateIncomingFeedKey(remoteInstanceId, peerKeyMsg.feed_key_hex) : null;` (R3 F-E: this path inits before persisting); gate the `:440-452` persist on the same non-null result.

- [ ] **Step 4: Run — PASS. Mutations:** remove the hex/length check → **G11 red**; remove the self-key check → **G11b red**.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js servers/sharing/boot.js servers/sharing/tailnet-sync.js tests/feed-rotation.test.js -m "feat(sync): validate peer feed keys before persist and open -- malformed and self-echo rejected at all three receipt points (2d, gates G11/G11b)"
```

---

### Task 6: C3 — active-stream tracking and post-swap attach

**Files:**
- Modify: `servers/sharing/instance-sync.js` — constructor (`this._activeStreams = new Map()`), `replicate` (`:1187`), the C1 open path (attach after set), `_closeInstanceFeedsInner` (teardown).
- Test: `tests/feed-rotation.test.js` (G8, G9).

**Interfaces:**
- Produces: `_activeStreams: Map<peerId, Set<stream>>`. Bound: ≤ live transport connections per active peer; entries removed on stream `close` and on `closeInstanceFeeds`.
- Consumes: Task 4's swap path.

- [ ] **Step 1: Failing tests**

```js
test("G8: rotation while a stream is actively replicating -- new feed attaches to the SAME stream", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b); // old core actively replicating on this stream
    await a.mgr.emitChange("memories", "insert", { id: "g8-pre", content: "x", lamport_ts: null });
    await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id='g8-pre'" })).rows.length === 1);
    // A rotates; the key is delivered to B while the ORIGINAL stream stays open.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    await a.mgr.replicate(b.id, /* A's side of the SAME stream */ linkStreamFor(a)); // see note below
    await b.mgr.initInstance(a.id, newKey); // swap: real bounded close of old core, then attach
    await a.mgr.emitChange("memories", "insert", { id: "g8-post", content: "y", lamport_ts: null });
    const applied = await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id='g8-post'" })).rows.length === 1);
    assert.equal(applied, true, "post-rotation data must flow over the pre-existing stream");
    link.close();
  } finally { await fleet.cleanup(); }
});

test("G9: old core blocks remain readable after the swap (acceptance pin)", async () => {
  // After G1-style rotation on side B: open B's in-dir with the OLD key and read block 0.
  // (Build inline: rotate as in G1, keep oldKey; then:)
  //   const reopened = new Hypercore(join(b.mgr.dataDir, a.id, "in"), oldKey, { valueEncoding: "json" });
  //   await reopened.ready();
  //   assert.ok(reopened.length >= 1); assert.ok(await reopened.get(0));
  //   await reopened.close();
});
```

Note on G8: `linkPeers` must be extended to return per-side stream handles (`{ nsA, nsB }`) so the test can re-`replicate` A's NEW out-feed onto A's existing stream (`nsA`) — on A's side the out-feed was closed and re-created, so A re-attaches its side too; B's side is what C3 must handle automatically. Import `Hypercore` at the top of the test file for G9.

- [ ] **Step 2: Run — G8 FAIL** (new in-feed never attaches to the existing stream), G9 skeleton filled and passing only after implementation.

- [ ] **Step 3: Implement.** Constructor: `this._activeStreams = new Map();`. In `replicate`:

```js
  async replicate(remoteInstanceId, stream) {
    // 2d C3: track live streams so a rotation can attach the successor feed
    // to connections that predate the key receipt (hyperswarm ordering hole).
    let set = this._activeStreams.get(remoteInstanceId);
    if (!set) { set = new Set(); this._activeStreams.set(remoteInstanceId, set); }
    if (!set.has(stream)) {
      set.add(stream);
      const drop = () => {
        set.delete(stream);
        if (set.size === 0) this._activeStreams.delete(remoteInstanceId);
      };
      stream.on("close", drop);
      stream.on("error", () => {}); // never let a tracked stream's error escape
    }
    const outFeed = this.outFeeds.get(remoteInstanceId);
    const inFeed = this.inFeeds.get(remoteInstanceId);
    if (outFeed) outFeed.replicate(stream, { live: true });
    if (inFeed) inFeed.replicate(stream, { live: true });
  }
```

In the C1 open path, after `this.inFeeds.set(remoteInstanceId, inFeed)`:

```js
        // 2d C3: attach the successor feed to every live stream for this peer.
        for (const s of this._activeStreams.get(remoteInstanceId) ?? []) {
          try { inFeed.replicate(s, { live: true }); } catch (err) {
            console.warn(`[instance-sync] post-swap stream attach failed for ${remoteInstanceId.slice(0,12)}…: ${err.message}`);
          }
        }
```

In `_closeInstanceFeedsInner` (R2 #2): `this._activeStreams.delete(remoteInstanceId);`

- [ ] **Step 4: Run — PASS. Mutation:** remove the post-swap attach loop → **G8 red**. Also verify (no mutation, just assert in G8) the out-feed replication was not disturbed.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/feed-rotation.test.js -m "feat(sync): track live replication streams and attach rotated in-feeds to them -- closes the hyperswarm key-after-replicate ordering hole (2d C3, gates G8/G9)"
```

---

### Task 7: F3 — tailnet server passes null pre-exchange; G13 real-WS race gate

**Files:**
- Modify: `servers/sharing/tailnet-sync.js:238`.
- Test: `tests/feed-rotation.test.js` (G13 — drives the REAL `setupTailnetSyncServer`).

**Interfaces:**
- Consumes: `setupTailnetSyncServer(server, ctx)` (exported), `buildHandshakePayload` shape (test re-implements the client handshake with `sign` from `servers/sharing/identity.js`).

- [ ] **Step 1: Failing test** — the test drives the real WS server; the barrier is a wrapped `ctx.db.execute` that parks the server's peer-row SELECT (`:222`) until the "hyperswarm path" lands the new key:

```js
test("G13: stale-snapshot tailnet handshake cannot swap back a concurrently-received new key", async () => {
  const fleet = await makeFleet();
  const http = await import("node:http");
  const { WebSocket } = await import("ws");
  const { setupTailnetSyncServer } = await import("../servers/sharing/tailnet-sync.js");
  const { sign } = await import("../servers/sharing/identity.js");
  try {
    const { a, b } = fleet;
    // B hosts the WS server. Seed B's row for A with the OLD key.
    const oldLink = await linkPeers(a, b);
    oldLink.close();
    const oldKeyHex = a.mgr.getOutFeedKey(b.id).toString("hex");
    await b.db.execute({ sql: "UPDATE crow_instances SET sync_url = ? WHERE id = ?", args: [oldKeyHex, a.id] });
    // Barrier: park the server's :222 snapshot SELECT until the new key lands.
    let releaseLookup; const lookupGate = new Promise((r) => { releaseLookup = r; });
    let parked = false;
    const realExec = b.db.execute.bind(b.db);
    const dbWrapper = { ...b.db, execute: async (q) => {
      if (!parked && typeof q?.sql === "string" && q.sql.includes("WHERE id = ? AND status IN ('active','offline') LIMIT 1")) {
        parked = true; await lookupGate;
      }
      return realExec(q);
    }};
    const server = http.createServer();
    setupTailnetSyncServer(server, { identity: b.mgr.identity, instanceSyncManager: b.mgr, db: dbWrapper });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    // Dial as A with a REAL signed handshake.
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/instance-sync/stream`);
    await new Promise((r) => ws.once("open", r));
    const nonce = "00".repeat(16);
    ws.send(JSON.stringify({ instance_id: a.id, nonce_hex: nonce, sig_hex: sign(`${a.id}:${nonce}`, a.mgr.identity.ed25519Priv) }));
    await until(() => parked); // server is now parked holding the OLD snapshot
    // Hyperswarm path lands A's rotated key on B.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    await b.db.execute({ sql: "UPDATE crow_instances SET sync_url = ? WHERE id = ?", args: [newKey.toString("hex"), a.id] });
    await b.mgr.initInstance(a.id, newKey);
    const swappedFeed = b.mgr.inFeeds.get(a.id);
    releaseLookup(); // server resumes with its stale snapshot → hits :238
    // Give the handler time to run its init + key-exchange frames.
    await ws.send(JSON.stringify({ feed_key_hex: newKey.toString("hex") }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(b.mgr.inFeeds.get(a.id), swappedFeed,
      "the stale-snapshot :238 init must NOT have swapped the in-feed back (F3)");
    assert.equal(b.mgr.inFeeds.get(a.id).key.toString("hex"), newKey.toString("hex"));
    ws.close(); server.close();
  } finally { await fleet.cleanup(); }
});
```

- [ ] **Step 2: Run — expect FAIL** (`:238` passes the stale snapshot key → swap-back → feed object differs).

- [ ] **Step 3: Implement** — `tailnet-sync.js:238`:

```js
  // 2d F3: pass NO key here. This call's only job is arming the out-feed for
  // getOutFeedKey below. Passing the :222 snapshot's sync_url was harmless
  // when a mismatched key no-oped, but under key-aware initInstance a stale
  // snapshot would swap a concurrently-rotated in-feed BACK to its dead key.
  // The authenticated receipt at the feed-key exchange below drives any swap.
  await instanceSyncManager.initInstance(remoteInstanceId, null);
```

- [ ] **Step 4: Run — PASS. Mutation:** restore the snapshot-key argument at `:238` → **G13 red**.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/tailnet-sync.js tests/feed-rotation.test.js -m "fix(sharing): tailnet server pre-exchange init passes no key -- stale row snapshot can no longer swap a rotated in-feed back (2d F3, gate G13)"
```

---

### Task 8: C4 — 60s heal loop in refresh()

**Files:**
- Modify: `servers/sharing/tailnet-sync.js:503-535` (`refresh()` inside `startTailnetSyncClients`).
- Test: `tests/feed-rotation.test.js` (C4 unit).

**Interfaces:**
- Consumes: `startTailnetSyncClients(ctx)` (exported; returns `{ dialers, stop }`).

- [ ] **Step 1: Failing test**

```js
test("C4: refresh heals sync_url drift for ALREADY-DIALING peers and survives initInstance throws", async () => {
  const calls = [];
  const stubMgr = {
    localInstanceId: "me",
    initInstance: async (id, key) => {
      calls.push([id, key ? key.toString("hex") : null]);
      if (calls.length === 1) throw new Error("boom"); // first tick throws
    },
  };
  const peerRow = { id: "peer1", gateway_url: "http://127.0.0.1:1", tailscale_ip: null, sync_url: "ab".repeat(32), status: "active" };
  const stubDb = { execute: async () => ({ rows: [peerRow] }) };
  const { startTailnetSyncClients } = await import("../servers/sharing/tailnet-sync.js");
  const clients = await startTailnetSyncClients({ db: stubDb, instanceSyncManager: stubMgr, identity: {} });
  try {
    // First refresh already ran inside startTailnetSyncClients: the throw must
    // not have escaped (this test completing IS the assertion), and the call
    // must have carried the persisted key.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["peer1", "ab".repeat(32)]);
    assert.ok(clients.dialers.has("peer1"), "dialer was still created after the throw");
    // Second refresh: peer is ALREADY dialing — the heal call must still fire
    // (placed BEFORE the dialers.has() continue; R3 F-C).
    peerRow.sync_url = "cd".repeat(32);
    await clients.__refreshForTest();
    assert.deepEqual(calls[1], ["peer1", "cd".repeat(32)], "already-dialing peer still healed");
  } finally { clients.stop(); }
});
```

- [ ] **Step 2: Run — FAIL** (no heal call; no `__refreshForTest`).

- [ ] **Step 3: Implement.** In `refresh()`'s peer loop, immediately after `seenIds.add(peer.id)` and BEFORE `if (!peer.gateway_url) continue;` / `if (dialers.has(peer.id))` (R3 F-C — after the continue it never heals the steady state):

```js
      // 2d C4: converge the in-feed with the persisted sync_url every rescan —
      // heals manual crow_update_instance edits and any missed key exchange
      // within 60s, no restart. Cheap fast-path (Map lookup + Buffer compare)
      // when nothing changed. Own try/catch: refresh runs on a bare
      // setInterval and an escaped rejection would crash the gateway (no
      // unhandledRejection handler exists in servers/).
      try {
        const keyBuf = peer.sync_url ? instanceSyncManager.validateIncomingFeedKey?.(peer.id, peer.sync_url) ?? null : null;
        await instanceSyncManager.initInstance(peer.id, keyBuf);
      } catch (err) {
        console.warn(`[tailnet-sync] refresh heal for ${peer.id.slice(0,12)}…: ${err.message}`);
      }
```

Expose the test hook on the return object: `return { dialers, __refreshForTest: refresh, stop() {...} };`
Note: `validateIncomingFeedKey` (optional-chained for stub managers) also screens a hand-edited malformed `sync_url` here.

- [ ] **Step 4: Run — PASS. Mutations:** move the heal call below the `dialers.has() continue` → **C4 test red** (second call missing); remove its try/catch → **C4 test red** (throw escapes the first refresh).

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/tailnet-sync.js tests/feed-rotation.test.js -m "feat(sharing): 60s refresh converges in-feeds with persisted sync_url -- heals manual edits and missed exchanges live, throw-isolated (2d C4)"
```

---

### Task 9: C5 — backfill-flag premise reset at boot

**Files:**
- Modify: `servers/sharing/instance-sync.js` — new `resetBackfillPremiseFlags()`.
- Modify: `servers/gateway/boot/mcp-mounts.js` — call it right after the `eagerInitPairedPeers` try-block (`:66`) and before the settings/contacts/groups/providers once-backfills.
- Test: `tests/feed-rotation.test.js` (G10).

**Interfaces:**
- Produces: `resetBackfillPremiseFlags()` → number of flags cleared. Reads `this.outFeeds`; deletes `__providers_backfill_v1:<peerId>` per empty-out-feed peer; deletes the three global flags (`__contacts_backfill_v1`, `__sync_reemit_allowlist_v2`, `__groups_backfill_v1`) if ANY armed out-feed is empty.

- [ ] **Step 1: Failing test**

```js
test("G10: empty armed out-feed clears premise flags BEFORE the once-backfills; non-empty leaves them", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    await a.mgr.initInstance(b.id, null); // armed, length 0 (fresh = post-rotation shape)
    const setFlag = (k, v) => a.db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?, ?)", args: [k, v] });
    await setFlag("__contacts_backfill_v1", "done:5");
    await setFlag("__sync_reemit_allowlist_v2", "done:9");
    await setFlag("__groups_backfill_v1", "done:2");
    await setFlag(`__providers_backfill_v1:${b.id}`, "done:3");
    const cleared = await a.mgr.resetBackfillPremiseFlags();
    assert.equal(cleared, 4, "three globals + one per-peer flag cleared");
    const read = async (k) => (await a.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [k] })).rows[0]?.value;
    assert.equal(await read("__contacts_backfill_v1"), undefined);
    assert.equal(await read(`__providers_backfill_v1:${b.id}`), undefined);
    // Ordering semantics (G10 mutation target): flags cleared → the once-backfill
    // re-runs in the same sequence. reemitSyncableSettingsOnce with the flag
    // GONE returns >= 0 and re-stamps done:, proving it executed its body.
    await setFlag("sync.allowlisted.example", "x"); // ensure at least a no-op run completes
    await a.mgr.reemitSyncableSettingsOnce();
    assert.match(String(await read("__sync_reemit_allowlist_v2")), /^done:/, "backfill re-ran this boot");
    // Negative control: non-empty out-feed → flags untouched.
    await a.mgr.emitChange("memories", "insert", { id: "g10", content: "x", lamport_ts: null });
    await setFlag("__contacts_backfill_v1", "done:5");
    assert.equal(await a.mgr.resetBackfillPremiseFlags(), 0, "non-empty feed: nothing cleared");
    assert.equal(await read("__contacts_backfill_v1"), "done:5");
  } finally { await fleet.cleanup(); }
});
```

- [ ] **Step 2: Run — FAIL** (method missing).

- [ ] **Step 3: Implement** in `instance-sync.js`:

```js
  /**
   * 2d C5 (D4): a length-0 armed out-feed means the once-backfill flags'
   * premise ("peers already received this") died with the feed — rotation,
   * or a brand-new pairing (desirable re-run either way; a never-emitted-to
   * peer re-triggers this each boot until a first emit lands — accepted,
   * re-runs are preserve-mode + deduped no-ops). MUST run between
   * eagerInitPairedPeers and the once-backfill calls (mcp-mounts ordering,
   * R1 F4). Returns the number of flags cleared.
   */
  async resetBackfillPremiseFlags() {
    if (this.feedsDisabled || this.outFeeds.size === 0) return 0;
    const emptyPeers = [...this.outFeeds.entries()]
      .filter(([, feed]) => feed.length === 0)
      .map(([peerId]) => peerId);
    if (emptyPeers.length === 0) return 0;
    let cleared = 0;
    const del = async (key) => {
      try {
        const r = await this.db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ? AND value LIKE 'done:%'", args: [key] });
        if ((r.rowsAffected ?? 0) > 0) cleared++;
      } catch (err) { console.warn(`[instance-sync] flag reset ${key}: ${err.message}`); }
    };
    for (const peerId of emptyPeers) await del(`__providers_backfill_v1:${peerId}`);
    for (const key of ["__contacts_backfill_v1", "__sync_reemit_allowlist_v2", "__groups_backfill_v1"]) await del(key);
    if (cleared > 0) {
      console.warn(`[instance-sync] C5: ${cleared} backfill premise flag(s) reset — empty out-feed(s) for ${emptyPeers.map((p) => p.slice(0, 12)).join(", ")}; once-backfills will re-run this boot`);
    }
    return cleared;
  }
```

In `mcp-mounts.js`, directly after the `eagerInitPairedPeers` try-block:

```js
  // 2d C5: reset once-backfill flags whose premise died with a lost out-feed
  // (rotation / restore-from-backup). MUST run BEFORE the once-backfills
  // below so they re-run this same boot (spec §3 C5 / R1 F4 ordering).
  try {
    if (syncManager?.resetBackfillPremiseFlags) {
      await syncManager.resetBackfillPremiseFlags();
    }
  } catch (err) {
    console.warn(`[instance-sync] resetBackfillPremiseFlags failed: ${err.message}`);
  }
```

- [ ] **Step 4: Run — PASS. Mutations:** remove the `length === 0` premise check (always clear) → **G10 red** (negative control); remove the per-peer providers deletion → **G10 red** (cleared-count 4 → 3); simulate wrong ordering by calling `reemitSyncableSettingsOnce` BEFORE `resetBackfillPremiseFlags` in the test's sequence → the `done:` re-stamp assertion documents why mcp-mounts order matters (keep as a comment, the mcp-mounts wiring itself is review-pinned).

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js servers/gateway/boot/mcp-mounts.js tests/feed-rotation.test.js -m "feat(sync): reset once-backfill premise flags when an armed out-feed is empty -- rotated instances repopulate peers this same boot (2d C5, gate G10)"
```

---

### Task 10: Integration closers — G2, G3 (MUTUAL), G7 + full verification

**Files:**
- Test: `tests/feed-rotation.test.js` (G2, G3, G7).

- [ ] **Step 1: Write the three remaining gate cases**

```js
test("G2: rotation resets the mark -- fresh feed seqs 0..2 all apply despite an old high mark", async () => {
  // G1 shape, but before delivering the new key, force B's record to {k: old, s: 40}
  // via _setLastAppliedSeq(a.id, 40, oldKeyHex). After swap + relink, emit 3 rows on A
  // and assert all 3 applied on B (the mark followed the feed, not the peer).
});

test("G3 MUTUAL: both sides rotate simultaneously -- both swap, both directions converge, conflicts flat", async () => {
  // Rotate BOTH sides' out-feeds (close + rm out dirs + re-init on each), exchange the
  // two new keys via initInstance on each side concurrently (Promise.all), relink,
  // then emit one row from EACH side and assert both apply on the opposite side.
  // Assert sync_conflicts unchanged on both DBs. (2a lesson: the mutual case is
  // where convergence designs die — this case is mandatory.)
});

test("G7: replay safety at seq 0 -- insert-then-delete converges deleted; newer local row survives older replayed entry", async () => {
  // On the rotated fresh feed: A emits insert then delete for one id → B ends without
  // the row. Second half: B holds a row with a HIGH lamport (insert directly + set
  // lamport via _advanceCounter pattern from lamport-reemit.test.js); A's replayed
  // older update for that id must NOT overwrite it (LWW gate holds at reset-replay).
});
```

Implement each fully (the comments above are the recipe; every assertion concrete, `until()`-based).

- [ ] **Step 2: Run the whole gate file** — all G-cases green.

- [ ] **Step 3: Full verification (record ALL outputs in the ledger):**

```bash
fuser ~/.crow/data/crow.db   # confirm only the systemd gateways hold prod
T=$(mktemp -d); CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1 node --test tests/*.test.js
# Expected: 1953+N pass / 2 known fails (bundles-validate-install) / 0 skips
node scripts/check-port-allocation.js   # green iff EXACTLY one error line: Port 8090 (capstone-tracker)
node scripts/build-registry.mjs --check
node servers/gateway/index.js --no-auth # boots clean, ctrl-C
```

- [ ] **Step 4: Full mutation matrix** — re-run every mutation from Tasks 2-9 in one recorded pass (guard → named red test → restore → green). Paste the matrix into the PR body.

- [ ] **Step 5: Commit any stragglers, then hand off to the ship pipeline below.**

```bash
git commit tests/feed-rotation.test.js -m "test(sync): 2d gate complete -- G2 mark-follows-feed, G3 mutual rotation, G7 replay safety (mutation matrix recorded)"
```

---

## Ship pipeline (after Task 10 — session workflow, not TDD tasks)

1. **Whole-branch adversarial review** — fresh Opus subagent over the full branch diff; verdict must be READY TO MERGE (fix + re-review otherwise). It must check the spec's §11 R3 mandatory fixes (F-A `.finally`, F-B revoke-clears-defer, F-C heal-before-continue) landed.
2. **PR** via GitHub MCP (repo `kh0pper/crow`), title `feat(sync): live in-feed key rotation + feed-keyed applied-seq (Item 2d)`; body: spec link, defect table, gate table + mutation matrix, no-schema-bump note. `git pull --rebase --autostash` before push.
3. **Merge** after local gates (check-runs `total_count: 0` is normal). **No migration rail needed** (no schema bump) — auto-update may stay ON.
4. **Deploy fleet** in runbook order: crow (`systemctl restart crow-gateway crow-mpa-gateway` via askpass helper) → grackle (bridge THEN gateway; check `grackle "curl -s localhost:3002/health"`) → black-swan (`~/.crow/app`, wait ~75s). Watch grackle's boot for the 2c wedge class — the C1 cap must never let boot hang.
5. **Live rotation proof** (spec §9): baselines → stop grackle gateway → move `~/.crow/data/instance-sync/<crow-peer-id>/out` aside (KEEP it) → start → on crow WITHOUT restart: journal shows `in-feed ROTATED`, sync_url updated, throwaway grackle row converges, `getSyncStatus` advancing from 0, conflicts flat ×4 (219/182/162/0), MPA untouched; grackle's C5 log line + repopulated out-feed. **Deadman:** the stop window carries a detached watchdog that restarts grackle's gateway after 10 minutes regardless (unattended-window rule — write it BEFORE stopping, `at`/`systemd-run` style, remove after).
6. **Soak** (health ×4, integrity ×4, conflicts vs baseline, stash 4/17, auto-update true ×4, zero new err classes; known-benign: nostr NOTICE lines, grackle stale-bswan handshake spam ~1/min).
7. **Post-item CDP bug-hunt round** (`~/.crow/p4/bughunt-item5/{cdp,checks,round}.mjs` — mint session into its sess-prod file, REVOKE after).
8. **Record**: ledger append; update the plan doc §4 Item 2d block; write/refresh the arc memory file.

## Self-review notes (done at write time)

- Spec coverage: C1→T4, C2→T2+T3, C3→T6, C4→T8, C5→T9, F3→T7, validation→T5, G1-G13 all placed, F6 migration→T2, R3 F-A/F-B→T4, F-C→T8, F-D→T4 catch, F-E→T5 client wiring, F-F→T2 reader, F-G→T4/T7 seams. Live plan §9→ship step 5.
- The `_rotationCloseCapMs` test knob is new here (not in the spec) — it changes nothing semantically (default 5000) and keeps G6 fast; note it in the PR.
- Type consistency: `_setLastAppliedSeq(id, seq, feedKeyHex:string|null)`, `_getLastAppliedSeq(id, feed:{key:Buffer}|null)`, `validateIncomingFeedKey(id, hex)→Buffer|null`, `resetBackfillPremiseFlags()→number` — used identically across tasks.
- G13's db wrapper spreads `b.db` — if the db client's methods live on a prototype, replace the spread with a Proxy delegating everything except `execute` (implementer note).
