# F3 — Bot Builder → Core (Phase a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Bot Builder a core feature present on every Crow instance — bots can be *defined* anywhere — by moving its schema into `init-db.js`, resolving all hardcoded `~/.crow-mpa` paths per-instance, and reframing the panels' off-MPA gating. (Distributing the *runtime* is Phase b, out of scope.)

**Architecture:** A new `scripts/pi-bots/instance-paths.mjs` resolves the bots DB / tasks DB / workspace root off the active instance, anchored on `CROW_DB_PATH` (falling back to `resolveDataDir()`), so the same code routes to `~/.crow-mpa` on the MPA gateway and `~/.crow` on a general instance. The three bot tables move into core `init-db.js` (`CREATE TABLE IF NOT EXISTS`, full shape — a no-op on the live MPA DB). Two dashboard panels stop saying "runs on the MPA instance" and instead show a neutral "not initialized" notice plus a local `feature_flags.bot_runtime` indicator.

**Tech Stack:** Node.js ESM, better-sqlite3 (via `servers/db.js` libsql-shaped client), `node:test`, server-rendered dashboard panels.

**Spec:** `docs/superpowers/specs/2026-06-08-f3-bot-builder-to-core-design.md`

**Conventions (apply to every commit):** Commit with explicit path args (`git commit <paths> -m …`), never `git add -A` + bare commit. Verify each commit with `git show --stat HEAD`. Never add Claude as co-author. Branch is `feat/f3-bot-builder-core` (already created off `main`). `git pull --rebase` before any push.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `scripts/pi-bots/instance-paths.mjs` | Resolve bots DB / tasks DB / workspace root per instance | Create |
| `tests/pi-bots-instance-paths.test.js` | Unit-test the resolver | Create |
| `tests/init-db-bot-tables.test.js` | Schema-parity: init-db on a fresh DB creates the 3 bot tables full-shape | Create |
| `scripts/init-db.js` | Canonical DDL for `pi_bot_defs` / `bot_sessions` / `bot_skill_events` | Modify (append) |
| `scripts/init-pi-bots.mjs` | Demote to legacy MPA backfill/guard; add cross-ref comment | Modify (comment only) |
| `scripts/pi-bots/{bridge,bridge_tick,tracker,skill_promote,skill_provenance,model_resolver,mcp_writer}.mjs` | Use the resolver instead of hardcoded `~/.crow-mpa` | Modify |
| `tests/pi-bots-no-mpa-coupling.test.js` | Regression guard: those modules contain no hardcoded MPA DB literal | Create |
| `servers/gateway/dashboard/panels/bot-runtime-flag.js` | `botRuntimeActive(db)` — local, non-synced runtime indicator | Create |
| `tests/bot-runtime-flag.test.js` | Unit-test the flag resolution | Create |
| `servers/gateway/dashboard/panels/bot-builder.js` | Use resolver for TASKS_DB + session dir; reframe notAvail; runtime banner | Modify |
| `servers/gateway/dashboard/panels/bot-board.js` | Reframe notAvail; runtime banner | Modify |
| `~/.claude/plans/F3b-bot-runtime-distribution-handoff.md` | Phase b handoff | Create |

---

## Task 1: `instance-paths.mjs` resolver + unit test

**Files:**
- Create: `scripts/pi-bots/instance-paths.mjs`
- Test: `tests/pi-bots-instance-paths.test.js`

**Design note:** `botsDataDir()` anchors on `CROW_DB_PATH` first (set by `pibot-gateways.service` even when `CROW_DATA_DIR` is not), then `resolveDataDir()` (set by the gateways). `tasksDbPath()` and `botsWorkspaceRoot()` derive from that same anchor so the tasks DB and per-bot workspace always sit beside the crow.db actually in use. All functions read `process.env` at **call time** (not import time) so tests can vary the env.

- [ ] **Step 1: Write the failing test**

Create `tests/pi-bots-instance-paths.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

// Functions read process.env at call time, so set/clear around each call.
const ENV_KEYS = ["CROW_DB_PATH", "CROW_TASKS_DB_PATH", "CROW_DATA_DIR"];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }

const { botsDbPath, tasksDbPath, botsWorkspaceRoot } =
  await import("../scripts/pi-bots/instance-paths.mjs");

test("CROW_DB_PATH is honored verbatim and anchors siblings", () => {
  clearEnv();
  process.env.CROW_DB_PATH = "/home/kh0pp/.crow-mpa/data/crow.db";
  assert.equal(botsDbPath(), "/home/kh0pp/.crow-mpa/data/crow.db");
  assert.equal(tasksDbPath(), "/home/kh0pp/.crow-mpa/data/tasks.db");
  assert.equal(botsWorkspaceRoot(), "/home/kh0pp/.crow-mpa/pi-bots");
});

test("falls back to CROW_DATA_DIR when CROW_DB_PATH is unset", () => {
  clearEnv();
  process.env.CROW_DATA_DIR = "/tmp/f3/data";
  assert.equal(botsDbPath(), "/tmp/f3/data/crow.db");
  assert.equal(tasksDbPath(), "/tmp/f3/data/tasks.db");
  assert.equal(botsWorkspaceRoot(), "/tmp/f3/pi-bots");
});

test("explicit CROW_TASKS_DB_PATH overrides the derived tasks path", () => {
  clearEnv();
  process.env.CROW_DB_PATH = "/tmp/f3/data/crow.db";
  process.env.CROW_TASKS_DB_PATH = "/tmp/other/tasks.db";
  assert.equal(tasksDbPath(), "/tmp/other/tasks.db");
});

test("never returns a ~/.crow-mpa literal when env points elsewhere", () => {
  clearEnv();
  process.env.CROW_DATA_DIR = "/tmp/general/data";
  assert.ok(!botsDbPath().includes(".crow-mpa"));
  assert.ok(!botsWorkspaceRoot().includes(".crow-mpa"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pi-bots-instance-paths.test.js`
Expected: FAIL — `Cannot find module '../scripts/pi-bots/instance-paths.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/pi-bots/instance-paths.mjs`:

```js
/**
 * Per-instance path resolution for the Bot Builder runtime + panel.
 *
 * F3 (Bot Builder -> core): replaces the hardcoded ~/.crow-mpa literals that
 * used to pin pi-bots to the MPA instance. Anchors on CROW_DB_PATH first
 * (pibot-gateways.service sets it even when CROW_DATA_DIR is absent), then
 * resolveDataDir() (CROW_DATA_DIR -> ~/.crow/data -> ./data). tasks DB and the
 * per-bot workspace derive from the SAME anchor, so they always sit beside the
 * crow.db actually in use. All functions read process.env at call time.
 */
import { dirname, join } from "node:path";
import { resolveDataDir } from "../../servers/db.js";

/** The data dir holding the crow.db this process uses. */
function botsDataDir() {
  if (process.env.CROW_DB_PATH) return dirname(process.env.CROW_DB_PATH);
  return resolveDataDir();
}

/** Absolute path to the bots crow.db for this instance. */
export function botsDbPath() {
  return process.env.CROW_DB_PATH || join(botsDataDir(), "crow.db");
}

/** Absolute path to the tasks.db for this instance. */
export function tasksDbPath() {
  return process.env.CROW_TASKS_DB_PATH || join(botsDataDir(), "tasks.db");
}

/** Per-bot workspace root: sibling of the data dir (…/pi-bots). */
export function botsWorkspaceRoot() {
  return join(dirname(botsDataDir()), "pi-bots");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pi-bots-instance-paths.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-bots/instance-paths.mjs tests/pi-bots-instance-paths.test.js
git commit scripts/pi-bots/instance-paths.mjs tests/pi-bots-instance-paths.test.js \
  -m "F3: per-instance path resolver for Bot Builder (instance-paths.mjs)"
git show --stat HEAD
```
Expected: 2 files changed.

---

## Task 2: Move bot-table DDL into core `init-db.js`

**Files:**
- Test: `tests/init-db-bot-tables.test.js`
- Modify: `scripts/init-db.js` (append after the `job_search_sites table` block, before `console.log("Database initialized successfully (local file)")`)
- Modify: `scripts/init-pi-bots.mjs` (cross-reference comment only)

**Design note:** Tables go in their **full current shape** — `pi_bot_defs.project_id`, `bot_sessions.model`/`escalated` included in the `CREATE` body (today those are guarded `ALTER`s in `init-pi-bots.mjs`). This is a verified no-op on the live MPA DB. No `ALTER`/backfill moves into `init-db.js`; `init-pi-bots.mjs` keeps the JSON→column `project_id` backfill + prod-bot guard.

- [ ] **Step 1: Write the failing test**

Create `tests/init-db-bot-tables.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "f3-initdb-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Run the real init-db.js against a throwaway data dir.
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const db = new Database(join(dir, "crow.db"), { readonly: true });
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test("pi_bot_defs exists with project_id column", () => {
  assert.ok(cols("pi_bot_defs").includes("project_id"));
});

test("bot_sessions exists with model + escalated columns", () => {
  const c = cols("bot_sessions");
  assert.ok(c.includes("model"));
  assert.ok(c.includes("escalated"));
});

test("bot_skill_events exists with action column", () => {
  assert.ok(cols("bot_skill_events").includes("action"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/init-db-bot-tables.test.js`
Expected: FAIL — `no such table: pi_bot_defs` (tables not yet in init-db.js).

- [ ] **Step 3: Append the DDL to `init-db.js`**

In `scripts/init-db.js`, immediately **after** the `await initTable("job_search_sites table", …)` block and **before** the final `console.log("Database initialized successfully (local file)")`, insert:

```js
// --- Bot Builder tables (F3: moved from scripts/init-pi-bots.mjs) ---
// Full current shape: pi_bot_defs.project_id and bot_sessions.model/escalated
// are in the CREATE body here (init-pi-bots.mjs adds them via guarded ALTER on
// pre-F3 DBs). CREATE ... IF NOT EXISTS — a no-op on the live MPA crow.db.
// init-pi-bots.mjs remains the MPA-only JSON->column project_id backfill + guard.
await initTable("pi_bot_defs table", `
  CREATE TABLE IF NOT EXISTS pi_bot_defs (
    bot_id        TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    definition    TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    project_id    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pi_bot_defs_enabled ON pi_bot_defs (enabled);
  CREATE INDEX IF NOT EXISTS idx_pi_bot_defs_project ON pi_bot_defs (project_id);
`);

await initTable("bot_sessions table", `
  CREATE TABLE IF NOT EXISTS bot_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id            TEXT NOT NULL,
    pi_session_id     TEXT,
    pi_session_dir    TEXT,
    gateway_type      TEXT,
    gateway_thread_id TEXT,
    project_id        INTEGER,
    card_id           INTEGER,
    plan_path         TEXT,
    status            TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','waiting-user','stopped','done','error')),
    control           TEXT NOT NULL DEFAULT 'run'
                        CHECK (control IN ('run','stop')),
    model             TEXT,
    escalated         INTEGER DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bot_sessions_bot_thread
    ON bot_sessions (bot_id, gateway_thread_id);
  CREATE INDEX IF NOT EXISTS idx_bot_sessions_status
    ON bot_sessions (status);
`);

await initTable("bot_skill_events table", `
  CREATE TABLE IF NOT EXISTS bot_skill_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id      TEXT NOT NULL,
    skill_name  TEXT NOT NULL,
    action      TEXT NOT NULL
                  CHECK (action IN ('propose','create','patch','reject','downgrade')),
    mode        TEXT,
    model       TEXT,
    flags_json  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bot_skill_events_bot_skill
    ON bot_skill_events (bot_id, skill_name);
  CREATE INDEX IF NOT EXISTS idx_bot_skill_events_bot_time
    ON bot_skill_events (bot_id, created_at);
`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/init-db-bot-tables.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add the cross-reference comment to `init-pi-bots.mjs`**

In `scripts/init-pi-bots.mjs`, change the top-of-file docblock opening (the line `* Creates the TWO NEW tables the Bot Builder owns. This is deliberately a`) by inserting a note directly **above** the `const DDL = [` line (around line 60):

```js
// F3 NOTE (2026-06-08): The CANONICAL DDL for these tables now lives in
// scripts/init-db.js (full shape, run on every instance init). This script is
// retained as the MPA-only maintenance path: the prod-bot guard above + the
// JSON->column project_id backfill below. Keep the CREATE bodies here in sync
// with init-db.js if either changes.
const DDL = [
```

(Replace the existing `const DDL = [` line with the comment block + that same line.)

- [ ] **Step 6: Verify init-pi-bots.mjs still parses**

Run: `node --check scripts/init-pi-bots.mjs`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add scripts/init-db.js scripts/init-pi-bots.mjs tests/init-db-bot-tables.test.js
git commit scripts/init-db.js scripts/init-pi-bots.mjs tests/init-db-bot-tables.test.js \
  -m "F3: move Bot Builder table DDL into core init-db.js"
git show --stat HEAD
```

- [ ] **Step 8: MPA no-op proof (manual, against a COPY — never the live DB)**

Run:
```bash
cp /home/kh0pp/.crow-mpa/data/crow.db /tmp/f3-mpa-copy.db
B="SELECT (SELECT count(*) FROM pi_bot_defs)||'/'||(SELECT count(*) FROM bot_sessions)||'/'||(SELECT count(*) FROM bot_skill_events)"
before=$(sqlite3 /tmp/f3-mpa-copy.db "$B")
CROW_DB_PATH=/tmp/f3-mpa-copy.db node scripts/init-db.js >/dev/null 2>&1
after=$(sqlite3 /tmp/f3-mpa-copy.db "$B")
echo "before=$before after=$after"; [ "$before" = "$after" ] && echo "NO-OP OK" || echo "MISMATCH"
```
Expected: `NO-OP OK` (row counts identical; init-db is idempotent on an existing MPA-shaped DB). Note: `init-db.js` derives its data dir from `CROW_DB_PATH` via `resolve(CROW_DB_PATH, "..")` (existing behavior at the top of the file), so it writes only to the copy. Delete `/tmp/f3-mpa-copy.db` after.

---

## Task 3: Swap hardcoded `~/.crow-mpa` DB paths in the pi-bots runtime modules

**Files:**
- Modify: `scripts/pi-bots/bridge.mjs:42,45`
- Modify: `scripts/pi-bots/bridge_tick.mjs:25`
- Modify: `scripts/pi-bots/tracker.mjs:18,19`
- Modify: `scripts/pi-bots/skill_promote.mjs:40`
- Modify: `scripts/pi-bots/skill_provenance.mjs:20`
- Modify: `scripts/pi-bots/model_resolver.mjs:60,165`
- Modify: `scripts/pi-bots/mcp_writer.mjs:329`
- Test: `tests/pi-bots-no-mpa-coupling.test.js`

**Pattern for every edit:** add (once per file, with the other imports) `import { botsDbPath, tasksDbPath } from "./instance-paths.mjs";` then replace each `process.env.CROW_DB_PATH || HOME + "/.crow-mpa/data/crow.db"` with `botsDbPath()`, and each `process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db"` with `tasksDbPath()`. `botsDbPath()` already honors `CROW_DB_PATH` first, so precedence is preserved; on the MPA gateway/service (env set) behavior is byte-identical.

- [ ] **Step 1: Write the failing regression test**

Create `tests/pi-bots-no-mpa-coupling.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MODULES = [
  "bridge.mjs", "bridge_tick.mjs", "tracker.mjs", "skill_promote.mjs",
  "skill_provenance.mjs", "model_resolver.mjs", "mcp_writer.mjs",
];

for (const m of MODULES) {
  test(`${m} has no hardcoded ~/.crow-mpa DB literal`, () => {
    const src = readFileSync(new URL(`../scripts/pi-bots/${m}`, import.meta.url), "utf8");
    assert.ok(!src.includes(".crow-mpa/data/crow.db"), `${m} still hardcodes crow.db`);
    assert.ok(!src.includes(".crow-mpa/data/tasks.db"), `${m} still hardcodes tasks.db`);
    assert.ok(src.includes("instance-paths.mjs"), `${m} must import the resolver`);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pi-bots-no-mpa-coupling.test.js`
Expected: FAIL — every module still contains the literal / lacks the import.

- [ ] **Step 3: Edit `bridge.mjs`**

Add to the import block (after line 33, `import { proposalsDir, … }` region — any spot among the `./` imports):
```js
import { botsDbPath, tasksDbPath } from "./instance-paths.mjs";
```
Replace line 42:
```js
const CROW_DB = botsDbPath();
```
Replace line 45:
```js
const TASKS_DB = tasksDbPath();
```

- [ ] **Step 4: Edit `bridge_tick.mjs`**

Add near its other imports:
```js
import { botsDbPath } from "./instance-paths.mjs";
```
Replace line 25 (the no-fallback literal) with:
```js
const CROW_DB = botsDbPath();
```

- [ ] **Step 5: Edit `tracker.mjs`**

Add near its imports:
```js
import { botsDbPath, tasksDbPath } from "./instance-paths.mjs";
```
Replace lines 18–19:
```js
const CROW_DB = botsDbPath();
const TASKS_DB = tasksDbPath();
```

- [ ] **Step 6: Edit `skill_promote.mjs`**

Add near its imports:
```js
import { botsDbPath } from "./instance-paths.mjs";
```
Replace line 40:
```js
const CROW_DB = botsDbPath();
```

- [ ] **Step 7: Edit `skill_provenance.mjs`**

Add near its imports:
```js
import { botsDbPath } from "./instance-paths.mjs";
```
Replace line 20:
```js
const CROW_DB = botsDbPath();
```

- [ ] **Step 8: Edit `model_resolver.mjs`**

Add near its imports:
```js
import { botsDbPath } from "./instance-paths.mjs";
```
Replace line 60 (inside its function — note the indentation) and line 165 (both are the same literal):
```js
    const CROW_DB = botsDbPath();
```
and
```js
  const CROW_DB = botsDbPath();
```
(Match each line's existing indentation.)

- [ ] **Step 9: Edit `mcp_writer.mjs`**

Add near its imports:
```js
import { botsDbPath } from "./instance-paths.mjs";
```
Replace line 329:
```js
  const CROW_DB = botsDbPath();
```
This is the per-bot `.mcp.json` minting path — `botsDbPath()` makes the generated block point pi at the resolved instance DB.

- [ ] **Step 10: Run the regression test**

Run: `node --test tests/pi-bots-no-mpa-coupling.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 11: Syntax-check every edited module**

Run:
```bash
for f in bridge bridge_tick tracker skill_promote skill_provenance model_resolver mcp_writer; do
  node --check scripts/pi-bots/$f.mjs && echo "$f OK"; done
```
Expected: seven `… OK` lines, no parse errors.

- [ ] **Step 12: Smoke-import the resolver-consuming modules under MPA-equivalent env**

Run:
```bash
CROW_DB_PATH=/home/kh0pp/.crow-mpa/data/crow.db node -e "
  import('./scripts/pi-bots/instance-paths.mjs').then(m => {
    console.log('db=', m.botsDbPath());
    console.log('tasks=', m.tasksDbPath());
    console.log('ws=', m.botsWorkspaceRoot());
  });
"
```
Expected: `db= /home/kh0pp/.crow-mpa/data/crow.db`, `tasks= /home/kh0pp/.crow-mpa/data/tasks.db`, `ws= /home/kh0pp/.crow-mpa/pi-bots` — i.e. byte-identical to the old MPA literals.

- [ ] **Step 13: Commit**

```bash
git add scripts/pi-bots/bridge.mjs scripts/pi-bots/bridge_tick.mjs scripts/pi-bots/tracker.mjs scripts/pi-bots/skill_promote.mjs scripts/pi-bots/skill_provenance.mjs scripts/pi-bots/model_resolver.mjs scripts/pi-bots/mcp_writer.mjs tests/pi-bots-no-mpa-coupling.test.js
git commit scripts/pi-bots/bridge.mjs scripts/pi-bots/bridge_tick.mjs scripts/pi-bots/tracker.mjs scripts/pi-bots/skill_promote.mjs scripts/pi-bots/skill_provenance.mjs scripts/pi-bots/model_resolver.mjs scripts/pi-bots/mcp_writer.mjs tests/pi-bots-no-mpa-coupling.test.js \
  -m "F3: resolve pi-bots DB/tasks paths per-instance (drop ~/.crow-mpa hardcoding)"
git show --stat HEAD
```

---

## Task 4: `bot-runtime-flag.js` helper + unit test

**Files:**
- Create: `servers/gateway/dashboard/panels/bot-runtime-flag.js`
- Test: `tests/bot-runtime-flag.test.js`

**Design note:** Mirrors the F1.3 `showMpaPresets`/`isMpaHost` pattern: read the local-only `feature_flags` blob, honor an explicit boolean `bot_runtime`, otherwise default to the auto-detected MPA host (the only place the runtime actually runs in Phase a). `feature_flags` is absent from `sync-allowlist.js`, so it never replicates — genuinely per-instance.

- [ ] **Step 1: Write the failing test**

Create `tests/bot-runtime-flag.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { botRuntimeActive } from "../servers/gateway/dashboard/panels/bot-runtime-flag.js";

// Minimal db stub: readSetting() does SELECT ... FROM dashboard_settings_overrides
// then dashboard_settings. Return our feature_flags value for both lookups.
function dbWith(flagsValue) {
  return {
    async execute({ sql }) {
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/dashboard_settings/.test(sql)) {
        return { rows: flagsValue == null ? [] : [{ value: flagsValue }] };
      }
      return { rows: [] };
    },
  };
}

test("explicit bot_runtime:true wins regardless of host", async () => {
  delete process.env.CROW_HOME; delete process.env.CROW_DATA_DIR;
  assert.equal(await botRuntimeActive(dbWith(JSON.stringify({ bot_runtime: true }))), true);
});

test("explicit bot_runtime:false wins", async () => {
  process.env.CROW_DATA_DIR = "/home/kh0pp/.crow-mpa/data"; // would otherwise be true
  assert.equal(await botRuntimeActive(dbWith(JSON.stringify({ bot_runtime: false }))), false);
  delete process.env.CROW_DATA_DIR;
});

test("no flag -> defaults to MPA host detection (general instance = false)", async () => {
  delete process.env.CROW_HOME; delete process.env.CROW_DATA_DIR;
  assert.equal(await botRuntimeActive(dbWith(null)), false);
});

test("no flag -> MPA host = true", async () => {
  process.env.CROW_HOME = "/home/kh0pp/.crow-mpa";
  assert.equal(await botRuntimeActive(dbWith(null)), true);
  delete process.env.CROW_HOME;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-runtime-flag.test.js`
Expected: FAIL — `Cannot find module '.../bot-runtime-flag.js'`.

- [ ] **Step 3: Write the implementation**

Create `servers/gateway/dashboard/panels/bot-runtime-flag.js`:

```js
/**
 * Bot runtime indicator (F3). Local-only (non-synced) signal for whether the
 * bot RUNTIME (Gmail/Telegram/Discord gateways + timers) runs on this instance.
 * Phase a: definitions work everywhere, runtime is MPA-only — so the panel
 * shows an honest "runtime not active here" banner when this returns false.
 *
 * Mirrors the F1.3 feature_flags pattern: explicit boolean wins, else default
 * to the auto-detected MPA host. feature_flags is absent from sync-allowlist.js
 * so it never replicates (genuinely per-instance).
 */
import { readSetting } from "../settings/registry.js";

/** Auto-detect the MPA host from its data-dir convention (~/.crow-mpa). */
function isMpaHost() {
  const probe = `${process.env.CROW_HOME || ""}|${process.env.CROW_DATA_DIR || ""}`;
  return /\.crow-mpa(\/|\b|$)/.test(probe);
}

export async function botRuntimeActive(db) {
  let flags = {};
  try {
    const raw = await readSetting(db, "feature_flags");
    if (raw) flags = JSON.parse(raw) || {};
  } catch { /* ignore malformed flags */ }
  if (typeof flags.bot_runtime === "boolean") return flags.bot_runtime;
  return isMpaHost();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bot-runtime-flag.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/panels/bot-runtime-flag.js tests/bot-runtime-flag.test.js
git commit servers/gateway/dashboard/panels/bot-runtime-flag.js tests/bot-runtime-flag.test.js \
  -m "F3: bot_runtime local feature-flag helper for the panel indicator"
git show --stat HEAD
```

---

## Task 5: Wire the panels — path swaps, reframed notAvail, runtime banner

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder.js` (imports, `:55`, `:285`, notAvail render `:661-668`)
- Modify: `servers/gateway/dashboard/panels/bot-board.js` (imports, notAvail render `:389-396`)

**Design note:** No new test file — the gating decision is unit-tested via `botRuntimeActive` (Task 4); this task is wiring + copy changes, verified by syntax check + an isolated-DB render smoke. The panels must never throw (shared `dashboard/index.js`).

- [ ] **Step 1: `bot-builder.js` — add imports**

After the existing `import { skillDirs } …` group (near line 47), add:
```js
import { tasksDbPath, botsWorkspaceRoot } from "../../../../scripts/pi-bots/instance-paths.mjs";
import { join as pathJoin } from "node:path";
import { botRuntimeActive } from "./bot-runtime-flag.js";
```

- [ ] **Step 2: `bot-builder.js` — replace the hardcoded TASKS_DB (line 55)**

Replace:
```js
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || HOME + "/.crow-mpa/data/tasks.db";
```
with:
```js
const TASKS_DB = tasksDbPath();
```

- [ ] **Step 3: `bot-builder.js` — replace the session dir (line 285)**

Inside `defaultDefinition`, replace:
```js
  const sessionDir = `${HOME}/.crow-mpa/pi-bots/${botId}`;
```
with:
```js
  const sessionDir = pathJoin(botsWorkspaceRoot(), botId);
```

- [ ] **Step 4: `bot-builder.js` — reframe the notAvail render + add the banner**

Replace the whole `if (notAvail) { … }` block (lines ~661–668) with:
```js
    if (notAvail) {
      return res.send(layout({
        title: "Bot Builder",
        content: section("Bot Builder",
          `<p>The Bot Builder tables are not initialized on this instance.</p>` +
          `<p>Run <code>npm run init-db</code> on the host whose crow.db this gateway uses, then reload.</p>`),
      }));
    }

    const runtimeActive = await botRuntimeActive(db);
    const runtimeBanner = runtimeActive ? "" :
      `<p class="btb-notice-warn">Bot definitions are stored on this instance. ` +
      `The bot runtime (Gmail/Telegram/Discord gateways) is enabled per-instance and is not active here yet.</p>`;
```

- [ ] **Step 5: `bot-builder.js` — surface the banner in the page**

Find the line that builds the combined notice (around line 678):
```js
    const notice = baseNotice + warnNotice;
```
Replace with:
```js
    const notice = runtimeBanner + baseNotice + warnNotice;
```

- [ ] **Step 6: `bot-board.js` — add imports**

Near the top imports of `bot-board.js`, add:
```js
import { botRuntimeActive } from "./bot-runtime-flag.js";
```

- [ ] **Step 7: `bot-board.js` — reframe the notAvail render**

Replace the `if (notAvail) { … }` block (lines ~389–396) with:
```js
    if (notAvail) {
      return layout({
        title: "Bot Board",
        content: section("Bot Board",
          `<p>The Bot Builder tables (<code>pi_bot_defs</code> / <code>bot_sessions</code>) are not initialized on this instance.</p>` +
          `<p>Run <code>npm run init-db</code> on the host whose crow.db this gateway uses, then reload.</p>`),
      });
    }
```

- [ ] **Step 8: `bot-board.js` — inject the runtime note into the shared `notice`**

`bot-board.js` threads one `notice` variable (built from `noticeBits`) through every render path. Inject the runtime note there so it shows in all views. Replace line 442:
```js
    const notice = noticeBits.join("");
```
with:
```js
    if (!(await botRuntimeActive(db))) {
      noticeBits.unshift(`<p class="bb-msg">Bot runtime is not active on this instance — board reflects definitions only.</p>`);
    }
    const notice = noticeBits.join("");
```
(`db` is in scope; the `notAvail` early-return above guarantees the tables exist by here.)

- [ ] **Step 9: Syntax-check both panels**

Run:
```bash
node --check servers/gateway/dashboard/panels/bot-builder.js && echo "bot-builder OK"
node --check servers/gateway/dashboard/panels/bot-board.js && echo "bot-board OK"
```
Expected: both `… OK`.

- [ ] **Step 10: Isolated-DB render smoke (both branches)**

Run this against a throwaway DB to confirm (a) the panel renders the editor + the runtime banner on a general instance, and (b) the banner disappears with `bot_runtime:true`:

```bash
TMP=$(mktemp -d)
CROW_DATA_DIR=$TMP node scripts/init-db.js >/dev/null 2>&1
node --input-type=module -e "
import panel from './servers/gateway/dashboard/panels/bot-builder.js';
import { createDbClient } from './servers/db.js';
process.env.CROW_DATA_DIR='$TMP';
const db = createDbClient();
const layout = ({content}) => content;
let out='';
const res = { send:(h)=>{out=h;}, redirectAfterPost:()=>{} };
await panel.handler({ method:'GET', query:{}, body:{} }, res, { db, layout });
console.log('general-instance banner present:', out.includes('not active here yet'));
await db.execute({ sql:\"INSERT INTO dashboard_settings(key,value) VALUES('feature_flags', ?)\", args:[JSON.stringify({bot_runtime:true})] });
let out2='';
const res2 = { send:(h)=>{out2=h;}, redirectAfterPost:()=>{} };
await panel.handler({ method:'GET', query:{}, body:{} }, res2, { db, layout });
console.log('runtime-on banner suppressed:', !out2.includes('not active here yet'));
"
rm -rf "$TMP"
```
Expected: `general-instance banner present: true` and `runtime-on banner suppressed: true`. (If `createDbClient` needs `CROW_DB_PATH`, export `CROW_DB_PATH=$TMP/crow.db` alongside `CROW_DATA_DIR`.)

- [ ] **Step 11: Commit**

```bash
git add servers/gateway/dashboard/panels/bot-builder.js servers/gateway/dashboard/panels/bot-board.js
git commit servers/gateway/dashboard/panels/bot-builder.js servers/gateway/dashboard/panels/bot-board.js \
  -m "F3: panel path resolution + reframe off-MPA gating + runtime indicator"
git show --stat HEAD
```

---

## Task 6: Write the Phase b handoff doc

**Files:**
- Create: `~/.claude/plans/F3b-bot-runtime-distribution-handoff.md`

- [ ] **Step 1: Write the handoff**

Create `/home/kh0pp/.claude/plans/F3b-bot-runtime-distribution-handoff.md` with this content:

```markdown
# Handoff — F3b: distribute the Bot Builder *runtime* to any instance

**Written:** 2026-06-08 · Follows F3 Phase a (`feat/f3-bot-builder-core`).

## Where Phase a left it
- Bot Builder tables are core (`scripts/init-db.js`); every instance gets them on init.
- All pi-bots DB/tasks/workspace paths resolve per-instance via
  `scripts/pi-bots/instance-paths.mjs` (anchors on `CROW_DB_PATH`, else `resolveDataDir()`).
- Panels (`bot-builder.js`, `bot-board.js`) render everywhere; show a
  `feature_flags.bot_runtime` indicator ("runtime not active here") — the seam
  to grab. `botRuntimeActive(db)` lives in `panels/bot-runtime-flag.js`.
- Runtime is still MPA-only: `pibot-gateways.service`, the Gmail tick
  (`bridge_tick.mjs`), and Discord gateway exist only on the MPA host.

## Phase b goal
Let an opted-in instance actually RUN bots end-to-end.

## Work
1. Parameterize the systemd units per instance — `pibot-gateways@.service`
   template (or gateway-startup hooks) with per-instance `CROW_DB_PATH`/`CROW_HOME`;
   decouple `After=crow-mpa-gateway.service`. Same for a Gmail-tick timer + Discord.
2. Wire `feature_flags.bot_runtime` (and likely a writable Settings toggle) to
   actually start/stop the runtime on that instance — flip from indicator to control.
3. Per-instance opt-in so no instance spontaneously starts polling.

## Hazards (read before touching prod)
- **Multi-gateway crow.db lock** — memory `grackle-multi-gateway-crowdb-lock`:
  extra gateways' MCP children leaking onto a shared crow.db crash-loop the
  dashboard on "database is locked". Distributing the runtime multiplies these
  consumers. Mitigate before scaling out.
- **Prod-safety** — instantiating/restarting units on live hosts degrades prod;
  short attended windows, verify-after (global rule).
- **3 live MPA bots** — renaming `pibot-gateways.service` to `@.service` is a
  stop/replace on a unit running real Maestro-Press bots. Plan a clean cutover.

## Deliberately MPA-pinned (left untouched in Phase a — revisit if needed)
`scripts/pi-bots/bridge_gmail_e2e.mjs`, `slicec_e2e.mjs`, `slicec_api_e2e.mjs`,
`p3_0_e2e.mjs`, `s2_setup.sh`, `mcp.json.s0` — MPA-targeted test fixtures with
intentional `~/.crow-mpa` literals.
```

- [ ] **Step 2: Confirm it was written**

Run: `head -5 /home/kh0pp/.claude/plans/F3b-bot-runtime-distribution-handoff.md`
Expected: the title line prints. (This file is outside the repo — not committed.)

---

## Task 7: Final invariant verification + full test sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the network-exposure + mesh invariants**

Run:
```bash
node tests/auth-network.test.js
node tests/nest-mesh.test.js
```
Expected: both green (no regression; no new routes added).

- [ ] **Step 2: Run the full F3 test set**

Run:
```bash
node --test tests/pi-bots-instance-paths.test.js tests/init-db-bot-tables.test.js tests/pi-bots-no-mpa-coupling.test.js tests/bot-runtime-flag.test.js
```
Expected: all pass.

- [ ] **Step 3: Confirm the branch diff is scoped**

Run: `git diff --stat main...feat/f3-bot-builder-core`
Expected: only the files listed in the File Structure table (plus the spec from the brainstorming commit). No stray files.

- [ ] **Step 4: (Deploy is a separate attended step — do NOT auto-run)**

Deployment (merge via GitHub MCP, `git pull --ff-only` + `npm run init-db` on both crow instances and grackle, restart `crow-gateway` + `crow-mpa-gateway`) is attended per the spec's Deploy section and the global prod-safety rule. Stop here and hand back for the deploy decision.

---

## Self-Review

**Spec coverage:**
- Schema to core (full shape, no-op on MPA) → Task 2. ✓
- `init-pi-bots.mjs` kept as legacy backfill + cross-ref → Task 2 Steps 5–6. ✓
- Per-instance path resolution (helper + 7 modules + panel) → Tasks 1, 3, 5. ✓
- `mcp_writer` minting uses resolved path → Task 3 Step 9. ✓
- Panel gating reframe (both panels) + never-throw → Task 5. ✓
- `feature_flags.bot_runtime` indicator → Tasks 4, 5. ✓
- Tests: instance-paths, schema parity, MPA no-op-on-copy, panel render, invariants → Tasks 1,2,5,7. ✓
- F3b handoff doc + MPA-pinned fixtures list → Task 6. ✓
- Out-of-scope (runtime distribution, e2e fixtures, migration runner, panel-registry hook) honored. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are concrete, including the `bot-board.js` injection point (pinned to line 442's `noticeBits.join("")`, which threads through every render path). Task 5 Step 10's render smoke notes a possible `CROW_DB_PATH` export if `createDbClient` requires it — the one environment-dependent fallback, explicitly stated.

**Type consistency:** `botsDbPath`/`tasksDbPath`/`botsWorkspaceRoot` (Task 1) used identically in Tasks 3, 5. `botRuntimeActive(db)` (Task 4) used in Task 5. `readSetting(db, key)` signature matches `registry.js:142`. Table/column names match `init-pi-bots.mjs` DDL exactly.
