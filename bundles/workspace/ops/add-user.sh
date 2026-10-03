#!/usr/bin/env bash
# Create a household Workspace account (group "household") with a one-time password,
# printed ONCE to this terminal. Run it yourself, so the password stays out of any AI
# session transcript. Ask the person to change it at first login.
#   bash ~/.crow/bundles/workspace/ops/add-user.sh <login> "<Display Name>"
set -euo pipefail
umask 077
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LOGIN="${1:-}"; NAME="${2:-}"

[[ "$LOGIN" =~ ^[a-z][a-z0-9._-]{1,31}$ ]] || die "login must be 2-32 lowercase letters, digits, dots, dashes or underscores, starting with a letter"
[ "$LOGIN" != "crow-bot" ] || die "crow-bot is managed by the bootstrap"
[ -n "$NAME" ] || NAME="$LOGIN"
if occ user:info "$LOGIN" >/dev/null 2>&1; then
  echo "Account $LOGIN already exists; nothing changed."
  exit 0
fi
PW="$(random_pw 20)"
printf '%s\n' "$PW" | occ_with_pass user:add --password-from-env --display-name="$NAME" --group household "$LOGIN" >/dev/null
echo "One-time password for $LOGIN: $PW"
echo "Ask them to change it at first login: avatar → Settings → Security → Password."
