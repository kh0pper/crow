/**
 * The saved service key, remembered once and reused per project ("Use saved key"). Ephemeral app,
 * a scratch DB built by init-db and a scratch Crow home (keychain key, masking hashes, bindings):
 * never ~/.crow, never ~/.pi.
 *
 * What it holds: a typed connect saves the service's key for the whole Crow (keychain kind
 * 'extension'), first typed key wins, and a later project connects it with one click instead of
 * retyping it. No value leaves Crow on that path, and none is synced.
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

const HOME = mkdtempSync(join(tmpdir(), "crow-savedkey-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = join(HOME, "data");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_SERVICES_UI;
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createDbClient } = await import("../servers/db.js");
const { servicesApiRouter, loadServicesPage } = await import("../servers/gateway/routes/services-api.js");
const K = await import("../servers/gateway/keychain/store.js");
const { loadKeychainKey } = await import("../servers/gateway/keychain/key.js");
const { serviceCatalog, serviceById } = await import("../servers/shared/service-catalog.js");
const { savedKeyServiceIds, rememberTypedKeys, isOneClickEligible } = await import("../servers/gateway/services/saved-key.js");
const SENS = await import("../servers/shared/service-sensitivity.js");
const SVC = await import("../servers/shared/service-connections.js");
const SYNC = await import("../servers/sharing/instance-sync.js");
const { markFromLaptop } = await import("./helpers/off-box.js");
const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
const { projectServicesClientJs, projectServicesData } = await import("../servers/gateway/dashboard/panels/project-services/client.js");

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const HA_TOKEN = "HA_TOKEN";
const CANARY = "canary-9c4e1";
const INSTALLED = ["github", "home-assistant", "trello"];
const KEY = () => loadKeychainKey({ crowHome: HOME });

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-savedkey-db-"));
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

/** A session gate that accepts any token; the owner is the "s1" session (the harness's seam). */
const anyGate = (req, res, next) => {
  const m = /crow_session=([\w-]+)/.exec(String(req.headers.cookie || ""));
  if (!m) return res.status(401).json({ error: "Not authenticated" });
  req.dashboardSession = m[1];
  next();
};
const as = (tok) => ({ cookie: `crow_session=${tok}; crow_csrf=tok9`, "x-crow-csrf": "tok9" });
const OWNER = as("s1");
const OTHER = as("s2");

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
    sessionGate: anyGate,
    testConnection: ctx.test,
    installedIds: () => new Set(INSTALLED),
    uiEnabled: () => true,
    crowHome: HOME,
    reservedNames: () => new Set(),
    refreshMasking: () => {},
    recordSecrets: () => {},
    ownerCheck: async (_db, req) => req.dashboardSession === "s1",
    ...opts,
  }));
  return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}

function call(server, method, path, { body, headers = {} } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
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

async function capture(fn) {
  const out = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { out.push(a.map(String).join(" ")); };
  try { return { result: await fn(), out }; } finally { Object.assign(console, orig); }
}

const connectPath = (slug) => `/dashboard/services/api/project/${slug}/connect`;
const typedGh = (s, slug, label, token, headers = OWNER) => call(s, "POST", connectPath(slug), { body: { serviceId: "github", accountLabel: label, values: { [GH]: token } }, headers });
const savedGh = (s, slug, headers = OWNER, extra = {}) => call(s, "POST", connectPath(slug), { body: { serviceId: "github", useSavedKey: true, ...extra }, headers });
const extensionRows = async (db) => (await db.execute("SELECT * FROM crow_keychain WHERE kind = 'extension' ORDER BY id")).rows;
const connCount = async (db) => Number((await db.execute("SELECT COUNT(*) AS n FROM service_connections")).rows[0].n);
const savedSecret = (db, bundle = "github") => K.extensionSecretsFor(db, KEY(), bundle, [GH, HA_TOKEN]);

// ---- 1. remember a typed key ---------------------------------------------------------------

test("a typed connect remembers the key for the whole Crow: one active sealed extension row, nothing in a config file", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    const c = await typedGh(s, "spring", "Main", CANARY);
    assert.equal(c.status, 201, c.text);
  });
  const rows = await extensionRows(ctx.db);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { kind: rows[0].kind, bundle_id: rows[0].bundle_id, env_key: rows[0].env_key, origin: rows[0].origin, status: rows[0].status, label: rows[0].label },
    { kind: "extension", bundle_id: "github", env_key: GH, origin: "typed", status: "active", label: `GitHub - ${GH}` },
  );
  assert.equal(rows[0].connection_uuid, null, "not a project connection's row");
  assert.deepEqual(await savedSecret(ctx.db), { [GH]: CANARY }, "the sealed row opens to it under this machine's key");
  // Never plaintext in the store.
  assert.ok(!JSON.stringify(rows.map((r) => ({ ...r, secret_sealed: "" }))).includes(CANARY));
  // Never written to a Crow-wide key file: the remembered value is not a server's env.
  for (const name of ["mcp-addons.json", ".env", "addons.env"]) {
    for (const p of [join(HOME, name), join(HOME, "data", name)]) {
      if (!existsSync(p)) continue;
      assert.ok(!readFileSync(p, "utf8").includes(CANARY), p);
    }
  }
  ctx.db.close();
  for (const f of [ctx.path, ctx.path + "-wal", ctx.path + "-shm"]) {
    if (existsSync(f)) assert.ok(!readFileSync(f).includes(Buffer.from(CANARY)), "raw DB bytes: " + f);
  }
});

// ---- 2. first typed key wins ---------------------------------------------------------------

test("a later connect that types a different key never replaces the remembered one; a failed connect remembers nothing", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  const SECOND = "test-token-second-2";
  await withApp(ctx, async (s) => {
    assert.equal((await typedGh(s, "spring", "Main", CANARY)).status, 201);
    const other = await typedGh(s, "home", "Main", SECOND);
    assert.equal(other.status, 201, other.text);
    // That project holds its own copy: it is the account the owner typed there.
    assert.deepEqual(await K.serviceSecretsFor(ctx.db, KEY(), other.json.connection.uuid, { allowedKeys: [GH] }), { [GH]: SECOND });
    // The remembered key is still the first one.
    assert.deepEqual(await savedSecret(ctx.db), { [GH]: CANARY }, "first typed key wins");
    // A failed connect saves nothing at all.
    ctx.test.result = { ok: false, error: "auth_failed" };
    const failed = await typedGh(s, "spring", "Work", "test-token-third-3");
    assert.equal(failed.status, 400);
    assert.deepEqual(failed.json, { error: "auth_failed" });
    ctx.test.result = { ok: true };
  });
  assert.deepEqual(await savedSecret(ctx.db), { [GH]: CANARY });
  assert.equal((await extensionRows(ctx.db)).length, 1, "still one remembered row");
  assert.equal(await connCount(ctx.db), 2, "the failed connect created no connection");
});

// ---- 3. the page data ----------------------------------------------------------------------

test("the savedKey flag: only for an id in the set, only in that card, and only the owner's GET carries it", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  const installed = new Set(INSTALLED);
  const cardOf = (page, id) => Object.values(page.groups).flat().find((c) => c.serviceId === id);
  let page = await loadServicesPage(ctx.db, "spring", { installedIds: installed });
  assert.equal(cardOf(page, "github").savedKey, undefined, "no set passed: no card carries the flag");
  page = await loadServicesPage(ctx.db, "spring", { installedIds: installed, savedKeyServiceIds: new Set(["github"]) });
  assert.equal(cardOf(page, "github").savedKey, true);
  assert.equal(cardOf(page, "home-assistant").savedKey, undefined);
  // The client's own payload copies it only when it is true.
  assert.equal(projectServicesData(page).groups.paste.find((c) => c.serviceId === "github").savedKey, true);
  page = await loadServicesPage(ctx.db, "spring", { installedIds: installed, savedKeyServiceIds: new Set(["trello"]) });
  assert.equal(cardOf(page, "github").savedKey, undefined);
  assert.equal(projectServicesData(page).groups.paste.find((c) => c.serviceId === "github").savedKey, undefined);

  await withApp(ctx, async (s) => {
    assert.equal((await typedGh(s, "spring", "Main", CANARY)).status, 201);
    const own = await call(s, "GET", "/dashboard/services/api/project/home", { headers: OWNER });
    assert.equal(own.status, 200, own.text);
    assert.equal(cardOf(own.json, "github").savedKey, true, "the owner gets the one-click flag");
    assert.ok(!own.text.includes(CANARY), "and never the value");
    const deputy = await call(s, "GET", "/dashboard/services/api/project/home", { headers: OTHER });
    assert.equal(deputy.status, 200);
    assert.equal(cardOf(deputy.json, "github").savedKey, undefined, "a non-owner session gets no one-click button");
  });
});

// ---- 4. one click --------------------------------------------------------------------------

test("useSavedKey: 201 with the same secret sealed for the new connection; the live test and the binding see it; the audit names the source and carries no value", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    assert.equal((await typedGh(s, "spring", "Main", CANARY)).status, 201);
    ctx.test.calls.length = 0;
    const { result: r, out } = await capture(() => savedGh(s, "home"));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.ok, true);
    const uuid = r.json.connection.uuid;
    assert.equal(r.json.connection.accountLabel, "main", "the default account name applies");
    assert.deepEqual(r.json.connection.fields, { [GH]: "set" });
    assert.equal(ctx.test.calls.length, 1);
    assert.deepEqual(ctx.test.calls[0].values, { [GH]: CANARY }, "the live test ran on the remembered key");
    // Its own sealed copy, keyed by the new connection uuid (what its child is spawned with).
    assert.deepEqual(await K.serviceSecretsFor(ctx.db, KEY(), uuid, { allowedKeys: [GH] }), { [GH]: CANARY });
    const conn = await SVC.getConnection(ctx.db, uuid);
    assert.equal(SENS.connectionBindingOk({ uuid, serviceId: "github" }, { crowHome: HOME }), true, "the binding was written");
    assert.ok(conn.lastTestedAt, "tested at connect");
    // The audit row names where the key came from, and no value.
    const audit = (await ctx.db.execute({ sql: "SELECT payload FROM project_audit_log WHERE action = 'service.connect' AND target = ?", args: [uuid] })).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(audit[0].payload), { service_id: "github", key_source: "saved" });
    const typedAudit = (await ctx.db.execute({ sql: "SELECT payload FROM project_audit_log WHERE action = 'service.connect' AND target != ?", args: [uuid] })).rows;
    assert.deepEqual(typedAudit.map((a) => JSON.parse(a.payload)), [{ service_id: "github" }], "a typed connect's payload is unchanged");
    // Nothing anywhere carries the value.
    assert.ok(!r.text.includes(CANARY));
    assert.ok(!out.join("\n").includes(CANARY), "no log line carries it: " + out.join("|"));
    const allAudit = (await ctx.db.execute("SELECT * FROM project_audit_log")).rows;
    assert.ok(!JSON.stringify(allAudit).includes(CANARY));
    const notes = (await ctx.db.execute("SELECT * FROM notifications")).rows;
    assert.ok(!JSON.stringify(notes).includes(CANARY), "no bell carries it");
  });
});

// ---- 5. not the owner's -------------------------------------------------------------------

test("useSavedKey is the owner's alone: a deputy session gets 403 not_owner and nothing is read", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    assert.equal((await typedGh(s, "spring", "Main", CANARY)).status, 201);
    ctx.test.calls.length = 0;
    const before = await connCount(ctx.db);
    const r = await savedGh(s, "home", OTHER);
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: "not_owner" });
    assert.equal(ctx.test.calls.length, 0, "no live test ran");
    assert.equal(await connCount(ctx.db), before, "no connection was made");
    assert.ok(!r.text.includes(CANARY));
  });
});

test("the real owner rule refuses an SSO session's useSavedKey too", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  const realGate = (req, res, next) => {
    const m = /crow_session=([\w-]+)/.exec(String(req.headers.cookie || ""));
    if (!m) return res.status(401).json({ error: "Not authenticated" });
    req.dashboardSession = m[1];
    markFromLaptop(req);
    next();
  };
  const future = new Date(Date.now() + 86400000).toISOString();
  for (const [tok, scopes] of [["own-1", "dashboard"], ["sso-1", "dashboard sso src:peer-1"]]) {
    await ctx.db.execute({
      sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)",
      args: [hashToken(tok), scopes, future],
    });
  }
  await withApp(ctx, async (s) => {
    const c = await call(s, "POST", connectPath("spring"), { body: { serviceId: "github", accountLabel: "Main", values: { [GH]: CANARY } }, headers: as("own-1") });
    assert.equal(c.status, 201, c.text);
    ctx.test.calls.length = 0;
    const r = await call(s, "POST", connectPath("home"), { body: { serviceId: "github", useSavedKey: true }, headers: as("sso-1") });
    assert.equal(r.status, 403, r.text);
    assert.deepEqual(r.json, { error: "not_owner" });
    assert.equal(ctx.test.calls.length, 0);
    assert.equal(await connCount(ctx.db), 1);
  }, { sessionGate: realGate, ownerCheck: undefined });
});

// ---- 6. nothing combined, nothing ineligible ----------------------------------------------

test("useSavedKey refuses typed values, a non-boolean flag, a service with a non-secret field and one that isn't installed", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    assert.equal((await typedGh(s, "spring", "Main", CANARY)).status, 201);
    ctx.test.calls.length = 0;
    const before = await connCount(ctx.db);
    const cases = [
      [{ serviceId: "github", useSavedKey: true, values: { [GH]: "chosen-by-the-caller" } }, 400, "bad_value"],
      [{ serviceId: "github", useSavedKey: true, values: { OTHER: "x" } }, 400, "bad_value"],
      [{ serviceId: "github", useSavedKey: true, values: [] }, 400, "bad_value"],
      [{ serviceId: "github", useSavedKey: "true" }, 400, "bad_value"],
      [{ serviceId: "github", useSavedKey: 1 }, 400, "bad_value"],
      [{ serviceId: "github", useSavedKey: false }, 400, "bad_value"],
      [{ serviceId: "home-assistant", useSavedKey: true }, 400, "bad_value"],
      [{ serviceId: "obsidian", useSavedKey: true }, 400, "not_installed"],
    ];
    for (const [body, status, code] of cases) {
      const r = await call(s, "POST", connectPath("home"), { body, headers: OWNER });
      assert.equal(r.status, status, JSON.stringify(body) + " → " + r.text);
      assert.deepEqual(r.json, { error: code }, JSON.stringify(body));
    }
    assert.equal(ctx.test.calls.length, 0, "nothing left Crow");
    assert.equal(await connCount(ctx.db), before, "nothing was created");
    assert.deepEqual(await savedSecret(ctx.db), { [GH]: CANARY }, "the remembered key is untouched");
  });
});

// ---- 7. no saved key / a key the service refuses ------------------------------------------

test("no saved key answers no_saved_key; a remembered key the service refuses answers auth_failed and leaves no connection behind", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  await withApp(ctx, async (s) => {
    // Nothing remembered yet (and no keychain key on this machine): still a plain 400.
    const none = await savedGh(s, "home");
    assert.equal(none.status, 400, none.text);
    assert.deepEqual(none.json, { error: "no_saved_key" });
    assert.equal(ctx.test.calls.length, 0, "no live test on a key that isn't there");

    assert.equal((await typedGh(s, "spring", "Main", CANARY)).status, 201);
    ctx.test.result = { ok: false, error: "auth_failed" };
    const refused = await savedGh(s, "home");
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.json, { error: "auth_failed" });
    ctx.test.result = { ok: true };
    assert.equal(await connCount(ctx.db), 1, "only the typed connect's row");
  });
});

// ---- 8. rotation and removal --------------------------------------------------------------

test("changing or removing the remembered key never touches a connection already made; a reinstall's next typed connect activates the row again", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  const ROTATED = "test-token-rotated-8";
  const REINSTALLED = "test-token-reinstall-9";
  await withApp(ctx, async (s) => {
    const c = await typedGh(s, "spring", "Main", CANARY);
    assert.equal(c.status, 201);
    const uuid = c.json.connection.uuid;
    // The owner saves a different key for the service (Settings > Passwords, or another connect).
    await K.saveExtensionSecret(ctx.db, KEY(), { bundleId: "github", envKey: GH, label: "GitHub", secret: ROTATED, origin: "typed" });
    assert.deepEqual(await savedSecret(ctx.db), { [GH]: ROTATED }, "the remembered key moved");
    assert.deepEqual(await K.serviceSecretsFor(ctx.db, KEY(), uuid, { allowedKeys: [GH] }), { [GH]: CANARY }, "the existing connection keeps its own copy");
    // Connecting again with one click picks the rotated key up.
    const fresh2 = await savedGh(s, "home");
    assert.equal(fresh2.status, 201, fresh2.text);
    assert.deepEqual(ctx.test.calls.at(-1).values, { [GH]: ROTATED });

    // Uninstall: the extension row is marked removed, so the one-click button is gone.
    assert.equal(await K.markBundleRemoved(ctx.db, "github"), 3, "the remembered key and both projects' copies");
    const catalog = serviceCatalog();
    assert.equal((await savedKeyServiceIds(ctx.db, catalog, new Set(INSTALLED))).has("github"), false);
    const gone = await savedGh(s, "home");
    assert.equal(gone.status, 400);
    assert.deepEqual(gone.json, { error: "no_saved_key" });
    assert.deepEqual(await K.serviceSecretsFor(ctx.db, KEY(), uuid, { allowedKeys: [GH] }), {}, "a removed bundle serves nothing");

    // Reinstall and type the key again: the removed row is reactivated with the new value.
    const again = await typedGh(s, "spring", "Again", REINSTALLED);
    assert.equal(again.status, 201, again.text);
    const rows = await extensionRows(ctx.db);
    assert.equal(rows.length, 1, "updated in place, not a second row");
    assert.equal(rows[0].status, "active");
    assert.deepEqual(await savedSecret(ctx.db), { [GH]: REINSTALLED });
    assert.equal((await savedKeyServiceIds(ctx.db, catalog, new Set(INSTALLED))).has("github"), true);
  });
});

// ---- 9. remembering is never fatal ---------------------------------------------------------

test("a keychain failure while remembering the typed key does not fail the connect", async () => {
  const ctx = { ...(await freshDb()), test: fakeTest() };
  const svc = serviceById("github");
  const key = { id: "0123456789abcdef", seed: Buffer.alloc(32, 7) };
  const { result, out } = await capture(async () => {
    await rememberTypedKeys(ctx.db, key, svc, { [GH]: CANARY }, { save: () => { throw new Error("keychain unavailable"); } });
    return "done";
  });
  assert.equal(result, "done", "never throws");
  assert.deepEqual(out, ["[services] saved key not remembered"], "one fixed line, never the value or the message");
  assert.equal((await extensionRows(ctx.db)).length, 0);
  // A missing key is not a failure either: nothing to save with, nothing to log.
  const quiet = await capture(() => rememberTypedKeys(ctx.db, null, svc, { [GH]: CANARY }));
  assert.deepEqual(quiet.out, []);
  assert.equal((await extensionRows(ctx.db)).length, 0);
});

// ---- 10. nothing is synced ------------------------------------------------------------------

test("no new table and no synced row: the keychain and the connections stay local-only", () => {
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("crow_keychain"));
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("service_connections"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("crow_keychain"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("service_connections"));
  const src = readFileSync(new URL("../servers/gateway/services/saved-key.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /CREATE TABLE|ALTER TABLE|INSERT INTO service_connections/i, "metadata reader + keychain rows only");
});

// ---- 11. the client -------------------------------------------------------------------------

test("the client offers Use saved key only for a savedKey card and falls back to the sheet when there is no saved key", () => {
  const src = readFileSync(new URL("../servers/gateway/dashboard/panels/project-services/client.js", import.meta.url), "utf8");
  assert.match(src, /useSavedKey: true/);
  assert.match(src, /'no_saved_key'/);
  assert.match(src, /data-svc-use-saved/);
  assert.match(src, /it\.savedKey === true/);
  const script = projectServicesClientJs();
  assert.ok(!script.includes("`"), "the generated script has no backtick in it");
  assert.ok(!script.includes("${"), "and no dollar-brace sequence");
  // The eligibility rule itself.
  assert.equal(isOneClickEligible(serviceById("github")), true);
  assert.equal(isOneClickEligible(serviceById("home-assistant")), false, "an address field needs the sheet");
  assert.equal(isOneClickEligible(serviceById("obsidian")), false);
  assert.equal(isOneClickEligible(null), false);
});