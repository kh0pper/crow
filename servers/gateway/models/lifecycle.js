// servers/gateway/models/lifecycle.js
/**
 * Lifecycle API state (spec §5.2), pure. The route layer (routes/llm-models.js)
 * owns I/O; this module owns the job state machine and the listing shape.
 */
import { randomUUID } from "node:crypto";
import { doorKindOf } from "./door-resolve.js";
import { isStartAllowed } from "../box-reservation.js";

export const JOB_STATES = ["queued", "evicting", "starting", "resident", "failed", "blocked_by_reservation"];
const FINISHED = new Set(["resident", "failed", "blocked_by_reservation"]);

export function createJobStore({ now = Date.now, maxJobs = 200, idFn = randomUUID } = {}) {
  const jobs = new Map();
  function evict() {
    if (jobs.size <= maxJobs) return;
    for (const [id, j] of jobs) {
      if (jobs.size <= maxJobs) break;
      if (FINISHED.has(j.state)) jobs.delete(id);
    }
  }
  return {
    create(provider) {
      const t = now();
      const job = { id: idFn(), provider, state: "queued", createdAt: t, updatedAt: t, cause: null, reservation: null, error: null };
      jobs.set(job.id, job);
      evict();
      return { ...job };
    },
    update(id, patch = {}) {
      const j = jobs.get(id);
      if (!j) return null;
      if (patch.state !== undefined && !JOB_STATES.includes(patch.state)) throw new Error(`unknown job state "${patch.state}"`);
      Object.assign(j, patch, { updatedAt: now() });
      return { ...j };
    },
    get(id) {
      const j = jobs.get(id);
      return j ? { ...j } : null;
    },
    activeFor(provider) {
      for (const j of jobs.values()) if (j.provider === provider && !FINISHED.has(j.state)) return { ...j };
      return null;
    },
  };
}

function firstModelId(p) {
  const m = Array.isArray(p?.models) ? p.models[0] : null;
  return typeof m === "string" ? m : m?.id ?? null;
}

export function buildModelsListing({ providers = {}, ownInstanceId, snapshotOf, jobs, reservation, externalHealth = {}, siblingsOf }) {
  const out = [];
  for (const [name, p] of Object.entries(providers)) {
    const kind = doorKindOf(p);
    // Native and external-engine rows only (bundle/opt-in/unmanaged rows have no lifecycle here).
    if (kind !== "native-owned" && kind !== "native-foreign" && kind !== "external") continue;
    const gp = p.gpuPolicy || {};
    const base = {
      provider: name, model: firstModelId(p), quant: gp.quant ?? null, mutexGroup: gp.mutexGroup ?? null,
      wouldEvict: [], argv: null, owner: gp.owner ?? null, managed: kind === "external" ? "external" : "native",
    };
    if (kind === "external") {
      out.push({ ...base, status: externalHealth[name]?.ready ? "external_up" : "external_down" });
      continue;
    }
    if (kind === "native-foreign" || (gp.owner && gp.owner !== ownInstanceId)) {
      out.push({ ...base, status: "foreign" });
      continue;
    }
    const snap = snapshotOf(name);
    const isResident = (n) => !!snapshotOf(n)?.live;
    const wouldEvict = (siblingsOf(name) || []).filter(isResident);
    let status;
    if (snap?.live) status = "resident";
    else if (jobs.activeFor(name)) status = "loading";
    else if (reservation && !isStartAllowed(reservation, name)) status = "blocked_by_reservation";
    else status = "stopped";
    out.push({ ...base, status, wouldEvict, argv: snap?.argv ?? null });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}
