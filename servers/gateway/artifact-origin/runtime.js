/**
 * The artifact origin's process-wide state (spec §3.2, §11): one view-token
 * store and one content resolver per gateway process, shared by the listener
 * (server.js) and the bundle's panel routes, which mint tokens. The bundle
 * registers its resolver when its routes initialise; until then every request
 * is a 404 (with the full sandbox headers).
 *
 * Configuration (per instance; nothing starts without a port):
 *   CROW_ARTIFACT_ORIGIN_PORT  port of this instance's origin listener
 *                              (registered in port-allocation.md). It is not
 *                              necessarily a loopback port: the BIND decides
 *                              where it listens.
 *   CROW_ARTIFACT_ORIGIN_BIND  default 127.0.0.1. A host-run gateway with a
 *                              sidecar binds its bridge's gateway IP (e.g.
 *                              172.30.0.1); a container instance binds 0.0.0.0
 *                              INSIDE its own namespace and publishes on host
 *                              loopback, behind its DOCKER-USER fence.
 *   CROW_ARTIFACT_ORIGIN_URL   the origin browsers use, e.g.
 *                              https://crow-artifacts.example.ts.net — its OWN
 *                              hostname (D13). Unset → the fallback below:
 *                              http://<bind or loopback>:<port>, local-only,
 *                              weaker.
 */
import { createViewTokenStore } from "./view-tokens.js";
// F1: one helper decides "this machine", shared with the sidecar audit.
import { isLoopbackOrWildcardHost } from "./sidecar-health.js";
// D24: the bundle's panel routes reach the decision through the runtime (the
// one process-wide surface they import), never their own copy of the table.
export { loadDecision } from "./view-tokens.js";
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

/**
 * The address a process on this machine uses to reach the listener (suggestion 6):
 * the bind address, with the wildcards mapped to loopback. The preview renderer's
 * fetcher connects here, never to the host in a browser's URL.
 */
function loopbackFor(bind) {
  const h = String(bind).replace(/^\[|\]$/g, "");
  if (h === "0.0.0.0") return "127.0.0.1";
  if (h === "::") return "::1";
  return h;
}

/**
 * The fallback origin browsers use when CROW_ARTIFACT_ORIGIN_URL is unset.
 *
 * A loopback bind (in any spelling) or a wildcard gives the documented
 * `http://localhost:<port>` — that is the hostname a dashboard tab on this
 * machine uses, so `isolationFor` still reports `shared-host` there. A bind that
 * is NOT this machine (a docker bridge's gateway IP) gives that address, because
 * `localhost` does not answer on it; the isolation is then `own-host` anyway.
 */
export function fallbackOriginUrl(host, port) {
  const bind = loopbackFor(host);
  const base = isLoopbackOrWildcardHost(host) ? "localhost" : bind;
  return `http://${base.includes(":") ? `[${base}]` : base}:${port}`;
}

export async function startArtifactOriginFromEnv(env = process.env) {
  // Idempotent (PR A review L6): a second call returns the running server
  // instead of orphaning its reference. Restart = _resetForTest (tests) or a
  // process restart.
  if (server) return server;
  const raw = env.CROW_ARTIFACT_ORIGIN_PORT;
  if (raw == null || String(raw).trim() === "") return null;
  // Digits only (review R1): Number() would accept "0x0BF2" (3058), "1e3"
  // (1000) and "0" — none of which is the port an operator meant to write.
  const digits = String(raw).trim();
  if (!/^\d{1,5}$/.test(digits)) throw new Error("CROW_ARTIFACT_ORIGIN_PORT must be a port number (1-65535)");
  const port = Number(digits);
  if (port < 1 || port > 65535) throw new Error("CROW_ARTIFACT_ORIGIN_PORT must be a port number (1-65535)");
  const configured = parseOriginUrl(env.CROW_ARTIFACT_ORIGIN_URL);
  if (env.CROW_ARTIFACT_ORIGIN_URL && !configured) throw new Error("CROW_ARTIFACT_ORIGIN_URL must be scheme://host[:port] with no path");
  const host = env.CROW_ARTIFACT_ORIGIN_BIND || "127.0.0.1";
  server = await startArtifactOrigin({
    port, host, tokens, publicBase: configured,
    resolveContent: async (q) => (resolver ? resolver(q) : null),
  });
  // The fallback base is the address the browser really reaches: loopback and
  // wildcard binds keep the documented `http://localhost:<port>`, anything else
  // is named (see fallbackOriginUrl).
  info = { baseUrl: configured || fallbackOriginUrl(host, port), port, configured: !!configured, bindHost: loopbackFor(host) };
  return server;
}

/** Boot ordering (review F8): the origin's bind may be a docker bridge's
 *  gateway IP. When the gateway starts before `docker.service` has created that
 *  bridge, `listen()` fails with EADDRNOTAVAIL and the origin stays off until
 *  the next restart — so the caller retries, bounded, and warns at the end. */
export const ORIGIN_BIND_RETRY_EVERY_MS = 5000;
export const ORIGIN_BIND_RETRY_WINDOW_MS = 2 * 60 * 1000;

/** The retry's sleep. `unref()`d (review N6): a boot's bind retry must never
 *  hold the process open — a shutdown, or a `node -e` that imports this module,
 *  would otherwise wait out the last 5 s tick (and the tests would hang).
 *  Exported as the injection default.
 */
export const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** A missing bind address (a race with dockerd), not a typo in the env. */
export function isAddressNotAvailable(err) {
  return err != null && (err.code === "EADDRNOTAVAIL" || err.cause?.code === "EADDRNOTAVAIL");
}

/**
 * `startArtifactOriginFromEnv`, retried while the bind address does not exist
 * yet. Returns the server, or null once the window is spent (the caller has
 * already warned; the origin is simply off). Any other error — a bad port, an
 * unparseable URL — is rethrown unchanged on the first attempt.
 *
 * `sleep` and `everyMs`/`windowMs` are injectable so the tests do not sleep.
 */
export async function startArtifactOriginWithBindRetry({
  start = startArtifactOriginFromEnv, env = process.env, log = (m) => console.warn(m),
  sleep = defaultSleep, everyMs = ORIGIN_BIND_RETRY_EVERY_MS, windowMs = ORIGIN_BIND_RETRY_WINDOW_MS,
} = {}) {
  for (let waited = 0; ; waited += everyMs) {
    try {
      return await start(env);
    } catch (err) {
      if (!isAddressNotAvailable(err)) throw err;
      if (waited + everyMs > windowMs) {
        log(`[gateway] artifact origin NOT started: ${err.message} (its bind address was still missing after ${Math.round(windowMs / 1000)}s; start the gateway After=docker.service)`);
        return null;
      }
      log(`[gateway] artifact origin waiting for its bind address (${err.code}); retrying in ${Math.round(everyMs / 1000)}s`);
      await sleep(everyMs);
    }
  }
}

/** Test seam. */
export function _resetForTest() { tokens = createViewTokenStore(); resolver = null; info = null; if (server) { server.closeAllConnections?.(); server.close(); server = null; } }
export function _setInfoForTest(i) { info = i; }
