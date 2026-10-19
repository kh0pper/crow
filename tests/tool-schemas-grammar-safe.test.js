/**
 * Every published MCP tool input schema is usable by a grammar-constrained
 * local model (queue item 26 follow-up; the private engineering notes have the
 * plan).
 *
 * llama-server compiles each tool's JSON Schema into a GBNF grammar for the
 * call arguments. Its json-schema-to-grammar maps an EMPTY schema {} to the
 * object rule, so where a tool publishes {} (z.any(), z.unknown(),
 * z.record(z.any())) the model can only ever send an object — never a string
 * or a number. #498 proved it live on the 35B for artifact_create's source.
 * This test builds every schema a client can see (core servers, crow-core,
 * the gateway router and board, every bundle server, and the three
 * re-publishers that convert an upstream JSON Schema back into zod) and
 * refuses any untyped node and any $ref.
 *
 * Safe "any" spellings: z.object({}).passthrough() (additionalProperties:
 * true → any value) and z.array(z.any()) (no items → array of any values).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { collectPublishedToolSchemas, grammarHazards } from "./helpers/published-tool-schemas.js";

const repoRoot = join(import.meta.dirname, "..");

// Explicit exceptions: { source, tool, path, reason }. Empty on purpose — a
// new entry needs a reason a reviewer can check (e.g. a third-party schema we
// re-publish verbatim and cannot type).
const ALLOWLIST = [];

const allowed = (e, h) => ALLOWLIST.some((a) => a.source === e.source && a.tool === e.tool && a.path === h.path);

test("grammarHazards flags untyped nodes and $ref, and passes the safe 'any' spellings", () => {
  const kinds = (s) => grammarHazards(s).map((h) => `${h.kind}@${h.path}`);
  assert.deepEqual(kinds({}), ["untyped@"]);
  assert.deepEqual(kinds({ type: "object", properties: { a: { description: "x" } } }), ["untyped@.a"]);
  assert.deepEqual(kinds({ type: "object", additionalProperties: {} }), ["untyped@{*}"]);
  assert.deepEqual(kinds({ type: "array", items: {} }), ["untyped@[]"]);
  assert.deepEqual(kinds({ type: "array", items: [{ type: "string" }, {}] }), ["untyped@[1]"]);
  assert.deepEqual(kinds({ anyOf: [{ type: "string" }, { type: "object", additionalProperties: {} }] }), ["untyped@<anyOf1>{*}"]);
  assert.deepEqual(kinds({ type: "object", properties: { a: { $ref: "#/properties/b" } } }), ["$ref@.a"]);
  assert.deepEqual(kinds({ type: "object", properties: {}, additionalProperties: true }), []);
  assert.deepEqual(kinds({ type: "array" }), []);
  assert.deepEqual(kinds({ type: ["string", "number", "null"] }), []);
  assert.deepEqual(kinds({ enum: ["a", "b"] }), []);
  assert.deepEqual(kinds({ type: "string", allOf: [{ pattern: "^a$" }, { pattern: "^b$" }] }), ["allOf@", "untyped@<allOf0>", "untyped@<allOf1>"]);
  assert.deepEqual(kinds({ type: "string", pattern: "abc" }), ["pattern@"]);
  assert.deepEqual(kinds({ type: "string", pattern: "^abc$" }), []);
  assert.deepEqual(kinds({ type: "object", properties: { o: { type: "object", properties: {}, additionalProperties: false } } }), ["empty-object@.o"]);
  assert.deepEqual(kinds({ type: "object", properties: {}, additionalProperties: false }), [], "a tool with no arguments is fine");
  assert.deepEqual(kinds({ type: "object", properties: { never: { not: {} } } }), [], "z.never() publishes {not:{}}; the grammar ignores not");
});

test("every published tool schema is typed all the way down (no {} and no $ref)", { timeout: 240_000 }, async () => {
  const { entries, failures } = await collectPublishedToolSchemas();
  assert.deepEqual(failures.map((f) => `${f.source}: ${f.error.split("\n")[0]}`), [], "every tool source must build");
  const bad = [];
  for (const e of entries) {
    for (const h of grammarHazards(e.inputSchema)) {
      if (!allowed(e, h)) bad.push(`${e.source} ${e.tool} ${h.kind} at ${h.path || "(root)"}`);
    }
  }
  assert.deepEqual(bad, [], "untyped or $ref nodes in published tool schemas");
});

test("the inventory covers every surface: core, router, board, every bundle factory, the re-publishers", async () => {
  const { entries, bundleFactories } = await collectPublishedToolSchemas();
  const sources = new Set(entries.map((e) => e.source));
  for (const s of ["core:memory", "core:projects", "core:sharing", "core:storage", "core:blog", "core:wm", "core:crow-core",
    "gateway:router", "gateway:board", "republish:gateway-proxy", "republish:crow-remote-proxy"]) {
    assert.ok(sources.has(s), `missing source ${s}`);
  }
  // An independent signal (not the scanner's regex): every bundle whose server code constructs an
  // McpServer anywhere under server/ must have published tools.
  const walkJs = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walkJs(join(d, e.name))) : /\.(m?js)$/.test(e.name) ? [join(d, e.name)] : []);
  const withMcp = readdirSync(join(repoRoot, "bundles")).filter((id) => {
    const dir = join(repoRoot, "bundles", id, "server");
    return existsSync(dir) && walkJs(dir).some((f) => /new McpServer\s*\(/.test(readFileSync(f, "utf8")));
  });
  assert.ok(withMcp.length >= 50, `expected the repo's ~57 MCP bundles, found ${withMcp.length}`);
  const bundleSources = new Set([...sources].filter((s) => s.startsWith("bundle:")).map((s) => s.slice(7)));
  assert.deepEqual(withMcp.filter((id) => !bundleSources.has(id)), [], "bundles with an McpServer that the inventory did not build");
  assert.ok(bundleFactories.length >= withMcp.length);
  for (const t of ["artifact_create", "sunvox_compose", "maker_validate_lesson", "board_create_item", "crow_memory", "crow_tools"]) {
    assert.ok(entries.some((e) => e.tool === t), `tool ${t} is in the inventory`);
  }
  // crow-core re-publishes every server it can activate, not just memory.
  assert.ok(entries.some((e) => e.source === "core:crow-core" && e.tool === "crow_create_post"), "crow-core lists the blog tools once activated");
  assert.ok(sources.has("chat:getChatTools") && sources.has("kiosk:tools"), "the chat/voice and kiosk tool lists are in");
  // The re-publishers saw every first-hand tool.
  const firstHand = entries.filter((e) => e.source.startsWith("core:") || e.source.startsWith("gateway:") || e.source.startsWith("bundle:")).length;
  assert.equal(entries.filter((e) => e.source === "republish:gateway-proxy").length, firstHand);
  assert.equal(entries.filter((e) => e.source === "republish:crow-remote-proxy").length, firstHand);
});

test("only bundle-declared runtime packages are stubbed (a typo'd import is never hidden)", async () => {
  const { stubbedPackages } = await collectPublishedToolSchemas();
  const declared = new Set();
  for (const id of readdirSync(join(repoRoot, "bundles"))) {
    const pj = join(repoRoot, "bundles", id, "package.json");
    if (!existsSync(pj)) continue;
    const j = JSON.parse(readFileSync(pj, "utf8"));
    for (const k of Object.keys({ ...j.dependencies, ...j.optionalDependencies, ...j.peerDependencies })) declared.add(k);
  }
  assert.deepEqual(stubbedPackages.filter((p) => !declared.has(p)), []);
});
