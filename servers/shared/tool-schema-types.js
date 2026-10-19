/**
 * Zod building blocks for MCP tool input schemas that a grammar-constrained
 * local model can actually fill in.
 *
 * Never publish z.any(), z.unknown() or z.record(z.any()) in a tool schema:
 * they publish an empty {} schema, and llama.cpp's json-schema-to-grammar maps
 * {} to the "object" rule, so the model can only send an object there — never
 * a string or a number (queue item 26; tests/tool-schemas-grammar-safe.test.js
 * enforces it for every published tool). Every helper returns a FRESH instance:
 * reusing one zod instance twice inside a tool publishes a $ref.
 */
import { z } from "zod";

/**
 * A model sometimes sends an object argument as a JSON string
 * ("{\"query\":\"x\"}"). Parse it ONLY when the whole string is a JSON object;
 * anything else is returned as is and fails the object check that follows.
 */
export function parseJsonObjectString(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{")) return v;
  try {
    const parsed = JSON.parse(t);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : v;
  } catch {
    return v;
  }
}

/**
 * A free-form JSON object (any keys, any JSON values): the same acceptance as
 * z.record(z.any()) — an object, never an array or null, every key kept — but
 * published as {type:"object", properties:{}, additionalProperties:true}, which
 * llama.cpp maps to "object whose values are any JSON value". A JSON-string
 * object is parsed first (parseJsonObjectString).
 */
export function jsonObject() {
  return z.preprocess(parseJsonObjectString, z.object({}).passthrough());
}
