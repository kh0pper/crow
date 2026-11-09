# Wallabag's login check, run inside the app's container by scripts/first-admin.sh.
#
# stdin: one candidate password. $1: the account name.
#
# Exit 0 = that password logs in. Exit 1 = Wallabag refused it. Exit 2 = the login could
# not be checked, which is never a yes: an empty redirect_url (a connection error, a 502,
# a timeout) is not "logged in". Reading it any other way would let Crow overwrite an
# operator's password (a working login read as gone) or report a login it cannot reproduce
# (a broken page read as working).
#
# The candidate goes to curl on stdin (`@-`), so no password file is ever left behind in
# the container; only the cookie jar is a temporary file, removed on the way out.
IFS= read -r P

J=$(mktemp /tmp/cj.XXXXXX) || exit 2
trap 'rm -f "$J"' EXIT

T=$(curl -s -c "$J" http://localhost/login | grep -o 'name="_csrf_token"[^>]*value="[^"]*"' | sed 's/.*value="//;s/"//')
[ -n "$T" ] || exit 2

OUT=$(printf '%s' "$P" | curl -s -b "$J" -c "$J" -o /dev/null -w '%{http_code} %{redirect_url}' \
  --data-urlencode "_username=$1" --data-urlencode "_csrf_token=$T" --data-urlencode "_password@-" \
  http://localhost/login_check) || exit 2

CODE=${OUT%% *}
LOC=${OUT#* }
[ "$CODE" = "302" ] || exit 2
[ -n "$LOC" ] || exit 2
case "$LOC" in
  */login) exit 1 ;;
  *) exit 0 ;;
esac