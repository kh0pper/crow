/**
 * Tool-schema sanitizer (C1 standing-gap fix).
 *
 * llama-server's native tool-calling compiles every advertised JSON-schema into
 * a GBNF sampling grammar. An absurd maxLength/minLength bound (Funkwhale's
 * fw_upload_track file_base64: { maxLength: 200_000_000 }) blows up that
 * compiler and hard-fails the WHOLE chat request with a 400 ("Failed to
 * initialize samplers: failed to parse grammar") — not just the one tool.
 * getChatTools() is the single choke point every chat-path caller (chat.js,
 * one-shot.js, meta-glasses routes.js) goes through, so sanitizeToolSchema()
 * is applied there, generically, for every advertised tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getChatTools, sanitizeToolSchema } from "../servers/gateway/ai/tool-executor.js";
import { connectedServers } from "../servers/gateway/proxy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const BOUND = 1024;

// ---------------------------------------------------------------------------
// Unit tests: sanitizeToolSchema
// ---------------------------------------------------------------------------

test("sanitizeToolSchema deletes an oversized top-level maxLength", () => {
  const out = sanitizeToolSchema({ type: "string", maxLength: 200_000_000 });
  assert.equal("maxLength" in out, false);
  assert.equal(out.type, "string");
});

test("sanitizeToolSchema deletes an oversized top-level minLength", () => {
  const out = sanitizeToolSchema({ type: "string", minLength: 5_000_000 });
  assert.equal("minLength" in out, false);
  assert.equal(out.type, "string");
});

test("sanitizeToolSchema deletes an oversized maxLength nested in properties", () => {
  const schema = {
    type: "object",
    properties: {
      library_uuid: { type: "string" },
      file_base64: { type: "string", maxLength: 200_000_000 },
      filename: { type: "string", maxLength: 500 },
    },
    required: ["library_uuid"],
  };
  const out = sanitizeToolSchema(schema);
  assert.equal("maxLength" in out.properties.file_base64, false);
  // sane bound elsewhere on the same schema is untouched
  assert.equal(out.properties.filename.maxLength, 500);
  assert.deepEqual(Object.keys(out.properties), Object.keys(schema.properties));
});

test("sanitizeToolSchema deletes an oversized maxLength nested in array items", () => {
  const schema = {
    type: "array",
    items: { type: "string", maxLength: 10_000_000 },
  };
  const out = sanitizeToolSchema(schema);
  assert.equal("maxLength" in out.items, false);
  assert.equal(out.items.type, "string");
});

test("sanitizeToolSchema deletes oversized bounds inside anyOf/oneOf/allOf", () => {
  const schema = {
    anyOf: [
      { type: "string", maxLength: 999_999_999 },
      { type: "string", maxLength: 100 },
    ],
    oneOf: [{ type: "string", minLength: 50_000_000 }],
    allOf: [{ type: "string", maxLength: 1024 }],
  };
  const out = sanitizeToolSchema(schema);
  assert.equal("maxLength" in out.anyOf[0], false);
  assert.equal(out.anyOf[1].maxLength, 100);
  assert.equal("minLength" in out.oneOf[0], false);
  assert.equal(out.allOf[0].maxLength, 1024); // exactly at the bound: kept
});

test("sanitizeToolSchema deletes oversized bounds inside an object-form additionalProperties", () => {
  const schema = {
    type: "object",
    additionalProperties: { type: "string", maxLength: 1_000_000 },
  };
  const out = sanitizeToolSchema(schema);
  assert.equal("maxLength" in out.additionalProperties, false);
});

test("sanitizeToolSchema preserves a sane maxLength (255)", () => {
  const out = sanitizeToolSchema({ type: "string", maxLength: 255 });
  assert.equal(out.maxLength, 255);
});

test("sanitizeToolSchema preserves a sane minLength (1)", () => {
  const out = sanitizeToolSchema({ type: "string", minLength: 1 });
  assert.equal(out.minLength, 1);
});

test("sanitizeToolSchema leaves non-length fields completely untouched", () => {
  const schema = {
    type: "object",
    $schema: "http://json-schema.org/draft-07/schema#",
    required: ["library_uuid"],
    additionalProperties: false,
    properties: { library_uuid: { type: "string", format: "uuid" } },
  };
  const out = sanitizeToolSchema(schema);
  assert.deepEqual(out, schema);
});

test("sanitizeToolSchema does not mutate its input", () => {
  const schema = { type: "object", properties: { a: { type: "string", maxLength: 999_999_999 } } };
  const before = JSON.parse(JSON.stringify(schema));
  sanitizeToolSchema(schema);
  assert.deepEqual(schema, before, "original schema object must be untouched");
});

test("sanitizeToolSchema returns the original on malformed input (null)", () => {
  assert.equal(sanitizeToolSchema(null), null);
});

test("sanitizeToolSchema returns the original on malformed input (a string)", () => {
  assert.equal(sanitizeToolSchema("not a schema"), "not a schema");
});

test("sanitizeToolSchema returns the original on malformed input (undefined)", () => {
  assert.equal(sanitizeToolSchema(undefined), undefined);
});

test("sanitizeToolSchema never throws on a cyclic-ish structure — returns the original", () => {
  const cyclic = { type: "object", properties: {} };
  cyclic.properties.self = cyclic; // self-reference
  assert.doesNotThrow(() => sanitizeToolSchema(cyclic));
  const out = sanitizeToolSchema(cyclic);
  // Defensive path: on any walk failure (stack overflow from the cycle), the
  // ORIGINAL object is returned unchanged (identity-equal), not a partial tree.
  assert.equal(out, cyclic);
});

test("sanitizeToolSchema never throws on a getter that throws — returns the original", () => {
  const evil = { type: "object" };
  Object.defineProperty(evil, "properties", { enumerable: true, get() { throw new Error("boom"); } });
  assert.doesNotThrow(() => sanitizeToolSchema(evil));
  assert.equal(sanitizeToolSchema(evil), evil);
});

// ---------------------------------------------------------------------------
// Integration-shaped: getChatTools() output has NO maxLength/minLength > 4096
// anywhere, across the real tool list (core categories + discover + delegate +
// bot-cron + any addon tools).
// ---------------------------------------------------------------------------

function walkForOversizedBounds(node, path, violations) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkForOversizedBounds(item, `${path}[${i}]`, violations));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "maxLength" || key === "minLength") && typeof value === "number" && value > BOUND) {
      violations.push(`${path}.${key} = ${value}`);
    }
    if (value && typeof value === "object") {
      walkForOversizedBounds(value, `${path}.${key}`, violations);
    }
  }
}

test("getChatTools() (unbound) output carries no maxLength/minLength above 4096 anywhere", () => {
  const tools = getChatTools();
  const violations = [];
  for (const t of tools) {
    walkForOversizedBounds(t.inputSchema, t.name, violations);
  }
  assert.deepEqual(violations, [], `oversized bounds leaked into advertised tools: ${violations.join(", ")}`);
});

test("getChatTools() (bound to a bot) output carries no maxLength/minLength above 4096 anywhere", () => {
  const tools = getChatTools({ botDef: { bot_id: "botA", tools: { crow_mcp: ["memory/crow_store_memory"] } } });
  const violations = [];
  for (const t of tools) {
    walkForOversizedBounds(t.inputSchema, t.name, violations);
  }
  assert.deepEqual(violations, [], `oversized bounds leaked into advertised tools: ${violations.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Real addon-tool integration: reproduce the exact Funkwhale shape via
// connectedServers (the real mechanism getChatTools() reads addon tools from)
// and prove getChatTools() sanitizes it — not a re-implementation, the actual
// code path a live fw_upload_track connection would go through.
// ---------------------------------------------------------------------------

test("getChatTools() sanitizes an oversized-maxLength addon tool advertised via connectedServers", () => {
  const FAKE_ID = "__test_funkwhale_sanitizer__";
  connectedServers.set(FAKE_ID, {
    status: "connected",
    tools: [
      {
        name: "fw_upload_track",
        description: "Upload an audio file.",
        inputSchema: {
          type: "object",
          properties: {
            library_uuid: { type: "string" },
            file_base64: { type: "string", maxLength: 200_000_000 },
          },
          required: ["library_uuid"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
    ],
  });
  try {
    const tools = getChatTools();
    const fw = tools.find((t) => t.name === "fw_upload_track");
    assert.ok(fw, "fw_upload_track should be promoted and advertised");
    assert.equal("maxLength" in fw.inputSchema.properties.file_base64, false,
      "the oversized bound must be stripped by getChatTools()");
    assert.equal(fw.inputSchema.properties.file_base64.type, "string", "the rest of the property is untouched");
  } finally {
    connectedServers.delete(FAKE_ID);
  }
});

// ---------------------------------------------------------------------------
// Funkwhale source fix: the absurd bound is gone from the bundle's own schema
// (fixes non-chat MCP clients too, independent of the gateway-side sanitizer).
// ---------------------------------------------------------------------------

test("funkwhale bundle: fw_upload_track's file_base64 no longer declares an absurd maxLength", () => {
  const src = readFileSync(join(repoRoot, "bundles/funkwhale/server/server.js"), "utf8");
  assert.equal(src.includes("200_000_000"), false, "the 200-million-char bound must be removed from the source");
  assert.equal(src.includes("200000000"), false, "the 200-million-char bound must be removed from the source (unscored form)");
  assert.match(src, /file_base64:\s*z\.string\(\)\.optional\(\)/, "file_base64 should stay a plain optional string (handler enforces size, not the schema)");
});
