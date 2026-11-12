/**
 * After a bundle uninstall, Crow says what was KEPT (tell, do not delete): the compose
 * project's named volumes, the pulled images, and the retained secrets file. Docker is
 * never run here — a fake runner answers the volume/image lookups, and the kept-settings
 * check is one existsSync in a scratch CROW_HOME.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";
import { inspectKept, describeKept } from "../servers/gateway/uninstall-kept.js";
import { retainedEnvPath } from "../servers/gateway/bundle-env-secrets.js";
import { t as tr } from "../servers/gateway/dashboard/shared/i18n.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-kept-home-"));
after(() => rmScratch(HOME));

const COMPOSE = `services:
  web:
    image: nginx:1.25
  db:
    image: postgres:16
    volumes:
      - data:/var/lib/postgresql/data
  builder:
    build: .
volumes:
  data:
`;

/** Keep a secrets file where an uninstall leaves it (contents are never read by the module). */
function keepSettings(bundleId) {
  const path = retainedEnvPath(HOME, bundleId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "SECRET_KEY=not-shown-anywhere\n");
}

/**
 * A fake `run(cmd, args, opts)`: named volumes come back from `volume ls`, `image inspect`
 * succeeds unless the name is in `missing` (`No such image`), and `fail` makes any call
 * reject with a generic docker failure.
 */
function fakeRunner({ volumes = [], missing = [], fail = false } = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (fail) throw Object.assign(new Error("Command failed: docker"), { stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\nsee logs" });
    if (args[0] === "volume" && args[1] === "ls") return { stdout: volumes.map((v) => `${v}\n`).join(""), stderr: "" };
    if (args[0] === "image" && args[1] === "inspect") {
      const name = args[args.length - 1];
      if (missing.includes(name)) throw Object.assign(new Error(`Error: No such image: ${name}`), { stderr: `Error response from daemon: No such image: ${name}` });
      return { stdout: `sha256:${"a".repeat(64)}\n`, stderr: "" };
    }
    throw new Error(`unexpected docker call: ${cmd} ${args.join(" ")}`);
  };
  runner.calls = calls;
  return runner;
}

const inOrder = (calls, cmd, sub) => calls.filter((c) => c.cmd === cmd && c.args[0] === sub);

test("volumes, images and settings: inspect finds them, describe logs the names and counts them", async () => {
  keepSettings("kept-full");
  const runner = fakeRunner({ volumes: ["kept-full_data", "kept-full_cache"] });
  const kept = await inspectKept({ bundleId: "kept-full", project: "kept-full", composeText: COMPOSE, env: {}, crowHome: HOME, runner });

  assert.equal(kept.error, null);
  assert.deepEqual(kept.volumes, ["kept-full_cache", "kept-full_data"]); // sorted
  assert.deepEqual(kept.images, [{ name: "nginx:1.25", present: true }, { name: "postgres:16", present: true }]);
  assert.equal(kept.settings, true);

  const volCall = inOrder(runner.calls, "docker", "volume")[0];
  assert.deepEqual(volCall.args, ["volume", "ls", "--filter", "label=com.docker.compose.project=kept-full", "--format", "{{.Name}}"]);
  assert.equal(volCall.opts.timeout, 10000);
  assert.deepEqual(inOrder(runner.calls, "docker", "image").map((c) => c.args.at(-1)), ["nginx:1.25", "postgres:16"]);
  assert.equal(inOrder(runner.calls, "docker", "image")[0].opts.timeout, 10000);

  const { logLines, body } = describeKept(kept, (k) => tr(k, "en"));
  assert.deepEqual(logLines, [
    "Kept storage volume: kept-full_cache",
    "Kept storage volume: kept-full_data",
    "Kept image: nginx:1.25",
    "Kept image: postgres:16",
    "Kept its saved settings (secrets file exists; contents not shown)",
  ]);
  assert.equal(body, "Its data was kept: 2 storage volumes, 2 images, and its saved settings. Reinstalling picks them up again.");
  for (const name of ["kept-full_data", "kept-full_cache", "nginx:1.25", "postgres:16"]) {
    assert.ok(!body.includes(name), `the body lists counts only, not ${name}`);
  }
});

test("nothing kept: one nothing line, in both the log and the body", async () => {
  const runner = fakeRunner({ volumes: [] });
  const kept = await inspectKept({ bundleId: "kept-none", project: "kept-none", composeText: "", env: {}, crowHome: HOME, runner });
  assert.deepEqual(kept, { volumes: [], images: [], settings: false, error: null });

  const { logLines, body } = describeKept(kept, (k) => tr(k, "en"));
  assert.deepEqual(logLines, ["Nothing was left behind."]);
  assert.equal(body, "Nothing was left behind.");
});

test("a generic docker failure is reported, never thrown", async () => {
  const runner = fakeRunner({ fail: true });
  const kept = await inspectKept({ bundleId: "kept-fail", project: "kept-fail", composeText: COMPOSE, env: {}, crowHome: HOME, runner });

  assert.equal(kept.error, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
  assert.deepEqual(kept.volumes, []);
  assert.deepEqual(kept.images, []);

  const { logLines, body } = describeKept(kept, (k) => tr(k, "en"));
  assert.deepEqual(logLines, ["Could not check what was left behind: Docker did not answer."]);
  assert.equal(body, "Could not check what was left behind: Docker did not answer.");
});

test("an image that is gone (No such image) is left out, not an error", async () => {
  const runner = fakeRunner({ volumes: [], missing: ["nginx:1.25"] });
  const kept = await inspectKept({ bundleId: "kept-pruned", project: "kept-pruned", composeText: COMPOSE, env: {}, crowHome: HOME, runner });

  assert.equal(kept.error, null);
  assert.deepEqual(kept.images, [{ name: "postgres:16", present: true }]);
  const { logLines } = describeKept(kept, (k) => tr(k, "en"));
  assert.deepEqual(logLines, ["Kept image: postgres:16"]);
});

test("no compose project (null): the volume lookup is skipped", async () => {
  const runner = fakeRunner({ volumes: ["should-not-be-asked"] });
  const kept = await inspectKept({ bundleId: "kept-noproj", project: null, composeText: COMPOSE, env: {}, crowHome: HOME, runner });

  assert.equal(kept.error, null);
  assert.deepEqual(kept.volumes, []);
  assert.deepEqual(inOrder(runner.calls, "docker", "volume"), []);
  assert.deepEqual(inOrder(runner.calls, "docker", "image").map((c) => c.args.at(-1)), ["nginx:1.25", "postgres:16"]);
});

test("compose image names honour env interpolation and drop build-only services", async () => {
  const compose = `services:
  web:
    image: \${TAG:-nginx:1.25}
  builder:
    build: .
`;
  const runner = fakeRunner({ volumes: [] });
  const kept = await inspectKept({ bundleId: "kept-env", project: null, composeText: compose, env: { TAG: "nginx:1.27" }, crowHome: HOME, runner });
  assert.deepEqual(kept.images, [{ name: "nginx:1.27", present: true }]);
});

test("Spanish: the description is translated, never empty", async () => {
  keepSettings("kept-es");
  const runner = fakeRunner({ volumes: ["kept-es_data", "kept-es_cache"] });
  const kept = await inspectKept({ bundleId: "kept-es", project: "kept-es", composeText: COMPOSE, env: {}, crowHome: HOME, runner });

  const { logLines, body } = describeKept(kept, (k) => tr(k, "es"));
  assert.ok(logLines.length > 0);
  for (const line of logLines) {
    assert.ok(typeof line === "string" && line.length > 0, `empty es log line: ${JSON.stringify(line)}`);
    assert.ok(!line.startsWith("extensions.kept."), `untranslated key leaked into the log: ${line}`);
  }
  assert.ok(body.length > 0);
  assert.ok(!body.startsWith("extensions.kept."), `untranslated key leaked into the body: ${body}`);
  assert.match(body, /volúmenes/);
  assert.ok(body.includes("2 imágenes"));
  assert.ok(logLines.includes("Se conservó el volumen de almacenamiento: kept-es_data"));
  assert.ok(logLines.includes("Se conservó la imagen: nginx:1.25"));
});