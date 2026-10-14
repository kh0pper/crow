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
    if (!S.renderDeps) { const r = await appImport("servers/blog/renderer.js"); S.renderDeps = { markdownBlocks: r.markdownBlocks }; }
    if (!S.csrf) S.csrf = (await appImport("servers/gateway/dashboard/shared/csrf.js")).csrfMiddleware;
    if (!S.policy) S.policy = await appImport("servers/gateway/artifact-origin/policy.js");
    S.runtime.setContentResolver(store.contentResolver(S.db, S.blobs));
    M = { store, comments, rounds, delivery, links };
  }
  const ensure = () => (ready ??= init().catch((e) => { ready = null; throw e; }));
  const OWNER = { kind: "session", id: null };
  const wrap = (fn) => async (req, res) => {
    try { await ensure(); await fn(req, res); }
    catch (e) {
      const map = { not_found: 404, forbidden: 403, round_running: 409, quota_full: 507, too_large: 413, bad_request: 400, bad_anchor: 400, too_long: 400, rate_limited: 429, too_many_threads: 429, bad_source: 400, flagged: 409, bad_origin: 403, comment_locked: 409,
        target_unlinked: 400, target_other_bot: 400, target_no_access: 400, target_not_bots_chat: 400, bot_lacks_artifacts: 400 };
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
      const { v, thread } = page.viewerParams(req.query);
      res.type("html").send(page.renderViewerPage({ lang: m && m[1] === "es" ? "es" : "en", id: req.params.id, v, thread }));
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

  router.get("/api/artifacts", wrap(async (_req, res) => {
    res.json({ artifacts: await M.store.listArtifacts(S.db, OWNER), origin: S.runtime.artifactOriginInfo() ? { isolation: S.runtime.isolationFor(_req.headers.host) } : { isolation: "unavailable" } });
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

  router.get("/api/artifacts/:id", wrap(async (req, res) => {
    const art = await M.store.requireAccess(S.db, OWNER, req.params.id);
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
    const eff = S.policy.effectiveType(art.type, scriptsOff);
    const tokens = S.runtime.viewTokens();
    const replaces = typeof req.body?.replaces === "string" ? req.body.replaces : null;
    if (replaces && tokens.evidence(replaces)?.artifactId === art.id) tokens.revokeToken(replaces);
    const { token, tokenId, nonce } = tokens.mint({ artifactId: art.id, versionN: Number(v.n), type: art.type, dashboardOrigin: o.origin, scriptsOff });
    const fragment = typeof req.body?.fragment === "string" && /^b\d{1,6}$/.test(req.body.fragment) ? req.body.fragment : null;
    res.json({
      url: `${info.baseUrl}/v/${token}/`, tokenId, nonce, type: art.type, fragment,
      sandbox: S.policy.iframeSandboxFor(eff), scripted: S.policy.isScriptedType(eff), scriptsOff,
      isolation: S.runtime.isolationFor(req.headers.host),
    });
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
    res.status(201).json(await M.comments.addThread(S.db, { artifactId: art.id, versionN: Number(req.body?.versionN ?? art.current_version), anchor: req.body?.anchor, text: req.body?.text, author: { kind: "owner" } }));
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
