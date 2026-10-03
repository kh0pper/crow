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
# Same rule as the manifest pattern ^[^\x00-\x1f\x7f]{12,128}$, counted the same way (UTF-16
# code units, like the install form's JavaScript RegExp — review S10), via stdin, never argv.
PW_LEN="$(printf '%s' "$PW" | python3 -c 'import sys; s=sys.stdin.buffer.read().decode("utf-8","replace"); print(len(s.encode("utf-16-le"))//2)')"
{ [ "$PW_LEN" -ge 12 ] && [ "$PW_LEN" -le 128 ]; } || die "password must be 12-128 characters"
case "$PW" in *[[:cntrl:]]*) die "password must not contain tabs, line breaks or other control characters" ;; esac
step "resetting the password"
printf '%s\n' "$PW" | occ_with_pass user:resetpassword --password-from-env "$LOGIN" >/dev/null
unset PW
echo "Password for $LOGIN updated."
