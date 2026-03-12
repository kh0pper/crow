#!/usr/bin/env bash
#
# Crow Backup Script
# Exports crow.db as SQL dump + binary copy to configurable destinations.
#
# Usage: ./scripts/backup.sh [--dry-run]
#
# Destinations (configurable via .env or environment):
#   - Local directory (always): ~/.crow/backups/
#   - S3/MinIO: if MINIO_ENDPOINT + MINIO_ACCESS_KEY are set
#   - Git repo: if CROW_BACKUP_GIT_REPO is set (SQL dumps only)
#
# Retention: CROW_BACKUP_KEEP_DAYS (default: 7)

set -euo pipefail

# --- Configuration ---

KEEP_DAYS="${CROW_BACKUP_KEEP_DAYS:-7}"
DRY_RUN=false
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DATE_ONLY=$(date +%Y%m%d)

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[dry-run] No files will be written or deleted."
fi

# Load .env if present (for S3/git credentials)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CROW_ROOT="$(dirname "$SCRIPT_DIR")"
if [[ -f "$CROW_ROOT/.env" ]]; then
  set -a
  source "$CROW_ROOT/.env"
  set +a
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

# --- Local backup directory ---

BACKUP_DIR="${CROW_BACKUP_DIR:-$HOME/.crow/backups}"

if [[ "$DRY_RUN" == false ]]; then
  mkdir -p "$BACKUP_DIR"
fi

SQL_FILE="$BACKUP_DIR/crow-${TIMESTAMP}.sql"
DB_FILE="$BACKUP_DIR/crow-${TIMESTAMP}.db"

echo "Crow Backup — $(date)"
echo "  Database: $DB_PATH"
echo "  Backup dir: $BACKUP_DIR"
echo "  Retention: $KEEP_DAYS days"
echo ""

# --- Step 1: SQL dump (text-based, git-friendly) ---

echo "Creating SQL dump..."
if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB_PATH" .dump > "$SQL_FILE"
  SQL_SIZE=$(du -h "$SQL_FILE" | cut -f1)
  echo "  SQL dump: $SQL_FILE ($SQL_SIZE)"
else
  echo "  [dry-run] Would create: $SQL_FILE"
fi

# --- Step 2: Binary copy (fast restore) ---

echo "Creating binary copy..."
if [[ "$DRY_RUN" == false ]]; then
  # Use sqlite3 backup command for consistency (handles WAL mode)
  sqlite3 "$DB_PATH" ".backup '$DB_FILE'"
  DB_SIZE=$(du -h "$DB_FILE" | cut -f1)
  echo "  Binary copy: $DB_FILE ($DB_SIZE)"
else
  echo "  [dry-run] Would create: $DB_FILE"
fi

# --- Step 3: S3/MinIO upload (if configured) ---

if [[ -n "${MINIO_ENDPOINT:-}" && -n "${MINIO_ACCESS_KEY:-}" && -n "${MINIO_SECRET_KEY:-}" ]]; then
  BUCKET="${CROW_BACKUP_S3_BUCKET:-crow-backups}"
  echo ""
  echo "Uploading to S3 ($MINIO_ENDPOINT / $BUCKET)..."

  if command -v mc &>/dev/null; then
    if [[ "$DRY_RUN" == false ]]; then
      mc alias set crow-backup "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --quiet 2>/dev/null || true
      mc mb --ignore-existing "crow-backup/$BUCKET" --quiet 2>/dev/null || true
      mc cp "$SQL_FILE" "crow-backup/$BUCKET/sql/" --quiet
      mc cp "$DB_FILE" "crow-backup/$BUCKET/db/" --quiet
      echo "  Uploaded SQL dump and binary copy to S3."
    else
      echo "  [dry-run] Would upload $SQL_FILE and $DB_FILE to $BUCKET"
    fi
  else
    echo "  Warning: 'mc' (MinIO client) not found. Skipping S3 upload."
    echo "  Install with: curl -O https://dl.min.io/client/mc/release/linux-amd64/mc && chmod +x mc"
  fi
fi

# --- Step 4: Git repo backup of SQL dump (if configured) ---

if [[ -n "${CROW_BACKUP_GIT_REPO:-}" ]]; then
  GIT_DIR="${CROW_BACKUP_GIT_DIR:-$HOME/.crow/backup-repo}"
  echo ""
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

# --- Step 5: Prune old local backups ---

echo ""
echo "Pruning backups older than $KEEP_DAYS days..."
if [[ "$DRY_RUN" == false ]]; then
  PRUNED=$(find "$BACKUP_DIR" -name "crow-*.sql" -o -name "crow-*.db" | while read -r f; do
    if [[ -f "$f" ]] && [[ $(find "$f" -mtime +"$KEEP_DAYS" 2>/dev/null) ]]; then
      rm "$f"
      echo "  Removed: $(basename "$f")"
    fi
  done)
  if [[ -z "$PRUNED" ]]; then
    echo "  No old backups to prune."
  fi
else
  OLD_COUNT=$(find "$BACKUP_DIR" -name "crow-*.sql" -mtime +"$KEEP_DAYS" 2>/dev/null | wc -l)
  OLD_COUNT=$((OLD_COUNT + $(find "$BACKUP_DIR" -name "crow-*.db" -mtime +"$KEEP_DAYS" 2>/dev/null | wc -l)))
  echo "  [dry-run] Would prune $OLD_COUNT files."
fi

echo ""
echo "Backup complete."
