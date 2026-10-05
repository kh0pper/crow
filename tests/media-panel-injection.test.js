/**
 * Media panel — feed-supplied data must never become markup or script.
 *
 * Everything a subscribed feed controls (titles, links, enclosure URLs,
 * image URLs, source names, authors, summaries, topics, dates) is seeded
 * with hostile values, then every affected view is rendered through the
 * REAL panel handler and the REAL public playlist route. The output is
 * parsed into a DOM (linkedom) and audited the way a browser would see it:
 *
 *   - no inline event handler carries feed data,
 *   - no href/src carries a script-capable scheme (javascript:, data:, ...),
 *   - no feed string breaks out of its attribute or text node into markup,
 *   - no feed string lands inside an inline <script>.
 *
 * The panel's client script is then run in a vm against the rendered
 * buttons to prove the data-* + delegated-listener wiring still plays audio
 * and that values round-trip as DATA (quotes and backslashes intact).
 *
 * Env discipline: HOME, CROW_DATA_DIR and CROW_DB_PATH point at a scratch
 * dir BEFORE the bundle is imported, so nothing resolves to a real install.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import vm from "node:vm";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "media-panel-injection-"));

const savedEnv = {
  HOME: process.env.HOME,
  CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_DB_PATH: process.env.CROW_DB_PATH,
};
process.env.HOME = SCRATCH;
process.env.CROW_DATA_DIR = SCRATCH;
process.env.CROW_DB_PATH = join(SCRATCH, "crow.db");

// Dynamic imports: static ones are hoisted above the env writes above.
const { createDbClient } = await import("../servers/db.js");
const { initMediaTables } = await import("../bundles/media/server/init-tables.js");
const { default: panel } = await import("../bundles/media/panel/media.js");
const { mediaPublicRouter } = await import("../bundles/media/panel/routes.js");

const db = createDbClient();
await initMediaTables(db);
// The Podcasts tab also lists the standalone podcast bundle's subscriptions.
await db.execute(`CREATE TABLE IF NOT EXISTS podcast_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, feed_url TEXT NOT NULL UNIQUE,
  title TEXT, description TEXT, image_url TEXT, last_fetched TEXT)`);

// ---------------------------------------------------------------------------
// Hostile fixture. Every payload names a function containing "pwned" (any
// case), so a single marker identifies feed data wherever it ends up.
// ---------------------------------------------------------------------------
const MARK = /pwned/i;

const HOSTILE_TITLE = `It's "quoted" \\ </script><script>PWNED_TITLE()</script><img src=x onerror=PWNED_TITLE2()>`;
const HOSTILE_AUDIO = `https://cdn.example.test/ep.mp3?a=1');PWNED_AUDIO();//`;
const BENIGN = {
  title: "Benign Title Zebra",
  url: "https://news.example.test/story?id=1&ref=feed",
  image: "https://img.example.test/pic.jpg",
  audio: "https://cdn.example.test/zebra.mp3?x=1&y=2",
};

async function insert(sql, args) {
  const r = await db.execute({ sql, args });
  return Number(r.lastInsertRowid);
}
const addSource = (type, name, url, category, config) =>
  insert("INSERT INTO media_sources (source_type, name, url, category, config, last_fetched) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    [type, name, url, category, JSON.stringify(config)]);
const addArticle = (sourceId, guid, a) =>
  insert(`INSERT INTO media_articles (source_id, guid, url, title, author, pub_date, summary, image_url, audio_url, topics)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sourceId, guid, a.url ?? null, a.title, a.author ?? null, a.pub_date ?? null, a.summary ?? null,
     a.image_url ?? null, a.audio_url ?? null, a.topics ?? null]);

const srcHostile = await addSource("rss",
  `Evil "Feed" O'Brien <img src=x onerror=PWNED_SRCNAME()>`, "https://feeds.example.test/a.xml",
  `cat'"><svg onload=PWNED_CAT()>`, { image: "javascript:PWNED_SRCIMG()" });
const srcNews = await addSource("google_news", "Google News: zebra", "https://feeds.example.test/b.xml", null, {});
const srcPodcast = await addSource("podcast",
  `Pod </script><script>PWNED_PODNAME()</script>`, "https://feeds.example.test/c.xml", null,
  { image: "data:text/html,<script>PWNED_PODIMG()</script>" });
const srcBenign = await addSource("rss", "Benign Source", "https://feeds.example.test/d.xml", "tech",
  { image: "https://img.example.test/logo.png?a=1&b=2" });

const artHostile = await addArticle(srcHostile, "g1", {
  title: HOSTILE_TITLE,
  url: "javascript:PWNED_URL()",
  image_url: "data:text/html,<script>PWNED_IMG()</script>",
  audio_url: HOSTILE_AUDIO,
  author: `Auth'"><img src=x onerror=PWNED_AUTHOR1()>`,
  pub_date: "<img src=x onerror=pwned_date()>",
  summary: `sum'"><img src=x onerror=PWNED_SUMMARY()></script><script>PWNED_SUMMARY2()</script>`,
  topics: JSON.stringify([`t'"><svg onload=PWNED_TOPIC()>`]),
});
const artBreakout = await addArticle(srcHostile, "g2", {
  title: `Second ' onmouseover='PWNED_TITLE3()' x='`,
  url: `https://example.test/a" onmouseover="PWNED_URL2()`,
  image_url: `https://img.example.test/i.png" onerror="PWNED_IMG2()`,
  audio_url: "javascript:PWNED_AUDIO2()",
  pub_date: "2026-01-02T00:00:00Z",
});
await addArticle(srcHostile, "g3", {
  title: "Third",
  url: " \tJaVaScRiPt:PWNED_URL3()",
  image_url: "vbscript:PWNED_IMG3()",
  audio_url: "data:text/html,<script>PWNED_AUDIO3()</script>",
  pub_date: "2026-01-03T00:00:00Z",
});
await addArticle(srcNews, "g4", {
  title: "Masthead",
  url: "https://news.example.test/masthead",
  author: `Pub'"><img src=x onerror=PWNED_AUTHOR2()>`,
  pub_date: "2026-01-04T00:00:00Z",
});
await addArticle(srcPodcast, "g5", {
  title: `Episode <img src=x onerror=PWNED_EPTITLE()>`,
  audio_url: "javascript:PWNED_EPAUDIO()",
  pub_date: "2026-01-05T00:00:00Z",
});
const artBenign = await addArticle(srcBenign, "g6", {
  title: BENIGN.title, url: BENIGN.url, image_url: BENIGN.image, audio_url: BENIGN.audio,
  pub_date: "2026-01-06T00:00:00Z", summary: "A calm summary.", topics: JSON.stringify(["calm"]),
});

const HOSTILE_BRIEFING = `Briefing: x\\'"><img src=x onerror=PWNED_BRIEF()>`;
const briefingId = await insert(
  "INSERT INTO media_briefings (title, script, audio_path, article_ids) VALUES (?, ?, ?, ?)",
  [HOSTILE_BRIEFING, "script", "/nonexistent/briefing.mp3", "[1]"]);

const playlistId = await insert(
  "INSERT INTO media_playlists (name, description, slug, visibility) VALUES (?, ?, ?, 'public')",
  [`Mix <img src=x onerror=PWNED_PLNAME()>`, `Desc'"><img src=x onerror=PWNED_PLDESC()>`, "evil-mix"]);
let position = 0;
for (const id of [artHostile, artBreakout, artBenign]) {
  await insert("INSERT INTO media_playlist_items (playlist_id, item_type, item_id, position) VALUES (?, 'article', ?, ?)",
    [playlistId, id, ++position]);
}

await insert("INSERT INTO media_smart_folders (name, query_json) VALUES (?, ?)", [
  `Folder <img src=x onerror=PWNED_FOLDERNAME()>`,
  JSON.stringify({ category: `<img src=x onerror=PWNED_FOLDERCAT()>`, fts_query: `<img src=x onerror=PWNED_FOLDERQ()>` }),
]);

// ---------------------------------------------------------------------------
// Rendering + the browser's-eye audit
// ---------------------------------------------------------------------------
async function renderTab(query) {
  let captured = null;
  const req = { method: "GET", query, body: {} };
  const res = { redirectAfterPost() { throw new Error("unexpected redirect on a GET"); } };
  await panel.handler(req, res, {
    db,
    appRoot: REPO_ROOT,
    layout: (opts) => { captured = opts; return ""; },
  });
  assert.ok(captured, "the handler must render through layout()");
  return { content: captured.content, scripts: captured.scripts || "" };
}

const asPage = ({ content, scripts }) =>
  `<!doctype html><html><body><main>${content}</main><script id="panel-scripts">${scripts}</script></body></html>`;

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "srcset", "xlink:href"]);
const scheme = (value) => String(value).replace(/[\u0000- ]/g, "").toLowerCase();

/** Returns the parsed document plus every injection finding in it. */
function audit(html, { feedStrings = [] } = {}) {
  const { document } = parseHTML(html);
  const problems = [];
  for (const el of document.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = String(attr.value);
      const where = `<${el.localName} ${name}="${value.slice(0, 90)}">`;
      if (name.startsWith("on") && (MARK.test(value) || feedStrings.some((s) => value.includes(s)))) {
        problems.push(`inline handler carries feed data: ${where}`);
      }
      if (URL_ATTRS.has(name) && /^(javascript|data|vbscript):/.test(scheme(value))) {
        problems.push(`script-capable URL: ${where}`);
      }
      if (MARK.test(name)) problems.push(`feed data became an attribute name: ${where}`);
    }
    if (MARK.test(el.localName)) problems.push(`feed data became an element: <${el.localName}>`);
  }
  for (const s of document.querySelectorAll("script")) {
    if (MARK.test(s.textContent) || feedStrings.some((f) => s.textContent.includes(f))) {
      problems.push("feed data inside an inline <script>");
    }
  }
  return { document, problems };
}

/** The benign article's values count as feed data too: none may sit in a handler. */
const BENIGN_FEED_STRINGS = ["Zebra", "example.test"];

function assertClean(html, label) {
  const { document, problems } = audit(html, { feedStrings: BENIGN_FEED_STRINGS });
  assert.deepEqual(problems, [], `${label}: injection findings\n  ${problems.join("\n  ")}`);
  return document;
}

after(() => {
  try { db.close(); } catch {}
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The audit itself must be able to see the defect class (no vacuous pass).
// ---------------------------------------------------------------------------
test("the audit detects each injection shape it is meant to rule out", () => {
  const cases = {
    "handler breakout": `<button onclick="p.load('https://x.example.test/a.mp3');PWNED();//','t')">x</button>`,
    "handler with benign feed data": `<button onclick="p.load('https://cdn.example.test/zebra.mp3','Zebra')">x</button>`,
    "javascript: href": `<a href="javascript:PWNED()">x</a>`,
    "obfuscated javascript: href": `<a href=" &#9;JaVaScRiPt:alert(1)">x</a>`,
    "data: src": `<img src="data:text/html,<b>x</b>">`,
    "attribute breakout": `<a href="https://example.test/a" onmouseover="PWNED()">x</a>`,
    "markup in text": `<div><img src=x onerror=PWNED()></div>`,
    "script breakout": `<script>var a = 1;</script><script>PWNED()</script>`,
  };
  for (const [label, html] of Object.entries(cases)) {
    assert.notEqual(audit(html, { feedStrings: BENIGN_FEED_STRINGS }).problems.length, 0, `audit missed: ${label}`);
  }
  assert.deepEqual(audit(`<a href="https://example.test/a?b=1&amp;c=2" data-title="PWNED()">It&#39;s &lt;b&gt;</a>`).problems, []);
});

// ---------------------------------------------------------------------------
// Dashboard panel views
// ---------------------------------------------------------------------------
test("feed tab: hostile article data stays inert", async () => {
  const doc = assertClean(asPage(await renderTab({ tab: "feed" })), "feed tab");
  const titles = [...doc.querySelectorAll(".media-card h4")].map((h) => h.textContent.trim());
  assert.ok(titles.includes(HOSTILE_TITLE), "the hostile title is shown verbatim, as text");
  assert.equal(doc.querySelectorAll(".media-card").length, 6);
});

test("feed tab: search results and the reflected query stay inert", async () => {
  const query = { tab: "feed", q: `Zebra'"><img src=x onerror=PWNED_QUERY()>` };
  assertClean(asPage(await renderTab(query)), "feed search");
});

test("feed tab: only http(s) links, images and audio are rendered", async () => {
  const doc = assertClean(asPage(await renderTab({ tab: "feed" })), "feed tab");
  const cards = [...doc.querySelectorAll(".media-card")];
  const cardFor = (title) => cards.find((c) => c.querySelector("h4").textContent.trim() === title);

  // javascript:/data: values are dropped: plain-text title, placeholder art.
  const hostile = cardFor(HOSTILE_TITLE);
  assert.equal(hostile.querySelector("h4 a"), null, "a javascript: link is not rendered as a link");
  assert.equal(hostile.querySelector("img"), null, "a data: image is not rendered");
  const third = cardFor("Third");
  assert.equal(third.querySelector("a"), null);
  assert.equal(third.querySelector("img"), null);
  assert.equal(third.querySelector('[data-media-action="play"]'), null, "a data: enclosure gets no play button");

  // Legitimate values are untouched.
  const benign = cardFor(BENIGN.title);
  assert.equal(benign.querySelector("h4 a").getAttribute("href"), BENIGN.url);
  assert.equal(benign.querySelector("img").getAttribute("src"), BENIGN.image);
  const play = benign.querySelector('[data-media-action="play"]');
  assert.equal(play.getAttribute("data-audio-url"), BENIGN.audio);
  assert.equal(play.getAttribute("data-title"), BENIGN.title);
  assert.equal(play.getAttribute("onclick"), null);

  // A quote-laden https link stays ONE attribute and still parses as https.
  const breakout = cardFor(`Second ' onmouseover='PWNED_TITLE3()' x='`);
  const href = breakout.querySelector("h4 a").getAttribute("href");
  assert.equal(new URL(href).protocol, "https:");
  assert.equal(new URL(href).hostname, "example.test");
  assert.equal(breakout.querySelector('[data-media-action="play"]'), null, "a javascript: enclosure gets no play button");
});

test("sources tab: hostile source names, categories and artwork stay inert", async () => {
  const doc = assertClean(asPage(await renderTab({ tab: "sources" })), "sources tab");
  const imgs = [...doc.querySelectorAll("main img")].map((i) => i.getAttribute("src"));
  assert.deepEqual(imgs, ["https://img.example.test/logo.png?a=1&b=2"], "only the http(s) artwork is rendered");
});

test("podcasts tab: hostile episode data and enclosure URLs stay inert", async () => {
  const doc = assertClean(asPage(await renderTab({ tab: "podcasts" })), "podcasts tab");
  const sources = [...doc.querySelectorAll("audio source")].map((s) => s.getAttribute("src"));
  assert.ok(sources.includes(BENIGN.audio), "a legitimate enclosure still gets a player");
  for (const src of sources) assert.match(src, /^https?:\/\//);
  assert.equal(doc.querySelectorAll("main img").length, 0, "the data: podcast artwork is not rendered");
});

test("playlist detail: hostile item titles stay inert", async () => {
  const doc = assertClean(
    asPage(await renderTab({ tab: "playlists", playlist_id: String(playlistId) })), "playlist detail");
  const listen = [...doc.querySelectorAll('[data-media-action="listen"]')];
  assert.equal(listen.length, 3);
  assert.equal(listen[0].getAttribute("data-title"), HOSTILE_TITLE);
  assert.equal(listen[0].getAttribute("data-article-id"), String(artHostile));
});

test("playlists tab: hostile playlist names stay inert", async () => {
  assertClean(asPage(await renderTab({ tab: "playlists" })), "playlists tab");
});

test("briefings tab: the play button carries its title as data", async () => {
  const doc = assertClean(asPage(await renderTab({ tab: "briefings" })), "briefings tab");
  const play = doc.querySelector('[data-media-action="play"]');
  assert.equal(play.getAttribute("data-audio-url"), `/api/media/briefings/${briefingId}/audio`);
  assert.equal(play.getAttribute("data-title"), HOSTILE_BRIEFING);
});

test("folders tab: stored folder filters are escaped", async () => {
  const doc = assertClean(asPage(await renderTab({ tab: "folders" })), "folders tab");
  assert.equal(doc.querySelectorAll("main img").length, 0);
  assert.ok(doc.querySelector("main").textContent.includes("<img src=x onerror=PWNED_FOLDERCAT()>"));
});

// ---------------------------------------------------------------------------
// Client script: data-* + one delegated listener
// ---------------------------------------------------------------------------
function runClientScript(scripts, { times = 1 } = {}) {
  const listeners = [];
  const calls = { load: [], fetch: [] };
  const sandbox = {
    document: {
      addEventListener: (type, fn) => listeners.push({ type, fn }),
      getElementById: () => null,
    },
    location: { href: "https://dash.example.test/dashboard/media?tab=feed", reload() {} },
    URL,
    console,
    setTimeout,
    alert() {},
    fetch: (url, opts) => {
      calls.fetch.push({ url, opts });
      return Promise.resolve({ json: async () => ({ audio_url: `${url.replace(/\/listen$/, "")}/audio` }) });
    },
    crowPlayer: { load: (src, title) => calls.load.push({ src, title }) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (let i = 0; i < times; i++) new vm.Script(scripts, { filename: "media-panel-client.js" }).runInContext(sandbox);
  const click = (el) => {
    for (const l of listeners) if (l.type === "click") l.fn({ target: el });
  };
  return { listeners, calls, click };
}

test("client script: parses, has no template-literal hazards, binds its listener once", async () => {
  const { scripts } = await renderTab({ tab: "feed" });
  assert.ok(!scripts.includes("`"), "client code must never contain a backtick");
  const once1 = runClientScript(scripts);
  assert.equal(once1.listeners.filter((l) => l.type === "click").length, 1);
  // Under Turbo the panel script re-runs on every navigation into the panel.
  const twice = runClientScript(scripts, { times: 3 });
  assert.equal(twice.listeners.filter((l) => l.type === "click").length, 1, "re-running must not stack listeners");
});

test("client script: play and listen buttons pass feed values as data", async () => {
  const rendered = await renderTab({ tab: "feed" });
  const doc = assertClean(asPage(rendered), "feed tab");
  const { calls, click } = runClientScript(rendered.scripts);
  const cards = [...doc.querySelectorAll(".media-card")];
  const cardFor = (title) => cards.find((c) => c.querySelector("h4").textContent.trim() === title);

  // Benign enclosure: plays exactly what the feed supplied.
  click(cardFor(BENIGN.title).querySelector('[data-media-action="play"]'));
  assert.deepEqual(calls.load, [{ src: BENIGN.audio, title: BENIGN.title }]);

  // Hostile enclosure: still an https URL, handed over as one inert string.
  calls.load.length = 0;
  click(cardFor(HOSTILE_TITLE).querySelector('[data-media-action="play"]'));
  assert.equal(calls.load.length, 1);
  assert.equal(new URL(calls.load[0].src).hostname, "cdn.example.test");
  assert.equal(calls.load[0].title, HOSTILE_TITLE, "quotes and backslashes survive as data");

  // Listen (TTS): the article id reaches the API, the title reaches the player.
  calls.load.length = 0;
  click(cardFor(HOSTILE_TITLE).querySelector('[data-media-action="listen"]'));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.fetch.at(-1).url, `/api/media/articles/${artHostile}/listen`);
  assert.deepEqual(calls.load, [{ src: `/api/media/articles/${artHostile}/audio`, title: HOSTILE_TITLE }]);

  // A click that is not on a media button does nothing.
  calls.load.length = 0;
  click(cardFor(BENIGN.title).querySelector("h4"));
  assert.equal(calls.load.length, 0);
});

test("client script: a script-capable URL on a play button is refused client-side too", async () => {
  const { scripts } = await renderTab({ tab: "feed" });
  const { calls, click } = runClientScript(scripts);
  const { document } = parseHTML(
    `<button id="a" data-media-action="play" data-audio-url="javascript:PWNED()" data-title="x">p</button>` +
    `<button id="b" data-media-action="play" data-audio-url="data:text/html,x" data-title="x">p</button>` +
    `<button id="c" data-media-action="play" data-audio-url="/api/media/briefings/7/audio" data-title="ok">p</button>`);
  click(document.getElementById("a"));
  click(document.getElementById("b"));
  assert.equal(calls.load.length, 0);
  click(document.getElementById("c"));
  assert.deepEqual(calls.load, [{ src: "/api/media/briefings/7/audio", title: "ok" }]);
});

// ---------------------------------------------------------------------------
// Companion-bundle tabs (Library / Live / Remote): rendered client-side from
// another service's JSON, so the scheme check lives in the client code.
// ---------------------------------------------------------------------------
function fakeElement(tag) {
  return {
    tag, style: {}, children: [],
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    isConnected: true,
  };
}
const flatten = (el) => [el, ...el.children.flatMap(flatten)];

/** Runs a tab's inline script against a fake DOM fed by `payloads` (url -> JSON). */
async function runTabScript(tab, containerId, payloads) {
  const { content } = await renderTab({ tab });
  const { document } = parseHTML(`<!doctype html><html><body>${content}</body></html>`);
  const code = [...document.querySelectorAll("script")].map((s) => s.textContent).join("\n");
  assert.ok(code.length > 0, `${tab}: the tab renders an inline script`);
  assert.ok(!code.includes("`"), `${tab}: client code must never contain a backtick`);
  const container = fakeElement("div");
  const loads = [];
  const sandbox = {
    document: {
      getElementById: (id) => (id === containerId ? container : null),
      createElement: fakeElement,
    },
    location: { href: "https://dash.example.test/dashboard/media" },
    URL, console,
    setTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    fetch: (url) => Promise.resolve({ ok: true, status: 200, json: async () => payloads[url] ?? {} }),
    crowPlayer: { load: (...args) => loads.push(args) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: `media-panel-${tab}.js` }).runInContext(sandbox);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { nodes: flatten(container) };
}

test("library, live and remote tabs: remote-supplied URLs are scheme-checked before use", async () => {
  mkdirSync(join(SCRATCH, ".crow"), { recursive: true });
  writeFileSync(join(SCRATCH, ".crow", "installed.json"), JSON.stringify(["jellyfin", "iptv", "kodi"]));
  try {
    const unsafe = (n) => /^(javascript|data|vbscript):/.test(scheme(n.href ?? "")) || /^(javascript|data|vbscript):/.test(scheme(n.src ?? ""));

    const library = await runTabScript("library", "library-content", {
      "/api/jellyfin/recent": { items: [
        { Name: "Hostile", Type: "Movie", ImageUrl: "data:text/html,<script>PWNED()</script>", StreamUrl: "javascript:PWNED()" },
        { Name: "Benign", Type: "Movie", ImageUrl: "https://img.example.test/p.jpg", StreamUrl: "/api/jellyfin/stream/7" },
      ] },
    });
    assert.deepEqual(library.nodes.filter(unsafe), []);
    assert.deepEqual(library.nodes.filter((n) => n.tag === "a").map((n) => n.href), ["/api/jellyfin/stream/7"]);
    assert.deepEqual(library.nodes.filter((n) => n.tag === "img").map((n) => n.src), ["https://img.example.test/p.jpg"]);

    const live = await runTabScript("live", "live-content", {
      "/api/iptv/channels?favorites_only=true": { channels: [
        { name: "Hostile", logo: "javascript:PWNED()", stream_url: " JaVaScRiPt:PWNED()" },
        { name: "Benign", logo: "https://img.example.test/l.png", stream_url: "https://tv.example.test/1.m3u8" },
      ] },
    });
    assert.deepEqual(live.nodes.filter(unsafe), []);
    assert.deepEqual(live.nodes.filter((n) => n.tag === "a").map((n) => n.href), ["https://tv.example.test/1.m3u8"]);
    assert.deepEqual(live.nodes.filter((n) => n.tag === "img").map((n) => n.src), ["https://img.example.test/l.png"]);

    const remote = await runTabScript("remote", "remote-content", {
      "/api/kodi/now-playing": { title: "Now", thumbnail: "javascript:PWNED()" },
    });
    assert.ok(remote.nodes.some((n) => n.textContent === "Now"), "the now-playing card rendered");
    assert.deepEqual(remote.nodes.filter((n) => n.tag === "img"), []);
  } finally {
    rmSync(join(SCRATCH, ".crow"), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Public playlist page (served without authentication)
// ---------------------------------------------------------------------------
test("public playlist page: hostile article data stays inert", async () => {
  const app = express();
  app.use(mediaPublicRouter());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/media/playlists/evil-mix`);
    assert.equal(res.status, 200);
    const doc = assertClean(await res.text(), "public playlist page");

    const links = [...doc.querySelectorAll(".container a")].map((a) => a.getAttribute("href"));
    assert.ok(links.includes(BENIGN.url), "a legitimate article link is kept");
    for (const href of links) assert.match(href, /^(https?:\/\/|#$)/, `unexpected link target: ${href}`);
    const imgs = [...doc.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    assert.ok(imgs.includes(BENIGN.image));
    for (const src of imgs) assert.match(src, /^https?:\/\//);
    assert.ok(doc.body.textContent.includes(HOSTILE_TITLE), "the hostile title is shown verbatim, as text");
  } finally {
    server.close();
  }
});
