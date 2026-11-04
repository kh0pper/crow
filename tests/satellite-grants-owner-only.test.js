/**
 * Satellite-bundle grants are the owner's alone (spec §8, §9.2, §9.4): a peer's SSO session saving
 * any Bot Builder tab, or a signed peer patching a peer-managed bot, never changes a bot's
 * satellite grants or their "always ask before" entries; a bundle that becomes satellite-hosted
 * starts with no grants. servers/gateway/satellites/grants.js and its callers.
 */
import { test, before, after } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-satgrants-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-satgrants-data-"));
const DB_PATH = join(DATA, "crow.db");
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_PATH;

const { createDbClient } = await import("../servers/db.js");
const { keepSatelliteGrants, stripBotGrantsForBundle } = await import("../servers/gateway/satellites/grants.js");
const { handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js");
const { applyPeerPatch } = await import("../servers/gateway/bot-federation.js");
const { _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");

const BOT = "b1";
const OWNER_SESS = "owner-sess-satgrants", SSO_SESS = "sso-sess-satgrants";
const hashTok = (t) => createHash("sha256").update(t).digest("hex");
const IDS = new Set(["gitea"]);
let db;

const installSatellite = () => writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "gitea", mode: "satellite", host: "sat-alpha-0001", version: "1.0.0" }]));
const mkRes = () => { const res = { redirected: null }; res.send = () => res; res.redirectAfterPost = (u) => { res.redirected = u; }; return res; };
const post = async (body, session) => {
  const res = mkRes();
  await handleBotBuilderPost({ body: { bot_id: BOT, ...body }, headers: {}, cookies: {}, dashboardSession: session, socket: { remoteAddress: "100.64.20.5" }, ip: "100.64.20.5" }, res, { db });
  return res;
};
const defNow = async () => JSON.parse((await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [BOT] })).rows[0].definition);
const setDef = (def) => db.execute({ sql: "UPDATE pi_bot_defs SET definition = ? WHERE bot_id = ?", args: [JSON.stringify(def), BOT] });

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  db = createDbClient(DB_PATH);
  _setSourcesForTest({ error: null, sources: [] });
  for (const [tok, scopes] of [[OWNER_SESS, "dashboard"], [SSO_SESS, "dashboard sso src:instance-peer"]]) {
    await db.execute({ sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), datetime('now'))", args: [hashTok(tok), scopes] });
  }
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)", args: [BOT, "B1", JSON.stringify({ tools: { crow_mcp: [] }, permission_policy: {} })] });
});

after(() => {
  try { db?.close(); } catch { /* closed */ }
  _setSourcesForTest(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [HOME, DATA]) rmScratch(d);
});

test("keepSatelliteGrants: both spellings, and the ask-first entries, go back to what they were", () => {
  const orig = { tools: { crow_mcp: ["crow-memory/crow_recall", "gitea/gitea_list_repos"] }, permission_policy: { confirm: ["gitea/gitea_create_repo"] } };
  const next = { tools: { crow_mcp: ["crow-memory/crow_recall", "gitea__gitea_create_repo", "crow-tasks/x"] }, permission_policy: { confirm: [] } };
  assert.equal(keepSatelliteGrants(next, orig, { bundleIds: IDS }), true);
  assert.deepEqual([...next.tools.crow_mcp].sort(), ["crow-memory/crow_recall", "crow-tasks/x", "gitea/gitea_list_repos"]);
  assert.deepEqual(next.permission_policy.confirm, ["gitea/gitea_create_repo"], "a removed ask-first entry is put back");
});

test("keepSatelliteGrants fails closed: an unreadable bundle list puts the whole grant and ask lists back", () => {
  const orig = { tools: { crow_mcp: ["crow-memory/crow_recall"] }, permission_policy: { confirm: ["x/y"] } };
  const next = { tools: { crow_mcp: ["crow-memory/crow_recall", "gitea/gitea_create_repo"] }, permission_policy: { confirm: [] } };
  assert.equal(keepSatelliteGrants(next, orig, { readIds: () => { throw new Error("installed.json unreadable"); } }), true);
  assert.deepEqual(next.tools.crow_mcp, ["crow-memory/crow_recall"]);
  assert.deepEqual(next.permission_policy.confirm, ["x/y"]);
});

test("a peer's SSO session saving the LEGACY Tools tab never adds a satellite grant", async () => {
  installSatellite();
  await setDef({ tools: { crow_mcp: ["crow-memory/crow_recall"], pi_builtin: ["read"] }, permission_policy: {} });
  const res = await post({ action: "save_tools", tab: "tools", builtin_read: "on", crow_mcp: ["crow-memory/crow_recall", "gitea/gitea_create_repo"] }, SSO_SESS);
  assert.ok(res.redirected, "the save answered");
  assert.ok(!(await defNow()).tools.crow_mcp.includes("gitea/gitea_create_repo"), "the satellite grant did not land");
  // The owner's own session can.
  await post({ action: "save_tools", tab: "tools", builtin_read: "on", crow_mcp: ["crow-memory/crow_recall", "gitea/gitea_create_repo"] }, OWNER_SESS);
  assert.ok((await defNow()).tools.crow_mcp.includes("gitea/gitea_create_repo"), "the owner's save lands");
});

test("a signed peer's patch of a peer-managed bot cannot add or remove a satellite grant", () => {
  installSatellite();
  const current = { tools: { crow_mcp: ["crow-memory/crow_recall", "gitea/gitea_list_repos"] }, permission_policy: {} };
  const out = applyPeerPatch(current, { "tools.crow_mcp": ["crow-memory/crow_recall", "gitea/gitea_create_repo", "gitea__gitea_delete_repo"] });
  assert.deepEqual([...out.tools.crow_mcp].sort(), ["crow-memory/crow_recall", "gitea/gitea_list_repos"]);
});

test("a bundle that becomes satellite-hosted starts with no bot grants", async () => {
  await setDef({ tools: { crow_mcp: ["crow-memory/crow_recall", "gitea/gitea_create_repo", "gitea__gitea_list_repos", "gitea"] }, permission_policy: { confirm: ["gitea/gitea_create_repo"] } });
  const changed = await stripBotGrantsForBundle(db, "gitea");
  assert.deepEqual(changed, [BOT]);
  const def = await defNow();
  assert.deepEqual(def.tools.crow_mcp, ["crow-memory/crow_recall"]);
  assert.deepEqual(def.permission_policy.confirm, ["gitea/gitea_create_repo"], "asking first is kept (never wider)");
});
