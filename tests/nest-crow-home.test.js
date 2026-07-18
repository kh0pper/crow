/**
 * Nest home grid must render THIS instance's installed bundles — resolved via
 * CROW_HOME — never the primary instance's ~/.crow/installed.json.
 *
 * Regression: co-hosted gateways (MPA, R4) rendered the primary instance's
 * personal bundle tiles because data-queries.js hardcoded homedir()/.crow.
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch CROW_HOME set BEFORE the dynamic import (repo pattern, commit 71ad6104).
const scratch = mkdtempSync(join(tmpdir(), "nest-crowhome-"));
process.env.CROW_HOME = scratch;
process.env.CROW_DATA_DIR = join(scratch, "data");
mkdirSync(join(scratch, "data"), { recursive: true });

test("nest home grid reads installed bundles from CROW_HOME, not homedir", async () => {
  writeFileSync(
    join(scratch, "installed.json"),
    JSON.stringify([{ id: "scratch-bundle", type: "bundle", installedAt: "2026-07-17T00:00:00Z" }])
  );
  mkdirSync(join(scratch, "bundles", "scratch-bundle"), { recursive: true });
  writeFileSync(
    join(scratch, "bundles", "scratch-bundle", "manifest.json"),
    JSON.stringify({ name: "Scratch Bundle", icon: "database", category: "test" })
  );

  const { getNestData } = await import("../servers/gateway/dashboard/panels/nest/data-queries.js");
  const db = { execute: async () => ({ rows: [] }) };
  const data = await getNestData(db, "en");

  const ids = data.bundles.map((b) => b.id);
  // Leak guard: every rendered bundle tile must come from THIS instance's
  // installed.json — on a host whose real ~/.crow/installed.json has bundles,
  // the pre-fix code returns those instead.
  assert.deepStrictEqual(ids, ["scratch-bundle"], `bundle tiles leaked from outside CROW_HOME: ${JSON.stringify(ids)}`);
  // Manifest metadata must resolve from CROW_HOME/bundles/<id>/ as well.
  const sb = data.bundles.find((b) => b.id === "scratch-bundle");
  assert.strictEqual(sb.name, "Scratch Bundle");
});

test("skills panel lists user skills from CROW_HOME, not homedir", async () => {
  mkdirSync(join(scratch, "skills"), { recursive: true });
  writeFileSync(
    join(scratch, "skills", "scratch-only-skill.md"),
    "---\ntitle: Scratch Only Skill\n---\nbody\n"
  );

  const { default: skillsPanel } = await import("../servers/gateway/dashboard/panels/skills.js");
  const req = { method: "GET", query: {} };
  const res = { redirect: () => {} };
  const html = await skillsPanel.handler(req, res, {
    db: { execute: async () => ({ rows: [] }) },
    layout: ({ content }) => content,
    lang: "en",
  });

  assert.ok(
    String(html).includes("scratch-only-skill"),
    "user skill in CROW_HOME/skills must appear in the skills list"
  );
});

test("add-on settings sections load from CROW_HOME, not homedir", async () => {
  // Extend the scratch installed.json with an add-on that ships a settings section.
  writeFileSync(
    join(scratch, "installed.json"),
    JSON.stringify([
      { id: "scratch-bundle", type: "bundle", installedAt: "2026-07-17T00:00:00Z" },
      { id: "scratch-addon", type: "bundle", installedAt: "2026-07-17T00:00:00Z" },
    ])
  );
  mkdirSync(join(scratch, "bundles", "scratch-addon"), { recursive: true });
  writeFileSync(
    join(scratch, "bundles", "scratch-addon", "settings-section.js"),
    "export default { id: 'scratch-addon-section', label: 'Scratch Addon', render: () => '' };\n"
  );

  const { loadAddonSettings, getSettingsSection } = await import(
    "../servers/gateway/dashboard/settings/registry.js"
  );
  await loadAddonSettings();

  assert.ok(
    getSettingsSection("scratch-addon-section"),
    "settings-section.js under CROW_HOME/bundles must register for this instance"
  );
});
