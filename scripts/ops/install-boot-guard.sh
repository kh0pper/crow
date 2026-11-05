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
#   --dry-run   print every action, write nothing, restart nothing (the read-only
#               `systemctl show` reads still run — they change nothing)
#   --user      ~/.config/systemd/user, no sudo
#
# Env test seams: CROW_SYSTEMD_UNIT_DIR / CROW_SYSTEMD_USER_UNIT_DIR override the
# two unit directories, and CROW_SYSTEMCTL names the systemctl binary used for the
# merged `show` read (both used by the tests against fixture units).

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

# The systemctl binary to ask for the MERGED unit values. Overridable so the
# tests can drive a fixture unit tree without a running systemd.
SYSTEMCTL="${CROW_SYSTEMCTL:-systemctl}"

# Temp files that must never be left behind (a failed run must not litter /tmp
# with drop-in bodies).
TMPFILES=()
cleanup_tmpfiles() {
  local f
  for f in ${TMPFILES[@]+"${TMPFILES[@]}"}; do [ -n "$f" ] && rm -f "$f"; done
  return 0
}
trap cleanup_tmpfiles EXIT

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

# The LAST value of a key in a unit file (systemd: later assignments win). Used
# only when systemctl cannot answer for a unit (no systemd, e.g. a container):
# reading only the main unit file misses every drop-in and EnvironmentFile=.
unit_value() { # <file> <key>
  sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -n 1
}

# Split ONE Environment= value into tokens the way systemd does: whitespace
# separates tokens, double quotes group them (and are removed), and the escapes
# \" \\ and \xHH stand for a quote, a backslash and one byte. systemd merges
# every Environment= line of the unit AND its drop-ins into ONE such line, so
# `Environment="CROW_HOME=/srv/crow home"` must yield one token, not two.
env_tokens() { # <value string>
  local s="$1" n=${#1} i=0 c nxt hex out="" q=0 tab
  tab="$(printf '\t')"
  while [ "$i" -lt "$n" ]; do
    c="${s:$i:1}"
    if [ "$c" = "\\" ]; then
      i=$((i + 1))
      [ "$i" -lt "$n" ] || break
      nxt="${s:$i:1}"
      case "$nxt" in
        '"') out+='"' ;;
        "\\") out+="\\" ;;
        x)
          hex="${s:$((i + 1)):2}"
          case "$hex" in
            [0-9a-fA-F][0-9a-fA-F])
              out+="$(printf '%b' "\\x${hex}")"
              i=$((i + 2))
              ;;
            *) out+='x' ;;
          esac
          ;;
        *) out+="$nxt" ;;
      esac
    elif [ "$c" = '"' ]; then
      q=$((1 - q))
    elif [ "$q" -eq 0 ] && { [ "$c" = ' ' ] || [ "$c" = "$tab" ]; }; then
      if [ -n "$out" ]; then printf '%s\n' "$out"; out=""; fi
    else
      out+="$c"
    fi
    i=$((i + 1))
  done
  if [ -n "$out" ]; then printf '%s\n' "$out"; fi
  return 0
}

# Every token of every Environment= line of a unit FILE, one per line (the
# fallback path, for a host where systemd cannot answer for the unit).
unit_env_tokens() { # <file>
  local line
  while IFS= read -r line; do
    env_tokens "$line"
  done < <(sed -n 's/^[[:space:]]*Environment=//p' "$1")
}

unit_env_value() { # <file> <KEY>
  unit_env_tokens "$1" | sed -n "s/^$2=//p" | tail -n 1
}

# Quote one argument for an Exec= line: a path may contain spaces, and a literal
# % is a systemd specifier (%% writes one).
sd_quote() { # <arg>
  local s="$1"
  s="${s//%/%%}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# ONE `systemctl [--user] show -p <Property> --value <unit>` call PER PROPERTY:
# the values systemd actually merged from the unit AND every drop-in (audit L1
# fix 5c). systemctl prints the properties in ITS order — ExecStart comes from
# the service table and is printed before the exec-context fields (Environment,
# WorkingDirectory, User) — whatever order the -p flags were given in, so asking
# for several at once and assigning them by line number gives every variable its
# neighbour's value. Read-only: safe to call in a dry run.
systemctl_prop() { # <unit> <Property>
  local out
  if [ "$MODE" = "user" ]; then
    out="$("$SYSTEMCTL" --user show -p "$2" --value "$1" 2>/dev/null)" || return 1
  else
    out="$("$SYSTEMCTL" show -p "$2" --value "$1" 2>/dev/null)" || return 1
  fi
  printf '%s\n' "$out"
}

# One field of systemctl's ExecStart struct, which runs up to ` ; `:
#   { path=/usr/bin/node ; argv[]=/usr/bin/node x.js ; ignore_errors=no ; … }
# A path containing a space is NOT quoted inside argv[] (systemd joins argv with
# spaces), so `path=` is the only unambiguous source for the program there.
exec_start_field() { # <execstart> <field-sed-regex>
  printf '%s' "$1" | sed -n "s/.*$2=\([^;]*\).*/\1/p" | sed -e 's/[[:space:]]*$//'
}

# ExecStart's program: argv[0], except that a space in the path makes argv[0]
# ambiguous, which is what `path=` is for.
exec_start_program() { # <execstart>
  local v="$1" argv0 path0
  case "$v" in
    \{*)
      argv0="$(exec_start_field "$v" 'argv\[\]')"
      argv0="${argv0%% *}"
      path0="$(exec_start_field "$v" 'path')"
      if [ -n "$path0" ] && [ "$(basename "$path0")" = "node" ]; then
        printf '%s\n' "$path0"
      else
        printf '%s\n' "${argv0:-$path0}"
      fi
      ;;
    *)
      v="${v#-}"
      printf '%s\n' "${v%% *}"
      ;;
  esac
}

expand_specifiers() { # <value> <home>
  local v="$1" h="$2"
  v="${v//%h/$h}"
  printf '%s\n' "$v"
}

# The node binary to run the launcher with: the unit's program when that IS
# node, otherwise the first node on the unit's Environment=PATH (an
# `npm run gateway` unit has no node in ExecStart). The caller passes ONE
# program, already de-quoted from ExecStart — a path may contain spaces, so it
# must not be cut here.
resolve_node() { # <program> <unit-path-env>
  local program first dirs d candidate
  program="${1#-}"
  first="$program"
  [ -n "$first" ] || return 1
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
  # A symlink here is a redirect the service user controls. As root the copy
  # would land in whatever directory the link names, owned by the user, and the
  # unit would then run code from there. Refuse, never follow.
  if [ -L "$dir" ]; then
    note "error: $dir is a symlink — refusing to install the boot guard through it"
    exit 1
  fi
  if [ -L "$file" ]; then
    note "error: $file is a symlink — refusing to replace it"
    exit 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would install: $file (dir 0700, file 0600)"
    return 0
  fi
  if [ -f "$file" ] && cmp -s "$LAUNCHER_SRC" "$file"; then
    say "launcher copy up to date: $file"
    return 0
  fi
  tmp="$file.tmp.$$"
  # AS THE UNIT'S USER when root is doing the install: the gateway refreshes this
  # copy itself, so it must own it, and root must never leave a root-owned file
  # in a directory that user can rewrite. Both the directory and the copy are made
  # by that user — root never hands ownership of the temp path over afterwards (a
  # predictable name in a directory the user can write: that follows a swapped-in
  # symlink) nor races a check of $dir with a later mkdir/mode/owner change of it
  # (audit L1 fix 5b). `install -o` is only the no-sudo fallback: install does not
  # follow links.
  if [ -n "$owner" ] && [ "$(id -u)" -eq 0 ] && command -v sudo >/dev/null 2>&1; then
    if [ ! -d "$dir" ]; then run sudo -u "$owner" mkdir -m 700 -p "$dir"; fi
    run sudo -u "$owner" install -m 600 "$LAUNCHER_SRC" "$tmp"
  elif [ -n "$owner" ] && [ "$(id -u)" -eq 0 ]; then
    if [ ! -d "$dir" ]; then run mkdir -m 700 -p "$dir"; fi
    run install -m 600 -o "$owner" "$LAUNCHER_SRC" "$tmp"
  else
    if [ ! -d "$dir" ]; then run mkdir -m 700 -p "$dir"; fi
    run install -m 600 "$LAUNCHER_SRC" "$tmp"
  fi
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
  # The body is written by THIS user outside the unit directory (mktemp), and the
  # privileged half is one `install` with the right mode: a non-root run cannot
  # write inside /etc at all, which the old redirect + `cp` did.
  tmp="$(mktemp "${TMPDIR:-/tmp}/crow-boot-guard.XXXXXX")"
  TMPFILES+=("$tmp")
  printf '%s\n' "$content" > "$tmp"
  run install -m 644 "$tmp" "$path"
  rm -f "$tmp"
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
if [ "$DRY_RUN" = "1" ]; then say "dry run:   nothing will be written, installed, daemon-reloaded or restarted"; fi

changed=0
for unit in "${units[@]}"; do
  unit_file="$UNIT_DIR/$unit"

  # A templated unit has one file for every instance: its WorkingDirectory, User
  # and CROW_HOME belong to the instance (e.g. %i), not to the template.
  case "$unit" in
    *@*)
      note "error: $unit is a templated unit — install the drop-in per instance by hand (its WorkingDirectory/User differ per instance)"
      exit 1
      ;;
  esac

  # Read the MERGED values from systemd when it can answer (it includes every
  # drop-in and EnvironmentFile=; the unit file alone does not). One call per
  # property — never one call whose lines are assigned by position, because the
  # order is systemd's, not ours. The file is the fallback for a host where
  # systemd is not the init system.
  merged_ok=0
  exec_start=""
  env_line=""
  working_dir=""
  unit_user=""
  if exec_start="$(systemctl_prop "$unit" ExecStart)" \
    && env_line="$(systemctl_prop "$unit" Environment)" \
    && working_dir="$(systemctl_prop "$unit" WorkingDirectory)" \
    && unit_user="$(systemctl_prop "$unit" User)"; then
    merged_ok=1
  fi

  if [ "$merged_ok" = "1" ]; then
    unit_path="$(env_tokens "$env_line" | sed -n 's/^PATH=//p' | tail -n 1)"
    crow_home="$(env_tokens "$env_line" | sed -n 's/^CROW_HOME=//p' | tail -n 1)"
    # ExecStart is `{ path=/usr/bin/node ; argv[]=… ; … }` here, not a command line.
    exec_argv0="$(exec_start_program "$exec_start")"
  else
    note "warning: $unit: systemctl could not report the merged unit values — reading $unit only (drop-ins may be missed)"
    working_dir="$(unit_value "$unit_file" "WorkingDirectory")"
    exec_start="$(unit_value "$unit_file" "ExecStart")"
    exec_argv0="${exec_start#-}"
    exec_argv0="${exec_argv0%% *}"
    unit_path="$(unit_env_value "$unit_file" "PATH")"
    crow_home="$(unit_env_value "$unit_file" "CROW_HOME")"
    unit_user=""
    if [ "$MODE" = "system" ]; then unit_user="$(unit_value "$unit_file" "User")"; fi
  fi

  if [ -z "$working_dir" ]; then
    note "warning: $unit has no WorkingDirectory= — skipped"
    continue
  fi
  # The optional `-` prefix means "ignore a failure", not part of the path.
  working_dir="${working_dir#-}"
  working_dir="$(expand_specifiers "$working_dir" "$OPERATOR_HOME")"

  if [ -z "$exec_start" ]; then
    note "warning: $unit has no ExecStart= — skipped"
    continue
  fi
  node="$(resolve_node "$exec_argv0" "$unit_path" || true)"
  if [ -z "$node" ]; then
    note "error: $unit: no node found (ExecStart argv[0] is not node, and its Environment=PATH has none)"
    exit 1
  fi
  if ! node_version_ok "$node"; then
    note "error: $unit: $node is older than ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} (the boot guard reads the schema through node:sqlite)"
    exit 1
  fi

  [ -n "$crow_home" ] || crow_home="$DEFAULT_CROW_HOME"
  crow_home="$(expand_specifiers "$crow_home" "$OPERATOR_HOME")"
  if [ "$MODE" = "user" ]; then unit_user=""; fi

  launcher="$crow_home/boot-guard/crow-boot-guard.mjs"

  say ""
  say "$unit"
  say "  node:       $node"
  say "  crow home:  $crow_home"
  say "  app root:   $working_dir"

  install_launcher "$crow_home" "$unit_user"

  # Paths are quoted (they can contain spaces) and % is escaped, or systemd reads
  # it as a specifier and the launcher never starts.
  quoted_node="$(sd_quote "$node")"
  quoted_launcher="$(sd_quote "$launcher")"
  quoted_app_root="$(sd_quote "$working_dir")"

  content="# Installed by $REPO_ROOT/scripts/ops/install-boot-guard.sh
# Audit N1c-3 Layer 1: roll back an update that keeps crashing on startup.
# The launcher lives OUTSIDE this checkout, so the failing commit's own copy of
# it can never run. Both lines are prefixed with '-' so the guard can never stop
# the gateway from starting. TimeoutStartSec covers the guard's own npm install
# (up to 5 minutes) plus a rollback.
[Service]
ExecStartPre=-$quoted_node $quoted_launcher --app-root $quoted_app_root
ExecStopPost=-$quoted_node $quoted_launcher --app-root $quoted_app_root --record-exit
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