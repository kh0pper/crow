/**
 * Add-on API Routes — Install, uninstall, start, stop, status
 *
 * Supports all add-on types:
 *   - bundle:     Docker Compose services (pull images, start/stop containers)
 *   - mcp-server: External MCP servers (register in ~/.crow/mcp-addons.json)
 *   - skill:      Markdown skill files (copy to ~/.crow/skills/)
 *   - panel:      Dashboard panels (copy to ~/.crow/panels/, register in panels.json)
 *
 * POST /bundles/api/install   — Install an add-on
 * POST /bundles/api/uninstall — Remove an add-on
 * POST /bundles/api/start     — Start bundle containers (Docker only)
 * POST /bundles/api/stop      — Stop bundle containers (Docker only)
 * GET  /bundles/api/status    — Get status of all installed add-ons
 * POST /bundles/api/env       — Save env vars for an add-on
 * GET  /bundles/api/jobs/:id  — Poll install job progress
 */

import { Router } from "express";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CROW_HOME = process.env.CROW_DATA_DIR || join(homedir(), ".crow");
const BUNDLES_DIR = join(CROW_HOME, "bundles");
const SKILLS_DIR = join(CROW_HOME, "skills");
const PANELS_DIR = join(CROW_HOME, "panels");
const MCP_ADDONS_PATH = join(CROW_HOME, "mcp-addons.json");
const PANELS_CONFIG_PATH = join(CROW_HOME, "panels.json");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");
const APP_BUNDLES = resolve(__dirname, "../../../bundles");

// In-memory job tracking (simple — no DB table needed for MVP)
const jobs = new Map();
let jobCounter = 0;

function createJob(bundleId, action) {
  const id = String(++jobCounter);
  const job = {
    id,
    bundleId,
    action,
    status: "running",
    log: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.set(id, job);
  // Clean up old jobs after 10 minutes
  setTimeout(() => jobs.delete(id), 600_000);
  return job;
}

function appendLog(job, line) {
  job.log.push(line);
}

function finishJob(job, status) {
  job.status = status;
  job.completedAt = new Date().toISOString();
}

/** Read installed.json as array */
function getInstalled() {
  try {
    if (existsSync(INSTALLED_PATH)) {
      const data = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
      return Array.isArray(data) ? data : Object.entries(data).map(([id, v]) => ({ id, ...v }));
    }
  } catch { /* ignore */ }
  return [];
}

/** Write installed.json */
function saveInstalled(arr) {
  mkdirSync(dirname(INSTALLED_PATH), { recursive: true });
  writeFileSync(INSTALLED_PATH, JSON.stringify(arr, null, 2));
}

/** Read manifest.json for a bundle from app source */
function getManifest(bundleId) {
  const manifestPath = join(APP_BUNDLES, bundleId, "manifest.json");
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

/** Run a shell command safely with execFile */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Read JSON file with fallback */
function readJsonSafe(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch { /* ignore */ }
  return fallback;
}

/** Write JSON file (creates parent dirs) */
function writeJsonSafe(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Validate bundle ID format (alphanumeric + hyphens only) */
function isValidBundleId(id) {
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= 64;
}

/**
 * @returns {Router}
 */
export default function bundlesRouter() {
  const router = Router();

  // GET /bundles/api/status — List installed bundles with container status
  router.get("/bundles/api/status", async (req, res) => {
    const installed = getInstalled();
    const results = [];

    for (const entry of installed) {
      const bundleDir = join(BUNDLES_DIR, entry.id);
      const composePath = join(bundleDir, "docker-compose.yml");
      const manifest = getManifest(entry.id);
      const info = { ...entry, name: manifest?.name || entry.id, type: manifest?.type || entry.type || "unknown" };

      if (existsSync(composePath)) {
        try {
          const { stdout } = await run("docker", ["compose", "ps", "--format", "json"], { cwd: bundleDir });
          const containers = stdout.trim().split("\n").filter(Boolean).map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);

          info.containers = containers.map((c) => ({
            name: c.Name || c.Service,
            state: c.State || "unknown",
            status: c.Status || "",
          }));
          info.running = containers.some((c) => c.State === "running");
        } catch {
          info.containers = [];
          info.running = false;
        }
      } else {
        info.containers = null; // MCP server type — no containers
        info.running = null;
      }

      results.push(info);
    }

    res.json({ bundles: results });
  });

  // POST /bundles/api/install — Install a bundle
  router.post("/bundles/api/install", async (req, res) => {
    const { bundle_id, env_vars } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    // Check source exists
    const sourceDir = join(APP_BUNDLES, bundle_id);
    if (!existsSync(sourceDir)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' not found` });
    }

    // Check not already installed
    const installed = getInstalled();
    if (installed.find((i) => i.id === bundle_id)) {
      return res.status(409).json({ error: `Bundle '${bundle_id}' is already installed` });
    }

    // Create job for async tracking
    const job = createJob(bundle_id, "install");
    res.json({ ok: true, job_id: job.id, message: `Installing ${bundle_id}...` });

    // Run install async (don't block the response)
    (async () => {
      try {
        const manifest = getManifest(bundle_id);
        const addonType = manifest?.type || "bundle";

        // 1. Copy bundle files to ~/.crow/bundles/<id>
        const destDir = join(BUNDLES_DIR, bundle_id);
        mkdirSync(destDir, { recursive: true });
        cpSync(sourceDir, destDir, { recursive: true });
        appendLog(job, "Copied bundle files");

        // 2. Write env vars if provided
        if (env_vars && typeof env_vars === "object") {
          const envLines = Object.entries(env_vars)
            .filter(([, v]) => v !== undefined && v !== "")
            .map(([k, v]) => `${k}=${v}`);
          if (envLines.length > 0) {
            writeFileSync(join(destDir, ".env"), envLines.join("\n") + "\n");
            appendLog(job, `Wrote ${envLines.length} env vars`);
          }
        } else if (existsSync(join(destDir, ".env.example")) && !existsSync(join(destDir, ".env"))) {
          cpSync(join(destDir, ".env.example"), join(destDir, ".env"));
          appendLog(job, "Created .env from .env.example");
        }

        // 3. Type-specific install steps
        if (addonType === "bundle") {
          // Docker bundle — pull images
          const composePath = join(destDir, "docker-compose.yml");
          if (existsSync(composePath)) {
            appendLog(job, "Pulling Docker images...");
            try {
              await run("docker", ["compose", "pull"], { cwd: destDir });
              appendLog(job, "Docker images pulled");
            } catch (err) {
              appendLog(job, `Warning: docker compose pull failed: ${err.message}`);
            }
          }
        } else if (addonType === "mcp-server") {
          // MCP server — register in mcp-addons.json
          if (manifest?.server) {
            const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
            const env = {};
            if (manifest.server.envKeys && env_vars) {
              for (const key of manifest.server.envKeys) {
                if (env_vars[key]) env[key] = env_vars[key];
              }
            }
            mcpAddons[bundle_id] = {
              command: manifest.server.command,
              args: manifest.server.args || [],
              ...(Object.keys(env).length > 0 ? { env } : {}),
            };
            writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
            appendLog(job, `Registered MCP server '${bundle_id}'`);
          }
        } else if (addonType === "skill") {
          // Skill — copy skill files to ~/.crow/skills/
          mkdirSync(SKILLS_DIR, { recursive: true });
          if (manifest?.skills) {
            for (const skillPath of manifest.skills) {
              const src = join(destDir, skillPath);
              const dest = join(SKILLS_DIR, skillPath.split("/").pop());
              if (existsSync(src)) {
                cpSync(src, dest);
                appendLog(job, `Installed skill: ${skillPath.split("/").pop()}`);
              }
            }
          }
        } else if (addonType === "panel") {
          // Panel — copy panel file to ~/.crow/panels/ and register
          mkdirSync(PANELS_DIR, { recursive: true });
          if (manifest?.panel) {
            const src = join(destDir, manifest.panel);
            const dest = join(PANELS_DIR, manifest.panel.split("/").pop());
            if (existsSync(src)) {
              cpSync(src, dest);
              const panelsCfg = readJsonSafe(PANELS_CONFIG_PATH, []);
              if (!panelsCfg.includes(bundle_id)) {
                panelsCfg.push(bundle_id);
                writeJsonSafe(PANELS_CONFIG_PATH, panelsCfg);
              }
              appendLog(job, `Installed panel: ${manifest.panel.split("/").pop()}`);
            }
          }
        }

        // 4. Copy any associated skills (bundles and mcp-servers can have skills too)
        if (addonType !== "skill" && manifest?.skills) {
          mkdirSync(SKILLS_DIR, { recursive: true });
          for (const skillPath of manifest.skills) {
            const src = join(destDir, skillPath);
            const dest = join(SKILLS_DIR, skillPath.split("/").pop());
            if (existsSync(src)) {
              cpSync(src, dest);
              appendLog(job, `Installed skill: ${skillPath.split("/").pop()}`);
            }
          }
        }

        // 5. Track installation
        installed.push({
          id: bundle_id,
          type: addonType,
          version: manifest?.version || "1.0.0",
          installedAt: new Date().toISOString(),
        });
        saveInstalled(installed);
        appendLog(job, "Installation tracked");

        finishJob(job, "complete");
      } catch (err) {
        appendLog(job, `Error: ${err.message}`);
        finishJob(job, "failed");
      }
    })();
  });

  // POST /bundles/api/uninstall — Remove a bundle
  router.post("/bundles/api/uninstall", async (req, res) => {
    const { bundle_id, delete_data } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    if (!existsSync(bundleDir)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' is not installed` });
    }

    const job = createJob(bundle_id, "uninstall");
    res.json({ ok: true, job_id: job.id, message: `Removing ${bundle_id}...` });

    (async () => {
      try {
        const manifest = getManifest(bundle_id);
        const addonType = manifest?.type || "bundle";

        // 1. Type-specific cleanup
        if (addonType === "bundle") {
          const composePath = join(bundleDir, "docker-compose.yml");
          if (existsSync(composePath)) {
            appendLog(job, "Stopping containers...");
            const downArgs = ["compose", "down", "--remove-orphans"];
            if (delete_data) downArgs.push("-v");
            try {
              await run("docker", downArgs, { cwd: bundleDir });
              appendLog(job, delete_data ? "Containers stopped, volumes removed" : "Containers stopped (data preserved)");
            } catch (err) {
              appendLog(job, `Warning: docker compose down: ${err.message}`);
            }
          }
        } else if (addonType === "mcp-server") {
          // Remove from mcp-addons.json
          const mcpAddons = readJsonSafe(MCP_ADDONS_PATH, {});
          if (mcpAddons[bundle_id]) {
            delete mcpAddons[bundle_id];
            writeJsonSafe(MCP_ADDONS_PATH, mcpAddons);
            appendLog(job, "Removed MCP server registration");
          }
        } else if (addonType === "panel") {
          // Remove from panels.json and delete panel file
          const panelsCfg = readJsonSafe(PANELS_CONFIG_PATH, []);
          const idx = panelsCfg.indexOf(bundle_id);
          if (idx !== -1) {
            panelsCfg.splice(idx, 1);
            writeJsonSafe(PANELS_CONFIG_PATH, panelsCfg);
          }
          if (manifest?.panel) {
            const panelFile = join(PANELS_DIR, manifest.panel.split("/").pop());
            if (existsSync(panelFile)) rmSync(panelFile);
            appendLog(job, "Removed panel file and registration");
          }
        }

        // 2. Remove associated skills (all types can have skills)
        if (manifest?.skills) {
          for (const skillPath of manifest.skills) {
            const skillFile = join(SKILLS_DIR, skillPath.split("/").pop());
            if (existsSync(skillFile)) {
              rmSync(skillFile);
              appendLog(job, `Removed skill: ${skillPath.split("/").pop()}`);
            }
          }
        }

        // 3. Remove bundle files
        rmSync(bundleDir, { recursive: true, force: true });
        appendLog(job, "Bundle files removed");

        // 4. Update installed.json
        const installed = getInstalled().filter((i) => i.id !== bundle_id);
        saveInstalled(installed);
        appendLog(job, "Installation record removed");

        finishJob(job, "complete");
      } catch (err) {
        appendLog(job, `Error: ${err.message}`);
        finishJob(job, "failed");
      }
    })();
  });

  // POST /bundles/api/start — Start bundle containers
  router.post("/bundles/api/start", async (req, res) => {
    const { bundle_id } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    const composePath = join(bundleDir, "docker-compose.yml");
    if (!existsSync(composePath)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' has no Docker containers` });
    }

    try {
      await run("docker", ["compose", "up", "-d"], { cwd: bundleDir });
      res.json({ ok: true, message: `Bundle '${bundle_id}' started` });
    } catch (err) {
      res.status(500).json({ error: `Failed to start: ${err.stderr || err.message}` });
    }
  });

  // POST /bundles/api/stop — Stop bundle containers
  router.post("/bundles/api/stop", async (req, res) => {
    const { bundle_id } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    const composePath = join(bundleDir, "docker-compose.yml");
    if (!existsSync(composePath)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' has no Docker containers` });
    }

    try {
      await run("docker", ["compose", "stop"], { cwd: bundleDir });
      res.json({ ok: true, message: `Bundle '${bundle_id}' stopped` });
    } catch (err) {
      res.status(500).json({ error: `Failed to stop: ${err.stderr || err.message}` });
    }
  });

  // POST /bundles/api/env — Save env vars for an installed bundle
  router.post("/bundles/api/env", (req, res) => {
    const { bundle_id, env_vars } = req.body;

    if (!bundle_id || !isValidBundleId(bundle_id)) {
      return res.status(400).json({ error: "Invalid bundle ID" });
    }

    const bundleDir = join(BUNDLES_DIR, bundle_id);
    if (!existsSync(bundleDir)) {
      return res.status(404).json({ error: `Bundle '${bundle_id}' is not installed` });
    }

    if (!env_vars || typeof env_vars !== "object") {
      return res.status(400).json({ error: "env_vars must be an object" });
    }

    // Read existing .env, merge with new values
    const envPath = join(bundleDir, ".env");
    const existing = {};
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match) existing[match[1]] = match[2];
      }
    }

    Object.assign(existing, env_vars);
    const envContent = Object.entries(existing)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    writeFileSync(envPath, envContent);

    res.json({ ok: true, message: "Environment variables saved" });
  });

  // GET /bundles/api/jobs/:id — Poll job progress
  router.get("/bundles/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  return router;
}
