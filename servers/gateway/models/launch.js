/**
 * Launch profiles for native llama-server starts (spec §3.1 / §4).
 *
 * A `launch` block is a fixed set of typed knobs plus `extra_args`. This
 * module is the ONLY place that maps a knob to a llama-server flag:
 * the catalog validator calls `validateLaunch`, the orchestrator calls
 * `mergeLaunch` (catalog defaults under the provider row's override) and
 * `renderLaunchArgs`. Identity flags (--model/--alias/--port/--host) and
 * companion/task flags (--mmproj/--embedding/--reranking) stay owned by
 * runtime.js + gpu-orchestrator.js; `extra_args` may never carry them.
 */

export const FLASH_ATTN_VALUES = ["on", "off", "auto"];
export const KV_TYPES = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"];
const SPEC_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;

const TOP_LEVEL_KEYS = new Set(["ctx", "ngl", "flash_attn", "parallel", "no_mmap", "kv_type", "spec", "sampling", "jinja", "extra_args"]);
const SAMPLING_RULES = {
  temp: (v) => v >= 0 && v <= 5,
  top_p: (v) => v >= 0 && v <= 1,
  top_k: (v) => Number.isInteger(v) && v >= 0,
  min_p: (v) => v >= 0 && v <= 1,
  presence_penalty: (v) => v >= -2 && v <= 2,
};
const SAMPLING_FLAGS = { temp: "--temp", top_p: "--top-p", top_k: "--top-k", min_p: "--min-p", presence_penalty: "--presence-penalty" };

export const LAUNCH_OWNED_FLAGS = new Set([
  "-m", "--model", "--alias", "--port", "--host",
  "-c", "--ctx-size", "--mmproj", "--embedding", "--embeddings", "--reranking", "--jinja",
  "-ngl", "--n-gpu-layers", "-fa", "--flash-attn", "-np", "--parallel", "--no-mmap",
  "-ctk", "-ctv", "--cache-type-k", "--cache-type-v",
  "--spec-type", "--spec-draft-n-max",
  "--temp", "--top-p", "--top-k", "--min-p", "--presence-penalty",
]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateLaunch(launch, { contextLen = null, label = "launch", hasMtp = false } = {}) {
  const errors = [];
  if (launch === undefined || launch === null) return errors;
  if (!isPlainObject(launch)) return [`${label}: must be a plain object`];

  for (const key of Object.keys(launch)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`${label}: unknown key "${key}"`);
  }
  const { ctx, ngl, flash_attn, parallel, no_mmap, kv_type, spec, sampling, jinja, extra_args } = launch;

  if (ctx !== undefined) {
    if (!Number.isInteger(ctx) || ctx < 1024) errors.push(`${label}: ctx must be an integer >= 1024`);
    else if (Number.isFinite(contextLen) && ctx > contextLen) errors.push(`${label}: ctx ${ctx} exceeds context_len ${contextLen}`);
  }
  if (ngl !== undefined && (!Number.isInteger(ngl) || ngl < 0)) errors.push(`${label}: ngl must be an integer >= 0`);
  if (parallel !== undefined && (!Number.isInteger(parallel) || parallel < 1)) errors.push(`${label}: parallel must be an integer >= 1`);
  if (no_mmap !== undefined && typeof no_mmap !== "boolean") errors.push(`${label}: no_mmap must be a boolean`);
  if (jinja !== undefined && typeof jinja !== "boolean") errors.push(`${label}: jinja must be a boolean`);
  if (flash_attn !== undefined && !FLASH_ATTN_VALUES.includes(flash_attn)) {
    errors.push(`${label}: flash_attn must be one of ${FLASH_ATTN_VALUES.join(", ")}`);
  }
  if (kv_type !== undefined && !KV_TYPES.includes(kv_type)) errors.push(`${label}: kv_type must be one of ${KV_TYPES.join(", ")}`);

  if (spec !== undefined) {
    if (!isPlainObject(spec)) errors.push(`${label}: spec must be a plain object`);
    else {
      if (typeof spec.type !== "string" || !SPEC_TYPE_RE.test(spec.type)) errors.push(`${label}: spec.type must be a flag-safe string`);
      if (!Number.isInteger(spec.draft_n_max) || spec.draft_n_max < 1) errors.push(`${label}: spec.draft_n_max must be a positive integer`);
      if (!hasMtp) errors.push(`${label}: spec requires an mtp companion or the "mtp" tag on the model`);
    }
  }

  if (sampling !== undefined) {
    if (!isPlainObject(sampling)) errors.push(`${label}: sampling must be a plain object`);
    else {
      for (const [k, v] of Object.entries(sampling)) {
        const rule = SAMPLING_RULES[k];
        if (!rule) errors.push(`${label}: sampling: unknown key "${k}"`);
        else if (typeof v !== "number" || !Number.isFinite(v) || !rule(v)) errors.push(`${label}: sampling.${k} is out of range`);
      }
    }
  }

  if (extra_args !== undefined) {
    if (!Array.isArray(extra_args) || extra_args.some((a) => typeof a !== "string")) {
      errors.push(`${label}: extra_args must be an array of strings`);
    } else {
      for (const arg of extra_args) {
        const flag = arg.split("=")[0];
        if (LAUNCH_OWNED_FLAGS.has(flag)) errors.push(`${label}: extra_args may not contain "${flag}" (owned by the launcher)`);
      }
    }
  }
  return errors;
}

export function mergeLaunch(base, override) {
  const out = {};
  for (const src of [base, override]) {
    if (!isPlainObject(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (k === "sampling" && isPlainObject(v)) out.sampling = { ...(out.sampling || {}), ...v };
      else if (k === "spec" && isPlainObject(v)) out.spec = { ...v };
      else if (k === "extra_args" && Array.isArray(v)) out.extra_args = [...v];
      else out[k] = v;
    }
  }
  return out;
}

export function renderLaunchArgs(launch) {
  if (!isPlainObject(launch)) return [];
  const args = [];
  if (launch.ctx !== undefined) args.push("-c", String(launch.ctx));
  if (launch.ngl !== undefined) args.push("-ngl", String(launch.ngl));
  if (launch.flash_attn !== undefined) args.push("-fa", launch.flash_attn);
  if (launch.parallel !== undefined) args.push("-np", String(launch.parallel));
  if (launch.no_mmap === true) args.push("--no-mmap");
  if (launch.kv_type !== undefined) args.push("-ctk", launch.kv_type, "-ctv", launch.kv_type);
  if (isPlainObject(launch.spec)) args.push("--spec-type", launch.spec.type, "--spec-draft-n-max", String(launch.spec.draft_n_max));
  if (isPlainObject(launch.sampling)) {
    for (const key of Object.keys(SAMPLING_FLAGS)) {
      if (launch.sampling[key] !== undefined) args.push(SAMPLING_FLAGS[key], String(launch.sampling[key]));
    }
  }
  if (launch.jinja === true) args.push("--jinja");
  if (Array.isArray(launch.extra_args)) args.push(...launch.extra_args);
  return args;
}
