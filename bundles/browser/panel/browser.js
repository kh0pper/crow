/**
 * Crow Browser — Dashboard Panel
 *
 * Shows container status, VNC viewer embed, saved sessions,
 * and installed automation skills/recipes.
 */

export default {
  id: "browser",
  name: "Browser",
  icon: "globe",
  route: "/dashboard/browser",
  navOrder: 45,

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { existsSync, readdirSync, statSync, readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { homedir } = await import("node:os");
    const { escapeHtml, badge } = await import(
      pathToFileURL(join(appRoot, "servers/gateway/dashboard/shared/components.js")).href
    );

    // --- Container status ---
    let containerRunning = false;
    let startedAt = null;
    try {
      const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}|{{.State.StartedAt}}", "crow-browser"], { encoding: "utf-8", timeout: 5000 }).trim();
      const parts = out.split("|");
      containerRunning = parts[0] === "true";
      startedAt = parts[1];
    } catch {}

    let cdpConnected = false;
    try {
      execFileSync("curl", ["-s", "-m", "2", "http://127.0.0.1:9222/json/version"], { encoding: "utf-8", timeout: 5000 });
      cdpConnected = true;
    } catch {}

    // --- Saved sessions ---
    let sessions = [];
    const sessDir = join(homedir(), ".crow", "browser-sessions");
    try {
      if (existsSync(sessDir)) {
        sessions = readdirSync(sessDir)
          .filter(f => f.endsWith(".json"))
          .map(f => {
            const st = statSync(join(sessDir, f));
            return { name: f.replace(".json", ""), modified: st.mtime.toISOString().substring(0, 19) };
          })
          .sort((a, b) => b.modified.localeCompare(a.modified))
          .slice(0, 10);
      }
    } catch {}

    // --- Installed skills/recipes ---
    let skills = [];
    const skillsDir = join(homedir(), ".crow", "skills");
    try {
      if (existsSync(skillsDir)) {
        skills = readdirSync(skillsDir)
          .filter(f => f.startsWith("crow-browser") || f.includes("ffff") || f.includes("scrape"))
          .map(f => {
            const content = readFileSync(join(skillsDir, f), "utf-8");
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*"?(.+?)"?$/m);
            return {
              file: f,
              name: nameMatch ? nameMatch[1].trim() : f.replace(".md", ""),
              description: descMatch ? descMatch[1].trim() : "",
            };
          });
      }
    } catch {}

    const tab = req.query.tab || "status";

    // --- Status tab ---
    const statusContent = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-bottom:1.5rem;">
        <div style="padding:1rem; border:1px solid var(--border); border-radius:8px;">
          <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.25rem;">Container</div>
          <div>${containerRunning ? badge("Running", "success") : badge("Stopped", "danger")}
            ${startedAt ? `<span style="margin-left:0.5rem; font-size:0.8rem; color:var(--text-muted)">since ${escapeHtml(startedAt.substring(0, 19))}</span>` : ""}
          </div>
        </div>
        <div style="padding:1rem; border:1px solid var(--border); border-radius:8px;">
          <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.25rem;">CDP (Chrome DevTools)</div>
          <div>${cdpConnected ? badge("Connected", "success") : badge("Disconnected", "warning")}</div>
        </div>
      </div>

      <div style="display:flex; gap:0.5rem; margin-bottom:1.5rem;">
        <form method="POST" action="/api/browser/control" style="display:inline">
          <input type="hidden" name="action" value="start">
          <button type="submit" class="btn btn-primary btn-sm" ${containerRunning ? "disabled" : ""}>Start</button>
        </form>
        <form method="POST" action="/api/browser/control" style="display:inline">
          <input type="hidden" name="action" value="stop">
          <button type="submit" class="btn btn-danger btn-sm" ${!containerRunning ? "disabled" : ""}>Stop</button>
        </form>
        <form method="POST" action="/api/browser/control" style="display:inline">
          <input type="hidden" name="action" value="restart">
          <button type="submit" class="btn btn-sm">Restart</button>
        </form>
        ${containerRunning ? `<a href="/proxy/browser/vnc.html" target="_blank" class="btn btn-sm" style="margin-left:auto;">Open VNC Viewer &#8599;</a>` : ""}
      </div>

      ${containerRunning ? `
        <div style="margin-bottom:1rem;">
          <h4 style="margin-bottom:0.5rem;">Live View</h4>
          <iframe src="/proxy/browser/vnc.html?autoconnect=true&resize=scale"
                  style="width:100%; height:500px; border:1px solid var(--border); border-radius:8px;"
                  title="VNC Viewer"></iframe>
        </div>
      ` : ""}
    `;

    // --- Sessions tab ---
    const sessionsContent = sessions.length > 0 ? `
      <table class="table">
        <thead><tr><th>Session Name</th><th>Last Modified</th></tr></thead>
        <tbody>
          ${sessions.map(s => `<tr><td><code>${escapeHtml(s.name)}</code></td><td>${escapeHtml(s.modified)}</td></tr>`).join("")}
        </tbody>
      </table>
    ` : `<div class="empty-state" style="padding:2rem; text-align:center; color:var(--text-muted);">
      <p>No saved sessions. Use <code>crow_browser_save_session</code> to save cookies and storage state.</p>
    </div>`;

    // --- Skills tab ---
    const skillsContent = `
      ${skills.length > 0 ? skills.map(s => `
        <div style="border:1px solid var(--border); border-radius:8px; padding:1rem; margin-bottom:0.75rem;">
          <strong>${escapeHtml(s.name)}</strong>
          <div style="font-size:0.85rem; color:var(--text-muted); margin-top:0.25rem;">${escapeHtml(s.description)}</div>
          <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.25rem;">File: ${escapeHtml(s.file)}</div>
        </div>
      `).join("") : `
        <div class="empty-state" style="padding:2rem; text-align:center; color:var(--text-muted);">
          <p>No browser automation skills installed.</p>
          <p>Ask Crow to create a scraping recipe, or install one from the community.</p>
        </div>
      `}
    `;

    // --- Tab navigation ---
    const tabBtn = (name, label, count) => {
      const active = tab === name ? 'style="border-bottom:2px solid var(--primary); font-weight:600;"' : '';
      const countBadge = count > 0 ? ` (${count})` : "";
      return `<a href="/dashboard/browser?tab=${name}" ${active} style="padding:0.5rem 1rem; text-decoration:none; color:inherit;">${label}${countBadge}</a>`;
    };

    const tabContent = {
      status: statusContent,
      sessions: sessionsContent,
      skills: skillsContent,
    }[tab] || statusContent;

    const content = `
      <div style="border-bottom:1px solid var(--border); margin-bottom:1rem; display:flex; gap:0;">
        ${tabBtn("status", "Status", 0)}
        ${tabBtn("sessions", "Sessions", sessions.length)}
        ${tabBtn("skills", "Skills", skills.length)}
      </div>
      ${tabContent}
    `;

    return layout({
      title: "Browser Automation",
      content,
    });
  },
};
