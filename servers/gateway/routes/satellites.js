/**
 * Satellite owner routes (SAT-1, spec §4.2, §8): pair, list, unpair, install command.
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
import { formatFingerprint, isSatelliteId } from "../../shared/satellite-protocol.js";
import { listSatellites } from "../satellites/store.js";
import { createPairingService, PairingError } from "../satellites/pairing.js";
import { buildInstallCommand } from "../satellites/install-command.js";

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
} = {}) {
  const router = Router();

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
      if (err?.code === "not_migrated") return res.status(503).json({ error: "not_migrated" });
      console.warn(`[satellites] ${label} failed: ${err?.message}`);
      res.status(500).json({ error: "internal" });
    } finally {
      try { db?.close?.(); } catch { /* best effort */ }
    }
  };

  router.get("/api/satellites", handle("list", async (db, _req, res) => {
    res.json({ satellites: (await listSatellites(db)).map(publicRow) });
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
    res.json(await service.unpairSatellite({ db, id: req.params.id, reason: req.body?.reason }));
  }));

  return router;
}
