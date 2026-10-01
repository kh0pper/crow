import { Router, json } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { timingSafeEqual, createHash } from "node:crypto";

const CROW_HOME = () => process.env.CROW_HOME || join(homedir(), ".crow");
function serverDir() {
  const installed = join(CROW_HOME(), "bundles", "phone", "server");
  if (existsSync(join(installed, "store.js"))) return installed;
  return join(process.env.CROW_APP_ROOT || join(homedir(), "crow"), "bundles", "phone", "server");
}
const bundleImport = (f) => import(pathToFileURL(join(serverDir(), f)).href);
const appImport = (rel) => import(pathToFileURL(join(process.env.CROW_APP_ROOT || join(homedir(), "crow"), rel)).href);
const eqSecret = (a, b) => { const x = createHash("sha256").update(String(a)).digest(), y = createHash("sha256").update(String(b)).digest(); return timingSafeEqual(x, y); };

async function readSettings(db) {
  const rows = (await db.execute({ sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'phone_%'", args: [] })).rows;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    ownerName: m.phone_owner_name || "", ownerNumber: m.phone_owner_number || null,
    dailyCap: Number(m.phone_daily_cap || 10), localModel: m.phone_local_model || "", cloudModel: m.phone_cloud_model || "",
    tcpaAck: m.phone_tcpa_ack === "true",
  };
}

async function resolveModel(db, spec) {
  if (!spec || !spec.includes("/")) return null;
  const [providerId, ...rest] = spec.split("/");
  const row = (await db.execute({ sql: "SELECT base_url, api_key FROM providers WHERE id = ? AND COALESCE(disabled,0)=0", args: [providerId] })).rows[0];
  return row ? { base_url: row.base_url, api_key: row.api_key || "none", model: rest.join("/"), label: spec } : null;
}

export default function phoneRouter(authMiddleware, seams = {}) {
  const router = Router();
  let mods = null, db = seams.db || null, runner = seams.runner || null, authority = seams.authority || null, csrf = seams.csrf || null, notifyCard = seams.notifyCard || null;

  let ready = null;

  // Perch session -> its bot (store.perchSessionBot: a direct read, never adopts or
  // wakes a session, spec 2026-10-01 §4.1). A transient DB error throws → 500 via wrap.
  const perchSessionBot = seams.perchSessionBot || ((sid) => mods.store.perchSessionBot(db, sid));
  function ensure() { return ready ??= init().catch((e) => { ready = null; throw e; }); }

  async function init() {
    seams.onInit?.();
    const [store, plan, auth, secrets, deliver, rc, disp, card] = await Promise.all(
      ["store.js", "plan.js", "authority.js", "secrets.js", "deliver.js", "runner-client.js", "dispatcher.js", "card.js"].map(bundleImport));
    if (!db) { const { createDbClient } = await appImport("servers/db.js"); db = createDbClient(); }
    const { initPhoneTables } = await bundleImport("init-tables.js"); await initPhoneTables(db);
    const secret = secrets.readRunnerSecret();
    if (!secret) console.warn("[phone] PHONE_RUNNER_SECRET not configured: calls cannot start until it is set (reinstall or set it in Extensions)");
    if (!runner) runner = rc.createRunnerClient({ baseUrl: process.env.PHONE_RUNNER_URL || "http://127.0.0.1:3065", secret });
    if (!authority) authority = auth;
    const m = { store, plan, secrets, deliver, disp, card };
    // Spec 2026-10-01 §4.2: card frames into the requesting Perch chat (the engine
    // checks I3). Resolved per push through the process singleton; never created here.
    if (!notifyCard) {
      let warnedNoEngine = false;
      notifyCard = async (sid, frame, opts) => {
        const { notifyCardToResident } = await appImport("servers/gateway/perch-interactive.js");
        const r = await notifyCardToResident(sid, frame, opts);
        if (r && r.reason === "no_engine") { if (!warnedNoEngine) { warnedNoEngine = true; console.warn("[phone] no Perch engine in this process yet: call cards appear when the chat is opened"); } }
        return r;
      };
    }
    if (seams.startDispatcher !== false) {
      const { createNotification } = await appImport("servers/shared/notifications.js");
      let perchMessage = null;
      try {
        const { getInteractiveEngine } = await appImport("servers/gateway/perch-interactive.js");
        perchMessage = deliver.enginePerchMessage(getInteractiveEngine); // no engine yet = transient (no_engine)
      } catch { /* perch unavailable → notify only */ }
      let cached = null;
      const refresh = async () => { cached = await readSettings(db); cached.local = await resolveModel(db, cached.localModel); cached.cloud = await resolveModel(db, cached.cloudModel); };
      await refresh(); setInterval(() => refresh().catch((e) => console.warn("[phone] settings refresh:", e.message)), 30000).unref();
      const d = disp.createDispatcher({ db, runner,
        deps: { notify: createNotification, deliver: deliver.deliverPhoneResult, perchMessage, notifyCard },
        settings: () => ({ ownerName: cached.ownerName, ownerNumber: cached.ownerNumber, dailyCap: cached.dailyCap, line: "interactive",
          model: (call) => (call.allow_cloud && cached.cloud) ? { ...cached.cloud, label: "cloud:" + cached.cloudModel } : (cached.local || null) }) });
      setInterval(() => d.tick().catch((e) => console.warn("[phone] dispatcher:", e.message)), 2000).unref();
    }
    mods = m;
    return mods;
  }

  const wrap = (fn) => async (req, res) => {
    try { await ensure(); await fn(req, res); }
    catch (e) { const st = { not_found: 404, not_pending: 409, not_editable: 409, invalid_plan: 400, rate_limited: 429, plan_changed: 409, plan_hash_required: 400 }[e.code] || 500; res.status(st).json({ error: e.code || "error", message: e.message }); }
  };
  const pushCard = async (id) => {
    try { await mods.card.pushCallCard(db, await mods.store.getCall(db, id), notifyCard); }
    catch (e) { console.warn(`[phone] card push failed for ${id}: ${e.message}`); }
  };
  const csrfMw = async (req, res, next) => {
    if (!csrf) { const m = await appImport("servers/gateway/dashboard/shared/csrf.js"); csrf = m.csrfMiddleware; }
    return csrf(req, res, next);
  };

  router.use("/api/phone", json({ limit: "64kb" }));

  // Runner → gateway: redeem the single-use start token (runner secret, NOT a dashboard session).
  router.post("/api/phone/verify", wrap(async (req, res) => {
    const h = req.headers.authorization || "";
    const b = req.body || {};
    const secret = mods.secrets.readRunnerSecret();
    if (!secret || !h.startsWith("Bearer ") || !eqSecret(h.slice(7), secret)) return res.status(401).json({ ok: false });
    res.json({ ok: await mods.store.consumeToken(db, String(b.call_id || ""), String(b.token || "")) });
  }));

  router.use("/api/phone", authMiddleware, csrfMw);

  const localOnly = async (req, res) => {
    if (await authority.isLocalDashboardSession(db, req.dashboardSession)) return true;
    res.status(403).json({ error: "local_login_required", message: "Sign in on this Crow with your password to use Phone (peer sign-in is not enough)." });
    return false;
  };

  // I7: any dashboard session may ask; only a local password session learns
  // the 2FA requirement and the cloud model label.
  router.get("/api/phone/whoami", wrap(async (req, res) => {
    const local = await authority.isLocalDashboardSession(db, req.dashboardSession);
    if (!local) return res.json({ local: false, totp_required: false, cloud_model: null });
    const st = await readSettings(db);
    res.json({ local: true, totp_required: !!(await authority.totpRequired()), cloud_model: st.cloudModel || null });
  }));
  // I5: one Perch chat's calls — that session's bot only, newest 20, local only.
  router.get("/api/phone/perch/:sid/calls", wrap(async (req, res) => {
    if (!(await localOnly(req, res))) return;
    const sid = String(req.params.sid || "");
    const botId = await perchSessionBot(sid);
    if (!botId) return res.json({ calls: [] });
    const calls = await mods.store.listPerchCalls(db, sid, botId, 20);
    res.json({ calls: calls.map(({ token_hash, approved_by_session, ...c }) => c) });
  }));
  router.get("/api/phone/calls", wrap(async (req, res) => {
    if (!(await localOnly(req, res))) return;
    const calls = await mods.store.listCalls(db, { status: req.query.status || undefined, limit: 100 });
    res.json({ calls: calls.map(({ token_hash, approved_by_session, ...c }) => c) });
  }));
  router.get("/api/phone/calls/:id", wrap(async (req, res) => {
    if (!(await localOnly(req, res))) return;
    const c = await mods.store.getCall(db, req.params.id);
    if (!c) return res.status(404).json({ error: "not_found" });
    const { token_hash, approved_by_session, ...safe } = c; res.json({ call: safe });
  }));

  router.post("/api/phone/calls/:id/approve", wrap(async (req, res) => {
    const b = req.body || {};
    if (!(await authority.isLocalDashboardSession(db, req.dashboardSession))) return res.status(403).json({ error: "local_login_required", message: "Sign in on this Crow with your password to approve calls (peer sign-in is not enough)." });
    if (!(await authority.stepUpOk(b.totp))) return res.status(403).json({ error: "totp_required", message: "Enter your current 2FA code." });
    if (b.business_confirmed !== true) return res.status(400).json({ error: "business_confirmation_required" });
    const st = await readSettings(db);
    if (!st.tcpaAck) return res.status(409).json({ error: "notice_not_acknowledged", message: "Acknowledge the AI-call notice in Phone settings first." });
    if (!String(st.ownerName || "").trim()) return res.status(409).json({ error: "owner_name_required", message: "Set your first name in Phone settings first (the assistant says who it is calling for)." });
    // "Approve now" sends run_after:null and clears any proposed time; a string
    // schedules it; an absent field keeps what is stored.
    let runAfter;
    if (b.run_after === null) runAfter = null;
    else if (typeof b.run_after === "string" && b.run_after) {
      const t = Date.parse(b.run_after);
      if (!Number.isFinite(t)) return res.status(400).json({ error: "invalid_run_after", message: "run_after must be a date and time." });
      runAfter = new Date(t).toISOString();
    }
    // I4: the hash check runs last, after every other gate, so a refused session
    // or a missing 2FA code never learns whether the plan changed.
    await mods.store.approveCall(db, req.params.id, { session: req.dashboardSession, allowCloud: !!b.allow_cloud, edits: b.edits || undefined, runAfter,
      expectedHash: typeof b.plan_hash === "string" ? b.plan_hash : undefined });
    await pushCard(req.params.id);
    res.json({ ok: true });
  }));
  router.post("/api/phone/calls/:id/reject", wrap(async (req, res) => {
    if (!(await localOnly(req, res))) return;
    await mods.store.rejectCall(db, req.params.id); await pushCard(req.params.id); res.json({ ok: true });
  }));
  router.post("/api/phone/calls/:id/edit", wrap(async (req, res) => {
    if (!(await localOnly(req, res))) return;
    await mods.store.editCall(db, req.params.id, (req.body || {}).edits || {}); await pushCard(req.params.id); res.json({ ok: true });
  }));
  // Stop is gated only by a dashboard session (any, incl. peer SSO): stopping a call is always safe.
  // Stop always ends the call: ask the runner to stop; if the runner says it is
  // not running this call (orphaned by a runner restart), finalize it here.
  router.post("/api/phone/calls/:id/stop", wrap(async (req, res) => {
    const id = req.params.id;
    await Promise.resolve().then(() => runner.stop(id)).catch(() => {});
    const c = await mods.store.getCall(db, id);
    if (c && (c.status === "live" || c.status === "starting")) {
      let r = null;
      try { r = await runner.events(id, c.event_seq); } catch { /* unreachable: the dispatcher times it out */ }
      if (r && r.active === false && !r.done) {
        if (await mods.store.finalizeCall(db, id, { outcome: "failed", booking: null, summary: null, error: "stopped by owner" })) await pushCard(id);
      }
    }
    res.json({ ok: true });
  }));
  router.post("/api/phone/calls/:id/farend", wrap(async (req, res) => {
    if (!(await localOnly(req, res))) return;
    const c = await mods.store.getCall(db, req.params.id);
    if (!c || c.status !== "live") return res.status(409).json({ error: "not_live" });
    const b = req.body || {};
    const text = String(b.text || "").slice(0, 1000).trim();
    if (!text) return res.status(400).json({ error: "empty" });
    await runner.farend(req.params.id, text); res.json({ ok: true });
  }));

  router.get("/api/phone/settings", wrap(async (req, res) => {
    if (!(await localOnly(req, res))) return;
    res.json(await readSettings(db));
  }));
  router.post("/api/phone/settings", wrap(async (req, res) => {
    const b = req.body || {};
    if (!(await authority.isLocalDashboardSession(db, req.dashboardSession))) return res.status(403).json({ error: "local_login_required", message: "Sign in on this Crow with your password to change Phone settings." });
    if (!(await authority.stepUpOk(b.totp))) return res.status(403).json({ error: "totp_required", message: "Enter your current 2FA code." });
    const checkModel = async (spec, { local }) => {
      if (spec === "") return true;
      const [pid, ...rest] = String(spec).split("/");
      const row = pid && rest.join("/") ? (await db.execute({ sql: "SELECT host FROM providers WHERE id = ? AND COALESCE(disabled,0)=0", args: [pid] })).rows[0] : null;
      if (!row) { res.status(400).json({ error: "invalid_model", message: `Model must be "<provider_id>/<model>" with an existing, enabled provider.` }); return false; }
      if (local && row.host === "cloud") { res.status(400).json({ error: "invalid_model", message: "The local model cannot use a cloud provider." }); return false; }
      return true;
    };
    if (b.localModel != null && !(await checkModel(String(b.localModel), { local: true }))) return;
    if (b.cloudModel != null && !(await checkModel(String(b.cloudModel), { local: false }))) return;
    const put = (k, v) => db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", args: [k, String(v)] });
    if (b.ownerName != null) await put("phone_owner_name", String(b.ownerName).slice(0, 80));
    if (b.ownerNumber) await put("phone_owner_number", mods.plan.normalizeNumber(b.ownerNumber));
    if (b.dailyCap != null) await put("phone_daily_cap", Math.max(1, Math.min(50, Math.floor(Number(b.dailyCap)) || 10)));
    if (b.localModel != null) await put("phone_local_model", String(b.localModel));
    if (b.cloudModel != null) await put("phone_cloud_model", String(b.cloudModel));
    if (b.tcpaAck === true) await put("phone_tcpa_ack", "true");
    res.json({ ok: true });
  }));

  if (seams.startDispatcher !== false) ensure().catch((e) => console.warn("[phone] init failed:", e.message));

  return router;
}
