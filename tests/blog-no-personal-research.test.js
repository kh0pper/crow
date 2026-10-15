/**
 * The public blog must not carry one owner's research project: no private
 * table names, no fixed project id, no private bucket names, no paths into a
 * personal checkout. Owner-specific content lives in the instance's
 * collections config, which only the read-only loader may touch.
 *
 * Scope is servers/ + bundles/ (scripts/ legitimately names unowned table
 * prefixes in an import tool). The rules are deliberately narrow so a lesson
 * tag elsewhere in bundles/ does not trip them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const LOADER = "servers/gateway/blog/collections-config.js";

function trackedJs(...dirs) {
  return execFileSync("git", ["ls-files", ...dirs], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(m?js|json)$/.test(f));
}

function read(rel) {
  try { return readFileSync(join(ROOT, rel), "utf8"); } catch { return ""; }
}

test("H1: servers/ and bundles/ carry no private research identifiers", () => {
  const rules = [/capstone_/, /"capstone-/, /project_id\s*=\s*6\b/, /\/blog\/research-docs\//, /research-bundles/];
  const hits = [];
  for (const f of trackedJs("servers", "bundles")) {
    const src = read(f);
    for (const re of rules) if (re.test(src)) hits.push(`${f}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test("H1b: nothing under servers/ names the old research project", () => {
  const hits = trackedJs("servers").filter((f) => /capstone/i.test(read(f)));
  assert.deepEqual(hits, []);
});

test("H2: only the read-only loader touches the blog collections config", () => {
  const pathRefs = /blog\/collections\.json|["']blog["']\s*,\s*["']collections\.json["']|CROW_BLOG_COLLECTIONS_CONFIG/;
  const others = trackedJs("servers", "bundles").filter((f) => f !== LOADER && pathRefs.test(read(f)));
  assert.deepEqual(others, [], "no other module may name the config file");

  const loader = read(LOADER);
  assert.ok(loader.length > 0);
  for (const w of ["writeFile", "appendFile", "rename", "createWriteStream", "fs.promises.write", "unlink", "copyFile"]) {
    assert.ok(!loader.includes(w), `loader must not call ${w}`);
  }

  // Importers use the loader only to read.
  const importers = trackedJs("servers", "bundles").filter((f) => f !== LOADER && read(f).includes("collections-config.js"));
  for (const f of importers) {
    const imported = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*collections-config\.js["']/.exec(read(f));
    assert.ok(imported, `${f} imports collections-config.js by name`);
    const names = imported[1].split(",").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(names.filter((n) => n !== "loadCollectionsConfig"), [], `${f} imports only loadCollectionsConfig`);
  }
});
