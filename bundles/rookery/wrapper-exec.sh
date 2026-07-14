#!/usr/bin/env bash
# wrapper-exec.sh — env allowlist interposer for stdio MCP servers (Phase-2
# blocker a: upstream OpenScience spawns local MCP servers with the FULL
# unfiltered process.env — backend/cli/src/mcp/index.ts:403).
#
# Every LOCAL (stdio) MCP registered in openscience.json gets its command
# prefixed with this wrapper. OpenScience still spawns the wrapper with the
# polluted env — harmless: the wrapper does `env -i` (clean slate) and
# re-execs the real server with ONLY the base allowlist (PATH, HOME,
# WORKSPACES_DIR) plus per-server vars declared via --allow. The real MCP
# process never sees provider keys, crow tokens, or anything else. This is
# an ALLOWLIST — the entrypoint's scrub-env.sh denylist is defense-in-depth
# only, this wrapper is THE mechanism (upstream's own sandboxing plan warns
# against denylists).
#
# Usage (as the MCP "command" array):
#   ["/app/wrapper-exec.sh", "--", "real-server", "arg", ...]
#   ["/app/wrapper-exec.sh", "--allow", "RESEARCH_MCP_API_KEY,FOO", "--",
#    "real-server", ...]
#
# Trade-off (accepted in the plan): an MCP needing an undocumented env var
# fails until the operator adds it to that server's --allow list.
#
# Failure-mode affordance: the wrapper logs the exact env it passes to
# stderr (MCP spawn failures are otherwise opaque). Values of
# credential-shaped names are redacted in the log — they still PASS through
# to the child, they just don't land in container logs.

set -euo pipefail

ALLOW=(PATH HOME WORKSPACES_DIR)

while [[ $# -gt 0 ]]; do
  case $1 in
    --allow)
      [[ $# -ge 2 ]] || { echo "[wrapper-exec] --allow needs a value" >&2; exit 2; }
      IFS=', ' read -r -a extra <<<"$2"
      for v in "${extra[@]}"; do
        [[ -n $v ]] && ALLOW+=("$v")
      done
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -gt 0 ]] || { echo "[wrapper-exec] no command given" >&2; exit 2; }

envargs=()
logline=""
for v in "${ALLOW[@]}"; do
  if [[ -n ${!v+x} ]]; then
    envargs+=("$v=${!v}")
    case $v in
      *KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*)
        logline+=" $v=<redacted>" ;;
      *)
        logline+=" $v=${!v}" ;;
    esac
  fi
done

echo "[wrapper-exec] exec: $* | env passed:${logline:- <none>}" >&2
exec env -i "${envargs[@]}" "$@"
