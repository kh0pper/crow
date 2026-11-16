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

// Inlined app-root resolver: this file is copied ALONE to
// <CROW_HOME>/panels/pm-workspace-routes.js, so neither its `../server/*`
// siblings nor a repo-relative path exist on an installed copy. The gateway
// sets CROW_APP_ROOT to the checkout at boot (servers/gateway/index.js); the
// guess is only the run-from-the-repo fallback. Same shape as the maker-lab
// bundle's inline resolver (that file travels alone too).
function looksLikeAppRoot(p) {
  return !!p && existsSync(join(p, "servers", "blog", "renderer.js"));
}
const APP_ROOT_GUESS = resolve(import.meta.dirname, "..", "..", "..");
const APP_ROOT = looksLikeAppRoot(process.env.CROW_APP_ROOT) ? process.env.CROW_APP_ROOT
  : looksLikeAppRoot(APP_ROOT_GUESS) ? APP_ROOT_GUESS
  : (process.env.CROW_APP_ROOT || APP_ROOT_GUESS);

// The sanitizing markdown renderer (marked + sanitize-html), loaded lazily the
// way the knowledge-base panel loads it. `null` = not tried yet, `false` = the
// import failed (answer escaped text, never raw markdown).
let rendererMod = null;
async function loadRenderer() {
  if (rendererMod !== null) return rendererMod;
  try {
    rendererMod = await import(pathToFileURL(join(APP_ROOT, "servers", "blog", "renderer.js")).href);
  } catch (err) {
    console.warn(`[pm-workspace routes] failed to load the markdown renderer: ${err.message}`);
    rendererMod = false;
  }
  return rendererMod;
}

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
      const [dbMod, notesMod, ocrMod, memMod, configMod, digestMod, syncMod, plannerMod] = await Promise.all([
        importBundleModule("server/db.js"),
        importBundleModule("server/notes.js"),
        importBundleModule("server/ocr.js"),
        importBundleModule("server/memory-index.js"),
        importBundleModule("server/config.js"),
        importBundleModule("server/digest/index.js"),
        importBundleModule("server/sync/monday.js"),
        importBundleModule("server/planner.js"),
      ]);
      if (!dbMod || !notesMod || !configMod) {
        res.status(500).json({ error: "pm-workspace bundle modules not available" });
        return false;
      }
      mods = { dbMod, notesMod, ocrMod, memMod, configMod, digestMod, syncMod, plannerMod };
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
<script src="https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js" integrity="sha384-sLpuECXYCB5TUyTbC06pftm/rgurDambREZmV4eRHwEqJzCQtU6lxI2Ve00z4XW5" crossorigin="anonymous"></script>` : ""}
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

  // Markdown → sanitized HTML for the editor's Preview tab.
  //
  // The browser never parses markdown itself: the ONLY markup it receives is
  // the renderer's output (marked + sanitize-html, the same pipeline the blog
  // and the knowledge base use), so a note written by a bot through the
  // pm-workspace MCP create-note tool cannot carry a live handler. Same
  // protection as POST /api/pm/notes above: the path-scoped dashboardAuth on
  // /api/pm is the auth rail, and the body is read the same way (text/plain
  // JSON string, or an already-parsed object).
  //
  // It is renderBotMarkdown, not renderMarkdown, because note text can be bot
  // text: that path refuses every image outside /blog/media/ (a same-origin
  // `<img src="/dashboard/logout">` would fire a GET with the reader's
  // cookies) and opts every link out of Turbo prefetch.
  //
  // PREVIEW_RENDER_MAX bounds render TIME, not just size: marked's lexer is
  // QUADRATIC on mixed-delimiter emphasis and the render is synchronous on
  // this server's event loop. Measured through renderBotMarkdown (CPU time,
  // 2026-09): 8_192 chars of `**a_` 415 ms (the worst measured), `*a_` 410 ms,
  // `_*a` 376 ms, `**_a` 210 ms; the same `*a_` run at 32_768 chars 5.4 s, and
  // at 65_535 chars (~64 KB, the renderer's own BOT_MD_MAX_INPUT) 21.7 s. The
  // renderer's bot cap is therefore far too late to protect a preview from a
  // single click: 8 KB renders in well under a second, while the bot cap would
  // still block the event loop for ~20 s.
  //
  // Over PREVIEW_RENDER_MAX (or over the bot cap, which is above it) is NOT an
  // error: the preview answers the note as ESCAPED TEXT in a <pre> plus
  // `truncated: true` (the editor puts a "shown without formatting" line above
  // it) and the renderer is never called. Above the hard PREVIEW_MAX_MD cap
  // the request is still refused. A SHORT note that legitimately renders to
  // nothing (whitespace only, comment only, a bare <script> the sanitizer
  // drops) gets the same escaped <pre> WITHOUT the flag: it is not truncated,
  // and the editor must never claim it is. A failed (or too old) renderer
  // import answers that same (unflagged) escaped text — an old install reading
  // markdown is a cosmetic loss, never a raw sink.
  const PREVIEW_MAX_MD = 200_000; // the same cap the MCP note tool puts on content_md
  const PREVIEW_RENDER_MAX = 8_192; // one preview render may spend this many chars of marked
  router.post("/api/pm/notes/preview", async (req, res) => {
    const body = parseBody(req);
    const md = typeof body.content_md === "string" ? body.content_md : "";
    if (md.length > PREVIEW_MAX_MD) {
      return res.status(400).json({ error: `content_md is too long (max ${PREVIEW_MAX_MD} characters)` });
    }
    const fallback = () => `<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>`;
    // The render budget is checked before the renderer is even imported: a long
    // note is unformatted text, and marked never sees it.
    if (md.length > PREVIEW_RENDER_MAX) return res.json({ html: fallback(), truncated: true });
    const mod = await loadRenderer();
    // Bot renderer first; an install whose renderer predates it keeps the
    // escaped-text answer rather than falling back to the image-allowing
    // renderMarkdown.
    const render = mod && typeof mod.renderBotMarkdown === "function" ? mod.renderBotMarkdown : null;
    if (!render) return res.json({ html: fallback() });
    try {
      const html = render(md);
      // renderBotMarkdown answers "" for input it refuses (empty in, empty out,
      // and anything over its own BOT_MD_MAX_INPUT — a backstop only, since
      // PREVIEW_RENDER_MAX is well below it). A short note can render to nothing
      // for innocent reasons too, so `truncated` belongs to the size branch
      // above only: a one-line note must not show "Long note: …".
      if (!html && md) return res.json({ html: fallback() });
      return res.json({ html });
    } catch (err) {
      console.warn(`[pm-workspace routes] markdown preview failed: ${err.message}`);
      return res.json({ html: fallback() });
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

  // ── Planner API (approval queue) ──

  function requirePlanner(res) {
    if (!mods.plannerMod) {
      res.status(500).json({ error: "planner module not available (bundle out of date?)" });
      return false;
    }
    return true;
  }

  router.get("/api/pm/plan/list", async (req, res) => {
    if (!(await ensureLoaded(res)) || !requirePlanner(res)) return;
    try {
      const status = req.query.status || undefined;
      const rows = await mods.plannerMod.list(db, { status, limit: 100 });
      res.json({ ok: true, events: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The dashboard queue is a decision surface: {uid, decision} with
  // decision approved | rejected | cancelled. decided_via is stamped
  // "dashboard" here — the chat gate stamps its own via the MCP tool.
  router.post("/api/pm/plan/decide", async (req, res) => {
    if (!(await ensureLoaded(res)) || !requirePlanner(res)) return;
    try {
      const body = parseBody(req);
      const row = await mods.plannerMod.decide(db, {
        uid: String(body.uid || ""),
        decision: String(body.decision || ""),
        via: "dashboard",
      });
      res.json({ ok: true, event: row });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/api/pm/plan/export", async (req, res) => {
    if (!(await ensureLoaded(res)) || !requirePlanner(res)) return;
    try {
      const config = mods.configMod.loadConfig();
      const result = await mods.plannerMod.exportApproved(db, config);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/pm/plan/reconcile", async (req, res) => {
    if (!(await ensureLoaded(res)) || !requirePlanner(res)) return;
    try {
      const config = mods.configMod.loadConfig();
      const result = await mods.plannerMod.reconcile(db, config);
      res.json({ ok: true, result });
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
