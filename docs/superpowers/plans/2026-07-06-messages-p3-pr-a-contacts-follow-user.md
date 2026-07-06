# Messages Phase 3 PR-A — Contacts + blocks follow the user — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the user's contact list — including blocks — sync across their own paired instances via the existing instance-sync mesh, so adding/editing/blocking/deleting a contact on one instance applies on all of them, and a synced-in contact becomes *live* (subscribed) on the receiver.

**Architecture:** The push side wires `emitChange("contacts", …)` at every contact-mutation site through a small guarded helper. The pull side adds a self-contained `_applyContact` handler — keyed on the stable `crow_id` (never the per-instance `AUTOINCREMENT id`) — dispatched in `_applyEntry` before the generic id-path, exactly mirroring the existing `_applyCrowContext`/`_applyDashboardSetting` natural-key handlers. A boot-injected `onContactSynced` hook wires a newly-synced, keyed, non-blocked, non-local-bot contact into the DHT topic + Nostr subscription (reusing `wireFullContact`). Carve-outs (`verified`/`last_seen` columns; `local-bot`/`pending` rows) ride on the existing `EXCLUDED_COLUMNS`/`shouldSyncRow` extension points.

**Tech Stack:** Node ESM, `@libsql/client` (SQLite), Node built-in test runner (`node --test`), Hypercore feeds (stubbed in tests), ed25519 sign/verify.

## Global Constraints

- **Test runner:** Node built-in — `node --test tests/<file>.test.js`. All tests live in `tests/*.test.js`. No third-party framework.
- **Commit discipline:** `git commit <path> -m "..."` with explicit positional paths (never bare `git commit`/`git add .`); the working tree carries unrelated untracked WIP that must not be swept. For a NEW file, `git add <thatpath>` first, then commit that path. Verify with `git show --stat HEAD` after each commit. Never attribute Claude as author/co-author.
- **Never-throw on the sync/receive path:** every new emit call and the `onContactSynced` hook must swallow their own errors (`.catch(()=>{})` / `try{}catch{}`) — a sync failure must never break the local write or the apply loop.
- **Key on `crow_id`, never `id`:** contacts' `id` is per-instance `AUTOINCREMENT`; `crow_id` is `NOT NULL UNIQUE` and stable. The apply path resolves the local row by `crow_id` exclusively and must ignore any wire `id`.
- **No schema change in PR-A.** `SCHEMA_GENERATION` stays **4**. (The delete-tombstone question — see Task 2 note — is deferred to plan-review; if review mandates a `deleted_at` column it becomes a bump to 5, handled as an added task.)
- **Trust boundary:** inbound entries are already ed25519-verified against the shared identity in `_applyEntry` (instance-sync.js:624) before dispatch — do not bypass it. `shouldSyncRow("contacts", …)` must gate on **apply** as well as emit (defense in depth), so a peer cannot inject a `pending`/`local-bot` row.

**Baseline:** full suite **1083/1083** @ `main` `996a0d42`. Live target for the eventual E2E: crow↔grackle (shared seed `crow:kdq7zskhat`, sync feeds confirmed live). black-swan is a distinct identity — not a sync target.

**Spec:** `docs/superpowers/specs/2026-07-06-messages-phase3-contacts-follow-user-design.md`.

---

### Task 1: Carve-out gates — `EXCLUDED_COLUMNS.contacts` + `shouldSyncRow` contacts branch

**Files:**
- Modify: `servers/sharing/instance-sync.js` (`EXCLUDED_COLUMNS` ~line 74; `shouldSyncRow` ~line 151)
- Test: `tests/contacts-sync.test.js` (create)

**Interfaces:**
- Consumes: existing `EXCLUDED_COLUMNS` map, `shouldSyncRow(table, row)`, exported `SYNCED_TABLES`.
- Produces: `shouldSyncRow("contacts", row)` returns `false` for `origin==='local-bot'` or a `request_status` outside `{null, undefined, 'accepted'}`; `true` otherwise. `EXCLUDED_COLUMNS.contacts = ["verified","last_seen"]` (stripped from every emitted wire row).

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-sync.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSyncRowForTest, EXCLUDED_COLUMNS } from "../servers/sharing/instance-sync.js";

test("shouldSyncRow: contacts carve-outs", () => {
  const ok = (row) => shouldSyncRowForTest("contacts", row);
  assert.equal(ok({ crow_id: "crow:a", request_status: null }), true, "full contact syncs");
  assert.equal(ok({ crow_id: "crow:a", request_status: "accepted" }), true, "accepted syncs");
  assert.equal(ok({ crow_id: "manual:x", contact_type: "manual" }), true, "manual address-book syncs");
  assert.equal(ok({ crow_id: "crow:a", is_blocked: 1 }), true, "blocked still syncs (block follows user)");
  assert.equal(ok({ crow_id: "crow:a", request_status: "pending" }), false, "pending stays local");
  assert.equal(ok({ crow_id: "crow:a", origin: "local-bot" }), false, "local-bot never syncs");
});

test("EXCLUDED_COLUMNS.contacts strips id + verified + last_seen", () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.contacts].sort(), ["id", "last_seen", "verified"]);
});
```

The `shouldSyncRow` function is currently module-private. Export a thin test alias (add near the existing exports): the test imports `shouldSyncRowForTest`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/contacts-sync.test.js`
Expected: FAIL — `shouldSyncRowForTest` is not exported / `EXCLUDED_COLUMNS.contacts` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `servers/sharing/instance-sync.js`, extend `EXCLUDED_COLUMNS` (currently ~line 74):

```js
const EXCLUDED_COLUMNS = {
  crow_instances: ["auth_token_hash"],
  providers: [],
  // Phase 3: `verified` is a per-device attestation ("I compared the safety
  // number on THIS device") — it must not be asserted on a device that never
  // checked. `last_seen` is bumped on every inbound DM (boot.js) — syncing it
  // would firehose the feed. `id` is the per-instance AUTOINCREMENT key — never
  // portable; strip it so the "never keys on id" invariant is true on the wire
  // too (the emit-side lamport stamp at :532 reads the ORIGINAL local row.id,
  // which is untouched by stripping the wire copy). All three stripped from the
  // wire; the row still syncs.
  contacts: ["verified", "last_seen", "id"],
};
```

Extend `shouldSyncRow` (currently ~line 151) — add the contacts branch before the default `return true`:

```js
function shouldSyncRow(table, row) {
  if (table === "contacts") {
    if (!row) return false;
    // local-bot contacts are hosted on THIS instance (instance-local secp key);
    // a phantom on a peer would point at a bot that isn't there.
    if (row.origin === "local-bot") return false;
    // Only established contacts sync. `pending` message-requests are a
    // per-instance inbox each instance forms from the shared inbound stream.
    const rs = row.request_status;
    if (rs !== null && rs !== undefined && rs !== "accepted") return false;
    return true;
  }
  if (table !== "dashboard_settings") return true;
  if (!row || !row.key) return false;
  return isSyncable(row.key);
}

// Test-only alias (keeps the function module-private for production callers).
export function shouldSyncRowForTest(table, row) { return shouldSyncRow(table, row); }
```

Also export `EXCLUDED_COLUMNS` for the test (add to the export surface — it is currently a private `const`; change to `export const EXCLUDED_COLUMNS`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/contacts-sync.test.js`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add tests/contacts-sync.test.js
git commit tests/contacts-sync.test.js servers/sharing/instance-sync.js -m "feat(sharing): Phase 3 contact-sync carve-outs (exclude verified/last_seen; gate local-bot/pending)"
git show --stat HEAD | head
```

---

### Task 2: `_applyContact` inbound handler (crow_id-keyed) + dispatch

**Files:**
- Modify: `servers/sharing/instance-sync.js` (dispatch in `_applyEntry` after the `crow_context` block ~line 665; new `_applyContact` method after `_applyCrowContext` ~line 911)
- Test: `tests/contacts-sync.test.js` (extend)

**Interfaces:**
- Consumes: `_applyEntry`'s already-verified `{ op, row, lamport_ts, instance_id }`; `rowsEquivalent`, `_insertConflictRow(tableName, rowId, winInst, loseInst, winTs, loseTs, winData, loseData, conflictOp)`, `_notifyConflict()`, `shouldSyncRow`.
- Produces: `async _applyContact(op, row, lamportTs, instanceId)` — natural-key (crow_id) upsert/delete with LWW; fires `this.onContactSynced?.(localRow)` (guarded) after any insert/update that leaves a live row. Reads `this.onContactSynced` (a boot-injected callback, default undefined → no-op).

- [ ] **Step 1: Write the failing tests**

Append to `tests/contacts-sync.test.js`. Reuse the harness style from `tests/instance-sync.test.js` (real init-db tmpdir, `sign()` to forge entries). Add at the top of the file:

```js
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const LOCAL_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-000000000002";

function mgr(id = LOCAL_ID) { return new InstanceSyncManager(IDENTITY, createDbClient(DB_PATH), id); }
function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}
const SECP_A = "a".repeat(64), SECP_B = "b".repeat(64);
```

Then the behavior tests:

```js
test("_applyContact: insert keys on crow_id, not per-instance id", async () => {
  const m = mgr(); const db = m.db;
  // Local contact happens to hold id that a remote insert also carries.
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (7,'crow:local','', ?)", args: [SECP_A] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert",
    { id: 7, crow_id: "crow:remote", ed25519_pubkey: "", secp256k1_pubkey: SECP_B, display_name: "Remote" }, 10));
  const local = (await db.execute({ sql: "SELECT crow_id FROM contacts WHERE crow_id='crow:local'" })).rows;
  const remote = (await db.execute({ sql: "SELECT crow_id, display_name FROM contacts WHERE crow_id='crow:remote'" })).rows;
  assert.equal(local.length, 1, "local row untouched (id collision did NOT clobber)");
  assert.equal(remote.length, 1, "remote contact created under its own crow_id");
  assert.equal(remote[0].display_name, "Remote");
});

test("_applyContact: LWW update — newer applies, stale skips + logs conflict", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:lww','', ?, 'Old', 5)", args: [SECP_A] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:lww", display_name: "New", secp256k1_pubkey: SECP_A }, 9));
  assert.equal((await db.execute({ sql: "SELECT display_name FROM contacts WHERE crow_id='crow:lww'" })).rows[0].display_name, "New");
  const before = (await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts" })).rows[0].c;
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:lww", display_name: "Stale", secp256k1_pubkey: SECP_A }, 3));
  assert.equal((await db.execute({ sql: "SELECT display_name FROM contacts WHERE crow_id='crow:lww'" })).rows[0].display_name, "New", "stale ignored");
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM sync_conflicts" })).rows[0].c, before + 1, "conflict logged");
});

test("_applyContact: delete is lamport-gated by crow_id", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, lamport_ts) VALUES ('crow:del','', ?, 5)", args: [SECP_A] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "delete", { crow_id: "crow:del" }, 3)); // stale
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:del'" })).rows[0].c, 1, "stale delete kept local");
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "delete", { crow_id: "crow:del" }, 9)); // newer
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:del'" })).rows[0].c, 0, "newer delete applied");
});

test("_applyContact: apply drops verified/last_seen and honors carve-outs", async () => {
  const m = mgr(); const db = m.db;
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert",
    { crow_id: "crow:carve", ed25519_pubkey: "", secp256k1_pubkey: SECP_A, verified: 1, last_seen: "2020-01-01" }, 4));
  const row = (await db.execute({ sql: "SELECT verified, last_seen FROM contacts WHERE crow_id='crow:carve'" })).rows[0];
  assert.equal(row.verified, 0, "verified not set from wire (local default)");
  assert.equal(row.last_seen, null, "last_seen not set from wire");
  // a peer-injected pending/local-bot row is dropped on apply
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", { crow_id: "crow:req", secp256k1_pubkey: SECP_B, ed25519_pubkey: "", request_status: "pending" }, 4));
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) c FROM contacts WHERE crow_id='crow:req'" })).rows[0].c, 0, "pending not applied");
});

test("_applyContact: a synced key-rebind resets verified to 0 (PR3 parity)", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, verified, lamport_ts) VALUES ('crow:rebind','e', ?, 1, 5)", args: [SECP_A] });
  // newer update rebinds the secp key → verified must clear
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:rebind", secp256k1_pubkey: SECP_B }, 9));
  const row = (await db.execute({ sql: "SELECT secp256k1_pubkey, verified FROM contacts WHERE crow_id='crow:rebind'" })).rows[0];
  assert.equal(row.secp256k1_pubkey, SECP_B, "key rebound");
  assert.equal(row.verified, 0, "verified reset on key change");
});

test("_applyContact: a same-key update preserves verified", async () => {
  const m = mgr(); const db = m.db;
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, verified, lamport_ts) VALUES ('crow:keep','e', ?, 'X', 1, 5)", args: [SECP_A] });
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "update", { crow_id: "crow:keep", secp256k1_pubkey: SECP_A, display_name: "Y" }, 9));
  const row = (await db.execute({ sql: "SELECT display_name, verified FROM contacts WHERE crow_id='crow:keep'" })).rows[0];
  assert.equal(row.display_name, "Y", "display updated");
  assert.equal(row.verified, 1, "verified preserved when key unchanged");
});

test("_applyContact: fires onContactSynced with the local row; never throws on junk", async () => {
  const m = mgr(); const seen = [];
  m.onContactSynced = (r) => seen.push(r);
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", { crow_id: "crow:hook", ed25519_pubkey: "", secp256k1_pubkey: SECP_A }, 4));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].crow_id, "crow:hook");
  assert.equal(typeof seen[0].id, "number", "hook receives the local row with a local id");
  await m._applyEntry(REMOTE_ID, signedEntry("contacts", "insert", { nonsense: true }, 4)); // no crow_id → no throw
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/contacts-sync.test.js`
Expected: FAIL — contacts entries currently fall through to the generic id-path (`crow:remote` insert would clobber/misbehave; `onContactSynced` never fires).

- [ ] **Step 3: Write the dispatch + `_applyContact`**

Add the pubkey-normalizer import at the top of `servers/sharing/instance-sync.js` if not already present (used by the verified-reset key-change check):

```js
import { normalizePubkey } from "./pubkey-util.js";
```

In `_applyEntry`, add a dispatch block immediately after the `crow_context` block (after line 665, before the generic `_checkConflict`/switch at 667):

```js
    // contacts is keyed by the stable crow_id (per-instance AUTOINCREMENT id is
    // NOT portable). Route ALL ops through the natural-key handler, mirroring
    // _applyCrowContext. shouldSyncRow already gated at :617, but re-checking
    // inside is cheap defense.
    if (table === "contacts") {
      try {
        await this._applyContact(op, row, lamport_ts, instance_id);
      } catch (err) {
        console.warn(`[instance-sync] Failed to apply ${op} on contacts:`, err.message);
      }
      return;
    }
```

Add the method after `_applyCrowContext` (after line 911). It mirrors `_applyCrowContext` with `crow_id` as the single natural key:

```js
  /**
   * Apply a contacts mutation keyed on the stable crow_id (Phase 3 / D1).
   * Per-instance AUTOINCREMENT id is never used. LWW by lamport_ts, matching
   * _applyCrowContext / _checkConflict (W4-1) semantics. After any insert/update
   * that leaves a live row, fires this.onContactSynced(localRow) so the receiver
   * subscribes to the contact (boot-injected; undefined in tests/pre-boot).
   *
   * @param {"insert"|"update"|"delete"} op
   * @param {object} row - wire row (no local id; keyed by crow_id)
   * @param {number} lamportTs
   * @param {string} instanceId - origin instance id
   */
  async _applyContact(op, row, lamportTs, instanceId) {
    const crowId = row && row.crow_id;
    if (!crowId) {
      console.warn("[instance-sync] _applyContact: missing crow_id — skipping");
      return;
    }

    // PRAGMA-filter incoming keys to live columns; always drop id/lamport_ts/
    // instance_id and the never-synced verified/last_seen (defense on apply).
    if (!this._contactCols) {
      try {
        const { rows: pragma } = await this.db.execute({ sql: "PRAGMA table_info(contacts)", args: [] });
        this._contactCols = new Set(pragma.map((r) => r.name));
      } catch { this._contactCols = null; }
    }
    const ALWAYS_DROP = new Set(["id", "lamport_ts", "instance_id", "verified", "last_seen"]);
    const filtered = {};
    for (const [k, v] of Object.entries(row)) {
      if (ALWAYS_DROP.has(k)) continue;
      if (this._contactCols && !this._contactCols.has(k)) continue;
      filtered[k] = v;
    }

    const { rows: localRows } = await this.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] });
    const localRow = localRows[0] ?? null;
    const localTs = localRow?.lamport_ts || 0;
    const rowIdJson = JSON.stringify({ crow_id: crowId });

    // ── delete ──────────────────────────────────────────────────────────────
    if (op === "delete") {
      if (!localRow) return;
      if (lamportTs > localTs) {
        await this.db.execute({ sql: "DELETE FROM contacts WHERE crow_id = ?", args: [crowId] });
        return;
      }
      try {
        await this._insertConflictRow("contacts", rowIdJson,
          localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
          JSON.stringify(localRow), JSON.stringify(filtered), "delete");
        await this._notifyConflict();
      } catch (err) {
        console.warn("[instance-sync] contacts delete conflict LOGGING failed (local kept):", err.message);
      }
      return;
    }

    // ── insert / update ────────────────────────────────────────────────────
    if (!localRow) {
      // NOT NULL parity (ed25519_pubkey, secp256k1_pubkey are NOT NULL,
      // init-db:459-460). A partial old-sender row would throw; skip with a
      // warning instead, mirroring _applyCrowContext's required-column guard.
      // (Empty string '' is fine — manual/keyless contacts carry ''; only a
      // truly-absent column is skipped.)
      if (filtered.secp256k1_pubkey == null || filtered.ed25519_pubkey == null) {
        console.warn("[instance-sync] _applyContact: insert skipped — NOT NULL pubkey column absent");
        return;
      }
      const cols = Object.keys(filtered).filter((k) => filtered[k] !== undefined);
      if (!cols.includes("crow_id")) cols.push("crow_id");
      const insertCols = [...new Set(cols)];
      const placeholders = insertCols.map(() => "?").join(", ");
      const values = insertCols.map((k) => (k === "crow_id" ? crowId : filtered[k] ?? null));
      await this.db.execute({
        sql: `INSERT INTO contacts (${insertCols.join(", ")}, lamport_ts) VALUES (${placeholders}, ?)`,
        args: [...values, lamportTs],
      });
      await this._afterContactApplied(crowId);
      return;
    }

    if (lamportTs > localTs) {
      const updateKeys = Object.keys(filtered).filter((k) => k !== "crow_id");
      // PR3 parity (R1 finding): a synced key rebind invalidates a local
      // safety-number check. `verified` is excluded from the wire (only ever set
      // by a local device comparison), so a secp/ed change MUST reset it to 0 —
      // matching contact-promote.js:124,165 on the local promote/merge path.
      const secpChanged = filtered.secp256k1_pubkey != null &&
        normalizePubkey(String(filtered.secp256k1_pubkey)) !== normalizePubkey(String(localRow.secp256k1_pubkey || ""));
      const edChanged = filtered.ed25519_pubkey != null &&
        String(filtered.ed25519_pubkey) !== String(localRow.ed25519_pubkey || "");
      const setClauses = updateKeys.map((k) => `${k} = ?`);
      const vals = updateKeys.map((k) => filtered[k] ?? null);
      if (secpChanged || edChanged) setClauses.push("verified = 0");
      setClauses.push("lamport_ts = ?"); vals.push(lamportTs);
      await this.db.execute({ sql: `UPDATE contacts SET ${setClauses.join(", ")} WHERE crow_id = ?`, args: [...vals, crowId] });
      await this._afterContactApplied(crowId);
      return;
    }

    // incomingTs <= localTs
    if (rowsEquivalent(localRow, filtered)) return; // re-delivery noise
    try {
      await this._insertConflictRow("contacts", rowIdJson,
        localRow.instance_id || this.localInstanceId, instanceId, localTs, lamportTs,
        JSON.stringify(localRow), JSON.stringify(filtered), op || "update");
      await this._notifyConflict();
    } catch (err) {
      console.warn("[instance-sync] contacts conflict LOGGING failed (local kept):", err.message);
    }
  }

  /** Re-select the applied row and hand it to the subscribe hook (guarded). */
  async _afterContactApplied(crowId) {
    try {
      const { rows } = await this.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] });
      if (rows[0] && typeof this.onContactSynced === "function") {
        Promise.resolve(this.onContactSynced(rows[0])).catch(() => {});
      }
    } catch {}
  }
```

Note the apply path does **not** re-run `shouldSyncRow` explicitly because `_applyEntry` already gated at line 617 — but confirm that gate covers the contacts branch (Task 1 makes `shouldSyncRow("contacts", row)` real, and `_applyEntry:617` calls `shouldSyncRow(table, row)` for every table). The `crow:req`/pending test above passes *because of* that :617 gate. Add a one-line comment at the dispatch pointing to it.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/contacts-sync.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/contacts-sync.test.js -m "feat(sharing): Phase 3 _applyContact — crow_id-keyed inbound apply with LWW + onContactSynced"
git show --stat HEAD | head
```

**Plan-review note (delete/tombstone, spec A5) — RESOLVED by R1: keep hard-delete, no tombstone.** PR-A uses a lamport-gated **hard delete**, matching the `_applyCrowContext` precedent. R1 verified the resurrection worry is unreachable in PR-A scope: (1) the only user-facing contact delete is `contacts:239` `WHERE contact_type='manual'` — manual `crow_id`s are `manual:${randomUUID()}`, created on exactly one instance, so their insert+delete originate on the same Hypercore feed → processed in-order by the peer → no reorder → no resurrection on a 2-instance fleet; (2) real crow contacts have **no** delete path (a block is an `is_blocked=1` update, not a delete), so "blocked-then-deleted → resurrected unblocked" cannot occur; (3) the `upsertFullContact` MERGE `emitContactDelete` folds a same-secp row whose insert precedes its delete on one feed. **Residual (documented, not fixed):** if the fleet grows to **3+ shared-identity instances** OR a future PR adds deletion of real crow contacts, cross-feed reorder could resurrect via the un-gated insert-when-missing branch — revisit a `deleted_at` tombstone (`SCHEMA_GENERATION 4→5`) then. No unsubscribe-on-delete hook in PR-A (propagated deletes are keyless/manual or same-key merge-folds → nothing subscribed to clean up); flagged for the coherence/groups PRs.

---

### Task 3: `onContactSynced` hook — gated wire + boot injection

**Files:**
- Modify: `servers/sharing/contact-promote.js` (export a gated `wireSyncedContact`; `wireFullContact` already exists ~line 75)
- Modify: `servers/gateway/boot/mcp-mounts.js` (inject `ism.onContactSynced` where `getInstanceSyncManager()` is already fetched ~line 30)
- Test: `tests/contacts-sync-hook.test.js` (create)

**Interfaces:**
- Consumes: `wireFullContact(managers, row)` (contact-promote.js — calls `syncManager.initContact`, `peerManager.joinContact`, `nostrManager.subscribeToContact`); `getManagersOrNull()` (managers.js); `getInstanceSyncManager()` (managers.js).
- Produces: `async wireSyncedContact(managers, row)` (exported) — wires a keyed, non-blocked, non-local-bot contact; unsubscribes a newly-blocked one; no-ops a keyless (manual) contact; never throws. Boot sets `instanceSyncManager.onContactSynced = (row) => { wireSyncedContact(getManagersOrNull(), row); }`.

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-sync-hook.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireSyncedContact } from "../servers/sharing/contact-promote.js";

function spyManagers() {
  const calls = { subscribe: [], join: [], init: [], close: [], leave: [] };
  return {
    calls,
    nostrManager: { subscribeToContact: async (c) => { calls.subscribe.push(c.crow_id); } },
    peerManager: { joinContact: async (c) => { calls.join.push(c.crowId); }, leaveContact: async (id) => { calls.leave.push(id); } },
    syncManager: { initContact: async (id) => { calls.init.push(id); }, closeContactFeeds: async (id) => { calls.close.push(id); } },
  };
}
const SECP = "a".repeat(64);

test("wireSyncedContact: subscribes a keyed, non-blocked contact", async () => {
  const m = spyManagers();
  await wireSyncedContact(m, { id: 1, crow_id: "crow:x", secp256k1_pubkey: SECP, ed25519_pubkey: "e", is_blocked: 0 });
  assert.deepEqual(m.calls.subscribe, ["crow:x"]);
  assert.deepEqual(m.calls.join, ["crow:x"]);
});

test("wireSyncedContact: newly-blocked contact unsubscribes, does not subscribe", async () => {
  const m = spyManagers();
  await wireSyncedContact(m, { id: 2, crow_id: "crow:b", secp256k1_pubkey: SECP, is_blocked: 1 });
  assert.deepEqual(m.calls.subscribe, []);
  assert.deepEqual(m.calls.close, [2]);
  assert.deepEqual(m.calls.leave, ["crow:b"]);
});

test("wireSyncedContact: keyless (manual) + local-bot contacts do not subscribe", async () => {
  const m = spyManagers();
  await wireSyncedContact(m, { id: 3, crow_id: "manual:x", secp256k1_pubkey: "", contact_type: "manual" });
  await wireSyncedContact(m, { id: 4, crow_id: "crow:lb", secp256k1_pubkey: SECP, origin: "local-bot" });
  assert.deepEqual(m.calls.subscribe, []);
});

test("wireSyncedContact: never throws on null managers", async () => {
  await wireSyncedContact(null, { id: 5, crow_id: "crow:n", secp256k1_pubkey: SECP });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/contacts-sync-hook.test.js`
Expected: FAIL — `wireSyncedContact` not exported.

- [ ] **Step 3: Implement `wireSyncedContact` + boot injection**

In `servers/sharing/contact-promote.js`, add (near `wireFullContact`):

```js
const HEX_SECP = /^[0-9a-fA-F]{64}(?:[0-9a-fA-F]{2})?$/;

/**
 * Phase 3: wire a contact that arrived via instance-sync into the live layer.
 *   - blocked      → unsubscribe (close feeds + leave DHT topic), no Nostr sub
 *   - local-bot    → no-op (hosted elsewhere; never subscribe on a peer)
 *   - keyless      → no-op (manual address-book entry has no secp key)
 *   - otherwise    → wireFullContact (initContact + joinContact + subscribeToContact)
 * Fully guarded — the apply loop must never throw.
 */
export async function wireSyncedContact(managers, row) {
  try {
    if (!managers || !row) return;
    const { syncManager, peerManager } = managers;
    if (row.is_blocked) {
      try { if (syncManager && row.id != null) await syncManager.closeContactFeeds(row.id); } catch {}
      try { if (peerManager && row.crow_id) await peerManager.leaveContact(row.crow_id); } catch {}
      return;
    }
    if (row.origin === "local-bot") return;
    if (!row.secp256k1_pubkey || !HEX_SECP.test(String(row.secp256k1_pubkey))) return; // manual/keyless
    await wireFullContact(managers, row);
  } catch { /* never throw into the sync apply loop */ }
}
```

In `servers/gateway/boot/mcp-mounts.js`, where `syncManager` (= the InstanceSyncManager) is already obtained (~line 30), add the injection (after the `setProviderSyncManager`/`setSettingsSyncManager` wiring). Import at the top: `import { wireSyncedContact } from "../../sharing/contact-promote.js";` and `getManagersOrNull` from `../../sharing/managers.js` (or reuse the already-imported accessor):

```js
  // Phase 3: when a contact syncs in from a paired instance, wire it live
  // (subscribe to its DMs / join its topic). Guarded; never throws.
  if (syncManager) {
    syncManager.onContactSynced = (row) => { wireSyncedContact(getManagersOrNull(), row); };
  }
```

Verify `getManagersOrNull` is imported in mcp-mounts.js; if not, add it to the existing `../../sharing/managers.js` import or `../../sharing/server.js` re-export.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/contacts-sync-hook.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add tests/contacts-sync-hook.test.js
git commit servers/sharing/contact-promote.js servers/gateway/boot/mcp-mounts.js tests/contacts-sync-hook.test.js -m "feat(sharing): Phase 3 onContactSynced hook — wire synced contacts live, gated for blocked/local-bot/keyless"
git show --stat HEAD | head
```

---

### Task 4a: Emit helper + push side in the sharing server (upsertFullContact, tools, boot)

**Files:**
- Create: `servers/sharing/contact-sync.js` (the `emitContactChange` helper)
- Modify: `servers/sharing/contact-promote.js` (`upsertFullContact` — emit per outcome + the merge delete)
- Modify: `servers/sharing/tools/contacts.js` (insert ~line 366)
- Test: `tests/contacts-sync-emit.test.js` (create)

**Interfaces:**
- Consumes: `getInstanceSyncManager()` (managers.js). `upsertFullContact` return `{ contactId, outcome }` with `outcome ∈ {created, promoted, merged, noop}`.
- Produces: `emitContactChange(op, row)` — guarded `getInstanceSyncManager()?.emitChange("contacts", op, row)`; null pre-boot/in tests (no-op). `emitContactDelete(crowId)` — convenience for the `{crow_id}` delete wire shape.

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-sync-emit.test.js`. Because `emitContactChange` reads a module singleton, the test injects a spy via an exported test seam:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { emitContactChange, emitContactDelete, __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";

test("emitContactChange forwards op+row to the sync manager", async () => {
  const seen = [];
  __setEmitSinkForTest({ emitChange: async (t, op, row) => seen.push([t, op, row.crow_id]) });
  await emitContactChange("insert", { crow_id: "crow:e1" });
  await emitContactChange("update", { crow_id: "crow:e2", is_blocked: 1 });
  await emitContactDelete("crow:e3");
  assert.deepEqual(seen, [
    ["contacts", "insert", "crow:e1"],
    ["contacts", "update", "crow:e2"],
    ["contacts", "delete", "crow:e3"],
  ]);
  __setEmitSinkForTest(null);
});

test("emitContactChange is a no-op with no manager (pre-boot / tests)", async () => {
  __setEmitSinkForTest(null);
  await emitContactChange("insert", { crow_id: "crow:none" }); // must not throw
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/contacts-sync-emit.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper + wire upsertFullContact + tools**

Create `servers/sharing/contact-sync.js`:

```js
/**
 * Phase 3 (D1): push contact mutations onto the instance-sync mesh.
 * Guarded + null-safe — a sync failure never breaks the local write, and the
 * sink is null pre-boot / in unit tests (no-op). Emits carry the FULL row for
 * insert/update; deletes carry only { crow_id } (the natural key). Carve-outs
 * (verified/last_seen columns, local-bot/pending rows) are enforced downstream
 * by EXCLUDED_COLUMNS.contacts + shouldSyncRow in instance-sync.js.
 */
// R1 finding: managers.js → nostr.js → contact-promote.js → contact-sync.js
// forms a cycle if we STATIC-import managers here. Lazy (cached) dynamic import
// keeps the module-load graph acyclic; the import resolves once, before any
// emit fires at runtime.
let _mgrMod = null;
let _testSink = null;
export function __setEmitSinkForTest(sink) { _testSink = sink; }

async function sink() {
  if (_testSink) return _testSink;
  if (!_mgrMod) { try { _mgrMod = await import("./managers.js"); } catch { return null; } }
  return _mgrMod.getInstanceSyncManager?.() || null;
}

export async function emitContactChange(op, row) {
  try { (await sink())?.emitChange("contacts", op, row); } catch { /* never throw */ }
}
export async function emitContactDelete(crowId) {
  if (!crowId) return;
  try { (await sink())?.emitChange("contacts", "delete", { crow_id: crowId }); } catch { /* never throw */ }
}
```

**Note (R1):** the emit path is therefore NOT statically self-contained — it reaches `managers.js` via a lazy dynamic import specifically to break the `managers → nostr → contact-promote → contact-sync` cycle. Do not "simplify" this to a static import.

In `servers/sharing/contact-promote.js`, import the helper and emit after each terminal outcome. Add `import { emitContactChange, emitContactDelete } from "./contact-sync.js";` at the top, then:
- In the MERGE branch (after the owner row is finalized, before `return {..."merged"}`): emit the folded row's delete + the owner's update.
  ```js
  await emitContactDelete(otherSecp.crow_id);
  await emitContactChange("update", row);
  ```
- In the PROMOTE branch (before `return {..."promoted"}`): `await emitContactChange("update", row);`
- In the CREATE branch (before `return {..."created"}`): `await emitContactChange("insert", row);`
- NOOP: no emit (nothing changed that peers need).

(These reuse the `row` already re-selected for `wireFullContact`.)

In `servers/sharing/tools/contacts.js`: **clarification (R1)** — `crow_add_contact` (the primary add path) already routes through `upsertFullContact` (~line 326), which Task 4a instruments above; it needs **no** separate emit. The only raw `INSERT INTO contacts` here is the **bot-accept** at ~line 366 (`crow_accept_bot_invite`). Advertised/remote bots sync per S-BOTS, so emit an insert there and there only:
```js
// (after the bot-accept INSERT) — Phase 3: propagate to the user's other instances.
const { rows: __r } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId] });
if (__r[0]) { const { emitContactChange } = await import("../contact-sync.js"); await emitContactChange("insert", __r[0]); }
```
(Verify the local variable holding the inserted crow_id at that site; do NOT also instrument the `upsertFullContact` call path.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/contacts-sync-emit.test.js`
Expected: PASS (2/2).

Then a focused regression on the promote path:
Run: `node --test tests/contact-promote.test.js`
Expected: PASS (unchanged — emits are guarded no-ops without a manager).

- [ ] **Step 5: Commit**

```bash
git add servers/sharing/contact-sync.js tests/contacts-sync-emit.test.js
git commit servers/sharing/contact-sync.js servers/sharing/contact-promote.js servers/sharing/tools/contacts.js tests/contacts-sync-emit.test.js -m "feat(sharing): Phase 3 emit contacts on upsert/tool mutations (push side)"
git show --stat HEAD | head
```

---

### Task 4b: Push side in the dashboard panels (contacts + messages)

**Files:**
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js` (block :41, unblock :70, verify — **skip**, insert :93, edit :228, delete :239, advertised-add :334/365)
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js` (block :68, unblock :96, accept_request :278, advertised-add :230; decline :303 — **skip**, no emit)
- Test: `tests/contacts-sync-panel-emit.test.js` (create)

**Interfaces:**
- Consumes: `getManagersOrNull()` (already imported in both panels), `emitContactChange`/`emitContactDelete` (contact-sync.js). The panels already resolve `managers` for other calls.

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-sync-panel-emit.test.js`. Drive `handleContactAction` / `handlePostAction` against a real init-db DB with the emit sink spied. (Follow the harness in `tests/contacts-peer-add.test.js` / `tests/contacts-add-by-id-action.test.js` for constructing `req`/`res` stubs and the DB.) Assert:

```js
// block emits an update carrying is_blocked=1
// unblock emits an update carrying is_blocked=0
// manual insert emits an insert
// edit emits an update
// delete emits a delete keyed on the contact's crow_id
// accept_request (pending→accepted) emits an update
// decline_request emits NOTHING (pending never syncs)
```

Use `__setEmitSinkForTest` to capture `[op, crow_id, is_blocked?]` and assert per action. (Write out each assertion explicitly — one `test(...)` per action — following the existing panel-action test files' structure. The verify toggle (`set_verified`) asserts NO emit.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/contacts-sync-panel-emit.test.js`
Expected: FAIL — panels don't emit yet.

- [ ] **Step 3: Instrument the panel sites**

Pattern at each mutating branch: after the existing `db.execute(...)` write, re-select the affected row (by `id` locally is fine here — we're on the origin instance) and emit. Import `import { emitContactChange, emitContactDelete } from "../../../../sharing/contact-sync.js";` at the top of each panel.

- **block** (contacts :41, messages :68 — messages keys on `crow_id`): after the UPDATE, `const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?"/or crow_id, args:[...] }); if (rows[0]) await emitContactChange("update", rows[0]);`
- **unblock** (contacts :70, messages :96): same, emits `update`.
- **manual insert** (contacts :93): re-select by the `manualCrowId` just created; `await emitContactChange("insert", rows[0]);`
- **edit** (contacts :228): after the dynamic UPDATE, re-select by id; `await emitContactChange("update", rows[0]);`
- **delete** (contacts :239): the row is deleted `WHERE id=? AND contact_type='manual'` — fetch `crow_id` BEFORE the delete, then after a successful delete `await emitContactDelete(crowId);`
- **accept_request** (messages :278): after `UPDATE ... 'accepted'`, re-select the row (now `accepted`) by id; `await emitContactChange("update", rows[0]);` (this is the pending→established transition — shouldSyncRow now lets it through).
- **advertised bot add** (contacts :334/365, messages :230): after the insert/`origin='advertised'` update, re-select by `crow_id`; `await emitContactChange("insert", rows[0]);` (advertised remote bots sync per S-BOTS).
- **decline_request** (messages :303) + **verify toggle** (contacts :80) + **local-bot writes**: **no emit** (pending never syncs; verified is per-device; local-bot excluded). Add a one-line comment at each explaining the deliberate omission.

Each emit is `await`ed but guarded (helper never throws); wrap in the same defensive style if the surrounding code is not already in a try.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/contacts-sync-panel-emit.test.js`
Expected: PASS.

Then regressions:
Run: `node --test tests/contacts-peer-add.test.js tests/contacts-add-by-id-action.test.js tests/contacts-trust-ui.test.js`
Expected: PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
git add tests/contacts-sync-panel-emit.test.js
git commit servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/panels/messages/api-handlers.js tests/contacts-sync-panel-emit.test.js -m "feat(dashboard): Phase 3 emit contacts on panel block/unblock/add/edit/delete/accept (push side)"
git show --stat HEAD | head
```

---

### Task 5: Full-suite verification, isolated boot smoke, self-review, ledger

**Files:**
- Modify: `.superpowers/sdd/progress.md` (git-ignored — do NOT `git add`)

- [ ] **Step 1: Full suite**

Run: `node --test tests/`
Expected: **≥1083 pass** + the new PR-A tests, 0 fail (~35s). If any pre-existing flaky (`crow-accept-bot-invite.test.js` handle-leak) appears, confirm it fails identically on `main` before attributing.

- [ ] **Step 2: Isolated boot smoke (no schema bump expected)**

```bash
D=$(mktemp -d); CROW_GATEWAY_URL= CROW_DATA_DIR=$D PORT=3999 timeout -k 5 25 node servers/gateway/index.js --no-auth > /tmp/p3boot.log 2>&1
grep -E "listening|Subscribed|Error|Schema" /tmp/p3boot.log
sqlite3 $D/crow.db "PRAGMA user_version;"   # expect 4 (NO bump in PR-A)
```
Expected: `listening`, `[nostr] Subscribed to incoming on N relay(s)`, `[sharing] Subscribed to incoming Nostr messages`, no new `Error`, `user_version=4`. (The pre-existing `unknown or invalid runtime name: nvidia` docker/vllm noise is fine.)

- [ ] **Step 3: Plan self-review vs spec**

Confirm each PR-A spec item maps to a task: emit sites (Task 4a/4b) ✓; `_applyContact` crow_id-keyed (Task 2) ✓; carve-outs verified/last_seen/local-bot/pending (Task 1) ✓; `onContactSynced` subscribe hook (Task 3) ✓; delete lamport-gated (Task 2) ✓; no-schema (confirmed Step 2). PR-B (coherence) and groups are explicitly out of PR-A scope.

- [ ] **Step 4: Update the git-ignored ledger** (do NOT `git add`)

Append a PR-A status block to `.superpowers/sdd/progress.md` (task-by-task outcomes, commit anchors, suite count).

- [ ] **Step 5: No commit for the ledger.** PR-A code is already committed per-task. Proceed to the whole-branch final SECURITY review (opus) before opening the PR.

---

## Post-plan pipeline (not tasks — the arc's standing process)

1. **2-round adversarial SECURITY review** of THIS plan (opus subagent) before any code — hardest on: the `crow_id`-keyed apply (id-portability, forged-id collision), signature/identity binding not bypassed by the new dispatch, `shouldSyncRow` gating on **apply** (no `pending`/`local-bot` injection), delete/tombstone residual (Task 2 note), `onContactSynced` never-throw + no-subscribe-on-blocked/keyless. Do NOT code until both rounds pass.
2. **Subagent-driven execution** (fresh sonnet implementer per task, TDD, per-task spec+quality review; dispatch fix subagents for Critical/Important).
3. **Opus final whole-branch SECURITY review** (this touches cross-instance data flow).
4. **PR** via github MCP (owner `kh0pper`, repo `crow`, base `main`); check-runs verified pre-merge (expect 0 applicable — port-allocation path-filtered off this diff).
5. **Merge** = MERGE COMMIT, **operator-gated** (AskUserQuestion).
6. **Deploy** crow first, then **grackle** (contacts-follow-user needs BOTH the pair on the new code): `git checkout main && git pull --rebase && sudo systemctl restart crow-gateway`. Verify on each: `/health` 200, `PRAGMA user_version`, `integrity_check ok`, 4 relays + both subscribe lines, sync feeds initialized. (grackle also applies PR3's `verified` migration user_version 3→4 on this restart.)
7. **LIVE E2E:** add a contact on crow → confirm it appears (and is subscribed) on grackle; block on crow → blocked on grackle; DM the contact both ways reads coherently. Then Phase 3 PR-B (coherence).
