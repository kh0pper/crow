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
# set), one that did not is exit 1. Gitea refuses to delete its last admin, so an account
# whose password could not be set (after one retry with a fresh token) stays: the script
# exits 1 and says how to set its password by hand.
#
# How: the account is made with Gitea's own admin CLI inside the container, which mints a
# throwaway random password (printed once, kept nowhere). A setup token is then minted
# separately with `generate-access-token --scopes all --raw`, and the real password is set
# through the API with a curl config on stdin, so neither the password nor the token is
# ever an argument. Setup tokens are deleted afterwards (they exist only to set the
# password, and a scoped-all admin token left behind would be a second way in); an EXIT
# trap tries again on every other path and names any token it could not remove.
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
  code="$(printf 'max-time = 10\nuser = "%s"\n' "$ADMIN_USER:$ESC_PW" \
    | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - http://localhost:3000/api/v1/user 2>/dev/null || true)"
  if [ "$code" = "200" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}

# ── setup tokens, removed on every path after they exist ───────────────────────────
# A setup token exists only to set the password through the API. Gitea's token routes need
# the account's own password (basic auth), so a token can be removed only once that password
# is set; the EXIT trap tries every token this run minted, and names any it could not remove.
# A token is never printed; only its name is ever mentioned.
MINTED=""
delete_tokens() {
  [ -n "$MINTED" ] || return 0
  local name status left=""
  for name in $MINTED; do
    status="$(printf 'max-time = 10\nuser = "%s"\nrequest = "DELETE"\n' "$ADMIN_USER:$ESC_PW" \
      | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - "http://localhost:3000/api/v1/users/$ADMIN_USER/tokens/$name" 2>/dev/null || true)"
    [ "$status" = "204" ] || left="$left $name"
  done
  MINTED=""
  if [ -n "$left" ]; then
    say "Note: remove the temporary setup token(s)$left from Gitea under Settings > Applications (signed in as $ADMIN_USER)."
  fi
  return 0
}
trap delete_tokens EXIT

# Mint a scoped token (--raw prints only the token, never an argument) and set the real
# password with it through the API (token and password both on stdin, in a curl config).
# The body is JSON and then a quoted config value: the password is escaped for JSON, the
# whole text again for curl's config. Returns 0 only on HTTP 200.
set_password_with() {
  local name="$1" raw tok body_json body status
  raw="$(docker exec -u git "$CONTAINER" "$CLI" admin user generate-access-token \
    --username "$ADMIN_USER" --token-name "$name" --scopes all --raw </dev/null 2>/dev/null || true)"
  tok="$(printf '%s\n' "$raw" | grep -E '[^[:space:]]' | tail -n 1 | tr -d '[:space:]' || true)"
  raw=""
  case "$tok" in "" | *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#tok}" -ge 20 ] || return 1
  MINTED="$MINTED $name"
  body_json="{\"login_name\":\"$ADMIN_USER\",\"source_id\":0,\"password\":\"$(esc "$PW")\",\"must_change_password\":false}"
  body="$(esc "$body_json")"
  status="$(printf 'max-time = 10\nheader = "Authorization: token %s"\nheader = "Content-Type: application/json"\nrequest = "PATCH"\ndata = "%s"\n' "$tok" "$body" \
    | docker exec -i "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -K - "http://localhost:3000/api/v1/admin/users/$ADMIN_USER" 2>/dev/null || true)"
  tok=""
  [ "$status" = "200" ]
}

state="$(detect)"
case "$state" in
  FRESH) ;;
  EXISTS) die "Gitea already has an admin; left alone." 3 ;;
  *) die "Gitea's admin user list could not be read; nothing was changed." 4 ;;
esac

# ── create it ──────────────────────────────────────────────────────────────────────
# No password and no token on the command line: the CLI mints a random password itself
# (printed once, captured here and dropped).
out="$(docker exec -u git "$CONTAINER" "$CLI" admin user create --admin \
  --username "$ADMIN_USER" \
  --email "$ADMIN_USER@localhost.localdomain" \
  --random-password \
  --must-change-password=false </dev/null 2>/dev/null)" || out=""
out=""
again="$(detect)"
case "$again" in
  EXISTS) ;;
  FRESH) die "Gitea did not create the account; nothing was changed." ;;
  *) die "Gitea did not report whether it created the account, and its user list could not be read afterwards; look at Gitea's own user list before trying again." ;;
esac

# ── set the real password ──────────────────────────────────────────────────────────
# A PATCH that did not answer 200 may still have written the password: one login decides.
# Otherwise one more try with a fresh token. Gitea refuses to delete its last admin, so
# there is no rolling back: the only honest end is to say what is left and how to fix it.
if ! set_password_with crow-setup && [ "$(prove)" != "LOGIN-OK" ]; then
  if ! set_password_with crow-setup-2 && [ "$(prove)" != "LOGIN-OK" ]; then
    die "Gitea created the admin account '$ADMIN_USER', but Crow could not set its password (it has a random one nobody kept). Set one with '$CLI admin user change-password --username $ADMIN_USER' inside the container, then save that login on the Extensions card." 1
  fi
fi
delete_tokens
say "Gitea's admin account '$ADMIN_USER' is in place."

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
  die "Gitea accepted the new password, but logging in with it did not succeed; open Gitea's own login page and set its admin password there." 5
fi

say "Gitea's admin login for '$ADMIN_USER' now uses the password Crow generated."