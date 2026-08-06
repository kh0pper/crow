# Safe Rolling Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every co-hosted crow gateway converge itself to the shared checkout — running its own migrations with its own env and verifying its own health — instead of one instance winning a lock and the others silently starving.

**Architecture:** Split the auto-updater's single operation into `updateTree()` (checkout-scoped, one winner, does the pull) and `convergeInstance()` (per-instance, no lock, always runs). A file-based ordered migration registry runs at gateway boot for the booting instance's own stores. A boot cookie carries a pre-convergence health baseline across the restart; the new boot compares against it and, on regression, quarantines that sha so peers never converge to it. The shared git tree is never mutated by a health failure.

**Tech Stack:** Node 22 (ABI 127) ESM, `better-sqlite3` for raw short-lived migration handles, node built-in test runner, bash for the Phase 1 deploy script.

## Global Constraints

- **Node 22 on every invocation:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`. Default `node` on crow is v20 — `better-sqlite3` is built for 22 and a v20 run fails `NODE_MODULE_VERSION 127 vs 115`.
- **`~/crow` stays on `main` always.** All work happens in the worktree `/home/kh0pp/crow-wt-rolling` on branch `feat/safe-rolling-updates` (already created, `node_modules` symlinked to `~/crow/node_modules`).
- **Positional-path commits:** `git commit <path> -m "..."`, never `git add .` then a bare commit. Verify with `git show --stat HEAD` after every commit.
- **NEVER attribute Claude** as author, co-author, or contributor on any commit or PR.
- **PR flow only** — `enforce_admins` is TRUE. Green check-runs (`suite`, `static-checks`, `audit`) queried via `https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` before merge. Never the legacy commit-status API.
- **No `SCHEMA_GENERATION` bump in this work.** `schema_migrations` is created lazily by the runner, never added to `scripts/init-db.js`.
- **Never open a running gateway's `crow.db` with an external sqlite3 client.** Copy the `.db` plus `-wal` and `-shm`, query the copy.
- **`scripts/init-db.js` without `CROW_DATA_DIR` writes the LIVE `~/.crow/data/crow.db`.** Pin `CROW_HOME`, `CROW_DATA_DIR`, and `CROW_DB_PATH` on every out-of-gateway invocation.
- **Test runs are foregrounded with direct file capture** (`npm test > log 2>&1`). Piping a background run through `tail` produced 0-byte logs twice in the P2 arc.
- **Baseline is 2961 tests / 2961 pass / 0 fail** (verified on this worktree, node v22.23.1). Any deviation is yours.
- **Coordination:** `pibot-gateways@r4` is mid-soak from the `~/crow` working tree through ~2026-08-12. Log a timestamp for every `~/crow` pull touching `scripts/pi-bots/` and every restart of that unit. Keep `bridge.mjs`'s exported surface name-stable. Do not touch `~/crow-wt-board` or `~/.crow/p4/harness-wt`.

---

## File Structure

**Part 1 — Phase 1 (separate repo, no crow changes, uncommitted):**
- Create: `/home/kh0pp/r4-tehcy/scripts/r4-deploy.sh` — supervised r4 deploy: pull, deps, migrations with explicit r4 env, bundle diff-sync, native rebuild, restart, health gate.

**Part 2 — PR A (migration registry):**
- Create: `scripts/migrations/runner.mjs` — discovery, ordering, `schema_migrations` bookkeeping, execution.
- Create: `scripts/migrations/0001-board-stages.mjs` — the first registry entry.
- Modify: `scripts/migrate-board-stages.mjs` — becomes a thin wrapper delegating to the registry entry.
- Modify: `servers/gateway/index.js` — run the registry after the schema guard, before the first `createDbClient`.
- Create: `tests/migration-registry.test.js`

**Part 3 — PR B (converge + health gate):**
- Create: `servers/gateway/convergence.js` — boot-sha capture, health snapshot comparison, boot cookie, `convergeInstance()`.
- Modify: `servers/gateway/proxy.js` — export `healthSnapshot()`.
- Modify: `servers/gateway/auto-update.js` — split `updateTree()`/`convergeInstance()`, record real HEAD before the disabled return, jitter the first check.
- Modify: `servers/shared/migration-guard.js` — `reason` field + `attemptsKey` on quarantine markers.
- Modify: `servers/gateway/boot/post-listen.js` — boot-cookie verification hook.
- Create: `tests/convergence-two-instance.test.js` — the executable gate.
- Create: `tests/convergence-unit.test.js`
- Modify: `docs/architecture/gateway.md` — document convergence + the kill switch.

---

## Part 1 — Phase 1: `r4-deploy.sh`

### Task 1: Deploy script with dry-run

**Files:**
- Create: `/home/kh0pp/r4-tehcy/scripts/r4-deploy.sh`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a script invoked as `r4-deploy.sh [--dry-run] [REF]`. Exit 0 = PASS, non-zero = FAIL. Nothing in Part 2 or 3 depends on it.

- [ ] **Step 1: Write the script skeleton with env pinning and dry-run**

```bash
#!/usr/bin/env bash
# Supervised deploy for the crow-r4 instance from the shared ~/crow checkout.
# Usage: r4-deploy.sh [--dry-run] [REF]
set -Eeuo pipefail

CROW_REPO=/home/kh0pp/crow
NODE_BIN=/home/kh0pp/.nvm/versions/node/v22.23.1/bin
export PATH="$NODE_BIN:$PATH"

# Explicit r4 env — every out-of-gateway spawn MUST carry all three, or the
# child silently resolves to the PRIMARY instance's ~/.crow/data/crow.db.
export CROW_HOME=/home/kh0pp/.crow-r4
export CROW_DATA_DIR=/home/kh0pp/.crow-r4/data
export CROW_DB_PATH=/home/kh0pp/.crow-r4/data/crow.db

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && { DRY_RUN=1; shift; }
REF="${1:-}"

PREV_COMMIT=$(git -C "$CROW_REPO" rev-parse HEAD)
FAILED_CHECK=""

log()  { printf '[r4-deploy %s] %s\n' "$(date -Is)" "$*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then log "DRY: $*"; else log "RUN: $*"; "$@"; fi; }
fail() { FAILED_CHECK="$1"; log "FAIL: $1"; log "Roll back with: git -C $CROW_REPO reset --hard $PREV_COMMIT"; exit 1; }

log "starting; previous commit $PREV_COMMIT; dry_run=$DRY_RUN"
```

- [ ] **Step 2: Verify node pinning is correct before going further**

Run: `bash -c 'export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH; node -v'`
Expected: `v22.23.1` — NOT v20.x. If v20, stop; every later step is invalid.

- [ ] **Step 3: Add steps 1-2 (pull, conditional deps) with the pi-bots soak log line**

```bash
# --- 1. pull ---------------------------------------------------------------
LOCK_BEFORE=$(md5sum "$CROW_REPO/package-lock.json" | cut -d' ' -f1)
if [ -n "$REF" ]; then
  run git -C "$CROW_REPO" checkout "$REF"
else
  run git -C "$CROW_REPO" pull --ff-only || fail "git pull --ff-only"
fi
NEW_COMMIT=$(git -C "$CROW_REPO" rev-parse HEAD)
log "now at $NEW_COMMIT"

# Soak coordination: pibot-gateways@r4 runs from this working tree through
# ~2026-08-12. Any pull touching scripts/pi-bots/ can produce a heartbeat gap;
# this line is what makes that gap explainable afterwards.
if git -C "$CROW_REPO" diff --name-only "$PREV_COMMIT..$NEW_COMMIT" | grep -q '^scripts/pi-bots/'; then
  log "NOTE: this pull touched scripts/pi-bots/ — pibot-gateways@r4 soak may show a heartbeat gap here"
fi

# --- 2. deps (only if the lockfile actually changed) ------------------------
LOCK_AFTER=$(md5sum "$CROW_REPO/package-lock.json" | cut -d' ' -f1)
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  log "lockfile changed — installing"
  (cd "$CROW_REPO" && run npm ci --omit=dev) || fail "npm ci"
else
  log "lockfile unchanged — skipping npm ci"
fi
```

- [ ] **Step 4: Add step 3 (migrations) with the both-DB guard**

```bash
# --- 3. migrations, explicit r4 env ----------------------------------------
# Baseline the PRIMARY instance's stores. They must not change: a migration
# that silently targeted ~/.crow instead of ~/.crow-r4 is the exact failure
# mode this guard exists to catch.
PRIMARY_BEFORE=$(md5sum /home/kh0pp/.crow/data/crow.db /home/kh0pp/.crow/data/tasks.db 2>/dev/null || true)

run node "$CROW_REPO/scripts/init-db.js"              || fail "init-db.js"
for m in "$CROW_REPO"/scripts/migrate-*.mjs; do
  case "$(basename "$m")" in
    migrate-data-dir.js|migrate-redirect-303.js) continue ;;  # one-shot legacy / codemod
  esac
  run node "$m" || fail "$(basename "$m")"
done

PRIMARY_AFTER=$(md5sum /home/kh0pp/.crow/data/crow.db /home/kh0pp/.crow/data/tasks.db 2>/dev/null || true)
if [ "$DRY_RUN" = 0 ] && [ "$PRIMARY_BEFORE" != "$PRIMARY_AFTER" ]; then
  fail "PRIMARY instance DBs changed during an r4 migration run — env leak, investigate before restarting anything"
fi
```

- [ ] **Step 5: Add step 4 (bundle + panel diff-sync, changed files only)**

```bash
# --- 4. bundle + panel diff-sync -------------------------------------------
# NEVER rsync --delete: knowledge-base's server/db.js and server/app-root.js
# are deliberately per-instance. Changed files only, then report.
for bdir in "$CROW_HOME"/bundles/*/; do
  id=$(basename "$bdir")
  src="$CROW_REPO/bundles/$id"
  [ -d "$src" ] || { log "bundle $id: no repo source, skipping"; continue; }
  run rsync -rc --exclude node_modules --exclude data --exclude '*.db' \
      "$src/" "$bdir" || fail "bundle sync $id"
done

for p in "$CROW_HOME"/panels/*.js; do
  [ -e "$p" ] || continue
  name=$(basename "$p")
  src=$(find "$CROW_REPO/bundles" -name "$name" -path '*/panel*' -print -quit 2>/dev/null || true)
  [ -n "$src" ] && run rsync -c "$src" "$p"
done
```

- [ ] **Step 6: Run the dry-run and read every line**

Run: `bash /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh --dry-run`
Expected: exits 0, prints `DRY:` for every mutating command, and prints the real current commit. Confirm no `RUN:` line appears for a mutating command. If any mutating command executed under `--dry-run`, fix before continuing — the next task runs this for real against a live instance.

- [ ] **Step 7: Commit — NOT to git**

The r4-tehcy repo belongs to another workstream. Leave the file uncommitted and note it on card #120 (Task 14). Verify only that it is executable:

```bash
chmod +x /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh
ls -l /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh
```

### Task 2: Native rebuild, restart, and health gate

**Files:**
- Modify: `/home/kh0pp/r4-tehcy/scripts/r4-deploy.sh`

**Interfaces:**
- Consumes: Task 1's script (the `run`/`fail`/`log` helpers and `PREV_COMMIT`).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add step 5 (native ABI rebuild, test-loaded)**

```bash
# --- 5. native modules must match the gateway's node (ABI 127) -------------
for nb in tasks bots-sql-mcp; do
  nbdir="$CROW_HOME/bundles/$nb"
  [ -d "$nbdir/node_modules/better-sqlite3" ] || continue
  if ! "$NODE_BIN/node" -e "require('$nbdir/node_modules/better-sqlite3')" 2>/dev/null; then
    log "$nb: better-sqlite3 ABI mismatch — rebuilding with the v22 npm"
    (cd "$nbdir" && run "$NODE_BIN/npm" rebuild better-sqlite3) || fail "rebuild $nb"
    "$NODE_BIN/node" -e "require('$nbdir/node_modules/better-sqlite3')" \
      || fail "$nb still fails to load after rebuild"
  else
    log "$nb: better-sqlite3 loads under node 22"
  fi
done
```

- [ ] **Step 2: Add step 6 (restart) and capture the restart timestamp**

```bash
# --- 6. restart -------------------------------------------------------------
RESTART_AT=$(date -Is)
run sudo systemctl restart crow-r4-gateway || fail "systemctl restart"
[ "$DRY_RUN" = 1 ] || sleep 20   # let addons attempt their connects (proxy CONNECT_TIMEOUT_MS is 60s)
```

- [ ] **Step 3: Add step 7 (health gate)**

```bash
# --- 7. health gate ---------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then log "DRY: skipping health gate"; log "PASS (dry-run)"; exit 0; fi

systemctl is-active --quiet crow-r4-gateway || fail "unit not active"

JOURNAL=$(journalctl -u crow-r4-gateway --since "$RESTART_AT" --no-pager 2>/dev/null || true)
if echo "$JOURNAL" | grep -q "failed to connect"; then
  echo "$JOURNAL" | grep "failed to connect"
  fail "at least one addon failed to connect"
fi
for a in tasks bots-sql-mcp pm-workspace knowledge-base knowledge-base-mcp; do
  echo "$JOURNAL" | grep -q "addon $a: connected" || fail "addon $a never reported connected"
done

code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3008/s/family/)
[ "$code" = "200" ] || fail "smoke route /s/family/ returned $code"

log "PASS — r4 on $(git -C "$CROW_REPO" rev-parse --short HEAD), all addons connected, smoke route 200"
```

- [ ] **Step 4: Dry-run again end to end**

Run: `bash /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh --dry-run`
Expected: exit 0, ends with `PASS (dry-run)`. No `sudo` executed, no restart.

- [ ] **Step 5: Real supervised run in a tight window**

Announce the window first (two other workstreams restart this gateway). Then:

Run: `bash /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh 2>&1 | tee /tmp/r4-deploy-first.log`
Expected: exit 0, final line `PASS`. If FAIL, the script prints the failing check and the rollback command — roll back and do not leave r4 on unverified code.

- [ ] **Step 6: Verify the primary instance was untouched**

```bash
ls -l /home/kh0pp/.crow/data/crow.db /home/kh0pp/.crow/data/tasks.db
```
Expected: mtimes unchanged by the deploy. This is the both-DB check the standing rule requires.

---

## Part 2 — PR A: migration registry

### Task 3: Registry runner

**Files:**
- Create: `scripts/migrations/runner.mjs`
- Test: `tests/migration-registry.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `runMigrations({ migrationsDir, dbPath, tasksDbPath, log }) → Promise<{ applied: string[], skipped: string[] }>`
  - `discoverMigrations(migrationsDir) → string[]` (sorted absolute paths)
  - Each migration module exports `id: string` and `run({ dbPath, tasksDbPath, log }): void | Promise<void>`.
  - Bookkeeping table `schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)` in the crow.db at `dbPath`, created lazily.

- [ ] **Step 1: Write the failing test**

```js
// tests/migration-registry.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations, discoverMigrations } from "../scripts/migrations/runner.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "migreg-"));
  const dir = join(root, "migrations");
  mkdirSync(dir);
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");
  new Database(dbPath).close();
  new Database(tasksDbPath).close();
  return { root, dir, dbPath, tasksDbPath };
}

function writeMigration(dir, name, body) {
  writeFileSync(join(dir, name), body);
}

test("runs migrations in filename order and records them", async () => {
  const f = fixture();
  try {
    // Migration bodies are real ESM modules — record order via a shared file.
    const orderFile = join(f.root, "order.txt");
    writeMigration(f.dir, "0001-first.mjs",
      `import { appendFileSync } from "node:fs";
       export const id = "0001-first";
       export function run() { appendFileSync(${JSON.stringify(orderFile)}, "first\\n"); }`);
    writeMigration(f.dir, "0002-second.mjs",
      `import { appendFileSync } from "node:fs";
       export const id = "0002-second";
       export function run() { appendFileSync(${JSON.stringify(orderFile)}, "second\\n"); }`);

    const res = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.deepEqual(res.applied, ["0001-first", "0002-second"]);

    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(orderFile, "utf8"), "first\nsecond\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("is idempotent — a second run applies nothing", async () => {
  const f = fixture();
  try {
    const hits = join(f.root, "hits.txt");
    writeMigration(f.dir, "0001-once.mjs",
      `import { appendFileSync } from "node:fs";
       export const id = "0001-once";
       export function run() { appendFileSync(${JSON.stringify(hits)}, "x"); }`);

    const a = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const b = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    assert.deepEqual(a.applied, ["0001-once"]);
    assert.deepEqual(b.applied, []);
    assert.deepEqual(b.skipped, ["0001-once"]);

    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(hits, "utf8"), "x", "migration body must run exactly once");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("creates schema_migrations lazily — never requires init-db", async () => {
  const f = fixture();
  try {
    writeMigration(f.dir, "0001-noop.mjs",
      `export const id = "0001-noop"; export function run() {}`);
    await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const db = new Database(f.dbPath);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    db.close();
    assert.ok(t, "runner must CREATE TABLE IF NOT EXISTS its own bookkeeping table");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ignores files that do not match the NNNN-slug.mjs pattern", () => {
  const f = fixture();
  try {
    writeMigration(f.dir, "0001-real.mjs", `export const id="0001-real"; export function run(){}`);
    writeMigration(f.dir, "README.md", "not a migration");
    writeMigration(f.dir, "helper.mjs", "export const x = 1;");
    writeMigration(f.dir, "0002-draft.mjs.bak", "stray");
    const found = discoverMigrations(f.dir).map((p) => p.split("/").pop());
    assert.deepEqual(found, ["0001-real.mjs"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a throwing migration aborts the rest and does not record itself", async () => {
  const f = fixture();
  try {
    writeMigration(f.dir, "0001-boom.mjs",
      `export const id = "0001-boom"; export function run() { throw new Error("boom"); }`);
    writeMigration(f.dir, "0002-after.mjs",
      `export const id = "0002-after"; export function run() {}`);

    await assert.rejects(
      () => runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath }),
      /boom/,
    );
    const db = new Database(f.dbPath);
    const rows = db.prepare("SELECT id FROM schema_migrations").all();
    db.close();
    assert.deepEqual(rows, [], "a failed migration must not be recorded, and 0002 must not run");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/migration-registry.test.js`
Expected: FAIL — `Cannot find module '../scripts/migrations/runner.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// scripts/migrations/runner.mjs
//
// Ordered, idempotent, per-instance migration registry.
//
// Bookkeeping lives in `schema_migrations` inside the instance's crow.db and is
// created lazily here — DELIBERATELY NOT in scripts/init-db.js. Adding a table
// there would bump SCHEMA_GENERATION, which re-runs all of init-db's DROP TABLE
// statements against every live instance DB. This registry must be able to ship
// without touching that rail at all.
//
// Migrations must ALSO be safe to run with their record missing (a restored
// backup can lose the record but keep the schema change), so every migration
// body stays shape-checked and idempotent in its own right.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const FILENAME = /^\d{4}-[a-z0-9-]+\.mjs$/;

/** Sorted absolute paths of every valid migration module in `dir`. */
export function discoverMigrations(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => FILENAME.test(n)).sort().map((n) => join(dir, n));
}

function open(p) {
  const d = new Database(p);
  d.pragma("busy_timeout = 10000");
  return d;
}

function ensureTable(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL,
       sha TEXT
     )`,
  ).run();
}

/**
 * Run every not-yet-applied migration, in order, against ONE instance's stores.
 * Throws on the first failure without recording it — the caller decides whether
 * that is fatal.
 */
export async function runMigrations({ migrationsDir, dbPath, tasksDbPath, sha = null, log = () => {} }) {
  const applied = [];
  const skipped = [];

  const book = open(dbPath);
  try {
    ensureTable(book);
    const done = new Set(book.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id));

    for (const file of discoverMigrations(migrationsDir)) {
      const mod = await import(pathToFileURL(file).href);
      if (!mod.id || typeof mod.run !== "function") {
        throw new Error(`${file}: a migration must export \`id\` and \`run\``);
      }
      if (done.has(mod.id)) { skipped.push(mod.id); continue; }

      log(`applying ${mod.id}`);
      await mod.run({ dbPath, tasksDbPath, log });

      book.prepare("INSERT INTO schema_migrations (id, applied_at, sha) VALUES (?, ?, ?)")
        .run(mod.id, new Date().toISOString(), sha);
      applied.push(mod.id);
    }
  } finally {
    book.close();
  }
  return { applied, skipped };
}
```

- [ ] **Step 4: Run the tests**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/migration-registry.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-test every assertion**

Assume these tests are vacuous until proven otherwise. Apply each mutation, confirm a test goes RED, then revert:

1. Delete the `if (done.has(mod.id))` line → the idempotence test must fail on the `"x"` assertion.
2. Change `.sort()` to `.reverse()` → the ordering test must fail.
3. Change `FILENAME` to `/\.mjs$/` → the stray-file test must fail.
4. Move the `INSERT INTO schema_migrations` above `await mod.run(...)` → the throwing-migration test must fail.
5. Remove `ensureTable(book)` → the lazy-creation test must fail.

If any mutation leaves all tests green, that assertion proves nothing — fix the test before continuing.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git add scripts/migrations/runner.mjs tests/migration-registry.test.js
git commit scripts/migrations/runner.mjs tests/migration-registry.test.js \
  -m "feat(migrations): ordered per-instance migration registry

Bookkeeping table is created lazily by the runner rather than in
init-db.js, so the registry ships without a SCHEMA_GENERATION bump."
git show --stat HEAD
```

### Task 4: Convert board-stages into the first registry entry

**Files:**
- Create: `scripts/migrations/0001-board-stages.mjs`
- Modify: `scripts/migrate-board-stages.mjs`
- Test: `tests/migration-registry.test.js` (append)

**Interfaces:**
- Consumes: `runMigrations` from Task 3.
- Produces: migration id `"0001-board-stages"`, and an exported helper `addColumnIfMissing(db, table, column, ddl) → "added"|"no-op"|"skip (<table> absent)"` reused by future entries.

- [ ] **Step 1: Write the failing test (append to the file)**

```js
test("0001-board-stages adds the columns, tolerates absent tables, and is idempotent", async () => {
  const f = fixture();
  try {
    // tasks.db HAS the table; crow.db does NOT have project_spaces/bot_sessions.
    const t = new Database(f.tasksDbPath);
    t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
    t.close();

    const dir = join(import.meta.dirname, "..", "scripts", "migrations");
    const res = await runMigrations({
      migrationsDir: dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
    });
    assert.ok(res.applied.includes("0001-board-stages"));

    const t2 = new Database(f.tasksDbPath);
    const cols = t2.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    t2.close();
    for (const c of ["stage", "assigned_bot", "plan_ref"]) {
      assert.ok(cols.includes(c), `tasks_items.${c} must exist`);
    }

    // Absent-table tolerance: crow.db had neither table and the run still succeeded.
    // Idempotence at the SHAPE level: re-run the module directly, record bypassed.
    const mod = await import(join(dir, "0001-board-stages.mjs"));
    await mod.run({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/migration-registry.test.js`
Expected: FAIL — no `0001-board-stages` in `applied`.

- [ ] **Step 3: Write the migration entry**

```js
// scripts/migrations/0001-board-stages.mjs
// Board–plan unification: guarded additive ALTERs. PRAGMA presence check,
// additive, idempotent, absent-table tolerant. SQLite ADD COLUMN never rebuilds
// the table, so existing CHECK constraints are unaffected.
import Database from "better-sqlite3";

export const id = "0001-board-stages";

export function addColumnIfMissing(db, table, column, ddl) {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!t) return `skip (${table} absent)`;
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (have.includes(column)) return "no-op";
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  return "added";
}

function open(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }

export function run({ dbPath, tasksDbPath, log = () => {} }) {
  const tdb = open(tasksDbPath);
  try {
    log(`  tasks_items.stage: ${addColumnIfMissing(tdb, "tasks_items", "stage", "TEXT")}`);
    log(`  tasks_items.assigned_bot: ${addColumnIfMissing(tdb, "tasks_items", "assigned_bot", "TEXT")}`);
    log(`  tasks_items.plan_ref: ${addColumnIfMissing(tdb, "tasks_items", "plan_ref", "TEXT")}`);
  } finally { tdb.close(); }

  const cdb = open(dbPath);
  try {
    log(`  project_spaces.repo_path: ${addColumnIfMissing(cdb, "project_spaces", "repo_path", "TEXT")}`);
    log(`  bot_sessions.kind: ${addColumnIfMissing(cdb, "bot_sessions", "kind", "TEXT NOT NULL DEFAULT 'chat'")}`);
  } finally { cdb.close(); }
}
```

- [ ] **Step 4: Rewrite the old script as a thin wrapper**

Phase 1 step 3 and any operator muscle memory still invoke this path, so it must keep working and must stay idempotent with the registry.

```js
// scripts/migrate-board-stages.mjs
// Thin wrapper — the migration itself now lives in the registry at
// scripts/migrations/0001-board-stages.mjs and runs automatically at gateway
// boot. This entry point stays for manual/deploy-script invocation.
import { tasksDbPath, botsDbPath } from "./pi-bots/instance-paths.mjs";
import { run } from "./migrations/0001-board-stages.mjs";

run({ dbPath: botsDbPath(), tasksDbPath: tasksDbPath(), log: (m) => console.log(m) });
```

- [ ] **Step 5: Run the tests, including the pre-existing board-stages test**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/migration-registry.test.js tests/board-stages-migration.test.js`
Expected: PASS. `tests/board-stages-migration.test.js` already exists and must not regress — if it asserts on the old script's internals, adapt the test to the wrapper, do not weaken the assertion.

- [ ] **Step 6: Mutation-test**

1. Change `addColumnIfMissing`'s `if (!t) return` to `if (!t) throw` → the absent-table tolerance assertion must fail.
2. Remove the `have.includes(column)` guard → the direct re-run at the end of the test must fail with "duplicate column name".

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git add scripts/migrations/0001-board-stages.mjs
git commit scripts/migrations/0001-board-stages.mjs scripts/migrate-board-stages.mjs tests/migration-registry.test.js \
  -m "feat(migrations): move board-stages into the registry as 0001

The old entry point becomes a thin wrapper so deploy scripts and manual
invocation keep working."
git show --stat HEAD
```

### Task 5: Run the registry at gateway boot

**Files:**
- Modify: `servers/gateway/index.js` (insert after the schema-guard block ending at line 195, before `await initOAuthTables()` at line 198)
- Test: `tests/migration-registry.test.js` (append)

**Interfaces:**
- Consumes: `runMigrations` from Task 3.
- Produces: the boot-time call site. Part 3 does not call it again — convergence relies on the restart passing through this block.

- [ ] **Step 1: Write the failing order-invariant test**

This mirrors the existing source-order assertion in `tests/migration-guard.test.js`. It is a source-text check because the invariant is about ordering within a module that cannot be imported without booting a gateway.

```js
test("ORDER INVARIANT: registry runs after the schema guard and before the first createDbClient", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "index.js"), "utf8");

  const guard = src.indexOf("runGuardedInitDb");
  const registry = src.indexOf("runMigrations");
  const firstClient = src.indexOf("initOAuthTables()");

  assert.ok(guard > 0, "schema guard must be present");
  assert.ok(registry > 0, "registry call must be present");
  assert.ok(firstClient > 0, "initOAuthTables must be present");
  assert.ok(guard < registry, "registry must run AFTER the schema guard");
  assert.ok(registry < firstClient,
    "registry must run BEFORE the first createDbClient — createDbClient registers a " +
    "never-closed WAL keeper, and a later restore would swap the DB under a pinned inode");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/migration-registry.test.js`
Expected: FAIL — "registry call must be present".

- [ ] **Step 3: Insert the call site**

Insert immediately after the schema-guard `try { ... } catch { ... }` block (which ends at line 195) and before `await initOAuthTables();`:

```js
// Per-instance migration registry (scripts/migrations/). Runs for THIS
// instance with THIS instance's env-resolved paths, so co-hosted gateways
// sharing one checkout each migrate their own stores. Covers changes that
// carry no SCHEMA_GENERATION bump — additive columns and non-crow.db stores
// like tasks.db — which the guard above deliberately does not.
//
// ORDER INVARIANT: after the schema guard, before the first createDbClient
// (initOAuthTables). See the guard block's note above; tests/migration-
// registry.test.js asserts this ordering.
try {
  const { runMigrations } = await import("../../scripts/migrations/runner.mjs");
  const { resolveDataDir } = await import("../db.js");
  const { resolveGuardDbPath } = await import("../shared/migration-guard.js");
  const { tasksDbPath } = await import("../../scripts/pi-bots/instance-paths.mjs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const _root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const res = await runMigrations({
    migrationsDir: join(_root, "scripts", "migrations"),
    dbPath: resolveGuardDbPath(resolveDataDir),
    tasksDbPath: tasksDbPath(),
    log: (m) => console.log(`[migrations] ${m}`),
  });
  if (res.applied.length) console.log(`[migrations] applied: ${res.applied.join(", ")}`);
} catch (e) {
  // Fail closed, matching the schema guard's posture: serving on a
  // half-migrated store is how the Bot Board 500'd on every drawer open.
  console.error("ERROR: migration registry failed:", e.message);
  console.error("  Run it manually with this instance's CROW_DATA_DIR/CROW_DB_PATH before starting the gateway.");
  process.exit(1);
}
```

- [ ] **Step 4: Run the test**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/migration-registry.test.js`
Expected: PASS.

- [ ] **Step 5: Verify a real gateway still boots**

Never point a scratch gateway at a live data dir. Use a scratch home with BOTH vars pinned:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
S=/tmp/claude-1000/-home-kh0pp-crow/6d3ccab0-b825-43c7-b8e4-dddc847b9be3/scratchpad/bootcheck
rm -rf $S && mkdir -p $S/data
cd /home/kh0pp/crow-wt-rolling
CROW_HOME=$S CROW_DATA_DIR=$S/data CROW_DB_PATH=$S/data/crow.db \
CROW_AUTO_UPDATE=0 CROW_ALLOW_ORPHAN=1 PORT=3099 \
timeout 90 node servers/gateway/index.js --no-auth 2>&1 | tee $S/boot.log | head -60
```
Expected: `[migrations] applied: 0001-board-stages` appears, and the gateway reaches its listen line. Then confirm the live DBs were untouched: `ls -l /home/kh0pp/.crow/data/crow.db` mtime unchanged.

- [ ] **Step 6: Run the full suite**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && npm test > /tmp/claude-1000/-home-kh0pp-crow/6d3ccab0-b825-43c7-b8e4-dddc847b9be3/scratchpad/suite-taskA.log 2>&1; grep -E "^# (tests|pass|fail|cancelled)" /tmp/claude-1000/-home-kh0pp-crow/6d3ccab0-b825-43c7-b8e4-dddc847b9be3/scratchpad/suite-taskA.log`
Expected: `# fail 0`, `# cancelled 0`, and `# tests` ≥ 2961 + the new tests.

- [ ] **Step 7: Commit and open PR A**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/index.js tests/migration-registry.test.js \
  -m "feat(gateway): run the per-instance migration registry at boot

Co-hosted gateways sharing one checkout each migrate their own stores with
their own env, covering changes that carry no SCHEMA_GENERATION bump."
git show --stat HEAD
git pull --rebase origin main
git push -u origin feat/safe-rolling-updates
```

Open PR A titled `feat(migrations): per-instance migration registry`. Do NOT merge yet — Part 3 continues on the same branch, and the whole-branch review in Task 14 gates the merge.

---

## Part 3 — PR B: converge + health gate

### Task 6: The executable gate — two instances, one checkout (MUST FAIL)

This task writes the integration test that reproduces the starvation bug. It is expected to FAIL at the end of this task and to go green in Task 10. A review that only reads a diff cannot tell you whether a restart-into-newer-code actually migrates — this harness can.

**Files:**
- Create: `tests/convergence-two-instance.test.js`

**Interfaces:**
- Consumes: `_setAppRootForTest`, `_setDbForTest` from `auto-update.js` (existing test seams).
- Produces: `twoInstanceFixture()` — reused by Task 12.

- [ ] **Step 1: Write the harness and the failing assertion**

```js
// tests/convergence-two-instance.test.js
//
// The executable gate for co-hosted convergence. TWO instance data dirs share
// ONE git checkout, exactly like crow-gateway / crow-mpa-gateway / crow-r4-gateway
// share ~/crow. Moving the fixture's origin forward must leave BOTH instances
// migrated — including the instance that loses the updater lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// This file drives the restart branch. Never let the suite believe it is supervised.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

export function twoInstanceFixture() {
  const root = mkdtempSync(join(tmpdir(), "converge-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");                 // the ONE shared checkout
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");

  mkdirSync(join(work, "scripts", "migrations"), { recursive: true });
  writeFileSync(join(work, "seed"), "1");
  g(work, "add", "-A");
  g(work, "commit", "-m", "seed");
  g(work, "push", "origin", "main");

  // TWO instances, each with its own data dir and its own stores.
  const instances = ["alpha", "beta"].map((name) => {
    const dataDir = join(root, name, "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "crow.db");
    const tasksDbPath = join(dataDir, "tasks.db");
    const t = new Database(tasksDbPath);
    t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
    t.close();
    new Database(dbPath).close();
    return { name, dataDir, dbPath, tasksDbPath };
  });

  /** Land a new migration on origin, as a real deploy would. */
  const advanceOrigin = (filename, body) => {
    writeFileSync(join(work, "scripts", "migrations", filename), body);
    g(work, "add", "-A");
    g(work, "commit", "-m", `add ${filename}`);
    g(work, "push", "origin", "main");
    // Rewind the shared checkout so it is genuinely BEHIND origin.
    g(work, "reset", "--hard", "HEAD~1");
  };

  return { root, origin, work, instances, advanceOrigin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const MIGRATION_BODY = `
import Database from "better-sqlite3";
export const id = "0002-converge-probe";
export function run({ tasksDbPath }) {
  const d = new Database(tasksDbPath);
  const have = d.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  if (!have.includes("probe")) d.prepare("ALTER TABLE tasks_items ADD COLUMN probe TEXT").run();
  d.close();
}`;

function hasProbe(tasksDbPath) {
  const d = new Database(tasksDbPath);
  const cols = d.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  d.close();
  return cols.includes("probe");
}

test("BOTH co-hosted instances converge — the lock loser must not starve", async (t) => {
  const f = twoInstanceFixture();
  t.after(f.cleanup);

  f.advanceOrigin("0002-converge-probe.mjs", MIGRATION_BODY);

  const { converge } = await import("../servers/gateway/convergence.js");
  const { _setAppRootForTest } = await import("../servers/gateway/auto-update.js");

  // Both instances share ONE checkout, so the tree half has ONE root. Retarget
  // it at the fixture, and restore it to the real repo before finishing — even
  // on failure — so no later test sees a mutating git command against ~/crow.
  _setAppRootForTest(f.work);
  t.after(() => _setAppRootForTest(join(import.meta.dirname, "..")));

  // alpha runs first and wins the checkout lock; beta runs second and loses it.
  const a = await converge({ appRoot: f.work, ...f.instances[0] });
  const b = await converge({ appRoot: f.work, ...f.instances[1] });

  assert.ok(hasProbe(f.instances[0].tasksDbPath), "alpha (lock winner) must be migrated");
  assert.ok(hasProbe(f.instances[1].tasksDbPath),
    "beta LOST the updater lock and must STILL migrate its own stores — this is the starvation bug");
  assert.equal(a.pulled, true, "the lock winner performs the pull");
  assert.equal(b.pulled, false, "the lock loser must not pull — the tree is shared");
  assert.equal(b.converged, true, "the lock loser must still converge");
});
```

- [ ] **Step 2: Run it and confirm it fails for the RIGHT reason**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-two-instance.test.js`
Expected: FAIL with `Cannot find module '../servers/gateway/convergence.js'`. That module arrives in Task 10. Do not stub it to make this pass.

- [ ] **Step 3: Commit the failing gate**

Committing a known-red test is deliberate here: it is the spec's executable gate, and the branch is not merged until Task 14.

```bash
cd /home/kh0pp/crow-wt-rolling
git add tests/convergence-two-instance.test.js
git commit tests/convergence-two-instance.test.js \
  -m "test(convergence): failing two-instance gate reproducing lock starvation

Two instance data dirs share one checkout. Expected RED until the
converge/updateTree split lands."
git show --stat HEAD
```

### Task 7: Record real HEAD even when auto-update is disabled

**Files:**
- Modify: `servers/gateway/auto-update.js:559-570`
- Test: `tests/convergence-unit.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports; a behavior change in `startAutoUpdate()`.

- [ ] **Step 1: Write the failing test**

```js
// tests/convergence-unit.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startAutoUpdate, stopAutoUpdate, _setDbForTest } from "../servers/gateway/auto-update.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

function fakeDb(rows) {
  const writes = [];
  return {
    writes,
    execute: async ({ sql, args }) => {
      if (/^SELECT/i.test(sql)) return { rows };
      writes.push({ key: args[0], value: args[1] });
      return { rows: [] };
    },
  };
}

test("a DISABLED instance still records its real running version", async () => {
  const db = fakeDb([{ key: "auto_update_enabled", value: "false" }]);
  await startAutoUpdate(db, {});
  stopAutoUpdate();

  const v = db.writes.find((w) => w.key === "auto_update_current_version");
  assert.ok(v, "current_version must be recorded even when auto-update is disabled — " +
               "otherwise a disabled instance reports a version it has not run since it was enabled");
  assert.match(v.value, /^[0-9a-f]{7,40}$/, "must be a real git sha");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js`
Expected: FAIL — "current_version must be recorded even when auto-update is disabled".

- [ ] **Step 3: Move the version write above the disabled return**

Replace lines 559-570 of `servers/gateway/auto-update.js`:

```js
  const settings = await getSettings();

  // Record the sha this process is ACTUALLY running, before any early return.
  // Previously this sat below the `disabled in settings` return, so a disabled
  // instance froze its reported version at whatever it was when it was last
  // enabled — while continuing to run whatever the shared checkout moved to.
  // The bookkeeping and the running code disagreed and nothing detected it.
  try {
    const ref = await run("git", ["rev-parse", "--short", "HEAD"]);
    if (ref.code === 0 && ref.stdout) await saveSetting("auto_update_current_version", ref.stdout);
  } catch {}

  if (settings.auto_update_enabled !== "true") {
    console.log("[auto-update] Disabled in settings");
    return;
  }
```

- [ ] **Step 4: Run the test**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js tests/auto-update-hardening.test.js tests/auto-update-tick-gate.test.js`
Expected: PASS, no regression in the two existing files.

- [ ] **Step 5: Mutation-test**

Move the version write back below the `return` → the new test must go RED. Revert.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git add tests/convergence-unit.test.js
git commit servers/gateway/auto-update.js tests/convergence-unit.test.js \
  -m "fix(auto-update): record the running sha even when updates are disabled

A disabled instance froze its reported version while continuing to run
whatever the shared checkout moved to."
git show --stat HEAD
```

### Task 8: Health snapshot and regression comparison

**Files:**
- Modify: `servers/gateway/proxy.js` (add export near `getProxyStatus`, line ~653)
- Create: `servers/gateway/convergence.js` (first half — pure functions only)
- Test: `tests/convergence-unit.test.js` (append)

**Interfaces:**
- Consumes: `connectedServers` from `proxy.js` (already exported at line 25).
- Produces:
  - `healthSnapshot() → Record<string, string>` in `proxy.js` — addon id → status.
  - `compareHealth(before, after) → { ok: boolean, regressions: Array<{id, was, now}> }` in `convergence.js`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { compareHealth } from "../servers/gateway/convergence.js";

test("compareHealth flags only REGRESSIONS, never pre-existing breakage", () => {
  // The Aug 3-5 state: tasks and bots-sql-mcp were already down for an
  // unrelated ABI reason. An absolute "all green" gate would have quarantined
  // every good sha for as long as that lasted.
  const before = { tasks: "error", "bots-sql-mcp": "error", "pm-workspace": "connected" };

  const unchanged = compareHealth(before, { ...before });
  assert.equal(unchanged.ok, true, "already-broken addons must NOT count as a regression");

  const healed = compareHealth(before, { ...before, tasks: "connected" });
  assert.equal(healed.ok, true, "an addon getting BETTER is not a regression");

  const broke = compareHealth(before, { ...before, "pm-workspace": "error" });
  assert.equal(broke.ok, false, "a connected addon going to error IS a regression");
  assert.deepEqual(broke.regressions, [{ id: "pm-workspace", was: "connected", now: "error" }]);

  const vanished = compareHealth(before, { tasks: "error", "bots-sql-mcp": "error" });
  assert.equal(vanished.ok, false, "an addon that disappears entirely is a regression");
  assert.deepEqual(vanished.regressions, [{ id: "pm-workspace", was: "connected", now: "missing" }]);
});

test("compareHealth on an empty baseline never regresses", () => {
  assert.equal(compareHealth({}, { anything: "error" }).ok, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js`
Expected: FAIL — `Cannot find module '../servers/gateway/convergence.js'`.

- [ ] **Step 3: Add the snapshot export to proxy.js**

Insert immediately before `export function getProxyStatus()`:

```js
/**
 * Addon id → connection status, for the convergence health gate. Deliberately
 * a flat map of the SAME statuses connectedServers already tracks, so the gate
 * compares like with like across a restart.
 */
export function healthSnapshot() {
  const snap = {};
  for (const [id, entry] of connectedServers) snap[id] = entry.status;
  return snap;
}
```

- [ ] **Step 4: Create convergence.js with the comparator**

```js
// servers/gateway/convergence.js
//
// An instance's job is to converge to the tree, not to pull. Pulling is a
// TREE operation (one winner among co-hosted gateways sharing a checkout);
// migrating and restarting are INSTANCE operations that every gateway must
// perform with its own env.

/**
 * A REGRESSION check, not an absolute one. "Every addon connected" would
 * quarantine a perfectly good sha on any host that already had a broken addon
 * — precisely crow's state Aug 3-5, when tasks and bots-sql-mcp were down for
 * an unrelated native-ABI reason. The gate must answer "did this update break
 * something?", not "is everything perfect?".
 */
export function compareHealth(before, after) {
  const regressions = [];
  for (const [id, was] of Object.entries(before || {})) {
    if (was !== "connected") continue;              // was already unhealthy — not ours
    const now = (after || {})[id] ?? "missing";
    if (now !== "connected") regressions.push({ id, was, now });
  }
  return { ok: regressions.length === 0, regressions };
}
```

- [ ] **Step 5: Run the tests**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js`
Expected: PASS.

- [ ] **Step 6: Mutation-test**

1. Remove the `if (was !== "connected") continue;` line → the "already-broken" and "getting better" assertions must fail.
2. Change `?? "missing"` to `?? "connected"` → the vanished-addon assertion must fail.
3. Change `now !== "connected"` to `now === "error"` → the vanished-addon assertion must fail.

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git add servers/gateway/convergence.js
git commit servers/gateway/convergence.js servers/gateway/proxy.js tests/convergence-unit.test.js \
  -m "feat(convergence): regression-based addon health comparison

Compares against a pre-convergence baseline rather than an absolute
all-green bar, so pre-existing breakage never quarantines a good sha."
git show --stat HEAD
```

### Task 9: The boot cookie

**Files:**
- Modify: `servers/gateway/convergence.js`
- Test: `tests/convergence-unit.test.js` (append)

**Interfaces:**
- Consumes: nothing from Task 8 beyond the same file.
- Produces:
  - `PENDING_TTL_MS = 10 * 60 * 1000`, `ADDON_GRACE_MS = 90 * 1000`
  - `writePending(dataDir, { sha, baseline, now })`, `readPending(dataDir) → record|null`, `clearPending(dataDir)`
  - `classifyPending(pending, bootSha, now) → "none" | "verify" | "failed" | "stale"`
  - Record shape: `{ sha, baseline: Record<string,string>, deadline: ISO string }` at `<dataDir>/convergence-pending.json`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePending, readPending, clearPending, classifyPending, PENDING_TTL_MS,
} from "../servers/gateway/convergence.js";

test("boot cookie round-trips and clears", () => {
  const d = mkdtempSync(join(tmpdir(), "cookie-"));
  try {
    const now = Date.parse("2026-08-06T12:00:00Z");
    writePending(d, { sha: "abc1234", baseline: { tasks: "connected" }, now });
    const p = readPending(d);
    assert.equal(p.sha, "abc1234");
    assert.deepEqual(p.baseline, { tasks: "connected" });
    assert.equal(Date.parse(p.deadline), now + PENDING_TTL_MS);

    clearPending(d);
    assert.equal(readPending(d), null);
    assert.equal(existsSync(join(d, "convergence-pending.json")), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("classifyPending covers every boot case including the crash-loop", () => {
  const now = Date.parse("2026-08-06T12:00:00Z");
  const fresh = { sha: "new1234", baseline: {}, deadline: new Date(now + 60_000).toISOString() };
  const expired = { sha: "new1234", baseline: {}, deadline: new Date(now - 1).toISOString() };

  assert.equal(classifyPending(null, "new1234", now), "none");

  // We are the boot the cookie was written for, and there is still time: verify.
  assert.equal(classifyPending(fresh, "new1234", now), "verify");

  // Crash-loop: same sha, but the deadline passed without anyone clearing it.
  // The previous boot never got far enough to verify — treat as failure.
  assert.equal(classifyPending(expired, "new1234", now), "failed",
    "an expired cookie for the sha we are booting proves the last convergence never verified");

  // Never booted into the target sha at all (it crashed before serving).
  assert.equal(classifyPending(expired, "old9999", now), "failed");

  // Cookie for some other sha that has not expired — unrelated, drop it.
  assert.equal(classifyPending(fresh, "old9999", now), "stale");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js`
Expected: FAIL — `writePending is not a function`.

- [ ] **Step 3: Implement**

Append to `servers/gateway/convergence.js`:

```js
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** How long a convergence has to boot and verify before we call it failed.
 *  Exceeds the worst realistic boot: a guarded SCHEMA_GENERATION migration
 *  plus ADDON_GRACE_MS. Too short quarantines healthy slow boots. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** How long after boot to let addons connect before snapshotting health.
 *  MUST exceed proxy.js's own CONNECT_TIMEOUT_MS (60s), or a slow-but-healthy
 *  addon reads as a regression. */
export const ADDON_GRACE_MS = 90 * 1000;

const PENDING_FILE = "convergence-pending.json";
const pendingPath = (dataDir) => join(dataDir, PENDING_FILE);

export function writePending(dataDir, { sha, baseline, now = Date.now() }) {
  const rec = { sha, baseline, deadline: new Date(now + PENDING_TTL_MS).toISOString() };
  writeFileSync(pendingPath(dataDir), JSON.stringify(rec, null, 2));
  return rec;
}

export function readPending(dataDir) {
  try { return JSON.parse(readFileSync(pendingPath(dataDir), "utf8")); } catch { return null; }
}

export function clearPending(dataDir) {
  try { unlinkSync(pendingPath(dataDir)); } catch {}
}

/**
 * What a booting process should do about the cookie it finds.
 *
 *   none   — nothing pending.
 *   verify — we ARE the boot this cookie was written for and there is time
 *            left; snapshot health after ADDON_GRACE_MS and compare.
 *   failed — the deadline passed with the cookie uncleared. Either the target
 *            never booted, or it booted and died before verifying. Both mean
 *            the convergence did not prove itself.
 *   stale  — a live cookie for a sha we are not running; unrelated, discard.
 */
export function classifyPending(pending, bootSha, now = Date.now()) {
  if (!pending) return "none";
  if (Date.parse(pending.deadline) <= now) return "failed";
  return pending.sha === bootSha ? "verify" : "stale";
}
```

- [ ] **Step 4: Run the tests**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation-test**

1. Swap the order of the deadline check and the sha check in `classifyPending` → the crash-loop assertion must fail.
2. Change `<=` to `<` in the deadline check → confirm which assertion moves; if none does, add a boundary case at exactly `deadline === now`.
3. Make `clearPending` a no-op → the round-trip test must fail.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/convergence.js tests/convergence-unit.test.js \
  -m "feat(convergence): boot cookie carrying the pre-restart health baseline

Classifies every boot case including the crash-loop, where the target sha
boots but dies before it can verify itself."
git show --stat HEAD
```

### Task 10: Split updateTree and convergeInstance

This is the task that turns Task 6's gate green.

**Files:**
- Modify: `servers/gateway/auto-update.js:196-231` (`checkForUpdates`)
- Modify: `servers/gateway/convergence.js`
- Test: `tests/convergence-two-instance.test.js` (already written, currently red)

**Interfaces:**
- Consumes: `runMigrations` (Task 3), `PENDING_TTL_MS`/`writePending` (Task 9), `compareHealth` (Task 8).
- Produces: `converge({ appRoot, dataDir, dbPath, tasksDbPath, log }) → Promise<{ pulled: boolean, converged: boolean, sha: string, applied: string[] }>`

- [ ] **Step 1: Confirm the gate is still red for the right reason**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-two-instance.test.js`
Expected: FAIL — `converge is not a function` (the module now exists from Tasks 8-9, but not this export).

- [ ] **Step 2: Implement `converge`**

Append to `servers/gateway/convergence.js`:

```js
import { execFile } from "node:child_process";

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ stdout: (stdout || "").trim(), stderr: (stderr || "").trim(), code: err ? err.code || 1 : 0 });
    });
  });
}

/**
 * Make ONE instance current with the checkout it runs from.
 *
 * The pull is a TREE operation and stays behind the checkout-scoped lock —
 * exactly one co-hosted gateway performs it. Everything after the pull is an
 * INSTANCE operation and runs unconditionally, including for the gateway that
 * lost the lock. Before this split the loser returned early and therefore never
 * migrated its own stores and never restarted into the new code; with all
 * gateways restarting together their 6h timers were phase-locked, so the same
 * instance lost every tick, forever.
 */
export async function converge({ appRoot, dataDir, dbPath, tasksDbPath, log = () => {} }) {
  const { runMigrations } = await import("../../scripts/migrations/runner.mjs");
  const au = await import("./auto-update.js");

  // --- tree half: at most one winner ---------------------------------------
  const pulled = await au.updateTree({ appRoot, log });

  // --- instance half: everyone, always -------------------------------------
  const sha = (await git(appRoot, ["rev-parse", "HEAD"])).stdout;
  const res = await runMigrations({
    migrationsDir: join(appRoot, "scripts", "migrations"),
    dbPath, tasksDbPath, sha, log,
  });

  return { pulled, converged: true, sha, applied: res.applied };
}
```

- [ ] **Step 3: Extract `updateTree` in auto-update.js**

Replace the lock-skip early return at lines 209-223 of `servers/gateway/auto-update.js`:

```js
    const lock = await lockPath();
    const held = lock ? acquireLock(lock) : null;
    if (lock && !held) {
      const info = readLock(lock);
      // NOT an error, and NOT a reason to stop. The tree is shared: another
      // co-hosted gateway is pulling it, which is exactly right. This instance
      // skips the PULL and still converges itself — see convergence.js.
      const msg = `Tree pull skipped: another instance holds the checkout lock (pid ${info?.pid ?? "unknown"})`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      return { updated: false, skipped: "locked", pulled: false, message: msg };
    }
```

Then add the exported wrapper near the end of the module:

```js
/**
 * The TREE half of an update: fetch, CI gate, quarantine check, pull, deps.
 * Returns whether this process actually moved the checkout. A `false` return
 * from a lock loss is a normal, healthy outcome — the caller still converges.
 *
 * Operates on the module's APP_ROOT deliberately: co-hosted gateways share ONE
 * checkout, so there is exactly one tree to update and no per-call root to
 * thread through. Tests retarget it with the existing _setAppRootForTest seam.
 */
export async function updateTree({ log = (m) => console.log(`[auto-update] ${m}`) } = {}) {
  const res = await checkForUpdates();
  return Boolean(res?.updated);
}
```

**Do NOT call `_setAppRootForTest` from `updateTree`.** It is documented
test-only (`auto-update.js:20`), and having production code mutate a test seam
would let a stray call silently retarget every later git operation in the
process. `converge()` accepts `appRoot` for its own git and migration paths
only; the tree half uses the module root.

- [ ] **Step 4: Run the two-instance gate**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-two-instance.test.js`
Expected: PASS — both alpha and beta have the `probe` column, `a.pulled === true`, `b.pulled === false`, `b.converged === true`.

- [ ] **Step 5: Mutation-test the gate — this is the important one**

The gate exists to catch starvation. Prove it can:

1. In `converge`, wrap the `runMigrations` call in `if (pulled) { ... }` → the beta assertion must fail with "beta LOST the updater lock and must STILL migrate". If it stays green, the harness is not actually exercising the loser path and the gate is worthless — fix it before continuing.
2. Restore the early `return` in the lock-loss branch of `checkForUpdates` → beta must fail.
3. Make `advanceOrigin` skip its `reset --hard` → the test should fail because nothing was behind; confirms the fixture creates real skew.

- [ ] **Step 6: Run the existing auto-update tests for regressions**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/auto-update-hardening.test.js tests/auto-update-ci-gate.test.js tests/auto-update-tick-gate.test.js`
Expected: PASS. The lock-skip message text changed — if a test asserts on the old string, update the assertion to the new one, and confirm it still asserts the *behavior* and not just the text.

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/convergence.js servers/gateway/auto-update.js tests/convergence-two-instance.test.js \
  -m "feat(convergence): converge every instance, pull on only one

Splits the updater into a tree half behind the checkout lock and an
instance half that always runs. The lock loser no longer starves."
git show --stat HEAD
```

### Task 11: De-phase-lock the update timers

**Files:**
- Modify: `servers/gateway/auto-update.js` (`startAutoUpdate`, line ~578)
- Test: `tests/convergence-unit.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `instanceJitterMs(key) → number` exported from `auto-update.js`, range `[0, 600000)`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { instanceJitterMs } from "../servers/gateway/auto-update.js";

test("instanceJitterMs is stable per instance and differs between instances", () => {
  const a = instanceJitterMs("/home/kh0pp/.crow/data");
  const b = instanceJitterMs("/home/kh0pp/.crow-mpa/data");
  const c = instanceJitterMs("/home/kh0pp/.crow-r4/data");

  assert.equal(a, instanceJitterMs("/home/kh0pp/.crow/data"), "must be deterministic");
  assert.notEqual(a, b, "co-hosted instances must not share a phase");
  assert.notEqual(b, c);
  for (const v of [a, b, c]) {
    assert.ok(v >= 0 && v < 600000, `jitter ${v} must be within [0, 10min)`);
    assert.ok(Number.isInteger(v));
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js`
Expected: FAIL — `instanceJitterMs is not a function`.

- [ ] **Step 3: Implement and wire it in**

Add to `servers/gateway/auto-update.js`:

```js
const JITTER_WINDOW_MS = 10 * 60 * 1000;

/**
 * A stable per-instance offset for the first update check.
 *
 * Co-hosted gateways restart together, so a fixed 5-minute first check put all
 * of them on the same millisecond forever: their checks landed 475ms apart and
 * the same instance lost the lock every single tick. Deriving the offset from
 * the instance's data-dir path de-phases them permanently and survives restarts.
 *
 * This is robustness, not the fix — the fix is that the lock loser converges
 * anyway (see convergence.js). Jitter only makes contention rare.
 */
export function instanceJitterMs(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % JITTER_WINDOW_MS;
}
```

Then in `startAutoUpdate`, replace the fixed `5 * 60 * 1000`:

```js
  const { resolveDataDir } = await import("../db.js");
  const firstDelay = 5 * 60 * 1000 + instanceJitterMs(resolveDataDir());
  console.log(`[auto-update] Enabled — checking every ${hours}h (first check in ${Math.round(firstDelay / 1000)}s)`);

  updateTimer = setTimeout(async () => {
    await tickCheck();
    updateTimer = setInterval(() => { tickCheck().catch(() => {}); }, intervalMs);
  }, firstDelay);
```

- [ ] **Step 4: Run the tests**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js tests/auto-update-hardening.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation-test**

1. `return 0` from `instanceJitterMs` → the differ-between-instances assertion must fail.
2. `return h` without `% JITTER_WINDOW_MS` → the range assertion must fail.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/auto-update.js tests/convergence-unit.test.js \
  -m "fix(auto-update): de-phase-lock co-hosted first checks

Gateways restart together, so a fixed first-check delay put them on the
same millisecond permanently."
git show --stat HEAD
```

### Task 12: Quarantine on failed convergence, and peers honor it

**Files:**
- Modify: `servers/shared/migration-guard.js:353-368` (`writeQuarantine`)
- Modify: `servers/gateway/convergence.js`
- Modify: `servers/gateway/boot/post-listen.js` (after the `startAutoUpdate` call, line ~186)
- Test: `tests/convergence-two-instance.test.js` (append)

**Interfaces:**
- Consumes: `writeQuarantine`, `evaluateQuarantine`, `fireMigrationAlert` from `migration-guard.js`; `compareHealth`, `classifyPending`, `writePending`, `readPending`, `clearPending`, `ADDON_GRACE_MS` from `convergence.js`.
- Produces:
  - `writeQuarantine` gains an optional `reason` (default `"migration"`) and an `attemptsKey` field on the marker.
  - `verifyPendingConvergence({ dataDir, appRoot, dbPath, bootSha, snapshot, now, schedule })` in `convergence.js`.

- [ ] **Step 1: Write the failing test (append to the two-instance file)**

```js
test("quarantine attempts are keyed per convergence sha, not shared across shas", () => {
  const f = twoInstanceFixture();
  t2after(f);
  const { dbPath } = f.instances[0];

  const m1 = writeQuarantine({ appRoot: f.work, dbPath, sha: "aaa", reason: "convergence" });
  const m2 = writeQuarantine({ appRoot: f.work, dbPath, sha: "bbb", reason: "convergence" });
  const m3 = writeQuarantine({ appRoot: f.work, dbPath, sha: "aaa", reason: "convergence" });

  assert.equal(m1.attempts, 1);
  assert.equal(m2.attempts, 1, "a DIFFERENT bad sha must start its own attempt count — " +
    "otherwise three unrelated failures ever would permanently stop auto-clearing");
  assert.equal(m3.attempts, 2, "the SAME bad sha must carry its count forward");
});

test("a health regression quarantines the sha; peers then refuse to converge to it", async () => {
  const f = twoInstanceFixture();
  t2after(f);
  const [alpha, beta] = f.instances;

  writePending(alpha.dataDir, {
    sha: "bad1234",
    baseline: { "pm-workspace": "connected" },
    now: Date.now(),
  });

  const out = await verifyPendingConvergence({
    dataDir: alpha.dataDir,
    appRoot: f.work,
    dbPath: alpha.dbPath,
    bootSha: "bad1234",
    snapshot: () => ({ "pm-workspace": "error" }),   // the regression
    schedule: (fn) => fn(),                          // run the grace timer inline
  });

  assert.equal(out.verdict, "quarantined");
  assert.deepEqual(out.regressions, [{ id: "pm-workspace", was: "connected", now: "error" }]);
  assert.equal(readPending(alpha.dataDir), null, "the cookie must be cleared either way");

  // The repo-level marker is what a PEER sees — they share the checkout.
  const marker = readMarker(repoMarkerPath(f.work));
  assert.equal(marker.sha, "bad1234");
  assert.equal(marker.reason, "convergence");

  // beta must now refuse.
  const { converge } = await import("../servers/gateway/convergence.js");
  const r = await converge({ appRoot: f.work, ...beta });
  assert.equal(r.converged, false, "a peer must not converge to a quarantined sha");
  assert.equal(r.skipped, "quarantined");
});

test("a healthy convergence clears the cookie and quarantines nothing", async () => {
  const f = twoInstanceFixture();
  t2after(f);
  const [alpha] = f.instances;

  writePending(alpha.dataDir, { sha: "good999", baseline: { tasks: "connected" }, now: Date.now() });

  const out = await verifyPendingConvergence({
    dataDir: alpha.dataDir, appRoot: f.work, dbPath: alpha.dbPath,
    bootSha: "good999",
    snapshot: () => ({ tasks: "connected" }),
    schedule: (fn) => fn(),
  });

  assert.equal(out.verdict, "ok");
  assert.equal(readPending(alpha.dataDir), null);
  assert.equal(readMarker(repoMarkerPath(f.work)), null, "a healthy convergence must not quarantine");
});
```

Add these imports to the TOP of the file (ESM imports must be at module scope,
not inside the appended tests), and this cleanup helper:

```js
import { test, after } from "node:test";     // replaces the existing `import { test }`
import { writeQuarantine, readMarker, repoMarkerPath } from "../servers/shared/migration-guard.js";
import { verifyPendingConvergence, writePending, readPending } from "../servers/gateway/convergence.js";
import { _setAppRootForTest } from "../servers/gateway/auto-update.js";

// These tests take no `t`, so they cannot use t.after — register centrally.
// The app-root restore is NOT optional: converge() reaches updateTree(), which
// operates on the module root. A test that leaves the root pointed at a deleted
// fixture makes a LATER test run git against whatever is there.
const _fixtures = [];
function t2after(f) { _fixtures.push(f); }
after(() => {
  _setAppRootForTest(join(import.meta.dirname, ".."));
  for (const f of _fixtures) f.cleanup();
  _fixtures.length = 0;
});
```

In the peer-refusal test, call `_setAppRootForTest(f.work)` before `converge`.
The quarantine guard runs before `updateTree` and should short-circuit first,
but do not rely on that ordering to keep git off the real repo.

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-two-instance.test.js`
Expected: FAIL — `verifyPendingConvergence is not a function`, and the attempts test fails because `writeQuarantine` keys attempts on the generation pair (both convergence markers pass `undefined`/`undefined`, so `bbb` inherits `aaa`'s count).

- [ ] **Step 3: Add `reason` and `attemptsKey` to writeQuarantine**

Replace `servers/shared/migration-guard.js:353-368`:

```js
export function writeQuarantine({ appRoot, dbPath, sha, fromGeneration, toGeneration, report, reason = "migration" }) {
  // Attempts carry forward per DISTINCT cause. For a schema migration the cause
  // is the (from,to) generation crossing; for a convergence failure it is the
  // specific bad sha. Keying convergence failures on the generation pair would
  // make every convergence failure share one counter — three unrelated bad shas
  // ever would permanently stop the quarantine from auto-clearing.
  const attemptsKey = reason === "convergence"
    ? `convergence:${sha}`
    : `migration:${fromGeneration}->${toGeneration}`;

  let attempts = 1;
  for (const p of [repoMarkerPath(appRoot), dataMarkerPath(dbPath)]) {
    const prev = readMarker(p);
    if (!prev) continue;
    // Markers written before attemptsKey existed are migration markers; fall
    // back to the original generation-pair comparison for them.
    const prevKey = prev.attemptsKey
      ?? `migration:${prev.fromGeneration}->${prev.toGeneration}`;
    if (prevKey === attemptsKey) attempts = Math.max(attempts, (prev.attempts || 0) + 1);
  }
  const marker = { sha, fromGeneration, toGeneration, reason, attemptsKey, at: new Date().toISOString(), attempts, report };
  for (const p of [repoMarkerPath(appRoot), dataMarkerPath(dbPath)]) {
    try { writeFileSync(p, JSON.stringify(marker, null, 2)); } catch {}
  }
  return marker;
}
```

- [ ] **Step 4: Implement `verifyPendingConvergence` and the peer guard**

Append to `servers/gateway/convergence.js`:

```js
/**
 * Called at boot. Decides what the cookie left behind by the previous
 * convergence means, and quarantines the sha if that convergence did not prove
 * itself healthy.
 *
 * `snapshot` and `schedule` are injected so tests can drive the grace window
 * without waiting 90 real seconds.
 */
export async function verifyPendingConvergence({
  dataDir, appRoot, dbPath, bootSha,
  snapshot, schedule = (fn) => setTimeout(fn, ADDON_GRACE_MS).unref(),
  now = Date.now(), log = () => {},
}) {
  const pending = readPending(dataDir);
  const verdict = classifyPending(pending, bootSha, now);

  if (verdict === "none") return { verdict: "none" };
  if (verdict === "stale") { clearPending(dataDir); return { verdict: "stale" }; }

  const guard = await import("../shared/migration-guard.js");

  const quarantine = async (sha, regressions, why) => {
    guard.writeQuarantine({ appRoot, dbPath, sha, reason: "convergence", report: { regressions, why } });
    clearPending(dataDir);
    await guard.fireMigrationAlert({
      title: "Crow update quarantined: convergence failed",
      body: `The gateway converged to ${String(sha).slice(0, 9)} and ${why}. `
          + `That sha is quarantined — no instance on this host will converge to it until the `
          + `quarantine clears (automatically when main moves past it, or by deleting the marker files). `
          + `The tree was NOT rolled back: co-hosted instances may be running it healthily.`,
    });
    log(`convergence to ${String(sha).slice(0, 9)} quarantined — ${why}`);
    return { verdict: "quarantined", regressions };
  };

  if (verdict === "failed") {
    return quarantine(pending.sha, [], "never completed a healthy boot before its deadline");
  }

  // verdict === "verify": we are the boot this cookie was written for.
  return new Promise((resolve) => {
    schedule(async () => {
      const after = snapshot();
      const cmp = compareHealth(pending.baseline, after);
      if (cmp.ok) {
        clearPending(dataDir);
        log(`convergence to ${String(pending.sha).slice(0, 9)} verified healthy`);
        resolve({ verdict: "ok" });
        return;
      }
      resolve(await quarantine(pending.sha, cmp.regressions,
        `broke ${cmp.regressions.map((r) => r.id).join(", ")}`));
    });
  });
}
```

Then add the peer guard at the top of `converge()`, immediately after the imports:

```js
  // Peers honor a quarantine written by whichever instance converged first.
  // The marker is written at BOTH repo and data level; the repo-level one is
  // what makes a shared checkout's other gateways see it. evaluateQuarantine
  // auto-clears once main moves past the bad sha (attempts-capped).
  const guard = await import("../shared/migration-guard.js");
  const head = (await git(appRoot, ["rev-parse", "HEAD"])).stdout;
  const q = guard.evaluateQuarantine({ appRoot, dbPath, originHeadSha: head });
  if (q.blocked) {
    log(`refusing to converge: ${q.marker.sha.slice(0, 9)} is quarantined (attempt ${q.marker.attempts})`);
    return { pulled: false, converged: false, skipped: "quarantined", sha: head, applied: [] };
  }
```

- [ ] **Step 5: Wire the boot-time verification into post-listen.js**

Insert immediately after the `startAutoUpdate(...)` call at line ~186:

```js
  // Verify the convergence that caused this restart, if there was one. Runs
  // after listen so the addon connects the gate measures have actually begun.
  import("../convergence.js").then(async ({ verifyPendingConvergence }) => {
    const { resolveDataDir } = await import("../../db.js");
    const { resolveGuardDbPath } = await import("../../shared/migration-guard.js");
    const { healthSnapshot } = await import("../proxy.js");
    const { execFileSync } = await import("node:child_process");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    let bootSha = null;
    try { bootSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, timeout: 10000 }).toString().trim(); } catch {}
    await verifyPendingConvergence({
      dataDir: resolveDataDir(),
      appRoot,
      dbPath: resolveGuardDbPath(resolveDataDir),
      bootSha,
      snapshot: healthSnapshot,
      log: (m) => console.log(`[convergence] ${m}`),
    });
  }).catch((err) => console.warn("[convergence] verification skipped:", err.message));
```

- [ ] **Step 6: Run the tests**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-two-instance.test.js tests/migration-guard.test.js`
Expected: PASS, including the pre-existing `migration-guard.test.js` — the `reason` default of `"migration"` keeps every existing caller behaving identically.

- [ ] **Step 7: Mutation-test**

1. Change the `attemptsKey` for convergence to use the generation pair → the per-sha attempts assertion must fail.
2. Remove `clearPending(dataDir)` from the healthy path → the "clears the cookie" assertion must fail.
3. Make the peer guard return `converged: true` anyway → the peer-refusal assertion must fail.
4. Change `compareHealth(pending.baseline, after)` to `compareHealth({}, after)` → the regression test must fail (it would make every convergence look healthy).
5. Remove the `reason` default from `writeQuarantine` → `migration-guard.test.js` must fail, proving back-compat is actually asserted.

- [ ] **Step 8: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/shared/migration-guard.js servers/gateway/convergence.js \
  servers/gateway/boot/post-listen.js tests/convergence-two-instance.test.js \
  -m "feat(convergence): quarantine a sha whose convergence regressed health

The shared tree is never rolled back — one instance's failed health check
must not drag co-hosted peers that are running that sha healthily. Peers
read the repo-level marker and refuse the bad sha instead."
git show --stat HEAD
```

### Task 13: Kill switch and documentation

**Files:**
- Modify: `servers/gateway/convergence.js`
- Modify: `docs/architecture/gateway.md`
- Test: `tests/convergence-unit.test.js` (append)

**Interfaces:**
- Consumes: `converge` from Task 10.
- Produces: `CROW_DISABLE_CONVERGE=1|true` short-circuits `converge()`.

- [ ] **Step 1: Write the failing test (append)**

```js
test("CROW_DISABLE_CONVERGE short-circuits convergence entirely", async () => {
  const { converge } = await import("../servers/gateway/convergence.js");
  process.env.CROW_DISABLE_CONVERGE = "1";
  try {
    const r = await converge({ appRoot: "/nonexistent", dataDir: "/nonexistent", dbPath: "/nonexistent/x.db", tasksDbPath: "/nonexistent/t.db" });
    assert.equal(r.converged, false);
    assert.equal(r.skipped, "disabled");
  } finally { delete process.env.CROW_DISABLE_CONVERGE; }
});
```

The nonexistent paths are deliberate: if the kill switch works, nothing touches the filesystem, so bogus paths cannot fail.

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js`
Expected: FAIL — an ENOENT from git or better-sqlite3, not a clean `skipped: "disabled"`.

- [ ] **Step 3: Add the kill switch as the very first statement in `converge()`**

```js
  if (process.env.CROW_DISABLE_CONVERGE === "1" || process.env.CROW_DISABLE_CONVERGE === "true") {
    log("convergence disabled via CROW_DISABLE_CONVERGE");
    return { pulled: false, converged: false, skipped: "disabled", sha: null, applied: [] };
  }
```

- [ ] **Step 4: Run the test**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/convergence-unit.test.js`
Expected: PASS.

- [ ] **Step 5: Document it**

Add to `docs/architecture/gateway.md` a section covering: the converge-vs-pull split and why the tree is shared; that a lock loss is normal and the instance still converges; the migration registry and how to add an entry (`scripts/migrations/NNNN-slug.mjs` exporting `id` and `run`); the health gate being a regression check with the 90 s / 10 min constants and why each is what it is; quarantine-not-rollback and how to clear a marker; and `CROW_DISABLE_CONVERGE=1`.

Check whether EN/ES i18n parity applies to anything you touched — the parity gate is live. Architecture docs are EN-only, but if any user-facing string was added, both locales must carry it.

- [ ] **Step 6: Run the FULL suite**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-rolling
npm test > /tmp/claude-1000/-home-kh0pp-crow/6d3ccab0-b825-43c7-b8e4-dddc847b9be3/scratchpad/suite-final.log 2>&1
grep -E "^# (tests|suites|pass|fail|cancelled|skipped)" /tmp/claude-1000/-home-kh0pp-crow/6d3ccab0-b825-43c7-b8e4-dddc847b9be3/scratchpad/suite-final.log
```
Expected: `# fail 0`, `# cancelled 0`, `# tests` ≥ 2961 plus every test added here. A `cancelled` count above zero is the known whole-file-cancel flake under load — re-run that file alone to confirm before treating it as a real failure.

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/convergence.js docs/architecture/gateway.md tests/convergence-unit.test.js \
  -m "feat(convergence): CROW_DISABLE_CONVERGE kill switch and architecture docs"
git show --stat HEAD
```

### Task 14: Whole-branch review, acceptance, merge, deploy, report

**Files:**
- No new files. This task gates the merge.

**Interfaces:**
- Consumes: everything above.
- Produces: merged `main`, deployed fleet, updated card #120.

- [ ] **Step 1: Audit the whole branch before review**

```bash
cd /home/kh0pp/crow-wt-rolling
git log --format='%an <%ae>%n%b' origin/main..HEAD | grep -iE "claude|co-authored|anthropic" && echo "ATTRIBUTION FOUND — FIX" || echo "clean"
git diff origin/main..HEAD --stat
```
Expected: `clean`. Any attribution must be rewritten before pushing further.

- [ ] **Step 2: Check the doctrine gates that CI does not cover**

- No new host ports added → `docs/developers/port-allocation.md` needs no change. Confirm with `git diff origin/main..HEAD | grep -iE "PORT|listen\("`.
- No new `DROP` or `DELETE` statements → `migration-expectations.js` needs no change. Confirm with `git diff origin/main..HEAD | grep -iE "DROP TABLE|DELETE FROM"`.
- No `SCHEMA_GENERATION` bump → the dryrun rail does not apply. Confirm with `git diff origin/main..HEAD -- servers/shared/schema-version.js` returning empty.

If any of those confirms are non-empty, stop and handle the corresponding rail before merging.

- [ ] **Step 3: Adversarial whole-branch review**

Request a code review covering the full diff, with these as the named areas of concern: the converge/pull split under real concurrency; whether the quarantine can wedge an instance permanently; whether `verifyPendingConvergence`'s promise can leak or never resolve; whether the boot-order invariant actually holds at runtime and not just in source text; and whether any test is vacuous.

- [ ] **Step 4: Wiped-scratch acceptance**

A fresh instance, never migrated, must boot correctly — this is the case the fixture harness cannot cover:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
S=/tmp/claude-1000/-home-kh0pp-crow/6d3ccab0-b825-43c7-b8e4-dddc847b9be3/scratchpad/accept
rm -rf $S && mkdir -p $S/data
cd /home/kh0pp/crow-wt-rolling
CROW_HOME=$S CROW_DATA_DIR=$S/data CROW_DB_PATH=$S/data/crow.db \
CROW_AUTO_UPDATE=0 CROW_ALLOW_ORPHAN=1 PORT=3099 \
timeout 120 node servers/gateway/index.js --no-auth 2>&1 | tee $S/accept.log | head -80
```
Expected: `[migrations] applied: 0001-board-stages`, gateway listens, no `[convergence]` quarantine. Then verify the live DBs were untouched (mtimes on `~/.crow/data/crow.db` and `~/.crow-r4/data/crow.db` unchanged).

- [ ] **Step 5: Push, verify CI via check-runs, merge**

```bash
cd /home/kh0pp/crow-wt-rolling
git pull --rebase origin main
git push
SHA=$(git rev-parse HEAD)
curl -s "https://api.github.com/repos/kh0pper/crow/commits/$SHA/check-runs" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(r['name'], r['status'], r['conclusion']) for r in d['check_runs']]"
```
Expected: `suite`, `static-checks`, `audit` each `completed success`. An empty result on a current sha means something is WRONG, not that checks are absent. Merge only when all three are green.

- [ ] **Step 6: Deploy and verify the fleet**

Deploy to all five instances. For the three co-hosted on crow, use the Phase 1 script for r4 and normal restarts for primary/MPA, in tight windows. After each restart confirm from DB **copies** (never open a running gateway's crow.db directly):

- `auto_update_current_version` now matches the real running sha on **every** instance, including r4 where auto-update is disabled. That is the Gap 4b fix proving itself in prod.
- No `[convergence]` quarantine markers exist: `ls ~/crow/.crow-migration-quarantine* 2>/dev/null`.
- `pibot-gateways@r4` is still active, and log a timestamp for its restart if the deploy touched `scripts/pi-bots/`.

- [ ] **Step 7: Report on card #120**

Update the card in `~/.crow-r4/data/tasks.db` (`tasks_items`) — it syncs to the Monday board, so keep it accurate. Record: what shipped (PR numbers and merge sha), that `r4-deploy.sh` is **uncommitted** at `/home/kh0pp/r4-tehcy/scripts/r4-deploy.sh` for the PM session to fold into the Gitea repo, the verification results, and that Phase 3 was deliberately not built. Set status to `done` only after the fleet verification in Step 6 passes.

- [ ] **Step 8: Present the r4 auto-update question**

With convergence merged, r4 could have `auto_update_enabled` turned back on — the starvation and migration-drift reasons for keeping it off are gone. This is the operator's call, not an assumption. Present it with the evidence from Step 6, and do not change the setting without an explicit yes.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Gap 1 — migrations travel with code | 3, 4, 5 |
| Gap 2 — bundle copies travel | 1 (step 5), 2 |
| Gap 3 — health verified | 8, 12 |
| Gap 4 — lock starvation | 6, 10, 11 |
| Gap 4b — disabled instance version lies | 7 |
| Lazy `schema_migrations`, no generation bump | 3 (step 3), 14 (step 2) |
| Registry scope = crow.db + tasks.db only | 3, 4 |
| Order invariant | 5 |
| Regression-not-absolute health gate | 8 |
| 90 s addon grace / 10 min cookie deadline | 9 |
| Quarantine, never `git reset --hard` | 12 |
| Peers honor the marker / canary by construction | 12 |
| `CROW_DISABLE_CONVERGE` kill switch | 13 |
| Two-instance executable gate | 6, 10 (step 5), 12 |
| Phase 3 not built | — (deliberate) |
| Report on card #120 | 14 |

**Known gap, stated rather than hidden:** if the new code crashes *before* `post-listen.js` runs, no boot ever reads the cookie in that process, and the quarantine only fires on the following boot via the expired-deadline path (`classifyPending → "failed"`, Task 9). That path is tested. A crash so early that systemd gives up before any boot reaches post-listen leaves the sha un-quarantined — detection then falls to the operator alert path, not to this mechanism. This is a real limit of self-verification without an external watchdog and is accepted rather than papered over.
