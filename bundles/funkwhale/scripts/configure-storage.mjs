#!/usr/bin/env node
/**
 * Funkwhale storage wiring.
 *
 * Reads FUNKWHALE_S3_* from the bundle's .env, runs F.0's
 * storage-translators.funkwhale() to get Funkwhale's AWS_* schema, and
 * appends the translated vars to the .env file so the compose stack picks
 * them up on the next `up`.
 *
 * If FUNKWHALE_S3_ENDPOINT is not set, exits 0 (on-disk storage — no-op).
 *
 * Invoked by scripts/post-install.sh. Safe to re-run (writes a managed
 * block delimited by `# crow-funkwhale-storage BEGIN` / `END`).
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env");

// Compose-exact .env codec (servers/gateway/bundle-env-codec.js): the installer quotes values
// with spaces, quotes, $ or #. An INSTALLED copy runs from ~/.crow/bundles/<id>/scripts/, where
// the repo-relative path does not exist — so resolve the app from CROW_APP_ROOT, then the
// in-repo location, and otherwise use the copy shipped beside this script. A failed import
// must never leave S3 storage silently unconfigured.
async function loadCodec() {
  for (const root of [process.env.CROW_APP_ROOT, resolve(__dirname, "..", "..", "..")]) {
    if (!root) continue;
    const p = resolve(root, "servers", "gateway", "bundle-env-codec.js");
    if (!existsSync(p)) continue;
    try { return await import(pathToFileURL(p).href); } catch { /* try the next location */ }
  }
  return import(new URL("./env-codec-fallback.mjs", import.meta.url).href);
}
const codec = await loadCodec();
function parseEnv(text) {
  return codec.parseEnvText(text);
}

function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  return parseEnv(readFileSync(ENV_PATH, "utf8"));
}

async function main() {
  const env = loadEnv();
  const endpoint = env.FUNKWHALE_S3_ENDPOINT;
  const bucket = env.FUNKWHALE_S3_BUCKET;
  const accessKey = env.FUNKWHALE_S3_ACCESS_KEY;
  const secretKey = env.FUNKWHALE_S3_SECRET_KEY;
  const region = env.FUNKWHALE_S3_REGION || "us-east-1";

  if (!endpoint) {
    console.log("[configure-storage] FUNKWHALE_S3_ENDPOINT not set — using on-disk storage.");
    return;
  }
  if (!bucket || !accessKey || !secretKey) {
    console.error("[configure-storage] FUNKWHALE_S3_ENDPOINT is set but bucket/access/secret are missing — refusing partial config.");
    process.exit(1);
  }

  let translate;
  try {
    const mod = await import(resolve(__dirname, "..", "..", "..", "servers", "gateway", "storage-translators.js"));
    translate = mod.translate;
  } catch (err) {
    console.error(`[configure-storage] Cannot load storage-translators.js (monorepo helper). In installed-mode this is expected; falling back to direct mapping.`);
    translate = (_, crow) => ({
      AWS_ACCESS_KEY_ID: crow.accessKey,
      AWS_SECRET_ACCESS_KEY: crow.secretKey,
      AWS_STORAGE_BUCKET_NAME: crow.bucket,
      AWS_S3_ENDPOINT_URL: crow.endpoint,
      AWS_S3_REGION_NAME: crow.region || "us-east-1",
      AWS_LOCATION: "",
      AWS_QUERYSTRING_AUTH: "true",
      AWS_QUERYSTRING_EXPIRE: "3600",
    });
  }

  const mapped = translate("funkwhale", { endpoint, bucket, accessKey, secretKey, region });

  const BEGIN = "# crow-funkwhale-storage BEGIN (managed by scripts/configure-storage.mjs — do not edit)";
  const END = "# crow-funkwhale-storage END";
  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${codec.encodeEnvValue(v)}`), END, ""].join("\n");

  let cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  if (cur.includes(BEGIN)) {
    cur = cur.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), "");
  }
  if (cur.length && !cur.endsWith("\n")) cur += "\n";
  writeFileSync(ENV_PATH, cur + block);
  console.log(`[configure-storage] Wrote ${Object.keys(mapped).length} translated S3 env vars to ${ENV_PATH}.`);
  console.log("[configure-storage] Restart the compose stack so api + celeryworker pick up the new vars:");
  console.log("  docker compose -f bundles/funkwhale/docker-compose.yml up -d --force-recreate");
}

main().catch((err) => {
  console.error(`[configure-storage] Failed: ${err.message}`);
  process.exit(1);
});
