/**
 * Reader — panel companion routes.
 * COPIED to $CROW_HOME/panels/reader-routes.js at install; no relative
 * imports. STRICT_PANEL_MOUNT: every middleware is path-scoped.
 */
import { Router } from "express";
import express from "express";
import multer from "multer";
import { join, resolve, normalize } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BUNDLE_DIR = join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "reader");

async function importBundleModule(rel) {
  try { return await import(pathToFileURL(join(BUNDLE_DIR, rel)).href); }
  catch (err) {
    console.warn(`[reader routes] failed to import ${rel}: ${err.message}`);
    return null;
  }
}

export default function readerRouter(dashboardAuth) {
  const router = Router();
  let mods = null;
  let db = null;

  async function ensureLoaded(res) {
    if (!mods) {
      const [dbMod, importMod, queriesMod, renderMod, configMod, initMod, progressMod] = await Promise.all([
        importBundleModule("server/db.js"),
        importBundleModule("server/import.js"),
        importBundleModule("server/queries.js"),
        importBundleModule("server/render.js"),
        importBundleModule("server/config.js"),
        importBundleModule("server/init-tables.js"),
        importBundleModule("server/progress.js"),
      ]);
      if (!dbMod || !importMod || !queriesMod || !renderMod || !configMod) {
        res.status(500).json({ error: "reader bundle modules not available" });
        return false;
      }
      mods = { dbMod, importMod, queriesMod, renderMod, configMod, initMod, progressMod };
    }
    if (!db) {
      db = mods.dbMod.createDbClient();
      if (mods.initMod) await mods.initMod.initReaderTables(db);
    }
    return true;
  }

  if (typeof dashboardAuth === "function") {
    router.use("/reader-app", dashboardAuth);
    router.use("/api/reader", dashboardAuth);
    router.use("/reader/static", dashboardAuth);
  }
  router.use("/api/reader", express.json({ limit: "1mb" }));

  // Static assets
  router.get("/reader/static/:file", (req, res) => {
    const staticDir = resolve(join(BUNDLE_DIR, "panel", "static"));
    const target = resolve(normalize(join(staticDir, req.params.file)));
    if (!target.startsWith(staticDir + "/")) return res.status(400).send("Bad path");
    if (!existsSync(target)) return res.status(404).send("Not found");
    res.sendFile(target);
  });

  // Import: multipart file OR JSON {url,...}.
  // multer resolves from the gateway's node_modules (^2.x) via the
  // panels/node_modules symlink; the instance is built lazily so
  // limits.fileSize reflects READER_MAX_UPLOAD_MB at request time.
  let uploadMw = null;
  function uploadSingle(req, res, next) {
    if (!uploadMw) {
      const capMb = Number(
        (mods?.configMod?.loadConfig() || {}).READER_MAX_UPLOAD_MB || 50);
      uploadMw = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: capMb * 1024 * 1024 },
      }).single("file");
    }
    uploadMw(req, res, (err) => {
      if (err && err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File exceeds the upload size cap" });
      }
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  }
  router.post("/api/reader/import", async (req, res, next) => {
    try {
      if (!(await ensureLoaded(res))) return;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }, uploadSingle, async (req, res) => {
    try {
      const config = mods.configMod.loadConfig();
      let input;
      if (req.file) {
        input = {
          sourceType: "upload", buffer: req.file.buffer,
          filename: req.file.originalname,
          title: req.body?.title || null, tags: req.body?.tags || null,
          ocr: req.body?.ocr === "1",
        };
      } else if (req.body?.url) {
        input = { sourceType: "url", url: req.body.url,
                  title: req.body.title || null, tags: req.body.tags || null };
      } else {
        return res.status(400).json({ error: "Provide a file or a url" });
      }
      const result = await mods.importMod.ingestDocument(db, config, input);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/reader/progress", async (req, res) => {
    try {
      if (!(await ensureLoaded(res))) return;
      const b = req.body || {};
      const documentId = Number(b.document_id);
      const paragraph = Number(b.paragraph);
      if (!Number.isInteger(documentId) || documentId <= 0 ||
          !Number.isInteger(paragraph) || paragraph < 0) {
        return res.status(400).json({ error: "document_id and paragraph must be non-negative integers" });
      }
      res.json(await mods.progressMod.saveProgress(db, {
        document_id: documentId,
        section_number: Number(b.section_number) || 1,
        paragraph,
        total_paragraphs: Number.isInteger(Number(b.total_paragraphs)) ? Number(b.total_paragraphs) : null,
        audio_time: typeof b.audio_time === "number" ? b.audio_time : null,
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/reader/progress/:documentId/:sectionNumber", async (req, res) => {
    try {
      if (!(await ensureLoaded(res))) return;
      const row = await mods.progressMod.getProgress(db,
        Number(req.params.documentId), Number(req.params.sectionNumber));
      res.json(row || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read view page
  router.get("/reader-app/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send("Bad id");
    try {
      if (!(await ensureLoaded(res))) return;
      const got = await mods.queriesMod.getDocument(db, id);
      if (!got) return res.status(404).send("Not found");
      const sectionNumber = Number(req.query.section || 1);
      const secRow = await db.execute({
        sql: `SELECT * FROM reader_sections WHERE document_id = ? AND section_number = ?`,
        args: [id, sectionNumber],
      });
      if (secRow.rows.length === 0) return res.status(404).send("Section not found");
      const progress = await db.execute({
        sql: `SELECT paragraph FROM reader_progress WHERE document_id = ? AND section_number = ?`,
        args: [id, sectionNumber],
      });
      res.send(mods.renderMod.readerPage({
        document: got.document,
        section: secRow.rows[0],
        sections: got.sections,
        paragraphs: JSON.parse(String(secRow.rows[0].paragraphs_json)),
        progress: progress.rows[0] || null,
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
