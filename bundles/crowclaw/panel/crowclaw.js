/**
 * Crow's Nest Panel — CrowClaw: Bot management dashboard
 *
 * Bundle-compatible version: uses dynamic imports with appRoot.
 */

export default {
  id: "bots",
  name: "Bots",
  icon: "bot",
  route: "/dashboard/bots",
  navOrder: 20,

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { existsSync, readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml, badge, formatDate } = await import(pathToFileURL(componentsPath).href);

    // Resolve bundle server directory
    const installedServerDir = join(homedir(), ".crow", "bundles", "crowclaw", "server");
    const repoServerDir = join(appRoot, "bundles", "crowclaw", "server");
    const bundleServerDir = existsSync(installedServerDir) ? installedServerDir : repoServerDir;

    const { createDbClient } = await import(pathToFileURL(join(bundleServerDir, "db.js")).href);
    const crowDb = createDbClient();

    // Fetch all bots
    const { rows: bots } = await crowDb.execute({ sql: "SELECT * FROM crowclaw_bots ORDER BY name" });

    // Selected bot detail
    const selectedBotId = req.query.bot_id ? Number(req.query.bot_id) : null;
    let selectedBot = null;
    let profiles = [];
    let workspaceFiles = [];
    let recentDeployments = [];
    let safetyEvents = [];

    if (selectedBotId) {
      const botResult = await crowDb.execute({ sql: "SELECT * FROM crowclaw_bots WHERE id = ?", args: [selectedBotId] });
      selectedBot = botResult.rows[0] || null;

      if (selectedBot) {
        const [pResult, wResult, dResult, sResult] = await Promise.all([
          crowDb.execute({ sql: "SELECT * FROM crowclaw_user_profiles WHERE bot_id = ? ORDER BY is_owner DESC, display_name", args: [selectedBotId] }),
          crowDb.execute({ sql: "SELECT file_name, is_template, lamport_ts FROM crowclaw_workspace_files WHERE bot_id = ? ORDER BY file_name", args: [selectedBotId] }),
          crowDb.execute({ sql: "SELECT * FROM crowclaw_deployments WHERE bot_id = ? ORDER BY started_at DESC LIMIT 10", args: [selectedBotId] }),
          crowDb.execute({ sql: "SELECT * FROM crowclaw_safety_events WHERE bot_id = ? ORDER BY timestamp DESC LIMIT 20", args: [selectedBotId] }),
        ]);
        profiles = pResult.rows;
        workspaceFiles = wResult.rows;
        recentDeployments = dResult.rows;
        safetyEvents = sResult.rows;
      }
    }

    // Status color helper
    function statusColor(status) {
      const colors = {
        running: "#22c55e", deployed: "#3b82f6", stopped: "#ef4444",
        created: "#a855f7", configured: "#f59e0b", error: "#ef4444",
      };
      return colors[status] || "#6b7280";
    }

    // Bot cards
    let botCardsHtml = "";
    if (bots.length === 0) {
      botCardsHtml = `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">
        <p>No bots configured yet.</p>
        <p style="font-size:0.85rem">Use <code>crow_create_bot</code> to create one, or import an existing bot.</p>
      </div>`;
    } else {
      botCardsHtml = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;padding:1rem">`;
      for (const bot of bots) {
        const isSelected = bot.id === selectedBotId;
        const border = isSelected ? "border:2px solid var(--crow-accent)" : "border:1px solid var(--crow-border)";
        botCardsHtml += `
          <a href="/dashboard/bots?bot_id=${bot.id}" style="text-decoration:none;color:inherit">
            <div style="${border};border-radius:8px;padding:1rem;background:var(--crow-bg-surface);transition:border-color 0.15s">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                <h3 style="margin:0;font-size:1rem;font-weight:600">${escapeHtml(bot.display_name || bot.name)}</h3>
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor(bot.status)}"></span>
              </div>
              <div style="font-size:0.8rem;color:var(--crow-text-secondary)">
                <span>${escapeHtml(bot.status)}</span>
                <span style="margin:0 0.4rem">&middot;</span>
                <span>Port ${bot.gateway_port || "—"}</span>
                <span style="margin:0 0.4rem">&middot;</span>
                <span>${escapeHtml(bot.deploy_mode)}</span>
              </div>
              ${bot.ai_source === "byoai" ? '<div style="margin-top:0.4rem;font-size:0.7rem;color:var(--crow-accent)">BYOAI</div>' : ""}
            </div>
          </a>`;
      }
      botCardsHtml += `</div>`;
    }

    // Bot detail section
    let detailHtml = "";
    if (selectedBot) {
      // Read gateway token from bot config for tokenized proxy URL
      let gatewayToken = "";
      try {
        const configPath = join(selectedBot.config_dir, "openclaw.json");
        if (existsSync(configPath)) {
          const botConfig = JSON.parse(readFileSync(configPath, "utf8"));
          gatewayToken = botConfig?.gateway?.auth?.token || "";
        }
      } catch {}

      // Proxy URL with token hash (auto-authenticates WebSocket) + direct fallback
      const controlUrl = `/proxy/crowclaw/chat?session=main#token=${gatewayToken}`;
      const reqHost = req.get("host") || "";
      const baseHost = reqHost.split(":")[0];
      const proto = req.protocol || "https";
      const directUrl = `${proto}://${baseHost}:${selectedBot.gateway_port}/`;

      // Profiles table
      let profilesHtml = `<table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--crow-border)">
          <th style="padding:0.4rem">Name</th><th style="padding:0.4rem">Platform</th>
          <th style="padding:0.4rem">Language</th><th style="padding:0.4rem">Voice</th>
          <th style="padding:0.4rem">Owner</th>
        </tr></thead><tbody>`;
      for (const p of profiles) {
        profilesHtml += `<tr style="border-bottom:1px solid var(--crow-border-subtle)">
          <td style="padding:0.4rem">${escapeHtml(p.display_name || p.platform_user_id)}</td>
          <td style="padding:0.4rem">${escapeHtml(p.platform)}</td>
          <td style="padding:0.4rem">${escapeHtml(p.language || "en")}</td>
          <td style="padding:0.4rem">${escapeHtml(p.tts_voice || "default")}</td>
          <td style="padding:0.4rem">${p.is_owner ? "Yes" : ""}</td>
        </tr>`;
      }
      profilesHtml += `</tbody></table>`;

      // Workspace files list
      let wsHtml = workspaceFiles.length > 0
        ? `<ul style="list-style:none;padding:0;margin:0">${workspaceFiles.map(f =>
            `<li style="padding:0.3rem 0;font-size:0.82rem;border-bottom:1px solid var(--crow-border-subtle)">${escapeHtml(f.file_name)}</li>`
          ).join("")}</ul>`
        : `<p style="color:var(--crow-text-muted);font-size:0.82rem">No workspace files</p>`;

      // Deployments list
      let deploymentsHtml = recentDeployments.length > 0
        ? `<ul style="list-style:none;padding:0;margin:0">${recentDeployments.map(d =>
            `<li style="padding:0.3rem 0;font-size:0.82rem;border-bottom:1px solid var(--crow-border-subtle)">
              <strong>${escapeHtml(d.action)}</strong> — ${escapeHtml(d.status)}
              <span style="color:var(--crow-text-muted);margin-left:0.5rem">${escapeHtml(d.started_at || "")}</span>
            </li>`
          ).join("")}</ul>`
        : `<p style="color:var(--crow-text-muted);font-size:0.82rem">No deployments yet</p>`;

      // Safety events
      let safetyHtml = safetyEvents.length > 0
        ? `<ul style="list-style:none;padding:0;margin:0">${safetyEvents.map(e =>
            `<li style="padding:0.3rem 0;font-size:0.82rem;border-bottom:1px solid var(--crow-border-subtle)">
              <span style="color:${e.severity === "high" ? "#ef4444" : e.severity === "warning" ? "#f59e0b" : "var(--crow-text-secondary)"}">${escapeHtml(e.severity)}</span>
              ${escapeHtml(e.event_type)}
              <span style="color:var(--crow-text-muted);margin-left:0.5rem">${escapeHtml(e.timestamp || "")}</span>
            </li>`
          ).join("")}</ul>`
        : `<p style="color:var(--crow-text-muted);font-size:0.82rem">No safety events</p>`;

      detailHtml = `
        <div style="padding:1rem;border-top:1px solid var(--crow-border)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h2 style="margin:0;font-size:1.2rem">${escapeHtml(selectedBot.display_name || selectedBot.name)}</h2>
            <div style="display:flex;gap:0.5rem;align-items:center">
              <span style="display:inline-block;padding:0.2rem 0.6rem;border-radius:12px;font-size:0.75rem;font-weight:500;background:${statusColor(selectedBot.status)}20;color:${statusColor(selectedBot.status)}">${escapeHtml(selectedBot.status)}</span>
              <a href="${escapeHtml(controlUrl)}" target="_blank" rel="noopener" style="font-size:0.82rem;color:var(--crow-accent)">OpenClaw Control UI &rarr;</a>
              <a href="${escapeHtml(directUrl)}" target="_blank" rel="noopener" style="font-size:0.72rem;color:var(--crow-text-muted);margin-left:0.5rem">Direct</a>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;font-size:0.82rem;margin-bottom:1.5rem">
            <div><strong>Config dir:</strong> ${escapeHtml(selectedBot.config_dir || "—")}</div>
            <div><strong>Service:</strong> ${escapeHtml(selectedBot.service_unit || "—")}</div>
            <div><strong>Port:</strong> ${selectedBot.gateway_port || "—"}</div>
            <div><strong>AI Source:</strong> ${escapeHtml(selectedBot.ai_source || "custom")}</div>
            <div><strong>Deploy mode:</strong> ${escapeHtml(selectedBot.deploy_mode)}</div>
            <div><strong>Model:</strong> ${escapeHtml(selectedBot.primary_model || "—")}</div>
          </div>

          <details open style="margin-bottom:1rem">
            <summary style="font-weight:600;cursor:pointer;padding:0.4rem 0">User Profiles (${profiles.length})</summary>
            ${profilesHtml}
          </details>

          <details style="margin-bottom:1rem">
            <summary style="font-weight:600;cursor:pointer;padding:0.4rem 0">Workspace Files (${workspaceFiles.length})</summary>
            ${wsHtml}
          </details>

          <details style="margin-bottom:1rem">
            <summary style="font-weight:600;cursor:pointer;padding:0.4rem 0">Recent Deployments</summary>
            ${deploymentsHtml}
          </details>

          <details style="margin-bottom:1rem">
            <summary style="font-weight:600;cursor:pointer;padding:0.4rem 0">Safety Events</summary>
            ${safetyHtml}
          </details>
        </div>`;
    }

    const content = `
      <div style="max-width:1100px;margin:0 auto">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:1rem">
          <h1 style="margin:0;font-size:1.4rem">CrowClaw — Bot Management</h1>
        </div>
        ${botCardsHtml}
        ${detailHtml}
      </div>
    `;

    return layout({ title: "CrowClaw Bots", content });
  },
};
