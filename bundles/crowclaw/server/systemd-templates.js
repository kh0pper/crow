/**
 * CrowClaw — Systemd Service File Generator
 *
 * Generates systemd user service units for OpenClaw bot instances.
 */

/**
 * Generate a systemd user service unit file.
 * @param {object} opts
 * @param {string} opts.name - Bot name (used in service name)
 * @param {string} opts.configDir - Path to OpenClaw config directory
 * @param {number} opts.gatewayPort - Gateway HTTP port
 * @param {string} [opts.voiceLangMap] - JSON string for OPENCLAW_VOICE_LANGMAP
 * @param {string} [opts.gogAccount] - Google account email for gog CLI
 * @param {string} [opts.gogKeyringPassword] - Keyring password for gog CLI
 * @returns {string} Service unit file content
 */
export function generateServiceUnit(opts) {
  const {
    name,
    configDir,
    gatewayPort,
    voiceLangMap,
    gogAccount,
    gogKeyringPassword,
  } = opts;

  const envLines = [
    `Environment=HOME=%h`,
    `Environment=OPENCLAW_CONFIG_DIR=${configDir}`,
    `Environment=OPENCLAW_GATEWAY_PORT=${gatewayPort}`,
  ];

  if (voiceLangMap) {
    envLines.push(`Environment=OPENCLAW_VOICE_LANGMAP=${voiceLangMap}`);
  }
  if (gogAccount) {
    envLines.push(`Environment=GOG_ACCOUNT=${gogAccount}`);
  }
  if (gogKeyringPassword) {
    envLines.push(`Environment=GOG_KEYRING_PASSWORD=${gogKeyringPassword}`);
  }

  return `[Unit]
Description=OpenClaw Gateway — ${name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.nvm/versions/node/v24.8.0/bin/node %h/.nvm/versions/node/v24.8.0/bin/openclaw gateway
WorkingDirectory=${configDir}
Restart=on-failure
RestartSec=10
${envLines.join("\n")}

[Install]
WantedBy=default.target
`;
}

/**
 * Get the expected service unit name for a bot.
 */
export function serviceUnitName(botName) {
  const slug = botName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `openclaw-gateway-${slug}.service`;
}
