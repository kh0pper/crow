/**
 * Queue item 30d: a compose `${KEY:?…}` whose key is blank in the bundle's .env makes every
 * `docker compose` command fail, `down` and `stop` included. Uninstall and Stop retry once
 * with a throwaway value for those keys (they don't use them), and an uninstall that still
 * cannot stop running containers keeps the extension installed instead of orphaning them.
 * Also: PeerTube's newly required admin email (needs-config, never a Start refusal) and the
 * in-place reinstall that must not re-ask for values the earlier install's .env holds.
 *
 * Scratch CROW_HOME, stubbed `docker compose` and `docker`: nothing touches the host.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-teardown-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-teardown-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;
const REPO = fileURLToPath(new URL("..", import.meta.url));

const B = await import("../servers/gateway/routes/bundles.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-teardown-app-"));
const GW = mkdtempSync(join(tmpdir(), "crow-teardown-gw-"));
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(GW, ".env"));
B._setRestartHookForTest(() => {});
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
after(() => {
  B._setComposeRunnerForTest(null); B._setDockerRunnerForTest(null);
  B._setRestartHookForTest(null); B._setAppEnvPathForTest(null);
  for (const d of [CROW_HOME, process.env.CROW_DATA_DIR, FIXTURES, GW]) rmScratch(d);
});

const COMPOSE = 'services:\n  app:\n    image: busybox:1.36\n    environment:\n      P: "${P:?set P}"\n      Q: "${Q:?set Q}"\n';
const missingVar = (k) => Object.assign(new Error(`Command failed: docker compose down\nrequired variable ${k} is missing a value: set ${k}`), { stderr: `required variable ${k} is missing a value: set ${k}` });

function seedInstalled(id, { compose = COMPOSE, envText = "P=\nQ=set-q\n", manifest = {} } = {}) {
  const m = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", ...manifest };
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(FIXTURES, id, "docker-compose.yml"), compose);
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  if (envText !== null) writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  const installedPath = join(CROW_HOME, "installed.json");
  const list = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, "utf8")) : [];
  writeFileSync(installedPath, JSON.stringify([...list.filter((i) => i.id !== id), { id, type: "bundle", version: "0.1.0" }]));
  return dir;
}
const installedIds = () => JSON.parse(readFileSync(join(CROW_HOME, "installed.json"), "utf8")).map((i) => i.id);

async function withServer(fn) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try { return await fn(post, base); } finally { server.close(); }
}
async function uninstall(id) {
  return withServer(async (post) => {
    const r = await post("/bundles/api/uninstall", { bundle_id: id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const deadline = Date.now() + 10_000;
    let job;
    while (Date.now() < deadline) {
      job = B._getJobForTest(r.body.job_id);
      if (job && job.status !== "running") break;
      await new Promise((res) => setTimeout(res, 25));
    }
    return job;
  });
}

test("uninstall: a down that fails on a blank :? key is retried once with a throwaway value for blank keys only", async () => {
  const id = "td-retry";
  const dir = seedInstalled(id);
  const calls = [];
  B._setComposeRunnerForTest(async (args, opts) => {
    calls.push({ args, extraEnv: opts?.extraEnv });
    if (args[0] === "down" && !opts?.extraEnv) throw missingVar("P");
    return { stdout: "", stderr: "" };
  });
  const job = await uninstall(id);
  const downs = calls.filter((c) => c.args[0] === "down");
  assert.equal(downs.length, 2, JSON.stringify(calls));
  assert.deepEqual(downs[1].extraEnv, { P: "crow-teardown-unset" }, "Q is set in .env and is never given a dummy");
  assert.notEqual(job.status, "failed", job.log.join("\n"));
  assert.equal(existsSync(dir), false, "files removed once the containers are down");
  assert.ok(!installedIds().includes(id), "record dropped");
});

test("uninstall: when down still fails and containers may run, the extension is left installed (no orphans)", async () => {
  const id = "td-keep";
  const dir = seedInstalled(id);
  const calls = [];
  B._setComposeRunnerForTest(async (args, opts) => {
    calls.push(args[0]);
    if (args[0] === "down" || args[0] === "ps") throw missingVar("P");
    return { stdout: "", stderr: "" };
  });
  const job = await uninstall(id);
  assert.equal(job.status, "failed");
  assert.ok(job.log.some((l) => l.includes("Containers are still running and could not be stopped; the extension was left installed so you can stop it")), job.log.join("\n"));
  assert.equal(existsSync(join(dir, "docker-compose.yml")), true, "the compose stays so the containers can still be stopped");
  assert.ok(installedIds().includes(id), "record kept");
  assert.ok(!calls.includes("up"), "never brought anything up");
});

test("uninstall: down fails for another reason but nothing runs → removed as before", async () => {
  const id = "td-other";
  const dir = seedInstalled(id, { envText: "P=x\nQ=y\n" });
  const calls = [];
  B._setComposeRunnerForTest(async (args, opts) => {
    calls.push({ args, extraEnv: opts?.extraEnv });
    if (args[0] === "down") throw new Error("network busy");
    return { stdout: "", stderr: "" };
  });
  const job = await uninstall(id);
  assert.equal(calls.filter((c) => c.args[0] === "down").length, 1, "no dummy retry for a non-interpolation error");
  assert.notEqual(job.status, "failed", job.log.join("\n"));
  assert.equal(existsSync(dir), false);
});

test("Stop retries the same way; Start (up) is never retried with dummies", async () => {
  const id = "td-stop";
  seedInstalled(id);
  const calls = [];
  B._setComposeRunnerForTest(async (args, opts) => {
    calls.push({ args, extraEnv: opts?.extraEnv });
    if (!opts?.extraEnv && ["stop", "up"].includes(args[0])) throw missingVar("P");
    return { stdout: "", stderr: "" };
  });
  await withServer(async (post) => {
    const s = await post("/bundles/api/stop", { bundle_id: id });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const stops = calls.filter((c) => c.args[0] === "stop");
    assert.equal(stops.length, 2);
    assert.deepEqual(stops[1].extraEnv, { P: "crow-teardown-unset" });
    const u = await post("/bundles/api/start", { bundle_id: id });
    assert.equal(u.status, 500, "Start keeps failing loudly");
    assert.match(u.body.error, /required variable P is missing a value/);
    const ups = calls.filter((c) => c.args[0] === "up");
    assert.equal(ups.length, 1);
    assert.equal(ups[0].extraEnv, undefined);
  });
});

test("PeerTube: an existing install with a blank admin email shows needs-config under the new manifest, and Start is not refused for it", async () => {
  B._setAppBundlesForTest(join(REPO, "bundles"));
  try {
    const dir = join(CROW_HOME, "bundles", "peertube");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(REPO, "bundles", "peertube", "manifest.json"), join(dir, "manifest.json"));
    // The old compose an existing install keeps (composes are never refreshed on update).
    writeFileSync(join(dir, "docker-compose.yml"), "services:\n  peertube:\n    image: busybox:1.36\n    environment:\n      PEERTUBE_ADMIN_EMAIL: ${PEERTUBE_ADMIN_EMAIL:-admin@example.com}\n");
    writeFileSync(join(dir, ".env"), "PEERTUBE_WEBSERVER_HOSTNAME=video.crow.test\nPEERTUBE_DB_PASSWORD=x\nPEERTUBE_SECRET=y\nPEERTUBE_ADMIN_EMAIL=\n", { mode: 0o600 });
    const list = JSON.parse(readFileSync(join(CROW_HOME, "installed.json"), "utf8"));
    writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([...list, { id: "peertube", type: "bundle", version: "1.0.4" }]));
    assert.ok(B.needsConfigKeys("peertube").includes("PEERTUBE_ADMIN_EMAIL"));
    const calls = [];
    B._setComposeRunnerForTest(async (args) => { calls.push(args[0]); return { stdout: "", stderr: "" }; });
    await withServer(async (post) => {
      const r = await post("/bundles/api/start", { bundle_id: "peertube" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    });
    assert.ok(calls.includes("up"));
  } finally {
    B._setAppBundlesForTest(FIXTURES);
  }
});

test("in-place reinstall: values the earlier install's .env holds are not asked again, and survive the install", async () => {
  // PeerTube, real manifest: a folder left from an earlier install (not in installed.json).
  B._setAppBundlesForTest(join(REPO, "bundles"));
  const ptDir = join(CROW_HOME, "bundles", "peertube");
  try {
    writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify(JSON.parse(readFileSync(join(CROW_HOME, "installed.json"), "utf8")).filter((i) => i.id !== "peertube")));
    writeFileSync(join(ptDir, ".env"), "PEERTUBE_WEBSERVER_HOSTNAME=video.crow.test\nPEERTUBE_ADMIN_EMAIL=abuse@crow.test\n", { mode: 0o600 });
    assert.deepEqual(B.missingInstallEnv("peertube", {}), []);
    writeFileSync(join(ptDir, ".env"), "PEERTUBE_WEBSERVER_HOSTNAME=video.crow.test\nPEERTUBE_ADMIN_EMAIL=\n", { mode: 0o600 });
    assert.deepEqual(B.missingInstallEnv("peertube", {}), ["PEERTUBE_ADMIN_EMAIL"], "a blank prior value is still asked");
  } finally {
    B._setAppBundlesForTest(FIXTURES);
  }

  // A bundle with no generated keys: a typed value on reinstall used to replace the whole .env.
  const id = "td-reinstall";
  const compose = 'services:\n  app:\n    image: busybox:1.36\n    volumes:\n      - "${MEDIA:?set MEDIA}:/data"\n';
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.2.0",
    env_vars: [{ name: "MEDIA", required: true }, { name: "TOKEN", required: false, secret: true }] };
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(FIXTURES, id, "docker-compose.yml"), compose);
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, version: "0.1.0" }));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  const lib = join(CROW_HOME, "media", "library");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(dir, ".env"), `# kept comment\nMEDIA=${lib}\nTOKEN=\n`, { mode: 0o600 });
  assert.deepEqual(B.missingInstallEnv(id, {}), []);
  const challenge = () => withServer(async (_post, base) => (await fetch(`${base}/bundles/api/consent-challenge/${id}`)).json());
  assert.deepEqual((await challenge()).install_required, [], "the install form gates on the same list");
  writeFileSync(join(dir, ".env"), "MEDIA=/path/to/media\n", { mode: 0o600 });
  assert.deepEqual((await challenge()).install_required, ["MEDIA"], "an example value is still asked");
  writeFileSync(join(dir, ".env"), `# kept comment\nMEDIA=${lib}\nTOKEN=\n`, { mode: 0o600 });
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, { TOKEN: "typed-now" }, { job, installedSnapshot: [], consentVerified: false, manifest });
  assert.equal(out.ok, true, out.reason);
  const text = readFileSync(join(dir, ".env"), "utf8");
  const env = parseEnvText(text);
  assert.equal(env.MEDIA, lib, "the earlier value is kept");
  assert.equal(env.TOKEN, "typed-now");
  assert.match(text, /# kept comment/);
});
