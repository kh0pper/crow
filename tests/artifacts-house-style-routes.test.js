// House style routes (spec §4.4): owner-only, CSRF, a project theme in
// design_house_styles, a bot default in its definition JSON (other keys kept).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { csrfMiddleware } from "../servers/gateway/dashboard/shared/csrf.js";
import * as runtime from "../servers/gateway/artifact-origin/runtime.js";
import * as policy from "../servers/gateway/artifact-origin/policy.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import artifactsRouter from "../bundles/artifacts/panel/routes.js";
import { ARTIFACTS_STRINGS } from "../bundles/artifacts/panel/artifacts.js";

const s = { kitOn: true };
const THEMES = new Map([["ocean-depths", { name: "Ocean Depths", colors: { bg: "#1a2332", fg: "#f1faee", accent: "#2d8b8b", accent2: "#a8dadc" } }]]);
before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "art-hs-routes-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await s.db.executeMultiple(`
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'general', status TEXT NOT NULL DEFAULT 'active', archived_at TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER, updated_at TEXT);
    INSERT INTO project_spaces (id, uuid, slug, name) VALUES (1, 'u-garden', 'garden', 'Garden'), (2, 'u-old', 'old', 'Old');
    INSERT INTO project_spaces (id, uuid, slug, name, type) VALUES (3, 'u-kid', 'kid', 'Learner', 'learner_profile');
    INSERT INTO project_spaces (id, uuid, slug, name, archived_at) VALUES (4, 'u-shelved', 'shelved', 'Shelved', '2026-01-01');
    UPDATE project_spaces SET status='archived' WHERE id=2;`);
  await s.db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES ('bobby','Bobby',?), ('mail','Mail',?)", args: [JSON.stringify({ tools: { crow_mcp: ["artifacts"] }, system_prompt: "keep me" }), JSON.stringify({ tools: { crow_mcp: ["gmail/send"] } })] });
  await initArtifactsTables(s.db);
  const design = { kit: async () => (s.kitOn ? { themes: s.themes || THEMES } : null), houseStyleFor: async () => null };
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).end());
  const app = express();
  app.use(artifactsRouter(dashboardAuth, { db: s.db, blobs: createLocalBlobStore(join(s.dir, "blobs")), runtime, policy, csrf: csrfMiddleware, renderDeps: { markdownBlocks }, design }));
  s.http = app.listen(0, "127.0.0.1"); await new Promise((r) => s.http.once("listening", r));
  s.base = `http://127.0.0.1:${s.http.address().port}`;
});
after(() => { s.http.close(); try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

const H = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok", "content-type": "application/json" };
const get = async () => (await fetch(s.base + "/api/artifacts/house-style", { headers: H })).json();
const post = async (body, headers = H) => { const r = await fetch(s.base + "/api/artifacts/house-style", { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };

test("GET lists themes, live projects and artifact bots", async () => {
  const j = await get();
  assert.equal(j.kit, true);
  assert.deepEqual(j.themes, [{ id: "ocean-depths", name: "Ocean Depths", colors: ["#1a2332", "#f1faee", "#2d8b8b", "#a8dadc"] }]);
  assert.deepEqual(j.projects, [{ id: 1, name: "Garden", theme: null }], "no archived projects, no learner profiles (review L8)");
  assert.deepEqual(j.bots, [{ id: "bobby", name: "Bobby", theme: null }]);
});

test("project: set and clear", async () => {
  assert.deepEqual(await post({ scope: "project", id: 1, theme: "ocean-depths" }), { status: 200, body: { ok: true } });
  assert.equal((await get()).projects[0].theme, "ocean-depths");
  assert.equal((await s.db.execute({ sql: "SELECT theme FROM design_house_styles WHERE project_uuid='u-garden'", args: [] })).rows[0].theme, "ocean-depths", "stored by uuid");
  assert.deepEqual(await post({ scope: "project", id: 1, theme: null }), { status: 200, body: { ok: true } });
  assert.equal((await get()).projects[0].theme, null);
  assert.equal((await post({ scope: "project", id: 99, theme: "ocean-depths" })).status, 404);
});

test("bot: set keeps every other definition key; clear removes the design key", async () => {
  await post({ scope: "bot", id: "bobby", theme: "ocean-depths" });
  let def = JSON.parse((await s.db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id='bobby'", args: [] })).rows[0].definition);
  assert.deepEqual(def, { tools: { crow_mcp: ["artifacts"] }, system_prompt: "keep me", design: { house_style: "ocean-depths" } });
  await post({ scope: "bot", id: "bobby", theme: null });
  def = JSON.parse((await s.db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id='bobby'", args: [] })).rows[0].definition);
  assert.deepEqual(def, { tools: { crow_mcp: ["artifacts"] }, system_prompt: "keep me" });
  const audit = (await s.db.execute({ sql: "SELECT target FROM artifact_audit WHERE action='house-style' ORDER BY id", args: [] })).rows.map((r) => r.target);
  assert.ok(audit.includes("bot:bobby") && audit.includes("project:1"));
});

test("refusals: unknown theme, bad scope, no CSRF, no kit", async () => {
  assert.equal((await post({ scope: "bot", id: "bobby", theme: "neon" })).status, 400);
  assert.equal((await post({ scope: "team", id: 1, theme: null })).status, 400);
  assert.equal((await post({ scope: "project", id: 1, theme: "ocean-depths" }, { ...H, "x-crow-csrf": "wrong" })).status, 403);
  s.kitOn = false;
  try {
    assert.deepEqual((await get()).kit, false);
    assert.equal((await post({ scope: "project", id: 1, theme: "ocean-depths" })).status, 400);
    assert.deepEqual(await post({ scope: "project", id: 1, theme: null }), { status: 200, body: { ok: true } }, "clearing works without the kit");
  } finally { s.kitOn = true; }
});

test("strings: the house-style keys exist in en and es", () => {
  for (const k of ["hs_button", "hs_title", "hs_help", "hs_no_kit", "hs_projects", "hs_bots", "hs_none", "hs_for", "hs_missing", "hs_no_projects", "hs_no_bots"]) {
    assert.ok(ARTIFACTS_STRINGS.en[k] && ARTIFACTS_STRINGS.es[k], k);
  }
});

// Task 15 carried rulings: F9 (colours by role), review L8 on the WRITE side,
// owner-only, the theme set only on bots that use Artifacts.
test("colours are read by role, not by JSON key order; odd values and ids are dropped", async () => {
  s.themes = new Map([
    ["sunset", { name: "Sunset", colors: { accent2: "#444444", accent: "#333333", fg: "#222222", bg: "#111111", extra: "#999999" } }],
    ["half", { name: "Half", colors: { bg: "#ffffff", fg: "url(x)" } }],
    ["../evil", { name: "Evil", colors: {} }],
  ]);
  try {
    const j = await get();
    assert.deepEqual(j.themes, [{ id: "sunset", name: "Sunset", colors: ["#111111", "#222222", "#333333", "#444444"] }, { id: "half", name: "Half", colors: ["#ffffff"] }]);
    assert.equal((await post({ scope: "project", id: 1, theme: "../evil" })).status, 400);
  } finally { delete s.themes; }
});

test("archived projects and learner profiles cannot be given a house style (review L8)", async () => {
  for (const id of [2, 3, 4]) {
    assert.equal((await post({ scope: "project", id, theme: "ocean-depths" })).status, 404, `project ${id}`);
    assert.equal((await post({ scope: "project", id, theme: null })).status, 404, `clear ${id}`);
  }
  assert.equal((await post({ scope: "project", id: "1x", theme: null })).status, 404);
  assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM design_house_styles WHERE project_uuid IN ('u-old','u-kid','u-shelved')", args: [] })).rows[0].n, 0);
});

test("bots: only a bot that uses Artifacts can be given one; any bot can be cleared; unknown bot 404", async () => {
  assert.equal((await post({ scope: "bot", id: "mail", theme: "ocean-depths" })).status, 400);
  assert.equal((await post({ scope: "bot", id: "nobody", theme: null })).status, 404);
  await s.db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='mail'", args: [JSON.stringify({ tools: { crow_mcp: ["gmail/send"] }, design: { house_style: "ocean-depths", other: 1 } })] });
  assert.deepEqual(await post({ scope: "bot", id: "mail", theme: null }), { status: 200, body: { ok: true } });
  const def = JSON.parse((await s.db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id='mail'", args: [] })).rows[0].definition);
  assert.deepEqual(def.design, { other: 1 }, "other design keys are kept");
});

test("owner-only: no dashboard session is refused before anything is written", async () => {
  const r = await fetch(s.base + "/api/artifacts/house-style", { method: "POST", headers: { ...H, cookie: "crow_csrf=tok" }, body: JSON.stringify({ scope: "project", id: 1, theme: "ocean-depths" }) });
  assert.equal(r.status, 401);
  assert.equal((await fetch(s.base + "/api/artifacts/house-style", { headers: { cookie: "crow_csrf=tok" } })).status, 401);
});
