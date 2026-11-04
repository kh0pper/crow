#!/usr/bin/env bash
# browser-cdp-gate.sh — move one installed crow-browser onto the CDP gate (bundle 1.5.0):
# Chromium on a pipe, and a token-gated relay on 127.0.0.1:${CROW_BROWSER_CDP_PORT}.
#
# A version bump alone does NOT refresh a docker bundle's compose file, entrypoint,
# Dockerfile or relay (manifest.refreshFiles only copies CODE into the installed bundle;
# the running container keeps the old image), so this script is the switch. Run it per
# instance, in tmux/screen, in a registered maintenance window. Recreating the container
# is a prod restart of the browser (the profile volume survives; the open page does not).
#
#   scripts/ops/browser-cdp-gate.sh <crow-home> <compose-project> \
#     --from-sha <git sha before this change> [--dry-run] [--no-tty-guard]
#
# Steps (all checks first; nothing changes before the backup exists):
#   1. checks: <crow-home>/bundles/browser exists with a .env; four source files present;
#      `--from-sha` really is a pre-gate tree (its entrypoint still starts Chromium with
#      --remote-debugging-port); if the container is running, it belongs to <compose-project>.
#   2. backup, mode 700, under <crow-home>/browser-cdp-gate-backup/<stamp>/:
#      `pre/` = the four files at --from-sha (git show, NOT the installed copy — an
#      install may already be stale), `installed/` = what is installed right now, `.env`.
#   3. copy the four new files into the installed bundle dir.
#   4. mint CROW_BROWSER_CDP_TOKEN into the bundle .env (and the retained copy) when it is
#      absent, through the same generator PR 1 uses; atomic, mode 600, never printed.
#   5. docker compose -p <project> up -d --build --force-recreate.
#   6. verify: GET /json/version without a token -> 401; with the token -> 200 (the header
#      travels in a 0600 file read by `curl -H @file`, never on a command line); and the
#      token appears in no /proc/<pid>/cmdline and in no `docker inspect` output (only
#      "found"/"not found" is printed).
#   7. print the exact rollback commands.
# --dry-run prints the plan and changes nothing (it does not need docker or git).
#
# Test seams: DOCKER (the docker binary), CURL, GIT, CROW_GATE_NOW (the timestamp).
set -uo pipefail

DOCKER="${DOCKER:-docker}"
CURL="${CURL:-curl}"
GIT="${GIT:-git}"
SERVICE=crow-browser
KEY=CROW_BROWSER_CDP_TOKEN
FILES=(docker-compose.yml Dockerfile entrypoint.sh cdp-relay.mjs)

say() { echo "[crow-cdp-gate] $*"; }
fail() { echo "[crow-cdp-gate] REFUSED: $*" >&2; exit 1; }
usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

INSTANCE_HOME="" PROJECT="" FROM_SHA="" DRY_RUN=0 TTY_GUARD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --from-sha) FROM_SHA="${2:-}"; [ -n "$FROM_SHA" ] || usage; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-tty-guard) TTY_GUARD=0; shift ;;
    -h|--help) usage ;;
    --*) echo "unknown argument: $1" >&2; usage ;;
    *)
      if [ -z "$INSTANCE_HOME" ]; then INSTANCE_HOME="$1"
      elif [ -z "$PROJECT" ]; then PROJECT="$1"
      else echo "unexpected argument: $1" >&2; usage; fi
      shift ;;
  esac
done
[ -n "$INSTANCE_HOME" ] && [ -n "$PROJECT" ] || usage

[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || fail "<compose-project> '$PROJECT' is not a compose project name"
INSTANCE_HOME="$(cd "$INSTANCE_HOME" 2>/dev/null && pwd -P)" || fail "<crow-home> is not a directory"
BUNDLE_DIR="$INSTANCE_HOME/bundles/browser"
ENV_FILE="$BUNDLE_DIR/.env"
REPO="$(cd "$(dirname "$0")/../.." && pwd -P)" || fail "cannot resolve this checkout"
SOURCE="$REPO/bundles/browser"

[ -d "$BUNDLE_DIR" ] || fail "$BUNDLE_DIR does not exist: is the browser bundle installed in this instance?"
[ -f "$ENV_FILE" ] || fail "no $ENV_FILE: the bundle is not configured in this instance"
for f in "${FILES[@]}"; do
  [ -f "$SOURCE/$f" ] || fail "this checkout has no bundles/browser/$f (run it from a checkout of the change)"
done
[ -x "$SOURCE/entrypoint.sh" ] || say "note: $SOURCE/entrypoint.sh is not executable; it will be installed 755"

CDP_PORT="$(sed -n 's/^CROW_BROWSER_CDP_PORT=\([0-9]\{1,5\}\)$/\1/p' "$ENV_FILE" | tail -n 1)"
CDP_PORT="${CDP_PORT:-9222}"
STAMP="${CROW_GATE_NOW:-$(date +%Y%m%d-%H%M%S)}"
BACKUP="$INSTANCE_HOME/browser-cdp-gate-backup/$STAMP"

have() { command -v "$1" >/dev/null 2>&1; }

# ---- --dry-run: the plan, then nothing -------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "plan (dry run — nothing will be changed)"
  say "  instance:      $INSTANCE_HOME"
  say "  bundle dir:    $BUNDLE_DIR"
  say "  compose -p:    $PROJECT (service $SERVICE)"
  say "  source:        $SOURCE"
  say "  pre-PR-2 sha:  ${FROM_SHA:-<none given: a real run needs --from-sha>}"
  say "  backup dir:    $BACKUP (mode 700)"
  say "  would copy:    ${FILES[*]}"
  say "  would mint:    $KEY into $ENV_FILE when absent (atomic, mode 600, never printed)"
  say "  would run:     ( cd $BUNDLE_DIR && docker compose -p $PROJECT up -d --build --force-recreate )"
  say "  would verify:  GET http://127.0.0.1:$CDP_PORT/json/version -> 401 without a token;"
  say "                 with the token (curl -H @<0600 file>) -> 200;"
  say "                 no token in /proc/<pid>/cmdline or in docker inspect (found/not found only)"
  say "  would print:   the exact rollback commands"
  if [ -n "$FROM_SHA" ]; then
    if ! have "$GIT"; then say "  note: git is not available here, so --from-sha cannot be checked in this run"
    elif ! "$GIT" -C "$REPO" cat-file -e "$FROM_SHA:bundles/browser/entrypoint.sh" 2>/dev/null; then
      fail "--from-sha '$FROM_SHA' has no bundles/browser/entrypoint.sh in $REPO"
    fi
  fi
  say "dry run: all values above are the plan; nothing changed."
  exit 0
fi

# ---- 1. checks -------------------------------------------------------------
[ -n "$FROM_SHA" ] || fail "--from-sha <sha before the CDP gate> is required: the backup must come from git, not from the installed copy (an install may be stale)"
have "$GIT" || fail "git is not available: --from-sha cannot be read"
"$GIT" -C "$REPO" cat-file -e "$FROM_SHA:bundles/browser/entrypoint.sh" 2>/dev/null \
  || fail "--from-sha '$FROM_SHA' has no bundles/browser/entrypoint.sh in $REPO"
# The sha must be a PRE-gate tree, or the "backup" would be the new files.
if ! "$GIT" -C "$REPO" show "$FROM_SHA:bundles/browser/entrypoint.sh" 2>/dev/null | grep -q -- '--remote-debugging-port'; then
  fail "--from-sha '$FROM_SHA' is not a pre-CDP-gate tree (its entrypoint has no Chromium --remote-debugging-port): pick the commit before this change"
fi
have "$DOCKER" || fail "no '$DOCKER': this needs Docker Compose to recreate the container"
have "$CURL" || fail "no '$CURL': the verification step needs curl"
CV="$("$DOCKER" compose version --short 2>/dev/null | sed 's/^v//')"
[ -n "$CV" ] || fail "cannot run '$DOCKER compose version'"
[ "$(printf '%s\n%s\n' 2.23.1 "$CV" | sort -V | head -n 1)" = "2.23.1" ] \
  || fail "Docker Compose $CV is older than 2.23.1 (the compose's token file needs it)"
CONTAINER="$("$DOCKER" inspect "$SERVICE" --format '{{.Name}}' 2>/dev/null | sed 's|^/||')"
if [ -n "$CONTAINER" ]; then
  [ "$CONTAINER" = "$SERVICE" ] || fail "'$SERVICE' resolves to another container"
  OWNER="$("$DOCKER" inspect "$SERVICE" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)"
  [ "$OWNER" = "$PROJECT" ] \
    || fail "container '$SERVICE' belongs to compose project '$OWNER', not '$PROJECT': refusing to recreate another instance's browser"
  say "container $CONTAINER belongs to project $PROJECT."
else
  say "note: no container named '$SERVICE' right now; the recreate will create it."
fi
# Was the old ufw rule opened for 9222? The new manifest drops that port; say how to remove it.
UFW_NOTE=""
if have ufw && ufw status 2>/dev/null | grep -q '9222'; then
  UFW_NOTE="sudo ufw delete allow from 100.64.0.0/10 to any port 9222 proto tcp"
fi

if [ -z "${TMUX:-}${STY:-}" ] && [ "$TTY_GUARD" = 1 ]; then
  fail "run this inside tmux or screen (a dropped SSH session mid-run would leave prod half-switched); --no-tty-guard overrides"
fi

say "instance:   $INSTANCE_HOME"
say "bundle dir: $BUNDLE_DIR"
say "project:    $PROJECT (CDP relay on 127.0.0.1:$CDP_PORT)"
say "backup:     $BACKUP (pre-PR-2 files from $FROM_SHA, plus what is installed now)"
say "then:       copy the four files, mint $KEY if absent, recreate the container, verify."

# ---- rollback: put the installed files back if anything below fails ----------
STAGE=prepare
TMPDIR_GATE=""
on_exit() {
  local code=$?
  trap - EXIT
  set +e
  [ -n "$TMPDIR_GATE" ] && rm -rf "$TMPDIR_GATE"
  [ "$STAGE" = done ] && exit "$code"
  echo "[crow-cdp-gate] FAILED or interrupted during '$STAGE'" >&2
  if [ -n "$BACKUP" ] && [ -d "$BACKUP/installed" ]; then
    for f in "${FILES[@]}"; do
      if [ -e "$BACKUP/installed/$f" ]; then cp -p "$BACKUP/installed/$f" "$BUNDLE_DIR/$f"; else rm -f "$BUNDLE_DIR/$f"; fi
    done
    echo "[crow-cdp-gate] the four files are back as they were installed before this run." >&2
  fi
  case "$STAGE" in
    recreate|recreated|verify)
      echo "[crow-cdp-gate] the container may have been recreated already: bring it back from the restored files," >&2
      echo "[crow-cdp-gate] or leave the new image running and fix the cause first. Either way, inspect: $DOCKER logs $SERVICE" >&2
      echo "[crow-cdp-gate]   cd $BUNDLE_DIR && CROW_HOME=$INSTANCE_HOME $DOCKER compose -p $PROJECT up -d --build --force-recreate" >&2 ;;
    *)
      echo "[crow-cdp-gate] the container was not recreated; nothing to restart." >&2 ;;
  esac
  echo "[crow-cdp-gate] backup kept: $BACKUP" >&2
  exit 1
}
trap on_exit EXIT
set -e

# ---- 2. backup -------------------------------------------------------------
STAGE=backup
mkdir -p "$BACKUP/pre" "$BACKUP/installed"
chmod 700 "$INSTANCE_HOME/browser-cdp-gate-backup" "$BACKUP"
for f in "${FILES[@]}"; do
  "$GIT" -C "$REPO" show "$FROM_SHA:bundles/browser/$f" > "$BACKUP/pre/$f" 2>/dev/null \
    || fail "--from-sha '$FROM_SHA' has no bundles/browser/$f"
  if [ -e "$BUNDLE_DIR/$f" ]; then cp -p "$BUNDLE_DIR/$f" "$BACKUP/installed/$f"; fi
done
( umask 077; cp -p "$ENV_FILE" "$BACKUP/.env" )
say "backup written: $BACKUP (pre/ from git, installed/ from this host, .env)"

# ---- 3. the new files ------------------------------------------------------
STAGE=copy
for f in "${FILES[@]}"; do
  case "$f" in
    entrypoint.sh) install -m 755 "$SOURCE/$f" "$BUNDLE_DIR/$f" ;;
    *) cp "$SOURCE/$f" "$BUNDLE_DIR/$f" ;;
  esac
done
say "installed: ${FILES[*]}"

# ---- 4. the token (minted through the gateway's own mint; never printed) -----
STAGE=mint
node --input-type=module -e '
  const [repo, destDir, crowHome] = process.argv.slice(-3);
  const { readFileSync } = await import("node:fs");
  const { mintMissingFlaggedKeys } = await import(repo + "/servers/gateway/bundle-env-secrets.js");
  const manifest = JSON.parse(readFileSync(repo + "/bundles/browser/manifest.json", "utf8"));
  const out = mintMissingFlaggedKeys("browser", manifest, { destDir, crowHome, log: (m) => console.log("[crow-cdp-gate] " + m) });
  if (out === null) process.exit(1);
' -- "$REPO" "$BUNDLE_DIR" "$INSTANCE_HOME" \
  || fail "could not mint $KEY (see above): the .env is unchanged, fix and rerun"
chmod 600 "$ENV_FILE"
grep -qE "^${KEY}=[A-Za-z0-9_-]{32,256}$" "$ENV_FILE" \
  || fail "$ENV_FILE has no well-formed $KEY after the mint: the container would refuse to start"

# ---- 5. recreate -----------------------------------------------------------
STAGE=recreate
say "recreating $SERVICE with the new compose (this restarts the browser)..."
( cd "$BUNDLE_DIR" && CROW_HOME="$INSTANCE_HOME" "$DOCKER" compose -p "$PROJECT" up -d --build --force-recreate )
STAGE=recreated

# ---- 6. verify -------------------------------------------------------------
# The token never reaches a command line: curl reads the header from a 0600 file,
# and grep reads the pattern from a 0600 file (`-f`), so neither argv nor `ps` sees it.
STAGE=verify
TMPDIR_GATE="$(mktemp -d)"
chmod 700 "$TMPDIR_GATE"
TOK="$TMPDIR_GATE/token"
HDR="$TMPDIR_GATE/header"
( umask 077
  TOKEN="$(sed -n "s/^${KEY}=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r\n')"
  printf '%s\n' "$TOKEN" > "$TOK"
  printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HDR"
  unset TOKEN )

ok=0
for i in $(seq 1 "${CROW_GATE_CDP_WAIT:-90}"); do
  code="$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$CDP_PORT/json/version" || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || fail "nothing answers on 127.0.0.1:$CDP_PORT after 90s: $DOCKER logs $SERVICE"

UNAUTH="$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$CDP_PORT/json/version" || true)"
AUTH="$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 -H "@$HDR" "http://127.0.0.1:$CDP_PORT/json/version" || true)"
say "unauthenticated /json/version -> $UNAUTH"
say "with the token           -> $AUTH"

# No token anywhere it must not be. Only "found"/"not found" is printed.
FOUND_ARGV=0
for pid in /proc/[0-9]*; do
  [ -r "$pid/cmdline" ] || continue
  if tr '\0' ' ' < "$pid/cmdline" 2>/dev/null | grep -qFf "$TOK" 2>/dev/null; then FOUND_ARGV=1; break; fi
done
INSPECT_FOUND=0
if "$DOCKER" inspect "$SERVICE" 2>/dev/null | grep -qFf "$TOK" 2>/dev/null; then INSPECT_FOUND=1; fi
say "token in any /proc/<pid>/cmdline: $([ "$FOUND_ARGV" = 1 ] && echo found || echo 'not found')"
say "token in docker inspect output:   $([ "$INSPECT_FOUND" = 1 ] && echo found || echo 'not found')"
LOGS_FOUND=0
if "$DOCKER" logs "$SERVICE" 2>&1 | grep -qFf "$TOK" 2>/dev/null; then LOGS_FOUND=1; fi
say "token in the container log:       $([ "$LOGS_FOUND" = 1 ] && echo found || echo 'not found')"
rm -rf "$TMPDIR_GATE"
TMPDIR_GATE=""

STAGE=done
trap - EXIT

VERDICT=ok
[ "$UNAUTH" = "401" ] || VERDICT=failed
[ "$AUTH" = "200" ] || VERDICT=failed
[ "$FOUND_ARGV$INSPECT_FOUND$LOGS_FOUND" = "000" ] || VERDICT=failed
if [ "$VERDICT" = ok ]; then
  say "verified: the relay refuses an unauthenticated request, answers with the token, and the token is nowhere it must not be."
else
  say "VERIFICATION INCOMPLETE — expected 401/200 above and 'not found' three times."
fi
[ -n "$UFW_NOTE" ] && say "the old install's ufw rule for 9222 is still there; it is no longer needed: $UFW_NOTE"

say "rollback, exactly:"
say "  cp -p $BACKUP/pre/docker-compose.yml $BUNDLE_DIR/docker-compose.yml"
say "  cp -p $BACKUP/pre/Dockerfile         $BUNDLE_DIR/Dockerfile"
say "  install -m 755 $BACKUP/pre/entrypoint.sh $BUNDLE_DIR/entrypoint.sh"
say "  rm -f $BUNDLE_DIR/cdp-relay.mjs"
say "  cd $BUNDLE_DIR && CROW_HOME=$INSTANCE_HOME docker compose -p $PROJECT up -d --build --force-recreate"
say "A public install rolls FORWARD instead: a later bundle version that reverts these files, because"
say "the installed manifest already says 1.5.0 and a hand-restored compose would be replaced by the"
say "next refresh of manifest.refreshFiles."
say "backup kept: $BACKUP (it holds a copy of .env, so treat it as a secret; delete it once you are sure)"
[ "$VERDICT" = ok ] || exit 1
say "done."