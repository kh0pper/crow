#!/usr/bin/env bash
# Unpack + decrypt a Crow Workspace backup into a private directory (mode 700).
#   bash ops/restore.sh <crow-workspace-*.tar> <target-dir> [passphrase-file]
# Produces db.sql, nextcloud-files.tar (all of /var/www/html), bundle.env.
set -euo pipefail
umask 077
ARCHIVE="${1:?usage: restore.sh <archive.tar> <target-dir> [passphrase-file]}"
TARGET="${2:?usage: restore.sh <archive.tar> <target-dir> [passphrase-file]}"
PASSFILE="${3:-${CROW_HOME:-$HOME/.crow}/workspace/backup-passphrase}"
GPG="${WORKSPACE_GPG:-gpg}"
die() { printf '[workspace-restore] ERROR: %s\n' "$*" >&2; exit 1; }
[ -f "$ARCHIVE" ] || die "no archive at $ARCHIVE"
[ -f "$PASSFILE" ] || die "no passphrase file at $PASSFILE"
mkdir -p "$TARGET"; chmod 700 "$TARGET"
tar -C "$TARGET" -xf "$ARCHIVE" db.sql.gpg files.tar.gpg bundle.env.gpg
dec() { "$GPG" --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --decrypt -o "$TARGET/$2" "$TARGET/$1" && rm -f "$TARGET/$1"; }
dec db.sql.gpg db.sql
dec files.tar.gpg nextcloud-files.tar
dec bundle.env.gpg bundle.env
for f in db.sql nextcloud-files.tar bundle.env; do [ -s "$TARGET/$f" ] || die "archive is missing $f"; chmod 600 "$TARGET/$f"; done
echo "Unpacked to $TARGET: db.sql, nextcloud-files.tar, bundle.env (plaintext: delete when done)"
