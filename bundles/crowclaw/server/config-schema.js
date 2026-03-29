/**
 * CrowClaw — OpenClaw Config Validation
 *
 * Validates OpenClaw configuration values and detects security downgrades.
 */

// Paths that are security-sensitive — warn when downgrading
const SECURITY_PATHS = new Set([
  "security",
  "discord.allowFrom",
  "discord.groupPolicy",
  "discord.allowBots",
]);

const SECURITY_DOWNGRADES = {
  security: (oldVal, newVal) => oldVal === "allowlist" && newVal === "open",
  "discord.allowFrom": (oldVal, newVal) => {
    if (Array.isArray(newVal) && newVal.includes("*")) return true;
    return false;
  },
  "discord.groupPolicy": (oldVal, newVal) => oldVal === "allowlist" && newVal === "open",
  "discord.allowBots": (oldVal, newVal) => newVal === true,
};

/**
 * Check if a config change is a security downgrade.
 * @returns {{ isDowngrade: boolean, warning?: string }}
 */
export function checkSecurityDowngrade(path, oldValue, newValue) {
  if (!SECURITY_PATHS.has(path)) return { isDowngrade: false };
  const checker = SECURITY_DOWNGRADES[path];
  if (checker && checker(oldValue, newValue)) {
    return {
      isDowngrade: true,
      warning: `Security downgrade: "${path}" changing from ${JSON.stringify(oldValue)} to ${JSON.stringify(newValue)}. This reduces bot security.`,
    };
  }
  return { isDowngrade: false };
}

/**
 * Get a nested value from an object by dot-separated path.
 */
export function getByPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/**
 * Set a nested value in an object by dot-separated path.
 */
export function setByPath(obj, path, value) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== "object") {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
  return obj;
}
