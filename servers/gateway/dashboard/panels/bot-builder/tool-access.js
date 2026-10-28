/**
 * Bot Builder — tool sources and their read/write classification.
 *
 * The Abilities tab shows one row per tool SOURCE (an MCP server) with the
 * modes Off / Read-only / All / Custom. The mode is DERIVED from the stored
 * selection (def.tools.crow_mcp, "server/tool" keys) against the live tool
 * catalog — it is never stored on its own, so it cannot drift from what the
 * bot actually runs with. A tool the server adds later is not granted by an
 * earlier "All": the row then honestly reads Custom until the operator
 * chooses again.
 *
 * Read/write: a name rule decides, and a name it does not recognise counts
 * as WRITE — "Read-only" never grants a tool it cannot vouch for. MCP tool
 * annotations (readOnlyHint / destructiveHint, carried by the probe) can
 * only narrow: a server may mark a tool as changing things, never the
 * reverse (annotations are untrusted hints).
 */

import { t } from "../../shared/i18n.js";

// The read/write name rule lives in servers/shared/tool-classify.js, shared
// with the skill-tools union (scripts/pi-bots/skill-tools.mjs), so Bot
// Builder's Read-only and the union's read mode can never disagree.
import { classifyTool, LEGACY_READ } from "../../../../shared/tool-classify.js";
export { classifyTool };

/** Names (no server prefix) of the read-class tools in a catalog. */
export function readToolNames(catalog) {
  return (catalog || []).filter((t) => t.access === "read").map((t) => t.name);
}

/**
 * Derive a source's mode from the stored selection.
 * @param {string} server
 * @param {string[]} selected - def.tools.crow_mcp ("server/tool" keys)
 * @param {{name:string, access:"read"|"write"}[]} catalog - this source's tools
 * @returns {"off"|"read"|"all"|"custom"}
 */
export function sourceMode(server, selected, catalog) {
  const prefix = server + "/";
  const mine = new Set((selected || []).filter((k) => typeof k === "string" && k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  if (mine.size === 0) return "off";
  const all = (catalog || []).map((t) => t.name);
  const known = new Set(all);
  for (const n of mine) if (!known.has(n)) return "custom";
  if (mine.size === all.length) return "all";
  const reads = readToolNames(catalog);
  // a Read-only selection saved before a LEGACY_READ tool (crow_fetch_source)
  // became write still stores it: it reads Read-only, not Custom
  const writes = new Set((catalog || []).filter((t) => t.access !== "read").map((t) => t.name));
  const picked = new Set([...mine].filter((n) => !(LEGACY_READ.has(n) && writes.has(n))));
  if (reads.length && reads.length < all.length && picked.size === reads.length && reads.every((n) => picked.has(n))) return "read";
  return "custom";
}

/** Concrete "server/tool" keys for a non-custom mode. */
export function expandSourceMode(server, mode, catalog) {
  const cat = catalog || [];
  if (mode === "all") return cat.map((t) => `${server}/${t.name}`);
  if (mode === "read") return cat.filter((t) => t.access === "read").map((t) => `${server}/${t.name}`);
  return [];
}

// Friendly names for the sources an operator meets most: Crow's own servers
// are translated (i18n key), product names are shown as they are. Anything
// else shows its server name.
const SOURCE_NAMES = {
  "crow-memory": { key: "botbuilder.srcCrowMemory" },
  "crow-projects": { key: "botbuilder.srcCrowProjects" },
  "crow-sharing": { key: "botbuilder.srcCrowSharing" },
  "crow-blog": { key: "botbuilder.srcCrowBlog" },
  "crow-storage": { key: "botbuilder.srcCrowFiles" },
  "crow-tasks": { key: "botbuilder.srcCrowTasks" },
  "crow-bots-sql": { key: "botbuilder.srcCrowBotData" },
  "browser": { key: "botbuilder.srcBrowser" },
  "crow-browser": { key: "botbuilder.srcBrowser" },
  "phone": { key: "botbuilder.srcPhone" },
  "google-workspace": { brand: "Google Workspace" },
  "brave-search": { brand: "Brave Search" },
  "monday": { brand: "monday.com" },
  "trello": { brand: "Trello" },
};

/**
 * @param {string} server
 * @param {string} [lang]
 * @param {{account?: string}} [opts] - an operator-set account label from the
 *   server's settings entry (mcp.json / mcp-addons.json "account"); without one,
 *   a server that is one of several instances of a known source shows its
 *   server name as the account.
 * @returns {{name:string, account:string, known:boolean}}
 */
export function sourceLabel(server, lang = "en", opts = {}) {
  const s = String(server || "");
  const label = typeof opts.account === "string" ? opts.account.trim().slice(0, 80) : "";
  const nameOf = (e) => (e.brand ? e.brand : t(e.key, lang));
  if (SOURCE_NAMES[s]) return { name: nameOf(SOURCE_NAMES[s]), account: label, known: true };
  // longest known base that prefixes the name with a "-" separator
  const bases = Object.keys(SOURCE_NAMES).filter((b) => s.startsWith(b + "-")).sort((a, b) => b.length - a.length);
  if (bases.length) return { name: nameOf(SOURCE_NAMES[bases[0]]), account: label || s, known: true };
  return { name: s, account: label, known: false };
}

/** Attach access to probed tools: [{name, readOnlyHint?, destructiveHint?}] -> [{name, access}] */
export function catalogFromProbe(tools) {
  return (tools || []).filter((t) => t && t.name).map((t) => ({ name: t.name, access: classifyTool(t), label: t.label || "" }));
}
