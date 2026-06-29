/**
 * Embedding client + BLOB+JS cosine-similarity search.
 *
 * Phase 4 semantic memory. Uses grackle's vLLM-CUDA Qwen3-Embedding-0.6B
 * endpoint as the primary provider, falls back to Ollama's nomic-embed-text
 * (used by spring-2026) if grackle is offline.
 *
 * Vectors stored as Float32Array serialized to BLOB. In-process scan over
 * the candidate set suffices for personal-KB scale (<10K items).
 *
 * Providers resolved from models.json via existing providers.js loader.
 */

import { loadProviders } from "../shared/providers.js";
import { createDbClient } from "../db.js";

// Fallback when no provider is configured via env or the dashboard setting.
const FALLBACK_PROVIDER = "grackle-embed";
const EMBED_TIMEOUT_MS = 10_000;
const FETCH_RETRIES = 1;

// Default embedding-provider resolution, in priority order:
//   1. CROW_EMBED_PROVIDER env var (headless/scripts/gateway via .env)
//   2. dashboard_settings 'embed_provider' (shared crow.db — reaches every
//      process, including the MCP servers Claude Code spawns, with no
//      re-registration; settable from the dashboard)
//   3. FALLBACK_PROVIDER ("grackle-embed") — preserves prior behavior
// Cached for 30s so the hot embed path stays cheap.
let _defaultProviderCache = null;
let _defaultProviderAt = 0;
const DEFAULT_PROVIDER_TTL_MS = 30_000;

export async function resolveDefaultProvider() {
  if (process.env.CROW_EMBED_PROVIDER) return process.env.CROW_EMBED_PROVIDER;
  if (_defaultProviderCache && Date.now() - _defaultProviderAt < DEFAULT_PROVIDER_TTL_MS) {
    return _defaultProviderCache;
  }
  let resolved = FALLBACK_PROVIDER;
  try {
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'embed_provider'",
        args: [],
      });
      const v = rows?.[0]?.value;
      if (v && String(v).trim()) resolved = String(v).trim();
    } finally {
      db.close?.();
    }
  } catch {
    // DB unavailable — keep the fallback.
  }
  _defaultProviderCache = resolved;
  _defaultProviderAt = Date.now();
  return resolved;
}

// -----------------------------------------------------------------------
// Provider resolution
// -----------------------------------------------------------------------

function resolveEmbedConfig(providerName = FALLBACK_PROVIDER) {
  const cfg = loadProviders();
  const p = cfg.providers?.[providerName];
  if (!p || !p.baseUrl) {
    throw new Error(`embedding provider "${providerName}" not configured in models.json`);
  }
  const model = p.models?.[0]?.id || "default";
  const dim = p.models?.[0]?.dim || null;
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, model, dim, name: providerName };
}

// -----------------------------------------------------------------------
// Embed API call
// -----------------------------------------------------------------------

/**
 * Embed a single text (or array of texts).
 * Returns Float32Array (for single) or Float32Array[] (for array).
 */
export async function embedText(text, { providerName } = {}) {
  const cfg = resolveEmbedConfig(providerName || (await resolveDefaultProvider()));
  const isArray = Array.isArray(text);
  const input = isArray ? text : [text];

  const body = JSON.stringify({ model: cfg.model, input });
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey && cfg.apiKey !== "none") {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/embeddings", {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastErr = new Error(`embed HTTP ${res.status} from ${cfg.name}`);
        continue;
      }
      const json = await res.json();
      const vecs = json.data.map((d) => Float32Array.from(d.embedding));
      return isArray ? vecs : vecs[0];
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("embed failed");
}

/**
 * Query the health/config of an embedding provider.
 * Returns { ok, model, dim, baseUrl } or { ok: false, error }.
 */
export async function embedProviderInfo(providerName) {
  try {
    const cfg = resolveEmbedConfig(providerName || (await resolveDefaultProvider()));
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/models", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const data = await res.json();
    const m = data.data?.[0];
    return {
      ok: true,
      provider: cfg.name,
      baseUrl: cfg.baseUrl,
      model: m?.id || cfg.model,
      dim: cfg.dim,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// -----------------------------------------------------------------------
// BLOB <-> Float32Array serialization
// -----------------------------------------------------------------------

/**
 * Serialize a Float32Array into a Buffer (BLOB) for storage.
 */
export function vecToBlob(vec) {
  // Float32Array's underlying buffer → Node Buffer
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize a BLOB (Buffer or ArrayBuffer) back into Float32Array.
 */
export function blobToVec(blob) {
  if (!blob) return null;
  // libsql returns BLOBs as either Buffer (Node) or Uint8Array
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  // Ensure 4-byte alignment for Float32Array view
  const aligned = buf.byteOffset % 4 === 0
    ? buf
    : Buffer.from(buf); // copy to aligned
  return new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 4)
  );
}

// -----------------------------------------------------------------------
// Cosine similarity
// -----------------------------------------------------------------------

/**
 * Cosine similarity between two Float32Arrays of equal length.
 * Returns a number in [-1, 1]. Higher = more similar.
 */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return -Infinity;
  let dot = 0, na = 0, nb = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Rank candidate vectors against a query vector by cosine similarity.
 * candidates: Array<{ id, vec, ...extra }>
 * Returns sorted descending by similarity, each entry augmented with `score`.
 */
export function rankByCosine(query, candidates, topK = 10) {
  const scored = [];
  for (const c of candidates) {
    const v = c.vec instanceof Float32Array ? c.vec : blobToVec(c.vec);
    scored.push({ ...c, vec: v, score: cosineSim(query, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// -----------------------------------------------------------------------
// DB helpers (one per table, kept consistent)
// -----------------------------------------------------------------------

/**
 * Upsert an embedding for a memory.
 */
export async function upsertMemoryEmbedding(db, memoryId, vec, { model, dim }) {
  await db.execute({
    sql: `INSERT INTO memory_embeddings_blob (memory_id, model, dim, vec)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(memory_id) DO UPDATE SET
            model = excluded.model,
            dim = excluded.dim,
            vec = excluded.vec,
            created_at = datetime('now')`,
    args: [memoryId, model, dim, vecToBlob(vec)],
  });
}

/**
 * Load all memory embeddings (optionally filtered by model).
 * Returns Array<{ memory_id, vec: Float32Array, model, dim }>.
 */
export async function loadMemoryEmbeddings(db, { model } = {}) {
  const sql = model
    ? "SELECT memory_id, model, dim, vec FROM memory_embeddings_blob WHERE model = ?"
    : "SELECT memory_id, model, dim, vec FROM memory_embeddings_blob";
  const args = model ? [model] : [];
  const { rows } = await db.execute({ sql, args });
  return rows.map((r) => ({
    id: r.memory_id,
    memory_id: r.memory_id,
    model: r.model,
    dim: r.dim,
    vec: blobToVec(r.vec),
  }));
}

// Same pattern for sources / notes / blog posts — kept DRY via generic helpers:

function emitGeneric(kind, idCol, table) {
  return {
    async upsert(db, id, vec, { model, dim }) {
      await db.execute({
        sql: `INSERT INTO ${table} (${idCol}, model, dim, vec)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(${idCol}) DO UPDATE SET
                model = excluded.model,
                dim = excluded.dim,
                vec = excluded.vec,
                created_at = datetime('now')`,
        args: [id, model, dim, vecToBlob(vec)],
      });
    },
    async loadAll(db, { model } = {}) {
      const sql = model
        ? `SELECT ${idCol}, model, dim, vec FROM ${table} WHERE model = ?`
        : `SELECT ${idCol}, model, dim, vec FROM ${table}`;
      const args = model ? [model] : [];
      const { rows } = await db.execute({ sql, args });
      return rows.map((r) => ({
        id: r[idCol],
        [idCol]: r[idCol],
        model: r.model,
        dim: r.dim,
        vec: blobToVec(r.vec),
      }));
    },
  };
}

export const sourceEmbeddings = emitGeneric("source", "source_id", "source_embeddings");
export const noteEmbeddings = emitGeneric("note", "note_id", "note_embeddings");
export const blogEmbeddings = emitGeneric("blog", "post_id", "blog_post_embeddings");
