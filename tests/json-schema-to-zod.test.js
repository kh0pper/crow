/**
 * servers/shared/json-schema-to-zod.js — the converter the gateway /tools
 * proxy, crow-remote-proxy and crow-core use to re-publish an upstream tool.
 * It must re-publish the upstream's types (a nested object stays an object
 * with typed fields, T|null stays T|null), never an empty {} schema (llama.cpp
 * turns {} into "object", see tool-schemas-grammar-safe.test.js), and never a
 * $ref.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { jsonSchemaToZod, jsonSchemaPropertiesToZod, jsonSchemaToZodObject } from "../servers/shared/json-schema-to-zod.js";
import { grammarHazards } from "./helpers/published-tool-schemas.js";

// Exactly how the MCP SDK (1.27, zod 3) publishes a tool's input schema.
const publish = (shape) => {
  const out = toJsonSchemaCompat(z.object(shape), { strictUnions: true, pipeStrategy: "input" });
  delete out.$schema;
  return out;
};
const roundTrip = (schema) => publish(jsonSchemaPropertiesToZod(schema));
const parse = (schema, value) => z.object(jsonSchemaPropertiesToZod(schema)).safeParse(value);

const ARTIFACT_SOURCE = {
  type: "object",
  properties: {
    source: {
      type: "object",
      properties: {
        title: { type: "string", description: "document: the title" },
        libs: { type: "array", items: { type: "string", maxLength: 120 }, maxItems: 40 },
        assets: { type: "array", items: { type: "object", properties: { path: { type: "string" }, base64: { type: "string" } }, required: ["path", "base64"], additionalProperties: false } },
        html: { type: "string", description: "page: the whole HTML document as ONE string" },
      },
      additionalProperties: false,
    },
    type: { type: "string", enum: ["page", "document", "diagram"] },
  },
  required: ["type"],
};

test("a typed nested object is re-published typed (the #498 artifacts source)", () => {
  const out = roundTrip(ARTIFACT_SOURCE);
  assert.deepEqual(grammarHazards(out), []);
  const src = out.properties.source;
  assert.equal(src.type, "object");
  assert.equal(src.additionalProperties, false);
  assert.deepEqual(Object.keys(src.properties), ["title", "libs", "assets", "html"], "property order is kept");
  assert.equal(src.properties.html.type, "string");
  assert.equal(src.properties.html.description, "page: the whole HTML document as ONE string");
  assert.equal(src.properties.libs.items.type, "string");
  assert.deepEqual(src.properties.assets.items.required, ["path", "base64"]);
  assert.deepEqual(out.properties.type.enum, ["page", "document", "diagram"]);
  assert.deepEqual(out.required, ["type"]);
});

test("values: strings pass where strings are declared; unknown keys of a closed object are dropped", () => {
  const ok = parse(ARTIFACT_SOURCE, { type: "page", source: { html: "<p>x</p>", extra: 1 } });
  assert.ok(ok.success);
  assert.deepEqual(ok.data.source, { html: "<p>x</p>" });
  assert.equal(parse(ARTIFACT_SOURCE, { type: "page", source: { html: { content: "<p>x</p>" } } }).success, false, "a wrapped body is a type error, as upstream");
  assert.equal(parse(ARTIFACT_SOURCE, { type: "nope" }).success, false);
});

test("an open object (no additionalProperties:false) keeps unknown keys", () => {
  const s = { type: "object", properties: { o: { type: "object", properties: { a: { type: "string" } } } } };
  const out = roundTrip(s);
  assert.equal(out.properties.o.additionalProperties, true);
  assert.deepEqual(parse(s, { o: { a: "x", b: 2 } }).data, { o: { a: "x", b: 2 } });
});

test("T|null stays a nullable T (it used to collapse to optional T and refuse null)", () => {
  const s = { type: "object", properties: { lease: { anyOf: [{ type: "string" }, { type: "null" }] }, n: { type: ["integer", "null"] } } };
  const out = roundTrip(s);
  assert.deepEqual(grammarHazards(out), []);
  assert.ok(parse(s, { lease: null, n: null }).success);
  assert.ok(parse(s, { lease: "x", n: 3 }).success);
  assert.equal(parse(s, { lease: 3 }).success, false);
  assert.equal(parse(s, { n: 1.5 }).success, false, "integer stays integer");
});

test("a multi-branch anyOf becomes a union of the typed branches", () => {
  const s = { type: "object", properties: { id: { anyOf: [{ type: "string" }, { type: "number" }] }, cell: { anyOf: [{ type: "string" }, { type: "object", properties: { f: { type: "string" } } }] } } };
  const out = roundTrip(s);
  assert.deepEqual(grammarHazards(out), []);
  assert.ok(parse(s, { id: "a", cell: { f: "=A1" } }).success);
  assert.ok(parse(s, { id: 2, cell: "x" }).success);
  assert.equal(parse(s, { id: true }).success, false);
});

test("records, arrays without items, enums and consts", () => {
  const s = {
    type: "object",
    properties: {
      headers: { type: "object", additionalProperties: { type: "string" } },
      anyArr: { type: "array" },
      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      level: { enum: [1, 2, 3] },
      kind: { const: "x" },
    },
  };
  const out = roundTrip(s);
  assert.deepEqual(grammarHazards(out), []);
  assert.deepEqual(out.properties.headers, { type: "object", additionalProperties: { type: "string" } });
  assert.ok(parse(s, { headers: { a: "b" }, anyArr: [1, "x", {}], tuple: ["a", 1], level: 2, kind: "x" }).success);
  assert.equal(parse(s, { headers: { a: 1 } }).success, false);
  assert.equal(parse(s, { level: 4 }).success, false);
  assert.equal(parse(s, { kind: "y" }).success, false);
});

test("an untyped upstream node ({} or description-only) becomes a typed 'any JSON value', never {}", () => {
  const s = { type: "object", properties: { v: {}, d: { description: "free" }, o: { type: "object" }, r: { type: "object", additionalProperties: {} }, ref: { $ref: "#/x" } } };
  const out = roundTrip(s);
  assert.deepEqual(grammarHazards(out), []);
  assert.equal(out.properties.d.description, "free");
  for (const v of ["s", 1, true, null, [1, "a"], { a: { b: 1 } }]) assert.ok(parse(s, { v, d: v, ref: v }).success, JSON.stringify(v));
  assert.ok(parse(s, { o: { a: 1, b: "x" }, r: { a: "s", b: 2 } }).success);
  assert.equal(parse(s, { o: "s" }).success, false, "a declared object still has to be an object");
});

test("a sub-schema repeated in one tool publishes no $ref (fresh instances)", () => {
  const cell = { anyOf: [{ type: "string" }, { type: "number" }] };
  const s = { type: "object", properties: { a: { type: "array", items: cell }, b: { type: "array", items: { type: "array", items: cell } } } };
  assert.deepEqual(grammarHazards(roundTrip(s)), []);
});

test("depth is capped: a pathological nesting ends in a typed 'any', not a stack overflow", () => {
  let node = { type: "string" };
  for (let i = 0; i < 200; i++) node = { type: "object", properties: { n: node } };
  const out = roundTrip({ type: "object", properties: { deep: node } });
  assert.deepEqual(grammarHazards(out), []);
});

test("jsonSchemaToZod tolerates junk without throwing", () => {
  for (const junk of [null, undefined, 3, "x", [], { type: "weird" }, { enum: [] }, { anyOf: [] }, { type: [] }]) {
    const zs = jsonSchemaToZod(junk);
    assert.deepEqual(grammarHazards(publish({ x: zs })), [], JSON.stringify(junk));
  }
  assert.deepEqual(jsonSchemaPropertiesToZod(null), {});
  assert.deepEqual(jsonSchemaPropertiesToZod({ type: "object" }), {});
});

test("a __proto__ key in a forwarded object does not pollute prototypes", () => {
  const s = { type: "object", properties: { o: { type: "object" } } };
  const r = parse(s, JSON.parse('{"o": {"__proto__": {"polluted": 1}, "a": 1}}'));
  assert.ok(r.success);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.data.o), Object.prototype);
});

// A pydantic / FastMCP-style schema (the third-party Python servers the
// /tools proxy re-publishes): $defs + $ref, allOf:[{$ref}] for a described
// model field, Any as {}, Optional[...] as anyOf with null, an integer enum.
const PYDANTIC = {
  type: "object",
  $defs: {
    Filter: { type: "object", title: "Filter", properties: { field: { type: "string" }, op: { enum: ["eq", "lt"], type: "string" }, value: {} }, required: ["field", "op"] },
    Level: { enum: [1, 2, 3], type: "integer" },
    Node: { type: "object", properties: { name: { type: "string" }, child: { $ref: "#/$defs/Node" } } },
  },
  properties: {
    query: { type: "string", title: "Query" },
    filter: { allOf: [{ $ref: "#/$defs/Filter" }], description: "one filter" },
    filters: { type: "array", items: { $ref: "#/$defs/Filter" } },
    level: { $ref: "#/$defs/Level" },
    limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
    tree: { $ref: "#/$defs/Node" },
    legacy: { $ref: "#/definitions/Missing" },
  },
  required: ["query"],
};

test("pydantic-style $defs, allOf:[{$ref}], Any and Optional are re-published typed, never {}", () => {
  const out = roundTrip(PYDANTIC);
  assert.deepEqual(grammarHazards(out), []);
  assert.equal(out.properties.filter.type, "object");
  assert.equal(out.properties.filter.description, "one filter");
  assert.deepEqual(out.properties.filter.required, ["field", "op"]);
  assert.deepEqual(out.properties.filter.properties.op.enum, ["eq", "lt"]);
  assert.equal(out.properties.filters.items.properties.field.type, "string");
  assert.ok(parse(PYDANTIC, { query: "q", level: 2, filter: { field: "a", op: "eq", value: 3 }, limit: null, tree: { name: "a", child: { name: "b" } } }).success);
  assert.equal(parse(PYDANTIC, { query: "q", level: 4 }).success, false, "integer enum kept");
  assert.equal(parse(PYDANTIC, { query: "q", filter: { field: "a", op: "gt" } }).success, false);
});

test("requirement-only anyOf branches keep the parent's type; OpenAPI nullable is honoured; a __proto__ property is skipped", () => {
  const s = { type: "object", properties: {
    pick: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, anyOf: [{ required: ["a"] }, { required: ["b"] }] },
    n: { type: "string", nullable: true },
    ["__proto__"]: { type: "string" },
  } };
  const out = roundTrip(JSON.parse(JSON.stringify(s)));
  assert.equal(out.properties.pick.type, "object");
  assert.ok(parse(s, { pick: { a: "x" }, n: null }).success);
  assert.equal(Object.getPrototypeOf(jsonSchemaPropertiesToZod(JSON.parse('{"properties":{"__proto__":{"type":"string"}}}'))), Object.prototype);
});

async function viaProxy(inputSchema) {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { connectedServers, createProxyServer } = await import("../servers/gateway/proxy.js");
  const forwarded = [];
  const key = "j2z-test";
  connectedServers.set(key, { status: "connected", tools: [{ name: "up_tool", description: "", inputSchema }],
    client: { callTool: async ({ arguments: a }) => { forwarded.push(a); return { content: [{ type: "text", text: "ok" }] }; } } });
  let server;
  try { server = createProxyServer({ allowSources: [key] }); } finally { connectedServers.delete(key); }
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  const { tools } = await client.listTools();
  return { published: tools[0].inputSchema, call: (args) => client.callTool({ name: "up_tool", arguments: args }), forwarded, close: () => client.close() };
}

test("through the /tools proxy: an open root keeps its arguments, a closed root strips, tightened types refuse, omitted defaults stay omitted", async () => {
  const open = await viaProxy({ type: "object", additionalProperties: true });
  assert.equal(open.published.additionalProperties, true);
  await open.call({ q: "x", extra: 1 });
  assert.deepEqual(open.forwarded, [{ q: "x", extra: 1 }], "an open root with no listed properties no longer loses every argument");
  await open.close();

  const closed = await viaProxy({ type: "object", properties: { n: { type: "integer", default: 5 }, mode: { type: "string", enum: ["a", "b"] }, o: { type: "object", properties: { s: { type: "string" } }, additionalProperties: false } }, additionalProperties: false });
  await closed.call({ o: { s: "x", junk: 1 }, junk: 2 });
  assert.deepEqual(closed.forwarded, [{ o: { s: "x" } }], "unknown keys of closed objects are dropped; the omitted default is left to the upstream");
  for (const bad of [{ n: 1.5 }, { n: "5" }, { mode: "c" }, { o: { s: 3 } }, { o: "x" }]) {
    const r = await closed.call(bad);
    assert.ok(r.isError, `refused: ${JSON.stringify(bad)}`);
    assert.match(r.content[0].text, /validation|Invalid/i);
  }
  assert.equal(closed.forwarded.length, 1, "refused calls never reach the upstream");
  await closed.close();
});

test("hostile upstream schemas are bounded: a $defs DAG and alias spellings of a self-ref stay small and fast", () => {
  const defs = {};
  for (let l = 0; l < 9; l++) {
    const props = {};
    for (let f = 0; f < 12; f++) props[`p${f}`] = l === 8 ? { type: "string" } : { $ref: `#/$defs/L${l + 1}` };
    defs[`L${l}`] = { type: "object", properties: props };
  }
  const dag = { type: "object", $defs: defs, properties: { root: { $ref: "#/$defs/L0" } } };
  const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 50000 }, (_, i) => [`p${i}`, i % 2 ? true : 7])) };
  let deep = { type: "string" };
  for (let i = 0; i < 40; i++) deep = { type: "object", properties: Object.fromEntries(Array.from({ length: 6 }, (_, j) => [`k${j}`, deep])) };
  const longEnum = { type: "object", $defs: { E: { type: "string", enum: Array.from({ length: 20000 }, (_, i) => `value-${i}-${"x".repeat(50)}`), description: "d".repeat(20000) } },
    properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, { $ref: "#/$defs/E" }])) };
  const untypedAlts = { type: "object", $defs: { U: { anyOf: Array.from({ length: 30000 }, () => ({})) } }, properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`u${i}`, { $ref: "#/$defs/U" }])) };
  const alias = { type: "object", properties: { a: { type: "object", properties: {
    x: { $ref: "#/properties/a" }, y: { $ref: "#//properties/a" }, z: { $ref: "#/%70roperties/a" }, w: { $ref: "#/properties//a" } } } } };
  for (const [name, schema] of [["dag", dag], ["alias", alias], ["wide", wide], ["deep", deep], ["longEnum", longEnum], ["untypedAlts", untypedAlts]]) {
    const t0 = Date.now();
    const out = publish({ x: jsonSchemaToZodObject(schema) }).properties.x; // the re-publishers' path
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `${name}: ${ms} ms`);
    assert.ok(JSON.stringify(out).length < 512 * 1024, `${name}: ${JSON.stringify(out).length} bytes`);
    assert.deepEqual(grammarHazards(out), [], name);
  }
});

test("a malformed $ref never throws, and one bad tool never sinks the re-published surface", async () => {
  assert.deepEqual(grammarHazards(roundTrip({ type: "object", properties: { a: { $ref: "#/%E0%A4%A" } } })), []);
  const { jsonSchemaToZodObject } = await import("../servers/shared/json-schema-to-zod.js");
  const poisoned = { type: "object", get properties() { throw new Error("boom"); } };
  const zs = jsonSchemaToZodObject(poisoned);
  assert.deepEqual(zs.parse({ any: 1 }), { any: 1 }, "falls back to forwarding as is");
});

test("a union of closed objects never silently drops keys (zod takes the first branch that parses)", () => {
  const branch = (props) => ({ type: "object", properties: props, required: ["id"], additionalProperties: false });
  const s = { type: "object", properties: { target: { anyOf: [branch({ id: { type: "string" } }), branch({ id: { type: "string" }, recursive: { type: "boolean" } })] } } };
  const r = parse(s, { target: { id: "x", recursive: true } });
  assert.ok(r.success);
  assert.deepEqual(r.data.target, { id: "x", recursive: true });
  assert.deepEqual(parse(s, { target: { id: "x" } }).data.target, { id: "x" });
  assert.equal(parse(s, { target: { id: "x", junk: 1 } }).success, false, "no branch admits an unknown key");
});

test("over budget, a tool keeps its typed top-level arguments and stays open; never a partial closed shape", async () => {
  const { jsonSchemaToZodObject, SOURCE_BUDGET } = await import("../servers/shared/json-schema-to-zod.js");
  const big = { type: "object", additionalProperties: false, required: ["notebookId", "body"], properties: {
    notebookId: { type: "string", description: "the notebook" },
    body: { type: "object", properties: Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, { type: "string" }])) },
    extra: { type: "integer" },
  } };
  const zs = jsonSchemaToZodObject(big);
  const pub = publish({ x: zs }).properties.x;
  assert.deepEqual(Object.keys(pub.properties), ["notebookId", "body", "extra"]);
  assert.deepEqual(pub.required, ["notebookId", "body"]);
  assert.equal(pub.properties.notebookId.type, "string");
  assert.equal(pub.additionalProperties, true);
  assert.deepEqual(grammarHazards(pub), []);
  assert.deepEqual(zs.parse({ notebookId: "n", body: { k5999: "kept" }, other: 1 }), { notebookId: "n", body: { k5999: "kept" }, other: 1 });
  assert.equal(zs.safeParse({ body: {} }).success, false, "a required argument is still required");
  // A source whose tools together exceed the pool: later tools go out shallow, still typed at the top.
  const pool = { units: 0 };
  const late = publish({ x: jsonSchemaToZodObject({ type: "object", properties: { q: { type: "string" }, o: { type: "object", properties: { a: { type: "string" } } } }, required: ["q"] }, pool) }).properties.x;
  assert.equal(late.properties.q.type, "string");
  assert.deepEqual(late.properties.o, { type: "object", properties: {}, additionalProperties: true });
  assert.ok(SOURCE_BUDGET > 0);
  const small = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  assert.equal(jsonSchemaToZodObject(small), jsonSchemaToZodObject(small), "converted once per upstream schema object");
});

test("strictness reaches every closed object inside a multi-branch union, and only there", () => {
  const closed = (props, req = []) => ({ type: "object", properties: props, required: req, additionalProperties: false });
  const s = { type: "object", properties: {
    nested: { anyOf: [closed({ kind: { const: "a" }, opt: closed({ x: { type: "string" } }) }, ["kind"]), closed({ kind: { const: "a" }, opt: closed({ x: { type: "string" }, y: { type: "string" } }) }, ["kind"])] },
    single: { anyOf: [{ type: "string" }, { anyOf: [closed({ id: { type: "string" } }, ["id"])] }, closed({ id: { type: "string" }, deep: { type: "boolean" } }, ["id"])] },
    typeArr: { type: ["object", "string"], properties: { id: { type: "string" } }, additionalProperties: false },
    maybe: { type: ["object", "null"], properties: { id: { type: "string" } }, additionalProperties: false },
  } };
  assert.deepEqual(parse(s, { nested: { kind: "a", opt: { x: "1", y: "2" } } }).data.nested, { kind: "a", opt: { x: "1", y: "2" } });
  assert.deepEqual(parse(s, { single: { id: "x", deep: true } }).data.single, { id: "x", deep: true });
  assert.deepEqual(parse(s, { typeArr: { id: "x", junk: 1 } }).data.typeArr, { id: "x" }, "object|string: one object branch, so it strips as before");
  assert.deepEqual(parse(s, { maybe: { id: "x", junk: 1 } }).data.maybe, { id: "x" }, "object|null is not a real union: it strips as before");
  const strOrObj = { type: "object", properties: { v: { anyOf: [{ type: "string" }, closed({ id: { type: "string" } })] } } };
  assert.deepEqual(parse(strOrObj, { v: { id: "x", junk: 1 } }).data.v, { id: "x" }, "only one branch can take an object: it strips as the upstream would");
});
