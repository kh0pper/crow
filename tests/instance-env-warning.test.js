// Queue item 19, step 1: a co-hosted instance that reads the shared checkout
// .env inherits the primary's secrets. The boot gate warns, naming keys only;
// an instance with its own CROW_APP_ENV_PATH gets no warning.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { inheritedSecretsWarning } from "../servers/shared/crow-home.js";
import { SECRET_NAME_RE } from "../servers/shared/bot-env.js";
import { runInstancePathsGate } from "../servers/gateway/boot/instance-paths-gate.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-envwarn-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const capture = () => { const lines = []; const p = (...a) => lines.push(a.join(" ")); return { lines, log: { log: p, warn: p, error: p } }; };

test("inheritedSecretsWarning names inherited secret-like keys for a non-default home, never a value or a path key", () => {
  const w = inheritedSecretsWarning({ CROW_HOME: join(scratch, "inst2") }, {
    envFileKeys: new Set(["GITHUB_PERSONAL_ACCESS_TOKEN", "MINIO_ROOT_PASSWORD", "MINIO_PORT", "CROW_PEER_TOKENS_PATH"]),
    secretNameRe: SECRET_NAME_RE,
  });
  assert.match(w, /inherits 2 secret-like key\(s\)/);
  assert.match(w, /GITHUB_PERSONAL_ACCESS_TOKEN, MINIO_ROOT_PASSWORD/);
  assert.ok(!/MINIO_PORT|CROW_PEER_TOKENS_PATH/.test(w));
});

test("no warning for the default home, for an own app env file, or when nothing secret was inherited", () => {
  const keys = new Set(["SOME_TOKEN"]);
  assert.equal(inheritedSecretsWarning({}, { envFileKeys: keys, secretNameRe: SECRET_NAME_RE }), null);
  assert.equal(inheritedSecretsWarning({ CROW_HOME: join(homedir(), ".crow") }, { envFileKeys: keys, secretNameRe: SECRET_NAME_RE }), null);
  assert.equal(inheritedSecretsWarning({ CROW_HOME: join(scratch, "i") }, { envFileKeys: keys, appEnvIsDefault: false, secretNameRe: SECRET_NAME_RE }), null);
  assert.equal(inheritedSecretsWarning({ CROW_HOME: join(scratch, "i") }, { envFileKeys: new Set(["PORT"]), secretNameRe: SECRET_NAME_RE }), null);
});

test("the gate warns for a co-hosted home on the shared .env, and not when CROW_APP_ENV_PATH names its own file", () => {
  const shared = join(scratch, "shared.env");
  writeFileSync(shared, "API_TOKEN=secret-value\nPORT=1\n");
  const home = join(scratch, "home-b");
  const base = { CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_DB_PATH: join(home, "data", "crow.db") };
  const a = capture();
  runInstancePathsGate({ env: { ...base }, envPath: shared, log: a.log, exit: () => {} });
  assert.ok(a.lines.some((l) => /inherits 1 secret-like key\(s\).*API_TOKEN/.test(l)), a.lines.join("\n"));
  assert.ok(!a.lines.join("\n").includes("secret-value"));
  const own = join(scratch, "own.env");
  writeFileSync(own, "PORT=2\n");
  const b = capture();
  const env = { ...base, CROW_APP_ENV_PATH: own };
  runInstancePathsGate({ env, envPath: own, log: b.log, exit: () => {} });
  assert.ok(!b.lines.some((l) => /inherits/.test(l)));
  assert.equal(env.API_TOKEN, undefined, "the own file was applied, not the shared one");
});
