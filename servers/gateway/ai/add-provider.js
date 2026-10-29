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
import { recommendedFor, candidatePick, presetForRow, RECOMMENDATION_ROLES } from "../../shared/provider-recommendations.js";
import { upsertProvider, listProvidersAll } from "../../shared/providers-db.js";
import { invalidateProvidersCache } from "../../shared/providers.js";
import { isDoorUrl } from "../models/door-resolve.js";
import { safeRequest, readJson, preflightRefused } from "../models/safe-upstream.js";
// Read-only check storage: this module never runs a pick check itself.
import { readPickChecks, checkIn, checkKindFor } from "./pick-checks.js";
import { resolveRoleKey, isCloudKey } from "../../shared/model-roles.js";
import { loadRoleContext } from "../../shared/model-roles-store.js";
import { scanSlots } from "../../shared/model-consumers.js";
import { previewRoleChange, applyRoleChange } from "../../shared/role-change.js";
import { getOwnAddresses } from "../../shared/locality.js";
import { buildRoleRows } from "../dashboard/settings/sections/models/rows.js";

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
  const call = async (path) => {
    if (left() <= 0) return { err: Object.assign(new Error("out of time"), { code: "TIMEOUT" }) };
    try { return { res: await requestFn(base + path, { method: "GET", headers, mode, timeoutMs: left() }) }; }
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
    saved = { id, reuse };
  } catch (err) {
    console.warn(`[add-provider] save failed: ${err?.message}`);
    return { ok: false, code: "save_failed" };
  } finally {
    release();
  }
  // Outside the try: the row is written, so a failing onAdded must not read as "not saved".
  if (onAdded) await onAdded(saved.id);
  return { ok: true, providerId: saved.id, reuse: saved.reuse, test };
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
 * `not_set`; a seeded role, a role running a default or fallback today, and
 * any cloud pick for embed or rerank are `optIn` (I8; `why: "cloud"` for the
 * last when nothing runs it today). Roles the operator chose, or that an env
 * var or setting pin fills, are `set`.
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
    const check = checkIn(checks, providerId, pick.model_id, { kind: checkKindFor(roleId), now, recOpts });
    if (!check) { skip("not_tested"); continue; }
    if (!check.ok) { skip("failed_check"); continue; }

    const r = rows.get(roleId);
    const code = r?.status?.code;
    if (!r || r.chosen || r.pin || SET_STATUSES.has(code)) { skip("set"); continue; }
    const current = r.model || null;
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

function stillEmptyOf(rows) {
  return rows.filter((r) => r.kind === "chat" && r.id !== "rerank" && !r.hidden && r.status?.code === "not_set").map((r) => r.id);
}

/**
 * Apply the ticked roles from a plan, after the one combined warning.
 *
 * Refuses every role, writing nothing, when a role is not offered by a fresh
 * plan (`not_offered`; the others `preview_changed`), when the combined hash
 * is stale (`preview_changed`), or when an ack the combined preview needs is
 * missing. Otherwise each role goes through applyRoleChange with the same
 * acks, one at a time: the first with the hash the user saw, each later one
 * with a hash taken after the writes before it (the combined hash already
 * covered them). A write that fails is listed in `refused` and the rest are
 * still tried, so `applied` is exactly what was written.
 * @returns {Promise<{applied:Array<{roleId,key}>, refused:Array<{roleId,reason}>, stillEmpty:string[]}>}
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
  if (wanted.some((r) => !offered.has(r))) return refuseAll((r) => (offered.has(r) ? "preview_changed" : "not_offered"));

  const { result, list } = await combine(db, wanted.map((roleId) => ({ roleId, key: offered.get(roleId) })), seams);
  if (typeof previewHash !== "string" || previewHash !== result.previewHash) return refuseAll(() => "preview_changed");
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
      r = { ok: false, reason: "save_failed" };
      wrote = true; // unknown: judge the next one on the live state
    }
    if (r?.ok) { applied.push({ roleId: it.roleId, key: it.key }); wrote = true; }
    else refused.push({ roleId: it.roleId, reason: typeof r?.reason === "string" ? r.reason : "save_failed" });
  }
  return finish();
}
