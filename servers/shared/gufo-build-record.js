/**
 * gufo engine build record — schema v1 validator, build id, collision and
 * selectionMode checks (the private engineering notes, §5, §6.4, §10).
 *
 * A gufo "plugin" in Crow is an immutable recorded engine build. The record is
 * a local file (`<build dir>/build.json`, mode 0444) that names the gufo commit,
 * the official extension lock and the toolchain; rows name a build. Nothing in
 * here touches the disk, the clock, the network or a container: the caller reads
 * and hashes the files and hands the parsed record over.
 *
 * Record shape (schema 1, v1 = recipe "cmake-in-nix" only):
 *
 *   {
 *     schema: 1,
 *     recipe: "cmake-in-nix",
 *     build_id: "gufo-<version>-<commit7>-<mode>-<recipe8>",   // computeBuildId
 *     created_at: <ISO-8601>,
 *     reproducible: true | false | "unchecked",
 *     builder: { host_label, user },              // local file, never displayed
 *     source: {
 *       repo, commit: <40-hex>, describe,
 *       dirty: false,                             // MUST be false
 *       untracked_files: 0,
 *       version_txt,
 *       store_path,                               // null for a local cmake build
 *       fetched_from_cache,                       // false for a local cmake build
 *     },
 *     extensions: {
 *       selection_mode: "lock",                   // asserted twice (§6.4)
 *       lock_file_sha256: <64-hex>,
 *       lock_names: [...],                        // from extensions.lock
 *       api_version,                              // diagnose extensionApiVersion
 *       built: [{ name, version, source }],        // diagnose builtExtensions
 *       provider_keys: { <provider id>: [<artifact key> ...] },
 *       excluded: [...],
 *     },
 *     diagnose: { argv: [...], returncode: 0, stdout_sha256, json: {...verbatim...} },
 *     check_install: { report_path, report_sha256, status: "PASS", mode: "lock" },
 *     toolchain: {
 *       id: <sha256 of flake.lock>,
 *       flake_lock_sha256,
 *       nix_image: <ref>@sha256:<64-hex>,         // never a floating tag
 *       closure_volume, closure_manifest_sha256, rocm_version,
 *       rocr_library_dir: <the exact GUFO_ROCR_LIBRARY_DIR string>,
 *     },
 *     cmake: { preset, defines: [...], gpu_targets: [...] },
 *     binary: { path, bytes, sha256, version_output },
 *     flags_needed: [...],
 *     tests: {...},
 *     trust: "official-lock",                     // the only accepted value
 *   }
 *
 * Out of v1 on purpose (they were considered and dropped): a
 * `nix-build-derivation` recipe, `nix.substituters` and
 * `nix.trusted_public_keys`. A record naming any recipe but "cmake-in-nix" is
 * refused with RECIPE_UNKNOWN; the build is made locally, so no binary cache is
 * a trust root.
 *
 * Validation results are NOT in the record: they are append-only entries in the
 * sibling `validation.jsonl`, so `build.json`'s own sha256 stays valid.
 *
 * `validateBuildRecord` judges one record in isolation. The provider-collision
 * check is exported separately (`collisionCheck`) because the pre-flight re-runs
 * it from `provider_keys` on every start rather than trusting a stored flag.
 */

import { createHash } from "node:crypto";

/**
 * One code per refusal. A caller switches on these; a boolean is never enough.
 * `PROVIDER_KEY_COLLISION` carries the artifact key after a ":".
 */
export const REASONS = Object.freeze({
  RECORD_NOT_OBJECT: "record_not_object",
  SCHEMA_UNSUPPORTED: "schema_unsupported",
  BUILD_ID_INVALID: "build_id_invalid",
  RECIPE_UNKNOWN: "recipe_unknown",
  TRUST_NOT_OFFICIAL: "trust_not_official",
  SOURCE_COMMIT_INVALID: "source_commit_invalid",
  SOURCE_DIRTY: "source_dirty",
  SOURCE_UNTRACKED: "source_untracked",
  SELECTION_NOT_LOCK: "selection_not_lock",
  LOCK_HASH_INVALID: "lock_hash_invalid",
  LOCK_NAMES_INVALID: "lock_names_invalid",
  EXTENSION_EXTRA: "extension_extra",
  EXTENSION_MISSING: "extension_missing",
  EXTENSION_SOURCE_OUTSIDE_TREE: "extension_source_outside_tree",
  API_VERSION_MISMATCH: "api_version_mismatch",
  PROVIDER_KEYS_MISSING: "provider_keys_missing",
  PROVIDER_KEYS_UNKNOWN: "provider_keys_unknown",
  PROVIDER_KEY_COLLISION: "provider_key_collision",
  CHECK_INSTALL_NOT_PASS: "check_install_not_pass",
  CHECK_INSTALL_NOT_LOCK: "check_install_not_lock",
  IMAGE_FLOATING_TAG: "image_floating_tag",
  IMAGE_NOT_DIGEST_PINNED: "image_not_digest_pinned",
  BINARY_VERSION_MISSING_COMMIT: "binary_version_missing_commit",
});

/** The only record schema this module reads. */
export const SCHEMA_VERSION = 1;
/** The only build recipe v1 accepts: cmake run inside the pinned nix image. */
export const RECIPE_CMAKE_IN_NIX = "cmake-in-nix";
/** The only trust level v1 accepts: gufo's own official extension lock. */
export const OFFICIAL_TRUST = "official-lock";
/** The only extension selection mode v1 accepts. */
export const OFFICIAL_LOCK_MODE = "lock";

/**
 * `gufo-<version>-<commit7>-<mode>-<recipe8>`: lowercase, no separators beyond
 * the four dashes, no whitespace — an id can never carry a host, a path or a
 * user name. Shared with the catalog validator, which checks the format only.
 */
export const BUILD_ID_RE = /^gufo-[0-9][0-9A-Za-z._+-]*-[0-9a-f]{7}-(?:lock|discovery|explicit)-[0-9a-f]{8}$/;

const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}$/;
/** A built extension's source is the official tree's own directory for it. */
const EXTENSION_SOURCE_RE = /^src\/models\/([A-Za-z0-9_.-]+)$/;

/** The recipe-name marker mixed into the build id, so a schema change is visible. */
const BUILD_ID_DOMAIN = "gufo-build-id-v1";

/** Required, non-empty string input, or a TypeError naming it. */
function requiredInput(inputs, name) {
  const value = inputs[name];
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`computeBuildId: ${name} must be a non-empty string`);
  }
  return value;
}

/**
 * The build id for a recipe's inputs: `gufo-<version>-<commit7>-<mode>-<recipe8>`.
 *
 * `recipe8` is the first 8 hex of sha256 over the recipe name, the commit, the
 * `extensions.lock` and `flake.lock` digests, the pinned nix image, the exact
 * `GUFO_ROCR_LIBRARY_DIR` string and the SORTED cmake defines — so two hosts
 * that agree on the id agree on the recipe, and the two recipe options could
 * never collide on one id. Binary bytes are not an input: the record carries the
 * binary sha256 separately and pre-flight compares it against the pin.
 *
 * @param {{version: string, commit: string, recipe: string, lock_file_sha256: string,
 *          flake_lock_sha256: string, nix_image: string, rocr_library_dir: string,
 *          defines: string[], mode?: string}} inputs
 * @returns {string} a BUILD_ID_RE-matching id
 */
export function computeBuildId(inputs) {
  const i = inputs && typeof inputs === "object" && !Array.isArray(inputs) ? inputs : {};
  const version = requiredInput(i, "version");
  const commit = requiredInput(i, "commit");
  const recipe = requiredInput(i, "recipe");
  const lockSha = requiredInput(i, "lock_file_sha256");
  const flakeLockSha = requiredInput(i, "flake_lock_sha256");
  const nixImage = requiredInput(i, "nix_image");
  const rocrDir = requiredInput(i, "rocr_library_dir");
  const mode = typeof i.mode === "string" && i.mode !== "" ? i.mode : OFFICIAL_LOCK_MODE;
  const defines = i.defines;
  if (!Array.isArray(defines) || defines.some((d) => typeof d !== "string" || d === "")) {
    throw new TypeError("computeBuildId: defines must be an array of non-empty strings");
  }
  if (!HEX40_RE.test(commit)) {
    throw new TypeError("computeBuildId: commit must be 40 lowercase hex characters (git rev-parse HEAD)");
  }

  const material = [
    BUILD_ID_DOMAIN,
    recipe,
    commit,
    lockSha,
    flakeLockSha,
    nixImage,
    rocrDir,
    ...[...defines].sort(),
  ].join("\n");
  const recipe8 = createHash("sha256").update(material, "utf8").digest("hex").slice(0, 8);
  const id = `gufo-${version}-${commit.slice(0, 7)}-${mode}-${recipe8}`;
  if (!BUILD_ID_RE.test(id)) {
    throw new TypeError(`computeBuildId: "${id}" is not a valid build id (check version, commit and mode)`);
  }
  return id;
}

/**
 * The nix image a record names must be pinned by digest: `null` when it is, else
 * the reason code. `:latest` is named on its own so the caller can tell a
 * floating tag from a tag-only tag.
 *
 * @param {unknown} image
 * @returns {string|null} null | REASONS.IMAGE_FLOATING_TAG | REASONS.IMAGE_NOT_DIGEST_PINNED
 */
export function checkRecordImage(image) {
  if (typeof image !== "string" || image.trim() === "") return REASONS.IMAGE_NOT_DIGEST_PINNED;
  const ref = image.trim();
  if (/:latest$/i.test(ref)) return REASONS.IMAGE_FLOATING_TAG;
  if (!IMAGE_DIGEST_RE.test(ref)) return REASONS.IMAGE_NOT_DIGEST_PINNED;
  return null;
}

/**
 * The extension selection mode a diagnose output reports, or a refusal. Accepts
 * either the diagnose JSON itself or the record's `diagnose` block
 * (`{ json: {...} }`), because both are handed around.
 *
 * @param {unknown} diagnose
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function selectionModeCheck(diagnose) {
  const d = diagnose && typeof diagnose === "object" && !Array.isArray(diagnose) ? diagnose : {};
  const json = d.json && typeof d.json === "object" && !Array.isArray(d.json) ? d.json : d;
  return json.selectionMode === OFFICIAL_LOCK_MODE
    ? { ok: true, reasons: [] }
    : { ok: false, reasons: [REASONS.SELECTION_NOT_LOCK] };
}

/**
 * Provider-collision check (§10): one artifact key claimed by two or more
 * providers is a refusal, because in lock mode the tie is resolved by gufo's own
 * probe order, which Crow can neither predict nor enforce.
 *
 * An UNAVAILABLE provider still counts: the key is still claimed, and the probe
 * order is still what the caller cannot see. Keys are reported in sorted order,
 * and a reason names the key (`provider_key_collision:<key>`).
 *
 * @param {Array<{id: string, available?: boolean}>} providers diagnose provider list
 * @param {Record<string, string[]>} providerKeys provider id -> artifact keys
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function collisionCheck(providers, providerKeys) {
  const list = Array.isArray(providers) ? providers : [];
  const keys = providerKeys && typeof providerKeys === "object" && !Array.isArray(providerKeys)
    ? providerKeys
    : {};

  const ownersByKey = new Map();
  for (const p of list) {
    const id = p && typeof p === "object" && typeof p.id === "string" ? p.id : null;
    if (!id) continue;
    const own = Array.isArray(keys[id])
      ? keys[id].filter((k) => typeof k === "string" && k !== "")
      : [];
    for (const key of new Set(own)) {
      if (!ownersByKey.has(key)) ownersByKey.set(key, []);
      const owners = ownersByKey.get(key);
      if (!owners.includes(id)) owners.push(id);
    }
  }

  const reasons = [];
  for (const key of [...ownersByKey.keys()].sort()) {
    if (ownersByKey.get(key).length > 1) {
      reasons.push(`${REASONS.PROVIDER_KEY_COLLISION}:${key}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Validate one build record in isolation: every hard refusal of §6.4 that can be
 * judged from the record alone. `reasons` is empty iff `ok`.
 *
 * The collision check is separate (see `collisionCheck`) and the on-disk hashes
 * (record, binary, report) are the caller's, because this module never reads a
 * file. `reasons` is deduplicated and, for a record refused by one bad field, is
 * exactly that field's code.
 *
 * @param {unknown} record parsed build.json
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function validateBuildRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reasons: [REASONS.RECORD_NOT_OBJECT] };
  }

  const reasons = [];
  const add = (code) => {
    if (!reasons.includes(code)) reasons.push(code);
  };

  if (record.schema !== SCHEMA_VERSION) add(REASONS.SCHEMA_UNSUPPORTED);
  if (record.recipe !== RECIPE_CMAKE_IN_NIX) add(REASONS.RECIPE_UNKNOWN);
  if (record.trust !== OFFICIAL_TRUST) add(REASONS.TRUST_NOT_OFFICIAL);
  if (typeof record.build_id !== "string" || !BUILD_ID_RE.test(record.build_id)) {
    add(REASONS.BUILD_ID_INVALID);
  }

  // --- source: a clean checkout of a full commit ---------------------------
  const source = record.source && typeof record.source === "object" ? record.source : {};
  const commit = typeof source.commit === "string" && HEX40_RE.test(source.commit) ? source.commit : null;
  if (!commit) add(REASONS.SOURCE_COMMIT_INVALID);
  if (source.dirty !== false) add(REASONS.SOURCE_DIRTY);
  if (source.untracked_files !== 0) add(REASONS.SOURCE_UNTRACKED);

  // --- extensions: lock mode, asserted twice (field + diagnose output) -----
  const ext = record.extensions && typeof record.extensions === "object" ? record.extensions : {};
  const diagnoseBlock = record.diagnose && typeof record.diagnose === "object" ? record.diagnose : {};
  const diagnoseJson = diagnoseBlock.json && typeof diagnoseBlock.json === "object" && !Array.isArray(diagnoseBlock.json)
    ? diagnoseBlock.json
    : null;

  if (ext.selection_mode !== OFFICIAL_LOCK_MODE) add(REASONS.SELECTION_NOT_LOCK);
  if (!diagnoseJson || diagnoseJson.selectionMode !== OFFICIAL_LOCK_MODE) add(REASONS.SELECTION_NOT_LOCK);

  if (typeof ext.lock_file_sha256 !== "string" || !HEX64_RE.test(ext.lock_file_sha256)) {
    add(REASONS.LOCK_HASH_INVALID);
  }

  const lockNames = Array.isArray(ext.lock_names)
    ? ext.lock_names.filter((n) => typeof n === "string" && n !== "")
    : null;
  if (!lockNames || lockNames.length === 0 || new Set(lockNames).size !== lockNames.length) {
    add(REASONS.LOCK_NAMES_INVALID);
  }
  const lockSet = new Set(lockNames || []);
  const built = Array.isArray(ext.built) ? ext.built.filter((b) => b && typeof b === "object") : [];

  if (built.some((b) => typeof b.name !== "string" || !lockSet.has(b.name))) add(REASONS.EXTENSION_EXTRA);
  for (const name of lockSet) {
    if (!built.some((b) => b.name === name)) {
      add(REASONS.EXTENSION_MISSING);
      break;
    }
  }

  for (const b of built) {
    const m = typeof b.source === "string" ? EXTENSION_SOURCE_RE.exec(b.source) : null;
    if (!m || m[1] !== b.name) {
      add(REASONS.EXTENSION_SOURCE_OUTSIDE_TREE);
      break;
    }
  }

  if (!diagnoseJson || diagnoseJson.extensionApiVersion !== ext.api_version) {
    add(REASONS.API_VERSION_MISMATCH);
  }

  // --- provider_keys must cover exactly the diagnose provider ids ----------
  const providerKeys = ext.provider_keys && typeof ext.provider_keys === "object" && !Array.isArray(ext.provider_keys)
    ? ext.provider_keys
    : null;
  const diagnoseIds = Array.isArray(diagnoseJson?.providers)
    ? diagnoseJson.providers.map((p) => (p && typeof p.id === "string" ? p.id : null)).filter(Boolean)
    : [];
  const keyIds = providerKeys ? Object.keys(providerKeys) : [];
  if (diagnoseIds.some((id) => !keyIds.includes(id))) add(REASONS.PROVIDER_KEYS_MISSING);
  if (keyIds.some((id) => !diagnoseIds.includes(id))) add(REASONS.PROVIDER_KEYS_UNKNOWN);

  // --- gufo's own check_install report ------------------------------------
  const checkInstall = record.check_install && typeof record.check_install === "object" ? record.check_install : {};
  if (checkInstall.status !== "PASS") add(REASONS.CHECK_INSTALL_NOT_PASS);
  if (checkInstall.mode !== OFFICIAL_LOCK_MODE) add(REASONS.CHECK_INSTALL_NOT_LOCK);

  // --- toolchain image: pinned by digest, never a floating tag -------------
  const imageReason = checkRecordImage(record.toolchain?.nix_image);
  if (imageReason) add(imageReason);

  // --- binary reports the commit it was built from (§6.4) ------------------
  // Only judged against a valid commit: an invalid one is already refused above,
  // and guessing a substring from it would report a second, confusing reason.
  if (commit) {
    const versionOutput = typeof record.binary?.version_output === "string" ? record.binary.version_output : "";
    if (!versionOutput.includes(commit) && !versionOutput.includes(commit.slice(0, 7))) {
      add(REASONS.BINARY_VERSION_MISSING_COMMIT);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * A one-line rendering for a record that is shown but never launched — the
 * `trust: "unrecorded"` shape an `import-legacy` writes, and status panels.
 *
 * It carries no path, no host label, no user and no hash past 12 hex: the build
 * id, the trust level, the commit prefix, the extension count and the binary
 * digest prefix only. Tolerates a partial or garbage record (a legacy directory
 * has almost nothing) and never throws.
 *
 * @param {unknown} record
 * @returns {string}
 */
export function displayBuildRecord(record) {
  const r = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  const id = typeof r.build_id === "string" && r.build_id.trim() !== "" ? r.build_id.trim() : "build unknown";
  const trust = typeof r.trust === "string" && r.trust.trim() !== "" ? r.trust.trim() : "unrecorded";
  const commit = typeof r.source?.commit === "string" && HEX40_RE.test(r.source.commit)
    ? r.source.commit.slice(0, 7)
    : null;
  const binary = typeof r.binary?.sha256 === "string" && HEX64_RE.test(r.binary.sha256)
    ? r.binary.sha256.slice(0, 12)
    : null;
  const builtCount = Array.isArray(r.extensions?.built) ? r.extensions.built.length : null;

  const parts = [id, trust];
  if (commit) parts.push(`commit ${commit}`);
  if (builtCount !== null) parts.push(`${builtCount} extension${builtCount === 1 ? "" : "s"}`);
  if (binary) parts.push(`binary ${binary}`);
  if (trust !== OFFICIAL_TRUST) parts.push("display only, not launchable");
  return parts.join(" · ");
}