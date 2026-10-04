/**
 * Workspace toolset configuration, read lazily from <CROW_HOME>/bundles/workspace/.env.
 * Bootstrap writes WORKSPACE_BOT_APP_PASSWORD after the MCP server is registered, so the
 * file is re-parsed whenever its mtime changes. The bundle codec decodes installer quoting.
 * Nothing here is ever logged.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { appImport } from "./app-root.js";
import { WsError } from "./result.js";
const { parseEnvText } = await appImport("servers/gateway/bundle-env-codec.js");

export const BOT_USER = "crow-bot";
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const crowHome = () => process.env.CROW_HOME || join(homedir(), ".crow");
export const envPath = () => join(crowHome(), "bundles", "workspace", ".env");

let cache = null;
function readEnv() {
  const p = envPath();
  let st;
  try { st = statSync(p); } catch { return {}; }
  if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.values;
  const values = parseEnvText(readFileSync(p, "utf8"));
  cache = { path: p, mtimeMs: st.mtimeMs, size: st.size, values };
  return values;
}

export function getConfig() {
  const e = readEnv();
  const host = HOST_RE.test(e.WORKSPACE_PUBLIC_HOST || "") ? e.WORKSPACE_PUBLIC_HOST : "";
  const port = /^[0-9]{2,5}$/.test(e.WORKSPACE_NC_SERVE_PORT || "") ? e.WORKSPACE_NC_SERVE_PORT : "8456";
  const appPassword = e.WORKSPACE_BOT_APP_PASSWORD || "";
  if (e.WORKSPACE_BOOTSTRAP_DONE !== "1" || !appPassword || !host) {
    throw new WsError("not_ready", `Crow Workspace setup has not finished. On the Crow machine run: bash ${join(crowHome(), "bundles", "workspace", "ops", "bootstrap.sh")}`);
  }
  const jwtSecret = e.WORKSPACE_ONLYOFFICE_JWT_SECRET || "";
  return Object.freeze({
    user: BOT_USER, appPassword, jwtSecret, host,
    ncUrl: (process.env.WORKSPACE_NC_INTERNAL_URL || "http://127.0.0.1:3070").replace(/\/+$/, ""),
    ooUrl: (process.env.WORKSPACE_OO_INTERNAL_URL || "http://127.0.0.1:3071").replace(/\/+$/, ""),
    webBase: `https://${host}:${port}`,
    secrets: Object.freeze([appPassword, jwtSecret].filter(Boolean)),
  });
}

/** Replace every secret occurrence; a null cfg tries the live config and tolerates not_ready. */
export function redact(text, cfg) {
  let s = String(text);
  let c = cfg;
  if (!c) { try { c = getConfig(); } catch { c = null; } }
  for (const v of c?.secrets || []) if (v) s = s.split(v).join("[redacted]");
  return s;
}
