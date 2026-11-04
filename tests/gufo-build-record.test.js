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
});

test("the golden build id is the one its own recipe inputs produce", () => {
  assert.equal(golden().build_id, computeBuildId(goldenBuildIdInputs()));
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
  ["a failed check_install", (r) => { r.check_install.status = "FAIL"; }, REASONS.CHECK_INSTALL_NOT_PASS],
  ["check_install run in another mode", (r) => { r.check_install.mode = "discovery"; }, REASONS.CHECK_INSTALL_NOT_LOCK],
  ["an unrecorded-legacy trust level", (r) => { r.trust = "unrecorded"; }, REASONS.TRUST_NOT_OFFICIAL],
  ["a community trust level", (r) => { r.trust = "community-lock"; }, REASONS.TRUST_NOT_OFFICIAL],
  ["a nix image on a floating tag", (r) => { r.toolchain.nix_image = "docker.io/nixos/nix:latest"; }, REASONS.IMAGE_FLOATING_TAG],
  ["a nix image pinned by tag only", (r) => { r.toolchain.nix_image = "docker.io/nixos/nix:2.24"; }, REASONS.IMAGE_NOT_DIGEST_PINNED],
  ["a nix image with a truncated digest", (r) => { r.toolchain.nix_image = `docker.io/nixos/nix@sha256:${"9".repeat(32)}`; }, REASONS.IMAGE_NOT_DIGEST_PINNED],
  ["an extension that the lock does not name", (r) => {
    r.extensions.built.push({ name: "community_thing", version: "0.1.0", source: "src/models/community_thing" });
  }, REASONS.EXTENSION_EXTRA],
  ["a lock name missing from the built set", (r) => { r.extensions.built.pop(); }, REASONS.EXTENSION_MISSING],
  ["a built extension sourced from outside the official tree", (r) => { r.extensions.built[0].source = "third_party/deepseek_v4_flash"; }, REASONS.EXTENSION_SOURCE_OUTSIDE_TREE],
  ["a built extension at another extension's tree path", (r) => { r.extensions.built[0].source = "src/models/qwen"; }, REASONS.EXTENSION_SOURCE_OUTSIDE_TREE],
  ["a diagnose provider with no recorded keys", (r) => { delete r.extensions.provider_keys["deepseek4"]; }, REASONS.PROVIDER_KEYS_MISSING],
  ["recorded keys for a provider diagnose does not list", (r) => { r.extensions.provider_keys.ghost = ["gguf:ghost"]; }, REASONS.PROVIDER_KEYS_UNKNOWN],
  ["a recipe that is not the v1 recipe", (r) => { r.recipe = "nix-build-derivation"; }, REASONS.RECIPE_UNKNOWN],
  ["an invented recipe name", (r) => { r.recipe = "cmake"; }, REASONS.RECIPE_UNKNOWN],
  ["a discovery-mode selection", (r) => { r.extensions.selection_mode = "discovery"; }, REASONS.SELECTION_NOT_LOCK],
  ["an explicit-mode selection", (r) => { r.extensions.selection_mode = "explicit"; }, REASONS.SELECTION_NOT_LOCK],
  ["a build id that is not an id", (r) => { r.build_id = "gufo-0.29.0-0123456"; }, REASONS.BUILD_ID_INVALID],
  ["an unknown record schema", (r) => { r.schema = 2; }, REASONS.SCHEMA_UNSUPPORTED],
  ["a lock digest of the wrong shape", (r) => { r.extensions.lock_file_sha256 = "not-a-digest"; }, REASONS.LOCK_HASH_INVALID],
  ["an API version that disagrees with diagnose", (r) => { r.extensions.api_version = "0.0.0"; }, REASONS.API_VERSION_MISMATCH],
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
    REASONS.SELECTION_NOT_LOCK,
    REASONS.LOCK_HASH_INVALID,
    REASONS.LOCK_NAMES_INVALID,
    REASONS.API_VERSION_MISMATCH,
    REASONS.CHECK_INSTALL_NOT_PASS,
    REASONS.CHECK_INSTALL_NOT_LOCK,
    REASONS.IMAGE_NOT_DIGEST_PINNED,
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

test("collision: a repeated key inside one provider is not a collision, and a provider with no keys is skipped", () => {
  assert.deepEqual(
    collisionCheck([provider("qwen27-q4")], { "qwen27-q4": ["gguf:qwen27", "gguf:qwen27"] }),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(collisionCheck([provider("a"), provider("b")], { a: [], b: [] }), { ok: true, reasons: [] });
  assert.deepEqual(collisionCheck(undefined, undefined), { ok: true, reasons: [] });
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

// --- build id ----------------------------------------------------------------

test("computeBuildId: equal inputs give an equal id, define order included", () => {
  const inputs = goldenBuildIdInputs();
  const id = computeBuildId(inputs);
  assert.equal(id, computeBuildId({ ...inputs }));
  assert.equal(id, computeBuildId({ ...inputs, defines: [...inputs.defines].reverse() }));
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

test("displayBuildRecord tolerates a legacy directory that has almost nothing", () => {
  assert.equal(typeof displayBuildRecord(undefined), "string");
  assert.equal(typeof displayBuildRecord(null), "string");
  assert.equal(typeof displayBuildRecord([]), "string");
  assert.equal(typeof displayBuildRecord({}), "string");

  const legacy = { build_id: "main-883f67b6", trust: "unrecorded", binary: { path: "/opt/gufo/gufo" } };
  const line = displayBuildRecord(legacy);
  assert.ok(line.includes("main-883f67b6"));
  assert.ok(line.includes("unrecorded"));
  assert.equal(line.includes("/"), false, line);
});