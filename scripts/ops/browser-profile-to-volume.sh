#!/usr/bin/env bash
# browser-profile-to-volume.sh — ONE-TIME move of a crow-browser container's
# Chromium profile (cookies, saved logins) from the container's own layer onto
# the named volume the browser bundle's compose declares since 1.3.12.
#
# NEVER run automatically. An operator runs it once per instance, in a
# registered maintenance window, after reading --dry-run's plan.
#
#   scripts/ops/browser-profile-to-volume.sh \
#     --container crow-browser --project browser \
#     --source <checkout>/bundles/browser [--domains example.com,example.org] [--dry-run]
#
# Steps (each refuses loudly; nothing is changed before step 2):
#   1. checks: the container exists, is THIS compose project's crow-browser
#      service, has no volume on the profile dir yet, the profile is there;
#      the new compose (--source) renders with this instance's .env to the same
#      project, container name and a project-scoped profile volume; the volume
#      does not exist yet.
#   2. docker stop the container.
#   3. docker cp the profile out (a tar stream: owners, modes and times kept)
#      to <instance home>/browser-profile-backup/<timestamp>/ (mode 700).
#   4. create the volume (with compose's own labels) and unpack the backup into
#      it as root inside a throwaway --network none container: ownership and
#      permissions preserved.
#   5. install the new compose / entrypoint / Dockerfile into the bundle dir
#      (the old ones are kept in the backup dir), add CROW_BROWSER_VNC_TOKEN to
#      the bundle .env if it is missing (mode 600), and recreate the container
#      with the new compose (build + force-recreate).
#   6. wait for CDP on 127.0.0.1:<CROW_BROWSER_CDP_PORT>.
#   7. print the cookie NAMES (never values) stored for --domains.
# Any failure before step 5's recreate puts the bundle files and .env back and
# starts the OLD container again, unchanged (its profile was never touched).
#
# Test seams (tests/browser-profile-to-volume.test.js): DOCKER (the docker
# binary), CROW_MIGRATE_NOW (the timestamp), CROW_MIGRATE_CDP_WAIT (seconds).
set -uo pipefail

DOCKER="${DOCKER:-docker}"
PROFILE_DIR=/root/.config/chromium-crow
VOLUME_KEY=chromium-profile
SERVICE=crow-browser

CONTAINER="" PROJECT="" SOURCE="" DOMAINS="" DRY_RUN=0

say() { echo "[profile-to-volume] $*"; }
fail() { echo "[profile-to-volume] REFUSED: $*" >&2; exit 1; }
usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --domains) DOMAINS="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$CONTAINER" ] && [ -n "$PROJECT" ] && [ -n "$SOURCE" ] || usage
[[ "$CONTAINER" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$ ]] || fail "--container '$CONTAINER' is not a container name"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || fail "--project '$PROJECT' is not a compose project name"
if [ -n "$DOMAINS" ] && ! [[ "$DOMAINS" =~ ^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$ ]]; then
  fail "--domains must be a comma-separated list of host names"
fi
SOURCE="$(cd "$SOURCE" 2>/dev/null && pwd)" || fail "--source is not a directory"
for f in docker-compose.yml entrypoint.sh Dockerfile; do
  [ -f "$SOURCE/$f" ] || fail "--source has no $f (point it at a checkout's bundles/browser)"
done
grep -q "${VOLUME_KEY}:${PROFILE_DIR}" "$SOURCE/docker-compose.yml" \
  || fail "--source's compose has no ${VOLUME_KEY} volume on ${PROFILE_DIR}: not the 1.3.12+ browser bundle"

# ---- 1. checks --------------------------------------------------------------
label() { "$DOCKER" inspect "$CONTAINER" --format "{{index .Config.Labels \"$1\"}}" 2>/dev/null; }
"$DOCKER" inspect "$CONTAINER" --format '{{.Name}}' >/dev/null 2>&1 || fail "no container named '$CONTAINER'"
[ "$("$DOCKER" inspect "$CONTAINER" --format '{{.Name}}')" = "/$CONTAINER" ] || fail "'$CONTAINER' resolves to another container"
[ "$(label com.docker.compose.project)" = "$PROJECT" ] \
  || fail "'$CONTAINER' belongs to compose project '$(label com.docker.compose.project)', not '$PROJECT'"
[ "$(label com.docker.compose.service)" = "$SERVICE" ] || fail "'$CONTAINER' is not the $SERVICE service"
COMPOSE_FILE_USED="$(label com.docker.compose.project.config_files)"
BUNDLE_DIR="$(dirname "${COMPOSE_FILE_USED%%,*}")"
[ -n "$COMPOSE_FILE_USED" ] && [ -f "$BUNDLE_DIR/docker-compose.yml" ] || fail "cannot find the bundle dir of '$CONTAINER' (compose file label: '$COMPOSE_FILE_USED')"
[ "$(basename "$BUNDLE_DIR")" = "browser" ] && [ "$(basename "$(dirname "$BUNDLE_DIR")")" = "bundles" ] \
  || fail "'$BUNDLE_DIR' is not an installed <home>/bundles/browser"
INSTANCE_HOME="$(dirname "$(dirname "$BUNDLE_DIR")")"
ENV_FILE="$BUNDLE_DIR/.env"
[ -f "$ENV_FILE" ] || fail "no $ENV_FILE"
if "$DOCKER" inspect "$CONTAINER" --format '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' | grep -qx "$PROFILE_DIR"; then
  fail "'$CONTAINER' already has a volume on $PROFILE_DIR: nothing to move"
fi
IMAGE="$("$DOCKER" inspect "$CONTAINER" --format '{{.Image}}')"
[ -n "$IMAGE" ] || fail "cannot read the image of '$CONTAINER'"
WAS_RUNNING="$("$DOCKER" inspect "$CONTAINER" --format '{{.State.Running}}')"

# What the NEW compose would do with this instance's .env (a stand-in token
# when the .env has none yet: config only renders, it never starts anything).
render() {
  ( cd "$BUNDLE_DIR" && CROW_HOME="$INSTANCE_HOME" CROW_BROWSER_VNC_TOKEN="${CROW_BROWSER_VNC_TOKEN:-render-check-only-render-check-only}" \
      "$DOCKER" compose --env-file "$ENV_FILE" -f "$SOURCE/docker-compose.yml" --project-directory "$BUNDLE_DIR" config --format json )
}
RENDERED="$(render 2>/dev/null)" || fail "the new compose does not render with $ENV_FILE"
read -r R_NAME R_CONTAINER R_VOLUME < <(printf '%s' "$RENDERED" | python3 -c '
import json, sys
c = json.load(sys.stdin)
s = c["services"]["crow-browser"]
vol = next((v for v in s.get("volumes", []) if v.get("target") == "/root/.config/chromium-crow"), {})
print(c.get("name", ""), s.get("container_name", ""), c.get("volumes", {}).get(vol.get("source", ""), {}).get("name", ""))
') || fail "cannot read the rendered compose"
[ "$R_NAME" = "$PROJECT" ] || fail "the new compose renders project '$R_NAME', not '$PROJECT' (check CROW_BROWSER_CONTAINER_NAME / COMPOSE_PROJECT_NAME in $ENV_FILE)"
[ "$R_CONTAINER" = "$CONTAINER" ] || fail "the new compose renders container '$R_CONTAINER', not '$CONTAINER'"
VOLUME="${PROJECT}_${VOLUME_KEY}"
[ "$R_VOLUME" = "$VOLUME" ] || fail "the new compose renders profile volume '$R_VOLUME', expected '$VOLUME'"
if "$DOCKER" volume inspect "$VOLUME" >/dev/null 2>&1; then
  fail "volume '$VOLUME' already exists: refusing to overwrite it (inspect it, and remove it yourself if it is empty)"
fi
"$DOCKER" exec "$CONTAINER" test -d "$PROFILE_DIR" 2>/dev/null || [ "$WAS_RUNNING" != "true" ] \
  || fail "'$CONTAINER' has no $PROFILE_DIR"

STAMP="${CROW_MIGRATE_NOW:-$(date +%Y%m%d-%H%M%S)}"
BACKUP="$INSTANCE_HOME/browser-profile-backup/$STAMP"
CDP_PORT="$(sed -n 's/^CROW_BROWSER_CDP_PORT=//p' "$ENV_FILE" | tail -n 1)"; CDP_PORT="${CDP_PORT:-9222}"

say "container:  $CONTAINER (project $PROJECT, running=$WAS_RUNNING)"
say "bundle dir: $BUNDLE_DIR"
say "backup:     $BACKUP (mode 700)"
say "volume:     $VOLUME → $PROFILE_DIR"
say "then:       new compose from $SOURCE, build + force-recreate, wait for CDP on 127.0.0.1:$CDP_PORT"
if [ "$DRY_RUN" = 1 ]; then
  say "dry run: all checks passed, nothing changed."
  exit 0
fi

# ---- rollback until the recreate --------------------------------------------
STAGE=checks
rollback() {
  local code=$?
  [ "$STAGE" = recreating ] || [ "$STAGE" = done ] && exit "$code"
  echo "[profile-to-volume] FAILED during '$STAGE': putting things back" >&2
  if [ -d "$BACKUP/bundle-files" ]; then
    for f in docker-compose.yml entrypoint.sh Dockerfile .env; do
      [ -e "$BACKUP/bundle-files/$f" ] && cp -p "$BACKUP/bundle-files/$f" "$BUNDLE_DIR/$f"
    done
  fi
  if [ "$WAS_RUNNING" = "true" ]; then
    "$DOCKER" start "$CONTAINER" >/dev/null 2>&1 && echo "[profile-to-volume] the old container '$CONTAINER' is running again, unchanged" >&2 \
      || echo "[profile-to-volume] could not start '$CONTAINER' again: docker start $CONTAINER" >&2
  fi
  [ "$STAGE" = volume ] && echo "[profile-to-volume] a partly filled volume may remain: docker volume rm $VOLUME" >&2
  exit 1
}
trap rollback EXIT
set -e

# ---- 2. stop ----------------------------------------------------------------
STAGE=stop
say "stopping $CONTAINER..."
"$DOCKER" stop "$CONTAINER" >/dev/null

# ---- 3. back up -------------------------------------------------------------
STAGE=backup
mkdir -p "$BACKUP"
chmod 700 "$INSTANCE_HOME/browser-profile-backup" "$BACKUP"
( umask 077; "$DOCKER" cp "$CONTAINER:$PROFILE_DIR" - > "$BACKUP/profile.tar" )
[ -s "$BACKUP/profile.tar" ] || { echo "empty profile backup" >&2; false; }
FIRST="$(tar -tf "$BACKUP/profile.tar" | sed -n 1p)"
[[ "$FIRST" == chromium-crow/* ]] || { echo "unexpected backup layout" >&2; false; }
mkdir -p "$BACKUP/bundle-files"
for f in docker-compose.yml entrypoint.sh Dockerfile .env; do
  [ -e "$BUNDLE_DIR/$f" ] && cp -p "$BUNDLE_DIR/$f" "$BACKUP/bundle-files/$f"
done
say "profile backed up: $BACKUP/profile.tar ($(du -h "$BACKUP/profile.tar" | cut -f1))"

# ---- 4. the volume ------------------------------------------------------------
STAGE=volume
"$DOCKER" volume create --label "com.docker.compose.project=$PROJECT" --label "com.docker.compose.volume=$VOLUME_KEY" "$VOLUME" >/dev/null
"$DOCKER" run --rm -i --network none --user 0:0 --entrypoint tar -v "$VOLUME:$PROFILE_DIR" "$IMAGE" \
  -xpf - --numeric-owner -C /root/.config < "$BACKUP/profile.tar"
COUNT_TAR="$(tar -tf "$BACKUP/profile.tar" | wc -l)"
COUNT_VOL="$("$DOCKER" run --rm --network none --entrypoint sh -v "$VOLUME:$PROFILE_DIR:ro" "$IMAGE" -c "cd /root/.config && find chromium-crow | wc -l")"
[ "$COUNT_TAR" -eq "$COUNT_VOL" ] || { echo "volume has $COUNT_VOL entries, backup $COUNT_TAR" >&2; false; }
say "volume $VOLUME filled ($COUNT_VOL entries, owners and modes kept)."

# ---- 5. new compose, token, recreate -----------------------------------------
STAGE=install
cp "$SOURCE/docker-compose.yml" "$BUNDLE_DIR/docker-compose.yml"
install -m 755 "$SOURCE/entrypoint.sh" "$BUNDLE_DIR/entrypoint.sh"
cp "$SOURCE/Dockerfile" "$BUNDLE_DIR/Dockerfile"
if ! grep -q '^CROW_BROWSER_VNC_TOKEN=.\{32,\}' "$ENV_FILE"; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  sed -i '/^CROW_BROWSER_VNC_TOKEN=/d' "$ENV_FILE"
  printf 'CROW_BROWSER_VNC_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
  unset TOKEN
  say "added CROW_BROWSER_VNC_TOKEN to $ENV_FILE (not printed)"
fi
chmod 600 "$ENV_FILE"
STAGE=recreating
trap - EXIT
say "recreating $CONTAINER with the new compose (build + force-recreate)..."
if ! ( cd "$BUNDLE_DIR" && CROW_HOME="$INSTANCE_HOME" "$DOCKER" compose -p "$PROJECT" up -d --build --force-recreate ); then
  echo "[profile-to-volume] the recreate FAILED. The profile is safe in volume $VOLUME and in $BACKUP/profile.tar;" >&2
  echo "[profile-to-volume] the old bundle files are in $BACKUP/bundle-files. Fix and rerun: cd $BUNDLE_DIR && CROW_HOME=$INSTANCE_HOME docker compose -p $PROJECT up -d --build" >&2
  exit 1
fi

# ---- 6. CDP -------------------------------------------------------------------
WAIT="${CROW_MIGRATE_CDP_WAIT:-90}"
ok=0
for i in $(seq 1 "$WAIT"); do
  if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || { echo "[profile-to-volume] CDP did not answer on 127.0.0.1:${CDP_PORT} within ${WAIT}s: docker logs $CONTAINER" >&2; exit 1; }
say "CDP is up on 127.0.0.1:${CDP_PORT}."

# ---- 7. cookie names (never values) --------------------------------------------
if [ -n "$DOMAINS" ]; then
  "$DOCKER" exec -i "$CONTAINER" python3 - "$DOMAINS" <<'PY' || echo "[profile-to-volume] could not read the cookie store (the profile is still in place)" >&2
import shutil, sqlite3, sys, tempfile, os
src = "/root/.config/chromium-crow/Default/Cookies"
if not os.path.exists(src):
    src = "/root/.config/chromium-crow/Default/Network/Cookies"
tmp = tempfile.mktemp()
shutil.copy(src, tmp)
db = sqlite3.connect(tmp)
for d in sys.argv[1].split(","):
    rows = db.execute("SELECT DISTINCT host_key, name FROM cookies WHERE host_key = ? OR host_key LIKE ? ORDER BY host_key, name",
                      (d, "%." + d)).fetchall()
    print("%s: %d cookie(s)%s" % (d, len(rows), (": " + ", ".join("%s (%s)" % (n, h) for h, n in rows)) if rows else ""))
db.close(); os.unlink(tmp)
PY
fi
say "done. The backup stays in $BACKUP until you remove it."
