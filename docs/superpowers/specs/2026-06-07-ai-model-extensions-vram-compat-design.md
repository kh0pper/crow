# AI Model Bundles → Extensions, with gfx1151 Tags + VRAM-Aware Compatibility

**Date:** 2026-06-07
**Status:** Design approved; pending spec review → implementation plan
**Scope:** Sub-project #1 of 2. (Sub-project #2 — a user-facing port registry — is a separate brainstorm, deferred per sequencing decision.)

## Problem

The local AI model-serving bundles that exist on disk under `bundles/` are not all listed in `registry/add-ons.json`, so they never appear in the dashboard Extensions page and cannot be installed one-click. Nine AI bundles are missing: the two CPU voice servers (`kokoro-tts` TTS, `faster-whisper-server` STT) and seven ROCm model bundles.

Separately, the Extensions page's hardware-compatibility detector (`checkGpuArchCompatible` in `servers/gateway/gpu-arch.js`) only matches GPU *architecture* tags. It ignores `min_vram_gb` entirely (the field is not even rendered), so a host with any matching-arch GPU sees huge models as "compatible" even when they cannot fit.

## Goals

1. List all nine unregistered AI model bundles in `registry/add-ons.json` so they install one-click.
2. Make the compatibility detector meaningful for these models:
   - Tag the ROCm bundles with the *specific* `gfx1151` arch they are actually built for (not the permissive `rocm` family), and tighten the four already-registered ROCm bundles to match.
   - Add **VRAM-aware gating**: detect host VRAM and show an "insufficient VRAM" result when `min_vram_gb` exceeds it.
3. Keep CI green — document the two new published host ports in `docs/developers/port-allocation.md` (the port-allocation check currently fails without this).

## Non-goals / out of scope

- **User-facing port registry / reassignment** — separate sub-project (#2), brainstormed next.
- **CUDA bundles** (`vllm`, `sdxl`, `vllm-cuda-*`) — already registered with `["cuda"]`; correct for NVIDIA hosts, left unchanged.
- **WIP/uncommitted bundles** (`capstone-tracker`, `fed-gov-data`, `knowledge-base-mcp`, `texas-gov-data`) and `campaigns` (social MCP, not a model) — excluded. Note: `capstone-tracker :8090` independently fails the port-allocation check today; not ours to fix here, flagged to its owner.
- **Orchestrator swap-group / mutex changes** — the ROCm model bundles publish *no* host port; their `:800x` service ports are orchestrator-routed and mutexed via `crow-strix-vram`. Listing them does not change that.

## Verified facts (basis for the values below)

- `rocminfo` on crow reports the GPU agent (`Name: gfx1151`) with a `Segment: GLOBAL` `COARSE GRAINED` pool of `130023424 KB ≈ 124 GB` (unified-memory/GTT ceiling). This is the VRAM-detection anchor. All nine models' `min_vram_gb` (max = Kimi at 110) fit under 124, so none is falsely excluded on crow.
- The ROCm model bundles' compose files publish **no** host ports (CI port check finds none); only `kokoro-tts` (`:8880`) and `faster-whisper-server` (`:8004`) publish real host ports among our nine.
- `min_vram_gb` values are taken verbatim from each bundle's committed `manifest.json`, not estimated.

## Design

### 1. Registry entries (`registry/add-ons.json`)

Add nine entries modeled on the existing `llamacpp-vulkan-qwen36-35b-a3b` entry schema: `id`, `name`, `version` (`"1.0.0"`), `description`, `type:"bundle"`, `category:"ai"`, `tags`, `icon:"cpu"`, `host:"local"`, `port`, `providers` (only where the manifest declares them), and `requires`.

`requires` per bundle:

| Bundle | gpu | gpu_arch | min_vram_gb | min_ram_mb | min_disk_mb | port | providers |
|---|---|---|---|---|---|---|---|
| `kokoro-tts` | — | — (CPU) | — | 1024* | 2000* | 8880 | — |
| `faster-whisper-server` | — | — (CPU) | — | 2048* | 4000* | 8004 | — |
| `vllm-rocm-qwen3` | true | `["gfx1151"]` | 12 | — | — | 8001 | — |
| `vllm-rocm-qwen35-4b` | true | `["gfx1151"]` | 12 | — | — | 8011 | crow-voice/qwen3.5-4b |
| `vllm-rocm-qwen3-32b` | true | `["gfx1151"]` | 80 | — | — | 8002 | — |
| `vllm-rocm-qwen35-27b` | true | `["gfx1151"]` | 80 | — | — | 8012 | crow-chat/qwen3.5-27b |
| `llamacpp-vulkan-qwen3-embed` | true | `["gfx1151"]` | 2 | — | — | 8004 | crow-embed/qwen3-embedding-0.6b |
| `llamacpp-qwen72b` | true | `["gfx1151"]` | 60 | — | — | 8003 | — |
| `vllm-rocm-kimi` | true | `["gfx1151"]` | 110 | — | — | 8003 | — |

`*` = derived estimate (model + image footprint), not a fabricated vendor spec; flagged as such in the entry note. The ROCm rows omit `min_ram_mb`/`min_disk_mb`, matching the existing registered model-bundle convention (which carries only `gpu`/`gpu_arch`/`min_vram_gb`).

**Tighten existing ROCm bundles** from `["rocm"]` → `["gfx1151"]`, in both the `registry/add-ons.json` entry and the on-disk `bundles/<id>/manifest.json`, for accuracy + consistency:
- `llamacpp-rocm-qwen35-122b-mtp`
- `llamacpp-vulkan-glm-45-air`
- `llamacpp-vulkan-qwen3-coder`
- `llamacpp-vulkan-qwen36-35b-a3b`

The two unregistered ROCm bundles whose manifests already say `["rocm"]` (`vllm-rocm-qwen35-27b`, `vllm-rocm-qwen35-4b`) likewise get `["gfx1151"]` in both manifest and new registry entry.

No install-flow code changes: `bundles.js` already reads each on-disk manifest, runs compose, opens/closes firewall ports, and seeds/unseeds `ttsProfileSeed`/`sttProfileSeed`. The bundles are invisible today *only* because they lack a registry entry.

### 2. VRAM detection (`servers/gateway/gpu-arch.js`)

Add `detectGpuVramGb({ refresh } = {})` returning host total VRAM in GB, or `null` when no GPU is detected. Cached like `cachedHostArches`.

- **ROCm**: parse `rocminfo` with a per-agent state machine. On each `Agent N` boundary reset; when an agent's `Name:` matches `gfx[0-9a-f]+`, mark it a GPU agent and capture the largest `Size: <n> KB` line under its `Segment: GLOBAL` pools; convert KB→GB. (On crow → ~124 GB.)
- **NVIDIA**: `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` (MiB→GB); take the max across GPUs.
- Same `resolveBinary` lookup already used for `rocminfo`/`nvidia-smi`.

### 3. Compatibility check + UI (`gpu-arch.js` + `servers/gateway/dashboard/panels/extensions.js`)

Extend `checkGpuArchCompatible(manifest, hostArches, hostVramGb)` (add an optional VRAM arg; default to `detectGpuVramGb()`):
- Run the existing arch match first. If it fails, return as today (`ok:false`, arch reason).
- If arch passes AND `manifest.requires.min_vram_gb` is set AND `hostVramGb` is a known number AND `hostVramGb < min_vram_gb`: return `{ ok:false, kind:"vram", reason:`Requires ~${min_vram_gb} GB VRAM; host has ~${hostVramGb} GB`, requiredVramGb, detectedVramGb }`.
- If host VRAM is unknown (`null` — detection failed or CPU-only host): **fail open** (arch-only result). Never hide an installable model on a probe miss.
- Gate on **total** VRAM (capacity question), not fluctuating free VRAM.

In `extensions.js`:
- Call `detectGpuVramGb()` once alongside `detectGpuArch()` and pass it in.
- Render the VRAM failure with a distinct **"insufficient VRAM"** badge + reason tooltip, so it reads differently from the existing "incompatible host" (arch) badge.
- Render `min_vram_gb` as a resource chip in `formatResources()` and in the modal (currently only `min_ram_mb`/`min_disk_mb` are shown).

### 4. Port documentation (`docs/developers/port-allocation.md`)

Add allocation-table rows so the CI port-allocation check passes:

| Port | Binding | Bundle / Service | Status |
|---|---|---|---|
| 8004 | 127.0.0.1 | faster-whisper-server (local STT) | existing |
| 8880 | 127.0.0.1 | kokoro-tts (local TTS) | existing |

### 5. Testing

- New unit test for the `rocminfo` VRAM parser against a fixture of the real captured output → asserts `gfx1151` detected and ≈124 GB.
- `checkGpuArchCompatible` cases: arch-pass + VRAM-pass; arch-pass + VRAM-fail; arch-fail (VRAM irrelevant); VRAM-unknown → fail-open; CPU bundle (no gpu requirement) → always ok.
- `node scripts/check-port-allocation.js` exits 0 for our ports (8090/capstone-tracker remains pre-existing/not-ours).
- Confirm the gateway boots clean (`node servers/gateway/index.js --no-auth`).
- No change to the network-exposure invariant, so `tests/auth-network.test.js` is not required by this work, but will be left passing.

## Known issues to carry into sub-project #2 (port registry)

- `faster-whisper-server` and `llamacpp-vulkan-qwen3-embed` both target host port **8004** (faster-whisper publishes it; embed's manifest claims it but publishes no host mapping). They cannot run simultaneously. CI does not catch this because embed publishes no docker host port. This is exactly the kind of latent conflict a user-facing port registry should surface and let the user reassign.

## Files

- **New:** none for #1 beyond test files; this design doc.
- **Modify:** `registry/add-ons.json` (9 new entries + 4 tightened), `bundles/{llamacpp-rocm-qwen35-122b-mtp,llamacpp-vulkan-glm-45-air,llamacpp-vulkan-qwen3-coder,llamacpp-vulkan-qwen36-35b-a3b,vllm-rocm-qwen35-27b,vllm-rocm-qwen35-4b}/manifest.json` (gpu_arch → gfx1151), `servers/gateway/gpu-arch.js` (VRAM detect + check), `servers/gateway/dashboard/panels/extensions.js` (call + render), `docs/developers/port-allocation.md` (2 rows).
- **Reuse (unchanged):** `routes/bundles.js` install flow, `ai/{stt,tts}` adapters + profile seeding, the registry-merge catalog logic in `extensions.js`.
