# crow.db corruption recovery

`crow.db` has corrupted twice the same way (2026-06-14, 2026-07-02): the
`cross_host_calls` federation-audit table is an unbounded, append-only,
high-write table, and a crash mid-write orphaned pages and spammed tens of
thousands of `disk image is malformed` errors while federation degraded
silently. Three hardening layers now exist; this doc covers the third — the
one-command recovery — and points at the other two.

## One command: `npm run recover-db`

Rebuilds a corrupt `crow.db` **offline** into a fresh, integrity-checked file,
salvaging every readable base table.

```bash
# Stop everything that opens crow.db FIRST (gateway + pi-bots + any same-host
# instances), then:
npm run recover-db -- --dry-run          # rehearse: build + verify, never swap
npm run recover-db                        # do it: build, verify, swap
```

Flags:

| Flag | Meaning |
|---|---|
| `--db <path>` | DB to recover (default `~/.crow/data/crow.db`). |
| `--dry-run` | Do everything **except** the swap. Leaves the rebuilt temp DB in place for inspection and never touches the original. |
| `--force` | Bypass the liveness gate (you assert the gateway/pi-bots are stopped). |

### What it does

1. **Liveness gate** — refuses to run if `crow.db`, `crow.db-wal`, or
   `crow.db-shm` have any open file handles (`lsof`/`fuser`). A TCP port check
   is *not* enough: pi-bots `bot_jobs` IPC, the WAL keeper, and other same-host
   gateway instances all open `crow.db`. Override with `--force`.
2. **Backup** — copies the corrupt DB (+ `-wal`/`-shm`) to `<db>.CORRUPT-<ts>`.
3. **Fresh schema** — runs the in-repo `scripts/init-db.js` into a temp file.
4. **Salvage** — `ATTACH`es the corrupt backup and `INSERT OR REPLACE`-copies
   every readable base table (shared columns only, so schema drift is
   survivable). FTS virtual tables are rebuilt via
   `INSERT INTO fts(fts) VALUES('rebuild')`.
   - **`crow_instances` is preserved** whenever it is readable — it is the
     peer-auth trust anchor (`validateInstanceToken` selects by
     `auth_token_hash`), so dropping it blacks out *all* federation until every
     peer re-enrolls. It is skipped **only** if its per-table `SELECT` throws a
     malformed error.
   - `cross_host_calls` (expendable audit) and `mcp_sessions` (ephemeral) are
     always dropped.
5. **MCP token re-inject** — re-writes `sha256(CROW_LOCAL_MCP_TOKEN)` (from the
   environment or `.env`) so headless MCP clients keep working, and validates
   it before allowing the swap.
6. **Two swap gates** — the rebuilt DB is installed **only if**:
   - `PRAGMA integrity_check` returns `ok`, **and**
   - every readable source table's row count exactly matches the copied count
     (a partially-readable source can't yield an "ok" but lossy DB).
   Any shortfall prints a loud diff and **aborts without swapping**; the
   rejected rebuild is left on disk for inspection.
7. **Swap** — atomically renames the rebuilt file over `<db>` and removes the
   stale `-wal`/`-shm`. Prints a runbook, every row count, and — if
   `crow_instances` had to be dropped — a **loud "federation peers must
   re-enroll"** warning.

### After a real recovery

- Restart the gateway and pi-bots so they reopen the fresh file
  (`sudo systemctl restart crow-gateway` + the pi-bots unit, etc.).
- The corrupt original stays at `<db>.CORRUPT-<ts>`; delete it once you trust
  the recovery.
- If the warning fired, re-pair each federation peer (grackle sync,
  black-swan, …) — they will be rejected until they re-enroll.

## The other two hardening layers

Recovery is the *last* resort. The root cause and the silent-failure mode are
addressed upstream:

- **Bounded retention + checkpoint** — `pruneCrossHostAudit` deletes
  `cross_host_calls` rows older than **14 days** (must exceed the 7-day
  `integrationsSignal` reader) and runs `PRAGMA wal_checkpoint(TRUNCATE)`,
  scheduled from `servers/gateway/boot/post-listen.js` (5-min initial delay,
  24h interval). The table now stays tiny — far less corruption surface, fast
  recovery. See `servers/shared/cross-host-audit-retention.js`.
- **Circuit breaker + loud alert** — when `auditCrossHostCall` sees a
  structural error (`malformed` / `not a database` / `disk image` /
  `SQLITE_IOERR`), it trips a per-process breaker that stops feeding the
  corruption and fires a **DB-free** ntfy + email alert (it does *not* route
  through `createNotification`, which would try to write the corrupt DB first).
  Surfaced in the nest as the `federation-audit` health signal. See
  `servers/shared/cross-host-auth.js`.
