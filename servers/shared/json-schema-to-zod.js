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
// Work cap per tool, in units: every node visited costs 1, an enum costs its
// values, a description its length / 256. It is charged BEFORE any work, and
// every loop stops once it is spent, so a hostile upstream schema (a $defs DAG
// grows as fanout^depth; long enums or descriptions repeated at every $ref)
// cannot blow up memory or the published size. Crow's largest tool uses ~60.
const BUDGET = 1000;
const TYPE_KEYS = ["type", "properties", "items", "enum", "const", "$ref", "anyOf", "oneOf", "allOf"];

/** Any JSON value, spelled so it publishes without an empty {} anywhere. */
export function anyJson() {
  return z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any()), z.object({}).passthrough()]);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasTypeInfo = (s) => isObj(s) && TYPE_KEYS.some((k) => k in s);
const spend = (ctx, units) => (ctx.budget -= units) >= 0;
const spent = (ctx) => ctx.budget < 0;

function withMeta(zs, prop, ctx) {
  let out = prop.nullable === true ? zs.nullable() : zs; // OpenAPI-style nullable
  const d = prop.description;
  if (typeof d === "string" && d && spend(ctx, Math.ceil(d.length / 256))) out = out.describe(d);
  return out;
}

function unionOf(list) {
  if (list.length === 0) return anyJson();
  if (list.length === 1) return list[0];
  return z.union(list);
}

function literalUnion(values, ctx) {
  const ok = values.filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
  if (ok.length === 0 || !spend(ctx, ok.reduce((n, v) => n + 1 + Math.floor(String(v).length / 64), 0))) return anyJson();
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

function propertiesShape(schema, ctx, depth, strict) {
  const shape = {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (spent(ctx)) break;
    if (key === "__proto__") continue; // would set the shape's prototype instead of a property
    const zs = convert(prop, ctx, depth + 1, strict);
    shape[key] = required.has(key) ? zs : zs.optional();
  }
  return shape;
}

// `strict`: this node sits inside a union with more than one non-null branch.
// zod takes the FIRST branch that parses, so a closed object that strips
// unknown keys (zod's default) could silently drop the keys of the branch that
// was meant; there, closed objects are strict instead.
function objectOf(prop, ctx, depth, strict) {
  const ap = prop.additionalProperties;
  if (isObj(prop.properties)) {
    const shape = propertiesShape(prop, ctx, depth, strict);
    if (spent(ctx)) return z.object({}).passthrough(); // over budget: this object goes out untyped, not huge
    if (ap === false) return strict ? z.object(shape).strict() : z.object(shape); // closed: published additionalProperties:false
    if (isObj(ap) && hasTypeInfo(ap)) return z.object(shape).catchall(convert(ap, ctx, depth + 1, strict));
    return z.object(shape).passthrough(); // absent, true or an untyped schema: open, any values
  }
  if (isObj(ap) && hasTypeInfo(ap)) return z.record(z.string(), convert(ap, ctx, depth + 1, strict));
  return z.object({}).passthrough();
}

function typed(type, prop, ctx, depth, strict) {
  if (Array.isArray(prop.enum) && prop.enum.length && type !== "object" && type !== "array") return literalUnion(prop.enum, ctx);
  switch (type) {
    case "string": return z.string();
    case "number": return z.number();
    case "integer": return z.number().int();
    case "boolean": return z.boolean();
    case "null": return z.null();
    case "array":
      // z.array(z.any()) publishes {type:"array"} (no items): llama.cpp's "array of any values".
      return isObj(prop.items) ? z.array(convert(prop.items, ctx, depth + 1, strict)) : z.array(z.any());
    case "object": return objectOf(prop, ctx, depth, strict);
    default: return anyJson();
  }
}

const branches = (list, isNull) => list.filter((x) => !isNull(x)).length > 1;

function convert(prop, ctx, depth, strict = false) {
  if (!spend(ctx, 1) || !isObj(prop) || depth > MAX_DEPTH) return anyJson();
  if ("$ref" in prop) {
    const target = resolveRef(prop.$ref, ctx);
    // Cycles are caught on the resolved NODE, so another spelling of the same pointer is no way round.
    if (!target || ctx.resolving.has(target)) return withMeta(anyJson(), prop, ctx);
    ctx.resolving.add(target);
    try { return withMeta(convert(target, ctx, depth + 1, strict), prop, ctx); }
    finally { ctx.resolving.delete(target); }
  }
  if (Array.isArray(prop.allOf) && prop.allOf.length === 1 && !TYPE_KEYS.some((k) => k !== "allOf" && k in prop)) {
    // pydantic v1: a described model field is {description, allOf:[{$ref}]}.
    return withMeta(convert(prop.allOf[0], ctx, depth + 1, strict), prop, ctx);
  }
  let zs;
  const alts = Array.isArray(prop.anyOf) ? prop.anyOf : Array.isArray(prop.oneOf) ? prop.oneOf : null;
  // {type:"object", properties, anyOf:[{required:[a]},{required:[b]}]} — branches that only add
  // requirements are not types; keep the parent's type then (the upstream enforces the rest).
  const typedAlts = alts && alts.some(hasTypeInfo) ? alts : null;
  if (typedAlts) {
    const inner = strict || branches(typedAlts, (a) => isObj(a) && a.type === "null");
    const list = [];
    for (const a of typedAlts) { if (spent(ctx)) break; list.push(convert(a, ctx, depth + 1, inner)); }
    zs = spent(ctx) ? anyJson() : unionOf(list);
  } else if ("const" in prop) zs = literalUnion([prop.const], ctx);
  else if (Array.isArray(prop.type)) {
    const inner = strict || branches(prop.type, (t) => t === "null");
    zs = unionOf(prop.type.slice(0, 8).map((t) => typed(t, prop, ctx, depth, inner)));
  } else if (typeof prop.type === "string") zs = typed(prop.type, prop, ctx, depth, strict);
  else if (Array.isArray(prop.enum)) zs = literalUnion(prop.enum, ctx);
  else if (isObj(prop.properties)) zs = objectOf(prop, ctx, depth, strict);
  else if (isObj(prop.items)) zs = typed("array", prop, ctx, depth, strict);
  else zs = anyJson(); // {}, description-only, multi-member allOf, not, …
  return withMeta(zs, prop, ctx);
}

const newCtx = (root) => ({ root: isObj(root) ? root : {}, resolving: new Set(), budget: BUDGET });

/** Convert one JSON Schema node to a zod schema (`root` resolves local $refs). */
export function jsonSchemaToZod(prop, root = prop) {
  return convert(prop, newCtx(root), 0);
}

/** Convert a JSON Schema "properties" + "required" into a Zod object shape. */
export function jsonSchemaPropertiesToZod(schema) {
  if (!isObj(schema) || !isObj(schema.properties)) return {};
  return propertiesShape(schema, newCtx(schema), 0, false);
}

/**
 * The whole input schema as a zod object, for McpServer.registerTool(). Unlike
 * the raw shape (which the SDK wraps in a stripping z.object), an OPEN root
 * (additionalProperties absent or true) stays open: its unknown top-level
 * arguments reach the upstream, and a root with no listed properties is not
 * re-published as "no arguments at all".
 */
const converted = new WeakMap(); // upstream inputSchema object → zod: converted once, not per MCP session
export function jsonSchemaToZodObject(schema) {
  if (isObj(schema) && converted.has(schema)) return converted.get(schema);
  try {
    const ctx = newCtx(schema);
    const shape = isObj(schema) && isObj(schema.properties) ? propertiesShape(schema, ctx, 0, false) : {};
    const closed = isObj(schema) && schema.additionalProperties === false;
    // Over budget: a partial closed shape would strip the arguments it never reached.
    const out = spent(ctx) ? z.object({}).passthrough() : closed ? z.object(shape) : z.object(shape).passthrough();
    if (isObj(schema)) converted.set(schema, out);
    return out;
  } catch (err) {
    // One malformed upstream tool never sinks the others: it is forwarded as is.
    console.warn(`[json-schema-to-zod] could not convert a tool schema (${err?.message || err}); forwarding it untyped`);
    return z.object({}).passthrough();
  }
}
