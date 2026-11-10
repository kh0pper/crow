/**
 * Bot Builder — the tool sources a bot can draw from, for the Abilities and
 * Safety tabs: every probed MCP server (core Crow servers, canonical extras,
 * installed extensions) with a read/write-classified tool catalog, the bot
 * project's connected services (their tools come from the cache, never a
 * blind probe of the bundle), and the bundles installed on a paired satellite
 * (their tools come from the owner-approved pin, never the satellite).
 */
import { probeAll, probeExtensions, connectedServiceSources } from "./data-queries.js";
import { resolveCrowHome } from "../../../../../scripts/pi-bots/ext_registry.mjs";
import { readCanonicalMcp } from "../../../../../scripts/pi-bots/mcp_writer.mjs";
import { catalogFromProbe, classifyTool, sourceLabel } from "./tool-access.js";
import { t, fill } from "../../shared/i18n.js";
import { getManifest } from "../../../bundles-config.js";
import { installPaths, satelliteInstalls, satelliteBundleIds } from "../../../satellites/installs.js";
import { getReadMarks, getSatellite, getToolPin } from "../../../satellites/store.js";
import { publishedTools } from "../../../satellites/tool-entry.js";
import { hhmm, reportedTools, toolsState } from "../../../satellites/tools-pin.js";

export const MEMORY_SOURCE = "crow-memory";

// Test seam: the live probe spawns every configured MCP server (with real
// credentials on an operator's box) — tests pin the sources instead.
let _override = null;
export function _setSourcesForTest(v) { _override = v; }

/**
 * The tool sources of a bot: probed MCP servers, installed extensions, that project's connected
 * services (one row per service, tools from the cache or a single start), and the bundles
 * installed on a paired satellite (the owner-approved pin's tools, read from crow's own records).
 * @param {{db?:object, projectId?:number|null, crowHome?:string}} [opts]
 * @returns {Promise<{error:string|null, errorCode:string|null, sources:Array<object>}>}
 */
export async function loadSources({ db = null, projectId = null, crowHome = null } = {}) {
  if (_override) return typeof _override === "function" ? _override() : _override;
  const home = crowHome || resolveCrowHome();
  const out = [];
  let error = null;
  let errorCode = null;
  const probe = await probeAll();
  // Operator-set account labels: an optional "account" string on a server's
  // settings entry (~/.pi/agent/mcp.json or <crowHome>/mcp-addons.json).
  let canonical = {};
  try { canonical = readCanonicalMcp().mcpServers || {}; } catch { canonical = {}; }
  const accountOf = (block) => (block && typeof block.account === "string" ? block.account : "");
  if (probe && probe._error) {
    // A missing ~/.pi/agent/mcp.json is a FRESH install, not a failure: there are
    // simply no tools yet, so the page shows an empty state rather than an errno
    // and a file path (audit N5-4). Every other errno/shape stays an error, with
    // its code, so the page can word it plainly.
    errorCode = probe._code ? String(probe._code) : null;
    error = errorCode === "ENOENT" ? null : String(probe._error);
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
        server: ext.id, name: lbl.known ? lbl.name : (ext.group && ext.group !== ext.id ? ext.group : (ext.name || ext.id)), group: ext.group && ext.group !== ext.id ? ext.group : (ext.name || ""), account: lbl.account, accountLabel,
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
  // Satellite-hosted bundles (SAT-7 part C) come last, and only when no local source already took
  // the id (a local install always wins, as it does everywhere else).
  try {
    for (const src of await satelliteSources({ db, crowHome: home })) {
      if (out.some((s) => s.server === src.server)) continue;
      out.push(src);
    }
  } catch { /* satellites are optional */ }
  return { error, errorCode, sources: out };
}

/** A satellite bundle's display name: its manifest's `name` (this checkout's copy), else the id. */
function bundleDisplayName(id) {
  try {
    const m = getManifest(id);
    if (m && typeof m.name === "string" && m.name.trim()) return m.name.trim();
  } catch { /* not in this checkout: the id is still true */ }
  return String(id);
}

/**
 * One tool source per satellite-hosted bundle with an owner-approved pin (SAT-7 part C, spec §9.1,
 * §9.4). `server` is the bundle id — the same key the grants (`<bundle>/<tool>` in
 * def.tools.crow_mcp) and the bot mount use. The catalog is the PINNED list, filtered by the
 * bundle's prefix rule exactly as the part A entry publishes it, and classified with
 * `isSatellite`: every tool is WRITE unless the owner marked that tool read against the pin.
 *
 * Read from crow's own records only (installed.json and the `satellites` / `satellite_tool_pins`
 * tables) — Bot Builder never asks the satellite. No pin, or a revoked satellite, is no row at
 * all: nothing was ever shown to the owner, so there is nothing to grant. An unreachable one
 * keeps its row, not ok, so the owner still sees the bundle and the tools already granted from it.
 * @param {{db?:object, crowHome?:string}} [opts]
 * @returns {Promise<Array<object>>} source rows
 */
export async function satelliteSources({ db = null, crowHome = null } = {}) {
  if (db == null) return [];
  const home = crowHome || resolveCrowHome();
  let installs = [];
  try { installs = satelliteInstalls(installPaths(home)); } catch { return []; }
  if (!installs.length) return [];
  const out = [];
  for (const rec of installs) {
    const id = String(rec?.id || "");
    const host = String(rec?.host || "");
    if (!id || !host) continue;
    let sat = null;
    let pin = null;
    try {
      sat = await getSatellite(db, host);
      pin = sat ? await getToolPin(db, host, id) : null;
    } catch { continue; }
    if (!sat || !pin || sat.status === "revoked") continue;
    let readMarks = [];
    try { readMarks = await getReadMarks(db, host, id); } catch { readMarks = []; }
    const state = toolsState(sat, id, pin);
    const unreachable = state.state === "unreachable";
    // Only a reported, pinned tool list is a working row: "unknown" (never polled) or
    // "unavailable" (no hash reported) would render 0 tools, and "All" on such a row would
    // drop the bot's existing grants for this bundle. Not ok keeps them untouched.
    const usable = state.state === "ok" || state.state === "changed";
    const displayName = bundleDisplayName(id);
    // publishedTools is the one filter of the pinned list (part A): reused, never copied.
    const tools = usable ? publishedTools(id, pin, reportedTools(sat, id)) : [];
    out.push({
      server: id, name: displayName, account: "", accountLabel: "",
      satellite: true, satelliteId: host, satelliteName: sat.name || host,
      bundleName: displayName, readMarks,
      ok: usable,
      // A fixed, short reason: the row shows it verbatim (probe errors are English too).
      error: usable ? undefined
        : unreachable ? `unreachable since ${state.since ? hhmm(state.since) : "?"}`
        : "tools not reported yet",
      catalog: catalogFromProbe(tools, { isSatellite: true, readMarks }),
    });
  }
  return out;
}

/**
 * Bundle id → the pin's read marks, for classifying a granted satellite tool. The Safety tab uses
 * it when the source list itself did not load, so a granted tool never drops off the ask list.
 * @param {object} db
 * @param {string} [crowHome]
 * @returns {Promise<Map<string,string[]>>}
 */
export async function satelliteReadMarks(db, crowHome = null) {
  let rows = [];
  try { rows = await satelliteSources({ db, crowHome }); } catch { rows = []; }
  return satelliteMarksFrom(rows, crowHome);
}

/**
 * Every satellite-installed bundle id → its read marks. Seeded from installed.json with NO
 * marks, so a bundle whose records could not be read (or whose row was skipped) still
 * classifies every tool as write: the ask list fails closed, never back to the name rule.
 */
export function satelliteMarksFrom(rows, crowHome = null) {
  const marks = new Map();
  try { for (const id of satelliteBundleIds(installPaths(crowHome || resolveCrowHome()))) marks.set(id, []); } catch { /* none installed */ }
  for (const r of rows || []) if (r && r.satellite === true) marks.set(r.server, r.readMarks || []);
  return marks;
}

/** A satellite source's label: "Gitea (on <satellite name>)" — it says where the tools run. */
export function satelliteSourceName(src, lang = "en") {
  const name = src.bundleName || src.name || src.server;
  return fill(t("botbuilder.srcSatelliteOn", lang), { name, host: src.satelliteName || src.satelliteId || "" });
}

/** A source's name and account for the viewer's language. */
export function sourceDisplay(src, lang) {
  // A satellite bundle's own name wins over the friendly-name table: two hosts can install the
  // same bundle id, and the label must say which one this row is.
  if (src.satellite === true) return { name: satelliteSourceName(src, lang), account: "" };
  const lbl = sourceLabel(src.server, lang, { account: src.accountLabel || "" });
  // A source's own name wins: an extension's name already falls back to its group, and a
  // connected service's name is its catalog name (not the "services" grouping).
  return { name: lbl.known ? lbl.name : (src.name || src.group || src.server), account: src.account || lbl.account };
}

/**
 * The bot's selected tools that change things: the "Always ask before…" choices on the Safety tab.
 * @param {object} def
 * @param {Object<string, {name:string, access:string}[]>} [catalog]
 * @param {Map<string,string[]>} [satelliteMarks] - bundle id → the pin's read marks
 *   (satelliteReadMarks). A server in this map is a satellite source, so its tools are WRITE
 *   whatever their name says (spec §9.1) — even when its catalog did not load.
 * @returns {{key:string, server:string, name:string}[]}
 */
export function selectedWriteTools(def, catalog = null, satelliteMarks = null) {
  const sel = (def && def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp : [];
  const out = [];
  const seen = new Set();
  const optsFor = (server) => (satelliteMarks && satelliteMarks.has(server)
    ? { isSatellite: true, readMarks: satelliteMarks.get(server) || [] }
    : undefined);
  for (const key of sel) {
    if (typeof key !== "string" || seen.has(key)) continue;
    seen.add(key);
    const i = key.indexOf("/");
    if (i <= 0) continue;
    const server = key.slice(0, i), name = key.slice(i + 1);
    const known = catalog && Array.isArray(catalog[server]) ? catalog[server].find((x) => x.name === name) : null;
    const opts = optsFor(server);
    const access = known
      ? (known.access === "read" && classifyTool({ name }, opts) === "read" ? "read" : "write")
      : classifyTool({ name }, opts);
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
