/**
 * Crow Campaigns MCP Server
 *
 * Social media campaign management: create campaigns, manage posts,
 * store encrypted credentials, schedule and publish to Reddit.
 *
 * 13 tools: campaign CRUD (4) + credentials (1) + subreddit intelligence (2) + post management (3) + AI drafting (1) + publishing (2)
 *
 * Factory function: createCampaignsServer(dbPath?, options?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { generateToken, validateToken, shouldSkipGates } from "./confirm.js";
import { createRedditClient, testAuth } from "./reddit-client.js";
import { crawlSubreddit } from "./subreddit-crawler.js";
import { publishPost, checkRateLimit } from "./post-publisher.js";
import { generateDraft } from "./draft-generator.js";

const ENCRYPTION_KEY = process.env.CROW_CAMPAIGNS_ENCRYPTION_KEY;

export function createCampaignsServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-campaigns", version: "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  const db = createDbClient(dbPath);

  // ===================================================================
  // Campaign CRUD (4 tools)
  // ===================================================================

  // --- crow_campaign_create ---
  server.tool(
    "crow_campaign_create",
    "Create a new social media campaign.",
    {
      name: z.string().min(1).max(200).describe("Campaign name"),
      description: z.string().max(2000).optional().describe("Campaign description"),
      brief: z.string().max(5000).optional().describe("Campaign brief for AI drafting"),
      credential_id: z.number().int().optional().describe("Credential ID to use (nullable for drafts)"),
      require_approval: z.boolean().optional().describe("Require approval before publishing (default: true)"),
    },
    async ({ name, description, brief, credential_id, require_approval }) => {
      try {
        // Validate credential_id if provided
        if (credential_id != null) {
          const cred = await db.execute({
            sql: "SELECT id FROM campaigns_credentials WHERE id = ?",
            args: [credential_id],
          });
          if (cred.rows.length === 0) {
            return { content: [{ type: "text", text: `Error: Credential ID ${credential_id} not found` }], isError: true };
          }
        }

        const result = await db.execute({
          sql: `INSERT INTO campaigns_campaigns (name, description, brief, credential_id, require_approval)
                VALUES (?, ?, ?, ?, ?)`,
          args: [
            name,
            description || null,
            brief || null,
            credential_id ?? null,
            require_approval === false ? 0 : 1,
          ],
        });

        const campaign = await db.execute({
          sql: "SELECT * FROM campaigns_campaigns WHERE id = ?",
          args: [result.lastInsertRowid],
        });

        return { content: [{ type: "text", text: JSON.stringify(campaign.rows[0], null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_campaign_update ---
  server.tool(
    "crow_campaign_update",
    "Update a campaign's name, description, brief, status, credential, or approval setting.",
    {
      campaign_id: z.number().int().describe("Campaign ID"),
      name: z.string().min(1).max(200).optional().describe("New name"),
      description: z.string().max(2000).optional().describe("New description"),
      brief: z.string().max(5000).optional().describe("New campaign brief"),
      status: z.enum(["draft", "active", "paused", "completed", "archived"]).optional().describe("New status"),
      credential_id: z.number().int().optional().describe("New credential ID"),
      require_approval: z.boolean().optional().describe("Require approval before publishing"),
    },
    async ({ campaign_id, name, description, brief, status, credential_id, require_approval }) => {
      try {
        const existing = await db.execute({
          sql: "SELECT * FROM campaigns_campaigns WHERE id = ?",
          args: [campaign_id],
        });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Error: Campaign ID ${campaign_id} not found` }], isError: true };
        }

        // Validate credential_id if provided
        if (credential_id != null) {
          const cred = await db.execute({
            sql: "SELECT id FROM campaigns_credentials WHERE id = ?",
            args: [credential_id],
          });
          if (cred.rows.length === 0) {
            return { content: [{ type: "text", text: `Error: Credential ID ${credential_id} not found` }], isError: true };
          }
        }

        const updates = [];
        const args = [];

        if (name !== undefined) { updates.push("name = ?"); args.push(name); }
        if (description !== undefined) { updates.push("description = ?"); args.push(description); }
        if (brief !== undefined) { updates.push("brief = ?"); args.push(brief); }
        if (status !== undefined) { updates.push("status = ?"); args.push(status); }
        if (credential_id !== undefined) { updates.push("credential_id = ?"); args.push(credential_id); }
        if (require_approval !== undefined) { updates.push("require_approval = ?"); args.push(require_approval ? 1 : 0); }

        if (updates.length === 0) {
          return { content: [{ type: "text", text: "No fields to update" }], isError: true };
        }

        updates.push("updated_at = datetime('now')");
        args.push(campaign_id);

        await db.execute({
          sql: `UPDATE campaigns_campaigns SET ${updates.join(", ")} WHERE id = ?`,
          args,
        });

        const campaign = await db.execute({
          sql: "SELECT * FROM campaigns_campaigns WHERE id = ?",
          args: [campaign_id],
        });

        return { content: [{ type: "text", text: JSON.stringify(campaign.rows[0], null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_campaign_delete ---
  server.tool(
    "crow_campaign_delete",
    "Delete a campaign and all its posts. Requires confirmation.",
    {
      campaign_id: z.number().int().describe("Campaign ID"),
      confirm_token: z.string().optional().describe("Confirmation token from preview call"),
    },
    async ({ campaign_id, confirm_token }) => {
      try {
        const existing = await db.execute({
          sql: "SELECT * FROM campaigns_campaigns WHERE id = ?",
          args: [campaign_id],
        });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Error: Campaign ID ${campaign_id} not found` }], isError: true };
        }

        const campaign = existing.rows[0];

        // Count posts that would be deleted
        const postCount = await db.execute({
          sql: "SELECT COUNT(*) as count FROM campaigns_posts WHERE campaign_id = ?",
          args: [campaign_id],
        });

        if (!shouldSkipGates() && !confirm_token) {
          const token = generateToken("delete_campaign", campaign_id);
          return {
            content: [{
              type: "text",
              text: `DELETE campaign "${campaign.name}" (ID ${campaign_id})? This will also delete ${postCount.rows[0].count} post(s) and their history.\n\nCall again with confirm_token: "${token}" to proceed.`,
            }],
          };
        }
        if (confirm_token && !shouldSkipGates()) {
          if (!validateToken(confirm_token, "delete_campaign", campaign_id)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token." }], isError: true };
          }
        }

        await db.execute({
          sql: "DELETE FROM campaigns_campaigns WHERE id = ?",
          args: [campaign_id],
        });

        return {
          content: [{
            type: "text",
            text: `Deleted campaign "${campaign.name}" and ${postCount.rows[0].count} post(s).`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_campaign_list ---
  server.tool(
    "crow_campaign_list",
    "List campaigns with summary stats. Optionally filter by status.",
    {
      status: z.enum(["draft", "active", "paused", "completed", "archived"]).optional().describe("Filter by status"),
    },
    async ({ status }) => {
      try {
        let sql = `
          SELECT c.*,
            (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id) as total_posts,
            (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'draft') as draft_posts,
            (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'scheduled') as scheduled_posts,
            (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'pending_approval') as pending_posts,
            (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'published') as published_posts,
            (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'failed') as failed_posts
          FROM campaigns_campaigns c
        `;
        const args = [];

        if (status) {
          sql += " WHERE c.status = ?";
          args.push(status);
        }

        sql += " ORDER BY c.updated_at DESC";

        const result = await db.execute({ sql, args });
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ===================================================================
  // Credentials (1 tool)
  // ===================================================================

  // --- crow_campaign_set_credentials ---
  server.tool(
    "crow_campaign_set_credentials",
    "Store encrypted Reddit credentials. Validates connection before saving.",
    {
      platform: z.enum(["reddit"]).optional().describe("Platform (default: reddit)"),
      username: z.string().min(1).max(100).describe("Reddit username"),
      client_id: z.string().min(1).max(200).describe("Reddit app client ID"),
      client_secret: z.string().min(1).max(200).describe("Reddit app client secret"),
      password: z.string().min(1).max(200).describe("Reddit account password"),
    },
    async ({ platform, username, client_id, client_secret, password }) => {
      try {
        if (!ENCRYPTION_KEY) {
          return {
            content: [{ type: "text", text: "Error: CROW_CAMPAIGNS_ENCRYPTION_KEY not set in .env" }],
            isError: true,
          };
        }

        const platformName = platform || "reddit";

        // Validate credentials against the Reddit API
        let authResult;
        try {
          const client = createRedditClient({
            username, clientId: client_id, clientSecret: client_secret, password,
          });
          authResult = await testAuth(client);
        } catch (authErr) {
          return {
            content: [{ type: "text", text: `Credential validation failed: ${authErr.message}\n\nCredentials were NOT saved. Fix the issue and try again.` }],
            isError: true,
          };
        }

        // Encrypt credentials
        const clientIdEnc = encrypt(client_id, ENCRYPTION_KEY);
        const clientSecretEnc = encrypt(client_secret, ENCRYPTION_KEY);
        const passwordEnc = encrypt(password, ENCRYPTION_KEY);

        // Deactivate any existing credentials for this platform+username
        await db.execute({
          sql: "UPDATE campaigns_credentials SET is_active = 0, updated_at = datetime('now') WHERE platform = ? AND username = ? AND is_active = 1",
          args: [platformName, username],
        });

        // Insert new credentials
        const result = await db.execute({
          sql: `INSERT INTO campaigns_credentials (platform, username, client_id_enc, client_secret_enc, password_enc)
                VALUES (?, ?, ?, ?, ?)`,
          args: [platformName, username, clientIdEnc, clientSecretEnc, passwordEnc],
        });

        const credId = result.lastInsertRowid;

        return {
          content: [{
            type: "text",
            text: `Credentials validated and stored for ${platformName}:@${authResult.name} (ID: ${credId}).\nKarma: ${authResult.link_karma} link / ${authResult.comment_karma} comment\nCredentials are encrypted at rest with AES-256-GCM.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ===================================================================
  // Subreddit Intelligence (2 tools)
  // ===================================================================

  /**
   * Helper: get an authenticated Reddit client from a credential ID.
   */
  async function getRedditClientForCredential(credentialId) {
    if (!ENCRYPTION_KEY) throw new Error("CROW_CAMPAIGNS_ENCRYPTION_KEY not set in .env");

    const cred = await db.execute({
      sql: "SELECT * FROM campaigns_credentials WHERE id = ? AND is_active = 1",
      args: [credentialId],
    });
    if (cred.rows.length === 0) throw new Error(`Active credential ID ${credentialId} not found`);

    const row = cred.rows[0];
    return createRedditClient({
      username: row.username,
      clientId: decrypt(row.client_id_enc, ENCRYPTION_KEY),
      clientSecret: decrypt(row.client_secret_enc, ENCRYPTION_KEY),
      password: decrypt(row.password_enc, ENCRYPTION_KEY),
    });
  }

  // --- crow_campaign_crawl_subreddit ---
  server.tool(
    "crow_campaign_crawl_subreddit",
    "Crawl a subreddit's rules, flairs, and metadata via the Reddit API. Stores results in the DB.",
    {
      subreddit: z.string().min(1).max(100).describe("Subreddit name (no r/ prefix)"),
      credential_id: z.number().int().describe("Credential ID to authenticate with"),
    },
    async ({ subreddit, credential_id }) => {
      try {
        const client = await getRedditClientForCredential(credential_id);
        const result = await crawlSubreddit(db, client, subreddit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_campaign_get_subreddit ---
  server.tool(
    "crow_campaign_get_subreddit",
    "Retrieve cached subreddit intelligence from the DB (rules, flairs, timing, culture notes).",
    {
      subreddit: z.string().min(1).max(100).describe("Subreddit name (no r/ prefix)"),
    },
    async ({ subreddit }) => {
      try {
        const name = subreddit.replace(/^r\//, "").toLowerCase();
        const result = await db.execute({
          sql: "SELECT * FROM campaigns_subreddits WHERE LOWER(name) = ?",
          args: [name],
        });

        if (result.rows.length === 0) {
          return {
            content: [{ type: "text", text: `No cached data for r/${subreddit}. Use crow_campaign_crawl_subreddit to fetch it.` }],
            isError: true,
          };
        }

        const row = result.rows[0];
        // Parse JSON fields for readability
        const output = {
          ...row,
          rules: row.rules_json ? JSON.parse(row.rules_json) : [],
          flairs: row.flair_json ? JSON.parse(row.flair_json) : [],
        };
        delete output.rules_json;
        delete output.flair_json;

        return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ===================================================================
  // Post Management (3 tools)
  // ===================================================================

  // --- crow_campaign_draft_post ---
  server.tool(
    "crow_campaign_draft_post",
    "Create a draft post for a campaign targeting a specific subreddit.",
    {
      campaign_id: z.number().int().describe("Campaign ID"),
      subreddit_name: z.string().min(1).max(100).describe("Target subreddit (no r/ prefix)"),
      title: z.string().min(1).max(300).describe("Post title"),
      body: z.string().max(40000).describe("Post body (markdown) or URL for link posts"),
      post_type: z.enum(["text", "link"]).optional().describe("Post type (default: text)"),
      flair_id: z.string().max(100).optional().describe("Flair template ID"),
      flair_text: z.string().max(100).optional().describe("Flair text"),
    },
    async ({ campaign_id, subreddit_name, title, body, post_type, flair_id, flair_text }) => {
      try {
        // Verify campaign exists
        const campaign = await db.execute({
          sql: "SELECT id FROM campaigns_campaigns WHERE id = ?",
          args: [campaign_id],
        });
        if (campaign.rows.length === 0) {
          return { content: [{ type: "text", text: `Error: Campaign ID ${campaign_id} not found` }], isError: true };
        }

        const result = await db.execute({
          sql: `INSERT INTO campaigns_posts
                (campaign_id, subreddit_name, title, body, post_type, flair_id, flair_text)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            campaign_id,
            subreddit_name.replace(/^r\//, ""),
            title,
            body,
            post_type || "text",
            flair_id || null,
            flair_text || null,
          ],
        });

        // Record creation in history
        await db.execute({
          sql: `INSERT INTO campaigns_post_history (post_id, from_status, to_status, details)
                VALUES (?, NULL, 'draft', 'Post created')`,
          args: [result.lastInsertRowid],
        });

        const post = await db.execute({
          sql: "SELECT * FROM campaigns_posts WHERE id = ?",
          args: [result.lastInsertRowid],
        });

        return { content: [{ type: "text", text: JSON.stringify(post.rows[0], null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_campaign_update_post ---
  server.tool(
    "crow_campaign_update_post",
    "Update a post's title, body, flair, type, scheduled time, or status.",
    {
      post_id: z.number().int().describe("Post ID"),
      title: z.string().min(1).max(300).optional().describe("New title"),
      body: z.string().max(40000).optional().describe("New body"),
      post_type: z.enum(["text", "link"]).optional().describe("New post type"),
      flair_id: z.string().max(100).optional().describe("New flair ID"),
      flair_text: z.string().max(100).optional().describe("New flair text"),
      status: z.enum(["draft", "scheduled", "pending_approval", "approved"]).optional().describe("New status (only pre-publish statuses)"),
      scheduled_at: z.string().max(50).optional().describe("ISO 8601 scheduled time"),
    },
    async ({ post_id, title, body, post_type, flair_id, flair_text, status, scheduled_at }) => {
      try {
        const existing = await db.execute({
          sql: "SELECT * FROM campaigns_posts WHERE id = ?",
          args: [post_id],
        });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Error: Post ID ${post_id} not found` }], isError: true };
        }

        const oldPost = existing.rows[0];

        // Don't allow editing published posts
        if (oldPost.status === "published") {
          return { content: [{ type: "text", text: "Error: Cannot edit a published post" }], isError: true };
        }
        if (oldPost.status === "publishing") {
          return { content: [{ type: "text", text: "Error: Post is currently being published" }], isError: true };
        }

        const updates = [];
        const args = [];

        if (title !== undefined) { updates.push("title = ?"); args.push(title); }
        if (body !== undefined) { updates.push("body = ?"); args.push(body); }
        if (post_type !== undefined) { updates.push("post_type = ?"); args.push(post_type); }
        if (flair_id !== undefined) { updates.push("flair_id = ?"); args.push(flair_id); }
        if (flair_text !== undefined) { updates.push("flair_text = ?"); args.push(flair_text); }
        if (scheduled_at !== undefined) { updates.push("scheduled_at = ?"); args.push(scheduled_at); }

        if (status !== undefined && status !== oldPost.status) {
          updates.push("status = ?");
          args.push(status);
          // Record status change
          await db.execute({
            sql: `INSERT INTO campaigns_post_history (post_id, from_status, to_status, details)
                  VALUES (?, ?, ?, 'Manual status change')`,
            args: [post_id, oldPost.status, status],
          });
        }

        if (updates.length === 0) {
          return { content: [{ type: "text", text: "No fields to update" }], isError: true };
        }

        updates.push("updated_at = datetime('now')");
        args.push(post_id);

        await db.execute({
          sql: `UPDATE campaigns_posts SET ${updates.join(", ")} WHERE id = ?`,
          args,
        });

        const post = await db.execute({
          sql: "SELECT * FROM campaigns_posts WHERE id = ?",
          args: [post_id],
        });

        return { content: [{ type: "text", text: JSON.stringify(post.rows[0], null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_campaign_approve_posts ---
  server.tool(
    "crow_campaign_approve_posts",
    "Batch approve posts by ID. Moves them from pending_approval/draft to approved.",
    {
      post_ids: z.array(z.number().int()).min(1).max(50).describe("Array of post IDs to approve"),
    },
    async ({ post_ids }) => {
      try {
        const results = [];

        for (const postId of post_ids) {
          const existing = await db.execute({
            sql: "SELECT * FROM campaigns_posts WHERE id = ?",
            args: [postId],
          });

          if (existing.rows.length === 0) {
            results.push({ id: postId, status: "error", message: "Not found" });
            continue;
          }

          const post = existing.rows[0];

          if (post.status === "published" || post.status === "publishing") {
            results.push({ id: postId, status: "skipped", message: `Already ${post.status}` });
            continue;
          }

          if (post.status === "approved") {
            results.push({ id: postId, status: "skipped", message: "Already approved" });
            continue;
          }

          await db.execute({
            sql: "UPDATE campaigns_posts SET status = 'approved', updated_at = datetime('now') WHERE id = ?",
            args: [postId],
          });

          await db.execute({
            sql: `INSERT INTO campaigns_post_history (post_id, from_status, to_status, details)
                  VALUES (?, ?, 'approved', 'Batch approved')`,
            args: [postId, post.status],
          });

          results.push({ id: postId, status: "approved", subreddit: post.subreddit_name, title: post.title });
        }

        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ===================================================================
  // AI Drafting (1 tool)
  // ===================================================================

  // --- crow_campaign_generate_posts ---
  server.tool(
    "crow_campaign_generate_posts",
    "AI-generate tailored post drafts for a campaign across multiple subreddits. Uses the configured BYOAI provider and subreddit intelligence.",
    {
      campaign_id: z.number().int().describe("Campaign ID (must have a brief set)"),
      subreddits: z.array(z.string().min(1).max(100)).min(1).max(20).describe("Array of subreddit names (no r/ prefix)"),
    },
    async ({ campaign_id, subreddits }) => {
      try {
        // Verify campaign exists and has a brief
        const campaignResult = await db.execute({
          sql: "SELECT * FROM campaigns_campaigns WHERE id = ?",
          args: [campaign_id],
        });
        if (campaignResult.rows.length === 0) {
          return { content: [{ type: "text", text: `Error: Campaign ID ${campaign_id} not found` }], isError: true };
        }
        const campaign = campaignResult.rows[0];
        if (!campaign.brief) {
          return { content: [{ type: "text", text: "Error: Campaign has no brief set. Update the campaign with a brief before generating posts." }], isError: true };
        }

        // Check AI provider is configured
        if (!process.env.AI_PROVIDER) {
          return { content: [{ type: "text", text: "Error: No AI provider configured. Set AI_PROVIDER, AI_API_KEY, and AI_MODEL in .env or Settings." }], isError: true };
        }

        const results = [];

        for (const subName of subreddits) {
          const name = subName.replace(/^r\//, "").toLowerCase();

          // Get cached subreddit data (or create a minimal placeholder)
          const subResult = await db.execute({
            sql: "SELECT * FROM campaigns_subreddits WHERE LOWER(name) = ?",
            args: [name],
          });

          const subredditData = subResult.rows[0] || { name, subscribers: null, rules_json: null, flair_json: null, culture_notes: null, timing_rules: null };

          try {
            const draft = await generateDraft(campaign, subredditData);

            // Insert as draft post
            const insertResult = await db.execute({
              sql: `INSERT INTO campaigns_posts
                    (campaign_id, subreddit_name, title, body, post_type, flair_id, flair_text)
                    VALUES (?, ?, ?, ?, 'text', ?, ?)`,
              args: [
                campaign_id,
                subredditData.name || name,
                draft.title,
                draft.body,
                draft.flair_id || null,
                draft.flair_text || null,
              ],
            });

            await db.execute({
              sql: `INSERT INTO campaigns_post_history (post_id, from_status, to_status, details)
                    VALUES (?, NULL, 'draft', ?)`,
              args: [insertResult.lastInsertRowid, `AI-generated. Reasoning: ${draft.reasoning || "none"}`],
            });

            results.push({
              subreddit: name,
              status: "generated",
              post_id: Number(insertResult.lastInsertRowid),
              title: draft.title,
              reasoning: draft.reasoning,
            });
          } catch (genErr) {
            results.push({
              subreddit: name,
              status: "failed",
              error: genErr.message,
            });
          }
        }

        const succeeded = results.filter(r => r.status === "generated").length;
        const failed = results.filter(r => r.status === "failed").length;

        return {
          content: [{
            type: "text",
            text: `Generated ${succeeded} draft(s), ${failed} failed.\n\n${JSON.stringify(results, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ===================================================================
  // Publishing (2 tools)
  // ===================================================================

  // --- crow_campaign_publish_post ---
  server.tool(
    "crow_campaign_publish_post",
    "Immediately publish a single post to Reddit. Requires confirmation.",
    {
      post_id: z.number().int().describe("Post ID to publish"),
      confirm_token: z.string().optional().describe("Confirmation token from preview call"),
    },
    async ({ post_id, confirm_token }) => {
      try {
        if (!ENCRYPTION_KEY) {
          return { content: [{ type: "text", text: "Error: CROW_CAMPAIGNS_ENCRYPTION_KEY not set" }], isError: true };
        }

        const existing = await db.execute({
          sql: "SELECT p.*, c.name as campaign_name, c.credential_id FROM campaigns_posts p JOIN campaigns_campaigns c ON p.campaign_id = c.id WHERE p.id = ?",
          args: [post_id],
        });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Error: Post ID ${post_id} not found` }], isError: true };
        }

        const post = existing.rows[0];

        if (post.status === "published") {
          return { content: [{ type: "text", text: `Post already published: ${post.reddit_url}` }], isError: true };
        }
        if (post.status === "publishing") {
          return { content: [{ type: "text", text: "Post is currently being published" }], isError: true };
        }
        if (!post.credential_id) {
          return { content: [{ type: "text", text: "Error: Campaign has no credentials assigned" }], isError: true };
        }

        // Rate limit pre-check
        const rateCheck = await checkRateLimit(db, post.subreddit_name);
        if (!rateCheck.allowed) {
          return {
            content: [{ type: "text", text: `Rate limited on r/${post.subreddit_name}: wait ${rateCheck.waitSeconds}s (last post at ${rateCheck.lastPublishedAt})` }],
            isError: true,
          };
        }

        // Confirmation gate
        if (!shouldSkipGates() && !confirm_token) {
          const token = generateToken("publish_post", post_id);
          return {
            content: [{
              type: "text",
              text: `Publish "${post.title}" to r/${post.subreddit_name} NOW?\n\nCampaign: ${post.campaign_name}\nType: ${post.post_type}\nBody preview: ${(post.body || "").substring(0, 200)}...\n\nCall again with confirm_token: "${token}" to proceed.`,
            }],
          };
        }
        if (confirm_token && !shouldSkipGates()) {
          if (!validateToken(confirm_token, "publish_post", post_id)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token." }], isError: true };
          }
        }

        // Get full campaign row for publisher
        const campaignResult = await db.execute({
          sql: "SELECT * FROM campaigns_campaigns WHERE id = ?",
          args: [post.campaign_id],
        });

        const result = await publishPost(db, post, campaignResult.rows[0], ENCRYPTION_KEY);

        if (result.success) {
          return {
            content: [{ type: "text", text: `Published to r/${post.subreddit_name}: ${result.redditUrl}` }],
          };
        } else {
          return {
            content: [{ type: "text", text: `Failed to publish: ${result.error}` }],
            isError: true,
          };
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_campaign_schedule_post ---
  server.tool(
    "crow_campaign_schedule_post",
    "Schedule a post for future publishing. Sets scheduled_at and moves to appropriate status.",
    {
      post_id: z.number().int().describe("Post ID"),
      scheduled_at: z.string().min(1).max(50).describe("ISO 8601 datetime for publishing (e.g., 2026-04-10T14:00:00Z)"),
    },
    async ({ post_id, scheduled_at }) => {
      try {
        const existing = await db.execute({
          sql: "SELECT p.*, c.require_approval FROM campaigns_posts p JOIN campaigns_campaigns c ON p.campaign_id = c.id WHERE p.id = ?",
          args: [post_id],
        });
        if (existing.rows.length === 0) {
          return { content: [{ type: "text", text: `Error: Post ID ${post_id} not found` }], isError: true };
        }

        const post = existing.rows[0];

        if (post.status === "published") {
          return { content: [{ type: "text", text: "Error: Cannot schedule an already-published post" }], isError: true };
        }
        if (post.status === "publishing") {
          return { content: [{ type: "text", text: "Error: Post is currently being published" }], isError: true };
        }

        // Validate the date
        const schedDate = new Date(scheduled_at);
        if (isNaN(schedDate.getTime())) {
          return { content: [{ type: "text", text: `Error: Invalid date format: ${scheduled_at}` }], isError: true };
        }

        // Determine target status based on campaign's approval setting
        const newStatus = post.require_approval ? "pending_approval" : "approved";

        await db.execute({
          sql: "UPDATE campaigns_posts SET scheduled_at = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
          args: [schedDate.toISOString(), newStatus, post_id],
        });

        await db.execute({
          sql: `INSERT INTO campaigns_post_history (post_id, from_status, to_status, details)
                VALUES (?, ?, ?, ?)`,
          args: [post_id, post.status, newStatus, `Scheduled for ${schedDate.toISOString()}`],
        });

        const updated = await db.execute({
          sql: "SELECT * FROM campaigns_posts WHERE id = ?",
          args: [post_id],
        });

        const statusNote = post.require_approval
          ? "Post is pending approval. Approve it to enable scheduled publishing."
          : "Post is approved and will publish at the scheduled time.";

        return {
          content: [{
            type: "text",
            text: `Scheduled for ${schedDate.toISOString()}. ${statusNote}\n\n${JSON.stringify(updated.rows[0], null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}
