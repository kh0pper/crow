# Theme 8 — Companion Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the Theme 8 companion-cleanup wave from the 2026-06-12 Continuous Improvement plan: delete the dead model-proxy, make the `memory_integration` and face-tracking toggles real, remove dead config, surface household profiles, and realign the docs with reality.

**Architecture:** All changes ride the existing surfaces: `bundles/companion/scripts/generate-config.py` (container config generation), `bundles/companion/scripts/crow-device-config.js` (per-device kiosk runtime), the bot-builder editor/api-handlers (`servers/gateway/dashboard/panels/bot-builder/`), and docs. No new subsystems. Work on branch `fix/t8-companion-cleanup`, PR at the end (operator reviews decisions at the PR gate).

**Tech Stack:** Node (gateway, tests via `node --test`), Python 3 (generate-config.py), Docker (companion container), vanilla JS injections.

## Verified facts this plan is built on (audited 2026-07-01)

- `scripts/companion/model-proxy.mjs` + `companion-model-proxy.service` are **fully superseded** by `servers/gateway/routes/llm-router.js` (its header says so; `bundles/companion/docker-compose.yml:41-43` defaults `COMPANION_PROXY_URL` to `http://localhost:3001/llm/v1`; the systemd unit on crow is disabled/inactive; nothing listens on 11435; no installer references the unit). `scripts/companion/` contains ONLY these two files.
- Stale docs still describing the deleted proxy: `CLAUDE.md:56`, `docs/architecture/companion.md` (lines ~21,27,29,35,65,66), `docs/architecture/bot-builder.md:68`, plus `docs/es/` mirrors of both.
- `web-0006-persona-swap.patch` is an INTENTIONAL zero-hunk numbering slot — **keep, do not delete**.
- `companion_features` write path: `editor.js:385-394` → `api-handlers.js:268-283` → `pi_bot_defs.definition.companion_features` → served verbatim by `servers/gateway/routes/companion-proxy.js:76` (`/companion/device-config`) → read by `bundles/companion/scripts/crow-device-config.js:33-44` (`applyFeatures`). Only `social_chat` has a real runtime effect; `avatar_model` is consumed at config-gen (`generate-config.py:729`). `memory_integration`, `pet_mode`, `avatar_animation` are stored but read by nothing.
- **The `"crow"` router MCP bridge (memory/projects/blog/sharing category tools) is generated in `mcp_servers.json` (`generate-config.py:900-903`) but is NOT in `mcp_enabled_servers` (`generate-config.py:603` = `["crow-wm", "crow-storage"]`)** — memory tools are unavailable to every companion bot today, while household personas explicitly instruct `crow_store_memory`/`crow_search_memories` (`generate-config.py:772-782`). The memory_integration checkbox never worked.
- `proactive_speak_prompt` (`generate-config.py:584`) has zero triggering logic anywhere in the repo.
- Household profiles ALREADY have a dashboard UI (`bundles/companion/settings-section.js:280-297,423-437`, since 2026-04) — the June-12 spec's "env-only, invisible" premise is stale. No migration needed; this is a discoverability problem.
- Face tracking (`crow-face-tracking.js`) is injected globally (`bundles/companion/scripts/entrypoint.sh:59-61`) but starts disabled (`_enabled=false`) and only runs when toggled; the enable path is the enable branch of `toggle()` (disable early-return ~:518-537, `_enabled = true` at :557).
- `generate-config.py` entry contract: env `APP_DIR` (default `/app`) + `CROW_DB_PATH`; degrades gracefully when the DB is missing.

## Decisions adopted (operator can veto at the PR — all reversible)

| # | Decision | Adopted default | Rationale |
|---|---|---|---|
| D1 | proactive_speak_prompt | DELETE the dead entry (after verifying OLVV doesn't require the key) | No trigger exists anywhere; YAGNI |
| D2 | memory_integration semantics | **OPT-IN per bot**: per-bot preset with `memory_integration: true` enables the `"crow"` router bridge; global default stays memory-less UNLESS household profiles are defined (their personas hardcode memory-tool instructions, so household mode enables it globally) | (Revised after round-1 review.) Opt-in avoids the privacy hole of a shared kiosk's default character searching the owner's memory store, and matches stored data: every bot saved through the old editor carries an explicit `false`, so nothing silently changes for existing bots |
| D3 | pet_mode / avatar_animation checkboxes | Leave in place, unwired, pending the attended kiosk pet-mode test (Task 7) | Wiring them blind risks breaking the kiosk; test first |
| D4 | Call-avatar-sync per-bot toggle | DEFER (calls-bundle presence is already an opt-in gate) | Spec said "consider"; no user demand |
| D5 | Household profiles | No per-bot migration; add discoverability hint + docs | UI already exists in Settings → Companion |

## Global Constraints

- Commit with positional path args only (`git commit <paths> -m "..."`), verify with `git show --stat HEAD` — parallel sessions share this working tree.
- `git pull --rebase` before pushing.
- Tests: Node built-in runner — `node --test tests/<file>.test.js`. Gateway must still start: `node servers/gateway/index.js --no-auth` (Ctrl-C).
- Before merging the PR: check GitHub **Actions check-runs** (`/commits/<sha>/check-runs`), not the commit-status API.
- Never attribute Claude as co-author in commits.
- The companion container name on crow: discover with `docker ps --format '{{.Names}}' | grep -i companion` (referred to below as `$COMP`).
- crow.md / AI-behavior files are NOT in scope — this wave is codebase-shape only, so CLAUDE.md (repo) edits are correct per the CLAUDE.md-vs-crow.md rule.

---

### Task 1: Delete the dead model-proxy + realign every doc that references it

**Files:**
- Delete: `scripts/companion/model-proxy.mjs`, `scripts/companion/companion-model-proxy.service` (removes the whole `scripts/companion/` dir)
- Modify: `CLAUDE.md:56` (the Bot Builder paragraph), `docs/architecture/companion.md`, `docs/architecture/bot-builder.md:68`, `docs/es/architecture/companion.md`, `docs/es/architecture/bot-builder.md`, `docs/guide/kiosk-mode.md:42,50`, `docs/es/guide/kiosk-mode.md:42,50`, `servers/gateway/dashboard/shared/i18n.js:657` (`botbuilder.gwHintCompanion` EN+ES — user-facing "the model proxy"/"el proxy de modelos" wording), `bundles/companion/scripts/generate-config.py:557-563` (comment) + `:572` (log line)

**Interfaces:**
- Produces: a repo where `grep -rn "model-proxy\|11435" --include="*.md" --include="*.js" --include="*.mjs" --include="*.py" --include="*.yml" --exclude-dir=node_modules --exclude-dir=.vitepress .` hits only: `llm-router.js`'s "formerly" header note, `servers/gateway/boot/late-mounts.js:30`'s "folds the standalone companion model-proxy" comment (accurate historical note — keep), the docker-compose "Replaced" comment, and historical specs under `docs/superpowers/`. (`docs/.vitepress/dist` is a gitignored build artifact that still contains the old strings — it regenerates from the fixed sources; MUST be excluded from the grep or the verify is unsatisfiable.)

- [ ] **Step 1: Delete the two files**

```bash
cd ~/crow && git rm scripts/companion/model-proxy.mjs scripts/companion/companion-model-proxy.service
```

- [ ] **Step 2: Fix CLAUDE.md**

In `CLAUDE.md` (repo root), the Bot Builder section sentence currently reads:

> …and routes models via `scripts/companion/model-proxy.mjs` (`companion-model-proxy.service`, loopback `:11435`): fast `crow-voice/qwen3.5-4b` (`:8011`, text-only) → escalate to `crow-chat/qwen3.6-35b-a3b` on a leading `!escalate`.

Replace with:

> …and routes models via the gateway's in-process `/llm/v1` router (`servers/gateway/routes/llm-router.js`): fast `crow-voice/qwen3.5-4b` (`:8011`, text-only) → escalate to `crow-chat/qwen3.6-35b-a3b` on a leading `!escalate`.

- [ ] **Step 3: Fix the six affected docs (EN + ES)**

In `docs/architecture/companion.md`, `docs/architecture/bot-builder.md`, `docs/guide/kiosk-mode.md` (and their `docs/es/` mirrors), replace every description of "the standalone companion model proxy / `companion-model-proxy.service` / `127.0.0.1:11435` / the model proxy" with the gateway route. Canonical replacement language (translate for ES, matching each file's surrounding style):

> Model routing runs in-process in the gateway: `servers/gateway/routes/llm-router.js` serves `/llm/v1` (OpenAI-compatible), routing each turn fast-model-first with `!escalate` escalation. The companion container reaches it via `COMPANION_PROXY_URL` (default `http://localhost:3001/llm/v1`, see `bundles/companion/docker-compose.yml`).

Find every stale line — the EN pattern alone MISSES the Spanish phrasings ("proxy de enrutamiento de modelos", "el proxy de modelos"), so sweep ES files on the bare word:

```bash
grep -n "11435\|model-proxy\|model proxy" docs/architecture/companion.md docs/architecture/bot-builder.md docs/guide/kiosk-mode.md
grep -rin "proxy" docs/es/architecture/companion.md docs/es/architecture/bot-builder.md docs/es/guide/kiosk-mode.md
```

Every hit in the ES sweep that refers to the retired standalone proxy gets rewritten; hits that describe `COMPANION_PROXY_URL`/the gateway route stay.

- [ ] **Step 3b: Fix the user-facing dashboard string.** `servers/gateway/dashboard/shared/i18n.js:657` — `botbuilder.gwHintCompanion` says "(the model proxy)" / "(el proxy de modelos)" in the bot-builder Gateways tab. Rewrite both EN and ES to say the pair is routed by the gateway's `/llm/v1` router (keep the sentence's surrounding meaning intact).

- [ ] **Step 3c: Sweep the leftover "model proxy" comment/log wording in files this wave touches anyway** (cosmetic but they'd re-stale the docs): `generate-config.py:572` (the `"Companion LLM routed through model proxy"` log line → "routed through the gateway /llm/v1 router"), `generate-config.py:694` and `:941-942` (comments), `servers/gateway/dashboard/panels/bot-builder/editor.js:355`, `servers/gateway/dashboard/panels/bot-builder/api-handlers.js:247`, `bundles/companion/scripts/crow-device-config.js:9` (comments — reword "the model proxy" → "the gateway /llm/v1 router").

- [ ] **Step 4: Update the generate-config.py comment (lines 557-562)** — reword "the proxy" intro so it names the gateway, not a standalone service. Replace the comment block with:

```python
    # Companion model routing: when COMPANION_PROXY_URL is set (compose default:
    # the gateway's in-process /llm/v1 router, servers/gateway/routes/llm-router.js),
    # OLVV talks to it instead of a model directly. The router picks the fast model
    # (Qwen3.5-4B) by default, escalating to the 35B on a "!escalate" prefix, and
    # forwards messages + tools verbatim so OLVV's own tool loop / crow_wm /
    # streaming all keep working. The `model` field is a placeholder — the router
    # rewrites it per chosen upstream. (Host network → localhost reaches the gateway.)
```

- [ ] **Step 5: Verify** — run the grep from "Produces" above; confirm only the four allowed hits remain (llm-router.js header, late-mounts.js:30, docker-compose comment, docs/superpowers historical specs). Then `node servers/gateway/index.js --no-auth` starts clean (Ctrl-C).

- [ ] **Step 6: Commit**

```bash
git commit scripts/companion CLAUDE.md docs/architecture/companion.md docs/architecture/bot-builder.md docs/es/architecture/companion.md docs/es/architecture/bot-builder.md docs/guide/kiosk-mode.md docs/es/guide/kiosk-mode.md servers/gateway/dashboard/shared/i18n.js servers/gateway/dashboard/panels/bot-builder/editor.js servers/gateway/dashboard/panels/bot-builder/api-handlers.js bundles/companion/scripts/crow-device-config.js bundles/companion/scripts/generate-config.py -m "T8-1: delete dead companion model-proxy (superseded by gateway llm-router) + realign docs and UI strings"
git show --stat HEAD
```

- [ ] **Step 7: Instance cleanup on crow (not a repo change — do once, after the commit)**

```bash
sudo systemctl disable --now companion-model-proxy.service 2>/dev/null; sudo rm -f /etc/systemd/system/companion-model-proxy.service && sudo systemctl daemon-reload
```

---

### Task 2: Remove the dead `proactive_speak_prompt` entry (D1)

**Files:**
- Modify: `bundles/companion/scripts/generate-config.py:580-585` (the `tool_prompts` map)

- [ ] **Step 1: Verify OLVV tolerates the key's absence** (it may read `tool_prompts` defensively or not):

```bash
docker exec $COMP grep -rn "proactive_speak" /app/src/open_llm_vtuber/ | head -20
```

Expected: hits show optional lookup (e.g. `tool_prompts.get(...)`) or a feature that's config-flag-gated and off. **If** OLVV unconditionally indexes `tool_prompts["proactive_speak_prompt"]` (KeyError risk), STOP: keep the line, add the comment `# required by OLVV's tool_prompts loader even though Crow never triggers proactive speech` above it, and record that in the commit message instead.

- [ ] **Step 2: Delete the line** `"proactive_speak_prompt": "proactive_speak_prompt",` from the `tool_prompts` dict (currently line 584).

- [ ] **Step 3: Sanity-run config generation on the host.** CAUTION: `get_crow_db_path()` (`generate-config.py:204-213`) only honors `CROW_DB_PATH` **if the path exists** and otherwise falls back to `~/.crow/data/crow.db` — which exists on crow. To genuinely exercise the no-DB fallback, point `HOME` at an empty dir too:

```bash
python3 -c "import yaml" 2>/dev/null || echo "SKIP — pyyaml missing on host; verify inside container after Task 6 deploy instead"
OUT=$(mktemp -d); APP_DIR=$OUT HOME=$(mktemp -d) CROW_DB_PATH= python3 bundles/companion/scripts/generate-config.py; echo "exit=$?"
grep -c proactive "$OUT/conf.yaml"
```

Expected: the "Crow database not found, using fallback config" warning, `exit=0`, and `grep -c` → `0`. If pyyaml is missing on the host, run the equivalent check inside the container after Task 6's redeploy — note it in the commit.

- [ ] **Step 4: Commit**

```bash
git commit bundles/companion/scripts/generate-config.py -m "T8-2: drop dead proactive_speak_prompt registration (no trigger exists anywhere)"
git show --stat HEAD
```

---

### Task 3: Make `memory_integration` real (D2) — enable the `"crow"` router bridge, opt-in per bot

**Files:**
- Modify: `bundles/companion/scripts/generate-config.py` (`generate_config()` agent block ~line 596-607; per-bot preset writer ~line 941-962; add helper)
- Test: `tests/companion-config-memory-gating.test.js` (new)
- (No editor.js change — the existing unchecked-by-default checkbox now honestly means "memory off".)

**Interfaces:**
- Produces: `bot_mcp_servers(features)` (Python, in generate-config.py): returns `["crow-wm", "crow-storage", "crow"]` when `features.get("memory_integration") is True`, else `["crow-wm", "crow-storage"]`. Global config passes `{"memory_integration": True}` when household profiles are defined (their personas hardcode memory-tool usage + scoping), else `None`. Per-bot preset YAML `crow_bot_<slug>.yaml` gains an `agent_config` override when (and only when) its servers differ from the global default.
- Migration reality (state this in the PR body): every bot previously saved through the editor carries an explicit `memory_integration: false` (the old checkbox defaulted unchecked), so existing bots stay memory-less — enabling memory for a bot is a deliberate re-check of the box. Privacy rationale: a shared kiosk's default character must not be able to search the owner's memory store by default.

- [ ] **Step 1: Verify OLVV's character-preset merge semantics** (determines Variant A vs B below):

```bash
docker exec $COMP grep -rn "switch-config\|config_alts\|alt_config" /app/src/open_llm_vtuber/ | head -20
# then read the file(s) that load the alt character config:
docker exec $COMP sed -n '1,80p' /app/src/open_llm_vtuber/<file-found-above>
```

Determine: when a character yaml under `characters/` is loaded, is its `character_config` **deep-merged** onto the base config (missing keys inherited) or does a present key like `agent_config` **replace** the whole base `agent_config`?

- [ ] **Step 2: Add the helper + use it in the global config.** In generate-config.py, above `generate_config()`:

```python
def bot_mcp_servers(features):
    """MCP servers for a companion agent. The "crow" router bridge carries the
    memory/projects/blog/sharing category tools; memory_integration=True is the
    per-bot OPT-IN (privacy: a shared kiosk's default character must not search
    the owner's memory store unless deliberately enabled)."""
    servers = ["crow-wm", "crow-storage"]
    if (features or {}).get("memory_integration") is True:
        servers.append("crow")
    return servers


def global_mcp_servers():
    """Household personas hardcode memory-tool instructions + per-profile
    scoping, so household mode enables the crow bridge globally."""
    return bot_mcp_servers({"memory_integration": bool(get_household_profiles())})
```

Place both helpers after `get_household_profiles` (defined at ~line 658, ends ~687) — any module-level position works at runtime (Python resolves at call time) but reading order should not imply a forward reference. In `generate_config()` change line ~603 from `"mcp_enabled_servers": ["crow-wm", "crow-storage"],` to `"mcp_enabled_servers": global_mcp_servers(),`.

Semantics note (state in Task 6's docs too): in household mode the global default is memory-ON, and a bot with an explicit `memory_integration: false` still gets a preset override REMOVING `crow` — per-bot false wins over the household global. That is intended.

- [ ] **Step 3: Gate the per-bot presets.** In the Part-3 preset writer (`for bot in get_companion_bots(db_path):` block, ~line 944), after `cc = {...}`:

**Variant A (OLVV deep-merges presets):**
```python
        servers = bot_mcp_servers(bot["features"])
        if servers != global_mcp_servers():
            cc["agent_config"] = {
                "agent_settings": {
                    "basic_memory_agent": {"mcp_enabled_servers": servers}
                }
            }
```

**Variant B (a present `agent_config` REPLACES the base one):** emit the FULL agent block so nothing is lost — refactor `generate_config()` so the whole `agent_config` dict (lines ~597-607, including `llm_configs`) is built by a function `agent_config_block(llm_config, servers)` that both the global config and the preset call; the preset passes the same `llm_config` the global config used (thread it through or recompute from the same env logic). Then in the preset writer:
```python
        servers = bot_mcp_servers(bot["features"])
        if servers != global_mcp_servers():
            cc["agent_config"] = agent_config_block(llm_config, servers)
```
(If Step 1 shows presets CANNOT carry `agent_config` at all, STOP and reconcile the whole task: remove the checkbox from editor.js:394 + the `memory_integration` line from api-handlers.js instead, skip the test's per-bot assertions, and write Task 6's docs to state memory is global-only (on only in household mode) — do NOT ship a per-bot toggle the runtime can't honor.)

- [ ] **Step 4: Slug-collision guard (cheap, while here).** `slugify` is lossy, and with per-bot memory gating a preset collision would apply one bot's memory setting to another. In the preset loop, before writing each `crow_bot_<slug>.yaml`, warn on collision:

```python
        if os.path.exists(path):
            print(f"Warning: bot preset collision on slug '{bot['slug']}' — '{bot['bot_id']}' overwrites an earlier bot's preset", file=sys.stderr)
```

- [ ] **Step 5: Write the test** — `tests/companion-config-memory-gating.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3"; // match the driver already used by repo tests; if repo tests use node:sqlite, use that instead

function havePython() {
  try { execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

test("per-bot preset gates the crow router on memory_integration (opt-in)", { skip: !havePython() && "python3/pyyaml unavailable" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "t8-"));
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER DEFAULT 1)`);
  const mk = (id, mem) => JSON.stringify({ display_name: id, system_prompt: "p", gateways: [{ type: "companion" }], companion_features: { memory_integration: mem } });
  db.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)").run("mem-on", "mem-on", mk("mem-on", true));
  db.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)").run("mem-off", "mem-off", mk("mem-off", false));
  db.close();
  // Strip host COMPANION_* vars — a leaked COMPANION_PROFILE_N_NAME would flip
  // household mode and invalidate the global-default assertions.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COMPANION_")));
  execFileSync("python3", ["bundles/companion/scripts/generate-config.py"], {
    env: { ...env, APP_DIR: dir, CROW_DB_PATH: dbPath, HOME: dir }, stdio: "pipe",
  });
  const conf = readFileSync(join(dir, "conf.yaml"), "utf8");
  assert.ok(!/^\s*- crow$/m.test(conf), "global default (no household profiles) does NOT enable the crow router");
  const on = readFileSync(join(dir, "characters", "crow_bot_mem-on.yaml"), "utf8");
  assert.ok(/agent_config/.test(on) && /^\s*- crow$/m.test(on), "mem-on preset carries the override enabling crow");
  const off = join(dir, "characters", "crow_bot_mem-off.yaml");
  assert.ok(existsSync(off), "mem-off preset generated");
  assert.ok(!/agent_config/.test(readFileSync(off, "utf8")), "mem-off matches global default — no override block");
});
```

NOTE for the implementer: the repo's test sqlite driver is better-sqlite3 (verified in round-1 review) — still mirror an existing test's import style. `get_companion_bots` (`generate-config.py:689-717`) selects with `WHERE enabled = 1` first and falls back on OperationalError; the `enabled` column above exercises the primary path. `HOME: dir` keeps `get_crow_db_path()`'s fallback away from the real `~/.crow` (the env var is honored here because the temp DB exists). Adjust the CREATE TABLE if the real SELECT uses more columns.

- [ ] **Step 6: Run it (expect FAIL before Steps 2-3 are applied if you're doing strict TDD — write it first) then PASS after:**

```bash
node --test tests/companion-config-memory-gating.test.js
```

- [ ] **Step 7: Full gateway sanity + commit**

```bash
node servers/gateway/index.js --no-auth   # starts clean, Ctrl-C
git commit bundles/companion/scripts/generate-config.py tests/companion-config-memory-gating.test.js -m "T8-3: wire memory_integration for real — per-bot opt-in enables the crow router bridge (household mode enables globally)"
git show --stat HEAD
```

---

### Task 4: Face tracking becomes a per-device availability toggle

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/editor.js` (~line 391, Features checkbox group), `servers/gateway/dashboard/panels/bot-builder/api-handlers.js` (~line 268, features object), `bundles/companion/scripts/crow-device-config.js` (`applyFeatures`, line 33-44), `bundles/companion/scripts/crow-face-tracking.js` (the enable path, ~line 540-560)
- Test: extend the bot-builder gateway-save behavioral test (find it: `grep -l "companion_features" tests/*.test.js`)

**Interfaces:**
- Produces: `companion_features.face_tracking` (boolean; absent = ON). Runtime contract: `window.CrowDeviceFeatures.face_tracking === false` blocks face-tracking start.

- [ ] **Step 1: Editor checkbox** — in editor.js's Features `btb-checkbox-group` add (alongside the existing four, same hardcoded-EN style the group already uses — the i18n sweep is Theme 9's):

```js
`<label><input type="checkbox" name="gw_face_tracking"${chk(cf.face_tracking !== false)}> Face tracking (camera drives the avatar)</label>` +
```

- [ ] **Step 2: api-handlers persistence** — in the `features` object (api-handlers.js:268):

```js
          face_tracking: b.gw_face_tracking === "on" || b.gw_face_tracking === "true",
```

- [ ] **Step 3: Device-config reflection + late-arrival handling** — in `crow-device-config.js` `applyFeatures`, after the `data-crow-anim` line:

```js
    root.setAttribute("data-crow-face", f.face_tracking === false ? "off" : "on");
    // Hide the face-tracking toggle button entirely on disabled devices, and
    // stop tracking if the flag arrives after the user already started it
    // (features load via async fetch — a click can beat the response).
    try {
      var ft = window.CrowFaceTracking;
      if (f.face_tracking === false && ft) {
        if (ft.isEnabled && ft.isEnabled()) ft.toggle();
      }
    } catch (e) {}
```

Then hide the toggle button on disabled devices. The button is `#crow-face-tracking-toggle` (created in `createToggleUI()`, crow-face-tracking.js:479, styled via inline `style.cssText` :481-486 — there is NO existing stylesheet in this file). Add a new `<style>` element inside `createToggleUI()`:

```js
    var css = document.createElement("style");
    css.textContent = 'html[data-crow-face="off"] #crow-face-tracking-toggle { display: none !important; }';
    document.head.appendChild(css);
```

- [ ] **Step 4: Gate the start path** — in `crow-face-tracking.js` inside `toggle()`: the function first handles the disable branch (`if (_enabled) { ...tear down...; return; }`, ~lines 518-537) and then falls into the enable branch (which ends with `_enabled = true` at :557 inside the `onloadeddata` callback). Insert the gate at the START of the enable branch — i.e. immediately AFTER the disable early-return, NOT at the top of `toggle()` (a gate at the top would make it impossible to turn OFF tracking that's already running when the flag flips mid-session):

```js
    if (window.CrowDeviceFeatures && window.CrowDeviceFeatures.face_tracking === false) {
      emit("error", { error: "Face tracking is disabled for this device (Bot Builder → Gateways → Features)" });
      return;
    }
```

- [ ] **Step 4b: Close the load-window race.** The gate above can be bypassed when a click beats the async device-config fetch (`CrowDeviceFeatures` still undefined), and `applyFeatures`'s stop only helps once `_enabled` is true — but `_enabled` only flips in `onloadeddata` (:557) AFTER the multi-second MediaPipe + camera acquisition. Without this step, tracking that started in that window runs the whole session. Re-check the flag at the top of the `onloadeddata` callback (just before `_enabled = true`):

```js
        if (window.CrowDeviceFeatures && window.CrowDeviceFeatures.face_tracking === false) {
          releaseCamera(); // use this file's actual camera-teardown helper (see the disable branch :518-537 for its name)
          emit("error", { error: "Face tracking is disabled for this device (Bot Builder → Gateways → Features)" });
          return;
        }
```

(Match the exact teardown the disable branch performs — stop the stream if `_ownStream`, clear `_videoEl`, cancel `_animFrame` — so no camera indicator stays lit.)

- [ ] **Step 5: Test** — extend `tests/bot-builder-gateway-draft.test.js` (it exercises `handleBotBuilderPost` only — do NOT add an editor-render assertion; that file has no render plumbing) with persistence-side checks: saving a companion bot with `gw_face_tracking: "on"` persists `face_tracking: true`; saving with the field absent persists `face_tracking: false`. Follow that file's existing arrange/act/assert pattern (temp DB via `scripts/init-db.js`). Run: `node --test tests/bot-builder-gateway-draft.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-builder/editor.js servers/gateway/dashboard/panels/bot-builder/api-handlers.js bundles/companion/scripts/crow-device-config.js bundles/companion/scripts/crow-face-tracking.js tests/bot-builder-gateway-draft.test.js -m "T8-4: face_tracking per-device toggle (default on) — availability gated via companion_features"
git show --stat HEAD
```

---

### Task 5: Household-profiles discoverability hint (D5)

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/editor.js` (companion fields block, after the Features group ~line 396)

- [ ] **Step 1: Add the hint via i18n** (the sibling hint uses `t("botbuilder.gwHintCompanion", lang)` — match it, don't hardcode EN like the Features checkbox labels do). Find the i18n dictionaries with `grep -rn "gwHintCompanion" servers/gateway/dashboard/` and add key `botbuilder.gwHintHousehold`:
  - EN: `Household profiles (multiple named users, each with their own avatar & voice) are configured in Settings → Companion → Household — they apply to the whole companion, not per bot.`
  - ES: `Los perfiles del hogar (varios usuarios con su propio avatar y voz) se configuran en Ajustes → Companion → Hogar; aplican a todo el companion, no por bot.`

Then in editor.js after the Features group:

```js
`<p class="btb-hint">${t("botbuilder.gwHintHousehold", lang)}</p>` +
```

- [ ] **Step 2: Verify render** — `node servers/gateway/index.js --no-auth`, open the bot-builder editor Gateways tab with type=companion, confirm the hint renders (or assert via the existing editor render test if one covers the companion branch: `grep -l "gwHintCompanion" tests/*.test.js`).

- [ ] **Step 3: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-builder/editor.js servers/gateway/dashboard/i18n -m "T8-5: surface household-profiles location in the companion gateway editor (EN+ES)"
git show --stat HEAD
```

(Adjust the i18n path in the commit to wherever the dictionaries actually live per the Step 1 grep.)

---

### Task 6: `docs/architecture/companion.md` truth pass (EN + ES) + deploy

**Files:**
- Modify: `docs/architecture/companion.md`, `docs/es/architecture/companion.md`

- [ ] **Step 1: Rewrite the affected sections** to state (beyond Task 1's proxy fix, which already landed):
  - `companion_features` real semantics table: `social_chat` (runtime, hides voice/peer panel), `avatar_model` (config-gen), `memory_integration` (config-gen: per-bot OPT-IN that enables the `crow` router bridge — NEW; household mode enables it globally), `face_tracking` (runtime availability gate, default on — NEW), `hearing_style`/`voice_idle_timeout` (device-config), `pet_mode`/`avatar_animation` (stored; wiring pending the kiosk pet-mode verification).
  - Household profiles: configured in Settings → Companion → Household (`settings-section.js`), env-backed (`COMPANION_PROFILE_N_*`), container-restart to apply.
  - MCP bridges: `crow` (router category tools incl. memory) available but opt-in per bot / on in household mode; `crow-storage`, `crow-wm` unchanged. Note the privacy rationale (shared kiosk ≠ owner's memory store).
  - If Task 3 landed on the Variant-B fallback (no per-bot override possible), write the global-only semantics instead — the docs must match what shipped.
- [ ] **Step 2: Mirror in ES** (`docs/es/architecture/companion.md`) — translate, keep structure identical.
- [ ] **Step 3: Commit**

```bash
git commit docs/architecture/companion.md docs/es/architecture/companion.md -m "T8-6: companion architecture doc truth pass (features table, household profiles, MCP bridges)"
git show --stat HEAD
```

- [ ] **Step 4: PR + merge gate** — push branch, open PR, wait for **check-runs** (`curl -s https://api.github.com/repos/<owner>/crow/commits/<sha>/check-runs` all `completed`/`success`). Operator reviews decisions D1-D5 here.
- [ ] **Step 5: Deploy** — after merge on crow:
  - Pre-check the bridge auth so opt-in memory can't ship 401 noise: `docker exec $COMP printenv CROW_LOCAL_MCP_TOKEN` must be non-empty (crow-storage already needs it, so it should be — if empty, set it in the bundle `.env` before recreating).
  - Regenerate the companion config + restart the container so generate-config.py changes take effect (`docker compose -f ~/.crow/bundles/companion/docker-compose.yml up -d --force-recreate` or the bundle's documented restart path — check `bundles/companion/README`/panel for the canonical command first).
  - If any bot opts into memory: spot-check voice turn latency on the kiosk before/after (the router's category tools were designed for context reduction, but verify on the 4B fast model).
  - Fleet: instances pull `main` via auto-update (pull-only — verify grackle/black-swan picked it up if they run the companion; as of 2026-06 only crow does).
  - Docs site: check how `docs/.vitepress/dist` gets rebuilt/served on this host (`grep -rn "vitepress" package.json docs/package.json .github/workflows/ 2>/dev/null`); if it's hand-built, rebuild it (`cd docs && npm run build`) so the served site stops describing the deleted proxy.

---

### Task 7 (ATTENDED — requires the operator): pet-mode verification on the kiosk

Not autonomous; schedule with Kevin. Checklist:

- [ ] Confirm the kiosk launch env: `CROW_PET_ANCHOR` set? (`web-0007` patch reads it; `web-0008` opens the control socket at `$XDG_RUNTIME_DIR/crow-pet.sock`; manifest-level gate `companion.pet_mode` in `servers/wm/server.js:92`).
- [ ] Launch pet mode on the kiosk; verify: anchoring applied, re-anchor via the socket works (`{op:"anchor",...}`), no crash on Linux.
- [ ] Outcome A (works): wire `companion_features.pet_mode` → decide with operator whether the per-bot checkbox should drive `CROW_PET_ANCHOR`/switch, then implement as a follow-up task.
- [ ] Outcome B (broken): file the fix list; the checkbox stays inert until fixed (D3).
- [ ] Either way: capture findings in `docs/architecture/companion.md` pet-mode section.

---

## Review

**Round 2 (2026-07-01, adversarial subagent): narrow REVISE — all three criticals + all suggestions applied:**
1. User-facing "model proxy" string in `i18n.js:657` (`gwHintCompanion` EN+ES) invisible to the verify grep → Task 1 Step 3b added; leftover comment/log wording sweep → Step 3c.
2. Verify grep unsatisfiable (gitignored `docs/.vitepress/dist` still contains old strings) → grep now excludes `.vitepress`; VitePress rebuild check added to Task 6 deploy.
3. The applyFeatures race-stop couldn't fire during the multi-second MediaPipe/camera load window (isEnabled() still false) → Task 4 Step 4b re-checks the flag in `onloadeddata` before `_enabled = true`, with full camera teardown.
Also: helper-placement contradiction fixed (after `get_household_profiles`), household+explicit-false semantics stated (per-bot false wins), test env strips `COMPANION_*` leakage, Task 4 test scoped to persistence-only (no render plumbing in that file), button-hiding spec'd against the real `#crow-face-tracking-toggle` inline-style reality.
Round 2 also POSITIVELY verified: D2 helper logic/insertion points against real line numbers, the Task 3 test passes against real behavior (missing tables degrade gracefully; `- crow$` regex safe vs `crow-wm`; slugify preserves hyphens; better-sqlite3 is the repo driver), Task 4 structure claims (:518-537/:557/:479), ES doc sweep complete.

**Round 1 (2026-07-01, adversarial subagent): REVISE.** All four critical issues addressed:
1. Stale-doc misses (`docs/guide/kiosk-mode.md` EN+ES; ES phrasings invisible to the EN grep) → added to Task 1 with an ES-aware sweep.
2. Task 1 verify contract missed `servers/gateway/boot/late-mounts.js:30` → added to the allowed-hits list.
3. Task 2's sanity run silently read the real `~/.crow` DB (`CROW_DB_PATH` only honored when the path exists) → step rewritten with `HOME` redirect; same quirk documented in the Task 3 test (`HOME: dir`).
4. D2 default-ON was a silent no-op for existing bots (stored `false`) AND a shared-kiosk privacy hole (reviewer Q1) → **D2 flipped to opt-in per bot, household mode enables globally**; editor unchanged; migration + privacy rationale mandated in the PR body.

Suggestions adopted: `enabled` column in the test schema (primary SQL path), precise gate placement in `toggle()` (enable branch only, preserving mid-session opt-out), toggle-button hiding + late-arrival/race stop in `applyFeatures`, `CROW_LOCAL_MCP_TOKEN` pre-deploy check, slug-collision warning, Task 5 via i18n key (EN+ES), Variant-B fallback now reconciles the test + Task 6 docs, latency spot-check noted (reviewer Q2), file-path cites corrected.

## Self-review notes (2026-07-01)

- Spec coverage vs the Theme-8 master-doc shape: (1) dead code → Tasks 1-2 (web-0006 kept deliberately — verified intentional slot); (2) memory_integration audit+fix → Task 3; (3) proactive-speak decision → Task 2/D1; (4) household+face-tracking toggles → Tasks 4-5 (household = discoverability per verified-stale premise, D5; avatar-sync deferred, D4); (5) doc refresh → Tasks 1+6; operator additions: pairing gap already fixed (W1-5 `c31a3d6`), pet-mode test → Task 7.
- Known unknowns are contained in explicit verify-first steps with both variants specified (Task 2 Step 1, Task 3 Steps 1/3) — implementers must not skip them.
- Type consistency: `bot_mcp_servers(features)` and `companion_features.face_tracking` names used consistently across tasks.
