import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, EXIT_CONCURRENT_WRITE } from "../scripts/models-runtime-override.mjs";
import { loadState, saveState, statePath } from "../servers/gateway/models/state.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "models-runtime-override.mjs");
const overrideOpts = {
  accessSyncImpl: () => {},
  spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "version: 10068 (abc1234)\n" }),
  now: () => new Date("2026-09-23T00:00:00Z"),
};

async function run(dir, argv, extra = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    dir,
    out: (s) => out.push(String(s)),
    err: (s) => err.push(String(s)),
    overrideOpts,
    catalogIds: ["qwen3.6-35b-a3b"],
    env: {},
    ...extra,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rt-override-cli-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A saveStateFn that saves, then lets a "gateway" clobber the file `times` times. */
function clobberingSave(times, clobber) {
  let left = times;
  return (d, st) => {
    saveState(d, st);
    if (left > 0) {
      left -= 1;
      saveState(d, clobber(st));
    }
  };
}
const dropOverrides = (st) => ({ ...st, runtimeOverride: null, runtimeOverrides: {} });

test("cli: set --model, get --model, list, clear --model round-trip; set/clear print the data dir", () => withDir(async (dir) => {
  const set = await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server", "--label", "pr-1234"]);
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /qwen3\.6-35b-a3b.*\/opt\/pr\/llama-server.*b10068/);
  assert.ok(set.out.includes(`(data dir: ${dir})`), set.out);
  assert.equal(set.err, "", "a catalog id produces no warning");

  const get = await run(dir, ["get", "--model", "qwen3.6-35b-a3b"]);
  assert.equal(get.code, 0);
  assert.deepEqual(JSON.parse(get.out), { bin: "/opt/pr/llama-server", label: "pr-1234", version: "b10068", setAt: "2026-09-23T00:00:00.000Z" });

  const list = await run(dir, ["list"]);
  assert.equal(list.code, 0);
  const parsed = JSON.parse(list.out);
  assert.equal(parsed.dataDir, dir);
  assert.equal(parsed.host, null);
  assert.equal(parsed.models["qwen3.6-35b-a3b"].bin, "/opt/pr/llama-server");

  const clear = await run(dir, ["clear", "--model", "qwen3.6-35b-a3b"]);
  assert.equal(clear.code, 0);
  assert.match(clear.out, /cleared/);
  assert.ok(clear.out.includes(`(data dir: ${dir})`), clear.out);
  assert.deepEqual(loadState(dir).runtimeOverrides, {});
  assert.match((await run(dir, ["clear", "--model", "qwen3.6-35b-a3b"])).out, /nothing to clear/);
  assert.equal((await run(dir, ["get", "--model", "qwen3.6-35b-a3b"])).out, "none");
}));

test("cli: without --model, set/get/clear act on the host override and leave per-model entries alone", () => withDir(async (dir) => {
  await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server"]);
  assert.equal((await run(dir, ["get"])).out, "none");
  const set = await run(dir, ["set", "--bin", "/opt/host/llama-server"]);
  assert.equal(set.code, 0, set.err);
  assert.ok(set.out.includes(`(data dir: ${dir})`), set.out);
  assert.equal(JSON.parse((await run(dir, ["get"])).out).bin, "/opt/host/llama-server");
  assert.equal((await run(dir, ["clear"])).code, 0);
  assert.equal(loadState(dir).runtimeOverride, null);
  assert.ok(loadState(dir).runtimeOverrides["qwen3.6-35b-a3b"], "per-model entry survived the host clear");
}));

test("cli: host clear with no host override stored neither creates nor rewrites state.json", () => withDir(async (dir) => {
  const r = await run(dir, ["clear"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to clear \(host override\)/);
  assert.equal(existsSync(statePath(dir)), false);
}));

test("cli: host get/clear warn when CROW_LLAMA_SERVER_BIN is set; --model commands and an unset env do not", () => withDir(async (dir) => {
  const env = { CROW_LLAMA_SERVER_BIN: "/opt/env/llama-server" };
  assert.match((await run(dir, ["get"], { env })).err, /CROW_LLAMA_SERVER_BIN is set.*re-bootstraps the host override/);
  assert.match((await run(dir, ["clear"], { env })).err, /re-bootstraps the host override/);
  assert.equal((await run(dir, ["get", "--model", "qwen3.6-35b-a3b"], { env })).err, "");
  assert.equal((await run(dir, ["get"])).err, "");
}));

test("cli: a write clobbered once by a concurrent gateway write is retried and lands (exit 0)", () => withDir(async (dir) => {
  const r = await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server"], {
    overrideOpts: { ...overrideOpts, saveStateFn: clobberingSave(1, dropOverrides) },
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(loadState(dir).runtimeOverrides["qwen3.6-35b-a3b"].bin, "/opt/pr/llama-server");
}));

test("cli: a write clobbered twice exits 3 naming the concurrent gateway write (set, host set, and clear)", () => withDir(async (dir) => {
  const always = { ...overrideOpts, saveStateFn: clobberingSave(99, dropOverrides) };
  const setModel = await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server"], { overrideOpts: always });
  assert.equal(setModel.code, EXIT_CONCURRENT_WRITE);
  assert.match(setModel.err, /concurrent gateway write overwrote it/);
  const setHost = await run(dir, ["set", "--bin", "/opt/host/llama-server"], { overrideOpts: always });
  assert.equal(setHost.code, EXIT_CONCURRENT_WRITE);

  // clear: the "gateway" keeps writing the old record back.
  await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server"]);
  const rec = loadState(dir).runtimeOverrides["qwen3.6-35b-a3b"];
  const restore = { ...overrideOpts, saveStateFn: clobberingSave(99, (st) => ({ ...st, runtimeOverrides: { "qwen3.6-35b-a3b": rec } })) };
  const clear = await run(dir, ["clear", "--model", "qwen3.6-35b-a3b"], { overrideOpts: restore });
  assert.equal(clear.code, EXIT_CONCURRENT_WRITE);
  assert.match(clear.err, /concurrent gateway write overwrote it/);
}));

test("cli: a binary that fails validation exits 1 with the code, and persists nothing", () => withDir(async (dir) => {
  const rel = await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "llama-server"]);
  assert.equal(rel.code, 1);
  assert.match(rel.err, /NOT_ABSOLUTE/);
  const bad = await run(dir, ["set", "--bin", "/x/llama-server"], {
    overrideOpts: { ...overrideOpts, spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "boom" }) },
  });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /VERSION_FAILED/);
  assert.deepEqual(loadState(dir).runtimeOverrides, {});
  assert.equal(loadState(dir).runtimeOverride, null);
}));

test("cli: an id matching no catalog id and no registered model warns but is still stored (provider-name fallback is legal)", () => withDir(async (dir) => {
  const r = await run(dir, ["set", "--model", "crow-chat", "--bin", "/opt/x/llama-server"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /warning: "crow-chat" matches no catalog id/);
  assert.ok(loadState(dir).runtimeOverrides["crow-chat"]);

  saveState(dir, { ...loadState(dir), registry: { "my-hf-model@Q4": { file: "m.gguf", catalogId: "my-hf-model", quant: "Q4" } } });
  const reg = await run(dir, ["set", "--model", "my-hf-model", "--bin", "/opt/x/llama-server"]);
  assert.equal(reg.err, "", "a registered catalogId is known — no warning");
}));

test("cli: usage errors exit 2", () => withDir(async (dir) => {
  for (const argv of [[], ["frobnicate"], ["set"], ["list", "--bogus"], ["get", "--model", ""], ["list", "extra"]]) {
    const r = await run(dir, argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /usage|needs|Unknown option|unknown command/i, JSON.stringify(argv));
  }
  assert.equal((await run(dir, ["--help"])).code, 0);
}));

test("cli (child process): resolves the data dir from CROW_DATA_DIR; list/get/host-clear never write state or bootstrap CROW_LLAMA_SERVER_BIN", () => withDir(async (dir) => {
  saveState(dir, { ...loadState(dir), runtimeOverrides: { "qwen3.6-35b-a3b": { bin: "/opt/seeded/llama-server", label: null, version: "b1", setAt: "2026-09-23T00:00:00Z" } } });
  const env = { ...process.env, CROW_DATA_DIR: dir };
  delete env.CROW_LLAMA_SERVER_BIN;
  const list = spawnSync(process.execPath, [SCRIPT, "list"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout);
  assert.equal(parsed.dataDir, resolve(dir));
  assert.equal(parsed.models["qwen3.6-35b-a3b"].bin, "/opt/seeded/llama-server");

  // A fresh dir + an env bin that WOULD validate (node --version exits 0):
  // if any of these went through getRuntimeOverride's bootstrap, or host
  // clear wrote unconditionally, state.json would appear. It must not.
  const fresh = mkdtempSync(join(tmpdir(), "rt-override-cli-fresh-"));
  try {
    const env2 = { ...process.env, CROW_DATA_DIR: fresh, CROW_LLAMA_SERVER_BIN: process.execPath };
    for (const argv of [["list"], ["get"], ["clear"]]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...argv], { env: env2, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(existsSync(statePath(fresh)), false, "read-only commands and a no-op host clear must not create state.json");
  } finally { rmSync(fresh, { recursive: true, force: true }); }
}));
