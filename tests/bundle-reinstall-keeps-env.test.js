/**
 * An in-place reinstall from Extensions keeps the earlier install's .env values.
 *
 * The install form pre-fills every optional field with its manifest default and submits
 * it. On a reinstall that default used to overwrite the value the earlier install's .env
 * held: MinIO's MINIO_BIND_ADDR (a tailnet address, so paired instances could reach it)
 * went back to 127.0.0.1 and cut those instances off. Rule: on a reinstall an existing
 * non-empty value is kept unless the owner actually changed that field; a default never
 * overwrites it. The form shows the existing values (never a secret in plain text).
 *
 * Scratch CROW_HOME + data dir, stubbed `docker compose` and `docker`: nothing touches the host.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-reenv-home-"));
process.env.CROW_HOME = TMP_HOME;
const TMP_DATA = mkdtempSync(join(tmpdir(), "crow-reenv-data-"));
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });
const CROW_HOME = TMP_HOME;
const REPO = fileURLToPath(new URL("..", import.meta.url));

const B = await import("../servers/gateway/routes/bundles.js");
const { parseEnvText } = await import("../servers/gateway/bundle-env-codec.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-reenv-app-"));
const GW = mkdtempSync(join(tmpdir(), "crow-reenv-gw-"));
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(GW, ".env"));
B._setRestartHookForTest(() => {});
B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
after(() => {
  B._setComposeRunnerForTest(null); B._setDockerRunnerForTest(null);
  B._setRestartHookForTest(null); B._setAppEnvPathForTest(null);
  for (const d of [TMP_HOME, TMP_DATA, FIXTURES, GW]) rmScratch(d);
});

const TAILNET_ADDR = "100.64.20.5";
// No ports/webUI: the installer would otherwise try `sudo -n ufw` / `tailscale serve` on this host.
const minioManifest = () => ({ ...JSON.parse(readFileSync(join(REPO, "bundles", "minio", "manifest.json"), "utf8")), ports: [], webUI: null });

/** Exactly what the install form submits: every field that has a value, i.e. each default. */
function formDefaults(manifest) {
  const out = {};
  for (const v of manifest.env_vars || []) if (!v.generate && v.default) out[v.name] = v.default;
  return out;
}

/** A MinIO folder left from an earlier install (not in installed.json): an in-place reinstall. */
function seedMinio(envText) {
  const id = "minio";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  for (const d of [join(FIXTURES, id), dir]) {
    writeFileSync(join(d, "manifest.json"), JSON.stringify(minioManifest()));
    copyFileSync(join(REPO, "bundles", id, "docker-compose.yml"), join(d, "docker-compose.yml"));
  }
  writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  return dir;
}
const PRIOR_MINIO = `MINIO_ROOT_USER=crowadmin\nMINIO_ROOT_PASSWORD=kept-generated-pw-0123456789abcdef\nMINIO_BIND_ADDR=${TAILNET_ADDR}\n`;

async function reinstall(id, envVars, manifest, opts = {}) {
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, envVars, { job, installedSnapshot: [], consentVerified: false, manifest, ...opts });
  assert.equal(out.ok, true, out.reason);
  return parseEnvText(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"));
}

test("MinIO reinstall: the form's default 127.0.0.1 does not overwrite the kept MINIO_BIND_ADDR", async () => {
  const manifest = minioManifest();
  seedMinio(PRIOR_MINIO);
  const env = await reinstall("minio", formDefaults(manifest), manifest);
  assert.equal(env.MINIO_BIND_ADDR, TAILNET_ADDR, "the earlier install's bind address is kept");
  assert.equal(env.MINIO_ROOT_PASSWORD, "kept-generated-pw-0123456789abcdef", "the generated password is kept");
});

test("MinIO reinstall: a field the owner edited wins, even when it equals the default", async () => {
  const manifest = minioManifest();
  seedMinio(PRIOR_MINIO);
  let env = await reinstall("minio", formDefaults(manifest), manifest, { editedEnv: ["MINIO_BIND_ADDR"] });
  assert.equal(env.MINIO_BIND_ADDR, "127.0.0.1", "deliberately set back to the default");
  seedMinio(PRIOR_MINIO);
  env = await reinstall("minio", { ...formDefaults(manifest), MINIO_BIND_ADDR: "100.64.20.9" }, manifest);
  assert.equal(env.MINIO_BIND_ADDR, "100.64.20.9", "a typed non-default value always wins");
});

test("reinstall without generated keys: defaults never overwrite kept values; blank or missing keys still get them", async () => {
  const id = "reenv-plain";
  const manifest = { id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.2.0",
    env_vars: [{ name: "BIND", default: "127.0.0.1" }, { name: "PORT", default: "8080" }, { name: "MODE", default: "basic" }, { name: "EXTRA", default: "on" }] };
  const compose = 'services:\n  app:\n    image: busybox:1.36\n    ports:\n      - "${BIND:-127.0.0.1}:${PORT:-8080}:80"\n';
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(FIXTURES, id, "docker-compose.yml"), compose);
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, version: "0.1.0" }));
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  writeFileSync(join(dir, ".env"), `BIND=${TAILNET_ADDR}\nPORT=9090\nMODE=\n`, { mode: 0o600 });
  const env = await reinstall(id, formDefaults(manifest), manifest);
  assert.equal(env.BIND, TAILNET_ADDR);
  assert.equal(env.PORT, "9090");
  assert.equal(env.MODE, "basic", "a blank kept value takes the default");
  assert.equal(env.EXTRA, "on", "a key the old .env lacks takes the default");
});

test("keepPriorOverDefaults: the pure rule", () => {
  const manifest = { env_vars: [{ name: "A", default: "d" }, { name: "B", default: "d" }, { name: "C" }, { name: "D", default: "d" }] };
  const prior = { A: "kept", B: "", C: "kept", D: "/path/to/media" };
  const out = B.keepPriorOverDefaults(manifest, { A: "d", B: "d", C: "typed", D: "d" }, prior, null);
  assert.deepEqual(out, { B: "d", C: "typed", D: "d" }, "kept A; blank B and placeholder D take the default; typed C wins");
  assert.deepEqual(B.keepPriorOverDefaults(manifest, { A: "d" }, prior, ["A"]), { A: "d" }, "edited");
  assert.deepEqual(B.keepPriorOverDefaults(manifest, { A: "d" }, {}, null), { A: "d" }, "first install: unchanged");
});

async function withServer(fn) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test("consent-challenge on a reinstall shows the kept values to the form, never a secret", async () => {
  seedMinio(PRIOR_MINIO);
  const data = await withServer(async (base) => (await fetch(`${base}/bundles/api/consent-challenge/minio`)).json());
  assert.equal(data.existing_env?.MINIO_BIND_ADDR, TAILNET_ADDR);
  assert.equal(data.existing_env?.MINIO_ROOT_USER, "crowadmin");
  assert.equal(data.existing_env?.MINIO_ROOT_PASSWORD, undefined, "secret values never leave the server");
  assert.ok(!JSON.stringify(data).includes("kept-generated-pw"), "not anywhere in the response");
  assert.deepEqual(data.existing_secret_set, ["MINIO_ROOT_PASSWORD"]);
});

test("consent-challenge on a first install carries no existing values", async () => {
  const id = "reenv-fresh";
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify({ id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: [{ name: "BIND", default: "127.0.0.1" }] }));
  const data = await withServer(async (base) => (await fetch(`${base}/bundles/api/consent-challenge/${id}`)).json());
  assert.deepEqual(data.existing_env || {}, {});
});

test("install form: shows kept values, marks secrets as kept, and submits which fields the owner edited", () => {
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/panels/extensions/client.js"), "utf8");
  assert.ok(src.includes("data.existing_env"), "fills fields from the kept values");
  assert.ok(src.includes("data.existing_secret_set"), "marks a kept secret without showing it");
  assert.ok(src.includes("payload.env_edited"), "sends the fields the owner changed");
});
