import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, detectSurfaces } from "../scripts/lib/bundle-contract.mjs";

/** Make a throwaway bundle dir <root>/<id> with optional files {relpath: content}. */
function tmpBundle(id, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "crowbundle-"));
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return { root, dir };
}

// Minimal valid manifest: only the 5 universal-required fields (no version/author).
const VALID = { id: "demo", name: "Demo", description: "d", type: "bundle", category: "misc" };

test("minimal manifest (no version/author) passes", () => {
  const { dir } = tmpBundle("demo");
  const r = validateManifest(VALID, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("missing each universal field fails", () => {
  const { dir } = tmpBundle("demo");
  for (const f of ["id", "name", "description", "type", "category"]) {
    const m = { ...VALID }; delete m[f];
    assert.equal(validateManifest(m, dir).ok, false, `expected fail without ${f}`);
  }
});

test("version/author are optional but shape-checked when present", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, version: "1.2.3", author: "Crow" }, dir).ok, true);
  assert.equal(validateManifest({ ...VALID, version: "v1" }, dir).ok, false, "bad semver must fail");
  assert.equal(validateManifest({ ...VALID, author: "" }, dir).ok, false, "empty author must fail");
});

test("bad type enum fails", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, type: "weird" }, dir).ok, false);
});

test("unknown top-level field is allowed (lenient)", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, sttProfileSeed: { x: 1 } }, dir).ok, true);
});

test("id must equal dirname", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, id: "other" }, dir).ok, false);
});

test("declared skill file must exist", () => {
  const withFile = tmpBundle("demo", { "skills/x.md": "# x" });
  assert.equal(validateManifest({ ...VALID, skills: ["skills/x.md"] }, withFile.dir).ok, true);
  const without = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, skills: ["skills/missing.md"] }, without.dir).ok, false);
});

test("docker composefile must exist", () => {
  const b = tmpBundle("demo", { "docker-compose.yml": "x" });
  assert.equal(validateManifest({ ...VALID, docker: { composefile: "docker-compose.yml" } }, b.dir).ok, true);
  const b2 = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, docker: { composefile: "docker-compose.yml" } }, b2.dir).ok, false);
});

test("node server entry-file must exist", () => {
  const b = tmpBundle("demo", { "server/index.js": "//" });
  assert.equal(validateManifest({ ...VALID, server: { command: "node", args: ["server/index.js"] } }, b.dir).ok, true);
  const b2 = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, server: { command: "node", args: ["server/index.js"] } }, b2.dir).ok, false);
});

test("external-command server is NOT file-checked (npx -y pkg)", () => {
  const { dir } = tmpBundle("demo"); // no local entry file on purpose
  const m = { ...VALID, type: "mcp-server", server: { command: "npx", args: ["-y", "hass-mcp"] } };
  assert.equal(validateManifest(m, dir).ok, true, "external command must not require a local file");
});

test("server: null is tolerated", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, server: null }, dir).ok, true);
});

test("panel string is file-checked; panel object is shape-only", () => {
  const withFile = tmpBundle("demo", { "panel/demo.js": "//" });
  assert.equal(validateManifest({ ...VALID, panel: "panel/demo.js" }, withFile.dir).ok, true);
  const missing = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, panel: "panel/demo.js" }, missing.dir).ok, false);
  // object form: no file check (resolved at runtime by resolvePanelPath)
  assert.equal(validateManifest({ ...VALID, panel: { id: "demo", extends: "homepage" } }, missing.dir).ok, true);
});

test("requires.bundles existence checked via resolver", () => {
  const { dir } = tmpBundle("demo");
  const m = { ...VALID, requires: { bundles: ["companion"] } };
  assert.equal(validateManifest(m, dir, { bundleExists: (id) => id === "companion" }).ok, true);
  assert.equal(validateManifest(m, dir, { bundleExists: () => false }).ok, false);
});

test("env_vars items must have a name", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, env_vars: [{ name: "X" }] }, dir).ok, true);
  assert.equal(validateManifest({ ...VALID, env_vars: [{ description: "no name" }] }, dir).ok, false);
});

test("detectSurfaces reports declared surfaces", () => {
  const s = detectSurfaces({ ...VALID, server: { command: "node", args: ["x"] }, skills: ["a.md"] });
  assert.deepEqual(s.sort(), ["server", "skills"]);
});

test("malformed manifest (null) returns ok:false, does not throw", () => {
  const { dir } = tmpBundle("demo");
  const r = validateManifest(null, dir);
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});

test("surface field of wrong type (docker as string) fails on shape, not a confusing integrity error", () => {
  const { dir } = tmpBundle("demo");
  const r = validateManifest({ ...VALID, docker: "x" }, dir);
  assert.equal(r.ok, false);
  // after the shape short-circuit, the error is a shape error, not 'docker.composefile "undefined" not found'
  assert.ok(r.errors.some((e) => e.startsWith("shape")), "expected a shape error, got: " + r.errors.join("; "));
  assert.ok(!r.errors.some((e) => e.includes("undefined")), "should not emit a spurious integrity error: " + r.errors.join("; "));
});
