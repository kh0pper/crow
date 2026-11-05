#!/usr/bin/env bash
#
# install-boot-guard.sh — wire the crash-loop rollback guard into this host's
# Crow gateway units (audit N1c-3, Layer 1). Idempotent; never restarts a unit.
#
# For each crow-*gateway*.service it writes ONE drop-in
# (<unit>.d/10-boot-guard.conf) that runs the launcher copy installed in
# CROW_HOME before every start and after every stop, and it copies the launcher
# from THIS checkout into <CROW_HOME>/boot-guard/.
#
# System units (default, needs sudo):
#   /etc/systemd/system/<unit>.d/10-boot-guard.conf
# User units (--user, no sudo):
#   ~/.config/systemd/user/<unit>.d/10-boot-guard.conf
#
# The launcher must run from OUTSIDE the checkout: the commit it is about to
# judge cannot be trusted to run it. So the drop-in never names the tree's copy.
#
# Run this from a checkout you know is good (a stable sha): the copy it installs
# is the one that keeps watching until a gateway has been stable for ten minutes
# and refreshes it from its own commit.
#
# Flags:
#   --dry-run   print every action, write nothing, never call systemctl
#   --user      ~/.config/systemd/user, no sudo
#
# Env test seams: CROW_SYSTEMD_UNIT_DIR / CROW_SYSTEMD_USER_UNIT_DIR override the
# two unit directories (used with --dry-run against fixture units).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCHER_SRC="$REPO_ROOT/scripts/boot-guard/crow-boot-guard.mjs"

# node:sqlite landed in 22.13; the launcher reads the schema through it.
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13
DEFAULT_CROW_HOME="${HOME}/.crow"
DROPIN_NAME="10-boot-guard.conf"

usage() {
  cat <<'EOF'
usage: install-boot-guard.sh [--user] [--dry-run]

  (no flag)   write /etc/systemd/system/<unit>.d/10-boot-guard.conf for every
              crow-*gateway*.service (needs sudo)
  --user      write ~/.config/systemd/user/<unit>.d/10-boot-guard.conf
  --dry-run   print what would change; write nothing, restart nothing
EOF
}

MODE=system
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --user) MODE=user ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help|-help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }

if [ ! -f "$LAUNCHER_SRC" ]; then
  note "error: $LAUNCHER_SRC is missing — run this from a Crow checkout"
  exit 1
fi

if [ "$MODE" = "user" ]; then
  UNIT_DIR="${CROW_SYSTEMD_USER_UNIT_DIR:-${HOME}/.config/systemd/user}"
  SUDO=()
else
  UNIT_DIR="${CROW_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
  if [ "$(id -u)" -ne 0 ]; then SUDO=(sudo); else SUDO=(); fi
fi

# Under sudo, $HOME is root's: the launcher copy and the default CROW_HOME belong
# to the account that runs the gateway, not to root.
OPERATOR_HOME="${HOME}"
if [ -n "${SUDO_USER:-}" ] && [ "$MODE" = "system" ]; then
  OPERATOR_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)"
  [ -n "$OPERATOR_HOME" ] || OPERATOR_HOME="${HOME}"
fi
DEFAULT_CROW_HOME="${OPERATOR_HOME}/.crow"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    local IFS=' '
    say "would run: $*"
    return 0
  fi
  if [ "${#SUDO[@]}" -gt 0 ]; then
    "${SUDO[@]}" "$@"
  else
    "$@"
  fi
}

# The LAST value of a key in a unit file (systemd: later assignments win).
unit_value() { # <file> <key>
  sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -n 1
}

# Every token of every Environment= line, one per line, unquoted.
unit_env_tokens() { # <file>
  local line tok
  while IFS= read -r line; do
    for tok in $line; do
      tok="${tok%\"}"; tok="${tok#\"}"
      printf '%s\n' "$tok"
    done
  done < <(sed -n 's/^[[:space:]]*Environment=//p' "$1")
}

unit_env_value() { # <file> <KEY>
  unit_env_tokens "$1" | sed -n "s/^$2=//p" | tail -n 1
}

expand_specifiers() { # <value> <home>
  local v="$1" h="$2"
  v="${v//%h/$h}"
  printf '%s\n' "$v"
}

# ExecStart's argv[0] when it is node; otherwise the first node on the unit's
# Environment=PATH (an `npm run gateway` unit has no node in ExecStart).
resolve_node() { # <execstart> <unit-path-env>
  local execstart first dirs d candidate
  execstart="${1#-}"
  first="${execstart%% *}"
  if [ "$(basename "$first")" = "node" ]; then
    if [ -x "$first" ]; then printf '%s\n' "$first"; return 0; fi
    if command -v "$first" >/dev/null 2>&1; then command -v "$first"; return 0; fi
  fi
  local paths="${2:-}"
  [ -n "$paths" ] || paths="$PATH"
  IFS=':' read -r -a dirs <<< "$paths"
  for d in "${dirs[@]}"; do
    [ -n "$d" ] || continue
    candidate="$d/node"
    if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

node_version_ok() { # <node>
  local node="$1" v major minor rest
  [ -x "$node" ] || return 1
  v="$("$node" --version 2>/dev/null)" || return 1
  v="${v#v}"
  major="${v%%.*}"
  rest="${v#*.}"
  minor="${rest%%.*}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
  if [ "$major" -gt "$NODE_MIN_MAJOR" ]; then return 0; fi
  if [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]; then return 0; fi
  return 1
}

install_launcher() { # <crow_home> <owner>
  local crow_home="$1" owner="${2:-}" dir file tmp
  dir="$crow_home/boot-guard"
  file="$dir/crow-boot-guard.mjs"
  if [ "$DRY_RUN" = "1" ]; then
    say "would install: $file (dir 0700, file 0600)"
    return 0
  fi
  if [ ! -d "$dir" ]; then
    run mkdir -p "$dir"
    run chmod 700 "$dir"
    if [ -n "$owner" ]; then run chown "$owner" "$dir"; fi
  fi
  if [ -f "$file" ] && cmp -s "$LAUNCHER_SRC" "$file"; then
    say "launcher copy up to date: $file"
    return 0
  fi
  tmp="$file.tmp.$$"
  run cp "$LAUNCHER_SRC" "$tmp"
  run chmod 600 "$tmp"
  if [ -n "$owner" ]; then run chown "$owner" "$tmp"; fi
  run mv -f "$tmp" "$file"
  say "installed launcher copy: $file"
}

write_dropin() { # <path> <content>
  local path="$1" content="$2" dir tmp
  dir="$(dirname "$path")"
  if [ -f "$path" ] && [ "$(cat "$path")" = "$content" ]; then
    say "unchanged: $path"
    return 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would write: $path"
    say "----- $DROPIN_NAME -----"
    printf '%s\n' "$content"
    say "-------------------------"
    return 0
  fi
  run mkdir -p "$dir"
  tmp="$path.tmp.$$"
  printf '%s\n' "$content" > "$tmp"
  run cp "$tmp" "$path"
  rm -f "$tmp"
  run chmod 644 "$path"
  say "wrote: $path"
  return 0
}

# --- find the gateway units -------------------------------------------------
units=()
if [ -d "$UNIT_DIR" ]; then
  for f in "$UNIT_DIR"/crow-*gateway*.service; do
    [ -e "$f" ] || continue
    units+=("$(basename "$f")")
  done
fi

if [ "${#units[@]}" -eq 0 ]; then
  note "no crow-*gateway*.service units in $UNIT_DIR — nothing to do"
  exit 0
fi

say "repo root: $REPO_ROOT"
say "unit dir:  $UNIT_DIR"
say "launcher:  $LAUNCHER_SRC"
say "mode:      ${MODE}"
if [ "$DRY_RUN" = "1" ]; then say "dry run:   nothing will be written and systemctl is never called"; fi

changed=0
for unit in "${units[@]}"; do
  unit_file="$UNIT_DIR/$unit"
  working_dir="$(unit_value "$unit_file" "WorkingDirectory")"
  if [ -z "$working_dir" ]; then
    note "warning: $unit has no WorkingDirectory= — skipped"
    continue
  fi
  working_dir="$(expand_specifiers "$working_dir" "$OPERATOR_HOME")"

  exec_start="$(unit_value "$unit_file" "ExecStart")"
  if [ -z "$exec_start" ]; then
    note "warning: $unit has no ExecStart= — skipped"
    continue
  fi
  unit_path="$(unit_env_value "$unit_file" "PATH")"
  node="$(resolve_node "$exec_start" "$unit_path" || true)"
  if [ -z "$node" ]; then
    note "error: $unit: no node found (ExecStart argv[0] is not node, and its Environment=PATH has none)"
    exit 1
  fi
  if ! node_version_ok "$node"; then
    note "error: $unit: $node is older than ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} (the boot guard reads the schema through node:sqlite)"
    exit 1
  fi

  crow_home="$(unit_env_value "$unit_file" "CROW_HOME")"
  [ -n "$crow_home" ] || crow_home="$DEFAULT_CROW_HOME"
  crow_home="$(expand_specifiers "$crow_home" "$OPERATOR_HOME")"

  launcher="$crow_home/boot-guard/crow-boot-guard.mjs"
  unit_user=""
  if [ "$MODE" = "system" ]; then unit_user="$(unit_value "$unit_file" "User")"; fi

  say ""
  say "$unit"
  say "  node:       $node"
  say "  crow home:  $crow_home"
  say "  app root:   $working_dir"

  install_launcher "$crow_home" "$unit_user"

  content="# Installed by $REPO_ROOT/scripts/ops/install-boot-guard.sh
# Audit N1c-3 Layer 1: roll back an update that keeps crashing on startup.
# The launcher lives OUTSIDE this checkout, so the failing commit's own copy of
# it can never run. Both lines are prefixed with '-' so the guard can never stop
# the gateway from starting. TimeoutStartSec covers the guard's own npm install
# (up to 5 minutes) plus a rollback.
[Service]
ExecStartPre=-$node $launcher --app-root $working_dir
ExecStopPost=-$node $launcher --app-root $working_dir --record-exit
TimeoutStartSec=15min
Environment=CROW_BOOT_GUARD=1"

  if write_dropin "$UNIT_DIR/$unit.d/$DROPIN_NAME" "$content"; then changed=1; fi
done

if [ "$changed" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  if [ "$MODE" = "user" ]; then
    systemctl --user daemon-reload
  else
    run systemctl daemon-reload
  fi
  say "daemon-reload done — the drop-in takes effect at the next start (no unit was restarted)"
elif [ "$changed" = "0" ]; then
  say "nothing changed — no daemon-reload"
fi

say ""
say "Boot guard installed. Verify after the next start with:"
say "  systemd-analyze cat-config systemd/system/$DROPIN_NAME   # system units"
say "  systemctl --user show -p ExecStartPre crow-gateway       # user units"
say "  journalctl -u ${units[0]} | grep boot-guard"