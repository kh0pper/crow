/**
 * Project service connections (project services Task 7): the store, its status and authority.
 * Scratch DB built by init-db, scratch keychain key; never touches ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-svcconn-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createDbClient } = await import("../servers/db.js");
const S = await import("../servers/shared/service-connections.js");
const K = await import("../servers/gateway/keychain/store.js");
const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");

const TOKEN_1 = "test-token-1";
const TOKEN_2 = "test-token-2";
const TOKEN_3 = "test-token-3";
const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "crow-svcconn-db-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const db = createDbClient(join(dir, "crow.db"));
  const ids = {};
  for (const slug of ["home", "spring"]) {
    const r = await db.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, ?) RETURNING id", args: [slug, slug[0].toUpperCase() + slug.slice(1)] });
    ids[slug] = Number(r.rows[0].id);
  }
  const key = createKeychainKey({ crowHome: mkdtempSync(join(tmpdir(), "crow-svcconn-home-")) });
  return { db, key, ids };
}

const gh = (ctx, label, extra = {}, opts = {}) =>
  S.createConnection(ctx.db, { projectId: ctx.ids.spring, serviceId: "github", accountLabel: label, secrets: { [GH]: TOKEN_1 }, ...extra }, { key: ctx.key, ...opts });

async function rejectsWith(p, code) {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof S.ConnectionError, `expected ConnectionError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  });
}

const rowsOf = async (db, sql = "SELECT * FROM service_connections ORDER BY id") => (await db.execute(sql)).rows;

test("connect and read", async () => {
  const ctx = await fresh();
  const c = await gh(ctx, "Main");
  assert.equal(c.blockName, "github-main");
  assert.equal(c.labelSlug, "main");
  assert.equal(c.accountLabel, "Main");
  assert.equal(c.serviceId, "github");
  assert.equal(c.bundleId, "github");
  assert.equal(c.method, "token");
  assert.equal(c.status, "active");
  assert.equal(c.lastError, null);
  assert.equal(c.projectId, ctx.ids.spring);
  assert.equal(c.ownerContactId, null);
  assert.match(c.uuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(c.config, {});
  assert.deepEqual(Object.keys(c).sort(), ["accountLabel", "blockName", "bundleId", "config", "createdAt", "id", "labelSlug", "lastError", "lastTestedAt", "method", "ownerContactId", "projectId", "serviceId", "sourceConnectionId", "status", "updatedAt", "uuid"]);
  assert.ok(!JSON.stringify(c).includes(TOKEN_1), "a Connection never holds a secret");
  assert.ok(!JSON.stringify(await rowsOf(ctx.db)).includes(TOKEN_1), "the row never holds a secret");
  assert.deepEqual(await S.getConnection(ctx.db, c.uuid), c);
  assert.deepEqual(await K.serviceSecretsFor(ctx.db, ctx.key, c.uuid, { allowedKeys: [GH] }), { [GH]: TOKEN_1 });

  assert.deepEqual((await S.connectionsFor(ctx.db, { projectId: ctx.ids.spring })).map((x) => x.uuid), [c.uuid]);
  assert.deepEqual(await S.connectionsFor(ctx.db, { projectId: ctx.ids.home }), []);
  assert.deepEqual(await S.connectionsFor(ctx.db, { projectId: null }), []);
  assert.deepEqual(await S.otherProjectServiceIds(ctx.db, ctx.ids.home), ["github"]);
  assert.deepEqual(await S.otherProjectServiceIds(ctx.db, ctx.ids.spring), []);
});

test("config holds only non-secret fields; secret in config or unknown fields refused", async () => {
  const ctx = await fresh();
  const z = await S.createConnection(ctx.db, { projectId: ctx.ids.home, serviceId: "zotero", accountLabel: "Library", config: { ZOTERO_USER_ID: "12345" }, secrets: { ZOTERO_API_KEY: TOKEN_2 } }, { key: ctx.key });
  assert.deepEqual(z.config, { ZOTERO_USER_ID: "12345" });
  assert.ok(!JSON.stringify(z).includes(TOKEN_2));
  await rejectsWith(S.createConnection(ctx.db, { projectId: ctx.ids.home, serviceId: "zotero", accountLabel: "B", config: { ZOTERO_USER_ID: "1", ZOTERO_API_KEY: TOKEN_2 } }, { key: ctx.key }), "bad_value");
  await rejectsWith(S.createConnection(ctx.db, { projectId: ctx.ids.home, serviceId: "zotero", accountLabel: "B", config: { ZOTERO_USER_ID: "1" }, secrets: { ZOTERO_API_KEY: TOKEN_2, OTHER: "x" } }, { key: ctx.key }), "bad_value");
  await rejectsWith(S.createConnection(ctx.db, { projectId: ctx.ids.home, serviceId: "zotero", accountLabel: "B", config: {}, secrets: { ZOTERO_API_KEY: TOKEN_2 } }, { key: ctx.key }), "missing_field");
  await rejectsWith(gh(ctx, "NoSecret", { secrets: {} }), "missing_field");
  await rejectsWith(gh(ctx, "   "), "missing_field");
  await rejectsWith(gh(ctx, 42), "bad_value");
  assert.equal((await rowsOf(ctx.db)).length, 1, "refusals write nothing");
});

test("unknown service, toggle service, missing project refused", async () => {
  const ctx = await fresh();
  await rejectsWith(S.createConnection(ctx.db, { projectId: ctx.ids.spring, serviceId: "nope", accountLabel: "A" }, { key: ctx.key }), "unknown_service");
  await rejectsWith(S.createConnection(ctx.db, { projectId: ctx.ids.spring, serviceId: "arxiv", accountLabel: "A" }, { key: ctx.key }), "unknown_service");
  await rejectsWith(gh(ctx, "A", { projectId: 9999 }), "unknown_project");
  await rejectsWith(gh(ctx, "A", { projectId: "spring" }), "bad_value");
});

test("label slug collision refused", async () => {
  const ctx = await fresh();
  const main = await gh(ctx, "Main");
  await rejectsWith(gh(ctx, "main!"), "label_taken");
  await rejectsWith(S.checkLabelFree(ctx.db, { projectId: ctx.ids.spring, serviceId: "github", accountLabel: "MAIN" }), "label_taken");
  const personal = await gh(ctx, "Personal");
  assert.equal(personal.blockName, "github-personal");
  // Same label, other project: free.
  await gh(ctx, "Main", { projectId: ctx.ids.home });
  await S.disconnectConnection(ctx.db, main.uuid);
  await S.checkLabelFree(ctx.db, { projectId: ctx.ids.spring, serviceId: "github", accountLabel: "main" });
  const again = await gh(ctx, "main");
  assert.equal(again.blockName, "github-main");
  assert.notEqual(again.uuid, main.uuid);
});

test("slug cases: labels with no ascii slug share 'account'; accents fold; long labels cap", async () => {
  const ctx = await fresh();
  const a = await gh(ctx, "!!!");
  assert.equal(a.blockName, "github-account");
  await rejectsWith(gh(ctx, "???"), "label_taken");
  const b = await gh(ctx, "Café Équipe");
  assert.equal(b.labelSlug, "cafe-equipe");
  await rejectsWith(gh(ctx, "cafe equipe"), "label_taken");
  const c = await gh(ctx, "A very long account label indeed");
  assert.ok(c.labelSlug.length <= 16);
  assert.equal(c.accountLabel, "A very long account label indeed");
});

test("concurrent labels: Work and work! raced resolve to one row and one label_taken", async () => {
  const ctx = await fresh();
  const results = await Promise.allSettled([gh(ctx, "Work"), gh(ctx, "work!")]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.ok(bad[0].reason instanceof S.ConnectionError);
  assert.equal(bad[0].reason.code, "label_taken");
  const live = await rowsOf(ctx.db, "SELECT * FROM service_connections WHERE status != 'disconnected'");
  assert.equal(live.length, 1);
  assert.equal(live[0].label_slug, "work");
});

test("the slug index alone refuses a raced insert (mapped to label_taken)", async () => {
  const ctx = await fresh();
  await gh(ctx, "Work");
  // Bypass checkLabelFree: a real race passes it before either insert lands.
  const raw = {
    execute: (q) => (typeof q === "object" && /FROM service_connections\s+WHERE project_id = \? AND owner_contact_id IS NULL/.test(q.sql) ? Promise.resolve({ rows: [] }) : ctx.db.execute(q)),
  };
  await rejectsWith(gh({ ...ctx, db: raw }, "work!"), "label_taken");
});

test("reserved name: a label whose block name is a reserved Crow server name is label_taken", async () => {
  const ctx = await fresh();
  const reg = JSON.parse(readFileSync(join(REPO, "registry/add-ons.json"), "utf8"));
  const list = [...(reg["add-ons"] || reg), { id: "google-workspace", name: "Google Workspace", connect: { method: "token", group: "paste", fields: [{ name: "GW_TOKEN", kind: "secret" }] } }];
  const reserved = S.RESERVED_BLOCK_NAMES(["crow-memory", "google-workspace"], ["google-workspace-alex", "brave-search"]);
  assert.ok(reserved instanceof Set);
  assert.deepEqual([...reserved].sort(), ["brave-search", "crow-memory", "google-workspace", "google-workspace-alex"]);
  await rejectsWith(S.checkLabelFree(ctx.db, { projectId: ctx.ids.home, serviceId: "google-workspace", accountLabel: "alex", reservedNames: reserved }), "label_taken");
  await rejectsWith(
    S.createConnection(ctx.db, { projectId: ctx.ids.home, serviceId: "google-workspace", accountLabel: "Alex", secrets: { GW_TOKEN: TOKEN_1 } }, { key: ctx.key, reservedNames: reserved, registry: list }),
    "label_taken",
  );
  const ok = await S.createConnection(ctx.db, { projectId: ctx.ids.home, serviceId: "google-workspace", accountLabel: "Work", secrets: { GW_TOKEN: TOKEN_1 } }, { key: ctx.key, reservedNames: reserved, registry: list });
  assert.equal(ok.blockName, "google-workspace-work");
  assert.deepEqual(S.RESERVED_BLOCK_NAMES(), new Set());
});

test("two accounts one service", async () => {
  const ctx = await fresh();
  const a = await gh(ctx, "Work");
  const b = await gh(ctx, "Personal", { secrets: { [GH]: TOKEN_2 } });
  const list = await S.connectionsFor(ctx.db, { projectId: ctx.ids.spring, serviceId: "github" });
  assert.deepEqual(list.map((c) => c.blockName), ["github-personal", "github-work"]);
  assert.equal((await K.serviceSecretsFor(ctx.db, ctx.key, a.uuid, { allowedKeys: [GH] }))[GH], TOKEN_1);
  assert.equal((await K.serviceSecretsFor(ctx.db, ctx.key, b.uuid, { allowedKeys: [GH] }))[GH], TOKEN_2);
});

test("archived project refused", async () => {
  const ctx = await fresh();
  await ctx.db.execute({ sql: "UPDATE project_spaces SET status = 'archived' WHERE id = ?", args: [ctx.ids.home] });
  await rejectsWith(gh(ctx, "Main", { projectId: ctx.ids.home }), "unknown_project");
  await ctx.db.execute({ sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?", args: [ctx.ids.spring] });
  await rejectsWith(gh(ctx, "Main"), "unknown_project");
  assert.equal((await rowsOf(ctx.db)).length, 0);
});

test("not active until secrets saved (M8): a throwing saveServiceSecret leaves an error row", async () => {
  const ctx = await fresh();
  let calls = 0;
  const failing = async () => { calls++; throw new Error("disk full"); };
  await assert.rejects(gh(ctx, "Main", {}, { saveServiceSecret: failing }), /disk full/);
  assert.equal(calls, 1);
  const rows = await rowsOf(ctx.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "error");
  assert.equal(rows[0].last_error, "child_unavailable");
  assert.deepEqual(await S.connectionsFor(ctx.db, { projectId: ctx.ids.spring }), []);
  // The stub sees the row in 'error' when it runs (the insert came first).
  let seen;
  const peek = async (db, _key, { connectionUuid }) => { seen = (await S.getConnection(db, connectionUuid)).status; throw new Error("stop"); };
  await assert.rejects(gh(ctx, "Other", {}, { saveServiceSecret: peek }), /stop/);
  assert.equal(seen, "error");
  // No key: refused before anything is written.
  await assert.rejects(gh(ctx, "Third", {}, { key: null }), (e) => e.code === "KEYCHAIN_KEY_MISSING");
  assert.equal((await rowsOf(ctx.db)).length, 2);
});

test("null owner: contact-owned rows are refused on create and never served to bots", async () => {
  const ctx = await fresh();
  await rejectsWith(gh(ctx, "Main", { ownerContactId: 5 }), "bad_value");
  await ctx.db.execute({
    sql: "INSERT INTO service_connections (uuid, project_id, owner_contact_id, service_id, bundle_id, method, account_label, label_slug, status) VALUES ('u-contact', ?, 5, 'github', 'github', 'token', 'Main', 'main', 'active')",
    args: [ctx.ids.spring],
  });
  // The local user's "Main" is not blocked by a contact's (IFNULL owner in the slug index).
  const mine = await gh(ctx, "Main");
  assert.deepEqual((await S.connectionsFor(ctx.db, { projectId: ctx.ids.spring })).map((c) => c.uuid), [mine.uuid]);
  assert.equal((await S.listConnections(ctx.db, { projectId: ctx.ids.spring })).length, 2);
  assert.equal((await S.listConnections(ctx.db, { projectId: ctx.ids.spring, ownerContactId: null })).length, 1);
  // Two local-owner (NULL) rows with one slug cannot coexist even bypassing the store.
  await assert.rejects(ctx.db.execute({
    sql: "INSERT INTO service_connections (uuid, project_id, service_id, method, account_label, label_slug) VALUES ('u-dup', ?, 'github', 'token', 'main', 'main')",
    args: [ctx.ids.spring],
  }), /UNIQUE/);
});

test("status", async () => {
  const ctx = await fresh();
  const c = await gh(ctx, "Main");
  assert.deepEqual(S.connectionDisplayStatus(c, { installed: true }), { status: "not_tested", labelKey: "services.status.not_tested" });
  const failed = await S.recordTest(ctx.db, c.uuid, { ok: false, error: "auth_failed", now: new Date("2026-10-01T00:00:00Z") });
  assert.equal(failed.status, "error");
  assert.equal(failed.lastError, "auth_failed");
  assert.equal(failed.lastTestedAt, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(S.connectionDisplayStatus(failed, { installed: true }), { status: "error", labelKey: "services.status.error" });
  assert.deepEqual(S.connectionDisplayStatus(failed, { installed: false }), { status: "needs_install", labelKey: "services.status.needs_install" });
  const fixed = await S.recordTest(ctx.db, c.uuid, { ok: true });
  assert.equal(fixed.status, "active");
  assert.equal(fixed.lastError, null);
  assert.deepEqual(S.connectionDisplayStatus(fixed, { installed: true }), { status: "active", labelKey: "services.status.active" });
  const odd = await S.recordTest(ctx.db, c.uuid, { ok: false, error: "Error: 401 token xyz" });
  assert.equal(odd.lastError, "unexpected_response", "free text never stored");
  const child = await S.recordChildFailure(ctx.db, c.uuid);
  assert.equal(child.status, "error");
  assert.equal(child.lastError, "child_unavailable");
  const tested = await gh(ctx, "Tested", { testedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(tested.lastTestedAt, "2026-10-02T00:00:00.000Z");
  assert.equal(S.connectionDisplayStatus(tested, { installed: true }).status, "active");
});

test("disconnect deletes secrets and audits without secret text", async () => {
  const ctx = await fresh();
  const c = await gh(ctx, "Main", { secrets: { [GH]: TOKEN_3 } });
  const d = await S.disconnectConnection(ctx.db, c.uuid);
  assert.equal(d.status, "disconnected");
  assert.deepEqual(await K.serviceSecretsFor(ctx.db, ctx.key, c.uuid, { allowedKeys: [GH] }), {});
  assert.equal((await K.serviceSecretKeys(ctx.db, c.uuid)).size, 0);
  assert.deepEqual(await S.connectionsFor(ctx.db, { projectId: ctx.ids.spring }), []);
  assert.equal((await S.listConnections(ctx.db, { projectId: ctx.ids.spring })).length, 0);
  assert.equal((await S.listConnections(ctx.db, { projectId: ctx.ids.spring, includeDisconnected: true })).length, 1);
  const audit = await rowsOf(ctx.db, "SELECT * FROM project_audit_log WHERE action LIKE 'service.%' ORDER BY id");
  assert.deepEqual(audit.map((r) => [r.action, r.target, r.actor_type, Number(r.project_id)]), [
    ["service.connect", c.uuid, "local", ctx.ids.spring],
    ["service.disconnect", c.uuid, "local", ctx.ids.spring],
  ]);
  assert.deepEqual(JSON.parse(audit[0].payload), { service_id: "github" });
  assert.ok(!JSON.stringify(audit).includes(TOKEN_3));
  await rejectsWith(S.disconnectConnection(ctx.db, "no-such-uuid"), "not_found");
});

test("uninstall round trip", async () => {
  const ctx = await fresh();
  const c = await gh(ctx, "Main");
  const broken = await gh(ctx, "Broken");
  await S.recordTest(ctx.db, broken.uuid, { ok: false, error: "auth_failed" });
  const affected = await S.markConnectionsNeedInstall(ctx.db, "github");
  assert.deepEqual(affected, [{ projectId: ctx.ids.spring, slug: "spring", name: "Spring" }]);
  assert.equal((await S.getConnection(ctx.db, c.uuid)).status, "needs_install");
  assert.deepEqual(await S.connectionsFor(ctx.db, { projectId: ctx.ids.spring }), []);
  await rejectsWith(gh(ctx, "main"), "label_taken");
  assert.equal(await S.restoreConnectionsAfterInstall(ctx.db, "github"), 2);
  assert.equal((await S.getConnection(ctx.db, c.uuid)).status, "active");
  assert.equal((await S.getConnection(ctx.db, broken.uuid)).status, "error", "an error row comes back as error");
  assert.deepEqual(await S.markConnectionsNeedInstall(ctx.db, "brave-search"), []);
});

test("authority", async () => {
  const ctx = await fresh();
  assert.deepEqual(await S.connectionAuthority(ctx.db, "github"), { kind: "self" });
});

test("ConnectionError takes only the plan's error classes", () => {
  assert.equal(new S.ConnectionError("label_taken").code, "label_taken");
  assert.throws(() => new S.ConnectionError("key_missing"), TypeError);
});
