# pi-bots Usage Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record one `surface="bot"` `usage_events` row per bot inference turn (interactive channels + scheduled jobs), reusing the gateway's shared `recordUsageEvent` price-book path.

**Architecture:** A new `scripts/pi-bots/metering.mjs` provides a thin `{execute}` adapter over the bridge's existing better-sqlite3 connection (so the libsql-shaped `recordUsageEvent`/`loadPricingRules` work unchanged) plus a `meterBotTurn()` helper that computes the per-turn token delta from pi's `get_session_stats` RPC (clamping compaction-induced negatives). A new `PiRpc.getSessionStats()` exposes the RPC. Two guarded wiring sites (`bridge.mjs:handleInbound`, `job_runner.mjs:runJob`) call the helper best-effort so capture never breaks a turn.

**Tech Stack:** Node.js ESM, better-sqlite3, node built-in test runner (`node --test`), `@earendil-works/pi-coding-agent` RPC.

**Spec:** `docs/superpowers/specs/2026-06-19-pibot-usage-capture-design.md`

## Global Constraints

- **TDD, red first** — write the failing test, watch it fail, then implement.
- **Best-effort capture** — every capture call is wrapped so a metering failure NEVER breaks a bot turn (mirrors `chat.js` / `llm-router.js`).
- **Single recording path** — record via the shared `servers/shared/metering.js:recordUsageEvent`; do not duplicate the INSERT. Reconciliation (Phase 1.5) depends on one path.
- **Do NOT use `servers/db.js:createDbClient` in the bridge/job runner** — it flips `journal_mode` to WAL on high-RAM hosts (crow) + registers a keeper (the `crowdb-wal-flip-new-consumers` hazard). Use the existing busy-timeout-only connections (`db()` / `dbConn()`).
- **Attribution (Phase 1.0 stubs, consistent with `chat.js`):** `surface="bot"`, `providerId=resolved.provider`, `modelId=resolved.model`, `providerType=null`, `tenantId=null`.
- **`cacheWrite` tokens dropped in v1** (no schema column; `computeCost` doesn't model it).
- **Commits:** explicit path args only (`git commit <paths> -m`), never bare `git add`+`git commit`. `git pull --rebase` before any push. Do NOT attribute Claude as co-author.
- **Code-only deploy** — the MPA `crow.db` already has `usage_events` + `pricing_rules`. No init-db, no schema change.

---

### Task 1: `metering.mjs` — libsql `{execute}` adapter

**Files:**
- Create: `scripts/pi-bots/metering.mjs`
- Test: `tests/pibot-metering.test.js`

**Interfaces:**
- Consumes: a better-sqlite3 `Database` connection.
- Produces: `libsqlAdapter(conn) -> { execute(arg) }` where `arg` is a SQL string or `{sql, args}`; SELECT returns `{rows: [...]}`, write returns `{rowsAffected, lastInsertRowid}`. Async.

- [ ] **Step 1: Write the failing test**

Create `tests/pibot-metering.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { libsqlAdapter } from "../scripts/pi-bots/metering.mjs";

// Minimal schema mirroring init-db.js (matches tests/metering-record.test.js).
export function freshDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT, provider_type TEXT, model_id TEXT NOT NULL DEFAULT '*',
    input_cost_per_1m REAL NOT NULL, output_cost_per_1m REAL NOT NULL,
    cache_read_cost_per_1m REAL, cache_write_cost_per_1m REAL,
    effective_from TEXT, effective_to TEXT)`);
  db.exec(`CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT, conversation_id INTEGER, message_id INTEGER,
    surface TEXT NOT NULL DEFAULT 'chat',
    provider_id TEXT, provider_type TEXT, model_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0, computed_cost_usd REAL,
    priced INTEGER NOT NULL DEFAULT 0, request_id TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

test("libsqlAdapter: SELECT returns {rows}, write returns {rowsAffected}", async () => {
  const a = libsqlAdapter(freshDb());
  const w = await a.execute({
    sql: "INSERT INTO pricing_rules (provider_type, model_id, input_cost_per_1m, output_cost_per_1m) VALUES (?,?,?,?)",
    args: ["together", "*", 0.18, 0.18],
  });
  assert.equal(w.rowsAffected, 1);
  const sel = await a.execute("SELECT * FROM pricing_rules WHERE effective_to IS NULL");
  assert.equal(sel.rows.length, 1);
  assert.equal(sel.rows[0].provider_type, "together");
  assert.equal(sel.rows[0].input_cost_per_1m, 0.18);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pibot-metering.test.js`
Expected: FAIL — `Cannot find module '.../scripts/pi-bots/metering.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/pi-bots/metering.mjs`:

```js
/**
 * pi-bots usage capture (Phase 1.4 of the metered-inference roadmap).
 *
 * Records one usage_events row per bot inference turn (surface="bot"), reusing
 * the SHARED servers/shared/metering.js recordUsageEvent path so the bot leg
 * shares the gateway's price book + single recording semantics (reconciliation,
 * Phase 1.5, must trust one path).
 *
 * The bridge / job runner speak better-sqlite3; recordUsageEvent + loadPricingRules
 * speak the libsql {execute({sql,args})} surface. `libsqlAdapter` is a thin
 * {execute} shim over an EXISTING better-sqlite3 connection. It deliberately does
 * NOT use servers/db.js createDbClient: that flips journal_mode to WAL on high-RAM
 * hosts (crow) and registers a keeper — the crowdb-wal-flip-new-consumers hazard
 * the bridge avoids by opening busy_timeout-only. This shim flips nothing.
 */
import { recordUsageEvent } from "../../servers/shared/metering.js";

// Wrap a better-sqlite3 connection in the async {execute} surface that
// recordUsageEvent / loadPricingRules expect. SELECT -> {rows}; write -> {rowsAffected}.
export function libsqlAdapter(conn) {
  return {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const args = (typeof arg === "string" ? [] : arg.args) || [];
      const stmt = conn.prepare(sql);
      if (/^\s*select/i.test(sql)) return { rows: stmt.all(...args) };
      const info = stmt.run(...args);
      return { rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pibot-metering.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git commit scripts/pi-bots/metering.mjs tests/pibot-metering.test.js -m "feat(metering): pi-bots libsql {execute} adapter over better-sqlite3"
git show --stat HEAD | head -6
```

---

### Task 2: `metering.mjs` — `tokenDelta` + `meterBotTurn`

**Files:**
- Modify: `scripts/pi-bots/metering.mjs`
- Test: `tests/pibot-metering.test.js`

**Interfaces:**
- Consumes: `libsqlAdapter` (Task 1); `recordUsageEvent` (shared); pi `SessionStats.tokens` shape `{input, output, cacheRead, cacheWrite, total}`.
- Produces:
  - `tokenDelta(before, after, log?) -> { input, output, cacheRead }` — non-negative per-dimension delta; logs a `compaction` warning when any raw `after-before` is negative.
  - `meterBotTurn({ conn, statsBefore, statsAfter, resolved, surface="bot", requestId=null, log }) -> Promise<{recorded:boolean, reason?:string, priced?:boolean, cost?:number|null}>`. `statsBefore`/`statsAfter` are the `SessionStats` objects (the `.data` from `PiRpc.getSessionStats()`), or null.

- [ ] **Step 1: Write the failing tests**

Append to `tests/pibot-metering.test.js`:

```js
import { meterBotTurn, tokenDelta } from "../scripts/pi-bots/metering.mjs";

test("tokenDelta clamps compaction-induced negatives to 0 and flags", () => {
  const warns = [];
  const d = tokenDelta(
    { input: 500, output: 50, cacheRead: 0 },
    { input: 480, output: 60, cacheRead: 0 },
    (m) => warns.push(m),
  );
  assert.deepEqual(d, { input: 0, output: 10, cacheRead: 0 });
  assert.ok(warns.some((w) => /compaction/i.test(w)));
});

test("meterBotTurn writes a priced surface=bot row from the per-turn delta", async () => {
  const conn = freshDb();
  conn.prepare(
    "INSERT INTO pricing_rules (provider_id, model_id, input_cost_per_1m, output_cost_per_1m) VALUES (?,?,?,?)",
  ).run("crow-test", "*", 1.0, 1.0);
  const res = await meterBotTurn({
    conn,
    statsBefore: { tokens: { input: 100, output: 10, cacheRead: 0 } },
    statsAfter: { tokens: { input: 160, output: 35, cacheRead: 5 } },
    resolved: { provider: "crow-test", model: "qwen" },
    requestId: "sess-1",
  });
  assert.equal(res.recorded, true);
  assert.equal(res.priced, true);
  const { rows } = await libsqlAdapter(conn).execute("SELECT * FROM usage_events");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, "bot");
  assert.equal(Number(rows[0].input_tokens), 60);
  assert.equal(Number(rows[0].output_tokens), 25);
  assert.equal(Number(rows[0].cached_tokens), 5);
  assert.equal(rows[0].provider_id, "crow-test");
  assert.equal(rows[0].provider_type, null);
  assert.equal(rows[0].model_id, "qwen");
  assert.equal(rows[0].tenant_id, null);
  assert.equal(rows[0].request_id, "sess-1");
  assert.equal(Number(rows[0].priced), 1);
});

test("meterBotTurn still records an UNPRICED row when no rule matches", async () => {
  const conn = freshDb(); // no pricing_rules seeded
  const res = await meterBotTurn({
    conn,
    statsBefore: { tokens: { input: 0, output: 0, cacheRead: 0 } },
    statsAfter: { tokens: { input: 10, output: 5, cacheRead: 0 } },
    resolved: { provider: "x", model: "y" },
    requestId: "s",
  });
  assert.equal(res.recorded, true);
  assert.equal(res.priced, false);
  const { rows } = await libsqlAdapter(conn).execute("SELECT priced, computed_cost_usd FROM usage_events");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].priced), 0);
  assert.equal(rows[0].computed_cost_usd, null);
});

test("meterBotTurn records nothing on zero delta or missing after-stats", async () => {
  const conn = freshDb();
  const zero = await meterBotTurn({
    conn,
    statsBefore: { tokens: { input: 5, output: 5, cacheRead: 0 } },
    statsAfter: { tokens: { input: 5, output: 5, cacheRead: 0 } },
    resolved: { provider: "x", model: "y" },
  });
  assert.equal(zero.recorded, false);
  const none = await meterBotTurn({
    conn, statsBefore: null, statsAfter: null, resolved: { provider: "x", model: "y" },
  });
  assert.equal(none.recorded, false);
  const { rows } = await libsqlAdapter(conn).execute("SELECT * FROM usage_events");
  assert.equal(rows.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pibot-metering.test.js`
Expected: FAIL — `meterBotTurn`/`tokenDelta` are not exported (`undefined is not a function` / import error).

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/pi-bots/metering.mjs`:

```js
// Non-negative per-dimension delta of two SessionStats.tokens snapshots. pi's
// get_session_stats sums usage over ALL current session messages, so a mid-turn
// compaction can shrink the cumulative count: clamp to >=0 and flag the undercount.
export function tokenDelta(before, after, log = () => {}) {
  const b = before || {};
  const a = after || {};
  const raw = {
    input: (a.input || 0) - (b.input || 0),
    output: (a.output || 0) - (b.output || 0),
    cacheRead: (a.cacheRead || 0) - (b.cacheRead || 0),
  };
  if (raw.input < 0 || raw.output < 0 || raw.cacheRead < 0) {
    log("[metering] compaction detected (after < before) — bot usage undercount this turn");
  }
  return {
    input: Math.max(0, raw.input),
    output: Math.max(0, raw.output),
    cacheRead: Math.max(0, raw.cacheRead),
  };
}

// Record one bot turn's usage. Best-effort by contract: the CALLER wraps this in
// try/catch (a metering failure must never break a turn). statsBefore/statsAfter
// are the SessionStats objects (.data from PiRpc.getSessionStats()), or null.
export async function meterBotTurn({
  conn, statsBefore, statsAfter, resolved, surface = "bot", requestId = null, log = () => {},
}) {
  if (!statsAfter || !statsAfter.tokens) return { recorded: false, reason: "no-stats" };
  const delta = tokenDelta(statsBefore && statsBefore.tokens, statsAfter.tokens, log);
  if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0) {
    return { recorded: false, reason: "zero-delta" };
  }
  const r = await recordUsageEvent(libsqlAdapter(conn), {
    surface,
    tenantId: null,
    providerId: resolved && resolved.provider != null ? resolved.provider : null,
    providerType: null,
    modelId: resolved && resolved.model != null ? resolved.model : null,
    inputTokens: delta.input,
    outputTokens: delta.output,
    cachedTokens: delta.cacheRead,
    requestId,
  });
  return { recorded: true, priced: r.priced, cost: r.cost };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pibot-metering.test.js`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git commit scripts/pi-bots/metering.mjs tests/pibot-metering.test.js -m "feat(metering): meterBotTurn + tokenDelta — per-turn bot usage recording"
git show --stat HEAD | head -6
```

---

### Task 3: `bridge.mjs` — `PiRpc.getSessionStats()` + `handleInbound` wiring

**Files:**
- Modify: `scripts/pi-bots/bridge.mjs` (import ~line 39; method after `getState()` ~line 184; wiring in `handleInbound` try block ~lines 556–568)

**Interfaces:**
- Consumes: `meterBotTurn` (Task 2); `PiRpc.getSessionStats()` (added here).
- Produces: `PiRpc.getSessionStats() -> Promise<{type:"response",command:"get_session_stats",success:true,data:SessionStats}>` (mirrors `getState()`).

> **Note on verification:** `handleInbound` spawns a real pi process, so it is proven by E2E scripts (`p3_0_e2e.mjs` etc.) and the post-deploy live smoke (Task 5), not a unit test. The pure logic it calls (`meterBotTurn`/`tokenDelta`) is fully unit-tested in Tasks 1–2. This task's gate is: code added correctly + the metering/pibot suites stay green + no syntax error on load.

- [ ] **Step 1: Add the import**

In `scripts/pi-bots/bridge.mjs`, after the existing `import { warmModel } from "./warm.mjs";` line (~38), add:

```js
import { meterBotTurn } from "./metering.mjs";
```

- [ ] **Step 2: Add `getSessionStats()` to PiRpc**

In the `PiRpc` class, immediately after the `getState()` method (the line ending `..."get_state");\n  }`), add:

```js
  async getSessionStats() { this.send({ type: "get_session_stats" }); return this.waitFor((m) => m.type === "response" && m.command === "get_session_stats", 15000, "get_session_stats"); }
```

- [ ] **Step 3: Capture stats around the turn + record**

In `handleInbound`'s `try` block, change the stats captures and add the recording. The existing lines:

```js
    const st0 = await pi.getState().catch(() => null);
    await pi.prompt(promptText, TURN_TIMEOUT_MS, opts.images);
    const st1 = await pi.getState().catch(() => null);
```

become:

```js
    const st0 = await pi.getState().catch(() => null);
    const stats0 = await pi.getSessionStats().catch(() => null);
    await pi.prompt(promptText, TURN_TIMEOUT_MS, opts.images);
    const st1 = await pi.getState().catch(() => null);
    const stats1 = await pi.getSessionStats().catch(() => null);
```

Then, immediately after the existing `upsertSession(session);` line that follows `session.model = resolved.key; session.escalated = ...` (the one BEFORE the `notice`/`sendReply`), add:

```js
    // Phase 1.4: meter this bot turn (surface=bot) into usage_events via the
    // shared recordUsageEvent path. Best-effort — never breaks a turn. Uses a
    // short-lived busy_timeout-only connection (same discipline as appendAuditBridge;
    // NOT createDbClient, which would WAL-flip the prod crow.db).
    try {
      const mconn = db(CROW_DB);
      try {
        await meterBotTurn({
          conn: mconn, statsBefore: stats0 && stats0.data, statsAfter: stats1 && stats1.data,
          resolved, surface: "bot", requestId: piSessionId, log,
        });
      } finally { mconn.close(); }
    } catch (e) {
      log("[metering] bot usage record failed (non-fatal): " + ((e && e.message) || e));
    }
```

- [ ] **Step 4: Verify the module loads + suites stay green**

Run:
```bash
node -e "import('./scripts/pi-bots/bridge.mjs').then(()=>console.log('bridge loads OK')).catch(e=>{console.error(e);process.exit(1)})"
node --test tests/pibot-metering.test.js tests/metering.test.js tests/metering-record.test.js tests/metering-summary.test.js tests/metering-extract.test.js tests/metering-panel.test.js tests/llm-tap.test.js tests/init-db-metering-tables.test.js
```
Expected: `bridge loads OK`, then all metering tests PASS (no regression).

- [ ] **Step 5: Commit**

```bash
git commit scripts/pi-bots/bridge.mjs -m "feat(metering): capture bot turns in handleInbound (surface=bot) via PiRpc.getSessionStats"
git show --stat HEAD | head -6
```

---

### Task 4: `job_runner.mjs` — `runJob` wiring

**Files:**
- Modify: `scripts/pi-bots/job_runner.mjs` (import after `warmModel` import ~line 44; wiring around the `pi.prompt` block ~lines 209–217)

**Interfaces:**
- Consumes: `meterBotTurn` (Task 2); `bridge.PiRpc.getSessionStats()` (Task 3); the module's existing `dbConn()` (busy_timeout-only) + `resolved` + `sessionId`.

> **Verification:** same as Task 3 — `runJob` spawns pi, so it is verified by module-load + the live smoke (Task 5). The pure helper is already unit-tested.

- [ ] **Step 1: Add the import**

In `scripts/pi-bots/job_runner.mjs`, after `import { warmModel } from "./warm.mjs";` (~line 44), add:

```js
import { meterBotTurn } from "./metering.mjs";
```

- [ ] **Step 2: Capture stats around the job turn + record**

In `runJob`, the existing block:

```js
      const st0 = await pi.getState().catch(() => null);
      await pi.prompt(buildJobPrompt(job.goal), JOB_TIMEOUT_MS);
      const st1 = await pi.getState().catch(() => null);
      const sessionId = (st1 && st1.data && st1.data.sessionId)
        || (st0 && st0.data && st0.data.sessionId) || null;
      const text = pi.assistantText() || "(no reply)";
```

becomes:

```js
      const st0 = await pi.getState().catch(() => null);
      const stats0 = await pi.getSessionStats().catch(() => null);
      await pi.prompt(buildJobPrompt(job.goal), JOB_TIMEOUT_MS);
      const st1 = await pi.getState().catch(() => null);
      const stats1 = await pi.getSessionStats().catch(() => null);
      const sessionId = (st1 && st1.data && st1.data.sessionId)
        || (st0 && st0.data && st0.data.sessionId) || null;
      // Phase 1.4: meter the scheduled job turn (surface=bot). Best-effort —
      // never fails the job. dbConn() is busy_timeout-only (no WAL flip).
      try {
        const mconn = dbConn();
        try {
          await meterBotTurn({
            conn: mconn, statsBefore: stats0 && stats0.data, statsAfter: stats1 && stats1.data,
            resolved, surface: "bot", requestId: sessionId, log,
          });
        } finally { mconn.close(); }
      } catch (e) {
        log("[metering] job usage record failed (non-fatal): " + ((e && e.message) || e));
      }
      const text = pi.assistantText() || "(no reply)";
```

- [ ] **Step 3: Verify the module loads + suites stay green**

Run:
```bash
node -e "import('./scripts/pi-bots/job_runner.mjs').then(()=>console.log('job_runner loads OK')).catch(e=>{console.error(e);process.exit(1)})"
node --test tests/pibot-metering.test.js tests/metering.test.js tests/metering-record.test.js
```
Expected: `job_runner loads OK`, metering tests PASS.

- [ ] **Step 4: Commit**

```bash
git commit scripts/pi-bots/job_runner.mjs -m "feat(metering): capture scheduled bot-job turns (surface=bot) in runJob"
git show --stat HEAD | head -6
```

---

### Task 5: Deploy (code-only) + live smoke

**Files:** none (deploy + verification only).

> **Context:** PROD. The pibot bridge runs as `pibot-gateways@crow-mpa` with `CROW_DB_PATH=/home/kh0pp/.crow-mpa/data/crow.db` — which already has `usage_events` + `pricing_rules`. No init-db. Sudo pw is in private notes. Coordinate with any concurrent session touching `~/.crow-mpa`.

- [ ] **Step 1: Pre-flight — rebase, run the full new test once more, push**

```bash
cd /home/kh0pp/crow
git pull --rebase
node --test tests/pibot-metering.test.js
git push
```
Expected: rebase clean, 5 tests PASS, push succeeds.

- [ ] **Step 2: Restart the pibot gateways onto current main**

Identify and restart the bridge/gateway service(s) (Gmail tick, Discord gateway, job runner) so they load the new `bridge.mjs` / `job_runner.mjs` / `metering.mjs`:

```bash
systemctl --user list-units 'pibot*' 2>/dev/null || systemctl list-units 'pibot*'
# Restart the unit that runs the pibot gateways on crow-mpa, e.g.:
#   systemctl --user restart pibot-gateways@crow-mpa
# (use sudo + the system manager if it is a system unit)
```
Expected: unit active, no crash loop (`NRestarts=0`).

- [ ] **Step 3: Live smoke — one real bot turn → assert a `surface=bot` row**

Note the current max id, drive one bot turn (a real inbound on a test bot, or a scheduled test job), then confirm a new row landed:

```bash
DB=/home/kh0pp/.crow-mpa/data/crow.db
sqlite3 "$DB" "SELECT COALESCE(MAX(id),0) FROM usage_events;"   # baseline
# ... trigger ONE bot turn via the normal channel (Gmail/Discord) or a test job ...
sqlite3 -header -column "$DB" "SELECT id, surface, provider_id, model_id, input_tokens, output_tokens, cached_tokens, priced, request_id, created_at FROM usage_events WHERE surface='bot' ORDER BY id DESC LIMIT 3;"
```
Expected: a new `surface=bot` row with non-zero `input_tokens`/`output_tokens` and a `request_id` matching the pi session. `priced=0` is EXPECTED until the MPA price book is seeded (the metering panel's unpriced-coverage warning reflects this) — that is correct, not a bug.

- [ ] **Step 4: Confirm the panel shows it**

Load `/dashboard/metering` on the MPA gateway and confirm a `bot` surface/provider row appears in the breakdown. (Optional: if the smoke used a throwaway test bot, delete the synthetic row: `sqlite3 "$DB" "DELETE FROM usage_events WHERE id=<the smoke id>;"`.)

- [ ] **Step 5: Update the project memory**

Update `~/.claude/projects/-home-kh0pp-crow/memory/ferpa-metered-inference-project.md`: mark Phase 1.4 (bot capture) BUILT + DEPLOYED, note `surface=bot` now captured on handleInbound + runJob, and that the MPA price book still needs seeding to price bot events. Record the recorded follow-ups (skill_review, cacheWrite, per-message deltas, quota gate).

---

## Self-Review

**Spec coverage:**
- `metering.mjs` adapter → Task 1 ✓
- `meterBotTurn` + compaction clamp → Task 2 ✓
- `PiRpc.getSessionStats()` → Task 3 ✓
- `handleInbound` wiring → Task 3 ✓
- `runJob` wiring → Task 4 ✓
- Attribution stubs (tenant/providerType null, surface=bot) → Task 2 impl + test ✓
- `cacheWrite` dropped → Task 2 impl (only input/output/cacheRead) ✓
- Best-effort/never-break-a-turn → Tasks 3–4 try/catch ✓
- Single recording path (shared `recordUsageEvent`) → Task 2 ✓
- No `createDbClient` / WAL-flip discipline → Global Constraints + Task 3/4 comments ✓
- Code-only deploy + live smoke → Task 5 ✓
- Out-of-scope seams (skill_review, quota gate) → not built, recorded in Task 5 memory step ✓

**Placeholder scan:** none — every code step has complete code; every run step has a command + expected output.

**Type consistency:** `libsqlAdapter(conn)`, `tokenDelta(before, after, log)`, `meterBotTurn({conn, statsBefore, statsAfter, resolved, surface, requestId, log})`, `getSessionStats()` used identically across Tasks 1–4. `statsBefore`/`statsAfter` are always the `SessionStats` object (`.data`), and callers pass `stats0 && stats0.data` consistently.
