// servers/gateway/routes/llm-models.js
/**
 * Lifecycle API for programs (spec §5.2): pi-lab and the board start, stop
 * and inspect local models through the owning gateway. Bearer auth: the full
 * local MCP token OR the path-scoped models token (<CROW_HOME>/models-token).
 * Mounted beside /llm/v1 with no dashboard auth; Funnel-rejected globally.
 */
import express from "express";
import { createDbClient } from "../../db.js";
import { validateLocalToken, validateModelsToken } from "../local-token.js";
import { loadProviders } from "../../shared/providers.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { readReservation, ReservedError } from "../box-reservation.js";
import { getProviderHealth } from "../provider-health.js";
import { acquireProvider, stopNativeProvider, nativeSnapshot, mutexSiblingsOf } from "../gpu-orchestrator.js";
import { createJobStore, buildModelsListing } from "../models/lifecycle.js";
import { doorKindOf } from "../models/door-resolve.js";
import { requesterTag } from "../requester-tag.js";

export default function llmModelsRouter(opts = {}) {
  let _db = null;
  const db = () => (_db ||= createDbClient());
  const deps = {
    authFn: async (token) => (await validateLocalToken(db(), token)) || (await validateModelsToken(db(), token)),
    loadProvidersFn: loadProviders,
    ownInstanceIdFn: getOrCreateLocalInstanceId,
    readReservationFn: readReservation,
    snapshotOfFn: nativeSnapshot,
    siblingsOfFn: mutexSiblingsOf,
    externalHealthFn: () => getProviderHealth().external,
    acquireFn: acquireProvider,
    stopFn: stopNativeProvider,
    jobs: createJobStore(),
    ...opts,
  };
  const jobs = deps.jobs;
  const router = express.Router();
  router.use("/llm/models", (req, res, next) => {
    if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: { code: "FUNNEL_REFUSED", message: "/llm is never reachable through Funnel" } });
    next();
  });
  router.use("/llm/models", express.json({ limit: "1mb" }));

  router.use("/llm/models", async (req, res, next) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    try {
      if (token && (await deps.authFn(token))) return next();
    } catch (err) {
      console.warn(`[llm-models] auth check failed: ${err.message}`);
    }
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "bearer token required (local MCP token or CROW_HOME/models-token)" } });
  });

  const providersNow = () => (deps.loadProvidersFn() || {}).providers || {};

  function refuseIfNotStartable(res, name, p) {
    if (!p) { res.status(404).json({ error: { code: "UNKNOWN_PROVIDER", message: `no enabled provider "${name}"` } }); return true; }
    const kind = doorKindOf(p);
    if (kind === "external") { res.status(409).json({ error: { code: "EXTERNAL_ENGINE", message: `"${name}" is an external engine; Crow never starts or stops it` } }); return true; }
    if (kind === "native-foreign" || (p.gpuPolicy?.owner && p.gpuPolicy.owner !== deps.ownInstanceIdFn())) {
      res.status(409).json({ error: { code: "NOT_OWNER", message: `"${name}" is owned by another instance`, owner: p.gpuPolicy?.owner ?? null, door: p.doorUrl || p.baseUrl } });
      return true;
    }
    if (kind !== "native-owned") { res.status(409).json({ error: { code: "NOT_NATIVE", message: `"${name}" is not a native model` } }); return true; }
    return false;
  }

  router.get("/llm/models", (req, res) => {
    const models = buildModelsListing({
      providers: providersNow(), ownInstanceId: deps.ownInstanceIdFn(), snapshotOf: deps.snapshotOfFn,
      jobs, reservation: deps.readReservationFn(), externalHealth: deps.externalHealthFn() || {}, siblingsOf: deps.siblingsOfFn,
    });
    res.json({ models });
  });

  router.post("/llm/models/:provider/start", (req, res) => {
    const name = req.params.provider;
    const p = providersNow()[name];
    if (refuseIfNotStartable(res, name, p)) return;
    const active = jobs.activeFor(name);
    if (active) return res.status(202).json({ job_id: active.id });
    const job = jobs.create(name);
    res.status(202).json({ job_id: job.id });
    const requester = requesterTag(req);
    (async () => {
      jobs.update(job.id, { state: (deps.siblingsOfFn(name) || []).some((s) => deps.snapshotOfFn(s)?.live) ? "evicting" : "starting" });
      try {
        const result = await deps.acquireFn(name, { requester });
        // acquireProvider returns null when the row is not orchestratable here
        // and false on a readiness timeout: only `true` means resident (review C6).
        if (result === true) jobs.update(job.id, { state: "resident" });
        else jobs.update(job.id, { state: "failed", error: `${name} was not started (acquire returned ${JSON.stringify(result)})`, cause: [] });
      } catch (err) {
        if (err instanceof ReservedError) {
          jobs.update(job.id, { state: "blocked_by_reservation", reservation: { owner: err.owner, expires_at: err.expires_at }, error: err.message });
        } else {
          // The orchestrator removes the handle on a failed start, so the tail
          // rides on the error (startNativeAndAwaitReady attaches it).
          jobs.update(job.id, { state: "failed", error: err?.message || String(err), cause: Array.isArray(err?.stderrTail) ? err.stderrTail : [] });
        }
      }
    })();
  });

  router.get("/llm/models/jobs/:id", (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: { code: "UNKNOWN_JOB", message: "no such job" } });
    res.json(j);
  });

  router.post("/llm/models/:provider/stop", async (req, res) => {
    const name = req.params.provider;
    const p = providersNow()[name];
    if (refuseIfNotStartable(res, name, p)) return;
    try {
      res.json(await deps.stopFn(name, { requester: requesterTag(req) }));
    } catch (err) {
      res.status(500).json({ error: { code: err.code || "STOP_FAILED", message: err.message } });
    }
  });

  return router;
}
