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

export default function browserRouter(authMiddleware) {
  const router = Router();

  // POST /api/browser/control — start/stop/restart container
  router.post("/api/browser/control", authMiddleware, async (req, res) => {
    const { action } = req.body || {};
    const composePath = join(homedir(), ".crow", "bundles", "browser", "docker-compose.yml");

    try {
      switch (action) {
        case "start":
          execFileSync("docker", ["compose", "-f", composePath, "up", "-d"], { timeout: 30000 });
          break;
        case "stop":
          execFileSync("docker", ["stop", "crow-browser"], { timeout: 15000 });
          break;
        case "restart":
          execFileSync("docker", ["restart", "crow-browser"], { timeout: 30000 });
          break;
        default:
          return res.status(400).json({ error: `Unknown action: ${action}` });
      }
    } catch (err) {
      // Don't fail hard — container might not exist yet
    }

    if (req.headers.accept?.includes("text/html")) {
      return res.redirectAfterPost("/dashboard/browser");
    }
    res.json({ ok: true, action });
  });

  // GET /api/browser/status — container and CDP health check
  router.get("/api/browser/status", authMiddleware, async (req, res) => {
    let containerRunning = false;
    try {
      const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", "crow-browser"], { encoding: "utf-8", timeout: 5000 }).trim();
      containerRunning = out === "true";
    } catch {}

    let cdpConnected = false;
    try {
      execFileSync("curl", ["-s", "-m", "2", "http://127.0.0.1:9222/json/version"], { encoding: "utf-8", timeout: 5000 });
      cdpConnected = true;
    } catch {}

    res.json({ containerRunning, cdpConnected });
  });

  return router;
}
