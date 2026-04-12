#!/usr/bin/env node
/**
 * Mastodon storage wiring.
 *
 * Reads MASTODON_S3_* from the bundle's .env, runs F.0's
 * storage-translators.mastodon() to get Mastodon's S3_* envelope, and
 * appends the translated vars to .env so compose picks them up on next up.
 *
 * No-op when MASTODON_S3_ENDPOINT is unset (on-disk storage).
 * Managed block: `# crow-mastodon-storage BEGIN` / `END`.
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
  const endpoint = env.MASTODON_S3_ENDPOINT;
  const bucket = env.MASTODON_S3_BUCKET;
  const accessKey = env.MASTODON_S3_ACCESS_KEY;
  const secretKey = env.MASTODON_S3_SECRET_KEY;
  const region = env.MASTODON_S3_REGION || "us-east-1";

  if (!endpoint) {
    console.log("[configure-storage] MASTODON_S3_ENDPOINT not set — using on-disk storage.");
    return;
  }
  if (!bucket || !accessKey || !secretKey) {
    console.error("[configure-storage] MASTODON_S3_ENDPOINT is set but bucket/access/secret are missing — refusing partial config.");
    process.exit(1);
  }

  let translate;
  try {
    const mod = await import(resolve(__dirname, "..", "..", "..", "servers", "gateway", "storage-translators.js"));
    translate = mod.translate;
  } catch {
    console.error("[configure-storage] Cannot load storage-translators.js — falling back to inline mapping.");
    const urlParts = (u) => {
      const m = u.match(/^(https?):\/\/([^/]+)/i);
      return m ? { scheme: m[1], authority: m[2] } : { scheme: "https", authority: u };
    };
    translate = (_, crow) => {
      const { scheme, authority } = urlParts(crow.endpoint);
      return {
        S3_ENABLED: "true",
        S3_BUCKET: crow.bucket,
        AWS_ACCESS_KEY_ID: crow.accessKey,
        AWS_SECRET_ACCESS_KEY: crow.secretKey,
        S3_REGION: crow.region || "us-east-1",
        S3_PROTOCOL: scheme,
        S3_HOSTNAME: authority,
        S3_ENDPOINT: crow.endpoint,
        S3_FORCE_SINGLE_REQUEST: "true",
      };
    };
  }

  const mapped = translate("mastodon", { endpoint, bucket, accessKey, secretKey, region });

  const BEGIN = "# crow-mastodon-storage BEGIN (managed by scripts/configure-storage.mjs — do not edit)";
  const END = "# crow-mastodon-storage END";
  const block = [BEGIN, ...Object.entries(mapped).map(([k, v]) => `${k}=${v}`), END, ""].join("\n");

  let cur = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  if (cur.includes(BEGIN)) {
    cur = cur.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), "");
  }
  if (cur.length && !cur.endsWith("\n")) cur += "\n";
  writeFileSync(ENV_PATH, cur + block);
  console.log(`[configure-storage] Wrote ${Object.keys(mapped).length} translated S3 env vars to ${ENV_PATH}.`);
  console.log("[configure-storage] Restart compose so web + sidekiq pick up the new vars:");
  console.log("  docker compose -f bundles/mastodon/docker-compose.yml up -d --force-recreate");
}

main().catch((err) => {
  console.error(`[configure-storage] Failed: ${err.message}`);
  process.exit(1);
});
