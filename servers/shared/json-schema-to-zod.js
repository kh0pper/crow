/**
 * Convert an MCP tool's JSON-Schema inputSchema into the Zod raw shape that
 * @modelcontextprotocol/sdk's McpServer.tool() expects. Shared single source of
 * truth: the gateway proxy (re-exposing external MCP tools) and the L2b
 * cross-instance forward-proxy (re-exposing a peer's tools) must convert
 * schemas identically.
 */
import { z } from "zod";

/**
 * Convert a JSON Schema property definition to a Zod schema.
 * Handles the common types MCP tools use.
 */
export function jsonSchemaToZod(prop) {
  if (!prop) return z.string();

  // Handle anyOf (often used for nullable types)
  if (prop.anyOf) {
    const nonNull = prop.anyOf.filter((s) => s.type !== "null");
    if (nonNull.length === 1) {
      const inner = jsonSchemaToZod(nonNull[0]);
      return inner.optional();
    }
    return z.any();
  }

  switch (prop.type) {
    case "string":
      if (prop.enum) return z.enum(prop.enum);
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(prop.items ? jsonSchemaToZod(prop.items) : z.any());
    case "object":
      return z.record(z.any());
    default:
      return z.any();
  }
}

/**
 * Convert a JSON Schema "properties" + "required" into a Zod object shape.
 */
export function jsonSchemaPropertiesToZod(schema) {
  if (!schema || !schema.properties) return {};

  const shape = {};
  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodProp = jsonSchemaToZod(prop);
    if (prop.description) zodProp = zodProp.describe(prop.description);
    if (!required.has(key)) zodProp = zodProp.optional();
    shape[key] = zodProp;
  }
  return shape;
}
