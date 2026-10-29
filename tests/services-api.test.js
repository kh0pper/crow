/**
 * The project Services JSON API (project services Task 9). Ephemeral app, a stub session gate, a
 * fake Connect and test, a scratch DB built by init-db and a scratch Crow home (keychain key,
 * masking hash list): never ~/.crow, never ~/.pi (reserved names are injected).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "crow-svcapi-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_SERVICES_UI;
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createDbClient } = await import("../servers/db.js");
const { servicesApiRouter, loadServicesPage } = await import("../servers/gateway/routes/services-api.js");
const { servicesUiEnabled } = await import("../servers/gateway/services/ui-flag.js");
const { serviceSecretsFor } = await import("../servers/gateway/keychain/store.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const SV = await import("../servers/shared/secret-values.js");
const { collectSecretValueSets } = await import("../servers/shared/secret-values-collect.js");

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const CANARY = "canary-7f3a9";
const COOKIE = "crow_session=s1; crow_csrf=tok9";
const AUTH = { cookie: COOKIE, "x-crow-csrf": "tok9" };

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-svcapi-db-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const path = join(dir, "crow.db");
  const db = createDbClient(path);
  const ids = {};
  for (const slug of ["home", "spring"]) {
    const r = await db.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, ?) RETURNING id", args: [slug, slug[0].toUpperCase() + slug.slice(1)] });
    ids[slug] = Number(r.rows[0].id);
  }
  return { db, path, dir, ids };
}

const stubGate = (req, res, next) => {
  if (!String(req.headers.cookie || "").includes("crow_session=s1")) return res.status(401).json({ error: "Not authenticated" });
  req.dashboardSession = "s1";
  next();
};

function fakeTest(result = { ok: true }) {
  const f = async (service, opts) => { f.calls.push({ service: service.id, values: opts.values }); return typeof f.result === "function" ? f.result(service, opts) : f.result; };
  f.calls = [];
  f.result = result;
  return f;
}

async function startApp(ctx, opts = {}) {
  const app = express();
  // The gateway's global parser skips this prefix (index.js _hasOwnParser): none here either.
  app.use(servicesApiRouter({
    dbFactory: () => createDbClient(ctx.path),
    sessionGate: stubGate,
    testConnection: ctx.test,
    installedIds: () => new Set(ctx.installed || ["github"]),
    uiEnabled: () => true,
    crowHome: HOME,
    reservedNames: () => new Set(["github-reserved"]),
    ...opts,
  }));
  return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}

function call(server, method, path, { body, raw, headers = {} } = {}) {
  const payload = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server.address().port, path, method,
      headers: { ...(payload != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json }); });
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function withApp(ctx, fn, opts) {
  const s = await startApp(ctx, opts);
  try { return await fn(s); } finally { s.close(); }
}

/** Capture console.log/warn/error while fn runs. */
async function capture(fn) {
  const out = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { out.push(a.map(String).join(" ")); };
  try { return { result: await fn(), out }; } finally { Object.assign(console, orig); }
}

const connectGh = (s, label = "Main", token = "test-token-1") =>
  call(s, "POST", "/dashboard/services/api/project/spring/connect", { body: { serviceId: "github", accountLabel: label, values: { [GH]: token } }, headers: AUTH });

test("servicesUiEnabled: on only for CROW_SERVICES_UI=1", () => {
  assert.equal(servicesUiEnabled({}), false);
  assert.equal(servicesUiEnabled({ CROW_SERVICES_UI: "0" }), false);
  assert.equal(servicesUiEnabled({ CROW_SERVICES_UI: "true" }), false);
  assert.equal(servicesUiEnabled({ CROW_SERVICES_UI: "1" }), true);
});

test("flag off hides it: every route 404s (the default flag reads CROW_SERVICES_UI, unset here)", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  for (const opts of [{ uiEnabled: () => false }, { uiEnabled: undefined }]) {
    await withApp(ctx, async (s) => {
      const uuid = "00000000-0000-4000-8000-000000000001";
      for (const [m, p] of [["GET", "/dashboard/services/api/project/spring"], ["POST", "/dashboard/services/api/project/spring/connect"],
        ["POST", `/dashboard/services/api/connection/${uuid}/test`], ["POST", `/dashboard/services/api/connection/${uuid}/disconnect`]]) {
        const r = await call(s, m, p, { body: m === "POST" ? { serviceId: "github" } : undefined, headers: AUTH });
        assert.equal(r.status, 404, `${m} ${p}`);
      }
    }, opts);
  }
  assert.equal(ctx.test.calls.length, 0);
});

test("no session refused; csrf required; a peer-signed request refused", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    assert.equal((await call(s, "GET", "/dashboard/services/api/project/spring")).status, 401);
    const body = { serviceId: "github", accountLabel: "Main", values: { [GH]: "test-token-1" } };
    assert.equal((await call(s, "POST", "/dashboard/services/api/project/spring/connect", { body })).status, 401);
    assert.equal((await call(s, "POST", "/dashboard/services/api/project/spring/connect", { body, headers: { cookie: COOKIE } })).status, 403, "no CSRF header");
    assert.equal((await call(s, "POST", "/dashboard/services/api/project/spring/connect", { body, headers: { cookie: COOKIE, "x-crow-csrf": "other" } })).status, 403);
    assert.equal((await call(s, "GET", "/dashboard/services/api/project/spring", { headers: { cookie: COOKIE, "x-crow-signature": "sig" } })).status, 403);
    assert.equal(ctx.test.calls.length, 0);
    assert.equal((await ctx.db.execute("SELECT COUNT(*) AS n FROM service_connections")).rows[0].n, 0);
  });
});

test("failed test saves nothing; label checked before the test", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest({ ok: false, error: "auth_failed" }) };
  await withApp(ctx, async (s) => {
    const { result: r, out } = await capture(() => connectGh(s, "Main", "test-token-2"));
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "auth_failed" });
    assert.ok(out.includes("[services] connect failed: auth_failed"));
    assert.equal(ctx.test.calls.length, 1);
    assert.equal((await ctx.db.execute("SELECT COUNT(*) AS n FROM service_connections")).rows[0].n, 0);
    assert.equal((await ctx.db.execute("SELECT COUNT(*) AS n FROM crow_keychain")).rows[0].n, 0);

    ctx.test.result = { ok: true };
    assert.equal((await connectGh(s, "Work")).status, 201);
    const before = ctx.test.calls.length;
    const taken = await connectGh(s, "work!");
    assert.equal(taken.status, 400);
    assert.deepEqual(taken.json, { error: "label_taken" });
    const reserved = await connectGh(s, "Reserved");
    assert.deepEqual(reserved.json, { error: "label_taken" }, "a reserved block name (computed server-side)");
    assert.equal(ctx.test.calls.length, before, "the test was never called for a taken label");
  });
});

test("validation before the test: missing field, bad value, unknown and toggle service, not installed, unknown project", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    const post = (slug, body) => call(s, "POST", `/dashboard/services/api/project/${slug}/connect`, { body, headers: AUTH });
    assert.deepEqual((await post("spring", { serviceId: "github", accountLabel: "Main", values: {} })).json, { error: "missing_field", field: GH });
    assert.deepEqual((await post("spring", { serviceId: "github", accountLabel: "Main", values: { [GH]: "  " } })).json, { error: "missing_field", field: GH });
    assert.deepEqual((await post("spring", { serviceId: "github", accountLabel: "Main", values: { [GH]: "a\u0007b" } })).json, { error: "bad_value", field: GH });
    assert.deepEqual((await post("spring", { serviceId: "github", accountLabel: "Main", values: { [GH]: "x".repeat(4097) } })).json, { error: "bad_value", field: GH });
    assert.deepEqual((await post("spring", { serviceId: "github", accountLabel: "Main", values: { [GH]: 7 } })).json, { error: "bad_value", field: GH });
    assert.deepEqual((await post("spring", { serviceId: "github", accountLabel: "Main", values: { [GH]: "t1", OTHER: "x" } })).json, { error: "bad_value" });
    assert.deepEqual((await post("spring", { serviceId: "github", accountLabel: "", values: { [GH]: "t1" } })).json, { error: "missing_field", field: "accountLabel" });
    assert.deepEqual((await post("spring", { serviceId: "nope", accountLabel: "Main", values: {} })).json, { error: "unknown_service" });
    assert.deepEqual((await post("spring", { serviceId: "arxiv", accountLabel: "Main", values: {} })).json, { error: "unknown_service" }, "a toggle service");
    const missing = await post("nowhere", { serviceId: "github", accountLabel: "Main", values: { [GH]: "t1" } });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: "unknown_project" });
    const ha = await post("spring", { serviceId: "home-assistant", accountLabel: "Main", values: { HA_URL: "http://ha.example.lan:8123", HA_TOKEN: "test-token-3" } });
    assert.equal(ha.status, 400);
    assert.deepEqual(ha.json, { error: "not_installed" }, "not installed: HA without home-assistant installed");
    assert.equal(ctx.test.calls.length, 0, "nothing left Crow");
  });
});

test("bad json never logged", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    const { result: r, out } = await capture(() => call(s, "POST", "/dashboard/services/api/project/spring/connect", { raw: `{"values":{"X":"${CANARY}"`, headers: AUTH }));
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "bad_value" });
    assert.ok(!r.text.includes(CANARY));
    assert.ok(!out.join("\n").includes(CANARY), "the parser's message never reaches a log");
    assert.ok(out.includes("[services] bad body"));
    const big = await capture(() => call(s, "POST", "/dashboard/services/api/project/spring/connect", { raw: JSON.stringify({ values: { [GH]: CANARY + "x".repeat(17000) } }), headers: AUTH }));
    assert.equal(big.result.status, 400);
    assert.deepEqual(big.result.json, { error: "bad_value" });
    assert.ok(!big.out.join("\n").includes(CANARY));
    assert.equal(ctx.test.calls.length, 0);
  });
});

test("canary never leaves the keychain (Review Focus 2)", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    const { result, out } = await capture(async () => {
      const c = await call(s, "POST", "/dashboard/services/api/project/spring/connect", { body: { serviceId: "github", accountLabel: "Main", values: { [GH]: CANARY } }, headers: AUTH });
      const g = await call(s, "GET", "/dashboard/services/api/project/spring", { headers: AUTH });
      return { c, g };
    });
    assert.equal(result.c.status, 201);
    assert.equal(result.c.json.ok, true);
    assert.equal(result.g.status, 200);
    for (const r of [result.c, result.g]) assert.ok(!r.text.includes(CANARY), "no response carries it");
    assert.ok(!out.join("\n").includes(CANARY), "no log line carries it");
    assert.equal(ctx.test.calls[0].values[GH], CANARY, "the live test got it");
    const conns = (await ctx.db.execute("SELECT * FROM service_connections")).rows;
    assert.equal(conns.length, 1);
    assert.ok(!JSON.stringify(conns).includes(CANARY));
    const audit = (await ctx.db.execute("SELECT * FROM project_audit_log")).rows;
    assert.ok(audit.some((a) => a.action === "service.connect"));
    assert.ok(!JSON.stringify(audit).includes(CANARY));
    const kc = (await ctx.db.execute("SELECT id, kind, label, bundle_id, env_key, username, url, key_id, origin, status, connection_uuid FROM crow_keychain")).rows;
    assert.ok(!JSON.stringify(kc).includes(CANARY), "keychain columns other than secret_sealed");
    ctx.db.close();
    for (const f of [ctx.path, ctx.path + "-wal", ctx.path + "-shm"]) {
      if (existsSync(f)) assert.ok(!readFileSync(f).includes(Buffer.from(CANARY)), "raw DB bytes: " + f);
    }
    for (const f of [SV.SERVICE_HASHES_FILENAME, SV.CARD_HASHES_FILENAME]) {
      const p = join(HOME, "secrets", f);
      if (existsSync(p)) assert.ok(!readFileSync(p, "utf8").includes(CANARY), f);
    }
    const db = createDbClient(ctx.path);
    try {
      const opened = await serviceSecretsFor(db, loadKeychainKey({ crowHome: HOME }), result.c.json.connection.uuid, { allowedKeys: [GH] });
      assert.deepEqual(opened, { [GH]: CANARY }, "the sealed row opens to it");
    } finally { db.close(); }
  });
});

test("views say set/unset; retest updates status; disconnect is idempotent and hides the row", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    const c = await connectGh(s);
    assert.equal(c.status, 201);
    const conn = c.json.connection;
    assert.deepEqual(Object.keys(conn).sort(), ["accountLabel", "fields", "labelKey", "lastError", "lastTestedAt", "name", "serviceId", "status", "uuid"]);
    assert.equal(conn.status, "active");
    assert.equal(conn.labelKey, "services.status.active");
    assert.ok(conn.lastTestedAt);
    const g = await call(s, "GET", "/dashboard/services/api/project/spring", { headers: AUTH });
    assert.deepEqual(g.json.connections.map((x) => x.fields), [{ [GH]: "set" }]);
    assert.deepEqual(g.json.project, { slug: "spring", name: "Spring" });
    assert.equal(g.json.botsLive, false);

    ctx.test.result = { ok: false, error: "auth_failed" };
    const { result: t, out } = await capture(() => call(s, "POST", `/dashboard/services/api/connection/${conn.uuid}/test`, { headers: AUTH }));
    assert.deepEqual(t.json, { ok: false, status: "error", error: "auth_failed" });
    assert.ok(out.includes("[services] test failed: auth_failed"));
    assert.equal(ctx.test.calls.at(-1).values[GH], "test-token-1", "the retest reads the saved secret");
    ctx.test.result = { ok: true };
    assert.deepEqual((await call(s, "POST", `/dashboard/services/api/connection/${conn.uuid}/test`, { headers: AUTH })).json, { ok: true, status: "active" });
    ctx.test.result = { ok: false, error: "made-up message from upstream" };
    assert.deepEqual((await call(s, "POST", `/dashboard/services/api/connection/${conn.uuid}/test`, { headers: AUTH })).json,
      { ok: false, status: "error", error: "unexpected_response" }, "never a class outside the list");

    for (let i = 0; i < 2; i++) {
      const d = await call(s, "POST", `/dashboard/services/api/connection/${conn.uuid}/disconnect`, { headers: AUTH });
      assert.equal(d.status, 200);
      assert.deepEqual(d.json, { ok: true });
    }
    const audits = (await ctx.db.execute("SELECT action FROM project_audit_log WHERE action = 'service.disconnect'")).rows;
    assert.equal(audits.length, 1, "one audit row");
    const after = await call(s, "GET", "/dashboard/services/api/project/spring", { headers: AUTH });
    assert.deepEqual(after.json.connections, [], "reads are active-only");
    assert.equal((await call(s, "POST", `/dashboard/services/api/connection/${conn.uuid}/test`, { headers: AUTH })).status, 404);
    assert.equal((await call(s, "POST", "/dashboard/services/api/connection/00000000-0000-4000-8000-0000000000ff/disconnect", { headers: AUTH })).status, 404);
    assert.equal((await call(s, "POST", "/dashboard/services/api/connection/not-a-uuid/disconnect", { headers: AUTH })).status, 404);
    // The label is free again once disconnected.
    ctx.test.result = { ok: true };
    assert.equal((await connectGh(s)).status, 201);
  });
});

test("(e) masking, connect write path: the saved secret's hash is recorded and the value joins the display and gateway card sets; disconnect keeps the hash", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  const TOKEN = "fakeHaTok3n" + ".sec0nd-Part9" + ".connectPath1";
  await withApp(ctx, async (s) => {
    const c = await connectGh(s, "Masked", TOKEN);
    assert.equal(c.status, 201);
    assert.ok(SV.readServiceHashes({ ...process.env, CROW_HOME: HOME }).has(SV.cardHashOf(TOKEN)));
    const sets = collectSecretValueSets({ env: { ...process.env, CROW_HOME: HOME, CROW_DATA_DIR: ctx.dir }, dbPath: ctx.path });
    assert.ok(sets.display.includes(TOKEN), "display (logs, notifications, transcripts)");
    assert.ok(sets.service.includes(TOKEN), "the gateway's approval-card mask");
    assert.equal(sets.card.includes(TOKEN), false, "never the set pi is handed");
    SV.invalidateSecretValues();
    assert.ok(SV.getSecretValues().includes(TOKEN), "this gateway masks it at once");
    await call(s, "POST", `/dashboard/services/api/connection/${c.json.connection.uuid}/disconnect`, { headers: AUTH });
    assert.ok(SV.readServiceHashes({ ...process.env, CROW_HOME: HOME }).has(SV.cardHashOf(TOKEN)), "disconnect keeps the hash");
  });
  SV.primeSecretValues([], []);
});

test("a recordSecrets seam is called with the secret values only, before the save", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  const seen = [];
  await withApp(ctx, async (s) => {
    assert.equal((await connectGh(s, "Seam", "test-token-4")).status, 201);
  }, { recordSecrets: (v) => seen.push(v) });
  assert.deepEqual(seen, [["test-token-4"]]);
});

test("folder: stored as its real path; a folder test that refuses saves nothing", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest(), installed: ["obsidian"] };
  const root = mkdtempSync(join(tmpdir(), "crow-svcapi-vault-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  await withApp(ctx, async (s) => {
    const typed = join(root, ".", "vault") + "/";
    const r = await call(s, "POST", "/dashboard/services/api/project/spring/connect", { body: { serviceId: "obsidian", accountLabel: "Notes", values: { OBSIDIAN_VAULT_PATH: typed } }, headers: AUTH });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json.connection.fields, { OBSIDIAN_VAULT_PATH: "set" });
    const row = (await ctx.db.execute("SELECT config FROM service_connections")).rows[0];
    assert.equal(JSON.parse(row.config).OBSIDIAN_VAULT_PATH, vault);
    ctx.test.result = { ok: false, error: "not_a_vault" };
    const bad = await call(s, "POST", "/dashboard/services/api/project/spring/connect", { body: { serviceId: "obsidian", accountLabel: "Other", values: { OBSIDIAN_VAULT_PATH: root } }, headers: AUTH });
    assert.deepEqual(bad.json, { error: "not_a_vault" });
    assert.equal((await ctx.db.execute("SELECT COUNT(*) AS n FROM service_connections")).rows[0].n, 1);
  });
});

test("an address is stored normalized", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest(), installed: ["home-assistant"] };
  await withApp(ctx, async (s) => {
    const r = await call(s, "POST", "/dashboard/services/api/project/spring/connect",
      { body: { serviceId: "home-assistant", accountLabel: "House", values: { HA_URL: " http://ha.example.lan:8123/ ", HA_TOKEN: "test-token-5" } }, headers: AUTH });
    assert.equal(r.status, 201, r.text);
    assert.equal(ctx.test.calls[0].values.HA_URL, "http://ha.example.lan:8123");
    assert.equal(JSON.parse((await ctx.db.execute("SELECT config FROM service_connections")).rows[0].config).HA_URL, "http://ha.example.lan:8123");
    const bad = await call(s, "POST", "/dashboard/services/api/project/spring/connect",
      { body: { serviceId: "home-assistant", accountLabel: "Bad", values: { HA_URL: "javascript:alert(1)", HA_TOKEN: "test-token-5" } }, headers: AUTH });
    assert.deepEqual(bad.json, { error: "bad_address", field: "HA_URL" });
  });
});

test("loadServicesPage: groups (no toggles), installed, members, also on your Crow, unknown slug", async () => {
  const ctx = await freshDb();
  const S = await import("../servers/shared/service-connections.js");
  const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
  const key = createKeychainKey({ crowHome: mkdtempSync(join(tmpdir(), "crow-svcapi-k-")) });
  await S.createConnection(ctx.db, { projectId: ctx.ids.home, serviceId: "trello", accountLabel: "Main", secrets: { TRELLO_API_KEY: "test-token-6", TRELLO_TOKEN: "test-token-7" } }, { key });
  let page = await loadServicesPage(ctx.db, "spring", { installedIds: new Set(["github"]) });
  assert.deepEqual(page.alsoOnCrow, [{ serviceId: "trello", name: page.alsoOnCrow[0].name }]);
  assert.equal(page.hasMembers, false);
  assert.deepEqual(Object.keys(page.groups), ["network", "signin", "paste", "builtin"]);
  const all = Object.values(page.groups).flat();
  assert.ok(!all.some((g) => g.serviceId === "arxiv"), "a toggle is not offered as a connection");
  const gh = page.groups.paste.find((g) => g.serviceId === "github");
  assert.equal(gh.installed, true);
  assert.deepEqual(gh.fields, [{ name: GH, kind: "secret", labelKey: "services.field." + GH, helpKey: null }]);
  assert.equal(gh.steps.length, 3);
  const ha = page.groups.network.find((g) => g.serviceId === "home-assistant");
  assert.equal(ha.installed, false);
  assert.ok(ha.stepLinks["services.steps.home-assistant.1"]);
  const contact = (await ctx.db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('npub1testmember', 'second user', 'ed-test', 'secp-test') RETURNING id", args: [] })).rows[0];
  await ctx.db.execute({ sql: "INSERT INTO project_members (project_id, contact_id, role, revoked_at) VALUES (?, ?, 'editor', datetime('now'))", args: [ctx.ids.spring, contact.id] });
  assert.equal((await loadServicesPage(ctx.db, "spring", {})).hasMembers, false, "a revoked member does not count");
  await ctx.db.execute({ sql: "INSERT INTO project_members (project_id, contact_id, role) VALUES (?, ?, 'editor')", args: [ctx.ids.spring, contact.id] });
  assert.equal((await loadServicesPage(ctx.db, "spring", {})).hasMembers, true);
  page = await loadServicesPage(ctx.db, "home", {});
  assert.deepEqual(page.alsoOnCrow, [], "a service connected here is not 'also' here");
  assert.equal(page.connections[0].status, "needs_install", "not installed reads as Extension removed");
  assert.equal(await loadServicesPage(ctx.db, "nowhere", {}), null);
  await ctx.db.execute({ sql: "UPDATE project_spaces SET status = 'archived' WHERE slug = 'home'", args: [] });
  assert.equal(await loadServicesPage(ctx.db, "home", {}), null, "an archived project is unknown");
});

test("a keychain key fault answers 500 with no class and a fixed log line", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  const empty = mkdtempSync(join(tmpdir(), "crow-svcapi-nokey-"));
  await withApp(ctx, async (s) => {
    const c = await connectGh(s, "Main", "test-token-8");
    assert.equal(c.status, 201);
    // The retest on a host whose key file is gone (a crow.db restored without it).
    const s2 = await startApp(ctx, { crowHome: empty });
    try {
      const { result: r, out } = await capture(() => call(s2, "POST", `/dashboard/services/api/connection/${c.json.connection.uuid}/test`, { headers: AUTH }));
      assert.equal(r.status, 500);
      assert.deepEqual(r.json, { ok: false });
      assert.ok(out.includes("[services] keychain key unavailable"));
    } finally { s2.close(); }
  });
});

test("the gateway's global body parser skips this prefix (case-insensitively)", () => {
  const src = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const m = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(src);
  assert.ok(m, "the predicate is where it was");
  const skip = new Function("p", `return ${m[1]};`);
  for (const p of ["/dashboard/services/api/project/home/connect", "/DASHBOARD/Services/API/project/home/connect"]) assert.equal(skip(p), true, p);
  for (const p of ["/dashboard/services", "/dashboard/keychain/api/add"]) assert.equal(skip(p), false, p);
});
