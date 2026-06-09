#!/usr/bin/env bash
# F3b — install + enable the per-instance bot runtime on THIS host.
# Usage: scripts/pi-bots/install-runtime.sh <instance-name> [CROW_HOME]
#   <instance-name>  systemd template key, e.g. "crow-mpa" or "grackle"
#   CROW_HOME        optional; defaults to ~/.crow (pass the MPA home dir for MPA)
set -euo pipefail

NAME="${1:?usage: install-runtime.sh <instance-name> [CROW_HOME]}"
CROW_HOME="${2:-$HOME/.crow}"
DATA_DIR="$CROW_HOME/data"
DB_PATH="$DATA_DIR/crow.db"
# Node bin dir for this host's PATH. Defaults to the node currently in PATH
# (run the installer as the user who owns this host's node_modules so the
# native-module ABI matches), overridable via CROW_NODE_BIN; falls back to
# probing common locations. The units invoke `/usr/bin/env node`, so this PATH
# is what selects the node binary per host (crow nvm v20, grackle /usr/bin v22).
NODE_BIN="${CROW_NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  _n="$(command -v node 2>/dev/null || true)"
  if [ -z "$_n" ]; then
    for _c in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node; do
      [ -x "$_c" ] && { _n="$_c"; break; }
    done
  fi
  NODE_BIN="$(dirname "$_n" 2>/dev/null || true)"
fi
[ -x "$NODE_BIN/node" ] || { echo "ERROR: node not found (set CROW_NODE_BIN to its bin dir)" >&2; exit 1; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_SRC="$REPO/scripts/pi-bots/systemd"
ENV_FILE="/etc/crow/pibot-$NAME.env"

[ -f "$DB_PATH" ] || { echo "ERROR: $DB_PATH not found — run 'npm run init-db' for this instance first" >&2; exit 1; }

echo "Installing bot runtime for instance '$NAME' (CROW_HOME=$CROW_HOME)"
sudo mkdir -p /etc/crow
sudo tee "$ENV_FILE" >/dev/null <<EOF
CROW_HOME=$CROW_HOME
CROW_DATA_DIR=$DATA_DIR
CROW_DB_PATH=$DB_PATH
PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
EOF
sudo chmod 0644 "$ENV_FILE"

for u in pibot-gateways@.service pibot-discord@.service pibot-bridge@.service pibot-bridge@.timer; do
  sudo cp "$UNIT_SRC/$u" "/etc/systemd/system/$u"
done
sudo systemctl daemon-reload
sudo systemctl enable --now "pibot-gateways@$NAME.service" "pibot-discord@$NAME.service" "pibot-bridge@$NAME.timer"

echo "Done. Units enabled for '$NAME'. They idle until you turn on"
echo "Settings → Bot Runtime (feature_flags.bot_runtime) on this instance."
