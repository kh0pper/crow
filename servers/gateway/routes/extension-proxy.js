/**
 * Extension Web UI Reverse Proxy
 *
 * Proxies extension web UIs through the Crow gateway so they're accessible
 * via the same HTTPS hostname — no need to open extra firewall ports.
 *
 * For each installed extension with a `webUI` field in its manifest,
 * creates a proxy route at /proxy/<id>/ → localhost:<port>.
 *
 * WebSocket upgrade is handled (needed for VNC/noVNC).
 *
 * Dashboard links should use:
 *   /proxy/browser/vnc.html   instead of   http://localhost:6080/vnc.html
 *   /proxy/minio/              instead of   http://localhost:9001/
 */

import { createProxyMiddleware } from "http-proxy-middleware";
import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isAllowedNetwork, parseCookies, verifySession } from "../dashboard/auth.js";

// Respect CROW_HOME so a secondary instance (systemd unit with its own
// CROW_HOME) proxies ITS extensions — not the primary's. Hardcoding ~/.crow
// here made every co-hosted instance serve the primary's web UIs.
const CROW_HOME = process.env.CROW_HOME || join(homedir(), ".crow");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");
const BUNDLES_DIR = join(CROW_HOME, "bundles");

function getManifest(bundleId) {
  const manifestPath = join(BUNDLES_DIR, bundleId, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function getProxiedExtensions() {
  if (!existsSync(INSTALLED_PATH)) return [];
  try {
    const installed = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
    const proxied = [];
    for (const entry of installed) {
      const manifest = getManifest(entry.id);
      if (manifest?.webUI?.port) {
        // webUI.portEnv names an env var that overrides the manifest port —
        // lets a per-instance unit remap the backend (e.g. a second browser
        // container on 6081) without editing the shared manifest.
        const envPort = manifest.webUI.portEnv
          ? Number(process.env[manifest.webUI.portEnv]) || null
          : null;
        proxied.push({
          id: entry.id,
          name: manifest.name || entry.id,
          port: envPort || manifest.webUI.port,
          path: manifest.webUI.path || "/",
          label: manifest.webUI.label || manifest.name || entry.id,
          proxyMode: manifest.webUI.proxyMode || "subpath",
          // Name of a file under CROW_HOME holding a bearer token for the
          // backend (perch-hub's `perch-token`). Never a path the manifest
          // can point outside CROW_HOME — see readAuthToken().
          authTokenFile: manifest.webUI.authTokenFile || null,
        });
      }
    }
    return proxied;
  } catch {
    return [];
  }
}

/**
 * Read the bearer token an extension's manifest named in
 * `webUI.authTokenFile`, or null when there is none / it is not there yet.
 *
 * LAZY BY CONTRACT. The perch-hub token is minted by `perch-runtime.js` from
 * the post-listen boot step, while this proxy's route table is built earlier
 * (boot/late-mounts.js) — a read at factory-construction time gets nothing on
 * the very first boot after install, and would then serve an empty header for
 * the whole process lifetime. So this runs per request instead.
 *
 * `authTokenFile` is manifest-supplied, so it is resolved against CROW_HOME
 * and rejected unless it stays inside it (no `../../.ssh/id_ed25519`).
 *
 * @param {string|null} authTokenFile relative filename from the manifest
 * @param {string} [crowHome] test seam; defaults to the module's CROW_HOME
 * @returns {string|null} trimmed token, or null (header is then omitted and
 *   the backend answers 401 — an honest failure, not a forged one)
 */
export function readAuthToken(authTokenFile, crowHome = CROW_HOME) {
  if (!authTokenFile) return null;
  const tokenPath = resolve(crowHome, authTokenFile);
  if (tokenPath !== resolve(crowHome) && !tokenPath.startsWith(resolve(crowHome) + sep)) return null;
  try {
    return readFileSync(tokenPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Authorize a WebSocket upgrade for /proxy/<id> paths (W2-1 security fix).
 *
 * server.on("upgrade") bypasses Express entirely, so the dashboardAuth
 * middleware mounted on the HTTP routes never runs for WS — previously an
 * unauthenticated LAN/tailnet client could reach extension web UIs
 * (including noVNC) over WS. Mirror the layers here:
 *   1. Network gate — isAllowedNetwork (funnel reject + private-network
 *      allowlist), exactly the layer the HTTP routes get via dashboardAuth.
 *   2. Session check — the crow_session cookie must be a live dashboard
 *      session (verifySession; DB-backed).
 *
 * @param {import('http').IncomingMessage} req  raw upgrade request
 * @returns {Promise<boolean>} true only when the upgrade may proceed
 */
export async function authorizeExtensionUpgrade(req) {
  // Layer parity with the HTTP gate: isAllowedNetwork covers the funnel
  // reject AND the network allowlist (loopback reject, private-IP ranges,
  // CROW_DASHBOARD_PUBLIC) — it reads req.headers + req.connection, both
  // present on a raw upgrade request.
  if (!isAllowedNetwork(req)) return false;
  const token = parseCookies(req)["crow_session"];
  if (!token) return false;
  try {
    return (await verifySession(token)) === true;
  } catch {
    return false;
  }
}

/**
 * Create the extension proxy router and WebSocket setup function.
 *
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @param {object} [opts]
 * @param {Function} [opts.createProxy] seam over createProxyMiddleware, so a
 *   test can read back the options this file hands to http-proxy-middleware —
 *   the websocket hook has no other observable surface short of a full
 *   session-authed upgrade.
 * @returns {{ router: Router, setupWebSocket: (server: import('http').Server) => void }}
 */
export default function extensionProxyFactory(authMiddleware, { createProxy = createProxyMiddleware } = {}) {
  const router = Router();
  const extensions = getProxiedExtensions();
  const proxyInstances = [];

  for (const ext of extensions) {
    // Skip direct-mode extensions (SPA apps that can't work behind a subpath proxy)
    if (ext.proxyMode === "direct") continue;

    const target = `http://127.0.0.1:${ext.port}`;
    const proxyPath = `/proxy/${ext.id}`;

    const proxyMiddleware = createProxy({
      target,
      changeOrigin: true,
      ws: true,
      pathRewrite: { [`^/proxy/${ext.id}`]: "" },
      logLevel: "warn",
      // Strip headers that block iframe embedding and fix cookies
      on: {
        // Inject the backend's bearer, read fresh on every request (see
        // readAuthToken). No token file → no header, and the backend 401s.
        //
        // ⚠ LOAD-BEARING CSRF DEPENDENCY — READ BEFORE CHANGING COOKIE POLICY.
        // Injecting the bearer means the BACKEND's own auth is already
        // satisfied for anything that reaches this middleware, so the only
        // gate left is Crow's session. This router is mounted at APP ROOT
        // (boot/late-mounts.js `app.use(router)`) — deliberately OUTSIDE the
        // /dashboard CSRF rail (dashboard/index.js `router.use("/dashboard",
        // csrfMiddleware)`), because proxied backends serve their own forms
        // and cannot echo Crow's `X-Crow-Csrf`.
        //
        // For perch-hub that backend exposes `POST /api/hub/spawn`, which its
        // own header documents as arbitrary code execution. The ONLY thing
        // preventing a cross-site POST from riding a logged-in operator's
        // session into it is `SameSite=Lax` on `crow_session`
        // (dashboard/auth.js setSessionCookie) — Lax withholds the cookie from
        // cross-site POSTs, so the request arrives session-less and
        // authMiddleware rejects it before we ever inject a bearer.
        //
        // Therefore: relaxing that cookie to `SameSite=None` (e.g. "so the
        // dashboard can be embedded in an iframe") converts this hook into
        // remote code execution reachable from any page the operator visits.
        // If embedding is ever needed, this router needs its own CSRF or
        // origin check FIRST. tests/perch-routes.test.js pins both halves.
        proxyReq: (proxyReq) => {
          const token = readAuthToken(ext.authTokenFile);
          if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
        },
        // Same injection for the websocket upgrade, which never passes
        // through the `proxyReq` hook — http-proxy emits `proxyReqWs` for it.
        proxyReqWs: (proxyReq) => {
          const token = readAuthToken(ext.authTokenFile);
          if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
        },
        proxyRes: (proxyRes) => {
          // Allow embedding in iframes (needed for VNC, MinIO console)
          delete proxyRes.headers["x-frame-options"];
          delete proxyRes.headers["content-security-policy"];
          // Fix cookie paths (backend sets path=/ but we serve from /proxy/<id>/)
          const setCookie = proxyRes.headers["set-cookie"];
          if (setCookie) {
            proxyRes.headers["set-cookie"] = (Array.isArray(setCookie) ? setCookie : [setCookie])
              .map(c => c.replace(/path=\//i, `path=/proxy/${ext.id}/`));
          }
        },
      },
      // NOTE: dead since the http-proxy-middleware v2→v3 bump — v3 reads error
      // handlers from `on.error`, and silently ignores this top-level
      // `onError`. Left as-is on purpose: adopting it changes live 502 copy,
      // which is its own change with its own test. (Perch Hub C-3.)
      onError: (err, req, res) => {
        if (!res || res.headersSent) return;
        res.status(502).json({
          error: `Extension '${ext.name}' is not running on port ${ext.port}`,
          hint: "Start it from the Browser panel or Extensions page.",
        });
      },
    });

    // Mount behind auth for HTTP requests
    router.use(proxyPath, authMiddleware, proxyMiddleware);
    proxyInstances.push({ ext, proxyPath, proxyMiddleware });

    console.log(`  [proxy] Extension UI: ${ext.label} → ${proxyPath}/ → ${target}`);
  }

  // GET /proxy — list all extension web UIs (proxied and direct)
  router.get("/proxy", authMiddleware, (req, res) => {
    const host = req.hostname || "localhost";
    res.json({
      extensions: extensions.map((ext) => ({
        id: ext.id,
        name: ext.name,
        label: ext.label,
        proxyMode: ext.proxyMode,
        url: ext.proxyMode === "direct"
          ? `${req.protocol}://${host}:${ext.port}${ext.path}`
          : `/proxy/${ext.id}${ext.path}`,
        port: ext.port,
      })),
    });
  });

  /**
   * Set up WebSocket upgrade handling on the HTTP server.
   * Must be called after server.listen().
   */
  function setupWebSocket(server) {
    if (proxyInstances.length === 0) return;

    server.on("upgrade", (req, socket, head) => {
      for (const { proxyPath, proxyMiddleware } of proxyInstances) {
        if (req.url?.startsWith(proxyPath)) {
          // W2-1: upgrades bypass Express, so enforce dashboard auth here.
          authorizeExtensionUpgrade(req).then((ok) => {
            if (!ok) {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
              socket.destroy();
              return;
            }
            proxyMiddleware.upgrade(req, socket, head);
          }).catch(() => {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
          });
          return;
        }
      }
    });

    console.log(`  [proxy] WebSocket upgrade handler registered for ${proxyInstances.length} extension(s) (session-gated)`);
  }

  return { router, setupWebSocket };
}
