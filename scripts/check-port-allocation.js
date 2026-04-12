#!/usr/bin/env node
/**
 * Port allocation check (CI).
 *
 * Verifies:
 *   1. Every host port in any bundles/<id>/docker-compose.yml is unique across bundles.
 *   2. Every host port is documented in docs/developers/port-allocation.md.
 *
 * Exits non-zero with a clear diff on violation.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLES_DIR = join(REPO_ROOT, "bundles");
const PORT_DOC = join(REPO_ROOT, "docs/developers/port-allocation.md");
const KNOWN_CONFLICTS_PATH = join(REPO_ROOT, "scripts/known-port-conflicts.json");

function loadKnownConflicts() {
  if (!existsSync(KNOWN_CONFLICTS_PATH)) return new Map();
  try {
    const data = JSON.parse(readFileSync(KNOWN_CONFLICTS_PATH, "utf8"));
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

function extractHostPorts(content) {
  const ports = new Set();
  const re = /^\s*-\s+["']?(?:\[?[\w.:]+\]?:)?(\d{1,5}):\d{1,5}(?:\/(?:tcp|udp))?["']?\s*$/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const port = parseInt(m[1], 10);
    if (port >= 1 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

function listBundleComposeFiles() {
  if (!existsSync(BUNDLES_DIR)) return [];
  const out = [];
  for (const entry of readdirSync(BUNDLES_DIR)) {
    const composePath = join(BUNDLES_DIR, entry, "docker-compose.yml");
    if (existsSync(composePath) && statSync(composePath).isFile()) {
      out.push({ bundle: entry, path: composePath });
    }
  }
  return out;
}

function loadDocumentedPorts() {
  if (!existsSync(PORT_DOC)) return new Set();
  const content = readFileSync(PORT_DOC, "utf8");
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

function main() {
  const bundles = listBundleComposeFiles();
  const documented = loadDocumentedPorts();
  const portToBundles = new Map();
  for (const { bundle, path } of bundles) {
    const content = readFileSync(path, "utf8");
    for (const port of extractHostPorts(content)) {
      if (!portToBundles.has(port)) portToBundles.set(port, []);
      portToBundles.get(port).push(bundle);
    }
  }

  let errors = 0;
  const knownConflicts = loadKnownConflicts();
  const collisions = [];
  const grandfatheredCollisions = [];
  for (const [port, bundleList] of portToBundles) {
    if (bundleList.length <= 1) continue;
    const sorted = [...bundleList].sort();
    const allowed = knownConflicts.get(port);
    if (allowed && allowed.length === sorted.length && allowed.every((b, i) => b === sorted[i])) {
      grandfatheredCollisions.push({ port, bundles: sorted });
    } else {
      collisions.push({ port, bundles: sorted });
    }
  }
  if (grandfatheredCollisions.length > 0) {
    console.warn("WARN: Pre-existing port conflicts (allowlisted in scripts/known-port-conflicts.json):");
    for (const { port, bundles } of grandfatheredCollisions) {
      console.warn("  Port " + port + ": " + bundles.join(", "));
    }
  }
  if (collisions.length > 0) {
    console.error("\nERROR: Port collisions detected:");
    for (const { port, bundles } of collisions) {
      console.error("  Port " + port + ": " + bundles.join(", "));
    }
    errors += collisions.length;
  }

  const undocumented = [];
  for (const port of portToBundles.keys()) {
    if (!documented.has(port)) {
      undocumented.push({ port, bundles: portToBundles.get(port) });
    }
  }
  if (undocumented.length > 0) {
    console.error("\nERROR: Undocumented ports (add a row to docs/developers/port-allocation.md):");
    for (const { port, bundles } of undocumented) {
      console.error("  Port " + port + " (" + bundles.join(", ") + ")");
    }
    errors += undocumented.length;
  }

  if (errors === 0) {
    const total = portToBundles.size;
    console.log("OK: " + total + " unique port(s) across " + bundles.length + " bundle(s), all documented, no collisions.");
    process.exit(0);
  }
  console.error("\nFound " + errors + " port-allocation issue(s).");
  process.exit(1);
}

main();
