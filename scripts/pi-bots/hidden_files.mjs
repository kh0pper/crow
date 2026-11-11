/**
 * The secret FILES a bot's default-tier sandbox masks with --ro-bind /dev/null
 * (pi_sandbox.mjs hideFiles). Built here, per spawn, from the instance's Crow
 * home and the repo checkout.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundles whose tool servers read their OWN .env inside the bot's sandbox at
 * run time: bundles/browser/server/instance.js and
 * bundles/workspace/server/config.js. Their .env stays readable until the
 * Phase 2 browser door replaces the file-based CDP token. Every other
 * bundle's .env has no reader inside the sandbox.
 */
export const BUNDLE_ENV_READABLE = ["browser", "workspace"];

/**
 * Root files the gateway side reads and hands the bot in its MCP block
 * headers (scripts/pi-bots/crow-server-catalog.mjs), so a bot never needs the
 * file itself.
 *
 * Deliberately NOT masked, and the reader inside the sandbox:
 *  - models-token: pi-lab's local-models extension.
 *  - llm-cloud-token: pi runs `cat` on it as a provider apiKey.
 *  - kiosk-announce-token: the kiosk MCP server reads it on each call
 *    (bundles/kiosk/server/server.js).
 *  - studio-agent-token: the studio MCP server reads it on each call
 *    (bundles/studio/server/hub-client.js).
 */
export const ROOT_SECRET_FILES = [".env", ".keystore-env", "board-token", "phone-token", "artifacts-token"];

/**
 * Absolute paths of the secret files to mask, for one Crow home (and the
 * repo checkout at appRoot, when given). Existence is not checked here:
 * wrapPiSpawn skips a file it cannot stat.
 * @param {{crowHome:string, appRoot?:string, readdir?:Function}} opts
 * @returns {string[]}
 */
export function secretFilesFor({ crowHome, appRoot, readdir = readdirSync }) {
  const out = [];
  const add = (p) => { if (!out.includes(p)) out.push(p); };
  for (const n of ROOT_SECRET_FILES) add(join(crowHome, n));
  if (appRoot) add(join(appRoot, ".env"));
  // Every bundle dir, including a stale copy (x.migrated-...): its .env is a
  // secret too. A missing bundles dir means none.
  let entries = [];
  try { entries = readdir(join(crowHome, "bundles")); } catch { entries = []; }
  for (const id of entries) {
    if (BUNDLE_ENV_READABLE.includes(id)) continue;
    add(join(crowHome, "bundles", id, ".env"));
  }
  return out;
}