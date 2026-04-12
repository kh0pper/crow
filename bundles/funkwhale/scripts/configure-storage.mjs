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
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env");

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
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
  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${v}`), END, ""].join("\n");

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
