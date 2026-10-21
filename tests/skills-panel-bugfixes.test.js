/**
 * Skills panel bug fixes (queue item 32, audit rows A6/A7/A10/A11/A14/A15/
 * A19/A21/A24/A25). The handler is driven directly with a scratch CROW_HOME;
 * the real-browser Save/Delete flow lives in skills-panel-live.test.js.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, rmSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "skills-panel-fix-"));
process.env.CROW_HOME = join(scratch, "home");
process.env.CROW_DATA_DIR = join(scratch, "home", "data");
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
const SKILLS = join(process.env.CROW_HOME, "skills");
const RECORD = join(process.env.CROW_HOME, "skill-installs.json");
mkdirSync(SKILLS, { recursive: true });

const { default: panel } = await import("../servers/gateway/dashboard/panels/skills.js");
const { syncBundleSkills } = await import("../servers/gateway/bundle-skill-sync.js");
after(() => rmSync(scratch, { recursive: true, force: true }));

function fakeDb(rows = []) {
  return { execute: async ({ sql }) => (/section_title/.test(sql) ? { rows } : { rows: [] }) };
}
async function call({ method = "GET", query = {}, body = {}, lang = "en", rows = [] } = {}) {
  const out = { status: 200, redirect: null, body: null };
  const res = {
    redirect: (a, b) => { out.redirect = b === undefined ? a : b; out.status = b === undefined ? 302 : a; },
    redirectAfterPost: (u) => { out.redirect = u; out.status = 303; },
    status(c) { out.status = c; return this; },
    type() { return this; },
    send(b) { out.body = b; return this; },
    end(b) { out.body = b ?? out.body; return this; },
  };
  const html = await panel.handler({ method, query, body }, res, { db: fakeDb(rows), layout: ({ content, title }) => `<title>${title}</title>${content}`, lang });
  if (html !== undefined) out.body = html;
  return out;
}
const put = (name, text) => writeFileSync(join(SKILLS, name), text);
const listFiles = () => readdirSync(SKILLS).sort();
const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };

/** Max <form> nesting depth in an HTML string. */
function maxFormDepth(html) {
  let depth = 0, max = 0;
  for (const m of html.matchAll(/<\/?form\b/gi)) {
    if (m[0][1] === "/") depth--; else { depth++; max = Math.max(max, depth); }
  }
  return max;
}

test("A6/A7: the user-skill edit page has no form nested inside another form", async () => {
  put("nest-check.md", "# Nest check\n");
  const r = await call({ query: { edit: "nest-check.md", source: "user" } });
  assert.equal(r.status, 200);
  assert.match(r.body, /name="action" value="save"/);
  assert.match(r.body, /name="action" value="delete"/);
  assert.equal(maxFormDepth(r.body), 1, "Save and Delete are sibling forms");
});

test("A6: a POST with a repeated action answers 400 and writes nothing", async () => {
  put("dup-action.md", "old\n");
  const r = await call({ method: "POST", body: { action: ["save", "delete"], filename: "dup-action.md", content: "new" } });
  assert.equal(r.status, 400);
  assert.equal(readFileSync(join(SKILLS, "dup-action.md"), "utf8"), "old\n");
  assert.match(r.body, /<title>/, "a full HTML page, so Turbo renders it with a way back");
  const r2 = await call({ method: "POST", body: { action: "save", filename: ["a.md", "b.md"], content: "x" } });
  assert.equal(r2.status, 400, "array filename is refused, not a basename() TypeError");
});

test("save writes the edit (single action) and stays within the skills dir", async () => {
  put("plain.md", "old\n");
  const r = await call({ method: "POST", body: { action: "save", filename: "plain.md", content: "new text" } });
  assert.equal(r.status, 303);
  assert.equal(readFileSync(join(SKILLS, "plain.md"), "utf8"), "new text");
  const before = listFiles();
  const esc = await call({ method: "POST", body: { action: "save", filename: "../escape.md", content: "x" } });
  assert.equal(existsSync(join(process.env.CROW_HOME, "escape.md")), false);
  assert.match(esc.redirect, /error=not-found/, "traversal collapses to a basename, and save never creates");
  assert.deepEqual(listFiles(), before);
});

test("A12: save edits an existing user skill only — it never creates or shadows a built-in", async () => {
  const before = listFiles();
  const r = await call({ method: "POST", body: { action: "save", filename: "memory-management.md", content: "shadow" } });
  assert.match(r.redirect, /error=not-found/);
  const r2 = await call({ method: "POST", body: { action: "save", filename: "brand-new.md", content: "x" } });
  assert.match(r2.redirect, /error=not-found/);
  assert.deepEqual(listFiles(), before);
  put("keep.md", "kept\n");
  const r3 = await call({ method: "POST", body: { action: "save", filename: "keep.md", content: "  " } });
  assert.match(r3.redirect, /error=empty/);
  assert.equal(readFileSync(join(SKILLS, "keep.md"), "utf8"), "kept\n");
});

test("A12: Override copies the built-in text server-side, once", async () => {
  const repoText = readFileSync(new URL("../skills/memory-management.md", import.meta.url), "utf8");
  const r = await call({ method: "POST", body: { action: "override", filename: "memory-management.md" } });
  assert.equal(r.status, 303);
  assert.match(r.redirect, /edit=memory-management\.md&source=user/);
  assert.equal(readFileSync(join(SKILLS, "memory-management.md"), "utf8"), repoText.replace(/\r\n/g, "\n"));
  writeFileSync(join(SKILLS, "memory-management.md"), "my version");
  const again = await call({ method: "POST", body: { action: "override", filename: "memory-management.md" } });
  assert.match(again.redirect, /error=exists/);
  assert.equal(readFileSync(join(SKILLS, "memory-management.md"), "utf8"), "my version");
  const none = await call({ method: "POST", body: { action: "override", filename: "no-such-builtin.md" } });
  assert.match(none.redirect, /error=not-found/);
  rmSync(join(SKILLS, "memory-management.md"));
  const view = await call({ query: { edit: "memory-management.md", source: "repo" } });
  assert.match(view.body, /name="action" value="override"/);
  assert.doesNotMatch(view.body, /name="content"/, "the built-in text is not round-tripped through the form");
});

test("save keeps the file's mode and writes LF line endings", async () => {
  put("moded.md", "x\n");
  chmodSync(join(SKILLS, "moded.md"), 0o600);
  await call({ method: "POST", body: { action: "save", filename: "moded.md", content: "a\r\nb\r\n" } });
  assert.equal(readFileSync(join(SKILLS, "moded.md"), "utf8"), "a\nb\n");
  assert.equal(lstatSync(join(SKILLS, "moded.md")).mode & 0o777, 0o600);
});

/** A refused create (PR 1): a 422 page with the form re-rendered, what was typed kept, the error inside the form. */
function refused(r, errorText) {
  assert.equal(r.status, 422);
  assert.equal(r.redirect, null, "no redirect: a redirect would drop what was typed");
  const form = r.body.match(/<form[^>]*id="skill-create"[\s\S]*?<\/form>/);
  assert.ok(form, "the create form is on the page");
  assert.match(form[0], /class="[^"]*skills-notice[^"]*" role="alert"/);
  if (errorText) assert.ok(form[0].includes(errorText), `error text: ${errorText}`);
  return form[0];
}

test("A11: create '!!!' writes nothing and reports invalid-name, keeping what was typed", async () => {
  const before = listFiles();
  const r = await call({ method: "POST", body: { action: "create", filename: "!!!", purpose: "A purpose", content: "# x <b>" } });
  const form = refused(r, "That name can't be used");
  assert.match(form, /name="filename"[^>]*value="!!!"/);
  assert.match(form, /name="purpose"[^>]*value="A purpose"/);
  assert.ok(form.includes("# x &lt;b&gt;</textarea>"), "the instructions are kept, escaped");
  assert.match(form, /id="field-filename"[^>]*autofocus/, "focus goes to the field to fix");
  assert.deepEqual(listFiles(), before);
  assert.equal(existsSync(join(SKILLS, ".md")), false);
  const list = await call({ query: { error: "invalid-name" } });
  assert.match(list.body, /class="[^"]*skills-notice/, "an old ?error= link still shows its notice");
});

test("A11: create refuses names that leave nothing valid, and never makes a dotfile", async () => {
  const before = listFiles();
  for (const filename of [".md", "..", "../", "   ", "---", "__", "x".repeat(81), "!!!", "😀"]) {
    const r = await call({ method: "POST", body: { action: "create", filename, content: "# x" } });
    refused(r, "That name can't be used");
  }
  assert.deepEqual(listFiles(), before);
  const r = await call({ method: "POST", body: { action: "create", filename: ".hidden", content: "# h" } });
  assert.equal(r.status, 303);
  assert.ok(existsSync(join(SKILLS, "hidden.md")), "the dot is dropped like any other character outside the slug set");
  assert.ok(listFiles().every((f) => !f.startsWith(".")), "no dotfile");
});

test("A11: create with empty content reports empty and writes nothing", async () => {
  const r = await call({ method: "POST", body: { action: "create", filename: "blank", content: "   \n" } });
  const form = refused(r, "The skill has no content");
  assert.match(form, /id="field-content"[^>]*autofocus/);
  assert.match(form, /name="filename"[^>]*value="blank"/);
  assert.equal(existsSync(join(SKILLS, "blank.md")), false);
});

test("create slugifies to the name a bot can load: 'My Test Skill' → my-test-skill.md, and says so", async () => {
  const r = await call({ method: "POST", body: { action: "create", filename: "My Test Skill", content: "# Mine" } });
  assert.equal(r.status, 303);
  assert.equal(r.redirect, "/dashboard/skills?created=my-test-skill.md");
  assert.equal(readFileSync(join(SKILLS, "my-test-skill.md"), "utf8"), "# Mine");
  const list = await call({ query: { created: "my-test-skill.md" } });
  assert.match(list.body, /Created my-test-skill\.md\./);
  const r2 = await call({ method: "POST", body: { action: "create", filename: "  spaced   out  ", content: "# S" } });
  assert.equal(r2.redirect, "/dashboard/skills?created=spaced-out.md", "whitespace runs collapse, edges trimmed");
});

test("A12: create refuses a name a built-in already has, and links to it", async () => {
  const r = await call({ method: "POST", body: { action: "create", filename: "memory-management", content: "# x" } });
  const form = refused(r, "You already have a skill called “memory-management”");
  assert.match(form, /href="\/dashboard\/skills\?edit=memory-management\.md&amp;source=repo"[^>]*>Open the existing one</);
  assert.equal(existsSync(join(SKILLS, "memory-management.md")), false);
});

test("A10: create an existing name reports exists and keeps the old text", async () => {
  put("taken.md", "original\n");
  const r = await call({ method: "POST", body: { action: "create", filename: "taken.md", content: "replacement" } });
  const form = refused(r, "Pick another name: everything you typed is still here.");
  assert.match(form, /href="\/dashboard\/skills\?edit=taken\.md&amp;source=user"/);
  assert.ok(form.includes(">replacement</textarea>"));
  assert.equal(readFileSync(join(SKILLS, "taken.md"), "utf8"), "original\n");
  const es = await call({ method: "POST", lang: "es", body: { action: "create", filename: "taken.md", content: "x" } });
  refused(es, "Ya tienes una habilidad llamada “taken.md”");
});

test("create folds accents for the file name and keeps the name as typed in the heading", async () => {
  const r = await call({ method: "POST", body: { action: "create", filename: "Café notes", purpose: "Notes about the café: menus", content: "Keep the menu notes short." } });
  assert.equal(r.redirect, "/dashboard/skills?created=cafe-notes.md");
  assert.equal(readFileSync(join(SKILLS, "cafe-notes.md"), "utf8"), '---\ndescription: "Notes about the café: menus"\n---\n# Café notes\n\nKeep the menu notes short.\n');
  const r2 = await call({ method: "POST", body: { action: "create", filename: "canción", content: "# Canción\n\nLetra." } });
  assert.equal(r2.redirect, "/dashboard/skills?created=cancion.md");
  assert.equal(readFileSync(join(SKILLS, "cancion.md"), "utf8"), "# Canción\n\nLetra.", "instructions that start with a heading get no second one");
  const r3 = await call({ method: "POST", body: { action: "create", filename: "Ñandú", purpose: "Birds", content: "Body" } });
  assert.equal(r3.redirect, "/dashboard/skills?created=nandu.md");
  assert.match(readFileSync(join(SKILLS, "nandu.md"), "utf8"), /^---\ndescription: Birds\n---\n# Ñandú\n/);
  for (const f of ["cafe-notes.md", "cancion.md", "nandu.md"]) rmSync(join(SKILLS, f));
});

test("create: a name in another script gets the first free skill-<n> file and keeps its title; the same title twice is a conflict", async () => {
  put("skill-1.md", "# Taken slot\n");
  const r = await call({ method: "POST", body: { action: "create", filename: "日本", content: "Notes." } });
  assert.equal(r.redirect, "/dashboard/skills?created=skill-2.md");
  assert.equal(readFileSync(join(SKILLS, "skill-2.md"), "utf8"), "# 日本\n\nNotes.\n");
  const again = await call({ method: "POST", body: { action: "create", filename: "日本", content: "Other." } });
  const form = refused(again, "You already have a skill called “日本”");
  assert.match(form, /href="\/dashboard\/skills\?edit=skill-2\.md&amp;source=user"/);
  assert.equal(existsSync(join(SKILLS, "skill-3.md")), false);
  const list = await call({ query: { created: "skill-2.md" } });
  assert.match(list.body, /Created skill-2\.md\./);
  rmSync(join(SKILLS, "skill-1.md")); rmSync(join(SKILLS, "skill-2.md"));
});

test("create refuses a file name an extension ships, installed or not, so a later install can't collide with it", async () => {
  const r = await call({ method: "POST", body: { action: "create", filename: "Kiosk", content: "Mine." } });
  const form = refused(r, "An extension (Kiosk display) ships a skill with that file name");
  assert.ok(form.includes(">Mine.</textarea>"));
  assert.equal(existsSync(join(SKILLS, "kiosk.md")), false);
});

test("create refuses a title a built-in already uses, and links to the built-in", async () => {
  // skills/backup.md is titled "Backup & Restore"; the typed name's own file (backup--restore.md) is free.
  const r = await call({ method: "POST", body: { action: "create", filename: "Backup & Restore", content: "x" } });
  const form = refused(r, "You already have a skill called “Backup &amp; Restore”");
  assert.match(form, /href="\/dashboard\/skills\?edit=backup\.md&amp;source=repo"/);
  assert.equal(existsSync(join(SKILLS, "backup--restore.md")), false);
});

test("create: the same title under another file name is a conflict too (accents and case folded)", async () => {
  put("kitchen-x.md", "# Café Notes\n");
  const r = await call({ method: "POST", body: { action: "create", filename: "cafe notes", content: "x" } });
  refused(r, "You already have a skill called “cafe notes”");
  assert.equal(existsSync(join(SKILLS, "cafe-notes.md")), false);
  rmSync(join(SKILLS, "kitchen-x.md"));
});

test("save / delete refuse a dot-leading or empty name", async () => {
  put(".secret.md", "hidden\n");
  await call({ method: "POST", body: { action: "save", filename: ".secret.md", content: "changed" } });
  assert.equal(readFileSync(join(SKILLS, ".secret.md"), "utf8"), "hidden\n");
  await call({ method: "POST", body: { action: "delete", filename: ".secret.md" } });
  assert.ok(existsSync(join(SKILLS, ".secret.md")));
  rmSync(join(SKILLS, ".secret.md"));
  await call({ method: "POST", body: { action: "save", filename: "!!!", content: "x" } });
  assert.equal(existsSync(join(SKILLS, ".md")), false);
});

// --- symlinks (A14/A15) ---
const targetDir = join(scratch, "bundle-copy");
mkdirSync(targetDir, { recursive: true });
function link(name, text) {
  const target = join(targetDir, name);
  writeFileSync(target, text);
  try { rmSync(join(SKILLS, name)); } catch {}
  symlinkSync(target, join(SKILLS, name));
  return target;
}

test("A14: save never writes through a symlink", async () => {
  const target = link("linked.md", "bundle text\n");
  const r = await call({ method: "POST", body: { action: "save", filename: "linked.md", content: "EDIT" } });
  assert.equal(r.status, 303);
  assert.equal(readFileSync(target, "utf8"), "bundle text\n", "the link target is untouched");
  assert.ok(lstatSync(join(SKILLS, "linked.md")).isSymbolicLink(), "still a link");
});

test("A14: the edit page for a link is read-only and offers Make my own copy", async () => {
  link("linked-view.md", "# Linked\n");
  const r = await call({ query: { edit: "linked-view.md", source: "user" } });
  assert.equal(r.status, 200);
  assert.match(r.body, /name="action" value="copy-link"/);
  assert.doesNotMatch(r.body, /<textarea/, "no editor for a link");
  assert.equal(maxFormDepth(r.body), 1);
});

test("A14: a dangling link opens with a notice and can be deleted", async () => {
  symlinkSync(join(scratch, "nowhere", "gone.md"), join(SKILLS, "dangling.md"));
  const view = await call({ query: { edit: "dangling.md", source: "user" } });
  assert.equal(view.status, 200);
  assert.match(view.body, /missing or can&#39;t be read|missing or can't be read/);
  assert.doesNotMatch(view.body, /value="copy-link"/);
  const cp = await call({ method: "POST", body: { action: "copy-link", filename: "dangling.md" } });
  assert.match(cp.redirect, /error=link-unreadable/);
  await call({ method: "POST", body: { action: "delete", filename: "dangling.md" } });
  assert.equal(lstatOrNull(join(SKILLS, "dangling.md")), null, "lstat-based delete removes a dangling link");
});

test("A14: a link to a directory is never read; copy-link refuses a regular file", async () => {
  mkdirSync(join(scratch, "a-dir"), { recursive: true });
  symlinkSync(join(scratch, "a-dir"), join(SKILLS, "dirlink.md"));
  const cp = await call({ method: "POST", body: { action: "copy-link", filename: "dirlink.md" } });
  assert.match(cp.redirect, /error=link-unreadable/);
  assert.ok(lstatSync(join(SKILLS, "dirlink.md")).isSymbolicLink());
  const list = await call();
  assert.equal(list.status, 200, "the list survives a link to a directory");
  rmSync(join(SKILLS, "dirlink.md"));
  put("not-a-link.md", "plain\n");
  const r = await call({ method: "POST", body: { action: "copy-link", filename: "not-a-link.md" } });
  assert.match(r.redirect, /error=not-found/, "copy-link is not a second save");
  assert.equal(readFileSync(join(SKILLS, "not-a-link.md"), "utf8"), "plain\n");
});

test("A14: Make my own copy replaces the link with a regular file; the target is untouched", async () => {
  const target = link("linked-copy.md", "# From the bundle\n");
  const r = await call({ method: "POST", body: { action: "copy-link", filename: "linked-copy.md" } });
  assert.equal(r.status, 303);
  const st = lstatSync(join(SKILLS, "linked-copy.md"));
  assert.ok(st.isFile() && !st.isSymbolicLink(), "a regular file now");
  assert.equal(readFileSync(join(SKILLS, "linked-copy.md"), "utf8"), "# From the bundle\n");
  assert.equal(readFileSync(target, "utf8"), "# From the bundle\n");
  await call({ method: "POST", body: { action: "save", filename: "linked-copy.md", content: "mine" } });
  assert.equal(readFileSync(join(SKILLS, "linked-copy.md"), "utf8"), "mine");
  assert.equal(readFileSync(target, "utf8"), "# From the bundle\n", "editing the copy never reaches the target");
});

const INSTALLED = join(process.env.CROW_HOME, "installed.json");
const REPO_BUNDLES = new URL("../bundles/", import.meta.url).pathname;

test("A15: deleting a link an installed extension ships tombstones it, so the boot sync does not re-install it", async () => {
  // maker-lab is a real repo bundle that ships skills/maker-lab.md.
  writeFileSync(INSTALLED, JSON.stringify([{ id: "maker-lab", type: "bundle" }]));
  const target = link("maker-lab.md", "# Maker lab (linked)\n");
  rmSync(RECORD, { force: true });
  await call({ method: "POST", body: { action: "delete", filename: "maker-lab.md" } });
  assert.equal(lstatOrNull(join(SKILLS, "maker-lab.md")), null);
  assert.equal(readFileSync(target, "utf8"), "# Maker lab (linked)\n", "the target is untouched");
  const rec = JSON.parse(readFileSync(RECORD, "utf8"))["maker-lab.md"];
  assert.equal(rec.bundle, "maker-lab");
  assert.equal(rec.removedLink, true);
  const manifest = JSON.parse(readFileSync(join(REPO_BUNDLES, "maker-lab", "manifest.json"), "utf8"));
  const sync = (install) => syncBundleSkills({ id: "maker-lab", src: join(REPO_BUNDLES, "maker-lab"), manifest, install, skillsDir: SKILLS, recordPath: RECORD, log: () => {} }).lines.map((l) => l.action);
  assert.deepEqual(sync(false), ["skip-deleted"], "the boot pass leaves it deleted");
  assert.equal(existsSync(join(SKILLS, "maker-lab.md")), false);
  assert.deepEqual(sync(true), ["install"], "an explicit reinstall still restores it");
  rmSync(join(SKILLS, "maker-lab.md"));
  rmSync(INSTALLED);
});

test("A15: deleting a link no installed extension ships writes no record", async () => {
  rmSync(RECORD, { force: true });
  link("own-link.md", "# Mine\n");
  await call({ method: "POST", body: { action: "delete", filename: "own-link.md" } });
  assert.equal(lstatOrNull(join(SKILLS, "own-link.md")), null);
  assert.equal(existsSync(RECORD), false);
});

test("A15: deleting a link keeps an existing record entry, and refuses over an unreadable record", async () => {
  writeFileSync(INSTALLED, JSON.stringify([{ id: "maker-lab", type: "bundle" }]));
  link("maker-lab.md", "# R\n");
  writeFileSync(RECORD, JSON.stringify({ "maker-lab.md": { bundle: "maker-lab", sha256: "abc", installedAt: "t" } }));
  await call({ method: "POST", body: { action: "delete", filename: "maker-lab.md" } });
  assert.deepEqual(JSON.parse(readFileSync(RECORD, "utf8"))["maker-lab.md"], { bundle: "maker-lab", sha256: "abc", installedAt: "t" });
  link("maker-lab.md", "# R\n");
  writeFileSync(RECORD, "{ not json");
  const r = await call({ method: "POST", body: { action: "delete", filename: "maker-lab.md" } });
  assert.match(r.redirect, /error=record-unreadable/);
  assert.ok(lstatSync(join(SKILLS, "maker-lab.md")).isSymbolicLink(), "the link stays until the record can be updated");
  assert.equal(readFileSync(RECORD, "utf8"), "{ not json", "the record is never rewritten from scratch");
  rmSync(join(SKILLS, "maker-lab.md")); rmSync(RECORD); rmSync(INSTALLED);
});

test("deleting a regular file never touches the record", async () => {
  put("regular-del.md", "x");
  rmSync(RECORD, { force: true });
  await call({ method: "POST", body: { action: "delete", filename: "regular-del.md" } });
  assert.equal(existsSync(join(SKILLS, "regular-del.md")), false);
  assert.equal(existsSync(RECORD), false);
});

// --- GET robustness and rendering ---
test("the built-in context-management skill opens in the viewer (not the crow.md editor)", async () => {
  const r = await call({ query: { edit: "context-management.md", source: "repo" } });
  assert.equal(r.status, 200);
  assert.equal(r.redirect, null);
  assert.match(r.body, /name="action" value="override"/);
  put("context-notes.md", "# Notes\n");
  const u = await call({ query: { edit: "context-notes.md", source: "user" } });
  assert.match(u.body, /name="action" value="save"/);
});

test("M1: a dotfile left by the old bug is not listed", async () => {
  put(".md", "old bug\n");
  const r = await call();
  assert.doesNotMatch(r.body, /value="\.md"/);
  rmSync(join(SKILLS, ".md"));
});

test("A21: a repeated ?edit= renders the list instead of a 500", async () => {
  const r = await call({ query: { edit: ["a.md", "b.md"], source: ["user", "repo"] } });
  assert.equal(r.status, 200);
  assert.match(r.body, /name="action" value="create"/);
});

test("A19: a context section title is escaped exactly once", async () => {
  const r = await call({ query: { edit: "context-identity" }, rows: [{ section_title: "Identity & Purpose", content: "x" }] });
  assert.match(r.body, /Identity &amp; Purpose/);
  assert.doesNotMatch(r.body, /&amp;amp;/);
});

test("A25: the create placeholder uses real newlines", async () => {
  const r = await call();
  const ph = r.body.match(/<textarea name="content"[^>]*placeholder="([^"]*)"/)[1];
  assert.ok(ph.includes("\n"), "real newline");
  assert.doesNotMatch(ph, /\\n/);
});

test("A24: the Spanish page carries none of the old hard-coded English", async () => {
  const rows = [
    { section_key: "identity", section_title: "Identidad", content: "x" },
    { section_key: "memory_protocol", section_title: "Memoria", content: "y" },
    { section_key: "skills_reference", section_title: "Ref", content: "z" },
  ];
  const db = { execute: async ({ sql }) => (/section_title/.test(sql) ? { rows } : { rows: [{ content: "Never use the word delve in any writing." }] }) };
  const res = { redirect() {}, redirectAfterPost() {} };
  const list = await panel.handler({ method: "GET", query: {}, body: {} }, res, { db, layout: ({ content }) => content, lang: "es" });
  const wr = await panel.handler({ method: "GET", query: { edit: "writing-rules" }, body: {} }, res, { db, layout: ({ content, title }) => `<title>${title}</title>${content}`, lang: "es" });
  const ctx = await panel.handler({ method: "GET", query: { edit: "context-identity" }, body: {} }, res, { db, layout: ({ content, title }) => `<title>${title}</title>${content}`, lang: "es" });
  // Literals no skill title can contain; the generic words are checked in the source below.
  const english = ["Always Active", "Set Up Writing Rules", "Edit Writing Rules", "Crow Context (crow.md)", "No context sections found.", "Auto-generated", "# My Skill", "Define rules Crow follows"];
  for (const html of [list, wr, ctx]) for (const lit of english) assert.ok(!html.includes(lit), `English literal "${lit}" on the es page`);
  assert.match(wr, /<title>Editar reglas de escritura<\/title>/);
  assert.match(ctx, /<title>Editar: Identidad<\/title>/);
  assert.match(list, /Secciones: 3/);
});

test("A24: skills.js renders no hard-coded English button or badge text", () => {
  const src = readFileSync(new URL("../servers/gateway/dashboard/panels/skills.js", import.meta.url), "utf8");
  for (const lit of [">Edit<", ">Save<", ">Cancel<", ">Writing Rules<", 'badge("', 'section("', 'formField("', "`Edit: "]) {
    assert.ok(!src.includes(lit), `hard-coded "${lit}" in skills.js`);
  }
});

test("code review M3/M8: bundleShippingSkill reads string entries and ignores hostile ids", async () => {
  const { bundleShippingSkill } = await import("../servers/gateway/bundle-skill-sync.js");
  const apps = join(scratch, "apps");
  mkdirSync(join(apps, "fixture-kit"), { recursive: true });
  writeFileSync(join(apps, "fixture-kit", "manifest.json"), JSON.stringify({ skills: ["skills/fixture-skill.md"] }));
  mkdirSync(join(scratch, "evil"), { recursive: true });
  writeFileSync(join(scratch, "evil", "manifest.json"), JSON.stringify({ skills: ["skills/fixture-skill.md"] }));
  const home = join(scratch, "ship-home"); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "installed.json"), JSON.stringify(["fixture-kit"]));
  assert.equal(bundleShippingSkill({ crowHome: home, appBundles: apps, skill: "fixture-skill.md" }), "fixture-kit", "a plain string entry counts");
  assert.equal(bundleShippingSkill({ crowHome: home, appBundles: apps, skill: "other.md" }), null);
  writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "../evil" }, { id: "a/b" }, "..", { id: 7 }]));
  assert.equal(bundleShippingSkill({ crowHome: home, appBundles: apps, skill: "fixture-skill.md" }), null, "no id escapes appBundles");
});

test("code review M8: a skill over 1 MiB is never read into the page; override keeps no stale mode", async () => {
  put("huge.md", "x".repeat(1024 * 1024 + 1));
  const r = await call({ query: { edit: "huge.md", source: "user" } });
  assert.equal(r.redirect, "/dashboard/skills");
  rmSync(join(SKILLS, "huge.md"));
  const r2 = await call({ method: "POST", body: { action: "override", filename: "ideation.md" } });
  assert.equal(r2.status, 303);
  assert.ok(lstatSync(join(SKILLS, "ideation.md")).isFile());
  rmSync(join(SKILLS, "ideation.md"));
});

test("code review M4: a crafted ?created= for a file that does not exist shows no notice", async () => {
  const r = await call({ query: { created: "never-made.md" } });
  assert.doesNotMatch(r.body, /Created never-made/);
});
