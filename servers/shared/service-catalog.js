/**
 * Service catalog — the registry's bundles that carry a `connect` block.
 * Read-only: never starts a child and never reads a secret.
 */
import { readFileSync } from "node:fs";

const REGISTRY_URL = new URL("../../registry/add-ons.json", import.meta.url);
const SLUG_MAX = 16;
const LABEL_MAX = 60;

let _defaultRegistry = null;

function defaultRegistry() {
  if (!_defaultRegistry) _defaultRegistry = JSON.parse(readFileSync(REGISTRY_URL, "utf8"));
  return _defaultRegistry;
}

export function _resetServiceCatalogForTest() {
  _defaultRegistry = null;
}

export function isServiceManifest(manifest) {
  const c = manifest && manifest.connect;
  return !!c && typeof c === "object" && !Array.isArray(c);
}

function toEntry(m) {
  const c = m.connect;
  const server = m.server || {};
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    icon: m.icon,
    bundleId: m.id,
    version: m.version,
    server: {
      command: server.command,
      args: Array.isArray(server.args) ? [...server.args] : [],
      envKeys: Array.isArray(server.envKeys) ? [...server.envKeys] : [],
    },
    requiresBins: [...(m.requires?.bins || [])],
    method: c.method,
    group: c.group,
    fields: c.fields || [],
    steps: c.steps || [],
    stepLinks: c.step_links || {},
    derivedEnv: c.derived_env || {},
    discover: c.discover || null,
    test: c.test || null,
    oauth: c.oauth || null,
    labelFrom: c.label_from || null,
    legacyEnableEnv: c.legacy_enable_env || null,
    crowWide: c.method === "toggle",
  };
}

/** Service entries sorted by name. A custom `registry` is read fresh each call. */
export function serviceCatalog({ registry } = {}) {
  const reg = registry || defaultRegistry();
  const list = Array.isArray(reg) ? reg : reg["add-ons"] || [];
  return list
    .filter(isServiceManifest)
    .map(toEntry)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function serviceById(id, opts) {
  return serviceCatalog(opts).find((s) => s.id === id) || null;
}

/** Label -> block-name slug: ascii lowercase, dashes, capped at 16 (I10). */
export function labelSlug(label) {
  const s = String(label ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");
  return s || "account";
}

export function blockNameFor(serviceId, label) {
  return `${serviceId}-${labelSlug(label)}`;
}

export function cleanLabel(label) {
  const s = String(label ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, LABEL_MAX).trim();
  return s || null;
}

/** Substitute ${NAME} in each derived_env template (M6). */
export function renderDerivedEnv(service, values = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(service.derivedEnv || {})) {
    out[key] = spec.template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => {
      const v = String(values[name] ?? "");
      return spec.encoding === "json"
        ? JSON.stringify(v).slice(1, -1)
        : v.replace(/[\r\n\0]/g, "");
    });
  }
  return out;
}
