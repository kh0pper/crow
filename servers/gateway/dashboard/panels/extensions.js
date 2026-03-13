/**
 * Extensions Panel — Browse, install, and manage add-ons
 *
 * Security note: All dynamic content is server-side escaped via escapeHtml().
 * Client-side modal content uses DOM manipulation with textContent for user data.
 * The Crow's Nest is auth-protected and only accessible on local/Tailscale networks.
 */

import { escapeHtml, statCard, statGrid, section, badge, formatDate } from "../shared/components.js";
import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const REGISTRY_URL = "https://raw.githubusercontent.com/kh0pper/crow-addons/main/registry.json";
const CROW_DIR = join(homedir(), ".crow");
const INSTALLED_PATH = join(CROW_DIR, "installed.json");

// Local fallback registry path
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_REGISTRY = join(__dirname, "../../../../registry/add-ons.json");

const ICON_MAP = {
  brain: "\u{1F9E0}",
  cloud: "\u2601\uFE0F",
  image: "\u{1F5BC}\uFE0F",
  book: "\u{1F4D6}",
  home: "\u{1F3E0}",
  archive: "\u{1F4E6}",
  mic: "\u{1F3A4}",
};

function getInstalled() {
  try {
    if (existsSync(INSTALLED_PATH)) {
      const data = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
      if (Array.isArray(data)) {
        const obj = {};
        for (const item of data) obj[item.id] = item;
        return obj;
      }
      return data;
    }
  } catch {}
  return {};
}

function formatResources(requires) {
  if (!requires) return "";
  const parts = [];
  if (requires.min_ram_mb) {
    const ram = requires.min_ram_mb >= 1024
      ? `${(requires.min_ram_mb / 1024).toFixed(0)}GB`
      : `${requires.min_ram_mb}MB`;
    parts.push(`${ram} RAM`);
  }
  if (requires.min_disk_mb) {
    const disk = requires.min_disk_mb >= 1024
      ? `${(requires.min_disk_mb / 1024).toFixed(0)}GB`
      : `${requires.min_disk_mb}MB`;
    parts.push(`${disk} disk`);
  }
  return parts.length > 0
    ? `<span style="font-size:0.75rem;color:var(--crow-text-muted)">${parts.join(" · ")}</span>`
    : "";
}

export default {
  id: "extensions",
  name: "Extensions",
  icon: "extensions",
  route: "/dashboard/extensions",
  navOrder: 80,

  async handler(req, res, { db, layout }) {
    const installed = getInstalled();
    const installedCount = Object.keys(installed).length;

    // Try remote registry, fall back to local
    let registry = { "add-ons": [] };
    let registrySource = "none";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        registry = await resp.json();
        registrySource = "remote";
      }
    } catch {
      // Remote unavailable — try local fallback
    }

    if (registrySource === "none") {
      try {
        if (existsSync(LOCAL_REGISTRY)) {
          registry = JSON.parse(readFileSync(LOCAL_REGISTRY, "utf8"));
          registrySource = "local";
        }
      } catch {}
    }

    const available = registry["add-ons"] || [];

    // Detect docker compose command variant
    let composeCmd = null;
    try {
      execFileSync("docker", ["compose", "version"], { timeout: 3000 });
      composeCmd = { cmd: "docker", prefix: ["compose"] };
    } catch {
      try {
        execFileSync("python3", ["-m", "compose", "version"], { timeout: 3000 });
        composeCmd = { cmd: "python3", prefix: ["-m", "compose"] };
      } catch {
        try {
          execFileSync("docker-compose", ["version"], { timeout: 3000 });
          composeCmd = { cmd: "docker-compose", prefix: [] };
        } catch {}
      }
    }

    // Fetch live container status for installed Docker bundles
    let bundleStatus = {};
    if (composeCmd) {
      try {
        const bundlesDir = join(CROW_DIR, "bundles");
        for (const [id] of Object.entries(installed)) {
          const composePath = join(bundlesDir, id, "docker-compose.yml");
          if (existsSync(composePath)) {
            try {
              const out = execFileSync(composeCmd.cmd, [...composeCmd.prefix, "ps", "--format", "json"], {
                cwd: join(bundlesDir, id),
                timeout: 5000,
              }).toString().trim();
              const containers = out.split("\n").filter(Boolean).map((line) => {
                try { return JSON.parse(line); } catch { return null; }
              }).filter(Boolean);
              bundleStatus[id] = {
                running: containers.some((c) => c.State === "running"),
                containers: containers.length,
              };
            } catch {
              bundleStatus[id] = { running: false, containers: 0 };
            }
          }
        }
      } catch {}
    }

    const runningCount = Object.values(bundleStatus).filter((s) => s.running).length;

    const stats = statGrid([
      statCard("Installed", installedCount, { delay: 0 }),
      statCard("Running", runningCount, { delay: 50 }),
      statCard("Available", available.length, { delay: 100 }),
    ]);

    // Installed add-ons with action buttons
    let installedHtml;
    if (installedCount === 0) {
      installedHtml = `<div class="empty-state"><h3>No add-ons installed</h3><p>Browse available add-ons below to get started.</p></div>`;
    } else {
      const cards = Object.entries(installed).map(([id, info], i) => {
        const registryEntry = available.find((a) => a.id === id);
        const name = registryEntry?.name || id;
        const icon = ICON_MAP[registryEntry?.icon] || "";
        const status = bundleStatus[id];
        const isDocker = !!status;
        const isRunning = status?.running;

        const statusBadge = isDocker
          ? (isRunning ? badge("Running", "published") : badge("Stopped", "draft"))
          : badge("MCP Server", "connected");

        // Action buttons using data attributes (no inline event handlers with dynamic data)
        let actions = "";
        if (isDocker) {
          if (isRunning) {
            actions = `
              <button class="btn btn-sm btn-secondary bundle-action" data-action="stop" data-id="${escapeHtml(id)}">Stop</button>
              <button class="btn btn-sm btn-secondary bundle-action" data-action="start" data-id="${escapeHtml(id)}" title="Restart">Restart</button>`;
          } else {
            actions = `<button class="btn btn-sm btn-primary bundle-action" data-action="start" data-id="${escapeHtml(id)}">Start</button>`;
          }
        }
        actions += `<button class="btn btn-sm bundle-uninstall" style="color:var(--crow-text-muted);border-color:var(--crow-border)" data-id="${escapeHtml(id)}" data-name="${escapeHtml(name)}" data-docker="${isDocker}">Remove</button>`;

        return `<div class="card" style="animation-delay:${i * 50}ms;margin-bottom:0.75rem">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <div>
              <h4 style="font-family:'Fraunces',serif;font-size:1rem;margin-bottom:0.25rem">${icon ? icon + " " : ""}${escapeHtml(name)}</h4>
              <div style="font-size:0.8rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace">
                ${statusBadge} v${escapeHtml(info.version || registryEntry?.version || "?")} · installed ${formatDate(info.installed_at || info.installedAt)}
              </div>
            </div>
            <div style="display:flex;gap:0.5rem;align-items:center">
              ${actions}
            </div>
          </div>
          <div id="status-${escapeHtml(id)}" style="font-size:0.8rem;margin-top:0.5rem;display:none"></div>
        </div>`;
      }).join("");
      installedHtml = cards;
    }

    // Available add-ons with install buttons
    let availableHtml;
    if (available.length === 0) {
      availableHtml = `<div class="empty-state"><h3>Registry unavailable</h3><p>Could not reach the add-on registry. Check your internet connection.</p></div>`;
    } else {
      const cards = available.map((addon, i) => {
        const isInstalled = installed[addon.id];
        const typeBadge = badge(addon.type, "connected");
        const icon = ICON_MAP[addon.icon] || "";
        const tags = (addon.tags || []).slice(0, 4).map((t) =>
          `<span style="font-size:0.7rem;color:var(--crow-accent);background:var(--crow-accent-muted);padding:0.1rem 0.4rem;border-radius:4px;margin-right:0.25rem">${escapeHtml(t)}</span>`
        ).join("");
        const resources = formatResources(addon.requires);
        const envCount = (addon.env_vars || addon.requires?.env || []).length;
        const envNote = envCount > 0
          ? `<span style="font-size:0.75rem;color:var(--crow-text-muted)">${envCount} env var${envCount > 1 ? "s" : ""}</span>`
          : "";
        const notes = addon.notes
          ? `<div style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.4rem;font-style:italic">${escapeHtml(addon.notes)}</div>`
          : "";

        // Install button or "Installed" badge — env_vars stored as data attribute
        let installButton;
        if (isInstalled) {
          installButton = badge("Installed", "published");
        } else {
          const envVarsAttr = escapeHtml(JSON.stringify(addon.env_vars || []));
          const minRam = addon.requires?.min_ram_mb || 0;
          const minDisk = addon.requires?.min_disk_mb || 0;
          installButton = `<button class="btn btn-sm btn-primary bundle-install" data-id="${escapeHtml(addon.id)}" data-name="${escapeHtml(addon.name)}" data-envvars="${envVarsAttr}" data-minram="${minRam}" data-mindisk="${minDisk}">Install</button>`;
        }

        return `<div class="card" style="animation-delay:${(i + installedCount) * 50}ms">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem">
            <h4 style="font-family:'Fraunces',serif;font-size:1rem">${icon ? icon + " " : ""}${escapeHtml(addon.name)}</h4>
            <div style="display:flex;gap:0.25rem;align-items:center">${installButton} ${typeBadge}</div>
          </div>
          <p style="color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:0.5rem">${escapeHtml(addon.description)}</p>
          <div style="display:flex;flex-wrap:wrap;gap:0.25rem;margin-bottom:0.4rem">${tags}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem">
            <div style="display:flex;gap:0.75rem;align-items:center">
              ${resources}
              ${envNote}
            </div>
            <div style="font-size:0.75rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace">
              v${escapeHtml(addon.version || "1.0.0")} · ${escapeHtml(addon.author || "community")}
            </div>
          </div>
          ${notes}
        </div>`;
      }).join("");
      availableHtml = `<div class="card-grid">${cards}</div>`;
    }

    const sourceNote = registrySource === "local"
      ? `<div style="font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:0.5rem">Showing local registry (remote unavailable)</div>`
      : "";

    // Modal container and client-side JavaScript
    // Uses data attributes and DOM APIs (textContent) instead of innerHTML with user data
    const interactiveScript = `
    <div id="modal-overlay" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center">
      <div id="modal-content" style="background:var(--crow-bg-card, #1d1d1f);border:1px solid var(--crow-border);border-radius:8px;padding:1.5rem;max-width:500px;width:90%;max-height:80vh;overflow-y:auto">
      </div>
    </div>

    <script>
      (function() {
        var API = "/dashboard/bundles/api";

        // --- Modal helpers ---
        function showModal() { document.getElementById("modal-overlay").style.display = "flex"; }
        function hideModal() { document.getElementById("modal-overlay").style.display = "none"; }
        document.getElementById("modal-overlay").addEventListener("click", function(e) {
          if (e.target === this) hideModal();
        });

        function setModalContent(el) {
          var mc = document.getElementById("modal-content");
          mc.replaceChildren();
          mc.appendChild(el);
        }

        function showStatus(id, msg, type) {
          var el = document.getElementById("status-" + id);
          if (el) {
            el.style.display = "block";
            el.style.color = type === "error" ? "var(--crow-error, #e74c3c)" : "var(--crow-accent)";
            el.textContent = msg;
          }
        }

        function apiCall(endpoint, body) {
          return fetch(API + "/" + endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); });
        }

        // --- Bundle start/stop ---
        document.querySelectorAll(".bundle-action").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var action = this.dataset.action;
            var id = this.dataset.id;
            showStatus(id, action === "start" ? "Starting..." : "Stopping...", "info");
            apiCall(action, { bundle_id: id }).then(function(res) {
              if (res.ok) {
                showStatus(id, res.data.message || "Done", "info");
                setTimeout(function() { location.reload(); }, 1500);
              } else {
                showStatus(id, res.data.error || "Failed", "error");
              }
            }).catch(function(err) {
              showStatus(id, "Network error", "error");
            });
          });
        });

        // --- Install modal ---
        document.querySelectorAll(".bundle-install").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var id = this.dataset.id;
            var name = this.dataset.name;
            var envVars = JSON.parse(this.dataset.envvars || "[]");
            var minRam = parseInt(this.dataset.minram || "0", 10);
            var minDisk = parseInt(this.dataset.mindisk || "0", 10);

            var frag = document.createElement("div");

            var h3 = document.createElement("h3");
            h3.style.cssText = "font-family:Fraunces,serif;margin-bottom:0.75rem";
            h3.textContent = "Install " + name;
            frag.appendChild(h3);

            var desc = document.createElement("p");
            desc.style.cssText = "color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:1rem";
            desc.textContent = "This will download and configure the add-on. You can update settings later.";
            frag.appendChild(desc);

            // Resource warning (check server health)
            if (minRam > 0 || minDisk > 0) {
              var warnDiv = document.createElement("div");
              warnDiv.id = "resource-warning";
              warnDiv.style.cssText = "font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.75rem";
              warnDiv.textContent = "Checking system resources...";
              frag.appendChild(warnDiv);
              fetch(API + "/status").then(function(r) { return r.json(); }).catch(function() { return null; }).then(function() {
                // Use /dashboard/health API for resource data
                fetch("/api/health").then(function(r) { return r.json(); }).then(function(h) {
                  var warnings = [];
                  if (minRam > 0 && h && h.ram_free_mb && h.ram_free_mb < minRam) {
                    warnings.push("This add-on needs ~" + minRam + "MB RAM. Your server has " + h.ram_free_mb + "MB free.");
                  }
                  if (minDisk > 0 && h && h.disk_free_mb && h.disk_free_mb < minDisk) {
                    warnings.push("This add-on needs ~" + minDisk + "MB disk. Your server has " + h.disk_free_mb + "MB free.");
                  }
                  if (warnings.length > 0) {
                    warnDiv.style.cssText = "font-size:0.8rem;color:var(--crow-warning, #f0ad4e);background:rgba(240,173,78,0.1);padding:0.75rem;border-radius:4px;margin-bottom:0.75rem;border:1px solid rgba(240,173,78,0.3)";
                    warnDiv.textContent = warnings.join(" ") + " Installing may cause instability.";
                  } else {
                    warnDiv.style.display = "none";
                  }
                }).catch(function() { warnDiv.style.display = "none"; });
              });
            }

            // Env var fields
            var envNames = [];
            if (envVars.length > 0) {
              var configH = document.createElement("h4");
              configH.style.cssText = "margin:0 0 0.5rem;font-size:0.9rem;color:var(--crow-text-secondary)";
              configH.textContent = "Configuration";
              frag.appendChild(configH);

              envVars.forEach(function(ev) {
                envNames.push(ev.name);
                var wrap = document.createElement("div");
                wrap.style.marginBottom = "0.75rem";

                var label = document.createElement("label");
                label.style.cssText = "display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem;text-transform:uppercase;letter-spacing:0.05em";
                label.textContent = ev.name + (ev.required ? " *" : "");
                wrap.appendChild(label);

                var input = document.createElement("input");
                input.type = ev.secret ? "password" : "text";
                input.id = "env_" + ev.name;
                input.value = ev.default || "";
                input.placeholder = ev.description || "";
                input.style.cssText = "width:100%;padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-family:JetBrains Mono,monospace;font-size:0.85rem;box-sizing:border-box";
                wrap.appendChild(input);

                var hint = document.createElement("div");
                hint.style.cssText = "font-size:0.7rem;color:var(--crow-text-muted);margin-top:0.2rem";
                hint.textContent = ev.description || "";
                wrap.appendChild(hint);

                frag.appendChild(wrap);
              });
            }

            var statusDiv = document.createElement("div");
            statusDiv.id = "install-status";
            statusDiv.style.cssText = "font-size:0.85rem;margin:0.75rem 0;display:none";
            frag.appendChild(statusDiv);

            var btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem";

            var cancelBtn = document.createElement("button");
            cancelBtn.className = "btn btn-secondary";
            cancelBtn.textContent = "Cancel";
            cancelBtn.addEventListener("click", hideModal);
            btnRow.appendChild(cancelBtn);

            var installBtn = document.createElement("button");
            installBtn.className = "btn btn-primary";
            installBtn.textContent = "Install";
            installBtn.addEventListener("click", function() {
              installBtn.disabled = true;
              installBtn.textContent = "Installing...";
              statusDiv.style.display = "block";
              statusDiv.style.color = "var(--crow-accent)";
              statusDiv.textContent = "Copying files and pulling images...";

              var envData = {};
              envNames.forEach(function(n) {
                var inp = document.getElementById("env_" + n);
                if (inp && inp.value) envData[n] = inp.value;
              });

              apiCall("install", { bundle_id: id, env_vars: envData }).then(function(res) {
                if (res.ok && res.data.job_id) {
                  pollJob(res.data.job_id, statusDiv, installBtn);
                } else {
                  statusDiv.style.color = "var(--crow-error, #e74c3c)";
                  statusDiv.textContent = res.data.error || "Install failed";
                  installBtn.disabled = false;
                  installBtn.textContent = "Retry";
                }
              }).catch(function() {
                statusDiv.style.color = "var(--crow-error, #e74c3c)";
                statusDiv.textContent = "Network error";
                installBtn.disabled = false;
                installBtn.textContent = "Retry";
              });
            });
            btnRow.appendChild(installBtn);
            frag.appendChild(btnRow);

            setModalContent(frag);
            showModal();
          });
        });

        // --- Uninstall modal ---
        document.querySelectorAll(".bundle-uninstall").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var id = this.dataset.id;
            var name = this.dataset.name;
            var isDocker = this.dataset.docker === "true";

            var frag = document.createElement("div");

            var h3 = document.createElement("h3");
            h3.style.cssText = "font-family:Fraunces,serif;margin-bottom:0.75rem";
            h3.textContent = "Uninstall " + name + "?";
            frag.appendChild(h3);

            var warnBox = document.createElement("div");
            warnBox.style.cssText = "background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.25);border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem";

            var warnTitle = document.createElement("div");
            warnTitle.style.cssText = "font-weight:600;color:var(--crow-error, #e74c3c);margin-bottom:0.35rem;font-size:0.9rem";
            warnTitle.textContent = "This action cannot be undone";
            warnBox.appendChild(warnTitle);

            var warnText = document.createElement("div");
            warnText.style.cssText = "color:var(--crow-text-secondary);font-size:0.85rem;line-height:1.5";
            warnText.textContent = isDocker
              ? "This will stop all " + name + " containers and remove the add-on. The gateway will restart to apply changes."
              : "This will remove " + name + " and its configuration.";
            warnBox.appendChild(warnText);
            frag.appendChild(warnBox);

            var checkId = null;
            if (isDocker) {
              var dataBox = document.createElement("div");
              dataBox.style.cssText = "background:var(--crow-bg-card, #1d1d1f);border:1px solid var(--crow-border);border-radius:6px;padding:0.75rem 1rem;margin-bottom:0.75rem";

              var label = document.createElement("label");
              label.style.cssText = "display:flex;align-items:start;gap:0.5rem;font-size:0.85rem;color:var(--crow-text-secondary);cursor:pointer";
              var check = document.createElement("input");
              check.type = "checkbox";
              check.id = "delete-data-check";
              check.style.cssText = "margin-top:0.2rem;flex-shrink:0";
              checkId = check.id;
              label.appendChild(check);

              var labelWrap = document.createElement("div");
              var labelMain = document.createElement("div");
              labelMain.style.fontWeight = "500";
              labelMain.textContent = "Also delete all stored data";
              labelWrap.appendChild(labelMain);
              var labelHint = document.createElement("div");
              labelHint.style.cssText = "font-size:0.78rem;color:var(--crow-text-muted);margin-top:0.2rem";
              labelHint.textContent = "Permanently removes all files and data stored by this service. Leave unchecked to keep data for a future reinstall.";
              labelWrap.appendChild(labelHint);
              label.appendChild(labelWrap);
              dataBox.appendChild(label);
              frag.appendChild(dataBox);
            }

            var statusDiv = document.createElement("div");
            statusDiv.style.cssText = "font-size:0.85rem;margin:0.75rem 0;display:none";
            frag.appendChild(statusDiv);

            var btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem";

            var cancelBtn = document.createElement("button");
            cancelBtn.className = "btn btn-secondary";
            cancelBtn.textContent = "Cancel";
            cancelBtn.addEventListener("click", hideModal);
            btnRow.appendChild(cancelBtn);

            var removeBtn = document.createElement("button");
            removeBtn.style.cssText = "background:var(--crow-error, #e74c3c);color:white;border:none";
            removeBtn.className = "btn";
            removeBtn.textContent = "Remove";
            removeBtn.addEventListener("click", function() {
              var deleteData = checkId ? document.getElementById(checkId).checked : false;
              removeBtn.disabled = true;
              removeBtn.textContent = "Removing...";
              statusDiv.style.display = "block";
              statusDiv.style.color = "var(--crow-accent)";
              statusDiv.textContent = "Stopping and removing...";

              apiCall("uninstall", { bundle_id: id, delete_data: deleteData }).then(function(res) {
                if (res.ok && res.data.job_id) {
                  pollJob(res.data.job_id, statusDiv, removeBtn);
                } else {
                  statusDiv.style.color = "var(--crow-error, #e74c3c)";
                  statusDiv.textContent = res.data.error || "Removal failed";
                  removeBtn.disabled = false;
                  removeBtn.textContent = "Retry";
                }
              }).catch(function() {
                statusDiv.style.color = "var(--crow-error, #e74c3c)";
                statusDiv.textContent = "Network error";
                removeBtn.disabled = false;
                removeBtn.textContent = "Retry";
              });
            });
            btnRow.appendChild(removeBtn);
            frag.appendChild(btnRow);

            setModalContent(frag);
            showModal();
          });
        });

        // --- Wait for gateway restart ---
        function waitForRestart(statusEl) {
          statusEl.style.color = "var(--crow-accent)";
          statusEl.textContent = "Gateway restarting to apply configuration...";
          setTimeout(function pollRestart() {
            fetch("/health").then(function(r) {
              if (r.ok) location.reload();
              else setTimeout(pollRestart, 2000);
            }).catch(function() { setTimeout(pollRestart, 2000); });
          }, 3000);
        }

        // --- Job polling ---
        function pollJob(jobId, statusEl, btn) {
          fetch(API + "/jobs/" + jobId).then(function(r) { return r.json(); }).then(function(job) {
            statusEl.textContent = job.log[job.log.length - 1] || "Working...";
            if (job.status === "complete") {
              statusEl.style.color = "var(--crow-accent)";
              statusEl.textContent = "Done!";
              setTimeout(function() { location.reload(); }, 1500);
            } else if (job.status === "failed") {
              statusEl.style.color = "var(--crow-error, #e74c3c)";
              statusEl.textContent = "Failed: " + (job.log[job.log.length - 1] || "Unknown error");
              btn.disabled = false;
              btn.textContent = "Retry";
            } else {
              setTimeout(function() { pollJob(jobId, statusEl, btn); }, 1000);
            }
          }).catch(function() {
            // Network error likely means gateway is restarting
            waitForRestart(statusEl);
          });
        }
      })();
    <\/script>`;

    const content = `
      ${stats}
      ${section("Installed", installedHtml, { delay: 100 })}
      ${sourceNote}
      ${section("Available Add-ons", availableHtml, { delay: 150 })}
      <div class="card" style="animation-delay:250ms">
        <p style="color:var(--crow-text-muted);font-size:0.85rem">
          Or ask your AI: <code>"install the [name] add-on"</code><br>
          To create your own, see the <a href="/crow/developers/creating-addons">developer guide</a>.
        </p>
      </div>
      ${interactiveScript}
    `;

    return layout({ title: "Extensions", content });
  },
};
