/**
 * Satellite owner routes (SAT-1, SAT-5, spec §4.2, §8): pair, list (with the Servers card data),
 * unpair, install command, tailnet peers, and remote management of a paired satellite
 * (satellites/manage.js: bundles, consent relay, jobs, env, logs, backups, tools + pin approval,
 * update, refresh, cert renewal and key rotation, rename).
 *
 * Owner only, on EVERY route: the JSON dashboard session gate, then a local password session
 * (`isLocalPasswordSession`: never a peer-SSO session), and never a signed peer request
 * (`req.crossHostAuth`) or an instance-authenticated one (`req.instanceAuth`). This is the
 * OWNER_ONLY line of routes/bundles.js, drawn for the whole prefix: no peer can drive a
 * satellite. CSRF (double-submit) on every POST. NEVER add `/api/satellites` to
 * PUBLIC_FUNNEL_PREFIXES (CLAUDE.md "Network exposure invariant").
 *
 * The tables may not be migrated yet: readers answer empty, writers 503 {error:"not_migrated"}.
 */
import { Router } from "express";
import { createDbClient } from "../../db.js";
import { csrfMiddleware } from "../dashboard/shared/csrf.js";
import { isLocalPasswordSession } from "../dashboard/local-session.js";
import { requireDashboardSessionJson } from "./models.js";
import { AGENT_PROTOCOL, formatFingerprint, isSatelliteId } from "../../shared/satellite-protocol.js";
import { listSatellites, getSatellite } from "../satellites/store.js";
import { createPairingService, PairingError } from "../satellites/pairing.js";
import { buildInstallCommand } from "../satellites/install-command.js";
import { ManageError } from "../satellites/manage.js";
import { getSatelliteRuntime } from "../satellites/runtime.js";

const PUBLIC_COLS = ["id", "name", "tailnet_host", "status", "cert_expires_at", "agent_protocol",
  "last_seen_at", "unreachable_since", "created_at", "revoked_at"];

function publicRow(r) {
  const out = {};
  for (const c of PUBLIC_COLS) out[c] = r[c] ?? null;
  out.fingerprint = isSatelliteId(r.id) ? formatFingerprint(r.id) : null;
  return out;
}

export default function satellitesRouter({
  dbFactory = createDbClient,
  sessionGate = requireDashboardSessionJson,
  ownerCheck = isLocalPasswordSession,
  service = createPairingService(),
  installOpts = {},
  manager = null,
} = {}) {
  const router = Router();
  // Lazy: the shared runtime (poller, renewer) is built on first use, never at mount in tests.
  const mgr = () => manager || getSatelliteRuntime().manager;

  const ownerOnly = async (req, res, next) => {
    const refuse = () => res.status(403).json({ error: "owner_only" });
    if (req.crossHostAuth || req.instanceAuth) return refuse();
    try {
      if (!(await ownerCheck(req))) return refuse();
    } catch {
      return refuse();
    }
    next();
  };
  router.use("/api/satellites", sessionGate, ownerOnly);

  const handle = (label, fn) => async (req, res) => {
    let db;
    try {
      db = dbFactory();
      await fn(db, req, res);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof PairingError) {
        const body = { error: err.code };
        if (err.detail !== undefined) body.detail = err.detail;
        return res.status(err.status).json(body);
      }
      if (err instanceof ManageError) return res.status(err.status).json({ error: err.code, ...err.extra });
      if (err?.code === "not_migrated") return res.status(503).json({ error: "not_migrated" });
      console.warn(`[satellites] ${label} failed: ${err?.message}`);
      res.status(500).json({ error: "internal" });
    } finally {
      try { db?.close?.(); } catch { /* best effort */ }
    }
  };

  const send = (res, r) => res.status(r.status).json(r.json);

  router.get("/api/satellites", handle("list", async (db, _req, res) => {
    const m = mgr();
    const out = [];
    for (const r of await listSatellites(db)) {
      const row = publicRow(r);
      if (r.status !== "revoked") {
        try { row.card = await m.card(db, r); } catch (err) { row.card = null; console.warn(`[satellites] card ${r.id}: ${err?.message}`); }
      }
      out.push(row);
    }
    res.json({ satellites: out, crow: { boot_sha: m.bootSha(), protocol: AGENT_PROTOCOL } });
  }));

  router.get("/api/satellites/peers", handle("peers", async (_db, _req, res) => send(res, await mgr().peers())));

  router.get("/api/satellites/eligible", handle("eligible", async (_db, _req, res) => {
    res.json({ bundles: mgr().eligibleBundles() });
  }));

  router.get("/api/satellites/install-command", handle("install-command", async (_db, _req, res) => {
    const { bootShaFn, ...rest } = installOpts;
    const r = await buildInstallCommand({ ...rest, ...(bootShaFn ? { sha: bootShaFn() } : {}) });
    if (!r.ok) return res.status(404).json({ error: "not_available" });
    res.json({ sha: r.sha, sha256: r.sha256, command: r.command });
  }));

  router.post("/api/satellites/pair/start", csrfMiddleware, handle("pair start", async (_db, req, res) => {
    res.json(await service.startPairing({ host: req.body?.host }));
  }));

  router.post("/api/satellites/pair/complete", csrfMiddleware, handle("pair complete", async (db, req, res) => {
    const b = req.body || {};
    res.json(await service.completePairing({
      db, pairing_id: b.pairing_id, code: b.code, name: b.name, confirm_without_whois: b.confirm_without_whois === true,
    }));
  }));

  router.post("/api/satellites/:id/unpair", csrfMiddleware, handle("unpair", async (db, req, res) => {
    const id = req.params.id;
    try {
      res.json(await service.unpairSatellite({ db, id, reason: req.body?.reason }));
    } finally {
      // The satellite's add-on entries, skills and any staged key go whenever the row is revoked
      // (also on a retry of an interrupted unpair, which answers already_revoked).
      if (isSatelliteId(id)) {
        try {
          if ((await getSatellite(db, id))?.status === "revoked") mgr().afterUnpair(id);
        } catch (err) { console.warn(`[satellites] unpair cleanup ${id}: ${err?.message}`); }
      }
    }
  }));

  // ── remote management (owner only, via the gate above; CSRF on every write) ─────────────
  const B = "/api/satellites/:id/bundles/:bundle";
  router.post("/api/satellites/:id/rename", csrfMiddleware, handle("rename", async (db, req, res) => send(res, await mgr().rename(db, req.params.id, req.body))));
  router.post("/api/satellites/:id/update", csrfMiddleware, handle("update", async (db, req, res) => send(res, await mgr().update(db, req.params.id))));
  router.post("/api/satellites/:id/refresh", csrfMiddleware, handle("refresh", async (db, req, res) => send(res, await mgr().refresh(db, req.params.id))));
  router.post("/api/satellites/:id/renew-cert", csrfMiddleware, handle("renew", async (db, req, res) => send(res, await mgr().renewCert(db, req.params.id))));
  router.post("/api/satellites/:id/rotate-key", csrfMiddleware, handle("rotate", async (db, req, res) => send(res, await mgr().rotateKey(db, req.params.id))));
  router.post("/api/satellites/:id/bundles/install", csrfMiddleware, handle("install", async (db, req, res) => send(res, await mgr().install(db, req.params.id, req.body))));
  router.get("/api/satellites/:id/jobs/:job", handle("job", async (db, req, res) => send(res, await mgr().job(db, req.params.id, req.params.job))));
  router.post(`${B}/consent`, csrfMiddleware, handle("consent", async (db, req, res) => send(res, await mgr().consent(db, req.params.id, req.params.bundle, req.body))));
  router.post(`${B}/uninstall`, csrfMiddleware, handle("uninstall", async (db, req, res) => send(res, await mgr().uninstall(db, req.params.id, req.params.bundle))));
  router.post(`${B}/repin`, csrfMiddleware, handle("repin", async (db, req, res) => send(res, await mgr().repin(db, req.params.id, req.params.bundle))));
  for (const action of ["start", "stop", "restart"]) {
    router.post(`${B}/${action}`, csrfMiddleware, handle(action, async (db, req, res) => send(res, await mgr().lifecycle(db, req.params.id, req.params.bundle, action))));
  }
  router.get(`${B}/env`, handle("env", async (db, req, res) => send(res, await mgr().getEnv(db, req.params.id, req.params.bundle))));
  router.put(`${B}/env`, csrfMiddleware, handle("env", async (db, req, res) => send(res, await mgr().putEnv(db, req.params.id, req.params.bundle, req.body))));
  router.get(`${B}/logs`, handle("logs", async (db, req, res) => send(res, await mgr().logs(db, req.params.id, req.params.bundle, req.query))));
  router.get(`${B}/backups`, handle("backups", async (db, req, res) => send(res, await mgr().backups(db, req.params.id, req.params.bundle))));
  router.get(`${B}/tools`, handle("tools", async (db, req, res) => send(res, await mgr().tools(db, req.params.id, req.params.bundle))));
  router.post(`${B}/approve-tools`, csrfMiddleware, handle("approve tools", async (db, req, res) => send(res, await mgr().approveTools(db, req.params.id, req.params.bundle, req.body))));

  return router;
}
