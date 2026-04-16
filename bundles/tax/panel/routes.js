/**
 * Crow Tax — Panel API Routes
 *
 * Express router factory for the tax dashboard panel.
 * Handles document upload, ingestion, verification, and return management.
 *
 * Pattern: export default function(authMiddleware) → Router
 */

import { Router } from "express";
import multer from "multer";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const TAX_DOCS_DIR = join(homedir(), ".crow", "tax-documents");

// Resolve bundle directory (installed vs repo)
function resolveBundleDir() {
  const installed = join(homedir(), ".crow", "bundles", "tax");
  if (existsSync(installed)) return installed;
  return join(import.meta.dirname, "..");
}

// Resolve the crow db module
function resolveDbModule() {
  const repoPath = join(import.meta.dirname, "..", "..", "..", "servers", "db.js");
  if (existsSync(repoPath)) return repoPath;
  const bundlePath = join(resolveBundleDir(), "server", "db.js");
  if (existsSync(bundlePath)) return bundlePath;
  return repoPath;
}

// Lazy-loaded db client
let _createDbClient = null;
async function getDb() {
  if (!_createDbClient) {
    const mod = await import(pathToFileURL(resolveDbModule()).href);
    _createDbClient = mod.createDbClient;
  }
  return _createDbClient();
}

// Multer setup — store uploads locally (PII safety, not S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

export default function taxRouter(authMiddleware) {
  const router = Router();
  const bundleDir = resolveBundleDir();

  // Ensure directories and tables exist
  mkdirSync(TAX_DOCS_DIR, { recursive: true });
  (async () => {
    try {
      const db = await getDb();
      await db.execute({
        sql: `CREATE TABLE IF NOT EXISTS tax_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          doc_type TEXT NOT NULL,
          owner TEXT DEFAULT 'taxpayer',
          file_path TEXT NOT NULL,
          status TEXT DEFAULT 'uploaded',
          return_id TEXT,
          extracted_data TEXT,
          confidence TEXT,
          warnings TEXT,
          uploaded_at TEXT DEFAULT (datetime('now')),
          ingested_at TEXT
        )`,
        args: [],
      });
      // Add owner column if table already exists without it
      try {
        await db.execute({ sql: "ALTER TABLE tax_documents ADD COLUMN owner TEXT DEFAULT 'taxpayer'", args: [] });
      } catch {} // Column already exists
    } catch {}
  })();

  // GET /api/tax/returns — list all returns
  router.get("/api/tax/returns", authMiddleware, async (req, res) => {
    try {
      const db = await getDb();
      const result = await db.execute({
        sql: "SELECT id, tax_year, filing_status, status, updated_at FROM tax_returns WHERE status != 'purged' ORDER BY updated_at DESC",
        args: [],
      });
      res.json({ returns: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/tax/returns/:id/summary — get calculated summary (no PII)
  router.get("/api/tax/returns/:id/summary", authMiddleware, async (req, res) => {
    try {
      const db = await getDb();
      const result = await db.execute({
        sql: "SELECT id, tax_year, filing_status, status, result FROM tax_returns WHERE id = ?",
        args: [req.params.id],
      });
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      const row = result.rows[0];
      res.json({
        id: row.id,
        taxYear: row.tax_year,
        filingStatus: row.filing_status,
        status: row.status,
        result: row.result ? JSON.parse(row.result) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/tax/documents — list all uploaded documents
  router.get("/api/tax/documents", authMiddleware, async (req, res) => {
    try {
      const db = await getDb();
      const result = await db.execute({
        sql: "SELECT id, filename, doc_type, status, return_id, extracted_data, confidence, warnings, uploaded_at, ingested_at FROM tax_documents ORDER BY uploaded_at DESC",
        args: [],
      });
      res.json({ documents: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/tax/documents/:id — get document details with extracted data
  router.get("/api/tax/documents/:id", authMiddleware, async (req, res) => {
    try {
      const db = await getDb();
      const result = await db.execute({
        sql: "SELECT * FROM tax_documents WHERE id = ?",
        args: [req.params.id],
      });
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      const doc = result.rows[0];
      res.json({
        ...doc,
        extracted_data: doc.extracted_data ? JSON.parse(doc.extracted_data) : null,
        confidence: doc.confidence ? JSON.parse(doc.confidence) : null,
        warnings: doc.warnings ? JSON.parse(doc.warnings) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/tax/upload — upload and ingest a tax document PDF
  router.post("/api/tax/upload", authMiddleware, upload.single("document"), async (req, res) => {
    try {
      const { doc_type, owner } = req.body || {};
      if (!doc_type) {
        return res.status(400).json({ error: "Document type is required" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "No PDF file uploaded" });
      }

      const db = await getDb();
      const filename = req.file.originalname;
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(TAX_DOCS_DIR, `${Date.now()}-${safeName}`);
      writeFileSync(filePath, req.file.buffer);

      // Record upload with owner tag
      await db.execute({
        sql: "INSERT INTO tax_documents (filename, doc_type, owner, file_path, status) VALUES (?, ?, ?, ?, 'uploaded')",
        args: [filename, doc_type, owner || "taxpayer", filePath],
      });

      // Get the inserted ID
      const idResult = await db.execute({ sql: "SELECT last_insert_rowid() as id", args: [] });
      const docId = idResult.rows[0]?.id;

      // Try ingestion
      let ingestionResult = null;
      try {
        const { ingestDocument } = await import(pathToFileURL(join(bundleDir, "engine", "ingest", "index.js")).href);
        ingestionResult = await ingestDocument(filePath, doc_type);

        await db.execute({
          sql: `UPDATE tax_documents SET status = 'ingested',
                extracted_data = ?, confidence = ?, warnings = ?, ingested_at = datetime('now')
                WHERE id = ?`,
          args: [
            JSON.stringify(ingestionResult.data),
            JSON.stringify(ingestionResult.confidence),
            JSON.stringify(ingestionResult.warnings || []),
            docId,
          ],
        });
      } catch (ingestErr) {
        await db.execute({
          sql: "UPDATE tax_documents SET status = 'error', warnings = ? WHERE id = ?",
          args: [JSON.stringify([ingestErr.message]), docId],
        });
      }

      // Redirect back to tax panel documents tab
      if (req.headers.accept?.includes("text/html")) {
        return res.redirectAfterPost("/dashboard/tax?tab=documents");
      }

      res.status(201).json({
        id: docId,
        filename,
        doc_type,
        status: ingestionResult ? "ingested" : "error",
        extracted_data: ingestionResult?.data || null,
        confidence: ingestionResult?.confidence || null,
        low_confidence_fields: ingestionResult?.low_confidence_fields || [],
        warnings: ingestionResult?.warnings || [],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/tax/documents/:id/confirm — confirm/correct extracted data
  // Accepts either JSON { corrected_data } or form fields (field_wages, field_employer, etc.)
  router.post("/api/tax/documents/:id/confirm", authMiddleware, async (req, res) => {
    try {
      const db = await getDb();

      const result = await db.execute({
        sql: "SELECT * FROM tax_documents WHERE id = ?",
        args: [req.params.id],
      });
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Document not found" });
      }

      const doc = result.rows[0];
      const existing = doc.extracted_data ? JSON.parse(doc.extracted_data) : {};
      let finalData;

      if (req.body.corrected_data) {
        // JSON API call
        finalData = req.body.corrected_data;
      } else {
        // Form submission — collect field_* params and build corrected data
        finalData = { ...existing };
        for (const [key, value] of Object.entries(req.body)) {
          if (key.startsWith("field_")) {
            const fieldName = key.substring(6);
            const trimmed = String(value).trim();
            // Detect numeric fields
            const numVal = parseFloat(trimmed.replace(/[$,]/g, ""));
            if (!isNaN(numVal) && /^[\d$,.\s-]+$/.test(trimmed)) {
              finalData[fieldName] = numVal;
            } else {
              finalData[fieldName] = trimmed;
            }
          }
        }
      }

      // Update document status to confirmed with corrected data
      await db.execute({
        sql: "UPDATE tax_documents SET status = 'confirmed', extracted_data = ? WHERE id = ?",
        args: [JSON.stringify(finalData), doc.id],
      });

      // Redirect back to documents tab if browser request
      if (req.headers.accept?.includes("text/html")) {
        return res.redirectAfterPost("/dashboard/tax?tab=documents");
      }
      res.json({ confirmed: true, doc_id: doc.id, data: finalData });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/tax/documents/:id/edit — revert confirmed document back to editable
  router.post("/api/tax/documents/:id/edit", authMiddleware, async (req, res) => {
    try {
      const db = await getDb();
      await db.execute({
        sql: "UPDATE tax_documents SET status = 'ingested' WHERE id = ?",
        args: [req.params.id],
      });
      if (req.headers.accept?.includes("text/html")) {
        return res.redirectAfterPost("/dashboard/tax?tab=documents");
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/tax/documents/:id/delete — remove a document
  router.post("/api/tax/documents/:id/delete", authMiddleware, async (req, res) => {
    try {
      const db = await getDb();
      // Get file path to delete the uploaded file
      const result = await db.execute({ sql: "SELECT file_path FROM tax_documents WHERE id = ?", args: [req.params.id] });
      if (result.rows[0]?.file_path) {
        try { (await import("node:fs")).unlinkSync(result.rows[0].file_path); } catch {}
      }
      await db.execute({ sql: "DELETE FROM tax_documents WHERE id = ?", args: [req.params.id] });
      if (req.headers.accept?.includes("text/html")) {
        return res.redirectAfterPost("/dashboard/tax?tab=documents");
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
