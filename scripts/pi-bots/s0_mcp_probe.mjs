#!/usr/bin/env node
/**
 * S0 spike — Crow Bot Builder.
 *
 * Dependency-free MCP stdio probe. Spawns a Crow MCP-server bundle exactly the
 * way pi-lab/mcp-client.ts would (command/args/cwd/env), then speaks
 * newline-delimited JSON-RPC 2.0 (the wire format StdioServerTransport uses):
 * initialize -> notifications/initialized -> tools/list -> tools/call.
 *
 * Purpose: prove pi's *substrate* (the Crow tool plane against the LIVE
 * ~/.crow-mpa databases under node v20.20.2) works with NO pi and NO LLM —
 * the cheap gate that must pass before any full pi run is burned.
 *
 * Usage:
 *   node s0_mcp_probe.mjs tasks
 *   node s0_mcp_probe.mjs bots-sql
 *
 * Exit 0 + "S0-PROBE OK" on success; non-zero + diagnostic on failure.
 */

import { resolveNodeBin, requirePiCli } from "./pi_resolver.mjs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();

// Mirrors the live ~/.crow-mpa/mcp-addons.json launch config, but with the
// db-path env set EXPLICITLY to the live MPA databases (the whole point of S0:
// the current ~/.pi/agent/mcp.json points at the wrong ./data/crow.db).
const TARGETS = {
  tasks: {
    cwd: `${HOME}/.crow-mpa/bundles/tasks`,
    args: ["server/index.js"],
    env: { CROW_TASKS_DB_PATH: `${HOME}/.crow-mpa/data/tasks.db` },
    expectTool: "tasks_list",
    call: { name: "tasks_list", arguments: {} },
  },
  "bots-sql": {
    cwd: `${HOME}/.crow-mpa/bundles/bots-sql-mcp`,
    args: ["server/index.js"],
    env: { CROW_DB_PATH: `${HOME}/.crow-mpa/data/crow.db` },
    expectTool: null, // discovered & reported; bots-sql is the "router/data" plane
    call: null,
  },
};

const which = process.argv[2];
const t = TARGETS[which];
if (!t) {
  console.error(`usage: node s0_mcp_probe.mjs <${Object.keys(TARGETS).join("|")}>`);
  process.exit(2);
}

const NODE = resolveNodeBin();

const child = spawn(NODE, t.args, {
  cwd: t.cwd,
  env: { ...process.env, ...t.env },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

// --- newline-delimited JSON-RPC plumbing ---
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
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (stderr: ${stderr.slice(-400)})`));
      }
    }, 20000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const fail = (m) => { console.error(`S0-PROBE FAIL [${which}]: ${m}`); child.kill("SIGKILL"); process.exit(1); };

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "s0-probe", version: "0" },
  });
  notify("notifications/initialized", {});
  const serverName = init?.serverInfo?.name ?? "?";

  const list = await rpc("tools/list", {});
  const tools = (list?.tools ?? []).map((x) => x.name);
  console.log(`[${which}] server=${serverName} tools(${tools.length}): ${tools.join(", ")}`);

  if (t.expectTool && !tools.includes(t.expectTool)) {
    fail(`expected tool '${t.expectTool}' not in tools/list`);
  }

  if (t.call) {
    const res = await rpc("tools/call", { name: t.call.name, arguments: t.call.arguments });
    const text = (res?.content ?? []).map((c) => c.text ?? "").join("\n");
    const preview = text.slice(0, 600).replace(/\n/g, " ");
    console.log(`[${which}] ${t.call.name} -> isError=${!!res?.isError} ${preview}`);
    if (res?.isError) fail(`${t.call.name} returned isError`);
  }

  console.log(`S0-PROBE OK [${which}] (db env: ${JSON.stringify(t.env)})`);
  child.kill("SIGTERM");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
