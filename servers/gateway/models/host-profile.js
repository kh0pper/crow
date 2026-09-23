/**
 * Host launch profile (Strix Halo runtime profile spec §2.4, D6/D7).
 *
 * `hostLaunchDefaults(probe)` returns launch knobs for the host itself, or
 * null. It is the LOWEST launch layer at a native start:
 *
 *   host profile < catalog `launch` < provider `gpu_policy.launch` < jinja
 *
 * so it only ever fills keys nobody else set. A provider opts out per key
 * through its own `gpu_policy.launch` (`{ no_op_offload: false }`,
 * `{ no_mmap: false }`, `{ flash_attn: "off" }`). It applies to native
 * llama-server starts only; Docker bundles build their own command lines.
 *
 * gfx1151 (Strix Halo) on Vulkan gets kyuz0's / pi-lab's flags:
 * `-fa on` (llama.cpp renders `-fa 1` as `on`), `--no-mmap`, and
 * `--no-op-offload`. Flash attention stays on for every task: production
 * containers already run `-fa on` for chat AND embedding models on this
 * hardware, and FA on an unsupported head size falls back silently.
 * `--no-op-offload` stays regardless of `ngl` (pi-lab approved it as a
 * default). pi-lab's caveats, kept here on purpose:
 *   - `--no-op-offload` changes nothing unless weights are host-resident;
 *   - its measured +18% alone did NOT include the fork-only
 *     `GGML_MOE_PREFETCH`, so do not expect that number from stock builds;
 *   - outputs match on argmax, not bit for bit.
 *
 * Pure: reads only the probe object it is handed (probe.js supplies
 * `gpuArch` and `accel`); never probes on its own.
 */

export const GFX1151_VULKAN_DEFAULTS = Object.freeze({ flash_attn: "on", no_mmap: true, no_op_offload: true });

/**
 * @param {{gpuArch?: string|null, accel?: string}|null|undefined} probe
 * @returns {{flash_attn: "on", no_mmap: true, no_op_offload: true}|null}
 */
export function hostLaunchDefaults(probe) {
  if (!probe || probe.gpuArch !== "gfx1151" || probe.accel !== "vulkan") return null;
  return { ...GFX1151_VULKAN_DEFAULTS };
}
