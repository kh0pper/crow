/**
 * Bot Builder — the tool sources a bot can draw from, for the Abilities and
 * Safety tabs: every probed MCP server (core Crow servers, canonical extras,
 * installed extensions) with a read/write-classified tool catalog, plus the
 * bot project's connected services (their tools come from the cache, never a
 * blind probe of the bundle).
 */
import { probeAll, probeExtensions, connectedServiceSources } from "./data-queries.js";
import { resolveCrowHome } from "../../../../../scripts/pi-bots/ext_registry.mjs";
import { readCanonicalMcp } from "../../../../../scripts/pi-bots/mcp_writer.mjs";
import { catalogFromProbe, classifyTool, sourceLabel } from "./tool-access.js";

export const MEMORY_SOURCE = "crow-memory";

// Test seam: the live probe spawns every configured MCP server (with real
// credentials on an operator's box) — tests pin the sources instead.
let _override = null;
export function _setSourcesForTest(v) { _override = v; }

/**
 * The tool sources of a bot: probed MCP servers, installed extensions, and — for a bot in a
 * project — that project's connected services (one row per service, tools from the cache or a
 * single start).
 * @param {{db?:object, projectId?:number|null, crowHome?:string}} [opts]
 * @returns {Promise<{error:string|null, sources:Array<object>}>}
 */
export async function loadSources({ db = null, projectId = null, crowHome = null } = {}) {
  if (_override) return typeof _override === "function" ? _override() : _override;
  const home = crowHome || resolveCrowHome();
  const out = [];
  let error = null;
  const probe = await probeAll();
  // Operator-set account labels: an optional "account" string on a server's
  // settings entry (~/.pi/agent/mcp.json or <crowHome>/mcp-addons.json).
  let canonical = {};
  try { canonical = readCanonicalMcp().mcpServers || {}; } catch { canonical = {}; }
  const accountOf = (block) => (block && typeof block.account === "string" ? block.account : "");
  if (probe && probe._error) {
    error = String(probe._error);
  } else {
    for (const server of Object.keys(probe || {}).sort()) {
      const p = probe[server];
      const accountLabel = accountOf(canonical[server]);
      const lbl = sourceLabel(server, "en", { account: accountLabel });
      out.push({
        server, name: lbl.name, account: lbl.account, accountLabel,
        ok: !!(p && p.ok), error: p && !p.ok ? String(p.error || "") : undefined,
        catalog: p && p.ok ? catalogFromProbe(p.tools) : [],
      });
    }
  }
  try {
    for (const { ext, probe: ep } of await probeExtensions(home)) {
      const accountLabel = accountOf(ext.block) || accountOf(canonical[ext.id]);
      const lbl = sourceLabel(ext.id, "en", { account: accountLabel });
      out.push({
        server: ext.id, name: lbl.known ? lbl.name : (ext.group || ext.id), group: ext.group || "", account: lbl.account, accountLabel,
        ok: !!(ep && ep.ok), error: ep && !ep.ok ? String(ep.error || "") : undefined,
        catalog: ep && ep.ok ? catalogFromProbe(ep.tools) : [],
      });
    }
  } catch { /* extensions are optional */ }
  if (db != null && projectId != null) {
    try {
      // One start budget for the whole page: a service's child starts at most once.
      const connected = await connectedServiceSources({ db, projectId, crowHome: home, started: new Set() });
      for (const src of connected) {
        out.push({
          server: src.server, name: src.name, group: src.group, connected: true,
          ok: src.ok, error: undefined, privateOnly: src.privateOnly,
          catalog: catalogFromProbe(src.tools), accountLabel: "",
        });
      }
    } catch { /* services are optional */ }
  }
  return { error, sources: out };
}

/**
 * The bot's selected tools that change things: the "Always ask before…"
 * choices on the Safety tab. Uses the same classification as the Abilities
 * tab: a source's probed catalog when given (annotations can only narrow),
 * else the name rule.
 * @param {object} def
 * @param {Object<string, {name:string, access:string}[]>} [catalog]
 * @returns {{key:string, server:string, name:string}[]}
 */
/** A source's name and account for the viewer's language. */
export function sourceDisplay(src, lang) {
  const lbl = sourceLabel(src.server, lang, { account: src.accountLabel || "" });
  // A source's own name wins: an extension's name already falls back to its group, and a
  // connected service's name is its catalog name (not the "services" grouping).
  return { name: lbl.known ? lbl.name : (src.name || src.group || src.server), account: src.account || lbl.account };
}

export function selectedWriteTools(def, catalog = null) {
  const sel = (def && def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp : [];
  const out = [];
  const seen = new Set();
  for (const key of sel) {
    if (typeof key !== "string" || seen.has(key)) continue;
    seen.add(key);
    const i = key.indexOf("/");
    if (i <= 0) continue;
    const server = key.slice(0, i), name = key.slice(i + 1);
    const known = catalog && Array.isArray(catalog[server]) ? catalog[server].find((x) => x.name === name) : null;
    const access = known ? (known.access === "read" && classifyTool({ name }) === "read" ? "read" : "write") : classifyTool({ name });
    if (access === "write") out.push({ key, server, name });
  }
  return out;
}

/** Rebuild the offered tools from the keys a Safety form was rendered with. */
export function toolsFromKeys(keys, def) {
  const sel = new Set((def && def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp.filter((k) => typeof k === "string") : []);
  const out = [];
  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key !== "string" || !sel.has(key)) continue;
    const i = key.indexOf("/");
    if (i <= 0) continue;
    out.push({ key, server: key.slice(0, i), name: key.slice(i + 1) });
  }
  return out;
}
