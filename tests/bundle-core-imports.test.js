/**
 * SAT-2: servers/gateway/bundle-core.js is what the satellite agent imports to install
 * bundles on a small server, so its import graph must stay free of the instance DB
 * (db.js and its drivers), the dashboard, providers, push/ntfy and model orchestration.
 *
 * A static scan: every relative `import … from`, `export … from`, side-effect `import "…"`
 * and literal `import("…")` is followed, transitively, from bundle-core.js. Dynamic
 * imports count too — they would load the moment the code path runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(["'])([^"'\n]+)\1/gm;

function specifiers(src) {
  const out = [];
  let m;
  while ((m = SPEC_RE.exec(src)) !== null) out.push(m[2]);
  return out;
}

/** Every module reached from `entry`: repo-relative paths, plus bare package names. */
function importGraph(entry) {
  const files = new Set();
  const packages = new Set();
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const file = stack.pop();
    const rel = relative(ROOT, file);
    if (files.has(rel)) continue;
    files.add(rel);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const target = resolve(dirname(file), spec);
        assert.ok(existsSync(target), `${rel} imports ${spec}, which does not resolve`);
        stack.push(target);
      } else {
        packages.add(spec);
      }
    }
  }
  return { files, packages };
}

const BANNED_FILES = [
  [/^servers\/gateway\/dashboard\//, "dashboard"],
  [/^servers\/db\.js$/, "db.js (crow.db)"],
  [/providers[^/]*\.js$/, "providers"],
  [/(^|\/)push\//, "push / ntfy"],
  [/model-orchestration/, "model orchestration"],
  [/^servers\/gateway\/routes\//, "the route layer (routes/bundles.js)"],
];
const BANNED_PACKAGES = [/^@libsql\//, /^better-sqlite3$/, /^libsql$/];

function violations(entry) {
  const { files, packages } = importGraph(entry);
  const out = [];
  for (const f of files) for (const [re, why] of BANNED_FILES) if (re.test(f)) out.push(`${f} (${why})`);
  for (const p of packages) for (const re of BANNED_PACKAGES) if (re.test(p)) out.push(`package ${p}`);
  return { files, packages, out };
}

test("bundle-core.js imports nothing from dashboard/, db.js, providers, push/ or model orchestration (transitively)", () => {
  const { files, packages, out } = violations("servers/gateway/bundle-core.js");
  assert.ok(files.size > 1, "the scan followed bundle-core.js's imports");
  assert.deepEqual(out, [], `bundle-core.js reaches: ${out.join(", ")}`);
  assert.deepEqual([...packages], [], "bundle-core.js needs no npm package");
});

test("positive control: the same scan flags routes/bundles.js", () => {
  const { out } = violations("servers/gateway/routes/bundles.js");
  for (const why of ["db.js (crow.db)", "dashboard", "providers", "push / ntfy", "model orchestration"]) {
    assert.ok(out.some((v) => v.includes(`(${why})`)), `the scan must catch ${why} in routes/bundles.js`);
  }
});

test("the scanner reads every import form", () => {
  assert.deepEqual(
    specifiers('import a from "./a.js";\nexport { b } from \'./b.js\';\nimport "./c.js";\nconst d = await import("./d.js");\nimport {\n  e,\n} from "./e.js";'),
    ["./a.js", "./b.js", "./c.js", "./d.js", "./e.js"],
  );
});
