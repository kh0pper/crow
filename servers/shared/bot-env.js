/**
 * The environment a bot's pi process starts with (Kevin ruling 2026-10-08).
 *
 * It used to be the whole gateway environment — which, once the gateway has
 * loaded the repo .env, includes tokens and passwords — so any bot with a
 * shell could print them with `env`. Now it is an explicit allowlist: system
 * basics, locale, proxy/CA settings, and the non-secret Crow/pi paths the
 * bot engine reads. MCP servers do not need the gateway's secrets inherited:
 * core server blocks carry their env explicitly, and add-on blocks carry
 * their own. The bridge then adds its computed PI_* keys and the bot def's
 * own spawn_env on top.
 *
 * Operator knobs (gateway env, never a bot def):
 *   CROW_BOT_ENV_ALLOW="A,B"   extra names to pass (secret-like names are
 *                              still refused)
 *   CROW_BOT_ENV_PASSTHROUGH=1 old behaviour (full env). While set, no bot
 *                              may have a shell: the permission validator
 *                              refuses ask/auto/allowlist and the bridge
 *                              clamps any stored one to deny.
 */

const EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "TMPDIR",
  "XDG_RUNTIME_DIR", "XDG_DATA_DIRS", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_ENV",
  // Crow instance paths (no credentials)
  "CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_TASKS_DB_PATH", "CROW_APP_ROOT",
  "CROW_GATEWAY_PORT", "CROW_GATEWAY_URL",
  // pi / pi-lab
  "PI_CODING_AGENT_DIR", "PI_MODELS_JSON", "PI_LOCAL_MODELS_SETTINGS", "PI_BOT_INTERACTIVE_ASK_TIMEOUT_MS",
]);
// LC_*: locale. PIBOT_TEST_*: test-harness capture hooks (stub pi children
// in tests/ write what they were handed there); never set on a real gateway.
const PREFIXES = ["LC_", "PIBOT_TEST_"];

/** Names that look like they hold a credential. Never passed. */
export const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASS(WORD|WD)?|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|SIGNING|DSN)/i;

export function botEnvScrubbed(env = process.env) {
  return String((env && env.CROW_BOT_ENV_PASSTHROUGH) || "") !== "1";
}

export function buildBotBaseEnv(source = process.env, { extraAllow = source.CROW_BOT_ENV_ALLOW || "" } = {}) {
  if (!botEnvScrubbed(source)) return { ...source };
  const extra = new Set(String(extraAllow || "").split(",").map((s) => s.trim()).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== "string") continue;
    if (SECRET_NAME_RE.test(k)) continue;
    if (EXACT.has(k) || PREFIXES.some((p) => k.startsWith(p)) || extra.has(k)) out[k] = v;
  }
  return out;
}
