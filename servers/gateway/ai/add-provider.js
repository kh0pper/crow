/**
 * Add a provider (roles phase 2b): test a pasted key in plain terms, choose a
 * provider id that never overwrites another account, and write one row shape.
 *
 * Every upstream call goes through `safeRequest` (presets in "cloud" mode,
 * "other" in "other" mode). The key is used only in request headers and the
 * stored row: it is never returned, and nothing here logs it (errors are
 * logged by `err.message`, which never carries headers).
 */
import { createHash } from "node:crypto";
import { presetById, normalizeBaseUrl, ANTHROPIC_VERSION } from "../../shared/provider-presets.js";
import { recommendedFor, candidatePick, presetForRow, entryKind, bareModelId, RECOMMENDATION_ROLES } from "../../shared/provider-recommendations.js";
import { upsertProvider, listProvidersAll } from "../../shared/providers-db.js";
import { invalidateProvidersCache } from "../../shared/providers.js";
import { isDoorUrl } from "../models/door-resolve.js";
import { safeRequest, readJson, preflightRefused } from "../models/safe-upstream.js";
// Read-only check storage: this module never runs a pick check itself.
import { readPickChecks, checkIn, checkKindFor } from "../../shared/pick-checks.js";
import { resolveRoleKey, isCloudKey, CORE_ROLES } from "../../shared/model-roles.js";
import { loadRoleContext } from "../../shared/model-roles-store.js";
import { scanSlots } from "../../shared/model-consumers.js";
import { previewRoleChange, applyRoleChange } from "../../shared/role-change.js";
import { getOwnAddresses } from "../../shared/locality.js";
import { buildRoleRows } from "../dashboard/settings/sections/models/rows.js";
import { grantCloudConsent } from "../../shared/cloud-consent.js";

const MAX_MODEL_IDS = 2000;
const MAX_MODEL_ID_LEN = 256;
const MAX_ID_LEN = 32;
const DOOR_ID_PREFIX = "crow-c-";

// One add at a time in this process (the gateway is the only writer of these rows).
let addChain = Promise.resolve();
function acquireAddLock() {
  let release;
  const held = new Promise((r) => { release = r; });
  const ready = addChain.then(() => release);
  addChain = addChain.then(() => held);
  return ready;
}

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

/**
 * The key to use: the cleaned key, "" for an empty key on `other` (a local
 * server that needs none), or null when the key is unusable.
 */
function keyFor(preset, apiKey) {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed && preset.id === "other") return "";
  return cleanKey(apiKey);
}

function authHeaders(preset, key) {
  if (!key) return {};
  if (preset.authStyle === "anthropic") return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  return { Authorization: `Bearer ${key}` };
}

/**
 * "bad_url", "forbidden_target" or null for a base URL, before any request.
 * The address rule is safeRequest's own (`preflightRefused`, which also
 * covers this gateway's port on any own address, m13); the door path is
 * refused here because safeRequest itself must still reach doors.
 */
function targetCode(raw, mode) {
  // A query or fragment would land in the middle of every request path.
  if (typeof raw !== "string" || /[?#]/.test(raw)) return "bad_url";
  const r = preflightRefused(raw, { mode });
  if (r === "BAD_URL") return "bad_url";
  if (r || isDoorUrl(raw)) return "forbidden_target";
  return null;
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

/**
 * Model ids from an OpenAI-style `{data:[{id}]}`, an Ollama-style
 * `{models:[{name}]}`, or a bare array. A leading "models/" is dropped
 * (Google's OpenAI-compatible listing), and an id is listed once.
 */
function idsFromListing(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (!list) return null;
  const ids = [];
  const seen = new Set();
  for (const m of list) {
    const raw = typeof m === "string" ? m : (m?.id ?? m?.name);
    const id = bareModelId(raw);
    if (typeof id === "string" && id && id.length <= MAX_MODEL_ID_LEN && /^[^\x00-\x1f\x7f]+$/.test(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

const discard = (res) => { try { res?.stream?.destroy?.(); } catch {} };

/**
 * Test a key. Returns `{ok, code, status?, models, host, baseUrl?, truncated?}`:
 * never the key. `models` is the listing (≤ 2,000 ids), or null when there is
 * none; a listing that fails after the key passed still gives `ok`. A preset
 * with a `testRequest` (no listing) is tested with that one POST instead.
 */
export async function testProviderKey({ presetId, variantId, baseUrl, apiKey } = {}, { requestFn = safeRequest, timeoutMs = 8000 } = {}) {
  const preset = presetById(presetId);
  if (!preset) return { ok: false, code: "unknown_preset", models: null, host: null };
  const raw = baseUrlFor(preset, { variantId, baseUrl });
  let u = null;
  try { u = raw ? new URL(raw) : null; } catch {}
  const host = u ? u.hostname.replace(/^\[|\]$/g, "") : null;
  const out = (code, extra = {}) => ({ ok: code === "ok", code, models: null, host, ...extra });
  if (!u) return out("bad_url");
  const mode = preset.id === "other" ? "other" : "cloud";
  const refused = targetCode(raw, mode);
  if (refused) return out(refused);
  const key = keyFor(preset, apiKey);
  if (key == null) return out("bad_key");

  const base = u.href.replace(/\/+$/, "");
  const headers = authHeaders(preset, key);
  // One budget for the whole test: both requests and both bodies.
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const call = async (path, extra = { method: "GET" }) => {
    if (left() <= 0) return { err: Object.assign(new Error("out of time"), { code: "TIMEOUT" }) };
    try { return { res: await requestFn(base + path, { ...extra, headers: { ...headers, ...(extra.headers || {}) }, mode, timeoutMs: left() }) }; }
    catch (err) { return { err }; }
  };

  // A provider with no listing proves the key with one small POST (its
  // `testRequest`): same codes, same deadline, and no models to return.
  if (preset.testRequest) {
    const tr = preset.testRequest;
    const sent = await call(tr.path, {
      method: tr.method, headers: { "content-type": "application/json" }, body: JSON.stringify(tr.body),
    });
    if (sent.err) return out(codeForError(sent.err));
    const tcode = codeForStatus(sent.res.status);
    if (tcode !== "ok") {
      discard(sent.res);
      return out(tcode, { status: sent.res.status, baseUrl: base });
    }
    // The answer must finish inside the budget; what it says does not matter.
    try { await readJson(sent.res, { maxBytes: 200_000, deadline }); }
    catch (err) { if (err?.code === "TIMEOUT") return out("unreachable"); }
    return { ok: true, code: "ok", status: sent.res.status, models: null, host, baseUrl: base };
  }

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
      const ids = idsFromListing(await readJson(listing.res, { maxBytes: 2_000_000, deadline }));
      if (ids) {
        truncated = ids.length > MAX_MODEL_IDS;
        models = ids.slice(0, MAX_MODEL_IDS);
      }
    } catch (err) {
      // The test's own answer never finished: the server is not usable. (A
      // separate listing that stalls is only a list failure: ok, models null.)
      if (err?.code === "TIMEOUT" && listing === first) return out("unreachable");
      models = null;
    }
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
  const wantKey = (typeof apiKey === "string" ? (cleanKey(apiKey) ?? apiKey.trim()) : apiKey) || "";
  for (let n = 1; n < 1000; n++) {
    const id = nthId(base, n, custom);
    if (id.startsWith(DOOR_ID_PREFIX)) continue;
    const row = byId.get(id);
    if (!row) return { id, reuse: false };
    const rowKey = row.apiKey ?? row.api_key ?? null;
    if (normalizeBaseUrl(row.baseUrl ?? row.base_url) === wantUrl && (rowKey || "") === wantKey) return { id, reuse: true };
  }
  throw new Error("no free provider id");
}

/** A models[] entry for one id, enriched from the recommendations when the file lists it. */
export function modelEntryFor(presetId, modelId) {
  const entry = { id: modelId };
  let embed = false, rerank = false, chat = false, other = null, vision = false, context = null;
  for (const role of RECOMMENDATION_ROLES) {
    for (const e of recommendedFor(presetId, role)) {
      if (e.model_id !== modelId) continue;
      const kind = entryKind(e);
      if (kind === "embed") embed = true;
      else if (kind === "rerank") rerank = true;
      else if (kind === "chat") chat = true;
      else other ??= kind; // realtime, audio, live: never a chat pick
      if (role === "vision" && kind === "chat") vision = true;
      if (context == null && Number.isFinite(e.context) && e.context > 0) context = e.context;
    }
  }
  if (embed) entry.task = "embedding";
  else if (rerank) entry.task = "rerank";
  else if (other && !chat) entry.task = other;
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
 * model a role is bound to is never dropped. `onAdded(providerId, {baseUrl,
 * apiKey})` runs after the write with exactly what was written; by default it
 * records this box's consent for bots to use the row (Task 15), on a new row
 * and again on reuse, refused if the row changed since. The result's
 * `consent` is "granted", "failed", or "not_needed" (not a cloud row, or one
 * the cloud door would never serve: cloudDoorIneligibleReason).
 */
export async function addProvider(db, { presetId, variantId, baseUrl, apiKey, modelIds } = {}, {
  upsertProviderFn = upsertProvider, invalidateFn = invalidateProvidersCache,
  testFn = testProviderKey, listRowsFn = listProvidersAll,
  onAdded = (id, written) => grantCloudConsent(db, id, { actor: "add-provider", expect: written }),
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
  const key = keyFor(preset, apiKey);
  const rowUrl = test.baseUrl || baseUrlFor(preset, { variantId, baseUrl });
  if (key == null) return { ok: false, code: "bad_key" };
  if (!rowUrl) return { ok: false, code: "bad_url" };

  let saved;
  // Serialized: choosing a free id and writing it is one step, so two adds in
  // flight at once (a double submit, two tabs) cannot both take `openai-2`.
  const release = await acquireAddLock();
  try {
    const rows = await listRowsFn(db);
    const { id, reuse } = providerIdFor(preset.id, { rows, baseUrl: rowUrl, apiKey: key });
    let models = ticked.map((m) => modelEntryFor(preset.id, m));
    const storedRow = reuse ? rows.find((r) => r.id === id) : null;
    if (reuse) {
      const stored = storedRow?.models;
      const kept = (Array.isArray(stored) ? stored : []).filter((m) => (typeof m === "string" ? m : m?.id));
      const have = new Set(kept.map((m) => (typeof m === "string" ? m : m.id)));
      models = [...kept, ...models.filter((m) => !have.has(m.id))];
    }
    await upsertProviderFn(db, {
      id,
      baseUrl: rowUrl,
      apiKey: key || null,
      host: preset.id === "other" ? undefined : "cloud",
      // On reuse the row's own bundle link and description are kept.
      bundleId: storedRow ? (storedRow.bundleId ?? storedRow.bundle_id ?? null) : null,
      description: (storedRow && storedRow.description) || labelFor(preset, variantId),
      models,
      disabled: false,
      providerType: preset.providerType,
    });
    invalidateFn();
    saved = { id, reuse, written: { baseUrl: rowUrl, apiKey: key || null } };
  } catch (err) {
    console.warn(`[add-provider] save failed: ${err?.message}`);
    return { ok: false, code: "save_failed" };
  } finally {
    release();
  }
  // Outside the try: the row is written, so a failing onAdded must not read as "not saved".
  let consent = "failed";
  try {
    const r = onAdded ? await onAdded(saved.id, saved.written) : null;
    consent = r?.ok === true ? "granted" : r?.reason === "not_cloud" || r?.reason === "not_eligible" ? "not_needed" : "failed";
  } catch (err) { console.warn(`[add-provider] after-save step failed: ${err?.message}`); }
  return { ok: true, providerId: saved.id, reuse: saved.reuse, consent, test };
}

// --- "Use the recommended models for roles you haven't set" (Task 11) -------

/** Roles whose cloud pick is never pre-ticked (I8): what they send is your whole memory or search. */
const NEVER_PRETICK_CLOUD = new Set(["embed", "rerank"]);
const RUNS_TODAY = new Set(["default", "fallback"]);
const SET_STATUSES = new Set(["env", "pinned"]);

const listedIdsOf = (row) => (Array.isArray(row?.models) ? row.models : [])
  .map((m) => (typeof m === "string" ? m : m?.id)).filter((id) => typeof id === "string" && id);

/** The change a pick makes: the model, keeping the role's stored chain (as a Change from the page does). */
function changeFor(ctx, roleId, key) {
  const fb = ctx?.bindings?.[roleId]?.fallback;
  return Array.isArray(fb) ? { model: key, fallback: [...fb] } : { model: key };
}

/** True when binding `key` makes the role resolve to it (the resolver's own rules, as listRolePicks). */
function resolvesTo(ctx, roleId, key) {
  const ctxX = { ...ctx, bindings: { ...(ctx.bindings || {}), [roleId]: { model: key, fallback: [], seeded: false } } };
  try {
    const r = resolveRoleKey(`role:${roleId}`, ctxX);
    return r.reason === "bound" && r.key === key;
  } catch { return false; }
}

const freshCtx = (db, localInstanceId) =>
  loadRoleContext(db, { maxAgeMs: 0, ...(localInstanceId ? { getOrCreateLocalInstanceId: localInstanceId } : {}) });

const rowsOf = (db, { buildRowsFn = buildRoleRows, env, ownAddrs, localMarks, localInstanceId, classifierStatusFn, classifierLookup }) =>
  buildRowsFn(db, { env, ownAddrs, localMarks, localInstanceId, classifierStatusFn, classifierLookup });

/**
 * What "Use the recommended models" would do for one provider.
 *
 * A pick is offered only when the provider is made from a preset, the row
 * lists the pick, the resolver would use it, and its stored check passed
 * (else `none_offered`, `not_listed`, `not_tested`, `failed_check`). An
 * offered pick is pre-ticked (`apply`) only for a role whose row says
 * `not_set` (or `not_available` while unbound: its chain dead-ends, L1); a
 * chosen or seeded role whose chain dead-ends (`why: "not_available"`), a
 * seeded role, a role running a default or fallback today, and
 * any cloud pick for embed or rerank are `optIn` (I8; `why: "cloud"` for the
 * last when nothing runs it today). Roles the operator chose, or that an env
 * var or setting pin fills, are `set`; a role the page has no row for is
 * `unknown`.
 *
 * Never carries the key. Seams: `buildRowsFn`, `classifierStatusFn`,
 * `classifierLookup`, `localInstanceId`, `recOpts`, `now`.
 * @returns {Promise<{apply:Array<{roleId,key,preview}>, optIn:Array<{roleId,key,current,why}>, skipped:Array<{roleId,why}>}>}
 */
export async function planRecommended(db, providerId, opts = {}) {
  const { env = process.env, localMarks, now = new Date(), recOpts, localInstanceId } = opts;
  const ownAddrs = opts.ownAddrs || getOwnAddresses();
  const ctx = opts.ctx || await freshCtx(db, localInstanceId);
  const out = { apply: [], optIn: [], skipped: [] };
  const row = (ctx.providers || []).find((p) => p && p.id === providerId);
  if (!row) return out;
  const presetId = presetForRow(row);
  const listed = listedIdsOf(row);
  const checks = await readPickChecks(db);
  const rows = new Map((await rowsOf(db, { ...opts, env, ownAddrs })).map((r) => [r.id, r]));
  let slots = null;

  for (const roleId of RECOMMENDATION_ROLES) {
    const skip = (why) => out.skipped.push({ roleId, why });
    if (!presetId || !candidatePick(presetId, roleId, {}, recOpts)) { skip("none_offered"); continue; }
    const pick = candidatePick(presetId, roleId, { liveModelIds: listed }, recOpts);
    const key = pick ? `${providerId}/${pick.model_id}` : null;
    if (!key || !resolvesTo(ctx, roleId, key)) { skip("not_listed"); continue; }
    const check = checkIn(checks, providerId, pick.model_id, { kind: checkKindFor(roleId), now, recOpts, row });
    if (!check || check.retryable) { skip("not_tested"); continue; }
    if (!check.ok) { skip("failed_check"); continue; }

    const r = rows.get(roleId);
    if (!r) { skip("unknown"); continue; }
    let code = r.status?.code;
    const current = r.model || null;
    if (r.pin || SET_STATUSES.has(code)) { skip("set"); continue; }
    // A dead-end chain (not_available): a role the operator chose, or Crow
    // seeded, is offered unticked; an unbound one is simply empty (L1).
    if (code === "not_available") {
      if (r.chosen || r.seeded) { out.optIn.push({ roleId, key, current, why: "not_available" }); continue; }
      code = "not_set";
    }
    if (r.chosen) { skip("set"); continue; }
    if (r.seeded) { out.optIn.push({ roleId, key, current, why: "seeded" }); continue; }
    if (RUNS_TODAY.has(code)) { out.optIn.push({ roleId, key, current, why: "runs_today" }); continue; }
    if (code !== "not_set") { skip("set"); continue; }
    if (NEVER_PRETICK_CLOUD.has(roleId) && isCloudKey(key, { providers: ctx.providers, localMarks, ownAddrs })) {
      out.optIn.push({ roleId, key, current, why: "cloud" });
      continue;
    }
    slots ??= await scanSlots(db, { withUnattended: true, includeSubagents: false, env });
    const preview = await previewRoleChange(db, roleId, changeFor(ctx, roleId, key), { ctx, slots, env, localMarks, ownAddrs });
    out.apply.push({ roleId, key, preview });
  }
  return out;
}

const consumerId = (c) => `${c?.kind}|${c?.id}`;

/** The union of each item's preview, plus the changes it was computed for (internal). */
async function combine(db, items, opts = {}) {
  const { env = process.env, localMarks, localInstanceId } = opts;
  const ownAddrs = opts.ownAddrs || getOwnAddresses();
  const ctx = await freshCtx(db, localInstanceId);
  const seen = new Set();
  const list = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.roleId !== "string" || typeof it.key !== "string" || seen.has(it.roleId)) continue;
    seen.add(it.roleId);
    list.push({ roleId: it.roleId, key: it.key, change: changeFor(ctx, it.roleId, it.key) });
  }
  const slots = list.length ? await scanSlots(db, { withUnattended: true, includeSubagents: false, env }) : [];
  const consumers = {}, consumerSeen = {};
  const clouds = [], cloudSeen = new Set();
  const refused = [], refusedSeen = new Set();
  const needs = { ackUnattended: false, ackCloud: false };
  let reembed = false;
  for (const it of list) {
    const p = await previewRoleChange(db, it.roleId, it.change, { ctx, slots, env, localMarks, ownAddrs });
    it.previewHash = p.previewHash;
    for (const [group, entries] of Object.entries(p.consumers || {})) {
      consumers[group] ??= [];
      consumerSeen[group] ??= new Set();
      for (const c of entries || []) {
        if (consumerSeen[group].has(consumerId(c))) continue;
        consumerSeen[group].add(consumerId(c));
        consumers[group].push(c);
      }
    }
    if (p.cloud && !cloudSeen.has(`${p.cloud.host}|${p.cloud.model}`)) {
      cloudSeen.add(`${p.cloud.host}|${p.cloud.model}`);
      clouds.push(p.cloud);
    }
    for (const x of p.refused || []) if (!refusedSeen.has(x.id)) { refusedSeen.add(x.id); refused.push(x); }
    needs.ackUnattended ||= !!p.needs?.ackUnattended;
    needs.ackCloud ||= !!p.needs?.ackCloud;
    reembed ||= !!p.reembed;
  }
  const parts = list.map((it) => [it.roleId, it.key, it.previewHash]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const previewHash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return {
    result: {
      consumers, cloud: clouds[0] || null, clouds, refused, reembed, needs,
      items: list.map(({ roleId, key, previewHash: h }) => ({ roleId, key, previewHash: h })),
      previewHash,
    },
    list,
    ownAddrs,
  };
}

/**
 * One warning for several picks: the union of each item's previewRoleChange
 * (each consumer once per group), `needs` the OR of theirs, `cloud` the first
 * cloud line (`clouds` all of them). The hash covers every item's own hash,
 * so it changes when any one preview changes.
 * @param {Array<{roleId:string, key:string}>} items
 * @returns {Promise<{consumers, cloud, clouds, refused, reembed, needs, items, previewHash}>}
 */
export async function combinedPreview(db, items, opts = {}) {
  return (await combine(db, items, opts)).result;
}

const CORE_IDS = new Set(CORE_ROLES.map((r) => r.id));

/**
 * The built-in core roles still empty: visible chat-style rows whose status is
 * `not_set`. Never custom roles (they are the operator's own, not gaps Crow
 * fills), never rerank (hidden unless chosen), never image/video (media), and
 * never stt/tts: those are speech profiles, set up on their own tab, not by a
 * provider's model picks.
 */
function stillEmptyOf(rows) {
  return rows
    .filter((r) => CORE_IDS.has(r.id) && r.kind === "chat" && r.id !== "rerank" && !r.hidden
      && (r.status?.code === "not_set" || (r.status?.code === "not_available" && !r.chosen && !r.seeded)))
    .map((r) => r.id);
}

/** True when the role's live binding is now the chosen `key` (the write landed). */
async function bindingLanded(db, roleId, key, localInstanceId) {
  try {
    const b = (await freshCtx(db, localInstanceId)).bindings?.[roleId];
    return !!(b && b.model === key && b.seeded !== true);
  } catch { return false; }
}

/**
 * Apply the ticked roles from a plan, after the one combined warning.
 *
 * Refuses every role, writing nothing, when a role is not offered by a fresh
 * plan or the combined hash is stale (all `preview_changed`, with `plan`, the
 * fresh plan, so the sheet can show what is offered now), or when an ack the
 * combined preview needs is missing. Otherwise each role goes through applyRoleChange with the same
 * acks, one at a time: the first with the hash the user saw, each later one
 * with a hash taken after the writes before it (the combined hash already
 * covered them). A write that fails is listed in `refused` and the rest are
 * still tried. When applyRoleChange throws, the binding is read back: the
 * role is `applied` if the write landed, `save_failed` only if it did not, so
 * `applied` is exactly what was written.
 * @returns {Promise<{applied:Array<{roleId,key}>, refused:Array<{roleId,reason}>, stillEmpty:string[], plan?:object}>}
 */
export async function applyRecommended(db, providerId, {
  roles, previewHash, actor, ackUnattended = false, ackCloud = false, applyRoleChangeFn = applyRoleChange, ...seams
} = {}) {
  delete seams.ctx; // every stage reads the live state
  seams.ownAddrs ||= getOwnAddresses();
  const { env = process.env, localMarks } = seams;
  const wanted = [...new Set((Array.isArray(roles) ? roles : []).filter((r) => typeof r === "string"))];
  const applied = [], refused = [];
  const finish = async () => ({ applied, refused, stillEmpty: stillEmptyOf(await rowsOf(db, { ...seams, env })) });
  const refuseAll = (reasonOf) => { for (const roleId of wanted) refused.push({ roleId, reason: reasonOf(roleId) }); return finish(); };
  if (!wanted.length) return finish();

  const plan = await planRecommended(db, providerId, seams);
  const offered = new Map([...plan.apply, ...plan.optIn].map((x) => [x.roleId, x.key]));
  const changed = async () => ({ ...(await refuseAll(() => "preview_changed")), plan });
  if (wanted.some((r) => !offered.has(r))) return changed();

  const { result, list } = await combine(db, wanted.map((roleId) => ({ roleId, key: offered.get(roleId) })), seams);
  if (typeof previewHash !== "string" || previewHash !== result.previewHash) return changed();
  if (result.needs.ackUnattended && ackUnattended !== true) return refuseAll(() => "needs_ack_unattended");
  if (result.needs.ackCloud && ackCloud !== true) return refuseAll(() => "needs_ack_cloud");

  let wrote = false;
  for (const it of list) {
    let r;
    try {
      const hash = wrote
        ? (await previewRoleChange(db, it.roleId, it.change, { env, localMarks, ownAddrs: seams.ownAddrs })).previewHash
        : it.previewHash;
      r = await applyRoleChangeFn(db, it.roleId, it.change, {
        actor, previewHash: hash, ackUnattended, ackCloud, env, localMarks, ownAddrs: seams.ownAddrs,
      });
    } catch (err) {
      console.warn(`[add-provider] apply ${it.roleId} failed: ${err?.message}`);
      r = (await bindingLanded(db, it.roleId, it.key, seams.localInstanceId)) ? { ok: true } : { ok: false, reason: "save_failed" };
      wrote = true; // judge the next one on the live state either way
    }
    if (r?.ok) { applied.push({ roleId: it.roleId, key: it.key }); wrote = true; }
    else refused.push({ roleId: it.roleId, reason: typeof r?.reason === "string" ? r.reason : "save_failed" });
  }
  return finish();
}
