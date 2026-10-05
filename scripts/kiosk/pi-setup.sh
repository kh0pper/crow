#!/bin/bash
# Crow kiosk: set up a Raspberry Pi (Raspberry Pi OS Lite 64-bit, trixie) as a Crow wall display.
#
#   sudo scripts/kiosk/pi-setup.sh --crow-url https://<tailnet-host>:8444 [options]
#
# Options (remembered in /etc/crow-kiosk/setup.env; a re-run without a flag keeps the saved value)
#   --crow-url URL             the Crow gateway origin (https, Tailscale Serve); required the first time
#   --bt-sink MAC              a paired Bluetooth speaker the agent watches and reconnects; --clear-bt-sink
#   --mic-target NODE          PipeWire node.name of the microphone (pinned; default: the default source)
#   --allow-frame-origin URL   an extra origin the kiosk may frame (repeatable; replaces the saved list)
#   --admin-user NAME          the login user whose own PipeWire is masked (default: $SUDO_USER)
#   --keep-admin-audio         do not mask the admin user's PipeWire (refused together with --bt-sink:
#                              two PipeWire instances race for the speaker)
#   --accept-oww-model-license download openWakeWord's feature models + hey_jarvis (CC BY-NC-SA 4.0,
#                              non-commercial); without it the agent runs tap-only
#   --wake-model-url URL       a custom wake model (e.g. hey_crow.onnx served by Crow); needs
#   --wake-model-sha256 HEX    its sha256; --clear-wake-model goes back to hey_jarvis
#   --auto-reboot | --no-auto-reboot   unattended-upgrades may reboot at --reboot-time (default 04:30)
#   --rotate 0|90|180|270      rotate the display and the touchscreen (a chassis mounted upside down: 180)
#   --repair-speaker           after setup, re-pair the --bt-sink speaker (operator present: clear the
#                              speaker's paired list in its app and put it in pairing mode first)
#   --skip-packages            do not run apt or pip (files and services only)
#   --dry-run DIR              change nothing: write every file under DIR and print the commands
#   -h, --help
#
# Idempotent: re-running rewrites only files whose content changed, then restarts the kiosk if it is
# running and something changed (otherwise: reboot to start it).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OWW_RELEASE="https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
# sha256 of the v0.5.1 release assets, recorded 2026-10-05
OWW_MODELS=(
  "melspectrogram.onnx ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f"
  "embedding_model.onnx 70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f"
  "hey_jarvis_v0.1.onnx 94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb"
)
# No python3-onnxruntime: Debian's 1.21 dies with SIGILL on a Pi 3; the agent venv gets the upstream wheel.
PACKAGES=(cage chromium wlr-randr python3-numpy python3-websockets python3-venv unattended-upgrades sysstat
          pipewire wireplumber pipewire-pulse pipewire-alsa libspa-0.2-bluetooth bluez pulseaudio-utils)
VENV=/opt/crow-kiosk/venv
SAVED_KEYS=(CROW_URL BT_SINK MIC_TARGET FRAME_ORIGINS ADMIN_USER KEEP_ADMIN_AUDIO ACCEPT_OWW WAKE_URL WAKE_SHA AUTO_REBOOT REBOOT_TIME ROTATE)

die() { echo "pi-setup: $*" >&2; exit 2; }
say() { echo "== $*"; }
usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

# Flags given on this run (empty = not given)
declare -A GIVEN=()
DRY=0 ROOT="" SKIP_PACKAGES=0 FRAMES_GIVEN=() REPAIR_SPEAKER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --crow-url) GIVEN[CROW_URL]="${2:-}"; shift 2 ;;
    --bt-sink) GIVEN[BT_SINK]="${2:-}"; shift 2 ;;
    --clear-bt-sink) GIVEN[BT_SINK]="-"; shift ;;
    --mic-target) GIVEN[MIC_TARGET]="${2:-}"; shift 2 ;;
    --allow-frame-origin) FRAMES_GIVEN+=("${2:-}"); shift 2 ;;
    --admin-user) GIVEN[ADMIN_USER]="${2:-}"; shift 2 ;;
    --keep-admin-audio) GIVEN[KEEP_ADMIN_AUDIO]=1; shift ;;
    --accept-oww-model-license) GIVEN[ACCEPT_OWW]=1; shift ;;
    --wake-model-url) GIVEN[WAKE_URL]="${2:-}"; shift 2 ;;
    --wake-model-sha256) GIVEN[WAKE_SHA]="${2:-}"; shift 2 ;;
    --clear-wake-model) GIVEN[WAKE_URL]="-"; GIVEN[WAKE_SHA]="-"; shift ;;
    --auto-reboot) GIVEN[AUTO_REBOOT]=true; shift ;;
    --no-auto-reboot) GIVEN[AUTO_REBOOT]=false; shift ;;
    --reboot-time) GIVEN[REBOOT_TIME]="${2:-}"; shift 2 ;;
    --rotate) GIVEN[ROTATE]="${2:-}"; shift 2 ;;
    --repair-speaker) REPAIR_SPEAKER=1; shift ;;
    --skip-packages) SKIP_PACKAGES=1; shift ;;
    --dry-run) DRY=1; ROOT="${2:-}"; [ -n "$ROOT" ] || die "--dry-run needs a directory"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
[ ${#FRAMES_GIVEN[@]} -eq 0 ] || GIVEN[FRAME_ORIGINS]="${FRAMES_GIVEN[*]}"

p() { echo "${ROOT}$1"; }  # path on the target (under the staging dir in dry-run)
SETUP_ENV=/etc/crow-kiosk/setup.env

# ---- saved settings: defaults <- saved file <- this run's flags ----------------------------------
declare -A CFG=([CROW_URL]="" [BT_SINK]="" [MIC_TARGET]="" [FRAME_ORIGINS]="" [ADMIN_USER]="${SUDO_USER:-}"
                [KEEP_ADMIN_AUDIO]=0 [ACCEPT_OWW]=0 [WAKE_URL]="" [WAKE_SHA]="" [AUTO_REBOOT]=false [REBOOT_TIME]="04:30" [ROTATE]=0)
if [ -f "$(p "$SETUP_ENV")" ]; then
  while IFS='=' read -r k v; do      # parsed, never sourced
    for known in "${SAVED_KEYS[@]}"; do [ "$k" = "$known" ] && CFG[$k]="$v"; done
  done < "$(p "$SETUP_ENV")"
fi
for k in "${!GIVEN[@]}"; do CFG[$k]="${GIVEN[$k]}"; done
for k in BT_SINK WAKE_URL WAKE_SHA; do [ "${CFG[$k]}" != "-" ] || CFG[$k]=""; done

# ---- validation (also in dry-run; nothing has been written yet) ------------------------------------
[ -n "${CFG[CROW_URL]}" ] || die "--crow-url is required"
CROW_ORIGIN="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); from chromium_policy import origin; print(origin(sys.argv[2]))' "$SRC_DIR" "${CFG[CROW_URL]}" 2>/dev/null)" \
  || die "--crow-url must be an https origin with no path, e.g. https://crow.example.ts.net:8444"
CFG[CROW_URL]="$CROW_ORIGIN"
if [ -n "${CFG[BT_SINK]}" ]; then
  CFG[BT_SINK]="${CFG[BT_SINK]^^}"
  [[ "${CFG[BT_SINK]}" =~ ^[0-9A-F]{2}(:[0-9A-F]{2}){5}$ ]] || die "--bt-sink must look like AA:BB:CC:DD:EE:FF"
fi
[[ -z "${CFG[MIC_TARGET]}" || "${CFG[MIC_TARGET]}" =~ ^[A-Za-z0-9_.:-]{1,200}$ ]] || die "--mic-target must be a PipeWire node name"
read -r -a FRAME_ORIGINS <<< "${CFG[FRAME_ORIGINS]}"
WAKE_FILE=/var/lib/crow-kiosk/wake/hey_jarvis_v0.1.onnx
if [ -n "${CFG[WAKE_URL]}" ]; then
  [[ "${CFG[WAKE_URL]}" == https://* ]] || die "--wake-model-url must be https"
  [[ "${CFG[WAKE_SHA]}" =~ ^[0-9a-f]{64}$ ]] || die "--wake-model-url needs --wake-model-sha256 (64 hex chars)"
  wname="$(basename "${CFG[WAKE_URL]%%\?*}")"
  [[ "$wname" =~ ^[a-z0-9_.-]+\.onnx$ && "$wname" != .* ]] || die "--wake-model-url must end in a plain <name>.onnx"
  WAKE_FILE="/var/lib/crow-kiosk/wake/$wname"
fi
[[ "${CFG[REBOOT_TIME]}" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "--reboot-time must be HH:MM"
[[ "${CFG[AUTO_REBOOT]}" =~ ^(true|false)$ ]] || die "bad saved AUTO_REBOOT"
[[ "${CFG[ROTATE]}" =~ ^(0|90|180|270)$ ]] || die "--rotate must be 0, 90, 180 or 270"
[[ -z "${CFG[ADMIN_USER]}" || "${CFG[ADMIN_USER]}" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "bad --admin-user"
[ "${CFG[ADMIN_USER]}" != "kiosk" ] || die "--admin-user cannot be the kiosk user"
[ "$REPAIR_SPEAKER" = 0 ] || [ -n "${CFG[BT_SINK]}" ] || die "--repair-speaker needs --bt-sink (or a saved one)"
if [ "${CFG[KEEP_ADMIN_AUDIO]}" = 1 ] && [ -n "${CFG[BT_SINK]}" ]; then
  die "--keep-admin-audio with --bt-sink: two PipeWire instances would race for the speaker"
fi

# ---- helpers -----------------------------------------------------------------------------------
CHANGE_MARK="$(mktemp)"            # put() often runs in a pipeline (a subshell), so a variable would be lost
trap 'rm -f "$CHANGE_MARK"' EXIT
changed() { echo x >> "$CHANGE_MARK"; }
run() {  # run a system command (printed only, in dry-run)
  if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi
}
put() {  # put MODE DEST < content ; writes only when the content changed
  local mode="$1" dest tmp
  dest="$(p "$2")"
  tmp="$(mktemp)"
  cat > "$tmp"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"; echo "   unchanged $2"
  else
    install -m "$mode" "$tmp" "$dest"; rm -f "$tmp"; echo "   wrote     $2"; changed
  fi
}
# Files inside a user's home (kiosk, admin) are user-writable places: root must never write or chown
# there, or a planted symlink could redirect a root write. So:
#  - no path component from the home down to the target may be a symlink (checked, refused otherwise);
#  - the write itself runs AS that user (runuser), so even a race can only reach what the user could
#    reach anyway; the file is written to a temp name in the same directory and renamed over (mv -T);
#  - no recursive chown anywhere.
as_user() {  # as_user USER CMD... (direct in dry-run: the staging tree belongs to the caller)
  local u="$1"; shift
  if [ "$DRY" = 1 ]; then "$@"; else runuser -u "$u" -- "$@"; fi
}
no_symlinks_below() {  # no_symlinks_below HOME PATH : refuse if HOME or anything between it and PATH is a symlink
  local home rel cur part
  home="$(p "$1")"; rel="${2#"$1"}"; cur="$home"
  [ "${2#"$1"/}" != "$2" ] || die "internal: $2 is not under $1"
  [ ! -L "$home" ] || die "refusing: $1 is a symlink"
  IFS='/' read -r -a parts <<< "${rel#/}"
  for part in "${parts[@]}"; do
    cur="$cur/$part"
    [ ! -L "$cur" ] || die "refusing to write through a symlink: ${cur#"$ROOT"}"
  done
}
uput() {  # uput USER HOME MODE DEST < content ; a user-home file, written as USER, never through a symlink
  local u="$1" home="$2" mode="$3" dest="$4" tmp d
  no_symlinks_below "$home" "$dest"
  tmp="$(mktemp)"; cat > "$tmp"; chmod 0644 "$tmp"
  d="$(p "$dest")"
  if [ -f "$d" ] && as_user "$u" cmp -s - "$d" < "$tmp"; then
    rm -f "$tmp"; echo "   unchanged $dest"; return
  fi
  # shellcheck disable=SC2016 # expanded by the inner sh
  as_user "$u" sh -c 'umask 022; mkdir -p "$(dirname "$1")" && t="$1.crow-kiosk-new.$$" && cat > "$t" && chmod "$2" "$t" && mv -fT "$t" "$1"' \
    sh "$d" "$mode" < "$tmp"
  rm -f "$tmp"; echo "   wrote     $dest"; changed
}
ulink() {  # ulink USER HOME TARGET LINKNAME ; a symlink in a user's home, made as USER
  local u="$1" home="$2" target="$3" name="$4" n
  no_symlinks_below "$home" "$(dirname "$name")"
  n="$(p "$name")"
  if [ "$(readlink "$n" 2>/dev/null || true)" = "$target" ]; then echo "   unchanged $name"; return; fi
  [ ! -e "$n" ] || [ -L "$n" ] || die "refusing: $name exists and is not a symlink"
  # shellcheck disable=SC2016 # expanded by the inner sh
  as_user "$u" sh -c 'mkdir -p "$(dirname "$2")" && ln -sfnT "$1" "$2"' sh "$target" "$n"
  echo "   linked    $name"; changed
}
KHOME=/home/kiosk

# ---- 1. preflight --------------------------------------------------------------------------------
say "preflight"
FIRST_INSTALL=1
if [ "$DRY" = 0 ]; then
  [ "$(id -u)" = 0 ] || die "run as root (sudo)"
  [ "$(uname -m)" = aarch64 ] || die "expected a 64-bit (aarch64) Raspberry Pi OS"
  grep -q "Raspberry Pi" /proc/device-tree/model 2>/dev/null || die "not a Raspberry Pi"
  # shellcheck source=/dev/null
  . /etc/os-release; [ "${VERSION_CODENAME:-}" = trixie ] || echo "   warning: tested on trixie, this is ${VERSION_CODENAME:-unknown}"
  ! id kiosk >/dev/null 2>&1 || FIRST_INSTALL=0
else
  mkdir -p "$ROOT"; echo "   dry-run: files go under $ROOT; commands are printed, not run"
  [ ! -f "$(p "$SETUP_ENV")" ] || FIRST_INSTALL=0
fi

# ---- 2. packages -----------------------------------------------------------------------------
if [ "$SKIP_PACKAGES" = 0 ]; then
  say "packages"
  run apt-get update
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PACKAGES[@]}"
  say "agent python environment"
  put 0644 /opt/crow-kiosk/requirements.txt < "$SRC_DIR/files/requirements-agent.txt"
  [ -x "$(p "$VENV/bin/python")" ] || run python3 -m venv --system-site-packages "$VENV"
  run "$VENV/bin/pip" install --disable-pip-version-check --no-deps --require-hashes -r /opt/crow-kiosk/requirements.txt
fi

# ---- 3. kiosk user -----------------------------------------------------------------------------
say "kiosk user"
if [ "$FIRST_INSTALL" = 1 ]; then
  run useradd --create-home --shell /usr/sbin/nologin --user-group kiosk
fi
run usermod --shell /usr/sbin/nologin kiosk
run passwd --lock kiosk
run usermod -a -G audio,video,render,input kiosk
run loginctl enable-linger kiosk

# ---- 4. files ----------------------------------------------------------------------------------
say "files"
put 0755 /usr/local/lib/crow-kiosk/kiosk-launch.sh < "$SRC_DIR/kiosk-launch.sh"
put 0755 /usr/local/lib/crow-kiosk/mem-sample.sh < "$SRC_DIR/mem-sample.sh"
put 0755 /usr/local/lib/crow-kiosk/after-dpkg.sh < "$SRC_DIR/after-dpkg.sh"
put 0755 /usr/local/lib/crow-kiosk/repair-speaker.sh < "$SRC_DIR/repair-speaker.sh"
for f in "$SRC_DIR"/agent/*.py; do
  name="$(basename "$f")"
  case "$name" in test_*|bench_*|_*) continue ;; esac
  put 0644 "/usr/local/lib/crow-kiosk/agent/$name" < "$f"
done
put 0755 /usr/local/lib/crow-kiosk/agent/bench_latency.py < "$SRC_DIR/agent/bench_latency.py"
printf 'CROW_URL=%s\nROTATE=%s\n' "$CROW_ORIGIN" "${CFG[ROTATE]}" | put 0644 /etc/crow-kiosk/kiosk.env
python3 - "$CROW_ORIGIN" "${CFG[BT_SINK]}" "$WAKE_FILE" "${CFG[MIC_TARGET]}" <<'PY_AGENTCFG' | put 0644 /etc/crow-kiosk/agent.json
import json, sys
origin, mac, wake, mic = sys.argv[1:5]
print(json.dumps({"crow_origin": origin, "bt_sink_mac": mac or None, "wake_model": wake,
                  "mic_target": mic or None}, indent=2, sort_keys=True))
PY_AGENTCFG
POLICY_ARGS=(--crow-url "$CROW_ORIGIN")
for o in ${FRAME_ORIGINS[@]+"${FRAME_ORIGINS[@]}"}; do POLICY_ARGS+=(--allow-frame-origin "$o"); done
python3 "$SRC_DIR/chromium_policy.py" "${POLICY_ARGS[@]}" | put 0644 /etc/chromium/policies/managed/crow-kiosk.json
put 0644 /etc/systemd/system/crow-kiosk-cage.service < "$SRC_DIR/files/crow-kiosk-cage.service"
put 0644 /etc/pam.d/crow-kiosk < "$SRC_DIR/files/pam-crow-kiosk"
put 0644 /etc/udev/rules.d/90-crow-kiosk-backlight.rules < "$SRC_DIR/files/90-crow-kiosk-backlight.rules"
# Touch rotation: wlroots does not rotate touch input with the output transform, so libinput gets a
# calibration matrix for touchscreens. 180 is verified on the official 7" display; 90/270 are libinput's
# documented rotation matrices and may need swapping on a given panel (check by tapping a corner).
case "${CFG[ROTATE]}" in
  90)  TOUCH_MATRIX="0 -1 1 1 0 0" ;;
  180) TOUCH_MATRIX="-1 0 1 0 -1 1" ;;
  270) TOUCH_MATRIX="0 1 0 -1 0 1" ;;
  *)   TOUCH_MATRIX="" ;;
esac
if [ -n "$TOUCH_MATRIX" ]; then
  printf '# Crow kiosk: touchscreen rotated %s degrees with the display (pi-setup --rotate).\nENV{ID_INPUT_TOUCHSCREEN}=="1", ENV{LIBINPUT_CALIBRATION_MATRIX}="%s"\n' \
    "${CFG[ROTATE]}" "$TOUCH_MATRIX" | put 0644 /etc/udev/rules.d/91-crow-kiosk-touch-rotation.rules
elif [ -e "$(p /etc/udev/rules.d/91-crow-kiosk-touch-rotation.rules)" ]; then
  run rm -f /etc/udev/rules.d/91-crow-kiosk-touch-rotation.rules; changed
fi
put 0644 /etc/ssh/sshd_config.d/10-crow-kiosk.conf < "$SRC_DIR/files/10-crow-kiosk-sshd.conf"
put 0644 /etc/systemd/system.conf.d/90-crow-kiosk-watchdog.conf < "$SRC_DIR/files/90-crow-kiosk-watchdog.conf"
put 0644 /etc/NetworkManager/conf.d/90-crow-kiosk-wifi-powersave.conf < "$SRC_DIR/files/90-crow-kiosk-wifi-powersave.conf"
sed -e "s/@AUTO_REBOOT@/${CFG[AUTO_REBOOT]}/" -e "s/@REBOOT_TIME@/${CFG[REBOOT_TIME]}/" \
  "$SRC_DIR/files/52-crow-kiosk-unattended-upgrades" | put 0644 /etc/apt/apt.conf.d/52crow-kiosk-unattended-upgrades
put 0644 /etc/apt/apt.conf.d/20auto-upgrades < "$SRC_DIR/files/20-crow-kiosk-auto-upgrades"
put 0644 /etc/apt/apt.conf.d/80crow-kiosk-after-dpkg < "$SRC_DIR/files/80-crow-kiosk-after-dpkg"
put 0644 /etc/systemd/system/apt-daily.timer.d/crow-kiosk.conf < "$SRC_DIR/files/apt-daily-timer.conf"
put 0644 /etc/systemd/system/apt-daily-upgrade.timer.d/crow-kiosk.conf < "$SRC_DIR/files/apt-daily-upgrade-timer.conf"
for u in crow-kiosk-agent.service crow-kiosk-mem.service crow-kiosk-mem.timer; do
  uput kiosk "$KHOME" 0644 "$KHOME/.config/systemd/user/$u" < "$SRC_DIR/files/$u"
done
ulink kiosk "$KHOME" "$KHOME/.config/systemd/user/crow-kiosk-agent.service" "$KHOME/.config/systemd/user/default.target.wants/crow-kiosk-agent.service"
ulink kiosk "$KHOME" "$KHOME/.config/systemd/user/crow-kiosk-mem.timer" "$KHOME/.config/systemd/user/timers.target.wants/crow-kiosk-mem.timer"
uput kiosk "$KHOME" 0644 "$KHOME/.config/wireplumber/wireplumber.conf.d/51-crow-kiosk-bluez.conf" < "$SRC_DIR/files/51-crow-kiosk-bluez.conf"

# ---- 5. audio and Bluetooth ownership -----------------------------------------------------------
say "audio ownership"
AU="${CFG[ADMIN_USER]}"
if [ -n "$AU" ] && [ "${CFG[KEEP_ADMIN_AUDIO]}" = 0 ]; then
  # Two PipeWire instances would race for the Bluetooth A2DP endpoints; the kiosk user owns audio.
  AHOME="$(getent passwd "$AU" 2>/dev/null | cut -d: -f6 || true)"; AHOME="${AHOME:-/home/$AU}"
  for u in pipewire.service pipewire.socket pipewire-pulse.service pipewire-pulse.socket wireplumber.service mpris-proxy.service; do
    ulink "$AU" "$AHOME" /dev/null "$AHOME/.config/systemd/user/$u"
  done
  run loginctl disable-linger "$AU"
  echo "   $AU's PipeWire is masked; inspect audio with: sudo -u kiosk XDG_RUNTIME_DIR=/run/user/\$(id -u kiosk) wpctl status"
fi
run rfkill unblock bluetooth
# Classic Bluetooth only: after a reboot BlueZ tried the speaker over LE and failed (disconnect 0x0e);
# A2DP needs BR/EDR. BlueZ has no conf.d, so main.conf is edited in place (original kept once as .orig).
BT_MAIN=/etc/bluetooth/main.conf
BT_BEFORE="$(cat "$(p "$BT_MAIN")" 2>/dev/null || true)"
if [ -n "$BT_BEFORE" ] && [ ! -e "$(p "$BT_MAIN.orig")" ] && ! grep -qx "ControllerMode = bredr" <<< "$BT_BEFORE"; then
  printf '%s\n' "$BT_BEFORE" | put 0644 "$BT_MAIN.orig"
fi
printf '%s\n' "$BT_BEFORE" | python3 "$SRC_DIR/bt_main_conf.py" | put 0644 "$BT_MAIN"
if [ "$(cat "$(p "$BT_MAIN")")" != "$BT_BEFORE" ]; then BT_RESTART=1; else BT_RESTART=0; fi
if [ -n "${CFG[BT_SINK]}" ] && [ "$DRY" = 0 ]; then
  if ! bluetoothctl info "${CFG[BT_SINK]}" 2>/dev/null | grep -q "Paired: yes"; then
    echo "   warning: ${CFG[BT_SINK]} is not paired. Pairing is an operator step (bluetoothctl: scan on, pair, trust)."
  fi
fi

# ---- 6. wake models ----------------------------------------------------------------------------
say "wake models"
fetch() {  # fetch URL SHA256 DEST
  local dest; dest="$(p "$3")"
  if [ -f "$dest" ] && echo "$2  $dest" | sha256sum -c --status 2>/dev/null; then echo "   unchanged $3"; return; fi
  run mkdir -p "$(dirname "$3")"
  run curl -fsSL --proto '=https' --max-filesize 10485760 -o "$3.part" "$1"
  if [ "$DRY" = 0 ]; then
    echo "$2  $3.part" | sha256sum -c --status || { rm -f "$3.part"; die "sha256 mismatch for $1"; }
  fi
  run mv "$3.part" "$3"; run chmod 0644 "$3"
  [ "$DRY" = 1 ] || changed   # dry-run cannot stage a download; it would never read as unchanged
}
if [ "${CFG[ACCEPT_OWW]}" = 1 ]; then
  for m in "${OWW_MODELS[@]}"; do
    # shellcheck disable=SC2086 # "name sha" pairs
    set -- $m; fetch "$OWW_RELEASE/$1" "$2" "/var/lib/crow-kiosk/wake/$1"
  done
  [ -z "${CFG[WAKE_URL]}" ] || fetch "${CFG[WAKE_URL]}" "${CFG[WAKE_SHA]}" "$WAKE_FILE"
else
  echo "   skipped: openWakeWord models are CC BY-NC-SA 4.0; re-run with --accept-oww-model-license."
  echo "   Until then the agent runs tap-only (backlight and touch still work)."
fi

# ---- 7. remember the settings --------------------------------------------------------------------
CFG[FRAME_ORIGINS]="${FRAME_ORIGINS[*]+${FRAME_ORIGINS[*]}}"
for k in "${SAVED_KEYS[@]}"; do printf '%s=%s\n' "$k" "${CFG[$k]}"; done | put 0600 "$SETUP_ENV"

# ---- 8. services -------------------------------------------------------------------------------
say "services"
run systemctl daemon-reload
run udevadm control --reload
run udevadm trigger --subsystem-match=backlight --action=add
run udevadm trigger --subsystem-match=input --action=change
if [ "$DRY" = 1 ] || sshd -t; then run systemctl reload ssh.service; else die "sshd -t rejected the configuration; not reloading ssh"; fi
run systemctl enable crow-kiosk-cage.service
run systemctl set-default graphical.target
run systemctl disable --now avahi-daemon.service avahi-daemon.socket
run touch /etc/cloud/cloud-init.disabled
if [ "$DRY" = 0 ]; then dpkg-query -W -f='${Version}\n' chromium > /var/lib/crow-kiosk/chromium.version 2>/dev/null || true; fi

# ---- 8b. the agent's interpreter must run onnxruntime (fail loudly, not as a crash loop later) ------
say "agent runtime check"
put 0644 /usr/local/lib/crow-kiosk/check-onnxruntime.py < "$SRC_DIR/files/check-onnxruntime.py"
if [ "$DRY" = 1 ]; then
  run runuser -u kiosk -- "$VENV/bin/python" /usr/local/lib/crow-kiosk/check-onnxruntime.py /var/lib/crow-kiosk/wake/melspectrogram.onnx
elif [ "$SKIP_PACKAGES" = 0 ] || [ -x "$VENV/bin/python" ]; then
  rc=0; runuser -u kiosk -- "$VENV/bin/python" /usr/local/lib/crow-kiosk/check-onnxruntime.py /var/lib/crow-kiosk/wake/melspectrogram.onnx || rc=$?
  if [ "$rc" != 0 ]; then
    die "onnxruntime does not run in $VENV (rc=$rc; 132 = SIGILL: a build this CPU cannot execute). The wake word would crash-loop; fix before rebooting."
  fi
fi

# ---- 8c. Bluetooth daemon -------------------------------------------------------------------------
# Restarting bluetoothd drops the A2DP endpoints WirePlumber registered; they come back only when the
# kiosk user's WirePlumber restarts too, so the two always go together.
KUID="$(id -u kiosk 2>/dev/null || echo '<kiosk-uid>')"
if [ "$BT_RESTART" = 1 ] && [ "$FIRST_INSTALL" = 0 ]; then
  say "bluetooth"
  run systemctl restart bluetooth.service
  run runuser -u kiosk -- env XDG_RUNTIME_DIR="/run/user/$KUID" systemctl --user restart wireplumber.service
fi

# ---- 9. apply ------------------------------------------------------------------------------------
say "apply"
if [ ! -s "$CHANGE_MARK" ]; then
  echo "   nothing changed"
elif [ "$FIRST_INSTALL" = 1 ]; then
  echo "   first install: reboot to start the kiosk (sudo reboot)"
elif [ "$DRY" = 1 ] || systemctl is-active --quiet crow-kiosk-cage.service; then
  run runuser -u kiosk -- env XDG_RUNTIME_DIR="/run/user/$KUID" systemctl --user daemon-reload
  run runuser -u kiosk -- env XDG_RUNTIME_DIR="/run/user/$KUID" systemctl --user restart crow-kiosk-agent.service
  run systemctl restart crow-kiosk-cage.service
  echo "   restarted the agent and the kiosk (network/watchdog settings apply at the next boot)"
else
  echo "   the kiosk is not running; changes apply at the next boot (sudo reboot)"
fi

# ---- 9b. optional: re-pair the speaker (operator present) ------------------------------------------
if [ "$REPAIR_SPEAKER" = 1 ]; then
  say "re-pair the speaker"
  if [ "$FIRST_INSTALL" = 1 ] && [ "$DRY" = 0 ]; then
    die "--repair-speaker: reboot once after the first install (the kiosk user's session owns Bluetooth audio), then re-run with --repair-speaker"
  fi
  # the agent's own reconnect attempts would race the pairing (org.bluez.Error.InProgress): pause it
  run runuser -u kiosk -- env XDG_RUNTIME_DIR="/run/user/$KUID" systemctl --user stop crow-kiosk-agent.service
  rc=0; run runuser -u kiosk -- env XDG_RUNTIME_DIR="/run/user/$KUID" /usr/local/lib/crow-kiosk/repair-speaker.sh "${CFG[BT_SINK]}" || rc=$?
  run runuser -u kiosk -- env XDG_RUNTIME_DIR="/run/user/$KUID" systemctl --user start crow-kiosk-agent.service
  [ "$rc" = 0 ] || die "re-pairing failed (rc=$rc); the agent is running again"
fi

# ---- 10. checks --------------------------------------------------------------------------------
say "checks"
if [ "$DRY" = 0 ]; then
  # capture first: with pipefail, piping sshd -T into an early-exiting grep fails (SIGPIPE to sshd)
  SSHD_T="$(sshd -T 2>/dev/null || true)"
  if grep -qx "passwordauthentication no" <<< "$SSHD_T" && grep -qx "kbdinteractiveauthentication no" <<< "$SSHD_T"; then
    echo "   ok   ssh is key-only"
  else
    echo "   WARN ssh still allows passwords: check /etc/ssh/sshd_config.d/"
  fi
  if tailscale status >/dev/null 2>&1; then echo "   ok   tailscale is logged in"
  else echo "   todo tailscale: run 'sudo tailscale up', approve the URL, then disable key expiry in the admin console"; fi
fi
say "done"
