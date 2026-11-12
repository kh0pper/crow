#!/usr/bin/env bash

# Crow — Installer Script
#
# Transforms a stock Raspberry Pi OS (or any Debian/Ubuntu) into a Crow appliance.
#
# Platform: Debian/Ubuntu family ONLY (the script drives apt end to end).
# macOS, Windows, and other Linux distributions are not auto-installed —
# follow the manual path in docs/getting-started/ instead.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/kh0pper/crow/v1.1.0/scripts/crow-install.sh | bash
#
# Or download and inspect first:
#   curl -sSL https://raw.githubusercontent.com/kh0pper/crow/v1.1.0/scripts/crow-install.sh -o crow-install.sh
#   less crow-install.sh
#   bash crow-install.sh
#
# Options:
#   -y, --yes          assume the default answer to every prompt (also CROW_INSTALL_YES=1)
#   --no-auto-updates  do not turn on automatic security updates (also CROW_NO_AUTO_UPDATES=1)
#
# Environment:
#   CROW_INSTALL_REF   release tag, branch, or commit to install (default v1.1.0;
#                      CROW_INSTALL_REF=main installs the tip of main)
#
# The one-liner above feeds the script to bash on stdin, so an option has to go
# to bash itself and not after the URL:
#   curl -sSL https://raw.githubusercontent.com/kh0pper/crow/v1.1.0/scripts/crow-install.sh | bash -s -- --no-auto-updates
#   curl -sSL https://raw.githubusercontent.com/kh0pper/crow/v1.1.0/scripts/crow-install.sh | CROW_NO_AUTO_UPDATES=1 bash

set -euo pipefail

# The release this script installs. The release checklist bumps it together with the README and the guide pages.
CROW_INSTALL_REF="${CROW_INSTALL_REF:-v1.1.0}"
CROW_REPO_URL="${CROW_REPO_URL:-https://github.com/kh0pper/crow.git}"

CROW_HOME="$HOME/.crow"
CROW_APP="$CROW_HOME/app"
CROW_DATA="$CROW_HOME/data"
NODE_MAJOR=24

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# How many `error`s this run printed. The closing "Crow is ready!" banner is
# gated on it (security audit N1c-15: the installer printed the banner, and
# exited 0, right after its own gateway health check had failed).
INSTALL_ERRORS=0

log()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }
error() { echo -e "  ${RED}✗${NC} $1"; INSTALL_ERRORS=$((INSTALL_ERRORS + 1)); }
header() {
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════"
}

# ─── The release to install (validated) ──────────────────
# CROW_INSTALL_REF reaches `git checkout` as an argument, so it is validated
# before anything else happens: a value starting with `-` would be read as an
# option (`--upload-pack=…` → arbitrary command), and `..` / whitespace are
# never part of a ref we publish. Run here (helpers above, prompts below) so a
# sourced copy fails the same way an executed one does.
case "$CROW_INSTALL_REF" in
  ''|[-/]*|*..*|*[!A-Za-z0-9._/-]*)
    error "Invalid CROW_INSTALL_REF: $CROW_INSTALL_REF"
    error "Use a release tag (v1.1.0), a branch (main), or a commit sha — [A-Za-z0-9._/-] only,"
    error "not starting with '-' or '/', and without '..'."
    exit 1
    ;;
esac

# ─── Prompt helpers (F-INSTALL-5/-7) ──────────────────────
# The documented `curl … | bash` one-liner has no usable stdin (the script
# body IS stdin), so prompts read /dev/tty when a terminal exists and resolve
# to their DEFAULT when it does not (headless / cloud-init / CI).
# `--yes` / `-y` / CROW_INSTALL_YES=1 forces defaults everywhere.
ASSUME_YES=false
# Automatic security updates (K6) are ON by default; --no-auto-updates or
# CROW_NO_AUTO_UPDATES=1 leaves the host's apt configuration alone entirely.
AUTO_UPDATES=true
for _arg in "$@"; do
  case "$_arg" in
    -y|--yes) ASSUME_YES=true ;;
    --no-auto-updates) AUTO_UPDATES=false ;;
  esac
done
if [ "${CROW_INSTALL_YES:-}" = "1" ]; then ASSUME_YES=true; fi
if [ "${CROW_NO_AUTO_UPDATES:-}" = "1" ]; then AUTO_UPDATES=false; fi

# Real tty detection (R1-I1): [ -r /dev/tty ] only tests the device node's
# permission bits and is TRUE even with no controlling terminal. Actually
# opening it is the reliable probe (fails with ENXIO when headless), and it
# keeps genuinely-headless installs from spraying /dev/tty errors into logs.
HAS_TTY=false
if { exec 3</dev/tty; } 2>/dev/null; then
  exec 3<&-
  HAS_TTY=true
fi

# ask_yn <prompt> <default Y|N> — 0=yes, 1=no. Headless/--yes → default.
ask_yn() {
  local prompt="$1" default="$2" reply=""
  if [ "$ASSUME_YES" = true ] || [ "$HAS_TTY" = false ]; then
    [ "$default" = "Y" ] && return 0 || return 1
  fi
  if [ "$default" = "Y" ]; then
    printf "  %s [Y/n] " "$prompt" > /dev/tty
  else
    printf "  %s [y/N] " "$prompt" > /dev/tty
  fi
  IFS= read -r reply < /dev/tty || reply=""
  case "$reply" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) [ "$default" = "Y" ] && return 0 || return 1 ;;
  esac
}

# ask_line <prompt> — prints the reply; empty when headless/--yes/EOF.
ask_line() {
  local prompt="$1" reply=""
  if [ "$ASSUME_YES" = true ] || [ "$HAS_TTY" = false ]; then
    return 0
  fi
  printf "  %s" "$prompt" > /dev/tty
  IFS= read -r reply < /dev/tty || reply=""
  printf "%s" "$reply"
}

# ts_first_field <JsonKey> — first "<JsonKey>":"value" in $TS_JSON, no pipes
# (F-INSTALL-6: piping through grep then head SIGPIPEs under pipefail on big tailnets).
# The first match is always the Self block (tailscale status --json emits
# Self before Peer).
ts_first_field() {
  local key="$1"
  if [[ ${TS_JSON:-} =~ \"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
  fi
}

# check_platform [os_release_path] [apt_probe_cmd] — 0 when this host is a
# Debian/Ubuntu family system with apt available, 1 otherwise (Item 4-PR5).
# The script drives apt end to end, so anything else must be refused BEFORE
# the first system mutation. Both params are test seams; they default to the
# real /etc/os-release and apt-get.
# shellcheck disable=SC2120  # params are test-only seams; the prod call passes none
check_platform() {
  local os_release="${1:-/etc/os-release}" apt_cmd="${2:-apt-get}"
  local id="" id_like=""
  if ! command -v "$apt_cmd" >/dev/null 2>&1; then
    return 1
  fi
  if [ -r "$os_release" ]; then
    id="$(sed -n 's/^ID=//p' "$os_release" | tr -d '"')"
    id_like="$(sed -n 's/^ID_LIKE=//p' "$os_release" | tr -d '"')"
  fi
  case " $id $id_like " in
    *" debian "*|*" ubuntu "*) return 0 ;;
  esac
  return 1
}

# is_wsl [osrelease_path] — 0 when this kernel is a WSL2 one (security audit
# N1c-19). The kernel release is the tell: a real WSL2 kernel reports something
# like 6.6.87.2-microsoft-standard-WSL2, and both spellings have shipped, so
# either substring counts — case-insensitively, because the tag's casing is not
# part of any contract. The path is a test seam, the same kind as
# check_platform's os_release.
is_wsl() {
  local osrelease="${1:-/proc/sys/kernel/osrelease}" release=""
  [ -r "$osrelease" ] || return 1
  release="$(tr '[:upper:]' '[:lower:]' < "$osrelease" 2>/dev/null || true)"
  case "$release" in
    *microsoft*|*wsl*) return 0 ;;
  esac
  return 1
}

# print_wsl_note [osrelease_path] — the one line a WSL2 host gets at the end of
# the run (audit N1c-19). Whether Crow is reachable from another device on the
# LAN is decided OUTSIDE this Linux environment — by WSL2's networking mode and
# the Windows/Hyper-V firewall — so the installer does not guess, prompt or
# change anything; it points at the guide's section that explains both. On any
# other host it prints nothing. The path is is_wsl's test seam.
# shellcheck disable=SC2120  # params are test-only seams; the prod call passes none
print_wsl_note() {
  local osrelease="${1:-/proc/sys/kernel/osrelease}"
  is_wsl "$osrelease" || return 0
  echo "  This is WSL2: see the Windows guide's 'Network: who can reach Crow' section before opening Crow to other devices."
  echo "  See docs/getting-started/windows-wsl2.md"
  echo ""
}

# Quote one argument for a systemd Exec= line: a path may contain spaces, and a
# literal % is a systemd specifier (%% writes one).
sd_quote() { # <arg>
  local s="$1"
  s="${s//%/%%}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# ─── Port precheck (security audit N1c-15) ───────────────
# Nothing may be installed or started while another program already owns one of
# the three ports this installer binds: the new units would fail — or, worse,
# half-start and be shadowed — and the operator would find out from a browser
# error much later. `ss` is iproute2's socket tool and ships on Debian/Ubuntu;
# `-ltnH` lists TCP listeners without a header and without needing root (the
# check only asks WHETHER a port is busy; the fix-it hint asks root for the PID).
CROW_INSTALL_PORTS=(3001 80 443)   # gateway · HTTP (Caddy) · HTTPS (Caddy)

port_is_listening() { # <port> — 0 when a TCP socket listens on it
  local listeners=""
  command -v ss >/dev/null 2>&1 || return 1
  listeners="$(ss -ltnH "sport = :$1" 2>/dev/null || true)"
  [ -n "$listeners" ]
}

crow_owns_port() { # <port> — 0 when an EXISTING Crow install already holds it
  # A re-run must not trip over its own services: only the "already cloned"
  # path can have these units, and only they may hold these ports.
  [ -d "$CROW_APP" ] || return 1
  case "$1" in
    3001) systemctl is-active --quiet crow-gateway 2>/dev/null ;;
    80|443) systemctl is-active --quiet caddy 2>/dev/null ;;
    *) return 1 ;;
  esac
}

check_ports_free() { # 0 when every CROW_INSTALL_PORTS entry is free or Crow's
  local port busy=0
  if ! command -v ss >/dev/null 2>&1; then
    warn "ss (iproute2) is missing — skipping the port check"
    return 0
  fi
  for port in "${CROW_INSTALL_PORTS[@]}"; do
    port_is_listening "$port" || continue
    if crow_owns_port "$port"; then
      continue
    fi
    error "Port ${port} is already in use by another program (see: sudo ss -ltnp 'sport = :${port}')."
    error "Stop that program or free the port, then run the installer again."
    busy=1
  done
  [ "$busy" -eq 0 ]
}

# ─── SSH port detection (security audit N1c-15) ──────────
# `ufw --force enable` opens the firewall instantly: a host whose sshd listens
# on anything but 22 would drop the operator's own session at that moment, and
# they could not get back in. Three probes, all best-effort — 22 is always
# allowed as well, so the worst case is exactly the old behaviour:
#   A. SSH_CONNECTION's 4th field: the port THIS session arrived on.
#   B. `sshd -T`'s effective config: the authority. It applies the config file,
#      every Include'd drop-in and the compiled-in defaults, and it is the only
#      probe that cannot be fooled by what a file merely says. When it cannot
#      answer (no binary, a config error) the config-file probe below takes over.
#   C. systemd's socket activation (`ssh.socket` on Ubuntu 22.10+, `sshd.socket`
#      elsewhere): there a custom port lives in a ListenStream= drop-in and no
#      `Port` line exists at all. Loopback-only and non-Stream entries are not
#      reachable by an operator, so they are not candidates.
# A port is only ever a candidate: each one is range-checked, normalised to its
# decimal value and de-duplicated before it is printed, and every candidate
# lives in an array — two probes are never concatenated into one string (an `ss`
# row's `22` glued to SSH_CONNECTION's `22` once became the bogus port 2222).
# Probe B cannot ask for a password: every sudo'd line above it already has.
# The install body's first privileged call is `sudo apt update` (Step 1) and the
# ufw `default`/`allow 22` lines sit directly above the probe, so by then sudo is
# obtained — a box that re-prompts every time would have prompted there instead.
#
# CROW_SSHD / CROW_SYSTEMCTL are the same kind of test seam as CROW_SUDO below:
# the suite points them at shims, so no test can reach the real sshd or systemd.
CROW_SSHD="${CROW_SSHD:-sshd}"
CROW_SYSTEMCTL="${CROW_SYSTEMCTL:-systemctl}"

port_in_range() { # <port> — 0 when it is a usable TCP port (1-65535)
  local p="${1:-}"
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  p="${p#"${p%%[!0]*}"}"          # drop leading zeros (082 is 82, not octal)
  [ -n "$p" ] || return 1           # all zeros is not a port
  [ "$p" -ge 1 ] && [ "$p" -le 65535 ]
}

sshd_effective_ports() { # — `sshd -T`'s `port` lines, one per line; non-zero when it cannot answer
  # `-T` prints sshd's EFFECTIVE configuration: the Include'd files are already
  # resolved, defaults are filled in, and a config error makes it fail (nothing on
  # stdout), which is exactly the cue to fall back to the config file.
  local out="" line got=0
  out="$(sudo_cmd "$CROW_SSHD" -T 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  while IFS= read -r line; do
    [[ "$line" =~ ^port\ ([0-9]+)$ ]] || continue
    printf '%s\n' "${BASH_REMATCH[1]}"
    got=1
  done <<< "$out"
  [ "$got" -eq 1 ]
}

sshd_config_ports() { # [config_file…] — the Port lines in sshd_config and its drop-ins
  # Fallback only (probe B could not answer). The files are world-readable on
  # Debian/Ubuntu, and the drop-in directory is where distro packages and cloud
  # images put them.
  local p cfgs=()
  if [ "$#" -gt 0 ]; then
    cfgs=("$@")
  else
    cfgs=(/etc/ssh/sshd_config)
    for p in /etc/ssh/sshd_config.d/*.conf; do
      if [ -r "$p" ]; then cfgs+=("$p"); fi
    done
  fi
  for p in "${cfgs[@]}"; do
    if [ -r "$p" ]; then
      # Keywords are case-insensitive, and `q` on the first Match line stops the
      # read there: a Port inside a Match block is invalid for sshd, so honouring
      # it would only open a port nothing listens on.
      sed -n '/^[[:space:]]*[Mm][Aa][Tt][Cc][Hh]/q;s/^[[:space:]]*[Pp][Oo][Rr][Tt][[:space:]][[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$p" 2>/dev/null || true
    fi
  done
}

sshd_socket_ports() { # — the Stream Listen ports of ssh.socket / sshd.socket, one per line
  # `systemctl show -p Listen --value` prints one address per line, e.g.
  # `[::]:22 (Stream)` or `0.0.0.0:2222 (Stream)`. A unit that does not exist
  # prints nothing and exits non-zero — with or without socket activation.
  local unit="" out="" line addr host port
  for unit in ssh.socket sshd.socket; do
    out="$("$CROW_SYSTEMCTL" show -p Listen --value "$unit" 2>/dev/null || true)"
    [ -n "$out" ] || continue
    while IFS= read -r line; do
      addr="${line% (Stream)}"
      [ "$addr" != "$line" ] || continue        # Datagram/Sequential not serving SSH
      case "$addr" in *:*) ;; *) continue ;; esac
      host="${addr%:*}"                         # 0.0.0.0:2222 · [::]:22 · [::1]:2201
      port="${addr##*:}"
      # A loopback-only listener is not a way back in for a remote operator.
      case "$host" in 127.*|'[::1]'|localhost) continue ;; esac
      printf '%s\n' "$port"
    done <<< "$out"
  done
}

# shellcheck disable=SC2120  # the config-file params are test-only seams; the prod call passes none
ssh_ports() { # [config_file…] — every port found once, one per line
  local -a candidates=()
  local p port num seen=" "
  # A. The port this very session arrived on — the one ufw must not close.
  if [ -n "${SSH_CONNECTION:-}" ]; then
    read -r _ _ _ p <<< "$SSH_CONNECTION" || true
    candidates+=("${p:-}")
  fi
  # B. sshd's effective config, or the files when sshd cannot tell us.
  if p="$(sshd_effective_ports)"; then
    while IFS= read -r port; do
      if [ -n "$port" ]; then candidates+=("$port"); fi
    done <<< "$p"
  else
    while IFS= read -r port; do
      if [ -n "$port" ]; then candidates+=("$port"); fi
    done < <(sshd_config_ports "$@")
  fi
  # C. Socket activation (a ListenStream= port has no `Port` line anywhere).
  while IFS= read -r port; do
    if [ -n "$port" ]; then candidates+=("$port"); fi
  done < <(sshd_socket_ports)
  [ "${#candidates[@]}" -gt 0 ] || return 0
  for port in "${candidates[@]}"; do
    port_in_range "$port" || continue
    num=$((10#$port))         # 0022 is 22 — decimal, never octal
    case "$seen" in *" $num "*) continue ;; esac
    seen="${seen}${num} "
    printf '%s\n' "$num"
  done
}

# ─── Failure tracking + gateway verification (audit N1c-15) ──
# "Crow is ready!" is a promise; it may only be printed when nothing failed.
install_failed() { # 0 when this run printed at least one error
  [ "${INSTALL_ERRORS:-0}" -ne 0 ]
}

# verify_gateway — the service check plus HTTP health probe that decide whether
# this run may claim to be finished. Every failure goes through `error` (so the
# banner below is blocked too) and names the commands that show the cause.
verify_gateway() {
  local ok=false
  if systemctl is-active --quiet crow-gateway 2>/dev/null; then
    log "Gateway service: running"
  else
    error "Gateway service is not running (see: sudo systemctl status crow-gateway)"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null http://localhost:3001/health 2>/dev/null; then
      ok=true
      break
    fi
    sleep 2
  done
  if [ "$ok" = true ]; then
    log "Gateway responding at http://localhost:3001"
    return 0
  fi
  error "Gateway did not respond at http://localhost:3001 after 10 attempts — Crow is not ready."
  echo "    1. Check the service:   sudo systemctl status crow-gateway"
  echo "    2. Read its last lines: sudo journalctl -u crow-gateway -n 50"
  echo "    3. Fix what they show, then run the installer again."
  return 1
}

# ─── Automatic security updates (security audit K6) ──────
# The installer writes ONE apt configuration file of its own
# (52crow-unattended-upgrades) and never edits the distribution's
# 50unattended-upgrades: our file only ADDS the origins of the repositories this
# installer wired up (NodeSource, Docker, cloudsmith/Caddy), so a security fix
# for Node, Docker or Caddy installs itself exactly like the distribution's own
# security updates do. Automatic reboots stay OFF, and nothing here restarts a
# service — a Docker or Node security update may bounce its own service for a
# moment, and the Crow's Nest says when a reboot is still owed (the "System
# updates" health card).
#
# The apt.conf.d directory and the two privileged commands are test seams: the
# suite runs this step against a scratch directory with shims, so it can never
# touch the real /etc/apt. The defaults are the real ones.
APT_CONF_DIR="${APT_CONF_DIR:-/etc/apt/apt.conf.d}"
CROW_SUDO="${CROW_SUDO:-sudo}"
CROW_APT="${CROW_APT:-apt}"

sudo_cmd() { # <cmd> [args…]
  # Word-split on purpose: the seam may carry flags too (e.g. "sudo -n").
  # shellcheck disable=SC2086
  $CROW_SUDO "$@"
}
apt_install() { # <package> [packages…] — the same `-y` style as the rest of the script
  sudo_cmd "$CROW_APT" install -y "$@"
}

# write_crow_apt_conf — Crow's own origins file. Idempotent: a re-run that would
# write identical bytes does nothing (so the file's mtime, and any dpkg state,
# stays untouched). The content is built in a temp file first and only then
# installed with mode 644, so nothing under /etc/apt is opened for a partial
# write by us.
write_crow_apt_conf() {
  local dest="$APT_CONF_DIR/52crow-unattended-upgrades" tmp
  tmp="$(mktemp)"
  # Quoted heredoc: ${distro_codename} is an apt variable that UNATTENDED-UPGRADES
  # (not apt) substitutes when it reads the origins, so it must land literally
  # (and `set -u` would choke on it).
  cat > "$tmp" << 'CROWAPTEOF'
// Written by the Crow installer. Remove this file to stop Crow's additions;
// see https://maestro.press/software/crow/guide/auto-update#system-updates
// for turning automatic updates off.
Unattended-Upgrade::Origins-Pattern {
    "origin=. nodistro,codename=nodistro";
    "origin=Docker,archive=${distro_codename}";
    "origin=cloudsmith/caddy/stable,codename=any-version";
};
Unattended-Upgrade::Automatic-Reboot "false";
CROWAPTEOF
  if [ -r "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    log "Automatic security updates already configured ($dest unchanged)"
    return 0
  fi
  sudo_cmd install -m 644 "$tmp" "$dest"
  rm -f "$tmp"
  log "Automatic security updates configured: system, Node, Docker and Caddy ($dest)"
}

# write_auto_upgrades_conf — the distro's periodic switch. Written ONLY when it
# does not exist: on a host that already configured unattended-upgrades (or ran
# dpkg-reconfigure), the operator's periodic settings are not overruled.
write_auto_upgrades_conf() {
  local dest="$APT_CONF_DIR/20auto-upgrades" tmp
  if [ -e "$dest" ]; then
    log "$dest already exists — left as it is"
    return 0
  fi
  tmp="$(mktemp)"
  cat > "$tmp" << 'CROWAPTEOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CROWAPTEOF
  sudo_cmd install -m 644 "$tmp" "$dest"
  rm -f "$tmp"
  log "Daily automatic security updates enabled ($dest)"
}

# install_auto_updates — the whole step. Never restarts a service and never
# reboots; both are the operator's call (the Nest shows when a reboot is owed).
install_auto_updates() {
  if [ "$AUTO_UPDATES" != true ]; then
    warn "Automatic security updates skipped (--no-auto-updates)"
    return 0
  fi
  apt_install unattended-upgrades
  write_crow_apt_conf
  write_auto_upgrades_conf
}

# ─── Bot sandbox: bubblewrap + Ubuntu's own AppArmor profile ─────────────
# The bot sandbox (scripts/pi-bots/pi_sandbox.mjs) wraps every pi child in
# bubblewrap; without it bots keep this user's groups (docker) and sudo. Ubuntu
# 24.04+ ships kernel.apparmor_restrict_unprivileged_userns=1, so bubblewrap
# cannot make the user namespace it needs. The answer is Ubuntu's OWN
# `bwrap-userns-restrict` profile, shipped in the apparmor-profiles package: it
# lets bwrap build its namespaces, and every program bwrap starts is stacked
# into its `unpriv_bwrap` child, which has `audit deny capability`. So bubblewrap
# may create a user namespace, everything bwrap runs has every capability use denied, and
# no other caller gains a way around the restriction. The installer never writes
# a profile of its own and nothing here writes a kernel setting.
#
# The package itself is NEVER installed: it drops 19 other profiles into
# /etc/apparmor.d in ENFORCE mode (samba, avahi, dnsmasq, nscd, ping, traceroute,
# php-fpm, syslogd…), which would confine services on the operator's machine.
# Only `bwrap-userns-restrict` is taken: from the file an operator already has,
# or by DOWNLOADING the .deb and extracting that one file into a temp dir.
#
# Every path and the parser are test seams, so the suite runs this step against
# a scratch root and can never touch the real /proc or /etc/apparmor.d.
APPARMOR_DIR="${APPARMOR_DIR:-/etc/apparmor.d}"
APPARMOR_EXTRA_DIR="${APPARMOR_EXTRA_DIR:-/usr/share/apparmor/extra-profiles}"
USERNS_SYSCTL_PATH="${USERNS_SYSCTL_PATH:-/proc/sys/kernel/apparmor_restrict_unprivileged_userns}"
CROW_APPARMOR_PARSER="${CROW_APPARMOR_PARSER:-apparmor_parser}"
# Debian's default USER PATH has neither /usr/sbin nor /sbin, so the parser is
# looked up there as well (it is a space-separated directory list).
CROW_APPARMOR_PARSER_DIRS="${CROW_APPARMOR_PARSER_DIRS:-/usr/sbin /sbin}"
# apt-get download needs no root and dpkg-deb -x unpacks as this user; both are
# seams so the suite never touches the network or the real dpkg.
CROW_APT_GET="${CROW_APT_GET:-apt-get}"
CROW_DPKG_DEB="${CROW_DPKG_DEB:-dpkg-deb}"
CROW_BWRAP_PROFILE="$APPARMOR_DIR/bwrap-userns-restrict"
# The profile where an operator already has the package installed by hand (or a
# distro that ships it in extra-profiles). Preferred over a download.
CROW_BWRAP_SOURCE="$APPARMOR_EXTRA_DIR/bwrap-userns-restrict"
# The first shape this branch shipped: an unconfined profile that let ANY local
# caller (or a compromised bot) run bwrap with a full-capability user namespace,
# undoing Ubuntu's restriction for everyone. Removed, never reinstalled.
CROW_OLD_BWRAP_PROFILE="$APPARMOR_DIR/crow-bwrap"

# userns_restricted — 0 when this kernel restricts unprivileged user namespaces
# (the proc file exists and reads 1). A missing file means an older kernel or
# AppArmor that allows them: then there is nothing to do.
userns_restricted() {
  local v
  [ -r "$USERNS_SYSCTL_PATH" ] || return 1
  v="$(cat "$USERNS_SYSCTL_PATH" 2>/dev/null || true)"
  v="${v//[[:space:]]/}"
  [ "$v" = "1" ]
}

# apparmor_parser_bin — print the parser to run, or nothing when this host has
# none. `command -v` alone is not enough: Debian's default user PATH has no
# /usr/sbin or /sbin, where the apparmor package installs it.
apparmor_parser_bin() {
  local d p
  if command -v "$CROW_APPARMOR_PARSER" >/dev/null 2>&1; then
    command -v "$CROW_APPARMOR_PARSER"
    return 0
  fi
  # shellcheck disable=SC2086  # a space-separated directory list on purpose
  for d in $CROW_APPARMOR_PARSER_DIRS; do
    p="$d/${CROW_APPARMOR_PARSER##*/}"
    if [ -x "$p" ]; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

# bwrap_profile_exists — 0 when some OTHER file already attaches /usr/bin/bwrap
# (the distro file, an operator's local one). Only a real profile line counts, so
# a comment mentioning the path never does; our own target file is not "somebody
# else", and our previous crow-bwrap file is removed before this is asked.
bwrap_profile_exists() {
  [ -d "$APPARMOR_DIR" ] || return 1
  # /etc/apparmor.d/bwrap is the distro's own name for this; never add a second
  # attachment next to it.
  [ -e "$APPARMOR_DIR/bwrap" ] && return 0
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$f" = "$CROW_BWRAP_PROFILE" ]; then
      continue
    fi
    if grep -Eqs '^[[:space:]]*profile[[:space:]]+[^[:space:]]+[[:space:]]+/usr/bin/bwrap' "$f"; then
      return 0
    fi
  done < <(grep -rlsF -- '/usr/bin/bwrap' "$APPARMOR_DIR" 2>/dev/null || true)
  return 1
}

# stage_trap_restore — put the traps back that stage_bwrap_profile found before
# it installed its own. Bash has no function-local traps, so the step snapshots
# the caller's INT/TERM/EXIT handlers with `trap -p` and calls this before EVERY
# return. An empty snapshot means that signal had no trap, so it is cleared here
# (a leftover `rm -rf $tmpdir` handler must not outlive the temp dir).
stage_trap_restore() { # <saved-int> <saved-term> <saved-exit>
  trap - INT
  trap - TERM
  trap - EXIT
  [ -z "${1:-}" ] || eval "$1"
  [ -z "${2:-}" ] || eval "$2"
  [ -z "${3:-}" ] || eval "$3"
}

# stage_trap_cleanup — the cleanup trap that runs WHILE stage_bwrap_profile owns
# its temp dir (a body like `rm -rf $tmpdir; exit 130` beats an explicit return
# on every path, because a signal can arrive anywhere). The first argument is the
# status to exit with for INT/TERM and empty for EXIT.
#   EXIT      — remove the dir, then RUN the exit trap that was installed before
#               this step took the signal over: re-installing it here would be
#               too late, the shell is already on its way out.
#   INT/TERM  — remove the dir, restore all three traps, then exit through them,
#               so a previous EXIT trap still runs (chaining, not clobbering).
stage_trap_cleanup() { # <status-or-empty> <tmpdir> <saved-int> <saved-term> <saved-exit>
  local status="${1:-}" tmpdir="$2" saved_int="${3:-}" saved_term="${4:-}" saved_exit="${5:-}"
  rm -rf "$tmpdir"
  trap - INT
  trap - TERM
  trap - EXIT
  [ -z "$saved_int" ] || eval "$saved_int"
  [ -z "$saved_term" ] || eval "$saved_term"
  if [ -n "$status" ]; then
    [ -z "$saved_exit" ] || eval "$saved_exit"
    exit "$status"
  fi
  # `trap -p EXIT` prints `trap -- '<command>' EXIT`; strip the wrapper and run
  # the command itself (evaluating a single shell-quoted word runs it).
  case "$saved_exit" in
    "trap -- "*" EXIT")
      saved_exit="${saved_exit#trap -- }"
      eval "${saved_exit% EXIT}"
      ;;
  esac
}

# stage_bwrap_profile — put Ubuntu's bwrap-userns-restrict bytes into <dest>.
# Preferred source: the file already on this host (the operator installed
# apparmor-profiles themselves, or the distro ships it in extra-profiles).
# Otherwise the package is DOWNLOADED, never installed, and unpacked into a temp
# dir: installing it would put 19 other profiles (samba, avahi, dnsmasq, nscd,
# ping, traceroute, php-fpm, syslog…) into /etc/apparmor.d in enforce mode. Only
# this one file is taken out of it. Every failure is a WARN plus a non-zero
# return; nothing here may abort the installer (set -e skips `if ! …` bodies).
stage_bwrap_profile() { # <dest-file>
  local dest="$1"
  if [ -r "$CROW_BWRAP_SOURCE" ]; then
    if cp "$CROW_BWRAP_SOURCE" "$dest" 2>/dev/null; then
      return 0
    fi
    warn "Could not read $CROW_BWRAP_SOURCE — bubblewrap has no rule, so bots run without the sandbox"
    return 1
  fi

  local tmpdir deb f src prev_int prev_term prev_exit trap_args
  if ! tmpdir="$(mktemp -d)"; then
    warn "Could not create a temp directory to fetch apparmor-profiles — bubblewrap has no rule, so bots run without the sandbox"
    return 1
  fi
  # The temp dir gets a cleanup trap that also fires on INT/TERM: an interrupted
  # re-run (or a Ctrl-C during a slow download) must not leave a .deb tree in
  # $TMPDIR. It is process-wide the moment it is set, so the caller's handlers
  # are snapshotted first and stage_trap_restore() runs before every return
  # below; `printf %q` freezes the values into the handler text, and an empty
  # snapshot becomes '' so that signal is left cleared.
  prev_int="$(trap -p INT)"
  prev_term="$(trap -p TERM)"
  prev_exit="$(trap -p EXIT)"
  trap_args="$(printf '%q' "$tmpdir") $(printf '%q' "$prev_int") $(printf '%q' "$prev_term") $(printf '%q' "$prev_exit")"
  # shellcheck disable=SC2064  # expanded now on purpose: the trap outlives these locals
  trap "stage_trap_cleanup 130 $trap_args" INT
  # shellcheck disable=SC2064
  trap "stage_trap_cleanup 143 $trap_args" TERM
  # shellcheck disable=SC2064
  trap "stage_trap_cleanup '' $trap_args" EXIT
  # apt-get download writes the .deb into the CWD and needs no root, so it runs
  # as the invoking user (never through sudo).
  # shellcheck disable=SC2086  # the seam may carry flags too
  if ! ( cd "$tmpdir" && $CROW_APT_GET download apparmor-profiles ); then
    rm -rf "$tmpdir"
    stage_trap_restore "$prev_int" "$prev_term" "$prev_exit"
    warn "Could not download apparmor-profiles — bubblewrap has no rule, so bots run without the sandbox"
    return 1
  fi
  deb=""
  for f in "$tmpdir"/*.deb; do
    if [ -f "$f" ]; then
      deb="$f"
      break
    fi
  done
  if [ -z "$deb" ]; then
    rm -rf "$tmpdir"
    stage_trap_restore "$prev_int" "$prev_term" "$prev_exit"
    warn "Downloading apparmor-profiles produced no .deb — bubblewrap has no rule, so bots run without the sandbox"
    return 1
  fi
  if ! "$CROW_DPKG_DEB" -x "$deb" "$tmpdir/x"; then
    rm -rf "$tmpdir"
    stage_trap_restore "$prev_int" "$prev_term" "$prev_exit"
    warn "Could not unpack apparmor-profiles with dpkg-deb — bubblewrap has no rule, so bots run without the sandbox"
    return 1
  fi
  src="$tmpdir/x/usr/share/apparmor/extra-profiles/bwrap-userns-restrict"
  if [ ! -r "$src" ]; then
    rm -rf "$tmpdir"
    stage_trap_restore "$prev_int" "$prev_term" "$prev_exit"
    warn "apparmor-profiles did not provide bwrap-userns-restrict — bubblewrap has no rule, so bots run without the sandbox"
    return 1
  fi
  if ! cp "$src" "$dest" 2>/dev/null; then
    rm -rf "$tmpdir"
    stage_trap_restore "$prev_int" "$prev_term" "$prev_exit"
    warn "Could not read bwrap-userns-restrict out of the downloaded package — bubblewrap has no rule, so bots run without the sandbox"
    return 1
  fi
  rm -rf "$tmpdir"
  stage_trap_restore "$prev_int" "$prev_term" "$prev_exit"
  return 0
}

# bwrap_profile_sane — the bytes really are the profile we expect: a bwrap
# attachment, the unpriv_bwrap child that carries the capability denial, the
# stacking rule that actually moves bwrap's children into that child
# (`-> &bwrap//&unpriv_bwrap`), and no profile whose flags list carries
# `unconfined` or `complain` — in any position, not just on its own. Guards
# against a future package shipping a shape that would lift Ubuntu's
# restriction for everyone, or one that would leave bots outside the denial.
bwrap_profile_sane() { # <file>
  local f="$1"
  grep -qF 'profile bwrap /usr/bin/bwrap' "$f" || return 1
  grep -qF 'profile unpriv_bwrap' "$f" || return 1
  grep -qF 'audit deny capability' "$f" || return 1
  # Without this rule the child profile exists but nothing is ever stacked into
  # it, so what bwrap runs keeps its capabilities. Two spellings are in use:
  # Ubuntu 24.04's apparmor-profiles writes `allow px /** -> bwrap//&unpriv_bwrap,`
  # and upstream writes `allow pix /** -> &bwrap//&unpriv_bwrap,`; both stack the
  # child under unpriv_bwrap. The pattern starts with `-`, so `--` is required.
  grep -Eq -- '-> &?bwrap//&unpriv_bwrap' "$f" || return 1
  # A flags list may carry either word anywhere (`flags=(complain)`,
  # `flags=(attach_disconnected,unconfined)`) and would lift the restriction.
  if grep -Eq 'flags=\([^)]*(unconfined|complain)' "$f"; then
    return 1
  fi
  return 0
}

# bwrap_profile_installed — our own copy is in place and is the profile we
# expect: a REGULAR file (not a symlink somebody pointed elsewhere) carrying the
# shape bwrap_profile_sane accepts. Re-runs key the "nothing to do" fast path on
# this, so a host that is already set up never reaches for the package again.
bwrap_profile_installed() {
  [ -f "$CROW_BWRAP_PROFILE" ] || return 1
  if [ -L "$CROW_BWRAP_PROFILE" ]; then
    return 1
  fi
  bwrap_profile_sane "$CROW_BWRAP_PROFILE"
}

# install_bwrap_apparmor — install Ubuntu's own bwrap-userns-restrict profile
# where the kernel restricts user namespaces, and only there. The file is copied
# byte for byte out of the apparmor-profiles package (a distro-maintained file,
# not text this repo writes): bwrap may create its user namespace and everything
# it starts has every capability use denied. Idempotent: identical bytes mean no
# rewrite, no reload and no mtime change. Every failure is a WARN, never an
# error — bots fall back exactly as they did before, and the Bot Runtime settings
# page plus the Crow's Nest health card say so in plain words.
install_bwrap_apparmor() {
  local unload_parser parser tmp backup=""
  local had_previous=0

  # The too-wide profile this branch shipped first is removed BEFORE any gate:
  # on a host whose switch now reads 0, or with no parser, it would otherwise
  # stay loaded — and it lifted Ubuntu's restriction for anyone who could run
  # bwrap. Unloaded by name when a parser is at hand, then removed.
  if [ -e "$CROW_OLD_BWRAP_PROFILE" ]; then
    unload_parser="$(apparmor_parser_bin || true)"
    if [ -n "$unload_parser" ]; then
      sudo_cmd "$unload_parser" -R "$CROW_OLD_BWRAP_PROFILE" >/dev/null 2>&1 || true
    fi
    sudo_cmd rm -f "$CROW_OLD_BWRAP_PROFILE" || true
    log "Removed the earlier crow-bwrap AppArmor profile (it lifted the user-namespace restriction for every bwrap caller)"
  fi

  if ! userns_restricted; then
    log "No AppArmor rule needed for bubblewrap (unprivileged user namespaces are not restricted here)"
    return 0
  fi
  if [ ! -d "$APPARMOR_DIR" ]; then
    warn "AppArmor is not installed — bubblewrap has no rule, so bots run without the sandbox"
    return 0
  fi
  if ! parser="$(apparmor_parser_bin)"; then
    warn "apparmor_parser is not available — bubblewrap has no rule, so bots run without the sandbox"
    return 0
  fi

  # A disable link is the operator's own choice: say what it means after the
  # next reboot and leave it alone. Removing it would silently overrule them.
  if [ -e "$APPARMOR_DIR/disable/bwrap-userns-restrict" ]; then
    warn "$APPARMOR_DIR/disable/bwrap-userns-restrict is present, so AppArmor disables the bubblewrap profile at boot: bots lose the sandbox after a reboot. Remove that link to keep it"
  fi

  # Re-run fast path: our installed copy is already there and intact, so there
  # is nothing to fetch — a re-run on an offline host must not warn "could not
  # download" for a file that is already correct. Both the download AND the
  # extract are skipped, and nothing is reloaded: the copy was loaded when it
  # was installed, or AppArmor loads it at boot from $APPARMOR_DIR.
  # A source copy that differs (the operator's own apparmor-profiles was
  # updated) still wins: it falls through to the normal copy path below, which
  # needs no download either. A missing, insane or symlinked install does what it
  # always did.
  if bwrap_profile_installed; then
    if [ ! -e "$CROW_BWRAP_SOURCE" ] || cmp -s "$CROW_BWRAP_SOURCE" "$CROW_BWRAP_PROFILE"; then
      log "AppArmor rule for bubblewrap already in place ($CROW_BWRAP_PROFILE unchanged)"
      return 0
    fi
  fi

  # Copied outside /etc first, so a partial write never lands in the profile dir.
  if ! tmp="$(mktemp)"; then
    warn "Could not create a temp file for the bubblewrap AppArmor profile — bots run without the sandbox"
    return 0
  fi
  if ! stage_bwrap_profile "$tmp"; then
    rm -f "$tmp"
    return 0
  fi
  if ! bwrap_profile_sane "$tmp"; then
    rm -f "$tmp"
    warn "The bwrap-userns-restrict profile in apparmor-profiles does not have the expected shape (a /usr/bin/bwrap profile, the unpriv_bwrap child with 'audit deny capability', a '-> &bwrap//&unpriv_bwrap' stacking rule, and no flags list carrying unconfined or complain) — nothing was written, so bots run without the sandbox"
    return 0
  fi
  if [ -e "$CROW_BWRAP_PROFILE" ] && cmp -s "$tmp" "$CROW_BWRAP_PROFILE"; then
    rm -f "$tmp"
    log "AppArmor rule for bubblewrap already installed ($CROW_BWRAP_PROFILE unchanged)"
    return 0
  fi
  # Somebody else already attached bwrap: never fight over an operator's (or a
  # package's) profile file.
  if bwrap_profile_exists; then
    rm -f "$tmp"
    log "An AppArmor profile for /usr/bin/bwrap already exists — left as it is"
    return 0
  fi
  # Keep the previous copy so a failed load restores it instead of leaving a
  # half-applied state (or no file at all).
  if [ -e "$CROW_BWRAP_PROFILE" ]; then
    if ! backup="$(mktemp)"; then
      backup=""
    elif cp "$CROW_BWRAP_PROFILE" "$backup" 2>/dev/null; then
      had_previous=1
    else
      rm -f "$backup"
      backup=""
    fi
  fi
  if ! sudo_cmd install -m 644 "$tmp" "$CROW_BWRAP_PROFILE"; then
    rm -f "$tmp"
    [ -z "$backup" ] || rm -f "$backup"
    warn "Could not install the AppArmor profile for bubblewrap — bots run without the sandbox (the Crow's Nest says so)"
    return 0
  fi
  rm -f "$tmp"
  if sudo_cmd "$parser" -r "$CROW_BWRAP_PROFILE"; then
    [ -z "$backup" ] || rm -f "$backup"
    log "AppArmor rule installed: bubblewrap may create a user namespace, and everything it runs has every capability use denied ($CROW_BWRAP_PROFILE)"
    return 0
  fi
  # The load failed. If a previous copy was there, put it back (the kernel still
  # holds whatever was loaded from it); otherwise leave nothing behind.
  if [ "$had_previous" = "1" ]; then
    if sudo_cmd install -m 644 "$backup" "$CROW_BWRAP_PROFILE"; then
      rm -f "$backup"
      warn "Could not load the new AppArmor profile for bubblewrap — the previous one is back in place, so this host is as it was"
    else
      rm -f "$backup"
      warn "Could not load the new AppArmor profile for bubblewrap, nor put the previous one back ($CROW_BWRAP_PROFILE) — check that file by hand"
    fi
    return 0
  fi
  sudo_cmd "$parser" -R "$CROW_BWRAP_PROFILE" >/dev/null 2>&1 || true
  sudo_cmd rm -f "$CROW_BWRAP_PROFILE" || true
  warn "Could not load the AppArmor profile for bubblewrap — bots run without the sandbox (the Crow's Nest says so)"
  return 0
}

# ─── ufw-docker, pinned to a commit and a checksum (security audit K7) ──
# Docker writes its own iptables rules for a published container port, so that
# port is reachable from outside even while ufw says deny. ufw-docker closes the
# mismatch — and it is a shell script fetched from GitHub that is then RUN AS
# ROOT, so the download is pinned to one commit and verified against a sha256:
# a moving branch would let upstream (or a hijacked network) decide what runs as
# root on the operator's machine.
#
# Bump BOTH values together — a new commit is a new file, so a stale sha256
# refuses it instead of installing bytes nobody has reviewed:
#   1. latest commit: https://github.com/chaifeng/ufw-docker/commits/master
#   2. set UFW_DOCKER_COMMIT to that sha (UFW_DOCKER_URL is built from it)
#   3. set UFW_DOCKER_SHA256 to `curl -fsSL "$UFW_DOCKER_URL" | sha256sum`
#   4. change both lines in the same edit.
UFW_DOCKER_COMMIT="020a8699f95592561f254d8d4ad1bb40d401dfc7"
UFW_DOCKER_URL="https://raw.githubusercontent.com/chaifeng/ufw-docker/${UFW_DOCKER_COMMIT}/ufw-docker"
# The downloader and the destination are test seams of the same kind as
# CROW_SUDO: the suite points them at a scratch dir and shims, so no test can
# download anything or write into /usr/local/bin.
CROW_CURL="${CROW_CURL:-curl}"
UFW_DOCKER_DEST="${UFW_DOCKER_DEST:-/usr/local/bin/ufw-docker}"
# Overridable only so the suite can pin its own fixture; production keeps the
# documented value above, which is the default here.
UFW_DOCKER_SHA256="${UFW_DOCKER_SHA256:-643e56b080567c567b4aa28650196849b2a2da5dd0473fd3e5216b0886035ab0}"

file_sha256() { # <file> — lowercase hex sha256; empty when it cannot be read
  local out=""
  out="$(sha256sum "$1" 2>/dev/null || true)"
  printf '%s' "${out%% *}"
}

# install_ufw_docker — install the pinned ufw-docker and wire it into ufw.
# The file is fetched by the INVOKING USER into a temp file, so nothing off the
# network is ever written into /usr/local/bin as root and root never downloads.
# Fails CLOSED: without ufw-docker a container's published port bypasses the
# firewall, so a download that cannot be verified ends the install (exit 1)
# instead of leaving a silently open box.
install_ufw_docker() {
  local tmp="" actual=""

  # A path that exists but is no regular file (a directory, a device) can never
  # be the binary: `install` would either fail halfway or — without -T — fill
  # the directory. Refuse before anything is downloaded.
  if [ -e "$UFW_DOCKER_DEST" ] && [ ! -f "$UFW_DOCKER_DEST" ]; then
    error "$UFW_DOCKER_DEST exists but is not a regular file (a directory?), so ufw-docker was not installed; Docker-published ports would bypass the firewall. Remove it, then run the installer again"
    exit 1
  fi

  # An existing binary is never trusted blindly: it may be an older (or newer)
  # copy from the branch that used to move, and it runs as root.
  if [ -f "$UFW_DOCKER_DEST" ]; then
    actual="$(file_sha256 "$UFW_DOCKER_DEST")"
    if [ "$actual" = "$UFW_DOCKER_SHA256" ]; then
      log "ufw-docker already installed ($UFW_DOCKER_DEST matches the pinned checksum)"
      # The FILE being right says nothing about the RULES: a first run that was
      # interrupted between installing the file and running its own `install`
      # leaves exactly that, and no later run would ever write the rules.
      # Upstream's `install` is idempotent — it rewrites /etc/ufw/after.rules
      # only when its own check fails — so it is safe on every re-run. The curl
      # shim is still never called on this path.
      sudo_cmd "$UFW_DOCKER_DEST" install
      sudo_cmd ufw reload
      log "ufw reloaded — the ufw-docker rules are live"
      return 0
    fi
    warn "$UFW_DOCKER_DEST is not the pinned ufw-docker (sha256 ${actual:-unreadable}, expected $UFW_DOCKER_SHA256) — replacing it with the pinned copy"
  fi

  if ! tmp="$(mktemp)"; then
    error "Could not create a temp file to download ufw-docker, so it was not installed; Docker-published ports would bypass the firewall. Check your network, then run the installer again"
    exit 1
  fi
  if ! "$CROW_CURL" -fsSL "$UFW_DOCKER_URL" -o "$tmp"; then
    rm -f "$tmp"
    error "Could not download ufw-docker from the pinned commit $UFW_DOCKER_COMMIT, so it was not installed; Docker-published ports would bypass the firewall. Check your network, then run the installer again"
    exit 1
  fi
  actual="$(file_sha256 "$tmp")"
  if [ "$actual" != "$UFW_DOCKER_SHA256" ]; then
    rm -f "$tmp"
    error "ufw-docker download did not match the pinned checksum, so it was not installed; Docker-published ports would bypass the firewall. The file upstream may have changed or been tampered with, or your network altered it: do not install it by hand. Run the installer again later, or report it."
    error "(got sha256 ${actual:-nothing}, the pinned commit $UFW_DOCKER_COMMIT is $UFW_DOCKER_SHA256)"
    exit 1
  fi
  # -T: the destination is treated as a FILE even when it is a directory or a
  # symlink to one, so a stray directory there is never filled with the file.
  sudo_cmd install -T -m 755 "$tmp" "$UFW_DOCKER_DEST"
  rm -f "$tmp"
  sudo_cmd "$UFW_DOCKER_DEST" install
  # ufw was enabled ABOVE, before ufw-docker rewrote /etc/ufw/after.rules, so
  # without this reload a published container port keeps bypassing the
  # firewall until the next reboot.
  sudo_cmd ufw reload
  log "ufw reloaded — the ufw-docker rules are live"
  log "ufw-docker installed (Docker/UFW conflict resolved)"
}

# ─── Third-party apt repositories, keyed by fingerprint (security audit K7) ──
# Node.js, Docker and Tailscale each come from their own apt repository, and
# that repository's signing key is what apt trusts when it installs packages AS
# ROOT. All three used to be wired up by piping a vendor script off the network
# into a root shell (`curl … | sudo sh` / `| sudo -E bash -`), which lets
# upstream — or whoever answers that request — decide what runs as root on this
# machine. Nothing is piped into a shell any more: the key is downloaded by the
# INVOKING USER into a temp file, its primary-key fingerprint is compared with a
# constant below, and only a matching key is installed (through sudo_cmd) before
# the apt source file is written. A key that does not match refuses the whole
# step and leaves no source file behind, so the repository is never trusted just
# because its download happened to succeed.
#
# A fingerprint and the URL it belongs to are bumped TOGETHER, in one edit: the
# fingerprint is what makes a new or replaced key visible instead of silently
# trusted. The constants below are plain assignments, so a stray exported
# variable can never change which key is pinned; only the suite swaps in its own
# throwaway fixture key, through the separately named CROW_TEST_*_KEY_FPR
# variables read right after the seams below.
DOCKER_KEY_URL_BASE="https://download.docker.com/linux"
DOCKER_KEY_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
NODESOURCE_KEY_URL="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
NODESOURCE_KEY_FPR="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
TAILSCALE_REPO_BASE="https://pkgs.tailscale.com/stable"
TAILSCALE_KEY_FPR="2596A99EAAB33821893C0A79458CA832957F5868"

# Test seams of the same kind as UFW_DOCKER_DEST and APT_CONF_DIR: the suite
# points every one of them into a scratch directory, so no test can read the
# real /etc/os-release, write under /etc/apt or /usr/share/keyrings, or reach
# the network. The defaults are the real ones. CROW_CURL, CROW_SUDO and
# CROW_APT come from the steps above.
DOCKER_KEY_FPR="${CROW_TEST_DOCKER_KEY_FPR:-$DOCKER_KEY_FPR}"
NODESOURCE_KEY_FPR="${CROW_TEST_NODESOURCE_KEY_FPR:-$NODESOURCE_KEY_FPR}"
TAILSCALE_KEY_FPR="${CROW_TEST_TAILSCALE_KEY_FPR:-$TAILSCALE_KEY_FPR}"
CROW_GPG="${CROW_GPG:-gpg}"
CROW_OS_RELEASE="${CROW_OS_RELEASE:-/etc/os-release}"
VENDOR_KEY_DIR="${VENDOR_KEY_DIR:-/etc/apt/keyrings}"
USR_KEYRING_DIR="${USR_KEYRING_DIR:-/usr/share/keyrings}"
APT_SOURCES_DIR="${APT_SOURCES_DIR:-/etc/apt/sources.list.d}"
CROW_DPKG_ARCH_CMD="${CROW_DPKG_ARCH_CMD:-dpkg --print-architecture}"

# crow_gpg_stop <gnupg_home> — stop the gpg-agent/dirmngr helpers a private
# GNUPGHOME started, so removing the directory leaves no process behind.
crow_gpg_stop() {
  gpgconf --homedir "$1" --kill all >/dev/null 2>&1 || true
}

# os_release_field <file> <KEY> — the value of KEY= in an os-release file, with
# the quotes stripped; empty when the file or the key is absent.
os_release_field() {
  local file="$1" key="$2" line="" value=""
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) value="${line#"$key="}"; break ;;
    esac
  done < "$file"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

# vendor_repo_target [os_release_file] — prints "<flavor> <codename>" for the
# vendor apt repositories, where flavor is ubuntu, debian or raspbian; returns 1
# and prints nothing when those repositories do not serve this distribution.
# Derivative distributions are resolved through ID_LIKE only when the vendor
# also sets the codename variable that goes with it (Mint and Pop set
# UBUNTU_CODENAME, LMDE sets DEBIAN_CODENAME): a guessed codename is a
# repository that 404s, so anything else — Kali, a rolling codename such as
# kali-rolling, an empty codename — is refused here instead.
# shellcheck disable=SC2120  # the file is a test seam; the prod call passes none
vendor_repo_target() {
  local file="${1:-$CROW_OS_RELEASE}"
  local id="" id_like="" ubuntu_codename="" debian_codename="" codename="" flavor=""
  id="$(os_release_field "$file" ID)"
  id_like="$(os_release_field "$file" ID_LIKE)"
  ubuntu_codename="$(os_release_field "$file" UBUNTU_CODENAME)"
  debian_codename="$(os_release_field "$file" DEBIAN_CODENAME)"
  case "$id" in
    ubuntu)
      flavor="ubuntu"
      codename="${ubuntu_codename:-$(os_release_field "$file" VERSION_CODENAME)}" ;;
    debian)
      flavor="debian"
      codename="$(os_release_field "$file" VERSION_CODENAME)" ;;
    raspbian)
      flavor="raspbian"
      codename="$(os_release_field "$file" VERSION_CODENAME)" ;;
    *)
      if [[ " $id_like " == *" ubuntu "* ]] && [ -n "$ubuntu_codename" ]; then
        flavor="ubuntu"; codename="$ubuntu_codename"
      elif [[ " $id_like " == *" debian "* ]] && [ -n "$debian_codename" ]; then
        flavor="debian"; codename="$debian_codename"
      fi ;;
  esac
  [ -n "$flavor" ] || return 1
  # A codename apt can use is a plain lowercase word.
  case "$codename" in
    ""|*[!a-z]*) return 1 ;;
  esac
  printf '%s %s\n' "$flavor" "$codename"
}

# fetch_verified_key <url> <expected_fpr> <dest> — download a repository signing
# key, refuse it unless it holds EXACTLY ONE primary key and that key's
# fingerprint is <expected_fpr>, and only then install it (mode 644) at <dest>.
# The download and the inspection both run as the INVOKING USER, in temp
# locations; root only ever `install`s a file whose bytes were checked here. The
# key is inspected in a fresh private GNUPGHOME, so nothing in the operator's
# own keyring can add, hide or vouch for a key. Every failure path prints an
# `error` naming the URL and the expected/got fingerprint, removes its temp
# files, and returns 1 WITHOUT touching <dest>.
fetch_verified_key() {
  local url="$1" expected="$2" dest="$3"
  local tmp="" gnupg_home="" cols="" pub_count=0 first_fpr="" got="" line=""

  if ! tmp="$(mktemp)"; then
    error "Could not create a temp file to download the signing key $url, so its apt repository was not added. Check the machine, then run the installer again"
    return 1
  fi
  if ! "$CROW_CURL" -fsSL --proto '=https' --tlsv1.2 -o "$tmp" "$url"; then
    rm -f "$tmp"
    error "Could not download the signing key $url (expected fingerprint $expected), so its apt repository was not added. Check your network, then run the installer again"
    return 1
  fi
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    error "The download from $url was empty (expected fingerprint $expected), so its apt repository was not added"
    return 1
  fi
  if ! gnupg_home="$(mktemp -d)"; then
    rm -f "$tmp"
    error "Could not create a temp keyring to inspect the signing key $url, so its apt repository was not added"
    return 1
  fi
  # IMPORT into the private home and read the keys back from there (not
  # `--show-keys` on the raw file): the installed bytes below are an EXPORT of
  # the one verified key, never the downloaded file. A download that carried
  # extra packets after the vendor key (a secret-key block that gpg lists
  # without counting as a primary, or a key version gpg skips but apt's own
  # verifier accepts) would otherwise be trusted by apt under Signed-By.
  if ! GNUPGHOME="$gnupg_home" "$CROW_GPG" --batch --import "$tmp" >/dev/null 2>&1; then
    crow_gpg_stop "$gnupg_home"; rm -rf "$gnupg_home"; rm -f "$tmp"
    error "gpg could not import the signing key from $url (expected fingerprint ${expected^^}), so its apt repository was not added. Check your network or gpg, then run the installer again"
    return 1
  fi
  cols="$(GNUPGHOME="$gnupg_home" "$CROW_GPG" --batch --with-colons --list-keys 2>/dev/null || true)"
  # `pub:` counts primary keys; the FIRST `fpr:` line is the primary key's own
  # fingerprint (a subkey's fpr line comes after it), and field 10 of a colon
  # record is the fingerprint itself.
  while IFS= read -r line; do
    case "$line" in
      pub:*) pub_count=$((pub_count + 1)) ;;
      fpr:*)
        if [ -z "$first_fpr" ]; then
          first_fpr="$(printf '%s\n' "$line" | cut -d: -f10)"
        fi ;;
    esac
  done <<< "$cols"
  if [ "$pub_count" -eq 1 ] && [ -n "$first_fpr" ]; then
    got="${first_fpr^^}"
  fi
  if [ "$pub_count" -ne 1 ] || [ "$got" != "${expected^^}" ]; then
    crow_gpg_stop "$gnupg_home"; rm -rf "$gnupg_home"; rm -f "$tmp"
    error "The signing key at $url was refused: expected fingerprint ${expected^^}, got ${got:-nothing} in $pub_count primary key(s). Its apt repository was not added, so nothing installs from it. Check your network or gpg, then run the installer again"
    return 1
  fi
  # Re-export ONLY the verified key (public parts, minimal): armored for a .asc
  # destination, binary for a .gpg one. That file replaces the download.
  local exported="" armor_flag=""
  case "$dest" in *.asc) armor_flag="--armor" ;; esac
  if ! exported="$(mktemp)"; then
    crow_gpg_stop "$gnupg_home"; rm -rf "$gnupg_home"; rm -f "$tmp"
    error "Could not create a temp file for the signing key from $url, so its apt repository was not added"
    return 1
  fi
  # shellcheck disable=SC2086  # armor_flag is empty or one fixed flag
  if ! GNUPGHOME="$gnupg_home" "$CROW_GPG" --batch --export-options export-minimal $armor_flag --export "${expected^^}" > "$exported" 2>/dev/null || [ ! -s "$exported" ]; then
    crow_gpg_stop "$gnupg_home"; rm -rf "$gnupg_home"; rm -f "$tmp" "$exported"
    error "gpg could not export the verified signing key from $url, so its apt repository was not added"
    return 1
  fi
  crow_gpg_stop "$gnupg_home"; rm -rf "$gnupg_home"
  rm -f "$tmp"
  tmp="$exported"
  if ! sudo_cmd install -d -m 0755 "$(dirname "$dest")"; then
    rm -f "$tmp"
    error "Could not create $(dirname "$dest"), so the signing key from $url was not installed and its apt repository was not added"
    return 1
  fi
  if ! sudo_cmd install -m 644 "$tmp" "$dest"; then
    rm -f "$tmp"
    error "Could not install the signing key from $url at $dest, so its apt repository was not added"
    return 1
  fi
  rm -f "$tmp"
  return 0
}

# install_docker_repo — Docker's official apt repository: verified key first,
# then the deb822 source file, then the packages. Writes no source file (and so
# trusts no repository) when the key does not match or the distribution is not
# one Docker serves.
install_docker_repo() {
  local target="" flavor="" codename="" repo_path="debian" arch=""
  local key_path="$VENDOR_KEY_DIR/docker.asc" src_path="$APT_SOURCES_DIR/docker.sources" tmp=""

  if ! apt_install ca-certificates curl gnupg; then
    error "Could not install ca-certificates, curl and gnupg, which are needed to add Docker's apt repository"
    return 1
  fi

  # shellcheck disable=SC2119  # defaults (the real os-release) are intended here
  if ! target="$(vendor_repo_target)"; then
    error "Docker has no apt repository for this distribution (ID '$(os_release_field "$CROW_OS_RELEASE" ID)', codename '$(os_release_field "$CROW_OS_RELEASE" VERSION_CODENAME)'), so Docker was not installed."
    error "Install Docker from the instructions at https://docs.docker.com/engine/install/, then run the installer again."
    return 1
  fi
  flavor="${target%% *}"
  codename="${target#* }"
  # Docker's own repository is published as `ubuntu` and `debian`; Raspberry Pi
  # OS takes the Debian one (its arm packages live there).
  # Raspberry Pi OS is always 32-bit armhf (a 64-bit one reports itself as
  # Debian); Docker still publishes a raspbian repository for the releases up to
  # bookworm and none for trixie, which takes the Debian one.
  case "$flavor:$codename" in
    ubuntu:*) repo_path="ubuntu" ;;
    raspbian:bullseye|raspbian:bookworm) repo_path="raspbian" ;;
  esac

  # deb822 lets the architecture be cast explicitly, so apt resolves the same
  # architectures dpkg reports for this machine. Word-split on purpose: the seam
  # carries the probe command AND its flag.
  # shellcheck disable=SC2086
  arch="$($CROW_DPKG_ARCH_CMD 2>/dev/null || true)"
  if [ -z "$arch" ]; then
    error "Could not read this machine's dpkg architecture, so the Docker apt repository was not added; install Docker from https://docs.docker.com/engine/install/ instead"
    return 1
  fi

  fetch_verified_key "$DOCKER_KEY_URL_BASE/$repo_path/gpg" "$DOCKER_KEY_FPR" "$key_path" || return 1

  if ! tmp="$(mktemp)"; then
    error "Could not create a temp file for $src_path, so the Docker apt repository was not added"
    return 1
  fi
  if ! cat > "$tmp" <<CRODOCKEREOF
Types: deb
URIs: $DOCKER_KEY_URL_BASE/$repo_path
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: $key_path
CRODOCKEREOF
  then
    rm -f "$tmp"
    error "Could not write the Docker apt source to a temp file, so its repository was not added"
    return 1
  fi
  if ! sudo_cmd install -d -m 0755 "$APT_SOURCES_DIR" || ! sudo_cmd install -m 644 "$tmp" "$src_path"; then
    rm -f "$tmp"
    error "Could not write $src_path, so the Docker apt repository was not added"
    return 1
  fi
  rm -f "$tmp"

  if ! sudo_cmd "$CROW_APT" update; then
    error "apt update failed after Docker's repository was added"
    return 1
  fi
  if ! apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    error "apt could not install Docker from its official repository"
    return 1
  fi
  log "Docker apt repository added (signing key $DOCKER_KEY_FPR)"
  return 0
}

# install_nodesource_repo <major> — NodeSource's apt repository for Node <major>.
# The old path piped NodeSource's setup script into a root bash, which also left
# a nodesource.list + nodesource.gpg pair behind; those are removed so apt has
# exactly one NodeSource source and one key. The downloaded key stays armored:
# apt reads it as well from a file named .asc, and upstream ships it that way.
install_nodesource_repo() {
  local major="${1:-}"
  local key_path="$VENDOR_KEY_DIR/nodesource.asc" src_path="$APT_SOURCES_DIR/nodesource.sources" tmp=""
  local legacy=""

  case "$major" in
    ""|*[!0-9]*)
      error "install_nodesource_repo needs a numeric Node.js major version (got '${major}'), so the NodeSource repository was not added"
      return 1 ;;
  esac

  if ! apt_install ca-certificates curl gnupg; then
    error "Could not install ca-certificates, curl and gnupg, which are needed to add NodeSource's apt repository"
    return 1
  fi
  fetch_verified_key "$NODESOURCE_KEY_URL" "$NODESOURCE_KEY_FPR" "$key_path" || return 1

  # The key is checked before anything of the old setup is taken away: a failed
  # download must not leave this host without a Node repository at all.
  for legacy in "$APT_SOURCES_DIR/nodesource.list" "$VENDOR_KEY_DIR/nodesource.gpg" "$USR_KEYRING_DIR/nodesource.gpg"; do
    if [ -e "$legacy" ] || [ -L "$legacy" ]; then
      if sudo_cmd rm -f "$legacy"; then
        log "Removed the legacy NodeSource file $legacy"
      else
        warn "Could not remove the legacy NodeSource file $legacy"
      fi
    fi
  done

  if ! tmp="$(mktemp)"; then
    error "Could not create a temp file for $src_path, so the NodeSource apt repository was not added"
    return 1
  fi
  if ! cat > "$tmp" <<CRONODEEOF
Types: deb
URIs: https://deb.nodesource.com/node_${major}.x
Suites: nodistro
Components: main
Signed-By: $key_path
CRONODEEOF
  then
    rm -f "$tmp"
    error "Could not write the NodeSource apt source to a temp file, so its repository was not added"
    return 1
  fi
  if ! sudo_cmd install -d -m 0755 "$APT_SOURCES_DIR" || ! sudo_cmd install -m 644 "$tmp" "$src_path"; then
    rm -f "$tmp"
    error "Could not write $src_path, so the NodeSource apt repository was not added"
    return 1
  fi
  rm -f "$tmp"

  if ! sudo_cmd "$CROW_APT" update; then
    error "apt update failed after NodeSource's repository was added"
    return 1
  fi
  if ! apt_install nodejs; then
    error "apt could not install Node.js from NodeSource's repository"
    return 1
  fi
  log "Node.js ${major} apt repository added (signing key $NODESOURCE_KEY_FPR)"
  return 0
}

# install_tailscale_repo — Tailscale's official apt repository. Its key is the
# binary (dearmored) file upstream publishes per distribution and codename, so
# it lands at the .gpg path apt expects, and the source file is the one-line
# style Tailscale documents.
install_tailscale_repo() {
  local target="" flavor="" codename=""
  local key_path="$USR_KEYRING_DIR/tailscale-archive-keyring.gpg" src_path="$APT_SOURCES_DIR/tailscale.list" tmp=""

  if ! apt_install ca-certificates curl gnupg; then
    error "Could not install ca-certificates, curl and gnupg, which are needed to add Tailscale's apt repository"
    return 1
  fi

  # shellcheck disable=SC2119  # defaults (the real os-release) are intended here
  if ! target="$(vendor_repo_target)"; then
    error "Tailscale has no apt repository for this distribution (ID '$(os_release_field "$CROW_OS_RELEASE" ID)', codename '$(os_release_field "$CROW_OS_RELEASE" VERSION_CODENAME)'), so Tailscale was not installed."
    error "Install Tailscale from https://tailscale.com/download, then run the installer again."
    return 1
  fi
  flavor="${target%% *}"
  codename="${target#* }"

  fetch_verified_key "$TAILSCALE_REPO_BASE/$flavor/$codename.noarmor.gpg" "$TAILSCALE_KEY_FPR" "$key_path" || return 1

  if ! tmp="$(mktemp)"; then
    error "Could not create a temp file for $src_path, so the Tailscale apt repository was not added"
    return 1
  fi
  if ! printf 'deb [signed-by=%s] %s/%s %s main\n' "$key_path" "$TAILSCALE_REPO_BASE" "$flavor" "$codename" > "$tmp"; then
    rm -f "$tmp"
    error "Could not write the Tailscale apt source to a temp file, so its repository was not added"
    return 1
  fi
  if ! sudo_cmd install -d -m 0755 "$APT_SOURCES_DIR" || ! sudo_cmd install -m 644 "$tmp" "$src_path"; then
    rm -f "$tmp"
    error "Could not write $src_path, so the Tailscale apt repository was not added"
    return 1
  fi
  rm -f "$tmp"

  if ! sudo_cmd "$CROW_APT" update; then
    error "apt update failed after Tailscale's repository was added"
    return 1
  fi
  if ! apt_install tailscale tailscale-archive-keyring; then
    error "apt could not install Tailscale from its official repository"
    return 1
  fi
  log "Tailscale apt repository added (signing key $TAILSCALE_KEY_FPR)"
  return 0
}

# ─── The `crow` command on PATH (install re-run N4-1) ─────
# ONE exact line, compared whole. The old guard grepped for "crow/scripts",
# which the line it writes never contains ($CROW_APP is ~/.crow/app), so every
# re-run appended another copy of the same export.
CROW_PATH_LINE="export PATH=\"\$PATH:$CROW_APP/scripts\""

# add_crow_to_path — add that line once; anything else in the file is left
# exactly as the operator has it.
add_crow_to_path() {
  if [ -f "$HOME/.bashrc" ] && grep -qxF -- "$CROW_PATH_LINE" "$HOME/.bashrc"; then
    return 0
  fi
  # A .bashrc whose last line carries no trailing newline would otherwise have
  # the export glued onto it: that changes the operator's own last line (and
  # breaks ours). `tail -c 1` prints nothing when the last byte IS a newline
  # (the substitution strips it), so a non-empty output means "add one" first.
  if [ -s "$HOME/.bashrc" ] && [ "$(tail -c 1 "$HOME/.bashrc")" != "" ]; then
    printf '\n' >> "$HOME/.bashrc"
  fi
  printf '%s\n' "$CROW_PATH_LINE" >> "$HOME/.bashrc"
  log "Added 'crow' command to PATH (restart shell or run: source ~/.bashrc)"
}

# clone_crow_release <dest> — clone Crow and leave the checkout on a LOCAL
# branch named main, at the release this script pins (CROW_INSTALL_REF).
# The gateway's auto-updater only pulls when HEAD is the branch `main`
# (servers/gateway/auto-update.js), so a detached checkout at a tag would never
# update again. `-B main <ref>` puts the working tree at the pinned commit while
# keeping a real main branch, and the upstream is origin/main, so the updater's
# `git pull --ff-only` fast-forwards onto main (only while the pinned commit is
# an ancestor of main). CROW_INSTALL_REF=main keeps the plain clone.
clone_crow_release() {
  local dest="$1"
  git clone "$CROW_REPO_URL" "$dest"
  if [ "$CROW_INSTALL_REF" = "main" ]; then
    return 0
  fi
  # A plain clone already has origin/main (the remote's default branch); fetch
  # it only when the remote's default branch is something else.
  if ! git -C "$dest" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
    git -C "$dest" fetch origin main
  fi
  # Prefer the tag object: a name like v1.1.0 could also be a branch on the
  # remote, and the tag is what the release checklist pins.
  if git -C "$dest" rev-parse --verify --quiet "refs/tags/$CROW_INSTALL_REF^{commit}" >/dev/null; then
    git -C "$dest" checkout -q -B main "refs/tags/$CROW_INSTALL_REF"
  elif git -C "$dest" rev-parse --verify --quiet "origin/$CROW_INSTALL_REF^{commit}" >/dev/null; then
    git -C "$dest" checkout -q -B main "origin/$CROW_INSTALL_REF"
  else
    git -C "$dest" checkout -q -B main "$CROW_INSTALL_REF"
  fi
  git -C "$dest" branch --set-upstream-to=origin/main main
}

# Test seam: tests source the helpers without executing the install.
if [ "${CROW_INSTALL_SOURCE_ONLY:-}" = "1" ]; then
  # shellcheck disable=SC2317  # exit IS reachable: `return` fails when the
  # script is executed (not sourced), and the fallback exit then runs.
  return 0 2>/dev/null || exit 0
fi

# Platform gate (Item 4-PR5): refuse non-Debian/Ubuntu hosts before ANY
# system mutation — a half-install on the wrong distro is worse than none.
# shellcheck disable=SC2119  # defaults (real /etc/os-release, apt-get) are intended here
if ! check_platform; then
  error "Unsupported platform: this installer supports Debian/Ubuntu family systems only"
  error "(Debian, Ubuntu, Raspberry Pi OS, and derivatives — it installs via apt)."
  error "For macOS, Windows, or other Linux distributions, follow the manual setup"
  error "path in docs/getting-started/ (https://github.com/kh0pper/crow/tree/main/docs/getting-started)."
  exit 1
fi

# Check if running as root (we don't want that)
if [ "$(id -u)" -eq 0 ]; then
  error "Don't run this script as root. Run as your normal user."
  error "The script will use sudo when it needs elevated privileges."
  exit 1
fi

# Check for sudo
if ! command -v sudo >/dev/null 2>&1; then
  error "sudo is required. Install it first: su -c 'apt install sudo'"
  exit 1
fi

header "Crow Installer"

echo ""
echo "  Requires a Debian/Ubuntu family system (installs via apt)."
echo ""
echo "  This script will install:"
echo "    - Node.js ${NODE_MAJOR}"
echo "    - bubblewrap (the bots' sandbox)"
echo "    - Docker + Docker Compose"
echo "    - Caddy (reverse proxy)"
echo "    - Crow"
echo "    - Automatic security updates (unattended-upgrades, reboots stay manual)"
echo "    - Security hardening (UFW + fail2ban)"
echo "    - Tailscale (offered if not installed — secure remote access)"
echo "    - Tailscale hostname setup (if Tailscale is installed)"
echo ""
if ! ask_yn "Continue?" Y; then
  echo "  Cancelled."
  exit 0
fi

# ─── Pre-flight: ports 3001, 80, 443 ─────────────────────
# Before anything is installed or started: if another program already owns one
# of the ports Crow binds, stop now with a sentence the operator can act on
# instead of half-finishing an install that nothing can reach.
header "Pre-flight: ports 3001, 80 and 443"
if ! check_ports_free; then
  exit 1
fi
log "Ports 3001, 80 and 443 are available"

# ─── Step 1: System updates ──────────────────────────────

header "Step 1/10: System Updates"

sudo apt update
sudo apt upgrade -y
log "System updated"

# ─── Step 2: Install Node.js ─────────────────────────────
# Node.js comes from NodeSource's apt repository, wired up by
# install_nodesource_repo: its signing key is checked against a pinned
# fingerprint before the source file exists (security audit K7 — the vendor
# setup script is no longer downloaded and piped into a root shell).

header "Step 2/10: Node.js ${NODE_MAJOR}"

if command -v node >/dev/null 2>&1; then
  CURRENT_NODE=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$CURRENT_NODE" -ge "$NODE_MAJOR" ]; then
    log "Node.js $(node --version) already installed"
  else
    warn "Node.js $(node --version) is too old, upgrading..."
    install_nodesource_repo "$NODE_MAJOR" || exit 1
    log "Node.js $(node --version) installed"
  fi
else
  install_nodesource_repo "$NODE_MAJOR" || exit 1
  log "Node.js $(node --version) installed"
fi

# libatomic is needed by rocksdb-native's prebuilt addon (pulled in through
# hyperswarm); minimal server and cloud images do not ship it. Installed here,
# on both Node paths, before any dependency install runs.
sudo apt install -y libatomic1

# bubblewrap is what wraps every bot's pi child (scripts/pi-bots/pi_sandbox.mjs:
# its own user/PID namespace, docker sockets masked, no_new_privs). Without it a
# bot runs with this user's groups and sudo. Installed here for both Node paths,
# and BEFORE Step 5 turns on the auto-update timer — a later apt call would have
# to wait for the dpkg lock. Ubuntu's own bwrap-userns-restrict AppArmor profile,
# right after it, is what makes bwrap work on Ubuntu 24.04+, where unprivileged
# user namespaces are restricted: bwrap may create the namespace, and everything
# it runs has every capability use denied. That step only DOWNLOADS apparmor-profiles and
# takes the one file — it never installs the package (its 19 other profiles would
# confine samba, avahi and friends on this machine).
sudo apt install -y bubblewrap
install_bwrap_apparmor

# ─── Step 3: Install Docker ──────────────────────────────
# Docker comes from its own apt repository, wired up by install_docker_repo with
# the same pinned-key check as Node.js (security audit K7).

header "Step 3/10: Docker"

if command -v docker >/dev/null 2>&1; then
  log "Docker already installed: $(docker --version)"
else
  install_docker_repo || exit 1
  sudo usermod -aG docker "$USER"
  log "Docker installed"
fi

# ─── Step 4: Install Caddy ───────────────────────────────

header "Step 4/10: Caddy"

if command -v caddy >/dev/null 2>&1; then
  log "Caddy already installed: $(caddy version)"
else
  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt update
  sudo apt install -y caddy
  log "Caddy installed"
fi

# The gateway's dedicated proxy socket (the security audit's finding) is owned
# by systemd, not by the gateway: crow-gateway-proxy.socket listens on
# /run/crow-proxy/gateway.sock as root:caddy with mode 0660, and the gateway
# receives that listening fd by socket activation. Caddy runs as the 'caddy'
# service user, which is why the socket's group is 'caddy' — no user is added to
# anybody's group, so Caddy never gains access to the operator's files.
if ! id caddy >/dev/null 2>&1 || ! getent group caddy >/dev/null 2>&1; then
  error "the 'caddy' user/group is missing — the proxy socket unit needs SocketGroup=caddy"
  exit 1
fi

# ─── Step 5: Automatic security updates ─────────────────
# Placed AFTER Docker and Caddy so their apt repositories exist: their origins
# are the three this step adds to unattended-upgrades (see install_auto_updates
# above). Nothing here restarts a service or reboots.
#
# From here on apt-daily-upgrade.timer can already be holding the dpkg lock when
# the remaining steps install a package, so every later apt call passes
# `-o DPkg::Lock::Timeout=300`: apt waits for the timer instead of taking the
# lock error and, under `set -e`, stopping the install. Keeping this step here
# (rather than moving it to the end) leaves it next to the repositories it names;
# the three later calls are the only apt calls left after it.

header "Step 5/10: Automatic Security Updates"

install_auto_updates

# ─── Step 6: Install Avahi (mDNS for crow.local) ─────────

header "Step 6/10: mDNS (crow.local)"

if dpkg -l avahi-daemon >/dev/null 2>&1; then
  log "Avahi already installed"
else
  sudo apt install -y -o DPkg::Lock::Timeout=300 avahi-daemon
  log "Avahi installed"
fi

# Set hostname to 'crow' for crow.local resolution
CURRENT_HOSTNAME=$(hostname)
if [ "$CURRENT_HOSTNAME" != "crow" ]; then
  # Renaming the machine is destructive under automation (F-INSTALL-11):
  # default NO, headless never renames. When skipped, Caddy serves
  # <hostname>.local instead of crow.local (below).
  if ask_yn "Set hostname to 'crow' (enables crow.local)?" N; then
    sudo hostnamectl set-hostname crow
    log "Hostname set to 'crow' — accessible as crow.local on your network"
  else
    warn "Keeping hostname '$CURRENT_HOSTNAME' — Crow will be at https://${CURRENT_HOSTNAME}.local"
  fi
fi
MDNS_HOST="$(hostname).local"

# ─── Step 7: Clone and Setup Crow ────────────────────────

header "Step 7/10: Crow Platform"

mkdir -p "$CROW_HOME"

if [ -d "$CROW_APP" ]; then
  log "Crow already cloned at $CROW_APP"
  cd "$CROW_APP"
  git pull --ff-only 2>/dev/null || warn "Could not pull latest — continuing with existing version"
else
  clone_crow_release "$CROW_APP"
  log "Cloned Crow to $CROW_APP"
  cd "$CROW_APP"
fi

# Set environment for ~/.crow/data
mkdir -p "$CROW_DATA"
export CROW_DATA_DIR="$CROW_DATA"

npm run setup
log "Crow setup complete"

# Generate identity
npm run identity 2>/dev/null || true
log "Identity generated"

# Create .env with secure permissions
if [ ! -f "$CROW_HOME/.env" ]; then
  cp .env.example "$CROW_HOME/.env"
  chmod 600 "$CROW_HOME/.env"
  # Point CROW_DB_PATH to the right place
  sed -i "s|CROW_DB_PATH=./data/crow.db|CROW_DB_PATH=$CROW_DATA/crow.db|" "$CROW_HOME/.env"
  log "Created $CROW_HOME/.env (permissions 600)"
fi

# Symlink .env into app directory
if [ ! -L "$CROW_APP/.env" ]; then
  ln -sf "$CROW_HOME/.env" "$CROW_APP/.env"
fi

# ─── Step 8: Security Hardening ──────────────────────────
# The firewall comes UP BEFORE any Crow unit is enabled or started (security
# audit N1c-15): a half-finished install — or the seconds between starting the
# gateway and closing its port — must never be reachable. Nothing here needs
# Crow running; ufw-docker only needs Docker (Step 3).
# Scope: "nothing listens before the firewall" is a claim about Crow's own units;
# `apt install caddy` (Step 4) starts Caddy's default site on :80/:443 itself.

header "Step 8/10: Security"

# UFW firewall
if command -v ufw >/dev/null 2>&1; then
  log "UFW already installed"
else
  sudo apt install -y -o DPkg::Lock::Timeout=300 ufw
fi

sudo ufw default deny incoming
sudo ufw default allow outgoing
# SSH is allowed FIRST and unconditionally: `ufw --force enable` two blocks down
# would cut a remote operator's session the instant it ran if the port that
# session arrived on were not open. 22 is the always-safe rule; ssh_ports adds
# any other port this host's sshd is actually configured for.
sudo ufw allow 22/tcp comment 'SSH'
# shellcheck disable=SC2119  # no args on purpose: the helper defaults to this host's sshd config
SSH_EXTRA_PORTS="$(ssh_ports)"
while IFS= read -r _ssh_port; do
  if [ -z "$_ssh_port" ] || [ "$_ssh_port" = "22" ]; then continue; fi
  sudo ufw allow "${_ssh_port}/tcp" comment 'SSH'
done <<< "$SSH_EXTRA_PORTS"

# 443 serves only Caddy's LAN vhost (https://${MDNS_HOST}); on a cloud VM
# that is an unintended PUBLIC surface (F-INSTALL-2). Cloud heuristic: the
# link-local metadata endpoint answers on AWS/Oracle/GCP/Azure/DO and never
# on home LANs. (Local-address checks don't work — Oracle NATs a private IP.)
IS_CLOUD_HOST=false
if curl -s -m 2 -o /dev/null http://169.254.169.254/ 2>/dev/null; then
  IS_CLOUD_HOST=true
fi
OPEN_443_DEFAULT=Y
if [ "$IS_CLOUD_HOST" = true ]; then
  OPEN_443_DEFAULT=N
  warn "Cloud/VPS environment detected — opening 443 would expose it to the internet."
fi
if ask_yn "Open port 443 for LAN access to https://${MDNS_HOST}?" "$OPEN_443_DEFAULT"; then
  sudo ufw allow 443/tcp comment 'HTTPS (Caddy)'
  log "Port 443 open (LAN HTTPS via Caddy)"
else
  warn "Port 443 closed — use Tailscale for remote access"
fi

sudo ufw --force enable
log "Firewall enabled"

# Install ufw-docker to fix Docker/UFW conflict. Pinned to a commit and verified
# against a sha256 in a temp file BEFORE it is installed, because the file runs as
# root — and without it a published container port bypasses the firewall, so a
# download that cannot be verified ends the install (install_ufw_docker, above).
install_ufw_docker

# Fail2ban
if command -v fail2ban-client >/dev/null 2>&1; then
  log "fail2ban already installed"
else
  sudo apt install -y -o DPkg::Lock::Timeout=300 fail2ban
  sudo systemctl enable --now fail2ban
  log "fail2ban installed and enabled"
fi

# ─── Step 9: Configure Services ──────────────────────────
# Only now, with the firewall already up, are the units written and started.

header "Step 9/10: System Services"

# The gateway's proxy socket — SYSTEMD owns it, as root:caddy 0660, so only the
# local Caddy can open it. A loopback dial carrying X-Forwarded-For from
# anywhere else (a bot running as the gateway's own user included) stays an
# unverifiable peer, and the gateway never creates, chmods or unlinks the path.
# Enable and start it BEFORE the gateway, which receives its fd by activation.
sudo tee /etc/systemd/system/crow-gateway-proxy.socket > /dev/null << 'SOCKETEOF'
[Unit]
Description=Crow gateway proxy socket (for the local Caddy only)
[Socket]
ListenStream=/run/crow-proxy/gateway.sock
Service=crow-gateway.service
SocketUser=root
SocketGroup=caddy
SocketMode=0660
DirectoryMode=0755
[Install]
WantedBy=sockets.target
SOCKETEOF

# The boot guard's launcher, installed OUTSIDE the checkout (audit N1c-3 L1):
# the unit below runs it before every start, and any gateway that stays up for
# ten minutes refreshes this copy from its own commit.
mkdir -p "$CROW_HOME/boot-guard"
chmod 700 "$CROW_HOME/boot-guard"
install -m 600 scripts/boot-guard/crow-boot-guard.mjs "$CROW_HOME/boot-guard/crow-boot-guard.mjs"
log "Boot guard installed at $CROW_HOME/boot-guard"

# Crow Gateway systemd service
sudo tee /etc/systemd/system/crow-gateway.service > /dev/null << EOF
[Unit]
Description=Crow Gateway
Wants=network-online.target
After=network-online.target docker.service tailscaled.service
After=crow-gateway-proxy.socket
Requires=docker.service
# The dedicated proxy socket Caddy dials (the security audit's finding): a
# loopback connection carrying X-Forwarded-For is unverifiable (any local
# process can write the same header), so Caddy's visitors would be turned away
# by the dashboard's network gate. CROW_TRUSTED_PROXIES=loopback is not the fix
# (it makes every same-box caller the proxy and breaks the loopback-only doors).
# systemd owns the socket (root:caddy 0660) and passes this service its
# listening fd by socket activation — see the socket unit above (Sockets= is
# a [Service] key; Requires=/After= stay here).
Requires=crow-gateway-proxy.socket

[Service]
Sockets=crow-gateway-proxy.socket
Type=simple
User=$USER
WorkingDirectory=$CROW_APP
ExecStart=$(which node) servers/gateway/index.js
# Audit N1c-3 Layer 1: the boot guard. It runs before EVERY start (including
# every automatic restart) and counts real crash exits; after three of them it
# moves main back to the last commit this host booted, so a commit that throws
# while loading is never a forever crash loop. It is executed from
# $CROW_HOME/boot-guard/, a copy OUTSIDE this checkout, because the failing
# commit's own copy cannot be trusted to roll itself back. The '-' prefix keeps
# a guard failure from blocking the start, and TimeoutStartSec covers the
# guard's own npm install (up to 5 minutes) plus a rollback. Every path is
# quoted (a home directory may contain a space) and a literal % is escaped as
# %%, or systemd reads it as a specifier and the guard never starts.
ExecStartPre=-$(sd_quote "$(which node)") $(sd_quote "$CROW_HOME/boot-guard/crow-boot-guard.mjs") --app-root $(sd_quote "$CROW_APP")
ExecStopPost=-$(sd_quote "$(which node)") $(sd_quote "$CROW_HOME/boot-guard/crow-boot-guard.mjs") --app-root $(sd_quote "$CROW_APP") --record-exit
TimeoutStartSec=15min
Environment=CROW_BOOT_GUARD=1
Restart=on-failure
RestartSec=5
# 78 = refused instance paths (servers/shared/crow-home.js): a config error, not a crash
RestartPreventExitStatus=78
Environment=NODE_ENV=production
Environment=$(sd_quote "CROW_HOME=$CROW_HOME")
Environment=$(sd_quote "CROW_DATA_DIR=$CROW_DATA")
Environment=$(sd_quote "CROW_DB_PATH=$CROW_DATA/crow.db")

[Install]
WantedBy=multi-user.target
EOF

# Caddy's own admin API, moved off its default local TCP address (127.0.0.1,
# port 2019). That default has no authentication at all, so any local account —
# a default-tier bot included — could POST /load and rewrite the HTTPS front door
# this machine serves, which would undo the proxy socket's whole premise. Caddy
# runs as user `caddy` and cannot create a directory under /run, so systemd makes
# /run/caddy for it on every start: owned by the service user, mode 0750.
# `admin off` is deliberately NOT used — that would make `caddy reload` (the
# packaged unit's ExecReload, behind `sudo systemctl reload caddy`) impossible.
sudo mkdir -p /etc/systemd/system/caddy.service.d
sudo tee /etc/systemd/system/caddy.service.d/crow-admin-socket.conf > /dev/null << 'CADDYADMINEOF'
[Service]
RuntimeDirectory=caddy
RuntimeDirectoryMode=0750
CADDYADMINEOF

# Caddy reverse proxy with self-signed cert for the actual hostname.
# Caddy dials the gateway's dedicated proxy socket (the security audit's
# finding) rather than loopback: on a unix socket the gateway can tell Caddy's
# visitors apart from any other same-box caller and classifies them `proxy` with
# the client Caddy names. Caddy 2 ignores a client-sent X-Forwarded-For unless
# trusted_proxies is configured, so the rightmost hop it sends is the real client.
#
# The global block comes FIRST, because a global options block must, and it pins
# the admin API to a unix socket the drop-in above gives a directory for. No
# `|mode` suffix on purpose: in current Caddy the default mode for a unix listen
# address is 0200 — owner write only — and the process that creates the socket is
# the caddy user, so only that user and root can open it (the 0750 /run/caddy
# directory keeps every other account out whatever the mode). `caddy reload` reads that
# address from this same file, so the reload keeps working.
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
{
	admin unix//run/caddy/admin.sock
}

${MDNS_HOST} {
    tls internal
    reverse_proxy unix//run/crow-proxy/gateway.sock
}
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now crow-gateway-proxy.socket
sudo systemctl enable crow-gateway
# restart, not enable --now: a re-run must hand a running gateway the socket's fd
sudo systemctl restart crow-gateway
sudo systemctl restart caddy
log "Gateway service enabled and started"
log "Caddy configured for https://${MDNS_HOST}"

# The admin socket is created by Caddy itself as it starts, so it appears a
# moment after the service does. A socket that never appears still leaves the
# front door serving, so this is a warning, not a failed install — existing
# installs get a Fix-it card for it, and scripts/fix-caddy-admin-socket.sh is
# the one command behind that card.
ADMIN_SOCKET_READY=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  # /run/caddy is 0750 caddy:caddy, so only root can look inside it.
  if sudo test -S /run/caddy/admin.sock; then ADMIN_SOCKET_READY=1; break; fi
  sleep 0.5
done
if [ "$ADMIN_SOCKET_READY" -eq 1 ]; then
  log "Caddy's admin API is on unix//run/caddy/admin.sock (owner: the caddy user)"
  # The packaged unit's reload goes through that address; prove it still works.
  sudo systemctl reload caddy || warn "'systemctl reload caddy' failed with the admin socket — a Caddy restart still works"
else
  warn "Caddy's admin socket /run/caddy/admin.sock has not appeared — try: sudo systemctl restart caddy"
fi

# ─── Step 10: Tailscale Hostname ──────────────────────────

header "Step 10/10: Tailscale (Remote Access)"

if command -v tailscale &>/dev/null; then
  log "Tailscale is installed"

  if tailscale status &>/dev/null; then
    log "Tailscale is authenticated"

    # Capture status JSON ONCE — never pipe it (F-INSTALL-6).
    TS_JSON="$(tailscale status --json 2>/dev/null || true)"
    CURRENT_TS_HOSTNAME="$(ts_first_field HostName)"

    if [ "$CURRENT_TS_HOSTNAME" = "crow" ]; then
      log "Tailscale hostname is already set to 'crow'"
    elif [[ $TS_JSON =~ \"HostName\"[[:space:]]*:[[:space:]]*\"crow\" ]]; then
      warn "Tailscale hostname 'crow' is already taken by another device on your tailnet."
      TS_HOSTNAME="$(ask_line "Enter a Tailscale hostname (or press Enter to skip): ")"
      if [ -n "$TS_HOSTNAME" ]; then
        sudo tailscale set --hostname="$TS_HOSTNAME"
        log "Tailscale hostname set to '$TS_HOSTNAME'"
      else
        warn "Skipped Tailscale hostname setup"
      fi
    else
      # Destructive rename: default NO; headless installs never rename
      # (F-INSTALL-7 — the old default-Y renamed fresh nodes to 'crow').
      if ask_yn "Set Tailscale hostname to 'crow'?" N; then
        sudo tailscale set --hostname=crow
        log "Tailscale hostname set to 'crow'"
      else
        warn "Keeping Tailscale hostname '${CURRENT_TS_HOSTNAME:-unknown}'"
      fi
    fi

    # ── F-INSTALL-1: wire Tailscale Serve so the dashboard is reachable over
    # the tailnet with real HTTPS (and the gateway gets an HTTPS issuer URL —
    # without it a cloud install has NO reachable dashboard at all).
    # Serve is tailnet-only; this never touches Funnel (public exposure).
    GATEWAY_HTTPS_URL=""
    TS_DNSNAME="$(ts_first_field DNSName)"
    TS_DNSNAME="${TS_DNSNAME%.}"   # strip trailing dot
    if [ -n "$TS_DNSNAME" ]; then
      if ask_yn "Serve the dashboard at https://${TS_DNSNAME}/ (tailnet-only, recommended)?" Y; then
        if sudo tailscale serve --bg --https=443 http://127.0.0.1:3001 >/dev/null 2>&1; then
          GATEWAY_HTTPS_URL="https://${TS_DNSNAME}"
          log "Tailscale Serve wired: ${GATEWAY_HTTPS_URL}/ → localhost:3001 (tailnet only)"
          if grep -q '^CROW_GATEWAY_URL=' "$CROW_HOME/.env" 2>/dev/null; then
            sed -i "s|^CROW_GATEWAY_URL=.*|CROW_GATEWAY_URL=${GATEWAY_HTTPS_URL}|" "$CROW_HOME/.env"
          else
            printf '\nCROW_GATEWAY_URL=%s\n' "$GATEWAY_HTTPS_URL" >> "$CROW_HOME/.env"
          fi
          if sudo systemctl restart crow-gateway; then
            log "CROW_GATEWAY_URL=${GATEWAY_HTTPS_URL} written to $CROW_HOME/.env (gateway restarted)"
          else
            warn "Gateway restart failed — restart manually: sudo systemctl restart crow-gateway"
          fi
        else
          warn "tailscale serve failed — wire it later: sudo tailscale serve --bg --https=443 http://127.0.0.1:3001"
        fi
      else
        warn "Skipped Tailscale Serve — remote HTTPS access not configured"
      fi
    fi
  else
    warn "Tailscale is installed but not authenticated"
    warn "Run 'sudo tailscale up' to log in, then re-run this step"
  fi
else
  echo ""
  warn "Tailscale is not installed"
  # Item 4-PR5: offer Tailscale's own apt repository (security audit K7: the
  # repository is wired from a fingerprint-checked key instead of a downloaded
  # install script piped into a root shell). Default Y is safe headlessly —
  # installing is additive and inert until `sudo tailscale up` (no tailnet
  # mutation without authentication; contrast the rename prompts, default N).
  if ask_yn "Install Tailscale now (recommended for secure remote access)?" Y; then
    # Tailscale is optional here: Crow runs without it, so a failed install is
    # still only a warning. Its own `error` lines are counted and then taken
    # back out of INSTALL_ERRORS, so the closing "Crow is ready!" banner stays
    # reachable (an optional step that failed must not fail the whole install).
    ERRORS_BEFORE_TAILSCALE=$INSTALL_ERRORS
    if install_tailscale_repo; then
      log "Tailscale installed"
      warn "Tailscale is installed but not authenticated"
      warn "Run 'sudo tailscale up' to log in, then re-run this script to wire the hostname + HTTPS dashboard"
    else
      INSTALL_ERRORS=$ERRORS_BEFORE_TAILSCALE
      warn "Tailscale install failed — install manually later: https://tailscale.com/download"
    fi
  else
    echo "  Tip: Install Tailscale for secure remote access."
    echo "  See docs/getting-started/tailscale-setup.md"
  fi
  echo ""
fi

# ─── Verification ─────────────────────────────────────────

header "Verification"

# The health check decides how this run ends. It fails → this exits 1 HERE, so
# the "Crow is ready!" banner further down is unreachable (security audit
# N1c-15: the installer printed that banner, and exited 0, over a gateway that
# never answered). verify_gateway names the three commands that show the cause.
if ! verify_gateway; then
  echo ""
  echo "  Installation incomplete — fix the cause above, then run the installer again."
  echo ""
  exit 1
fi

# ─── Done ─────────────────────────────────────────────────

# Belt and braces: any `error` at all (a failed service check included) also
# withholds the banner, because a claim that Crow is ready must be true.
if install_failed; then
  header "Installation Incomplete"
  echo ""
  echo "  Crow is not ready: ${INSTALL_ERRORS} check(s) above failed."
  echo "  Fix what they show, then run the installer again."
  echo ""
  exit 1
fi

header "Installation Complete"

echo ""
echo "  Crow is ready!"
echo ""

# First-run setup link. While no dashboard password exists the gateway writes a
# one-time token to $CROW_HOME/setup-token (mode 0600, readable only by this
# account) and every first-run path demands it from anything but the machine
# itself, so a neighbour on the same LAN cannot claim this Crow first.
SETUP_TOKEN_FILE="$CROW_HOME/setup-token"
SETUP_TOKEN=""
if [ -r "$SETUP_TOKEN_FILE" ]; then
  SETUP_TOKEN="$(cat "$SETUP_TOKEN_FILE" 2>/dev/null || true)"
fi
# The token is base64url (A-Z a-z 0-9 - _), so it needs no quoting inside a URL.
SETUP_QS=""
if [ -n "$SETUP_TOKEN" ]; then
  SETUP_QS="?token=${SETUP_TOKEN}"
fi

# Has this Crow already been set up? Two signals together: no token file (it is
# deleted with the first password) AND the gateway redirecting /setup to the
# login page, which setup-page.js does only once a password exists. Status 302
# from /setup is the simplest reliable one; a missing 302 (gated page, or no
# answer) leaves the first-run message in place.
SETUP_DONE=false
if [ ! -r "$SETUP_TOKEN_FILE" ]; then
  SETUP_STATUS="$(curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:3001/setup 2>/dev/null || true)"
  if [ "$SETUP_STATUS" = "302" ]; then
    SETUP_DONE=true
  fi
fi

if [ "$IS_CLOUD_HOST" = true ] && [ -z "${GATEWAY_HTTPS_URL:-}" ]; then
  echo "  This is a cloud server: ${MDNS_HOST} is not reachable from your browser."
  echo "  Open an SSH tunnel from your own computer, then browse to http://localhost:3001/setup${SETUP_QS} :"
  echo "    ssh -L 3001:localhost:3001 ${USER}@<this-server's-public-IP>"
  echo "  (Or re-run this installer and accept Tailscale Serve for a permanent URL.)"
  SIGNIN_URL="http://localhost:3001/dashboard/login   (through the SSH tunnel)"
else
  echo "  Open in your browser:"
  echo "    https://${MDNS_HOST}/setup${SETUP_QS}"
  SIGNIN_URL="https://${MDNS_HOST}/dashboard/login"
  if [ -n "${GATEWAY_HTTPS_URL:-}" ]; then
    echo "    ${GATEWAY_HTTPS_URL}/setup${SETUP_QS}   (any device on your tailnet)"
    SIGNIN_URL="${GATEWAY_HTTPS_URL}/dashboard/login"
  fi
fi
echo ""
if [ "$SETUP_DONE" = true ]; then
  echo "  Setup is already done; sign in at:"
  echo "    ${SIGNIN_URL}"
else
  if [ -n "$SETUP_TOKEN" ]; then
    echo "  That link works once, and anyone who has it can claim this Crow — don't share it."
  else
    echo "  The one-time setup token is not written yet. The gateway saves it to:"
    echo "    ${SETUP_TOKEN_FILE}"
    echo "  Read it on this machine and add it to the URL as ?token=<that value>."
  fi
  echo "  Opening the setup page on this machine itself (http://localhost:3001/setup)"
  echo "  needs no token."
fi
echo ""
echo "  Everything else happens there — the setup wizard walks you through"
echo "  passwords, your AI model, and connecting devices."
echo ""

# A WSL2 host gets one more line: Crow is reachable from this machine, but who
# else can reach it is a Windows-side question (audit N1c-19). Nothing else
# changes — no prompt, no reconfiguration.
# shellcheck disable=SC2119  # the default (real kernel release) is intended here
print_wsl_note

# Add crow CLI to PATH if not already there (one exact line, added once)
add_crow_to_path
