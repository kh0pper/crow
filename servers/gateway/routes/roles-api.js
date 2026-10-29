/**
 * Roles JSON API (roles Phase 2, the Models page): what may fill a role,
 * preview a rebind, apply it with the acknowledgements the preview asked for,
 * and (Phase 2) set the default STT/TTS profile behind the speech rows.
 *
 * Auth: every route runs the dashboard session gate (`requireDashboardSessionJson`,
 * JSON 401/403, see routes/models.js), and every POST the double-submit CSRF
 * check (`crow_csrf` cookie, `X-Crow-Csrf` header). NEVER add `/api/roles`
 * to PUBLIC_FUNNEL_PREFIXES (CLAUDE.md "Network exposure invariant").
 *
 * Secrets: no answer carries a provider or profile API key. Pick lists and
 * previews are built from role data; profile lists are read without keys.
 *
 * Peers: nothing here sends anything to a peer. A role binding is written
 * without an emit (setBinding); the speech default rides the `stt_profiles` /
 * `tts_profiles` sync that already exists, which is why every speech preview
 * says `paired: true` whenever a trusted peer exists (minor g).
 *
 * Path segment `custom` is reserved for the custom-role routes (registered
 * before these); `/api/roles/custom...` answers 404 here.
 *
 * Add a provider (roles phase 2b): `/api/providers/test`, `/api/providers`,
 * and per provider `/plan`, `/probe`, `/recommended/preview`, `/recommended`.
 * Same session gate (per route, so the older `/api/providers/health` keeps its
 * own auth) and CSRF. A pasted key is read from the body and handed to the
 * test or the write; every answer is built field by field, so no key can ride
 * along. NEVER add `/api/providers` to PUBLIC_FUNNEL_PREFIXES either.
 */
import { Router } from "express";
import { createHash } from "node:crypto";

import { createDbClient } from "../../db.js";
import { parseCookies } from "../dashboard/auth.js";
import { csrfMiddleware } from "../dashboard/shared/csrf.js";
import { SUPPORTED_LANGS } from "../dashboard/shared/i18n.js";
import { requireDashboardSessionJson } from "./models.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { CORE_ROLES, MEDIA_CAPABILITIES, isRoleRef, roleIdOf, isRawKey, isValidCustomRoleId, walkRole } from "../../shared/model-roles.js";
import { getOwnAddresses } from "../../shared/locality.js";
import { loadRoleContext } from "../../shared/model-roles-store.js";
import { previewRoleChange, applyRoleChange } from "../../shared/role-change.js";
import { listRolePicks, providerLabel } from "../../shared/role-picks.js";
import { readPickChecks, pickCheckOf, checkKindFor, isProbeKind } from "../../shared/pick-checks.js";
import { candidatePick, presetForRow, isRecommendationsStale, loadRecommendations, recommendedModelIds, RECOMMENDATION_ROLES } from "../../shared/provider-recommendations.js";
import { presetById } from "../../shared/provider-presets.js";
import { friendlyModel } from "../dashboard/shared/bot-display.js";
import { testProviderKey, addProvider, planRecommended, combinedPreview, applyRecommended } from "../ai/add-provider.js";
import { probeRecommended } from "../ai/pick-probe.js";
import { speechProfileWhere, speechProfileHost, isSpeechWhereLocal } from "../../shared/speech-where.js";
import { TRUSTED_PEER_SQL } from "../../shared/peer-trust.js";
import { getTtsProfiles } from "../ai/tts/index.js";
import { getSttProfiles } from "../ai/stt/index.js";
import { setDefaultTtsProfile } from "../dashboard/settings/sections/llm/tts-profiles.js";
import { setDefaultSttProfile } from "../dashboard/settings/sections/llm/stt-profiles.js";

const RESERVED = new Set(["custom"]);
const CORE_BY_ID = new Map(CORE_ROLES.map((r) => [r.id, r]));
const SPEECH = {
  stt: { list: getSttProfiles, setDefault: setDefaultSttProfile },
  tts: { list: getTtsProfiles, setDefault: setDefaultTtsProfile },
};
// 409: the user can fix it by looking again or ticking a box. Everything else a refusal is 400.
const CONFLICT_REASONS = new Set(["preview_changed", "needs_ack_unattended", "needs_ack_cloud"]);

function roleDef(id, customDefs) {
  if (typeof id !== "string" || RESERVED.has(id)) return null;
  if (CORE_BY_ID.has(id)) return CORE_BY_ID.get(id);
  if (isValidCustomRoleId(id) && customDefs?.[id]) return { ...customDefs[id], id };
  return null;
}

const knownRoleId = (id, customDefs) => roleDef(id, customDefs) !== null;

const str = (v) => (typeof v === "string" ? v : undefined);
const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const listedIds = (row) => (Array.isArray(row?.models) ? row.models : [])
  .map((m) => (typeof m === "string" ? m : m?.id)).filter((id) => typeof id === "string" && id);

/** The roles a body names, kept to the ones recommendations cover; null when none are named. */
function rolesOf(body) {
  const r = body?.roles;
  if (!Array.isArray(r)) return null;
  return [...new Set(r.filter((x) => typeof x === "string" && RECOMMENDATION_ROLES.includes(x)))];
}

/** The model ids a preset recommends from a listing (what the sheet pre-ticks and stars). */
function recommendedIds(presetId, models, recOpts) {
  if (!Array.isArray(models) || !models.length) return [];
  const out = new Set();
  for (const roleId of RECOMMENDATION_ROLES) {
    const p = candidatePick(presetId, roleId, { liveModelIds: models }, recOpts);
    if (p?.model_id) out.add(p.model_id);
  }
  return [...out];
}

/**
 * The JSON parser's own refusals on these routes: a body that does not parse
 * (400 `bad_request`) or is over the limit (413 `too_large`). Both answer
 * without detail and log nothing. A parse error's message can quote part of
 * the body (an unquoted value, for one), and a body here may hold a pasted
 * key; Express's default handler would echo that message and log its stack.
 * Any other error passes on untouched. Mount after the JSON parser:
 * app.use(["/api/roles", "/api/providers"], it).
 */
export function rolesApiBodyErrorHandler(err, req, res, next) {
  if (!err || res.headersSent) return next(err);
  if (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413) {
    return res.status(413).json({ ok: false, code: "too_large" });
  }
  if (err.type !== "entity.parse.failed" && err.status !== 400 && err.statusCode !== 400) return next(err);
  res.status(400).json({ ok: false, code: "bad_request" });
}

/** null (clear), a raw `provider/model`, or `role:<known id>`. */
function validModel(model, customDefs) {
  if (model === null || model === undefined) return true;
  if (typeof model !== "string") return false;
  return isRoleRef(model) ? knownRoleId(roleIdOf(model), customDefs) : isRawKey(model);
}

function validFallback(fallback, customDefs) {
  if (fallback === undefined) return true;
  return Array.isArray(fallback) && fallback.every((f) => typeof f === "string" && knownRoleId(isRoleRef(f) ? roleIdOf(f) : f, customDefs));
}

/** The safety role is a boundary: never chained, in either direction (the picks' rule). */
const SAFETY = "safety";

/**
 * The picks' rules, enforced here too (a crafted POST must not do what the
 * page never offers). Returns an error code, or null when the change is fine:
 *   safety_no_chain       safety bound to a role ref, or given a fallback chain
 *   safety_not_followable another role naming role:safety (model or fallback)
 *   self_reference        a role naming itself (model or fallback)
 *   capability_mismatch   a raw key whose model lacks the role's capability
 */
function picksRuleError(roleId, { model, fallback }, ctx) {
  const refs = [
    ...(isRoleRef(model) ? [roleIdOf(model)] : []),
    ...(Array.isArray(fallback) ? fallback.map((f) => (isRoleRef(f) ? roleIdOf(f) : f)) : []),
  ];
  if (roleId === SAFETY && refs.length) return "safety_no_chain";
  if (refs.includes(SAFETY)) return "safety_not_followable";
  if (refs.includes(roleId)) return "self_reference";
  if (typeof model === "string" && isRawKey(model)) {
    const ctxX = { ...ctx, bindings: { ...(ctx.bindings || {}), [roleId]: { model, fallback: [], seeded: false } } };
    let first = null;
    try { first = walkRole(roleId, ctxX).next().value || null; } catch { first = null; }
    if (first && first.key === model && first.verdict === "capability") return "capability_mismatch";
  }
  return null;
}

const langOf = (req) => {
  const c = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(c) ? c : "en";
};

/**
 * @param {object} [opts]
 * @param {() => object} [opts.dbFactory]
 * @param {Function} [opts.sessionGate]
 * @param {object} [opts.env]             env for pins and env overrides (default process.env)
 * @param {Set<string>} [opts.ownAddrs]   this box's addresses (default: probed once per request)
 * @param {() => Set<string>} [opts.probeOwnAddrs]  the probe (default getOwnAddresses)
 * @param {() => string} [opts.localInstanceId]
 * @param {(roleId:string) => string[]} [opts.recommendedFn]
 * @param {Function} [opts.testFn]          the key test (default testProviderKey)
 * @param {Function} [opts.probeRequestFn]  the probe's request seam (default safeRequest)
 * @param {() => Date} [opts.now]           the clock for pick checks
 * @param {Function} [opts.classifierStatusFn]  the safety row's status (plans)
 * @param {object} [opts.recOpts]           recommendations file options (tests)
 */
export default function rolesApiRouter({
  dbFactory = createDbClient,
  sessionGate = requireDashboardSessionJson,
  env = process.env,
  ownAddrs,
  probeOwnAddrs = getOwnAddresses,
  localInstanceId = getOrCreateLocalInstanceId,
  recommendedFn,
  testFn = testProviderKey,
  probeRequestFn,
  now = () => new Date(),
  classifierStatusFn,
  recOpts,
} = {}) {
  const router = Router();
  /** This box's addresses, probed at most once per request and passed down. */
  const ownOf = (req) => {
    if (!req.crowOwnAddrs) req.crowOwnAddrs = ownAddrs || probeOwnAddrs();
    return { ownAddrs: req.crowOwnAddrs };
  };

  router.use("/api/roles", sessionGate);

  const actorOf = (req) => `dashboard:${typeof req.dashboardUser === "string" && req.dashboardUser ? req.dashboardUser : "owner"}`;

  /** Run `fn(db)` on a fresh client, closed afterwards; errors answer 500 without detail. */
  const withDb = (label, fn) => async (req, res) => {
    let db;
    try {
      db = dbFactory();
      await fn(db, req, res);
    } catch (err) {
      console.warn(`[roles-api] ${label} failed: ${err?.message}`);
      if (!res.headersSent) res.status(500).json({ error: "internal" });
    } finally {
      try { db?.close?.(); } catch { /* best effort */ }
    }
  };

  const loadCtx = (db) => loadRoleContext(db, { maxAgeMs: 0, getOrCreateLocalInstanceId: localInstanceId });

  async function hasTrustedPeer(db) {
    let self = null;
    try { self = localInstanceId(); } catch { /* no id: every trusted row is a peer */ }
    const { rows } = await db.execute({
      sql: `SELECT 1 FROM crow_instances WHERE ${TRUSTED_PEER_SQL} AND id != ? LIMIT 1`,
      args: [self ?? ""],
    });
    return rows.length > 0;
  }

  async function speechPreview(db, roleId, profileId, own) {
    const profiles = await SPEECH[roleId].list(db); // keys stripped
    const profile = typeof profileId === "string" ? profiles.find((p) => p && p.id === profileId) : null;
    if (!profile) return null;
    const where = speechProfileWhere(profile, own);
    const host = speechProfileHost(profile);
    const cloud = !isSpeechWhereLocal(where);
    const paired = await hasTrustedPeer(db);
    const previewHash = createHash("sha256")
      .update(JSON.stringify([roleId, profile.id, profile.provider ?? null, profile.baseUrl ?? null, where, host, paired]))
      .digest("hex").slice(0, 32);
    return { where, host, cloud, paired, previewHash };
  }

  // --- Picks ----------------------------------------------------------------

  router.get("/api/roles/:id/picks", withDb("picks", async (db, req, res) => {
    const ctx = await loadCtx(db);
    const def = roleDef(req.params.id, ctx.customDefs);
    if (!def) return res.status(404).json({ error: "unknown_role" });
    const own = ownOf(req);
    const pickChecks = recommendedFn ? undefined : await readPickChecks(db);
    const picks = listRolePicks(def.id, {
      ctx, lang: langOf(req), ...(recommendedFn ? { recommendedFn } : { pickChecks, now: now(), recOpts }), ...own,
    });
    // The stored chain rides along so a Change from the page keeps it (it is sent back unchanged).
    const fb = ctx.bindings?.[def.id]?.fallback;
    const base = Array.isArray(fb) ? { picks, fallback: [...fb] } : { picks };
    if (!SPEECH[def.id]) return res.json(base);
    // Speech rows are views over the default profile (Phase 2).
    const profiles = (await SPEECH[def.id].list(db)).filter((p) => p && typeof p.id === "string").map((p) => ({
      id: p.id,
      name: typeof p.name === "string" ? p.name : p.id,
      provider: typeof p.provider === "string" ? p.provider : null,
      isDefault: p.isDefault === true,
      where: speechProfileWhere(p, own),
      host: speechProfileHost(p),
    }));
    res.json({ ...base, profiles });
  }));

  // --- Speech defaults (stt/tts) ---------------------------------------------
  // Registered before `/:id` so the literal `profile` segment wins.

  router.post("/api/roles/:id/profile/preview", csrfMiddleware, withDb("profile preview", async (db, req, res) => {
    if (!SPEECH[req.params.id]) return res.status(404).json({ error: "unknown_role" });
    const pv = await speechPreview(db, req.params.id, req.body?.profileId, ownOf(req));
    if (!pv) return res.status(404).json({ error: "unknown_profile" });
    res.json(pv);
  }));

  router.post("/api/roles/:id/profile", csrfMiddleware, withDb("profile apply", async (db, req, res) => {
    const roleId = req.params.id;
    if (!SPEECH[roleId]) return res.status(404).json({ error: "unknown_role" });
    const { profileId, previewHash, ackCloud } = req.body || {};
    const preview = await speechPreview(db, roleId, profileId, ownOf(req));
    if (!preview) return res.status(404).json({ error: "unknown_profile" });
    if (typeof previewHash !== "string" || previewHash !== preview.previewHash) {
      return res.status(409).json({ ok: false, reason: "preview_changed", preview });
    }
    if (preview.cloud && ackCloud !== true) return res.status(409).json({ ok: false, reason: "needs_ack_cloud", preview });
    if (!(await SPEECH[roleId].setDefault(db, profileId))) return res.status(404).json({ error: "unknown_profile" });
    console.log(`[roles-api] ${roleId} default profile set by ${actorOf(req)}`);
    res.json({ ok: true });
  }));

  // --- Chat-style roles: preview and apply -----------------------------------

  /** Validate the role and the change; answers and returns null on a refusal. */
  async function checkChange(db, req, res) {
    const ctx = await loadCtx(db);
    const def = roleDef(req.params.id, ctx.customDefs);
    if (!def) { res.status(404).json({ error: "unknown_role" }); return null; }
    if (MEDIA_CAPABILITIES.includes(def.capability)) { res.status(400).json({ error: "not_bindable" }); return null; }
    const { model, fallback } = req.body || {};
    if (!validModel(model, ctx.customDefs)) { res.status(400).json({ error: "invalid_model" }); return null; }
    if (!validFallback(fallback, ctx.customDefs)) { res.status(400).json({ error: "invalid_fallback" }); return null; }
    const ruleError = picksRuleError(def.id, { model, fallback }, ctx);
    if (ruleError) { res.status(400).json({ error: ruleError }); return null; }
    const change = { model: model ?? null };
    if (fallback !== undefined) change.fallback = [...fallback];
    return { ctx, roleId: def.id, change };
  }

  router.post("/api/roles/:id/preview", csrfMiddleware, withDb("preview", async (db, req, res) => {
    const c = await checkChange(db, req, res);
    if (!c) return;
    res.json(await previewRoleChange(db, c.roleId, c.change, { ctx: c.ctx, env, ...ownOf(req) }));
  }));

  router.post("/api/roles/:id", csrfMiddleware, withDb("apply", async (db, req, res) => {
    const c = await checkChange(db, req, res);
    if (!c) return;
    const { previewHash, ackUnattended, ackCloud, replacePin } = req.body || {};
    const r = await applyRoleChange(db, c.roleId, c.change, {
      actor: actorOf(req),
      previewHash,
      ackUnattended: ackUnattended === true,
      ackCloud: ackCloud === true,
      replacePin: replacePin === true,
      env,
      ...ownOf(req),
    });
    if (r.ok) return res.json({ ok: true, preview: r.preview });
    res.status(CONFLICT_REASONS.has(r.reason) ? 409 : 400).json({ ok: false, reason: r.reason, preview: r.preview });
  }));

  // --- Add a provider (roles phase 2b) -----------------------------------------

  // A typed address is only for "Other": a preset always uses its own URL.
  const providerBody = (b) => ({
    presetId: str(b?.presetId), variantId: str(b?.variantId),
    baseUrl: b?.presetId === "other" ? str(b?.baseUrl) : undefined, apiKey: str(b?.apiKey),
  });
  const planOpts = (req) => ({
    env, ...ownOf(req), now: now(), localInstanceId,
    ...(classifierStatusFn ? { classifierStatusFn } : {}), ...(recOpts ? { recOpts } : {}),
  });
  /**
   * The provider row named by `:id`, or null (answered 404). Door rows
   * (`crow-c-*`, another Crow's model door) and bundle rows (a local engine
   * an extension manages) are never providers this flow added or checks:
   * refused as `not_addable`, whatever their URL.
   */
  async function providerRow(db, req, res) {
    const id = req.params.id;
    const row = PROVIDER_ID.test(id || "") ? ((await loadCtx(db)).providers || []).find((p) => p && p.id === id) : null;
    if (!row) { res.status(404).json({ error: "unknown_provider" }); return null; }
    if (row.id.toLowerCase().startsWith("crow-c-") || row.bundleId || row.bundle_id) { res.status(404).json({ error: "not_addable" }); return null; }
    return row;
  }

  router.post("/api/providers/test", sessionGate, csrfMiddleware, async (req, res) => {
    try {
      const body = providerBody(req.body);
      const r = await testFn(body);
      const out = { ok: r?.ok === true, code: typeof r?.code === "string" ? r.code : "unreachable", models: null, host: typeof r?.host === "string" ? r.host : null };
      if (Number.isFinite(r?.status)) out.status = r.status;
      if (Array.isArray(r?.models)) out.models = r.models.filter((m) => typeof m === "string");
      if (r?.truncated === true) out.truncated = true;
      // A provider with no model list (modelsPath null): offer its recommended
      // ids as the choices, flagged so the sheet says there is no list.
      if (out.ok && out.models === null && presetById(body.presetId)?.modelsPath === null) {
        out.models = recommendedModelIds(body.presetId, recOpts);
        out.noListing = true;
      }
      out.recommended = out.ok ? recommendedIds(body.presetId, out.models, recOpts) : [];
      res.json(out);
    } catch (err) {
      console.warn(`[roles-api] provider test failed: ${err?.message}`);
      if (!res.headersSent) res.status(500).json({ error: "internal" });
    }
  });

  router.post("/api/providers", sessionGate, csrfMiddleware, withDb("provider add", async (db, req, res) => {
    const modelIds = req.body?.modelIds;
    const r = await addProvider(db, { ...providerBody(req.body), modelIds }, { testFn });
    if (r?.ok) {
      console.log(`[roles-api] provider ${r.providerId} added by ${actorOf(req)}`);
      const consent = ["granted", "failed", "not_needed", "ineligible"].includes(r.consent) ? r.consent : "failed";
      const out = { ok: true, providerId: r.providerId, consent };
      if (consent === "ineligible" && typeof r.consentReason === "string" && /^[a-z_]{1,32}$/.test(r.consentReason)) out.consentReason = r.consentReason;
      return res.json(out);
    }
    const out = { ok: false, code: typeof r?.code === "string" ? r.code : "save_failed" };
    if (Number.isFinite(r?.status)) out.status = r.status;
    res.status(400).json(out);
  }));

  router.get("/api/providers/:id/plan", sessionGate, withDb("provider plan", async (db, req, res) => {
    const row = await providerRow(db, req, res);
    if (!row) return;
    const opts = planOpts(req);
    const plan = await planRecommended(db, row.id, opts);
    // Each role's candidate pick and its stored check, for the sheet. Only the
    // row's saved (ticked) models are candidates; only chat and embed picks are probed.
    const presetId = presetForRow(row);
    const listed = listedIds(row);
    const ctx = await loadCtx(db);
    const picks = [];
    if (presetId) {
      for (const roleId of RECOMMENDATION_ROLES) {
        const p = candidatePick(presetId, roleId, { liveModelIds: listed.length ? listed : null }, recOpts);
        if (!p?.model_id) continue;
        const key = `${row.id}/${p.model_id}`;
        const probed = isProbeKind(p.kind);
        const check = !probed
          ? null
          : await pickCheckOf(db, row.id, p.model_id, { kind: checkKindFor(roleId), now: opts.now, recOpts, row });
        picks.push({
          roleId, modelId: p.model_id, key, kind: p.kind,
          label: friendlyModel(key, ctx.providers) || p.model_id,
          providerLabel: providerLabel(row.id, ctx.providers),
          probed,
          check: check ? {
            ok: check.ok, code: check.code, at: typeof check.at === "string" ? check.at : null,
            ...(check.retryable ? { retryable: true } : {}),
          } : null,
        });
      }
    }
    const reviewed = typeof loadRecommendations(recOpts).accessed === "string" ? loadRecommendations(recOpts).accessed : null;
    res.json({
      providerId: row.id, providerLabel: providerLabel(row.id, ctx.providers),
      apply: plan.apply, optIn: plan.optIn, skipped: plan.skipped,
      picks, stale: isRecommendationsStale(opts.now, recOpts), reviewed,
    });
  }));

  router.post("/api/providers/:id/probe", sessionGate, csrfMiddleware, withDb("provider probe", async (db, req, res) => {
    const row = await providerRow(db, req, res);
    if (!row) return;
    const roles = rolesOf(req.body);
    const r = await probeRecommended(db, row.id, {
      ...(roles && roles.length ? { roles } : {}),
      ...(probeRequestFn ? { requestFn: probeRequestFn } : {}),
      ...(recOpts ? { recOpts } : {}),
    });
    const out = {};
    for (const [roleId, v] of Object.entries(r || {})) {
      out[roleId] = { modelId: String(v?.modelId ?? ""), ok: v?.ok === true, code: String(v?.code ?? "") };
    }
    res.json(out);
  }));

  /** The fresh plan's apply/optIn/skipped lists, as /plan answers them (no key rides along). */
  const planOut = (plan) => ({ apply: plan.apply, optIn: plan.optIn, skipped: plan.skipped });

  /**
   * The {roleId, key} items a fresh plan offers for the named roles, or
   * `{plan}` when any named role is no longer offered.
   */
  async function offeredItems(db, providerId, roles, req) {
    const plan = await planRecommended(db, providerId, planOpts(req));
    const offered = new Map([...plan.apply, ...plan.optIn].map((x) => [x.roleId, x.key]));
    if (roles.some((r) => !offered.has(r))) return { plan };
    return { items: roles.map((roleId) => ({ roleId, key: offered.get(roleId) })) };
  }

  router.post("/api/providers/:id/recommended/preview", sessionGate, csrfMiddleware, withDb("recommended preview", async (db, req, res) => {
    const row = await providerRow(db, req, res);
    if (!row) return;
    const { items, plan } = await offeredItems(db, row.id, rolesOf(req.body) || [], req);
    // A ticked role the plan no longer offers: the sheet re-reads what is offered now.
    if (plan) return res.status(409).json({ ok: false, reason: "preview_changed", plan: planOut(plan) });
    res.json(await combinedPreview(db, items, planOpts(req)));
  }));

  router.post("/api/providers/:id/recommended", sessionGate, csrfMiddleware, withDb("recommended apply", async (db, req, res) => {
    const row = await providerRow(db, req, res);
    if (!row) return;
    const { previewHash, ackUnattended, ackCloud } = req.body || {};
    const r = await applyRecommended(db, row.id, {
      ...planOpts(req),
      roles: rolesOf(req.body) || [],
      previewHash: typeof previewHash === "string" ? previewHash : undefined,
      actor: actorOf(req),
      ackUnattended: ackUnattended === true,
      ackCloud: ackCloud === true,
    });
    const out = { ok: r.refused.length === 0, applied: r.applied, refused: r.refused, stillEmpty: r.stillEmpty };
    // Nothing written and the user can fix it by looking again or ticking a box: 409.
    const conflict = !r.applied.length && r.refused.length && r.refused.every((x) => CONFLICT_REASONS.has(x.reason));
    if (conflict && r.plan) out.plan = planOut(r.plan);
    if (r.applied.length) console.log(`[roles-api] recommended picks for ${row.id} applied by ${actorOf(req)}`);
    res.status(conflict ? 409 : 200).json(out);
  }));

  return router;
}
