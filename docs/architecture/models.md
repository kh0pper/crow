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

`state.json.runtimeOverride` (`{ bin, label, version, setAt }`) is host-local — it lives in the state file, never in the `providers` DB row, so it never replicates to another instance. It bootstraps once from the `CROW_LLAMA_SERVER_BIN` environment variable when no record exists yet. When set, every native start on that host uses the override binary instead of the pinned catalog release, skipping `ensureRuntime` entirely; if the override binary later goes missing, the orchestrator falls back to the release with a logged warning rather than failing the start. A panel card for setting and clearing the override (with `--version` validation surfaced in the UI) is scoped to a later plan (plan 3), not this branch.

## What later plans add

This branch is scoped to the native path's own capabilities; three later plans build on top of it. **Plan 2** adds a model-addressed `/llm/v1` door (`<providerId>/<modelId>` and bare-id resolution with a 400 on ambiguity), a lifecycle API under `/llm/models` (start/stop/status as async jobs, local-MCP-token auth), and the pi-lab contract change to call the gateway instead of raw ports — plus the fix for why a provider disable or bundle→native conversion made on the primary hasn't been replicating to r4, black-swan, and grackle. **Plan 3** reworks the Extensions and Model Catalog panels: a single "Local models" card replacing the per-bundle inference cards, a registration dialog (provider id, mutex group, launch knobs), an adopt-from-disk flow, and the runtime-override card. **Plan 4** is the actual migration: an ops script (`adopt`/`convert`/`revert`/`status`) driving six windows — embed, voice, chat (35B), the 27B variants, r4's gemma, then deleting crow's four model bundles and their `installed.json`/`~/.crow/bundles` entries — each run inside a registered box reservation with a live acceptance check.

## Two data facts worth knowing

The catalog's 35B entry (`qwen3.6-35b-a3b`) points at `unsloth/Qwen3.6-35B-A3B-MTP-GGUF`, not the non-MTP repo an earlier catalog revision cited — the weights already on disk (`hf-cache/qwen36-35b-a3b-mtp`) match this build by sha256, and it's the one crow's bundle actually runs. The catalog's 27B entry ships with no `launch.spec` (no MTP draft flags) because unsloth re-cut `unsloth/Qwen3.8-27B-GGUF` on 2026-08-19 and moved the MTP head into a separate companion file; the on-disk 27B weights predate that change and don't match any file in the current repo, so whether to adopt the on-disk file unverified (keeping in-GGUF MTP) or re-download the current build is an operator decision left open for plan 4's migration step.
