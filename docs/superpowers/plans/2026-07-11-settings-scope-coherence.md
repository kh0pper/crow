# Settings-Scope Coherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 12+ per-instance settings keys (auto_update_*, notification_prefs, discovery_*, blog_*, language, onboarding_completed_at, tts_voice) actually take effect when saved from the UI, by routing their writes to the global `dashboard_settings` table their readers already query — plus a one-shot heal for stranded broken-era values, a scope-route guard, the vision_profiles reader fix, two vestigial-write deletions, and an auto-update tick gate so disable works without a restart.

**Architecture:** Spec `docs/superpowers/specs/2026-07-11-settings-scope-coherence-design.md` (2-round adversarially reviewed: R1 REVISE folded, R2 APPROVE). Approach A: a curated `INSTANCE_SCOPE_KEYS` list beside `SYNC_ALLOWLIST`; `writeSetting` routes those keys to the global table WITHOUT sync emission (replication stays gated by `isSyncable` at emit instance-sync.js:207-211 and apply :936 — a global row for a non-allowlisted key never leaves the box). Readers stay untouched. A flag-guarded one-shot boot heal (`__instance_scope_heal_v1`) promotes stranded overrides newest-updated_at-wins and deletes them.

**Tech Stack:** Node ESM, node:test, @libsql/client, better-sqlite-compatible raw SQL. No new deps. NO schema change — SCHEMA_GENERATION stays 6.

## Global Constraints

- Branch: `fix/settings-scope-coherence`, base = current origin/main (≥ 09d9b526). `git pull --ff-only origin main` before branching.
- **Commit style: `git add <explicit paths>` then `git commit <explicit paths> -m "..."`** — NEVER bare `git commit -a`, NEVER `git add -A` (parallel sessions keep unrelated WIP in this tree), NEVER `git commit --amend`. After every commit run `git show --stat HEAD` and confirm ONLY your files are in it.
- Tests: `node --test tests/<file>.test.js`. Full suite: `node --test tests/`.
- The tree may contain foreign untracked dirs (bundles/capstone-tracker etc.) and modified scripts/bench/** — they are another session's; do not touch, stage, or clean them.
- `feature_flags`, `kiosk_mode`, and every key NOT in INSTANCE_SCOPE_KEYS keep the exact current downgrade-to-local behavior.
- The heal flag row is written by RAW SQL only (an upsertSetting'd flag key would be misfiled).
- No key is added to SYNC_ALLOWLIST in this PR.

---

### Task 1: INSTANCE_SCOPE_KEYS + writeSetting three-way routing (spec D1)

**Files:**
- Modify: `servers/gateway/dashboard/settings/sync-allowlist.js` (append after `PROFILE_SYNC_KEYS`, line ~103)
- Modify: `servers/gateway/dashboard/settings/registry.js` (imports line 121; `writeSetting` lines 190-224; docblock lines 176-189; re-export line 256)
- Test: `tests/instance-scope-keys.test.js` (new)

**Interfaces:**
- Produces: `INSTANCE_SCOPE_KEYS` (object) and `isInstanceScope(key) → boolean` exported from sync-allowlist.js; `writeSetting` now writes instance-scope keys to the global `dashboard_settings` table without emitting; `isInstanceScope` re-exported from registry.js. Tasks 2-6 rely on exactly these names.

- [ ] **Step 1: Write the failing test**

Create `tests/instance-scope-keys.test.js`:

```js
/**
 * Settings-scope coherence D1 — INSTANCE_SCOPE_KEYS routing.
 * Instance-scope keys are per-install: they live in the global
 * dashboard_settings table (their readers are global-direct) and NEVER sync.
 * Everything else keeps the legacy downgrade-to-local behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  SYNC_ALLOWLIST,
  INSTANCE_SCOPE_KEYS,
  isSyncable,
  isInstanceScope,
} from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import {
  writeSetting,
  upsertSetting,
  setSettingsSyncManager,
} from "../servers/gateway/dashboard/settings/registry.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "instance-scope-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const globalValue = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;
const overrideRows = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ?", args: [key] })).rows;

test("isInstanceScope: explicit keys, blog_* prefix, and negatives", () => {
  for (const k of [
    "auto_update_enabled", "auto_update_interval_hours", "notification_prefs",
    "discovery_enabled", "discovery_name", "onboarding_completed_at",
    "language", "tts_voice", "blog_title", "blog_podcast_language", "blog_theme_mode",
  ]) assert.equal(isInstanceScope(k), true, k);
  for (const k of ["feature_flags", "profile_display_name", "blog", "kiosk_mode", "ai_profiles", "", null]) {
    assert.equal(isInstanceScope(k), false, String(k));
  }
});

test("zero overlap between SYNC_ALLOWLIST and INSTANCE_SCOPE_KEYS (pattern-aware both directions)", () => {
  const overlaps = (a, b) => {
    const aPre = a.endsWith("*") ? a.slice(0, -1) : null;
    const bPre = b.endsWith("*") ? b.slice(0, -1) : null;
    if (aPre !== null && bPre !== null) return aPre.startsWith(bPre) || bPre.startsWith(aPre);
    if (aPre !== null) return b.startsWith(aPre);
    if (bPre !== null) return a.startsWith(bPre);
    return a === b;
  };
  for (const s of Object.keys(SYNC_ALLOWLIST)) {
    for (const i of Object.keys(INSTANCE_SCOPE_KEYS)) {
      assert.equal(overlaps(s, i), false, `overlap: allowlist "${s}" vs instance "${i}"`);
    }
  }
});

test("writeSetting routing: instance key → global table, NO override, NO emit (D1)", async () => {
  const { db, cleanup } = fresh();
  const emitted = [];
  setSettingsSyncManager({ emitChange: async (t, op, row) => { emitted.push(row.key); } });
  try {
    const res = await upsertSetting(db, "auto_update_enabled", "false");
    assert.equal(await globalValue(db, "auto_update_enabled"), "false", "lands in dashboard_settings");
    assert.equal((await overrideRows(db, "auto_update_enabled")).length, 0, "no override row");
    assert.equal(emitted.length, 0, "instance-scope write does NOT emit to peers");
    // allowlisted key still emits (control)
    await writeSetting(db, "unified_dashboard_enabled", "true", { scope: "global" });
    assert.deepEqual(emitted, ["unified_dashboard_enabled"], "allowlisted global write still emits");
    // non-listed key still downgrades to local (feature_flags class preserved)
    await upsertSetting(db, "feature_flags", '{"x":1}');
    assert.equal(await globalValue(db, "feature_flags"), undefined, "non-listed key NOT in global table");
    assert.equal((await overrideRows(db, "feature_flags")).length, 1, "non-listed key downgraded to override");
  } finally {
    setSettingsSyncManager(null);
    cleanup();
  }
});

test("writeSetting allowLocalFallback:false — throws for non-listed, succeeds for instance-scope", async () => {
  const { db, cleanup } = fresh();
  try {
    await assert.rejects(
      writeSetting(db, "some_random_key", "v", { scope: "global", allowLocalFallback: false }),
      (err) => err.code === "NotSyncable",
    );
    const r = await writeSetting(db, "discovery_enabled", "true", { scope: "global", allowLocalFallback: false });
    assert.deepEqual(r, { scope: "global", instance_id: null });
    assert.equal(await globalValue(db, "discovery_enabled"), "true");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/instance-scope-keys.test.js`
Expected: FAIL — `INSTANCE_SCOPE_KEYS`/`isInstanceScope` are not exported (SyntaxError/undefined).

- [ ] **Step 3: Implement**

In `servers/gateway/dashboard/settings/sync-allowlist.js`, append after the `PROFILE_SYNC_KEYS` export:

```js
/**
 * Instance-scope keys — per-install settings whose readers query the global
 * dashboard_settings table directly (auto-update timer, notification delivery
 * gate, peer-discovery API, public blog, media bundle, setup pages). Each
 * instance's DB is its own world for these: replication is gated by
 * isSyncable at BOTH emit (instance-sync.js shouldSyncRow) and apply (the
 * inbound-entry dispatch), so a global row for a key listed here NEVER leaves
 * the box. writeSetting routes these to the global table instead of the
 * legacy downgrade-to-local (which stranded every UI save in an overrides row
 * no reader consulted — the F-SETTINGS-1 §6 bug class).
 *
 * What belongs here: per-install behavior toggles with global-direct readers.
 * What does NOT: user-level data that should follow the user (SYNC_ALLOWLIST,
 * e.g. profile_*), and intentionally-local keys whose readers all resolve
 * overrides via readSetting (feature_flags, kiosk_mode — do NOT add those).
 * Promoting a key from here to fleet-synced later = move it to SYNC_ALLOWLIST
 * + bump the reemit flag (see reemitSyncableSettingsOnce) — a deliberate,
 * per-key product decision.
 *
 * Entries may end with "*" to match a prefix. A key must never match BOTH
 * lists (test-enforced, pattern-aware).
 */
export const INSTANCE_SCOPE_KEYS = {
  auto_update_enabled:        "Auto-update on/off (per install)",
  auto_update_interval_hours: "Auto-update check interval (per install)",
  notification_prefs:         "Notification type gating (per install)",
  discovery_enabled:          "Peer discovery opt-in (per install)",
  discovery_name:             "Peer discovery display name (per install)",
  onboarding_completed_at:    "Onboarding completion stamp (per install)",
  language:                   "Dashboard language default (per install)",
  "blog_*":                   "Blog config — the blog is hosted per instance",
  tts_voice:                  "Legacy TTS voice mirror (per install)",
};

/**
 * Check whether a key is instance-scope (global table, never synced).
 * @param {string} key
 * @returns {boolean}
 */
export function isInstanceScope(key) {
  if (!key) return false;
  for (const pattern of Object.keys(INSTANCE_SCOPE_KEYS)) {
    if (pattern.endsWith("*")) {
      if (key.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === key) {
      return true;
    }
  }
  return false;
}
```

In `servers/gateway/dashboard/settings/registry.js`:

Line 121, change the import to:

```js
import { isSyncable, isInstanceScope } from "./sync-allowlist.js";
```

Replace the `writeSetting` docblock (lines 176-189) with:

```js
/**
 * Write a setting with explicit scope. Three-way routing:
 *
 *   - allowlisted key + scope "global"     → dashboard_settings row, EMITTED
 *     to paired peers. Does NOT clear a local override — an existing override
 *     for this instance keeps winning readSetting until deleteLocalSetting is
 *     called (the scope route does that explicitly; see routes/settings-scope.js).
 *   - instance-scope key + scope "global"  → dashboard_settings row, NEVER
 *     emitted (per-install setting; readers are global-direct by design —
 *     see INSTANCE_SCOPE_KEYS in sync-allowlist.js).
 *   - any other key + scope "global"       → silently downgraded to local
 *     (legacy upsertSetting behavior) unless allowLocalFallback:false, which
 *     throws NotSyncable instead.
 *   - scope "local" → dashboard_settings_overrides row keyed by
 *     (key, instance_id). Never syncs. Takes precedence over the global row
 *     on readSetting reads.
 */
```

In the `writeSetting` body, change the downgrade condition (line ~194) from:

```js
  if (scope === "global" && !isSyncable(key)) {
```

to:

```js
  if (scope === "global" && !isSyncable(key) && !isInstanceScope(key)) {
```

and change the unconditional emit after the global upsert (line ~221-222) from:

```js
  // Emit to peers — filter happens inside InstanceSyncManager.
  await emitSettingsSync("update", { key, value, instance_id: null });
```

to:

```js
  // Emit to peers only for allowlisted keys. Instance-scope keys are
  // per-install and must not emit (the manager's shouldSyncRow gate would
  // drop them anyway — this makes the intent explicit at the source).
  if (isSyncable(key)) {
    await emitSettingsSync("update", { key, value, instance_id: null });
  }
```

Line 256, change the re-export to:

```js
export { isSyncable, isInstanceScope };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/instance-scope-keys.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Mutation checks (do NOT commit the mutations)**

1. Revert the routing condition to `!isSyncable(key)` only → run the test file → the "instance key → global table" assertions MUST fail. Restore.
2. Remove the `if (isSyncable(key))` emit gate (make the emit unconditional) → the "does NOT emit" assertion MUST fail. Restore.
Record both outcomes in your report.

- [ ] **Step 6: Full-file sanity + commit**

Run: `node --test tests/profile-heal.test.js tests/settings-reemit-v2.test.js` — Expected: PASS (neighboring settings machinery unaffected).

```bash
git add tests/instance-scope-keys.test.js
git commit servers/gateway/dashboard/settings/sync-allowlist.js servers/gateway/dashboard/settings/registry.js tests/instance-scope-keys.test.js -m "feat(settings): INSTANCE_SCOPE_KEYS — per-instance keys write the global table, never emit (D1)"
git show --stat HEAD
```

---

### Task 2: One-shot heal for stranded overrides (spec D2)

**Files:**
- Create: `servers/gateway/dashboard/settings/instance-scope-heal.js`
- Modify: `servers/gateway/boot/mcp-mounts.js` (insert BEFORE the profile-heal block at lines 78-90)
- Test: `tests/instance-scope-heal.test.js` (new)

**Interfaces:**
- Consumes: `isInstanceScope` from Task 1; `writeSetting`, `deleteLocalSetting` from registry.js; `getOrCreateLocalInstanceId` from `servers/gateway/instance-registry.js`; `createDbClient` already imported in mcp-mounts.js:17.
- Produces: `healInstanceScopeOverridesOnce(db) → Promise<number>` (count promoted). Flag row key `__instance_scope_heal_v1`.

- [ ] **Step 1: Write the failing test**

Create `tests/instance-scope-heal.test.js`:

```js
/**
 * Settings-scope coherence D2 — one-shot heal. Stranded broken-era overrides
 * for instance-scope keys are promoted to the global table newest-updated_at-
 * wins and deleted; flag-guarded (__instance_scope_heal_v1); failure-tracked
 * flag (a per-key error leaves the flag unwritten → retry next boot — a
 * DELIBERATE divergence from profile-heal, which never retries); runs with no
 * sync manager at all (ungated posture).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { healInstanceScopeOverridesOnce } from "../servers/gateway/dashboard/settings/instance-scope-heal.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "iscope-heal-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
async function seedOverride(db, localId, key, value, ts) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at) VALUES (?, ?, ?, ?)",
    args: [key, localId, value, ts],
  });
}
async function seedGlobal(db, key, value, ts) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, ?)",
    args: [key, value, ts],
  });
}
const globalValue = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;
const overrideCount = async (db, like) =>
  Number((await db.execute({ sql: "SELECT COUNT(*) AS c FROM dashboard_settings_overrides WHERE key LIKE ?", args: [like] })).rows[0].c);
const flagValue = async (db) =>
  (await db.execute("SELECT value FROM dashboard_settings WHERE key = '__instance_scope_heal_v1'")).rows[0]?.value;

function withDataDir(dir, fn) {
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
  });
}

test("heal: promote override-only, newest-wins vs global, blog_* pattern, non-instance keys untouched, flag one-shot", async () => {
  const { dir, db, cleanup } = fresh();
  await withDataDir(dir, async () => {
    try {
      const localId = getOrCreateLocalInstanceId();
      // (a) override-only → promoted
      await seedOverride(db, localId, "discovery_enabled", "true", "2026-07-01 10:00:00");
      // (c) override NEWER than global → override wins
      await seedOverride(db, localId, "notification_prefs", '{"types_enabled":["reminder"]}', "2026-07-02 10:00:00");
      await seedGlobal(db, "notification_prefs", '{"types_enabled":["reminder","media"]}', "2026-07-01 09:00:00");
      // (d) global NEWER than override → global preserved, override still deleted
      await seedOverride(db, localId, "blog_title", "Stale UI Title", "2026-03-01 10:00:00");
      await seedGlobal(db, "blog_title", "Live MCP Title", "2026-06-01 10:00:00");
      // (g) non-instance-scope overrides untouched
      await seedOverride(db, localId, "feature_flags", '{"keep":"me"}', "2026-07-01 10:00:00");
      await seedOverride(db, localId, "profile_display_name", "KeepMe", "2026-07-01 10:00:00");

      const n = await healInstanceScopeOverridesOnce(db);
      assert.equal(n, 2, "(a)+(c) promoted; (d) not promoted");
      assert.equal(await globalValue(db, "discovery_enabled"), "true", "(a)");
      assert.equal(await globalValue(db, "notification_prefs"), '{"types_enabled":["reminder"]}', "(c) newer override won");
      assert.equal(await globalValue(db, "blog_title"), "Live MCP Title", "(d) newer global preserved");
      assert.equal(await overrideCount(db, "discovery_%"), 0);
      assert.equal(await overrideCount(db, "notification_%"), 0);
      assert.equal(await overrideCount(db, "blog_%"), 0, "(d) losing override still deleted");
      assert.equal(await overrideCount(db, "feature_flags"), 1, "(g) consistent-key override untouched");
      assert.equal(await overrideCount(db, "profile_%"), 1, "(g) allowlisted-key override untouched");
      assert.match(String(await flagValue(db)), /^done:2$/);

      // (b) second run is a flag-guarded no-op even with a fresh override present
      await seedOverride(db, localId, "discovery_enabled", "false", "2026-07-03 10:00:00");
      const n2 = await healInstanceScopeOverridesOnce(db);
      assert.equal(n2, 0, "(b) flag-guarded");
      assert.equal(await globalValue(db, "discovery_enabled"), "true", "(b) post-flag override not consumed");
    } finally { cleanup(); }
  });
});

test("heal: (e) no overrides → flag set, nothing written; runs with NO sync manager (i)", async () => {
  const { dir, db, cleanup } = fresh();
  await withDataDir(dir, async () => {
    try {
      setSettingsSyncManager(null); // (i) ungated posture: null manager must not matter
      const n = await healInstanceScopeOverridesOnce(db);
      assert.equal(n, 0);
      assert.match(String(await flagValue(db)), /^done:0$/, "(e) flag written on clean empty run");
    } finally { cleanup(); }
  });
});

test("heal: (j) NULL-updated_at precedence", async () => {
  const { dir, db, cleanup } = fresh();
  await withDataDir(dir, async () => {
    try {
      const localId = getOrCreateLocalInstanceId();
      // global ts NULL → override wins
      await seedOverride(db, localId, "language", "es", "2026-07-01 10:00:00");
      await db.execute("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('language', 'en', NULL)");
      // override ts NULL, global ts present → global wins (override deleted)
      await seedOverride(db, localId, "tts_voice", "af_bella", null);
      await seedGlobal(db, "tts_voice", "en-US-BrianNeural", "2026-07-01 10:00:00");

      const n = await healInstanceScopeOverridesOnce(db);
      assert.equal(n, 1);
      assert.equal(await globalValue(db, "language"), "es", "global-ts-NULL → override wins");
      assert.equal(await globalValue(db, "tts_voice"), "en-US-BrianNeural", "override-ts-NULL → global wins");
      assert.equal(await overrideCount(db, "tts_voice"), 0, "losing override still deleted");
    } finally { cleanup(); }
  });
});

test("heal: (h) one key's failure does not abort the others AND leaves the flag UNWRITTEN", async () => {
  const { dir, db, cleanup } = fresh();
  await withDataDir(dir, async () => {
    try {
      const localId = getOrCreateLocalInstanceId();
      await seedOverride(db, localId, "discovery_enabled", "true", "2026-07-01 10:00:00");
      await seedOverride(db, localId, "language", "es", "2026-07-01 10:00:00");
      // Wrap the db so the global-row lookup for ONE key throws.
      const failingDb = {
        execute: (arg) => {
          const sql = typeof arg === "string" ? arg : arg.sql;
          const args = typeof arg === "string" ? [] : (arg.args || []);
          if (sql.includes("SELECT value, updated_at FROM dashboard_settings WHERE key = ?") && args[0] === "language") {
            throw new Error("injected failure");
          }
          return db.execute(arg);
        },
      };
      const n = await healInstanceScopeOverridesOnce(failingDb);
      assert.equal(n, 1, "the healthy key still promoted");
      assert.equal(await globalValue(db, "discovery_enabled"), "true");
      assert.equal(await flagValue(db), undefined, "(h) flag UNWRITTEN after a per-key failure → retries next boot");

      // Next (clean) boot retries and completes.
      const n2 = await healInstanceScopeOverridesOnce(db);
      assert.equal(n2, 1, "retry promotes the previously-failed key");
      assert.equal(await globalValue(db, "language"), "es");
      assert.match(String(await flagValue(db)), /^done:1$/);
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/instance-scope-heal.test.js`
Expected: FAIL — module `instance-scope-heal.js` does not exist.

- [ ] **Step 3: Implement the heal module**

Create `servers/gateway/dashboard/settings/instance-scope-heal.js`:

```js
/**
 * instance-scope-heal.js — settings-scope coherence D2: one-shot heal for
 * values stranded in dashboard_settings_overrides by the broken-era
 * upsertSetting downgrade (the F-SETTINGS-1 §6 bug class).
 *
 * For every override row of THIS instance whose key isInstanceScope:
 *   - no global row            → promote to global, delete override
 *   - global row exists        → NEWEST updated_at wins (both tables' writers
 *     use datetime('now') on one host/clock — unlike Cluster B's cross-
 *     instance case, a timestamp compare is safe here). NULL precedence:
 *     global ts NULL/empty → override wins; else override ts NULL/empty →
 *     global wins; else lexicographic (>= : tie → override, the broken-era
 *     UI write being healed). The override row is deleted EITHER WAY —
 *     post-D1, overrides for instance-scope keys are meaningless and would
 *     keep shadowing readSetting-based readers (blog_theme_* chrome).
 *   - promote strictly BEFORE delete (a crash between re-runs idempotently).
 *
 * Flag __instance_scope_heal_v1 is RAW SQL into dashboard_settings (an
 * upsertSetting'd flag key would be misfiled by the very routing this PR
 * adds). FAILURE-TRACKED: one key's error skips that key, and the flag stays
 * UNWRITTEN so the next boot retries — a DELIBERATE divergence from
 * profile-heal.js, which writes its flag unconditionally and never retries.
 * Do not "simplify" back to that shape (mutation-tested).
 *
 * Deliberately UNGATED (contrast profile-heal's feedsDisabled gate): this
 * heal has ZERO sync side effects (writeSetting does not emit instance-scope
 * keys), so any process sharing the data dir — primary, --no-auth companion —
 * reaches the identical result, and a null-syncManager boot still heals.
 */
import { writeSetting, deleteLocalSetting } from "./registry.js";
import { isInstanceScope } from "./sync-allowlist.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";

const FLAG_KEY = "__instance_scope_heal_v1";

function overrideWins(overrideTs, globalTs) {
  if (globalTs == null || String(globalTs).trim() === "") return true;
  if (overrideTs == null || String(overrideTs).trim() === "") return false;
  return String(overrideTs) >= String(globalTs);
}

export async function healInstanceScopeOverridesOnce(db) {
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
  let overrides;
  try {
    ({ rows: overrides } = await db.execute({
      sql: "SELECT key, value, updated_at FROM dashboard_settings_overrides WHERE instance_id = ?",
      args: [localId],
    }));
  } catch {
    return 0;
  }

  let promoted = 0;
  let hadFailure = false;
  for (const row of overrides) {
    if (!isInstanceScope(row.key)) continue;
    try {
      const g = await db.execute({
        sql: "SELECT value, updated_at FROM dashboard_settings WHERE key = ?",
        args: [row.key],
      });
      const globalRow = g.rows[0];
      if (!globalRow || overrideWins(row.updated_at, globalRow.updated_at)) {
        await writeSetting(db, row.key, row.value, { scope: "global" });
        promoted++;
      }
      await deleteLocalSetting(db, row.key);
    } catch (err) {
      hadFailure = true;
      console.warn(`[settings] instance-scope heal for ${row.key} failed: ${err.message}`);
    }
  }

  if (!hadFailure) {
    try {
      await db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [FLAG_KEY, `done:${promoted}`],
      });
    } catch {}
  }

  if (promoted > 0) {
    console.log(`[settings] instance-scope heal: promoted ${promoted} stranded per-instance value(s) to the global scope`);
  }
  return promoted;
}
```

NOTE for the implementer: `deleteLocalSetting` calls `getOrCreateLocalInstanceId()` internally and `writeSetting` routes via Task 1 — the injected-failure test's `failingDb` wrapper only intercepts `db.execute`, which both helpers use, so it works unmodified.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/instance-scope-heal.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Wire into boot**

In `servers/gateway/boot/mcp-mounts.js`, insert BEFORE the Cluster B profile-heal block (i.e. immediately after the `setSettingsSyncManager` try/catch ending line 76):

```js
  // Settings-scope coherence D2: one-shot heal — promote instance-scope
  // values stranded in dashboard_settings_overrides by the broken-era
  // upsertSetting downgrade. Deliberately UNGATED (contrast the profile heal
  // below): zero sync side effects, so a --no-auth companion sharing the
  // primary's DB reaches the identical result — and it uses its own
  // createDbClient() so even a null-syncManager boot heals.
  try {
    const { healInstanceScopeOverridesOnce } = await import("../dashboard/settings/instance-scope-heal.js");
    await healInstanceScopeOverridesOnce(createDbClient());
  } catch (err) {
    console.warn(`[settings] healInstanceScopeOverridesOnce failed: ${err.message}`);
  }
```

- [ ] **Step 6: Mutation checks (do NOT commit the mutations)**

1. Remove the flag check (the first try block's early return) → test (b) MUST fail. Restore.
2. Replace the `overrideWins` call with `true` (drop the comparison) → test (d) "Live MCP Title" assertion MUST fail. Restore.
3. Change `if (!isInstanceScope(row.key)) continue;` to not skip → test (g) MUST fail. Restore.
4. Write the flag unconditionally (drop `if (!hadFailure)` — the profile-heal shape) → test (h) flag-unwritten assertion MUST fail. Restore.
5. Remove the NULL guard branches in `overrideWins` → test (j) MUST fail on at least one direction. Restore.
Record all five outcomes.

- [ ] **Step 7: Boot sanity + commit**

Run: `timeout 25 node servers/gateway/index.js --no-auth 2>&1 | head -40` (Ctrl-C equivalent via timeout) — Expected: boots without `healInstanceScopeOverridesOnce failed`, no crash.

```bash
git add servers/gateway/dashboard/settings/instance-scope-heal.js tests/instance-scope-heal.test.js
git commit servers/gateway/dashboard/settings/instance-scope-heal.js servers/gateway/boot/mcp-mounts.js tests/instance-scope-heal.test.js -m "feat(settings): one-shot instance-scope override heal — newest-wins, failure-tracked flag, ungated boot wiring (D2)"
git show --stat HEAD
```

---

### Task 3: Scope-route guard (spec D3)

**Files:**
- Modify: `servers/gateway/routes/settings-scope.js` (import line 26; POST handler after the scope-value validation, line ~57)
- Test: `tests/settings-scope-guard.test.js` (new)

**Interfaces:**
- Consumes: `isInstanceScope` from sync-allowlist.js.
- Produces: POST `/api/settings/scope` responds 403 `{code:"InstanceScoped"}` for instance-scope keys, both directions.

- [ ] **Step 1: Write the failing test**

Create `tests/settings-scope-guard.test.js`:

```js
/**
 * Settings-scope coherence D3 — the scope route refuses to promote OR demote
 * an instance-scope key. Pure hardening: the scope-toggle UI renders radios
 * only for isSyncable keys, so no UI path exists — this guards hand-crafted
 * requests that would otherwise create a shadowing override (the exact bug
 * class this PR removes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import settingsScopeRouter from "../servers/gateway/routes/settings-scope.js";

function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), "scope-guard-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  return dir;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use(settingsScopeRouter((req, res, next) => next())); // no-op auth
  const srv = app.listen(0);
  const port = srv.address().port;
  try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(); }
}

test("scope route: 403 InstanceScoped for instance-scope keys, both directions; others unaffected", async () => {
  const dir = freshEnv();
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  try {
    await withServer(async (base) => {
      for (const scope of ["local", "global"]) {
        const r = await fetch(`${base}/api/settings/scope`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "auto_update_enabled", scope }),
        });
        assert.equal(r.status, 403, `scope=${scope}`);
        const body = await r.json();
        assert.equal(body.code, "InstanceScoped", `scope=${scope}`);
      }
      // blog_* prefix covered too
      const rBlog = await fetch(`${base}/api/settings/scope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "blog_title", scope: "local" }),
      });
      assert.equal(rBlog.status, 403);
      // non-listed key keeps prior behavior: promote → 403 NotSyncable (allowlist), demote of a
      // value-less key → 404 (readSetting null) — both NOT InstanceScoped
      const rPromote = await fetch(`${base}/api/settings/scope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "some_random_key", scope: "global" }),
      });
      assert.equal(rPromote.status, 403);
      assert.equal((await rPromote.json()).code, "NotSyncable");
      // GET still reports for instance keys
      const rGet = await fetch(`${base}/api/settings/scope?key=auto_update_enabled`);
      assert.equal(rGet.status, 200);
    });
  } finally {
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/settings-scope-guard.test.js`
Expected: FAIL — POST currently returns 200 (scope=local writes an override) / 404 or NotSyncable, not InstanceScoped.

- [ ] **Step 3: Implement**

In `servers/gateway/routes/settings-scope.js`, change line 26 to:

```js
import { isSyncable, isInstanceScope } from "../dashboard/settings/sync-allowlist.js";
```

In the POST handler, insert AFTER the `scope !== "global" && scope !== "local"` validation (line ~57) and BEFORE the existing `scope === "global" && !isSyncable(key)` check:

```js
    if (isInstanceScope(key)) {
      return res.status(403).json({
        error: `Key "${key}" is per-instance by design; its scope cannot be changed.`,
        code: "InstanceScoped",
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/settings-scope-guard.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation check (do NOT commit)**

Remove the `isInstanceScope` guard → the 403/InstanceScoped assertions MUST fail (scope=local would 200 and write an override). Restore. Record.

- [ ] **Step 6: Commit**

```bash
git add tests/settings-scope-guard.test.js
git commit servers/gateway/routes/settings-scope.js tests/settings-scope-guard.test.js -m "feat(settings): scope route refuses instance-scope keys — 403 InstanceScoped (D3)"
git show --stat HEAD
```

---

### Task 4: vision_profiles reader conformance + vestigial dead-write deletes (spec D5 + D4)

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/data-queries.js` (loadVisionProfiles, lines 99-112)
- Modify: `servers/gateway/dashboard/settings/sections/theme.js` (set_theme handler, lines 97-101)
- Modify: `servers/gateway/dashboard/settings/migrations/llm-settings-migration.js` (lines ~173-179)
- Test: `tests/instance-scope-cleanups.test.js` (new)

**Interfaces:**
- Consumes: `readSetting` from `../../settings/registry.js` (relative to data-queries.js).
- Produces: `loadVisionProfiles(db)` unchanged signature, now override-aware; `set_theme` action response-only.

- [ ] **Step 1: Write the failing test**

Create `tests/instance-scope-cleanups.test.js`:

```js
/**
 * Settings-scope coherence D5 + D4:
 *  - loadVisionProfiles resolves scope like every other vision_profiles reader
 *    (readSetting: override-then-global) instead of raw global (which returned
 *    [] for every install whose section default-wrote local).
 *  - set_theme is response-only: the dashboard_theme write was vestigial
 *    (zero runtime readers) and is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { loadVisionProfiles } from "../servers/gateway/dashboard/panels/bot-builder/data-queries.js";
import { writeSetting } from "../servers/gateway/dashboard/settings/registry.js";
import themeSection from "../servers/gateway/dashboard/settings/sections/theme.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "iscope-clean-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("D5: loadVisionProfiles sees a LOCAL-scoped vision_profiles row (apiKey stripped)", async () => {
  const { dir, db, cleanup } = fresh();
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  try {
    await writeSetting(db, "vision_profiles",
      JSON.stringify([{ id: "v1", name: "Local Vision", apiKey: "sk-secret" }]),
      { scope: "local" });
    const out = await loadVisionProfiles(db);
    assert.equal(out.length, 1, "local-scoped profile visible");
    assert.equal(out[0].name, "Local Vision");
    assert.equal(out[0].apiKey, undefined, "apiKey stripped");
  } finally {
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    cleanup();
  }
});

test("D4: set_theme responds ok and writes NOTHING", async () => {
  const executed = [];
  const recorderDb = { execute: async (arg) => { executed.push(typeof arg === "string" ? arg : arg.sql); return { rows: [] }; } };
  let jsonBody = null;
  const res = { json: (b) => { jsonBody = b; }, setHeader() {} };
  const handled = await themeSection.handleAction({
    req: { body: { theme: "light" } }, res, db: recorderDb, action: "set_theme",
  });
  assert.equal(handled, true);
  assert.deepEqual(jsonBody, { ok: true });
  assert.equal(executed.length, 0, "no DB writes from set_theme");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/instance-scope-cleanups.test.js`
Expected: FAIL — D5 test gets `[]` (raw global read misses the override); D4 test records 1+ executes (the dashboard_theme INSERT via upsertSetting).

- [ ] **Step 3: Implement**

In `servers/gateway/dashboard/panels/bot-builder/data-queries.js`, add to the imports:

```js
import { readSetting } from "../../settings/registry.js";
```

and replace `loadVisionProfiles` (lines 99-112) with:

```js
// A6: vision profiles have no dedicated getter (unlike tts/stt) — resolve via
// readSetting (override-then-global) like every other vision_profiles reader
// (the section default-writes LOCAL scope; a raw global SELECT here returned
// [] forever on such installs). apiKey stripped, same storage shape.
export async function loadVisionProfiles(db) {
  try {
    const value = await readSetting(db, "vision_profiles");
    if (!value) return [];
    return JSON.parse(value).map(({ apiKey, ...rest }) => rest);
  } catch {
    return [];
  }
}
```

In `servers/gateway/dashboard/settings/sections/theme.js`, replace the `set_theme` branch (lines 97-101):

```js
    if (action === "set_theme") {
      // Response-only: chrome theme persistence flows through set_theme_mode →
      // blog_theme_mode (read by dashboard/index.js). The old dashboard_theme
      // write here was vestigial — zero runtime readers — and was removed with
      // the settings-scope coherence PR.
      res.json({ ok: true });
      return true;
    }
```

In `servers/gateway/dashboard/settings/migrations/llm-settings-migration.js`, delete these lines (~173-179):

```js
  // Record the env-default pointer. llm_chat_default_provider_id is a
  // local-only key (not in SYNC_ALLOWLIST); upsertSetting falls back to
  // dashboard_settings_overrides for non-allowlisted keys.
  try {
    await upsertSetting(db, "llm_chat_default_provider_id", ENV_DEFAULT_ID);
  } catch {}
```

(The `return { migrated: true, provider_id: ENV_DEFAULT_ID };` line stays. If `upsertSetting` is now unused in that file's imports, remove it from the line-27 import — check with `grep -n "upsertSetting" servers/gateway/dashboard/settings/migrations/llm-settings-migration.js`; `readSetting` stays if still used.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/instance-scope-cleanups.test.js`
Expected: PASS (2/2).

- [ ] **Step 5: Neighbor sanity + commit**

Run: `node --test tests/ 2>&1 | tail -5` is too slow here — instead run the focused neighbors:
`grep -rln "loadVisionProfiles\|migrateLlmSettings\|set_theme" tests/ | xargs -r -n1 node --test`
Expected: all PASS (any pre-existing migration/bot-builder tests stay green).

```bash
git add tests/instance-scope-cleanups.test.js
git commit servers/gateway/dashboard/panels/bot-builder/data-queries.js servers/gateway/dashboard/settings/sections/theme.js servers/gateway/dashboard/settings/migrations/llm-settings-migration.js tests/instance-scope-cleanups.test.js -m "fix(settings): vision_profiles reader resolves scope; drop vestigial dashboard_theme + llm_chat_default_provider_id writes (D4+D5)"
git show --stat HEAD
```

---

### Task 5: Auto-update tick gate (spec D6)

**Files:**
- Modify: `servers/gateway/auto-update.js` (timer callback lines 229-234; new exports)
- Test: `tests/auto-update-tick-gate.test.js` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `tickCheck(check = checkForUpdates) → Promise<any|null>` exported; `_setDbForTest(database)` test-only export. `checkForUpdates` stays exported and UNGATED (the manual "Check for updates now" button at settings sections/updates.js:165-167 calls it directly — R1 MAJOR-1: do NOT put the gate inside it).

- [ ] **Step 1: Write the failing test**

Create `tests/auto-update-tick-gate.test.js`:

```js
/**
 * Settings-scope coherence D6 — the auto-update TIMER re-reads
 * auto_update_enabled each tick (post-D1 the UI toggle lands in the global
 * row this module reads), so disable takes effect within one interval,
 * WITHOUT gating checkForUpdates() itself (the manual "Check now" button
 * calls it directly and must keep working when auto-update is disabled —
 * R1 MAJOR-1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tickCheck, _setDbForTest } from "../servers/gateway/auto-update.js";

function stubDb(enabledValue) {
  return {
    execute: async () => ({
      rows: enabledValue === undefined ? [] : [{ key: "auto_update_enabled", value: enabledValue }],
    }),
  };
}

test("tick gate: disabled → injected check NOT called, returns null", async () => {
  _setDbForTest(stubDb("false"));
  let called = 0;
  const out = await tickCheck(async () => { called++; return { ran: true }; });
  assert.equal(called, 0, "tick must skip when disabled");
  assert.equal(out, null);
  _setDbForTest(null);
});

test("tick gate: enabled → injected check called", async () => {
  _setDbForTest(stubDb("true"));
  let called = 0;
  await tickCheck(async () => { called++; return { ran: true }; });
  assert.equal(called, 1);
  _setDbForTest(null);
});

test("tick gate: DB error → getSettings returns defaults (enabled) → proceeds (fail-open, spec D6)", async () => {
  _setDbForTest({ execute: async () => { throw new Error("db down"); } });
  let called = 0;
  await tickCheck(async () => { called++; });
  assert.equal(called, 1, "defaults have auto_update_enabled:'true' → tick proceeds");
  _setDbForTest(null);
});

test("tick gate: no rows at all (fresh install) → defaults → proceeds", async () => {
  _setDbForTest(stubDb(undefined));
  let called = 0;
  await tickCheck(async () => { called++; });
  assert.equal(called, 1);
  _setDbForTest(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/auto-update-tick-gate.test.js`
Expected: FAIL — `tickCheck`/`_setDbForTest` not exported.

- [ ] **Step 3: Implement**

In `servers/gateway/auto-update.js`, add after `getSettings()` (i.e. after line 52):

```js
/**
 * Timer-tick wrapper: re-reads auto_update_enabled each tick so a UI disable
 * takes effect within one interval, no restart. The gate lives HERE and NOT
 * in checkForUpdates() — the manual "Check for updates now" settings action
 * calls checkForUpdates() directly and must work while auto-update is
 * disabled (that is the point of a manual button). getSettings() cannot
 * throw: on DB error it returns defaults (enabled:"true"), indistinguishable
 * from a fresh install, so a blip proceeds for that one tick — consistent
 * with the boot gate's identical defaulting; self-corrects next tick.
 * `check` is injectable for tests only.
 */
export async function tickCheck(check = checkForUpdates) {
  const settings = await getSettings();
  if (settings.auto_update_enabled !== "true") {
    console.log("[auto-update] Skipping scheduled check — disabled in settings");
    return null;
  }
  return check();
}

/** Test-only: inject the module-level db handle without starting timers. */
export function _setDbForTest(database) {
  db = database;
}
```

Replace the timer body (lines 229-234):

```js
  // First check after 5 minutes (let gateway fully start)
  updateTimer = setTimeout(async () => {
    await tickCheck();
    // Then schedule recurring checks
    updateTimer = setInterval(() => { tickCheck().catch(() => {}); }, intervalMs);
  }, 5 * 60 * 1000);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/auto-update-tick-gate.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Mutation checks (do NOT commit)**

1. Remove the `!== "true"` early-return in `tickCheck` → test 1 MUST fail. Restore.
2. Change the setInterval callback back to `checkForUpdates()` directly → no test reddens (module-internal wiring) — so ALSO verify by inspection and state in your report that both timer call sites go through `tickCheck`. This wiring is what the CDP tick-skip check proves live.
Record outcomes.

- [ ] **Step 6: Verify the manual path is untouched + commit**

Run: `git diff servers/gateway/auto-update.js | grep -c "checkForUpdates"` and confirm by reading the diff that `checkForUpdates`'s body has NO new gate; `grep -n "check_updates_now" servers/gateway/dashboard/settings/sections/updates.js` still calls `checkForUpdates` (file untouched by this task).

```bash
git add tests/auto-update-tick-gate.test.js
git commit servers/gateway/auto-update.js tests/auto-update-tick-gate.test.js -m "feat(auto-update): re-read enabled flag each timer tick — UI disable works without restart; manual check stays ungated (D6)"
git show --stat HEAD
```

---

### Task 6: Family write→read integration tests + full suite + boot (spec §5.3, §5.9)

**Files:**
- Test: `tests/instance-scope-write-read.test.js` (new)
- No production code changes expected. If a test exposes a defect, STOP and report — do not silently patch other tasks' files.

**Interfaces:**
- Consumes: `upsertSetting` (Task 1 routing); `createNotification` from `servers/shared/notifications.js`.

- [ ] **Step 1: Write the integration tests**

Create `tests/instance-scope-write-read.test.js`:

```js
/**
 * Settings-scope coherence §5.3 — end-to-end write→read per family: a UI-style
 * upsertSetting write is visible to each family's REAL reader mechanism
 * (raw global SELECT or actual reader function). These are the exact reads
 * that were blind to UI saves before D1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { upsertSetting } from "../servers/gateway/dashboard/settings/registry.js";
import { createNotification } from "../servers/shared/notifications.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "iscope-e2e-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
// The EXACT reader query each family's consumer runs (global-direct):
const rawGlobal = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;

test("auto_update family: UI-style save visible to the timer's global read", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "auto_update_enabled", "false");
    await upsertSetting(db, "auto_update_interval_hours", "12");
    // auto-update.js getSettings(): SELECT ... WHERE key LIKE 'auto_update_%'
    const rows = (await db.execute("SELECT key, value FROM dashboard_settings WHERE key LIKE 'auto_update_%'")).rows;
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assert.equal(m.auto_update_enabled, "false");
    assert.equal(m.auto_update_interval_hours, "12");
  } finally { cleanup(); }
});

test("notification_prefs: UI-style save actually gates delivery (createNotification returns null)", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "notification_prefs", JSON.stringify({ types_enabled: ["reminder"] }));
    const suppressed = await createNotification(db, {
      type: "media", title: "t", body: "b",
    });
    assert.equal(suppressed, null, "disabled type suppressed by the real delivery gate");
    const delivered = await createNotification(db, {
      type: "reminder", title: "t", body: "b",
    });
    assert.ok(delivered, "enabled type still delivers");
  } finally { cleanup(); }
});

test("discovery family: UI-style save visible to the peer API's global reads", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "discovery_enabled", "true");
    await upsertSetting(db, "discovery_name", "Crow Test");
    assert.equal(await rawGlobal(db, "discovery_enabled"), "true");
    assert.equal(await rawGlobal(db, "discovery_name"), "Crow Test");
  } finally { cleanup(); }
});

test("blog family: UI-style save visible to blog-public/MCP global reads (incl. listed gate)", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "blog_title", "New Title");
    await upsertSetting(db, "blog_listed", "true");
    assert.equal(await rawGlobal(db, "blog_title"), "New Title");
    assert.equal(await rawGlobal(db, "blog_listed"), "true");
  } finally { cleanup(); }
});

test("language + onboarding + tts_voice: UI-style saves visible to their global-direct readers", async () => {
  const { db, cleanup } = fresh();
  try {
    await upsertSetting(db, "language", "es");
    await upsertSetting(db, "onboarding_completed_at", "2026-07-11T00:00:00.000Z");
    await upsertSetting(db, "tts_voice", "af_bella");
    assert.equal(await rawGlobal(db, "language"), "es");
    assert.ok(await rawGlobal(db, "onboarding_completed_at"));
    assert.equal(await rawGlobal(db, "tts_voice"), "af_bella");
  } finally { cleanup(); }
});
```

NOTE: check `createNotification`'s real signature in `servers/shared/notifications.js` before running — if it takes `(db, { type, title, message })` or positional args, adapt the two calls (the assertion contract — null when the type is disabled, truthy when enabled — is what matters). If web-push/ntfy side effects fire on the delivered path, they are try/catch'd no-ops in a bare test env (verify by reading the function; if it throws on missing VAPID config, seed `notification_prefs` only and assert the SUPPRESSED path plus the row-insert path via the returned value).

- [ ] **Step 2: Run the new tests**

Run: `node --test tests/instance-scope-write-read.test.js`
Expected: PASS (5/5) — these pass because Tasks 1-5 are already in. If any fail, that is a REAL defect in an earlier task: STOP and report which assertion, do not patch.

- [ ] **Step 3: Full suite**

Run: `node --test tests/ 2>&1 | tail -15`
Expected: pass count ≥ the main baseline (re-baseline main in an isolated worktree if unsure; last known 1397 pass / 1 pre-existing foreign fail (rookery registry drift) / 1 skip) plus this branch's new tests; ZERO new failures.

- [ ] **Step 4: Boot checks**

1. `timeout 25 node servers/gateway/index.js --no-auth 2>&1 | head -50` — Expected: clean boot, heal line present-or-silent (no error), no unhandled rejection.
2. Confirm the heal actually ran on the scratch data dir the boot used (or run the heal-focused boot check from Task 2 Step 7 again if the default data dir is shared).

- [ ] **Step 5: Commit**

```bash
git add tests/instance-scope-write-read.test.js
git commit tests/instance-scope-write-read.test.js -m "test(settings): per-family write→read integration proofs for instance-scope routing"
git show --stat HEAD
```

---

### Task 7 (controller, NOT a subagent): CDP verification + PR

Per spec §6 — run on a scratch gateway pair (Cluster-A recipe: distinct host IPs, `CROW_DISABLE_HEALTH_MONITOR=1`, real minted sessions via `~/.crow/eval/tokeneff/mint_session.mjs`, `CROW_DATA_DIR` per instance; drivers at `~/.crow/p4/cluster-a-evidence/cdp.mjs`, crow-browser CDP 127.0.0.1:9222):

- [ ] Updates: click Disable + Save → form re-renders Disabled; DB global row `false`, no override; with a short-interval scratch config, the next tick logs "Skipping scheduled check" (the operator's named hard req). NOTE: do NOT set `CROW_AUTO_UPDATE=0` on this scratch instance (it would mask the DB gate); keep the scratch gateway pointed at a THROWAWAY checkout so a proceeding tick can't mutate the real tree.
- [ ] Discovery: click Enable + set name + Save → form persists; `GET /discover/profile` flips 404→200 with the name.
- [ ] Blog: edit blog_title in the settings form → form persists; public `/blog` shows the new title.
- [ ] Notifications (mixed): uncheck a type + Save in the browser → checkboxes persist; node probe against the scratch DB asserts `createNotification` of that type returns null.
- [ ] Language (mixed): save Español → fresh CDP context without the crow_lang cookie: setup/help pages + the authed dropdown (minted session, no cookie) render Spanish.
- [ ] Heal live: boot a scratch gateway on a DB copy seeded with broken-era overrides (incl. one global-newer dual-writer case) → log shows promotions, overrides empty for instance keys, flag `done:N`.
- [ ] Then: plan-doc + ledger commit, push branch, open PR (Kevin gates merge). Check-runs via `curl https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` (total_count 0 is normal — path-filtered); run `node scripts/check-port-allocation.js` locally (ignore foreign untracked dirs).
- [ ] Post-merge deploy per spec §6: snapshot grackle `blog_%` globals BEFORE deploy; deploy fleet; verify heal logs + flag on each instance; grackle public blog unchanged (or explain the diff via a newer override); crow Updates form persists a save; profile keys still 'Kevin' fleet-wide. Before any live E2E: `fuser ~/.crow/data/crow.db` and kill this session's stale stdio MCP subprocesses.

## Self-Review (done at plan-writing time)

- Spec coverage: D1→T1, D2→T2, D3→T3, D4+D5→T4, D6→T5, §5.3→T6, §5 mutations→embedded per task, §6→T7. §5.1/5.2→T1 tests; §5.4→T2 tests (a-j; (f) covered by blog_title rows in T2 test 1; (i) covered by null-manager test 2); §5.5→T3; §5.6→T4; §5.7→T5; §5.8→T4; §5.9→T6.
- No placeholders: every step has full code or an exact command.
- Type consistency: `isInstanceScope`, `INSTANCE_SCOPE_KEYS`, `healInstanceScopeOverridesOnce`, `tickCheck`, `_setDbForTest` used identically across tasks.
- Known judgment call surfaced to implementers: T6's createNotification signature must be verified against the real module before running (contract stated).
