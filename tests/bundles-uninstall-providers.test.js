/**
 * Uninstall turns off the providers the install registered (manifest.providers[]). The route
 * used to pass an undefined id, so every uninstall logged "Provider unregister skipped" and the
 * providers stayed enabled. Scratch Crow home and data dir; no docker.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-unprov-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-unprov-data-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

const B = await import("../servers/gateway/routes/bundles.js");
const { createDbClient } = await import("../servers/db.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-unprov-app-"));
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(mkdtempSync(join(tmpdir(), "crow-unprov-gw-")), ".env"));
B._setRestartHookForTest(() => {});
after(() => {
  B._setAppEnvPathForTest(null);
  B._setRestartHookForTest(null);
  for (const d of [HOME, DATA, FIXTURES]) rmScratch(d);
});

async function providerRows(bundleId) {
  const db = createDbClient();
  try {
    return (await db.execute({ sql: "SELECT id, disabled FROM providers WHERE bundle_id = ? ORDER BY id", args: [bundleId] })).rows
      .map((r) => ({ id: r.id, disabled: Number(r.disabled) }));
  } finally { db.close(); }
}

test("uninstall unregisters the providers the install registered", async () => {
  const id = "demo-llm";
  const manifest = {
    id, name: "Demo LLM", description: "d", type: "bundle", category: "ai", version: "0.1.0", port: 18999,
    providers: [{ id: "demo-llm-local", baseUrlTemplate: "http://{host_ip}:{port}/v1", models: [{ id: "demo-model" }] }],
  };
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(HOME, "installed.json"), "[]");
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: [], consentVerified: false, manifest });
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(await providerRows(id), [{ id: "demo-llm-local", disabled: 0 }], job.log.join("\n"));

  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  let done;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/bundles/api/uninstall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id }) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    const deadline = Date.now() + 10_000;
    do {
      await new Promise((res) => setTimeout(res, 30));
      done = await (await fetch(`${base}/bundles/api/jobs/${body.job_id}`)).json();
    } while (done.status === "running" && Date.now() < deadline);
  } finally { server.close(); }
  assert.ok(["complete", "complete_restart"].includes(done.status), JSON.stringify(done.log));
  assert.ok(!done.log.some((l) => /Provider unregister skipped/.test(l)), done.log.join("\n"));
  assert.ok(done.log.includes("Disabled 1 provider(s) registered by bundle"), done.log.join("\n"));
  assert.deepEqual(await providerRows(id), [{ id: "demo-llm-local", disabled: 1 }]);

  // A reinstall registers the manifest's providers again, enabled.
  const again = B._createJobForTest(id, "install");
  const out2 = await B.runInstallJob(id, {}, { job: again, installedSnapshot: [], consentVerified: false, manifest });
  assert.equal(out2.ok, true, out2.reason);
  assert.deepEqual(await providerRows(id), [{ id: "demo-llm-local", disabled: 0 }], again.log.join("\n"));
});
