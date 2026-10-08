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

// Any of these tokens in a tool name means it changes something.
const WRITE_TOKENS = new Set([
  "create", "update", "delete", "send", "write", "set", "add", "remove", "move", "rename",
  "share", "upload", "trash", "archive", "publish", "unpublish", "apply", "resolve", "reply",
  "insert", "append", "replace", "format", "edit", "transfer", "store", "dismiss", "complete",
  "respond", "sync", "run", "click", "fill", "evaluate", "download", "export", "import",
  "copy", "duplicate", "reorder", "rewrite", "batch", "label", "mark", "react", "revoke",
  "accept", "register", "invite", "crosspost", "patch", "put", "save", "load",
  "launch", "block", "transpose", "regenerate", "generate", "approve",
  "reject", "cancel", "start", "stop", "restart", "install", "uninstall", "enable", "disable",
  "assign", "attach", "verify", "close", "open", "dream", "forward",
  "spam", "untrash", "unlabel", "unmark",
  // looks harmless, changes or shares something: a display shows text
  // ("show"), a list gains an entry ("want"), a link is minted ("url"), and a
  // logged-in browser that navigates, scrolls, paginates (clicks "next") or
  // fetches a page acts on the web
  "show", "want", "url", "navigate", "scroll", "paginate", "scrape", "wait",
  // common changing verbs: a name that mixes one of these with a lookup word
  // ("get_reset_status") still counts as changing things
  "purge", "execute", "exec", "reset", "clear", "kill", "drop", "wipe", "grant",
  "deploy", "merge", "push", "post", "submit", "pay", "order", "book", "trigger",
  "call", "dial", "sms", "notify", "rotate", "restore", "commit", "rollback", "flush",
  "terminate", "suspend", "resume", "lock", "unlock", "ban", "mute", "follow", "unfollow",
  "like", "vote", "rsvp", "checkout", "refund", "charge", "mint", "sign", "release",
]);

// Tools whose names read like lookups but whose source shows they change
// state (verified against each tool's code). Always "changes things".
const WRITE_NAMES = new Set([
  "crow_kiosk_show", "crow_kavita_want_to_read", "crow_calibreweb_reading_status",
  "crow_browser_paginate", "crow_browser_navigate", "crow_get_file_url",
]);

// Otherwise, any of these tokens means it only looks.
const READ_TOKENS = new Set([
  "get", "list", "search", "read", "find", "recall", "stats", "status", "check", "view",
  "describe", "inspect", "fetch", "lookup", "extract", "screenshot",
  "guide", "discover", "structure", "tabs",
  "metadata", "permissions", "info", "count", "preview",
]);

function tokens(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * @param {{name?:string, readOnlyHint?:boolean, destructiveHint?:boolean}} tool
 * @returns {"read"|"write"}
 */
export function classifyTool(tool) {
  const t = tool || {};
  // MCP annotations are untrusted hints from the server: they may only
  // NARROW. A server can mark a tool as changing things; it can never turn a
  // tool the name rule calls "changes things" (or does not recognise) into a
  // read. readOnlyHint:true therefore adds nothing over the name rule.
  if (t.destructiveHint === true || t.readOnlyHint === false) return "write";
  if (WRITE_NAMES.has(String(t.name || ""))) return "write";
  const toks = tokens(t.name);
  if (!toks.length) return "write";
  if (toks.some((x) => WRITE_TOKENS.has(x))) return "write";
  if (toks.some((x) => READ_TOKENS.has(x))) return "read";
  return "write";
}

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
  if (reads.length && reads.length < all.length && mine.size === reads.length && reads.every((n) => mine.has(n))) return "read";
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
