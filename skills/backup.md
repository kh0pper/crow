---
name: backup
description: Database backup and restore — SQL dumps, binary copies, S3 upload, git archival
triggers:
  - back up
  - backup
  - restore
  - export data
  - data safety
tools: []
---

# Backup & Restore

## When to Activate

- User asks to back up their data
- User asks to restore from a backup
- User asks about data safety or export
- User mentions backup schedule or retention

## Backup Workflow

1. Run the backup script:
   ```bash
   bash scripts/backup.sh
   ```
   This writes a verified binary copy of the database into the backup directory — `~/backups/crow` by default, or `CROW_BACKUP_DIR`. When the `sqlite3` command-line tool is installed it also writes a SQL dump (text, diffable) named like the copy with `.sql`; without it the binary copy is complete on its own.

   The live database is never opened with `sqlite3`: if the gateway for THIS database is running it is asked for the copy (its answer names the database it backed up and the file it wrote, so a co-hosted gateway that serves another `CROW_HOME` is ignored), otherwise the script makes one itself — read-only — and only when no process has the database open. The files are named per instance (`<label>-<date>.db`; a second gateway with its own `CROW_HOME` gets `<label>-<home>-<hash>-<date>.db`) and come with an `.owner.json` sidecar, the same as the dashboard's "Run backup now".

   Which process has `crow.db` (or its `-wal`/`-shm`) open is what decides, not which port answers: `/proc/<pid>/fd` on Linux, `lsof` elsewhere. If the port answers but not like a gateway (a 5xx, a reset, a timeout), or the database is open and no gateway of ours answers on the port, the backup refuses and says who holds it — set `PORT`/`CROW_GATEWAY_PORT` to that gateway's port, or stop those processes.

   The Crow Artifacts blob store (`<data dir>/artifacts`) is copied too, to `<backup dir>/artifacts` — or, for an instance with its own `CROW_HOME` (a co-hosted second gateway), to `<backup dir>/artifacts-<stem>`. Each instance's `rsync --delete` stays inside its own subdirectory, so two instances never prune each other's blobs.

   **The identity is kept, locally only (N1c-10).** The instance's `identity.json` is copied into the same backup directory as `<stem>-identity-<date>.json` — `0600`, with the same `.owner.json` sidecar as the database copy, pruned with the run it belongs to. It stays on THIS machine: the S3 and git steps have an explicit allow-list (this run's `.db` and `.sql`) and a guard that refuses exactly what must not leave — this instance's identity copy name, any `identity.json`, and anything under `<CROW_HOME>/secrets` (a database copy whose stem merely contains the word "identity" still uploads) — so neither the identity nor the keychain key is ever uploaded or committed. `<CROW_HOME>/secrets` is never copied by any backup. The S3 step prints what it actually uploaded, or that it refused a file. A copy the owner can take anywhere is the passphrase-protected identity backup on the onboarding done step (Settings → Help & setup, or `npm run identity:export`); Crow asks for it once, on boot, in a dismissable notification. Keychain entries move with the Keychain's own passphrase Export.

   **After upgrading a tagged instance** (one with its own `CROW_HOME`): before the per-instance split its artifacts were copied into the shared `<backup dir>/artifacts`. The first backup after upgrading writes `<backup dir>/artifacts-<stem>`, and the host-default instance's next run (`rsync --delete` into `artifacts/`) drops the tagged instance's old files from that shared directory — so run a backup once right after upgrading, and the tagged instance's blobs then live in their own subdirectory. `restore.sh` prints the same note.

2. For a preview without writing files:
   ```bash
   bash scripts/backup.sh --dry-run
   ```

### Backup Destinations

- **Local** (always): `~/backups/crow` (`CROW_BACKUP_DIR`) — runs by default, no config needed. A directory the script creates is `0700` and everything in it is `0600`; an existing directory is never re-chmod'ed (it may be shared) — it is warned about instead when group or others can read it.
- **S3/MinIO**: Set `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` in `.env`. Bucket: `CROW_BACKUP_S3_BUCKET` (default: `crow-backups`)
- **Git repo**: Set `CROW_BACKUP_GIT_REPO` in `.env` (e.g., a private Gitea repo). Only SQL dumps are committed — never binary `.db` files. The host-default instance commits `crow-latest.sql` / `crow-<date>.sql`; a co-hosted instance (its own `CROW_HOME`) commits `crow-latest-<stem>.sql` / `crow-<stem>-<date>.sql`.

### Retention

Old backups are pruned automatically, per instance (a run never deletes another instance's files). Default: 7 days. Configure with `CROW_BACKUP_KEEP_DAYS` in `.env`.

### Automated Schedule

Add a cron entry for nightly backups:
```bash
crontab -e
# Add: 0 3 * * * /path/to/crow/scripts/backup.sh
```

## Restore Workflow

1. List available backups:
   ```bash
   bash scripts/restore.sh --list
   ```
   Backups in the old `~/.crow/backups` directory are listed under "Older backups" and can still be restored by name. This instance's identity copies (`*-identity-<date>.json`) are listed too.

2. Preview what a restore would do:
   ```bash
   bash scripts/restore.sh <backup-file> --dry-run
   ```

3. Restore from a backup (NOTHING may hold the database first — the script refuses while any process has `crow.db`/`-wal`/`-shm` open, names its pid, and refuses while something answers on the gateway port; there is no `--force`):
   ```bash
   systemctl --user stop crow-gateway
   bash scripts/restore.sh <backup-file>
   systemctl --user start crow-gateway
   ```

   Add `--with-identity` to put this machine's identity back from the same run (same stem and date):
   ```bash
   bash scripts/restore.sh <backup-file> --with-identity
   ```
   It writes `identity.json` `0600` only when the target has none yet, or already holds the same crow id. The copy is checked before it is used: a symlink is refused, a copy whose `.owner.json` sidecar names another Crow instance is refused ("That identity copy belongs to another Crow instance; it is not restored here."), and a copy whose seed does not derive the crow id it claims is refused. A DIFFERENT existing identity is refused ("This instance already has a different identity (crow id …). Move it aside yourself if you mean to replace it.") before anything changes — every bot key, contact and share derives from that seed, so it is never replaced silently. Without `--with-identity`, `identity.json` is never touched.

That plaintext identity copy is for restoring **on this machine**. To move to NEW hardware, restore the database and files there (`npm run restore -- <backup>`, no `--with-identity`) and bring the identity with the passphrase-protected identity backup: `npm run identity:import` with the copy made here (`npm run identity:export`, or the download from the onboarding done step / Settings → Help & setup). Never copy the backup folder's identity copy to another machine.

The script always saves the current database as `<db>.pre-restore-TIMESTAMP` before overwriting it. That copy is made with better-sqlite3, not `cp`, so data still sitting in `crow.db-wal` is included; if it cannot be made or does not verify, the restore stops and the database is NOT replaced. Before anything changes, the backup FILE is checked too: one that is the live database itself (or its `-wal`/`-shm`), one that is empty, or one that fails `quick_check` is refused. The copy then lands in a temp file beside the database, is verified there, and only then replaces it — so a failed restore leaves the old database and its WAL exactly as they were. A `.sql` dump must also create at least one table and end with `COMMIT;`: a dump cut short at a statement boundary replays "successfully" into half a database, so it is refused instead. Stale `crow.db-wal` / `crow.db-shm` of the database being replaced are removed at that last step, the restored file keeps the old file's owner and mode, and the result is verified (integrity check plus table and memory counts) before the script reports success. A database reached through a symlink is handled by replacing the real file, leaving the symlink in place.

A database alone is not a full recovery: Artifacts rows point at blobs by sha256 key. This instance's blobs are in `<backup dir>/artifacts` (an instance with its own `CROW_HOME`: `<backup dir>/artifacts-<stem>`) — copy them back to `<data dir>/artifacts/` after the restore. The restore script prints the exact path when it exists, and it prints only THIS instance's copy: the backup directory may be shared with a co-hosted instance, whose `artifacts-<stem>` is not this database's blobs.

### Restore Types

- `.db` files: binary copy — needs no external tool, and is the recommended kind
- `.sql` files: replayed with the `sqlite3` command-line tool into a temp file that is checked before it replaces the database; if the tool is not installed the script says so and stops rather than leaving a half-restored database

## Safety Confirmations

- Before restoring: Always show the backup file details (size, date, contents preview via `--dry-run`) and warn that the current database will be overwritten
- Before deleting backups: Confirm the number of files and date range being pruned
- The restore script always saves the current database as `.pre-restore-TIMESTAMP` before overwriting
- Never restore while anything holds the database: stop the gateway (`systemctl --user stop crow-gateway`) and any other Crow server or bridge using it
- Back up only through `scripts/backup.sh` (or the dashboard's "Run backup now"): it never opens a live WAL database from an external process

## Tips

- SQL dumps are portable and work across SQLite versions (they need the `sqlite3` command-line tool)
- Binary copies restore without any external tool and are the product's own format
- The backup script respects `CROW_DB_PATH` and `CROW_DATA_DIR` environment variables
