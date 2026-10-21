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

const STATIC = {
  "viewer.js": "text/javascript; charset=utf-8", "panel-client.js": "text/javascript; charset=utf-8", "panel.css": "text/css; charset=utf-8",
  "viewer-client.js": "text/javascript; charset=utf-8", "viewer.css": "text/css; charset=utf-8",
};

/**
 * @param {Function} dashboardAuth
 * @param {object} seams  tests: { db, blobs, engine, csrf, runtime, policy, notify, renderDeps, loadBotDef, createBoardCard }
 */
export default function artifactsRouter(dashboardAuth, seams = {}) {
  const router = Router();
  let ready = null, M = null;
  const S = { ...seams };

  async function init() {
    const [store, comments, rounds, delivery, tables, blobMinio, links] = await Promise.all(
      ["server/store.js", "server/comments.js", "server/rounds.js", "server/delivery.js", "server/init-tables.js", "server/blob-store-minio.js", "server/links.js"].map(bundleImport));
    if (!S.db) { const { createDbClient } = await appImport("servers/db.js"); S.db = createDbClient(); }
    await tables.initArtifactsTables(S.db);
    if (!S.blobs) { const { resolveDataDir } = await appImport("servers/db.js"); S.blobs = await blobMinio.createBlobStore(S.db, resolveDataDir()); }
    if (!S.runtime) S.runtime = await appImport("servers/gateway/artifact-origin/runtime.js");
    // D4's "Create a board card": the gateway's factory (tasks.db + card/plan
    // services). Absent/broken board → null, and deliverRound reports no_board.
    if (S.createBoardCard === undefined) {
      try {
        const ac = await appImport("servers/gateway/board/artifact-card.js");
        S.createBoardCard = ac.makeArtifactBoardCard({ db: S.db });
      } catch { S.createBoardCard = null; }
    }
    // The Design kit (spec §4): used only when installed on this instance.
    // Panel-path renders get it too, like the MCP mount's renderDeps.
    // design.js failing to load degrades to "no kit" (null, not retried);
    // it never takes the panel down (final review M4).
    if (S.design === undefined) {
      try {
        const d = await (S.importDesign || (() => bundleImport("server/design.js")))();
        S.design = d.createDesign({ crowHome: process.env.CROW_HOME || join(homedir(), ".crow"), db: S.db });
      } catch (e) {
        console.warn(`[artifacts] the Design kit seam could not be loaded (${(e && e.code) || "error"}); the panel runs without the kit`);
        S.design = null;
      }
    }
    if (!S.renderDeps) { const r = await appImport("servers/blog/renderer.js"); S.renderDeps = { markdownBlocks: r.markdownBlocks, design: S.design }; }
    if (!S.designShared) S.designShared = await appImport("servers/shared/design-kit.js");
    if (!S.csrf) S.csrf = (await appImport("servers/gateway/dashboard/shared/csrf.js")).csrfMiddleware;
    if (!S.policy) S.policy = await appImport("servers/gateway/artifact-origin/policy.js");
    S.runtime.setContentResolver(store.contentResolver(S.db, S.blobs));
    M = { store, comments, rounds, delivery, links };
    S.plainBackfill = comments.backfillPlain(S.db, S.blobs, S.renderDeps.markdownBlocks).then((r) => {
      if (r.versions || r.skipped || r.stopped) console.log(`[artifacts] plain backfill: ${r.versions} version(s), ${r.threads} thread(s), ${r.skipped} left on the fallback${r.stopped ? "; stopped early (storage unavailable), retried at the next start" : ""}`);
    }, (e) => console.warn(`[artifacts] plain backfill failed (${(e && e.code) || "error"}); old documents stay on the markdown fallback`));
  }
  const ensure = () => (ready ??= init().catch((e) => { ready = null; throw e; }));
  const OWNER = { kind: "session", id: null };
  const wrap = (fn) => async (req, res) => {
    try { await ensure(); await fn(req, res); }
    catch (e) {
      const map = { not_found: 404, forbidden: 403, round_running: 409, quota_full: 507, too_large: 413, bad_request: 400, bad_anchor: 400, too_long: 400, rate_limited: 429, too_many_threads: 429, bad_source: 400, flagged: 409, bad_origin: 403, comment_locked: 409,
        target_unlinked: 400, target_other_bot: 400, target_no_access: 400, target_not_bots_chat: 400, bot_lacks_artifacts: 400, target_locked: 400, already_decided: 409, stale: 409 };
      res.status(map[e.code] || 500).json({ error: e.code || "error", message: e.code ? e.message : "internal error", ...(e.holders ? { holders: e.holders } : {}) });
    }
  };
  const csrfMw = async (req, res, next) => { try { await ensure(); } catch (e) { return res.status(500).json({ error: "init" }); } return S.csrf(req, res, next); };

  router.use("/api/artifacts", dashboardAuth, json({ limit: "60mb" }), csrfMw);
  router.use("/artifacts/static", dashboardAuth);

  /**
   * The viewer page (plan PR-2 Task 2.1): the one page that frames the
   * artifact origin. Mounted at the app root like every route here; the
   * dashboard router's `/dashboard/:panelId` matches one segment only, so
   * this 4-segment path reaches us. Path-scoped auth; the core viewerCsp.
   */
  router.get("/dashboard/artifacts/view/:id", dashboardAuth, async (req, res) => {
    try {
      const page = await bundleImport("panel/viewer-page.js");
      if (!page.ARTIFACT_ID_RE.test(req.params.id)) return res.status(404).type("text/plain").send("not found");
      await ensure();
      const origin = S.runtime.artifactOriginInfo()?.baseUrl || null;
      for (const [k, v] of Object.entries(page.viewerHeaders(S.policy.viewerCsp, origin))) res.setHeader(k, v);
      const m = /(?:^|;\s*)crow_lang=([a-z]{2})/.exec(String(req.headers.cookie || ""));
      const lang = m && m[1] === "es" ? "es" : "en";
      const { v, thread } = page.viewerParams(req.query);
      // The player bar (bar on every Crow page): the core shell, emitted only here, behind dashboardAuth.
      // An older core without the module renders the viewer with no bar.
      let shellHtml = "";
      try { shellHtml = (await appImport("servers/gateway/dashboard/shared/player-shell.js")).playerShellHtml(lang); } catch { shellHtml = ""; }
      res.type("html").send(page.renderViewerPage({ lang, id: req.params.id, v, thread, shellHtml }));
    } catch {
      res.status(500).type("text/plain").send("error");
    }
  });

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

  /** The Library list (plan PR-3 Task 3.9): each row carries its badges,
   *  derived server-side from store rows — scripts-off (the D20 expression on
   *  the current version), open contact threads, active linked chats. */
  router.get("/api/artifacts", wrap(async (_req, res) => {
    const arts = await M.store.listArtifacts(S.db, OWNER);
    const out = [];
    for (const a of arts) {
      const cur = await M.store.getVersion(S.db, a.id, a.current_version);
      const contact = Number((await S.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_threads WHERE artifact_id=? AND author_kind='contact' AND status<>'resolved'", args: [a.id] })).rows[0].n);
      const links = Number((await S.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_links WHERE artifact_id=? AND unlinked_at IS NULL", args: [a.id] })).rows[0].n);
      out.push({ ...a, badges: { scriptsOff: !!(cur && S.policy.isScriptedType(a.type) && M.store.isTainted(cur)), contactComments: contact, links } });
    }
    res.json({ artifacts: out, origin: S.runtime.artifactOriginInfo() ? { isolation: S.runtime.isolationFor(_req.headers.host) } : { isolation: "unavailable" } });
  }));

  /**
   * Chat-first replay (spec v1.6 D25; plan PR-1 Task 1.3): the artifact
   * events of ONE Perch thread, so a reloaded transcript redraws its cards —
   * the file-card history contract. Derived from the audit log (the store is
   * the system of record); capped at 200 rows, newest last. Owner-only like
   * every route here. A chat sees the artifacts ACTIVELY linked to it
   * (artifact_links, D25); an unlinked chat's cards stop replaying.
   */
  const THREAD_EVENT_FOR = { create: "create", version: "update", "version-proposed": "update", reply: "reply", "round-done": "round-done", "ask-done": "round-done" };
  router.get("/api/artifacts/by-thread/:thread", wrap(async (req, res) => {
    const actions = Object.keys(THREAD_EVENT_FOR);
    const rows = (await S.db.execute({
      sql: `SELECT au.artifact_id, au.action, au.target, au.ts FROM artifact_audit au
            JOIN artifacts a ON a.id=au.artifact_id
            WHERE a.deleted_at IS NULL AND au.action IN (${actions.map(() => "?").join(",")})
              AND EXISTS (SELECT 1 FROM artifact_links l WHERE l.artifact_id=a.id AND l.thread_id=? AND l.unlinked_at IS NULL)
            ORDER BY au.id DESC LIMIT 200`,
      args: [...actions, String(req.params.thread)],
    })).rows;
    rows.reverse();   // the cap keeps the NEWEST 200; the client replays oldest-first
    res.json({
      items: rows.map((r) => {
        const v = /^v(\d+)$/.exec(String(r.target || ""));
        return { artifactId: r.artifact_id, event: THREAD_EVENT_FOR[r.action], n: v ? Number(v[1]) : null, ts: r.ts };
      }),
    });
  }));

  /**
   * Feedback cards in chat (plan PR-3 Task 3.8, review N5). Store-derived, no
   * engine change: a chat lists the rounds DELIVERED to it, one card per
   * round id. The card shows the round SNAPSHOT's owner comments — what was
   * actually sent — never a comment added after Send.
   * Contact text is impossible BY ROUTE: an untrusted round (untrusted_input
   * not exactly 0) is refused here outright, whatever its delivery says.
   * Only rounds that reached the chat count (perch-session to this thread,
   * working / done / timed-out; never failed, queued or pending).
   */
  const cardRound = (t) => `${t}kind='round' AND ${t}delivery='perch-session' AND ${t}status IN ('working','done','timed-out') AND ${t}untrusted_input=0`;
  const anchorLabel = (j) => { let a = null; try { a = JSON.parse(j || "null"); } catch { a = null; } return String((a && (a.text || a.quote || a.selector || a.id || a.kind)) || "").slice(0, 200); };
  router.get("/api/artifacts/rounds-by-thread/:thread", wrap(async (req, res) => {
    const rows = (await S.db.execute({ sql: `SELECT r.id, r.artifact_id, r.base_version, r.result_version, r.thread_ids_json, r.status, r.created_at, a.title FROM artifact_rounds r JOIN artifacts a ON a.id=r.artifact_id WHERE r.session_id=? AND a.deleted_at IS NULL AND ${cardRound("r.")} ORDER BY r.id LIMIT 50`, args: [String(req.params.thread)] })).rows;
    res.setHeader("cache-control", "no-store");
    res.json({ cards: rows.map((r) => { let n = 0; try { n = JSON.parse(r.thread_ids_json || "[]").length; } catch { n = 0; } return { roundId: Number(r.id), artifactId: r.artifact_id, title: r.title, version: Number(r.base_version), resultVersion: r.result_version == null ? null : Number(r.result_version), count: n, status: r.status, at: r.created_at }; }) });
  }));
  router.get("/api/artifacts/rounds/:rid/card", wrap(async (req, res) => {
    const rid = Number(req.params.rid);
    const r = Number.isInteger(rid) ? (await S.db.execute({ sql: `SELECT * FROM artifact_rounds WHERE id=? AND ${cardRound("")}`, args: [rid] })).rows[0] : null;
    if (!r) throw Object.assign(new Error("no such card"), { code: "not_found" });
    const art = await M.store.requireAccess(S.db, OWNER, r.artifact_id);
    let snap = {}; try { snap = JSON.parse(r.snapshot_json || "{}") || {}; } catch { snap = {}; }
    // Review L5: the words AS SENT (frozen at Send); a round frozen before
    // owner_text existed falls back to today's text.
    const sent = snap.owner_text && typeof snap.owner_text === "object" ? snap.owner_text : {};
    const textOf = (c) => (Object.prototype.hasOwnProperty.call(sent, String(c.id)) && typeof sent[c.id] === "string" ? sent[c.id] : c.text);
    const threads = [];
    for (const [tid, maxId] of Object.entries(snap)) {
      if (!/^\d+$/.test(tid)) continue;
      const t = (await S.db.execute({ sql: "SELECT anchor_json FROM artifact_threads WHERE id=? AND artifact_id=?", args: [Number(tid), art.id] })).rows[0];
      if (!t) continue;
      const cs = (await S.db.execute({ sql: "SELECT id, text FROM artifact_comments WHERE thread_id=? AND id<=? AND author_kind='owner' AND deleted_at IS NULL ORDER BY id", args: [Number(tid), Number(maxId)] })).rows;
      threads.push({ anchor: anchorLabel(t.anchor_json), comments: cs.map(textOf) });
    }
    res.setHeader("cache-control", "no-store");
    res.json({ roundId: rid, artifactId: art.id, title: art.title, version: Number(r.base_version), threads });
  }));

  /**
   * Ask-first linking, the owner's side (plan PR-3 Task 3.5, spec D25). A bot's
   * artifact_attach left a PENDING request and an ask card in its chat; the
   * hub lists that chat's pending requests here and the owner decides. Only
   * Yes writes the link (owner-yes), audited, and the chat hears
   * "link-decided". One decision wins (the UPDATE is the claim). Registered
   * before /api/artifacts/:id so "link-requests" is never read as an id.
   */
  const emitTo = async (thread, frame, botId) => {
    try {
      const emit = S.emitExternal || (await appImport("servers/gateway/perch-interactive.js")).emitExternalToResident;
      await emit(thread, frame, { botId });
    } catch { /* the store holds the decision; the hub refetches on open */ }
  };
  router.get("/api/artifacts/link-requests", wrap(async (req, res) => {
    const thread = String(req.query.thread || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(thread)) throw Object.assign(new Error("thread"), { code: "bad_request" });
    const rows = (await S.db.execute({ sql: "SELECT r.id, r.artifact_id, r.bot_id, r.requested_at, a.title FROM artifact_link_requests r JOIN artifacts a ON a.id=r.artifact_id WHERE r.thread_id=? AND r.status='pending' AND a.deleted_at IS NULL ORDER BY r.id", args: [thread] })).rows;
    res.setHeader("cache-control", "no-store");
    res.json({ requests: rows.map((r) => ({ id: Number(r.id), artifactId: r.artifact_id, title: r.title, botId: r.bot_id, requestedAt: r.requested_at })) });
  }));
  router.post("/api/artifacts/link-requests/:rid/decide", wrap(async (req, res) => {
    const rid = Number(req.params.rid);
    const r = Number.isInteger(rid) ? (await S.db.execute({ sql: "SELECT * FROM artifact_link_requests WHERE id=?", args: [rid] })).rows[0] : null;
    if (!r) throw Object.assign(new Error("no such request"), { code: "not_found" });
    const art = await M.store.requireAccess(S.db, OWNER, r.artifact_id);
    const accept = req.body?.accept === true;
    const claim = (status) => S.db.execute({ sql: "UPDATE artifact_link_requests SET status=?, decided_at=datetime('now') WHERE id=? AND status='pending'", args: [status, rid] });
    // A Yes for a bot that can no longer reach the artifact links nothing.
    if (accept && !(await M.store.canAccess(S.db, { kind: "bot", id: r.bot_id }, art))) {
      if (Number((await claim("declined")).rowsAffected) === 1) await M.store.audit(S.db, { artifactId: art.id, actor: OWNER, action: "link-declined", target: r.thread_id, detail: { reason: "no_access" } });
      throw Object.assign(new Error("that bot can't work on this artifact"), { code: "target_no_access" });
    }
    if (Number((await claim(accept ? "accepted" : "declined")).rowsAffected) !== 1) throw Object.assign(new Error("already decided"), { code: "already_decided" });
    if (accept) {
      // Review L2: the insert itself re-checks access, so a revoke landing
      // between the check above and this write links nothing.
      try { await S.db.execute({ sql: "INSERT INTO artifact_links (artifact_id,bot_id,thread_id,linked_by) SELECT ?,?,?,'owner-yes' WHERE EXISTS (SELECT 1 FROM artifacts WHERE id=? AND created_by_bot=? AND received=0 AND deleted_at IS NULL) OR EXISTS (SELECT 1 FROM artifact_bot_access WHERE artifact_id=? AND bot_id=?)", args: [art.id, r.bot_id, r.thread_id, art.id, r.bot_id, art.id, r.bot_id] }); }
      catch (e) { if (!/UNIQUE/i.test(String(e.message))) throw e; /* already actively linked */ }
    }
    await M.store.audit(S.db, { artifactId: art.id, actor: OWNER, action: accept ? "link-accepted" : "link-declined", target: r.thread_id, detail: { request: rid } });
    await emitTo(r.thread_id, { type: "artifact", artifactId: art.id, n: null, event: "link-decided" }, r.bot_id);
    res.json({ decided: accept ? "accepted" : "declined" });
  }));

  /**
   * The owner's "Let <bot> work on this" (plan PR-3 Task 3.7). NEVER
   * bot-callable: dashboard auth + CSRF only, no MCP tool. The picker lists
   * bots whose def grants the Artifacts tools. A grant opens the artifact to
   * that bot (get/find/attach/update); a revoke closes it and unlinks that
   * bot's chats from it (a chat of a bot that can no longer reach the
   * artifact must not keep receiving its cards). Both audited.
   * /api/artifacts/bots is registered before /api/artifacts/:id.
   */
  async function artifactBots({ withTheme = false } = {}) {
    let rows = [];
    try { rows = (await S.db.execute({ sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE enabled=1 ORDER BY display_name", args: [] })).rows; } catch { rows = []; }
    const out = [];
    for (const r of rows) {
      let def = null; try { def = JSON.parse(r.definition || "{}"); } catch { def = null; }
      if (!M.delivery.botHasArtifactsTools(def)) continue;
      const bot = { id: String(r.bot_id), name: String(r.display_name || r.bot_id) };
      if (withTheme) bot.theme = S.designShared.botThemeOf(def);
      out.push(bot);
    }
    return out;
  }

  /**
   * House style (design kit spec §4.4, D4/D5). Owner-only (dashboard auth +
   * CSRF), never bot-callable: no MCP tool writes it. A project's theme lives
   * in design_house_styles (by the project's uuid, exactly as stored); a
   * bot's default in pi_bot_defs.definition.design.house_style. Off unless
   * set. Archived projects and learner profiles are neither listed nor
   * writable (review L8). Registered before /api/artifacts/:id.
   */
  const COLOR_ROLES = ["bg", "fg", "accent", "accent2"];
  const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
  async function kitThemes() {
    const k = S.design ? await S.design.kit() : null;
    if (!k) return null;
    const out = [];
    for (const [id, t] of k.themes.entries()) {
      if (!S.designShared.THEME_ID_RE.test(id)) continue;
      const c = (t && t.colors) || {};
      // By role (ruling F9), never by the JSON's key order.
      const colors = COLOR_ROLES.map((role) => c[role]).filter((v) => typeof v === "string" && HEX_RE.test(v));
      out.push({ id, name: String((t && t.name) || id).slice(0, 60), colors });
    }
    return out;
  }
  const LIVE_PROJECT = "p.type<>'learner_profile' AND p.status<>'archived' AND p.archived_at IS NULL";
  router.get("/api/artifacts/house-style", wrap(async (_req, res) => {
    const themes = await kitThemes();
    let projects = [];
    try { projects = (await S.db.execute({ sql: `SELECT p.id, p.name, h.theme FROM project_spaces p LEFT JOIN design_house_styles h ON h.project_uuid=p.uuid WHERE ${LIVE_PROJECT} ORDER BY p.name`, args: [] })).rows; } catch { projects = []; }
    res.json({ kit: !!themes, themes: themes || [], projects: projects.map((p) => ({ id: Number(p.id), name: String(p.name), theme: p.theme || null })), bots: await artifactBots({ withTheme: true }) });
  }));
  router.post("/api/artifacts/house-style", wrap(async (req, res) => {
    const b = req.body || {};
    const theme = b.theme == null || b.theme === "" ? null : String(b.theme);
    const bad = (m) => Object.assign(new Error(m), { code: "bad_request" });
    const notFound = (m) => Object.assign(new Error(m), { code: "not_found" });
    if (b.scope !== "project" && b.scope !== "bot") throw bad("scope must be project or bot");
    if (theme !== null) { const themes = await kitThemes(); if (!themes || !themes.some((t) => t.id === theme)) throw bad("unknown theme"); }
    if (b.scope === "project") {
      const id = typeof b.id === "number" ? b.id : (/^\d+$/.test(String(b.id ?? "")) ? Number(b.id) : NaN);
      let p = null;
      if (Number.isSafeInteger(id)) {
        try { p = (await S.db.execute({ sql: `SELECT p.uuid FROM project_spaces p WHERE p.id=? AND ${LIVE_PROJECT}`, args: [id] })).rows[0] || null; } catch { p = null; }
      }
      if (!p || typeof p.uuid !== "string" || !p.uuid) throw notFound("no such project");
      if (theme === null) await S.db.execute({ sql: "DELETE FROM design_house_styles WHERE project_uuid=?", args: [p.uuid] });
      else await S.db.execute({ sql: "INSERT INTO design_house_styles (project_uuid, theme) VALUES (?,?) ON CONFLICT(project_uuid) DO UPDATE SET theme=excluded.theme, set_at=datetime('now')", args: [p.uuid, theme] });
      await M.store.audit(S.db, { actor: OWNER, action: "house-style", target: `project:${id}`, detail: { theme } });
      return res.json({ ok: true });
    }
    const id = String(b.id || "");
    // The reserved Crow voice bot has no house style; refuse set and clear before any read or write.
    if ((await appImport("servers/shared/voice-bot.js")).isVoiceBotId(id)) throw bad("the Crow voice bot has no house style");
    let row = null;
    try { row = (await S.db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0] || null; } catch { row = null; }
    if (!row) throw notFound("no such bot");
    // Setting needs a bot that uses Artifacts (the listed ones); clearing a
    // stale default works on any bot.
    if (theme !== null && !(await artifactBots()).some((x) => x.id === id)) throw bad("that bot has no Artifacts tools");
    let def; try { def = JSON.parse(row.definition || "{}"); } catch { def = null; }
    if (!def || typeof def !== "object" || Array.isArray(def)) throw bad("the bot's definition could not be read; fix it in Bot Builder");
    const design = { ...(def.design && typeof def.design === "object" && !Array.isArray(def.design) ? def.design : {}) };
    if (theme === null) delete design.house_style; else design.house_style = theme;
    const next = { ...def };
    if (Object.keys(design).length) next.design = design; else delete next.design;
    // Compare-and-swap on the definition read above (Bot Builder's rule): a
    // concurrent Bot Builder save wins and this one asks for a reload.
    const r = await S.db.execute({ sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=? AND definition IS ?", args: [JSON.stringify(next), id, row.definition ?? null] });
    if (!Number(r.rowsAffected)) throw Object.assign(new Error("the bot changed meanwhile; reload and try again"), { code: "stale" });
    try { (await appImport("servers/gateway/dashboard/panels/bot-builder/defs-changed.js")).emitBotDefsChanged(id); } catch { /* no bot-builder bus here */ }
    await M.store.audit(S.db, { actor: OWNER, action: "house-style", target: `bot:${id}`, detail: { theme } });
    res.json({ ok: true });
  }));
  router.get("/api/artifacts/bots", wrap(async (_req, res) => { res.json({ bots: await artifactBots() }); }));
  router.get("/api/artifacts/:id/access", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const rows = (await S.db.execute({ sql: "SELECT bot_id, granted_at FROM artifact_bot_access WHERE artifact_id=? ORDER BY granted_at", args: [art.id] })).rows;
    res.json({ grants: rows.map((r) => ({ botId: r.bot_id, grantedAt: r.granted_at })) });
  }));
  router.post("/api/artifacts/:id/access", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const botId = String(req.body?.botId || "");
    if (!botId || botId === art.created_by_bot) throw Object.assign(new Error("pick another bot"), { code: "bad_request" });
    if (!(await artifactBots()).some((b) => b.id === botId)) throw Object.assign(new Error("that bot has no Artifacts tools"), { code: "bad_request" });
    await S.db.execute({ sql: "INSERT OR IGNORE INTO artifact_bot_access (artifact_id, bot_id) VALUES (?,?)", args: [art.id, botId] });
    await M.store.audit(S.db, { artifactId: art.id, actor: OWNER, action: "access-granted", target: botId });
    res.json({ granted: botId });
  }));
  router.delete("/api/artifacts/:id/access/:botId", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const botId = String(req.params.botId);
    const r = await S.db.execute({ sql: "DELETE FROM artifact_bot_access WHERE artifact_id=? AND bot_id=?", args: [art.id, botId] });
    if (Number(r.rowsAffected) !== 1) throw Object.assign(new Error("no such grant"), { code: "not_found" });
    if (botId !== art.created_by_bot) await S.db.execute({ sql: "UPDATE artifact_links SET unlinked_at=datetime('now') WHERE artifact_id=? AND bot_id=? AND unlinked_at IS NULL", args: [art.id, botId] });
    await M.store.audit(S.db, { artifactId: art.id, actor: OWNER, action: "access-revoked", target: botId });
    res.json({ revoked: botId });
  }));

  /** D28 leftover (review L-6): pre-D28 documents get their blocks' rendered
   *  `plain` (and their block threads a span) from a ONE-TIME pass started in
   *  init (comments.backfillPlain). A document view or block comment waits
   *  for it at most 2 s; it never fails a request. */
  const backfillDone = async () => {
    // Bounded (code review I3): a slow store never stalls the viewer; past
    // the cap the request goes on with whatever the map holds.
    let t;
    try { await Promise.race([S.plainBackfill, new Promise((r) => { t = setTimeout(r, 2000); })]); } catch { /* logged where it ran */ } finally { clearTimeout(t); }
  };
  router.get("/api/artifacts/:id", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    if (art.type === "document") await backfillDone();
    const versions = (await S.db.execute({ sql: "SELECT n, state, made_by, made_by_bot, round_id, untrusted_input, trust_cleared_at, change_note, proposed_reason, flagged_reason, created_at, anchor_map_json FROM artifact_versions WHERE artifact_id=? ORDER BY n DESC", args: [art.id] })).rows;
    // Chat-first card (plan PR-1 Task 1.4): the card's state chip reads the
    // active round and the scripted-type flag from THIS row — the client
    // never re-derives policy (one definition, server-side). scriptsOff is
    // the SAME expression the view-mint route uses (D20).
    const activeRound = (await S.db.execute({ sql: "SELECT id, kind, status FROM artifact_rounds WHERE artifact_id=? AND status IN ('queued','pending','delivering','working') ORDER BY id DESC LIMIT 1", args: [art.id] })).rows[0] || null;
    const cur = versions.find((v) => Number(v.n) === Number(art.current_version)) || null;
    const scripted = S.policy.isScriptedType(art.type);
    res.json({ artifact: art, versions: versions.map((v) => ({ ...v, anchor_map: v.anchor_map_json ? JSON.parse(v.anchor_map_json) : null, anchor_map_json: undefined })), threads: await M.comments.listThreads(S.db, art.id),
      activeRound, scripted, scriptsOff: !!(cur && scripted && M.store.isTainted(cur)),
      // The threads a round or ask holds right now: the viewer hides Edit/Delete on them.
      lockedThreads: await M.comments.lockedThreadIds(S.db, art.id) });
  }));

  /**
   * The send sheet (plan PR-3 Task 3.4) and the Library's Linked chats tab:
   * the artifact's ACTIVE links, most recent first, each with its chat's
   * state (the engine's word, or "unknown" when it is not listed) and whether
   * a Send can go there — the SAME verification the Send route runs, so the
   * sheet never offers a chat the server would refuse. Owner-only.
   */
  router.get("/api/artifacts/:id/links", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const rows = (await S.db.execute({ sql: "SELECT id, bot_id, thread_id, linked_at, linked_by FROM artifact_links WHERE artifact_id=? AND unlinked_at IS NULL ORDER BY linked_at DESC, id DESC", args: [art.id] })).rows;
    let sessions = [];
    try { sessions = await (await engineNow()).list(); } catch { sessions = []; }
    const links = [];
    for (const r of rows) {
      const seen = sessions.find((x) => x.threadId === r.thread_id) || null;
      const state = seen ? String(seen.state || "unknown") : "unknown";
      const why = await M.links.verifyTarget(S.db, { artifactId: art.id, botId: r.bot_id, threadId: r.thread_id, botDef: await botDefOf(r.bot_id) });
      links.push({ id: Number(r.id), threadId: r.thread_id, botId: r.bot_id, linkedAt: r.linked_at, linkedBy: r.linked_by, state, label: (seen && seen.label) || null, sendable: !why && state !== "stopped", why: why || null });
    }
    res.setHeader("cache-control", "no-store");
    res.json({ links, bot: art.created_by_bot || null, offerBoard: typeof S.createBoardCard === "function" });
  }));

  /** The Library drawer's Audit tab: the last 50 rows, newest first. */
  router.get("/api/artifacts/:id/audit", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const rows = (await S.db.execute({ sql: "SELECT id, actor_kind, actor_id, action, target, ts FROM artifact_audit WHERE artifact_id=? ORDER BY id DESC LIMIT 50", args: [art.id] })).rows;
    res.json({ rows: rows.map((r) => ({ id: Number(r.id), actor: r.actor_kind + (r.actor_id ? ":" + r.actor_id : ""), action: r.action, target: r.target, ts: r.ts })) });
  }));

  /** The Library drawer's Unlink (spec D25): the chat stops receiving this
   *  artifact's cards and is no longer a Send target. Owner + CSRF, audited. */
  router.post("/api/artifacts/:id/links/:lid/unlink", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const lid = Number(req.params.lid);
    const l = Number.isInteger(lid) ? (await S.db.execute({ sql: "SELECT thread_id FROM artifact_links WHERE id=? AND artifact_id=? AND unlinked_at IS NULL", args: [lid, art.id] })).rows[0] : null;
    if (!l) throw Object.assign(new Error("no such link"), { code: "not_found" });
    const r = await S.db.execute({ sql: "UPDATE artifact_links SET unlinked_at=datetime('now') WHERE id=? AND artifact_id=? AND unlinked_at IS NULL", args: [lid, art.id] });
    if (Number(r.rowsAffected) !== 1) throw Object.assign(new Error("no such link"), { code: "not_found" });
    await M.store.audit(S.db, { artifactId: art.id, actor: OWNER, action: "link-unlinked", target: l.thread_id });
    res.json({ unlinked: true });
  }));

  /**
   * Mint a view token for ONE version and ONE frame load (§5.1). The token's
   * frame-ancestors is the dashboard origin the browser itself declared on
   * this same-origin POST (Origin header), checked against Host — so every
   * instance gets its own frame-ancestors with no configuration (M5).
   *
   * D24: the reply carries the token's `tokenId` (its SHA-256 — not a
   * credential) for the load-evidence route. A retry passes the frame's old
   * tokenId as `replaces`; that token is revoked when it belongs to THIS
   * artifact (another artifact's id is ignored).
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
    // D28/review H2: ONE decision for the sandbox and whether the frame speaks.
    const fg = S.policy.frameGrantFor(art.type, scriptsOff);
    const tokens = S.runtime.viewTokens();
    const replaces = typeof req.body?.replaces === "string" ? req.body.replaces : null;
    if (replaces && tokens.evidence(replaces)?.artifactId === art.id) tokens.revokeToken(replaces);
    const { token, tokenId, nonce } = tokens.mint({ artifactId: art.id, versionN: Number(v.n), type: art.type, dashboardOrigin: o.origin, scriptsOff });
    const fragment = typeof req.body?.fragment === "string" && /^b\d{1,6}$/.test(req.body.fragment) ? req.body.fragment : null;
    res.json({
      url: `${info.baseUrl}/v/${token}/`, tokenId, nonce, type: art.type, fragment,
      sandbox: fg.sandbox, scripted: fg.speaks, scriptsOff,
      isolation: S.runtime.isolationFor(req.headers.host),
    });
  }));

  /**
   * D28 (review low): the viewer refused a grant locally (bad-grant) and hands
   * back the token that mint already made live. Revoked only when it belongs
   * to THIS artifact; any other id is a no-op.
   */
  router.post("/api/artifacts/:id/view-tokens/revoke", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const tokens = S.runtime.viewTokens();
    const id = typeof req.body?.tokenId === "string" ? req.body.tokenId : null;
    const mine = !!id && tokens.evidence(id)?.artifactId === art.id;
    if (mine) tokens.revokeToken(id);
    res.json({ revoked: mine });
  }));

  /**
   * D24: a scripted frame said no hello in time — should the viewer flag it or
   * offer "couldn't load — retry"? Answered from the origin's own per-token
   * record (view-tokens.js loadDecision), which the frame content cannot
   * suppress. Read-only (no flag, no audit — the viewer reports a flag through
   * the tripwire route as before). A tokenId of another artifact or version,
   * an expired/revoked one or a malformed one answers "unknown" → retry.
   */
  router.get("/api/artifacts/:id/versions/:n/load-evidence", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const ev = S.runtime.viewTokens().evidence(String(req.query.tokenId || ""));
    const mine = ev && ev.artifactId === art.id && ev.versionN === Number(req.params.n);
    res.setHeader("cache-control", "no-store");
    res.json(S.runtime.loadDecision(mine ? ev : null));
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

  router.post("/api/artifacts/:id/threads", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const versionN = Number(req.body?.versionN ?? art.current_version);
    let anchor = req.body?.anchor;
    // D28: a block anchor is resolved against THIS version's stored anchor
    // map (block text from the map; the quote must be that block's).
    if (anchor && anchor.kind === "block") {
      await backfillDone();
      const v = await M.store.getVersion(S.db, art.id, versionN);
      let map = null; try { map = v && v.anchor_map_json ? JSON.parse(v.anchor_map_json) : null; } catch { map = null; }
      anchor = M.comments.resolveBlockAnchor(map, anchor);
    }
    res.status(201).json(await M.comments.addThread(S.db, { artifactId: art.id, versionN, anchor, text: req.body?.text, author: { kind: "owner" } }));
  }));
  router.post("/api/artifacts/:id/threads/:tid/comments", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    const t = (await S.db.execute({ sql: "SELECT artifact_id FROM artifact_threads WHERE id=?", args: [Number(req.params.tid)] })).rows[0];
    if (!t || t.artifact_id !== art.id) throw Object.assign(new Error("no such thread"), { code: "not_found" });
    res.status(201).json(await M.comments.addComment(S.db, { threadId: Number(req.params.tid), text: req.body?.text, author: { kind: "owner" } }));
  }));
  router.post("/api/artifacts/:id/threads/:tid/status", wrap(async (req, res) => {
    await M.store.requireAccess(S.db, OWNER, req.params.id);
    await M.comments.setThreadStatus(S.db, { threadId: Number(req.params.tid), status: req.body?.status, artifactId: req.params.id });
    res.json({ ok: true });
  }));
  /** The owner edits one of their own comments (comments.js editComment:
   *  never a contact's or bot's words, never while a round holds the thread). */
  router.patch("/api/artifacts/:id/comments/:cid", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    res.json(await M.comments.editComment(S.db, { commentId: Number(req.params.cid), artifactId: art.id, text: req.body?.text, actor: OWNER }));
  }));
  router.delete("/api/artifacts/:id/comments/:cid", wrap(async (req, res) => {
    await M.store.requireAccess(S.db, OWNER, req.params.id);
    res.json(await M.comments.deleteComment(S.db, { commentId: Number(req.params.cid), actor: OWNER }));
  }));

  router.get("/api/artifacts/:id/round-preview", wrap(async (req, res) => {
    await M.store.requireAccess(S.db, OWNER, req.params.id);
    res.json(await M.rounds.previewRound(S.db, req.params.id));
  }));

  const THREAD_RE = /^[A-Za-z0-9_-]{1,80}$/;
  const CHOICES = ["chat", "new-session", "board-card"];
  const choiceOf = (c) => (CHOICES.includes(c) ? c : "chat");   // legacy "auto" → chat
  const engineNow = async () => S.engine || (await appImport("servers/gateway/perch-interactive.js")).getInteractiveEngine();
  const botDefOf = (botId) => (S.loadBotDef ? S.loadBotDef(botId) : loadBotDef(S.db, botId));
  const named = (code) => Object.assign(new Error(code), { code });

  /**
   * The owner names ONE chat (plan PR-3 Task 3.3, review M4/M5c): verified
   * server-side (active link, the link's bot has access, the chat is that
   * bot's own, the def still has the Artifacts tools) or refused by name.
   * Returns { threadId, botId } or throws.
   */
  async function namedTarget(art, thread) {
    if (typeof thread !== "string" || !THREAD_RE.test(thread)) throw named("bad_request");
    const l = await M.links.activeLink(S.db, art.id, thread);
    if (!l) throw named("target_unlinked");
    const why = await M.links.verifyTarget(S.db, { artifactId: art.id, botId: l.botId, threadId: l.threadId, botDef: await botDefOf(l.botId) });
    if (why) throw named(why);
    return { threadId: l.threadId, botId: l.botId };
  }

  /** Send feedback (owner gesture). body: { include: [threadIds], choice: chat|new-session|board-card, thread?, datasetsApproved }
   *  "chat" (the default) goes ONLY to a verified chat: the viewer's thread=,
   *  else (the Library) the most recent verified active link, persisted on
   *  the round as target_thread. No such chat → the round waits for the
   *  owner's choice (the send sheet). Never "any live chat" (round-2 B7). */
  router.post("/api/artifacts/:id/rounds", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    if (!art.created_by_bot) throw Object.assign(new Error("this artifact has no bot"), { code: "bad_request" });
    const choice = choiceOf(req.body?.choice);
    let target = null;
    if (choice === "chat") {
      target = req.body?.thread != null ? await namedTarget(art, req.body.thread) : await M.links.pickSendTarget(S.db, { artifactId: art.id, loadBotDef: botDefOf });
    }
    const round = await M.rounds.startRound(S.db, { artifactId: art.id, actor: OWNER, include: req.body?.include, kind: req.body?.kind === "ask" ? "ask" : "round", datasetsApproved: !!req.body?.datasetsApproved, botId: target ? target.botId : art.created_by_bot, targetThread: target ? target.threadId : null });
    const out = await M.delivery.deliverRound(S.db, round, { engine: await engineNow(), botDef: await botDefOf(round.bot_id), choice, createBoardCard: S.createBoardCard || null, actor: OWNER });
    res.status(201).json({ round: await M.rounds.getRound(S.db, round.id), delivery: out });
  }));

  /** The send sheet's second step: deliver a round still waiting for the
   *  owner's choice (or queued at capacity). "chat" with a thread= names a
   *  chat, verified like the Send route and persisted before delivery. */
  router.post("/api/artifacts/:id/rounds/:rid/deliver", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
    let round = await M.rounds.getRound(S.db, Number(req.params.rid));
    if (!round || round.artifact_id !== art.id) throw Object.assign(new Error("no such round"), { code: "not_found" });
    if (!["pending", "queued"].includes(round.status) || round.session_id || round.card_id) throw Object.assign(new Error("this round was already delivered"), { code: "bad_request" });
    const choice = choiceOf(req.body?.choice);
    if (choice === "chat" && req.body?.thread != null) {
      const t = await namedTarget(art, req.body.thread);
      await S.db.execute({ sql: "UPDATE artifact_rounds SET target_thread=?, bot_id=?, updated_at=datetime('now') WHERE id=? AND status IN ('pending','queued') AND session_id IS NULL AND card_id IS NULL", args: [t.threadId, t.botId, round.id] });
      round = await M.rounds.getRound(S.db, round.id);
    }
    const out = await M.delivery.deliverRound(S.db, round, { engine: await engineNow(), botDef: await botDefOf(round.bot_id), choice, createBoardCard: S.createBoardCard || null, actor: OWNER });
    res.json({ round: await M.rounds.getRound(S.db, round.id), delivery: out });
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

async function loadBotDef(db, botId) {
  const r = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
  try { return r ? JSON.parse(r.definition || "{}") : null; } catch { return null; }
}
