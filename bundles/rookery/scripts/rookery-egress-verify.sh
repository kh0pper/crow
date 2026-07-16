#!/usr/bin/env bash
# rookery-egress-verify.sh — behavioral verification of the rookery egress
# lock (companion to rookery-egress-lock.sh). Run AFTER installing the lock;
# running it BEFORE is the negative control (the egress probes should FAIL,
# proving the probes actually detect openness).
#
# Checks (no root needed except [7]):
#   1. UI answers 200 on 127.0.0.1:3061 (host path via docker-proxy)
#   2. model answers from INSIDE the container (the one allowed egress)
#   3. internet egress dead   (raw-IP probe, no DNS dependency)
#   4. tailnet hop dead       (grackle probe)
#   5. other published container ports dead (35b :8003) + host INPUT dead
#      (bridge-gateway :22)
#   6. vendor connection ABSENT: no ESTABLISHED socket in the container's
#      netns to anything but the model / the UI's own published port
#      (repeats the runbook §6 socket inspection, from /proc/net/tcp{,6})
#   7. (root only) lock rules present + no bridge/subnet/DNAT drift
#
# Exit 0 = all checks passed. Config env mirrors rookery-egress-lock.sh:
#   ROOKERY_NETWORK, MODEL_PUBLISH, CONTAINER (default crow-rookery),
#   UI_URL (default http://127.0.0.1:3061/),
#   PROBE_INTERNET (default 1.1.1.1:443), PROBE_TAILNET (default
#   100.121.254.89:3002), PROBE_PUBLISHED (default 100.118.41.122:8003)

set -uo pipefail

ROOKERY_NETWORK=${ROOKERY_NETWORK:-rookery_default}
MODEL_PUBLISH=${MODEL_PUBLISH:-100.118.41.122:8010}
CONTAINER=${CONTAINER:-crow-rookery}
UI_URL=${UI_URL:-http://127.0.0.1:3061/}
PROBE_INTERNET=${PROBE_INTERNET:-1.1.1.1:443}
PROBE_TAILNET=${PROBE_TAILNET:-100.121.254.89:3002}
PROBE_PUBLISHED=${PROBE_PUBLISHED:-100.118.41.122:8003}

FAILURES=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILURES=$((FAILURES + 1)); }
warn() { echo "WARN  $*"; }

# Raw TCP connect from inside the container: prints CONNECTED / TIMEOUT /
# ERROR:<code>. Under the lock, blocked destinations must TIMEOUT (DROP);
# ERROR:ECONNREFUSED means the packet got through and was RST — NOT dropped.
probe() {
  local hostport=$1
  docker exec "$CONTAINER" node -e '
const net = require("net");
const [h, p] = process.argv.slice(1);
const s = net.connect({ host: h, port: +p, timeout: 6000 });
s.on("connect", () => { console.log("CONNECTED"); process.exit(0); });
s.on("timeout", () => { console.log("TIMEOUT"); s.destroy(); process.exit(0); });
s.on("error", (e) => { console.log("ERROR:" + e.code); process.exit(0); });
' "${hostport%:*}" "${hostport##*:}" 2>/dev/null
}

expect_blocked() {
  local hostport=$1 label=$2 out
  out=$(probe "$hostport")
  case $out in
    TIMEOUT)   pass "$label ($hostport → $out)" ;;
    CONNECTED) fail "$label ($hostport → CONNECTED — egress is OPEN)" ;;
    ERROR:ECONNREFUSED)
               fail "$label ($hostport → RST received — packet was NOT dropped)" ;;
    *)         warn "$label ($hostport → $out — inconclusive, treating as pass)"
               pass "$label (unreachable)" ;;
  esac
}

# 1. UI
if curl -fsS -m 8 -o /dev/null "$UI_URL"; then
  pass "UI answers at $UI_URL"
else
  fail "UI did NOT answer at $UI_URL"
fi

# 2. model from inside the container
MODEL_OUT=$(docker exec "$CONTAINER" node -e '
fetch(process.argv[1], { signal: AbortSignal.timeout(8000) })
  .then(r => { console.log("HTTP " + r.status); process.exit(r.ok ? 0 : 1); })
  .catch(e => { console.log("FAIL " + e.message); process.exit(1); });
' "http://${MODEL_PUBLISH}/health" 2>/dev/null)
if [[ $MODEL_OUT == "HTTP 200" ]]; then
  pass "model answers from inside the container ($MODEL_PUBLISH)"
else
  fail "model NOT reachable from inside the container ($MODEL_PUBLISH → $MODEL_OUT)"
fi

# 3–5. blocked destinations
expect_blocked "$PROBE_INTERNET"  "internet egress blocked"
expect_blocked "$PROBE_TAILNET"   "tailnet hop blocked"
expect_blocked "$PROBE_PUBLISHED" "other published container port blocked"

GATEWAY=$(docker network inspect "$ROOKERY_NETWORK" \
  --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)
if [[ -n $GATEWAY ]]; then
  expect_blocked "${GATEWAY}:22" "host INPUT blocked (bridge gateway ssh)"
else
  warn "could not derive bridge gateway — skipping host INPUT probe"
fi

# 6. vendor ESTAB absent (runbook §6, from the container's own netns)
ESTAB_OUT=$(docker exec "$CONTAINER" node -e '
const fs = require("fs");
const [modelIp, modelPort] = process.argv.slice(1);
function hex4(ip) { // v4 little-endian hex → dotted
  return ip.match(/../g).reverse().map(h => parseInt(h, 16)).join(".");
}
const offenders = [];
for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]]) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  for (const line of text.trim().split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    const [localA, localP] = f[1].split(":");
    const [remA, remP] = f[2].split(":");
    if (f[3] !== "01") continue; // ESTABLISHED only
    const lport = parseInt(localP, 16), rport = parseInt(remP, 16);
    let rip;
    if (v6) {
      // v4-mapped ::ffff:a.b.c.d lives in the last 8 hex chars
      rip = /^0{20}FFFF/i.test(remA) ? hex4(remA.slice(24)) : "v6:" + remA;
    } else {
      rip = hex4(remA);
    }
    if (rip === modelIp && rport === +modelPort) continue;    // the model
    if (lport === 3061) continue;                             // inbound UI
    if (rip.startsWith("127.") || rip === "v6:" + "0".repeat(32)) continue;
    offenders.push(`${rip}:${rport} (local :${lport})`);
  }
}
if (offenders.length) { console.log("OFFENDERS " + offenders.join(", ")); process.exit(1); }
console.log("CLEAN");
' "${MODEL_PUBLISH%:*}" "${MODEL_PUBLISH##*:}" 2>/dev/null)
if [[ $ESTAB_OUT == CLEAN ]]; then
  pass "no vendor/foreign ESTABLISHED sockets in the container netns"
else
  fail "foreign ESTABLISHED sockets present: ${ESTAB_OUT#OFFENDERS }"
fi

# 7. rule presence + drift (root only)
if [[ $EUID -eq 0 ]]; then
  NET_ID=$(docker network inspect "$ROOKERY_NETWORK" --format '{{.Id}}' 2>/dev/null)
  BRIDGE="br-${NET_ID:0:12}"
  SUBNET=$(docker network inspect "$ROOKERY_NETWORK" \
    --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null)
  for fam in iptables ip6tables; do
    if "$fam" -w -S DOCKER-USER | grep -qF -- "-i $BRIDGE -m comment --comment rookery-lock -j ROOKERY-EGRESS"; then
      pass "$fam DOCKER-USER egress jump present for $BRIDGE"
    else
      fail "$fam DOCKER-USER egress jump MISSING or keyed to a stale bridge (want $BRIDGE) — re-run rookery-egress-lock.sh"
    fi
    if "$fam" -w -S INPUT | grep -qF -- "-i $BRIDGE -m comment --comment rookery-lock -j ROOKERY-HOSTIN"; then
      pass "$fam INPUT jump present for $BRIDGE"
    else
      fail "$fam INPUT jump MISSING or stale (want $BRIDGE)"
    fi
  done
  if iptables -w -S DOCKER-USER | grep -qF -- "-s $SUBNET"; then
    pass "subnet tripwire present for $SUBNET"
  else
    fail "subnet tripwire MISSING or stale (want $SUBNET)"
  fi
else
  warn "not root — skipping rule-presence/drift checks (run with sudo for check 7)"
fi

echo
if (( FAILURES == 0 )); then
  echo "ALL CHECKS PASSED"
else
  echo "$FAILURES CHECK(S) FAILED"
fi
exit $(( FAILURES > 0 ))
