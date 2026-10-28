/**
 * Model roles Phase 1, Task 4: a bot def may name `role:<id>` for its default
 * or escalation model. resolveModel walks this instance's bindings (full walk,
 * need "chat"), substitutes the raw key, then runs today's validation against
 * the same loaded models. A raw key resolves exactly as the frozen pre-roles
 * resolver does.
 *
 * Every DB here is a fresh scratch init-db; no pi is spawned.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const scratch = mkdtempSync(join(tmpdir(), "crow-resolver-roles-"));
process.env.CROW_DATA_DIR = join(scratch, "data");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(scratch, "no-such-models.json");
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
});

const { test } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const { default: Database } = await import("better-sqlite3");
const { resolveModel, LOCAL_FALLBACK } = await import("../scripts/pi-bots/model_resolver.mjs");
const frozen = await import("./fixtures/model-roles/model_resolver.pre-roles.mjs");
const { getOrCreateLocalInstanceId } = await import("../servers/gateway/instance-registry.js");
const { filterSpawnEnvWithReport } = await import("../scripts/pi-bots/bridge.mjs");

const DB_PATH = join(process.env.CROW_DATA_DIR, "crow.db");

function withDb(fn) {
  const d = new Database(DB_PATH);
  d.pragma("busy_timeout = 10000");
  try { return fn(d); } finally { d.close(); }
}

function reset({ bindings = {}, providers = [["local-chat", [{ id: "m1" }]], ["local-voice", [{ id: "m2" }]]] } = {}) {
  withDb((d) => {
    d.prepare("DELETE FROM dashboard_settings WHERE key >= 'model_role' AND key < 'model_rolf'").run();
    d.prepare("DELETE FROM providers").run();
    for (const [id, models] of providers) {
      d.prepare("INSERT INTO providers (id, base_url, models, host, disabled) VALUES (?, ?, ?, 'local', 0)")
        .run(id, "http://127.0.0.1:9/v1", JSON.stringify(models));
    }
    for (const [id, value] of Object.entries(bindings)) {
      d.prepare("INSERT INTO dashboard_settings (key, value) VALUES (?, ?)").run("model_role." + id, JSON.stringify(value));
    }
  });
}
const setProvider = (id, col, value) => withDb((d) => d.prepare(`UPDATE providers SET ${col} = ? WHERE id = ?`).run(value, id));
const pick = (r, keys) => Object.fromEntries(keys.map((k) => [k, r[k]]));

test("role default resolves", async () => {
  reset({ bindings: { everyday: { model: "local-chat/m1" } } });
  const r = await resolveModel({ models: { default: "role:everyday" } });
  assert.deepEqual(r, {
    provider: "local-chat", model: "m1", key: "local-chat/m1", escalated: false, source: "default",
    escalationRequestedButUnavailable: false, role: "everyday", chain: ["everyday"], roleReason: "bound",
  });
});

test("role escalation", async () => {
  reset({ bindings: { deep: { model: "local-voice/m2" } } });
  const r = await resolveModel({ models: { default: "local-chat/m1", escalation: "role:deep" } }, { escalate: true });
  assert.deepEqual(pick(r, ["key", "escalated", "source", "role"]),
    { key: "local-voice/m2", escalated: true, source: "escalation", role: "deep" });
});

test("disabled bound provider walks chain; re-enabling is seen on the next call", async () => {
  reset({ bindings: { everyday: { model: "local-chat/m1", fallback: ["quick"] }, quick: { model: "local-voice/m2" } } });
  setProvider("local-chat", "disabled", 1);
  const r = await resolveModel({ models: { default: "role:everyday" } });
  assert.deepEqual(pick(r, ["key", "chain", "roleReason"]),
    { key: "local-voice/m2", chain: ["everyday", "quick"], roleReason: "fallback" });
  setProvider("local-chat", "disabled", 0);
  const r2 = await resolveModel({ models: { default: "role:everyday" } });
  assert.deepEqual(pick(r2, ["key", "roleReason"]), { key: "local-chat/m1", roleReason: "bound" });
});

test("own row accepted (positive control)", async () => {
  reset({ bindings: { everyday: { model: "local-chat/m1", fallback: ["quick"] }, quick: { model: "local-voice/m2" } } });
  setProvider("local-chat", "host", getOrCreateLocalInstanceId());
  const r = await resolveModel({ models: { default: "role:everyday" } });
  assert.deepEqual(pick(r, ["key", "roleReason"]), { key: "local-chat/m1", roleReason: "bound" });
});

test("foreign row skipped", async () => {
  reset({ bindings: { everyday: { model: "local-chat/m1", fallback: ["quick"] }, quick: { model: "local-voice/m2" } } });
  setProvider("local-chat", "host", "b".repeat(32));
  const r = await resolveModel({ models: { default: "role:everyday" } });
  assert.deepEqual(pick(r, ["key", "chain", "roleReason"]),
    { key: "local-voice/m2", chain: ["everyday", "quick"], roleReason: "fallback" });
});

test("role ref with no bindings falls back without throwing", async () => {
  reset();
  const r = await resolveModel({ models: { default: "role:everyday" } });
  assert.deepEqual(pick(r, ["key", "source", "role", "roleReason"]),
    { key: LOCAL_FALLBACK, source: "fallback", role: "everyday", roleReason: "unset" });
});

test("media role refused", async () => {
  reset({ bindings: { tts: { model: "local-voice/m2" } } });
  const r = await resolveModel({ models: { default: "role:tts" } });
  assert.deepEqual(pick(r, ["key", "source", "roleReason"]),
    { key: LOCAL_FALLBACK, source: "fallback", roleReason: "capability" });
});

test("unresolvable escalation role sets the R12 flag", async () => {
  reset();
  const r = await resolveModel({ models: { default: "local-chat/m1", escalation: "role:deep" } }, { escalate: true });
  assert.deepEqual(pick(r, ["key", "source", "escalated", "escalationRequestedButUnavailable", "escalationRole", "escalationReason"]),
    { key: "local-chat/m1", source: "fallback", escalated: false, escalationRequestedButUnavailable: true,
      escalationRole: "deep", escalationReason: "unset" });
  // The raw default is not the role's model: the result carries no role tag.
  assert.equal("role" in r, false);
  assert.equal("roleReason" in r, false);
});

test("role default with an unresolvable escalation role keeps both apart", async () => {
  reset({ bindings: { everyday: { model: "local-chat/m1" } } });
  const r = await resolveModel({ models: { default: "role:everyday", escalation: "role:tts" } }, { escalate: true });
  assert.deepEqual(pick(r, ["key", "source", "role", "roleReason", "escalationRole", "escalationReason", "escalationRequestedButUnavailable"]),
    { key: "local-chat/m1", source: "fallback", role: "everyday", roleReason: "bound",
      escalationRole: "tts", escalationReason: "capability", escalationRequestedButUnavailable: true });
});

test("raw keys match the frozen copy", async () => {
  reset({ bindings: { everyday: { model: "local-voice/m2" } } });
  const defs = {
    valid: { models: { default: "local-chat/m1" } },
    invalid: { models: { default: "nope/x" } },
    missingModels: {},
    escalationValid: { models: { default: "local-chat/m1", escalation: "local-voice/m2" } },
    escalationInvalid: { models: { default: "local-chat/m1", escalation: "nope/z" } },
    noEscalation: { models: { default: "local-voice/m2" } },
  };
  for (const [name, def] of Object.entries(defs)) {
    for (const escalate of [false, true]) {
      const now = await resolveModel(def, { escalate });
      const then = await frozen.resolveModel(def, { escalate });
      assert.deepEqual(now, then, `${name} escalate=${escalate}`);
      assert.equal("role" in now, false, `${name} escalate=${escalate} has no role field`);
    }
  }
});

test("spawn env reserved: CROW_MODEL_ROLES_FILE stripped, and set after opts.extraEnv", () => {
  assert.deepEqual(
    filterSpawnEnvWithReport({ spawn_env: { CROW_MODEL_ROLES_FILE: "/tmp/evil", FOO: "1" } }),
    { spawnEnv: { FOO: "1" }, stripped: ["CROW_MODEL_ROLES_FILE"] },
  );
  const src = readFileSync(join(import.meta.dirname, "../scripts/pi-bots/bridge.mjs"), "utf8");
  const extra = src.indexOf("opts.extraEnv || {}");
  const assign = src.indexOf("CROW_MODEL_ROLES_FILE: roleSnapshotPath()");
  assert.ok(extra > 0, "opts.extraEnv merge found");
  assert.ok(assign > extra, "CROW_MODEL_ROLES_FILE is assigned after opts.extraEnv");
  assert.match(src, /" escalation-role=" \+ resolved\.escalationRole/, "the log line names a failed escalation role");
});

test("the bridge's snapshot path is the gateway writer's path", async () => {
  const env = await import("../servers/shared/model-roles-env.js");
  const snap = await import("../servers/shared/model-roles-snapshot.js");
  // One definition: the writer module re-exports the leaf's function.
  assert.equal(snap.roleSnapshotPath, env.roleSnapshotPath);
  const bridgeSrc = readFileSync(join(import.meta.dirname, "../scripts/pi-bots/bridge.mjs"), "utf8");
  assert.match(bridgeSrc, /import \{ roleSnapshotPath \} from "\.\.\/\.\.\/servers\/shared\/model-roles-env\.js";/);
  const writerSrc = readFileSync(join(import.meta.dirname, "../servers/shared/model-roles-snapshot.js"), "utf8");
  assert.match(writerSrc, /writeRoleSnapshot\(db, \{ path = roleSnapshotPath\(\)/, "the writer defaults to the same function");
  // CROW_HOME decides it; CROW_DATA_DIR and CROW_DB_PATH do not move it.
  const home = join(scratch, "inst-home");
  assert.equal(env.roleSnapshotPath({ env: { CROW_HOME: home } }), join(home, "model-roles.json"));
  assert.equal(env.roleSnapshotPath({ env: { CROW_HOME: home, CROW_DATA_DIR: join(scratch, "elsewhere"), CROW_DB_PATH: join(scratch, "x.db") } }),
    join(home, "model-roles.json"));
  assert.equal(env.roleSnapshotPath(), join(process.env.CROW_HOME || join((await import("node:os")).homedir(), ".crow"), "model-roles.json"));
});

test("loadRoleContextSync: a throwing own-id function gives null, logged once", async () => {
  const { loadRoleContextSync } = await import("../scripts/pi-bots/role_context.mjs");
  reset({ bindings: { everyday: { model: "local-chat/m1" } } });
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const ctx = withDb((d) => loadRoleContextSync(d, { models: null, ownInstanceId: () => { throw new Error("x"); } }));
    assert.equal(ctx.ownInstanceId(), null);
    assert.equal(ctx.ownInstanceId(), null);
    assert.equal(ctx.bindings.everyday.model, "local-chat/m1");
    assert.equal(ctx.providers.length, 2);
    assert.ok(Array.isArray(ctx.catalog) && ctx.catalog.length > 0, "catalog loaded");
  } finally {
    console.warn = orig;
  }
  assert.deepEqual(warns.filter((w) => w.includes("own instance id unavailable")).length, 1);
});

test("bridge.mjs loads neither the role store, the settings registry nor the snapshot writer", () => {
  const script = `
    import { registerHooks } from "node:module";
    const seen = [];
    registerHooks({ resolve(s, c, n) { const r = n(s, c); seen.push(r.url); return r; } });
    await import(${JSON.stringify(new URL("../scripts/pi-bots/bridge.mjs", import.meta.url).href)});
    process.stdout.write(JSON.stringify(seen));
    process.exit(0);`;
  const seen = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: join(import.meta.dirname, ".."), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  }).toString());
  for (const banned of ["servers/shared/model-roles-store.js", "servers/gateway/dashboard/settings/registry.js", "servers/shared/model-roles-snapshot.js"]) {
    assert.equal(seen.filter((u) => u.endsWith(banned)).length, 0, banned);
  }
  assert.ok(seen.some((u) => u.endsWith("servers/shared/model-roles-env.js")));
});
