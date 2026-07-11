import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { validateInstall } from "../servers/gateway/routes/bundles.js";

const INSTALLED_PATH = join(homedir(), ".crow", "installed.json");

test("invalid bundle id → 400 invalid_id", async () => {
  const r = await validateInstall("../../etc/passwd");
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, "invalid_id");
});

test("unknown bundle → 404 not_found", async () => {
  const r = await validateInstall("definitely-not-a-real-bundle");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.code, "not_found");
});

test("privileged/consent bundle without a token → 403 consent_required", async () => {
  // 'caddy' declares consent_required: true in its on-disk manifest.
  // forceInstall so this is a pure consent test — without it, the hardware
  // gate and the already-installed check run first (they sit earlier in the
  // gate order) and would fail this test for the wrong reason on a
  // constrained runner or a host where caddy happens to be installed.
  const r = await validateInstall("caddy", { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, "consent_required");
});

test("consent bundle with an invalid/bogus token → 403 consent_invalid", async () => {
  // 'caddy' again, but this time with a token that cannot possibly match a
  // row in install_consents — never minted, so validateConsentToken's
  // UPDATE...RETURNING finds nothing and consentVerified stays false.
  const r = await validateInstall("caddy", {
    forceInstall: true,
    consentToken: "not-a-real-token",
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, "consent_invalid");
});

test("host-networking bundle refused on managed hosting → 403 hosted_forbidden", async () => {
  // 'plex' has `network_mode: host` in its docker-compose.yml and declares
  // neither consent_required nor privileged, so with CROW_HOSTED set it must
  // be refused by the hosted-networking gate (the branch the plan's code
  // block missed entirely — nothing else in this suite pins it).
  const prevHosted = process.env.CROW_HOSTED;
  process.env.CROW_HOSTED = "1";
  try {
    const r = await validateInstall("plex", { forceInstall: true });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, "hosted_forbidden");
  } finally {
    if (prevHosted === undefined) delete process.env.CROW_HOSTED;
    else process.env.CROW_HOSTED = prevHosted;
  }
});

test("bundle whose GPU-arch requirement the host doesn't satisfy → 400 gpu_arch_gate", async () => {
  // 'vllm-cuda-embed' declares requires.gpu_arch: ["cuda"]. This crow host is
  // an AMD Strix Halo box (gfx1151 / ROCm) with no NVIDIA GPU, so
  // checkGpuArchCompatible() must refuse it. gpu_arch has no forceInstall
  // bypass (the install would just crash), so forceInstall only needs to
  // clear the earlier hardware-headroom gate.
  const r = await validateInstall("vllm-cuda-embed", { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, "gpu_arch_gate");
});

test("bundle with a missing required dependency bundle → 400 missing_dependencies", async () => {
  // 'peertube' declares requires.bundles: ["caddy"]. On this host caddy is
  // not in ~/.crow/installed.json (verified by reading it, not modified by
  // this test), so the dependency gate must fire with the missing bundle
  // named in extra.missing_dependencies. This is coupled to real host state
  // (whether caddy happens to be installed) rather than an injectable fixture
  // — see task-4-report.md for the honest accounting of that trade-off.
  const r = await validateInstall("peertube", { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, "missing_dependencies");
  assert.ok(Array.isArray(r.extra.missing_dependencies));
  assert.ok(r.extra.missing_dependencies.includes("caddy"));
});

test("a bundle already present in ~/.crow/installed.json → 409 already_installed", async () => {
  // Reads the REAL, live installed.json to pick an id that's genuinely
  // installed on this host — does not write to it. If nothing usable is
  // installed (fresh host), skip honestly rather than faking a fixture.
  if (!existsSync(INSTALLED_PATH)) {
    console.log("  (skipped: no ~/.crow/installed.json on this host)");
    return;
  }
  const installed = JSON.parse(readFileSync(INSTALLED_PATH, "utf8"));
  const candidate = (Array.isArray(installed) ? installed : [])
    .map((i) => i.id)
    .find((id) => existsSync(join(process.cwd(), "bundles", id)));
  if (!candidate) {
    console.log("  (skipped: no installed bundle also present in the bundles/ registry)");
    return;
  }
  const r = await validateInstall(candidate, { forceInstall: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, "already_installed");
});

test("a plain, non-consent, non-GPU bundle passes and returns its manifest + installed snapshot", async () => {
  const r = await validateInstall("uptime-kuma", { forceInstall: true });
  // forceInstall skips the hardware gate so this test is machine-independent.
  if (r.ok === false && r.code === "already_installed") return; // acceptable on a host where it's installed
  assert.equal(r.ok, true);
  assert.equal(r.manifest.id, "uptime-kuma");
  assert.ok(Array.isArray(r.installed));
  assert.equal(r.consentVerified, false);
});
