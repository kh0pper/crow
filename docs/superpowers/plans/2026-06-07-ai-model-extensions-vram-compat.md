# AI Model Bundles → Extensions, with gfx1151 Tags + VRAM-Aware Compatibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List the nine unregistered local AI model bundles in the Extensions registry and make the page's hardware-compatibility detector VRAM-aware, with gfx1151-specific GPU arch tags.

**Architecture:** Pure parser functions in `servers/gateway/gpu-arch.js` (unit-tested against captured `rocminfo`/`nvidia-smi` fixtures) feed a new `detectGpuVramGb()` and an extended `checkGpuArchCompatible()`. The dashboard panel `extensions.js` calls these and renders a distinct "insufficient VRAM" badge. Registry/manifest edits are data-only; the existing `bundles.js` install flow already handles compose + firewall + STT/TTS profile seeding.

**Tech Stack:** Node.js (ES modules), `node:test`, Express dashboard panels rendering HTML strings, JSON registry/manifests, Docker Compose bundles.

**Spec:** `docs/superpowers/specs/2026-06-07-ai-model-extensions-vram-compat-design.md`

**Branch:** Create `feat/ai-model-extensions-vram-compat` before Task 1. Do NOT implement on `main`.

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

Run:
```bash
cd /home/kh0pp/crow
git pull --rebase
git checkout -b feat/ai-model-extensions-vram-compat
```
Expected: switched to a new branch.

---

### Task 1: VRAM parsers + `detectGpuVramGb()` in gpu-arch.js

**Files:**
- Modify: `servers/gateway/gpu-arch.js`
- Test: `tests/gpu-arch-vram.test.js` (create)
- Modify: `package.json` (add `test:gpu-vram` script)

- [ ] **Step 1: Write the failing test**

Create `tests/gpu-arch-vram.test.js`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRocminfoArches,
  parseRocminfoVramGb,
  parseNvidiaSmiVramGb,
} from "../servers/gateway/gpu-arch.js";

// Trimmed real `rocminfo` output from crow: CPU agent (larger pool), the
// gfx1151 GPU agent (124 GB pool), and the NPU agent. The parser must anchor
// VRAM to the GPU agent only — NOT the CPU agent's larger GLOBAL pool.
const ROCMINFO_FIXTURE = `
Agent 1
  Name:                    AMD RYZEN AI MAX+ 395 w/ Radeon 8060S
  Vendor Name:             CPU
  Pool Info:
      Segment:                 GLOBAL; FLAGS: FINE GRAINED
      Size:                    131011452(0x7cf137c) KB
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    131011452(0x7cf137c) KB
Agent 2
  Name:                    gfx1151
  Vendor Name:             AMD
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    130023424(0x7c00000) KB
      Segment:                 GROUP
      Size:                    64(0x40) KB
Agent 3
  Name:                    aie2p
  Vendor Name:             AMD
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    131011452(0x7cf137c) KB
`;

test("parseRocminfoArches: finds gfx1151 only", () => {
  assert.deepEqual(parseRocminfoArches(ROCMINFO_FIXTURE), ["gfx1151"]);
});

test("parseRocminfoVramGb: anchors to GPU agent (124 GB, not CPU's 125)", () => {
  assert.equal(parseRocminfoVramGb(ROCMINFO_FIXTURE), 124);
});

test("parseRocminfoVramGb: returns null when no GPU agent present", () => {
  const cpuOnly = `
Agent 1
  Name:                    Some CPU
  Vendor Name:             CPU
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    131011452(0x7cf137c) KB
`;
  assert.equal(parseRocminfoVramGb(cpuOnly), null);
});

test("parseNvidiaSmiVramGb: MiB rows -> max GB", () => {
  assert.equal(parseNvidiaSmiVramGb("16384\n24576\n"), 24);
});

test("parseNvidiaSmiVramGb: empty -> null", () => {
  assert.equal(parseNvidiaSmiVramGb(""), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/gpu-arch-vram.test.js`
Expected: FAIL — the named exports `parseRocminfoArches` / `parseRocminfoVramGb` / `parseNvidiaSmiVramGb` do not exist yet (import error / undefined).

- [ ] **Step 3: Add the parsers and detector to gpu-arch.js**

In `servers/gateway/gpu-arch.js`, add these exports (place after the `FAMILY_MEMBERS` const and before `detectGpuArch`):

```javascript
/**
 * Pure parser: extract gfxNNNN arch tags from rocminfo text. CPU agents carry a
 * marketing name (no gfx token), so a bare `Name: gfxNNNN` match is unambiguous.
 */
export function parseRocminfoArches(text) {
  const tags = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*Name:\s*(gfx[0-9a-f]+)\s*$/);
    if (m) tags.add(m[1]);
  }
  return [...tags];
}

/**
 * Pure parser: total GPU VRAM in GB from rocminfo text. Per-agent state machine
 * that captures the largest `Segment: GLOBAL` pool size ONLY for GPU agents
 * (those whose `Name:` is gfxNNNN), so the CPU agent's (often larger) system-RAM
 * pool is never mistaken for VRAM. On a unified-memory APU this is the GTT/UMA
 * ceiling. Returns null if no GPU agent is found.
 */
export function parseRocminfoVramGb(text) {
  let inGpuAgent = false;
  let inGlobalSegment = false;
  let maxKb = 0;
  for (const line of text.split("\n")) {
    if (/^\s*Agent\s+\d+/.test(line)) {
      inGpuAgent = false;
      inGlobalSegment = false;
      continue;
    }
    if (/^\s*Name:\s*gfx[0-9a-f]+\s*$/.test(line)) {
      inGpuAgent = true;
      continue;
    }
    if (!inGpuAgent) continue;
    if (/^\s*Segment:\s*GLOBAL/.test(line)) {
      inGlobalSegment = true;
      continue;
    }
    if (/^\s*Segment:/.test(line)) {
      inGlobalSegment = false;
      continue;
    }
    if (inGlobalSegment) {
      const m = line.match(/^\s*Size:\s*(\d+)\b.*KB/);
      if (m) maxKb = Math.max(maxKb, parseInt(m[1], 10));
    }
  }
  if (maxKb <= 0) return null;
  return Math.round(maxKb / 1024 / 1024); // KB -> GB
}

/**
 * Pure parser: max GPU memory in GB from `nvidia-smi --query-gpu=memory.total
 * --format=csv,noheader,nounits` output (one integer MiB per GPU line).
 */
export function parseNvidiaSmiVramGb(text) {
  let maxMib = 0;
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)$/);
    if (m) maxMib = Math.max(maxMib, parseInt(m[1], 10));
  }
  if (maxMib <= 0) return null;
  return Math.round(maxMib / 1024); // MiB -> GB
}

/** Cached host VRAM (GB), populated on first call. null = no GPU / unknown. */
let cachedVramGb = null;
let vramProbed = false;

/**
 * Detect total host GPU VRAM in GB (ROCm first, then NVIDIA). Returns null when
 * no GPU is present or detection fails — callers MUST treat null as "unknown"
 * and fail open (do not block install on a probe miss).
 */
export function detectGpuVramGb({ refresh = false } = {}) {
  if (vramProbed && !refresh) return cachedVramGb;
  let gb = null;
  try {
    const out = execFileSync(ROCMINFO, [], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" });
    gb = parseRocminfoVramGb(out);
  } catch { /* rocminfo missing or no AMD GPU */ }
  if (gb == null) {
    try {
      const out = execFileSync(
        NVIDIASMI,
        ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" },
      );
      gb = parseNvidiaSmiVramGb(out);
    } catch { /* nvidia-smi missing or no NVIDIA GPU */ }
  }
  cachedVramGb = gb;
  vramProbed = true;
  return cachedVramGb;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/gpu-arch-vram.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the npm test script**

In `package.json`, in the `scripts` block alongside the other `test:*` entries, add:
```json
    "test:gpu-vram": "node --test tests/gpu-arch-vram.test.js",
```

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/gpu-arch.js tests/gpu-arch-vram.test.js package.json
git commit servers/gateway/gpu-arch.js tests/gpu-arch-vram.test.js package.json -m "gpu-arch: add VRAM detection parsers + detectGpuVramGb"
git show --stat HEAD | tail -6
```
Expected: exactly 3 files in the commit.

---

### Task 2: VRAM gating in `checkGpuArchCompatible()`

**Files:**
- Modify: `servers/gateway/gpu-arch.js`
- Test: `tests/gpu-arch-vram.test.js` (extend)

- [ ] **Step 1: Add failing tests**

Append to `tests/gpu-arch-vram.test.js`:
```javascript
import { checkGpuArchCompatible } from "../servers/gateway/gpu-arch.js";

const ROCM_HOST = ["gfx1151", "rocm", "cpu"];

test("compat: arch ok + VRAM fits -> ok", () => {
  const m = { requires: { gpu: true, gpu_arch: ["gfx1151"], min_vram_gb: 12 } };
  assert.equal(checkGpuArchCompatible(m, ROCM_HOST, 124).ok, true);
});

test("compat: arch ok + VRAM too small -> not ok, kind vram", () => {
  const m = { requires: { gpu: true, gpu_arch: ["gfx1151"], min_vram_gb: 200 } };
  const r = checkGpuArchCompatible(m, ROCM_HOST, 124);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "vram");
  assert.match(r.reason, /200 GB/);
});

test("compat: arch fails -> not ok, no vram kind (arch checked first)", () => {
  const m = { requires: { gpu: true, gpu_arch: ["gfx1151"], min_vram_gb: 8 } };
  const r = checkGpuArchCompatible(m, ["sm_86", "cuda", "cpu"], 8);
  assert.equal(r.ok, false);
  assert.notEqual(r.kind, "vram");
});

test("compat: VRAM unknown (null) -> fail open", () => {
  const m = { requires: { gpu: true, gpu_arch: ["gfx1151"], min_vram_gb: 999 } };
  assert.equal(checkGpuArchCompatible(m, ROCM_HOST, null).ok, true);
});

test("compat: CPU bundle (no gpu requirement) -> always ok", () => {
  const m = { requires: { platform: "linux-x86_64" } };
  assert.equal(checkGpuArchCompatible(m, ["cpu"], null).ok, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/gpu-arch-vram.test.js`
Expected: FAIL — the "VRAM too small" test fails because `checkGpuArchCompatible` currently ignores `min_vram_gb` (returns `ok:true`).

- [ ] **Step 3: Refactor `checkGpuArchCompatible` to add VRAM gating**

In `servers/gateway/gpu-arch.js`, replace the entire existing `checkGpuArchCompatible` function with:
```javascript
/**
 * Arch-only compatibility (the pre-VRAM logic). Internal.
 */
function checkArchOnly(manifest, hostArches) {
  const required = manifest?.requires?.gpu_arch;
  const requiresGpu = Boolean(manifest?.requires?.gpu);

  if (!requiresGpu && (!required || required.length === 0)) {
    return { ok: true };
  }
  if (requiresGpu && (!required || required.length === 0)) {
    const hasGpu = hostArches.some((t) => t !== "cpu");
    return hasGpu
      ? { ok: true }
      : { ok: false, reason: "Bundle requires a GPU, but none was detected.", detected: hostArches };
  }
  const hostSet = new Set(hostArches);
  for (const tag of required) {
    if (hostSet.has(tag)) return { ok: true };
    const family = FAMILY_MEMBERS[tag];
    if (family && hostArches.some(family)) return { ok: true };
  }
  return {
    ok: false,
    reason: `Bundle requires GPU arch in [${required.join(", ")}]; host has [${hostArches.join(", ")}].`,
    required,
    detected: hostArches,
  };
}

/**
 * Check whether a manifest's GPU requirements are satisfiable on this host.
 * Arch is checked first; only on an arch match is VRAM considered. When host
 * VRAM is unknown (null), VRAM gating is skipped (fail open).
 * Returns { ok: bool, reason?, kind?, required?, detected?, requiredVramGb?, detectedVramGb? }.
 */
export function checkGpuArchCompatible(manifest, hostArches = detectGpuArch(), hostVramGb = detectGpuVramGb()) {
  const archResult = checkArchOnly(manifest, hostArches);
  if (!archResult.ok) return archResult;

  const minVram = manifest?.requires?.min_vram_gb;
  if (minVram && typeof hostVramGb === "number" && hostVramGb < minVram) {
    return {
      ok: false,
      kind: "vram",
      reason: `Requires ~${minVram} GB VRAM; host has ~${hostVramGb} GB.`,
      requiredVramGb: minVram,
      detectedVramGb: hostVramGb,
    };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/gpu-arch-vram.test.js`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/gpu-arch.js tests/gpu-arch-vram.test.js
git commit servers/gateway/gpu-arch.js tests/gpu-arch-vram.test.js -m "gpu-arch: VRAM-aware compatibility gating (arch-first, fail-open on unknown)"
git show --stat HEAD | tail -5
```
Expected: exactly 2 files.

---

### Task 3: Wire VRAM compat into the Extensions panel

**Files:**
- Modify: `servers/gateway/dashboard/panels/extensions.js`

No unit test (the panel renders HTML strings); the compat logic itself is covered by Task 2. Verification is by gateway boot in Task 6.

- [ ] **Step 1: Import `detectGpuVramGb`**

In `servers/gateway/dashboard/panels/extensions.js`, line 12 currently reads:
```javascript
import { detectGpuArch, checkGpuArchCompatible } from "../../gpu-arch.js";
```
Change to:
```javascript
import { detectGpuArch, checkGpuArchCompatible, detectGpuVramGb } from "../../gpu-arch.js";
```

- [ ] **Step 2: Detect VRAM once and pass it to the check**

Around line 675, the code reads:
```javascript
      const hostArches = detectGpuArch();
```
Change to:
```javascript
      const hostArches = detectGpuArch();
      const hostVramGb = detectGpuVramGb();
```

Then at the compat call (around line 690):
```javascript
        const gpuCompat = checkGpuArchCompatible(addon, hostArches);
```
Change to:
```javascript
        const gpuCompat = checkGpuArchCompatible(addon, hostArches, hostVramGb);
```

- [ ] **Step 3: Render a distinct "insufficient VRAM" badge**

The incompatible branch (around lines 693-695) reads:
```javascript
        } else if (!gpuCompat.ok) {
          const tip = `${gpuCompat.reason || "Incompatible GPU arch."}`;
          installButton = `<span class="ext-card__badge ext-card__badge--type" title="${escapeHtml(tip)}" style="opacity:0.85">incompatible host</span>`;
        } else {
```
Change to:
```javascript
        } else if (!gpuCompat.ok) {
          const tip = `${gpuCompat.reason || "Incompatible GPU arch."}`;
          const label = gpuCompat.kind === "vram" ? "insufficient VRAM" : "incompatible host";
          installButton = `<span class="ext-card__badge ext-card__badge--type" title="${escapeHtml(tip)}" style="opacity:0.85">${label}</span>`;
        } else {
```

- [ ] **Step 4: Render `min_vram_gb` as a resource chip (card)**

`formatResources(requires)` builds a plain-text `parts` array joined by ` · `. The `min_disk_mb` block reads:
```javascript
  if (requires.min_disk_mb) {
    const disk = requires.min_disk_mb >= 1024
      ? `${(requires.min_disk_mb / 1024).toFixed(0)}GB`
      : `${requires.min_disk_mb}MB`;
    parts.push(`${disk} disk`);
  }
```
Immediately after that `if` block (before the `return`), add:
```javascript
  if (requires.min_vram_gb) {
    parts.push(`${requires.min_vram_gb}GB VRAM`);
  }
```

- [ ] **Step 5: Render `min_vram_gb` chip in the modal**

The modal requirements block (around line 1435) is gated by:
```javascript
          var req = addon.requires || {};
          if (req.min_ram_mb || req.min_disk_mb || req.gpu) {
```
Widen the gate to include VRAM:
```javascript
          var req = addon.requires || {};
          if (req.min_ram_mb || req.min_disk_mb || req.gpu || req.min_vram_gb) {
```
Then, immediately after the `diskChip` block:
```javascript
            if (req.min_disk_mb) {
              var diskChip = document.createElement("span");
              diskChip.className = "ext-detail__req-chip";
              diskChip.textContent = (req.min_disk_mb >= 1024 ? Math.floor(req.min_disk_mb / 1024) + "GB" : req.min_disk_mb + "MB") + " disk";
              reqWrap.appendChild(diskChip);
            }
```
add the VRAM chip (same `ext-detail__req-chip` pattern), before the `if (req.gpu)` block:
```javascript
            if (req.min_vram_gb) {
              var vramChip = document.createElement("span");
              vramChip.className = "ext-detail__req-chip";
              vramChip.textContent = req.min_vram_gb + "GB VRAM";
              reqWrap.appendChild(vramChip);
            }
```

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/panels/extensions.js
git commit servers/gateway/dashboard/panels/extensions.js -m "extensions panel: VRAM-aware compat badge + min_vram_gb chips"
git show --stat HEAD | tail -4
```
Expected: exactly 1 file.

---

### Task 4: Tighten on-disk manifests to gfx1151

**Files:**
- Modify: `bundles/llamacpp-rocm-qwen35-122b-mtp/manifest.json`
- Modify: `bundles/llamacpp-vulkan-glm-45-air/manifest.json`
- Modify: `bundles/llamacpp-vulkan-qwen3-coder/manifest.json`
- Modify: `bundles/llamacpp-vulkan-qwen36-35b-a3b/manifest.json`
- Modify: `bundles/vllm-rocm-qwen35-27b/manifest.json`
- Modify: `bundles/vllm-rocm-qwen35-4b/manifest.json`

- [ ] **Step 1: Change each manifest's `gpu_arch`**

In each of the six files above, the `requires.gpu_arch` currently is:
```json
      "gpu_arch": [
        "rocm"
      ]
```
Change the value to:
```json
      "gpu_arch": [
        "gfx1151"
      ]
```
(Only the array contents change: `"rocm"` → `"gfx1151"`. Leave `gpu`, `min_vram_gb`, `platform` untouched.)

- [ ] **Step 2: Verify all six are valid JSON and updated**

Run:
```bash
cd /home/kh0pp/crow
for b in llamacpp-rocm-qwen35-122b-mtp llamacpp-vulkan-glm-45-air llamacpp-vulkan-qwen3-coder llamacpp-vulkan-qwen36-35b-a3b vllm-rocm-qwen35-27b vllm-rocm-qwen35-4b; do
  node -e "const m=require('./bundles/$b/manifest.json'); if(JSON.stringify(m.requires.gpu_arch)!=='[\"gfx1151\"]'){console.error('BAD',\"$b\",m.requires.gpu_arch);process.exit(1)} console.log('ok','$b')"
done
```
Expected: `ok` for all six, no `BAD`.

- [ ] **Step 3: Commit**

```bash
git add bundles/llamacpp-rocm-qwen35-122b-mtp/manifest.json bundles/llamacpp-vulkan-glm-45-air/manifest.json bundles/llamacpp-vulkan-qwen3-coder/manifest.json bundles/llamacpp-vulkan-qwen36-35b-a3b/manifest.json bundles/vllm-rocm-qwen35-27b/manifest.json bundles/vllm-rocm-qwen35-4b/manifest.json
git commit bundles/llamacpp-rocm-qwen35-122b-mtp/manifest.json bundles/llamacpp-vulkan-glm-45-air/manifest.json bundles/llamacpp-vulkan-qwen3-coder/manifest.json bundles/llamacpp-vulkan-qwen36-35b-a3b/manifest.json bundles/vllm-rocm-qwen35-27b/manifest.json bundles/vllm-rocm-qwen35-4b/manifest.json -m "bundles: tighten ROCm model gpu_arch rocm -> gfx1151 (manifests)"
git show --stat HEAD | tail -8
```
Expected: exactly 6 files.

---

### Task 5: Registry entries (add 9, tighten 4)

**Files:**
- Modify: `registry/add-ons.json`

- [ ] **Step 1: Tighten the four already-registered ROCm entries**

In `registry/add-ons.json`, for each of these four add-ons find their `requires.gpu_arch` and change `["rocm"]` → `["gfx1151"]` (same one-line edit as the manifests):
- `llamacpp-rocm-qwen35-122b-mtp`
- `llamacpp-vulkan-glm-45-air`
- `llamacpp-vulkan-qwen3-coder`
- `llamacpp-vulkan-qwen36-35b-a3b`

- [ ] **Step 2: Add the nine new add-on entries**

Append these nine objects to the `"add-ons"` array in `registry/add-ons.json` (mind the trailing comma on the previous element):

```json
    {
      "id": "kokoro-tts",
      "name": "Kokoro TTS (local)",
      "version": "1.0.0",
      "description": "Local OpenAI-compatible text-to-speech (Kokoro-82M) on CPU. Powers the AI Companion and Meta Glasses voices (af_heart EN / ef_dora ES). Loopback :8880 only.",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "tts", "voice", "speech", "kokoro", "cpu", "local"],
      "icon": "cpu",
      "host": "local",
      "port": 8880,
      "requires": {
        "platform": "linux-x86_64",
        "min_ram_mb": 1024,
        "min_disk_mb": 2000
      },
      "env_vars": [],
      "notes": "CPU-only — compatible on any linux-x86_64 host. RAM/disk are derived estimates (Kokoro-82M weights + image), not vendor specs. Seeds a 'Kokoro (local)' TTS profile on install."
    },
    {
      "id": "faster-whisper-server",
      "name": "Faster-Whisper Server (local)",
      "version": "1.0.0",
      "description": "Local OpenAI-compatible speech-to-text (faster-whisper / CTranslate2, large-v3) for Meta Glasses and AI-chat voice input. Runs on CPU; loopback :8004 only. The AI Companion keeps its own in-container STT.",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "stt", "voice", "speech", "whisper", "transcription", "cpu", "local"],
      "icon": "cpu",
      "host": "local",
      "port": 8004,
      "requires": {
        "platform": "linux-x86_64",
        "min_ram_mb": 2048,
        "min_disk_mb": 4000
      },
      "env_vars": [],
      "notes": "CPU-only — compatible on any linux-x86_64 host. RAM/disk are derived estimates (large-v3 int8 ~3GB weights + image), not vendor specs. Seeds a 'Faster-Whisper (local)' STT profile on install."
    },
    {
      "id": "vllm-rocm-qwen3",
      "name": "vLLM Qwen3-4B (ROCm gfx1151)",
      "version": "1.0.0",
      "description": "Fast tool-dispatch LLM (Qwen3-4B BF16) served via vLLM on AMD Strix Halo (gfx1151). Part of crow's tiered Mode A.",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "llm", "vllm", "qwen3", "rocm", "gfx1151"],
      "icon": "cpu",
      "host": "local",
      "port": 8001,
      "requires": {
        "gpu": true,
        "gpu_arch": ["gfx1151"],
        "min_vram_gb": 12,
        "platform": "linux-x86_64"
      },
      "env_vars": [],
      "notes": "Orchestrator-managed; participates in the crow-strix-vram swap group. Built for AMD Strix Halo gfx1151."
    },
    {
      "id": "vllm-rocm-qwen35-4b",
      "name": "vLLM Qwen3.5-4B (ROCm gfx1151)",
      "version": "1.0.0",
      "description": "Fast tool-dispatch + Maker Lab classroom endpoint (Qwen3.5-4B BF16) served via vLLM-ROCm on AMD Strix Halo (gfx1151).",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "llm", "vllm", "qwen3.5", "rocm", "gfx1151", "voice"],
      "icon": "cpu",
      "host": "local",
      "port": 8011,
      "requires": {
        "gpu": true,
        "gpu_arch": ["gfx1151"],
        "min_vram_gb": 12,
        "platform": "linux-x86_64"
      },
      "env_vars": [],
      "providers": [
        {
          "id": "crow-voice",
          "baseUrlTemplate": "http://{host_ip}:{port}/v1",
          "apiKey": "none",
          "description": "Fast tool-dispatch + Maker Lab classroom endpoint (Qwen3.5-4B BF16)",
          "models": [
            { "id": "qwen3.5-4b", "contextLen": 32768, "warm": true, "priority": "voice" }
          ]
        }
      ],
      "notes": "Orchestrator-managed; registers the crow-voice provider. Built for AMD Strix Halo gfx1151."
    },
    {
      "id": "vllm-rocm-qwen3-32b",
      "name": "vLLM Qwen3-32B (ROCm gfx1151)",
      "version": "1.0.0",
      "description": "Mid-tier reasoning/synthesis LLM (Qwen3-32B dense BF16) on AMD Strix Halo. Part of crow's tiered Mode A.",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "llm", "vllm", "qwen3", "rocm", "gfx1151"],
      "icon": "cpu",
      "host": "local",
      "port": 8002,
      "requires": {
        "gpu": true,
        "gpu_arch": ["gfx1151"],
        "min_vram_gb": 80,
        "platform": "linux-x86_64"
      },
      "env_vars": [],
      "notes": "Orchestrator-managed; participates in the crow-strix-vram swap group. Built for AMD Strix Halo gfx1151."
    },
    {
      "id": "vllm-rocm-qwen35-27b",
      "name": "vLLM Qwen3.5-27B (ROCm gfx1151)",
      "version": "1.0.0",
      "description": "Daily-driver mid-tier reasoning/synthesis (Qwen3.5-27B BF16, ~54GB resident) served via vLLM-ROCm on AMD Strix Halo (gfx1151).",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "llm", "vllm", "qwen3.5", "rocm", "gfx1151"],
      "icon": "cpu",
      "host": "local",
      "port": 8012,
      "requires": {
        "gpu": true,
        "gpu_arch": ["gfx1151"],
        "min_vram_gb": 80,
        "platform": "linux-x86_64"
      },
      "env_vars": [],
      "providers": [
        {
          "id": "crow-chat",
          "baseUrlTemplate": "http://{host_ip}:{port}/v1",
          "apiKey": "none",
          "description": "Daily-driver mid-tier reasoning/synthesis (Qwen3.5-27B BF16)",
          "models": [
            { "id": "qwen3.5-27b", "contextLen": 32768, "warm": true, "priority": "interactive" }
          ]
        }
      ],
      "notes": "Orchestrator-managed; registers the crow-chat provider. Built for AMD Strix Halo gfx1151."
    },
    {
      "id": "llamacpp-vulkan-qwen3-embed",
      "name": "llama.cpp Qwen3-Embedding-0.6B (gfx1151)",
      "version": "1.0.0",
      "description": "Dedicated OpenAI-compatible embedding endpoint (Qwen3-Embedding-0.6B Q8_0, 1024-dim) via llama.cpp on AMD Strix Halo gfx1151. Registers as the crow-embed provider for KB MCP and other consumers.",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "embeddings", "llama.cpp", "qwen3", "rocm", "gfx1151"],
      "icon": "cpu",
      "host": "local",
      "port": 8004,
      "requires": {
        "gpu": true,
        "gpu_arch": ["gfx1151"],
        "min_vram_gb": 2,
        "platform": "linux-x86_64"
      },
      "env_vars": [],
      "providers": [
        {
          "id": "crow-embed",
          "baseUrlTemplate": "http://{host_ip}:{port}/v1",
          "apiKey": "none",
          "description": "OpenAI-compatible embedding endpoint (Qwen3-Embedding-0.6B Q8_0)",
          "models": [
            { "id": "qwen3-embedding-0.6b", "contextLen": 32768, "dimensions": 1024, "warm": true, "priority": "background" }
          ]
        }
      ],
      "notes": "Built for AMD Strix Halo gfx1151. NOTE: its service port 8004 overlaps faster-whisper-server's published host port 8004 — they cannot both run; to be reconciled by the port-registry sub-project."
    },
    {
      "id": "llamacpp-qwen72b",
      "name": "llama.cpp Qwen2.5-72B Q4_K_M (ROCm gfx1151)",
      "version": "1.0.0",
      "description": "Top-tier reasoning (Qwen2.5-72B-Instruct Q4_K_M via llama.cpp-ROCm), 64K context. Tiered Mode B on AMD Strix Halo gfx1151.",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "llm", "llama.cpp", "qwen2.5", "rocm", "gfx1151"],
      "icon": "cpu",
      "host": "local",
      "port": 8003,
      "requires": {
        "gpu": true,
        "gpu_arch": ["gfx1151"],
        "min_vram_gb": 60,
        "platform": "linux-x86_64"
      },
      "env_vars": [],
      "notes": "Orchestrator-managed; participates in the crow-strix-vram swap group (shares service port 8003). Built for AMD Strix Halo gfx1151."
    },
    {
      "id": "vllm-rocm-kimi",
      "name": "vLLM Kimi-Linear-48B (ROCm gfx1151)",
      "version": "1.0.0",
      "description": "Top-tier long-context planner (Kimi-Linear-48B-A3B-Instruct, MoE, 1M context, BF16). Tiered Mode B; manual start via crow-mode-big on AMD Strix Halo gfx1151.",
      "type": "bundle",
      "author": "Crow",
      "category": "ai",
      "tags": ["ai", "llm", "vllm", "kimi", "moe", "rocm", "gfx1151"],
      "icon": "cpu",
      "host": "local",
      "port": 8003,
      "requires": {
        "gpu": true,
        "gpu_arch": ["gfx1151"],
        "min_vram_gb": 110,
        "platform": "linux-x86_64"
      },
      "env_vars": [],
      "notes": "Orchestrator-managed; participates in the crow-strix-vram swap group (shares service port 8003). Built for AMD Strix Halo gfx1151."
    }
```

- [ ] **Step 2b: Verify JSON validity and entry count**

Run:
```bash
cd /home/kh0pp/crow
node -e "
const r=require('./registry/add-ons.json');
const ids=r['add-ons'].map(a=>a.id);
const want=['kokoro-tts','faster-whisper-server','vllm-rocm-qwen3','vllm-rocm-qwen35-4b','vllm-rocm-qwen3-32b','vllm-rocm-qwen35-27b','llamacpp-vulkan-qwen3-embed','llamacpp-qwen72b','vllm-rocm-kimi'];
for(const w of want){ if(!ids.includes(w)){console.error('MISSING',w);process.exit(1)} }
const byId=Object.fromEntries(r['add-ons'].map(a=>[a.id,a]));
for(const t of ['llamacpp-rocm-qwen35-122b-mtp','llamacpp-vulkan-glm-45-air','llamacpp-vulkan-qwen3-coder','llamacpp-vulkan-qwen36-35b-a3b']){
  if(JSON.stringify(byId[t].requires.gpu_arch)!=='[\"gfx1151\"]'){console.error('NOT TIGHTENED',t);process.exit(1)}
}
console.log('OK: 9 added, 4 tightened, valid JSON');
"
```
Expected: `OK: 9 added, 4 tightened, valid JSON`.

- [ ] **Step 3: Commit**

```bash
git add registry/add-ons.json
git commit registry/add-ons.json -m "registry: add 9 AI model bundles, tighten ROCm entries to gfx1151"
git show --stat HEAD | tail -4
```
Expected: exactly 1 file.

---

### Task 6: Port documentation + full verification

**Files:**
- Modify: `docs/developers/port-allocation.md`

- [ ] **Step 1: Add the two port rows**

In `docs/developers/port-allocation.md`, in the "Allocation table" (the `| Port | Binding | Bundle / Service | Status |` table), add two rows in port order (8004 near other 80xx rows, 8880 after them):
```markdown
| 8004 | 127.0.0.1 | faster-whisper-server (local STT) | existing |
| 8880 | 127.0.0.1 | kokoro-tts (local TTS) | existing |
```

- [ ] **Step 2: Run the CI port-allocation check**

Run: `node scripts/check-port-allocation.js; echo "exit=$?"`
Expected: our ports no longer listed as undocumented. `capstone-tracker :8090` may still appear (pre-existing, not ours). Confirm 8004 and 8880 are gone from the "Undocumented ports" list.

- [ ] **Step 3: Run the full gpu-arch test suite**

Run: `node --test tests/gpu-arch-vram.test.js`
Expected: PASS (10 tests).

- [ ] **Step 4: Boot the gateway clean (smoke test)**

Run: `timeout 20 node servers/gateway/index.js --no-auth 2>&1 | tail -20; echo "rc=${PIPESTATUS[0]}"`
Expected: gateway logs normal startup (listening on :3001), no import/syntax error from `gpu-arch.js` or `extensions.js`. (timeout killing it is fine — we only check it starts.)

- [ ] **Step 5: Commit**

```bash
git add docs/developers/port-allocation.md
git commit docs/developers/port-allocation.md -m "docs: document kokoro-tts :8880 + faster-whisper-server :8004 ports"
git show --stat HEAD | tail -4
```
Expected: exactly 1 file.

- [ ] **Step 6: Final review of the whole branch**

Run: `git log --oneline main..HEAD` and `git diff --stat main..HEAD`
Expected: 6 commits (Tasks 1-6), touching exactly: `servers/gateway/gpu-arch.js`, `tests/gpu-arch-vram.test.js`, `package.json`, `servers/gateway/dashboard/panels/extensions.js`, the 6 manifests, `registry/add-ons.json`, `docs/developers/port-allocation.md`. No unrelated files.

---

## Manual verification (post-merge, on crow)

After merge and a gateway restart, open the dashboard Extensions page (AI category):
- The 9 new bundles appear as cards.
- On crow (gfx1151, ~124 GB): all show an **Install** button (Kimi at 110 GB fits under 124).
- Each ROCm card shows a `🎮 NGB VRAM` chip.
- (Optional confidence check) Temporarily lower a bundle's `min_vram_gb` above 124 in a local copy and confirm the card flips to an "insufficient VRAM" badge with the reason tooltip; revert.

## Out of scope (carried to sub-project #2 — port registry)
- The faster-whisper / llamacpp-vulkan-qwen3-embed :8004 overlap (noted in the embed entry's `notes`).
- `capstone-tracker :8090` undocumented-port CI failure (not ours).
