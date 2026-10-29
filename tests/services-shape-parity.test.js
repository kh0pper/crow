/**
 * Project services Task 14 (fix round 1, I3): children.js shapeServiceResult mirrors the loopback
 * mount's result shaping (loopback-tool-mount.js runTool step 6, not exported there). This feeds
 * the SAME raw results through the real mount (a bare express app, a fresh init-db database, a
 * real path-scoped family token and real v3 signatures, as tests/loopback-tool-mount.test.js
 * does) and through shapeServiceResult, and requires identical answers.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const DIR = mkdtempSync(join(tmpdir(), "crow-svcshape-"));
const DB_PATH = join(DIR, "crow.db");
process.env.CROW_HOME = DIR;
process.env.CROW_DATA_DIR = DIR;
process.env.CROW_DB_PATH = DB_PATH;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });

const { createDbClient } = await import("../servers/db.js");
const { SessionManager } = await import("../servers/gateway/session-manager.js");
const { pathScopedToken } = await import("../servers/gateway/local-token.js");
const { initGatewayActorKey, _resetActorKeyForTest, signScopeActor } = await import("../scripts/pi-bots/actor-sig.mjs");
const { mountLoopbackMcp } = await import("../servers/gateway/loopback-tool-mount.js");
const { shapeServiceResult } = await import("../servers/gateway/services/children.js");

const UUID = "11111111-2222-4333-8444-555555555556";
const FAMILY = "example-shape";
const SECRETS = ["test-token-91", "test-token-91-longer"];
const MAX = 4096;

// Raw upstream results, by tool name.
const RAW = {
  plain: { content: [{ type: "text", text: "hello" }] },
  secret: { content: [{ type: "text", text: "uses test-token-91 here" }], structuredContent: { s: "test-token-91" }, _meta: { m: 1 } },
  split: { content: [{ type: "text", text: "head test-tok" }, { type: "text", text: "en-91 tail" }] },
  longest: { content: [{ type: "text", text: "x test-token-91-longer y" }] },
  iserr: { isError: true, content: [{ type: "text", text: "failed near test-token-91" }] },
  mixed: { content: [
    { type: "text", text: "kept", _meta: { a: 1 }, annotations: { b: 2 } },
    { type: "resource", resource: { uri: "file:///x", text: "dropped" } },
    { type: "weird", text: "w" },
    { type: "image", mimeType: "text/html", data: "QUJD" },
    { type: "image", mimeType: "image/png", data: "not base64!" },
    { type: "image", mimeType: "image/png", data: "QUJD", _meta: { s: 1 } },
  ] },
  big: { content: [{ type: "text", text: "x".repeat(8000) }] },
  bigimg: { content: [{ type: "text", text: "pic" }, { type: "image", mimeType: "image/jpeg", data: "A".repeat(6000) }] },
  nocontent: { result: "no content array" },
  coded: { code: "busy" },
  badcode: { code: "ECONNREFUSED" },
  empty: { content: [] },
};

let srv, base, token, sessions;

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  const d = new Database(DB_PATH);
  if (!d.prepare("PRAGMA table_info(bot_jobs)").all().some((c) => c.name === "principal")) d.exec("ALTER TABLE bot_jobs ADD COLUMN principal TEXT");
  d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('hank', 'Hank', '{}', 1, 42)").run();
  d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, worker_pid, principal) VALUES ('job-shape-1', 'hank', 'g', 'running', ?, 'owner')").run(process.pid);
  d.close();
  _resetActorKeyForTest();
  initGatewayActorKey();
  const tok = pathScopedToken({ name: FAMILY, hashKey: "mcp_example_shape_token_hash", createdKey: "mcp_example_shape_token_created", home: DIR });
  const db = createDbClient(DB_PATH);
  token = await tok.rotate(db);
  db.close();
  sessions = new SessionManager();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mountLoopbackMcp(app, {
    family: FAMILY, params: ":uuid", actorKind: "service", token: tok,
    authorize: async () => ({ ok: true, ctx: { secrets: SECRETS } }),
    upstream: {
      listTools: async () => Object.keys(RAW).map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
      callTool: async (_ctx, name) => RAW[name],
    },
    toolFilter: () => true,
    resultCap: { maxBytes: MAX, contentTypes: ["text", "image"] }, callTimeoutMs: 2000,
    sessionManager: sessions, createDbClient: () => createDbClient(DB_PATH), onAudit: () => {},
  });
  await new Promise((r) => { srv = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  await sessions?.closeAll?.();
  sessions?.dispose?.();
  await new Promise((r) => srv.close(r));
  srv.closeAllConnections?.();
  rmScratch(DIR);
});

const actor = () => {
  const tuple = { threadId: "job-job-shape-1", gatewayType: "job" };
  return {
    "x-crow-actor-kind": "service", "x-crow-actor-id": "hank", "x-crow-actor-scope": `j:job-shape-1@${process.pid}`,
    "x-crow-actor-thread": tuple.threadId, "x-crow-actor-gateway": tuple.gatewayType,
    "x-crow-actor-sig": signScopeActor({ kind: "service", botId: "hank", jobId: "job-shape-1", ...tuple }),
  };
};

let rpcId = 0;
async function rpc(body, sid) {
  const res = await fetch(`${base}/${FAMILY}/${UUID}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...actor(), ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop();
    json = data ? JSON.parse(data) : null;
  } else { try { json = JSON.parse(text); } catch { json = null; } }
  return { status: res.status, json, sid: res.headers.get("mcp-session-id") };
}

test("shapeServiceResult gives exactly the mount's answer for the same raw results", async () => {
  const init = await rpc({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.status, 200, JSON.stringify(init.json));
  for (const name of Object.keys(RAW)) {
    const r = await rpc({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: {} } }, init.sid);
    assert.equal(r.status, 200, name);
    const fromMount = r.json.result;
    const mine = shapeServiceResult(structuredClone(RAW[name]), { secrets: SECRETS, maxBytes: MAX, tool: name });
    assert.deepEqual(mine, fromMount, `parity: ${name}`);
    assert.ok(!JSON.stringify(mine).includes("test-token-91"), `${name}: no secret`);
  }
});
