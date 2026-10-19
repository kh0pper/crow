/**
 * Every MCP tool input schema Crow publishes, built the way a client sees it
 * (a real McpServer, an in-process client, tools/list).
 *
 * Sources:
 *   - the core servers (memory, projects, sharing, storage, blog, wm) and the
 *     on-demand crow-core server;
 *   - the gateway's own servers: the router (/router/mcp) and the board
 *     (/board/mcp);
 *   - every bundle server in the repo: each exported create*Server /
 *     create*McpServer factory in bundles/<id>/server/{server,mcp}.js, found by
 *     scanning, so a new bundle is covered without editing this file;
 *   - the three re-publishers that turn an upstream JSON Schema back into zod
 *     (the gateway /tools proxy, crow-core and the peer crow-remote-proxy),
 *     fed every schema above.
 *
 * Callers must run inside the scratch test env (scripts/run-suite.mjs): the
 * core servers open CROW_DB_PATH, which this helper points at a fresh,
 * init-db'd database of its own.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = join(import.meta.dirname, "..", "..");
const bundlesRoot = pathToFileURL(join(repoRoot, "bundles")).href + "/";

// A bundle's own runtime packages (playwright, snoowrap, nodemailer, ...) live
// in that bundle's node_modules, which neither CI nor a fresh worktree
// installs. Building a tool list never calls them, so a bare import that does
// not resolve FROM A BUNDLE FILE gets an inert stub that exports the names the
// importing file asks for. Core code is never stubbed: a missing package there
// still fails loudly.
const stubbed = new Set();
let hooksInstalled = false;
async function installBundleDepStubs() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const { registerHooks } = await import("node:module");
  const STUB = "crow-schema-audit-stub:";
  registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (err) {
        const bare = !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":");
        // Never stub the packages a tool list is built FROM: a stub there would hide the failure.
        const core = specifier === "zod" || specifier.startsWith("zod/") || specifier.startsWith("@modelcontextprotocol/");
        if (err?.code !== "ERR_MODULE_NOT_FOUND" || !bare || core || !context.parentURL?.startsWith(bundlesRoot)) throw err;
        stubbed.add(specifier);
        return { url: `${STUB}${encodeURIComponent(specifier)}?from=${encodeURIComponent(context.parentURL)}`, shortCircuit: true };
      }
    },
    load(url, context, next) {
      if (!url.startsWith(STUB)) return next(url, context);
      const [spec, query] = url.slice(STUB.length).split("?from=");
      const specifier = decodeURIComponent(spec);
      const parent = readFileSync(new URL(decodeURIComponent(query)), "utf8");
      const names = new Set();
      const esc = specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      for (const m of parent.matchAll(new RegExp(`import\\s*(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*["']${esc}["']`, "g"))) {
        for (const part of m[1].split(",")) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (n && n !== "default") names.add(n); }
      }
      const inert = "const inert = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : inert), apply: () => inert, construct: () => inert });";
      const source = `${inert}\nexport default inert;\n${[...names].map((n) => `export const ${n} = inert;`).join("\n")}\n`;
      return { format: "module", source, shortCircuit: true };
    },
  });
}

// Factory arguments for the bundle factories whose first parameter is not an
// options object. Anything not listed is called with no arguments.
function bundleArgs(name, ctx) {
  switch (name) {
    case "createCampaignsServer":
    case "createDataDashboardServer":
    case "createMediaServer":
    case "createNominatimServer":
    case "createTaxServer":
      return [ctx.dbPath, {}];
    case "createIptvServer":
    case "createKnowledgeBaseServer":
    case "createMakerLabServer":
    case "createPmWorkspaceServer":
    case "createRambleServer":
    case "createReaderServer":
      return [ctx.db, {}];
    case "createArtifactsMcpServer":
      return [{ db: ctx.db, blobs: {}, McpServer: ctx.McpServer, z: ctx.z, verifyActor: () => null }];
    case "createPhoneMcpServer":
      return [{ db: ctx.db, ownerNumber: "+15125550100", McpServer: ctx.McpServer, z: ctx.z, verifyActor: () => null }];
    case "createKioskServer":
      return [{ fetchImpl: async () => { throw new Error("no network in tests"); } }];
    default:
      return [];
  }
}

async function connectClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "schema-audit", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}

async function listOf(server) {
  const client = await connectClient(server);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/** A fresh scratch DB with the full schema; sets CROW_DB_PATH for the core servers. */
function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), "tool-schemas-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const dbPath = join(dir, "crow.db");
  process.env.CROW_DB_PATH = dbPath;
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: repoRoot });
  return { dir, dbPath };
}

let cached = null;

/**
 * @returns {Promise<{ entries: Array<{source: string, tool: string, inputSchema: object}>,
 *   failures: Array<{source: string, error: string}>, bundleFactories: string[], stubbedPackages: string[] }>}
 */
export async function collectPublishedToolSchemas() {
  if (cached) return cached;
  await installBundleDepStubs();
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { z } = await import("zod");
  const { createDbClient } = await import("../../servers/db.js");
  const savedDbPath = process.env.CROW_DB_PATH;
  const { dir, dbPath } = scratchDb();
  const ctx = { dbPath, db: createDbClient(dbPath), McpServer, z };
  const entries = [];
  const failures = [];
  const add = (source, tools) => { for (const t of tools) entries.push({ source, tool: t.name, inputSchema: t.inputSchema }); };
  // One source never hangs the whole inventory: 15 s each, then a readable failure.
  const withTimeout = (p, source) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${source}: no tool list within 15 s`)), 15_000); })]).finally(() => clearTimeout(t));
  };
  const attempt = async (source, build) => {
    try { add(source, await withTimeout((async () => listOf(await build()))(), source)); }
    catch (err) { failures.push({ source, error: err?.stack || String(err) }); }
  };
  // Tool lists that are plain JSON, not an MCP server: added as is.
  const addStatic = (source, list) => { for (const t of list) entries.push({ source, tool: t.name, inputSchema: t.inputSchema }); };

  // Core servers.
  const core = [
    ["memory", "../../servers/memory/server.js", "createMemoryServer"],
    ["projects", "../../servers/research/server.js", "createProjectServer"],
    ["sharing", "../../servers/sharing/server.js", "createSharingServer"],
    ["storage", "../../servers/storage/server.js", "createStorageServer"],
    ["blog", "../../servers/blog/server.js", "createBlogServer"],
    ["wm", "../../servers/wm/server.js", "createWmServer"],
  ];
  for (const [id, path, fn] of core) {
    await attempt(`core:${id}`, async () => (await import(path))[fn](dbPath));
  }

  // Gateway servers.
  await attempt("gateway:router", async () => (await import("../../servers/gateway/router.js")).createRouterServer());
  await attempt("gateway:board", async () => {
    const { createBoardMcpServer } = await import("../../servers/gateway/board-mcp.js");
    return createBoardMcpServer({ tdb: createDbClient(join(dir, "tasks.db")), cdb: ctx.db, verifyActor: () => null });
  });

  // Every bundle server factory in the repo.
  const bundlesDir = join(repoRoot, "bundles");
  const bundleFactories = [];
  for (const id of readdirSync(bundlesDir).sort()) {
    for (const file of ["server.js", "mcp.js"]) {
      const p = join(bundlesDir, id, "server", file);
      if (!existsSync(p)) continue;
      const src = readFileSync(p, "utf8");
      const names = [...src.matchAll(/^export (?:async )?function (create\w*(?:Server|McpServer))\s*\(/gm)].map((m) => m[1]);
      for (const name of names) {
        const source = `bundle:${id}`;
        bundleFactories.push(`${id}/${file}:${name}`);
        await attempt(source, async () => {
          const mod = await import(pathToFileURL(p).href);
          return await mod[name](...bundleArgs(name, ctx));
        });
      }
    }
  }

  // The on-demand crow-core server, with every server it can proxy switched on
  // (it re-publishes them through a JSON Schema -> zod conversion of its own).
  try {
    const { createCoreServer } = await import("../../servers/core/server.js");
    const client = await connectClient(await createCoreServer(dbPath));
    for (const name of ["projects", "sharing", "blog", "storage"]) {
      const r = await client.callTool({ name: "crow_activate_server", arguments: { server: name } });
      if (r.isError) throw new Error(`crow-core could not activate ${name}: ${JSON.stringify(r.content)}`);
    }
    add("core:crow-core", (await client.listTools()).tools);
    await client.close();
  } catch (err) { failures.push({ source: "core:crow-core", error: err?.stack || String(err) }); }

  // The re-publishers, fed every first-hand schema collected above.
  const firstHand = entries.filter((e) => !e.source.startsWith("republish:"));
  const fake = { tools: firstHand.map((e) => ({ name: `${e.source.replace(/\W/g, "_")}__${e.tool}`, description: "", inputSchema: e.inputSchema })) };
  await attempt("republish:gateway-proxy", async () => {
    const { connectedServers, createProxyServer } = await import("../../servers/gateway/proxy.js");
    const key = "schema-audit-fake";
    connectedServers.set(key, { status: "connected", client: { callTool: async () => ({ content: [] }) }, tools: fake.tools });
    try { return createProxyServer({ allowSources: [key] }); }
    finally { connectedServers.delete(key); }
  });
  await attempt("republish:crow-remote-proxy", async () => {
    const { buildRemoteProxyServer } = await import("../../scripts/pi-bots/crow-remote-proxy.mjs");
    const { server } = await buildRemoteProxyServer({ clientFactory: async () => ({ listTools: async () => fake, callTool: async () => ({ content: [] }) }) });
    return server;
  });

  // The gateway chat/voice tool list (dashboard chat, voice, glasses), with every first-hand
  // bundle tool connected the way an installed add-on is.
  try {
    const { connectedServers } = await import("../../servers/gateway/proxy.js");
    const { getChatTools } = await import("../../servers/gateway/ai/tool-executor.js");
    const key = "schema-audit-chat";
    connectedServers.set(key, { status: "connected", client: { callTool: async () => ({ content: [] }) }, tools: fake.tools });
    try { addStatic("chat:getChatTools", getChatTools({})); }
    finally { connectedServers.delete(key); }
  } catch (err) { failures.push({ source: "chat:getChatTools", error: err?.stack || String(err) }); }
  // The kiosk voice loop's hand-written tools, with every option on.
  try {
    const kiosk = await import("../../bundles/kiosk/server/tools.js");
    addStatic("kiosk:tools", kiosk.buildToolDefinitions({ windows: ["recipe", ...kiosk.SHOW_KINDS], sources: [...kiosk.PLAY_SOURCES],
      items: [{ id: "weather", title: "Weather" }], verbs: [...kiosk.WM_VERBS, ...kiosk.MEDIA_VERBS] }));
  } catch (err) { failures.push({ source: "kiosk:tools", error: err?.stack || String(err) }); }

  if (savedDbPath === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = savedDbPath;
  cached = { entries, failures, bundleFactories, stubbedPackages: [...stubbed].sort() };
  return cached;
}

/**
 * Walk a published JSON Schema and report every node a grammar-constrained
 * engine (llama.cpp json-schema-to-grammar, b9172 on the 35B) cannot use as
 * intended:
 *   - "untyped": a value schema with no type-bearing keyword ({} or only a
 *     description). {} maps to the OBJECT rule, so a model can never send a
 *     string or a number there.
 *   - "$ref": a reused zod instance. Every tool's refs share ONE table keyed
 *     by the bare pointer, so two tools' refs can resolve to each other.
 *   - "allOf": on a string or untyped node it takes the object-merge branch;
 *     members without properties/enum are dropped, leaving only {}.
 *   - "pattern": an unanchored pattern fails the WHOLE request's grammar.
 *   - "empty-object": a nested {type:"object", properties:{}} without
 *     additionalProperties:true admits only {}.
 * additionalProperties: true and a bare {type:"array"} are fine: llama.cpp
 * maps both to "any JSON value" members. `not` is never read by the grammar
 * (z.never() publishes {not:{}}), so it is not walked.
 */
const TYPE_KEYS = ["type", "anyOf", "oneOf", "allOf", "enum", "const", "properties", "items"];
export function grammarHazards(schema, path = "") {
  const out = [];
  const walk = (node, p, root) => {
    if (node === true || node === false) return; // boolean schemas only appear as additionalProperties here
    if (!node || typeof node !== "object" || Array.isArray(node)) { out.push({ path: p, kind: "malformed" }); return; }
    if ("$ref" in node) out.push({ path: p, kind: "$ref" });
    else if (!TYPE_KEYS.some((k) => k in node) && !("not" in node)) out.push({ path: p, kind: "untyped" });
    if (Array.isArray(node.allOf) && !node.allOf.every((m) => m && typeof m === "object" && ("properties" in m || "enum" in m))) out.push({ path: p, kind: "allOf" });
    if (typeof node.pattern === "string" && !(node.pattern.startsWith("^") && node.pattern.endsWith("$"))) out.push({ path: p, kind: "pattern" });
    if (!root && node.type === "object" && node.properties && !Object.keys(node.properties).length && node.additionalProperties !== true
      && !(node.additionalProperties && typeof node.additionalProperties === "object")) out.push({ path: p, kind: "empty-object" });
    for (const [k, v] of Object.entries(node.properties || {})) walk(v, `${p}.${k}`, false);
    if (node.additionalProperties !== undefined && node.additionalProperties !== true && node.additionalProperties !== false) walk(node.additionalProperties, `${p}{*}`, false);
    if (node.items !== undefined) {
      if (Array.isArray(node.items)) node.items.forEach((it, i) => walk(it, `${p}[${i}]`, false));
      else walk(node.items, `${p}[]`, false);
    }
    for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[k])) node[k].forEach((s, i) => walk(s, `${p}<${k}${i}>`, false));
  };
  walk(schema, path, true);
  return out;
}
