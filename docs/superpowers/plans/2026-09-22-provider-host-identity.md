# Provider Host Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `providers.host` honest. Inference stops calling other machines' private addresses "local". Rows this instance wrote wrongly get repaired without starting a sync war. Readers treat their own instance id as self. The dashboard shows where an endpoint really lives.

**Architecture:**
- One new pure module, `servers/shared/provider-host.js`, holds the host vocabulary, inference, the self test, the repair decision and the display label.
- `servers/shared/locality.js` gains `addressClass` and `isPrivateHost`.
- `providers-db.js` swaps its private `inferHost` for the module's. It uses it on every write path and runs `repairProviderHosts` at the end of the existing hourly reconciler.
- `gpu-orchestrator.js` swaps two `host !== "local"` checks for `isSelfHost`.
- `providers-tab.js` renders `hostLabel`.
- No schema change and no migration.

**Tech Stack:** Node 22 ESM, `node:test`, `node:net` `isIP`, the existing libsql/better-sqlite3 DB wrapper (`servers/db.js` `createDbClient`).

**Spec:** `docs/superpowers/specs/2026-09-22-provider-host-identity-design.md` (read it first; §3.4 G1/G2 and §4 D2/D3/D7 are the load-bearing parts).

## Global Constraints

- **Allowed stored `host` values:** `local`, `cloud`, or a 32-character lowercase hex instance id (`/^[0-9a-f]{32}$/`). Anything else is invalid.
- **Inference never writes an instance id** (spec D2).
- **Repair rewrites only rows where `row.instance_id === ownInstanceId`** (D3). **G1:** judge a target only against a same-class live own address. **G2:** `local`→`cloud` only for IP-literal hostnames.
- **No `SCHEMA_GENERATION` bump, no `scripts/init-db.js` change** (D5).
- **Tests:** run through `node scripts/run-suite.mjs` (single file: `npm test -- tests/<file>.test.js`) with Node 22 on PATH: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` (verify with `node -v` → v22.23.1; the shell default is v24). **Never** raw `node --test` against the live DB.
- **Commits:**
  - Commit with a positional path: `git commit <paths> -m "..."`. Run `git show --stat HEAD` after every commit.
  - The worktree's `node_modules` is an untracked symlink and must never be committed.
- **Panel code:** `providers-tab.js` is server-rendered, so template literals are fine there. Do not touch any `client.js`.
- **Worktree:** `/home/kh0pp/crow-wt-host-identity`, branch `spec/provider-host-identity`. Never check out branches in `~/crow`.

## Review Focus

- **Boot race:** the gateway boots before tailscaled holds its `100.x` address. Repair must skip every `100.x` row on that run and change nothing (Task 4 test "G1 skips CGNAT targets when no CGNAT own address").
- **Co-hosted instances** (crow + r4 share addresses and the loopback): a row pointing at `100.118.41.122` written `local` by either must never be repaired on either (Task 4 test "own address → no repair").
- **Bracketed IPv6 and mixed-case hostnames** in `base_url` (`http://[::1]:8080`, `http://[FD00::5]:80`) must classify the same as their plain forms (Task 1 tests).
- **DNS-name base URLs** (`https://api.z.ai/...`, `http://raven:8030`, `*.ts.net`): inference gives `cloud` exactly as before, repair leaves a `local` row alone (G2), and the display label is honest (Tasks 1, 2, 4).
- **Repair idempotence under sync:** a second reconcile after convergence must write nothing and emit nothing, on both instances (Task 5 mutual sim).

---

### Task 1: Host vocabulary and inference module

**Files:**
- Create: `servers/shared/provider-host.js`
- Modify: `servers/shared/locality.js` (append `addressClass`, `isPrivateHost`)
- Test: `tests/provider-host.test.js`

**Interfaces:**
- Produces, from `provider-host.js`:
  - `isInstanceIdShape(h: any) → boolean`
  - `isValidHost(h: any) → boolean`
  - `hostnameOf(baseUrl: string|null) → string|null` (brackets stripped, lowercased)
  - `isIpLiteral(h: string) → boolean`
  - `inferHost(baseUrl, existingHost, { ownAddrs?: Set<string> }) → "local"|"cloud"|<existing valid>`
  - `isSelfHost(host, ownInstanceId) → boolean`
  - `repairHostDecision(row: {host, baseUrl, instance_id}, { ownInstanceId, ownAddrs }) → string|null`
  - `hostLabel(p: {host, baseUrl}, { ownAddrs, ownInstanceId, instanceNames: Map }) → { kind: "this"|"network"|"cloud"|"instance"|"invalid", text: string }`
- Produces, from `locality.js`:
  - `addressClass(h: string) → "loopback"|"linklocal"|"cgnat"|"rfc1918"|"ula"|"public"|null` (null = not an IP literal)
  - `isPrivateHost(h: string) → boolean` (DISPLAY ONLY)

- [ ] **Step 1: Write the failing test** `tests/provider-host.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInstanceIdShape, isValidHost, hostnameOf, isIpLiteral,
  inferHost, isSelfHost, repairHostDecision, hostLabel,
} from "../servers/shared/provider-host.js";
import { addressClass, isPrivateHost } from "../servers/shared/locality.js";

const OWN_ID = "0867ac2809dedd885ba7769b21966f8e";
const PEER_ID = "49cf71ca878643ba7717f344329266fd";
// crow-like: loopback + LAN + tailnet
const CROW = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237", "100.118.41.122"]);
// boot race: tailscale not up yet
const CROW_NO_TS = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]);
// nothing but loopback (network down)
const LOOP_ONLY = new Set(["localhost", "127.0.0.1", "::1"]);

test("isInstanceIdShape / isValidHost", () => {
  assert.equal(isInstanceIdShape(OWN_ID), true);
  assert.equal(isInstanceIdShape(OWN_ID.toUpperCase()), false);
  assert.equal(isInstanceIdShape("grackle-5fc01ac74463b6f4"), false);
  assert.equal(isInstanceIdShape("aaaaaaaa-0000-0000-0000-00000000000a"), false);
  for (const v of ["local", "cloud", OWN_ID]) assert.equal(isValidHost(v), true, v);
  for (const v of ["raven", "grackle-5fc01ac74463b6f4", "", null, undefined, "LOCAL", 42]) {
    assert.equal(isValidHost(v), false, String(v));
  }
});

test("hostnameOf strips IPv6 brackets and lowercases", () => {
  assert.equal(hostnameOf("http://[::1]:8080/v1"), "::1");
  assert.equal(hostnameOf("http://[FD00::5]:80/"), "fd00::5");
  assert.equal(hostnameOf("HTTP://Raven:8030/v1"), "raven");
  assert.equal(hostnameOf("not a url"), null);
  assert.equal(hostnameOf(""), null);
  assert.equal(hostnameOf(null), null);
});

test("isIpLiteral", () => {
  assert.equal(isIpLiteral("10.0.0.126"), true);
  assert.equal(isIpLiteral("fd00::5"), true);
  assert.equal(isIpLiteral("raven"), false);
  assert.equal(isIpLiteral("api.z.ai"), false);
});

test("inferHost: own and loopback → local; every foreign address → cloud (the regression)", () => {
  const o = { ownAddrs: CROW };
  assert.equal(inferHost("http://127.0.0.1:8003/v1", null, o), "local");
  assert.equal(inferHost("http://localhost:3001/llm/v1", null, o), "local");
  assert.equal(inferHost("http://[::1]:8080/v1", null, o), "local");
  assert.equal(inferHost("http://100.118.41.122:8003/v1", null, o), "local");
  assert.equal(inferHost("http://10.0.0.237:8003/v1", null, o), "local");
  assert.equal(inferHost("http://10.0.0.126:8030/v1", null, o), "cloud");      // raven, LAN
  assert.equal(inferHost("http://192.168.1.50:8000/v1", null, o), "cloud");
  assert.equal(inferHost("http://100.121.254.89:9100/v1", null, o), "cloud");   // grackle, tailnet
  assert.equal(inferHost("https://api.z.ai/api/coding/paas/v4", null, o), "cloud");
  assert.equal(inferHost("http://raven:8030/v1", null, o), "cloud");             // DNS name: unchanged D8
});

test("inferHost: no/unparseable baseUrl stays local (unchanged)", () => {
  assert.equal(inferHost("", null, { ownAddrs: CROW }), "local");
  assert.equal(inferHost(null, null, { ownAddrs: CROW }), "local");
  assert.equal(inferHost("not a url", null, { ownAddrs: CROW }), "local");
});

test("inferHost: valid existing host short-circuits; invalid falls through", () => {
  assert.equal(inferHost("http://10.0.0.126:8030/v1", "local", { ownAddrs: CROW }), "local");
  assert.equal(inferHost("http://10.0.0.126:8030/v1", PEER_ID, { ownAddrs: CROW }), PEER_ID);
  assert.equal(inferHost("http://10.0.0.126:8030/v1", "raven", { ownAddrs: CROW }), "cloud");
  assert.equal(inferHost("http://100.121.254.89:9100/v1", "grackle-5fc01ac74463b6f4",
    { ownAddrs: new Set(["127.0.0.1", "100.121.254.89"]) }), "local");
});

test("isSelfHost", () => {
  assert.equal(isSelfHost("local", OWN_ID), true);
  assert.equal(isSelfHost(OWN_ID, OWN_ID), true);
  assert.equal(isSelfHost(PEER_ID, OWN_ID), false);
  assert.equal(isSelfHost("cloud", OWN_ID), false);
  assert.equal(isSelfHost(null, OWN_ID), false);
  assert.equal(isSelfHost(OWN_ID, null), false);
});

const row = (host, baseUrl, instance_id = OWN_ID) => ({ host, baseUrl, instance_id });

test("repairHostDecision: only this instance's own writes (D3)", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1", PEER_ID), o), null);
  assert.equal(repairHostDecision(row("raven", "http://10.0.0.126:8030/v1", PEER_ID), o), null);
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), { ownInstanceId: null, ownAddrs: CROW }), null);
});

test("repairHostDecision: the two live crow rows", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), "cloud"); // raven-halogen-smoke
  assert.equal(repairHostDecision(row("raven", "http://10.0.0.126:8030/v1"), o), "cloud"); // raven-flash-next
});

test("repairHostDecision: grackle's invalid label on its own endpoint becomes local", () => {
  const GRACKLE = new Set(["127.0.0.1", "::1", "localhost", "10.0.0.21", "100.121.254.89"]);
  assert.equal(repairHostDecision(row("grackle-5fc01ac74463b6f4", "http://100.121.254.89:9100/v1"),
    { ownInstanceId: OWN_ID, ownAddrs: GRACKLE }), "local");
});

test("repairHostDecision: never touches valid non-local hosts, own addresses, or DNS names (G2)", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("cloud", "http://10.0.0.126:8030/v1"), o), null);
  assert.equal(repairHostDecision(row(PEER_ID, "http://10.0.0.126:8030/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://100.118.41.122:8003/v1"), o), null); // own
  assert.equal(repairHostDecision(row("local", "http://127.0.0.1:8020/v1"), o), null);      // loopback
  assert.equal(repairHostDecision(row("local", "https://api.z.ai/api/coding/paas/v4"), o), null); // G2
  assert.equal(repairHostDecision(row("local", "http://raven:8030/v1"), o), null);               // G2
  assert.equal(repairHostDecision(row("local", ""), o), null);
});

test("repairHostDecision G1: CGNAT target skipped while no CGNAT own address (boot race)", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW_NO_TS };
  assert.equal(repairHostDecision(row("local", "http://100.118.41.122:8003/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://100.121.254.89:9100/v1"), o), null);
  // RFC1918 target is still judged: a live RFC1918 own address exists.
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), "cloud");
});

test("repairHostDecision G1: loopback-only box never repairs local rows", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: LOOP_ONLY };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://[fe80::1]:80/"), o), null);
});

test("repairHostDecision G1: link-local targets are never judged", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: new Set([...CROW, "fe80::abcd"]) };
  assert.equal(repairHostDecision(row("local", "http://[fe80::1]:80/"), o), null);
});

test("addressClass", () => {
  assert.equal(addressClass("127.0.0.1"), "loopback");
  assert.equal(addressClass("::1"), "loopback");
  assert.equal(addressClass("169.254.3.3"), "linklocal");
  assert.equal(addressClass("fe80::1"), "linklocal");
  assert.equal(addressClass("100.64.0.1"), "cgnat");
  assert.equal(addressClass("100.127.255.254"), "cgnat");
  assert.equal(addressClass("100.128.0.1"), "public");
  assert.equal(addressClass("10.0.0.126"), "rfc1918");
  assert.equal(addressClass("172.16.0.1"), "rfc1918");
  assert.equal(addressClass("172.32.0.1"), "public");
  assert.equal(addressClass("192.168.1.1"), "rfc1918");
  assert.equal(addressClass("fd00::5"), "ula");
  assert.equal(addressClass("fc00::5"), "ula");
  assert.equal(addressClass("::ffff:10.0.0.1"), "rfc1918");
  assert.equal(addressClass("8.8.8.8"), "public");
  assert.equal(addressClass("2606:4700::1111"), "public");
  assert.equal(addressClass("raven"), null);
});

test("isPrivateHost (display only)", () => {
  for (const h of ["10.0.0.126", "100.121.254.89", "fd00::5", "raven", "localhost",
                   "grackle.dachshund-chromatic.ts.net", "nas.local", "box.lan", "x.home.arpa", "y.internal"]) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ["8.8.8.8", "api.z.ai", "api.together.xyz", "", null]) {
    assert.equal(isPrivateHost(h), false, String(h));
  }
});

test("hostLabel", () => {
  const ctx = { ownAddrs: CROW, ownInstanceId: OWN_ID, instanceNames: new Map([[PEER_ID, "Primary"]]) };
  assert.deepEqual(hostLabel({ host: "local", baseUrl: "http://100.118.41.122:8003/v1" }, ctx), { kind: "this", text: "this machine" });
  assert.deepEqual(hostLabel({ host: "local", baseUrl: "" }, ctx), { kind: "this", text: "this machine" });
  assert.deepEqual(hostLabel({ host: "local", baseUrl: "http://100.121.254.89:9100/v1" }, ctx), { kind: "network", text: "network" });
  assert.deepEqual(hostLabel({ host: "local", baseUrl: "https://api.z.ai/v4" }, ctx), { kind: "cloud", text: "cloud" });
  assert.deepEqual(hostLabel({ host: "cloud", baseUrl: "http://10.0.0.126:8030/v1" }, ctx), { kind: "network", text: "network" });
  assert.deepEqual(hostLabel({ host: "cloud", baseUrl: "https://api.together.xyz/v1" }, ctx), { kind: "cloud", text: "cloud" });
  assert.deepEqual(hostLabel({ host: OWN_ID, baseUrl: "http://127.0.0.1:1/v1" }, ctx), { kind: "this", text: "this machine" });
  assert.deepEqual(hostLabel({ host: PEER_ID, baseUrl: "http://x/v1" }, ctx), { kind: "instance", text: "Primary" });
  const unknown = "ffffffffffffffffffffffffffffffff";
  assert.deepEqual(hostLabel({ host: unknown, baseUrl: "http://x/v1" }, ctx), { kind: "instance", text: unknown.slice(0, 18) });
  assert.deepEqual(hostLabel({ host: "raven", baseUrl: "http://10.0.0.126:8030/v1" }, ctx), { kind: "invalid", text: "raven" });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /home/kh0pp/crow-wt-host-identity && npm test -- tests/provider-host.test.js`
Expected: FAIL. The import errors because `provider-host.js` does not exist, and `addressClass` is not exported.

- [ ] **Step 3: Append to `servers/shared/locality.js`**

```js
import { isIP } from "node:net";

function v4Octets(h) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  const v4 = m ? m[1] : h;
  if (isIP(v4) !== 4) return null;
  return v4.split(".").map(Number);
}

/**
 * Network class of an IP literal, or null for a DNS name. Used by the
 * providers host-repair guard G1 (spec 2026-09-22 §3.4) and by display.
 * NEVER a locality or ownership answer — that is isLocallyOrchestratable's
 * job (own-address membership), not a range test.
 */
export function addressClass(h) {
  if (typeof h !== "string" || !h) return null;
  const o = v4Octets(h);
  if (o) {
    const [a, b] = o;
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "linklocal";
    if (a === 100 && b >= 64 && b <= 127) return "cgnat";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "rfc1918";
    return "public";
  }
  if (isIP(h) !== 6) return null;
  const x = h.toLowerCase();
  if (x === "::1") return "loopback";
  if (/^fe[89ab]/.test(x)) return "linklocal";
  if (/^f[cd]/.test(x)) return "ula";
  return "public";
}

/**
 * DISPLAY ONLY: does this hostname look like it lives on a private network?
 * Never use it to decide routing, ownership or whether to start a model —
 * conflating "private address" with "this machine" was the inferHost bug.
 */
export function isPrivateHost(h) {
  if (typeof h !== "string" || !h) return false;
  const c = addressClass(h);
  if (c) return c !== "public";
  const n = h.toLowerCase();
  if (!n.includes(".")) return true;
  return /\.(local|lan|internal|home\.arpa|ts\.net)$/.test(n);
}
```

Move the `import { isIP } from "node:net";` line to the top of `locality.js`, next to the existing `import { networkInterfaces } from "node:os";`.

- [ ] **Step 4: Create `servers/shared/provider-host.js`**

```js
/**
 * providers.host vocabulary (spec: docs/superpowers/specs/2026-09-22-provider-host-identity-design.md).
 *
 *   "local"         the WRITER's own machine (loopback / own interface address).
 *                   Perspective-neutral among co-owners; never proof of
 *                   locality for a reader — readers keep the address checks.
 *   <instance-id>   32-hex id of the Crow instance serving the endpoint.
 *                   Written only explicitly (manifest, operator) — inference
 *                   never writes one (D2: peer and viewer would disagree → war).
 *   "cloud"         not managed from here: call base_url directly. Public APIs
 *                   AND unmanaged network boxes (raven today; Kevin, D1).
 */
import { isIP } from "node:net";
import { getOwnAddresses, addressClass, isPrivateHost } from "./locality.js";

const INSTANCE_ID_RE = /^[0-9a-f]{32}$/;

export function isInstanceIdShape(h) {
  return typeof h === "string" && INSTANCE_ID_RE.test(h);
}

export function isValidHost(h) {
  return h === "local" || h === "cloud" || isInstanceIdShape(h);
}

export function hostnameOf(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return null;
  try {
    return new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isIpLiteral(h) {
  return typeof h === "string" && isIP(h) !== 0;
}

export function inferHost(baseUrl, existingHost, { ownAddrs } = {}) {
  if (isValidHost(existingHost)) return existingHost;
  const h = hostnameOf(baseUrl);
  if (h === null) return "local";
  return (ownAddrs || getOwnAddresses()).has(h) ? "local" : "cloud";
}

export function isSelfHost(host, ownInstanceId) {
  if (host === "local") return true;
  return !!ownInstanceId && host === ownInstanceId;
}

/** G1: is there a live own address of the same network class as `h`? */
function sameClassOwnAddress(h, ownAddrs) {
  const cls = addressClass(h);
  if (!cls || cls === "loopback" || cls === "linklocal") return false;
  for (const a of ownAddrs) if (addressClass(a) === cls) return true;
  return false;
}

/**
 * The host this row should be repaired to, or null to leave it alone
 * (spec §3.4: D3 own writes only, G1 same-class live address, G2 IP literals
 * only for local→cloud). Pure.
 */
export function repairHostDecision(row, { ownInstanceId, ownAddrs }) {
  if (!row || !ownInstanceId || row.instance_id !== ownInstanceId) return null;
  const cur = row.host;
  if (isValidHost(cur) && cur !== "local") return null;
  if (cur === "local") {
    const h = hostnameOf(row.baseUrl);
    if (h === null || !isIpLiteral(h) || ownAddrs.has(h)) return null;
    if (!sameClassOwnAddress(h, ownAddrs)) return null;
  }
  const next = inferHost(row.baseUrl, null, { ownAddrs });
  return next !== cur ? next : null;
}

/** Dashboard badge text for a provider row. Display only. */
export function hostLabel(p, { ownAddrs, ownInstanceId, instanceNames }) {
  const host = p?.host;
  const h = hostnameOf(p?.baseUrl);
  const here = () => h === null || ownAddrs.has(h);
  const away = () => (isPrivateHost(h) ? { kind: "network", text: "network" } : { kind: "cloud", text: "cloud" });
  if (host === "local") return here() ? { kind: "this", text: "this machine" } : away();
  if (host === "cloud") return h !== null && isPrivateHost(h) ? { kind: "network", text: "network" } : { kind: "cloud", text: "cloud" };
  if (isInstanceIdShape(host)) {
    if (host === ownInstanceId) return { kind: "this", text: "this machine" };
    return { kind: "instance", text: instanceNames?.get(host) || host.slice(0, 18) };
  }
  return { kind: "invalid", text: String(host ?? "").slice(0, 18) };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test -- tests/provider-host.test.js`
Expected: PASS, all tests. Also run `npm test -- tests/gpu-orchestrator-host-gate.test.js` to confirm `locality.js` still loads (expected PASS, unchanged).

- [ ] **Step 6: Commit**

```bash
git add servers/shared/provider-host.js tests/provider-host.test.js
git commit servers/shared/provider-host.js servers/shared/locality.js tests/provider-host.test.js -m "feat(providers): host vocabulary module — honest inferHost, isSelfHost, guarded repair decision, display label"
git show --stat HEAD
```

---

### Task 2: providers-db write paths use the new inference

**Files:**
- Modify: `servers/shared/providers-db.js`:
  - delete the private `inferHost` at `:50-59`;
  - import from `./provider-host.js`;
  - `seedProvidersFromModelsJson` at `:97`;
  - `upsertProvider` host fallback at `:248`, `:282`, `:298`;
  - the reconciler call at `:570`;
  - the header comment at `:13-24`.
- Test: `tests/providers-host-inference.test.js`

**Interfaces:**
- Consumes: `inferHost` from Task 1.
- Produces: unchanged public signatures. `upsertProvider(db, provider)` now defaults a missing `host` to `inferHost(baseUrl, null)` instead of `"local"`.

- [ ] **Step 1: Write the failing test** `tests/providers-host-inference.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  seedProvidersFromModelsJson, syncProvidersFromModelsJson, upsertProvider, setProviderSyncManager,
} from "../servers/shared/providers-db.js";

const FIXTURE = {
  "fx-cloud": { baseUrl: "https://api.together.xyz/v1", models: [{ id: "a" }] },
  "fx-raven": { baseUrl: "http://10.0.0.126:8030/v1", models: [{ id: "b" }] },
  "fx-loop":  { baseUrl: "http://127.0.0.1:8003/v1", models: [{ id: "c" }] },
  "fx-tail":  { baseUrl: "http://100.121.254.89:9100/v1", models: [{ id: "d" }] },
};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "providers-host-inference-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" },
    stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const fixturePath = join(dir, "models.fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ providers: FIXTURE }));
  const prev = { d: process.env.CROW_DATA_DIR, m: process.env.CROW_MODELS_JSON };
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = fixturePath;
  setProviderSyncManager(null);
  const db = createDbClient(join(dir, "crow.db"));
  return {
    db,
    cleanup() {
      if (prev.d === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev.d;
      if (prev.m === undefined) delete process.env.CROW_MODELS_JSON; else process.env.CROW_MODELS_JSON = prev.m;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function hosts(db) {
  const { rows } = await db.execute("SELECT id, host FROM providers ORDER BY id");
  return Object.fromEntries(rows.map((r) => [r.id, r.host]));
}

test("first-boot seed infers host instead of blanket 'local'", async () => {
  const t = fresh();
  try {
    await seedProvidersFromModelsJson(t.db);
    const h = await hosts(t.db);
    assert.equal(h["fx-cloud"], "cloud");
    assert.equal(h["fx-raven"], "cloud");
    assert.equal(h["fx-loop"], "local");
    // fx-tail: the test box does not own 100.121.254.89 (it is grackle's) → cloud
    assert.equal(h["fx-tail"], "cloud");
  } finally { t.cleanup(); }
});

test("reconciler seed of an absent id: foreign LAN/tailnet → cloud, own → local", async () => {
  const t = fresh();
  try {
    const ownAddrs = new Set(["localhost", "127.0.0.1", "::1", "100.121.254.89"]);
    await syncProvidersFromModelsJson(t.db, { ownAddrs });
    const h = await hosts(t.db);
    assert.equal(h["fx-raven"], "cloud");
    assert.equal(h["fx-cloud"], "cloud");
    assert.equal(h["fx-loop"], "local");
    assert.equal(h["fx-tail"], "local");
  } finally { t.cleanup(); }
});

test("upsertProvider without a host infers it", async () => {
  const t = fresh();
  try {
    await upsertProvider(t.db, { id: "u-raven", baseUrl: "http://10.0.0.126:8030/v1", models: [] });
    await upsertProvider(t.db, { id: "u-loop", baseUrl: "http://127.0.0.1:9/v1", models: [] });
    await upsertProvider(t.db, { id: "u-explicit", baseUrl: "http://10.0.0.126:8030/v1", host: "local", models: [] });
    const h = await hosts(t.db);
    assert.equal(h["u-raven"], "cloud");
    assert.equal(h["u-loop"], "local");
    assert.equal(h["u-explicit"], "local", "an explicit host is written as given");
  } finally { t.cleanup(); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- tests/providers-host-inference.test.js`
Expected: FAIL. `fx-cloud`/`fx-raven`/`fx-tail` come out as `local` (first test), `fx-raven` as `local` (second), and `u-raven` as `local` (third).

- [ ] **Step 3: Implement in `servers/shared/providers-db.js`**

  1. Delete the whole local `function inferHost(baseUrl, existingHost) { ... }` block.
  2. Add `import { inferHost } from "./provider-host.js";` after the `locality.js` import.
  3. In `seedProvidersFromModelsJson`, replace `p.host || "local",` in the `args` array with:
     ```js
     inferHost(p.baseUrl, p.host),
     ```
  4. In `upsertProvider`, add at the top, right after the `provider.id` check:
     ```js
     const host = provider.host || inferHost(provider.baseUrl || provider.base_url || "", null);
     ```
     Then replace each of the three `provider.host || "local"` occurrences inside `upsertProvider` (the `upsertIsNoop` image, the INSERT args and the `emitSync` row) with `host`.
  5. In `syncProvidersFromModelsJson`, change `host: inferHost(p.baseUrl, p.host),` to:
     ```js
     host: inferHost(p.baseUrl, p.host, { ownAddrs: addrs }),
     ```
  6. Replace the header block from ` * \`host\` column invariant (three allowed values only):` through the end of that comment paragraph (the line ending `(adapter inferred from bundle_id/models.json).`) with:
     ```
      * `host` column (spec 2026-09-22 provider-host-identity; vocabulary and
      * helpers in ./provider-host.js):
      *   - "local"         the WRITER's own machine (loopback / own interface
      *                     address). Never proof of locality for a reader —
      *                     readers use isSelfHost() plus the address/owner checks.
      *   - "<instance-id>" 32-hex id of the Crow instance serving it. Written only
      *                     explicitly; inference never writes one.
      *   - "cloud"         not managed from here: call base_url directly
      *                     (public APIs and unmanaged network boxes alike).
      * Anything else is invalid and is repaired by repairProviderHosts() on the
      * instance that wrote it.
     ```

- [ ] **Step 4: Run the test and the neighbouring suites and confirm they pass**

Run: `npm test -- tests/providers-host-inference.test.js tests/providers-reconcile-gate.test.js tests/providers-upsert-noop.test.js tests/providers-war-sim.test.js tests/models-json-seam.test.js tests/providers-sync-wire.test.js`
Expected: PASS.

If a pre-existing assertion encoded the old bug (a foreign tailnet address expected to be `local`), change it to `cloud`. In the commit body, name the test and quote the spec line that makes the new value correct. Do not weaken any other assertion.

- [ ] **Step 5: Commit**

```bash
git add tests/providers-host-inference.test.js
git commit servers/shared/providers-db.js tests/providers-host-inference.test.js -m "fix(providers): every write path infers host by own-address membership, not private ranges"
git show --stat HEAD
```

---

### Task 3: Readers treat their own instance id as self

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js:574` (`maybeAcquireLocalProvider`) and `:619` (`resolveWarmableProviderName`)
- Test: `tests/gpu-orchestrator-host-gate.test.js` (append)

**Interfaces:**
- Consumes: `isSelfHost` (Task 1); the orchestrator's existing `ownInstanceId(opts)` and `_setOwnInstanceIdForTest`.

- [ ] **Step 1: Append the failing test** to `tests/gpu-orchestrator-host-gate.test.js`:

```js
test("isSelfHost reader: a bundle row whose host is THIS instance's id is warmable; a foreign id is not", () => {
  const SELF = "0867ac2809dedd885ba7769b21966f8e";
  const OTHER = "49cf71ca878643ba7717f344329266fd";
  _setOwnInstanceIdForTest(SELF);
  try {
    const cfg = { providers: {
      "self-id-bundle":  { baseUrl: "http://100.118.41.122:8003/v1", host: SELF,  bundleId: "b1" },
      "other-id-bundle": { baseUrl: "http://100.118.41.122:8004/v1", host: OTHER, bundleId: "b2" },
      "self-id-alias":   { baseUrl: "http://100.118.41.122:8003/v1", host: SELF,  bundleId: null },
      "self-id-foreign": { baseUrl: "http://100.121.254.89:8003/v1", host: SELF,  bundleId: "b3" },
    } };
    assert.equal(resolveWarmableProviderName(cfg, "self-id-alias", CROW), "self-id-bundle");
    assert.equal(resolveWarmableProviderName(cfg, "self-id-bundle", CROW), "self-id-bundle");
    // the address gate still binds: own id on a foreign address is not warmable here
    assert.equal(resolveWarmableProviderName(cfg, "self-id-foreign", CROW), null);
  } finally {
    _setOwnInstanceIdForTest(null);
  }
});
```

This also needs a `maybeAcquireLocalProvider` check. `maybeAcquireLocalProvider` calls `acquireProvider`, which starts containers, so test only the early-exit branch through its return value. With a cfg whose row has `host: OTHER`, the call must return `null` *before* acquiring. Append:

```js
test("maybeAcquireLocalProvider: foreign instance id still exits early; own id passes the host gate", async () => {
  const { maybeAcquireLocalProvider } = await import("../servers/gateway/gpu-orchestrator.js");
  const SELF = "0867ac2809dedd885ba7769b21966f8e";
  const OTHER = "49cf71ca878643ba7717f344329266fd";
  _setOwnInstanceIdForTest(SELF);
  try {
    const foreign = { providers: { p: { baseUrl: "http://100.121.254.89:1/v1", host: OTHER, bundleId: "b" } } };
    assert.equal(await maybeAcquireLocalProvider("p", { cfg: foreign }), null);
    // own id + foreign address: passes the host gate, then refused by the address gate → still null,
    // and must not throw or start anything.
    const ownIdForeignAddr = { providers: { p: { baseUrl: "http://100.121.254.89:1/v1", host: SELF, bundleId: "b" } } };
    assert.equal(await maybeAcquireLocalProvider("p", { cfg: ownIdForeignAddr }), null);
  } finally {
    _setOwnInstanceIdForTest(null);
  }
});
```

- [ ] **Step 2: Run it and confirm the first new test fails**

Run: `npm test -- tests/gpu-orchestrator-host-gate.test.js`
Expected: FAIL on `resolveWarmableProviderName(cfg, "self-id-alias", CROW)`, which returns `null` instead of `"self-id-bundle"` because `host !== "local"` exits early.

- [ ] **Step 3: Implement.** In `gpu-orchestrator.js`:
  - Add `import { isSelfHost } from "../shared/provider-host.js";` beside the other `../shared/` imports.
  - In `maybeAcquireLocalProvider`, replace
    ```js
    if (p.host && p.host !== "local") return null;
    ```
    with
    ```js
    if (p.host && !isSelfHost(p.host, ownInstanceId(opts))) return null;
    ```
  - In `resolveWarmableProviderName`, replace
    ```js
    if (direct.host != null && direct.host !== "local") return null; // cloud alias — not warmable
    ```
    with
    ```js
    if (direct.host != null && !isSelfHost(direct.host, ownInstanceId())) return null; // cloud/peer alias — not warmable
    ```

- [ ] **Step 4: Run and confirm everything passes**

Run: `npm test -- tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js tests/gpu-orchestrator-native.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/gpu-orchestrator.js tests/gpu-orchestrator-host-gate.test.js -m "fix(orchestrator): a row carrying this instance's own id is self, not foreign (isSelfHost)"
git show --stat HEAD
```

---

### Task 4: `repairProviderHosts` wired into the reconciler

**Files:**
- Modify: `servers/shared/providers-db.js`: add `repairProviderHosts`. Call it at the end of `syncProvidersFromModelsJson` and add `repaired` to its return.
- Modify: `servers/gateway/boot/admin-api.js:152-155`: log when `res.repaired > 0`.
- Test: `tests/providers-host-repair.test.js`

**Interfaces:**
- Consumes: `repairHostDecision` (Task 1), `listProvidersAll`, `upsertProvider`, `getOrCreateLocalInstanceId`, `getOwnAddresses`.
- Produces:
  - `repairProviderHosts(db, { ownInstanceId?, ownAddrs? }) → Promise<{ repaired: number, changes: Array<{id, from, to}> }>`
  - `syncProvidersFromModelsJson` returns `{ ..., repaired: number }`.

- [ ] **Step 1: Write the failing test** `tests/providers-host-repair.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { repairProviderHosts, syncProvidersFromModelsJson, setProviderSyncManager } from "../servers/shared/providers-db.js";

const PEER = "49cf71ca878643ba7717f344329266fd";
const CROW = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237", "100.118.41.122"]);

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "providers-host-repair-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" },
    stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const prev = { d: process.env.CROW_DATA_DIR, m: process.env.CROW_MODELS_JSON };
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = "";
  const calls = [];
  setProviderSyncManager({ feedsDisabled: false, emitChange: async (...a) => { calls.push(a); } });
  const db = createDbClient(join(dir, "crow.db"));
  return {
    db, dir, calls,
    cleanup() {
      setProviderSyncManager(null);
      if (prev.d === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev.d;
      if (prev.m === undefined) delete process.env.CROW_MODELS_JSON; else process.env.CROW_MODELS_JSON = prev.m;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function insert(db, id, host, baseUrl, instanceId) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id)
          VALUES (?, ?, ?, '[]', 0, 10, ?)`,
    args: [id, baseUrl, host, instanceId],
  });
}
async function hostOf(db, id) {
  const { rows } = await db.execute({ sql: "SELECT host, lamport_ts FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

test("repairs exactly this instance's bad writes, and nothing else", async () => {
  const t = fresh();
  try {
    const own = readFileSync(join(t.dir, "instance-id"), "utf8").trim();
    await insert(t.db, "raven-halogen-smoke", "local", "http://10.0.0.126:8731/v1", own);
    await insert(t.db, "raven-flash-next", "raven", "http://10.0.0.126:8030/v1", own);
    await insert(t.db, "peer-wrote-local", "local", "http://10.0.0.126:9999/v1", PEER);
    await insert(t.db, "own-addr-local", "local", "http://100.118.41.122:8003/v1", own);
    await insert(t.db, "dns-local", "local", "https://api.z.ai/v4", own);
    await insert(t.db, "cloud-ok", "cloud", "https://api.together.xyz/v1", own);

    const res = await repairProviderHosts(t.db, { ownInstanceId: own, ownAddrs: CROW });
    assert.deepEqual(res.changes.map((c) => c.id).sort(), ["raven-flash-next", "raven-halogen-smoke"]);
    assert.equal((await hostOf(t.db, "raven-halogen-smoke")).host, "cloud");
    assert.equal((await hostOf(t.db, "raven-flash-next")).host, "cloud");
    assert.equal((await hostOf(t.db, "peer-wrote-local")).host, "local");
    assert.equal((await hostOf(t.db, "own-addr-local")).host, "local");
    assert.equal((await hostOf(t.db, "dns-local")).host, "local");
    assert.equal(t.calls.length, 2, "exactly two sync emits");

    // idempotent: a second pass writes and emits nothing
    const lamportBefore = (await hostOf(t.db, "raven-flash-next")).lamport_ts;
    const res2 = await repairProviderHosts(t.db, { ownInstanceId: own, ownAddrs: CROW });
    assert.equal(res2.repaired, 0);
    assert.equal(t.calls.length, 2);
    assert.equal((await hostOf(t.db, "raven-flash-next")).lamport_ts, lamportBefore);
  } finally { t.cleanup(); }
});

test("G1 boot race: no CGNAT own address → 100.x rows untouched", async () => {
  const t = fresh();
  try {
    const own = readFileSync(join(t.dir, "instance-id"), "utf8").trim();
    await insert(t.db, "crow-chat", "local", "http://100.118.41.122:8003/v1", own);
    const noTs = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]);
    const res = await repairProviderHosts(t.db, { ownInstanceId: own, ownAddrs: noTs });
    assert.equal(res.repaired, 0);
    assert.equal((await hostOf(t.db, "crow-chat")).host, "local");
  } finally { t.cleanup(); }
});

test("syncProvidersFromModelsJson runs the repair and reports it", async () => {
  const t = fresh();
  try {
    const own = readFileSync(join(t.dir, "instance-id"), "utf8").trim();
    await insert(t.db, "raven-flash-next", "raven", "http://10.0.0.126:8030/v1", own);
    const res = await syncProvidersFromModelsJson(t.db, { ownAddrs: CROW });
    assert.equal(res.repaired, 1);
    assert.equal((await hostOf(t.db, "raven-flash-next")).host, "cloud");
  } finally { t.cleanup(); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- tests/providers-host-repair.test.js`
Expected: FAIL. `repairProviderHosts` is not exported.

- [ ] **Step 3: Implement.** In `servers/shared/providers-db.js`:
  - Extend the Task-2 import to `import { inferHost, repairHostDecision } from "./provider-host.js";`.
  - Add after `reenableProviderPreservingContent`:

```js
/**
 * Spec 2026-09-22 §3.4: repair provider rows whose `host` THIS instance wrote
 * wrongly (the old private-range inferHost, or a hand-set invalid label).
 * Single-writer by construction — only rows whose last writer is this
 * instance (D3) — and guarded against the boot race (G1) and DNS names (G2)
 * inside repairHostDecision. Round-trips through the parsed listProvidersAll
 * shape (R2-M2), so upsertProvider re-stamps lamport/instance_id and emits.
 */
export async function repairProviderHosts(db, {
  ownInstanceId = getOrCreateLocalInstanceId(),
  ownAddrs = getOwnAddresses(),
} = {}) {
  const changes = [];
  for (const row of await listProvidersAll(db)) {
    const next = repairHostDecision(row, { ownInstanceId, ownAddrs });
    if (next === null) continue;
    await upsertProvider(db, { ...row, host: next });
    changes.push({ id: row.id, from: row.host, to: next });
  }
  return { repaired: changes.length, changes };
}
```

  - In `syncProvidersFromModelsJson`:
    - Add `repaired: 0` to `counters`.
    - Change both early `return { ...counters, source: path };` lines, the ones before the loop, so the repair still runs when models.json is empty. The repair must run even with no file. Replace them with a single tail:
      1. Remove the two early returns, and guard the loop body instead: wrap the `entries` computation in `const entries = config?.providers ? Object.entries(config.providers).filter(([id]) => !id.startsWith("$")) : [];`.
      2. Just before the final `return`, insert:

```js
  const rep = await repairProviderHosts(dbClient, { ownAddrs: addrs });
  counters.repaired = rep.repaired;
```

  - In `servers/gateway/boot/admin-api.js`, change the condition `if (res.upserted > 0 || res.reenabled > 0)` to `if (res.upserted > 0 || res.reenabled > 0 || res.repaired > 0)`, and append ` repaired=${res.repaired}` to the log template.

- [ ] **Step 4: Run and confirm everything passes**

Run: `npm test -- tests/providers-host-repair.test.js tests/providers-reconcile-gate.test.js tests/providers-host-inference.test.js tests/models-json-seam.test.js`
Expected: PASS.

Check `providers-reconcile-gate.test.js` for any exact `deepEqual` on the return object of `syncProvidersFromModelsJson`. Add `repaired: 0` to such expectations only when its fixture has no repairable rows, which the reconcile-gate fixture does not: every row there is written by the test instance, but all its tailnet entries are either own or `100.77.x` seeds. Re-check: seeds now write `cloud` for foreign addresses, so they are valid, and repair finds nothing. Note the assertion change in the commit body.

- [ ] **Step 5: Commit**

```bash
git add tests/providers-host-repair.test.js
git commit servers/shared/providers-db.js servers/gateway/boot/admin-api.js tests/providers-host-repair.test.js -m "feat(providers): repairProviderHosts — own-writes-only host repair in the hourly reconciler"
git show --stat HEAD
```

---

### Task 5: Multi-instance mutual-case simulation

**Files:**
- Test: `tests/providers-host-repair-sim.test.js`, modelled on `tests/providers-war-sim.test.js` (read its harness first: two init-db'd tmp dirs, `InstanceSyncManager` with the stub feed, shared test identity).

**Interfaces:**
- Consumes: `repairProviderHosts`, `upsertProvider`, `setProviderSyncManager`, `InstanceSyncManager`.

This is required by the sync-layer lesson: the gate must be executable, multi-instance and MUTUAL-case. Both instances run repair, and both apply each other's feed.

- [ ] **Step 1: Write the test.** Copy the harness block verbatim from `tests/providers-war-sim.test.js`: imports, the two dirs + `init-db`, `IDENTITY`, `mgrA`/`mgrB`, `makeStubFeed`, and the `after` cleanup. Then change these:
  - Use 32-hex ids: `const A_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; const B_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";`.
  - Wire two feeds: `feedAtoB` (in `mgrA.outFeeds.set(B_ID, ...)`) and `feedBtoA` (in `mgrB.outFeeds.set(A_ID, ...)`).
  - Deliver with the war-sim's own apply call: `await mgrB._processNewEntries(A_ID, feedAtoB)` and `await mgrA._processNewEntries(B_ID, feedBtoA)`. It tracks its own per-feed cursor (war-sim calls it twice on the same feed at :141 and :167). Define `const deliver = (feed, mgr, fromId) => mgr._processNewEntries(fromId, feed);`.

Scenario A, where A wrote the bad row last:

```js
test("mutual: A's bad write converges to cloud on both; B never rewrites; clocks stop", async () => {
  const ADDRS_A = new Set(["127.0.0.1", "::1", "localhost", "10.0.0.237", "100.118.41.122"]);
  const ADDRS_B = new Set(["127.0.0.1", "::1", "localhost", "10.0.0.21", "100.121.254.89"]);
  for (const db of [dbA, dbB]) {
    await db.execute({
      sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id)
            VALUES ('raven-x', 'http://10.0.0.126:8030/v1', 'raven', '[]', 0, 50, ?)`,
      args: [A_ID],
    });
  }
  for (let round = 0; round < 3; round++) {
    setProviderSyncManager(mgrA);
    process.env.CROW_DATA_DIR = dirA;
    await repairProviderHosts(dbA, { ownInstanceId: A_ID, ownAddrs: ADDRS_A });
    setProviderSyncManager(mgrB);
    process.env.CROW_DATA_DIR = dirB;
    await repairProviderHosts(dbB, { ownInstanceId: B_ID, ownAddrs: ADDRS_B });
    await deliver(feedAtoB, mgrB, A_ID);
    await deliver(feedBtoA, mgrA, B_ID);
  }
  const a = (await dbA.execute("SELECT host, lamport_ts FROM providers WHERE id='raven-x'")).rows[0];
  const b = (await dbB.execute("SELECT host, lamport_ts FROM providers WHERE id='raven-x'")).rows[0];
  assert.equal(a.host, "cloud");
  assert.equal(b.host, "cloud");
  assert.equal(Number(a.lamport_ts), Number(b.lamport_ts));
  assert.equal(feedAtoB.length, 1, "A emitted exactly once across 3 rounds");
  assert.equal(feedBtoA.length, 0, "B never wrote A's row");
  assert.equal(await conflictCount(dbA) + await conflictCount(dbB), 0);
});
```

Scenario B, where B owns the endpoint and asserts `local`. A holds the row with B as last writer and must never rewrite it. Insert `('grackle-embed', 'http://100.121.254.89:9100/v1', 'local', ..., B_ID)` into both DBs. Run 3 rounds of both repairs and deliveries as above. Assert that both still read `local`, that both feeds are empty, and that there are 0 conflicts.

The `upsertProvider` instance id comes from `getOrCreateLocalInstanceId()`, which reads `$CROW_DATA_DIR/instance-id`. Before the loop, write `A_ID` into `join(dirA, "instance-id")` and `B_ID` into `join(dirB, "instance-id")` with `writeFileSync`. Switch `process.env.CROW_DATA_DIR` per side, as shown. Restore it in `after`.

- [ ] **Step 2: Prove the test can fail.** Temporarily make `repairHostDecision` ignore D3: comment out the `row.instance_id !== ownInstanceId` clause. Then run:

`npm test -- tests/providers-host-repair-sim.test.js`
Expected: FAIL in scenario B. A rewrites B's `local`, because 100.121.254.89 is not A's address and A has a live CGNAT address. That produces an emit on `feedAtoB`.

Restore the clause (`git diff servers/shared/provider-host.js` must be empty afterwards).

- [ ] **Step 3: Run it and confirm it passes**

Run: `npm test -- tests/providers-host-repair-sim.test.js tests/providers-war-sim.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/providers-host-repair-sim.test.js
git commit tests/providers-host-repair-sim.test.js -m "test(providers): mutual two-instance host-repair sim — converges, single writer, no conflicts"
git show --stat HEAD
```

---

### Task 6: Dashboard badge

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/llm/providers-tab.js`: `hostBadge` at `:26-31`, and its call site in `render` at `:44`.
- Test: covered by Task 1's `hostLabel` tests. This task adds only a render smoke test in `tests/providers-tab-host-badge.test.js`.

**Interfaces:**
- Consumes: `hostLabel` (Task 1), `getOwnAddresses` (`locality.js`), `getOrCreateLocalInstanceId` (`servers/gateway/instance-registry.js`).

- [ ] **Step 1: Write the failing smoke test** `tests/providers-tab-host-badge.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostBadge } from "../servers/gateway/dashboard/settings/sections/llm/providers-tab.js";

const ctx = {
  ownAddrs: new Set(["127.0.0.1", "::1", "localhost", "100.118.41.122"]),
  ownInstanceId: "0867ac2809dedd885ba7769b21966f8e",
  instanceNames: new Map(),
};

test("hostBadge renders the honest label and escapes it", () => {
  assert.match(hostBadge({ host: "cloud", baseUrl: "http://10.0.0.126:8030/v1", provider_type: "openai-compat" }, ctx), />network</);
  assert.match(hostBadge({ host: "cloud", baseUrl: "https://api.together.xyz/v1", provider_type: "openai-compat" }, ctx), />cloud · openai-compat</);
  assert.match(hostBadge({ host: "local", baseUrl: "http://100.118.41.122:8003/v1" }, ctx), />this machine</);
  assert.match(hostBadge({ host: "<b>x", baseUrl: "http://10.0.0.1/v1" }, ctx), /&lt;b&gt;x/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- tests/providers-tab-host-badge.test.js`
Expected: FAIL. `hostBadge` is not exported.

- [ ] **Step 3: Implement.** In `providers-tab.js`:
  - Add the imports:
    ```js
    import { hostLabel } from "../../../../../shared/provider-host.js";
    import { getOwnAddresses } from "../../../../../shared/locality.js";
    import { getOrCreateLocalInstanceId } from "../../../../instance-registry.js";
    ```
    Verify each relative path resolves from `servers/gateway/dashboard/settings/sections/llm/`. `instance-registry.js` lives in `servers/gateway/`.
  - Replace `hostBadge` with an exported version:

```js
export function hostBadge(p, ctx) {
  const base = `font-size:0.72rem;padding:2px 8px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);white-space:nowrap`;
  const { kind, text } = hostLabel(p, ctx);
  const color = kind === "cloud" ? "var(--crow-accent)" : "var(--crow-text-secondary)";
  const suffix = kind === "cloud" && p.provider_type ? ` · ${escapeHtml(p.provider_type)}` : "";
  return `<span style="${base};color:${color}" title="stored host: ${escapeHtml(String(p.host ?? ""))}">${escapeHtml(text)}${suffix}</span>`;
}
```

  - In `render({ db })`, before `providers.map`, build the context:

```js
    let instanceNames = new Map();
    try {
      const { rows } = await db.execute("SELECT id, name FROM crow_instances");
      instanceNames = new Map(rows.map((r) => [r.id, r.name]));
    } catch {}
    let ownInstanceId = null;
    try { ownInstanceId = getOrCreateLocalInstanceId(); } catch {}
    const hostCtx = { ownAddrs: getOwnAddresses(), ownInstanceId, instanceNames };
```

    Change `${hostBadge(p)}` to `${hostBadge(p, hostCtx)}`.

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- tests/providers-tab-host-badge.test.js tests/provider-host.test.js`
Expected: PASS.

Also check that the gateway boots: `CROW_DATA_DIR=$(mktemp -d) CROW_MODELS_JSON= timeout 20 node servers/gateway/index.js --no-auth --port 3999`. The expected result is a clean startup log; exit by timeout is fine. **Do not** point this at `~/.crow`.

- [ ] **Step 5: Commit**

```bash
git add tests/providers-tab-host-badge.test.js
git commit servers/gateway/dashboard/settings/sections/llm/providers-tab.js tests/providers-tab-host-badge.test.js -m "feat(dashboard): provider host badge says where the endpoint actually is"
git show --stat HEAD
```

---

### Task 7: Live-data dry run, full suite, PR

**Files:**
- Create: `scripts/ops/provider-host-repair-dryrun.mjs` (read-only).

- [ ] **Step 1: Write the dry-run script**

```js
#!/usr/bin/env node
// Read-only: which provider rows would repairProviderHosts change on a COPY
// of a crow.db? Usage: provider-host-repair-dryrun.mjs <db-copy> <own-instance-id> <addr,addr,...>
import { createDbClient } from "../../servers/db.js";
import { listProvidersAll } from "../../servers/shared/providers-db.js";
import { repairHostDecision } from "../../servers/shared/provider-host.js";

const [dbPath, ownInstanceId, addrCsv] = process.argv.slice(2);
if (!dbPath || !ownInstanceId || !addrCsv) {
  console.error("usage: provider-host-repair-dryrun.mjs <db-copy> <own-instance-id> <addr,addr,...>");
  process.exit(2);
}
const ownAddrs = new Set(["localhost", "127.0.0.1", "::1", ...addrCsv.split(",")]);
const db = createDbClient(dbPath);
let n = 0;
for (const row of await listProvidersAll(db)) {
  const next = repairHostDecision(row, { ownInstanceId, ownAddrs });
  if (next !== null) { n++; console.log(`${row.id}\t${row.host} -> ${next}\t${row.baseUrl}`); }
}
console.log(`would repair: ${n}`);
db.close?.();
```

- [ ] **Step 2: Run it against COPIES** (never the live files). Grackle's DB is `~/crow/data/crow.db`, not `~/.crow`:

```bash
S=$(mktemp -d)
sqlite3 ~/.crow/data/crow.db ".backup $S/crow.db"
sqlite3 ~/.crow-r4/data/crow.db ".backup $S/r4.db"
ssh kh0pp@10.0.0.21 "sqlite3 ~/crow/data/crow.db '.backup /tmp/gr.db'" && scp kh0pp@10.0.0.21:/tmp/gr.db $S/gr.db && ssh kh0pp@10.0.0.21 rm /tmp/gr.db
node scripts/ops/provider-host-repair-dryrun.mjs $S/crow.db 0867ac2809dedd885ba7769b21966f8e 10.0.0.237,100.118.41.122
node scripts/ops/provider-host-repair-dryrun.mjs $S/r4.db   c22c6af81c13ff920ce609d2d61d8065 10.0.0.237,100.118.41.122
node scripts/ops/provider-host-repair-dryrun.mjs $S/gr.db   49cf71ca878643ba7717f344329266fd 10.0.0.21,100.121.254.89
rm -rf $S
```

Expected:
- **crow:** `raven-flash-next raven -> cloud` and `raven-halogen-smoke local -> cloud`, 2 rows.
- **r4:** the same 2 rows.
- **grackle:** `grackle-embed/-rerank/-vision grackle-5fc01ac74463b6f4 -> local`, 3 rows.

**Any other row is a STOP.** Investigate it and fix the spec or plan before continuing. Record the three outputs verbatim in the PR body.

- [ ] **Step 3: Full suite**

Run: `node scripts/run-suite.mjs` (Node 22).
Expected: 0 failures. Record the pass count against `main`'s baseline; run the suite on `main` first if the baseline is unknown.

Also run: `npm test -- tests/auth-network.test.js` (expected PASS), then `node scripts/check-port-allocation.js` and `node scripts/build-registry.js --check` (expected: unchanged / OK).

- [ ] **Step 4: Commit the script, push, open the PR**

```bash
git add scripts/ops/provider-host-repair-dryrun.mjs
git commit scripts/ops/provider-host-repair-dryrun.mjs -m "ops: read-only provider host repair dry run"
git pull --rebase origin main
git push -u origin spec/provider-host-identity
```

Open the PR with the GitHub MCP (`gh` is not installed). The body covers:
- the problem, with the live rows;
- the design, pointing at the spec;
- the three dry-run outputs;
- suite counts;
- the no-schema-change statement.

No attribution lines.

- [ ] **Step 5: CI**

Query `https://api.github.com/repos/kh0pper/crow/commits/<head-sha>/check-runs`. Every run (`suite`, `static-checks`, `audit`) must be `completed` / `success`. An empty result is wrong: investigate it, do not merge.

---

### Task 8: Merge, deploy, live verification

- [ ] **Step 1:** Read `~/CROW-SCHEDULE.md` and run `node ~/crow/scripts/ops/box-reserve.mjs status`. Merge only when no crow window is active or imminent. Register a one-line reservation, "provider-host-identity deploy (gateway restarts)", and clear it afterwards.
- [ ] **Step 2:** Squash-merge through the GitHub MCP. Auto-update pulls `main` into `~/crow` and restarts the crow gateways. Confirm that `~/crow` is on `main` and at the merge sha. Confirm that `auto_update_last_result` in `dashboard_settings` is not "Skipped". If auto-update has not run within 15 minutes, restart the gateway units deliberately: `systemctl --user restart crow-gateway` and the r4 gateway unit. Look up the r4 unit name in `systemctl --user list-units 'crow*'`.
- [ ] **Step 3:** Force a reconcile so you don't have to wait an hour. On crow's dashboard, go to Settings → LLM → Providers and use "Sync bundle providers" (`force: true`). Then run:
  ```bash
  sqlite3 ~/.crow/data/crow.db "select id,host,lamport_ts from providers where id in ('raven-flash-next','raven-halogen-smoke','crow-chat')"
  ```
  Expected: the two raven rows are `cloud`, and `crow-chat` is unchanged. Repeat for `~/.crow-r4/data/crow.db` after its own reconcile.
- [ ] **Step 4:** One hour later, re-run the same query. The lamport values of the two raven rows must be unchanged. Also run:
  ```bash
  sqlite3 ~/.crow/data/crow.db "select count(*) from sync_conflicts where table_name='providers' and created_at > datetime('now','-1 hour')"
  ```
  Expected: 0. Confirm the column name with `.schema sync_conflicts` first.
- [ ] **Step 5:** The Providers tab on crow shows "network" for the raven rows and "this machine" for crow's own rows.
- [ ] **Step 6:**
  - Update the two-host spec §3.1 on branch `spec/heavy-model-catalog-curation` (worktree `~/crow-wt-catalog`, PR #344): replace the "Set **`host = 'raven'`**" requirement with a line saying unmanaged network endpoints are `cloud`, pointing at this spec. Commit with a path and push.
  - Update memory `crow-inferhost-private-address-bug.md` to FIXED, with the PR number and merge sha.
  - Update the Gitea queue doc: sub-project 1 done.
