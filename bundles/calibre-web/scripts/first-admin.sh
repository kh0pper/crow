#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Calibre-Web creates its own `/config/app.db` on first start and seeds it with the
# account `admin` / `admin123` — a login printed in its own docs, on a loopback port, so
# anything else on the machine can sign in to a fresh install with it. This script
# replaces that password with the one Crow generated, and only while `admin123` still
# opens the account.
#
# How: Calibre-Web keeps its users in app.db with a werkzeug scrypt hash, and the image
# ships Python with those libraries, so each step is a small python snippet run inside the
# container as the app's own user (uid 1000, which owns the database). The snippet prints
# ONE status word — never a hash and never a password — and the password reaches it on
# stdin. The library at /books is the operator's own and is never touched here.
# The interpreter is the image's own `python3` (docker exec applies the image's PATH); it
# has to be the one whose site-packages hold flask and werkzeug, which a first live run on
# the pinned image is what confirms — a wrong one answers UNKNOWN, and the run ends at 4
# having changed nothing.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin. Exit
# 0 = the admin now has exactly that password, 3 = the shipped default no longer works
# (this install already has its own admin password; left alone), 4 = not running / not
# answering / the database could not be read, 5 = Calibre-Web took the new password but
# logging in with it did not succeed, anything else = failed.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-calibre-web}"
# The image serves the app on port 8083 inside its own container.
BASE_URL="http://localhost:8083"
# The account its image seeds is row 1 of the user table: name `admin` in /config/app.db,
# password `admin123`. Those two values are the ones the snippets below name.
# An empty value is refused below rather than silently replaced, because an empty one
# means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._@-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Calibre-Web was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Calibre-Web was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Calibre-Web was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Calibre-Web container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Calibre-Web is not running; nothing was changed." 4

# ── wait for the app (a first start creates and fills app.db first) ─────────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 120 s, and --max-time 5 on the
# probe itself, so a single stuck curl cannot outlive the wait.
up=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  if docker exec "$CONTAINER" curl -fsS --max-time 5 -o /dev/null "$BASE_URL/" </dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "Calibre-Web did not answer on its web port; nothing was changed." 4

# ── the snippets (one status word each, no secret in any of them) ──────────────────
# DETECT is read-only: it opens app.db read-only and asks werkzeug whether the stored hash
# is still the shipped password. The username arrives on the first stdin line.
DETECT='import sys
try:
    import sqlite3
    from werkzeug.security import check_password_hash
    user = sys.stdin.readline().rstrip("\n")
    db = sqlite3.connect("file:/config/app.db?mode=ro", uri=True)
    row = db.execute("SELECT password FROM user WHERE id = 1 AND name = ?", (user,)).fetchone()
    stored = row[0] if row else ""
    if not stored:
        print("UNKNOWN")
    elif check_password_hash(stored, "admin123"):
        print("DEFAULT")
    else:
        print("CHANGED")
except Exception:
    print("UNKNOWN")'
# SET rewrites exactly that one row, and says UPDATED only when exactly one row changed.
SET='import sys
try:
    import sqlite3
    from werkzeug.security import generate_password_hash
    user = sys.stdin.readline().rstrip("\n")
    password = sys.stdin.readline().rstrip("\n")
    db = sqlite3.connect("/config/app.db", timeout=10)
    cur = db.execute("UPDATE user SET password = ? WHERE id = 1 AND name = ?", (generate_password_hash(password), user))
    db.commit()
    print("UPDATED" if cur.rowcount == 1 else "UNKNOWN")
except Exception:
    print("UNKNOWN")'
# PROVE reads the stored hash back and checks both halves: the new password opens it and the
# shipped one no longer does.
PROVE='import sys
try:
    import sqlite3
    from werkzeug.security import check_password_hash
    user = sys.stdin.readline().rstrip("\n")
    password = sys.stdin.readline().rstrip("\n")
    db = sqlite3.connect("file:/config/app.db?mode=ro", uri=True)
    row = db.execute("SELECT password FROM user WHERE id = 1 AND name = ?", (user,)).fetchone()
    stored = row[0] if row else ""
    if stored and check_password_hash(stored, password) and not check_password_hash(stored, "admin123"):
        print("LOGIN-OK")
    else:
        print("LOGIN-FAIL")
except Exception:
    print("PROOF-UNKNOWN")'

# ── is the shipped default password still working? ────────────────────────────────
state="$(printf '%s\n' "$ADMIN_USER" | docker exec -i -u 1000 "$CONTAINER" python3 -c "$DETECT" 2>/dev/null | tail -n 1 || true)"
case "$state" in
  DEFAULT) ;;
  CHANGED) die "Calibre-Web's default password no longer works, so this install already has its own admin password; left alone." 3 ;;
  *) die "Calibre-Web's user table could not be read; nothing was changed." 4 ;;
esac

# ── set the new password (on the snippet's stdin, never as an argument) ────────────
updated="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i -u 1000 "$CONTAINER" python3 -c "$SET" 2>/dev/null | tail -n 1 || true)"
[ "$updated" = "UPDATED" ] || die "Calibre-Web did not confirm the new password; the default login is unchanged." 1
say "Calibre-Web confirmed the new password for the account '$ADMIN_USER'."

# ── prove the new login works ─────────────────────────────────────────────────────
# Three tries, and never more than 30 s of them: each check opens the database read-only,
# this budget bounds the whole loop.
attempt=1
proof=""
proof_deadline=$((SECONDS + 30))
while :; do
  proof="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i -u 1000 "$CONTAINER" python3 -c "$PROVE" 2>/dev/null | tail -n 1 || true)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # The UPDATE reported exactly one row changed, so the account holds this password: Crow
  # keeps it and says it could not log in with it (exit 5).
  die "Calibre-Web accepted the new password, but logging in with it did not succeed; open Calibre-Web's own UI and set its admin password there." 5
fi

say "Calibre-Web's admin login for '$ADMIN_USER' now uses the password Crow generated."