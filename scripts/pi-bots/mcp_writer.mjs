#!/usr/bin/env node
/**
 * Crow Bot Builder — per-bot MCP config writer + tool-list prober.
 *
 * PRECEDENCE (verified live against pi 0.82.0 + pi-lab main, 2026-08-08):
 * pi-lab/extensions/mcp-client.ts merges ~/.pi/agent/mcp.json FIRST, then every
 * cwd-ancestor .mcp.json from the filesystem root down to cwd — the NEAREST
 * project file WINS. pi-lab commit 671e116 (2026-07-04) changed this; the old
 * "homedir wins on collision" rule this file used to assert is FALSE, and
 * believing it hid three live bugs for a month. A project file may also delete
 * an inherited server with {"name": {"disabled": true}}.
 *
 * So the per-bot <session_dir>/.mcp.json is AUTHORITATIVE, and this writer
 * writes it CLOSED-WORLD: the bot's selected servers with instance-correct
 * bindings, plus {"disabled": true} for every other server named in CANONICAL
 * that pi would otherwise inherit. That makes the file the complete statement
 * of CANONICAL's world, not of the bot's actual world — pi also merges every
 * cwd-ancestor .mcp.json between the filesystem root and the session dir, and
 * a server defined only in one of THOSE files (never in canonical) is neither
 * disabled nor known here, so it can still reach the bot unnarrowed. Omission
 * of a canonical name is NOT narrowing — an unmentioned homedir server still
 * loads.
 *
 * Crow servers are never copied out of the homedir file; they are derived
 * per-instance by crow-server-catalog.mjs. See
 * docs/superpowers/specs/2026-08-08-mcp-instance-binding-design.md.
 *
 * Also exports probeServerTools(): a dependency-free MCP stdio `tools/list`
 * (initialize -> notifications/initialized -> tools/list) reusing the
 * s0_mcp_probe wire plumbing — this is the authoritative GUI tool-picker data
 * source (plan §5: pi's effective mcp.json + a LIVE per-server tools/list, NOT
 * getProxyStatus()). Each tool is flagged `hasPattern` if its inputSchema
 * contains a `pattern`/regex anywhere (drives the Phase-2.3 SOFT-WARN; S4
 * proved the crow-chat --jinja regex scar does NOT reproduce under pi).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { botsDbPath } from "./instance-paths.mjs";
import { mintRemoteBlocks } from "./remote-blocks.mjs";
import { crowServerCatalog, instanceBinding, rebindBlock } from "./crow-server-catalog.mjs";

const HOME = process.env.HOME || homedir();
export const CANONICAL_MCP_PATH = HOME + "/.pi/agent/mcp.json";

export function readCanonicalMcp(path = CANONICAL_MCP_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error("cannot read canonical mcp.json at " + path + ": " + e.message);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error("canonical mcp.json is not valid JSON: " + e.message);
  }
  if (!j || typeof j.mcpServers !== "object" || !j.mcpServers) {
    throw new Error("canonical mcp.json has no mcpServers object");
  }
  return j;
}

/** Distinct MCP server names a bot references via def.tools.crow_mcp. */
export function serversForBot(def) {
  const sel = (def && def.tools && def.tools.crow_mcp) || [];
  const set = new Set();
  for (const entry of sel) {
    if (typeof entry !== "string" || !entry) continue;
    // "server/tool" -> "server"; a bare "server" -> "server"
    set.add(entry.split("/")[0]);
  }
  return [...set];
}

/** True if a server block touches crow.db (so the journal guard applies). */
function touchesCrowDb(block) {
  return !!(block && block.env && block.env.CROW_DB_PATH);
}

// ---- A5: extension addon servers -> minted per-bot pi blocks ---------------
// A bot may select an MCP server that lives in <crowHome>/mcp-addons.json but
// is ABSENT from the canonical ~/.pi/agent/mcp.json (e.g. texas-gov-data,
// bots-sql-mcp, tasks on MPA). pi-lab's additive merge (CONFIRMED against the
// installed v0.74.2 and re-verified on v0.82.0 (2026-07-25 probe run): extensions/mcp-client.ts reverses the path list so homedir
// is Object.assign'd LAST and wins on key collision; the per-bot sessionDir
// /.mcp.json is a cwd-self entry and is the SOLE source for absent-from-homedir
// servers) means we can safely ADD such servers in the per-bot file — never
// mutating the canonical homedir config. We mint a pi-compatible block from the
// addon block, defaulting cwd exactly as the gateway proxy and pi-lab require.
//
// kept local (no ext_registry import) so the lower-level writer has no cycle.
const _HOME_FOR_CROW = HOME;
function resolveCrowHome() {
  return process.env.CROW_HOME || _HOME_FOR_CROW + "/.crow";
}
function readAddons(crowHome) {
  try {
    return JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8")) || {};
  } catch {
    return {};
  }
}
/**
 * Default an addon block's cwd the SAME way the gateway proxy does
 * (proxy.js:197) and pi-lab requires (mcp-client spawns `cwd: cfg.cwd` with NO
 * default — a cwd-less addon would run `node server/index.js` from the bot's
 * sessionDir and MODULE_NOT_FOUND). Returns a shallow copy with cwd filled.
 */
function addonSpawnBlock(serverId, block, crowHome) {
  return { ...block, cwd: block.cwd || join(crowHome, "bundles", serverId) };
}

/**
 * Mint pi-compatible blocks for the bot's selected servers that are ABSENT from
 * canonical but present in <crowHome>/mcp-addons.json. Returns a
 * {name: block} map (cwd defaulted; the journal guard is applied later by
 * buildBotMcp on the clone). Servers absent from BOTH canonical and addons are
 * left out here so buildBotMcp surfaces them as a warning.
 *
 * @param {object} opts.canonical  pre-read canonical (avoids a second read)
 */
export function extraServersFromExtensions(def, crowHome = resolveCrowHome(), opts = {}) {
  const want = serversForBot(def);
  const canonical = opts.canonical || readCanonicalMcp(opts.canonicalPath);
  const addons = readAddons(crowHome);
  const servers = {};
  for (const name of want) {
    // The catalog (crow-server-catalog.mjs) already covers every Crow server on
    // this instance and is consulted first by buildBotMcp, so this path only
    // ever fills a NON-Crow name absent from canonical. Kept as a seam for
    // callers that pass their own canonical without a catalog.
    if (canonical.mcpServers[name]) continue;
    const addon = addons[name];
    if (!addon) continue; // absent from both -> buildBotMcp warns
    servers[name] = addonSpawnBlock(name, addon, crowHome);
  }
  return servers;
}

/**
 * Build the per-bot `.mcp.json` object. CLOSED-WORLD — see the file header.
 *
 * Resolution order for a selected name:
 *   1. catalog   — instance-derived, always correct. Wins.
 *   2. canonical — for names the catalog does not know (third-party servers,
 *                  crow-browser). Rebound onto this instance as a belt.
 *   3. extraServers — the mcp-addons seam retained for callers without a catalog.
 * Then every OTHER canonical name is emitted as {"disabled": true}, because
 * canonical is exactly what pi would otherwise inherit.
 *
 * @returns {{ json, servers, warnings, journalGuarded, minted, rebound, disabled }}
 *   `servers` lists ACTIVE names only; disabled names are in `disabled`.
 */
export function buildBotMcp(def, canonical, opts = {}) {
  // opts.ensureServers (Track 3 acceptance F2): names unioned into the
  // selection BEFORE catalog resolution, so a card-bound session gets the
  // board entry (it must be able to call board_report_result — that call is
  // what ends the run) even when the def never selected board/*. An ensured
  // name absent from the catalog rides the same unconfigured/soft-warning
  // path as a selected-but-absent server.
  const ensure = (opts.ensureServers || []).filter((n) => typeof n === "string" && n);
  const want = [...new Set([...serversForBot(def), ...ensure])];
  const catalog = opts.catalog || {};
  const unconfigured = opts.unconfigured || {};
  const binding = opts.binding;
  const crowHome = opts.crowHome;
  const extra = opts.extraServers || {};
  const out = { mcpServers: {} };
  const warnings = [];
  const journalGuarded = [];
  const minted = [];
  const rebound = [];
  const disabled = [];
  const active = [];

  const disable = (name, reason) => {
    out.mcpServers[name] = { disabled: true };
    disabled.push(name);
    if (reason) warnings.push(`server '${name}' ${reason}`);
  };

  // `minted` keeps its A5 meaning: resolved from somewhere canonical does NOT
  // have it. A core server present in BOTH the catalog and canonical is not
  // minted — logging it as "minted from extensions" would be false on the
  // commonest path (bot-world.mjs and the regen message both print this).
  const noteMinted = (name) => { if (!canonical.mcpServers[name]) minted.push(name); };
  // `journalGuarded` exists to make the WAL-unlink guard OBSERVABLE, so it
  // reports every active crow.db server carrying the guard — uniformly, on
  // whichever path resolved it. Reporting only the blocks this function
  // happened to flip would hide the catalog path, which is now the common one.
  const noteGuard = (name, block) => { if (touchesCrowDb(block)) journalGuarded.push(name); };

  for (const name of want) {
    if (catalog[name]) {
      out.mcpServers[name] = catalog[name];
      active.push(name);
      noteMinted(name);
      noteGuard(name, catalog[name]);
      continue;
    }
    if (unconfigured[name]) {
      disable(name, unconfigured[name]);
      continue;
    }
    const source = canonical.mcpServers[name] || extra[name];
    if (!source) {
      warnings.push(
        "server '" + name + "' is selected but absent from the instance catalog, " +
        "canonical mcp.json AND mcp-addons.json — pi will NOT have it"
      );
      continue;
    }
    // No binding means a caller that predates instance binding (tests, CLI):
    // fall back to the old verbatim copy + journal guard rather than crash.
    if (!binding) {
      const clone = JSON.parse(JSON.stringify(source));
      if (touchesCrowDb(clone)) {
        clone.env = clone.env || {};
        if (clone.env.CROW_JOURNAL_MODE !== "DELETE") {
          clone.env.CROW_JOURNAL_MODE = "DELETE";
          journalGuarded.push(name);
        }
      }
      out.mcpServers[name] = clone;
      active.push(name);
      noteMinted(name);
      continue;
    }
    const r = rebindBlock(name, source, binding, crowHome);
    if (r.disabled) {
      disable(name, r.reason);
      continue;
    }
    if (r.rebound.length) rebound.push({ name, keys: r.rebound });
    noteGuard(name, r.block);
    out.mcpServers[name] = r.block;
    active.push(name);
    noteMinted(name);
  }

  // Closed-world. Sorted so the written file is diffable.
  const selected = new Set(want);
  for (const name of Object.keys(canonical.mcpServers).sort()) {
    if (selected.has(name)) continue;
    disable(name, null);
  }

  return { json: out, servers: active, warnings, journalGuarded, minted, rebound, disabled };
}

/**
 * Write `<session_dir>/.mcp.json` for a bot. Idempotent (full rewrite each
 * call). Throws only on a missing session_dir in the def or an unreadable
 * canonical; a selected-but-absent server is a soft warning (returned).
 *
 * M3b: callers may override session_dir via opts.sessionDir — the bridge
 * uses this when a project_space workspace resolves to a different path
 * than the legacy def.session_dir. Without the override, mcp.json drifts
 * out of sync with the actual pi cwd and the bot relies solely on the
 * canonical ~/.pi/agent/mcp.json fallback.
 */
export function writeBotMcp(def, opts = {}) {
  const sessionDir = opts.sessionDir || (def && def.session_dir);
  if (!sessionDir) throw new Error("bot def has no session_dir (and no opts.sessionDir override)");
  const canonical = opts.canonical || readCanonicalMcp(opts.canonicalPath);
  // A5: resolve the active instance + mint addon blocks for selected servers
  // absent from canonical. opts.crowHome lets the bridge/GUI/CLI pin the
  // instance explicitly; otherwise CROW_HOME env (MPA service) or ~/.crow.
  const crowHome = opts.crowHome || resolveCrowHome();
  const extraServers = opts.extraServers || extraServersFromExtensions(def, crowHome, { canonical });
  // The instance catalog is the FIRST source for any Crow server. opts.binding
  // lets tests and the panel pin an instance without mutating process.env.
  const binding = opts.binding || instanceBinding(crowHome, opts);
  // botId/jobId (Track 1 Task 7): threaded into the catalog's board entry so
  // its X-Crow-Actor-Id/X-Crow-Job-Id headers carry THIS turn's identity —
  // see crow-server-catalog.mjs's boardBlock(). Absent for callers that
  // predate the job_id plumbing (job_runner's generic runJob, the GUI regen
  // handler, the CLI): the board entry then omits those headers and
  // board-mcp.js's resolveActor falls back to actor_kind='session'.
  const { servers: catalog, unconfigured } = crowServerCatalog(crowHome, {
    binding, botId: opts.botId, jobId: opts.jobId,
  });
  const built = buildBotMcp(def, canonical, {
    extraServers, catalog, unconfigured, binding, crowHome,
    ensureServers: opts.ensureServers,
  });
  // F4a L2b: merge cross-instance forward-proxy blocks when the caller has
  // confirmed feature_flags.remote_invocation is on (the DB read is done by the
  // caller — bridge/panel/CLI — since this module is DB-agnostic). Default
  // off: callers that don't pass remoteEnabled get byte-identical output.
  let remoteWarnings = [];
  if (opts.remoteEnabled) {
    const node = opts.node || process.execPath;
    const proxyPath = opts.proxyPath || join(import.meta.dirname, "crow-remote-proxy.mjs");
    // Pin the spawned proxy to THIS instance's peer-tokens.json (peer-credentials.js
    // hardcodes ~/.crow otherwise — wrong for ~/.crow-mpa where the bot runtime lives).
    const peerTokensPath = opts.peerTokensPath || join(crowHome, "peer-tokens.json");
    const { blocks, warnings } = mintRemoteBlocks(def, {
      peerGatewayUrls: opts.peerGatewayUrls || {},
      proxyPath,
      node,
      peerTokensPath,
    });
    remoteWarnings = warnings;
    for (const [name, block] of Object.entries(blocks)) built.json.mcpServers[name] = block;
  }
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, ".mcp.json");
  writeFileSync(path, JSON.stringify(built.json, null, 2) + "\n", { mode: 0o600 });
  return {
    path,
    servers: built.servers,
    warnings: built.warnings,
    journalGuarded: built.journalGuarded,
    minted: built.minted,
    rebound: built.rebound,
    disabled: built.disabled,
    remoteWarnings,
  };
}

// ---- dependency-free MCP stdio tools/list (GUI picker source) -------------

function deepHasPattern(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 12) return false;
  if (Object.prototype.hasOwnProperty.call(schema, "pattern")) return true;
  for (const k of Object.keys(schema)) {
    const v = schema[k];
    if (v && typeof v === "object" && deepHasPattern(v, depth + 1)) return true;
  }
  return false;
}

/**
 * Live `tools/list` for a URL-based (streamable HTTP) MCP server block.
 * Mirrors the stdio probe's return shape. Never throws.
 */
async function probeHttpServerTools(block, timeoutMs) {
  let client, transport;
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const requestInit = {};
    if (block.headers && typeof block.headers === "object") requestInit.headers = block.headers;
    transport = new StreamableHTTPClientTransport(new URL(block.url), { requestInit });
    client = new Client({ name: "pibot-picker", version: "0" });
    let timer;
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("connect timeout")), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const list = await client.listTools();
    const tools = (list && list.tools ? list.tools : []).map((t) => ({
      name: t.name,
      description: (t.description || "").slice(0, 240),
      hasPattern: deepHasPattern(t.inputSchema),
    }));
    return { ok: true, serverName: block.url, tools };
  } catch (e) {
    return { ok: false, error: "http probe failed: " + (e.message || String(e)) };
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
  }
}

/**
 * Live `tools/list` for one MCP server block. Handles both stdio servers
 * (command/args/cwd/env exactly as pi-lab/mcp-client would spawn it) and
 * URL-based streamable-HTTP servers. Never throws — returns {ok:false,error}.
 * @returns {Promise<{ok:boolean, serverName?:string, tools?:Array<{name:string,description:string,hasPattern:boolean}>, error?:string}>}
 */
export function probeServerTools(block, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  // URL-based (streamable HTTP) MCP server — probe over HTTP, never stdio spawn.
  // spawn(undefined) throws "The 'file' argument must be of type string".
  if (block && block.url && !block.command) {
    return probeHttpServerTools(block, timeoutMs);
  }
  // Removed / half-installed addon: its cwd points at a bundle dir that no
  // longer exists, so spawn() would throw ENOENT ("proc error: spawn node
  // ENOENT"). Report it cleanly instead of a cryptic error / 15s hang.
  if (block && block.cwd && !existsSync(block.cwd)) {
    return Promise.resolve({ ok: false, error: "not installed (missing " + block.cwd + ")" });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve(r);
    };
    let child;
    try {
      child = spawn(block.command, block.args || [], {
        cwd: block.cwd,
        env: Object.assign({}, process.env, block.env || {}),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ ok: false, error: "spawn failed: " + e.message });
    }
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => finish({ ok: false, error: "proc error: " + e.message }));
    const hardTimer = setTimeout(
      () => finish({ ok: false, error: "timeout (stderr: " + stderr.slice(-300) + ")" }),
      timeoutMs
    );

    let buf = "";
    const pending = new Map();
    let nextId = 1;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? rj(new Error(JSON.stringify(msg.error))) : rs(msg.result);
        }
      }
    });
    const rpc = (method, params) => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((rs, rj) => {
        pending.set(id, { resolve: rs, reject: rj });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rj(new Error("rpc timeout " + method));
          }
        }, timeoutMs);
      });
    };
    const notify = (method, params) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

    (async () => {
      try {
        const init = await rpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pibot-picker", version: "0" },
        });
        notify("notifications/initialized", {});
        const list = await rpc("tools/list", {});
        clearTimeout(hardTimer);
        const tools = (list && list.tools ? list.tools : []).map((t) => ({
          name: t.name,
          description: (t.description || "").slice(0, 240),
          hasPattern: deepHasPattern(t.inputSchema),
        }));
        finish({
          ok: true,
          serverName: (init && init.serverInfo && init.serverInfo.name) || "?",
          tools,
        });
      } catch (e) {
        clearTimeout(hardTimer);
        finish({ ok: false, error: e.message + " (stderr: " + stderr.slice(-200) + ")" });
      }
    })();
  });
}

// CLI: write <botId> | probe <serverName> | list-servers
if (import.meta.url === "file://" + process.argv[1]) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  const CROW_DB = botsDbPath();
  if (cmd === "list-servers") {
    const c = readCanonicalMcp();
    console.log(Object.keys(c.mcpServers).join("\n"));
    process.exit(0);
  }
  if (cmd === "probe" && arg) {
    const c = readCanonicalMcp();
    const block = c.mcpServers[arg];
    if (!block) {
      console.error("no such server: " + arg);
      process.exit(2);
    }
    probeServerTools(block).then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    });
  } else if (cmd === "write" && arg) {
    // load the bot def from crow.db
    import("better-sqlite3").then((m) => {
      const Database = m.default;
      const d = new Database(CROW_DB);
      d.pragma("busy_timeout = 10000");
      const row = d
        .prepare("SELECT definition FROM pi_bot_defs WHERE bot_id=?")
        .get(arg);
      d.close();
      if (!row) {
        console.error("no such bot: " + arg);
        process.exit(2);
      }
      const def = JSON.parse(row.definition || "{}");
      // A5: thread the active instance (CROW_HOME env -> ~/.crow-mpa on MPA)
      // so minted addon blocks resolve against the same instance as CROW_DB.
      const res = writeBotMcp(def, { crowHome: resolveCrowHome() });
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    });
  } else {
    console.error(
      "usage: mcp_writer.mjs list-servers | probe <server> | write <botId>"
    );
    process.exit(2);
  }
}
