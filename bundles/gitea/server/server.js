/**
 * Gitea MCP Server
 *
 * Tools to manage a self-hosted Gitea instance via the v1 REST API:
 *   - gitea_list_repos        List repos the token owner has access to
 *   - gitea_repo_info         Details for a single repo
 *   - gitea_create_repo       Create a new repo under the token owner
 *   - gitea_list_issues       List issues in a repo
 *   - gitea_create_issue      Open a new issue
 *
 * Auth: personal access token (Settings > Applications). Token requires
 * the "repo" and "issue" scopes for write operations.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const GITEA_URL = () => (process.env.GITEA_URL || "http://localhost:3040").replace(/\/+$/, "");
const GITEA_TOKEN = () => process.env.GITEA_TOKEN || "";

async function giteaFetch(path, options = {}) {
  const url = `${GITEA_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const token = GITEA_TOKEN();
    const headers = { "Content-Type": "application/json", ...options.headers };
    if (token) headers["Authorization"] = `token ${token}`;

    const res = await fetch(url, { ...options, signal: controller.signal, headers });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check GITEA_TOKEN");
      if (res.status === 403) throw new Error("Permission denied — token lacks required scope");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      const body = await res.text().catch(() => "");
      throw new Error(`Gitea API error: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Gitea request timed out after 10s: ${path}`);
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Gitea at ${GITEA_URL()} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function repoSummary(r) {
  return {
    id: r.id,
    full_name: r.full_name,
    name: r.name,
    owner: r.owner?.login || null,
    private: !!r.private,
    fork: !!r.fork,
    description: r.description ? r.description.slice(0, 300) : null,
    default_branch: r.default_branch || null,
    stars: r.stars_count || 0,
    forks: r.forks_count || 0,
    open_issues: r.open_issues_count || 0,
    html_url: r.html_url || null,
    ssh_url: r.ssh_url || null,
    clone_url: r.clone_url || null,
    updated_at: r.updated_at || null,
  };
}

function issueSummary(i) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    user: i.user?.login || null,
    labels: (i.labels || []).map((l) => l.name),
    assignees: (i.assignees || []).map((a) => a.login),
    comments: i.comments || 0,
    created_at: i.created_at,
    updated_at: i.updated_at,
    html_url: i.html_url || null,
  };
}

export function createGiteaServer(options = {}) {
  const server = new McpServer(
    { name: "crow-gitea", version: "1.0.0" },
    { instructions: options.instructions },
  );

  server.tool(
    "gitea_list_repos",
    "List repositories the current token owner can access (paginated)",
    {
      page: z.number().min(1).optional().default(1).describe("Page number (default 1)"),
      per_page: z.number().min(1).max(50).optional().default(20).describe("Results per page (max 50)"),
      query: z.string().max(200).optional().describe("Optional search query to filter by name"),
    },
    async ({ page, per_page, query }) => {
      try {
        const params = new URLSearchParams({ page: String(page), limit: String(per_page) });
        const path = query
          ? `/api/v1/repos/search?${params}&q=${encodeURIComponent(query)}`
          : `/api/v1/repos/search?${params}&uid=0`;
        const data = await giteaFetch(path);
        const repos = (Array.isArray(data?.data) ? data.data : []).map(repoSummary);
        return {
          content: [{
            type: "text",
            text: repos.length
              ? `${repos.length} repo(s):\n${JSON.stringify(repos, null, 2)}`
              : "No repositories found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "gitea_repo_info",
    "Get detailed info for one repository",
    {
      owner: z.string().max(100).describe("Repo owner (user or org)"),
      repo: z.string().max(100).describe("Repo name"),
    },
    async ({ owner, repo }) => {
      try {
        const data = await giteaFetch(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
        return { content: [{ type: "text", text: JSON.stringify(repoSummary(data), null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "gitea_create_repo",
    "Create a new repository owned by the token user",
    {
      name: z.string().max(100).describe("Repo name"),
      description: z.string().max(1000).optional().describe("Repo description"),
      private: z.boolean().optional().default(false).describe("Create as private (default false)"),
      auto_init: z.boolean().optional().default(true).describe("Initialize with README (default true)"),
      default_branch: z.string().max(100).optional().default("main").describe("Default branch (default 'main')"),
    },
    async ({ name, description, private: isPrivate, auto_init, default_branch }) => {
      try {
        const body = { name, description, private: isPrivate, auto_init, default_branch };
        const data = await giteaFetch(`/api/v1/user/repos`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [{
            type: "text",
            text: `Repository created:\n${JSON.stringify(repoSummary(data), null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "gitea_list_issues",
    "List issues in a repository",
    {
      owner: z.string().max(100).describe("Repo owner"),
      repo: z.string().max(100).describe("Repo name"),
      state: z.enum(["open", "closed", "all"]).optional().default("open"),
      page: z.number().min(1).optional().default(1),
      per_page: z.number().min(1).max(50).optional().default(20),
    },
    async ({ owner, repo, state, page, per_page }) => {
      try {
        const params = new URLSearchParams({ state, page: String(page), limit: String(per_page), type: "issues" });
        const data = await giteaFetch(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`);
        const issues = (Array.isArray(data) ? data : []).map(issueSummary);
        return {
          content: [{
            type: "text",
            text: issues.length
              ? `${issues.length} issue(s):\n${JSON.stringify(issues, null, 2)}`
              : "No issues found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "gitea_create_issue",
    "Open a new issue in a repository",
    {
      owner: z.string().max(100).describe("Repo owner"),
      repo: z.string().max(100).describe("Repo name"),
      title: z.string().max(500).describe("Issue title"),
      body: z.string().max(50000).optional().describe("Issue body (markdown)"),
    },
    async ({ owner, repo, title, body }) => {
      try {
        const payload = { title };
        if (body) payload.body = body;
        const data = await giteaFetch(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        return {
          content: [{
            type: "text",
            text: `Issue opened:\n${JSON.stringify(issueSummary(data), null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}
