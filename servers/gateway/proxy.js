/**
 * MCP Proxy — Spawns external MCP servers and re-exposes their tools.
 *
 * Pattern: For each configured integration with valid env vars, spawn it as a
 * child process, connect via StdioClientTransport, discover its tools, and
 * register proxy tools on a combined McpServer that the gateway serves over HTTP.
 */

import { resolveAddonCommand, checkLauncherArgs } from "../shared/resolve-command.js";
import { withoutCredentialKeys } from "../shared/credentials-env.js";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolveCrowHome as resolveSharedCrowHome, isWithin } from "../shared/crow-home.js";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchemaToZodObject, SOURCE_BUDGET } from "../shared/json-schema-to-zod.js";
import { sortedServers, sortedByName } from "../shared/stable-order.js";
import { legacyEnvSources, isLegacyConfiguredAddon, legacyIntegrationsView, addonDerivedEnv } from "./services/legacy-sources.js";
import { addonBaseEnv, declaredPassthrough, storagePassthrough } from "./addon-env.js";
import { createDbClient, resolveDataDir } from "../db.js";
import { gatewayListenPort } from "./listen-port.js";
import { addonWallMode } from "../../scripts/addon-sandbox/spawn.mjs";
import { AddonStdioTransport, createStderrPrefixer } from "../../scripts/addon-sandbox/transport.mjs";
import { clearWallFailures, recordWallFailure, wallFailureByRef, wallFailureReason } from "../../scripts/addon-sandbox/failures.mjs";
import { createWallContext } from "../../scripts/addon-sandbox/gateway-wall.mjs";
import { isApproved, approvalNotFromThisMachine, approvalForAnotherBackend, hasApproval, isLegacyApproval, LEGACY_APPROVAL_MESSAGE, MACHINE_APPROVAL_MESSAGE, NOT_FOR_THIS_BACKEND_MESSAGE, verifyBackendLaunch, backendEnv, parseStoredSpec, prepareSpawn, PENDING_STATUS } from "../shared/data-backend-approval.js";
import { pruneApprovalNonces } from "../shared/data-backend-approval-key.js";
import { createGoogleOAuthProvider } from "../shared/oauth-client-provider.js";
import { livenessStatusSql } from "../shared/instance-status.js";
import { recordPeerProbe } from "./peer-probe-health.js";
import bus from "../shared/event-bus.js";
import { rowIsTrusted } from "../shared/peer-trust.js";
import { peerActorMeta, remoteBotActorAllowed } from "../shared/peer-label.js";
import { bindSatelliteServers, refreshSatelliteEntries, satelliteVisible } from "./satellites/tool-entry.js";

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
// Satellite-hosted bundles live in this same map (one entry per bundle, appended last) so /tools,
// the router and the tool executor all see them; satellites/tool-entry.js keeps each entry's tool
// list in step with the owner-approved pins.
bindSatelliteServers(connectedServers);

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

/** The listed vars that are set in `source` (the gateway's environment by default). */
function envFromVars(vars = [], source = process.env) {
  const env = {};
  for (const v of vars) if (source[v]) env[v] = source[v];
  return env;
}

/** This checkout's root, two levels above `servers/gateway`. */
const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The in-namespace entry every walled child runs first (scripts/pi-bots). */
const PI_NETNS_ENTRY = fileURLToPath(new URL("../../scripts/pi-bots/pi_netns_entry.mjs", import.meta.url));

/** An add-on id is one lowercase slug; it names folders and a relay dir. */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A walled add-on that goes away within this window of connecting is a failure. */
const WALL_CLOSE_WINDOW_MS = 60_000;

/** How long a walled close waits before it raises a card (a shutdown is not a failure). */
const WALL_CLOSE_REPORT_DELAY_MS = 2000;

/** Marks an entry whose close Crow itself asked for (never a wall failure). */
const CLOSING = Symbol("closing");
function markClosing(entry) {
  if (entry && typeof entry === "object") {
    try { entry[CLOSING] = true; } catch { /* a frozen entry closes as before */ }
  }
}

/** The wall context, created the first time a walled spawn needs it. */
let _wallContext = null;
function getWallContext() {
  if (!_wallContext) {
    _wallContext = createWallContext({
      crowHome: resolveCrowHome(),
      appRoot: APP_ROOT,
      dataDir: resolveDataDir(),
      home: homedir(),
      nodeBin: process.execPath,
      gatewayPort: gatewayListenPort(),
    });
  }
  return _wallContext;
}

/**
 * Feed a stdio child's stderr through the line prefixer: the child never blocks
 * on a full stderr pipe, and every line of it reads `[addon:<id>] …`.
 */
function attachStderrPrefixer(transport, id) {
  const stream = transport.stderr;
  if (!stream || typeof stream.on !== "function") return;
  const prefixer = createStderrPrefixer({ id });
  stream.on("data", (chunk) => { try { prefixer.write(chunk); } catch { /* a reader that went away */ } });
  stream.on("end", () => { try { prefixer.end(); } catch { /* nothing left to flush */ } });
  stream.on("error", () => { /* the child's exit is what counts */ });
}

/**
 * The `wall` field a connected add-on's entry carries: plain data only (a mode,
 * a tier, a reason and the profile snapshot), never a live object. The relay
 * and the bind fds belong to `wrapAddonSpawn`'s cleanup, so the relay is kept
 * beside the entry as a non-enumerable `_wallRelay` reference instead.
 */
function wallInfoFor(wall, mode) {
  return {
    mode: wall && wall.walled ? "walled" : "unwalled",
    tier: wall ? wall.tier : "none",
    reason: wall && wall.walled ? null : (wall?.reason || mode?.reason || null),
    source: wallSource(wall, mode),
    profile: wall?.profile ?? null,
    // Plain data: what the add-on still reaches beyond its wall (e.g. the
    // `storage` residual, LEDGER N1b-13), so no status line calls it fully walled.
    residuals: Array.isArray(wall?.residuals) ? wall.residuals.map((r) => ({ kind: r.kind, label: r.label })) : [],
  };
}

/**
 * Where one entry's wall mode came from: the mode decision's own source, or
 * "no-bwrap" when the decision said walled and this computer has no usable
 * bwrap (so the child runs at a weaker tier, or not at all).
 */
function wallSource(wall, mode) {
  if (mode?.source === "walled") return wall && wall.walled ? "walled" : "no-bwrap";
  if (mode?.source) return mode.source;
  // No decision source: a weaker tier here never reads as a wall.
  const tier = wall ? wall.tier : "none";
  return tier === "nnp" || tier === "none" ? "no-bwrap" : "refused";
}

/**
 * The connection entry for an add-on: the given fields, plus the wall's relay as
 * a NON-enumerable `_wallRelay` (a later status surface reads it; a JSON view of
 * the entry or of its `wall` never carries a live object).
 */
function wallEntry(entry, wall) {
  const relay = wall && wall.walled && wall.relay ? wall.relay : null;
  if (relay) {
    try {
      Object.defineProperty(entry, "_wallRelay", { value: relay, enumerable: false, writable: true, configurable: true });
    } catch { /* an entry that cannot carry it loses nothing else */ }
  }
  return entry;
}

/**
 * Every connected entry that went through the wall decision, as a snapshot of
 * plain data: { id, kind, name, status, wall }. `kind` is "addon" for a bundle
 * add-on, "builtin" for a built-in integration and "backend" for an approved
 * data backend (whose `name` is its row's display name). An add-on or built-in
 * with no `wall` record never ran a local child under a decision (an HTTP
 * add-on, one that failed before it), so it is neither walled nor counted.
 * Never a client, never a relay — a status surface may serialise this as it is.
 */
export function addonWallEntries() {
  const entries = [];
  for (const [id, entry] of connectedServers) {
    if (!entry) continue;
    let kind = null;
    if (entry.isBackend) kind = "backend";
    else if (entry.isAddon) kind = "addon";
    else if (entry.isBuiltin) kind = "builtin";
    if (!kind) continue;
    const wall = entry.wall && typeof entry.wall === "object" ? { ...entry.wall } : null;
    if (!wall && kind !== "backend") continue;
    entries.push({
      id,
      kind,
      name: kind === "backend" ? (entry.backendName || id) : id,
      status: entry.status || "unknown",
      wall,
    });
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The emit a failure card goes through: fix-it's own, on a client of its own. */
function realEmitWallFailure(db, eventName, payload) {
  return import("./fix-it/index.js").then((m) => m.emitFixIt(db, eventName, payload));
}

/**
 * The folder a failure's paths are shown relative to: the add-on's own install
 * folder, and only when it is one of the two the wall allows. The entry's `cwd`
 * comes from mcp-addons.json, which unwalled same-user code can edit, so anything
 * else falls back to the installed copy.
 */
function wallInstallRoot(id, cwd) {
  const fallback = join(resolveCrowHome(), "bundles", id);
  if (typeof cwd !== "string" || !cwd) return fallback;
  let real = null;
  try { real = realpathSync(cwd); } catch { return fallback; }
  for (const allowed of [join(resolveCrowHome(), "bundles", id), join(APP_ROOT, "bundles", id)]) {
    let root = null;
    try { root = realpathSync(allowed); } catch { root = resolve(allowed); }
    if (real === root || isWithin(real, root)) return real;
  }
  return fallback;
}

/**
 * Record one walled add-on's failure and raise its Fix-it card, fire-and-forget.
 * The card carries the record's ref only; the reason is built here (denials,
 * then the child's stderr, then its exit code) so no card ever echoes a path
 * outside the add-on's own folders. Never throws, never blocks a connect.
 */
export function reportWallFailure(id, { refused = false, wall = null, transport = null, cwd = null } = {}) {
  try {
    const relay = wall?.relay || connectedServers.get(id)?._wallRelay || null;
    const denials = typeof relay?.denials === "function" ? relay.denials() : [];
    const stderrLines = typeof transport?.stderrLines === "function" ? transport.stderrLines() : [];
    const reason = wallFailureReason({
      denials,
      stderrLines,
      exitCode: Number.isInteger(transport?.exitCode) ? transport.exitCode : null,
      installDir: wallInstallRoot(id, cwd),
      dataDir: join(resolveDataDir(), id),
      refused,
    });
    const ref = recordWallFailure(id, reason);
    if (!ref) return;

    let db = null;
    try { db = createDbClient(); } catch { return; }
    Promise.resolve()
      .then(() => {
        // A newer failure for the same add-on drops this record: an older,
        // out-of-order emit must never overwrite the card with a dead ref.
        if (wallFailureByRef(ref) === null) return null;
        return dep("emitFixIt", realEmitWallFailure)(db, "addon-wall-failed", { id, reason, ref });
      })
      .catch((err) => console.warn(`  [proxy] addon ${id}: the Fix-it card could not be raised — ${err?.message || err}`))
      .finally(() => { try { db.close(); } catch { /* already closed */ } });
  } catch (err) {
    console.warn(`  [proxy] addon ${id}: the wall failure could not be recorded — ${err?.message || err}`);
  }
}

/**
 * The environment connectToServer() gives a child. A data backend brings its own
 * allowlisted base env, and a built-in integration gets the add-on base
 * allowlist — never the gateway's whole environment. On top of either: the
 * integration's own `env` (a legacy source), or the `envVars` it declares, read
 * from `base`. Keys applied from systemd credentials are dropped.
 */
export function integrationChildEnv(integration, base = process.env) {
  const spawnEnv = integration.env || envFromVars(integration.envVars, base);
  return {
    ...withoutCredentialKeys(integration.baseEnv || addonBaseEnv(base)),
    ...spawnEnv,
  };
}

/**
 * Spawn a single external server, connect, and discover its tools.
 * `integration.env` (a legacy source) is the child's own vars; otherwise the
 * listed `envVars` are read from the gateway's environment (data backends).
 * Returns { client, childProcess, tools } or null on failure.
 */
async function connectToServer(integration) {
  const env = integrationChildEnv(integration);
  // The built-in's own vars: the walled path builds its env from these plus the
  // allowlisted base, never from `env` above.
  const spawnEnv = integration.env || envFromVars(integration.envVars, process.env);

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

  // A data backend (preSpawn) brings its own approval and its own wall story
  // (D7): nothing about it changes here. Every other built-in is walled by the
  // same rules as a bundle add-on.
  let wall = null;
  let wallMode = null;
  if (!integration.preSpawn) {
    wallMode = dep("addonWallMode", addonWallMode)({ id: integration.id, gatewayEnv: process.env, crowHome: resolveCrowHome() });
    if (wallMode.mode === "walled") {
      try {
        wall = await dep("startAddonWall", (o) => getWallContext().startAddonWall(o))({
          id: integration.id,
          entry: { command, args, env: spawnEnv },
          command,
          args: Array.isArray(args) ? args : [],
          baseEnv: integration.baseEnv || process.env,
          ownEnv: spawnEnv,
          kind: "builtin",
        });
      } catch (err) {
        const message = err?.message || "the wall could not be built";
        console.warn(`  [proxy] ${integration.name}: not started, its wall was refused — ${message}`);
        connectedServers.set(integration.id, {
          client: null,
          tools: [],
          status: "error",
          error: message,
          isBuiltin: true,
          wall: { mode: "refused", reason: message },
        });
        return null;
      }
    }
  }

  // Timeout: npx/uvx may need to download packages on first run
  const CONNECT_TIMEOUT_MS = 60_000;

  let transport = null;
  try {
    if (wall && wall.walled) {
      transport = new AddonStdioTransport({
        id: integration.id,
        command: wall.cmd,
        args: wall.args,
        env: wall.env,
        stdioExtra: wall.stdioExtra,
        onExit: wall.cleanup,
      });
    } else if (wall && wall.tier === "nnp") {
      // No usable bwrap here: the child runs under setpriv, with the env the wall
      // built (never the spawn site's own).
      transport = new StdioClientTransport({ command: wall.cmd, args: wall.args, env: wall.env, stderr: "pipe" });
      attachStderrPrefixer(transport, integration.id);
    } else {
      transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
      attachStderrPrefixer(transport, integration.id);
    }

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

    // A built-in that went through the wall decision carries its wall the same
    // way an add-on does; a data backend is marked as one (its `name` is the row's).
    const wallInfo = wallMode ? wallInfoFor(wall, wallMode) : null;
    connectedServers.set(integration.id, {
      client,
      tools,
      status: "connected",
      ...(integration.preSpawn ? { isBackend: true, backendName: integration.name } : { isBuiltin: true }),
      ...(wallInfo ? { wall: wallInfo } : {}),
    });

    // Handle unexpected disconnection
    transport.onclose = () => {
      console.warn(`  [proxy] ${integration.name}: disconnected`);
      const entry = connectedServers.get(integration.id);
      if (entry) entry.status = "disconnected";
    };

    return { client, tools };
  } catch (error) {
    // A wall that was built but whose child never connected still owns a relay,
    // bind fds and a door token: cleanup is idempotent and covers both. A walled
    // child that started but never answered is stopped first.
    if (wall && wall.walled && transport) { try { await transport.close(); } catch { /* already gone */ } }
    try { wall?.cleanup?.(); } catch { /* nothing left to close */ }
    console.error(`  [proxy] ${integration.name}: failed to connect — ${error.message}`);
    connectedServers.set(integration.id, {
      client: null,
      tools: [],
      status: "error",
      error: error.message,
      ...(integration.preSpawn ? { isBackend: true, backendName: integration.name } : { isBuiltin: true }),
      ...(wall && wall.walled ? { wall: { mode: "walled", tier: wall.tier, reason: null } } : {}),
    });
    return null;
  }
}

/** A walled add-on's own env: its entry env, its derived keys, and the gateway host mark. */
export function addonOwnEnv(config = {}, base = process.env, id = null) {
  const derived = id ? addonDerivedEnv(id, config.env, undefined, withoutCredentialKeys(base)) : {};
  return { ...(config.env || {}), ...derived, CROW_ADDON_HOST: "gateway" };
}

/**
 * The environment of a bundle add-on's stdio child started BY THE GATEWAY: the allowlisted base
 * (addon-env.js), the keys the add-on's registry entry declares, the storage env the four
 * storage-reading bundles keep, the entry's own env, and the manifest's derived env.
 * `CROW_ADDON_HOST=gateway` marks the one long-lived copy the gateway supervises, so an add-on can
 * keep background work (schedules, polling) out of the short-lived private copies that bots and
 * other MCP clients start from the same mcp-addons.json entry. Set last: an add-on's own env
 * cannot claim or drop it.
 * With an `id`, a service add-on also gets its manifest's derived env (e.g. Render's AUTH_HEADER),
 * rendered from `config.env` over `base`.
 * The passthrough reads from a base without the names this process applied from systemd
 * credentials: those values are the gateway's own, not part of the environment it was given.
 */
export function addonStdioEnv(config = {}, base = process.env, id = null, opts = {}) {
  const gate = withoutCredentialKeys(base);
  const derived = id ? addonDerivedEnv(id, config.env, undefined, gate) : {};
  return {
    ...addonBaseEnv(base),
    ...declaredPassthrough(id, gate, opts),
    ...storagePassthrough(id, gate),
    ...(config.env || {}),
    ...derived,
    CROW_ADDON_HOST: "gateway",
  };
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
 *
 * A stdio add-on is walled when the mode says so. A wall that cannot be built
 * leaves it OFF (never an unwalled spawn). With the walls off, this is the
 * same spawn as before plus the stderr prefixer.
 */
export async function connectAddonServer(id, config) {
  const CONNECT_TIMEOUT_MS = 60_000;
  const transportMode = (config.transport || "stdio").toLowerCase();
  // The add-on's own code folder: the entry may name one, else the installed copy.
  const installDir = config.cwd || join(resolveCrowHome(), "bundles", id);
  let wall = null;
  let wallInfo = null;
  let transport = null;

  try {
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
      const cwd = installDir;
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

      // The mode comes from the gateway's env and `<CROW_HOME>/addon-walls.json`
      // only; nothing the add-on can write is read here.
      const wm = dep("addonWallMode", addonWallMode)({ id, gatewayEnv: process.env, crowHome: resolveCrowHome() });
      if (wm.mode === "walled") {
        try {
          wall = await dep("startAddonWall", (o) => getWallContext().startAddonWall(o))({
            id,
            entry: config,
            command: rc.command,
            args: config.args || [],
            // The wall builds the child env itself: the gateway env is read only
            // through its allowlist, never spread (defence in depth over Phase 0).
            baseEnv: process.env,
            ownEnv: addonOwnEnv(config, process.env, id),
            kind: "addon",
          });
        } catch (err) {
          const message = err?.message || "the wall could not be built";
          console.error(`  [proxy] addon ${id}: not started, its wall was refused — ${message}`);
          connectedServers.set(id, {
            client: null,
            tools: [],
            status: "error",
            error: message,
            isAddon: true,
            wall: { mode: "refused", reason: message },
          });
          reportWallFailure(id, { refused: true, cwd: installDir });
          return null;
        }
      }

      if (wall && wall.walled) {
        transport = new AddonStdioTransport({
          id,
          command: wall.cmd,
          args: wall.args,
          env: wall.env,
          stdioExtra: wall.stdioExtra,
          onExit: wall.cleanup,
        });
      } else if (wall && wall.tier === "nnp") {
        // No usable bwrap here: the child runs under setpriv, and its stderr goes
        // through the same prefixer (the process hygiene applies to every tier).
        // The env is the wall's own build, never the spawn site's.
        transport = new StdioClientTransport({ command: wall.cmd, args: wall.args, env: wall.env, cwd, stderr: "pipe" });
        attachStderrPrefixer(transport, id);
      } else {
        transport = new StdioClientTransport({ command: rc.command, args: config.args || [], env, cwd, stderr: "pipe" });
        attachStderrPrefixer(transport, id);
      }
      wallInfo = wallInfoFor(wall, wm);
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

    connectedServers.set(id, wallEntry({
      client,
      tools,
      status: "connected",
      isAddon: true,
      remoteBotActor,
      ...(wallInfo ? { wall: wallInfo } : {}),
    }, wall));

    // It runs walled now: the failure the owner may still be looking at is over.
    if (wall && wall.walled) clearWallFailures(id);
    const connectedAt = Date.now();

    // This connection's own entry: a later reconnect replaces the map's entry,
    // and this transport's late close must never mark (or card) the new one.
    const ownEntry = connectedServers.get(id);
    transport.onclose = () => {
      console.warn(`  [proxy] addon ${id}: disconnected`);
      const entry = connectedServers.get(id);
      if (entry !== ownEntry) return;
      if (entry) entry.status = "disconnected";
      // A walled child that goes away right after connecting is a wall failure,
      // not a shutdown: it stays off, and the owner gets the card. A close Crow
      // asked for (uninstall, reconnect, gateway stop) is not a failure.
      if (entry && entry[CLOSING] === true) return;
      if (wall && wall.walled && Date.now() - connectedAt < WALL_CLOSE_WINDOW_MS) {
        if (entry) entry.status = "error";
        // A gateway shutting down kills its children too, and that is not a
        // failure. Wait a moment, then report only if this is still the live
        // entry and nothing marked it closing. Unref'd: an exiting gateway
        // never fires it.
        const timer = setTimeout(() => {
          const live = connectedServers.get(id);
          if (!live || live !== ownEntry || live[CLOSING] === true) return;
          reportWallFailure(id, { wall, transport, cwd: installDir });
        }, WALL_CLOSE_REPORT_DELAY_MS);
        timer.unref?.();
      }
    };

    return { client, tools };
  } catch (error) {
    // A wall that was built but whose child never connected still owns a relay,
    // bind fds and a door token: cleanup is idempotent and covers a spawn that
    // never happened too. Never retried unwalled. A walled child that started
    // but never answered is stopped too: its relay is gone with the cleanup.
    // The failure is recorded BEFORE the cleanup: the relay's denials are still
    // readable here (and stay readable after it, harmlessly).
    if (wall && wall.walled) reportWallFailure(id, { wall, transport, cwd: installDir });
    if (wall && wall.walled && transport) { try { await transport.close(); } catch { /* already gone */ } }
    try { wall?.cleanup?.(); } catch { /* nothing left to close */ }
    console.error(`  [proxy] addon ${id}: failed to connect — ${error.message}`);
    connectedServers.set(id, {
      client: null,
      tools: [],
      status: "error",
      error: error.message,
      isAddon: true,
      ...(wall && wall.walled ? { wall: { mode: "walled", tier: wall.tier, reason: null } } : {}),
    });
    return null;
  }
}

/**
 * Disconnect an addon server (for clean uninstall).
 */
export async function disconnectAddonServer(id) {
  const entry = connectedServers.get(id);
  markClosing(entry);
  if (entry && entry.client) {
    try { await entry.client.close(); } catch {}
  }
  connectedServers.delete(id);
}

/**
 * Connect one installed add-on now (the owner's "Wall it again", and the
 * "Run without the wall" remedy). Which add-on runs, and how, comes from this
 * instance's mcp-addons.json entry and the wall decision — never from a caller.
 * Never throws.
 *
 * @returns {Promise<{ok: boolean, status?: string, reason?: string}>}
 */
export async function reconnectAddonServer(id) {
  if (typeof id !== "string" || !ADDON_ID_RE.test(id)) return { ok: false, reason: "invalid add-on id" };

  let config = null;
  try {
    const all = JSON.parse(readFileSync(join(resolveCrowHome(), "mcp-addons.json"), "utf8"));
    config = all && typeof all === "object" && Object.hasOwn(all, id) ? all[id] : null;
  } catch {
    return { ok: false, reason: "the add-on list could not be read" };
  }
  if (!config || typeof config !== "object") return { ok: false, reason: "that add-on is not installed" };
  // A satellite-hosted bundle's tools come from its host, never from a spawn here.
  if ((config.transport || "stdio").toLowerCase() === "satellite") {
    return { ok: false, reason: "that add-on runs on another computer" };
  }
  // A service add-on without its fields is connected per project, not Crow-wide.
  if (!isLegacyConfiguredAddon(id, config)) return { ok: false, reason: "that add-on's account fields are not set" };

  try {
    await dep("disconnectAddonServer", disconnectAddonServer)(id);
    await dep("connectAddonServer", connectAddonServer)(id, config);
  } catch (err) {
    console.warn(`  [proxy] addon ${id}: reconnect failed — ${err?.message || err}`);
    return { ok: false, status: "error" };
  }
  const status = connectedServers.get(id)?.status ?? "error";
  return { ok: status === "connected", status };
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
      markClosing(entry);
      if (entry.client) {
        try { await entry.client.close(); } catch {}
      }
    })
  );
  connectedServers.clear();
}

/**
 * Kill stale addon server processes left over from a previous gateway instance:
 * a node add-on whose cwd is in <crowHome>/bundles/, and an orphaned bwrap
 * wrapper around a walled add-on (isOrphanAddonWrapper). Both sweeps kill only
 * init-adopted processes (ppid 1).
 */
function cleanupStaleAddonProcesses() {
  let cleaned = sweepStaleAddonNodes();
  cleaned += sweepOrphanAddonWrappers();
  if (cleaned > 0) console.log(`  [proxy] Cleaned up ${cleaned} stale addon process(es)`);
}

/** The node add-ons an earlier gateway left behind, adopted by init. */
function sweepStaleAddonNodes() {
  let cleaned = 0;
  try {
    const bundleDir = join(resolveCrowHome(), "bundles");
    // Match "node server/index.js" — the cwd check below narrows to bundles only
    const output = execFileSync(
      "pgrep", ["-a", "-f", "node server/index\\.js"],
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    if (!output) return 0;

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
  return cleaned;
}

/** The process table the wrapper sweep reads: one { pid, ppid, argv } per process. */
function listProcsReal() {
  const procs = [];
  let names = [];
  try { names = readdirSync("/proc"); } catch { return procs; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let argv = [];
    try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (argv.length === 0) continue;
    let ppid = null;
    try {
      // "pid (comm) state ppid …": comm may hold spaces, so split after its paren.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      ppid = parseInt(fields[1], 10);
    } catch { continue; }
    if (!Number.isInteger(ppid)) continue;
    procs.push({ pid, ppid, argv });
  }
  return procs;
}

/**
 * Whether one process is an orphaned bwrap wrapper around a walled add-on: all
 * four of an init-adopted process (ppid 1), a bwrap command line, the wall's
 * in-namespace entry AND a --chdir into a bundles folder. The --chdir is what
 * tells it from a bot: a bot runs the same netns entry under bwrap too, but not
 * into a bundles folder.
 */
export function isOrphanAddonWrapper({ ppid, argv, crowHome, appRoot, netnsEntry } = {}) {
  if (ppid !== 1) return false;
  if (!Array.isArray(argv) || argv.length === 0) return false;
  if (basename(String(argv[0])) !== "bwrap") return false;
  const entry = typeof netnsEntry === "string" && netnsEntry ? netnsEntry : PI_NETNS_ENTRY;
  if (!argv.some((a) => typeof a === "string" && (a === entry || a.endsWith(entry)))) return false;
  const at = argv.indexOf("--chdir");
  if (at < 0 || at + 1 >= argv.length) return false;
  const dir = argv[at + 1];
  if (typeof dir !== "string" || !dir) return false;
  const roots = [];
  if (typeof crowHome === "string" && crowHome) roots.push(join(crowHome, "bundles"));
  if (typeof appRoot === "string" && appRoot) roots.push(join(appRoot, "bundles"));
  return roots.some((root) => isWithin(dir, root));
}

/** SIGTERM the orphaned bwrap wrappers an earlier gateway left behind. */
export function sweepOrphanAddonWrappers({ selfPid = process.pid } = {}) {
  let killed = 0;
  // A gateway that is PID 1 in a container owns its ppid-1 children: they are
  // its own, never another process's orphans.
  if (selfPid === 1) return 0;
  let procs = [];
  try { procs = dep("listProcs", listProcsReal)() || []; } catch { return 0; }
  const crowHome = resolveCrowHome();
  const killPid = dep("killPid", (pid) => process.kill(pid, "SIGTERM"));
  for (const proc of procs) {
    if (!proc || !Number.isInteger(proc.pid) || proc.pid === process.pid) continue;
    if (!isOrphanAddonWrapper({ ppid: proc.ppid, argv: proc.argv, crowHome, appRoot: APP_ROOT, netnsEntry: PI_NETNS_ENTRY })) continue;
    try {
      console.log(`  [proxy] Killing stale walled add-on wrapper PID ${proc.pid}`);
      killPid(proc.pid);
      killed++;
    } catch { /* it may have gone already */ }
  }
  return killed;
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
    await loadSatelliteServers();
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
  // Then the satellite-hosted bundles, so their entries come AFTER every local source.
  await loadSatelliteServers();
  } finally {
    _markAddonsSettled();
  }
}

/**
 * Load the satellite-hosted bundles as tool entries (spec §9.1). Runs after every local source;
 * never fatal: a host with no satellites, or satellite tables not migrated yet, has no entries.
 */
async function loadSatelliteServers() {
  try {
    const { bundles } = await refreshSatelliteEntries();
    if (bundles) console.log(`[proxy] ${bundles} satellite bundle(s) published as tools`);
  } catch (err) {
    console.warn(`  [proxy] satellite tools unavailable: ${err.message}`);
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
    // A satellite-hosted bundle is not a local add-on: its tools come from the satellite entry
    // (satellites/tool-entry.js), never from a spawn here (spec §8, §9.1).
    if (config?.transport === "satellite") continue;
    // A service add-on without its fields is connected per project, not Crow-wide.
    if (!isLegacyConfiguredAddon(id, config)) {
      console.log(`  [proxy] addon ${id}: skipped (service: its account fields are not set)`);
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
  // The key that makes an approval unforgeable lives outside crow.db, under
  // this instance's home (resolved here, at call time, like every instance path).
  const crowHome = resolveSharedCrowHome();
  try {
    db = createDbClient();
    const { rows } = await db.execute(
      "SELECT * FROM data_backends WHERE backend_type = 'mcp_server'"
    );

    // A row that is gone must not leave its nonce in the record: with the nonce
    // still on record, putting the same row back (same id, same connection_ref,
    // same old `hmac1:` value) would verify again. Every delete path clears its
    // own entries; this is the backstop for the ones that could not, and for
    // entries left by an older Crow. One write, only when something is stale.
    try {
      const stale = await pruneApprovalNonces(rows.map((r) => r.id), { crowHome });
      if (stale) console.log(`[proxy] dropped ${stale} approval record entr${stale === 1 ? "y" : "ies"} for backends that no longer exist`);
    } catch {
      console.warn("[proxy] could not prune the data-backend approval record");
    }

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
      // The check covers the stored text and the contents of the files it runs,
      // keyed with a secret kept outside crow.db.
      //
      // A bare-64-hex value is what older versions stored: recomputable from the
      // row itself, so a crow.db writer could forge it. It is not an approval;
      // the row is stopped and the owner is told to approve it again (the value
      // is left alone: nothing is deleted).
      if (isLegacyApproval(row)) {
        if (row.status !== PENDING_STATUS || row.last_error !== LEGACY_APPROVAL_MESSAGE) {
          await db.execute({
            sql: "UPDATE data_backends SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?",
            args: [PENDING_STATUS, LEGACY_APPROVAL_MESSAGE, row.id],
          });
        }
        console.warn(`  [proxy] Backend #${row.id} "${row.name}": approved before approvals were keyed — not started`);
        continue;
      }
      if (!isApproved(row, { crowHome })) {
        // Four different situations, four different sentences: never approved;
        // a value made for another row (the key and other rows' nonces are here,
        // this row's is not: copied or forged) — checked BEFORE the restore case,
        // which a copied value looks like from this row alone; approved but this
        // machine cannot check it (no key or an empty record, e.g. a restore,
        // since secrets/ is never backed up); approved here but what it pins
        // changed.
        const why = !hasApproval(row)
          ? "Waiting for the owner to approve it on the Projects page"
          : approvalForAnotherBackend(row, { crowHome })
            ? NOT_FOR_THIS_BACKEND_MESSAGE
            : approvalNotFromThisMachine(row, { crowHome })
              ? MACHINE_APPROVAL_MESSAGE
              : "Changed since it was approved (its command or a file it runs) — approve it again on the Projects page";
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
        preSpawn: () => prepareSpawn(fresh, undefined, { crowHome }),
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
  // connectedServers fills in connect-completion order). Satellite entries come
  // AFTER every local one, so a residual name clash keeps the LOCAL tool.
  const sources = [...sortedServers(connectedServers)];
  const ordered = [...sources.filter(([, e]) => !e.isSatellite), ...sources.filter(([, e]) => e.isSatellite)];
  for (const [integrationId, entry] of ordered) {
    if (entry.status !== "connected" || !entry.client) continue;
    if (filter?.allowSources && !filter.allowSources.includes(integrationId)) continue;
    if (filter?.denySources?.includes(integrationId)) continue;
    // A paired peer never sees a satellite's tools (spec §9.2).
    if (!satelliteVisible(entry)) continue;
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
