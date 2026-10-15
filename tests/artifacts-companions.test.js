// Artifacts smoke fixes S2a (review M7): a def that grants artifact_update
// also gets artifact_find and artifact_attach, written INTO the stored def
// (one-time boot migration + the Bot Builder save) so every crow_mcp consumer
// — the tool-budget preflight, the Safety tab, federation — sees the same
// explicit list the owner sees. Never past the model's tool cap; a whole-server
// grant is untouched; peer patches are never augmented.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "art-companions-"));
const saved = { PI_MODELS_JSON: process.env.PI_MODELS_JSON, HOME: process.env.HOME };
process.env.PI_MODELS_JSON = join(dir, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
process.env.HOME = join(dir, "fakehome");
mkdirSync(process.env.HOME, { recursive: true });

const { withArtifactsCompanions } = await import("../scripts/pi-bots/bot-world.mjs");
const { addCompanionsGuarded, migrateArtifactsCompanions, MIGRATION_KEY } = await import("../scripts/pi-bots/artifacts-companions.mjs");
const { toolAllowlist } = await import("../scripts/pi-bots/bridge.mjs");
const { saveAbilities } = await import("../servers/gateway/dashboard/panels/bot-builder/save-handlers.js");
const { createDbClient } = await import("../servers/db.js");
const { applyPeerPatch } = await import("../servers/gateway/bot-federation.js");

const U = "artifacts/artifact_update", F = "artifacts/artifact_find", A = "artifacts/artifact_attach";
// A budget seam: cap N, count = crow_mcp entries (+ builtins).
const budget = (cap) => ({ cap, countFor: (d) => ((d.tools && d.tools.crow_mcp) || []).length + ((d.tools && d.tools.pi_builtin) || []).length });

after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

test("withArtifactsCompanions: Update brings Find and Attach (either spelling); a whole-server grant or no Update is untouched; never duplicates", () => {
  assert.deepEqual(withArtifactsCompanions(["memory", U]), ["memory", U, F, A]);
  assert.deepEqual(withArtifactsCompanions(["artifacts__artifact_update"]), ["artifacts__artifact_update", F, A]);
  assert.deepEqual(withArtifactsCompanions([U, A]), [U, A, F]);
  assert.deepEqual(withArtifactsCompanions([U, "artifacts__artifact_find", "artifacts__artifact_attach"]), [U, "artifacts__artifact_find", "artifacts__artifact_attach"], "the __ spelling counts as present");
  assert.deepEqual(withArtifactsCompanions(["artifacts"]), ["artifacts"]);
  assert.deepEqual(withArtifactsCompanions(["artifacts", U]), ["artifacts", U], "the whole server already covers them");
  assert.deepEqual(withArtifactsCompanions(["artifacts/artifact_create"]), ["artifacts/artifact_create"]);
  assert.deepEqual(withArtifactsCompanions([]), []);
  assert.deepEqual(withArtifactsCompanions(undefined), []);
  const input = [U];
  withArtifactsCompanions(input);
  assert.deepEqual(input, [U], "pure: the input is never mutated");
});

test("addCompanionsGuarded: added under the cap, refused over it, added when the cap is unknown", async () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: ["memory/crow_search_memories", U] } };
  let r = await addCompanionsGuarded(def, { budget: budget(10) });
  assert.deepEqual(r.added, [F, A]);
  assert.equal(r.refused, false);
  assert.deepEqual(r.def.tools.crow_mcp, ["memory/crow_search_memories", U, F, A]);
  assert.deepEqual(def.tools.crow_mcp, ["memory/crow_search_memories", U], "the input def is not mutated");
  r = await addCompanionsGuarded(def, { budget: budget(4) });
  assert.equal(r.refused, true, "3 + 2 = 5 > 4");
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.def.tools.crow_mcp, def.tools.crow_mcp);
  r = await addCompanionsGuarded(def, { budget: { cap: null, countFor: () => 999 } });
  assert.deepEqual(r.added, [F, A], "no cap known: they are added (explicit, so a later budget refusal names them)");
  r = await addCompanionsGuarded({ tools: { crow_mcp: ["artifacts"] } }, { budget: budget(1) });
  assert.deepEqual(r.added, []);
  assert.equal(r.refused, false);
});

async function defsDb() {
  const db = createDbClient(join(dir, `crow-${Math.random().toString(36).slice(2)}.db`));
  await db.executeMultiple(`
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER, created_at TEXT, updated_at TEXT);`);
  const ins = (id, d) => db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)", args: [id, id, typeof d === "string" ? d : JSON.stringify(d)] });
  await ins("bobby", { tools: { crow_mcp: ["memory/crow_search_memories", U] } });
  await ins("alex", { tools: { crow_mcp: ["artifacts"] } });
  await ins("big", { tools: { crow_mcp: ["a/1", "a/2", "a/3", U] } });
  await ins("none", { tools: { crow_mcp: ["memory/crow_search_memories"] } });
  await ins("junk", "{ not json");
  return db;
}
const defOf = async (db, id) => JSON.parse((await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0].definition);

test("the boot migration writes Find/Attach into stored defs once (marker), skips over-cap and whole-server defs with a log line", async () => {
  const db = await defsDb();
  try {
    const logs = [];
    const out = await migrateArtifactsCompanions(db, { log: (m) => logs.push(m), budgetFor: async () => budget(5) });
    assert.deepEqual(out.updated, ["bobby"]);
    assert.deepEqual(out.refused, ["big"]);
    assert.deepEqual((await defOf(db, "bobby")).tools.crow_mcp, ["memory/crow_search_memories", U, F, A]);
    assert.deepEqual((await defOf(db, "alex")).tools.crow_mcp, ["artifacts"]);
    assert.deepEqual((await defOf(db, "big")).tools.crow_mcp, ["a/1", "a/2", "a/3", U]);
    assert.ok(logs.some((m) => /big/.test(m) && /tool limit/.test(m)));
    assert.ok((await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key=?", args: [MIGRATION_KEY] })).rows[0]);
    // The runtime list for a migrated def is exactly its explicit list.
    assert.equal(toolAllowlist(await defOf(db, "bobby")), "mcp__memory__crow_search_memories,mcp__artifacts__artifact_update,mcp__artifacts__artifact_find,mcp__artifacts__artifact_attach");
    // Runs once: a def granted Update later (say by a peer patch) is never augmented by a re-run.
    await db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='none'", args: [JSON.stringify({ tools: { crow_mcp: [U] } })] });
    const again = await migrateArtifactsCompanions(db, { log: () => {}, budgetFor: async () => budget(50) });
    assert.equal(again.skipped, true);
    assert.deepEqual((await defOf(db, "none")).tools.crow_mcp, [U]);
  } finally { db.close(); }
});

const catalog = JSON.stringify({ artifacts: [["artifact_update", "write"], ["artifact_find", "read"], ["artifact_attach", "write"], ["artifact_get", "read"]] });
const ctx = (cap) => ({ lang: "en", changed: () => true, companionBudget: async () => budget(cap) });

test("Bot Builder save: ticking Update adds Find/Attach under the cap; over it the owner is told and nothing is added", async () => {
  const def = { tools: { crow_mcp: ["artifacts/artifact_get"] } };
  let r = await saveAbilities(def, { src_catalog: catalog, src__artifacts: "custom", src__artifacts__was: "custom", tool__artifacts: ["artifacts/artifact_get", U] }, ctx(10));
  assert.equal(r.error, undefined);
  assert.deepEqual(def.tools.crow_mcp, ["artifacts/artifact_get", U, F, A]);
  const def2 = { tools: { crow_mcp: ["artifacts/artifact_get"] } };
  r = await saveAbilities(def2, { src_catalog: catalog, src__artifacts: "custom", src__artifacts__was: "custom", tool__artifacts: ["artifacts/artifact_get", U] }, ctx(2));
  assert.deepEqual(def2.tools.crow_mcp, ["artifacts/artifact_get", U]);
  assert.equal(r.warn.length, 1);
  assert.match(r.warn[0], /Find and Attach were not added/);
  const es = await saveAbilities({ tools: { crow_mcp: [] } }, { src_catalog: catalog, src__artifacts: "custom", src__artifacts__was: "off", tool__artifacts: [U] }, { ...ctx(1), lang: "es" });
  assert.ok(es.warn[0] && !/Find and Attach were not added/.test(es.warn[0]), "translated");
});

test("Bot Builder save: explicit Find/Attach survive unticking Update (they stay ticked and posted)", async () => {
  const def = { tools: { crow_mcp: [U, F, A] } };
  await saveAbilities(def, { src_catalog: catalog, src__artifacts: "custom", src__artifacts__was: "custom", tool__artifacts: [F, A] }, ctx(10));
  assert.deepEqual(def.tools.crow_mcp.sort(), [A, F].sort());
});

test("a federation patch granting artifact_update stays exactly as sent (peer grants are never augmented)", async (t) => {
  if (typeof applyPeerPatch !== "function") { t.skip("applyPeerPatch not exported"); return; }
  const merged = applyPeerPatch({ tools: { crow_mcp: [] } }, { "tools.crow_mcp": [U] });
  assert.deepEqual(merged.tools.crow_mcp, [U]);
});

test("review 2: a save where Update was ALREADY granted never re-adds an untick of Find/Attach", async () => {
  const def = { tools: { crow_mcp: [U, F, A, "artifacts/artifact_get"] } };
  // The owner unticks Attach (Update stays ticked).
  await saveAbilities(def, { src_catalog: catalog, src__artifacts: "custom", src__artifacts__was: "custom", tool__artifacts: [U, F, "artifacts/artifact_get"] }, ctx(10));
  assert.deepEqual(def.tools.crow_mcp.slice().sort(), [U, F, "artifacts/artifact_get"].sort(), "the untick stands");
  // An unrelated Abilities save later: still not re-added.
  await saveAbilities(def, { files_mode: "read", files_mode__was: "read" }, ctx(10));
  assert.ok(!def.tools.crow_mcp.includes(A));
  // Update off → on in one save: added.
  const d2 = { tools: { crow_mcp: [U, "artifacts/artifact_get"] } };
  await saveAbilities(d2, { src_catalog: catalog, src__artifacts: "custom", src__artifacts__was: "custom", tool__artifacts: ["artifacts/artifact_get"] }, ctx(10));
  assert.deepEqual(d2.tools.crow_mcp, ["artifacts/artifact_get"]);
  await saveAbilities(d2, { src_catalog: catalog, src__artifacts: "custom", src__artifacts__was: "custom", tool__artifacts: ["artifacts/artifact_get", U] }, ctx(10));
  assert.ok(d2.tools.crow_mcp.includes(F) && d2.tools.crow_mcp.includes(A), "re-ticking Update brings them");
});

test("review 4: a cap-refused bot gets ONE owner notification naming it and saying why", async () => {
  const db = await defsDb();
  try {
    const notes = [];
    await migrateArtifactsCompanions(db, { log: () => {}, budgetFor: async () => budget(5), notify: async (n) => notes.push(n) });
    assert.equal(notes.length, 1);
    assert.match(notes[0].title, /big/);
    assert.match(notes[0].body, /tool limit/);
    await migrateArtifactsCompanions(db, { log: () => {}, budgetFor: async () => budget(5), notify: async (n) => notes.push(n) });
    assert.equal(notes.length, 1, "the migration runs once, so the notice is posted once");
  } finally { db.close(); }
});
