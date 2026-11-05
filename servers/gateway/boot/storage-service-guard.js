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
 * Exit 78 (EX_CONFIG), like the instance-path and satellite gates: a systemd unit with
 * `RestartPreventExitStatus=78` stops instead of restart-looping. Nothing else honors
 * the code — the root docker-compose.yml's `restart: unless-stopped` restarts the
 * gateway anyway, so under compose the same line repeats about every 4 s until .env
 * is fixed (the message says what to fix). Only a unit keeps it from looping by itself.
 *
 * Fires on the exact legacy shape only: MINIO_ENDPOINT is the compose service
 * name, no S3_ENDPOINT is set, and `minio` genuinely fails to resolve
 * (ENOTFOUND/EAI_AGAIN) twice, 2 s apart. Any other endpoint value, any other
 * lookup error (a resolver timeout, say), and any other host are not this
 * guard's business — a slow or broken resolver must never cost a gateway.
 *
 * The DB wins over env: servers/storage/s3-client.js:getClient() uses the Shared
 * Storage settings (dashboard_settings storage.shared.*) when a COMPLETE config is
 * there, and only then falls back to the S3_* / MINIO_* env names. A compose host
 * whose .env still says MINIO_ENDPOINT=minio but which stores through a Garage
 * configured in Settings is healthy, so the guard asks the DB the same question
 * first — read-only, through that module's own loader (loadSharedStorageFromDb), so
 * "a config the client would use" means exactly the same thing in both places. A
 * host with a DB endpoint is never refused, whatever the env says.
 *
 * Limitation: the read is possible only from where the guard runs — after the
 * schema guard and the migration registry, so crow.db and dashboard_settings exist.
 * It creates no identity (a first boot has none, hence no sealed settings, hence no
 * DB config — the correct answer, since the client would have none either) and the
 * client it opens is closed again. If the read fails for any reason the guard falls
 * back to the env verdict, exactly as before this check existed.
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
 * The DB half of the client's precedence rule, read-only: the endpoint of a complete
 * storage.shared.* config, read exactly as servers/storage/s3-client.js reads it
 * (its loader returns null unless endpoint + access key + secret are all present, so
 * a half-synced window keeps the env fallback in force there and here). Never throws:
 * any failure means "no DB config", which is also what the client would see.
 *
 * The guard runs after the schema guard and the migration registry, so the table is
 * there. No identity is created — loadIdentityIfPresent only reads — and the client
 * is closed in the finally block.
 */
export async function readSharedStorageEndpoint() {
  try {
    const [{ createDbClient }, { loadSharedStorageFromDb }, { loadIdentityIfPresent }] = await Promise.all([
      import("../../db.js"),
      import("../../storage/s3-client.js"),
      import("../../sharing/identity.js"),
    ]);
    const identity = loadIdentityIfPresent();
    if (!identity) return null;
    const db = createDbClient();
    try {
      const cfg = await loadSharedStorageFromDb(db, identity);
      return cfg?.endpoint || null;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[storage-guard] could not read Shared Storage from the DB: ${err.message}`);
    return null;
  }
}

/**
 * Trip the guard when the legacy compose storage shape has no service behind it.
 * Every dependency is injected so this is testable without DNS, a DB or a real boot.
 *
 * @param {object} [o]
 * @param {object} [o.env]        environment to read (defaults to process.env)
 * @param {() => Promise<string|null>} [o.sharedEndpoint] Shared Storage endpoint from the DB
 * @param {(host: string) => Promise<unknown>} [o.resolve] DNS lookup
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {{error: Function, warn: Function}} [o.log]
 * @param {(code: number) => void} [o.exit]
 * @returns {Promise<{tripped: boolean, reason: string}>} never throws on a lookup failure
 */
export async function refuseMissingMinioService({
  env = process.env,
  sharedEndpoint = readSharedStorageEndpoint,
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

  // And the DB wins over BOTH: a complete storage.shared.* config is what getClient()
  // uses, so a dead MINIO_ENDPOINT=minio is harmless on a Settings-configured host.
  // Asked only after the two env short-circuits: the common boot never touches the DB.
  let fromDb = null;
  try {
    fromDb = await sharedEndpoint();
  } catch (err) {
    log.warn(`[storage-guard] Shared Storage settings unreadable (${err.message}); judging by env`);
  }
  if (fromDb) return { tripped: false, reason: "db-storage-configured" };

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