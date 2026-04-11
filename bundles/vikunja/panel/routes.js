/**
 * Vikunja API Routes — Express router for Crow's Nest Vikunja panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Vikunja instance for the dashboard panel.
 */

import { Router } from "express";

const VIKUNJA_URL = () => (process.env.VIKUNJA_URL || "http://localhost:3456").replace(/\/+$/, "");
const VIKUNJA_API_TOKEN = () => process.env.VIKUNJA_API_TOKEN || "";

/**
 * Fetch from Vikunja API with auth and timeout.
 */
async function vkFetch(path) {
  const url = `${VIKUNJA_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Authorization": `Bearer ${VIKUNJA_API_TOKEN()}` },
    });
    if (!res.ok) throw new Error(`Vikunja ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Vikunja request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Vikunja — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format an ISO date to short form.
 */
function formatDate(dateStr) {
  if (!dateStr || dateStr === "0001-01-01T00:00:00Z") return null;
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

/**
 * Map Vikunja priority number to label.
 */
function priorityLabel(p) {
  const labels = { 0: "unset", 1: "low", 2: "medium", 3: "high", 4: "urgent", 5: "do now" };
  return labels[p] || String(p);
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function vikunjaRouter(authMiddleware) {
  const router = Router();

  // --- Task Stats ---
  router.get("/api/vikunja/stats", authMiddleware, async (req, res) => {
    try {
      const projects = await vkFetch("/api/v1/projects");
      const projectList = Array.isArray(projects) ? projects : [];

      let open = 0;
      let done = 0;
      let overdue = 0;
      const now = new Date();

      for (const project of projectList) {
        try {
          const tasks = await vkFetch(`/api/v1/projects/${project.id}/tasks?per_page=200`);
          const taskList = Array.isArray(tasks) ? tasks : [];
          for (const t of taskList) {
            if (t.done) {
              done++;
            } else {
              open++;
              if (t.due_date && t.due_date !== "0001-01-01T00:00:00Z" && new Date(t.due_date) < now) {
                overdue++;
              }
            }
          }
        } catch {
          // Skip projects we can't access
        }
      }

      res.json({
        projects: projectList.length,
        open,
        done,
        overdue,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Overdue Tasks ---
  router.get("/api/vikunja/overdue", authMiddleware, async (req, res) => {
    try {
      const projects = await vkFetch("/api/v1/projects");
      const projectList = Array.isArray(projects) ? projects : [];
      const projectMap = {};
      for (const p of projectList) projectMap[p.id] = p.title;

      const overdueTasks = [];
      const now = new Date();

      for (const project of projectList) {
        try {
          const tasks = await vkFetch(`/api/v1/projects/${project.id}/tasks?per_page=200`);
          const taskList = Array.isArray(tasks) ? tasks : [];
          for (const t of taskList) {
            if (!t.done && t.due_date && t.due_date !== "0001-01-01T00:00:00Z" && new Date(t.due_date) < now) {
              overdueTasks.push({
                id: t.id,
                title: t.title,
                done: false,
                priority: priorityLabel(t.priority),
                due_date: formatDate(t.due_date),
                project: projectMap[t.project_id] || null,
                labels: t.labels?.map((l) => l.title) || [],
              });
            }
          }
        } catch {
          // Skip
        }
      }

      overdueTasks.sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""));

      res.json({ tasks: overdueTasks.slice(0, 20) });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Tasks ---
  router.get("/api/vikunja/recent", authMiddleware, async (req, res) => {
    try {
      const projects = await vkFetch("/api/v1/projects");
      const projectList = Array.isArray(projects) ? projects : [];
      const projectMap = {};
      for (const p of projectList) projectMap[p.id] = p.title;

      const allTasks = [];

      for (const project of projectList) {
        try {
          const tasks = await vkFetch(`/api/v1/projects/${project.id}/tasks?sort_by=updated&order_by=desc&per_page=10`);
          const taskList = Array.isArray(tasks) ? tasks : [];
          for (const t of taskList) {
            allTasks.push({
              id: t.id,
              title: t.title,
              done: t.done || false,
              priority: priorityLabel(t.priority),
              due_date: formatDate(t.due_date),
              project: projectMap[t.project_id] || null,
              labels: t.labels?.map((l) => l.title) || [],
              updated: t.updated,
            });
          }
        } catch {
          // Skip
        }
      }

      allTasks.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));

      res.json({ tasks: allTasks.slice(0, 20) });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
