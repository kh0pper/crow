// tests/install-set-e2e.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install-set over a fixture collection, against a scratch CROW_HOME, driven
 * over real HTTP against the actual bundlesRouter() — the set runner's
 * headline promises (sequential order, per-member live gates, continue-on-
 * error, exactly ONE deferred restart, the busy gate) are only real if
 * exercised end-to-end; unit tests on the individual pieces (install-lock,
 * bundles-install-set, bundles-install-job) already cover the primitives in
 * isolation but never prove the wiring between them.
 *
 * Fixture members (no Docker invoked, no network):
 *   fx-panel  — type:"bundle" with a `panel` field → runInstallJob flips
 *               needsRestart TRUE (proves the deferred restart). Without a
 *               panel-bearing member, needsRestart never flips and that
 *               assertion would be vacuous — skill-only/panel-less installs
 *               never set it.
 *   fx-broken — type:"bundle" with a docker-compose.yml that mounts a
 *               sensitive host path (/etc). validateComposeFile refuses this
 *               BEFORE any `docker compose` command runs, so the member fails
 *               deterministically without ever invoking Docker.
 *   fx-skill  — type:"skill", no panel → needsRestart stays false.
 * Order matters: fx-broken sits in the middle, so a passing run proves
 * continue-on-error (fx-skill after it must still install).
 *
 * Isolation rules (non-negotiable — a prior run of a test in this family
 * actually installed uptime-kuma on the operator's live host): CROW_HOME and
 * CROW_DATA_DIR point at a scratch dir, APP_BUNDLES is repointed at a scratch
 * fixture source tree (never the real registry/collections.json or the real
 * bundles/ tree), and the module is imported dynamically AFTER the env is
 * set (ESM import hoisting would otherwise read CROW_HOME too early).
 */
function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), "crowhome-"));
  mkdirSync(join(home, "bundles"), { recursive: true });
  mkdirSync(join(home, "panels"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "installed.json"), "[]");
  return home;
}

/** Build the fixture bundle-source tree (fx-panel / fx-broken / fx-skill) under `root`. */
function buildFixtureBundles(root) {
  // fx-panel: type "bundle" + a `panel` field. This is the ONLY member that
  // makes runInstallJob set needsRestart=true (see bundles.js's "Bundle types
  // can also have panels" block) — required so complete_restart isn't vacuous.
  const panelDir = join(root, "fx-panel");
  mkdirSync(join(panelDir, "panel"), { recursive: true });
  writeFileSync(join(panelDir, "manifest.json"), JSON.stringify({
    id: "fx-panel", name: "Fixture Panel", type: "bundle", version: "1.0.0",
    panel: "panel/index.js",
  }, null, 2));
  writeFileSync(
    join(panelDir, "panel", "index.js"),
    "// fixture panel file — copied by the installer, never loaded in this test\nexport default function panel() {}\n",
  );

  // fx-broken: type "bundle" with a docker-compose.yml mounting /etc — a
  // sensitive host path. validateComposeFile() rejects this by reading the
  // file's text (regex match) BEFORE runInstallJob ever calls `docker compose
  // pull`/`up`, so this is a real, deterministic install failure with zero
  // Docker invocation.
  const brokenDir = join(root, "fx-broken");
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, "manifest.json"), JSON.stringify({
    id: "fx-broken", name: "Fixture Broken", type: "bundle", version: "1.0.0",
  }, null, 2));
  writeFileSync(
    join(brokenDir, "docker-compose.yml"),
    "services:\n  broken:\n    image: busybox\n    volumes:\n      - /etc:/etc\n",
  );

  // fx-skill: type "skill", no panel → must NOT flip needsRestart.
  const skillDir = join(root, "fx-skill");
  mkdirSync(join(skillDir, "skills"), { recursive: true });
  writeFileSync(join(skillDir, "manifest.json"), JSON.stringify({
    id: "fx-skill", name: "Fixture Skill", type: "skill", version: "1.0.0",
    skills: ["skills/fx-skill.md"],
  }, null, 2));
  writeFileSync(join(skillDir, "skills", "fx-skill.md"), "# Fixture skill\nJust a test fixture.\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("install-set: sequential, continue-on-error, exactly one deferred restart, live gates", async (t) => {
  const home = scratchHome();
  process.env.CROW_HOME = home;
  process.env.CROW_DATA_DIR = join(home, "data");
  process.env.CROW_AUTO_UPDATE = "0";
  process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
  process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
  process.env.CROW_DISABLE_NOSTR = "1";

  // Import AFTER the env is set — the module reads CROW_HOME at load.
  const {
    default: bundlesRouter,
    _setAppBundlesForTest,
    _setCollectionsPathForTest,
    _setRestartHookForTest,
    _setInstallSetStepDelayForTest,
  } = await import("../servers/gateway/routes/bundles.js");
  const { loadCollections } = await import("../servers/gateway/dashboard/panels/extensions/collections.js");

  // Fixture bundle source tree (this repoints APP_BUNDLES — the app's real
  // bundles/ tree is never touched or read).
  const fixtureBundlesDir = mkdtempSync(join(tmpdir(), "crow-fixture-bundles-"));
  buildFixtureBundles(fixtureBundlesDir);

  // Fixture collections.json (this repoints the path getCollection() reads —
  // the real registry/collections.json is never touched or read).
  const fixtureCollectionsPath = join(home, "collections.json");
  writeFileSync(fixtureCollectionsPath, JSON.stringify({
    version: 1,
    collections: [{
      id: "fx", name: "Fixture", description: "d", icon: "home",
      members: [
        { id: "fx-panel", kind: "builtin" },
        { id: "fx-broken", kind: "builtin" },
        { id: "fx-skill", kind: "builtin" },
      ],
    }],
  }));
  const cols = loadCollections(fixtureCollectionsPath);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].members.length, 3);

  _setAppBundlesForTest(fixtureBundlesDir);
  _setCollectionsPathForTest(fixtureCollectionsPath);
  // Real (small) macrotask pacing between members — see the seam's doc
  // comment in bundles.js for why this is required to make the busy-gate
  // assertion below observable at all over real HTTP, rather than flaky.
  _setInstallSetStepDelayForTest(150);
  const restartCalls = [];
  _setRestartHookForTest((delayMs) => restartCalls.push(delayMs));

  t.after(() => {
    _setRestartHookForTest(null);
    _setInstallSetStepDelayForTest(0);
    try { rmSync(fixtureBundlesDir, { recursive: true, force: true }); } catch {}
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res1 = await fetch(base + "/bundles/api/install-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection_id: "fx" }),
    });
    const body1 = await res1.json();
    assert.equal(res1.status, 200, `install-set POST failed: ${JSON.stringify(body1)}`);
    const { job_id, plan } = body1;
    assert.equal(plan.length, 3);
    assert.ok(plan.every((p) => p.action === "install"), `expected all 3 members to plan as "install": ${JSON.stringify(plan)}`);

    // Busy gate: a second POST while the first set is still running must 409.
    // The step-delay seam above keeps the job alive for ~450ms so this isn't a race.
    const res2 = await fetch(base + "/bundles/api/install-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection_id: "fx" }),
    });
    assert.equal(res2.status, 409, "a concurrent install-set POST must be refused with 409 while one is running");

    // Poll the shared job until it finishes.
    let job;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(base + `/bundles/api/jobs/${job_id}`);
      job = await r.json();
      if (job.status !== "running") break;
      await sleep(50);
    }
    assert.notEqual(job.status, "running", `job never finished — E2E timed out; log:\n${(job?.log || []).join("\n")}`);
    assert.equal(job.status, "complete_restart", "fx-panel's panel install must have flipped needsRestart");

    const log = job.log.join("\n");
    const panelIdx = job.log.findIndex((l) => l === "SUMMARY member fx-panel installed");
    const brokenIdx = job.log.findIndex((l) => /^SUMMARY member fx-broken failed/.test(l));
    const skillIdx = job.log.findIndex((l) => l === "SUMMARY member fx-skill installed");
    assert.ok(panelIdx >= 0, `missing fx-panel install summary; log:\n${log}`);
    assert.ok(brokenIdx >= 0, `missing fx-broken failure summary (continue-on-error not exercised); log:\n${log}`);
    assert.ok(skillIdx >= 0, `missing fx-skill install summary — the set aborted instead of continuing past fx-broken; log:\n${log}`);
    assert.ok(
      panelIdx < brokenIdx && brokenIdx < skillIdx,
      `members must run in collection order (sequential): panel@${panelIdx} broken@${brokenIdx} skill@${skillIdx}\n${log}`,
    );

    // Exactly one deferred restart, scheduled with the set's 3000ms delay.
    assert.equal(restartCalls.length, 1, `expected exactly one deferred restart, got ${restartCalls.length}: ${JSON.stringify(restartCalls)}`);
    assert.equal(restartCalls[0], 3000);

    // installed.json: fx-panel + fx-skill landed; fx-broken (failed) did not.
    const installed = JSON.parse(readFileSync(join(home, "installed.json"), "utf8"));
    const ids = installed.map((e) => e.id);
    assert.ok(ids.includes("fx-panel"), `installed.json missing fx-panel: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes("fx-skill"), `installed.json missing fx-skill: ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes("fx-broken"), `installed.json must NOT include the failed fx-broken: ${JSON.stringify(ids)}`);
  } finally {
    server.close();
  }
});
