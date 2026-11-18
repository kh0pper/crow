// Boot ordering for the artifact origin's listener (review F8). The origin's
// bind address may be a docker bridge's gateway IP: when the gateway unit starts
// before docker.service has created that bridge, listen() fails with
// EADDRNOTAVAIL and the origin would stay off until the next restart. The retry
// is bounded (every 5 s for 2 min), never retries a typo, and never throws into
// the boot. The sleeps are injected, so this file runs in milliseconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  startArtifactOriginWithBindRetry,
  startArtifactOriginFromEnv,
  isAddressNotAvailable,
  fallbackOriginUrl,
  artifactOriginInfo,
  defaultSleep,
  _resetForTest,
  ORIGIN_BIND_RETRY_EVERY_MS,
  ORIGIN_BIND_RETRY_WINDOW_MS,
} from "../servers/gateway/artifact-origin/runtime.js";

const addrNotAvailable = () => Object.assign(new Error("listen EADDRNOTAVAIL: address not available 172.30.0.1:3090"), { code: "EADDRNOTAVAIL" });

/** A start() that fails this many times with EADDRNOTAVAIL, then succeeds. */
function flakyStart(failures, err = addrNotAvailable) {
  let n = 0;
  const start = async () => {
    if (n < failures) { n++; throw err(); }
    return { address: () => ({ port: 3090 }) };
  };
  return { start, calls: () => n };
}

test("a bind address that is not up yet is retried every 5 s, and the retry stops as soon as it binds", async () => {
  const { start, calls } = flakyStart(3);
  const sleeps = [], logs = [];
  const srv = await startArtifactOriginWithBindRetry({
    start, env: {}, log: (m) => logs.push(String(m)), sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.ok(srv, "the eventually-bound server is returned");
  assert.equal(typeof srv.address, "function");
  assert.equal(calls(), 3, "three attempts failed before the fourth bound");
  assert.deepEqual(sleeps, [ORIGIN_BIND_RETRY_EVERY_MS, ORIGIN_BIND_RETRY_EVERY_MS, ORIGIN_BIND_RETRY_EVERY_MS]);
  assert.equal(ORIGIN_BIND_RETRY_EVERY_MS, 5000, "5 s between attempts");
  assert.equal(ORIGIN_BIND_RETRY_WINDOW_MS, 120000, "a 2 minute window");
  assert.equal(logs.length, 3, "each waiting attempt says why");
  for (const l of logs) assert.match(l, /artifact origin waiting for its bind address \(EADDRNOTAVAIL\)/);
});

test("the window is bounded: after 2 minutes of a missing address it warns once and gives up (no throw)", async () => {
  const { start, calls } = flakyStart(Infinity);
  const sleeps = [], logs = [];
  const srv = await startArtifactOriginWithBindRetry({
    start, env: {}, log: (m) => logs.push(String(m)), sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(srv, null, "the origin is off, the boot continues");
  // 1 immediate attempt + one per sleep inside the window.
  const attempts = ORIGIN_BIND_RETRY_WINDOW_MS / ORIGIN_BIND_RETRY_EVERY_MS + 1;
  assert.equal(calls(), attempts, `one attempt per ${ORIGIN_BIND_RETRY_EVERY_MS} ms`);
  assert.equal(sleeps.length, attempts - 1, "no sleep after the last attempt");
  assert.equal(sleeps.reduce((a, b) => a + b, 0), ORIGIN_BIND_RETRY_WINDOW_MS, "the window is 2 minutes of waiting");
  const last = logs.at(-1);
  assert.match(last, /artifact origin NOT started: .*EADDRNOTAVAIL/);
  assert.match(last, /2 minute|120s|After=docker\.service/);
  assert.equal(logs.filter((l) => /NOT started/.test(l)).length, 1, "exactly one give-up line");
});

test("a typo is not a race: any other error is rethrown on the first attempt", async () => {
  for (const err of [
    new Error("CROW_ARTIFACT_ORIGIN_PORT must be a port number (1-65535)"),
    Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" }),
    Object.assign(new Error("CROW_ARTIFACT_ORIGIN_URL must be scheme://host[:port] with no path"), { code: "ERR_INVALID_URL" }),
  ]) {
    let calls = 0;
    const sleeps = [];
    await assert.rejects(
      () => startArtifactOriginWithBindRetry({ start: async () => { calls++; throw err; }, env: {}, sleep: async (ms) => sleeps.push(ms), log: () => {} }),
      (e) => e === err,
      err.message,
    );
    assert.equal(calls, 1, err.message);
    assert.deepEqual(sleeps, [], "nothing is retried");
  }
});

test("isAddressNotAvailable reads the code, including a nested cause", () => {
  assert.equal(isAddressNotAvailable(addrNotAvailable()), true);
  assert.equal(isAddressNotAvailable({ cause: { code: "EADDRNOTAVAIL" } }), true);
  assert.equal(isAddressNotAvailable(Object.assign(new Error("x"), { code: "EADDRINUSE" })), false);
  assert.equal(isAddressNotAvailable(new Error("x")), false);
  assert.equal(isAddressNotAvailable(null), false);
  assert.equal(isAddressNotAvailable(undefined), false);
});

test("no port configured is not a retry: the helper returns null at once (nothing to bind)", async () => {
  // The real starter with an empty env, through the retry wrapper.
  _resetForTest();
  const sleeps = [];
  const out = await startArtifactOriginWithBindRetry({ env: {}, sleep: async (ms) => sleeps.push(ms), log: () => {} });
  assert.equal(out, null);
  assert.deepEqual(sleeps, []);
  assert.equal(artifactOriginInfo(), null);
  assert.equal(typeof startArtifactOriginFromEnv, "function");
});

test("the fallback origin URL follows the bind: localhost for loopback/wildcards, the address itself otherwise", () => {
  // The documented fallback (and the hostname a dashboard tab on this machine
  // uses, so isolationFor stays `shared-host`).
  for (const bind of ["127.0.0.1", "127.0.0.2", "127.1", "localhost", "0.0.0.0", "::", "::1", "[::1]"]) {
    assert.equal(fallbackOriginUrl(bind, 3090), "http://localhost:3090", bind);
  }
  // A bridge gateway bind is not this machine's loopback: naming it is the only
  // address that answers there, and the isolation is `own-host` regardless.
  assert.equal(fallbackOriginUrl("172.30.0.1", 3090), "http://172.30.0.1:3090");
  assert.equal(fallbackOriginUrl("fd00::1", 3090), "http://[fd00::1]:3090", "IPv6 brackets are kept");
  assert.equal(fallbackOriginUrl("crow-artifacts", 3092), "http://crow-artifacts:3092");
  assert.equal(new URL(fallbackOriginUrl("172.30.0.1", 3090)).port, "3090");
});

test("the retry sleep is unref'd: a pending sleep never holds the process open (review N6)", async () => {
  // A CHILD process is the only honest check: with a ref'd timer it lives out the
  // full 60 s and the 10 s timeout kills it, which is the failure this pins.
  const mod = new URL("../servers/gateway/artifact-origin/runtime.js", import.meta.url).href;
  const code = `import(${JSON.stringify(mod)}).then(({ defaultSleep }) => { defaultSleep(60000); });`;
  const started = Date.now();
  const run = await new Promise((resolve) => {
    execFile(process.execPath, ["-e", code], { timeout: 10000, encoding: "utf8" }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
  assert.equal(run.err, null, `a pending unref'd sleep must not keep node alive: ${run.err?.message ?? ""} ${run.stderr ?? ""}`);
  assert.ok(Date.now() - started < 10000, "the child exited on its own, well before the sleep ran out");
  assert.equal(run.stdout.trim(), "", "the sleep resolves nothing by itself");
  // The seam is the exported default, and it still resolves.
  await defaultSleep(1);
});

test("the gateway's mount retries in the BACKGROUND, so a missing bridge never holds the dashboard's listen", () => {
  // Source pin: the mount starts the origin without awaiting it, and both
  // outcomes are logged (a failure must still be named, never swallowed).
  const src = readFileSync(new URL("../servers/gateway/boot/mcp-mounts.js", import.meta.url), "utf8");
  assert.match(src, /origin\.startArtifactOriginWithBindRetry\(\{ env: process\.env \}\)/);
  assert.doesNotMatch(src, /await origin\.startArtifactOriginWithBindRetry/, "not awaited: boot must not wait 2 minutes");
  assert.doesNotMatch(src, /await origin\.startArtifactOriginFromEnv/, "the retry replaces the single attempt");
  assert.match(src, /artifact origin NOT started: \$\{err\.message\}/, "a real failure is still reported");
});