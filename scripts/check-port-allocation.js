#!/usr/bin/env node
/**
 * Port allocation check (CI).
 *
 * Verifies:
 *   1. No two bundles publish the same host port on overlapping addresses
 *      (same host IP, or either side a wildcard), across every
 *      bundles/<id>/docker-compose*.yml (overlays included).
 *   2. Every host port is documented in docs/developers/port-allocation.md.
 *
 * Host ports written as ${VAR:-N} or ${VAR-N} count as N, the port a fresh
 * install publishes. A host port that is a variable with no default is not
 * checked (there is no number to check).
 *
 * Exits non-zero with a clear diff on violation.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLES_DIR = join(REPO_ROOT, "bundles");
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
// publishes, so the default is what has to be unique and documented.
const VAR_WITH_DEFAULT_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*):?-([^}]*)\}/g;
// ${NAME}, ${NAME:?err}, ${NAME?err}: no default, nothing to check.
const VAR_NO_DEFAULT_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:]?[?+][^}]*)?\}/g;

function resolveDefaults(value) {
  return value
    .replace(VAR_WITH_DEFAULT_RE, (_, _name, def) => def)
    .replace(VAR_NO_DEFAULT_RE, (_, name) => "$" + name);
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

/**
 * Parse one short-syntax publish ("[ip:]host:container[/proto]") into its
 * host side. Returns { ip, ports } or null when nothing is published on a
 * fixed host port (container-only entries, ephemeral "ip::80", or a host
 * port that is a variable with no default).
 */
export function parsePortSpec(spec) {
  let s = resolveDefaults(String(spec).trim()).replace(/\/(?:tcp|udp|sctp)$/i, "");
  let ip = "";
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) return null;
    ip = s.slice(1, close);
    s = s.slice(close + 1).replace(/^:/, "");
    const parts = s.split(":");
    if (parts.length !== 2) return null;
    const ports = expandRange(parts[0]);
    return ports ? { ip, ports } : null;
  }
  const parts = s.split(":");
  if (parts.length < 2) return null;
  const host = parts[parts.length - 2];
  ip = parts.slice(0, -2).join(":");
  const ports = expandRange(host);
  return ports ? { ip, ports } : null;
}

function longSyntaxToSpec(obj) {
  if (obj.published === undefined || obj.published === "") return null;
  const published = resolveDefaults(stripScalar(String(obj.published)));
  const ports = expandRange(published);
  if (!ports) return null;
  const ip = obj.host_ip !== undefined ? resolveDefaults(stripScalar(String(obj.host_ip))) : "";
  return { ip, ports };
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

/**
 * Every fixed host-side publish in a compose file, as { ip, port } pairs.
 * Reads the `ports:` sections only (short syntax, long syntax with
 * `published:`/`host_ip:`, and flow sequences), so volume and environment
 * lines that happen to look like "a:b" never count.
 */
export function extractHostMappings(content) {
  const lines = content.split(/\r?\n/);
  const specs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const head = /^(\s*)ports:\s*(.*)$/.exec(line);
    if (!head) continue;
    const keyIndent = head[1].length;
    const rest = head[2].replace(/\s+#.*$/, "").trim();
    if (rest.startsWith("[")) {
      for (const item of splitFlow(rest.replace(/^\[|\]$/g, ""))) {
        if (item.startsWith("{")) specs.push(longSyntaxToSpec(parseFlowMapping(item)));
        else specs.push(parsePortSpec(stripScalar(item)));
      }
      continue;
    }
    if (rest !== "") continue;
    let current = null;
    let itemIndent = -1;
    const flush = () => {
      if (current) specs.push(longSyntaxToSpec(current));
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
        if (body.startsWith("{")) specs.push(longSyntaxToSpec(parseFlowMapping(body)));
        else if (kv && !/^["']/.test(body)) current = { [kv[1]]: kv[2] };
        else specs.push(parsePortSpec(stripScalar(body)));
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
  const out = [];
  const seen = new Set();
  for (const spec of specs) {
    if (!spec) continue;
    for (const port of spec.ports) {
      const key = spec.ip + "|" + port;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ip: spec.ip, port });
    }
  }
  return out;
}

export function extractHostPorts(content) {
  return [...new Set(extractHostMappings(content).map((m) => m.port))];
}

const WILDCARD_IPS = new Set(["", "0.0.0.0", "::", "*"]);

/** Two publishes of one port clash when they share an address or either is a wildcard. */
export function bindsOverlap(a, b) {
  return a === b || WILDCARD_IPS.has(a) || WILDCARD_IPS.has(b);
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
export function checkPortAllocation({
  bundlesDir = BUNDLES_DIR,
  docPath = PORT_DOC,
  knownConflictsPath = KNOWN_CONFLICTS_PATH,
} = {}) {
  const files = listBundleComposeFiles(bundlesDir);
  const documented = loadDocumentedPorts(docPath);
  // port -> [{ bundle, ip }]
  const portToBinds = new Map();
  for (const { bundle, path } of files) {
    for (const { ip, port } of extractHostMappings(readFileSync(path, "utf8"))) {
      if (!portToBinds.has(port)) portToBinds.set(port, []);
      const binds = portToBinds.get(port);
      if (!binds.some((b) => b.bundle === bundle && b.ip === ip)) binds.push({ bundle, ip });
    }
  }

  const knownConflicts = loadKnownConflicts(knownConflictsPath);
  const collisions = [];
  const grandfathered = [];
  for (const [port, binds] of [...portToBinds].sort((a, b) => a[0] - b[0])) {
    const clashing = new Set();
    for (let i = 0; i < binds.length; i++) {
      for (let j = i + 1; j < binds.length; j++) {
        if (binds[i].bundle === binds[j].bundle) continue;
        if (bindsOverlap(binds[i].ip, binds[j].ip)) {
          clashing.add(binds[i].bundle);
          clashing.add(binds[j].bundle);
        }
      }
    }
    if (clashing.size === 0) continue;
    const sorted = [...clashing].sort();
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
  const bundleCount = new Set(files.map((f) => f.bundle)).size;
  return { collisions, grandfathered, undocumented, portCount: portToBinds.size, bundleCount };
}

function main() {
  const { collisions, grandfathered, undocumented, portCount, bundleCount } = checkPortAllocation();
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
    console.log("OK: " + portCount + " unique port(s) across " + bundleCount + " bundle(s), all documented, no collisions.");
    process.exit(0);
  }
  console.error("\nFound " + errors + " port-allocation issue(s).");
  process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
