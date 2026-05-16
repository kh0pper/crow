#!/usr/bin/env bash
# S2 spike fixtures — Crow Bot Builder. Run on the CROW box before s2_rpc_drive.mjs.
#
# Idempotent. Creates isolated pi spike config so the production ~/.pi/agent is
# never touched. KEY FACT proven in S2: pi-lab/mcp-client.ts reads
# ~/.pi/agent/mcp.json from homedir() unconditionally (it ignores
# PI_CODING_AGENT_DIR) and additively merges every cwd-ancestor .mcp.json,
# with ~/.pi/agent/mcp.json winning on key collision. Therefore:
#   * agent-real      : pi-lab pinned absolute; pi loads it via PI_CODING_AGENT_DIR
#                       (settings.json IS honored there) — crow MCP is whatever
#                       ~/.pi/agent/mcp.json currently is (healthy post-S0).
#   * cwd-d/.mcp.json : adds a deliberately-unreachable server `crow-broken`
#                       (nonexistent cwd) — the "an MCP server is DOWN" case,
#                       exercised by pinning pi's cwd here.
set -euo pipefail
SPK=/home/kh0pp/.pi-spike
PI=/home/kh0pp/.pi/agent
NODE=/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node

mkdir -p "$SPK"/{cwd,cwd-d,sessions-s2,sessions-s2d} "$SPK/agent-real/sessions"

cd "$SPK/agent-real"
for f in models.json auth.json prompts skills agents; do ln -sfn "$PI/$f" "$f"; done
# settings.json: pi-lab pinned ABSOLUTE so package resolution is unambiguous
# under PI_CODING_AGENT_DIR; keep the rest of the real settings.
"$NODE" -e '
  const fs=require("fs");
  const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  j.packages=["/home/kh0pp/pi-lab","npm:@e9n/pi-mobile","npm:@e9n/pi-webserver"];
  fs.writeFileSync(process.argv[2], JSON.stringify(j,null,2));
' "$PI/settings.json" "$SPK/agent-real/settings.json"

cat > "$SPK/cwd-d/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "crow-broken": { "command": "/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node", "args": ["server/index.js"], "cwd": "/home/kh0pp/NONEXISTENT-bot-builder-s2-down", "env": { "CROW_TASKS_DB_PATH": "/home/kh0pp/.crow-mpa/data/tasks.db" } }
  }
}
JSON

echo "S2 fixtures ready under $SPK (agent-real, cwd, cwd-d, sessions-s2*)"
