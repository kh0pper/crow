/**
 * The ids of the capabilities THIS instance actually has.
 *
 * N1b-8 review round 1 (B2): on the `/router` mount a peer names the tool
 * (`crow_<something>`) and the gate turns that into `crow-<something>`. That
 * string then keyed a Fix-it card, its dedupe key and a
 * `peer_exposure_card_suppressed` counter entry — so a peer could mint
 * unlimited distinct "capabilities" out of junk names (`crow_junk1`,
 * `crow_JUNK2`, a 10 KB name …). The id must therefore be canonicalised and
 * matched against the instance's OWN catalog before anything is raised or
 * counted.
 *
 * This module is a leaf (static tool manifests + the extension registry, no
 * settings, no db) so capability-registry.js, peer-exposure.js and the Fix-it
 * detector can all use it without an import cycle. It is the same set the
 * public catalog is built from (`coreTools()` + `addonTools()` in
 * capability-registry.js), so "in the catalog" and "a capability this instance
 * has" mean exactly one thing.
 */
import { TOOL_MANIFESTS } from "./tool-manifests.js";
import { listInstalledExtensions, resolveCrowHome } from "../../scripts/pi-bots/ext_registry.mjs";

/** Canonical server id for a core manifest category (crow-memory, etc.). */
export function canonicalForCategory(category) {
  return `crow-${category}`;
}

/**
 * A peer-chosen `/router` tool name → canonical capability id, or null.
 *
 * `crow_memory` → `crow-memory`; the case variant `crow_Memory` → the SAME
 * `crow-memory` (so it is one capability, not an unknown one — and it lands on
 * the same card and the same dedupe key). Anything whose tail is not a plain
 * identifier (`crow_../etc`, `crow_`, a 4 KB name, `crow_store_memory` →
 * `crow-store_memory` — the tail keeps its underscore) canonicalises to an id
 * that no catalog contains, and is therefore unknown.
 *
 * Note this is only a PROPOSAL: the caller must still require the returned id
 * to be in `getLocalCapabilityIds()`.
 */
const PEER_TOOL_RE = /^crow_([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
export function canonicalizePeerCapabilityTool(toolName) {
  if (typeof toolName !== "string") return null;
  const m = PEER_TOOL_RE.exec(toolName);
  if (!m) return null;
  return canonicalForCategory(m[1].toLowerCase());
}

// The live aggregation re-reads installed extensions (a few small JSON files +
// readdirs), which is fine per-DENIAL but not per-request: a deny costs one
// scan per TTL window per CROW_HOME. A newly installed addon shows up within
// this window, which is bounded because the window is short.
const CACHE_TTL_MS = 30_000;
const cache = new Map(); // crowHome -> { at, ids }

/**
 * Every canonical capability id on this instance: core manifests + installed
 * extensions. Never throws; returns a fresh Set the caller may keep.
 *
 * @param {string} [crowHome]
 * @returns {Set<string>}
 */
export function getLocalCapabilityIds(crowHome = resolveCrowHome()) {
  const now = Date.now();
  const hit = cache.get(crowHome);
  if (hit && now - hit.at < CACHE_TTL_MS) return new Set(hit.ids);
  const ids = new Set();
  for (const category of Object.keys(TOOL_MANIFESTS)) ids.add(canonicalForCategory(category));
  try {
    for (const ext of listInstalledExtensions(crowHome)) {
      if (ext && typeof ext.id === "string" && ext.id) ids.add(ext.id);
    }
  } catch { /* addon listing unavailable: core ids only */ }
  cache.set(crowHome, { at: now, ids });
  return new Set(ids);
}

/** Test seam: forget the cached scans. */
export function _clearCapabilityIdCache() {
  cache.clear();
}