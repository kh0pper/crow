/**
 * Settings dead links (settings audit 2026-10-20).
 *
 * - The Companion settings linked to ?section=ai-profiles / ?section=tts-profiles,
 *   which are not registered sections (they live as LLM Orchestrator →
 *   Profiles subtabs), so the user was bounced to the Settings home.
 * - Old profile section ids (and the `tts` alias) now land on the matching
 *   Profiles subtab instead of the Settings home.
 * - Sync Profiles is removed: it saved crow_instances.sync_profile, which the
 *   sync engine never reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

test("companion settings never link to unregistered settings sections", () => {
  const src = readFileSync(join(REPO_ROOT, "bundles/companion/settings-section.js"), "utf8");
  assert.doesNotMatch(src, /section=(ai-profiles|tts-profiles|stt-profiles|vision-profiles)\b/);
  assert.match(src, /section=llm&(amp;)?tab=profiles&(amp;)?subtab=chat/);
  assert.match(src, /section=llm&(amp;)?tab=profiles&(amp;)?subtab=tts/);
});

test("nothing in servers/ or bundles/ links to the non-existent /dashboard/models page", () => {
  const out = execFileSync("git", ["grep", "-n", "-E", "[\"'`]/dashboard/models[\"'`?#]", "--", "servers", "bundles"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  // The only hit allowed is the redirect route itself.
  const hits = out.split("\n").filter((l) => l && !l.includes('router.get("/dashboard/models"'));
  assert.deepEqual(hits, []);
});

test("/dashboard/models (kept in old notifications) redirects to the model catalog, behind auth", () => {
  const src = readFileSync(join(REPO_ROOT, "servers/gateway/dashboard/index.js"), "utf8");
  const route = src.indexOf('router.get("/dashboard/models", (req, res) => res.redirect("/dashboard/model-catalog"))');
  assert.ok(route > 0, "redirect route exists");
  assert.ok(route > src.indexOf('router.use("/dashboard", dashboardAuth)'), "mounted after dashboardAuth");
});

async function settingsPanel() {
  return (await import("../servers/gateway/dashboard/panels/settings.js")).default;
}

async function getSection(id) {
  await settingsPanel(); // registers the built-in sections
  const { getSettingsSection } = await import("../servers/gateway/dashboard/settings/registry.js");
  return getSettingsSection(id);
}

for (const [oldId, subtab] of [["tts", "tts"], ["tts-profiles", "tts"], ["ai-profiles", "chat"], ["stt-profiles", "stt"], ["vision-profiles", "vision"]]) {
  test(`?section=${oldId} lands on the LLM Profiles ${subtab} subtab`, async () => {
    const panel = await settingsPanel();
    let to = null;
    const res = { redirect(a, b) { to = b === undefined ? a : b; } };
    await panel.handler({ method: "GET", query: { section: oldId }, body: {} }, res, { db: null, layout: () => "", lang: "en" });
    assert.equal(to, `/dashboard/settings?section=llm&tab=profiles&subtab=${subtab}`);
  });
}

test("Sync Profiles is no longer a settings section", async () => {
  assert.equal(await getSection("sync-profiles"), undefined);
  assert.ok(await getSection("llm"), "sanity: built-in sections are registered");
});
