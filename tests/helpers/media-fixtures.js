/**
 * Shared fixtures for the media bundle tests: a real init-db'd database with the bundle's own
 * tables, a fake local voice server that speaks the OpenAI speech shape Kokoro serves, synthetic
 * MP3 bytes in the format that engine returns (MPEG-2 Layer III, 24 kHz, 128 kbps, mono), and a
 * feed server. Feed addresses and names are made up (example.invalid); nothing here is a real source.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../../servers/db.js";
import { initMediaTables } from "../../bundles/media/server/init-tables.js";

export const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const FRAME_SECONDS = 576 / 24000;   // 0.024 s
export const FRAME_BYTES = 384;

/** A real core schema (schedules, notifications, settings) plus the media tables. */
export async function freshMediaDb(prefix = "crow-media") {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_HOME: dir, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") }, stdio: "pipe", cwd: REPO });
  const dbPath = join(dir, "crow.db");
  const db = createDbClient(dbPath);
  const quiet = console.error;
  console.error = () => {};
  try { await initMediaTables(db); } finally { console.error = quiet; }
  return { dir, dbPath, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

/** `frames` MPEG-2 Layer III frames (0.024 s each), optionally wrapped the way encoders wrap them. */
export function fakeMp3(frames, { id3 = true, xing = false, tag = false } = {}) {
  const frame = (fill) => { const f = Buffer.alloc(FRAME_BYTES, 0); f[0] = 0xff; f[1] = 0xf3; f[2] = 0xc4; f[3] = 0xc4; if (fill) f.write(fill, 21, "latin1"); return f; };
  const parts = [];
  if (id3) { const h = Buffer.alloc(10 + 34, 0); h.write("ID3", 0, "latin1"); h[3] = 4; h[9] = 34; parts.push(h); }
  if (xing) parts.push(frame("Info"));
  for (let i = 0; i < frames; i++) parts.push(frame(""));
  if (tag) { const t = Buffer.alloc(128, 0); t.write("TAG", 0, "latin1"); parts.push(t); }
  return Buffer.concat(parts);
}

/**
 * A local voice server. Each request is recorded; the reply is one frame per 5 input characters,
 * unless `mode` says otherwise: "wav" (not MP3), "error" (HTTP 500), "stall" (headers, then nothing),
 * "cut" (half the bytes, then the socket is destroyed).
 */
export async function startFakeVoice({ mode = "ok", voices = ["af_heart", "af_bella", "ef_dora"] } = {}) {
  const requests = [];
  const state = { mode };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/audio/voices") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ voices })); }
    if (req.method !== "POST" || req.url !== "/v1/audio/speech") { res.writeHead(404); return res.end(); }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const json = JSON.parse(body);
      requests.push(json);
      if (state.mode === "error") { res.writeHead(500, { "Content-Type": "text/plain" }); return res.end("engine failed"); }
      if (state.mode === "wav") { res.writeHead(200, { "Content-Type": "audio/wav" }); return res.end(Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), Buffer.alloc(4000, 1)])); }
      const bytes = fakeMp3(Math.max(1, Math.ceil(String(json.input).length / 5)));
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      if (state.mode === "stall") return res.write(bytes.subarray(0, 100));
      if (state.mode === "cut") { res.write(bytes.subarray(0, Math.floor(bytes.length / 2))); return setTimeout(() => res.destroy(), 20); }
      res.end(bytes);
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests, state,
    async close() { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); },
  };
}

/** Voice profiles as an instance has them: a cloud profile marked default, then local ones. */
export async function setVoiceProfiles(db, profiles) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('tts_profiles', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [JSON.stringify(profiles)],
  });
}
export const CLOUD_DEFAULT = { id: "cloud1", name: "Cloud voice", provider: "edge", apiKey: "", baseUrl: "", defaultVoice: "en-US-JennyNeural", isDefault: true };
export const localVoice = (baseUrl, extra = {}) => ({ id: "local1", name: "Local voice", provider: "kokoro", apiKey: "", baseUrl, defaultVoice: "af_heart", isDefault: false, ...extra });

export async function seedSource(db, { name, url, type = "rss", enabled = 1, category = null }) {
  const r = await db.execute({ sql: "INSERT INTO media_sources (source_type, name, url, category, enabled) VALUES (?, ?, ?, ?, ?)", args: [type, name, url, category, enabled] });
  return Number(r.lastInsertRowid);
}

export async function seedArticle(db, { source_id, title, summary = null, content_full = null, pub_date, url = null, audio_url = null, guid = null }) {
  const r = await db.execute({
    sql: `INSERT INTO media_articles (source_id, guid, url, title, pub_date, summary, content_full, audio_url, content_fetch_status, ai_analysis_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
    args: [source_id, guid || `${title}|${pub_date}`, url, title, pub_date, summary, content_full, audio_url],
  });
  return Number(r.lastInsertRowid);
}

/** A feed server: `feeds` maps a path to a function returning { status?, headers?, body }. */
export async function startFeedServer(feeds) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url, etag: req.headers["if-none-match"] || null });
    const make = feeds[req.url];
    if (!make) { res.writeHead(404); return res.end("not found"); }
    const out = make(req);
    res.writeHead(out.status || 200, { "Content-Type": "application/rss+xml", ...(out.headers || {}) });
    res.end(out.body || "");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${server.address().port}`, hits, async close() { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); } };
}

export function rss(title, items) {
  const item = (i) => `<item><title>${i.title}</title><link>${i.link || ""}</link><guid>${i.guid || i.title}</guid><pubDate>${i.pubDate}</pubDate>` +
    `<description><![CDATA[${i.description || ""}]]></description>${i.enclosure ? `<enclosure url="${i.enclosure}" length="1" type="audio/mpeg"/>` : ""}` +
    `${i.duration ? `<itunes:duration>${i.duration}</itunes:duration>` : ""}</item>`;
  return `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${title}</title>${items.map(item).join("")}</channel></rss>`;
}
