/**
 * The per-service tool cache (project services Task 14, I3): what a service's child answered to
 * tools/list the last time any of its connections started, so listing tools (Bot Builder, the
 * mount's tools/list, dashboard chat) never starts a child.
 *
 * One file, `<crowHome>/service-tools-cache.json` (mode 0600), keyed `serviceId@bundleVersion`:
 * a version change is a miss, and a write drops the service's other versions. Each tool keeps
 * its name, description and input schema only (no annotations, _meta or output schema). The
 * caller redacts descriptions before writing (children.js does, with the connection's values).
 * Nothing here logs a tool's text.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const TOOL_CACHE_FILE = "service-tools-cache.json";
const MAX_TOOLS = 500;
const NAME_MAX = 128;
const DESC_MAX = 8192;

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
