/**
 * Crow Browser — Dashboard Panel
 *
 * Shows container status, VNC viewer embed, saved sessions, and scraping jobs.
 */

import { execFileSync } from "child_process";

export default function browserPanel(api) {
  return {
    id: "browser",
    title: "Browser",
    icon: "globe",

    async render() {
      try {
        // Check container status
        let containerRunning = false;
        let containerInfo = null;
        try {
          const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}|{{.State.StartedAt}}", "crow-browser"], { encoding: "utf-8", timeout: 5000 }).trim();
          const [running, startedAt] = out.split("|");
          containerRunning = running === "true";
          containerInfo = { running: containerRunning, startedAt };
        } catch {
          containerInfo = { running: false, error: "Container not found" };
        }

        // Check CDP connectivity
        let cdpConnected = false;
        try {
          const resp = execFileSync("curl", ["-s", "-m", "2", "http://127.0.0.1:9222/json/version"], { encoding: "utf-8", timeout: 5000 });
          if (resp.includes("Browser")) cdpConnected = true;
        } catch {}

        // Load saved sessions
        let sessions = [];
        try {
          const { readdirSync, statSync } = await import("fs");
          const { join } = await import("path");
          const { homedir } = await import("os");
          const sessDir = join(homedir(), ".crow", "browser-sessions");
          if ((await import("fs")).existsSync(sessDir)) {
            sessions = readdirSync(sessDir)
              .filter(f => f.endsWith(".json"))
              .map(f => {
                const st = statSync(join(sessDir, f));
                return { name: f.replace(".json", ""), modified: st.mtime.toISOString() };
              })
              .sort((a, b) => b.modified.localeCompare(a.modified))
              .slice(0, 10);
          }
        } catch {}

        // Status section
        const statusBadge = containerRunning
          ? '<span class="badge badge-success">Running</span>'
          : '<span class="badge badge-danger">Stopped</span>';

        const cdpBadge = cdpConnected
          ? '<span class="badge badge-success">Connected</span>'
          : '<span class="badge badge-warning">Not connected</span>';

        const statusHtml = `
          <div style="display: flex; gap: 2rem; margin-bottom: 1rem; flex-wrap: wrap;">
            <div>
              <strong>Container:</strong> ${statusBadge}
              ${containerInfo?.startedAt ? `<span class="muted" style="margin-left: 0.5rem;">since ${containerInfo.startedAt.substring(0, 19)}</span>` : ""}
            </div>
            <div><strong>CDP:</strong> ${cdpBadge}</div>
            ${containerRunning ? `<div><a href="http://localhost:6080/vnc.html" target="_blank" class="btn btn-sm">Open VNC Viewer</a></div>` : ""}
          </div>
        `;

        // Container controls
        const controlsHtml = `
          <div style="margin-bottom: 1rem; display: flex; gap: 0.5rem;">
            <form method="POST" action="/dashboard/browser/control" style="display:inline">
              <input type="hidden" name="action" value="start">
              <button type="submit" class="btn btn-sm btn-primary" ${containerRunning ? "disabled" : ""}>Start</button>
            </form>
            <form method="POST" action="/dashboard/browser/control" style="display:inline">
              <input type="hidden" name="action" value="stop">
              <button type="submit" class="btn btn-sm btn-danger" ${!containerRunning ? "disabled" : ""}>Stop</button>
            </form>
            <form method="POST" action="/dashboard/browser/control" style="display:inline">
              <input type="hidden" name="action" value="restart">
              <button type="submit" class="btn btn-sm">Restart</button>
            </form>
          </div>
        `;

        // VNC embed (only if running)
        const vncHtml = containerRunning ? `
          <div style="margin-bottom: 1rem;">
            <h4>Live View</h4>
            <iframe src="http://localhost:6080/vnc.html?autoconnect=true&resize=scale"
                    style="width: 100%; height: 500px; border: 1px solid var(--border); border-radius: 4px;"
                    title="VNC Viewer"></iframe>
          </div>
        ` : "";

        // Sessions list
        const sessionsHtml = sessions.length > 0 ? `
          <h4>Saved Sessions</h4>
          <table class="table">
            <thead><tr><th>Name</th><th>Last Modified</th></tr></thead>
            <tbody>
              ${sessions.map(s => `<tr><td><code>${s.name}</code></td><td>${s.modified.substring(0, 19)}</td></tr>`).join("")}
            </tbody>
          </table>
        ` : '<p class="muted">No saved sessions. Use <code>crow_browser_save_session</code> to save cookies and storage.</p>';

        return {
          html: `
            ${statusHtml}
            ${controlsHtml}
            ${vncHtml}
            ${sessionsHtml}
          `,
        };
      } catch (err) {
        return { html: `<p class="error">Error loading browser panel: ${err.message}</p>` };
      }
    },
  };
}
