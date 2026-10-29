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
 */
import { Router } from "express";
import { createHash } from "node:crypto";

import { createDbClient } from "../../db.js";
import { parseCookies } from "../dashboard/auth.js";
import { csrfMiddleware } from "../dashboard/shared/csrf.js";
import { SUPPORTED_LANGS } from "../dashboard/shared/i18n.js";
import { requireDashboardSessionJson } from "./models.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { CORE_ROLES, MEDIA_CAPABILITIES, isRoleRef, roleIdOf, isRawKey, isValidCustomRoleId } from "../../shared/model-roles.js";
import { loadRoleContext } from "../../shared/model-roles-store.js";
import { previewRoleChange, applyRoleChange } from "../../shared/role-change.js";
import { listRolePicks } from "../../shared/role-picks.js";
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

const langOf = (req) => {
  const c = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(c) ? c : "en";
};

/**
 * @param {object} [opts]
 * @param {() => object} [opts.dbFactory]
 * @param {Function} [opts.sessionGate]
 * @param {object} [opts.env]             env for pins and env overrides (default process.env)
 * @param {Set<string>} [opts.ownAddrs]   this box's addresses (default: probed)
 * @param {() => string} [opts.localInstanceId]
 * @param {(roleId:string) => string[]} [opts.recommendedFn]
 */
export default function rolesApiRouter({
  dbFactory = createDbClient,
  sessionGate = requireDashboardSessionJson,
  env = process.env,
  ownAddrs,
  localInstanceId = getOrCreateLocalInstanceId,
  recommendedFn,
} = {}) {
  const router = Router();
  const own = ownAddrs ? { ownAddrs } : {};

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

  async function speechPreview(db, roleId, profileId) {
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
    const picks = listRolePicks(def.id, { ctx, lang: langOf(req), ...(recommendedFn ? { recommendedFn } : {}), ...own });
    if (!SPEECH[def.id]) return res.json({ picks });
    // Speech rows are views over the default profile (Phase 2).
    const profiles = (await SPEECH[def.id].list(db)).filter((p) => p && typeof p.id === "string").map((p) => ({
      id: p.id,
      name: typeof p.name === "string" ? p.name : p.id,
      provider: typeof p.provider === "string" ? p.provider : null,
      isDefault: p.isDefault === true,
      where: speechProfileWhere(p, own),
      host: speechProfileHost(p),
    }));
    res.json({ picks, profiles });
  }));

  // --- Speech defaults (stt/tts) ---------------------------------------------
  // Registered before `/:id` so the literal `profile` segment wins.

  router.post("/api/roles/:id/profile/preview", csrfMiddleware, withDb("profile preview", async (db, req, res) => {
    if (!SPEECH[req.params.id]) return res.status(404).json({ error: "unknown_role" });
    const pv = await speechPreview(db, req.params.id, req.body?.profileId);
    if (!pv) return res.status(404).json({ error: "unknown_profile" });
    res.json(pv);
  }));

  router.post("/api/roles/:id/profile", csrfMiddleware, withDb("profile apply", async (db, req, res) => {
    const roleId = req.params.id;
    if (!SPEECH[roleId]) return res.status(404).json({ error: "unknown_role" });
    const { profileId, previewHash, ackCloud } = req.body || {};
    const preview = await speechPreview(db, roleId, profileId);
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
    const change = { model: model ?? null };
    if (fallback !== undefined) change.fallback = [...fallback];
    return { ctx, roleId: def.id, change };
  }

  router.post("/api/roles/:id/preview", csrfMiddleware, withDb("preview", async (db, req, res) => {
    const c = await checkChange(db, req, res);
    if (!c) return;
    res.json(await previewRoleChange(db, c.roleId, c.change, { ctx: c.ctx, env, ...own }));
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
      ...own,
    });
    if (r.ok) return res.json({ ok: true, preview: r.preview });
    res.status(CONFLICT_REASONS.has(r.reason) ? 409 : 400).json({ ok: false, reason: r.reason, preview: r.preview });
  }));

  return router;
}
