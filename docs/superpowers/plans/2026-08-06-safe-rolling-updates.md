# Safe Rolling Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every co-hosted crow gateway converge itself to the shared checkout — running its own migrations with its own env and verifying its own health — instead of one instance winning a lock and the others silently starving.

**Architecture:** `checkForUpdates()` is **restructured**, not supplemented: acquire the checkout lock, run the tree half only if held, release, then **always** run the instance half. The scheduled tick stays the single production path. Convergence owns the restart, writes a boot cookie carrying a pre-restart addon-health baseline, and on regression writes a convergence-specific quarantine marker that withholds *convergence* (never the pull) and hard-expires after 24 h.

**Tech Stack:** Node 22 (ABI 127) ESM, `better-sqlite3` for raw short-lived migration handles, node built-in test runner, bash for the Phase 1 deploy script.

## Global Constraints

- **Node 22 on every invocation:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`. Default `node` is v20; `better-sqlite3` is built for 22 and a v20 run fails `NODE_MODULE_VERSION 127 vs 115`.
- **`~/crow` stays on `main` always.** Work in `/home/kh0pp/crow-wt-rolling` on `feat/safe-rolling-updates` (`node_modules` symlinked).
- **Positional-path commits**, verified with `git show --stat HEAD`. **NEVER attribute Claude.**
- **PR flow only** (`enforce_admins` TRUE). Green `suite`/`static-checks`/`audit` via `/commits/<sha>/check-runs`, never commit-status.
- **No `SCHEMA_GENERATION` bump.** `schema_migrations` is created lazily by the runner.
- **Never open a running gateway's `crow.db` externally.** Copy `.db` + `-wal` + `-shm`, query the copy.
- **Pin `CROW_HOME`, `CROW_DATA_DIR`, `CROW_DB_PATH`** on every out-of-gateway invocation — `init-db.js` without them writes the LIVE primary DB.
- **Foreground test runs with direct file capture.** Baseline is **2961 pass / 0 fail** on this worktree.
- **Every test file that can reach `fireMigrationAlert` MUST call `_setAlertChannelsForTest`** with no-op channels, or the suite sends real ntfy pushes and emails.
- **Every test that can reach `checkForUpdates` MUST call `_setAppRootForTest(<fixture>)` and restore it**, or it runs git against the real worktree.
- **Coordination:** `pibot-gateways@r4` is mid-soak from `~/crow` through ~2026-08-12 — log a timestamp for every pull touching `scripts/pi-bots/` and every restart. Don't touch `~/crow-wt-board` or `~/.crow/p4/harness-wt`.

---

## File Structure

**Part 1 — Phase 1 (separate repo, uncommitted):** `/home/kh0pp/r4-tehcy/scripts/r4-deploy.sh`

**Part 2 — migration registry:**
- Create `scripts/migrations/runner.mjs`, `scripts/migrations/0001-board-stages.mjs`
- Modify `scripts/migrate-board-stages.mjs` (thin wrapper), `servers/gateway/index.js` (boot call site)
- Create `tests/migration-registry.test.js`

**Part 3 — converge + health gate:**
- Create `servers/gateway/convergence.js` (health comparison, boot cookie, quarantine namespace, `convergeInstance`)
- Modify `servers/gateway/proxy.js` (`healthSnapshot()`, addons-settled signal)
- Modify `servers/gateway/auto-update.js` (restructure `checkForUpdates`, move the restart out, jitter, record real HEAD)
- Modify `servers/gateway/boot/post-listen.js` (cookie verification)
- Create `tests/convergence-two-instance.test.js`, `tests/convergence-unit.test.js`
- Modify `docs/architecture/gateway.md`

---

## Part 1 — Phase 1: `r4-deploy.sh`

### Task 1: Deploy script — pull, deps, migrations, sync

**Files:** Create `/home/kh0pp/r4-tehcy/scripts/r4-deploy.sh`

**Interfaces:** Produces `r4-deploy.sh [--dry-run] [REF]`; exit 0 = PASS. Nothing else consumes it.

- [ ] **Step 1: Skeleton with env pinning and dry-run**

```bash
#!/usr/bin/env bash
# Supervised deploy for the crow-r4 instance from the shared ~/crow checkout.
set -Eeuo pipefail
CROW_REPO=/home/kh0pp/crow
NODE_BIN=/home/kh0pp/.nvm/versions/node/v22.23.1/bin
export PATH="$NODE_BIN:$PATH"
# All three, always: a child missing any of them silently resolves to the
# PRIMARY instance's ~/.crow/data/crow.db and nothing errors.
export CROW_HOME=/home/kh0pp/.crow-r4
export CROW_DATA_DIR=/home/kh0pp/.crow-r4/data
export CROW_DB_PATH=/home/kh0pp/.crow-r4/data/crow.db

DRY_RUN=0; [ "${1:-}" = "--dry-run" ] && { DRY_RUN=1; shift; }
REF="${1:-}"
PREV_COMMIT=$(git -C "$CROW_REPO" rev-parse HEAD)
log()  { printf '[r4-deploy %s] %s\n' "$(date -Is)" "$*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then log "DRY: $*"; else log "RUN: $*"; "$@"; fi; }
fail() { log "FAIL: $1"; log "Roll back: git -C $CROW_REPO reset --hard $PREV_COMMIT"; exit 1; }
log "starting; previous commit $PREV_COMMIT; dry_run=$DRY_RUN"
```

- [ ] **Step 2: Verify node pinning before anything else**

Run: `bash -c 'export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH; node -v'`
Expected: `v22.23.1`. If v20, stop — every later step is invalid.

- [ ] **Step 3: Pull + conditional deps + soak log line**

```bash
LOCK_BEFORE=$(md5sum "$CROW_REPO/package-lock.json" | cut -d' ' -f1)
if [ -n "$REF" ]; then run git -C "$CROW_REPO" checkout "$REF"
else run git -C "$CROW_REPO" pull --ff-only || fail "git pull --ff-only"; fi
NEW_COMMIT=$(git -C "$CROW_REPO" rev-parse HEAD)
log "now at $NEW_COMMIT"
# pibot-gateways@r4 soaks from this tree until ~2026-08-12; this line is what
# makes a heartbeat gap explainable afterwards.
if git -C "$CROW_REPO" diff --name-only "$PREV_COMMIT..$NEW_COMMIT" | grep -q '^scripts/pi-bots/'; then
  log "NOTE: pull touched scripts/pi-bots/ — pibot-gateways@r4 soak may show a heartbeat gap here"
fi
LOCK_AFTER=$(md5sum "$CROW_REPO/package-lock.json" | cut -d' ' -f1)
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  (cd "$CROW_REPO" && run npm ci --omit=dev) || fail "npm ci"
else log "lockfile unchanged — skipping npm ci"; fi
```

- [ ] **Step 4: Migrations with a WAL-aware both-DB guard**

The guard must count rows, not hash the file. These stores are WAL-mode: writes land in `crow.db-wal` and the main file's checksum does not move, so a hash-only guard prints PASS over exactly the env-leak it exists to catch.

```bash
primary_counts() {
  for d in /home/kh0pp/.crow/data/crow.db /home/kh0pp/.crow/data/tasks.db; do
    [ -f "$d" ] || { echo "$d MISSING"; continue; }
    cp "$d" "/tmp/pcheck.db"; [ -f "$d-wal" ] && cp "$d-wal" "/tmp/pcheck.db-wal"
    [ -f "$d-shm" ] && cp "$d-shm" "/tmp/pcheck.db-shm"
    echo -n "$d "
    sqlite3 /tmp/pcheck.db \
      "SELECT (SELECT count(*) FROM sqlite_master)||':'||(SELECT coalesce(sum(1),0) FROM sqlite_master WHERE type='table');"
    rm -f /tmp/pcheck.db /tmp/pcheck.db-wal /tmp/pcheck.db-shm
  done
}
PRIMARY_BEFORE=$(primary_counts)
run node "$CROW_REPO/scripts/init-db.js" || fail "init-db.js"
for m in "$CROW_REPO"/scripts/migrate-*.mjs; do
  [ -e "$m" ] || continue
  run node "$m" || fail "$(basename "$m")"
done
if [ "$DRY_RUN" = 0 ] && [ "$PRIMARY_BEFORE" != "$(primary_counts)" ]; then
  fail "PRIMARY instance DBs changed during an r4 migration run — env leak"
fi
```

Note the glob is `migrate-*.mjs`: `migrate-data-dir.js` (one-shot legacy install) and `migrate-redirect-303.js` (a codemod) are `.js` and correctly excluded.

- [ ] **Step 5: Bundle + panel sync with the per-instance exclusions**

```bash
# Omitting --delete prevents DELETION, not OVERWRITE, and -c selects exactly the
# files that differ — i.e. the deliberately per-instance ones. Exclude them by name.
for bdir in "$CROW_HOME"/bundles/*/; do
  id=$(basename "$bdir"); src="$CROW_REPO/bundles/$id"
  [ -d "$src" ] || { log "bundle $id: no repo source, skipping"; continue; }
  run rsync -rc --exclude node_modules --exclude data --exclude '*.db' \
      --exclude 'server/db.js' --exclude 'server/app-root.js' \
      "$src/" "$bdir" || fail "bundle sync $id"
  log "--- diff report for $id ---"
  diff -rq --exclude node_modules --exclude data "$src" "$bdir" || true
done
for p in "$CROW_HOME"/panels/*.js; do
  [ -e "$p" ] || continue
  src=$(find "$CROW_REPO/bundles" -name "$(basename "$p")" -path '*/panel*' -print -quit 2>/dev/null || true)
  [ -n "$src" ] && run rsync -c "$src" "$p"
done
```

- [ ] **Step 6: Dry-run and read every line**

Run: `bash /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh --dry-run`
Expected: exit 0; every mutating command prefixed `DRY:`. If any mutating command actually ran, fix before Task 2 — that task runs this for real against a live instance.

- [ ] **Step 7: Make executable, do NOT commit**

The r4-tehcy repo belongs to another workstream; leave it uncommitted and note it on card #120 (Task 15).
```bash
chmod +x /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh && ls -l /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh
```

### Task 2: Native rebuild, restart, regression-based health gate

**Files:** Modify `/home/kh0pp/r4-tehcy/scripts/r4-deploy.sh`
**Interfaces:** Consumes Task 1's helpers and `PREV_COMMIT`.

- [ ] **Step 1: Capture the pre-restart addon baseline**

The gate is a **regression** check, matching the gateway's. An absolute "all connected" gate would have failed every deploy during Aug 3–5, when `tasks` and `bots-sql-mcp` were legitimately down for an unrelated ABI reason, and demanded rollback of a good tree.

```bash
addon_states() {  # id=status per line, from the CURRENT journal
  journalctl -u crow-r4-gateway --since "-24h" --no-pager 2>/dev/null \
    | grep -oE 'addon [a-z0-9-]+: (connected|disconnected)' \
    | awk '{print $2$3}' | sed 's/://' | sort -u | awk -F: '{print}' | tail -50
}
BASELINE_CONNECTED=$(journalctl -u crow-r4-gateway --since "-24h" --no-pager 2>/dev/null \
  | grep -oE 'addon [a-z0-9-]+: connected' | awk '{print $2}' | tr -d ':' | sort -u)
log "baseline connected addons: $(echo "$BASELINE_CONNECTED" | tr '\n' ' ')"
```

- [ ] **Step 2: Native ABI rebuild, test-loaded**

```bash
for nb in tasks bots-sql-mcp; do
  nbdir="$CROW_HOME/bundles/$nb"
  [ -d "$nbdir/node_modules/better-sqlite3" ] || continue
  if ! "$NODE_BIN/node" -e "require('$nbdir/node_modules/better-sqlite3')" 2>/dev/null; then
    log "$nb: ABI mismatch — rebuilding with the v22 npm"
    (cd "$nbdir" && run "$NODE_BIN/npm" rebuild better-sqlite3) || fail "rebuild $nb"
    "$NODE_BIN/node" -e "require('$nbdir/node_modules/better-sqlite3')" || fail "$nb still fails to load"
  else log "$nb: loads under node 22"; fi
done
```

- [ ] **Step 3: Restart and wait on the SETTLE signal, not a clock**

`initProxyServers` connects addons **sequentially** (`proxy.js:337`) at 60 s each, so total time is unbounded in addon count. A fixed sleep either truncates a healthy slow start or wastes minutes.

```bash
RESTART_AT=$(date -Is)
run sudo systemctl restart crow-r4-gateway || fail "systemctl restart"
if [ "$DRY_RUN" = 0 ]; then
  log "waiting for the addon loop to settle (cap 10m)"
  for i in $(seq 1 120); do
    journalctl -u crow-r4-gateway --since "$RESTART_AT" --no-pager 2>/dev/null \
      | grep -q "Loading .* addon server" && \
    journalctl -u crow-r4-gateway --since "$RESTART_AT" --no-pager 2>/dev/null \
      | grep -qE "addon .*: (connected|failed to connect)" && sleep 5 && break
    sleep 5
  done
fi
```

- [ ] **Step 4: Regression gate**

```bash
if [ "$DRY_RUN" = 1 ]; then log "PASS (dry-run)"; exit 0; fi
systemctl is-active --quiet crow-r4-gateway || fail "unit not active"
J=$(journalctl -u crow-r4-gateway --since "$RESTART_AT" --no-pager 2>/dev/null || true)
for a in $BASELINE_CONNECTED; do
  echo "$J" | grep -q "addon $a: connected" \
    || fail "REGRESSION: addon '$a' was connected before this deploy and is not now"
done
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3008/s/family/)
[ "$code" = "200" ] || fail "smoke route /s/family/ returned $code"
log "PASS — r4 on $(git -C "$CROW_REPO" rev-parse --short HEAD); no addon regressed; smoke 200"
```

- [ ] **Step 5: Dry-run end to end**

Run: `bash /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh --dry-run` → exit 0, ends `PASS (dry-run)`, no sudo, no restart.

- [ ] **Step 6: Real supervised run in a tight window**

Announce the window (two other workstreams restart this gateway). Then:
`bash /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh 2>&1 | tee /tmp/r4-deploy-first.log`
Expected: exit 0, final line `PASS`. On FAIL, roll back with the printed command — never leave r4 on unverified code.

- [ ] **Step 7: Verify the primary was untouched**

`ls -l /home/kh0pp/.crow/data/crow.db /home/kh0pp/.crow/data/tasks.db` — mtimes unchanged.

---

## Part 2 — migration registry

### Task 3: Registry runner with deferral

**Files:** Create `scripts/migrations/runner.mjs`; Test `tests/migration-registry.test.js`

**Interfaces:** Produces
- `discoverMigrations(dir) → string[]` (sorted absolute paths)
- `runMigrations({ migrationsDir, dbPath, tasksDbPath, sha?, log? }) → Promise<{ applied: string[], skipped: string[], deferred: string[] }>`
- Migration module contract: exports `id: string` and `run({ dbPath, tasksDbPath, log }) → void | { deferred: true }`
- Table `schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)`, created lazily.

- [ ] **Step 1: Write the failing tests**

```js
// tests/migration-registry.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations, discoverMigrations } from "../scripts/migrations/runner.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "migreg-"));
  const dir = join(root, "migrations"); mkdirSync(dir);
  const dbPath = join(root, "crow.db"), tasksDbPath = join(root, "tasks.db");
  new Database(dbPath).close(); new Database(tasksDbPath).close();
  return { root, dir, dbPath, tasksDbPath };
}
const wm = (dir, name, body) => writeFileSync(join(dir, name), body);
// Fixture migrations import ONLY node: builtins — a bare specifier would not
// resolve from os.tmpdir(), which has no node_modules on its path.
const sideEffect = (id, file) =>
  `import { appendFileSync } from "node:fs";
   export const id = ${JSON.stringify(id)};
   export function run() { appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(id + "\n")}); }`;

test("runs migrations in filename order, not creation order", async () => {
  const f = fixture();
  try {
    const order = join(f.root, "order.txt");
    // Created out of order on purpose: readdirSync order is unspecified, so a
    // test whose files happen to be created in sorted order proves nothing.
    wm(f.dir, "0003-c.mjs", sideEffect("0003-c", order));
    wm(f.dir, "0001-a.mjs", sideEffect("0001-a", order));
    wm(f.dir, "0002-b.mjs", sideEffect("0002-b", order));
    const res = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.deepEqual(res.applied, ["0001-a", "0002-b", "0003-c"]);
    assert.equal(readFileSync(order, "utf8"), "0001-a\n0002-b\n0003-c\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("is idempotent — the body runs exactly once across two calls", async () => {
  const f = fixture();
  try {
    const hits = join(f.root, "hits.txt");
    wm(f.dir, "0001-once.mjs", sideEffect("0001-once", hits));
    const a = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const b = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.deepEqual(a.applied, ["0001-once"]);
    assert.deepEqual(b.applied, []);
    assert.deepEqual(b.skipped, ["0001-once"]);
    assert.equal(readFileSync(hits, "utf8"), "0001-once\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a DEFERRED migration is NOT recorded and runs again next time", async () => {
  const f = fixture();
  try {
    const hits = join(f.root, "deferred.txt");
    wm(f.dir, "0001-defer.mjs",
      `import { appendFileSync } from "node:fs";
       export const id = "0001-defer";
       export function run() { appendFileSync(${JSON.stringify(hits)}, "x"); return { deferred: true }; }`);
    const a = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const b = await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.deepEqual(a.deferred, ["0001-defer"]);
    assert.deepEqual(a.applied, []);
    assert.deepEqual(b.deferred, ["0001-defer"], "a deferred migration must retry, not be recorded");
    assert.equal(readFileSync(hits, "utf8"), "xx", "body must run BOTH times");
    const db = new Database(f.dbPath);
    assert.deepEqual(db.prepare("SELECT id FROM schema_migrations").all(), []);
    db.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("creates schema_migrations lazily — never requires init-db", async () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-noop.mjs", `export const id="0001-noop"; export function run(){}`);
    await runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    const db = new Database(f.dbPath);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    db.close();
    assert.ok(t, "runner must CREATE TABLE IF NOT EXISTS its own bookkeeping");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ignores files that do not match NNNN-slug.mjs", () => {
  const f = fixture();
  try {
    wm(f.dir, "0001-real.mjs", `export const id="0001-real"; export function run(){}`);
    wm(f.dir, "README.md", "x"); wm(f.dir, "helper.mjs", "export const x=1;");
    wm(f.dir, "0002-draft.mjs.bak", "x");
    assert.deepEqual(discoverMigrations(f.dir).map((p) => p.split("/").pop()), ["0001-real.mjs"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a throwing migration aborts the rest and records nothing", async () => {
  const f = fixture();
  try {
    const after = join(f.root, "after.txt");
    wm(f.dir, "0001-boom.mjs", `export const id="0001-boom"; export function run(){ throw new Error("boom"); }`);
    wm(f.dir, "0002-after.mjs", sideEffect("0002-after", after));   // observable side effect
    await assert.rejects(
      () => runMigrations({ migrationsDir: f.dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath }), /boom/);
    assert.equal(existsSync(after), false, "0002 must NOT run after 0001 throws");
    const db = new Database(f.dbPath);
    assert.deepEqual(db.prepare("SELECT id FROM schema_migrations").all(), []);
    db.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Verify it fails**

Run: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH && cd /home/kh0pp/crow-wt-rolling && node --test tests/migration-registry.test.js`
Expected: FAIL — `Cannot find module '../scripts/migrations/runner.mjs'`.

- [ ] **Step 3: Implement**

```js
// scripts/migrations/runner.mjs
//
// Ordered, idempotent, per-instance migration registry.
//
// Bookkeeping lives in `schema_migrations` inside the instance's crow.db and is
// created lazily HERE — deliberately not in scripts/init-db.js. Adding a table
// there would bump SCHEMA_GENERATION, which re-runs all of init-db's DROP TABLE
// statements against every live instance DB.
//
// Migrations must ALSO be safe to run with their record missing (a restored
// backup can lose the record but keep the change), so every body stays
// shape-checked and idempotent in its own right.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const FILENAME = /^\d{4}-[a-z0-9-]+\.mjs$/;

export function discoverMigrations(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => FILENAME.test(n)).sort().map((n) => join(dir, n));
}

function open(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }

function ensureTable(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)`).run();
}

/**
 * Run every not-yet-applied migration, in order, against ONE instance's stores.
 * Throws on the first failure without recording it.
 *
 * A migration returning `{ deferred: true }` is NOT recorded — its target tables
 * did not exist yet (bundle stores are created by their bundle, which may start
 * after the gateway boots, and better-sqlite3 creates an empty file on open, so
 * "absent" is the normal fresh-install state). Recording a deferral as applied
 * would reproduce the original bug: the table gets created later WITHOUT the new
 * columns and the migration never retries.
 */
export async function runMigrations({ migrationsDir, dbPath, tasksDbPath, sha = null, log = () => {} }) {
  const applied = [], skipped = [], deferred = [];
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
      const outcome = await mod.run({ dbPath, tasksDbPath, log });
      if (outcome && outcome.deferred) {
        log(`${mod.id} deferred — target tables absent, will retry next boot`);
        deferred.push(mod.id);
        continue;
      }
      book.prepare("INSERT INTO schema_migrations (id, applied_at, sha) VALUES (?, ?, ?)")
        .run(mod.id, new Date().toISOString(), sha);
      applied.push(mod.id);
    }
  } finally { book.close(); }
  return { applied, skipped, deferred };
}
```

- [ ] **Step 4: Run** — `node --test tests/migration-registry.test.js` → PASS, 6 tests.

- [ ] **Step 5: Mutation-test (assume vacuous until proven otherwise)**

Apply each, confirm the named test goes RED, revert:
1. Delete `if (done.has(mod.id))` → idempotence test fails on the `"0001-once\n"` assertion.
2. `.sort()` → `.sort().reverse()` → ordering test fails. (Plain `.reverse()` is *not* a valid mutation: `readdirSync` order is unspecified, so it can land correct by luck.)
3. `FILENAME` → `/\.mjs$/` → stray-file test fails.
4. Move the `INSERT` above `await mod.run(...)` → throwing-migration test fails.
5. Wrap `await mod.run(...)` in `try { } catch { continue }` → throwing test fails on `existsSync(after) === false`.
6. Treat `{deferred:true}` as applied (delete the `continue`) → deferral test fails on both the retry and the `"xx"` assertion.
7. Remove `ensureTable` → lazy-creation test fails.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git add scripts/migrations/runner.mjs tests/migration-registry.test.js
git commit scripts/migrations/runner.mjs tests/migration-registry.test.js \
  -m "feat(migrations): ordered per-instance migration registry

Bookkeeping is created lazily rather than in init-db.js, so the registry
ships without a SCHEMA_GENERATION bump. A migration whose target tables are
absent defers instead of recording itself as applied."
git show --stat HEAD
```

### Task 4: board-stages as registry entry 0001

**Files:** Create `scripts/migrations/0001-board-stages.mjs`; Modify `scripts/migrate-board-stages.mjs`; Test append.

**Interfaces:** Consumes `runMigrations`. Produces id `"0001-board-stages"` and `addColumnIfMissing(db, table, column, ddl) → "added"|"no-op"|"absent"`.

- [ ] **Step 1: Write the failing test (append)**

```js
test("0001-board-stages: adds columns, DEFERS when every table is absent, idempotent", async () => {
  const dir = join(import.meta.dirname, "..", "scripts", "migrations");

  // (a) All targets absent → deferred, NOT recorded.
  const bare = fixture();
  try {
    const r = await runMigrations({ migrationsDir: dir, dbPath: bare.dbPath, tasksDbPath: bare.tasksDbPath });
    assert.ok(r.deferred.includes("0001-board-stages"),
      "a fresh instance has no tasks_items yet — recording this as applied is the original bug");
    assert.ok(!r.applied.includes("0001-board-stages"));
  } finally { rmSync(bare.root, { recursive: true, force: true }); }

  // (b) tasks_items present → applied, columns added, re-runnable.
  const f = fixture();
  try {
    const t = new Database(f.tasksDbPath);
    t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
    t.close();
    const r = await runMigrations({ migrationsDir: dir, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.ok(r.applied.includes("0001-board-stages"));
    const t2 = new Database(f.tasksDbPath);
    const cols = t2.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    t2.close();
    for (const c of ["stage", "assigned_bot", "plan_ref"]) assert.ok(cols.includes(c), `tasks_items.${c}`);
    // Shape-level idempotence: re-run directly, bypassing the record.
    const mod = await import(join(dir, "0001-board-stages.mjs"));
    await mod.run({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Verify it fails** — `node --test tests/migration-registry.test.js` → FAIL, `0001-board-stages` not in `deferred`.

- [ ] **Step 3: Implement**

```js
// scripts/migrations/0001-board-stages.mjs
// Board–plan unification: guarded additive ALTERs. PRAGMA presence check,
// additive, idempotent, absent-table tolerant. SQLite ADD COLUMN never rebuilds
// the table, so existing CHECK constraints are unaffected.
import Database from "better-sqlite3";

export const id = "0001-board-stages";

export function addColumnIfMissing(db, table, column, ddl) {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!t) return "absent";
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (have.includes(column)) return "no-op";
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  return "added";
}

function open(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }

export function run({ dbPath, tasksDbPath, log = () => {} }) {
  const results = [];
  const tdb = open(tasksDbPath);
  try {
    for (const [col, ddl] of [["stage", "TEXT"], ["assigned_bot", "TEXT"], ["plan_ref", "TEXT"]]) {
      const r = addColumnIfMissing(tdb, "tasks_items", col, ddl);
      log(`  tasks_items.${col}: ${r}`); results.push(r);
    }
  } finally { tdb.close(); }

  const cdb = open(dbPath);
  try {
    for (const [tbl, col, ddl] of [
      ["project_spaces", "repo_path", "TEXT"],
      ["bot_sessions", "kind", "TEXT NOT NULL DEFAULT 'chat'"],
    ]) {
      const r = addColumnIfMissing(cdb, tbl, col, ddl);
      log(`  ${tbl}.${col}: ${r}`); results.push(r);
    }
  } finally { cdb.close(); }

  // Every target table missing means this instance's stores do not exist YET —
  // not that the work is done. Defer so the runner retries on the next boot.
  if (results.every((r) => r === "absent")) return { deferred: true };
}
```

- [ ] **Step 4: Rewrite the old script as a thin wrapper**

```js
// scripts/migrate-board-stages.mjs
// Thin wrapper — the migration lives in the registry at
// scripts/migrations/0001-board-stages.mjs and runs automatically at gateway
// boot. This entry point stays for manual and deploy-script invocation.
import { tasksDbPath, botsDbPath } from "./pi-bots/instance-paths.mjs";
import { run } from "./migrations/0001-board-stages.mjs";
const out = run({ dbPath: botsDbPath(), tasksDbPath: tasksDbPath(), log: (m) => console.log(m) });
if (out?.deferred) console.log("  (deferred — target tables absent on this instance)");
```

- [ ] **Step 5: Run** — `node --test tests/migration-registry.test.js tests/board-stages-migration.test.js` → PASS. If the pre-existing board-stages test asserts on the old script's internals, adapt it to the wrapper; do not weaken the assertion.

- [ ] **Step 6: Mutation-test**
1. `if (!t) return "absent"` → `throw` → the deferral assertion fails.
2. Remove the `have.includes(column)` guard → the direct re-run fails with "duplicate column name".
3. Delete the `results.every(...)` deferral return → test (a) fails.

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git add scripts/migrations/0001-board-stages.mjs
git commit scripts/migrations/0001-board-stages.mjs scripts/migrate-board-stages.mjs tests/migration-registry.test.js \
  -m "feat(migrations): move board-stages into the registry as 0001"
git show --stat HEAD
```

### Task 5: Run the registry at gateway boot

**Files:** Modify `servers/gateway/index.js` (after the schema-guard block ending line 195, before `initOAuthTables()` line 198); Test append.

**Interfaces:** Consumes `runMigrations`. Produces the boot call site.

- [ ] **Step 1: Write the failing order-invariant test**

```js
test("ORDER INVARIANT: registry runs after the schema guard, before the first createDbClient", async () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "index.js"), "utf8");
  // Anchor on the guard's CALL, not its import: `runGuardedInitDb` first appears
  // in the dynamic-import destructure, so indexOf would match a registry block
  // wrongly placed INSIDE the guard block.
  const guardCall = src.indexOf("await runGuardedInitDb(");
  const registry  = src.indexOf("runMigrations(");
  const firstClient = src.indexOf("initOAuthTables()");
  assert.ok(guardCall > 0 && registry > 0 && firstClient > 0, "all three call sites must be present");
  assert.ok(guardCall < registry, "registry must run AFTER the schema guard");
  assert.ok(registry < firstClient,
    "registry must run BEFORE the first createDbClient — createDbClient registers a " +
    "never-closed WAL keeper, and a later restore would swap the DB under a pinned inode");
});
```

- [ ] **Step 2: Verify it fails** — FAIL, "all three call sites must be present".

- [ ] **Step 3: Insert the call site**

Fail-closed only on genuine breakage. A `SQLITE_BUSY` on a bundle-owned store (the `tasks` addon child holds `tasks.db` open) is transient — exiting on it would make gateway boot depend on a store the gateway does not control, and under systemd's `StartLimitBurst` a crash-loop leaves the unit permanently down.

```js
// Per-instance migration registry (scripts/migrations/). Runs for THIS instance
// with THIS instance's env-resolved paths, so co-hosted gateways sharing one
// checkout each migrate their own stores. Covers changes carrying no
// SCHEMA_GENERATION bump — additive columns, and non-crow.db stores like tasks.db.
//
// ORDER INVARIANT: after the schema guard, before the first createDbClient
// (initOAuthTables). tests/migration-registry.test.js asserts this ordering.
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
  if (res.deferred.length) console.log(`[migrations] deferred (will retry): ${res.deferred.join(", ")}`);
} catch (e) {
  const transient = /SQLITE_BUSY|database is locked/i.test(e.message || "");
  if (transient) {
    console.warn(`[migrations] deferred — store busy (${e.message}); retrying next boot`);
  } else {
    console.error("ERROR: migration registry failed:", e.message);
    console.error("  Run it manually with this instance's CROW_DATA_DIR/CROW_DB_PATH before starting.");
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run** — `node --test tests/migration-registry.test.js` → PASS.

- [ ] **Step 5: Mutation-test the invariant** (the previous plan revision had no mutation here)
1. Move the registry block *above* the schema-guard block → the `guardCall < registry` assertion must fail.
2. Move it *below* `await initOAuthTables()` → the `registry < firstClient` assertion must fail.

- [ ] **Step 6: Verify a real gateway boots on a scratch home**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
S=/tmp/claude-1000/-home-kh0pp-crow/6d3ccab0-b825-43c7-b8e4-dddc847b9be3/scratchpad/bootcheck
rm -rf $S && mkdir -p $S/data
cd /home/kh0pp/crow-wt-rolling
CROW_HOME=$S CROW_DATA_DIR=$S/data CROW_DB_PATH=$S/data/crow.db \
CROW_AUTO_UPDATE=0 CROW_ALLOW_ORPHAN=1 PORT=3099 \
timeout 120 node servers/gateway/index.js --no-auth 2>&1 | tee $S/boot.log | head -60
```
Expected: `[migrations] deferred (will retry): 0001-board-stages` — a wiped instance has no `tasks_items` yet, so **deferred is the correct outcome here, not applied**. Gateway reaches its listen line. Then confirm `~/.crow/data/crow.db` mtime is unchanged.

- [ ] **Step 7: Full suite** — `npm test > …/suite-partA.log 2>&1`, then `grep -E "^# (tests|pass|fail|cancelled)"`. Expected `# fail 0`, `# cancelled 0`.

- [ ] **Step 8: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/index.js tests/migration-registry.test.js \
  -m "feat(gateway): run the per-instance migration registry at boot"
git show --stat HEAD
```

---

## Part 3 — converge + health gate

### Task 6: Addon health snapshot and the settled signal

**Files:** Modify `servers/gateway/proxy.js`; Create `servers/gateway/convergence.js`; Test `tests/convergence-unit.test.js`

**Interfaces:** Produces
- `healthSnapshot() → Record<string,string>` in `proxy.js` — **addons only** (`entry.isAddon`)
- `addonsSettled() → Promise<void>` in `proxy.js` — resolves when `initProxyServers`' connect loop finishes
- `compareHealth(before, after) → { ok, regressions: [{id, was, now}] }` in `convergence.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/convergence-unit.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectedServers, healthSnapshot } from "../servers/gateway/proxy.js";
import { compareHealth } from "../servers/gateway/convergence.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

test("healthSnapshot reports ADDONS ONLY, with their real status field", () => {
  connectedServers.clear();
  connectedServers.set("tasks", { status: "connected", isAddon: true });
  connectedServers.set("bots-sql-mcp", { status: "error", isAddon: true });
  connectedServers.set("instance-peer", { status: "offline", isRemote: true });   // federation peer
  connectedServers.set("some-integration", { status: "connected" });              // integration
  try {
    assert.deepEqual(healthSnapshot(), { tasks: "connected", "bots-sql-mcp": "error" },
      "a remote crow rebooting must never look like a LOCAL regression");
  } finally { connectedServers.clear(); }
});

test("compareHealth flags only REGRESSIONS, never pre-existing breakage", () => {
  // The Aug 3-5 state: tasks and bots-sql-mcp already down for an unrelated ABI
  // reason. An absolute gate would quarantine every good sha for that whole window.
  const before = { tasks: "error", "bots-sql-mcp": "error", "pm-workspace": "connected" };
  assert.equal(compareHealth(before, { ...before }).ok, true, "already-broken is not a regression");
  assert.equal(compareHealth(before, { ...before, tasks: "connected" }).ok, true, "improvement is not a regression");

  const broke = compareHealth(before, { ...before, "pm-workspace": "error" });
  assert.equal(broke.ok, false);
  assert.deepEqual(broke.regressions, [{ id: "pm-workspace", was: "connected", now: "error" }]);

  // disconnected is the transport.onclose path (proxy.js:180) — the likeliest real regression.
  assert.equal(compareHealth(before, { ...before, "pm-workspace": "disconnected" }).ok, false);

  const vanished = compareHealth(before, { tasks: "error", "bots-sql-mcp": "error" });
  assert.deepEqual(vanished.regressions, [{ id: "pm-workspace", was: "connected", now: "missing" }]);

  const multi = compareHealth({ a: "connected", b: "connected" }, { a: "error", b: "error" });
  assert.equal(multi.regressions.length, 2);
  assert.equal(compareHealth({}, { anything: "error" }).ok, true, "empty baseline never regresses");
});
```

- [ ] **Step 2: Verify it fails** — `Cannot find module '../servers/gateway/convergence.js'`.

- [ ] **Step 3: Add `healthSnapshot` and `addonsSettled` to proxy.js**

Insert before `export function getProxyStatus()`:

```js
/**
 * Addon id → connection status, for the convergence health gate.
 *
 * ADDONS ONLY. connectedServers also holds remote federation peers (whose status
 * flips to "offline" whenever a crow on another machine reboots) and data
 * backends. Including them would let a remote host's uptime quarantine this
 * host's sha.
 */
export function healthSnapshot() {
  const snap = {};
  for (const [id, entry] of connectedServers) if (entry.isAddon) snap[id] = entry.status;
  return snap;
}

let _settledResolve;
const _settled = new Promise((r) => { _settledResolve = r; });
/** Resolves once initProxyServers' addon-connect loop has finished. Addons
 *  connect SEQUENTIALLY at CONNECT_TIMEOUT_MS each, so total time is unbounded
 *  in addon count and no fixed grace window is correct. */
export function addonsSettled() { return _settled; }
export function _markAddonsSettled() { _settledResolve?.(); }
```

Then call `_markAddonsSettled()` at the end of the addon `for` loop in `initProxyServers` (after the loop at `proxy.js:337-344`), and also on the `entries.length === 0` early return, so it always resolves.

- [ ] **Step 4: Create convergence.js with the comparator**

```js
// servers/gateway/convergence.js
//
// An instance's job is to converge to the tree, not to pull. Pulling is a TREE
// operation (one winner among co-hosted gateways sharing a checkout); migrating
// and restarting are INSTANCE operations every gateway must perform with its own env.

/**
 * A REGRESSION check, not an absolute one. "Every addon connected" would
 * quarantine a perfectly good sha on any host that already had a broken addon —
 * precisely crow's state Aug 3-5. The gate answers "did this update break
 * something?", not "is everything perfect?".
 */
export function compareHealth(before, after) {
  const regressions = [];
  for (const [id, was] of Object.entries(before || {})) {
    if (was !== "connected") continue;             // already unhealthy — not ours
    const now = (after || {})[id] ?? "missing";
    if (now !== "connected") regressions.push({ id, was, now });
  }
  return { ok: regressions.length === 0, regressions };
}
```

- [ ] **Step 5: Run** — PASS.

- [ ] **Step 6: Mutation-test**
1. Drop the `entry.isAddon` filter → the federation-peer assertion fails.
2. `snap[id] = entry.state` (wrong field) → the snapshot test fails with `{tasks: undefined}`. *(This is the mutation the previous revision lacked: without a `healthSnapshot` test, a wrong field name would have left the entire gate silently dead with every test green.)*
3. Remove `if (was !== "connected") continue` → the already-broken and improvement assertions fail.
4. `?? "missing"` → `?? "connected"` → the vanished assertion fails.

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git add servers/gateway/convergence.js tests/convergence-unit.test.js
git commit servers/gateway/convergence.js servers/gateway/proxy.js tests/convergence-unit.test.js \
  -m "feat(convergence): addon-only health snapshot and regression comparison"
git show --stat HEAD
```

### Task 7: Boot cookie and convergence-quarantine namespace

**Files:** Modify `servers/gateway/convergence.js`; Test append.

**Interfaces:** Produces `PENDING_TTL_MS = 900000`, `QUARANTINE_TTL_MS = 86400000`; `writePending`, `readPending`, `clearPending`, `classifyPending`; `writeConvQuarantine({ appRoot, dataDir, sha, regressions, why, now })`, `readConvQuarantine({ appRoot, dataDir, now })`. Cookie at `<dataDir>/convergence-pending.json`; markers at `<appRoot>/.crow-convergence-quarantine.json` and `<dataDir>/.crow-convergence-quarantine.json`.

- [ ] **Step 1: Write the failing tests (append)**

```js
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePending, readPending, clearPending, classifyPending,
  writeConvQuarantine, readConvQuarantine, PENDING_TTL_MS, QUARANTINE_TTL_MS,
} from "../servers/gateway/convergence.js";

test("the tuned constants are pinned to their justified values", () => {
  // Both sides of a `now + PENDING_TTL_MS` assertion use the same constant, so
  // that form proves nothing. Pin the literals with their rationale.
  assert.equal(PENDING_TTL_MS, 15 * 60 * 1000,
    "must exceed a guarded SCHEMA_GENERATION migration plus a full SEQUENTIAL addon-connect pass");
  assert.equal(QUARANTINE_TTL_MS, 24 * 60 * 60 * 1000,
    "hard expiry so no failure mode ends in a host only manual file deletion recovers");
});

test("boot cookie round-trips, clears, and survives a torn write", () => {
  const d = mkdtempSync(join(tmpdir(), "cookie-"));
  try {
    const now = Date.parse("2026-08-06T12:00:00Z");
    writePending(d, { sha: "abc1234", baseline: { tasks: "connected" }, now });
    const p = readPending(d);
    assert.equal(p.sha, "abc1234");
    assert.deepEqual(p.baseline, { tasks: "connected" });
    assert.equal(Date.parse(p.deadline), now + 15 * 60 * 1000);   // literal, not the constant
    assert.equal(existsSync(join(d, "convergence-pending.json.tmp")), false, "tmp must be renamed away");
    clearPending(d);
    assert.equal(readPending(d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("classifyPending covers every boot case including the crash-loop", () => {
  const now = Date.parse("2026-08-06T12:00:00Z");
  const fresh   = { sha: "new1234", baseline: {}, deadline: new Date(now + 60_000).toISOString() };
  const expired = { sha: "new1234", baseline: {}, deadline: new Date(now - 1).toISOString() };
  const exact   = { sha: "new1234", baseline: {}, deadline: new Date(now).toISOString() };

  assert.equal(classifyPending(null, "new1234", now), "none");
  assert.equal(classifyPending(fresh, "new1234", now), "verify");
  assert.equal(classifyPending(expired, "new1234", now), "failed",
    "crash-loop: booted the target sha but died before verifying");
  assert.equal(classifyPending(expired, "old9999", now), "failed",
    "never booted the target sha at all");
  assert.equal(classifyPending(fresh, "old9999", now), "stale");
  assert.equal(classifyPending(exact, "new1234", now), "failed", "deadline boundary is inclusive");
});

test("convergence quarantine is its OWN namespace and hard-expires", () => {
  const root = mkdtempSync(join(tmpdir(), "convq-"));
  const dataDir = join(root, "data"); require("node:fs").mkdirSync(dataDir);
  try {
    const now = Date.parse("2026-08-06T12:00:00Z");
    writeConvQuarantine({ appRoot: root, dataDir, sha: "bad1234", regressions: [{ id: "x" }], why: "broke x", now });

    // It must NOT be written where migration-guard's readers look: index.js:141
    // would make a gateway boot skipping init-db entirely on an empty database.
    assert.equal(existsSync(join(root, ".crow-migration-quarantine.json")), false,
      "convergence must never write a migration-guard marker");
    assert.ok(existsSync(join(root, ".crow-convergence-quarantine.json")), "repo-level marker for peers");
    assert.ok(existsSync(join(dataDir, ".crow-convergence-quarantine.json")), "data-level marker");

    assert.equal(readConvQuarantine({ appRoot: root, dataDir, now: now + 1000 }).sha, "bad1234");
    assert.equal(readConvQuarantine({ appRoot: root, dataDir, now: now + 23 * 3600_000 }).sha, "bad1234");
    assert.equal(readConvQuarantine({ appRoot: root, dataDir, now: now + 25 * 3600_000 }), null,
      "a quarantine older than 24h must be ignored — no permanent wedge");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Verify it fails** — `writePending is not a function`.

- [ ] **Step 3: Implement** (append to `convergence.js`)

```js
import { readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

/** How long a convergence has to boot and verify before we call it failed.
 *  Exceeds a guarded SCHEMA_GENERATION migration plus a full SEQUENTIAL
 *  addon-connect pass (60s per addon, unbounded in count). */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/** Hard expiry on a convergence quarantine. No failure mode may end in a state
 *  only manual file deletion recovers from. */
export const QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000;

const PENDING_FILE = "convergence-pending.json";
const QUARANTINE_FILE = ".crow-convergence-quarantine.json";

/** Atomic: a crash mid-write must not leave torn JSON that readPending would
 *  silently swallow as "nothing pending". */
function writeAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

export function writePending(dataDir, { sha, baseline, now = Date.now() }) {
  const rec = { sha, baseline, deadline: new Date(now + PENDING_TTL_MS).toISOString() };
  writeAtomic(join(dataDir, PENDING_FILE), rec);
  return rec;
}
export const readPending = (dataDir) => readJson(join(dataDir, PENDING_FILE));
export function clearPending(dataDir) { try { unlinkSync(join(dataDir, PENDING_FILE)); } catch {} }

/**
 *   none   — nothing pending.
 *   verify — we ARE the boot this cookie was written for, with time left.
 *   failed — the deadline passed uncleared: either the target never booted, or
 *            it booted and died before verifying.
 *   stale  — a live cookie for a sha we are not running.
 */
export function classifyPending(pending, bootSha, now = Date.now()) {
  if (!pending) return "none";
  if (Date.parse(pending.deadline) <= now) return "failed";
  return pending.sha === bootSha ? "verify" : "stale";
}

/**
 * Convergence quarantine — its OWN namespace, deliberately NOT migration-guard's
 * markers. Two existing readers consume those with no knowledge of why they were
 * written: index.js:141 would boot a gateway skipping init-db (on an empty DB,
 * that means serving with no tables), and auto-update.js:318 would block all
 * updates host-wide while printing `gen undefined->undefined`. An addon flapping
 * must not be able to disable schema initialization.
 *
 * Written at BOTH repo and data level: the repo-level file is what co-hosted
 * peers sharing the checkout read.
 */
export function writeConvQuarantine({ appRoot, dataDir, sha, regressions = [], why = "", now = Date.now() }) {
  const marker = { sha, why, regressions, at: new Date(now).toISOString() };
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    try { writeAtomic(p, marker); } catch {}
  }
  return marker;
}

/** The active marker, or null. Anything past QUARANTINE_TTL_MS is ignored. */
export function readConvQuarantine({ appRoot, dataDir, now = Date.now() }) {
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    const m = readJson(p);
    if (!m) continue;
    if (now - Date.parse(m.at) > QUARANTINE_TTL_MS) continue;
    return m;
  }
  return null;
}
export function clearConvQuarantine({ appRoot, dataDir }) {
  for (const p of [join(appRoot, QUARANTINE_FILE), join(dataDir, QUARANTINE_FILE)]) {
    try { unlinkSync(p); } catch {}
  }
}
```

Replace the `require("node:fs").mkdirSync` in the test with a top-level `mkdirSync` import.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Mutation-test**
1. Swap the deadline and sha checks in `classifyPending` → the `classifyPending(expired,"old9999") === "failed"` assertion fails. *(Note: the crash-loop assertion does NOT move under this mutation — naming it would be a false mutation claim.)*
2. `<=` → `<` in the deadline check → the boundary assertion fails.
3. Make `writeAtomic` a plain `writeFileSync` to `path` → the `.tmp` assertion still passes; instead assert it by mutating `renameSync` to a no-op → `readPending` returns null and the round-trip fails.
4. Point `writeConvQuarantine` at `.crow-migration-quarantine.json` → the namespace assertion fails.
5. Delete the TTL check in `readConvQuarantine` → the 25 h assertion fails.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/convergence.js tests/convergence-unit.test.js \
  -m "feat(convergence): boot cookie and a convergence-specific quarantine namespace

Its own marker files, hard-expiring after 24h, so an addon flap can never
disable schema initialization or wedge the host permanently."
git show --stat HEAD
```

### Task 8: The executable gate — two instances, one checkout (MUST FAIL)

Reproduces the starvation through the **real production path** (`checkForUpdates`), not a side entry point. Expected RED until Task 9.

**Files:** Create `tests/convergence-two-instance.test.js`

- [ ] **Step 1: Write the harness**

```js
// tests/convergence-two-instance.test.js
//
// The executable gate. TWO instance data dirs share ONE git checkout, exactly as
// crow-gateway / crow-mpa-gateway / crow-r4-gateway share ~/crow. Moving origin
// forward must leave BOTH instances migrated — including the one that LOSES the
// checkout lock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { checkForUpdates, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";
import { _setAlertChannelsForTest } from "../servers/shared/migration-guard.js";

// Never let the suite believe it is supervised — the restart branch would arm
// this process's exit chain.
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

// The update failure paths call fireMigrationAlert. Unstubbed, the suite sends a
// REAL ntfy push and email.
_setAlertChannelsForTest({ sendNtfyNotification: async () => {}, sendEmailNotification: async () => {} });

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();

/** A DB stub matching the shape auto-update's saveSetting/getSettings expect. */
function stubDb(rows = [{ key: "auto_update_enabled", value: "true" }]) {
  const writes = [];
  return { writes, execute: async ({ sql, args }) => {
    if (/^SELECT/i.test(sql)) return { rows };
    writes.push({ key: args?.[0], value: args?.[1] }); return { rows: [] };
  } };
}

const _fixtures = [];
after(() => {
  _setAppRootForTest(REAL_APP_ROOT);      // MUST restore, even on failure
  _setDbForTest(null);
  for (const f of _fixtures) f.cleanup();
  _fixtures.length = 0;
});

export function twoInstanceFixture() {
  const root = mkdtempSync(join(tmpdir(), "converge-"));
  const origin = join(root, "origin.git"), work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t"); g(work, "config", "user.name", "t");
  mkdirSync(join(work, "scripts", "migrations"), { recursive: true });
  // runLockedUpdate CHECKS init-db's exit code; without this the fixture update
  // always reports failure and withholds the restart.
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  g(work, "add", "-A"); g(work, "commit", "-m", "seed"); g(work, "push", "origin", "main");

  const instances = ["alpha", "beta"].map((name) => {
    const dataDir = join(root, name, "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "crow.db"), tasksDbPath = join(dataDir, "tasks.db");
    const t = new Database(tasksDbPath);
    t.prepare("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT)").run();
    t.close();
    new Database(dbPath).close();
    return { name, dataDir, dbPath, tasksDbPath };
  });

  const advanceOrigin = (filename, body) => {
    writeFileSync(join(work, "scripts", "migrations", filename), body);
    g(work, "add", "-A"); g(work, "commit", "-m", `add ${filename}`); g(work, "push", "origin", "main");
    g(work, "reset", "--hard", "HEAD~1");        // the shared checkout is now genuinely behind
  };
  const f = { root, origin, work, instances, advanceOrigin,
              cleanup: () => rmSync(root, { recursive: true, force: true }) };
  _fixtures.push(f);
  return f;
}

// A bare `import Database from "better-sqlite3"` cannot resolve from os.tmpdir()
// — there is no node_modules on that path. Bake in the resolved absolute URL.
const BS3 = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
export const MIGRATION_BODY = `
import Database from ${JSON.stringify(BS3)};
export const id = "0002-converge-probe";
export function run({ tasksDbPath }) {
  const d = new Database(tasksDbPath);
  const have = d.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  if (!have.includes("probe")) d.prepare("ALTER TABLE tasks_items ADD COLUMN probe TEXT").run();
  d.close();
}`;

export function hasProbe(tasksDbPath) {
  const d = new Database(tasksDbPath);
  const cols = d.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
  d.close();
  return cols.includes("probe");
}

test("BOTH co-hosted instances converge — the lock loser must not starve", async () => {
  const f = twoInstanceFixture();
  f.advanceOrigin("0002-converge-probe.mjs", MIGRATION_BODY);
  _setAppRootForTest(f.work);

  // alpha: no contention, wins the lock, pulls, converges.
  _setDbForTest(stubDb());
  const a = await checkForUpdates({ instance: f.instances[0] });

  // beta: HOLD the lock so beta genuinely LOSES it. Sequential awaited calls do
  // NOT contend — checkForUpdates releases in a finally, so without this beta
  // would simply find "already up to date" and the gate would prove nothing.
  const lockFile = join(f.work, ".git", "crow-auto-update.lock");
  writeFileSync(lockFile, `${process.pid}\n${new Date().toISOString()}\n`);
  _setDbForTest(stubDb());
  const b = await checkForUpdates({ instance: f.instances[1] });
  rmSync(lockFile, { force: true });

  assert.equal(b.skipped, "locked", "beta must actually have taken the lock-loss path");
  assert.ok(hasProbe(f.instances[0].tasksDbPath), "alpha (lock winner) must be migrated");
  assert.ok(hasProbe(f.instances[1].tasksDbPath),
    "beta LOST the lock and must STILL migrate its own stores — this is the starvation bug");
  assert.equal(a.pulled, true, "the lock winner performs the pull");
  assert.equal(b.pulled, false, "the lock loser must not pull — the tree is shared");
  assert.equal(b.converged, true, "the lock loser must still converge");
});
```

- [ ] **Step 2: Confirm it fails for the RIGHT reason**

Run: `node --test tests/convergence-two-instance.test.js`
Expected: FAIL because `b.converged` is `undefined` and beta has no `probe` column — the lock loser returns early today. It must NOT fail on a missing module, a `better-sqlite3` resolution error, or an init-db exit code; if it does, fix the fixture first. Do not stub anything to make it pass.

- [ ] **Step 3: Commit the failing gate** (deliberate — the branch is not merged until Task 12)

```bash
cd /home/kh0pp/crow-wt-rolling
git add tests/convergence-two-instance.test.js
git commit tests/convergence-two-instance.test.js \
  -m "test(convergence): failing two-instance gate reproducing lock starvation

Drives the real checkForUpdates path and holds the lock so the loser
genuinely loses it. Expected RED until the converge restructure lands."
git show --stat HEAD
```

### Task 9: Restructure checkForUpdates — the instance half always runs

Turns Task 8's gate green.

**Files:** Modify `servers/gateway/auto-update.js`, `servers/gateway/convergence.js`

**Interfaces:** Produces
- `convergeInstance({ appRoot, instance, pulled, log }) → Promise<{ pulled, converged, sha, applied, skipped? }>` in `convergence.js`
- `checkForUpdates({ instance? })` now returns `{ ...treeResult, pulled, converged }`
- `resolveInstance()` in `convergence.js` → `{ dataDir, dbPath, tasksDbPath }` from env (production default when no `instance` is injected)

- [ ] **Step 1: Confirm the gate is still red** — `b.converged === undefined`.

- [ ] **Step 2: Move the restart OUT of runLockedUpdate's success path**

In `runLockedUpdate`, delete the `scheduleSupervisedRestart(log, "Restarting gateway to apply update...")` call on the success path (~line 505). **Keep** the one on the migration-guard loss path (~line 463) — that exists to reopen a restored DB file and is unrelated. Convergence now owns the restart: otherwise the winner's 1.5 s exit timer fires while its own migrations are still running (an interrupted `ALTER` on a live store), and the boot cookie — which must be written *before* the restart — may never be written.

Export it so convergence can call it: `export function scheduleSupervisedRestart(log, message) { ... }`.

- [ ] **Step 3: Restructure `checkForUpdates`**

Replace the lock-loss early return (lines 209-223) so it **falls through**:

```js
    const lock = await lockPath();
    const held = lock ? acquireLock(lock) : null;
    let treeResult = { updated: false }, pulled = false;
    if (lock && !held) {
      // NOT an error and NOT a reason to stop. The tree is shared: another
      // co-hosted gateway is pulling it, which is exactly right. This instance
      // skips the PULL and still converges itself.
      const info = readLock(lock);
      const msg = `Tree pull skipped: another instance holds the checkout lock (pid ${info?.pid ?? "unknown"})`;
      log(msg);
      await saveSetting("auto_update_last_check", new Date().toISOString());
      await saveSetting("auto_update_last_result", msg);
      treeResult = { updated: false, skipped: "locked", message: msg };
    } else {
      try { treeResult = await runLockedUpdate(log); }
      finally { if (held) releaseLock(held); }
      pulled = Boolean(treeResult?.updated);
    }

    // The INSTANCE half — always, for every gateway, lock or no lock.
    const { convergeInstance } = await import("./convergence.js");
    const conv = await convergeInstance({ instance, pulled, log });
    return { ...treeResult, pulled, converged: conv.converged, applied: conv.applied };
```

and change the signature to `export async function checkForUpdates({ instance = null } = {})`.

- [ ] **Step 4: Implement `convergeInstance`**

```js
import { execFile } from "node:child_process";
function git(cwd, args) {
  return new Promise((resolve) => execFile("git", args, { cwd, timeout: 120000 },
    (err, so, se) => resolve({ stdout: (so||"").trim(), stderr: (se||"").trim(), code: err ? err.code||1 : 0 })));
}

/** This process's paths, from env, matching how the stores actually resolve. */
export async function resolveInstance() {
  const { resolveDataDir } = await import("../db.js");
  const { resolveGuardDbPath } = await import("../shared/migration-guard.js");
  const { tasksDbPath } = await import("../../scripts/pi-bots/instance-paths.mjs");
  return { dataDir: resolveDataDir(), dbPath: resolveGuardDbPath(resolveDataDir), tasksDbPath: tasksDbPath() };
}

/** The sha this process booted on. Captured once — convergence compares against
 *  it, NOT against `pulled`: runLockedUpdate returns updated:false on several
 *  branches AFTER the tree has already moved (quarantine skip, init-db failure,
 *  the loss-and-rollback path). Deciding on that flag would let peers converge
 *  into code the winner had just explicitly refused. */
let BOOT_SHA = null;
export function setBootSha(sha) { BOOT_SHA = sha; }
export function getBootSha() { return BOOT_SHA; }

export async function convergeInstance({ appRoot, instance = null, pulled = false, log = () => {} } = {}) {
  if (process.env.CROW_DISABLE_CONVERGE === "1" || process.env.CROW_DISABLE_CONVERGE === "true") {
    log("convergence disabled via CROW_DISABLE_CONVERGE");
    return { pulled, converged: false, skipped: "disabled", sha: null, applied: [] };
  }
  const root = appRoot || (await import("node:path")).dirname(
    (await import("node:path")).dirname((await import("node:path")).dirname(
      (await import("node:url")).fileURLToPath(import.meta.url))));
  const inst = instance || (await resolveInstance());
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout;

  // Quarantine gates the MIGRATE-AND-RESTART, never the pull, and the tree half
  // has already run above. A guard placed before the pull is a fleet deadlock: a
  // blocked peer never fetches, so the checkout never moves past the bad sha, so
  // the escape can never fire.
  const q = readConvQuarantine({ appRoot: root, dataDir: inst.dataDir });
  if (q && q.sha === head) {
    log(`refusing to converge: ${head.slice(0, 9)} is quarantined (${q.why})`);
    return { pulled, converged: false, skipped: "quarantined", sha: head, applied: [] };
  }

  const boot = getBootSha();
  if (boot && boot === head) return { pulled, converged: false, skipped: "current", sha: head, applied: [] };

  const { runMigrations } = await import("../../scripts/migrations/runner.mjs");
  const { join } = await import("node:path");
  const res = await runMigrations({
    migrationsDir: join(root, "scripts", "migrations"),
    dbPath: inst.dbPath, tasksDbPath: inst.tasksDbPath, sha: head, log,
  });

  // Baseline BEFORE the restart, from the still-live process, then hand it
  // across the restart in the cookie.
  let baseline = {};
  try { ({ healthSnapshot: baseline } = {}); const p = await import("./proxy.js"); baseline = p.healthSnapshot(); } catch {}
  writePending(inst.dataDir, { sha: head, baseline });

  const au = await import("./auto-update.js");
  au.scheduleSupervisedRestart(log, `Restarting to run ${head.slice(0, 9)}...`);
  return { pulled, converged: true, sha: head, applied: res.applied };
}
```

Clean up the `baseline` line to a plain `try { const p = await import("./proxy.js"); baseline = p.healthSnapshot(); } catch {}` when implementing.

- [ ] **Step 5: Capture the boot sha at gateway start**

In `servers/gateway/index.js`, immediately after the registry block, add:
```js
try {
  const { execFileSync } = await import("node:child_process");
  const { setBootSha } = await import("./convergence.js");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const _r = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  setBootSha(execFileSync("git", ["rev-parse", "HEAD"], { cwd: _r, timeout: 10000 }).toString().trim());
} catch {}
```

- [ ] **Step 6: Run the gate** — `node --test tests/convergence-two-instance.test.js` → PASS, with `b.skipped === "locked"` and beta migrated.

- [ ] **Step 7: Mutation-test — the most important step in this plan**

1. Restore the early `return` in the lock-loss branch → **beta must fail.** *(Under the previous harness this mutation could not go red, because sequential calls never contended. If it stays green now, the gate is still worthless — stop and fix it.)*
2. Guard the instance half with `if (pulled) { ... }` → beta must fail.
3. Delete `assert.equal(b.skipped, "locked")` mentally and re-run mutation 1 — confirm the *probe-column* assertion also moves, so the gate does not rest on the status string alone.
4. Make `convergeInstance` return before `writePending` → Task 10's verification tests fail.

- [ ] **Step 8: Existing auto-update tests** — `node --test tests/auto-update-hardening.test.js tests/auto-update-ci-gate.test.js tests/auto-update-tick-gate.test.js`. These call `checkForUpdates()` with no argument; the new optional-object signature must keep them passing. The lock-skip message changed — update any assertion to the new text and confirm it still asserts behavior, not just a string.

- [ ] **Step 9: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/auto-update.js servers/gateway/convergence.js servers/gateway/index.js \
  -m "feat(convergence): every instance converges, only one pulls

Restructures checkForUpdates so the lock loser falls through to the instance
half instead of returning. Convergence owns the restart so it cannot fire
mid-migration or before the boot cookie is written."
git show --stat HEAD
```

### Task 10: Boot-time verification and quarantine on regression

**Files:** Modify `servers/gateway/convergence.js`, `servers/gateway/boot/post-listen.js`; Test append (two-instance file).

**Interfaces:** Produces `verifyPendingConvergence({ dataDir, appRoot, bootSha, snapshot, settled, now, log }) → Promise<{ verdict, regressions? }>`; verdicts `none|stale|ok|quarantined`.

- [ ] **Step 1: Write the failing tests (append)**

```js
import { verifyPendingConvergence, writePending, readPending,
         readConvQuarantine } from "../servers/gateway/convergence.js";

test("a health regression quarantines the sha; peers then refuse to converge", async () => {
  const f = twoInstanceFixture();
  const [alpha, beta] = f.instances;
  _setAppRootForTest(f.work);
  // Quarantine the fixture's ACTUAL head — in production the shared tree STAYS
  // at the bad sha, which is the whole case this design has to handle.
  const badSha = g(f.work, "rev-parse", "HEAD");
  writePending(alpha.dataDir, { sha: badSha, baseline: { "pm-workspace": "connected" } });

  const out = await verifyPendingConvergence({
    dataDir: alpha.dataDir, appRoot: f.work, bootSha: badSha,
    snapshot: () => ({ "pm-workspace": "error" }),
    settled: async () => {},
  });
  assert.equal(out.verdict, "quarantined");
  assert.deepEqual(out.regressions, [{ id: "pm-workspace", was: "connected", now: "error" }]);
  assert.equal(readPending(alpha.dataDir), null, "cookie must be cleared either way");
  assert.equal(readConvQuarantine({ appRoot: f.work, dataDir: alpha.dataDir }).sha, badSha);

  const { convergeInstance, setBootSha } = await import("../servers/gateway/convergence.js");
  setBootSha("something-older");
  const r = await convergeInstance({ appRoot: f.work, instance: beta });
  assert.equal(r.converged, false, "a peer must not converge to a quarantined sha");
  assert.equal(r.skipped, "quarantined");
});

test("a healthy convergence clears the cookie and quarantines nothing", async () => {
  const f = twoInstanceFixture();
  const [alpha] = f.instances;
  const sha = g(f.work, "rev-parse", "HEAD");
  writePending(alpha.dataDir, { sha, baseline: { tasks: "connected" } });
  const out = await verifyPendingConvergence({
    dataDir: alpha.dataDir, appRoot: f.work, bootSha: sha,
    snapshot: () => ({ tasks: "connected" }), settled: async () => {},
  });
  assert.equal(out.verdict, "ok");
  assert.equal(readPending(alpha.dataDir), null);
  assert.equal(readConvQuarantine({ appRoot: f.work, dataDir: alpha.dataDir }), null);
});

test("a snapshot that throws FAILS OPEN and always settles", async () => {
  const f = twoInstanceFixture();
  const [alpha] = f.instances;
  const sha = g(f.work, "rev-parse", "HEAD");
  writePending(alpha.dataDir, { sha, baseline: { tasks: "connected" } });
  const out = await verifyPendingConvergence({
    dataDir: alpha.dataDir, appRoot: f.work, bootSha: sha,
    snapshot: () => { throw new Error("proxy not ready"); }, settled: async () => {},
  });
  // Spec: "health gate cannot determine status -> unknown, FAIL OPEN". An
  // unhandled rejection here would crash the gateway on Node 22 and the outer
  // promise would never settle.
  assert.equal(out.verdict, "unknown");
  assert.equal(readConvQuarantine({ appRoot: f.work, dataDir: alpha.dataDir }), null,
    "an indeterminate gate must not quarantine");
});
```

- [ ] **Step 2: Verify it fails** — `verifyPendingConvergence is not a function`.

- [ ] **Step 3: Implement**

```js
/**
 * Called at boot. Decides what the cookie left by the previous convergence means.
 * `snapshot` and `settled` are injected so tests need not wait on the real
 * addon-connect loop.
 */
export async function verifyPendingConvergence({
  dataDir, appRoot, bootSha, snapshot, settled,
  now = Date.now(), log = () => {},
}) {
  const pending = readPending(dataDir);
  const verdict = classifyPending(pending, bootSha, now);
  if (verdict === "none") return { verdict: "none" };
  if (verdict === "stale") { clearPending(dataDir); return { verdict: "stale" }; }

  const quarantine = async (sha, regressions, why) => {
    writeConvQuarantine({ appRoot, dataDir, sha, regressions, why });
    clearPending(dataDir);
    try {
      const { fireMigrationAlert } = await import("../shared/migration-guard.js");
      await fireMigrationAlert({
        title: "Crow update quarantined: convergence failed",
        body: `This instance converged to ${String(sha).slice(0, 9)} and ${why}. That sha is `
            + `quarantined for 24h — no gateway on this host will converge to it. The tree was `
            + `NOT rolled back: co-hosted instances may be running it healthily.`,
      });
    } catch {}
    log(`convergence to ${String(sha).slice(0, 9)} quarantined — ${why}`);
    return { verdict: "quarantined", regressions };
  };

  if (verdict === "failed") {
    return quarantine(pending.sha, [], "never completed a healthy boot before its deadline");
  }

  // verdict === "verify". Everything below is wrapped: an unhandled rejection
  // here would take the gateway down on Node 22, and the spec requires the gate
  // to fail OPEN when it cannot determine status.
  try {
    await settled();
    const after = snapshot();
    const cmp = compareHealth(pending.baseline, after);
    if (cmp.ok) {
      clearPending(dataDir);
      log(`convergence to ${String(pending.sha).slice(0, 9)} verified healthy`);
      return { verdict: "ok" };
    }
    return await quarantine(pending.sha, cmp.regressions,
      `broke ${cmp.regressions.map((r) => r.id).join(", ")}`);
  } catch (err) {
    clearPending(dataDir);
    log(`health gate indeterminate (${err.message}) — failing open, not quarantining`);
    return { verdict: "unknown" };
  }
}
```

- [ ] **Step 4: Wire into post-listen.js** after the `startAutoUpdate(...)` call (~line 186):

```js
  // Verify the convergence that caused this restart, if there was one.
  import("../convergence.js").then(async (conv) => {
    const { healthSnapshot, addonsSettled } = await import("../proxy.js");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const inst = await conv.resolveInstance();
    await conv.verifyPendingConvergence({
      dataDir: inst.dataDir, appRoot, bootSha: conv.getBootSha(),
      snapshot: healthSnapshot, settled: addonsSettled,
      log: (m) => console.log(`[convergence] ${m}`),
    });
  }).catch((err) => console.warn("[convergence] verification skipped:", err.message));
```

- [ ] **Step 5: Run** — `node --test tests/convergence-two-instance.test.js tests/migration-guard.test.js` → PASS (migration-guard is untouched by this design and must stay green).

- [ ] **Step 6: Mutation-test**
1. Remove `clearPending` from the healthy path → the "clears the cookie" assertion fails.
2. Make the peer guard in `convergeInstance` return `converged: true` → the peer-refusal assertion fails.
3. `compareHealth(pending.baseline, after)` → `compareHealth({}, after)` → the regression test fails (it would make every convergence look healthy).
4. Remove the `try/catch` around the verify branch → the fail-open test fails (and likely crashes the runner, which is the point).
5. Point `writeConvQuarantine` at migration-guard's `writeQuarantine` → `migration-guard.test.js` or the namespace assertion in Task 7 fails.

- [ ] **Step 7: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/convergence.js servers/gateway/boot/post-listen.js tests/convergence-two-instance.test.js \
  -m "feat(convergence): boot-time health verification with quarantine on regression

Gates convergence, never the pull, so the tree can always move past a bad
sha. Fails open when the gate cannot determine status."
git show --stat HEAD
```

### Task 11: De-phase-lock the timers, and record real HEAD when disabled

**Files:** Modify `servers/gateway/auto-update.js`; Test append (unit file).

**Interfaces:** Produces `instanceJitterMs(key) → number` in `[0, 600000)`.

- [ ] **Step 1: Write the failing tests (append)**

```js
import { startAutoUpdate, stopAutoUpdate, _setDbForTest, instanceJitterMs }
  from "../servers/gateway/auto-update.js";
import { execFileSync } from "node:child_process";

test("instanceJitterMs is stable per instance and differs between instances", () => {
  const a = instanceJitterMs("/home/kh0pp/.crow/data");
  const b = instanceJitterMs("/home/kh0pp/.crow-mpa/data");
  const c = instanceJitterMs("/home/kh0pp/.crow-r4/data");
  assert.equal(a, instanceJitterMs("/home/kh0pp/.crow/data"), "must be deterministic");
  assert.notEqual(a, b); assert.notEqual(b, c); assert.notEqual(a, c);
  for (const k of Array.from({ length: 500 }, (_, i) => `/tmp/inst-${i}/data`)) {
    const v = instanceJitterMs(k);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 600000, `jitter ${v} out of range for ${k}`);
  }
});

test("the jitter is actually WIRED IN — the first-check delay differs per instance", async () => {
  // Without this the pure function could be perfect and the delay still fixed.
  const seen = [];
  const orig = console.log;
  console.log = (...a) => seen.push(a.join(" "));
  try {
    for (const dir of ["/tmp/jit-a/data", "/tmp/jit-b/data"]) {
      process.env.CROW_DATA_DIR = dir;
      _setDbForTest({ execute: async ({ sql }) =>
        /^SELECT/i.test(sql) ? { rows: [{ key: "auto_update_enabled", value: "true" }] } : { rows: [] } });
      await startAutoUpdate({ execute: async () => ({ rows: [] }) }, {});
      stopAutoUpdate();
    }
  } finally { console.log = orig; delete process.env.CROW_DATA_DIR; _setDbForTest(null); }
  const delays = seen.filter((l) => l.includes("first check in")).map((l) => l.match(/in (\d+)s/)?.[1]);
  assert.equal(delays.length, 2);
  assert.notEqual(delays[0], delays[1], "two instances must not share a first-check phase");
});

test("a DISABLED instance still records its ACTUAL running sha", async () => {
  delete process.env.CROW_AUTO_UPDATE;   // shouldStartAutoUpdate gates on this
  const writes = [];
  const db = { execute: async ({ sql, args }) => {
    if (/^SELECT/i.test(sql)) return { rows: [{ key: "auto_update_enabled", value: "false" }] };
    writes.push({ key: args[0], value: args[1] }); return { rows: [] };
  } };
  await startAutoUpdate(db, {});
  stopAutoUpdate();
  const v = writes.find((w) => w.key === "auto_update_current_version");
  assert.ok(v, "must record even when disabled — Gap 4b is a version it has not run");
  const real = execFileSync("git", ["rev-parse", "--short", "HEAD"],
    { cwd: join(import.meta.dirname, "..") }).toString().trim();
  assert.equal(v.value, real, "must be THIS checkout's sha, not merely sha-shaped");
});
```

- [ ] **Step 2: Verify it fails** — `instanceJitterMs is not a function`.

- [ ] **Step 3: Implement**

```js
const JITTER_WINDOW_MS = 10 * 60 * 1000;

/**
 * A stable per-instance offset for the first update check. Co-hosted gateways
 * restart together, so a fixed 5-minute first check put all of them on the same
 * millisecond forever — their checks landed 475ms apart and the same instance
 * lost the lock every tick. Robustness only: the real fix is that the loser
 * converges anyway.
 */
export function instanceJitterMs(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % JITTER_WINDOW_MS;
}
```

In `startAutoUpdate`, move the version write **above** the disabled return:

```js
  const settings = await getSettings();
  // Record the sha this process is ACTUALLY running, before any early return.
  // Previously this sat below the disabled return, so a disabled instance froze
  // its reported version while continuing to run whatever the tree moved to.
  try {
    const ref = await run("git", ["rev-parse", "--short", "HEAD"]);
    if (ref.code === 0 && ref.stdout) await saveSetting("auto_update_current_version", ref.stdout);
  } catch {}
  if (settings.auto_update_enabled !== "true") { console.log("[auto-update] Disabled in settings"); return; }
```

and replace the fixed first delay:

```js
  const { resolveDataDir } = await import("../db.js");
  const firstDelay = 5 * 60 * 1000 + instanceJitterMs(resolveDataDir());
  console.log(`[auto-update] Enabled — checking every ${hours}h (first check in ${Math.round(firstDelay/1000)}s)`);
  updateTimer = setTimeout(async () => {
    await tickCheck().catch((e) => console.error("[auto-update] tick failed:", e.message));
    updateTimer = setInterval(() => { tickCheck().catch(() => {}); }, intervalMs);
  }, firstDelay);
```

The added `.catch` matters: `tickCheck` now reaches `runMigrations`, which **can** reject, and an unhandled rejection in that timer would take the gateway down.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Mutation-test**
1. `return 0` from `instanceJitterMs` → both the differ-between-instances and the wired-in assertions fail.
2. Drop `% JITTER_WINDOW_MS` → the 500-key range assertion fails.
3. Revert the version write below the `return` → the disabled-instance test fails.
4. Record `origin/main`'s sha instead of HEAD → the equality assertion fails (a regex-shaped assertion would not have caught this).
5. Restore the fixed `5 * 60 * 1000` delay → the wired-in test fails.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow-wt-rolling
git commit servers/gateway/auto-update.js tests/convergence-unit.test.js \
  -m "fix(auto-update): de-phase-lock co-hosted checks; record the running sha when disabled"
git show --stat HEAD
```

### Task 12: Kill switch test, docs, whole-branch review, acceptance, merge, report

**Files:** Modify `docs/architecture/gateway.md`; Test append.

- [ ] **Step 1: Kill-switch test (append to the unit file)**

```js
test("CROW_DISABLE_CONVERGE short-circuits convergence entirely", async () => {
  const { convergeInstance } = await import("../servers/gateway/convergence.js");
  process.env.CROW_DISABLE_CONVERGE = "1";
  try {
    // Bogus paths are deliberate: if the switch works, nothing touches the
    // filesystem or git, so they cannot fail.
    const r = await convergeInstance({ appRoot: "/nonexistent", instance:
      { dataDir: "/nonexistent", dbPath: "/nonexistent/x.db", tasksDbPath: "/nonexistent/t.db" } });
    assert.equal(r.converged, false);
    assert.equal(r.skipped, "disabled");
  } finally { delete process.env.CROW_DISABLE_CONVERGE; }
});
```

The switch is already the first statement in `convergeInstance` (Task 9), so this should pass immediately — confirm by mutating it to run second and watching the test error on ENOENT rather than assert cleanly.

- [ ] **Step 2: Document** in `docs/architecture/gateway.md`: the converge-vs-pull split and why a lock loss is normal; the migration registry and how to add an entry (`scripts/migrations/NNNN-slug.mjs` exporting `id` and `run`, returning `{deferred:true}` when targets are absent); the health gate as a regression check waiting on the addon-settled signal; quarantine-not-rollback, its own namespace, the 24 h expiry, and how to clear a marker; `CROW_DISABLE_CONVERGE=1`. Check EN/ES parity if any user-facing string was added (the gate is live; architecture docs are EN-only).

- [ ] **Step 3: Full suite**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-rolling
npm test > /tmp/claude-1000/-home-kh0pp-crow/6d3ccab0-b825-43c7-b8e4-dddc847b9be3/scratchpad/suite-final.log 2>&1
grep -E "^# (tests|suites|pass|fail|cancelled|skipped)" …/suite-final.log
```
Expected `# fail 0`, `# cancelled 0`, `# tests` ≥ 2961 + the new ones. A nonzero `cancelled` is the known whole-file-cancel flake under load — re-run that file alone before treating it as real.

- [ ] **Step 4: Audit the branch**

```bash
git log --format='%an <%ae>%n%b' origin/main..HEAD | grep -iE "claude|co-authored|anthropic" && echo "ATTRIBUTION — FIX" || echo clean
git diff origin/main..HEAD | grep -iE "DROP TABLE|DELETE FROM" || echo "no new DROP/DELETE — migration-expectations.js unaffected"
git diff origin/main..HEAD -- servers/shared/schema-version.js | head -1 || true   # must be empty: no gen bump
git diff origin/main..HEAD | grep -iE "listen\(|PORT" || echo "no new host port — port-allocation.md unaffected"
```
Also confirm `.crow-convergence-quarantine.json` is gitignored — `convergeInstance` writes it into the repo root, which three gateways and the `pibot-gateways@r4` soak share. Add it to `.gitignore` if absent.

- [ ] **Step 5: Adversarial whole-branch review**

Named concerns: the fall-through under real concurrency; whether any quarantine path can wedge an instance past the 24 h expiry; whether `verifyPendingConvergence` can leak a promise; whether the boot-order invariant holds at runtime and not just in source text; whether the registry's tick-time run (outside the boot ordering) is safe against the WAL keeper; and whether any test is vacuous.

- [ ] **Step 6: Wiped-scratch acceptance**

```bash
S=…/scratchpad/accept; rm -rf $S && mkdir -p $S/data
CROW_HOME=$S CROW_DATA_DIR=$S/data CROW_DB_PATH=$S/data/crow.db \
CROW_AUTO_UPDATE=0 CROW_ALLOW_ORPHAN=1 PORT=3099 \
timeout 120 node servers/gateway/index.js --no-auth 2>&1 | tee $S/accept.log | head -80
```
Expected: `[migrations] deferred (will retry): 0001-board-stages` (**deferred, not applied** — a wiped instance has no `tasks_items`), gateway listens, no `[convergence]` quarantine, live DB mtimes unchanged.

- [ ] **Step 7: Push, verify check-runs, merge**

```bash
git pull --rebase origin main && git push
SHA=$(git rev-parse HEAD)
curl -s "https://api.github.com/repos/kh0pper/crow/commits/$SHA/check-runs" \
 | python3 -c "import json,sys;d=json.load(sys.stdin);[print(r['name'],r['status'],r['conclusion']) for r in d['check_runs']]"
```
All of `suite`/`static-checks`/`audit` `completed success`. An empty result on a current sha means something is WRONG.

- [ ] **Step 8: Deploy and verify the fleet**

Deploy to all five. Use `r4-deploy.sh` for r4, normal restarts for primary/MPA, tight windows. From DB **copies** confirm `auto_update_current_version` matches the real running sha on **every** instance including r4 (the Gap 4b fix proving itself). Confirm no `.crow-convergence-quarantine.json` exists. Confirm `pibot-gateways@r4` is still active and log a timestamp if the deploy touched `scripts/pi-bots/`.

- [ ] **Step 9: Report on card #120** in `~/.crow-r4/data/tasks.db` (`tasks_items`) — syncs to Monday, keep it accurate. Record what shipped, that `r4-deploy.sh` is **uncommitted** for the PM session to fold into Gitea, verification results, and that Phase 3 was deliberately not built. Set `done` only after Step 8 passes.

- [ ] **Step 10: Present the r4 auto-update question** — with convergence merged, `auto_update_enabled` could return for r4. Operator's call; present the Step 8 evidence and change nothing without an explicit yes.

---

## Self-Review

| Spec requirement | Task |
|---|---|
| Gap 1 — migrations travel with code | 3, 4, 5 |
| Gap 1 — deferral, not false "applied" | 3, 4 |
| Gap 2 — bundle copies travel (with per-instance exclusions) | 1 |
| Gap 3 — health verified | 6, 10 |
| Gap 4 — lock starvation (fall-through, real path) | 8, 9 |
| Gap 4b — disabled instance version lies | 11 |
| Lazy `schema_migrations`, no generation bump | 3, 12 |
| Registry scope = crow.db + tasks.db only | 3, 4 |
| Order invariant (+ mutation) | 5 |
| Regression-not-absolute gate, addons only | 6 |
| Settled signal, not a fixed grace window | 6, 10 |
| Cookie 15 min, atomic write, constants pinned | 7 |
| Own quarantine namespace, 24 h expiry | 7, 10 |
| Quarantine gates convergence, never the pull | 9, 10 |
| Fail open when the gate is indeterminate | 10 |
| Convergence owns the restart | 9 |
| Trigger is bootSha≠HEAD, never `pulled` | 9 |
| `CROW_DISABLE_CONVERGE` kill switch | 9, 12 |
| Two-instance executable gate, real lock contention | 8, 9 |
| Phase 3 not built | — (deliberate) |
| Report on card #120 | 12 |

**Stated limits, not hidden:**
- If new code crashes *before* `post-listen.js` runs, quarantine fires only on the following boot via the expired-deadline path (tested). A crash so early that systemd exhausts `StartLimitBurst` first leaves the sha un-quarantined; detection falls to the operator alert. This is the real limit of self-verification without an external watchdog.
- The registry runs at tick time inside `convergeInstance` as well as at boot. The boot call site is ordered before the first `createDbClient`; the tick-time one is not, and runs while the WAL keeper is pinned. That is safe for additive `ALTER`s (no file swap) but a future migration that restores or replaces a DB file must not go in this registry.
- Three unlocked processes can write markers concurrently; writes are tmp+rename so no reader sees torn JSON, but a lost update between two simultaneous quarantines is possible. Consequence is bounded: both write the same sha, and the 24 h expiry caps any divergence.
