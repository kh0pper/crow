#!/usr/bin/env bash
# Design kit renderer SMOKE instance on 127.0.0.1:18018 (tests only).
#   scripts/design-kit/smoke-renderer.sh up | down
# Same image recipe and hardening as the bundle's compose; separate names, all
# prefixed "design-kit-smoke-" (an operator's deadman can sweep that prefix),
# and its own port, so a test can never reach or disturb the prod renderer on
# 8018 (review L6).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMG=crow-design-kit-renderer:smoke
case "${1:-}" in
  up)
    if ss -ltnH | awk '{print $4}' | grep -qE ':18018$'; then echo "18018 in use" >&2; exit 1; fi
    docker build -t "$IMG" "$ROOT/bundles/design-kit/renderer"
    docker network create --internal design-kit-smoke-internal >/dev/null
    docker network create design-kit-smoke-edge >/dev/null
    docker run -d --name design-kit-smoke-render --network design-kit-smoke-internal --network-alias render \
      --read-only --tmpfs /tmp:size=256m --cap-drop ALL --security-opt no-new-privileges:true \
      --memory 1g --cpus 2 --pids-limit 256 --init -e RENDER_ALLOWED_HOSTS=127.0.0.1:18018 "$IMG" node main.mjs >/dev/null
    docker run -d --name design-kit-smoke-door --network design-kit-smoke-edge -p 127.0.0.1:18018:8018 \
      --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 64m --pids-limit 32 --init "$IMG" node door.mjs >/dev/null
    docker network connect design-kit-smoke-internal design-kit-smoke-door
    for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:18018/health >/dev/null 2>&1 && { echo "smoke renderer up on 127.0.0.1:18018"; exit 0; }; sleep 1; done
    echo "smoke renderer did not come up" >&2; exit 1 ;;
  down)
    docker rm -f design-kit-smoke-door design-kit-smoke-render >/dev/null 2>&1 || true
    docker network rm design-kit-smoke-internal design-kit-smoke-edge >/dev/null 2>&1 || true
    docker image rm "$IMG" >/dev/null 2>&1 || true
    echo "smoke renderer removed" ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
