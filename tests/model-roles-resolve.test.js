import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORE_ROLES, isRoleRef, roleIdOf, isValidCustomRoleId,
  resolveRoleKey, resolveChosenRoleKey, isConfigured, sameServer, isCloudKey, cloudStatus,
} from "../servers/shared/model-roles.js";

const prov = (id, modelIds, extra = {}) => ({
  id, baseUrl: `http://10.0.0.5:8000/${id}/v1`, host: "local", disabled: false,
  models: modelIds.map((m) => (typeof m === "string" ? { id: m } : m)), gpuPolicy: null, ...extra,
});
// the loadModels() shape, built from the enabled provider rows
const modelsOf = (providers) => ({
  providers: Object.fromEntries(providers.filter((p) => !p.disabled).map((p) => [p.id, { models: p.models }])),
});
const run = (key, o) => {
  const providers = o.providers;
  return resolveRoleKey(key, { need: o.need, bindings: o.bindings || {}, customDefs: o.customDefs || {}, providers, models: o.models || modelsOf(providers), catalog: o.catalog || [] });
};

test("vocabulary matches the spec table", () => {
  // the full id list is pinned in tests/model-roles-vocabulary.test.js
  const by = Object.fromEntries(CORE_ROLES.map((r) => [r.id, r]));
  assert.deepEqual(by.coordinator.defaultFallback, ["deep", "everyday"]);
  assert.equal(by.deep.allowHeavy, true);
  assert.equal(by.everyday.allowHeavy, false);
  assert.equal(by.rerank.capability, "score");
  assert.equal(by.vision.capability, "vision");
});

test("ref helpers", () => {
  assert.equal(isRoleRef("role:everyday"), true);
  assert.equal(isRoleRef("local-chat/m1"), false);
  assert.equal(roleIdOf("role:deep"), "deep");
  assert.equal(roleIdOf("a/b"), null);
});

test("custom role id rules", () => {
  assert.equal(isValidCustomRoleId("c-coder"), true);
  assert.equal(isValidCustomRoleId("coder"), false);
  assert.equal(isValidCustomRoleId("c-" + "x".repeat(33)), false);
  assert.equal(isValidCustomRoleId("c-" + "x".repeat(32)), true);
  assert.equal(isValidCustomRoleId("c-Upper"), false);
});

test("raw key passes through", () => {
  const providers = [prov("local-chat", ["m1"])];
  const r = run("local-chat/m1", { providers });
  assert.equal(r.key, "local-chat/m1");
  assert.equal(r.role, null);
  assert.equal(r.reason, "raw");
});

test("raw key is never filtered", () => {
  const providers = [prov("p", [{ id: "m", task: "embed" }], { host: "a".repeat(32) })];
  assert.equal(run("p/m", { providers, need: "chat" }).key, "p/m");
});

test("bound role resolves", () => {
  const providers = [prov("local-chat", ["m1"])];
  const r = run("role:everyday", { providers, bindings: { everyday: { model: "local-chat/m1", fallback: ["quick"] } } });
  assert.deepEqual({ key: r.key, role: r.role, chain: r.chain, reason: r.reason }, { key: "local-chat/m1", role: "everyday", chain: ["everyday"], reason: "bound" });
});

test("disabled provider walks chain", () => {
  const providers = [prov("local-chat", ["m1"], { disabled: true }), prov("local-voice", ["m2"])];
  const r = run("role:everyday", { providers, bindings: {
    everyday: { model: "local-chat/m1", fallback: ["quick"] },
    quick: { model: "local-voice/m2", fallback: [] },
  } });
  assert.equal(r.key, "local-voice/m2");
  assert.deepEqual(r.chain, ["everyday", "quick"]);
  assert.equal(r.reason, "fallback");
});

test("asleep is not a fallback", () => {
  const providers = [prov("local-chat", ["m1"], { health: "down" })];
  const r = run("role:everyday", { providers, bindings: { everyday: { model: "local-chat/m1", fallback: ["quick"] } } });
  assert.equal(r.reason, "bound");
});

test("unset binding and nothing to fall to", () => {
  const r = run("role:expert", { providers: [], bindings: {} });
  assert.deepEqual({ key: r.key, reason: r.reason }, { key: null, reason: "unset" });
});

test("cycle stops", () => {
  const defs = { "c-a": { capability: "chat", allowHeavy: false }, "c-b": { capability: "chat", allowHeavy: false } };
  const r = run("role:c-a", { providers: [], customDefs: defs, bindings: { "c-a": { model: "role:c-b", fallback: [] }, "c-b": { model: "role:c-a", fallback: [] } } });
  assert.deepEqual({ key: r.key, reason: r.reason }, { key: null, reason: "cycle" });
  const ids = ["c-a", "c-b", "c-c", "c-d", "c-e"];
  const customDefs = Object.fromEntries(ids.map((i) => [i, { capability: "chat", allowHeavy: false }]));
  const bindings = Object.fromEntries(ids.map((i, n) => [i, { model: n < 4 ? `role:${ids[n + 1]}` : "p/m", fallback: [] }]));
  const providers = [prov("p", ["m"])];
  const r5 = run("role:c-a", { providers, customDefs, bindings });
  assert.deepEqual({ key: r5.key, reason: r5.reason }, { key: null, reason: "too_deep" });
});

test("default mutual fallbacks are not a cycle", () => {
  const r = run("role:everyday", { providers: [], bindings: {} });
  assert.equal(r.reason, "unset");
});

test("unknown role", () => {
  const r = run("role:nope", { providers: [] });
  assert.deepEqual({ key: r.key, reason: r.reason }, { key: null, reason: "unknown_role" });
});

test("capability", () => {
  const providers = [prov("p", [{ id: "e", task: "embed" }]), prov("q", ["c"])];
  const bindings = { everyday: { model: "p/e", fallback: ["quick"] }, quick: { model: "q/c", fallback: [] } };
  const ok = run("role:everyday", { providers, bindings, need: "chat" });
  assert.deepEqual({ key: ok.key, reason: ok.reason }, { key: "q/c", reason: "fallback" });
  const none = run("role:everyday", { providers, bindings: { everyday: { model: "p/e", fallback: [] } }, need: "chat" });
  assert.deepEqual({ key: none.key, reason: none.reason }, { key: null, reason: "capability" });
});

test("heavy refused for automatic role, allowed for deep", () => {
  const providers = [prov("big", ["m"], { gpuPolicy: { catalogId: "big-cat" } })];
  const catalog = [{ id: "big-cat", serving: { class: "windowed" } }];
  const every = run("role:everyday", { providers, catalog, bindings: { everyday: { model: "big/m", fallback: [] } } });
  assert.equal(every.key, null);
  const deep = run("role:deep", { providers, catalog, bindings: { deep: { model: "big/m", fallback: [] } } });
  assert.deepEqual({ key: deep.key, reason: deep.reason }, { key: "big/m", reason: "bound" });
});

test("serving override comes only from the explicit option, never a row field", () => {
  const catalog = [{ id: "big-cat", serving: { class: "windowed" } }];
  const bindings = { everyday: { model: "big/m", fallback: [] } };
  const rowField = [prov("big", ["m"], { gpuPolicy: { catalogId: "big-cat", servingOverride: "windowed" }, servingOverride: "windowed" })];
  assert.equal(run("role:everyday", { providers: rowField, catalog, bindings }).key, null);
  const providers = [prov("big", ["m"], { gpuPolicy: { catalogId: "big-cat" } })];
  const r = resolveRoleKey("role:everyday", { bindings, providers, models: modelsOf(providers), catalog, servingOverrides: { big: "windowed" } });
  assert.equal(r.key, "big/m");
});

test("class filter still applies when the provider row is missing", () => {
  const catalog = [{ id: "ghost", serving: { class: "wedge-risk" } }];
  const models = { providers: { ghost: { models: [{ id: "m" }] } } };
  const r = resolveRoleKey("role:everyday", { bindings: { everyday: { model: "ghost/m", fallback: [] } }, providers: [], models, catalog });
  assert.equal(r.key, null);
  const ok = resolveRoleKey("role:everyday", { bindings: { everyday: { model: "ghost/m", fallback: [] } }, providers: [], models, catalog: [] });
  assert.equal(ok.key, "ghost/m");
});

test("a role walk that needs the foreign check requires ownInstanceId", () => {
  const providers = [prov("far", ["m"], { host: "b".repeat(32) })];
  assert.throws(() => run("role:everyday", { providers, bindings: { everyday: { model: "far/m", fallback: [] } } }), TypeError);
  assert.equal(run("far/m", { providers }).key, "far/m"); // raw keys need no option
});

test("uncurated (no catalog entry) is allowed", () => {
  const providers = [prov("big", ["m"])];
  assert.equal(run("role:everyday", { providers, bindings: { everyday: { model: "big/m", fallback: [] } } }).reason, "bound");
});

test("foreign-owned row is skipped in a chain", () => {
  const providers = [prov("far", ["m"], { host: "b".repeat(32) }), prov("near", ["m"])];
  const bindings = { everyday: { model: "far/m", fallback: ["quick"] }, quick: { model: "near/m", fallback: [] } };
  const r = resolveRoleKey("role:everyday", { bindings, customDefs: {}, providers, models: modelsOf(providers), catalog: [], ownInstanceId: () => "c".repeat(32) });
  assert.equal(r.key, "near/m");
});

test("configured matches the bot loader", () => {
  const providers = [prov("p", ["other"])];
  const dbModels = modelsOf(providers);
  const fileModels = { providers: { p: { models: [{ id: "m" }] } } };
  assert.equal(isConfigured("p/m", { models: dbModels }), false);
  assert.equal(isConfigured("p/m", { models: fileModels }), true);
  const r = run("role:everyday", { providers, models: dbModels, bindings: { everyday: { model: "p/m", fallback: [] } } });
  assert.equal(r.key, null);
  assert.equal(r.reason, "not_configured");
  const r2 = run("role:everyday", { providers, models: fileModels, bindings: { everyday: { model: "p/m", fallback: [] } } });
  assert.equal(r2.key, "p/m");
});

test("sameServer", () => {
  const providers = [
    prov("local-chat", ["m1", "m2"], { baseUrl: "http://Host.Example:8000/v1/" }),
    prov("local-alias", ["m1", "m2"], { baseUrl: "http://host.example:8000/v1" }),
    prov("other", ["m1"], { baseUrl: "http://other.example:8000/v1" }),
  ];
  assert.equal(sameServer("local-chat/m1", "local-alias/m1", { providers }), true);
  assert.equal(sameServer("local-chat/m1", "local-alias/m2", { providers }), false);
  assert.equal(sameServer("local-chat/m1", "other/m1", { providers }), false);
});

test("cloud through a door", () => {
  const providers = [
    prov("door", ["m"], { baseUrl: "http://192.168.1.5:3001/llm/p/cloud-a/v1", gpuPolicy: { door_forward: true } }),
    prov("cloud-a", ["m"], { baseUrl: "https://api.example.com/v1", host: "cloud" }),
    prov("marked", ["m"], { baseUrl: "http://192.168.1.9:8000/v1", host: "cloud" }),
    prov("plain", ["m"], { baseUrl: "http://192.168.1.9:8000/v1" }),
    prov("mine", ["m"], { baseUrl: "http://203.0.113.7:8000/v1" }),
  ];
  const own = new Set(["203.0.113.7"]);
  assert.equal(isCloudKey("door/m", { providers, ownAddrs: own }), true);
  assert.equal(isCloudKey("cloud-a/m", { providers, ownAddrs: own }), true);
  assert.equal(isCloudKey("marked/m", { providers, ownAddrs: own }), false);
  assert.equal(isCloudKey("plain/m", { providers, ownAddrs: own }), false);
  assert.equal(isCloudKey("mine/m", { providers, ownAddrs: own }), false);
  assert.equal(isCloudKey("door/m", { providers, ownAddrs: own, resolveDoor: () => null }), true); // unnamed upstream: unknown, so warn
});

test("cloudStatus classifies every hop and fails toward warning", () => {
  const providers = [
    prov("pub-door", ["m"], { baseUrl: "https://gw.example.com/llm/p/priv/v1", gpuPolicy: { door_forward: true } }),
    prov("priv", ["m"], { baseUrl: "http://192.168.1.9:8000/v1" }),
    prov("anon-door", ["m"], { baseUrl: "http://192.168.1.5:3001/llm/v1", gpuPolicy: { door_forward: true } }),
    prov("bad", ["m"], { baseUrl: "not a url" }),
    prov("pub-ip", ["m"], { baseUrl: "http://203.0.113.9:8000/v1" }),
  ];
  const own = new Set();
  assert.equal(cloudStatus("pub-door/m", { providers, ownAddrs: own }), "unknown"); // a public NAME cannot be proven public
  assert.equal(cloudStatus("pub-ip/m", { providers, ownAddrs: own }), "cloud");
  assert.equal(cloudStatus("anon-door/m", { providers, ownAddrs: own }), "unknown");
  assert.equal(isCloudKey("anon-door/m", { providers, ownAddrs: own }), true);
  assert.equal(cloudStatus("priv/m", { providers, ownAddrs: own }), "local");
  assert.equal(isCloudKey("priv/m", { providers, ownAddrs: own }), false);
  assert.equal(cloudStatus("bad/m", { providers, ownAddrs: own }), "unknown");
  assert.equal(cloudStatus("missing/m", { providers, ownAddrs: own }), "unknown");
});

test("path depth, not visit count, is capped: coordinator [deep, critic, expert] reaches expert", () => {
  const providers = [prov("p", ["m"])];
  const r = run("role:coordinator", {
    providers,
    bindings: { coordinator: { fallback: ["deep", "critic", "expert"] }, expert: { model: "p/m", fallback: [] } },
  });
  assert.deepEqual({ key: r.key, reason: r.reason }, { key: "p/m", reason: "fallback" });
});

test("a path deeper than MAX_CHAIN_DEPTH reports too_deep; a true cycle still reports cycle", () => {
  const ids = ["c-a", "c-b", "c-c", "c-d", "c-e"];
  const customDefs = Object.fromEntries(ids.map((i) => [i, { capability: "chat", allowHeavy: false }]));
  const bindings = Object.fromEntries(ids.map((i, n) => [i, { model: n < 4 ? `role:${ids[n + 1]}` : "p/m", fallback: [] }]));
  const r = run("role:c-a", { providers: [prov("p", ["m"])], customDefs, bindings });
  assert.equal(r.reason, "too_deep");
  const four = Object.fromEntries(ids.slice(0, 4).map((i, n) => [i, { model: n < 3 ? `role:${ids[n + 1]}` : "p/m", fallback: [] }]));
  assert.equal(run("role:c-a", { providers: [prov("p", ["m"])], customDefs, bindings: four }).key, "p/m");
});

test("task synonyms and case come from provider-task.js", () => {
  const providers = [prov("p", [{ id: "e", task: "embedding" }, { id: "s", task: "Score" }, { id: "r", task: "RERANK" }])];
  const b = (m) => ({ embed: { model: `p/${m}`, fallback: [] }, rerank: { model: `p/${m}`, fallback: [] } });
  assert.equal(run("role:embed", { providers, bindings: b("e"), need: "embed" }).key, "p/e");
  assert.equal(run("role:rerank", { providers, bindings: b("s"), need: "score" }).key, "p/s");
  assert.equal(run("role:rerank", { providers, bindings: b("r"), need: "score" }).key, "p/r");
});

test("cloudStatus locality: only IP literals, own addresses and local suffixes are local", () => {
  const st = (baseUrl, extra = {}) => cloudStatus("x/m", { providers: [prov("x", ["m"], { baseUrl })], ownAddrs: new Set(["localhost"]), ...extra });
  assert.equal(st("https://someone.example.ts.net/v1"), "unknown");
  assert.equal(st("http://openai-proxy:8000/v1"), "unknown");
  assert.equal(st("https://api.example.internal/v1"), "unknown");
  assert.equal(st("https://api.openai.com/v1"), "unknown");
  assert.equal(st("http://box.local:8000/v1"), "local");
  assert.equal(st("http://nas.home.arpa/v1"), "local");
  assert.equal(st("http://192.168.1.5:8000/v1"), "local");
  assert.equal(st("http://100.64.20.5:8000/v1"), "local");
  assert.equal(st("http://localhost:8000/v1"), "local");
  assert.equal(st("http://203.0.113.9/v1"), "cloud");
  assert.equal(st("https://x.tail12345.ts.net/v1"), "unknown");
  assert.equal(st("https://x.tail12345.ts.net/v1", { localSuffixes: [".tail12345.ts.net"] }), "local");
  assert.equal(st("http://box.local/v1", { localSuffixes: [".tail12345.ts.net"] }), "unknown");
});

test("media role refused", () => {
  const providers = [prov("local-tts", ["k"])];
  const r = run("role:tts", { providers, bindings: { tts: { model: "local-tts/k" } } });
  assert.deepEqual({ key: r.key, role: r.role, chain: r.chain, reason: r.reason }, { key: null, role: "tts", chain: [], reason: "capability" });
  const c = resolveChosenRoleKey("role:tts", { bindings: { tts: { model: "local-tts/k" } }, providers, models: modelsOf(providers) });
  assert.deepEqual({ key: c.key, reason: c.reason }, { key: null, reason: "capability" });
});

test("broken chosen voice does not walk to quick", () => {
  const providers = [prov("local-chat", ["m1"])];
  const bindings = { voice: { model: "local-voice/m2" }, quick: { model: "local-chat/m1" } };
  const r = run("role:voice", { providers, bindings });
  assert.deepEqual({ key: r.key, role: r.role, chain: r.chain, reason: r.reason }, { key: null, role: "voice", chain: ["voice"], reason: "not_configured" });
  const r2 = run("role:voice", { providers, bindings: { ...bindings, voice: { model: "local-voice/m2", fallback: ["quick"] } } });
  assert.deepEqual({ key: r2.key, reason: r2.reason }, { key: "local-chat/m1", reason: "fallback" });
});

test("safety has no default chain", () => {
  const providers = [prov("local-chat", ["m1"])];
  const r = run("role:safety", { providers, bindings: { safety: { model: "local-cls/x" }, quick: { model: "local-chat/m1" } } });
  assert.equal(r.key, null);
});

test("chosen-only", () => {
  const providers = [prov("local-chat", ["m1"])];
  const base = { providers, models: modelsOf(providers), catalog: [] };
  const seeded = { quick: { model: "local-chat/m1", seeded: true } };
  assert.equal(resolveChosenRoleKey("role:safety", { ...base, bindings: seeded }).reason, "not_chosen");
  const q = resolveChosenRoleKey("role:quick", { ...base, bindings: seeded });
  assert.deepEqual({ key: q.key, role: q.role, chain: q.chain, reason: q.reason }, { key: null, role: "quick", chain: [], reason: "not_chosen" });
  assert.equal(resolveChosenRoleKey("role:quick", { ...base, bindings: { quick: { model: null } } }).reason, "not_chosen");
  const v = resolveChosenRoleKey("role:voice", { ...base, bindings: { ...seeded, voice: { model: "role:quick" } } });
  assert.equal(v.key, "local-chat/m1");
  const raw = resolveChosenRoleKey("local-chat/m1", base);
  assert.deepEqual({ key: raw.key, reason: raw.reason }, { key: "local-chat/m1", reason: "raw" });
});

test("an automatic root never reaches a heavy model through a role ref; a heavy root does", () => {
  const providers = [prov("big", ["m"], { gpuPolicy: { catalogId: "big-cat" } })];
  const catalog = [{ id: "big-cat", serving: { class: "windowed" } }];
  const bindings = { everyday: { model: "role:deep", fallback: [] }, deep: { model: "big/m", fallback: [] }, coordinator: { model: "role:deep", fallback: [] } };
  const every = run("role:everyday", { providers, catalog, bindings });
  assert.deepEqual({ key: every.key, reason: every.reason }, { key: null, reason: "not_configured" });
  const coord = run("role:coordinator", { providers, catalog, bindings });
  assert.deepEqual({ key: coord.key, reason: coord.reason }, { key: "big/m", reason: "fallback" });
  assert.equal(run("role:deep", { providers, catalog, bindings }).key, "big/m");
});

test("chosen-only: an unknown root is unknown_role, not not_chosen", () => {
  const r = resolveChosenRoleKey("role:nope", { bindings: {}, providers: [], models: { providers: {} } });
  assert.deepEqual({ key: r.key, role: r.role, reason: r.reason }, { key: null, role: "nope", reason: "unknown_role" });
  assert.equal(resolveChosenRoleKey("role:c-gone", { bindings: { "c-gone": { model: "p/m" } }, providers: [] }).reason, "unknown_role");
});
