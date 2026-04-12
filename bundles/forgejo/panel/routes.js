/**
 * Forgejo panel routes — mirrors the Gitea bundle structure since the v1
 * REST API is compatible.
 */

import { Router } from "express";

const FORGEJO_URL = () => (process.env.FORGEJO_URL || "http://localhost:3050").replace(/\/+$/, "");
const FORGEJO_TOKEN = () => process.env.FORGEJO_TOKEN || "";

async function fjFetch(path) {
  const url = `${FORGEJO_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const token = FORGEJO_TOKEN();
    const headers = {};
    if (token) headers["Authorization"] = `token ${token}`;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`Forgejo ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Forgejo request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Forgejo — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export default function forgejoRouter(authMiddleware) {
  const router = Router();

  router.get("/api/forgejo/stats", authMiddleware, async (req, res) => {
    try {
      const data = await fjFetch(`/api/v1/repos/search?limit=1&uid=0`);
      const total = Array.isArray(data?.data) ? data.data.length : 0;
      res.json({
        url: FORGEJO_URL(),
        reachable: true,
        has_token: !!FORGEJO_TOKEN(),
        visible_repo_count_hint: total,
      });
    } catch (err) {
      res.json({ url: FORGEJO_URL(), reachable: false, error: err.message });
    }
  });

  router.get("/api/forgejo/repos", authMiddleware, async (req, res) => {
    try {
      const data = await fjFetch(`/api/v1/repos/search?limit=20&uid=0&sort=updated&order=desc`);
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
