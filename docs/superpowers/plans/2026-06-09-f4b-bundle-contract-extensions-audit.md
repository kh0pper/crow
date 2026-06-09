# F4b — Bundle Contract + Extensions Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize a surface-based bundle contract, validate every bundle manifest against it, and regenerate `registry/add-ons.json` from per-bundle manifests as a committed, drift-checked artifact.

**Architecture:** A JSON Schema (`registry/manifest.schema.json`) defines manifest shape; a dependency-light validator (`scripts/lib/bundle-contract.mjs`) layers filesystem referential-integrity checks on top via `ajv`; a generator (`scripts/build-registry.mjs`) scans `bundles/*/manifest.json`, validates, excludes drafts + untracked dirs, injects `official: true`, sorts by id, and writes the registry; a `node:test` suite gates shape, integrity, and registry no-drift.

**Tech Stack:** Node ESM (`type: module`), `ajv` (new devDependency, approved), `node:test`, `node:fs`, `git ls-files`.

**Spec:** `docs/superpowers/specs/2026-06-09-f4b-bundle-contract-extensions-audit-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `registry/manifest.schema.json` (create) | JSON Schema (draft-07) — manifest shape, the human-readable contract of record |
| `scripts/lib/bundle-contract.mjs` (create) | `validateManifest(manifest, dir, opts)` (shape via ajv + filesystem integrity) + `detectSurfaces()` — single source of validation logic |
| `scripts/build-registry.mjs` (create) | Scan + validate + (write \| `--check`) the registry; audit table; `git ls-files` tracked detection |
| `tests/bundle-contract.test.js` (create) | Unit tests (shape, integrity, generator) + integration tests (all real manifests valid, no registry drift) |
| `registry/add-ons.json` (regenerate) | Generated, committed install catalog |
| `package.json` (modify) | Add `ajv` devDependency + `build-registry`/`test:bundle-contract` scripts |
| `docs/developers/bundles.md` (rewrite) | The real surface-based contract |
| `docs/developers/creating-addons.md`, `creating-servers.md` (modify) | Cross-reference fixes |

---

## Task 1: Add the `ajv` devDependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install ajv (approved package)**

Run:
```bash
cd /home/kh0pp/crow && npm install --save-dev ajv
```
Expected: `package.json` `devDependencies` gains `ajv` (v8.x); `package-lock.json` updated.

- [ ] **Step 2: Verify it imports under ESM**

Run:
```bash
cd /home/kh0pp/crow && node -e "import('ajv').then(m => console.log('ajv', typeof m.default))"
```
Expected: `ajv function`

- [ ] **Step 3: Commit**

```bash
cd /home/kh0pp/crow
git commit package.json package-lock.json -m "F4b: add ajv devDependency for bundle manifest validation"
git show --stat HEAD | head -6
```

---

## Task 2: Manifest schema + shape validation

**Files:**
- Create: `registry/manifest.schema.json`
- Create: `scripts/lib/bundle-contract.mjs`
- Test: `tests/bundle-contract.test.js`

- [ ] **Step 1: Write the failing shape tests**

Create `tests/bundle-contract.test.js`:

```js
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

const VALID = {
  id: "demo", name: "Demo", version: "1.0.0", description: "d",
  type: "bundle", author: "Crow", category: "misc",
};

test("valid minimal manifest passes", () => {
  const { dir } = tmpBundle("demo");
  const r = validateManifest(VALID, dir);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("missing each universal field fails", () => {
  const { dir } = tmpBundle("demo");
  for (const f of ["id", "name", "version", "description", "type", "author", "category"]) {
    const m = { ...VALID }; delete m[f];
    assert.equal(validateManifest(m, dir).ok, false, `expected fail without ${f}`);
  }
});

test("bad type enum and bad semver fail", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, type: "weird" }, dir).ok, false);
  assert.equal(validateManifest({ ...VALID, version: "v1" }, dir).ok, false);
});

test("unknown top-level field is allowed (lenient)", () => {
  const { dir } = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, sttProfileSeed: { x: 1 } }, dir).ok, true);
});

test("detectSurfaces reports declared surfaces", () => {
  const s = detectSurfaces({ ...VALID, server: { command: "node", args: ["x"] }, skills: ["a.md"] });
  assert.deepEqual(s.sort(), ["server", "skills"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/kh0pp/crow && node --test tests/bundle-contract.test.js`
Expected: FAIL — `Cannot find module '../scripts/lib/bundle-contract.mjs'`

- [ ] **Step 3: Write the JSON Schema**

Create `registry/manifest.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://crow.local/registry/manifest.schema.json",
  "title": "Crow Bundle Manifest",
  "type": "object",
  "required": ["id", "name", "version", "description", "type", "author", "category"],
  "additionalProperties": true,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "name": { "type": "string", "minLength": 1 },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+([-+].+)?$" },
    "description": { "type": "string", "minLength": 1 },
    "type": { "type": "string", "enum": ["bundle", "mcp-server", "skill"] },
    "author": { "type": "string", "minLength": 1 },
    "category": { "type": "string", "minLength": 1 },
    "draft": { "type": "boolean" },
    "official": { "type": "boolean" },
    "icon": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "notes": { "type": "string" },
    "panel": { "type": "string", "minLength": 1 },
    "panelRoutes": { "type": "string", "minLength": 1 },
    "skills": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
    "ports": { "type": "array", "items": { "type": "integer", "minimum": 1, "maximum": 65535 } },
    "docker": {
      "type": "object",
      "required": ["composefile"],
      "additionalProperties": true,
      "properties": { "composefile": { "type": "string", "minLength": 1 } }
    },
    "server": {
      "type": "object",
      "required": ["command", "args"],
      "additionalProperties": true,
      "properties": {
        "command": { "type": "string", "minLength": 1 },
        "args": { "type": "array", "minItems": 1, "items": { "type": "string" } },
        "envKeys": { "type": "array", "items": { "type": "string" } }
      }
    },
    "webUI": {
      "type": "object",
      "additionalProperties": true,
      "properties": { "port": { "type": "integer", "minimum": 1, "maximum": 65535 } }
    },
    "requires": {
      "type": "object",
      "additionalProperties": true,
      "properties": { "bundles": { "type": "array", "items": { "type": "string" } } }
    },
    "optional_bundles": { "type": "array", "items": { "type": "string" } },
    "env_vars": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name"],
        "additionalProperties": true,
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "description": { "type": "string" },
          "required": { "type": "boolean" },
          "secret": { "type": "boolean" },
          "default": {}
        }
      }
    }
  }
}
```

- [ ] **Step 4: Write `bundle-contract.mjs` (shape half + detectSurfaces)**

Create `scripts/lib/bundle-contract.mjs`:

```js
/**
 * Bundle manifest contract — the single source of validation logic, shared by
 * scripts/build-registry.mjs and tests/bundle-contract.test.js.
 *
 * Two layers: (1) shape via ajv against registry/manifest.schema.json, and
 * (2) filesystem referential integrity (declared surface files exist, id ==
 * dirname, dependency bundles exist) — which JSON Schema cannot express.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import Ajv from "ajv";

const schema = JSON.parse(
  readFileSync(new URL("../../registry/manifest.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(schema);

/** Surfaces a manifest declares, by key presence. */
export function detectSurfaces(manifest) {
  const s = [];
  if (manifest && manifest.docker) s.push("docker");
  if (manifest && manifest.server) s.push("server");
  if (manifest && manifest.panel) s.push("panel");
  if (manifest && manifest.panelRoutes) s.push("panelRoutes");
  if (manifest && Array.isArray(manifest.skills) && manifest.skills.length) s.push("skills");
  return s;
}

function fileExists(bundleDir, rel) {
  if (typeof rel !== "string" || !rel) return false;
  const p = isAbsolute(rel) ? rel : join(bundleDir, rel);
  return existsSync(p);
}

/**
 * Validate one manifest object against the contract.
 * @param {object} manifest parsed manifest.json
 * @param {string} bundleDir absolute path to the bundle directory
 * @param {{bundleExists?: (id:string)=>boolean}} [opts] resolver for requires.bundles / optional_bundles
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest(manifest, bundleDir, opts = {}) {
  const errors = [];

  // 1. Shape (ajv)
  if (!validateShape(manifest)) {
    for (const e of validateShape.errors || []) {
      errors.push(`shape ${e.instancePath || "/"} ${e.message}`);
    }
  }

  // 2. id must equal dirname
  const dirName = basename(bundleDir);
  if (manifest && manifest.id && dirName && manifest.id !== dirName) {
    errors.push(`id "${manifest.id}" must equal directory name "${dirName}"`);
  }

  // 3. Referential integrity per declared surface
  if (manifest && manifest.docker && !fileExists(bundleDir, manifest.docker.composefile)) {
    errors.push(`docker.composefile "${manifest.docker && manifest.docker.composefile}" not found`);
  }
  if (manifest && manifest.server && Array.isArray(manifest.server.args) && manifest.server.args[0]) {
    if (!fileExists(bundleDir, manifest.server.args[0])) {
      errors.push(`server entry "${manifest.server.args[0]}" not found`);
    }
  }
  if (manifest && manifest.panel && !fileExists(bundleDir, manifest.panel)) {
    errors.push(`panel "${manifest.panel}" not found`);
  }
  if (manifest && manifest.panelRoutes && !fileExists(bundleDir, manifest.panelRoutes)) {
    errors.push(`panelRoutes "${manifest.panelRoutes}" not found`);
  }
  if (manifest && Array.isArray(manifest.skills)) {
    for (const sk of manifest.skills) {
      if (!fileExists(bundleDir, sk)) errors.push(`skill "${sk}" not found`);
    }
  }

  // 4. Dependency bundles exist (via injected resolver)
  const deps = [
    ...(manifest && manifest.requires && Array.isArray(manifest.requires.bundles) ? manifest.requires.bundles : []),
    ...(manifest && Array.isArray(manifest.optional_bundles) ? manifest.optional_bundles : []),
  ];
  if (deps.length && typeof opts.bundleExists === "function") {
    for (const d of deps) {
      if (!opts.bundleExists(d)) errors.push(`required bundle "${d}" does not exist`);
    }
  }

  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/kh0pp/crow && node --test tests/bundle-contract.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow
git add registry/manifest.schema.json scripts/lib/bundle-contract.mjs tests/bundle-contract.test.js
git commit registry/manifest.schema.json scripts/lib/bundle-contract.mjs tests/bundle-contract.test.js -m "F4b: manifest schema + shape validation (validateManifest, detectSurfaces)"
git show --stat HEAD | head -8
```

---

## Task 3: Referential-integrity tests

**Files:**
- Modify: `tests/bundle-contract.test.js` (append tests — `bundle-contract.mjs` already implements integrity from Task 2)

- [ ] **Step 1: Append the failing-then-passing integrity tests**

Append to `tests/bundle-contract.test.js` (after the existing tests):

```js
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

test("declared server entry and docker composefile must exist", () => {
  const b = tmpBundle("demo", { "server/index.js": "//", "docker-compose.yml": "x" });
  const ok = validateManifest({
    ...VALID,
    server: { command: "node", args: ["server/index.js"] },
    docker: { composefile: "docker-compose.yml" },
  }, b.dir);
  assert.equal(ok.ok, true, ok.errors.join("; "));
  const b2 = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, server: { command: "node", args: ["server/index.js"] } }, b2.dir).ok, false);
});

test("declared panel files must exist", () => {
  const b = tmpBundle("demo", { "panel/p.js": "//", "panel/routes.js": "//" });
  assert.equal(validateManifest({ ...VALID, panel: "panel/p.js", panelRoutes: "panel/routes.js" }, b.dir).ok, true);
  const b2 = tmpBundle("demo");
  assert.equal(validateManifest({ ...VALID, panel: "panel/missing.js" }, b2.dir).ok, false);
});

test("requires.bundles existence checked via resolver", () => {
  const { dir } = tmpBundle("demo");
  const m = { ...VALID, requires: { bundles: ["companion"] } };
  assert.equal(validateManifest(m, dir, { bundleExists: (id) => id === "companion" }).ok, true);
  assert.equal(validateManifest(m, dir, { bundleExists: () => false }).ok, false);
});
```

- [ ] **Step 2: Run the tests**

Run: `cd /home/kh0pp/crow && node --test tests/bundle-contract.test.js`
Expected: PASS (10 tests — these pass immediately because `bundle-contract.mjs` already implements integrity; the tests lock in that behavior)

- [ ] **Step 3: Commit**

```bash
cd /home/kh0pp/crow
git commit tests/bundle-contract.test.js -m "F4b: referential-integrity tests for surfaces + id/dirname + deps"
git show --stat HEAD | head -6
```

---

## Task 4: Registry generator (`build-registry.mjs`)

**Files:**
- Create: `scripts/build-registry.mjs`
- Modify: `tests/bundle-contract.test.js` (append generator tests + imports)

- [ ] **Step 1: Add generator imports + failing tests**

At the TOP of `tests/bundle-contract.test.js`, add to the imports:

```js
import { buildRegistry, formatRegistry } from "../scripts/build-registry.mjs";
```

Append these tests at the end of the file:

```js
/** Build a fake bundles root from {id: manifestObject}; creates referenced skill files so they validate. */
function fakeBundlesRoot(manifests) {
  const root = mkdtempSync(join(tmpdir(), "crowreg-"));
  for (const [id, manifest] of Object.entries(manifests)) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    if (Array.isArray(manifest.skills)) {
      for (const s of manifest.skills) {
        mkdirSync(join(dir, s, ".."), { recursive: true });
        writeFileSync(join(dir, s), "x");
      }
    }
  }
  return root;
}

const mk = (id, extra = {}) => ({
  id, name: id.toUpperCase(), version: "1.0.0", description: "d",
  type: "bundle", author: "Crow", category: "misc", ...extra,
});

test("buildRegistry: valid non-draft tracked entries, official injected, sorted by id", () => {
  const root = fakeBundlesRoot({ zebra: mk("zebra"), alpha: mk("alpha"), draftone: mk("draftone", { draft: true }) });
  const { registry } = buildRegistry({ bundlesRoot: root, tracked: null });
  assert.deepEqual(registry["add-ons"].map((e) => e.id), ["alpha", "zebra"]);
  assert.equal(registry["add-ons"][0].official, true);
  assert.equal(registry.version, 2);
});

test("buildRegistry: untracked dir excluded", () => {
  const root = fakeBundlesRoot({ keep: mk("keep"), wip: mk("wip") });
  const { registry } = buildRegistry({ bundlesRoot: root, tracked: new Set(["keep"]) });
  assert.deepEqual(registry["add-ons"].map((e) => e.id), ["keep"]);
});

test("buildRegistry: invalid manifest excluded and flagged", () => {
  const root = fakeBundlesRoot({ bad: mk("bad", { version: "nope" }) });
  const { registry, audit } = buildRegistry({ bundlesRoot: root, tracked: null });
  assert.equal(registry["add-ons"].length, 0);
  assert.equal(audit.find((a) => a.id === "bad").status, "invalid");
});

test("formatRegistry: 2-space indent + trailing newline", () => {
  const out = formatRegistry({ version: 2, "add-ons": [] });
  assert.ok(out.endsWith("}\n"));
  assert.ok(out.includes('  "version": 2'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/kh0pp/crow && node --test tests/bundle-contract.test.js`
Expected: FAIL — `Cannot find module '../scripts/build-registry.mjs'`

- [ ] **Step 3: Write `build-registry.mjs`**

Create `scripts/build-registry.mjs`:

```js
/**
 * Generate registry/add-ons.json from per-bundle manifests.
 *
 * The registry is a committed, generated artifact (lockfile model): every
 * bundle whose manifest passes the contract, is not `draft`, and is git-tracked
 * is emitted (full manifest + official:true), sorted by id. Untracked dirs are
 * implicit drafts (safe WIP handling) — excluded and reported. Orphan registry
 * entries vanish automatically (no manifest, no entry).
 *
 *   node scripts/build-registry.mjs            # write registry/add-ons.json
 *   node scripts/build-registry.mjs --check    # validate + drift-check, no write (CI)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { validateManifest, detectSurfaces } from "./lib/bundle-contract.mjs";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES_ROOT = join(APP_ROOT, "bundles");
const REGISTRY_PATH = join(APP_ROOT, "registry", "add-ons.json");

/** Set of bundle dir names whose manifest.json is git-tracked; null if git unavailable. */
export function trackedBundleSet() {
  try {
    const out = execFileSync("git", ["ls-files", "bundles"], { cwd: APP_ROOT, encoding: "utf8" });
    const set = new Set();
    for (const line of out.split("\n")) {
      const m = line.match(/^bundles\/([^/]+)\/manifest\.json$/);
      if (m) set.add(m[1]);
    }
    return set;
  } catch {
    return null; // git unavailable (e.g. tarball checkout) → treat all as tracked
  }
}

/**
 * @param {{bundlesRoot?: string, tracked?: Set<string>|null}} [opts]
 *   tracked: explicit tracked set (tests). `null` = treat all as tracked.
 *   omitted = derive from `git ls-files`.
 * @returns {{registry: object, audit: object[]}}
 */
export function buildRegistry(opts = {}) {
  const bundlesRoot = opts.bundlesRoot || BUNDLES_ROOT;
  const trackedSet = "tracked" in opts ? opts.tracked : trackedBundleSet();

  const dirs = readdirSync(bundlesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const bundleExists = (id) => existsSync(join(bundlesRoot, id, "manifest.json")) || dirs.includes(id);

  const entries = [];
  const audit = [];
  for (const id of dirs) {
    const manifestPath = join(bundlesRoot, id, "manifest.json");
    if (!existsSync(manifestPath)) continue; // not a bundle
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      audit.push({ id, type: "?", surfaces: [], ok: false, errors: [`manifest.json parse error: ${e.message}`], status: "invalid" });
      continue;
    }
    const bundleDir = join(bundlesRoot, id);
    const { ok, errors } = validateManifest(manifest, bundleDir, { bundleExists });
    const isTracked = trackedSet === null ? true : trackedSet.has(id);
    const isDraft = manifest.draft === true;
    let status = "published";
    if (!ok) status = "invalid";
    else if (isDraft) status = "draft";
    else if (!isTracked) status = "untracked";
    audit.push({ id, type: manifest.type, surfaces: detectSurfaces(manifest), ok, errors, status });
    if (ok && !isDraft && isTracked) entries.push({ ...manifest, official: true });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { registry: { version: 2, "add-ons": entries }, audit };
}

export function formatRegistry(registry) {
  return JSON.stringify(registry, null, 2) + "\n";
}

function main() {
  const isCheck = process.argv.includes("--check");
  const { registry, audit } = buildRegistry();
  const generated = formatRegistry(registry);

  for (const a of audit) {
    const tag = a.status.toUpperCase().padEnd(9);
    const surf = (a.surfaces || []).join("+") || "-";
    const errs = a.errors && a.errors.length ? "  :: " + a.errors.join("; ") : "";
    console.log(`${tag} ${a.id.padEnd(28)} ${(a.type || "?").padEnd(10)} ${surf}${errs}`);
  }
  const n = (s) => audit.filter((a) => a.status === s).length;
  console.log(`\n${audit.length} bundles | ${registry["add-ons"].length} published | ${n("invalid")} invalid | ${n("draft")} draft | ${n("untracked")} untracked`);

  const failures = n("invalid");
  if (isCheck) {
    const current = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : "";
    const drift = current !== generated;
    if (drift) console.error("\nDRIFT: registry/add-ons.json is out of date — run `npm run build-registry`.");
    if (failures || drift) process.exit(1);
    console.log("\nOK: all manifests valid, registry in sync.");
  } else {
    if (failures) { console.error(`\nRefusing to write: ${failures} invalid manifest(s).`); process.exit(1); }
    writeFileSync(REGISTRY_PATH, generated);
    console.log(`\nWrote ${REGISTRY_PATH}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/kh0pp/crow && node --test tests/bundle-contract.test.js`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/kh0pp/crow
git add scripts/build-registry.mjs
git commit scripts/build-registry.mjs tests/bundle-contract.test.js -m "F4b: registry generator (buildRegistry, --check drift mode, untracked=draft)"
git show --stat HEAD | head -8
```

---

## Task 5: Wire npm scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the two scripts**

In `package.json` `scripts`, add (after `"sync-skills": ...`):

```json
    "build-registry": "node scripts/build-registry.mjs",
    "test:bundle-contract": "node --test tests/bundle-contract.test.js",
```

- [ ] **Step 2: Verify both run**

Run:
```bash
cd /home/kh0pp/crow && npm run test:bundle-contract 2>&1 | tail -5
```
Expected: tests pass (14 tests).

Run:
```bash
cd /home/kh0pp/crow && npm run build-registry -- --check 2>&1 | tail -8
```
Expected: prints the audit table for the REAL bundles. This will likely report DRIFT and possibly INVALID manifests — that is expected and is resolved in Tasks 6–7. (Exit code nonzero is fine here.)

- [ ] **Step 3: Commit**

```bash
cd /home/kh0pp/crow
git commit package.json -m "F4b: add build-registry + test:bundle-contract npm scripts"
git show --stat HEAD | head -6
```

---

## Task 6: Integration tests over the real bundles (failing gate)

**Files:**
- Modify: `tests/bundle-contract.test.js` (append integration tests + `readFileSync` import)

- [ ] **Step 1: Add the integration tests**

Ensure `readFileSync` is imported at the top of `tests/bundle-contract.test.js`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
```

Append at the end of `tests/bundle-contract.test.js`:

```js
// --- Integration: the real bundles + committed registry (no fixtures) ---

test("all tracked real bundle manifests are valid", () => {
  const { audit } = buildRegistry(); // real BUNDLES_ROOT + git tracked-set
  const invalid = audit.filter((a) => a.status === "invalid");
  assert.equal(invalid.length, 0, "invalid manifests: " + invalid.map((a) => `${a.id} [${a.errors.join(", ")}]`).join(" | "));
});

test("committed registry/add-ons.json matches generated (no drift)", () => {
  const { registry } = buildRegistry();
  const generated = formatRegistry(registry);
  const current = readFileSync(new URL("../registry/add-ons.json", import.meta.url), "utf8");
  assert.equal(current, generated, "registry drift — run `npm run build-registry`");
});
```

- [ ] **Step 2: Run — expect these two to FAIL**

Run: `cd /home/kh0pp/crow && node --test tests/bundle-contract.test.js 2>&1 | tail -20`
Expected: the 14 unit tests pass; the 2 integration tests FAIL (drift, because the committed registry is the old hand-maintained file; possibly also invalid-manifest failures). This documents the pre-fix state.

- [ ] **Step 3: Commit the failing gate**

```bash
cd /home/kh0pp/crow
git commit tests/bundle-contract.test.js -m "F4b: integration gate — all real manifests valid + registry no-drift (currently failing, fixed next)"
git show --stat HEAD | head -6
```

---

## Task 7: Audit-fix + regenerate the registry

**Files:**
- Modify: any nonconformant `bundles/<id>/manifest.json` (data-driven; see below)
- Regenerate: `registry/add-ons.json`

- [ ] **Step 1: Capture the audit**

Run:
```bash
cd /home/kh0pp/crow && node scripts/build-registry.mjs --check 2>&1 | tee /tmp/f4b-audit.txt | grep -E "^INVALID|^UNTRACKED|^DRAFT" 
```
Expected: a list of INVALID (must fix), UNTRACKED (the 5 WIP dirs — leave their files untouched), DRAFT (none yet).

- [ ] **Step 2: Fix each INVALID tracked manifest**

For every line tagged `INVALID`, read the `:: <error>` reason and fix the **manifest** (not the contract):
- Missing universal field (e.g. `category`) → add the correct value (read the bundle's README/description; never fabricate — if genuinely unknown, use the bundle's existing `tags`/dir purpose to choose an accurate `category`).
- `skill "..." not found` / `server entry "..." not found` / `panel "..." not found` → either the path is wrong (fix it to the real file) or the file was removed (remove the dangling reference). Verify against the actual dir contents with `ls bundles/<id>`.
- `id must equal directory name` → fix the manifest `id` to match the dir.
- `required bundle "X" does not exist` → fix or remove the dependency.

Re-run `node scripts/build-registry.mjs --check 2>&1 | grep -E "^INVALID"` after each fix until zero INVALID remain. Commit manifest fixes with explicit paths, e.g.:
```bash
git commit bundles/<id>/manifest.json -m "F4b: fix <id> manifest — <what was wrong>"
```

> **STOP-AND-ASK:** If a fix would require a non-obvious judgement (a missing file that should arguably exist, a bundle that looks half-built, or `campaigns`/any tracked dir that fails), do NOT guess — surface it to the user with the audit line and proposed resolution (fix / mark `"draft": true` / leave). The UNTRACKED WIP dirs are reported only; their files are never edited.

- [ ] **Step 3: Regenerate the registry**

Run:
```bash
cd /home/kh0pp/crow && node scripts/build-registry.mjs 2>&1 | tail -4
```
Expected: `Wrote .../registry/add-ons.json`.

- [ ] **Step 4: Review the diff (semantic vs normalization)**

Run:
```bash
cd /home/kh0pp/crow && git diff --stat registry/add-ons.json && echo "--- sample semantic gains (server/skills now present) ---" && git diff registry/add-ons.json | grep -E '^\+' | grep -E '"server"|"skills"|"panel"' | head
```
Expected: a large diff. Two kinds of change, both expected: (a) **normalization** — non-ASCII `—` becomes literal `—` and ordering/formatting normalizes (the registry is now generated); (b) **semantic** — previously-thin entries (jellyfin, plex, obsidian, trilium, nominatim, browser, …) regain `server`/`skills`/`panel` from their manifests, and orphan entries `tasks`/`developer-kit` disappear. Confirm no published bundle was unexpectedly dropped:
```bash
cd /home/kh0pp/crow && node -e '
const before = require("./registry/add-ons.json"); // already regenerated; compare against HEAD via git
' ; git show HEAD:registry/add-ons.json | node -e '
const fs=require("fs"); let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  const before=new Set(JSON.parse(s)["add-ons"].map(e=>e.id));
  const after=new Set(require("/home/kh0pp/crow/registry/add-ons.json")["add-ons"].map(e=>e.id));
  console.log("dropped:", [...before].filter(x=>!after.has(x)).join(", ")||"(none)");
  console.log("added:", [...after].filter(x=>!before.has(x)).join(", ")||"(none)");
});'
```
Expected `dropped:` to contain only `tasks, developer-kit` (orphans) plus any dir you intentionally marked draft; `added:` may include `campaigns` if it validated. If anything else dropped, investigate before committing.

- [ ] **Step 5: Run the full suite to verify the gate is green**

Run: `cd /home/kh0pp/crow && node --test tests/bundle-contract.test.js 2>&1 | tail -6`
Expected: PASS (16 tests — including the two integration tests now green).

- [ ] **Step 6: Confirm no regression in the gateway-facing tests**

Run: `cd /home/kh0pp/crow && node --test tests/auth-network.test.js 2>&1 | tail -4`
Expected: PASS (this work touches no routes/auth; this is a guard).

- [ ] **Step 7: Commit the regenerated registry**

```bash
cd /home/kh0pp/crow
git commit registry/add-ons.json -m "F4b: regenerate add-ons.json from manifests (drops orphans, restores server/skills)"
git show --stat HEAD | head -6
```

---

## Task 8: Documentation

**Files:**
- Rewrite: `docs/developers/bundles.md`
- Modify: `docs/developers/creating-addons.md`, `docs/developers/creating-servers.md` (cross-reference fixes only)

- [ ] **Step 1: Rewrite `docs/developers/bundles.md`**

Replace the entire file contents with:

```markdown
# Bundles — the Bundle Contract

A **bundle** is the modular unit of Crow's extension layer: a directory under `bundles/<id>/` described by a `manifest.json`. A bundle may provide any combination of surfaces — a containerized **service** (Docker), an **MCP server** (tools), a **dashboard panel**, and **skills** — hence "bundle = service + tools + skills". The contract is *surface-based*: a bundle is only required to satisfy the rules for the surfaces it actually declares.

## Where bundles come from

- Source of truth: each `bundles/<id>/manifest.json`.
- Install catalog: `registry/add-ons.json` is **generated** from the manifests by `npm run build-registry` — never hand-edit it. It is committed (lockfile model) and a test fails if it drifts.

## Universal required fields

Every manifest must have:

| Field | Rule |
|---|---|
| `id` | must equal the directory name |
| `name` | non-empty |
| `version` | semver (`x.y.z`) |
| `description` | non-empty |
| `type` | `bundle` \| `mcp-server` \| `skill` (a coarse category tag, not what drives required fields) |
| `author` | non-empty |
| `category` | non-empty |

## Surfaces (declare what you provide)

A surface is "declared" by the presence of its key. Each declared surface is validated for shape **and** that its referenced files exist under the bundle dir:

| Surface | Shape | Integrity |
|---|---|---|
| `docker` | `{ "composefile": "docker-compose.yml" }` | the composefile exists |
| `server` | `{ "command": "node", "args": ["server/index.js"], "envKeys": [...] }` | `args[0]` exists |
| `panel` / `panelRoutes` | `"panel/<id>.js"` | the file exists |
| `skills` | `["skills/<id>.md", ...]` | every path exists |
| `ports` / `port` / `webUI.port` | integers (1–65535) | — |
| `requires.bundles` / `optional_bundles` | `["<bundle-id>", ...]` | each id exists as a `bundles/<id>` dir |
| `env_vars` | `[{ "name": "X", "description": "...", "required": false, "secret": false, "default": "" }]` | each entry has a `name` |

Unknown fields are allowed (the schema is lenient) — bundle-specific extras like `capabilities`, `companion`, `storage`, `providers`, `sttProfileSeed` pass through untouched. The canonical shape is `registry/manifest.schema.json`.

## Draft / unpublished

- `"draft": true` excludes a bundle from the generated registry.
- An **untracked** bundle dir (not committed to git) is treated as an implicit draft — excluded and reported, never auto-published. This keeps work-in-progress out of the registry.

## Validate + generate

```bash
npm run build-registry -- --check   # validate all manifests + drift-check (CI)
npm run build-registry              # regenerate registry/add-ons.json
npm run test:bundle-contract        # the node:test gate
```

`--check` prints a per-bundle audit (id, type, surfaces, status) and exits nonzero on any invalid manifest or if the committed registry is out of date.

## Minimal example

```
bundles/your-bundle/
├── manifest.json
├── docker-compose.yml      (if it ships a service)
├── server/index.js         (if it provides MCP tools)
├── panel/your-bundle.js    (if it adds a dashboard panel)
└── skills/your-bundle.md   (if it adds skills)
```

```json
{
  "id": "your-bundle",
  "name": "Your Bundle",
  "version": "1.0.0",
  "description": "What it does",
  "type": "bundle",
  "author": "You",
  "category": "utilities",
  "docker": { "composefile": "docker-compose.yml" },
  "server": { "command": "node", "args": ["server/index.js"], "envKeys": ["YOUR_API_KEY"] },
  "panel": "panel/your-bundle.js",
  "skills": ["skills/your-bundle.md"],
  "requires": { "env": ["YOUR_API_KEY"] },
  "env_vars": [
    { "name": "YOUR_API_KEY", "description": "API key", "required": true, "secret": true }
  ]
}
```

After adding or editing a bundle, run `npm run build-registry` and commit both the manifest and the regenerated `registry/add-ons.json`.
```

- [ ] **Step 2: Fix cross-references in the other two docs**

Run to find stale references:
```bash
cd /home/kh0pp/crow && grep -n "add-ons.json\|manifest.json\|bundle" docs/developers/creating-addons.md docs/developers/creating-servers.md | head -30
```
For any line that tells authors to hand-edit `registry/add-ons.json`, change it to: author `bundles/<id>/manifest.json` then run `npm run build-registry` (the registry is generated). Add a one-line pointer near the top of each: `> The bundle contract is documented in [bundles.md](./bundles.md).` Make only these targeted edits — do not rewrite these files.

- [ ] **Step 3: Verify docs build (if VitePress dev is quick) or at least lint links**

Run:
```bash
cd /home/kh0pp/crow && grep -c "Surfaces" docs/developers/bundles.md
```
Expected: `1` (sanity check the rewrite landed).

- [ ] **Step 4: Commit**

```bash
cd /home/kh0pp/crow
git commit docs/developers/bundles.md docs/developers/creating-addons.md docs/developers/creating-servers.md -m "F4b: document the surface-based bundle contract; registry is generated"
git show --stat HEAD | head -8
```

---

## Final verification

- [ ] **Run the full bundle-contract suite + a gateway smoke test**

```bash
cd /home/kh0pp/crow
node --test tests/bundle-contract.test.js 2>&1 | tail -6      # expect 16 pass
npm run build-registry -- --check 2>&1 | tail -3              # expect "OK: ... in sync." exit 0
timeout 8 node servers/gateway/index.js --no-auth 2>&1 | tail -15 || true   # boots clean, extensions panel reads regenerated registry
```
Expected: all bundle-contract tests pass; `--check` reports OK and exits 0; gateway boots without errors referencing the registry.

- [ ] **Holistic review** — per subagent-driven-development, run the final holistic code review across all F4b commits before considering the branch done.

---

## Notes for the implementer

- **Commits:** always `git commit <explicit paths>` (parallel sessions share the tree); for new files `git add <path>` first. Verify with `git show --stat HEAD`. Never attribute Claude / add as co-author.
- **No init-db:** this work adds no DB tables. Deploy (if/when) = pull + restart gateways; the registry is read from disk.
- **Build resource note:** subagent-driven runs one subagent at a time and only `node --test` — no need to stop the model stack. Only stop `docker stop vllm-rocm-qwen35-4b llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed crow-companion faster-whisper-server kokoro-tts` before genuinely parallel heavy fan-out.
- **WIP safety:** the five uncommitted dirs (`capstone-tracker`, `fed-gov-data`, `knowledge-base-mcp`, `research-integration`, `texas-gov-data`) are untracked → auto-excluded. Never edit their files or `git add` them as part of F4b.
```
