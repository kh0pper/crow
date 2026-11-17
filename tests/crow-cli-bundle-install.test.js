/**
 * `crow bundle install <id>` must reach `docker compose pull`.
 *
 * The CLI runs under `set -euo pipefail`, and its shared-env probe was
 * `shared_env=$(grep … docker-compose.yml | sed -n '1p' | sed …)`: grep exits 1 when the
 * compose names no `${HOME}/.crow/env/…` file, so the ASSIGNMENT failed and `set -e` aborted
 * the install right there — before the pull — for every compose bundle with no .env, no
 * .env.example and no shared env reference. These tests run the real CLI against a synthetic
 * bundle inside a scratch CROW_HOME (never the repo's own bundles/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "scripts", "crow");

/**
 * A scratch CROW_HOME with a synthetic bundle in it: CROW_HOME/app is the CLI's CROW_APP, so
 * `bundle install` copies from the scratch home and the checkout is untouched. HOME is the
 * scratch home too, so no real ~/.crow/env can steer the probe. `docker` is a stub that
 * records its argv, so "the pull ran" is provable without a daemon.
 */
function scratchInstall(t, { compose, sharedEnv = null }) {
  const home = mkdtempSync(join(tmpdir(), "crow-cli-install-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bundle = join(home, "app", "bundles", "plaincompose");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "docker-compose.yml"), compose);
  let shared = null;
  if (sharedEnv) {
    mkdirSync(join(home, ".crow", "env"), { recursive: true });
    shared = join(home, ".crow", "env", sharedEnv);
    writeFileSync(shared, "VIDEO_GID=44\n");
  }
  const tools = join(home, "tools");
  mkdirSync(tools);
  const calls = join(home, "docker-calls");
  writeFileSync(join(tools, "docker"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`);
  chmodSync(join(tools, "docker"), 0o755);
  const run = spawnSync("bash", [CLI, "bundle", "install", "plaincompose"], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, CROW_DATA_DIR: home, HOME: home },
  });
  return { home, calls, shared, code: run.status, out: `${run.stdout || ""}\n${run.stderr || ""}` };
}

test("a compose bundle with no .env, no .env.example and no shared env reference still reaches the pull", (t) => {
  const { calls, code, out } = scratchInstall(t, {
    compose: "services:\n  app:\n    image: example/app:1.0.0\n",
  });
  assert.equal(code, 0, out);
  assert.match(out, /Pulling Docker images/, "the install is not cut short before the pull");
  assert.equal(readFileSync(calls, "utf8").trim(), "compose pull", "docker compose pull really ran");
  assert.match(out, /Bundle 'plaincompose' installed\./, out);
});

test("a compose bundle that does name a shared env file is still linked to it (the probe still works)", (t) => {
  const { home, calls, shared, code, out } = scratchInstall(t, {
    compose: "services:\n  app:\n    image: example/app:1.0.0\n    env_file: ${HOME}/.crow/env/rocm.env\n",
    sharedEnv: "rocm.env",
  });
  assert.equal(code, 0, out);
  assert.match(out, /Pulling Docker images/);
  assert.equal(readFileSync(calls, "utf8").trim(), "compose pull", "the pull ran here too");
  const installed = join(home, "bundles", "plaincompose", ".env");
  assert.ok(lstatSync(installed).isSymbolicLink(), "the shared env file is symlinked as the bundle .env");
  assert.equal(readlinkSync(installed), shared);
});