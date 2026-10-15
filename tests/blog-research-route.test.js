/**
 * /blog/research, the blog nav link, page lang and the case-study chapter nav
 * are all driven by the optional collections config. With no config the page
 * is a 404, the nav carries no link to it, and posts render without a chapter
 * nav. Nothing here may depend on one owner's research project.
 *
 * Two scratch DBs: one with the data-dashboard tables (data_case_studies) and
 * one with init-db only, to prove the routes survive a host without the bundle.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import express from "express";

const ROOT = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "blog-research-route-"));
const withDash = join(tmp, "with-dash");
const bare = join(tmp, "bare");
mkdirSync(withDash);
mkdirSync(bare);
process.env.CROW_HOME = join(tmp, "home");
process.env.CROW_DATA_DIR = withDash;
delete process.env.CROW_DB_PATH;

let server;
let base;
let cfgSeq = 0;

function initDb(dataDir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: join(dataDir, "crow.db") },
    stdio: "pipe",
    cwd: ROOT,
  });
}

function useDb(dataDir) {
  process.env.CROW_DB_PATH = join(dataDir, "crow.db");
}

/** Write a config to a fresh path (fresh path = no loader cache reuse). */
function setConfig(value) {
  if (value === null) {
    delete process.env.CROW_BLOG_COLLECTIONS_CONFIG;
    return null;
  }
  const p = join(tmp, `collections-${++cfgSeq}.json`);
  writeFileSync(p, JSON.stringify(value));
  process.env.CROW_BLOG_COLLECTIONS_CONFIG = p;
  return p;
}

function config(overrides = {}) {
  return {
    enabled: true,
    navTitle: "Notes",
    pageTitle: "Example collection",
    intro: "Long-form notes.",
    sections: [{ kind: "case-studies", heading: "Entries", projectId: 2 }],
    ...overrides,
  };
}

async function get(path, headers = {}) {
  const r = await fetch(base + path, { headers, redirect: "manual" });
  return { status: r.status, body: await r.text() };
}

before(async () => {
  initDb(withDash);
  initDb(bare);
  const { createDbClient } = await import("../servers/db.js");
  const { initDataDashboardTables } = await import("../bundles/data-dashboard/server/init-tables.js");

  for (const dataDir of [withDash, bare]) {
    const db = createDbClient(join(dataDir, "crow.db"));
    for (const id of [2, 3]) {
      await db.execute({ sql: "INSERT INTO project_spaces (id, slug, name) VALUES (?, ?, ?)", args: [id, `p${id}`, `Project ${id}`] });
    }
    const post = (slug, title, tags) => db.execute({
      sql: `INSERT INTO blog_posts (slug, title, content, excerpt, status, visibility, tags, published_at)
            VALUES (?, ?, ?, ?, 'published', 'public', ?, datetime('now'))`,
      args: [slug, title, `Body of ${title}`, `Excerpt ${title}`, tags],
    });
    await post("entry-one", "Entry One", "case-study");
    await post("entry-two", "Entry Two", "case-study");
    await post("other-project", "Other Project Entry", "case-study");
    await post("plain-post", "Plain Post", "misc");
    await post("note-summary", "Note Summary", "field-notes");
    await post("note-short-version", "Note Short Version", "field-notes");
    if (dataDir === withDash) {
      await initDataDashboardTables(db);
      const ids = Object.fromEntries((await db.execute("SELECT id, slug FROM blog_posts")).rows.map((r) => [r.slug, r.id]));
      const cs = (projectId, title, postId, order) => db.execute({
        sql: "INSERT INTO data_case_studies (project_id, title, blog_post_id, display_order) VALUES (?, ?, ?, ?)",
        args: [projectId, title, postId, order],
      });
      // display_order deliberately disagrees with insertion order.
      await cs(2, "Two", ids["entry-two"], 2);
      await cs(2, "One", ids["entry-one"], 1);
      await cs(3, "Other", ids["other-project"], 1);
    }
    db.close();
  }

  useDb(withDash);
  const { default: blogPublicRouter } = await import("../servers/gateway/routes/blog-public.js");
  const app = express();
  app.use(blogPublicRouter());
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("R1: no config → no nav link and /blog/research is a 404", async () => {
  useDb(withDash);
  setConfig(null);
  const idx = await get("/blog");
  assert.equal(idx.status, 200);
  assert.ok(!idx.body.includes('href="/blog/research"'), "nav must not link a disabled page");
  const r = await get("/blog/research");
  assert.equal(r.status, 404);
});

test("R2: a config → the nav shows navTitle linking /blog/research", async () => {
  useDb(withDash);
  setConfig(config({ navTitle: "Field Notes" }));
  const idx = await get("/blog");
  assert.match(idx.body, /<a href="\/blog\/research">Field Notes<\/a>/);
});

test("R3: no config → no page carries the old hard-coded research labels", async () => {
  useDb(withDash);
  setConfig(null);
  for (const path of ["/blog", "/blog/research", "/blog/entry-one"]) {
    const r = await get(path);
    for (const label of ["Research Publications", "Policy Briefs", "All chapters"]) {
      assert.ok(!r.body.includes(label), `${path} must not contain "${label}"`);
    }
  }
});

test("R4: case studies come from the configured project, ordered, escaped; featured blurb is sanitized", async () => {
  useDb(withDash);
  setConfig(config({
    featured: {
      title: "Featured <b>work</b>",
      blurbHtml: `An <em>overview</em> <a href="https://example.com/">link</a><script>alert(1)</script><a href="javascript:x()">bad</a>`,
    },
    sections: [{ kind: "case-studies", heading: "<script>x</script>", projectId: 2 }],
  }));
  const r = await get("/blog/research");
  assert.equal(r.status, 200);
  const one = r.body.indexOf("Entry One");
  const two = r.body.indexOf("Entry Two");
  assert.ok(one > 0 && two > 0, "both project-2 entries listed");
  assert.ok(one < two, "ordered by display_order");
  assert.ok(!r.body.includes("Other Project Entry"), "project 3 is not listed");
  assert.ok(r.body.includes("&lt;script&gt;x&lt;/script&gt;"), "heading escaped");
  assert.ok(!r.body.includes("<script>x</script>"));
  assert.ok(r.body.includes("Featured &lt;b&gt;work&lt;/b&gt;"), "featured title escaped");
  assert.ok(r.body.includes("<em>overview</em>"));
  assert.ok(r.body.includes('<a href="https://example.com/" rel="noopener noreferrer">link</a>'));
  assert.ok(!r.body.includes("alert(1)"));
  assert.ok(!r.body.includes("javascript:"));
  assert.ok(r.body.includes("<title>Example collection"), "pageTitle is the document title");
});

test("R5: a tag section hides when empty; docLinks hrefs follow the first matching rule", async () => {
  useDb(withDash);
  setConfig(config({
    sections: [{ kind: "tag", heading: "Nothing Tagged Here", tag: "no-such-tag" }],
  }));
  let r = await get("/blog/research");
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes("Nothing Tagged Here"), "empty hideIfEmpty section omitted");

  setConfig(config({
    sections: [{
      kind: "tag",
      heading: "Field notes",
      tag: "field-notes",
      blurb: "Short reads.",
      docLinks: {
        base: "/blog/docs/",
        rules: [{ slugContains: "short", file: "short.pdf" }, { slugContains: "note", file: "first-match.pdf" }],
        defaultFile: "default.pdf",
      },
    }],
  }));
  r = await get("/blog/research");
  assert.ok(r.body.includes("Field notes"));
  assert.ok(r.body.includes("Short reads."));
  assert.ok(r.body.includes('href="/blog/note-summary"'));
  assert.ok(r.body.includes('href="/blog/docs/first-match.pdf"'), "summary → second rule");
  assert.ok(r.body.includes('href="/blog/docs/short.pdf"'), "short version → first rule wins");
  assert.ok(!r.body.includes("default.pdf"), "every slug matched a rule");
});

test("R7: lang:'es' sets <html lang> and the es empty text; other pages stay lang=en", async () => {
  useDb(withDash);
  setConfig(config({ lang: "es", sections: [{ kind: "case-studies", heading: "Entradas", projectId: 3000 }] }));
  const r = await get("/blog/research");
  assert.match(r.body, /<html lang="es">/);
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  assert.ok(r.body.includes(t("blog.collections.empty", "es")));
  assert.notEqual(t("blog.collections.empty", "es"), t("blog.collections.empty", "en"));
  for (const path of ["/blog", "/blog/plain-post"]) {
    assert.match((await get(path)).body, /<html lang="en">/, path);
  }
});

test("R8: chapter nav is config-driven, project-scoped, and survives a missing table", async () => {
  useDb(withDash);
  setConfig(config({ chapterNav: { tag: "case-study", projectId: 2, indexLabel: "Every entry" } }));
  let r = await get("/blog/entry-two");
  assert.equal(r.status, 200);
  assert.ok(r.body.includes("chapter-nav"));
  assert.ok(r.body.includes('href="/blog/entry-one"'), "prev is entry one");
  assert.ok(!r.body.includes('href="/blog/other-project"'), "project 3 never a neighbour");
  assert.ok(r.body.includes("Every entry"));

  setConfig(config());
  r = await get("/blog/entry-two");
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes("chapter-nav"), "no chapterNav config → no nav");

  setConfig(null);
  r = await get("/blog/entry-two");
  assert.ok(!r.body.includes("chapter-nav"));

  useDb(bare);
  setConfig(config({ chapterNav: { tag: "case-study", projectId: 2 } }));
  r = await get("/blog/entry-two");
  assert.equal(r.status, 200, "no data_case_studies table → still renders");
  assert.ok(!r.body.includes("chapter-nav"));
  const page = await get("/blog/research");
  assert.equal(page.status, 200, "case-studies section on a bare DB renders its empty state");
  useDb(withDash);
});

test("R9: deleting the config between requests turns the page off without a restart", async () => {
  useDb(withDash);
  const p = setConfig(config());
  assert.equal((await get("/blog/research")).status, 200);
  rmSync(p);
  assert.equal((await get("/blog/research")).status, 404);
});
