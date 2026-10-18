/**
 * SunVox Studio MCP Server
 *
 * AI-operable SunVox: inspect, render and compose tracker music via the
 * MIT-licensed SunVox engine library (vendored libsunvox.so, offline mode —
 * no audio device needed).
 *
 * Tools:
 *   sunvox_info          — structured metadata for a .sunvox/.xm/.mod file
 *   sunvox_render        — offline render to WAV/MP3/OGG (ffmpeg for lossy)
 *   sunvox_compose       — build a project from a constrained JSON spec,
 *                          save .sunvox, optionally render in one call
 *   sunvox_module_types  — the module/controller catalogue (compose reference)
 *
 * Sources resolve from `path` (filesystem) or `storage_key` (Crow storage,
 * via the repo's s3-client when reachable; env-configured MinIO fallback).
 * Renders land in the work dir (SUNVOX_WORKDIR, default
 * ~/.crow/data/sunvox-studio/) and the returned path can be handed straight
 * to fw_upload_track for Funkwhale/glasses playback.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import * as engine from "./sunvox-engine.js";

const WORKDIR = process.env.SUNVOX_WORKDIR || path.join(os.homedir(), ".crow", "data", "sunvox-studio");

// --- Lazy storage import (works from the repo tree; degrades with a clear error) ---
let storageMod = null;
let storageTried = false;
async function storage() {
  if (storageTried) return storageMod;
  storageTried = true;
  for (const rel of ["../../../servers/storage/s3-client.js", "../../../../crow/servers/storage/s3-client.js"]) {
    try {
      storageMod = await import(rel);
      if (await storageMod.isAvailable()) return storageMod;
    } catch { /* try next */ }
  }
  storageMod = null;
  return null;
}

async function readSource({ path: p, storage_key }) {
  if (p) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
    return { buf: await fsp.readFile(abs), name: path.basename(abs) };
  }
  if (storage_key) {
    const s3 = await storage();
    if (!s3) throw new Error(`storage unavailable — pass a filesystem "path" instead of storage_key "${storage_key}" (storage needs MINIO_* env or the repo s3-client)`);
    const { stream } = await s3.getObject(storage_key);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return { buf: Buffer.concat(chunks), name: path.basename(storage_key) };
  }
  throw new Error('provide either "path" or "storage_key"');
}

const SOURCE_SCHEMA = {
  path: z.string().optional().describe("Filesystem path to a .sunvox/.xm/.mod file"),
  storage_key: z.string().optional().describe("Crow storage key (s3_key) of the project file"),
};

function sanitize(n) { return String(n).replace(/[^a-zA-Z0-9 _.-]/g, "").slice(0, 80) || "sunvox"; }

async function ensureWorkdir() { await fsp.mkdir(WORKDIR, { recursive: true }); return WORKDIR; }

function convertWithFfmpeg(wavPath, outPath) {
  const ff = spawnSync("ffmpeg", ["-y", "-i", wavPath, "-codec:a", outPath.endsWith(".mp3") ? "libmp3lame" : "libvorbis", "-qscale:a", "4", outPath], { encoding: "utf8" });
  if (ff.status !== 0) throw new Error(`ffmpeg conversion failed (is ffmpeg installed?): ${String(ff.stderr).slice(-400)}`);
  return outPath;
}

async function renderToFile(buf, { name, format }) {
  const dir = await ensureWorkdir();
  const { info, wav } = await engine.render(buf);
  const base = path.join(dir, `${sanitize(name)}-${Date.now()}`);
  const wavPath = `${base}.wav`;
  await fsp.writeFile(wavPath, wav);
  let outPath = wavPath;
  if (format === "mp3" || format === "ogg") {
    outPath = `${base}.${format}`;
    convertWithFfmpeg(wavPath, outPath);
    await fsp.unlink(wavPath).catch(() => {});
  }
  const stat = await fsp.stat(outPath);
  return { info, path: outPath, format: path.extname(outPath).slice(1), size_bytes: stat.size, duration_s: info.duration_s };
}

export function createSunvoxServer() {
  const server = new McpServer({ name: "sunvox-studio", version: "0.1.0" });

  server.registerTool("sunvox_module_types", {
    title: "Module catalogue",
    description: "The SunVox module-type catalogue: every synthesizer/effect/controller type with its parameters (name, min, max, kind, default). This is the reference for writing sunvox_compose specs. Output exists automatically at module 0 — reference it as \"out\" in connections, never create it.",
    inputSchema: {},
  }, async () => {
    const cat = await engine.moduleCatalogue();
    return { content: [{ type: "text", text: JSON.stringify(cat, null, 1) }] };
  });

  server.registerTool("sunvox_info", {
    title: "Inspect a project",
    description: "Structured metadata for a SunVox/XM/MOD file: name, BPM, TPL, duration, module list (type/name/kind/controller count), pattern list (name/tracks/lines). Cheap and safe — use it to look at any track before rendering or editing.",
    inputSchema: SOURCE_SCHEMA,
  }, async (args) => {
    try {
      const { buf, name } = await readSource(args);
      const info = await engine.info(buf);
      return { content: [{ type: "text", text: JSON.stringify({ source: name, ...info }, null, 1) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `sunvox_info failed: ${err.message}` }] };
    }
  });

  server.registerTool("sunvox_render", {
    title: "Render to audio",
    description: "Offline-render a SunVox/XM/MOD project to an audio file (wav, or mp3/ogg via ffmpeg). ~130x realtime. Returns the output path — hand it to fw_upload_track for Funkwhale, or play it via the glasses. No audio device needed on this machine.",
    inputSchema: {
      ...SOURCE_SCHEMA,
      format: z.enum(["wav", "mp3", "ogg"]).default("wav").describe("Output format (mp3/ogg need ffmpeg)"),
      out_name: z.string().optional().describe("Base filename (default: source name)"),
    },
  }, async (args) => {
    try {
      const { buf, name } = await readSource(args);
      const res = await renderToFile(buf, { name: args.out_name || path.parse(name).name, format: args.format || "wav" });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 1) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `sunvox_render failed: ${err.message}` }] };
    }
  });

  server.registerTool("sunvox_compose", {
    title: "Compose a project",
    description:
      "Build a SunVox project programmatically from a JSON spec, save it as .sunvox, and optionally render it in the same call. " +
      "Spec: { bpm? (1-255), tpl? (1-32), modules: [{ id, type, name?, params?: {controllerName: value}, x?, y? }], connections?: [[srcId, ..., \"out\"], ...] (chains; modules not used as a chain source auto-connect to Output), patterns: [{ name?, tracks, lines, x?, y?, events: [{ track, line, note (\"C3\"/\"F#4\"/1-127), velocity? (1-129), module (id), ctl?/ctl_val? or effect?/effect_param?, note_off? }] }] }. " +
      "Use sunvox_module_types first to pick module types and param names. Notes: C0=1; a line is one tick (TPL ticks per beat). Keep patterns 16-64 lines; place successive patterns at x = previous x + lines.",
    inputSchema: {
      spec: z.record(z.string(), z.any()).describe("The composition spec (see tool description)"),
      name: z.string().default("crow-compose").describe("Project/file name"),
      render: z.boolean().default(false).describe("Also render to audio in the same call"),
      format: z.enum(["wav", "mp3", "ogg"]).default("wav").describe("Render format when render=true"),
    },
  }, async (args) => {
    try {
      const { project, info } = await engine.compose(args.spec, { name: args.name });
      const dir = await ensureWorkdir();
      const projectPath = path.join(dir, `${sanitize(args.name)}.sunvox`);
      await fsp.writeFile(projectPath, project);
      const out = { project_path: projectPath, project_bytes: project.length, info };
      if (args.render) {
        const res = await renderToFile(project, { name: args.name, format: args.format || "wav" });
        out.render_path = res.path;
        out.render_format = res.format;
        out.render_size_bytes = res.size_bytes;
        out.duration_s = res.duration_s;
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `sunvox_compose failed: ${err.message}` }] };
    }
  });

  return server;
}
