// servers/gateway/models/lifecycle-core.js
/**
 * One lifecycle core, two doors (models plan 3a, Task 2). The bearer door
 * (routes/llm-models.js, /llm/models) and the dashboard-session door
 * (routes/models.js, /api/models/providers/*) both delegate here, and both
 * default to the same job store (lifecycle.js `sharedJobStore()`), so a start
 * made through one door shows as `loading` through the other and a second
 * start of the same provider joins the first job instead of spawning a
 * second llama-server.
 *
 * Transport-neutral: every method answers `{ status, body }` where a refusal
 * body is `{ code, message, owner?, door? }`. Each door wraps that in its own
 * error envelope.
 */
import { ReservedError } from "../box-reservation.js";
import { doorKindOf } from "./door-resolve.js";
import { buildModelsListing } from "./lifecycle.js";

/**
 * @param {object} deps
 * @param {() => object} deps.providersFn   provider map (loadProviders().providers)
 * @param {() => string} deps.ownInstanceIdFn
 * @param {() => object|null} deps.readReservationFn
 * @param {(name: string) => object|null} deps.snapshotOfFn
 * @param {(name: string) => string[]} deps.siblingsOfFn
 * @param {() => object} deps.externalHealthFn
 * @param {(name: string, opts: object) => Promise<boolean|null>} deps.acquireFn
 * @param {(name: string, opts: object) => Promise<object>} deps.stopFn
 * @param {object} deps.jobs                job store (createJobStore shape)
 */
export function createLifecycleCore(deps) {
  const { jobs } = deps;
  const providersNow = () => deps.providersFn() || {};

  /** Refusal for anything this instance must not start or stop, else null. */
  function refusal(name, p = providersNow()[name]) {
    if (!p) return { status: 404, body: { code: "UNKNOWN_PROVIDER", message: `no enabled provider "${name}"` } };
    const kind = doorKindOf(p);
    if (kind === "external") return { status: 409, body: { code: "EXTERNAL_ENGINE", message: `"${name}" is an external engine; Crow never starts or stops it` } };
    if (kind === "native-foreign" || (p.gpuPolicy?.owner && p.gpuPolicy.owner !== deps.ownInstanceIdFn())) {
      return { status: 409, body: { code: "NOT_OWNER", message: `"${name}" is owned by another instance`, owner: p.gpuPolicy?.owner ?? null, door: p.doorUrl || p.baseUrl } };
    }
    if (kind !== "native-owned") return { status: 409, body: { code: "NOT_NATIVE", message: `"${name}" is not a native model` } };
    return null;
  }

  function listing() {
    return buildModelsListing({
      providers: providersNow(), ownInstanceId: deps.ownInstanceIdFn(), snapshotOf: deps.snapshotOfFn,
      jobs, reservation: deps.readReservationFn(), externalHealth: deps.externalHealthFn() || {}, siblingsOf: deps.siblingsOfFn,
    });
  }

  async function runStart(job, name, requester) {
    try {
      jobs.update(job.id, { state: (deps.siblingsOfFn(name) || []).some((s) => deps.snapshotOfFn(s)?.live) ? "evicting" : "starting" });
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
  }

  /** 202 `{ job_id }` at once; the start runs in the background. A second
   * start while one is active returns the active job. */
  function start(name, requester) {
    const refused = refusal(name);
    if (refused) return refused;
    if (jobs.isRemoving?.(name)) return { status: 409, body: { code: "REMOVING", message: `"${name}" is being unregistered` } };
    const active = jobs.activeFor(name);
    if (active) return { status: 202, body: { job_id: active.id } };
    const job = jobs.create(name);
    runStart(job, name, requester);
    return { status: 202, body: { job_id: job.id } };
  }

  async function stop(name, requester) {
    const refused = refusal(name);
    if (refused) return refused;
    try {
      return { status: 200, body: await deps.stopFn(name, { requester }) };
    } catch (err) {
      return { status: 500, body: { code: err.code || "STOP_FAILED", message: err.message } };
    }
  }

  function job(id) {
    const j = jobs.get(id);
    return j ? { status: 200, body: j } : { status: 404, body: { code: "UNKNOWN_JOB", message: "no such job" } };
  }

  return { refusal, listing, start, stop, job, jobs, providers: providersNow };
}
