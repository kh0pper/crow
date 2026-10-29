/**
 * Satellite tool pins (SAT-5, spec §9.1): the owner-approved `tools/list` of one bundle on one
 * satellite, its hash, and whether the satellite's last reported hash still matches it.
 *
 *   tools_sha256 = sha256(canonical JSON of the full tools/list `tools` array) — the satellite
 *   computes the same over its tool cache (servers/satellite/mcp-host.js), and reports it per
 *   bundle in GET status: tools[bundle] = {version, sha256} or {version, error} (no sha256: the
 *   list could not be cached, e.g. tools_too_large — "tools unavailable", never a mismatch).
 *
 * The satellite transport (proxy.js, SAT-7) disables a bundle's tools whenever toolsState is
 * not "ok"; approval (routes/satellites.js) writes a fresh pin, which re-enables them.
 */
import { canonicalJson, sha256Hex } from "../../shared/satellite-protocol.js";

export const MAX_TOOLS = 64;
export const MAX_DESCRIPTION = 300;

export const toolsSha = (tools) => sha256Hex(canonicalJson(tools));

/** The tool-name prefix for a bundle id: `-` → `_`. */
export const toolPrefix = (bundle) => String(bundle).replace(/-/g, "_");
export function toolNameRe(bundle) {
  return new RegExp(`^${toolPrefix(bundle).replace(/[^a-z0-9_]/g, "")}_[a-z0-9_]{1,64}$`);
}

/**
 * The §9.1 caps for an approval: names that pass the prefix rule (others are listed as
 * problems and will never be published), descriptions ≤ 300 chars, at most 64 tools.
 */
export function checkToolList(bundle, tools) {
  const list = Array.isArray(tools) ? tools : [];
  const re = toolNameRe(bundle);
  const allowed = [];
  const problems = [];
  for (const t of list) {
    const name = typeof t?.name === "string" ? t.name : "";
    if (!re.test(name)) { problems.push({ name, problem: "bad_name" }); continue; }
    if (typeof t.description === "string" && t.description.length > MAX_DESCRIPTION) { problems.push({ name, problem: "description_too_long" }); continue; }
    allowed.push(name);
  }
  return { allowed, problems, tooMany: list.length > MAX_TOOLS };
}

/** + added, − removed, ~ changed (description, schema or annotations differ). */
export function diffTools(oldTools, newTools) {
  const byName = (l) => new Map((Array.isArray(l) ? l : []).filter((t) => t && typeof t.name === "string").map((t) => [t.name, t]));
  const a = byName(oldTools);
  const b = byName(newTools);
  const added = [...b.keys()].filter((n) => !a.has(n)).sort();
  const removed = [...a.keys()].filter((n) => !b.has(n)).sort();
  const changed = [...b.keys()].filter((n) => a.has(n) && canonicalJson(a.get(n)) !== canonicalJson(b.get(n))).sort();
  return { added, removed, changed };
}

export function formatDiff(d) {
  const parts = [...d.added.map((n) => `+ ${n}`), ...d.removed.map((n) => `− ${n}`), ...d.changed.map((n) => `~ ${n}`)];
  return parts.join(", ") || "no visible change";
}

/** The poller's record in satellites.last_status_json, or null. */
export function lastRecord(sat) {
  try {
    const r = JSON.parse(sat?.last_status_json || "null");
    return r && typeof r === "object" ? r : null;
  } catch { return null; }
}

/** The satellite's last reported tools[bundle] ({version, sha256} | {version, error}) or null. */
export function reportedTools(sat, bundle) {
  const t = lastRecord(sat)?.status?.tools?.[bundle];
  return t && typeof t === "object" ? t : null;
}

/**
 * {state, ...}: "ok" (reported hash = pin) | "unpinned" | "changed" (hash ≠ pin) |
 * "unavailable" (no sha256 reported: {error}) | "unknown" (never polled) |
 * "unreachable" | "revoked".
 */
export function toolsState(sat, bundle, pin) {
  if (!sat) return { state: "unknown" };
  if (sat.status === "revoked") return { state: "revoked" };
  if (sat.status === "unreachable") return { state: "unreachable", since: sat.unreachable_since || null };
  if (!pin) return { state: "unpinned" };
  const t = reportedTools(sat, bundle);
  if (!t) return { state: "unknown" };
  if (typeof t.sha256 !== "string" || !t.sha256) return { state: "unavailable", error: typeof t.error === "string" ? t.error : "tools_unavailable" };
  return t.sha256 === pin.tools_sha256 ? { state: "ok" } : { state: "changed", reported: t.sha256, version: t.version ?? null };
}
