#!/usr/bin/env bash
#
# Crow Restore Script
# Restores crow.db from a binary copy (.db) or a SQL dump (.sql).
#
# Usage:
#   ./scripts/restore.sh <backup-file>            # Restore from file
#   ./scripts/restore.sh <backup-file> --dry-run  # Preview without restoring
#   ./scripts/restore.sh --list                   # List available backups
#
# Backups are read from the same directory `npm run backup` and the dashboard's
# "Run backup now" write to (CROW_BACKUP_DIR, else ~/backups/crow). Files still
# sitting in the old ~/.crow/backups directory are listed and can be restored
# by name too.
#
# The gateway must be STOPPED before a restore: it holds the live database's
# -wal/-shm and would keep writing through descriptors to a file we replace.
# There is no --force; stop the gateway (systemctl --user stop crow-gateway)
# and run the restore again.
#
# Node helpers (scripts/restore-db.mjs) do everything that used to need the
# sqlite3 CLI: the whole pre-restore safety copy, the .db preview and the
# verification. Only replaying a .sql dump still needs sqlite3.

set -euo pipefail
# The safety copy and the restored database are as sensitive as the original.
umask 077

# --- Configuration ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CROW_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env if present (for the instance paths and the gateway port)
if [[ -f "$CROW_ROOT/.env" ]]; then
  set -a
  source "$CROW_ROOT/.env"
  set +a
fi

NODE_BIN="${NODE:-node}"
BACKUP_HELPER="$SCRIPT_DIR/backup-db.mjs"
RESTORE_HELPER="$SCRIPT_DIR/restore-db.mjs"

if ! command -v "$NODE_BIN" &>/dev/null; then
  echo "Error: node not found on PATH (restore needs better-sqlite3)."
  exit 1
fi

# Resolve database path
if [[ -n "${CROW_DB_PATH:-}" ]]; then
  DB_PATH="$CROW_DB_PATH"
elif [[ -d "$HOME/.crow/data" ]]; then
  DB_PATH="$HOME/.crow/data/crow.db"
else
  DB_PATH="$CROW_ROOT/data/crow.db"
fi

# Backup directory == resolveBackupDir: CROW_BACKUP_DIR, else ~/backups/crow
if [[ -n "${CROW_BACKUP_DIR:-}" ]]; then
  BACKUP_DIR="$CROW_BACKUP_DIR"
else
  BACKUP_DIR="$("$NODE_BIN" "$BACKUP_HELPER" --backup-dir)"
fi

# Where backups lived before the backup directory was unified. Read-only
# fallback: listed by --list and still restorable by bare file name.
LEGACY_DIR="$HOME/.crow/backups"

# --- List mode ---

print_entries() {
  # shellcheck disable=SC2012
  ls -lhtr -- "$@" 2>/dev/null | awk '{print "  " $NF " (" $5 ", " $6 " " $7 " " $8 ")"}'
}

if [[ "${1:-}" == "--list" ]]; then
  echo "Available backups in $BACKUP_DIR:"
  echo ""
  COUNT=0
  if [[ -d "$BACKUP_DIR" ]]; then
    shopt -s nullglob
    ENTRIES=("$BACKUP_DIR"/*.db "$BACKUP_DIR"/*.sql)
    shopt -u nullglob
    COUNT=${#ENTRIES[@]}
    if [[ "$COUNT" -gt 0 ]]; then
      print_entries "${ENTRIES[@]}"
    else
      echo "  (none)"
    fi
  else
    echo "  No backup directory found at $BACKUP_DIR"
  fi
  echo ""
  echo "$COUNT backup file(s) found."

  # The old location: only this product's own file shapes, only when it is a
  # different directory (a host that never had one prints nothing).
  if [[ -d "$LEGACY_DIR" && "$(cd "$LEGACY_DIR" && pwd -P)" != "$(cd "$BACKUP_DIR" 2>/dev/null && pwd -P || echo "")" ]]; then
    shopt -s nullglob
    LEGACY_ENTRIES=("$LEGACY_DIR"/crow-*.db "$LEGACY_DIR"/crow-*.sql)
    shopt -u nullglob
    if [[ ${#LEGACY_ENTRIES[@]} -gt 0 ]]; then
      echo ""
      echo "Older backups (~/.crow/backups):"
      echo ""
      print_entries "${LEGACY_ENTRIES[@]}"
      echo ""
      echo "Restore one by name (e.g. restore.sh $(basename "${LEGACY_ENTRIES[0]}")) — they are not pruned."
    fi
  fi
  exit 0
fi

# --- Validate arguments ---

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <backup-file> [--dry-run]"
  echo "       $0 --list"
  echo ""
  echo "Restores crow.db from a .db binary copy or a .sql dump."
  exit 1
fi

BACKUP_FILE="$1"
DRY_RUN=false
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# If given just a filename (not a path), look in the backup dir, then the old one.
if [[ ! -f "$BACKUP_FILE" && -f "$BACKUP_DIR/$BACKUP_FILE" ]]; then
  BACKUP_FILE="$BACKUP_DIR/$BACKUP_FILE"
fi
if [[ ! -f "$BACKUP_FILE" && -f "$LEGACY_DIR/$BACKUP_FILE" ]]; then
  BACKUP_FILE="$LEGACY_DIR/$BACKUP_FILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  echo "Looked in $BACKUP_DIR and $LEGACY_DIR."
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

# --- Dry run: preview contents (read-only, so it is allowed while the gateway runs) ---

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] Preview of backup contents:"
  echo ""
  if [[ "$EXT" == "sql" ]]; then
    # Count tables and rows from the SQL dump
    echo "  Tables found:"
    grep -c "^CREATE TABLE" "$BACKUP_FILE" | xargs -I{} echo "    {} CREATE TABLE statements"
    grep -c "^INSERT INTO" "$BACKUP_FILE" | xargs -I{} echo "    {} INSERT statements"
    echo ""
    echo "  Tables:"
    grep "^CREATE TABLE" "$BACKUP_FILE" | sed 's/CREATE TABLE IF NOT EXISTS /    /;s/CREATE TABLE /    /;s/ (.*//'
  else
    # A binary copy is inspected with better-sqlite3, never the sqlite3 CLI.
    "$NODE_BIN" "$RESTORE_HELPER" inspect "$BACKUP_FILE"
  fi
  echo ""
  echo "[dry-run] No changes made. Remove --dry-run to restore."
  exit 0
fi

# --- Refuse while the gateway is running (no --force: this one has no override) ---

GATEWAY_STATE="$("$NODE_BIN" "$RESTORE_HELPER" gateway-check 2>/dev/null || true)"
if [[ -z "$GATEWAY_STATE" ]]; then
  echo "Error: could not check whether the gateway is running (node/better-sqlite3 failed)."
  echo "Refusing to replace $DB_PATH without that check."
  exit 1
fi
GATEWAY_PORT="${GATEWAY_STATE%% *}"
GATEWAY_STATE="${GATEWAY_STATE##* }"
if [[ "$GATEWAY_STATE" == "up" ]]; then
  echo "Error: The gateway is running on port $GATEWAY_PORT. Stop it first"
  echo "(systemctl --user stop crow-gateway, or stop the process), then run the restore again."
  exit 1
fi

if [[ "$EXT" == "sql" ]] && ! command -v sqlite3 &>/dev/null; then
  echo "Error: the sqlite3 command-line tool is not installed, so a .sql dump cannot be replayed."
  echo "  Install it (e.g. sudo apt install sqlite3) and run the restore again, or restore a"
  echo "  .db binary copy instead — that needs no external tool."
  exit 1
fi

# --- Safety: whole copy of the current DB before overwriting ---
# A `cp crow.db` would miss everything still sitting in crow.db-wal, so this is
# a better-sqlite3 online .backup(): it reads through the WAL and writes one
# self-contained 0600 file.

PRE_RESTORE=""
if [[ -f "$DB_PATH" ]]; then
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  PRE_RESTORE="$DB_PATH.pre-restore-${TIMESTAMP}"
  echo "Saving the current database (whole, WAL included) to $PRE_RESTORE..."
  "$NODE_BIN" "$RESTORE_HELPER" safety-copy "$DB_PATH" "$PRE_RESTORE"
fi

# --- Restore ---

echo "Restoring..."

if [[ "$EXT" == "db" ]]; then
  # Stale WAL/SHM of the DB being replaced must never be replayed onto the
  # restored file (they belong to the OLD database).
  rm -f -- "${DB_PATH}-wal" "${DB_PATH}-shm"
  # Copy beside the DB, then rename: an interrupted copy can never leave a
  # half-written crow.db under the real name.
  TMP_RESTORE="${DB_PATH}.restore-${TIMESTAMP:-$(date +%Y%m%d-%H%M%S)}-$$.tmp"
  trap 'rm -f -- "$TMP_RESTORE"' EXIT
  cp -- "$BACKUP_FILE" "$TMP_RESTORE"
  chmod 600 "$TMP_RESTORE"
  mv -f -- "$TMP_RESTORE" "$DB_PATH"
  trap - EXIT
  echo "  Binary copy restored."
elif [[ "$EXT" == "sql" ]]; then
  # SQL restore: drop existing, replay dump (creates a fresh database file)
  rm -f -- "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"
  sqlite3 "$DB_PATH" < "$BACKUP_FILE"
  chmod 600 "$DB_PATH" 2>/dev/null || true
  echo "  SQL dump replayed."
fi

# --- Verify (node/better-sqlite3: quick_check + table and memories counts) ---

echo ""
echo "Verifying restored database..."
"$NODE_BIN" "$RESTORE_HELPER" verify "$DB_PATH"

echo ""
echo "Restore complete."
if [[ -n "$PRE_RESTORE" ]]; then
  echo "Previous database saved at: $PRE_RESTORE"
fi
echo "Start the gateway again when you are ready: systemctl --user start crow-gateway"