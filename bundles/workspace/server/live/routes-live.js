/**
 * K5 live endpoints (spec §5.7, §7.4) for the Crow ONLYOFFICE plugin, mounted at /api/workspace/live/v1 by
 * panel/routes.js. Express's Router/json are INJECTED (F2: no bare `express` import under server/).
 *
 * Every request (no dashboard session, no cookies, so CSRF does not apply), in this order:
 *  1. never over Funnel (403);
 *  2. PRE-AUTH rate limit, before any token check or Nextcloud/ONLYOFFICE call: per client IP (the first
 *     X-Forwarded-For hop when the peer is the loopback Serve proxy) and a small global cap (429). This router's
 *     prefix is in the gateway's GENERAL_LIMITER_SKIP_PREFIXES because every editor arrives through the same
 *     loopback Serve proxy (one shared IP bucket there); these limits replace it;
 *  3. Bearer = the docservice SESSION token (HS256, shared secret; S9: 30-day lifetime) — signature and exp;
 *  4. its document.key must be the CURRENT live session key of a file with queued (or unverified live) work, and
 *     its user must be in that session's ONLYOFFICE info.users (command service);
 *  5. post-auth limits: 60/min per (document, user) and 180/min per document (bounded LRU key sets);
 *  6. plugin version (pv) required on poll and claim (426);
 *  7. WRITE permission (fix B), checked server-side on /pending, /claim and /ack alike: the user must own the file or
 *     hold a user share with update rights that crow-bot can see (live/permissions.js documents the verified limit;
 *     unverifiable → view-only → 403, and the change applies at close). Token "view" markers are honoured too.
 * Caching: ONLYOFFICE sessions and write decisions are cached 30 s for polls (GET); claims and acks always check
 * fresh. So a document opened (or a share changed) right after a poll can wait up to 30 s (+ the plugin's back-off).
 * A claim returns a per-change apply token (per-boot secret) that the ack must present. An ack is never proof of
 * application (R-LIVE): applied_live rows stay unverified until the close-time worker checks the saved file, and the
 * undo of a live change is derived server-side (live/derive-inverse.js) — the ack carries no inverse (fix A).
 */
import { verifyEditorJwt, mintApplyToken, checkApplyToken } from "./jwt.js";
import { windowLimiter } from "./limits.js";
import { userCanWrite } from "./permissions.js";
import { deriveInverse } from "./derive-inverse.js";
import { get, cas, nextApplicable, argsOf, preOf, resultOf } from "../queue/store.js";
import { liveEligible } from "../queue/conditions.js";
import { docSession } from "../nc/onlyoffice.js";
import { notifyChange } from "../queue/notify.js";

export const MIN_PLUGIN_VERSION = "0.2.0";
export const LEASE_MS = 60000;
export const LIMITS = Object.freeze({ perIp: 300, global: 1200, perUser: 60, perDocument: 180 });
const SESSION_TTL_MS = 30000;
const CACHE_MAX = 2000;
const HIDDEN_ARGS = new Set(["path", "file_id", "if_open", "wait_s"]);
const REASON_RE = /^[a-z_]{1,40}$/;

/** "x.y.z" ≥ min; anything malformed → false (an old or unknown plugin never claims). */
export function versionAtLeast(v, min = MIN_PLUGIN_VERSION) {
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(String(v))) return false;
  const a = String(v).split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** F8: the plugin sees the change's own args only — never the path or file id (args_json keeps them for close-time). */
const offered = (r) => ({ change_id: r.id, tool: r.tool, args: Object.fromEntries(Object.entries(argsOf(r)).filter(([k]) => !HIDDEN_ARGS.has(k))), pre: preOf(r) });

export function liveRouter({ Router, json, db, getConfig, clock, limits = LIMITS }) {
  if (typeof Router !== "function" || typeof json !== "function") throw new Error("liveRouter needs express's Router and json (panel/routes.js injects them)");
  const router = Router();
  const now = () => clock.now();
  const lim = (max, maxKeys = 1000) => windowLimiter({ max, windowMs: 60000, maxKeys, now });
  const perIp = lim(limits.perIp), global = lim(limits.global, 1), perUser = lim(limits.perUser), perDoc = lim(limits.perDocument);
  // bounded 30 s caches (oldest evicted): fileId → ONLYOFFICE session; "fileId\0uid" → write permission
  const cache = () => {
    const m = new Map();
    return {
      get: (k, force) => { const c = m.get(k); return !force && c && c.at > now() - SESSION_TTL_MS ? c : null; },
      set: (k, v) => { m.delete(k); m.set(k, { at: now(), v }); while (m.size > CACHE_MAX) m.delete(m.keys().next().value); return v; },
    };
  };
  const sessions = cache(), writes = cache();
  const sessionOf = async (fileId, force) => sessions.get(fileId, force)?.v ?? sessions.set(fileId, await docSession(getConfig(), fileId).catch(() => null));
  const canWrite = async (fileId, uid, path, force) => {
    const k = `${fileId}\u0000${uid}`; const c = writes.get(k, force);
    return c ? c.v : writes.set(k, await userCanWrite(getConfig(), fileId, uid, path));
  };
  /**
   * The file whose CURRENT live session has this key → {fileId, path, users, uids} | null. Candidates: files with
   * queued work or a live change not yet verified (bounded; the key the change was queued under is tried first).
   */
  async function liveSession(key, force) {
    const rows = (await db.execute({ sql: `SELECT file_id, MIN(path) AS path, MAX(CASE WHEN doc_key=? THEN 1 ELSE 0 END) AS hinted FROM workspace_pending_changes
      WHERE state IN ('pending','claimed_live','unknown_after_claim') OR (state='applied_live' AND verified=0) GROUP BY file_id ORDER BY hinted DESC, file_id`, args: [key] })).rows;
    for (const r of rows) {
      const s = await sessionOf(Number(r.file_id), force);
      if (s?.live && String(s.key) === key) return { fileId: Number(r.file_id), path: r.path, users: s.users.map(String), uids: (s.uids || s.users).map(String) };
    }
    return null;
  }
  const clientIp = (req) => {
    const peer = String(req.socket?.remoteAddress || "");
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return /^(127\.|::1$|::ffff:127\.)/.test(peer) && xff ? xff : peer || "unknown";
  };

  const auth = async (req, res, next) => {
    if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: "not available over Funnel" });
    if (!perIp.hit(clientIp(req)) || !global.hit("*")) return res.status(429).json({ error: "too many requests" });
    let cfg;
    try { cfg = getConfig(); } catch { return res.status(503).json({ error: "Workspace is not set up" }); }
    let t;
    try { t = verifyEditorJwt(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), cfg.jwtSecret, now()); }
    catch { return res.status(401).json({ error: "unauthorized" }); }
    if (req.query.key !== undefined && String(req.query.key) !== t.key) return res.status(401).json({ error: "token is for another document" });
    const force = req.method !== "GET";
    let live;
    try { live = await liveSession(t.key, force); } catch { return res.status(503).json({ error: "editor unavailable" }); }
    const at = live && t.userId ? live.users.indexOf(t.userId) : -1;
    if (at < 0) return res.status(401).json({ error: "not a live editor session" });
    if (!perUser.hit(`${t.key}\u0000${t.userId}`) || !perDoc.hit(t.key)) return res.status(429).json({ error: "too many requests" });
    if (req.path !== "/ack" && !versionAtLeast(req.query.pv ?? req.body?.pv)) return res.status(426).json({ error: "the Crow plugin in this editor is outdated; reload the document" });
    // fix B: edit rights are checked server-side for every endpoint (a viewer sees no change content either)
    if (!t.canEdit || !(await canWrite(live.fileId, live.uids[at], live.path, force))) return res.status(403).json({ error: "view-only session" });
    req.live = { editor: t, fileId: live.fileId };
    next();
  };
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.warn(`[workspace] live: ${e.code || ""} ${String(e.message).slice(0, 200)}`); if (!res.headersSent) res.status(500).json({ error: "internal" }); });

  router.use(json({ limit: "256kb" }), auth);

  router.get("/pending", wrap(async (req, res) => {
    const r = await nextApplicable(db, req.live.fileId, ["pending"]); // spec §5.6 order: only the next change, if it is pending
    res.json(r && Number(r.claim_count) < 1 && liveEligible(r.tool, argsOf(r), preOf(r)) ? [offered(r)] : []);
  }));

  router.post("/claim", wrap(async (req, res) => {
    const { editor, fileId } = req.live;
    const r = await get(db, String(req.body?.change_id || ""));
    const next = await nextApplicable(db, fileId, ["pending"]); // review K5-I6: only the next change in seq order
    if (!r || Number(r.file_id) !== fileId || !next || next.id !== r.id || Number(r.claim_count) >= 1 || !liveEligible(r.tool, argsOf(r), preOf(r))) return res.status(409).json({ error: "not claimable" });
    const lease = clock.now() + LEASE_MS;
    if (!(await cas(db, r.id, "pending", "claimed_live", { lease_until: lease, lease_owner: editor.userId.slice(0, 200), claim_count: Number(r.claim_count) + 1 }))) return res.status(409).json({ error: "not claimable" });
    res.json({ lease_until: lease, apply_token: mintApplyToken(r.id, editor.key, lease) });
  }));

  router.post("/ack", wrap(async (req, res) => {
    const { editor, fileId } = req.live; const b = req.body || {};
    const r = await get(db, String(b.change_id || ""));
    if (!r || Number(r.file_id) !== fileId || !checkApplyToken(b.apply_token, r.id, editor.key, r.lease_until, clock.now())) return res.status(403).json({ error: "bad apply token" });
    if (b.outcome === "applied") {
      // fix A: the undo is derived from Crow's own record (args + pre); b.inverse (an old plugin's field) is ignored
      const inverse = deriveInverse(r);
      if (!(await cas(db, r.id, "claimed_live", "applied_live", { inverse_json: inverse ? JSON.stringify(inverse) : null, result_json: JSON.stringify({ ...resultOf(r), live_by: editor.userName }) }))) return res.status(409).json({ error: "not claimed" });
      await notifyChange(db, await get(db, r.id), "live_ack"); // M1: "applied in the open editor (confirmed when saved)"
    } else if (b.outcome === "failed") {
      // review K5-I4: only an op that provably changed NOTHING may return to pending (claim_count stays 1: never offered
      // live again); anything else is ambiguous → the postcondition decides at close.
      const to = b.applied_nothing === true ? "pending" : "unknown_after_claim";
      const reason = REASON_RE.test(String(b.reason)) ? String(b.reason) : "error";
      if (!(await cas(db, r.id, "claimed_live", to, { lease_until: null, lease_owner: null, result_json: JSON.stringify({ ...resultOf(r), live_failed: reason }) }))) return res.status(409).json({ error: "not claimed" });
    } else return res.status(400).json({ error: "outcome must be applied or failed" });
    res.json({ ok: true });
  }));
  return router;
}
