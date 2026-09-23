# Strix Halo runtime profile: a GTT-aware probe, per-model runtime override, gfx1151 launch defaults (design, 2026-09-23)

Strix Halo track, sub-project 3. Source: the decision doc on Gitea,
`backlog/2026-09-22-strix-halo-profile-and-external-engines.md`, which says
"Crow stays generic, with a first-class gfx1151 tier on top", and the
improvement-queue handoff (`docs/superpowers/handoffs/2026-09-23-improvement-queue-handoff.md`).

This spec amends the models-arc spec
(`2026-09-04-models-bundles-to-catalog-design.md`) in two places:
- §3.4, where the runtime override was host-wide only;
- §4, where launch precedence was "catalog → gpu_policy.launch → nothing else".

It is shipped on its own rather than folded into models-arc plans 2 and 3.
Those plans have not started, and none of the three pieces here depends on
their doors, lifecycle API or panels.

Autonomous cycle: the decisions marked **(D#)** are mine, made under Kevin's
standing grant.

## 1. Facts this design rests on (read live on crow, 2026-09-23)

| source | value |
|---|---|
| `vulkaninfo` GPU | `AMD Radeon Graphics (RADV GFX1151)`, `PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU` |
| Vulkan heaps | heap0 41.50 GiB (host), heap1 **83.00 GiB `DEVICE_LOCAL`** |
| `/sys/class/drm/card0/device/mem_info_vram_total` | 536,870,912 B (**512 MiB** BIOS carve-out) |
| `…/mem_info_gtt_total` | 133,143,986,176 B (**126,976 MiB**; kernel `amdgpu.gttsize=126976`) |
| `…/mem_info_gtt_used` | 61.8 GB, with 35b + embed containers resident |
| `/proc/meminfo` | MemTotal 127,941 MiB, MemAvailable ≈ 46 GiB |
| `llama-server --help` (b9172, prod 35b container) | `--op-offload, --no-op-offload` present; the stock pin b10068 is newer |
| crow's native runtime | not currently in use: `state.json` registers `qwen3.5-4b` only, it is not live, and no stock runtime is downloaded. Production models run in containers. |

**What the probe gets wrong today.**
- `probe.vramMb` is RADV's 83 GiB `DEVICE_LOCAL` heap. That is a slice of the
  same unified pool as RAM, not separate VRAM.
- `fitBadge` would add it on top of MemAvailable, and so double-count the same
  memory, for any quant with `min_vram_mb > 0`. It escapes today only because
  every catalog quant has `min_vram_mb: 0`.
- The real single-box ceiling, GTT total, is read nowhere. The only copy is
  the constant `SINGLE_BOX_RAM_MB` in `serving-class.js`.

## 2. Design

### 2.1 Probe: know the host is unified, and read GTT (D1)

Four new fields go on the probe. All are additive, and every existing field
keeps its meaning.

| field | source | null when |
|---|---|---|
| `gpuArch` | `/\bGFX(\d{3,4}[a-z]?)\b/i` on the Vulkan `deviceName` → `"gfx1151"`; else rocminfo's `Name: gfxNNNN` line for the chosen agent | not detected |
| `unified` | When vulkaninfo answered, its `deviceType` decides: `INTEGRATED_GPU` → `true`, `DISCRETE_GPU` → `false`. Any other type, or no Vulkan at all (the rocminfo path), falls back to a sysfs heuristic: an AMD GPU whose amdgpu `mem_info_vram_total` is ≤ 2048 MiB alongside a `mem_info_gtt_total` → `true`, else `false`. | no GPU (and always on darwin) |
| `gttTotalMb`, `gttUsedMb` | `/sys/class/drm/card*/device/mem_info_gtt_{total,used}` of the amdgpu card with the smallest `mem_info_vram_total` that has GTT, i.e. the iGPU | `unified` is not `true`, not amdgpu, or not linux |
| `ramTotalMb` | `/proc/meminfo` `MemTotal` | unreadable |

- `parseVulkaninfo` is extended to also return `deviceType` and to parse the
  arch. The parsers stay pure and exported.
- The sysfs reads go through the injected `fs`, as `readMemAvailable` already
  does. `probe.js` still does not import `gpu-arch.js`, and its header keeps
  giving the reasons.

### 2.2 `fitBadge` on unified memory (D2)

The discrete and unknown paths are byte-identical to today. When
`probe.unified === true`:

- VRAM credit is **never** added on unified memory, which removes the
  double-count.
- **GTT-expanded APU** (`gttTotalMb` known, `ramTotalMb` known, and
  `gttTotalMb >= 0.75 × ramTotalMb`, as on crow with `amdgpu.gttsize`):
  1. `min_ram_mb > gttTotalMb` → `wont_fit`, because it can never run on
     this box. This is checked first: on an idle box MemAvailable can exceed GTT;
  2. `min_ram_mb <= ramAvailableMb` → `fits`;
  3. otherwise → `tight`: it fits the box, but only after other resident
     models are stopped.
- **Every other unified host** (default GTT, e.g. a laptop APU whose GTT is
  half its RAM, or GTT/MemTotal unknown) uses today's formula exactly, minus
  the VRAM credit: `fits` within MemAvailable, `tight` within MemAvailable ×
  1.10, else `wont_fit`. GTT is not a ceiling there, so a quant that fits
  MemAvailable but exceeds a default GTT still reads `fits` (llama.cpp can
  run it partly on CPU).
- Fail-closed rules are unchanged: missing `ramAvailableMb` gives `unknown`.

The "tight widening" (tight now spans everything between MemAvailable and the
GTT ceiling) applies **only to GTT-expanded hosts**. Results on crow today:

- Flash-Next UD-Q4_K_XL (115,068 MiB) moves from `wont_fit` to `tight`. That
  is correct, because it is a `resident`-class model that runs once the 35b
  is evicted.
- GLM UD-IQ4_XS (157,911 MiB) stays `wont_fit`.

The `models.fitTightHint` copy (en and es) gains "may need other models
stopped first", so the one badge truthfully covers both meanings.

**No new badge value (D3).** A fourth value would ripple into `FIT_ORDER`, the
client script and the panel tests for a distinction that the hint text already
carries.

### 2.3 Per-model runtime override (D4)

- `state.json` gains `runtimeOverrides: { [catalogId]: { bin, label, version, setAt } }`.
  It uses the same record shape and the same `validateBinary` (absolute path,
  `X_OK`, `--version` exits 0) as the host override.
- It lives in `state.json` for the same reason as the host override: a binary
  path is host-specific, so it **never replicates**. Putting it in
  `gpu_policy`, which is a synced DB column, would ship crow's paths to peers.
- `runtime-override.js` gains `getModelRuntimeOverride(dir, catalogId)`,
  `setModelRuntimeOverride(dir, catalogId, bin, opts)`,
  `clearModelRuntimeOverride(dir, catalogId)` and `listModelRuntimeOverrides(dir)`.
  The existing host-override functions stay unchanged.
- `resolveNativeBinPath(p, opts)` resolves in this order:
  1. the per-model override for `p.gpuPolicy?.catalogId || <provider name>`,
     if its `bin` exists;
  2. the host override, if its `bin` exists;
  3. the stock catalog release through `ensureRuntime`.

  A missing override `bin` warns once per bin and falls through to the next
  layer, matching today's host-override behaviour.
  - `resolveNativeBinPath` today does not receive the provider name, so it is
    passed in through `opts.providerName` from both callers.
- **Operator surface (D5):** a CLI, `scripts/models-runtime-override.mjs`,
  with the subcommands `list`, `get [--model <id>]`,
  `set --bin <abs> [--model <id>] [--label <s>]` and `clear [--model <id>]`.
  - Without `--model`, the command acts on the host override.
  - It resolves the data dir the same way the gateway does
    (`resolveDataDir()`: `CROW_DATA_DIR`, else `~/.crow/data`); `set` and
    `clear` print the resolved data dir.
  - The CLI is a second writer of `state.json`. After every write it re-reads
    the file and verifies the change landed; on a mismatch it retries once,
    then exits non-zero saying a concurrent gateway write overwrote it. The
    read-back narrows the race but does not close it: a gateway that loaded
    state before the write and saves after the read-back still wins. Verify
    with `get` after the next gateway restart.
  - `list`/`get` never write; `clear` without `--model` does not create or
    write `state.json` when no host override exists. When
    `CROW_LLAMA_SERVER_BIN` is set, host `get`/`clear` warn that the gateway
    will re-bootstrap the host override from it.
  - Deploy note: restart the crow and r4 gateways once after deploying this,
    before the first `set` — an older gateway rewrites `state.json` without
    the unknown `runtimeOverrides` key.
  - A per-model override keyed by `catalogId` applies to every quant/variant
    row of that model. That is intended: pi-lab builds are per model.
  - The dashboard card is models-arc plan 3 and is not built here.
  - This CLI is how pi-lab's pre-merge llama.cpp builds reach a single model,
    which the decision doc requires.
- Like the host override, a per-model override skips `ensureRuntime`, and
  because of that it also skips `min_runtime_version`.

### 2.4 The gfx1151 launch profile (D6)

- A new pure module, `servers/gateway/models/host-profile.js`, exports
  `hostLaunchDefaults(probe)`. It returns
  `{ flash_attn: "on", no_mmap: true, no_op_offload: true }` when
  `probe.gpuArch === "gfx1151"` and `probe.accel === "vulkan"`, and `null`
  otherwise. These are kyuz0's and pi-lab's flags: `-fa 1` is rendered by
  llama.cpp as `-fa on`. Production containers already run `-fa on` for chat
  AND embedding models on this hardware; FA on an unsupported head size falls
  back silently. `--no-op-offload` stays in the profile regardless of `ngl`
  (pi-lab approved it as a default; opt out via `gpu_policy.launch`).
- The orchestrator warms the probe cache in `resolveNativeBinPath`, before any
  override early-return, and the start's critical section only reads the
  cached probe (null → no profile). A warm-up failure is remembered for
  5 minutes: no re-probe inside that window on override starts, and one
  warning per window. The stock path still probes when it needs to.
- **Precedence: host profile < catalog `launch` < provider `gpu_policy.launch` < the jinja layer.**
  - **(D7) The profile is the LOWEST layer.** The spec §4 order is unchanged
    above it: a curated catalog value, or an operator's per-provider value,
    always wins. The profile only fills keys that nobody set.
  - This amends §4's "nothing else" to "a host default underneath".
- New typed launch key `no_op_offload: boolean`.
  - It renders `--no-op-offload` only when `true`.
  - `--op-offload` and `--no-op-offload` join `LAUNCH_OWNED_FLAGS`, so they
    cannot be smuggled in through `extra_args`.
  - A provider opts out with `gpu_policy.launch: { no_op_offload: false }`,
    and likewise with `no_mmap: false` or `flash_attn: "off"`.
- pi-lab's caveats go in the module comment:
  - `--no-op-offload` changes nothing unless weights are host-resident;
  - its measured +18% alone did not include the fork-only `GGML_MOE_PREFETCH`;
  - results match on argmax, not bit for bit.
- The profile applies to native-runtime starts only. Docker bundles build
  their own command lines.

## 3. Out of scope

- The live GTT/MemAvailable **start gate** (two-host spec §6 step 2). The probe
  now carries `gttUsedMb`, which that gate will need, but refusing starts on
  live memory is its own change.
- The dashboard runtime-override card, a per-model override UI, and showing
  the new probe fields in the Health tab. All of these are plan 3.
- ROCm/HIP as a runtime asset. Stock Crow ships Vulkan, and ROCm builds arrive
  through the override.
- `SINGLE_BOX_RAM_MB` stays a catalog-curation constant. It describes the
  hardware class the catalog is curated for, not the host running it.

## 4. Testing

- **Probe parsers:**
  - the crow `vulkaninfo` excerpt → `deviceType` `INTEGRATED_GPU` and `gpuArch` `gfx1151`;
  - a discrete NVIDIA/RADV sample → `unified: false`;
  - a two-card host (iGPU card0 with a 512 MiB carve-out + discrete card1
    with 16 GiB, Vulkan says DISCRETE) → `unified: false`, no GTT fields,
    discrete `fitBadge` unchanged;
  - a ≤ 2 GiB discrete card reported DISCRETE by Vulkan → `unified: false`;
  - sysfs fixtures through an injected `fs`: GTT present, absent, and non-amdgpu;
  - a MemTotal parse.
- **`fitBadge` unified matrix:**
  - under available → `fits`;
  - GTT-expanded crow numbers: Flash-Next 115,068 → `tight`, GLM 157,911 → `wont_fit`;
  - default-GTT laptop APU (GTT 50% of RAM), quant within MemAvailable but
    above GTT → `fits`;
  - GTT or MemTotal unknown → today's 10% band without VRAM credit;
  - `min_vram_mb > 0` on unified never adds VRAM;
  - the discrete cases are unchanged: the existing tests stay green.
- **Per-model override:**
  - set, get, list and clear round-trip through `state.json`;
  - `validateBinary` errors (reuse the host-override tests' fake binaries);
  - `resolveNativeBinPath` order: per-model > host > stock, including the
    missing-bin fall-through for each layer.
- **CLI:** `list`, `set` and `clear` against a temp `CROW_DATA_DIR`; verify-after-write retry and the concurrent-overwrite failure; host `clear` with nothing set writes nothing.
- **Launch:**
  - `validateLaunch` accepts `no_op_offload` and rejects a non-boolean;
  - `extra_args` containing `--no-op-offload` is refused;
  - `renderLaunchArgs` emits it;
  - `hostLaunchDefaults` covers gfx1151 vulkan, gfx1151 cpu, another arch, and a null probe;
  - the orchestrator start args, through the existing native harness: the
    profile fills unset keys, the catalog wins over the profile, and
    gpu_policy `no_op_offload:false` suppresses the flag.
