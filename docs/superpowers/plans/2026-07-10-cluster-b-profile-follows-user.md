# Cluster B — Profile Follows the User Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard profile save real (write the global scope, sync to the user's paired instances) so the profile page shows what you saved and handshakes carry one consistent name — fixing F-SETTINGS-1 and F-CONTACT-5.

**Architecture:** Allowlist the three `profile_*` keys so `upsertSetting` writes the global `dashboard_settings` row and emits to peers (D1); clear stranded broken-era overrides on save (D2); a one-shot flag-guarded boot heal promotes non-empty stranded overrides to global (D3); bump the settings re-emit flag v1→v2 with an empty-profile-value skip so pre-existing global rows reconcile once (D4). Readers stay global-direct (D6). No handshake-ack dedupe (D5). Spec (2-round adversarially reviewed): `docs/superpowers/specs/2026-07-10-profile-follows-user-design.md`.

**Tech Stack:** Node ESM, better-sqlite3 via libsql-style client (`db.execute`), node:test.

## Global Constraints

- **No SCHEMA_GENERATION bump** — this PR is code-only; no DDL anywhere.
- **NEVER `git commit --amend`** (shared tree, parallel sessions). Commit with **positional paths only** (`git commit <paths> -m ...`; `git add <path>` first for NEW files). Verify with `git show --stat HEAD` after every commit.
- The working tree carries unrelated WIP (`scripts/bench/**`, many untracked dirs) from a parallel session — never `git add -A`/`git add .`.
- Branch: `fix/messages-cluster-b-profile-follows-user`. Suite baseline: **1376 pass / 0 fail / 1 skip** (`node --test tests/*.test.js`).
- The heal flag row is written via **raw SQL** into `dashboard_settings`, never `upsertSetting` (spec R2 MINOR-B).
- Heal ordering is crash-safety-critical: **promote before delete** (spec R2 MINOR-C).
- Heal gate: **`feedsDisabled === true` → full no-op** (no promotion, no flag write) (spec R2 MAJOR-A).
- Tests must not leak module state: always reset `setSettingsSyncManager(null)` and restore `process.env.CROW_DATA_DIR` in `finally`.

---

### Task 1: Sync-allowlist the profile keys + `PROFILE_SYNC_KEYS` + `writeSetting` docblock fix

**Files:**
- Modify: `servers/gateway/dashboard/settings/sync-allowlist.js`
- Modify: `servers/gateway/dashboard/settings/registry.js` (docblock only, ~line 177-187)
- Test: `tests/profile-sync-allowlist.test.js` (new)

**Interfaces:**
- Produces: `export const PROFILE_SYNC_KEYS = ["profile_display_name", "profile_avatar_url", "profile_bio"]` from `sync-allowlist.js` — consumed by Tasks 2, 3, 4.
- Produces: `isSyncable("profile_display_name") === true` (and the other two) — Tasks 3/4 depend on it.

- [ ] **Step 1: Write the failing test**

Create `tests/profile-sync-allowlist.test.js`:

```js
/**
 * Cluster B (F-SETTINGS-1/F-CONTACT-5) — the three profile keys are
 * sync-allowlisted so upsertSetting writes the GLOBAL scope and emits to
 * peers, instead of silently downgrading to a local override no reader sees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { isSyncable, PROFILE_SYNC_KEYS } from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import { upsertSetting, setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "profile-allowlist-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("profile keys are sync-allowlisted (F-SETTINGS-1 root fix)", () => {
  for (const k of ["profile_display_name", "profile_avatar_url", "profile_bio"]) {
    assert.equal(isSyncable(k), true, `${k} must be syncable`);
  }
  assert.deepEqual(PROFILE_SYNC_KEYS, ["profile_display_name", "profile_avatar_url", "profile_bio"]);
});

test("explicit-entry posture: an unrelated profile_ key is NOT syncable", () => {
  assert.equal(isSyncable("profile_zzz"), false);
});

test("upsertSetting on a profile key writes the GLOBAL row (no override) and emits", async () => {
  const { dir, db, cleanup } = freshDb();
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const emitted = [];
  setSettingsSyncManager({ emitChange: async (t, op, row) => { emitted.push({ t, op, row }); } });
  try {
    await upsertSetting(db, "profile_display_name", "Kevin");
    const g = await db.execute("SELECT value FROM dashboard_settings WHERE key = 'profile_display_name'");
    assert.equal(g.rows[0]?.value, "Kevin", "global row written");
    const o = await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key = 'profile_display_name'");
    assert.equal(Number(o.rows[0].c), 0, "no local-override downgrade");
    assert.ok(
      emitted.some((e) => e.t === "dashboard_settings" && e.op === "update" && e.row.key === "profile_display_name" && e.row.instance_id === null),
      "sync emit fired with instance_id null"
    );
  } finally {
    setSettingsSyncManager(null);
    if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevDataDir;
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/profile-sync-allowlist.test.js`
Expected: FAIL — `PROFILE_SYNC_KEYS` is not exported (SyntaxError on import) / `isSyncable` returns false.

- [ ] **Step 3: Implement**

In `servers/gateway/dashboard/settings/sync-allowlist.js`, add to `SYNC_ALLOWLIST` (after `unified_dashboard_enabled`):

```js
  // Cluster B (F-SETTINGS-1/F-CONTACT-5): own-profile identity is user-level
  // data — it follows the user across instances like contacts/groups do.
  // SECURITY NOTE: the sync-apply path (_applyDashboardSetting) writes peer
  // values RAW. The defense is (a) every dashboard render of profile values is
  // escapeHtml'd and (b) both handshake readers re-sanitize via
  // sanitizeDisplayName at READ time. Any future reader of profile_* must
  // follow the same rule.
  profile_display_name:      "Own profile — display name (sent in pairing handshakes)",
  profile_avatar_url:        "Own profile — avatar URL",
  profile_bio:               "Own profile — bio",
```

And export (near the bottom, after `checkSyncKeyDrift`):

```js
/**
 * The three own-profile keys (explicit list, deliberately NOT a "profile_*"
 * allowlist prefix — a future profile_ key must be consciously added).
 * Consumed by the save-path override clear, the one-shot heal, and the
 * re-emit empty-value guard.
 */
export const PROFILE_SYNC_KEYS = ["profile_display_name", "profile_avatar_url", "profile_bio"];
```

In `servers/gateway/dashboard/settings/registry.js`, fix the `writeSetting` docblock lie (R1): replace

```js
 *   - "global" → dashboard_settings row (synced if key in SYNC_ALLOWLIST).
 *     Also clears any local override for this instance so the global row is effective.
```

with

```js
 *   - "global" → dashboard_settings row (synced if key in SYNC_ALLOWLIST).
 *     Does NOT clear a local override — an existing override for this instance
 *     keeps winning readSetting until deleteLocalSetting is called (the scope
 *     route does that explicitly; see routes/settings-scope.js).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/profile-sync-allowlist.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add tests/profile-sync-allowlist.test.js
git commit tests/profile-sync-allowlist.test.js servers/gateway/dashboard/settings/sync-allowlist.js servers/gateway/dashboard/settings/registry.js -m "feat(settings): sync-allowlist the profile keys (F-SETTINGS-1/F-CONTACT-5 root fix) + correct writeSetting docblock"
git show --stat HEAD
```

---

### Task 2: `save_profile` clears stranded overrides + D6 read-site comments

**Files:**
- Modify: `servers/gateway/dashboard/panels/contacts/api-handlers.js:352-368` (save_profile block; add `deleteLocalSetting` import at the top, next to the existing `upsertSetting` import from `../../settings/registry.js`)
- Modify: `servers/gateway/dashboard/panels/contacts/data-queries.js:121-124` (comment), `servers/sharing/boot.js:30-34` (comment), `servers/sharing/tools/contacts.js:65-69` (comment)
- Test: `tests/profile-save-clears-override.test.js` (new)

**Interfaces:**
- Consumes: `handleContactAction(req, db, opts)` (existing export), `deleteLocalSetting(db, key)` (registry.js:227), `getMyProfile(db)` (data-queries.js:124), `getOrCreateLocalInstanceId()` (instance-registry.js:333, respects `CROW_DATA_DIR` at call time).
- Produces: nothing new for later tasks (behavioral change only).

- [ ] **Step 1: Write the failing test**

Create `tests/profile-save-clears-override.test.js`:

```js
/**
 * Cluster B D2 — a profile save writes the global row AND clears the stranded
 * broken-era local override, and the profile page reader (getMyProfile) sees
 * the saved value on the very next read (the F-SETTINGS-1 symptom).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { getMyProfile } from "../servers/gateway/dashboard/panels/contacts/data-queries.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "profile-save-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("save_profile writes global, clears the stranded override, and getMyProfile sees it", async () => {
  const { dir, db, cleanup } = freshDb();
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  setSettingsSyncManager(null); // emits are not this test's subject
  try {
    const localId = getOrCreateLocalInstanceId();
    // Seed the broken-era state: value stranded in the override, global empty.
    await db.execute({
      sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES ('profile_display_name', ?, 'Stranded', datetime('now'))",
      args: [localId],
    });

    const req = { body: { action: "save_profile", display_name: "Kevin", bio: "Hello" } };
    const out = await handleContactAction(req, db, {});
    assert.ok(out && out.redirect, "save redirects");

    const g = await db.execute("SELECT key, value FROM dashboard_settings WHERE key IN ('profile_display_name','profile_bio')");
    const byKey = Object.fromEntries(g.rows.map((r) => [r.key, r.value]));
    assert.equal(byKey.profile_display_name, "Kevin", "global name row written");
    assert.equal(byKey.profile_bio, "Hello", "global bio row written");

    const o = await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key LIKE 'profile_%'");
    assert.equal(Number(o.rows[0].c), 0, "stranded override cleared (D2)");

    const profile = await getMyProfile(db);
    assert.equal(profile.display_name, "Kevin", "the profile page reader sees the save immediately");
    assert.equal(profile.bio, "Hello");
  } finally {
    setSettingsSyncManager(null);
    if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevDataDir;
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/profile-save-clears-override.test.js`
Expected: FAIL on "stranded override cleared (D2)" — count is 1 (Task 1 already makes the global write land; the override clear does not exist yet).

- [ ] **Step 3: Implement**

In `servers/gateway/dashboard/panels/contacts/api-handlers.js`:

Change the import (line 9) from
```js
import { upsertSetting } from "../../settings/registry.js";
```
to
```js
import { upsertSetting, deleteLocalSetting } from "../../settings/registry.js";
```

Rewrite the `save_profile` block (keep the existing D5 comment; add the clears):

```js
  // --- Own profile ---
  if (action === "save_profile") {
    // F-SETTINGS-1 (Cluster B D2): each save also clears any stranded
    // broken-era local override — during the era when these keys were not
    // sync-allowlisted, upsertSetting silently downgraded profile saves to
    // dashboard_settings_overrides rows that no reader consults. The global
    // row (which readers use and peers sync) must be effective from this save.
    if (req.body.display_name !== undefined) {
      // This value is SENT on every handshake and syncs to all of the user's
      // instances — cap + strip it at write (design §D5). sanitizeDisplayName
      // returns null when nothing survives; store "" rather than the literal
      // "null" so the setting is cleared, not poisoned.
      await upsertSetting(db, "profile_display_name", sanitizeDisplayName(req.body.display_name) ?? "");
      await deleteLocalSetting(db, "profile_display_name");
    }
    if (req.body.avatar_url !== undefined) {
      await upsertSetting(db, "profile_avatar_url", req.body.avatar_url.trim());
      await deleteLocalSetting(db, "profile_avatar_url");
    }
    if (req.body.bio !== undefined) {
      await upsertSetting(db, "profile_bio", req.body.bio.trim());
      await deleteLocalSetting(db, "profile_bio");
    }
    return { redirect: "/dashboard/contacts?view=profile" };
  }
```

Add the D6 comment at each of the three read sites (adapt the first line to local context; the substance must be identical):

`servers/gateway/dashboard/panels/contacts/data-queries.js`, above the `SELECT` in `getMyProfile` (line ~128):
```js
  // Reads the GLOBAL scope on purpose (Cluster B design D6): profile identity
  // is user-level and follows the user across instances. Per-instance
  // overrides of profile_* keys are intentionally inert — do not "fix" this
  // to readSetting, and do not wire a scope toggle for these keys (the scope
  // route would report "local" while behavior stays global).
```

`servers/sharing/boot.js`, inside the `readLocalDisplayName` docblock (after line 33's "Never throws."):
```js
 * Reads the GLOBAL scope on purpose (Cluster B design D6): profile identity is
 * user-level; per-instance overrides of profile_* keys are intentionally inert.
```

`servers/sharing/tools/contacts.js`, extend the F-CONTACT-2 comment (line ~65-69) with:
```js
    // Reads the GLOBAL scope on purpose (Cluster B design D6): profile identity
    // is user-level; per-instance overrides of profile_* keys are intentionally inert.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/profile-save-clears-override.test.js tests/profile-sync-allowlist.test.js tests/handshake-display-name.test.js`
Expected: ALL PASS (the pre-existing handshake test proves the boot.js/tools readers still work; post-Task-1 they now read what the UI writes).

- [ ] **Step 5: Commit**

```bash
git add tests/profile-save-clears-override.test.js
git commit tests/profile-save-clears-override.test.js servers/gateway/dashboard/panels/contacts/api-handlers.js servers/gateway/dashboard/panels/contacts/data-queries.js servers/sharing/boot.js servers/sharing/tools/contacts.js -m "fix(contacts): profile save clears stranded broken-era overrides; pin global-direct reader semantics (D2+D6)"
git show --stat HEAD
```

---

### Task 3: Re-emit flag v1→v2 + empty-profile-value skip

**Files:**
- Modify: `servers/sharing/instance-sync.js` (`reemitSyncableSettingsOnce`, ~lines 470-533)
- Test: `tests/settings-reemit-v2.test.js` (new)

**Interfaces:**
- Consumes: `PROFILE_SYNC_KEYS` from `servers/gateway/dashboard/settings/sync-allowlist.js` (Task 1). NOTE: instance-sync.js already imports `isSyncable` from that exact module (line 22) — extend that import.
- Produces: `reemitSyncableSettingsOnce()` now keyed on flag `__sync_reemit_allowlist_v2`.

- [ ] **Step 1: Write the failing test**

Create `tests/settings-reemit-v2.test.js` (harness mirrors `tests/messages-contacts-backfill.test.js`):

```js
/**
 * Cluster B D4 — reemitSyncableSettingsOnce keyed on the v2 flag: a fleet
 * instance whose v1 flag is 'done:' re-runs ONCE so pre-existing global rows
 * for the newly-allowlisted profile keys reconcile; empty profile values are
 * never re-emitted (they could win the lamport race and blank a peer's real
 * value — R1 MAJOR-2).
 */
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

function freshMgr(label, id) {
  const d = mkdtempSync(join(tmpdir(), `crow-b-reemit-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  after(() => rmSync(d, { recursive: true, force: true }));
  const m = new InstanceSyncManager(IDENTITY, createDbClient(join(d, "crow.db")), id);
  m.feedsDisabled = false;
  m.outFeeds.set("peer-1", { append: async () => {} });
  return m;
}

test("v2 flag: re-runs once even when the v1 flag is done:, then no-ops (v1 orphan ignored)", async () => {
  const m = freshMgr("v2", "local-1"); const db = m.db;
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('__sync_reemit_allowlist_v1', 'done:9', datetime('now'))");
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Kevin Hopper', datetime('now'))");
  const emitted = [];
  const orig = m.emitChange.bind(m);
  m.emitChange = async (t, o, r) => { emitted.push(r.key); return orig(t, o, r); };

  const n1 = await m.reemitSyncableSettingsOnce();
  assert.ok(n1 >= 1, "re-ran despite done: v1 flag");
  assert.ok(emitted.includes("profile_display_name"), "newly-allowlisted profile row re-emitted");
  const flag = await db.execute("SELECT value FROM dashboard_settings WHERE key = '__sync_reemit_allowlist_v2'");
  assert.match(String(flag.rows[0]?.value), /^done:/, "v2 flag marked done");

  emitted.length = 0;
  const n2 = await m.reemitSyncableSettingsOnce();
  assert.equal(n2, 0, "second run is a no-op");
  assert.equal(emitted.length, 0);
});

test("apply side: a peer's profile_display_name entry is applied; a non-allowlisted key is dropped (spec test 7)", async () => {
  const m = freshMgr("apply", "local-3"); const db = m.db;
  const { sign } = await import("../servers/sharing/identity.js");
  function signedEntry(table, op, row, lamport_ts) {
    const entry = { table, op, row, lamport_ts, instance_id: "peer-1" };
    entry.signature = sign(JSON.stringify(entry), TEST_PRIV);
    return entry;
  }
  const fakeFeedWith = (entries) => ({ length: entries.length, async get(seq) { return entries[seq]; } });
  // trustedKeys: _verifyEntry resolves the peer's ed25519 key — mirror the
  // backfill test's approach of trusting our own test key for "peer-1".
  m.trustedPeerKeys = m.trustedPeerKeys || new Map();
  const entries = [
    signedEntry("dashboard_settings", "update", { key: "profile_display_name", value: "Peer Name", instance_id: null }, 500),
    signedEntry("dashboard_settings", "update", { key: "not_allowlisted_key", value: "evil", instance_id: null }, 501),
  ];
  await m._processNewEntriesInner("peer-1", fakeFeedWith(entries), TEST_PUB_HEX);
  const g = await db.execute("SELECT value FROM dashboard_settings WHERE key = 'profile_display_name'");
  assert.equal(g.rows[0]?.value, "Peer Name", "allowlisted profile row applied from a peer");
  const bad = await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings WHERE key = 'not_allowlisted_key'");
  assert.equal(Number(bad.rows[0].c), 0, "non-allowlisted key dropped by the apply-side gate");
});
// IMPLEMENTER NOTE: mirror tests/messages-contacts-backfill.test.js for the exact
// _processNewEntriesInner invocation/signature-verification setup — if that file
// passes a different peer-key wiring (e.g. a peers-table row or a keys argument),
// copy ITS working pattern rather than the sketch above; the assertion pair
// (applied vs dropped) is the requirement.

test("empty-profile guard: empty/whitespace profile values are NOT re-emitted; non-profile empties still are", async () => {
  const m = freshMgr("empty", "local-2"); const db = m.db;
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_bio', '', datetime('now'))");
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_avatar_url', '  ', datetime('now'))");
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Kevin', datetime('now'))");
  // Pins the DELIBERATE scoping: the guard is profile-only (an empty value for
  // another allowlisted key is meaningful and still reconciles).
  await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('nav_groups', '', datetime('now'))");
  const emitted = [];
  m.emitChange = async (_t, _o, r) => { emitted.push(r.key); };

  await m.reemitSyncableSettingsOnce();
  assert.ok(!emitted.includes("profile_bio"), "empty bio NOT re-emitted (fleet-blanking hazard)");
  assert.ok(!emitted.includes("profile_avatar_url"), "whitespace avatar NOT re-emitted");
  assert.ok(emitted.includes("profile_display_name"), "non-empty profile value re-emitted");
  assert.ok(emitted.includes("nav_groups"), "guard is scoped to profile keys only");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/settings-reemit-v2.test.js`
Expected: FAIL — test 1: `n1` is 0 (the code still reads the v1 flag, which is `done:9`); test 2: `profile_bio` IS emitted.

- [ ] **Step 3: Implement**

In `servers/sharing/instance-sync.js`:

Extend the existing import at line 22:
```js
import { isSyncable, PROFILE_SYNC_KEYS } from "../gateway/dashboard/settings/sync-allowlist.js";
```

In `reemitSyncableSettingsOnce()`, change the flag constant (~line 471) with a why-comment:
```js
    // v1 → v2 (Cluster B, 2026-07-10): the profile keys were added to the
    // allowlist and every fleet instance's v1 flag is already done: — without a
    // re-run, pre-existing global profile rows (written before the settings-
    // scope refactor) would never replicate until the next manual save. The v1
    // flag row remains as a harmless orphan.
    const FLAG_KEY = "__sync_reemit_allowlist_v2";
```

In the emit loop (~line 505), after the `if (!isSyncable(row.key)) continue;` line, add:
```js
      // R1 MAJOR-2 (Cluster B): never re-emit an EMPTY profile value — a
      // historical empty row (indistinguishable from "never set") would get a
      // fresh lamport and could win LWW, blanking a peer's real value. A LIVE
      // save of "" still emits via writeSetting (a deliberate clear propagates);
      // this guard is scoped to the re-emit reconciliation only.
      if (PROFILE_SYNC_KEYS.includes(row.key) && (typeof row.value !== "string" || row.value.trim() === "")) continue;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/settings-reemit-v2.test.js`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add tests/settings-reemit-v2.test.js
git commit tests/settings-reemit-v2.test.js servers/sharing/instance-sync.js -m "feat(instance-sync): settings re-emit flag v2 + empty-profile-value guard (D4; R1 MAJOR-2)"
git show --stat HEAD
```

---

### Task 4: One-shot profile-override heal + boot wiring order

**Files:**
- Create: `servers/gateway/dashboard/settings/profile-heal.js`
- Modify: `servers/gateway/boot/mcp-mounts.js` (move the `setSettingsSyncManager` block above the one-shots; insert the heal call)
- Test: `tests/profile-heal.test.js` (new)

**Interfaces:**
- Consumes: `writeSetting`, `deleteLocalSetting` (registry.js), `PROFILE_SYNC_KEYS` (Task 1), `getOrCreateLocalInstanceId` (instance-registry.js).
- Produces: `export async function healProfileOverridesOnce(db, { feedsDisabled = false } = {})` → returns the number of promoted keys. Called from `mcp-mounts.js` with `syncManager.db` and `syncManager.feedsDisabled`.

- [ ] **Step 1: Write the failing test**

Create `tests/profile-heal.test.js`:

```js
/**
 * Cluster B D3 — one-shot heal: values stranded in dashboard_settings_overrides
 * by the broken-era save_profile are promoted (non-empty only) to the global
 * scope once, flag-guarded, gated OFF for --no-auth companions (feedsDisabled).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { healProfileOverridesOnce } from "../servers/gateway/dashboard/settings/profile-heal.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "profile-heal-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function seedOverride(db, localId, key, value) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, ?, datetime('now'))",
    args: [key, localId, value],
  });
}
const globalValue = async (db, key) => (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;
const overrideCount = async (db) => Number((await db.execute("SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key LIKE 'profile_%'")).rows[0].c);

test("heal: promotes non-empty stranded overrides (override wins over global), deletes empties, one-shot flag, emits", async () => {
  const { dir, db, cleanup } = fresh();
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const emitted = [];
  setSettingsSyncManager({ emitChange: async (t, op, row) => { emitted.push(row.key); } });
  try {
    const localId = getOrCreateLocalInstanceId();
    await seedOverride(db, localId, "profile_display_name", "Kevin");   // (a)+(c): promote, wins over global
    await seedOverride(db, localId, "profile_bio", "");                 // (f): empty → delete only
    await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_display_name', 'Old Global', datetime('now'))");
    await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('profile_bio', 'Real Bio', datetime('now'))");

    const n = await healProfileOverridesOnce(db, { feedsDisabled: false });
    assert.equal(n, 1, "exactly the one non-empty override promoted");
    assert.equal(await globalValue(db, "profile_display_name"), "Kevin", "(c) override value wins over pre-existing global");
    assert.equal(await globalValue(db, "profile_bio"), "Real Bio", "(f) empty override did NOT blank the real global value");
    assert.equal(await overrideCount(db), 0, "all profile overrides cleared (incl. the empty one)");
    assert.ok(emitted.includes("profile_display_name"), "(e) promotion emitted (manager wired)");
    const flag = await db.execute("SELECT value FROM dashboard_settings WHERE key = '__profile_override_heal_v1'");
    assert.match(String(flag.rows[0]?.value), /^done:1$/, "flag row written to dashboard_settings via raw SQL");

    // (b) second run is a flag-guarded no-op even with a fresh override present
    await seedOverride(db, localId, "profile_display_name", "Deliberate Local");
    emitted.length = 0;
    const n2 = await healProfileOverridesOnce(db, { feedsDisabled: false });
    assert.equal(n2, 0, "(b) flag-guarded second run no-ops");
    assert.equal(await globalValue(db, "profile_display_name"), "Kevin", "deliberate post-heal override untouched");
    assert.equal(emitted.length, 0);
  } finally {
    setSettingsSyncManager(null);
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    cleanup();
  }
});

test("heal: no overrides → flag still set, nothing written (d); feedsDisabled → FULL no-op, no flag (5d)", async () => {
  const { dir, db, cleanup } = fresh();
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  setSettingsSyncManager(null);
  try {
    // 5d: companion gateway (feedsDisabled) must not run NOR mark the flag —
    // it shares the primary's DB and would make the primary skip its own heal.
    const gated = await healProfileOverridesOnce(db, { feedsDisabled: true });
    assert.equal(gated, 0);
    let flag = await db.execute("SELECT value FROM dashboard_settings WHERE key = '__profile_override_heal_v1'");
    assert.equal(flag.rows.length, 0, "feedsDisabled run left NO flag row");

    // (d): a clean primary marks the flag with zero promotions
    const n = await healProfileOverridesOnce(db, { feedsDisabled: false });
    assert.equal(n, 0);
    flag = await db.execute("SELECT value FROM dashboard_settings WHERE key = '__profile_override_heal_v1'");
    assert.match(String(flag.rows[0]?.value), /^done:0$/);
  } finally {
    setSettingsSyncManager(null);
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    cleanup();
  }
});

test("boot wiring order pin: setSettingsSyncManager is wired BEFORE the heal, which runs BEFORE the re-emit", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/boot/mcp-mounts.js"), "utf8");
  const wireIdx = src.indexOf("setSettingsSyncManager(syncManager)");
  const healIdx = src.indexOf("healProfileOverridesOnce");
  const reemitIdx = src.indexOf("reemitSyncableSettingsOnce");
  assert.ok(wireIdx > -1 && healIdx > -1 && reemitIdx > -1, "all three call sites present");
  assert.ok(wireIdx < healIdx, "R1 MAJOR-1: manager wired before the heal (else the heal's emit hits a null manager)");
  assert.ok(healIdx < reemitIdx, "heal before re-emit so a promoted value rides the same boot's re-emit");
  assert.match(src, /feedsDisabled/, "heal call site carries the feedsDisabled gate");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/profile-heal.test.js`
Expected: FAIL — cannot import `profile-heal.js` (module does not exist).

- [ ] **Step 3: Implement the heal module**

Create `servers/gateway/dashboard/settings/profile-heal.js`:

```js
/**
 * profile-heal.js — Cluster B D3: one-shot heal for F-SETTINGS-1's stranded
 * profile values.
 *
 * During the settings-scope era in which the profile keys were not
 * sync-allowlisted, every UI profile save was silently downgraded to a
 * dashboard_settings_overrides row that NO reader consults (all profile
 * readers are global-direct by design, D6). Users' typed values are stranded
 * there. This promotes them to the global scope once, so the name a user
 * saved into the "broken" UI comes back — and starts syncing — at upgrade,
 * with no re-save.
 *
 * Rules (spec §D3):
 *  - non-empty override → promote to global (writeSetting, which emits to
 *    peers when the sync manager is wired) THEN delete the override. Promote
 *    strictly BEFORE delete: reversed, a crash between the two loses the
 *    value forever (override gone, global never written, flag prevents retry).
 *    Promote-first re-runs are idempotent.
 *  - empty/whitespace override → delete only. Promoting "" could blank a
 *    peer's real pre-refactor global value fleet-wide.
 *  - flag row __profile_override_heal_v1 is RAW SQL into dashboard_settings
 *    (NOT upsertSetting — a non-allowlisted flag key would silently downgrade
 *    to an overrides row and never read back as done → heal re-runs forever).
 *  - feedsDisabled=true (a --no-auth companion sharing the primary's DB) is a
 *    FULL no-op — no promotion, no flag write — or the companion would mark
 *    the flag and the primary would skip its own heal (R2 MAJOR-A). Gate on
 *    feedsDisabled, NOT manager truthiness (the manager is constructed
 *    unconditionally) and NOT outFeeds.size (a peerless single-instance
 *    install still needs the local half of the heal).
 */
import { writeSetting, deleteLocalSetting } from "./registry.js";
import { PROFILE_SYNC_KEYS } from "./sync-allowlist.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";

const FLAG_KEY = "__profile_override_heal_v1";

export async function healProfileOverridesOnce(db, { feedsDisabled = false } = {}) {
  if (feedsDisabled) return 0;

  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = ?",
      args: [FLAG_KEY],
    });
    if (typeof rows?.[0]?.value === "string" && rows[0].value.startsWith("done:")) return 0;
  } catch {
    return 0; // unreadable flag → do nothing rather than risk a re-run loop
  }

  const localId = getOrCreateLocalInstanceId();
  let promoted = 0;
  for (const key of PROFILE_SYNC_KEYS) {
    try {
      const { rows } = await db.execute({
        sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
        args: [key, localId],
      });
      if (rows.length === 0) continue;
      const value = rows[0].value;
      if (typeof value === "string" && value.trim() !== "") {
        await writeSetting(db, key, value, { scope: "global" });
        promoted++;
      }
      await deleteLocalSetting(db, key);
    } catch (err) {
      console.warn(`[settings] profile heal for ${key} failed: ${err.message}`);
    }
  }

  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [FLAG_KEY, `done:${promoted}`],
    });
  } catch {}

  if (promoted > 0) {
    console.log(`[settings] profile heal: promoted ${promoted} stranded profile value(s) to the global scope`);
  }
  return promoted;
}
```

- [ ] **Step 4: Rewire boot order in `mcp-mounts.js`**

DELETE the existing block at lines 102-107:
```js
  // Scoped-settings sync: wire the registry's writeSetting to emitChange so
  // operator edits on one instance propagate to paired peers.
  try {
    const { setSettingsSyncManager } = await import("../dashboard/settings/registry.js");
    setSettingsSyncManager(syncManager);
  } catch {}
```

INSERT in its place order — directly AFTER the `eagerInitPairedPeers` try-block (line 66) and BEFORE the `reemitSyncableSettingsOnce` block (line 68):
```js
  // Scoped-settings sync: wire the registry's writeSetting to emitChange so
  // operator edits on one instance propagate to paired peers. MUST happen
  // BEFORE the heal/re-emit one-shots below (R1 MAJOR-1): the heal promotes
  // via writeSetting, whose emit is a silent no-op — and whose promoted row
  // never gets a lamport stamp — while the manager is unwired.
  try {
    const { setSettingsSyncManager } = await import("../dashboard/settings/registry.js");
    setSettingsSyncManager(syncManager);
  } catch {}

  // Cluster B D3: one-shot heal — promote profile values stranded in
  // dashboard_settings_overrides by the broken-era save_profile. Gated on
  // !feedsDisabled: a --no-auth companion shares the primary's DB and must
  // not run it or mark its flag (R2 MAJOR-A). Runs BEFORE the settings
  // re-emit so a promoted value also rides this boot's reconciliation.
  try {
    if (syncManager && !syncManager.feedsDisabled) {
      const { healProfileOverridesOnce } = await import("../dashboard/settings/profile-heal.js");
      await healProfileOverridesOnce(syncManager.db, { feedsDisabled: syncManager.feedsDisabled });
    }
  } catch (err) {
    console.warn(`[settings] healProfileOverridesOnce failed: ${err.message}`);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/profile-heal.test.js`
Expected: PASS (3/3, including the source-order pin).

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/settings/profile-heal.js tests/profile-heal.test.js
git commit servers/gateway/dashboard/settings/profile-heal.js tests/profile-heal.test.js servers/gateway/boot/mcp-mounts.js -m "feat(settings): one-shot heal for stranded broken-era profile overrides + wire settings sync manager before the boot one-shots (D3; R1 MAJOR-1, R2 MAJOR-A)"
git show --stat HEAD
```

---

### Task 5: Full suite, boot check, mutation-test evidence

**Files:**
- No new files (evidence recorded in `.superpowers/sdd/progress.md` — git-IGNORED, never `git add`).

- [ ] **Step 1: Full suite**

Run: `node --test tests/*.test.js 2>&1 | tail -5`
Expected: ≥ 1376+new pass / 0 fail / 1 skip. Any failure → fix before proceeding (bisect against the four commits above).

- [ ] **Step 2: Boot check**

Run: `timeout 25 node servers/gateway/index.js --no-auth` (Ctrl-C/timeout after "listening")
Expected: boots clean; NO `[settings] profile heal` promotion line (feedsDisabled gate — a `--no-auth` boot must not heal), no new warnings.

- [ ] **Step 3: Mutation-test every guard** (apply each mutation, run the named test, verify RED, revert):

| # | Mutation | Test that must go RED |
|---|---|---|
| M1 | profile-heal.js: delete the `startsWith("done:")` flag check | profile-heal.test.js "(b) flag-guarded second run no-ops" |
| M2 | profile-heal.js: drop the `value.trim() !== ""` guard (always promote) | profile-heal.test.js "(f) empty override did NOT blank the real global value" |
| M3 | profile-heal.js: change `if (feedsDisabled) return 0;` to `if (false)` | profile-heal.test.js "feedsDisabled run left NO flag row" |
| M4 | instance-sync.js: revert `FLAG_KEY` to `__sync_reemit_allowlist_v1` | settings-reemit-v2.test.js "re-ran despite done: v1 flag" |
| M5 | instance-sync.js: delete the empty-profile `continue` guard | settings-reemit-v2.test.js "empty bio NOT re-emitted" |
| M6 | mcp-mounts.js: move the `setSettingsSyncManager` block back below the one-shots | profile-heal.test.js "boot wiring order pin" |

Expected: each mutation reddens exactly the named assertion; reverting restores green. Record the six results in the progress ledger.

- [ ] **Step 4: Update the progress ledger** (`.superpowers/sdd/progress.md` — append Task summaries + mutation evidence; never `git add` this file).

---

## Post-implementation (controller, not subagents)

1. CDP browser verification on a scratch pair (Task tracker #3): real-browser profile save → page re-renders the saved name (F-SETTINGS-1 symptom), global row written, override cleared. Recipes: `~/.crow/p4/cluster-a-evidence/` (distinct host IPs 10.0.0.237 vs 100.118.41.122; `CROW_AUTO_UPDATE=0`; `CROW_DISABLE_HEALTH_MONITOR=1`; real passwords/sessions).
2. Final whole-branch Opus review → fold → PR → check-runs (curl; port-allocation.yml is path-filtered → total_count 0 is normal; run `node scripts/check-port-allocation.js` locally, ignore the untracked capstone-tracker 8090 flag from another session).
3. Kevin gates the merge. Then deploy crow+MPA+grackle **together** (old-code peers drop profile rows AND advance their checkpoint — spec §D4), then black-swan; expect the one-time `storage.shared.*` `_scheduleStorageReset` blip at first boot.
4. Prod reconciliation: CDP product-path save `display_name='Kevin'` on crow → verify fleet convergence (~3s), grackle's March bio propagated, crow's stale override gone, per-instance `SELECT value FROM dashboard_settings WHERE key='profile_display_name'` all return 'Kevin'.
