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
 * Sources resolve from `path` (inside the work dir) or `storage_key` (Crow
 * storage, via the app's s3-client resolved through server/app-root.js).
 * Renders and projects land in the work dir (SUNVOX_WORKDIR, default
 * ~/.crow/data/sunvox-studio/) and, when storage is available, in Crow
 * storage too (server/outputs.js: storage key, storage_files row, short-lived
 * URL). A render can also go straight into a Funkwhale library
 * (server/funkwhale-push.js) and raise a notification when it is done.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import * as engine from "./sunvox-engine.js";
import { saveToStorage, storageMode, notifyDone, mimeFor, REFERENCE_TYPES } from "./outputs.js";
import { pushToFunkwhale } from "./funkwhale-push.js";

/** "~/x" → <home>/x (an installed entry can carry the manifest's "~/" default verbatim). */
export function expandHome(p) {
  const s = String(p);
  return s === "~" || s.startsWith("~/") ? path.join(os.homedir(), s.slice(1)) : s;
}

/** This instance's data dir + sunvox-studio (a second instance gets its own). */
async function defaultWorkdir() {
  try {
    const { appImport } = await import("./app-root.js");
    const { resolveInstanceDataDir } = await appImport("servers/shared/crow-home.js");
    return path.join(resolveInstanceDataDir(), "sunvox-studio");
  } catch {
    return path.join(os.homedir(), ".crow", "data", "sunvox-studio");
  }
}
export const WORKDIR = path.resolve(process.env.SUNVOX_WORKDIR ? expandHome(process.env.SUNVOX_WORKDIR) : await defaultWorkdir());

// --- Lazy storage import (works from the repo tree; degrades with a clear error) ---
let storageMod = null;
let storageInit = false;
/**
 * Crow storage through the app's own s3-client, resolved via the app root
 * (CROW_APP_ROOT, in-repo run, or ~/crow) so installed copies find it too.
 *
 * Storage is usually configured in the Nest (storage.shared.* settings, with
 * sealed secrets), not in the environment. The gateway opens those with the
 * instance identity (initStorage); this child does the same once, with the
 * identity loaded ONLY if it exists (never created), and falls back to the
 * MINIO_* environment like the stdio storage server.
 */
async function storage() {
  // Only a working client is cached: storage that was down at the first call
  // is retried on the next one instead of staying off for the session.
  if (storageMod) return storageMod;
  try {
    const { appImport } = await import("./app-root.js");
    const mod = await appImport("servers/storage/s3-client.js");
    if (!storageInit) {
      storageInit = true;
      try {
        const { loadIdentityIfPresent } = await appImport("servers/sharing/identity.js");
        const identity = typeof loadIdentityIfPresent === "function" ? loadIdentityIfPresent() : null;
        if (identity) await mod.initStorage({ db: await sharedDb(), identity });
      } catch { /* env fallback (MINIO_*) stays active */ }
    }
    storageMod = (await mod.isAvailable()) ? mod : null;
  } catch {
    storageMod = null;
  }
  return storageMod;
}

let dbClient = null;
async function sharedDb() {
  if (!dbClient) {
    const { appImport } = await import("./app-root.js");
    dbClient = (await appImport("servers/db.js")).createDbClient();
  }
  return dbClient;
}

/** Largest project file accepted (SunVox projects are typically < 5 MB). */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/**
 * Directories a filesystem `path` may point into: the work dir (compose
 * output, renders) plus any extra SUNVOX_READ_DIRS (colon-separated) the
 * operator configures. Anything else is refused, so a tool call cannot feed
 * arbitrary host files to the native parser.
 */
export function readRoots() {
  // Relative entries resolve against the work dir, never the process cwd.
  const extra = String(process.env.SUNVOX_READ_DIRS || "").split(":").map((d) => d.trim()).filter(Boolean)
    .map((d) => path.resolve(WORKDIR, expandHome(d)));
  return [WORKDIR, ...extra].map((d) => { try { return fs.realpathSync(d); } catch { return d; } });
}

export function resolveReadablePath(p) {
  const abs = path.resolve(WORKDIR, p);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const real = fs.realpathSync(abs);
  const ok = readRoots().some((root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  if (!ok) throw new Error(`path is outside the SunVox work dir (${WORKDIR}); copy the file there, use storage_key, or add its folder to SUNVOX_READ_DIRS`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`not a file: ${abs}`);
  if (st.size > MAX_SOURCE_BYTES) throw new Error(`file is ${st.size} bytes; the limit is ${MAX_SOURCE_BYTES}`);
  return real;
}

// --- App modules, resolved lazily through the app root (tests inject fakes) ---
async function appDeps() {
  const { appImport } = await import("./app-root.js");
  return {
    db: sharedDb,
    createNotification: async (...a) => (await appImport("servers/shared/notifications.js")).createNotification(...a),
    consumeToken: async (...a) => (await appImport("servers/shared/rate-limiter.js")).consumeToken(...a),
    musicConfig: async () => (await appImport("servers/gateway/media/pinned-upstream.js")).musicUpstreamConfig(),
  };
}

async function readSource({ path: p, storage_key }) {
  if (p) {
    const real = resolveReadablePath(p);
    return { buf: await fsp.readFile(real), name: path.basename(real) };
  }
  if (storage_key) {
    const s3 = await storage();
    if (!s3) throw new Error(`storage unavailable — pass a filesystem "path" instead of storage_key "${storage_key}" (storage needs MINIO_* env or the repo s3-client)`);
    const { stream, stat } = await s3.getObject(storage_key);
    if (stat && stat.size > MAX_SOURCE_BYTES) {
      stream.destroy?.();
      throw new Error(`storage object is ${stat.size} bytes; the limit is ${MAX_SOURCE_BYTES}`);
    }
    const chunks = [];
    let total = 0;
    for await (const c of stream) {
      total += c.length;
      if (total > MAX_SOURCE_BYTES) { stream.destroy?.(); throw new Error(`storage object exceeds ${MAX_SOURCE_BYTES} bytes`); }
      chunks.push(c);
    }
    return { buf: Buffer.concat(chunks), name: path.basename(storage_key) };
  }
  throw new Error('provide either "path" or "storage_key"');
}

const SOURCE_SCHEMA = {
  path: z.string().optional().describe("Path to a .sunvox/.xm/.mod file inside the SunVox work dir (relative paths resolve there; extra folders via SUNVOX_READ_DIRS)"),
  storage_key: z.string().optional().describe("Crow storage key (s3_key) of the project file"),
};

function sanitize(n) { return String(n).replace(/[^a-zA-Z0-9 _.-]/g, "").slice(0, 80) || "sunvox"; }

async function ensureWorkdir() { await fsp.mkdir(WORKDIR, { recursive: true }); return WORKDIR; }

/** Tags written into mp3/ogg renders. A music library such as Funkwhale
 *  imports a file only when it carries a title, an artist and an album. */
export function renderTags(title) {
  const clean = String(title || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "SunVox render";
  return { title: clean, artist: "Crow", album: "SunVox Studio" };
}

function convertWithFfmpeg(wavPath, outPath, tags = {}) {
  const meta = Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
  const ff = spawnSync("ffmpeg", ["-y", "-i", wavPath, "-codec:a", outPath.endsWith(".mp3") ? "libmp3lame" : "libvorbis", "-qscale:a", "4", ...meta, outPath], { encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (ff.status !== 0) throw new Error(`ffmpeg conversion failed (is ffmpeg installed?): ${String(ff.stderr).slice(-400)}`);
  return outPath;
}

async function renderToFile(buf, { name, format, sampleRate = 44100 }) {
  const dir = await ensureWorkdir();
  const { info, wav, frames } = await engine.render(buf, { sampleRate });
  const title = info.name || name;
  const base = path.join(dir, `${sanitize(name)}-${Date.now()}`);
  const wavPath = `${base}.wav`;
  await fsp.writeFile(wavPath, wav);
  let outPath = wavPath;
  if (format === "mp3" || format === "ogg") {
    outPath = `${base}.${format}`;
    convertWithFfmpeg(wavPath, outPath, renderTags(title));
    await fsp.unlink(wavPath).catch(() => {});
  }
  const stat = await fsp.stat(outPath);
  // duration_s: the audio written (the song plus up to 2 s of effect tail); song_duration_s: the song.
  return { info, path: outPath, format: path.extname(outPath).slice(1), sample_rate: sampleRate, size_bytes: stat.size, duration_s: +(frames / sampleRate).toFixed(3), song_duration_s: info.duration_s };
}

const OUTPUT_SCHEMA = {
  save_to_storage: z.boolean().optional().describe("Save to Crow storage (default: yes when storage is available; true = fail if it is not; false = local file only)"),
  reference_type: z.enum(REFERENCE_TYPES).optional().describe("blog_post: attach to a blog/song post, which makes the stored file PUBLIC at /blog/media/<key> (a song page's player fetches it there)"),
  reference_id: z.number().int().optional().describe("ID of the referenced post"),
};
const RENDER_OPTS_SCHEMA = {
  sample_rate: z.union([z.literal(44100), z.literal(48000)]).optional().describe("Output sample rate (default 44100)"),
  notify: z.boolean().optional().describe("Raise a Crow notification when the render is done"),
  funkwhale_library: z.string().max(200).optional().describe("Also upload the render (mp3/ogg) to this Funkwhale library, by UUID or name, so fw_play can play it (needs the Funkwhale add-on)"),
};

/**
 * Store one finished file (render or project) per the save_to_storage /
 * reference_type options. → fields to merge into the tool result.
 */
async function storeOutput(deps, { buf, fileName, kind, args }) {
  const s3 = await deps.storage();
  const mode = storageMode(args.save_to_storage, !!s3);
  if (mode === "off") return {};
  if (mode === "skip-unavailable") return { storage: "not saved: storage is not available (the file is in the local work dir)" };
  try {
    return await saveToStorage({
      s3, db: await deps.db(), buf, fileName, mimeType: mimeFor(path.extname(fileName).slice(1)), kind,
      referenceType: args.reference_type ?? null, referenceId: args.reference_id ?? null,
    });
  } catch (err) {
    // Asked for explicitly: the call fails. Otherwise the local file stands and the reason is reported.
    if (args.save_to_storage === true) throw err;
    return { storage: `not saved: ${err.message} (the file is in the local work dir)` };
  }
}

/** Storage, Funkwhale and the notification for one finished render. */
async function deliverRender(deps, res, { name, args }) {
  const buf = await fsp.readFile(res.path);
  const out = {};
  const st = await storeOutput(deps, { buf, fileName: path.basename(res.path), kind: "renders", args });
  for (const [k, v] of Object.entries(st)) out[k === "url" ? "storage_url" : k === "url_expires_in_s" ? "storage_url_expires_in_s" : k] = v;
  if (args.funkwhale_library) {
    try {
      out.funkwhale = await pushToFunkwhale({
        cfg: await deps.musicConfig(), buf, fileName: path.basename(res.path), library: args.funkwhale_library,
        fetchImpl: deps.fetchImpl || fetch, db: await deps.db().catch(() => null), consumeToken: deps.consumeToken,
      });
    } catch (err) {
      out.funkwhale = { error: err.message };
    }
  }
  if (args.notify) {
    let n;
    try {
      n = await notifyDone({ createNotification: deps.createNotification, db: await deps.db() }, { name, format: res.format, duration_s: res.duration_s, storage_key: out.storage_key || null });
    } catch (err) {
      n = { notified: false, error: err.message };
    }
    out.notified = n.notified;
    if (n.error) out.notify_error = n.error;
  }
  return out;
}

// The spec compose() (sunvox-engine.js) reads, as a typed schema: the old
// z.record(z.string(), z.any()) published {} values, which a grammar-constrained
// local model can only fill with objects (queue item 26). Types only — the
// engine keeps every range/count check and its messages. Nullable where the
// engine treats null as "not given"; objects stay open (the engine ignores
// unknown keys). A spec sent as a JSON string is parsed first. Inside the
// nested objects short fields come first, bodies last (a JSON-grammar engine
// admits optional keys only in declared order).
export function parseJsonObjectString(v) {
  if (typeof v !== "string" || !v.trim().startsWith("{")) return v;
  try { const o = JSON.parse(v); return o && typeof o === "object" && !Array.isArray(o) ? o : v; } catch { return v; }
}
function composeSpecSchema() {
  const num = () => z.number().nullable().optional();
  const module = z.object({
    id: z.string().describe("your id for this module, used in connections and events"),
    type: z.string().describe("a type from sunvox_module_types"),
    name: z.string().nullable().optional(),
    x: num(),
    y: num(),
    params: z.record(z.string(), z.number()).nullable().optional().describe("controller name → number"),
  }).passthrough();
  const event = z.object({
    track: num(),
    line: num(),
    module: z.string().optional().describe("module id"),
    note: z.union([z.string(), z.number()]).nullable().optional().describe("\"C3\" / \"F#4\" or 1-127"),
    velocity: num().describe("1-129"),
    note_off: z.boolean().optional(),
    ctl: z.number().optional(),
    ctl_val: num(),
    effect: z.number().optional(),
    effect_param: num(),
  }).passthrough();
  const pattern = z.object({
    name: z.string().nullable().optional(),
    id: z.union([z.string(), z.number()]).nullable().optional(),
    tracks: num(),
    lines: num(),
    x: num(),
    y: num(),
    events: z.array(event).optional(),
  }).passthrough();
  return z.preprocess(parseJsonObjectString, z.object({
    bpm: num(),
    tpl: num(),
    modules: z.array(module),
    connections: z.array(z.array(z.string())).nullable().optional().describe("chains of module ids; \"out\" is the Output"),
    patterns: z.array(pattern),
    arrangement: z.array(z.object({
      pattern: z.union([z.string(), z.number()]).describe("a pattern id"),
      x: num().describe("start line; default: right after the previous placement"),
      y: num().describe("timeline row; default 0"),
    }).passthrough()).nullable().optional().describe("the timeline, in order; a pattern placed twice repeats"),
  }).passthrough()).describe("The composition spec (see tool description)");
}

/**
 * @param {object} [inject] test seams: storage() → s3-client-like or null,
 *   db() → db client, createNotification, consumeToken, musicConfig(), fetchImpl.
 */
export function createSunvoxServer(inject = {}) {
  const server = new McpServer({ name: "sunvox-studio", version: "0.2.0" });
  let lazy = null;
  const app = async () => (lazy ||= await appDeps());
  const deps = {
    storage: inject.storage || storage,
    db: inject.db || (async () => (await app()).db()),
    createNotification: inject.createNotification || (async (...a) => (await app()).createNotification(...a)),
    consumeToken: inject.consumeToken || (async (...a) => (await app()).consumeToken(...a)),
    musicConfig: inject.musicConfig || (async () => { try { return await (await app()).musicConfig(); } catch { return null; } }),
    fetchImpl: inject.fetchImpl || null,
  };

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
    description: "Structured metadata for a SunVox/XM/MOD file: format, name, project version, BPM, TPL (and the effective tempo), duration, module list (type/name/kind/controller count/x/y/colour), pattern list (name/tracks/lines/x/y on the timeline). Cheap and safe — use it to look at any track before rendering or editing.",
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
    description: "Offline-render a SunVox/XM/MOD project to audio (wav, or mp3/ogg via ffmpeg), ~130x realtime, up to 20 minutes. Saves it to Crow storage when storage is available and returns the storage_key plus a short-lived storage_url; the local path is returned too. funkwhale_library uploads it to Funkwhale so fw_play can play it on the glasses; notify raises a Crow notification when it is done. No audio device needed on this machine.",
    inputSchema: {
      ...SOURCE_SCHEMA,
      format: z.enum(["wav", "mp3", "ogg"]).default("wav").describe("Output format (mp3/ogg need ffmpeg; Funkwhale takes mp3/ogg)"),
      out_name: z.string().optional().describe("Base filename (default: source name)"),
      ...RENDER_OPTS_SCHEMA,
      ...OUTPUT_SCHEMA,
    },
  }, async (args) => {
    try {
      const { buf, name } = await readSource(args);
      const outName = args.out_name || path.parse(name).name;
      const res = await renderToFile(buf, { name: outName, format: args.format || "wav", sampleRate: args.sample_rate || 44100 });
      Object.assign(res, await deliverRender(deps, res, { name: outName, args }));
      return { content: [{ type: "text", text: JSON.stringify(res, null, 1) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `sunvox_render failed: ${err.message}` }] };
    }
  });

  server.registerTool("sunvox_compose", {
    title: "Compose a project",
    description:
      "Build a SunVox project programmatically from a JSON spec, save it as .sunvox, and optionally render it in the same call. " +
      "Spec: { bpm? (1-999), tpl? (1-31), modules: [{ id, type, name?, params?: {controllerName: value within its min..max}, x?, y? }], connections?: [[srcId, ..., \"out\"], ...] (chains; modules not used as a chain source auto-connect to Output), patterns: [{ id, tracks, lines, x?, y?, events: [{ track, line, note (\"C3\"/\"F#4\"/1-127), velocity? (1-129), module (id), ctl?/ctl_val? or effect?/effect_param?, note_off? }] }], arrangement?: [{ pattern (id), x?, y? }] (the timeline in order: a missing x starts after the previous placement; a pattern placed twice repeats; every pattern must be placed; it overrides the patterns' own x/y) }. " +
      "Use sunvox_module_types first to pick module types and param names. Notes: C0=1; a line is one tick (TPL ticks per beat). Keep patterns 16-64 lines. The name becomes the song name; an existing composition with the same name is kept unless overwrite is true. " +
      "Saves the project (and the render, with render=true) to Crow storage when it is available; reference_type blog_post makes them public for a song page (**SunVox:** storage:<key>).",
    inputSchema: {
      name: z.string().default("crow-compose").describe("Project/file name, also the song name"),
      overwrite: z.boolean().default(false).describe("Replace an existing composition with the same name in the work dir"),
      render: z.boolean().default(false).describe("Also render to audio in the same call"),
      format: z.enum(["wav", "mp3", "ogg"]).default("wav").describe("Render format when render=true"),
      ...RENDER_OPTS_SCHEMA,
      ...OUTPUT_SCHEMA,
      spec: composeSpecSchema(),
    },
  }, async (args) => {
    try {
      const dir = await ensureWorkdir();
      const projectPath = path.join(dir, `${sanitize(args.name)}.sunvox`);
      const exists = () => new Error(`a composition named "${sanitize(args.name)}" already exists in the work dir; pass overwrite: true to replace it, or pick another name`);
      if (!args.overwrite && fs.existsSync(projectPath)) throw exists();
      const { project, info } = await engine.compose(args.spec, { name: args.name });
      try {
        // "wx": a same-name compose that finished first in the meantime is not clobbered.
        await fsp.writeFile(projectPath, project, { flag: args.overwrite ? "w" : "wx" });
      } catch (err) {
        if (err.code === "EEXIST") throw exists();
        throw err;
      }
      const out = { project_path: projectPath, project_bytes: project.length, info };
      const st = await storeOutput(deps, { buf: project, fileName: path.basename(projectPath), kind: "projects", args });
      if (st.storage_key) {
        out.project_storage_key = st.storage_key;
        out.project_storage_url = st.url;
        if (st.media_path) out.project_media_path = st.media_path;
      } else if (st.storage) out.storage = st.storage;
      if (args.render) {
        const res = await renderToFile(project, { name: args.name, format: args.format || "wav", sampleRate: args.sample_rate || 44100 });
        out.render_path = res.path;
        out.render_format = res.format;
        out.render_size_bytes = res.size_bytes;
        out.sample_rate = res.sample_rate;
        out.duration_s = res.duration_s;
        out.song_duration_s = res.song_duration_s;
        const d = await deliverRender(deps, res, { name: args.name, args });
        if (d.storage_key) {
          out.render_storage_key = d.storage_key;
          out.render_storage_url = d.storage_url;
          if (d.media_path) out.render_media_path = d.media_path;
        } else if (d.storage) out.render_storage = d.storage;
        for (const k of ["funkwhale", "notified", "notify_error"]) if (d[k] !== undefined) out[k] = d[k];
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `sunvox_compose failed: ${err.message}` }] };
    }
  });

  return server;
}
