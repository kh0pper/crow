# Provider Host Identity Implementation Plan (rev 3, after plan review rounds 1–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `providers.host` honest and stop it from deciding what a machine may start.
- Inference judges "this machine" by the machine's own addresses, not by private ranges.
- Readers veto only a *foreign instance id*.
- A narrow, guarded repair fixes the rows this instance wrote wrongly.
- The dashboard shows where an endpoint really lives.

**Architecture:**
- A new pure module, `servers/shared/provider-host.js`, holds the vocabulary, inference, the foreign-id veto, the repair decision and the display label.
- `servers/shared/locality.js` gains `addressClass` and `isPrivateHost`.
- `providers-db.js` uses the new `inferHost` on every write path and runs `repairProviderHosts` at the end of the existing hourly reconciler.
- `gpu-orchestrator.js` swaps its two `host !== "local"` exits for `isForeignInstanceHost`.
- `providers-tab.js` renders `hostLabel`.
- `routes/models.js` stops writing `host:"external"`.
- No schema change.

**Tech Stack:** Node 22 ESM, `node:test`, `node:net` `isIP`, the `servers/db.js` `createDbClient` wrapper.

**Spec:** `docs/superpowers/specs/2026-09-22-provider-host-identity-design.md`. Load-bearing sections: §3.3 (the foreign-id veto, D9), §3.4 (scope, D3, G1, G2) and §4.1 (accepted limitations).

## Global Constraints

- **Allowed stored `host` values:** `local`, `cloud`, or a 32-character lowercase hex instance id (`/^[0-9a-f]{32}$/`).
- **Inference never writes an instance id** (D2).
- **`host` is not an orchestration gate** except the foreign-instance-id veto (D9).
- **Repair scope:** `bundleId == null`, no `gpuPolicy.owner`, `gpuPolicy.local_only !== true`, and `!disabled`.
- **Repair rules:**
  - it applies only when `instance_id === ownInstanceId` (D3);
  - G1: any result of `cloud` needs an IP-literal target plus a live own address of the same class, and the whole pass is skipped if `ownAddrs` holds only loopback;
  - G2: `local` rows naming a DNS host are never touched.
- **No schema change:** no `SCHEMA_GENERATION` bump and no `scripts/init-db.js` change (D5).
- **Tests:** always through `npm test -- tests/<file>.test.js` or `node scripts/run-suite.mjs`, with Node 22 on PATH: `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` (check that `node -v` prints v22.23.1; the shell default is v24). **Never** run raw `node --test` (it hits the live DB).
- **Test instance ids:** a test's own instance id comes from `getOrCreateLocalInstanceId()` (`servers/gateway/instance-registry.js`), called **after** setting `CROW_DATA_DIR`. `init-db.js` does not create the `instance-id` file, and the getter is not cached.
- **Commits:**
  - Commit with a positional path: `git commit <paths> -m "..."`, then check with `git show --stat HEAD`.
  - The worktree's `node_modules` is an untracked symlink and must never be committed.
- **Worktree:** `/home/kh0pp/crow-wt-host-identity`, branch `spec/provider-host-identity`. Never check out branches in `~/crow`.

## Review Focus

- **Tailscale boot race.** Repair must skip every `100.x` target while no own `100.64/10` address is live. This applies to both the `local` and the invalid-value branches (Task 1 tests "G1 …" and Task 4 "G1 boot race").
- **Re-stamped rows.** A bundle row whose `instance_id` is another machine's, which is live for crow's `crow-chat`/`crow-voice`/`crow-swap-agentic`, must never be repaired by that other machine (Task 1 "scope", Task 5 scenario C).
- **Own bundle marked `cloud`.** A bundle row marked `cloud` but served on this machine must still be warmable (Task 3). This is the D9 guarantee.
- **Unusual base URLs:** bracketed or mapped IPv6 (`[::ffff:10.0.0.1]` normalises to hex), mixed-case hosts, and DNS-name base URLs (Task 1).
- **Idempotence.** After convergence, repair plus the owner's reconcile must write and emit nothing on either instance, round after round (Task 5).

---

### Task 1: Host vocabulary and inference module

**Files:**
- Create: `servers/shared/provider-host.js`
- Modify: `servers/shared/locality.js` (add `import { isIP } from "node:net";` beside the `node:os` import, and append `addressClass` and `isPrivateHost`)
- Test: `tests/provider-host.test.js`

**Interfaces (Produces):**
- `provider-host.js`:
  - `isInstanceIdShape(h) → boolean`
  - `isValidHost(h) → boolean`
  - `hostnameOf(baseUrl) → string|null` (brackets stripped, lowercased)
  - `isIpLiteral(h) → boolean`
  - `inferHost(baseUrl, existingHost, { ownAddrs? }) → "local"|"cloud"|<existing valid>`
  - `isForeignInstanceHost(host, ownInstanceIdFn: () => string|null) → boolean` (calls `ownInstanceIdFn` only for id-shaped hosts)
  - `inRepairScope(row) → boolean`
  - `repairHostDecision(row: {host, baseUrl, instance_id, bundleId, gpuPolicy, disabled}, { ownInstanceId, ownAddrs }) → string|null`
  - `hostLabel(p, { ownAddrs, ownInstanceId, instanceNames: Map }) → { kind: "this"|"network"|"cloud"|"instance"|"invalid", text }`
- `locality.js`:
  - `addressClass(h) → "loopback"|"linklocal"|"cgnat"|"rfc1918"|"ula"|"public4"|"public6"|null`
  - `isPrivateHost(h) → boolean` (DISPLAY ONLY)

- [ ] **Step 1: Write the failing test** `tests/provider-host.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInstanceIdShape, isValidHost, hostnameOf, isIpLiteral, inferHost,
  isForeignInstanceHost, inRepairScope, repairHostDecision, hostLabel,
} from "../servers/shared/provider-host.js";
import { addressClass, isPrivateHost } from "../servers/shared/locality.js";

const OWN_ID = "0867ac2809dedd885ba7769b21966f8e";
const PEER_ID = "49cf71ca878643ba7717f344329266fd";
const CROW = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237", "100.118.41.122"]);
const CROW_NO_TS = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]);
const LOOP_ONLY = new Set(["localhost", "127.0.0.1", "::1"]);

test("isInstanceIdShape / isValidHost", () => {
  assert.equal(isInstanceIdShape(OWN_ID), true);
  assert.equal(isInstanceIdShape(OWN_ID.toUpperCase()), false);
  assert.equal(isInstanceIdShape("grackle-5fc01ac74463b6f4"), false);
  assert.equal(isInstanceIdShape("aaaaaaaa-0000-0000-0000-00000000000a"), false);
  for (const v of ["local", "cloud", OWN_ID]) assert.equal(isValidHost(v), true, v);
  for (const v of ["raven", "external", "grackle-5fc01ac74463b6f4", "", null, undefined, "LOCAL", 42]) {
    assert.equal(isValidHost(v), false, String(v));
  }
});

test("hostnameOf / isIpLiteral", () => {
  assert.equal(hostnameOf("http://[::1]:8080/v1"), "::1");
  assert.equal(hostnameOf("http://[FD00::5]:80/"), "fd00::5");
  assert.equal(hostnameOf("HTTP://Raven:8030/v1"), "raven");
  assert.equal(hostnameOf("not a url"), null);
  assert.equal(hostnameOf(""), null);
  assert.equal(hostnameOf(null), null);
  assert.equal(isIpLiteral("10.0.0.126"), true);
  assert.equal(isIpLiteral("fd00::5"), true);
  assert.equal(isIpLiteral("raven"), false);
});

test("inferHost: own/loopback → local; every foreign address → cloud (the regression)", () => {
  const o = { ownAddrs: CROW };
  assert.equal(inferHost("http://127.0.0.1:8003/v1", null, o), "local");
  assert.equal(inferHost("http://localhost:3001/llm/v1", null, o), "local");
  assert.equal(inferHost("http://[::1]:8080/v1", null, o), "local");
  assert.equal(inferHost("http://100.118.41.122:8003/v1", null, o), "local");
  assert.equal(inferHost("http://10.0.0.237:8003/v1", null, o), "local");
  assert.equal(inferHost("http://10.0.0.126:8030/v1", null, o), "cloud");
  assert.equal(inferHost("http://192.168.1.50:8000/v1", null, o), "cloud");
  assert.equal(inferHost("http://100.121.254.89:9100/v1", null, o), "cloud");
  assert.equal(inferHost("https://api.z.ai/api/coding/paas/v4", null, o), "cloud");
  assert.equal(inferHost("http://raven:8030/v1", null, o), "cloud"); // D8 unchanged
  assert.equal(inferHost("", null, o), "local");
  assert.equal(inferHost(null, null, o), "local");
  assert.equal(inferHost("not a url", null, o), "local");
});

test("inferHost: valid existing host short-circuits; invalid falls through", () => {
  assert.equal(inferHost("http://10.0.0.126:8030/v1", "local", { ownAddrs: CROW }), "local");
  assert.equal(inferHost("http://10.0.0.126:8030/v1", PEER_ID, { ownAddrs: CROW }), PEER_ID);
  assert.equal(inferHost("http://10.0.0.126:8030/v1", "raven", { ownAddrs: CROW }), "cloud");
  assert.equal(inferHost("http://100.121.254.89:9100/v1", "grackle-5fc01ac74463b6f4",
    { ownAddrs: new Set(["127.0.0.1", "100.121.254.89"]) }), "local");
});

test("isForeignInstanceHost: only a DIFFERENT 32-hex id is foreign; id read lazily", () => {
  let reads = 0;
  const own = () => { reads++; return OWN_ID; };
  for (const h of ["local", "cloud", "raven", "grackle-5fc01ac74463b6f4", null, undefined]) {
    assert.equal(isForeignInstanceHost(h, own), false, String(h));
  }
  assert.equal(reads, 0, "never reads the instance id for non-id hosts");
  assert.equal(isForeignInstanceHost(OWN_ID, own), false);
  assert.equal(isForeignInstanceHost(PEER_ID, own), true);
  assert.equal(isForeignInstanceHost(PEER_ID, () => null), true, "unknown own id: any id is foreign");
});

const row = (host, baseUrl, extra = {}) => ({
  host, baseUrl, instance_id: OWN_ID, bundleId: null, gpuPolicy: null, disabled: false, ...extra,
});

test("inRepairScope: bundle, owned-native, local_only and disabled rows are out", () => {
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1")), true);
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1", { bundleId: "b" })), false);
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1", { gpuPolicy: { owner: OWN_ID } })), false);
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1", { gpuPolicy: { local_only: true } })), false);
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1", { disabled: true })), false);
  assert.equal(inRepairScope(null), false);
});

test("repairHostDecision: the two live crow rows", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), "cloud");
  assert.equal(repairHostDecision(row("raven", "http://10.0.0.126:8030/v1"), o), "cloud");
});

test("repairHostDecision D3: another instance's write is never touched", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1", { instance_id: PEER_ID }), o), null);
  assert.equal(repairHostDecision(row("raven", "http://10.0.0.126:8030/v1", { instance_id: PEER_ID }), o), null);
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), { ownInstanceId: null, ownAddrs: CROW }), null);
});

test("repairHostDecision scope: re-stamped BUNDLE row (the live crow-chat case) is never touched", () => {
  // On grackle: crow-chat is host=local, base_url crow's 100.118.41.122, instance_id = grackle
  const GRACKLE = new Set(["127.0.0.1", "::1", "localhost", "10.0.0.21", "100.121.254.89"]);
  const crowChat = row("local", "http://100.118.41.122:8003/v1", { bundleId: "llamacpp-vulkan-qwen36-35b-a3b" });
  assert.equal(repairHostDecision(crowChat, { ownInstanceId: OWN_ID, ownAddrs: GRACKLE }), null);
});

test("repairHostDecision: never touches valid non-local hosts, own addresses, DNS names (G2)", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("cloud", "http://10.0.0.126:8030/v1"), o), null);
  assert.equal(repairHostDecision(row(PEER_ID, "http://10.0.0.126:8030/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://100.118.41.122:8003/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://127.0.0.1:8020/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "https://api.z.ai/api/coding/paas/v4"), o), null);
  assert.equal(repairHostDecision(row("local", "http://raven:8030/v1"), o), null);
  assert.equal(repairHostDecision(row("local", ""), o), null);
  // invalid label on a DNS-name row → left for the operator (cloud result, not judgeable)
  assert.equal(repairHostDecision(row("raven", "http://raven:8030/v1"), o), null);
  // invalid label whose inference is local (own address) IS repaired
  assert.equal(repairHostDecision(row("raven", "http://127.0.0.1:9/v1"), o), "local");
});

test("repairHostDecision G1: 100.x targets skipped while no CGNAT own address — BOTH branches", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW_NO_TS };
  assert.equal(repairHostDecision(row("local", "http://100.118.41.122:8003/v1"), o), null);
  assert.equal(repairHostDecision(row("raven", "http://100.121.254.89:9100/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), "cloud");
});

test("repairHostDecision G1: loopback-only box repairs nothing to cloud", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: LOOP_ONLY };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), null);
  assert.equal(repairHostDecision(row("raven", "http://10.0.0.126:8030/v1"), o), null);
});

test("repairHostDecision G1: link-local and public-family mismatch are not judged", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: new Set([...CROW, "fe80::abcd", "2601:2c5::5"]) };
  assert.equal(repairHostDecision(row("local", "http://[fe80::1]:80/"), o), null);
  // box has public6 only → a public4 target is not judged
  assert.equal(repairHostDecision(row("local", "http://8.8.8.8:80/"), o), null);
});

test("addressClass", () => {
  assert.equal(addressClass("127.0.0.1"), "loopback");
  assert.equal(addressClass("::1"), "loopback");
  assert.equal(addressClass("169.254.3.3"), "linklocal");
  assert.equal(addressClass("fe80::1"), "linklocal");
  assert.equal(addressClass("100.64.0.1"), "cgnat");
  assert.equal(addressClass("100.127.255.254"), "cgnat");
  assert.equal(addressClass("100.128.0.1"), "public4");
  assert.equal(addressClass("10.0.0.126"), "rfc1918");
  assert.equal(addressClass("172.16.0.1"), "rfc1918");
  assert.equal(addressClass("172.32.0.1"), "public4");
  assert.equal(addressClass("192.168.1.1"), "rfc1918");
  assert.equal(addressClass("fd00::5"), "ula");
  assert.equal(addressClass("fc00::5"), "ula");
  assert.equal(addressClass("::ffff:10.0.0.1"), "rfc1918");
  assert.equal(addressClass("::ffff:a00:1"), "rfc1918"); // WHATWG URL's normalised form of [::ffff:10.0.0.1]
  assert.equal(hostnameOf("http://[::ffff:10.0.0.1]/"), "::ffff:a00:1");
  assert.equal(addressClass("8.8.8.8"), "public4");
  assert.equal(addressClass("2606:4700::1111"), "public6");
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
Expected: FAIL on the imports: the module is missing and `addressClass` is not exported.

- [ ] **Step 3: Append to `servers/shared/locality.js`.** Add the `node:net` import at the top.

```js
function v4Octets(h) {
  let m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  if (m) return isIP(m[1]) === 4 ? m[1].split(".").map(Number) : null;
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h); // WHATWG-normalised mapped form
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255];
  }
  return isIP(h) === 4 ? h.split(".").map(Number) : null;
}

/**
 * Network class of an IP literal, or null for a DNS name. Used by the
 * providers host-repair guard G1 (spec 2026-09-22 §3.4) and by display.
 * NEVER a locality or ownership answer — that is own-address membership
 * (isLocallyOrchestratable), not a range test.
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
    return "public4";
  }
  if (isIP(h) !== 6) return null;
  const x = h.toLowerCase();
  if (x === "::1") return "loopback";
  if (/^fe[89ab]/.test(x)) return "linklocal";
  if (/^f[cd]/.test(x)) return "ula";
  return "public6";
}

/**
 * DISPLAY ONLY: does this hostname look like it lives on a private network?
 * Never use it to decide routing, ownership or whether to start a model —
 * conflating "private address" with "this machine" was the inferHost bug.
 */
export function isPrivateHost(h) {
  if (typeof h !== "string" || !h) return false;
  const c = addressClass(h);
  if (c) return c !== "public4" && c !== "public6";
  const n = h.toLowerCase();
  if (!n.includes(".")) return true;
  return /\.(local|lan|internal|home\.arpa|ts\.net)$/.test(n);
}
```

- [ ] **Step 4: Create `servers/shared/provider-host.js`**

```js
/**
 * providers.host vocabulary (spec: docs/superpowers/specs/2026-09-22-provider-host-identity-design.md).
 *
 *   "local"         the WRITER's own machine (loopback / own interface address).
 *   <instance-id>   32-hex id of the Crow instance serving the endpoint. Written
 *                   only explicitly — inference never writes one (D2).
 *   "cloud"         not managed from here: call base_url directly (public APIs
 *                   and unmanaged network boxes alike; Kevin, D1).
 *
 * `host` is NOT an orchestration gate (D9): the only veto it carries is "this
 * belongs to a different Crow instance" (isForeignInstanceHost). Whether this
 * machine may start a model is decided by address/owner checks elsewhere.
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

/** The one veto `host` still carries. Reads the own id only for id-shaped hosts. */
export function isForeignInstanceHost(host, ownInstanceIdFn) {
  if (!isInstanceIdShape(host)) return false;
  return host !== ownInstanceIdFn();
}

/** Spec §3.4 scope: bundle, owned-native, local_only and disabled rows are never repaired. */
export function inRepairScope(row) {
  if (!row) return false;
  if (row.bundleId != null) return false;
  const gp = row.gpuPolicy || {};
  if (typeof gp.owner === "string" && gp.owner) return false;
  if (gp.local_only === true) return false;
  if (row.disabled) return false;
  return true;
}

function hasNonLoopback(ownAddrs) {
  for (const a of ownAddrs) {
    const c = addressClass(a);
    if (c && c !== "loopback" && c !== "linklocal") return true;
  }
  return false;
}

/** G1: an IP-literal target with a live own address of the same class. */
function judgeable(h, ownAddrs) {
  if (!isIpLiteral(h)) return false;
  const cls = addressClass(h);
  if (!cls || cls === "loopback" || cls === "linklocal") return false;
  for (const a of ownAddrs) if (addressClass(a) === cls) return true;
  return false;
}

/**
 * The host this row should be repaired to, or null (spec §3.4). Pure.
 */
export function repairHostDecision(row, { ownInstanceId, ownAddrs }) {
  if (!inRepairScope(row)) return null;
  if (!ownInstanceId || row.instance_id !== ownInstanceId) return null;      // D3
  const cur = row.host;
  if (isValidHost(cur) && cur !== "local") return null;
  const h = hostnameOf(row.baseUrl);
  if (cur === "local" && (h === null || !isIpLiteral(h) || ownAddrs.has(h))) return null; // G2 / own
  const next = inferHost(row.baseUrl, null, { ownAddrs });
  if (next === cur) return null;
  if (next === "cloud" && (!hasNonLoopback(ownAddrs) || !judgeable(h, ownAddrs))) return null; // G1
  return next;
}

/** Dashboard badge text for a provider row. Display only. */
export function hostLabel(p, { ownAddrs, ownInstanceId, instanceNames }) {
  const host = p?.host;
  const h = hostnameOf(p?.baseUrl);
  const away = () => (isPrivateHost(h) ? { kind: "network", text: "network" } : { kind: "cloud", text: "cloud" });
  if (host === "local") return h === null || ownAddrs.has(h) ? { kind: "this", text: "this machine" } : away();
  if (host === "cloud") return h !== null && isPrivateHost(h) ? { kind: "network", text: "network" } : { kind: "cloud", text: "cloud" };
  if (isInstanceIdShape(host)) {
    if (host === ownInstanceId) return { kind: "this", text: "this machine" };
    return { kind: "instance", text: instanceNames?.get(host) || host.slice(0, 18) };
  }
  return { kind: "invalid", text: String(host ?? "").slice(0, 18) };
}
```

- [ ] **Step 5: Run and confirm it passes**

Run: `npm test -- tests/provider-host.test.js tests/gpu-orchestrator-host-gate.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add servers/shared/provider-host.js tests/provider-host.test.js
git commit servers/shared/provider-host.js servers/shared/locality.js tests/provider-host.test.js -m "feat(providers): host vocabulary module — own-address inferHost, foreign-id veto, scoped+guarded repair decision, display label"
git show --stat HEAD
```

---

### Task 2: Write paths infer honestly, and the `external` writer is fixed

**Files:**
- Modify: `servers/shared/providers-db.js`:
  - delete the private `inferHost` (`:50-59`) and import the module's;
  - the seed at `:97`;
  - `upsertProvider` at `:248`, `:282` and `:298`;
  - the reconciler at `:570`;
  - the header at `:13-24`.
- Modify: `servers/gateway/routes/models.js:759`, which writes `host: "external"`.
- Modify: `tests/providers-reconcile-gate.test.js`, with a deliberate expectation change (Step 4).
- Test: `tests/providers-host-inference.test.js`

**Interfaces:** consumes `inferHost` (Task 1). `upsertProvider` now defaults a missing `host` to `inferHost(baseUrl, null)`.

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
    assert.equal(h["fx-tail"], "cloud"); // no test box owns grackle's 100.121.254.89
  } finally { t.cleanup(); }
});

test("reconciler seed of an absent id: foreign → cloud, own → local", async () => {
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

test("upsertProvider without a host infers it; an explicit host is kept", async () => {
  const t = fresh();
  try {
    await upsertProvider(t.db, { id: "u-raven", baseUrl: "http://10.0.0.126:8030/v1", models: [] });
    await upsertProvider(t.db, { id: "u-loop", baseUrl: "http://127.0.0.1:9/v1", models: [] });
    await upsertProvider(t.db, { id: "u-explicit", baseUrl: "http://10.0.0.126:8030/v1", host: "local", models: [] });
    const h = await hosts(t.db);
    assert.equal(h["u-raven"], "cloud");
    assert.equal(h["u-loop"], "local");
    assert.equal(h["u-explicit"], "local");
  } finally { t.cleanup(); }
});
```

For the `routes/models.js` change, add to the same file:

```js
import { readFileSync } from "node:fs";
test("the HF-token row writer uses a valid host value", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/routes/models.js"), "utf8");
  assert.equal(/host:\s*"external"/.test(src), false, 'routes/models.js must not write host:"external"');
});
```

This is a source check, and it is the one place one is acceptable, because the handler needs a full HTTP app to exercise. It can fail against today's code, since `:759` writes `"external"`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- tests/providers-host-inference.test.js`
Expected: FAIL.
- `fx-cloud`, `fx-raven` and `fx-tail` come out as `local`.
- `fx-raven` comes out as `local` in the reconciler test.
- `u-raven` comes out as `local`.
- The source check finds `"external"`.

- [ ] **Step 3: Implement**
  1. `providers-db.js`: delete the local `inferHost` function and add `import { inferHost } from "./provider-host.js";`.
  2. In `seedProvidersFromModelsJson`, change `args` from `p.host || "local",` to `inferHost(p.baseUrl, p.host),`.
  3. In `upsertProvider`, directly after the `provider.id` check, add:
     ```js
     const host = provider.host || inferHost(provider.baseUrl || provider.base_url || "", null);
     ```
     Then replace all three `provider.host || "local"` inside `upsertProvider` with `host`.
  4. In `syncProvidersFromModelsJson`, change `host: inferHost(p.baseUrl, p.host),` to `host: inferHost(p.baseUrl, p.host, { ownAddrs: addrs }),`.
  5. In the header, replace only the lines from ` * \`host\` column invariant (three allowed values only):` through ` *   - "cloud"            → no host; call base_url directly (OpenAI, Anthropic…)` with:
     ```
      * `host` column (spec 2026-09-22 provider-host-identity; helpers in ./provider-host.js):
      *   - "local"         the WRITER's own machine (loopback / own interface address).
      *   - "<instance-id>" 32-hex id of the serving Crow instance; written only
      *                     explicitly, never by inference.
      *   - "cloud"         not managed from here; call base_url directly (public
      *                     APIs and unmanaged network boxes alike).
      * host is NOT an orchestration gate: readers veto only a foreign instance id
      * (isForeignInstanceHost); locality comes from address/owner checks.
     ```
     **Keep** the following paragraph unchanged. It begins `Any new routing code MUST NOT treat…` and covers cloud rows versus bundle rows.
  6. In `servers/gateway/routes/models.js`, change `host: "external",` (in the HF-token `upsertProviderFn` call) to `host: "cloud",`.

- [ ] **Step 4: The deliberate change in `tests/providers-reconcile-gate.test.js`.** Run:

`npm test -- tests/providers-reconcile-gate.test.js`

Expected: the third reconcile call's `upserted === 0` / `unchanged === …` assertions (around lines 267–280) FAIL.

**This is a real, intended behaviour change, not an encoded bug.**
- The test's first call seeds `fx-tail-a/b` (`100.77.0.1`) with loopback-only addresses, so they are now stored as `cloud` rather than the old false `local`.
- The third call claims `100.77.0.1`, so its owned `assert` infers `local`, and that is a real write.

Edit that call's expectations as follows:
- the claimed entries whose seed was `cloud` now count in `upserted`, not `unchanged`;
- add an assertion that their stored `host` is now `local`;
- add a comment citing spec §4.1 "Tailscale boot race on write-time inference". The write here is exactly the self-heal on gaining ownership.

Change nothing else in the file. Then run: `npm test -- tests/providers-host-inference.test.js tests/providers-reconcile-gate.test.js tests/providers-upsert-noop.test.js tests/providers-war-sim.test.js tests/models-json-seam.test.js tests/providers-sync-wire.test.js tests/models-registration.test.js tests/models-panel.test.js`
Expected: PASS. If any other existing assertion now fails, stop and report it; do not edit it.

- [ ] **Step 5: Commit**

```bash
git add tests/providers-host-inference.test.js
git commit servers/shared/providers-db.js servers/gateway/routes/models.js tests/providers-host-inference.test.js tests/providers-reconcile-gate.test.js -m "fix(providers): every write path infers host by own-address membership; HF-token row writes a valid host"
git show --stat HEAD
```

---

### Task 3: The orchestrator stops gating on `host` (foreign-id veto only)

**Files:**
- Modify: `servers/gateway/gpu-orchestrator.js:574` and `:619`
- Test: `tests/gpu-orchestrator-host-gate.test.js` (append)

**Interfaces:** consumes `isForeignInstanceHost` (Task 1) and the orchestrator's existing `ownInstanceId(opts)` / `_setOwnInstanceIdForTest`.

- [ ] **Step 1: Append the failing tests**:

```js
import { maybeAcquireLocalProvider } from "../servers/gateway/gpu-orchestrator.js";

const SELF = "0867ac2809dedd885ba7769b21966f8e";
const OTHER = "49cf71ca878643ba7717f344329266fd";

test("D9: an own bundle marked cloud (boot-race seed) or with own id is still warmable; a foreign id is not", async () => {
  _setOwnInstanceIdForTest(SELF);
  try {
    const ready = { probeReadyFn: async () => true }; // fast path: "already resident" — nothing starts
    const mk = (host) => ({ providers: { p: { baseUrl: "http://127.0.0.1:1/v1", host, bundleId: "b" } } });
    assert.equal(await maybeAcquireLocalProvider("p", { cfg: mk("cloud"), ...ready }), true);
    assert.equal(await maybeAcquireLocalProvider("p", { cfg: mk(SELF), ...ready }), true);
    assert.equal(await maybeAcquireLocalProvider("p", { cfg: mk("local"), ...ready }), true);
    assert.equal(await maybeAcquireLocalProvider("p", { cfg: mk("grackle-5fc01ac74463b6f4"), ...ready }), true);
    assert.equal(await maybeAcquireLocalProvider("p", { cfg: mk(OTHER), ...ready }), null);
  } finally {
    _setOwnInstanceIdForTest(null);
  }
});

test("D9 resolveWarmableProviderName: own-id / cloud alias resolves to its local bundle sibling; foreign id does not", () => {
  _setOwnInstanceIdForTest(SELF);
  try {
    const cfg = { providers: {
      "bundle":       { baseUrl: "http://100.118.41.122:8003/v1", host: "local", bundleId: "b1" },
      "alias-self":   { baseUrl: "http://100.118.41.122:8003/v1", host: SELF,    bundleId: null },
      "alias-cloud":  { baseUrl: "http://100.118.41.122:8003/v1", host: "cloud", bundleId: null },
      "alias-other":  { baseUrl: "http://100.118.41.122:8003/v1", host: OTHER,   bundleId: null },
      "public-cloud": { baseUrl: "https://api.together.xyz/v1",   host: "cloud", bundleId: null },
    } };
    assert.equal(resolveWarmableProviderName(cfg, "alias-self", CROW), "bundle");
    assert.equal(resolveWarmableProviderName(cfg, "alias-cloud", CROW), "bundle");
    assert.equal(resolveWarmableProviderName(cfg, "alias-other", CROW), null);
    assert.equal(resolveWarmableProviderName(cfg, "public-cloud", CROW), null);
  } finally {
    _setOwnInstanceIdForTest(null);
  }
});
```

`maybeAcquireLocalProvider` may already be imported at the file's top; merge the import rather than duplicating it.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/gpu-orchestrator-host-gate.test.js`
Expected: FAIL.
- `mk("cloud")`, `mk(SELF)` and the grackle-label case return `null` instead of `true`.
- `alias-self` and `alias-cloud` return `null`.

- [ ] **Step 3: Implement.** In `gpu-orchestrator.js`:
  - Import: `import { isForeignInstanceHost } from "../shared/provider-host.js";`
  - In `maybeAcquireLocalProvider`, replace `if (p.host && p.host !== "local") return null;` (and the comment above it) with:
    ```js
    // host is not a locality gate (spec 2026-09-22 D9) — only "belongs to another Crow instance" vetoes;
    // orchestratableHere below decides by address/owner.
    if (isForeignInstanceHost(p.host, () => ownInstanceId(opts))) return null;
    ```
  - In `resolveWarmableProviderName`, replace `if (direct.host != null && direct.host !== "local") return null; // cloud alias — not warmable` with:
    ```js
    if (isForeignInstanceHost(direct.host, () => ownInstanceId())) return null; // another instance's alias — not warmable here
    ```

- [ ] **Step 4: Run and confirm everything passes**

Run: `npm test -- tests/gpu-orchestrator-host-gate.test.js tests/gpu-warm-resolve.test.js tests/gpu-orchestrator-native.test.js tests/gpu-orchestrator-reservation.test.js tests/chat-native-copy.test.js tests/models-panel.test.js tests/models-registration.test.js`
Expected: PASS. If a file name doesn't exist, use `ls tests | grep -i <stem>` to find the nearest match and run that instead.

If an existing test asserted that a `cloud` alias sharing a local bundle's `baseUrl` resolves to `null`, stop and report. That would mean a real caller depended on the old gate.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/gpu-orchestrator.js tests/gpu-orchestrator-host-gate.test.js -m "fix(orchestrator): host stops gating locality — only a foreign instance id vetoes (spec D9)"
git show --stat HEAD
```

---

### Task 4: `repairProviderHosts` in the reconciler

**Files:**
- Modify: `servers/shared/providers-db.js`: add `repairProviderHosts`, and run it from `syncProvidersFromModelsJson`, which returns `repaired`.
- Modify: `servers/gateway/boot/admin-api.js:152-155` (the log line)
- Test: `tests/providers-host-repair.test.js`

**Interfaces:**
- Produces `repairProviderHosts(db, { ownInstanceId?, ownAddrs? }) → Promise<{ repaired, changes: [{id, from, to}] }>`.
- `syncProvidersFromModelsJson` now returns `{ ..., repaired }`.

- [ ] **Step 1: Write the failing test** `tests/providers-host-repair.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { repairProviderHosts, syncProvidersFromModelsJson, setProviderSyncManager } from "../servers/shared/providers-db.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

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
  const own = getOrCreateLocalInstanceId(); // creates <dir>/instance-id
  const calls = [];
  setProviderSyncManager({ feedsDisabled: false, emitChange: async (...a) => { calls.push(a); } });
  const db = createDbClient(join(dir, "crow.db"));
  return {
    db, own, calls,
    cleanup() {
      setProviderSyncManager(null);
      if (prev.d === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev.d;
      if (prev.m === undefined) delete process.env.CROW_MODELS_JSON; else process.env.CROW_MODELS_JSON = prev.m;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function insert(db, id, host, baseUrl, instanceId, { bundleId = null, disabled = 0, gpuPolicy = null } = {}) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, host, bundle_id, models, disabled, lamport_ts, instance_id, gpu_policy)
          VALUES (?, ?, ?, ?, '[]', ?, 10, ?, ?)`,
    args: [id, baseUrl, host, bundleId, disabled, instanceId, gpuPolicy ? JSON.stringify(gpuPolicy) : null],
  });
}
async function get(db, id) {
  const { rows } = await db.execute({ sql: "SELECT host, lamport_ts FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

test("repairs exactly this instance's in-scope bad writes, nothing else; idempotent", async () => {
  const t = fresh();
  try {
    await insert(t.db, "raven-halogen-smoke", "local", "http://10.0.0.126:8731/v1", t.own);
    await insert(t.db, "raven-flash-next", "raven", "http://10.0.0.126:8030/v1", t.own);
    await insert(t.db, "peer-wrote-local", "local", "http://10.0.0.126:9999/v1", PEER);
    await insert(t.db, "own-addr-local", "local", "http://100.118.41.122:8003/v1", t.own);
    await insert(t.db, "dns-local", "local", "https://api.z.ai/v4", t.own);
    await insert(t.db, "cloud-ok", "cloud", "https://api.together.xyz/v1", t.own);
    await insert(t.db, "bundle-foreign", "local", "http://10.0.0.126:7000/v1", t.own, { bundleId: "b" });
    await insert(t.db, "disabled-foreign", "local", "http://10.0.0.126:7001/v1", t.own, { disabled: 1 });
    await insert(t.db, "hf-token", "external", "https://huggingface.co", t.own, { disabled: 1, gpuPolicy: { local_only: true } });

    const res = await repairProviderHosts(t.db, { ownInstanceId: t.own, ownAddrs: CROW });
    assert.deepEqual(res.changes.map((c) => c.id).sort(), ["raven-flash-next", "raven-halogen-smoke"]);
    for (const id of ["raven-halogen-smoke", "raven-flash-next"]) assert.equal((await get(t.db, id)).host, "cloud");
    for (const [id, h] of [["peer-wrote-local", "local"], ["own-addr-local", "local"], ["dns-local", "local"],
                           ["bundle-foreign", "local"], ["disabled-foreign", "local"], ["hf-token", "external"]]) {
      assert.equal((await get(t.db, id)).host, h, id);
    }
    assert.equal(t.calls.length, 2, "exactly two sync emits");

    const lamport = (await get(t.db, "raven-flash-next")).lamport_ts;
    const res2 = await repairProviderHosts(t.db, { ownInstanceId: t.own, ownAddrs: CROW });
    assert.equal(res2.repaired, 0);
    assert.equal(t.calls.length, 2);
    assert.equal((await get(t.db, "raven-flash-next")).lamport_ts, lamport);
  } finally { t.cleanup(); }
});

test("G1 boot race: no CGNAT own address → 100.x rows untouched; loopback-only → nothing", async () => {
  const t = fresh();
  try {
    await insert(t.db, "tail-local", "local", "http://100.99.0.1:8003/v1", t.own);
    await insert(t.db, "tail-invalid", "raven", "http://100.99.0.2:8003/v1", t.own);
    const noTs = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]);
    assert.equal((await repairProviderHosts(t.db, { ownInstanceId: t.own, ownAddrs: noTs })).repaired, 0);
    const loop = new Set(["localhost", "127.0.0.1", "::1"]);
    assert.equal((await repairProviderHosts(t.db, { ownInstanceId: t.own, ownAddrs: loop })).repaired, 0);
    assert.equal((await get(t.db, "tail-local")).host, "local");
    assert.equal((await get(t.db, "tail-invalid")).host, "raven");
  } finally { t.cleanup(); }
});

test("syncProvidersFromModelsJson runs the repair even with no models.json, and reports it", async () => {
  const t = fresh();
  try {
    await insert(t.db, "raven-flash-next", "raven", "http://10.0.0.126:8030/v1", t.own);
    const res = await syncProvidersFromModelsJson(t.db, { ownAddrs: CROW });
    assert.equal(res.repaired, 1);
    assert.equal((await get(t.db, "raven-flash-next")).host, "cloud");
  } finally { t.cleanup(); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- tests/providers-host-repair.test.js`
Expected: FAIL. `repairProviderHosts` is not exported.

- [ ] **Step 3: Implement.** In `providers-db.js`:
  - Change the import to `import { inferHost, repairHostDecision } from "./provider-host.js";`.
  - Add after `reenableProviderPreservingContent`:

```js
/**
 * Spec 2026-09-22 §3.4: repair provider rows whose host THIS instance wrote
 * wrongly. Scope, D3, G1 and G2 live in repairHostDecision (pure). Round-trips
 * the parsed listProvidersAll shape (R2-M2) so upsertProvider re-stamps and emits.
 * Harmless if imperfect: host is not an orchestration gate (D9).
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
    1. Add `repaired: 0` to `counters`.
    2. Replace the two early returns:
       ```js
       if (!config?.providers) return { ...counters, source: path };
       const entries = Object.entries(config.providers).filter(([id]) => !id.startsWith("$"));
       if (entries.length === 0) return { ...counters, source: path };
       ```
       with
       ```js
       const entries = config?.providers
         ? Object.entries(config.providers).filter(([id]) => !id.startsWith("$"))
         : [];
       ```
    3. Immediately before the function's final `return { ...counters, source: path };`, insert:
       ```js
       const rep = await repairProviderHosts(dbClient, { ownAddrs: addrs });
       counters.repaired = rep.repaired;
       ```
  - In `admin-api.js`, change the condition to `if (res.upserted > 0 || res.reenabled > 0 || res.repaired > 0)` and append ` repaired=${res.repaired}` to the log template.

- [ ] **Step 4: Run and confirm everything passes**

Run: `npm test -- tests/providers-host-repair.test.js tests/providers-reconcile-gate.test.js tests/providers-host-inference.test.js tests/models-json-seam.test.js`
Expected: PASS.

`providers-reconcile-gate` deep-equals return objects. If it now fails only because of the new `repaired` key, add `repaired: 0` to those expected objects. Its fixture rows are all seeded as valid hosts, so repair finds nothing. Name the change in the commit body.

- [ ] **Step 5: Commit**

```bash
git add tests/providers-host-repair.test.js
git commit servers/shared/providers-db.js servers/gateway/boot/admin-api.js tests/providers-host-repair.test.js tests/providers-reconcile-gate.test.js -m "feat(providers): repairProviderHosts — scoped, own-writes-only, boot-race-guarded host repair in the hourly reconciler"
git show --stat HEAD
```

---

### Task 5: Mutual two-instance simulation, with the reconciler in the loop

**Files:**
- Test: `tests/providers-host-repair-sim.test.js`

Model it on `tests/providers-war-sim.test.js`, and read that harness first. Copy these verbatim:
- the imports (plus `writeFileSync`);
- the two `init-db`'d tmp dirs;
- `IDENTITY`;
- `InstanceSyncManager` construction;
- `makeStubFeed`;
- `conflictCount`;
- the `after` cleanup.

Then make these changes:
- **Ids:** `const A_ID = "a".repeat(32); const B_ID = "b".repeat(32);`. Write them into `join(dirA,"instance-id")` and `join(dirB,"instance-id")` with `writeFileSync` **before** any upsert.
- **Per-scenario, per-side fixtures (review round 2, C1).** Each scenario writes its OWN two files, `join(dirA, \`models-${scenario}.json\`)` and the same for B, and `side()` points `CROW_MODELS_JSON` at the current scenario's file.
  - Scenarios A and C: both files are `{"providers":{}}`.
  - Scenario B: A's file is `{"providers":{}}`, and B's declares
    `"grackle-embed": { "baseUrl": "http://100.121.254.89:9100/v1", "host": "local", "models": [{ "id": "e" }] }`.
  - A file shared across scenarios would make B's reconciler **seed** `grackle-embed` into A's and C's empty tables, because `reconcileDecision` returns "seed" for any absent row. That would break their `feedBtoA.length === 0` assertions.
- **Side switching:** a helper `async function side(which, scenario)` sets `process.env.CROW_DATA_DIR`, `process.env.CROW_MODELS_JSON` (that side's scenario file) and `setProviderSyncManager(mgrX)`.
- **Hermetic setup and cleanup:**
  - Pass `CROW_MODELS_JSON: ""` in `init-db`'s env.
  - The `after` hook restores BOTH `CROW_DATA_DIR` and `CROW_MODELS_JSON` to their previous values, or deletes them if they were unset.
- **Fresh, uniquely keyed feeds per test (review round 2, C2).**
  - `makeStubFeed()` gains `key: randomBytes(32)` (import `randomBytes` from `node:crypto`). `_getLastAppliedSeq` (`instance-sync.js:3765-3772`) compares `Buffer.from(feed.key).toString("hex")` against the stored cursor's `k`. An unkeyed feed stores `k:null` and matches every later unkeyed feed, so the cursor carries over between tests and a new feed's seq 0 is silently skipped.
  - At the start of each test, **also** run `DELETE FROM providers`, `DELETE FROM sync_conflicts` and `DELETE FROM sync_state` on both DBs. Check the cursor's table and column name with `grep -n "_appliedSeqRecord" -A12 servers/sharing/instance-sync.js`, and clear whatever table it reads.
  - Build `feedAtoB` and `feedBtoA` fresh, then call `mgrA.outFeeds.set(B_ID, feedAtoB)` and `mgrB.outFeeds.set(A_ID, feedBtoA)`.
- **Delivery:** `const deliver = (feed, mgr, fromId) => mgr._processNewEntries(fromId, feed);`. War-sim calls it repeatedly on the same feed, so it tracks its own cursor.
- **Addresses:** `ADDRS_A = new Set(["127.0.0.1","::1","localhost","10.0.0.237","100.118.41.122"])` and `ADDRS_B = new Set(["127.0.0.1","::1","localhost","10.0.0.21","100.121.254.89"])`.
- **Round function:** `async function round(scenario, addrsA, addrsB)` runs
  1. `side("A", scenario)` then `syncProvidersFromModelsJson(dbA, { ownAddrs: addrsA })`, which includes repair;
  2. `side("B", scenario)` then `syncProvidersFromModelsJson(dbB, { ownAddrs: addrsB })`;
  3. `deliver(feedAtoB, mgrB, A_ID)`;
  4. `deliver(feedBtoA, mgrA, B_ID)`.

- [ ] **Step 1: Write three scenarios:**

  - **Scenario A: A's bad write converges.**
    - Insert `('raven-x','http://10.0.0.126:8030/v1','raven', lamport 50, instance_id A_ID, bundle_id NULL)` into both DBs.
    - Run 4 rounds.
    - Assert: both hosts are `cloud`; the lamports are equal; `feedAtoB.length === 1`; `feedBtoA.length === 0`; conflicts total 0.
    - Record both lamports after round 2 and assert they are unchanged after round 4 (clocks stop).
  - **Scenario B: the owner asserts and the non-owner never fights it.**
    - Insert `('grackle-embed','http://100.121.254.89:9100/v1','local', models '[{"id":"e"}]', bundle_id NULL, gpu_policy NULL, lamport 50, instance_id B_ID)` into both DBs. The models match B's file exactly, so B's owned assert is a no-op (review round 2, C3).
    - Run 4 rounds.
    - Assert **in this order**:
      1. B's lamport after round 2 equals B's lamport after round 4, and both stay 50. This goes first so that mutation (b) fails here.
      2. Both rows are `local`.
      3. `feedAtoB.length === 0` and `feedBtoA.length === 0`, since B's assert is a no-op.
      4. No conflicts.
  - **Scenario C: a re-stamped bundle row (the live crow-chat case).**
    - Insert `('crow-swap-agentic','http://100.118.41.122:8003/v1','local', lamport 50, instance_id B_ID, bundle_id 'llamacpp-vulkan-qwen36-35b-a3b')` into both DBs. B is the last writer, but the endpoint is A's.
    - Run 4 rounds.
    - Assert: both still `local`; `feedBtoA.length === 0`; no conflicts.

  - **Scenario D: co-owners compute the same value (optional but cheap; review round 2, Q2).**
    - A and B share one address set (both `ADDRS_A`), and each is last writer of its own copy: `('raven-y','http://10.0.0.126:8030/v1','raven', lamport 50)` with instance_id A_ID in dbA and B_ID in dbB. Both files are empty.
    - Run 4 rounds.
    - Call `round("D", ADDRS_A, ADDRS_A)`.
    - Assert:
      - both copies are `cloud`;
      - both lamports are equal;
      - **exactly 0** conflict rows. `rowsEquivalent` ignores `lamport_ts` and `instance_id`, so equal-lamport, equal-data deliveries are skipped (verified in plan review round 3). Spec §4.1's "≤1" remains the documented bound.

- [ ] **Step 2: Prove the sim can fail.** Make two temporary mutations, running the file after each and reverting (`git diff servers/shared/provider-host.js` must be empty at the end):
  - (a) Delete the `if (!inRepairScope(row)) return null;` line in `repairHostDecision`. Expected: scenario C FAILS, because B repairs A's row to `cloud` and `feedBtoA.length` becomes greater than 0.
  - (b) Delete the D3 line (`if (!ownInstanceId || row.instance_id !== ownInstanceId) return null;`). Scenario B's row is already non-bundle.
    - Expected: scenario B FAILS, because A rewrites B's `local` to `cloud` and emits. Once the cursors are keyed, B then applies it, B's owned assert writes `local` back, and the lamports keep climbing across rounds.
    - Add an explicit assertion for the climb: record B's lamport after rounds 2 and 4 and assert they are equal. The mutated run must fail on THAT assertion, not only on a feed length.

  Run: `npm test -- tests/providers-host-repair-sim.test.js` after each mutation.

- [ ] **Step 3: Run it and confirm it passes**

Run: `npm test -- tests/providers-host-repair-sim.test.js tests/providers-war-sim.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/providers-host-repair-sim.test.js
git commit tests/providers-host-repair-sim.test.js -m "test(providers): two-instance host-repair sim with owner reconcile in the loop — converges, never fights, clocks stop"
git show --stat HEAD
```

---

### Task 6: Dashboard badge

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/llm/providers-tab.js` (`hostBadge` at `:26-31`, and `render`)
- Test: `tests/providers-tab-host-badge.test.js`

- [ ] **Step 1: Write the failing test**:

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

- [ ] **Step 3: Implement.**
  - Add the imports. Resolve each path from `servers/gateway/dashboard/settings/sections/llm/` and check the file exists:
    ```js
    import { hostLabel } from "../../../../../shared/provider-host.js";
    import { getOwnAddresses } from "../../../../../shared/locality.js";
    import { getOrCreateLocalInstanceId } from "../../../../instance-registry.js";
    ```
  - Replace `hostBadge`:

```js
export function hostBadge(p, ctx) {
  const base = `font-size:0.72rem;padding:2px 8px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);white-space:nowrap`;
  const { kind, text } = hostLabel(p, ctx);
  const color = kind === "cloud" ? "var(--crow-accent)" : "var(--crow-text-secondary)";
  const suffix = kind === "cloud" && p.provider_type ? ` · ${escapeHtml(p.provider_type)}` : "";
  return `<span style="${base};color:${color}" title="stored host: ${escapeHtml(String(p.host ?? ""))}">${escapeHtml(text)}${suffix}</span>`;
}
```

  - In `render({ db })`, after `listProvidersAll`:

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

    Then change `${hostBadge(p)}` to `${hostBadge(p, hostCtx)}`.

- [ ] **Step 4: Run and confirm it passes, then smoke-boot**

Run: `npm test -- tests/providers-tab-host-badge.test.js tests/provider-host.test.js`
Expected: PASS.

Smoke boot, isolated, WITH the reconcile path (no `--no-auth`) and run-suite's safety env:

```bash
cd /home/kh0pp/crow-wt-host-identity && export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
T=$(mktemp -d)
CROW_HOME=$T CROW_DATA_DIR=$T/data CROW_MODELS_JSON= CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1 \
CROW_DISABLE_BOT_RUNTIME=1 CROW_DISABLE_PERCH=1 CROW_BOX_RESERVATION_PATH=$T/box-reservation.json \
PORT= CROW_GATEWAY_PORT=3999 timeout 25 node servers/gateway/index.js 2>&1 | tail -30; rm -rf $T
```

Expected: a clean startup, no stack traces, and the `[providers]` reconcile either quiet or logging `repaired=0`. Check `scripts/run-suite.mjs` for the exact env var names it sets and use those. If the gateway needs a different port variable, read `servers/gateway/index.js` for it.

- [ ] **Step 5: Commit**

```bash
git add tests/providers-tab-host-badge.test.js
git commit servers/gateway/dashboard/settings/sections/llm/providers-tab.js tests/providers-tab-host-badge.test.js -m "feat(dashboard): provider host badge says where the endpoint actually is"
git show --stat HEAD
```

---

### Task 7: Live-data dry run, full suite, PR

**Files:**
- Create: `scripts/ops/provider-host-repair-dryrun.mjs` (read-only)

- [ ] **Step 1: Write the script.** It must be read-only and must simulate BOTH the owned-assert host changes and the repair:

```js
#!/usr/bin/env node
// Read-only: on a COPY of a crow.db, what would (1) the reconciler's owned
// asserts change in `host`, and (2) repairProviderHosts change? Each is
// evaluated against the pre-assert state; in the real pass repair sees the
// post-assert row — equivalent today because asserted rows are models.json
// rows and repair's scope excludes nothing they could flip into.
// Usage: provider-host-repair-dryrun.mjs <db-copy> <own-instance-id> <addr,addr,...> [models.json,...]
import { readFileSync } from "node:fs";
import { createDbClient } from "../../servers/db.js";
import { listProvidersAll } from "../../servers/shared/providers-db.js";
import { inferHost, repairHostDecision } from "../../servers/shared/provider-host.js";
import { isLocallyOrchestratable } from "../../servers/shared/locality.js";

const [dbPath, ownInstanceId, addrCsv, modelsCsv = ""] = process.argv.slice(2);
if (!dbPath || !ownInstanceId || !addrCsv) {
  console.error("usage: provider-host-repair-dryrun.mjs <db-copy> <own-instance-id> <addr,...> [models.json,...]");
  process.exit(2);
}
const ownAddrs = new Set(["localhost", "127.0.0.1", "::1", ...addrCsv.split(",")]);
const file = {};
for (const p of modelsCsv.split(",").filter(Boolean)) {
  try { Object.assign(file, JSON.parse(readFileSync(p, "utf8")).providers || {}); } catch (e) { console.error(`skip ${p}: ${e.message}`); }
}
const db = createDbClient(dbPath);
const rows = await listProvidersAll(db);
let a = 0, r = 0;
for (const row of rows) {
  const f = file[row.id];
  if (f && !row.disabled && isLocallyOrchestratable({ baseUrl: f.baseUrl }, ownAddrs)) {
    const h = inferHost(f.baseUrl, f.host, { ownAddrs });
    if (h !== row.host) { a++; console.log(`ASSERT\t${row.id}\t${row.host} -> ${h}`); }
  }
  const next = repairHostDecision(row, { ownInstanceId, ownAddrs });
  if (next !== null) { r++; console.log(`REPAIR\t${row.id}\t${row.host} -> ${next}\t${row.baseUrl}`); }
}
console.log(`assert host changes: ${a}; repairs: ${r}`);
db.close?.();
```

- [ ] **Step 2: Run it against COPIES** (never the live files). Grackle's DB lives at `~/crow/data/crow.db`.

```bash
S=$(mktemp -d)
# read-only opens (servers/db.js:503-507 warns against a second read-write opener of a live WAL db)
sqlite3 "file:$HOME/.crow/data/crow.db?mode=ro" ".backup $S/crow.db"
sqlite3 "file:$HOME/.crow-r4/data/crow.db?mode=ro" ".backup $S/r4.db"
ssh kh0pp@10.0.0.21 'sqlite3 "file:$HOME/crow/data/crow.db?mode=ro" ".backup /tmp/gr.db"' && scp -q kh0pp@10.0.0.21:/tmp/gr.db $S/gr.db && scp -q kh0pp@10.0.0.21:crow/config/models.json $S/gr-models.json; ssh kh0pp@10.0.0.21 rm -f /tmp/gr.db
node scripts/ops/provider-host-repair-dryrun.mjs $S/crow.db 0867ac2809dedd885ba7769b21966f8e 10.0.0.237,100.118.41.122 ~/crow/config/models.json,$HOME/.pi/agent/models.json
node scripts/ops/provider-host-repair-dryrun.mjs $S/r4.db   c22c6af81c13ff920ce609d2d61d8065 10.0.0.237,100.118.41.122 ~/crow/config/models.json,$HOME/.pi/agent/models.json
node scripts/ops/provider-host-repair-dryrun.mjs $S/gr.db   49cf71ca878643ba7717f344329266fd 10.0.0.21,100.121.254.89 $S/gr-models.json
rm -rf $S
```

r4's gateway (the **system** unit `crow-r4-gateway.service`) sets no `CROW_MODELS_JSON` and runs with `WorkingDirectory=/home/kh0pp/crow` and the same HOME. So it reads the same models.json files as crow, as passed above (verified in review round 2).

Expected: `REPAIR raven-flash-next raven -> cloud` and `REPAIR raven-halogen-smoke local -> cloud` on crow and on r4, and 0 repairs on grackle.
- ASSERT lines are allowed only where the file declares a host that is invalid or missing (for example grackle's label → `local`).
- **Any other REPAIR or ASSERT line is a STOP.** Investigate, and fix the spec and plan before continuing.
- Record all three outputs verbatim for the PR body.

- [ ] **Step 3: Full suite and static checks**

Run: `node scripts/run-suite.mjs` (Node 22).
Expected: 0 failures. Record the pass count, and run the suite on `main` for the baseline if it isn't known.

Then run:
- `npm test -- tests/auth-network.test.js` (expected PASS);
- `node scripts/check-port-allocation.js` (expected OK);
- `node scripts/build-registry.mjs --check` (expected OK; this is the script CI runs).

- [ ] **Step 4: Commit the script, rebase, push, open the PR**

```bash
git add scripts/ops/provider-host-repair-dryrun.mjs
git commit scripts/ops/provider-host-repair-dryrun.mjs -m "ops: read-only provider host dry run (owned asserts + repair)"
git pull --rebase origin main
git push -u origin spec/provider-host-identity
```

Open the PR with the GitHub MCP (`mcp__github__create_pull_request`, owner `kh0pper`, repo `crow`, base `main`). The body covers:
- the problem, with the live rows;
- the D9 decision;
- the repair scope and guards;
- the three dry-run outputs;
- suite counts;
- "no schema change";
- the accepted limitations (§4.1), including the Messages picker "(cloud)" label.

No attribution lines.

- [ ] **Step 5: CI.** Query `https://api.github.com/repos/kh0pper/crow/commits/<head-sha>/check-runs`. `suite`, `static-checks` and `audit` must all be `completed` / `success`. An empty result is wrong; investigate it rather than merge.

---

### Task 8: Merge, deploy, live verification

- [ ] **Step 1:**
  - Read `~/CROW-SCHEDULE.md` and run `node ~/crow/scripts/ops/box-reserve.mjs status`.
  - Merge only when no crow window is active or due within 30 minutes.
  - Add a reservation row "provider-host-identity deploy (gateway restarts)" to CROW-SCHEDULE, and move it to Done afterwards.
- [ ] **Step 2:**
  - Squash-merge through the GitHub MCP.
  - Confirm that `~/crow` is on `main` at the merge sha, and that `auto_update_last_result` in `dashboard_settings` is not "Skipped" (`sqlite3 ~/.crow/data/crow.db "select value from dashboard_settings where key='auto_update_last_result'"`).
  - If auto-update hasn't restarted the gateways within 15 minutes, run `echo '8r00kly^' | sudo -S systemctl restart crow-gateway crow-r4-gateway`. Both are **system** units, not user units (verified in review round 2).
- [ ] **Step 3:**
  - **Do not use the dashboard "Sync bundle providers" (force) button.** Its re-enable path re-stamps `instance_id`.
  - The reconcile runs at boot, so after the restart run:
    ```bash
    sqlite3 ~/.crow/data/crow.db "select id,host,lamport_ts from providers where id in ('raven-flash-next','raven-halogen-smoke','crow-chat','crow-voice','crow-swap-agentic')"
    ```
    Expected: the raven rows are `cloud`, and the three crow bundle rows are `local`, unchanged.
  - Repeat on `~/.crow-r4/data/crow.db`.
  - Confirm with `journalctl -u crow-gateway --since "-10 min" | grep "\[providers\]"` and the same for `-u crow-r4-gateway`. Each should show `repaired=2`. They are system units; use `sudo -S` if the journal needs it.
- [ ] **Step 4:**
  - One hour later, re-run the Step 3 query. The raven rows' lamports must be unchanged.
  - Run `sqlite3 ~/.crow/data/crow.db "select count(*) from sync_conflicts where table_name='providers' and created_at > datetime('now','-1 hour')"`. Expected: 0, or a one-time burst for these cases, but none recurring on a second check an hour later:
- the raven ids arriving from grackle's stale copy;
- grackle's `grackle-*` rows flipping from their label to `local` through grackle's owned assert. r4 and crow last-wrote their copies at lower lamports (review round 2, Q1).
- [ ] **Step 5:** Check that chat on crow still reaches crow's own 35b through `crow-chat`, which proves the D9 gate did not regress. Send one short chat through the dashboard, or `curl` the `/llm/v1` door with the local token. Also check that the Providers tab shows "network" for the raven rows and "this machine" for crow's own rows.
- [ ] **Step 6:**
  - Two-host spec §3.1 lives on branch `spec/heavy-model-catalog-curation`, worktree `~/crow-wt-catalog`, PR #344. Replace the "Set **`host = 'raven'`**" requirement with "unmanaged network endpoints are `cloud`; `host` is not an orchestration gate (see `docs/superpowers/specs/2026-09-22-provider-host-identity-design.md`)". Commit with a path and push.
  - Update memory `crow-inferhost-private-address-bug.md` to FIXED, with the PR number and merge sha.
  - Update the Gitea queue doc: sub-project 1 done.


## Review

- **Round 1 (2026-09-22): REVISE.** Seven critical issues:
  - C1: the D3 premise is broken by writes that re-stamp `instance_id`. The live crow bundle rows carry grackle's `instance_id`.
  - C2: G1 did not cover the invalid-value branch.
  - C3: `routes/models.js` wrote `host:"external"`.
  - C4: the tests read an `instance-id` file that `init-db` never creates.
  - C5: the reconcile-gate expectation change.
  - C6: the simulation did not run the reconciler.
  - C7: a `maybeAcquireLocalProvider` test that could not fail.

  **Resolution:** the spec was revised. D9 makes `host` stop gating orchestration except for a foreign-id veto, which is the root fix for C1. Repair was scoped to non-bundle, non-owner, not-`local_only`, enabled rows. G1 was generalised. All the test issues were rewritten.
- **Round 2: REVISE.** Five issues:
  - C1: the shared simulation fixture seeded rows into the other scenarios.
  - C2: unkeyed stub feeds share one cursor across tests.
  - C3: scenario B's `models` did not match.
  - C4: the gateways are **system** units, not user units.
  - C5: the script is `build-registry.mjs`.

  **Resolution:** all fixed. The spec now records grackle's label→`local` change through its own assert, rerank and vision becoming swappable on grackle, the residual D3 hole, and G1's coarseness.
- **Round 3: APPROVE**, with minor notes (scenario B assertion order, `round()` signature, env restore, scenario D asserting exactly 0 conflicts, `PORT=` on the smoke boot). All were folded in. Every scenario and both mutations were traced by hand against the lamport arithmetic.
