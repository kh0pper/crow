import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { computePayloadDigest } from "../scripts/check-vendored-payloads.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_SCRIPT = join(REPO_ROOT, "scripts", "check-vendored-payloads.mjs");

/**
 * Digest framing is a CONTRACT, not an implementation detail: the same bytes
 * under the same relative paths must hash the same on every host and every
 * node version, forever, or a vendored payload that never changed starts
 * failing CI. The literal below was computed independently from the documented
 * framing (path, NUL, bytes, NUL, over posix-relative paths sorted
 * lexicographically) — if an implementation change breaks it, that is a
 * BREAKING change to every stamped manifest, not a test to update casually.
 */
const FIXTURE_FILES = {
  "hub/server.mjs": 'console.log("a");\n',
  "lib/sessions.mjs": "export const b = 1;\n",
};
const FIXTURE_DIGEST = "ec9395740500a14a2ec1c89d67b6570a687ff0ee797c27ce5c9a4e8e35866198";

/** Write {relpath: content} under a fresh temp dir; returns the dir. */
function writeTree(files, root = mkdtempSync(join(tmpdir(), "perch-payload-"))) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

/**
 * Fake repo root: <root>/bundles/<id>/manifest.json (+ payload/ when given).
 * The check script takes --root so tests never touch the real bundles/ tree.
 */
function fakeRepo({ id = "perch-hub", manifest = {}, payload = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "perch-repo-"));
  const bundleDir = join(root, "bundles", id);
  mkdirSync(bundleDir, { recursive: true });
  if (payload) {
    const payloadDir = join(bundleDir, "payload");
    mkdirSync(payloadDir, { recursive: true });
    writeTree(payload, payloadDir);
  }
  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { root, bundleDir };
}

function runCheck(root) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, "--root", root], { encoding: "utf8" });
}

test("computePayloadDigest is pure and pins the documented framing", () => {
  const a = writeTree(FIXTURE_FILES);
  const b = writeTree(FIXTURE_FILES);
  assert.equal(computePayloadDigest(a), FIXTURE_DIGEST);
  assert.equal(computePayloadDigest(b), FIXTURE_DIGEST, "same bytes in a different dir → same digest");
});

test("computePayloadDigest changes when content or path changes", () => {
  const tampered = writeTree({ ...FIXTURE_FILES, "hub/server.mjs": 'console.log("A");\n' });
  assert.notEqual(computePayloadDigest(tampered), FIXTURE_DIGEST, "content change must move the digest");
  const renamed = writeTree({ "hub/server.mjs": 'console.log("a");\n', "lib/other.mjs": "export const b = 1;\n" });
  assert.notEqual(computePayloadDigest(renamed), FIXTURE_DIGEST, "path change must move the digest");
});

test("check script exits 0 when the payload matches the stamped digest", () => {
  const { root } = fakeRepo({
    manifest: { id: "perch-hub", name: "P", description: "d", type: "bundle", category: "ai", payload_sha256: FIXTURE_DIGEST },
    payload: FIXTURE_FILES,
  });
  const r = runCheck(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("check script exits 1 and names the bundle when the payload is tampered", () => {
  const { root } = fakeRepo({
    manifest: { id: "perch-hub", name: "P", description: "d", type: "bundle", category: "ai", payload_sha256: FIXTURE_DIGEST },
    payload: { ...FIXTURE_FILES, "hub/server.mjs": 'console.log("pwn");\n' },
  });
  const r = runCheck(root);
  assert.equal(r.status, 1, "tampered payload must fail the gate");
  assert.match(r.stdout + r.stderr, /perch-hub/);
});

test("check script exits 1 when a stamped manifest has no payload dir at all", () => {
  const { root } = fakeRepo({
    manifest: { id: "perch-hub", name: "P", description: "d", type: "bundle", category: "ai", payload_sha256: FIXTURE_DIGEST },
  });
  const r = runCheck(root);
  assert.equal(r.status, 1, "stamped-but-missing payload must fail, not silently pass");
});

test("check script exits 0 when payload_sha256 is absent (pre-vendor draft, by design)", () => {
  const { root } = fakeRepo({
    manifest: { id: "perch-hub", name: "P", description: "d", type: "bundle", category: "ai", draft: true },
  });
  const r = runCheck(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /skip/i);
});

test("check script warns (but stays green) when a payload dir exists with no stamp", () => {
  const { root } = fakeRepo({
    manifest: { id: "perch-hub", name: "P", description: "d", type: "bundle", category: "ai", draft: true },
    payload: FIXTURE_FILES,
  });
  const r = runCheck(root);
  assert.equal(r.status, 0, "unstamped payload is legitimate mid-vendor — must not redden CI");
  assert.match(r.stdout, /WARN\s+perch-hub/, "…but it must never pass in silence");
});

test("check script exits 0 on the real repo (perch-hub draft carries no digest yet)", () => {
  const r = spawnSync(process.execPath, [CHECK_SCRIPT], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// --- vendor script -------------------------------------------------------
// The vendor script is WRITTEN in C-1 and RUN in C-8 (its upstream inputs do
// not all exist yet). These tests stand in for that run: a throwaway git repo
// plays pi-lab, and PERCH_VENDOR_BUNDLE_DIR redirects the write to a scratch
// bundle so the real bundles/perch-hub/payload/ is never touched here.

const VENDOR_SCRIPT = join(REPO_ROOT, "scripts", "vendor-perch.mjs");

function fakePiLab(files) {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-fake-"));
  writeTree(files, dir);
  const g = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "vendor@test.invalid");
  g("config", "user.name", "vendor test");
  g("add", "-A");
  g("commit", "-q", "-m", "fixture");
  g("branch", "crow-mode");
  return dir;
}

function runVendor(piLabDir, bundleDir, extraArgs = []) {
  return spawnSync(process.execPath, [VENDOR_SCRIPT, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, PI_LAB_DIR: piLabDir, PERCH_VENDOR_BUNDLE_DIR: bundleDir },
  });
}

function scratchBundle() {
  const dir = mkdtempSync(join(tmpdir(), "perch-bundle-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ id: "perch-hub", name: "P", description: "d", type: "bundle", category: "ai", version: "0.1.0", draft: true }, null, 2) + "\n",
  );
  return dir;
}

const UPSTREAM_FIXTURE = {
  "hub/server.mjs": "// hub\n",
  "hub/auth-source.mjs": "// auth\n",
  "hub/bots-page.mjs": "// bots\n",
  "lib/sessions.mjs": "// sessions\n",
};

test("vendor script refuses cleanly when a pinned file is absent upstream, writing nothing", () => {
  const { "hub/bots-page.mjs": _absent, ...partial } = UPSTREAM_FIXTURE;
  const piLab = fakePiLab(partial);
  const bundleDir = scratchBundle();
  const r = runVendor(piLab, bundleDir, ["--ref", "crow-mode"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hub\/bots-page\.mjs/, "must name the missing file");
  assert.match(r.stderr, /Nothing was written/i);
  assert.equal(existsSync(join(bundleDir, "payload")), false, "a partial payload must never be left behind");
  assert.equal(JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")).version, "0.1.0", "manifest untouched on refusal");
});

test("vendor script refuses cleanly on an unknown ref and on a non-repo PI_LAB_DIR", () => {
  const piLab = fakePiLab(UPSTREAM_FIXTURE);
  const bundleDir = scratchBundle();
  const badRef = runVendor(piLab, bundleDir, ["--ref", "no-such-branch"]);
  assert.equal(badRef.status, 1);
  assert.match(badRef.stderr, /no-such-branch/);

  const notARepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
  const r = runVendor(notARepo, bundleDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PI_LAB_DIR/);
});

test("vendor script pins the ref, records UPSTREAM, stamps the digest and bumps the patch version", () => {
  const piLab = fakePiLab(UPSTREAM_FIXTURE);
  const bundleDir = scratchBundle();
  const r = runVendor(piLab, bundleDir, ["--ref", "crow-mode"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const payloadDir = join(bundleDir, "payload");
  // hub/ + lib/ siblings preserved — the hub imports ../lib/sessions.mjs.
  for (const rel of [...Object.keys(UPSTREAM_FIXTURE), "UPSTREAM"]) {
    assert.equal(existsSync(join(payloadDir, rel)), true, `missing payload/${rel}`);
  }
  const head = spawnSync("git", ["-C", piLab, "rev-parse", "crow-mode"], { encoding: "utf8" }).stdout.trim();
  const [sha, date] = readFileSync(join(payloadDir, "UPSTREAM"), "utf8").trim().split("\n");
  assert.equal(sha, head, "UPSTREAM must record the exact vendored commit");
  assert.match(date, /^\d{4}-\d{2}-\d{2}T/);

  const m = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
  assert.equal(m.version, "0.1.1", "patch version bumped");
  assert.equal(m.payload_sha256, computePayloadDigest(payloadDir), "stamped digest must match the tree it wrote");

  // And the gate agrees end to end.
  const repoRoot = mkdtempSync(join(tmpdir(), "perch-repo-"));
  mkdirSync(join(repoRoot, "bundles"), { recursive: true });
  spawnSync("cp", ["-r", bundleDir, join(repoRoot, "bundles", "perch-hub")]);
  assert.equal(runCheck(repoRoot).status, 0, "freshly vendored payload must pass check-vendored-payloads");
});

test("vendor script reads the ref, not the dirty working tree", () => {
  const piLab = fakePiLab(UPSTREAM_FIXTURE);
  writeFileSync(join(piLab, "hub", "server.mjs"), "// UNCOMMITTED EDIT\n");
  const bundleDir = scratchBundle();
  assert.equal(runVendor(piLab, bundleDir, ["--ref", "crow-mode"]).status, 0);
  assert.equal(readFileSync(join(bundleDir, "payload", "hub", "server.mjs"), "utf8"), "// hub\n");
});

test("vendor script replaces the payload wholesale (no stale files linger inside the digest)", () => {
  const piLab = fakePiLab(UPSTREAM_FIXTURE);
  const bundleDir = scratchBundle();
  assert.equal(runVendor(piLab, bundleDir, ["--ref", "crow-mode"]).status, 0);
  writeFileSync(join(bundleDir, "payload", "hub", "stowaway.mjs"), "// not pinned\n");
  assert.equal(runVendor(piLab, bundleDir, ["--ref", "crow-mode"]).status, 0);
  assert.equal(existsSync(join(bundleDir, "payload", "hub", "stowaway.mjs")), false);
});

test("perch-hub manifest is a draft with the pinned webUI contract and no digest yet", () => {
  const m = JSON.parse(readFileSync(join(REPO_ROOT, "bundles", "perch-hub", "manifest.json"), "utf8"));
  assert.equal(m.id, "perch-hub", "id must equal the dirname — bundle-contract enforces it");
  assert.equal(m.draft, true, "stays a draft until the payload is vendored (C-8)");
  assert.equal("payload_sha256" in m, false, "no digest until vendoring stamps it");
  assert.equal(m.npm_required, false);
  assert.equal(m.min_node, "22.19.0");
  assert.deepEqual(m.webUI, {
    port: 4210,
    portEnv: "CROW_PERCH_PORT",
    path: "/",
    label: "Perch",
    authTokenFile: "perch-token",
  });
});
