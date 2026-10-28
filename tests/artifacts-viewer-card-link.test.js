/**
 * P6 Task 6.2: the document's header links to its card, and the viewer has a
 * way back to the shell.
 *
 * GET /api/artifacts/:id carries `card: { id, title, lane, href, thread } | null`
 * (core make/card-docs.js cardSummary, reached through the bundle's appImport
 * seam); the viewer page names the card (escaped), links into its drawer and
 * its chat, and shows "‹ Make" / "‹ Chat" from `?from=`. A scratch crow.db built
 * by init-db plus the bundle's tables, and a hand-made tasks.db.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "artifacts-card-link-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;
const THREAD = "perchlive-0123abcd";

const s = {};
async function mount(seams) {
  const { default: express } = await import("express");
  const { default: artifactsRouter } = await import("../bundles/artifacts/panel/routes.js");
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).json({ error: "login" }));
  const app = express();
  app.use(artifactsRouter(dashboardAuth, { ...s.base, ...seams }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  return srv;
}
function get(srv, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: srv.address().port, path, headers: { cookie: "crow_session=good; crow_csrf=tok" } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j, text: b }); });
    }).on("error", reject);
  });
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    action_needed TEXT, archived_at TEXT, autonomy TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.prepare("INSERT INTO tasks_items (id, title, project_id, action_needed) VALUES (9, ?, 5, 'Pick a cover')").run('Write <the> "report"');
  t.close();

  const { createDbClient } = await import("../servers/db.js");
  s.db = createDbClient();
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  await initArtifactsTables(s.db);
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('board-5','board-5',?,1,5)")
    .run(JSON.stringify({ tracker_config: { type: "kanban" } }));
  c.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, card_id, status, kind) VALUES ('bobby','perch',?,9,'active','perch-live')").run(THREAD);
  c.close();

  const { createLocalBlobStore } = await import("../bundles/artifacts/server/blob-store.js");
  const store = await import("../bundles/artifacts/server/store.js");
  const runtime = await import("../servers/gateway/artifact-origin/runtime.js");
  const policy = await import("../servers/gateway/artifact-origin/policy.js");
  const { markdownBlocks } = await import("../servers/blog/renderer.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  runtime._resetForTest();
  runtime._setInfoForTest({ baseUrl: "https://artifacts.example.ts.net", port: 0, configured: true });
  s.runtime = runtime;
  const blobs = createLocalBlobStore(join(dir, "blobs"));
  s.base = { db: s.db, blobs, runtime, policy, csrf: csrfMiddleware, renderDeps: { markdownBlocks }, createBoardCard: null, design: null,
    engine: { async list() { return []; }, async spawn() { return {}; }, async message() {} } };
  const mk = (title, origin) => store.createArtifact(s.db, blobs, { title, type: "page", source: { html: "<p>x</p>" }, actor: { kind: "bot", id: "bobby" }, origin }, {});
  s.onCard = await mk("On a card", { card: 9 });
  s.loose = await mk("Loose", {});
  s.srv = await mount({});
});
after(() => { try { s.srv.close(); } catch {} s.runtime?._resetForTest(); try { s.db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

test("the API names the document's card", async () => {
  const r = await get(s.srv, `/api/artifacts/${s.onCard.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.card.id, 9);
  assert.equal(r.body.card.title, 'Write <the> "report"');
  assert.equal(r.body.card.lane, "needs_you", "laneOf over the stored ask, not a guess");
  assert.equal(r.body.card.href, "/dashboard/bot-board?bot=board-5#open=9", "the drawer, never ?card= while a drawer can open it");
  assert.equal(r.body.card.thread, THREAD);

  const page = await get(s.srv, `/dashboard/artifacts/view/${s.onCard.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="cv-card"[^>]*href="\/dashboard\/bot-board\?bot=board-5#open=9"/);
  assert.ok(page.text.includes("Write &lt;the&gt; &quot;report&quot;"), "the card title is escaped");
  assert.ok(!page.text.includes("Write <the>"), "never raw");
  assert.ok(page.text.includes("Card #9"));
  assert.match(page.text, /class="cv-card-chat"[^>]*href="\/dashboard\/perch#perchlive-0123abcd"[^>]*>Open the chat</);
});

test("no card: null and no header link", async () => {
  const r = await get(s.srv, `/api/artifacts/${s.loose.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.card, null);
  const page = await get(s.srv, `/dashboard/artifacts/view/${s.loose.id}`);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes("cv-card"), "no card row at all");
});

test("an older core without card-docs still serves the artifact", async () => {
  const srv = await mount({ importCardDocs: async () => { throw Object.assign(new Error("Cannot find module"), { code: "ERR_MODULE_NOT_FOUND" }); } });
  try {
    const r = await get(srv, `/api/artifacts/${s.onCard.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.artifact.id, s.onCard.id);
    assert.equal(r.body.card, null);
    const page = await get(srv, `/dashboard/artifacts/view/${s.onCard.id}`);
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes("cv-card"));
  } finally { srv.close(); }
  // A core with cardForDocument but no cardSummary: the standalone card view (never the default bot's board, Q14), no title or lane.
  const { cardForDocument } = await import("../servers/gateway/make/card-docs.js");
  const srv2 = await mount({ importCardDocs: async () => ({ cardForDocument }) });
  try {
    const r = await get(srv2, `/api/artifacts/${s.onCard.id}`);
    assert.deepEqual(r.body.card, { id: 9, title: "", lane: null, href: "/dashboard/bot-board?card=9", thread: null });
  } finally { srv2.close(); }
});

test("the header shows the card's lane chip with core's wording, en and es", async () => {
  const { cardForDocument, cardSummary } = await import("../servers/gateway/make/card-docs.js");
  const WORDS = { needs_you: ["Needs you", "Te necesita"], working: ["Working", "En marcha"], up_next: ["Up next", "Lo siguiente"], done: ["Done", "Hecho"] };
  for (const [lane, [en, es]] of Object.entries(WORDS)) {
    const srv = await mount({ importCardDocs: async () => ({ cardForDocument, cardSummary: async (...a) => ({ ...(await cardSummary(...a)), lane }) }) });
    try {
      const page = await get(srv, `/dashboard/artifacts/view/${s.onCard.id}`);
      assert.match(page.text, new RegExp(`<span class="cv-lane" data-lane="${lane}">${en}</span>`), lane + " en");
      const esPage = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: srv.address().port, path: `/dashboard/artifacts/view/${s.onCard.id}`, headers: { cookie: "crow_session=good; crow_lang=es" } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).on("error", reject));
      assert.match(esPage, new RegExp(`<span class="cv-lane" data-lane="${lane}">${es}</span>`), lane + " es");
    } finally { srv.close(); }
  }
});

test("no lane chip: null lane, an unknown lane, or core's i18n unavailable (page still 200)", async () => {
  const { cardForDocument, cardSummary } = await import("../servers/gateway/make/card-docs.js");
  const withLane = (lane) => ({ importCardDocs: async () => ({ cardForDocument, cardSummary: async (...a) => ({ ...(await cardSummary(...a)), lane }) }) });
  for (const [name, seams] of [
    ["null lane", withLane(null)],
    ["unknown lane", withLane("bogus")],
    ["injected lane", withLane('x"><b>')],
    ["i18n import fails", { ...withLane("working"), importI18n: async () => { throw new Error("Cannot find module"); } }],
    ["i18n without t", { ...withLane("working"), importI18n: async () => ({}) }],
    ["key missing (t echoes the key)", { ...withLane("working"), importI18n: async () => ({ t: (k) => k }) }],
  ]) {
    const srv = await mount(seams);
    try {
      const page = await get(srv, `/dashboard/artifacts/view/${s.onCard.id}`);
      assert.equal(page.status, 200, name);
      assert.ok(page.text.includes("Card #9"), name + ": the card link stays");
      assert.ok(!page.text.includes("cv-lane"), name + ": no chip");
    } finally { srv.close(); }
  }
});

test("the manifest version moved", () => {
  const m = JSON.parse(readFileSync(join(REPO, "bundles/artifacts/manifest.json"), "utf8"));
  assert.equal(m.version, "0.9.1");
  const reg = JSON.parse(readFileSync(join(REPO, "registry/add-ons.json"), "utf8"));
  const entry = (reg["add-ons"] || reg.addons || reg).find?.((a) => a.id === "artifacts");
  assert.equal(entry?.version, "0.9.1", "the registry is in sync");
});

test("the viewer has a way back", async () => {
  const page = await import("../bundles/artifacts/panel/viewer-page.js");
  const make = page.renderViewerPage({ id: "art_abcdef", back: "make" });
  assert.match(make, /class="cv-back"[^>]*href="\/dashboard\/make"/);
  assert.ok(make.includes("‹ Make"));
  const chat = page.renderViewerPage({ id: "art_abcdef", back: "chat", thread: "perchlive-q" });
  assert.match(chat, /class="cv-back"[^>]*href="\/dashboard\/perch#perchlive-q"/);
  assert.ok(chat.includes("‹ Chat"));
  assert.match(page.renderViewerPage({ id: "art_abcdef", back: "chat", lang: "es" }), /class="cv-back"[^>]*href="\/dashboard\/perch"/);
  assert.ok(page.renderViewerPage({ id: "art_abcdef", back: "make", lang: "es" }).includes("‹ Crear"));
  assert.ok(!page.renderViewerPage({ id: "art_abcdef" }).includes("cv-back"), "no way back without from=");
  assert.equal(page.viewerParams({ from: "https://x" }).back, null);
  assert.equal(page.viewerParams({ from: "make" }).back, "make");
  assert.equal(page.viewerParams({ from: "chat" }).back, "chat");
  assert.equal(page.viewerParams({ from: ["make"] }).back, null);
  assert.equal(page.viewerParams({}).back, null);
  // The route reads it.
  const r = await get(s.srv, `/dashboard/artifacts/view/${s.loose.id}?from=make`);
  assert.match(r.text, /class="cv-back"[^>]*href="\/dashboard\/make"/);
  // Both links are 44 px tap targets.
  const css = readFileSync(join(REPO, "bundles/artifacts/panel/static/viewer.css"), "utf8");
  assert.match(css, /\.cv-back[^{]*\{[^}]*min-height:44px/);
  assert.match(css, /\.cv-card[^{]*\{[^}]*min-height:44px/);
});

test("Perch's artifact card asks for the way back", async () => {
  const { perchArtifactCardJs } = await import("../servers/gateway/dashboard/perch-hub/artifact-card.js");
  const js = perchArtifactCardJs("en");
  assert.ok(js.includes("from=chat"));
  const src = /function artViewerUrl\(id,sid,v\)\{[\s\S]*?\n  \}/.exec(js);
  assert.ok(src, "artViewerUrl found");
  const artViewerUrl = new Function(src[0] + "; return artViewerUrl;")();
  assert.equal(artViewerUrl("art_p", THREAD), "/dashboard/artifacts/view/art_p?thread=" + THREAD + "&from=chat");
  assert.equal(artViewerUrl("art_p", null), "/dashboard/artifacts/view/art_p?from=chat");
});

test("cardSummary: an unknown card, a bad id or a missing tasks.db is null, never a guess", async () => {
  const { cardSummary } = await import("../servers/gateway/make/card-docs.js");
  assert.equal(await cardSummary(s.db, 404), null);
  assert.equal(await cardSummary(s.db, "9; DROP"), null);
  assert.equal(await cardSummary(s.db, 0), null);
  const saved = process.env.CROW_TASKS_DB_PATH;
  process.env.CROW_TASKS_DB_PATH = join(dir, "absent", "tasks.db");
  try { assert.equal(await cardSummary(s.db, 9), null); } finally { process.env.CROW_TASKS_DB_PATH = saved; }
});

test("cardSummary: when the drawer link can't be worked out, the standalone card view", async () => {
  const { cardSummary } = await import("../servers/gateway/make/card-docs.js");
  const { createDbClient } = await import("../servers/db.js");
  const real = createDbClient(process.env.CROW_TASKS_DB_PATH);
  // The lane query works; cardDrawerHref's own card read fails.
  const tasksDb = {
    execute(q) {
      if (/^SELECT project_id(, id)? FROM tasks_items/.test(q.sql)) throw new Error("drawer read failed");
      return real.execute(q);
    },
  };
  try {
    const c = await cardSummary(s.db, 9, { tasksDb });
    assert.equal(c.href, "/dashboard/bot-board?card=9", "the standalone view, never the default bot's board (Q14)");
    assert.equal(c.lane, "needs_you", "the rest of the summary still stands");
    assert.equal(c.title, 'Write <the> "report"');
  } finally { real.close(); }
});

test("a poll (?poll=1) skips the card summary and omits card; other callers are unchanged", async () => {
  const { cardForDocument, cardSummary } = await import("../servers/gateway/make/card-docs.js");
  let summaries = 0;
  const srv = await mount({ importCardDocs: async () => ({ cardForDocument, cardSummary: async (...a) => { summaries++; return cardSummary(...a); } }) });
  try {
    const p = await get(srv, `/api/artifacts/${s.onCard.id}?poll=1`);
    assert.equal(p.status, 200);
    assert.equal(summaries, 0, "no summary computed on a poll");
    assert.ok(!("card" in p.body), "card is absent on a poll");
    assert.equal(p.body.artifact.id, s.onCard.id);
    const f = await get(srv, `/api/artifacts/${s.onCard.id}`);
    assert.equal(summaries, 1, "a normal load still computes one");
    assert.ok(f.body.card && f.body.card.id === 9);
  } finally { srv.close(); }
});

test("the viewer client's poll sends the flag; first load does not", () => {
  const src = readFileSync(join(REPO, "bundles/artifacts/panel/static/viewer-client.js"), "utf8");
  assert.match(src, /\?poll=1/);
  assert.match(src, /setTimeout\(function \(\) \{ S\.poll = null; refresh\("poll"\)/);
});
