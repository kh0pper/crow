/**
 * Which Crow instance is this browser server bound to?
 *
 * One module, one answer. server.js used to disagree with itself: browser-sessions
 * honored CROW_HOME while browser-exports and browser-downloads hardcoded ~/.crow,
 * so a second instance on the same host wrote its downloads into the primary's
 * directory. Everything instance-scoped resolves here now.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** This instance's home. Falls back to the primary, which is correct only for the primary. */
export function stateRoot() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/** A state directory under this instance's home, e.g. stateDir("browser-downloads"). */
export function stateDir(name) {
  return join(stateRoot(), name);
}

/**
 * The instance's bundle .env, parsed lazily and cached per resolved path.
 *
 * The MCP server gets CROW_BROWSER_* from its MCP config block, but the dashboard
 * panel runs inside the gateway process, which carries none of them — they live in
 * <CROW_HOME>/bundles/browser/.env. Layering that file under process.env keeps the
 * server's behaviour identical while making the panel resolve its own instance.
 */
let envCache = null;
function bundleEnv() {
  const path = join(stateRoot(), "bundles", "browser", ".env");
  if (envCache && envCache.path === path) return envCache.values;
  const values = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No .env (fresh checkout, bundle not installed) — defaults apply.
  }
  envCache = { path, values };
  return values;
}

/** process.env wins, then this instance's bundle .env, then the default. */
function setting(key, fallback) {
  return process.env[key] || bundleEnv()[key] || fallback;
}

/**
 * The docker container this instance's browser runs in.
 *
 * manifest.json declares CROW_BROWSER_CONTAINER_NAME and r4's addon sets it, but
 * server.js used to hardcode "crow-browser" in all four of its docker calls — one
 * of which is `docker restart`, so a secondary instance restarting "its" browser
 * killed the primary's Chrome and every session logged into it.
 */
export function containerName() {
  return setting("CROW_BROWSER_CONTAINER_NAME", "crow-browser");
}

/** This instance's Chrome DevTools Protocol port. */
export function cdpPort() {
  return setting("CROW_BROWSER_CDP_PORT", "9222");
}

/** This instance's noVNC port. */
export function vncPort() {
  return setting("CROW_BROWSER_VNC_PORT", "6080");
}
