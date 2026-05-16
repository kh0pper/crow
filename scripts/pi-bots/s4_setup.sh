#!/usr/bin/env bash
# S4 spike fixture — Crow Bot Builder. Run on the CROW box before
# s4_regex_schema.mjs. Idempotent. Depends on s2_setup.sh having created
# ~/.pi-spike/agent-real (the driver sets PI_CODING_AGENT_DIR there).
#
# Exposes the S4 pattern MCP server to pi via a cwd-ancestor .mcp.json (the
# per-bot MCP mechanism proven in S2). pi registers its tools as
# mcp__s4__s4_echo_pattern (param has JSON-Schema `pattern`) and
# mcp__s4__s4_echo_plain (control). `--tools` in the driver allowlists exactly
# one so the tools[] array sent to the model carries only the schema under test.
set -euo pipefail
SPK=/home/kh0pp/.pi-spike
SRV=/home/kh0pp/crow/scripts/pi-bots/s4_pattern_mcp.mjs   # canonical committed path
NODE=/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node

[ -f "$SRV" ] || { echo "missing $SRV (deploy ~/crow first)"; exit 1; }
mkdir -p "$SPK/cwd-s4" "$SPK/sessions-s4"
cat > "$SPK/cwd-s4/.mcp.json" <<JSON
{
  "mcpServers": {
    "s4": { "command": "$NODE", "args": ["$SRV"], "cwd": "$SPK/cwd-s4" }
  }
}
JSON
echo "S4 fixture ready: $SPK/cwd-s4/.mcp.json -> s4 MCP server ($SRV)"
