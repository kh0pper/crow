/**
 * MCP Proxy — Spawns external MCP servers and re-exposes their tools.
 *
 * Pattern: For each configured integration with valid env vars, spawn it as a
 * child process, connect via StdioClientTransport, discover its tools, and
 * register proxy tools on a combined McpServer that the gateway serves over HTTP.
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { INTEGRATIONS, isIntegrationConfigured, getSpawnEnv } from "./integrations.js";
import { createDbClient } from "../db.js";
import { createGoogleOAuthProvider } from "../orchestrator/oauth-client-provider.js";

// Track connected servers for health checks and router access
const connectedServers = new Map(); // id → { client, process, tools }
export { connectedServers };

/**
 * Resolve the Crow instance home directory. Primary gateway leaves this
 * unset and falls back to ~/.crow; alternate instances (MPA, etc.) set
 * CROW_HOME in their systemd env so bundle installs, mcp-addons.json, and
 * skills/panels stay per-instance instead of bleeding into primary's state.
 */
function resolveCrowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/**
 * Convert a JSON Schema property definition to a Zod schema.
 * Handles the common types MCP tools use.
 */
function jsonSchemaToZod(prop) {
  if (!prop) return z.string();

  // Handle anyOf (often used for nullable types)
  if (prop.anyOf) {
    const nonNull = prop.anyOf.filter((s) => s.type !== "null");
    if (nonNull.length === 1) {
      const inner = jsonSchemaToZod(nonNull[0]);
      return inner.optional();
    }
    return z.any();
  }

  switch (prop.type) {
    case "string":
      if (prop.enum) return z.enum(prop.enum);
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(prop.items ? jsonSchemaToZod(prop.items) : z.any());
    case "object":
      return z.record(z.any());
    default:
      return z.any();
  }
}

/**
 * Convert a JSON Schema "properties" + "required" into a Zod object shape.
 */
function jsonSchemaPropertiesToZod(schema) {
  if (!schema || !schema.properties) return {};

  const shape = {};
  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodProp = jsonSchemaToZod(prop);
    if (prop.description) zodProp = zodProp.describe(prop.description);
    if (!required.has(key)) zodProp = zodProp.optional();
    shape[key] = zodProp;
  }
  return shape;
}

/**
 * Spawn a single external server, connect, and discover its tools.
 * Returns { client, childProcess, tools } or null on failure.
 */
async function connectToServer(integration) {
  const spawnEnv = getSpawnEnv(integration);
  const env = {
    ...process.env,
    ...spawnEnv,
  };

  // Support argsTransform for servers that need env values in args (e.g., Render bearer token)
  const args = integration.argsTransform
    ? integration.argsTransform(spawnEnv)
    : integration.args;

  // Timeout: npx/uvx may need to download packages on first run
  const CONNECT_TIMEOUT_MS = 60_000;

  try {
    const transport = new StdioClientTransport({
      command: integration.command,
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
        setTimeout(() => reject(new Error("Connection timed out (60s)")), CONNECT_TIMEOUT_MS)
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
 * Connect to an MCP server installed as a bundle addon (from ~/.crow/mcp-addons.json).
 * Unlike connectToServer(), this takes a flat env dict instead of using getSpawnEnv().
 */
async function connectAddonServer(id, config) {
  const CONNECT_TIMEOUT_MS = 60_000;
  const transportMode = (config.transport || "stdio").toLowerCase();

  try {
    let transport;
    if (transportMode === "http") {
      // Remote HTTP MCP server (e.g. Google's gmailmcp.googleapis.com).
      // OAuth flow is handled by the SDK via authProvider; see
      // orchestrator/oauth-client-provider.js for the token file shape.
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
      const env = { ...process.env, ...(config.env || {}) };
      transport = new StdioClientTransport({
        command: config.command,
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
        setTimeout(() => reject(new Error("Connection timed out (60s)")), CONNECT_TIMEOUT_MS)
      ),
    ]);

    const { tools } = await client.listTools();

    console.log(`  [proxy] addon ${id}: connected, ${tools.length} tools discovered`);

    connectedServers.set(id, {
      client,
      tools,
      status: "connected",
      isAddon: true,
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

/**
 * Create a combined McpServer that proxies tools from all connected external servers.
 * Call this once at gateway startup; it spawns all configured servers.
 */
export async function initProxyServers() {
  cleanupStaleAddonProcesses();

  const configured = INTEGRATIONS.filter((i) => {
    if (!isIntegrationConfigured(i)) return false;
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
    await loadDynamicBackends();
    await loadAddonServers();
    return;
  }

  console.log(`[proxy] Starting ${configured.length} external server(s)...`);

  // Connect to all servers in parallel
  const results = await Promise.allSettled(
    configured.map((integration) => connectToServer(integration))
  );

  const successCount = results.filter(
    (r) => r.status === "fulfilled" && r.value !== null
  ).length;

  console.log(`[proxy] ${successCount}/${configured.length} server(s) connected.`);

  // Load dynamic backends from data_backends table
  await loadDynamicBackends();

  // Load bundle-installed MCP servers from <crow-home>/mcp-addons.json
  await loadAddonServers();
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
    try {
      await connectAddonServer(id, config);
    } catch (err) {
      console.warn(`  [proxy] addon ${id}: ${err.message}`);
    }
  }
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

      let connRef;
      try {
        connRef = JSON.parse(row.connection_ref);
      } catch {
        console.error(`  [proxy] Backend #${row.id} "${row.name}": invalid connection_ref JSON`);
        await db.execute({
          sql: "UPDATE data_backends SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?",
          args: ["Invalid connection_ref JSON", row.id],
        });
        continue;
      }

      // Check that required env vars are set
      const missingVars = (connRef.envVars || []).filter((v) => !process.env[v]);
      if (missingVars.length > 0) {
        console.warn(`  [proxy] Backend #${row.id} "${row.name}": missing env vars: ${missingVars.join(", ")}`);
        await db.execute({
          sql: "UPDATE data_backends SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?",
          args: [`Missing env vars: ${missingVars.join(", ")}`, row.id],
        });
        continue;
      }

      // Build integration-shaped object for connectToServer
      const integration = {
        id: backendKey,
        name: row.name,
        command: connRef.command,
        args: connRef.args || [],
        envVars: connRef.envVars || [],
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

/**
 * Create a new McpServer instance with proxy tools for all connected servers.
 * Called per-session by the gateway's MCP handler.
 */
export function createProxyServer() {
  const server = new McpServer({
    name: "crow-tools",
    version: "0.1.0",
  });

  // Register proxy tools for each connected server
  for (const [integrationId, entry] of connectedServers) {
    if (entry.status !== "connected" || !entry.client) continue;

    for (const tool of entry.tools) {
      const zodShape = jsonSchemaPropertiesToZod(tool.inputSchema);

      server.tool(
        tool.name,
        tool.description || `Tool from ${integrationId}`,
        zodShape,
        async (args) => {
          try {
            const result = await entry.client.callTool({
              name: tool.name,
              arguments: args,
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

    if (rows.length === 0) return;

    console.log(`[proxy] Probing ${rows.length} remote instance(s)...`);

    for (const inst of rows) {
      const instanceKey = `instance-${inst.id}`;

      // Skip if already connected — but refresh last_seen_at so the
      // dashboard doesn't drift into "offline since X" for live peers.
      const existing = connectedServers.get(instanceKey);
      if (existing && existing.status === "connected") {
        await db.execute({
          sql: "UPDATE crow_instances SET last_seen_at = datetime('now') WHERE id = ?",
          args: [inst.id],
        });
        continue;
      }

      try {
        // Probe health endpoint with timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const healthUrl = `${inst.gateway_url}/health`;

        const resp = await fetch(healthUrl, { signal: controller.signal });
        clearTimeout(timeout);

        if (!resp.ok) {
          throw new Error(`Health check returned ${resp.status}`);
        }

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
          sql: "UPDATE crow_instances SET last_seen_at = datetime('now'), status = 'active', updated_at = datetime('now') WHERE id = ?",
          args: [inst.id],
        });
      } catch (err) {
        console.warn(`  [proxy] Instance "${inst.name}" (${inst.hostname}): unreachable — ${err.message}`);
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
          sql: "UPDATE crow_instances SET status = 'offline', updated_at = datetime('now') WHERE id = ?",
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
 * Get status of all integrations for the /health and /setup endpoints.
 */
export function getProxyStatus() {
  const integrationStatus = INTEGRATIONS.map((integration) => {
    const configured = isIntegrationConfigured(integration);

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
