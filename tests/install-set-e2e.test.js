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

/**
 * A barrier the install-set runner parks on at the TOP of every member
 * iteration. It is a thenable, not a bare promise, so the test can observe the
 * runner's interaction with it as a mechanism rather than infer it from timing:
 *   - `awaited` counts every `await barrier` the runner performs (one per member),
 *   - `reached` resolves the instant the runner first parks on it, which is what
 *     lets the busy-gate assertions below run provably mid-flight with zero
 *     wall-clock sleeping,
 *   - `release()` unparks the runner and is idempotent.
 */
function makeBarrier() {
  let release;
  let notifyReached;
  const gate = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { notifyReached = r; });
  const barrier = {
    awaited: 0,
    reached,
    release,
    then(onFulfilled, onRejected) {
      barrier.awaited++;
      notifyReached();
      return gate.then(onFulfilled, onRejected);
    },
  };
  return barrier;
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
    _setInstallSetBarrierForTest,
    _getInstallSetBarrierForTest,
  } = await import("../servers/gateway/routes/bundles.js");
  const { loadCollections } = await import("../servers/gateway/dashboard/panels/extensions/collections.js");
  // fx-broken (type bundle + compose) traverses validateInstall's docker gate;
  // pin the probe so the mount-guard this test exists to prove is what's
  // actually exercised on docker-less/loaded hosts (and skip a real 3s
  // `docker info` spawn per run).
  const { _setDockerProbeForTest } = await import("../servers/gateway/dashboard/panels/extensions/data-queries.js");
  _setDockerProbeForTest(true);

  // Production no-op, proven by mechanism (not by a comment): on a fresh import,
  // before anything installs a barrier, the module-private barrier is null. The
  // runner's only interaction with it is `if (_installSetBarrier) await
  // _installSetBarrier` — and the thenable spy below proves that branch is live
  // and gated on the barrier's truthiness. null is falsy ⇒ in production the
  // branch is never entered: no await, no timer.
  assert.equal(
    _getInstallSetBarrierForTest(), null,
    "production default: the install-set barrier must be null on a fresh import, so the runner's `if (barrier) await barrier` branch is never entered",
  );

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

  // Pre-existing installed bundle (on disk, not in installed.json) so the
  // reverse-guard uninstall assertion below has something real to target.
  mkdirSync(join(home, "bundles", "fx-preinstalled"), { recursive: true });
  writeFileSync(join(home, "bundles", "fx-preinstalled", "manifest.json"), JSON.stringify({
    id: "fx-preinstalled", name: "Fixture Preinstalled", type: "bundle", version: "1.0.0",
  }, null, 2));

  _setAppBundlesForTest(fixtureBundlesDir);
  _setCollectionsPathForTest(fixtureCollectionsPath);
  // Park the set runner at the top of every member iteration. This replaces the
  // old wall-clock step-delay seam: the busy-gate assertions below no longer
  // race a ~450ms timer, they run while the runner is provably parked.
  const barrier = makeBarrier();
  _setInstallSetBarrierForTest(barrier);
  const restartCalls = [];
  _setRestartHookForTest((delayMs) => restartCalls.push(delayMs));

  t.after(() => {
    _setRestartHookForTest(null);
    // Idempotent release (the happy path already released it after the busy-gate
    // assertions). This is the failure story: if an assertion throws while the
    // runner is parked, the runner never reaches the `finally` that calls
    // endInstallSet() and the busy flag leaks into the next test.
    barrier.release();
    _setInstallSetBarrierForTest(null);
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

    // Wait until the runner has actually parked on the barrier. From here the
    // busy-gate assertions are provably mid-flight — not "probably within 450ms".
    await barrier.reached;

    // The barrier gates the TOP of each iteration, INCLUDING the first: the
    // runner must park BEFORE installing member 1, otherwise the first member's
    // install races these busy-gate fetches.
    assert.equal(barrier.awaited, 1, "the runner must await the barrier once, at the top of the first member's iteration");
    assert.equal(
      existsSync(join(home, "bundles", "fx-panel")), false,
      "the barrier must gate the TOP of the first iteration — fx-panel was already installed by the time the runner reached the barrier",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(home, "installed.json"), "utf8")), [],
      "no member may be installed while the runner is parked on the barrier",
    );

    // Busy gate: a second POST while the first set is still running must 409.
    const res2 = await fetch(base + "/bundles/api/install-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection_id: "fx" }),
    });
    assert.equal(res2.status, 409, "a concurrent install-set POST must be refused with 409 while one is running");

    // D6.9 reverse guard: a single install/uninstall started mid-set must ALSO
    // 409 (and must not create a job) — otherwise it would finish on its own,
    // call scheduleGatewayRestart(), and kill the set runner mid-sequence.
    const res3 = await fetch(base + "/bundles/api/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: "fx-skill" }),
    });
    const body3 = await res3.json();
    assert.equal(res3.status, 409, `a single /install while a set is running must 409: ${JSON.stringify(body3)}`);
    assert.match(body3.error, /collection install is in progress/i);
    assert.equal(body3.job_id, undefined, "a rejected /install must not create a job");

    const res4 = await fetch(base + "/bundles/api/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: "fx-preinstalled" }),
    });
    const body4 = await res4.json();
    assert.equal(res4.status, 409, `a single /uninstall while a set is running must 409: ${JSON.stringify(body4)}`);
    assert.match(body4.error, /collection install is in progress/i);
    assert.equal(body4.job_id, undefined, "a rejected /uninstall must not create a job");

    // Busy-gate assertions are done — unpark the runner so the set can finish.
    // This MUST happen here, not only in t.after(): a runner left parked would
    // make the poll loop below burn all 100 iterations and fail every time.
    barrier.release();

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

    // One await per member — the barrier gates the top of EVERY iteration, so a
    // future member added to the set cannot slip past it.
    assert.equal(barrier.awaited, 3, "the runner must await the barrier once per member (3 members)");
    assert.equal(_getInstallSetBarrierForTest(), barrier, "the barrier setter is the only thing that mutates the module-private barrier");
  } finally {
    server.close();
  }
});
