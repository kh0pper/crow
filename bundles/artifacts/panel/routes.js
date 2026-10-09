/**
 * Crow Artifacts — panel routes (`/api/artifacts/*` + `/artifacts/static/*`).
 *
 * COPIED ALONE to `$CROW_HOME/panels/artifacts-routes.js` at install, so every
 * bundle module is imported by absolute path (phone/ramble pattern). Every
 * middleware is path-scoped (STRICT_PANEL_MOUNT). Every /api/artifacts route
 * is the OWNER: dashboard session (dashboardAuth) + CSRF on writes. No bot
 * token, peer request or artifact-origin request can reach these routes: the
 * artifact origin is a separate listener with no route here, and dashboardAuth
 * refuses Funnel traffic.
 */
import { Router, json } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "artifacts"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "artifacts") : null,
  resolve(__dirname, ".."),
].filter(Boolean);
const BUNDLE_DIR = CANDIDATES.find((p) => existsSync(join(p, "manifest.json"))) || CANDIDATES[CANDIDATES.length - 1];
const bundleImport = (rel) => import(pathToFileURL(join(BUNDLE_DIR, rel)).href);
const APP_ROOT = process.env.CROW_APP_ROOT || resolve(BUNDLE_DIR, "..", "..");
const appImport = (rel) => import(pathToFileURL(join(APP_ROOT, rel)).href);

const STATIC = { "viewer.js": "text/javascript; charset=utf-8", "panel-client.js": "text/javascript; charset=utf-8", "panel.css": "text/css; charset=utf-8" };

/**
 * @param {Function} dashboardAuth
 * @param {object} seams  tests: { db, blobs, csrf, runtime, policy, notify, renderDeps }
 *   (the round/thread routes and their engine seams arrive with step 3)
 */
export default function artifactsRouter(dashboardAuth, seams = {}) {
  const router = Router();
  let ready = null, M = null;
  const S = { ...seams };

  async function init() {
    const [store, comments, tables, blobMinio] = await Promise.all(
      ["server/store.js", "server/comments.js", "server/init-tables.js", "server/blob-store-minio.js"].map(bundleImport));
    if (!S.db) { const { createDbClient } = await appImport("servers/db.js"); S.db = createDbClient(); }
    await tables.initArtifactsTables(S.db);
    if (!S.blobs) { const { resolveDataDir } = await appImport("servers/db.js"); S.blobs = await blobMinio.createBlobStore(S.db, resolveDataDir()); }
    if (!S.runtime) S.runtime = await appImport("servers/gateway/artifact-origin/runtime.js");
    if (!S.renderDeps) { const r = await appImport("servers/blog/renderer.js"); S.renderDeps = { markdownBlocks: r.markdownBlocks }; }
    if (!S.csrf) S.csrf = (await appImport("servers/gateway/dashboard/shared/csrf.js")).csrfMiddleware;
    if (!S.policy) S.policy = await appImport("servers/gateway/artifact-origin/policy.js");
    S.runtime.setContentResolver(store.contentResolver(S.db, S.blobs));
    M = { store, comments };
  }
  const ensure = () => (ready ??= init().catch((e) => { ready = null; throw e; }));
  const OWNER = { kind: "session", id: null };
  const wrap = (fn) => async (req, res) => {
    try { await ensure(); await fn(req, res); }
    catch (e) {
      const map = { not_found: 404, forbidden: 403, round_running: 409, quota_full: 507, too_large: 413, bad_request: 400, bad_anchor: 400, too_long: 400, rate_limited: 429, too_many_threads: 429, bad_source: 400, flagged: 409, bad_origin: 403 };
      res.status(map[e.code] || 500).json({ error: e.code || "error", message: e.code ? e.message : "internal error", ...(e.holders ? { holders: e.holders } : {}) });
    }
  };
  const csrfMw = async (req, res, next) => { try { await ensure(); } catch (e) { return res.status(500).json({ error: "init" }); } return S.csrf(req, res, next); };

  router.use("/api/artifacts", dashboardAuth, json({ limit: "60mb" }), csrfMw);
  router.use("/artifacts/static", dashboardAuth);

  router.get("/artifacts/static/:file", (req, res) => {
    // Own properties only: a prototype key (__proto__, constructor, …) must
    // 404 like any other unknown name, not reach setHeader/readFileSync
    // (review L1).
    if (!Object.hasOwn(STATIC, req.params.file)) return res.status(404).end();
    const type = STATIC[req.params.file];
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "no-store");
    res.end(readFileSync(join(BUNDLE_DIR, "panel", "static", req.params.file)));
  });

  router.get("/api/artifacts", wrap(async (_req, res) => {
    res.json({ artifacts: await M.store.listArtifacts(S.db, OWNER), origin: S.runtime.artifactOriginInfo() ? { isolation: S.runtime.isolationFor(_req.headers.host) } : { isolation: "unavailable" } });
  }));

  router.get("/api/artifacts/:id", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const versions = (await S.db.execute({ sql: "SELECT n, state, made_by, made_by_bot, round_id, untrusted_input, change_note, proposed_reason, flagged_reason, created_at, anchor_map_json FROM artifact_versions WHERE artifact_id=? ORDER BY n DESC", args: [art.id] })).rows;
    res.json({ artifact: art, versions: versions.map((v) => ({ ...v, anchor_map: v.anchor_map_json ? JSON.parse(v.anchor_map_json) : null, anchor_map_json: undefined })), threads: await M.comments.listThreads(S.db, art.id) });
  }));

  /**
   * Mint a view token for ONE version and ONE frame load (§5.1). The token's
   * frame-ancestors is the dashboard origin the browser itself declared on
   * this same-origin POST (Origin header), checked against Host — so every
   * instance gets its own frame-ancestors with no configuration (M5).
   */
  router.post("/api/artifacts/:id/versions/:n/view", wrap(async (req, res) => {
    const info = S.runtime.artifactOriginInfo();
    if (!info) return res.status(503).json({ error: "origin_unavailable" });
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const v = await M.store.getVersion(S.db, art.id, Number(req.params.n));
    if (!v) throw Object.assign(new Error("no such version"), { code: "not_found" });
    if (v.flagged_reason) throw Object.assign(new Error("this version tried to leave its frame"), { code: "flagged" });
    const origin = String(req.headers.origin || "");
    let o; try { o = new URL(origin); } catch { o = null; }
    if (!o || o.host !== String(req.headers.host || "") || o.origin !== origin) throw Object.assign(new Error("bad origin"), { code: "bad_origin" });
    // D20: a tainted version of a scripted type runs with scripts OFF until
    // the owner presses "Run this version's scripts" (= approve, audited).
    const scriptsOff = S.policy.isScriptedType(art.type) && M.store.isTainted(v);
    const eff = S.policy.effectiveType(art.type, scriptsOff);
    const { token, nonce } = S.runtime.viewTokens().mint({ artifactId: art.id, versionN: Number(v.n), type: art.type, dashboardOrigin: o.origin, scriptsOff });
    const fragment = typeof req.body?.fragment === "string" && /^b\d{1,6}$/.test(req.body.fragment) ? req.body.fragment : null;
    res.json({
      url: `${info.baseUrl}/v/${token}/`, nonce, type: art.type, fragment,
      sandbox: S.policy.iframeSandboxFor(eff), scripted: S.policy.isScriptedType(eff), scriptsOff,
      isolation: S.runtime.isolationFor(req.headers.host),
    });
  }));

  // §5.1 tripwire report: flag, revoke every live token for the artifact, audit, notify.
  router.post("/api/artifacts/:id/versions/:n/tripwire", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const reason = String(req.body?.reason || "unknown").replace(/[^a-z-]/g, "").slice(0, 32) || "unknown";
    await M.store.flagVersion(S.db, { artifactId: art.id, n: Number(req.params.n), reason, actor: OWNER });
    S.runtime.viewTokens().revokeArtifact(art.id);
    if (S.notify) await S.notify({ title: `"${art.title}" tried to leave its frame`, body: `Version ${Number(req.params.n)} was closed and flagged.`, type: "attention", source: "artifacts", action_url: `/dashboard/artifacts?id=${encodeURIComponent(art.id)}` });
    res.json({ flagged: true });
  }));

  router.post("/api/artifacts/:id/versions/:n/decide", wrap(async (req, res) => {
    await M.store.requireAccess(S.db, OWNER, req.params.id);
    const out = await M.store.decideProposed(S.db, { artifactId: req.params.id, n: Number(req.params.n), accept: req.body?.accept === true, actor: OWNER, blobs: S.blobs });
    if (out.current) await M.comments.carryForwardTo(S.db, S.blobs, req.params.id, out.current);
    res.json(out);
  }));

  // The owner's explicit approval: the only action that clears taint (§7.3).
  router.post("/api/artifacts/:id/versions/:n/approve", wrap(async (req, res) => {
    await M.store.requireAccess(S.db, OWNER, req.params.id);
    res.json(await M.store.approveVersion(S.db, { artifactId: req.params.id, n: Number(req.params.n), actor: OWNER }));
  }));

  return router;
}
