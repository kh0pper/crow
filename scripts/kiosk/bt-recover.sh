#!/bin/bash
# Crow kiosk: recover a hung Raspberry Pi Bluetooth controller (root; run by crow-kiosk-bt-recover.service
# when the agent touches /run/crow-kiosk/bt-recover.request after repeated bluetoothctl timeouts).
#
# The Pi 3's BCM43438 controller can hang ("hci0: command 0x0406 tx timeout", "Opcode 0x0401 failed: -110",
# even "Opcode 0x0c03 (Reset) failed"); restarting bluetoothd does not clear it. Rebinding the hci_uart
# serdev driver resets the controller. This script:
#   1. acts only if the kernel log shows such hci0 errors in the last 15 minutes (evidence, not a hunch);
#   2. at most once per 10 minutes and 3 times per hour;
#   3. unbinds + rebinds the serdev device, waits for hci0 to come back powered, restarts bluetoothd and
#      then the kiosk user's WirePlumber (its A2DP endpoints are not re-registered otherwise);
#   4. NEVER removes or re-pairs the speaker (the speaker keeps its key; a Pi-side re-pair is refused
#      until the operator clears the speaker's own list);
#   5. writes the outcome to /run/crow-kiosk/bt-recover.state (ok | no_fault | rate_limited |
#      needs_restart) for the agent; reboots only if the operator enabled it (/etc/crow-kiosk/bt-auto-reboot)
#      and the Pi has not rebooted for this in the last 24 h.
set -u
R="${CROW_KIOSK_TEST_ROOT:-}"          # tests only: prefix for every path below
STATE_DIR="$R/run/crow-kiosk"
STATE="$STATE_DIR/bt-recover.state"
LOGF="$R/var/lib/crow-kiosk/bt-recover.log"
SERDEV_FILE="$R/var/lib/crow-kiosk/bt-serdev"
DRIVER="$R/sys/bus/serial/drivers/hci_uart_bcm"
HCI="$R/sys/class/bluetooth/hci0/device"
AUTO_REBOOT_MARK="$R/etc/crow-kiosk/bt-auto-reboot"
WAIT_S="${CROW_KIOSK_BT_WAIT:-20}"
JOURNAL_SINCE="${CROW_KIOSK_BT_SINCE:--15min}"
now="$(date +%s)"
mkdir -p "$STATE_DIR" "$(dirname "$LOGF")"
say() { echo "$*"; logger -t crow-kiosk-bt-recover "$*" 2>/dev/null || true; }
finish() { printf '%s %s\n' "$1" "$now" > "$STATE"; echo "$now $1" >> "$LOGF"; say "outcome: $1"; exit 0; }

# 1. evidence
if ! journalctl -k --since "$JOURNAL_SINCE" --no-pager -q 2>/dev/null \
     | grep -Eq 'hci0: (command 0x[0-9a-f]+ tx timeout|Opcode 0x[0-9a-f]+ failed: -110|Opcode 0x0c03 failed)'; then
  finish no_fault
fi

# 2. rate limit (from the log of earlier attempts)
recent10=0; recent60=0
if [ -f "$LOGF" ]; then
  while read -r t what; do
    case "$what" in ok|needs_restart) ;; *) continue ;; esac
    [ $((now - t)) -lt 600 ] && recent10=$((recent10 + 1))
    [ $((now - t)) -lt 3600 ] && recent60=$((recent60 + 1))
  done < "$LOGF"
fi
if [ "$recent10" -gt 0 ] || [ "$recent60" -ge 3 ]; then finish rate_limited; fi

# 3. rebind the controller's serdev device
dev="$(cat "$SERDEV_FILE" 2>/dev/null || true)"
if [ -z "$dev" ] && [ -e "$HCI" ]; then dev="$(basename "$(readlink -f "$HCI")")"; fi
if [ -z "$dev" ]; then dev="$(find "$DRIVER" -maxdepth 1 -name 'serial*-*' -printf '%f\n' 2>/dev/null | head -1)"; fi
[[ "$dev" =~ ^serial[0-9]+-[0-9]+$ ]] || { say "no serdev device found for hci_uart_bcm"; finish needs_restart; }
say "rebinding $dev (hci_uart_bcm)"
[ -e "$DRIVER/$dev" ] && echo "$dev" > "$DRIVER/unbind"
sleep 2
echo "$dev" > "$DRIVER/bind" 2>/dev/null || true
up=0
for _ in $(seq 1 "$WAIT_S"); do
  if bluetoothctl show 2>/dev/null | grep -q "Powered: yes"; then up=1; break; fi
  sleep 1
done
if [ "$up" = 1 ]; then
  systemctl restart bluetooth.service
  KUID="$(id -u kiosk 2>/dev/null || true)"
  [ -z "$KUID" ] || runuser -u kiosk -- env XDG_RUNTIME_DIR="/run/user/$KUID" systemctl --user restart wireplumber.service || true
  finish ok
fi

# 4. still dead: a reboot is the only cure
if [ -e "$AUTO_REBOOT_MARK" ]; then
  last="$(awk '$2=="reboot" {t=$1} END {print t+0}' "$LOGF" 2>/dev/null)"
  if [ $((now - ${last:-0})) -ge 86400 ]; then
    echo "$now reboot" >> "$LOGF"
    printf 'rebooting %s\n' "$now" > "$STATE"
    say "controller did not come back; rebooting (operator-enabled)"
    systemctl reboot
    exit 0
  fi
fi
finish needs_restart
