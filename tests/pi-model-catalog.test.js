// tests/pi-model-catalog.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePiListModels, listPiModels, checkPiModel, invalidatePiModelCache, piModelsFileKeys } from "../scripts/pi-bots/pi-model-catalog.mjs";

// CI has no pi installed: every call injects the resolvers.
const R = { resolvePiCliFn: () => ({ cliPath: "/fake/pi/cli.js", source: "env" }), resolveNodeBinFn: () => "/fake/node", piKeysFn: () => null };
const OUT = [
  "provider         model              context  max-out  thinking  images",
  "crow-chat        qwen3.6-35b-a3b    262K     32K      yes       yes",
  "Qwen Cloud       qwen3.8-max        1M       64K      yes       no",
  "zai-coding       glm-5.1            200K     32K      yes       no",
].join("\n");
const okExec = (counter) => (cmd, args, opts, cb) => { if (counter) counter.n++; setImmediate(() => cb(null, OUT, "")); };

test("parse: columns are separated by two or more spaces (provider ids may contain one space)", () => {
  const keys = parsePiListModels(OUT);
  assert.ok(keys.has("crow-chat/qwen3.6-35b-a3b"));
  assert.ok(keys.has("Qwen Cloud/qwen3.8-max"));
  assert.equal(keys.size, 3);
});

test("listing is async, cached for ttl, shared between concurrent callers, and invalidated on demand", async () => {
  invalidatePiModelCache();
  const c = { n: 0 };
  let t = 0;
  const [a, b] = await Promise.all([listPiModels({ ...R, execFileFn: okExec(c), nowFn: () => t }), listPiModels({ ...R, execFileFn: okExec(c), nowFn: () => t })]);
  assert.equal(c.n, 1, "one spawn for two concurrent callers");
  assert.ok(a.ok && b.ok);
  t = 1000;
  await listPiModels({ ...R, execFileFn: okExec(c), nowFn: () => t });
  assert.equal(c.n, 1, "cached");
  invalidatePiModelCache();
  await listPiModels({ ...R, execFileFn: okExec(c), nowFn: () => t });
  assert.equal(c.n, 2);
});

test("unknown model fails with the exact operator message (after one forced re-list)", async () => {
  invalidatePiModelCache();
  const c = { n: 0 };
  const r = await checkPiModel({ provider: "crow-chat", model: "nope" }, { ...R, execFileFn: okExec(c) });
  assert.deepEqual(r, { ok: false, message: 'model "crow-chat/nope" is not available to the bot engine' });
  assert.equal(c.n, 2);
});

test("a failed listing or a missing pi lets the turn proceed (unverified)", async () => {
  invalidatePiModelCache();
  const failing = (cmd, args, opts, cb) => setImmediate(() => cb(new Error("exit 1"), "", "boom"));
  assert.deepEqual(await checkPiModel({ provider: "crow-chat", model: "qwen3.6-35b-a3b" }, { ...R, execFileFn: failing }), { ok: true, unverified: true });
  invalidatePiModelCache();
  assert.equal((await listPiModels({ resolvePiCliFn: () => null, resolveNodeBinFn: () => "/fake/node" })).ok, false);
});

test("a known model passes", async () => {
  invalidatePiModelCache();
  assert.deepEqual(await checkPiModel({ provider: "zai-coding", model: "glm-5.1" }, { ...R, execFileFn: okExec() }), { ok: true });
});

test("a key declared in pi's models.json passes without spawning pi", async () => {
  invalidatePiModelCache();
  const c = { n: 0 };
  const r = await checkPiModel({ provider: "crow-chat", model: "qwen3.6-35b-a3b" }, { ...R, piKeysFn: () => new Set(["crow-chat/qwen3.6-35b-a3b"]), execFileFn: okExec(c) });
  assert.deepEqual(r, { ok: true });
  assert.equal(c.n, 0);
});

test("piModelsFileKeys reads models.json without spawning; unreadable → null", () => {
  const json = JSON.stringify({ $crowManaged: ["crow-chat"], providers: { "crow-chat": { models: [{ id: "qwen3.6-35b-a3b" }] }, "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } } });
  const keys = piModelsFileKeys({ path: "/x", readFileFn: () => json });
  assert.ok(keys.has("crow-chat/qwen3.6-35b-a3b") && keys.has("crow-local/qwen3.6-35b-a3b"));
  assert.equal(piModelsFileKeys({ path: "/x", readFileFn: () => { throw new Error("ENOENT"); } }), null);
});

test("PiModelUnavailableError carries the PI_MODEL_UNAVAILABLE code, and the bridge replies with it instead of only logging", async () => {
  const { PiModelUnavailableError } = await import("../scripts/pi-bots/pi-model-catalog.mjs");
  const e = new PiModelUnavailableError('model "a/b" is not available to the bot engine');
  assert.equal(e.code, "PI_MODEL_UNAVAILABLE");
  // bridge_tick/discord_gateway only log a rejected handleInbound; the bridge
  // must catch this error around prepareSpawn and sendReply it.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "pi-bots", "bridge.mjs"), "utf8");
  const at = src.indexOf("spawnPrep = await prepareSpawn(");
  assert.ok(at > 0, "prepareSpawn is awaited inside a try");
  const block = src.slice(at, at + 1200);
  assert.match(block, /PI_MODEL_UNAVAILABLE/);
  assert.match(block, /sendReply\(/);
});
