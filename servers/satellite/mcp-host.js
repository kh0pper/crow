/**
 * Add-on MCP servers on a satellite (SAT-6, spec §5.2, §7.0 item 4, §7.3, §9.3).
 *
 * Children: every installed bundle's MCP server (its mcp-addons.json entry, the full-Crow
 * format) is a stdio child started on the FIRST tools/call and stopped after IDLE_STOP_MS
 * (SIGTERM, then SIGKILL after KILL_GRACE_MS). One child per bundle, shared by concurrent
 * callers (the caller is per request, in _meta). At most MAX_CHILDREN at once: a start beyond
 * that stops the least recently used idle child, or is refused while every child is busy.
 * Children get NODE_OPTIONS=--max-old-space-size=48. The MCP SDK's StdioClientTransport is used
 * directly: gateway/proxy.js cannot be imported without crow.db.
 *
 * Admission (§7.0 item 4, reservation-based): a bundle's reservation already includes one MCP
 * child, so its own child needs only MemAvailable ≥ CHILD_FLOOR_MB (32). A child that starts
 * while another bundle's child is running is a second concurrent child and needs
 * MemAvailable ≥ its mcp.mem_mb + 32. Below that: isError LOW_MEMORY_TEXT. Swap never counts.
 *
 * tool_cache: on install and on every bundle version change the child is started once, its
 * tools/list (all pages) is stored as JSON with sha256Hex(canonicalJson(tools)), and it is
 * stopped. tools/list is always answered from that cache (crow pins the hash), never a child.
 *
 * The HTTP side (POST /satellite/v1/mcp/:bundle) is registerMcpRoutes below: a fresh SDK
 * Streamable HTTP transport per request in stateless JSON mode, the whole answer buffered,
 * capped and signed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListToolsRequestSchema, ListToolsResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, RESULT_CAP_BYTES, sha256Hex } from "../shared/satellite-protocol.js";
import { checkLauncherArgs, resolveAddonCommand } from "../shared/resolve-command.js";
import { installedPath, readInstalled } from "../gateway/bundle-core.js";
import { memAvailableMb } from "./gate.js";
import { readTextOrNull } from "./status.js";

export const IDLE_STOP_MS = 10 * 60000;
export const KILL_GRACE_MS = 5000;
export const MAX_CHILDREN = 2;
export const CHILD_NODE_OPTIONS = "--max-old-space-size=48";
export const CHILD_FLOOR_MB = 32;
export const CONNECT_TIMEOUT_MS = 30000;
export const CALL_TIMEOUT_MS = 120000;
export const LOW_MEMORY_TEXT = "This server is low on memory right now";
export const BUSY_TEXT = "This server is busy right now; try again shortly";
export const START_FAILED_TEXT = "This extension's server could not start";
const BUNDLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CROW_META = "crow.dev/";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };
const errorText = (text) => ({ content: [{ type: "text", text }], isError: true });

class HostRefusal extends Error {
  constructor(text) { super(text); this.text = text; }
}

/**
 * The _meta a child sees (§9.3): the client's own keys except any crow.dev/* (and progressToken:
 * progress is dropped on a satellite), then crow.dev/caller (bot | owner-local | owner-remote)
 * and, for a bot, crow.dev/bot_id, from the SIGNED caller.
 */
export function callerMeta(satCaller, clientMeta) {
  const out = {};
  for (const [k, v] of Object.entries(isObj(clientMeta) ? clientMeta : {})) {
    if (k.startsWith(CROW_META) || k === "progressToken") continue;
    out[k] = v;
  }
  const c = String(satCaller || "");
  if (c.startsWith("bot:")) {
    out["crow.dev/caller"] = "bot";
    out["crow.dev/bot_id"] = c.slice(4);
  } else {
    out["crow.dev/caller"] = c;
  }
  return out;
}

/**
 * A tools/call result as a satellite answers it: text content only (any other item dropped, one
 * text note says how many), then the 256 KiB cap on the whole JSON-RPC answer for `requestId`.
 */
export function shapeResult(result, requestId) {
  const items = Array.isArray(result?.content) ? result.content : [];
  const isText = (c) => c?.type === "text" && typeof c.text === "string";
  const text = items.filter(isText);
  const dropped = items.filter((c) => !isText(c));
  const content = dropped.length
    ? [...text, { type: "text", text: `[${dropped.length} non-text item${dropped.length === 1 ? "" : "s"} dropped (${[...new Set(dropped.map((c) => String(c?.type || "unknown")))].join(", ")}): this server returns text only]` }]
    : text;
  const out = { ...result, content };
  const size = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: requestId ?? null, result: out }));
  if (size > RESULT_CAP_BYTES) return errorText(`result too large (${Math.ceil(size / 1024)} KiB)`);
  return out;
}

/**
 * The child manager + tool cache for one satellite. `readText` reads /proc/meminfo (injectable);
 * `manifestFor(id)` → the installed manifest (for mcp.mem_mb); `baseEnv` is what a child inherits.
 */
export function createMcpHost({
  db, satHome, readText = readTextOrNull, manifestFor = () => null, baseEnv = process.env, log = console.warn,
  idleMs = IDLE_STOP_MS, killGraceMs = KILL_GRACE_MS, maxChildren = MAX_CHILDREN,
  connectTimeoutMs = CONNECT_TIMEOUT_MS, callTimeoutMs = CALL_TIMEOUT_MS,
}) {
  const children = new Map(); // bundle id → entry
  let clock = 0; // LRU order (monotonic, never wall time)
  let closed = false;
  const addonsPath = join(satHome, "mcp-addons.json");
  const configOf = (id) => {
    const c = readJson(addonsPath, {})?.[id];
    return isObj(c) && typeof c.command === "string" && String(c.transport || "stdio").toLowerCase() === "stdio" ? c : null;
  };
  const memMbOf = (id) => { const v = Number(manifestFor(id)?.mcp?.mem_mb); return Number.isFinite(v) && v > 0 ? v : 0; };

  const getCache = db.prepare("SELECT bundle, version, tools_json, sha256, cached_at FROM tool_cache WHERE bundle = ?");
  const putCache = db.prepare(`INSERT INTO tool_cache (bundle, version, tools_json, sha256, cached_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bundle) DO UPDATE SET version = excluded.version, tools_json = excluded.tools_json, sha256 = excluded.sha256, cached_at = excluded.cached_at`);
  const delCache = db.prepare("DELETE FROM tool_cache WHERE bundle = ?");
  const allCache = db.prepare("SELECT bundle, version, sha256 FROM tool_cache ORDER BY bundle");

  function spawnChild(id, config) {
    const cwd = join(satHome, "bundles", id);
    const rc = resolveAddonCommand(config.command, { sha256: config.command_sha256, cwd });
    const argProblem = rc.missing ? null : checkLauncherArgs(rc.command, config.args);
    if (rc.missing || argProblem) throw new Error(`command '${config.command}' not usable: ${argProblem || rc.reason || "not found"}`);
    const env = { ...baseEnv, ...(isObj(config.env) ? config.env : {}), NODE_OPTIONS: CHILD_NODE_OPTIONS, CROW_ADDON_HOST: "satellite" };
    const transport = new StdioClientTransport({ command: rc.command, args: Array.isArray(config.args) ? config.args : [], env, cwd, stderr: "ignore" });
    const entry = { id, transport, client: null, pid: null, inflight: 0, lastUsed: ++clock, idleTimer: null, stopping: null };
    entry.exited = new Promise((resolve) => { entry.markExited = resolve; });
    // Set before connect: the SDK chains its own close handler after this one.
    transport.onclose = () => {
      entry.markExited();
      if (children.get(id) === entry) children.delete(id);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    };
    transport.onerror = () => {};
    const client = new Client({ name: `crow-satellite-${id}`, version: "0.1.0" });
    entry.client = client;
    let timer;
    entry.ready = Promise.race([
      client.connect(transport),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`connect timed out (${connectTimeoutMs} ms)`)), connectTimeoutMs); timer.unref?.(); }),
    ]).then(() => { clearTimeout(timer); entry.pid = transport.pid; }, async (err) => {
      clearTimeout(timer);
      entry.pid = transport.pid;
      await stopEntry(entry);
      throw err;
    });
    return entry;
  }

  /** SIGTERM, SIGKILL after the grace; resolves once the child is gone. */
  function stopEntry(entry) {
    if (entry.stopping) return entry.stopping;
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    entry.stopping = (async () => {
      const pid = entry.transport.pid ?? entry.pid;
      if (pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        let t;
        const graced = await Promise.race([entry.exited.then(() => true), new Promise((r) => { t = setTimeout(() => r(false), killGraceMs); })]);
        clearTimeout(t);
        if (!graced) {
          try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
          let t2;
          await Promise.race([entry.exited, new Promise((r) => { t2 = setTimeout(r, 2000); })]);
          clearTimeout(t2);
        }
      } else {
        try { await entry.transport.close(); } catch { /* never started */ }
      }
      entry.markExited();
      if (children.get(entry.id) === entry) children.delete(entry.id);
    })();
    return entry.stopping;
  }

  function armIdle(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.inflight === 0 && children.get(entry.id) === entry) stopEntry(entry).catch(() => {});
    }, idleMs);
    entry.idleTimer.unref?.();
  }

  /** → a lease {client, release()} on the bundle's running child, starting it if admitted. */
  async function acquire(id) {
    if (closed) throw new HostRefusal(START_FAILED_TEXT);
    for (;;) {
      const have = children.get(id);
      if (have && !have.stopping) {
        have.inflight++;
        have.lastUsed = ++clock;
        if (have.idleTimer) { clearTimeout(have.idleTimer); have.idleTimer = null; }
        try {
          await have.ready;
        } catch {
          have.inflight--;
          throw new HostRefusal(START_FAILED_TEXT);
        }
        return lease(have);
      }
      if (have?.stopping) { await have.stopping; continue; }
      const config = configOf(id);
      if (!config) throw new HostRefusal(START_FAILED_TEXT);
      const live = [...children.values()];
      if (live.length >= maxChildren) {
        const idle = live.filter((e) => e.inflight === 0 && !e.stopping).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new HostRefusal(BUSY_TEXT);
        await stopEntry(idle);
        continue; // re-check: another caller may have started this bundle meanwhile
      }
      const avail = memAvailableMb(readText("/proc/meminfo"));
      const need = live.length ? memMbOf(id) + CHILD_FLOOR_MB : CHILD_FLOOR_MB;
      if (avail === null || avail < need) throw new HostRefusal(LOW_MEMORY_TEXT);
      let entry;
      try {
        entry = spawnChild(id, config);
      } catch (err) {
        log(`[satellite mcp] ${id}: ${String(err?.message || err).slice(0, 300)}`);
        throw new HostRefusal(START_FAILED_TEXT);
      }
      children.set(id, entry);
      entry.ready.catch((err) => log(`[satellite mcp] ${id}: start failed: ${String(err?.message || err).slice(0, 300)}`));
    }
  }

  function lease(entry) {
    let done = false;
    return {
      client: entry.client,
      release() {
        if (done) return;
        done = true;
        entry.inflight--;
        entry.lastUsed = ++clock;
        if (entry.inflight === 0 && !entry.stopping) armIdle(entry);
      },
    };
  }

  // ── tool cache ─────────────────────────────────────────────────────────────
  function cached(id) {
    const row = getCache.get(id);
    if (!row) return null;
    try { return { version: row.version, sha256: row.sha256, tools: JSON.parse(row.tools_json) }; } catch { return null; }
  }

  /** Start the child once, store its whole tools/list, stop it (unless a caller is using it). */
  async function refreshToolCache(id, version) {
    const l = await acquire(id);
    let tools = [];
    try {
      let cursor;
      for (let page = 0; page < 100; page++) {
        const r = await l.client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, ListToolsResultSchema, { timeout: callTimeoutMs });
        tools.push(...(r.tools || []));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
    } finally {
      l.release();
    }
    tools = JSON.parse(JSON.stringify(tools)); // plain JSON values only (canonicalJson refuses undefined)
    const sha256 = sha256Hex(canonicalJson(tools));
    putCache.run(id, version == null ? null : String(version), JSON.stringify(tools), sha256, new Date().toISOString());
    const e = children.get(id);
    if (e && e.inflight === 0) await stopEntry(e);
    return { count: tools.length, sha256 };
  }

  /** Every installed bundle with an MCP entry whose cache is missing or for another version. */
  async function reconcile() {
    const list = readInstalled(installedPath(satHome));
    for (const rec of list) {
      if (closed) return;
      if (!configOf(rec.id)) continue;
      const c = getCache.get(rec.id);
      if (c && c.version === (rec.version == null ? null : String(rec.version))) continue;
      try {
        await refreshToolCache(rec.id, rec.version);
      } catch (err) {
        log(`[satellite mcp] ${rec.id}: tool cache refresh failed: ${String(err?.message || err?.text || err).slice(0, 300)}`);
      }
    }
  }

  async function removeBundle(id) {
    const e = children.get(id);
    if (e) await stopEntry(e);
    delCache.run(id);
  }

  /** One tools/call, already shaped (text only, capped). Refusals come back as isError results. */
  async function callTool(id, params, satCaller, requestId) {
    const tools = cached(id)?.tools || [];
    if (!tools.some((t) => t?.name === params?.name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${String(params?.name).slice(0, 100)}`);
    let l;
    try {
      l = await acquire(id);
    } catch (err) {
      if (err instanceof HostRefusal) return errorText(err.text);
      throw err;
    }
    try {
      const forwarded = { name: params.name, arguments: isObj(params.arguments) ? params.arguments : {}, _meta: callerMeta(satCaller, params._meta) };
      const result = await l.client.request({ method: "tools/call", params: forwarded }, CallToolResultSchema, { timeout: callTimeoutMs });
      return shapeResult(result, requestId);
    } finally {
      l.release();
    }
  }

  return {
    acquire,
    callTool,
    cached,
    refreshToolCache,
    reconcile,
    removeBundle,
    /** The running child's pid for gate.js's current-use reader ([] when none). */
    pids: (id) => { const e = children.get(id); return e?.pid && !e.stopping ? [e.pid] : []; },
    running: () => [...children.keys()],
    toolsStatus: () => Object.fromEntries(allCache.all().map((r) => [r.bundle, { version: r.version, sha256: r.sha256 }])),
    async stopAll() {
      closed = true;
      await Promise.all([...children.values()].map((e) => stopEntry(e)));
    },
  };
}

/**
 * POST /satellite/v1/mcp/:bundle on the signed router (every caller kind may call: bots and
 * owners). GET / DELETE → 405 (no SSE stream, no session). The SDK's web-standard Streamable HTTP
 * transport (the core of StreamableHTTPServerTransport) runs fresh per request with
 * sessionIdGenerator undefined and enableJsonResponse true, so its answer is one complete JSON
 * Response that is read whole, size-checked and sent through sendSigned. crow sends
 * `Accept: application/json` only (§5.2); the transport's Accept check wants both types, so the
 * request it sees carries both (the answer is JSON either way).
 */
export function registerMcpRoutes(router, { host, satHome, sendSigned }) {
  const installed = (id) => readInstalled(installedPath(satHome)).some((b) => b.id === id);
  const hasServer = (id) => { const c = readJson(join(satHome, "mcp-addons.json"), {})?.[id]; return isObj(c) && typeof c.command === "string"; };

  router.post("/mcp/:bundle", async (req, res, next) => {
    const id = req.params.bundle;
    if (!BUNDLE_ID.test(id) || !installed(id) || !hasServer(id)) return sendSigned(res, 404, { error: "unknown_bundle" });
    let server;
    let transport;
    try {
      server = new Server({ name: `crow-satellite-${id}`, version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const c = host.cached(id);
        if (!c) throw new McpError(ErrorCode.InternalError, "This extension's tool list is not cached yet; try again shortly");
        return { tools: c.tools };
      });
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => host.callTool(id, request.params, req.satCaller, extra.requestId));
      transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
      const pv = req.get("mcp-protocol-version");
      if (pv) headers["mcp-protocol-version"] = pv;
      const webReq = new Request(`http://satellite.invalid/satellite/v1/mcp/${id}`, { method: "POST", headers, body: Buffer.isBuffer(req.body) ? req.body : "" });
      const answer = await transport.handleRequest(webReq, { parsedBody: req.satBody });
      const text = await answer.text();
      if (Buffer.byteLength(text) > RESULT_CAP_BYTES) return sendSigned(res, 413, { error: "result_too_large", kib: Math.ceil(Buffer.byteLength(text) / 1024) });
      let body = {};
      if (text) {
        try { body = JSON.parse(text); } catch { return sendSigned(res, 502, { error: "bad_mcp_answer" }); }
      }
      return sendSigned(res, answer.status, body);
    } catch (err) {
      return next(err);
    } finally {
      try { await transport?.close(); } catch { /* closed */ }
      try { await server?.close(); } catch { /* closed */ }
    }
  });
  router.all("/mcp/:bundle", (_req, res) => sendSigned(res, 405, { error: "method_not_allowed" }));
}
