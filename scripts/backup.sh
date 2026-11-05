#!/usr/bin/env bash
#
# Crow Backup Script
# Writes a verified binary copy of crow.db (plus an SQL dump when the sqlite3
# CLI is installed) to the backup directory, and optionally uploads it.
#
# Usage: ./scripts/backup.sh [--dry-run]
#
# The copy is made by scripts/backup-db.mjs, never by the sqlite3 CLI on the
# live file: if the gateway answers on its port it is asked for the copy
# (POST /api/admin/backup — an in-process better-sqlite3 .backup(), verified,
# named and sidecarred like every other backup); with no gateway, the helper
# opens the database itself with better-sqlite3 and renames a verified copy
# into place under the same name. Opening a live WAL crow.db from an external
# process is what used to orphan the gateway's -wal/-shm file descriptors.
# The SQL dump is taken from the verified copy, never from the live file.
#
# Destinations (configurable via .env or environment):
#   - Local directory (always): $CROW_BACKUP_DIR, else ~/backups/crow
#     (servers/shared/backup-naming.js resolveBackupDir — the dashboard's
#     "Run backup now" writes to the same place with the same names)
#   - S3 (Garage or any S3 endpoint): if S3_ENDPOINT + S3_ACCESS_KEY + S3_SECRET_KEY
#     are set (the older MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY still work)
#   - Git repo: if CROW_BACKUP_GIT_REPO is set (SQL dumps only)
#
# Retention: CROW_BACKUP_KEEP_DAYS (default: 7), per instance.
#
# Mode bits: everything this script writes is 0600 in a 0700 directory.

set -euo pipefail
# Nothing written by a backup (copy, dump, sidecar, artifacts) may be
# world-readable: a crow.db holds everything Crow knows.
umask 077

# --- Configuration ---

KEEP_DAYS="${CROW_BACKUP_KEEP_DAYS:-7}"
DRY_RUN=false
DATE_ONLY=$(date +%Y%m%d)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# Load .env if present (for S3/git credentials and the instance paths)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CROW_ROOT="$(dirname "$SCRIPT_DIR")"
if [[ -f "$CROW_ROOT/.env" ]]; then
  set -a
  source "$CROW_ROOT/.env"
  set +a
fi

NODE_BIN="${NODE:-node}"
BACKUP_HELPER="$SCRIPT_DIR/backup-db.mjs"

if ! command -v "$NODE_BIN" &>/dev/null; then
  echo "Error: node not found on PATH (the backup copy needs better-sqlite3)."
  exit 1
fi

# --- Resolve database path ---

if [[ -n "${CROW_DB_PATH:-}" ]]; then
  DB_PATH="$CROW_DB_PATH"
elif [[ -d "$HOME/.crow/data" ]]; then
  DB_PATH="$HOME/.crow/data/crow.db"
else
  DB_PATH="$CROW_ROOT/data/crow.db"
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "Error: Database not found at $DB_PATH"
  echo "Run 'npm run setup' in the crow directory first."
  exit 1
fi

# --- Local backup directory (== resolveBackupDir: CROW_BACKUP_DIR, else ~/backups/crow) ---

if [[ -n "${CROW_BACKUP_DIR:-}" ]]; then
  BACKUP_DIR="$CROW_BACKUP_DIR"
else
  BACKUP_DIR="$("$NODE_BIN" "$BACKUP_HELPER" --backup-dir)"
fi

echo "Crow Backup — $(date)"
echo "  Database: $DB_PATH"
echo "  Backup dir: $BACKUP_DIR"
echo "  Retention: $KEEP_DAYS days"
echo ""

REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/crow-backup-report.XXXXXX")"
trap 'rm -f "$REPORT_FILE"' EXIT

# --- Step 1: the binary copy (and the SQL dump taken from it) ---

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] No files will be written or deleted."
  echo ""
  echo "Creating binary copy..."
  "$NODE_BIN" "$BACKUP_HELPER" --names --report "$REPORT_FILE" --db "$DB_PATH"
  # shellcheck disable=SC1090
  source "$REPORT_FILE"
  echo "  [dry-run] Would create: $DB_FILE"
  echo "Creating SQL dump from that copy..."
  echo "  [dry-run] Would create: $SQL_FILE"
else
  if [[ ! -d "$BACKUP_DIR" ]]; then
    mkdir -p -m 700 "$BACKUP_DIR"
  fi
  # Tighten a dir that predates this rule — only when it is ours to change.
  if [[ -O "$BACKUP_DIR" ]]; then
    chmod 700 "$BACKUP_DIR"
  fi
  if [[ "$(stat -c %a "$BACKUP_DIR" 2>/dev/null || echo 700)" != "700" ]]; then
    echo "  Warning: $BACKUP_DIR is not 0700 and not yours to change; backups in it may be readable by others."
  fi
  echo "Creating binary copy..."
  "$NODE_BIN" "$BACKUP_HELPER" --report "$REPORT_FILE" --db "$DB_PATH"
  # shellcheck disable=SC1090
  source "$REPORT_FILE"
fi

# --- Step 2: Artifacts blob store (Crow Artifacts) ---
# <dataDir>/artifacts/ holds the content-addressed blob objects and the
# cross-process write lock. Artifact DB rows reference blobs by sha256 key, so
# a restore needs BOTH the database and this directory. On installs using MinIO
# for shared storage the blobs live in the <prefix>-artifacts bucket instead
# (backed up with MinIO itself) and this directory holds only the lock file.
# The rsync runs without coordination with live writers: blobs are
# content-addressed and immutable, and an in-flight temp object that sneaks
# into the copy is reclaimed by reconcileBlobs on the restored boot.

ARTIFACTS_DIR="$(dirname "$DB_PATH")/artifacts"
if [[ -d "$ARTIFACTS_DIR" ]]; then
  echo "Copying artifacts store..."
  if [[ "$DRY_RUN" == false ]]; then
    mkdir -p -m 700 "$BACKUP_DIR/artifacts"
    # --no-links: a symlink planted into the store is never followed or copied.
    # --chmod: the copy is ours, so force private dirs/files whatever the
    # source modes are.
    rsync -a --no-links --delete --chmod=D700,F600 "$ARTIFACTS_DIR/" "$BACKUP_DIR/artifacts/"
    if [[ -O "$BACKUP_DIR/artifacts" ]]; then
      chmod 700 "$BACKUP_DIR/artifacts"
    fi
    echo "  Artifacts: $BACKUP_DIR/artifacts ($(du -sh "$BACKUP_DIR/artifacts" | cut -f1))"
  else
    echo "  [dry-run] Would rsync $ARTIFACTS_DIR/ to $BACKUP_DIR/artifacts/"
  fi
fi

# --- Step 3: S3 upload (if configured) ---
# S3_* first; the older MINIO_* names are the fallback. An endpoint without a scheme
# gets http:// (https:// with S3_USE_SSL=true), as `mc alias set` needs a URL.

S3_EP="${S3_ENDPOINT:-${MINIO_ENDPOINT:-}}"
S3_AK="${S3_ACCESS_KEY:-${MINIO_ACCESS_KEY:-}}"
S3_SK="${S3_SECRET_KEY:-${MINIO_SECRET_KEY:-}}"
if [[ -n "$S3_EP" && "$S3_EP" != http://* && "$S3_EP" != https://* ]]; then
  if [[ "${S3_USE_SSL:-${MINIO_USE_SSL:-false}}" == "true" ]]; then S3_EP="https://$S3_EP"; else S3_EP="http://$S3_EP"; fi
fi

if [[ -n "$S3_EP" && -n "$S3_AK" && -n "$S3_SK" ]]; then
  BUCKET="${CROW_BACKUP_S3_BUCKET:-crow-backups}"
  echo ""
  echo "Uploading to S3 ($S3_EP / $BUCKET)..."

  if command -v mc &>/dev/null; then
    if [[ "$DRY_RUN" == false ]]; then
      mc alias set crow-backup "$S3_EP" "$S3_AK" "$S3_SK" --quiet 2>/dev/null || true
      mc mb --ignore-existing "crow-backup/$BUCKET" --quiet 2>/dev/null || true
      if [[ -n "${SQL_FILE:-}" && -f "$SQL_FILE" ]]; then
        mc cp "$SQL_FILE" "crow-backup/$BUCKET/sql/" --quiet
      fi
      mc cp "$DB_FILE" "crow-backup/$BUCKET/db/" --quiet
      echo "  Uploaded this run's files to S3."
    else
      echo "  [dry-run] Would upload $SQL_FILE and $DB_FILE to $BUCKET"
    fi
  else
    echo "  Warning: 'mc' (an S3 client) not found. Skipping S3 upload."
    echo "  Install with: curl -O https://dl.min.io/client/mc/release/linux-amd64/mc && chmod +x mc"
  fi
fi

# --- Step 4: Git repo backup of the SQL dump (if configured) ---

if [[ -n "${CROW_BACKUP_GIT_REPO:-}" ]]; then
  GIT_DIR="${CROW_BACKUP_GIT_DIR:-$HOME/.crow/backup-repo}"
  echo ""
  if [[ -z "${SQL_FILE:-}" || ! -f "$SQL_FILE" ]]; then
    echo "Skipping the git backup: no SQL dump was produced (the sqlite3 CLI is not installed)."
    echo "The binary copy $DB_FILE is complete; a .db can be committed if your repo allows binary files."
  else
    echo "Committing SQL dump to git ($CROW_BACKUP_GIT_REPO)..."

    if [[ "$DRY_RUN" == false ]]; then
      if [[ ! -d "$GIT_DIR/.git" ]]; then
        git clone "$CROW_BACKUP_GIT_REPO" "$GIT_DIR" 2>/dev/null
      fi

      cp "$SQL_FILE" "$GIT_DIR/crow-latest.sql"
      cd "$GIT_DIR"
      git add crow-latest.sql

      # Also keep dated snapshots (but only SQL — never binary .db)
      cp "$SQL_FILE" "$GIT_DIR/crow-${DATE_ONLY}.sql"
      git add "crow-${DATE_ONLY}.sql"

      # Ensure .gitignore blocks binary and sensitive files
      if [[ ! -f .gitignore ]] || ! grep -q '*.db' .gitignore; then
        cat >> .gitignore << 'GITIGNORE'
*.db
*.db-wal
*.db-shm
.env
*.key
*.pem
GITIGNORE
        git add .gitignore
      fi

      if git diff --cached --quiet; then
        echo "  No changes to commit."
      else
        git commit -m "Crow backup ${TIMESTAMP}" --quiet
        git push --quiet 2>/dev/null || echo "  Warning: git push failed. Commit saved locally."
        echo "  Committed and pushed SQL dump."
      fi
    else
      echo "  [dry-run] Would commit SQL dump to $GIT_DIR"
    fi
  fi
fi

# --- Step 5: Prune old backups (this instance's only) ---

echo ""
if [[ "$DRY_RUN" == true ]]; then
  echo "Checking backups older than $KEEP_DAYS days..."
else
  echo "Pruning backups older than $KEEP_DAYS days..."
fi
PRUNE_ARGS=(--prune)
if [[ "$DRY_RUN" == true ]]; then
  PRUNE_ARGS+=(--dry-run)
fi
"$NODE_BIN" "$BACKUP_HELPER" "${PRUNE_ARGS[@]}"

echo ""
echo "Backup complete."