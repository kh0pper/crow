/**
 * An uninstall deletes the bundle's folder but never the owner's data: the compose project's
 * named volumes, the pulled images and the retained secrets file survive on purpose. The
 * uninstall job now says so — in its log and in the "Removed: …" bell — and it must never
 * fail the uninstall to do it (a docker that will not answer is only noted).
 *
 * Scratch CROW_HOME/DATA, stubbed `docker`/`docker compose`: nothing touches the host.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-keptun-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-keptun-data-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

const B = await import("../servers/gateway/routes/bundles.js");
const { createDbClient } = await import("../servers/db.js");
const { retainedEnvPath } = await import("../servers/gateway/bundle-env-secrets.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-keptun-app-"));
const GW = mkdtempSync(join(tmpdir(), "crow-keptun-gw-"));
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(GW, ".env"));
B._setRestartHookForTest(() => {});
B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
after(() => {
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  B._setRestartHookForTest(null);
  B._setAppEnvPathForTest(null);
  for (const d of [HOME, DATA, FIXTURES, GW]) rmScratch(d);
});

const IMAGE = "example/demo:1.0";
const COMPOSE = `name: kept-demo-project\nservices:\n  app:\n    image: ${IMAGE}\n    volumes:\n      - data:/data\nvolumes:\n  data:\n`;

/** A bundle installed the plain way: folder under CROW_HOME/bundles + an installed.json entry. */
function seedInstalled(id, { compose = COMPOSE, envText = null } = {}) {
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0" };
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(FIXTURES, id, "docker-compose.yml"), compose);
  const dir = join(HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  // The values compose interpolates into the bundle's image refs sit in its own .env.
  if (envText !== null) writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  const installedPath = join(HOME, "installed.json");
  const list = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, "utf8")) : [];
  writeFileSync(installedPath, JSON.stringify([...list.filter((i) => i.id !== id), { id, type: "bundle", version: "0.1.0" }]));
  return dir;
}

/** Keep a secrets file exactly where an uninstall leaves it (contents are never read). */
function keepSettings(id) {
  const path = retainedEnvPath(HOME, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "SECRET_KEY=not-shown-anywhere\n", { mode: 0o600 });
}

/**
 * A fake `docker` for the whole uninstall: `compose config`/`ps` answer nothing (the project
 * name falls back to the compose file's `name:`), `volume ls` lists `volumes`, `image inspect`
 * succeeds unless the image is in `missing`, and `volumeFail` rejects that one lookup.
 */
function dockerStub({ volumes = [], missing = [], volumeFail = null } = {}) {
  return async (cmd, args) => {
    if (args[0] === "volume" && args[1] === "ls") {
      if (volumeFail) throw Object.assign(new Error("Command failed: docker volume ls"), { stderr: volumeFail });
      return { stdout: volumes.map((v) => `${v}\n`).join(""), stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const name = args[args.length - 1];
      if (missing.includes(name)) throw Object.assign(new Error(`Error: No such image: ${name}`), { stderr: `Error response from daemon: No such image: ${name}` });
      return { stdout: `sha256:${"a".repeat(64)}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" }; // compose config, ps -a, …
  };
}

async function withServer(fn) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

/** POST the uninstall and poll its job to a non-running state. */
async function uninstall(id) {
  return withServer(async (base) => {
    const r = await fetch(`${base}/bundles/api/uninstall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: id }) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    const deadline = Date.now() + 10_000;
    let job;
    do {
      await new Promise((res) => setTimeout(res, 25));
      job = await (await fetch(`${base}/bundles/api/jobs/${body.job_id}`)).json();
    } while (job.status === "running" && Date.now() < deadline);
    return job;
  });
}

/** The "Removed: …" bell row this uninstall wrote. */
async function removedNotice(id) {
  const db = createDbClient();
  try {
    return (await db.execute({
      sql: "SELECT title, body FROM notifications WHERE source = 'bundle-installer' AND title LIKE 'Removed:%' ORDER BY id DESC",
      args: [],
    })).rows.find((row) => row.title === `Removed: ${id}`) || null;
  } finally { db.close(); }
}

test("uninstall says what it kept: both volumes, the image and the saved settings", async () => {
  const id = "kept-full";
  const dir = seedInstalled(id);
  keepSettings(id);
  B._setDockerRunnerForTest(dockerStub({ volumes: [`${id}_data`, `${id}_cache`] }));

  const job = await uninstall(id);
  const log = job.log.join("\n");
  assert.ok(["complete", "complete_restart"].includes(job.status), log);
  assert.equal(existsSync(dir), false, "the bundle folder is still removed");
  assert.ok(job.log.includes("Kept storage volume: kept-full_data"), log);
  assert.ok(job.log.includes("Kept storage volume: kept-full_cache"), log);
  assert.ok(job.log.includes(`Kept image: ${IMAGE}`), log);
  assert.ok(job.log.includes("Kept its saved settings (secrets file exists; contents not shown)"), log);

  const notice = await removedNotice(id);
  assert.ok(notice, "the bell row was written");
  assert.ok(notice.body && notice.body !== "", `body: ${JSON.stringify(notice.body)}`);
  assert.match(notice.body, /2 storage volumes/);
  assert.match(notice.body, /1 image/);
});

test("uninstall on a clean host says nothing was left behind", async () => {
  const id = "kept-none";
  const dir = seedInstalled(id);
  B._setDockerRunnerForTest(dockerStub({ volumes: [], missing: [IMAGE] }));

  const job = await uninstall(id);
  const log = job.log.join("\n");
  assert.ok(["complete", "complete_restart"].includes(job.status), log);
  assert.equal(existsSync(dir), false);
  assert.ok(job.log.includes("Nothing was left behind."), log);

  const notice = await removedNotice(id);
  assert.ok(notice, "the bell row was written");
  assert.equal(notice.body, "Nothing was left behind.");
});

test("uninstall with docker refusing the volume lookup still completes, noting it could not check", async () => {
  const id = "kept-nocheck";
  const dir = seedInstalled(id);
  keepSettings(id);
  B._setDockerRunnerForTest(dockerStub({ volumeFail: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }));

  const job = await uninstall(id);
  const log = job.log.join("\n");
  assert.ok(["complete", "complete_restart"].includes(job.status), log);
  assert.equal(existsSync(dir), false, "a docker that will not answer never blocks the uninstall");
  assert.ok(job.log.includes("Could not check what was left behind: Docker did not answer."), log);

  const notice = await removedNotice(id);
  assert.ok(notice, "the bell row was written");
  assert.equal(notice.body, "Could not check what was left behind: Docker did not answer.");
});

test("the image ref is named from the bundle's own .env (image: example/demo:${TAG})", async () => {
  const id = "kept-envtag";
  const compose = "name: kept-envtag-project\nservices:\n  app:\n    image: example/demo:${TAG}\n";
  const dir = seedInstalled(id, { compose, envText: "TAG=1.2\n" });
  B._setDockerRunnerForTest(dockerStub({ volumes: [] }));

  const job = await uninstall(id);
  const log = job.log.join("\n");
  assert.ok(["complete", "complete_restart"].includes(job.status), log);
  assert.equal(existsSync(dir), false, "the bundle folder is still removed");
  assert.ok(job.log.includes("Kept image: example/demo:1.2"), log);
  assert.ok(!log.includes("Nothing was left behind."), log);

  const notice = await removedNotice(id);
  assert.ok(notice, "the bell row was written");
  assert.match(notice.body, /Kept on this computer: 1 image\./);
  assert.match(notice.body, /Reinstalling uses them again\.$/);
});