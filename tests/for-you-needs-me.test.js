/**
 * For You's "What needs me" widget (widgets phase 1, Task 4), in three layers:
 *   - the markup needsMeWidgetHtml builds, from a summary: titles and project names escaped, an
 *     inline button only where the SUMMARY offered an action (a plan and a message row have none and
 *     their link is the way in), and the all-clear state with what the bots are doing;
 *   - the page the real For You handler builds over a scratch crow.db: the widget sits above Your
 *     morning, drawn from the real aggregator (an unread thread is the item), and a throwing
 *     aggregator costs only this card;
 *   - the emitted client, lifted out of the page's script and run in a vm over a linkedom page: a tap
 *     POSTs {key, action, nonce} with the CSRF header and repaints from the returned summary, a 409
 *     re-reads the summary instead of retrying, and any other failure shows the page's action-failed
 *     line.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { fromLaptop } from "./helpers/off-box.js";

import { needsMeWidgetHtml } from "../servers/gateway/dashboard/panels/for-you/html.js";
import { forYouClientJs } from "../servers/gateway/dashboard/panels/for-you/client.js";

// ─── the markup, from a summary ───

function summaryOf(over = {}) {
  return {
    id: "needs-me",
    title: "What needs me",
    updated_at: "2026-11-03T10:00:00.000Z",
    state: "ok",
    headline: "4 waiting",
    more_href: "/dashboard/bot-board",
    lock: { count: 4, label: "4 waiting" },
    doing: [],
    items: [
      {
        key: "card:7:decision", kind: "decision", title: "Ship the <b>widget</b>?", project: "Garden",
        href: "/dashboard/board?card=7", nonce: "n1",
        actions: [{ id: "option:0", label: "Yes", style: "primary" }, { id: "option:1", label: "Not yet", style: "plain" }],
      },
      {
        key: "card:8:result:12", kind: "result", title: "Finished the draft", project: null,
        href: "/dashboard/board?card=8", nonce: "n2",
        actions: [{ id: "accept", label: "Accept", style: "primary" }, { id: "not_now", label: "Not now", style: "plain" }],
      },
      {
        key: "card:9:plan:3", kind: "plan", title: "Plan for the garden", project: "Garden",
        href: "/dashboard/board?card=9", nonce: "n3", actions: [],
      },
      {
        key: "handoff:abc", kind: "handoff", title: "Call the plumber", project: null,
        href: "/dashboard/voice/handoffs/abc", nonce: "n4",
        actions: [{ id: "yes", label: "Yes", style: "primary" }, { id: "no", label: "No", style: "plain" }],
      },
      {
        key: "message:3", kind: "message", title: "Second user", project: null,
        href: "/dashboard/messages#peer-3", nonce: "n5", actions: [],
      },
    ],
    ...over,
  };
}

/** The markup of the row whose item key is `key`. */
function row(html, key) {
  const at = html.indexOf('data-fy-needs-item="' + key + '"');
  assert.ok(at >= 0, "the row for " + key + " must be drawn");
  return html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
}

/** The action ids a row drew, in order. */
function actIds(markup) {
  return [...markup.matchAll(/data-fy-needs-act="([^"]*)"/g)].map((m) => m[1]);
}

test("What needs me: every item's title and project, and buttons only where the summary offers them", () => {
  const html = needsMeWidgetHtml(summaryOf(), "en");
  assert.match(html, /<h2 class="fy-kicker" id="fy-needs-h">What needs me<\/h2>/);
  assert.match(html, /data-fy-needs-headline>4 waiting</);
  // Every title is escaped text, never markup.
  assert.match(html, /Ship the &lt;b&gt;widget&lt;\/b&gt;\?/, "the title is escaped");
  assert.ok(!html.includes("<b>widget</b>"), "nothing from a title became markup");
  for (const title of ["Finished the draft", "Plan for the garden", "Call the plumber", "Second user"]) {
    assert.ok(html.includes(title), title + " is drawn");
  }
  assert.ok(html.includes('<span class="fy-line-proj"> · Garden</span>'), "the project name rides with its rows");
  // A decision keeps its own options; a result its Accept / Not now; a hand-off its Yes / No.
  assert.deepEqual(actIds(row(html, "card:7:decision")), ["option:0", "option:1"]);
  assert.deepEqual(actIds(row(html, "card:8:result:12")), ["accept", "not_now"]);
  assert.deepEqual(actIds(row(html, "handoff:abc")), ["yes", "no"]);
  assert.match(row(html, "card:7:decision"), /data-fy-needs-nonce="n1"/, "the tap carries the state it was drawn from");
  assert.match(row(html, "card:7:decision"), /class="fy-btn fy-btn--primary" data-fy-needs-act="option:0"/);
});

test("a plan row (and a message row) has no button and links to its item", () => {
  const html = needsMeWidgetHtml(summaryOf(), "en");
  const plan = row(html, "card:9:plan:3");
  assert.deepEqual(actIds(plan), [], "inline plan approval does not exist");
  assert.ok(!plan.includes("<button"), "no button at all on a plan");
  assert.match(plan, /href="\/dashboard\/board\?card=9"/, "the card link is the way in");
  const msg = row(html, "message:3");
  assert.deepEqual(actIds(msg), [], "a message has nothing to answer in place");
  assert.match(msg, /href="\/dashboard\/messages#peer-3"/);
});

test("the empty state says All clear and lists what the bots are working on", () => {
  const html = needsMeWidgetHtml(summaryOf({
    state: "empty", headline: "All clear", items: [], lock: { count: 0, label: "0 waiting" },
    doing: ["Two cards in progress", "A blog draft"],
  }), "en");
  assert.match(html, /data-fy-needs-headline>All clear</);
  assert.match(html, /Your bots are working on/);
  for (const line of ["Two cards in progress", "A blog draft"]) assert.ok(html.includes(line), line);
  assert.equal(html.includes("data-fy-needs-item"), false, "no rows are drawn");
  assert.match(html, /data-fy-needs-list hidden/);
});

test("a summary that failed to load (null) is one line, not a broken page", () => {
  const html = needsMeWidgetHtml(null, "es");
  assert.match(html, /Lo que me espera/);
  assert.match(html, /no se pudo cargar ahora mismo/);
  assert.ok(!html.includes("data-fy-needs-act"), "nothing to tap");
});

// ─── the page, through the real For You handler ───

const dir = mkdtempSync(join(tmpdir(), "for-you-needs-me-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db"); // absent: no Board rows, the messages source still reads
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-for-you-needs-me");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

let panel;
const CONTACT_ID = 1;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?, 'peer-second', 'Second user', 'pk-ed', 'pk-sec')").run(CONTACT_ID);
  c.prepare("INSERT INTO messages (contact_id, content, direction, is_read, created_at) VALUES (?, 'Are you there?', 'received', 0, '2026-11-03 09:00:00')").run(CONTACT_ID);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')")
    .run(hashToken("owner-sess"));
  c.close();
  panel = await import("../servers/gateway/dashboard/panels/for-you.js");
});

after(() => {
  delete process.env.CROW_FOR_YOU;
  panel?._setForYouSeamsForTest({});
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.CROW_FOR_YOU = "1";
  panel._setForYouSeamsForTest({});
});

/** The page's content, through the panel's own handler (the owner's own session, from the laptop). */
async function renderPage() {
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  let content = null;
  const res = { status() { return this; }, type() { return this; }, send() { return this; } };
  try {
    const out = await panel.default.handler(
      fromLaptop({ method: "GET", query: {}, dashboardSession: "owner-sess" }),
      res,
      { db, lang: "en", layout: (page) => { content = page.content; return "page"; } },
    );
    assert.equal(out, "page");
  } finally { db.close(); }
  return content || "";
}

/** The widget's own markup, out of the page (the client script also names its attributes). */
function needsSection(content) {
  const at = content.indexOf('<section class="fy-card fy-needs"');
  assert.ok(at >= 0, "the widget is on the page");
  return content.slice(at, content.indexOf("</section>", at));
}

test("the page draws What needs me first, above Your morning, from the real aggregator", async () => {
  const content = await renderPage();
  const widget = needsSection(content);
  assert.ok(content.indexOf('data-fy-needs') < content.indexOf('id="fy-morning-h"'), "above Your morning");
  assert.match(widget, /What needs me/);
  assert.match(widget, /1 waiting/);
  assert.match(widget, /Unread message/, "the message row says what it is");
  assert.match(widget, /Second user/, "the thread's contact is the title");
  assert.match(widget, new RegExp('href="/dashboard/messages#peer-' + CONTACT_ID + '"'));
  assert.ok(!widget.includes("data-fy-needs-act"), "a message has no inline action");
  assert.match(widget, /href="\/dashboard\/bot-board"/, "the full list is one tap away");
});

test("a failing aggregator costs only this card: the page still renders", async () => {
  panel._setForYouSeamsForTest({
    needsMe: async () => { throw new Error("aggregator down"); },
  });
  const content = await renderPage();
  assert.match(needsSection(content), /What needs me couldn't load just now\./);
  assert.match(content, /id="fy-morning-h"/, "Your morning still renders");
  assert.match(content, /Nothing needs you this morning\./, "…with its own facts");
});

// ─── the emitted client, lifted and run ───

/** The page's script with its tags off (it is emitted inside a template literal). */
function clientSource() {
  const js = forYouClientJs();
  assert.ok(!js.includes("`"), "client.js may carry no backtick: it is emitted inside a template literal");
  assert.ok(!js.includes("${"), "and no ${ either");
  return js.replace(/^<script>\s*/, "").replace(/<\/script>\s*$/, "");
}

const SCRIPT = clientSource();

/**
 * A page with the widget's markup, the click listener captured, and a fetch stub that answers with
 * the given responses in order. Nothing here re-proves what a browser does with textContent.
 */
function rig(responses) {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div class="fy" data-fy data-fy-failed="That action failed.">
      <section class="fy-card fy-needs" data-fy-needs data-fy-needs-error="It could not load."
        data-fy-needs-doing-label="Your bots are working on"
        data-fy-needs-kind-decision="Decision" data-fy-needs-kind-message="Unread message">
        <h2 class="fy-kicker" id="fy-needs-h">What needs me</h2>
        <p class="fy-sum" data-fy-needs-headline>1 waiting</p>
        <ul class="fy-lines fy-needs-list" data-fy-needs-list>
          <li class="fy-needs-item" data-fy-needs-item="card:7:decision">
            <a class="fy-line" href="/dashboard/board?card=7"><span class="fy-line-text"><span class="fy-line-tag">Decision</span><span class="fy-line-title">Ship it?</span></span></a>
            <div class="fy-acts fy-needs-acts">
              <button type="button" class="fy-btn fy-btn--primary" data-fy-needs-act="option:0" data-fy-needs-key="card:7:decision" data-fy-needs-nonce="abc123">Yes</button>
            </div>
          </li>
        </ul>
        <p class="fy-kicker" data-fy-needs-doing-h hidden>Your bots are working on</p>
        <ul class="fy-lines" data-fy-needs-doing hidden></ul>
        <p class="fy-status" role="status" data-fy-needs-status></p>
      </section>
    </div>
  </body></html>`);
  Object.defineProperty(document, "cookie", { value: "crow_csrf=tok%2B1; other=1", configurable: true });
  const root = document.querySelector("[data-fy]");
  const listeners = {};
  root.addEventListener = (type, fn) => { listeners[type] = fn; };
  const calls = [];
  let i = 0;
  const fetchStub = (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = responses[Math.min(i++, responses.length - 1)] || { status: 500, json: null };
    return Promise.resolve({
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: () => (r.json == null ? Promise.reject(new Error("no json")) : Promise.resolve(r.json)),
    });
  };
  vm.runInContext(SCRIPT, vm.createContext({ document, window: {}, fetch: fetchStub, console }));
  const click = (el) => listeners.click({ target: el });
  return { document, root, calls, click, widget: document.querySelector("[data-fy-needs]") };
}

const tick = async () => { for (let n = 0; n < 4; n++) await new Promise((r) => setImmediate(r)); };

test("a tap posts its key, action and nonce with the CSRF header, then repaints from the summary", async () => {
  const r = rig([{
    status: 200,
    json: {
      ok: true,
      summary: {
        state: "empty", headline: "All clear", items: [], doing: ["Two cards in progress"],
        lock: { count: 0, label: "0 waiting" },
      },
    },
  }]);
  r.click(r.document.querySelector("[data-fy-needs-act]"));
  await tick();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "/dashboard/widgets-api/needs-me/act");
  assert.equal(r.calls[0].opts.method, "POST");
  assert.equal(r.calls[0].opts.headers["x-crow-csrf"], "tok+1", "the page's CSRF cookie, decoded");
  assert.equal(r.calls[0].opts.credentials, "same-origin");
  assert.deepEqual(r.calls[0].body, { key: "card:7:decision", action: "option:0", nonce: "abc123" });
  // The answer's summary is what the widget now shows: the answered row is gone, all clear.
  assert.equal(r.widget.querySelector("[data-fy-needs-headline]").textContent, "All clear");
  assert.equal(r.widget.querySelectorAll("[data-fy-needs-item]").length, 0);
  assert.equal(r.widget.querySelector("[data-fy-needs-doing]").textContent, "Two cards in progress");
  assert.equal(r.widget.querySelector("[data-fy-needs-doing]").hasAttribute("hidden"), false);
});

test("a 409 re-reads the summary and draws that instead of retrying the action", async () => {
  const r = rig([
    { status: 409, json: { code: "stale" } },
    // The read answers the summary itself (the route's GET body), not a wrapper around it.
    {
      status: 200,
      json: {
        state: "ok", headline: "1 waiting",
        items: [{
          key: "card:8:result:12", kind: "message", title: "Something else", project: null,
          href: "/dashboard/messages#peer-4", nonce: "zzz", actions: [],
        }],
        doing: [], lock: { count: 1, label: "1 waiting" },
      },
    },
  ]);
  r.click(r.document.querySelector("[data-fy-needs-act]"));
  await tick();
  assert.equal(r.calls.length, 2, "the act, then one read");
  assert.equal(r.calls[1].url, "/dashboard/widgets-api/needs-me");
  assert.equal(r.calls[1].opts.method || "GET", "GET");
  assert.equal(r.widget.querySelector("[data-fy-needs-headline]").textContent, "1 waiting");
  const rows = r.widget.querySelectorAll("[data-fy-needs-item]");
  assert.equal(rows.length, 1, "the fresh summary replaced the row");
  assert.equal(rows[0].getAttribute("data-fy-needs-item"), "card:8:result:12");
  assert.equal(rows[0].querySelector(".fy-line-title").textContent, "Something else");
  assert.equal(rows[0].querySelectorAll("button").length, 0, "no actions: nothing to tap");
});

test("any other failure is the page's own action-failed line, and the buttons come back", async () => {
  const r = rig([{ status: 400, json: { code: "bad_action" } }]);
  const btn = r.document.querySelector("[data-fy-needs-act]");
  r.click(btn);
  await tick();
  assert.equal(r.calls.length, 1, "no refresh on a bad action");
  assert.equal(r.widget.querySelector("[data-fy-needs-status]").textContent, "That action failed.");
  assert.equal(r.document.querySelector("[data-fy-needs-act]").disabled, false, "the tap can be tried again");
});
test("a 409 whose re-read fails keeps the rows and shows the failed line", async () => {
  const r = rig([
    { status: 409, json: { code: "stale" } },
    { status: 500, json: { error: "The action failed", code: "error" } },
  ]);
  r.click(r.document.querySelector("[data-fy-needs-act]"));
  await tick();
  assert.equal(r.calls.length, 2);
  assert.equal(r.widget.querySelectorAll("[data-fy-needs-item]").length, 1, "the old row stays");
  assert.equal(r.widget.querySelector("[data-fy-needs-headline]").textContent, "1 waiting");
  assert.equal(r.widget.querySelector("[data-fy-needs-status]").textContent, "That action failed.");
});

test("a later tap clears the failed line, and a second tap while one is in flight does nothing", async () => {
  const r = rig([
    { status: 400, json: { code: "bad_action" } },
    { status: 200, json: { ok: true, summary: { state: "empty", headline: "All clear", items: [], doing: [], lock: { count: 0, label: "0 waiting" } } } },
  ]);
  const btn = r.document.querySelector("[data-fy-needs-act]");
  r.click(btn);
  await tick();
  assert.equal(r.widget.querySelector("[data-fy-needs-status]").textContent, "That action failed.");
  r.click(btn);
  r.click(btn);
  await tick();
  assert.equal(r.calls.length, 2, "the in-flight second tap sent nothing");
  assert.equal(r.widget.querySelector("[data-fy-needs-status]").textContent, "");
  assert.equal(r.widget.querySelector("[data-fy-needs-headline]").textContent, "All clear");
});

test("a repainted row keeps only same-site links and names its buttons", async () => {
  const r = rig([{
    status: 200,
    json: { ok: true, summary: { state: "ok", headline: "2 waiting", doing: [], lock: { count: 2, label: "2 waiting" }, items: [
      { key: "handoff:3", kind: "decision", title: "Send it", project: null, href: "javascript:alert(1)", nonce: "n", actions: [{ id: "yes", label: "Yes", style: "primary" }] },
      { key: "message:4", kind: "message", title: "Hi", project: null, href: "//evil.example/x", nonce: "m", actions: [] },
    ] } },
  }]);
  r.click(r.document.querySelector("[data-fy-needs-act]"));
  await tick();
  const links = r.widget.querySelectorAll("[data-fy-needs-item] a");
  assert.equal(links[0].getAttribute("href"), "/dashboard/bot-board");
  assert.equal(links[1].getAttribute("href"), "/dashboard/bot-board");
  assert.equal(r.widget.querySelector("[data-fy-needs-act]").getAttribute("aria-label"), "Yes: Send it");
});
