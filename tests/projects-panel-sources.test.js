/**
 * Projects panel Sources section: the header counts every source (not the 50-row
 * page), and each row shows whether Crow fetched it, with the same labels the
 * research tools use. A NULL-status (peer) or legacy row never reads as verified.
 * Also: an old DB without the 0013 columns degrades to no status, no crash.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const ROOT = join(import.meta.dirname, "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-projsrc-"));
const DATA = join(HOME, ".crow", "data");
mkdirSync(DATA, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = join(HOME, ".crow");
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = join(DATA, "crow.db");
after(() => rmSync(HOME, { recursive: true, force: true }));
execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: ROOT, env: process.env, stdio: "pipe" });
const CORE = join(DATA, "crow.db");

const { default: panel } = await import("../servers/gateway/dashboard/panels/projects.js");
const { createDbClient } = await import("../servers/db.js");

async function render(pid) {
  const out = await panel.handler({ method: "GET", query: { view: String(pid) }, body: {} }, { redirectAfterPost: (u) => u },
    { db: createDbClient(CORE), layout: (x) => x.content || x, lang: "en" });
  return String(out);
}
function newProject(name) {
  const d = new Database(CORE);
  try {
    const cols = d.prepare("PRAGMA table_info(project_spaces)").all().map((c) => c.name);
    const slug = name.toLowerCase().replace(/\W+/g, "-");
    const row = cols.includes("slug") ? d.prepare("INSERT INTO project_spaces (name, slug) VALUES (?, ?)").run(name, slug)
      : d.prepare("INSERT INTO project_spaces (name) VALUES (?)").run(name);
    return Number(row.lastInsertRowid);
  } finally { d.close(); }
}
function addSource(pid, title, extra = {}) {
  const d = new Database(CORE);
  try {
    const r = d.prepare("INSERT INTO research_sources (project_id, title, source_type, url, citation_apa, verified, fetch_status, verification_method) VALUES (?,?,?,?,?,?,?,?)")
      .run(pid, title, "web_article", "https://example.com/" + encodeURIComponent(title), "apa", extra.verified ?? 0, extra.status ?? null, extra.method ?? null);
    const sid = Number(r.lastInsertRowid);
    for (const found of extra.quotes || []) {
      d.prepare("INSERT INTO research_notes (project_id, source_id, note_type, content, quote_found) VALUES (?,?,?,?,?)").run(pid, sid, "quote", "q", found);
    }
    return sid;
  } finally { d.close(); }
}
const row = (html, title) => {
  const i = html.indexOf(title);
  assert.ok(i >= 0, title + " not rendered");
  return html.slice(i, html.indexOf("</tr>", i));
};

test("the Sources header shows the real total, not the 50-row page", async () => {
  const pid = newProject("Many");
  for (let i = 0; i < 60; i++) addSource(pid, "bulk" + String(i).padStart(2, "0"));
  const html = await render(pid);
  assert.match(html, /Sources \(60\)/);
  assert.match(html, /Showing latest 50 of 60/);
});

test("each row shows fetch status, the quote check count, and never verifies legacy or NULL rows", async () => {
  const pid = newProject("Statuses");
  addSource(pid, "FetchedOne", { status: "fetched", verified: 1, method: "quotes_checked", quotes: [1, 1, 0] });
  addSource(pid, "FailedOne", { status: "failed" });
  addSource(pid, "LegacyOne", { status: "legacy", verified: 1, method: "legacy_flag" });
  addSource(pid, "PeerOne", { status: null, verified: 1 });
  addSource(pid, "NoTextOne", { status: "fetched_no_text" });
  addSource(pid, "NotWebOne", { status: "not_applicable" });
  const html = await render(pid);
  const fetched = row(html, "FetchedOne");
  assert.match(fetched, /badge-connected">fetched</);
  assert.match(fetched, /2\/3 quotes found/);
  assert.match(fetched, /badge-connected">verified</);
  assert.match(row(html, "FailedOne"), /badge-error">failed</);
  const legacy = row(html, "LegacyOne");
  assert.match(legacy, /badge-draft">legacy, unchecked</);
  assert.doesNotMatch(legacy, />verified</);
  const peer = row(html, "PeerOne");
  assert.match(peer, /badge-draft">not fetched here</);
  assert.doesNotMatch(peer, />verified</);
  assert.match(row(html, "NoTextOne"), /fetched \(no text\)/);
  assert.match(row(html, "NotWebOne"), /not a web page/);
});

test("the empty state names the fetch rule", async () => {
  const pid = newProject("Empty");
  assert.match(await render(pid), /opens the page first/);
});

test("the tools and the panel produce identical label text for every status and quote count", async () => {
  const { statusLabel, statusCode, quotesLabel } = await import("../servers/research/fetch-labels.js");
  const { fetchChipHtml } = await import("../servers/gateway/dashboard/panels/projects.js");
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const st of ["fetched", "fetched_no_text", "failed", "not_applicable", "legacy", null, "weird"]) {
    const chip = fetchChipHtml({ fetch_status: st, quote_total: 0 }, "en");
    assert.ok(chip.includes(`>${statusLabel(st)}</span>`), `panel chip for ${st} is not "${statusLabel(st)}": ${chip}`);
  }
  assert.equal(statusLabel("failed"), "failed");
  assert.equal(statusLabel(null), "not fetched here");
  const chip = fetchChipHtml({ fetch_status: "fetched", quote_total: 3, quote_found_count: 2 }, "en");
  assert.ok(chip.includes(quotesLabel(2, 3)));
  // Spanish keys off the same codes and differs from English.
  assert.notEqual(fetchChipHtml({ fetch_status: "failed" }, "es"), fetchChipHtml({ fetch_status: "failed" }, "en"));
  assert.equal(statusCode(null), "unknown");
  assert.ok(t("projects.fetch.quotes", "es").includes("{found}"));
});

test("a non-http source URL renders as plain text; http(s) links carry rel noopener", async () => {
  const pid = newProject("Links");
  const d = new Database(CORE);
  d.prepare("INSERT INTO research_sources (project_id, title, source_type, url, citation_apa, fetch_status) VALUES (?,?,?,?,?,?)")
    .run(pid, "EvilLink", "web_article", "javascript:alert(1)", "apa", "legacy");
  d.close();
  addSource(pid, "GoodLink", { status: "fetched" });
  const html = await render(pid);
  assert.doesNotMatch(row(html, "EvilLink"), /<a href/);
  assert.match(row(html, "EvilLink"), /javascript:alert\(1\)/);
  assert.match(row(html, "GoodLink"), /<a href="https:\/\/example\.com\/GoodLink" target="_blank" rel="noopener noreferrer"/);
});

// Last: it drops a column from the shared scratch DB.
test("an old DB without the 0013 columns renders without status or a crash", async () => {
  const pid = newProject("Old");
  addSource(pid, "OldSource");
  const d = new Database(CORE);
  d.exec("ALTER TABLE research_sources DROP COLUMN fetch_status");
  d.close();
  const html = await render(pid);
  assert.match(html, /Sources \(1\)/);
  assert.match(row(html, "OldSource"), /OldSource/);
  assert.doesNotMatch(html, /not fetched here/);
});
