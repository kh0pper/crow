import { test } from "node:test";
import assert from "node:assert/strict";
import { shellDrawer, shellTabsNav, projectColor } from "../servers/gateway/dashboard/shell/chrome.js";

const projects = [
  { id: 1, slug: "alpha", name: "Alpha" },
  { id: 2, slug: "beta", name: "Beta" },
  { id: 3, slug: "gamma", name: "Gamma" },
];
const fakePanels = new Set(["messages", "bot-builder", "schedule", "memory", "media", "board"]);
const getPanel = (id) => (fakePanels.has(id) ? { name: id } : null);
const base = { scope: { all: true }, projects, lang: "en", getPanel };

test("projects render as links to their home with a dot", () => {
  const html = shellDrawer({ ...base, homeSlug: "beta" });
  assert.match(html, /<a href="\/dashboard\/project\/alpha" class="shell-project">/);
  assert.match(html, /<a href="\/dashboard\/project\/beta" class="shell-project is-current" aria-current="page">/);
  assert.match(html, /shell-project-dot" style="background:var\(--shell-project-c[1-6]\)"/);
  assert.match(html, /href="\/dashboard\/projects\?new=1"/);
  assert.match(html, /href="\/dashboard\/projects\?status=archived"/);
});

test("the count label shows, ? for unknown, none for zero", () => {
  const counts = new Map([[1, 3], [2, null], [3, 0]]);
  const html = shellDrawer({ ...base, counts });
  const row = (slug) => html.match(new RegExp(`href="/dashboard/project/${slug}".*?</a>`, "s"))[0];
  assert.match(row("alpha"), /3 need you/);
  assert.match(row("beta"), /<span aria-hidden="true">\?<\/span><span class="shell-sr">Can(?:&#39;|')t count here<\/span>/);
  assert.match(shellDrawer({ ...base, counts, lang: "es" }).match(/href="\/dashboard\/project\/beta".*?<\/a>/s)[0], /shell-sr">No se puede contar aquí</);
  assert.doesNotMatch(row("gamma"), /need you|shell-project-sub/);
});

test("one project needs you (singular), in both languages", () => {
  const counts = new Map([[1, 1], [2, 2]]);
  const en = shellDrawer({ ...base, counts });
  assert.match(en, /1 needs you/);
  assert.match(en, /2 need you/);
  const es = shellDrawer({ ...base, counts, lang: "es" });
  assert.match(es, /1 te necesita</);
  assert.match(es, /2 te necesitan</);
});

test("the shell chrome does not import the Board's data layer", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../servers/gateway/dashboard/shell/chrome.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /needs-you\.js/);
  assert.match(src, /needs-you-label\.js/);
});

test("Everything and Unassigned stay scope buttons", () => {
  const html = shellDrawer(base);
  assert.match(html, /<button type="submit" class="shell-project is-current" name="scope" value="all"/);
  assert.match(html, /Across every project/);
  assert.match(html, /name="scope" value="unassigned"/);
});

test("More of Crow is a details row holding the grid", () => {
  const html = shellDrawer(base);
  const m = html.match(/<details class="shell-more-row">(.*?)<\/details>/s);
  assert.ok(m);
  assert.match(m[1], /<summary/);
  assert.match(m[1], /More of Crow/);
  assert.match(m[1], /class="shell-more"/);
  assert.match(m[1], /href="\/dashboard\/messages"/);
  assert.match(m[1], /, [^<]*, [^<]*, [^<]*…</);
});

test("project scope points Chat at the home and Board/Make carry ?project=", () => {
  const scope = { projectId: 2, slug: "beta" };
  const html = shellTabsNav({ ...base, scope, tab: "chat", counts: new Map([[2, 4]]),
    getPanel: (id) => ({ name: id }) });
  assert.match(html, /href="\/dashboard\/project\/beta" class="shell-tab"/);
  assert.match(html, /href="\/dashboard\/board\?project=beta"/);
  assert.match(html, /href="\/dashboard\/make\?project=beta"/);
  assert.match(html, /Board · 4/);
  const all = shellTabsNav({ ...base, tab: "chat", getPanel: (id) => ({ name: id }) });
  assert.match(all, /href="\/dashboard\/perch"/);
  assert.doesNotMatch(all, /Board ·/);
});

test("project names are escaped", () => {
  const html = shellDrawer({ ...base, projects: [{ id: 9, slug: "x", name: '<img src=x onerror=1>"' }] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
});

test("projectColor is stable and within the six", () => {
  assert.equal(projectColor("alpha"), projectColor("alpha"));
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = projectColor(`p${i}`);
    assert.match(c, /^var\(--shell-project-c[1-6]\)$/);
    seen.add(c);
  }
  assert.equal(seen.size, 6);
});
