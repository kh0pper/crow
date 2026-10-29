/**
 * Project services Task 13: entry points to Services (Settings, onboarding, project home, the
 * launcher tile), all behind CROW_SERVICES_UI. Flag off: nothing changes (Review Focus 5).
 * Scratch DB built by init-db; never touches ~/.crow.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-t13-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const { createDbClient } = await import("../servers/db.js");
const section = (await import("../servers/gateway/dashboard/settings/sections/integrations.js")).default;
const { projectHomeHtml } = await import("../servers/gateway/dashboard/panels/project-home/html.js");
const onboardingPanel = (await import("../servers/gateway/dashboard/panels/onboarding.js")).default;
const { STEP_KEYS } = await import("../servers/gateway/dashboard/panels/onboarding.js");
const tiles = await import("../servers/gateway/apps/extra-tiles.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { isAppIconKey } = await import("../servers/gateway/dashboard/shared/app-icons.js");

const SECRET = "ghp_SHOULD_NEVER_APPEAR_1234567890";
const ENV_BEFORE = { ...process.env };
after(() => { for (const k of ["CROW_SERVICES_UI", "GITHUB_PERSONAL_ACCESS_TOKEN"]) { if (k in ENV_BEFORE) process.env[k] = ENV_BEFORE[k]; else delete process.env[k]; } });

const flag = (on) => { if (on) process.env.CROW_SERVICES_UI = "1"; else delete process.env.CROW_SERVICES_UI; };

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-t13-db-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const db = createDbClient(join(dir, "crow.db"));
  const r = await db.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES ('spring', 'Spring') RETURNING id" });
  return { db, projectId: Number(r.rows[0].id) };
}

const HOME_DATA = { lead: null, bots: [], needsYouCount: 0, needsYou: [], sessions: [] };
const PROJECT = { id: 1, slug: "spring" };

async function onboardingHtml() {
  let captured = "";
  const out = await onboardingPanel.handler({ method: "GET", query: { step: String(STEP_KEYS.indexOf("integrations")) }, headers: {} },
    { send(h) { captured = h; }, setHeader() {} }, { layout: ({ content }) => content, lang: "en" });
  return typeof out === "string" ? out : captured;
}

test("no entry points with the flag off", async () => {
  flag(false);
  const { db, projectId } = await freshDb();
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = SECRET;
  // Settings: today's form, with the save button, whatever the scope.
  const a = await section.render({ req: { crowScope: { projectId, slug: "spring" } }, db, lang: "en" });
  const b = await section.render({ lang: "en" });
  assert.equal(a, b);
  assert.ok(a.includes("saveIntegration("), "the save button is there");
  assert.ok(!a.includes("data-int-moved") && !a.includes("data-int-advanced") && !a.includes("/services"));
  // Project home: no Services link; the markup equals the flag-on markup minus the link.
  const off = projectHomeHtml(HOME_DATA, PROJECT, "en", { servicesUi: false });
  const on = projectHomeHtml(HOME_DATA, PROJECT, "en", { servicesUi: true });
  assert.ok(!off.includes("/services") && !off.includes("ph-services"));
  assert.equal(on.replace(/\n    <nav class="ph-head">.*?<\/nav>/s, ""), off);
  // Default arg reads the flag.
  assert.equal(projectHomeHtml(HOME_DATA, PROJECT, "en"), off);
  // Onboarding still deep-links the Settings section.
  assert.ok((await onboardingHtml()).includes('href="/dashboard/settings?section=integrations"'));
  // Launcher: no tile.
  tiles._resetLauncherTiles();
  await import("../servers/gateway/services/launcher-tile.js?off");
  assert.deepEqual(tiles.launcherTiles({ scope: "project", projectSlug: "spring", lang: "en", canManage: true }).map((x) => x.id), []);
});

test("flag on: Settings points at the scope's Services page and Advanced prints no value", async () => {
  flag(true);
  const { db, projectId } = await freshDb();
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = SECRET;
  const inProject = await section.render({ req: { crowScope: { projectId, slug: "spring" } }, db, lang: "en" });
  assert.ok(inProject.includes('href="/dashboard/project/spring/services"'));
  assert.ok(inProject.includes("Open Spring&#39;s services") || inProject.includes("Open Spring's services"));
  assert.ok(inProject.includes(t("settings.integrations.moved", "en")));
  assert.ok(!inProject.includes("saveIntegration("), "the old form is gone");
  const everything = await section.render({ req: { crowScope: { all: true } }, db, lang: "en" });
  assert.ok(everything.includes('href="/dashboard/projects"') && !everything.includes("/services"));
  for (const html of [inProject, everything]) {
    assert.match(html, /<summary>Advanced<\/summary>/);
    assert.ok(html.includes("<code>github</code>"), "Advanced names github");
    assert.ok(html.includes("GITHUB_PERSONAL_ACCESS_TOKEN"), "and its field name");
    assert.ok(!html.includes(SECRET), "never the value");
  }
  assert.match(await section.render({ req: { crowScope: { all: true } }, db, lang: "es" }), /Avanzado/);
});

test("flag on: Advanced lists a connection's status and error class, no secret", async () => {
  flag(true);
  const { db, projectId } = await freshDb();
  await db.execute({ sql: `INSERT INTO service_connections (uuid, project_id, service_id, method, account_label, label_slug, status, last_error)
    VALUES ('u-1', ?, 'github', 'paste_key', 'Main', 'main', 'error', 'auth_failed')`, args: [projectId] });
  const html = await section.render({ req: { crowScope: { all: true } }, db, lang: "en" });
  assert.ok(html.includes("Main") && html.includes("Not working") && html.includes("<code>auth_failed</code>"));
});

test("flag on (Task 16c): Advanced shows each connection's Private switch: its default, locked for obsidian, posting to the owner route", async () => {
  flag(true);
  const { db, projectId } = await freshDb();
  for (const [uuid, svc, label] of [["00000000-0000-4000-8000-0000000000a1", "github", "gh"], ["00000000-0000-4000-8000-0000000000a2", "notion", "nt"], ["00000000-0000-4000-8000-0000000000a3", "obsidian", "ob"]]) {
    await db.execute({ sql: `INSERT INTO service_connections (uuid, project_id, service_id, method, account_label, label_slug, status)
      VALUES (?, ?, ?, 'paste_key', ?, ?, 'active')`, args: [uuid, projectId, svc, label, label] });
  }
  const html = await section.render({ req: { crowScope: { all: true } }, db, lang: "en" });
  const box = (uuid) => (html.match(new RegExp(`<input type="checkbox" data-int-private="${uuid}"[^>]*>`)) || [""])[0];
  assert.ok(box("00000000-0000-4000-8000-0000000000a1") && !/ checked/.test(box("00000000-0000-4000-8000-0000000000a1")), "github: not private");
  assert.match(box("00000000-0000-4000-8000-0000000000a2"), / checked/, "notion: private by default");
  assert.doesNotMatch(box("00000000-0000-4000-8000-0000000000a2"), / disabled/, "and the owner may turn it off");
  assert.match(box("00000000-0000-4000-8000-0000000000a3"), / checked disabled/, "obsidian: locked");
  assert.ok(html.includes(t("services.private.locked", "en")) && html.includes(t("services.private.label", "en")));
  assert.ok(html.includes("'/sensitive'") && html.includes("'X-Crow-Csrf': csrf"), "posts the owner route with CSRF");
  const script = html.slice(html.indexOf("<script>"));
  assert.ok(!script.includes("`") && !script.includes("innerHTML"), "no backtick, textContent only");
  assert.match(await section.render({ req: { crowScope: { all: true } }, db, lang: "es" }), /Tratar como privado/);
});

test("flag on: the project home and onboarding link to Services", async () => {
  flag(true);
  const home = projectHomeHtml(HOME_DATA, PROJECT, "en");
  assert.ok(home.includes('href="/dashboard/project/spring/services"') && home.includes(">Services</a>"));
  assert.ok(projectHomeHtml(HOME_DATA, PROJECT, "es").includes(">Servicios</a>"));
  const ob = await onboardingHtml();
  assert.ok(ob.includes('href="/dashboard/projects"') && !ob.includes("?section=integrations"));
});

test("launcher tile: absent without canManage, absent with the flag off, present with both", async () => {
  tiles._resetLauncherTiles();
  await import("../servers/gateway/services/launcher-tile.js?on");
  const ctx = (canManage, projectSlug = "spring") => ({ scope: projectSlug ? "project" : "all", projectSlug, lang: "en", canManage });
  const ids = (c) => tiles.launcherTiles(c).map((x) => x.id);
  flag(true);
  assert.deepEqual(ids(ctx(true)), ["add-service"]);
  assert.deepEqual(tiles.launcherTiles(ctx(true))[0], { id: "add-service", label: "Add a service", icon: "plus", href: "/dashboard/project/spring/services" });
  assert.equal(tiles.launcherTiles({ ...ctx(true), lang: "es" })[0].label, "Añadir un servicio");
  assert.deepEqual(ids(ctx(false)), []);
  assert.deepEqual(ids(ctx(true, null)), []);
  flag(false);
  assert.deepEqual(ids(ctx(true)), []);
  assert.ok(isAppIconKey("plus"));
});
