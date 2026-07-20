/**
 * Task 11 (C1/C3 build, PR C-C) — Settings saves that need a restart used to
 * say "restart needed" as bare text with no way to act on it. This adds a
 * "Restart Crow now" button next to that message: it POSTs
 * /bundles/api/restart (session-authed route, bundles.js), then reuses the
 * same pollHealth()-then-reload pattern already used for the supervised
 * auto-restart path in this section (mirrors extensions/client.js's
 * waitForRestart).
 *
 * integrations.js is the ONLY emitter of settings.savedRestartNeeded in the
 * dashboard (grep -rl savedRestartNeeded servers/ tests/), so the button
 * lives there only — no other settings section renders this message.
 *
 * The message + button are built client-side (inside the rendered <script>)
 * when a save response comes back with restarting:false, so this test
 * renders the section's static HTML/script output and asserts the pieces
 * are present: the restart endpoint, a confirm() gate, the button label,
 * and reuse of the existing pollHealth reload helper (not a duplicated
 * one-off poller).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");
const SECTION_PATH = join(REPO_ROOT, "servers/gateway/dashboard/settings/sections/integrations.js");

function renderIntegrationsSection(dataDir, lang) {
  const script = `
    import section from ${JSON.stringify(SECTION_PATH)};
    const html = await section.render({ lang: ${JSON.stringify(lang)} });
    process.stdout.write(html);
  `;
  const scriptPath = join(dataDir, "_render.mjs");
  writeFileSync(scriptPath, script);
  return execFileSync(process.execPath, [scriptPath], {
    env: { ...process.env, CROW_DATA_DIR: dataDir },
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("integrations section renders a restart-now button wired to POST /bundles/api/restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-integrations-restart-"));
  try {
    const html = renderIntegrationsSection(dir, "en");

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
    const html = renderIntegrationsSection(dir, "es");
    assert.ok(html.includes("Reiniciar Crow ahora"), "must render the ES restartNow button label");
    assert.ok(!html.includes("Restart Crow now"), "es render must not leak the EN label");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
