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
# Uptime Kuma took the password THIS RUN created the account with but the login could
# not be proved, anything else = failed. A create step that answers unclearly is
# re-checked against Uptime Kuma's own setup state: an account that appeared is proved
# (exit 0, or exit 1 with "Crow did not set it" when this run never reported CREATED),
# one that did not is exit 1.
#
# Exit 5 is only for an account Crow made itself. Uptime Kuma refuses `setup` whenever
# any user exists, so REFUSED or an unclear answer followed by EXISTS can mean somebody
# else claimed the instance in between — that login is proved like any other, but a
# failed proof is exit 1, because nothing of Crow's was saved.
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
# stdin inside the container. Two timers bound it: the 15 s one that still prints an
# UNKNOWN, and an unconditional 20 s `process.exit(1)` behind it, so no `docker exec` of a
# snippet can outlive ~20 s even if the socket never answers and stdout never flushes.

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
setTimeout(() => process.exit(1), 20000);
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
setTimeout(() => process.exit(1), 20000);
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
setTimeout(() => process.exit(1), 20000);
sock = io("http://127.0.0.1:3001", { transports: ["websocket"], reconnection: false, timeout: 10000 });
sock.on("connect_error", () => finish("UNKNOWN"));
sock.on("connect", () => {
  sock.emit("login", { username: user, password: password, token: "" }, (res) => {
    if (res && res.ok === true) finish("LOGIN-OK");
    else finish("LOGIN-FAIL");
  });
});'

# ── wait for the app (a first start creates its database first) ─────────────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 180 s, and `timeout 10`
# around the health check itself (coreutils/busybox timeout in the image; where it is
# missing the exec returns at once and the budget alone ends the wait).
up=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  if docker exec "$CONTAINER" timeout 10 node /app/extra/healthcheck.js </dev/null >/dev/null 2>&1; then
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
# `ours` records whether the app itself said it made the account with OUR password; it
# is what allows exit 5 at the end, and nothing else does.
ours=""
created="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" node -e "$CREATE" 2>/dev/null)" || true
result="$(printf '%s\n' "$created" | tail -n 1)"
case "$result" in
  CREATED) ours=1 ;;
  EXISTS) die "Uptime Kuma already has an admin; left alone." 3 ;;
  *)
    # Unclearly reported create: an account may have appeared, made by this run or by
    # somebody else. Ask Uptime Kuma itself rather than guess — and prove it below either
    # way. Only CREATED above can lead to exit 5.
    again="$(docker exec "$CONTAINER" node -e "$DETECT" </dev/null 2>/dev/null || true)"
    recheck="$(printf '%s\n' "$again" | tail -n 1)"
    case "$recheck" in
      EXISTS) ;;
      FRESH) die "Uptime Kuma did not create the account; nothing was changed." ;;
      *) die "Uptime Kuma did not report whether it created the account, and its setup state could not be read afterwards; look at Uptime Kuma's own user list before trying again." ;;
    esac
    ;;
esac
[ -z "$ours" ] || say "Uptime Kuma's admin account '$ADMIN_USER' is in place."

# ── prove the new login works ───────────────────────────────────────────────────────
attempt=1
proof=""
# Three tries, and never more than 40 s of them: each proof run is bounded by the
# snippet's own timers, this budget bounds the whole loop.
proof_deadline=$((SECONDS + 40))
while :; do
  proof="$(printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" node -e "$PROVE" 2>/dev/null | tail -n 1)" || true
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  if [ -z "$ours" ]; then
    # This run never got a CREATED: the account that is there now is not one it can vouch
    # for, so it must not claim the app took Crow's password (exit 5).
    die "An account appeared in Uptime Kuma that Crow did not set; nothing of Crow's was saved. Check Uptime Kuma's own users."
  fi
  # The account is the one this run created with this password, so Crow keeps it and says
  # it could not prove the login (exit 5).
  die "Uptime Kuma accepted the new password, but logging in with it did not succeed; open Uptime Kuma's own login page and set its admin password there." 5
fi

say "Uptime Kuma's admin login for '$ADMIN_USER' now uses the password Crow generated."