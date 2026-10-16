#!/usr/bin/env bash
# postInstall: give the Actual server Crow just installed its generated password, right
# away, so nobody who opens the web UI first can set their own (Actual's first-run
# "bootstrap" is first caller wins). Loopback only: the container is published on
# 127.0.0.1:5006. Never prints the password. Idempotent: a server that already has a
# password is left alone (Actual itself refuses a second bootstrap).
set -euo pipefail
ENV_FILE="${CROW_BUNDLE_DIR:-.}/.env"
URL="${ACTUAL_BOOTSTRAP_URL:-http://127.0.0.1:5006}"   # override: tests only (hookEnv never passes it)
[[ "$URL" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || { echo "Refusing a non-loopback Actual URL."; exit 0; }

pw="$(sed -n 's/^ACTUAL_SERVER_PASSWORD=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)"
pw="${pw%\"}"; pw="${pw#\"}"
if [ -z "$pw" ]; then
  echo "No generated server password in the extension settings; nothing to set."
  exit 0
fi
if ! [[ "$pw" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "The server password is not in the generated format; set it in Actual's web UI instead."
  exit 0
fi
command -v curl >/dev/null || { echo "curl is not installed; Crow sets the password the first time it connects instead."; exit 0; }

state=""
for _ in $(seq 1 "${ACTUAL_BOOTSTRAP_TRIES:-60}"); do
  state="$(curl -fsS --max-time 5 "$URL/account/needs-bootstrap" 2>/dev/null || true)"
  [ -n "$state" ] && break
  sleep 2
done
if [ -z "$state" ]; then
  echo "The Actual server did not answer within 2 minutes; Crow sets the password the first time it connects instead."
  exit 0
fi
if ! printf '%s' "$state" | grep -q '"bootstrapped":false'; then
  echo "The Actual server already has a password; left unchanged."
  exit 0
fi
# The body goes in on stdin, so the password never appears in a process list.
resp="$(printf '{"password":"%s"}' "$pw" | curl -sS --max-time 10 -H 'Content-Type: application/json' --data-binary @- "$URL/account/bootstrap" || true)"
if printf '%s' "$resp" | grep -q '"status":"ok"'; then
  echo "Set the generated password on the Actual server (Settings → Passwords)."
elif printf '%s' "$resp" | grep -q 'already-bootstrapped'; then
  echo "The Actual server already has a password; left unchanged."
else
  echo "Could not set the Actual server password; Crow tries again the first time it connects."
fi
