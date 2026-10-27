#!/usr/bin/env node
/**
 * Port allocation check (CI).
 *
 * Verifies:
 *   1. No two owners publish the same host port on overlapping addresses
 *      (same host IP, or either side a wildcard), across every
 *      bundles/<id>/docker-compose*.yml (overlays included) and the
 *      repo-root docker-compose.yml. An owner is a (bundle, service) pair, so
 *      two services of one bundle are checked against each other too.
 *   2. Every host port is documented in docs/developers/port-allocation.md.
 *
 * Host ports written as ${VAR:-N} or ${VAR-N} count as N, the port a fresh
 * install publishes. A ports entry it cannot read (a host port variable with
 * no default, a non-numeric value) is printed as a WARNING, never skipped
 * silently.
 *
 * Exits non-zero with a clear diff on violation.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLES_DIR = join(REPO_ROOT, "bundles");
const ROOT_COMPOSE = join(REPO_ROOT, "docker-compose.yml");
const PORT_DOC = join(REPO_ROOT, "docs/developers/port-allocation.md");
const KNOWN_CONFLICTS_PATH = join(REPO_ROOT, "scripts/known-port-conflicts.json");

function loadKnownConflicts(path = KNOWN_CONFLICTS_PATH) {
  if (!existsSync(path)) return new Map();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const m = new Map();
    for (const [port, bundles] of Object.entries(data)) {
      if (port.startsWith("_")) continue;
      if (Array.isArray(bundles)) m.set(parseInt(port, 10), [...bundles].sort());
    }
    return m;
  } catch {
    return new Map();
  }
}

// ${NAME:-default} / ${NAME-default}: Compose uses the default when NAME is
// unset (":-" also when it is empty). A default is what a fresh install
// publishes, so the default is what has to be unique and documented. The
// pattern matches innermost-first (no "$", "{" or "}" in the default), and
// resolveDefaults loops, so nested ${A:-${B:-N}} resolves to N.
const VAR_WITH_DEFAULT_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*):?-([^${}]*)\}/g;
// ${NAME:?err}: Compose refuses to start when NAME is unset or empty, so the
// value is always one specific address. Kept as "$NAME".
const VAR_REQUIRED_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^${}]*\}/g;
// ${NAME}, ${NAME?err}, ${NAME:+x}, ${NAME+x}: may be empty. Kept as
// "${NAME}"; as a host IP it is a wildcard (empty publishes on every address).
const VAR_OTHER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:]?[?+][^${}]*)?\}/g;

function resolveDefaults(value) {
  let prev;
  let out = value;
  do {
    prev = out;
    out = out.replace(VAR_WITH_DEFAULT_RE, (_, _name, def) => def);
  } while (out !== prev);
  return out
    .replace(VAR_REQUIRED_RE, (_, name) => "$" + name)
    .replace(VAR_OTHER_RE, (_, name) => "\u0000" + name + "\u0001")
    .replace(/\u0000([A-Za-z0-9_]+)\u0001/g, (_, name) => "${" + name + "}");
}

function stripScalar(raw) {
  let v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const close = v.indexOf(q, 1);
    return close > 0 ? v.slice(1, close) : v.slice(1);
  }
  return v.replace(/\s+#.*$/, "").trim();
}

function expandRange(spec) {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(spec);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  if (start < 1 || end > 65535 || start > end) return null;
  const out = [];
  for (let p = start; p <= end; p++) out.push(p);
  return out;
}

function hostPorts(host, spec) {
  if (/\$/.test(host)) return { invalid: `"${spec}": host port ${host} has no default, so it cannot be checked` };
  const ports = expandRange(host);
  return ports ? { ports } : { invalid: `"${spec}": host port "${host}" is not a port number or range` };
}

/**
 * Parse one short-syntax publish ("[ip:]host:container[/proto]").
 * Returns { ip, ports }; null when nothing is published on a fixed host port
 * on purpose (container-only "80", ephemeral "ip::80"); or { invalid } with a
 * reason when the entry cannot be read (the CLI prints it as a warning).
 */
export function parsePortSpec(spec) {
  const raw = String(spec).trim();
  const s = resolveDefaults(raw).replace(/\/(?:tcp|udp|sctp)$/i, "");
  let ip;
  let rest;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0 || s[close + 1] !== ":") return { invalid: `"${raw}": unreadable IPv6 host address` };
    ip = s.slice(1, close);
    rest = s.slice(close + 2).split(":");
    if (rest.length !== 2) return { invalid: `"${raw}": expected [ip]:host:container` };
  } else {
    const parts = s.split(":");
    if (parts.length < 2) return /^\d{1,5}(?:-\d{1,5})?$/.test(s) ? null : { invalid: `"${raw}": not a port mapping` };
    ip = parts.slice(0, -2).join(":");
    rest = parts.slice(-2);
  }
  if (rest[0] === "") return null; // ephemeral host port
  const r = hostPorts(rest[0], raw);
  return r.invalid ? r : { ip, ports: r.ports };
}

function longSyntaxToSpec(obj) {
  if (obj.published === undefined || stripScalar(String(obj.published)) === "") return null;
  const raw = stripScalar(String(obj.published));
  const r = hostPorts(resolveDefaults(raw), "published: " + raw);
  if (r.invalid) return r;
  const ip = obj.host_ip !== undefined ? resolveDefaults(stripScalar(String(obj.host_ip))) : "";
  return { ip, ports: r.ports };
}

function splitFlow(inner) {
  const items = [];
  let cur = "";
  let quote = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "{" || ch === "[") {
      depth++;
      cur += ch;
    } else if (ch === "}" || ch === "]") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      items.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function parseFlowMapping(text) {
  const obj = {};
  for (const pair of splitFlow(text.replace(/^\{|\}$/g, ""))) {
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(pair);
    if (m) obj[m[1]] = m[2];
  }
  return obj;
}

const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === "" || line.trim().startsWith("#");

/** The service each line belongs to (top-level `services:` children), or null. */
function serviceByLine(lines) {
  const out = new Array(lines.length).fill(null);
  let inServices = false;
  let childIndent = -1;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isSkippable(line)) {
      const ind = indentOf(line);
      if (ind === 0) {
        inServices = /^services:\s*(?:#.*)?$/.test(line);
        childIndent = -1;
        current = null;
      } else if (inServices) {
        if (childIndent < 0) childIndent = ind;
        const key = /^\s*["']?([\w.-]+)["']?:\s*(?:#.*)?$/.exec(line);
        if (ind === childIndent && key) current = key[1];
      }
    }
    out[i] = current;
  }
  return out;
}

/**
 * Every fixed host-side publish in a compose file, as { service, ip, port },
 * plus a warning for each ports entry that cannot be read. Reads the
 * `ports:` sections only (short syntax, long syntax with `published:` /
 * `host_ip:`, and flow sequences), so volume and environment lines that
 * happen to look like "a:b" never count.
 */
export function scanCompose(content) {
  const lines = content.split(/\r?\n/);
  const services = serviceByLine(lines);
  const specs = []; // { service, spec }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const head = /^(\s*)ports:\s*(.*)$/.exec(line);
    if (!head) continue;
    const service = services[i];
    const push = (spec) => specs.push({ service, spec });
    const keyIndent = head[1].length;
    const rest = head[2].replace(/\s+#.*$/, "").trim();
    if (rest.startsWith("[")) {
      for (const item of splitFlow(rest.replace(/^\[|\]$/g, ""))) {
        if (item.startsWith("{")) push(longSyntaxToSpec(parseFlowMapping(item)));
        else push(parsePortSpec(stripScalar(item)));
      }
      continue;
    }
    if (rest !== "") continue;
    let current = null;
    let itemIndent = -1;
    const flush = () => {
      if (current) push(longSyntaxToSpec(current));
      current = null;
    };
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (isSkippable(l)) continue;
      const ind = indentOf(l);
      const trimmed = l.trimStart();
      const isItem = trimmed.startsWith("- ") || trimmed === "-";
      if (ind < keyIndent || (ind === keyIndent && !isItem)) break;
      if (isItem && (itemIndent < 0 || ind === itemIndent)) {
        itemIndent = ind;
        flush();
        const body = trimmed.slice(1).trim();
        const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(body);
        if (body.startsWith("{")) push(longSyntaxToSpec(parseFlowMapping(body)));
        else if (kv && !/^["']/.test(body)) current = { [kv[1]]: kv[2] };
        else push(parsePortSpec(stripScalar(body)));
      } else if (current && ind > itemIndent) {
        const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(trimmed);
        if (kv) current[kv[1]] = kv[2];
      } else if (ind <= itemIndent) {
        break;
      }
    }
    flush();
    i = j - 1;
  }
  const mappings = [];
  const warnings = [];
  const seen = new Set();
  for (const { service, spec } of specs) {
    if (!spec) continue;
    if (spec.invalid) {
      warnings.push((service ? service + ": " : "") + spec.invalid);
      continue;
    }
    for (const port of spec.ports) {
      const key = service + "|" + spec.ip + "|" + port;
      if (seen.has(key)) continue;
      seen.add(key);
      mappings.push({ service, ip: spec.ip, port });
    }
  }
  return { mappings, warnings };
}

/** Distinct { ip, port } publishes in a compose file (services merged). */
export function extractHostMappings(content) {
  const out = [];
  const seen = new Set();
  for (const { ip, port } of scanCompose(content).mappings) {
    if (seen.has(ip + "|" + port)) continue;
    seen.add(ip + "|" + port);
    out.push({ ip, port });
  }
  return out;
}

export function extractHostPorts(content) {
  return [...new Set(extractHostMappings(content).map((m) => m.port))];
}

const WILDCARD_IPS = new Set(["", "0.0.0.0", "::", "*"]);

/**
 * Two publishes of one port clash when they share an address or either is a
 * wildcard. A host-IP variable that may be unset (`${NAME}`) is a wildcard:
 * Compose then publishes on every address. A required one (`${NAME:?err}`,
 * kept as "$NAME") is one specific address.
 */
export function bindsOverlap(a, b) {
  const wild = (ip) => WILDCARD_IPS.has(ip) || ip.startsWith("${");
  return a === b || wild(a) || wild(b);
}

function listBundleComposeFiles(bundlesDir) {
  if (!existsSync(bundlesDir)) return [];
  const out = [];
  for (const entry of readdirSync(bundlesDir).sort()) {
    const dir = join(bundlesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      // docker-compose.yml plus overlays such as docker-compose.tailnet.yml.
      if (!/^docker-compose(?:\.[\w-]+)?\.ya?ml$/.test(file)) continue;
      const composePath = join(dir, file);
      if (statSync(composePath).isFile()) out.push({ bundle: entry, path: composePath });
    }
  }
  return out;
}

export function loadDocumentedPorts(docPath = PORT_DOC) {
  if (!existsSync(docPath)) return new Set();
  const content = readFileSync(docPath, "utf8");
  const ports = new Set();
  const rowRe = /^\|\s*([\d, /-]+)\s*\|/gm;
  let m;
  while ((m = rowRe.exec(content)) !== null) {
    const cell = m[1];
    const numRe = /(\d{1,5})(?:\s*-\s*(\d{1,5}))?/g;
    let n;
    while ((n = numRe.exec(cell)) !== null) {
      const start = parseInt(n[1], 10);
      const end = n[2] ? parseInt(n[2], 10) : start;
      if (start >= 1 && end <= 65535 && start <= end) {
        for (let p = start; p <= end; p++) ports.add(p);
      }
    }
  }
  return ports;
}

/**
 * Run the check over a bundles tree and a port doc. Returns the findings;
 * the CLI below prints them and sets the exit code.
 */
const ROOT_LABEL = "(root compose)";

/**
 * Run the check over a bundles tree, the repo-root compose and a port doc.
 * Returns the findings; the CLI below prints them and sets the exit code.
 *
 * Owners are (bundle, service). Publishes of one service merge across a
 * bundle's compose files (overlays restate the base's ports), while two
 * services of one bundle are checked against each other like two bundles.
 * A repo-root service named like a bundle (the optional `minio` service) is
 * that bundle's alternative deployment (the two never run together), so it
 * counts as that bundle and is not checked against that bundle's own services.
 */
export function checkPortAllocation({
  bundlesDir = BUNDLES_DIR,
  docPath = PORT_DOC,
  knownConflictsPath = KNOWN_CONFLICTS_PATH,
  rootComposePath = ROOT_COMPOSE,
} = {}) {
  const files = listBundleComposeFiles(bundlesDir);
  const bundleIds = new Set(files.map((f) => f.bundle));
  const sources = files.map((f) => ({ ...f, root: false }));
  if (rootComposePath && existsSync(rootComposePath)) sources.push({ bundle: ROOT_LABEL, path: rootComposePath, root: true });
  const documented = loadDocumentedPorts(docPath);
  const warnings = [];
  // port -> [{ bundle, service, ip }]
  const portToBinds = new Map();
  for (const { bundle, path, root } of sources) {
    const { mappings, warnings: w } = scanCompose(readFileSync(path, "utf8"));
    for (const msg of w) warnings.push(relative(REPO_ROOT, path) + ": " + msg);
    for (const { service, ip, port } of mappings) {
      const alt = root && bundleIds.has(service); // an alternative deployment of that bundle
      const owner = alt ? service : bundle;
      if (!portToBinds.has(port)) portToBinds.set(port, []);
      const binds = portToBinds.get(port);
      if (!binds.some((b) => b.bundle === owner && b.service === service && b.ip === ip && b.alt === alt)) binds.push({ bundle: owner, service, ip, alt });
    }
  }

  const knownConflicts = loadKnownConflicts(knownConflictsPath);
  const collisions = [];
  const grandfathered = [];
  for (const [port, binds] of [...portToBinds].sort((a, b) => a[0] - b[0])) {
    const clashing = [];
    const add = (b) => { if (!clashing.includes(b)) clashing.push(b); };
    for (let i = 0; i < binds.length; i++) {
      for (let j = i + 1; j < binds.length; j++) {
        const a = binds[i];
        const b = binds[j];
        if (a.bundle === b.bundle && (a.service === b.service || a.alt !== b.alt)) continue;
        if (bindsOverlap(a.ip, b.ip)) { add(a); add(b); }
      }
    }
    if (clashing.length === 0) continue;
    const label = (b) => (clashing.some((o) => o.bundle === b.bundle && o.service !== b.service) ? b.bundle + "/" + b.service : b.bundle);
    const sorted = [...new Set(clashing.map(label))].sort();
    const allowed = knownConflicts.get(port);
    if (allowed && allowed.length === sorted.length && allowed.every((b, i) => b === sorted[i])) {
      grandfathered.push({ port, bundles: sorted });
    } else {
      collisions.push({ port, bundles: sorted });
    }
  }

  const undocumented = [];
  for (const [port, binds] of [...portToBinds].sort((a, b) => a[0] - b[0])) {
    if (!documented.has(port)) {
      undocumented.push({ port, bundles: [...new Set(binds.map((b) => b.bundle))].sort() });
    }
  }
  return { collisions, grandfathered, undocumented, warnings, portCount: portToBinds.size, bundleCount: bundleIds.size };
}

function main() {
  const { collisions, grandfathered, undocumented, warnings, portCount, bundleCount } = checkPortAllocation();
  if (warnings.length > 0) {
    console.warn("WARNING: ports entries the checker cannot read (not checked):");
    for (const w of warnings) console.warn("  " + w);
  }
  if (grandfathered.length > 0) {
    console.warn("WARN: Pre-existing port conflicts (allowlisted in scripts/known-port-conflicts.json):");
    for (const { port, bundles } of grandfathered) {
      console.warn("  Port " + port + ": " + bundles.join(", "));
    }
  }
  if (collisions.length > 0) {
    console.error("\nERROR: Port collisions detected:");
    for (const { port, bundles } of collisions) {
      console.error("  Port " + port + ": " + bundles.join(", "));
    }
  }
  if (undocumented.length > 0) {
    console.error("\nERROR: Undocumented ports (add a row to docs/developers/port-allocation.md):");
    for (const { port, bundles } of undocumented) {
      console.error("  Port " + port + " (" + bundles.join(", ") + ")");
    }
  }
  const errors = collisions.length + undocumented.length;
  if (errors === 0) {
    console.log("OK: " + portCount + " unique port(s) across " + bundleCount + " bundle(s) and the root compose, all documented, no collisions.");
    process.exit(0);
  }
  console.error("\nFound " + errors + " port-allocation issue(s).");
  process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
