/**
 * Crow Browser — Dashboard Panel
 *
 * Shows container status, VNC viewer embed, saved sessions,
 * and installed automation skills/recipes.
 */

/**
 * The bot holding this instance's browser lease, or null (free, expired, the
 * operator's own holding, or unreadable). `isFree` comes from the lease module.
 */
export function botHolding(lease, isFree, now = Date.now()) {
  if (!lease || typeof isFree !== "function" || isFree(lease, now)) return null;
  const h = lease.holder;
  if (!h || h.kind !== "bot") return null;
  return { sessionId: typeof h.sessionId === "string" ? h.sessionId : "" };
}

/** Take over: the chat's sheet for a Perch session (its thread under it), else the sheet alone. */
export function takeOverHref(holding) {
  const sid = holding && holding.sessionId;
  // A Perch session: the link is checked against that chat's live turn. Any
  // other holder (an external client): the panel's own take-over.
  return /^perchlive-[0-9a-f]{8}$/.test(sid || "") ? "/dashboard/perch?take-over=1#" + sid : "/dashboard/perch?take-over=panel";
}

/** The panel's Hand back: the same route as the chat's sheet (CSRF header from the cookie). No backtick or dollar-brace. */
export const HAND_BACK_JS = "(function(){var b=document.getElementById('browser-hand-back');if(!b)return;" +
  "b.addEventListener('click',function(){if(b.disabled)return;b.disabled=true;" +
  "var m=document.cookie.match(/(?:^|; )crow_csrf=([^;]*)/);" +
  "fetch('/dashboard/perch-api/browser/hand-back',{method:'POST',headers:{'X-Crow-Csrf':m?decodeURIComponent(m[1]):''}})" +
  ".then(function(r){if(r.ok){location.reload();}else{b.disabled=false;}},function(){b.disabled=false;});});})();";

/**
 * The noVNC viewer URLs. The bundled noVNC (Ubuntu 22.04's novnc 1:1.0.0)
 * reads view_only from the query string and then KEEPS it in localStorage
 * (WebUtil.writeSetting), shared by every viewer on this origin, so the
 * interactive ones pin view_only=false; otherwise watching once would leave
 * the Take over sheet's viewer unable to type or click.
 */
export const VNC_VIEW_ONLY = "/proxy/browser/vnc.html?view_only=true&autoconnect=true&resize=scale";
export const VNC_INTERACTIVE = "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false";
const VNC_INTERACTIVE_POPOUT = "/proxy/browser/vnc.html?view_only=false";

export default {
  id: "browser",
  name: "Browser",
  icon: "globe",
  route: "/dashboard/browser",
  navOrder: 45,

  async handler(req, res, { db, layout, appRoot, lang }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { existsSync, readdirSync, statSync, readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { homedir } = await import("node:os");
    const { escapeHtml, badge } = await import(
      pathToFileURL(join(appRoot, "servers/gateway/dashboard/shared/components.js")).href
    );

    // The panel is deployed to <CROW_HOME>/panels/, not the bundle directory, so a
    // relative import of instance.js can't be correct in both the repo and the
    // deployed layout — resolve it by absolute path from CROW_HOME instead.
    //
    // Fail soft like the docker/curl calls below: if the bundle isn't installed
    // (instance.js missing), leave everything at its "unknown/empty" default —
    // never silently fall back to primary-flavoured constants, which is the
    // defect this resolves.
    let stateDir = null, containerName = null, cdpPort = null;
    try {
      const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
      const instanceUrl = pathToFileURL(join(crowHome, "bundles", "browser", "server", "instance.js")).href;
      ({ stateDir, containerName, cdpPort } = await import(instanceUrl));
    } catch {}

    // --- Container status ---
    let containerRunning = false;
    let startedAt = null;
    try {
      const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}|{{.State.StartedAt}}", containerName()], { encoding: "utf-8", timeout: 5000 }).trim();
      const parts = out.split("|");
      containerRunning = parts[0] === "true";
      startedAt = parts[1];
    } catch {}

    let cdpConnected = false;
    try {
      execFileSync("curl", ["-s", "-m", "2", `http://127.0.0.1:${cdpPort()}/json/version`], { encoding: "utf-8", timeout: 5000 });
      cdpConnected = true;
    } catch {}

    // --- Saved sessions ---
    let sessions = [];
    try {
      const sessDir = stateDir("browser-sessions");
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
    try {
      const skillsDir = stateDir("skills");
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

    // --- Live browser tile: a bot holding the lease (a lock-free read) ---
    // The viewer is not a silent bypass: while a bot drives the page, the
    // panel says so and points at Take over (the chat's sheet, which asks the
    // bot to pause), and shows the page in a VIEW-ONLY viewer (noVNC 1.0's
    // view_only setting) so the operator can watch without acting behind its
    // back. Advisory, like the lease; an older core without the module
    // shows the interactive viewer as before.
    let botUsing = null;
    try {
      const leaseMod = await import(pathToFileURL(join(appRoot, "servers/shared/browser-lease.js")).href);
      botUsing = botHolding(await leaseMod.readLease(leaseMod.leaseDir(stateDir)), leaseMod.isFree);
    } catch {}
    // The operator's own holding: the gateway's in-memory take-over state
    // (never the lease file, which a bot can write). Never creates an engine.
    let operatorHas = false;
    try {
      const eng = (await import(pathToFileURL(join(appRoot, "servers/gateway/perch-interactive.js")).href))
        .getInteractiveEngine({ createIfMissing: false });
      const st = eng && eng.browserTakeOver && eng.browserTakeOver.state();
      operatorHas = st === "held" || st === "pending";
    } catch {}
    let botUsingText = "A bot is using the browser", takeOverText = "Take over";
    let youHaveText = "You have the browser", handBackText = "Hand back";
    try {
      const { t } = await import(pathToFileURL(join(appRoot, "servers/gateway/dashboard/shared/i18n.js")).href);
      botUsingText = t("browser.botUsing", lang);
      takeOverText = t("perch.takeOver", lang);
      youHaveText = t("perch.youHaveBrowser", lang);
      handBackText = t("perch.handBack", lang);
    } catch {}
    const botNotice = botUsing ? `
      <div class="browser-bot-using" role="status" style="display:flex; flex-wrap:wrap; align-items:center; gap:0.75rem; padding:1rem; border:1px solid var(--border); border-radius:8px; margin-bottom:1rem;">
        <span>${escapeHtml(botUsingText)}</span>
        <a class="btn btn-primary btn-sm" style="min-height:44px; display:inline-flex; align-items:center;" href="${escapeHtml(takeOverHref(botUsing))}">${escapeHtml(takeOverText)}</a>
      </div>` : "";
    const operatorNotice = operatorHas ? `
      <div class="browser-operator-has" role="status" style="display:flex; flex-wrap:wrap; align-items:center; gap:0.75rem; padding:1rem; border:1px solid var(--border); border-radius:8px; margin-bottom:1rem;">
        <span>${escapeHtml(youHaveText)}</span>
        <button type="button" id="browser-hand-back" class="btn btn-primary btn-sm" style="min-height:44px;">${escapeHtml(handBackText)}</button>
      </div>
      <script>${HAND_BACK_JS}</script>` : "";

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
        ${containerRunning && !botUsing ? `<a href="${VNC_INTERACTIVE_POPOUT}" target="_blank" class="btn btn-sm" style="margin-left:auto;">Open VNC Viewer &#8599;</a>` : ""}
      </div>

      ${operatorNotice}
      ${botNotice}
      ${containerRunning ? `
        <div style="margin-bottom:1rem;">
          <h4 style="margin-bottom:0.5rem;">Live View</h4>
          <iframe src="${botUsing ? VNC_VIEW_ONLY : VNC_INTERACTIVE}"
                  style="width:100%; height:500px; border:1px solid var(--border); border-radius:8px;"
                  title="VNC Viewer"></iframe>
        </div>
      ` : ""}
    `;

    // --- Sessions tab ---
    const sessionsContent = sessions.length > 0 ? `
      <div class="table-scroll"><table class="table">
        <thead><tr><th>Session Name</th><th>Last Modified</th></tr></thead>
        <tbody>
          ${sessions.map(s => `<tr><td><code>${escapeHtml(s.name)}</code></td><td>${escapeHtml(s.modified)}</td></tr>`).join("")}
        </tbody>
      </table></div>
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
