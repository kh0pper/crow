#!/usr/bin/env bash
# ExecStopPost for crow-workspace-backup.service. systemd runs it after ANY end of the
# backup (success, failure, timeout, SIGKILL, OOM), so maintenance mode is recovered
# OUT OF PROCESS. It also sweeps work dirs and alerts when the backup could not.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WS="${WORKSPACE_DATA_ROOT:-$CROW_HOME/workspace}"
RESULT="${SERVICE_RESULT:-unknown}"

(cd "$BUNDLE_DIR" && timeout 120 $DC exec -T -u www-data nextcloud php occ maintenance:mode --off) >/dev/null 2>&1
off_rc=$?
rm -rf "$WS/backups-staging"/run-* "$WS/backups-staging"/*.part 2>/dev/null

msg=""
case "$RESULT" in
  success|exit-code) ;;   # backup.sh reported its own outcome
  *) msg="Workspace backup was killed ($RESULT, ${EXIT_CODE:-?}/${EXIT_STATUS:-?})" ;;
esac
[ "$off_rc" = 0 ] || msg="${msg:+$msg; }could not confirm maintenance mode is off. Run: cd $BUNDLE_DIR && CROW_HOME=$CROW_HOME docker compose exec -u www-data nextcloud php occ maintenance:mode --off"
if [ -n "$msg" ]; then
  lib="${WORKSPACE_BACKUP_ALERT_LIB:-}"
  if [ -n "$lib" ] && [ -r "$lib" ]; then ( set +eu; source "$lib"; send_alert "Workspace backup" "$msg" high ) >/dev/null 2>&1; fi
  printf '[workspace-backup] ALERT: %s\n' "$msg" >&2
fi
exit 0
