#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Jellyfin's first start runs a setup wizard, and whoever finishes it becomes its
# administrator. That wizard answers on 127.0.0.1:8096 inside the container, so an
# install left alone is claimable by anything else on the machine. This script finishes
# the wizard itself, with the password Crow generated, before the operator's first visit.
#
# Every request is made INSIDE the container, with the curl its image ships, and the
# request config travels on stdin (`curl -K -`): the admin username and the password are
# never an argument, an environment value or output.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
# Exit 0 = the admin now has exactly that password, 3 = this install has an admin that is not
# provably Crow's and nothing of Crow's was saved, 4 = not running / not answering /
# unreadable, 5 = Jellyfin itself confirmed Crow's change but logging in with it did not
# succeed, anything else = failed. A wizard step that answers unclearly is settled by asking
# Jellyfin's own state again: a finished wizard means the password is proved (0, or 5 when
# Jellyfin wrote it and will not log in with it), an unfinished one means nothing was changed
# (1).
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-jellyfin}"
BASE_URL="http://127.0.0.1:8096"
# Crow creates `admin`; an empty value is refused below rather than silently replaced,
# because an empty one means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Jellyfin was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Jellyfin was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Jellyfin was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Jellyfin container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Jellyfin is not running; nothing was changed." 4

# Escaping for a curl config value (curl reads its config from stdin with `-K -`): a
# double-quoted value there understands exactly two escapes, `\\` and `\"`. It is used for
# the JSON body (where it is also the JSON string escape) and for the config line itself.
esc() { local s="${1//\\/\\\\}"; printf '%s' "${s//\"/\\\"}"; }

# ── one HTTP call inside the container, its config on stdin ────────────────────────
# Prints the body and then one final line with the HTTP status code (that is what
# `-w '\n%{http_code}'` appends). Nothing at all means the request did not happen.
# Following a redirect belongs to a READ only: a POST answered with one has to show up as
# that answer instead of being replayed to wherever the redirect points.
http_get() { printf '%s' "$1" | docker exec -i "$CONTAINER" curl -sS -L -K - -w '\n%{http_code}' 2>/dev/null || true; }
http_post() { printf '%s' "$1" | docker exec -i "$CONTAINER" curl -sS -K - -w '\n%{http_code}' 2>/dev/null || true; }
code_of() { printf '%s' "${1##*$'\n'}"; }
body_of() { printf '%s' "${1%$'\n'*}"; }

cfg_get() { printf 'url = "%s"\nmax-time = 10\n' "$1"; }
cfg_post() {
  printf 'url = "%s"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$1" "$(esc "$2")"
}

# One boolean field of a JSON document: `true` / `false` / nothing readable. Whitespace
# is stripped first, so the match does not depend on how the app formats its JSON.
json_flag() {
  printf '%s' "$1" | tr -d '[:space:]' | grep -o "\"$2\":\(true\|false\)" | tail -n 1 | sed 's/^.*://' || true
}

# FRESH (the wizard has not been finished) / DONE / UNKNOWN / LOADING / OFFLINE. Only a
# POSITIVE un-finished signal may lead to a change; everything else is reported as unreadable.
# 503 is Jellyfin saying its server is still loading: that is a first start in progress, not
# an answer, and it arrives for several seconds — sometimes after a few 200s.
wizard_state() {
  local resp code body flag
  resp="$(http_get "$(cfg_get "$BASE_URL/System/Info/Public")")"
  code="$(code_of "$resp")"
  body="$(body_of "$resp")"
  if [ -z "$resp" ] || [ -z "$code" ] || [ "$code" = "000" ]; then printf '%s' "OFFLINE"; return 0; fi
  if [ "$code" = "503" ]; then printf '%s' "LOADING"; return 0; fi
  if [ "$code" != "200" ]; then printf '%s' "UNKNOWN"; return 0; fi
  flag="$(json_flag "$body" StartupWizardCompleted)"
  # While it starts, Jellyfin first answers from a small start-up server that spells the
  # key `startupWizardCompleted`; only the real server's `StartupWizardCompleted` counts.
  # The start-up spelling is "still loading", never an answer.
  if [ -z "$flag" ] && [ -n "$(json_flag "$body" startupWizardCompleted)" ]; then printf '%s' "LOADING"; return 0; fi
  case "$flag" in
    false) printf '%s' "FRESH" ;;
    true) printf '%s' "DONE" ;;
    *) printf '%s' "UNKNOWN" ;;
  esac
}

# ── read the wizard's state, and mean it ───────────────────────────────────────────
# LOADING and silence mean "still starting", so both only restart the wait. With CONFIRM=1 a
# readable answer also has to arrive twice in a row before anything is done with it. A state
# that has not settled by DEADLINE (a $SECONDS value) reads as UNKNOWN, and silence as
# OFFLINE, so neither is ever acted on.
state_until() {
  local deadline="$1" confirm="$2" state="" seen="" answer="" settled=""
  while [ "$SECONDS" -lt "$deadline" ] && [ -z "$settled" ]; do
    state="$(wizard_state)"
    case "$state" in
      OFFLINE | LOADING) seen="" ;;
      UNKNOWN) answer="UNKNOWN"; settled=1 ;;
      *)
        if [ "$confirm" != "1" ] || [ "$state" = "$seen" ]; then
          answer="$state"; settled=1
        else
          seen="$state"
        fi ;;
    esac
    [ -n "$settled" ] || sleep 2
  done
  if [ -n "$settled" ]; then printf '%s' "$answer"; return 0; fi
  case "$state" in
    FRESH | DONE | UNKNOWN) printf '%s' "UNKNOWN" ;;
    *) printf '%s' "OFFLINE" ;;
  esac
}

# ── wait for the app (a first start prepares its own configuration first) ──────────
# Bounded twice: a $SECONDS budget well inside the manifest's 240 s, and max-time 10 in
# the probe's own config, so a single stuck request cannot outlive the wait.
wait_deadline=$((SECONDS + 60))
state="$(state_until "$wait_deadline" 1)"
case "$state" in
  FRESH) ;;
  DONE) die "Jellyfin's setup wizard is already finished, so this install already has its own admin; left alone, and nothing was changed." 3 ;;
  OFFLINE | "") die "Jellyfin did not answer on its web port; nothing was changed." 4 ;;
  *) die "Jellyfin's setup state could not be read; nothing was changed." 4 ;;
esac

# ── finish the wizard: configuration, the admin user, remote access, complete ───────
# The first step only prepares the server, so a refusal there means nothing was set.
resp="$(http_post "$(cfg_post "$BASE_URL/Startup/Configuration" '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}')")"
[ "$(code_of "$resp")" = "204" ] || die "Jellyfin did not accept the setup wizard's first step, so nothing was changed." 1

# Jellyfin's single default user is created by READING this endpoint: on a fresh install the
# POST below answers 404 until that GET has run once. Its body holds nothing Crow needs.
http_get "$(cfg_get "$BASE_URL/Startup/User")" >/dev/null

# The user step renames that default user and sets its password. From here on the account may
# exist even when an answer is unclear, so an unclear answer is settled by reading the
# wizard's own state instead of the status code. `confirmed` records the one thing that lets
# Crow keep the password after a login that does not work: Jellyfin itself reporting that it
# wrote the account (204 on the user step).
user_body="{\"Name\":\"$ADMIN_USER\",\"Password\":\"$(esc "$PW")\"}"
confirmed=""
unclear=""
resp="$(http_post "$(cfg_post "$BASE_URL/Startup/User" "$user_body")")"
if [ "$(code_of "$resp")" != "204" ]; then
  unclear=1
else
  confirmed=1
  resp="$(http_post "$(cfg_post "$BASE_URL/Startup/RemoteAccess" '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}')")"
  if [ "$(code_of "$resp")" != "204" ]; then
    unclear=1
  else
    resp="$(http_post "$(cfg_post "$BASE_URL/Startup/Complete" "")")"
    if [ "$(code_of "$resp")" != "204" ]; then
      # Completing the wizard is idempotent: one retry, then the wizard's own state decides.
      resp="$(http_post "$(cfg_post "$BASE_URL/Startup/Complete" "")")"
      [ "$(code_of "$resp")" = "204" ] || unclear=1
    fi
  fi
fi
if [ -n "$unclear" ]; then
  recheck_deadline=$((SECONDS + 15))
  again="$(state_until "$recheck_deadline" 0)"
  case "$again" in
    # The wizard did finish after all: go on and prove the password with a real login.
    DONE) ;;
    FRESH)
      if [ -n "$confirmed" ]; then
        die "Crow set the admin, but Jellyfin's setup wizard is still open; press Set it up for me again." 1
      fi
      die "Jellyfin did not finish its setup wizard, so nothing was changed; check the app's own setup page." 1 ;;
    *)
      if [ -n "$confirmed" ]; then
        die "Crow set the admin, but Jellyfin did not report whether its setup wizard finished; press Set it up for me again." 1
      fi
      die "Jellyfin did not report whether its setup wizard finished; check the app's own admin login before trying again." 1 ;;
  esac
fi
# Only Jellyfin's own 204 makes that account Crow's; a wizard that finished on its own is
# proved below, so it is not claimed here.
if [ -n "$confirmed" ]; then say "Jellyfin's admin account '$ADMIN_USER' is in place."; fi

# ── prove the new login works ───────────────────────────────────────────────────────
# Jellyfin's own client header is what its login endpoint expects; without it the answer
# is not a login at all.
MEDIA_BROWSER='MediaBrowser Client="crow", Device="installer", DeviceId="crow-install", Version="1"'
login_body="{\"Username\":\"$ADMIN_USER\",\"Pw\":\"$(esc "$PW")\"}"
cfg_login() {
  printf 'url = "%s"\nmax-time = 10\nrequest = "POST"\nheader = "Content-Type: application/json"\nheader = "Authorization: %s"\ndata = "%s"\n' \
    "$BASE_URL/Users/AuthenticateByName" "$(esc "$MEDIA_BROWSER")" "$(esc "$login_body")"
}
prove() {
  local answer
  answer="$(http_post "$(cfg_login)")"
  if [ "$(code_of "$answer")" = "200" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}
attempt=1
proof=""
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
  # Jellyfin itself confirmed the change, so the new password IS its password: Crow keeps it
  # and says it could not log in with it (exit 5). Without that confirmation a finished
  # wizard says nothing about whose account it is, so the password is not saved (exit 3).
  if [ -n "$confirmed" ]; then
    die "Jellyfin accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
  fi
  die "Jellyfin's setup wizard is already finished, but logging in with Crow's password did not succeed, so that admin is not Crow's; left alone, and nothing of Crow's was saved." 3
fi

say "Jellyfin's admin login for '$ADMIN_USER' now uses the password Crow generated."