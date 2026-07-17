/**
 * PM Workspace — panel companion routes.
 *
 * IMPORTANT: this file is COPIED to $CROW_HOME/panels/pm-workspace-routes.js
 * at install time, so it must not use relative imports into the bundle.
 * Bundle server modules are resolved from
 * $CROW_HOME/bundles/pm-workspace and dynamically imported in try/catch
 * (same pattern as the knowledge-base bundle's panel/routes.js).
 *
 * Auth: the panel registry calls this factory with the gateway's
 * dashboardAuth middleware. Everything is PATH-SCOPED (never a bare
 * router.use(mw)) so this router can't intercept traffic destined for
 * later-mounted panels (STRICT_PANEL_MOUNT contract).
 *
 * Large-body note: the gateway's global JSON parser is capped at 1mb,
 * which a drawing note's PNG data URL can exceed. The editors therefore
 * POST saves as text/plain (JSON string body); a route-scoped text
 * parser (25mb) reads it here, and handlers accept either an
 * already-parsed object (small application/json requests) or a raw
 * string.
 */

import { Router } from "express";
import express from "express";
import { join, resolve, normalize } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BUNDLE_DIR = join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "pm-workspace");

async function importBundleModule(rel) {
  try {
    return await import(pathToFileURL(join(BUNDLE_DIR, rel)).href);
  } catch (err) {
    console.warn(`[pm-workspace routes] failed to import ${rel}: ${err.message}`);
    return null;
  }
}

function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default function pmWorkspaceRouter(dashboardAuth) {
  const router = Router();

  let mods = null;
  let db = null;

  async function ensureLoaded(res) {
    if (!mods) {
      const [dbMod, notesMod, ocrMod, memMod, configMod, digestMod, syncMod] = await Promise.all([
        importBundleModule("server/db.js"),
        importBundleModule("server/notes.js"),
        importBundleModule("server/ocr.js"),
        importBundleModule("server/memory-index.js"),
        importBundleModule("server/config.js"),
        importBundleModule("server/digest/index.js"),
        importBundleModule("server/sync/monday.js"),
      ]);
      if (!dbMod || !notesMod || !configMod) {
        res.status(500).json({ error: "pm-workspace bundle modules not available" });
        return false;
      }
      mods = { dbMod, notesMod, ocrMod, memMod, configMod, digestMod, syncMod };
    }
    if (!db) db = mods.dbMod.createDbClient();
    return true;
  }

  // ── Auth + parsers: path-scoped only ──
  if (typeof dashboardAuth === "function") {
    router.use("/pm", dashboardAuth);
    router.use("/api/pm", dashboardAuth);
  }
  // Accept large text/plain JSON payloads on the API (see header comment).
  router.use("/api/pm", express.text({ type: ["text/plain", "text/*"], limit: "25mb" }));

  // ── Static assets (bundle panel/static) ──
  router.get("/pm/static/:file", (req, res) => {
    const staticDir = resolve(join(BUNDLE_DIR, "panel", "static"));
    const target = resolve(normalize(join(staticDir, req.params.file)));
    if (!target.startsWith(staticDir + "/") && target !== staticDir) {
      return res.status(400).send("Bad path");
    }
    if (!existsSync(target)) return res.status(404).send("Not found");
    res.sendFile(target);
  });

  // ── Editor pages ──

  function editorPage({ note, kind }) {
    const noteData = JSON.stringify({
      id: note?.id ?? null,
      title: note?.title ?? "",
      kind,
      content_md: note?.content_md ?? "",
      strokes_json: note?.strokes_json ?? null,
      tags: note?.tags ? String(note.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
      ocr_status: note?.ocr_status ?? "n/a",
    }).replace(/</g, "\\u003c");

    const isDrawing = kind === "drawing";
    const title = escapeHtml(note?.title || (isDrawing ? "New Drawing Note" : "New Markdown Note"));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>${title} — PM Workspace</title>
<link rel="stylesheet" href="/pm/static/pm.css">
${isDrawing ? `<script type="importmap">
{
  "imports": { "perfect-freehand": "https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.2/dist/esm/index.mjs" },
  "integrity": { "https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.2/dist/esm/index.mjs": "sha384-5l3A2yfUaPsFT9OELkOpJOX0+bzd81Hi6euWa2tIwITOu+z8k9dMuxvIu78wYkxL" }
}
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js" integrity="sha384-sLpuECXYCB5TUyTbC06pftm/rgurDambREZmV4eRHwEqJzCQtU6lxI2Ve00z4XW5" crossorigin="anonymous"></script>` : `<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js" integrity="sha384-/TQbtLCAerC3jgaim+N78RZSDYV7ryeoBCVqTuzRrFec2akfBkHS7ACQ3PQhvMVi" crossorigin="anonymous"></script>`}
</head>
<body>
<div class="editor-page" id="editor-page">
  <div class="editor-toolbar">
    <div class="toolbar-left">
      <a href="/dashboard/pm-workspace?view=notes" class="btn-back" title="Back to notes">&larr;</a>
      <input type="text" class="note-title-input" id="note-title" placeholder="Untitled Note">
    </div>
    <div class="toolbar-center">
      <div class="tag-chips" id="tag-chips">
        <button class="tag-add-btn" id="btn-add-tag" title="Add tag" type="button">+</button>
      </div>
    </div>
    <div class="toolbar-right">
      ${isDrawing ? `
      <button class="tool-btn topbar-action" id="btn-undo" title="Undo (Ctrl+Z)" disabled>&#8630;</button>
      <button class="tool-btn topbar-action" id="btn-redo" title="Redo (Ctrl+Shift+Z)" disabled>&#8631;</button>` : ""}
      <span class="save-status" id="save-status">Saved</span>
      ${isDrawing ? `<button class="btn btn-sm btn-ocr" id="btn-ocr" title="Transcribe handwriting via OCR" type="button">OCR</button>` : ""}
    </div>
  </div>
${isDrawing ? `
  <div class="editor-body">
    <div class="side-toolbar" id="side-toolbar">
      <div class="toolbar-group">
        <button class="tool-btn active" data-tool="pen" title="Pen" type="button">&#9998;</button>
        <button class="tool-btn" data-tool="highlighter" title="Highlighter" type="button">&#9639;</button>
        <button class="tool-btn" data-tool="eraser" title="Eraser" type="button">&#9003;</button>
        <button class="tool-btn" data-tool="select" title="Select" type="button">&#8689;</button>
        <button class="tool-btn" data-tool="text" title="Text" type="button">T</button>
        <button class="tool-btn" data-tool="shape" data-shape="line" title="Line" type="button">&#9585;</button>
        <button class="tool-btn" data-tool="shape" data-shape="rect" title="Rectangle" type="button">&#9634;</button>
        <button class="tool-btn" data-tool="shape" data-shape="circle" title="Circle" type="button">&#9675;</button>
      </div>
      <div class="toolbar-group">
        <div class="color-grid">
          <button class="color-swatch active" data-color="#000000" style="background:#000000" title="Black" type="button"></button>
          <button class="color-swatch" data-color="#e53e3e" style="background:#e53e3e" title="Red" type="button"></button>
          <button class="color-swatch" data-color="#3182ce" style="background:#3182ce" title="Blue" type="button"></button>
          <button class="color-swatch" data-color="#38a169" style="background:#38a169" title="Green" type="button"></button>
          <button class="color-swatch" data-color="#d69e2e" style="background:#d69e2e" title="Yellow" type="button"></button>
          <button class="color-swatch" data-color="#805ad5" style="background:#805ad5" title="Purple" type="button"></button>
        </div>
      </div>
      <div class="toolbar-group">
        <button class="size-btn active" data-size="2" title="Fine" type="button"><span class="size-dot size-fine"></span></button>
        <button class="size-btn" data-size="4" title="Medium" type="button"><span class="size-dot size-medium"></span></button>
        <button class="size-btn" data-size="8" title="Thick" type="button"><span class="size-dot size-thick"></span></button>
      </div>
    </div>
    <div class="whiteboard-area" id="whiteboard-area">
      <canvas id="whiteboard-canvas"></canvas>
      <div class="zoom-indicator" id="zoom-indicator" title="Click to reset zoom">100%</div>
    </div>
  </div>` : `
  <div class="editor-body md-body">
    <div class="editor-tabs">
      <button class="editor-tab active" data-tab="edit" type="button">Edit</button>
      <button class="editor-tab" data-tab="preview" type="button">Preview</button>
    </div>
    <textarea id="text-editor-textarea" class="md-textarea" placeholder="Write markdown…"></textarea>
    <div id="text-editor-preview" class="md-preview" style="display:none"></div>
  </div>`}
</div>
<script>window.PM_BASE = ""; window.NOTE_DATA = ${noteData};</script>
${isDrawing
  ? `<script type="module" src="/pm/static/note-editor.js"></script>`
  : `<script src="/pm/static/note-text-editor.js"></script>`}
</body>
</html>`;
  }

  router.get("/pm/notes/new", (req, res) => {
    res.send(editorPage({ note: null, kind: "drawing" }));
  });

  router.get("/pm/notes/new-md", (req, res) => {
    res.send(editorPage({ note: null, kind: "markdown" }));
  });

  router.get("/pm/notes/:id/edit", async (req, res) => {
    if (!(await ensureLoaded(res))) return;
    try {
      const note = await mods.notesMod.getNote(db, Number(req.params.id));
      if (!note) return res.status(404).send("Note not found");
      res.send(editorPage({ note, kind: note.kind === "drawing" ? "drawing" : "markdown" }));
    } catch (err) {
      res.status(500).send(`Error: ${escapeHtml(err.message)}`);
    }
  });

  // ── Notes API ──

  // Create or update: JSON {id?, title, kind, content_md?, strokes_json?, image_data_url?, tags?}
  router.post("/api/pm/notes", async (req, res) => {
    if (!(await ensureLoaded(res))) return;
    try {
      const body = parseBody(req);
      let note;
      if (body.id) {
        note = await mods.notesMod.updateNote(db, Number(body.id), body);
        if (!note) return res.status(404).json({ error: "Note not found" });
      } else {
        note = await mods.notesMod.createNote(db, body);
      }
      // Best-effort memory index for text content (never blocks the save).
      if (mods.memMod && (note.content_md || note.ocr_text)) {
        const config = mods.configMod.loadConfig();
        mods.memMod.indexNote(db, note, config).catch(() => {});
      }
      res.json({ ok: true, note: { ...note, strokes_json: undefined } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/pm/notes/:id/ocr", async (req, res) => {
    if (!(await ensureLoaded(res))) return;
    try {
      const note = await mods.notesMod.getNote(db, Number(req.params.id));
      if (!note) return res.status(404).json({ error: "Note not found" });
      if (!note.image_path) return res.status(400).json({ error: "Note has no PNG snapshot yet — save the drawing first" });
      const config = mods.configMod.loadConfig();
      const result = await mods.ocrMod.ocrNote(db, note, config);
      if (mods.memMod) {
        const fresh = await mods.notesMod.getNote(db, note.id);
        mods.memMod.indexNote(db, fresh, config).catch(() => {});
      }
      res.json({ ok: true, ocr_text: result.text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Digest + Sync API ──

  router.post("/api/pm/digest/run", async (req, res) => {
    if (!(await ensureLoaded(res))) return;
    try {
      const body = parseBody(req);
      const config = mods.configMod.loadConfig();
      const result = body.preview
        ? await mods.digestMod.preview(db, config)
        : await mods.digestMod.runDigest(db, config, { force: Boolean(body.force) });
      res.json({ ok: true, result: body.preview ? { date: result.date, summary: result.summary, text: result.text } : result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/pm/sync/run", async (req, res) => {
    if (!(await ensureLoaded(res))) return;
    try {
      const config = mods.configMod.loadConfig();
      const result = await mods.syncMod.runSync(db, config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
