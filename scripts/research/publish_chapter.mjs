#!/usr/bin/env node
/**
 * Publish one case study as a Crow blog post. Replicates the
 * crow_data_case_study_publish MCP tool's logic directly via Node
 * imports because the MCP tool is not exposed in this session. Code
 * under test:
 *   - figure-renderer.renderChart (@napi-rs/canvas + Chart.js)
 *   - figure-renderer.cacheKey / s3KeyFor
 *   - storage/s3-client.uploadObject (MinIO)
 *   - query-engine.executeReadQuery (backend SQL)
 *   - init-tables.addColumnIfMissing idempotency
 *
 * Invocation:
 *   node ~/crow/scripts/research/publish_chapter.mjs <case_study_id> [--overwrite] [--write]
 *
 * Default is --dry-run equivalent: the INSERT is gated on --write so
 * you can preview what would be written without touching blog_posts.
 * Pass --write to actually insert/update. Overwrite maps to the tool's
 * overwrite=true (UPDATE existing bp).
 */

import { createDbClient } from "/home/kh0pp/crow/servers/db.js";
import {
  renderChart,
  renderMap,
  cacheKey,
  s3KeyFor,
} from "/home/kh0pp/crow/servers/blog/figure-renderer.js";
import { uploadObject, getClient as getStorageClient }
  from "/home/kh0pp/crow/servers/storage/s3-client.js";
import { executeReadQuery }
  from "/home/kh0pp/crow/bundles/data-dashboard/server/query-engine.js";

const FIGURES_BUCKET = "capstone-research";
const GATEWAY_INTERNAL_URL = "http://127.0.0.1:3002";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Section titles come from authored JSON that may contain markdown-style
// italics (e.g. `*Edgewood*`). The blog renderer treats <h2>…</h2> as raw
// HTML and does NOT parse markdown inside it, so asterisks would survive
// verbatim. Escape first, then convert *word* → <em>word</em>.
function renderHeadingText(s) {
  return escapeHtml(s).replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
}

async function resolveDbPath(db, backendId) {
  const { rows } = await db.execute({
    sql: "SELECT connection_ref FROM data_backends WHERE id = ? AND backend_type = 'sqlite'",
    args: [backendId],
  });
  if (rows.length === 0) throw new Error(`Backend #${backendId} not found`);
  return JSON.parse(rows[0].connection_ref).path;
}

async function fetchGeojsonForSection(config) {
  const params = new URLSearchParams();
  if (config.backend_id != null) params.set("backend_id", String(config.backend_id));
  if (config.metric) params.set("metric", config.metric);
  if (config.year) params.set("year", config.year);
  if (config.region) params.set("region", String(config.region));
  if (config.county) params.set("county", config.county);
  const url = `${GATEWAY_INTERNAL_URL}/bundles/tea-maps/api/geojson?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`tea-maps geojson fetch failed: ${resp.status}`);
  return resp.json();
}

async function figureObjectExists(s3Key) {
  try {
    const client = getStorageClient();
    if (!client) return false;
    await client.statObject(FIGURES_BUCKET, s3Key);
    return true;
  } catch { return false; }
}

function buildFigureHtml(section, config, backendId, s3Key) {
  const cls = section.section_type === "chart" ? "crow-chart" : "crow-map";
  const imgUrl = `/blog/${s3Key}`;
  const dataBackend = backendId ? ` data-backend-id="${backendId}"` : "";
  let mapData = "";
  if (section.section_type === "map") {
    if (config.metric) mapData += ` data-metric="${escapeHtml(config.metric)}"`;
    if (config.field) mapData += ` data-field="${escapeHtml(config.field)}"`;
  }
  const caption = section.caption || "";
  const figcaption = [section.title, caption].filter(Boolean).map(escapeHtml).join(". ");
  return [
    `<figure class="${cls}" data-section-id="${section.id}"${dataBackend}${mapData}>`,
    `  <img src="${imgUrl}" alt="${escapeHtml(section.title || section.section_type)}" loading="lazy" width="1200" height="800">`,
    figcaption ? `  <figcaption>${figcaption}</figcaption>` : "",
    `</figure>`,
  ].filter(Boolean).join("\n");
}

async function renderSectionFigure(db, section, opts = {}) {
  const skipIfCached = opts.skipIfCached === true;
  const config = section.config ? JSON.parse(section.config) : {};
  const backendId = config.backend_id ?? null;
  let digestInput, geojson, rows;
  if (section.section_type === "chart") {
    if (!section.sql) throw new Error("chart missing sql");
    if (!backendId) throw new Error("chart missing backend_id");
    const dbPath = await resolveDbPath(db, backendId);
    const result = await executeReadQuery(dbPath, section.sql);
    rows = result.rows;
    digestInput = rows;
  } else if (section.section_type === "map") {
    geojson = await fetchGeojsonForSection(config);
    digestInput = (geojson.features || []).map((f) => f.properties?.metric_data ?? null);
  } else {
    throw new Error(`unsupported section_type ${section.section_type}`);
  }
  const key = cacheKey({
    sectionId: section.id, config, sql: section.sql || "", dataDigestInput: digestInput,
  });
  const s3Key = s3KeyFor(section.id, key);
  let cached = false;
  if (skipIfCached && (await figureObjectExists(s3Key))) {
    cached = true;
  } else {
    const buffer = section.section_type === "chart"
      ? await renderChart({ config: { ...config, title: section.title }, rows })
      : await renderMap({ config: { ...config, title: section.title }, title: section.title || "", geojson });
    await uploadObject(s3Key, buffer, { bucket: FIGURES_BUCKET, contentType: "image/png" });
  }
  return { s3Key, cached, html: buildFigureHtml(section, config, backendId, s3Key) };
}

async function main() {
  const args = process.argv.slice(2);
  const caseStudyId = Number(args[0]);
  const write = args.includes("--write");
  const overwrite = args.includes("--overwrite");
  if (!Number.isInteger(caseStudyId) || caseStudyId <= 0) {
    console.error("Usage: publish_chapter.mjs <case_study_id> [--write] [--overwrite]");
    process.exit(2);
  }

  const db = createDbClient();
  const { rows: studies } = await db.execute({
    sql: "SELECT * FROM data_case_studies WHERE id = ?",
    args: [caseStudyId],
  });
  if (studies.length === 0) throw new Error(`Case study #${caseStudyId} not found`);
  const study = studies[0];
  const alreadyPublished = study.blog_post_id != null;
  if (alreadyPublished && !overwrite) {
    console.log(`Already published as blog post #${study.blog_post_id}. Pass --overwrite to re-emit.`);
    return;
  }
  console.log(`Case study: ${study.title} (id=${caseStudyId})`);
  console.log(`  blog_post_id=${study.blog_post_id} alreadyPublished=${alreadyPublished}`);
  console.log(`  overwrite=${overwrite} write=${write}`);

  const { rows: sections } = await db.execute({
    sql: "SELECT * FROM data_case_study_sections WHERE case_study_id = ? ORDER BY sort_order",
    args: [caseStudyId],
  });
  console.log(`  sections: ${sections.length}`);

  const articleParts = [`<article itemscope itemtype="https://schema.org/Article">`];
  articleParts.push(`<h1 itemprop="headline">${escapeHtml(study.title)}</h1>`);
  if (study.description) articleParts.push(`<p itemprop="description">${escapeHtml(study.description)}</p>`);
  let rendered = 0, cached = 0;
  const failures = [];
  for (const s of sections) {
    if (s.title) articleParts.push(`<h2>${renderHeadingText(s.title)}</h2>`);
    if (s.section_type === "text") {
      if (s.content) articleParts.push(s.content);
    } else if (s.section_type === "chart" || s.section_type === "map") {
      try {
        // --overwrite also forces re-render: rendering-code changes
        // (palette, plugin) don't change the cache key because the key
        // is data-hash-keyed by design. When the operator explicitly
        // overwrites, they expect the PNGs to reflect the current code.
        const result = await renderSectionFigure(db, s, { skipIfCached: !overwrite });
        if (result.cached) { cached += 1; } else { rendered += 1; }
        articleParts.push(result.html);
        console.log(`  ${s.section_type} #${s.id} ${result.cached ? "cached" : "rendered"} → ${result.s3Key}`);
      } catch (err) {
        failures.push(`#${s.id}: ${err.message}`);
        console.error(`  ${s.section_type} #${s.id} FAILED: ${err.message}`);
      }
    }
  }
  articleParts.push(`</article>`);

  if (failures.length > 0) {
    console.error(`\nAborting: ${failures.length} failure(s)`);
    process.exit(1);
  }

  const content = articleParts.join("\n\n");
  const slug = study.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  console.log(`\nBuilt content: ${content.length} chars, ${rendered} rendered, ${cached} cached`);
  console.log(`Slug: ${slug}`);

  if (!write) {
    console.log(`\n(Dry run. Pass --write to INSERT the blog_posts row.)`);
    return;
  }

  let postId, action;
  if (alreadyPublished && overwrite) {
    await db.execute({
      sql: "UPDATE blog_posts SET title = ?, slug = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
      args: [study.title, slug, content, study.blog_post_id],
    });
    postId = study.blog_post_id;
    action = "updated";
  } else {
    const postResult = await db.execute({
      sql: "INSERT INTO blog_posts (title, slug, content, status, visibility, tags) VALUES (?, ?, ?, 'draft', 'public', 'case-study')",
      args: [study.title, slug, content],
    });
    postId = Number(postResult.lastInsertRowid);
    await db.execute({
      sql: "UPDATE data_case_studies SET blog_post_id = ?, updated_at = datetime('now') WHERE id = ?",
      args: [postId, caseStudyId],
    });
    action = "inserted";
  }
  console.log(`\nBlog post #${postId} (draft) ${action}. Slug: ${slug}`);
  console.log(`Status stays 'draft' until an explicit publish. Visibility='public'.`);
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
