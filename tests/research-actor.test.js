// Who is calling the project server (owner, a bot, or unknown) and the server readying its own
// provenance schema at construction. Owner is never inferred from a missing actor; per-call
// `_meta` can only downgrade; a peer-instance caller is checked before `_meta`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  OWNER, UNKNOWN, actorFromEnv, resolveCallActor, forwardActorMeta, actorLabel, auditActor,
} from "../servers/research/actor.js";
import { createProjectServer } from "../servers/research/server.js";
import { PROVENANCE_COLUMNS } from "../servers/research/provenance-schema.js";
import { makePre0013Db, makeOldFkDb } from "./helpers/research-fixtures.js";
import { buildBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";
import { CORE_SERVERS, COMBINED_SERVER } from "../scripts/server-registry.js";

const REPO = new URL("..", import.meta.url).pathname;
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "research-actor-"));
  dirs.push(d);
  return d;
}

function columns(path) {
  const db = new Database(path, { readonly: true });
  try {
    const out = new Set();
    for (const t of ["research_sources", "research_notes"]) {
      for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) out.add(`${t}.${c.name}`);
    }
    return out;
  } finally {
    db.close();
  }
}

test("actorFromEnv: bot env, explicit owner, and nothing", () => {
  assert.deepEqual(actorFromEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "hank" }), { kind: "bot", id: "hank" });
  assert.equal(actorFromEnv({ CROW_ACTOR_KIND: "owner" }).kind, "owner");
  assert.equal(actorFromEnv({}).kind, "unknown");
  assert.equal(actorFromEnv(undefined).kind, "unknown");
  assert.equal(actorFromEnv({ CROW_ACTOR_KIND: "bot" }).kind, "unknown"); // no id
  assert.equal(actorFromEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "" }).kind, "unknown");
});

test("_meta can downgrade but never upgrade; a peer is checked first", () => {
  assert.equal(resolveCallActor(OWNER, { _meta: { "crow/actor": { kind: "bot", id: "b1" } } }).id, "b1");
  assert.equal(resolveCallActor(UNKNOWN, { _meta: { "crow/actor": { kind: "owner" } } }).kind, "unknown");
  assert.equal(resolveCallActor(OWNER, { _meta: { "crow/actor": { kind: "owner" } } }).kind, "unknown");
  assert.equal(resolveCallActor(OWNER, { authInfo: { token: "peer-instance" } }).kind, "unknown");
  assert.equal(resolveCallActor(OWNER, { authInfo: { token: "peer-instance" }, _meta: { "crow/actor": { kind: "bot", id: "x" } } }).kind, "unknown");
  assert.equal(resolveCallActor({ kind: "bot", id: "b2" }, { _meta: { "crow/actor": { kind: "bot", id: "b9" } } }).id, "b2");
  assert.equal(resolveCallActor(OWNER, {}).kind, "owner");
  assert.equal(resolveCallActor(OWNER, undefined).kind, "owner");
  assert.equal(resolveCallActor(undefined, {}).kind, "unknown");
  assert.deepEqual(resolveCallActor(UNKNOWN, { _meta: { "crow/actor": { kind: "bot", id: 7 } } }), { kind: "bot", id: "7" });
});

test("forwardActorMeta passes a bot through and turns a peer into kind peer", () => {
  assert.deepEqual(forwardActorMeta({ _meta: { "crow/actor": { kind: "bot", id: "b1" } } }), { _meta: { "crow/actor": { kind: "bot", id: "b1" } } });
  assert.deepEqual(forwardActorMeta({ authInfo: { token: "peer-instance" } }), { _meta: { "crow/actor": { kind: "peer" } } });
  assert.deepEqual(forwardActorMeta({ authInfo: { token: "peer-instance" }, _meta: { "crow/actor": { kind: "bot", id: "b1" } } }), { _meta: { "crow/actor": { kind: "peer" } } });
  assert.deepEqual(forwardActorMeta({}), {});
  assert.deepEqual(forwardActorMeta(undefined), {});
});

test("actorLabel and auditActor", () => {
  assert.equal(actorLabel(OWNER), "owner");
  assert.equal(actorLabel({ kind: "bot", id: "b1" }), "bot:b1");
  assert.equal(actorLabel(UNKNOWN), null);
  assert.deepEqual(auditActor(OWNER), { actor_type: "local", actor_id: null });
  assert.deepEqual(auditActor({ kind: "bot", id: "b1" }), { actor_type: "bot", actor_id: "b1" });
  assert.deepEqual(auditActor(UNKNOWN), { actor_type: "local", actor_id: "unknown" });
});

test("the wiring passes the actor at every construction site", () => {
  const index = read("servers/research/index.js");
  assert.match(index, /createProjectServer\(undefined, \{[^}]*actor: actorFromEnv\(process\.env\)/);

  const core = read("servers/core/server.js");
  assert.match(core, /actorFromEnv\(process\.env\)/);

  const mounts = read("servers/gateway/boot/mcp-mounts.js");
  assert.match(mounts, /const mountActor = noAuth \? UNKNOWN : OWNER/);
  assert.match(mounts, /createProjectServer\(undefined, \{ instructions, actor: mountActor \}\)/);
  assert.match(mounts, /createRouterServer\(\{ instructions: routerInstructions, actor: mountActor \}\)/);

  const router = read("servers/gateway/router.js");
  assert.match(router, /actor: options\.actor \|\| UNKNOWN/);
  assert.match(router, /\.\.\.forwardActorMeta\(extra\)/);
  assert.match(router, /async \(\{ action, params \}, extra\) =>/);

  const exec = read("servers/gateway/ai/tool-executor.js");
  assert.match(exec, /kind: "bot", id: boundBotId/);
  assert.match(exec, /projects: \{ actor: boundBotId \? \{ kind: "bot", id: boundBotId \} : undefined \}/);
});

test("the server readies its own schema at construction", () => {
  const dir = tmp();
  const pre = makePre0013Db(join(dir, "pre.db"));
  const server = createProjectServer(pre, { actor: OWNER });
  const have = columns(pre);
  for (const { table, column } of PROVENANCE_COLUMNS) assert.ok(have.has(`${table}.${column}`), `${table}.${column}`);
  assert.equal(server.research.schema.ready, true);
  assert.equal(server.research.actor.kind, "owner");

  const oldFk = makeOldFkDb(join(dir, "old.db"));
  const before = columns(oldFk);
  let s2;
  assert.doesNotThrow(() => { s2 = createProjectServer(oldFk); });
  assert.deepEqual(columns(oldFk), before);
  assert.equal(s2.research.schema.ready, false);
  assert.equal(s2.research.schema.state, "deferred");
  assert.equal(s2.research.actor.kind, "unknown");
  // callActor resolves per call against the stored base actor
  assert.equal(s2.research.callActor({ _meta: { "crow/actor": { kind: "bot", id: "b3" } } }).id, "b3");
});

test("the generated owner config marks crow-projects as owner; bot configs never carry it", () => {
  const gen = (extra) => JSON.parse(execFileSync(process.execPath, ["scripts/generate-mcp-config.js", "--stdout", ...extra], { cwd: REPO, encoding: "utf8" }));
  assert.equal(gen([]).mcpServers["crow-projects"].env.CROW_ACTOR_KIND, "owner");
  assert.equal(gen(["--combined"]).mcpServers["crow-core"].env.CROW_ACTOR_KIND, "owner");

  const projects = CORE_SERVERS.find((s) => s.name === "crow-projects");
  assert.equal(projects.mcpEnv.CROW_ACTOR_KIND, undefined);
  assert.equal(COMBINED_SERVER.mcpEnv.CROW_ACTOR_KIND, undefined);

  const def = { tools: { crow_mcp: ["crow-projects"] } };
  const canonical = { mcpServers: { "crow-projects": { command: "node", env: { CROW_ACTOR_KIND: "owner" } } } };
  const { json } = buildBotMcp(def, canonical, {});
  assert.equal((json.mcpServers["crow-projects"].env || {}).CROW_ACTOR_KIND, undefined);
  // the canonical object is never mutated
  assert.equal(canonical.mcpServers["crow-projects"].env.CROW_ACTOR_KIND, "owner");

  // with a bot actor the bot env lands as usual
  const withBot = buildBotMcp(def, canonical, { actor: { botId: "b1", displayName: "B" } });
  assert.equal(withBot.json.mcpServers["crow-projects"].env.CROW_ACTOR_KIND, "bot");
});

test("refreshSchema retries the ensure at most once per 30 s per path while not ready", () => {
  const dir = tmp();
  const p = join(dir, "later.db");
  new Database(p).close(); // no research tables yet: the ensure defers
  let t = 1_000_000;
  const now = () => t;
  const server = createProjectServer(p, { now });
  assert.equal(server.research.schema.ready, false);
  assert.equal(server.research.schema.state, "deferred");

  makePre0013Db(p); // the tables arrive; a real attempt would now succeed
  t += 10_000;
  assert.equal(server.research.refreshSchema().ready, false, "within 30 s: no new attempt");
  assert.equal(createProjectServer(p, { now }).research.schema.ready, false, "a new construction shares the backoff");
  assert.ok(!columns(p).has("research_sources.fetch_status"), "no ensure ran");

  t += 21_000; // 31 s after the first attempt
  assert.equal(server.research.refreshSchema().ready, true);
  assert.ok(columns(p).has("research_sources.fetch_status"));
});

test("buildBotMcp disables gateway project-tool mounts on any host and leaves other url blocks alone", () => {
  const blocks = {
    "crow-core": { url: "http://127.0.0.1:3001/router/mcp", headers: { Authorization: "Bearer x" } },
    "proj-local": { url: "http://localhost:3001/projects/mcp/" },
    "research-v6": { url: "http://[::1]:3001/research/mcp" },
    "proj-lan": { url: "http://192.0.2.10:3001/projects/mcp" },
    board: { url: "http://127.0.0.1:3001/board/mcp", headers: { Authorization: "Bearer b" } },
    artifacts: { url: "http://127.0.0.1:3001/artifacts/mcp", headers: { Authorization: "Bearer a" } },
    tailnet: { url: "https://crow.example.ts.net:8444/router/mcp", headers: { Authorization: "Bearer t" } },
    external: { url: "https://mcp.example.com/research/mcp/" },
    "tailnet-board": { url: "https://crow.example.ts.net:8444/board/mcp", headers: { Authorization: "Bearer b" } },
    other: { url: "https://mcp.example.com/mcp" },
  };
  const def = { tools: { crow_mcp: Object.keys(blocks) } };
  const { json, servers, warnings, disabled } = buildBotMcp(def, { mcpServers: blocks }, {});
  for (const name of ["crow-core", "proj-local", "research-v6", "proj-lan", "tailnet", "external"]) {
    assert.deepEqual(json.mcpServers[name], { disabled: true }, name);
    assert.ok(disabled.includes(name), name);
    assert.ok(!servers.includes(name), name);
    assert.ok(warnings.some((w) => w.includes(`'${name}'`) && /must not reach the operator's research tools with a gateway token/.test(w)), name);
  }
  for (const name of ["board", "artifacts", "tailnet-board", "other"]) {
    assert.deepEqual(json.mcpServers[name], blocks[name], name);
    assert.ok(servers.includes(name), name);
  }
});
