/**
 * The tools that used to publish an empty {} value schema (queue item 26
 * follow-up): their new typed schemas, the field order a grammar engine sees,
 * and that what they accept is unchanged (or stricter, where typed) — plus the
 * one normalisation: an object argument sent as a JSON string is parsed.
 * The repo-wide guard is tests/tool-schemas-grammar-safe.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { jsonObject, parseJsonObjectString } from "../servers/shared/tool-schema-types.js";
import { collectPublishedToolSchemas } from "./helpers/published-tool-schemas.js";

const repoRoot = join(import.meta.dirname, "..");
let home;

before(() => {
  home = mkdtempSync(join(tmpdir(), "typed-schemas-"));
  mkdirSync(join(home, "data"), { recursive: true });
  process.env.CROW_DB_PATH = join(home, "crow.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: repoRoot });
});
after(() => rmSync(home, { recursive: true, force: true }));

async function connect(server) {
  const client = new Client({ name: "typed-schemas", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}
const text = (r) => (r.content || []).map((c) => c.text || "").join("\n");
// The zod object the SDK validates a call with (McpServer 1.27 keeps it per tool).
const zodOf = (server, tool) => server._registeredTools[tool].inputSchema;
let published;
const schemaOf = async (source, tool) => {
  published ||= await collectPublishedToolSchemas();
  const e = published.entries.find((x) => x.source === source && x.tool === tool);
  assert.ok(e, `${source} ${tool} published`);
  return e.inputSchema;
};

test("parseJsonObjectString (shared copy and the two bundle copies): only a whole JSON object string is parsed", async () => {
  const copies = [
    ["shared", parseJsonObjectString],
    ["maker-lab", (await import("../bundles/maker-lab/server/server.js")).parseJsonObjectString],
    ["sunvox-studio", (await import("../bundles/sunvox-studio/server/server.js")).parseJsonObjectString],
  ];
  for (const [name, fn] of copies) {
    assert.deepEqual(fn('{"query":"x"}'), { query: "x" }, name);
    assert.deepEqual(fn('  {"a":1}  '), { a: 1 }, name);
    for (const v of ["[1,2]", '"s"', "12", "{not json", "plain", "", "null", null, 3, ["a"]]) assert.deepEqual(fn(v), v, `${name}: ${JSON.stringify(v)}`);
    const obj = { a: 1 };
    assert.equal(fn(obj), obj, name);
  }
});

test("jsonObject accepts exactly what z.record(z.any()) accepted, plus a JSON-string object", () => {
  const ours = z.object({ v: jsonObject().optional() });
  const old = z.object({ v: z.record(z.any()).optional() });
  for (const v of [{}, { a: 1, b: "s", c: [1], d: { e: null } }, undefined]) {
    assert.deepEqual(ours.parse({ v }), old.parse({ v }), JSON.stringify(v));
  }
  for (const v of [[], [1], "s", 3, null, true]) {
    assert.equal(ours.safeParse({ v }).success, false, JSON.stringify(v));
    assert.equal(old.safeParse({ v }).success, false, JSON.stringify(v));
  }
  assert.deepEqual(ours.parse({ v: '{"a":"b"}' }), { v: { a: "b" } });
  assert.equal(ours.safeParse({ v: "[1]" }).success, false);
  const polluted = ours.parse({ v: '{"__proto__": {"polluted": 1}, "a": 1}' });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(polluted.v), Object.prototype);
  assert.equal(polluted.v.polluted, undefined);
});

test("router: params publishes as an open object and a JSON-string params reaches the server", async () => {
  const s = await schemaOf("gateway:router", "crow_memory");
  assert.deepEqual(s.properties.params, { type: "object", properties: {}, additionalProperties: true, description: s.properties.params.description });
  const tools = await schemaOf("gateway:router", "crow_tools");
  assert.deepEqual(Object.keys(tools.properties), ["action", "instance_id", "params"], "params last");

  const { createRouterServer } = await import("../servers/gateway/router.js");
  const client = await connect(createRouterServer());
  const stored = await client.callTool({ name: "crow_memory", arguments: { action: "store_memory", params: { content: "The heron lands at xylophone bridge", category: "general" } } });
  assert.ok(!stored.isError, text(stored));
  const found = await client.callTool({ name: "crow_memory", arguments: { action: "search_memories", params: '{"query": "xylophone"}' } });
  assert.ok(!found.isError, text(found));
  assert.match(text(found), /xylophone bridge/);
  const refused = await client.callTool({ name: "crow_memory", arguments: { action: "search_memories", params: "xylophone" } });
  assert.ok(refused.isError);
  assert.match(text(refused), /params/);
  await client.close();
});

test("board: data publishes as an open object; objects and JSON-string objects pass, the rest is refused", async () => {
  for (const tool of ["board_create_item", "board_update_item"]) {
    const s = await schemaOf("gateway:board", tool);
    assert.equal(s.properties.data.type, "object");
    assert.equal(s.properties.data.additionalProperties, true);
    assert.equal(Object.keys(s.properties).at(-1), "data", "data stays last");
  }
  const { createBoardMcpServer } = await import("../servers/gateway/board-mcp.js");
  const { createDbClient } = await import("../servers/db.js");
  const server = createBoardMcpServer({ tdb: createDbClient(join(home, "tasks.db")), cdb: createDbClient(process.env.CROW_DB_PATH), verifyActor: () => null });
  const zs = zodOf(server, "board_create_item");
  assert.deepEqual(zs.parse({ title: "t", data: { owner: "alex", points: 3, done: false } }).data, { owner: "alex", points: 3, done: false });
  assert.deepEqual(zs.parse({ title: "t", data: '{"owner":"alex"}' }).data, { owner: "alex" });
  for (const data of [["a"], "alex", 3, null]) assert.equal(zs.safeParse({ title: "t", data }).success, false, JSON.stringify(data));
});

test("memory: crow_create_notification publishes short fields first, body and metadata last", async () => {
  const s = await schemaOf("core:memory", "crow_create_notification");
  assert.deepEqual(Object.keys(s.properties), ["title", "type", "priority", "action_url", "expires_in_minutes", "body", "metadata"]);
  assert.equal(s.properties.metadata.additionalProperties, true);
  const { createMemoryServer } = await import("../servers/memory/server.js");
  const client = await connect(createMemoryServer());
  const r = await client.callTool({ name: "crow_create_notification", arguments: { title: "Typed", metadata: { source: "test", n: 2 } } });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Notification created|disabled/);
  await client.close();
});

test("maker-lab: lesson is typed (fields in grammar-friendly order) and the validator still owns the messages", async () => {
  const s = await schemaOf("bundle:maker-lab", "maker_validate_lesson");
  const lesson = s.properties.lesson;
  assert.equal(lesson.type, "object");
  assert.equal(lesson.additionalProperties, true);
  const keys = Object.keys(lesson.properties);
  assert.deepEqual(keys.slice(0, 4), ["id", "title", "surface", "age_band"]);
  assert.deepEqual(keys.slice(-2), ["starter_workspace", "steps"], "bodies last");
  assert.deepEqual(lesson.properties.surface.anyOf, [{ type: "string", enum: ["blockly", "scratch", "kolibri"] }, { type: "null" }]);
  assert.equal(lesson.required, undefined, "missing fields are reported by validateLesson, not the schema");

  const { createDbClient } = await import("../servers/db.js");
  const { createMakerLabServer } = await import("../bundles/maker-lab/server/server.js");
  const client = await connect(createMakerLabServer(createDbClient(process.env.CROW_DB_PATH), {}));
  const good = { id: "loops-1", title: "Loops", surface: "blockly", age_band: "10-13", steps: [{ prompt: "Make it repeat" }], canned_hints: ["Try the repeat block"], custom_note: "kept" };
  const ok = JSON.parse(text(await client.callTool({ name: "maker_validate_lesson", arguments: { lesson: good } })));
  assert.equal(ok.valid, true, JSON.stringify(ok));
  const asString = JSON.parse(text(await client.callTool({ name: "maker_validate_lesson", arguments: { lesson: JSON.stringify(good) } })));
  assert.equal(asString.valid, true, "a lesson sent as a JSON string is parsed");
  const missing = JSON.parse(text(await client.callTool({ name: "maker_validate_lesson", arguments: { lesson: { id: "x", title: "t" } } })));
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.includes("missing: steps"), JSON.stringify(missing.errors));
  // The validator reads null as "not given" and checks String(id): both stay valid.
  const lenient = { ...good, id: 42, goal: null, starter_workspace: null, reading_level: null, success_check: null, toolbox: null, tags: null };
  const nullable = JSON.parse(text(await client.callTool({ name: "maker_validate_lesson", arguments: { lesson: lenient } })));
  assert.equal(nullable.valid, true, JSON.stringify(nullable));
  const badEnum = JSON.parse(text(await client.callTool({ name: "maker_validate_lesson", arguments: { lesson: { ...good, surface: null, age_band: null, reading_level: 9 } } })));
  assert.equal(badEnum.valid, true, "null enums read as absent, as the validator does");
  const tooHard = JSON.parse(text(await client.callTool({ name: "maker_validate_lesson", arguments: { lesson: { ...good, age_band: "5-9", reading_level: 9 } } })));
  assert.equal(tooHard.valid, false);
  assert.ok(tooHard.errors.some((e) => /reading_level must be <= 3/.test(e)), "range messages still come from the validator");
  const wrongType = await client.callTool({ name: "maker_validate_lesson", arguments: { lesson: { title: 5 } } });
  assert.ok(wrongType.isError, "a wrong type is now a schema error naming the field");
  assert.match(text(wrongType), /title/);
  await client.close();
});

test("sunvox: spec is typed from compose(); a real-shaped spec is accepted unchanged, a JSON-string spec is parsed", async () => {
  const s = await schemaOf("bundle:sunvox-studio", "sunvox_compose");
  assert.deepEqual(Object.keys(s.properties), ["name", "render", "format", "spec"]);
  const spec = s.properties.spec;
  assert.deepEqual(Object.keys(spec.properties), ["bpm", "tpl", "modules", "connections", "patterns"]);
  assert.deepEqual(spec.required, ["modules", "patterns"]);
  const ev = spec.properties.patterns.items.properties.events.items;
  assert.deepEqual(Object.keys(ev.properties).slice(0, 4), ["track", "line", "module", "note"]);

  const { createSunvoxServer } = await import("../bundles/sunvox-studio/server/server.js");
  const zs = zodOf(createSunvoxServer(), "sunvox_compose");
  const real = {
    bpm: 120, tpl: 6,
    modules: [{ id: "lead", type: "Generator", params: { Volume: 200 } }, { id: "rev", type: "Reverb", x: 600, y: null }],
    connections: [["lead", "rev", "out"]],
    patterns: [{ name: "intro", tracks: 2, lines: 16, events: [{ track: 0, line: 0, note: "C4", velocity: 100, module: "lead" }, { line: 8, note_off: true }, { track: 1, line: 4, ctl: 1, ctl_val: 0x8000, module: "lead" }] }],
    extra_key: "ignored by the engine",
  };
  assert.deepEqual(zs.parse({ spec: real }).spec, real);
  assert.deepEqual(zs.parse({ spec: JSON.stringify(real) }).spec, real);
  for (const bad of [{ modules: [], patterns: "x" }, { modules: [{ id: 1, type: "Generator" }], patterns: [] }, { modules: [], patterns: [{ events: [{ note: { name: "C4" } }] }] }, { modules: [{ id: "a", type: "Generator", params: { Volume: "loud" } }], patterns: [] }]) {
    assert.equal(zs.safeParse({ spec: bad }).success, false, JSON.stringify(bad));
  }
});

test("caddy: set_wellknown opts carries the four keys buildWellKnownJson reads, as strings", async () => {
  const s = await schemaOf("bundle:caddy", "caddy_set_wellknown");
  assert.deepEqual(Object.keys(s.properties.opts.properties), ["delegate_to", "homeserver_base_url", "identity_server_base_url", "href"]);
  const { createCaddyServer } = await import("../bundles/caddy/server/server.js");
  const zs = zodOf(createCaddyServer(), "caddy_set_wellknown");
  assert.deepEqual(zs.parse({ domain: "example.com", kind: "matrix-server", opts: { delegate_to: "matrix.example.com:443", other: 1 } }).opts, { delegate_to: "matrix.example.com:443" });
  assert.equal(zs.safeParse({ domain: "example.com", kind: "nodeinfo", opts: { href: { url: "x" } } }).success, false);
});

test("browser: export rows are open objects; cookies are typed Playwright cookies (sameSite normalised)", async () => {
  const exp = await schemaOf("bundle:browser", "crow_browser_export");
  assert.deepEqual(exp.properties.data.items, { type: "object", properties: {}, additionalProperties: true });
  const ck = await schemaOf("bundle:browser", "crow_browser_add_cookies");
  const item = ck.properties.cookies.items;
  assert.deepEqual(item.required, ["name", "value"]);
  assert.equal(Object.keys(item.properties).at(-1), "value");
  const { createBrowserServer } = await import("../bundles/browser/server/server.js");
  const server = createBrowserServer();
  const rows = [{ title: "a", price: 3, tags: ["x"], nested: { k: 1 } }];
  assert.deepEqual(zodOf(server, "crow_browser_export").parse({ data: rows, format: "json" }).data, rows);
  const zs = zodOf(server, "crow_browser_add_cookies");
  const parsed = zs.parse({ cookies: [{ name: "sid", value: "abc", domain: ".example.com", path: "/", sameSite: "lax", partitionKey: "p" }] });
  assert.deepEqual(parsed.cookies[0], { name: "sid", value: "abc", domain: ".example.com", path: "/", sameSite: "Lax", partitionKey: "p" });
  assert.equal(zs.parse({ cookies: [{ name: "a", value: "b", sameSite: "no_restriction" }] }).cookies[0].sameSite, "None");
  assert.equal(zs.parse({ cookies: [{ name: "a", value: "b", sameSite: "unspecified" }] }).cookies[0].sameSite, undefined);
  assert.equal(zs.safeParse({ cookies: [{ name: "sid", value: { v: "abc" } }] }).success, false);
  assert.equal(zs.safeParse({ cookies: [{ name: "sid", value: "abc", sameSite: "sometimes" }] }).success, false);
});

test("workspace: sheet cell values publish without $ref and still take strings, numbers, objects and arrays", async () => {
  for (const tool of ["ws_sheets_write", "ws_sheets_append"]) {
    const s = await schemaOf("bundle:workspace", tool);
    assert.ok(!JSON.stringify(s).includes("$ref"), tool);
  }
  const { createWorkspaceServer } = await import("../bundles/workspace/server/server.js");
  const server = createWorkspaceServer();
  const write = zodOf(server, "ws_sheets_write");
  const base = { path: "Budget.xlsx", range: "Sheet1!A1" };
  const cells = [["a", 1, true, null, { f: 1 }, [1, 2]]];
  const parsed = write.safeParse({ ...base, values: cells });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.values, cells);
});
