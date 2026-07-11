import { test } from "node:test";
import assert from "node:assert/strict";
import { runInstallJob, _createJobForTest, _getJobForTest, _finishJobForTest } from "../servers/gateway/routes/bundles.js";

test("runInstallJob is exported with the outcome-returning signature", () => {
  assert.equal(typeof runInstallJob, "function");
});

test("a failed install returns { ok:false, reason } and does NOT finish the shared job", async () => {
  const job = _createJobForTest("no-such-bundle", "install");
  const out = await runInstallJob("no-such-bundle", {}, {
    job,
    installedSnapshot: [],
    consentVerified: false,
    manifest: null,
    deferRestart: true,
  });
  assert.equal(out.ok, false);
  assert.ok(out.reason, "failure must carry a reason for the set summary");
  assert.equal(_getJobForTest(job.id).status, "running", "deferRestart:true means the CALLER owns finishJob — the set job must still be running");
});

test("jobs are evicted only after they FINISH (a long-running job is never deleted mid-flight)", async () => {
  const job = _createJobForTest("ttl-probe", "install");
  assert.ok(_getJobForTest(job.id), "job exists while running");
  // The eviction timer must be armed in finishJob, not createJob. We assert the
  // structural property: a running job has no eviction timer handle.
  assert.equal(job._evictTimer, undefined, "createJob must NOT arm an eviction timer (a multi-GB set install outlives it and the client's poll 404s mid-install)");
  _finishJobForTest(job, "complete");
  assert.ok(job._evictTimer, "finishJob must arm the eviction timer");
  clearTimeout(job._evictTimer); // don't leave a handle open in the test process
});
