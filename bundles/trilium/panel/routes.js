/**
 * TriliumNext API Routes — Express router for Crow's Nest TriliumNext panel
 *
 * Bundle-compatible version: uses env vars directly for ETAPI calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * TriliumNext instance for the dashboard panel.
 */

import { Router } from "express";

const TRILIUM_URL = () => (process.env.TRILIUM_URL || "http://localhost:8088").replace(/\/+$/, "");
const TRILIUM_TOKEN = () => process.env.TRILIUM_ETAPI_TOKEN || "";

/**
 * Fetch from TriliumNext ETAPI with auth and timeout.
 */
async function etapiFetch(path, options = {}) {
  const url = `${TRILIUM_URL()}/etapi/${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: TRILIUM_TOKEN(),
        ...options.headers,
      },
    });
    if (!res.ok) throw new Error(`ETAPI ${res.status}: ${res.statusText}`);

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return await res.json();
    }
    return await res.text();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("TriliumNext request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach TriliumNext — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function triliumRouter(authMiddleware) {
  const router = Router();

  // --- Search Notes ---
  router.get("/api/trilium/search", authMiddleware, async (req, res) => {
    try {
      const q = req.query.q || "";
      if (!q) return res.json({ notes: [] });

      const params = new URLSearchParams({
        search: q,
        limit: "20",
      });

      const data = await etapiFetch(`notes?${params}`);
      const notes = (data.results || []).map((note) => ({
        noteId: note.noteId,
        title: note.title,
        type: note.type,
        dateModified: note.dateModified || null,
      }));

      res.json({ notes });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Get Note Content ---
  router.get("/api/trilium/note/:id", authMiddleware, async (req, res) => {
    try {
      const id = encodeURIComponent(req.params.id);
      const [note, content] = await Promise.all([
        etapiFetch(`notes/${id}`),
        etapiFetch(`notes/${id}/content`),
      ]);

      res.json({
        noteId: note.noteId,
        title: note.title,
        type: note.type,
        content: typeof content === "string" ? content : JSON.stringify(content),
        dateModified: note.dateModified || null,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Notes ---
  router.get("/api/trilium/recent", authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams({
        search: "note.noteId != 'root'",
        limit: "15",
        orderBy: "dateModified",
        orderDirection: "desc",
      });

      const data = await etapiFetch(`notes?${params}`);
      const notes = (data.results || []).map((note) => ({
        noteId: note.noteId,
        title: note.title,
        type: note.type,
        dateModified: note.dateModified || null,
      }));

      res.json({ notes });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Web Clip ---
  router.post("/api/trilium/clip", authMiddleware, async (req, res) => {
    try {
      const { url, parent_note_id, title } = req.body || {};
      if (!url) return res.json({ error: "URL is required" });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      let html;
      try {
        const fetchRes = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Crow/1.0 (Web Clipper)" },
        });
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
        html = await fetchRes.text();
      } finally {
        clearTimeout(timeout);
      }

      // Extract title
      let noteTitle = title;
      if (!noteTitle) {
        const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        noteTitle = match ? match[1].replace(/\s+/g, " ").trim() : url;
      }

      // Strip tags
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const noteContent = `<p><strong>Source:</strong> <a href="${url}">${url}</a></p><hr/><p>${text.slice(0, 45000)}</p>`;

      const result = await etapiFetch("create-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentNoteId: parent_note_id || "root",
          title: noteTitle,
          content: noteContent,
          type: "text",
        }),
      });

      res.json({
        noteId: result.note?.noteId,
        title: noteTitle,
        sourceUrl: url,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
