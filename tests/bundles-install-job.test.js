import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bundles.js resolves BUNDLES_DIR/INSTALLED_PATH/MCP_ADDONS_PATH from CROW_HOME at
// module load. Point it at a scratch dir BEFORE importing it: runInstallJob()
// mkdirSync's ~/.crow/bundles/<bundleId> unconditionally as its first step — even
// for a bundle that goes on to fail — so an unisolated run creates real directories
// in the operator's real ~/.crow (it has — see bundles-auth-bypass.test.js's header
// comment for the live incident this caused).
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
const { runInstallJob, _createJobForTest, _getJobForTest, _finishJobForTest } =
  await import("../servers/gateway/routes/bundles.js");

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
  });
  assert.equal(out.ok, false);
  assert.ok(out.reason, "failure must carry a reason for the set summary");
  assert.equal(_getJobForTest(job.id).status, "running", "runInstallJob never finishes the job itself — the caller owns finishJob, so the set job must still be running");
});

test("jobs are evicted only after they FINISH (a long-running job is never deleted mid-flight)", async () => {
  const job = _createJobForTest("ttl-probe", "install");
  assert.ok(_getJobForTest(job.id), "job exists while running");
  // The eviction timer must be armed in finishJob, not createJob. We assert the
  // structural property: a running job has no eviction timer handle.
  assert.equal(job._evictTimer, undefined, "createJob must NOT arm an eviction timer (a multi-GB set install outlives it and the client's poll 404s mid-install)");
  _finishJobForTest(job, "complete");
  assert.ok(job._evictTimer, "finishJob must arm the eviction timer");
  assert.doesNotThrow(() => JSON.stringify(_getJobForTest(job.id)), "finished job must stay JSON-serializable — the poll endpoint does res.json(job)");
  assert.ok(!JSON.stringify(_getJobForTest(job.id)).includes("_evictTimer"), "timer handle must not serialize");
  clearTimeout(job._evictTimer); // don't leave a handle open in the test process
});
