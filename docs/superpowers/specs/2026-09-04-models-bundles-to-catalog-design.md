# Model bundles → catalog + Hugging Face browser — DESIGN (2026-09-04)

Status: **DESIGN APPROVED in brainstorm 2026-09-04** (Kevin, section by section); step-time decisions D12–D14 taken 2026-09-05; plan not yet written.
Predecessors: `docs/superpowers/handoffs/2026-09-04-catalog-v2-shipped-next-bundles-to-catalog-arc.md`
(seed facts), `docs/superpowers/plans/2026-09-04-model-catalog-curation.md` (catalog v2 + stale
bundle retirement, shipped as PRs #303/#304), `docs/architecture/box-reservation.md`.

Kevin's goal, verbatim (2026-09-04): "ultimately the goal is to move away from the bundles we have
in the extension page and replace that method of installing models with this model catalog and
hugging face browser."

## 1. Problem, restated from the code

Crow has two ways to install and launch a local model, and they do not meet.

**Bundle path.** A model bundle is a docker-compose dir under `bundles/` whose manifest carries
`category: "ai"`, `inference: true` and a `providers[]` block. The Extensions page installs it
(`POST /bundles/api/install`), which copies the dir under `~/.crow/bundles`, runs `docker compose
up`, writes `~/.crow/installed.json`, and calls `registerProviderFromManifest()` to create a
`providers` row with `bundle_id` set, `host: "local"`, `base_url` on the Tailscale IP and a fixed
port (`crow-chat` → `100.118.41.122:8003`). The gpu-orchestrator starts and stops these rows with
`docker compose` (`bundleUp`/`bundleStop`) and swaps mutex-group siblings. Every launch knob (`-c`,
`-ngl`, `-fa`, `-np`, KV quant, MTP draft flags, `--no-mmap`, sampling, `--pooling`) lives in the
compose `command:`. pi-lab's `lib/local-models.mjs` starts the same compose dirs from
`~/.pi/agent/settings.json` `localModels[].composeDir`.

Live model bundles on crow today: `llamacpp-vulkan-qwen36-35b-a3b` (crow-chat, kyuz0
`vulkan-radv-mtp` toolbox image), `vllm-rocm-qwen35-4b` (crow-voice, vLLM ROCm, BF16),
`llamacpp-vulkan-qwen3-embed` (crow-embed), plus private `~/crow-addons` composes for the three
27B variants (`llamacpp-vulkan-qwen38-27b{,-copilot,-512k}`) and `llamacpp-vulkan-gemma4-e2b`
(r4's wayfinder ask-generation). grackle runs `vllm-cuda-{embed,rerank,vision}`.

**Catalog path.** `registry/model-catalog.json` (10 curated entries, schema v2 with shards,
companions, task enum) → `downloadModel()` into `~/.crow/data/models/blobs` with per-file sha256
→ `registerModel()` writes a `providers` row with `bundle_id: null`, `host: "local"`, `base_url
http://127.0.0.1:181xx/v1`, `gpu_policy: {runtime:"native", mutexGroup}` → `acquireOrStartNative()`
spawns llama-server from the pinned stock GitHub release (`runtime.release` b10068), under a native
host lock keyed by mutex group, with an identity probe. Panel: `dashboard/panels/model-catalog.js`
(curated + Hugging Face tabs); routes under `/api/models/*`.

What the code says about the gap:

- The native path renders only `--model/--alias/--port/--host`, plus `--jinja` (chat-template
  kwargs), `--mmproj` (companion), `--embedding`/`--reranking` (task). No context size, no `-ngl`,
  no flash attention, no `-np`, no MTP, no `--no-mmap`. `context_len` reaches the provider row only.
- Provider id equals model id in `registerModel`; the registry (`state.json`) is keyed by model id.
  Roles (`crow-chat`) and variants (three 27B rows on one set of weights) cannot be expressed.
- Locality (`servers/shared/locality.js isLocallyOrchestratable`) is decided by the `base_url`
  hostname. A loopback `base_url` replicated to r4 (same box) or black-swan looks local there.
- `/llm/v1` (`routes/llm-router.js`) is the companion router: it advertises two ids (fast and
  escalate) and picks by heuristics. It is not a model-addressed door. pi-lab addresses each model by
  its own raw port through separate `models.json` providers (`crow-local`, `crow-local-27b`, …).
- The native chat mutex group defaults to `local-llm`; the bundle rows use `crow-strix-vram`. The
  host lock is keyed by group, so today a native chat model and the 35B bundle do not exclude each
  other.
- ~360 GB of weights already sit in `/home/kh0pp/llm/hf-cache` (35B 93 GB, 27B 26 GB, Flash-Next
  238 GB, embed 0.6 GB), outside the blob dir.
- The primary disabled eight stale provider rows on 2026-09-04; r4, black-swan and grackle still
  show them enabled. Provider replication of a disable did not propagate.
- Host facts: RADV Vulkan ICD present, glibc 2.39 (stock Vulkan release runs natively); ten
  operator llama.cpp builds exist under `~/llama-*/build/bin/llama-server`.

## 2. Decisions taken in the brainstorm (Kevin, 2026-09-04)

| # | Question | Decision |
|---|---|---|
| D1 | vLLM's future | **llama.cpp is the only runtime.** crow-voice moves to the catalog's Qwen3.5-4B GGUF; grackle's specialists move to the catalog's embed/rerank/VL-4B entries in a later arc. |
| D2 | llama-server source | **Stock release + per-host operator override** (a path to a llama-server the operator built). No containers in the model path. |
| D3 | Launch knobs | **Catalog `launch` defaults + per-provider overrides**; one catalog model may be registered more than once under different provider ids (variants). |
| D4 | Remote reach | **Through the gateway only.** Models stay loopback; remote instances and pi-lab call the owning gateway's `/llm/v1`. |
| D5 | Extensions UX | **One "Local models" card** linking to the Model Catalog page; model bundle cards disappear. Non-model AI bundles (Ollama, LocalAI, SDXL, Kokoro, faster-whisper) stay. |
| D6 | Existing weights | **Adopt in place** by sha256 (size-only match allowed, labelled unverified); registry entries may point outside the blob dir. |
| D7 | Fleet scope | **Crow primary first, fleet-ready design.** grackle's vLLM bundles stay until a follow-up arc. |
| D8 | pi-lab | **Gateway lifecycle API; the pi-lab change is in this arc's scope.** |
| D9 | Bundle fate | **Delete crow's model bundles after migration.** Correction accepted in §7: the orchestrator's docker branch and the `inference: true` contract stay until the fleet arc, because grackle's gateway still starts its specialists with them. |
| D10 | Arc shape | **Incremental cutover by provider role** (embed → voice → chat → 27B variants → gemma → retire), each inside a registered reservation window, bundle branch as rollback. |
| D11 | Registry key | `<catalogId>@<quant>`; vision models join the chat mutex group by default. |
| D12 | Voice quant (2026-09-05) | **Q8_0** for crow-voice (the bundle served BF16; Q4_K_XL stays the fresh-install default). |
| D13 | wayfinder-embed (2026-09-05) | **Not adopted.** It stays r4's own launcher. |
| D14 | Gemma embedding (2026-09-05) | **EmbeddingGemma-300M joins the catalog** as an optional alternative to Qwen3-Embedding-0.6B (`ggml-org/embeddinggemma-300M-GGUF`, Q8_0, ungated, Gemma license; byte-identical to the file r4 runs). Same vector space caveat as any embedding change: switching the fleet embedder re-embeds; it is offered, not made the default. |

## 3. Data model

### 3.1 Catalog `launch` block (per model, optional)

```jsonc
"launch": {
  "ctx": 262144,            // -c            integer, 1024..context_len
  "ngl": 999,               // -ngl          integer >= 0
  "flash_attn": "on",       // -fa           "on" | "off" | "auto"
  "parallel": 1,            // -np           integer >= 1
  "no_mmap": true,          // --no-mmap     boolean
  "kv_type": "q8_0",        // -ctk/-ctv     one of llama.cpp's cache types; optional
  "spec": { "type": "draft-mtp", "draft_n_max": 2 },   // --spec-type / --spec-draft-n-max; optional
  "sampling": { "temp": 1.0, "top_p": 0.95, "top_k": 20, "min_p": 0.0, "presence_penalty": 0.0 },
  "extra_args": ["--pooling", "mean", "-b", "4096", "-ub", "4096"]
}
```

Validator rules (`scripts/validate-model-catalog.js`): every knob typed and ranged as above;
`ctx <= context_len`; `spec` requires an `mtp` companion or the `mtp` tag (in-gguf MTP); `extra_args`
is an array of strings and MUST NOT contain any flag the orchestrator owns: `-m`, `--model`,
`--alias`, `--port`, `--host`, `-c`, `--ctx-size`, `--mmproj`, `--embedding`, `--reranking`,
`--jinja`, nor any knob the block already renders (`-ngl`, `-fa`, `-np`, `--no-mmap`, `-ctk`,
`-ctv`, `--spec-type`, `--spec-draft-n-max`, `--temp`, `--top-p`, `--top-k`, `--min-p`,
`--presence-penalty`). Absent knobs render nothing (today's behavior).

The ten curated entries receive the values now in the composes: 35B (ctx 262144, np 1, fa on,
no_mmap, spec draft-mtp n2); 27B (ctx 262144, fa on, kv q8_0, no_mmap, np 1, spec draft-mtp n4,
Qwen thinking-mode sampling); embed (ctx 32768, parallel 8, `--pooling mean -b 4096 -ub 4096`);
4B voice (ctx 32768, fa on); gemma (ctx 8192, `--reasoning-budget 0`); Flash-Next, GLM-5.3-Flash,
DSv4-Flash (ctx as bench notes; `spec` where the companion exists).

**New catalog entry (D14):** `embeddinggemma-300m` — family `gemma3`, lab Google, `hf_repo`
`ggml-org/embeddinggemma-300M-GGUF`, license `gemma`, `gated: false`, `task: embedding`,
`context_len: 2048`, quant `Q8_0` (`embeddinggemma-300M-Q8_0.gguf`, 333,590,944 bytes, sha256
`b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63`), tags `small, embedding,
cpu-capable, alternative`, `launch: {ctx: 2048}` with **no pooling flag** (the GGUF declares mean
pooling and llama.cpp honours it; overriding it changes the vectors). Dimensions 768. Notes state
it is the optional alternative to `qwen3-embedding-0.6b` and that switching embedders re-embeds.

### 3.2 Provider row (`providers.gpu_policy`, JSON)

Existing fields stay: `runtime: "native"`, `mutexGroup`, `alwaysResident`, `defaultMember`,
`local_only`. New fields:

| field | meaning |
|---|---|
| `catalogId`, `quant` | registry key `<catalogId>@<quant>`; decouples provider id from model id |
| `launch` | override object, same shape as §3.1, merged over the catalog defaults at start |
| `port` | the loopback port the native process binds (was parsed from `base_url`) |
| `owner` | instance id of the host that orchestrates this row |

`base_url` for a native row is the **owning gateway's door**:
`http://<owner tailnet ip>:<gateway port>/llm/v1` (`CROW_GATEWAY_PORT`, default 3001). Hosts with no
tailnet address fall back to `http://127.0.0.1:<gateway port>/llm/v1` and the row is marked
`local_only: true` so it does not replicate. `models[0].id` stays the bare model id (the
llama-server alias), so the identity probe and every existing consumer keep working.

`registerModel(modelId, opts)` gains `providerId` (default `modelId`), `launch`, `mutexGroup`,
`alwaysResident`, `defaultMember`. Default mutex assignment is task-based: `chat` and `vision` join
the host's chat group (`pickChatMutexGroup`, unchanged: the largest existing chat group, else
`local-llm`); `embedding` and `rerank` get none. Registering onto an existing **bundle** row of the
same provider id converts it: `bundle_id → null`, `gpu_policy` set, `base_url` set to the door; the
prior row is snapshotted to `state.json.conversions[providerId]` for rollback.

### 3.3 Registry (`<CROW_HOME>/models/state.json`)

`registry` keys become `<catalogId>@<quant>`; a loader migration renames today's `<modelId>` keys
once, idempotently (the entry already carries `catalogId` and `quant`). New per-entry fields:
`path` (absolute; default `blobs/<file>`), `companions[].path`, `adopted: true`, `verified:
false` for size-only adoption. Unregistering an adopted entry never unlinks files. The
`reservations` map is keyed by provider id (unchanged) and stores the port a provider owns.

### 3.4 Runtime override (host-local)

`state.json.runtimeOverride: { bin, label, version, setAt }`. Bootstrapped from
`CROW_LLAMA_SERVER_BIN` when set and no record exists. Never replicates (it lives in the state file,
not the DB). When present, every native start on the host uses it; `ensureRuntime` is skipped; the
`min_runtime_version` gate is skipped with a visible warning in the panel and the start log.

## 4. Orchestrator

- `buildLlamaServerArgs({ggufPath, alias, port, host, launch, extraFlags})` renders identity flags,
  then each present knob (`-c`, `-ngl`, `-fa`, `-np`, `--no-mmap`, `-ctk/-ctv`, `--spec-type`,
  `--spec-draft-n-max`, sampling), then `launch.extra_args`, then the existing companion/task flags.
  Precedence: catalog `launch` → provider `gpu_policy.launch` → nothing else. The rendered argv is
  logged at start and returned in the status snapshot.
- `startNativeAndAwaitReady` resolves weights via `gpu_policy.catalogId@quant` (fallback: provider
  id, for rows registered before this arc), path via `registry.path`, port via `gpu_policy.port`
  (fallback: `portFromBaseUrl`). Probes and forwards to `127.0.0.1:<port>`, never to `base_url`.
- Owner gate: a row whose `gpu_policy.owner` is set and is not this instance is never orchestrated
  here; it is treated as remote. Rows with no `owner` keep today's `base_url`-hostname locality.
- `resolveNativeBinPath` checks `runtimeOverride` first; missing/non-executable override → warn and
  fall back to the pinned release.
- Guard: resolved `ctx > context_len` refuses the start (`CTX_EXCEEDS_MODEL`). No other memory
  guard beyond the existing fit badge (operator's call, as with bundles).
- Mutex/residency mechanics unchanged. Migration sets: crow-chat `{mutexGroup: crow-strix-vram,
  defaultMember: true}`; crow-voice `{alwaysResident: true, mutexGroup: null}`; crow-embed no group;
  27B rows in `crow-strix-vram`, `defaultMember: false`.
- Docker branch (`bundleUp/bundleStop`, docker sibling stop, `resolveWarmableProviderName`) stays
  in this arc (grackle). Its removal is the fleet arc's closing step.

## 5. Gateway doors

### 5.1 Model-addressed `/llm/v1`

Keeps the companion behavior (two aliases, fast/escalate heuristics) unchanged. Adds explicit
addressing: `model` = `<providerId>/<modelId>` forwards to that provider; a bare `<modelId>`
resolves to the enabled local native provider carrying it when unique, else to the one with
`defaultMember: true` in its group, else **400** listing the qualified forms. Forwarding goes to
`127.0.0.1:<gpu_policy.port>` for local rows (no self-hop, no loop); a row owned elsewhere is
forwarded to its own door. `maybeAcquireLocalProvider` runs first; reservation refusals surface as
today (409 `BOX_RESERVED` unless allow-listed). `GET /llm/v1/models` lists every enabled local
native model as `<providerId>/<modelId>` plus the two companion aliases. Auth is unchanged: no
dashboard auth, Funnel rejected, tailnet + loopback binding only (the same exposure the raw bundle
ports had, minus fixed public ports).

### 5.2 Lifecycle API (for programs)

Under `/llm`, authenticated with the **local MCP token** (the credential pi-lab and the board already
hold):

| route | behavior |
|---|---|
| `GET /llm/models` | every local native provider: `{provider, model, quant, status, mutexGroup, wouldEvict[], argv, owner}`; `status ∈ resident, loading, stopped, blocked_by_reservation` |
| `POST /llm/models/:provider/start` | returns `{job_id}` immediately; job states `queued, evicting, starting, resident, failed, blocked_by_reservation` (with the reservation's owner and expiry) |
| `GET /llm/models/jobs/:id` | job state + `cause` (last 40 stderr lines on failure) |
| `POST /llm/models/:provider/stop` | stops the native handle; 409 `NOT_OWNER` (with the owner's door) for rows owned elsewhere |

The dashboard-session routes `POST /api/models/:id/start|stop` stay for the panel.

### 5.3 pi-lab contract (`~/pi-lab`, in scope)

`localModels[]` entries drop `composeDir` and gain `gateway` (door base, e.g.
`http://127.0.0.1:3001`) and `provider`. `lib/local-models.mjs` keeps its exported functions
(`readLocalModels`, `isRunning`, `startModel`, `stopModel`, `wouldEvict`, `annotate`,
`enqueueLifecycle`) so the critic, refute pass and TUI need no change; internally they call §5.2.
`wouldEvict` derives from the gateway's `wouldEvict[]` instead of local `group/evicts`. `startModel`
maps `blocked_by_reservation` to a new `"reserved"` progress stage. `models.json` providers
(`crow-local*`) point at the door with model ids in the qualified form where the bare id is shared
(`crow-local-27b-copilot/qwen3.8-27b`).

## 6. Extensions and Models panel

**Extensions.** The AI group renders no `inference: true` cards. One card, "Local models"
(registered count, resident indicator), links to `/dashboard/model-catalog`; it is produced by
`buildExtensionsHTML` like any other card. `installed.json` entries whose bundle id no longer exists
in the registry render a "retired" chip with an uninstall action (cleanup of stale entries), not a
broken card.

**Model Catalog page.** Additions to the curated and Hugging Face tabs:

- **Registration dialog** (shared by Download, Adopt and HF download): provider id (default model
  id; `crow-chat`/`crow-voice`/`crow-embed` suggested when such a bundle row exists), mutex group
  (existing groups offered), always-resident toggle, launch knobs pre-filled from the catalog.
  Saving creates or converts the row.
- **Adopt from disk**: path field on a curated card; server verifies sha256 against the chosen quant
  (size-only match offered, labelled unverified), registers with `path`, never copies. Same on the
  HF tab for a listed file already on disk.
- **Registered models list**: provider, model, quant, status, mutex group, rendered argv; actions
  start, stop, edit (knobs + residency; a resident model shows "restart to apply"), unregister.
- **Runtime card**: catalog release and asset; override path, `--version`, "Use catalog release"
  reset. Saving an override validates executability and version first.

Every new string ships `en` + `es` (parity gate).

## 7. Migration sequence (each step inside a registered CROW-SCHEDULE window with the box
reservation held; deploys only when `box-reserve.mjs status` shows no reservation)

0. **Replication first.** Find why the 2026-09-04 disables did not reach r4/black-swan/grackle and
   fix it (a conversion must replicate, or remote consumers keep dialing `:8003`). Two-instance test
   proves a disable and a bundle→native conversion both arrive.
1. **crow-embed.** Adopt `hf-cache/qwen3-embedding-0.6b/Qwen3-Embedding-0.6B-Q8_0.gguf`; convert;
   start native; a memory recall embeds through it; stop and remove the container. Proves the
   allow-list exemption on the reservation gate.
2. **crow-voice.** Download the catalog 4B at **Q8_0** (D12; the UD-Q4_K_XL already on disk stays
   registered as the fresh-install default row `qwen3.5-4b`). Convert `crow-voice` with
   `alwaysResident`, no group. Companion and glasses already use `/llm/v1`; unchanged.
3. **crow-chat.** Adopt 35B UD-Q5_K_XL + `mmproj-F16.gguf` from `hf-cache/qwen36-35b-a3b-mtp`;
   launch from §3.1; default member of `crow-strix-vram`. Acceptance: a bot round-trip and
   single-stream code tok/s within 10% of the bundle baseline (~70 tok/s). If the stock release is
   slower or lacks a flag, set the runtime override to an operator build and record which.
4. **27B variants.** Adopt UD-Q6_K_XL + mmproj once; register `crow-local-27b`, `-copilot`, `-512k`
   with per-variant `launch` (512k carries YaRN `extra_args`); retire the raw-port alias rows
   (`crow-local`, `crow-swap-agentic`, `crow-llm` reviewed individually); ship the pi-lab change.
5. **gemma for r4.** Adopt `gemma-4-E2B-it-Q4_0.gguf` from the wayfinder models path;
   `alwaysResident`, no group; r4's `ASK_LLM_URL` moves to the door. `wayfinder-embed` is **not**
   adopted (D13): it keeps serving r4's `kb_embeddings` on `127.0.0.1:3794` from its own compose.
6. **Retire.** Delete `bundles/llamacpp-vulkan-qwen36-35b-a3b`, `vllm-rocm-qwen35-4b`,
   `llamacpp-vulkan-qwen3-embed`, `llamacpp-cpu-qwen3-embed`; regenerate the registry; port table
   rows; their `installed.json` entries and `~/.crow/bundles` copies; the `~/crow-addons` model
   composes; compose-based `localModels` entries. Not deleted (fleet arc): `vllm-cuda-*`, the
   docker branch, the `inference` contract.

Rollback for any step: start the bundle container again and restore the row from
`state.json.conversions[providerId]` (a `scripts/ops/models-migrate.mjs revert <provider>` command).

**Fleet provisions built now, used later:** `linux-x64-cuda` runtime asset slot + resolution
preferring it when the probe reports CUDA and the asset exists; runtime override works on any host
(grackle can point at its own CUDA build); embedding/rerank rows register with no mutex group.

## 8. Error handling

- Launch knobs fail at save (validator message), never at start; a start that dies before readiness
  returns the last 40 stderr lines (`cause`) to the panel and API.
- Adopt: sha mismatch refuses naming the expected quant; size-only registers `verified: false` with
  a badge; a missing path at start → `MODEL_FILE_MISSING`, restart budget not spent.
- Runtime override: non-executable or `--version` failure refused at save; binary gone later → fall
  back to the release with a warning; card shows the fallback.
- Door: ambiguous bare id → 400 with qualified forms; non-owner start → 409 `NOT_OWNER`.
- Lifecycle jobs report `blocked_by_reservation` with owner and expiry.

## 9. Testing

Pure-function seams and stubbed process boundaries, as the repo does today:

- validator: every `launch` rule incl. the owned-flag collision list.
- `buildLlamaServerArgs`: each knob; precedence; a **35B compose-parity fixture** asserting the
  rendered argv equals the retired compose's command list (same for embed and 27B).
- registry key migration: `<modelId>` → `<catalogId>@<quant>`, idempotent.
- adopt: sha match / mismatch / size-only / missing at start (HTTP fixture harness).
- orchestrator (existing stub seams): owner gate never starts a foreign row; door forwarding never
  targets its own `base_url`; override chosen over release and falls back when missing; ctx guard.
- `/llm/v1`: qualified and bare addressing, ambiguity 400, companion aliases unchanged, 409 while
  reserved.
- lifecycle API: MCP-token auth, job states, stop, `NOT_OWNER`, status shape.
- Extensions render: no inference cards; Local models card; retired chip.
- two-instance sync: disable and conversion arrive on the peer.
- panel client contract: registration dialog, knob editor, adopt flow (client JS executed).
- live acceptance per migration step (§7), recorded on the PR as Track 3 was.

## 10. Out of scope (named so they are not lost)

grackle's vLLM specialists and the CUDA asset publication; deleting the orchestrator's docker
branch and the `inference` contract; the 512k-27B bot-model UI exposure beyond registering the row;
the persistent "box reserved" health card; per-bot `X-Crow-Client` from the bridge; MCP OAuth for
remote doors.
