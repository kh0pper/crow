/**
 * Convert an MCP tool's JSON-Schema inputSchema into zod, for every
 * re-publisher: the gateway /tools proxy (external and bundle MCP tools), the
 * L2b cross-instance forward-proxy (scripts/pi-bots/crow-remote-proxy.mjs) and
 * crow-core (servers/core/server.js). Single source of truth: they must
 * convert identically.
 *
 * The re-published schema is what a client's model sees, so it keeps the
 * upstream's TYPES: nested objects stay objects with typed properties, T|null
 * stays T|null, enums stay enums, local $refs ($defs / definitions, as pydantic
 * emits them) are resolved. It never publishes an empty {} schema:
 * llama.cpp's json-schema-to-grammar turns {} into the "object" rule, so a
 * grammar-constrained local model could only send an object there (queue item
 * 26; tests/tool-schemas-grammar-safe.test.js). A node that stays untyped
 * becomes anyJson(), a union of every JSON type that publishes with no {}.
 * NOTE: on engines that emit tool arguments as tagged text (llama.cpp's Qwen
 * format), a TOP-LEVEL argument whose schema admits a string is generated as
 * raw text, so a top-level anyJson() arrives as a string there.
 *
 * Validation: the upstream validates the forwarded call with its own schema,
 * so this layer only has to be no looser than it was (it used to accept any
 * value for every nested field). Length, pattern, format, range and default
 * keywords are NOT carried: the upstream enforces them (and applies its own
 * defaults to omitted fields), and unbounded lengths are a grammar hazard of
 * their own (see tool-executor's sanitizeToolSchema). Every call builds fresh
 * zod instances, so a sub-schema repeated inside one tool never publishes as a
 * $ref.
 */
import { z } from "zod";

const MAX_DEPTH = 12;
// Work cap per tool: every convert() call spends one. Bounds $ref expansion of
// an upstream schema (a DAG of $defs grows as fanout^depth) and the published size.
const NODE_BUDGET = 2000;
const TYPE_KEYS = ["type", "properties", "items", "enum", "const", "$ref", "anyOf", "oneOf", "allOf"];

/** Any JSON value, spelled so it publishes without an empty {} anywhere. */
export function anyJson() {
  return z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any()), z.object({}).passthrough()]);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasTypeInfo = (s) => isObj(s) && TYPE_KEYS.some((k) => k in s);

function withMeta(zs, prop) {
  let out = prop.nullable === true ? zs.nullable() : zs; // OpenAPI-style nullable
  if (typeof prop.description === "string" && prop.description) out = out.describe(prop.description);
  return out;
}

function unionOf(list) {
  if (list.length === 0) return anyJson();
  if (list.length === 1) return list[0];
  return z.union(list);
}

function literalUnion(values) {
  const ok = values.filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
  if (ok.length === 0) return anyJson();
  if (ok.every((v) => typeof v === "string")) return z.enum(ok);
  return unionOf(ok.map((v) => z.literal(v)));
}

/** Resolve a local JSON pointer ("#/$defs/X", "#/definitions/X", "#/properties/a/…") against the root. */
function resolveRef(ref, ctx) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return null;
  let node = ctx.root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    let key;
    try { key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { return null; }
    if (!isObj(node) || !Object.hasOwn(node, key)) return null;
    node = node[key];
  }
  return isObj(node) ? node : null;
}

function propertiesShape(schema, ctx, depth) {
  const shape = {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key === "__proto__") continue; // would set the shape's prototype instead of a property
    const zs = convert(prop, ctx, depth + 1);
    shape[key] = required.has(key) ? zs : zs.optional();
  }
  return shape;
}

function objectOf(prop, ctx, depth, inUnion = false) {
  const ap = prop.additionalProperties;
  if (isObj(prop.properties)) {
    const shape = propertiesShape(prop, ctx, depth);
    if (ctx.budget < 0) return z.object({}).passthrough(); // over budget: this object goes out untyped, not huge
    // Closed: zod's default strip, published additionalProperties:false. As a union
    // branch it is strict instead: zod takes the FIRST branch that parses, and a
    // stripping branch with a subset of the keys would silently drop the rest.
    if (ap === false) return inUnion ? z.object(shape).strict() : z.object(shape);
    if (isObj(ap) && hasTypeInfo(ap)) return z.object(shape).catchall(convert(ap, ctx, depth + 1));
    return z.object(shape).passthrough(); // absent, true or an untyped schema: open, any values
  }
  if (isObj(ap) && hasTypeInfo(ap)) return z.record(z.string(), convert(ap, ctx, depth + 1));
  return z.object({}).passthrough();
}

function typed(type, prop, ctx, depth, inUnion = false) {
  if (Array.isArray(prop.enum) && prop.enum.length && type !== "object" && type !== "array") return literalUnion(prop.enum);
  switch (type) {
    case "string": return z.string();
    case "number": return z.number();
    case "integer": return z.number().int();
    case "boolean": return z.boolean();
    case "null": return z.null();
    case "array":
      // z.array(z.any()) publishes {type:"array"} (no items): llama.cpp's "array of any values".
      return isObj(prop.items) ? z.array(convert(prop.items, ctx, depth + 1)) : z.array(z.any());
    case "object": return objectOf(prop, ctx, depth, inUnion);
    default: return anyJson();
  }
}

function convert(prop, ctx, depth, inUnion = false) {
  if (!isObj(prop) || depth > MAX_DEPTH || --ctx.budget < 0) return anyJson();
  if ("$ref" in prop) {
    const target = resolveRef(prop.$ref, ctx);
    // Cycles are caught on the resolved NODE, so another spelling of the same pointer is no way round.
    if (!target || ctx.resolving.has(target)) return withMeta(anyJson(), prop);
    ctx.resolving.add(target);
    try { return withMeta(convert(target, ctx, depth + 1, inUnion), prop); }
    finally { ctx.resolving.delete(target); }
  }
  if (Array.isArray(prop.allOf) && prop.allOf.length === 1 && !TYPE_KEYS.some((k) => k !== "allOf" && k in prop)) {
    // pydantic v1: a described model field is {description, allOf:[{$ref}]}.
    return withMeta(convert(prop.allOf[0], ctx, depth + 1, inUnion), prop);
  }
  let zs;
  const alts = Array.isArray(prop.anyOf) ? prop.anyOf : Array.isArray(prop.oneOf) ? prop.oneOf : null;
  // {type:"object", properties, anyOf:[{required:[a]},{required:[b]}]} — branches that only add
  // requirements are not types; keep the parent's type then (the upstream enforces the rest).
  const typedAlts = alts && alts.some(hasTypeInfo) ? alts : null;
  if (typedAlts) zs = unionOf(typedAlts.map((a) => convert(a, ctx, depth + 1, typedAlts.length > 1)));
  else if ("const" in prop) zs = literalUnion([prop.const]);
  else if (Array.isArray(prop.type)) zs = unionOf(prop.type.map((t) => typed(t, prop, ctx, depth, prop.type.length > 1)));
  else if (typeof prop.type === "string") zs = typed(prop.type, prop, ctx, depth, inUnion);
  else if (Array.isArray(prop.enum)) zs = literalUnion(prop.enum);
  else if (isObj(prop.properties)) zs = objectOf(prop, ctx, depth, inUnion);
  else if (isObj(prop.items)) zs = typed("array", prop, ctx, depth);
  else zs = anyJson(); // {}, description-only, multi-member allOf, not, …
  return withMeta(zs, prop);
}

const newCtx = (root) => ({ root: isObj(root) ? root : {}, resolving: new Set(), budget: NODE_BUDGET });

/** Convert one JSON Schema node to a zod schema (`root` resolves local $refs). */
export function jsonSchemaToZod(prop, root = prop) {
  return convert(prop, newCtx(root), 0);
}

/** Convert a JSON Schema "properties" + "required" into a Zod object shape. */
export function jsonSchemaPropertiesToZod(schema) {
  if (!isObj(schema) || !isObj(schema.properties)) return {};
  return propertiesShape(schema, newCtx(schema), 0);
}

/**
 * The whole input schema as a zod object, for McpServer.registerTool(). Unlike
 * the raw shape (which the SDK wraps in a stripping z.object), an OPEN root
 * (additionalProperties absent or true) stays open: its unknown top-level
 * arguments reach the upstream, and a root with no listed properties is not
 * re-published as "no arguments at all".
 */
export function jsonSchemaToZodObject(schema) {
  try {
    const shape = jsonSchemaPropertiesToZod(schema);
    const closed = isObj(schema) && schema.additionalProperties === false;
    return closed ? z.object(shape) : z.object(shape).passthrough();
  } catch (err) {
    // One malformed upstream tool never sinks the others: it is forwarded as is.
    console.warn(`[json-schema-to-zod] could not convert a tool schema (${err?.message || err}); forwarding it untyped`);
    return z.object({}).passthrough();
  }
}
