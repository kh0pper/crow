/**
 * Gitea panel routes — backs the dashboard panel via authenticated GETs.
 */

import { Router } from "express";

const GITEA_URL = () => (process.env.GITEA_URL || "http://localhost:3040").replace(/\/+$/, "");
const GITEA_TOKEN = () => process.env.GITEA_TOKEN || "";

async function gtFetch(path) {
  const url = `${GITEA_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const token = GITEA_TOKEN();
    const headers = {};
    if (token) headers["Authorization"] = `token ${token}`;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`Gitea ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Gitea request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Gitea — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export default function giteaRouter(authMiddleware) {
  const router = Router();

  router.get("/api/gitea/stats", authMiddleware, async (req, res) => {
    try {
      const data = await gtFetch(`/api/v1/repos/search?limit=1&uid=0`);
      const total = data && typeof data.data !== "undefined"
        ? (Array.isArray(data.data) ? (data.data.length) : 0)
        : 0;
      // Gitea puts the total count in an X-Total-Count header; fall back to best-effort
      res.json({
        url: GITEA_URL(),
        reachable: true,
        has_token: !!GITEA_TOKEN(),
        visible_repo_count_hint: total,
      });
    } catch (err) {
      res.json({ url: GITEA_URL(), reachable: false, error: err.message });
    }
  });

  router.get("/api/gitea/repos", authMiddleware, async (req, res) => {
    try {
      const data = await gtFetch(`/api/v1/repos/search?limit=20&uid=0&sort=updated&order=desc`);
      const repos = (Array.isArray(data?.data) ? data.data : []).map((r) => ({
        full_name: r.full_name,
        private: !!r.private,
        fork: !!r.fork,
        description: r.description ? r.description.slice(0, 200) : null,
        stars: r.stars_count || 0,
        open_issues: r.open_issues_count || 0,
        updated_at: r.updated_at || null,
        html_url: r.html_url || null,
      }));
      res.json({ repos });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
