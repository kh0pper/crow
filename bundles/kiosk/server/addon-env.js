/**
 * An installed add-on's environment for the kiosk panel (the music library's URL and token).
 *
 * Read at the moment it is needed, so a token change applies without a restart. The entry's
 * `keychainEnv` names are unsealed with THIS process's role: the panel runs in the gateway, which
 * registered one. When the keychain cannot produce them (an add-on child, a deleted row) the plain
 * settings are returned instead — a caller that finds no token already treats the library as
 * unavailable, and a listed name never has a plain value to fall back to.
 *
 * Nothing here logs or returns a value anywhere but the caller's in-memory config.
 */
import { readFileSync } from "node:fs";
import { appImport } from "./app-root.js";

const { AddonKeysUnavailableError, hydrateAddonEntry, processUnsealer } = await appImport("servers/shared/addon-secrets.js");
const { gatewayKeychainPaths } = await appImport("servers/gateway/addon-keys-paths.js");

/** The add-on's env object (never null when the entry has one), or null when it is not installed. */
export function addonEnvFromFile(addonsFile, id) {
  let entry;
  try {
    entry = JSON.parse(readFileSync(addonsFile, "utf8"))?.[id];
  } catch {
    return null; // not installed / unreadable
  }
  if (!entry || typeof entry !== "object") return null;
  let hydrated = entry;
  try {
    hydrated = hydrateAddonEntry(id, entry, { unsealer: processUnsealer(), ...gatewayKeychainPaths() });
  } catch (err) {
    if (!(err instanceof AddonKeysUnavailableError)) throw err;
    hydrated = entry; // the plain settings only; its listed names have no plain value
  }
  const env = hydrated?.env;
  return env && typeof env === "object" ? env : null;
}