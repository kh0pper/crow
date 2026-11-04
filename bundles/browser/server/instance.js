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
import { readFileSync, statSync } from "node:fs";
import { appImport } from "./app-root.js";
const { parseEnvText } = await appImport("servers/gateway/bundle-env-codec.js");

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
  let values = {};
  try {
    // Compose-exact decoding (bundle-env-codec.js): the installer quotes a value
    // with spaces or symbols; the container sees it unquoted.
    values = parseEnvText(readFileSync(path, "utf8"));
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

/** A CDP token: url-safe base64 or hex, long enough to be unguessable, short enough to cap. */
const CDP_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
/** The last token read: { path, mtimeMs, size, value } — see cdpToken() for why it is not bundleEnv(). */
let tokenCache = null;

/**
 * This instance's CDP token, or null when there is none (or it is malformed).
 *
 * Deliberately NOT bundleEnv()'s process-lifetime cache and NOT process.env: the token is a
 * secret the gateway mints into the bundle .env after the fact (mint_if_missing on repair), a
 * long-running process must pick that up without a restart, and the manifest keeps it out of
 * process.env (propagate: false) so MCP children and the gateway .env never carry it. A file
 * whose mtime and size are unchanged is not re-parsed; every other call re-reads it.
 */
export function cdpToken() {
  const path = join(stateRoot(), "bundles", "browser", ".env");
  let st;
  try { st = statSync(path); } catch { tokenCache = null; return null; }
  if (tokenCache && tokenCache.path === path && tokenCache.mtimeMs === st.mtimeMs && tokenCache.size === st.size) return tokenCache.value;
  let value = null;
  try {
    const raw = parseEnvText(readFileSync(path, "utf8")).CROW_BROWSER_CDP_TOKEN;
    if (typeof raw === "string" && CDP_TOKEN_RE.test(raw.trim())) value = raw.trim();
  } catch { value = null; }
  tokenCache = { path, mtimeMs: st.mtimeMs, size: st.size, value };
  return value;
}
