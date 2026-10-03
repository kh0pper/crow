#!/usr/bin/env bash
# Reset a Workspace account's password. The new password is read from the terminal
# (not echoed) or from stdin, and reaches occ only via stdin, never argv.
#   bash ~/.crow/bundles/workspace/ops/reset-password.sh <login>
set -euo pipefail
umask 077
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LOGIN="${1:-}"
[[ "$LOGIN" =~ ^[a-z][a-z0-9._-]{1,31}$ ]] || die "usage: reset-password.sh <login>"
if [ -t 0 ]; then IFS= read -rsp "New password for $LOGIN: " PW; echo; else IFS= read -r PW; fi
[[ "$PW" =~ ^[A-Za-z0-9!%*+,./:=?@^_~-]{12,128}$ ]] || die "password must be 12-128 letters, digits or ! % * + , - . / : = ? @ ^ _ ~"
step "resetting the password"
printf '%s\n' "$PW" | occ_with_pass user:resetpassword --password-from-env "$LOGIN" >/dev/null
unset PW
echo "Password for $LOGIN updated."
