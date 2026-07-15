# Item 2c — Lamport-Preserving Re-emit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill re-emits preserve row lamports (no fabricated recency), boot-window emits are queued+drained instead of silently dropped, contact deletes become durable via a per-boot tombstone re-emit, and repeat-delivery conflict rows dedupe on a stable key.

**Architecture:** All changes live in the instance-sync layer (`servers/sharing/`). `emitChange` gains an explicit envelope-lamport option and routes every append through a per-peer FIFO promise chain (`_appendLocks`) that parks entries for unarmed feeds in `_pendingPeerEmits` and drains them on feed-arm. The three LWW re-emitters pass preserved lamports; a new flagless `reemitContactTombstones` mirrors the shipped W4 groups pattern. Spec (APPROVED rev 4): `docs/superpowers/specs/2026-07-14-lamport-preserving-reemit-design.md` — read §3 (C1–C7) and §5 (gate table) before any task.

**Tech Stack:** Node ESM, better-sqlite3 via `servers/db.js` client, node:test, two-instance test harness (pattern: `tests/group-tombstones.test.js`).

## Global Constraints

- Branch: all work on `feat/item2c-lamport-reemit` (create from current `main` at task 1).
- **No schema change, no wire-format change.** If a task seems to need either, STOP — the spec explicitly forbids both (no migration rail is budgeted).
- Commits: positional path args only (`git commit <paths> -m "..."`), never bare `git commit`; verify `git show --stat HEAD` after every commit; never `--amend`; never attribute Claude; no backticks in `-m`.
- Suite runs ONLY on scratch env: `T=$(mktemp -d); CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1 node --test tests/<file>.test.js`. NEVER point tests at `~/.crow` or `~/.crow-mpa`.
- Suite baseline: 1931 pass / 3 known fails (2× bundles-validate-install, 1× instance-sync test 18 — task 1 fixes the third) / 0 skips. Any NEW failure is yours.
- Every guard added gets a mutation check against its NAMED test (spec §5 matrix); `grep -rn "MUTATION\|if (false" servers/ tests/` must be clean before every commit.
- New test file `tests/lamport-reemit.test.js` header must carry: `// NEVER point this file at ~/.crow — it DELETES contacts.`

---

### Task 1: C6 — test-18 harness fix (baseline first)

**Files:**
- Modify: `tests/instance-sync.test.js:73-76` (makeManager)

**Interfaces:**
- Produces: suite baseline moves to 1932/2/0 — later tasks assert against this.

- [ ] **Step 1: Create the branch**

```bash
cd ~/crow && git pull --rebase --autostash && git checkout -b feat/item2c-lamport-reemit
```

- [ ] **Step 2: Reproduce the failure**

Run: `T=$(mktemp -d); CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1 node --test --test-name-pattern "18\. crow_context" tests/instance-sync.test.js`
Expected: FAIL `global lamport_ts should be stamped > 0, got 0`.

- [ ] **Step 3: Fix makeManager**

```js
function makeManager(instanceId = LOCAL_ID) {
  const db = createDbClient(DB_PATH);
  const mgr = new InstanceSyncManager(IDENTITY, db, instanceId);
  // The scratch suite env sets CROW_DISABLE_INSTANCE_SYNC=1, which the constructor
  // reads into feedsDisabled — emitChange would return before stamping and every
  // emit-path assertion would go vacuous. These tests drive stub feeds, never real
  // Hypercores, so force-enable (same as tests/group-tombstones.test.js:80).
  mgr.feedsDisabled = false;
  return { mgr, db };
}
```

- [ ] **Step 4: Verify test 18 green + whole file**

Run: same command as step 2 → PASS. Then full file: `... node --test tests/instance-sync.test.js` → 0 fails.

- [ ] **Step 5: Commit**

```bash
git commit tests/instance-sync.test.js -m "test(sync): makeManager force-enables feeds under the scratch env -- test 18 was failing on feedsDisabled, not on stamping (suite baseline now 1932/2/0)"
git show --stat HEAD
```

---

### Task 2: C1 — `emitChange` explicit envelope lamport (`opts.lamportTs`)

**Files:**
- Modify: `servers/sharing/instance-sync.js:1052-1130` (emitChange)
- Test: `tests/instance-sync.test.js` (append two tests near test 18)

**Interfaces:**
- Produces: `emitChange(table, op, row, opts = {})` — when `opts.lamportTs` is a finite number ≥ 0: envelope `lamport_ts = Number(opts.lamportTs)`, NO `_nextLamport()` mint, NO local row re-stamp, counter still floored at `MAX(row.lamport_ts, opts.lamportTs)` via `_advanceCounter`. Returns the envelope lamport. All existing no-opts callers byte-identical.

- [ ] **Step 1: Write the failing tests** (append to `tests/instance-sync.test.js`)

```js
test("2c-C1a. emitChange opts.lamportTs: envelope preserved, local row NOT re-stamped, counter floored", async () => {
  const { mgr, db } = makeManager("inst-2c-c1");
  const captured = [];
  mgr.outFeeds = new Map([["peer-x", { append: async (e) => captured.push(e) }]]);
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:c1a', '', 'a1', 'Old Name', 5)",
    args: [],
  });
  const { rows: r0 } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:c1a'", args: [] });
  const ts = await mgr.emitChange("contacts", "update", r0[0], { lamportTs: 5 });
  assert.equal(ts, 5, "returns the preserved envelope lamport");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].lamport_ts, 5, "envelope carries the preserved lamport");
  const { rows: r1 } = await db.execute({ sql: "SELECT lamport_ts FROM contacts WHERE crow_id = 'crow:c1a'", args: [] });
  assert.equal(Number(r1[0].lamport_ts), 5, "local row lamport NOT re-stamped");
  // Counter floored: the next fresh mint must exceed the preserved value.
  const fresh = await mgr._nextLamport();
  assert.ok(fresh > 5, `next mint ${fresh} must exceed preserved 5`);
  db.close();
});

test("2c-C1b. emitChange without opts: behavior unchanged (fresh mint + local stamp)", async () => {
  const { mgr, db } = makeManager("inst-2c-c1b");
  const captured = [];
  mgr.outFeeds = new Map([["peer-x", { append: async (e) => captured.push(e) }]]);
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, lamport_ts) VALUES ('crow:c1b', '', 'b1', 5)",
    args: [],
  });
  const { rows: r0 } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:c1b'", args: [] });
  const ts = await mgr.emitChange("contacts", "update", r0[0]);
  assert.ok(ts > 5, "fresh mint exceeds row lamport (counter floor)");
  const { rows: r1 } = await db.execute({ sql: "SELECT lamport_ts FROM contacts WHERE crow_id = 'crow:c1b'", args: [] });
  assert.equal(Number(r1[0].lamport_ts), ts, "local row re-stamped with the fresh mint");
  db.close();
});
```

NOTE: if the `INSERT INTO contacts` fails on a NOT NULL column, run `PRAGMA table_info(contacts)` against a scratch init-db DB and extend the column list — do NOT weaken the assertions.

- [ ] **Step 2: Run to verify failure** — `... node --test --test-name-pattern "2c-C1" tests/instance-sync.test.js` → C1a FAILS (opts ignored: envelope gets a fresh mint, row re-stamped).

- [ ] **Step 3: Implement** — in `emitChange`, replace the mint/stamp sections:

```js
  async emitChange(table, op, row, opts = {}) {
    // --no-auth companion doesn't drive fleet sync (and has no outFeeds).
    if (this.feedsDisabled) return null;
    if (!SYNCED_TABLES.includes(table)) return null;
    if (!shouldSyncRow(table, row)) return null; // local-only row; don't broadcast

    // 2c C1: a re-emit passes opts.lamportTs to preserve the row's ORIGINAL emit
    // lamport — a redelivery must never fabricate recency over a peer's newer
    // write. Preserve-mode skips the mint AND the local re-stamp; the counter is
    // still floored so future fresh mints strictly exceed every re-emitted value.
    // Live mutations MUST NOT pass opts.lamportTs.
    const preservedTs =
      opts != null && Number.isFinite(Number(opts.lamportTs)) && Number(opts.lamportTs) >= 0
        ? Number(opts.lamportTs)
        : null;

    // Envelope counter floor (see original comment): floor at the outgoing row's
    // own lamport, and in preserve-mode also at the preserved envelope value.
    const rowTs = Number(row?.lamport_ts);
    if (Number.isFinite(rowTs) && rowTs > 0) {
      await this._advanceCounter(rowTs);
    }
    if (preservedTs !== null && preservedTs > 0) {
      await this._advanceCounter(preservedTs);
    }
    const lamportTs = preservedTs !== null ? preservedTs : await this._nextLamport();
```

and wrap the existing local-stamp block (`if (op !== "delete") { ... }`) as:

```js
    // Update the row's lamport_ts in the local database (NEVER in preserve-mode —
    // the row keeps its original lamport; 2c C1).
    if (op !== "delete" && preservedTs === null) {
```

Keep everything else (strip/transform/sign/append/return) untouched in this task.

- [ ] **Step 4: Verify** — pattern run → both PASS; then whole file → 0 fails.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/instance-sync.test.js -m "feat(sync): emitChange opts.lamportTs -- preserve-mode for re-emits (no mint, no local re-stamp, counter still floored) (2c C1)"
```

---

### Task 3: C5 — stable-key conflict dedupe in `_insertConflictRow`

**Files:**
- Modify: `servers/sharing/instance-sync.js:2207-2223` (`_insertConflictRow`) and its 8 call sites (`:1423, :1498, :1626, :1786, :1998, :2061, :2180, :2321`) — gate the paired `_notifyConflict()` on the new boolean return.
- Test: `tests/instance-sync.test.js` (append)

**Interfaces:**
- Produces: `_insertConflictRow(...)` returns `true` when a row was inserted, `false` when deduped. Callers only `_notifyConflict()` on `true`.

- [ ] **Step 1: Failing tests**

```js
test("2c-C5a. conflict dedupe: identical redelivery adds no row; losing_instance_id distinguishes peers; resolved=1 re-surfaces once", async () => {
  const { mgr, db } = makeManager("inst-2c-c5");
  const count = async () => Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sync_conflicts", args: [] })).rows[0].n);
  const args = ["contacts", '{"crow_id":"crow:c5"}', "inst-2c-c5", "peer-A", 12, 10, '{"v":1}', '{"v":0}', "update"];
  assert.equal(await mgr._insertConflictRow(...args), true, "first insert rides");
  const base = await count();
  // Identical redelivery — even with DIFFERENT winning_data (volatile last_seen class)
  const argsVolatile = [...args]; argsVolatile[6] = '{"v":1,"last_seen":"moved"}';
  assert.equal(await mgr._insertConflictRow(...argsVolatile), false, "stable key ignores data blobs");
  assert.equal(await count(), base, "no growth on redelivery");
  // Different origin peer, same lamport pair → genuinely distinct → logs (G2b)
  const argsPeerB = [...args]; argsPeerB[3] = "peer-B";
  assert.equal(await mgr._insertConflictRow(...argsPeerB), true, "losing_instance_id distinguishes");
  assert.equal(await count(), base + 1);
  // Resolve the peer-A row, redeliver → re-surfaces EXACTLY once (G5c)
  await db.execute({ sql: "UPDATE sync_conflicts SET resolved = 1 WHERE losing_instance_id = 'peer-A'", args: [] });
  assert.equal(await mgr._insertConflictRow(...args), true, "re-surfaces once after resolve");
  assert.equal(await mgr._insertConflictRow(...args), false, "then dedupes against the new unresolved row");
  db.close();
});
```

- [ ] **Step 2: Run** → FAIL (`_insertConflictRow` returns undefined; count grows).

- [ ] **Step 3: Implement**

```js
  /**
   * @returns {Promise<boolean>} true when a row was inserted; false when an
   * identical unresolved conflict already exists (repeat delivery — 2c C5).
   * Stable key (table_name,row_id,op,winning_lamport_ts,losing_lamport_ts,
   * losing_instance_id): data blobs are EXCLUDED (winning_data carries volatile
   * never-synced columns — contacts.last_seen moves without lamport movement),
   * origin is INCLUDED (per-instance counters collide across peers; spec §3 C5).
   */
  async _insertConflictRow(tableName, rowId, winInst, loseInst, winTs, loseTs, winData, loseData, conflictOp) {
    const dedupeArgs = [tableName, rowId, winTs, loseTs, loseInst];
    try {
      const { rows } = await this.db.execute({
        sql: `SELECT id FROM sync_conflicts
               WHERE table_name = ? AND row_id = ? AND winning_lamport_ts = ?
                 AND losing_lamport_ts = ? AND losing_instance_id = ?
                 AND op IS ? AND resolved = 0 LIMIT 1`,
        args: [...dedupeArgs, conflictOp ?? null],
      });
      if (rows.length > 0) return false;
    } catch (err) {
      // Pre-migration DB without the op column: degrade like the INSERT fallback
      // below — dedupe without the op predicate rather than letting the error
      // escape (which would silently kill ALL conflict logging; spec R2/F4).
      if (/no such column: op|no column named op/i.test(err.message || "")) {
        try {
          const { rows } = await this.db.execute({
            sql: `SELECT id FROM sync_conflicts
                   WHERE table_name = ? AND row_id = ? AND winning_lamport_ts = ?
                     AND losing_lamport_ts = ? AND losing_instance_id = ?
                     AND resolved = 0 LIMIT 1`,
            args: dedupeArgs,
          });
          if (rows.length > 0) return false;
        } catch { /* dedupe is best-effort; fall through to insert */ }
      }
      // Any other pre-check error: fall through — logging the conflict matters
      // more than deduping it.
    }
    const legacyCols = `table_name, row_id, winning_instance_id, losing_instance_id,
                 winning_lamport_ts, losing_lamport_ts, winning_data, losing_data`;
    const legacyArgs = [tableName, rowId, winInst, loseInst, winTs, loseTs, winData, loseData];
    try {
      await this.db.execute({
        sql: `INSERT INTO sync_conflicts (${legacyCols}, op) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [...legacyArgs, conflictOp],
      });
    } catch (err) {
      if (!/no column named op/i.test(err.message || "")) throw err;
      await this.db.execute({
        sql: `INSERT INTO sync_conflicts (${legacyCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: legacyArgs,
      });
    }
    return true;
  }
```

Then at EVERY call site (all 8), capture the return and gate the notify that follows, e.g. at `:1626`:

```js
        const inserted = await this._insertConflictRow("contacts", rowIdJson,
          localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
          JSON.stringify(localRow), JSON.stringify(filtered), "delete");
        if (inserted) await this._notifyConflict();
```

Apply the same shape at each site (some sites have the notify a line or two later; keep their existing try/catch wrappers intact). A call site with NO adjacent `_notifyConflict()` just captures-and-ignores the boolean.

- [ ] **Step 4: Verify** — pattern `2c-C5` PASS; whole file 0 fails; also run `tests/group-tombstones.test.js` (its conflicts flow through the same helper) → same pass/fail count as before this task.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/instance-sync.test.js -m "feat(sync): conflict dedupe on stable key (lamport pair + losing origin, resolved=0-scoped, op-absent fallback) -- repeat deliveries stop growing sync_conflicts (2c C5)"
```

---

### Task 4: C3 — per-peer append chain, pending queue, drain seam

**Files:**
- Modify: `servers/sharing/instance-sync.js` — constructor (add `_appendLocks`, `_pendingPeerEmits`), `emitChange` broadcast section (`:1120-1127`), `_initInstanceInner` (after `outFeeds.set`), `_closeInstanceFeedsInner` (`:2470` — cleanup)
- Create: `tests/lamport-reemit.test.js` (the two-instance gate file WITH the shared harness)

**Interfaces:**
- Produces:
  - `async _appendToPeer(peerId, entry)` — chained; appends when `outFeeds.get(peerId)` exists (retaining the per-append `console.warn` on failure), else parks in `_pendingPeerEmits` (FIFO, cap 256, drop-oldest with warn).
  - `async _drainPendingEmits(peerId)` — chained; splices the pending slot and appends FIFO; returns count. **Enqueued synchronously adjacent to `outFeeds.set` in `_initInstanceInner` — no `await` between them (spec MUST).**
  - Harness exports (top of `tests/lamport-reemit.test.js`, used by tasks 5–7): `newFleet()` returning `{ A, B, wire, deliver, skimWire, restart, other }` where `A/B = { id, db, mgr }` (adapted VERBATIM from `tests/group-tombstones.test.js:50-113`, with these deltas: outFeeds keyed by the OTHER instance's real id, not "peer"; each instance's `crow_instances` seeded with the other via `INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, ?, 'active')`; the emit sink helper `act(inst, fn)` binds `contact-sync.js`'s `__setEmitSinkForTest`).

- [ ] **Step 1: Create `tests/lamport-reemit.test.js`** — header comment, imports, and the harness copied+adapted from `tests/group-tombstones.test.js:22-113` (two mkdtemp DBs via `scripts/init-db.js` subprocess with `CROW_DB_PATH: ""`, shared IDENTITY, captured `wire`, `deliver()`, `skimWire()`, `restart()`), plus the three failing G3 tests:

```js
test("G3: boot-window delete queues, drains on arm, peer converges", async () => {
  const f = newFleet();
  // Seed the same contact on both sides, converged at lamport 5.
  for (const inst of [f.A, f.B]) {
    await inst.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:g3', '', 'aa11', 'G3', 5)", args: [] });
  }
  // A's boot window: NO armed feeds (but B is paired in crow_instances via the harness).
  f.A.mgr.outFeeds = new Map();
  const { deleteContactLocal } = await import("../servers/sharing/contact-delete.js");
  const { rows } = await f.A.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g3'", args: [] });
  await act(f.A, () => deleteContactLocal(f.A.db, {}, rows[0]));
  assert.equal(f.wire.length, 0, "nothing rode while feeds were closed");
  const { rows: tombA } = await f.A.db.execute({ sql: "SELECT * FROM contact_tombstones WHERE crow_id = 'crow:g3'", args: [] });
  assert.ok(tombA[0], "local tombstone written in the window");
  // Arm A→B and drain through the REAL seam.
  f.A.mgr.outFeeds = new Map([[f.B.id, { append: async (e) => f.wire.push({ from: f.A.id, entry: JSON.parse(JSON.stringify(e)) }) }]]);
  const drained = await f.A.mgr._drainPendingEmits(f.B.id);
  assert.equal(drained, 1, "the queued delete drained");
  assert.equal(f.wire.length, 1);
  assert.equal(Number(f.wire[0].entry.lamport_ts), Number(tombA[0].lamport_ts), "tombstone lamport == envelope lamport");
  await f.deliver();
  const { rows: rowB } = await f.B.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g3'", args: [] });
  assert.equal(rowB.length, 0, "B's row deleted");
  const { rows: tombB } = await f.B.db.execute({ sql: "SELECT * FROM contact_tombstones WHERE crow_id = 'crow:g3'", args: [] });
  assert.ok(tombB[0], "B tombstoned");
});

test("G3b: real initInstance invokes the drain after arming (scratch dataDir)", async () => {
  const f = newFleet();
  const scratch = mkdtempSync(join(tmpdir(), "crow-2c-g3b-"));
  f.A.mgr.dataDir = join(scratch, "instance-sync"); // isolate from process default (tests/instance-sync-noauth-feeds.test.js:71)
  f.A.mgr.outFeeds = new Map();
  // Park one entry for B.
  await f.A.mgr._appendToPeer(f.B.id, { table: "contacts", op: "update", row: { crow_id: "crow:g3b" }, lamport_ts: 1, instance_id: f.A.id });
  const calls = [];
  const realDrain = f.A.mgr._drainPendingEmits.bind(f.A.mgr);
  f.A.mgr._drainPendingEmits = async (peerId) => { calls.push(peerId); return realDrain(peerId); };
  try {
    await f.A.mgr.initInstance(f.B.id, null); // real Hypercore on scratch disk
    assert.ok(calls.includes(f.B.id), "initInstance drained the pending slot after arming");
    const feed = f.A.mgr.outFeeds.get(f.B.id);
    assert.equal(feed.length, 1, "pending entry is readable from the REAL Hypercore");
    const block = await feed.get(0);
    assert.equal(block.row.crow_id, "crow:g3b");
  } finally {
    try { await f.A.mgr.outFeeds.get(f.B.id)?.close(); } catch {}
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("G3c: chain preserves emit order across the open transition; nothing duplicated or stranded", async () => {
  const f = newFleet();
  f.A.mgr.outFeeds = new Map();
  const appended = [];
  // E1 parks (feed closed).
  await f.A.mgr._appendToPeer(f.B.id, { marker: "E1" });
  // Arm with a SLOW stub append so the drain is in flight when E2 is emitted.
  f.A.mgr.outFeeds = new Map([[f.B.id, { append: async (e) => { await new Promise((r) => setTimeout(r, 20)); appended.push(e.marker); } }]]);
  const drainP = f.A.mgr._drainPendingEmits(f.B.id);      // chained task 1 (slow)
  const liveP = f.A.mgr._appendToPeer(f.B.id, { marker: "E2" }); // chained task 2
  await Promise.all([drainP, liveP]);
  assert.deepEqual(appended, ["E1", "E2"], "E1 strictly before E2");
  assert.equal((f.A.mgr._pendingPeerEmits.get(f.B.id) || []).length, 0, "nothing stranded");
});
```

- [ ] **Step 2: Run** → all three FAIL (`_appendToPeer`/`_drainPendingEmits`/`_pendingPeerEmits` undefined).

- [ ] **Step 3: Implement.** Constructor (near `_initLocks`):

```js
    // 2c C3: per-peer ordered append pipeline. ALL writes toward a peer's outFeed
    // flow through one FIFO promise chain (_appendLocks, the _initLocks pattern);
    // entries emitted while the peer's feed is not yet armed park in
    // _pendingPeerEmits and drain on arm — the boot-window fix (spec §3 C3).
    this._appendLocks = new Map();      // remoteInstanceId → tail Promise
    this._pendingPeerEmits = new Map(); // remoteInstanceId → [signed entries]
```

New methods (place right above `emitChange`):

```js
  /** Chain helper: run taskFn as the next link on peerId's append chain. */
  async _chainAppendTask(peerId, taskFn) {
    const prior = this._appendLocks.get(peerId) || Promise.resolve();
    const next = prior.catch(() => {}).then(taskFn);
    this._appendLocks.set(peerId, next);
    try {
      return await next;
    } finally {
      if (this._appendLocks.get(peerId) === next) this._appendLocks.delete(peerId);
    }
  }

  /**
   * Append an entry toward a peer, or park it while the feed is unarmed.
   * The decision is made INSIDE the chained task, against current state — a
   * check-then-push outside the chain can strand entries or reorder the feed
   * (spec R2/F2). A failed append is logged and NOT retried (pre-existing
   * semantics; deletes self-heal via the tombstone re-emit).
   */
  async _appendToPeer(peerId, entry) {
    return this._chainAppendTask(peerId, async () => {
      const feed = this.outFeeds.get(peerId);
      if (feed) {
        try {
          await feed.append(entry);
        } catch (err) {
          console.warn(`[instance-sync] Failed to append to feed for ${peerId}:`, err.message);
        }
        return;
      }
      const slot = this._pendingPeerEmits.get(peerId) || [];
      slot.push(entry);
      if (slot.length > 256) {
        slot.shift();
        console.warn(`[instance-sync] pending emit queue overflow for ${peerId} — dropped oldest (LWW-safe direction)`);
      }
      this._pendingPeerEmits.set(peerId, slot);
    });
  }

  /**
   * Drain a peer's parked entries onto its (now armed) outFeed, FIFO. Chained,
   * so a live emit can never interleave mid-drain. Enqueued by _initInstanceInner
   * SYNCHRONOUSLY ADJACENT to outFeeds.set — no await between them (spec §3 C3
   * MUST: an emit slipping into that gap would reorder the feed).
   * @returns {Promise<number>} entries appended
   */
  async _drainPendingEmits(peerId) {
    return this._chainAppendTask(peerId, async () => {
      const slot = this._pendingPeerEmits.get(peerId);
      this._pendingPeerEmits.delete(peerId);
      if (!slot || slot.length === 0) return 0;
      const feed = this.outFeeds.get(peerId);
      if (!feed) {
        this._pendingPeerEmits.set(peerId, slot); // feed vanished — re-park
        return 0;
      }
      let n = 0;
      for (const entry of slot) {
        try {
          await feed.append(entry);
          n++;
        } catch (err) {
          console.warn(`[instance-sync] pending drain append failed for ${peerId}: ${err.message}`);
        }
      }
      return n;
    });
  }
```

`emitChange` — replace the broadcast loop (`:1120-1127`) with:

```js
    // Broadcast through the per-peer chains: every PAIRED peer (armed or not)
    // plus any armed feed not (yet) in the registry. Entries for unarmed paired
    // peers park in _pendingPeerEmits and ride when the feed arms (2c C3 — the
    // boot-window fix; previously they were silently dropped while the caller
    // saw a valid lamport).
    let pairedIds = [];
    try {
      const { rows } = await this.db.execute({
        sql: "SELECT id FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
        args: [this.localInstanceId],
      });
      pairedIds = rows.map((r) => r.id);
    } catch {
      pairedIds = []; // degraded: armed feeds below still get the entry
    }
    const targets = new Set([...pairedIds, ...this.outFeeds.keys()]);
    await Promise.all([...targets].map((peerId) => this._appendToPeer(peerId, entry)));
```

`_initInstanceInner` — immediately after the existing `this.outFeeds.set(remoteInstanceId, outFeed);` line (NO await between):

```js
      this.outFeeds.set(remoteInstanceId, outFeed);
      // 2c C3: drain entries parked while this feed was unarmed. The enqueue MUST
      // be synchronously adjacent to the set above (spec §3 C3) — an emit task
      // slipping in between would append ahead of older parked entries.
      const drainDone = this._drainPendingEmits(remoteInstanceId);
      await drainDone.catch(() => {});
```

`_closeInstanceFeedsInner` — add at its end:

```js
    // 2c C3: a closed/revoked peer keeps no parked entries or chain tail.
    this._pendingPeerEmits.delete(remoteInstanceId);
    this._appendLocks.delete(remoteInstanceId);
```

- [ ] **Step 4: Verify** — `... node --test tests/lamport-reemit.test.js` → G3/G3b/G3c PASS. Then `tests/instance-sync.test.js`, `tests/group-tombstones.test.js`, `tests/instance-sync-noauth-feeds.test.js`, `tests/advertised-prune-durability.test.js` → no new failures (these exercise emitChange heavily).

- [ ] **Step 5: Commit**

```bash
git add tests/lamport-reemit.test.js
git commit servers/sharing/instance-sync.js tests/lamport-reemit.test.js -m "feat(sync): per-peer ordered append chain + pending queue + drain-on-arm -- boot-window emits ride instead of silently dropping (2c C3, gate G3/G3b/G3c)"
```

---

### Task 5: C2 — preserved lamports in the three LWW re-emitters (+ gate G1/G2/G6/G6b/G7/G8)

**Files:**
- Modify: `servers/sharing/instance-sync.js:661` (contacts), `:566` (settings), `servers/sharing/group-sync.js` (`emitGroupUpsert` signature + `instance-sync.js:957` call site)
- Test: `tests/lamport-reemit.test.js` (append; uses task-4 harness)

**Interfaces:**
- Consumes: `emitChange(..., { lamportTs })` (task 2); harness `newFleet()/act()/deliver()` (task 4).
- Produces: `emitGroupUpsert(db, groupId, opts = {})` — `opts.preserveLamport === true` ⇒ inner emit passes `{ lamportTs: Number(row.lamport_ts) || 0 }`.

- [ ] **Step 1: Failing tests** (append to `tests/lamport-reemit.test.js`; complete code for G1 shown — G2, G6, G6b, G7, G8 follow the same fleet pattern and MUST implement exactly the spec §5 red-line assertions, including G2's conflict-side check via `winning_lamport_ts=10 AND losing_lamport_ts=5` and second-delivery zero-growth):

```js
const SYNCED_CONTACT_COLS = ["crow_id", "display_name", "ed25519_pubkey", "secp256k1_pubkey"]; // extend if assertions need more

test("G1: backfill re-emit preserves lamport -- stale cannot clobber newer; mutual convergence", async () => {
  const f = newFleet();
  await f.A.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:g1', '', 'g1aa', 'Stale Name', 5)", args: [] });
  await f.B.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:g1', '', 'g1aa', 'Newer Name', 10)", args: [] });
  const emitted = await f.A.mgr.backfillContactsOnce();
  assert.ok(emitted >= 1, "backfill ran and emitted");
  assert.equal(Number(f.wire.at(-1).entry.lamport_ts), 5, "envelope preserved the row lamport");
  await f.deliver(); // A→B: stale@5 vs local@10
  const rowB = (await f.B.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g1'", args: [] })).rows[0];
  assert.equal(rowB.display_name, "Newer Name", "B keeps its newer value");
  assert.equal(Number(rowB.lamport_ts), 10);
  const rowA0 = (await f.A.db.execute({ sql: "SELECT lamport_ts FROM contacts WHERE crow_id = 'crow:g1'", args: [] })).rows[0];
  assert.equal(Number(rowA0.lamport_ts), 5, "A's local row was NOT re-stamped");
  // B's live emit reaches A → mutual convergence over the synced projection.
  const rowBFull = (await f.B.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g1'", args: [] })).rows[0];
  await act(f.B, async () => { await f.B.mgr.emitChange("contacts", "update", rowBFull); });
  await f.deliver();
  const a = (await f.A.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g1'", args: [] })).rows[0];
  const b = (await f.B.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g1'", args: [] })).rows[0];
  for (const col of SYNCED_CONTACT_COLS) {
    assert.equal(String(a[col] ?? ""), String(b[col] ?? ""), `converged on ${col}`);
  }
});
```

G7 note: `backfillContactsOnce` writes `done:<n>` into `dashboard_settings` — assert the flag value and that a second call emits 0 (wire length unchanged). G8 note: for settings call `reemitSyncableSettingsOnce` after seeding an allowlisted key with `lamport_ts = 40` (check `isSyncable`/`PROFILE_SYNC_KEYS` in the file for a valid key — use a real allowlisted one, not an invented name) and assert envelope `lamport_ts === 40`; for groups seed a `contact_groups` row with `group_uid` + `lamport_ts = 30`, call `emitGroupUpsert(db, id, { preserveLamport: true })` under `act(...)` with `group-sync.js`'s OWN `__setEmitSinkForTest`, assert envelope 30.

- [ ] **Step 2: Run** → G1 FAILS (envelope carries a fresh mint > 5; B clobbered).

- [ ] **Step 3: Implement.** `backfillContactsOnce` (`:661`):

```js
        // 2c C2: preserve the row's ORIGINAL lamport — a backfill is redelivery,
        // not a new write; a fresh mint here fabricated recency over any peer
        // write still in flight (I-B1). NULL-lamport legacy rows emit at 0: they
        // land where the peer has nothing and lose everywhere else.
        await this.emitChange("contacts", "update", row, { lamportTs: Number(row.lamport_ts) || 0 });
```

`reemitSyncableSettingsOnce` (`:566`) — same option added to its emit (row already SELECTs `lamport_ts`):

```js
        await this.emitChange("dashboard_settings", "update", {
          key: row.key,
          value: row.value,
          instance_id: null,
        }, { lamportTs: Number(row.lamport_ts) || 0 });
```

`group-sync.js` `emitGroupUpsert` — signature `export async function emitGroupUpsert(db, groupId, opts = {})`, and its final emit becomes:

```js
    const emitOpts = opts && opts.preserveLamport === true
      ? { lamportTs: Number(row.lamport_ts) || 0 } // 2c C2: backfill redelivery keeps the original lamport
      : undefined;
    await (await sink())?.emitChange("contact_groups", "update", row, emitOpts);
```

`_backfillGroupsOnceGated` (`instance-sync.js:957`): `await emitGroupUpsert(this.db, row.id, { preserveLamport: true });`

- [ ] **Step 4: Verify** — `tests/lamport-reemit.test.js` all green; re-run `tests/instance-sync.test.js`, `tests/group-tombstones.test.js`, `tests/messages-contacts-backfill.test.js` → no new failures.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js servers/sharing/group-sync.js tests/lamport-reemit.test.js -m "feat(sync): backfill re-emits preserve row lamports (contacts, settings, groups) -- redelivery can no longer fabricate recency over in-flight peer writes (2c C2, gate G1/G2/G6/G6b/G7/G8)"
```

---

### Task 6: C4 — flagless contact-tombstone re-emit (+ gate G4/G4b/G5/G5b)

**Files:**
- Modify: `servers/sharing/instance-sync.js` — rename `backfillContactsOnce` body → `_backfillContactsOnceGated`, add wrapper + `reemitContactTombstones()`
- Test: `tests/lamport-reemit.test.js` (append)

**Interfaces:**
- Consumes: `emitChange(..., { lamportTs })`; harness.
- Produces: `backfillContactsOnce()` — SAME external contract (mcp-mounts.js:121 unchanged; returns the gated body's count); `reemitContactTombstones()` returns re-emitted count.

- [ ] **Step 1: Failing tests** (G4 complete; G4b/G5/G5b per spec §5 rows — G5 MUST mutate `last_seen` on B's row between the two boots; G5b MUST deliver B's newer edit as `op="update"` and assert A drops it, B keeps its row, exactly 1 conflict row total on B across two more boots):

```js
test("G4: tombstone re-emit heals a peer that never received the delete", async () => {
  const f = newFleet();
  for (const inst of [f.A, f.B]) {
    await inst.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:g4', '', 'g4aa', 'G4', 5)", args: [] });
  }
  const { deleteContactLocal } = await import("../servers/sharing/contact-delete.js");
  const rowsA = (await f.A.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g4'", args: [] })).rows;
  await act(f.A, () => deleteContactLocal(f.A.db, {}, rowsA[0]));
  f.skimWire(); // the live delete is LOST (never delivered) — the D-C scenario
  // Seed a 'prune' tombstone too: it must NOT ride (kind IS NULL filter).
  await f.A.db.execute({ sql: "INSERT INTO contact_tombstones (crow_id, lamport_ts, deleted_at, kind) VALUES ('crow:g4prune', 3, 1, 'prune')", args: [] });
  // Mark the gated backfill done so ONLY the finally-path re-emit can deliver.
  await f.A.db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('__contacts_backfill_v1', 'done:0') ON CONFLICT(key) DO UPDATE SET value = 'done:0'", args: [] });
  await f.A.mgr.backfillContactsOnce(); // boot path: gated body no-ops, finally re-emits
  const rode = f.wire.slice();
  assert.equal(rode.filter((w) => w.entry.op === "delete" && w.entry.row.crow_id === "crow:g4").length, 1, "authoritative tombstone rode");
  assert.equal(rode.filter((w) => w.entry.row.crow_id === "crow:g4prune").length, 0, "prune tombstone did NOT ride");
  await f.deliver();
  assert.equal((await f.B.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g4'", args: [] })).rows.length, 0, "B healed: row deleted");
});
```

- [ ] **Step 2: Run** → FAIL (`reemitContactTombstones` undefined / nothing rides).

- [ ] **Step 3: Implement** (mirror `backfillGroupsOnce`'s `:902-922` shape exactly):

```js
  /**
   * 2c C4 (spec §3): contacts mirror of W4's flagless group-tombstone re-emit.
   * Runs on EVERY exit path of the gated backfill. Only safe because the
   * envelope lamport is the tombstone's ORIGINAL global delete lamport
   * (preserve-mode) — a fresh mint here would beat a peer's genuinely-newer
   * re-add and wipe it (contacts allow re-add-after-delete, unlike groups).
   */
  async backfillContactsOnce() {
    try {
      return await this._backfillContactsOnceGated();
    } finally {
      await this.reemitContactTombstones();
    }
  }

  async reemitContactTombstones() {
    if (this.feedsDisabled) return 0;
    if (this.outFeeds.size === 0) return 0; // retry next boot; flagless by design (W4 rationale)
    // I-B1 drain: an already-delivered re-add-as-insert must clear our tombstone
    // BEFORE we re-emit it (rule order is load-bearing; spec §3 C4).
    try {
      for (const [peerId, inFeed] of this.inFeeds) {
        await this._processNewEntries(peerId, inFeed);
      }
    } catch (err) {
      console.warn(`[instance-sync] contact tombstone re-emit drain failed: ${err.message}`);
    }
    let rows = [];
    try {
      // kind IS NULL: authoritative user deletes ONLY ('prune' is local GC and
      // never rides — 2a). No-live-row join: never broadcast a delete for a
      // contact this instance still holds (anomalous state; spec R1/m-3).
      const r = await this.db.execute({
        sql: `SELECT t.crow_id, t.lamport_ts FROM contact_tombstones t
               LEFT JOIN contacts c ON c.crow_id = t.crow_id
               WHERE t.kind IS NULL AND c.crow_id IS NULL`,
      });
      rows = r.rows || [];
    } catch {
      return 0; // missing table / read failure → no-op (never throw at boot)
    }
    let emitted = 0;
    for (const row of rows) {
      try {
        const ts = await this.emitChange("contacts", "delete", { crow_id: row.crow_id },
          { lamportTs: Number(row.lamport_ts) || 0 });
        if (ts != null) emitted++;
      } catch (err) {
        console.warn(`[instance-sync] contact tombstone re-emit failed for ${row.crow_id}: ${err.message}`);
      }
    }
    if (emitted > 0) console.log(`[instance-sync] re-emitted ${emitted} contact tombstone delete(s) to all peers`);
    return emitted;
  }
```

Rename the existing `backfillContactsOnce` to `_backfillContactsOnceGated` (body unchanged from task 5's state; keep its doc comment, add a line noting the wrapper).

- [ ] **Step 4: Verify** — gate file green; `tests/messages-contacts-backfill.test.js` + `tests/instance-sync.test.js` no new failures (they call `backfillContactsOnce` — contract preserved).

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/lamport-reemit.test.js -m "feat(sync): flagless per-boot contact tombstone re-emit at preserved lamports -- lost or re-pair-skipped deletes now heal; re-adds survive (2c C4, gate G4/G4b/G5/G5b)"
```

---

### Task 7: C7 — `restoreConflict` refuses natural-key tables (+ gate G10)

**Files:**
- Modify: `servers/sharing/sync-conflict-resolve.js` (~:125-140 — replace the crow_context special case)
- Test: `tests/lamport-reemit.test.js` (append G10)

**Interfaces:**
- Consumes: nothing from other tasks (independent).
- Produces: `restoreConflict` returns `{status:"refused"}` for `crow_context`, `contacts`, `contact_groups`.

- [ ] **Step 1: Failing test** — seed a conflict row for `contacts` and one for `contact_groups` (INSERT INTO sync_conflicts with JSON `row_id`, real `winning_data` JSON), call `restoreConflict(db, id)`, assert `status === "refused"` AND `winning_data` is byte-identical before/after (the corruption was the stale guard overwriting it with `'null'`). Assert an existing `crow_context` conflict is still refused.

- [ ] **Step 2: Run** → FAIL for contacts/contact_groups (`status` is `"stale"` and `winning_data` becomes `'null'` — the corruption, live).

- [ ] **Step 3: Implement** — replace the `if (table === "crow_context")` block with:

```js
  // Natural-key tables cannot be auto-restored: their conflict row_id is a JSON
  // key (crow_context: {section_key,device_id,project_id}; contacts: {crow_id};
  // contact_groups: {group_uid}), not a numeric id, so the id-keyed stale-snapshot
  // guard below would run SELECT ... WHERE id = '{...}', find nothing, re-snapshot
  // winning_data to 'null', and silently destroy the recorded local snapshot
  // (2c C7 / spec R3-Q4). Placement BEFORE the stale guard is load-bearing.
  const NATURAL_KEY_RESTORE_REFUSALS = {
    crow_context:
      "This version cannot be restored automatically. crow_context rows are keyed " +
      "by a composite key (section_key, device_id, project_id), not a single id. " +
      "Use crow_update_context_section to apply the values shown below.",
    contacts:
      "This version cannot be restored automatically. Contact conflicts are keyed " +
      "by crow_id, not a numeric id. Review the values shown below and re-apply " +
      "the change manually from the Contacts panel.",
    contact_groups:
      "This version cannot be restored automatically. Group conflicts are keyed " +
      "by group_uid, not a numeric id. Review the values shown below and re-apply " +
      "the change manually from the Groups panel.",
  };
  if (NATURAL_KEY_RESTORE_REFUSALS[table]) {
    return { status: "refused", message: NATURAL_KEY_RESTORE_REFUSALS[table] };
  }
```

- [ ] **Step 4: Verify** — G10 green; run any existing tests importing `restoreConflict` (`grep -rl restoreConflict tests/`) → no new failures (test 21 in instance-sync.test.js and group-tombstones.test.js T-cases must stay green — note the group-tombstones `restoreConflict` tests exercise the INSERT-branch refusal, which sits AFTER this guard; if one seeded a `contact_groups` restore expecting a different status, read it and reconcile — the REFUSAL is the spec-mandated behavior).

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/sync-conflict-resolve.js tests/lamport-reemit.test.js -m "fix(sync): restoreConflict refuses ALL natural-key tables (contacts, contact_groups join crow_context) -- the id-keyed stale guard was destroying their winning_data snapshots (2c C7, gate G10)"
```

---

### Task 8: G5c + mutation matrix + full gates

**Files:**
- Modify: `tests/lamport-reemit.test.js` (append G5c if not already covered by task 3's unit test — G5c must ALSO run through the two-instance apply path, not only the `_insertConflictRow` unit)
- No production code changes expected — this is the verification task.

- [ ] **Step 1: G5c two-instance variant** — divergent pair from G5b's shape; resolve B's conflict row (`UPDATE sync_conflicts SET resolved = 1`), boot A again (redelivery) → exactly one NEW unresolved row; boot again → 0 new.

- [ ] **Step 2: Execute the FULL mutation matrix from spec §5** — for EACH mutation: apply it (comment the guard / revert the option), run the NAMED test, confirm RED, restore, confirm GREEN. Record each pair in the ledger (`~/crow/.superpowers/sdd/progress.md` — git-ignored, do not commit). The matrix: C2-revert→G1/G2; drain-call-delete→G3b; drain-gut→G3; chain-bypass→G3c; finally-remove→G4; minted-tombstone-lamport→G5; C5-remove→G5-boot-2; key-drop-losing_instance_id→G2b; resolved-scope-drop→G5c; kind-filter-remove→G4-prune; livejoin-remove→G4b; C7-refusal-remove→G10 (both tables).
- [ ] **Step 3: Clean-tree checks** — `grep -rn "MUTATION\|if (false" servers/ tests/` → empty.
- [ ] **Step 4: Full suite on scratch env** — `T=$(mktemp -d); CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1 node --test tests/*.test.js 2>&1 | tail -5`. Expected: **1932+N pass / 2 fail / 0 skip** where N = new tests added and the 2 fails are both `bundles-validate-install` (run `fuser ~/.crow/data/crow.db` first; no scratch gateway may be alive).
- [ ] **Step 5: Repo gates** — `node scripts/check-port-allocation.js` (green iff exactly one error line: `Port 8090 (capstone-tracker)`); `node scripts/build-registry.mjs --check`.
- [ ] **Step 6: Commit any test additions**

```bash
git commit tests/lamport-reemit.test.js -m "test(sync): G5c two-instance resolve-then-redeliver case + mutation-matrix run recorded (2c gate complete)"
```

---

## After the plan (not tasks — session-level)

Final whole-branch adversarial review (fresh Opus subagent) → PR via GitHub MCP → local gates re-run on the merge result → fleet deploy (runbook order, NO migration rail needed — no schema change) → §7 live verification (pre-deploy tombstone audit ×4 instances first!) → soak → ledger + memory + plan-doc update → post-item CDP bug-hunt round.
