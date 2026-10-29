// tests/providers-tab-role-warning.test.js — turning a provider off, or removing
// it, names the roles that move (roles phase 2 Task 23, M14). The Disable
// confirm goes through the REAL dashboard router (session, then CSRF).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const dir = mkdtempSync(join(tmpdir(), "providers-role-warning-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
const prevPublic = process.env.CROW_DASHBOARD_PUBLIC;

const { createDbClient } = await import("../servers/db.js");
const { providerBindings } = await import("../servers/gateway/models/manager.js");
const { setBinding, saveCustomRole, invalidateRoleContext } = await import("../servers/shared/model-roles-store.js");
const db = createDbClient();
after(() => {
  if (prevPublic === undefined) delete process.env.CROW_DASHBOARD_PUBLIC; else process.env.CROW_DASHBOARD_PUBLIC = prevPublic;
  try { db.close(); } catch {}
  rmScratch(dir);
});

const addProvider = (id, host = "local") => db.execute({
  sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled, lamport_ts, instance_id) VALUES (?,?,NULL,?,?,0,1,?)",
  args: [id, "http://100.64.20.5:8000/v1", host, JSON.stringify([{ id: "m1" }]), "b".repeat(32)],
});
const disabledOf = async (id) => Number((await db.execute({ sql: "SELECT disabled FROM providers WHERE id=?", args: [id] })).rows[0].disabled);

await addProvider("local-chat");
await addProvider("local-cls");
const bound = await setBinding(db, "everyday", { model: "local-chat/m1" }, { actor: "test" });
assert.ok(bound.ok, JSON.stringify(bound));

test("providerBindings: roles bound to the provider, and every role that reaches them", async () => {
  const b = await providerBindings(db, "local-chat");
  assert.equal(b.roles[0].roleId, "everyday");
  const ids = b.reach.map((r) => r.roleId);
  assert.ok(ids.includes("coordinator") && ids.includes("quick") && ids.includes("deep"), ids.join());
  assert.ok(!ids.includes("everyday"), "the bound role is in roles, not reach");
  assert.ok(b.reach.every((r) => r.via === "everyday"));
  assert.deepEqual((await providerBindings(db, "local-cls")).reach, []);
});

test("a custom role's label rides along (untrusted text, escaped by the renderers)", async () => {
  const r = await saveCustomRole(db, { label: "<i>Coder</i>", capability: "chat" }, { actor: "test" });
  assert.ok(r.ok, JSON.stringify(r));
  await setBinding(db, r.id, { model: "local-cls/m1" }, { actor: "test" });
  invalidateRoleContext();
  const b = await providerBindings(db, "local-cls");
  assert.equal(b.roles[0].label, "<i>Coder</i>");
  await setBinding(db, r.id, { model: null }, { actor: "test" });
});

test("Disable: without confirm=1 the tab lists the roles and nothing is disabled; with it, it is; without CSRF, 403", async () => {
  const { mintSsoSession } = await import("../servers/gateway/dashboard/auth.js");
  await (await import("./fixtures/sso-source.mjs")).trustedSsoSource("test");
  const { token: session } = await mintSsoSession("test");
  const express = (await import("express")).default;
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(dashboardRouter((req, res, next) => next()));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  process.env.CROW_DASHBOARD_PUBLIC = "true";
  try {
    const url = `http://127.0.0.1:${server.address().port}/dashboard/settings?section=llm&tab=providers`;
    const cookie = `crow_session=${session}; crow_csrf=csrf-abc`;
    const send = (fields, headers = { cookie }) => fetch(url, {
      method: "POST", redirect: "manual",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

    const noCsrf = await send({ action: "llm_provider_disable", id: "local-chat", confirm: "1" });
    assert.equal(noCsrf.status, 403);
    assert.equal(await disabledOf("local-chat"), 0, "no CSRF: still enabled");

    const first = await send({ action: "llm_provider_disable", id: "local-chat", _csrf: "csrf-abc" });
    assert.equal(first.status, 200, "re-rendered, not redirected");
    const html = await first.text();
    assert.ok(html.includes("Builder") && html.includes("Orchestrator"), "names the roles");
    assert.match(html, /name="confirm" value="1"/);
    assert.match(html, /Turning this off moves:/);
    assert.equal(await disabledOf("local-chat"), 0, "not disabled yet");

    const plain = await send({ action: "llm_provider_disable", id: "local-cls", _csrf: "csrf-abc" });
    assert.equal(plain.status, 303, "no roles bound: straight through");
    assert.equal(await disabledOf("local-cls"), 1);

    const ok = await send({ action: "llm_provider_disable", id: "local-chat", confirm: "1", _csrf: "csrf-abc" });
    assert.equal(ok.status, 303);
    assert.equal(await disabledOf("local-chat"), 1);
  } finally {
    delete process.env.CROW_DASHBOARD_PUBLIC;
    server.close();
  }
});

test("the Disable callout escapes custom role labels and says nothing without roles", async () => {
  const { disableMovesCallout } = await import("../servers/gateway/dashboard/settings/sections/llm/providers-tab.js");
  const html = disableMovesCallout({ id: "x<y", labels: ["<img src=x onerror=1>", "Builder"] }, { csrfToken: "t", cookies: {} }, "en");
  assert.ok(!html.includes("<img") && html.includes("&lt;img"));
  assert.ok(html.includes('value="x&lt;y"'));
  assert.equal(disableMovesCallout(null, {}, "en"), "");
  assert.equal(disableMovesCallout({ id: "x", labels: [] }, {}, "en"), "");
});

test("the delete-confirm client names roles (core translated, custom by label) and has no backtick", async () => {
  const { roleNamesJs } = await import("../servers/gateway/dashboard/panels/model-catalog-dialog.js");
  for (const lang of ["en", "es"]) assert.ok(!roleNamesJs(lang).includes("`"));
  const run = (lang, b) => new Function(roleNamesJs(lang) + "; return roleNamesOf(arguments[0]);")(b);
  const b = { roles: [{ roleId: "everyday" }], reach: [{ roleId: "coordinator", via: "everyday" }, { roleId: "c-x", label: "<b>X</b>" }, { roleId: "constructor" }, { roleId: "everyday" }] };
  assert.deepEqual(run("en", b), ["Builder", "Orchestrator", "<b>X</b>", "constructor"]);
  assert.deepEqual(run("es", { roles: [{ roleId: "coordinator" }] }), ["Orquestador"]);
  assert.deepEqual(run("en", undefined), []);
});
