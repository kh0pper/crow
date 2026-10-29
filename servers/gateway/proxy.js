/**
 * MCP Proxy — Spawns external MCP servers and re-exposes their tools.
 *
 * Pattern: For each configured integration with valid env vars, spawn it as a
 * child process, connect via StdioClientTransport, discover its tools, and
 * register proxy tools on a combined McpServer that the gateway serves over HTTP.
 */

import { resolveAddonCommand, checkLauncherArgs } from "../shared/resolve-command.js";
import { spawn } from "node:child_process";
import { resolveCrowHome as resolveSharedCrowHome } from "../shared/crow-home.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchemaToZodObject, SOURCE_BUDGET } from "../shared/json-schema-to-zod.js";
import { sortedServers, sortedByName } from "../shared/stable-order.js";
import { legacyEnvSources, isLegacyConfiguredAddon, legacyIntegrationsView, addonDerivedEnv } from "./services/legacy-sources.js";
import { createDbClient } from "../db.js";
import { isApproved, hasApproval, verifyBackendLaunch, backendEnv, parseStoredSpec, prepareSpawn, PENDING_STATUS } from "../shared/data-backend-approval.js";
import { createGoogleOAuthProvider } from "../shared/oauth-client-provider.js";
import { livenessStatusSql } from "../shared/instance-status.js";
import { recordPeerProbe } from "./peer-probe-health.js";
import bus from "../shared/event-bus.js";
import { rowIsTrusted } from "../shared/peer-trust.js";
import { peerActorMeta, remoteBotActorAllowed } from "../shared/peer-label.js";

/** GET <gatewayUrl>/health with a 5 s cap; throws on non-2xx or timeout. */
async function probePeerHealth(gatewayUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${gatewayUrl}/health`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Health check returned ${resp.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

// Track connected servers for health checks and router access
const connectedServers = new Map(); // id → { client, process, tools }
export { connectedServers };

/** Drop the federated MCP client for a remote instance (revoke teardown). */
export function dropRemoteInstance(instanceId) {
  const key = `instance-${instanceId}`;
  const entry = connectedServers.get(key);
  if (!entry) return false;
  connectedServers.delete(key);
  try { entry.client?.close?.(); } catch {}
  return true;
}

// Revoke teardown (review C1): an in-process revoke drops the peer's live
// federated client at once. A revoke from another process is caught by the
// 60 s probe below, which drops connections for rows no longer probed.
bus.on("crow_instances:row_updated", (evt) => {
  try {
    if (evt?.fields?.status === "revoked" && evt.id) dropRemoteInstance(evt.id);
  } catch {}
});

/**
 * Resolve the Crow instance home directory. Primary gateway leaves this
 * unset and falls back to ~/.crow; alternate instances (MPA, etc.) set
 * CROW_HOME in their systemd env so bundle installs, mcp-addons.json, and
 * skills/panels stay per-instance instead of bleeding into primary's state.
 */
export function resolveCrowHome() {
  return resolveSharedCrowHome();
}

/** The listed vars that are set in the gateway's environment. */
function envFromVars(vars = []) {
  const env = {};
  for (const v of vars) if (process.env[v]) env[v] = process.env[v];
  return env;
}

/**
 * Spawn a single external server, connect, and discover its tools.
 * `integration.env` (a legacy source) is the child's own vars; otherwise the
 * listed `envVars` are read from the gateway's environment (data backends).
 * Returns { client, childProcess, tools } or null on failure.
 */
async function connectToServer(integration) {
  const spawnEnv = integration.env || envFromVars(integration.envVars);
  // A data backend brings its own allowlisted base env (never the gateway's
  // whole environment); built-in integrations keep the old behaviour.
  const env = {
    ...(integration.baseEnv || process.env),
    ...spawnEnv,
  };

  let command = integration.command;
  let args = integration.args;

  // Data backends: the last check runs here, synchronously, with no await
  // between it and the spawn inside client.connect() below.
  if (integration.preSpawn) {
    const ready = integration.preSpawn();
    if (!ready || !ready.ok) {
      console.warn(`  [proxy] ${integration.name}: not started — ${ready ? ready.reason : "pre-spawn check failed"}`);
      return null;
    }
    command = ready.command;
    args = ready.args;
  }

  // Timeout: npx/uvx may need to download packages on first run
  const CONNECT_TIMEOUT_MS = 60_000;

  try {
    const transport = new StdioClientTransport({
      command,
      args,
      env,
    });

    const client = new Client({
      name: `crow-proxy-${integration.id}`,
      version: "0.1.0",
    });

    // Race the connection against a timeout
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out (60s)")), CONNECT_TIMEOUT_MS).unref()
      ),
    ]);

    // Discover tools
    const { tools } = await client.listTools();

    console.log(`  [proxy] ${integration.name}: connected, ${tools.length} tools discovered`);

    connectedServers.set(integration.id, {
      client,
      tools,
      status: "connected",
    });

    // Handle unexpected disconnection
    transport.onclose = () => {
      console.warn(`  [proxy] ${integration.name}: disconnected`);
      const entry = connectedServers.get(integration.id);
      if (entry) entry.status = "disconnected";
    };

    return { client, tools };
  } catch (error) {
    console.error(`  [proxy] ${integration.name}: failed to connect — ${error.message}`);
    connectedServers.set(integration.id, {
      client: null,
      tools: [],
      status: "error",
      error: error.message,
    });
    return null;
  }
}

/**
 * The environment of a bundle add-on's stdio child started BY THE GATEWAY. `CROW_ADDON_HOST=gateway`
 * marks the one long-lived copy the gateway supervises, so an add-on can keep background work
 * (schedules, polling) out of the short-lived private copies that bots and other MCP clients start
 * from the same mcp-addons.json entry. Set last: an add-on's own env cannot claim or drop it.
 * With an `id`, a service add-on also gets its manifest's derived env (e.g. Render's AUTH_HEADER),
 * rendered from `config.env` over `base`.
 */
export function addonStdioEnv(config = {}, base = process.env, id = null) {
  const derived = id ? addonDerivedEnv(id, config.env, undefined, base) : {};
  return { ...base, ...(config.env || {}), ...derived, CROW_ADDON_HOST: "gateway" };
}

/**
 * Whether the add-on running from `cwd` understands a peer's remote bot actor (item 46 PR-B): its own
 * manifest.json says Workspace at or above the version in REMOTE_BOT_ACTOR_MIN. Read once at connect; any
 * read or parse failure is false, so the add-on keeps getting the "Crow (via <name>)" peer form.
 */
export function remoteBotActorForCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return false;
  try { return remoteBotActorAllowed(JSON.parse(readFileSync(join(cwd, "manifest.json"), "utf8"))); }
  catch { return false; }
}

/**
 * Connect to an MCP server installed as a bundle addon (from ~/.crow/mcp-addons.json).
 * Unlike connectToServer(), this takes the add-on entry's flat env dict.
 */
async function connectAddonServer(id, config) {
  const CONNECT_TIMEOUT_MS = 60_000;
  const transportMode = (config.transport || "stdio").toLowerCase();

  try {
    let transport;
    // Only a stdio add-on whose own manifest opts in gets the remote bot form; HTTP add-ons never do.
    let remoteBotActor = false;
    if (transportMode === "http") {
      // Remote HTTP MCP server (e.g. Google's gmailmcp.googleapis.com).
      // OAuth flow is handled by the SDK via authProvider; see
      // shared/oauth-client-provider.js for the token file shape.
      if (!config.url) {
        throw new Error(`addon ${id}: transport=http requires a "url" field`);
      }
      let authProvider;
      if (config.oauth) {
        const { credentials_file, token_file, scopes } = config.oauth;
        if (!credentials_file || !token_file || !Array.isArray(scopes)) {
          throw new Error(
            `addon ${id}: oauth block requires credentials_file, token_file, scopes[]`,
          );
        }
        authProvider = createGoogleOAuthProvider({
          credentialsFile: credentials_file,
          tokenFile: token_file,
          scopes,
          label: id,
        });
      }
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider,
      });
    } else {
      // stdio (default, backward-compatible)
      const cwd = config.cwd || join(resolveCrowHome(), "bundles", id);
      const env = addonStdioEnv(config, process.env, id);
      remoteBotActor = remoteBotActorForCwd(cwd);
      // Bare command names (uvx, uv, npx) resolve against the gateway PATH,
      // then the per-user install dirs systemd's PATH lacks.
      const rc = resolveAddonCommand(config.command, { sha256: config.command_sha256, cwd });
      const argProblem = rc.missing ? null : checkLauncherArgs(rc.command, config.args);
      if (argProblem) throw new Error(`command '${config.command}' not usable: ${argProblem}`);
      if (rc.missing) {
        throw new Error(`command '${config.command}' not usable: ${rc.reason || "not found"} (searched the gateway PATH, ~/.local/bin, ~/.cargo/bin, ~/bin, /usr/local/bin)`);
      }
      transport = new StdioClientTransport({
        command: rc.command,
        args: config.args || [],
        env,
        cwd,
      });
    }

    const client = new Client({
      name: `crow-addon-${id}`,
      version: "0.1.0",
    });

    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out (60s)")), CONNECT_TIMEOUT_MS).unref()
      ),
    ]);

    const { tools } = await client.listTools();

    console.log(`  [proxy] addon ${id}: connected, ${tools.length} tools discovered`);

    connectedServers.set(id, {
      client,
      tools,
      status: "connected",
      isAddon: true,
      remoteBotActor,
    });

    transport.onclose = () => {
      console.warn(`  [proxy] addon ${id}: disconnected`);
      const entry = connectedServers.get(id);
      if (entry) entry.status = "disconnected";
    };

    return { client, tools };
  } catch (error) {
    console.error(`  [proxy] addon ${id}: failed to connect — ${error.message}`);
    connectedServers.set(id, {
      client: null,
      tools: [],
      status: "error",
      error: error.message,
      isAddon: true,
    });
    return null;
  }
}

/**
 * Disconnect an addon server (for clean uninstall).
 */
export async function disconnectAddonServer(id) {
  const entry = connectedServers.get(id);
  if (entry && entry.client) {
    try { await entry.client.close(); } catch {}
  }
  connectedServers.delete(id);
}

/**
 * Gracefully shut down all connected proxy servers.
 * Closes each MCP client, which terminates the child process via the SDK's
 * StdioClientTransport.close() (stdin.end → SIGTERM → SIGKILL escalation).
 */
export async function shutdownAll() {
  const entries = [...connectedServers.entries()];
  await Promise.allSettled(
    entries.map(async ([id, entry]) => {
      if (entry.client) {
        try { await entry.client.close(); } catch {}
      }
    })
  );
  connectedServers.clear();
}

/**
 * Kill stale addon server processes left over from a previous gateway instance.
 * Finds node processes whose cwd is in ~/.crow/bundles/ and whose parent is
 * NOT the current gateway (i.e., orphans from a crash or restart).
 */
function cleanupStaleAddonProcesses() {
  let cleaned = 0;
  try {
    const bundleDir = join(resolveCrowHome(), "bundles");
    // Match "node server/index.js" — the cwd check below narrows to bundles only
    const output = execFileSync(
      "pgrep", ["-a", "-f", "node server/index\\.js"],
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    if (!output) return;

    for (const line of output.split("\n")) {
      const pid = parseInt(line.split(/\s+/)[0], 10);
      if (!pid || pid === process.pid) continue;
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(bundleDir)) continue;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ppid = parseInt(stat.split(" ")[3], 10);
        // Only kill TRUE orphans (init-adopted, ppid=1). A non-zero ppid that
        // isn't our own means the addon belongs to ANOTHER gateway instance
        // (e.g. crow-finance-gateway) which is still parenting it — leave it
        // alone. Killing it would create a hostile-cleanup loop where each
        // gateway boot kills the other gateway's bundle children.
        if (ppid !== 1) continue;
        console.log(`  [proxy] Killing stale addon process PID ${pid} (cwd: ${cwd})`);
        process.kill(pid, "SIGTERM");
        cleaned++;
      } catch {}
    }
  } catch {}
  if (cleaned > 0) console.log(`  [proxy] Cleaned up ${cleaned} stale addon process(es)`);
}

// Test seam: a test swaps the spawn-side functions for fakes (never set in production).
let _testDeps = null;
export function _setProxyDepsForTest(deps) { _testDeps = deps || null; }
function dep(name, real) { return (_testDeps && _testDeps[name]) || real; }

/**
 * Create a combined McpServer that proxies tools from all connected external servers.
 * Call this once at gateway startup; it spawns all configured servers.
 */
export async function initProxyServers() {
  // The settled signal MUST fire however this function exits — the early
  // `configured.length === 0` return, a throw from any loader, or the normal
  // path. initProxyServers is invoked fire-and-forget with a .catch in
  // boot/post-listen.js, so a signal that only fires at the end of the addon
  // loop would never resolve on a host with no mcp-addons.json (the common
  // fresh-install case). The convergence health gate awaits this; an unresolved
  // promise there means the boot cookie is never cleared and the NEXT boot
  // quarantines a sha that was healthy all along.
  try {
  cleanupStaleAddonProcesses();

  // Crow-wide sources configured through .env (deleted by PR 4, Home migration).
  const configured = dep("legacyEnvSources", legacyEnvSources)().filter((i) => {
    if (connectedServers.has(i.id)) return false;
    if (i.requires && i.requires.length > 0) {
      const hasBins = i.requires.every((bin) => {
        try {
          execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 5000 });
          return true;
        } catch {
          return false;
        }
      });
      if (!hasBins) return false;
    }
    return true;
  });

  if (configured.length === 0) {
    console.log("[proxy] No external integrations configured — /tools/mcp will have no tools.");
    // Still load dynamic backends and bundle-installed MCP addons — they don't
    // require external integrations to be configured.
    await dep("loadDynamicBackends", loadDynamicBackends)();
    await loadAddonServers();
    return;
  }

  console.log(`[proxy] Starting ${configured.length} external server(s)...`);

  // Connect to all servers in parallel
  const results = await Promise.allSettled(
    configured.map((integration) => dep("connectToServer", connectToServer)(integration))
  );

  const successCount = results.filter(
    (r) => r.status === "fulfilled" && r.value !== null
  ).length;

  console.log(`[proxy] ${successCount}/${configured.length} server(s) connected.`);

  // Load dynamic backends from data_backends table
  await dep("loadDynamicBackends", loadDynamicBackends)();

  // Load bundle-installed MCP servers from <crow-home>/mcp-addons.json
  await loadAddonServers();
  } finally {
    _markAddonsSettled();
  }
}

/**
 * Load MCP servers registered by bundle installs. Reads from the active
 * instance's mcp-addons.json (primary: ~/.crow/, MPA and other alternate
 * instances: $CROW_HOME/).
 */
async function loadAddonServers() {
  const mcpAddonsPath = join(resolveCrowHome(), "mcp-addons.json");
  if (!existsSync(mcpAddonsPath)) return;

  let addons;
  try {
    addons = JSON.parse(readFileSync(mcpAddonsPath, "utf8"));
  } catch {
    return;
  }

  const entries = Object.entries(addons);
  if (entries.length === 0) return;

  console.log(`[proxy] Loading ${entries.length} addon server(s) from mcp-addons.json...`);

  for (const [id, config] of entries) {
    if (connectedServers.has(id)) continue;
    // A service add-on without its fields is connected per project, not Crow-wide.
    if (!isLegacyConfiguredAddon(id, config)) {
      console.log(`  [proxy] addon ${id}: skipped (service: connected per project)`);
      continue;
    }
    try {
      await dep("connectAddonServer", connectAddonServer)(id, config);
    } catch (err) {
      console.warn(`  [proxy] addon ${id}: ${err.message}`);
    }
  }
}

/** Close a running data backend (its owner approval was withdrawn). */
export function disconnectDynamicBackend(backendId) {
  const key = `backend-${backendId}`;
  const entry = connectedServers.get(key);
  if (!entry) return false;
  connectedServers.delete(key);
  try { entry.client?.close?.(); } catch {}
  return true;
}

/**
 * Load data backends from the database and connect them as integrations.
 * Called on startup and can be called again to reload without full restart.
 */
export async function loadDynamicBackends() {
  let db;
  try {
    db = createDbClient();
    const { rows } = await db.execute(
      "SELECT * FROM data_backends WHERE backend_type = 'mcp_server'"
    );

    if (rows.length === 0) return;

    console.log(`[proxy] Loading ${rows.length} dynamic backend(s) from database...`);

    for (const row of rows) {
      const backendKey = `backend-${row.id}`;

      // Skip if already connected
      const existing = connectedServers.get(backendKey);
      if (existing && existing.status === "connected") continue;

      // The one parser every reader uses (approval page, hash, spawner).
      const parsed = parseStoredSpec(row.connection_ref);
      if (!parsed.ok) {
        console.error(`  [proxy] Backend #${row.id} "${row.name}": ${parsed.reason}`);
        await db.execute({
          sql: "UPDATE data_backends SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?",
          args: [parsed.reason, row.id],
        });
        continue;
      }

      // Owner approval gate: a registered command runs only after the
      // dashboard owner approved this exact connection_ref (an edit voids it).
      // The check covers the stored text and the contents of the files it runs.
      if (!isApproved(row)) {
        const why = hasApproval(row)
          ? "Changed since it was approved (its command or a file it runs) — approve it again on the Projects page"
          : "Waiting for the owner to approve it on the Projects page";
        // Keep an approval-refusal reason the owner has not acted on yet.
        if (row.status !== PENDING_STATUS || (hasApproval(row) && row.last_error !== why)) {
          await db.execute({
            sql: "UPDATE data_backends SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?",
            args: [PENDING_STATUS, why, row.id],
          });
        }
        console.warn(`  [proxy] Backend #${row.id} "${row.name}": not approved by the owner — not started`);
        continue;
      }
      const launch = verifyBackendLaunch(parsed.spec);
      if (!launch.ok) {
        await db.execute({
          sql: "UPDATE data_backends SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?",
          args: [launch.reason, row.id],
        });
        continue;
      }

      // Check that required env vars are set
      const missingVars = launch.envVars.filter((v) => !process.env[v]);
      if (missingVars.length > 0) {
        console.warn(`  [proxy] Backend #${row.id} "${row.name}": missing env vars: ${missingVars.join(", ")}`);
        await db.execute({
          sql: "UPDATE data_backends SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?",
          args: [`Missing env vars: ${missingVars.join(", ")}`, row.id],
        });
        continue;
      }

      // Re-read the row right before starting it, and let connectToServer run
      // the final synchronous check (prepareSpawn) in the same tick as the
      // spawn: the hash, files and launcher it verifies are the ones executed.
      const fresh = (await db.execute({ sql: "SELECT * FROM data_backends WHERE id = ? AND backend_type = 'mcp_server'", args: [row.id] })).rows[0];
      if (!fresh || fresh.connection_ref !== row.connection_ref || fresh.approved_ref_sha256 !== row.approved_ref_sha256) continue;
      const integration = {
        id: backendKey,
        name: row.name,
        command: launch.command,
        args: launch.args,
        envVars: launch.envVars,
        baseEnv: backendEnv([]),
        preSpawn: () => prepareSpawn(fresh),
      };

      try {
        const result = await connectToServer(integration);
        if (result) {
          await db.execute({
            sql: "UPDATE data_backends SET status = 'connected', last_connected_at = datetime('now'), last_error = NULL, schema_info = ?, updated_at = datetime('now') WHERE id = ?",
            args: [JSON.stringify(result.tools.map((t) => ({ name: t.name, description: t.description }))), row.id],
          });
        } else {
          await db.execute({
            sql: "UPDATE data_backends SET status = 'error', last_error = 'Connection failed', updated_at = datetime('now') WHERE id = ?",
            args: [row.id],
          });
        }
      } catch (error) {
        await db.execute({
          sql: "UPDATE data_backends SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?",
          args: [error.message, row.id],
        });
      }
    }
  } catch (error) {
    // data_backends table may not exist yet (first run before init-db)
    if (!error.message?.includes("no such table")) {
      console.warn(`[proxy] Failed to load dynamic backends: ${error.message}`);
    }
  } finally {
    if (db) db.close();
  }
}

const warnedToolClashes = new Set();
function warnToolClash(name, kept, skipped) {
  const key = `${name}\u0000${kept}\u0000${skipped}`;
  if (warnedToolClashes.has(key)) return;
  warnedToolClashes.add(key);
  console.warn(`[proxy] tool "${name}" is offered by both "${kept}" and "${skipped}"; /tools keeps "${kept}" and skips the duplicate`);
}

/**
 * Create a new McpServer instance with proxy tools for all connected servers.
 * Called per-session by the gateway's MCP handler.
 *
 * @param {object} [filter] Optional client-scoped tool filter.
 * @param {string[]} [filter.allowSources] If set, only these source ids are exposed.
 * @param {string[]} [filter.denySources] If set, these source ids are excluded.
 * @param {string[]} [filter.allowTools] If set, only these tool names are exposed.
 * @param {string[]} [filter.denyTools] Tool names to exclude.
 */
export function createProxyServer(filter) {
  const server = new McpServer({
    name: "crow-tools",
    version: "0.1.0",
  });
  const owners = new Map(); // tool name -> the source that registered it

  // Register proxy tools for each connected server — servers by id, tools by
  // name, so tools/list is the same bytes on every boot (stable-order.js:
  // connectedServers fills in connect-completion order).
  for (const [integrationId, entry] of sortedServers(connectedServers)) {
    if (entry.status !== "connected" || !entry.client) continue;
    if (filter?.allowSources && !filter.allowSources.includes(integrationId)) continue;
    if (filter?.denySources?.includes(integrationId)) continue;
    // Federation peers (loadRemoteInstances' instance-<id> entries) are never
    // part of the raw tool surface: they carry the peer's /memory/mcp tools
    // under the same crow_* names as this instance (two peers threw on the
    // duplicate and 500'd every session; one peer's tools answered to the
    // local names and wrote to the peer). Peers are reached via /router/mcp
    // and the bot remote proxy. No filter can opt one back in.
    if (entry.isRemote) continue;

    for (const tool of sortedByName(entry.tools)) {
      // Tools surface under their upstream name. Sources already self-namespace
      // (crow_browser_*, brave_web_search, etc.). If two sources do collide on
      // a tool name, the first one registered keeps it and the clash is logged
      // once per process (warnToolClash) — registerTool() throws on a
      // duplicate, and one bad source must not fail every session.
      if (filter?.allowTools && !filter.allowTools.includes(tool.name)) continue;
      if (filter?.denyTools?.includes(tool.name)) continue;
      const holder = owners.get(tool.name);
      if (holder !== undefined) { warnToolClash(tool.name, holder, integrationId); continue; }
      owners.set(tool.name, integrationId);

      // Re-publish the upstream's types (servers/shared/json-schema-to-zod.js).
      server.registerTool(
        tool.name,
        { description: tool.description || `Tool from ${integrationId}`, inputSchema: jsonSchemaToZodObject(tool.inputSchema, (entry.schemaPool ||= { units: SOURCE_BUDGET })) },
        async (args, extra) => {
          try {
            const result = await entry.client.callTool({
              name: tool.name,
              arguments: args,
              // A paired instance's call says so ({kind:"peer", from}, or its gateway's verified bot for an
              // add-on that opted in); nothing the caller sent is forwarded.
              ...peerActorMeta(extra, { allowRemoteBot: !!entry.remoteBotActor }),
            });
            return result;
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error calling ${tool.name}: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );
    }
  }

  return server;
}

/**
 * Connect to remote Crow instances via HTTP federation.
 * Queries crow_instances table for active remote instances with gateway URLs,
 * probes their /health endpoint, and registers them in connectedServers.
 *
 * Remote tool calls are proxied via HTTP POST to the instance's gateway.
 */
export async function loadRemoteInstances() {
  let db;
  try {
    db = createDbClient();
    const { getOrCreateLocalInstanceId } = await import("./instance-registry.js");
    const localId = getOrCreateLocalInstanceId();

    // Probe every non-revoked instance — not just those currently marked
    // 'active'. When a sibling restarts its /health window can miss a probe
    // and get flipped to 'offline', and if we only probed active rows we'd
    // never re-discover it. The probe itself flips status back to 'active'
    // on success, so transient offline states heal automatically.
    const { rows } = await db.execute({
      sql: "SELECT * FROM crow_instances WHERE status != 'revoked' AND gateway_url IS NOT NULL AND id != ?",
      args: [localId],
    });

    // A connection whose row is no longer trusted and live (revoked, paused,
    // trusted=0, or deleted) is dropped — otherwise such a peer kept a live
    // federated MCP client (PT-1: the one trust predicate).
    const liveIds = new Set(rows.filter((r) => rowIsTrusted(r)).map((r) => r.id));
    for (const key of [...connectedServers.keys()]) {
      const entry = connectedServers.get(key);
      if (entry?.isRemote && entry.instanceId && !liveIds.has(entry.instanceId)) {
        dropRemoteInstance(entry.instanceId);
      }
    }

    if (rows.length === 0) return;

    console.log(`[proxy] Probing ${rows.length} remote instance(s)...`);

    for (const inst of rows) {
      const instanceKey = `instance-${inst.id}`;

      // Already connected: keep the MCP client, but still probe /health so
      // last_seen_at and the peer-probe record reflect real contact. (This
      // used to refresh last_seen_at unconditionally, so a peer that dropped
      // after connecting looked alive forever.)
      const existing = connectedServers.get(instanceKey);
      if (existing && existing.status === "connected") {
        try {
          await probePeerHealth(inst.gateway_url);
          recordPeerProbe(inst.id, true);
          await db.execute({
            sql: "UPDATE crow_instances SET last_seen_at = datetime('now') WHERE id = ? AND status != 'revoked'",
            args: [inst.id],
          });
        } catch (err) {
          recordPeerProbe(inst.id, false, { error: err.message });
        }
        continue;
      }

      // Not trusted and live (paused, trusted=0): probe /health only (its
      // liveness is still shown), never connect a federated MCP client.
      if (!rowIsTrusted(inst)) {
        try {
          await probePeerHealth(inst.gateway_url);
          recordPeerProbe(inst.id, true);
        } catch (err) {
          recordPeerProbe(inst.id, false, { error: err.message });
        }
        continue;
      }

      let healthOk = false;
      try {
        await probePeerHealth(inst.gateway_url);
        healthOk = true;
        recordPeerProbe(inst.id, true);

        console.log(`  [proxy] Instance "${inst.name}" (${inst.hostname}): reachable, connecting...`);

        // Create a proper MCP client using StreamableHTTPClientTransport
        const remoteClient = await createRemoteInstanceClient(inst);

        // Discover tools on the remote instance
        let remoteTools = [];
        try {
          const { tools } = await remoteClient.listTools();
          remoteTools = tools;
          console.log(`  [proxy] Instance "${inst.name}": ${remoteTools.length} tools discovered`);
        } catch (err) {
          console.warn(`  [proxy] Instance "${inst.name}": tool discovery failed — ${err.message}`);
        }

        connectedServers.set(instanceKey, {
          client: remoteClient,
          tools: remoteTools,
          status: "connected",
          isRemote: true,
          instanceId: inst.id,
          instanceName: inst.name,
          gatewayUrl: inst.gateway_url,
          hostname: inst.hostname,
        });

        // Update last_seen
        await db.execute({
          sql: `UPDATE crow_instances SET last_seen_at = datetime('now'), status = ${livenessStatusSql("active")}, updated_at = datetime('now') WHERE id = ? AND status != 'revoked'`,
          args: [inst.id],
        });
      } catch (err) {
        console.warn(`  [proxy] Instance "${inst.name}" (${inst.hostname}): unreachable — ${err.message}`);
        if (!healthOk) recordPeerProbe(inst.id, false, { error: err.message });
        connectedServers.set(instanceKey, {
          client: null,
          tools: [],
          status: "offline",
          isRemote: true,
          instanceId: inst.id,
          instanceName: inst.name,
          gatewayUrl: inst.gateway_url,
          hostname: inst.hostname,
          error: err.message,
        });

        await db.execute({
          // Never overwrite a revoke/pause that landed while this probe was
          // in flight (MPA retirement defect 4).
          sql: `UPDATE crow_instances SET status = ${livenessStatusSql("offline")}, updated_at = datetime('now') WHERE id = ? AND status != 'revoked'`,
          args: [inst.id],
        }).catch(() => {});
      }
    }
  } catch (err) {
    if (!err.message?.includes("no such table")) {
      console.warn(`[proxy] Failed to load remote instances: ${err.message}`);
    }
  } finally {
    if (db) db.close();
  }
}

/**
 * Create a proper MCP client connected to a remote Crow instance's gateway.
 * Uses the SDK's StreamableHTTPClientTransport for session-aware communication.
 */
async function createRemoteInstanceClient(instance) {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { getPeerCreds } = await import("../shared/peer-credentials.js");

  const baseUrl = instance.gateway_url.replace(/\/$/, "");
  const mcpUrl = new URL(`${baseUrl}/memory/mcp`);

  // Attach the pre-shared peer bearer token so the remote gateway's
  // instanceAuthMiddleware (servers/gateway/instance-registry.js:427)
  // recognises the request. Without this, federated MCP calls were
  // hitting the peer's OAuth middleware and failing with
  // `invalid_token / Missing Authorization header` even for correctly
  // paired instances. The peer-tokens.json store is the source of truth
  // for these tokens (populated during instance-pair).
  const creds = getPeerCreds(instance.id);
  console.log(`  [proxy] federation auth for "${instance.name}" (${instance.id.slice(0,8)}…): ${creds?.auth_token ? "token=present" : "token=MISSING"}`);
  const requestInit = creds?.auth_token
    ? { headers: { Authorization: `Bearer ${creds.auth_token}` } }
    : undefined;

  const transport = new StreamableHTTPClientTransport(mcpUrl, requestInit ? { requestInit } : undefined);

  const client = new Client({
    name: `crow-federation-${instance.id}`,
    version: "0.1.0",
  });

  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Federation connection timed out (10s)")), 10_000)
    ),
  ]);

  return client;
}

/**
 * Addon id → connection status, for the convergence health gate.
 *
 * ADDONS ONLY. connectedServers also holds remote federation peers (whose status
 * flips to "offline" whenever a crow on another machine reboots) and dynamic
 * data backends. Including them would let a remote host's uptime quarantine
 * this host's sha — a regression that has nothing to do with the update.
 */
export function healthSnapshot() {
  const snap = {};
  for (const [id, entry] of connectedServers) {
    if (entry.isAddon) snap[id] = entry.status;
  }
  return snap;
}

let _settledResolve = null;
const _settled = new Promise((r) => { _settledResolve = r; });

/**
 * Resolves once addon loading has finished — however it finished.
 *
 * Addons connect SEQUENTIALLY with a 60s CONNECT_TIMEOUT_MS each, so the total
 * is unbounded in addon count and no fixed grace window is correct: with two
 * addons hung on their full timeout, a third has not yet been *attempted* and
 * would read as "missing", i.e. a false regression, on a perfectly good sha.
 */
export function addonsSettled() { return _settled; }

/** Marked from initProxyServers' `finally`. Idempotent. */
export function _markAddonsSettled() {
  if (_settledResolve) { _settledResolve(); _settledResolve = null; }
}

/**
 * Get status of all integrations for the /health and /setup endpoints.
 */
export function getProxyStatus() {
  const integrationStatus = legacyIntegrationsView().map((integration) => {
    const configured = integration.configured;

    let requiresMissing = false;
    if (integration.requires && integration.requires.length > 0) {
      requiresMissing = !integration.requires.every((bin) => {
        try {
          execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 5000 });
          return true;
        } catch {
          return false;
        }
      });
    }

    const entry = connectedServers.get(integration.id);

    return {
      id: integration.id,
      name: integration.name,
      description: integration.description,
      configured,
      status: entry?.status || (configured ? "pending" : "not_configured"),
      toolCount: entry?.tools?.length || 0,
      error: entry?.error || null,
      envVars: integration.envVars,
      keyUrl: integration.keyUrl,
      keyInstructions: integration.keyInstructions,
      requiresMissing,
      requires: integration.requires || [],
      docsUrl: integration.docsUrl || null,
      category: integration.category,
      steps: integration.steps,
      toggleEnv: integration.toggleEnv,
    };
  });

  // Include addon servers (from mcp-addons.json)
  for (const [id, entry] of connectedServers) {
    if (!entry.isAddon) continue;
    integrationStatus.push({
      id,
      name: id,
      description: `Bundle add-on: ${id}`,
      configured: true,
      status: entry.status,
      toolCount: entry.tools?.length || 0,
      error: entry.error || null,
      isAddon: true,
    });
  }

  return integrationStatus;
}
