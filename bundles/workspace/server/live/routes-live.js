/**
 * K5 live endpoints (spec §5.7, §7.4) for the Crow ONLYOFFICE plugin, mounted at /api/workspace/live/v1 by
 * panel/routes.js. Express's Router/json are INJECTED (F2: no bare `express` import under server/).
 *
 * Every request (no dashboard session, no cookies, so CSRF does not apply), in this order:
 *  1. never over Funnel (403);
 *  2. Bearer = the docservice SESSION token (HS256, shared secret; S9: 30-day lifetime) — signature and exp, from the
 *     header alone (cheap, before the body is parsed and before any Nextcloud/ONLYOFFICE call). Only FAILURES are
 *     counted against the pre-auth buckets — per client address and a global cap (fix2 X1): an unauthenticated flood
 *     gets 429 itself but can never make a valid editor wait. The client address is the TCP peer, or — when the peer
 *     is the loopback Serve proxy — the RIGHTMOST X-Forwarded-For entry. Verified read-only on crow 2026-10-04:
 *     through Tailscale Serve (:8444) a request carrying `X-Forwarded-For: 1.2.3.4` still passes the /llm source
 *     gate (which refuses any non-tailnet forwarded address: the same request sent directly to 127.0.0.1:3001 is
 *     403), so Serve REPLACES an inbound XFF with the real tailnet source (W1 smoke: Serve sets `X-Forwarded-For:
 *     <tailnet ip>`). The rightmost entry is used anyway, in case a proxy that appends ever sits in front.
 *     Tailscale-User-Login is NOT used as a key (stripping of inbound copies by Serve not verified here).
 *     This prefix is in the gateway's GENERAL_LIMITER_SKIP_PREFIXES because every editor arrives through the same
 *     loopback proxy (one shared bucket there); these limits replace it;
 *  3. its document.key must be the CURRENT live session key of a file with queued (or unverified live) work, and its
 *     user must be in that session's ONLYOFFICE info.users (command service). A key that matched no file is
 *     remembered for 30 s against the same set of candidate files (fix2 N6), and at most 20 candidate files are asked;
 *  4. 60/min per (document, user) and a raw 720/min per document, for every VALID token, right after the signature
 *     check and before the session lookup or body parse (fix3 R1) — a viewer cannot drive Nextcloud/ONLYOFFICE calls;
 *  5. WRITE permission (fix B), server-side on /pending, /claim and /ack alike: the user owns the file or holds a user
 *     share with update rights that crow-bot can see (live/permissions.js documents the verified limit);
 *  6. 180/min per document, counted only for authorized editors (fix2 N3: viewers cannot starve the editor);
 *  7. plugin version (pv) on poll and claim (426) — after authorization, so it leaks nothing to a viewer.
 * Every authentication/authorization failure gets the SAME answer, 401 {"error":"unauthorized"} (fix2 N5): a viewer
 * cannot tell whether a document has queued work.
 * Caching: for polls (GET), an ONLYOFFICE session that can authorize (live) and write decisions are cached 30 s;
 * a NEGATIVE answer (no live session, an unreadable one, a key that matched no queued file) only NEGATIVE_TTL_MS
 * (5 s), so a document opened — or a change queued for it — right after a poll is seen within ~5 s (+ the plugin's
 * poll interval: 5 s while the editor has focus). Claims and acks always check fresh. Every lookup is still behind
 * the per-(document, user) and per-document limits above.
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
export const LIMITS = Object.freeze({ perIp: 300, global: 1200, perUser: 60, perDocument: 180, perDocumentRaw: 720 });
const SESSION_TTL_MS = 30000;
export const NEGATIVE_TTL_MS = 5000;
const CACHE_MAX = 2000;
const MAX_CANDIDATES = 20;
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
  const rawDoc = lim(limits.perDocumentRaw ?? limits.perDocument * 4); // every valid token on the document, before authorization
  // bounded caches (oldest evicted): fileId → ONLYOFFICE session; "fileId\0uid" → write permission. Each entry keeps
  // its own lifetime: 30 s, or NEGATIVE_TTL_MS for an answer that cannot authorize anyone.
  const cache = () => {
    const m = new Map();
    return {
      get: (k, force, maxAge = Infinity) => { const c = m.get(k); return !force && c && c.at > now() - Math.min(c.ttl, maxAge) ? c : null; },
      set: (k, v, ttl = SESSION_TTL_MS) => { m.delete(k); m.set(k, { at: now(), ttl, v }); while (m.size > CACHE_MAX) m.delete(m.keys().next().value); return v; },
    };
  };
  const sessions = cache(), writes = cache();
  const sessionOf = async (fileId, force) => {
    const c = sessions.get(fileId, force); if (c) return c.v;
    const s = await docSession(getConfig(), fileId).catch(() => null);
    return sessions.set(fileId, s, s && !s.live ? NEGATIVE_TTL_MS : SESSION_TTL_MS); // an unreadable session (null) keeps 30 s
  };
  const canWrite = async (fileId, uid, path, force) => {
    const k = `${fileId}\u0000${uid}`; const c = writes.get(k, force);
    if (c) return c.v;
    const ok = await userCanWrite(getConfig(), fileId, uid, path);
    return writes.set(k, ok, ok ? SESSION_TTL_MS : NEGATIVE_TTL_MS);
  };
  /**
   * The file whose CURRENT live session has this key → {fileId, path, users, uids} | null. Candidates: files with
   * queued work or a live change not yet verified (bounded; the key the change was queued under is tried first).
   */
  const misses = cache(); // key → candidate-set signature it matched none of (N6), for NEGATIVE_TTL_MS
  async function liveSession(key, force, userId) {
    const rows = (await db.execute({ sql: `SELECT file_id, MIN(path) AS path, MAX(CASE WHEN doc_key=? THEN 1 ELSE 0 END) AS hinted FROM workspace_pending_changes
      WHERE state IN ('pending','claimed_live','unknown_after_claim') OR (state='applied_live' AND verified=0) GROUP BY file_id ORDER BY hinted DESC, file_id LIMIT ?`, args: [key, MAX_CANDIDATES] })).rows;
    const sig = rows.map((r) => r.file_id).join(",");
    if (misses.get(key)?.v === sig) return null; // asked these same files < 5 s ago: none had this key
    for (const r of rows) {
      let s = await sessionOf(Number(r.file_id), force);
      // a user who joined after this session was cached: re-ask once the entry is older than the negative window
      if (!force && userId && s?.live && String(s.key) === key && !s.users.map(String).includes(userId) && !sessions.get(Number(r.file_id), false, NEGATIVE_TTL_MS)) s = await sessionOf(Number(r.file_id), true);
      if (s?.live && String(s.key) === key) return { fileId: Number(r.file_id), path: r.path, users: s.users.map(String), uids: (s.uids || s.users).map(String) };
    }
    misses.set(key, sig, NEGATIVE_TTL_MS);
    return null;
  }
  /** Rightmost X-Forwarded-For entry when the peer is the loopback Serve proxy, else the TCP peer (fix2 X1). */
  const clientIp = (req) => {
    const peer = String(req.socket?.remoteAddress || "");
    const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    return /^(127\.|::1$|::ffff:127\.)/.test(peer) && hops.length ? hops.at(-1) : peer || "unknown";
  };
  const deny = (res) => res.status(401).json({ error: "unauthorized" }); // N5: one answer for every auth failure

  /** Funnel + token signature, from the header only; failures feed the pre-auth buckets. */
  const preAuth = (req, res, next) => {
    if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: "not available over Funnel" });
    let cfg;
    try { cfg = getConfig(); } catch { return res.status(503).json({ error: "Workspace is not set up" }); }
    try { req.liveToken = verifyEditorJwt(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), cfg.jwtSecret, now()); }
    catch {
      if (!perIp.hit(clientIp(req)) || !global.hit("*")) return res.status(429).json({ error: "too many requests" });
      return deny(res);
    }
    // fix3 R1: a valid token is limited BEFORE any session lookup (Nextcloud/ONLYOFFICE calls) or body parse — per
    // (document, user) and a raw per-document ceiling — so even a 30-day token holder cannot drive command-service
    // calls at will, and the answer is the same whether or not the document has queued work.
    const t = req.liveToken;
    if (!perUser.hit(`${t.key}\u0000${t.userId}`) || !rawDoc.hit(t.key)) return res.status(429).json({ error: "too many requests" });
    next();
  };
  const auth = async (req, res, next) => {
    const t = req.liveToken;
    if (req.query.key !== undefined && String(req.query.key) !== t.key) return deny(res);
    const force = req.method !== "GET";
    let live;
    try { live = await liveSession(t.key, force, t.userId ? String(t.userId) : ""); } catch { return res.status(503).json({ error: "editor unavailable" }); }
    const at = live && t.userId ? live.users.indexOf(t.userId) : -1;
    if (at < 0) return deny(res);
    // fix B: edit rights are checked server-side for every endpoint (a viewer sees no change content either)
    if (!t.canEdit || !(await canWrite(live.fileId, live.uids[at], live.path, force))) return deny(res);
    if (!perDoc.hit(t.key)) return res.status(429).json({ error: "too many requests" });
    if (req.path !== "/ack" && !versionAtLeast(req.query.pv ?? req.body?.pv)) return res.status(426).json({ error: "the Crow plugin in this editor is outdated; reload the document" });
    req.live = { editor: t, fileId: live.fileId };
    next();
  };
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.warn(`[workspace] live: ${e.code || ""} ${String(e.message).slice(0, 200)}`); if (!res.headersSent) res.status(500).json({ error: "internal" }); });

  // N4: the body is parsed only after the token passed (the gateway's own JSON parser may already have run)
  router.use(preAuth, json({ limit: "256kb" }), auth);

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
