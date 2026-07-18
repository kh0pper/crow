#!/usr/bin/env node
/**
 * Validates registry/model-catalog.json (Item G model-catalog theme).
 *
 * Exports a pure function `validateCatalog(catalogObj) -> { ok, errors }`
 * for tests and other tooling, plus a CLI main that loads the real catalog
 * file and exits 1 on any error (wired into CI's static-checks job as
 * `npm run validate-model-catalog`).
 *
 * Checks:
 *   - runtime.assets keys are drawn from a known set; linux-* keys require
 *     min_glibc.
 *   - model ids are unique.
 *   - every quant has a sha256 UNLESS the owning model is gated:true (a
 *     gated HF repo can hide the LFS blob's sha256 even when size is known
 *     — see scripts/dev/hf-catalog-entry.mjs's doc comment). A non-gated
 *     model must always carry a real sha256.
 *   - min_ram_mb is never less than the quant's own size_mb (a RAM-math
 *     sanity floor: whatever else is estimated, the model has to fit in RAM
 *     at all before KV-cache/overhead are even added).
 *   - min_runtime_version (a llama.cpp "b<build>" tag) must not exceed
 *     runtime.release's build number.
 *   - exactly one model has first_run_default:true, and that model must be
 *     ungated with at least one quant carrying min_vram_mb:0 (CPU-capable) —
 *     first_run_default is the model Crow offers as the default first
 *     install on a machine with no GPU.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_PATH = join(REPO_ROOT, "registry/model-catalog.json");

const KNOWN_RUNTIME_ASSET_KEYS = new Set([
  "linux-x64-vulkan",
  "linux-x64-cpu",
  "darwin-arm64",
  "darwin-x64",
]);

const SHA256_RE = /^[0-9a-f]{64}$/i;

/** Parse a llama.cpp release tag "b<number>" into its numeric build. Returns NaN on malformed input. */
function parseBuildNumber(tag) {
  if (typeof tag !== "string") return NaN;
  const m = tag.match(/^b(\d+)$/);
  return m ? Number(m[1]) : NaN;
}

export function validateCatalog(catalog) {
  const errors = [];

  if (!catalog || typeof catalog !== "object") {
    return { ok: false, errors: ["catalog must be an object"] };
  }

  const runtime = catalog.runtime;
  if (!runtime || typeof runtime !== "object") {
    errors.push("runtime is required");
  } else {
    const releaseBuild = parseBuildNumber(runtime.release);
    if (Number.isNaN(releaseBuild)) {
      errors.push(`runtime.release must be a "b<number>" tag, got ${JSON.stringify(runtime.release)}`);
    }

    const assets = runtime.assets;
    if (!assets || typeof assets !== "object") {
      errors.push("runtime.assets is required");
    } else {
      for (const [key, asset] of Object.entries(assets)) {
        if (!KNOWN_RUNTIME_ASSET_KEYS.has(key)) {
          errors.push(`unknown runtime asset key "${key}"`);
        }
        if (key.startsWith("linux-") && (!asset || !asset.min_glibc)) {
          errors.push(`runtime asset "${key}" is a linux asset and must declare min_glibc`);
        }
        if (!asset || !asset.file) {
          errors.push(`runtime asset "${key}" is missing file`);
        }
        if (!asset || !SHA256_RE.test(asset.sha256 || "")) {
          errors.push(`runtime asset "${key}" has an invalid or missing sha256`);
        }
      }
    }
  }

  const models = Array.isArray(catalog.models) ? catalog.models : null;
  if (!models) {
    errors.push("models must be an array");
    return { ok: errors.length === 0, errors };
  }

  const seenIds = new Set();
  const firstRunDefaults = [];
  const releaseBuild = runtime && typeof runtime === "object" ? parseBuildNumber(runtime.release) : NaN;

  models.forEach((model, idx) => {
    const label = model && model.id ? `model "${model.id}"` : `models[${idx}]`;

    if (!model || typeof model !== "object") {
      errors.push(`${label}: entry must be an object`);
      return;
    }

    if (!model.id) {
      errors.push(`${label}: missing id`);
    } else if (seenIds.has(model.id)) {
      errors.push(`duplicate model id "${model.id}"`);
    } else {
      seenIds.add(model.id);
    }

    if (model.first_run_default === true) {
      firstRunDefaults.push(model);
    }

    if (!Number.isNaN(releaseBuild) && model.min_runtime_version != null) {
      const modelBuild = parseBuildNumber(model.min_runtime_version);
      if (Number.isNaN(modelBuild)) {
        errors.push(`${label}: min_runtime_version must be a "b<number>" tag, got ${JSON.stringify(model.min_runtime_version)}`);
      } else if (modelBuild > releaseBuild) {
        errors.push(
          `${label}: min_runtime_version ${model.min_runtime_version} is greater than runtime.release ${runtime.release}`
        );
      }
    }

    const quants = Array.isArray(model.quants) ? model.quants : [];
    if (quants.length === 0) {
      errors.push(`${label}: must have at least one quant`);
    }

    quants.forEach((quant, qidx) => {
      const qlabel = `${label} quant[${qidx}]${quant && quant.quant ? ` (${quant.quant})` : ""}`;

      if (!quant || typeof quant !== "object") {
        errors.push(`${qlabel}: entry must be an object`);
        return;
      }

      // sha256: required for every quant, UNLESS the owning model is
      // gated:true — a gated HF repo can hide the LFS blob's sha256 even
      // when the file's size is independently known.
      const gated = model.gated === true;
      if (quant.sha256 == null) {
        if (!gated) {
          errors.push(`${qlabel}: missing quant sha256 (only allowed when the model is gated:true)`);
        }
      } else if (!SHA256_RE.test(quant.sha256)) {
        errors.push(`${qlabel}: sha256 is not a valid 64-char hex string`);
      }

      if (typeof quant.size_mb !== "number" || !(quant.size_mb > 0)) {
        errors.push(`${qlabel}: size_mb must be a positive number`);
      }
      if (typeof quant.min_ram_mb !== "number") {
        errors.push(`${qlabel}: min_ram_mb must be a number`);
      } else if (typeof quant.size_mb === "number" && quant.min_ram_mb < quant.size_mb) {
        errors.push(`${qlabel}: min_ram_mb (${quant.min_ram_mb}) is less than quant size_mb (${quant.size_mb})`);
      }
      if (typeof quant.min_vram_mb !== "number") {
        errors.push(`${qlabel}: min_vram_mb must be a number`);
      }
    });
  });

  if (firstRunDefaults.length === 0) {
    errors.push("exactly one model must have first_run_default:true, found 0");
  } else if (firstRunDefaults.length > 1) {
    errors.push(
      `exactly one model must have first_run_default:true, found ${firstRunDefaults.length} (${firstRunDefaults
        .map((m) => m.id)
        .join(", ")})`
    );
  } else {
    const def = firstRunDefaults[0];
    if (def.gated === true) {
      errors.push(`first_run_default model "${def.id}" must not be gated:true`);
    }
    const quants = Array.isArray(def.quants) ? def.quants : [];
    const hasCpuCapable = quants.some((q) => q && q.min_vram_mb === 0);
    if (!hasCpuCapable) {
      errors.push(`first_run_default model "${def.id}" must have at least one quant with min_vram_mb:0`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  } catch (err) {
    console.error(`ERROR: failed to read/parse ${CATALOG_PATH}: ${err.message}`);
    process.exit(1);
  }

  const { ok, errors } = validateCatalog(catalog);
  if (!ok) {
    console.error(`ERROR: ${errors.length} model-catalog validation issue(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK: ${catalog.models.length} model(s) in ${CATALOG_PATH} validate cleanly.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
