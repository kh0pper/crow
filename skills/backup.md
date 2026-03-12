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
   This creates both a SQL dump (text, diffable) and a binary copy in `~/.crow/backups/`.

2. For a preview without writing files:
   ```bash
   bash scripts/backup.sh --dry-run
   ```

### Backup Destinations

- **Local** (always): `~/.crow/backups/` — runs by default, no config needed
- **S3/MinIO**: Set `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` in `.env`. Bucket: `CROW_BACKUP_S3_BUCKET` (default: `crow-backups`)
- **Git repo**: Set `CROW_BACKUP_GIT_REPO` in `.env` (e.g., a private Gitea repo). Only SQL dumps are committed — never binary `.db` files

### Retention

Old backups are pruned automatically. Default: 7 days. Configure with `CROW_BACKUP_KEEP_DAYS` in `.env`.

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

2. Preview what a restore would do:
   ```bash
   bash scripts/restore.sh <backup-file> --dry-run
   ```

3. Restore from a backup:
   ```bash
   bash scripts/restore.sh <backup-file>
   ```

The script automatically backs up the current database before overwriting it.

### Restore Types

- `.sql` files: Drops and recreates the database from the SQL dump
- `.db` files: Direct binary copy (faster, but less portable)

## Safety Confirmations

- Before restoring: Always show the backup file details (size, date, contents preview via `--dry-run`) and warn that the current database will be overwritten
- Before deleting backups: Confirm the number of files and date range being pruned
- The restore script always saves the current database as `.pre-restore-TIMESTAMP` before overwriting

## Tips

- SQL dumps are portable and work across SQLite versions
- Binary copies are faster to restore but version-dependent
- For Turso (cloud) databases, use the Turso CLI for backup/restore instead
- The backup script respects `CROW_DB_PATH` and `CROW_DATA_DIR` environment variables
