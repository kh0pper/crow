/**
 * Crow's Nest Panel — Campaigns: Social media campaign dashboard
 *
 * Views: campaign list (default), campaign detail (?campaign_id=N),
 * pending approvals (?view=pending), setup (?view=setup)
 */

export default {
  id: "campaigns",
  name: "Campaigns",
  icon: "megaphone",
  route: "/dashboard/campaigns",
  navOrder: 25,

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml, statCard, statGrid, dataTable } = await import(pathToFileURL(componentsPath).href);

    // Resolve bundle server
    const installedDir = join(homedir(), ".crow", "bundles", "campaigns", "server");
    const repoDir = join(appRoot, "bundles", "campaigns", "server");
    const serverDir = existsSync(installedDir) ? installedDir : repoDir;
    const { createDbClient } = await import(pathToFileURL(join(serverDir, "db.js")).href);
    const cdb = createDbClient();

    // ============================================================
    // POST action handler (approve, retry, delete, save creds)
    // ============================================================
    if (req.method === "POST") {
      const action = req.query.action;
      const postId = req.query.post_id ? Number(req.query.post_id) : null;
      const campaignIdParam = req.query.campaign_id;

      if (action === "approve" && postId) {
        const post = await cdb.execute({ sql: "SELECT status FROM campaigns_posts WHERE id = ?", args: [postId] });
        if (post.rows[0]) {
          const oldStatus = post.rows[0].status;
          await cdb.execute({ sql: "UPDATE campaigns_posts SET status = 'approved', updated_at = datetime('now') WHERE id = ?", args: [postId] });
          await cdb.execute({
            sql: "INSERT INTO campaigns_post_history (post_id, from_status, to_status, details) VALUES (?, ?, 'approved', 'Approved via dashboard')",
            args: [postId, oldStatus],
          });
        }
        return res.redirectAfterPost(`/dashboard/campaigns${campaignIdParam ? `?campaign_id=${campaignIdParam}` : "?view=pending"}`);
      }

      if (action === "retry" && postId) {
        const post = await cdb.execute({ sql: "SELECT status FROM campaigns_posts WHERE id = ?", args: [postId] });
        if (post.rows[0] && post.rows[0].status === "failed") {
          await cdb.execute({ sql: "UPDATE campaigns_posts SET status = 'approved', error = NULL, updated_at = datetime('now') WHERE id = ?", args: [postId] });
          await cdb.execute({
            sql: "INSERT INTO campaigns_post_history (post_id, from_status, to_status, details) VALUES (?, 'failed', 'approved', 'Retried via dashboard')",
            args: [postId],
          });
        }
        return res.redirectAfterPost(`/dashboard/campaigns${campaignIdParam ? `?campaign_id=${campaignIdParam}` : ""}`);
      }

      if (action === "delete_post" && postId) {
        await cdb.execute({ sql: "DELETE FROM campaigns_posts WHERE id = ?", args: [postId] });
        return res.redirectAfterPost(`/dashboard/campaigns${campaignIdParam ? `?campaign_id=${campaignIdParam}` : ""}`);
      }

      if (action === "save_creds") {
        const ENCRYPTION_KEY = process.env.CROW_CAMPAIGNS_ENCRYPTION_KEY;
        if (!ENCRYPTION_KEY) {
          return res.redirectAfterPost("/dashboard/campaigns?view=setup&error=CROW_CAMPAIGNS_ENCRYPTION_KEY+not+set");
        }

        const { username, client_id, client_secret, password } = req.body;
        if (!username || !client_id || !client_secret || !password) {
          return res.redirectAfterPost("/dashboard/campaigns?view=setup&error=All+fields+required");
        }

        try {
          const { encrypt } = await import(pathToFileURL(join(serverDir, "crypto.js")).href);
          const { createRedditClient, testAuth } = await import(pathToFileURL(join(serverDir, "reddit-client.js")).href);

          const client = createRedditClient({ username, clientId: client_id, clientSecret: client_secret, password });
          await testAuth(client);

          const clientIdEnc = encrypt(client_id, ENCRYPTION_KEY);
          const clientSecretEnc = encrypt(client_secret, ENCRYPTION_KEY);
          const passwordEnc = encrypt(password, ENCRYPTION_KEY);

          await cdb.execute({
            sql: "UPDATE campaigns_credentials SET is_active = 0, updated_at = datetime('now') WHERE platform = 'reddit' AND username = ? AND is_active = 1",
            args: [username],
          });
          await cdb.execute({
            sql: "INSERT INTO campaigns_credentials (platform, username, client_id_enc, client_secret_enc, password_enc) VALUES ('reddit', ?, ?, ?, ?)",
            args: [username, clientIdEnc, clientSecretEnc, passwordEnc],
          });

          return res.redirectAfterPost(`/dashboard/campaigns?view=setup&success=Credentials+saved+for+@${encodeURIComponent(username)}`);
        } catch (err) {
          return res.redirectAfterPost(`/dashboard/campaigns?view=setup&error=${encodeURIComponent(err.message)}`);
        }
      }

      return res.redirectAfterPost("/dashboard/campaigns");
    }

    const view = req.query.view;
    const campaignId = req.query.campaign_id ? Number(req.query.campaign_id) : null;

    // ============================================================
    // Setup view
    // ============================================================
    if (view === "setup") {
      const { rows: creds } = await cdb.execute({
        sql: "SELECT id, platform, username, is_active, created_at FROM campaigns_credentials ORDER BY is_active DESC, created_at DESC",
      });

      let credsHtml = "";
      if (creds.length > 0) {
        credsHtml = `<div style="margin-bottom:1.5rem">
          <h3 style="margin:0 0 0.5rem">Saved Credentials</h3>
          <table class="data-table"><thead><tr>
            <th>Platform</th><th>Username</th><th>Status</th><th>Added</th>
          </tr></thead><tbody>`;
        for (const c of creds) {
          const statusBadge = c.is_active
            ? '<span style="color:#22c55e;font-weight:500">Active</span>'
            : '<span style="color:var(--crow-text-muted)">Inactive</span>';
          credsHtml += `<tr>
            <td>${escapeHtml(c.platform)}</td>
            <td>@${escapeHtml(c.username)}</td>
            <td>${statusBadge}</td>
            <td>${escapeHtml(c.created_at || "")}</td>
          </tr>`;
        }
        credsHtml += `</tbody></table></div>`;
      }

      const content = `
        <div style="max-width:700px;margin:0 auto;padding:1rem">
          <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
            <a href="/dashboard/campaigns" style="color:var(--crow-accent);text-decoration:none">&larr; Back</a>
            <h1 style="margin:0;font-size:1.4rem">Campaign Setup</h1>
          </div>

          ${credsHtml}

          <div style="background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:8px;padding:1.5rem">
            <h3 style="margin:0 0 0.5rem">Add Reddit Credentials</h3>
            <p style="font-size:0.82rem;color:var(--crow-text-secondary);margin:0 0 1rem">
              Register a "script" app at
              <a href="https://www.reddit.com/prefs/apps" target="_blank" rel="noopener">reddit.com/prefs/apps</a>,
              then enter the credentials below. They'll be validated against the Reddit API and encrypted before saving.
            </p>
            <form method="POST" action="/dashboard/campaigns?view=setup&action=save_creds" style="display:grid;gap:0.75rem">
              <label style="font-size:0.82rem;font-weight:500">
                Reddit Username
                <input type="text" name="username" required placeholder="your_reddit_username"
                  style="width:100%;margin-top:0.25rem;padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.9rem">
              </label>
              <label style="font-size:0.82rem;font-weight:500">
                Client ID
                <input type="text" name="client_id" required placeholder="From reddit.com/prefs/apps"
                  style="width:100%;margin-top:0.25rem;padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.9rem">
              </label>
              <label style="font-size:0.82rem;font-weight:500">
                Client Secret
                <input type="password" name="client_secret" required
                  style="width:100%;margin-top:0.25rem;padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.9rem">
              </label>
              <label style="font-size:0.82rem;font-weight:500">
                Reddit Password
                <input type="password" name="password" required
                  style="width:100%;margin-top:0.25rem;padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.9rem">
              </label>
              <button type="submit" style="padding:0.6rem 1.2rem;background:var(--crow-accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;font-size:0.9rem;justify-self:start">
                Test &amp; Save
              </button>
            </form>
            ${req.query.error ? `<div style="margin-top:0.75rem;padding:0.5rem;background:#ef444420;border:1px solid #ef4444;border-radius:4px;color:#ef4444;font-size:0.82rem">${escapeHtml(req.query.error)}</div>` : ""}
            ${req.query.success ? `<div style="margin-top:0.75rem;padding:0.5rem;background:#22c55e20;border:1px solid #22c55e;border-radius:4px;color:#22c55e;font-size:0.82rem">${escapeHtml(req.query.success)}</div>` : ""}
          </div>
        </div>`;
      return layout({ title: "Campaign Setup", content });
    }

    // ============================================================
    // Pending approvals view
    // ============================================================
    if (view === "pending") {
      const { rows: pending } = await cdb.execute({
        sql: `SELECT p.*, c.name as campaign_name
              FROM campaigns_posts p
              JOIN campaigns_campaigns c ON p.campaign_id = c.id
              WHERE p.status = 'pending_approval'
              ORDER BY p.scheduled_at ASC, p.created_at DESC`,
      });

      let tableHtml;
      if (pending.length === 0) {
        tableHtml = `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">No posts pending approval.</div>`;
      } else {
        const rows = pending.map(p => [
          `<a href="/dashboard/campaigns?campaign_id=${p.campaign_id}" style="color:var(--crow-accent)">${escapeHtml(p.campaign_name)}</a>`,
          `r/${escapeHtml(p.subreddit_name)}`,
          escapeHtml(p.title || "(untitled)"),
          escapeHtml(p.scheduled_at || "Not scheduled"),
          `<form method="POST" action="/dashboard/campaigns?action=approve&post_id=${p.id}" style="display:inline">
            <button type="submit" style="padding:0.25rem 0.6rem;background:#22c55e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.75rem">Approve</button>
          </form>`,
        ]);
        tableHtml = dataTable(["Campaign", "Subreddit", "Title", "Scheduled", "Action"], rows);
      }

      const content = `
        <div style="max-width:1100px;margin:0 auto;padding:1rem">
          <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
            <a href="/dashboard/campaigns" style="color:var(--crow-accent);text-decoration:none">&larr; Back</a>
            <h1 style="margin:0;font-size:1.4rem">Pending Approvals (${pending.length})</h1>
          </div>
          ${tableHtml}
        </div>`;
      return layout({ title: "Pending Approvals", content });
    }

    // ============================================================
    // Campaign detail view
    // ============================================================
    if (campaignId) {
      const campaignResult = await cdb.execute({
        sql: "SELECT * FROM campaigns_campaigns WHERE id = ?", args: [campaignId],
      });
      if (!campaignResult.rows[0]) {
        const content = `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">Campaign not found.</div>`;
        return layout({ title: "Campaign Not Found", content });
      }

      const campaign = campaignResult.rows[0];
      const { rows: posts } = await cdb.execute({
        sql: "SELECT * FROM campaigns_posts WHERE campaign_id = ? ORDER BY status ASC, scheduled_at ASC, created_at DESC",
        args: [campaignId],
      });

      // Status color helper
      function postStatusColor(s) {
        return { draft: "#6b7280", scheduled: "#3b82f6", pending_approval: "#f59e0b", approved: "#22c55e",
          publishing: "#a855f7", published: "#059669", failed: "#ef4444" }[s] || "#6b7280";
      }
      function campaignStatusColor(s) {
        return { draft: "#6b7280", active: "#22c55e", paused: "#f59e0b", completed: "#3b82f6", archived: "#9ca3af" }[s] || "#6b7280";
      }

      // Post rows
      let postsHtml;
      if (posts.length === 0) {
        postsHtml = `<div style="padding:1.5rem;text-align:center;color:var(--crow-text-muted)">
          No posts yet. Use <code>crow_campaign_draft_post</code> to create one.
        </div>`;
      } else {
        postsHtml = `<table class="data-table"><thead><tr>
          <th>Subreddit</th><th>Title</th><th>Type</th><th>Status</th><th>Scheduled</th><th>Actions</th>
        </tr></thead><tbody>`;
        for (const p of posts) {
          const color = postStatusColor(p.status);
          const statusBadge = `<span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:10px;font-size:0.72rem;font-weight:500;background:${color}20;color:${color}">${escapeHtml(p.status)}</span>`;

          let actions = "";
          if (p.status === "failed") {
            actions += `<form method="POST" action="/dashboard/campaigns?action=retry&post_id=${p.id}&campaign_id=${campaignId}" style="display:inline">
              <button type="submit" style="padding:0.2rem 0.5rem;background:#f59e0b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.72rem">Retry</button>
            </form> `;
          }
          if (p.status === "pending_approval" || p.status === "draft") {
            actions += `<form method="POST" action="/dashboard/campaigns?action=approve&post_id=${p.id}&campaign_id=${campaignId}" style="display:inline">
              <button type="submit" style="padding:0.2rem 0.5rem;background:#22c55e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.72rem">Approve</button>
            </form> `;
          }
          if (p.status === "published" && p.reddit_url) {
            actions += `<a href="${escapeHtml(p.reddit_url)}" target="_blank" rel="noopener" style="font-size:0.72rem;color:var(--crow-accent)">View</a> `;
          }
          if (p.status !== "published" && p.status !== "publishing") {
            actions += `<form method="POST" action="/dashboard/campaigns?action=delete_post&post_id=${p.id}&campaign_id=${campaignId}" style="display:inline">
              <button type="submit" style="padding:0.2rem 0.5rem;background:transparent;color:#ef4444;border:1px solid #ef4444;border-radius:4px;cursor:pointer;font-size:0.72rem" onclick="return confirm('Delete this post?')">Del</button>
            </form>`;
          }

          const errorNote = p.error ? `<div style="font-size:0.7rem;color:#ef4444;margin-top:0.2rem">${escapeHtml(p.error)}</div>` : "";

          postsHtml += `<tr>
            <td>r/${escapeHtml(p.subreddit_name)}</td>
            <td>${escapeHtml(p.title || "(untitled)")}${errorNote}</td>
            <td>${escapeHtml(p.post_type)}</td>
            <td>${statusBadge}</td>
            <td style="font-size:0.8rem">${escapeHtml(p.scheduled_at || "")}</td>
            <td>${actions}</td>
          </tr>`;
        }
        postsHtml += `</tbody></table>`;
      }

      // Campaign header
      const cColor = campaignStatusColor(campaign.status);
      const cBadge = `<span style="display:inline-block;padding:0.2rem 0.6rem;border-radius:12px;font-size:0.75rem;font-weight:500;background:${cColor}20;color:${cColor}">${escapeHtml(campaign.status)}</span>`;
      const approvalBadge = campaign.require_approval
        ? '<span style="font-size:0.75rem;color:#f59e0b">Approval required</span>'
        : '<span style="font-size:0.75rem;color:#22c55e">Auto-publish</span>';

      const content = `
        <div style="max-width:1100px;margin:0 auto;padding:1rem">
          <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
            <a href="/dashboard/campaigns" style="color:var(--crow-accent);text-decoration:none">&larr; Back</a>
            <h1 style="margin:0;font-size:1.4rem">${escapeHtml(campaign.name)}</h1>
            ${cBadge}
            ${approvalBadge}
          </div>

          ${campaign.brief ? `<div style="padding:0.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:6px;margin-bottom:1rem;font-size:0.85rem;color:var(--crow-text-secondary)"><strong>Brief:</strong> ${escapeHtml(campaign.brief)}</div>` : ""}

          ${statGrid([
            statCard("Total Posts", posts.length),
            statCard("Published", posts.filter(p => p.status === "published").length, { delay: 50 }),
            statCard("Pending", posts.filter(p => p.status === "pending_approval").length, { delay: 100 }),
            statCard("Failed", posts.filter(p => p.status === "failed").length, { delay: 150 }),
          ])}

          <h2 style="font-size:1.1rem;margin:1.5rem 0 0.75rem">Posts</h2>
          ${postsHtml}
        </div>`;
      return layout({ title: campaign.name, content });
    }

    // ============================================================
    // Campaign list (default view)
    // ============================================================
    const { rows: campaigns } = await cdb.execute({
      sql: `SELECT c.*,
        (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id) as total_posts,
        (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'published') as published_posts,
        (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'pending_approval') as pending_posts,
        (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'failed') as failed_posts
      FROM campaigns_campaigns c ORDER BY c.updated_at DESC`,
    });

    const { rows: creds } = await cdb.execute({
      sql: "SELECT COUNT(*) as count FROM campaigns_credentials WHERE is_active = 1",
    });
    const hasCredentials = creds[0].count > 0;

    const totalPending = campaigns.reduce((s, c) => s + (Number(c.pending_posts) || 0), 0);
    const totalPublished = campaigns.reduce((s, c) => s + (Number(c.published_posts) || 0), 0);
    const totalFailed = campaigns.reduce((s, c) => s + (Number(c.failed_posts) || 0), 0);

    // Stat cards
    const stats = statGrid([
      statCard("Campaigns", campaigns.length),
      statCard("Published", totalPublished, { delay: 50 }),
      statCard("Pending Approval", totalPending, { delay: 100 }),
      statCard("Failed", totalFailed, { delay: 150 }),
    ]);

    // Setup banner if no credentials
    const setupBanner = hasCredentials ? "" : `
      <div style="padding:0.75rem 1rem;background:#f59e0b20;border:1px solid #f59e0b;border-radius:6px;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:0.85rem;color:#f59e0b">No Reddit credentials configured. Set up credentials to enable publishing.</span>
        <a href="/dashboard/campaigns?view=setup" style="padding:0.3rem 0.8rem;background:#f59e0b;color:#fff;border-radius:4px;text-decoration:none;font-size:0.82rem;font-weight:500">Setup</a>
      </div>`;

    // Campaign table
    let tableHtml;
    if (campaigns.length === 0) {
      tableHtml = `<div style="padding:2rem;text-align:center;color:var(--crow-text-muted)">
        <p>No campaigns yet.</p>
        <p style="font-size:0.85rem">Use <code>crow_campaign_create</code> to create one.</p>
      </div>`;
    } else {
      function campaignStatusColor(s) {
        return { draft: "#6b7280", active: "#22c55e", paused: "#f59e0b", completed: "#3b82f6", archived: "#9ca3af" }[s] || "#6b7280";
      }

      const rows = campaigns.map(c => {
        const color = campaignStatusColor(c.status);
        const badge = `<span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:10px;font-size:0.72rem;font-weight:500;background:${color}20;color:${color}">${escapeHtml(c.status)}</span>`;
        const postSummary = `${c.published_posts || 0} pub / ${c.total_posts || 0} total`;
        const pendingBadge = c.pending_posts > 0
          ? ` <span style="color:#f59e0b;font-size:0.72rem">(${c.pending_posts} pending)</span>`
          : "";
        const failedBadge = c.failed_posts > 0
          ? ` <span style="color:#ef4444;font-size:0.72rem">(${c.failed_posts} failed)</span>`
          : "";

        return [
          `<a href="/dashboard/campaigns?campaign_id=${c.id}" style="color:var(--crow-accent);text-decoration:none;font-weight:500">${escapeHtml(c.name)}</a>`,
          badge,
          `${postSummary}${pendingBadge}${failedBadge}`,
          escapeHtml(c.updated_at || ""),
        ];
      });

      tableHtml = dataTable(["Campaign", "Status", "Posts", "Updated"], rows);
    }

    // Nav links
    const navLinks = `
      <div style="display:flex;gap:0.75rem;align-items:center">
        ${totalPending > 0 ? `<a href="/dashboard/campaigns?view=pending" style="padding:0.3rem 0.8rem;background:#f59e0b;color:#fff;border-radius:4px;text-decoration:none;font-size:0.82rem;font-weight:500">${totalPending} Pending</a>` : ""}
        <a href="/dashboard/campaigns?view=setup" style="font-size:0.82rem;color:var(--crow-text-secondary);text-decoration:none">Setup</a>
      </div>`;

    const content = `
      <div style="max-width:1100px;margin:0 auto;padding:1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
          <h1 style="margin:0;font-size:1.4rem">Campaigns</h1>
          ${navLinks}
        </div>
        ${setupBanner}
        ${stats}
        ${tableHtml}
      </div>`;
    return layout({ title: "Campaigns", content });
  },

};
