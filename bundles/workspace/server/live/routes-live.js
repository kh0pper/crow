/**
 * K5 live endpoints (spec §5.7, §7.4) for the Crow ONLYOFFICE plugin, mounted at /api/workspace/live/v1 by
 * panel/routes.js. Express's Router/json are INJECTED (F2: no bare `express` import under server/).
 *
 * Auth — every request (no dashboard session, no cookies, so CSRF does not apply):
 *  1. Bearer = the docservice SESSION token (HS256, shared secret; S9: 30-day lifetime) — signature and exp checked;
 *  2. its document.key must be the CURRENT session key of a file with queued work, and its user must be in that
 *     session's live ONLYOFFICE info.users (command service). Checked per request (cached 30 s for polls, fresh for
 *     claim and ack), so old tokens, ended sessions, revoked sharees and tokens crow-bot could mint are refused;
 *  3. never over Funnel; 60 requests/min per document; the plugin version (pv) is required on poll and claim.
 * A claim returns a per-change apply token (per-boot secret) that the ack must present. An ack is never proof of
 * application (R-LIVE): applied_live rows stay unverified until the close-time worker checks the saved file.
 */
import { z } from "zod";
import { verifyEditorJwt, mintApplyToken, checkApplyToken } from "./jwt.js";
import { get, cas, nextApplicable, argsOf, preOf, resultOf } from "../queue/store.js";
import { liveEligible, pinInverse } from "../queue/conditions.js";
import { docSession } from "../nc/onlyoffice.js";
import { notifyChange } from "../queue/notify.js";
import { ALL_DEFS } from "../tools/all.js";

export const MIN_PLUGIN_VERSION = "0.2.0";
export const LEASE_MS = 60000;
const RATE_PER_MIN = 60;
const SESSION_TTL_MS = 30000;
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

/** A reported inverse: pinned to the allowed tool and THIS file (K5-I7), then re-validated by that tool's own zod schema. */
export function validInverse(row, inverse) {
  const pinned = pinInverse(row, inverse);
  if (!pinned) return null;
  for (const x of pinned) {
    const def = ALL_DEFS.get(x.tool);
    if (!def) return null;
    const schema = def.internal ? z.object(def.schema).strict() : z.object(def.schema);
    if (!schema.safeParse(x.args).success) return null;
  }
  return pinned;
}

export function liveRouter({ Router, json, db, getConfig, clock }) {
  if (typeof Router !== "function" || typeof json !== "function") throw new Error("liveRouter needs express's Router and json (panel/routes.js injects them)");
  const router = Router();
  const hits = new Map(); // key → request times in the last minute
  const files = new Map(); // fileId → {at, s} ONLYOFFICE session (docSession: config key + info users), cached 30 s
  const fresh = (c) => c && c.at > clock.now() - SESSION_TTL_MS;

  async function sessionOf(fileId, force) {
    const c = files.get(fileId);
    if (!force && fresh(c)) return c.s;
    const s = await docSession(getConfig(), fileId).catch(() => null);
    if (files.size > 1000) files.clear();
    files.set(fileId, { at: clock.now(), s });
    return s;
  }
  /**
   * The file whose CURRENT live session has this key → {fileId, users} | null. Candidates: files with queued work or
   * a live change not yet verified (bounded; the key the change was queued under is tried first).
   */
  async function liveSession(key, force) {
    const rows = (await db.execute({ sql: `SELECT file_id, MAX(CASE WHEN doc_key=? THEN 1 ELSE 0 END) AS hinted FROM workspace_pending_changes
      WHERE state IN ('pending','claimed_live','unknown_after_claim') OR (state='applied_live' AND verified=0) GROUP BY file_id ORDER BY hinted DESC, file_id`, args: [key] })).rows;
    for (const r of rows) {
      const s = await sessionOf(Number(r.file_id), force);
      if (s?.live && String(s.key) === key) return { fileId: Number(r.file_id), users: s.users.map(String) };
    }
    return null;
  }

  const auth = async (req, res, next) => {
    if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: "not available over Funnel" });
    let cfg;
    try { cfg = getConfig(); } catch { return res.status(503).json({ error: "Workspace is not set up" }); }
    let t;
    try { t = verifyEditorJwt(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), cfg.jwtSecret, clock.now()); }
    catch { return res.status(401).json({ error: "unauthorized" }); }
    if (req.query.key !== undefined && String(req.query.key) !== t.key) return res.status(401).json({ error: "token is for another document" });
    let live;
    try { live = await liveSession(t.key, req.method !== "GET"); } catch { return res.status(503).json({ error: "editor unavailable" }); }
    if (!live || !t.userId || !live.users.includes(t.userId)) return res.status(401).json({ error: "not a live editor session" });
    if (hits.size > 1000) hits.clear();
    const h = (hits.get(t.key) || []).filter((x) => x > clock.now() - 60000); h.push(clock.now()); hits.set(t.key, h);
    if (h.length > RATE_PER_MIN) return res.status(429).json({ error: "too many requests" });
    if (req.path !== "/ack" && !versionAtLeast(req.query.pv ?? req.body?.pv)) return res.status(426).json({ error: "the Crow plugin in this editor is outdated; reload the document" });
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
    if (!editor.canEdit) return res.status(403).json({ error: "view-only session" });
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
      const inverse = validInverse(r, b.inverse);
      if (!(await cas(db, r.id, "claimed_live", "applied_live", { inverse_json: inverse ? JSON.stringify(inverse) : null, result_json: JSON.stringify({ ...resultOf(r), live_by: editor.userName }) }))) return res.status(409).json({ error: "not claimed" });
      await notifyChange(db, await get(db, r.id), "applied_live");
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
