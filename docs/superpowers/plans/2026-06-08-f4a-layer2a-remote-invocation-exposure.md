# F4a Layer 2a — Remote Invocation Exposure + Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **RESOURCE NOTE (crow froze twice during the Layer 1 build):** crow runs a heavy always-on LLM stack. Execute this plan **single-threaded** — ONE implementer subagent at a time, NO concurrent fan-out. All tests here use stubs/temp dirs; never spawn live MCP probes or `forwardSignedRequest` against real peers. If memory pressure appears, pause and check `free -h`. (The model docker containers should already be stopped for this build; restart them after.)

**Goal:** Make cross-instance tool invocation **safe** by adding a per-instance, default-deny exposure allowlist enforced server-side: a trusted peer may invoke only the capabilities this instance has explicitly exposed.

**Architecture:** A local-only setting `remote_exposed_tools` (never synced) holds the canonical capability ids this instance exposes. A pure resolver maps an inbound MCP `tools/call` (by mount prefix / router category tool / proxy tool name) to its owning `canonicalId`; an enforcement gate on the instance-auth MCP path (`routes/mcp.js`) allows the call only if that id is exposed, else rejects + audits (default-deny). The Layer 1 capability catalog gains an `exposed` boolean (producer + receive-side validator parity) so peers' Bot Builders know what's selectable (consumed in L2b). A Settings section lets the operator toggle exposure per capability.

**Tech Stack:** Node.js ESM, `node:test`, Express, libsql. Reuses Layer 1 (`capability-registry.js`, `capabilities-cache.js`), the settings registry (`readSetting`/`writeSetting`), `auditCrossHostCall`, and the existing `req.instanceAuth` instance-auth path.

**Spec:** `docs/superpowers/specs/2026-06-08-f4a-layer2a-remote-invocation-exposure-design.md`

**Conventions (every commit):** `git commit <explicit paths> -m "..."` (never `git add -A` + bare commit); verify `git show --stat HEAD` after each commit; never add Claude as co-author; `git pull --rebase` before any push. Branch `feat/f4a-layer2a-remote-invocation` (already created off `main` @ `d8a9030`).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `servers/gateway/peer-exposure.js` | `getExposedCapabilities` (read setting → Set), `resolveCalledCanonicalId` (pure prefix/body → canonicalId), `enforcePeerExposure` (the gate) | Create |
| `tests/exposure-allowlist.test.js` | `getExposedCapabilities` parse + malformed→deny-all | Create |
| `tests/peer-invocation-gate.test.js` | resolver + gate: default-deny, exposed passes, local-operator unaffected, non-`tools/call` allowed, audit on deny | Create |
| `servers/gateway/capability-registry.js` | `toPublicTool` gains `exposed`; `getLocalCatalog` consults exposure set | Modify |
| `tests/public-projection.test.js` | extend expected key set with `exposed` (Layer 1 test) | Modify |
| `tests/capability-registry.test.js` | assert `exposed` flag wiring | Modify |
| `servers/gateway/dashboard/capabilities-cache.js` | `vTool` preserves `exposed` boolean (producer↔validator parity) | Modify |
| `tests/capabilities-cache.test.js` | assert `vTool` preserves `exposed` | Modify |
| `servers/gateway/routes/mcp.js` | `mountMcpServer` gains optional `peerGate`; run it in `skipAuthForInstance` | Modify |
| `servers/gateway/index.js` | build the gate closure (db + connectedServers) + pass to every authed `mountMcpServer` | Modify |
| `servers/gateway/dashboard/settings/sections/remote-exposure.js` | operator toggle UI per capability | Create |
| `servers/gateway/dashboard/panels/settings.js` | import + register the section | Modify |
| `servers/gateway/dashboard/shared/i18n.js` | add `settings.section.remoteExposure` label | Modify |

**Reference shapes (verified — read while implementing):**
- `readSetting(db, key)` / `writeSetting(db, key, value, { scope })` (`settings/registry.js:142,188`). `writeSetting` with a key **not** in `SYNC_ALLOWLIST` auto-downgrades to `local` scope (per-instance, never synced) — exactly what we want; `remote_exposed_tools` is deliberately absent from `sync-allowlist.js`.
- `toPublicTool(entry)` today returns `{ canonicalId, category, name, bundleId, toolCount }` (`capability-registry.js:20`). `getLocalCatalog(db, { crowHome, instanceId, instanceName })` builds `tools = [...coreTools(), ...addonTools(crowHome)].map(toPublicTool)` (`:101`).
- `vTool(t)` in `capabilities-cache.js:22` is the receive-side validator; `validateCapabilitiesEnvelope` runs it over `c.tools`.
- Instance-auth path: `skipAuthForInstance` in `mountMcpServer` (`routes/mcp.js:223-239`) fires when `req.instanceAuth?.instance` is set, synthesizing `req.auth` with scope `mcp:tools`. `prefix` is in closure scope. `req.body` is already JSON-parsed (the `toolTrackMiddleware` reads `req.body?.method`).
- `mountMcpServer` call sites (`index.js`): `/memory`, `/projects`, `/research`, `/sharing`, `/tools-<name>` (per-client proxies), `/tools`, `""` (root → memory), `/router`, `/storage`, `/blog-mcp` — all with `authMiddleware`. `/wm` is mounted with `null` authMiddleware (no instance auth → no gate needed).
- `connectedServers` (`proxy.js:25`, exported; already imported in `index.js:81`): `Map<id, { client, tools:[{name,...}], status, isAddon?, isRemote?, instanceId? }>`. Addon entries have `isAddon:true` and the map **key === addon canonicalId** (`proxy.js:223` uses the addon `id`).
- Router category tools (`router.js:172`): `crow_<category>` (e.g. `crow_memory`); plus `crow_tools` (args `{action, params, instance_id}`) and `crow_discover`. The MCP `tools/call` body is `{ method:"tools/call", params:{ name:"crow_tools", arguments:{action, instance_id, ...} }, id }`.
- `auditCrossHostCall(db, { sourceInstanceId, targetInstanceId, direction, action, bundleId, actor, httpStatus, error })` (`cross-host-auth.js:226`); never throws. Inbound calls use `direction:"inbound"` (`dashboard/index.js:477`).
- `getOrCreateLocalInstanceId()` from `../instance-registry.js` (used throughout the gateway).
- Settings section module shape (`sections/unified-dashboard.js`): default-export `{ id, group, icon, labelKey, navOrder, getPreview({settings}), render({db}), handleAction({req,res,db,action}) }`; registered by importing into `panels/settings.js` + `registerSettingsSection(...)`. `group:"multiInstance"` places it beside paired-instances/unified-dashboard. `t(key)` (`i18n.js:747`) falls back to the raw key if missing.

**Canonical-id resolution table (the security core — encode exactly):**

| Inbound prefix | Called tool | → canonicalId |
|---|---|---|
| `/memory`, `` (root) | any | `crow-memory` |
| `/projects`, `/research` | any | `crow-projects` |
| `/sharing` | any | `crow-sharing` |
| `/storage` | any | `crow-storage` |
| `/blog-mcp` | any | `crow-blog` |
| `/router` | `crow_discover` | `__allow__` (discovery) |
| `/router` | `crow_<cat>` | `crow-<cat>` |
| `/router` | `crow_tools` w/ `arguments.instance_id` | `null` (onward relay — deny this hop) |
| `/router` | `crow_tools` w/o instance_id | resolve `arguments.action` via `connectedServers` → owning id, else `null` |
| `/tools`, `/tools-<name>` | tool name | resolve `params.name` via `connectedServers` → owning id, else `null` |
| anything else | — | `null` (fail closed) |

`null` ⇒ deny. `__allow__` ⇒ pass (not a gated capability call). Any resolved id is allowed only if it ∈ exposed set.

---

## Task 1: Exposure allowlist helper + the enforcement module (no wiring yet)

**Files:**
- Create: `servers/gateway/peer-exposure.js`
- Test: `tests/exposure-allowlist.test.js`, `tests/peer-invocation-gate.test.js`

- [ ] **Step 1: Write the failing helper test**

Create `tests/exposure-allowlist.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getExposedCapabilities, EXPOSURE_SETTING_KEY } from "../servers/gateway/peer-exposure.js";

// Minimal db stub: returns whatever readSetting would read for the exposure key.
function dbReturning(value) {
  return {
    async execute({ sql }) {
      // readSetting checks overrides first, then dashboard_settings.
      // Return the value on the global-row query, empty on the override query.
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      return { rows: value === undefined ? [] : [{ value }] };
    },
  };
}

test("parses a JSON array into a Set of canonical ids", async () => {
  const set = await getExposedCapabilities(dbReturning(JSON.stringify(["crow-memory", "texas-gov-data"])));
  assert.ok(set instanceof Set);
  assert.ok(set.has("crow-memory"));
  assert.ok(set.has("texas-gov-data"));
  assert.equal(set.size, 2);
});

test("absent setting → empty set (deny all)", async () => {
  const set = await getExposedCapabilities(dbReturning(undefined));
  assert.equal(set.size, 0);
});

test("malformed JSON → empty set (deny all)", async () => {
  const set = await getExposedCapabilities(dbReturning("{not json"));
  assert.equal(set.size, 0);
});

test("non-array JSON (object/string/number) → empty set", async () => {
  assert.equal((await getExposedCapabilities(dbReturning(JSON.stringify({ a: 1 })))).size, 0);
  assert.equal((await getExposedCapabilities(dbReturning(JSON.stringify("crow-memory")))).size, 0);
});

test("array with non-string / empty entries → only valid strings kept", async () => {
  const set = await getExposedCapabilities(dbReturning(JSON.stringify(["crow-memory", "", null, 5, "crow-blog"])));
  assert.deepEqual([...set].sort(), ["crow-blog", "crow-memory"]);
});

test("exposes the setting key constant", () => {
  assert.equal(EXPOSURE_SETTING_KEY, "remote_exposed_tools");
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/exposure-allowlist.test.js`
Expected: FAIL — `Cannot find module '../servers/gateway/peer-exposure.js'`.

- [ ] **Step 3: Write the resolver + gate test (the security keystone)**

Create `tests/peer-invocation-gate.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCalledCanonicalId, enforcePeerExposure } from "../servers/gateway/peer-exposure.js";

const callBody = (name, args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args || {} } });

// --- resolver (pure) ---
test("core prefixes map to canonical ids", () => {
  assert.equal(resolveCalledCanonicalId("/memory", callBody("crow_store_memory")), "crow-memory");
  assert.equal(resolveCalledCanonicalId("", callBody("crow_store_memory")), "crow-memory");
  assert.equal(resolveCalledCanonicalId("/projects", callBody("x")), "crow-projects");
  assert.equal(resolveCalledCanonicalId("/research", callBody("x")), "crow-projects");
  assert.equal(resolveCalledCanonicalId("/sharing", callBody("x")), "crow-sharing");
  assert.equal(resolveCalledCanonicalId("/storage", callBody("x")), "crow-storage");
  assert.equal(resolveCalledCanonicalId("/blog-mcp", callBody("x")), "crow-blog");
});

test("router category tool → crow-<cat>; discover allowed; relay denied", () => {
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_memory")), "crow-memory");
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_blog")), "crow-blog");
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_discover")), "__allow__");
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_tools", { instance_id: "p2", action: "x" })), null);
});

test("non-tools/call methods are not gated (allow)", () => {
  assert.equal(resolveCalledCanonicalId("/memory", { method: "tools/list", id: 1 }), "__allow__");
  assert.equal(resolveCalledCanonicalId("/memory", { method: "initialize", id: 1 }), "__allow__");
  assert.equal(resolveCalledCanonicalId("/router", {}), "__allow__");
});

test("proxy/addon tool resolves via connectedServers; unknown → null", () => {
  const connected = new Map([
    ["texas-gov-data", { isAddon: true, status: "connected", tools: [{ name: "tx_query" }, { name: "tx_lookup" }] }],
    ["trello", { status: "connected", tools: [{ name: "add_card" }] }],
  ]);
  assert.equal(resolveCalledCanonicalId("/tools", callBody("tx_query"), connected), "texas-gov-data");
  assert.equal(resolveCalledCanonicalId("/tools-readonly", callBody("tx_lookup"), connected), "texas-gov-data");
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_tools", { action: "add_card" }), connected), "trello");
  assert.equal(resolveCalledCanonicalId("/tools", callBody("does_not_exist"), connected), null);
});

test("unknown prefix → null (fail closed)", () => {
  assert.equal(resolveCalledCanonicalId("/mystery", callBody("x")), null);
});

// --- gate (enforcePeerExposure) ---
function fakeRes() {
  return {
    statusCode: null, body: null, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.headersSent = true; return this; },
    type() { return this; },
  };
}

test("local-operator call (no instanceAuth) is never gated → allowed, no audit", async () => {
  const req = { body: callBody("crow_store_memory") }; // no req.instanceAuth
  const res = fakeRes();
  let audited = false;
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(), auditFn: async () => { audited = true; },
  });
  assert.equal(allowed, true);
  assert.equal(res.headersSent, false);
  assert.equal(audited, false);
});

test("peer call to a non-exposed capability is rejected + audited (default-deny)", async () => {
  const req = { body: callBody("crow_store_memory"), instanceAuth: { instance: { id: "peer-1" } } };
  const res = fakeRes();
  let rec = null;
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(), // memory NOT exposed
    auditFn: async (_db, r) => { rec = r; },
  });
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, -32001);
  assert.ok(rec && rec.error === "not_exposed");
  assert.equal(rec.direction, "inbound");
  assert.equal(rec.sourceInstanceId, "peer-1");
  assert.equal(rec.bundleId, "crow-memory");
});

test("peer call to an exposed capability passes (and audits allow)", async () => {
  const req = { body: callBody("crow_store_memory"), instanceAuth: { instance: { id: "peer-1" } } };
  const res = fakeRes();
  let rec = null;
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(["crow-memory"]),
    auditFn: async (_db, r) => { rec = r; },
  });
  assert.equal(allowed, true);
  assert.equal(res.headersSent, false);
  assert.ok(rec && rec.httpStatus === 200 && !rec.error);
});

test("peer tools/list is allowed (discovery) without exposure", async () => {
  const req = { body: { method: "tools/list", id: 9 }, instanceAuth: { instance: { id: "peer-1" } } };
  const res = fakeRes();
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(), auditFn: async () => {},
  });
  assert.equal(allowed, true);
  assert.equal(res.headersSent, false);
});

test("unresolvable peer tools/call is denied (fail closed)", async () => {
  const req = { body: callBody("whatever"), instanceAuth: { instance: { id: "peer-1" } } };
  const res = fakeRes();
  const allowed = await enforcePeerExposure({
    prefix: "/mystery", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(["crow-memory"]), auditFn: async () => {},
  });
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 403);
});
```

- [ ] **Step 4: Run it — expect failure (module missing)**

Run: `node --test tests/peer-invocation-gate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `peer-exposure.js`**

Create `servers/gateway/peer-exposure.js`:

```js
/**
 * F4a Layer 2a — cross-instance invocation exposure + enforcement.
 *
 * The trust boundary for remote tool invocation. A trusted peer instance
 * (req.instanceAuth.instance) may invoke a tool ONLY if its owning capability
 * canonicalId is in this instance's `remote_exposed_tools` allowlist.
 * DEFAULT-DENY: nothing is invocable by a peer until the operator exposes it.
 *
 * This gate is the security keystone — it enforces server-side, independent of
 * any UI affordance, even against a peer crafting a raw JSON-RPC call to any
 * mounted MCP endpoint. The catalog `exposed` flag is convenience, NOT the
 * boundary. Local-operator calls are never gated here (they don't carry
 * req.instanceAuth.instance).
 */
import { readSetting } from "./dashboard/settings/registry.js";
import { getOrCreateLocalInstanceId } from "./instance-registry.js";
import { auditCrossHostCall } from "../shared/cross-host-auth.js";

/** Local-only (never-synced) setting key. Deliberately absent from sync-allowlist.js. */
export const EXPOSURE_SETTING_KEY = "remote_exposed_tools";

/**
 * Read the exposure allowlist → Set<canonicalId>. Tolerates absent/malformed
 * settings by returning an empty set (deny-all). Never throws.
 */
export async function getExposedCapabilities(db) {
  let raw;
  try { raw = await readSetting(db, EXPOSURE_SETTING_KEY); } catch { return new Set(); }
  if (raw == null) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((x) => typeof x === "string" && x.length > 0));
}

// Mount prefix → canonical capability id, for prefixes where ALL tools belong
// to one capability. Root "" is the single-server memory mount.
const PREFIX_CANON = {
  "memory": "crow-memory",
  "": "crow-memory",
  "projects": "crow-projects",
  "research": "crow-projects",
  "sharing": "crow-sharing",
  "storage": "crow-storage",
  "blog-mcp": "crow-blog",
};

/** Find the connectedServers id whose tool list contains `toolName`. */
function resolveProxyTool(toolName, connectedServers) {
  if (!toolName || !connectedServers) return null;
  for (const [id, entry] of connectedServers) {
    if (entry && Array.isArray(entry.tools) && entry.tools.some((t) => t && t.name === toolName)) {
      return id; // addon entries are keyed by their canonical id (proxy.js)
    }
  }
  return null;
}

/**
 * Resolve the canonical capability id a peer call targets.
 * @returns {string|null|"__allow__"} canonicalId to check; null = deny (fail
 *   closed); "__allow__" = ungated (discovery / non-tools-call method).
 */
export function resolveCalledCanonicalId(prefix, body, connectedServers) {
  if (!body || body.method !== "tools/call") return "__allow__";
  const toolName = body.params?.name;
  const p = String(prefix || "").replace(/^\//, "");

  if (Object.prototype.hasOwnProperty.call(PREFIX_CANON, p)) return PREFIX_CANON[p];

  if (p === "router") {
    if (toolName === "crow_discover") return "__allow__";
    if (toolName === "crow_tools") {
      const args = body.params?.arguments || {};
      if (args.instance_id) return null; // onward relay to a third instance — deny this hop
      return resolveProxyTool(args.action, connectedServers);
    }
    if (typeof toolName === "string" && toolName.startsWith("crow_")) {
      return `crow-${toolName.slice("crow_".length)}`;
    }
    return null;
  }

  if (p === "tools" || p.startsWith("tools-")) {
    return resolveProxyTool(toolName, connectedServers);
  }

  return null; // unknown prefix — fail closed
}

const DENY_CODE = -32001;

/**
 * Enforcement gate for the instance-auth MCP path. Returns true to proceed,
 * false if the call was rejected (this fn already wrote the JSON-RPC error).
 *
 * @param {object} o
 * @param {string} o.prefix mount prefix (closure-bound in mountMcpServer)
 * @param {object} o.req express req (reads req.instanceAuth, req.body)
 * @param {object} o.res express res
 * @param {object} o.db libsql client (for exposure read + audit)
 * @param {Map} o.connectedServers proxy map (for addon/proxy resolution)
 * @param {Set<string>} [o.exposedSetOverride] test hook — skip the db read
 * @param {Function} [o.auditFn] test hook — defaults to auditCrossHostCall
 */
export async function enforcePeerExposure({ prefix, req, res, db, connectedServers, exposedSetOverride, auditFn = auditCrossHostCall }) {
  // Only peer-instance callers are gated. Local-operator calls don't carry this.
  if (!req?.instanceAuth?.instance) return true;

  const body = req.body;
  const canonicalId = resolveCalledCanonicalId(prefix, body, connectedServers);
  if (canonicalId === "__allow__") return true; // discovery / non-tools-call

  const exposed = exposedSetOverride || await getExposedCapabilities(db);
  const allowed = typeof canonicalId === "string" && exposed.has(canonicalId);

  const sourceId = req.instanceAuth.instance.id;
  let localId = null;
  try { localId = getOrCreateLocalInstanceId(); } catch { /* best-effort */ }
  const toolName = body?.params?.name || null;

  // Audit every peer tools/call decision (never throws).
  try {
    await auditFn(db, {
      sourceInstanceId: sourceId,
      targetInstanceId: localId,
      direction: "inbound",
      action: `tools/call:${toolName || "?"}`,
      bundleId: canonicalId || null,
      actor: `instance:${sourceId}`,
      httpStatus: allowed ? 200 : 403,
      error: allowed ? null : "not_exposed",
    });
  } catch { /* audit must not break the path */ }

  if (allowed) return true;

  if (!res.headersSent) {
    res.status(403).json({
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code: DENY_CODE, message: "Tool not exposed for remote invocation by this instance" },
    });
  }
  return false;
}
```

- [ ] **Step 6: Run both tests — expect pass**

Run: `node --test tests/exposure-allowlist.test.js tests/peer-invocation-gate.test.js`
Expected: PASS — all tests, fail 0.

- [ ] **Step 7: Commit**

```bash
git commit servers/gateway/peer-exposure.js tests/exposure-allowlist.test.js tests/peer-invocation-gate.test.js \
  -m "F4a L2a: exposure allowlist helper + peer-invocation resolver + enforcement gate"
git show --stat HEAD
```

---

## Task 2: Catalog `exposed` flag (Layer 1 extension) + validator parity

**Files:**
- Modify: `servers/gateway/capability-registry.js`, `servers/gateway/dashboard/capabilities-cache.js`
- Test: `tests/public-projection.test.js`, `tests/capability-registry.test.js`, `tests/capabilities-cache.test.js`

- [ ] **Step 1: Update the Layer 1 projection test to expect `exposed`**

In `tests/public-projection.test.js`, the `toPublicTool` test asserts the exact key set. Update it to include `exposed` and assert default `false`. Find:

```js
test("toPublicTool drops env/keys/command/args", () => {
  const pub = toPublicTool({
    canonicalId: "texas-gov-data", category: "tools", name: "texas-gov-data", bundleId: "texas-gov-data", toolCount: 5,
    block: { command: "/usr/bin/uv", args: ["run", "x"], env: { API_KEY: "sekret" } },
  });
  assert.deepEqual(Object.keys(pub).sort(), ["bundleId", "canonicalId", "category", "name", "toolCount"].sort());
  assert.ok(!JSON.stringify(pub).includes("sekret"));
  assert.ok(!JSON.stringify(pub).includes("API_KEY"));
});
```

Replace its body with:

```js
test("toPublicTool drops env/keys/command/args", () => {
  const pub = toPublicTool({
    canonicalId: "texas-gov-data", category: "tools", name: "texas-gov-data", bundleId: "texas-gov-data", toolCount: 5,
    block: { command: "/usr/bin/uv", args: ["run", "x"], env: { API_KEY: "sekret" } },
  });
  assert.deepEqual(Object.keys(pub).sort(), ["bundleId", "canonicalId", "category", "exposed", "name", "toolCount"].sort());
  assert.equal(pub.exposed, false, "default exposed:false when no exposure set passed");
  assert.ok(!JSON.stringify(pub).includes("sekret"));
  assert.ok(!JSON.stringify(pub).includes("API_KEY"));
});

test("toPublicTool sets exposed:true when canonicalId is in the exposure set", () => {
  const set = new Set(["texas-gov-data"]);
  const pub = toPublicTool({ canonicalId: "texas-gov-data", category: "tools", name: "T", bundleId: "texas-gov-data", toolCount: 5 }, set);
  assert.equal(pub.exposed, true);
  const other = toPublicTool({ canonicalId: "crow-memory", category: "memory", name: "Memory", bundleId: null, toolCount: 9 }, set);
  assert.equal(other.exposed, false);
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/public-projection.test.js`
Expected: FAIL — current `toPublicTool` has no `exposed` key (deepEqual mismatch) and ignores the second arg.

- [ ] **Step 3: Add `exposed` to `toPublicTool` and thread the set through `getLocalCatalog`**

In `servers/gateway/capability-registry.js`:

(a) Add the import at the top (after the existing imports):

```js
import { getExposedCapabilities } from "./peer-exposure.js";
```

(b) Replace `toPublicTool`:

```js
export function toPublicTool(entry, exposedSet) {
  const canonicalId = entry.canonicalId;
  return {
    canonicalId,
    category: entry.category,
    name: entry.name,
    bundleId: entry.bundleId ?? null,
    toolCount: entry.toolCount ?? null,
    exposed: exposedSet instanceof Set ? exposedSet.has(canonicalId) : false,
  };
}
```

(c) In `getLocalCatalog`, read the exposure set once and pass it to each `toPublicTool`:

```js
export async function getLocalCatalog(db, { crowHome = resolveCrowHome(), instanceId = null, instanceName = null } = {}) {
  const exposedSet = await getExposedCapabilities(db);
  const tools = [...coreTools(), ...addonTools(crowHome)].map((e) => toPublicTool(e, exposedSet));
  const skills = localSkills(crowHome).map(toPublicSkill);
  const bots = (await localBots(db)).map(toPublicBot);
  return { instanceId, instanceName, tools, skills, bots };
}
```

- [ ] **Step 4: Run the projection test — expect pass**

Run: `node --test tests/public-projection.test.js`
Expected: PASS.

- [ ] **Step 5: Extend the aggregator test to cover `exposed` wiring**

In `tests/capability-registry.test.js`, the stub `db.execute()` returns bot rows for any query. `getLocalCatalog` now also calls `readSetting` (via `getExposedCapabilities`), which runs `db.execute` — the existing stub returns bot rows for that too, so `JSON.parse("<bot row value>")` would be attempted on `rows[0].value` (undefined) → `getExposedCapabilities` returns empty set (null/undefined raw → empty). That is the deny-all default and is fine. Add an explicit test that a configured exposure set flips the flag. Append:

```js
test("catalog reflects the exposure set on tool entries", async () => {
  // db stub: exposure setting returns ["crow-memory"]; bot query returns [].
  const exposingDb = {
    async execute({ sql }) {
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/FROM dashboard_settings\b/.test(sql)) return { rows: [{ value: JSON.stringify(["crow-memory"]) }] };
      return { rows: [] }; // pi_bot_defs
    },
  };
  const cat = await getLocalCatalog(exposingDb, { crowHome: "/tmp/nonexistent-crowhome", instanceId: "self" });
  const mem = cat.tools.find((t) => t.canonicalId === canonicalForCategory("memory"));
  assert.equal(mem.exposed, true);
  const others = cat.tools.filter((t) => t.canonicalId !== "crow-memory");
  assert.ok(others.every((t) => t.exposed === false), "non-exposed tools are exposed:false");
});
```

- [ ] **Step 6: Run it — expect pass**

Run: `node --test tests/capability-registry.test.js`
Expected: PASS (the original two tests + the new one). Note: the original tests use a stub whose `execute` returns bot rows for every query; `getExposedCapabilities` reads `rows[0].value` which is undefined for those stubs → empty set → `exposed:false`, harmless.

- [ ] **Step 7: Add `exposed` to the receive-side validator `vTool`**

In `servers/gateway/dashboard/capabilities-cache.js`, replace `vTool`:

```js
function vTool(t) {
  if (!t || typeof t !== "object") return null;
  const canonicalId = str(t.canonicalId);
  const name = str(t.name);
  if (!canonicalId || !name) return null;
  return {
    canonicalId,
    category: str(t.category),
    name,
    bundleId: t.bundleId == null ? null : str(t.bundleId),
    toolCount: num(t.toolCount),
    exposed: !!t.exposed,
  };
}
```

- [ ] **Step 8: Assert validator parity in the cache test**

In `tests/capabilities-cache.test.js`, the first test (`validateCapabilitiesEnvelope accepts a well-formed payload`) sends a tool without `exposed`. Add a dedicated parity test. Append:

```js
test("validateCapabilitiesEnvelope preserves the exposed boolean (producer↔validator parity)", () => {
  const ok = validateCapabilitiesEnvelope({
    instance: { id: "abc", name: "Crow" },
    capabilities: {
      tools: [
        { canonicalId: "crow-memory", category: "memory", name: "Memory", bundleId: null, toolCount: 5, exposed: true },
        { canonicalId: "crow-blog", category: "blog", name: "Blog", bundleId: null, toolCount: 3 }, // missing → false
      ],
      skills: [], bots: [],
    },
    generatedAt: "t",
  });
  assert.equal(ok.capabilities.tools[0].exposed, true);
  assert.equal(ok.capabilities.tools[1].exposed, false);
});
```

- [ ] **Step 9: Run the cache test — expect pass**

Run: `node --test tests/capabilities-cache.test.js`
Expected: PASS — the existing 4 tests + the new parity test.

- [ ] **Step 10: Commit**

```bash
git commit servers/gateway/capability-registry.js servers/gateway/dashboard/capabilities-cache.js \
  tests/public-projection.test.js tests/capability-registry.test.js tests/capabilities-cache.test.js \
  -m "F4a L2a: catalog exposed flag (toPublicTool + getLocalCatalog) + vTool validator parity"
git show --stat HEAD
```

---

## Task 3: Wire the enforcement gate into the instance-auth MCP path

**Files:**
- Modify: `servers/gateway/routes/mcp.js`, `servers/gateway/index.js`

This is the wiring step — the gate logic + its unit tests landed in Task 1. Here we add an optional `peerGate` to `mountMcpServer` and build the real gate (db + connectedServers) in `index.js`.

- [ ] **Step 1: Add the `peerGate` param to `mountMcpServer` and run it in `skipAuthForInstance`**

In `servers/gateway/routes/mcp.js`, change the signature and the instance-auth branch.

Signature (`:185`) — add `peerGate`:

```js
export function mountMcpServer(router, prefix, createServer, sessionManager, authMiddleware, peerGate) {
```

Replace the `skipAuthForInstance` definition (`:223-234`) with an async version that consults the gate **before** synthesizing `req.auth`:

```js
    const skipAuthForInstance = async (req, res, next) => {
      if (req.instanceAuth?.instance) {
        // F4a Layer 2a: default-deny exposure gate. A trusted peer may invoke
        // only capabilities this instance has exposed. Runs only for peer
        // callers; local-operator calls take the authMiddleware branch below
        // and are never gated here. The gate writes its own JSON-RPC error on
        // deny, so we just stop.
        if (peerGate) {
          let allowed = true;
          try { allowed = await peerGate(prefix, req, res); }
          catch (err) {
            console.warn(`[mcp] peer exposure gate error (${prefix}):`, err.message);
            allowed = false; // fail closed
            if (!res.headersSent) {
              res.status(403).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32001, message: "Exposure check failed" } });
            }
          }
          if (!allowed) return;
        }
        req.auth = {
          token: "peer-instance",
          clientId: `instance:${req.instanceAuth.instance.id}`,
          scopes: ["mcp:tools"],
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        };
        return next();
      }
      return authMiddleware(req, res, next);
    };
```

(The `router.post/get/delete` lines that reference `skipAuthForInstance` are unchanged — Express awaits async middleware that returns a promise.)

- [ ] **Step 2: Syntax check**

Run: `node --check servers/gateway/routes/mcp.js`
Expected: exit 0.

- [ ] **Step 3: Build the gate in `index.js` and pass it to every authed mount**

In `servers/gateway/index.js`:

(a) Add the import (with the other gateway imports near `:67-81`):

```js
import { enforcePeerExposure } from "./peer-exposure.js";
```

(b) Define the gate closure once, **before** the first `mountMcpServer(...)` call (i.e. before `:676`). It opens a short-lived db client per peer call (matching the per-request `createDbClient()` pattern used elsewhere in this file) and passes the live `connectedServers` map:

```js
// F4a Layer 2a: shared default-deny exposure gate for all peer-instance MCP
// calls. Bound once; mountMcpServer passes the mount prefix per call.
const peerExposureGate = async (prefix, req, res) => {
  if (!req.instanceAuth?.instance) return true; // fast path: not a peer call
  const db = createDbClient();
  try {
    return await enforcePeerExposure({ prefix, req, res, db, connectedServers });
  } finally {
    try { db.close(); } catch {}
  }
};
```

(c) Append `peerExposureGate` as the 6th argument to **every** `mountMcpServer(...)` call that currently passes `authMiddleware`. These are (verify each line):

```
servers/gateway/index.js:676  /memory
servers/gateway/index.js:678  /projects
servers/gateway/index.js:680  /research
servers/gateway/index.js:681  /sharing
servers/gateway/index.js:704  /tools-${name}
servers/gateway/index.js:712  /tools
servers/gateway/index.js:715  "" (root)
servers/gateway/index.js:719  /router
servers/gateway/index.js:738  /storage
servers/gateway/index.js:755  /blog-mcp
```

Each becomes e.g.:

```js
mountMcpServer(app, "/memory", () => createMemoryServer(undefined, { instructions, syncManager }), sessionManager, authMiddleware, peerExposureGate);
```

Do **not** add the gate to the `/wm` mount (`:787`) — it passes `null` for authMiddleware (no instance auth path).

- [ ] **Step 4: Syntax check + grep the wiring**

```bash
node --check servers/gateway/index.js
grep -n "mountMcpServer(app" servers/gateway/index.js
```
Expected: exit 0; every authed mount line ends with `, peerExposureGate);` except `/wm` (which keeps `, null);`).

- [ ] **Step 5: Boot smoke (gateway starts cleanly with the gate wired)**

```bash
timeout 12 node servers/gateway/index.js --no-auth > /tmp/l2a-boot.log 2>&1; echo "exit=$?"
grep -iE "Router server mounted|listening|mount /tools|error|throw|cannot find" /tmp/l2a-boot.log | head -20
```
Expected: mounts log normally, no `Cannot find module` / unhandled throw. (`timeout` killing it after 12s is fine — we only need clean startup. A non-zero exit from `timeout` is expected.)

- [ ] **Step 6: Re-run the gate unit tests (still green after wiring)**

Run: `node --test tests/peer-invocation-gate.test.js tests/exposure-allowlist.test.js`
Expected: PASS, fail 0.

- [ ] **Step 7: Commit**

```bash
git commit servers/gateway/routes/mcp.js servers/gateway/index.js \
  -m "F4a L2a: wire default-deny peer-exposure gate into instance-auth MCP path"
git show --stat HEAD
```

---

## Task 4: Settings exposure section

**Files:**
- Create: `servers/gateway/dashboard/settings/sections/remote-exposure.js`
- Modify: `servers/gateway/dashboard/panels/settings.js`, `servers/gateway/dashboard/shared/i18n.js`

- [ ] **Step 1: Add the i18n label**

In `servers/gateway/dashboard/shared/i18n.js`, beside the other `settings.section.*` entries (around `:626-636`), add:

```js
  "settings.section.remoteExposure": { en: "Remote Tool Exposure", es: "Exposición de herramientas remotas" },
```

- [ ] **Step 2: Create the section**

Create `servers/gateway/dashboard/settings/sections/remote-exposure.js`:

```js
/**
 * Settings Section: Remote Tool Exposure (Multi-Instance group) — F4a Layer 2a.
 *
 * Per-instance, LOCAL-ONLY (never synced) allowlist of capabilities this
 * instance lets trusted peer instances invoke. Default = nothing exposed
 * (deny-all). The authoritative enforcement is server-side in
 * peer-exposure.js; this UI only edits the `remote_exposed_tools` setting.
 *
 * `remote_exposed_tools` is deliberately ABSENT from sync-allowlist.js, so
 * writeSetting downgrades it to local scope automatically — each instance is
 * sovereign over what it exposes.
 */
import { readSetting, writeSetting } from "../registry.js";
import { getLocalCatalog } from "../../../capability-registry.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { escapeHtml } from "../../shared/escape.js";

async function readExposed(db) {
  const raw = await readSetting(db, "remote_exposed_tools");
  if (raw == null) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch { return new Set(); }
}

export default {
  id: "remote-exposure",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6"/><path d="M4.2 4.2l4.2 4.2m6.4 6.4l4.2 4.2"/><path d="M1 12h6m6 0h6"/></svg>`,
  labelKey: "settings.section.remoteExposure",
  navOrder: 6,

  async getPreview({ db }) {
    const exposed = await readExposed(db);
    return exposed.size === 0 ? "none exposed" : `${exposed.size} exposed`;
  },

  async render({ db }) {
    const exposed = await readExposed(db);
    const catalog = await getLocalCatalog(db, { instanceId: getOrCreateLocalInstanceId() });
    // Distinct capabilities by canonicalId (core categories + installed addons).
    const seen = new Set();
    const caps = [];
    for (const t of catalog.tools) {
      if (!t.canonicalId || seen.has(t.canonicalId)) continue;
      seen.add(t.canonicalId);
      caps.push(t);
    }
    caps.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const rows = caps.map((c) => {
      const on = exposed.has(c.canonicalId);
      return `<label style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--crow-border,#2222)">
        <input type="checkbox" name="cap" value="${escapeHtml(c.canonicalId)}" ${on ? "checked" : ""}>
        <span style="flex:1">${escapeHtml(c.name)} <span style="color:var(--crow-text-muted);font-size:0.85rem">(${escapeHtml(c.category)}${c.bundleId ? " · addon" : ""})</span></span>
        <code style="color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(c.canonicalId)}</code>
      </label>`;
    }).join("");

    return `<form method="POST">
      <input type="hidden" name="action" value="set_remote_exposure">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        Choose which capabilities <strong>trusted paired instances</strong> may invoke on this
        instance. Exposing a capability lets a peer's bots/agents run its tools here;
        destructive tools still require their in-tool confirmation. Nothing is exposed by
        default. <strong>This setting is local to this instance and never synced.</strong>
      </div>
      <div style="border:1px solid var(--crow-border,#2222);border-radius:8px;padding:0 0.8rem">
        ${rows || '<p style="color:var(--crow-text-muted);padding:0.8rem 0">No capabilities found on this instance.</p>'}
      </div>
      <div style="margin-top:1.5rem">
        <button type="submit" class="btn btn-secondary">Save exposure</button>
      </div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_remote_exposure") return false;
    // Checkboxes: req.body.cap is a string (one) or array (many) or undefined (none).
    let selected = req.body.cap;
    if (selected == null) selected = [];
    else if (!Array.isArray(selected)) selected = [selected];
    const clean = [...new Set(selected.filter((x) => typeof x === "string" && x.length > 0))];
    // Local scope (not in sync-allowlist → writeSetting downgrades anyway; be explicit).
    await writeSetting(db, "remote_exposed_tools", JSON.stringify(clean), { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=remote-exposure");
    return true;
  },
};
```

- [ ] **Step 3: Verify `escapeHtml` import path**

Run: `grep -rn "export function escapeHtml\|export const escapeHtml" servers/gateway/dashboard/shared/escape.js`
Expected: a match. If `escapeHtml` is NOT in `shared/escape.js`, find it with `grep -rn "export.*escapeHtml" servers/gateway/dashboard/ | head` and fix the import line in `remote-exposure.js` to the correct module before continuing.

- [ ] **Step 4: Register the section**

In `servers/gateway/dashboard/panels/settings.js`:

(a) Add the import beside the others (after `:43`):

```js
import remoteExposureSection from "../settings/sections/remote-exposure.js";
```

(b) Register it after `unifiedDashboardSection` (`:58`):

```js
registerSettingsSection(remoteExposureSection);
```

- [ ] **Step 5: Syntax check**

```bash
node --check servers/gateway/dashboard/settings/sections/remote-exposure.js
node --check servers/gateway/dashboard/panels/settings.js
```
Expected: exit 0 for both.

- [ ] **Step 6: Render + round-trip smoke (isolated DB)**

```bash
TMP=$(mktemp -d); CROW_DATA_DIR=$TMP CROW_DB_PATH=$TMP/crow.db node scripts/init-db.js >/dev/null 2>&1
node --input-type=module -e "
import section from './servers/gateway/dashboard/settings/sections/remote-exposure.js';
import { createDbClient } from './servers/db.js';
process.env.CROW_DATA_DIR='$TMP'; process.env.CROW_DB_PATH='$TMP/crow.db';
const db = createDbClient();
// initial render: nothing exposed
let html = await section.render({ db });
console.log('renders:', html.length > 200);
console.log('has memory cap:', html.includes('crow-memory'));
console.log('default unchecked:', !/value=\"crow-memory\"[^>]*checked/.test(html));
// expose crow-memory via handleAction
let redirected = '';
const res = { redirectAfterPost: (u) => { redirected = u; } };
const handled = await section.handleAction({ req: { body: { action: 'set_remote_exposure', cap: 'crow-memory' } }, res, db, action: 'set_remote_exposure' });
console.log('action handled:', handled === true, 'redirect ok:', redirected.includes('remote-exposure'));
// re-render: crow-memory now checked
html = await section.render({ db });
console.log('crow-memory now checked:', /value=\"crow-memory\"[^>]*checked/.test(html));
// preview reflects count
console.log('preview:', await section.getPreview({ db }));
"; rm -rf "$TMP"
```
Expected: `renders: true`, `has memory cap: true`, `default unchecked: true`, `action handled: true`, `redirect ok: true`, `crow-memory now checked: true`, `preview: 1 exposed`.

- [ ] **Step 7: Confirm the setting did NOT become syncable**

```bash
grep -n "remote_exposed_tools" servers/gateway/dashboard/settings/sync-allowlist.js || echo "OK: remote_exposed_tools absent from sync-allowlist (local-only)"
```
Expected: the OK line (the key is NOT in the allowlist → never synced).

- [ ] **Step 8: Commit**

```bash
git commit servers/gateway/dashboard/settings/sections/remote-exposure.js \
  servers/gateway/dashboard/panels/settings.js servers/gateway/dashboard/shared/i18n.js \
  -m "F4a L2a: Settings section to toggle per-capability remote exposure (local-only)"
git show --stat HEAD
```

---

## Task 5: Invariant sweep + full L2a + Layer 1 test run

**Files:** none (verification only).

- [ ] **Step 1: Network-exposure invariant intact**

```bash
node tests/auth-network.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `fail 0`. (L2a adds no public routes; the gate only tightens the existing private instance-auth path.)

- [ ] **Step 2: Exposure setting is local-only (never synced)**

```bash
grep -n "remote_exposed_tools" servers/gateway/dashboard/settings/sync-allowlist.js \
  && echo "FAIL: exposure key is in sync-allowlist" || echo "OK: remote_exposed_tools is local-only"
```
Expected: the OK line.

- [ ] **Step 3: Full L2a + Layer 1 test set**

```bash
node --test \
  tests/exposure-allowlist.test.js \
  tests/peer-invocation-gate.test.js \
  tests/public-projection.test.js \
  tests/capability-registry.test.js \
  tests/capabilities-cache.test.js \
  2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: all pass, `fail 0`.

- [ ] **Step 4: Scoped-diff check**

```bash
git diff --stat main...feat/f4a-layer2a-remote-invocation
```
Expected: only the files in the File Structure table (+ this plan doc). No strays.

- [ ] **Step 5: Gateway boot smoke (final)**

```bash
timeout 12 node servers/gateway/index.js --no-auth > /tmp/l2a-final-boot.log 2>&1; echo "exit=$?"
grep -iE "error|throw|cannot find|unhandled" /tmp/l2a-final-boot.log | grep -vi "no error" | head
```
Expected: no module/throw errors in the log.

- [ ] **Step 6: STOP — hand back for the merge/deploy decision.** Do NOT auto-merge or deploy. Restart the model docker containers that were stopped for the build (`docker start vllm-rocm-qwen35-4b llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed crow-companion faster-whisper-server kokoro-tts`). Deploy (when chosen) is `git pull --ff-only` + restart `crow-gateway` (+ `crow-mpa-gateway` on crow) + grackle — **no `init-db`** (L2a adds no tables; the setting lives in `dashboard_settings_overrides`). Single host at a time, verify is-active + clean journal after each.

---

## Self-Review

**Spec coverage:**
- §1 Exposure allowlist setting (`remote_exposed_tools`, local-only, default `[]`, `getExposedCapabilities` helper, tolerant parse) → Task 1 + `tests/exposure-allowlist.test.js`. ✓
- §2 Settings UI (per-capability toggle from `getLocalCatalog`, default-off, caution, local-only) → Task 4 + render/round-trip smoke. ✓
- §3 Catalog `exposed` flag (`toPublicTool` + `getLocalCatalog` consult exposure set; `vTool` parity) → Task 2 + projection/cache tests. ✓
- §4 Server-side enforcement gate (peer `tools/call` allowed only if owning canonicalId exposed; default-deny; local-operator unaffected; non-`tools/call` allowed; audited; resolves via prefix / router category / proxy id) → Task 1 (logic+tests) + Task 3 (wiring) + `tests/peer-invocation-gate.test.js`. ✓
- §4 `tools/list` filtering for peers — spec marks this **optional** ("defense-in-depth; optional if it complicates — the hard gate is on `tools/call`"). NOT implemented; the hard gate on `tools/call` is the boundary. Noted, not a gap.
- Testing & verification items 1–4 → Tasks 1, 2, 5. ✓
- Invariant (auth-network green; key absent from sync-allowlist) → Task 5. ✓
- Non-goals honored: no pi-bot selection/invocation (L2b), no per-individual-tool granularity (category/server only), confirm-token model untouched, no cross-instance bot edit/run. ✓

**Placeholder scan:** No TBD/TODO. The only locate-then-edit steps are: the `escapeHtml` import path (Task 4 Step 3 verifies + corrects), and the exact `mountMcpServer` line numbers in `index.js` (Task 3 lists all 10 + the grep in Step 4 confirms). Both are bounded with explicit verification.

**Type consistency:** `getExposedCapabilities(db) → Set<string>` used identically in Task 1 (gate), Task 2 (`getLocalCatalog`), Task 4 (section reads the raw setting directly with the same parse discipline). `resolveCalledCanonicalId(prefix, body, connectedServers) → string|null|"__allow__"` consumed only by `enforcePeerExposure`. `enforcePeerExposure({prefix,req,res,db,connectedServers,...}) → boolean` — Task 3's `peerExposureGate(prefix,req,res)` calls it with exactly those keys; `mountMcpServer`'s `peerGate(prefix,req,res)` matches. `toPublicTool(entry, exposedSet)` (Task 2) — `exposed:boolean` field mirrored by `vTool` (Task 2 Step 7). Setting key string `"remote_exposed_tools"` identical across `EXPOSURE_SETTING_KEY` (Task 1), the section (Task 4), and the sync-allowlist check (Task 5). JSON-RPC deny shape `{ code:-32001 }` identical between `enforcePeerExposure` and the fail-closed fallback in `mcp.js` (Task 3 Step 1).
