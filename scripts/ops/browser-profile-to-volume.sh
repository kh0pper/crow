#!/usr/bin/env bash
# browser-profile-to-volume.sh — ONE-TIME move of a crow-browser container's
# Chromium profile (cookies, saved logins) from the container's own layer onto
# the named volume the browser bundle's compose declares since 1.4.0.
#
# NEVER run automatically. An operator runs it once per instance, inside tmux
# or screen (it refuses otherwise, unless --no-tty-guard), in a registered
# maintenance window with bots paused, after reading --dry-run's plan.
# Needs Docker Compose 2.23.1 or newer (checked).
#
#   scripts/ops/browser-profile-to-volume.sh \
#     --container crow-browser --project browser \
#     --source <checkout>/bundles/browser [--domains example.com,example.org] [--dry-run] [--no-tty-guard]
#   scripts/ops/browser-profile-to-volume.sh --delete-backup <home>/browser-profile-backup/<stamp>
#
# Steps (each refuses loudly; nothing is changed before step 2):
#   1. checks: the container exists and is THIS compose project's crow-browser
#      service, has no volume on the profile dir yet; the new compose (--source)
#      renders with this instance's .env to the same project, container and the
#      instance's explicitly named profile volume; that volume does not exist.
#   2. tag the old image crow-browser-prev:<project>-<stamp> (the nightly
#      `docker image prune` cannot remove it: the rollback image).
#   3. BUILD the new image to a temporary tag (crow-browser-next:...) while the
#      old container keeps running; the compose image name moves to it only at
#      step 7, so a `compose up` in between cannot replace the old container.
#      Then arm an out-of-process deadman (systemd-run --user, 15 min): unless
#      this run marks itself done or rolled back, it restores the old
#      container's restart policy and starts it, if the old container is still
#      the one there and is not running.
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
# says so and prints the recovery commands. A SIGKILL, an OOM kill or a dead
# tmux server skip all of that: the deadman covers those.
#
# Test seams (tests/browser-profile-to-volume.test.js): DOCKER (the docker
# binary), CROW_MIGRATE_NOW (the timestamp), CROW_MIGRATE_CDP_WAIT,
# CROW_MIGRATE_CLOSE_WAIT and CROW_MIGRATE_DEADMAN_SECS (seconds),
# CROW_MIGRATE_SYSTEMD_RUN / CROW_MIGRATE_SYSTEMCTL (the systemd binaries).
set -uo pipefail

DOCKER="${DOCKER:-docker}"
PROFILE_DIR=/root/.config/chromium-crow
VOLUME_KEY=chromium-profile
SERVICE=crow-browser
# Files whose hashes must match between the backup and the volume (the ones
# that hold the logins), relative to /root/.config.
KEY_FILES="chromium-crow/Default/Cookies chromium-crow/Default/Network/Cookies chromium-crow/Default/Login?Data chromium-crow/Local?State chromium-crow/Default/Preferences"

CONTAINER="" PROJECT="" SOURCE="" DOMAINS="" DRY_RUN=0 DELETE_BACKUP="" TTY_GUARD=1
SYSTEMD_RUN="${CROW_MIGRATE_SYSTEMD_RUN:-systemd-run}"
SYSTEMCTL="${CROW_MIGRATE_SYSTEMCTL:-systemctl}"

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
    --no-tty-guard) TTY_GUARD=0; shift ;;
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
  [ -d "$(dirname "$(dirname "$real")")/bundles/browser" ] \
    || fail "'$real' is not under a Crow instance's data dir (no bundles/browser beside browser-profile-backup)"
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
  || fail "--source's compose has no ${VOLUME_KEY} volume on ${PROFILE_DIR}: not the 1.4.0+ browser bundle"

# configs `content:` (the token file) needs Docker Compose 2.23.1+.
CV="$("$DOCKER" compose version --short 2>/dev/null | sed 's/^v//')"
[ -n "$CV" ] || fail "cannot run '$DOCKER compose version'"
[ "$(printf '%s\n%s\n' 2.23.1 "$CV" | sort -V | head -n 1)" = "2.23.1" ] || fail "Docker Compose $CV is older than 2.23.1 (the new compose's token file needs it)"

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
INSTANCE_HOME="$(realpath -m -- "$(dirname "$(dirname "$BUNDLE_DIR")")")"
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
VOLUME="${PROJECT}_${VOLUME_KEY}"
[ "$R_VOLUME" = "$VOLUME" ] || fail "the new compose renders profile volume '$R_VOLUME', expected '$VOLUME'"
if "$DOCKER" volume inspect "$VOLUME" >/dev/null 2>&1; then
  fail "volume '$VOLUME' already exists: refusing to overwrite it (inspect it, and remove it yourself if it is empty)"
fi
"$DOCKER" exec "$CONTAINER" test -d "$PROFILE_DIR" 2>/dev/null || [ "$WAS_RUNNING" != "true" ] \
  || fail "'$CONTAINER' has no $PROFILE_DIR"

STAMP="${CROW_MIGRATE_NOW:-$(date +%Y%m%d-%H%M%S)}"
BACKUP="$INSTANCE_HOME/browser-profile-backup/$STAMP"
PREV_TAG="crow-browser-prev:${PROJECT}-${STAMP}"
NEXT_TAG="crow-browser-next:${PROJECT}-${STAMP}"
DEADMAN_UNIT="crow-browser-deadman-${PROJECT}-${STAMP}"
BUILD_NAME="${PROJECT}-crow-browser"
# The CDP port THIS container uses (its own env), never the .env's: a mismatch
# would close another instance's Chromium.
CDP_PORT="$("$DOCKER" inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^CDP_PORT=\([0-9]\{1,5\}\)$/\1/p' | tail -n 1)"
CDP_PORT="${CDP_PORT:-9222}"

# ---- an earlier run must be finished first (N2) --------------------------------
# A deadman left armed by an earlier run (killed, or a rollback that could not
# start the container) would fire into THIS run: start the old container
# mid-copy (a torn Cookies/Login Data in the tar) or beside the new one.
STALE_TIMERS=""
if command -v "$SYSTEMCTL" >/dev/null 2>&1; then
  STALE_TIMERS="$("$SYSTEMCTL" --user list-units --state=active --plain --no-legend "crow-browser-deadman-${PROJECT}-*.timer" 2>/dev/null | awk '{print $1}' | grep . || true)"
fi
STALE_STATES=""
for st in "$INSTANCE_HOME"/browser-profile-backup/*/state; do
  [ -f "$st" ] || continue
  case "$(cat "$st" 2>/dev/null)" in armed|start-failed) STALE_STATES="$STALE_STATES $(dirname "$st")" ;; esac
done
if [ -n "$STALE_TIMERS$STALE_STATES" ]; then
  {
    echo "[profile-to-volume] REFUSED: an earlier migration of $PROJECT may still be in flight:"
    for t in $STALE_TIMERS; do echo "[profile-to-volume]   active deadman timer: $t"; done
    for d in $STALE_STATES; do echo "[profile-to-volume]   backup state '$(cat "$d/state" 2>/dev/null)': $d"; done
    echo "[profile-to-volume] Resolve it first:"
    echo "[profile-to-volume]   1. make sure no browser-profile-to-volume.sh is running (pgrep -af browser-profile-to-volume)"
    echo "[profile-to-volume]   2. check the container: docker inspect $CONTAINER --format '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}'"
    echo "[profile-to-volume]      (bring it back if needed: docker update --restart=unless-stopped $CONTAINER && docker start $CONTAINER)"
    for t in $STALE_TIMERS; do echo "[profile-to-volume]   3. systemctl --user stop $t"; done
    for d in $STALE_STATES; do echo "[profile-to-volume]   4. echo resolved > $d/state   (then remove that backup with --delete-backup once you are sure)"; done
  } >&2
  exit 1
fi

say "container:  $CONTAINER (project $PROJECT, running=$WAS_RUNNING, restart=$POLICY)"
say "bundle dir: $BUNDLE_DIR"
say "old image:  kept as $PREV_TAG (the rollback image; prune-proof)"
say "new image:  built as $NEXT_TAG from $SOURCE BEFORE the old container stops; named $BUILD_NAME only at install"
say "deadman:    $DEADMAN_UNIT restarts the old container after ${CROW_MIGRATE_DEADMAN_SECS:-900}s unless this run finishes"
say "backup:     $BACKUP (mode 700)"
say "volume:     $VOLUME → $PROFILE_DIR"
say "then:       new compose, recreate (no rebuild), wait for CDP on 127.0.0.1:$CDP_PORT"
if [ "$DRY_RUN" = 1 ]; then
  say "dry run: all checks passed, nothing changed."
  exit 0
fi
if [ -z "${TMUX:-}${STY:-}" ] && [ "$TTY_GUARD" = 1 ]; then
  fail "run this inside tmux or screen (a dropped SSH session mid-run would leave prod down until the deadman fires); --no-tty-guard overrides"
fi
for b in "$SYSTEMD_RUN" "$SYSTEMCTL"; do command -v "$b" >/dev/null 2>&1 || fail "'$b' not found: the deadman needs systemd (user)"; done

# CDP Browser.close on 127.0.0.1:<port> (a raw WebSocket; python3 only).
cdp_close() {
  timeout 10 python3 - "$1" <<'PY' >/dev/null 2>&1
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

# ---- the deadman (out of process) ------------------------------------------------
# A detached transient systemd unit. When it fires:
#   - finished ("done", "rolled-back", "replaced" in $BACKUP/state): nothing;
#   - the run itself is still alive (its pid in $BACKUP/pid): SIGTERM it, so its
#     own rollback runs, and wait up to 120 s for it;
#   - then only if the container there is still the OLD one (its image) and not
#     running: restore the restart policy and start it. "fired" is written only
#     when the start worked; a failure writes "start-failed" (the next run
#     refuses until it is resolved) and is logged: journalctl --user -u <unit>.
# It needs the user's systemd manager to outlive the SSH session: enable
# lingering for the operator (loginctl enable-linger), as on the lab hosts.
arm_deadman() {
  local dm="$BACKUP/deadman.sh" dockerbin
  dockerbin="$(command -v "$DOCKER")"
  {
    echo '#!/bin/sh'
    echo "# crow-browser profile migration deadman for $CONTAINER (armed $STAMP)"
    echo "grep -qxE 'done|rolled-back|replaced' '$BACKUP/state' 2>/dev/null && exit 0"
    echo "pid=\"\$(cat '$BACKUP/pid' 2>/dev/null)\""
    echo "if [ -n \"\$pid\" ] && kill -0 \"\$pid\" 2>/dev/null && grep -q browser-profile-to-volume \"/proc/\$pid/cmdline\" 2>/dev/null; then"
    echo "  echo \"deadman: the migration (pid \$pid) is still running at the deadline: stopping it so its own rollback runs\" >&2"
    echo "  kill -TERM \"\$pid\""
    echo "  i=0; while kill -0 \"\$pid\" 2>/dev/null && [ \$i -lt 120 ]; do sleep 1; i=\$((i+1)); done"
    echo "  grep -qxE 'done|rolled-back|replaced' '$BACKUP/state' 2>/dev/null && exit 0"
    echo "fi"
    echo "img=\"\$('$dockerbin' inspect '$CONTAINER' --format '{{.Image}}' 2>/dev/null)\""
    echo "run=\"\$('$dockerbin' inspect '$CONTAINER' --format '{{.State.Running}}' 2>/dev/null)\""
    echo "[ \"\$img\" = '$IMAGE' ] || exit 0"
    echo "[ \"\$run\" = true ] && exit 0"
    echo "'$dockerbin' update --restart='$POLICY' '$CONTAINER'"
    echo "if '$dockerbin' start '$CONTAINER'; then"
    echo "  '$dockerbin' rmi '$NEXT_TAG' >/dev/null 2>&1"
    echo "  echo fired > '$BACKUP/state'"
    echo "  echo \"deadman: restarted the old container $CONTAINER\" >&2"
    echo "else"
    echo "  echo start-failed > '$BACKUP/state'"
    echo "  echo \"deadman: could NOT start $CONTAINER: docker start $CONTAINER\" >&2"
    echo "  exit 1"
    echo "fi"
  } > "$dm"
  chmod 700 "$dm"
  "$SYSTEMD_RUN" --user --quiet --collect --unit="$DEADMAN_UNIT" --on-active="${CROW_MIGRATE_DEADMAN_SECS:-900}s" /bin/sh "$dm" \
    || { echo "cannot arm the deadman ($SYSTEMD_RUN)" >&2; return 1; }
  DEADMAN_ARMED=1
}
disarm_deadman() {
  { echo "$1" > "$BACKUP/state"; } 2>/dev/null
  if [ "$DEADMAN_ARMED" = 1 ]; then "$SYSTEMCTL" --user stop "${DEADMAN_UNIT}.timer" >/dev/null 2>&1; fi
  DEADMAN_ARMED=0
  return 0
}

# ---- rollback until the new container is up ----------------------------------
STAGE=start RETAGGED=0 POLICY_CHANGED=0 CREATED_VOLUME=0 DEADMAN_ARMED=0
# Every rollback message tolerates a dead terminal (EPIPE/EIO after a dropped
# SSH session) and is also kept in $BACKUP/rollback.log.
note() {
  echo "[profile-to-volume] $*" >&2 2>/dev/null || true
  if [ -d "$BACKUP" ]; then { echo "[profile-to-volume] $*" >> "$BACKUP/rollback.log"; } 2>/dev/null || true; fi
}
cleanup_hint() {
  if [ -d "$BACKUP" ]; then
    note "backup kept: $BACKUP (holds the cookies, effectively unencrypted); delete it once you are sure: $0 --delete-backup $BACKUP"
  fi
  note "previous image kept: $PREV_TAG; remove it when no longer needed: docker rmi $PREV_TAG"
}
rollback() {
  local code=$?
  set +e
  trap - EXIT
  trap '' INT TERM HUP PIPE      # a second Ctrl-C or HUP must not cut the rollback short
  [ "$STAGE" = done ] && exit "$code"
  [ "$STAGE" = start ] && exit "$code"
  note "FAILED or interrupted during '$STAGE': putting things back"
  if [ "$STAGE" = recreate ]; then
    if [ "$("$DOCKER" inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null)" != "$IMAGE" ]; then
      note "the recreate already replaced the old container. NOT rolling back automatically."
      note "the profile is in volume $VOLUME and $BACKUP/profile.tar; the old image is $PREV_TAG;"
      note "the old bundle files are in $BACKUP/bundle-files. Retry: cd $BUNDLE_DIR && CROW_HOME=$INSTANCE_HOME docker compose -p $PROJECT up -d --no-build"
      disarm_deadman replaced
      note "the deadman ($DEADMAN_UNIT) is disarmed: if you recover by hand with the old image, nothing restarts it behind you."
      cleanup_hint
      exit 1
    fi
  fi
  if [ -d "$BACKUP/bundle-files" ]; then
    for f in docker-compose.yml entrypoint.sh Dockerfile .dockerignore .env; do
      if [ -e "$BACKUP/bundle-files/$f" ]; then cp -p "$BACKUP/bundle-files/$f" "$BUNDLE_DIR/$f"; fi
    done
  fi
  if [ "$CREATED_VOLUME" = 1 ] && "$DOCKER" volume inspect "$VOLUME" >/dev/null 2>&1; then
    if "$DOCKER" volume rm "$VOLUME" >/dev/null 2>&1; then note "removed the volume this run created ($VOLUME)"
    else note "could not remove $VOLUME: remove it before any later 'compose up': docker volume rm $VOLUME"; fi
  fi
  if [ "$RETAGGED" = 1 ]; then "$DOCKER" tag "$IMAGE" "$BUILD_NAME" >/dev/null 2>&1; fi
  "$DOCKER" rmi "$NEXT_TAG" >/dev/null 2>&1
  if [ "$POLICY_CHANGED" = 1 ]; then "$DOCKER" update --restart="$POLICY" "$CONTAINER" >/dev/null 2>&1; fi
  local started=1
  if [ "$WAS_RUNNING" = "true" ]; then
    if "$DOCKER" start "$CONTAINER" >/dev/null 2>&1; then note "the old container '$CONTAINER' is running again, unchanged"
    else started=0; note "could not start '$CONTAINER' again: docker start $CONTAINER (the deadman stays armed and retries)"; fi
  fi
  [ "$started" = 1 ] && disarm_deadman rolled-back
  cleanup_hint
  exit 1
}
trap rollback EXIT
trap 'exit 130' INT TERM HUP
trap '' PIPE
set -e

# ---- 2. keep the old image ---------------------------------------------------
STAGE=tag
"$DOCKER" tag "$IMAGE" "$PREV_TAG"
say "old image tagged $PREV_TAG"

# ---- 3. build first, while the old container still serves ---------------------
STAGE=build
"$DOCKER" build -t "$NEXT_TAG" "$SOURCE"
say "new image built ($NEXT_TAG)."

# ---- 3b. the deadman, before anything takes prod down ---------------------------
STAGE=deadman
mkdir -p "$BACKUP"
chmod 700 "$INSTANCE_HOME/browser-profile-backup" "$BACKUP"
echo armed > "$BACKUP/state"
arm_deadman
echo "$$" > "$BACKUP/pid"
say "deadman armed: $DEADMAN_UNIT (${CROW_MIGRATE_DEADMAN_SECS:-900}s; its log: journalctl --user -u ${DEADMAN_UNIT}.service)"

# ---- 4. a graceful stop: Chromium flushes cookies and logins first ------------
STAGE=stop
POLICY_CHANGED=1   # before the change: restoring the original policy is harmless either way
"$DOCKER" update --restart=no "$CONTAINER" >/dev/null
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
( umask 077; "$DOCKER" cp "$CONTAINER:$PROFILE_DIR" - > "$BACKUP/profile.tar" )
[ -s "$BACKUP/profile.tar" ] || { echo "empty profile backup" >&2; false; }
FIRST="$(tar -tf "$BACKUP/profile.tar" | sed -n 1p)"
[[ "$FIRST" == chromium-crow/* ]] || { echo "unexpected backup layout" >&2; false; }
mkdir -p "$BACKUP/bundle-files"
for f in docker-compose.yml entrypoint.sh Dockerfile .dockerignore .env; do
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
CREATED_VOLUME=1   # before the create (step 1 proved it absent; the rollback checks it exists)
"$DOCKER" volume create --label "com.docker.compose.project=$PROJECT" --label "com.docker.compose.volume=$VOLUME_KEY" --label crow.bundle=browser "$VOLUME" >/dev/null
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
if [ -f "$SOURCE/.dockerignore" ]; then cp "$SOURCE/.dockerignore" "$BUNDLE_DIR/.dockerignore"; fi
if ! grep -q '^CROW_BROWSER_VNC_TOKEN=.\{32,\}' "$ENV_FILE"; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  sed -i '/^CROW_BROWSER_VNC_TOKEN=/d' "$ENV_FILE"
  printf 'CROW_BROWSER_VNC_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
  unset TOKEN
  say "added CROW_BROWSER_VNC_TOKEN to $ENV_FILE (not printed)"
fi
chmod 600 "$ENV_FILE"
RETAGGED=1
"$DOCKER" tag "$NEXT_TAG" "$BUILD_NAME"
STAGE=recreate
say "recreating $CONTAINER with the new compose (no rebuild)..."
( cd "$BUNDLE_DIR" && CROW_HOME="$INSTANCE_HOME" "$DOCKER" compose -p "$PROJECT" up -d --no-build --force-recreate )
STAGE=done
trap - EXIT INT TERM HUP
set +e
disarm_deadman done
"$DOCKER" rmi "$NEXT_TAG" >/dev/null 2>&1   # the tag only: the image is $BUILD_NAME now
say "deadman disarmed."

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
