/**
 * Public blog embed API — read-only JSON endpoints that hydrate static
 * <figure> fallbacks into live Chart.js / Leaflet widgets on published
 * case-study posts.
 *
 * Mounted BEFORE blogPublicRouter in gateway/index.js so /blog/api/*
 * does not collide with blog-public.js's /blog/:slug catch-all. The
 * slug handler also has a belt-and-suspenders guard for 'api', 'figures',
 * 'feed.xml', etc.
 *
 * Authorization: the ONLY gate is that the section belongs to a blog post
 * with status='published' AND visibility='public'. If the owner flips a
 * post back to private, these endpoints immediately return 404 for that
 * post's sections.
 *
 * Rate limits (express-rate-limit v7):
 *   - Tailscale-User-Login header present → 60 req/min per login
 *   - Tailscale-Funnel-Request header present → 20 req/min shared anonymous
 *   - Otherwise (direct tailnet / localhost) → 240 req/min per IP
 * Keyed via ipKeyGenerator for IPv6 correctness.
 */

import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createClient } from "@libsql/client";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { createDbClient } from "../../db.js";
import { getObject } from "../../storage/s3-client.js";

const MAX_ROWS = 5000;
const QUERY_TIMEOUT_MS = 10_000;
const FIGURES_BUCKET = "capstone-research";
const GATEWAY_INTERNAL_URL =
  process.env.BLOG_FIGURE_GATEWAY_URL || "http://127.0.0.1:3002";

function embedApiKey(req) {
  const login = req.headers["tailscale-user-login"];
  if (login) return `tsuser:${String(login).toLowerCase()}`;
  const funnel = req.headers["tailscale-funnel-request"];
  if (funnel) return "funnel:shared";
  return `ip:${ipKeyGenerator(req.ip || "")}`;
}

function embedApiMax(req) {
  if (req.headers["tailscale-user-login"]) return 60;
  if (req.headers["tailscale-funnel-request"]) return 20;
  return 240;
}

const embedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: embedApiMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: embedApiKey,
  message: { error: "Too many requests" },
});

function isReadOnlySql(sql) {
  const trimmed = String(sql || "")
    .replace(/^(--.*)$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  if (!trimmed) return false;
  const head = trimmed.split(/\s+/)[0]?.toUpperCase();
  return head === "SELECT" || head === "WITH" || head === "EXPLAIN" || head === "PRAGMA";
}

function isPathSafe(dbPath) {
  const crowData = resolve(homedir(), ".crow", "data");
  const resolved = resolve(dbPath);
  return resolved.startsWith(crowData) && !resolved.includes("..");
}

async function loadPublishedSection(db, sectionId) {
  const { rows } = await db.execute({
    sql: `SELECT s.*, cs.blog_post_id, bp.status AS bp_status, bp.visibility AS bp_visibility
            FROM data_case_study_sections s
            JOIN data_case_studies cs ON cs.id = s.case_study_id
            LEFT JOIN blog_posts bp ON bp.id = cs.blog_post_id
           WHERE s.id = ?`,
    args: [sectionId],
  });
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!row.blog_post_id) return null;
  if (row.bp_status !== "published") return null;
  if (row.bp_visibility !== "public") return null;
  return row;
}

async function resolveBackendPath(db, backendId) {
  const { rows } = await db.execute({
    sql: "SELECT connection_ref FROM data_backends WHERE id = ? AND backend_type = 'sqlite'",
    args: [backendId],
  });
  if (rows.length === 0) return null;
  try {
    const ref = JSON.parse(rows[0].connection_ref);
    return ref.path || null;
  } catch {
    return null;
  }
}

async function runSectionSql(dbPath, sql) {
  if (!isReadOnlySql(sql)) throw new Error("Section SQL is not read-only");
  if (!isPathSafe(dbPath)) throw new Error("Backend path outside allowed directory");
  if (!existsSync(dbPath)) throw new Error("Backend database not found");
  const userDb = createClient({ url: `file:${dbPath}` });
  try {
    let safeSql = sql.trim();
    if (!/\bLIMIT\b/i.test(safeSql)) safeSql = `${safeSql} LIMIT ${MAX_ROWS}`;
    const result = await Promise.race([
      userDb.execute(safeSql),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`Query timeout (${QUERY_TIMEOUT_MS / 1000}s)`)), QUERY_TIMEOUT_MS),
      ),
    ]);
    return { columns: result.columns || [], rows: result.rows || [] };
  } finally {
    userDb.close();
  }
}

function parseConfig(configStr) {
  if (!configStr) return {};
  try { return JSON.parse(configStr); } catch { return {}; }
}

export function blogEmbedApiRouter() {
  const router = Router();

  router.use("/blog/api", embedLimiter);
  router.use("/blog/figures", embedLimiter);

  router.get("/blog/api/chart/:section_id(\\d+).json", async (req, res) => {
    const db = createDbClient();
    try {
      const sectionId = Number(req.params.section_id);
      const section = await loadPublishedSection(db, sectionId);
      if (!section || section.section_type !== "chart") return res.status(404).json({ error: "not_found" });

      const config = parseConfig(section.config);
      res.set("Cache-Control", "public, max-age=300");
      res.json({
        section_id: sectionId,
        title: section.title,
        caption: section.caption || "",
        config,
      });
    } catch (err) {
      console.warn("[blog-embed-api] chart config error:", err.message);
      res.status(500).json({ error: "internal_error" });
    } finally {
      db.close();
    }
  });

  router.get("/blog/api/chart/:section_id(\\d+)/data.json", async (req, res) => {
    const db = createDbClient();
    try {
      const sectionId = Number(req.params.section_id);
      const section = await loadPublishedSection(db, sectionId);
      if (!section || section.section_type !== "chart") return res.status(404).json({ error: "not_found" });
      if (!section.sql) return res.status(400).json({ error: "section_has_no_sql" });

      const config = parseConfig(section.config);
      if (!config.backend_id) return res.status(400).json({ error: "section_missing_backend_id" });
      const dbPath = await resolveBackendPath(db, config.backend_id);
      if (!dbPath) return res.status(500).json({ error: "backend_unavailable" });

      const { columns, rows } = await runSectionSql(dbPath, section.sql);
      res.set("Cache-Control", "public, max-age=60");
      res.json({ section_id: sectionId, columns, rows, row_count: rows.length });
    } catch (err) {
      console.warn("[blog-embed-api] chart data error:", err.message);
      res.status(500).json({ error: "internal_error", detail: err.message });
    } finally {
      db.close();
    }
  });

  router.get("/blog/api/geojson/:section_id(\\d+).json", async (req, res) => {
    const db = createDbClient();
    try {
      const sectionId = Number(req.params.section_id);
      const section = await loadPublishedSection(db, sectionId);
      if (!section || section.section_type !== "map") return res.status(404).json({ error: "not_found" });

      const config = parseConfig(section.config);
      const params = new URLSearchParams();
      if (config.backend_id != null) params.set("backend_id", String(config.backend_id));
      if (config.metric) params.set("metric", config.metric);
      if (config.year) params.set("year", config.year);
      if (config.region) params.set("region", String(config.region));
      if (config.county) params.set("county", config.county);

      const upstreamUrl = `${GATEWAY_INTERNAL_URL}/bundles/tea-maps/api/geojson?${params.toString()}`;
      const upstream = await fetch(upstreamUrl);
      res.status(upstream.status);
      res.set("Cache-Control", "public, max-age=300");
      res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
      const coverage = upstream.headers.get("x-join-coverage");
      if (coverage) res.set("X-Join-Coverage", coverage);
      const body = await upstream.text();
      res.send(body);
    } catch (err) {
      console.warn("[blog-embed-api] geojson proxy error:", err.message);
      res.status(502).json({ error: "geojson_upstream_error" });
    } finally {
      db.close();
    }
  });

  router.get("/blog/figures/:filename", async (req, res) => {
    const filename = String(req.params.filename || "");
    const match = /^(\d+)-[0-9a-f]{8,64}\.png$/.exec(filename);
    if (!match) return res.status(400).json({ error: "bad_filename" });
    const sectionId = Number(match[1]);

    const db = createDbClient();
    try {
      const section = await loadPublishedSection(db, sectionId);
      if (!section) return res.status(404).json({ error: "not_found" });

      const s3Key = `figures/${filename}`;
      try {
        const { stream, stat } = await getObject(s3Key, { bucket: FIGURES_BUCKET });
        res.set("Content-Type", stat.metaData?.["content-type"] || "image/png");
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        stream.on("error", (err) => {
          console.warn("[blog-embed-api] figure stream error:", err.message);
          res.destroy();
        });
        stream.pipe(res);
      } catch (err) {
        if (/not.*found|NoSuchKey/i.test(err.message)) {
          return res.status(404).json({ error: "figure_not_found" });
        }
        throw err;
      }
    } catch (err) {
      console.warn("[blog-embed-api] figure proxy error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    } finally {
      db.close();
    }
  });

  return router;
}

export default blogEmbedApiRouter;
