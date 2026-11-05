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
# Identity (security audit N1c-10, the operator's ruling 2026-11-05): this script
# also copies <data dir>/identity.json into the backup directory as
# `<stem>-identity-<date>.json` — 0600, owner sidecar, pruned with the run it
# belongs to. That copy stays on THIS machine: it is for restoring the same
# hardware (`npm run restore -- <backup> --with-identity`).
#
#   - The S3 step and the git step have an EXPLICIT allow-list — this run's .db
#     and .sql, nothing else — and a guard that refuses exactly what must not
#     travel: this instance's identity copy name
#     (`<stem>-identity-<date>.json`), any `identity.json`, and anything under
#     <CROW_HOME>/secrets. The guard is uploadRefusalReason() in
#     servers/shared/backup-naming.js (asked through `backup-db.mjs
#     --may-leave`), so a database copy whose stem merely contains the word
#     "identity" is not mistaken for identity data. A file added to the backup
#     dir later cannot start travelling by accident.
#   - <CROW_HOME>/secrets is NEVER copied, by this script or by any backup:
#     those entries move between machines with the Keychain's own passphrase
#     Export.
#   - A copy of the identity the owner can take anywhere is the
#     passphrase-protected identity backup (Settings → Help & setup, or
#     `npm run identity:export`). Crow asks for it once, on boot.
#
# Artifacts: the Crow Artifacts blob store (<dataDir>/artifacts) is copied to
# <backup dir>/artifacts — or, for an instance with its own CROW_HOME (a
# tagged instance), <backup dir>/artifacts-<stem>. Each instance rsyncs
# `--delete` into its OWN subdirectory only, so two co-hosted instances never
# prune each other's blobs. A restore needs the database AND that subdirectory.
#
# Upgrading a tagged instance: before this split its blobs went into the shared
# `artifacts/`, and the host-default instance's next run (rsync --delete into
# `artifacts/`) drops them from there — so a tagged instance should run one
# backup right after upgrading, which writes its own `artifacts-<stem>/` copy.
#
# Mode bits: everything this script writes is 0600 in a 0700 directory. A
# directory this script CREATES is 0700; an existing directory is never clamped
# (it may be shared) — it is warned about once instead, and a chmod that fails
# (a filesystem without modes) never aborts a backup.

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

# --- This instance's names (stem, tag, artifacts subdirectory) ---
# <label>[-<tag>]-<date>.db for the copy; the artifacts store is `artifacts`
# for the host-default instance and `artifacts-<stem>` for a tagged one.
NAMING="$("$NODE_BIN" "$BACKUP_HELPER" --naming)"
BACKUP_STEM="$(printf '%s\n' "$NAMING" | sed -n 1p)"
INSTANCE_TAG="$(printf '%s\n' "$NAMING" | sed -n 2p)"
ARTIFACTS_NAME="$(printf '%s\n' "$NAMING" | sed -n 3p)"
if [[ -z "$BACKUP_STEM" || -z "$ARTIFACTS_NAME" ]]; then
  echo "Error: could not resolve this instance's backup names (node/backup-naming failed)."
  exit 1
fi

# Warn once (never chmod) about a directory group or others may read.
warn_if_shared() {
  local dir="$1" mode
  mode="$(stat -c %a -- "$dir" 2>/dev/null || true)"
  if [[ "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 8#077) != 0 )); then
    echo "  Warning: $dir is mode $mode (group- or world-accessible); the backups in it may be readable by others. chmod 700 it if only Crow uses it."
  fi
}

# Create a private directory when it is missing. An existing directory is never
# clamped: it may be shared with other software. Nothing here aborts the backup.
make_private_dir() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    warn_if_shared "$dir"
    return 0
  fi
  if ! mkdir -p -m 700 -- "$dir"; then
    echo "  Warning: could not create $dir."
    return 0
  fi
  chmod 700 -- "$dir" 2>/dev/null || echo "  Warning: could not set mode 0700 on $dir."
  return 0
}

echo "Crow Backup — $(date)"
echo "  Database: $DB_PATH"
echo "  Backup dir: $BACKUP_DIR"
echo "  Retention: $KEEP_DAYS days"
echo ""

REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/crow-backup-report.XXXXXX")"
trap 'rm -f "$REPORT_FILE"' EXIT

# --- Upload guards (N1c-10) ---
# Two independent refusals, on purpose: the allow-list below never offers an
# unseen file, and this guard catches one that reaches a step anyway. Identity
# data and the keychain key never leave this machine. What counts as "identity"
# is decided in ONE place (uploadRefusalReason in servers/shared/backup-naming.js):
# this instance's identity copy name, any identity.json, and anything under
# <CROW_HOME>/secrets — never "any name containing identity", so a database
# copy whose stem contains the word still uploads.
file_may_leave() {
  local f="$1" why
  if why="$("$NODE_BIN" "$BACKUP_HELPER" --may-leave "$f" 2>&1)"; then
    return 0
  fi
  echo "  Refusing to send $(basename -- "$f") anywhere: ${why:-it must not leave this machine}"
  return 1
}

# --- Step 1: the binary copy (and the SQL dump taken from it) ---

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] No files will be written or deleted."
  echo ""
  echo "Creating binary copy..."
  "$NODE_BIN" "$BACKUP_HELPER" --names --report "$REPORT_FILE" --db "$DB_PATH"
  # shellcheck disable=SC1090
  source "$REPORT_FILE"
  echo "  [dry-run] Would create: $DB_FILE"
  if [[ -n "${IDENTITY_FILE:-}" ]]; then
    echo "  [dry-run] Would create (this machine only, never uploaded): $IDENTITY_FILE"
  fi
  echo "Creating SQL dump from that copy..."
  echo "  [dry-run] Would create: $SQL_FILE"
else
  if [[ ! -d "$BACKUP_DIR" ]]; then
    mkdir -p -m 700 -- "$BACKUP_DIR" || {
      echo "Error: cannot create the backup directory $BACKUP_DIR"
      exit 1
    }
    chmod 700 -- "$BACKUP_DIR" 2>/dev/null || echo "  Warning: could not set mode 0700 on $BACKUP_DIR."
  else
    # Never clamp an existing directory — it may be shared.
    warn_if_shared "$BACKUP_DIR"
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
ARTIFACTS_COPY="$BACKUP_DIR/$ARTIFACTS_NAME"
if [[ -d "$ARTIFACTS_DIR" ]]; then
  echo "Copying artifacts store..."
  if [[ "$DRY_RUN" == false ]]; then
    make_private_dir "$ARTIFACTS_COPY"
    # --no-links: a symlink planted into the store is never followed or copied.
    # --chmod: the copy is ours, so force private dirs/files whatever the
    # source modes are.
    # --delete touches ONLY this instance's own copy (its own subdirectory), so
    # a co-hosted instance's blobs are never pruned from this run.
    rsync -a --no-links --delete --chmod=D700,F600 "$ARTIFACTS_DIR/" "$ARTIFACTS_COPY/"
    echo "  Artifacts: $ARTIFACTS_COPY ($(du -sh "$ARTIFACTS_COPY" | cut -f1))"
  else
    echo "  [dry-run] Would rsync $ARTIFACTS_DIR/ to $ARTIFACTS_COPY/"
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
      # EXPLICIT ALLOW-LIST (N1c-10): this run's .db, and its .sql when one was
      # written. Nothing else is ever offered to `mc` — in particular neither
      # <stem>-identity-<date>.json nor anything under <CROW_HOME>/secrets. The
      # names come from the run's own report file, and file_may_leave() refuses
      # an identity copy, an identity.json or a path in the secrets directory
      # even if one ever reached the list.
      S3_FILES=()
      S3_REFUSED=()
      for f in "$DB_FILE" "${SQL_FILE:-}"; do
        [[ -n "$f" && -f "$f" ]] || continue
        if file_may_leave "$f"; then
          S3_FILES+=("$f")
        else
          S3_REFUSED+=("$(basename -- "$f")")
        fi
      done
      mc alias set crow-backup "$S3_EP" "$S3_AK" "$S3_SK" --quiet 2>/dev/null || true
      mc mb --ignore-existing "crow-backup/$BUCKET" --quiet 2>/dev/null || true
      S3_UPLOADED=()
      for f in ${S3_FILES[@]+"${S3_FILES[@]}"}; do
        case "$f" in
          *.sql) where="sql/" ;;
          *)     where="db/" ;;
        esac
        if mc cp "$f" "crow-backup/$BUCKET/$where" --quiet; then
          S3_UPLOADED+=("$where$(basename -- "$f")")
        else
          echo "  Warning: could not upload $(basename -- "$f") to S3."
        fi
      done
      # Say what actually went, or that it refused — never a blanket "uploaded
      # this run's files" after a refusal.
      if [[ ${#S3_UPLOADED[@]} -gt 0 ]]; then
        echo "  Uploaded to S3: ${S3_UPLOADED[*]}"
      fi
      if [[ ${#S3_REFUSED[@]} -gt 0 ]]; then
        echo "  Refused to upload: ${S3_REFUSED[*]}"
      fi
      if [[ ${#S3_UPLOADED[@]} -eq 0 && ${#S3_REFUSED[@]} -eq 0 ]]; then
        echo "  Nothing to upload to S3."
      fi
    else
      echo "  [dry-run] Would upload $SQL_FILE and $DB_FILE to $BUCKET (never the identity copy)"
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

      # Per instance: the host-default instance keeps the historical names, a
      # tagged instance commits its own, so two co-hosted instances sharing a
      # backup repo never overwrite each other's dumps.
      if [[ -n "$INSTANCE_TAG" ]]; then
        GIT_LATEST="crow-latest-${BACKUP_STEM}.sql"
        GIT_DATED="crow-${BACKUP_STEM}-${DATE_ONLY}.sql"
      else
        GIT_LATEST="crow-latest.sql"
        GIT_DATED="crow-${DATE_ONLY}.sql"
      fi

      # EXPLICIT ALLOW-LIST (N1c-10): the only file that ever enters this repo
      # is this run's SQL dump, under the two names below (never the binary
      # .db, never <stem>-identity-<date>.json, never anything under
      # <CROW_HOME>/secrets). file_may_leave() refuses an identity copy, an
      # identity.json or a path in the secrets directory, and the staged-files
      # check before the commit refuses a commit that carries either one.
      if ! file_may_leave "$GIT_DIR/$GIT_LATEST" || ! file_may_leave "$GIT_DIR/$GIT_DATED"; then
        echo "  Git backup skipped: a staged name was refused."
      else
        cp "$SQL_FILE" "$GIT_DIR/$GIT_LATEST"
        cd "$GIT_DIR"
        git add "$GIT_LATEST"

        # Also keep dated snapshots (but only SQL — never binary .db)
        cp "$SQL_FILE" "$GIT_DIR/$GIT_DATED"
        git add "$GIT_DATED"

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

        # Nothing staged may carry identity data or an entry from the secrets
        # directory: refuse the whole commit (and unstage) rather than let one
        # through.
        STAGED_IDENTITY="$(git diff --cached --name-only | { grep -Ei '(^|/)[^/]*identity|(^|/)secrets(/|$)' || true; })"
        if [[ -n "$STAGED_IDENTITY" ]]; then
          git reset --quiet
          echo "  Refusing to commit: a staged file carries identity data or an entry from the secrets directory."
        elif git diff --cached --quiet; then
          echo "  No changes to commit."
        else
          git commit -m "Crow backup ${TIMESTAMP}" --quiet
          git push --quiet 2>/dev/null || echo "  Warning: git push failed. Commit saved locally."
          echo "  Committed and pushed SQL dump."
        fi
      fi
    else
      echo "  [dry-run] Would commit SQL dump to $GIT_DIR (never the identity copy)"
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
PRUNE_ARGS=(--prune --db "$DB_PATH")
if [[ "$DRY_RUN" == true ]]; then
  PRUNE_ARGS+=(--dry-run)
fi
"$NODE_BIN" "$BACKUP_HELPER" "${PRUNE_ARGS[@]}"

echo ""
echo "Backup complete."