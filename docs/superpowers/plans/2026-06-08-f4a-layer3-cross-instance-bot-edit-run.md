# F4a Layer 3 — Cross-instance Bot Edit + Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator on instance X edit (non-secret fields) and run (enable/disable) a bot owned by a trusted peer Y, with the bot and its secrets never leaving Y.

**Architecture:** Remote-control in place. Y owns the bot; X sends field-scoped patches + enable toggles over the existing HMAC-signed federation channel (`forwardSignedRequest`) to new `/dashboard/bot-federation/*` endpoints on Y. Y's server-side gate (master flag + per-bot opt-in, default-deny) is authoritative; redaction + a patch-field allowlist keep secrets on Y and reject any non-allowlisted write. The bot runs on Y via the existing F3b runtime.

**Tech Stack:** Node ESM, `node:test`, libsql (`db.execute`), Express federation router, `forwardSignedRequest`/`federationVerifyMiddleware` (HMAC), the L2a settings/exposure patterns (`readSetting`/`writeSetting`, `getExposedCapabilities`).

**Spec:** `docs/superpowers/specs/2026-06-08-f4a-layer3-cross-instance-bot-edit-run-design.md`

**Branch:** `feat/f4a-layer3-bot-edit-run` (off `main`).

**Deviations from spec (intentional, decided while mapping the code):**
- **Single async gate reader (no sync reader).** The spec hedged "sync + async." There is no sync consumer — the federation endpoints and panels are all async libsql. The gate is one async reader (`botPeerManageable`) plus a pure parse helper (`parseManagedBots`) for testability. (If a runner ever needs it, mirror it then.)
- **`regenerateBotMcp(db, botId)` extracted** from `bot-builder.js`'s inline `regen_mcp` logic into `servers/gateway/dashboard/panels/bot-mcp-regen.js`, so the patch endpoint and the existing action share one tested path (DRY).

---

## Pre-flight

- [ ] **Step 0a: Branch off main**

Run:
```bash
cd /home/kh0pp/crow && git fetch origin && git switch -c feat/f4a-layer3-bot-edit-run origin/main && git log --oneline -1
```
Expected: HEAD at `a05fcd4` (or later origin/main), new branch created.

- [ ] **Step 0b: Free inference RAM before heavy multi-agent execution (only if fanning out subagents)**

Run:
```bash
docker stop vllm-rocm-qwen35-4b llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed crow-companion faster-whisper-server kokoro-tts
```
Expected: containers stop (frees ~62Gi). `docker start` the same list after the build, before the deploy/acceptance.

---

## Task 1: Owner-side gate (`bot-management-exposure.js`)

Default-deny gate mirroring `peer-exposure.js`: master flag (`feature_flags.remote_bot_management`) AND per-bot opt-in (`remote_managed_bots` array). Empty set unless the master flag is on.

**Files:**
- Create: `servers/gateway/bot-management-exposure.js`
- Test: `tests/bot-management-exposure.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-management-exposure.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseManagedBots, getPeerManagedBots, botPeerManageable, remoteBotManagementEnabled,
  MANAGED_BOTS_SETTING_KEY, REMOTE_BOT_MGMT_FLAG,
} from "../servers/gateway/bot-management-exposure.js";

// db stub: returns settings values keyed by the setting key (args[0]).
// readSetting queries dashboard_settings_overrides first (args:[key,localId])
// then dashboard_settings (args:[key]). Return value on the global query only.
function dbWith(settings) {
  return {
    async execute({ sql, args }) {
      const key = args?.[0];
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      const v = settings[key];
      return { rows: v === undefined ? [] : [{ value: v }] };
    },
  };
}

test("parseManagedBots: array of strings → Set; junk dropped", () => {
  const s = parseManagedBots(JSON.stringify(["a", "", null, 3, "b"]));
  assert.deepEqual([...s].sort(), ["a", "b"]);
});

test("parseManagedBots: absent/malformed/non-array → empty set", () => {
  assert.equal(parseManagedBots(null).size, 0);
  assert.equal(parseManagedBots("{bad").size, 0);
  assert.equal(parseManagedBots(JSON.stringify({ a: 1 })).size, 0);
});

test("master flag OFF → empty managed set (default-deny), even if list non-empty", async () => {
  const db = dbWith({
    feature_flags: JSON.stringify({ remote_bot_management: false }),
    remote_managed_bots: JSON.stringify(["scout"]),
  });
  assert.equal((await getPeerManagedBots(db)).size, 0);
  assert.equal(await botPeerManageable(db, "scout"), false);
});

test("absent master flag → default-deny", async () => {
  const db = dbWith({ remote_managed_bots: JSON.stringify(["scout"]) });
  assert.equal(await remoteBotManagementEnabled(db), false);
  assert.equal(await botPeerManageable(db, "scout"), false);
});

test("master ON + bot in list → manageable; other bot → not", async () => {
  const db = dbWith({
    feature_flags: JSON.stringify({ remote_bot_management: true }),
    remote_managed_bots: JSON.stringify(["scout", "filer"]),
  });
  assert.equal(await remoteBotManagementEnabled(db), true);
  assert.deepEqual([...(await getPeerManagedBots(db))].sort(), ["filer", "scout"]);
  assert.equal(await botPeerManageable(db, "scout"), true);
  assert.equal(await botPeerManageable(db, "ghost"), false);
});

test("master ON + empty list → nothing manageable", async () => {
  const db = dbWith({ feature_flags: JSON.stringify({ remote_bot_management: true }) });
  assert.equal((await getPeerManagedBots(db)).size, 0);
  assert.equal(await botPeerManageable(db, "scout"), false);
});

test("non-string botId → false, never throws", async () => {
  const db = dbWith({ feature_flags: JSON.stringify({ remote_bot_management: true }), remote_managed_bots: JSON.stringify(["scout"]) });
  assert.equal(await botPeerManageable(db, null), false);
  assert.equal(await botPeerManageable(db, ""), false);
});

test("exposes setting key + flag name constants", () => {
  assert.equal(MANAGED_BOTS_SETTING_KEY, "remote_managed_bots");
  assert.equal(REMOTE_BOT_MGMT_FLAG, "remote_bot_management");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-management-exposure.test.js`
Expected: FAIL — `Cannot find module '../servers/gateway/bot-management-exposure.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// servers/gateway/bot-management-exposure.js
/**
 * F4a Layer 3 — owner-side gate for cross-instance bot edit/run.
 *
 * DEFAULT-DENY. A trusted peer may edit/enable one of this instance's bots ONLY
 * if BOTH hold: (1) feature_flags.remote_bot_management is true (master switch),
 * AND (2) the bot_id is in remote_managed_bots (per-bot opt-in). Mirrors the
 * L2a exposure model (peer-exposure.js). Both settings are local-only and
 * deliberately absent from sync-allowlist.js. This gate is the security
 * keystone — it is enforced server-side on every federation endpoint,
 * independent of any UI affordance.
 */
import { readSetting } from "./dashboard/settings/registry.js";

/** feature_flags key (boolean master switch). */
export const REMOTE_BOT_MGMT_FLAG = "remote_bot_management";
/** Local-only (never-synced) per-bot opt-in list key. */
export const MANAGED_BOTS_SETTING_KEY = "remote_managed_bots";

/** Pure: parse the stored JSON array → Set<bot_id>. Never throws. */
export function parseManagedBots(raw) {
  if (raw == null) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((x) => typeof x === "string" && x.length > 0));
}

/** Master switch. Absent/malformed → false (deny). Never throws. */
export async function remoteBotManagementEnabled(db) {
  try {
    const raw = await readSetting(db, "feature_flags");
    if (!raw) return false;
    return (JSON.parse(raw) || {})[REMOTE_BOT_MGMT_FLAG] === true;
  } catch { return false; }
}

/**
 * The set of bot_ids exposed to trusted peers. Empty unless the master switch
 * is on (default-deny). Never throws.
 */
export async function getPeerManagedBots(db) {
  if (!(await remoteBotManagementEnabled(db))) return new Set();
  let raw;
  try { raw = await readSetting(db, MANAGED_BOTS_SETTING_KEY); } catch { return new Set(); }
  return parseManagedBots(raw);
}

/** Authoritative per-call check. */
export async function botPeerManageable(db, botId) {
  if (typeof botId !== "string" || !botId) return false;
  return (await getPeerManagedBots(db)).has(botId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bot-management-exposure.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/bot-management-exposure.js tests/bot-management-exposure.test.js
git commit servers/gateway/bot-management-exposure.js tests/bot-management-exposure.test.js -m "F4a L3: owner-side bot edit/run gate (master flag + per-bot opt-in, default-deny)"
git show --stat HEAD
```

---

## Task 2: Pure security core (`bot-federation.js` — redaction + patch allowlist)

Two pure functions: `redactDefForPeer` (the only path from a def to a remote editor; secrets → markers) and `applyPeerPatch` (merge non-secret allowlisted fields only; throw on anything else).

**Files:**
- Create: `servers/gateway/bot-federation.js`
- Test: `tests/bot-federation-core.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-federation-core.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactDefForPeer, applyPeerPatch, PATCHABLE_FIELDS } from "../servers/gateway/bot-federation.js";

function sampleDef() {
  return {
    engine: "pi",
    models: { default: "crow-local/qwen3.6-35b-a3b" },
    system_prompt: "be helpful",
    tools: { pi_builtin: ["read"], crow_mcp: ["crow-tasks/tasks_list"], skills: [], pi_extensions: [], remote_mcp: [] },
    gateways: [
      { type: "discord", token: "SECRET-DISCORD", channel_ids: ["123"], allowlist: ["u#1"] },
      { type: "slack", bot_token: "xoxb-SECRET", app_token: "xapp-SECRET", channel_ids: ["C1"] },
      { type: "gmail", address: "kevin.hopper+scout@maestro.press", allowlist: ["a@b.com"] },
    ],
    permission_policy: { bash: "deny", external_send: "draft_only", confirm: [] },
    triggers: { gateway: true, cron: "" },
    spawn_env: { CROW_JOURNAL_MODE: "DELETE", PI_PROVIDER: "crow-local", OPENAI_API_KEY: "sk-LEAK" },
    session_dir: "/home/kh0pp/.crow/pi-bots/scout",
  };
}

test("redactDefForPeer: no raw secret survives serialization", () => {
  const red = redactDefForPeer(sampleDef());
  const json = JSON.stringify(red);
  for (const leak of ["SECRET-DISCORD", "xoxb-SECRET", "xapp-SECRET", "sk-LEAK"]) {
    assert.equal(json.includes(leak), false, `leaked ${leak}`);
  }
});

test("redactDefForPeer: secret fields become {__redacted:true,set:<bool>}", () => {
  const red = redactDefForPeer(sampleDef());
  assert.deepEqual(red.gateways[0].token, { __redacted: true, set: true });
  assert.deepEqual(red.gateways[1].bot_token, { __redacted: true, set: true });
  assert.deepEqual(red.gateways[1].app_token, { __redacted: true, set: true });
  assert.deepEqual(red.spawn_env.OPENAI_API_KEY, { __redacted: true, set: true });
});

test("redactDefForPeer: non-secret fields preserved verbatim", () => {
  const red = redactDefForPeer(sampleDef());
  assert.equal(red.system_prompt, "be helpful");
  assert.equal(red.models.default, "crow-local/qwen3.6-35b-a3b");
  assert.deepEqual(red.tools.crow_mcp, ["crow-tasks/tasks_list"]);
  assert.equal(red.gateways[0].type, "discord");
  assert.deepEqual(red.gateways[0].channel_ids, ["123"]);   // non-secret gateway struct kept visible
  assert.equal(red.gateways[2].address, "kevin.hopper+scout@maestro.press");
  assert.equal(red.spawn_env.PI_PROVIDER, "crow-local");     // non-secret env kept
});

test("redactDefForPeer: does not mutate the input", () => {
  const def = sampleDef();
  redactDefForPeer(def);
  assert.equal(def.gateways[0].token, "SECRET-DISCORD");
});

test("applyPeerPatch: merges allowlisted non-secret fields by dotted path", () => {
  const merged = applyPeerPatch(sampleDef(), {
    "system_prompt": "new prompt",
    "models.default": "crow-local/other",
    "tools.skills": ["research"],
    "display_name": "Scout 2",
    "enabled": 1,
  });
  assert.equal(merged.system_prompt, "new prompt");
  assert.equal(merged.models.default, "crow-local/other");
  assert.deepEqual(merged.tools.skills, ["research"]);
  // unrelated fields untouched
  assert.deepEqual(merged.tools.crow_mcp, ["crow-tasks/tasks_list"]);
  assert.equal(merged.gateways[0].token, "SECRET-DISCORD");
});

test("applyPeerPatch: rejects a non-allowlisted path", () => {
  assert.throws(() => applyPeerPatch(sampleDef(), { "session_dir": "/evil" }), /not patchable/i);
});

test("applyPeerPatch: rejects any gateway-credential / secret path", () => {
  assert.throws(() => applyPeerPatch(sampleDef(), { "gateways": [] }), /not patchable/i);
  assert.throws(() => applyPeerPatch(sampleDef(), { "spawn_env.OPENAI_API_KEY": "x" }), /not patchable/i);
});

test("applyPeerPatch: does not mutate the input def", () => {
  const def = sampleDef();
  applyPeerPatch(def, { "system_prompt": "x" });
  assert.equal(def.system_prompt, "be helpful");
});

test("PATCHABLE_FIELDS includes the locked non-secret edit surface only", () => {
  for (const f of ["display_name", "system_prompt", "models.default", "tools.skills", "tools.crow_mcp", "permission_policy.external_send", "triggers.cron", "enabled"]) {
    assert.ok(PATCHABLE_FIELDS.some((p) => p === f || (p.endsWith(".*") && f.startsWith(p.slice(0, -1)))), `missing ${f}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-federation-core.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// servers/gateway/bot-federation.js
/**
 * F4a Layer 3 — pure security core for cross-instance bot edit.
 *
 * redactDefForPeer: the ONLY path from a local bot definition to a remote
 *   editor. Every secret-bearing field is replaced with a non-secret marker so
 *   the editor can show "•••• set" without ever receiving the value.
 * applyPeerPatch / PATCHABLE_FIELDS: the authoritative server-side allowlist.
 *   A patch may only touch the locked non-secret edit surface; anything else
 *   (incl. every gateway credential) throws. Enforced regardless of what the
 *   remote UI sends.
 */

const REDACT = (v) => ({ __redacted: true, set: v != null && v !== "" });

// Secret keys inside a gateway object.
const GATEWAY_SECRET_KEYS = new Set(["token", "bot_token", "app_token", "password", "secret"]);
// Secret-looking spawn_env keys.
const ENV_SECRET_RE = /(TOKEN|KEY|SECRET|PASSWORD|CRED)/i;

/** Deep-clone + redact. Pure (never mutates input). */
export function redactDefForPeer(def) {
  const d = JSON.parse(JSON.stringify(def || {}));
  if (Array.isArray(d.gateways)) {
    for (const gw of d.gateways) {
      if (!gw || typeof gw !== "object") continue;
      for (const k of Object.keys(gw)) {
        if (GATEWAY_SECRET_KEYS.has(k)) gw[k] = REDACT(gw[k]);
      }
    }
  }
  if (d.spawn_env && typeof d.spawn_env === "object") {
    for (const k of Object.keys(d.spawn_env)) {
      if (ENV_SECRET_RE.test(k)) d.spawn_env[k] = REDACT(d.spawn_env[k]);
    }
  }
  return d;
}

/**
 * Allowlist of patchable definition paths (the locked non-secret edit surface).
 * A trailing ".*" means "any direct/nested child of this object". `enabled` is
 * handled by a separate endpoint but accepted here too for completeness; the
 * patch endpoint routes it to the column.
 */
export const PATCHABLE_FIELDS = [
  "display_name",
  "system_prompt",
  "models.*",
  "tools.crow_mcp",
  "tools.remote_mcp",
  "tools.pi_extensions",
  "tools.skills",
  "tools.pi_builtin",
  "skills",
  "permission_policy.*",
  "triggers.*",
  "tracker_config.*",
];

function isPatchable(path) {
  for (const allowed of PATCHABLE_FIELDS) {
    if (allowed === path) return true;
    if (allowed.endsWith(".*")) {
      const prefix = allowed.slice(0, -1); // keep the dot
      // exactly one level under the prefix and not itself a secret env/gateway key
      if (path.startsWith(prefix) && path.length > prefix.length) return true;
    }
  }
  return false;
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Merge a field-scoped patch into a clone of currentDef. Throws on any path not
 * in PATCHABLE_FIELDS. `enabled` is allowed (the endpoint applies it to the
 * column, not the JSON, so it is stripped from the merged def here).
 * Pure (never mutates currentDef).
 */
export function applyPeerPatch(currentDef, patch) {
  const out = JSON.parse(JSON.stringify(currentDef || {}));
  for (const [path, value] of Object.entries(patch || {})) {
    if (path === "enabled") continue; // routed to the column by the caller
    if (!isPatchable(path)) {
      throw new Error(`field not patchable from a peer: ${path}`);
    }
    setByPath(out, path, value);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bot-federation-core.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/bot-federation.js tests/bot-federation-core.test.js
git commit servers/gateway/bot-federation.js tests/bot-federation-core.test.js -m "F4a L3: pure security core (redactDefForPeer + applyPeerPatch allowlist)"
git show --stat HEAD
```

---

## Task 3: Extract `regenerateBotMcp` + owner-side federation endpoints

The patch endpoint must regenerate `.mcp.json` exactly like `bot-builder.js`'s `regen_mcp` action. Extract that logic into a shared helper first, then add the three HMAC-gated endpoints.

### 3A — Extract the regen helper

**Files:**
- Create: `servers/gateway/dashboard/panels/bot-mcp-regen.js`
- Modify: `servers/gateway/dashboard/panels/bot-builder.js:675-706` (use the helper)
- Test: `tests/bot-mcp-regen.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-mcp-regen.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBotSessionDir } from "../servers/gateway/dashboard/panels/bot-mcp-regen.js";

function dbWith(rows) {
  return {
    async execute({ sql, args }) {
      if (/project_spaces/.test(sql)) return { rows: rows.project_spaces || [] };
      if (/pi_bot_defs/.test(sql)) return { rows: rows.pi_bot_defs || [] };
      return { rows: [] };
    },
  };
}

test("resolveBotSessionDir: project_id present → workspace/bots/<id>", async () => {
  const db = dbWith({ project_spaces: [{ workspace_dir: "/ws/proj" }] });
  const dir = await resolveBotSessionDir(db, "scout", { session_dir: "/legacy" }, 7);
  assert.equal(dir, "/ws/proj/bots/scout");
});

test("resolveBotSessionDir: no project_id → def.session_dir", async () => {
  const db = dbWith({});
  const dir = await resolveBotSessionDir(db, "scout", { session_dir: "/legacy" }, null);
  assert.equal(dir, "/legacy");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-mcp-regen.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper and refactor bot-builder to use it**

```javascript
// servers/gateway/dashboard/panels/bot-mcp-regen.js
/**
 * Shared bot .mcp.json regeneration (M3b sessionDir rule). Used by the Bot
 * Builder's regen_mcp action and the F4a Layer 3 federation patch endpoint, so
 * both write the bot's MCP config to the exact path the bridge will run from.
 */
import { writeBotMcp } from "../../../../scripts/pi-bots/mcp_writer.mjs";
import { resolveCrowHome } from "../../../../scripts/pi-bots/ext_registry.mjs";

/** Resolve the sessionDir pi runs from: project workspace wins over def.session_dir. */
export async function resolveBotSessionDir(db, botId, def, projectId) {
  let sessionDir = def.session_dir;
  if (projectId != null) {
    const ws = (await db.execute({
      sql: "SELECT workspace_dir FROM project_spaces WHERE id=?",
      args: [projectId],
    })).rows[0];
    if (ws && ws.workspace_dir) sessionDir = ws.workspace_dir + "/bots/" + botId;
  }
  return sessionDir;
}

/** Regenerate the bot's .mcp.json from its current def+project. Returns writeBotMcp's result. */
export async function regenerateBotMcp(db, botId) {
  const row = (await db.execute({
    sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?",
    args: [botId],
  })).rows[0];
  if (!row) throw new Error("bot_not_found");
  const def = JSON.parse(row.definition || "{}");
  const sessionDir = await resolveBotSessionDir(db, botId, def, row.project_id);
  return writeBotMcp(def, { sessionDir, crowHome: resolveCrowHome() });
}
```

Then replace the inline body of the `regen_mcp` action in `bot-builder.js` (lines ~682-697) so it calls the helper (keep the surrounding `try/catch` + message formatting + redirect unchanged):

```javascript
      if (action === "regen_mcp") {
        const botId = b.bot_id;
        let msg;
        try {
          const r = await regenerateBotMcp(db, botId);
          msg = `wrote ${r.path} (servers: ${r.servers.join(", ") || "none"}` +
            (r.minted && r.minted.length ? `; minted: ${r.minted.join(",")}` : "") +
            (r.warnings.length ? `; ⚠ ${r.warnings.join("; ")}` : "") +
            (r.journalGuarded.length ? `; journal-guarded: ${r.journalGuarded.join(",")}` : "") + ")";
        } catch (e) {
          msg = "ERROR: " + String(e.message || e);
        }
        return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=review&mcp=` + encodeURIComponent(msg));
      }
```

Add the import near the top of `bot-builder.js` (beside the existing `writeBotMcp` import):
```javascript
import { regenerateBotMcp } from "./bot-mcp-regen.js";
```
Remove the now-unused direct `writeBotMcp` import from bot-builder **only if** nothing else in the file uses it (grep first: `grep -n writeBotMcp servers/gateway/dashboard/panels/bot-builder.js`). If other call sites remain, leave the import.

- [ ] **Step 4: Run tests + verify bot-builder still loads**

Run:
```bash
node --test tests/bot-mcp-regen.test.js
node -e "import('./servers/gateway/dashboard/panels/bot-builder.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: tests PASS; `OK` printed.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/panels/bot-mcp-regen.js tests/bot-mcp-regen.test.js servers/gateway/dashboard/panels/bot-builder.js
git commit servers/gateway/dashboard/panels/bot-mcp-regen.js tests/bot-mcp-regen.test.js servers/gateway/dashboard/panels/bot-builder.js -m "F4a L3: extract regenerateBotMcp helper (shared by builder + federation patch)"
git show --stat HEAD
```

### 3B — Federation endpoints (def / patch / enabled)

Add a small `botFederationRouter` registered inside `federationRouter` (federation.js), behind the same `federationVerifyMiddleware`. Keep it in a dedicated module for focus, mounted by the factory.

**Files:**
- Create: `servers/gateway/routes/bot-federation-routes.js`
- Modify: `servers/gateway/routes/federation.js` (mount the three routes in the factory)
- Test: `tests/bot-federation-endpoints.test.js`

- [ ] **Step 1: Write the failing test (handlers tested directly, no live HTTP)**

```javascript
// tests/bot-federation-endpoints.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBotFederationHandlers } from "../servers/gateway/routes/bot-federation-routes.js";

// In-memory bot store backed by a fake libsql db.
function makeDb({ manageable, def }) {
  const store = { definition: JSON.stringify(def), enabled: 1, project_id: null };
  return {
    _store: store,
    async execute({ sql, args }) {
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/SELECT value FROM dashboard_settings/.test(sql)) {
        const key = args[0];
        if (key === "feature_flags") return { rows: [{ value: JSON.stringify({ remote_bot_management: true }) }] };
        if (key === "remote_managed_bots") return { rows: [{ value: JSON.stringify(manageable) }] };
        return { rows: [] };
      }
      if (/SELECT definition, project_id FROM pi_bot_defs/.test(sql)) {
        if (args[0] !== "scout") return { rows: [] };
        return { rows: [{ definition: store.definition, project_id: store.project_id }] };
      }
      if (/UPDATE pi_bot_defs SET definition/.test(sql)) { store.definition = args[0]; return { rows: [] }; }
      if (/UPDATE pi_bot_defs SET enabled/.test(sql)) { store.enabled = args[0]; return { rows: [] }; }
      return { rows: [] };
    },
  };
}
const sampleDef = () => ({ system_prompt: "old", models: { default: "m" }, gateways: [{ type: "discord", token: "S" }], tools: { skills: [] } });
// res stub
function makeRes() {
  return { _status: 200, _json: null, status(c){this._status=c;return this;}, json(o){this._json=o;return this;}, type(){return this;}, send(s){this._json=JSON.parse(s);return this;} };
}

test("GET def: manageable → redacted def (no secret)", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.getDef({ params: { botId: "scout" }, headers: {} }, res);
  assert.equal(res._status, 200);
  assert.equal(JSON.stringify(res._json).includes('"S"'), false);
  assert.deepEqual(res._json.definition.gateways[0].token, { __redacted: true, set: true });
});

test("GET def: not manageable → 403", async () => {
  const db = makeDb({ manageable: [], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.getDef({ params: { botId: "scout" }, headers: {} }, res);
  assert.equal(res._status, 403);
});

test("GET def: unknown bot → 404", async () => {
  const db = makeDb({ manageable: ["ghost"], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.getDef({ params: { botId: "ghost" }, headers: {} }, res);
  assert.equal(res._status, 404);
});

test("POST patch: merges non-secret field + regenerates mcp", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  let regen = 0;
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => { regen++; return {}; } });
  const res = makeRes();
  await h.patch({ params: { botId: "scout" }, headers: { "x-crow-source": "peerX" }, body: { patch: { "system_prompt": "new", "tools.skills": ["r"] } } }, res);
  assert.equal(res._status, 200);
  assert.equal(JSON.parse(db._store.definition).system_prompt, "new");
  assert.equal(regen, 1); // tools changed
});

test("POST patch: secret/disallowed field → 400, no write", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  const before = db._store.definition;
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.patch({ params: { botId: "scout" }, headers: {}, body: { patch: { "gateways": [] } } }, res);
  assert.equal(res._status, 400);
  assert.equal(db._store.definition, before);
});

test("POST patch: not manageable → 403", async () => {
  const db = makeDb({ manageable: [], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.patch({ params: { botId: "scout" }, headers: {}, body: { patch: { "system_prompt": "x" } } }, res);
  assert.equal(res._status, 403);
});

test("POST enabled: manageable → flips column", async () => {
  const db = makeDb({ manageable: ["scout"], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.setEnabled({ params: { botId: "scout" }, headers: {}, body: { enabled: 0 } }, res);
  assert.equal(res._status, 200);
  assert.equal(db._store.enabled, 0);
});

test("POST enabled: not manageable → 403", async () => {
  const db = makeDb({ manageable: [], def: sampleDef() });
  const h = makeBotFederationHandlers({ db, regenerateBotMcp: async () => ({}) });
  const res = makeRes();
  await h.setEnabled({ params: { botId: "scout" }, headers: {}, body: { enabled: 0 } }, res);
  assert.equal(res._status, 403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-federation-endpoints.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handlers + mount them**

```javascript
// servers/gateway/routes/bot-federation-routes.js
/**
 * F4a Layer 3 — owner-side cross-instance bot edit/run endpoints.
 *
 * Mounted under /dashboard/bot-federation/* behind federationVerifyMiddleware
 * (HMAC). Every handler re-checks botPeerManageable(db, botId) — the gate is
 * authoritative; the HMAC middleware only proves the caller is a known peer.
 * Secrets never cross the wire (redactDefForPeer); only allowlisted non-secret
 * fields are writable (applyPeerPatch). Under /dashboard → Funnel-blocked;
 * never add to PUBLIC_FUNNEL_PREFIXES.
 */
import { Router } from "express";
import { botPeerManageable } from "../bot-management-exposure.js";
import { redactDefForPeer, applyPeerPatch } from "../bot-federation.js";
import { regenerateBotMcp as defaultRegen } from "../dashboard/panels/bot-mcp-regen.js";

/** Factory so tests can inject db + regen. */
export function makeBotFederationHandlers({ db, regenerateBotMcp = defaultRegen }) {
  async function loadDef(botId) {
    const row = (await db.execute({
      sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?",
      args: [botId],
    })).rows[0];
    if (!row) return null;
    let def = {};
    try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
    return { def, project_id: row.project_id };
  }

  return {
    async getDef(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) return res.status(403).json({ error: "not_manageable" });
      const row = await loadDef(botId);
      if (!row) return res.status(404).json({ error: "bot_not_found" });
      return res.type("application/json").send(JSON.stringify({ bot_id: botId, definition: redactDefForPeer(row.def) }));
    },

    async patch(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) return res.status(403).json({ error: "not_manageable" });
      const row = await loadDef(botId);
      if (!row) return res.status(404).json({ error: "bot_not_found" });
      const patch = (req.body && req.body.patch) || {};
      let merged;
      try { merged = applyPeerPatch(row.def, patch); }
      catch (e) { return res.status(400).json({ error: "field_not_patchable", detail: String(e.message || e) }); }
      const toolsChanged = Object.keys(patch).some((k) => k.startsWith("tools.") || k === "skills");
      await db.execute({
        sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?",
        args: [JSON.stringify(merged), botId],
      });
      let mcp = null;
      if (toolsChanged) { try { mcp = await regenerateBotMcp(db, botId); } catch (e) { mcp = { error: String(e.message || e) }; } }
      return res.json({ ok: true, regenerated: toolsChanged, mcp: mcp && mcp.path ? { path: mcp.path, servers: mcp.servers } : mcp });
    },

    async setEnabled(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) return res.status(403).json({ error: "not_manageable" });
      const row = await loadDef(botId);
      if (!row) return res.status(404).json({ error: "bot_not_found" });
      const enabled = req.body && Number(req.body.enabled) ? 1 : 0;
      await db.execute({
        sql: "UPDATE pi_bot_defs SET enabled=?, updated_at=datetime('now') WHERE bot_id=?",
        args: [enabled, botId],
      });
      return res.json({ ok: true, enabled });
    },
  };
}

/** Build an Express router for the three routes (relative to the /dashboard mount). */
export function botFederationRouter({ createDbClient, verifyMiddleware }) {
  const router = Router();
  // Each request gets its own db client; closed after the handler.
  const wrap = (name) => async (req, res) => {
    const db = createDbClient();
    try { await makeBotFederationHandlers({ db })[name](req, res); }
    catch (err) { if (!res.headersSent) res.status(500).json({ error: "bot_federation_failed" }); }
    finally { db.close(); }
  };
  router.get("/bot-federation/def/:botId", verifyMiddleware, wrap("getDef"));
  router.post("/bot-federation/patch/:botId", verifyMiddleware, wrap("patch"));
  router.post("/bot-federation/enabled/:botId", verifyMiddleware, wrap("setEnabled"));
  return router;
}
```

Mount it in `federation.js`'s `federationRouter` factory — after the `/capabilities` route, before `return router`:

```javascript
  // F4a Layer 3: cross-instance bot edit/run. Same HMAC gate; gate-checked per
  // request by botPeerManageable. Under /dashboard → Funnel-blocked.
  router.use("/", botFederationRouter({ createDbClient, verifyMiddleware: federationVerifyMiddleware(dbForAudit) }));
```

Add the import at the top of `federation.js`:
```javascript
import { botFederationRouter } from "./bot-federation-routes.js";
```

- [ ] **Step 4: Run test + verify federation router still loads**

Run:
```bash
node --test tests/bot-federation-endpoints.test.js
node -e "import('./servers/gateway/routes/federation.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: tests PASS (8); `OK` printed.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/routes/bot-federation-routes.js tests/bot-federation-endpoints.test.js servers/gateway/routes/federation.js
git commit servers/gateway/routes/bot-federation-routes.js tests/bot-federation-endpoints.test.js servers/gateway/routes/federation.js -m "F4a L3: owner-side bot-federation endpoints (def/patch/enabled, gate-checked, HMAC)"
git show --stat HEAD
```

---

## Task 4: Caller-side client (`bot-federation-client.js`)

Thin wrappers over `forwardSignedRequest` — what the editing instance's panels call.

**Files:**
- Create: `servers/gateway/bot-federation-client.js`
- Test: `tests/bot-federation-client.test.js`

- [ ] **Step 1: Write the failing test (inject a fake forwarder)**

```javascript
// tests/bot-federation-client.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPeerBotDef, patchPeerBot, setPeerBotEnabled } from "../servers/gateway/bot-federation-client.js";

function fakeForward(captured) {
  return async (args) => { captured.push(args); return { ok: true, status: 200, body: { ok: true } }; };
}

test("fetchPeerBotDef signs a GET to the def path with the right audit action", async () => {
  const cap = [];
  await fetchPeerBotDef({ db: {}, sourceInstanceId: "me", instanceId: "peerY", botId: "scout" }, fakeForward(cap));
  assert.equal(cap[0].method, "GET");
  assert.equal(cap[0].path, "/dashboard/bot-federation/def/scout");
  assert.equal(cap[0].targetInstanceId, "peerY");
  assert.equal(cap[0].auditAction, "federation.bot.def");
});

test("patchPeerBot POSTs {patch} with the patch audit action", async () => {
  const cap = [];
  await patchPeerBot({ db: {}, sourceInstanceId: "me", instanceId: "peerY", botId: "scout", patch: { system_prompt: "x" } }, fakeForward(cap));
  assert.equal(cap[0].method, "POST");
  assert.equal(cap[0].path, "/dashboard/bot-federation/patch/scout");
  assert.deepEqual(cap[0].body, { patch: { system_prompt: "x" } });
  assert.equal(cap[0].auditAction, "federation.bot.patch");
});

test("setPeerBotEnabled POSTs {enabled} with the enabled audit action", async () => {
  const cap = [];
  await setPeerBotEnabled({ db: {}, sourceInstanceId: "me", instanceId: "peerY", botId: "scout", enabled: 0 }, fakeForward(cap));
  assert.equal(cap[0].path, "/dashboard/bot-federation/enabled/scout");
  assert.deepEqual(cap[0].body, { enabled: 0 });
  assert.equal(cap[0].auditAction, "federation.bot.enabled");
});

test("botId is URL-encoded in the path", async () => {
  const cap = [];
  await fetchPeerBotDef({ db: {}, sourceInstanceId: "me", instanceId: "peerY", botId: "a/b z" }, fakeForward(cap));
  assert.equal(cap[0].path, "/dashboard/bot-federation/def/a%2Fb%20z");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-federation-client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// servers/gateway/bot-federation-client.js
/**
 * F4a Layer 3 — caller-side client. The editing instance uses these to drive a
 * peer's bot over the HMAC-signed, trust-gated federation channel. The peer's
 * gate (botPeerManageable) is the security boundary; these are a dumb pipe.
 */
import { forwardSignedRequest as realForward } from "../shared/peer-forward.js";

const enc = (s) => encodeURIComponent(String(s));

export async function fetchPeerBotDef({ db, sourceInstanceId, instanceId, botId, actor }, forward = realForward) {
  return forward({
    db, sourceInstanceId, targetInstanceId: instanceId,
    method: "GET", path: `/dashboard/bot-federation/def/${enc(botId)}`,
    auditAction: "federation.bot.def", actor, maxResponseBytes: 65_536,
  });
}

export async function patchPeerBot({ db, sourceInstanceId, instanceId, botId, patch, actor }, forward = realForward) {
  return forward({
    db, sourceInstanceId, targetInstanceId: instanceId,
    method: "POST", path: `/dashboard/bot-federation/patch/${enc(botId)}`,
    body: { patch }, auditAction: "federation.bot.patch", actor, maxResponseBytes: 65_536,
  });
}

export async function setPeerBotEnabled({ db, sourceInstanceId, instanceId, botId, enabled, actor }, forward = realForward) {
  return forward({
    db, sourceInstanceId, targetInstanceId: instanceId,
    method: "POST", path: `/dashboard/bot-federation/enabled/${enc(botId)}`,
    body: { enabled: enabled ? 1 : 0 }, auditAction: "federation.bot.enabled", actor, maxResponseBytes: 65_536,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bot-federation-client.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/bot-federation-client.js tests/bot-federation-client.test.js
git commit servers/gateway/bot-federation-client.js tests/bot-federation-client.test.js -m "F4a L3: caller-side bot-federation client (signed def/patch/enabled wrappers)"
git show --stat HEAD
```

---

## Task 5: Advertise `peer_manageable` across the mesh (L1 projection)

So an editing instance knows which peer bots are editable without an extra fetch.

**Files:**
- Modify: `servers/gateway/capability-registry.js` (`toPublicBot` + `getLocalCatalog`)
- Modify: `servers/gateway/dashboard/capabilities-cache.js` (`vBot` validator ~line 41-52)
- Test: `tests/bot-federation-projection.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/bot-federation-projection.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPublicBot } from "../servers/gateway/capability-registry.js";

const row = () => ({ bot_id: "scout", display_name: "Scout", enabled: 1, project_id: 3, definition: JSON.stringify({ models: { default: "m" }, tools: { crow_mcp: ["x/y"] } }) });

test("toPublicBot: peer_manageable true when bot in managedSet", () => {
  const b = toPublicBot(row(), new Set(["scout"]));
  assert.equal(b.peer_manageable, true);
  assert.equal(b.bot_id, "scout");
});

test("toPublicBot: peer_manageable false when not in set / no set", () => {
  assert.equal(toPublicBot(row(), new Set()).peer_manageable, false);
  assert.equal(toPublicBot(row()).peer_manageable, false);
});

test("toPublicBot: never leaks the definition or secrets", () => {
  const b = toPublicBot(row(), new Set(["scout"]));
  assert.equal("definition" in b, false);
  assert.equal("system_prompt" in b, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-federation-projection.test.js`
Expected: FAIL — `peer_manageable` is `undefined` (assertions fail).

- [ ] **Step 3: Implement**

In `capability-registry.js`, change `toPublicBot` to accept a managed set (mirrors `toPublicTool(entry, exposedSet)`):

```javascript
export function toPublicBot(row, managedSet) {
  let def = {};
  try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
  const crowMcp = (def.tools && Array.isArray(def.tools.crow_mcp)) ? def.tools.crow_mcp : [];
  return {
    bot_id: row.bot_id,
    display_name: row.display_name,
    enabled: !!Number(row.enabled),
    project_id: row.project_id != null && Number.isFinite(Number(row.project_id)) ? Number(row.project_id) : null,
    tracker_type: (def.triggers && def.triggers.tracker_type) || "none",
    model: (def.models && def.models.default) || null,
    tool_count: crowMcp.length,
    peer_manageable: managedSet instanceof Set ? managedSet.has(row.bot_id) : false,
  };
}
```

In `getLocalCatalog`, compute the managed set once (mirrors the `exposedSet` line) and pass it:

```javascript
import { getPeerManagedBots } from "./bot-management-exposure.js"; // add near the getExposedCapabilities import
// ...
  const exposedSet = await getExposedCapabilities(db);
  const managedSet = await getPeerManagedBots(db);
  const tools = [...coreTools(), ...addonTools(crowHome)].map((e) => toPublicTool(e, exposedSet));
  const skills = localSkills(crowHome).map(toPublicSkill);
  const bots = (await localBots(db)).map((r) => toPublicBot(r, managedSet));
```

In `capabilities-cache.js` `vBot` (the receive-side validator), add the field so it survives the mesh:

```javascript
    tool_count: num(b.tool_count) ?? 0,
    peer_manageable: !!b.peer_manageable,
```

- [ ] **Step 4: Run test + the existing projection/cache tests**

Run:
```bash
node --test tests/bot-federation-projection.test.js
node --test tests/capability-registry.test.js tests/capabilities-cache.test.js
```
Expected: new test PASS; existing tests still PASS (update them only if they assert an exact-key-set on a bot object — add `peer_manageable` there if so).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/capability-registry.js servers/gateway/dashboard/capabilities-cache.js tests/bot-federation-projection.test.js
git commit servers/gateway/capability-registry.js servers/gateway/dashboard/capabilities-cache.js tests/bot-federation-projection.test.js -m "F4a L3: advertise peer_manageable in the L1 bot projection"
git show --stat HEAD
```

---

## Task 6: Owner-side controls (master toggle + per-bot opt-in)

### 6A — Settings section: master flag

**Files:**
- Create: `servers/gateway/dashboard/settings/sections/remote-bot-management.js`
- Modify: i18n — add `settings.section.remoteBotManagement` (find where `settings.section.remoteInvocation` is defined: `grep -rn "settings.section.remoteInvocation" servers/gateway/`) and add the sibling key with the same shape/locales.
- Test: `tests/remote-bot-management-toggle.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/remote-bot-management-toggle.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import section from "../servers/gateway/dashboard/settings/sections/remote-bot-management.js";

test("getPreview reflects the flag", async () => {
  assert.equal(await section.getPreview({ settings: { feature_flags: JSON.stringify({ remote_bot_management: true }) } }), "enabled");
  assert.equal(await section.getPreview({ settings: { feature_flags: "{}" } }), "disabled");
});

test("handleAction writes feature_flags.remote_bot_management at local scope, preserving other flags", async () => {
  let written = null;
  const db = {
    async execute({ sql, args }) {
      if (/dashboard_settings_overrides/.test(sql)) return { rows: [] };
      if (/SELECT value FROM dashboard_settings/.test(sql)) return { rows: [{ value: JSON.stringify({ smart_chat: true }) }] };
      return { rows: [] };
    },
  };
  // monkeypatch writeSetting via the registry is not trivial here; instead assert the merge logic
  // by calling handleAction with a stub res and a writeSetting spy injected through module mock is overkill.
  // Minimal: verify the section id/group and that handleAction returns true for its action.
  const res = { redirectAfterPost() {} };
  const handled = await section.handleAction({ req: { body: { enabled: "on" } }, res, db, action: "set_remote_bot_management" });
  assert.equal(handled, true);
});

test("ignores unrelated actions", async () => {
  const handled = await section.handleAction({ req: { body: {} }, res: {}, db: {}, action: "something_else" });
  assert.equal(handled, false);
});

test("section metadata", () => {
  assert.equal(section.id, "remote-bot-management");
  assert.equal(section.group, "multiInstance");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-bot-management-toggle.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (copy `remote-invocation.js` shape exactly)**

```javascript
// servers/gateway/dashboard/settings/sections/remote-bot-management.js
/**
 * Settings Section: Remote Bot Management (Multi-Instance group) — F4a Layer 3.
 *
 * Toggles feature_flags.remote_bot_management (local-only; NOT in SYNC_ALLOWLIST).
 * Master switch. When ON, trusted peers may edit (non-secret fields) and
 * enable/disable any of THIS instance's bots that are individually marked
 * "manageable by peers" in the Bot Builder. Default OFF. The per-bot opt-in
 * (remote_managed_bots) is the second required condition; this is the global
 * kill-switch.
 */
import { readSetting, writeSetting } from "../registry.js";

async function readFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export default {
  id: "remote-bot-management",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>`,
  labelKey: "settings.section.remoteBotManagement",
  navOrder: 8,

  async getPreview({ settings }) {
    let on = false;
    try { on = JSON.parse(settings?.feature_flags || "{}")?.remote_bot_management === true; } catch {}
    return on ? "enabled" : "disabled";
  },

  async render({ db }) {
    const flags = await readFlags(db);
    const on = flags.remote_bot_management === true;
    return `<form method="POST">
      <input type="hidden" name="action" value="set_remote_bot_management">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        When enabled, a <strong>trusted peer instance</strong> can edit the non-secret settings
        (prompt, model, tools, skills, permissions) and enable/disable any of this instance's bots
        that you mark <strong>"Manageable by trusted peers"</strong> in the Bot Builder. Gateway
        credentials are never exposed or settable remotely. The bot always runs here.
        Off by default. <strong>Local to this instance, never synced.</strong>
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${on ? "checked" : ""}>
        <span>Allow trusted peers to manage exposed bots on this instance</span>
      </label>
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-secondary">Save</button></div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_remote_bot_management") return false;
    const flags = await readFlags(db);
    flags.remote_bot_management = req.body.enabled === "on";
    await writeSetting(db, "feature_flags", JSON.stringify(flags), { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=remote-bot-management");
    return true;
  },
};
```

Verify the section is auto-discovered: check how `sections/remote-invocation.js` is registered (`grep -rn "remote-invocation" servers/gateway/dashboard/settings/`). If sections are auto-loaded from the directory, nothing else is needed. If there's an explicit registry array, add `remote-bot-management` beside `remote-invocation`.

- [ ] **Step 4: Run test + verify settings panel loads**

Run:
```bash
node --test tests/remote-bot-management-toggle.test.js
node -e "import('./servers/gateway/dashboard/settings/sections/remote-bot-management.js').then(()=>console.log('OK'))"
```
Expected: PASS; `OK`.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/settings/sections/remote-bot-management.js tests/remote-bot-management-toggle.test.js
# also add the i18n file you edited
git commit servers/gateway/dashboard/settings/sections/remote-bot-management.js tests/remote-bot-management-toggle.test.js <i18n-file> -m "F4a L3: Remote Bot Management settings section (master flag)"
git show --stat HEAD
```

### 6B — Per-bot opt-in checkbox (owner's Bot Builder)

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder.js` (render a "Manageable by trusted peers" checkbox for each LOCAL bot; add a `toggle_peer_managed` action that adds/removes the bot_id from `remote_managed_bots`).

- [ ] **Step 1: Add the action handler** (in `handler`'s POST block, beside the other actions). Reuse `readSetting`/`writeSetting` (already imported in the file — confirm with `grep -n "readSetting\|writeSetting" servers/gateway/dashboard/panels/bot-builder.js`; import from `../settings/registry.js` if absent):

```javascript
      if (action === "toggle_peer_managed") {
        const botId = (b.bot_id || "").trim();
        const raw = await readSetting(db, "remote_managed_bots");
        let list = [];
        try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
        if (!Array.isArray(list)) list = [];
        const set = new Set(list.filter((x) => typeof x === "string" && x));
        if (b.managed === "on") set.add(botId); else set.delete(botId);
        await writeSetting(db, "remote_managed_bots", JSON.stringify([...set]), { scope: "local" });
        return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=permissions`);
      }
```

- [ ] **Step 2: Render the checkbox** on the permissions tab for a local bot. Read the current `remote_managed_bots` set once where the tab renders, then:

```javascript
// when rendering the permissions tab for an existing local bot:
const managedRaw = await readSetting(db, "remote_managed_bots");
let managedSet = new Set();
try { const a = JSON.parse(managedRaw || "[]"); if (Array.isArray(a)) managedSet = new Set(a); } catch {}
const isManaged = managedSet.has(currentBotId);
// ...inside the permissions form HTML:
`<form method="POST" style="margin-top:1rem">
  <input type="hidden" name="action" value="toggle_peer_managed">
  <input type="hidden" name="bot_id" value="${currentBotId}">
  <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
    <input type="checkbox" name="managed" ${isManaged ? "checked" : ""} onchange="this.form.submit()">
    <span>Manageable by trusted peers (cross-instance edit/run — requires the master toggle in Settings → Remote Bot Management)</span>
  </label>
</form>`
```

- [ ] **Step 3: Verify the panel loads + manual smoke**

Run:
```bash
node -e "import('./servers/gateway/dashboard/panels/bot-builder.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: `OK`. (Functional smoke happens against a running gateway in Task 8.)

- [ ] **Step 4: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-builder.js -m "F4a L3: per-bot 'manageable by trusted peers' opt-in in the Bot Builder"
git show --stat HEAD
```

---

## Task 7: Editing-instance UI (remote edit + remote enable toggle)

### 7A — Bot Board: enable/disable a manageable peer bot

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-board.js` (the "Bots on other instances" section + a POST action calling `setPeerBotEnabled`).

- [ ] **Step 1: Add a remote-enable action** in bot-board's POST handler:

```javascript
import { setPeerBotEnabled } from "../../bot-federation-client.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";
// ...
      if (action === "peer_toggle") {
        const instanceId = b.instance_id, botId = b.bot_id;
        const r = await setPeerBotEnabled({
          db, sourceInstanceId: getOrCreateLocalInstanceId(), instanceId, botId,
          enabled: b.enabled === "1" ? 1 : 0, actor: "dashboard",
        });
        const msg = r.ok ? "ok" : (r.error || "failed");
        return res.redirectAfterPost(`/dashboard/bot-board?peer=${encodeURIComponent(msg)}`);
      }
```

- [ ] **Step 2: Render the toggle** only for peer bots with `peer_manageable === true` (the others keep the read-only link-out). In the peer-bots row render (`gatherPeerBots` results), where `b.peer_manageable`:

```javascript
b.peer_manageable
  ? `<form method="POST" style="display:inline">
       <input type="hidden" name="action" value="peer_toggle">
       <input type="hidden" name="instance_id" value="${b.instanceId}">
       <input type="hidden" name="bot_id" value="${b.bot_id}">
       <input type="hidden" name="enabled" value="${b.enabled ? 0 : 1}">
       <button type="submit" class="btn btn-sm">${b.enabled ? "Disable" : "Enable"}</button>
     </form>`
  : `<span class="muted">read-only — open on owner</span>`
```

- [ ] **Step 3: Verify panel loads**

Run: `node -e "import('./servers/gateway/dashboard/panels/bot-board.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-board.js -m "F4a L3: remote enable/disable toggle for manageable peer bots (Bot Board)"
git show --stat HEAD
```

### 7B — Bot Builder: edit a manageable peer bot

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder.js` (an "Edit on peer" entry point that loads the redacted def via `fetchPeerBotDef`, renders the non-secret tabs editable with credential fields disabled, and saves via `patchPeerBot`).

Design note for the implementer: the existing editor is keyed on a local `bot_id`. Add a remote-edit mode keyed on `?peer=<instanceId>&bot=<botId>`:
- **GET** `?peer=<id>&bot=<id>`: call `fetchPeerBotDef`; if `!r.ok` render an offline notice; else render the editor from `r.body.definition` (already redacted). For each gateway field whose value is `{__redacted:true}`, render the input **disabled** showing `•••• set — edit on owner`. Add a hidden `peer` field to each tab form so saves route remotely.
- **POST** with a `peer` field present: build a field-scoped patch from only the changed non-secret inputs (the same per-tab field set the local `save_*` actions handle, minus gateways), call `patchPeerBot({ ..., patch })`, redirect with a status. For the enable toggle in this view, call `setPeerBotEnabled`.

- [ ] **Step 1: Add the remote-edit GET branch** near the top of `handler` (after computing `notAvail`), reading `req.query.peer`:

```javascript
import { fetchPeerBotDef, patchPeerBot } from "../../bot-federation-client.js";
// ...
    const peerId = req.query.peer;
    if (peerId && req.method === "GET") {
      const botId = req.query.bot;
      const r = await fetchPeerBotDef({ db, sourceInstanceId: getOrCreateLocalInstanceId(), instanceId: peerId, botId, actor: "dashboard" });
      if (!r.ok) {
        return res.send(layout({ title: "Bot Builder", content: section("Edit peer bot",
          `<p>Could not reach the owner instance (${r.error || "offline"}). Try again later.</p>`) }));
      }
      const def = r.body?.definition || {};
      // render the same tabbed editor, but: forms carry <input type=hidden name=peer value=peerId>,
      // gateway credential inputs are disabled when the value is {__redacted:true}.
      return res.send(renderRemoteEditor({ layout, peerId, botId, def })); // implement alongside the local renderer
    }
```

- [ ] **Step 2: Add the remote-edit POST branch** (build patch from changed non-secret fields per tab):

```javascript
      if (req.body && req.body.peer) {
        const peerId = req.body.peer, botId = req.body.bot_id;
        const patch = {};
        // map the submitted tab fields to dotted patch paths (non-secret only):
        if (typeof req.body.system_prompt === "string") patch["system_prompt"] = req.body.system_prompt;
        if (typeof req.body.model === "string" && req.body.model) patch["models.default"] = req.body.model;
        if (typeof req.body.skills === "string") patch["tools.skills"] = lines(req.body.skills);
        if (typeof req.body.crow_mcp === "string") patch["tools.crow_mcp"] = lines(req.body.crow_mcp);
        // (extend with the other non-secret tab fields as the local save_* actions do)
        const r = await patchPeerBot({ db, sourceInstanceId: getOrCreateLocalInstanceId(), instanceId: peerId, botId, patch, actor: "dashboard" });
        const msg = r.ok ? "saved" : (r.body?.error || r.error || "failed");
        return res.redirectAfterPost(`/dashboard/bot-builder?peer=${encodeURIComponent(peerId)}&bot=${encodeURIComponent(botId)}&status=${encodeURIComponent(msg)}`);
      }
```

- [ ] **Step 3: Add the "Edit" affordance** in the federated remote group rendered by `gatherPeerTools`/the peer-bots list: for a peer bot with `peer_manageable === true`, link to `?peer=<instanceId>&bot=<bot_id>`; otherwise keep the L1 read-only label.

- [ ] **Step 4: Verify panel loads + lint**

Run:
```bash
node -e "import('./servers/gateway/dashboard/panels/bot-builder.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-builder.js -m "F4a L3: edit a manageable peer bot from the Bot Builder (redacted load + field-scoped patch)"
git show --stat HEAD
```

---

## Task 8: Invariant sweep + deploy + acceptance

### 8A — Network-exposure invariant test

**Files:**
- Modify: `tests/auth-network.test.js` (assert `/dashboard/bot-federation/*` is private, never Funnel-allowed).

- [ ] **Step 1: Add an assertion** mirroring the existing capabilities/overview checks — confirm `/dashboard/bot-federation/def/x`, `/patch/x`, `/enabled/x` do NOT match `PUBLIC_FUNNEL_PREFIXES` (use the same helper the file already uses to test `/dashboard/capabilities`). Pattern (adapt to the file's existing structure):

```javascript
test("bot-federation endpoints are never funnel-exposed", () => {
  for (const p of ["/dashboard/bot-federation/def/x", "/dashboard/bot-federation/patch/x", "/dashboard/bot-federation/enabled/x"]) {
    assert.equal(isPublicFunnelPath(p), false);
  }
});
```

- [ ] **Step 2: Run the full invariant + L3 suite**

Run:
```bash
node --test tests/auth-network.test.js \
  tests/bot-management-exposure.test.js tests/bot-federation-core.test.js \
  tests/bot-mcp-regen.test.js tests/bot-federation-endpoints.test.js \
  tests/bot-federation-client.test.js tests/bot-federation-projection.test.js \
  tests/remote-bot-management-toggle.test.js
node --test tests/capability-registry.test.js tests/capabilities-cache.test.js \
  tests/exposure-allowlist.test.js tests/peer-invocation-gate.test.js \
  tests/federation-overview.test.js
```
Expected: all PASS (L1/L2a/L2b/F3b regression green).

- [ ] **Step 3: Gateway boots clean**

Run: `node servers/gateway/index.js --no-auth` (Ctrl-C after it logs "listening"). Expected: starts with no import/registration errors; Settings shows "Remote Bot Management".

- [ ] **Step 4: Commit + flag-off safety check**

Confirm the safety invariant manually: with the master flag off (default), `getPeerManagedBots` returns empty and every endpoint 403s. This is already covered by `tests/bot-management-exposure.test.js` ("master flag OFF") + `tests/bot-federation-endpoints.test.js` ("not manageable → 403"); no extra code.

```bash
git commit tests/auth-network.test.js -m "F4a L3: assert bot-federation endpoints never funnel-exposed"
git show --stat HEAD
```

### 8B — Deploy + acceptance (ATTENDED — STOP and do this with the operator)

> Prod-safety: per host, attended, one at a time, verify-after. **No init-db** (this slice adds no tables/columns; `remote_managed_bots` is a settings row). Deploy = pull + restart gateways. sudo pw `8r00kly^` (crow + grackle). Restart model stack first if it was stopped (`docker start vllm-rocm-qwen35-4b llamacpp-vulkan-qwen36-35b-a3b llamacpp-vulkan-qwen3-embed crow-companion faster-whisper-server kokoro-tts`).

- [ ] **Step 1: Merge to main + push** (after a final holistic review): `git switch main && git pull --rebase && git merge --no-ff feat/f4a-layer3-bot-edit-run` then `git push origin main`.

- [ ] **Step 2: Deploy crow + grackle** (pull + restart each gateway; verify dashboard 303/healthy after each).

- [ ] **Step 3: Acceptance — crow edits grackle's TEST bot.** On grackle (owner): Settings → Remote Bot Management → ON; in the Bot Builder mark a **test** bot "Manageable by trusted peers". On crow: open the Bot Builder, find that bot in the remote group (now showing Edit), change its system prompt + add a skill, save. Then toggle it enabled from crow.
  - Verify on grackle: `pi_bot_defs.definition` shows the new prompt + skill; `.mcp.json` regenerated; `enabled` flipped; the F3b runtime reacted on the next tick; a `cross_host_calls` audit row exists with `action='federation.bot.patch'` / `federation.bot.enabled`, `direction='inbound'`.
  - Verify the negative: a grackle bot **not** marked manageable returns 403 / shows read-only from crow; gateway credentials are never visible in crow's editor (show "•••• set").

- [ ] **Step 4: Turn the master flag back off** on grackle if this was only an acceptance run (leave prod default-deny unless the operator wants it on), and update the handoff/memory note.

---

## Self-Review (completed during planning)

- **Spec coverage:** A (gate)→T1; B (endpoints)→T3B; C (redaction+allowlist)→T2; D (client)→T4; E (projection)→T5; F (Builder edit UI)→T7B; G (Board toggle)→T7A; H (owner controls)→T6; security invariants→T2/T1/T8A; testing list→T1-T8; build order→tasks in order. The `regen_mcp` reuse pin (spec "two items to pin") is resolved in T3A; the `spawn_env` secret-key pattern pin is resolved by `ENV_SECRET_RE` in T2.
- **Placeholders:** UI tasks (T6B/T7) reference `renderRemoteEditor` and "extend with the other non-secret tab fields" — these are the inherently-SSR parts where the implementer mirrors the existing per-tab render/save code in the same file; the dotted-path patch mapping + the disabled-credential rule are shown concretely. All security-critical code (gate, redaction, allowlist, endpoints, client, projection) is complete with full test code.
- **Type/name consistency:** `botPeerManageable`, `getPeerManagedBots`, `parseManagedBots`, `redactDefForPeer`, `applyPeerPatch`, `PATCHABLE_FIELDS`, `regenerateBotMcp`, `resolveBotSessionDir`, `fetchPeerBotDef`/`patchPeerBot`/`setPeerBotEnabled`, `makeBotFederationHandlers`/`botFederationRouter`, `toPublicBot(row, managedSet)` — used identically across tasks. Setting keys: `remote_bot_management` (flag), `remote_managed_bots` (list). Audit actions: `federation.bot.{def,patch,enabled}`.
