/**
 * Add a provider (roles phase 2b): test a pasted key in plain terms, choose a
 * provider id that never overwrites another account, and write one row shape.
 *
 * Every upstream call goes through `safeRequest` (presets in "cloud" mode,
 * "other" in "other" mode). The key is used only in request headers and the
 * stored row: it is never returned, and nothing here logs it (errors are
 * logged by `err.message`, which never carries headers).
 */
import { presetById, normalizeBaseUrl, ANTHROPIC_VERSION } from "../../shared/provider-presets.js";
import { recommendedFor, RECOMMENDATION_ROLES } from "../../shared/provider-recommendations.js";
import { upsertProvider, listProvidersAll } from "../../shared/providers-db.js";
import { invalidateProvidersCache } from "../../shared/providers.js";
import { getOwnAddresses } from "../../shared/locality.js";
import { classifyIp } from "../../shared/ip-classify.js";
import { isForbiddenTarget, isDoorUrl } from "../models/door-resolve.js";
import { gatewayPort } from "../models/door.js";
import { safeRequest, readJson, addressRefused } from "../models/safe-upstream.js";

const MAX_MODEL_IDS = 2000;
const MAX_MODEL_ID_LEN = 256;
const MAX_ID_LEN = 32;
const DOOR_ID_PREFIX = "crow-c-";

/** Trimmed key, or null when empty or holding anything outside printable ASCII without spaces. */
function cleanKey(apiKey) {
  const k = typeof apiKey === "string" ? apiKey.trim() : "";
  return k && /^[\x21-\x7e]+$/.test(k) ? k : null;
}

/** The base URL a test or write uses: a typed URL wins, then the variant's, then the preset's. */
function baseUrlFor(preset, { variantId, baseUrl }) {
  if (typeof baseUrl === "string" && baseUrl.trim()) return baseUrl.trim().replace(/\/+$/, "");
  if (preset.variants) {
    const v = variantId ? preset.variants.find((x) => x.id === variantId) : preset.variants[0];
    return v ? v.baseUrl : null;
  }
  return preset.baseUrl || null;
}

function labelFor(preset, variantId) {
  const v = preset.variants && (variantId ? preset.variants.find((x) => x.id === variantId) : preset.variants[0]);
  return v?.label || preset.label;
}

function authHeaders(preset, key) {
  if (preset.authStyle === "anthropic") return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  return { Authorization: `Bearer ${key}` };
}

const isHttpUrl = (u) => u.protocol === "http:" || u.protocol === "https:";

/** A target this gateway must never send a key to, checked before any request. */
function refusedTarget(u, mode) {
  if (isForbiddenTarget(u.href) || isDoorUrl(u.href)) return true;
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // m13: a loopback or own address on this gateway's port is the gateway itself.
  if (port === gatewayPort()) {
    const own = getOwnAddresses();
    if (own.has(host) || host === "localhost" || ["loopback", "unspecified"].includes(classifyIp(host).cls)) return true;
  }
  if (classifyIp(host).cls !== "invalid" && addressRefused(host, { mode, port })) return true;
  return false;
}

function codeForStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "key_rejected";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  return "provider_error";
}

function codeForError(err) {
  const c = err?.code;
  if (c === "FORBIDDEN_TARGET" || c === "UPSTREAM_ADDRESS_REFUSED") return "forbidden_target";
  if (c === "BAD_URL") return "bad_url";
  return "unreachable";
}

/** Model ids from an OpenAI-style `{data:[{id}]}`, an Ollama-style `{models:[{name}]}`, or a bare array. */
function idsFromListing(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (!list) return null;
  const ids = [];
  for (const m of list) {
    const id = typeof m === "string" ? m : (m?.id ?? m?.name);
    if (typeof id === "string" && id && id.length <= MAX_MODEL_ID_LEN && /^[^\x00-\x1f\x7f]+$/.test(id)) ids.push(id);
  }
  return ids;
}

const discard = (res) => { try { res?.stream?.destroy?.(); } catch {} };

/**
 * Test a key. Returns `{ok, code, status?, models, host, baseUrl?, truncated?}`:
 * never the key. `models` is the listing (≤ 2,000 ids), or null when there is
 * none; a listing that fails after the key passed still gives `ok`.
 */
export async function testProviderKey({ presetId, variantId, baseUrl, apiKey } = {}, { requestFn = safeRequest, timeoutMs = 8000 } = {}) {
  const preset = presetById(presetId);
  if (!preset) return { ok: false, code: "unknown_preset", models: null, host: null };
  const raw = baseUrlFor(preset, { variantId, baseUrl });
  let u = null;
  try { u = raw ? new URL(raw) : null; } catch {}
  const host = u ? u.hostname.replace(/^\[|\]$/g, "") : null;
  const out = (code, extra = {}) => ({ ok: code === "ok", code, models: null, host, ...extra });
  if (!u || !isHttpUrl(u) || u.username || u.password) return out("bad_url");
  const mode = preset.id === "other" ? "other" : "cloud";
  if (refusedTarget(u, mode)) return out("forbidden_target");
  const key = cleanKey(apiKey);
  if (!key) return out("bad_key");

  const base = u.href.replace(/\/+$/, "");
  const headers = authHeaders(preset, key);
  const call = async (path) => {
    try { return { res: await requestFn(base + path, { method: "GET", headers, mode, timeoutMs }) }; }
    catch (err) { return { err }; }
  };

  // Anthropic pages its listing (20 by default); ask for the largest page.
  const modelsPath = preset.authStyle === "anthropic" ? `${preset.modelsPath}?limit=1000` : preset.modelsPath;
  const testPath = preset.testPath === preset.modelsPath ? modelsPath : preset.testPath;
  const first = await call(testPath);
  if (first.err) return out(codeForError(first.err));
  const code = codeForStatus(first.res.status);
  if (code !== "ok") {
    discard(first.res);
    return out(code, { status: first.res.status, baseUrl: base });
  }

  // When the test and the list share a path, the test's answer is the list.
  let listing = first;
  if (testPath !== modelsPath) {
    discard(first.res);
    listing = await call(modelsPath);
  }
  let models = null;
  let truncated = false;
  if (!listing.err && codeForStatus(listing.res.status) === "ok") {
    try {
      const ids = idsFromListing(await readJson(listing.res, { maxBytes: 2_000_000 }));
      if (ids) {
        truncated = ids.length > MAX_MODEL_IDS;
        models = ids.slice(0, MAX_MODEL_IDS);
      }
    } catch { models = null; }
  } else discard(listing.res);
  return { ok: true, code: "ok", status: first.res.status, models, host, baseUrl: base, ...(truncated ? { truncated: true } : {}) };
}

function hostSlug(baseUrl) {
  let h = "";
  try { h = new URL(baseUrl).hostname; } catch {}
  return h.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

/** The id `n` of a base (n = 1 is the base itself), kept within 32 chars for custom ids. */
function nthId(base, n, capped) {
  if (n === 1) return capped ? base.slice(0, MAX_ID_LEN).replace(/-+$/, "") : base;
  const suffix = `-${n}`;
  return capped ? base.slice(0, MAX_ID_LEN - suffix.length).replace(/-+$/, "") + suffix : base + suffix;
}

/**
 * The provider id for a new account: the preset id when free; the same id
 * with `reuse: true` when that row has the same base URL and key; otherwise
 * `<id>-2`, `-3`, … `other` uses `custom-<host-slug>` (≤ 32 chars). Never an
 * id in the door namespace (`crow-c-`).
 */
export function providerIdFor(presetId, { rows = [], baseUrl, apiKey } = {}) {
  const custom = presetId === "other";
  const base = custom ? `custom-${hostSlug(baseUrl)}` : String(presetId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const wantUrl = normalizeBaseUrl(baseUrl);
  const wantKey = cleanKey(apiKey) ?? apiKey;
  for (let n = 1; n < 1000; n++) {
    const id = nthId(base, n, custom);
    if (id.startsWith(DOOR_ID_PREFIX)) continue;
    const row = byId.get(id);
    if (!row) return { id, reuse: false };
    const rowKey = row.apiKey ?? row.api_key ?? null;
    if (normalizeBaseUrl(row.baseUrl ?? row.base_url) === wantUrl && rowKey === wantKey) return { id, reuse: true };
  }
  throw new Error("no free provider id");
}

/** A models[] entry for one id, enriched from the recommendations when the file lists it. */
export function modelEntryFor(presetId, modelId) {
  const entry = { id: modelId };
  let embed = false, rerank = false, vision = false, context = null;
  for (const role of RECOMMENDATION_ROLES) {
    for (const e of recommendedFor(presetId, role)) {
      if (e.model_id !== modelId) continue;
      if (e.kind === "embed") embed = true;
      if (e.kind === "rerank") rerank = true;
      if (role === "vision") vision = true;
      if (context == null && Number.isFinite(e.context) && e.context > 0) context = e.context;
    }
  }
  if (embed) entry.task = "embedding";
  else if (rerank) entry.task = "rerank";
  if (vision) entry.input = ["text", "image"];
  if (context != null) entry.contextWindow = context;
  return entry;
}

function cleanModelIds(modelIds) {
  if (modelIds == null) return [];
  if (!Array.isArray(modelIds)) return null;
  const out = [];
  for (const m of modelIds) {
    if (typeof m !== "string") return null;
    const id = m.trim();
    if (!id || id.length > MAX_MODEL_ID_LEN || /[\x00-\x1f\x7f]/.test(id)) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out.length > MAX_MODEL_IDS ? null : out;
}

/**
 * Test, then write one providers row. Refuses unless the test passed (or, for
 * `other` with a typed model id, the server simply had no listing). On
 * `reuse`, the stored models are kept and the ticked ones added (I9), so a
 * model a role is bound to is never dropped. `onAdded(providerId)` runs after
 * the write (Task 15's consent seam).
 */
export async function addProvider(db, { presetId, variantId, baseUrl, apiKey, modelIds } = {}, {
  upsertProviderFn = upsertProvider, invalidateFn = invalidateProvidersCache,
  testFn = testProviderKey, listRowsFn = listProvidersAll, onAdded,
} = {}) {
  const preset = presetById(presetId);
  if (!preset) return { ok: false, code: "unknown_preset" };
  const ticked = cleanModelIds(modelIds);
  if (!ticked) return { ok: false, code: "bad_model" };

  const test = await testFn({ presetId, variantId, baseUrl, apiKey });
  const typedOnly = preset.id === "other" && test.code === "not_found" && ticked.length > 0;
  if (!test.ok && !typedOnly) {
    return { ok: false, code: test.code, ...(test.status != null ? { status: test.status } : {}) };
  }
  const key = cleanKey(apiKey);
  const rowUrl = test.baseUrl || baseUrlFor(preset, { variantId, baseUrl });
  if (!key || !rowUrl) return { ok: false, code: key ? "bad_url" : "bad_key" };

  let saved;
  try {
    const rows = await listRowsFn(db);
    const { id, reuse } = providerIdFor(preset.id, { rows, baseUrl: rowUrl, apiKey: key });
    let models = ticked.map((m) => modelEntryFor(preset.id, m));
    if (reuse) {
      const stored = rows.find((r) => r.id === id)?.models;
      const kept = (Array.isArray(stored) ? stored : []).filter((m) => (typeof m === "string" ? m : m?.id));
      const have = new Set(kept.map((m) => (typeof m === "string" ? m : m.id)));
      models = [...kept, ...models.filter((m) => !have.has(m.id))];
    }
    await upsertProviderFn(db, {
      id,
      baseUrl: rowUrl,
      apiKey: key,
      host: preset.id === "other" ? undefined : "cloud",
      bundleId: null,
      description: labelFor(preset, variantId),
      models,
      disabled: false,
      providerType: preset.providerType,
    });
    invalidateFn();
    saved = { id, reuse };
  } catch (err) {
    console.warn(`[add-provider] save failed: ${err?.message}`);
    return { ok: false, code: "save_failed" };
  }
  // Outside the try: the row is written, so a failing onAdded must not read as "not saved".
  if (onAdded) await onAdded(saved.id);
  return { ok: true, providerId: saved.id, reuse: saved.reuse, test };
}
