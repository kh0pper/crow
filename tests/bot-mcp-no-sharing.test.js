// No bot's generated MCP config contains the stdio `crow-sharing` server —
// in either delivery mode, whatever the def asks for and whatever the
// operator's own canonical ~/.pi/agent/mcp.json carries (item: bots never read
// Crow's identity file).
//
// Since servers/shared/bot-owner-only refuses every sharing tool to a bot (all
// but crow_list_crosspost_transforms), a bot's config that named it could only
// fail calls. The block is now dropped for bots and the REGISTRY entry stays
// exactly as it is for the operator's own `npm run mcp-config` output. A def
// that still lists crow-sharing tools must not break the spawn: the config
// carries {"disabled": true} and the tools are simply absent.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOT_EXCLUDED_SERVERS, isBotExcludedServer, crowServerCatalog, instanceBinding } from "../scripts/pi-bots/crow-server-catalog.mjs";
import { buildBotMcp, writeBotMcp, serversForBot } from "../scripts/pi-bots/mcp_writer.mjs";
import { CORE_SERVERS, CONDITIONAL_SERVERS } from "../scripts/server-registry.js";

const T = mkdtempSync(join(tmpdir(), "crow-no-sharing-"));
after(() => rmSync(T, { recursive: true, force: true }));

const CROW_HOME = join(T, ".crow-z");
mkdirSync(join(CROW_HOME, "data"), { recursive: true });

/** The operator's canonical config: it DOES have crow-sharing (npm run mcp-config). */
const CANONICAL = {
  mcpServers: {
    "crow-sharing": { command: "node", args: ["servers/sharing/index.js"], env: { CROW_DB_PATH: "/somewhere/crow.db" } },
    "some-third-party": { command: "node", args: ["srv.js"] },
  },
};

/** A bot def that still names crow-sharing tools (a stored def from before this change). */
const DEF = {
  bot_id: "old-bot",
  session_dir: join(T, "sessions", "old-bot"),
  tools: { pi_builtin: ["read"], crow_mcp: ["crow-sharing/list_invites", "crow-sharing__get_identity", "crow-sharing"] },
  permission_policy: { bash: "deny", write_paths: [], read_paths: [] },
};

test("the catalog never offers crow-sharing to a bot, but the registry entry is kept", () => {
  const { servers, coreNames } = crowServerCatalog(CROW_HOME, { binding: instanceBinding(CROW_HOME) });
  assert.equal(servers["crow-sharing"], undefined, "no crow-sharing block in a bot catalog");
  assert.ok(!coreNames.includes("crow-sharing"), "not offered in the Bot Builder either");
  assert.ok(servers["crow-memory"], "the rest of the core servers are still there");
  // The operator's own generated config is built from the REGISTRY, which is untouched.
  const registryNames = [...CORE_SERVERS, ...CONDITIONAL_SERVERS].map((s) => s.name);
  assert.ok(registryNames.includes("crow-sharing"), "the registry entry stays for non-bot use");
  assert.deepEqual([...BOT_EXCLUDED_SERVERS], ["crow-sharing"]);
  assert.equal(isBotExcludedServer("crow-sharing"), true);
  assert.equal(isBotExcludedServer("crow-memory"), false);
  assert.equal(isBotExcludedServer(undefined), false);
});

test("buildBotMcp disables crow-sharing even when the operator's canonical file carries it", () => {
  const { servers: catalog, unconfigured } = crowServerCatalog(CROW_HOME, { binding: instanceBinding(CROW_HOME) });
  const built = buildBotMcp(DEF, CANONICAL, {
    catalog, unconfigured, binding: instanceBinding(CROW_HOME), crowHome: CROW_HOME,
    interactive: true,
  });
  assert.deepEqual(built.json.mcpServers["crow-sharing"], { disabled: true }, "a disabled block, not an active one");
  // The `__` spelling pi registers a tool under is excluded too.
  assert.deepEqual(built.json.mcpServers["crow-sharing__get_identity"], { disabled: true });
  assert.ok(!built.servers.includes("crow-sharing"), "not in the active list");
  assert.ok(built.warnings.some((w) => /crow-sharing.*not available to bots/.test(w)), built.warnings.join(" | "));
  // The server name both spellings reduce to is the one the catalog knows.
  assert.deepEqual(serversForBot(DEF).sort(), ["crow-sharing", "crow-sharing__get_identity"]);
  assert.equal(isBotExcludedServer("crow-sharing/list_invites"), true, "a per-tool spelling is the same server");
  assert.equal(isBotExcludedServer("crow-sharing__get_identity"), true, "the pi tool spelling too");
});

test("a written .mcp.json for a sharing-naming bot has no active crow-sharing block and never execs servers/sharing", () => {
  const res = writeBotMcp(DEF, {
    canonical: CANONICAL, crowHome: CROW_HOME, binding: instanceBinding(CROW_HOME),
    sessionDir: DEF.session_dir, write: true,
  });
  const written = JSON.parse(readFileSync(join(DEF.session_dir, ".mcp.json"), "utf8"));
  assert.equal(written.mcpServers["crow-sharing"].disabled, true);
  for (const [name, block] of Object.entries(written.mcpServers)) {
    if (!block || typeof block !== "object" || block.disabled) continue;
    const argv = [block.command, ...(block.args || []), block.cwd].map((x) => String(x || ""));
    assert.ok(!argv.some((a) => /servers\/sharing\b/.test(a)), name + " must not exec the sharing server");
  }
  assert.ok(!res.servers.includes("crow-sharing"), "the writer's active list agrees");
  assert.equal(res.path, join(DEF.session_dir, ".mcp.json"));
});

test("fd delivery (write: false) returns the same closed-world config and writes no file", () => {
  const other = { ...DEF, session_dir: join(T, "sessions", "fd-bot") };
  const res = writeBotMcp(other, {
    canonical: CANONICAL, crowHome: CROW_HOME, binding: instanceBinding(CROW_HOME),
    sessionDir: other.session_dir, write: false,
  });
  assert.equal(res.path, null);
  assert.equal(res.json.mcpServers["crow-sharing"].disabled, true);
});