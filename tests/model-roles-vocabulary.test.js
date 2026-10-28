import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORE_ROLES, MEDIA_CAPABILITIES, ROLE_LABEL_KEYS,
  ROLE_BINDING_PREFIX, ROLE_DEF_PREFIX, SUBAGENT_MAP_KEY, ROLE_KEY_RANGE, bindingKey,
  parseBindingValue, parseBindingRows, walkRole, roleCandidates, resolveRoleKey,
} from "../servers/shared/model-roles.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

const prov = (id, modelIds, extra = {}) => ({
  id, baseUrl: `http://10.0.0.5:8000/${id}/v1`, host: "local", disabled: false,
  models: modelIds.map((m) => (typeof m === "string" ? { id: m } : m)), gpuPolicy: null, ...extra,
});
const modelsOf = (providers) => ({
  providers: Object.fromEntries(providers.filter((p) => !p.disabled).map((p) => [p.id, { models: p.models }])),
});
const OWN = "c".repeat(32);
const ctxOf = (o) => ({
  need: o.need, bindings: o.bindings || {}, customDefs: o.customDefs || {}, providers: o.providers,
  models: o.models || modelsOf(o.providers), catalog: o.catalog || [], ownInstanceId: () => OWN,
});
const keysOf = (list) => list.map((c) => c.key);

test("15 roles in order", () => {
  assert.deepEqual(CORE_ROLES.map((r) => r.id), [
    "quick", "everyday", "deep", "coordinator", "critic", "expert", "vision", "embed", "rerank", "safety",
    "voice", "stt", "tts", "image", "video",
  ]);
  const by = Object.fromEntries(CORE_ROLES.map((r) => [r.id, r]));
  assert.deepEqual({ ...by.voice, defaultFallback: [...by.voice.defaultFallback] }, { id: "voice", capability: "chat", allowHeavy: false, defaultFallback: [] });
  assert.deepEqual([...by.safety.defaultFallback], []);
  assert.deepEqual(["stt", "tts", "image", "video"].map((id) => by[id].capability), ["transcription", "speech", "image", "video"]);
  assert.deepEqual([...MEDIA_CAPABILITIES], ["transcription", "speech", "image", "video"]);
  assert.equal(Object.isFrozen(MEDIA_CAPABILITIES), true);
});

test("labels", () => {
  for (const r of CORE_ROLES) {
    const k = ROLE_LABEL_KEYS[r.id];
    assert.equal(k, `settings.roles.${r.id}`);
    assert.ok(translations[k]?.en, `${k} en`);
    assert.ok(translations[k]?.es, `${k} es`);
  }
  assert.equal(translations["settings.roles.safety"].en, "Classifier");
  assert.equal(translations["settings.roles.coordinator"].en, "Orchestrator");
  assert.equal(translations["settings.roles.quick"].en, "Scout");
  assert.equal(translations["settings.roles.expert"].es, "Experto en línea");
});

test("key helpers", () => {
  assert.equal(ROLE_BINDING_PREFIX, "model_role.");
  assert.equal(ROLE_DEF_PREFIX, "model_role_def.");
  assert.equal(SUBAGENT_MAP_KEY, "model_role_subagents");
  assert.equal(bindingKey("everyday"), "model_role.everyday");
  assert.deepEqual({ ...ROLE_KEY_RANGE }, { lo: "model_role", hi: "model_rolf" });
  assert.equal(Object.isFrozen(ROLE_KEY_RANGE), true);
  for (const k of [bindingKey("quick"), "model_role_def.c-x", SUBAGENT_MAP_KEY]) assert.ok(k >= ROLE_KEY_RANGE.lo && k < ROLE_KEY_RANGE.hi, k);
  for (const k of ["model_rolf", "model_rol", "model_rold", "models"]) assert.ok(!(k >= ROLE_KEY_RANGE.lo && k < ROLE_KEY_RANGE.hi), k);
});

test("parse binding", () => {
  assert.deepEqual(parseBindingValue('{"model":"local-chat/m1","seeded":true}'), { model: "local-chat/m1", seeded: true });
  assert.equal(parseBindingValue("{bad"), null);
  assert.equal(parseBindingValue('{"model":"nokey"}'), null);
  assert.deepEqual(parseBindingValue('{"model":null}'), { model: null, seeded: false });
  assert.deepEqual(parseBindingValue('{"model":"role:quick","fallback":["deep"]}'), { model: "role:quick", fallback: ["deep"], seeded: false });
  assert.equal(parseBindingValue('"local-chat/m1"'), null);
  assert.equal(parseBindingValue("[]"), null);
  assert.equal(parseBindingValue("null"), null);
  assert.equal(parseBindingValue(undefined), null);
  assert.equal(parseBindingValue('{"model":"role:"}'), null);
  assert.equal(parseBindingValue('{"model":42}'), null);
});

test("parse rows", () => {
  const rows = [
    { key: "model_role.everyday", value: '{"model":"local-chat/m1"}' },
    { key: "model_role.nope", value: '{"model":"local-chat/m1"}' },
    { key: "model_role_def.c-coder", value: '{"capability":"chat","allowHeavy":false,"fallback":["everyday"]}' },
    { key: "model_role_def.c-bad", value: '{"capability":"embed"}' },
    { key: "model_role.c-coder", value: '{"model":"role:everyday"}' },
    { key: "model_role.c-bad", value: '{"model":"local-chat/m1"}' },
    { key: "model_role.quick", value: "{bad" },
    { key: "model_role_subagents", value: "{}" },
  ];
  const { bindings, customDefs } = parseBindingRows(rows);
  assert.deepEqual(Object.keys(bindings).sort(), ["c-coder", "everyday"]);
  assert.equal(bindings.everyday.model, "local-chat/m1");
  assert.deepEqual(Object.keys(customDefs), ["c-coder"]);
  assert.equal(customDefs["c-coder"].capability, "chat");
  const extra = parseBindingRows([{ key: "model_role_def.c-x", value: '{"label":"Coder","job":"writes code","capability":"vision","allowHeavy":true,"fallback":["deep"],"evil":1}' }]);
  assert.deepEqual(extra.customDefs["c-x"], { capability: "vision", label: "Coder", job: "writes code" });
  assert.deepEqual(parseBindingRows(null), { bindings: {}, customDefs: {} });
});

test("candidates filtered", () => {
  const providers = [
    prov("local-voice", ["m2"]),
    prov("foreign", ["m3"], { host: "f".repeat(32) }),
    prov("big", ["m4"]),
  ];
  const catalog = [{ id: "big", serving: { class: "windowed" } }];
  const bindings = {
    voice: { model: "local-voice/m2", fallback: ["quick"] },
    quick: { model: "foreign/m3" },
    everyday: { fallback: ["deep"] },
    deep: { model: "big/m4", fallback: [] },
  };
  const ctx = ctxOf({ providers, catalog, bindings });
  const voice = keysOf(roleCandidates("voice", ctx));
  assert.ok(voice.includes("local-voice/m2"));
  assert.ok(!voice.includes("foreign/m3"));
  assert.ok(!voice.includes("big/m4"));
  assert.ok(keysOf(roleCandidates("deep", ctx)).includes("big/m4"));
  const verdicts = Object.fromEntries([...walkRole("voice", ctx)].filter((e) => e.key).map((e) => [e.key, e.verdict]));
  assert.deepEqual(verdicts, { "local-voice/m2": "ok", "foreign/m3": "foreign", "big/m4": "class" });

  // m1: a not-configured windowed candidate is filtered, while the resolver's reason stays not_configured.
  const p2 = [...providers, prov("big2", ["m5"])];
  const models = modelsOf(p2.filter((p) => p.id !== "big2"));
  const cat2 = [...catalog, { id: "big2", serving: { class: "windowed" } }];
  const b2 = { voice: { model: "big2/m5", fallback: [] } };
  const ctx2 = ctxOf({ providers: p2, models, catalog: cat2, bindings: b2 });
  assert.ok(!keysOf(roleCandidates("voice", ctx2)).includes("big2/m5"));
  const e = [...walkRole("voice", ctx2)].find((x) => x.key === "big2/m5");
  assert.deepEqual({ verdict: e.verdict, filtered: e.filtered }, { verdict: "not_configured", filtered: true });
  const r = resolveRoleKey("role:voice", ctx2);
  assert.deepEqual({ key: r.key, reason: r.reason }, { key: null, reason: "not_configured" });
  // and an unfiltered not-configured candidate is kept
  const ctx3 = ctxOf({ providers: [], models: { providers: {} }, bindings: { voice: { model: "local-voice/m9", fallback: [] } } });
  assert.deepEqual(keysOf(roleCandidates("voice", ctx3)), ["local-voice/m9"]);
});

test("candidates match resolver order", () => {
  const fixtures = [
    { providers: [prov("local-chat", ["m1"], { disabled: true }), prov("local-voice", ["m2"])],
      bindings: { everyday: { model: "local-chat/m1", fallback: ["quick"] }, quick: { model: "local-voice/m2", fallback: [] } } },
    { providers: [prov("p", [{ id: "e", task: "embed" }]), prov("q", ["c"])],
      bindings: { everyday: { model: "p/e", fallback: ["quick"] }, quick: { model: "q/c", fallback: [] } } },
    { providers: [prov("far", ["m"], { host: "b".repeat(32) }), prov("near", ["m"])],
      bindings: { everyday: { model: "far/m", fallback: ["quick"] }, quick: { model: "near/m", fallback: [] } } },
    { providers: [prov("p", ["m"])],
      bindings: { coordinator: { fallback: ["deep", "critic", "expert"] }, expert: { model: "p/m", fallback: [] } } },
    { providers: [prov("big", ["m"], { gpuPolicy: { catalogId: "big-cat" } }), prov("p", ["m"])],
      catalog: [{ id: "big-cat", serving: { class: "windowed" } }],
      bindings: { everyday: { model: "big/m", fallback: ["quick"] }, deep: { model: "big/m" }, quick: { model: "p/m" } } },
  ];
  let compared = 0;
  for (const f of fixtures) {
    const ctx = ctxOf(f);
    for (const r of CORE_ROLES) {
      const first = roleCandidates(r.id, ctx)[0];
      if (!first || !ctx.models.providers[first.key.split("/")[0]]?.models.some((m) => m.id === first.key.split("/")[1])) continue;
      assert.equal(first.key, resolveRoleKey(`role:${r.id}`, ctx).key, `${r.id}`);
      compared++;
    }
  }
  assert.ok(compared >= 10, `compared ${compared}`);
});
