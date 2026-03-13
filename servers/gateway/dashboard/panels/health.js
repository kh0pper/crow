/**
 * Crow's Nest Panel — App launcher tiles, system stats, Docker containers, DB metrics
 */

import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { escapeHtml, statCard, statGrid, section, badge } from "../shared/components.js";
import { CROW_HERO_SVG } from "../shared/crow-hero.js";
import { getAddonLogo } from "../shared/logos.js";

// Cache for Docker status checks (bundle-id -> { status, timestamp })
const _dockerStatusCache = new Map();
const DOCKER_CACHE_TTL = 30_000; // 30 seconds

function getBundleDockerStatus(bundleId) {
  const cached = _dockerStatusCache.get(bundleId);
  if (cached && Date.now() - cached.timestamp < DOCKER_CACHE_TTL) {
    return cached.status;
  }
  let status = null;
  try {
    const out = execFileSync("docker", ["ps", "--filter", `name=${bundleId}`, "--format", "{{.Status}}"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    status = out || null;
  } catch {
    // Docker not available or command failed
  }
  _dockerStatusCache.set(bundleId, { status, timestamp: Date.now() });
  return status;
}

export default {
  id: "health",
  name: "Crow's Nest",
  icon: "health",
  route: "/dashboard/health",
  navOrder: 5,

  async handler(req, res, { db, layout }) {
    // --- CPU usage (average across cores, sampled over ~100ms) ---
    const cpus1 = os.cpus();
    await new Promise((r) => setTimeout(r, 100));
    const cpus2 = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (let i = 0; i < cpus2.length; i++) {
      const c1 = cpus1[i].times;
      const c2 = cpus2[i].times;
      const idle = c2.idle - c1.idle;
      const total =
        c2.user - c1.user +
        c2.nice - c1.nice +
        c2.sys - c1.sys +
        c2.idle - c1.idle +
        c2.irq - c1.irq;
      totalIdle += idle;
      totalTick += total;
    }
    const cpuPercent = totalTick > 0 ? Math.round((1 - totalIdle / totalTick) * 100) : 0;

    // --- RAM ---
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramPercent = Math.round((usedMem / totalMem) * 100);

    // --- Disk ---
    let diskUsed = "?";
    let diskTotal = "?";
    let diskPercent = 0;
    try {
      const dfOut = execFileSync("df", ["-B1", "--output=size,used,pcent", "/"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const lines = dfOut.trim().split("\n");
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        const totalBytes = parseInt(parts[0], 10);
        const usedBytes = parseInt(parts[1], 10);
        diskPercent = parseInt(parts[2], 10) || 0;
        diskTotal = formatSize(totalBytes);
        diskUsed = formatSize(usedBytes);
      }
    } catch {
      // df not available or failed
    }

    // --- Uptime ---
    const uptimeSec = os.uptime();
    const uptimeStr = formatUptime(uptimeSec);

    // --- Docker containers ---
    let containerCount = 0;
    let containerRunning = 0;
    let containerStopped = 0;
    let dockerAvailable = true;
    try {
      const psOut = execFileSync("docker", ["ps", "--format", "json", "--all"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const jsonLines = psOut.trim().split("\n").filter((l) => l.trim());
      containerCount = jsonLines.length;
      for (const line of jsonLines) {
        try {
          const c = JSON.parse(line);
          if (c.State === "running") {
            containerRunning++;
          } else {
            containerStopped++;
          }
        } catch {
          // skip malformed line
        }
      }
    } catch {
      dockerAvailable = false;
    }

    // --- Memory entries from DB ---
    let memoryCount = 0;
    try {
      const result = await db.execute("SELECT COUNT(*) as c FROM memories");
      memoryCount = result.rows[0]?.c || 0;
    } catch {
      // DB not available
    }

    // --- Color-coded indicators ---
    const cpuColor = colorForPercent(cpuPercent);
    const ramColor = colorForPercent(ramPercent);
    const diskColor = colorForPercent(diskPercent);

    // --- Build stat cards ---
    const systemStats = statGrid([
      statCard("CPU", `${cpuPercent}%`, { delay: 0 }),
      statCard("RAM", `${ramPercent}%`, { delay: 50 }),
      statCard("Disk", `${diskPercent}%`, { delay: 100 }),
      statCard("Uptime", uptimeStr, { delay: 150 }),
    ]);

    // --- System details section ---
    const systemDetailsHtml = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div>
          <div style="font-size:0.8rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.35rem">CPU Usage</div>
          ${progressBar(cpuPercent, cpuColor)}
          <div style="font-size:0.85rem;margin-top:0.25rem">${cpuPercent}% across ${os.cpus().length} cores</div>
        </div>
        <div>
          <div style="font-size:0.8rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.35rem">Memory</div>
          ${progressBar(ramPercent, ramColor)}
          <div style="font-size:0.85rem;margin-top:0.25rem">${formatSize(usedMem)} / ${formatSize(totalMem)}</div>
        </div>
        <div>
          <div style="font-size:0.8rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.35rem">Disk</div>
          ${progressBar(diskPercent, diskColor)}
          <div style="font-size:0.85rem;margin-top:0.25rem">${escapeHtml(diskUsed)} / ${escapeHtml(diskTotal)}</div>
        </div>
        <div>
          <div style="font-size:0.8rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.35rem">System Uptime</div>
          <div style="font-size:1.1rem;font-family:'JetBrains Mono',monospace;margin-top:0.5rem">${escapeHtml(uptimeStr)}</div>
        </div>
      </div>`;

    // --- Docker section ---
    let dockerHtml;
    if (!dockerAvailable) {
      dockerHtml = `<p style="color:var(--crow-text-muted)">Docker is not available or not running.</p>`;
    } else {
      const statusBadge = containerStopped > 0
        ? badge(`${containerRunning} running, ${containerStopped} stopped`, containerRunning > 0 ? "published" : "error")
        : badge(`${containerRunning} running`, "connected");
      dockerHtml = `
        <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
          <div style="font-size:1.8rem;font-family:'Fraunces',serif">${containerCount}</div>
          <div>
            <div style="font-size:0.85rem;color:var(--crow-text-muted)">containers total</div>
            <div style="margin-top:0.25rem">${statusBadge}</div>
          </div>
        </div>`;
    }

    // --- Database section ---
    const dbHtml = `
      <div style="display:flex;align-items:center;gap:1rem">
        <div style="font-size:1.8rem;font-family:'Fraunces',serif">${escapeHtml(String(memoryCount))}</div>
        <div style="font-size:0.85rem;color:var(--crow-text-muted)">memory entries stored</div>
      </div>`;

    // --- Auto-refresh hint ---
    const refreshHint = `<p style="color:var(--crow-text-muted);font-size:0.8rem;text-align:center;margin-top:1rem">Reload the page to refresh stats.</p>`;

    const heroHtml = `<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
      <div style="width:80px;height:80px;flex-shrink:0">${CROW_HERO_SVG}</div>
      <div>
        <div style="font-family:'Fraunces',serif;font-size:1.25rem;font-weight:600;color:var(--crow-text-primary)">Welcome to the Crow's Nest</div>
        <div style="color:var(--crow-text-muted);font-size:0.9rem">System health at a glance</div>
      </div>
    </div>`;

    // --- Launcher tiles for installed apps ---
    let launcherHtml = "";
    const installedPath = join(homedir(), ".crow", "installed.json");
    if (existsSync(installedPath)) {
      try {
        let installed = JSON.parse(readFileSync(installedPath, "utf-8"));
        // Normalize array format to object (bundles.js writes arrays)
        if (Array.isArray(installed)) {
          const obj = {};
          for (const item of installed) if (item.id) obj[item.id] = item;
          installed = obj;
        }
        const appEntries = Object.entries(installed).filter(
          ([, meta]) => meta.type === "bundle" || meta.type === "mcp-server"
        );

        if (appEntries.length > 0) {
          const tiles = appEntries.map(([id, meta]) => {
            // Try to load manifest for name and webUI info
            let name = id;
            let webUI = null;
            const manifestPath = join(import.meta.dirname, "../../../../bundles", id, "manifest.json");
            if (existsSync(manifestPath)) {
              try {
                const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
                name = manifest.name || id;
                webUI = manifest.webUI || null;
              } catch {
                // skip malformed manifest
              }
            }

            // Logo or fallback letter circle
            const logo = getAddonLogo(id, 48);
            const logoHtml = logo || `<div style="width:48px;height:48px;border-radius:50%;background:var(--crow-accent-muted);color:var(--crow-accent);display:flex;align-items:center;justify-content:center;font-family:'Fraunces',serif;font-size:1.25rem;font-weight:600">${escapeHtml(name.charAt(0).toUpperCase())}</div>`;

            // Docker status for bundles
            let isRunning = false;
            if (meta.type === "bundle") {
              const status = getBundleDockerStatus(id);
              isRunning = status !== null && status.toLowerCase().startsWith("up");
            }
            const statusDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${isRunning ? "var(--crow-success)" : "var(--crow-text-muted)"};margin-left:0.35rem;vertical-align:middle" title="${isRunning ? "Running" : "Stopped"}"></span>`;

            // Open link if webUI is set
            const openLink = webUI
              ? `<a href="http://localhost:${webUI.port}${webUI.path || "/"}" target="_blank" class="btn btn-sm btn-secondary" style="margin-top:0.5rem;font-size:0.75rem">Open</a>`
              : "";

            return `<div class="card app-tile" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:1.25rem 0.75rem;cursor:default">
              ${logoHtml}
              <div style="margin-top:0.5rem;font-size:0.85rem;font-weight:500">${escapeHtml(name)}${statusDot}</div>
              ${openLink}
            </div>`;
          }).join("\n");

          launcherHtml = section("Your Apps", `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:1rem">
              ${tiles}
            </div>
            <style>.app-tile:hover{transform:translateY(-2px);border-color:var(--crow-accent) !important;transition:transform 0.15s,border-color 0.15s}</style>
          `, { delay: 175 });
        }
      } catch {
        // installed.json malformed — skip launcher
      }
    }

    const content = `
      ${heroHtml}
      ${systemStats}
      ${launcherHtml}
      ${section("System Resources", systemDetailsHtml, { delay: 200 })}
      ${section("Docker", dockerHtml, { delay: 250 })}
      ${section("Database", dbHtml, { delay: 300 })}
      ${refreshHint}
    `;

    return layout({ title: "Crow's Nest", content });
  },
};

// --- Helpers ---

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i] || "TB"}`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function colorForPercent(pct) {
  if (pct >= 90) return "#e74c3c";
  if (pct >= 70) return "#f39c12";
  return "linear-gradient(90deg, #10b981, #22c55e)";
}

function progressBar(percent, color) {
  return `<div style="background:var(--crow-border);border-radius:4px;height:8px;overflow:hidden">
    <div style="width:${Math.min(percent, 100)}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s"></div>
  </div>`;
}
