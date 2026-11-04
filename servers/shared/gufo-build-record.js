/**
 * gufo engine build record — schema v1 validator, build id, collision and
 * selectionMode checks (the private engineering notes, §2, §5, §6.4, §10).
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
 *       id: <sha256 of flake.lock>,               // MUST equal flake_lock_sha256
 *       flake_lock_sha256: <64-hex>,
 *       nix_image: <ref>@sha256:<64-hex>,         // never a floating tag
 *       closure_volume, closure_manifest_sha256, rocm_version,
 *       rocr_library_dir: <the exact GUFO_ROCR_LIBRARY_DIR string>,
 *     },
 *     cmake: { preset, defines: [...], gpu_targets: [...] },
 *     binary: { path, bytes, sha256: <64-hex>, version_output },
 *     flags_needed: [...],
 *     tests: {...},
 *     trust: "official-lock",                     // the only accepted value
 *   }
 *
 * §2's cmake command line is part of the record, not of the toolchain, and it is
 * judged by an allowlist grammar rather than by string equality: every entry of
 * `cmake.defines` must be one `-D<NAME>[:<TYPE>]=<value>` token, so an alternate
 * spelling of a define cannot slip past a check. Keyed on the parsed variable
 * name (a `:TYPE` suffix is accepted and ignored), the defines must select the
 * official lock exactly once (`GUFO_EXTENSIONS_FROM_LOCK=ON`), must name exactly
 * the recorded commit (`GUFO_REVISION=<source.commit>`), and must never hand gufo
 * an extension list of its own (`GUFO_EXTENSIONS`, `GUFO_EXTENSION_DIRS`, typed
 * or not). A bare `-D`, a split `"-D", "NAME=value"` pair, `-U`, `-C <file>`,
 * a lowercase name or a padded token is refused as malformed.
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
 * `PROVIDER_KEY_COLLISION` and `PROVIDER_KEYS_MISSING` / `PROVIDER_KEYS_INVALID`
 * from `collisionCheck` carry the artifact key / provider id after a ":".
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
  DEFINES_MALFORMED: "defines_malformed",
  DEFINES_LOCK_MISSING: "defines_lock_missing",
  DEFINES_REVISION_MISMATCH: "defines_revision_mismatch",
  DEFINES_FORBIDDEN: "defines_forbidden",
  SELECTION_NOT_LOCK: "selection_not_lock",
  LOCK_HASH_INVALID: "lock_hash_invalid",
  LOCK_NAMES_INVALID: "lock_names_invalid",
  EXTENSION_EXTRA: "extension_extra",
  EXTENSION_MISSING: "extension_missing",
  EXTENSION_SOURCE_OUTSIDE_TREE: "extension_source_outside_tree",
  API_VERSION_MISMATCH: "api_version_mismatch",
  DIAGNOSE_EXTENSIONS_MISMATCH: "diagnose_extensions_mismatch",
  PROVIDER_IDS_INVALID: "provider_ids_invalid",
  PROVIDER_KEYS_MISSING: "provider_keys_missing",
  PROVIDER_KEYS_UNKNOWN: "provider_keys_unknown",
  PROVIDER_KEYS_INVALID: "provider_keys_invalid",
  PROVIDER_KEY_COLLISION: "provider_key_collision",
  CHECK_INSTALL_NOT_PASS: "check_install_not_pass",
  CHECK_INSTALL_NOT_LOCK: "check_install_not_lock",
  REPORT_HASH_INVALID: "report_hash_invalid",
  DIAGNOSE_RETURNCODE: "diagnose_returncode",
  DIAGNOSE_HASH_INVALID: "diagnose_hash_invalid",
  IMAGE_FLOATING_TAG: "image_floating_tag",
  IMAGE_NOT_DIGEST_PINNED: "image_not_digest_pinned",
  FLAKE_LOCK_HASH_INVALID: "flake_lock_hash_invalid",
  TOOLCHAIN_ID_MISMATCH: "toolchain_id_mismatch",
  BINARY_HASH_INVALID: "binary_hash_invalid",
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

/**
 * §2: the one spelling a cmake define may have — `-D` then an upper-case name,
 * an optional `:TYPE`, `=` and the value. The name is the only thing the checks
 * key on, so `-DGUFO_REVISION=...` and `-DGUFO_REVISION:STRING=...` are the same
 * variable and neither can be used to hide a second, different value.
 */
const DEFINE_RE = /^-D([A-Z0-9_]+)(?::[A-Z]+)?=(.*)$/;
/** §2: the official lock, exactly once, and the revision pin. */
const LOCK_VARIABLE = "GUFO_EXTENSIONS_FROM_LOCK";
const REVISION_VARIABLE = "GUFO_REVISION";
/** §2: a record that hands gufo its own extension list is refused, typed or not. */
const FORBIDDEN_VARIABLES = Object.freeze(["GUFO_EXTENSIONS", "GUFO_EXTENSION_DIRS"]);

const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}$/;
/** A built extension's source is the official tree's own directory for it. */
const EXTENSION_SOURCE_RE = /^src\/models\/([A-Za-z0-9_.-]+)$/;
/**
 * A build id that is safe to print verbatim (no path, no host, no user, and no
 * dot — a dot is how a host name or a file name would arrive).
 */
const DISPLAY_ID_RE = /^[A-Za-z0-9_+-]{1,64}$/;
/** The trust levels a displayed record may name; anything else is "unrecorded". */
const DISPLAY_TRUSTS = Object.freeze([OFFICIAL_TRUST, "unrecorded"]);

/** The recipe-name marker mixed into the build id, so a schema change is visible. */
const BUILD_ID_DOMAIN = "gufo-build-id-v1";

/**
 * A reason that already refuses one of the fields the build id is derived from.
 * When one of them fired, the id is not recomputed: the fault would otherwise be
 * reported twice, once as itself and once as a build id mismatch.
 */
const ID_INPUT_REASONS = Object.freeze([
  REASONS.RECIPE_UNKNOWN,
  REASONS.SOURCE_COMMIT_INVALID,
  REASONS.LOCK_HASH_INVALID,
  REASONS.IMAGE_FLOATING_TAG,
  REASONS.IMAGE_NOT_DIGEST_PINNED,
  REASONS.DEFINES_MALFORMED,
  REASONS.DEFINES_LOCK_MISSING,
  REASONS.DEFINES_REVISION_MISMATCH,
  REASONS.DEFINES_FORBIDDEN,
  REASONS.FLAKE_LOCK_HASH_INVALID,
]);

/** An object whose prototype is Object.prototype (or none) — not an array, not a Map. */
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Required, non-empty string input, or a TypeError naming it. */
function requiredInput(inputs, name) {
  const value = inputs[name];
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`computeBuildId: ${name} must be a non-empty string`);
  }
  return value;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `--version` output names the commit: the full 40-hex form, or its
 * 7-hex abbreviation. Both are anchored on a non-hex boundary at either end, so
 * a longer hex run (a store path hash, a different revision) cannot stand in for
 * the record's own commit.
 */
function mentionsCommit(versionOutput, commit) {
  const full = new RegExp(`(^|[^0-9a-f])${escapeRegex(commit)}([^0-9a-f]|$)`);
  const short = new RegExp(`(^|[^0-9a-f])${escapeRegex(commit.slice(0, 7))}([^0-9a-f]|$)`);
  return full.test(versionOutput) || short.test(versionOutput);
}

/** `{name, version, source}` for each entry, sorted by name — or null if unusable. */
function extensionProjection(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) return null;
    out.push({ name: entry.name ?? null, version: entry.version ?? null, source: entry.source ?? null });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

/**
 * Whether two extension lists name the same extensions, in any order: the
 * record's list and the diagnose output's list are compared by name, version and
 * source, so neither a dropped, an added nor an edited extension passes.
 */
function sameExtensions(a, b) {
  const left = extensionProjection(a);
  const right = extensionProjection(b);
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
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
 * The inputs are hashed as one JSON array with a domain tag, never as a joined
 * string: `["a\nb"]` and `["a", "b"]` are different recipes and must not share
 * an id.
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

  const material = JSON.stringify([
    BUILD_ID_DOMAIN,
    recipe,
    commit,
    lockSha,
    flakeLockSha,
    nixImage,
    rocrDir,
    [...defines].sort(),
  ]);
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
 * Fails CLOSED: a provider list that is not an array, a `provider_keys` that is
 * not a plain object, a provider without a string id and a listed provider with
 * no key list are all refusals, because a collision can then not be judged at
 * all. An UNAVAILABLE provider still counts: the key is still claimed, and the
 * probe order is still what the caller cannot see. A missing key list is
 * reported as `provider_keys_missing:<id>`; a present key list that is empty or
 * not all non-empty strings is `provider_keys_invalid:<id>` — the list is judged
 * here, not left to the caller, because an unknown key set can never be cleared;
 * colliding keys are reported in sorted order as
 * `provider_key_collision:<key>`.
 *
 * @param {Array<{id: string, available?: boolean}>} providers diagnose provider list
 * @param {Record<string, string[]>} providerKeys provider id -> artifact keys
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function collisionCheck(providers, providerKeys) {
  const reasons = [];
  const add = (code) => {
    if (!reasons.includes(code)) reasons.push(code);
  };

  const list = Array.isArray(providers) ? providers : null;
  const keys = isPlainObject(providerKeys) ? providerKeys : null;
  if (!list) add(REASONS.PROVIDER_IDS_INVALID);
  if (!keys) add(REASONS.PROVIDER_KEYS_INVALID);

  const ids = [];
  for (const p of list ?? []) {
    if (!isPlainObject(p) || typeof p.id !== "string" || p.id === "") {
      add(REASONS.PROVIDER_IDS_INVALID);
      continue;
    }
    if (!ids.includes(p.id)) ids.push(p.id);
  }

  if (keys) {
    for (const id of ids) {
      const own = Object.prototype.hasOwnProperty.call(keys, id) ? keys[id] : undefined;
      // No key list recorded for a provider diagnose lists: the collision
      // cannot be judged at all, so the provider is refused by name.
      if (!Array.isArray(own)) {
        add(`${REASONS.PROVIDER_KEYS_MISSING}:${id}`);
        continue;
      }
      // An empty list, or a list that is not all non-empty strings, is refused
      // here rather than left to the caller: a provider whose keys are unknown
      // can never be cleared of a collision.
      if (own.length === 0 || own.some((k) => typeof k !== "string" || k === "")) {
        add(`${REASONS.PROVIDER_KEYS_INVALID}:${id}`);
      }
    }
  }

  const ownersByKey = new Map();
  for (const id of ids) {
    const own = keys && Object.prototype.hasOwnProperty.call(keys, id) ? keys[id] : undefined;
    if (!Array.isArray(own)) continue;
    for (const key of new Set(own)) {
      if (!ownersByKey.has(key)) ownersByKey.set(key, []);
      const owners = ownersByKey.get(key);
      if (!owners.includes(id)) owners.push(id);
    }
  }

  const colliding = [...ownersByKey.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([key]) => key)
    .sort();
  for (const key of colliding) add(`${REASONS.PROVIDER_KEY_COLLISION}:${key}`);

  return { ok: reasons.length === 0, reasons };
}

/**
 * Validate one build record in isolation: every hard refusal of §2, §6.4 and
 * §10 that can be judged from the record alone. `reasons` is empty iff `ok`.
 *
 * The collision check is separate (see `collisionCheck`) and the on-disk hashes
 * (record, binary, report) are the caller's, because this module never reads a
 * file. `reasons` is deduplicated and, for a record refused by one bad field, is
 * exactly that field's code: a check whose inputs were already refused is
 * skipped rather than reported a second time (the build id is the last check and
 * is only recomputed from a record whose recipe inputs are accepted).
 *
 * @param {unknown} record parsed build.json
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function validateBuildRecord(record) {
  if (!isPlainObject(record)) {
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
  const source = isPlainObject(record.source) ? record.source : {};
  const commit = typeof source.commit === "string" && HEX40_RE.test(source.commit) ? source.commit : null;
  if (!commit) add(REASONS.SOURCE_COMMIT_INVALID);
  if (source.dirty !== false) add(REASONS.SOURCE_DIRTY);
  if (source.untracked_files !== 0) add(REASONS.SOURCE_UNTRACKED);

  // --- §2 defines: official lock, own revision, no extension list ----------
  const cmake = isPlainObject(record.cmake) ? record.cmake : {};
  const rawDefines = Array.isArray(cmake.defines) ? cmake.defines : null;
  if (!rawDefines) {
    // No usable command line at all: the lock define is what is missing.
    add(REASONS.DEFINES_LOCK_MISSING);
  } else {
    // Every entry must be one allowlisted `-D<NAME>[:<TYPE>]=<value>` token. The
    // checks below key on the parsed NAME, so a typed or otherwise respelled
    // define is judged on the variable it sets and not on its text.
    const parsed = [];
    let malformed = false;
    for (const entry of rawDefines) {
      const m = typeof entry === "string" ? DEFINE_RE.exec(entry) : null;
      // A padded token is not the token: whitespace inside a define is never
      // part of the value the build used.
      if (!m || m[2] !== m[2].trim()) {
        malformed = true;
        continue;
      }
      parsed.push({ name: m[1], value: m[2] });
    }

    if (malformed) {
      // A command line the grammar cannot read is not judged key by key: the
      // keys it seems to set are an artefact of a spelling gufo never got.
      add(REASONS.DEFINES_MALFORMED);
    } else {
      const named = (name) => parsed.filter((d) => d.name === name);

      // §2: the official lock, exactly once and switched on — an `=OFF` after an
      // `=ON` and a typed `:BOOL=OFF` are the same refusal.
      const lock = named(LOCK_VARIABLE);
      if (lock.length !== 1 || lock[0].value !== "ON") add(REASONS.DEFINES_LOCK_MISSING);

      if (commit) {
        // Only judged against a valid commit: the mismatch would repeat
        // SOURCE_COMMIT_INVALID and say nothing new. A second revision define,
        // typed or not, is a second value and therefore a mismatch.
        const revisions = named(REVISION_VARIABLE);
        if (revisions.length !== 1 || revisions[0].value !== commit) {
          add(REASONS.DEFINES_REVISION_MISMATCH);
        }
      }

      // §2: any form of an extension list is refused, typed or not, whichever
      // value it carries.
      if (FORBIDDEN_VARIABLES.some((name) => named(name).length > 0)) add(REASONS.DEFINES_FORBIDDEN);
    }
  }

  // --- extensions: lock mode, asserted twice (field + diagnose output) -----
  const ext = isPlainObject(record.extensions) ? record.extensions : {};
  const diagnoseBlock = isPlainObject(record.diagnose) ? record.diagnose : {};
  const diagnoseJson = isPlainObject(diagnoseBlock.json) ? diagnoseBlock.json : null;

  if (ext.selection_mode !== OFFICIAL_LOCK_MODE) add(REASONS.SELECTION_NOT_LOCK);
  if (!diagnoseJson || diagnoseJson.selectionMode !== OFFICIAL_LOCK_MODE) add(REASONS.SELECTION_NOT_LOCK);

  if (typeof ext.lock_file_sha256 !== "string" || !HEX64_RE.test(ext.lock_file_sha256)) {
    add(REASONS.LOCK_HASH_INVALID);
  }

  // --- the lock's names, in full, without duplicates ----------------------
  const lockNames = Array.isArray(ext.lock_names) && ext.lock_names.every((n) => typeof n === "string" && n !== "")
    ? ext.lock_names
    : null;
  const lockNamesOk = lockNames !== null && lockNames.length > 0 && new Set(lockNames).size === lockNames.length;
  if (!lockNamesOk) add(REASONS.LOCK_NAMES_INVALID);
  const lockSet = new Set(lockNamesOk ? lockNames : []);

  // --- what was built must be exactly the lock, nothing else --------------
  const rawBuilt = ext.built;
  const built = Array.isArray(rawBuilt) ? rawBuilt.filter(isPlainObject) : [];
  if (Array.isArray(rawBuilt) && rawBuilt.some((b) => !isPlainObject(b))) add(REASONS.EXTENSION_EXTRA);
  const builtNames = built.map((b) => b.name);
  if (new Set(builtNames).size !== builtNames.length) add(REASONS.EXTENSION_EXTRA);
  if (lockNamesOk) {
    if (built.some((b) => typeof b.name !== "string" || !lockSet.has(b.name))) add(REASONS.EXTENSION_EXTRA);
    for (const name of lockSet) {
      if (!built.some((b) => b.name === name)) {
        add(REASONS.EXTENSION_MISSING);
        break;
      }
    }
  }

  for (const b of built) {
    const m = typeof b.source === "string" ? EXTENSION_SOURCE_RE.exec(b.source) : null;
    if (!m || m[1] !== b.name) {
      add(REASONS.EXTENSION_SOURCE_OUTSIDE_TREE);
      break;
    }
  }

  // --- the extension API version, on both sides ---------------------------
  const apiVersion = typeof ext.api_version === "string" && ext.api_version !== "" ? ext.api_version : null;
  const diagnoseApiVersion =
    typeof diagnoseJson?.extensionApiVersion === "string" && diagnoseJson.extensionApiVersion !== ""
      ? diagnoseJson.extensionApiVersion
      : null;
  if (!apiVersion || !diagnoseApiVersion || apiVersion !== diagnoseApiVersion) {
    add(REASONS.API_VERSION_MISMATCH);
  }

  // --- the record's extension lists must be the diagnose output's ---------
  const builtRefused = reasons.includes(REASONS.EXTENSION_EXTRA) ||
    reasons.includes(REASONS.EXTENSION_MISSING) ||
    reasons.includes(REASONS.EXTENSION_SOURCE_OUTSIDE_TREE);
  if (!builtRefused && !sameExtensions(diagnoseJson?.builtExtensions, rawBuilt)) {
    add(REASONS.DIAGNOSE_EXTENSIONS_MISMATCH);
  }
  if (!sameExtensions(diagnoseJson?.excludedExtensions, ext.excluded)) {
    add(REASONS.DIAGNOSE_EXTENSIONS_MISMATCH);
  }

  // --- provider_keys must cover exactly the diagnose provider ids ---------
  const providers = Array.isArray(diagnoseJson?.providers) ? diagnoseJson.providers : null;
  const providerKeys = isPlainObject(ext.provider_keys) ? ext.provider_keys : null;

  let diagnoseIds = null;
  if (!providers) {
    add(REASONS.PROVIDER_IDS_INVALID);
  } else {
    diagnoseIds = [];
    for (const p of providers) {
      if (!isPlainObject(p) || typeof p.id !== "string" || p.id === "") {
        add(REASONS.PROVIDER_IDS_INVALID);
        continue;
      }
      if (diagnoseIds.includes(p.id)) {
        add(REASONS.PROVIDER_IDS_INVALID);
        continue;
      }
      diagnoseIds.push(p.id);
    }
  }

  const keyIds = providerKeys ? Object.keys(providerKeys) : [];
  if (diagnoseIds) {
    if (diagnoseIds.some((id) => !keyIds.includes(id))) add(REASONS.PROVIDER_KEYS_MISSING);
    if (keyIds.some((id) => !diagnoseIds.includes(id))) add(REASONS.PROVIDER_KEYS_UNKNOWN);
  }
  if (!providerKeys) {
    add(REASONS.PROVIDER_KEYS_INVALID);
  } else {
    for (const id of keyIds) {
      const own = providerKeys[id];
      // An empty list is refused too: a provider with no keys cannot be
      // collision-checked, so it cannot be accepted either.
      if (!Array.isArray(own) || own.length === 0 || own.some((k) => typeof k !== "string" || k === "")) {
        add(REASONS.PROVIDER_KEYS_INVALID);
        break;
      }
    }
  }

  // --- gufo's own check_install report ------------------------------------
  const checkInstall = isPlainObject(record.check_install) ? record.check_install : {};
  if (checkInstall.status !== "PASS") add(REASONS.CHECK_INSTALL_NOT_PASS);
  if (checkInstall.mode !== OFFICIAL_LOCK_MODE) add(REASONS.CHECK_INSTALL_NOT_LOCK);
  if (typeof checkInstall.report_sha256 !== "string" || !HEX64_RE.test(checkInstall.report_sha256)) {
    add(REASONS.REPORT_HASH_INVALID);
  }

  // --- the diagnose run itself --------------------------------------------
  if (diagnoseBlock.returncode !== 0) add(REASONS.DIAGNOSE_RETURNCODE);
  if (typeof diagnoseBlock.stdout_sha256 !== "string" || !HEX64_RE.test(diagnoseBlock.stdout_sha256)) {
    add(REASONS.DIAGNOSE_HASH_INVALID);
  }

  // --- toolchain: image pinned by digest, one flake.lock identity ----------
  const toolchain = isPlainObject(record.toolchain) ? record.toolchain : {};
  const imageReason = checkRecordImage(toolchain.nix_image);
  if (imageReason) add(imageReason);
  const flakeLockSha =
    typeof toolchain.flake_lock_sha256 === "string" && HEX64_RE.test(toolchain.flake_lock_sha256)
      ? toolchain.flake_lock_sha256
      : null;
  if (!flakeLockSha) add(REASONS.FLAKE_LOCK_HASH_INVALID);
  else if (toolchain.id !== flakeLockSha) add(REASONS.TOOLCHAIN_ID_MISMATCH);

  // --- binary: a digest, reporting the commit it was built from -----------
  const binary = isPlainObject(record.binary) ? record.binary : {};
  if (typeof binary.sha256 !== "string" || !HEX64_RE.test(binary.sha256)) {
    add(REASONS.BINARY_HASH_INVALID);
  }
  if (commit) {
    const versionOutput = typeof binary.version_output === "string" ? binary.version_output : "";
    if (!mentionsCommit(versionOutput, commit)) add(REASONS.BINARY_VERSION_MISSING_COMMIT);
  }

  // --- the id names this exact recipe, so recompute it --------------------
  // Only judged when the fields it hashes were not refused above: the record is
  // otherwise self-contradictory in a way the other codes already name.
  if (!ID_INPUT_REASONS.some((code) => reasons.includes(code))) {
    let computed = null;
    try {
      computed = computeBuildId({
        version: source.version_txt,
        commit: source.commit,
        recipe: record.recipe,
        lock_file_sha256: ext.lock_file_sha256,
        flake_lock_sha256: toolchain.flake_lock_sha256,
        nix_image: toolchain.nix_image,
        rocr_library_dir: toolchain.rocr_library_dir,
        defines: cmake.defines,
        mode: OFFICIAL_LOCK_MODE,
      });
    } catch {
      // A field the id cannot be built from is a bad id, not a bad input here.
      computed = null;
    }
    if (computed === null || computed !== record.build_id) add(REASONS.BUILD_ID_INVALID);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * A one-line rendering for a record that is shown but never launched — the
 * `trust: "unrecorded"` shape an `import-legacy` writes, and status panels.
 *
 * It carries no path, no host label, no user and no hash past 12 hex: the build
 * id, the trust level, the commit prefix, the extension count and the binary
 * digest prefix only. The build id is printed only when it is the full build id
 * (which may carry dots in its version) or a plain dot-free id, and never a
 * path, a host name or a label; the trust level is mapped onto the two known
 * values, so a new or a garbage trust string is shown as "unrecorded". Tolerates
 * a partial or garbage record (a legacy directory has almost nothing) and never
 * throws.
 *
 * @param {unknown} record
 * @returns {string}
 */
export function displayBuildRecord(record) {
  const r = isPlainObject(record) ? record : {};
  const rawId = typeof r.build_id === "string" ? r.build_id : "";
  // A dot is not printed on the strength of the plain-id pattern alone: only a
  // full build id may carry one (its version part does), so `host.example` or a
  // file name is shown as "build unknown" rather than echoed.
  const id = BUILD_ID_RE.test(rawId) || DISPLAY_ID_RE.test(rawId) ? rawId : "build unknown";
  const trust = typeof r.trust === "string" && DISPLAY_TRUSTS.includes(r.trust) ? r.trust : "unrecorded";
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
