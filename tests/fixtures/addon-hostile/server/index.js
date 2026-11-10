#!/usr/bin/env node
/**
 * A stdio MCP add-on that spends its whole life probing its own sandbox, and
 * reports only what each call could or could not do: a boolean and an error
 * CODE, never a file's contents, a value or a path it managed to read.
 *
 * The wall briefs use it as the hostile case: it tries to read the operator's
 * secrets, another add-on's data, the docker socket and crow.db; it tries to
 * write into its own read-only code and into another add-on's folder; it tries
 * unix sockets, loopback ports, the gateway's own port, and the pid list; it
 * opens a named fd path (the forwarder's test) and, last, kills itself.
 *
 * Plain newline-delimited JSON-RPC 2.0 over stdin/stdout, dependency-free (node
 * built-ins only) so it runs inside a wall that has no node_modules.
 *
 * Tools:
 *   probe_read {path}          open(path, "r")
 *   probe_write {path}         open(path, "w") + one byte
 *   probe_connect {host, port} a TCP connect (3 s cap)
 *   probe_http {url}           a raw http.get, no proxy (5 s cap)
 *   probe_unix {path}          a connect to a unix socket (3 s cap)
 *   probe_fd_open {path}       open(path, "r"), usually /proc/<pid>/fd/<n>
 *   probe_pids()               every numeric /proc entry with its comm
 *   probe_sql()                NO_DB without CROW_DB_PATH, else an open of it
 *   crash()                    exit 70
 */

import { closeSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { get as httpGet } from "node:http";
import { connect as netConnect } from "node:net";

const SERVER_NAME = "addon-hostile";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_FALLBACK = "2025-06-18";
const CONNECT_TIMEOUT_MS = 3000;
const HTTP_TIMEOUT_MS = 5000;
const PROBE_BYTES = "x";

/** The error class of a call, never its text. */
function codeOf(err) {
  if (err && typeof err.code === "string" && err.code) return err.code;
  return "ERROR";
}

function probeRead(args) {
  try {
    closeSync(openSync(String(args?.path ?? ""), "r"));
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
}

function probeWrite(args) {
  try {
    const fd = openSync(String(args?.path ?? ""), "w");
    writeSync(fd, PROBE_BYTES);
    closeSync(fd);
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
}

function probeFdOpen(args) {
  return probeRead(args);
}

function probeConnect(args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    const socket = netConnect({ host: String(args?.host ?? ""), port: Number(args?.port) });
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => done({ ok: true, code: null }));
    socket.once("timeout", () => done({ ok: false, code: "ETIMEDOUT" }));
    socket.once("error", (err) => done({ ok: false, code: codeOf(err) }));
  });
}

function probeUnix(args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    const socket = netConnect({ path: String(args?.path ?? "") });
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => done({ ok: true, code: null }));
    socket.once("timeout", () => done({ ok: false, code: "ETIMEDOUT" }));
    socket.once("error", (err) => done({ ok: false, code: codeOf(err) }));
  });
}

function probeHttp(args) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    try {
      // No proxy, no redirect: the raw socket the namespace gives this process.
      req = httpGet(String(args?.url ?? ""), (res) => {
        res.resume();
        done({ ok: Number(res.statusCode) < 400, status: Number(res.statusCode), code: null });
      });
    } catch (err) {
      done({ ok: false, status: null, code: codeOf(err) });
      return;
    }
    req.setTimeout(HTTP_TIMEOUT_MS, () => done({ ok: false, status: null, code: "ETIMEDOUT" }));
    req.on("error", (err) => done({ ok: false, status: null, code: codeOf(err) }));
  });
}

function probePids() {
  let names = [];
  try {
    names = readdirSync("/proc");
  } catch (err) {
    return { ok: false, code: codeOf(err), pids: [] };
  }
  const pids = [];
  for (const name of names) {
    if (!/^\d+$/.test(String(name))) continue;
    let comm = null;
    try { comm = readFileSync("/proc/" + name + "/comm", "utf8").trim(); } catch { comm = null; }
    pids.push({ pid: Number(name), comm });
  }
  return { ok: true, code: null, pids, self: process.pid };
}

function probeSql() {
  const at = process.env.CROW_DB_PATH;
  if (!at) return { ok: false, code: "NO_DB" };
  try {
    closeSync(openSync(at, "r"));
    return { ok: true, code: null };
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
}

const TOOLS = [
  { name: "probe_read", description: "Open a path for reading", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "probe_write", description: "Open a path for writing", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "probe_connect", description: "Open a TCP connection", inputSchema: { type: "object", properties: { host: { type: "string" }, port: { type: "number" } }, required: ["host", "port"] } },
  { name: "probe_http", description: "One plain HTTP GET", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "probe_unix", description: "Open a unix socket", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "probe_fd_open", description: "Open a path that names an fd", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "probe_pids", description: "List the visible processes", inputSchema: { type: "object", properties: {} } },
  { name: "probe_sql", description: "Open the Crow database", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Exit at once", inputSchema: { type: "object", properties: {} } },
];

async function runTool(name, args) {
  switch (name) {
    case "probe_read": return probeRead(args);
    case "probe_write": return probeWrite(args);
    case "probe_connect": return probeConnect(args);
    case "probe_http": return probeHttp(args);
    case "probe_unix": return probeUnix(args);
    case "probe_fd_open": return probeFdOpen(args);
    case "probe_pids": return probePids();
    case "probe_sql": return probeSql();
    case "crash":
      // Nothing to answer: the point of the tool.
      process.exit(70);
      return { ok: false, code: "EXITED" };
    default:
      return { ok: false, code: "NO_SUCH_TOOL" };
  }
}

function write(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch { /* the gateway went away */ }
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  const method = message && typeof message.method === "string" ? message.method : "";
  const id = message ? message.id : undefined;
  const params = message && message.params && typeof message.params === "object" ? message.params : {};

  // A notification carries no id and is never answered.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    const version = typeof params.protocolVersion === "string" && params.protocolVersion ? params.protocolVersion : PROTOCOL_FALLBACK;
    reply(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const result = await runTool(String(params.name ?? ""), args);
    reply(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    return;
  }
  fail(id, -32601, "method not found");
}

// The one line the gateway's stderr prefixer turns into `[addon:addon-hostile] hostile-started`.
process.stderr.write("hostile-started\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).replace(/\r$/, "");
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let message = null;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message).catch(() => { /* a tool's own answer is what counts */ });
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));