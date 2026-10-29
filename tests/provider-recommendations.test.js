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
} from "../servers/shared/provider-recommendations.js";
import { CORE_ROLES } from "../servers/shared/model-roles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "..", "registry", "provider-recommendations.json");
const EXCLUDED = ["safety", "stt", "tts", "image", "video"];

test("presets: order, frozen, shape", () => {
  assert.deepEqual(PROVIDER_PRESETS.map((p) => p.id),
    ["openrouter", "anthropic", "openai", "google", "zai", "groq", "together", "other"]);
  assert.ok(Object.isFrozen(PROVIDER_PRESETS));
  for (const p of PROVIDER_PRESETS) {
    assert.ok(Object.isFrozen(p), `${p.id} frozen`);
    assert.equal(typeof p.labelKey, "string");
    assert.ok(["bearer", "anthropic"].includes(p.authStyle), `${p.id} authStyle`);
    assert.equal(typeof p.testPath, "string");
    assert.equal(typeof p.modelsPath, "string");
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

test("presetForRow", () => {
  assert.equal(presetForRow({ baseUrl: "https://api.groq.com/openai/v1/" }), "groq");
  assert.equal(presetForRow({ base_url: "https://api.z.ai/api/coding/paas/v4" }), "zai");
  assert.equal(presetForRow({ baseUrl: "https://api.z.ai/api/paas/v4" }), "zai");
  assert.equal(presetForRow({ baseUrl: "https://API.Anthropic.com/" }), "anthropic");
  assert.equal(presetForRow({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" }), "google");
  assert.equal(presetForRow({ baseUrl: "https://api.together.xyz/v1" }), "together");
  assert.equal(presetForRow({ baseUrl: "https://api.example.com/v1" }), null);
  assert.equal(presetForRow({}), null);
  assert.equal(presetForRow(null), null);
});

test("stale", () => {
  assert.equal(isRecommendationsStale(new Date("2027-02-01")), true);
  assert.equal(isRecommendationsStale(new Date("2026-11-01")), false);
});
