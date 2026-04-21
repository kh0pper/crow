/**
 * Blog figure renderer — static PNGs for case-study chart/map sections.
 *
 * Used by `crow_data_case_study_publish` (8.3) and `crow_data_case_study_
 * rerender_figures` (8.6). The PNG is the fallback for RSS readers,
 * JS-disabled browsers, and social-card previews; the interactive
 * Chart.js / Leaflet widget (hydrated by 8.5) is the primary experience.
 *
 * Hybrid runtime:
 *   - Charts → Chart.js + @napi-rs/canvas (Node-native, single source of
 *     color config with the browser Chart.js path).
 *   - Maps → shells out to scripts/build_section_map.py (matplotlib +
 *     geopandas). Headless Leaflet in Node would require either jsdom or
 *     re-implementing projection/path drawing with d3-geo; shelling to
 *     matplotlib reuses the project's existing thesis-figure toolchain.
 *
 * The module returns raw PNG buffers. The caller is responsible for
 * upload (s3-client.uploadObject) and cache-key management. This keeps
 * figure-renderer pure/unit-testable.
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import Chart from "chart.js/auto";
import { createCanvas } from "@napi-rs/canvas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLORS = JSON.parse(readFileSync(join(__dirname, "figure-colors.json"), "utf8"));

const DEFAULT_W = 1200;
const DEFAULT_H = 800;
const PY_SCRIPT = resolve(process.env.HOME || "/root", "spring-2026/scripts/build_section_map.py");

// Map rendering shells out to matplotlib + geopandas, which live in the
// spring-2026 scripts venv. Set BLOG_FIGURE_PYTHON to override (e.g. on
// the crow machine once the same venv is provisioned there). Falls back
// to /usr/bin/python3 — will fail loudly if geopandas isn't available.
const PY_BIN = (() => {
  if (process.env.BLOG_FIGURE_PYTHON) return process.env.BLOG_FIGURE_PYTHON;
  const venvPy = resolve(process.env.HOME || "/root", "spring-2026/scripts/.venv/bin/python");
  return existsSync(venvPy) ? venvPy : "python3";
})();

// ── cacheKey — deterministic fingerprint that includes the query result
// ───────────────────────────────────────────────────────────────────────
// Phase 8 Round 4 bug: earlier design hashed (section_id, config, sql) only.
// When tea_data.db is refreshed, config/sql are unchanged → same hash → stale
// cache → wrong PNG served. The fix is to include the query result in the
// hash so refreshed data invalidates.
//
// For charts: pass the row array from the SQL execution.
// For maps: pass the GeoJSON feature array (same idea — it's what the
// browser renders and matches the snapshot in time).
export function cacheKey({ sectionId, config, sql, dataDigestInput }) {
  const h = createHash("sha256");
  h.update(String(sectionId));
  h.update("\x1f");
  h.update(JSON.stringify(config ?? null));
  h.update("\x1f");
  h.update(sql || "");
  h.update("\x1f");
  h.update(typeof dataDigestInput === "string" ? dataDigestInput : JSON.stringify(dataDigestInput ?? null));
  return h.digest("hex").slice(0, 16);
}

export function s3KeyFor(sectionId, key) {
  return `figures/${sectionId}-${key}.png`;
}

// ── Chart renderer (Node, Chart.js) ──────────────────────────────────

function buildChartJsConfig(sectionConfig, rows) {
  // The dashboard stores two schema variants (reference_chart_config_schema):
  //   1. {type, xCol, yCol, backend_id}                     — bar / scatter
  //   2. {chart_type: 'grouped_bar', x_field, y_fields: []} — grouped bar
  const { chart_type, x_field, y_fields } = sectionConfig || {};
  if (chart_type === "grouped_bar" && Array.isArray(y_fields)) {
    const labels = rows.map((r) => r[x_field]);
    const datasets = y_fields.map((yf, i) => ({
      label: yf,
      data: rows.map((r) => toNum(r[yf])),
      backgroundColor: COLORS.chart_palette[i % COLORS.chart_palette.length],
    }));
    return {
      type: "bar",
      data: { labels, datasets },
      options: buildChartOptions(sectionConfig, { grouped: true }),
    };
  }
  // variant 1 — bar or scatter
  const type = sectionConfig?.type === "scatter" ? "scatter" : "bar";
  const xCol = sectionConfig?.xCol;
  const yCol = sectionConfig?.yCol;
  if (!xCol || !yCol) throw new Error("figure-renderer: chart config missing xCol/yCol");
  if (type === "scatter") {
    return {
      type: "scatter",
      data: {
        datasets: [{
          label: yCol,
          data: rows.map((r) => ({ x: toNum(r[xCol]), y: toNum(r[yCol]) })),
          backgroundColor: COLORS.chart_palette[0],
          borderColor: COLORS.chart_palette[0].replace("0.8)", "1)"),
        }],
      },
      options: buildChartOptions(sectionConfig, { scatter: true }),
    };
  }
  return {
    type: "bar",
    data: {
      labels: rows.map((r) => String(r[xCol])),
      datasets: [{
        label: yCol,
        data: rows.map((r) => toNum(r[yCol])),
        backgroundColor: COLORS.chart_palette[0],
      }],
    },
    options: buildChartOptions(sectionConfig, {}),
  };
}

function buildChartOptions(sectionConfig, flags) {
  return {
    responsive: false,
    animation: false,
    plugins: {
      legend: { labels: { color: COLORS.chart_text } },
      title: sectionConfig?.title
        ? { display: true, text: String(sectionConfig.title).slice(0, 120), color: COLORS.chart_text, font: { size: 18 } }
        : { display: false },
    },
    scales: {
      x: {
        ticks: { color: COLORS.chart_text, maxRotation: 45, autoSkip: true },
        grid: { color: COLORS.chart_grid },
      },
      y: {
        ticks: { color: COLORS.chart_text },
        grid: { color: COLORS.chart_grid },
        beginAtZero: !flags.scatter,
      },
    },
  };
}

function toNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Render a chart section to a PNG Buffer.
 * @param {object} args
 * @param {object} args.config    Section config (chart_type|type + field map)
 * @param {Array}  args.rows      Query result rows
 * @param {number} [args.width]   Default 1200
 * @param {number} [args.height]  Default 800
 * @returns {Promise<Buffer>}
 */
export async function renderChart({ config, rows, width = DEFAULT_W, height = DEFAULT_H }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    // Empty-state PNG — still produce something so <img> doesn't 404.
    return placeholderPng(width, height, "No data", COLORS.chart_panel, COLORS.chart_text);
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLORS.chart_bg;
  ctx.fillRect(0, 0, width, height);
  const chartConfig = buildChartJsConfig(config, rows);
  const chart = new Chart(ctx, chartConfig);
  // Chart.js renders synchronously on first construction with animation:false.
  // Take the buffer, then destroy so the instance doesn't hold handles.
  const buf = canvas.toBuffer("image/png");
  chart.destroy();
  return buf;
}

// ── Map renderer (Python subprocess, matplotlib) ─────────────────────

/**
 * Render a map section to a PNG Buffer by shelling out to
 * scripts/build_section_map.py. Caller supplies the GeoJSON
 * FeatureCollection (fetched from /bundles/tea-maps/api/geojson?...) so
 * the PNG reflects exactly the data the browser would show at publish
 * time.
 *
 * @param {object} args
 * @param {object} args.config     Section config (metric, field, year, region)
 * @param {object} args.geojson    Pre-fetched GeoJSON FeatureCollection
 * @param {string} [args.title]    Title overlay
 * @param {number} [args.width]    Default 1200
 * @param {number} [args.height]   Default 800
 * @returns {Promise<Buffer>}
 */
export async function renderMap({ config, geojson, title, width = DEFAULT_W, height = DEFAULT_H }) {
  if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {
    return placeholderPng(width, height, "No map data", COLORS.chart_panel, COLORS.chart_text);
  }
  const dir = await mkdtemp(join(tmpdir(), "crow-figure-"));
  const inputPath = join(dir, "input.json");
  const outputPath = join(dir, "out.png");
  try {
    await writeFile(
      inputPath,
      JSON.stringify({
        config: config || {},
        title: title || config?.title || "",
        geojson,
        colors: {
          stops: COLORS.choropleth_stops,
          neutral: COLORS.neutral,
          bg: COLORS.chart_bg,
          text: COLORS.chart_text,
          grid: COLORS.chart_grid,
        },
        width,
        height,
      }),
    );
    await runPython([PY_BIN, PY_SCRIPT, "--input", inputPath, "--output", outputPath]);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runPython(argv) {
  return new Promise((resolvePromise, rejectPromise) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", (err) => rejectPromise(err));
    p.on("close", (code) => {
      if (code === 0) return resolvePromise();
      rejectPromise(new Error(`figure-renderer: build_section_map.py exit ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

// ── Placeholder fallback ─────────────────────────────────────────────

function placeholderPng(w, h, text, bg, fg) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.font = "bold 32px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);
  return canvas.toBuffer("image/png");
}
