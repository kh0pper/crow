/**
 * Crow Browser — Panel API Routes
 *
 * Container control and session management.
 * Pattern: export default function(authMiddleware) → Router
 */

import { Router } from "express";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// The panel is deployed to <CROW_HOME>/panels/, not the bundle directory, so a
// relative import of instance.js can't be correct in both the repo and the
// deployed layout — resolve it by absolute path from CROW_HOME instead.
//
// This is done per-handler rather than once in the factory: panel-registry.js
// calls browserRouter(authMiddleware) synchronously and mounts its return value
// immediately (servers/gateway/index.js), never awaiting it — an async factory
// would hand Express a Promise instead of a Router and silently break mounting.
async function loadInstance() {
  const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
  const instanceUrl = pathToFileURL(join(crowHome, "bundles", "browser", "server", "instance.js")).href;
  return import(instanceUrl);
}

export default function browserRouter(authMiddleware) {
  const router = Router();

  // POST /api/browser/control — start/stop/restart container
  router.post("/api/browser/control", authMiddleware, async (req, res) => {
    const { action } = req.body || {};
    if (!["start", "stop", "restart"].includes(action)) {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    try {
      const { stateRoot, containerName } = await loadInstance();
      const composePath = join(stateRoot(), "bundles", "browser", "docker-compose.yml");
      const container = containerName();

      switch (action) {
        case "start":
          execFileSync("docker", ["compose", "-f", composePath, "up", "-d"], { timeout: 30000 });
          break;
        case "stop":
          execFileSync("docker", ["stop", container], { timeout: 15000 });
          break;
        case "restart":
          execFileSync("docker", ["restart", container], { timeout: 30000 });
          break;
      }
    } catch (err) {
      // Don't fail hard — container might not exist yet (or the bundle isn't installed)
    }

    if (req.headers.accept?.includes("text/html")) {
      return res.redirectAfterPost("/dashboard/browser");
    }
    res.json({ ok: true, action });
  });

  // GET /api/browser/status — container and CDP health check
  router.get("/api/browser/status", authMiddleware, async (req, res) => {
    let containerRunning = false;
    let cdpConnected = false;
    try {
      const { containerName, cdpPort } = await loadInstance();

      try {
        const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", containerName()], { encoding: "utf-8", timeout: 5000 }).trim();
        containerRunning = out === "true";
      } catch {}

      try {
        execFileSync("curl", ["-s", "-m", "2", `http://127.0.0.1:${cdpPort()}/json/version`], { encoding: "utf-8", timeout: 5000 });
        cdpConnected = true;
      } catch {}
    } catch {
      // instance.js not resolvable (bundle not installed) — report both as down
    }

    res.json({ containerRunning, cdpConnected });
  });

  return router;
}
