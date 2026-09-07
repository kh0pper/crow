/**
 * bundle-server-deps — every first-party bundle whose MCP server runs under
 * `node` must declare the bare packages its server code imports in the
 * bundle's own package.json.
 *
 * WHY THIS TEST EXISTS (2026-09-07): the Extensions page installs a bundle by
 * COPYING it to ~/.crow/bundles/<id>/ and running `npm install` there only
 * when a package.json declares dependencies. The ramble bundle imported
 * `@modelcontextprotocol/sdk` and `zod` but shipped no package.json, so the
 * installed copy on grackle crashed at spawn with ERR_MODULE_NOT_FOUND
 * (`Cannot find package '@modelcontextprotocol/sdk'`) while the same code ran
 * fine from the app repo, whose node_modules happens to resolve. Four other
 * bundles had the identical gap. Node's resolver walks UP from the installed
 * dir, never into the app repo — a bundle server only works installed when it
 * names what it needs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = join(ROOT, "bundles");
const BUILTINS = new Set(builtinModules);

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    const st = statSync(p);
    if (st.isDirectory()) walkJs(p, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** Bare package names imported/required by a file (scoped packages keep their scope). */
function barePackages(src) {
  const specs = [];
  const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/g;
  const sideEffectRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importRe, sideEffectRe, requireRe]) {
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
  }
  const names = new Set();
  for (const spec of specs) {
    if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) continue;
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (BUILTINS.has(name)) continue;
    names.add(name);
  }
  return names;
}

function nodeServerBundles() {
  const out = [];
  for (const id of readdirSync(BUNDLES)) {
    const mf = join(BUNDLES, id, "manifest.json");
    if (!existsSync(mf)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(mf, "utf8")); } catch { continue; }
    if (manifest?.server?.command !== "node") continue;
    out.push({ id, dir: join(BUNDLES, id), manifest });
  }
  return out;
}

const bundles = nodeServerBundles();

test("scan finds the node-server bundles (sanity: ramble is one of them)", () => {
  assert.ok(bundles.length > 5, `expected several node-server bundles, got ${bundles.length}`);
  assert.ok(bundles.some((b) => b.id === "ramble"), "ramble must be a node-server bundle");
});

for (const { id, dir } of bundles) {
  test(`bundle ${id}: server code declares every bare package it imports`, () => {
    const imported = new Set();
    for (const file of walkJs(join(dir, "server"))) {
      for (const name of barePackages(readFileSync(file, "utf8"))) imported.add(name);
    }
    if (imported.size === 0) return; // pure-builtin server: nothing to declare
    const pkgPath = join(dir, "package.json");
    assert.ok(existsSync(pkgPath), `${id}/server imports ${[...imported].join(", ")} but ships no package.json`);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const declared = new Set(Object.keys(pkg.dependencies || {}));
    const missing = [...imported].filter((n) => !declared.has(n));
    assert.deepEqual(missing, [], `${id}/package.json must declare: ${missing.join(", ")}`);
  });
}
