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
# A restore refuses while ANY process holds the database open — a live
# gateway, a second instance's server, a bridge, an sqlite3 shell
# (scripts/restore-db.mjs dbHolders: /proc/<pid>/fd, else lsof) — and while
# something answers on the gateway port. A live gateway holds the live
# database's -wal/-shm and would keep writing through descriptors to a file we
# replace. There is no --force; stop the processes (systemctl --user stop
# crow-gateway) and run the restore again.
#
# Node helpers (scripts/restore-db.mjs) do everything that used to need the
# sqlite3 CLI: the source check, the whole pre-restore safety copy, the copy
# into place and the verification. Only replaying a .sql dump still needs
# sqlite3.
#
# Nothing is changed before the SOURCE has been checked: a backup that is the
# live database itself (or its -wal/-shm), one that is empty, or one that fails
# quick_check is refused with the old database untouched. The copy then lands in
# a temp file BESIDE the database and is verified there; only after that are the
# old -wal/-shm removed and the temp renamed into place, so a failed restore
# always leaves the old database and its WAL intact. The restored file keeps the
# old database's owner and mode.
#
# Artifacts: `npm run backup` also copies the Crow Artifacts blob store to
# <backup dir>/artifacts (an instance with its own CROW_HOME:
# <backup dir>/artifacts-<stem>). Rows reference blobs by sha256 key, so a full
# recovery restores the database AND that directory; this script restores the
# database only and prints where the blobs are.

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

# If given just a filename (not a path), look in the backup dir, then the old
# one, and only then the current directory.
if [[ "$BACKUP_FILE" != */* ]]; then
  if [[ -f "$BACKUP_DIR/$BACKUP_FILE" ]]; then
    BACKUP_FILE="$BACKUP_DIR/$BACKUP_FILE"
  elif [[ -f "$LEGACY_DIR/$BACKUP_FILE" ]]; then
    BACKUP_FILE="$LEGACY_DIR/$BACKUP_FILE"
  elif [[ -f "$BACKUP_FILE" ]]; then
    BACKUP_FILE="$(pwd)/$BACKUP_FILE"
  fi
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  echo "Looked in $BACKUP_DIR, $LEGACY_DIR and the current directory."
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

# --- Refuse a bad source before anything changes ---
#   exit 0 = the source is a usable backup of something other than the target
#   exit 4 = refused (the sentence is on stdout); nothing has been touched
#   other  = the check itself could not run
set +e
SOURCE_CHECK="$("$NODE_BIN" "$RESTORE_HELPER" check-source "$BACKUP_FILE" "$DB_PATH" 2>&1)"
SOURCE_STATUS=$?
set -e
if [[ -n "$SOURCE_CHECK" ]]; then
  echo "$SOURCE_CHECK"
fi
if [[ "$SOURCE_STATUS" -eq 4 ]]; then
  echo ""
  echo "Nothing has been changed."
  exit 1
fi
if [[ "$SOURCE_STATUS" -ne 0 ]]; then
  echo "Error: could not check $BACKUP_FILE (node/better-sqlite3 failed)."
  echo "Refusing to replace $DB_PATH with a file that could not be checked."
  exit 1
fi

# --- Refuse while anything holds the database (no --force: this one has no override) ---
# Who has crow.db / -wal / -shm open decides, not which port answers: a second
# gateway started from another CROW_HOME, a pi-bots bridge or an sqlite3 shell
# holds the file without answering on our port. The node helper scans
# /proc/<pid>/fd (or lsof) and also probes the gateway port; when it cannot tell
# who holds the file it says so and falls back to the probe.
#   exit 0 = clear to restore (possibly with a warning on stdout)
#   exit 3 = refused, the reason is on stdout
#   other  = the check itself could not run
set +e
HOLD_CHECK="$("$NODE_BIN" "$RESTORE_HELPER" precheck "$DB_PATH" 2>&1)"
HOLD_STATUS=$?
set -e
if [[ -n "$HOLD_CHECK" ]]; then
  echo "$HOLD_CHECK"
fi
if [[ "$HOLD_STATUS" -eq 3 ]]; then
  exit 1
fi
if [[ "$HOLD_STATUS" -ne 0 ]]; then
  echo "Error: could not check whether anything holds $DB_PATH (node/better-sqlite3 failed)."
  echo "Refusing to replace $DB_PATH without that check."
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
  # A safety copy that cannot be made or does not verify stops the restore:
  # nothing may replace a database that could not be saved first.
  if ! "$NODE_BIN" "$RESTORE_HELPER" safety-copy "$DB_PATH" "$PRE_RESTORE"; then
    echo ""
    echo "Error: the pre-restore copy failed, so $DB_PATH has NOT been replaced."
    exit 1
  fi
fi

# --- Restore ---
# Every write happens in restore-db.mjs: a temp copy beside the database (or a
# .sql replay into one), verified there, then renamed into place. The old -wal
# and -shm are removed only after the temp file checked out.

echo "Restoring..."
if ! "$NODE_BIN" "$RESTORE_HELPER" apply "$BACKUP_FILE" "$DB_PATH"; then
  echo ""
  echo "Error: the restore failed, so $DB_PATH has NOT been replaced."
  if [[ -n "$PRE_RESTORE" ]]; then
    echo "The database is as it was; the pre-restore copy is at $PRE_RESTORE."
  fi
  exit 1
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
# The blob store is NOT part of the database: rows reference blobs by sha256 key.
# <backup dir>/artifacts is the host-default instance's copy; an instance with
# its own CROW_HOME has its own <backup dir>/artifacts-<stem>.
for artifacts_dir in "$BACKUP_DIR/artifacts" "$BACKUP_DIR"/artifacts-*; do
  if [[ -d "$artifacts_dir" ]]; then
    echo "Artifacts blobs for a full recovery: $artifacts_dir"
    echo "  (copy them back with: rsync -a --delete \"$artifacts_dir/\" \"$(dirname "$DB_PATH")/artifacts/\")"
  fi
done
echo "Start the gateway again when you are ready: systemctl --user start crow-gateway"