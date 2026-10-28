/**
 * Model roles Phase 1, Task 3: the role snapshot pi reads
 * ($CROW_HOME/model-roles.json). Pure build, an atomic 0600 write that never
 * follows a link, a parallel reader that only ever sees whole files, and the
 * provider-change listener that reschedules it. Every DB is a fresh scratch
 * init-db; every snapshot path is under a scratch dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import {
  mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, readdirSync, lstatSync, symlinkSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { setBinding, loadRoleContext, invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import {
  buildRoleSnapshot, writeRoleSnapshot, roleSnapshotPath, scheduleRoleSnapshot,
} from "../servers/shared/model-roles-snapshot.js";
import { addProviderChangeListener, setProviderChangeHook, upsertProvider } from "../servers/shared/providers-db.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "roles-snap-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  invalidateRoleContext();
  return { dir, db, cleanup() { invalidateRoleContext(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

async function provider(db, id, baseUrl, models, { host = null, gpuPolicy = null } = {}) {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, host, models, gpu_policy, disabled) VALUES (?, ?, ?, ?, ?, 0)",
    args: [id, baseUrl, host, JSON.stringify(models.map((m) => ({ id: m }))), gpuPolicy ? JSON.stringify(gpuPolicy) : null],
  });
  invalidateRoleContext();
}
const bind = (db, id, model, fallback) => setBinding(db, id, fallback ? { model, fallback } : { model }, { actor: "test" });
const snapOf = async (db) => buildRoleSnapshot(await loadRoleContext(db), { instanceId: "inst-1", now: new Date(0), subagents: null });

test("shape, resolution and cloud", async () => {
  const { db, cleanup } = fresh();
  try {
    await provider(db, "local-voice", "http://127.0.0.1:8011/v1", ["m2"]);
    await provider(db, "cloud-a", "https://api.example.com/v1", ["m9"]);
    await bind(db, "voice", "local-voice/m2");
    await bind(db, "everyday", "cloud-a/m9");
    const s = await snapOf(db);
    assert.equal(s.version, 1);
    assert.equal(s.instance_id, "inst-1");
    assert.equal(s.generated_at, new Date(0).toISOString());
    assert.equal("subagents" in s, false, "no subagents key when null");
    assert.equal(s.roles.voice.resolved, "local-voice/m2");
    assert.deepEqual(s.roles.voice.chain, ["voice"]);
    assert.equal(s.roles.voice.cloud, false);
    assert.equal(s.roles.everyday.resolved, "cloud-a/m9");
    assert.equal(s.roles.everyday.cloud, true);
    assert.deepEqual(s.roles.tts, { resolved: null, chain: [], candidates: [], cloud: false });
    assert.equal(s.roles.stt.resolved, null);
    assert.equal(s.roles.safety.resolved, null);
    assert.equal(s.roles.safety.cloud, false);
  } finally { cleanup(); }
});

test("cloud via a door", async () => {
  const { db, cleanup } = fresh();
  try {
    await provider(db, "cloud-a", "https://api.example.com/v1", ["m9"]);
    await provider(db, "door-a", "http://127.0.0.1:3001/llm/p/cloud-a/v1", ["m9"], { gpuPolicy: { door_forward: true } });
    await bind(db, "quick", "door-a/m9");
    const s = await snapOf(db);
    assert.equal(s.roles.quick.resolved, "door-a/m9");
    assert.equal(s.roles.quick.cloud, true, "a loopback door to a cloud upstream is cloud");
  } finally { cleanup(); }
});

test("candidates filtered", async () => {
  const { db, cleanup } = fresh();
  try {
    await provider(db, "local-voice", "http://127.0.0.1:8011/v1", ["m2"]);
    await provider(db, "far", "http://100.64.20.5:8000/v1", ["m3"], { host: "f".repeat(32) });
    await provider(db, "heavy", "http://127.0.0.1:8020/v1", ["m4"], { gpuPolicy: { catalogId: "glm-5.3-flash" } });
    await bind(db, "voice", "local-voice/m2", ["quick", "everyday"]);
    await bind(db, "quick", "far/m3");
    await bind(db, "everyday", "heavy/m4");
    await bind(db, "deep", "heavy/m4");
    const s = await snapOf(db);
    const keys = s.roles.voice.candidates.map((c) => c.key);
    assert.deepEqual(keys, ["local-voice/m2"], "foreign and windowed candidates are filtered");
    assert.deepEqual(s.roles.voice.chain, ["voice"]);
    // Positive control: the heavy row is configured and reachable where heavy is allowed.
    assert.ok(s.roles.deep.candidates.some((c) => c.key === "heavy/m4"));
    assert.equal(s.roles.deep.resolved, "heavy/m4");
  } finally { cleanup(); }
});

test("roleSnapshotPath follows CROW_HOME", () => {
  assert.equal(roleSnapshotPath({ env: { CROW_HOME: "/x/home" } }), join("/x/home", "model-roles.json"));
});

test("trust properties", async () => {
  const { dir, db, cleanup } = fresh();
  try {
    await provider(db, "local-voice", "http://127.0.0.1:8011/v1", ["m2"]);
    await bind(db, "voice", "local-voice/m2");
    const path = join(dir, "model-roles.json");
    const r = await writeRoleSnapshot(db, { path });
    assert.equal(r.path, path);
    const st = lstatSync(path);
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, process.getuid());
    assert.equal(readdirSync(dir).filter((f) => f.includes(".tmp-")).length, 0, "no temp file left behind");
    const j = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(j.roles.voice.resolved, "local-voice/m2");
  } finally { cleanup(); }
});

test("symlink replaced not followed", async () => {
  const { dir, db, cleanup } = fresh();
  try {
    const decoy = join(dir, "decoy.txt");
    writeFileSync(decoy, "decoy-bytes\n");
    const path = join(dir, "model-roles.json");
    symlinkSync(decoy, path);
    await writeRoleSnapshot(db, { path });
    const st = lstatSync(path);
    assert.ok(st.isFile() && !st.isSymbolicLink(), "the link is replaced by a regular file");
    assert.equal(readFileSync(decoy, "utf8"), "decoy-bytes\n");
  } finally { cleanup(); }
});

test("planted temp refused", async () => {
  const { dir, db, cleanup } = fresh();
  try {
    const decoy = join(dir, "decoy.txt");
    writeFileSync(decoy, "decoy-bytes\n");
    const path = join(dir, "model-roles.json");
    symlinkSync(decoy, path + ".tmp-fixed");
    await assert.rejects(writeRoleSnapshot(db, { path, tmpSuffix: "fixed" }), { code: "EEXIST" });
    assert.equal(readFileSync(decoy, "utf8"), "decoy-bytes\n");
    assert.equal(existsSync(path), false, "nothing published");
  } finally { cleanup(); }
});

// ---- the race harness (N3) ---------------------------------------------------

async function runRace(writeOnce, path) {
  await writeOnce(); // the file exists before the reader starts
  const worker = new Worker(new URL("./fixtures/model-roles/snapshot-reader-worker.mjs", import.meta.url), {
    workerData: { path, durationMs: 1000 },
  });
  let result = null, failure = null, resolveReady;
  const ready = new Promise((res) => { resolveReady = res; });
  worker.on("message", (m) => { if (m?.ready) resolveReady(); else if (m?.done) result = m; });
  worker.on("error", (e) => { failure = e; resolveReady(); });
  worker.on("exit", (code) => { if (!result && !failure) failure = new Error(`worker exited ${code} without a result`); resolveReady(); });
  await ready;
  const deadline = Date.now() + 15000;
  while (!result && !failure) {
    if (Date.now() > deadline) { failure = new Error("race harness: no result from the worker"); break; }
    await writeOnce();
    await new Promise((r) => setImmediate(r));
  }
  await worker.terminate();
  if (failure) throw failure;
  assert.equal(result.enoent, 0, `ENOENT after the pre-write is impossible (saw ${result.enoent})`);
  assert.ok(result.reads > 0, "the worker read the file");
  return { parseFailures: result.parseFailures, shortReads: result.shortReads, enoent: result.enoent, reads: result.reads };
}

async function raceDb() {
  const t = fresh();
  for (let i = 0; i < 6; i++) await provider(t.db, `local-p${i}`, `http://127.0.0.1:80${10 + i}/v1`, ["m1", "m2", "m3"]);
  for (const [i, id] of ["quick", "everyday", "deep", "voice", "vision", "critic"].entries()) await bind(t.db, id, `local-p${i}/m1`);
  return t;
}

test("worker reader sees whole files", async () => {
  const { dir, db, cleanup } = await raceDb();
  try {
    const path = join(dir, "model-roles.json");
    const r = await runRace(() => writeRoleSnapshot(db, { path }), path);
    assert.equal(r.parseFailures + r.shortReads, 0, `parseFailures=${r.parseFailures} shortReads=${r.shortReads} reads=${r.reads}`);
  } finally { cleanup(); }
});

test("negative control: a non-atomic writer is caught by the harness", async () => {
  const { dir, db, cleanup } = await raceDb();
  try {
    const path = join(dir, "model-roles.json");
    const json = JSON.stringify(await snapOf(db), null, 2);
    assert.ok(json.length > 640, "enough chunks to interleave");
    const naiveWrite = async () => {
      writeFileSync(path, "");
      for (let i = 0; i < json.length; i += 64) appendFileSync(path, json.slice(i, i + 64));
    };
    const r = await runRace(naiveWrite, path);
    assert.ok(r.parseFailures + r.shortReads > 0, `the harness must see the bad writer (reads=${r.reads})`);
  } finally { cleanup(); }
});

test("subagents only on the default home", async () => {
  const { dir, db, cleanup } = fresh();
  const saved = { CROW_HOME: process.env.CROW_HOME, HOME: process.env.HOME };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  try {
    const map = { scout: { role: "everyday", was: "local-chat/m1" } };
    await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES (?, ?)", args: ["model_role_subagents", JSON.stringify(map)] });
    const path = join(dir, "model-roles.json");

    process.env.CROW_HOME = join(dir, ".crow-r4");
    await writeRoleSnapshot(db, { path });
    assert.equal("subagents" in JSON.parse(readFileSync(path, "utf8")), false, "a co-hosted instance gets no subagents");

    process.env.CROW_HOME = join(dir, ".crow");
    process.env.HOME = dir;
    await writeRoleSnapshot(db, { path });
    restore();
    const j = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(j.subagents.scout, { role: "everyday", was: "local-chat/m1" });
  } finally { restore(); cleanup(); }
});

test("provider write reschedules", async () => {
  const { db, cleanup } = fresh();
  let spy = 0, hook = 0;
  setProviderChangeHook(() => { hook++; });
  const off = addProviderChangeListener(() => { spy++; });
  const offBad = addProviderChangeListener(() => { throw new Error("listener boom"); });
  const warns = [];
  const warn = console.warn;
  try {
    console.warn = (...a) => warns.push(a.join(" "));
    try { await upsertProvider(db, { id: "p1", baseUrl: "http://127.0.0.1:8099/v1", models: [{ id: "a" }] }); }
    finally { console.warn = warn; }
    assert.deepEqual(warns, ["[providers] change listener failed: listener boom"], "a throwing listener is logged, not fatal");
    assert.equal(spy, 1);
    assert.equal(hook, 1, "the existing hook still runs");
    off(); offBad();
    await upsertProvider(db, { id: "p1", baseUrl: "http://127.0.0.1:8099/v1", models: [{ id: "b" }] });
    assert.equal(spy, 1, "unsubscribed");
    assert.equal(hook, 2);
  } finally { off(); offBad(); setProviderChangeHook(null); cleanup(); }
});

test("scheduleRoleSnapshot debounces, writes once, closes its client", async () => {
  const { dir, db, cleanup } = fresh();
  try {
    const path = join(dir, "model-roles.json");
    let opened = 0, closed = 0;
    const factory = () => {
      opened++;
      return { execute: (q) => db.execute(q), close: () => { closed++; } };
    };
    scheduleRoleSnapshot(factory, { delayMs: 20, path });
    scheduleRoleSnapshot(factory, { delayMs: 20, path });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(opened, 1, "debounced to one run");
    assert.equal(closed, 1, "closed in finally");
    assert.ok(existsSync(path));
    // A failing run never throws out of the timer.
    const warns = [];
    const warn = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      scheduleRoleSnapshot(() => { throw new Error("no db"); }, { delayMs: 5, path });
      await new Promise((r) => setTimeout(r, 100));
    } finally { console.warn = warn; }
    assert.deepEqual(warns, ["[roles] snapshot write failed: no db"]);
  } finally { cleanup(); }
});

test("boot wiring: the snapshot write follows the role seed and closes its client", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/boot/admin-api.js"), "utf8");
  const seed = src.indexOf("seedRoleBindings(");
  const w = src.indexOf("writeRoleSnapshot(db", seed);
  assert.ok(seed > 0 && w > seed, "boot snapshot after the seed");
  assert.match(src.slice(w, w + 400), /finally \{\s*(try \{ )?db\.close\(\)/);
  assert.ok(src.includes("addProviderChangeListener("));
  assert.ok(src.includes("addBindingsChangeListener("));
  assert.match(src, /setInterval\(\(\) => scheduleRoleSnapshot\(createDbClient\), reconcileIntervalMs\(\)\)\.unref\(\)/);
});
