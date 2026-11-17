/**
 * Crow Mail's reader client script (plan 2, Task 8), run for real in linkedom + node:vm over the
 * markup the panel draws:
 *   - the script never arrives with a body: every iframe is built here from a frame slot, with the
 *     sandbox set before the src and a fresh per-load nonce in the URL's fragment and in
 *     data-ml-nonce; a slot is used only when its data-sandbox is exactly the server's own sandbox
 *     value — any other value, including one differing only in case, leaves the slot empty;
 *   - the one window message listener accepts a frame's report only from that frame's own
 *     contentWindow, from the opaque origin ("null") and with that frame's own nonce; it floors and
 *     clamps the height, and hides the image banner for a zero count and shows it for more;
 *   - Show images rebuilds the frame for this load only, and Always show posts the allow first;
 *   - refresh, pull-to-refresh, Look further back and the server search post to /dashboard/mail/api
 *     and reload through Turbo (or the location); one round of syncs runs at a time, so a pull plus
 *     a click posts one round, and a failed call shows the translated sentence for the response's
 *     error code, never the response's own message;
 *   - the settings page's rename, local-models switch, password, add-account and remove-sender
 *     controls send their own verbs; removing an account keeps its sentence hidden until the first
 *     click, and sends only on a later click at least 500 ms after that;
 *   - the image banner shows the sentence the server drew for the count of hidden images (the
 *     singular for exactly one), and a failure whose code has no sentence of its own shows the
 *     generic one, while the add-account form shows the duplicate-address sentence for a 409;
 *   - every view carries exactly one settings gear, in the refresh row where there is one and in
 *     the page header row otherwise.
 * Static pins: no backtick, no dollar-brace, no markup sink, every request URL under the mail API,
 * the doubled-backslash cookie regex, and the two overscroll rules that stop Chrome's own refresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";

import { mailClientJs } from "../servers/gateway/dashboard/panels/mail/client.js";
import { mailCss } from "../servers/gateway/dashboard/panels/mail/css.js";
import { mailErrorStrings, renderMailPage } from "../servers/gateway/dashboard/panels/mail/html.js";
import { settingsHtml } from "../servers/gateway/dashboard/panels/mail/settings-html.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";
import { FRAME_IFRAME_SANDBOX } from "../servers/gateway/mail/reader/frame-doc.js";

const CLIENT_FILE = join(import.meta.dirname, "..", "servers/gateway/dashboard/panels/mail/client.js");
const T0 = Date.UTC(2026, 4, 14, 9, 0, 0);

/* ------------------------------------------------------------------- fixtures */

const ACC = { id: "ma-aaaaaaaaaaaaaaaa", label: "Personal", address: "alex@example.com", status: "active", localModelsOnly: false };
const ACC_B = { id: "ma-bbbbbbbbbbbbbbbb", label: "Work", address: "sam@example.com", status: "active", localModelsOnly: false };

function messageRow(over = {}) {
  return {
    id: 11,
    accountId: ACC.id,
    folderId: 3,
    threadId: 5,
    messageId: "<one@mail.example.test>",
    subject: "Hello there",
    fromName: "Alex",
    fromAddr: "alex@example.com",
    to: [{ name: "Sam", address: "sam@example.com" }],
    cc: [],
    date: T0,
    isRead: false,
    bodyText: "Hello from Alex",
    bodyHtml: "<p>Hello from Alex</p>",
    parseError: null,
    attachments: [],
    ...over,
  };
}

function summaryRow(over = {}) {
  return {
    id: 11,
    accountId: ACC.id,
    folderId: 3,
    messageId: "<one@mail.example.test>",
    subject: "Hello there",
    fromName: "Alex",
    fromAddr: "alex@example.com",
    snippet: "Hello from Alex",
    date: T0,
    isRead: false,
    ...over,
  };
}

/** The account's folders, as the panel hands them to the message view for its action bar. */
const FOLDERS = [
  { id: 3, accountId: ACC.id, name: "Inbox", path: "INBOX", specialUse: "\\Inbox" },
  { id: 4, accountId: ACC.id, name: "Label", path: "Label" },
  { id: 5, accountId: ACC.id, name: "Archive", path: "Archive", specialUse: "\\Archive" },
  { id: 6, accountId: ACC.id, name: "Trash", path: "Trash", specialUse: "\\Trash" },
];

/** The message view as the panel serves it: two sections, the opened (and newest) one open. */
function messagePage(rowOver = {}) {
  const opened = messageRow(rowOver);
  const earlier = messageRow({ id: 10, messageId: "<zero@mail.example.test>", subject: "Earlier", date: T0 - 60_000 });
  return renderMailPage({
    view: "message",
    accounts: [ACC],
    lang: "en",
    folders: FOLDERS,
    message: opened,
    thread: [earlier, opened],
    account: ACC,
    back: "/dashboard/mail?acct=all",
  });
}

/** The unified inbox: two accounts, one inbox folder each, no further page. */
function inboxPage() {
  const folders = [
    { id: 3, accountId: ACC.id, name: "Inbox", path: "INBOX", role: "inbox", specialUse: "\\Inbox", unreadCount: 1 },
    { id: 4, accountId: ACC_B.id, name: "Inbox", path: "INBOX", role: "inbox", specialUse: "\\Inbox", unreadCount: 0 },
  ];
  return renderMailPage({
    view: "inbox",
    accounts: [ACC, ACC_B],
    lang: "en",
    folders,
    page: { items: [summaryRow(), summaryRow({ id: 12, accountId: ACC_B.id, folderId: 4, subject: "Second" })], nextCursor: null },
    acct: "all",
    folderId: null,
    now: T0 + 3_600_000,
    tz: "UTC",
  });
}

/** The account page as the panel composes it: the hidden error element, then the cards and the form. */
function settingsPage() {
  const account = { ...ACC, status: "auth_failed", lastSyncAt: T0 };
  return mailErrorStrings("en") + settingsHtml({
    accounts: [account],
    elsewhere: [],
    allow: { [ACC.id]: ["sam@example.com"] },
    lang: "en",
    tz: "UTC",
  });
}

/* ------------------------------------------------------------------------- rig */

const jsonResponse = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });

/**
 * The emitted script, run in a vm over a linkedom page. Fetch is a stub and the timers are kept, so a
 * test says exactly when something would have fired; every iframe the script builds is recorded with
 * its attribute order and a stand-in contentWindow, so a message can be posted from it.
 */
function boot(html, { fetchImpl = () => jsonResponse(200, { ok: true }), href = "/dashboard/mail", cookie = "crow_session=abc;  crow_csrf=tok%2042" } = {}) {
  const { window: dom, document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  Object.defineProperty(document, "cookie", { configurable: true, get: () => cookie });
  // The reader marks a message read only while the page is visible, so the page's own reading of
  // visibilityState is the test's to set.
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

  const frames = [];
  const createElement = document.createElement.bind(document);
  document.createElement = (name) => {
    const node = createElement(name);
    if (String(name).toLowerCase() !== "iframe") return node;
    const record = { node, attrs: [], contentWindow: { mail: frames.length } };
    node.contentWindow = record.contentWindow;
    const setAttribute = node.setAttribute.bind(node);
    node.setAttribute = (key, value) => {
      record.attrs.push(String(key));
      return setAttribute(key, value);
    };
    frames.push(record);
    return node;
  };

  const calls = [];
  const visits = [];
  const timers = [];
  let seed = 1;
  const windowListeners = {};
  // The vm's window is a stand-in: Turbo, the nonce source and the one message listener live here,
  // so two visits share it while the document is the real linkedom one.
  const window = {
    Turbo: { visit: (url) => visits.push(String(url)) },
    btoa: (text) => Buffer.from(String(text), "binary").toString("base64"),
    scrollY: 0,
    __mlTimer: null,
    __mlBound: false,
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
    crypto: {
      getRandomValues(array) {
        for (let i = 0; i < array.length; i += 1) { array[i] = seed++ % 256; }
        array[0] = 0x41;
        return array;
      },
    },
  };

  // linkedom's fields expose `value` as a getter only; the page's own controls need a writable one, as
  // they have in a browser (the client clears a password field after it is sent).
  for (const field of document.querySelectorAll("input, select, textarea")) {
    let current = field.getAttribute("value") || "";
    Object.defineProperty(field, "value", {
      configurable: true,
      get: () => current,
      set: (next) => { current = String(next); field.setAttribute("value", current); },
    });
  }

  const location = {
    href: "http://127.0.0.1" + href,
    assign: (url) => visits.push(String(url)),
    reload: () => visits.push("reload"),
  };
  const ctx = vm.createContext({
    window,
    document,
    location,
    fetch: (url, init) => {
      const options = init || {};
      calls.push({
        url: String(url),
        method: String(options.method || "GET"),
        headers: options.headers || {},
        body: options.body == null ? null : JSON.parse(String(options.body)),
      });
      return Promise.resolve(fetchImpl(String(url), options));
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  });

  const script = (() => {
    const emitted = mailClientJs("en");
    return emitted.slice(emitted.indexOf("<script>") + 8, emitted.lastIndexOf("</script>"));
  })();
  const run = () => vm.runInContext(script, ctx);
  run();

  const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const event = (type, extra = {}) => new dom.Event(type, { bubbles: true, cancelable: true, ...extra });
  const click = (node) => { node.dispatchEvent(event("click")); return node; };
  const change = (node) => { node.dispatchEvent(event("change")); return node; };
  const submit = (node) => {
    const fired = event("submit");
    node.dispatchEvent(fired);
    return fired;
  };
  const toggle = (node) => { node.dispatchEvent(event("toggle", { bubbles: false })); };
  // A sandboxed frame without allow-same-origin reports from the opaque origin, which is "null".
  const send = (record, data, origin = "null") => {
    for (const fn of windowListeners.message || []) fn({ source: record.contentWindow, origin, data });
  };
  // The rig's timers never fire on their own, so a test says when one did.
  const fire = (ms) => {
    const timer = timers.filter((entry) => entry.ms === ms && !entry.cleared && !entry.fired).pop();
    if (!timer) return false;
    timer.fired = true;
    timer.fn();
    return true;
  };
  const touch = (node, type, y) => {
    const fired = event(type);
    if (type === "touchstart") fired.touches = [{ clientY: y }];
    else fired.changedTouches = [{ clientY: y }];
    node.dispatchEvent(fired);
  };
  const pull = (distance, list = $(".ml-list")) => {
    touch(list, "touchstart", 100);
    touch(list, "touchend", 100 + distance);
  };
  const turboBeforeVisit = () => { document.dispatchEvent(event("turbo:before-visit", { bubbles: false })); };
  const pagehide = () => { for (const fn of windowListeners.pagehide || []) fn(); };

  return {
    window, document, location, ctx, run, settle, $, $$, click, change, submit, send, pull, touch, toggle, turboBeforeVisit, pagehide,
    fire, event, frames, calls, visits, timers, windowListeners,
    setVisibility: (value) => { visibility = String(value); },
  };
}

const errorStrings = (lang = "en") => {
  const html = mailErrorStrings(lang);
  const { document } = parseHTML(`<body>${html}</body>`);
  const box = document.querySelector("[data-ml-errs]");
  const out = {};
  for (const attribute of [...box.attributes].map((a) => a.name)) {
    if (attribute.startsWith("data-ml-err-")) out[attribute.slice("data-ml-err-".length)] = box.getAttribute(attribute);
  }
  return out;
};

/* ------------------------------------------------------------- static pins (Step 1) */

test("static: the script has no backticks, no dollar-brace, and no markup sink", () => {
  const source = readFileSync(CLIENT_FILE, "utf8");
  const body = source.slice(source.indexOf("export function mailClientJs"));
  const script = body.slice(body.indexOf("<script>"), body.lastIndexOf("</script>"));
  assert.ok(script.length > 500, "the template holds the script");
  assert.equal(script.includes("`"), false, "no backtick inside the template literal");
  assert.equal(script.includes("${"), false, "no interpolation inside the template literal");
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.equal(mailClientJs("en").includes("`"), false, "the emitted script has no backtick either");
});

test("static: every request URL starts with /dashboard/mail/api/", () => {
  const source = readFileSync(CLIENT_FILE, "utf8");
  const body = source.slice(source.indexOf("export function mailClientJs"));
  const script = body.slice(body.indexOf("<script>"), body.lastIndexOf("</script>"));
  const literals = [...script.matchAll(/\b(?:post|patch|put|remove)\('([^']*)'/g)].map((match) => match[1]);
  assert.ok(literals.length >= 8, `the client names its routes: ${literals.length}`);
  for (const value of literals) assert.ok(value.startsWith("/dashboard/mail/api/"), value);
  assert.doesNotMatch(script, /fetch\('/, "fetch is only reached through the one request helper");
  const places = new Set(literals.map((value) => value.split("/").slice(0, 6).join("/")));
  assert.ok(places.size >= 3, [...places].join(", "));
});

test("S8 static: the source holds the doubled backslashes of the cookie regex", () => {
  const source = readFileSync(CLIENT_FILE, "utf8");
  const body = source.slice(source.indexOf("export function mailClientJs"));
  assert.ok(body.includes(";\\\\s*"), "client.js is inside a template literal: the regex is written with two backslashes");
  assert.equal(body.includes(";\\\\\\\\s*"), false, "and not with four, which would leave the script a stray backslash");
  assert.ok(mailClientJs("en").includes(";\\s*"), "the emitted script holds the one backslash the browser's regex needs");
  assert.equal(mailClientJs("en").includes(";\\\\s*"), false);
});

test("S7 static: the stylesheet contains itself on .ml, and the page-level rule ships with the script", () => {
  const css = mailCss({ inbox: true, message: true, settings: true });
  assert.match(css, /\.ml \{[^}]*overscroll-behavior-y: contain/);
  const source = readFileSync(CLIENT_FILE, "utf8");
  const body = source.slice(source.indexOf("export function mailClientJs"));
  assert.match(body, /html:has\(\.ml\) \{[^}]*overscroll-behavior-y: contain/);
});

/* ------------------------------------------------------------------- the frames */

test("every iframe is built from a slot: none in the markup, sandbox before src, one nonce, once per section", () => {
  const markup = messagePage();
  assert.doesNotMatch(markup, /<iframe/i, "the served page carries no frame");
  const slots = [...markup.matchAll(/data-ml-frame-slot/g)].length;
  assert.equal(slots, 2, "two conversation sections, one slot each");

  const r = boot(markup);
  const frames = r.$$("[data-ml-frame-slot] iframe");
  assert.equal(frames.length, 1, "only the open section has a frame at bind time");
  const record = r.frames[0];
  assert.equal(record.attrs[0], "sandbox", "the sandbox is set first");
  assert.ok(record.attrs.indexOf("sandbox") < record.attrs.indexOf("src"));
  assert.equal(record.node.getAttribute("sandbox"), FRAME_IFRAME_SANDBOX);
  assert.equal(record.node.getAttribute("referrerpolicy"), "no-referrer");
  const src = record.node.getAttribute("src");
  const nonce = /#n=([A-Za-z0-9_-]{16,64})$/.exec(src);
  assert.ok(nonce, `the nonce rides in the fragment: ${src}`);
  assert.equal(record.node.getAttribute("data-ml-nonce"), nonce[1]);
  assert.ok(src.startsWith("/dashboard/mail/api/messages/"), src);

  // The closed section builds its frame the first time it is opened, and never again.
  const closed = r.$$("[data-ml-msg]").find((node) => !node.hasAttribute("open"));
  assert.ok(closed, "one section is closed");
  closed.setAttribute("open", "");
  r.toggle(closed);
  closed.removeAttribute("open");
  r.toggle(closed);
  closed.setAttribute("open", "");
  r.toggle(closed);
  const after = closed.querySelectorAll("[data-ml-frame-slot] iframe");
  assert.equal(after.length, 1, "one frame, however many toggles");
  assert.equal(r.frames.length, 2, "one frame per section");
});

test("a slot's sandbox is used only when it is exactly the server's own value", () => {
  const page = (sandbox) => `<div class="ml" data-ml>
    <details class="ml-msg-section" data-ml-msg="7" open>
      <div class="ml-frame" data-ml-frame-slot data-src="/dashboard/mail/api/messages/7/frame"
        data-sandbox="${sandbox}"></div>
    </details>
  </div>`;
  const refused = [
    "allow-scripts allow-same-origin allow-popups",
    "Allow-Scripts allow-popups allow-popups-to-escape-sandbox",
    "allow-scripts allow-popups",
    FRAME_IFRAME_SANDBOX + " allow-same-origin",
    "",
  ];
  for (const sandbox of refused) {
    const r = boot(page(sandbox));
    assert.equal(r.frames.length, 0, `no frame for ${JSON.stringify(sandbox)}`);
    assert.equal(r.$("[data-ml-frame-slot]").children.length, 0, "the slot is left empty");
  }
  const accepted = boot(page(FRAME_IFRAME_SANDBOX));
  assert.equal(accepted.frames.length, 1, "the server's own value builds the frame");
  assert.equal(accepted.frames[0].node.getAttribute("sandbox"), FRAME_IFRAME_SANDBOX);
});

/* -------------------------------------------------------------- the frame's report */

test("a frame's report sets a floored, clamped height and shows the banner only for a blocked count above zero", () => {
  const r = boot(messagePage());
  const record = r.frames[0];
  const frame = record.node;
  const section = r.$("[data-ml-msg][open]");
  assert.ok(section.contains(frame), "the open section holds the one frame");
  const banner = section.querySelector("[data-ml-img-banner]");
  const nonce = frame.getAttribute("data-ml-nonce");
  assert.ok(banner.hasAttribute("hidden"), "hidden until the frame reports blocked images");

  r.send(record, { t: "crow-mail-frame", nonce, height: 640.7, blocked: 2 });
  assert.equal(frame.style.height, "640px", "floored");

  assert.equal(banner.hasAttribute("hidden"), false, "shown for blocked 2");
  assert.equal(banner.getAttribute("data-ml-blocked"), "2");

  r.send(record, { t: "crow-mail-frame", nonce, height: 20.4, blocked: 0 });
  assert.equal(frame.style.height, "120px", "clamped up to 120");
  assert.ok(banner.hasAttribute("hidden"), "hidden for 0");
  assert.equal(banner.hasAttribute("data-ml-blocked"), false);

  r.send(record, { t: "crow-mail-frame", nonce, height: 100000, blocked: 1 });
  assert.equal(frame.style.height, "20000px", "clamped down to 20000");
  assert.equal(banner.hasAttribute("hidden"), false);
});

test("reports from another window, another nonce, another type or with impossible numbers are ignored", () => {
  const r = boot(messagePage());
  const record = r.frames[0];
  const frame = record.node;
  const section = r.$("[data-ml-msg][open]");
  const nonce = frame.getAttribute("data-ml-nonce");
  const banner = section.querySelector("[data-ml-img-banner]");
  const height = frame.style.height;
  const good = { t: "crow-mail-frame", nonce, height: 500, blocked: 1 };

  const ignore = (data, source = record.contentWindow) => {
    for (const fn of r.windowListeners.message || []) fn({ source, origin: "null", data });
    assert.equal(frame.style.height, height, "no height was written");
    assert.ok(banner.hasAttribute("hidden"), "no banner was shown");
  };
  ignore(good, { notThisFrame: true });
  ignore({ ...good, nonce: "wrongnonce000000" });
  ignore({ ...good, nonce: "" });
  ignore({ ...good, t: "something-else" });
  ignore({ ...good, height: Number.NaN });
  ignore({ ...good, height: "500" });
  ignore({ ...good, height: -40 });
  ignore({ ...good, blocked: -1 });
  ignore({ ...good, blocked: 1.5 });
  ignore({ ...good, blocked: "1" });
  ignore(null);

  // The same report with everything right still works, so the listener was not disabled by the above.
  r.send(record, good);
  assert.equal(frame.style.height, "500px");
  assert.equal(banner.hasAttribute("hidden"), false);
});

test("a report from the right window and nonce but another origin is ignored", () => {
  const r = boot(messagePage());
  const record = r.frames[0];
  const frame = record.node;
  const section = r.$("[data-ml-msg][open]");
  const banner = section.querySelector("[data-ml-img-banner]");
  const report = { t: "crow-mail-frame", nonce: frame.getAttribute("data-ml-nonce"), height: 700, blocked: 2 };
  const height = frame.style.height;

  for (const origin of ["http://127.0.0.1", "https://mail.example.test", "http://127.0.0.1:443", "", "NULL"]) {
    r.send(record, report, origin);
    assert.equal(frame.style.height, height, `no height for origin ${JSON.stringify(origin)}`);
    assert.ok(banner.hasAttribute("hidden"), `no banner for origin ${JSON.stringify(origin)}`);
  }
  // And an event that names no origin at all is not this frame's report either.
  for (const fn of r.windowListeners.message || []) fn({ source: record.contentWindow, data: report });
  assert.equal(frame.style.height, height);
  assert.ok(banner.hasAttribute("hidden"));

  r.send(record, report);
  assert.equal(frame.style.height, "700px", "the opaque origin's report is accepted");
  assert.equal(banner.hasAttribute("hidden"), false);
});

test("after Show images the old nonce is refused and the new frame's nonce is accepted", async () => {
  const r = boot(messagePage());
  const section = r.$("[data-ml-msg][open]");
  const old = r.frames[0];
  const oldNonce = old.node.getAttribute("data-ml-nonce");
  r.click(section.querySelector("[data-ml-show-images]"));
  assert.equal(r.calls.length, 0, "showing images stores nothing: no request");
  assert.equal(r.frames.length, 2, "the frame was rebuilt");
  assert.equal(section.querySelectorAll("[data-ml-frame-slot] iframe").length, 1, "and the old one is gone");
  const fresh = r.frames[1];
  const freshNonce = fresh.node.getAttribute("data-ml-nonce");
  assert.notEqual(freshNonce, oldNonce);
  assert.match(fresh.node.getAttribute("src"), /\?images=1#n=[A-Za-z0-9_-]{16,64}$/);
  const height = fresh.node.style.height;

  r.send(old, { t: "crow-mail-frame", nonce: oldNonce, height: 700, blocked: 1 });
  assert.equal(fresh.node.style.height, height, "the old load's report is not this frame's");
  r.send(fresh, { t: "crow-mail-frame", nonce: freshNonce, height: 700, blocked: 1 });
  assert.equal(fresh.node.style.height, "700px", "the new load's report is");
});

/* ------------------------------------------------------------- refresh and pull */

test("S7: the script runs twice on one page and one pull still sends exactly one sync per account", async () => {
  const r = boot(inboxPage());
  r.run();
  r.pull(90);
  await r.settle();
  const syncs = r.calls.filter((call) => call.url.endsWith("/sync"));
  assert.deepEqual(syncs.map((call) => call.url).sort(), [
    "/dashboard/mail/api/accounts/ma-aaaaaaaaaaaaaaaa/sync",
    "/dashboard/mail/api/accounts/ma-bbbbbbbbbbbbbbbb/sync",
  ]);
  assert.equal(syncs.length, 2, "one per account, not two per account");
});

test("S7: a mark-read timer armed on one visit is cleared before the next and by turbo:before-visit", () => {
  const r = boot(inboxPage());
  let posts = 0;
  r.window.__mlTimer = r.ctx.setTimeout(() => { posts += 1; }, 1500);
  const armed = r.window.__mlTimer;
  r.run();
  assert.equal(armed.cleared, true, "the next visit clears it");

  r.window.__mlTimer = r.ctx.setTimeout(() => { posts += 1; }, 1500);
  const second = r.window.__mlTimer;
  r.turboBeforeVisit();
  assert.equal(second.cleared, true, "leaving the page clears it");
  assert.equal(posts, 0, "it never posted");
});

test("refresh posts a sync per account id, shows the translating status line, then visits the page", async () => {
  const r = boot(inboxPage());
  r.click(r.$("[data-ml-refresh]"));
  const line = r.$("[data-ml-status-line]");
  assert.ok(line, "a status line was added");
  assert.equal(line.getAttribute("role"), "status");
  assert.equal(line.getAttribute("aria-live"), "polite", "and screen readers announce it");
  assert.equal(line.textContent, "Refreshing");
  await r.settle();
  assert.deepEqual(r.calls.map((call) => call.method), ["POST", "POST"]);
  assert.equal(r.calls[0].headers["x-crow-csrf"], "tok 42", "the CSRF header comes from the cookie");
  assert.deepEqual(r.visits, [r.location.href]);
});

test("a failed refresh shows the fixed sentence for its code, never the response's message, and stays put", async () => {
  const strings = errorStrings();
  const r = boot(inboxPage(), {
    fetchImpl: () => jsonResponse(502, { error: "network", message: "RAW SERVER TEXT: getaddrinfo ENOTFOUND mail.example.test" }),
  });
  r.click(r.$("[data-ml-refresh]"));
  await r.settle();
  const line = r.$("[data-ml-status-line]");
  assert.equal(line.textContent, strings.network);
  assert.equal(line.textContent.includes("RAW SERVER TEXT"), false);
  assert.equal(line.textContent.includes("mail.example.test"), false);
  assert.deepEqual(r.visits, [], "a failed sync never reloads the page");
});

test("a pull of 90px at the top refreshes; 40px, or a scrolled page, does not", async () => {
  const one = boot(inboxPage());
  one.pull(90);
  await one.settle();
  assert.equal(one.calls.length, 2, "two accounts synced");

  const short = boot(inboxPage());
  short.pull(40);
  await short.settle();
  assert.equal(short.calls.length, 0, "under 80px is not a pull");

  const scrolled = boot(inboxPage());
  scrolled.window.scrollY = 300;
  scrolled.pull(90);
  await scrolled.settle();
  assert.equal(scrolled.calls.length, 0, "a pull starts at the top only");
});

test("a pull and a click during one refresh send one round of syncs, from the first trigger", async () => {
  const r = boot(inboxPage());
  const button = r.$("[data-ml-refresh]");
  r.click(button);
  r.pull(90);
  r.click(button);
  await r.settle();
  assert.equal(r.calls.length, 2, "one sync per account, not one round per trigger");
  assert.deepEqual(r.visits, [r.location.href], "and one page load");
});

test("two pulls send one round, and the refresh control is disabled while the round runs", async () => {
  const r = boot(inboxPage());
  const button = r.$("[data-ml-refresh]");
  r.pull(90);
  r.pull(90);
  assert.equal(button.hasAttribute("disabled"), true, "the control is disabled while the round runs");
  await r.settle();
  assert.equal(r.calls.length, 2, "one sync per account");
});

test("a failed round frees the refresh control, and the next attempt really posts again", async () => {
  const r = boot(inboxPage(), {
    fetchImpl: () => jsonResponse(502, { error: "network", message: "RAW" }),
  });
  r.click(r.$("[data-ml-refresh]"));
  await r.settle();
  assert.equal(r.$("[data-ml-refresh]").hasAttribute("disabled"), false, "the control is usable again");
  r.click(r.$("[data-ml-refresh]"));
  await r.settle();
  assert.equal(r.calls.length, 4, "the retry is its own round");
});

test("Look further back posts one call per folder and reloads with flash=older:N", async () => {
  const r = boot(inboxPage(), {
    fetchImpl: (url) => jsonResponse(200, url.includes("/folders/3/") ? { added: 3, reachedStart: false } : { added: 2, reachedStart: false }),
  });
  const older = r.$("[data-ml-older]");
  assert.ok(older, "the control is on the last page");
  r.click(older);
  await r.settle();
  assert.deepEqual(r.calls.map((call) => call.url), [
    "/dashboard/mail/api/folders/3/older",
    "/dashboard/mail/api/folders/4/older",
  ]);
  assert.equal(r.visits.length, 1);
  const target = decodeURIComponent(r.visits[0]);
  assert.match(target, /[?&]flash=older:5(&|$)/, target);
  assert.doesNotMatch(target, /flash=older:5.*flash=/, "the flash is written once");
});

test("the server search posts the words and the scope, then reloads with flash=remote:N", async () => {
  const page = renderMailPage({
    view: "search",
    accounts: [ACC],
    lang: "en",
    q: "garden",
    acct: "all",
    hits: [summaryRow()],
    now: T0 + 3_600_000,
    tz: "UTC",
  });
  const r = boot(page, { fetchImpl: () => jsonResponse(200, { added: 4, failures: [] }) });
  const button = r.$("[data-ml-search-remote]");
  r.click(button);
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "/dashboard/mail/api/search/remote");
  assert.deepEqual(r.calls[0].body, { q: "garden", account: "all" });
  assert.match(decodeURIComponent(r.visits[0]), /[?&]flash=remote:4(&|$)/);
});

/* ------------------------------------------------------------ the actions */

test("Archive posts the action with the row id and the csrf header, then navigates to the back url", async () => {
  const r = boot(messagePage(), { fetchImpl: () => jsonResponse(200, { ok: true, movedTo: 5 }) });
  r.click(r.$('button[data-ml-action="archive"]'));
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].method, "POST");
  assert.equal(r.calls[0].url, "/dashboard/mail/api/messages/11/actions");
  assert.deepEqual(r.calls[0].body, { action: "archive" });
  assert.equal(r.calls[0].headers["x-crow-csrf"], "tok 42", "the header comes from the cookie");
  assert.deepEqual(r.visits, ["/dashboard/mail?acct=all&flash=archived"], "the back link the page carries, with the note");
});

test("a 409 shows its sentence, keeps the page and frees the controls", async () => {
  const strings = errorStrings();
  const r = boot(messagePage(), {
    fetchImpl: () => jsonResponse(409, { error: "changed_on_server", message: "RAW SERVER TEXT" }),
  });
  const button = r.$('button[data-ml-action="archive"]');
  r.click(button);
  await r.settle();
  const line = r.$("[data-ml-actions] [data-ml-status-line]");
  assert.ok(line, "the bar carries the sentence");
  assert.equal(line.getAttribute("role"), "status");
  assert.equal(line.textContent, strings.changed_on_server);
  assert.equal(line.textContent.includes("RAW"), false, "the response's own message is never shown");
  assert.deepEqual(r.visits, [], "a changed message does not navigate");
  assert.equal(button.hasAttribute("disabled"), false, "the control is usable again");
  assert.equal(button.hasAttribute("hidden"), false, "and it is still there");
});

test("pagehide before the 1.5 s clears the mark-read timer, so nothing is posted", async () => {
  const r = boot(messagePage());
  r.run();
  assert.equal(r.windowListeners.pagehide.length, 1, "the hook is bound once per window");
  assert.equal(r.timers.filter((timer) => timer.ms === 1500 && !timer.cleared).length, 1, "the unread message armed one timer");

  r.pagehide();
  assert.equal(r.window.__mlTimer, null, "the hand on the timer is gone");
  assert.equal(r.fire(1500), false, "the timer no longer fires");
  await r.settle();
  assert.equal(r.calls.length, 0, "no mark-read post for a page that is going away");
});

test("mark read posts read once, 1.5 s after load, only for an unread shown message", async () => {
  const unread = boot(messagePage());
  const armed = unread.timers.filter((timer) => timer.ms === 1500 && !timer.cleared);
  assert.equal(armed.length, 1, "one timer for the opened unread message");
  assert.equal(unread.fire(1500), true, "it fires when the 1.5 s have passed");
  await unread.settle();
  assert.equal(unread.calls.length, 1);
  assert.equal(unread.calls[0].method, "POST");
  assert.equal(unread.calls[0].url, "/dashboard/mail/api/messages/11/actions");
  assert.deepEqual(unread.calls[0].body, { action: "read" });
  assert.equal(unread.calls[0].headers["x-crow-csrf"], "tok 42");
  assert.equal(unread.fire(1500), false, "the timer is one-shot");
  await unread.settle();
  assert.equal(unread.calls.length, 1, "and never posts twice");

  const read = boot(messagePage({ isRead: true }));
  assert.equal(read.timers.filter((timer) => timer.ms === 1500 && !timer.cleared).length, 0,
    "a message already read arms no timer");
  assert.equal(read.fire(1500), false);
  await read.settle();
  assert.equal(read.calls.length, 0);

  const hidden = boot(messagePage());
  hidden.setVisibility("hidden");
  hidden.fire(1500);
  await hidden.settle();
  assert.equal(hidden.calls.length, 0, "a page that is not visible writes nothing");

  const left = boot(messagePage());
  left.turboBeforeVisit();
  assert.equal(left.fire(1500), false, "leaving the page clears the timer");
  await left.settle();
  assert.equal(left.calls.length, 0);
});

test("Mark unread posts unread and hides itself", async () => {
  const r = boot(messagePage({ isRead: true }));
  const button = r.$('button[data-ml-action="unread"]');
  assert.ok(button, "a read message offers Mark unread");
  assert.equal(button.textContent, "Mark unread");
  r.click(button);
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].method, "POST");
  assert.equal(r.calls[0].url, "/dashboard/mail/api/messages/11/actions");
  assert.deepEqual(r.calls[0].body, { action: "unread" });
  assert.equal(r.calls[0].headers["x-crow-csrf"], "tok 42");
  assert.equal(button.hasAttribute("hidden"), true, "the control goes away");
  assert.deepEqual(r.visits, [], "and the page stays");
});

test("Move sends the folder chosen in the select", async () => {
  const r = boot(messagePage(), { fetchImpl: () => jsonResponse(200, { ok: true, movedTo: 4 }) });
  const select = r.$("[data-ml-move-select]");
  assert.ok(select, "the move select");
  select.value = "4";
  r.click(r.$('button[data-ml-action="move"]'));
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "/dashboard/mail/api/messages/11/actions");
  assert.deepEqual(r.calls[0].body, { action: "move", folderId: 4 });
  assert.deepEqual(r.visits, ["/dashboard/mail?acct=all&flash=moved%3A4"], "back to the list, naming the folder it went to");
});

test("a double click on an action posts once and disables every control while it is in flight", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const r = boot(messagePage(), { fetchImpl: () => pending });
  const archive = r.$('button[data-ml-action="archive"]');
  r.click(archive);
  r.click(archive);
  assert.equal(r.calls.length, 1, "the second click is not a second action");
  for (const control of r.$$("[data-ml-actions] [data-ml-action]")) {
    assert.equal(control.hasAttribute("disabled"), true, "every control waits for the answer");
  }
  release(jsonResponse(200, { ok: true, movedTo: 5 }));
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.visits, ["/dashboard/mail?acct=all&flash=archived"]);
});

test("after a successful archive, delete or move no control posts again while the page leaves", async () => {
  const FLASH = { archive: "archived", delete: "deleted", move: "moved%3A4" };
  for (const action of ["archive", "delete", "move"]) {
    const r = boot(messagePage(), { fetchImpl: () => jsonResponse(200, { ok: true, movedTo: 5 }) });
    if (action === "move") { r.$("[data-ml-move-select]").value = "4"; }
    r.click(r.$('button[data-ml-action="' + action + '"]'));
    await r.settle();
    assert.equal(r.calls.length, 1, action + ": one post");
    const expected = ["/dashboard/mail?acct=all&flash=" + FLASH[action]];
    assert.deepEqual(r.visits, expected, action + ": the reader goes back to its list, with its own note");

    const controls = r.$$("[data-ml-actions] [data-ml-action]");
    assert.ok(controls.length >= 2, action + ": the bar carries controls");
    for (const control of controls) {
      const verb = control.getAttribute("data-ml-action");
      assert.equal(control.hasAttribute("disabled"), true, action + ": " + verb + " stays disabled");
      r.click(control);
    }
    await r.settle();
    assert.equal(r.calls.length, 1, action + ": a second click posts nothing");
    assert.deepEqual(r.visits, expected, action + ": and navigates once");
  }
});

test("Archive, Delete and Move each go back to the list carrying their own note", async () => {
  const cases = [
    ["archive", "flash=archived"],
    ["delete", "flash=deleted"],
    ["move", "flash=moved:4"],
  ];
  for (const [action, flash] of cases) {
    const r = boot(messagePage(), { fetchImpl: () => jsonResponse(200, { ok: true }) });
    if (action === "move") { r.$("[data-ml-move-select]").value = "4"; }
    r.click(r.$('button[data-ml-action="' + action + '"]'));
    await r.settle();
    assert.equal(r.calls.length, 1, action);
    assert.equal(r.visits.length, 1, action + ": one visit");
    const target = decodeURIComponent(r.visits[0]);
    assert.match(target, new RegExp("[?&]" + flash + "(&|$)"), target);
    assert.equal(new URL("http://127.0.0.1" + target).pathname, "/dashboard/mail", action + ": back in the list");
  }
});

test("Mark unread says Marked unread. in the bar and swaps the two read controls", async () => {
  const r = boot(messagePage({ isRead: true }));
  const unread = r.$('button[data-ml-action="unread"]');
  const read = r.$('button[data-ml-action="read"]');
  assert.equal(read.hasAttribute("hidden"), true, "a read message hides Mark read");
  r.click(unread);
  await r.settle();
  const line = r.$("[data-ml-actions] [data-ml-status-line]");
  assert.ok(line, "the bar carries the sentence");
  assert.equal(line.getAttribute("role"), "status");
  assert.equal(line.getAttribute("aria-live"), "polite");
  assert.equal(line.textContent, "Marked unread.");
  assert.equal(unread.hasAttribute("hidden"), true, "Mark unread goes away");
  assert.equal(read.hasAttribute("hidden"), false, "and Mark read is shown");
  assert.deepEqual(r.visits, [], "the reader stays on the message");
});

test("Mark read posts read, swaps the controls and says nothing", async () => {
  const r = boot(messagePage());
  const read = r.$('button[data-ml-action="read"]');
  const unread = r.$('button[data-ml-action="unread"]');
  assert.ok(read, "an unread message offers Mark read");
  assert.equal(read.textContent, "Mark read");
  assert.equal(read.hasAttribute("hidden"), false);
  assert.equal(unread.hasAttribute("hidden"), true);
  r.click(read);
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].method, "POST");
  assert.equal(r.calls[0].url, "/dashboard/mail/api/messages/11/actions");
  assert.deepEqual(r.calls[0].body, { action: "read" });
  assert.equal(r.calls[0].headers["x-crow-csrf"], "tok 42");
  assert.equal(read.hasAttribute("hidden"), true, "Mark read goes away");
  assert.equal(unread.hasAttribute("hidden"), false, "and Mark unread is shown");
  const line = r.$("[data-ml-actions] [data-ml-status-line]");
  assert.ok(!line || line.textContent === "", "no sentence: the plan approved none");
  assert.ok(!line || line.hasAttribute("hidden"), "and nothing is shown");
  assert.deepEqual(r.visits, [], "the reader stays on the message");
});

test("Mark read after Mark unread clears the bar's sentence instead of leaving it visible", async () => {
  const r = boot(messagePage({ isRead: true }));
  const bar = r.$("[data-ml-actions]");
  const unread = r.$('button[data-ml-action="unread"]');
  const read = r.$('button[data-ml-action="read"]');
  r.click(unread);
  await r.settle();
  const line = bar.querySelector("[data-ml-status-line]");
  assert.equal(line.textContent, "Marked unread.");
  assert.equal(line.hasAttribute("hidden"), false, "the sentence is shown");

  r.click(read);
  await r.settle();
  assert.equal(r.calls.length, 2, "both answers arrived");
  assert.deepEqual(r.calls[1].body, { action: "read" });
  assert.equal(line.textContent, "", "the sentence that belonged to the unread state is gone");
  assert.equal(line.hasAttribute("hidden"), true, "and the line is hidden again");
  assert.equal(read.hasAttribute("hidden"), true, "Mark read goes away");
  assert.equal(unread.hasAttribute("hidden"), false, "and Mark unread is shown");
  assert.deepEqual(r.visits, [], "the reader stays on the message");
});

test("either read control clears the pending automatic mark-read when it is clicked", async () => {
  const marked = boot(messagePage());
  const armed = marked.window.__mlTimer;
  assert.ok(armed, "the opened unread message armed the timer");
  marked.click(marked.$('button[data-ml-action="read"]'));
  await marked.settle();
  assert.equal(armed.cleared, true, "the click clears the pending mark-read");
  assert.equal(marked.fire(1500), false, "so it cannot fire as well");
  await marked.settle();
  assert.equal(marked.calls.length, 1, "one post, the click's own");
  assert.deepEqual(marked.calls[0].body, { action: "read" });

  const unread = boot(messagePage({ isRead: true }));
  let fired = 0;
  unread.window.__mlTimer = unread.ctx.setTimeout(() => { fired += 1; }, 1500);
  const pending = unread.window.__mlTimer;
  unread.click(unread.$('button[data-ml-action="unread"]'));
  await unread.settle();
  assert.equal(pending.cleared, true, "Mark unread clears it too");
  assert.equal(fired, 0);
});

test("the automatic mark-read swaps the two read controls once the server agrees", async () => {
  const r = boot(messagePage());
  const read = r.$('button[data-ml-action="read"]');
  const unread = r.$('button[data-ml-action="unread"]');
  assert.equal(read.hasAttribute("hidden"), false);
  assert.equal(unread.hasAttribute("hidden"), true);
  assert.equal(r.fire(1500), true);
  await r.settle();
  assert.deepEqual(r.calls[0].body, { action: "read" });
  assert.equal(read.hasAttribute("hidden"), true, "Mark read goes away by itself");
  assert.equal(unread.hasAttribute("hidden"), false, "and Mark unread is shown");
  assert.deepEqual(r.visits, []);
});

test("a click while the automatic mark-read is in flight posts nothing more", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const r = boot(messagePage(), { fetchImpl: () => pending });
  assert.equal(r.fire(1500), true, "the automatic read goes out");
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].body, { action: "read" });

  const unread = r.$('button[data-ml-action="unread"]');
  const archive = r.$('button[data-ml-action="archive"]');
  assert.equal(unread.hasAttribute("disabled"), true, "the bar waits for the automatic answer");
  r.click(unread);
  r.click(archive);
  assert.equal(r.calls.length, 1, "a click during the automatic post is not a second post");

  release(jsonResponse(200, { ok: true }));
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.visits, [], "no archive and no unread went out");
  const read = r.$('button[data-ml-action="read"]');
  assert.equal(read.hasAttribute("hidden"), true, "the answer that did arrive swaps them");
  assert.equal(unread.hasAttribute("hidden"), false, "and Mark unread is shown");
  for (const control of r.$$("[data-ml-actions] [data-ml-action]")) {
    assert.equal(control.hasAttribute("disabled"), false, "the bar is usable again");
  }
});

test("the automatic mark-read stands aside while another action is in flight", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const r = boot(messagePage(), { fetchImpl: () => pending });
  r.click(r.$('button[data-ml-action="archive"]'));
  assert.equal(r.calls.length, 1, "the archive post is out");
  assert.deepEqual(r.calls[0].body, { action: "archive" });

  assert.equal(r.fire(1500), true, "the automatic mark-read fires while the archive is in flight");
  await r.settle();
  assert.equal(r.calls.length, 1, "it posts nothing over the action that is already out");
  assert.deepEqual(r.calls.map((call) => call.body), [{ action: "archive" }], "no read went out");
  for (const control of r.$$("[data-ml-actions] [data-ml-action]")) {
    assert.equal(control.hasAttribute("disabled"), true, "the bar still waits for the archive's own answer");
  }

  release(jsonResponse(200, { ok: true, movedTo: 5 }));
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.visits, ["/dashboard/mail?acct=all&flash=archived"], "the archive's answer still carries the page away");
  assert.equal(r.$('button[data-ml-action="read"]').hasAttribute("hidden"), false,
    "no read answer arrived, so the read controls were never swapped");
});

/* ------------------------------------------------------------------- the settings */

test("Always show posts the account and sender with the CSRF header, then rebuilds the frame with images", async () => {
  const r = boot(messagePage());
  const section = r.$("[data-ml-msg][open]");
  const before = r.frames.length;
  r.click(section.querySelector("[data-ml-always-images]"));
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].method, "POST");
  assert.equal(r.calls[0].url, "/dashboard/mail/api/image-allow");
  assert.deepEqual(r.calls[0].body, { accountId: ACC.id, sender: "alex@example.com" });
  assert.equal(r.calls[0].headers["x-crow-csrf"], "tok 42");
  assert.equal(r.frames.length, before + 1);
  assert.match(r.frames[before].node.getAttribute("src"), /\?images=1#n=/);
});

test("rename and the local-models switch PATCH their own field and report a failure in the card", async () => {
  const ok = boot(settingsPage());
  const rename = ok.$("[data-ml-rename]");
  rename.value = "Home";
  ok.change(rename);
  await ok.settle();
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].method, "PATCH");
  assert.equal(ok.calls[0].url, "/dashboard/mail/api/accounts/" + ACC.id);
  assert.deepEqual(ok.calls[0].body, { label: "Home" });

  const local = ok.$("[data-ml-local-models]");
  local.checked = true;
  ok.change(local);
  await ok.settle();
  assert.deepEqual(ok.calls[1].body, { localModelsOnly: true });

  const strings = errorStrings();
  const bad = boot(settingsPage(), { fetchImpl: () => jsonResponse(400, { error: "bad_input", message: "RAW" }) });
  const field = bad.$("[data-ml-rename]");
  field.value = " ";
  bad.change(field);
  await bad.settle();
  const line = bad.$("[data-ml-account] [data-ml-status-line]");
  assert.ok(line, "the card carries the line");
  assert.equal(line.textContent, strings.bad_input);
});

test("Update password PUTs the secret, clears the field in every outcome and reloads only on success", async () => {
  const ok = boot(settingsPage());
  const details = ok.$("[data-ml-update-password]");
  details.setAttribute("open", "");
  ok.$("[data-ml-password-input]").value = "new-app-password";
  ok.click(ok.$("[data-ml-password-save]"));
  await ok.settle();
  assert.equal(ok.calls[0].method, "PUT");
  assert.equal(ok.calls[0].url, "/dashboard/mail/api/accounts/" + ACC.id + "/password");
  assert.deepEqual(ok.calls[0].body, { password: "new-app-password" });
  assert.equal(ok.$("[data-ml-password-input]").value, "", "cleared after success");
  assert.equal(ok.visits.length, 1, "the page reloads so the status word is fresh");

  const strings = errorStrings();
  const bad = boot(settingsPage(), { fetchImpl: () => jsonResponse(400, { error: "AUTH_FAILED", message: "RAW" }) });
  bad.$("[data-ml-update-password]").setAttribute("open", "");
  bad.$("[data-ml-password-input]").value = "wrong-app-password";
  bad.click(bad.$("[data-ml-password-save]"));
  await bad.settle();
  assert.equal(bad.$("[data-ml-password-input]").value, "", "cleared after failure too");
  assert.deepEqual(bad.visits, [], "a refused password does not reload");
  const line = bad.$("[data-ml-account] [data-ml-status-line]");
  assert.equal(line.textContent, strings.auth_failed);
  assert.equal(bad.document.body.innerHTML.includes("wrong-app-password"), false, "the secret is not written back into the page");
});

test("the add-account form posts its fields as endpoints, clears the password on success and on error", async () => {
  const ok = boot(settingsPage(), { fetchImpl: () => jsonResponse(201, { account: { id: ACC.id } }) });
  const form = ok.$("[data-ml-add-account]");
  const fill = (name, value) => { form.querySelector('[name="' + name + '"]').value = value; };
  fill("label", "Home");
  fill("address", "sam@example.com");
  fill("password", "app-password");
  fill("imap-host", "mail.example.test");
  fill("imap-port", "993");
  fill("imap-security", "ssl");
  fill("smtp-host", "mail.example.test");
  fill("smtp-port", "465");
  fill("smtp-security", "starttls");
  const event = ok.submit(form);
  assert.equal(event.defaultPrevented, true, "the form never posts on its own");
  assert.equal(form.querySelector('[name="password"]').value, "", "cleared as soon as it was sent");
  await ok.settle();
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].method, "POST");
  assert.equal(ok.calls[0].url, "/dashboard/mail/api/accounts");
  assert.deepEqual(ok.calls[0].body, {
    label: "Home",
    address: "sam@example.com",
    password: "app-password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "starttls" },
  });
  assert.equal(ok.visits.length, 1, "success reloads");
  assert.equal(ok.document.body.innerHTML.includes("app-password"), false);

  const strings = errorStrings();
  const bad = boot(settingsPage(), { fetchImpl: () => jsonResponse(400, { error: "BAD_INPUT", message: "RAW" }) });
  const other = bad.$("[data-ml-add-account]");
  other.querySelector('[name="password"]').value = "second-password";
  bad.submit(other);
  await bad.settle();
  assert.equal(other.querySelector('[name="password"]').value, "", "cleared after an error too");
  assert.deepEqual(bad.visits, [], "an error does not reload");
  const line = other.querySelector("[data-ml-status-line]");
  assert.ok(line, "the form carries the line");
  assert.equal(line.textContent, strings.bad_input, "the sentence for the code, whatever case the server used");
  assert.equal(bad.document.body.textContent.includes("RAW"), false, "the response's own message is never shown");
});

test("a cancelable submit on the add-account form is cancelled before a field is read, then posted once", async () => {
  const r = boot(settingsPage(), { fetchImpl: () => jsonResponse(201, { account: { id: ACC.id } }) });
  const form = r.$("[data-ml-add-account]");
  const fill = (name, value) => { form.querySelector('[name="' + name + '"]').value = value; };
  fill("label", "Home");
  fill("address", "sam@example.com");
  fill("password", "app-password");
  fill("imap-host", "mail.example.test");
  fill("imap-port", "993");
  fill("imap-security", "ssl");
  fill("smtp-host", "mail.example.test");
  fill("smtp-port", "465");
  fill("smtp-security", "starttls");

  // Every read of the form — its attribute as much as its fields — reports whether the submit had
  // already been cancelled at that moment: the form is never given an instant in which the browser
  // could start a submission.
  const fired = r.event("submit");
  const accesses = [];
  const watch = (name) => {
    const call = form[name].bind(form);
    form[name] = (selector) => {
      accesses.push({ name: `${name}(${String(selector)})`, prevented: fired.defaultPrevented });
      return call(selector);
    };
  };
  watch("getAttribute");
  watch("querySelector");
  form.dispatchEvent(fired);

  assert.equal(fired.defaultPrevented, true, "the form never submits itself");
  assert.ok(accesses.some((entry) => entry.name.startsWith("querySelector(")), "the handler read the fields");
  for (const entry of accesses) {
    assert.equal(entry.prevented, true, `the submit was already cancelled before ${entry.name}`);
  }
  assert.equal(form.querySelector('[name="password"]').value, "", "the secret leaves the page as it is sent");

  await r.settle();
  assert.equal(r.calls.length, 1, "exactly one request");
  assert.equal(r.calls[0].method, "POST");
  assert.equal(r.calls[0].url, "/dashboard/mail/api/accounts");
  assert.equal(r.calls[0].headers["x-crow-csrf"], "tok 42", "the header comes from the cookie");
  assert.deepEqual(r.calls[0].body, {
    label: "Home",
    address: "sam@example.com",
    password: "app-password",
    imap: { host: "mail.example.test", port: 993, security: "ssl" },
    smtp: { host: "mail.example.test", port: 465, security: "starttls" },
  });
});

test("a submit with no CSRF cookie is still cancelled and never becomes a native post", async () => {
  const r = boot(settingsPage(), {
    cookie: "crow_session=abc",
    fetchImpl: () => jsonResponse(403, { error: "bad_input" }),
  });
  const form = r.$("[data-ml-add-account]");
  form.querySelector('[name="password"]').value = "app-password";
  const fired = r.submit(form);
  assert.equal(fired.defaultPrevented, true, "a missing cookie does not hand the form back to the browser");
  assert.equal(form.getAttribute("method"), "post", "what the browser would post, if it ever did");
  assert.equal(form.getAttribute("action"), null, "and there is no target for it");
  await r.settle();
  assert.deepEqual(r.visits, [], "nothing navigated and nothing reloaded");
});

test("the header's search box stays a plain GET form: its submit is not cancelled", () => {
  const r = boot(inboxPage());
  const form = r.$("form.ml-search");
  assert.ok(form, "the search box");
  assert.equal(form.getAttribute("method"), "get", "it works with no client script");
  const fired = r.submit(form);
  assert.equal(fired.defaultPrevented, false, "the browser performs the search itself");
  assert.deepEqual(r.calls, [], "and no request is made for it");
});

test("Remove sender DELETEs the allowance and takes the row out of the list", async () => {
  const r = boot(settingsPage());
  const button = r.$("[data-ml-remove-sender]");
  assert.ok(button, "the allowed sender is listed");
  r.click(button);
  await r.settle();
  assert.equal(r.calls[0].method, "DELETE");
  assert.equal(r.calls[0].url, "/dashboard/mail/api/image-allow");
  assert.deepEqual(r.calls[0].body, { accountId: ACC.id, sender: "sam@example.com" });
  assert.equal(r.$("[data-ml-allow-list]").children.length, 0, "the sender's row is gone");
});

test("Remove account reveals its sentence on the first click and still calls nothing", async () => {
  const r = boot(settingsPage());
  const button = r.$("[data-ml-remove-account-btn]");
  const sentence = r.$("[data-ml-confirm-sentence]");
  assert.ok(button, "the remove control");
  assert.ok(sentence, "its sentence");
  assert.equal(sentence.hasAttribute("hidden"), true, "the sentence is hidden until the first click");
  r.click(button);
  await r.settle();
  assert.deepEqual(r.calls, [], "one click is not the confirmation");
  assert.equal(sentence.hasAttribute("hidden"), false, "the sentence is revealed");
  assert.equal(button.getAttribute("data-ml-confirm"), "1", "and the button is armed");
});

test("two clicks less than 100 ms apart send nothing; a later click sends exactly one DELETE", async () => {
  const r = boot(settingsPage());
  const button = r.$("[data-ml-remove-account-btn]");
  r.click(button);
  r.click(button);
  await r.settle();
  assert.deepEqual(r.calls, [], "the second click came before the arm was ready");
  assert.equal(button.getAttribute("data-ml-confirm"), "1", "the button is still armed");

  assert.equal(r.fire(500), true, "the arm timer elapses");
  r.click(button);
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].method, "DELETE");
  assert.equal(r.calls[0].url, "/dashboard/mail/api/accounts/" + ACC.id);
  assert.equal(r.visits.length, 1, "the page reloads once the account is gone");

  r.click(button);
  await r.settle();
  assert.equal(r.calls.length, 1, "one DELETE for the whole confirmation");
});

test("the confirmation disarms itself after 8 s and a later click only arms it again", async () => {
  const r = boot(settingsPage());
  const button = r.$("[data-ml-remove-account-btn]");
  const sentence = r.$("[data-ml-confirm-sentence]");
  r.click(button);
  assert.equal(r.fire(8000), true, "the confirm window elapses");
  assert.equal(sentence.hasAttribute("hidden"), true, "the sentence is hidden again");
  assert.equal(button.hasAttribute("data-ml-confirm"), false, "the button is disarmed");
  r.click(button);
  await r.settle();
  assert.deepEqual(r.calls, [], "a lapsed confirmation sends nothing");
  assert.equal(button.getAttribute("data-ml-confirm"), "1", "the click arms a new one");
});

test("leaving the remove block disarms it", async () => {
  const r = boot(settingsPage());
  const button = r.$("[data-ml-remove-account-btn]");
  const sentence = r.$("[data-ml-confirm-sentence]");
  r.click(button);
  assert.equal(sentence.hasAttribute("hidden"), false);
  r.$("[data-ml-remove-account]").dispatchEvent(r.event("focusout", { bubbles: true }));
  assert.equal(sentence.hasAttribute("hidden"), true, "the sentence is hidden on leaving");
  assert.equal(button.hasAttribute("data-ml-confirm"), false, "and the button is disarmed");
  r.fire(500);
  r.click(button);
  await r.settle();
  assert.deepEqual(r.calls, [], "a click after leaving only arms again");
});

test("Sync now posts that one account's sync", async () => {
  const r = boot(settingsPage(), { fetchImpl: () => jsonResponse(202, { ok: true, started: true }) });
  const button = r.$("[data-ml-sync]");
  r.click(button);
  await r.settle();
  assert.equal(r.calls[0].method, "POST");
  assert.equal(r.calls[0].url, "/dashboard/mail/api/accounts/" + ACC.id + "/sync");
  assert.equal(r.visits.length, 1);
});

/* ----------------------------------------------------------------- the copy pins */

test("every sentence the client can show is translated, and the error codes have a sentence", () => {
  const strings = errorStrings("en");
  const spanish = errorStrings("es");
  for (const code of ["auth_failed", "network", "tls", "protocol", "not_found", "bad_input",
    "claimed_elsewhere", "too_large", "timeout", "changed", "changed_on_server",
    "no_archive_folder", "no_trash_folder", "duplicate_address", "generic"]) {
    assert.ok(strings[code], `en has a sentence for ${code}`);
    assert.ok(spanish[code], `es has a sentence for ${code}`);
    assert.notEqual(strings[code], spanish[code], `${code} is translated`);
  }
  assert.equal(translations["mail.refreshing"].en, "Refreshing");
  assert.notEqual(translations["mail.refreshing"].es, translations["mail.refreshing"].en);
  const refresh = boot(inboxPage()).$("[data-ml-refresh]");
  assert.equal(refresh.getAttribute("data-ml-refreshing"), "Refreshing");
});

/* --------------------------------------------------------- the approved copy */

test("the approved sentences read exactly as given, and each has its own Spanish", () => {
  const COPY = {
    "mail.unread": "Unread",
    "mail.allowedSendersHeading": "Senders whose images load",
    "mail.lastChecked": "Last checked",
    "mail.imagesHidden": "{n} images hidden.",
    "mail.imageHiddenOne": "1 image hidden.",
    "mail.settings": "Settings",
    "mail.anotherCrow": "another Crow",
    "mail.error.no_archive_folder": "Crow couldn't find this account's Archive folder.",
    "mail.error.no_trash_folder": "Crow couldn't find this account's Trash folder.",
    "mail.error.duplicate_address": "That address is already set up in Crow.",
    "mail.error.generic": "Something went wrong. Try again.",
    "mail.markRead": "Mark read",
    "mail.doneArchived": "Archived.",
    "mail.doneDeleted": "Deleted.",
    "mail.doneMoved": "Moved to {folder}.",
    "mail.doneUnread": "Marked unread.",
  };
  for (const [key, en] of Object.entries(COPY)) {
    assert.equal(translations[key]?.en, en, key);
    assert.ok(translations[key]?.es, `${key} has a Spanish sentence`);
    assert.notEqual(translations[key].es, en, `${key} is translated`);
  }
});

test("a nameless instance is called another Crow, in the page's language", () => {
  const listing = (lang) => renderMailPage({ view: "inbox", accounts: [], elsewhere: [{ instanceName: "  " }], lang });
  assert.match(listing("en"), /<p class="ml-note">Mail is set up on another Crow<\/p>/);
  assert.match(listing("es"), /<p class="ml-note">El correo está configurado en otro Crow<\/p>/);
  assert.match(settingsHtml({ accounts: [], elsewhere: [{ instanceName: "" }], lang: "es" }), /otro Crow/);
  // The account-label fallback keeps its behaviour: the label, then the fallback name, translated.
  const chips = (lang) => renderMailPage({
    view: "inbox",
    accounts: [{ ...ACC, label: "" }],
    folders: [],
    page: { items: [], nextCursor: null },
    lang,
  });
  assert.match(chips("en"), /class="ml-chip" href="[^"]*"[^>]*>another Crow<\/a>/);
  assert.match(chips("es"), /class="ml-chip" href="[^"]*"[^>]*>otro Crow<\/a>/);
  // And the status word of a held account with no instance name stored.
  const held = settingsHtml({ accounts: [{ ...ACC, status: "claimed_elsewhere" }], lang: "es" });
  assert.match(held, /Conectado en otro Crow/);
});

/* ------------------------------------------------------------------- the gear */

const GEAR = '<a class="ml-btn ml-gear" href="/dashboard/mail?view=settings" aria-label="Settings">';

/** Every view the reader can draw, each with the markup the panel serves for it. */
function everyView() {
  return {
    "the connect card": renderMailPage({ view: "inbox", accounts: [], elsewhere: [], lang: "en" }),
    "the elsewhere card": renderMailPage({ view: "inbox", accounts: [], elsewhere: [{ instanceName: "Studio" }], lang: "en" }),
    "the held-only card": renderMailPage({
      view: "inbox", accounts: [{ ...ACC, status: "claimed_elsewhere", heldBy: "Studio" }], lang: "en",
    }),
    "the inbox": inboxPage(),
    "the search view": renderMailPage({
      view: "search", accounts: [ACC], lang: "en", q: "garden", acct: "all", hits: [summaryRow()], now: T0, tz: "UTC",
    }),
    "the message view": messagePage(),
    "the not-here page": renderMailPage({ view: "message", accounts: [ACC], lang: "en", missing: true }),
    "the settings view": settingsHtml({ accounts: [ACC], lang: "en", tz: "UTC" }),
  };
}

test("every view carries exactly one settings gear, named Settings and pointing at the account page", () => {
  for (const [name, markup] of Object.entries(everyView())) {
    const gears = markup.match(/class="ml-btn ml-gear"/g) || [];
    assert.equal(gears.length, 1, `${name}: one gear`);
    assert.ok(markup.includes(GEAR), `${name}: the gear carries its own name and target`);
    const tag = /<a class="ml-btn ml-gear"[\s\S]*?<\/a>/.exec(markup)[0];
    assert.match(tag, /aria-hidden="true"/, `${name}: the glyph is hidden from assistive technology`);
    assert.match(tag, /<svg class="ml-gear-icon"/, `${name}: an inline glyph, no icon font`);
    assert.equal((tag.match(/<svg/g) || []).length, 1, name);
  }
});

test("the gear sits after Refresh on the inbox and in the page header row on every other view", () => {
  const inbox = inboxPage();
  assert.match(
    inbox,
    /data-ml-refresh[^>]*>Refresh<\/button><a class="ml-btn ml-gear" href="\/dashboard\/mail\?view=settings" aria-label="Settings">/,
    "the inbox puts it right after the refresh control",
  );
  for (const name of ["the search view", "the message view", "the not-here page", "the connect card", "the elsewhere card", "the held-only card"]) {
    const markup = everyView()[name];
    assert.doesNotMatch(markup, /data-ml-refresh/, `${name}: no refresh row here`);
    assert.match(
      markup,
      /<div class="ml-page-head">\s*<h1 class="ml-title">[^<]*<\/h1>\s*<a class="ml-btn ml-gear"/,
      `${name}: the gear rides the page header row`,
    );
  }
  assert.match(
    everyView()["the settings view"],
    /<div class="ml-page-head">\s*<h1 class="ml-title">[^<]*<\/h1>\s*<a class="ml-btn ml-gear"/,
  );
});

test("the gear is a 44px square target in the stylesheet", () => {
  const css = mailCss({ inbox: true, message: true, settings: true });
  const rule = /\.ml-gear \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the gear has its own rule");
  assert.match(rule[1], /min-width: 44px/);
  assert.match(rule[1], /min-height: 44px/);
  assert.match(rule[1], /align-items: center/);
  assert.match(rule[1], /justify-content: center/);
});

/* ------------------------------------------------------- the hidden-image count */

test("the image banner shows N images hidden. and 1 image hidden. from the sentence the server drew", () => {
  const r = boot(messagePage());
  const record = r.frames[0];
  const section = r.$("[data-ml-msg][open]");
  const banner = section.querySelector("[data-ml-img-banner]");
  const nonce = record.node.getAttribute("data-ml-nonce");
  assert.equal(banner.getAttribute("data-ml-blocked-many"), "{n} images hidden.");
  assert.equal(banner.getAttribute("data-ml-blocked-one"), "1 image hidden.");

  r.send(record, { t: "crow-mail-frame", nonce, height: 500, blocked: 3 });
  let note = banner.querySelector("[data-ml-blocked-note]");
  assert.ok(note, "the sentence is in the banner");
  assert.equal(String(note.tagName).toLowerCase(), "p");
  assert.equal(note.getAttribute("role"), "status");
  assert.match(note.getAttribute("class"), /ml-note/);
  assert.equal(note.textContent, "3 images hidden.");

  r.send(record, { t: "crow-mail-frame", nonce, height: 500, blocked: 1 });
  note = banner.querySelector("[data-ml-blocked-note]");
  assert.equal(note.textContent, "1 image hidden.", "the singular for exactly one");

  r.send(record, { t: "crow-mail-frame", nonce, height: 500, blocked: 0 });
  assert.equal(banner.querySelector("[data-ml-blocked-note]"), null, "cleared with the count");
  assert.ok(banner.hasAttribute("hidden"));
});

test("a report the listener refuses never reaches the sentence", () => {
  const r = boot(messagePage());
  const record = r.frames[0];
  const section = r.$("[data-ml-msg][open]");
  const banner = section.querySelector("[data-ml-img-banner]");
  const nonce = record.node.getAttribute("data-ml-nonce");
  const refused = [
    { blocked: "3 images hidden." },
    { blocked: "<b>x</b>" },
    { blocked: -2 },
    { blocked: 2.5 },
    { blocked: Number.NaN },
    { blocked: null },
    { nonce: "wrongnonce000000", blocked: 3 },
  ];
  for (const extra of refused) {
    r.send(record, { t: "crow-mail-frame", nonce, height: 500, blocked: 2, ...extra });
    assert.equal(banner.querySelector("[data-ml-blocked-note]"), null, JSON.stringify(extra));
    assert.ok(banner.hasAttribute("hidden"), JSON.stringify(extra));
  }
  // The count is the integer alone: no text from anywhere rides into the sentence.
  r.send(record, { t: "crow-mail-frame", nonce, height: 500, blocked: 4 });
  assert.equal(banner.querySelector("[data-ml-blocked-note]").textContent, "4 images hidden.");
});

/* ------------------------------------------------------------ the generic fallback */

test("a code with no sentence of its own shows the generic one, and a code with one keeps it", async () => {
  const strings = errorStrings();
  assert.equal(strings.generic, "Something went wrong. Try again.");

  const say = async (error) => {
    const r = boot(settingsPage(), { fetchImpl: () => jsonResponse(400, { error, message: "RAW SERVER TEXT" }) });
    const field = r.$("[data-ml-rename]");
    field.value = "Home";
    r.change(field);
    await r.settle();
    const line = r.$("[data-ml-account] [data-ml-status-line]");
    assert.ok(line, error);
    assert.equal(line.textContent.includes("RAW"), false, `${error} never shows the response's message`);
    return line.textContent;
  };

  for (const code of ["owner_only", "busy", "unavailable", "keychain_key_missing", "internal", "unknown"]) {
    assert.equal(await say(code), strings.generic, code);
  }
  assert.equal(await say("no_archive_folder"), strings.no_archive_folder, "its own sentence wins");
  assert.equal(await say("no_trash_folder"), strings.no_trash_folder);
  assert.equal(await say("AUTH_FAILED"), strings.auth_failed);

  // A failure with no answer at all is still the network sentence.
  const offline = boot(settingsPage(), { fetchImpl: () => Promise.reject(new Error("offline")) });
  const field = offline.$("[data-ml-rename]");
  field.value = "Home";
  offline.change(field);
  await offline.settle();
  assert.equal(offline.$("[data-ml-account] [data-ml-status-line]").textContent, strings.network);
});

test("the add-account form shows the duplicate-address sentence for a 409 and stays put", async () => {
  const strings = errorStrings();
  assert.equal(strings.duplicate_address, "That address is already set up in Crow.");
  const r = boot(settingsPage(), {
    fetchImpl: () => jsonResponse(409, { error: "duplicate_address", message: "RAW SERVER TEXT" }),
  });
  const form = r.$("[data-ml-add-account]");
  form.querySelector('[name="password"]').value = "app-password";
  r.submit(form);
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "/dashboard/mail/api/accounts");
  const line = form.querySelector("[data-ml-status-line]");
  assert.ok(line, "the form carries the sentence");
  assert.equal(line.getAttribute("role"), "status");
  assert.equal(line.textContent, "That address is already set up in Crow.");
  assert.equal(line.textContent.includes("RAW"), false);
  assert.equal(form.querySelector('[name="password"]').value, "", "the secret is cleared whatever the answer");
  assert.deepEqual(r.visits, [], "a refused address does not reload");
});

test("static: the codes ride the hidden element and errorText falls back to the generic sentence", () => {
  const box = parseHTML(`<body>${mailErrorStrings("en")}</body>`).document.querySelector("[data-ml-errs]");
  for (const code of ["duplicate_address", "generic", "no_archive_folder", "no_trash_folder"]) {
    assert.ok(box.hasAttribute(`data-ml-err-${code}`), code);
  }
  const source = readFileSync(CLIENT_FILE, "utf8");
  const body = source.slice(source.indexOf("export function mailClientJs"));
  assert.ok(body.includes("data-ml-err-generic"), "the fallback reads the generic sentence");
  assert.match(body, /if \(!text\) \{ text = box\.getAttribute\('data-ml-err-generic'\); \}/);
});
