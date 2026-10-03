#!/usr/bin/env bash
# Crow Workspace post-install bootstrap. Idempotent: every step checks the current
# state first, so it is safe to re-run at any time (also restore step 6):
#     bash ~/.crow/bundles/workspace/ops/bootstrap.sh
# Never prints a secret, never puts one in argv (host OR container): secrets are
# written by the `printf` builtin into the stdin of `docker compose exec -T`.
set -euo pipefail
umask 077

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ENV_FILE="$BUNDLE_DIR/.env"
PROJECT="${WORKSPACE_COMPOSE_PROJECT:-crow-workspace}"
TS="${WORKSPACE_TS:-tailscale}"
DOCKER="${WORKSPACE_DOCKER:-docker}"
WAIT_S="${WORKSPACE_WAIT_S:-600}"
SLEEP_S="${WORKSPACE_SLEEP_S:-5}"
NET="${PROJECT}_default"
BOT="crow-bot"
TOKEN_NAME="crow-workspace-tools"
GENERATED_KEYS="WORKSPACE_FIRSTRUN_ADMIN_PASSWORD WORKSPACE_DB_ROOT_PASSWORD WORKSPACE_DB_PASSWORD WORKSPACE_REDIS_PASSWORD WORKSPACE_ONLYOFFICE_JWT_SECRET"
RETAINED_DIR="$CROW_HOME/secrets/bundle-env"
RETAINED="$RETAINED_DIR/workspace.env"
HOST_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'

env_get() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
env_rewrite() {  # $1 = key to drop; $2 = optional "KEY=value" line to append. Atomic, 600.
  local tmp
  tmp="$(mktemp "$BUNDLE_DIR/.env.XXXXXX")"
  { grep -v "^$1=" "$ENV_FILE" || true; [ -n "${2:-}" ] && printf '%s\n' "$2"; } > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
}
env_set() { env_rewrite "$1" "$1=$2"; }
env_unset() { env_rewrite "$1"; }
wait_for() {
  local what="$1" waited=0; shift
  until "$@" >/dev/null 2>&1; do
    [ "$waited" -ge "$WAIT_S" ] && die "$what not ready after ${WAIT_S}s"
    sleep "$SLEEP_S"; waited=$((waited + SLEEP_S))
  done
  log "$what ready"
}
nc_installed() { [[ "$(occ status --output=json 2>/dev/null)" == *'"installed":true'* ]]; }
oo_connected() { occ onlyoffice:documentserver --check; }

[ -f "$ENV_FILE" ] || die ".env missing at $ENV_FILE (reinstall Workspace from the Extensions page)"
ADMIN_USER="$(env_get WORKSPACE_ADMIN_USER)"; ADMIN_USER="${ADMIN_USER:-admin}"
NC_PORT="$(env_get WORKSPACE_NC_SERVE_PORT)"; NC_PORT="${NC_PORT:-8456}"
OO_PORT="$(env_get WORKSPACE_OO_SERVE_PORT)"; OO_PORT="${OO_PORT:-8457}"
[[ "$NC_PORT" =~ ^[0-9]{2,5}$ && "$OO_PORT" =~ ^[0-9]{2,5}$ ]] || die "Serve ports must be numbers"
[ -n "$(env_get WORKSPACE_ONLYOFFICE_JWT_SECRET)" ] || die "WORKSPACE_ONLYOFFICE_JWT_SECRET is missing from .env"

step "checking .env"
# 0a-pre. Never overwrite the only DB-matching copy of the secrets from a damaged .env.
for k in $GENERATED_KEYS; do
  [ -n "$(env_get "$k")" ] || die "$k is empty or missing in $ENV_FILE. Not touching the retained copy $RETAINED (it may hold the only value that matches the database). Restore the line from $RETAINED into $ENV_FILE (keep it mode 600), then re-run this script"
done

step "saving the retained secrets copy"
# 0a. Keep the retained-secrets copy equal to .env (restore / new-box recovery, C2).
mkdir -p "$RETAINED_DIR"; chmod 700 "$RETAINED_DIR"
tmp="$(mktemp "$RETAINED_DIR/.workspace.env.XXXXXX")"
{
  if [ -f "$RETAINED" ]; then grep -vE "^($(echo "$GENERATED_KEYS" | tr ' ' '|'))=" "$RETAINED" || true; fi
  for k in $GENERATED_KEYS; do v="$(env_get "$k")"; [ -n "$v" ] && printf '%s=%s\n' "$k" "$v"; done
} > "$tmp"
chmod 600 "$tmp"; mv "$tmp" "$RETAINED"; unset v

step "waiting for Nextcloud install"
# 1. Nextcloud finished the image's first-run install (with the generated throwaway admin password).
wait_for "Nextcloud" nc_installed

step "applying the admin password"
# 1b. Apply the typed admin password via stdin, then scrub it from this machine (Kevin Q2).
#     Runs before tailnet detection, so a missing tailnet name never delays it.
ADMIN_PW="$(env_get WORKSPACE_ADMIN_PASSWORD)"
if [ -n "$ADMIN_PW" ]; then
  if ! occ user:info "$ADMIN_USER" >/dev/null 2>&1; then
    unset ADMIN_PW
    die "the admin login '$ADMIN_USER' (WORKSPACE_ADMIN_USER) does not exist in this Nextcloud. This happens when the admin name was changed on a reinstall over existing data. Fix: set WORKSPACE_ADMIN_USER in $ENV_FILE to the login that already exists in Nextcloud (or create it with bash $BUNDLE_DIR/ops/add-user.sh), then re-run this script"
  fi
  if ! OCC_ERR="$(printf '%s\n' "$ADMIN_PW" | occ_with_pass user:resetpassword --password-from-env "$ADMIN_USER" 2>&1 >/dev/null)"; then
    unset ADMIN_PW
    OCC_ERR="$(printf '%s' "$OCC_ERR" | tail -n 1 | tr -d '\r')"
    die "Nextcloud rejected the admin password from the install form (its password policy, e.g. a password found in known data breaches; occ said: ${OCC_ERR:-no message}). Fix: bash $BUNDLE_DIR/ops/reset-password.sh $ADMIN_USER with another password, then delete the WORKSPACE_ADMIN_PASSWORD line from $ENV_FILE and re-run this script."
  fi
  env_unset WORKSPACE_ADMIN_PASSWORD
  log "admin password set from the install form; removed from .env"
fi
unset ADMIN_PW

step "working out the tailnet name"
# 0b. Where the household reaches it: this machine's tailnet name.
HOST="$(env_get WORKSPACE_PUBLIC_HOST)"
if [ -z "$HOST" ]; then
  HOST="$($TS status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  [ -n "$HOST" ] || die "cannot work out this machine's tailnet name. Add a line WORKSPACE_PUBLIC_HOST=<name> to $ENV_FILE (keep it mode 600), then re-run this script"
  [[ "$HOST" =~ $HOST_RE ]] || die "'$HOST' is not a valid hostname"
  env_set WORKSPACE_PUBLIC_HOST "$HOST"
fi
[[ "$HOST" =~ $HOST_RE ]] || die "WORKSPACE_PUBLIC_HOST '$HOST' is not a valid hostname"
NC_URL="https://$HOST:$NC_PORT"
OO_URL="https://$HOST:$OO_PORT/"


step "enabling apps"
# 2. Apps + background jobs (Redis locking is configured by the image from REDIS_HOST).
for app in calendar contacts forms onlyoffice; do
  if [ "$(occ config:app:get "$app" enabled 2>/dev/null || true)" = "yes" ]; then
    log "app $app: already enabled"
  else
    occ app:install "$app" >/dev/null 2>&1 || occ app:enable "$app" >/dev/null
    log "app $app: enabled"
  fi
done
occ background:cron >/dev/null
occ config:system:set memcache.local --value='\OC\Memcache\APCu' >/dev/null

step "configuring the reverse proxy"
# 3. Reverse proxy: Serve → 127.0.0.1:3070 → the (pinned) docker bridge gateway.
GW="$($DOCKER network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
[ -n "$GW" ] || die "cannot read the gateway address of docker network $NET"
occ config:system:set trusted_domains 1 --value=nextcloud >/dev/null
occ config:system:set trusted_domains 2 --value="$HOST" >/dev/null
occ config:system:set trusted_proxies 0 --value="$GW" >/dev/null
occ config:system:set overwritehost --value="$HOST:$NC_PORT" >/dev/null
occ config:system:set overwriteprotocol --value=https >/dev/null
occ config:system:set overwrite.cli.url --value="$NC_URL" >/dev/null
occ config:system:set overwritecondaddr --value="^${GW//./\\.}\$" >/dev/null
occ config:system:set allow_local_remote_servers --value=true --type=boolean >/dev/null
log "proxy: $NC_URL (overwrite only for requests via $GW)"

step "ONLYOFFICE connector"
# 4. ONLYOFFICE connector. The JWT goes in on stdin: python builds the JSON, which the
#    container writes to a private temp file for `occ config:import` (see occ_import_stdin;
#    /dev/stdin is not openable by php there) — the secret is in no argv anywhere.
occ config:app:set onlyoffice DocumentServerUrl --value="$OO_URL" >/dev/null
occ config:app:set onlyoffice DocumentServerInternalUrl --value="http://onlyoffice/" >/dev/null
occ config:app:set onlyoffice StorageUrl --value="http://nextcloud/" >/dev/null
printf '%s\n' "$(env_get WORKSPACE_ONLYOFFICE_JWT_SECRET)" \
  | python3 -c 'import json,sys; print(json.dumps({"apps":{"onlyoffice":{"jwt_secret":sys.stdin.read().strip()}}}))' \
  | occ_import_stdin >/dev/null
occ config:app:set onlyoffice jwt_header --value=Authorization >/dev/null
occ config:system:set onlyoffice allow_local_address --value=true --type=boolean >/dev/null
occ config:app:set onlyoffice defFormats --value='{"docx":true,"xlsx":true,"pptx":true,"odt":true,"ods":true,"odp":true}' >/dev/null
occ config:app:set onlyoffice editFormats --value='{"odt":true,"ods":true,"odp":true}' >/dev/null
wait_for "ONLYOFFICE" oo_connected

step "groups and sharing policy"
# 5. Groups + sharing policy (Kevin Q5): crow-bot can't make public links and is never
#    suggested by autocomplete (household users enumerate only their group; typing the
#    exact login still works).
occ group:add household >/dev/null 2>&1 || true
occ group:adduser household "$ADMIN_USER" >/dev/null 2>&1 || true
occ group:add crow-bots >/dev/null 2>&1 || true
occ config:app:set core shareapi_allow_links_exclude_groups --value='["crow-bots"]' >/dev/null
occ config:app:set core shareapi_restrict_user_enumeration_to_group --value=yes >/dev/null
occ config:app:set core shareapi_restrict_user_enumeration_full_match --value=yes >/dev/null

step "Menu calendar"
# 6. The shared "Menu" calendar, owned by the admin (shared with people in the Calendar app).
if occ dav:list-calendars "$ADMIN_USER" 2>/dev/null | grep -qE '^\| Menu +\|'; then
  log "calendar Menu: exists"
else
  occ dav:create-calendar "$ADMIN_USER" Menu >/dev/null
  log "calendar Menu: created"
fi

step "crow-bot account"
# 7. crow-bot (group crow-bots, not admin) + exactly one valid app password, in .env (600).
if occ user:info "$BOT" >/dev/null 2>&1; then BOT_EXISTS=1; else BOT_EXISTS=0; fi
if [ "$BOT_EXISTS" = 1 ] && [ -n "$(env_get WORKSPACE_BOT_APP_PASSWORD)" ]; then
  log "$BOT: present"
else
  BOT_PW="$(random_pw 40)"
  if [ "$BOT_EXISTS" = 0 ]; then
    printf '%s\n' "$BOT_PW" | occ_with_pass user:add --password-from-env --display-name="Crow bot" --group crow-bots "$BOT" >/dev/null
  else
    printf '%s\n' "$BOT_PW" | occ_with_pass user:resetpassword --password-from-env "$BOT" >/dev/null
    for id in $(occ user:auth-tokens:list "$BOT" --output=json 2>/dev/null | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = []
print(" ".join(str(t["id"]) for t in d if t.get("name") == "'"$TOKEN_NAME"'"))'); do
      occ user:auth-tokens:delete "$BOT" "$id" >/dev/null
    done
  fi
  TOKEN="$(printf '%s\n' "$BOT_PW" | occ_with_pass user:auth-tokens:add --password-from-env --name "$TOKEN_NAME" "$BOT" | tail -n 1 | tr -d '\r')"
  unset BOT_PW
  [[ "$TOKEN" =~ ^[A-Za-z0-9]{72}$ ]] || die "could not mint the $BOT app password (unexpected occ output)"
  env_set WORKSPACE_BOT_APP_PASSWORD "$TOKEN"
  unset TOKEN
  log "$BOT: account ready; app password stored in .env (mode 600)"
fi

step "writing the completion marker"
# Last step: completion marker (non-secret). The Office page shows "ready" only with it.
env_set WORKSPACE_BOOTSTRAP_DONE 1
log "done. Workspace: $NC_URL  editor: $OO_URL"
log "next: publish both on your tailnet (Office in Crow shows the two commands)"
