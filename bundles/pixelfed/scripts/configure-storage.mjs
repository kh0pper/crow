#!/usr/bin/env node
/**
 * Pixelfed storage wiring.
 *
 * Reads PIXELFED_S3_* from the bundle's .env, runs F.0's
 * storage-translators.pixelfed() to get Pixelfed's AWS_* + FILESYSTEM_CLOUD
 * + PF_ENABLE_CLOUD schema, and appends the translated vars to the .env
 * file so compose picks them up on the next `up`.
 *
 * If PIXELFED_S3_ENDPOINT is not set, exits 0 (on-disk storage — no-op).
 *
 * Invoked by scripts/post-install.sh. Safe to re-run (managed block is
 * delimited by `# crow-pixelfed-storage BEGIN` / `END`).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  const endpoint = env.PIXELFED_S3_ENDPOINT;
  const bucket = env.PIXELFED_S3_BUCKET;
  const accessKey = env.PIXELFED_S3_ACCESS_KEY;
  const secretKey = env.PIXELFED_S3_SECRET_KEY;
  const region = env.PIXELFED_S3_REGION || "us-east-1";

  if (!endpoint) {
    console.log("[configure-storage] PIXELFED_S3_ENDPOINT not set — using on-disk storage.");
    return;
  }
  if (!bucket || !accessKey || !secretKey) {
    console.error("[configure-storage] PIXELFED_S3_ENDPOINT is set but bucket/access/secret are missing — refusing partial config.");
    process.exit(1);
  }

  let translate;
  try {
    const mod = await import(resolve(__dirname, "..", "..", "..", "servers", "gateway", "storage-translators.js"));
    translate = mod.translate;
  } catch {
    console.error("[configure-storage] Cannot load storage-translators.js — falling back to inline mapping.");
    translate = (_, crow) => ({
      FILESYSTEM_CLOUD: "s3",
      PF_ENABLE_CLOUD: "true",
      AWS_ACCESS_KEY_ID: crow.accessKey,
      AWS_SECRET_ACCESS_KEY: crow.secretKey,
      AWS_DEFAULT_REGION: crow.region || "us-east-1",
      AWS_BUCKET: crow.bucket,
      AWS_URL: crow.endpoint,
      AWS_ENDPOINT: crow.endpoint,
      AWS_USE_PATH_STYLE_ENDPOINT: "true",
    });
  }

  const mapped = translate("pixelfed", { endpoint, bucket, accessKey, secretKey, region });

  const BEGIN = "# crow-pixelfed-storage BEGIN (managed by scripts/configure-storage.mjs — do not edit)";
  const END = "# crow-pixelfed-storage END";
  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${v}`), END, ""].join("\n");

  let cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  if (cur.includes(BEGIN)) {
    cur = cur.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), "");
  }
  if (cur.length && !cur.endsWith("\n")) cur += "\n";
  writeFileSync(ENV_PATH, cur + block);
  console.log(`[configure-storage] Wrote ${Object.keys(mapped).length} translated S3 env vars to ${ENV_PATH}.`);
  console.log("[configure-storage] Restart the compose stack so app + horizon pick up the new vars:");
  console.log("  docker compose -f bundles/pixelfed/docker-compose.yml up -d --force-recreate");
}

main().catch((err) => {
  console.error(`[configure-storage] Failed: ${err.message}`);
  process.exit(1);
});
