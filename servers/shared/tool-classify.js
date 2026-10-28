/**
 * The one read/write classifier for MCP tool names (moved from
 * servers/gateway/dashboard/panels/bot-builder/tool-access.js so the
 * skill-tools union in scripts/pi-bots/skill-tools.mjs uses the same rule
 * as Bot Builder's Read-only mode).
 *
 * A name rule decides, and a name it does not recognise counts as WRITE —
 * "Read-only" never grants a tool it cannot vouch for. MCP annotations
 * (readOnlyHint / destructiveHint) can only narrow.
 *
 * No imports: the pi-bots scripts load it too.
 */

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
  // "fetch" reads like a lookup, but it re-fetches the page and writes the
  // source row (servers/research)
  "crow_fetch_source",
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
 * The rule with its reason kept: "write" when a rule says the tool changes
 * things, "read" when only lookup words match, "unknown" when nothing
 * matches (classifyTool counts that as write).
 * @param {{name?:string, readOnlyHint?:boolean, destructiveHint?:boolean}} tool
 * @returns {"read"|"write"|"unknown"}
 */
export function classifyToolDetail(tool) {
  const t = tool || {};
  // MCP annotations are untrusted hints from the server: they may only
  // NARROW. A server can mark a tool as changing things; it can never turn a
  // tool the name rule calls "changes things" (or does not recognise) into a
  // read. readOnlyHint:true therefore adds nothing over the name rule.
  if (t.destructiveHint === true || t.readOnlyHint === false) return "write";
  if (WRITE_NAMES.has(String(t.name || ""))) return "write";
  const toks = tokens(t.name);
  if (!toks.length) return "unknown";
  if (toks.some((x) => WRITE_TOKENS.has(x))) return "write";
  if (toks.some((x) => READ_TOKENS.has(x))) return "read";
  return "unknown";
}

/**
 * @param {{name?:string, readOnlyHint?:boolean, destructiveHint?:boolean}} tool
 * @returns {"read"|"write"} a name the rule does not recognise is "write"
 */
export function classifyTool(tool) {
  return classifyToolDetail(tool) === "read" ? "read" : "write";
}
