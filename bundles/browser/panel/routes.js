/**
 * Crow Browser — Panel API Routes
 *
 * Container control and session management endpoints.
 */

import { execFileSync } from "child_process";

export default function browserRoutes(router) {
  // POST /dashboard/browser/control — start/stop/restart container
  router.post("/dashboard/browser/control", async (req, res) => {
    const { action } = req.body || {};

    try {
      switch (action) {
        case "start":
          execFileSync("docker", ["compose", "-f", process.env.CROW_BROWSER_COMPOSE || `${process.env.HOME}/.crow/bundles/browser/docker-compose.yml`, "up", "-d"], { timeout: 30000 });
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
      // Don't fail hard — container might not exist for start
    }

    // Redirect back to dashboard
    if (req.headers.accept?.includes("text/html")) {
      return res.redirect("/dashboard#browser");
    }
    res.json({ success: true, action });
  });

  // GET /api/browser/status — container and CDP health
  router.get("/api/browser/status", async (req, res) => {
    let containerRunning = false;
    try {
      const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", "crow-browser"], { encoding: "utf-8", timeout: 5000 }).trim();
      containerRunning = out === "true";
    } catch {}

    let cdpConnected = false;
    try {
      const out = execFileSync("curl", ["-s", "-m", "2", "http://127.0.0.1:9222/json/version"], { encoding: "utf-8", timeout: 5000 });
      cdpConnected = out.includes("Browser");
    } catch {}

    res.json({ containerRunning, cdpConnected });
  });
}
