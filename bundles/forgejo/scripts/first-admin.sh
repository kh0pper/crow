#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Forgejo's own installer page answers on 127.0.0.1 and, until somebody uses it, lets
# whoever or whatever reaches it first claim the instance. This bundle's compose file now
# sets FORGEJO__security__INSTALL_LOCK=true, so that page no longer runs the installer;
# this script creates the admin account itself, with the password Crow generated, before
# the operator's first visit.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through a pipe — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has that password, 3 = Forgejo already has an
# admin of its own (left alone), 4 = not running / not answering, 5 = Forgejo took the new
# password but the login could not be proved, anything else = failed. A create step that
# answers unclearly is re-checked against Forgejo's own user list: an account that appeared
# is kept and proved (exit 0, or the honest exit 1 below when its password could not be
# set), one that did not is exit 1. When the password cannot be set, the account this run
# created is deleted again — an admin whose password nobody holds would lock the operator
# out of the next run (exit 3) for good.
#
# How: the account is made with Forgejo's own admin CLI inside the container, which mints a
# throwaway random password (printed once, kept nowhere). Forgejo's `create --access-token`
# makes a token WITHOUT scopes, which the API then refuses with a 403, so the token is
# minted separately with `generate-access-token --scopes all`. The real password is then
# set through the API with a curl config on stdin, so neither the password nor the token is
# ever an argument. The setup token is deleted afterwards — it exists only to set the
# password, and a scoped-all admin token left behind would be a second way in — and an EXIT
# trap removes it on every other path too.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-forgejo}"
CLI="forgejo"
# Forgejo reserves the username `admin`, and Crow uses one name for every app it sets up.
# An empty value is refused below rather than silently replaced, because an empty one
# means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-crow-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Forgejo was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Forgejo was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Forgejo was not touched."

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`. A value
# written through this function can hold anything, which is why the password, the token and
# the JSON body never have to become command arguments.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }
ESC_PW="$(esc "$PW")"
# The username is validated to `[A-Za-z0-9._-]` above, so it needs no escaping at all.

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Forgejo container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Forgejo is not running; nothing was changed." 4

# ── wait for the app (a first start prepares its database first) ────────────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 240 s, and --max-time 5 on
# the probe itself, so a single stuck curl cannot outlive the wait.
up=""
wait_deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  if docker exec "$CONTAINER" curl -fsS --max-time 5 -o /dev/null http://localhost:3000/api/healthz </dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "Forgejo did not answer on its health endpoint; nothing was changed." 4

# ── Forgejo's own admin user list: FRESH (header only), EXISTS, or UNREADABLE ───────
# The CLI's own table is the authority: a header and no data rows means no admin yet. A
# non-zero exit (Forgejo answers 1 while it is not installed) or anything this cannot
# parse is UNREADABLE — never a change.
detect() {
  local out
  out="$(docker exec -u git "$CONTAINER" "$CLI" admin user list --admin </dev/null 2>/dev/null)" || { printf '%s' "UNREADABLE"; return 0; }
  printf '%s\n' "$out" | awk '
    /^[[:space:]]*$/ { next }
    first == 0 { first = 1; if (toupper($1) != "ID") bad = 1; next }
    { rows++ }
    END {
      if (bad || first == 0) print "UNREADABLE";
      else if (rows > 0) print "EXISTS";
      else print "FRESH";
    }
  '
}

# ── prove a login with the real password (a curl config on stdin) ───────────────────
prove() {
  local code
  code="$(printf 'max-time = 10\nuser = "%s"\n' "$ADMIN_USER:$ESC_PW" \
    | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - http://localhost:3000/api/v1/user 2>/dev/null || true)"
  if [ "$code" = "200" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}

# ── remove the account this run created, when its password could not be set ────────
# Only when Forgejo's own list shows EXACTLY ONE admin and it is $ADMIN_USER: anything else
# (another admin, no admin, an unreadable list) is not ours to delete. Deleting the user
# also removes the setup token it holds. Non-zero = nothing was deleted.
rollback() {
  local out name
  out="$(docker exec -u git "$CONTAINER" "$CLI" admin user list --admin </dev/null 2>/dev/null)" || return 1
  name="$(printf '%s\n' "$out" | awk '
    /^[[:space:]]*$/ { next }
    first == 0 { first = 1; if (toupper($1) != "ID") bad = 1; next }
    { rows++; uname = $2 }
    END {
      if (bad || first == 0 || rows != 1) exit 1;
      print uname;
    }
  ')" || return 1
  [ "$name" = "$ADMIN_USER" ] || return 1
  docker exec -u git "$CONTAINER" "$CLI" admin user delete --username "$ADMIN_USER" </dev/null >/dev/null 2>&1
}

# ── the setup token, removed on every path after it exists ─────────────────────────
# Installed as an EXIT trap, so a failed token mint, a failed PATCH, a failed proof or an
# early die cannot leave a scoped-all admin token behind. The token is never printed; only
# its HTTP status is ever mentioned. Deleting it twice is harmless: the first call clears
# $TOKEN.
TOKEN=""
ACCOUNT_REMOVED=""
delete_token() {
  [ -n "$TOKEN" ] || return 0
  local status
  status="$(printf 'max-time = 10\nuser = "%s"\nrequest = "DELETE"\n' "$ADMIN_USER:$ESC_PW" \
    | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - "http://localhost:3000/api/v1/users/$ADMIN_USER/tokens/crow-setup" 2>/dev/null || true)"
  TOKEN=""
  # A failure here is worth a line in the log, never a failed setup — and after the account
  # was deleted again there is no token left to point the operator at.
  if [ "$status" != "204" ] && [ -z "$ACCOUNT_REMOVED" ]; then
    say "Note: the temporary setup token could not be removed from Forgejo (HTTP $status); remove 'crow-setup' under Settings > Applications by hand."
  fi
  return 0
}
trap delete_token EXIT

# ── what to say when the real password could not be set ────────────────────────────
# The account is deleted again when it is a lone account this run created — otherwise it
# is left for the operator with the only honest way out.
fail_password() {
  if rollback; then
    ACCOUNT_REMOVED=1
    die "Crow could not set the new admin account's password, so it removed the account again; nothing was changed. Try again." 1
  fi
  die "Forgejo created the account '$ADMIN_USER', but Crow could not set its password — it was created with a random password that Forgejo printed once and nothing kept. Reset it with '$CLI admin user change-password' or delete the account $ADMIN_USER, then try again." 1
}

state="$(detect)"
case "$state" in
  FRESH) ;;
  EXISTS) die "Forgejo already has an admin; left alone." 3 ;;
  *) die "Forgejo's admin user list could not be read; nothing was changed." 4 ;;
esac

# ── create it ──────────────────────────────────────────────────────────────────────
# No password and no token on the command line: the CLI mints the password itself, and a
# token made here would carry no scopes. Its output is captured, never echoed.
out="$(docker exec -u git "$CONTAINER" "$CLI" admin user create --admin \
  --username "$ADMIN_USER" \
  --email "$ADMIN_USER@localhost.localdomain" \
  --random-password \
  --must-change-password=false </dev/null 2>/dev/null)" || out=""
out=""

# The scoped setup token, minted separately. --raw prints the token and nothing else.
raw="$(docker exec -u git "$CONTAINER" "$CLI" admin user generate-access-token \
  --username "$ADMIN_USER" \
  --token-name crow-setup \
  --scopes all \
  --raw </dev/null 2>/dev/null || true)"
TOKEN="$(printf '%s\n' "$raw" | grep -E '[^[:space:]]' | tail -n 1 | tr -d '[:space:]' || true)"
raw=""
case "$TOKEN" in
  "" | *[!A-Za-z0-9_-]*) TOKEN="" ;;
esac
[ "${#TOKEN}" -ge 20 ] || TOKEN=""

if [ -z "$TOKEN" ]; then
  # No usable token: the account may or may not exist, and either way its password cannot
  # be set through the API. Ask Forgejo itself.
  again="$(detect)"
  case "$again" in
    EXISTS) ;;
    FRESH) die "Forgejo did not create the account; nothing was changed." ;;
    *) die "Forgejo did not report whether it created the account, and its user list could not be read afterwards; look at Forgejo's own user list before trying again." ;;
  esac
  # The account exists, so its password is the random one Forgejo printed once and nothing
  # kept. Try the real password anyway (a previous run may have set it), and be honest.
  if [ "$(prove)" != "LOGIN-OK" ]; then
    fail_password
  fi
else
  # ── set the real password (token and password both on stdin) ─────────────────────
  # The body is JSON and then a quoted config value: the password is escaped for JSON, the
  # whole text again for curl's config — otherwise its first `"` would end the value and the
  # API would receive a truncated body.
  body_json="{\"login_name\":\"$ADMIN_USER\",\"source_id\":0,\"password\":\"$(esc "$PW")\",\"must_change_password\":false}"
  body="$(esc "$body_json")"
  patch_status="$(printf 'max-time = 10\nheader = "Authorization: token %s"\nheader = "Content-Type: application/json"\nrequest = "PATCH"\ndata = "%s"\n' "$TOKEN" "$body" \
    | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - "http://localhost:3000/api/v1/admin/users/$ADMIN_USER" 2>/dev/null || true)"
  if [ "$patch_status" != "200" ]; then
    # The PATCH may have written the password and failed to answer. One login attempt with
    # the real password decides it; if that fails, the account goes again.
    if [ "$(prove)" != "LOGIN-OK" ]; then
      fail_password
    fi
  fi
  # ── remove the setup token ───────────────────────────────────────────────────────
  # It only existed to set the password. The EXIT trap is the safety net; this call is the
  # ordinary path, and it clears $TOKEN so the trap has nothing left to do.
  delete_token
fi
say "Forgejo's admin account '$ADMIN_USER' is in place."

# ── prove the new login works ───────────────────────────────────────────────────────
attempt=1
proof=""
# Three tries, and never more than 40 s of them: each probe is bounded by max-time 10 in
# its curl config, this budget bounds the whole loop.
proof_deadline=$((SECONDS + 40))
while :; do
  proof="$(prove)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # The app holds this password, so Crow keeps it and says it could not prove the login
  # (exit 5).
  die "Forgejo accepted the new password, but logging in with it did not succeed; open Forgejo's own login page and set its admin password there." 5
fi

say "Forgejo's admin login for '$ADMIN_USER' now uses the password Crow generated."