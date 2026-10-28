/**
 * Model roles Phase 1, Task 2: the binding store (instance-owned, never
 * synced), the per-key authority seam, the role context, and the
 * source-tracking seed. Every DB here is a fresh scratch init-db.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { isSyncable, isInstanceScope } from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import { setSettingsSyncManager } from "../servers/gateway/dashboard/settings/registry.js";
import { shouldSyncRow } from "../servers/sharing/instance-sync.js";
import { parseBindingValue, sameServer } from "../servers/shared/model-roles.js";
import {
  readBindings, setBinding, roleBindingAuthority, loadRoleContext, invalidateRoleContext, resolveRole,
} from "../servers/shared/model-roles-store.js";
import { defaultSeedSources, seedRoleBindings } from "../servers/shared/model-roles-seed.js";
import { effectiveAgentModel } from "../servers/shared/pi-agent-config.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "roles-store-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  invalidateRoleContext();
  return { dir, db, cleanup() { invalidateRoleContext(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const rawValue = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value;
const row = async (db, id) => parseBindingValue(await rawValue(db, "model_role." + id));
const quiet = () => {};

function piHome({ settings, agents = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "roles-home-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  if (settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  for (const [n, model] of Object.entries(agents)) {
    writeFileSync(join(agentDir, "agents", n + ".md"), `---\nname: ${n}\nmodel: ${model}\n---\nbody\n`);
  }
  return { home, agentDir, cleanup() { rmSync(home, { recursive: true, force: true }); } };
}

const FIXTURE = {
  settings: {
    defaultProvider: "cloud-a", defaultModel: "m7",
    critic: { refuteModel: "local-chat/m5" },
    subagent: { modelOverrides: { scout: "local-chat/m1" } },
  },
  agents: { planner: "cloud-a/m8", adversary: "cloud-a/m9" },
};
const ALWAYS_NULL = ["safety", "embed", "rerank", "vision", "stt", "tts", "image", "video"];

test("instance scope, never synced", () => {
  for (const k of ["model_role.voice", "model_role_def.c-x", "model_role_subagents"]) {
    assert.equal(isInstanceScope(k), true, k);
    assert.equal(isSyncable(k), false, k);
  }
  assert.equal(shouldSyncRow("dashboard_settings", { key: "model_role.voice", value: "{}", instance_id: null }), false);
});

test("seed inserts, no emit", async () => {
  const { db, cleanup } = fresh();
  let emits = 0;
  setSettingsSyncManager({ feedsDisabled: false, emitChange: async () => { emits++; } });
  try {
    const r = await seedRoleBindings(db, { sources: { voice: "local-voice/m2", everyday: "local-chat/m1", deep: null }, log: quiet });
    assert.deepEqual(r, { inserted: ["voice", "everyday"], reseeded: [] });
    assert.equal((await row(db, "voice")).seeded, true);
    assert.equal((await row(db, "everyday")).seeded, true);
    assert.equal(await rawValue(db, "model_role.deep"), undefined);
    const ov = await db.execute("SELECT COUNT(*) AS n FROM dashboard_settings_overrides WHERE key >= 'model_role' AND key < 'model_rolf'");
    assert.equal(Number(ov.rows[0].n), 0);
    assert.equal(emits, 0);
  } finally { setSettingsSyncManager(null); cleanup(); }
});

test("reseed follows the source; a user write is never reseeded", async () => {
  const { db, cleanup } = fresh();
  try {
    await seedRoleBindings(db, { sources: { voice: "local-voice/m2", everyday: "local-chat/m1" }, log: quiet });
    const lines = [];
    const r = await seedRoleBindings(db, { sources: { voice: "local-voice/m3", everyday: "local-chat/m1" }, log: (s) => lines.push(s) });
    assert.deepEqual(r.reseeded, ["voice"]);
    assert.deepEqual(r.inserted, []);
    assert.equal((await row(db, "voice")).model, "local-voice/m3");
    assert.ok(lines.some((l) => /reseeded voice: local-voice\/m2 → local-voice\/m3/.test(l)));

    assert.deepEqual(await setBinding(db, "everyday", { model: "local-chat/m9" }, { actor: "t" }), { ok: true });
    await seedRoleBindings(db, { sources: { everyday: "local-chat/m1" }, log: quiet });
    const ev = await row(db, "everyday");
    assert.equal(ev.model, "local-chat/m9");
    assert.equal(ev.seeded, false);
  } finally { cleanup(); }
});

test("insert never clobbers a concurrent user write", async () => {
  const { db, cleanup } = fresh();
  try {
    await setBinding(db, "quick", { model: "local-chat/u1" }, { actor: "t" });
    const before = await rawValue(db, "model_role.quick");
    const r = await seedRoleBindings(db, { sources: { quick: "x/y" }, log: quiet });
    assert.deepEqual(r, { inserted: [], reseeded: [] });
    assert.equal(await rawValue(db, "model_role.quick"), before);
  } finally { cleanup(); }
});

test("lost CAS keeps the user value", async () => {
  const { db, cleanup } = fresh();
  try {
    await seedRoleBindings(db, { sources: { voice: "local-voice/m2" }, log: quiet });
    const lines = [];
    const r = await seedRoleBindings(db, {
      sources: { voice: "local-voice/m3" },
      log: (s) => lines.push(s),
      beforeUpdate: (id) => setBinding(db, id, { model: "local-voice/m9" }, { actor: "t" }),
    });
    assert.deepEqual(r.reseeded, []);
    const v = await row(db, "voice");
    assert.equal(v.model, "local-voice/m9");
    assert.equal(v.seeded, false);
    assert.equal(lines.some((l) => /reseeded voice/.test(l)), false);
  } finally { cleanup(); }
});

test("effectiveAgentModel: override beats frontmatter, frontmatter alone, missing gives null", () => {
  const h = piHome({ settings: { subagent: { modelOverrides: { scout: "local-chat/m1" } } }, agents: { scout: "cloud-a/m2", planner: "cloud-a/m8" } });
  const bare = piHome();
  try {
    assert.equal(effectiveAgentModel(h.agentDir, "scout"), "local-chat/m1");
    assert.equal(effectiveAgentModel(h.agentDir, "planner"), "cloud-a/m8");
    assert.equal(effectiveAgentModel(h.agentDir, "adversary"), null);
    assert.equal(effectiveAgentModel(bare.agentDir, "scout"), null, "no settings.json does not throw");
  } finally { h.cleanup(); bare.cleanup(); }
});

test("remapped sources", () => {
  const h = piHome(FIXTURE);
  try {
    const s = defaultSeedSources({ env: {}, homeDir: h.home });
    assert.equal(s.voice, "crow-voice/qwen3.5-4b");
    assert.equal(s.everyday, "crow-chat/qwen3.6-35b-a3b");
    assert.equal(s.quick, "local-chat/m1");
    assert.equal(s.deep, "cloud-a/m8");
    assert.equal(s.coordinator, "cloud-a/m7");
    assert.equal(s.critic, "local-chat/m5");
    assert.equal(s.expert, "cloud-a/m9");
    for (const id of ALWAYS_NULL) assert.equal(s[id], null, id);
  } finally { h.cleanup(); }
});

test("no two roles seed the same key (and the recorded shared case)", () => {
  const h = piHome(FIXTURE);
  const shared = piHome({ settings: { subagent: { modelOverrides: { scout: "crow-local/qwen3.6-35b-a3b" } } } });
  try {
    const vals = Object.values(defaultSeedSources({ env: {}, homeDir: h.home })).filter((v) => v != null);
    assert.equal(new Set(vals).size, vals.length, "non-null seeds are pairwise distinct");

    // Recorded shared case: Scout and Everyday name the same 35B under two
    // provider ids. Distinct strings, one server.
    const s = defaultSeedSources({ env: {}, homeDir: shared.home });
    assert.equal(s.quick, "crow-local/qwen3.6-35b-a3b");
    assert.equal(s.everyday, "crow-chat/qwen3.6-35b-a3b");
    assert.notEqual(s.quick, s.everyday);
    const providers = [
      { id: "crow-local", baseUrl: "http://127.0.0.1:8003/v1" },
      { id: "crow-chat", baseUrl: "http://127.0.0.1:8003/v1/" },
    ];
    assert.equal(sameServer(s.quick, s.everyday, { providers }), true, "shared case: same server on a shared base URL");
  } finally { h.cleanup(); shared.cleanup(); }
});

test("defaultModel carrying a provider", () => {
  const a = piHome({ settings: { defaultModel: "cloud-a/m7" } });
  const b = piHome({ settings: { defaultProvider: "cloud-a" } });
  try {
    assert.equal(defaultSeedSources({ env: {}, homeDir: a.home }).coordinator, "cloud-a/m7");
    assert.equal(defaultSeedSources({ env: {}, homeDir: b.home }).coordinator, null);
  } finally { a.cleanup(); b.cleanup(); }
});

test("PI_CODING_AGENT_DIR honoured; env voice overrides", () => {
  const home = piHome();
  const other = piHome(FIXTURE);
  try {
    const s = defaultSeedSources({ env: { PI_CODING_AGENT_DIR: other.agentDir, COMPANION_FAST_MODEL: "local-voice/v1", COMPANION_ESCALATION_MODEL: "local-chat/e1" }, homeDir: home.home });
    assert.equal(s.quick, "local-chat/m1");
    assert.equal(s.deep, "cloud-a/m8");
    assert.equal(s.voice, "local-voice/v1");
    assert.equal(s.everyday, "local-chat/e1");
  } finally { home.cleanup(); other.cleanup(); }
});

test("co-hosted seeds no pi sources", () => {
  const h = piHome(FIXTURE);
  try {
    const s = defaultSeedSources({ env: { CROW_HOME: h.home + "/.crow-r4" }, homeDir: h.home });
    for (const id of ["quick", "deep", "coordinator", "critic", "expert"]) assert.equal(s[id], null, id);
    assert.equal(s.voice, "crow-voice/qwen3.5-4b");
  } finally { h.cleanup(); }
});

test("per-key authority", async () => {
  const { db, cleanup } = fresh();
  const SELF = new Set(["model_role.embed", "model_role.rerank", "model_role_subagents"]);
  const authority = async (_db, key) => (SELF.has(key) ? { kind: "self" } : { kind: "primary", instanceId: "i-primary" });
  try {
    assert.deepEqual(await setBinding(db, "voice", { model: "local-voice/m2" }, { actor: "t", authority }), { ok: false, reason: "follows_primary" });
    assert.equal(await rawValue(db, "model_role.voice"), undefined);
    assert.deepEqual(await setBinding(db, "embed", { model: "emb-a/e1" }, { actor: "t", authority }), { ok: true });
    assert.deepEqual(await roleBindingAuthority(db, "model_role.embed"), { kind: "self" });
    assert.deepEqual(await roleBindingAuthority(db, "model_role.voice"), { kind: "self" });
  } finally { cleanup(); }
});

test("seed skips a role whose authority is not self", async () => {
  const { db, cleanup } = fresh();
  try {
    const authority = async (_db, key) => (key === "model_role.voice" ? { kind: "primary", instanceId: "i-p" } : { kind: "self" });
    const r = await seedRoleBindings(db, { sources: { voice: "local-voice/m2", everyday: "local-chat/m1" }, log: quiet, authority });
    assert.deepEqual(r.inserted, ["everyday"]);
  } finally { cleanup(); }
});

test("setBinding validation; written value shape", async () => {
  const { db, cleanup } = fresh();
  try {
    assert.deepEqual(await setBinding(db, "nope", { model: "a/b" }, { actor: "t" }), { ok: false, reason: "unknown_role" });
    assert.deepEqual(await setBinding(db, "quick", { model: "nokey" }, { actor: "t" }), { ok: false, reason: "invalid_model" });
    assert.deepEqual(await setBinding(db, "quick", { model: "role:nope" }, { actor: "t" }), { ok: false, reason: "invalid_model" });
    assert.deepEqual(await setBinding(db, "quick", { model: "a/b", fallback: ["nope"] }, { actor: "t" }), { ok: false, reason: "invalid_fallback" });
    assert.deepEqual(await setBinding(db, "quick", { model: "role:everyday", fallback: ["deep"] }, { actor: "t" }), { ok: true });
    assert.deepEqual(await setBinding(db, "deep", { model: null }, { actor: "t" }), { ok: true });
    const v = JSON.parse(await rawValue(db, "model_role.quick"));
    assert.equal(v.model, "role:everyday");
    assert.deepEqual(v.fallback, ["deep"]);
    assert.equal(v.by, "t");
    assert.equal(typeof v.at, "string");
    assert.equal("seeded" in v, false);
  } finally { cleanup(); }
});

test("corrupt row is unset", async () => {
  const { db, cleanup } = fresh();
  try {
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))", args: ["model_role.everyday", "{bad"] });
    assert.equal((await readBindings(db)).everyday, undefined);
    const r = await resolveRole(db, "role:everyday", {});
    assert.equal(r.key, null);
    assert.equal(typeof r.reason, "string");
  } finally { cleanup(); }
});

test("context invalidated by setBinding", async () => {
  const { db, cleanup } = fresh();
  try {
    const a = await loadRoleContext(db, { maxAgeMs: 60000 });
    assert.equal(a.bindings.quick, undefined);
    await setBinding(db, "quick", { model: "local-chat/m1" }, { actor: "t" });
    const b = await loadRoleContext(db, { maxAgeMs: 60000 });
    assert.equal(b.bindings.quick.model, "local-chat/m1");
    assert.ok(Array.isArray(b.catalog));
    assert.equal(typeof b.ownInstanceId, "function");
  } finally { cleanup(); }
});

test("resolveRole: models from enabled DB rows; chosenOnly ignores a seed", async () => {
  const { db, cleanup } = fresh();
  try {
    await db.execute({
      sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?, ?, ?, 0)",
      args: ["local-chat", "http://127.0.0.1:8003/v1", JSON.stringify([{ id: "m1" }])],
    });
    await seedRoleBindings(db, { sources: { everyday: "local-chat/m1" }, log: quiet });
    invalidateRoleContext();
    const full = await resolveRole(db, "role:everyday", {});
    assert.equal(full.key, "local-chat/m1");
    const chosen = await resolveRole(db, "role:everyday", { chosenOnly: true });
    assert.equal(chosen.key, null);
    assert.equal(chosen.reason, "not_chosen");
  } finally { cleanup(); }
});

test("boot wiring", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/boot/admin-api.js"), "utf8");
  const r = src.indexOf("await reconcile();");
  assert.ok(r > 0, "reconcile call present");
  const s = src.indexOf("seedRoleBindings(", r);
  assert.ok(s > r, "seedRoleBindings( after await reconcile();");
  const tryAt = src.lastIndexOf("try {", s);
  assert.ok(tryAt > r, "inside a try { after reconcile");
  const fin = src.indexOf("finally", s);
  assert.ok(fin > s, "a finally follows");
  const block = src.slice(src.lastIndexOf("createDbClient()", s), fin + 60);
  assert.ok(src.lastIndexOf("createDbClient()", s) > r, "createDbClient() opened for the seed");
  assert.match(block, /finally\s*\{\s*\w+\.close\(\)/);
});

test("memory-side id wrap", async () => {
  const { db, cleanup } = fresh();
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const ctx = await loadRoleContext(db, { getOrCreateLocalInstanceId: () => { throw new Error("unpinned"); } });
    assert.equal(ctx.ownInstanceId(), null);
    assert.equal(ctx.ownInstanceId(), null);
    const hits = warns.filter((w) => w.includes("[roles] own instance id unavailable; instance-owned rows treated as foreign"));
    assert.equal(hits.length, 1);
  } finally { console.warn = orig; cleanup(); }
});
