/**
 * gufo build record — schema v1 validator, build id, provider-collision and
 * selectionMode checks (servers/shared/gufo-build-record.js).
 *
 * Every refusal test is a ONE-FIELD mutation of the golden record in
 * tests/fixtures/gufo/golden-record.mjs and asserts the whole `reasons` array, so
 * a test cannot pass by tripping some other check. The diagnose sample used by
 * the SELECTION_NOT_LOCK test is the real v0.29.0 output, pinned by sha256.
 *
 * Pure: no fs writes, no network, no container, no nix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  REASONS,
  BUILD_ID_RE,
  SCHEMA_VERSION,
  RECIPE_CMAKE_IN_NIX,
  OFFICIAL_TRUST,
  validateBuildRecord,
  computeBuildId,
  collisionCheck,
  selectionModeCheck,
  checkRecordImage,
  displayBuildRecord,
} from "../servers/shared/gufo-build-record.js";
import { goldenRecord, goldenBuildIdInputs, REAL_DIAGNOSE } from "./fixtures/gufo/golden-record.mjs";

/** sha256 of tests/fixtures/gufo/diagnose-v029-discovery.json, byte-identical to the gufo output. */
const FIXTURE_SHA256 = "47e2b0dc074fb73e32431b9a9db15d328a855c30fc3fce3e4b51ce32d1229875";

const LOCK_DEFINE = "-DGUFO_EXTENSIONS_FROM_LOCK=ON";
const revisionDefines = (record) => record.cmake.defines.filter((d) => d.startsWith("-DGUFO_REVISION="));

const golden = () => goldenRecord();
const reasonsOf = (record) => validateBuildRecord(record).reasons;
const provider = (id, extra = {}) => ({ id, extension: "ext", available: true, reason: "", ...extra });

// --- the fixture itself ------------------------------------------------------

test("the committed diagnose sample is the real v0.29.0 output (pinned sha256)", () => {
  const bytes = readFileSync(new URL("./fixtures/gufo/diagnose-v029-discovery.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), FIXTURE_SHA256);
  assert.equal(REAL_DIAGNOSE.selectionMode, "discovery");
  assert.equal(REAL_DIAGNOSE.builtExtensions.length, 8);
});

// --- the golden record -------------------------------------------------------

test("the golden record passes: lock mode, official lock, clean tree, PASS", () => {
  const record = golden();
  assert.deepEqual(validateBuildRecord(record), { ok: true, reasons: [] });
  assert.equal(record.schema, SCHEMA_VERSION);
  assert.equal(record.recipe, RECIPE_CMAKE_IN_NIX);
  assert.equal(record.trust, OFFICIAL_TRUST);
  assert.equal(record.extensions.selection_mode, "lock");
  assert.equal(record.diagnose.json.selectionMode, "lock");
  assert.match(record.source.commit, /^[0-9a-f]{40}$/);
  assert.match(record.build_id, BUILD_ID_RE);
  assert.deepEqual(record.extensions.lock_names, record.extensions.built.map((b) => b.name));
  assert.deepEqual(
    Object.keys(record.extensions.provider_keys).sort(),
    record.diagnose.json.providers.map((p) => p.id).sort(),
  );
  // §2: the lock define once, the record's own commit once, nothing else
  assert.equal(record.cmake.defines.filter((d) => d === LOCK_DEFINE).length, 1);
  assert.deepEqual(revisionDefines(record), [`-DGUFO_REVISION=${record.source.commit}`]);
  assert.equal(
    record.cmake.defines.some((d) => d.startsWith("-DGUFO_EXTENSIONS=") || d.startsWith("-DGUFO_EXTENSION_DIRS=")),
    false,
  );
  // the record's extension lists are the diagnose output's
  assert.deepEqual(record.diagnose.json.builtExtensions, record.extensions.built);
  assert.deepEqual(record.diagnose.json.excludedExtensions, record.extensions.excluded);
  assert.equal(record.toolchain.id, record.toolchain.flake_lock_sha256);
  assert.equal(record.diagnose.returncode, 0);
});

test("the golden build id is the one its own recipe inputs produce", () => {
  assert.equal(golden().build_id, computeBuildId(goldenBuildIdInputs()));
});

test("the golden build id is recomputed from the record's own fields", () => {
  const record = golden();
  assert.equal(record.build_id, computeBuildId({
    version: record.source.version_txt,
    commit: record.source.commit,
    recipe: record.recipe,
    lock_file_sha256: record.extensions.lock_file_sha256,
    flake_lock_sha256: record.toolchain.flake_lock_sha256,
    nix_image: record.toolchain.nix_image,
    rocr_library_dir: record.toolchain.rocr_library_dir,
    defines: record.cmake.defines,
    mode: "lock",
  }));
});

test("the golden record's provider keys have no collision", () => {
  const record = golden();
  assert.deepEqual(
    collisionCheck(record.diagnose.json.providers, record.extensions.provider_keys),
    { ok: true, reasons: [] },
  );
});

// --- one-field refusals ------------------------------------------------------

const ONE_FIELD_REFUSALS = [
  ["a dirty source tree", (r) => { r.source.dirty = true; }, REASONS.SOURCE_DIRTY],
  ["untracked files in the source tree", (r) => { r.source.untracked_files = 1; }, REASONS.SOURCE_UNTRACKED],
  ["a commit that is not 40 hex", (r) => { r.source.commit = "0123456"; }, REASONS.SOURCE_COMMIT_INVALID],
  ["a binary reporting an unset revision", (r) => { r.binary.version_output = "gufo development (unknown)"; }, REASONS.BINARY_VERSION_MISSING_COMMIT],

  // §2 cmake command line
  ["cmake defines without the lock define", (r) => {
    r.cmake.defines = r.cmake.defines.filter((d) => d !== LOCK_DEFINE);
  }, REASONS.DEFINES_LOCK_MISSING],
  ["a duplicated lock define", (r) => { r.cmake.defines.push(LOCK_DEFINE); }, REASONS.DEFINES_LOCK_MISSING],
  ["a revision define naming another commit", (r) => {
    r.cmake.defines[1] = `-DGUFO_REVISION=${"f".repeat(40)}`;
  }, REASONS.DEFINES_REVISION_MISMATCH],
  ["a missing revision define", (r) => { r.cmake.defines.splice(1, 1); }, REASONS.DEFINES_REVISION_MISMATCH],
  ["a duplicated revision define", (r) => { r.cmake.defines.push(r.cmake.defines[1]); }, REASONS.DEFINES_REVISION_MISMATCH],
  ["an extension list on the cmake command line", (r) => {
    r.cmake.defines.push("-DGUFO_EXTENSIONS=qwen");
  }, REASONS.DEFINES_FORBIDDEN],
  ["an extension directory list on the cmake command line", (r) => {
    r.cmake.defines.push("-DGUFO_EXTENSION_DIRS=src/models");
  }, REASONS.DEFINES_FORBIDDEN],

  ["a failed check_install", (r) => { r.check_install.status = "FAIL"; }, REASONS.CHECK_INSTALL_NOT_PASS],
  ["check_install run in another mode", (r) => { r.check_install.mode = "discovery"; }, REASONS.CHECK_INSTALL_NOT_LOCK],
  ["a check_install report digest of the wrong shape", (r) => { r.check_install.report_sha256 = "not-a-digest"; }, REASONS.REPORT_HASH_INVALID],
  ["a diagnose run that exited non-zero", (r) => { r.diagnose.returncode = 1; }, REASONS.DIAGNOSE_RETURNCODE],
  ["a diagnose stdout digest of the wrong shape", (r) => { r.diagnose.stdout_sha256 = "d".repeat(63); }, REASONS.DIAGNOSE_HASH_INVALID],

  ["an unrecorded-legacy trust level", (r) => { r.trust = "unrecorded"; }, REASONS.TRUST_NOT_OFFICIAL],
  ["a community trust level", (r) => { r.trust = "community-lock"; }, REASONS.TRUST_NOT_OFFICIAL],

  ["a nix image on a floating tag", (r) => { r.toolchain.nix_image = "docker.io/nixos/nix:latest"; }, REASONS.IMAGE_FLOATING_TAG],
  ["a nix image pinned by tag only", (r) => { r.toolchain.nix_image = "docker.io/nixos/nix:2.24"; }, REASONS.IMAGE_NOT_DIGEST_PINNED],
  ["a nix image with a truncated digest", (r) => { r.toolchain.nix_image = `docker.io/nixos/nix@sha256:${"9".repeat(32)}`; }, REASONS.IMAGE_NOT_DIGEST_PINNED],
  ["a flake lock digest of the wrong shape", (r) => { r.toolchain.flake_lock_sha256 = "b".repeat(63); }, REASONS.FLAKE_LOCK_HASH_INVALID],
  ["a toolchain id that is not the flake lock digest", (r) => { r.toolchain.id = "a".repeat(64); }, REASONS.TOOLCHAIN_ID_MISMATCH],

  ["an extension that the lock does not name", (r) => {
    r.extensions.built.push({ name: "community_thing", version: "0.1.0", source: "src/models/community_thing" });
  }, REASONS.EXTENSION_EXTRA],
  ["a built entry that is not an object", (r) => { r.extensions.built.push("community_thing"); }, REASONS.EXTENSION_EXTRA],
  ["two built entries with the same name", (r) => { r.extensions.built.push({ ...r.extensions.built[0] }); }, REASONS.EXTENSION_EXTRA],
  ["a lock name that is not a string", (r) => { r.extensions.lock_names[0] = 7; }, REASONS.LOCK_NAMES_INVALID],
  ["an empty lock name", (r) => { r.extensions.lock_names[0] = ""; }, REASONS.LOCK_NAMES_INVALID],
  ["a duplicate lock name", (r) => { r.extensions.lock_names.push(r.extensions.lock_names[0]); }, REASONS.LOCK_NAMES_INVALID],
  ["an empty lock name list", (r) => { r.extensions.lock_names = []; }, REASONS.LOCK_NAMES_INVALID],
  ["a lock name missing from the built set", (r) => { r.extensions.built.pop(); }, REASONS.EXTENSION_MISSING],
  ["a built extension sourced from outside the official tree", (r) => { r.extensions.built[0].source = "third_party/deepseek_v4_flash"; }, REASONS.EXTENSION_SOURCE_OUTSIDE_TREE],
  ["a built extension at another extension's tree path", (r) => { r.extensions.built[0].source = "src/models/qwen"; }, REASONS.EXTENSION_SOURCE_OUTSIDE_TREE],

  // the record's extension lists versus the diagnose output's
  ["a built extension version diagnose does not report", (r) => {
    r.extensions.built[0].version = "0.2.0";
  }, REASONS.DIAGNOSE_EXTENSIONS_MISMATCH],
  ["a built extension version the record does not report", (r) => {
    r.diagnose.json.builtExtensions.find((e) => e.name === "qwen").version = "0.2.0";
  }, REASONS.DIAGNOSE_EXTENSIONS_MISMATCH],
  ["a built extension diagnose reports and the record does not", (r) => {
    r.diagnose.json.builtExtensions.push({ name: "community_thing", version: "0.1.0", source: "src/models/community_thing" });
  }, REASONS.DIAGNOSE_EXTENSIONS_MISMATCH],
  ["a built extension the record lists and diagnose does not", (r) => {
    r.diagnose.json.builtExtensions.pop();
  }, REASONS.DIAGNOSE_EXTENSIONS_MISMATCH],
  ["an exclusion diagnose reports and the record does not", (r) => {
    r.diagnose.json.excludedExtensions.push({ name: "qwen", version: "0.1.0", source: "src/models/qwen" });
  }, REASONS.DIAGNOSE_EXTENSIONS_MISMATCH],
  ["an exclusion the record lists and diagnose does not", (r) => {
    r.extensions.excluded.push({ name: "qwen", version: "0.1.0", source: "src/models/qwen" });
  }, REASONS.DIAGNOSE_EXTENSIONS_MISMATCH],

  // provider keys
  ["a provider key list that is not an array", (r) => { r.extensions.provider_keys.deepseek4 = "gguf:deepseek4"; }, REASONS.PROVIDER_KEYS_INVALID],
  ["an empty provider key list", (r) => { r.extensions.provider_keys.deepseek4 = []; }, REASONS.PROVIDER_KEYS_INVALID],
  ["a non-string provider key", (r) => { r.extensions.provider_keys.deepseek4 = ["gguf:deepseek4", 7]; }, REASONS.PROVIDER_KEYS_INVALID],
  ["an empty provider key", (r) => { r.extensions.provider_keys.deepseek4 = ["gguf:deepseek4", ""]; }, REASONS.PROVIDER_KEYS_INVALID],
  ["a diagnose provider with no recorded keys", (r) => { delete r.extensions.provider_keys["deepseek4"]; }, REASONS.PROVIDER_KEYS_MISSING],
  ["recorded keys for a provider diagnose does not list", (r) => { r.extensions.provider_keys.ghost = ["gguf:ghost"]; }, REASONS.PROVIDER_KEYS_UNKNOWN],
  ["a diagnose provider listed twice", (r) => {
    r.diagnose.json.providers.push({ ...r.diagnose.json.providers[0] });
  }, REASONS.PROVIDER_IDS_INVALID],
  ["a diagnose output with no provider list", (r) => { delete r.diagnose.json.providers; }, REASONS.PROVIDER_IDS_INVALID],

  ["an API version the record does not report", (r) => { delete r.extensions.api_version; }, REASONS.API_VERSION_MISMATCH],
  ["an API version that disagrees with diagnose", (r) => { r.extensions.api_version = "0.0.0"; }, REASONS.API_VERSION_MISMATCH],

  // the build id names the record's own recipe
  ["a build id naming another recipe build", (r) => {
    r.build_id = `gufo-${r.source.version_txt}-${r.source.commit.slice(0, 7)}-lock-ffffffff`;
  }, REASONS.BUILD_ID_INVALID],
  ["a cmake define added after the id was computed", (r) => {
    r.cmake.defines.push("-DCMAKE_BUILD_TYPE=Debug");
  }, REASONS.BUILD_ID_INVALID],
  ["a lock digest replaced after the id was computed", (r) => {
    r.extensions.lock_file_sha256 = "a".repeat(63) + "1";
  }, REASONS.BUILD_ID_INVALID],
  ["a rocr library dir the id was not computed from", (r) => {
    r.toolchain.rocr_library_dir = `${r.toolchain.rocr_library_dir}-other`;
  }, REASONS.BUILD_ID_INVALID],
  ["a version file the id cannot be built from", (r) => { r.source.version_txt = "v0.29.0"; }, REASONS.BUILD_ID_INVALID],
  ["a build id that is missing", (r) => { delete r.build_id; }, REASONS.BUILD_ID_INVALID],

  ["a binary digest of the wrong shape", (r) => { r.binary.sha256 = "f".repeat(63); }, REASONS.BINARY_HASH_INVALID],

  ["a recipe that is not the v1 recipe", (r) => { r.recipe = "nix-build-derivation"; }, REASONS.RECIPE_UNKNOWN],
  ["an invented recipe name", (r) => { r.recipe = "cmake"; }, REASONS.RECIPE_UNKNOWN],
  ["a discovery-mode selection", (r) => { r.extensions.selection_mode = "discovery"; }, REASONS.SELECTION_NOT_LOCK],
  ["an explicit-mode selection", (r) => { r.extensions.selection_mode = "explicit"; }, REASONS.SELECTION_NOT_LOCK],
  ["a build id that is not an id", (r) => { r.build_id = "gufo-0.29.0-0123456"; }, REASONS.BUILD_ID_INVALID],
  ["an unknown record schema", (r) => { r.schema = 2; }, REASONS.SCHEMA_UNSUPPORTED],
  ["a lock digest of the wrong shape", (r) => { r.extensions.lock_file_sha256 = "not-a-digest"; }, REASONS.LOCK_HASH_INVALID],
];

for (const [name, mutate, code] of ONE_FIELD_REFUSALS) {
  test(`refuses ${name}: exactly ${code}`, () => {
    const record = golden();
    mutate(record);
    const result = validateBuildRecord(record);
    assert.equal(result.ok, false);
    assert.deepEqual(result.reasons, [code]);
  });
}

test("refuses cmake defines that are not an array of strings", () => {
  for (const bad of [LOCK_DEFINE, [LOCK_DEFINE, 7], null, {}]) {
    const record = golden();
    record.cmake.defines = bad;
    assert.deepEqual(reasonsOf(record), [REASONS.DEFINES_LOCK_MISSING], JSON.stringify(bad));
  }
});

test("refuses a provider_keys block that is not a plain object", () => {
  for (const bad of [null, ["gguf:deepseek4"], "gguf:deepseek4", 7]) {
    const record = golden();
    record.extensions.provider_keys = bad;
    assert.deepEqual(
      reasonsOf(record),
      [REASONS.PROVIDER_KEYS_MISSING, REASONS.PROVIDER_KEYS_INVALID],
      JSON.stringify(bad),
    );
  }
});

test("the extension API version must be a non-empty string on both sides", () => {
  const bothMissing = golden();
  delete bothMissing.extensions.api_version;
  delete bothMissing.diagnose.json.extensionApiVersion;
  assert.deepEqual(reasonsOf(bothMissing), [REASONS.API_VERSION_MISMATCH]);

  const bothEmpty = golden();
  bothEmpty.extensions.api_version = "";
  bothEmpty.diagnose.json.extensionApiVersion = "";
  assert.deepEqual(reasonsOf(bothEmpty), [REASONS.API_VERSION_MISMATCH]);

  const diagnoseEmpty = golden();
  diagnoseEmpty.diagnose.json.extensionApiVersion = "";
  assert.deepEqual(reasonsOf(diagnoseEmpty), [REASONS.API_VERSION_MISMATCH]);
});

test("the extension lists are compared by name, not by order", () => {
  const record = golden();
  record.extensions.built.reverse();
  record.diagnose.json.builtExtensions.reverse();
  assert.deepEqual(validateBuildRecord(record), { ok: true, reasons: [] });

  const excluded = golden();
  const exclusion = { name: "qwen", version: "0.1.0", source: "src/models/qwen" };
  excluded.extensions.excluded = [exclusion, { ...exclusion, name: "qwen3_tts" }];
  excluded.diagnose.json.excludedExtensions = [{ ...exclusion, name: "qwen3_tts" }, exclusion];
  assert.deepEqual(validateBuildRecord(excluded), { ok: true, reasons: [] });
});

test("refuses the real discovery-mode diagnose output: exactly SELECTION_NOT_LOCK", () => {
  const record = golden();
  record.diagnose.json = structuredClone(REAL_DIAGNOSE);
  const result = validateBuildRecord(record);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [REASONS.SELECTION_NOT_LOCK]);
});

test("validateBuildRecord fails closed on anything that is not a record object", () => {
  for (const bad of [null, undefined, [], "record", 7, true]) {
    assert.deepEqual(validateBuildRecord(bad), { ok: false, reasons: [REASONS.RECORD_NOT_OBJECT] }, JSON.stringify(bad));
  }
  assert.deepEqual(reasonsOf({}), [
    REASONS.SCHEMA_UNSUPPORTED,
    REASONS.RECIPE_UNKNOWN,
    REASONS.TRUST_NOT_OFFICIAL,
    REASONS.BUILD_ID_INVALID,
    REASONS.SOURCE_COMMIT_INVALID,
    REASONS.SOURCE_DIRTY,
    REASONS.SOURCE_UNTRACKED,
    REASONS.DEFINES_LOCK_MISSING,
    REASONS.SELECTION_NOT_LOCK,
    REASONS.LOCK_HASH_INVALID,
    REASONS.LOCK_NAMES_INVALID,
    REASONS.API_VERSION_MISMATCH,
    REASONS.DIAGNOSE_EXTENSIONS_MISMATCH,
    REASONS.PROVIDER_IDS_INVALID,
    REASONS.PROVIDER_KEYS_INVALID,
    REASONS.CHECK_INSTALL_NOT_PASS,
    REASONS.CHECK_INSTALL_NOT_LOCK,
    REASONS.REPORT_HASH_INVALID,
    REASONS.DIAGNOSE_RETURNCODE,
    REASONS.DIAGNOSE_HASH_INVALID,
    REASONS.IMAGE_NOT_DIGEST_PINNED,
    REASONS.FLAKE_LOCK_HASH_INVALID,
    REASONS.BINARY_HASH_INVALID,
  ]);
});

// --- collision (private engineering notes §10) -------------------------------

test("collision: a shared NON-FIRST key is refused and the reason names the key", () => {
  const providers = [provider("qwen27-q4"), provider("qwen27-q8")];
  const keys = {
    "qwen27-q4": ["gguf:qwen", "gguf:qwen27"],
    "qwen27-q8": ["gguf:qwen27q8", "gguf:qwen27"],
  };
  assert.deepEqual(collisionCheck(providers, keys), {
    ok: false,
    reasons: [`${REASONS.PROVIDER_KEY_COLLISION}:gguf:qwen27`],
  });
});

test("collision: the same overlapping pair is refused in both orders", () => {
  const a = provider("flash-next-q4");
  const b = provider("flash-next-q8");
  const keys = {
    "flash-next-q4": ["gguf:qwen4exp", "gguf:qwen4"],
    "flash-next-q8": ["gguf:qwen4"],
  };
  const want = [`${REASONS.PROVIDER_KEY_COLLISION}:gguf:qwen4`];
  assert.deepEqual(collisionCheck([a, b], keys).reasons, want);
  assert.deepEqual(collisionCheck([b, a], keys).reasons, want);
});

test("collision: an UNAVAILABLE provider's key still counts", () => {
  const providers = [
    provider("deepseek4"),
    provider("deepseek4-exp", { available: false, reason: "probe declined" }),
  ];
  const keys = {
    "deepseek4": ["gguf:deepseek4", "gguf:deepseek"],
    "deepseek4-exp": ["gguf:deepseek"],
  };
  assert.deepEqual(collisionCheck(providers, keys), {
    ok: false,
    reasons: [`${REASONS.PROVIDER_KEY_COLLISION}:gguf:deepseek`],
  });
});

test("collision: no overlap passes, and every colliding key is named once, sorted", () => {
  const providers = [provider("qwen27-q4"), provider("qwen27-q8")];
  assert.deepEqual(
    collisionCheck(providers, { "qwen27-q4": ["gguf:a"], "qwen27-q8": ["gguf:b"] }),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(
    collisionCheck(providers, { "qwen27-q4": ["gguf:z", "gguf:a"], "qwen27-q8": ["gguf:z", "gguf:a"] }),
    {
      ok: false,
      reasons: [`${REASONS.PROVIDER_KEY_COLLISION}:gguf:a`, `${REASONS.PROVIDER_KEY_COLLISION}:gguf:z`],
    },
  );
});

test("collision: a repeated key inside one provider is not a collision", () => {
  assert.deepEqual(
    collisionCheck([provider("qwen27-q4")], { "qwen27-q4": ["gguf:qwen27", "gguf:qwen27"] }),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(collisionCheck([provider("a"), provider("b")], { a: [], b: [] }), { ok: true, reasons: [] });
});

test("collision fails CLOSED on a shape it cannot judge", () => {
  // neither side usable: both are refusals, not an empty pass
  assert.deepEqual(collisionCheck(undefined, undefined), {
    ok: false,
    reasons: [REASONS.PROVIDER_IDS_INVALID, REASONS.PROVIDER_KEYS_INVALID],
  });
  assert.deepEqual(collisionCheck("providers", {}).reasons, [REASONS.PROVIDER_IDS_INVALID]);
  assert.deepEqual(collisionCheck([], "keys").reasons, [REASONS.PROVIDER_KEYS_INVALID]);
  assert.deepEqual(collisionCheck([], new Map()).reasons, [REASONS.PROVIDER_KEYS_INVALID]);
  assert.deepEqual(collisionCheck([{ id: 7 }], {}), { ok: false, reasons: [REASONS.PROVIDER_IDS_INVALID] });
  assert.deepEqual(collisionCheck([null, provider("a")], { a: ["gguf:a"] }).reasons, [REASONS.PROVIDER_IDS_INVALID]);
});

test("collision: a listed provider with no key list is a refusal naming the id", () => {
  assert.deepEqual(collisionCheck([provider("a")], {}), {
    ok: false,
    reasons: [`${REASONS.PROVIDER_KEYS_MISSING}:a`],
  });
  assert.deepEqual(collisionCheck([provider("a"), provider("b")], { a: ["gguf:a"] }).reasons, [
    `${REASONS.PROVIDER_KEYS_MISSING}:b`,
  ]);
  assert.deepEqual(collisionCheck([provider("a")], { a: "gguf:a" }).reasons, [
    `${REASONS.PROVIDER_KEYS_MISSING}:a`,
  ]);
});

// --- selectionMode -----------------------------------------------------------

test("selectionModeCheck: only \"lock\" passes, from the JSON or the diagnose block", () => {
  assert.deepEqual(selectionModeCheck(REAL_DIAGNOSE), { ok: false, reasons: [REASONS.SELECTION_NOT_LOCK] });
  assert.deepEqual(selectionModeCheck({ json: REAL_DIAGNOSE }), { ok: false, reasons: [REASONS.SELECTION_NOT_LOCK] });
  assert.deepEqual(selectionModeCheck({ selectionMode: "explicit" }), { ok: false, reasons: [REASONS.SELECTION_NOT_LOCK] });
  assert.deepEqual(selectionModeCheck(undefined), { ok: false, reasons: [REASONS.SELECTION_NOT_LOCK] });
  assert.deepEqual(selectionModeCheck({ selectionMode: "lock" }), { ok: true, reasons: [] });
  assert.deepEqual(selectionModeCheck({ json: { selectionMode: "lock" } }), { ok: true, reasons: [] });
});

// --- the image check on its own ---------------------------------------------

test("checkRecordImage: a digest pins the image, a tag does not", () => {
  const digest = `@sha256:${"9".repeat(64)}`;
  assert.equal(checkRecordImage(`docker.io/nixos/nix${digest}`), null);
  assert.equal(checkRecordImage(`docker.io/nixos/nix:2.24${digest}`), null);
  assert.equal(checkRecordImage("docker.io/nixos/nix:latest"), REASONS.IMAGE_FLOATING_TAG);
  assert.equal(checkRecordImage("docker.io/nixos/nix:2.24"), REASONS.IMAGE_NOT_DIGEST_PINNED);
  assert.equal(checkRecordImage(`docker.io/nixos/nix@sha256:${"9".repeat(12)}`), REASONS.IMAGE_NOT_DIGEST_PINNED);
  assert.equal(checkRecordImage(""), REASONS.IMAGE_NOT_DIGEST_PINNED);
  assert.equal(checkRecordImage("   "), REASONS.IMAGE_NOT_DIGEST_PINNED);
  assert.equal(checkRecordImage(undefined), REASONS.IMAGE_NOT_DIGEST_PINNED);
  assert.equal(checkRecordImage(42), REASONS.IMAGE_NOT_DIGEST_PINNED);
});

// --- the commit reported by --version ---------------------------------------

test("the --version commit match is anchored, and both forms are accepted", () => {
  const abbreviated = golden();
  abbreviated.binary.version_output = `gufo ${abbreviated.source.version_txt} (${abbreviated.source.commit.slice(0, 7)})`;
  assert.deepEqual(validateBuildRecord(abbreviated), { ok: true, reasons: [] });

  // only the full 40-hex form: the 7-hex branch cannot carry this one, so the
  // full-commit branch is what accepts it
  const full = golden();
  full.binary.version_output = `gufo revision ${full.source.commit}`;
  assert.deepEqual(validateBuildRecord(full), { ok: true, reasons: [] });

  // a longer hex run is not the commit: neither form names it
  const embedded = golden();
  embedded.binary.version_output = `gufo revision ${embedded.source.commit}0`;
  assert.deepEqual(reasonsOf(embedded), [REASONS.BINARY_VERSION_MISSING_COMMIT]);

  const embeddedShort = golden();
  embeddedShort.binary.version_output = `gufo revision ${embeddedShort.source.commit.slice(0, 7)}0`;
  assert.deepEqual(reasonsOf(embeddedShort), [REASONS.BINARY_VERSION_MISSING_COMMIT]);
});

// --- build id ----------------------------------------------------------------

test("computeBuildId: equal inputs give an equal id, define order included", () => {
  const inputs = goldenBuildIdInputs();
  const id = computeBuildId(inputs);
  assert.equal(id, computeBuildId({ ...inputs }));
  assert.equal(id, computeBuildId({ ...inputs, defines: [...inputs.defines].reverse() }));
});

test("computeBuildId hashes its inputs as a list, not as a joined string", () => {
  const inputs = goldenBuildIdInputs();
  const oneDefine = computeBuildId({ ...inputs, defines: ["a\nb"] });
  const twoDefines = computeBuildId({ ...inputs, defines: ["a", "b"] });
  assert.notEqual(oneDefine, twoDefines);
  assert.notEqual(computeBuildId({ ...inputs, defines: ["a\0b"] }), computeBuildId({ ...inputs, defines: ["a", "\0b"] }));
});

const ID_INPUT_MUTATIONS = [
  ["version", (i) => { i.version = "0.30.0"; }],
  ["commit", (i) => { i.commit = "f".repeat(40); }],
  ["recipe", (i) => { i.recipe = "nix-build-derivation"; }],
  ["lock_file_sha256", (i) => { i.lock_file_sha256 = "a".repeat(63) + "0"; }],
  ["flake_lock_sha256", (i) => { i.flake_lock_sha256 = "b".repeat(63) + "0"; }],
  ["nix_image", (i) => { i.nix_image = `docker.io/nixos/nix@sha256:${"8".repeat(64)}`; }],
  ["rocr_library_dir", (i) => { i.rocr_library_dir = `${i.rocr_library_dir}-other`; }],
  ["defines", (i) => { i.defines = [...i.defines, "-DCMAKE_BUILD_TYPE=Debug"]; }],
  ["mode", (i) => { i.mode = "explicit"; }],
];

for (const [name, mutate] of ID_INPUT_MUTATIONS) {
  test(`computeBuildId changes when ${name} changes`, () => {
    const inputs = goldenBuildIdInputs();
    const before = computeBuildId(inputs);
    mutate(inputs);
    const after = computeBuildId(inputs);
    assert.notEqual(after, before);
    assert.match(after, BUILD_ID_RE);
  });
}

test("computeBuildId refuses inputs it cannot identify a build by", () => {
  assert.throws(() => computeBuildId(), TypeError);
  assert.throws(() => computeBuildId({}), TypeError);
  assert.throws(() => computeBuildId({ ...goldenBuildIdInputs(), version: "" }), TypeError);
  assert.throws(() => computeBuildId({ ...goldenBuildIdInputs(), commit: "0123456" }), TypeError);
  assert.throws(() => computeBuildId({ ...goldenBuildIdInputs(), commit: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" }), TypeError);
  assert.throws(() => computeBuildId({ ...goldenBuildIdInputs(), defines: null }), TypeError);
  assert.throws(() => computeBuildId({ ...goldenBuildIdInputs(), defines: [""] }), TypeError);
  assert.throws(() => computeBuildId({ ...goldenBuildIdInputs(), nix_image: 7 }), TypeError);
});

test("the build id format is exact: version, commit7, mode, recipe8", () => {
  const record = golden();
  const id = record.build_id;
  assert.ok(id.startsWith(`gufo-0.29.0-${record.source.commit.slice(0, 7)}-lock-`), id);
  assert.equal(id.length, "gufo-0.29.0-0123456-lock-".length + 8);
  for (const bad of [
    "",
    "gufo",
    "gufo-0.29.0-0123456-lock",
    "gufo-0.29.0-0123456-lock-0123456",
    "gufo-0.29.0-0123456-lock-0123456789",
    "gufo-0.29.0-0123456-lock-0123456789AB",
    "GUFO-0.29.0-0123456-lock-01234567",
    "gufo-0.29.0-zzzzzzz-lock-01234567",
    "gufo-0.29.0-0123456-other-01234567",
  ]) {
    assert.equal(BUILD_ID_RE.test(bad), false, bad);
  }
});

test("the build id carries no host, path, user or whitespace", () => {
  const record = golden();
  const id = computeBuildId(goldenBuildIdInputs());
  for (const ch of ["/", "\\", "@", " ", "\t", "\n", ":"]) {
    assert.equal(id.includes(ch), false, `id holds ${JSON.stringify(ch)}: ${id}`);
  }
  const identity = [
    record.builder.host_label,
    record.builder.user,
    record.source.repo,
    record.binary.path,
    record.toolchain.rocr_library_dir,
    record.toolchain.nix_image,
    "home",
  ];
  for (const value of identity) {
    assert.equal(id.includes(value), false, `id holds ${JSON.stringify(value)}`);
  }
});

// --- display only: trust "unrecorded" ---------------------------------------

test("a trust \"unrecorded\" record never passes the launch gate", () => {
  const record = golden();
  record.trust = "unrecorded";
  const result = validateBuildRecord(record);
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [REASONS.TRUST_NOT_OFFICIAL]);
});

test("displayBuildRecord renders an unrecorded record without a path, host or user", () => {
  const record = golden();
  record.trust = "unrecorded";
  const line = displayBuildRecord(record);

  assert.equal(typeof line, "string");
  assert.ok(line.includes(record.build_id));
  assert.ok(line.includes("unrecorded"));
  assert.ok(line.includes(record.source.commit.slice(0, 7)));
  assert.ok(line.includes(record.binary.sha256.slice(0, 12)));
  assert.ok(line.includes("not launchable"));

  assert.equal(line.includes("/"), false, line);
  assert.equal(line.includes("\\"), false, line);
  assert.equal(line.includes(record.builder.host_label), false, line);
  assert.equal(line.includes(record.builder.user), false, line);
  assert.equal(line.includes(record.check_install.report_path), false, line);
  assert.equal(line.includes(record.toolchain.rocr_library_dir), false, line);

  // a hash is shown only as its 12-hex prefix
  assert.equal(line.includes(record.binary.sha256.slice(12)), false, line);
});

test("displayBuildRecord prints a build id only when it is a plain id", () => {
  for (const bad of ["/opt/gufo/builds/current", "opt/gufo", "build dir", " build-dir", "g".repeat(65), ""]) {
    const line = displayBuildRecord({ build_id: bad, trust: "unrecorded" });
    assert.ok(line.includes("build unknown"), line);
    if (bad !== "") assert.equal(line.includes(bad), false, line);
  }
  // a plain legacy id is printed as it is
  assert.ok(displayBuildRecord({ build_id: "legacy-example" }).includes("legacy-example"));
  assert.ok(displayBuildRecord({ build_id: "gufo-0.29.0-0123456-lock-01234567" }).includes("gufo-0.29.0-0123456-lock-01234567"));
});

test("displayBuildRecord maps trust onto the known set", () => {
  assert.ok(displayBuildRecord({ build_id: "legacy-example", trust: "unrecorded" }).includes("unrecorded"));
  assert.ok(displayBuildRecord({ build_id: "legacy-example", trust: "official-lock" }).includes("official-lock"));

  const official = displayBuildRecord({ build_id: "legacy-example", trust: "official-lock" });
  assert.equal(official.includes("not launchable"), false, official);

  for (const bad of ["community-lock", "official", "unrecorded-ish", 7, {}, null]) {
    const line = displayBuildRecord({ build_id: "legacy-example", trust: bad });
    assert.ok(line.includes("unrecorded"), line);
    assert.ok(line.includes("not launchable"), line);
  }
});

test("displayBuildRecord tolerates a legacy directory that has almost nothing", () => {
  assert.equal(typeof displayBuildRecord(undefined), "string");
  assert.equal(typeof displayBuildRecord(null), "string");
  assert.equal(typeof displayBuildRecord([]), "string");
  assert.equal(typeof displayBuildRecord({}), "string");

  const legacy = { build_id: "legacy-example", trust: "unrecorded", binary: { path: "/opt/gufo/gufo" } };
  const line = displayBuildRecord(legacy);
  assert.ok(line.includes("legacy-example"));
  assert.ok(line.includes("unrecorded"));
  assert.equal(line.includes("/"), false, line);
});
