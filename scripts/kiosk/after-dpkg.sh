#!/bin/bash
# apt DPkg::Post-Invoke hook (crow kiosk): when the chromium package version changed, restart the kiosk so
# the running browser never mixes an old browser process with new renderer binaries.
set -u
STATE=/var/lib/crow-kiosk/chromium.version
new="$(dpkg-query -W -f='${Version}' chromium 2>/dev/null)" || exit 0
old="$(cat "$STATE" 2>/dev/null || true)"
[ "$new" = "$old" ] && exit 0
mkdir -p "$(dirname "$STATE")" && printf '%s\n' "$new" > "$STATE"
if systemctl is-active --quiet crow-kiosk-cage.service; then
  logger -t crow-kiosk "chromium $old -> $new: restarting the kiosk"
  systemctl restart --no-block crow-kiosk-cage.service
fi
exit 0
