#!/usr/bin/env bash
# Satellite Crow installer (SAT-4, spec §4.1, §4.3, §6.4, §11).
#
# Runs on a fresh small server (Ubuntu 22.04+ / Debian 12+, x86_64 or arm64) as the login user
# who will own the satellite (sudo for the system steps). crow's Extensions > Servers > Add a
# server page shows the two lines that fetch this file from GitHub at crow's own sha, check its
# sha256, and run it:
#
#   bash satellite-install.sh --sha <sha>            install (idempotent: a re-run repairs)
#   bash satellite-install.sh --repair --sha <sha>   repair an installed box (§4.3)
#   bash satellite-install.sh --dry-run --sha <sha>  preflight only, then print the plan
#   --make-swap                                      answer yes to the 2 GiB swap offer
#
# What it does: preflight (refuses with a plain message, exit 78) → swap / Tailscale / Node 24 /
# Docker when missing → git clone of the public repo into $SAT_HOME/app at --sha → npm ci
# --omit=dev under a 600 MB scope → the satellite key → crow-satellite.service → ufw
# assertions → Tailscale Serve `/` → http://127.0.0.1:3014 (never Funnel) → starts the agent,
# which prints a pairing code when it is unpaired.
#
# It never contacts crow: pairing is crow → satellite (crow's owner types the code). --repair
# never deletes vault/, installed.json, bundle data or secrets/, and never touches cert.json or
# pinned.json: the agent itself treats a missing or lapsed cert (past the 30-day grace) as
# unpaired and prints a new code; a valid cert stays paired.
#
# Post-update crash rollback: deferred. update.js rolls back every failure it can see (fetch,
# npm ci, self-check, migrate) before it restarts with exit 75; a new tree that passes its
# self-check and then crashes at boot is NOT rolled back automatically. The unit's StartLimit
# stops such a crash loop after 5 starts in 10 minutes; recover by hand with
#   bash satellite-install.sh --repair --sha <the "from" sha in $SAT_HOME/update-last.json>
#
# Test hooks (read-only): SAT_OS_RELEASE and SAT_MEMINFO point the preflight at other files.
set -euo pipefail

SATELLITE_REPO="kh0pper/crow"
REPO_URL="https://github.com/${SATELLITE_REPO}.git"
AGENT_PORT=3014
GUARD_EXIT=78
OS_RELEASE="${SAT_OS_RELEASE:-/etc/os-release}"
MEMINFO="${SAT_MEMINFO:-/proc/meminfo}"
NODE_MAJOR=24
NODE_BIN=/usr/bin/node
NPM_BIN=/usr/bin/npm
UNIT_NAME=crow-satellite.service
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"
CLI_LINK=/usr/local/bin/crow-satellite
MIN_MEM_KB=$((900 * 1024))
MIN_SWAP_KB=$((1024 * 1024))
MIN_DISK_BYTES=5000000000
SYS_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() {
  echo "usage: bash satellite-install.sh --sha <40-hex commit sha> [--repair] [--dry-run] [--make-swap]" >&2
  exit 2
}

SHA=""
REPAIR=0
DRY_RUN=0
MAKE_SWAP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) [ $# -ge 2 ] || usage; SHA="$2"; shift 2 ;;
    --repair) REPAIR=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --make-swap) MAKE_SWAP=1; shift ;;
    *) echo "satellite-install: unknown option: $1" >&2; usage ;;
  esac
done
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "satellite-install: --sha must be a full 40-character commit sha" >&2
  usage
fi

say() { echo "satellite-install: $*"; }
refuse() {
  echo "satellite-install: refusing: $*" >&2
  exit "$GUARD_EXIT"
}
STEP0="Move it off this box first (see the satellite step 0 runbook), then re-run."

PLAN=()
plan() { PLAN+=("$*"); }

has_tty() { { : </dev/tty; } 2>/dev/null; }
ask_yn() { # ask_yn "question" → 0 on yes; headless → no
  local ans=""
  has_tty || return 1
  read -r -p "$1 [y/N] " ans </dev/tty || return 1
  [[ "$ans" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------------------------------------
# Preflight: read-only. Every refusal is one plain message and exit 78.
# ---------------------------------------------------------------------------------------------

USER_UID="$(id -u)"
USER_NAME="$(id -un)"
[ "$USER_UID" != "0" ] || refuse "do not run this as root; run it as the login user who will own the satellite (it uses sudo for the system steps)"
if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then refuse "HOME is not set to an existing directory"; fi

RHOME="$(realpath -m "$HOME")"
SAT_HOME="$(realpath -m "${SAT_HOME:-$RHOME/.crow-satellite}")"
case "$SAT_HOME" in
  "$RHOME"/*) ;;
  *) refuse "SAT_HOME must be under your home directory ($RHOME); got $SAT_HOME" ;;
esac
APP_DIR="$SAT_HOME/app"

if [ "$REPAIR" = 1 ] && [ ! -d "$APP_DIR" ]; then
  refuse "nothing to repair: $APP_DIR does not exist (run without --repair to install)"
fi

# OS and architecture.
os_id=""
os_ver=""
if [ -r "$OS_RELEASE" ]; then
  # shellcheck source=/dev/null
  os_id="$(. "$OS_RELEASE"; echo "${ID:-}")"
  # shellcheck source=/dev/null
  os_ver="$(. "$OS_RELEASE"; echo "${VERSION_ID:-}")"
fi
os_major="${os_ver%%.*}"
os_ok=0
if [[ "$os_major" =~ ^[0-9]+$ ]]; then
  case "$os_id" in
    ubuntu) [ "$os_major" -ge 22 ] && os_ok=1 ;;
    debian) [ "$os_major" -ge 12 ] && os_ok=1 ;;
  esac
fi
[ "$os_ok" = 1 ] || refuse "this box runs ${os_id:-an unknown OS} ${os_ver}; a satellite needs Ubuntu 22.04+ or Debian 12+"
arch="$(uname -m)"
case "$arch" in
  x86_64 | aarch64 | arm64) ;;
  *) refuse "this box is $arch; a satellite needs x86_64 or arm64" ;;
esac

# Memory, swap, disk.
mem_kb=0
swap_kb=0
while read -r key val _; do
  case "$key" in
    MemTotal:) mem_kb="$val" ;;
    SwapTotal:) swap_kb="$val" ;;
  esac
done <"$MEMINFO"
[ "$mem_kb" -ge "$MIN_MEM_KB" ] || refuse "this box has $((mem_kb / 1024)) MiB of RAM; a satellite needs at least 900 MiB"
NEED_SWAP=0
if [ "$swap_kb" -eq 0 ]; then
  NEED_SWAP=1
  plan "offer to create 2 GiB swap at /swapfile (none is on; --make-swap answers yes)"
elif [ "$swap_kb" -lt "$MIN_SWAP_KB" ]; then
  refuse "this box has $((swap_kb / 1024)) MiB of swap; a satellite needs at least 1 GiB (grow it, or turn it off and re-run to get the 2 GiB offer)"
fi
df_out="$(df -Pk "$RHOME")"
avail_kb="$(awk 'NR == 2 { print $4 }' <<<"$df_out")"
[[ "$avail_kb" =~ ^[0-9]+$ ]] || refuse "could not read the free disk space under $RHOME"
[ "$((avail_kb * 1024))" -ge "$MIN_DISK_BYTES" ] || refuse "only $((avail_kb / 1024)) MiB free under $RHOME; a satellite needs at least 5 GB"

# Tailscale.
TS_MISSING=0
if ! command -v tailscale >/dev/null 2>&1; then
  TS_MISSING=1
  plan "install Tailscale (tailscale.com/install.sh), then the owner logs in (sudo tailscale up)"
else
  TS_JSON="$(tailscale status --json 2>/dev/null || true)"
  [[ "$TS_JSON" =~ \"BackendState\"[[:space:]]*:[[:space:]]*\"Running\" ]] \
    || refuse "Tailscale is installed but not up; run: sudo tailscale up, log in, then re-run"
fi

# A full Crow gateway on this box.
if pgrep -f 'servers/gateway/index\.js' >/dev/null 2>&1 || systemctl is-active --quiet crow-gateway.service 2>/dev/null; then
  refuse "a full Crow gateway is running on this box; a satellite never runs beside one. $STEP0"
fi

# Stray Crow homes: any ~/.crow, ~/.crow.*, ~/.crow-* other than SAT_HOME.
strays=()
for p in "$RHOME/.crow" "$RHOME"/.crow.* "$RHOME"/.crow-*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  [ "$(realpath -m "$p")" = "$SAT_HOME" ] && continue
  strays+=("$p")
done
if [ "${#strays[@]}" -gt 0 ]; then
  printf '  %s\n' "${strays[@]}" >&2
  refuse "found Crow data beside the satellite home ($SAT_HOME): the path(s) above. $STEP0"
fi

# Seed-bearing identity files (any identity.json or identity.json.*, .bak included) under $HOME
# or $CROW_DATA_DIR. The satellite's own code checkout is public code and is skipped. An
# unreadable one counts: refuse rather than guess (same rule as servers/satellite/guards.js).
seeds=()
scan_seeds() {
  local root="$1" f
  [ -d "$root" ] || return 0
  # A find that cannot even read the root would pass the scan silently: fail closed instead.
  find "$root" -maxdepth 0 >/dev/null 2>&1 || refuse "could not scan $root for Crow identity files"
  while IFS= read -r -d '' f; do
    if [ ! -r "$f" ] || grep -qE '"seed"[[:space:]]*:' "$f" 2>/dev/null; then seeds+=("$f"); fi
  done < <(find "$root" -path "$APP_DIR" -prune -o \( -name identity.json -o -name 'identity.json.*' \) \( -type f -o -type l \) -print0 2>/dev/null)
}
scan_seeds "$RHOME"
if [ -n "${CROW_DATA_DIR:-}" ]; then scan_seeds "$(realpath -m "$CROW_DATA_DIR")"; fi
if [ "${#seeds[@]}" -gt 0 ]; then
  printf '  %s\n' "${seeds[@]}" >&2
  refuse "the file(s) above hold a Crow identity seed; a satellite never holds one. $STEP0"
fi

say "preflight passed (${os_id} ${os_ver}, ${arch}, $((mem_kb / 1024)) MiB RAM, SAT_HOME $SAT_HOME)"

# ---------------------------------------------------------------------------------------------
# The plan (printed by --dry-run; the real run follows the same order).
# ---------------------------------------------------------------------------------------------

plan "ensure git, curl and ca-certificates (apt-get) when missing"
plan "ensure Node ${NODE_MAJOR} at ${NODE_BIN} (NodeSource) when missing or not v${NODE_MAJOR}"
plan "ensure Docker Engine (get.docker.com) when missing; add ${USER_NAME} to the docker group"
plan "assert lingering for the update path's systemd-run --user: loginctl enable-linger ${USER_NAME}"
if [ -d "$APP_DIR/.git" ]; then
  plan "git fetch origin in $APP_DIR, then checkout --detach $SHA"
else
  plan "git clone ${REPO_URL} $APP_DIR, then checkout --detach $SHA"
fi
plan "check the agent's own start guards (servers/satellite/guards.js)"
plan "cd $APP_DIR && systemd-run --user --scope -p MemoryMax=600M nice -n 10 npm ci --omit=dev"
plan "make the satellite key in $SAT_HOME/secrets/ (kept if present)"
plan "write ${UNIT_PATH} (below), link ${CLI_LINK}"
plan "assert ufw: active with default deny inbound; add 'allow in on tailscale0' if missing; never change other rules"
plan "refuse if Funnel is on for :443; tailscale serve --bg --https=443 http://127.0.0.1:3014"
plan "start ${UNIT_NAME}; an unpaired agent prints its pairing code (also visible in the journal for its 15 minutes)"
if [ "$REPAIR" = 1 ]; then
  plan "--repair keeps vault/, installed.json, bundle data and secrets/; a valid cert stays paired, a missing or lapsed one returns the agent to unpaired mode; crow is never contacted"
fi

render_unit() {
  cat <<EOF
[Unit]
Description=Crow satellite agent
After=network-online.target tailscaled.service
Wants=network-online.target
# A crash loop (for example new code that fails at boot after an update) stops here; see the
# installer's header for the manual rollback.
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${APP_DIR}
Environment=CROW_PROFILE=satellite CROW_HOME=${SAT_HOME}
Environment=XDG_RUNTIME_DIR=/run/user/${USER_UID}
ExecStart=${NODE_BIN} ${APP_DIR}/servers/satellite/index.js
# 75 = update restart (restarts), 78 = start guard refused (stays down).
Restart=on-failure
RestartPreventExitStatus=78
RestartSec=5
MemoryHigh=150M
MemoryMax=192M
OOMScoreAdjust=-300
Nice=5
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}

if [ "$DRY_RUN" = 1 ]; then
  for step in "${PLAN[@]}"; do echo "plan: $step"; done
  echo "--- ${UNIT_NAME} ---"
  render_unit
  echo "--- end ---"
  say "dry run: nothing was changed"
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# Install.
# ---------------------------------------------------------------------------------------------

umask 077
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT
sudo -v || refuse "sudo is needed for the system steps"

fetch() { curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"; }

# Swap.
if [ "$NEED_SWAP" = 1 ]; then
  if [ "$MAKE_SWAP" = 1 ] || ask_yn "No swap is on. Create 2 GiB of swap at /swapfile?"; then
    [ ! -e /swapfile ] || refuse "/swapfile exists but no swap is on; turn it on or remove it, then re-run"
    say "creating 2 GiB swap at /swapfile"
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
    sudo swapon /swapfile
    if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
      echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    fi
  else
    refuse "a satellite needs at least 1 GiB of swap (re-run with --make-swap to create 2 GiB)"
  fi
fi

# Base packages.
missing=()
for pkg_cmd in git:git curl:curl; do
  command -v "${pkg_cmd#*:}" >/dev/null 2>&1 || missing+=("${pkg_cmd%%:*}")
done
[ -e /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
if [ "${#missing[@]}" -gt 0 ]; then
  say "installing ${missing[*]}"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
fi

# Tailscale (the owner logs in).
if [ "$TS_MISSING" = 1 ]; then
  say "installing Tailscale"
  fetch https://tailscale.com/install.sh "$TMP_DIR/tailscale-install.sh"
  sudo sh "$TMP_DIR/tailscale-install.sh"
  say "log this box into your tailnet: follow the link sudo tailscale up prints"
  sudo tailscale up
  TS_JSON="$(tailscale status --json 2>/dev/null || true)"
  [[ "$TS_JSON" =~ \"BackendState\"[[:space:]]*:[[:space:]]*\"Running\" ]] || refuse "Tailscale is still not up; run: sudo tailscale up, then re-run"
fi

# Node 24 from NodeSource.
node_major=""
if [ -x "$NODE_BIN" ]; then node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"; fi
if [ "$node_major" != "$NODE_MAJOR" ]; then
  say "installing Node ${NODE_MAJOR} (NodeSource)"
  fetch "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" "$TMP_DIR/nodesource-setup.sh"
  sudo -E bash "$TMP_DIR/nodesource-setup.sh"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" = "$NODE_MAJOR" ] || refuse "${NODE_BIN} is v${node_major} after the NodeSource install; a satellite needs v${NODE_MAJOR}"
fi

# Docker Engine.
if ! command -v docker >/dev/null 2>&1; then
  say "installing Docker Engine"
  fetch https://get.docker.com "$TMP_DIR/get-docker.sh"
  sudo sh "$TMP_DIR/get-docker.sh"
fi
if [[ " $(id -nG "$USER_NAME") " != *" docker "* ]]; then
  say "adding ${USER_NAME} to the docker group"
  sudo usermod -aG docker "$USER_NAME"
fi

# Lingering: the agent's update path runs npm ci under systemd-run --user, which needs this
# user's systemd manager even with nobody logged in.
if [ "$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
  say "enabling lingering for ${USER_NAME}"
  sudo loginctl enable-linger "$USER_NAME"
fi
for _ in $(seq 1 20); do [ -d "/run/user/${USER_UID}" ] && break; sleep 0.5; done
[ -d "/run/user/${USER_UID}" ] || refuse "/run/user/${USER_UID} did not appear after enabling lingering"
export XDG_RUNTIME_DIR="/run/user/${USER_UID}"

# Code at --sha.
mkdir -p "$SAT_HOME"
chmod 700 "$SAT_HOME"
if [ -d "$APP_DIR/.git" ]; then
  say "updating the checkout in $APP_DIR"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  git -C "$APP_DIR" fetch --quiet origin main
else
  [ ! -e "$APP_DIR" ] || refuse "$APP_DIR exists but is not a git checkout; move it aside, then re-run"
  say "cloning ${REPO_URL} into $APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
if ! git -C "$APP_DIR" cat-file -e "${SHA}^{commit}" 2>/dev/null; then
  git -C "$APP_DIR" fetch --quiet origin "$SHA" || refuse "commit $SHA is not in ${REPO_URL}"
fi
git -C "$APP_DIR" -c advice.detachedHead=false checkout --quiet --force --detach "$SHA"
[ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$SHA" ] || refuse "the checkout in $APP_DIR is not at $SHA"

# The agent's own start guards, from the checkout (the same rules it applies at every boot).
CROW_PROFILE=satellite CROW_HOME="$SAT_HOME" "$NODE_BIN" --input-type=module -e '
  const { bootGuardMessage, GUARD_EXIT_CODE } = await import(process.argv[1]);
  const env = { CROW_PROFILE: "satellite", CROW_HOME: process.env.CROW_HOME };
  if (process.env.CROW_DATA_DIR) env.CROW_DATA_DIR = process.env.CROW_DATA_DIR;
  const m = bootGuardMessage({ env, satHome: process.env.CROW_HOME, host: "127.0.0.1" });
  if (m) { console.error(m); process.exit(GUARD_EXIT_CODE); }
' "$APP_DIR/servers/satellite/guards.js" || refuse "the agent's start guards refused this box (message above). $STEP0"

# Dependencies under a 600 MB scope.
say "installing dependencies (npm ci --omit=dev, capped at 600 MB)"
(cd "$APP_DIR" && PATH="$SYS_PATH" systemd-run --user --scope --quiet -p MemoryMax=600M nice -n 10 "$NPM_BIN" ci --omit=dev --no-audit --no-fund)

# The satellite key (made once, kept on every re-run).
CROW_PROFILE=satellite CROW_HOME="$SAT_HOME" "$NODE_BIN" --input-type=module -e '
  const { ensureSatelliteKey } = await import(process.argv[1]);
  ensureSatelliteKey(process.env.CROW_HOME);
' "$APP_DIR/servers/satellite/keys.js"
say "satellite key ready in $SAT_HOME/secrets/"

# The unit and the CLI.
render_unit >"$TMP_DIR/$UNIT_NAME"
if ! sudo cmp -s "$TMP_DIR/$UNIT_NAME" "$UNIT_PATH"; then
  say "writing $UNIT_PATH"
  sudo install -m 0644 -o root -g root "$TMP_DIR/$UNIT_NAME" "$UNIT_PATH"
fi
sudo systemctl daemon-reload
sudo systemctl enable --quiet "$UNIT_NAME"
sudo ln -sfn "$APP_DIR/scripts/crow-satellite" "$CLI_LINK"

# ufw: assert, add only the one rule the agent needs, never change anything else.
ufw_out="$(sudo ufw status verbose 2>&1)" || refuse "ufw is not installed or not readable; install it, turn it on with a default-deny inbound policy and your ssh rule, then re-run"
[[ "$ufw_out" == *"Status: active"* ]] || refuse "ufw is not active; turn it on yourself with a default-deny inbound policy and your ssh rule (so you are not locked out), then re-run"
[[ "$ufw_out" =~ Default:\ deny\ \(incoming\) ]] || refuse "ufw's inbound default is not deny; set it yourself (check your ssh rule first), then re-run"
if ! grep -qE '^Anywhere on tailscale0[[:space:]]+ALLOW IN' <<<"$ufw_out"; then
  say "adding the ufw rule: allow in on tailscale0"
  sudo ufw allow in on tailscale0 comment 'crow-satellite' >/dev/null
fi
grep -qE '^(22|22/tcp|OpenSSH)[[:space:]]' <<<"$ufw_out" \
  || say "note: ufw has no 22/tcp rule; ssh then works only over the tailnet (left as is)"

# Tailscale Serve: `/` on the tailnet :443 → the agent. Never Funnel.
serve_state() {
  # shellcheck disable=SC2016 # a node program: its ${...} are JavaScript, not shell
  SERVE_JSON="$(sudo tailscale serve status --json 2>/dev/null || true)" "$NODE_BIN" -e '
    let j = {};
    try { j = JSON.parse(process.env.SERVE_JSON || "{}") || {}; } catch {}
    const funnel = Object.entries(j.AllowFunnel || {}).some(([k, v]) => v && k.endsWith(":443"));
    const web = Object.entries(j.Web || {}).find(([k]) => k.endsWith(":443"));
    const root = web ? web[1]?.Handlers?.["/"]?.Proxy || "" : "";
    console.log(`${funnel ? "funnel" : "nofunnel"} ${root || "-"}`);
  '
}
read -r funnel_state _ <<<"$(serve_state)"
[ "$funnel_state" = "nofunnel" ] || refuse "Tailscale Funnel is on for :443 on this box; turn Funnel off for :443 first (the agent must never be public)"
say "pointing Tailscale Serve / on :443 at the agent"
sudo tailscale serve --bg --https=443 http://127.0.0.1:3014 >/dev/null
read -r funnel_state serve_root <<<"$(serve_state)"
if [ "$funnel_state" != "nofunnel" ] || [ "$serve_root" != "http://127.0.0.1:${AGENT_PORT}" ]; then
  refuse "Tailscale Serve / on :443 is not http://127.0.0.1:${AGENT_PORT} after the re-point (funnel: $funnel_state, / → $serve_root)"
fi

# Start (or restart) the agent and wait for its readiness line.
since="$(date +%s)"
sudo systemctl restart "$UNIT_NAME"
journal=""
for _ in $(seq 1 60); do
  journal="$(sudo journalctl -u "$UNIT_NAME" --since "@${since}" -o cat --no-pager 2>/dev/null || true)"
  [[ "$journal" == *"listening on 127.0.0.1:${AGENT_PORT}"* ]] && break
  if sudo systemctl is-failed --quiet "$UNIT_NAME"; then break; fi
  sleep 1
done
if [[ "$journal" != *"listening on 127.0.0.1:${AGENT_PORT}"* ]]; then
  echo "$journal" >&2
  echo "satellite-install: the agent did not start; see: sudo journalctl -u $UNIT_NAME" >&2
  exit 1
fi

echo
while IFS= read -r line; do
  case "$line" in "Pairing code:"* | "This server id:"* | "Paired"*) echo "  $line" ;; esac
done <<<"$journal"
echo
if [[ "$journal" == *"Pairing code:"* ]]; then
  say "enter the pairing code on crow: Extensions > Servers > Add a server, and check the server id matches."
  say "the code is also visible in this box's journal (journalctl -u crow-satellite) for its 15-minute life, to anyone who can read the journal; crow-satellite pair-code prints a fresh one and voids the old one."
else
  say "the agent is paired; nothing to do on crow."
fi
if [ "$SAT_HOME" != "$RHOME/.crow-satellite" ]; then
  say "SAT_HOME is $SAT_HOME: run the CLI as SAT_HOME=$SAT_HOME crow-satellite status"
fi
say "done"
