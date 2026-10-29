/**
 * Provider presets + the curated per-role recommendations file (roles phase 2b, Task 8).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_PRESETS, presetById } from "../servers/shared/provider-presets.js";
import {
  loadRecommendations,
  recommendedFor,
  candidatePick,
  presetForRow,
  isRecommendationsStale,
  RECOMMENDATION_ROLES,
  bareModelId,
  recommendedModelIds,
} from "../servers/shared/provider-recommendations.js";
import { CORE_ROLES } from "../servers/shared/model-roles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "..", "registry", "provider-recommendations.json");
const EXCLUDED = ["safety", "stt", "tts", "image", "video"];

test("presets: order, frozen, shape", () => {
  assert.deepEqual(PROVIDER_PRESETS.map((p) => p.id),
    ["openrouter", "anthropic", "openai", "google", "zai", "groq", "together", "modelstudio", "other"]);
  assert.ok(Object.isFrozen(PROVIDER_PRESETS));
  for (const p of PROVIDER_PRESETS) {
    assert.ok(Object.isFrozen(p), `${p.id} frozen`);
    assert.equal(typeof p.labelKey, "string");
    assert.ok(["bearer", "anthropic"].includes(p.authStyle), `${p.id} authStyle`);
    // A key test is a GET testPath, or a POST testRequest for a provider with no listing.
    if (p.testRequest) {
      assert.equal(p.testPath, undefined, `${p.id} has one key test`);
      assert.equal(p.testRequest.method, "POST");
      assert.match(p.testRequest.path, /^\//);
      assert.equal(typeof p.testRequest.body, "object");
      assert.ok(p.modelsPath === null, `${p.id} has no listing`);
    } else {
      assert.equal(typeof p.testPath, "string");
      assert.equal(typeof p.modelsPath, "string");
    }
    assert.equal(typeof p.keyHint, "string");
    if (p.id === "other") {
      assert.equal(p.baseUrl, undefined);
      assert.equal(p.providerType, "openai-compat");
    } else if (p.variants) {
      assert.ok(p.variants.length >= 2);
      for (const v of p.variants) assert.match(v.baseUrl, /^https:\/\//);
    } else {
      assert.match(p.baseUrl, /^https:\/\//);
    }
  }
  const a = presetById("anthropic");
  assert.equal(a.providerType, "anthropic");
  assert.equal(a.authStyle, "anthropic");
  assert.equal(a.baseUrl, "https://api.anthropic.com");
  assert.equal(a.testPath, "/v1/models");
  assert.equal(a.modelsPath, "/v1/models");
  assert.equal(presetById("openrouter").testPath, "/key");
  assert.equal(presetById("openrouter").modelsPath, "/models");
  assert.deepEqual(presetById("zai").variants.map((v) => [v.id, v.baseUrl]), [
    ["payg", "https://api.z.ai/api/paas/v4"],
    ["coding", "https://api.z.ai/api/coding/paas/v4"],
  ]);
  assert.equal(presetById("nope"), null);
});

test("modelstudio: four regions, Singapore first, a POST key test, no listing, a probe without required", () => {
  const p = presetById("modelstudio");
  assert.equal(p.label, "Alibaba Model Studio (Qwen)");
  assert.equal(p.labelKey, "providers.preset.modelstudio");
  assert.equal(p.providerType, "openai");
  assert.equal(p.authStyle, "bearer");
  assert.equal(p.baseUrl, undefined);
  assert.deepEqual(p.variants.map((v) => [v.id, v.baseUrl]), [
    ["intl", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["us", "https://dashscope-us.aliyuncs.com/compatible-mode/v1"],
    ["cn", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
    ["hk", "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1"],
  ]);
  for (const v of p.variants) assert.equal(v.labelKey, `providers.preset.modelstudio.${v.id}`);
  assert.deepEqual(p.testRequest, {
    method: "POST", path: "/chat/completions",
    body: { model: "qwen3.8-flash", messages: [{ role: "user", content: "ok" }], max_tokens: 1, enable_thinking: false },
  });
  assert.equal(p.modelsPath, null);
  assert.deepEqual(p.probe, { toolChoice: "auto", extraBody: { enable_thinking: false } });
  // The region choice and the region-bound key are explained in plain words.
  assert.equal(p.variantLabelKey, "models.add.region");
  assert.equal(p.keyNoteKey, "providers.preset.modelstudio.keyNote");
  assert.equal(p.keyRejectedKey, "models.add.test.key_rejected_region");
  assert.ok(Object.isFrozen(p.testRequest.body.messages[0]));
  // The test model is one the file recommends with a verified id.
  assert.ok(recommendedFor("modelstudio", "quick").some((e) => e.model_id === p.testRequest.body.model && e.id_verified));
  // No other preset carries a probe override: they keep tool_choice required.
  for (const q of PROVIDER_PRESETS) if (q.id !== "modelstudio") assert.equal(q.probe, undefined, q.id);
});

test("modelstudio recommendations: verified ids, no rerank, embed is text-embedding-v4, voice is a text model, notes kept", () => {
  const raw = JSON.parse(readFileSync(FILE, "utf8"));
  const ms = raw.providers.modelstudio;
  assert.ok(ms, "modelstudio entry");
  assert.ok(ms.none_found.includes("rerank"));
  assert.equal(ms.roles.rerank, undefined);
  assert.equal(candidatePick("modelstudio", "rerank"), null);
  const embed = candidatePick("modelstudio", "embed", { liveModelIds: null });
  assert.equal(embed.model_id, "text-embedding-v4");
  assert.equal(embed.kind, "embed");
  for (const e of ms.roles.voice || []) assert.equal(e.kind, "chat", "no realtime voice entry");
  assert.equal(candidatePick("modelstudio", "voice").model_id, "qwen3.8-flash");
  for (const [roleId, entries] of Object.entries(ms.roles)) {
    for (const e of entries) {
      assert.equal(e.id_verified, true, `${roleId} ${e.model_id}`);
      if (e.price.unit === "unknown") assert.equal(e.price.price_verified, false, `${e.model_id} unknown price`);
    }
  }
  // Primaries from the research.
  const primaries = Object.fromEntries(["coordinator", "quick", "deep", "everyday", "expert", "critic", "vision"]
    .map((r) => [r, candidatePick("modelstudio", r, { liveModelIds: null }).model_id]));
  assert.deepEqual(primaries, {
    coordinator: "qwen3.8-max", quick: "qwen3.8-flash", deep: "qwen3.8-max", everyday: "qwen3.7-plus",
    expert: "qwen3.8-max", critic: "deepseek-v4-pro-0813", vision: "qwen3.7-plus",
  });
  // The free quota is Singapore-only; the distribution note keeps its unverified wording.
  assert.match(ms.notes.free_quota, /Singapore/);
  assert.match(ms.notes.distribution, /unverified|not retrieved|not resolved|unresolved/i);
  assert.match(ms.notes.distribution, /own key/);
  assert.ok(ms.docs_urls.includes("https://help.aliyun.com/en/model-studio/base-url"));
});

test("modelstudio: no listing skips the live filter; ticked ids narrow it", () => {
  assert.equal(candidatePick("modelstudio", "coordinator", { liveModelIds: null }).model_id, "qwen3.8-max");
  assert.equal(candidatePick("modelstudio", "coordinator", {}).model_id, "qwen3.8-max");
  assert.equal(candidatePick("modelstudio", "coordinator", { liveModelIds: ["kimi-k3"] }).model_id, "kimi-k3");
  assert.equal(candidatePick("modelstudio", "coordinator", { liveModelIds: [] }), null);
});

test("file shape", () => {
  const raw = JSON.parse(readFileSync(FILE, "utf8"));
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.accessed, "2026-10-28");
  assert.equal(raw.review_by, "2027-01-28");
  const presetIds = PROVIDER_PRESETS.map((p) => p.id).filter((id) => id !== "other");
  assert.deepEqual(Object.keys(raw.providers).sort(), [...presetIds].sort());
  const coreIds = new Set(CORE_ROLES.map((r) => r.id));
  for (const [pid, prov] of Object.entries(raw.providers)) {
    assert.ok(Array.isArray(prov.docs_urls) && prov.docs_urls.length > 0, `${pid} docs_urls`);
    for (const u of prov.docs_urls) assert.match(u, /^https:\/\//);
    assert.ok(Array.isArray(prov.deprecations), `${pid} deprecations`);
    for (const d of prov.deprecations) {
      assert.equal(typeof d.model_id, "string");
      assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(d.replacement === null || typeof d.replacement === "string");
    }
    for (const [roleId, entries] of Object.entries(prov.roles)) {
      assert.ok(coreIds.has(roleId), `${pid}.${roleId} is a core role`);
      assert.ok(!EXCLUDED.includes(roleId), `${pid}.${roleId} excluded`);
      assert.ok(RECOMMENDATION_ROLES.includes(roleId));
      assert.ok(Array.isArray(entries) && entries.length > 0, `${pid}.${roleId} non-empty`);
      for (const e of entries) {
        assert.equal(typeof e.model_id, "string");
        assert.ok(e.model_id.length > 0);
        assert.equal(typeof e.id_verified, "boolean", `${pid}.${roleId}.${e.model_id} id_verified`);
        assert.ok(["stable", "preview", "restricted", "enterprise", "deprecated"].includes(e.status), `${e.model_id} status`);
        assert.equal(typeof e.kind, "string");
        assert.ok(e.retires === null || /^\d{4}-\d{2}-\d{2}$/.test(e.retires));
        assert.equal(typeof e.price, "object");
        assert.equal(typeof e.price.unit, "string");
        assert.equal(typeof e.price.price_verified, "boolean", `${e.model_id} price_verified`);
        assert.ok(e.context === null || Number.isInteger(e.context));
        assert.equal(typeof e.note, "string");
      }
    }
  }
  // Every excluded role is absent everywhere.
  for (const prov of Object.values(raw.providers)) {
    for (const r of EXCLUDED) assert.equal(prov.roles[r], undefined);
  }
});

test("recommendedFor returns primary first", () => {
  const e = recommendedFor("anthropic", "coordinator");
  assert.equal(e[0].model_id, "claude-opus-5-5");
  assert.deepEqual(recommendedFor("anthropic", "embed"), []);
  assert.deepEqual(recommendedFor("other", "everyday"), []);
  assert.deepEqual(recommendedFor("anthropic", "safety"), []);
});

test("candidate rules", () => {
  // Z.AI: never an inferred id.
  for (const roleId of RECOMMENDATION_ROLES) {
    const pick = candidatePick("zai", roleId, { liveModelIds: null });
    if (pick) assert.equal(pick.id_verified, true, `zai ${roleId}`);
  }
  assert.ok(candidatePick("zai", "everyday", { liveModelIds: null }));
  // A listing narrows the picks.
  assert.equal(candidatePick("openai", "everyday", { liveModelIds: ["gpt-6.1-sol"] }).model_id, "gpt-6.1-sol");
  assert.equal(candidatePick("openai", "everyday", { liveModelIds: ["gpt-6.1-terra"] }).model_id, "gpt-6.1-terra");
  assert.equal(candidatePick("openai", "everyday", { liveModelIds: [] }), null);
  // No listing: the primary.
  assert.equal(candidatePick("openai", "everyday", { liveModelIds: null }).model_id, "gpt-6.1-sol");
  assert.equal(candidatePick("openai", "everyday").model_id, "gpt-6.1-sol");
  // Groq expert has only preview models: returned flagged.
  const ge = candidatePick("groq", "expert", { liveModelIds: null });
  assert.equal(ge.model_id, "qwen/qwen3.8-27b");
  assert.equal(ge.preview, true);
  // Groq critic: the primary is preview but a stable (Production) alternative exists,
  // so the stable entry wins and carries no preview flag.
  const gc = candidatePick("groq", "critic", { liveModelIds: null });
  assert.equal(gc.model_id, "openai/gpt-oss-120b");
  assert.notEqual(gc.preview, true);
  // ...and when the key's listing lacks the stable one, the preview entry comes back flagged.
  const gcp = candidatePick("groq", "critic", { liveModelIds: ["qwen/qwen3.8-27b"] });
  assert.equal(gcp.model_id, "qwen/qwen3.8-27b");
  assert.equal(gcp.preview, true);
  // Enterprise entries are never picked.
  assert.equal(candidatePick("groq", "vision", { liveModelIds: ["meta-models/muse-spark-open"] }), null);
  // Stable entries never carry the preview flag; returned entries are copies.
  const s = candidatePick("anthropic", "everyday");
  assert.equal(s.preview, undefined);
  s.model_id = "mutated";
  assert.equal(candidatePick("anthropic", "everyday").model_id, "claude-sonnet-5-5");
  // Unknown preset / excluded role.
  assert.equal(candidatePick("nope", "everyday"), null);
  assert.equal(candidatePick("anthropic", "safety"), null);
});

test("candidate rules: retirement before review_by and restricted entries are skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-recs-"));
  const f = join(dir, "recs.json");
  const entry = (model_id, extra = {}) => ({
    model_id, id_verified: true, kind: "chat", status: "stable", retires: null, tools: "yes",
    agentic: "yes", context: null, price: { unit: "per_mtok_in_out", in: 1, out: 2, price_verified: true }, note: "", ...extra,
  });
  writeFileSync(f, JSON.stringify({
    schema_version: 1, accessed: "2026-10-28", review_by: "2027-01-28", source_notes: "x",
    providers: { openai: { docs_urls: ["https://api.example.com/docs"], deprecations: [], roles: {
      everyday: [entry("m-retiring", { retires: "2026-12-11" }), entry("m-restricted", { status: "restricted" }), entry("m-ok", { retires: "2027-04-01" })],
      quick: [entry("m-inferred", { id_verified: false }), entry("m-preview", { status: "preview" })],
    } } },
  }));
  const opts = { file: f };
  assert.equal(candidatePick("openai", "everyday", { liveModelIds: null }, opts).model_id, "m-ok");
  // An unverified id is skipped even when it is the only stable entry.
  const q = candidatePick("openai", "quick", { liveModelIds: null }, opts);
  assert.equal(q.model_id, "m-preview");
  assert.equal(q.preview, true);
  // mtime cache: a rewrite with a new mtime is picked up.
  writeFileSync(f, JSON.stringify({
    schema_version: 1, accessed: "2026-10-28", review_by: "2027-01-28", source_notes: "x",
    providers: { openai: { docs_urls: [], deprecations: [], roles: { everyday: [entry("m-new")] } } },
  }));
  const later = new Date(Date.now() + 5000);
  utimesSync(f, later, later);
  assert.equal(candidatePick("openai", "everyday", {}, opts).model_id, "m-new");
  assert.equal(loadRecommendations(opts).review_by, "2027-01-28");
});

function bumpMtime(f, secs) {
  const t = new Date(Date.now() + secs * 1000);
  utimesSync(f, t, t);
}
const goodEntry = (model_id) => ({
  model_id, id_verified: true, kind: "chat", status: "stable", retires: null, tools: "yes",
  agentic: "yes", context: null, price: { unit: "per_mtok_in_out", in: 1, out: 2, price_verified: true }, note: "",
});
const goodFile = (reviewBy = "2027-01-28", everyday = [goodEntry("m-good")]) => JSON.stringify({
  schema_version: 1, accessed: "2026-10-28", review_by: reviewBy, source_notes: "x",
  providers: { openai: { docs_urls: [], deprecations: [], roles: { everyday } } },
});

test("malformed after a good load: empty and stale, cached; a good file recovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-recs-bad-"));
  const f = join(dir, "recs.json");
  const opts = { file: f };
  const now = new Date("2026-11-01");
  writeFileSync(f, goodFile());
  bumpMtime(f, 10);
  assert.equal(candidatePick("openai", "everyday", {}, opts).model_id, "m-good");
  assert.equal(isRecommendationsStale(now, opts), false);

  writeFileSync(f, "{ not json");
  bumpMtime(f, 20);
  assert.equal(candidatePick("openai", "everyday", {}, opts), null);
  assert.deepEqual(recommendedFor("openai", "everyday", opts), []);
  assert.equal(isRecommendationsStale(now, opts), true);
  // Cached against that mtime: the same object comes back without a re-parse.
  assert.equal(loadRecommendations(opts), loadRecommendations(opts));

  writeFileSync(f, goodFile());
  bumpMtime(f, 30);
  assert.equal(candidatePick("openai", "everyday", {}, opts).model_id, "m-good");
  assert.equal(isRecommendationsStale(now, opts), false);
});

test("null and non-object entries are skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-recs-null-"));
  const f = join(dir, "recs.json");
  writeFileSync(f, goodFile("2027-01-28", [null, 7, "x", [], goodEntry("m-after")]));
  bumpMtime(f, 40);
  const opts = { file: f };
  assert.deepEqual(recommendedFor("openai", "everyday", opts).map((e) => e.model_id), ["m-after"]);
  assert.equal(candidatePick("openai", "everyday", {}, opts).model_id, "m-after");
});

test("an invalid review_by date counts as stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-recs-date-"));
  const f = join(dir, "recs.json");
  const opts = { file: f };
  for (const [i, bad] of ["not-a-date", "2027-13-45", 20270128, ""].entries()) {
    writeFileSync(f, goodFile(bad));
    bumpMtime(f, 50 + i);
    assert.equal(isRecommendationsStale(new Date("2026-11-01"), opts), true, `review_by ${JSON.stringify(bad)}`);
  }
});

test("presetForRow", () => {
  assert.equal(presetForRow({ baseUrl: "", base_url: "https://api.groq.com/openai/v1" }), "groq");
  assert.equal(presetForRow({ baseUrl: "https://api.groq.com/openai/v1/" }), "groq");
  assert.equal(presetForRow({ base_url: "https://api.z.ai/api/coding/paas/v4" }), "zai");
  assert.equal(presetForRow({ baseUrl: "https://api.z.ai/api/paas/v4" }), "zai");
  assert.equal(presetForRow({ baseUrl: "https://API.Anthropic.com/" }), "anthropic");
  assert.equal(presetForRow({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" }), "google");
  assert.equal(presetForRow({ baseUrl: "https://api.together.xyz/v1" }), "together");
  for (const v of presetById("modelstudio").variants) assert.equal(presetForRow({ baseUrl: v.baseUrl + "/" }), "modelstudio", v.id);
  assert.equal(presetForRow({ baseUrl: "https://api.example.com/v1" }), null);
  assert.equal(presetForRow({}), null);
  assert.equal(presetForRow(null), null);
});

test("stale", () => {
  assert.equal(isRecommendationsStale(new Date("2027-02-01")), true);
  assert.equal(isRecommendationsStale(new Date("2026-11-01")), false);
});

test("a pick honours its entry's kind: realtime voice models are never picked (F1)", () => {
  // The voice role is the text LLM behind the voice router: a realtime model cannot serve it.
  assert.equal(candidatePick("openai", "voice", { liveModelIds: null }), null);
  assert.equal(candidatePick("google", "voice", { liveModelIds: null }), null);
  assert.equal(candidatePick("openai", "voice", { liveModelIds: ["gpt-realtime-2.1-mini", "gpt-6-luna"] }), null);
  assert.equal(candidatePick("anthropic", "voice").kind, "chat");
  for (const presetId of PROVIDER_PRESETS.map((p) => p.id)) {
    for (const roleId of RECOMMENDATION_ROLES) {
      const p = candidatePick(presetId, roleId);
      if (!p) continue;
      const want = roleId === "embed" ? "embed" : roleId === "rerank" ? "rerank" : "chat";
      assert.equal(p.kind, want, `${presetId} ${roleId}`);
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "crow-recs-kind-"));
  const f = join(dir, "recs.json");
  const e = (model_id, kind) => ({ model_id, id_verified: true, ...(kind ? { kind } : {}), status: "stable", retires: null });
  writeFileSync(f, JSON.stringify({
    schema_version: 1, accessed: "2026-10-28", review_by: "2027-01-28", source_notes: "x",
    providers: { openai: { roles: {
      voice: [e("rt", "realtime"), e("au", "audio"), e("lv", "live"), e("plain")],
      everyday: [e("em", "embed"), e("ch", "chat")],
      embed: [e("ch2", "chat"), e("em2", "embed")],
      rerank: [e("em3", "embed"), e("rr", "rerank")],
      quick: [e("rt2", "realtime")],
    } } },
  }));
  const opts = { file: f };
  // An entry with no kind counts as chat.
  assert.equal(candidatePick("openai", "voice", {}, opts).model_id, "plain");
  assert.equal(candidatePick("openai", "everyday", {}, opts).model_id, "ch");
  assert.equal(candidatePick("openai", "embed", {}, opts).model_id, "em2");
  assert.equal(candidatePick("openai", "rerank", {}, opts).model_id, "rr");
  assert.equal(candidatePick("openai", "quick", {}, opts), null);
});

test("a listing's models/<id> ids match the bare recommended ids (F2, Google)", () => {
  const listing = ["models/gemini-3.8-flash", "models/gemini-4-argon", "models/gemini-embedding-2"];
  assert.equal(candidatePick("google", "everyday", { liveModelIds: listing }).model_id, "gemini-3.8-flash");
  assert.equal(candidatePick("google", "embed", { liveModelIds: listing }).model_id, "gemini-embedding-2");
  assert.equal(bareModelId("models/gemini-3.8-flash"), "gemini-3.8-flash");
  assert.equal(bareModelId("openai/gpt-oss-120b"), "openai/gpt-oss-120b");
  assert.equal(bareModelId("models/"), "models/");
});

test("modelstudio notes: thinking-only models say a probe may fail; omni-flash names reasoning_effort; the domain is legacy", () => {
  const ms = JSON.parse(readFileSync(FILE, "utf8")).providers.modelstudio;
  const all = Object.values(ms.roles).flat();
  for (const id of ["kimi-k3", "glm-5.3"]) {
    const entries = all.filter((e) => e.model_id === id);
    assert.ok(entries.length > 0, id);
    for (const e of entries) {
      assert.match(e.note, /always thinks/i, `${id}: ${e.note}`);
      assert.match(e.note, /may fail/i, `${id}: ${e.note}`);
      assert.doesNotMatch(e.note, /^Documented with tool_choice required/, id);
    }
  }
  for (const e of all.filter((x) => x.model_id === "qwen3.8-omni-flash")) assert.match(e.note, /reasoning_effort/, e.note);
  assert.match(ms.endpoint_check, /legacy/i);
  assert.match(ms.endpoint_check, /still available/i);
});

test("recommendedModelIds: verified, fitting kinds, once each, never an entry retiring before review_by", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-recs-ids-"));
  const f = join(dir, "recs.json");
  const e = (model_id, extra = {}) => ({ model_id, id_verified: true, kind: "chat", status: "stable", retires: null, ...extra });
  writeFileSync(f, JSON.stringify({
    schema_version: 1, accessed: "2026-10-28", review_by: "2027-01-28", source_notes: "x",
    providers: { openai: { roles: {
      everyday: [e("m-ok"), e("m-retiring", { retires: "2026-12-11" }), e("m-later", { retires: "2027-04-01" }), e("m-inferred", { id_verified: false })],
      quick: [e("m-ok"), e("rt", { kind: "realtime" })],
      embed: [e("em", { kind: "embed" })],
    } } },
  }));
  bumpMtime(f, 60);
  assert.deepEqual(recommendedModelIds("openai", { file: f }), ["m-ok", "m-later", "em"]);
});
