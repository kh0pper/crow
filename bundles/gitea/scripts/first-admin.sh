#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Gitea's own installer page answers on 127.0.0.1 and, until somebody uses it, lets
# whoever or whatever reaches it first claim the instance. This bundle's compose file
# now sets GITEA__security__INSTALL_LOCK=true, so that page no longer runs the installer;
# this script creates the admin account itself, with the password Crow generated, before
# the operator's first visit.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and is
# passed on only through a pipe — never in an argument or the environment, and this script
# prints no secret. Exit 0 = the admin now has that password, 3 = Gitea already has an
# admin of its own (left alone), 4 = not running / not answering, 5 = Gitea took the new
# password but the login could not be proved, anything else = failed. A create step that
# answers unclearly is re-checked against Gitea's own user list: an account that appeared
# is kept and proved (exit 0, or the honest exit 1 below when its password could not be
# set), one that did not is exit 1.
#
# How: the account is made with Gitea's own admin CLI inside the container, which mints a
# throwaway random password (printed once, kept nowhere) and a setup token. The real
# password is then set through the API with a curl config on stdin, so neither the
# password nor the token is ever an argument. The setup token is deleted afterwards — it
# exists only to set the password, and a scoped-all admin token left behind would be a
# second way in.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-gitea}"
CLI="gitea"
# Gitea already uses `admin` as a reserved word in places, and Crow uses one name for
# every app it sets up. An empty value is refused below rather than silently replaced,
# because an empty one means the declaration is broken — only an UNSET one takes the
# default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-crow-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Gitea was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Gitea was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Gitea was not touched."

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`. A value
# written through this function can hold anything, which is why the password, the token and
# the JSON body never have to become command arguments.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }
ESC_PW="$(esc "$PW")"
# The username is validated to `[A-Za-z0-9._-]` above, so it needs no escaping at all.

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Gitea container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Gitea is not running; nothing was changed." 4

# ── wait for the app (a first start prepares its database first) ────────────────────
up=""
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" curl -fsS -o /dev/null http://localhost:3000/api/healthz </dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "Gitea did not answer on its health endpoint; nothing was changed." 4

# ── Gitea's own admin user list: FRESH (header only), EXISTS, or UNREADABLE ─────────
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
  code="$(printf 'user = "%s"\n' "$ADMIN_USER:$ESC_PW" \
    | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - http://localhost:3000/api/v1/user 2>/dev/null || true)"
  if [ "$code" = "200" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}

state="$(detect)"
case "$state" in
  FRESH) ;;
  EXISTS) die "Gitea already has an admin; left alone." 3 ;;
  *) die "Gitea's admin user list could not be read; nothing was changed." 4 ;;
esac

# ── create it ──────────────────────────────────────────────────────────────────────
# No password and no token on the command line: the CLI mints both itself. Its output is
# captured, never echoed — the random password it prints is a throwaway.
out="$(docker exec -u git "$CONTAINER" "$CLI" admin user create --admin \
  --username "$ADMIN_USER" \
  --email "$ADMIN_USER@localhost.localdomain" \
  --random-password \
  --must-change-password=false \
  --access-token \
  --access-token-name crow-setup </dev/null 2>/dev/null)" || out=""
TOKEN="$(printf '%s\n' "$out" | grep -i 'token' | grep -Eio '[0-9a-f]{40}' | tail -n 1 || true)"
out=""

if [ -z "$TOKEN" ]; then
  # The create did not hand back a usable token: the account may or may not exist, and
  # either way its password cannot be set through the API. Ask Gitea itself.
  again="$(detect)"
  case "$again" in
    EXISTS) ;;
    FRESH) die "Gitea did not create the account; nothing was changed." ;;
    *) die "Gitea did not report whether it created the account, and its user list could not be read afterwards; look at Gitea's own user list before trying again." ;;
  esac
  # The account exists, so its password is the random one Gitea printed once and nothing
  # kept. Try the real password anyway (a previous run may have set it), and be honest.
  if [ "$(prove)" != "LOGIN-OK" ]; then
    die "Gitea created the account '$ADMIN_USER', but Crow could not set its password — it was created with a random password that Gitea printed once and nothing kept. Reset it with '$CLI admin user change-password' or delete the account $ADMIN_USER, then try again." 1
  fi
else
  # ── set the real password (token and password both on stdin) ─────────────────────
  # The body is JSON and then a quoted config value: the password is escaped for JSON, the
  # whole text again for curl's config — otherwise its first `"` would end the value and the
  # API would receive a truncated body.
  body_json="{\"login_name\":\"$ADMIN_USER\",\"source_id\":0,\"password\":\"$(esc "$PW")\",\"must_change_password\":false}"
  body="$(esc "$body_json")"
  patch_status="$(printf 'header = "Authorization: token %s"\nheader = "Content-Type: application/json"\nrequest = "PATCH"\ndata = "%s"\n' "$TOKEN" "$body" \
    | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - "http://localhost:3000/api/v1/admin/users/$ADMIN_USER" 2>/dev/null || true)"
  if [ "$patch_status" != "200" ]; then
    # The PATCH may have written the password and failed to answer. One login attempt with
    # the real password decides it; if that fails, say plainly what happened.
    if [ "$(prove)" != "LOGIN-OK" ]; then
      die "Gitea created the account '$ADMIN_USER', but Crow could not set its password — it was created with a random password that Gitea printed once and nothing kept. Reset it with '$CLI admin user change-password' or delete the account $ADMIN_USER, then try again." 1
    fi
  fi
  # ── remove the setup token ───────────────────────────────────────────────────────
  # It only existed to set the password. A failure here is worth a line in the log, never a
  # failed setup: the login itself already works.
  del_status="$(printf 'user = "%s"\nrequest = "DELETE"\n' "$ADMIN_USER:$ESC_PW" \
    | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - "http://localhost:3000/api/v1/users/$ADMIN_USER/tokens/crow-setup" 2>/dev/null || true)"
  [ "$del_status" = "204" ] || say "Note: the temporary setup token could not be removed from Gitea (HTTP $del_status); remove 'crow-setup' under Settings > Applications by hand."
fi
say "Gitea's admin account '$ADMIN_USER' is in place."

# ── prove the new login works ───────────────────────────────────────────────────────
attempt=1
proof=""
while :; do
  proof="$(prove)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # The app holds this password, so Crow keeps it and says it could not prove the login
  # (exit 5).
  die "Gitea accepted the new password, but logging in with it did not succeed; open Gitea's own login page and set its admin password there." 5
fi

say "Gitea's admin login for '$ADMIN_USER' now uses the password Crow generated."