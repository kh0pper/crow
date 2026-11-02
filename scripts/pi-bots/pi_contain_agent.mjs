/**
 * The pi agent dir a CONTAINED spawn gets: generated, door-only, per spawn.
 *
 * The contain tier (pi_contain.mjs) gives pi an empty root, so the per-spawn
 * copy of the operator's agent dir (pi_contain.mjs prepareAgentShadow, before
 * this module) was the one place provider keys still went in: it copied
 * auth.json, the operator's models.json (literal apiKeys for cloud rows,
 * LAN/tailnet baseUrls no door serves) and models-store.json, plus mcp.json
 * with token paths. This module writes the dir instead:
 *
 *   models.json   DOOR-ONLY. Every provider entry points at this gateway's
 *                 loopback door: `/llm/p/<row>/v1` for a row the provider door
 *                 serves (native, external engine, bundle, door_forward
 *                 opt-in) and `/llm/c/<row>` for a cloud row this box
 *                 consented to (the existing door entry: key `!cat
 *                 <cloudTokenPath>`, never the provider key). A row with no
 *                 door is reported in `missing` and the spawn is refused
 *                 (pi_sandbox.mjs wrapPiSpawn), never run keyless.
 *   mcp.json      exactly {"mcpServers":{}}: the bot's servers arrive on the
 *                 MCP config fd (mcp-delivery.mjs), never from this file.
 *   settings.json, keybindings.json   copied from the operator's agent dir
 *                 (pi reads its packages[] from settings.json; those package
 *                 paths stay bound read-only by pi_contain.mjs, as before).
 *   everything else absent: no auth.json (the operator's pi logins are not a
 *                 bot's), no models-store.json, no skills/ entry, no symlink.
 *   model-roles.json   a 0600 copy of the instance's role snapshot, so the
 *                 spawned CROW_MODEL_ROLES_FILE names a file inside the dir
 *                 instead of <CROW_HOME> (which is not bound).
 *
 * Why not buildManagedEntries (servers/shared/pi-models-sync.js): it keeps a
 * bundle/external row's OWN baseUrl, and that file's import graph reaches the
 * gateway's settings registry, which the bridge must never load
 * (tests/pibot-model-resolver-roles.test.js). The entry shapes here are the
 * same ones that module writes, built from the same door helpers
 * (providerDoorUrl/cloudDoorUrl, doorKindOf, consentVerdict, piCompatFor).
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCrowHome } from "../../servers/shared/crow-home.js";
import { providerDoorUrl, cloudDoorUrl } from "../../servers/gateway/models/door.js";
import { doorKindOf, isLocalClassTarget, isForbiddenTarget } from "../../servers/gateway/models/door-resolve.js";
import { cloudDoorEligible, consentVerdict } from "../../servers/shared/cloud-consent.js";
import { DOOR_ID_PREFIX, doorEntryId, piCompatFor } from "../../servers/shared/pi-compat.js";
import { AGENT_RO_SUBDIRS } from "./pi_contain.mjs";

/** Agent files copied from the operator's dir, unchanged. */
export const AGENT_COPIED_FILES = Object.freeze(["settings.json", "keybindings.json"]);
/** The role snapshot's name inside the generated dir. */
export const CONTAINED_ROLES_FILE = "model-roles.json";

/** <CROW_HOME>/llm-cloud-token — the same file servers/gateway/local-token.js
 *  rotates every boot (llmCloudTokenPath). Not imported from there: that
 *  module loads the dashboard settings registry, which the bridge must never
 *  load; this is the servicesTokenPath pattern (service-blocks.mjs). */
export function containedCloudTokenPath() { return join(resolveCrowHome(), "llm-cloud-token"); }

const OPENAI_TYPES = new Set([null, undefined, "", "openai-compat", "openai"]);
/** Task tags that are not chat models for pi (pi-models-sync's NON_CHAT). */
const NON_CHAT = new Set(["embed", "embedding", "rerank", "score"]);
const PI_DEFAULT_MAX_TOKENS = 16384;

const posInt = (v) => {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/** pi's model definitions for a row's chat models, with the same contextWindow
 *  / maxTokens rules pi-models-sync's chatModels uses (half the window keeps
 *  room for the prompt, never above pi's own 16384 default). */
function modelEntries(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === "string" ? { id: m } : m))
    .filter((m) => m && typeof m.id === "string" && m.id.trim() && !NON_CHAT.has(m.task))
    .map((m) => {
      const out = { id: m.id };
      if (typeof m.name === "string" && m.name.trim()) out.name = m.name.trim();
      if (typeof m.reasoning === "boolean") out.reasoning = m.reasoning;
      if (Array.isArray(m.input)) {
        const input = [...new Set(m.input.filter((x) => x === "text" || x === "image"))];
        if (input.length) out.input = input;
      }
      const ctx = posInt(m.contextWindow) ?? posInt(m.contextLen) ?? posInt(m.context_len);
      if (ctx !== undefined) out.contextWindow = ctx;
      const rowMax = posInt(m.maxTokens);
      if (ctx !== undefined) out.maxTokens = Math.min(rowMax ?? PI_DEFAULT_MAX_TOKENS, Math.floor(ctx / 2));
      else if (rowMax !== undefined) out.maxTokens = rowMax;
      return out;
    });
}

/** A path as one /bin/sh single-quoted word (pi runs the `!cat` apiKey under
 *  /bin/sh on every auth resolve): each ' becomes '\''. */
function shellQuote(path) { return "'" + String(path).replace(/'/g, "'\\''") + "'"; }

const doorBaseFor = (gatewayPort) => `http://127.0.0.1:${gatewayPort}/llm/v1`;

/** True for a URL this gateway's door serves: loopback, its own port, /llm/p or /llm/c. */
function isContainedDoorUrl(url, gatewayPort) {
  return typeof url === "string" && new RegExp("^http://127\\.0\\.0\\.1:" + gatewayPort + "/llm/(?:p|c)/").test(url);
}

/** The row behind a provider id pi was told to spawn with (pi folds ids to
 *  lower case, so a case-insensitive match counts too). */
function rowFor(rows, id) {
  if (typeof id !== "string" || !id) return null;
  const exact = rows.find((r) => r && r.id === id);
  if (exact) return exact;
  const lower = id.toLowerCase();
  return rows.find((r) => r && typeof r.id === "string" && r.id.toLowerCase() === lower) || null;
}

/** A row the provider door `/llm/p` actually forwards for: a loopback, private
 *  or tailnet target Crow manages (native, external engine, bundle, opt-in).
 *  doorKindOf's "unmanaged" rows (a plain LAN/tailnet endpoint nothing routes
 *  for) are exactly the ones `/llm/p` refuses with NOT_FORWARDABLE. */
function doorRow(r) {
  if (!r || typeof r.baseUrl !== "string" || !r.baseUrl) return null;
  if (isForbiddenTarget(r.baseUrl) || !isLocalClassTarget(r.baseUrl)) return null;
  if (doorKindOf(r) === "unmanaged") return null;
  return r;
}

/** The consented cloud door entry for a row (the shape pi-models-sync writes),
 *  or null when the row is not one this box agreed to serve. */
function cloudDoorEntry(r, { gatewayPort, cloudTokenPath, consent, consentSalt }) {
  if (!r || typeof cloudTokenPath !== "string" || !cloudTokenPath) return null;
  if (!cloudDoorEligible(r)) return null;
  if (!OPENAI_TYPES.has(r.provider_type) && r.provider_type !== "anthropic") return null;
  const entry = consent && typeof consent === "object" && Object.hasOwn(consent, r.id) ? consent[r.id] : null;
  if (consentVerdict(r, entry, { salt: consentSalt }) !== "ok") return null;
  const models = modelEntries(r.models);
  if (!models.length) return null;
  const anthropic = r.provider_type === "anthropic";
  return {
    baseUrl: cloudDoorUrl(gatewayPort, r.id, r.provider_type),
    apiKey: "!cat " + shellQuote(cloudTokenPath),
    api: anthropic ? "anthropic-messages" : "openai-completions",
    models: anthropic ? models : models.map((m) => {
      const compat = piCompatFor(r.baseUrl, m.id);
      return compat ? { ...m, compat } : m;
    }),
  };
}

/**
 * Write the door-only agent dir for one contained spawn.
 *
 * @param {object} a
 * @param {string} a.piAgentDir       the operator's agent dir (settings/keybindings source)
 * @param {string} a.dir              the dir to fill (a fresh per-spawn dir)
 * @param {string[]} [a.providerIds]  the providers this spawn needs (pi ids: a row id, or crow-c-<row>)
 * @param {object[]} [a.rows]         this instance's providers rows (providerRowToObject shape)
 * @param {object|null} [a.consent]   dashboard_settings.llm_cloud_door_rows
 * @param {string|null} [a.consentSalt]
 * @param {number} a.gatewayPort      the spawner's own gateway port
 * @param {string|null} [a.cloudTokenPath]  <CROW_HOME>/llm-cloud-token
 * @param {string|null} [a.modelRolesFile]  the instance's role snapshot
 * @returns {{dir: string, missing: Array<{provider: string, reason: string}>, env: object, roleSnapshotPath: string|null}}
 *   `missing` names every needed provider no door serves; `env` is the spawn
 *   env this dir needs (CROW_MODEL_ROLES_FILE inside the dir).
 */
export function buildContainedAgentDir({
  piAgentDir, dir, providerIds = [], rows = [], consent = null, consentSalt = null,
  gatewayPort, cloudTokenPath = null, modelRolesFile = null,
} = {}) {
  if (!dir) throw new Error("buildContainedAgentDir: dir is required");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const doorBase = doorBaseFor(gatewayPort);
  const providers = {};
  const missing = [];
  const seen = new Set();
  for (const raw of Array.isArray(providerIds) ? providerIds : []) {
    if (typeof raw !== "string" || !raw || seen.has(raw)) continue;
    seen.add(raw);
    const asCloudEntry = raw.toLowerCase().startsWith(DOOR_ID_PREFIX);
    const row = asCloudEntry ? rowFor(rows, raw.slice(DOOR_ID_PREFIX.length)) : rowFor(rows, raw);
    const label = row ? row.id : raw;
    let entry = null;
    let key = null;
    if (asCloudEntry) {
      // pi was spawned as crow-c-<row>: only that id, and only as a door entry.
      if (row) { entry = cloudDoorEntry(row, { gatewayPort, cloudTokenPath, consent, consentSalt }); key = raw; }
    } else if (doorRow(row)) {
      const models = modelEntries(row.models);
      if (OPENAI_TYPES.has(row.provider_type) && models.length) {
        entry = { baseUrl: providerDoorUrl(doorBase, row.id), apiKey: "none", api: "openai-completions", models };
        key = row.id;
      }
    }
    if (!entry && row) {
      // A cloud row reaches a bot only as its consented crow-c-* entry, and pi
      // must then be spawned with that id.
      const doorId = doorEntryId(row.id);
      const cloud = cloudDoorEntry(row, { gatewayPort, cloudTokenPath, consent, consentSalt });
      if (cloud) { entry = cloud; key = doorId; }
    }
    if (!entry || !isContainedDoorUrl(entry.baseUrl, gatewayPort)) {
      missing.push({ provider: label, reason: "provider " + label + " has no door" });
      continue;
    }
    providers[key] = entry;
  }

  const write = (name, data) => {
    const p = join(dir, name);
    writeFileSync(p, data, { mode: 0o600 });
    chmodSync(p, 0o600);
    return p;
  };
  write("models.json", JSON.stringify({ providers, "$crowManaged": Object.keys(providers).sort() }, null, 2) + "\n");
  write("mcp.json", JSON.stringify({ mcpServers: {} }) + "\n");

  for (const f of AGENT_COPIED_FILES) {
    const src = join(piAgentDir || "", f);
    try {
      if (!lstatSync(src).isFile()) continue; // never follow a symlink out of the agent dir
      copyFileSync(src, join(dir, f));
      chmodSync(join(dir, f), 0o600);
    } catch { /* absent: pi uses its defaults */ }
  }
  // Mount points only: pi_contain.mjs binds the operator's real subdirs (code,
  // prompts, pkg) read-only on top of them. No skills/ entry is created.
  for (const d of AGENT_RO_SUBDIRS) {
    try { if (lstatSync(join(piAgentDir || "", d)).isDirectory()) mkdirSync(join(dir, d), { mode: 0o700 }); } catch { /* absent */ }
  }

  // The role snapshot lives under <CROW_HOME>, which a contained spawn never
  // binds: the spawn env names a copy inside this dir instead.
  const roleSnapshotPath = join(dir, CONTAINED_ROLES_FILE);
  let copied = null;
  try {
    if (modelRolesFile && lstatSync(modelRolesFile).isFile()) {
      copyFileSync(modelRolesFile, roleSnapshotPath);
      chmodSync(roleSnapshotPath, 0o600);
      copied = roleSnapshotPath;
    }
  } catch { copied = null; }

  return { dir, missing, env: { CROW_MODEL_ROLES_FILE: roleSnapshotPath }, roleSnapshotPath: copied };
}