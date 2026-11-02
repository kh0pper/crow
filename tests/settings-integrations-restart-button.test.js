/**
 * Task 11 (C1/C3 build, PR C-C) — Settings saves that need a restart used to
 * say "restart needed" as bare text with no way to act on it. This adds a
 * "Restart Crow now" button next to that message: it POSTs
 * /bundles/api/restart (session-authed route, bundles.js), then reuses the
 * same pollHealth()-then-reload pattern already used for the supervised
 * auto-restart path in this section (mirrors extensions/client.js's
 * waitForRestart).
 *
 * The flag-off section is the ONLY emitter of settings.savedRestartNeeded in the
 * dashboard (grep -rl savedRestartNeeded servers/ tests/), so the button lives
 * there only — no other settings section renders this message.
 *
 * The message + button are built client-side (inside the rendered <script>)
 * when a save response comes back with restarting:false, so this test
 * renders the section's static HTML/script output and asserts the pieces
 * are present: the restart endpoint, a confirm() gate, the button label,
 * and reuse of the existing pollHealth reload helper (not a duplicated
 * one-off poller).
 *
 * Project services PR 3 turned the Services UI on by default, and with it on the
 * Integrations section no longer renders that save form at all: it points at the
 * Services page and lists each connection under Advanced. So the two flag-off
 * tests below set CROW_SERVICES_UI=0, and one flag-on test says what replaced
 * them. Nothing a user could do is lost: the restart this section offered
 * belonged to a save that only exists in the flag-off form, and a connection's
 * own Restart (services children, Task 14) is still offered in Advanced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const REPO_ROOT = join(import.meta.dirname, "..");
const SECTION_PATH = join(REPO_ROOT, "servers/gateway/dashboard/settings/sections/integrations.js");
const DB_MODULE_URL = pathToFileURL(join(REPO_ROOT, "servers/db.js")).href;

/**
 * Render the section in its own process. `env` is layered over this process's env, so a test picks
 * the Services flag; `withDb` hands render() a client on the scratch database, which is what lists
 * a seeded connection in Advanced.
 */
function renderIntegrationsSection(dataDir, lang, { env = {}, withDb = false } = {}) {
  const script = `
    import section from ${JSON.stringify(SECTION_PATH)};
    ${withDb ? `const { createDbClient } = await import(${JSON.stringify(DB_MODULE_URL)});` : ""}
    const html = await section.render({ lang: ${JSON.stringify(lang)}${withDb ? ", db: createDbClient()" : ""} });
    process.stdout.write(html);
  `;
  const scriptPath = join(dataDir, "_render.mjs");
  writeFileSync(scriptPath, script);
  return execFileSync(process.execPath, [scriptPath], {
    // The data dir explicitly, and its own crow.db: a CROW_DB_PATH inherited from the suite runner
    // would point the child at another database.
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: join(dataDir, "crow.db"), ...env },
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

const CONN = "00000000-0000-4000-8000-0000000000c1";

/** init-db in the scratch data dir, then one active github connection in a project. */
function seedConnection(dataDir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    cwd: REPO_ROOT, env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: join(dataDir, "crow.db") }, stdio: "pipe",
  });
  const c = new Database(join(dataDir, "crow.db"));
  try {
    const pid = Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES ('spring', 'Spring') RETURNING id").get().id);
    c.prepare(`INSERT INTO service_connections (uuid, project_id, service_id, method, account_label, label_slug, status)
      VALUES (?, ?, 'github', 'paste_key', 'Main', 'main', 'active')`).run(CONN, pid);
  } finally { c.close(); }
}

test("integrations section renders a restart-now button wired to POST /bundles/api/restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-integrations-restart-"));
  try {
    const html = renderIntegrationsSection(dir, "en", { env: { CROW_SERVICES_UI: "0" } });

    assert.ok(
      html.includes("/bundles/api/restart"),
      "must POST the real restart route (bundles.js:2397-2402), not a stand-in",
    );
    assert.ok(/confirm\(/.test(html), "must gate the restart behind a confirm() dialog");
    assert.ok(html.includes("Restart Crow now"), "must render the EN restartNow button label");
    assert.ok(html.includes("Restart Crow now to apply"), "must render the EN restartConfirm dialog text");
    assert.ok(
      html.includes("pollHealth"),
      "must reuse the section's existing pollHealth()-then-reload helper, not a second poller",
    );
    assert.ok(
      !/function waitForRestart/.test(html),
      "must not duplicate a second wait-for-restart poller alongside pollHealth",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrations section restart button is translated for es", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-integrations-restart-es-"));
  try {
    const html = renderIntegrationsSection(dir, "es", { env: { CROW_SERVICES_UI: "0" } });
    assert.ok(html.includes("Reiniciar Crow ahora"), "must render the ES restartNow button label");
    assert.ok(!html.includes("Restart Crow now"), "es render must not leak the EN label");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Services UI on: the save form and its restart button are gone; Services and a per-connection Restart replace them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-integrations-restart-on-"));
  // A scratch Crow home: with the flag on the section reads the hidden secrets dir (bindings,
  // sensitivity overrides), and never the operator's own.
  const env = { CROW_SERVICES_UI: "1", CROW_HOME: join(dir, "home") };
  try {
    const plain = renderIntegrationsSection(dir, "en", { env });
    assert.ok(!plain.includes("/bundles/api/restart"), "the legacy save's restart button is not emitted");
    assert.ok(!plain.includes("saveIntegration("), "the legacy save form is gone");
    assert.ok(!plain.includes("Restart Crow now"), "and so is its label");
    assert.ok(plain.includes('href="/dashboard/projects"'), "the section points at Services");

    // What a restart is still for: one connection's child. Advanced offers it on the services route.
    seedConnection(dir);
    const en = renderIntegrationsSection(dir, "en", { env, withDb: true });
    assert.ok(en.includes(`data-int-restart="${CONN}"`), "the connection keeps a Restart");
    assert.ok(en.includes("/dashboard/services/api/connection/") && en.includes("/restart"), "on the services restart route");

    const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
    const { escapeHtml } = await import("../servers/gateway/dashboard/shared/components.js");
    const es = renderIntegrationsSection(dir, "es", { env, withDb: true });
    const esLabel = t("settings.integrations.restartChild", "es");
    const enLabel = t("settings.integrations.restartChild", "en");
    assert.ok(es.includes(escapeHtml(esLabel)), "and it is translated for es");
    if (esLabel !== enLabel) {
      assert.ok(!es.includes(">" + escapeHtml(enLabel) + "<"), "es render's Restart button carries no EN label");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});