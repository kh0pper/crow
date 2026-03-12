#!/usr/bin/env bash
#
# Crow Restore Script
# Restores crow.db from a SQL dump (.sql) or binary copy (.db).
#
# Usage:
#   ./scripts/restore.sh <backup-file>           # Restore from file
#   ./scripts/restore.sh <backup-file> --dry-run  # Preview without restoring
#   ./scripts/restore.sh --list                    # List available backups

set -euo pipefail

# --- Configuration ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CROW_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [[ -f "$CROW_ROOT/.env" ]]; then
  set -a
  source "$CROW_ROOT/.env"
  set +a
fi

# Resolve database path
if [[ -n "${CROW_DB_PATH:-}" ]]; then
  DB_PATH="$CROW_DB_PATH"
elif [[ -d "$HOME/.crow/data" ]]; then
  DB_PATH="$HOME/.crow/data/crow.db"
else
  DB_PATH="$CROW_ROOT/data/crow.db"
fi

BACKUP_DIR="${CROW_BACKUP_DIR:-$HOME/.crow/backups}"

# --- List mode ---

if [[ "${1:-}" == "--list" ]]; then
  echo "Available backups in $BACKUP_DIR:"
  echo ""
  if [[ -d "$BACKUP_DIR" ]]; then
    ls -lhtr "$BACKUP_DIR"/crow-*.{sql,db} 2>/dev/null | awk '{print "  " $NF " (" $5 ", " $6 " " $7 " " $8 ")"}'
    COUNT=$(ls "$BACKUP_DIR"/crow-*.{sql,db} 2>/dev/null | wc -l)
    echo ""
    echo "$COUNT backup file(s) found."
  else
    echo "  No backup directory found at $BACKUP_DIR"
  fi
  exit 0
fi

# --- Validate arguments ---

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <backup-file> [--dry-run]"
  echo "       $0 --list"
  echo ""
  echo "Restores crow.db from a .sql dump or .db binary copy."
  exit 1
fi

BACKUP_FILE="$1"
DRY_RUN=false
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# If given just a filename (not a path), look in backup dir
if [[ ! -f "$BACKUP_FILE" && -f "$BACKUP_DIR/$BACKUP_FILE" ]]; then
  BACKUP_FILE="$BACKUP_DIR/$BACKUP_FILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Detect backup type
EXT="${BACKUP_FILE##*.}"
if [[ "$EXT" != "sql" && "$EXT" != "db" ]]; then
  echo "Error: Unsupported file type '.$EXT'. Expected .sql or .db"
  exit 1
fi

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
BACKUP_DATE=$(stat -c %y "$BACKUP_FILE" 2>/dev/null | cut -d. -f1 || stat -f "%Sm" "$BACKUP_FILE" 2>/dev/null || echo "unknown")

echo "Crow Restore"
echo "  Backup file: $BACKUP_FILE ($BACKUP_SIZE)"
echo "  Backup date: $BACKUP_DATE"
echo "  Target DB:   $DB_PATH"
echo "  Type:        $EXT"
echo ""

# --- Dry run: preview contents ---

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] Preview of backup contents:"
  echo ""
  if [[ "$EXT" == "sql" ]]; then
    # Count tables and rows from SQL dump
    echo "  Tables found:"
    grep -c "^CREATE TABLE" "$BACKUP_FILE" | xargs -I{} echo "    {} CREATE TABLE statements"
    grep -c "^INSERT INTO" "$BACKUP_FILE" | xargs -I{} echo "    {} INSERT statements"
    echo ""
    echo "  Tables:"
    grep "^CREATE TABLE" "$BACKUP_FILE" | sed 's/CREATE TABLE IF NOT EXISTS /    /;s/CREATE TABLE /    /;s/ (.*//'
  else
    # For binary, show table list via sqlite3
    echo "  Tables:"
    sqlite3 "$BACKUP_FILE" ".tables" 2>/dev/null | sed 's/^/    /' || echo "    (could not read — file may be corrupt)"
    echo ""
    echo "  Row counts:"
    for table in $(sqlite3 "$BACKUP_FILE" ".tables" 2>/dev/null); do
      COUNT=$(sqlite3 "$BACKUP_FILE" "SELECT COUNT(*) FROM \"$table\";" 2>/dev/null || echo "?")
      echo "    $table: $COUNT"
    done
  fi
  echo ""
  echo "[dry-run] No changes made. Remove --dry-run to restore."
  exit 0
fi

# --- Safety: backup current DB before overwriting ---

if [[ -f "$DB_PATH" ]]; then
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  PRE_RESTORE="$DB_PATH.pre-restore-${TIMESTAMP}"
  echo "Backing up current database to $PRE_RESTORE..."
  cp "$DB_PATH" "$PRE_RESTORE"
fi

# --- Restore ---

echo "Restoring..."

if [[ "$EXT" == "db" ]]; then
  # Binary restore: direct copy
  cp "$BACKUP_FILE" "$DB_PATH"
  echo "  Binary copy restored."
elif [[ "$EXT" == "sql" ]]; then
  # SQL restore: drop existing, replay dump
  # Remove existing DB (the SQL dump recreates everything)
  rm -f "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"
  sqlite3 "$DB_PATH" < "$BACKUP_FILE"
  echo "  SQL dump replayed."
fi

# --- Verify ---

echo ""
echo "Verifying restored database..."
TABLE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "0")
MEMORY_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo "0")
echo "  Tables: $TABLE_COUNT"
echo "  Memories: $MEMORY_COUNT"

echo ""
echo "Restore complete."
if [[ -n "${PRE_RESTORE:-}" ]]; then
  echo "Previous database saved at: $PRE_RESTORE"
fi
