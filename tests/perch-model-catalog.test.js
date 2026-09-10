// The session-free model list: one source for the launcher's picker (which has
// no session yet) and for options()'s fallback on a session with no live child.
// Two lists that could disagree about what this instance serves is the defect
// class the module exists to prevent, so this pins the SHAPE both consume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerModelList, modelKey } from "../servers/gateway/perch-model-catalog.js";

const cfg = (providers) => ({ load: () => ({ providers }) });

test("every model of every provider row becomes a pi-shaped entry", async () => {
  // pi's own Model object (its rpc docs) is {id, name, provider, baseUrl, …},
  // and that is what the drawer, the launcher and annotateAvailability read.
  const list = providerModelList(cfg({
    "crow-local": { baseUrl: "http://x:8003/v1", models: [{ id: "qwen3.6-35b-a3b", name: "Qwen" }] },
    "zai-coding": { baseUrl: "https://api.z.ai/v4", models: [{ id: "glm-5.1" }, { id: "glm-5" }] },
  }));
  assert.deepEqual(list, [
    { id: "qwen3.6-35b-a3b", name: "Qwen", provider: "crow-local", baseUrl: "http://x:8003/v1" },
    { id: "glm-5.1", provider: "zai-coding", baseUrl: "https://api.z.ai/v4" },
    { id: "glm-5", provider: "zai-coding", baseUrl: "https://api.z.ai/v4" },
  ]);
});

test("baseUrl rides along on every entry — it is what the availability probe addresses", async () => {
  const list = providerModelList(cfg({ p: { baseUrl: "http://probe-me/v1", models: [{ id: "m" }] } }));
  assert.equal(list[0].baseUrl, "http://probe-me/v1");
  // A row with no baseUrl is still listed; annotateAvailability falls through
  // to the warmability question for it rather than dropping the model.
  const noUrl = providerModelList(cfg({ p: { models: [{ id: "m" }] } }));
  assert.equal(noUrl.length, 1);
  assert.equal(noUrl[0].baseUrl, null);
});

test("every field the provider row carries on a model is preserved", async () => {
  const list = providerModelList(cfg({
    p: { baseUrl: "u", models: [{ id: "m", name: "M", reasoning: true, contextWindow: 262144 }] },
  }));
  assert.equal(list[0].reasoning, true);
  assert.equal(list[0].contextWindow, 262144);
});

test("a bare id string is a model too — the shape bot-builder's loader also tolerates", async () => {
  const list = providerModelList(cfg({ p: { baseUrl: "u", models: ["plain-id"] } }));
  assert.deepEqual(list, [{ id: "plain-id", provider: "p", baseUrl: "u" }]);
});

test("models.json schema meta keys are not providers", async () => {
  const list = providerModelList(cfg({
    $schema: { models: [{ id: "nope" }] },
    real: { baseUrl: "u", models: [{ id: "yes" }] },
  }));
  assert.deepEqual(list.map((m) => m.id), ["yes"]);
});

test("junk is skipped, never rendered as an entry with no id", async () => {
  const list = providerModelList(cfg({
    empty: { baseUrl: "u", models: [] },
    nullish: null,
    notArray: { baseUrl: "u", models: "qwen" },
    idless: { baseUrl: "u", models: [{ name: "no id here" }, { id: "" }, null] },
    good: { baseUrl: "u", models: [{ id: "keep" }] },
  }));
  assert.deepEqual(list.map((m) => m.id), ["keep"]);
});

test("no registry at all is an empty list, never a throw", async () => {
  // loadProviders() reads a DB and a file; a caller listing models must not
  // 500 a page because neither is readable.
  assert.deepEqual(providerModelList({ load: () => { throw new Error("no db"); } }), []);
  assert.deepEqual(providerModelList({ load: () => null }), []);
  assert.deepEqual(providerModelList({ load: () => ({}) }), []);
  assert.deepEqual(providerModelList(cfg({})), []);
});

test("modelKey speaks the one key definition.models.default and control() both use", async () => {
  assert.equal(modelKey({ provider: "crow-local", id: "qwen3.6-35b-a3b" }), "crow-local/qwen3.6-35b-a3b");
  assert.equal(modelKey({ provider: "p" }), null);
  assert.equal(modelKey(null), null);
});

test("the default source really is loadProviders — the established session-free path", async () => {
  // A precondition test, not a behaviour one: prove the module resolves its
  // real dependency and returns an array here, so a renamed export cannot wait
  // to bite the first operator who opens the launcher on a live box.
  const list = providerModelList();
  assert.ok(Array.isArray(list), "the DB/models.json-backed default must return a list, whatever this host has");
});
