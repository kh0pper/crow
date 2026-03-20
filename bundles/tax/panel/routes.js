/**
 * Crow Tax — Panel API Routes
 *
 * Provides endpoints for the dashboard panel including document upload.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TAX_DOCS_DIR = join(homedir(), ".crow", "tax-documents");

export default function taxRoutes(router, db) {
  // Ensure documents directory exists
  if (!existsSync(TAX_DOCS_DIR)) {
    mkdirSync(TAX_DOCS_DIR, { recursive: true });
  }

  // Ensure tax_documents table exists
  db.execute({
    sql: `CREATE TABLE IF NOT EXISTS tax_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      doc_type TEXT NOT NULL,
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
  }).catch(() => {});

  // GET /api/tax/returns — list all returns
  router.get("/api/tax/returns", async (req, res) => {
    try {
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
  router.get("/api/tax/returns/:id/summary", async (req, res) => {
    try {
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
  router.get("/api/tax/documents", async (req, res) => {
    try {
      const result = await db.execute({
        sql: "SELECT id, filename, doc_type, status, return_id, extracted_data, confidence, warnings, uploaded_at, ingested_at FROM tax_documents ORDER BY uploaded_at DESC",
        args: [],
      });
      res.json({ documents: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/tax/documents/:id — get document details including extracted data
  router.get("/api/tax/documents/:id", async (req, res) => {
    try {
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

  // POST /dashboard/tax/upload — upload and ingest a document
  // Note: this requires multipart form data handling from the gateway
  router.post("/dashboard/tax/upload", async (req, res) => {
    try {
      const { doc_type } = req.body || {};

      if (!doc_type) {
        return res.status(400).json({ error: "Document type is required" });
      }

      // Check if the gateway provides file upload via req.file (multer-style)
      if (!req.file && !req.body.file_path) {
        // Fallback: accept a file_path in the body for CLI/MCP usage
        return res.status(400).json({
          error: "No file uploaded. Use the form with a PDF file, or POST with file_path.",
        });
      }

      let filePath;
      let filename;

      if (req.file) {
        // File uploaded via multipart form
        filename = req.file.originalname;
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        filePath = join(TAX_DOCS_DIR, `${Date.now()}-${safeName}`);
        writeFileSync(filePath, req.file.buffer);
      } else {
        // File path provided directly
        filePath = req.body.file_path;
        filename = filePath.split("/").pop();
      }

      // Record the upload
      await db.execute({
        sql: "INSERT INTO tax_documents (filename, doc_type, file_path, status) VALUES (?, ?, ?, 'uploaded')",
        args: [filename, doc_type, filePath],
      });

      // Try to ingest the document
      try {
        const { ingestDocument } = await import("../engine/ingest/index.js");
        const result = await ingestDocument(filePath, doc_type);

        await db.execute({
          sql: `UPDATE tax_documents SET status = 'ingested',
                extracted_data = ?, confidence = ?, warnings = ?, ingested_at = datetime('now')
                WHERE file_path = ?`,
          args: [
            JSON.stringify(result.data),
            JSON.stringify(result.confidence),
            JSON.stringify(result.warnings),
            filePath,
          ],
        });
      } catch (ingestErr) {
        await db.execute({
          sql: "UPDATE tax_documents SET status = 'error', warnings = ? WHERE file_path = ?",
          args: [JSON.stringify([ingestErr.message]), filePath],
        });
      }

      // Redirect back to the tax panel
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/dashboard#tax");
      }
      res.json({ success: true, filename, doc_type });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
