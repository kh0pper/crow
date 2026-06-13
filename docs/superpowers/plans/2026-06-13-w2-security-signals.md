# Wave 2: Security-Maintenance Safeguards — Implementation Plan

**Goal:** the top-4 security-maintenance gaps become nest health signals (extending the
existing 7-signal system), with high-urgency ones (login storm, exposure) also firing
notifications. Non-technical wording, plain "what to do" actions, fresh-install safe.

**Branch:** `fix/w2-security-signals`. Node test runner, positional-path commits,
`--no-ff` merge, 4-gateway deploy with `/dashboard/nest` verification.

---

## Verified architecture (read before coding)

| Piece | Location | Facts |
|---|---|---|
| Health signals | `servers/gateway/dashboard/panels/nest/health-signals.js` | 7 signals; contract `{id, severity:null\|"info"\|"warn", state, label, value, issueLabel?, actionLabel?, actionHref?}`; module-level 30s cache (`_cache`/`_cacheTs`), injectable clock; each collector swallows its own errors; `ok = no warn issues`. |
| Strip render | `nest/html.js` `buildHealthStrip()` (~167-233) | renders issues (dot+label+action) + `<details>` grid; backup action special-cased: `actionHref==="/dashboard/nest?action=backup"` → POST form to `/dashboard/nest/backup`. |
| Health monitor (notifications ALREADY wired) | `servers/gateway/boot/post-listen.js` (~166-244) | 15-min interval, 2-min boot delay, kill-switch `CROW_DISABLE_HEALTH_MONITOR=1`; every `severity==="warn"` issue → `createNotification(... priority:"high" ...)`, deduped 24h per id via `shouldNotify()` + `dashboard_settings.health_last_notified` JSON map. **Any new warn signal auto-notifies.** |
| Notifications | `servers/shared/notifications.js` | `createNotification(db, {title, body, type, source, priority, action_url})` → table + bell + web-push + ntfy + email. |
| Failed logins | `dashboard/auth.js` `attemptLogin()` (~160-242) | lockout state persistent in `dashboard_settings` (`lockout:<ip>`); every failure → `auditLog(db,'auth_login_failure',{ip})`; lockout → `auditLog(db,'security_lockout_report',...)`. `audit_log` table exists (init-db ~1090) w/ index `idx_audit_log_event_created(event_type,created_at)`. **No new table.** Pre-existing bug: lockout-report passes `{ip,userAgent,attempts,lockedUntil}` but `auditLog()` (`servers/db.js:105`) reads only `{actor,ip,details}` → extras dropped. |
| Exposure guards | `servers/gateway/funnel.js` (`PUBLIC_FUNNEL_PREFIXES`, importable); `auth.js isAllowedNetwork()`; `index.js` (~80-104, `--no-auth`/`CROW_DASHBOARD_PUBLIC`); `csrf.js:45` (`CROW_CSRF_STRICT!=="0"`). No code queries live tailscale config today. |
| Backups | `routes/admin-backup.js` `runBackup()` → `performBackup()` (`db.js:405`, better-sqlite3 online backup). POST `/dashboard/nest/backup` + localhost `/api/admin/backup`. Honor `CROW_BACKUP_DIR`. **No verification today.** |
| Credential stores | `data_backends` has `status`/`last_error`/`last_connected_at`; `cross_host_calls` has per-peer `http_status`/`error`; Google tokens file-based JSON w/ `expiry` ISO + `refresh_token` (`scripts/google-mcp-auth.mjs:88`, override `GOOGLE_TOKEN_FILE`). Local connect token: no expiry → OUT OF SCOPE. Peer tokens: no expiry, failures show in `cross_host_calls` 401/403. |
| i18n | `dashboard/shared/i18n.js` `t(key,lang)`, flat `{en,es}`, NO interpolation (use `.replace("{n}",...)`). Existing 6 signals hardcode English — left untouched; NEW signals use `t()`. |
| Tests | `tests/health-signals.test.js` (stub-db, injectable clock), `tests/health-monitor-dedupe.test.js` (pure `shouldNotify`). |

---

## Files

**Modify:** health-signals.js (+3 collectors, upgrade backup, thread lang, generalize
shouldNotify, add pruneResolved); routes/admin-backup.js (verify after write);
dashboard/auth.js (fix audit details + immediate lockout notification); boot/post-listen.js
(prune resolved markers); panels/health.js (pass lang); shared/i18n.js (~20 keys).
**Create:** tests/security-signals.test.js, tests/backup-verify.test.js; extend
tests/health-monitor-dedupe.test.js. No new tables; new `dashboard_settings` keys
`backup_last_verified`, `lockout_notified_at`.

## Shared plumbing (health-signals.js)

- Cache becomes lang-aware (`_cacheLang`; recompute on lang change).
- `shouldNotify(lastMap, id, nowMs, windowMs=24h)` — add optional window, backward compatible.
- `pruneResolved(lastMap, activeIds)` — pure helper returning only active-id entries.
- Add `loginsSignal(db,lang)`, `exposureSignal(lang)`, `integrationsSignal(db,lang)` to
  the `Promise.all`; `backupSignal(db,nowFn,lang)`. `health.js` → `collectHealthSignals(db,{lang})`.

> **SQL TIME FILTERS (applies to signals 1 & 3) — C2:** `audit_log.created_at` and
> `cross_host_calls.at` are TEXT (`datetime('now')`). EVERY time filter MUST use
> `... >= datetime('now','-N hours')` (matches the text format AND hits the
> `(event_type,created_at)` / `(target_instance_id, at DESC)` indexes). NEVER compare
> against epoch-ms — it silently matches everything or nothing.

## Signal 1 — logins (failed-login visibility)

One indexed `audit_log` query: failures + distinct IPs in 24h, lockout-report count in 24h.
- 0 failures → ok (value "no failed attempts").
- 1-4 → ok (owner typos).
- ≥5 → info (strip only): "{n} failed sign-in attempts in the last day".
- ≥10 OR any lockout → warn (notifies): "Someone tried to sign in {n} times in the last day and was blocked". Action → `/dashboard/settings?section=two-factor`.

Immediate notification in `auth.js` lockout branch (don't wait ≤15min for monitor): fix
the dropped-details audit bug at the same time (nest the extras under `details`); fire
high-priority `createNotification` with 60-min cooldown marker
(`dashboard_settings.lockout_notified_at`). All wrapped in try/catch — notification
failure must never break login. **Q1 dedupe:** in the SAME block, seed
`health_last_notified["logins"] = Date.now()` so the 15-min monitor does NOT fire a
second notification for the same storm (auth.js owns the instant path; monitor suppressed
for 24h). auth.js's `db` is the async libsql-shaped client → `await db.execute(...)` is
correct; i18n import is `./shared/i18n.js` (auth.js is in dashboard/).

## Signal 2 — exposure ("you are exposed")  ⚠ C1-REVISED

**The reliable, high-value part = the three env flags. The tailscale-funnel part is
defensive and conservative (skip-not-warn on any doubt).**

Env checks (high-confidence, always evaluated):
- `CROW_DASHBOARD_PUBLIC==="true"` → warn ("Your Crow dashboard is open to the whole
  internet…").
- `process.argv.includes("--no-auth")` → warn ("The password requirement is turned off").
- `CROW_CSRF_STRICT==="0"` → warn ("A protection against request forgery is turned off")
  — **S4: no "CSRF" acronym in the user string.**

Funnel check — **C1: serve ≠ funnel.** Verified on crow: a healthy PRIVATE box has
`Web.<host:port>.Handlers["/"]` for EVERY served port and NO `AllowFunnel` key (all
"tailnet only"). Parsing `Web` handlers naively would warn "shared (/)" on a totally
private install — the exact day-1 false-warn to avoid. Correct logic:
- Read `cfg.AllowFunnel` (object of `"host:port" → true`). **Absent or empty → PRIVATE →
  contribute nothing** (this is the case for every box in the fleet today).
- For each hostport with `AllowFunnel[hp]===true`, inspect `cfg.Web[hp].Handlers` paths;
  warn only if a funnel-exposed path is NOT public-safe per `PUBLIC_FUNNEL_PREFIXES`
  (reuse funnel.js's trailing-slash-subtree-vs-exact matcher — **S3**, don't re-implement
  with `includes`). `/` funneled → warn "more of this Crow is shared to the internet than
  expected".
- The funnel-ON JSON shape (where the path sits under AllowFunnel) is UNVERIFIED — no
  fleet box has funnel enabled. So: wrap in try/catch and on ANY unexpected shape, SKIP
  (never warn). Validate against a real funnel-on box during E2E (briefly enable funnel
  on black-swan). Bias: a missed exposure (false negative) is recoverable; a day-1
  false-warn on a private box violates the north-star.

Mechanics: ONE cached (5-min) read via injectable `_setTailscaleReader`; the reader uses
`execFileSync("tailscale",["serve","status","-json"],{timeout:2000})`. CLI absent OR
erroring → null → skip silently (never warn). None of the above → ok ("private").
Action → `/dashboard/settings?section=connections`.
- 0.0.0.0 bind is the shipped default (guarded by isAllowedNetwork) → NOT a warn. No live
  external reachability probing. DETECT ONLY — never change exposure behavior.
- The nest is auth-gated + funnel-403'd, so this signal renders only to the authed owner
  — no info leak.

## Signal 3 — integrations (token/credential failure)

Three detectable sources, no live API probing. **Severity split: backends + peer-401 are
warn (real failure tracking); Google file heuristic is INFO only (S1 — it can
false-positive).**
1. `data_backends WHERE status='error'` — **Q4: AND `updated_at >= datetime('now','-30
   days')`** so a months-old stale error row doesn't warn forever. → warn.
2. Per trusted+active peer, latest outbound `cross_host_calls` row with `http_status IN
   (401,403)` AND `at >= datetime('now','-7 days')`. → warn.
3. Google token files (`GOOGLE_TOKEN_FILE` + `~/.config/google-workspace-mcp*/*.json`,
   cap 10): **S1 — Google omits `refresh_token` on re-consent, so "no refresh_token" is
   NOT proof of breakage.** Only flag as **INFO** (gentle "may need re-connecting"), and
   only when `token && !refresh_token && expiry` parses to a time MORE THAN 7 days in the
   past (well-dead, not a fresh 1h-expired access token). Guard the date parse against
   `undefined`/NaN explicitly. **S2: parse inside empty `catch {}` — NEVER log the file
   contents (it holds token/refresh_token/client_secret).**
- All empty → ok ("all working"). Any warn source → warn "{n} need attention" / "The
  connection to {name} has stopped working — it may need a new sign-in". Only the Google
  info source present → info (no notification). Action → `/dashboard/settings?section=integrations`.

## Signal 4 — backup integrity

(a) Verify at write time in `runBackup()`: after `performBackup`+`statSync`, open the
backup file readonly with better-sqlite3 and `PRAGMA quick_check` (standalone copy — safe
to open externally; the live-WAL hazard doesn't apply). Persist
`backup_last_verified={path,ok,result,size_bytes,checked_at}` to dashboard_settings; throw
on failure → existing `flash=backup_fail`/HTTP-500 path.
(b) Surface in `backupSignal`: keep existing age logic (none → info "Backups aren't set up
yet"; >7d → warn) and layer verification: damaged (unreadable / size 0 / stored ok:false
for newest path) → warn "Your latest backup may be damaged — make a new backup now";
predates verification / external copy → info "hasn't been checked yet — run a backup";
verified ok → value "today · checked ✓". Track `newestPath` alongside `newestMtimeMs`;
hot path uses cheap statSync only (no PRAGMA per render). **S5: the default for
`backup_last_verified.path !== newestPath` is the INFO "hasn't been checked yet" branch
(e.g. a hand-copied/external backup), NEVER a false "damaged" warn.**

## Notification dedupe (once per incident)

Monitor already gives "≤1/24h per id". Add: in post-listen.js after the notify loop,
`pruneResolved(lastMap, activeIds)` clears markers for resolved issues so a *recurrence*
notifies immediately. `activeIds` = ids of issues currently present (warn OR info), so a
warn→info downgrade KEEPS the marker (same incident, no re-notify); a full warn→ok
resolution drops the id → marker pruned → a genuine recurrence re-notifies (Q2: intended;
borderline flapping is bounded by the 30s signal cache + 15-min monitor interval, and
backup-age uses a 7-day threshold so it can't flap per-cycle). Login storms fire instantly
from auth.js (60-min cooldown) AND seed `health_last_notified["logins"]` to suppress the
monitor duplicate (Q1). Persisted keys (`backup_last_verified`, `lockout_notified_at`)
match the monitor's existing raw-`db.execute` upsert convention on base `dashboard_settings`
(S6 — these are local-only operational markers, not synced settings).

## Tests

- `tests/security-signals.test.js` (stub-db; `invalidateHealthCache()` first; stub
  audit_log/data_backends/cross_host_calls): logins 0→ok, 6→info, 14/lockout→warn;
  exposure clean+reader-throws→ok, DASHBOARD_PUBLIC→warn, CSRF=0→warn, funnel `/`→warn vs
  `/blog`→ok; integrations empty→ok, data_backends error→warn, peer 401→warn, google
  expired-no-refresh→warn vs with-refresh→ok; `shouldNotify` windowMs; `pruneResolved`.
- `tests/backup-verify.test.js`: real temp sqlite + temp CROW_BACKUP_DIR; runBackup →
  dest exists + `backup_last_verified.ok:true`; corrupt newest + stored ok:false →
  backupSignal warn; missing record + fresh file → info unverified.
- extend `tests/health-monitor-dedupe.test.js` with pruneResolved (one place only).
- Run with `tests/auth-network.test.js` too (auth.js touched — CLAUDE.md exposure rule).

## Commit sequence (branch `fix/w2-security-signals`)

1. auth.js + security-signals.test.js — W2-1 failed-login (audit fix + immediate notify).
2. admin-backup.js + backup-verify.test.js — W2-4 backup integrity (quick_check + record).
3. health-signals.js + health.js + i18n.js + security-signals.test.js — 3 signals + backup
   read + lang threading + tailscale check.
4. post-listen.js + health-signals.js + health-monitor-dedupe.test.js — incident dedupe.
`git show --stat HEAD` after each.

## Deploy (4 gateways) + verify

crow :3001, crow-mpa :3006, grackle :3002, black-swan :3001 — pull --ff-only + restart +
`/dashboard/nest` → 403 (mounted), `/health` → 200, journal `[health-monitor] armed`,
tailnet browser shows new cards (Sign-ins, Privacy, Connections, Backup).

## E2E verification

1. Logins: 5 wrong passwords from a tailnet machine → lockout → notification within
   seconds + warn strip ≤30s. Cleanup `DELETE FROM dashboard_settings WHERE key LIKE
   'lockout:%' OR key='lockout_notified_at'`.
2. Backup: Run-a-backup → flash=backup_ok + `backup_last_verified.ok:true`. Stale: touch
   `-d '10 days ago'`. Damaged: truncate a newest copy → warn. Restore by re-running.
3. Exposure: dev checkout `CROW_CSRF_STRICT=0` → warn; `tailscale funnel --set-path` on a
   test box → warn names path; NEVER set CROW_DASHBOARD_PUBLIC on prod (unit test covers).
4. Integrations: insert a `data_backends` error row OR drop an expired google token file → warn; remove to clear.
5. Dedupe: after a warn notifies, confirm `health_last_notified` gained the id; resolve;
   one monitor cycle prunes it; re-trigger → immediate new notification.
6. **Funnel-on validation (C1 follow-up):** briefly enable `tailscale funnel` on a
   non-public path on black-swan, capture `tailscale serve status -json`, confirm the
   exposure parser warns ONLY on the non-public path and that crow/grackle/mpa (serve-only,
   no AllowFunnel) stay ok. Reset funnel after. This pins the unverified funnel-ON shape.

## Review (round 1, 2026-06-13): REVISE → fixes applied

- **C1 (critical, fixed):** exposure signal would false-warn on every healthy private box
  — serve mounts `/` with no AllowFunnel. Rewrote to parse `AllowFunnel` only; serve-only
  ignored; funnel-on shape best-effort + skip-on-doubt; env flags are the reliable core.
  Verified the false-warn shape live on crow. Funnel-ON shape still needs the E2E capture.
- **C2 (critical, fixed):** all time filters pinned to `datetime('now','-N hours')` text
  form, not epoch ms.
- **S1 fixed:** Google detection downgraded to INFO + 7-day-dead gate (no-refresh-token is
  not proof of breakage). **S2:** never log token file contents. **S3:** reuse funnel
  matcher. **S4:** dropped "CSRF" acronym from the user string. **S5:** external/unverified
  backup → info not warn. **S6:** marker convention noted.
- **Q1 fixed:** auth.js seeds `health_last_notified["logins"]` to prevent a double
  notification. **Q2/Q3/Q4 addressed:** recurrence behavior documented; tailscale reader
  uses execFileSync+timeout, CLI-error → ok; data_backends gets a 30-day recency gate.
- Verified correct by reviewer: signal contract + strip "info" handling (peers/updates
  already ship info), monitor warn-only filter, async db.execute in auth.js, backup file
  safe to open read-only, all table/column names, funnel.js export + semantics.
