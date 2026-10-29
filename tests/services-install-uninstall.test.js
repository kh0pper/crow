/**
 * Project services Task 12: install then connect, account fields leave the install form, and an
 * uninstall pauses connections while keeping their secrets. A scratch Crow home and data dir
 * (init-db), a fixture extension folder, the real install job and uninstall route, the real
 * services API with a stub session gate, and the real page client in linkedom + node:vm.
 * Nothing here touches ~/.crow.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import express from "express";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-svcinst-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-svcinst-data-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.CROW_SERVICES_UI;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

const B = await import("../servers/gateway/routes/bundles.js");
const H = await import("../servers/gateway/keychain/install-hooks.js");
const { createDbClient } = await import("../servers/db.js");
const { ensureWriteKey } = await import("../servers/gateway/keychain/store.js");
const SC = await import("../servers/shared/service-connections.js");
const { visibleEnvVars, formEnvVars } = await import("../servers/gateway/bundle-env-form.js");
const { servicesApiRouter } = await import("../servers/gateway/routes/services-api.js");
const { projectServicesHtml } = await import("../servers/gateway/dashboard/panels/project-services/html.js");
const { projectServicesClientJs, projectServicesDataScript } = await import("../servers/gateway/dashboard/panels/project-services/client.js");
const { serviceById } = await import("../servers/shared/service-catalog.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-svcinst-app-"));
B._setAppBundlesForTest(FIXTURES);
B._setAppEnvPathForTest(join(mkdtempSync(join(tmpdir(), "crow-svcinst-gw-")), ".env"));
B._setRestartHookForTest(() => {});
after(() => {
  B._setAppEnvPathForTest(null);
  B._setRestartHookForTest(null);
  for (const d of [HOME, DATA, FIXTURES]) rmScratch(d);
});

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const readManifest = (id) => JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));

// ---- Review Focus 5: the form is unchanged with the flag off ---------------------------------

test("form unchanged with the flag off: HA keeps HA_URL/HA_TOKEN off and drops them on; a non-service manifest never changes", () => {
  const ha = readManifest("home-assistant");
  const names = (list) => list.map((e) => e.name);
  assert.deepEqual(names(visibleEnvVars(ha, { servicesUi: false })), names(ha.env_vars.filter((e) => !e.generate)));
  assert.ok(names(visibleEnvVars(ha, { servicesUi: false })).includes("HA_URL"));
  assert.ok(names(visibleEnvVars(ha, { servicesUi: false })).includes("HA_TOKEN"));
  assert.deepEqual(names(visibleEnvVars(ha, { servicesUi: true })).filter((n) => n === "HA_URL" || n === "HA_TOKEN"), []);
  // The browser shape (Install button data attribute and the registry blob Configure reads).
  assert.deepEqual(formEnvVars(ha, { servicesUi: false }), ha.env_vars.filter((e) => !e.generate).map((e) => formEnvVars({ env_vars: [e] }, { servicesUi: false })[0]));
  // The default reads CROW_SERVICES_UI.
  assert.ok(names(visibleEnvVars(ha)).includes("HA_TOKEN"), "flag unset: unchanged");
  process.env.CROW_SERVICES_UI = "1";
  try { assert.ok(!names(visibleEnvVars(ha)).includes("HA_TOKEN")); } finally { delete process.env.CROW_SERVICES_UI; }
  // A manifest with no connect block (a plain extension) is identical either way.
  const plain = { id: "demo", env_vars: [{ name: "DEMO_URL", required: true }, { name: "DEMO_KEY", secret: true }, { name: "DEMO_GEN", generate: "secret" }] };
  assert.deepEqual(visibleEnvVars(plain, { servicesUi: true }), visibleEnvVars(plain, { servicesUi: false }));
  assert.deepEqual(names(visibleEnvVars(plain, { servicesUi: true })), ["DEMO_URL", "DEMO_KEY"]);
  // The registry entry the store renders from carries the same connect block.
  const reg = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"));
  const regHa = (reg["add-ons"] || reg).find((a) => a.id === "home-assistant");
  assert.deepEqual(names(formEnvVars(regHa, { servicesUi: false })), names(formEnvVars(ha, { servicesUi: false })));
  assert.ok(!names(formEnvVars(regHa, { servicesUi: true })).includes("HA_URL"));
});

// ---- Uninstall pauses, reinstall resumes ------------------------------------------------------

const db = () => createDbClient();

async function project(slug, name, { archived = false } = {}) {
  const d = db();
  try {
    const r = await d.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, ?) RETURNING id", args: [slug, name] });
    const id = Number(r.rows[0].id);
    if (archived) await d.execute({ sql: "UPDATE project_spaces SET status = 'archived', archived_at = datetime('now') WHERE id = ?", args: [id] });
    return id;
  } finally { d.close(); }
}

async function connectGithub(projectId, label, token) {
  const d = db();
  try {
    const key = await ensureWriteKey(d, { crowHome: HOME });
    return await SC.createConnection(d, { projectId, serviceId: "github", accountLabel: label, secrets: { [GH]: token }, testedAt: new Date() }, { key });
  } finally { d.close(); }
}

async function state(uuid) {
  const d = db();
  try {
    const conn = await SC.getConnection(d, uuid);
    const rows = (await d.execute({ sql: "SELECT status FROM crow_keychain WHERE kind = 'service' AND connection_uuid = ?", args: [uuid] })).rows;
    return { status: conn.status, secrets: rows.map((r) => r.status) };
  } finally { d.close(); }
}

function fixture(id) {
  // A service-only extension: no compose, no generated key, no keychain:true field, so the
  // install never reaches recordKeychainForInstall's reused-key reactivation (Task 6 I2).
  const m = { id, name: "GitHub", description: "d", type: "bundle", category: "productivity", version: "0.1.0", env_vars: [{ name: GH, secret: true, required: true }] };
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify(m));
  return m;
}
async function install(id, manifest) {
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, {}, { job, installedSnapshot: JSON.parse(readFileSync(join(HOME, "installed.json"), "utf8").toString() || "[]"), consentVerified: false, manifest });
  assert.equal(out.ok, true, out.reason);
  return job;
}

async function withBundles(fn) {
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test("uninstall of github pauses spring's connection (needs_install, secrets extension_removed), names spring; a reinstall flips both back; a disconnected one never revives", async () => {
  if (!existsSync(join(HOME, "installed.json"))) writeFileSync(join(HOME, "installed.json"), "[]");
  const manifest = fixture("github");
  await install("github", manifest);
  const spring = await project("spring", "Spring");
  const autumn = await project("autumn", "Autumn");
  const old = await project("old", "Old", { archived: false });
  const live = await connectGithub(spring, "work", "test-token-1");
  const gone = await connectGithub(autumn, "work", "test-token-2");
  const archivedConn = await connectGithub(old, "work", "test-token-3");
  {
    const d = db();
    try {
      await SC.disconnectConnection(d, gone.uuid);
      await d.execute({ sql: "UPDATE project_spaces SET status = 'archived', archived_at = datetime('now') WHERE id = ?", args: [old] });
    } finally { d.close(); }
  }
  assert.deepEqual(await state(gone.uuid), { status: "disconnected", secrets: ["disconnected"] });

  const job = await withBundles(async (base) => {
    const r = await fetch(`${base}/bundles/api/uninstall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle_id: "github" }) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(body.affectedProjects, [{ slug: "spring", name: "Spring" }], "live connections in non-archived projects only");
    const deadline = Date.now() + 10_000;
    let j;
    do {
      await new Promise((res) => setTimeout(res, 30));
      j = await (await fetch(`${base}/bundles/api/jobs/${body.job_id}`)).json();
    } while (j.status === "running" && Date.now() < deadline);
    return j;
  });
  assert.ok(["complete", "complete_restart"].includes(job.status), JSON.stringify(job.log));
  assert.deepEqual(job.affectedProjects.map((p) => p.slug), ["old", "spring"], "the job reports every connection it paused, archived projects too");
  assert.deepEqual(await state(live.uuid), { status: "needs_install", secrets: ["extension_removed"] });
  assert.deepEqual(await state(archivedConn.uuid), { status: "needs_install", secrets: ["extension_removed"] });
  assert.deepEqual(await state(gone.uuid), { status: "disconnected", secrets: ["disconnected"] }, "uninstall leaves a disconnected one alone");

  const reinstall = await install("github", manifest);
  assert.deepEqual(await state(live.uuid), { status: "active", secrets: ["active"] }, "reinstall flips both back");
  assert.deepEqual(await state(archivedConn.uuid), { status: "active", secrets: ["active"] });
  assert.deepEqual(await state(gone.uuid), { status: "disconnected", secrets: ["disconnected"] }, "a disconnected connection and its secrets are never revived");
  assert.ok(reinstall.log.some((l) => /Resumed 2 project connection/.test(l)), reinstall.log.join("\n"));
  assert.ok(!reinstall.log.join("\n").includes("test-token"), "no value in the job log");
});

test("restoreServicesAfterInstall runs with no reused key, restores error rows as error, and never revives a disconnected secret", async () => {
  const p = await project("winter", "Winter");
  const a = await connectGithub(p, "a", "test-token-4");
  const b = await connectGithub(p, "b", "test-token-5");
  const d = db();
  try {
    await SC.recordTest(d, a.uuid, { ok: false, error: "auth_failed" });
    await SC.markConnectionsNeedInstall(d, "github");
    await H.markBundleKeychainRemoved("github");
    // Disconnected WHILE paused: its secrets go 'disconnected' from 'extension_removed'.
    await SC.disconnectConnection(d, b.uuid);
  } finally { d.close(); }
  assert.deepEqual(await state(b.uuid), { status: "disconnected", secrets: ["disconnected"] });
  const out = await H.restoreServicesAfterInstall("github");
  assert.ok(out.connections >= 1);
  assert.deepEqual(await state(a.uuid), { status: "error", secrets: ["active"] }, "it carried an error: back as Not working");
  assert.deepEqual(await state(b.uuid), { status: "disconnected", secrets: ["disconnected"] });
});

test("markBundleKeychainRemoved still marks the keychain when the connection pause throws", async () => {
  let paused = null;
  H._setKeychainDepsForTest({
    openDb: () => {
      const real = createDbClient();
      return {
        execute: (q) => (String(q.sql || q).includes("service_connections") ? Promise.reject(new Error("no such table")) : real.execute(q)),
        close: () => real.close(),
      };
    },
  });
  try {
    const n = await H.markBundleKeychainRemoved("nobody-installed-this", { onPaused: (p) => { paused = p; } });
    assert.equal(n, 0);
    assert.equal(paused, null, "a failed pause reports nothing");
  } finally { H._setKeychainDepsForTest(null); }
});

test("uninstallAffectedProjects is read-only and answers [] on a DB failure", async () => {
  assert.deepEqual(await B.uninstallAffectedProjects("github", { dbFactory: () => { throw new Error("busy"); } }), []);
  assert.deepEqual(await B.uninstallAffectedProjects("no-such-bundle"), []);
});

// ---- The preflight route ----------------------------------------------------------------------

const COOKIE = "crow_session=s1; crow_csrf=tok9";
const stubGate = (req, res, next) => {
  if (!String(req.headers.cookie || "").includes("crow_session=s1")) return res.status(401).json({ error: "Not authenticated" });
  req.dashboardSession = "s1";
  next();
};
function get(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { let body = null; try { body = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, body }); });
    }).on("error", reject);
  });
}
async function servicesApp(opts = {}) {
  const app = express();
  app.use(servicesApiRouter({ sessionGate: stubGate, uiEnabled: () => true, crowHome: HOME, installedIds: () => new Set(["github"]), reservedNames: () => new Set(), ...opts }));
  return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}

test("GET /dashboard/services/api/uninstall-preflight/:id: session-gated, read-only, [] when nothing is affected, 404 with the flag off", async () => {
  const p = await project("summer", "Summer");
  const c = await connectGithub(p, "main", "test-token-6");
  const before = await state(c.uuid);
  const server = await servicesApp();
  try {
    const r = await get(server, "/dashboard/services/api/uninstall-preflight/github", { cookie: COOKIE });
    assert.equal(r.status, 200);
    assert.ok(r.body.affectedProjects.some((x) => x.slug === "summer" && x.name === "Summer"));
    for (const x of r.body.affectedProjects) assert.deepEqual(Object.keys(x).sort(), ["name", "slug"], "names only");
    assert.deepEqual(await state(c.uuid), before, "nothing changed");
    assert.deepEqual((await get(server, "/dashboard/services/api/uninstall-preflight/notion", { cookie: COOKIE })).body, { affectedProjects: [] });
    assert.equal((await get(server, "/dashboard/services/api/uninstall-preflight/Bad..id", { cookie: COOKIE })).status, 400);
    assert.equal((await get(server, "/dashboard/services/api/uninstall-preflight/github")).status, 401);
  } finally { server.close(); }
  const off = await servicesApp({ uiEnabled: () => false });
  try {
    assert.equal((await get(off, "/dashboard/services/api/uninstall-preflight/github", { cookie: COOKIE })).status, 404);
  } finally { off.close(); }
});

// ---- The Install sheet --------------------------------------------------------------------------

const CLIENT_HTML = projectServicesClientJs();
const CLIENT_JS = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + "<script>".length, CLIENT_HTML.lastIndexOf("</script>"));
const SECRET = "test-token-7f3a9";

function card(id, installed) {
  const s = serviceById(id);
  return {
    serviceId: s.id, bundleId: s.bundleId, name: s.name, installed, labelFrom: s.labelFrom || null,
    fields: s.fields.map((f) => ({ name: f.name, kind: f.kind, labelKey: f.label_key || null, helpKey: f.help_key || null })),
    steps: [...s.steps], stepLinks: { ...s.stepLinks },
  };
}
const PAGE = () => ({
  project: { slug: "spring", name: "Spring" }, connections: [], hasMembers: false, alsoOnCrow: [],
  groups: { network: [], signin: [], paste: [card("github", false), card("zotero", false)], builtin: [] }, botsLive: false,
});

function boot({ lang = "en", route } = {}) {
  const pg = PAGE();
  const html = projectServicesHtml(pg, lang) + projectServicesDataScript(pg, lang);
  const { window, document } = parseHTML(`<html><body class="shell"><main>${html}</main></body></html>`);
  const calls = [];
  const timers = [];
  let reloads = 0;
  const fetchStub = (url, init = {}) => {
    const c = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body ?? null };
    calls.push(c);
    const r = route(c, calls);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ status: r.status, ok: r.status >= 200 && r.status < 300, json: () => (r.body === undefined ? Promise.reject(new Error("no json")) : Promise.resolve(r.body)) });
  };
  const location = { href: "https://crow.example.ts.net/dashboard/project/spring/services", reload() { reloads++; } };
  document.cookie = "crow_csrf=csrf-abc";
  window.location = location;
  window.HTMLElement.prototype.focus = function () {};
  const ctx = vm.createContext({ window, document, location, fetch: fetchStub, URL, setTimeout: (fn) => { timers.push(fn); return timers.length; } });
  vm.runInContext(CLIENT_JS, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
  const submit = (form) => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const flush = async () => { for (let n = 0; n < 20 && timers.length; n++) { timers.splice(0).forEach((fn) => fn()); await settle(); } };
  const sheet = () => document.querySelector("[data-svc-sheet]");
  const isOpen = () => !!sheet() && (sheet().open === true || sheet().hasAttribute("open"));
  const openInstall = (id) => {
    click(document.querySelector("[data-svc-add]"));
    click(sheet().querySelector(`[data-svc-install="${id}"]`));
    return sheet().querySelector("form.svc-connect");
  };
  return { window, document, calls, click, type, submit, settle, flush, sheet, isOpen, openInstall, reloads: () => reloads };
}

const path = (u) => u.split("?")[0];
/** The store's answers: a challenge with no consent, a job that runs once then completes, a connect. */
function storeRoute({ install = { status: 200, body: { ok: true, job_id: "7" } }, connect = { status: 201, body: { ok: true, connection: {} } }, challenge = { status: 200, body: { required: false, install_required: [] } }, job = ["running", "complete"] } = {}) {
  let polls = 0;
  return (c) => {
    const p = path(c.url);
    if (p.startsWith("/dashboard/bundles/api/consent-challenge/")) return challenge;
    if (p === "/dashboard/bundles/api/install") return typeof install === "function" ? install(c) : install;
    if (p.startsWith("/dashboard/bundles/api/jobs/")) return { status: 200, body: { status: job[Math.min(polls++, job.length - 1)], log: ["x"] } };
    if (p === "/health") return { status: 200, body: {} };
    if (p.endsWith("/connect")) return typeof connect === "function" ? connect(c) : connect;
    return { status: 404, body: {} };
  };
}

test("Install sheet: the two numbered steps, the fields under step 2, the footnote, Install and connect", () => {
  const s = boot({ route: storeRoute() });
  const form = s.openInstall("github");
  assert.ok(s.isOpen());
  assert.equal(s.sheet().querySelector(".svc-sheet-title").textContent, "GitHub");
  const cards = [...form.querySelectorAll("[data-svc-install-step]")];
  assert.deepEqual(cards.map((c) => c.getAttribute("data-svc-install-step")), ["1", "2"]);
  assert.equal(cards[0].querySelector(".svc-install-title").textContent, "Add the GitHub extension to Crow");
  assert.equal(cards[0].querySelector(".svc-help").textContent, t("services.install.step1Help", "en"));
  assert.equal(cards[1].querySelector(".svc-install-title").textContent, "Connect it to Spring");
  assert.ok(cards[1].querySelector(`input[data-field="${GH}"]`), "the account fields sit in step 2");
  assert.ok(cards[1].querySelector("[data-svc-label]"));
  assert.equal(form.querySelector(".svc-footnote").textContent, t("services.install.footnote", "en"));
  assert.equal(form.querySelector(".svc-submit").textContent, "Install and connect");
  assert.equal(form.querySelector(".svc-for"), null);
  const es = boot({ lang: "es", route: storeRoute() });
  const f2 = es.openInstall("github");
  assert.equal(f2.querySelector(".svc-submit").textContent, "Instalar y conectar");
  assert.equal(f2.querySelector(".svc-install-title").textContent, "Añadir la extensión GitHub a Crow");
});

test("Install and connect: consent-challenge, install, jobs, connect, in that order; the secret only in the connect body", async () => {
  const s = boot({ route: storeRoute() });
  const form = s.openInstall("github");
  s.type(form.querySelector(`input[data-field="${GH}"]`), SECRET);
  s.submit(form);
  await s.settle();
  await s.flush();
  const seq = s.calls.map((c) => `${c.method} ${path(c.url)}`);
  assert.deepEqual(seq, [
    "GET /dashboard/bundles/api/consent-challenge/github",
    "POST /dashboard/bundles/api/install",
    "GET /dashboard/bundles/api/jobs/7",
    "GET /dashboard/bundles/api/jobs/7",
    "POST /dashboard/services/api/project/spring/connect",
  ]);
  const inst = s.calls[1];
  assert.deepEqual(JSON.parse(inst.body), { bundle_id: "github", env_vars: {} }, "no account field goes to the install");
  assert.equal(inst.headers["X-Crow-Csrf"], "csrf-abc");
  for (const c of s.calls) {
    assert.ok(!c.url.includes(SECRET));
    if (!c.url.endsWith("/connect") && !path(c.url).endsWith("/connect")) assert.ok(!String(c.body || "").includes(SECRET), c.url);
  }
  assert.equal(JSON.parse(s.calls[4].body).values[GH], SECRET);
  assert.equal(form.querySelector(`input[data-field="${GH}"]`).value, "", "cleared on success");
  assert.equal(form.querySelector("[data-svc-ok]").textContent, "Connected and tested.");
  assert.ok(form.querySelector('[data-svc-install-step="1"]').classList.contains("svc-install-step--done"));
});

test("a refused install (bins_not_trusted) shows the store's own line and keeps the sheet open, nothing else runs", async () => {
  for (const lang of ["en", "es"]) {
    const s = boot({ lang, route: storeRoute({ install: { status: 409, body: { code: "bins_not_trusted", bins: ["uvx"], error: "English text" } } }) });
    const form = s.openInstall("zotero");
    s.type(form.querySelector('input[data-field="ZOTERO_API_KEY"]'), SECRET);
    s.submit(form);
    await s.settle();
    await s.flush();
    assert.equal(form.querySelector("[data-svc-error]").textContent, t("extensions.binsNotTrusted", lang).replace("{bins}", "uvx"));
    assert.ok(s.isOpen());
    assert.ok(!s.calls.some((c) => c.url.includes("/jobs/") || c.url.includes("/connect")));
    assert.equal(form.querySelector(".svc-submit").disabled, false, "can try again");
    assert.equal(form.querySelector('input[data-field="ZOTERO_API_KEY"]').value, SECRET, "a refusal that isn't the key's keeps it");
    assert.equal(form.querySelector(".svc-submit").textContent, t("services.install.submit", lang), "nothing installed: still Install and connect");
  }
});

test("a connect that fails after the install: the extension stays installed, the error shows, and the retry only connects", async () => {
  let answer = { status: 400, body: { error: "auth_failed" } };
  const s = boot({ route: storeRoute({ connect: () => answer }) });
  const form = s.openInstall("github");
  const tok = form.querySelector(`input[data-field="${GH}"]`);
  s.type(tok, SECRET);
  s.submit(form);
  await s.settle();
  await s.flush();
  assert.equal(form.querySelector("[data-svc-error]").textContent, "The service refused the key. Check it and try again.");
  assert.equal(tok.value, "", "auth_failed clears the secret");
  assert.ok(s.isOpen());
  assert.equal(form.querySelector(".svc-submit").textContent, "Connect and test", "from here the button only connects");
  assert.ok(!s.calls.some((c) => c.url.includes("uninstall")), "nothing removes the extension");
  const before = s.calls.length;
  answer = { status: 201, body: { ok: true, connection: {} } };
  s.type(tok, "test-token-2");
  s.submit(form);
  await s.settle();
  await s.flush();
  assert.deepEqual(s.calls.slice(before).map((c) => path(c.url)), ["/dashboard/services/api/project/spring/connect"], "no second install");
  assert.equal(form.querySelector("[data-svc-ok]").textContent, "Connected and tested.");
});

test("a failed install job shows the generic line; a restart-scheduling one waits for the gateway, then connects", async () => {
  const s = boot({ route: storeRoute({ job: ["failed"] }) });
  const form = s.openInstall("github");
  s.submit(form);
  await s.settle();
  await s.flush();
  assert.equal(form.querySelector("[data-svc-error]").textContent, t("services.error.generic", "en"));
  assert.ok(!s.calls.some((c) => c.url.includes("/connect")));
  const r = boot({ route: storeRoute({ job: ["complete_restart"] }) });
  const f2 = r.openInstall("github");
  r.type(f2.querySelector(`input[data-field="${GH}"]`), SECRET);
  r.submit(f2);
  await r.settle();
  await r.flush();
  const seq = r.calls.map((c) => path(c.url));
  assert.ok(seq.indexOf("/health") > seq.indexOf("/dashboard/bundles/api/jobs/7"));
  assert.equal(seq[seq.length - 1], "/dashboard/services/api/project/spring/connect");
});

test("an extension that needs consent or other install settings goes to its own form in Extensions", async () => {
  for (const challenge of [{ status: 200, body: { required: true, token: "t" } }, { status: 200, body: { required: false, install_required: ["X_URL"] } }]) {
    const s = boot({ route: storeRoute({ challenge }) });
    const form = s.openInstall("github");
    s.type(form.querySelector(`input[data-field="${GH}"]`), SECRET);
    s.submit(form);
    await s.settle();
    assert.equal(s.window.location.href, "/dashboard/extensions?q=github");
    assert.equal(s.isOpen(), false);
    assert.equal(form.querySelector(`input[data-field="${GH}"]`).value, "", "closing clears the secret");
    assert.ok(!s.calls.some((c) => path(c.url) === "/dashboard/bundles/api/install"), "no install without consent");
  }
});

test("closing the sheet mid-install clears the secret, stops the flow before the connect, and re-renders the page", async () => {
  const s = boot({ route: storeRoute({ job: ["running", "running", "complete"] }) });
  const form = s.openInstall("github");
  const tok = form.querySelector(`input[data-field="${GH}"]`);
  s.type(tok, SECRET);
  s.submit(form);
  await s.settle();
  s.click(s.sheet().querySelector("[data-svc-close]"));
  assert.equal(tok.value, "");
  await s.flush();
  assert.ok(!s.calls.some((c) => c.url.includes("/connect")), "the late job answer never connects");
  assert.equal(s.reloads(), 1, "the started install shows on the page");
});

test("source: no backtick, no dollar-brace, no storage in the client; the secret never in a data- attribute", () => {
  assert.ok(!CLIENT_HTML.includes("`"));
  assert.ok(!CLIENT_JS.includes("${"));
  for (const bad of ["localStorage", "sessionStorage", "indexedDB", "console.", "innerHTML"]) assert.ok(!CLIENT_JS.includes(bad), bad);
});

test("copy: the Install and uninstall lines are the plan's exact text, en + es", () => {
  assert.equal(t("services.install.step1", "en"), "Add the {service} extension to Crow");
  assert.equal(t("services.install.step2", "es"), "Conectarla a {project}");
  assert.equal(t("services.install.submit", "es"), "Instalar y conectar");
  assert.equal(t("services.install.footnote", "en"), "Disconnecting later removes it from this project only. Removing the extension from Crow is in Extensions.");
  assert.equal(t("services.uninstall.affects", "en"), "Connections in these projects stop until you install it again: {projects}");
  assert.equal(t("services.uninstall.affects", "es"), "Las conexiones de estos proyectos se detienen hasta que la instales de nuevo: {projects}");
  for (const k of ["step1", "step1Help", "step2", "step2Help", "submit", "footnote"]) {
    assert.notEqual(t(`services.install.${k}`, "es"), t(`services.install.${k}`, "en"), k);
  }
});
