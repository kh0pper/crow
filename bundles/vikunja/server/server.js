/**
 * Vikunja MCP Server
 *
 * Provides tools to manage a Vikunja task manager via REST API:
 * - List and create projects
 * - List, create, update, and delete tasks
 * - Get task details with labels and assignees
 * - List labels
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const VIKUNJA_URL = (process.env.VIKUNJA_URL || "http://localhost:3456").replace(/\/+$/, "");
const VIKUNJA_API_TOKEN = process.env.VIKUNJA_API_TOKEN || "";

/**
 * Make an authenticated request to the Vikunja API.
 * @param {string} path - API path (e.g., "/api/v1/projects")
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function vikunjaFetch(path, options = {}) {
  const url = `${VIKUNJA_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${VIKUNJA_API_TOKEN}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Authentication failed — check VIKUNJA_API_TOKEN");
      if (res.status === 403) throw new Error("Permission denied — the API token lacks access to this resource");
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Vikunja API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Vikunja request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Vikunja at ${VIKUNJA_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format an ISO date string to a short human-readable form.
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

export function createVikunjaServer(options = {}) {
  const server = new McpServer(
    { name: "crow-vikunja", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_vikunja_projects ---
  server.tool(
    "crow_vikunja_projects",
    "List all Vikunja projects",
    {},
    async () => {
      try {
        const data = await vikunjaFetch("/api/v1/projects");
        const projects = (Array.isArray(data) ? data : []).map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description ? p.description.slice(0, 200) : null,
          is_archived: p.is_archived || false,
          created: formatDate(p.created),
          updated: formatDate(p.updated),
        }));

        return {
          content: [{
            type: "text",
            text: projects.length > 0
              ? `${projects.length} project(s):\n${JSON.stringify(projects, null, 2)}`
              : "No projects found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_vikunja_tasks ---
  server.tool(
    "crow_vikunja_tasks",
    "List tasks in a Vikunja project with optional filters",
    {
      project_id: z.number().describe("Project ID"),
      done: z.boolean().optional().describe("Filter by completion status"),
      priority: z.number().min(0).max(5).optional().describe("Filter by priority (0=unset, 1=low, 5=do now)"),
      sort_by: z.enum(["done", "priority", "due_date", "created", "updated"]).optional().default("done").describe("Sort field"),
      page: z.number().min(1).optional().default(1).describe("Page number (default 1)"),
      per_page: z.number().min(1).max(200).optional().default(50).describe("Tasks per page (default 50)"),
    },
    async ({ project_id, done, priority, sort_by, page, per_page }) => {
      try {
        const params = new URLSearchParams({
          sort_by,
          order_by: "asc",
          page: String(page),
          per_page: String(per_page),
        });
        if (done !== undefined) {
          params.set("filter", `done = ${done}`);
        }

        const data = await vikunjaFetch(`/api/v1/projects/${project_id}/tasks?${params}`);
        let tasks = (Array.isArray(data) ? data : []).map((t) => ({
          id: t.id,
          title: t.title,
          done: t.done || false,
          priority: priorityLabel(t.priority),
          due_date: formatDate(t.due_date),
          labels: t.labels?.map((l) => l.title) || [],
          created: formatDate(t.created),
        }));

        if (priority !== undefined) {
          tasks = tasks.filter((t) => t.priority === priorityLabel(priority));
        }

        return {
          content: [{
            type: "text",
            text: tasks.length > 0
              ? `${tasks.length} task(s) (page ${page}):\n${JSON.stringify(tasks, null, 2)}`
              : "No tasks found matching the criteria.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_vikunja_get_task ---
  server.tool(
    "crow_vikunja_get_task",
    "Get detailed information about a specific Vikunja task",
    {
      id: z.number().describe("Task ID"),
    },
    async ({ id }) => {
      try {
        const task = await vikunjaFetch(`/api/v1/tasks/${id}`);

        const result = {
          id: task.id,
          title: task.title,
          description: task.description || null,
          done: task.done || false,
          priority: priorityLabel(task.priority),
          due_date: formatDate(task.due_date),
          start_date: formatDate(task.start_date),
          end_date: formatDate(task.end_date),
          percent_done: task.percent_done || 0,
          repeat_after: task.repeat_after || 0,
          project_id: task.project_id,
          labels: task.labels?.map((l) => ({ id: l.id, title: l.title, color: l.hex_color })) || [],
          assignees: task.assignees?.map((a) => ({ id: a.id, username: a.username, name: a.name })) || [],
          created: formatDate(task.created),
          updated: formatDate(task.updated),
          created_by: task.created_by?.username || null,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_vikunja_create_task ---
  server.tool(
    "crow_vikunja_create_task",
    "Create a new task in a Vikunja project",
    {
      project_id: z.number().describe("Project ID to create the task in"),
      title: z.string().max(500).describe("Task title"),
      description: z.string().max(50000).optional().describe("Task description (markdown)"),
      priority: z.number().min(0).max(5).optional().describe("Priority (0=unset, 1=low, 2=medium, 3=high, 4=urgent, 5=do now)"),
      due_date: z.string().max(100).optional().describe("Due date in ISO 8601 format (e.g., 2026-04-15T17:00:00Z)"),
    },
    async ({ project_id, title, description, priority, due_date }) => {
      try {
        const body = { title };
        if (description) body.description = description;
        if (priority !== undefined) body.priority = priority;
        if (due_date) body.due_date = due_date;

        const task = await vikunjaFetch(`/api/v1/projects/${project_id}/tasks`, {
          method: "PUT",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Task created:\n${JSON.stringify({
              id: task.id,
              title: task.title,
              project_id: task.project_id,
              priority: priorityLabel(task.priority),
              due_date: formatDate(task.due_date),
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_vikunja_update_task ---
  server.tool(
    "crow_vikunja_update_task",
    "Update an existing Vikunja task (title, description, done, priority, due date)",
    {
      id: z.number().describe("Task ID"),
      title: z.string().max(500).optional().describe("New task title"),
      description: z.string().max(50000).optional().describe("New description"),
      done: z.boolean().optional().describe("Mark as done or not done"),
      priority: z.number().min(0).max(5).optional().describe("New priority (0-5)"),
      due_date: z.string().max(100).optional().describe("New due date in ISO 8601 format, or empty string to clear"),
    },
    async ({ id, title, description, done, priority, due_date }) => {
      try {
        const body = {};
        if (title !== undefined) body.title = title;
        if (description !== undefined) body.description = description;
        if (done !== undefined) body.done = done;
        if (priority !== undefined) body.priority = priority;
        if (due_date !== undefined) body.due_date = due_date || null;

        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text", text: "Error: Provide at least one field to update" }] };
        }

        const task = await vikunjaFetch(`/api/v1/tasks/${id}`, {
          method: "POST",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Task updated:\n${JSON.stringify({
              id: task.id,
              title: task.title,
              done: task.done,
              priority: priorityLabel(task.priority),
              due_date: formatDate(task.due_date),
              updated: formatDate(task.updated),
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_vikunja_labels ---
  server.tool(
    "crow_vikunja_labels",
    "List all available labels in Vikunja",
    {},
    async () => {
      try {
        const data = await vikunjaFetch("/api/v1/labels");
        const labels = (Array.isArray(data) ? data : []).map((l) => ({
          id: l.id,
          title: l.title,
          color: l.hex_color || null,
          description: l.description ? l.description.slice(0, 200) : null,
          created_by: l.created_by?.username || null,
        }));

        return {
          content: [{
            type: "text",
            text: labels.length > 0
              ? `${labels.length} label(s):\n${JSON.stringify(labels, null, 2)}`
              : "No labels found.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_vikunja_create_project ---
  server.tool(
    "crow_vikunja_create_project",
    "Create a new Vikunja project",
    {
      title: z.string().max(500).describe("Project title"),
      description: z.string().max(5000).optional().describe("Project description"),
    },
    async ({ title, description }) => {
      try {
        const body = { title };
        if (description) body.description = description;

        const project = await vikunjaFetch("/api/v1/projects", {
          method: "PUT",
          body: JSON.stringify(body),
        });

        return {
          content: [{
            type: "text",
            text: `Project created:\n${JSON.stringify({
              id: project.id,
              title: project.title,
              created: formatDate(project.created),
            }, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_vikunja_delete_task ---
  server.tool(
    "crow_vikunja_delete_task",
    "Delete a task from Vikunja (irreversible)",
    {
      id: z.number().describe("Task ID to delete"),
      confirm: z.literal("yes").describe('Must be "yes" to confirm deletion'),
    },
    async ({ id }) => {
      try {
        await vikunjaFetch(`/api/v1/tasks/${id}`, { method: "DELETE" });

        return {
          content: [{
            type: "text",
            text: `Task ${id} deleted successfully.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
