/**
 * boot/storage-service-guard.js — refuse to boot when the compose shape still
 * points object storage at a MinIO service that is not running.
 *
 * Garage is the default object storage of the root docker-compose.yml
 * (`--profile storage`); MinIO moved to `--profile minio-legacy`. A `.env`
 * carried over from before still says `MINIO_ENDPOINT=minio`, and inside a
 * compose network that name only resolves while the `minio` service runs — so
 * the gateway would boot and then fail every upload on a DNS error, with
 * nothing in the log saying why. Refuse instead, before listen.
 *
 * Exit 78 (EX_CONFIG), like the instance-path and satellite gates: a unit with
 * `RestartPreventExitStatus=78` stops instead of restart-looping.
 *
 * Fires on the exact legacy shape only: MINIO_ENDPOINT is the compose service
 * name, no S3_ENDPOINT is set, and `minio` genuinely fails to resolve
 * (ENOTFOUND/EAI_AGAIN) twice, 2 s apart. Any other endpoint value, any other
 * lookup error (a resolver timeout, say), and any other host are not this
 * guard's business — a slow or broken resolver must never cost a gateway.
 */
import { lookup as dnsLookup } from "node:dns/promises";

/** What an operator (or a unit's RestartPreventExitStatus) sees. */
export const STORAGE_SERVICE_EXIT_CODE = 78;
/** The compose service name: only this value can trip the guard. */
export const COMPOSE_MINIO_HOST = "minio";
/** Two tries, 2 s apart: one blip must not refuse a boot. */
export const LOOKUP_TRIES = 2;
export const LOOKUP_INTERVAL_MS = 2000;
/** Only "this name does not exist" counts; a timeout could be a busy resolver. */
export const UNRESOLVED_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

export const MISSING_MINIO_MESSAGE =
  "MINIO_ENDPOINT=minio but no MinIO service is running. Object storage now uses Garage: " +
  "run with --profile storage and set S3_* (see .env.example), or keep MinIO with --profile minio-legacy.";

/**
 * Trip the guard when the legacy compose storage shape has no service behind it.
 * Every dependency is injected so this is testable without DNS or a real boot.
 *
 * @param {object} [o]
 * @param {object} [o.env]        environment to read (defaults to process.env)
 * @param {(host: string) => Promise<unknown>} [o.resolve] DNS lookup
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {{error: Function, warn: Function}} [o.log]
 * @param {(code: number) => void} [o.exit]
 * @returns {Promise<{tripped: boolean, reason: string}>} never throws on a lookup failure
 */
export async function refuseMissingMinioService({
  env = process.env,
  resolve = (host) => dnsLookup(host),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
  exit = process.exit,
  tries = LOOKUP_TRIES,
  intervalMs = LOOKUP_INTERVAL_MS,
} = {}) {
  // S3_ENDPOINT wins over MINIO_* in servers/storage/s3-client.js: with one set,
  // MINIO_ENDPOINT is dead config and the old name resolving or not means nothing.
  if (String(env.S3_ENDPOINT || "").trim()) return { tripped: false, reason: "s3-endpoint-set" };
  if (String(env.MINIO_ENDPOINT || "").trim() !== COMPOSE_MINIO_HOST) return { tripped: false, reason: "not-compose-minio" };

  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(intervalMs);
    try {
      await resolve(COMPOSE_MINIO_HOST);
      return { tripped: false, reason: "resolved" };
    } catch (err) {
      // A timeout or a resolver misconfiguration says nothing about the service.
      if (!UNRESOLVED_CODES.has(err?.code)) return { tripped: false, reason: "lookup-error" };
    }
  }

  log.error(MISSING_MINIO_MESSAGE);
  exit(STORAGE_SERVICE_EXIT_CODE);
  return { tripped: true, reason: "unresolved" };
}

/**
 * The boot call (servers/gateway/index.js, before listen). A guard that cannot
 * ask DNS at all must not cost the operator a gateway: log and continue.
 */
export async function runStorageServiceGuard(opts = {}) {
  try {
    return await refuseMissingMinioService(opts);
  } catch (err) {
    console.warn(`[storage-guard] could not check the MinIO service: ${err.message}`);
    return { tripped: false, reason: "check-failed" };
  }
}