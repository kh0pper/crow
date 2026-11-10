#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Uptime Kuma's own first-run page ("create your admin account") answers on 127.0.0.1
# and stays open until somebody uses it, so whoever or whatever reaches it first claims
# the instance. This script creates that account itself, with the password Crow
# generated, before the operator's first visit.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin and
# is passed on only through a pipe — never in an argument or the environment, and this
# script prints no secret. Exit 0 = the admin now has that password, 3 = Uptime Kuma
# already has an admin of its own (left alone), 4 = not running / not answering, 5 =
# Uptime Kuma took the new password but the login could not be proved, anything else =
# failed. A create step that answers unclearly is re-checked against Uptime Kuma's own
# setup state: an account that appeared is proved (exit 0 or 5), one that did not is
# exit 1.
#
# How: Uptime Kuma's only API is socket.io on port 3001 INSIDE the container, and the
# image ships its own client, so one node script inside the container asks "needSetup"
# and then — only when the answer is a real true, in that same connection — creates the
# account. The username and the password reach that script as the first and second stdin
# line, so neither is ever interpolated into code.
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-uptime-kuma}"
# Crow creates `crow-admin`, the same name the other app bundles use. An empty value is
# refused below rather than silently replaced, because an empty one means the
# declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-crow-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Uptime Kuma was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Uptime Kuma was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Uptime Kuma was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Uptime Kuma container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Uptime Kuma is not running; nothing was changed." 4

# ── every snippet: one status word, printed once, then the process exits ────────────
# Each snippet is the same small prelude (connect, one status word, exit) plus its own
# ask. Nothing is interpolated into the code: the username and the password are read from
# stdin inside the container.

# DETECT: is the instance still waiting for its first account? Only a real true means
# "nobody has claimed it"; anything else (a falsy answer, a connect error, the 15 s
# timer) is UNKNOWN, and the shell exits 4 without touching the app.
DETECT='const io = require("/app/node_modules/socket.io-client");
let done = false;
let sock = null;
let timer = null;
const finish = (word) => {
  if (done) return;
  done = true;
  if (timer) clearTimeout(timer);
  process.stdout.write(word + "\n", () => {
    try { if (sock) sock.close(); } catch (err) {}
    process.exit(0);
  });
};
timer = setTimeout(() => finish("UNKNOWN"), 15000);
sock = io("http://127.0.0.1:3001", { transports: ["websocket"], reconnection: false, timeout: 10000 });
sock.on("connect_error", () => finish("UNKNOWN"));
sock.on("connect", () => {
  sock.emit("needSetup", (v) => {
    if (v === true) finish("FRESH");
    else if (v === false) finish("EXISTS");
    else finish("UNKNOWN");
  });
});'

# CREATE: the same connection asks once more right before it writes, so an account made
# in between is reported as EXISTS instead of being overwritten.
CREATE='const fs = require("fs");
const io = require("/app/node_modules/socket.io-client");
const lines = fs.readFileSync(0, "utf8").split("\n");
const user = lines[0] || "";
const password = lines[1] || "";
let done = false;
let sock = null;
let timer = null;
const finish = (word) => {
  if (done) return;
  done = true;
  if (timer) clearTimeout(timer);
  process.stdout.write(word + "\n", () => {
    try { if (sock) sock.close(); } catch (err) {}
    process.exit(0);
  });
};
timer = setTimeout(() => finish("UNKNOWN"), 15000);
sock = io("http://127.0.0.1:3001", { transports: ["websocket"], reconnection: false, timeout: 10000 });
sock.on("connect_error", () => finish("UNKNOWN"));
sock.on("connect", () => {
  sock.emit("needSetup", (v) => {
    if (v === false) finish("EXISTS");
    else if (v !== true) finish("UNKNOWN");
    else sock.emit("setup", user, password, (res) => {
      if (res && res.ok === true) finish("CREATED");
      else if (res && res.ok === false) finish("REFUSED");
      else finish("UNKNOWN");
    });
  });
});'

# PROVE (a separate run): log in with the account exactly as the web UI does.
PROVE='const fs = require("fs");
const io = require("/app/node_modules/socket.io-client");
const lines = fs.readFileSync(0, "utf8").split("\n");
const user = lines[0] || "";
const password = lines[1] || "";
let done = false;
let sock = null;
let timer = null;
const finish = (word) => {
  if (done) return;
  done = true;
  if (timer) clearTimeout(timer);
  process.stdout.write(word + "\n", () => {
    try { if (sock) sock.close(); } catch (err) {}
    process.exit(0);
  });
};
timer = setTimeout(() => finish("UNKNOWN"), 15000);
sock = io("http://127.0.0.1:3001", { transports: ["websocket"], reconnection: false, timeout: 10000 });
sock.on("connect_error", () => finish("UNKNOWN"));
sock.on("connect", () => {
  sock.emit("login", { username: user, password: password, token: "" }, (res) => {
    if (res && res.ok === true) finish("LOGIN-OK");
    else finish("LOGIN-FAIL");
  });
});'

# ── wait for the app (a first start creates its database first) ─────────────────────
up=""
for _ in $(seq 1 45); do
  if docker exec "$CONTAINER" node /app/extra/healthcheck.js </dev/null >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 2
done
[ -n "$up" ] || die "Uptime Kuma did not answer its own health check in time; nothing was changed." 4

# ── is the instance still unclaimed? ────────────────────────────────────────────────
state="$(docker exec "$CONTAINER" node -e "$DETECT" </dev/null 2>/dev/null || true)"
state="$(printf '%s\n' "$state" | tail -n 1)"
case "$state" in
  FRESH) ;;
  EXISTS) die "Uptime Kuma already has an admin; left alone." 3 ;;
  *) die "Uptime Kuma's setup state could not be read; nothing was changed." 4 ;;
esac

# ── create it (username on the first stdin line, password on the second) ────────────
created="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" node -e "$CREATE" 2>/dev/null)" || true
result="$(printf '%s\n' "$created" | tail -n 1)"
case "$result" in
  CREATED) ;;
  EXISTS) die "Uptime Kuma already has an admin; left alone." 3 ;;
  *)
    # Unclearly reported create: the account may already be there. Ask Uptime Kuma
    # itself rather than guess — an account that exists means this password is the only
    # one anybody has, so it is kept and proved below.
    again="$(docker exec "$CONTAINER" node -e "$DETECT" </dev/null 2>/dev/null || true)"
    recheck="$(printf '%s\n' "$again" | tail -n 1)"
    case "$recheck" in
      EXISTS) ;;
      FRESH) die "Uptime Kuma did not create the account; nothing was changed." ;;
      *) die "Uptime Kuma did not report whether it created the account, and its setup state could not be read afterwards; look at Uptime Kuma's own user list before trying again." ;;
    esac
    ;;
esac
say "Uptime Kuma's admin account '$ADMIN_USER' is in place."

# ── prove the new login works ───────────────────────────────────────────────────────
attempt=1
proof=""
while :; do
  proof="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" node -e "$PROVE" 2>/dev/null | tail -n 1)" || true
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # The account exists with this password, so Crow keeps it and says it could not prove
  # the login (exit 5).
  die "Uptime Kuma accepted the new password, but logging in with it did not succeed; open Uptime Kuma's own login page and set its admin password there." 5
fi

say "Uptime Kuma's admin login for '$ADMIN_USER' now uses the password Crow generated."