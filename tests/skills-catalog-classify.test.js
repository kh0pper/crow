// Skills panel option C, PR 1: where each skill comes from and its status
// (audit A1/A3-A5: 17 of 21 home skills read "custom", podcast read
// "overridden"; the sync's decisions were only ever logged). Everything runs
// on a scratch CROW_HOME and a scratch app bundles/ dir.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { skillSyncPlan, classifySkills, isExtensionCopy } from "../servers/gateway/skills-catalog.js";
import { syncBundleSkills, skillHash } from "../servers/gateway/bundle-skill-sync.js";

const scratch = mkdtempSync(join(tmpdir(), "skills-catalog-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A fresh home + app dir + repo skills dir. */
function world() {
  const root = join(scratch, `w${++n}`);
  const home = join(root, "home"), apps = join(root, "apps"), repo = join(root, "repo-skills");
  for (const d of [join(home, "skills"), apps, repo]) mkdirSync(d, { recursive: true });
  const w = {
    home, apps, repo,
    bundle(id, skills, { name = id[0].toUpperCase() + id.slice(1), extra = {} } = {}) {
      mkdirSync(join(apps, id, "skills"), { recursive: true });
      for (const [file, text] of Object.entries(skills)) writeFileSync(join(apps, id, "skills", file), text);
      writeFileSync(join(apps, id, "manifest.json"), JSON.stringify({ id, name, version: "1.0.0", skills: Object.keys(skills).map((f) => `skills/${f}`), ...extra }));
      return w;
    },
    installed(...ids) { writeFileSync(join(home, "installed.json"), JSON.stringify(ids.map((id) => ({ id, type: "bundle" })))); return w; },
    user(file, text) { writeFileSync(join(home, "skills", file), text); return w; },
    repoSkill(file, text) { writeFileSync(join(repo, file), text); return w; },
    record(obj) { writeFileSync(join(home, "skill-installs.json"), JSON.stringify(obj)); return w; },
    rows(extra = {}) { return classifySkills({ crowHome: home, appBundles: apps, repoDir: repo, ...extra }); },
    row(name, extra) { return this.rows(extra).find((r) => r.name === name && !r.shadow); },
  };
  return w;
}
const pick = (r) => r && { source: r.source, bundle: r.bundle, status: r.status, basedOn: r.basedOn, linked: r.linked, replacesBuiltin: r.replacesBuiltin, hasFile: r.hasFile };

test("syncBundleSkills lines carry the shipped hash and the record entry (review I7)", () => {
  const w = world().bundle("kiosk", { "kiosk.md": "# Kiosk v2\n" }).installed("kiosk").user("kiosk.md", "# Kiosk v1\n");
  w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# Kiosk v1\n"), installedAt: "t" } });
  const { lines } = syncBundleSkills({ id: "kiosk", src: join(w.apps, "kiosk"), manifest: JSON.parse(readFileSync(join(w.apps, "kiosk", "manifest.json"), "utf8")), mode: "report", skillsDir: join(w.home, "skills"), recordPath: join(w.home, "skill-installs.json"), log: () => {} });
  assert.equal(lines[0].action, "refresh");
  assert.equal(lines[0].srcSha, skillHash("# Kiosk v2\n"));
  assert.equal(lines[0].rec.sha256, skillHash("# Kiosk v1\n"));
  const opt = syncBundleSkills({ id: "kiosk", src: join(w.apps, "kiosk"), manifest: { skills: ["skills/kiosk.md"] }, installedManifest: { refresh: false }, mode: "report", skillsDir: join(w.home, "skills"), recordPath: join(w.home, "skill-installs.json"), log: () => {} });
  assert.deepEqual(opt.lines, [{ bundle: "kiosk", skill: "kiosk.md", action: "skip-optout", srcSha: null, rec: null }]);
});

test("an unedited recorded copy reads From <ext>, on", () => {
  const text = "---\ndescription: Put a note on the kiosk.\n---\n# Kiosk display\n";
  const w = world().bundle("kiosk", { "kiosk.md": text }).installed("kiosk").user("kiosk.md", text);
  w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash(text), installedAt: "t" } });
  const r = w.row("kiosk");
  assert.deepEqual(pick(r), { source: "ext", bundle: "kiosk", status: "on", basedOn: null, linked: false, replacesBuiltin: false, hasFile: true });
  assert.equal(r.bundleName, "Kiosk");
  assert.equal(r.title, "Kiosk display");
  assert.equal(r.description, "Put a note on the kiosk.");
});

test("an unedited copy with a newer shipped version (report mode / before boot) reads update ready", () => {
  const w = world().bundle("kiosk", { "kiosk.md": "# v2\n" }).installed("kiosk").user("kiosk.md", "# v1\n");
  w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# v1\n"), installedAt: "t" } });
  assert.deepEqual(pick(w.row("kiosk")), { source: "ext", bundle: "kiosk", status: "update", basedOn: null, linked: false, replacesBuiltin: false, hasFile: true });
});

test("an edited copy: behind when a newer version shipped since the edit, quiet when not", () => {
  const w = world().bundle("media", { "media.md": "# Media v2\n" }).installed("media").user("media.md", "# My media\n");
  w.record({ "media.md": { bundle: "media", sha256: skillHash("# Media v1\n"), installedAt: "t" } });
  assert.deepEqual(pick(w.row("media")), { source: "yours", bundle: "media", status: "behind", basedOn: "media", linked: false, replacesBuiltin: false, hasFile: true });
  w.record({ "media.md": { bundle: "media", sha256: skillHash("# Media v2\n"), installedAt: "t" } });
  assert.deepEqual(pick(w.row("media")), { source: "yours", bundle: "media", status: "on", basedOn: "media", linked: false, replacesBuiltin: false, hasFile: true });
});

test("an unverified copy is behind until acked for that shipped version", () => {
  const w = world().bundle("media", { "media.md": "# Media v3\n" }).installed("media").user("media.md", "# Who knows\n");
  assert.equal(w.row("media").status, "behind");
  const v3 = skillHash("# Media v3\n");
  assert.equal(w.row("media", { ack: { "media.md": { srcSha: v3 } } }).status, "on");
  assert.equal(w.row("media", { ack: { "media.md": { srcSha: skillHash("# Media v2\n") } } }).status, "behind", "an ack for an older version does not hold");
  assert.equal(w.row("media").source, "yours");
});

test("a \"refresh\": false bundle's copy is still an extension copy (review I8)", () => {
  const w = world().bundle("kiosk", { "kiosk.md": "# v2\n" }).installed("kiosk").user("kiosk.md", "# v1\n");
  mkdirSync(join(w.home, "bundles", "kiosk"), { recursive: true });
  writeFileSync(join(w.home, "bundles", "kiosk", "manifest.json"), JSON.stringify({ id: "kiosk", refresh: false }));
  const { plan } = skillSyncPlan({ crowHome: w.home, appBundles: w.apps });
  assert.equal(plan.get("kiosk.md").action, "skip-optout");
  assert.equal(isExtensionCopy(plan.get("kiosk.md")), true);
  assert.equal(w.row("kiosk").source, "ext");
  for (const a of ["same", "adopt", "refresh", "install", "skip-optout"]) assert.equal(isExtensionCopy({ action: a }), true, a);
  for (const a of ["kept-edited", "kept-unverified", "skip-symlink", "skip-deleted"]) assert.equal(isExtensionCopy({ action: a }), false, a);
  assert.equal(isExtensionCopy(null), false);
});

test("a symlink into an extension is From <ext> · linked", () => {
  const w = world().bundle("maker", { "maker.md": "# Maker lab\n" }).installed("maker");
  mkdirSync(join(w.home, "bundles", "maker", "skills"), { recursive: true });
  writeFileSync(join(w.home, "bundles", "maker", "skills", "maker.md"), "# Maker lab\n");
  symlinkSync(join(w.home, "bundles", "maker", "skills", "maker.md"), join(w.home, "skills", "maker.md"));
  assert.deepEqual(pick(w.row("maker")), { source: "ext", bundle: "maker", status: "on", basedOn: null, linked: true, replacesBuiltin: false, hasFile: true });
  // A link nobody ships, pointing elsewhere, is the owner's own.
  writeFileSync(join(scratch, "elsewhere.md"), "# Elsewhere\n");
  symlinkSync(join(scratch, "elsewhere.md"), join(w.home, "skills", "own-link.md"));
  assert.equal(w.row("own-link").source, "yours");
  assert.equal(w.row("own-link").linked, false);
});

test("a recorded skill whose file is gone reads Removed (no file); with the bundle uninstalled, no row", () => {
  const w = world().bundle("poster", { "design-poster.md": "# Design Poster\n" }).installed("poster");
  w.record({ "design-poster.md": { bundle: "poster", sha256: "abc", installedAt: "t" } });
  assert.deepEqual(pick(w.row("design-poster")), { source: "ext", bundle: "poster", status: "removed", basedOn: null, linked: false, replacesBuiltin: false, hasFile: false });
  assert.equal(w.row("design-poster").title, "Design Poster", "the shipped copy names it");
  w.record({ "design-poster.md": { bundle: "poster", sha256: null, removedLink: true, removedAt: "t" } });
  assert.equal(w.row("design-poster").status, "removed", "a link tombstone reads the same");
  w.installed();
  assert.equal(w.row("design-poster"), undefined);
});

test("an edited copy kept when its extension was uninstalled reads 'extension removed', not 'no longer shipped'", () => {
  const w = world().bundle("media", { "media.md": "# Media\n" }).installed().user("media.md", "# My media\n");
  w.record({ "media.md": { bundle: "media", sha256: skillHash("# Media\n"), installedAt: "t" } });
  assert.deepEqual(pick(w.row("media")), { source: "yours", bundle: "media", status: "ext-removed", basedOn: "media", linked: false, replacesBuiltin: false, hasFile: true });
});

test("a copy its installed extension no longer ships reads 'no longer shipped' (the capstone shape)", () => {
  const w = world().bundle("dash", { "dash.md": "# Dash\n" }).installed("dash").user("capstone.md", "# Capstone\n");
  mkdirSync(join(w.home, "bundles", "dash", "skills"), { recursive: true });
  writeFileSync(join(w.home, "bundles", "dash", "skills", "capstone.md"), "# Capstone\n");
  assert.deepEqual(pick(w.row("capstone")), { source: "yours", bundle: "dash", status: "orphan", basedOn: "dash", linked: false, replacesBuiltin: false, hasFile: true });
  // Recorded under that bundle, manifest dropped it: same status.
  const w2 = world().bundle("dash", { "dash.md": "# Dash\n" }).installed("dash").user("old.md", "# Old\n");
  w2.record({ "old.md": { bundle: "dash", sha256: "x", installedAt: "t" } });
  assert.equal(w2.row("old").status, "orphan");
});

test("a user copy of a built-in: yours 'replaces built-in', and the built-in row reads replaced", () => {
  const w = world().repoSkill("tutoring.md", "# Tutoring Skill\n\nTeach.\n").user("tutoring.md", "# My tutoring\n");
  const rows = w.rows().filter((r) => r.name === "tutoring");
  assert.equal(rows.length, 2);
  const yours = rows.find((r) => !r.shadow), builtin = rows.find((r) => r.shadow);
  assert.deepEqual(pick(yours), { source: "yours", bundle: null, status: "on", basedOn: null, linked: false, replacesBuiltin: true, hasFile: true });
  assert.equal(builtin.source, "builtin");
  assert.equal(builtin.status, "replaced");
  assert.equal(builtin.title, "Tutoring");
});

test("an extension copy shadowing a built-in (the podcast shape) is From <ext> + replaces built-in, not 'overridden'", () => {
  const text = "# Podcast\n";
  const w = world().repoSkill("podcast.md", "# Podcast (built-in)\n").bundle("podcast", { "podcast.md": text }).installed("podcast").user("podcast.md", text);
  w.record({ "podcast.md": { bundle: "podcast", sha256: skillHash(text), installedAt: "t" } });
  assert.deepEqual(pick(w.row("podcast")), { source: "ext", bundle: "podcast", status: "on", basedOn: null, linked: false, replacesBuiltin: true, hasFile: true });
});

test("a shipped skill not installed yet reads update ready, with no file", () => {
  const w = world().bundle("kiosk", { "kiosk.md": "# Kiosk\n" }).installed("kiosk");
  assert.deepEqual(pick(w.row("kiosk")), { source: "ext", bundle: "kiosk", status: "update", basedOn: null, linked: false, replacesBuiltin: false, hasFile: false });
});

test("a Design kit skill on a kit-less instance reads needs-kit; with the kit, on", () => {
  const w = world().user("design-frontend.md", "# Design frontend\n").user("design-mine.md", "# Mine\n");
  const kit = { kitSkills: ["design-frontend", "design-themes", "design-poster"] };
  assert.equal(w.row("design-frontend", { ...kit, kitInstalled: false }).status, "needs-kit");
  assert.equal(w.row("design-frontend", { ...kit, kitInstalled: true }).status, "on");
  assert.equal(w.row("design-mine", { ...kit, kitInstalled: false }).status, "on", "the operator's own design-* skill is not a kit skill");
});

test("plain built-ins and plain user skills", () => {
  const w = world().repoSkill("ideation.md", "# Ideation — Notes to Plans\n\nTurn notes into plans.\n").user("household.md", "# Household\n");
  assert.deepEqual(pick(w.row("ideation")), { source: "builtin", bundle: null, status: "on", basedOn: null, linked: false, replacesBuiltin: false, hasFile: true });
  assert.equal(w.row("ideation").title, "Ideation");
  assert.equal(w.row("ideation").description, "Turn notes into plans.");
  assert.equal(w.row("household").source, "yours");
});

test("an installed id the gateway would refuse is not in the plan", () => {
  const w = world().bundle("kiosk", { "kiosk.md": "# K\n" });
  mkdirSync(join(w.apps, "Bad.Id"), { recursive: true });
  writeFileSync(join(w.apps, "Bad.Id", "manifest.json"), JSON.stringify({ skills: ["skills/bad.md"] }));
  writeFileSync(join(w.home, "installed.json"), JSON.stringify(["kiosk", "Bad.Id", { id: "../x" }, 7]));
  const { plan, installedIds } = skillSyncPlan({ crowHome: w.home, appBundles: w.apps });
  assert.deepEqual(installedIds, ["kiosk"]);
  assert.deepEqual([...plan.keys()], ["kiosk.md"]);
});

function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, f.name);
      h.update(relative(dir, p));
      if (f.isDirectory()) walk(p);
      else if (f.isFile()) { h.update(readFileSync(p)); h.update(String(statSync(p).mode)); }
    }
  };
  walk(dir);
  return h.digest("hex");
}

test("skillSyncPlan and classifySkills write nothing, whatever the sync would do", () => {
  const w = world()
    .bundle("kiosk", { "kiosk.md": "# v2\n", "fresh.md": "# Fresh\n" })
    .bundle("media", { "media.md": "# Media v3\n" })
    .installed("kiosk", "media")
    .user("kiosk.md", "# v1\n").user("media.md", "# Mine\n");
  w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# v1\n"), installedAt: "t" } });
  const before = treeHash(w.home);
  skillSyncPlan({ crowHome: w.home, appBundles: w.apps });
  w.rows();
  assert.equal(treeHash(w.home), before);
});

test("the report CLI prints the same lines as before it moved onto skillSyncPlan", () => {
  const w = world()
    .bundle("kiosk", { "kiosk.md": "# v2\n", "fresh.md": "# Fresh\n" })
    .bundle("media", { "media.md": "# Media v3\n" })
    .installed("kiosk", "media")
    .user("kiosk.md", "# v1\n").user("media.md", "# Mine\n");
  w.record({ "kiosk.md": { bundle: "kiosk", sha256: skillHash("# v1\n"), installedAt: "t" } });
  // --app points at the parent of a bundles/ dir.
  const app = join(w.apps, "..", "app");
  mkdirSync(app, { recursive: true });
  symlinkSync(w.apps, join(app, "bundles"));
  const cli = fileURLToPath(new URL("../scripts/ops/skill-sync-report.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "--home", w.home, "--app", app], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // Captured from the pre-change CLI (scripts/ops/skill-sync-report.mjs @ 71f3b363) on this fixture.
  assert.equal(r.stdout.replace(w.home, "<home>").replace(join(app, "bundles"), "<app>/bundles"), [
    "skill sync report — home <home>, source <app>/bundles",
    "  refresh          kiosk/kiosk.md",
    "  install          kiosk/fresh.md",
    "  kept-unverified  media/media.md",
    "summary: install 1, kept-unverified 1, refresh 1",
    "STOP AND LOOK: kept copies will not be updated.",
    "",
  ].join("\n"));
});
