#!/bin/bash
# Re-pair the kiosk's Bluetooth speaker. Operator-run only (pi-setup --repair-speaker runs it as the
# kiosk user); the kiosk page and the agent never pair anything.
#
#   repair-speaker.sh AA:BB:CC:DD:EE:FF [--yes]
#
# Before running it:
#   1. clear the speaker's own list of paired devices (in its app), so it does not refuse the Pi
#      ("br-connection-refused" / AVDTP "Connection refused" until this was done, on the first Pi);
#   2. put the speaker into Bluetooth pairing mode.
# Then: remove the old bond -> scan until the speaker is seen (up to 60 s) -> pair -> trust -> connect.
# After a successful run, disconnect/reconnect works without pairing mode again.
set -euo pipefail

BTCTL="${CROW_KIOSK_BTCTL:-bluetoothctl}"     # overridable for tests
MAC="${1:-}"
YES="${2:-}"
[[ "${MAC^^}" =~ ^[0-9A-F]{2}(:[0-9A-F]{2}){5}$ ]] || { echo "usage: $0 AA:BB:CC:DD:EE:FF [--yes]" >&2; exit 2; }
MAC="${MAC^^}"
[ -z "$YES" ] || [ "$YES" = "--yes" ] || { echo "usage: $0 AA:BB:CC:DD:EE:FF [--yes]" >&2; exit 2; }

if [ "$YES" != "--yes" ]; then
  echo "Clear the speaker's paired-device list in its app, then put it into pairing mode."
  read -r -p "Press Enter when the speaker is in pairing mode (Ctrl+C to stop) " _ < /dev/tty
fi

step() { echo "== $*"; }
step "remove the old bond"
"$BTCTL" remove "$MAC" >/dev/null 2>&1 || true

step "scan for the speaker (up to 60 s)"
"$BTCTL" --timeout 60 scan on >/dev/null 2>&1 &
SCAN=$!
trap 'kill "$SCAN" 2>/dev/null || true' EXIT
seen=0
for _ in $(seq 1 30); do
  if "$BTCTL" devices 2>/dev/null | grep -qi "^Device $MAC"; then seen=1; break; fi
  sleep 2
done
[ "$seen" = 1 ] || { echo "speaker $MAC not seen: is it in pairing mode and near the Pi?" >&2; exit 1; }
kill "$SCAN" 2>/dev/null || true
"$BTCTL" scan off >/dev/null 2>&1 || true

step "pair"
"$BTCTL" pair "$MAC"
step "trust"
"$BTCTL" trust "$MAC"
step "connect"
ok=0
for _ in 1 2 3; do
  if "$BTCTL" connect "$MAC" && "$BTCTL" info "$MAC" | grep -q "Connected: yes"; then ok=1; break; fi
  sleep 3
done
[ "$ok" = 1 ] || { echo "paired and trusted, but the connection did not come up" >&2; exit 1; }
echo "speaker $MAC paired, trusted and connected"
