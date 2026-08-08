# MCP Instance Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally impossible for a Crow bot to resolve an MCP server bound to a different instance.

**Architecture:** Crow servers stop being read out of the user-global `~/.pi/agent/mcp.json` and are instead derived per-instance from the repo registry (core servers) and the instance's own `mcp-addons.json` (bundle servers). The per-bot `<sessionDir>/.mcp.json` becomes closed-world: it names every server the bot may use with instance-correct bindings, and explicitly `{"disabled": true}`s everything else pi would otherwise inherit.

**Tech Stack:** Node 22 ESM, `node:test` built-in runner, `better-sqlite3`, pi 0.82.0 + pi-lab `main`.

**Spec:** `docs/superpowers/specs/2026-08-08-mcp-instance-binding-design.md`

## Global Constraints

- **Node 22 on every invocation:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`
- **Tests:** `npm test` runs the full suite in a scratch env. Single file: `npm test -- tests/<file>.test.js`
- **Bridge export stability is mandatory.** `pibot-gateways@r4` runs from the `~/crow` working tree in a soak ending ~2026-08-12 and `job_runner.mjs` imports from `bridge.mjs`. Every export in `scripts/pi-bots/bridge.mjs` — `db`, `CROW_DB`, `TASKS_DB`, `PiRpc`, `toolAllowlist`, `applySessionNarrowing`, `readRemoteInvocationEnabled`, `readPeerGatewayUrls` — keeps its name and signature. Only function bodies change.
- **Never open a running gateway's `crow.db`/`tasks.db` directly.** Copy `.db` + `-wal` + `-shm`, query the copy.
- **Commit with a positional path arg:** `git commit <path> -m "..."`. `git add <exact path>` first only when the file is new. Never a bare `git add`. Verify with `git show --stat HEAD` after every commit.
- **`git pull --rebase` before pushing.** Parallel sessions push to `main`.
- **CI is a hard gate.** Query `https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs`, never the legacy commit-status API. Contexts: `suite`, `static-checks`, `audit`. `enforce_admins` is TRUE.
- **`gh` is not installed.** Use the GitHub MCP tools.
- **Never attribute Claude. No `Co-Authored-By` trailer.**
- **No schema changes in this plan.** `SCHEMA_GENERATION` is not touched, so the migration rail does not apply.

## File Structure

| file | responsibility |
|---|---|
| `scripts/pi-bots/crow-server-catalog.mjs` | **new.** Owns "what Crow servers exist on this instance and how are they bound." Imports only `server-registry.js` and `instance-paths.mjs` — no `ext_registry`, no `mcp_writer` — so there is no import cycle. |
| `scripts/pi-bots/mcp_writer.mjs` | modified. Consumes the catalog; writes the closed-world per-bot file. Already 447 lines, so the catalog deliberately does not live here. |
| `scripts/pi-bots/bridge.mjs` | modified, one line in the `PiRpc` constructor. |
| `scripts/pi-bots/ext_registry.mjs` | modified, adds `serversForProbe`. |
| `servers/gateway/dashboard/panels/bot-builder/data-queries.js` | modified, `probeAll()` — which lives here, not in `ext_registry.mjs`. |
| `tests/pibot-crow-server-catalog.test.js` | **new.** Catalog derivation and rebinding. |
| `tests/pibot-mcp-instance-binding.test.js` | **new.** The invariant, closed-world, and `optIn`. |
| `tests/pibot-tools-envelope.test.js` | **new.** The real `--tools` spawn args, via the `PiRpc` stub seam. |

---

### Task 1: The instance catalog module

**Files:**
- Create: `scripts/pi-bots/crow-server-catalog.mjs`
- Test: `tests/pibot-crow-server-catalog.test.js`

**Interfaces:**
- Consumes: `CORE_SERVERS`, `CONDITIONAL_SERVERS`, `ROOT`, `loadEnv`, `resolveEnvValue` from `scripts/server-registry.js`; `botsDbPath`, `tasksDbPath`, `resolveSqlitePath` from `scripts/pi-bots/instance-paths.mjs`.
- Produces:
  - `INSTANCE_ENV_KEYS: string[]` — exactly `["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_TASKS_DB_PATH"]`
  - `instanceBinding(crowHome: string, opts?: {tasksDbPath?: string}) -> {CROW_HOME, CROW_DATA_DIR, CROW_DB_PATH, CROW_TASKS_DB_PATH}`
  - `rebindBlock(name: string, block: object, binding: object, crowHome: string) -> {block, rebound: string[]} | {disabled: true, reason: string}`
  - `crowServerCatalog(crowHome: string, opts?: {binding?, node?}) -> {servers: {[name]: block}, unconfigured: {[name]: string}}`

- [ ] **Step 1: Write the failing test**

Create `tests/pibot-crow-server-catalog.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTANCE_ENV_KEYS,
  instanceBinding,
  rebindBlock,
  crowServerCatalog,
} from "../scripts/pi-bots/crow-server-catalog.mjs";
import { ROOT } from "../scripts/server-registry.js";

/** An instance home with a tasks bundle dir and an mcp-addons.json. */
function instanceB() {
  const dir = mkdtempSync(join(tmpdir(), "instB-"));
  const home = join(dir, ".crow-b");
  mkdirSync(join(home, "bundles", "tasks"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    tasks: { command: "node", args: ["server/index.js"], env: { CROW_TASKS_DB_PATH: "/wrong/tasks.db" } },
    ghost: { command: "node", args: ["server/index.js"] },
  }));
  return { dir, home };
}

const BINDING_B = (home) => ({
  CROW_HOME: home,
  CROW_DATA_DIR: join(home, "data"),
  CROW_DB_PATH: join(home, "data", "crow.db"),
  CROW_TASKS_DB_PATH: join(home, "data", "tasks.db"),
});

test("INSTANCE_ENV_KEYS is exactly the four instance-scoped vars", () => {
  assert.deepEqual([...INSTANCE_ENV_KEYS].sort(),
    ["CROW_DATA_DIR", "CROW_DB_PATH", "CROW_HOME", "CROW_TASKS_DB_PATH"]);
});

test("instanceBinding normalizes a file: tasks URI", () => {
  const b = instanceBinding("/home/x/.crow-r4", { tasksDbPath: "file:/home/x/.crow-r4/data/tasks.db" });
  assert.equal(b.CROW_TASKS_DB_PATH, "/home/x/.crow-r4/data/tasks.db");
});

test("rebindBlock rewrites every instance-scoped env key", () => {
  const { home } = instanceB();
  const block = { command: "n", args: ["a.js"], cwd: "/repo",
    env: { CROW_DB_PATH: "/home/x/.crow-mpa/data/crow.db", UNRELATED: "keep" } };
  const r = rebindBlock("crow-memory", block, BINDING_B(home), home);
  assert.equal(r.env, undefined, "returns a wrapper, not a bare block");
  assert.equal(r.block.env.CROW_DB_PATH, join(home, "data", "crow.db"));
  assert.equal(r.block.env.UNRELATED, "keep");
  assert.equal(r.block.env.CROW_JOURNAL_MODE, "DELETE", "WAL scar guard applied");
  assert.deepEqual(r.rebound, ["CROW_DB_PATH"]);
});

test("rebindBlock retargets a cross-instance bundle cwd that exists here", () => {
  const { home } = instanceB();
  const block = { command: "n", args: ["server/index.js"], cwd: "/home/x/.crow-mpa/bundles/tasks", env: {} };
  const r = rebindBlock("crow-tasks", block, BINDING_B(home), home);
  assert.equal(r.block.cwd, join(home, "bundles", "tasks"));
  assert.ok(r.rebound.includes("cwd"));
});

test("rebindBlock disables a bundle absent on this instance, with a reason", () => {
  const { home } = instanceB();
  const block = { command: "n", args: ["server/index.js"], cwd: "/home/x/.crow-mpa/bundles/rookery", env: {} };
  const r = rebindBlock("crow-rookery", block, BINDING_B(home), home);
  assert.equal(r.disabled, true);
  assert.match(r.reason, /rookery/);
  assert.match(r.reason, /not installed/);
});

test("rebindBlock leaves the repo cwd alone — the repo is instance-neutral", () => {
  const { home } = instanceB();
  const block = { command: "n", args: ["x.js"], cwd: "/home/kh0pp/crow/bundles/browser", env: {} };
  const r = rebindBlock("crow-browser", block, BINDING_B(home), home);
  assert.equal(r.block.cwd, "/home/kh0pp/crow/bundles/browser");
  assert.deepEqual(r.rebound, []);
});

test("rebindBlock strips optIn — selection is the opt-in", () => {
  const { home } = instanceB();
  const r = rebindBlock("gws", { command: "n", args: [], optIn: true, env: {} }, BINDING_B(home), home);
  assert.ok(!("optIn" in r.block));
});

test("catalog binds core servers to this instance and serves them from the repo", () => {
  const { home } = instanceB();
  const { servers } = crowServerCatalog(home, { binding: BINDING_B(home) });
  const mem = servers["crow-memory"];
  assert.ok(mem, "crow-memory catalogued");
  assert.equal(mem.env.CROW_DB_PATH, join(home, "data", "crow.db"));
  assert.equal(mem.env.CROW_JOURNAL_MODE, "DELETE");
  assert.equal(mem.cwd, ROOT, "core servers run from the repo root");
});

test("catalog binds bundle servers from this instance's mcp-addons.json", () => {
  const { home } = instanceB();
  const { servers } = crowServerCatalog(home, { binding: BINDING_B(home) });
  assert.equal(servers.tasks.cwd, join(home, "bundles", "tasks"), "cwd defaulted under this instance");
  assert.equal(servers.tasks.env.CROW_TASKS_DB_PATH, join(home, "data", "tasks.db"),
    "the addon's own wrong path is rebound, not trusted");
});

test("catalog reports an addon whose bundle dir is missing as unconfigured", () => {
  const { home } = instanceB();
  const { servers, unconfigured } = crowServerCatalog(home, { binding: BINDING_B(home) });
  assert.ok(!servers.ghost, "ghost is not offered as spawnable");
  assert.match(unconfigured.ghost, /not installed/);
});

test("crow-storage is catalogued as unconfigured when MinIO env is absent", () => {
  const { home } = instanceB();
  const { servers, unconfigured } = crowServerCatalog(home, { binding: BINDING_B(home) });
  assert.ok(!servers["crow-storage"], "not offered as spawnable without MinIO settings");
  assert.match(unconfigured["crow-storage"], /MINIO_ENDPOINT/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test -- tests/pibot-crow-server-catalog.test.js
```

Expected: FAIL — `Cannot find module '../scripts/pi-bots/crow-server-catalog.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/pi-bots/crow-server-catalog.mjs`:

```js
#!/usr/bin/env node
/**
 * Crow Bot Builder — the per-instance Crow server catalog.
 *
 * THE INVARIANT: a bot must never resolve a Crow server bound to an instance
 * other than its own. Stated structurally, which is how this module achieves
 * it: no file that can name an instance may describe a Crow server.
 *
 * So Crow servers are DERIVED, never copied out of the user-global
 * ~/.pi/agent/mcp.json:
 *   - core servers  -> scripts/server-registry.js, run from the repo root,
 *                      env bound to THIS instance
 *   - bundle servers -> <crowHome>/mcp-addons.json, cwd under THIS instance
 * The homedir config keeps only third-party servers, which carry credentials
 * rather than instance identity.
 *
 * Imports are deliberately limited to server-registry.js and instance-paths.mjs
 * so neither ext_registry.mjs nor mcp_writer.mjs can form a cycle through here.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CORE_SERVERS,
  CONDITIONAL_SERVERS,
  ROOT,
  loadEnv,
  resolveEnvValue,
} from "../server-registry.js";
import { botsDbPath, tasksDbPath, resolveSqlitePath } from "./instance-paths.mjs";

/**
 * The env vars that name an instance. r4-deploy.sh warns that a child missing
 * any of these silently resolves to the PRIMARY instance, which is exactly the
 * failure this list exists to prevent.
 */
export const INSTANCE_ENV_KEYS = [
  "CROW_HOME",
  "CROW_DATA_DIR",
  "CROW_DB_PATH",
  "CROW_TASKS_DB_PATH",
];

/**
 * This instance's canonical values for the four instance-scoped env vars.
 *
 * The tasks path is normalized through resolveSqlitePath(): production stores
 * `file:` URIs in project_spaces.tasks_db_uri and better-sqlite3 has no URI
 * support, so an un-normalized value reaches a bundle as an unopenable
 * filename (the PR #278 defect).
 */
export function instanceBinding(crowHome, opts = {}) {
  const dbPath = opts.dbPath || botsDbPath();
  return {
    CROW_HOME: crowHome,
    CROW_DATA_DIR: dirname(dbPath),
    CROW_DB_PATH: dbPath,
    CROW_TASKS_DB_PATH: resolveSqlitePath(opts.tasksDbPath || tasksDbPath()),
  };
}

/** A bundle cwd under SOME instance home: /…/.crow<suffix>/bundles/<id>. */
const INSTANCE_BUNDLE_CWD = /\/\.crow[^/]*\/bundles\/([^/]+)\/?$/;

function applyJournalGuard(env) {
  // The WAL-unlink scar: every server touching a crow.db runs journal DELETE.
  if (env && env.CROW_DB_PATH) env.CROW_JOURNAL_MODE = "DELETE";
  return env;
}

/**
 * Rebind a server block that did NOT come from the catalog — a third-party or
 * `crow-browser` entry out of the homedir config — onto this instance.
 *
 * Returns {block, rebound} or {disabled, reason}. `optIn` is stripped: pi
 * activates an optIn server only when a project file says {"enabled": true},
 * so a verbatim copy of an optIn block silently never loads. Selecting the
 * server IS the opt-in.
 *
 * The /.crow anchor is deliberate. `/home/kh0pp/crow/bundles/browser` and
 * `/home/kh0pp/crow` do not match, so the repo is left alone — it is
 * instance-neutral, correctly.
 */
export function rebindBlock(name, block, binding, crowHome) {
  const clone = JSON.parse(JSON.stringify(block));
  delete clone.optIn;
  const rebound = [];
  if (clone.env) {
    for (const k of INSTANCE_ENV_KEYS) {
      if (k in clone.env && clone.env[k] !== binding[k]) {
        clone.env[k] = binding[k];
        rebound.push(k);
      }
    }
  }
  const m = clone.cwd ? INSTANCE_BUNDLE_CWD.exec(clone.cwd) : null;
  if (m) {
    const target = join(crowHome, "bundles", m[1]);
    if (!existsSync(target)) {
      return {
        disabled: true,
        reason: `bundle '${m[1]}' is not installed on this instance (${target})`,
      };
    }
    if (clone.cwd !== target) {
      clone.cwd = target;
      rebound.push("cwd");
    }
  }
  applyJournalGuard(clone.env);
  return { block: clone, rebound };
}

function readAddons(crowHome) {
  try {
    return JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

/**
 * Build a core-server block from its registry entry. Instance-scoped env keys
 * come from the binding; everything else resolves against the repo .env.
 * Returns {block, missing} — `missing` names required templates (no `:-`
 * default) that resolved empty.
 */
function coreBlock(spec, binding, repoEnv, node) {
  const env = {};
  const missing = [];
  for (const [k, tmpl] of Object.entries(spec.mcpEnv || {})) {
    if (INSTANCE_ENV_KEYS.includes(k)) {
      env[k] = binding[k];
      continue;
    }
    const v = resolveEnvValue(tmpl, repoEnv);
    if (!v && /\$\{\w+\}/.test(tmpl)) missing.push(k);
    else env[k] = v;
  }
  applyJournalGuard(env);
  return { block: { command: node, args: [...spec.args], cwd: ROOT, env }, missing };
}

/**
 * Every Crow server available to THIS instance, plus the ones that exist but
 * cannot be spawned here and why.
 *
 * `unconfigured` is not an error channel — it is what the GUI renders so an
 * operator sees "crow-storage: unconfigured, missing MINIO_ENDPOINT" instead
 * of an opaque spawn failure.
 */
export function crowServerCatalog(crowHome = process.env.CROW_HOME || join(homedir(), ".crow"), opts = {}) {
  const binding = opts.binding || instanceBinding(crowHome, opts);
  const node = opts.node || process.execPath;
  const repoEnv = loadEnv();
  const servers = {};
  const unconfigured = {};

  for (const spec of CORE_SERVERS) {
    const { block } = coreBlock(spec, binding, repoEnv, node);
    servers[spec.name] = block;
  }
  for (const spec of CONDITIONAL_SERVERS) {
    const { block, missing } = coreBlock(spec, binding, repoEnv, node);
    if (missing.length) unconfigured[spec.name] = `unconfigured: missing ${missing.join(", ")}`;
    else servers[spec.name] = block;
  }
  for (const [id, addon] of Object.entries(readAddons(crowHome))) {
    const cwd = resolve(addon.cwd || join(crowHome, "bundles", id));
    if (!existsSync(cwd)) {
      unconfigured[id] = `bundle not installed on this instance (${cwd})`;
      continue;
    }
    const r = rebindBlock(id, { ...addon, cwd }, binding, crowHome);
    if (r.disabled) unconfigured[id] = r.reason;
    else servers[id] = r.block;
  }
  return { servers, unconfigured };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test -- tests/pibot-crow-server-catalog.test.js
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-bots/crow-server-catalog.mjs tests/pibot-crow-server-catalog.test.js
git commit scripts/pi-bots/crow-server-catalog.mjs tests/pibot-crow-server-catalog.test.js \
  -m "feat(pi-bots): derive Crow MCP servers per instance instead of copying them

Core servers come from the repo registry bound to this instance's env; bundle
servers come from this instance's mcp-addons.json with cwd under its own home.
A bundle absent here is reported, never minted into a guaranteed spawn failure.

No file that can name an instance describes a Crow server."
git show --stat HEAD
```

---

### Task 2: Closed-world per-bot config

**Files:**
- Modify: `scripts/pi-bots/mcp_writer.mjs` (header comment, `extraServersFromExtensions` comment, `buildBotMcp`, `writeBotMcp`)
- Test: `tests/pibot-mcp-instance-binding.test.js`

**Interfaces:**
- Consumes: `crowServerCatalog`, `instanceBinding`, `rebindBlock` from Task 1.
- Produces: `buildBotMcp(def, canonical, opts)` gains `opts.catalog`, `opts.unconfigured`, `opts.binding`, `opts.crowHome`; its return gains `rebound: Array<{name, keys}>` and `disabled: string[]`, and `servers` now lists **active** names only. `writeBotMcp(def, opts)` gains the same passthrough plus `opts.binding`. All existing keys and signatures are unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/pibot-mcp-instance-binding.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";

/**
 * A canonical config pinned to instance A, and a crowHome of instance B.
 * The invariant is that nothing active in the output may reference A.
 */
function twoInstances() {
  const dir = mkdtempSync(join(tmpdir(), "twoinst-"));
  const A = join(dir, ".crow-a");
  const B = join(dir, ".crow-b");
  mkdirSync(join(A, "bundles", "tasks"), { recursive: true });
  mkdirSync(join(A, "bundles", "rookery"), { recursive: true });
  mkdirSync(join(B, "bundles", "tasks"), { recursive: true });
  mkdirSync(join(B, "data"), { recursive: true });
  writeFileSync(join(B, "mcp-addons.json"), JSON.stringify({
    tasks: { command: "node", args: ["server/index.js"], env: { CROW_TASKS_DB_PATH: join(A, "data", "tasks.db") } },
  }));
  const canonicalPath = join(dir, "canonical.json");
  writeFileSync(canonicalPath, JSON.stringify({ mcpServers: {
    "crow-memory":  { command: "n", args: ["servers/memory/index.js"], cwd: "/repo", env: { CROW_DB_PATH: join(A, "data", "crow.db") } },
    "crow-tasks":   { command: "n", args: ["server/index.js"], cwd: join(A, "bundles", "tasks"), env: { CROW_TASKS_DB_PATH: join(A, "data", "tasks.db") } },
    "crow-rookery": { command: "n", args: ["server/index.js"], cwd: join(A, "bundles", "rookery"), env: {} },
    "brave-search": { command: "npx", args: ["-y", "srv"], cwd: "/home/x", env: { BRAVE_API_KEY: "k" } },
    "gws":          { command: "g", args: [], optIn: true, env: {} },
  } }));
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const binding = {
    CROW_HOME: B,
    CROW_DATA_DIR: join(B, "data"),
    CROW_DB_PATH: join(B, "data", "crow.db"),
    CROW_TASKS_DB_PATH: join(B, "data", "tasks.db"),
  };
  return { dir, A, B, canonicalPath, sessionDir, binding };
}

function write(def, f) {
  const res = writeBotMcp(def, {
    sessionDir: f.sessionDir, canonicalPath: f.canonicalPath, crowHome: f.B, binding: f.binding,
  });
  return { res, json: JSON.parse(readFileSync(join(f.sessionDir, ".mcp.json"), "utf8")) };
}

/** Every string anywhere in a block — cwd, command, args, env values. */
function strings(block) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(block);
  return out;
}

test("THE INVARIANT: no active block references the other instance", () => {
  const f = twoInstances();
  const { json } = write({ tools: { crow_mcp: ["crow-memory", "tasks", "brave-search"] } }, f);
  for (const [name, block] of Object.entries(json.mcpServers)) {
    if (block && block.disabled === true) continue;
    for (const s of strings(block)) {
      assert.ok(!s.includes("/.crow-a"), `${name} leaks instance A via ${s}`);
    }
  }
});

test("a selected core server is rebound to this instance's database", () => {
  const f = twoInstances();
  const { json } = write({ tools: { crow_mcp: ["crow-memory"] } }, f);
  assert.equal(json.mcpServers["crow-memory"].env.CROW_DB_PATH, join(f.B, "data", "crow.db"));
  assert.equal(json.mcpServers["crow-memory"].env.CROW_JOURNAL_MODE, "DELETE");
});

test("closed-world: every unselected canonical server is disabled", () => {
  const f = twoInstances();
  const { json, res } = write({ tools: { crow_mcp: ["crow-memory"] } }, f);
  for (const name of ["crow-tasks", "crow-rookery", "brave-search", "gws"]) {
    assert.deepEqual(json.mcpServers[name], { disabled: true }, `${name} must be disabled`);
  }
  assert.ok(res.disabled.includes("brave-search"));
  assert.deepEqual(res.servers, ["crow-memory"], "servers lists ACTIVE names only");
});

test("a selected bundle absent on this instance is disabled with a reason", () => {
  const f = twoInstances();
  const { json, res } = write({ tools: { crow_mcp: ["crow-rookery"] } }, f);
  assert.deepEqual(json.mcpServers["crow-rookery"], { disabled: true });
  assert.ok(res.warnings.some((w) => /rookery/.test(w) && /not installed/.test(w)),
    "the reason is surfaced, not swallowed: " + JSON.stringify(res.warnings));
});

test("optIn never survives into an active block", () => {
  const f = twoInstances();
  const { json } = write({ tools: { crow_mcp: ["gws"] } }, f);
  assert.ok(!("optIn" in json.mcpServers.gws), "a copied optIn block would never load");
});

test("a non-Crow server is carried through untouched", () => {
  const f = twoInstances();
  const { json } = write({ tools: { crow_mcp: ["brave-search"] } }, f);
  assert.equal(json.mcpServers["brave-search"].env.BRAVE_API_KEY, "k");
  assert.equal(json.mcpServers["brave-search"].cwd, "/home/x");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test -- tests/pibot-mcp-instance-binding.test.js
```

Expected: FAIL. `THE INVARIANT` fails because `crow-memory` still carries instance A's `CROW_DB_PATH`; `closed-world` fails because unselected servers are absent rather than disabled.

- [ ] **Step 3: Correct the two stale precedence comments**

In `scripts/pi-bots/mcp_writer.mjs`, replace the first paragraph of the file header (the block beginning `S2/D finding (plan §5, "Verified Claims")`) with:

```js
/**
 * Crow Bot Builder — per-bot MCP config writer + tool-list prober.
 *
 * PRECEDENCE (verified live against pi 0.82.0 + pi-lab main, 2026-08-08):
 * pi-lab/extensions/mcp-client.ts merges ~/.pi/agent/mcp.json FIRST, then every
 * cwd-ancestor .mcp.json from the filesystem root down to cwd — the NEAREST
 * project file WINS. pi-lab commit 671e116 (2026-07-04) changed this; the old
 * "homedir wins on collision" rule this file used to assert is FALSE, and
 * believing it hid three live bugs for a month. A project file may also delete
 * an inherited server with {"name": {"disabled": true}}.
 *
 * So the per-bot <session_dir>/.mcp.json is AUTHORITATIVE, and this writer
 * writes it CLOSED-WORLD: the bot's selected servers with instance-correct
 * bindings, plus {"disabled": true} for every other server pi would inherit.
 * Omission is NOT narrowing — an unmentioned homedir server still loads.
 *
 * Crow servers are never copied out of the homedir file; they are derived
 * per-instance by crow-server-catalog.mjs. See
 * docs/superpowers/specs/2026-08-08-mcp-instance-binding-design.md.
 */
```

In `extraServersFromExtensions`, replace the line

```js
    if (canonical.mcpServers[name]) continue; // canonical present -> homedir wins, no mint
```

with:

```js
    // The catalog (crow-server-catalog.mjs) already covers every Crow server on
    // this instance and is consulted first by buildBotMcp, so this path only
    // ever fills a NON-Crow name absent from canonical. Kept as a seam for
    // callers that pass their own canonical without a catalog.
    if (canonical.mcpServers[name]) continue;
```

- [ ] **Step 4: Rewrite `buildBotMcp` closed-world**

In `scripts/pi-bots/mcp_writer.mjs`, add to the imports at the top:

```js
import { crowServerCatalog, instanceBinding, rebindBlock } from "./crow-server-catalog.mjs";
```

Replace the whole of `buildBotMcp` with:

```js
/**
 * Build the per-bot `.mcp.json` object. CLOSED-WORLD — see the file header.
 *
 * Resolution order for a selected name:
 *   1. catalog   — instance-derived, always correct. Wins.
 *   2. canonical — for names the catalog does not know (third-party servers,
 *                  crow-browser). Rebound onto this instance as a belt.
 *   3. extraServers — the mcp-addons seam retained for callers without a catalog.
 * Then every OTHER canonical name is emitted as {"disabled": true}, because
 * canonical is exactly what pi would otherwise inherit.
 *
 * @returns {{ json, servers, warnings, journalGuarded, minted, rebound, disabled }}
 *   `servers` lists ACTIVE names only; disabled names are in `disabled`.
 */
export function buildBotMcp(def, canonical, opts = {}) {
  const want = serversForBot(def);
  const catalog = opts.catalog || {};
  const unconfigured = opts.unconfigured || {};
  const binding = opts.binding;
  const crowHome = opts.crowHome;
  const extra = opts.extraServers || {};
  const out = { mcpServers: {} };
  const warnings = [];
  const journalGuarded = [];
  const minted = [];
  const rebound = [];
  const disabled = [];
  const active = [];

  const disable = (name, reason) => {
    out.mcpServers[name] = { disabled: true };
    disabled.push(name);
    if (reason) warnings.push(`server '${name}' ${reason}`);
  };

  // `minted` keeps its A5 meaning: resolved from somewhere canonical does NOT
  // have it. A core server present in BOTH the catalog and canonical is not
  // minted — logging it as "minted from extensions" would be false on the
  // commonest path (bot-world.mjs and the regen message both print this).
  const noteMinted = (name) => { if (!canonical.mcpServers[name]) minted.push(name); };
  // `journalGuarded` exists to make the WAL-unlink guard OBSERVABLE, so it
  // reports every active crow.db server carrying the guard — uniformly, on
  // whichever path resolved it. Reporting only the blocks this function
  // happened to flip would hide the catalog path, which is now the common one.
  const noteGuard = (name, block) => { if (touchesCrowDb(block)) journalGuarded.push(name); };

  for (const name of want) {
    if (catalog[name]) {
      out.mcpServers[name] = catalog[name];
      active.push(name);
      noteMinted(name);
      noteGuard(name, catalog[name]);
      continue;
    }
    if (unconfigured[name]) {
      disable(name, unconfigured[name]);
      continue;
    }
    const source = canonical.mcpServers[name] || extra[name];
    if (!source) {
      warnings.push(
        "server '" + name + "' is selected but absent from the instance catalog, " +
        "canonical mcp.json AND mcp-addons.json — pi will NOT have it"
      );
      continue;
    }
    // No binding means a caller that predates instance binding (tests, CLI):
    // fall back to the old verbatim copy + journal guard rather than crash.
    if (!binding) {
      const clone = JSON.parse(JSON.stringify(source));
      if (touchesCrowDb(clone)) {
        clone.env = clone.env || {};
        if (clone.env.CROW_JOURNAL_MODE !== "DELETE") {
          clone.env.CROW_JOURNAL_MODE = "DELETE";
          journalGuarded.push(name);
        }
      }
      out.mcpServers[name] = clone;
      active.push(name);
      noteMinted(name);
      continue;
    }
    const r = rebindBlock(name, source, binding, crowHome);
    if (r.disabled) {
      disable(name, r.reason);
      continue;
    }
    if (r.rebound.length) rebound.push({ name, keys: r.rebound });
    noteGuard(name, r.block);
    out.mcpServers[name] = r.block;
    active.push(name);
    noteMinted(name);
  }

  // Closed-world. Sorted so the written file is diffable.
  const selected = new Set(want);
  for (const name of Object.keys(canonical.mcpServers).sort()) {
    if (selected.has(name)) continue;
    disable(name, null);
  }

  return { json: out, servers: active, warnings, journalGuarded, minted, rebound, disabled };
}
```

- [ ] **Step 5: Thread the catalog through `writeBotMcp`**

In `scripts/pi-bots/mcp_writer.mjs`, inside `writeBotMcp`, replace the two lines

```js
  const extraServers = opts.extraServers || extraServersFromExtensions(def, crowHome, { canonical });
  const built = buildBotMcp(def, canonical, { extraServers });
```

with:

```js
  const extraServers = opts.extraServers || extraServersFromExtensions(def, crowHome, { canonical });
  // The instance catalog is the FIRST source for any Crow server. opts.binding
  // lets tests and the panel pin an instance without mutating process.env.
  const binding = opts.binding || instanceBinding(crowHome, opts);
  const { servers: catalog, unconfigured } = crowServerCatalog(crowHome, { binding });
  const built = buildBotMcp(def, canonical, {
    extraServers, catalog, unconfigured, binding, crowHome,
  });
```

Then forward the two new keys in `writeBotMcp`'s own `return {...}` — without this the
function silently drops them and Step 1's closed-world test throws
`Cannot read properties of undefined (reading 'includes')`:

```js
    journalGuarded: built.journalGuarded,
    minted: built.minted,
    rebound: built.rebound,
    disabled: built.disabled,
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test -- tests/pibot-mcp-instance-binding.test.js
npm test -- tests/remote-mcp-writer.test.js
```

Expected: both PASS. `remote-mcp-writer.test.js` exercises the no-binding fallback path and must be unchanged.

- [ ] **Step 7: Commit**

```bash
git add tests/pibot-mcp-instance-binding.test.js
git commit scripts/pi-bots/mcp_writer.mjs tests/pibot-mcp-instance-binding.test.js \
  -m "fix(pi-bots): write the per-bot .mcp.json closed-world

pi's NEAREST-file-wins precedence (pi-lab 671e116, 2026-07-04) means the per-bot
file is authoritative and can delete an inherited server. This writer believed
the opposite, so it copied core-server blocks verbatim out of a homedir config
pinned to one instance and stayed silent about everything else pi inherits.

An r4 bot's crow_store_memory resolved to MPA's crow.db. Six MPA-pinned servers
were spawned into every r4 turn. A copied optIn block never activated at all."
git show --stat HEAD
```

---

### Task 3: Pin `--tools` for an empty envelope

**Files:**
- Modify: `scripts/pi-bots/bridge.mjs` (`PiRpc` constructor, the `--tools` branch)
- Create: `tests/pibot-tools-envelope.test.js`

**Interfaces:**
- Consumes: `PiRpc` from `bridge.mjs` via its existing `nodeBin` / `cliPath` / `extraEnv` test seams — the same seams `tests/pibot-bridge-exit-surface.test.js` uses, so no real pi and no live MCP server is ever spawned.
- Produces: nothing new. `PiRpc`'s spawn args gain `--tools ""` where the flag was previously omitted.

**Test the real spawn args, never a mirror of the branch.** `PiRpc` builds its args
internally and spawns in the constructor, so a stub `cliPath` that records its own
`process.argv` is the only honest way to assert this. A helper that re-implements the
`if/else` in the test file would assert nothing about production code.

- [ ] **Step 1: Write the failing test**

Create `tests/pibot-tools-envelope.test.js`:

```js
/**
 * `--tools` is ALWAYS pinned.
 *
 * pi falls back to defaultActiveToolNames when the flag is ABSENT
 * (dist/cli/args.js:85-89 -> dist/core/sdk.js:133-136), so a bot with an empty
 * envelope used to receive bash, edit, write, and every tool registered by
 * every inherited MCP server. Three enabled r4 bots were in that state.
 *
 * Uses the PiRpc nodeBin/cliPath seam with a stub that records its argv, so no
 * real pi is spawned. Asserts the ACTUAL spawn args, never a mirror of the
 * branch under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");

/** Spawn PiRpc against a stub that dumps argv, and return the args pi saw. */
async function spawnArgs(def, narrowedTools) {
  const scratch = mkdtempSync(join(tmpdir(), "crow-tools-"));
  mkdirSync(join(scratch, "sessions"), { recursive: true });
  const out = join(scratch, "argv.json");
  const stub = join(scratch, "stub-pi.mjs");
  writeFileSync(stub,
    'import { writeFileSync } from "node:fs";\n' +
    'writeFileSync(process.env.CROW_TEST_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n' +
    'process.exit(0);\n');
  const pi = new PiRpc({
    def,
    sessionDir: scratch,
    resolved: { provider: "stub", model: "stub", key: "stub/stub" },
    nodeBin: process.execPath,
    cliPath: stub,
    narrowedTools,
    extraEnv: { CROW_TEST_ARGV_OUT: out },
  });
  for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  try { pi.close(); } catch { /* already exited */ }
  assert.ok(existsSync(out), "stub pi never recorded its argv");
  return JSON.parse(readFileSync(out, "utf8"));
}

/** The value pi received for --tools, or undefined when the flag was omitted. */
function toolsFlag(argv) {
  const i = argv.indexOf("--tools");
  return i === -1 ? undefined : argv[i + 1];
}

test("an empty tool envelope pins --tools \"\" instead of omitting the flag", async () => {
  const argv = await spawnArgs({ tools: { pi_builtin: [], crow_mcp: [] } });
  assert.notEqual(toolsFlag(argv), undefined,
    "omitting --tools hands pi its full default surface — an empty envelope would WIDEN");
  assert.equal(toolsFlag(argv), "");
});

test("a normal envelope still pins its allowlist", async () => {
  const argv = await spawnArgs({ tools: { pi_builtin: ["read"], crow_mcp: ["tasks/tasks_list"] } });
  assert.equal(toolsFlag(argv), "read,mcp__tasks__tasks_list");
});

test("narrowing every tool away still pins --tools \"\"", async () => {
  const argv = await spawnArgs(
    { tools: { pi_builtin: ["read"], crow_mcp: [] } },
    JSON.stringify(["read"]));
  assert.equal(toolsFlag(argv), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test -- tests/pibot-tools-envelope.test.js
```

Expected: FAIL on the first test — `--tools` is absent from argv, so `toolsFlag` returns `undefined`. The other two must already PASS; if they do not, stop and report, because the seam itself is not working.

- [ ] **Step 3: Change the branch in `bridge.mjs`**

In `scripts/pi-bots/bridge.mjs`, in the `PiRpc` constructor, replace:

```js
    if (narrowedTools !== tools) {
      // A narrowing that removes EVERY tool must STILL pin `--tools ""`: pi
      // parses that to an empty allowlist (dist/cli/args.js:85-89 →
      // core/sdk.js:133-136, verified on 0.82.0), whereas omitting the flag
      // hands pi its full default surface — narrowing would widen.
      args.push("--tools", narrowedTools);
    } else if (tools) {
      args.push("--tools", tools);
    }
```

with:

```js
    // `--tools` is ALWAYS pinned. pi parses "" to an empty allowlist
    // (dist/cli/args.js:85-89 → core/sdk.js:133-136, verified on 0.82.0),
    // whereas OMITTING the flag hands pi defaultActiveToolNames — bash, edit,
    // write, and every tool registered by every inherited MCP server.
    //
    // The narrowing case was already guarded. The EMPTY-ENVELOPE case fell
    // through the same hole: toolAllowlist() returns "" for a bot with no
    // builtin and no MCP tools, `else if (tools)` is falsy on "", and three
    // enabled r4 bots were running with pi's entire default surface.
    // An empty envelope is a real answer, not an absent one.
    args.push("--tools", narrowedTools);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test -- tests/pibot-tools-envelope.test.js
npm test -- tests/pibot-bridge-exit-surface.test.js tests/perch-narrowing.test.js
```

Expected: all PASS. The latter two already drive `PiRpc` and must be unaffected.

- [ ] **Step 5: Verify bridge exports are unchanged — the soak requires it**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
git diff scripts/pi-bots/bridge.mjs | grep -E '^[-+].*export ' || echo "OK: no export line changed"
node -e "import('./scripts/pi-bots/bridge.mjs').then(m=>console.log(Object.keys(m).sort().join(' ')))"
```

Expected: `OK: no export line changed`, and the export list contains at least `CROW_DB PiRpc TASKS_DB applySessionNarrowing db readPeerGatewayUrls readRemoteInvocationEnabled toolAllowlist`.

- [ ] **Step 6: Commit**

```bash
git add tests/pibot-tools-envelope.test.js
git commit scripts/pi-bots/bridge.mjs tests/pibot-tools-envelope.test.js \
  -m "fix(pi-bots): always pin --tools, so an empty envelope means no tools

toolAllowlist() returns \"\" for a bot with no builtin and no MCP tools, and
\`else if (tools)\` is falsy on \"\", so the flag was omitted and pi fell back to
defaultActiveToolNames. Three enabled r4 bots were running with bash, edit,
write and every inherited MCP tool.

The comment above the branch already stated the rule for the narrowing case.
The empty-envelope case fell through the same hole."
git show --stat HEAD
```

---

### Task 4: The GUI picker keeps every server, correctly bound

**Files:**
- Modify: `scripts/pi-bots/ext_registry.mjs` (add `serversForProbe`)
- Modify: `servers/gateway/dashboard/panels/bot-builder/data-queries.js` (`probeAll` lives HERE, not in ext_registry — it already imports `resolveCrowHome`; callers `wizard.js:404` and `editor.js:133` are both zero-arg)
- Test: `tests/pibot-crow-server-catalog.test.js` (append)

**Interfaces:**
- Consumes: `crowServerCatalog` from Task 1.
- Produces: `probeAll(crowHome?)` — gains an optional first argument. Existing zero-arg callers keep working.

This task is what makes the host cleanup in Task 6 survivable: once the six Crow entries leave `~/.pi/agent/mcp.json`, a picker that renders canonical alone would stop offering Crow's own tools.

- [ ] **Step 1: Write the failing test**

Append to `tests/pibot-crow-server-catalog.test.js`:

```js
import { serversForProbe } from "../scripts/pi-bots/ext_registry.mjs";

test("probe surface is the catalog plus NON-Crow canonical entries", () => {
  const { home } = instanceB();
  const canonical = { mcpServers: {
    "crow-memory": { command: "n", args: [], env: { CROW_DB_PATH: "/elsewhere/crow.db" } },
    "brave-search": { command: "npx", args: ["-y", "s"], env: { BRAVE_API_KEY: "k" } },
  } };
  const surface = serversForProbe(canonical, home, { binding: BINDING_B(home) });
  assert.equal(surface["crow-memory"].env.CROW_DB_PATH, join(home, "data", "crow.db"),
    "the catalog wins over the canonical entry");
  assert.equal(surface["brave-search"].env.BRAVE_API_KEY, "k", "non-Crow entries survive");
  assert.ok(!surface.tasks,
    "addons stay OUT — probeExtensions already owns them; folding them in double-lists every addon");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test -- tests/pibot-crow-server-catalog.test.js
```

Expected: FAIL — `serversForProbe` is not exported.

- [ ] **Step 3: Implement**

In `scripts/pi-bots/ext_registry.mjs`, add to the imports:

```js
import { crowServerCatalog } from "./crow-server-catalog.mjs";
```

Add this exported function immediately above `probeAll`:

```js
/**
 * The set of servers the Tools tab probes: this instance's Crow catalog, plus
 * the NON-Crow entries from the homedir config. The catalog wins on name, so a
 * homedir entry pinned to another instance is never probed or offered.
 *
 * Once the Crow entries are removed from ~/.pi/agent/mcp.json entirely, this
 * function is what keeps the picker whole.
 */
export function serversForProbe(canonical, crowHome = resolveCrowHome(), opts = {}) {
  // CORE servers only. `probeExtensions` already owns the addon surface and is
  // already instance-correct, so folding the catalog's mcp-addons half in here
  // would render every installed addon TWICE in the editor's Tools tab and
  // spawn each one twice per cold render.
  const { servers: catalog, coreNames } = crowServerCatalog(crowHome, opts);
  const core = {};
  for (const name of coreNames) if (catalog[name]) core[name] = catalog[name];
  const out = {};
  for (const [name, block] of Object.entries(canonical.mcpServers || {})) {
    if (!core[name]) out[name] = block;
  }
  return Object.assign(out, core);
}
```

In `probeAll` — which is in `servers/gateway/dashboard/panels/bot-builder/data-queries.js`, NOT `ext_registry.mjs` — replace:

```js
  const names = Object.keys(canonical.mcpServers);
  await Promise.all(
    names.map(async (n) => {
      try {
        out[n] = await probeServerTools(canonical.mcpServers[n], { timeoutMs: 12000 });
```

with:

```js
  const surface = serversForProbe(canonical, crowHome);
  const names = Object.keys(surface);
  await Promise.all(
    names.map(async (n) => {
      try {
        out[n] = await probeServerTools(surface[n], { timeoutMs: 12000 });
```

and change the signature `export async function probeAll() {` to:

```js
export async function probeAll(crowHome = resolveCrowHome()) {
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test -- tests/pibot-crow-server-catalog.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit scripts/pi-bots/ext_registry.mjs tests/pibot-crow-server-catalog.test.js \
  -m "fix(pi-bots): probe the instance catalog, not the homedir config

The Bot Builder tool picker rendered every canonical server, so it offered Crow
servers bound to whichever instance the homedir file named. It now probes this
instance's catalog plus the non-Crow canonical entries, which is also what lets
the Crow entries leave ~/.pi/agent/mcp.json without emptying the picker."
git show --stat HEAD
```

---

### Task 5: Mutation-test, full suite, and live acceptance on r4

Verification is its own task because the spec makes mutation testing a requirement, and because a green unit suite does not prove the writer produces a correct file for the real `r4-assistant`.

**Files:** none modified. This task produces evidence.

- [ ] **Step 1: Mutation-test each production change**

For each mutation below: apply it, run the named test file, confirm it FAILS, then `git checkout` the file. **A mutation that does not fail a test means the test is vacuous — fix the test before proceeding.**

| # | mutation | must fail |
|---|---|---|
| 1 | in `crow-server-catalog.mjs`, make `rebindBlock` skip the env loop (`for (const k of [])`) | `pibot-crow-server-catalog` + `pibot-mcp-instance-binding` |
| 2 | in `crow-server-catalog.mjs`, drop the `existsSync(target)` guard so a missing bundle is retargeted anyway | `pibot-crow-server-catalog` |
| 3 | in `crow-server-catalog.mjs`, remove `delete clone.optIn` | `pibot-mcp-instance-binding` |
| 4 | in `mcp_writer.mjs`, delete the closed-world loop | `pibot-mcp-instance-binding` |
| 5 | in `mcp_writer.mjs`, prefer `canonical` over `catalog` in the resolution order | `pibot-mcp-instance-binding` |
| 6 | in `bridge.mjs`, restore `else if (tools)` | `pibot-tools-envelope` |
| 7 | in `crow-server-catalog.mjs`, anchor the bundle regex on `/crow` instead of `/\.crow` | `pibot-crow-server-catalog` (the repo-cwd test) |
| 8 | in `ext_registry.mjs`, revert `serversForProbe` to fold the whole catalog (`Object.assign(out, catalog)`) | `pibot-crow-server-catalog` (the addon double-listing test) |

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
# after each edit:
npm test -- tests/pibot-crow-server-catalog.test.js tests/pibot-mcp-instance-binding.test.js tests/pibot-tools-envelope.test.js
git checkout scripts/pi-bots/<file>
```

- [ ] **Step 2: Run the full suite**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
npm test 2>&1 | tail -30
```

Expected: pass/fail counts with **0 failures other than** `tests/models-panel-ui.test.js`, which fails on this host and passes in CI because the catalog suppresses the Download button when the memory fit probe returns `wont_fit`. It reproduces on pristine `origin/main` and predates this work. **Record the exact counts** — the prior "3052 pass / 0 fail" baseline is only true on an idle box.

- [ ] **Step 3: Live acceptance — the real `r4-assistant`, before any deploy**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
S=$(mktemp -d); mkdir -p $S/db $S/out
for f in crow.db crow.db-wal crow.db-shm; do cp -a /home/kh0pp/.crow-r4/data/$f $S/db/ 2>/dev/null; done
cd /home/kh0pp/crow
CROW_HOME=/home/kh0pp/.crow-r4 CROW_DATA_DIR=/home/kh0pp/.crow-r4/data \
CROW_DB_PATH=$S/db/crow.db node -e "
const Database=require('better-sqlite3');
const d=new Database(process.env.CROW_DB_PATH,{readonly:true});
const def=JSON.parse(d.prepare('SELECT definition FROM pi_bot_defs WHERE bot_id=?').get('r4-assistant').definition);
d.close();
import('./scripts/pi-bots/mcp_writer.mjs').then(m=>{
  const r=m.writeBotMcp(def,{sessionDir:'$S/out',crowHome:'/home/kh0pp/.crow-r4'});
  console.log(JSON.stringify({servers:r.servers,disabled:r.disabled,rebound:r.rebound,warnings:r.warnings},null,2));
});"
echo '--- written file ---'; cat $S/out/.mcp.json
echo '--- INVARIANT: any active block naming another instance? ---'
node -e "
const j=JSON.parse(require('fs').readFileSync('$S/out/.mcp.json','utf8'));
let bad=0;
for(const [n,b] of Object.entries(j.mcpServers)){
  if(b&&b.disabled===true) continue;
  const s=JSON.stringify(b);
  if(/\.crow-mpa|\.crow\//.test(s)){console.log('LEAK',n,s);bad++;}
}
console.log(bad?'FAIL '+bad+' leaking':'PASS no active block names another instance');"
```

Expected: `servers` is `["tasks","bots-sql-mcp","crow-memory"]`; `crow-memory.env.CROW_DB_PATH` is `/home/kh0pp/.crow-r4/data/crow.db`; `crow-tasks`, `crow-bots-sql`, `crow-projects`, `crow-blog`, `crow-storage`, `brave-search`, `crow-browser`, `google-workspace*` all appear as `{"disabled": true}`; and the final line reads **PASS**.

- [ ] **Step 4: Record the evidence**

Append the Step 2 counts and the Step 3 output to the spec's Appendix A under a new heading `A.7 — post-implementation acceptance`, then commit:

```bash
git commit docs/superpowers/specs/2026-08-08-mcp-instance-binding-design.md \
  -m "docs(pi-bots): record post-implementation acceptance evidence"
git show --stat HEAD
```

---

### Task 6: Ship it — PR 1, then the host cleanup

**Files:** none modified in the repo beyond the branch push.

- [ ] **Step 1: Push the branch and open the PR**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
git pull --rebase
git push -u origin HEAD
```

Then open the PR with `mcp__github__create_pull_request` against `kh0pper/crow` `main`. Title:

```
fix(pi-bots): a bot must never resolve another instance's Crow server
```

Body — use verbatim. **No `Co-Authored-By` trailer, no Claude attribution.**

```markdown
pi-lab commit 671e116 (2026-07-04) changed MCP config precedence so the NEAREST
project file wins, not the homedir `~/.pi/agent/mcp.json`. Crow still asserted
the old "homedir wins on collision" rule in `mcp_writer.mjs`, and believing it
hid three live bugs.

1. **Core-server blocks were copied verbatim** out of a homedir config pinned to
   one instance, so an r4 bot's `crow_store_memory` resolved to MPA's `crow.db`.
   Armed and reachable; MPA's `memories` table shows it had not yet fired.
2. **An empty tool envelope omitted `--tools`**, and pi falls back to
   `defaultActiveToolNames` when the flag is absent. Three enabled r4 bots were
   running with bash, edit, write, and every inherited MCP tool.
3. **A verbatim-copied `optIn` block never activates**, so four MPA bots listed
   Google Workspace tools for a server that never loaded.

Crow servers are now derived per instance — core from the repo registry, bundles
from the instance's own `mcp-addons.json` — and the per-bot `.mcp.json` is written
closed-world, disabling everything pi would otherwise inherit.

Design and evidence: `docs/superpowers/specs/2026-08-08-mcp-instance-binding-design.md`

No schema change; `SCHEMA_GENERATION` is untouched, so the migration rail does not apply.
```

- [ ] **Step 2: Gate on CI**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
SHA=$(git rev-parse HEAD)
curl -s https://api.github.com/repos/kh0pper/crow/commits/$SHA/check-runs \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);
    console.log('total',j.total_count);
    for(const r of j.check_runs) console.log(' ',r.name,r.status,r.conclusion);});"
```

Every run must be `completed` / `success` on `suite`, `static-checks` and `audit`. **An empty `check_runs` result on a current sha means something is WRONG, not normal** — do not merge. Never consult the legacy commit-status API.

- [ ] **Step 3: Merge, deploy, and log the soak entries**

Merge with `mcp__github__merge_pull_request`. Then:

`r4-deploy.sh` uses `sudo -A` when `SUDO_ASKPASS` is set and `sudo -n` otherwise
(`scripts/r4-deploy.sh:65`). No askpass helper exists on this host, so create one — it must
print the password and nothing else:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
ASKPASS=$(mktemp /tmp/crow-askpass-XXXX.sh)
printf '#!/bin/sh\necho "8r00kly^"\n' > "$ASKPASS"
chmod 700 "$ASKPASS"
```

Then deploy, dry run first:

```bash
date '+%Y-%m-%d %H:%M:%S %Z'   # RECORD: ~/crow pull touching scripts/pi-bots/
git pull --rebase
SUDO_ASKPASS="$ASKPASS" /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh --dry-run
SUDO_ASKPASS="$ASKPASS" /home/kh0pp/r4-tehcy/scripts/r4-deploy.sh
date '+%Y-%m-%d %H:%M:%S %Z'   # RECORD: manual pibot-gateways@r4 restart
SUDO_ASKPASS="$ASKPASS" sudo -A systemctl restart pibot-gateways@r4
sleep 15
SUDO_ASKPASS="$ASKPASS" sudo -A journalctl -u pibot-gateways@r4 -n 40 --no-pager
```

Keep `$ASKPASS` for the rest of this task — Step 5 needs it. It is deleted in Step 6.

`r4-deploy.sh` does **not** restart `pibot-gateways@r4`, and that unit imports `bridge.mjs` at start, so without the manual restart it keeps running the old code. Confirm the journal shows the job runner and bot-cron armed and `bot_runtime ON`. Both timestamps go in the handoff so heartbeat gaps stay explainable during the soak.

- [ ] **Step 4: Confirm the leak is closed on the live host**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
echo '8r00kly^' | sudo -S journalctl -u pibot-gateways@r4 --since "10 min ago" --no-pager \
  | grep -iE "crow-tasks|ERR_DLOPEN|Brave Search|mcp-client" || echo "OK: no inherited-global spawn"
```

Expected: `OK: no inherited-global spawn`. Before this change the r4 journal showed `[pi-lab/mcp-client] crow-tasks: MCP error -32000` and `Brave Search MCP Server running on stdio` inside r4 bot turns.

- [ ] **Step 5: The host cleanup — only after Step 4 passes**

Ordering is a hard constraint: editing the global file before PR 1 is deployed breaks the six MPA bots and the GUI picker.

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
D=$(date +%Y%m%d-%H%M%S)
cp -a /home/kh0pp/.pi/agent/mcp.json /home/kh0pp/.pi/agent/mcp.json.bak.$D
cp -a /home/kh0pp/r4-tehcy/.mcp.json /home/kh0pp/r4-tehcy/.mcp.json.bak.$D
```

Then:

**1. Strip the six Crow entries from the global config.** Leaves `google-workspace`,
`brave-search`, `crow-browser`, `google-workspace-dayane`.

```bash
node -e "
const fs=require('fs'), P='/home/kh0pp/.pi/agent/mcp.json';
const j=JSON.parse(fs.readFileSync(P,'utf8'));
for(const n of ['crow-memory','crow-projects','crow-blog','crow-storage','crow-tasks','crow-bots-sql'])
  delete j.mcpServers[n];
fs.writeFileSync(P, JSON.stringify(j,null,2)+'\n');
console.log('remaining:', Object.keys(j.mcpServers).join(', '));"
```

**2. Disable the same six in `~/r4-tehcy/.mcp.json`.** That file defines r4-correct servers
under *different* names (`r4-tasks`, `r4-trackers`, `r4-kb`, `pm-workspace`), so the six
MPA-pinned globals currently load **alongside** them: working in `~/r4-tehcy` today,
`crow_store_memory` writes to MPA. This closes the human door, and stays correct as defense in
depth even after step 1.

```bash
node -e "
const fs=require('fs'), P='/home/kh0pp/r4-tehcy/.mcp.json';
const j=JSON.parse(fs.readFileSync(P,'utf8'));
for(const n of ['crow-memory','crow-projects','crow-blog','crow-storage','crow-tasks','crow-bots-sql'])
  j.mcpServers[n]={disabled:true};
fs.writeFileSync(P, JSON.stringify(j,null,2)+'\n');
console.log('entries:', Object.keys(j.mcpServers).join(', '));"
```

**3. Rename the legacy selections in MPA's five bot defs.** Data only, no schema change.
`~/.crow-mpa` is not the live instance and its gateway is running, so stop it first, edit, restart.
Leave `crow-home` on `~/.crow` alone — `~/.crow` has no tasks bundle, so it is correctly disabled
with a reason.

```bash
SUDO_ASKPASS="$ASKPASS" sudo -A systemctl stop pibot-gateways@crow-mpa pibot-discord@crow-mpa
# Back up all three sqlite files — a .db without its -wal is not a restorable copy.
for f in crow.db crow.db-wal crow.db-shm; do
  [ -e /home/kh0pp/.crow-mpa/data/$f ] && cp -a /home/kh0pp/.crow-mpa/data/$f /home/kh0pp/.crow-mpa/data/$f.bak.$D
done
node -e "
const Database=require('/home/kh0pp/crow/node_modules/better-sqlite3');
const d=new Database('/home/kh0pp/.crow-mpa/data/crow.db');
d.pragma('busy_timeout = 10000');
const MAP={'crow-tasks':'tasks','crow-bots-sql':'bots-sql-mcp'};
for(const r of d.prepare('SELECT bot_id,definition FROM pi_bot_defs').all()){
  const def=JSON.parse(r.definition||'{}');
  const sel=(def.tools&&def.tools.crow_mcp)||[];
  const next=sel.map(s=>{const [srv,...rest]=s.split('/');return (MAP[srv]||srv)+(rest.length?'/'+rest.join('/'):'');});
  if(JSON.stringify(sel)===JSON.stringify(next)) continue;
  def.tools.crow_mcp=next;
  d.prepare('UPDATE pi_bot_defs SET definition=? WHERE bot_id=?').run(JSON.stringify(def), r.bot_id);
  console.log(r.bot_id, '->', next.join(', '));
}
d.close();"
SUDO_ASKPASS="$ASKPASS" sudo -A systemctl start pibot-gateways@crow-mpa pibot-discord@crow-mpa
```

- [ ] **Step 6: Verify the cleanup**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node -e "
const j=JSON.parse(require('fs').readFileSync('/home/kh0pp/.pi/agent/mcp.json','utf8'));
const gone=['crow-memory','crow-projects','crow-blog','crow-storage','crow-tasks','crow-bots-sql']
  .filter(n=>j.mcpServers[n]);
console.log(gone.length?'STILL PRESENT: '+gone.join(', '):'OK: no Crow server in the global config');"
```

Expected: `OK: no Crow server in the global config`. Then re-run Task 5 Step 3 and confirm it still reports **PASS** — the writer must produce the same file with the global entries gone, because the catalog was already winning.

Confirm the Bot Builder tool picker still offers Crow's own tools, which is the regression Task 4 exists to prevent:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow
CROW_HOME=/home/kh0pp/.crow-r4 node -e "
import('./scripts/pi-bots/ext_registry.mjs').then(async m=>{
  const { readCanonicalMcp } = await import('./scripts/pi-bots/mcp_writer.mjs');
  const s = m.serversForProbe(readCanonicalMcp(), '/home/kh0pp/.crow-r4');
  console.log('picker offers:', Object.keys(s).sort().join(', '));
  console.log(s['crow-memory'] ? 'PASS crow-memory still offered' : 'FAIL crow-memory missing');
});"
```

Finally, clean up the askpass helper:

```bash
rm -f "$ASKPASS"
```

---

## Notes for the implementer

- **`crow-storage` and `crow-sharing` are catalog-only.** No bot selects either. `crow-storage` lands in `unconfigured` because `loadEnv()` reads only `<repo>/.env`, which has no `MINIO_*` keys, and no instance has its own `.env`. That is expected, not a bug to chase.
- **`installed.json` is deliberately not consulted.** r4's lists neither `tasks` nor `bots-sql-mcp` although both bundle dirs and `mcp-addons.json` entries exist. This design keys off the bundle directory, which is the operative truth for spawning. Making `installed.json` authoritative would strip `r4-assistant`'s tools — the workaround that was explicitly rejected.
- **The board arc is not this work.** The scope document lives in Gitea `kh0pper/crow-engineering`, branch `docs/board-truth-and-visual-language-scope`. Do not start Track 0 here.
