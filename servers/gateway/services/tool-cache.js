/**
 * The per-service tool cache (project services Task 14, I3): what a service's child answered to
 * tools/list the last time any of its connections started, so listing tools (Bot Builder, the
 * mount's tools/list, dashboard chat) never starts a child.
 *
 * One file, `<crowHome>/service-tools-cache.json` (mode 0600), keyed `serviceId@bundleVersion`:
 * a version change is a miss, and a write drops the service's other versions. Each tool keeps
 * its name, description and input schema only (no annotations, _meta or output schema).
 *
 * The cache is per SERVICE, so one connection's tools are what every other project's connection
 * of that service lists: a value injected into the writing child must never reach it.
 * sanitizeToolsForCache (run by children.js at write time with the writer's injected values)
 * drops a tool whose name holds one, and redacts + caps the description and every human-readable
 * schema string (description, title, const, default, enum / examples strings), the same walk as
 * the loopback mount's sanitizeSchema (loopback-tool-mount.js, not exported there).
 * Nothing here logs a tool's text.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { redactSecrets } from "../../shared/redact-secrets.js";

export const TOOL_CACHE_FILE = "service-tools-cache.json";
const MAX_TOOLS = 500;
const NAME_MAX = 128;
const DESC_MAX = 2048;          // the mount's per-string cap
const SCHEMA_MAX_DEPTH = 64;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clip = (v, secrets) => redactSecrets(v, secrets).slice(0, DESC_MAX);

/** The mount's sanitizeSchema, mirrored: keys and structure kept, readable strings redacted and capped. */
export function sanitizeSchema(node, secrets, depth = 0) {
  if (depth > SCHEMA_MAX_DEPTH) return {};
  if (Array.isArray(node)) return node.map((v) => sanitizeSchema(v, secrets, depth + 1));
  if (!isPlainObject(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === "description" || k === "title" || k === "const" || k === "default") && typeof v === "string") out[k] = clip(v, secrets);
    else if ((k === "enum" || k === "examples") && Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? clip(x, secrets) : sanitizeSchema(x, secrets, depth + 1)));
    else out[k] = sanitizeSchema(v, secrets, depth + 1);
  }
  return out;
}

/** Tools as they may be cached: a tool whose name holds a secret is dropped; the rest sanitized. */
export function sanitizeToolsForCache(tools, secrets = []) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!isPlainObject(t) || typeof t.name !== "string" || !t.name) continue;
    if (redactSecrets(t.name, secrets) !== t.name) continue;
    out.push({
      name: t.name,
      ...(typeof t.description === "string" ? { description: clip(t.description, secrets) } : {}),
      inputSchema: sanitizeSchema(isPlainObject(t.inputSchema) ? t.inputSchema : { type: "object" }, secrets),
    });
  }
  return out;
}

const cachePath = (crowHome) => join(crowHome, TOOL_CACHE_FILE);
const cacheKey = (serviceId, version) => `${serviceId}@${version || "unknown"}`;

function readAll(crowHome) {
  try {
    const v = JSON.parse(readFileSync(cachePath(crowHome), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** One tool as cached: name (required), description, inputSchema (an object) — nothing else. */
export function cachedToolShape(tool) {
  if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name || tool.name.length > NAME_MAX) return null;
  const out = { name: tool.name };
  if (typeof tool.description === "string") out.description = tool.description.slice(0, DESC_MAX);
  const schema = tool.inputSchema;
  out.inputSchema = schema && typeof schema === "object" && !Array.isArray(schema) ? schema : { type: "object" };
  return out;
}

/** @returns {Array<{name:string, description?:string, inputSchema:object}>|null} null on a miss */
export function readToolCache(crowHome, serviceId, version) {
  if (typeof crowHome !== "string" || typeof serviceId !== "string" || !serviceId) return null;
  const hit = readAll(crowHome)[cacheKey(serviceId, version)];
  if (!hit || !Array.isArray(hit.tools)) return null;
  return hit.tools.map(cachedToolShape).filter(Boolean);
}

/** Writes this service's tools at this version (atomic, 0600) and drops its other versions. */
export function writeToolCache(crowHome, serviceId, version, tools) {
  if (typeof crowHome !== "string" || typeof serviceId !== "string" || !serviceId) return;
  const all = readAll(crowHome);
  for (const k of Object.keys(all)) if (k.startsWith(`${serviceId}@`)) delete all[k];
  all[cacheKey(serviceId, version)] = {
    tools: (Array.isArray(tools) ? tools : []).slice(0, MAX_TOOLS).map(cachedToolShape).filter(Boolean),
    writtenAt: new Date().toISOString(),
  };
  if (!existsSync(crowHome)) mkdirSync(crowHome, { recursive: true, mode: 0o700 });
  const final = cachePath(crowHome);
  const tmp = `${final}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, final);
}
