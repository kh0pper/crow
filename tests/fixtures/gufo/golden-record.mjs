/**
 * The golden gufo build record: schema 1, lock mode, recipe "cmake-in-nix".
 *
 * Hand-built, and every validator test mutates exactly one field of it. Its
 * `extensions` block and `diagnose.json` are derived from the committed v0.29.0
 * diagnose sample (`diagnose-v029-discovery.json`) with `selectionMode` flipped
 * to "lock", so putting the real sample back in is the only difference the
 * SELECTION_NOT_LOCK test needs.
 *
 * Placeholders, not facts about any host: the commit, every digest, the file
 * size, the ROCm version and the artifact keys of the extensions the design does
 * not name. The validator judges shape and cross-field consistency, never a real
 * digest, and the paths here are neutral ("/opt/gufo"). `build_id` is computed
 * from the record's own recipe inputs, so the fixture carries no invented
 * recipe hash.
 *
 * No fs writes: reading the sample is the only I/O, and the module under test
 * stays pure.
 */
import { readFileSync } from "node:fs";
import { computeBuildId, RECIPE_CMAKE_IN_NIX } from "../../../servers/shared/gufo-build-record.js";

/** The real `gufo diagnose --section extensions --json` output for v0.29.0 (discovery mode). */
export const REAL_DIAGNOSE = JSON.parse(
  readFileSync(new URL("./diagnose-v029-discovery.json", import.meta.url), "utf8"),
);

const VERSION = "0.29.0";
/** 40-hex shape, synthetic value: the record's own digests are opaque here. */
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const LOCK_SHA = "a".repeat(64);
const FLAKE_LOCK_SHA = "b".repeat(64);
const REPORT_SHA = "c".repeat(64);
const STDOUT_SHA = "d".repeat(64);
const CLOSURE_SHA = "e".repeat(64);
const BINARY_SHA = "f".repeat(64);
const NIX_IMAGE = `docker.io/nixos/nix@sha256:${"9".repeat(64)}`;
/** The exact value the build's shell exports; hashed as the literal string (Option A). */
const ROCR_LIBRARY_DIR = `/nix/store/${"0".repeat(32)}-rocm-merged/lib`;

/** The two defines the design mandates; both must be on the cmake command line. */
const defines = () => [
  "-DGUFO_EXTENSIONS_FROM_LOCK=ON",
  `-DGUFO_REVISION=${COMMIT}`,
];

/**
 * `gguf:qwen27`, `gguf:qwen4exp` and `gguf:deepseek4` are the keys the design
 * notes name for their providers; the rest are fixture strings of the same shape.
 */
const providerKeys = () => ({
  "deepseek4": ["gguf:deepseek4"],
  "embeddinggemma-2": ["gguf:embeddinggemma2"],
  "minimax-h3": ["gguf:minimax-h3"],
  "qwen27-q4": ["gguf:qwen27"],
  "flash-next-q4": ["gguf:qwen4exp"],
  "qwen3-asr": ["gguf:qwen3-asr"],
  "qwen3-tts": ["gguf:qwen3-tts"],
  "qwen-image-21": ["gguf:qwen-image21"],
});

/** The record's own recipe inputs, i.e. exactly what computeBuildId hashes. */
export function goldenBuildIdInputs() {
  return {
    version: VERSION,
    mode: "lock",
    recipe: RECIPE_CMAKE_IN_NIX,
    commit: COMMIT,
    lock_file_sha256: LOCK_SHA,
    flake_lock_sha256: FLAKE_LOCK_SHA,
    nix_image: NIX_IMAGE,
    rocr_library_dir: ROCR_LIBRARY_DIR,
    defines: defines(),
  };
}

function baseRecord() {
  const diagnose = structuredClone(REAL_DIAGNOSE);
  diagnose.selectionMode = "lock";
  const built = structuredClone(REAL_DIAGNOSE.builtExtensions);

  return {
    schema: 1,
    recipe: RECIPE_CMAKE_IN_NIX,
    build_id: computeBuildId(goldenBuildIdInputs()),
    created_at: "2026-11-04T00:00:00Z",
    reproducible: "unchecked",
    builder: { host_label: "example", user: "example" },
    source: {
      repo: "gufo-org/gufo",
      commit: COMMIT,
      describe: `v${VERSION}`,
      dirty: false,
      untracked_files: 0,
      version_txt: VERSION,
      store_path: null,
      fetched_from_cache: false,
    },
    extensions: {
      selection_mode: "lock",
      lock_file_sha256: LOCK_SHA,
      lock_names: built.map((e) => e.name),
      api_version: REAL_DIAGNOSE.extensionApiVersion,
      built,
      provider_keys: providerKeys(),
      excluded: structuredClone(REAL_DIAGNOSE.excludedExtensions),
    },
    diagnose: {
      argv: ["/opt/gufo/gufo", "diagnose", "--section", "extensions", "--json"],
      returncode: 0,
      stdout_sha256: STDOUT_SHA,
      json: diagnose,
    },
    check_install: {
      report_path: "/opt/gufo/check_install.report.json",
      report_sha256: REPORT_SHA,
      status: "PASS",
      mode: "lock",
    },
    toolchain: {
      id: FLAKE_LOCK_SHA,
      flake_lock_sha256: FLAKE_LOCK_SHA,
      nix_image: NIX_IMAGE,
      closure_volume: "gufo-nix",
      closure_manifest_sha256: CLOSURE_SHA,
      rocm_version: "placeholder",
      rocr_library_dir: ROCR_LIBRARY_DIR,
    },
    cmake: { preset: "release", defines: defines(), gpu_targets: [] },
    binary: {
      path: "/opt/gufo/gufo",
      bytes: 0,
      sha256: BINARY_SHA,
      version_output: `gufo ${VERSION} (${COMMIT})`,
    },
    flags_needed: [],
    tests: {},
    trust: "official-lock",
  };
}

/** A fresh golden record on every call, so a mutation can never leak sideways. */
export function goldenRecord() {
  return baseRecord();
}