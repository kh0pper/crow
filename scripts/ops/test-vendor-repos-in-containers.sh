#!/usr/bin/env bash
#
# Vendor apt repositories, wired up end to end inside a throwaway container.
#
# Usage:
#   scripts/ops/test-vendor-repos-in-containers.sh              # debian:13, ubuntu:24.04
#   scripts/ops/test-vendor-repos-in-containers.sh --all        # + debian:12, ubuntu:22.04
#   scripts/ops/test-vendor-repos-in-containers.sh ubuntu:22.04 # any of those four, added
#
# Needs Docker and a working network: each target pulls its image and installs
# Docker, Node.js 24 and Tailscale from their own apt repositories, using the
# installer's own install_docker_repo / install_nodesource_repo /
# install_tailscale_repo helpers against the real keys and the real gpg. It
# prints PASS or FAIL per target and exits non-zero if any target failed.
#
# Nothing of the host is involved beyond this repository, mounted read-only at
# /crow. No container is privileged, no daemon is started (policy-rc.d answers
# 101 to every start request), and `tailscale up` is never run.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT_IMAGES=(debian:13 ubuntu:24.04)
EXTRA_IMAGES=(debian:12 ubuntu:22.04)

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required (and so is a network for the image pulls)" >&2
  exit 2
fi

# The in-container half. Quoted heredoc: nothing here is expanded by THIS shell,
# so every $ below belongs to the container. It runs as root inside a fresh
# image; the only paths it writes are that container's own.
container_script() {
  cat << 'IN_CONTAINER'
set -euo pipefail

fail=0
ok()    { printf '  ok: %s\n' "$1"; }
bad()   { printf '  NOT OK: %s\n' "$1"; fail=1; }
check() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi; }

# No service may start in here: dpkg asks /usr/sbin/policy-rc.d first, and 101
# is "do not start it".
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 0755 /usr/sbin/policy-rc.d
check "policy-rc.d blocks service starts" test -x /usr/sbin/policy-rc.d

if command -v bash >/dev/null 2>&1; then
  apt-get update
else
  apt-get update
  apt-get install -y --no-install-recommends bash
fi

# The installer's helper layer only: CROW_SUDO=env makes every privileged step
# run in place (this container is already root), and CROW_INSTALL_SOURCE_ONLY
# stops the script before its install body.
export CROW_INSTALL_SOURCE_ONLY=1
export CROW_SUDO=env
# shellcheck disable=SC1091
. /crow/scripts/crow-install.sh

install_docker_repo
install_nodesource_repo 24
install_tailscale_repo

check "docker-ce installed" dpkg -s docker-ce
check "containerd.io installed" dpkg -s containerd.io
check "docker-compose-plugin installed" dpkg -s docker-compose-plugin
check "tailscale installed" dpkg -s tailscale
check "nodejs installed" dpkg -s nodejs
check "the tailscale archive keyring is installed" dpkg -s tailscale-archive-keyring

node_version="$(node --version 2>/dev/null || true)"
case "$node_version" in
  v24.*) ok "node --version is ${node_version}" ;;
  *) bad "node --version is '${node_version}', expected v24.x" ;;
esac

check "docker --version runs" docker --version
if tailscale version --client >/dev/null 2>&1 || tailscale --version >/dev/null 2>&1; then
  ok "tailscale version runs"
else
  bad "tailscale version runs"
fi

check "Docker key file exists" test -s /etc/apt/keyrings/docker.asc
check "Docker source file exists" test -s /etc/apt/sources.list.d/docker.sources
check "NodeSource key file exists" test -s /etc/apt/keyrings/nodesource.asc
check "NodeSource source file exists" test -s /etc/apt/sources.list.d/nodesource.sources
check "Tailscale key file exists" test -s /usr/share/keyrings/tailscale-archive-keyring.gpg
check "Tailscale source file exists" test -s /etc/apt/sources.list.d/tailscale.list

# nodejs must resolve to NodeSource, not to the distribution's own (older) one.
node_policy="$(apt-cache policy nodejs 2>/dev/null || true)"
node_candidate="$(printf '%s\n' "$node_policy" | sed -n 's/^ *Candidate: //p')"
if [ -z "$node_candidate" ]; then
  bad "apt knows a candidate for nodejs"
else
  ok "apt candidate for nodejs is ${node_candidate}"
fi
case "$node_policy" in
  *deb.nodesource.com*) ok "the nodejs candidate comes from deb.nodesource.com" ;;
  *) bad "the nodejs candidate comes from deb.nodesource.com" ;;
esac

exit "$fail"
IN_CONTAINER
}

IMAGES=("${DEFAULT_IMAGES[@]}")
add_image() {
  local candidate="$1" known=""
  for known in "${IMAGES[@]}"; do
    if [ "$candidate" = "$known" ]; then return 0; fi
  done
  for known in "${EXTRA_IMAGES[@]}"; do
    if [ "$candidate" = "$known" ]; then IMAGES+=("$candidate"); return 0; fi
  done
  echo "unknown image '$candidate' (allowed: ${DEFAULT_IMAGES[*]} ${EXTRA_IMAGES[*]})" >&2
  return 1
}

for arg in "$@"; do
  case "$arg" in
    --all)
      for image in "${EXTRA_IMAGES[@]}"; do
        add_image "$image" || exit 2
      done ;;
    -h|--help)
      sed -n '3,20p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *)
      add_image "$arg" || exit 2 ;;
  esac
done

failures=0
for image in "${IMAGES[@]}"; do
  echo ""
  echo "== $image"
  # Only the repository, read-only; no other host path, no --privileged.
  if docker run --rm -v "$REPO:/crow:ro" "$image" bash -c "$(container_script)"; then
    echo "PASS $image"
  else
    echo "FAIL $image"
    failures=$((failures + 1))
  fi
done

echo ""
if [ "$failures" -ne 0 ]; then
  echo "FAIL: $failures of ${#IMAGES[@]} target(s) did not install their vendor repositories"
  exit 1
fi
echo "PASS: ${#IMAGES[@]} target(s) installed and resolved Docker, Node.js 24 and Tailscale"