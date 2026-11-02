/**
 * Project services Task 20: the dashboard chat uses its pinned project's connections and
 * nothing else does.
 *
 * A scratch Crow home and database (init-db), the fake stdio child (tests/fixtures/
 * echo-mcp-server.mjs, run by this node; never npx, uvx or a real service) as the installed
 * add-on, real connections with the owner's binding recorded, and tool caches written through
 * the real cache helper — so listing is exercised with the real children.js (which starts
 * nothing) and a call with the real ensureChild.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "echo-mcp-server.mjs");
const HOME = mkdtempSync(join(tmpdir(), "crow-svcscope-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-svcscope-data-"));
const DB_PATH = join(DATA, "crow.db");
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_PATH;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

// Dynamic imports: the gateway modules read the scratch env above at load time.
const C = await import("../servers/gateway/services/children.js");
const SC = await import("../servers/shared/service-connections.js");
const TC = await import("../servers/gateway/services/tool-cache.js");
const PT = await import("../servers/gateway/services/project-tools.js");
const SENS = await import("../servers/shared/service-sensitivity.js");
const { serviceById } = await import("../servers/shared/service-catalog.js");
const { createDbClient } = await import("../servers/db.js");
const { ensureWriteKey } = await import("../servers/gateway/keychain/store.js");
const { createToolExecutor, getChatTools } = await import("../servers/gateway/ai/tool-executor.js");
const { chatServiceScope, projectIdOfScope } = await import("../servers/gateway/routes/chat.js");

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const GH_TOKEN = "test-token-1";
const SPAWNS = join(HOME, "spawns.log");
mkdirSync(join(HOME, "secrets"), { recursive: true });
C._setChildrenForTest({ folder: { otherSecretsDirs: [] } });

// ---- scratch install: github (with the reveal tool) and notion (private by default) ----------

const knobs = { github: { reveal: true }, notion: {} };
function writeControl(id) {
  const dir = join(HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "echo-control.json"), JSON.stringify({ spawnLog: SPAWNS, ...knobs[id] }));
}
writeFileSync(join(HOME, "installed.json"), JSON.stringify(["github", "notion"].map((id) => ({ id, type: "mcp-server", version: "1.0.0" }))));
for (const id of ["github", "notion"]) writeControl(id);
writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({
  github: { command: "node", args: [FIXTURE], env: {} }, notion: { command: "node", args: [FIXTURE], env: {} },
}), { mode: 0o600 });

const spawnCount = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, "utf8").split("\n").filter(Boolean).length : 0);
const TOOL = (name) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } });
const DEFAULT_GITHUB_CACHE = [TOOL("whoami"), TOOL("reveal")];
const setGithubCache = (tools) => TC.writeToolCache(HOME, "github", "1.0.0", tools);

async function withDb(fn) {
  const d = createDbClient(DB_PATH);
  try { return await fn(d); } finally { d.close(); }
}
function raw(fn) {
  const d = new Database(DB_PATH);
  try { d.pragma("foreign_keys = OFF"); return fn(d); } finally { d.close(); }
}

const P = {};   // project ids
const U = {};   // connection uuids

async function connect(serviceId, projectId, label) {
  return withDb(async (d) => {
    const key = await ensureWriteKey(d, { crowHome: HOME });
    const secrets = serviceId === "github" ? { [GH]: GH_TOKEN } : { NOTION_TOKEN: "test-token-2" };
    const c = await SC.createConnection(d, { projectId, serviceId, accountLabel: label, secrets, config: {}, testedAt: new Date() }, { key });
    // As the owner's connect route does: the binding (and its fingerprints) in the hidden dir.
    SENS.recordConnectionBinding(c, { crowHome: HOME, service: serviceById(serviceId), values: { config: c.config, secrets } });
    return c;
  });
}

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  raw((d) => {
    const proj = d.prepare("INSERT INTO project_spaces (slug, name) VALUES (?, ?)");
    for (const slug of ["spring", "home", "eight"]) P[slug] = Number(proj.run(slug, slug).lastInsertRowid);
  });
  U.work = (await connect("github", P.spring, "work")).uuid;
  U.personal = (await connect("github", P.spring, "personal")).uuid;
  U.long = (await connect("github", P.spring, "averylongaccount")).uuid;
  U.notion = (await connect("notion", P.spring, "work")).uuid;
  U.home = (await connect("github", P.home, "work")).uuid;
  for (const label of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
    U[label] = (await connect("github", P.eight, label)).uuid;
  }
  setGithubCache(DEFAULT_GITHUB_CACHE);
  TC.writeToolCache(HOME, "notion", "1.0.0", [TOOL("whoami")]);
});

after(async () => {
  await C.stopAllChildren();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [HOME, DATA]) rmScratch(d);
});

// ---- listing ---------------------------------------------------------------------------------

test("onlyUuids restricts: two cached connections, one named → only its tools", async () => {
  const all = await withDb((d) => PT.listProjectServiceTools(d, { projectId: P.spring, crowHome: HOME }));
  const only = await withDb((d) => PT.listProjectServiceTools(d, { projectId: P.spring, crowHome: HOME, onlyUuids: new Set([U.work]) }));

  assert.ok(all.tools.some((t) => t.name.startsWith("mcp__github-work__")));
  assert.ok(all.tools.some((t) => t.name.startsWith("mcp__github-personal__")));
  assert.ok(only.tools.length > 0);
  for (const t of only.tools) assert.ok(t.name.startsWith("mcp__github-work__"), t.name);
  for (const name of only.route.keys()) assert.ok(name.startsWith("mcp__github-work__"), name);
  assert.deepEqual(only.route.get("mcp__github-work__whoami"), { uuid: U.work, toolName: "whoami" });
  assert.equal(only.tools.find((t) => t.name === "mcp__github-work__whoami").description, "whoami tool");
});

test("listing starts nothing: eight cached connections → zero children; one call starts exactly one", async () => {
  await C.stopAllChildren();
  assert.deepEqual(C.listChildren(), []);
  const before = spawnCount();

  const listed = await withDb((d) => PT.listProjectServiceTools(d, { projectId: P.eight, crowHome: HOME }));
  assert.equal(listed.tools.length, 16, "eight connections × whoami and reveal");
  assert.deepEqual(C.listChildren(), [], "listing never starts a child");

  const name = "mcp__github-one__whoami";
  assert.ok(listed.route.has(name));
  const r = await withDb((d) => PT.callProjectServiceTool(d, listed.route, name, {}, { crowHome: HOME }));
  assert.equal(r.isError, false, r.result);
  assert.ok(r.result.includes("keys"), r.result);
  assert.equal(C.listChildren().length, 1, "one call, one child");
  assert.equal(spawnCount(), before + 1);
});

test("sensitive skipped: a private connection contributes no tools; switched private after listing, the next call is refused and starts nothing", async () => {
  const listed = await withDb((d) => PT.listProjectServiceTools(d, { projectId: P.spring, crowHome: HOME }));
  assert.ok(!listed.tools.some((t) => t.name.startsWith("mcp__notion-")), "notion is private by default");

  SENS.setSensitivityOverride({ uuid: U.work, serviceId: "github" }, true, { crowHome: HOME });
  try {
    const afterSwitch = await withDb((d) => PT.listProjectServiceTools(d, { projectId: P.spring, crowHome: HOME }));
    assert.ok(!afterSwitch.tools.some((t) => t.name.startsWith("mcp__github-work__")));

    const before = spawnCount();
    const r = await withDb((d) => PT.callProjectServiceTool(d, listed.route, "mcp__github-work__whoami", {}, { crowHome: HOME }));
    assert.equal(r.isError, true);
    assert.equal(r.result, "This connection is private. Bots can't read it yet.");
    assert.equal(spawnCount(), before, "a refused call starts nothing");
  } finally {
    SENS.setSensitivityOverride({ uuid: U.work, serviceId: "github" }, false, { crowHome: HOME });
  }
});

test("long names not advertised: a name over 64 characters is absent, warned about once", async () => {
  const longTool = `tool-${"x".repeat(40)}`;   // mcp__ + github-averylongaccount (23) + __ = 30, + 45
  const expected = `mcp__github-averylongaccount__${longTool}`;
  assert.ok(expected.length > PT.SERVICE_TOOL_NAME_MAX);
  setGithubCache([TOOL("whoami"), TOOL(longTool)]);

  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const first = await withDb((d) => PT.listProjectServiceTools(d, { projectId: P.spring, crowHome: HOME, onlyUuids: new Set([U.long]) }));
    const second = await withDb((d) => PT.listProjectServiceTools(d, { projectId: P.spring, crowHome: HOME, onlyUuids: new Set([U.long]) }));
    assert.deepEqual(first.tools.map((t) => t.name), ["mcp__github-averylongaccount__whoami"]);
    assert.ok(second.tools.every((t) => t.name !== expected));
    assert.equal(warnings.filter((w) => w.includes(longTool)).length, 1, "one warning for the name");
  } finally {
    console.warn = original;
    setGithubCache(DEFAULT_GITHUB_CACHE);
  }
});

// ---- calling ---------------------------------------------------------------------------------

test("masking: a child result carrying the connection's token reaches the chat as [redacted]", async () => {
  await C.stopAllChildren();
  setGithubCache(DEFAULT_GITHUB_CACHE);
  const listed = await withDb((d) => PT.listProjectServiceTools(d, { projectId: P.spring, crowHome: HOME, onlyUuids: new Set([U.work]) }));
  const r = await withDb((d) => PT.callProjectServiceTool(d, listed.route, "mcp__github-work__reveal", {}, { crowHome: HOME }));
  assert.equal(r.isError, false, r.result);
  assert.ok(r.result.includes("[redacted]"), r.result);
  assert.ok(!r.result.includes(GH_TOKEN), "the token never reaches the chat");
});

test("an unknown name refuses without touching a child", async () => {
  const r = await withDb((d) => PT.callProjectServiceTool(d, new Map(), "mcp__nope__whoami", {}, { crowHome: HOME }));
  assert.deepEqual(r, { result: "Unknown tool", isError: true });
});

// ---- the executor and the advertised surface --------------------------------------------------

test("executor routes services first: an mcp__ name goes to serviceCall, a crow_ name never does", async () => {
  const route = new Map([["mcp__demo__whoami", { uuid: "demo", toolName: "whoami" }]]);
  const calls = [];
  const ex = createToolExecutor({
    serviceRoute: route,
    serviceCall: async (name, args) => { calls.push([name, args]); return { result: "routed", isError: false }; },
  });
  try {
    const [routed] = await ex.executeToolCalls([{ id: "1", name: "mcp__demo__whoami", arguments: { a: 1 } }]);
    assert.equal(routed.result, "routed");
    assert.equal(routed.isError, false);
    assert.deepEqual(calls, [["mcp__demo__whoami", { a: 1 }]]);

    const [memory] = await ex.executeToolCalls([{ id: "2", name: "crow_memory", arguments: { action: "search_memories", params: { query: "x" } } }]);
    assert.notEqual(memory.result, "routed");
    const [discover] = await ex.executeToolCalls([{ id: "3", name: "crow_discover", arguments: {} }]);
    assert.notEqual(discover.result, "routed");
    assert.equal(calls.length, 1, "a crow_ name never reaches the service route");
  } finally {
    await ex.close();
  }
});

test("getChatTools has no service names, bound or unbound", () => {
  const unbound = getChatTools();
  const bound = getChatTools({ botDef: { bot_id: "b1", display_name: "B1", tools: { crow_mcp: ["github"] } } });
  assert.ok(unbound.length > 0);
  assert.ok(bound.length > 0);
  for (const t of [...unbound, ...bound]) assert.ok(!t.name.startsWith("mcp__"), t.name);
});

// ---- which project and which tools a conversation gets ---------------------------------------

const conversation = (projectId) => ({ id: 1, project_id: projectId });

function scopedDeps(projectId, { owner = true } = {}) {
  const seen = [];
  return {
    seen,
    deps: {
      isLocalPasswordSessionOn: async () => owner,
      listTools: async (_db, opts) => {
        seen.push(opts.projectId);
        assert.equal(opts.projectId, projectId);
        return {
          tools: [{ name: "mcp__github-work__whoami", description: "", inputSchema: { type: "object", properties: {} } }],
          route: new Map([["mcp__github-work__whoami", { uuid: "u", toolName: "whoami" }]]),
        };
      },
    },
  };
}

test("chat pins its project: an owner's local session gets that project's tools and principal owner", async () => {
  const { deps, seen } = scopedDeps(P.spring);
  const scope = await chatServiceScope({}, { cookies: {} }, conversation(P.spring), deps);
  assert.equal(scope.projectId, P.spring);
  assert.equal(scope.principal, "owner");
  assert.deepEqual(scope.tools.map((t) => t.name), ["mcp__github-work__whoami"]);
  assert.ok(scope.route.has("mcp__github-work__whoami"));
  assert.deepEqual(seen, [P.spring]);
});

test("a session that is not the owner's local one gets no tools and no principal", async () => {
  const { deps, seen } = scopedDeps(P.spring, { owner: false });
  const scope = await chatServiceScope({}, {}, conversation(P.spring), deps);
  assert.equal(scope.projectId, P.spring);
  assert.equal(scope.principal, null);
  assert.deepEqual(scope.tools, []);
  assert.equal(scope.route.size, 0);
  assert.deepEqual(seen, [], "nothing is listed for a non-owner turn");
});

test("existing thread has none: a NULL project_id gets no tools, owner or not", async () => {
  const seen = [];
  const deps = {
    isLocalPasswordSessionOn: async () => true,
    listTools: async () => { seen.push("listed"); return { tools: [], route: new Map() }; },
  };
  for (const row of [conversation(null), conversation(undefined), { id: 2 }]) {
    const scope = await chatServiceScope({}, {}, row, deps);
    assert.equal(scope.projectId, null);
    assert.equal(scope.principal, null);
    assert.deepEqual(scope.tools, []);
  }
  assert.deepEqual(seen, [], "a legacy thread lists nothing");
});

test("the stored project wins over a different scope cookie: the request's cookie is never consulted", async () => {
  const req = { cookies: { crow_scope: "home" }, query: { project: "home" } };
  const { deps, seen } = scopedDeps(P.spring);
  const scope = await chatServiceScope({}, req, conversation(P.spring), deps);
  assert.equal(scope.projectId, P.spring);
  assert.deepEqual(seen, [P.spring]);
});

test("projectIdOfScope: only a single-project scope pins a new conversation", () => {
  assert.equal(projectIdOfScope({ projectId: 7, slug: "spring" }), 7);
  assert.equal(projectIdOfScope({ all: true }), null);
  assert.equal(projectIdOfScope({ unassigned: true }), null);
  assert.equal(projectIdOfScope({}), null);
  assert.equal(projectIdOfScope(undefined), null);
});