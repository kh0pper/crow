/**
 * Which Google credential a staged draft was made with, and where its token file is (spec §12.2/§2).
 *
 * A row stores only a reference — `{ server, role }` — never a path. The server is the MCP server the
 * bot's draft tool came through (`mcp__<server>__gmail_create_draft[_personal]`); the role picks the
 * primary or the personal account. At send time the server block is looked up in OPERATOR-OWNED
 * CONFIG only:
 *   - the canonical `~/.pi/agent/mcp.json` (`mcpServers[server].env`), which is what pi bots spawn
 *     with, and
 *   - this instance's `mcp-addons.json` (a flat `{ server: { env } }` map), which is what the
 *     gateway's own add-ons use.
 * A path that came from a bot's own data (its tool args, a session file, a project workspace) is
 * never read: `resolveTokenFile` ignores everything on the ref except server and role.
 *
 * `null` is the honest answer for a server whose block carries no token-file env — the public
 * `workspace-mcp` keeps its token where Crow cannot read it — and the card then says "Open in Gmail
 * to send" instead of guessing.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveCrowHome } from "../../shared/crow-home.js";

/** The env key each role's token file comes from (google-workspace-mcp's own two-account naming). */
export const TOKEN_ENV_BY_ROLE = Object.freeze({
  primary: "GOOGLE_TOKEN_FILE",
  personal: "GOOGLE_PERSONAL_TOKEN_FILE",
});

const TOOL_PREFIX = /^mcp__([A-Za-z0-9][A-Za-z0-9._-]*)__/;
const PERSONAL_SUFFIX = /_personal$/;

/** `mcpConfigPath` defaults to the canonical pi file; overridable so a test never reads the host's. */
export function canonicalMcpPath() {
  return join(process.env.HOME || homedir(), ".pi", "agent", "mcp.json");
}

export function mcpAddonsPath() {
  return join(resolveCrowHome(), "mcp-addons.json");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // absent or unreadable config is "no credential", never a throw at send time
  }
}

/** The block for `server` in a world config: `{mcpServers:{...}}` (pi) or a flat `{server:{...}}`. */
function blockFor(mcpConfig, server) {
  if (!mcpConfig || typeof mcpConfig !== "object") return null;
  const servers = mcpConfig.mcpServers && typeof mcpConfig.mcpServers === "object" ? mcpConfig.mcpServers : mcpConfig;
  const block = servers[server];
  if (!block || typeof block !== "object" || block.disabled) return null;
  return block;
}

/**
 * The credential reference for a draft tool call, or null when Crow cannot read that server's
 * credential. `"personal"` is the `_personal` tool suffix, otherwise `"primary"` — and the role's
 * own env key must be present on the server's block, or there is nothing to resolve later.
 */
export function credRefFromWorld(mcpConfig, toolName) {
  const m = TOOL_PREFIX.exec(String(toolName ?? ""));
  if (!m) return null;
  const server = m[1];
  const role = PERSONAL_SUFFIX.test(String(toolName)) ? "personal" : "primary";
  const block = blockFor(mcpConfig, server);
  const env = block && block.env;
  if (!env || typeof env !== "object") return null;
  const value = env[TOKEN_ENV_BY_ROLE[role]];
  if (typeof value !== "string" || !value.trim()) return null;
  return { server, role };
}

/** `~/x` -> `<home>/x`; anything else is left for the absolute-path check. */
function expandHome(path) {
  if (path === "~") return process.env.HOME || homedir();
  if (path.startsWith("~/")) return join(process.env.HOME || homedir(), path.slice(2));
  return path;
}

/**
 * The token file for a credential reference, read from operator config only, or null. Canonical
 * `mcp.json` wins over `mcp-addons.json` (a pi bot's world is minted from canonical; the gateway
 * add-on is the fallback). Only an absolute path is accepted: a relative one would resolve against
 * whatever cwd the gateway happens to have.
 *
 * `paths` is the test seam ({ canonical, addons }); production reads the two real locations.
 */
export function resolveTokenFile(credRef, paths = {}) {
  if (!credRef || typeof credRef !== "object") return null;
  const { server, role } = credRef;
  const key = TOKEN_ENV_BY_ROLE[role];
  if (!key || typeof server !== "string" || !server) return null;

  const canonical = paths.canonical || canonicalMcpPath();
  const addons = paths.addons || mcpAddonsPath();
  // Both operator files can name the same server id with DIFFERENT token files
  // (the canonical config and the gateway add-on, two Google accounts). A
  // {server, role} ref cannot say which one made the draft, and sending from the
  // wrong account is never acceptable: an ambiguous ref resolves to nothing, and
  // the card falls back to "Open in Gmail to send".
  const found = new Set();
  for (const block of [blockFor(readJson(canonical), server), blockFor(readJson(addons), server)]) {
    const value = block && block.env && block.env[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const path = expandHome(value.trim());
    if (isAbsolute(path)) found.add(path);
  }
  return found.size === 1 ? [...found][0] : null;
}