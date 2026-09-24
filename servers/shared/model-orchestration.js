/**
 * Host-level "no model orchestration" switch
 * (spec docs/superpowers/specs/2026-09-24-raven-instance-no-orchestration-design.md).
 *
 * A host whose models are owned by something else (raven: halogen under
 * systemd and pi-lab's windows) sets CROW_DISABLE_MODEL_ORCHESTRATION=1, and
 * its gateway never starts, stops or evicts a model or a model bundle. Read
 * on every call so tests can toggle it. Pure, no I/O.
 */

export const ORCHESTRATION_DISABLED_ENV = "CROW_DISABLE_MODEL_ORCHESTRATION";

export function isModelOrchestrationDisabled(env = process.env) {
  const v = String(env?.[ORCHESTRATION_DISABLED_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export class OrchestrationDisabledError extends Error {
  constructor(providerName) {
    super(`${providerName || "model"} is not started here — model orchestration is disabled on this host (${ORCHESTRATION_DISABLED_ENV})`);
    this.name = "OrchestrationDisabledError";
    this.code = "model_orchestration_disabled";
    this.http = 409;
    this.provider = providerName || null;
  }
}

/** A bundle whose containers serve a model: declared inference, a GPU
 *  requirement or GPU-arch list, provider rows it registers, or a speech
 *  (STT/TTS) profile seed. */
export function isModelBundleManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest.inference === true) return true;
  const req = manifest.requires || {};
  if (req.gpu) return true;
  if (Array.isArray(req.gpu_arch) && req.gpu_arch.length > 0) return true;
  if (Array.isArray(manifest.providers) && manifest.providers.length > 0) return true;
  return Boolean(manifest.sttProfileSeed || manifest.ttsProfileSeed);
}
