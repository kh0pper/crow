#!/usr/bin/env node
/**
 * Crow Bot Builder — Extension capability registry (Slice A, A2/A4).
 *
 * The "extension capability layer". An EXTENSION (on a given instance) is an
 * MCP server registered in <crowHome>/mcp-addons.json — the add-on servers a
 * bot can use beyond the canonical ~/.pi/agent/mcp.json set. A repo bundle MAY
 * additionally declare a `capabilities` block (A1) that ENRICHES presentation
 * (group, per-tool label/subgroup, contributed skills, target runtimes); when
 * present it is overlaid, when absent the extension still works with sensible
 * defaults (group = server id, tools straight from the live probe).
 *
 * This is the data source the Bot Builder palette (A6) folds into its live MCP
 * probe, and the home of the canonical->voice-category map (A4) Slice B needs.
 *
 * NON-DISRUPTIVE: read-only. It never installs, mutates configs, or spawns
 * long-lived processes. extensionTools() does a short, killed-on-finish stdio
 * tools/list probe (mcp_writer.probeServerTools) — the same mechanism the
 * Tools tab already uses for canonical servers.
 *
 * Verified against the MPA layout: the install route registers an MCP server
 * under its bundle id as a key in <crowHome>/mcp-addons.json; MPA has NO
 * installed.json (its addons are hand-authored in ~/.crow-mpa/mcp-addons.json).
 * So mcp-addons.json IS the source of truth for what is installed.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { probeServerTools, readCanonicalMcp, CANONICAL_MCP_PATH } from "./mcp_writer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/pi-bots -> repo root (~/crow) -> bundles
const REPO_ROOT = join(__dirname, "..", "..");
const APP_BUNDLES = join(REPO_ROOT, "bundles");

/**
 * Resolve the active Crow instance home, matching servers/gateway/proxy.js
 * resolveCrowHome() exactly: the per-instance CROW_HOME env (set by the MPA
 * service to ~/.crow-mpa) or the primary default ~/.crow. Shared by A3/A5 so
 * skills + minted addon blocks resolve against the SAME instance the DB does.
 * NOTE (plan context): the DB routes on CROW_DATA_DIR/CROW_DB_PATH, NOT this —
 * crowHome governs bundles/skills/mcp-addons/panels, not the database path.
 */
export function resolveCrowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/** Path to <crowHome>/mcp-addons.json for the given (or active) instance. */
export function mcpAddonsPath(crowHome = resolveCrowHome()) {
  return join(crowHome, "mcp-addons.json");
}

function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * The raw mcp-addons.json server block for an addon id on this instance, or
 * null. This is the verbatim {command,args,cwd?,env?} the gateway proxy /
 * pi-lab would spawn. A5 mints a per-bot pi block from exactly this.
 */
export function mcpAddonBlockFor(serverId, crowHome = resolveCrowHome()) {
  const addons = readJsonSafe(mcpAddonsPath(crowHome), {});
  return (addons && addons[serverId]) || null;
}

/** Canonical (homedir) mcp.json — parsed, or {mcpServers:{}} on failure. */
function readCanonicalSafe() {
  try {
    return readCanonicalMcp();
  } catch {
    return { mcpServers: {} };
  }
}

/** Canonical (homedir) mcp.json server block for an id, or null. */
function canonicalBlockFor(serverId) {
  return readCanonicalSafe().mcpServers[serverId] || null;
}

/**
 * Default an addon block's cwd the SAME way the gateway proxy does
 * (proxy.js:197: `config.cwd || join(resolveCrowHome(),"bundles",id)`) and the
 * SAME way A5 must mint it for pi (pi-lab spawns with `cwd: cfg.cwd` and NO
 * default — so a cwd-less addon like `tasks`/`bots-sql-mcp` would run
 * `node server/index.js` from the wrong dir and MODULE_NOT_FOUND). Returns a
 * shallow copy with cwd filled.
 */
export function addonBlockWithCwd(serverId, block, crowHome = resolveCrowHome()) {
  if (!block) return block;
  return { ...block, cwd: block.cwd || join(crowHome, "bundles", serverId) };
}

/**
 * A spawnable server block for an id: prefer the per-instance addon block
 * (with cwd defaulted), fall back to the canonical homedir block (used as-is,
 * since canonical blocks are authored with correct cwd). Used to LIVE-probe.
 */
export function serverBlockFor(serverId, crowHome = resolveCrowHome()) {
  const addon = mcpAddonBlockFor(serverId, crowHome);
  if (addon) return addonBlockWithCwd(serverId, addon, crowHome);
  return canonicalBlockFor(serverId);
}

// ---- capability-bundle index (enrichment overlay) -------------------------

/**
 * Scan repo bundles for a `capabilities` block (A1). Returns the universe of
 * extension-capable bundles, independent of any instance. Each entry:
 *   { id, name, description, capabilities:{mcp_server_id,group,skills[],runtimes{},tools[]} }
 */
export function listCapabilityBundles() {
  const out = [];
  let ids;
  try {
    ids = readdirSync(APP_BUNDLES);
  } catch {
    return out;
  }
  for (const id of ids) {
    const mpath = join(APP_BUNDLES, id, "manifest.json");
    if (!existsSync(mpath)) continue;
    const m = readJsonSafe(mpath, null);
    if (!m || !m.capabilities || typeof m.capabilities !== "object") continue;
    const cap = m.capabilities;
    out.push({
      id: m.id || id,
      name: m.name || m.id || id,
      description: m.description || "",
      capabilities: {
        mcp_server_id: cap.mcp_server_id || m.id || id,
        group: cap.group || (m.name || id),
        skills: Array.isArray(cap.skills) ? cap.skills.slice() : [],
        runtimes: cap.runtimes || {},
        tools: Array.isArray(cap.tools) ? cap.tools.slice() : [],
      },
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Map: mcp_server_id -> capability bundle (for overlay lookup). */
function capabilityIndex() {
  const idx = new Map();
  for (const b of listCapabilityBundles()) idx.set(b.capabilities.mcp_server_id, b);
  return idx;
}

// ---- installed extensions (instance-actual) -------------------------------

/**
 * Extensions installed on this instance = every server in
 * <crowHome>/mcp-addons.json, annotated with:
 *   id          the mcp-addons key / server id
 *   block       the spawnable {command,args,cwd?,env?}
 *   inCanonical also present in ~/.pi/agent/mcp.json (homedir wins -> no mint
 *               needed; the palette already shows it under the canonical groups)
 *   needsMint   !inCanonical — A5 must mint a per-bot pi block for these
 *   group       capability group, else the server id
 *   name        capability bundle name, else the server id
 *   capabilities the overlay block, or null
 */
export function listInstalledExtensions(crowHome = resolveCrowHome()) {
  const addons = readJsonSafe(mcpAddonsPath(crowHome), {});
  const canonical = readCanonicalSafe().mcpServers || {};
  const idx = capabilityIndex();
  const out = [];
  for (const id of Object.keys(addons)) {
    const cap = idx.get(id) || null;
    const inCanonical = Object.prototype.hasOwnProperty.call(canonical, id);
    out.push({
      id,
      block: addonBlockWithCwd(id, addons[id], crowHome),
      inCanonical,
      needsMint: !inCanonical,
      group: (cap && cap.capabilities.group) || id,
      name: (cap && cap.name) || id,
      capabilities: cap ? cap.capabilities : null,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Capability bundles NOT installed on this instance (neither an addon nor
 * canonical). The palette can offer these as "available to install" with a
 * not-installed badge. (Slice A on MPA: funkwhale/media/meta-glasses.)
 */
export function listAvailableExtensions(crowHome = resolveCrowHome()) {
  const addons = readJsonSafe(mcpAddonsPath(crowHome), {});
  const canonical = readCanonicalSafe().mcpServers || {};
  return listCapabilityBundles().filter((b) => {
    const sid = b.capabilities.mcp_server_id;
    return !(sid in addons) && !(sid in canonical);
  });
}

/**
 * LIVE tools for an extension on this instance. `ext` may be an entry from
 * listInstalledExtensions() (has .id/.block/.capabilities) or a bare server-id
 * string. Spawns the MCP server, runs tools/list (mcp_writer.probeServerTools),
 * then overlays curated capabilities metadata (label/subgroup) where declared.
 * Mirrors the canonical-server probe shape so A6 can fold it into probeAll.
 *
 * @returns {Promise<{ok:boolean, serverId, group, inCanonical?, tools?, error?}>}
 *   tools[] = { name, description, hasPattern, label, subgroup }.
 */
export async function extensionTools(ext, opts = {}) {
  const crowHome = opts.crowHome || resolveCrowHome();
  const entry = typeof ext === "string" ? { id: ext } : ext;
  const sid = entry.id || entry.serverId || entry.mcp_server_id;
  const cap =
    entry.capabilities || (capabilityIndex().get(sid) || {}).capabilities || null;
  const group = entry.group || (cap && cap.group) || sid;
  const block = entry.block || serverBlockFor(sid, crowHome);
  if (!block) {
    return { ok: false, serverId: sid, group, error: "not installed on this instance" };
  }
  const meta = new Map(((cap && cap.tools) || []).map((t) => [t.name, t]));
  const res = await probeServerTools(block, { timeoutMs: opts.timeoutMs || 12000 });
  if (!res.ok) return { ok: false, serverId: sid, group, error: res.error };
  const tools = (res.tools || []).map((t) => {
    const m = meta.get(t.name);
    return { ...t, label: (m && m.label) || t.name, subgroup: (m && m.subgroup) || null };
  });
  return { ok: true, serverId: sid, group, inCanonical: !!entry.inCanonical, tools };
}

/**
 * Skill NAMES an extension contributes (bare, .md-stripped). On install the
 * bundle's manifest.skills files are copied into <crowHome>/skills, so these
 * resolve by name via skill_resolver (A3). Reads the capability overlay; an
 * extension with no capability block contributes no skills.
 */
export function extensionSkills(ext) {
  const cap =
    (ext && ext.capabilities) ||
    (typeof ext === "string" ? (capabilityIndex().get(ext) || {}).capabilities : null);
  return ((cap && cap.skills) || []).map((s) =>
    String(s).replace(/.*\//, "").replace(/\.md$/, "")
  );
}

// ---------------------------------------------------------------------------
// A4 — canonical (pi MCP server name) -> voice (gateway category) map.
//
// A bot's def.tools.crow_mcp selections use CANONICAL pi server names (the keys
// of ~/.pi/agent/mcp.json). The glasses fast-voice path (Slice B) advertises
// GATEWAY CATEGORIES (servers/gateway/tool-manifests.js): memory | projects |
// blog | sharing | storage | media. This map is
// the single, explicit bridge between the two vocabularies.
//
// Precision (review finding A4): every server a bot can actually SELECT from
// the canonical mcp.json is enumerated. Servers with NO gateway-category
// in-process factory map to null — Slice B B3/B4 must WARN that those tools are
// unavailable by voice rather than silently drop them. (crow-tasks /
// crow-bots-sql / crow-browser / google-workspace / brave-search / texas-gov-data
// are pi MCP servers or addons with no voice category.) Voice-only categories
// that no canonical server maps to (sharing, media)
// are intentionally absent — this map is one-directional: bot selection
// (canonical) -> voice category. addon ids differ from canonical names
// (e.g. addon `bots-sql-mcp` vs canonical `crow-bots-sql`); both no-voice
// variants are listed so a lookup by either id resolves to "no voice".
// ---------------------------------------------------------------------------
export const CANONICAL_TO_VOICE_CATEGORY = Object.freeze({
  "crow-memory": "memory",
  "crow-projects": "projects",
  "crow-blog": "blog",
  "crow-storage": "storage",
  // No voice equivalent (work under pi, not the fast-voice turn):
  "crow-tasks": null,
  "crow-bots-sql": null,
  "crow-browser": null,
  "google-workspace": null,
  "brave-search": null,
  "texas-gov-data": null,
  // addon-id aliases (mcp-addons.json keys) for the no-voice servers:
  "tasks": null,
  "bots-sql-mcp": null,
});

/**
 * Voice category for a canonical pi server name, or null when none exists.
 * Servers not enumerated at all also return null (treated as no-voice); use
 * isKnownCanonicalServer() to distinguish "known no-voice" from "unknown".
 */
export function voiceCategoryFor(canonicalServer) {
  const v = CANONICAL_TO_VOICE_CATEGORY[canonicalServer];
  return v === undefined ? null : v;
}

/** True iff the server is explicitly enumerated in the map. */
export function isKnownCanonicalServer(canonicalServer) {
  return Object.prototype.hasOwnProperty.call(CANONICAL_TO_VOICE_CATEGORY, canonicalServer);
}

// CLI: `list` (installed extensions + live tool counts) | `available` | `map`
if (import.meta.url === "file://" + process.argv[1]) {
  const cmd = process.argv[2] || "list";
  const crowHome = resolveCrowHome();
  if (cmd === "map") {
    for (const [k, v] of Object.entries(CANONICAL_TO_VOICE_CATEGORY)) {
      console.log(`${k.padEnd(18)} -> ${v == null ? "(no voice equivalent)" : v}`);
    }
    process.exit(0);
  }
  if (cmd === "available") {
    const avail = listAvailableExtensions(crowHome);
    console.log(`crowHome=${crowHome}`);
    console.log(`${avail.length} capability bundle(s) available to install:`);
    for (const b of avail) {
      console.log(
        `  ${b.id.padEnd(16)} [${b.capabilities.group}] curated:${b.capabilities.tools.length} skills:${b.capabilities.skills.join(",") || "-"}`
      );
    }
    process.exit(0);
  }
  const exts = listInstalledExtensions(crowHome);
  console.log(`crowHome=${crowHome}  canonical=${CANONICAL_MCP_PATH}`);
  console.log(`${exts.length} installed extension(s) (mcp-addons.json):`);
  for (const ext of exts) {
    const tooled = await extensionTools(ext, { crowHome });
    const count = tooled.ok ? `${tooled.tools.length} tools` : `probe: ${tooled.error}`;
    const mint = ext.needsMint ? "needs-mint" : "in-canonical";
    const cap = ext.capabilities ? `cap:${ext.group}` : "no-cap";
    console.log(`  ${ext.id.padEnd(16)} ${mint.padEnd(12)} ${cap.padEnd(18)} ${count}`);
  }
  process.exit(0);
}
