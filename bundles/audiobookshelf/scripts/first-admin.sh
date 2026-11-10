#!/usr/bin/env bash
# Crow's first-admin setup for this bundle (manifest firstAdmin.via: "setup").
#
# Audiobookshelf's first start shows a "create the root user" form, and the first caller
# that fills it in owns the server. That form answers on 127.0.0.1:80 inside the container,
# so an install left alone is claimable by anything else on the machine. This script creates
# that account itself, with the password Crow generated, before the operator's first visit.
#
# This image ships no command-line HTTP client, so every request is made INSIDE the container
# by the node it does ship: one fixed snippet (no secret in it, ever) reads the admin
# username and the password as the first two lines of ITS stdin and prints ONE status word.
# Neither value is an argument, an environment value or output.
#
# Protocol (docs/developers/bundles.md): the password arrives as ONE line on stdin.
# Exit 0 = the admin now has exactly that password, 3 = Audiobookshelf is already set up
# (nothing changed), 4 = not running / not answering / unreadable, 5 = Audiobookshelf took
# the new password but logging in with it did not succeed, anything else = failed. A create
# answer that does not say the account was made is settled by reading Audiobookshelf's own
# state again — a second init answers 500, so the status code alone never means "already set
# up": an install that now has its root user keeps the password and proves it (0 or 5), one
# that still has none changed nothing (1).
#
# CROW_FA_CONTAINER overrides the container name for tests only; Crow never sets it.
set -euo pipefail

CONTAINER="${CROW_FA_CONTAINER:-crow-audiobookshelf}"
# Crow creates `admin`; an empty value is refused below rather than silently replaced,
# because an empty one means the declaration is broken — only an UNSET one takes the default.
ADMIN_USER="${CROW_FIRST_ADMIN_USER-admin}"
[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { printf '%s\n' "The admin username is not a plain account name; Audiobookshelf was not touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# ── the password, from stdin only ───────────────────────────────────────────────────
PW=""
IFS= read -r PW || true
[ -n "$PW" ] || die "No password arrived on stdin; Audiobookshelf was not touched."
[ "${#PW}" -ge 12 ] || die "The password on stdin is shorter than 12 characters; Audiobookshelf was not touched."

# ── docker, and the container ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not available here, so the Audiobookshelf container cannot be reached; nothing was changed." 4
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "Audiobookshelf is not running; nothing was changed." 4

# ── the one snippet every request goes through ─────────────────────────────────────
# Fixed text: it carries no username and no password. It takes the method and the path as
# arguments (`GET /status`, `POST /init`, `POST /login`), reads the admin username and the
# password as the first two lines of its stdin, and prints exactly one status word:
#   OFFLINE                                  the request never reached the app
#   INIT / READY / UNKNOWN                   GET /status: isInit false / true / unreadable
#   CREATED / REFUSED                        POST /init: 200 / anything else
#   LOGIN-OK / LOGIN-FAIL                    POST /login: 200 / anything else
# `import()` rather than `require` keeps it working whichever module type the app's own
# package.json asks for.
HTTP_REQUEST='const args = process.argv.slice(1);
const method = args.indexOf("POST") >= 0 ? "POST" : "GET";
const target = args.filter((a) => a.charAt(0) === "/")[0] || "/status";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input = input + chunk; });
process.stdin.on("end", () => {
  const lines = input.split("\n");
  const username = lines[0] || "";
  const password = lines[1] || "";
  let body = "";
  if (target === "/init") body = JSON.stringify({ newRoot: { username: username, password: password } });
  if (target === "/login") body = JSON.stringify({ username: username, password: password });
  import("node:http").then((loaded) => {
    const http = loaded.default || loaded;
    const request = http.request({
      host: "127.0.0.1",
      port: 80,
      path: target,
      method: method,
      timeout: 10000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text = text + chunk; });
      response.on("end", () => {
        let word = "UNKNOWN";
        if (target === "/status") {
          if (text.indexOf("\"isInit\":true") >= 0) word = "READY";
          else if (text.indexOf("\"isInit\":false") >= 0) word = "INIT";
        } else if (target === "/init") {
          word = response.statusCode === 200 ? "CREATED" : "REFUSED";
        } else if (target === "/login") {
          word = response.statusCode === 200 ? "LOGIN-OK" : "LOGIN-FAIL";
        }
        process.stdout.write(word + "\n");
      });
    });
    request.on("timeout", () => { request.destroy(new Error("timed out")); });
    request.on("error", () => { process.stdout.write("OFFLINE\n"); });
    request.end(body);
  }).catch(() => { process.stdout.write("OFFLINE\n"); });
});'

# abs_http METHOD PATH: one request inside the container. The username and the password go
# in on a pipe as the snippet's first two stdin lines; only the method and the path are
# arguments. The last line of the output is the snippet's one status word.
abs_http() {
  printf '%s\n%s\n' "$ADMIN_USER" "$PW" | docker exec -i "$CONTAINER" node -e "$HTTP_REQUEST" "$1" "$2" 2>/dev/null | tail -n 1 || true
}

# ── wait for the app (a first start prepares its own database first) ───────────────
# Bounded twice: a $SECONDS budget well inside the manifest's 180 s, and the 10 s the
# snippet puts on its own request, so a single stuck request cannot outlive the wait.
state=""
wait_deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$wait_deadline" ]; do
  state="$(abs_http GET /status)"
  if [ -n "$state" ] && [ "$state" != "OFFLINE" ]; then break; fi
  sleep 2
done
case "$state" in
  INIT) ;;
  READY) die "Audiobookshelf is already set up, so this install has its own root user; left alone, and nothing was changed." 3 ;;
  OFFLINE | "") die "Audiobookshelf did not answer on its web port; nothing was changed." 4 ;;
  *) die "Audiobookshelf's setup state could not be read; nothing was changed." 4 ;;
esac

# ── create the root user ───────────────────────────────────────────────────────────
create="$(abs_http POST /init)"
if [ "$create" != "CREATED" ]; then
  # Whatever the status was, the app's own state decides. A second init answers 500 rather
  # than a 4xx, so "not 200" alone is never read as "already set up".
  again="$(abs_http GET /status)"
  case "$again" in
    READY) ;;
    INIT) die "Audiobookshelf did not create the root user, so nothing was changed; check the app's own login." 1 ;;
    *) die "Audiobookshelf did not report whether it created the root user; check the app's own login before trying again." 1 ;;
  esac
fi
say "Audiobookshelf's admin account '$ADMIN_USER' is in place."

# ── prove the new login works ───────────────────────────────────────────────────────
prove() {
  local answer
  answer="$(abs_http POST /login)"
  if [ "$answer" = "LOGIN-OK" ]; then printf '%s' "LOGIN-OK"; else printf '%s' "LOGIN-FAIL"; fi
}
attempt=1
proof=""
proof_deadline=$((SECONDS + 40))
while :; do
  proof="$(prove)"
  if [ "$proof" = "LOGIN-OK" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then break; fi
  if [ "$SECONDS" -ge "$proof_deadline" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$proof" != "LOGIN-OK" ]; then
  # Audiobookshelf confirmed the change, so the new password IS its password: Crow keeps it
  # and says it could not log in with it (exit 5).
  die "Audiobookshelf accepted the new password, but logging in with it did not succeed; Crow kept the new password; use the login in Settings → Passwords." 5
fi

say "Audiobookshelf's admin login for '$ADMIN_USER' now uses the password Crow generated."