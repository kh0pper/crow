import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { validateInstall } from "../servers/gateway/routes/bundles.js";
import { createDbClient } from "../servers/db.js";
import { _setDockerProbeForTest } from "../servers/gateway/dashboard/panels/extensions/data-queries.js";

// Four tests below traverse validateInstall's docker gate (caddy consent ×2,
// plex hosted, uptime-kuma pass) but none of them is ABOUT docker. The live
// probe (`docker info`, 3s timeout, cached 60s) times out under parallel-suite
// load and turns them into 412 docker_unavailable for the wrong reason — pin
// it for the whole file. (routes/bundles.js consults this same ESM instance.)
_setDockerProbeForTest(true);

// Honor CROW_HOME like the code under test does (routes/bundles.js resolves its
// paths from it) — under the scratch suite env this points at the throwaway dir,
// NOT the operator's real ~/.crow.
const CROW_HOME = process.env.CROW_HOME || join(homedir(), ".crow");
const INSTALLED_PATH = join(CROW_HOME, "installed.json");

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
  //
  // validateInstall opens its own createDbClient() for the consent check. On a
  // scratch CROW_DATA_DIR that DB is table-less (init-db never ran), so the
  // UPDATE used to throw instead of returning consent_invalid — this test was
  // one of the suite's standing "known fails" under the scratch env. Create
  // the one table the path touches (same DDL as scripts/init-db.js; IF NOT
  // EXISTS makes it a no-op on a fully-initialized host DB). better-sqlite3
  // won't mkdir, so provision the scratch data dir first (real hosts have it).
  if (process.env.CROW_DATA_DIR) mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
  const db = createDbClient();
  try {
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS install_consents (
              token TEXT PRIMARY KEY,
              bundle_id TEXT NOT NULL,
              schema_version INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              consumed INTEGER NOT NULL DEFAULT 0
            )`,
      args: [],
    });
  } finally {
    try { db.close(); } catch {}
  }
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

test("a bundle already present in installed.json → 409 already_installed", async () => {
  // On the operator's host: reads the REAL installed.json to pick an id that's
  // genuinely installed — never writes it. Under a scratch CROW_HOME (the suite
  // env) installed.json doesn't exist, and this test used to skip on prod /
  // fail closed on scratch (the candidate came from prod state the code under
  // test couldn't see). Scratch is disposable, so seed the fixture there and
  // make the 409 deterministic; remove it after so parallel test files see the
  // same empty scratch they started with.
  let seeded = false;
  if (!existsSync(INSTALLED_PATH)) {
    if (!process.env.CROW_HOME) {
      // Real ~/.crow without an installed.json (fresh host): never write there.
      console.log("  (skipped: no installed.json and no scratch CROW_HOME to seed)");
      return;
    }
    writeFileSync(INSTALLED_PATH, JSON.stringify([
      { id: "uptime-kuma", installed_at: "2026-01-01T00:00:00Z" },
    ]));
    seeded = true;
  }
  try {
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
  } finally {
    if (seeded) rmSync(INSTALLED_PATH, { force: true });
  }
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
