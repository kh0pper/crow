# Models

Crow runs local models two ways today, and this page documents the arc that is closing the gap between them. It covers the state landed on `feat/models-core-launch-roles` (catalog schema v3, the keyed registry, native provider rows, the start sequence, runtime override) — no bundle has been deleted, no docker branch touched, and nothing has migrated or deployed yet.

## Two paths today, and where this arc is heading

A **model bundle** is a docker-compose directory under `bundles/` with `category: "ai"`, `inference: true`, and a `providers[]` block; the Extensions page installs it, the gpu-orchestrator starts and stops it with `docker compose`, and every launch flag (`-c`, `-ngl`, `-fa`, KV quant, MTP draft flags) lives in the compose `command:`. The **catalog** path (`registry/model-catalog.json`) downloads curated GGUF weights and spawns `llama-server` natively, but until this arc it rendered only identity flags — no context size, no `-ngl`, no flash attention, no MTP — and its registry was keyed by bare model id, so provider roles (`crow-chat`) and variants over one set of weights (three 27B rows) could not be expressed. Kevin's stated goal is to retire the bundles and make the catalog + native path the only way to install and launch a local model. The full design is `docs/superpowers/specs/2026-09-04-models-bundles-to-catalog-design.md`; this branch is plan 1 of 4 — it gives the native path everything the bundles express today, so later plans can migrate each provider role off its bundle one at a time.

## Catalog schema v3: the `launch` block

Each catalog entry may carry an optional `launch` block: a fixed set of typed knobs plus `extra_args`, validated by `scripts/validate-model-catalog.js` and rendered into `llama-server` argv by `servers/gateway/models/launch.js` — the only module that maps a knob to a flag. `size_mb` in the catalog is **decimal megabytes** (bytes / 1e6, matching the Hugging Face tree API), and `min_ram_mb` must be at least `size_mb`. The runtime asset map gained a `linux-x64-cuda` slot alongside the existing Vulkan/CPU assets, so a host that probes CUDA (grackle, eventually) can resolve to a CUDA build without a catalog change.

| Knob | Flag(s) |
|---|---|
| `ctx` | `-c` (must be `1024 <= ctx <= context_len`) |
| `ngl` | `-ngl` |
| `flash_attn` (`on`/`off`/`auto`) | `-fa` |
| `parallel` | `-np` |
| `no_mmap` | `--no-mmap` |
| `kv_type` | `-ctk` / `-ctv` |
| `spec` (`type`, `draft_n_max`) | `--spec-type` / `--spec-draft-n-max` (requires an `mtp` companion or the `mtp` tag) |
| `sampling` (`temp`, `top_p`, `top_k`, `min_p`, `presence_penalty`) | `--temp` / `--top-p` / `--top-k` / `--min-p` / `--presence-penalty` |
| `jinja` | `--jinja` |
| `extra_args` | passed through verbatim, last |

`extra_args` may never repeat a flag the renderer or the identity/companion/task layer already owns (`-m`, `--model`, `--alias`, `--port`, `--host`, `--mmproj`, `--embedding`, `--reranking`, plus every flag above) — the validator rejects the collision at save. `jinja` was added as its own knob (not inferred only from `chat_template_kwargs`) because the retired 35B compose passes `--jinja` with no chat-template kwargs at all; the orchestrator still sets it automatically when a catalog entry declares `chat_template_kwargs`, and a provider override can also set it directly. Absent knobs render nothing, matching today's bundle-less behavior. `mergeLaunch` layers a provider's override over the catalog defaults key-by-key (`sampling` merges per sampling key; `extra_args` replaces wholesale).

## `serving.class`: a curated safety ceiling

Every catalog entry carries a required `serving: { class }` field: `resident` (single box, safe behind a cap, starts as today), `windowed` (needs an operator present; two-box and/or evicts production), or `wedge-risk` (a shape that has actually wedged a Strix Halo box). It is a **ceiling on the model, not a runtime toggle** — it lives only in the git-reviewed catalog (`registry/model-catalog.json`), never in `settings.localModels` or any instance setting; an instance may narrow what it runs, never widen it (narrowing is not built yet). `scripts/validate-model-catalog.js` requires the field on every entry and checks it arithmetically (a quant needing more than `SINGLE_BOX_RAM_MB`, 124 GiB, cannot be `resident`) plus against the `two-box` tag and the `first_run_default` model. Full design: `docs/superpowers/specs/2026-09-23-serving-class-design.md`.

The gateway enforces the ceiling at the single native start choke point, `acquireOrStartNative` — after the resident fast path (a running model is never refused) and before the box-reservation gate, so a permanent refusal is never reported as a retryable `box_reserved`. A `windowed` or `wedge-risk` start is refused (`ServingClassError`, 409) unless the caller passes an explicit `serving_override` naming that exact class; an uncurated provider (no catalog `catalogId` match) is always allowed. Only `POST /api/models/:id/start` can plumb `serving_override` — chat, the `/llm/v1` router, and `/llm/acquire` can never start a non-resident model at all (the router degrades to a live fast model on an escalation instead, or answers 409). The dashboard shows a class badge on every non-`resident` card and replaces one-tap Start with a notice; it never offers an override button, even a two-step one.

**Known limits:**
- A model fetched through the HF browser (`/hf-download`), or any provider whose `gpuPolicy.catalogId` isn't a catalog id, is uncurated (D6) — a DeepSeek GGUF fetched that way gets no ceiling.
- An `alwaysResident` non-resident model is never started, and `pollResidency` reports it as down. That's honest, but it's a misconfiguration.
- The bot model picker (`model-availability.js`) still lists a refused native model as `on_demand`. Picking it yields the refusal error, not a hang.

## Registry (`state.json`)

`<CROW_HOME>/models/state.json` keeps a `registry` map, now keyed `<catalogId>@<quant>` instead of bare model id, so one set of weights can back several provider rows (three 27B variants, for example) and a provider id can differ from the model it runs. A loader migration renames any old bare-id key to the new form once, idempotently, using the `catalogId`/`quant` already stored on the entry. Each entry carries `path` (absolute; defaults to `blobs/<file>` for a downloaded model), `companions[].path`, `adopted: true` when the weights were registered from an existing file rather than downloaded, and `verified: false` when the match was size-only rather than sha256. Unregistering an adopted entry, or a provider row that shares its weights with another provider, never unlinks the file. `runtimeOverride` and per-provider port `reservations` (keyed by provider id, unchanged) live in the same state file.

## Provider row shape for a native model

A native provider's `gpu_policy` (JSON column) gained `catalogId` and `quant` (together the registry key), `launch` (a per-provider override merged over the catalog defaults at start), `port` (the loopback port `llama-server` binds — previously parsed out of `base_url`), and `owner` (the instance id that is allowed to orchestrate this row). The existing fields (`mutexGroup`, `alwaysResident`, `defaultMember`, `local_only`) are unchanged; registering a chat or vision model still defaults into the host's chat mutex group (largest existing chat group, else `local-llm`), while embedding and rerank rows get no group.

`base_url` for a native row is now the **owning gateway's door**: `http://<owner's tailnet ip>:<gateway port>/llm/v1` (port from `CROW_GATEWAY_PORT`, default 3001; loopback fallback plus `local_only: true` when the host has no tailnet address). `models[0].id` still holds the bare model id, so the identity probe and existing consumers are unaffected. Two things exist because of this: **the door**, because remote instances and pi-lab should reach a native model through the owning gateway's `/llm/v1` rather than dialing its raw loopback port directly (a raw port is meaningless off-box and doesn't replicate); and **the owner gate**, because locality used to be decided purely by matching `base_url`'s hostname against the box's own addresses — which breaks the moment two co-hosted instances (crow and r4, on the same box) or a replicated row (black-swan, grackle) share an address. A row with a declared `owner` is orchestrated only by that instance, tailnet address notwithstanding; a row with no `owner` (pre-arc rows) keeps the old hostname-match rule. Locally, the orchestrator always probes and forwards to `127.0.0.1:<gpu_policy.port>`, never to `base_url` — the door is what other hosts dial, not what this host dials itself. Localization of an owned row's door back to loopback happens in exactly three read paths — `loadProvidersFromDb` (`servers/shared/providers-db.js`, the providers cache), `resolveFromDb` (`servers/gateway/ai/resolve-profile.js`, behind `resolveProviderConfig`, which the LLM router, chat routes and `ai/provider.js` all call), and `loadProviderFromDb` (`servers/memory/embeddings.js`, the cold-cache embedding fallback) — all three via `localizeNativeRow`/`localizeDbBaseUrl` in `servers/shared/native-locality.js`; the admin/registration view (`listProvidersAll`) and the instance-sync replication reads deliberately do NOT localize, because replication must carry the door.

## Start sequence and error codes

Starting a native provider runs: **identity probe on loopback** (is something already answering on `127.0.0.1:<port>` as this model?) → **reservation gate** (`box-reserve` / allow-list; unrelated to this arc, unchanged) → **sibling swap** (evict a mutex-group sibling if needed) → **host lock** (native lock keyed by mutex group) → **argv render** (registry lookup by `<catalogId>@<quant>` for `path` and companions, catalog `launch` merged under the provider's `gpu_policy.launch`, companion/task flags appended, binary resolved) → **readiness** (poll `127.0.0.1:<port>` until it answers, logging the full rendered argv either way). Failures short-circuit before any process is spawned wherever possible:

- `CTX_EXCEEDS_MODEL` — merged `launch.ctx` exceeds the catalog entry's `context_len`.
- `MODEL_FILE_MISSING` — the registry entry's `path` (or `blobs/<file>`) does not exist on disk.
- `INVALID_LAUNCH` — a `launch` block fails validation at save time (registration), never at start.
- `ADOPT_SHA_MISMATCH` / `ADOPT_SIZE_MISMATCH` / `ADOPT_FILE_MISSING` / `ADOPT_COMPANION_MISSING` — adopting a file already on disk: hash or size doesn't match the catalog quant, the file isn't there, or a required companion (e.g. `mmproj`) has no resolvable path.
- `NOT_ABSOLUTE` / `NOT_EXECUTABLE` / `VERSION_FAILED` — setting a runtime override: the path isn't absolute, isn't an executable file, or fails to run `--version`.

## Runtime override

`state.json.runtimeOverride` (`{ bin, label, version, setAt }`) is host-local. It lives in the state file, never in the `providers` DB row, so it never replicates to another instance. It bootstraps once from the `CROW_LLAMA_SERVER_BIN` environment variable when no record exists yet.

`state.json.runtimeOverrides[<id>]` is a **per-model** override with the same record shape and the same validation. `<id>` is the provider row's `gpu_policy.catalogId`, or the provider name for a row without one.

A native start resolves its binary in this order:

1. the per-model override;
2. the host override;
3. the pinned catalog release through `ensureRuntime`.

Either override skips `ensureRuntime`, and with it any `min_runtime_version` check. An override binary that goes missing logs one warning per binary and falls through to the next layer rather than failing the start.

The operator surface is a CLI that resolves the data dir the way the gateway does (`CROW_DATA_DIR`, else `~/.crow/data`, else the repo's `./data`):

    node scripts/models-runtime-override.mjs list
    node scripts/models-runtime-override.mjs get   [--model <id>]
    node scripts/models-runtime-override.mjs set   --bin /abs/llama-server [--model <id>] [--label <text>]
    node scripts/models-runtime-override.mjs clear [--model <id>]

For r4, point it at r4's data dir:

    CROW_DATA_DIR=/home/kh0pp/.crow-r4/data node scripts/models-runtime-override.mjs …

- Without `--model`, a command acts on the host override.
- A per-model override keyed by a `catalogId` applies to every quant/variant row of that model. That is intended: pi-lab builds are per model.
- `list` and `get` only read. They never trigger the env bootstrap. `clear` without `--model` writes nothing when no host override is stored.
- `set` and `clear` print the data dir they wrote to.
- The CLI is a second writer of `state.json`, next to the gateway. After every write it re-reads the file and checks the change landed. On a mismatch it retries once, then exits 3 saying a concurrent gateway write overwrote it.
- The read-back narrows the race but does not close it. A gateway that loaded `state.json` before the write and saves after the read-back still wins, silently. Verify with `get` after the next gateway restart.
- When `CROW_LLAMA_SERVER_BIN` is set, host `get`/`clear` warn that the gateway will re-bootstrap the host override from that variable.
- `set --model` warns when the id matches no catalog id and no registered model, because such an override only applies to a provider with that exact name.
- A running model keeps its binary until it is next started.

**Deploy note:** restart the crow and r4 gateways once after deploying this, before the first `set`. An older gateway drops unknown state keys, so it would rewrite `state.json` without `runtimeOverrides`.

This CLI is how a pi-lab pre-merge llama.cpp build reaches a single model. The dashboard card for both overrides is plan 3.

## Unified memory and the gfx1151 host profile

This section covers the Strix Halo runtime profile, spec `docs/superpowers/specs/2026-09-23-strix-halo-runtime-profile-design.md`.

**Probe.** `probeHardware()` adds five fields. Every earlier field keeps its meaning.

| field | what it holds |
|---|---|
| `gpuArch` | e.g. `gfx1151`, from the Vulkan device name, else from rocminfo |
| `unified` | `true` when Vulkan reports `INTEGRATED_GPU`, or when amdgpu sysfs shows a VRAM carve-out of 2 GiB or less alongside a GTT total. `false` for a discrete GPU. `null` when no GPU is detected. |
| `gttTotalMb`, `gttUsedMb` | from the amdgpu card with the smallest VRAM carve-out (the iGPU) that exposes `mem_info_gtt_*` |
| `ramTotalMb` | `/proc/meminfo` `MemTotal` |

On an APU, `vramMb` (RADV's `DEVICE_LOCAL` heap, 83 GiB on crow) is a slice of RAM. It is not separate memory.

`unified` comes from Vulkan's `deviceType` whenever vulkaninfo answers: `INTEGRATED_GPU` is `true` and `DISCRETE_GPU` is `false`. The sysfs small-carve-out heuristic is only a fallback, for other Vulkan types and for the rocminfo path. GTT fields are reported only when `unified` is `true`, taken from the amdgpu card with the smallest VRAM (the iGPU).

**Fit badge.** On a unified host `fitBadge` never adds VRAM to RAM. The GTT ceiling applies only to a **GTT-expanded** APU, where GTT total is at least 75% of `MemTotal`, as on crow with `amdgpu.gttsize`:

| condition (GTT-expanded, checked in this order) | badge |
|---|---|
| `min_ram_mb` above GTT total | `wont_fit`, even when an idle box has more MemAvailable than GTT |
| `min_ram_mb` within MemAvailable | `fits` |
| anything in between | `tight`: it fits the box, but only after other resident models are stopped |

Every other unified host (default GTT, or GTT/MemTotal unknown) uses the discrete formula minus the VRAM credit: `fits` within MemAvailable, `tight` within 110% of it, else `wont_fit`. So a laptop APU with default GTT never has a `fits` turned into `wont_fit`. Only GTT-expanded hosts get the wider `tight` band. There is no fourth badge value. The tight hint says both "close to your limits" and "may need other models stopped first". The discrete path is unchanged. The live GTT start gate is a separate change (two-host spec §6).

**Host launch profile.** `servers/gateway/models/host-profile.js` returns `{ flash_attn: "on", no_mmap: true, no_op_offload: true }` for `gpuArch: "gfx1151"` on `accel: "vulkan"`, and nothing otherwise. It is the **lowest** launch layer:

    host profile < catalog launch < provider gpu_policy.launch < jinja

So a curated catalog value or an operator's per-provider value always wins. Flash attention stays on for every task, because production containers already run `-fa on` for chat and embedding models on this hardware, and FA on an unsupported head size falls back silently. `--no-op-offload` stays in the profile regardless of `ngl`. A provider opts out per key with `gpu_policy.launch: { no_op_offload: false }`, `{ no_mmap: false }` or `{ flash_attn: "off" }`.

`no_op_offload` is a typed launch key. It renders `--no-op-offload` only when `true`, and `--op-offload`/`--no-op-offload` can never ride in `extra_args`.

An old override llama-server build that predates `-fa on` support or `--no-op-offload` will fail at launch on gfx1151, because a runtime override (host or per-model) skips `ensureRuntime` and with it the `min_runtime_version` check — opt out per provider with `gpu_policy.launch: { no_op_offload: false }` / `{ flash_attn: "off" }`.

pi-lab's caveats, also recorded in the module:

- `--no-op-offload` changes nothing unless weights are host-resident;
- pi-lab's measured +18% did not include the fork-only `GGML_MOE_PREFETCH`;
- results match on argmax, not bit for bit.

The profile applies to native starts only. Docker bundles build their own command lines.

## Host switch: no model orchestration

`CROW_DISABLE_MODEL_ORCHESTRATION=1` (`servers/shared/model-orchestration.js`) is a property of the **host**, not of a provider row. Per-row gates (locality, owner, foreign-instance veto, bundle/runtime presence, the external-engine marker) decide *which* rows a host may orchestrate. This switch says the host orchestrates *none*, however rows arrive through sync. That matters on a box like raven, where any synced row whose base_url is the box's own LAN address counts as local.

Under the switch:

- **Entry points:**
  - `maybeAcquireLocalProvider` and `resolveWarmableProviderName` return `null`;
  - `acquireProvider` throws `OrchestrationDisabledError` (`model_orchestration_disabled`) before any probe or start;
  - `ensureResident`, `retryDeferredResidents` and `checkIdleRevert` are no-ops;
  - `bootResidency` logs one DISABLED line and arms no idle-revert timer.
- **Lowest-level primitives** (`bundleUp`, `bundleStop`, `startNativeAndAwaitReady`) throw as well, so a future caller cannot bypass the gate.
- **Model bundles** (`inference: true`, truthy `requires.gpu`, non-empty `requires.gpu_arch`, non-empty `providers[]`, or an STT/TTS profile seed via `sttProfileSeed`/`ttsProfileSeed` — e.g. ollama, localai, faster-whisper-server, kokoro-tts) cannot be installed, started, stopped, uninstalled, or have shared storage applied through `/bundles/api/*`. This includes starts a peer forwards (`bundleOrchestrationRefusal` in `routes/bundles.js`).

The residency poll and the external-engine poll still run, since both are read-only. Model downloads are not gated. Spec: `docs/superpowers/specs/2026-09-24-raven-instance-no-orchestration-design.md`.

## External engines

A provider row can declare that **another machine runs the engine**: `gpu_policy.engine = { managed: "external", host: "<machine>", label?: "<engine>" }` (today: halogen on raven, row `raven-flash-next`). `managed` must be exactly `"external"`, the only value defined. `host` is a display label, never a routing input, and `providers.host` stays `cloud` (the tab shows "network" + "external · raven"). The helper is `isExternalEngine` in `servers/shared/provider-engine.js`. `gpu_policy` replicates, so every paired instance learns that the row is not its to manage.

**Never orchestrated.** Every orchestrator path checks the marker first. `maybeAcquireLocalProvider` returns `null`, so the caller dials `base_url` directly, exactly as for a cloud row. `acquireProvider` throws `ExternalEngineError` (`code: "external_engine"`). `resolveWarmableProviderName` returns `null`. `ensureResident` skips the row and logs once per provider. The row is never always-resident, never a mutex sibling (so it is never evicted), never a mutex-group member, and never an idle-revert default. The legacy `servers/shared/lifecycle.js` `ensureModelWarm` refuses it (`reason: "external_engine"`), and `releaseModel` is a no-op for it.

**Write validation (transition-only).** `upsertProvider` judges a write only when it **changes** `gpu_policy.engine`, `bundleId` or `gpu_policy.runtime` relative to the stored row. It then refuses a resulting row that has any of these:
- a malformed marker (`EXTERNAL_ENGINE_INVALID`);
- a marker combined with a `bundleId` or `runtime: "native"`, judged on the effective policy after the upsert's `COALESCE` (`EXTERNAL_ENGINE_CONFLICT`);
- a marked row turned into an orchestratable one in a single write (`EXTERNAL_ENGINE_CONFLICT`). Unmarking and orchestrating are refused together on purpose: `registerModel` still refuses an unmarked row that carries no `bundle_id` and no native runtime with `ProviderIdConflictError`, since it isn't "ours" to overwrite. To bring such a row under Crow's management, unmark it with its own write first (no `engine`, no bundle, no native runtime), then either disable/delete that row and register a fresh provider id, or convert it through a bundle install.

A malformed incoming `gpu_policy` JSON string is `EXTERNAL_ENGINE_INVALID` only when it differs (byte- or canonically-equal check) from what is already stored; a spread write that re-sends the stored value — malformed or not — passes untouched (spec §2.2, review round 2).

A write that leaves those three fields as stored always passes. Replication writes rows directly, never through `upsertProvider`, so a contradictory row can arrive from a peer, and the tab's re-enable, host repair and the reconciler must keep working on it.

The models.json reconciler keeps a stored `engine` when it re-asserts `gpu_policy`. It also runs each entry in its own try/catch: a refused entry is logged as `[providers-reconcile] <id> skipped: …` and counted in `failed`. `repairProviderHosts` has the same per-row isolation: a refused row is logged as `[providers-repair] <id> skipped: …` and the repair loop continues with the next row.

**Read-only health.** `servers/gateway/external-engine-poll.js` is armed by `initOrchestrator` next to the residency monitor.
- Every `CROW_EXTERNAL_ENGINE_POLL_MS` (default 60000; `0` disables it; the scratch test suite sets `0`), each enabled marked row gets one `GET <base_url>/models` with no auth header and a 3 s timeout. 2xx means ready.
- Results land in `getProviderHealth().external` (`servers/gateway/provider-health.js`). Disabled and removed rows are pruned from it.
- A tick probes and prunes only when the providers config came from the DB (`_source === "db:providers"`). The models.json fallback that `loadProviders()` serves after a cache invalidation or a DB error carries no markers, so such a tick is a no-op and every clock survives.
- Each instance probes from its own network position. A peer on another LAN may even reach a *different* device at the same private IP (for example `10.0.0.126`). That is harmless: the result is info-only, and the request is a header-less GET on `/models`.

**Surfacing.** External engines have their **own** nest signal, `externalEngines`, at **info severity at most, never warn**, so they never trigger a health-monitor push. There is no card when no engine is watched. Each engine gets one line:
- `"halogen on raven: up"`;
- `"… down for <age> (externally managed)"` once it has answered in this process;
- `"… not reachable from this instance"` if it never has.

Engines run outside Crow are stopped on purpose: raven's production windows stop halogen for hours, and Crow has no route-away.

The engines deliberately do **not** share the `providers` id. The monitor's dedupe is per issue id with a 24 h window, and a marker survives while any issue with that id is active. An external info issue under `providers` would therefore swallow the next real resident-model push. The resident `providers` signal is exactly as before.

The Settings > LLM > Providers dot for a marked row shows this instance's probe result: reachable, not reachable, or not probed yet.

**Not in scope:** remote lifecycle (the window script starts and stops halogen over ssh), route-away or fallback when an engine is down, and sync filtering. `GET /api/providers/health` still probes every row on demand.

## What later plans add

This branch is scoped to the native path's own capabilities; three later plans build on top of it. **Plan 2** adds a model-addressed `/llm/v1` door (`<providerId>/<modelId>` and bare-id resolution with a 400 on ambiguity), a lifecycle API under `/llm/models` (start/stop/status as async jobs, local-MCP-token auth), and the pi-lab contract change to call the gateway instead of raw ports — plus the fix for why a provider disable or bundle→native conversion made on the primary hasn't been replicating to r4, black-swan, and grackle. **Plan 3** reworks the Extensions and Model Catalog panels: a single "Local models" card replacing the per-bundle inference cards, a registration dialog (provider id, mutex group, launch knobs), an adopt-from-disk flow, and the runtime-override card. **Plan 4** is the actual migration: an ops script (`adopt`/`convert`/`revert`/`status`) driving six windows — embed, voice, chat (35B), the 27B variants, r4's gemma, then deleting crow's four model bundles and their `installed.json`/`~/.crow/bundles` entries — each run inside a registered box reservation with a live acceptance check.

## Two data facts worth knowing

The catalog's 35B entry (`qwen3.6-35b-a3b`) points at `unsloth/Qwen3.6-35B-A3B-MTP-GGUF`, not the non-MTP repo an earlier catalog revision cited — the weights already on disk (`hf-cache/qwen36-35b-a3b-mtp`) match this build by sha256, and it's the one crow's bundle actually runs. The catalog's 27B entry ships with no `launch.spec` (no MTP draft flags) because unsloth re-cut `unsloth/Qwen3.8-27B-GGUF` on 2026-08-19 and moved the MTP head into a separate companion file; the on-disk 27B weights predate that change and don't match any file in the current repo, so whether to adopt the on-disk file unverified (keeping in-GGUF MTP) or re-download the current build is an operator decision left open for plan 4's migration step.
