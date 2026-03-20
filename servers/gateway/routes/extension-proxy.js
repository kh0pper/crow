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
import { join } from "node:path";
import { homedir } from "node:os";

const CROW_HOME = join(homedir(), ".crow");
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
        proxied.push({
          id: entry.id,
          name: manifest.name || entry.id,
          port: manifest.webUI.port,
          path: manifest.webUI.path || "/",
          label: manifest.webUI.label || manifest.name || entry.id,
        });
      }
    }
    return proxied;
  } catch {
    return [];
  }
}

/**
 * Create the extension proxy router and WebSocket setup function.
 *
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {{ router: Router, setupWebSocket: (server: import('http').Server) => void }}
 */
export default function extensionProxyFactory(authMiddleware) {
  const router = Router();
  const extensions = getProxiedExtensions();
  const proxyInstances = [];

  for (const ext of extensions) {
    const target = `http://127.0.0.1:${ext.port}`;
    const proxyPath = `/proxy/${ext.id}`;

    const proxyMiddleware = createProxyMiddleware({
      target,
      changeOrigin: true,
      ws: true,
      pathRewrite: { [`^/proxy/${ext.id}`]: "" },
      logLevel: "warn",
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

  // GET /proxy — list all proxied extensions
  router.get("/proxy", authMiddleware, (req, res) => {
    res.json({
      extensions: extensions.map((ext) => ({
        id: ext.id,
        name: ext.name,
        label: ext.label,
        url: `/proxy/${ext.id}${ext.path}`,
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
          proxyMiddleware.upgrade(req, socket, head);
          return;
        }
      }
    });

    console.log(`  [proxy] WebSocket upgrade handler registered for ${proxyInstances.length} extension(s)`);
  }

  return { router, setupWebSocket };
}
