/**
 * The artifact origin's process-wide state (spec §3.2, §11): one view-token
 * store and one content resolver per gateway process, shared by the listener
 * (server.js) and the bundle's panel routes, which mint tokens. The bundle
 * registers its resolver when its routes initialise; until then every request
 * is a 404 (with the full sandbox headers).
 *
 * Configuration (per instance; nothing starts without a port):
 *   CROW_ARTIFACT_ORIGIN_PORT  loopback port (registered in port-allocation.md)
 *   CROW_ARTIFACT_ORIGIN_BIND  default 127.0.0.1 (a container instance binds
 *                              0.0.0.0 inside its namespace and publishes on
 *                              host loopback, behind its DOCKER-USER fence)
 *   CROW_ARTIFACT_ORIGIN_URL   the origin browsers use, e.g.
 *                              https://crow-artifacts.example.ts.net — its OWN
 *                              hostname (D13). Unset → the loopback fallback
 *                              http://localhost:<port>, local-only, weaker.
 */
import { createViewTokenStore } from "./view-tokens.js";
import { startArtifactOrigin } from "./server.js";

let tokens = createViewTokenStore();
let resolver = null;
let info = null;
let server = null;

export function viewTokens() { return tokens; }
export function setContentResolver(fn) { resolver = typeof fn === "function" ? fn : null; }
export function artifactOriginInfo() { return info; }

/** Strict: scheme + host [+ port], nothing else. */
export function parseOriginUrl(v) {
  if (!v) return null;
  let u;
  try { u = new URL(String(v)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
  return u.origin;
}

/**
 * Isolation as seen from one dashboard request (§5.1): "own-host" when the
 * artifact origin's hostname differs from the dashboard's; otherwise
 * "shared-host" (the fallback: cookies reach the listener and are stripped).
 */
export function isolationFor(dashboardHost) {
  if (!info) return "unavailable";
  const h = new URL(info.baseUrl).hostname;
  const d = String(dashboardHost || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return h && d && h.toLowerCase() !== d.toLowerCase() ? "own-host" : "shared-host";
}

export async function startArtifactOriginFromEnv(env = process.env) {
  const raw = env.CROW_ARTIFACT_ORIGIN_PORT;
  if (raw == null || String(raw).trim() === "") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CROW_ARTIFACT_ORIGIN_PORT must be a port number (1-65535)");
  const configured = parseOriginUrl(env.CROW_ARTIFACT_ORIGIN_URL);
  if (env.CROW_ARTIFACT_ORIGIN_URL && !configured) throw new Error("CROW_ARTIFACT_ORIGIN_URL must be scheme://host[:port] with no path");
  const host = env.CROW_ARTIFACT_ORIGIN_BIND || "127.0.0.1";
  server = await startArtifactOrigin({
    port, host, tokens, publicBase: configured,
    resolveContent: async (q) => (resolver ? resolver(q) : null),
  });
  info = { baseUrl: configured || `http://localhost:${port}`, port, configured: !!configured };
  return server;
}

/** Test seam. */
export function _resetForTest() { tokens = createViewTokenStore(); resolver = null; info = null; if (server) { server.closeAllConnections?.(); server.close(); server = null; } }
export function _setInfoForTest(i) { info = i; }
