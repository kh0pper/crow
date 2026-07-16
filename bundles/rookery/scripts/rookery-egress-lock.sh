#!/usr/bin/env bash
# rookery-egress-lock.sh — host-kernel egress allowlist for the crow-rookery
# container (Phase-2 blocker b: the OpenScience binary phones a vendor
# endpoint at launch).
#
# Posture (signed off 2026-07-14): MODEL-ONLY. The container reaches nothing
# except the local model endpoint; internet, tailnet peers, other containers,
# and host services are all dropped at the host kernel. Survives container
# rebuilds; does NOT survive reboot (see --print-systemd-unit).
#
# Verified rule shape (Task 2 recon, 2026-07-14): the model endpoint
# (MODEL_PUBLISH, default 100.118.41.122:8010) is a docker-PUBLISHED port of
# the copilot container, so container→model traffic is DNAT'd in
# nat/PREROUTING to <copilot-ip>:<container-port> and traverses
# FORWARD → DOCKER-USER — NOT host INPUT (corrects Task 1a; confirmed by
# DNAT counter increments). The model allow therefore lives in DOCKER-USER,
# pinned to the DNAT'd destination, ahead of the drop-all.
#
# Chains installed (IPv4; IPv6 twins are interface-keyed drop-all — the
# rookery network is IPv4-only, EnableIPv6=false, so v6 rules are insurance
# against a future network recreate with v6 enabled):
#   ROOKERY-EGRESS   from DOCKER-USER pos 1 (-i <bridge>):
#                    ESTABLISHED accept → model accept → extra published-port
#                    accepts → rate-limited LOG → DROP
#   ROOKERY-INGRESS  from DOCKER-USER pos 2 (-o <bridge>):
#                    ESTABLISHED accept → LOG → DROP. The UI's published
#                    127.0.0.1:3061 rides docker-proxy from the host (OUTPUT
#                    path) and is unaffected.
#   ROOKERY-HOSTIN   from INPUT pos 1 (-i <bridge>):
#                    ESTABLISHED accept (docker-proxy return path — removing
#                    it kills the UI) → ALLOW_HOST_TCP_PORTS accepts → LOG →
#                    DROP.
# Plus a subnet-keyed tripwire DROP appended to DOCKER-USER (catches traffic
# if the bridge name drifts while the subnet doesn't).
#
# Idempotency: every rule placed in a shared chain (DOCKER-USER, INPUT)
# carries -m comment --comment rookery-lock; install removes by tag first.
#
# ufw coexistence: ufw-* chains and policies are never touched. `ufw reload`
# and `ufw enable` rewrite only ufw's own chains; docker preserves
# DOCKER-USER across daemon restarts. Verified layout on crow 2026-07-14:
# INPUT policy DROP → ts-input → ufw-*; FORWARD → DOCKER-USER first.
#
# Docker embedded DNS caveat: in-container resolution (127.0.0.11) is
# answered by dockerd, whose upstream lookups run as a HOST process — that
# leg cannot be cheaply blocked here. Names still resolve; connections die
# in DOCKER-USER. Accepted in the plan.
#
# Re-run triggers: reboot, `docker network` recreate (compose down/up of the
# rookery OR copilot stack — bridge names, subnets, and the DNAT target are
# all derived fresh each run), copilot container recreate (its IP changes).
# The companion rookery-egress-verify.sh detects drift.
#
# Usage:
#   sudo ./rookery-egress-lock.sh                     install/refresh
#   sudo ./rookery-egress-lock.sh --remove            remove everything
#        ./rookery-egress-lock.sh --dry-run           print, run nothing
#   sudo ./rookery-egress-lock.sh --status            show installed rules
#        ./rookery-egress-lock.sh --print-systemd-unit  reboot persistence
#   sudo ./rookery-egress-lock.sh --wait 180          poll for docker state
#
# Config (env, all optional):
#   ROOKERY_NETWORK            docker network name (default rookery_default)
#   MODEL_PUBLISH              host ip:port of the model endpoint the bundle
#                              is configured against (default
#                              100.118.41.122:8010)
#   ALLOW_HOST_TCP_PORTS       extra host-INPUT tcp ports reachable from the
#                              container, space/comma-separated (Task 4 adds
#                              the crow API port here)
#   ALLOW_PUBLISHED_TCP_PORTS  extra docker-published host ports; each is
#                              resolved to its DNAT target like the model's
#   ROOKERY_BRIDGE, ROOKERY_SUBNET, MODEL_DST (ip:port)
#                              derivation overrides (used by the tests;
#                              MODEL_DST is the post-DNAT destination)

set -euo pipefail

# Record which config vars the CALLER set (before defaulting) so
# --print-systemd-unit can bake them into the unit — a bare boot-time re-run
# would otherwise drop the deployed posture (live gap 2026-07-16: the unit
# reinstalled the lock without ALLOW_HOST_TCP_PORTS=3006, silently killing
# the MCP bridge after reboot).
CALLER_SET=()
for v in MODEL_PUBLISH ALLOW_PUBLISHED_TCP_PORTS ALLOW_HOST_TCP_PORTS ROOKERY_NETWORK; do
  [[ -n ${!v:-} ]] && CALLER_SET+=("$v")
done

ROOKERY_NETWORK=${ROOKERY_NETWORK:-rookery_default}
MODEL_PUBLISH=${MODEL_PUBLISH:-100.118.41.122:8010}
ALLOW_HOST_TCP_PORTS=${ALLOW_HOST_TCP_PORTS:-}
ALLOW_PUBLISHED_TCP_PORTS=${ALLOW_PUBLISHED_TCP_PORTS:-}

DRY=false
MODE=install
WAIT_SECS=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY=true ;;
    --remove) MODE=remove ;;
    --status) MODE=status ;;
    --print-systemd-unit) MODE=unit ;;
    --wait) WAIT_SECS=${2:?--wait needs seconds}; shift ;;
    -h|--help) sed -n '2,80p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

CHAINS=(ROOKERY-EGRESS ROOKERY-INGRESS ROOKERY-HOSTIN)
CMT=(-m comment --comment rookery-lock)

runcmd() { if $DRY; then echo "+ $*"; else "$@"; fi; }
run4() { runcmd iptables -w "$@"; }
run6() { runcmd ip6tables -w "$@"; }
note() { echo "[rookery-egress-lock] $*" >&2; }

# ---------------------------------------------------------------- derivation

derive_network() {
  if [[ -n ${ROOKERY_BRIDGE:-} && -n ${ROOKERY_SUBNET:-} ]]; then
    BRIDGE=$ROOKERY_BRIDGE SUBNET=$ROOKERY_SUBNET
    return 0
  fi
  local id
  id=$(docker network inspect "$ROOKERY_NETWORK" --format '{{.Id}}' 2>/dev/null) || return 1
  BRIDGE=${ROOKERY_BRIDGE:-br-${id:0:12}}
  SUBNET=${ROOKERY_SUBNET:-$(docker network inspect "$ROOKERY_NETWORK" \
    --format '{{(index .IPAM.Config 0).Subnet}}')} || return 1
  [[ -n $BRIDGE && -n $SUBNET ]]
}

# Resolve a host-published ip:port to its post-DNAT "ip port" pair by asking
# docker for the container that publishes it (same data the DNAT rule is
# generated from).
derive_published_dst() {
  local publish=$1 hostip hostport cid
  hostip=${publish%:*} hostport=${publish##*:}
  cid=$(docker ps --filter "publish=${hostport}" -q 2>/dev/null | head -1)
  [[ -n $cid ]] || return 1
  docker inspect "$cid" | python3 -c '
import json, sys
hostip, hostport = sys.argv[1], sys.argv[2]
c = json.load(sys.stdin)[0]
cport = None
for key, binds in (c["NetworkSettings"]["Ports"] or {}).items():
    if not key.endswith("/tcp"):
        continue
    for b in binds or []:
        if b.get("HostPort") == hostport and b.get("HostIp") in (hostip, "0.0.0.0", ""):
            cport = key.split("/")[0]
if not cport:
    sys.exit(1)
ip = next((n["IPAddress"] for n in c["NetworkSettings"]["Networks"].values()
           if n.get("IPAddress")), None)
if not ip:
    sys.exit(1)
print(ip, cport)
' "$hostip" "$hostport"
}

derive_model_dst() {
  if [[ -n ${MODEL_DST:-} ]]; then
    MODEL_IP=${MODEL_DST%:*} MODEL_PORT=${MODEL_DST##*:}
    return 0
  fi
  local pair
  pair=$(derive_published_dst "$MODEL_PUBLISH") || return 1
  MODEL_IP=${pair% *} MODEL_PORT=${pair#* }
}

wait_for_derivation() {
  local deadline=$((SECONDS + WAIT_SECS))
  while :; do
    if derive_network && derive_model_dst; then return 0; fi
    (( SECONDS < deadline )) || return 1
    note "waiting for docker network/model container ($((deadline - SECONDS))s left)…"
    sleep 5
  done
}

# ------------------------------------------------------------------- removal

# Delete every rookery-lock-tagged rule from the shared chains, then flush
# and delete our own chains. Safe to run when nothing is installed.
remove_all() {
  if $DRY; then
    note "would remove all rookery-lock-tagged rules + ROOKERY-* chains (enumeration needs root)"
    return 0
  fi
  local fam chain line
  for fam in iptables ip6tables; do
    for chain in DOCKER-USER INPUT; do
      # Re-scan after each delete: rule numbers shift.
      while line=$("$fam" -w -S "$chain" 2>/dev/null \
                   | grep -F -- '--comment rookery-lock' | head -1); [[ -n $line ]]; do
        # shellcheck disable=SC2086  # rule specs are space-safe token lists
        "$fam" -w ${line/#-A/-D}
      done
    done
    for chain in "${CHAINS[@]}"; do
      "$fam" -w -F "$chain" 2>/dev/null || true
      "$fam" -w -X "$chain" 2>/dev/null || true
    done
  done
}

# ------------------------------------------------------------------- install

install_lock() {
  remove_all

  local fam
  for fam in run4 run6; do
    local c
    for c in "${CHAINS[@]}"; do
      $fam -N "$c" || true
    done

    # EGRESS: container → world
    $fam -A ROOKERY-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    if [[ $fam == run4 ]]; then
      if [[ -n ${MODEL_IP:-} ]]; then
        $fam -A ROOKERY-EGRESS -d "$MODEL_IP/32" -p tcp --dport "$MODEL_PORT" -j ACCEPT
      fi
      local pub pair
      for pub in ${ALLOW_PUBLISHED_TCP_PORTS//,/ }; do
        [[ $pub == *:* ]] || pub="${MODEL_PUBLISH%:*}:$pub"
        if pair=$(derive_published_dst "$pub"); then
          $fam -A ROOKERY-EGRESS -d "${pair% *}/32" -p tcp --dport "${pair#* }" -j ACCEPT
        else
          note "WARN: could not resolve published port $pub — no allow installed for it"
        fi
      done
    fi
    $fam -A ROOKERY-EGRESS -m limit --limit 4/min -j LOG --log-prefix "[ROOKERY-DROP-EGR] "
    $fam -A ROOKERY-EGRESS -j DROP

    # INGRESS: world → container (new connections; the UI path is host-originated)
    $fam -A ROOKERY-INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    $fam -A ROOKERY-INGRESS -m limit --limit 4/min -j LOG --log-prefix "[ROOKERY-DROP-ING] "
    $fam -A ROOKERY-INGRESS -j DROP

    # HOSTIN: container → host-local services (INPUT path)
    $fam -A ROOKERY-HOSTIN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    if [[ $fam == run4 ]]; then
      local p
      for p in ${ALLOW_HOST_TCP_PORTS//,/ }; do
        $fam -A ROOKERY-HOSTIN -p tcp --dport "$p" -j ACCEPT
      done
    fi
    $fam -A ROOKERY-HOSTIN -m limit --limit 4/min -j LOG --log-prefix "[ROOKERY-DROP-HIN] "
    $fam -A ROOKERY-HOSTIN -j DROP

    # Jumps (tagged, position-pinned ahead of everything else)
    $fam -I DOCKER-USER 1 "${CMT[@]}" -i "$BRIDGE" -j ROOKERY-EGRESS
    $fam -I DOCKER-USER 2 "${CMT[@]}" -o "$BRIDGE" -j ROOKERY-INGRESS
    $fam -I INPUT 1 "${CMT[@]}" -i "$BRIDGE" -j ROOKERY-HOSTIN
  done

  # v4-only subnet tripwire: catches rookery-sourced traffic if the bridge
  # name drifted (network recreate) while the subnet didn't. Appended, so
  # legitimately accepted traffic (terminal ACCEPT in ROOKERY-EGRESS) never
  # reaches it.
  run4 -A DOCKER-USER "${CMT[@]}" -s "$SUBNET" -j DROP
}

# -------------------------------------------------------------------- status

show_status() {
  local fam
  for fam in iptables ip6tables; do
    echo "== $fam =="
    "$fam" -w -S DOCKER-USER | grep -F 'rookery-lock' || echo "(no DOCKER-USER jumps)"
    "$fam" -w -S INPUT | grep -F 'rookery-lock' || echo "(no INPUT jump)"
    local c
    for c in "${CHAINS[@]}"; do
      "$fam" -w -vnL "$c" 2>/dev/null || echo "(chain $c absent)"
    done
  done
}

print_unit() {
  local script_path
  script_path=$(readlink -f "$0")
  cat <<UNIT
# Reboot persistence for the rookery egress lock. Install with:
#   sudo $script_path --print-systemd-unit \\
#     | sudo tee /etc/systemd/system/rookery-egress-lock.service
#   sudo systemctl daemon-reload && sudo systemctl enable rookery-egress-lock
# A boot-time RE-RUN is the correct persistence mechanism (not a saved rules
# file): bridge names, subnets, and the DNAT target are derived fresh.
[Unit]
Description=Rookery container egress lock (model-only allowlist)
After=docker.service network-online.target
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
$(for v in ${CALLER_SET[@]+"${CALLER_SET[@]}"}; do printf 'Environment="%s=%s"\n' "$v" "${!v}"; done)# --wait rides out slow container starts; on timeout the lock still installs
# drop-only (fail-closed, no model allow) and exits nonzero so the unit
# shows failed.
ExecStart=$script_path --wait 300

[Install]
WantedBy=multi-user.target
UNIT
}

# ---------------------------------------------------------------------- main

case $MODE in
  unit) print_unit; exit 0 ;;
  status) show_status; exit 0 ;;
  remove)
    remove_all
    note "removed."
    exit 0
    ;;
esac

if (( WAIT_SECS > 0 )); then
  wait_for_derivation || true
fi

derive_network || { note "FATAL: cannot derive network '$ROOKERY_NETWORK' (docker down? network removed?)"; exit 1; }

MODEL_OK=true
if ! derive_model_dst; then
  MODEL_OK=false
  MODEL_IP='' MODEL_PORT=''
  note "WARN: cannot resolve model endpoint $MODEL_PUBLISH to a DNAT target"
  note "WARN: installing DROP-ONLY lock (fail-closed) — the container cannot reach the model."
  note "WARN: re-run once the model container is up."
fi

note "bridge=$BRIDGE subnet=$SUBNET model=${MODEL_IP:-<none>}:${MODEL_PORT:-} (from $MODEL_PUBLISH)"
install_lock
if $MODEL_OK; then
  note "installed."
else
  note "installed drop-only."
  exit 3
fi
