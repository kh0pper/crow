# Design — a bot must never resolve a Crow server belonging to another instance

Written 2026-08-08. Supersedes the framing in
`docs/superpowers/handoffs/2026-08-08-board-truth-scope-and-mcp-override.md`, whose central premise
turned out to be inverted. Every claim below was verified against live state or a running pi; the
evidence is in Appendix A.

---

## 1. The invariant

> **A bot must never resolve a Crow server bound to an instance other than its own.**

Stated structurally, which is how this design achieves it:

> **No file that can name an instance may describe a Crow server.**

## 2. What is actually wrong

The handoff said the defect was that `~/.pi/agent/mcp.json` **wins on collision** over the per-bot
`.mcp.json`, so per-bot instance scoping could not take effect. That is false on the pi that is
actually installed.

`/home/kh0pp/pi-lab/extensions/mcp-client.ts` — on `main`, loaded, live:

> *Precedence: global config first, then `.mcp.json` files from the filesystem root down to cwd —
> the NEAREST project file wins (Claude Code semantics).*

pi-lab commit `671e116`, **2026-07-04**, changed this. Crow's copy of the old rule survives in
`mcp_writer.mjs`'s header and in `extraServersFromExtensions`' skip comment, both re-asserted as
"re-verified on v0.82.0 (2026-07-25 probe run)". The stale comment is why the real behavior stayed
invisible for a month; correcting it is part of this fix, not tidying.

The real defect is narrower and more ordinary: **the per-bot file is written open-world.** It lists
only what the bot selected, copies blocks verbatim from a config pinned to one instance, and says
nothing about the rest — so everything unselected leaks in. Three live bugs follow.

### Bug 1 — core-server blocks are copied verbatim, so they carry another instance's database

`crow-memory` is a core server, so `extraServersFromExtensions` never mints it; `buildBotMcp` copies
the canonical block unchanged. Running the real `writeBotMcp` for `r4-assistant` under r4's
`CROW_HOME` produces:

```
tasks          → /home/kh0pp/.crow-r4/…            ✅ minted from r4's mcp-addons.json
bots-sql-mcp   → /home/kh0pp/.crow-r4/…            ✅ minted
crow-memory    → CROW_DB_PATH=/home/kh0pp/.crow-mpa/data/crow.db   ❌
```

`crow_store_memory` is in `r4-assistant`'s allowlist. Nothing crashes. It writes to MPA's `crow.db`.

The handoff's correction was half right: the *tools* are legitimate, the *binding* is not.

**Not yet fired.** MPA's `memories` table (read from a copy) has 343 rows, newest `2026-07-02`. The
path is armed and reachable; no cross-instance write has occurred. No data cleanup is required.

### Bug 2 — an empty tool envelope hands pi its full default surface

`toolAllowlist()` returns `""` for a bot with no builtin and no MCP tools. In `PiRpc`:

```js
if (narrowedTools !== tools) args.push("--tools", narrowedTools);
else if (tools) args.push("--tools", tools);   // "" is falsy → flag omitted
```

pi's own parser (`dist/cli/args.js:85-89` → `dist/core/sdk.js:133-136`): `--tools ""` parses to an
empty array and correctly yields no tools, but **omitting the flag yields `defaultActiveToolNames`** —
bash, edit, write, and every tool registered by every inherited global server.

`r4-toolkit-assets`, `r4-comms-log`, `r4-monday-mirror` are all `enabled=1` with empty envelopes. On
those three bots the MPA-pinned `crow-tasks`, `crow-bots-sql` and `crow-memory` tools are **callable
today**.

The comment three lines above that branch already states the rule — *"omitting the flag hands pi its
full default surface — narrowing would widen"* — but the empty-envelope case falls through the same
hole the narrowing case was patched for.

### Bug 3 — `optIn` is copied verbatim, which makes the server inactive

pi activates an `optIn: true` server only when a project file opts in with `{"enabled": true}`.
`buildBotMcp` copies blocks verbatim, `optIn` included, and nothing ever emits `enabled`. So
`job-searcher`, `job-searcher-dayane`, `pir-processor` and `grackle` carry
`mcp__google-workspace__*` in their allowlists for a server that never loads.

Proven by experiment (Appendix A.3). **Not** corroborated by production logs — no journal line
confirms or denies it in bot behavior.

### The common root

All three are the same mistake: **the writer treats the global config as a source to copy from, when
pi treats the per-bot file as the authority.**

## 3. The mechanism, as proven

pi 0.82.0 + pi-lab `main` merges global → filesystem root → cwd, nearest wins. Three levers:

| lever | effect | proven by |
|---|---|---|
| redefine a name in the per-bot file | per-bot block wins entirely | A.1 |
| `{"name": {"disabled": true}}` | global server does not load at all | A.2 |
| omit a name | global server **still loads** | A.2 |

This design uses all three rather than fighting the first.

## 4. Architecture

Three sources, split by what each genuinely knows. This is the structural form of the invariant.

| server class | source of truth | instance binding |
|---|---|---|
| Crow **core** — `crow-memory`, `crow-projects`, `crow-sharing`, `crow-blog`, `crow-storage` (the last catalogued only — §5.5) | `scripts/server-registry.js` (`CORE_SERVERS` + `CONDITIONAL_SERVERS`), which already carries args and `mcpEnv` templates and already has `resolveEnvValue` for `${VAR:-default}` | computed from this instance's env on every write |
| Crow **bundle** — `tasks`, `bots-sql-mcp`, `knowledge-base`, … | the instance's own `mcp-addons.json` | already instance-native; cwd defaulted to `<crowHome>/bundles/<id>` |
| **non-Crow** — `brave-search`, `google-workspace*`, `ms365`, `monday`, `box` | `~/.pi/agent/mcp.json`, which keeps them | none — they carry credentials, not instance identity |

`~/.pi/agent/mcp.json` is demoted from *catalog of Crow servers* to *the place third-party
credentials live*, which is what it was always good at.

`crow-browser` stays canonical-sourced: its cwd is `/home/kh0pp/crow/bundles/browser` — the repo, not
an instance — so it is not instance-scoped.

### Why the host file cannot simply be edited

`~/.pi/agent/mcp.json` is currently the product's Crow-server catalog in two places:

- `mcp_writer.buildBotMcp` copies server blocks from it. Remove the six Crow entries and all six MPA
  bots lose `crow-tasks` / `crow-memory` / `crow-bots-sql` / `crow-projects`.
- `ext_registry.probeAll()` renders the Bot Builder tool picker by probing **every** canonical
  server. Remove them and the operator can no longer select Crow's own tools when building a bot.

So the host cleanup is downstream of a product change, not an alternative to one. **Ordering is a
hard constraint** — see §8.

## 5. Code changes

### 5.1 `scripts/pi-bots/mcp_writer.mjs`

**New — `crowServerCatalog(crowHome)`.** Returns `{name: block}` for every Crow server available to
*this* instance, assembled from the registry (core) and `mcp-addons.json` (bundles). Core blocks get
`cwd = ROOT` (the repo) and env resolved against this instance's values. Bundle blocks get
`cwd = <crowHome>/bundles/<id>` when the addon block omits one, matching `proxy.js:197`.

**Resolution order for a selected server name** — stated explicitly, because it is the whole design:

1. **catalog** (`crowServerCatalog`) — instance-derived, always correct. Wins.
2. **canonical** (`~/.pi/agent/mcp.json`) — for names the catalog does not know: the non-Crow
   servers, plus `crow-browser`.
3. neither → warning, server omitted (unchanged behavior).

Before PR 2, canonical still carries the six Crow entries; step 1 means they are never consulted for
those names, so PR 1 fixes the binding on its own and PR 2 only removes a now-unused fallback.

**New — `rebindBlock(name, block, binding, crowHome)`.** A belt for blocks resolved at step 2 that
nonetheless carry instance-scoped state. It rewrites the four instance-scoped env keys — `CROW_HOME`, `CROW_DATA_DIR`, `CROW_DB_PATH`,
`CROW_TASKS_DB_PATH` — to this instance's values, sourced from `instance-paths.mjs`. The tasks path
is normalized through the `resolveSqlitePath()` that PR #278 added, so a `file:` URI from
`project_spaces.tasks_db_uri` never reaches a bundle's `better-sqlite3`. A `cwd` matching
`*/.crow*/bundles/<id>` is rewritten to `<crowHome>/bundles/<id>`; if that directory does not exist,
the server is **disabled with a stated reason** rather than minted into a guaranteed spawn failure.

The `/.crow` anchor is deliberate: `/home/kh0pp/crow/bundles/browser` and `/home/kh0pp/crow` do not
match, so the repo is left alone. It is instance-neutral, correctly.

**Changed — `buildBotMcp` becomes closed-world.** After emitting the bot's selected servers, emit
`{"disabled": true}` for every other name **present in the canonical config** and not selected. The
per-bot file becomes the complete statement of the bot's world. Emit in stable sorted order so the
file is diffable.

Canonical is the right source for the disable list because canonical is exactly what pi would
otherwise inherit — the catalog is never inherited, only written. After PR 2 the six Crow names leave
canonical and simply stop appearing in the disable list, which is correct: there is nothing left to
disable.

**Changed — strip `optIn` from selected blocks.** Selection *is* the opt-in. Fixes bug 3.

**Changed — comments.** The header's "homedir WINNING on key collision" and
`extraServersFromExtensions`' `// canonical present -> homedir wins, no mint` are both false as of
pi-lab `671e116`. Replace with the proven rule and cite the commit and date.

Return shape gains `disabled: [...]` and `rebound: [{name, keys}]` for logging. Existing keys keep
their names and meanings.

### 5.2 `scripts/pi-bots/bridge.mjs`

One line: `args.push("--tools", narrowedTools)` unconditionally, so an empty envelope pins
`--tools ""` instead of omitting the flag. Fixes bug 2.

Constructor body only. `PiRpc`, `db`, `toolAllowlist`, `CROW_DB`, `TASKS_DB` and every other export
keep their name and signature, so `job_runner.mjs`'s consumer surface is untouched — required by the
pibot soak agreement.

### 5.3 `scripts/pi-bots/ext_registry.mjs`

`probeAll()` renders **catalog ∪ non-Crow canonical** instead of canonical alone, so the GUI tool
picker keeps every server it shows today and gains correct instance binding for the Crow ones. This
is what makes §8's host cleanup survivable.

### 5.4 The alias shim

MPA's bots reference `crow-tasks` and `crow-bots-sql`. The instance-native names for those same
bundles are `tasks` and `bots-sql-mcp`. Renaming them in the six bot defs would change the tool names
the model sees (`mcp__crow-tasks__*` → `mcp__tasks__*`), which their system prompts and skills may
reference.

Ship a two-entry alias map — `crow-tasks → tasks`, `crow-bots-sql → bots-sql-mcp` — documented as a
compatibility shim with a stated retirement. **Do not migrate bot defs during the soak.**

The alias applies at **catalog lookup only**. The emitted block keeps the key the bot selected, so
`crow-tasks` stays `crow-tasks` in the per-bot file and the model keeps seeing
`mcp__crow-tasks__tasks_update`. Only the block's contents come from the instance-native `tasks`
entry. Nothing the model or a system prompt can observe changes.

This is the one part of the design worth calling ugly. It is contained to two entries and one lookup.

### 5.5 `crow-storage` — catalogued, not minted

`loadEnv()` reads only `<repo>/.env`, a single repo-global file. No instance has its own `.env`, and
`/home/kh0pp/crow/.env` contains zero `MINIO_*` keys. Minting `crow-storage` from its registry
`mcpEnv` would resolve endpoint and password to empty strings. The canonical block is no better — it
carries no MinIO env either.

No bot selects `crow-storage` or `crow-sharing`, so this is catalog-only surface. Catalog
`crow-storage` as **present but unconfigured**, with the reason surfaced in the GUI, instead of
minting a block that would fail on spawn.

## 6. The invariant as a test

Closed-world was chosen over refuse-to-start, so the invariant lands as an executable assertion over
the writer's output rather than a runtime abort.

`tests/pibot-mcp-instance-binding.test.js`:

1. **The invariant.** Given a canonical config pinned to instance **A** and a `crowHome` of instance
   **B**, no active block in the produced file may reference **A** — walking `cwd` and every env
   string value.
2. Every canonical key the bot did not select appears with `{"disabled": true}`.
3. A selected bundle absent on **B** is disabled with a stated reason, not silently minted.
4. `optIn` never survives into an active block.
5. `toolAllowlist(def) === ""` still yields `--tools ""` in the spawn args.

**Mutation-tested**: reverting any one production change must fail at least one test. This is the
discipline that caught `tracker.mjs`'s duplicate `db()` in PR #278, where reading the call sites was
not sufficient and running them was.

## 7. Blast radius

Checked, not assumed. Every MPA bot has a non-empty envelope, so `--tools` is already pinned and
closed-world removes **no capability from any existing bot** — only per-turn spawns. Six MPA-pinned
Crow servers plus `brave-search` stop being spawned into every r4 bot turn.

Bots and their selected servers at design time:

| instance | bot | selects |
|---|---|---|
| r4 | `r4-assistant` | `tasks`, `bots-sql-mcp`, `crow-memory` |
| r4 | `r4-toolkit-assets`, `r4-comms-log`, `r4-monday-mirror` | *(none — bug 2)* |
| r4 | `r4-heartbeat` | *(none, 1 builtin)* |
| mpa | `research-scout`, `pir-portal-runner` | `crow-tasks` |
| mpa | `job-searcher`, `job-searcher-dayane` | `crow-bots-sql`, `crow-tasks`, `google-workspace*`, `crow-memory`, `brave-search`, `crow-browser` |
| mpa | `pir-processor` | `crow-tasks`, `crow-memory`, `crow-projects`, `texas-gov-data`, `google-workspace`, `crow-bots-sql` |
| mpa | `grackle` | `crow-memory`, `google-workspace` |

The only behavior that changes is in the direction of the three bugs.

## 8. Host cleanup — PR 2, strictly after PR 1 deploys

**Ordering is a hard constraint.** Editing the global file before the product change breaks the six
MPA bots and the GUI picker immediately.

1. Strip the six Crow entries — `crow-memory`, `crow-projects`, `crow-blog`, `crow-storage`,
   `crow-tasks`, `crow-bots-sql` — from `~/.pi/agent/mcp.json`.
2. Add `{"disabled": true}` for those same six to `~/r4-tehcy/.mcp.json`.

Step 2 closes the **human** door. `~/r4-tehcy/.mcp.json` defines r4-correct servers under *different*
names (`r4-tasks`, `r4-trackers`, `r4-kb`, `pm-workspace`), so the six MPA-pinned globals currently
load **alongside** them: working in `~/r4-tehcy` today, `crow_store_memory` writes to MPA. That is
finding 2 of the board scope document, and the product fix does not close it — only step 2 does. It
remains correct to do even after step 1, as defense in depth.

Back up both files first, using the existing `.bak-<date>` convention already in `~/.pi/agent/`.

## 9. Soak discipline

`scripts/pi-bots/` is touched, and `pibot-gateways@r4` runs from the `~/crow` working tree in a soak
ending ~2026-08-12. Required:

- Log the `~/crow` pull with a timestamp.
- Restart `pibot-gateways@r4` **manually** — `r4-deploy.sh` does not restart it, and it imports
  `bridge.mjs` at start — and log that with a timestamp.
- Confirm bridge exports are name- and signature-stable before merging.

## 10. Out of scope

- **Board truth / visual language.** The next arc, scoped in Gitea `kh0pp/crow-engineering`, branch
  `docs/board-truth-and-visual-language-scope`. Not this task.
- **Migrating bot defs off `crow-tasks` / `crow-bots-sql` names.** Deferred behind the alias shim.
- **`~/crow/.mcp.json`** (generated) points `CROW_DB_PATH` at `./data/crow.db` — safe only because it
  is relative to the repo cwd. Recorded, not fixed.
- **`installed.json` drift.** r4's `installed.json` lists neither `tasks` nor `bots-sql-mcp` although
  both bundle directories and `mcp-addons.json` entries exist. This design keys off the bundle
  directory's existence, which is the operative truth for spawning, and warns on the discrepancy.
  Making `installed.json` authoritative would remove `r4-assistant`'s tools — the workaround that was
  explicitly rejected.
- **`tests/models-panel-ui.test.js`** fails on crow and passes in CI (memory-dependent fit probe).
  Predates this work.

---

## Appendix A — evidence

All experiments run against pi **0.82.0** with pi-lab `main` loaded, using a fake `HOME` containing a
global `mcp.json` and a project `.mcp.json` that define the *same server name*, each pointing at a
stub MCP server that appends its variant to a marker file on spawn. Whoever spawns, wins.

**A.1 — nearest file wins.** Global and project both define `probe`. Result: only **PROJECT**
spawned.

**A.2 — disable works; omission does not narrow.** Global defines `probe` and `other`; project says
`{"probe": {"disabled": true}}` and never mentions `other`. Result: `probe` did **not** spawn,
`other` **did**.

**A.3 — `optIn` survives a verbatim copy and suppresses the server.** Global entry carries
`optIn: true`.

| project file | result |
|---|---|
| copies the block verbatim, `optIn` retained (what `mcp_writer` does today) | **NOT SPAWNED** |
| copies the block with `optIn` stripped | spawned |

**A.4 — the live cross-instance binding.** Real `writeBotMcp` for `r4-assistant` under r4's
`CROW_HOME` emits `crow-memory` with `CROW_DB_PATH=/home/kh0pp/.crow-mpa/data/crow.db`.

**A.5 — inherited globals really are spawned into r4 bot turns.** r4 journal,
`Aug 07 21:23:09`:

```
[gateways] [jobs] job job-msjqo0g7-9x0mtn → failed (timeout:agent_end (stderr -mpa/bundles/tasks/server/index.js:18:12 {
  code: 'ERR_DLOPEN_FAILED'
[pi-lab/mcp-client] crow-tasks: MCP error -32000: Connection closed
Brave Search MCP Server running on stdio
```

MPA's copy of the tasks bundle carries a stale native-module ABI, which is the only reason that
particular spawn failed rather than succeeded against MPA's `tasks.db`.

**A.6 — no cross-instance write has occurred.** MPA `memories`: 343 rows, newest `2026-07-02`.

All database reads were taken from copies of `.db` + `-wal` + `-shm`; no running gateway's database
was opened directly.
