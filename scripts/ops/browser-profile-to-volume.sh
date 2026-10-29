#!/usr/bin/env bash
# browser-profile-to-volume.sh — ONE-TIME move of a crow-browser container's
# Chromium profile (cookies, saved logins) from the container's own layer onto
# the named volume the browser bundle's compose declares since 1.3.12.
#
# NEVER run automatically. An operator runs it once per instance, inside tmux,
# in a registered maintenance window, after reading --dry-run's plan.
#
#   scripts/ops/browser-profile-to-volume.sh \
#     --container crow-browser --project browser \
#     --source <checkout>/bundles/browser [--domains example.com,example.org] [--dry-run]
#   scripts/ops/browser-profile-to-volume.sh --delete-backup <home>/browser-profile-backup/<stamp>
#
# Steps (each refuses loudly; nothing is changed before step 2):
#   1. checks: the container exists and is THIS compose project's crow-browser
#      service, has no volume on the profile dir yet; the new compose (--source)
#      renders with this instance's .env to the same project, container and the
#      instance's explicitly named profile volume; that volume does not exist.
#   2. tag the old image crow-browser-prev:<project>-<stamp> (the nightly
#      `docker image prune` cannot remove it: the rollback image).
#   3. BUILD the new image while the old container keeps running.
#   4. close Chromium gracefully (restart policy paused; CDP Browser.close,
#      SIGTERM only as a fallback; wait), then docker stop.
#   5. docker cp the profile out (a tar stream: owners, modes kept) to
#      <instance home>/browser-profile-backup/<stamp>/ (700; the tar 600).
#   6. create the volume (compose's labels), unpack into it as root in a
#      --network none container; check the entry count AND the sha256 of
#      Cookies, Login Data, Local State and Preferences against the tar.
#   7. install the new compose / entrypoint / Dockerfile (old ones kept in the
#      backup dir), add CROW_BROWSER_VNC_TOKEN to the .env if missing (600,
#      never printed), recreate with the new compose (no rebuild).
#   8. wait for CDP; 9. print cookie NAMES for --domains (never values).
# A failure or interrupt (Ctrl-C, a dropped SSH) before the new container is
# up puts back the bundle files, the .env and the old image name, removes a
# volume this run created, restores the restart policy and starts the OLD
# container again, unchanged. If the recreate removed the old container, it
# says so and prints the recovery commands.
#
# Test seams (tests/browser-profile-to-volume.test.js): DOCKER (the docker
# binary), CROW_MIGRATE_NOW (the timestamp), CROW_MIGRATE_CDP_WAIT and
# CROW_MIGRATE_CLOSE_WAIT (seconds).
set -uo pipefail

DOCKER="${DOCKER:-docker}"
PROFILE_DIR=/root/.config/chromium-crow
VOLUME_KEY=chromium-profile
SERVICE=crow-browser
# Files whose hashes must match between the backup and the volume (the ones
# that hold the logins), relative to /root/.config.
KEY_FILES="chromium-crow/Default/Cookies chromium-crow/Default/Network/Cookies chromium-crow/Default/Login?Data chromium-crow/Local?State chromium-crow/Default/Preferences"

CONTAINER="" PROJECT="" SOURCE="" DOMAINS="" DRY_RUN=0 DELETE_BACKUP=""

say() { echo "[profile-to-volume] $*"; }
fail() { echo "[profile-to-volume] REFUSED: $*" >&2; exit 1; }
usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --domains) DOMAINS="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --delete-backup) DELETE_BACKUP="${2:-}"; [ -n "$DELETE_BACKUP" ] || usage; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

# ---- --delete-backup: remove ONE backup dir this script made ----------------
if [ -n "$DELETE_BACKUP" ]; then
  [ -z "$CONTAINER$PROJECT$SOURCE$DOMAINS" ] || fail "--delete-backup takes no other options"
  real="$(cd "$DELETE_BACKUP" 2>/dev/null && pwd -P)" || fail "'$DELETE_BACKUP' is not a directory"
  [[ "$(basename "$real")" =~ ^[0-9]{8}-[0-9]{6}$ ]] && [ "$(basename "$(dirname "$real")")" = "browser-profile-backup" ] \
    || fail "'$real' is not <home>/browser-profile-backup/<stamp>"
  [ -f "$real/profile.tar" ] || fail "'$real' has no profile.tar: not a backup this script made"
  [ "$(stat -c %u "$real")" = "$(id -u)" ] || fail "'$real' is not yours"
  if [ "$DRY_RUN" = 1 ]; then say "dry run: would delete $real"; exit 0; fi
  rm -rf -- "$real"
  say "deleted $real"
  rmdir --ignore-fail-on-non-empty "$(dirname "$real")" 2>/dev/null || true
  exit 0
fi

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
POLICY="$("$DOCKER" inspect "$CONTAINER" --format '{{.HostConfig.RestartPolicy.Name}}')"; POLICY="${POLICY:-no}"

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
unset RENDERED
[ "$R_NAME" = "$PROJECT" ] || fail "the new compose renders project '$R_NAME', not '$PROJECT' (check CROW_BROWSER_CONTAINER_NAME / COMPOSE_PROJECT_NAME in $ENV_FILE)"
[ "$R_CONTAINER" = "$CONTAINER" ] || fail "the new compose renders container '$R_CONTAINER', not '$CONTAINER'"
VOLUME="${PROJECT}-${VOLUME_KEY}"
[ "$R_VOLUME" = "$VOLUME" ] || fail "the new compose renders profile volume '$R_VOLUME', expected '$VOLUME'"
if "$DOCKER" volume inspect "$VOLUME" >/dev/null 2>&1; then
  fail "volume '$VOLUME' already exists: refusing to overwrite it (inspect it, and remove it yourself if it is empty)"
fi
"$DOCKER" exec "$CONTAINER" test -d "$PROFILE_DIR" 2>/dev/null || [ "$WAS_RUNNING" != "true" ] \
  || fail "'$CONTAINER' has no $PROFILE_DIR"

STAMP="${CROW_MIGRATE_NOW:-$(date +%Y%m%d-%H%M%S)}"
BACKUP="$INSTANCE_HOME/browser-profile-backup/$STAMP"
PREV_TAG="crow-browser-prev:${PROJECT}-${STAMP}"
BUILD_NAME="${PROJECT}-crow-browser"
CDP_PORT="$(sed -n 's/^CROW_BROWSER_CDP_PORT=//p' "$ENV_FILE" | tail -n 1)"; CDP_PORT="${CDP_PORT:-9222}"

say "container:  $CONTAINER (project $PROJECT, running=$WAS_RUNNING, restart=$POLICY)"
say "bundle dir: $BUNDLE_DIR"
say "old image:  kept as $PREV_TAG (the rollback image; prune-proof)"
say "new image:  built as $BUILD_NAME from $SOURCE BEFORE the old container stops"
say "backup:     $BACKUP (mode 700)"
say "volume:     $VOLUME → $PROFILE_DIR"
say "then:       new compose, recreate (no rebuild), wait for CDP on 127.0.0.1:$CDP_PORT"
if [ "$DRY_RUN" = 1 ]; then
  say "dry run: all checks passed, nothing changed."
  exit 0
fi
[ -n "${TMUX:-}${STY:-}" ] || say "note: not inside tmux/screen. A dropped session is rolled back, but run it inside tmux."

# CDP Browser.close on 127.0.0.1:<port> (a raw WebSocket; python3 only).
cdp_close() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import base64, json, os, socket, sys, urllib.request
port = int(sys.argv[1])
url = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=3))["webSocketDebuggerUrl"]
path = url.split(":%d" % port, 1)[1]
s = socket.create_connection(("127.0.0.1", port), timeout=5)
s.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, port, base64.b64encode(os.urandom(16)).decode())).encode())
head = b""
while b"\r\n\r\n" not in head:
    d = s.recv(4096)
    if not d:
        sys.exit(1)
    head += d
if b" 101 " not in head.split(b"\r\n")[0]:
    sys.exit(1)
msg = json.dumps({"id": 1, "method": "Browser.close"}).encode()
mask = os.urandom(4)
s.sendall(bytes([0x81, 0x80 | len(msg)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(msg)))
try:
    s.recv(4096)
except OSError:
    pass
PY
}

# ---- rollback until the new container is up ----------------------------------
STAGE=start BUILT=0 POLICY_CHANGED=0 CREATED_VOLUME=0
rollback() {
  local code=$?
  [ "$STAGE" = done ] && exit "$code"
  trap - EXIT INT TERM HUP
  echo "[profile-to-volume] FAILED or interrupted during '$STAGE': putting things back" >&2
  if [ "$STAGE" = recreate ]; then
    if [ "$("$DOCKER" inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null)" != "$IMAGE" ]; then
      echo "[profile-to-volume] the recreate already replaced the old container. NOT rolling back automatically." >&2
      echo "[profile-to-volume] the profile is in volume $VOLUME and $BACKUP/profile.tar; the old image is $PREV_TAG;" >&2
      echo "[profile-to-volume] the old bundle files are in $BACKUP/bundle-files. Retry: cd $BUNDLE_DIR && CROW_HOME=$INSTANCE_HOME docker compose -p $PROJECT up -d --no-build" >&2
      exit 1
    fi
  fi
  if [ -d "$BACKUP/bundle-files" ]; then
    for f in docker-compose.yml entrypoint.sh Dockerfile .env; do
      [ -e "$BACKUP/bundle-files/$f" ] && cp -p "$BACKUP/bundle-files/$f" "$BUNDLE_DIR/$f"
    done
  fi
  if [ "$CREATED_VOLUME" = 1 ]; then
    "$DOCKER" volume rm "$VOLUME" >/dev/null 2>&1 && echo "[profile-to-volume] removed the volume this run created ($VOLUME)" >&2 \
      || echo "[profile-to-volume] could not remove $VOLUME: remove it before any later 'compose up': docker volume rm $VOLUME" >&2
  fi
  [ "$BUILT" = 1 ] && "$DOCKER" tag "$IMAGE" "$BUILD_NAME" >/dev/null 2>&1
  [ "$POLICY_CHANGED" = 1 ] && "$DOCKER" update --restart="$POLICY" "$CONTAINER" >/dev/null 2>&1
  if [ "$WAS_RUNNING" = "true" ]; then
    "$DOCKER" start "$CONTAINER" >/dev/null 2>&1 && echo "[profile-to-volume] the old container '$CONTAINER' is running again, unchanged" >&2 \
      || echo "[profile-to-volume] could not start '$CONTAINER' again: docker start $CONTAINER" >&2
  fi
  exit 1
}
trap rollback EXIT
trap 'exit 130' INT TERM HUP
set -e

# ---- 2. keep the old image ---------------------------------------------------
STAGE=tag
"$DOCKER" tag "$IMAGE" "$PREV_TAG"
say "old image tagged $PREV_TAG"

# ---- 3. build first, while the old container still serves ---------------------
STAGE=build
BUILT=1
"$DOCKER" build -t "$BUILD_NAME" "$SOURCE"
say "new image built ($BUILD_NAME)."

# ---- 4. a graceful stop: Chromium flushes cookies and logins first ------------
STAGE=stop
"$DOCKER" update --restart=no "$CONTAINER" >/dev/null
POLICY_CHANGED=1
if [ "$WAS_RUNNING" = "true" ]; then
  # CDP Browser.close: the way that commits the cookie store (Chromium's own
  # SIGTERM path, and docker stop's SIGKILL, do not). SIGTERM is the fallback.
  say "closing Chromium in $CONTAINER (CDP Browser.close on 127.0.0.1:$CDP_PORT)..."
  closed=0
  if cdp_close "$CDP_PORT"; then closed=1; fi
  [ "$closed" = 1 ] || "$DOCKER" exec "$CONTAINER" sh -c 'pkill -TERM -o -f -- "--user-data-dir=/root/.config/chromium-crow"' >/dev/null 2>&1 || true
  for i in $(seq 1 "${CROW_MIGRATE_CLOSE_WAIT:-30}"); do
    [ "$("$DOCKER" inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null)" = "true" ] || break
    "$DOCKER" exec "$CONTAINER" pgrep -f -- "--user-data-dir=/root/.config/chromium-crow" >/dev/null 2>&1 || break
    sleep 1
  done
  [ "$closed" = 1 ] && say "Chromium closed through CDP." || say "CDP close failed: Chromium got SIGTERM (recent cookie writes may be lost)."
fi
say "stopping $CONTAINER..."
"$DOCKER" stop -t 30 "$CONTAINER" >/dev/null

# ---- 5. back up ---------------------------------------------------------------
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
# sha256 of the login-bearing files, from the tar itself.
TAR_HASHES="$(set -f; python3 - "$BACKUP/profile.tar" $KEY_FILES <<'PY'
import hashlib, sys, tarfile
want = [w.replace("?", " ") for w in sys.argv[2:]]
with tarfile.open(sys.argv[1]) as t:
    for m in t.getmembers():
        if m.isfile() and m.name in want:
            print(hashlib.sha256(t.extractfile(m).read()).hexdigest() + "  " + m.name)
PY
)"
TAR_HASHES="$(printf '%s\n' "$TAR_HASHES" | sort)"
[ -n "$TAR_HASHES" ] || say "warning: none of Cookies / Login Data / Local State / Preferences is in the profile"
say "profile backed up: $BACKUP/profile.tar ($(du -h "$BACKUP/profile.tar" | cut -f1))"

# ---- 6. the volume --------------------------------------------------------------
STAGE=volume
"$DOCKER" volume create --label "com.docker.compose.project=$PROJECT" --label "com.docker.compose.volume=$VOLUME_KEY" "$VOLUME" >/dev/null
CREATED_VOLUME=1
"$DOCKER" run --rm -i --network none --user 0:0 --entrypoint tar -v "$VOLUME:$PROFILE_DIR" "$IMAGE" \
  -xpf - --numeric-owner -C /root/.config < "$BACKUP/profile.tar"
COUNT_TAR="$(tar -tf "$BACKUP/profile.tar" | wc -l)"
COUNT_VOL="$("$DOCKER" run --rm --network none --entrypoint sh -v "$VOLUME:$PROFILE_DIR:ro" "$IMAGE" -c "cd /root/.config && find chromium-crow | wc -l")"
[ "$COUNT_TAR" -eq "$COUNT_VOL" ] || { echo "volume has $COUNT_VOL entries, backup $COUNT_TAR" >&2; false; }
VOL_HASHES="$("$DOCKER" run --rm --network none --entrypoint sh -v "$VOLUME:$PROFILE_DIR:ro" "$IMAGE" \
  -c "cd /root/.config && for f in $KEY_FILES; do [ -f \"\$f\" ] && sha256sum \"\$f\"; done; true" | sort)"
[ "$VOL_HASHES" = "$TAR_HASHES" ] || { echo "the volume's Cookies / Login Data / Local State / Preferences do not match the backup" >&2; false; }
say "volume $VOLUME filled ($COUNT_VOL entries; owners, modes and the login files' hashes match)."

# ---- 7. new compose, token, recreate ----------------------------------------------
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
STAGE=recreate
say "recreating $CONTAINER with the new compose (no rebuild)..."
( cd "$BUNDLE_DIR" && CROW_HOME="$INSTANCE_HOME" "$DOCKER" compose -p "$PROJECT" up -d --no-build --force-recreate )
STAGE=done
trap - EXIT INT TERM HUP
set +e

# ---- 8. CDP -------------------------------------------------------------------
WAIT="${CROW_MIGRATE_CDP_WAIT:-90}"
ok=0
for i in $(seq 1 "$WAIT"); do
  if curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then
  say "CDP is up on 127.0.0.1:${CDP_PORT}."
else
  echo "[profile-to-volume] CDP did not answer on 127.0.0.1:${CDP_PORT} within ${WAIT}s: docker logs $CONTAINER" >&2
fi

# ---- 9. cookie names (never values) --------------------------------------------
if [ "$ok" = 1 ] && [ -n "$DOMAINS" ]; then
  "$DOCKER" exec -i "$CONTAINER" python3 - "$DOMAINS" <<'PY' || echo "[profile-to-volume] could not read the cookie store (the profile is still in place)" >&2
import os, sqlite3, sys, tempfile
src = "/root/.config/chromium-crow/Default/Network/Cookies"
if not os.path.exists(src):
    src = "/root/.config/chromium-crow/Default/Cookies"
fd, tmp = tempfile.mkstemp(prefix="crow-cookies-")   # 0600, unique
os.close(fd)
try:
    live = sqlite3.connect("file:%s?mode=ro" % src, uri=True)
    copy = sqlite3.connect(tmp)
    live.backup(copy)          # a consistent copy, journal included
    live.close()
    for d in sys.argv[1].split(","):
        rows = copy.execute("SELECT DISTINCT host_key, name FROM cookies WHERE host_key = ? OR host_key LIKE ? ORDER BY host_key, name",
                            (d, "%." + d)).fetchall()
        print("%s: %d cookie(s)%s" % (d, len(rows), (": " + ", ".join("%s (%s)" % (n, h) for h, n in rows)) if rows else ""))
    copy.close()
finally:
    os.unlink(tmp)
PY
fi

say "done."
say "backup: $BACKUP  (holds the cookies, effectively unencrypted)"
say "rollback image: $PREV_TAG"
say "once the logins are confirmed, delete both:"
say "  $0 --delete-backup $BACKUP"
say "  docker rmi $PREV_TAG"
[ "$ok" = 1 ] || exit 1
