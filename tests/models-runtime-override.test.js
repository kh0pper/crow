import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState } from "../servers/gateway/models/state.js";
import { getRuntimeOverride, setRuntimeOverride, clearRuntimeOverride, parseLlamaServerVersion, RuntimeOverrideError } from "../servers/gateway/models/runtime-override.js";

const okAccess = () => {};
const okSpawn = () => ({ status: 0, stdout: "", stderr: "version: 10068 (abc1234)\nbuilt with cc\n" });

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rt-override-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("parseLlamaServerVersion maps llama-server's version line to a b-tag", () => {
  assert.equal(parseLlamaServerVersion("version: 10068 (abc1234)\nbuilt with"), "b10068");
  assert.equal(parseLlamaServerVersion("something else\n"), "something else");
});

test("parseLlamaServerVersion returns a modern dev-build version line verbatim", () => {
  assert.equal(
    parseLlamaServerVersion("version: 0.2.0-dev (build 405, commit b21e4de74)\nbuilt with GNU 13.3.0"),
    "0.2.0-dev (build 405, commit b21e4de74)"
  );
});

test("parseLlamaServerVersion finds the version line past a leading blank line", () => {
  assert.equal(
    parseLlamaServerVersion("\nversion: 0.3.0-dev (build 1, commit 035e227)\n"),
    "0.3.0-dev (build 1, commit 035e227)"
  );
});

test("getRuntimeOverride is null with no record and no env", () => withDir((dir) => {
  assert.equal(getRuntimeOverride(dir, { env: {} }), null);
}));

test("setRuntimeOverride validates and persists { bin, label, version, setAt }", () => withDir((dir) => {
  const rec = setRuntimeOverride(dir, { bin: "/opt/llama/llama-server", label: "rocm-7.2.3" },
    { spawnSyncImpl: okSpawn, accessSyncImpl: okAccess, now: () => new Date("2026-09-05T00:00:00Z") });
  assert.deepEqual(rec, { bin: "/opt/llama/llama-server", label: "rocm-7.2.3", version: "b10068", setAt: "2026-09-05T00:00:00.000Z" });
  assert.deepEqual(loadState(dir).runtimeOverride, rec);
  assert.equal(getRuntimeOverride(dir, { env: {} }).source, "state");
}));

test("setRuntimeOverride stores a modern dev-build version line verbatim", () => withDir((dir) => {
  const rec = setRuntimeOverride(dir, { bin: "/opt/llama/llama-server" },
    { spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "version: 0.2.0-dev (build 405, commit b21e4de74)\n" }), accessSyncImpl: okAccess });
  assert.equal(rec.version, "0.2.0-dev (build 405, commit b21e4de74)");
}));

test("setRuntimeOverride refuses a relative path, a non-executable, and a binary whose --version fails", () => withDir((dir) => {
  assert.throws(() => setRuntimeOverride(dir, { bin: "llama-server" }, { spawnSyncImpl: okSpawn, accessSyncImpl: okAccess }),
    (e) => e instanceof RuntimeOverrideError && e.code === "NOT_ABSOLUTE");
  assert.throws(() => setRuntimeOverride(dir, { bin: "/x/llama-server" }, { spawnSyncImpl: okSpawn, accessSyncImpl: () => { throw new Error("EACCES"); } }),
    (e) => e.code === "NOT_EXECUTABLE");
  assert.throws(() => setRuntimeOverride(dir, { bin: "/x/llama-server" }, { spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "boom" }), accessSyncImpl: okAccess }),
    (e) => e.code === "VERSION_FAILED" && /exit 1/.test(e.message));
  assert.throws(() => setRuntimeOverride(dir, { bin: "/x/llama-server" }, { spawnSyncImpl: () => ({ error: new Error("ENOENT") }), accessSyncImpl: okAccess }),
    (e) => e.code === "VERSION_FAILED" && /ENOENT/.test(e.message));
  assert.equal(loadState(dir).runtimeOverride, null);
}));

test("getRuntimeOverride bootstraps from CROW_LLAMA_SERVER_BIN once and persists it", () => withDir((dir) => {
  const env = { CROW_LLAMA_SERVER_BIN: "/env/llama-server" };
  const rec = getRuntimeOverride(dir, { env, accessSyncImpl: okAccess, spawnSyncImpl: okSpawn });
  assert.equal(rec.bin, "/env/llama-server");
  assert.equal(rec.source, "env");
  assert.equal(loadState(dir).runtimeOverride.bin, "/env/llama-server");
  // A stored record wins over env afterwards.
  setRuntimeOverride(dir, { bin: "/stored/llama-server" }, { spawnSyncImpl: okSpawn, accessSyncImpl: okAccess });
  assert.equal(getRuntimeOverride(dir, { env }).bin, "/stored/llama-server");
}));

test("getRuntimeOverride ignores an env bootstrap that fails validation (never throws)", () => withDir((dir) => {
  const env = { CROW_LLAMA_SERVER_BIN: "/missing/llama-server" };
  assert.equal(getRuntimeOverride(dir, { env, accessSyncImpl: () => { throw new Error("ENOENT"); } }), null);
}));

test("clearRuntimeOverride removes the record", () => withDir((dir) => {
  setRuntimeOverride(dir, { bin: "/x/llama-server" }, { spawnSyncImpl: okSpawn, accessSyncImpl: okAccess });
  assert.equal(clearRuntimeOverride(dir), true);
  assert.equal(getRuntimeOverride(dir, { env: {} }), null);
  assert.equal(clearRuntimeOverride(dir), false);
}));
