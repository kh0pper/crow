# cross_host_calls Corruption-Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the `cross_host_calls` federation audit table unable to silently take down (or slowly corrupt) crow's DB again — it has now corrupted twice the same way (2026-06-14, 2026-07-02), each time as an unbounded append-only high-write table whose crash-mid-write orphaned pages and spammed 40k "disk image is malformed" errors while federation degraded silently for hours/days.

**Architecture:** Three independent, low-risk layers on existing surfaces: (1) bounded retention + checkpoint so the table stays tiny (far less corruption surface, fast recovery); (2) a circuit-breaker + LOUD alert so a malformed-audit-DB condition surfaces immediately and stops feeding the corruption, instead of degrading silently; (3) a checked-in scripted recovery so the next rebuild is one command, not hand-built. **Explicitly NOT doing:** live auto-rebuild of a corrupt table under a running gateway (that is exactly the risky operation we just did carefully OFFLINE with backups — automating it on PROD is unsafe).

**Tech Stack:** Node 20, `servers/shared/cross-host-auth.js`, `servers/gateway/boot/post-listen.js` (periodic-timer pattern at :154), the W2 nest health-signals + `servers/shared/notifications.js`, `node --test`.

## Verified facts (2026-07-02)

- `cross_host_calls` schema has an `at TEXT DEFAULT (datetime('now'))` column (init-db.js:1678, ISO string, lexicographically sortable); indexes on target/source/action `at DESC`. **Readers (grep-verified, review C1): TWO — the dashboard audit view last-24h (`audit-log.js:20`) AND `integrationsSignal` in `health-signals.js:493-506` which reads a 7-DAY window (`c.at >= datetime('now','-7 days')`) and picks the latest 401/403 per instance.** So retention MUST exceed 7 days with margin → use **14 days** (table still stays tiny). A 7-day retention would let the prune delete the "latest failing peer" row and silence the integrations warn — reintroducing silent degradation.
- `auditCrossHostCall` (`cross-host-auth.js:227`) ALREADY never throws (best-effort). `validateInstanceToken` (`instance-registry.js:441-451`) ALREADY retries on a fresh client and logs a degraded warning (2026-06-14 symptom-fixes). There is **no retention/prune anywhere** (grep confirmed) — the unaddressed root cause.
- Periodic timers use `setInterval(fn, ms).unref()` in `post-listen.js` (e.g. remote-probe :154); gated for `--no-auth` per QW1.
- Recovery recipe proven 2026-07-02: fresh schema from `scripts/init-db.js` + `INSERT OR REPLACE` copy of readable base tables from the corrupt file, skipping `cross_host_calls`/`crow_instances`/`mcp_sessions`, FTS rebuilt via triggers, token-hash re-injected. (The working `recover.mjs` is in the job tmp dir — Task 3 productizes it.)

## Global Constraints

- Positional-path commits; `git show --stat HEAD` after each. Branch `fix/xhost-audit-hardening`.
- Tests: `node --test tests/<file>.test.js`; gateway must still boot (`node servers/gateway/index.js --no-auth`).
- No schema change that requires a data migration beyond what `init-db.js` idempotently applies.
- Check-runs gate before merge.

---

### Task 1: Bounded retention + checkpoint for cross_host_calls

**Files:**
- Create: `servers/shared/cross-host-audit-retention.js` — `pruneCrossHostAudit(db, { retentionDays = 14 })` → `DELETE FROM cross_host_calls WHERE at < datetime('now', ?)` (param `'-14 days'` — MUST exceed the 7-day integrations reader, review C1), returns rows deleted; then `PRAGMA wal_checkpoint(TRUNCATE)` (best-effort, never throws — harmless no-op returning `(busy,log,ckpt)` in DELETE-mode per review; a failure must not break boot). Pure, testable, never throws.
- Modify: `servers/gateway/boot/post-listen.js` — schedule `pruneCrossHostAudit` once ~5 min after boot then every 24h, `setInterval(...).unref()`, fully try/caught. **Gate to the home instance only** (run only when this instance is `is_home`/primary — review suggestion) so three fleet processes don't serialize prune+checkpoint on the same file; runs regardless of `--no-auth` (harmless — a `--no-auth` box may point at a throwaway DB).
- Test: `tests/cross-host-audit-retention.test.js`

**Interfaces:**
- Produces: `pruneCrossHostAudit(db, opts) → Promise<{deleted:number, checkpointed:boolean}>`; never rejects.

- [ ] **Step 1:** Write the test against a temp init-db DB: insert rows with `at` = now, now-2d, now-10d, now-20d; the DEFAULT `pruneCrossHostAudit(db)` (14d) deletes ONLY the 20d row (returns `{deleted:1}`), leaves the now/2d/10d rows (proving the shipped default is 14, not <10 — the number this review changed); a second call deletes 0; an explicit `{retentionDays:7}` then also removes the 10d row; corrupt/closed-db call resolves (never rejects).
- [ ] **Step 2:** Run it → FAIL (module absent).
- [ ] **Step 3:** Implement `cross-host-audit-retention.js`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Wire into `post-listen.js` (5-min initial delay, 24h interval, unref, try/caught, `--no-auth`-gated); a tiny unit test or a `node --check` + boot smoke confirming the wiring doesn't throw.
- [ ] **Step 6:** Commit `fix: bound cross_host_calls with 14-day retention + checkpoint (root-cause of the 2x corruption — unbounded high-write audit table)`.

### Task 2: Circuit-breaker + loud alert on a malformed audit DB

**Files:**
- Modify: `servers/shared/cross-host-auth.js` — a module-level (per-process) circuit breaker: when `auditCrossHostCall`'s insert catch sees a STRUCTURAL error matching `/malformed|not a database|disk image|disk I\/O|SQLITE_IOERR/i` (include IOERR per review Q3 — db.js history shows it accompanies real unreadability), increment a counter and, past a small threshold (e.g. 3), set `_auditDisabled=true` so subsequent `auditCrossHostCall` calls short-circuit (skip the INSERT — stop feeding the corruption). Transient `SQLITE_BUSY` must NOT trip it. **The alert must NOT depend on a write to the corrupt DB (review C2 — `createNotification` INSERTs to the same `crow.db` at notifications.js:63 BEFORE the ntfy/email sends, so those loud channels never fire when the DB is malformed).** On trip, call the DB-free channels DIRECTLY via dynamic import — `sendNtfyNotification` from `servers/gateway/push/ntfy.js` + `sendEmailNotification` from `servers/gateway/push/email.js` (the real exports — NOT `notifications.js`, which only re-imports them privately inside `createNotification`; both confirmed DB-free, review round-2) — guarded by a `_notified` one-shot. Message: "Federation audit DB is corrupted — run `npm run recover-db`; federation still works, audit logging paused." **Re-arm** `_notified` after a ~6h cooldown (review Q4) so a days-long degradation re-alerts. Never throws; all flags reset on process restart. Per-process singleton — assumes one DB file per process (true on this fleet); state the assumption.
- Modify: `servers/gateway/dashboard/panels/nest/health-signals.js` — add a `federation-audit` signal that warns when the breaker is tripped (surface the same condition in the nest, reusing the W2 signal contract).
- Test: `tests/cross-host-audit-breaker.test.js`

**Interfaces:**
- Consumes: `auditCrossHostCall` (existing). Produces: exported `isAuditDegraded()` → boolean (for the health signal + tests); exported `_resetAuditBreaker()` test hook.

- [ ] **Step 1:** Test: a `db.execute` stub that throws a `malformed` error 3× trips `isAuditDegraded()` true, further `auditCrossHostCall` calls do NOT call `db.execute` (breaker open), and exactly one alert fires — stub the DB-FREE channels at their real modules (`gateway/push/ntfy.js` `sendNtfyNotification`, `gateway/push/email.js` `sendEmailNotification`), asserting they are called and `createNotification`/`db` is NOT (this catches the round-2 wrong-module bug). A `SQLITE_BUSY` does NOT trip it (transient); an IOERR DOES. Re-arm: after `_resetAuditBreaker()`-style cooldown advance, a subsequent trip fires the alert AGAIN (covers the 6h re-arm). `_resetAuditBreaker()` clears all flags.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the breaker + notification (guard the notification behind a `_notified` one-shot flag).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Add the `federation-audit` nest health signal (warn when `isAuditDegraded()`), with an i18n label EN+ES; extend the health-signals test if one enumerates signals.
- [ ] **Step 6:** Commit `fix: circuit-breaker + loud alert when the cross_host_calls audit DB is malformed (no more silent multi-day federation degradation)`.

### Task 3: Checked-in scripted recovery

**Files:**
- Create: `scripts/recover-crow-db.mjs` — productized from the proven 2026-07-02 `recover.mjs`: takes `--db <path>` (default `~/.crow/data/crow.db`). **Liveness gate (review C3): refuse unless the DB file has NO open handles** — check `lsof`/`fuser` on `<db>`, `<db>-wal`, `<db>-shm` (NOT just the :3001 TCP port — pi-bots `bot_jobs` IPC + WAL keeper handles + other same-host instances also open crow.db per db.js:20-22), or require explicit `--force`. Backs up to `<db>.CORRUPT-<ts>` (+ `-wal`/`-shm`). Builds fresh schema via the in-repo init-db path; `INSERT OR REPLACE`-copies readable base tables. **`crow_instances` handling (review C4): copy it if READABLE (it's the peer-auth trust anchor — `validateInstanceToken` selects by `auth_token_hash`; dropping it blacks out ALL federation until every peer re-enrolls). Only skip a table if a per-table SELECT throws malformed** (today's run skipped `crow_instances` precisely because it was corrupt garbage — but a general recovery must preserve it when intact). Always skip `cross_host_calls` (expendable audit) + `mcp_sessions` (ephemeral) only when unreadable-or-empty. Rebuild FTS via triggers; re-inject the existing `.env` MCP token hash (clients keep working). **Two swap gates: (a) `PRAGMA integrity_check` MUST be `ok`; (b) per-table row-count completeness — every readable source table's count must match the copied count (loud diff + ABORT on shortfall, review suggestion), so a partially-readable source can't yield an "ok" but lossy DB.** Only then swap atomically. Prints the full runbook, every row-count, and — if `crow_instances` was skipped — a LOUD "federation peers must re-enroll" warning.
- Modify: `package.json` — `"recover-db": "node scripts/recover-crow-db.mjs"`.
- Modify: `docs/architecture/` or `docs/developers/` — a short "DB corruption recovery" runbook pointing at `npm run recover-db` + the retention/breaker hardening.

- [ ] **Step 1:** Adapt the proven script (in the job tmp dir); make the DB path + backup + integrity-gate + token-reinjection parameterized and safe (never swap if integrity != ok; never run against a live gateway without `--force`).
- [ ] **Step 2:** Dry-run against a COPY of a DB (e.g. the current healthy crow.db copied to tmp) — confirm it produces an `ok` DB with matching row counts and does NOT touch the original without an explicit swap flag.
- [ ] **Step 3:** Add the npm script + runbook doc.
- [ ] **Step 4:** Commit `feat: scripted crow DB recovery (npm run recover-db) — productizes the 2026-07-02 manual recovery`.

---

## Review

**Round 1 (2026-07-02, adversarial subagent, opus): REVISE — all 4 criticals fixed:**
- **C1** (false "24h-only reader"): grep-verified a SECOND, 7-day reader (`integrationsSignal` health-signals.js:493-506); retention raised 7d→**14d** and the Verified-facts corrected.
- **C2** (alert writes to the corrupt DB first, so ntfy/email never fire): breaker now calls `sendNtfyNotification`/`sendEmailNotification` DIRECTLY (no `db`) via dynamic import, not `createNotification`; + 6h re-arm.
- **C3** (port-only liveness insufficient — pi-bots also open crow.db): recovery gates on `lsof`/`fuser` of the db + `-wal`/`-shm`, not the TCP port.
- **C4** (skipping `crow_instances` blacks out federation): recovery now PRESERVES `crow_instances` when readable (skip only if a per-table SELECT throws), + a loud re-enroll warning when it must be skipped.
Suggestions adopted: prune gated to the home instance; IOERR added to the breaker trigger; per-table row-count completeness gate on recovery; dynamic-import notifications; per-process-breaker assumption stated; replay-safety (separate nonceCache) confirmed unaffected.

## Self-review notes
- Attacks the ROOT cause (unbounded table) in Task 1; converts the SILENT failure mode to LOUD + self-limiting in Task 2; makes the inevitable-someday recovery one gated command in Task 3. Layered, each independently valuable.
- Deliberately NOT auto-rebuilding a corrupt table live (unsafe — documented rejection).
- Retention 14d exceeds both readers (24h dashboard + 7d integrations) with margin; table still stays tiny; no user-visible loss.
- Breaker trips only on structural errors (malformed/not-a-database/IOERR), never on transient SQLITE_BUSY.
- NOTE for the operator: today's recovery dropped the corrupt `crow_instances`, so crow's federation peers (grackle sync, black-swan) will be rejected until they re-enroll — the recovery script's C4 fix prevents this in future runs, but the current instance may need a re-pair.
