#!/usr/bin/env bash
# Matrix Bridges post-install.
#
# 1. For each BRIDGE_*_ENABLED=true flag, start the corresponding compose
#    profile so the bridge container boots and generates its
#    /data/registration.yaml.
# 2. Wait for registration.yaml to appear.
# 3. Copy the YAML into the crow-dendrite container's appservices dir.
# 4. Patch dendrite.yaml's app_service_api.config_files list to include
#    the new YAML (idempotent — skip if already present).
# 5. Restart crow-dendrite (appservice registrations are read ONLY at
#    startup; hot reload silently no-ops).
# 6. Print bridge-bot MXIDs and next steps (DM the bot to start pairing).

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BUNDLE_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

COMPOSE="docker compose -f ${BUNDLE_DIR}/docker-compose.yml"

# Map BRIDGE_*_ENABLED → (profile, bridge_id, registration_filename)
BRIDGE_RECORDS=()
if [ "${BRIDGE_SIGNAL_ENABLED:-false}" = "true" ];   then BRIDGE_RECORDS+=("signal:mautrix-signal:signal.yaml"); fi
if [ "${BRIDGE_TELEGRAM_ENABLED:-false}" = "true" ]; then BRIDGE_RECORDS+=("telegram:mautrix-telegram:telegram.yaml"); fi
if [ "${BRIDGE_WHATSAPP_ENABLED:-false}" = "true" ]; then BRIDGE_RECORDS+=("whatsapp:mautrix-whatsapp:whatsapp.yaml"); fi

if [ ${#BRIDGE_RECORDS[@]} -eq 0 ]; then
  cat <<EOF
No bridges enabled. Set one or more of the following in .env, then re-run:
    BRIDGE_SIGNAL_ENABLED=true      # RISK: Signal ToS prohibits bots
    BRIDGE_TELEGRAM_ENABLED=true    # Requires BRIDGE_TELEGRAM_API_ID/HASH
    BRIDGE_WHATSAPP_ENABLED=true    # RISK: WhatsApp may ban the phone

After editing, run: crow bundle restart matrix-bridges
EOF
  exit 0
fi

# Start the enabled profiles
PROFILES_ARG=""
for rec in "${BRIDGE_RECORDS[@]}"; do
  profile="${rec%%:*}"
  PROFILES_ARG+=" --profile $profile"
done
echo "Starting bridge containers${PROFILES_ARG}…"
eval "$COMPOSE$PROFILES_ARG up -d"

# Wait for each bridge's registration.yaml
for rec in "${BRIDGE_RECORDS[@]}"; do
  IFS=':' read -r profile container yaml <<< "$rec"
  full_container="crow-${container}"
  echo "Waiting for ${full_container} to generate /data/registration.yaml (up to 120s)…"
  for i in $(seq 1 24); do
    if docker exec "$full_container" test -f /data/registration.yaml 2>/dev/null; then
      echo "  → ${full_container} registration.yaml ready"
      break
    fi
    sleep 5
  done
done

# Copy each registration.yaml into crow-dendrite
if ! docker ps --format '{{.Names}}' | grep -qw crow-dendrite; then
  echo "ERROR: crow-dendrite is not running. Start matrix-dendrite bundle first." >&2
  exit 1
fi

docker exec crow-dendrite mkdir -p /etc/dendrite/appservices
for rec in "${BRIDGE_RECORDS[@]}"; do
  IFS=':' read -r profile container yaml <<< "$rec"
  full_container="crow-${container}"
  TMP="$(mktemp)"
  docker cp "$full_container:/data/registration.yaml" "$TMP"
  docker cp "$TMP" "crow-dendrite:/etc/dendrite/appservices/$yaml"
  rm -f "$TMP"
  echo "  → copied $yaml into crow-dendrite:/etc/dendrite/appservices/"
done

# Patch dendrite.yaml to include the new appservice config_files (idempotent)
CFG=/etc/dendrite/dendrite.yaml
for rec in "${BRIDGE_RECORDS[@]}"; do
  IFS=':' read -r profile container yaml <<< "$rec"
  entry="    - appservices/$yaml"
  if docker exec crow-dendrite grep -qF "appservices/$yaml" "$CFG" 2>/dev/null; then
    echo "  → dendrite.yaml already references appservices/$yaml"
    continue
  fi
  # Add / update app_service_api.config_files block. Whole-file awk for safety.
  docker exec crow-dendrite sh -c "
    if ! grep -q 'app_service_api:' $CFG; then
      printf '\napp_service_api:\n  config_files:\n    - appservices/$yaml\n' >> $CFG
    elif ! grep -q 'config_files:' $CFG; then
      awk '/app_service_api:/{print;print \"  config_files:\";print \"    - appservices/$yaml\";next}1' $CFG > $CFG.tmp && mv $CFG.tmp $CFG
    else
      awk -v ENT=\"    - appservices/$yaml\" '
        {print}
        /^[[:space:]]*config_files:/{print ENT}
      ' $CFG > $CFG.tmp && mv $CFG.tmp $CFG
    fi
  "
  echo "  → patched dendrite.yaml with appservices/$yaml"
done

# Restart Dendrite (appservice registrations are only read at startup)
echo "Restarting crow-dendrite (appservice registrations read at startup only)…"
DENDRITE_COMPOSE="${BUNDLE_DIR}/../matrix-dendrite/docker-compose.yml"
if [ -f "$DENDRITE_COMPOSE" ]; then
  docker compose -f "$DENDRITE_COMPOSE" restart dendrite
else
  docker restart crow-dendrite >/dev/null
fi

# Wait for Dendrite to come back healthy
echo "Waiting for Dendrite to report healthy after restart (up to 60s)…"
for i in $(seq 1 12); do
  if docker inspect crow-dendrite --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then
    echo "  → dendrite healthy"
    break
  fi
  sleep 5
done

cat <<EOF

Matrix Bridges post-install complete. Enabled bridges:
EOF
for rec in "${BRIDGE_RECORDS[@]}"; do
  IFS=':' read -r profile container yaml <<< "$rec"
  echo "  • $profile (container: crow-$container, registration: appservices/$yaml)"
done
cat <<EOF

Next steps per bridge:

  Signal:    DM @signalbot:${MATRIX_BRIDGE_DOMAIN:-example.com} → 'login'
             (Scans QR from your phone's Signal → Linked Devices)

  Telegram:  DM @telegrambot:${MATRIX_BRIDGE_DOMAIN:-example.com} → 'login'
             (Enter phone number + SMS code or password)

  WhatsApp:  DM @whatsappbot:${MATRIX_BRIDGE_DOMAIN:-example.com} → 'login qr'
             (Scans QR from your phone's WhatsApp → Linked Devices)
             Meta may ban the linked number — assume it's at risk.

If a bridge bot doesn't respond, check:
  docker logs crow-mautrix-<bridge>
  docker exec crow-dendrite cat /etc/dendrite/appservices/<yaml>

EOF
