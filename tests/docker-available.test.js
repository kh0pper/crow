import { test } from "node:test";
import assert from "node:assert/strict";
import { probeDocker, dockerSkip, dockerAvailable } from "./helpers/docker-available.js";

const out = (status, stdout = "", stderr = "") => () => ({ status, stdout, stderr });

test("a daemon that answers with a version is available", () => {
  assert.deepEqual(probeDocker(out(0, "27.3.1\n")), { available: true, reason: "" });
});

test("a CLI that cannot reach the daemon is unavailable, with the first stderr line as the reason", () => {
  const p = probeDocker(out(1, "", "failed to connect to the docker API at unix:///var/run/docker.sock\nmore"));
  assert.equal(p.available, false);
  assert.match(p.reason, /no reachable Docker daemon \(failed to connect to the docker API/);
  assert.doesNotMatch(p.reason, /more/);
});

test("no docker CLI (ENOENT) is unavailable", () => {
  const p = probeDocker(() => ({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) }));
  assert.deepEqual(p, { available: false, reason: "no docker CLI on this host" });
});

test("a timeout or a throw is unavailable, never an exception", () => {
  assert.equal(probeDocker(() => ({ error: new Error("spawnSync docker ETIMEDOUT") })).available, false);
  assert.equal(probeDocker(() => { throw new Error("boom"); }).available, false);
});

test("exit 0 with an empty version is unavailable", () => {
  assert.equal(probeDocker(out(0, "  \n")).available, false);
});

test("dockerSkip agrees with the host probe: false when a daemon is up, else a reason string", () => {
  const p = dockerAvailable();
  const s = dockerSkip();
  if (p.available) assert.equal(s, false);
  else assert.match(s, /^docker daemon not available: /);
});
