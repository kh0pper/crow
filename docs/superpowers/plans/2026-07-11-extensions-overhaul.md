# Extensions Overhaul + One-Click Collections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Crow dashboard Extensions page as a real app store (no horizontal scrolling, browse/installed views, featured + grouped sections) and add one-click themed collections installed through a new batched, auth-hardened `install-set` API.

**Architecture:** Server-rendered panel (existing pattern: `panels/extensions.js` orchestrator + `panels/extensions/{html,css,client,data-queries,api-handlers}.js`) gains a `groups.js` (category→display-group map) and `collections.js` (loader for the new `registry/collections.json`). `routes/bundles.js` is refactored so its install path splits into two pure-ish seams — `validateInstall()` (outcome-returning gate bundle) and `runInstallJob()` (outcome-returning worker) — which the single-install route and the new `POST /bundles/api/install-set` both consume. A new module-level `install-lock.js` coordinates the set-busy gate and auto-update inhibition.

**Tech Stack:** Node 20 ESM, Express Router, node:test + node:assert/strict (no third-party test framework), server-rendered template strings, vanilla client JS (no framework), Turbo Drive for navigation.

**Spec:** `docs/superpowers/specs/2026-07-11-extensions-overhaul-design.md` (v3 — R1+R2 adversarial reviews folded). Read it before Task 1; every design ID below (D1…D10, R1-Mn, R2-N-Mn) refers to it.

## Global Constraints

- **Branch:** `feat/extensions-overhaul` (already exists, carries the three spec commits).
- **Commits:** positional-path only — `git commit <path> [<path>...] -m "..."`. Never `git add -A`, never `--amend`. For NEW files: `git add <specific-file>` first, then the positional commit. Verify with `git show --stat HEAD` after every commit. Parallel Claude sessions modify this working tree.
- **Tests:** `node --test tests/<file>.test.js`. All tests live in `tests/*.test.js`. Full suite baseline: **1522 pass / 0 fail / 1 skip** — must not regress.
- **i18n:** every user-facing string goes through `t()`/`tJs()` with a key added to BOTH `en` and `es` in `servers/gateway/dashboard/shared/i18n.js`. No hardcoded English in panels.
- **No new host ports** (so no `docs/developers/port-allocation.md` change); no DB schema change; nothing here participates in instance-sync.
- **Network invariant:** nothing added here may become Funnel-reachable. Do not touch `PUBLIC_FUNNEL_PREFIXES`.
- **Never attribute Claude as co-author** in any commit message.
- **Design-token discipline:** CSS uses `var(--crow-*)` tokens, `'Fraunces',serif` for display names, `'DM Sans',sans-serif` for body, `'JetBrains Mono',monospace` for metadata; `.theme-glass` overrides mirrored for any new surface.

---

### Task 1: Global horizontal-overflow containment (D1)

**Files:**
- Modify: `servers/gateway/dashboard/shared/layout.js:963-967` (`.main-content` rule)
- Test: `tests/dashboard-layout-containment.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks (pure CSS fix). CDP proof happens in Task 13.

Root cause (CDP-verified): `.main-content` is a flex child of `.dashboard { display:flex }` with no `min-width:0`, so a wide non-wrapping descendant (today: the 19 nowrap category tabs, min-content ≈2251px) inflates the whole main column to 2315px and the document to 2555px vs a 1904px viewport.

- [ ] **Step 1: Write the failing test**

```js
// tests/dashboard-layout-containment.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(
  new URL("../servers/gateway/dashboard/shared/layout.js", import.meta.url),
  "utf8",
);

test(".main-content sets min-width:0 so a wide descendant cannot inflate the flex column", () => {
  // Grab the .main-content rule body (the desktop one, first occurrence).
  const m = CSS.match(/\.main-content\s*\{([^}]*)\}/);
  assert.ok(m, ".main-content rule not found in layout.js");
  const body = m[1].replace(/\s+/g, "");
  assert.ok(
    /min-width:0/.test(body),
    ".main-content must declare min-width:0 (flex automatic-minimum containment). " +
      "Without it a nowrap descendant propagates its min-content width to the whole page " +
      "(the Extensions 2555px-wide-document bug).",
  );
  assert.ok(/flex:1/.test(body), "guard: this is the flex-child rule we think it is");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/dashboard-layout-containment.test.js`
Expected: FAIL — "must declare min-width:0".

- [ ] **Step 3: Add the declaration**

In `servers/gateway/dashboard/shared/layout.js`, the `.main-content` rule becomes:

```css
  /* Main content */
  .main-content {
    flex: 1;
    /* Flex children default to min-width:auto, so a nowrap descendant's
       min-content width inflates this column and the whole document
       (the Extensions horizontal-scroll bug: doc 2555px vs viewport 1904px).
       min-width:0 lets the column shrink and forces descendants to handle
       their own overflow. */
    min-width: 0;
    margin-left: 240px;
    min-height: 100vh;
  }
```

(Do not touch the `@media` mobile `.main-content` block near line 1294 — it already sets `overflow:hidden`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/dashboard-layout-containment.test.js`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add tests/dashboard-layout-containment.test.js
git commit tests/dashboard-layout-containment.test.js servers/gateway/dashboard/shared/layout.js \
  -m "fix(dashboard): .main-content min-width:0 — a nowrap descendant no longer inflates the page (Extensions horizontal-scroll root cause)"
git show --stat HEAD
```

---

### Task 2: Category display groups (D3)

**Files:**
- Create: `servers/gateway/dashboard/panels/extensions/groups.js`
- Test: `tests/extensions-groups.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const DISPLAY_GROUPS` — array of `{ id, labelKey, categories: string[] }` in render order.
  - `export function groupForCategory(category: string): string` — returns a group id; unknown/undefined → `"more"`.
  - `export function groupAddons(addons: Array<{category?:string}>): Map<string, Array<addon>>` — group id → addons, preserving input order, only groups with ≥1 addon.

The registry's 18 live categories: ai, media, productivity, storage, smart-home, networking, gaming, data, social, finance, infrastructure, automation, education, federated-social, federated-media, federated-comms, cameras, hardware (+ `other` as the schema default).

- [ ] **Step 1: Write the failing test**

```js
// tests/extensions-groups.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DISPLAY_GROUPS, groupForCategory, groupAddons } from "../servers/gateway/dashboard/panels/extensions/groups.js";

const REGISTRY = JSON.parse(
  readFileSync(new URL("../registry/add-ons.json", import.meta.url), "utf8"),
);

test("every category present in the real registry maps to a group", () => {
  const cats = new Set(REGISTRY["add-ons"].map((a) => a.category || "other"));
  const groupIds = new Set(DISPLAY_GROUPS.map((g) => g.id));
  for (const cat of cats) {
    const g = groupForCategory(cat);
    assert.ok(groupIds.has(g), `category '${cat}' mapped to unknown group '${g}'`);
  }
});

test("unknown / missing categories fall into 'more' (forward-compatible, never dropped)", () => {
  assert.equal(groupForCategory("quantum-teleportation"), "more");
  assert.equal(groupForCategory(undefined), "more");
  assert.equal(groupForCategory(""), "more");
});

test("no category is claimed by two groups", () => {
  const seen = new Map();
  for (const g of DISPLAY_GROUPS) {
    for (const c of g.categories) {
      assert.ok(!seen.has(c), `category '${c}' claimed by both '${seen.get(c)}' and '${g.id}'`);
      seen.set(c, g.id);
    }
  }
});

test("groupAddons buckets by group, preserves order, omits empty groups", () => {
  const addons = [
    { id: "a", category: "ai" },
    { id: "b", category: "media" },
    { id: "c", category: "ai" },
    { id: "d", category: "totally-made-up" },
  ];
  const grouped = groupAddons(addons);
  assert.deepEqual(grouped.get("ai").map((a) => a.id), ["a", "c"]);
  assert.deepEqual(grouped.get("media").map((a) => a.id), ["b"]);
  assert.deepEqual(grouped.get("more").map((a) => a.id), ["d"]);
  assert.equal(grouped.has("home-hardware"), false, "empty groups are omitted");
});

test("every group has an i18n label key", () => {
  for (const g of DISPLAY_GROUPS) {
    assert.match(g.labelKey, /^extensions\.group[A-Za-z]+$/, `bad labelKey on ${g.id}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/extensions-groups.test.js`
Expected: FAIL — cannot find module `groups.js`.

- [ ] **Step 3: Write the module**

```js
// servers/gateway/dashboard/panels/extensions/groups.js
/**
 * Extensions Panel — category display groups.
 *
 * The registry has 18+ fine-grained categories, which rendered as 19 filter
 * tabs and (with the old flex-nowrap tab row) inflated the page to 2555px.
 * The store UI groups them into a handful of browsable sections instead.
 * The registry is NOT changed — this is a display-side mapping, so new
 * registry categories keep working: anything unmapped lands in "More".
 */

export const DISPLAY_GROUPS = [
  { id: "ai",             labelKey: "extensions.groupAi",             categories: ["ai"] },
  { id: "media",          labelKey: "extensions.groupMedia",          categories: ["media"] },
  { id: "productivity",   labelKey: "extensions.groupProductivity",   categories: ["productivity", "education"] },
  { id: "social",         labelKey: "extensions.groupSocial",         categories: ["social", "federated-social", "federated-media", "federated-comms"] },
  { id: "infrastructure", labelKey: "extensions.groupInfrastructure", categories: ["infrastructure", "networking", "storage", "data", "automation"] },
  { id: "home-hardware",  labelKey: "extensions.groupHomeHardware",   categories: ["smart-home", "cameras", "hardware"] },
  { id: "more",           labelKey: "extensions.groupMore",           categories: ["finance", "gaming", "other"] },
];

const CATEGORY_TO_GROUP = new Map();
for (const g of DISPLAY_GROUPS) {
  for (const c of g.categories) CATEGORY_TO_GROUP.set(c, g.id);
}

/** Group id for a registry category. Unknown/missing → "more" (never dropped). */
export function groupForCategory(category) {
  if (!category) return "more";
  return CATEGORY_TO_GROUP.get(category) || "more";
}

/**
 * Bucket add-ons by display group.
 * @returns {Map<string, Array<object>>} group id → addons (input order preserved);
 *   groups with no add-ons are absent from the map.
 */
export function groupAddons(addons) {
  const out = new Map();
  for (const g of DISPLAY_GROUPS) {
    const members = addons.filter((a) => groupForCategory(a.category) === g.id);
    if (members.length > 0) out.set(g.id, members);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/extensions-groups.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/panels/extensions/groups.js tests/extensions-groups.test.js
git commit servers/gateway/dashboard/panels/extensions/groups.js tests/extensions-groups.test.js \
  -m "feat(extensions): category display-group mapping (7 groups, unknown categories fall to More)"
git show --stat HEAD
```

---

### Task 3: Collections data file + loader + hard-rules guard (D5)

**Files:**
- Create: `registry/collections.json`
- Create: `servers/gateway/dashboard/panels/extensions/collections.js`
- Test: `tests/extensions-collections.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const COLLECTIONS_PATH` — absolute path to `registry/collections.json`.
  - `export function loadCollections(path = COLLECTIONS_PATH): Array<Collection>` — returns `[]` on missing/corrupt file (never throws).
  - `export function getCollection(id, path?): Collection | null`.
  - `Collection` = `{ id, name, description, icon, members: Array<{ id, kind }> }` where `kind ∈ {"deploys","connects","builtin"}` and `connects` members also carry `you_need: string`.

Hard rules (enforced by the test against the REAL registry + REAL on-disk `bundles/<id>/manifest.json` — `getManifest()` reads on-disk manifests, and that is what install actually enforces):
official-registry member; source dir `bundles/<id>` exists; not `privileged`; not `consent_required`; no `requires.gpu`/`min_vram_gb`; dependency closure (`requires.bundles` ⊆ set) and topological order; `kind` matches compose-file presence (compose ⇒ `deploys`); `connects` ⇒ non-empty `you_need`.

- [ ] **Step 1: Write the failing test**

```js
// tests/extensions-collections.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCollections, getCollection, COLLECTIONS_PATH } from "../servers/gateway/dashboard/panels/extensions/collections.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = JSON.parse(readFileSync(join(REPO, "registry/add-ons.json"), "utf8"))["add-ons"];
const byId = new Map(REGISTRY.map((a) => [a.id, a]));
const manifestOf = (id) =>
  JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
const hasCompose = (id) => existsSync(join(REPO, "bundles", id, "docker-compose.yml"));

test("loader returns the four collections with well-formed shape", () => {
  const cols = loadCollections();
  assert.deepEqual(cols.map((c) => c.id).sort(), ["development", "education", "home-server", "research"]);
  for (const c of cols) {
    assert.ok(c.name && c.description && c.icon, `${c.id} missing display fields`);
    assert.ok(Array.isArray(c.members) && c.members.length > 0, `${c.id} has no members`);
    for (const m of c.members) {
      assert.ok(["deploys", "connects", "builtin"].includes(m.kind), `${c.id}/${m.id} bad kind '${m.kind}'`);
    }
  }
});

test("HARD RULE: every member exists in the official registry and on disk", () => {
  for (const c of loadCollections()) {
    for (const m of c.members) {
      assert.ok(byId.has(m.id), `${c.id}: '${m.id}' is not in registry/add-ons.json`);
      assert.ok(existsSync(join(REPO, "bundles", m.id, "manifest.json")), `${c.id}: bundles/${m.id} has no manifest`);
    }
  }
});

test("HARD RULE: no member is privileged, consent_required, or GPU-gated", () => {
  for (const c of loadCollections()) {
    for (const m of c.members) {
      const man = manifestOf(m.id);
      assert.notEqual(man.privileged, true, `${c.id}/${m.id} is privileged — one-click must not bypass the consent gate`);
      assert.notEqual(man.consent_required, true, `${c.id}/${m.id} is consent_required — one-click must not bypass the consent gate`);
      assert.ok(!man.requires?.gpu, `${c.id}/${m.id} requires a GPU — host-specific, not collection material`);
      assert.ok(!man.requires?.min_vram_gb, `${c.id}/${m.id} requires VRAM — host-specific`);
    }
  }
});

test("HARD RULE: no member's compose file uses host networking or a docker socket (install would be refused)", () => {
  for (const c of loadCollections()) {
    for (const m of c.members) {
      if (!hasCompose(m.id)) continue;
      const compose = readFileSync(join(REPO, "bundles", m.id, "docker-compose.yml"), "utf8");
      assert.ok(!/network_mode:\s*["']?host/.test(compose), `${c.id}/${m.id} uses host networking — validateComposeFile refuses it without privileged+consent`);
      assert.ok(!/\/var\/run\/docker\.sock/.test(compose), `${c.id}/${m.id} mounts the docker socket — refused without consent_required`);
    }
  }
});

test("HARD RULE: dependency closure + topological order", () => {
  for (const c of loadCollections()) {
    const seen = new Set();
    for (const m of c.members) {
      const deps = manifestOf(m.id).requires?.bundles || [];
      for (const d of deps) {
        assert.ok(c.members.some((x) => x.id === d), `${c.id}/${m.id} requires '${d}' which is not in the collection`);
        assert.ok(seen.has(d), `${c.id}: '${d}' must be ordered BEFORE its dependent '${m.id}'`);
      }
      seen.add(m.id);
    }
  }
});

test("HARD RULE: kind matches reality; connects members declare what you'll need", () => {
  for (const c of loadCollections()) {
    for (const m of c.members) {
      if (hasCompose(m.id)) {
        assert.equal(m.kind, "deploys", `${c.id}/${m.id} ships a compose file → kind must be 'deploys'`);
      } else {
        assert.notEqual(m.kind, "deploys", `${c.id}/${m.id} has no compose file → kind cannot be 'deploys'`);
      }
      if (m.kind === "connects") {
        assert.ok(m.you_need && m.you_need.length > 0, `${c.id}/${m.id} is 'connects' → must declare you_need (an external service the user must already run)`);
      }
    }
  }
});

test("loader is crash-proof: missing file → [], corrupt file → []", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowcol-"));
  assert.deepEqual(loadCollections(join(dir, "nope.json")), []);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ this is not json");
  assert.deepEqual(loadCollections(bad), []);
});

test("getCollection returns a collection by id, null for unknown", () => {
  assert.equal(getCollection("home-server").id, "home-server");
  assert.equal(getCollection("does-not-exist"), null);
});

test("COLLECTIONS_PATH points at the real registry file", () => {
  assert.ok(existsSync(COLLECTIONS_PATH), "registry/collections.json must exist");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/extensions-collections.test.js`
Expected: FAIL — cannot find module `collections.js`.

- [ ] **Step 3: Write the data file**

```json
{
  "version": 1,
  "collections": [
    {
      "id": "home-server",
      "name": "Home Server",
      "description": "Media, documents, network filtering and uptime alerts — the core of a self-hosted home.",
      "icon": "home",
      "members": [
        { "id": "jellyfin", "kind": "deploys" },
        { "id": "paperless", "kind": "deploys" },
        { "id": "adguard-home", "kind": "deploys" },
        { "id": "uptime-kuma", "kind": "deploys" },
        { "id": "ntfy", "kind": "deploys" },
        { "id": "home-assistant", "kind": "connects", "you_need": "A running Home Assistant instance (its URL and a long-lived access token)." }
      ]
    },
    {
      "id": "education",
      "name": "Education",
      "description": "Course content, a library, a wiki, and document tools for teaching and learning.",
      "icon": "graduation-cap",
      "members": [
        { "id": "kolibri", "kind": "deploys" },
        { "id": "kavita", "kind": "deploys" },
        { "id": "calibre-web", "kind": "deploys" },
        { "id": "bookstack", "kind": "deploys" },
        { "id": "stirling-pdf", "kind": "deploys" },
        { "id": "knowledge-base", "kind": "builtin" }
      ]
    },
    {
      "id": "research",
      "name": "Research",
      "description": "Private search, feeds, read-later, bookmarks and document archiving for source-driven work.",
      "icon": "search",
      "members": [
        { "id": "searxng", "kind": "deploys" },
        { "id": "miniflux", "kind": "deploys" },
        { "id": "wallabag", "kind": "deploys" },
        { "id": "linkding", "kind": "deploys" },
        { "id": "paperless", "kind": "deploys" },
        { "id": "knowledge-base", "kind": "builtin" }
      ]
    },
    {
      "id": "development",
      "name": "Development",
      "description": "Self-hosted git, object storage, uptime monitoring and a SQL explorer.",
      "icon": "git",
      "members": [
        { "id": "gitea", "kind": "deploys" },
        { "id": "minio", "kind": "deploys" },
        { "id": "uptime-kuma", "kind": "deploys" },
        { "id": "data-dashboard", "kind": "builtin" }
      ]
    }
  ]
}
```

Before moving on, sanity-check each member against the hard rules by hand: `browser` (host networking) and `maker-lab` (unmet `requires.bundles: ["companion"]`) are DELIBERATELY absent — R1-M2. `immich` is absent from home-server: it ships no compose file and is an integration to an external Immich — R1-M7. If the Step-4 test disagrees with this file, the FILE is wrong, not the test.

- [ ] **Step 4: Write the loader**

```js
// servers/gateway/dashboard/panels/extensions/collections.js
/**
 * Extensions Panel — themed collections ("install these N extensions in one click").
 *
 * Data lives in registry/collections.json. v1 is local-file only: the remote
 * add-on registry may grow collections later, at which point the merge follows
 * the add-on rule (local wins by id).
 *
 * Membership is constrained (tests/extensions-collections.test.js enforces it):
 * official add-ons only, never privileged / consent_required (one-click must not
 * weaken the consent gate), never GPU-gated, dependency-closed and topologically
 * ordered, and each member declares how it arrives:
 *   deploys  — ships its own containers via docker-compose
 *   connects — integrates with an external service the user must already run
 *              (carries `you_need`, rendered as a prerequisite in the UI)
 *   builtin  — in-process panel/MCP add-on: no container, no external service
 * The server re-validates all of this at install time against the on-disk
 * manifests (routes/bundles.js) — this file is data, not a trust boundary.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** registry/collections.json — five levels up from panels/extensions/. */
export const COLLECTIONS_PATH = join(__dirname, "../../../../../registry/collections.json");

/**
 * Load collections. Never throws: a missing or corrupt file yields [] and the
 * collections section simply doesn't render.
 * @returns {Array<{id:string,name:string,description:string,icon:string,members:Array<{id:string,kind:string,you_need?:string}>}>}
 */
export function loadCollections(path = COLLECTIONS_PATH) {
  try {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf8"));
    const collections = data?.collections;
    if (!Array.isArray(collections)) return [];
    return collections.filter(
      (c) => c && typeof c.id === "string" && Array.isArray(c.members) && c.members.length > 0,
    );
  } catch {
    return [];
  }
}

/** @returns {object|null} the collection with this id, or null. */
export function getCollection(id, path = COLLECTIONS_PATH) {
  return loadCollections(path).find((c) => c.id === id) || null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/extensions-collections.test.js`
Expected: PASS (9 tests). If a hard-rule test fails, fix `registry/collections.json` (drop or reorder the offending member) — never weaken the test.

- [ ] **Step 6: Commit**

```bash
git add registry/collections.json servers/gateway/dashboard/panels/extensions/collections.js tests/extensions-collections.test.js
git commit registry/collections.json servers/gateway/dashboard/panels/extensions/collections.js tests/extensions-collections.test.js \
  -m "feat(extensions): themed collections data + loader, with hard membership rules enforced against the real registry and on-disk manifests"
git show --stat HEAD
```

---

### Task 4: `validateInstall()` — the install gates as an outcome function (D6.4b)

**Files:**
- Modify: `servers/gateway/routes/bundles.js` (add `validateInstall`; rewire `POST /bundles/api/install`'s validation half, currently lines ~1083–1200)
- Test: `tests/bundles-validate-install.test.js` (create)

**Interfaces:**
- Consumes: existing module-internals `isValidBundleId`, `getInstalled`, `getManifest`, `checkHardwareGate`, `checkGpuArchCompatible`, `manifestRequiresConsent`, `validateConsentToken`, `createDbClient`, `APP_BUNDLES`.
- Produces:
  ```js
  /**
   * @returns {Promise<
   *   { ok: true, manifest: object, installed: Array, consentVerified: boolean, hardwareWarning?: object }
   * | { ok: false, status: number, code: string, error: string, extra?: object }>}
   * codes: invalid_id | not_found | already_installed | missing_dependencies |
   *        hardware_gate | gpu_arch_gate | consent_required | consent_invalid | hosted_forbidden
   */
  export async function validateInstall(bundleId, { envVars, consentToken, forceInstall } = {})
  ```
  Task 5 and Task 6 both call this. The HTTP route maps `{status, error, extra}` to a response; the set runner maps `{code}` to a per-member skip/fail log line.

**Why a rewrite and not a move (R2-N-M2):** the current validation half is a chain of `res.status().json()` early returns; there is no `res` in a job context. Every branch below must keep its exact current semantics — this is where a consent or hardware-gate regression would hide, so each branch gets a test.

- [ ] **Step 1: Write the failing test**

```js
// tests/bundles-validate-install.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInstall } from "../servers/gateway/routes/bundles.js";

test("invalid bundle id → 400 invalid_id", async () => {
  const r = await validateInstall("../../etc/passwd");
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, "invalid_id");
});

test("unknown bundle → 404 not_found", async () => {
  const r = await validateInstall("definitely-not-a-real-bundle");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.code, "not_found");
});

test("privileged/consent bundle without a token → 403 consent_required", async () => {
  // 'caddy' declares consent_required: true in its on-disk manifest.
  const r = await validateInstall("caddy", {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, "consent_required");
});

test("a plain, non-consent, non-GPU bundle passes and returns its manifest + installed snapshot", async () => {
  const r = await validateInstall("uptime-kuma", { forceInstall: true });
  // forceInstall skips the hardware gate so this test is machine-independent.
  if (r.ok === false && r.code === "already_installed") return; // acceptable on a host where it's installed
  assert.equal(r.ok, true);
  assert.equal(r.manifest.id, "uptime-kuma");
  assert.ok(Array.isArray(r.installed));
  assert.equal(r.consentVerified, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bundles-validate-install.test.js`
Expected: FAIL — `validateInstall` is not exported.

- [ ] **Step 3: Extract the function**

In `servers/gateway/routes/bundles.js`, add (module scope, above `bundlesRouter`):

```js
/**
 * All install-time gates, as an outcome function.
 *
 * The single-install route maps the outcome to HTTP; the collection installer
 * maps it to a per-member skip/fail entry. Semantics are identical to the
 * pre-refactor inline chain (order matters: id → source → already-installed →
 * dependencies → hardware → GPU → consent → hosted).
 *
 * @returns {Promise<object>} { ok:true, manifest, installed, consentVerified, hardwareWarning? }
 *   or { ok:false, status, code, error, extra? }
 */
export async function validateInstall(bundleId, { envVars = {}, consentToken = null, forceInstall = false } = {}) {
  if (!bundleId || !isValidBundleId(bundleId)) {
    return { ok: false, status: 400, code: "invalid_id", error: "Invalid bundle ID" };
  }

  const sourceDir = join(APP_BUNDLES, bundleId);
  if (!existsSync(sourceDir)) {
    return { ok: false, status: 404, code: "not_found", error: `Bundle '${bundleId}' not found` };
  }

  const installed = getInstalled();
  if (installed.find((i) => i.id === bundleId)) {
    return { ok: false, status: 409, code: "already_installed", error: `Bundle '${bundleId}' is already installed` };
  }

  const manifest = getManifest(bundleId);

  const requiredBundles = manifest?.requires?.bundles || [];
  if (requiredBundles.length > 0) {
    const installedIds = new Set(installed.map((i) => i.id));
    const missing = requiredBundles.filter((id) => !installedIds.has(id));
    if (missing.length > 0) {
      return {
        ok: false, status: 400, code: "missing_dependencies",
        error: `Bundle '${bundleId}' requires the following bundles to be installed first: ${missing.join(", ")}`,
        extra: { missing_dependencies: missing },
      };
    }
  }

  // Advisory only — the phone enforces it client-side.
  if (manifest?.requires?.min_android_app) {
    console.log(`[bundles] ${bundleId} declares min_android_app=${manifest.requires.min_android_app} — enforced client-side on the Crow Android app`);
  }

  let hardwareWarning;
  if (!forceInstall) {
    const gate = checkHardwareGate({
      manifest,
      installed,
      manifestLookup: (id) => getManifest(id),
      dataDir: CROW_HOME,
    });
    if (!gate.allow) {
      return { ok: false, status: 400, code: "hardware_gate", error: gate.reason, extra: { hardware_gate: gate } };
    }
    if (gate.level === "warn") hardwareWarning = gate;
  }

  const gpuCheck = checkGpuArchCompatible(manifest);
  if (!gpuCheck.ok) {
    return { ok: false, status: 400, code: "gpu_arch_gate", error: gpuCheck.reason, extra: { gpu_arch_gate: gpuCheck } };
  }

  let consentVerified = false;
  if (manifestRequiresConsent(manifest)) {
    if (!consentToken) {
      return {
        ok: false, status: 403, code: "consent_required",
        error: "Consent token required. Call GET /bundles/api/consent-challenge/:id to obtain one.",
        extra: { consent_required: true },
      };
    }
    const consentDb = createDbClient();
    try {
      consentVerified = await validateConsentToken(consentDb, bundleId, consentToken);
    } finally {
      try { consentDb.close(); } catch {}
    }
    if (!consentVerified) {
      return {
        ok: false, status: 403, code: "consent_invalid",
        error: "Consent token is invalid, expired, or already consumed. Mint a new one and retry.",
        extra: { consent_expired: true },
      };
    }
  }

  return { ok: true, manifest, installed, consentVerified, ...(hardwareWarning ? { hardwareWarning } : {}) };
}
```

**IMPORTANT — preserve the remaining inline branches verbatim.** Read the current lines ~1083–1200 and confirm every early return in that range is represented above (including the `process.env.CROW_HOSTED` host-networking refusal — if it lives in the validation half, move it in as code `hosted_forbidden` with its exact status/message; if it lives inside the async body, leave it there). Then rewrite the route's validation half as:

```js
  router.post("/bundles/api/install", async (req, res) => {
    const { bundle_id, env_vars, consent_token } = req.body;

    const v = await validateInstall(bundle_id, {
      envVars: env_vars,
      consentToken: consent_token,
      forceInstall: !!req.body.force_install,
    });
    if (!v.ok) {
      return res.status(v.status).json({ error: v.error, ...(v.extra || {}) });
    }
    if (v.hardwareWarning) req._hardwareWarning = v.hardwareWarning;

    // ...existing job creation + async install body continues unchanged for now
    // (Task 5 extracts that body). The body may reference `installed` and
    // `consentVerified` — bind them from the outcome so behavior is identical:
    const installed = v.installed;
    const consentVerified = v.consentVerified;
    const manifestPre = v.manifest;
```

- [ ] **Step 4: Run the new test AND the existing bundle tests**

```bash
node --test tests/bundles-validate-install.test.js
node --test tests/bundle-contract.test.js tests/bundle-version-refresh.test.js tests/calibre-web-bundle.test.js
```
Expected: all PASS. (The install route must behave exactly as before — same statuses, same JSON keys.)

- [ ] **Step 5: Mutation check (guard is real)**

Temporarily change the consent branch to `if (false && manifestRequiresConsent(manifest))`, run `node --test tests/bundles-validate-install.test.js` → the consent test must FAIL (red). Restore the line, re-run → PASS. Record red-then-restored in the task report.

- [ ] **Step 6: Commit**

```bash
git add tests/bundles-validate-install.test.js
git commit servers/gateway/routes/bundles.js tests/bundles-validate-install.test.js \
  -m "refactor(bundles): install gates become validateInstall() — an outcome function the route and (next) the collection installer both consume"
git show --stat HEAD
```

---

### Task 5: `runInstallJob()` + job-TTL rearm (D6.4a, D6.7)

**Files:**
- Modify: `servers/gateway/routes/bundles.js` (extract the async install body ~1202–1663 into `runInstallJob`; move the eviction timer from `createJob` to `finishJob`)
- Test: `tests/bundles-install-job.test.js` (create)

**Interfaces:**
- Consumes: `validateInstall` (Task 4).
- Produces:
  ```js
  /**
   * Run one bundle install against an existing job.
   * NEVER calls finishJob() or scheduleGatewayRestart() when deferRestart is true —
   * the caller owns the job's lifecycle (the collection installer shares ONE job
   * across N members).
   * @returns {Promise<{ ok: true, needsRestart: boolean } | { ok: false, reason: string }>}
   */
  export async function runInstallJob(bundleId, envVars, { job, installedSnapshot, consentVerified, manifest, deferRestart = false })
  ```

**The trap this task exists to avoid (R2-N-M2):** the current async body ends with `finishJob(job, needsRestart ? "complete_restart" : "complete")` and `scheduleGatewayRestart(3000)`, and bails with `finishJob(job, "failed"); return;` on failure. Moved verbatim into a set runner, member 1 would finish the shared job, member 1's failure would abort the whole set (killing continue-on-error), and each restart-needing member would exit the process mid-set. `runInstallJob` must therefore RETURN outcomes instead of finishing/restarting when `deferRestart` is set. It also closes over `installed` (line ~1097) and `consentVerified` (~1164) today — both are now parameters.

- [ ] **Step 1: Write the failing test**

```js
// tests/bundles-install-job.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInstallJob, _createJobForTest, _getJobForTest, _finishJobForTest } from "../servers/gateway/routes/bundles.js";

test("runInstallJob is exported with the outcome-returning signature", () => {
  assert.equal(typeof runInstallJob, "function");
});

test("a failed install returns { ok:false, reason } and does NOT finish the shared job", async () => {
  const job = _createJobForTest("no-such-bundle", "install");
  const out = await runInstallJob("no-such-bundle", {}, {
    job,
    installedSnapshot: [],
    consentVerified: false,
    manifest: null,
    deferRestart: true,
  });
  assert.equal(out.ok, false);
  assert.ok(out.reason, "failure must carry a reason for the set summary");
  assert.equal(_getJobForTest(job.id).status, "running", "deferRestart:true means the CALLER owns finishJob — the set job must still be running");
});

test("jobs are evicted only after they FINISH (a long-running job is never deleted mid-flight)", async () => {
  const job = _createJobForTest("ttl-probe", "install");
  assert.ok(_getJobForTest(job.id), "job exists while running");
  // The eviction timer must be armed in finishJob, not createJob. We assert the
  // structural property: a running job has no eviction timer handle.
  assert.equal(job._evictTimer, undefined, "createJob must NOT arm an eviction timer (a multi-GB set install outlives it and the client's poll 404s mid-install)");
  _finishJobForTest(job, "complete");
  assert.ok(job._evictTimer, "finishJob must arm the eviction timer");
  clearTimeout(job._evictTimer); // don't leave a handle open in the test process
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bundles-install-job.test.js`
Expected: FAIL — exports missing.

- [ ] **Step 3: Rearm the TTL**

```js
function createJob(bundleId, action) {
  const id = String(++jobCounter);
  const job = {
    id, bundleId, action,
    status: "running",
    log: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.set(id, job);
  // NOTE: eviction is armed in finishJob(), NOT here. A collection install can
  // run for tens of minutes (multi-GB image pulls); a creation-time timer would
  // delete the job mid-flight, the client's poll would 404, and its catch-path
  // would mistake that for a gateway restart (spurious reload + lost summary).
  return job;
}

const JOB_TTL_MS = 600_000;

function finishJob(job, status) {
  job.status = status;
  job.completedAt = new Date().toISOString();
  // Evict N minutes after the job ENDS — never while it runs.
  job._evictTimer = setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
  if (typeof job._evictTimer.unref === "function") job._evictTimer.unref();
  emitJobChanged(job);
}
```

Add the test seams next to them:

```js
/** Test-only seams (jobs are in-process; tests need to create/inspect/finish one). */
export function _createJobForTest(bundleId, action) { return createJob(bundleId, action); }
export function _getJobForTest(id) { return jobs.get(id); }
export function _finishJobForTest(job, status) { return finishJob(job, status); }
```

- [ ] **Step 4: Extract the async body**

Move the async install IIFE body (currently ~1202–1663) into:

```js
/**
 * Run one bundle install against an existing job.
 *
 * Outcome-returning by design: the collection installer shares ONE job across N
 * members, so this function must not decide the job's fate. With deferRestart:true
 * it never calls finishJob() and never calls scheduleGatewayRestart() — it reports
 * `needsRestart` and the caller does exactly one restart at the end.
 *
 * @param {object} opts
 * @param {object} opts.job              the job to append logs to
 * @param {Array}  opts.installedSnapshot  getInstalled() as of validation (the body pushes onto it)
 * @param {boolean} opts.consentVerified  from validateInstall — gates validateComposeFile
 * @param {object} opts.manifest          the on-disk manifest
 * @param {boolean} opts.deferRestart     true → return needsRestart instead of restarting
 * @returns {Promise<{ok:true, needsRestart:boolean}|{ok:false, reason:string}>}
 */
export async function runInstallJob(bundleId, envVars, { job, installedSnapshot, consentVerified, manifest, deferRestart = false }) {
  let needsRestart = false;
  try {
    // ── VERBATIM: the existing install body from `const destDir = ...` through the
    //    npm-install / compose-up / panel-copy / MCP-registration / skill-copy /
    //    AI-provider-config / saveInstalled sequence. Substitutions ONLY:
    //      bundle_id      → bundleId
    //      env_vars       → envVars
    //      installed      → installedSnapshot
    //      manifestPre    → manifest
    //      consentVerified stays (now a parameter)
    //    Every `finishJob(job, "failed"); return;` becomes:
    //      appendLog(job, `<existing message>`); return { ok: false, reason: "<existing message>" };
    //    The trailing finishJob/scheduleGatewayRestart block is REMOVED (see below).
    // ──

    return { ok: true, needsRestart };
  } catch (err) {
    const reason = err?.message || String(err);
    appendLog(job, `Install failed: ${reason}`);
    return { ok: false, reason };
  }
}
```

The single-install route keeps its old semantics by owning the lifecycle:

```js
    const job = createJob(bundle_id, "install");
    res.json({ job_id: job.id });

    (async () => {
      const out = await runInstallJob(bundle_id, env_vars, {
        job,
        installedSnapshot: v.installed,
        consentVerified: v.consentVerified,
        manifest: v.manifest,
        deferRestart: false,
      });
      if (!out.ok) {
        finishJob(job, "failed");
        return;
      }
      finishJob(job, out.needsRestart ? "complete_restart" : "complete");
      if (out.needsRestart) {
        appendLog(job, "Scheduling gateway restart to load new panels/servers...");
        scheduleGatewayRestart(3000);
      }
    })();
```

(Keep `deferRestart` out of the single-install path's decision — the route restarts because `out.needsRestart` is true, exactly as before.)

- [ ] **Step 5: Run the tests**

```bash
node --test tests/bundles-install-job.test.js tests/bundles-validate-install.test.js
node --test tests/bundle-contract.test.js tests/bundle-version-refresh.test.js
```
Expected: PASS. Behavior of `POST /bundles/api/install` must be unchanged.

- [ ] **Step 6: Mutation check**

Temporarily arm the eviction timer in `createJob` again (add `setTimeout(() => jobs.delete(id), 600_000)`) → the TTL test must FAIL red. Restore → PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/bundles-install-job.test.js
git commit servers/gateway/routes/bundles.js tests/bundles-install-job.test.js \
  -m "refactor(bundles): runInstallJob() returns per-member outcomes; job eviction arms at finish, not creation (a long install no longer deletes its own job mid-flight)"
git show --stat HEAD
```

---

### Task 6: Install-lock module + auto-update inhibition (D6.9, D6.10)

**Files:**
- Create: `servers/gateway/install-lock.js`
- Modify: `servers/gateway/auto-update.js:71-78` (`tickCheck`)
- Test: `tests/install-lock.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function beginInstallSet(collectionId): void` (throws if already busy)
  - `export function endInstallSet(): void`
  - `export function isInstallSetRunning(): boolean` — false once the 2h max-age lapses (backstop against a leaked flag)
  - `export function _resetForTest(): void`

`auto-update.js` imports `isInstallSetRunning` so a scheduled tick can't `exit(1)` mid-collection-install (killing the runner and losing the summary). Manual Check-now stays ungated (operator intent — the #163 precedent).

- [ ] **Step 1: Write the failing test**

```js
// tests/install-lock.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { beginInstallSet, endInstallSet, isInstallSetRunning, _resetForTest } from "../servers/gateway/install-lock.js";
import { tickCheck } from "../servers/gateway/auto-update.js";

test("begin → running; end → not running", () => {
  _resetForTest();
  assert.equal(isInstallSetRunning(), false);
  beginInstallSet("home-server");
  assert.equal(isInstallSetRunning(), true);
  endInstallSet();
  assert.equal(isInstallSetRunning(), false);
});

test("a second begin while busy throws (the route turns this into a 409)", () => {
  _resetForTest();
  beginInstallSet("home-server");
  assert.throws(() => beginInstallSet("research"), /in progress/i);
  endInstallSet();
});

test("a leaked lock expires after the max-age backstop", () => {
  _resetForTest();
  beginInstallSet("home-server", { startedAt: Date.now() - 3 * 60 * 60 * 1000 }); // 3h ago
  assert.equal(isInstallSetRunning(), false, "a 3h-old lock must not wedge installs forever");
  _resetForTest();
});

test("the auto-update tick skips while a collection install is running", async () => {
  _resetForTest();
  beginInstallSet("home-server");
  let checked = false;
  const result = await tickCheck(async () => { checked = true; return { updated: true }; });
  assert.equal(checked, false, "auto-update must not pull+restart mid-collection-install");
  assert.equal(result, null);
  endInstallSet();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install-lock.test.js`
Expected: FAIL — cannot find module `install-lock.js`.

- [ ] **Step 3: Write the module**

```js
// servers/gateway/install-lock.js
/**
 * Collection-install busy flag.
 *
 * A collection install runs N bundle installs against ONE shared job and ends
 * with ONE deferred gateway restart. Two things would kill it mid-flight:
 *   1. a concurrent single install/uninstall finishing with its own immediate
 *      restart (process exit), and
 *   2. the auto-update tick, which lives in this same process and exits to
 *      trigger a supervised restart.
 * Both consult this flag. It is in-process state (it cannot outlive the gateway,
 * and the set's own restart resets it), with a max-age backstop so a leaked flag
 * can never wedge installs permanently.
 *
 * Co-hosted gateways MUST use distinct CROW_HOME (crow's MPA unit already does):
 * this flag does not coordinate across processes, and two gateways sharing one
 * ~/.crow would race on installed.json regardless.
 */

const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h backstop

let state = null; // { collectionId, startedAt }

/** @throws {Error} if a set is already running */
export function beginInstallSet(collectionId, { startedAt = Date.now() } = {}) {
  if (isInstallSetRunning()) {
    throw new Error(`A collection install is already in progress (${state.collectionId})`);
  }
  state = { collectionId, startedAt };
}

export function endInstallSet() {
  state = null;
}

/** True while a collection install is running (and younger than the backstop). */
export function isInstallSetRunning() {
  if (!state) return false;
  if (Date.now() - state.startedAt > MAX_AGE_MS) {
    state = null;
    return false;
  }
  return true;
}

/** Test-only. */
export function _resetForTest() {
  state = null;
}
```

- [ ] **Step 4: Inhibit the auto-update tick**

In `servers/gateway/auto-update.js`, add the import and the gate:

```js
import { isInstallSetRunning } from "./install-lock.js";

export async function tickCheck(check = checkForUpdates) {
  // A collection install runs N installs against one job and ends in a single
  // deferred restart. An auto-update pull+exit here would kill that runner
  // mid-flight (partial collection, lost summary). Manual Check-now stays
  // ungated — that's explicit operator intent.
  if (isInstallSetRunning()) {
    console.log("[auto-update] Skipping scheduled check — a collection install is in progress");
    return null;
  }
  const settings = await getSettings();
  if (settings.auto_update_enabled !== "true") {
    console.log("[auto-update] Skipping scheduled check — disabled in settings");
    return null;
  }
  return check();
}
```

- [ ] **Step 5: Run the tests**

```bash
node --test tests/install-lock.test.js
node --test tests/auto-update.test.js   # if present — the tick-gate tests must still pass
```
Expected: PASS.

- [ ] **Step 6: Mutation check**

Delete the `isInstallSetRunning()` gate from `tickCheck` → the auto-update test in `tests/install-lock.test.js` must FAIL red. Restore → PASS.

- [ ] **Step 7: Commit**

```bash
git add servers/gateway/install-lock.js tests/install-lock.test.js
git commit servers/gateway/install-lock.js servers/gateway/auto-update.js tests/install-lock.test.js \
  -m "feat(bundles): collection-install busy flag + auto-update tick inhibition (a scheduled pull can no longer kill a running collection install)"
git show --stat HEAD
```

---

### Task 7: `POST /bundles/api/install-set` (D6)

**Files:**
- Modify: `servers/gateway/routes/bundles.js` (new route + set runner)
- Test: `tests/bundles-install-set.test.js` (create)

**Interfaces:**
- Consumes: `getCollection` (Task 3), `validateInstall` + `runInstallJob` (Tasks 4–5), `beginInstallSet`/`endInstallSet`/`isInstallSetRunning` (Task 6), existing `createJob`/`appendLog`/`finishJob`/`scheduleGatewayRestart`/`getManifest`/`jobs`.
- Produces:
  - `POST /bundles/api/install-set` body `{ collection_id }` → `{ job_id, plan }` or an error status.
  - `export function planInstallSet(collection): Array<{id, action, reason?}>` — the display plan (`action ∈ {"install","skip"}`).
  - `export function validateCollectionServerSide(collection): { ok:true } | { ok:false, error:string }` — re-validates membership against ON-DISK manifests (a tampered collections file must not smuggle a privileged/consent/host-net member past the gate).
  - Job summary lines the client parses: `SUMMARY member <id> <installed|skipped|failed> <reason?>` and `NEEDS_CONFIG <id> <KEY1,KEY2>`.

- [ ] **Step 1: Write the failing test**

```js
// tests/bundles-install-set.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { planInstallSet, validateCollectionServerSide, needsConfigKeys } from "../servers/gateway/routes/bundles.js";
import { getCollection } from "../servers/gateway/dashboard/panels/extensions/collections.js";

test("server-side re-validation accepts the shipped collections", () => {
  for (const id of ["home-server", "education", "research", "development"]) {
    const r = validateCollectionServerSide(getCollection(id));
    assert.equal(r.ok, true, `${id}: ${r.error}`);
  }
});

test("server-side re-validation REFUSES a tampered collection carrying a consent-required member", () => {
  // 'caddy' has consent_required: true on disk. A tampered collections.json must not smuggle it in.
  const tampered = { id: "evil", name: "Evil", description: "", icon: "home", members: [{ id: "caddy", kind: "deploys" }] };
  const r = validateCollectionServerSide(tampered);
  assert.equal(r.ok, false);
  assert.match(r.error, /consent|privileged/i);
});

test("server-side re-validation REFUSES a member that isn't on disk", () => {
  const bogus = { id: "x", name: "X", description: "", icon: "home", members: [{ id: "not-a-bundle", kind: "deploys" }] };
  assert.equal(validateCollectionServerSide(bogus).ok, false);
});

test("the display plan marks already-installed members as skipped", () => {
  const plan = planInstallSet({
    id: "t", members: [{ id: "uptime-kuma", kind: "deploys" }, { id: "definitely-not-installed-xyz", kind: "deploys" }],
  });
  assert.equal(plan.length, 2);
  for (const p of plan) assert.ok(["install", "skip"].includes(p.action));
  const bad = plan.find((p) => p.id === "definitely-not-installed-xyz");
  assert.equal(bad.action, "skip");
  assert.match(bad.reason, /not found/i);
});

test("needsConfigKeys reports manifest-required keys that are EMPTY in the written .env, and nothing else", () => {
  // Keys satisfied by .env.example defaults (DB passwords, secret keys) are already
  // configured — flagging them would invite a post-init change that breaks the app.
  const keys = needsConfigKeys("jellyfin", {
    JELLYFIN_URL: "http://localhost:8096",
    JELLYFIN_API_KEY: "",
  });
  assert.deepEqual(keys, ["JELLYFIN_API_KEY"]);
  assert.deepEqual(needsConfigKeys("jellyfin", { JELLYFIN_URL: "http://x", JELLYFIN_API_KEY: "abc" }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bundles-install-set.test.js`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

Add to `servers/gateway/routes/bundles.js`:

```js
import { getCollection } from "../dashboard/panels/extensions/collections.js";
import { beginInstallSet, endInstallSet, isInstallSetRunning } from "../install-lock.js";

/**
 * Re-validate a collection's membership against the ON-DISK manifests.
 * registry/collections.json is data, not a trust boundary: this is the gate that
 * stops a tampered file from one-click-installing a privileged, consent-required,
 * or host-networking bundle without the consent ceremony.
 */
export function validateCollectionServerSide(collection) {
  if (!collection || !Array.isArray(collection.members) || collection.members.length === 0) {
    return { ok: false, error: "Collection has no members" };
  }
  const seen = new Set();
  for (const m of collection.members) {
    if (!m?.id || !isValidBundleId(m.id)) return { ok: false, error: `Invalid member id '${m?.id}'` };
    if (!existsSync(join(APP_BUNDLES, m.id))) return { ok: false, error: `Member '${m.id}' is not a known bundle` };
    const man = getManifest(m.id);
    if (man?.privileged === true || man?.consent_required === true) {
      return { ok: false, error: `Member '${m.id}' requires explicit consent — install it individually` };
    }
    if (man?.requires?.gpu || man?.requires?.min_vram_gb) {
      return { ok: false, error: `Member '${m.id}' is GPU-gated — install it individually` };
    }
    for (const dep of man?.requires?.bundles || []) {
      if (!seen.has(dep) && !getInstalled().some((i) => i.id === dep)) {
        return { ok: false, error: `Member '${m.id}' requires '${dep}', which is neither installed nor earlier in the collection` };
      }
    }
    seen.add(m.id);
  }
  return { ok: true };
}

/** Display plan (what the user is told will happen). Execution re-checks every gate live. */
export function planInstallSet(collection) {
  const installedIds = new Set(getInstalled().map((i) => i.id));
  return collection.members.map((m) => {
    if (installedIds.has(m.id)) return { id: m.id, action: "skip", reason: "already installed" };
    if (!existsSync(join(APP_BUNDLES, m.id))) return { id: m.id, action: "skip", reason: "not found in this Crow's bundle set" };
    const gpu = checkGpuArchCompatible(getManifest(m.id));
    if (!gpu.ok) return { id: m.id, action: "skip", reason: gpu.reason || "incompatible with this host's GPU" };
    return { id: m.id, action: "install" };
  });
}

/**
 * Manifest-required env keys that are still EMPTY in the bundle's written .env.
 * Keys with a value (including .env.example defaults — DB passwords, secret keys)
 * count as configured and are NEVER surfaced: those are consumed at first container
 * boot, and changing them afterwards breaks the app or strands its data.
 * @param {object} [envOverride] test seam — the parsed .env
 */
export function needsConfigKeys(bundleId, envOverride = null) {
  const man = getManifest(bundleId);
  const required = (man?.env_vars || []).filter((v) => v.required).map((v) => v.name);
  if (required.length === 0) return [];
  let env = envOverride;
  if (!env) {
    env = {};
    const envPath = join(BUNDLES_DIR, bundleId, ".env");
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) env[m[1]] = m[2];
      }
    }
  }
  return required.filter((k) => !env[k] || env[k].trim() === "");
}
```

And the route (register it next to `/bundles/api/install`):

```js
  // POST /bundles/api/install-set — install a themed collection in one click.
  // ONE job for the whole set (the client polls it like any install), members run
  // sequentially in the collection's topological order, a member failure does NOT
  // abort the set, and exactly ONE gateway restart happens at the end.
  router.post("/bundles/api/install-set", async (req, res) => {
    const { collection_id } = req.body || {};

    const collection = getCollection(collection_id);
    if (!collection) return res.status(404).json({ error: `Unknown collection '${collection_id}'` });

    const v = validateCollectionServerSide(collection);
    if (!v.ok) return res.status(400).json({ error: v.error });

    // Refuse to start while ANY install/uninstall job is running: a single install
    // finishing mid-set fires its own immediate restart and would kill this runner.
    // Predicate is status === "running" — finished jobs linger in the Map for their
    // TTL, so a presence check would 409 every set for 10 minutes after any install.
    const busy = [...jobs.values()].some(
      (j) => j.status === "running" && (j.action === "install" || j.action === "uninstall" || j.action === "install-set"),
    );
    if (busy || isInstallSetRunning()) {
      return res.status(409).json({ error: "Another install is in progress — wait for it to finish and try again." });
    }

    const plan = planInstallSet(collection);
    const job = createJob(collection.id, "install-set");
    try {
      beginInstallSet(collection.id);
    } catch {
      finishJob(job, "failed");
      return res.status(409).json({ error: "A collection install is already in progress." });
    }

    res.json({ job_id: job.id, plan });

    (async () => {
      let anyRestart = false;
      const needsConfig = [];
      try {
        appendLog(job, `Installing collection '${collection.name}' (${plan.filter((p) => p.action === "install").length} to install, ${plan.filter((p) => p.action === "skip").length} skipped)`);

        for (const member of collection.members) {
          // Live gate re-check: getInstalled() has grown as earlier members landed,
          // so cumulative RAM commitments and intra-set dependencies are enforced for
          // real — not against a stale pre-set snapshot.
          const mv = await validateInstall(member.id, {});
          if (!mv.ok) {
            appendLog(job, `SUMMARY member ${member.id} skipped ${mv.error}`);
            continue;
          }
          appendLog(job, `Installing ${member.id}...`);
          const out = await runInstallJob(member.id, {}, {
            job,
            installedSnapshot: mv.installed,
            consentVerified: mv.consentVerified,
            manifest: mv.manifest,
            deferRestart: true,
          });
          if (!out.ok) {
            appendLog(job, `SUMMARY member ${member.id} failed ${out.reason}`);
            continue; // continue-on-error: one bad member must not sink the collection
          }
          if (out.needsRestart) anyRestart = true;
          const keys = needsConfigKeys(member.id);
          if (keys.length > 0) needsConfig.push({ id: member.id, keys });
          appendLog(job, `SUMMARY member ${member.id} installed`);
        }

        for (const nc of needsConfig) appendLog(job, `NEEDS_CONFIG ${nc.id} ${nc.keys.join(",")}`);
        appendLog(job, "Collection install complete");
        finishJob(job, anyRestart ? "complete_restart" : "complete");
        if (anyRestart) scheduleGatewayRestart(3000);
      } catch (err) {
        appendLog(job, `Collection install failed: ${err?.message || err}`);
        finishJob(job, "failed");
      } finally {
        endInstallSet();
      }
    })();
  });
```

- [ ] **Step 4: Run the tests**

```bash
node --test tests/bundles-install-set.test.js tests/bundles-validate-install.test.js tests/bundles-install-job.test.js tests/install-lock.test.js
```
Expected: PASS.

- [ ] **Step 5: Mutation checks (three guards)**

1. Make `validateCollectionServerSide` return `{ ok: true }` unconditionally → the tampered-consent test FAILS red. Restore.
2. Change the member loop's `continue` on failure to `throw` → add/observe that continue-on-error coverage fails (Task 12's integration test covers this end-to-end; here, assert via a unit test if you added one). Restore.
3. Change the busy predicate to `jobs.size > 0` → confirm the behavior is wrong by reasoning + note it; restore. (The status-predicate is asserted end-to-end in Task 12.)

Record each red-then-restored in the task report.

- [ ] **Step 6: Commit**

```bash
git add tests/bundles-install-set.test.js
git commit servers/gateway/routes/bundles.js tests/bundles-install-set.test.js \
  -m "feat(bundles): POST /install-set — one-click collection install (one shared job, per-member live gates, continue-on-error, one deferred restart, server-side membership re-validation)"
git show --stat HEAD
```

---

### Task 8: Router-wide `xhostVerify` — close the signed-header auth bypass (D6.8 / R2-N-M1)

**Files:**
- Modify: `servers/gateway/routes/bundles.js` (move the `xhostVerify` construction above the route definitions; `router.use(xhostVerify)` once)
- Test: `tests/bundles-auth-bypass.test.js` (create)

**Interfaces:**
- Consumes: existing `crossHostVerifyMiddleware(db, { optional: true })`.
- Produces: every bundles route (present and future) verifies an HMAC when `x-crow-signature` is present.

**The hole:** `dashboard/index.js:596-607` routes ANY request carrying an `x-crow-signature` header straight to `bundlesRouter`, before `dashboardAuth` and `csrfMiddleware`. Only `start`/`stop` verify the signature today, so a request with a **bogus** header reaches `install`, `uninstall`, **`restart`** (→ `scheduleGatewayRestart` → unauthenticated restart/DoS) and **`env`** (→ arbitrary secret writes into any bundle's `.env`) with no session, no CSRF, and no valid HMAC. Denylist-by-omission is the bug; mount once at the router root.

Why this is safe for the dashboard: `crossHostVerifyMiddleware(..., { optional: true })` calls `next()` when the header is absent, and unsigned requests only ever arrive through the normal, `dashboardAuth`+CSRF-protected mount.

- [ ] **Step 1: Write the failing test**

```js
// tests/bundles-auth-bypass.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import bundlesRouter from "../servers/gateway/routes/bundles.js";

/** Boot the bundles router alone (as the signed-header bypass reaches it) on an ephemeral port. */
async function withRouter(fn) {
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const SIGNED = { "content-type": "application/json", "x-crow-signature": "bogus-not-a-real-hmac" };

test("a bogus x-crow-signature is rejected on every state-changing bundles route", async () => {
  await withRouter(async (base) => {
    for (const path of [
      "/bundles/api/install",
      "/bundles/api/uninstall",
      "/bundles/api/install-set",
      "/bundles/api/restart",     // unauthenticated gateway restart / DoS if unguarded
      "/bundles/api/env",         // unauthenticated secret write if unguarded
    ]) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: SIGNED,
        body: JSON.stringify({ bundle_id: "uptime-kuma", collection_id: "home-server", env_vars: { PWNED: "1" } }),
      });
      assert.ok(
        res.status === 401 || res.status === 403,
        `${path} accepted a bogus signature (status ${res.status}) — the x-crow-signature bypass is open`,
      );
    }
  });
});

test("unsigned requests fall through (the dashboard path still works — optional:true)", async () => {
  await withRouter(async (base) => {
    // No signature header → middleware calls next(); the route's own validation answers.
    const res = await fetch(base + "/bundles/api/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: "../etc/passwd" }),
    });
    assert.equal(res.status, 400, "unsigned requests must reach the route (400 invalid id), not be blocked by xhostVerify");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bundles-auth-bypass.test.js`
Expected: FAIL — `/bundles/api/restart` and `/bundles/api/env` return 200 with a bogus signature.

- [ ] **Step 3: Mount router-wide**

In `bundlesRouter()`, move the `dbForXhost` + `xhostVerify` construction (currently ~1876) to the TOP of the factory, immediately after `const router = Router();`, and mount it before any route:

```js
export default function bundlesRouter() {
  const router = Router();

  // Cross-host verification. dashboard/index.js routes ANY request bearing an
  // x-crow-signature header straight here, BEFORE dashboardAuth and CSRF — so a
  // bogus header would otherwise reach install/uninstall/restart/env with no auth
  // at all. Mount router-wide (not per-route): denylist-by-omission is how
  // /restart (unauthenticated gateway DoS) and /env (unauthenticated secret write)
  // stayed exposed. optional:true ⇒ unsigned requests fall through to the normal
  // dashboardAuth+CSRF mount, so the dashboard path is unaffected.
  const dbForXhost = createDbClient();
  const xhostVerify = crossHostVerifyMiddleware(dbForXhost, {
    optional: true,
    audit: (req) => `bundle.${(req.path.split("/").pop() || "")}`,
    auditBundleId: true,
  });
  router.use(xhostVerify);

  // ... routes follow (start/stop drop their now-redundant per-route xhostVerify arg)
```

Remove the duplicate construction at ~1876 and the per-route `xhostVerify` arguments on `start`/`stop` (they inherit it now). Keep `dbForXhost` available to `dispatchBundleAction` (it uses it for audit).

- [ ] **Step 4: Run the tests**

```bash
node --test tests/bundles-auth-bypass.test.js
node --test tests/bundles-install-set.test.js tests/bundle-contract.test.js
```
Expected: PASS.

- [ ] **Step 5: Mutation check**

Comment out `router.use(xhostVerify)` → the bypass test FAILS red on `/restart` and `/env`. Restore → PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/bundles-auth-bypass.test.js
git commit servers/gateway/routes/bundles.js tests/bundles-auth-bypass.test.js \
  -m "fix(bundles): verify cross-host signatures router-wide — a bogus x-crow-signature no longer reaches install/uninstall/restart/env unauthenticated"
git show --stat HEAD
```

---

### Task 9: `/bundles/api/env` also configures MCP servers (D7 / R2-N-M3)

**Files:**
- Modify: `servers/gateway/routes/bundles.js:1985-2019` (the `env` route)
- Test: `tests/bundles-env-mcp-config.test.js` (create)

**Interfaces:**
- Consumes: existing `readJsonSafe`/`writeJsonSafe`, `MCP_ADDONS_PATH`, `getManifest`.
- Produces: `POST /bundles/api/env` response gains `needs_restart: boolean`; `mcp-addons.json[<id>].env` is updated for add-ons that register an MCP server.
- Also produces `export function applyEnvToMcpAddons(bundleId, envVars, path?): boolean` (true when it wrote).

**The bug this closes:** MCP children are spawned with `{ ...process.env, ...(config.env||{}) }` from `mcp-addons.json` (`proxy.js:145`), whose `env` block is populated ONLY at install time. `POST /bundles/api/env` writes `bundles/<id>/.env`, which the MCP child never reads. So a user who installs the Home Server collection and then dutifully sets `HA_URL`/`HA_TOKEN` from the post-install checklist leaves home-assistant dead. Collections would mass-produce this pre-existing bug; fixing it here benefits every MCP add-on.

- [ ] **Step 1: Write the failing test**

```js
// tests/bundles-env-mcp-config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnvToMcpAddons } from "../servers/gateway/routes/bundles.js";

test("configuring an mcp-server add-on's env updates mcp-addons.json (the file the MCP child actually reads)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({
    "home-assistant": { command: "node", args: ["server/index.js"], env: { HA_URL: "" } },
  }));

  const wrote = applyEnvToMcpAddons("home-assistant", { HA_URL: "http://homeassistant.local:8123", HA_TOKEN: "tok" }, path);
  assert.equal(wrote, true);

  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after["home-assistant"].env.HA_URL, "http://homeassistant.local:8123");
  assert.equal(after["home-assistant"].env.HA_TOKEN, "tok");
  assert.equal(after["home-assistant"].command, "node", "existing config fields survive");
});

test("an add-on with no MCP server registration is a no-op (returns false)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmcp-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({}));
  assert.equal(applyEnvToMcpAddons("jellyfin", { JELLYFIN_API_KEY: "x" }, path), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bundles-env-mcp-config.test.js`
Expected: FAIL — `applyEnvToMcpAddons` is not exported.

- [ ] **Step 3: Implement**

```js
/**
 * Push env values into the add-on's mcp-addons.json entry.
 *
 * MCP children are spawned with { ...process.env, ...(config.env||{}) } from
 * mcp-addons.json (proxy.js) — they never read bundles/<id>/.env. Before this,
 * mcp-addons env was only ever written at install time, so post-install
 * configuration silently did nothing (home-assistant would stay dead no matter
 * how carefully you filled in HA_URL/HA_TOKEN).
 *
 * @returns {boolean} true if the add-on registers an MCP server and the file was written
 */
export function applyEnvToMcpAddons(bundleId, envVars, path = MCP_ADDONS_PATH) {
  const mcpAddons = readJsonSafe(path, {});
  const entry = mcpAddons[bundleId];
  if (!entry) return false; // not an MCP add-on — nothing to configure
  entry.env = { ...(entry.env || {}), ...envVars };
  mcpAddons[bundleId] = entry;
  writeJsonSafe(path, mcpAddons);
  return true;
}
```

At the end of the `env` route, replacing its final `res.json(...)`:

```js
    writeFileSync(envPath, envContent);

    // Also configure the MCP child, which reads mcp-addons.json — not this .env.
    const mcpUpdated = applyEnvToMcpAddons(bundle_id, env_vars);

    res.json({
      ok: true,
      message: mcpUpdated
        ? "Environment variables saved — restart the gateway to apply them to the MCP server"
        : "Environment variables saved",
      needs_restart: mcpUpdated,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bundles-env-mcp-config.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/bundles-env-mcp-config.test.js
git commit servers/gateway/routes/bundles.js tests/bundles-env-mcp-config.test.js \
  -m "fix(bundles): post-install env config now reaches MCP servers (mcp-addons.json), not just an .env the child never reads"
git show --stat HEAD
```

---

### Task 10: Store IA + visual makeover — server render (D2, D3, D4, D8)

**Files:**
- Modify: `servers/gateway/dashboard/panels/extensions/html.js` (rewrite `buildExtensionsHTML`)
- Modify: `servers/gateway/dashboard/panels/extensions/css.js`
- Modify: `servers/gateway/dashboard/panels/extensions/data-queries.js` (`fetchRegistryData` also returns `collections`)
- Modify: `servers/gateway/dashboard/panels/extensions.js` (orchestrator: pass the new fragments)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (new `extensions.*` keys, en + es)
- Modify: `registry/add-ons.json` (add `"featured": true` to the curated six)
- Test: `tests/extensions-page-render.test.js` (create)

**REQUIRED SUB-SKILL for this task: `frontend-design`.** Invoke it before writing CSS. Keep Crow's identity (Fraunces / DM Sans / JetBrains Mono, `--crow-*` tokens, existing category colors, `.theme-glass` overrides, subtle `fadeInUp`); express the hierarchy — collections > featured > grid — through scale, weight and accent, not new colors. Every new surface gets its `.theme-glass` companion rule.

**Interfaces:**
- Consumes: `groupAddons`/`DISPLAY_GROUPS` (Task 2), `loadCollections` (Task 3).
- Produces: `buildExtensionsHTML({ installed, available, collections, registrySource, communityStores, bundleStatus, lang })` → `{ viewsHtml, addonRegistryScript, collectionsScript }` (the orchestrator composes them). The client (Task 11) relies on these DOM contracts:
  - `#ext-view-browse`, `#ext-view-installed` (view containers), `.ext-viewtab[data-view]` (segmented control)
  - `#ext-collections` section, `.ext-collection-card[data-collection-id]`
  - `#ext-featured` section
  - `.ext-group-section[data-group]`, `.ext-group-chip[data-group]`, `.ext-group-more[data-group]` (Show-all button)
  - `.addon-card[data-addon-id][data-addon-group][data-addon-name][data-addon-desc][data-addon-tags]`
  - `#ext-search`, `#addon-registry` (JSON), `#collection-registry` (JSON)

Curated `featured` set (add `"featured": true` to these six registry entries): `companion`, `knowledge-base`, `home-assistant`, `jellyfin`, `paperless`, `searxng`.

Structure to render (all vertical; NOTHING horizontally scrollable):

```
[ segmented control: Browse | Installed (N) ]
── Browse ─────────────────────────────────
  search
  §Starter collections   → wrapping row of .ext-collection-card
  §Featured              → grid of .addon-card (featured entries)
  [ group chips (wrapping) ]
  §<Group>  (×7)         → grid of .addon-card, first 8 shown, "Show all (N)"
── Installed ──────────────────────────────
  installed items (always expanded: icon, name, status badge, start/stop/restart, remove)
  community stores (existing form)
  help card
```

- [ ] **Step 1: Write the failing test**

```js
// tests/extensions-page-render.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { loadCollections } from "../servers/gateway/dashboard/panels/extensions/collections.js";

const AVAILABLE = [
  { id: "jellyfin", name: "Jellyfin", description: "Media server", type: "bundle", category: "media", version: "1.0.0", author: "Crow", featured: true, tags: ["media"] },
  { id: "searxng", name: "SearXNG", description: "Private search", type: "bundle", category: "infrastructure", version: "1.0.0", author: "Crow", featured: true, tags: [] },
  { id: "kolibri", name: "Kolibri", description: "Learning platform", type: "bundle", category: "education", version: "1.0.0", author: "Crow", tags: [] },
];

function render(overrides = {}) {
  return buildExtensionsHTML({
    installed: {},
    available: AVAILABLE,
    collections: loadCollections(),
    registrySource: "local",
    communityStores: [],
    bundleStatus: {},
    lang: "en",
    ...overrides,
  });
}

test("renders both views and the segmented control", () => {
  const { viewsHtml } = render();
  assert.match(viewsHtml, /id="ext-view-browse"/);
  assert.match(viewsHtml, /id="ext-view-installed"/);
  assert.match(viewsHtml, /class="[^"]*ext-viewtab[^"]*"[^>]*data-view="browse"/);
  assert.match(viewsHtml, /data-view="installed"/);
});

test("renders a collection card per shipped collection", () => {
  const { viewsHtml } = render();
  for (const c of loadCollections()) {
    assert.ok(
      viewsHtml.includes(`data-collection-id="${c.id}"`),
      `missing collection card for ${c.id}`,
    );
  }
});

test("featured add-ons get their own section; non-featured do not appear in it", () => {
  const { viewsHtml } = render();
  const featured = viewsHtml.split('id="ext-featured"')[1].split("</section>")[0];
  assert.ok(featured.includes('data-addon-id="jellyfin"'));
  assert.ok(featured.includes('data-addon-id="searxng"'));
  assert.ok(!featured.includes('data-addon-id="kolibri"'), "kolibri is not featured");
});

test("every add-on lands in exactly one group section, tagged with its group", () => {
  const { viewsHtml } = render();
  assert.match(viewsHtml, /class="ext-group-section"[^>]*data-group="media"/);
  assert.match(viewsHtml, /data-addon-id="kolibri"[^>]*data-addon-group="productivity"/);
});

test("no horizontal-scroll patterns are emitted (the bug we are fixing)", () => {
  const { viewsHtml } = render();
  assert.ok(!/overflow-x\s*:\s*(auto|scroll)/.test(viewsHtml), "no inline horizontal scrollers in the markup");
});

test("collections registry JSON is embedded for the client modal", () => {
  const { collectionsScript } = render();
  assert.match(collectionsScript, /id="collection-registry"/);
  assert.ok(collectionsScript.includes("home-server"));
});

test("empty collections → the section is simply absent (crash-proof)", () => {
  const { viewsHtml } = render({ collections: [] });
  assert.ok(!viewsHtml.includes('id="ext-collections"'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/extensions-page-render.test.js`
Expected: FAIL — `buildExtensionsHTML` returns the old shape.

- [ ] **Step 3: Add the i18n keys (en + es)**

In `servers/gateway/dashboard/shared/i18n.js`, add to the `extensions.*` block:

```js
  "extensions.viewBrowse": { en: "Browse", es: "Explorar" },
  "extensions.viewInstalled": { en: "Installed", es: "Instalados" },
  "extensions.collectionsTitle": { en: "Starter collections", es: "Colecciones iniciales" },
  "extensions.collectionsSubtitle": { en: "Set up Crow for what you do — one click, a curated set of extensions.", es: "Configura Crow para lo que haces — un clic, un conjunto curado de extensiones." },
  "extensions.featuredTitle": { en: "Featured", es: "Destacados" },
  "extensions.groupAi": { en: "AI & Models", es: "IA y modelos" },
  "extensions.groupMedia": { en: "Media", es: "Medios" },
  "extensions.groupProductivity": { en: "Productivity & Learning", es: "Productividad y aprendizaje" },
  "extensions.groupSocial": { en: "Social & Federation", es: "Social y federación" },
  "extensions.groupInfrastructure": { en: "Infrastructure & Tools", es: "Infraestructura y herramientas" },
  "extensions.groupHomeHardware": { en: "Home & Hardware", es: "Hogar y hardware" },
  "extensions.groupMore": { en: "More", es: "Más" },
  "extensions.showAll": { en: "Show all", es: "Ver todo" },
  "extensions.showFewer": { en: "Show fewer", es: "Ver menos" },
  "extensions.collectionMembers": { en: "extensions", es: "extensiones" },
  "extensions.collectionInstall": { en: "Install collection", es: "Instalar colección" },
  "extensions.collectionExpectation": { en: "Installs these extensions one after another — large downloads can take a while on home bandwidth — then restarts Crow once.", es: "Instala estas extensiones una tras otra — las descargas grandes pueden tardar con ancho de banda doméstico — y luego reinicia Crow una vez." },
  "extensions.collectionWillInstall": { en: "Will install", es: "Se instalará" },
  "extensions.collectionAlreadyInstalled": { en: "Already installed", es: "Ya instalado" },
  "extensions.collectionSkipped": { en: "Skipped", es: "Omitido" },
  "extensions.collectionYouNeed": { en: "You'll need", es: "Necesitarás" },
  "extensions.collectionRunsHere": { en: "Runs on this Crow", es: "Se ejecuta en este Crow" },
  "extensions.collectionConnects": { en: "Connects to a service you already run", es: "Se conecta a un servicio que ya ejecutas" },
  "extensions.collectionDone": { en: "Collection installed", es: "Colección instalada" },
  "extensions.collectionConfigure": { en: "Finish setup", es: "Completar configuración" },
  "extensions.collectionConfigureDesc": { en: "These extensions are installed but need a value before they can do anything:", es: "Estas extensiones están instaladas pero necesitan un valor para funcionar:" },
  "extensions.configure": { en: "Configure", es: "Configurar" },
  "extensions.collectionBusy": { en: "Another install is already running — wait for it to finish.", es: "Ya hay otra instalación en curso — espera a que termine." },
  "extensions.noResults": { en: "No add-ons match your search.", es: "Ningún complemento coincide con tu búsqueda." },
```

- [ ] **Step 4: Mark the featured six in the registry**

Add `"featured": true` to the `companion`, `knowledge-base`, `home-assistant`, `jellyfin`, `paperless`, and `searxng` entries in `registry/add-ons.json`. (The manifest schema is `additionalProperties: true` and is only validated by `scripts/build-registry.mjs`, so this is additive — no schema version bump.)

- [ ] **Step 5: Rewrite the renderer + styles**

Rewrite `buildExtensionsHTML` in `html.js` to emit the structure above, returning `{ viewsHtml, addonRegistryScript, collectionsScript }`. Keep and reuse the existing `renderIcon`, `getCategoryColor`, `formatResources`, `ICON_MAP`, `CATEGORY_COLORS` helpers and the existing `.addon-card` data attributes (the install/detail-modal client code depends on them) — ADD `data-addon-group`. The addon card markup itself stays as-is apart from the new attribute; the *hierarchy* is what changes.

Collection card markup:

```js
const collectionCard = (c) => `<button type="button" class="ext-collection-card" data-collection-id="${escapeHtml(c.id)}">
    <span class="ext-collection-card__icon">${ICON_MAP[c.icon] || "\u{1F4E6}"}</span>
    <span class="ext-collection-card__name">${escapeHtml(c.name)}</span>
    <span class="ext-collection-card__desc">${escapeHtml(c.description)}</span>
    <span class="ext-collection-card__count">${c.members.length} ${t("extensions.collectionMembers", lang)}</span>
  </button>`;
```

Group section markup (`SHOWN = 8` — a fixed count, deliberately NOT "two grid rows", which would need viewport-dependent column measurement):

```js
const groupSection = (group, addons) => `<section class="ext-group-section" data-group="${escapeHtml(group.id)}">
    <h3 class="ext-section-title">${t(group.labelKey, lang)} <span class="ext-section-count">${addons.length}</span></h3>
    <div class="ext-grid">${addons.map((a, i) => addonCard(a, i, i >= 8)).join("")}</div>
    ${addons.length > 8 ? `<button type="button" class="btn btn-sm btn-secondary ext-group-more" data-group="${escapeHtml(group.id)}">${t("extensions.showAll", lang)} (${addons.length})</button>` : ""}
  </section>`;
```

where `addonCard(addon, i, hidden)` adds `class="ext-card addon-card ext-card--overflow"` + `style="display:none"` when `hidden` (the Show-all button toggles `.ext-card--overflow` visibility).

In `css.js`, add styles for `.ext-viewtabs/.ext-viewtab`, `.ext-collections`/`.ext-collection-card`, `.ext-featured`, `.ext-section-title`/`.ext-section-count`, `.ext-group-chips`/`.ext-group-chip` (**`flex-wrap: wrap`** — never `overflow-x`), `.ext-group-section`, `.ext-collection-modal__*`. **Delete** the old `.ext-tabs` rule (its `overflow-x:auto` + `flex-shrink:0` children were the overflow source) and the `.ext-installed-toggle` collapse (Installed is now its own view). Mirror every new surface into the `.theme-glass` block.

In `data-queries.js`, have `fetchRegistryData()` also return `collections: loadCollections()`.

In `extensions.js` (orchestrator), compose: `extensionStyles() + viewsHtml + addonRegistryScript + collectionsScript + extensionsClientJS(lang)`.

- [ ] **Step 6: Run the tests**

```bash
node --test tests/extensions-page-render.test.js tests/extensions-groups.test.js tests/extensions-collections.test.js
```
Expected: PASS.

- [ ] **Step 7: Boot the gateway to prove the page renders**

```bash
node servers/gateway/index.js --no-auth
# in another shell: curl -s localhost:3001/dashboard/extensions | grep -c 'ext-collection-card'   # expect 4
# ctrl-C
```
Expected: 4 collection cards, no errors in the boot log.

- [ ] **Step 8: Commit**

```bash
git add tests/extensions-page-render.test.js
git commit servers/gateway/dashboard/panels/extensions/html.js servers/gateway/dashboard/panels/extensions/css.js \
  servers/gateway/dashboard/panels/extensions/data-queries.js servers/gateway/dashboard/panels/extensions.js \
  servers/gateway/dashboard/shared/i18n.js registry/add-ons.json tests/extensions-page-render.test.js \
  -m "feat(extensions): app-store IA — browse/installed views, starter collections, featured, grouped sections; the horizontal tab scroller is gone"
git show --stat HEAD
```

---

### Task 11: Client behavior — views, filters, collection modal, checklist (D2, D7)

**Files:**
- Modify: `servers/gateway/dashboard/panels/extensions/client.js`
- Test: `tests/extensions-client-contract.test.js` (create)

**Interfaces:**
- Consumes: the DOM contracts from Task 10; `POST /bundles/api/install-set` and the job-log conventions from Task 7 (`SUMMARY member <id> <state> <reason?>`, `NEEDS_CONFIG <id> <KEYS>`).
- Produces: no new exports (the panel's client IIFE).

Client behavior to add — keep everything already there (install modal, consent gate, detail modal, uninstall, `pollJob`, `waitForRestart`, the `window.__extEscapeBound` one-time listener pattern):

1. **Segmented control**: `.ext-viewtab[data-view]` toggles `#ext-view-browse` / `#ext-view-installed` (`hidden` attribute), sets `aria-pressed`, and writes `location.hash` (`#installed` / cleared for browse).
2. **Hash deep-links on every render** (Turbo-safe): `#installed` → Installed view; `#collections` → Browse view + `scrollIntoView()` on `#ext-collections`.
3. **Group chips**: `.ext-group-chip[data-group]` — `all` shows every `.ext-group-section`; a group id shows only that section.
4. **Search**: a non-empty query hides all `.ext-group-section` / `#ext-collections` / `#ext-featured` and shows a flat `#ext-search-results` grid of matching `.addon-card` clones-by-visibility (reuse the existing name/desc/tags dataset match); an empty query restores sections. Zero matches → `extensions.noResults`.
5. **Show-all**: `.ext-group-more[data-group]` toggles `display` on that section's `.ext-card--overflow` cards and swaps its label between `showAll`/`showFewer`.
6. **Collection modal**: click `.ext-collection-card` → modal listing members with status chips (installed / will install / skipped-why) and the `kind` line (`collectionRunsHere` vs `collectionConnects` + `You'll need: <you_need>`), the expectation copy, and ONE primary button → `POST /bundles/api/install-set { collection_id }` → `pollJob(job_id, ...)` (which already handles `complete_restart` → `/restart` → `waitForRestart`). A 409 renders `extensions.collectionBusy`.
7. **Post-install checklist**: parse `NEEDS_CONFIG <id> <KEYS>` lines out of the finished job's log; render the `collectionConfigure` section with one row per member and a `Configure` button that opens the EXISTING env form for that add-on. Persist the parsed list in `sessionStorage` under `crow_ext_needs_config` before the restart-reload, and re-render it after reload (the gateway restart wipes the in-process job).

- [ ] **Step 1: Write the failing test**

The client is a template string, so the contract test asserts the wiring it must contain (this is how other panels in this repo are guarded; the real behavioral proof is the CDP run in Task 13).

```js
// tests/extensions-client-contract.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionsClientJS } from "../servers/gateway/dashboard/panels/extensions/client.js";

const JS = extensionsClientJS("en");

test("drives the collection installer against install-set and reuses the job poller", () => {
  assert.match(JS, /install-set/);
  assert.match(JS, /collection_id/);
  assert.match(JS, /pollJob\(/);
});

test("wires the segmented control, group chips, and show-all", () => {
  assert.match(JS, /\.ext-viewtab/);
  assert.match(JS, /\.ext-group-chip/);
  assert.match(JS, /\.ext-group-more/);
  assert.match(JS, /aria-pressed/);
});

test("honors #installed and #collections deep links", () => {
  assert.match(JS, /#?installed/);
  assert.match(JS, /collections/);
  assert.match(JS, /location\.hash/);
});

test("parses the NEEDS_CONFIG job-log lines into the post-install checklist and survives the restart reload", () => {
  assert.match(JS, /NEEDS_CONFIG/);
  assert.match(JS, /sessionStorage/);
});

test("a 409 from install-set surfaces the busy message, not a silent failure", () => {
  assert.match(JS, /409/);
});

test("keeps the one-time escape listener guard (Turbo re-entry must not stack listeners)", () => {
  assert.match(JS, /__extEscapeBound/);
});

test("no hardcoded English in the added UI strings (everything goes through tJs)", () => {
  // The collection modal's copy must come from i18n, not literals.
  assert.ok(!/Install collection<|>Install collection/.test(JS), "collection button label must be i18n'd");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/extensions-client-contract.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the client additions**

Write them inside the existing IIFE in `client.js`, after the current install/uninstall/detail wiring. Key fragments (adapt names to the surrounding code style — `var`, no arrow functions in the emitted string, `tJs()` for every label):

```js
        // --- View switching (segmented control + hash deep-links) ---
        function showView(view) {
          document.querySelectorAll(".ext-viewtab").forEach(function(t) {
            var on = t.dataset.view === view;
            t.classList.toggle("ext-viewtab--active", on);
            t.setAttribute("aria-pressed", on ? "true" : "false");
          });
          var browse = document.getElementById("ext-view-browse");
          var installed = document.getElementById("ext-view-installed");
          if (browse) browse.hidden = view !== "browse";
          if (installed) installed.hidden = view !== "installed";
        }
        document.querySelectorAll(".ext-viewtab").forEach(function(t) {
          t.addEventListener("click", function() {
            showView(this.dataset.view);
            location.hash = this.dataset.view === "installed" ? "installed" : "";
          });
        });
        // Deep links: run on every render so Turbo revisits behave.
        (function applyHash() {
          var h = (location.hash || "").replace("#", "");
          if (h === "installed") { showView("installed"); return; }
          showView("browse");
          if (h === "collections") {
            var sec = document.getElementById("ext-collections");
            if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        })();

        // --- Collection install ---
        var COLLECTIONS = (function() {
          var el = document.getElementById("collection-registry");
          if (!el) return {};
          try { return JSON.parse(el.textContent); } catch (e) { return {}; }
        })();

        function startCollectionInstall(collectionId, statusEl, btn) {
          btn.disabled = true;
          statusEl.style.display = "block";
          statusEl.style.color = "var(--crow-accent)";
          statusEl.textContent = '${tJs("extensions.installing", lang)}';
          apiCall("install-set", { collection_id: collectionId }).then(function(res) {
            if (res.ok && res.data.job_id) {
              sessionStorage.setItem("crow_ext_pending_collection", collectionId);
              pollJob(res.data.job_id, statusEl, btn);
            } else if (res.data && res.data.error && String(res.data.error).length && !res.ok) {
              statusEl.style.color = "var(--crow-error, #e74c3c)";
              statusEl.textContent = res.data.error;
              btn.disabled = false;
            }
          }).catch(function() {
            statusEl.style.color = "var(--crow-error, #e74c3c)";
            statusEl.textContent = '${tJs("extensions.networkError", lang)}';
            btn.disabled = false;
          });
        }
```

(The 409 path is the `!res.ok` branch — the server's message is already the busy copy. Branch on `res.status === 409` explicitly so the intent is legible and the contract test's `409` assertion passes; fall back to `extensions.collectionBusy` if the server sent no message.)

`pollJob` gains a NEEDS_CONFIG harvest before its existing completion handling:

```js
        function harvestNeedsConfig(job) {
          var out = [];
          (job.log || []).forEach(function(line) {
            var m = /^NEEDS_CONFIG (\\S+) (\\S+)$/.exec(line);
            if (m) out.push({ id: m[1], keys: m[2].split(",") });
          });
          if (out.length > 0) sessionStorage.setItem("crow_ext_needs_config", JSON.stringify(out));
          return out;
        }
```

and after a reload, a one-shot renderer reads `crow_ext_needs_config` from `sessionStorage`, renders the `collectionConfigure` checklist into the modal (each row: add-on name + missing keys + a `Configure` button calling the existing env-form flow), then clears the key.

- [ ] **Step 4: Run the tests**

```bash
node --test tests/extensions-client-contract.test.js tests/extensions-page-render.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/extensions-client-contract.test.js
git commit servers/gateway/dashboard/panels/extensions/client.js tests/extensions-client-contract.test.js \
  -m "feat(extensions): store client — view switching, group chips, show-all, collection modal driving install-set, post-install configuration checklist"
git show --stat HEAD
```

---

### Task 12: Collection install end-to-end on a scratch gateway (§7 integration)

**Files:**
- Test: `tests/install-set-e2e.test.js` (create)

**Interfaces:**
- Consumes: everything from Tasks 3–9.
- Produces: nothing.

The set runner's headline promises are only real if proven end-to-end: sequential execution, per-member LIVE gates, continue-on-error, exactly ONE `complete_restart`, and the busy gate. Use a fixture collection whose members are cheap and local — **at least one must be panel-bearing**, or `needsRestart` never flips and the deferred-restart assertion is vacuous (skill-only and panel-less mcp-server installs never set it).

**Isolation rules (non-negotiable, learned the hard way):** scratch `CROW_HOME` **and** `CROW_DATA_DIR` (never the real ones), never the real `.env`, and the fully-offline env: `CROW_AUTO_UPDATE=0`, `CROW_DISABLE_HEALTH_MONITOR=1`, `CROW_DISABLE_INSTANCE_SYNC=1`, `CROW_DISABLE_NOSTR=1`.

- [ ] **Step 1: Write the test**

```js
// tests/install-set-e2e.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install-set over a fixture collection, against a scratch CROW_HOME.
 *
 * Fixture members (no Docker, no network):
 *   fx-panel  — bundle with a panel  → needsRestart TRUE (proves the deferred restart)
 *   fx-skill  — skill add-on         → needsRestart false
 *   fx-broken — manifest points at a missing panel file → member FAILS
 * Order matters: fx-broken sits in the middle, so a passing run proves
 * continue-on-error (fx-skill after it must still install).
 */
function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), "crowhome-"));
  mkdirSync(join(home, "bundles"), { recursive: true });
  mkdirSync(join(home, "panels"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "installed.json"), "[]");
  return home;
}

test("install-set: sequential, continue-on-error, exactly one deferred restart, live gates", async (t) => {
  const home = scratchHome();
  process.env.CROW_HOME = home;
  process.env.CROW_DATA_DIR = join(home, "data");
  process.env.CROW_AUTO_UPDATE = "0";
  process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
  process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
  process.env.CROW_DISABLE_NOSTR = "1";

  // Import AFTER the env is set — the module reads CROW_HOME at load.
  const { validateCollectionServerSide, planInstallSet } = await import("../servers/gateway/routes/bundles.js");
  const { loadCollections } = await import("../servers/gateway/dashboard/panels/extensions/collections.js");

  // Fixture collections file
  const fixture = join(home, "collections.json");
  writeFileSync(fixture, JSON.stringify({
    version: 1,
    collections: [{
      id: "fx", name: "Fixture", description: "d", icon: "home",
      members: [
        { id: "fx-panel", kind: "builtin" },
        { id: "fx-broken", kind: "builtin" },
        { id: "fx-skill", kind: "builtin" },
      ],
    }],
  }));
  const cols = loadCollections(fixture);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].members.length, 3);

  // The real assertions below drive the router over HTTP (express app with the
  // bundles router mounted, APP_BUNDLES pointed at a scratch source tree holding
  // fx-panel / fx-broken / fx-skill). Build that source tree here, POST
  // /bundles/api/install-set { collection_id: "fx" }, then poll /bundles/api/jobs/:id
  // until it finishes and assert on the log:
  //   - "SUMMARY member fx-panel installed"
  //   - "SUMMARY member fx-broken failed ..."      ← continue-on-error
  //   - "SUMMARY member fx-skill installed"        ← the set did NOT abort
  //   - job.status === "complete_restart"          ← exactly one deferred restart
  //   - installed.json contains fx-panel + fx-skill, NOT fx-broken
  //   - a second POST while the first runs → 409   ← busy gate
});
```

**Implementer note:** flesh out the commented block into real code. If pointing `APP_BUNDLES` at a scratch tree requires a test seam in `bundles.js` (e.g. `_setAppBundlesForTest`), add it — a narrow, clearly-named test seam is preferable to installing real bundles in a test. Keep `scheduleGatewayRestart` from actually exiting the test process: inject/stub it via the same seam pattern (`_setRestartHookForTest`) and assert it was called exactly ONCE.

- [ ] **Step 2: Run the test**

Run: `node --test tests/install-set-e2e.test.js`
Expected: PASS, with the process NOT exiting (the restart hook is stubbed).

- [ ] **Step 3: Prove the scratch isolation held**

```bash
# The real installed.json must be untouched by the test run:
git status --short ~/.crow 2>/dev/null || true
python3 -c "import json;print(len(json.load(open('/home/kh0pp/.crow/installed.json'))))"
```
Expected: the real `~/.crow/installed.json` still lists the same add-ons as before the run (record the count in the task report — the #166 suite-leak incident is exactly this failure mode).

- [ ] **Step 4: Commit**

```bash
git add tests/install-set-e2e.test.js
git commit tests/install-set-e2e.test.js servers/gateway/routes/bundles.js \
  -m "test(bundles): install-set E2E on a scratch CROW_HOME — sequential, continue-on-error, one deferred restart, busy gate"
git show --stat HEAD
```

---

### Task 13: Onboarding bridge, docs, full suite, CDP proof (D9, D10, §7, §8)

**Files:**
- Modify: `servers/gateway/dashboard/panels/onboarding.js:38` (the "what to try" cards)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (the new onboarding card keys, en + es)
- Modify: `docs/developers/bundles.md` (collections + the co-hosted CROW_HOME invariant)
- Modify: `docs/developers/creating-addons.md` (`featured` flag; how to get into a collection)
- Test: `tests/onboarding-cards.test.js` (create)
- Evidence: `~/.crow/p4/ext-overhaul/` (CDP)

- [ ] **Step 1: Write the failing test**

```js
// tests/onboarding-cards.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../servers/gateway/dashboard/panels/onboarding.js", import.meta.url), "utf8");

test("the done step offers a starter-collection card that deep-links into the store", () => {
  assert.match(SRC, /\/dashboard\/extensions#collections/);
  assert.match(SRC, /onboarding\.(tryCollections|collections)/, "the card's copy must be i18n'd");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/onboarding-cards.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the fourth card + i18n**

In `onboarding.js`, extend the three "what to try" cards with:

```js
  {
    icon: "extensions",
    titleKey: "onboarding.tryCollectionsTitle",
    bodyKey: "onboarding.tryCollectionsBody",
    href: "/dashboard/extensions#collections",
  },
```

i18n (en + es):

```js
  "onboarding.tryCollectionsTitle": { en: "Set up a starter collection", es: "Instala una colección inicial" },
  "onboarding.tryCollectionsBody": { en: "Home server, education, research or development — install a curated set of extensions in one click.", es: "Servidor doméstico, educación, investigación o desarrollo — instala un conjunto curado de extensiones con un clic." },
```

- [ ] **Step 4: Docs**

`docs/developers/bundles.md` — add a "Collections" section: what `registry/collections.json` is, the member hard rules (official, non-privileged, non-consent, non-GPU, dependency-closed + topologically ordered, `kind` matches compose presence, `connects` ⇒ `you_need`), that `tests/extensions-collections.test.js` enforces them, and that the gateway re-validates against on-disk manifests at install time. Add the deployment invariant: **co-hosted gateways must use distinct `CROW_HOME`** (the install busy-flag is in-process; two gateways sharing one `~/.crow` would race on `installed.json`).

`docs/developers/creating-addons.md` — document the optional `featured: true` registry flag (surfaces the add-on in the store's Featured section) and note that post-install `env` configuration now also updates `mcp-addons.json` for MCP add-ons (so a gateway restart applies it).

- [ ] **Step 5: Full suite + merge main**

```bash
git fetch origin
git merge origin/main --no-rebase -m "Merge origin/main into feat/extensions-overhaul"   # only if main moved
npm test 2>&1 | tail -5    # or: node --test tests/
```
Expected: **no regressions vs the 1522/0/1 baseline** (new tests add to the pass count). Fix anything red before proceeding.

- [ ] **Step 6: CDP browser proof (HARD REQUIREMENT — UI-heavy theme)**

Evidence dir `~/.crow/p4/ext-overhaul/`; helper `~/.crow/p4/bughunt-20260711/cdp.mjs` (`newTab(url, sessionToken)`, `ev()`, `shot()`, `log()`). Run against a **scratch gateway** (throwaway clone on this branch, scratch `CROW_HOME`+`CROW_DATA_DIR`, no real `.env`, `--no-auth`, port 3999) for the install-set drive, and against **prod crow** (`http://10.0.0.237:3001`, minted session cookie) for the read-only layout checks after deploy.

Required assertions, each logged to `assertions.jsonl` with a screenshot:

1. **Overflow gone**: on `/dashboard/extensions`, `document.documentElement.scrollWidth <= clientWidth + 1` at viewport widths 1920, 1366, 768, 390 (use `Emulation.setDeviceMetricsOverride`). Before-shot for comparison already exists: `extensions-current.png` (2555 vs 1904).
2. **D1 regression sweep**: same overflow assertion on `/dashboard`, `/dashboard/messages`, `/dashboard/contacts`, `/dashboard/settings`, `/dashboard/bot-builder`.
3. **Segmented control**: real click on `[data-view="installed"]` → `#ext-view-installed` visible, `#ext-view-browse` hidden, `location.hash === "#installed"`.
4. **Group chips**: real click on a chip → only that `.ext-group-section` is visible.
5. **Show all**: real click on `.ext-group-more` in a >8-card group → the previously hidden `.ext-card--overflow` cards become visible.
6. **Search**: type into `#ext-search` → sections hide, matching cards show; clear → sections return.
7. **Collection modal**: real click on `.ext-collection-card[data-collection-id="development"]` → modal lists members with status chips + the `kind` line + the expectation copy.
8. **THE MONEY SHOT — one-click install on the scratch gateway**: real click on "Install collection" for a fixture/small collection → job log streams → job reaches `complete_restart` → the restart waiter reloads → members show as Installed → the configuration checklist renders with the expected members. Screenshot each stage.
9. **Onboarding bridge**: `/dashboard/onboarding?step=<done>` → the fourth card links to `/dashboard/extensions#collections`; clicking it lands on Browse with the collections section scrolled into view.

- [ ] **Step 7: Commit**

```bash
git add tests/onboarding-cards.test.js
git commit servers/gateway/dashboard/panels/onboarding.js servers/gateway/dashboard/shared/i18n.js \
  docs/developers/bundles.md docs/developers/creating-addons.md tests/onboarding-cards.test.js \
  -m "feat(onboarding): starter-collection card on the done step; docs for collections, the featured flag, and the co-hosted CROW_HOME invariant"
git show --stat HEAD
```

- [ ] **Step 8: Final whole-branch review → PR → merge → deploy → live verify**

1. Final adversarial whole-branch Opus review (fresh subagent, full diff vs `origin/main`). Fold anything MAJOR; triage minors explicitly.
2. Open the PR (`gh` is absent — use the GitHub MCP tools). Body: what shipped, the R1/R2 review record, the CDP evidence list, the suite numbers, and the **post-deploy checks**.
3. Check-runs: `https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs` (`total_count: 0` is normal here — the workflows are path-filtered; the local suite is the real gate).
4. Merge (blanket authorization — no per-PR gate).
5. Deploy: crow = `git pull --ff-only` + `sudo systemctl restart crow-gateway crow-mpa-gateway` (same tree — restore `main` first); grackle = pull, then restart `crow-mcp-bridge` THEN `crow-gateway`; black-swan = pull in `~/.crow/app` + restart (slow boot 60–90s; until-loop on `:3001/health`).
6. Live verify on prod crow: CDP assertions 1–7 + 9 (NOT 8 — never mass-install collections on prod), `PRAGMA integrity_check`, gateway log clean, `sync_conflicts` still 219/182/162, stash baselines unchanged (crow 4, grackle 17).

---

## Self-Review

**Spec coverage:** D1→T1. D2→T10+T11. D3→T2. D4→T10 (featured flag + section). D5→T3. D6 (all 11 sub-points)→T4 (validateInstall), T5 (runInstallJob + TTL), T6 (busy flag + auto-update inhibition), T7 (route, planner, server-side re-validation, continue-on-error, one restart), T8 (router-wide xhostVerify), T3+T13 (co-hosted CROW_HOME invariant: documented, and already true on crow). D7→T7 (needsConfigKeys), T9 (mcp env path), T11 (modal + checklist). D8→T10 (frontend-design). D9→T13. D10 (i18n/Turbo/a11y)→T10 (keys), T11 (aria-pressed, one-time listeners, hash-on-every-render). §7 testing→T12 (integration) + T13 (suite + CDP) + per-task mutation checks in T4/T5/T6/T7/T8. §8 rollout→T13 Step 8.

**Placeholders:** none — Task 12's fixture-tree code is deliberately left for the implementer to flesh out from a precisely-specified assertion list (it depends on a test seam whose exact shape the implementer will discover in `bundles.js`); every other step carries the actual code.

**Type consistency:** `validateInstall` returns `{ok, manifest, installed, consentVerified, hardwareWarning?}` (T4) — consumed with those exact names by T5's `runInstallJob({job, installedSnapshot, consentVerified, manifest, deferRestart})` and T7's set runner (`mv.installed` → `installedSnapshot`, `mv.manifest` → `manifest`). `runInstallJob` returns `{ok:true, needsRestart}` / `{ok:false, reason}` — T7 reads exactly `out.ok`, `out.needsRestart`, `out.reason`. `loadCollections`/`getCollection` (T3) return members as `{id, kind, you_need?}` — T7's `validateCollectionServerSide` and T10's card renderer both use `m.id` / `m.kind` / `m.you_need`. `groupForCategory`/`groupAddons` (T2) feed T10's `data-addon-group` attribute, which T11's chip filter reads.
