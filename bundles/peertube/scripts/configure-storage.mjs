#!/usr/bin/env node
/**
 * PeerTube storage wiring.
 *
 * Reads PEERTUBE_S3_* from the bundle's .env, runs F.0's
 * storage-translators.peertube() to get PeerTube's PEERTUBE_OBJECT_STORAGE_*
 * envelope, and appends the translated vars to .env. Strongly recommended
 * to configure — see the skill doc for why S3 is load-bearing.
 *
 * No-op when PEERTUBE_S3_ENDPOINT is unset.
 * Managed block: `# crow-peertube-storage BEGIN` / `END`.
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
  const endpoint = env.PEERTUBE_S3_ENDPOINT;
  const bucket = env.PEERTUBE_S3_BUCKET;
  const accessKey = env.PEERTUBE_S3_ACCESS_KEY;
  const secretKey = env.PEERTUBE_S3_SECRET_KEY;
  const region = env.PEERTUBE_S3_REGION || "us-east-1";

  if (!endpoint) {
    console.log("[configure-storage] PEERTUBE_S3_ENDPOINT not set — using on-disk storage. Strongly recommended to enable S3 before publishing anything.");
    return;
  }
  if (!bucket || !accessKey || !secretKey) {
    console.error("[configure-storage] PEERTUBE_S3_ENDPOINT is set but bucket/access/secret are missing — refusing partial config.");
    process.exit(1);
  }

  let translate;
  try {
    const mod = await import(resolve(__dirname, "..", "..", "..", "servers", "gateway", "storage-translators.js"));
    translate = mod.translate;
  } catch {
    console.error("[configure-storage] Cannot load storage-translators.js — falling back to inline mapping.");
    translate = (_, crow) => ({
      PEERTUBE_OBJECT_STORAGE_ENABLED: "true",
      PEERTUBE_OBJECT_STORAGE_ENDPOINT: crow.endpoint,
      PEERTUBE_OBJECT_STORAGE_REGION: crow.region || "us-east-1",
      PEERTUBE_OBJECT_STORAGE_ACCESS_KEY_ID: crow.accessKey,
      PEERTUBE_OBJECT_STORAGE_SECRET_ACCESS_KEY: crow.secretKey,
      PEERTUBE_OBJECT_STORAGE_UPLOAD_ACL_PUBLIC: "public-read",
      PEERTUBE_OBJECT_STORAGE_UPLOAD_ACL_PRIVATE: "private",
      PEERTUBE_OBJECT_STORAGE_VIDEOS_BUCKET_NAME: crow.bucket,
      PEERTUBE_OBJECT_STORAGE_STREAMING_PLAYLISTS_BUCKET_NAME: crow.bucket,
      PEERTUBE_OBJECT_STORAGE_WEB_VIDEOS_BUCKET_NAME: crow.bucket,
      PEERTUBE_OBJECT_STORAGE_ORIGINAL_VIDEO_FILES_BUCKET_NAME: crow.bucket,
      PEERTUBE_OBJECT_STORAGE_USER_EXPORTS_BUCKET_NAME: crow.bucket,
    });
  }

  const mapped = translate("peertube", { endpoint, bucket, accessKey, secretKey, region });

  const BEGIN = "# crow-peertube-storage BEGIN (managed by scripts/configure-storage.mjs — do not edit)";
  const END = "# crow-peertube-storage END";
  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${v}`), END, ""].join("\n");

  let cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  if (cur.includes(BEGIN)) {
    cur = cur.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), "");
  }
  if (cur.length && !cur.endsWith("\n")) cur += "\n";
  writeFileSync(ENV_PATH, cur + block);
  console.log(`[configure-storage] Wrote ${Object.keys(mapped).length} translated PEERTUBE_OBJECT_STORAGE_* env vars to ${ENV_PATH}.`);
  console.log("[configure-storage] Restart compose so peertube picks up the new vars:");
  console.log("  docker compose -f bundles/peertube/docker-compose.yml up -d --force-recreate");
  console.log("[configure-storage] To migrate existing on-disk media to S3:");
  console.log("  docker exec -it crow-peertube node dist/scripts/migrate-videos-to-object-storage.js");
}

main().catch((err) => {
  console.error(`[configure-storage] Failed: ${err.message}`);
  process.exit(1);
});
