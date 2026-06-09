# F3b — Distribute the Bot Builder Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **RESOURCE NOTE:** crow runs a heavy always-on LLM stack. Execute single-threaded — ONE implementer subagent at a time, NO concurrent fan-out. All tests use stubs/temp dirs; never connect live Telegram/Slack/Discord/Gmail in tests. `docker stop` the model stack before heavy multi-agent execution and `docker start` after.
>
> **PROD-SAFETY:** Tasks 1–5 are code/tests only (safe). The deploy (Task 6) is an ATTENDED, hand-back-to-operator step — short windows, verify-after, one host at a time, never unattended; it stops/replaces units running the 3 live MPA prod bots.

**Goal:** Make the Bot Builder runtime runnable on any opted-in instance — self-gating templated systemd units controlled by `feature_flags.bot_runtime` from the dashboard — then cut MPA over and light up grackle as a live second host.

**Architecture:** A `runtimeGate(db,{start,stop})` helper polls `feature_flags.bot_runtime` (sync better-sqlite3 read) and starts/stops the bot adapters in-process — so the dashboard toggle controls the runtime with no restart or privilege. The three runners (`gateway_runner`, `discord_gateway`, `bridge_tick`) wrap their adapter lifecycle in it. Per-instance templated units (`pibot-*@.service` + `/etc/crow/pibot-%i.env`) + a one-time `install-runtime.sh` make it distributable; a writable Settings toggle flips the flag.

**Tech Stack:** Node.js ESM, `node:test`, `better-sqlite3` (runners, sync), libsql (panel, async), systemd templated units, bash installer.

**Spec:** `docs/superpowers/specs/2026-06-08-f3b-bot-runtime-distribution-design.md`

**Conventions (every commit):** `git commit <explicit paths> -m "..."` (never `git add -A` + bare commit); verify `git show --stat HEAD`; never add Claude as co-author; `git pull --rebase` before push. Branch `feat/f3b-bot-runtime-distribution` (already created off `main`).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `scripts/pi-bots/runtime-gate.mjs` | `botRuntimeEnabledSync(db)` + `runtimeGate(db,{start,stop,pollMs,logTag})` | Create |
| `tests/runtime-gate.test.js` | gate transitions + sync flag read | Create |
| `scripts/pi-bots/bridge_tick.mjs` | add top-of-run flag guard (no-op when off) | Modify |
| `scripts/pi-bots/gateways/gateway_runner.mjs` | wrap adapters in `runtimeGate` | Modify |
| `scripts/pi-bots/discord_gateway.mjs` | wrap clients in `runtimeGate` | Modify |
| `servers/gateway/dashboard/settings/sections/bot-runtime.js` | writable `feature_flags.bot_runtime` toggle | Create |
| `servers/gateway/dashboard/panels/settings.js` | register the section | Modify |
| `servers/gateway/dashboard/shared/i18n.js` | label | Modify |
| `tests/bot-runtime-toggle.test.js` | toggle round-trip + merge-preserve | Create |
| `scripts/pi-bots/systemd/pibot-gateways@.service` | templated Telegram/Slack unit | Create |
| `scripts/pi-bots/systemd/pibot-discord@.service` | templated Discord unit | Create |
| `scripts/pi-bots/systemd/pibot-bridge@.service` | templated Gmail one-shot | Create |
| `scripts/pi-bots/systemd/pibot-bridge@.timer` | templated Gmail timer | Create |
| `scripts/pi-bots/install-runtime.sh` | one-time per-instance opt-in installer | Create |
| `tests/pibot-units-portable.test.js` | unit/installer lint (no hardcoded paths) | Create |

**Reference shapes (verified — read while implementing):**
- `botRuntimeActive(db)` (`servers/gateway/dashboard/panels/bot-runtime-flag.js`): async; `readSetting(db,"feature_flags")` → JSON → `typeof flags.bot_runtime === "boolean" ? flags.bot_runtime : isMpaHost()`. `isMpaHost()` = `/\.crow-mpa(\/|\b|$)/.test(`${process.env.CROW_HOME||""}|${process.env.CROW_DATA_DIR||""}`)`. **Leave this file unchanged** — the runners use a sync mirror (cross-layer + async/sync coupling avoided; `mpa-detect.js` dedup stays deferred).
- `feature_flags` is a `dashboard_settings` JSON row, local-only (absent from `sync-allowlist.js`). Sync scope-resolved read pattern (override-by-localId then global): see `bridge.readRemoteInvocationEnabled` (`scripts/pi-bots/bridge.mjs`). `getOrCreateLocalInstanceId()` from `servers/gateway/instance-registry.js` (sync). `parseRemoteInvocationFlag` shape in `scripts/pi-bots/remote-blocks.mjs` is the template for parsing a `feature_flags` sub-key.
- `gateway_runner.mjs`: `startAll()` connects adapters → module-scope `handles[]` (`{stop}`); `shutdown()` (`:95`) clears `reaper` + stops handles + `exit`; `main()` (`:104`) `startReaper(); await startAll(); setInterval(()=>{},1<<30)`.
- `discord_gateway.mjs`: `startBot(bot)` (`:89`) connects one client → `clients[]`; `shutdown()` (`:200`) destroys clients + exit; `main()` (`:208`) loads bots, `for (b of bots) startBot(b)`, keep-alive.
- `bridge_tick.mjs`: one-shot IIFE (`:54`) — `acquireLock()` then reaper + Gmail work + `process.exit(0)`. `LOCK="/tmp/pibot-bridge-tick.lock"`, released by deleting on exit.
- Settings section pattern: `servers/gateway/dashboard/settings/sections/remote-invocation.js` is the exact template (writable `feature_flags` toggle, `getPreview({settings})`, local scope, registered in `panels/settings.js`).
- Legacy units (to template): `scripts/pi-bots/pibot-gateways.service` (repo) + `/etc/systemd/system/pibot-{gateways,discord,bridge}.{service,timer}` (installed, hardcoded `CROW_DB_PATH=/home/kh0pp/.crow-mpa/data/crow.db`, `User=kh0pp`, `WorkingDirectory=/home/kh0pp/crow`, node at `/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node`).

---

## Task 1: `runtime-gate.mjs` — sync flag read + self-gating loop

**Files:** Create `scripts/pi-bots/runtime-gate.mjs`, `tests/runtime-gate.test.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/runtime-gate.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { botRuntimeEnabledSync, runtimeGate } from "../scripts/pi-bots/runtime-gate.mjs";

// Sync db stub mirroring readSetting's override-then-global resolution.
function dbWith(featureFlagsValue) {
  return {
    prepare(sql) {
      return {
        get() {
          if (/dashboard_settings_overrides/.test(sql)) return undefined;
          if (/FROM dashboard_settings\b/.test(sql)) return featureFlagsValue === undefined ? undefined : { value: featureFlagsValue };
          return undefined;
        },
      };
    },
  };
}

test("botRuntimeEnabledSync: explicit true/false wins", () => {
  assert.equal(botRuntimeEnabledSync(dbWith(JSON.stringify({ bot_runtime: true }))), true);
  assert.equal(botRuntimeEnabledSync(dbWith(JSON.stringify({ bot_runtime: false }))), false);
});

test("botRuntimeEnabledSync: malformed/absent → falls back to isMpaHost (env-driven)", () => {
  // No CROW_HOME/CROW_DATA_DIR pointing at .crow-mpa in the test env → false.
  assert.equal(botRuntimeEnabledSync(dbWith("not json")), false);
  assert.equal(botRuntimeEnabledSync(dbWith(undefined)), false);
});

test("botRuntimeEnabledSync: never throws on a broken db", () => {
  assert.equal(botRuntimeEnabledSync({ prepare() { throw new Error("boom"); } }), false);
});

test("runtimeGate: start() called when active at boot; stop() on active→inactive; start() on inactive→active", async () => {
  let active = true;
  const db = { /* unused: we inject the reader */ };
  const calls = [];
  const handle = runtimeGate(db, {
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
    pollMs: 10,
    _isActive: () => active, // test hook overrides botRuntimeEnabledSync
  });
  await new Promise((r) => setTimeout(r, 25)); // boot + at least one poll
  assert.deepEqual(calls, ["start"], "start once at boot, no churn while active");
  active = false;
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(calls, ["start", "stop"], "stop on active→inactive");
  active = true;
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(calls, ["start", "stop", "start"], "start again on inactive→active");
  handle.dispose();
});

test("runtimeGate: a throwing start() does not crash the gate (retries next poll)", async () => {
  let active = true, n = 0;
  const handle = runtimeGate({}, {
    start: () => { n++; if (n === 1) throw new Error("first fails"); },
    stop: () => {},
    pollMs: 10,
    _isActive: () => active,
  });
  await new Promise((r) => setTimeout(r, 35)); // boot (throws) + retries
  assert.ok(n >= 2, "start retried after throwing");
  handle.dispose();
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/runtime-gate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runtime-gate.mjs`**

Create `scripts/pi-bots/runtime-gate.mjs`:

```js
/**
 * F3b — bot-runtime self-gating. The dashboard toggle writes
 * feature_flags.bot_runtime; the long-lived runners poll it here and
 * start/stop their adapters in-process — so the toggle takes effect with NO
 * restart and NO privilege ("off" = idle process, not a stopped unit).
 *
 * Runners use better-sqlite3 (sync). The async panel reader
 * (bot-runtime-flag.js botRuntimeActive) mirrors this same resolve rule;
 * they're intentionally kept as two tiny readers (no cross-layer/async-sync
 * coupling) — the future mpa-detect.js dedup unifies isMpaHost.
 */
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";

/** Mirror of bot-runtime-flag.js isMpaHost() — auto-detect the MPA host. */
function isMpaHost() {
  const probe = `${process.env.CROW_HOME || ""}|${process.env.CROW_DATA_DIR || ""}`;
  return /\.crow-mpa(\/|\b|$)/.test(probe);
}

/** Resolve the rule from a parsed feature_flags object (shared with the panel). */
function resolveBotRuntime(flags) {
  if (flags && typeof flags.bot_runtime === "boolean") return flags.bot_runtime;
  return isMpaHost();
}

/**
 * Synchronous, scope-resolved read of feature_flags.bot_runtime over
 * better-sqlite3 (override-by-local-instance first, then global). Never throws.
 */
export function botRuntimeEnabledSync(conn) {
  try {
    let raw = null;
    let localId = null;
    try { localId = getOrCreateLocalInstanceId(); } catch {}
    if (localId) {
      const ov = conn.prepare("SELECT value FROM dashboard_settings_overrides WHERE key='feature_flags' AND instance_id=?").get(localId);
      if (ov && ov.value != null) raw = ov.value;
    }
    if (raw == null) {
      const gl = conn.prepare("SELECT value FROM dashboard_settings WHERE key='feature_flags'").get();
      if (gl && gl.value != null) raw = gl.value;
    }
    let flags = null;
    if (raw != null) { try { flags = JSON.parse(raw); } catch { flags = null; } }
    return resolveBotRuntime(flags);
  } catch {
    return false;
  }
}

/**
 * Drive start()/stop() on bot_runtime transitions. Returns { dispose() }.
 * @param {object} db better-sqlite3 connection (re-read each poll)
 * @param {object} o { start, stop, pollMs=30000, logTag, _isActive? }
 */
export function runtimeGate(db, { start, stop, pollMs = 30000, logTag = "runtime-gate", _isActive } = {}) {
  const isActive = _isActive || (() => botRuntimeEnabledSync(db));
  let running = false;
  const log = (m) => console.log(`[${logTag}] ${m}`);

  const tick = () => {
    let active;
    try { active = !!isActive(); } catch { active = false; }
    if (active && !running) {
      try { start(); running = true; log("bot_runtime ON — adapters started"); }
      catch (e) { log("start failed (will retry): " + ((e && e.message) || e)); }
    } else if (!active && running) {
      try { stop(); } catch (e) { log("stop error (non-fatal): " + ((e && e.message) || e)); }
      running = false; log("bot_runtime OFF — adapters stopped (idle)");
    }
  };

  tick(); // boot
  const timer = setInterval(tick, pollMs);
  if (timer.unref) timer.unref();
  return { dispose() { clearInterval(timer); } };
}
```

Note: the test's `_isActive` hook bypasses the db read so the transition logic is tested deterministically; the sync-read tests cover `botRuntimeEnabledSync` separately.

- [ ] **Step 4: Run it — expect pass**

Run: `node --test tests/runtime-gate.test.js`
Expected: PASS — 5 tests, fail 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-bots/runtime-gate.mjs tests/runtime-gate.test.js
git commit scripts/pi-bots/runtime-gate.mjs tests/runtime-gate.test.js \
  -m "F3b: runtime-gate — sync bot_runtime read + self-gating start/stop loop"
git show --stat HEAD
```

---

## Task 2: Wrap the three runners in the gate

**Files:** Modify `scripts/pi-bots/bridge_tick.mjs`, `scripts/pi-bots/gateways/gateway_runner.mjs`, `scripts/pi-bots/discord_gateway.mjs`.

No new unit test (the gate logic is covered in Task 1; the long-lived adapter lifecycle is integration, verified by `node --check` here + the attended acceptance in Task 6). The `bridge_tick` guard reuses the Task-1 sync reader.

- [ ] **Step 1: `bridge_tick.mjs` — add the flag guard**

Add the import (with the others at top):
```js
import { botRuntimeEnabledSync } from "./runtime-gate.mjs";
```
In the IIFE, immediately AFTER the `acquireLock()` guard line (`if (!acquireLock()) {...process.exit(0); }`) and BEFORE the reaper block, insert:
```js
  // F3b: respect the per-instance runtime toggle. Timer keeps firing; when the
  // operator has bot_runtime off, the tick is a no-op (release lock + exit).
  {
    const _g = db();
    let on = false;
    try { on = botRuntimeEnabledSync(_g); } finally { _g.close(); }
    if (!on) { try { unlinkSync(LOCK); } catch {} console.log("[tick] bot_runtime off — skip"); process.exit(0); }
  }
```
(`db`, `unlinkSync`, `LOCK` are already in scope.)

- [ ] **Step 2: Syntax check**

Run: `node --check scripts/pi-bots/bridge_tick.mjs` → exit 0.

- [ ] **Step 3: `gateway_runner.mjs` — wrap adapters in `runtimeGate`**

(a) Add import (with the others): `import { runtimeGate } from "../runtime-gate.mjs";`

(b) Add a `stopAdapters()` after `startAll()` (module scope):
```js
async function stopAdapters() {
  for (const h of handles.splice(0)) { try { await h.stop(); } catch {} }
}
```

(c) Replace the `main()` IIFE (`:104-109`) with a gate-driven one. The reaper stays always-on (cheap, unref'd). Replace:
```js
(async function main() {
  startReaper();
  await startAll();
  // Stay alive even with zero adapters so systemd doesn't flap on Restart.
  setInterval(() => {}, 1 << 30);
})();
```
with:
```js
let _gate = null;
(function main() {
  startReaper();
  // F3b: self-gate on feature_flags.bot_runtime — start/stop adapters on the
  // toggle without a restart. Off = idle (service up, no adapters connected).
  _gate = runtimeGate(db(), { start: () => { startAll(); }, stop: () => { stopAdapters(); }, logTag: "gateways" });
  setInterval(() => {}, 1 << 30); // keep the process alive across idle periods
})();
```
(`startAll` is async but `runtimeGate`'s `start` may be sync-fire-and-forget here; the `handles` populate as adapters connect. `db()` opens a short-lived connection re-opened each poll inside `botRuntimeEnabledSync`? — NO: `runtimeGate` is passed ONE `db()` connection and re-reads it each poll. Keep that single connection open for the gate's lifetime; it is read-only `SELECT`s with `busy_timeout`.)

(d) Update `shutdown()` to dispose the gate first: change its body's start to:
```js
async function shutdown() {
  log("SIGTERM — stopping");
  if (_gate) { try { _gate.dispose(); } catch {} }
  if (reaper) { clearInterval(reaper); reaper = null; }
  for (const h of handles) { try { await h.stop(); } catch {} }
  process.exit(0);
}
```

- [ ] **Step 4: Syntax check**

Run: `node --check scripts/pi-bots/gateways/gateway_runner.mjs` → exit 0.

- [ ] **Step 5: `discord_gateway.mjs` — wrap clients in `runtimeGate`**

(a) Add import: `import { runtimeGate } from "./runtime-gate.mjs";`

(b) Add `startAllDiscord()` + `stopAllDiscord()` (module scope, near `startBot`):
```js
function startAllDiscord() {
  const bots = loadDiscordBots();
  if (!bots.length) { log("no enabled bots with a discord gateway — idle"); return; }
  log("starting " + bots.length + " discord bot(s): " + bots.map((b) => b.bot_id).join(", "));
  for (const b of bots) startBot(b);
}
function stopAllDiscord() {
  for (const c of clients.splice(0)) { try { c.destroy(); } catch {} }
}
```

(c) Replace the `main()` IIFE (`:208`...) with:
```js
let _gate = null;
(function main() {
  _gate = runtimeGate(db(), { start: () => { startAllDiscord(); }, stop: () => { stopAllDiscord(); }, logTag: "discord" });
  setInterval(() => {}, 1 << 30);
})();
```

(d) Update `shutdown()` to dispose the gate:
```js
function shutdown() {
  log("SIGTERM — destroying " + clients.length + " client(s)");
  if (_gate) { try { _gate.dispose(); } catch {} }
  for (const c of clients) { try { c.destroy(); } catch {} }
  process.exit(0);
}
```

- [ ] **Step 6: Syntax check + regression**

```bash
node --check scripts/pi-bots/discord_gateway.mjs
node --test tests/pi-bots-no-mpa-coupling.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
node --test tests/runtime-gate.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: checks exit 0; no-mpa-coupling green; runtime-gate green.

- [ ] **Step 7: Commit**

```bash
git commit scripts/pi-bots/bridge_tick.mjs scripts/pi-bots/gateways/gateway_runner.mjs scripts/pi-bots/discord_gateway.mjs \
  -m "F3b: runners self-gate on bot_runtime (bridge_tick no-op when off; gateways/discord start/stop via runtimeGate)"
git show --stat HEAD
```

---

## Task 3: Writable `bot_runtime` Settings toggle

**Files:** Create `servers/gateway/dashboard/settings/sections/bot-runtime.js`; modify `panels/settings.js`, `shared/i18n.js`. Test `tests/bot-runtime-toggle.test.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/bot-runtime-toggle.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import section from "../servers/gateway/dashboard/settings/sections/bot-runtime.js";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "f3b-"));
  process.env.CROW_DATA_DIR = tmp; process.env.CROW_DB_PATH = join(tmp, "crow.db");
  return tmp;
}

test("toggle round-trips bot_runtime and preserves other flags", async () => {
  setup();
  const { execSync } = await import("node:child_process");
  execSync("node scripts/init-db.js", { env: process.env, stdio: "ignore" });
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  // seed another flag to prove merge-preserve
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  await writeSetting(db, "feature_flags", JSON.stringify({ smart_chat: true }), { scope: "local" });

  const res = { redirectAfterPost() {} };
  await section.handleAction({ req: { body: { action: "set_bot_runtime", enabled: "on" } }, res, db, action: "set_bot_runtime" });
  const { readSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const flags = JSON.parse(await readSetting(db, "feature_flags"));
  assert.equal(flags.bot_runtime, true);
  assert.equal(flags.smart_chat, true, "other flags preserved");

  assert.equal(await section.getPreview({ settings: { feature_flags: JSON.stringify({ bot_runtime: true }) } }), "enabled");
  assert.equal(await section.getPreview({ settings: {} }), "disabled");
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/bot-runtime-toggle.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the section** (mirror `remote-invocation.js`)

Create `servers/gateway/dashboard/settings/sections/bot-runtime.js`:

```js
/**
 * Settings Section: Bot Runtime (Multi-Instance group) — F3b.
 *
 * Toggles feature_flags.bot_runtime (local-only; absent from sync-allowlist).
 * When ON, this instance's installed bot-runtime units (pibot-*@<instance>)
 * actually run bots (poll Gmail / answer Telegram/Slack/Discord); the runners
 * self-gate on this flag with no restart. OFF = installed-but-idle. Requires
 * the units to be installed first (scripts/pi-bots/install-runtime.sh).
 */
import { readSetting, writeSetting } from "../registry.js";

async function readFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export default {
  id: "bot-runtime",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>`,
  labelKey: "settings.section.botRuntime",
  navOrder: 8,

  async getPreview({ settings }) {
    let on = false;
    try { on = JSON.parse(settings?.feature_flags || "{}")?.bot_runtime === true; } catch {}
    return on ? "enabled" : "disabled";
  },

  async render({ db }) {
    const flags = await readFlags(db);
    const on = flags.bot_runtime === true;
    return `<form method="POST">
      <input type="hidden" name="action" value="set_bot_runtime">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        When enabled, this instance <strong>runs</strong> the bots defined here — polling Gmail and
        answering Telegram / Slack / Discord. The runtime units must be installed first
        (<code>scripts/pi-bots/install-runtime.sh</code>); this toggle then starts/stops them with no restart.
        Off by default. <strong>Local to this instance, never synced.</strong>
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${on ? "checked" : ""}>
        <span>Run bots on this instance</span>
      </label>
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-secondary">Save</button></div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_bot_runtime") return false;
    const flags = await readFlags(db);
    flags.bot_runtime = req.body.enabled === "on";
    await writeSetting(db, "feature_flags", JSON.stringify(flags), { scope: "local" });
    res.redirectAfterPost("/dashboard/settings?section=bot-runtime");
    return true;
  },
};
```

- [ ] **Step 4: Register + i18n**

In `servers/gateway/dashboard/shared/i18n.js`, beside the other `settings.section.*` entries, add:
```js
  "settings.section.botRuntime": { en: "Bot Runtime", es: "Ejecución de bots" },
```
In `servers/gateway/dashboard/panels/settings.js`: add `import botRuntimeSection from "../settings/sections/bot-runtime.js";` with the other section imports, and `registerSettingsSection(botRuntimeSection);` after the `remote-invocation` / `unified-dashboard` registration.

- [ ] **Step 5: Run it + syntax check**

```bash
node --check servers/gateway/dashboard/settings/sections/bot-runtime.js
node --check servers/gateway/dashboard/panels/settings.js
node --test tests/bot-runtime-toggle.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
grep -n "bot_runtime\|feature_flags" servers/gateway/dashboard/settings/sync-allowlist.js || echo "OK: bot_runtime not in sync-allowlist (local-only)"
```
Expected: checks exit 0; toggle test passes; the OK line.

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/settings/sections/bot-runtime.js tests/bot-runtime-toggle.test.js
git commit servers/gateway/dashboard/settings/sections/bot-runtime.js \
  servers/gateway/dashboard/panels/settings.js servers/gateway/dashboard/shared/i18n.js tests/bot-runtime-toggle.test.js \
  -m "F3b: writable bot_runtime Settings toggle (local-only, default off)"
git show --stat HEAD
```

---

## Task 4: Templated units + opt-in installer

**Files:** Create `scripts/pi-bots/systemd/pibot-gateways@.service`, `pibot-discord@.service`, `pibot-bridge@.service`, `pibot-bridge@.timer`, `scripts/pi-bots/install-runtime.sh`. Test `tests/pibot-units-portable.test.js`.

- [ ] **Step 1: Write the portability lint test**

Create `tests/pibot-units-portable.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const DIR = "scripts/pi-bots/systemd";
const units = readdirSync(DIR).filter((f) => f.endsWith(".service") || f.endsWith(".timer"));

test("templated units exist", () => {
  for (const u of ["pibot-gateways@.service", "pibot-discord@.service", "pibot-bridge@.service", "pibot-bridge@.timer"]) {
    assert.ok(units.includes(u), `missing ${u}`);
  }
});

test("service units are instance-portable (no hardcoded ~/.crow-mpa, use EnvironmentFile, no crow-mpa-gateway dep)", () => {
  for (const u of units.filter((f) => f.endsWith(".service"))) {
    const s = readFileSync(`${DIR}/${u}`, "utf8");
    assert.ok(!/\.crow-mpa/.test(s), `${u} hardcodes ~/.crow-mpa`);
    assert.ok(/EnvironmentFile=\/etc\/crow\/pibot-%i\.env/.test(s), `${u} missing per-instance EnvironmentFile`);
    assert.ok(!/After=.*crow-mpa-gateway/.test(s), `${u} still depends on crow-mpa-gateway`);
  }
});

test("installer is portable + idempotent-flavored", () => {
  const sh = readFileSync("scripts/pi-bots/install-runtime.sh", "utf8");
  assert.ok(!/\.crow-mpa/.test(sh), "installer hardcodes ~/.crow-mpa");
  assert.ok(/\/etc\/crow\/pibot-/.test(sh), "installer doesn't write the per-instance env file");
  assert.ok(/systemctl/.test(sh) && /enable/.test(sh), "installer doesn't enable units");
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/pibot-units-portable.test.js`
Expected: FAIL — `scripts/pi-bots/systemd` missing.

- [ ] **Step 3: Create the templated units**

Create `scripts/pi-bots/systemd/pibot-gateways@.service`:
```ini
[Unit]
Description=Crow Bot Builder — gateway host (Telegram/Slack) [%i]
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kh0pp
WorkingDirectory=/home/kh0pp/crow
EnvironmentFile=/etc/crow/pibot-%i.env
ExecStart=/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node /home/kh0pp/crow/scripts/pi-bots/gateways/gateway_runner.mjs
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Create `scripts/pi-bots/systemd/pibot-discord@.service`:
```ini
[Unit]
Description=Crow Bot Builder — Discord gateway [%i]
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kh0pp
WorkingDirectory=/home/kh0pp/crow
EnvironmentFile=/etc/crow/pibot-%i.env
ExecStart=/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node /home/kh0pp/crow/scripts/pi-bots/discord_gateway.mjs
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Create `scripts/pi-bots/systemd/pibot-bridge@.service` (one-shot):
```ini
[Unit]
Description=Crow Bot Builder — Gmail bridge tick [%i]
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=kh0pp
WorkingDirectory=/home/kh0pp/crow
EnvironmentFile=/etc/crow/pibot-%i.env
ExecStart=/home/kh0pp/.nvm/versions/node/v20.20.2/bin/node /home/kh0pp/crow/scripts/pi-bots/bridge_tick.mjs
TimeoutStartSec=600
StandardOutput=journal
StandardError=journal
```

Create `scripts/pi-bots/systemd/pibot-bridge@.timer`:
```ini
[Unit]
Description=Crow Bot Builder — Gmail bridge tick timer [%i]

[Timer]
OnBootSec=90
OnUnitActiveSec=60
Unit=pibot-bridge@%i.service
AccuracySec=15

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Create the installer**

Create `scripts/pi-bots/install-runtime.sh`:
```bash
#!/usr/bin/env bash
# F3b — install + enable the per-instance bot runtime on THIS host.
# Usage: scripts/pi-bots/install-runtime.sh <instance-name> [CROW_HOME]
#   <instance-name>  systemd template key, e.g. "crow-mpa" or "grackle"
#   CROW_HOME        optional; defaults to ~/.crow (set to ~/.crow-mpa for MPA)
set -euo pipefail

NAME="${1:?usage: install-runtime.sh <instance-name> [CROW_HOME]}"
CROW_HOME="${2:-$HOME/.crow}"
DATA_DIR="$CROW_HOME/data"
DB_PATH="$DATA_DIR/crow.db"
NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_SRC="$REPO/scripts/pi-bots/systemd"
ENV_FILE="/etc/crow/pibot-$NAME.env"

[ -f "$DB_PATH" ] || { echo "ERROR: $DB_PATH not found — run 'npm run init-db' for this instance first" >&2; exit 1; }

echo "Installing bot runtime for instance '$NAME' (CROW_HOME=$CROW_HOME)"
sudo mkdir -p /etc/crow
sudo tee "$ENV_FILE" >/dev/null <<EOF
CROW_HOME=$CROW_HOME
CROW_DATA_DIR=$DATA_DIR
CROW_DB_PATH=$DB_PATH
PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
EOF
sudo chmod 0644 "$ENV_FILE"

for u in pibot-gateways@.service pibot-discord@.service pibot-bridge@.service pibot-bridge@.timer; do
  sudo cp "$UNIT_SRC/$u" "/etc/systemd/system/$u"
done
sudo systemctl daemon-reload
sudo systemctl enable --now "pibot-gateways@$NAME.service" "pibot-discord@$NAME.service" "pibot-bridge@$NAME.timer"

echo "Done. Units enabled for '$NAME'. They idle until you turn on"
echo "Settings → Bot Runtime (feature_flags.bot_runtime) on this instance."
```
Make executable: `chmod +x scripts/pi-bots/install-runtime.sh`.

- [ ] **Step 5: Run the lint test + shell syntax check**

```bash
node --test tests/pibot-units-portable.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
bash -n scripts/pi-bots/install-runtime.sh && echo "installer syntax OK"
```
Expected: lint tests pass; installer syntax OK.

- [ ] **Step 6: Commit**

```bash
git add scripts/pi-bots/systemd/pibot-gateways@.service scripts/pi-bots/systemd/pibot-discord@.service \
  scripts/pi-bots/systemd/pibot-bridge@.service scripts/pi-bots/systemd/pibot-bridge@.timer \
  scripts/pi-bots/install-runtime.sh tests/pibot-units-portable.test.js
git commit scripts/pi-bots/systemd/pibot-gateways@.service scripts/pi-bots/systemd/pibot-discord@.service \
  scripts/pi-bots/systemd/pibot-bridge@.service scripts/pi-bots/systemd/pibot-bridge@.timer \
  scripts/pi-bots/install-runtime.sh tests/pibot-units-portable.test.js \
  -m "F3b: per-instance templated pibot units + install-runtime.sh opt-in installer"
git show --stat HEAD
```

---

## Task 5: Invariant + regression sweep

**Files:** none (verification only).

- [ ] **Step 1: Full F3b test set + regressions**

```bash
node --test tests/runtime-gate.test.js tests/bot-runtime-toggle.test.js tests/pibot-units-portable.test.js tests/pi-bots-no-mpa-coupling.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
node tests/auth-network.test.js 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: all pass, fail 0 (auth-network unaffected — F3b adds no routes).

- [ ] **Step 2: Syntax sweep of every touched runtime file**

```bash
for f in scripts/pi-bots/runtime-gate.mjs scripts/pi-bots/bridge_tick.mjs scripts/pi-bots/gateways/gateway_runner.mjs scripts/pi-bots/discord_gateway.mjs servers/gateway/dashboard/settings/sections/bot-runtime.js servers/gateway/dashboard/panels/settings.js; do node --check "$f" && echo "OK $f"; done
```
Expected: all OK.

- [ ] **Step 3: Gateway boot smoke (isolated; the new section registers cleanly)**

```bash
TMP=$(mktemp -d); PORT=3074 CROW_DATA_DIR=$TMP CROW_DB_PATH=$TMP/crow.db timeout 14 node servers/gateway/index.js > /tmp/f3b-boot.log 2>&1; echo "exit=$?"
grep -iE "listening|error|cannot find|throw" /tmp/f3b-boot.log | grep -ivE "multicast-dns|express-rate-limit|ipKeyGenerator|ValidationError" | head
rm -rf "$TMP"
```
Expected: "listening" present; no module/throw errors.

- [ ] **Step 4: Scoped diff + STOP for the attended deploy**

```bash
git diff --stat main...feat/f3b-bot-runtime-distribution
```
Expected: only the File-Structure files (+ spec/plan docs). No strays. Then **STOP** — Task 6 is an attended, operator-driven deploy; do NOT run it autonomously.

---

## Task 6: Attended deploy — MPA cutover + grackle bring-up + acceptance

**Files:** none (operations only). **This is a hand-back, ATTENDED step.** Per the global prod-safety rule: short windows, verify-after each unit, one host at a time, no unattended long holds, the model stack restored. Merge + push to `main` first (`git pull --rebase`), then deploy per host (`git pull --ff-only`; **no init-db needed** — F3b adds no tables; the section/flag live in existing `dashboard_settings`).

- [ ] **Step 1: Restart the gateways** (so the new Bot Runtime Settings section + the gate-aware runner code is loaded) on crow (`crow-gateway`, `crow-mpa-gateway`) and grackle (`crow-gateway`). Verify is-active + clean journal.

- [ ] **Step 2: MPA cutover (tight window; do NOT disturb the 3 prod bots beyond this).**
  1. `bash scripts/pi-bots/install-runtime.sh crow-mpa /home/kh0pp/.crow-mpa` (writes `/etc/crow/pibot-crow-mpa.env`, installs templated units, `enable --now`).
  2. Set the flag ON for the MPA instance: Settings → Bot Runtime on `:8447`, OR `dashboard_settings_overrides(key='feature_flags', instance_id=<MPA id>)` merge `bot_runtime:true`.
  3. **In one window:** `sudo systemctl disable --now pibot-gateways.service pibot-discord.service pibot-bridge.timer` (the 3 legacy units) — the `@crow-mpa` units are already enabled+started by the installer and will start their adapters once the flag is on.
  4. **Verify:** a prod bot answers (send a Telegram/Discord message or trigger a Gmail tick); `systemctl is-active 'pibot-gateways@crow-mpa' 'pibot-discord@crow-mpa' 'pibot-bridge@crow-mpa.timer'`; journals clean.
  5. Once verified, remove the 3 legacy unit files (`sudo rm /etc/systemd/system/pibot-{gateways,discord,bridge}.{service,timer}` + the `pibot-bridge.service.d` drop-in) + `daemon-reload`. (Re-create the bridge timeout drop-in under `pibot-bridge@.service.d/` if the old `timeout.conf` is still wanted.)

- [ ] **Step 3: grackle bring-up.** Pre-check the lock guards are active (grackle's minted bot blocks carry `CROW_JOURNAL_MODE=DELETE`; `busy_timeout`; reaper). `bash scripts/pi-bots/install-runtime.sh grackle /home/kh0pp/.crow` on grackle → set `feature_flags.bot_runtime=true` on grackle. Define a **test** bot there (Bot Builder) and verify one end-to-end turn (Telegram or Gmail). Watch grackle's crow.db for any "database is locked" in the journal during a turn.

- [ ] **Step 4: Toggle verification.** On grackle, Settings → Bot Runtime OFF → confirm the runner idles (journal shows "bot_runtime OFF — adapters stopped"; no polling) WITHOUT a service restart; ON again → resumes. This proves the dashboard control works.

- [ ] **Step 5: Hand back.** Report cutover + grackle status; restart the model containers if they were stopped for the build.

---

## Self-Review

**Spec coverage:**
- §1 templated units + per-instance EnvironmentFile → Task 4 (units) + Task 6 (install). ✓
- §2 `runtime-gate.mjs` self-gating (sync read mirroring `botRuntimeActive`, start/stop transitions, fail-safe) → Task 1. ✓
- §2 runners wrap adapters / bridge_tick guard → Task 2. ✓
- §3 writable `feature_flags.bot_runtime` toggle (local scope, default off, getPreview) → Task 3. ✓
- §4 `install-runtime.sh` one-time opt-in → Task 4. ✓
- §5 MPA cutover (tight window, no disturbing prod bots) → Task 6 Step 2. ✓
- §6 grackle bring-up + crow.db-lock handling (isolated cross-host DB; existing guards) → Task 6 Step 3. ✓
- §7 testing (runtime-gate, bridge_tick guard via sync reader, toggle round-trip, unit lint, regression) + attended acceptance → Tasks 1,3,4,5 + Task 6 Steps 2-4. ✓
- Non-goals honored: no privileged systemctl path, no supervisor rewrite, no extra hosts, MPA-pinned fixtures untouched. ✓
- Deferred: `mpa-detect.js` dedup (runtime-gate keeps its own `isMpaHost` mirror, noted). ✓

**Placeholder scan:** No TBD/TODO. The runner-wrap steps (Task 2) name exact anchors (`startAll`/`shutdown`/`main` line numbers, `startBot`/`clients`, the `acquireLock` insertion point) + give full replacement code; `node --check` gates each. Task 6 is explicitly attended ops, not auto-run.

**Type consistency:** `botRuntimeEnabledSync(conn) → bool` (Task 1) reused in `bridge_tick` (Task 2) + by `runtimeGate`'s default reader (Task 1). `runtimeGate(db,{start,stop,pollMs,logTag}) → {dispose()}` consumed identically in both long-lived runners (Task 2). `feature_flags.bot_runtime` key string identical across the toggle (Task 3), the sync reader (Task 1), and `botRuntimeActive` (untouched). Settings-section export shape matches `remote-invocation.js`. Templated-unit `EnvironmentFile=/etc/crow/pibot-%i.env` identical across units (Task 4) and the path the installer writes (`/etc/crow/pibot-$NAME.env`, Task 4 installer).
