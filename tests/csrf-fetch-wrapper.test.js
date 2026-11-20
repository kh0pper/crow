/**
 * Review F2: the layout's fetch wrapper hands `X-Crow-Csrf` to a request only
 * when the BROWSER's URL parser says the URL is same-origin.
 *
 * The old rule was a leading-slash string test ("starts with '/' and not '//'"),
 * which is not the same question: `/\evil.example/x` starts with a slash and is
 * an absolute URL to another origin once parsed (a backslash is a slash in the
 * URL parser's authority position), so a panel (or a bot-supplied value that
 * reached one) could have mailed the session's CSRF token to a third party.
 *
 * The wrapper is exercised as the page gets it: every inline `<script>` of a
 * real renderLayout, run in a vm context with a stub DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";

import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";

const TOKEN = "csrf-token-under-test";
const ORIGIN = "https://dash.example.test";

function fakeEl(extra = {}) {
  return {
    style: {}, dataset: {}, children: [], childNodes: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return { remove() {} }; },
    ...extra,
  };
}

/** The page's inline scripts in a stub DOM; `sent` records every fetch call. */
function page() {
  const html = renderLayout({ title: "T", content: "", activePanel: "nest", panels: [] });
  const scripts = [...parseHTML(html).document.querySelectorAll("script")]
    .filter((s) => !s.getAttribute("src"))
    .map((s) => s.textContent);

  const sent = [];
  const listeners = new Map();
  const add = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const sandbox = {
    console, URL, Headers, Promise, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    // The server-bound token, exactly as /csrf-client.js exposes it.
    crowCsrf: () => TOKEN,
    fetch: (input, init) => {
      sent.push({ url: typeof input === "string" ? input : input.url, init: init || {} });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null } });
    },
    document: {
      cookie: "",
      addEventListener: add,
      removeEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => fakeEl(),
      documentElement: fakeEl(),
      body: fakeEl(),
      readyState: "complete",
    },
    location: { href: `${ORIGIN}/dashboard/nest`, origin: ORIGIN, reload() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: {},
    addEventListener: add,
    alert() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // Layout scripts touch DOM this stub does not model; the CSRF wiring is what
  // matters and is installed regardless.
  for (const s of scripts) {
    try { new vm.Script(s).runInContext(sandbox); } catch { /* unrelated DOM wiring */ }
  }
  return { sandbox, sent, listeners };
}

const csrfHeader = (entry) => new Headers(entry.init.headers).get("X-Crow-Csrf");

test("the fetch wrapper is installed and attaches the token to a same-origin POST", async () => {
  const { sandbox, sent } = page();
  assert.equal(sandbox.__crowFetchWrapped, true, "the dashboard layout wraps window.fetch");
  await sandbox.fetch("/dashboard/perch-api/bots/1/interactive", { method: "POST" });
  assert.equal(sent.length, 1);
  assert.equal(csrfHeader(sent[0]), TOKEN);
  await sandbox.fetch(`${ORIGIN}/api/models/registered`, { method: "POST", body: "{}" });
  assert.equal(csrfHeader(sent[1]), TOKEN, "an absolute same-origin URL is fine");
});

test("a URL that only LOOKS relative gets no token (review F2)", async () => {
  const { sandbox, sent } = page();
  // "/\evil.example/x" parses as https://evil.example/x — another origin.
  await sandbox.fetch("/\\evil.example/x", { method: "POST" });
  assert.equal(sent.length, 1);
  assert.equal(csrfHeader(sent[0]), null, "the token never leaves this origin");
  // The classic protocol-relative spelling is refused the same way.
  await sandbox.fetch("//evil.example/x", { method: "POST" });
  assert.equal(csrfHeader(sent[1]), null);
  await sandbox.fetch("https://evil.example/x", { method: "POST" });
  assert.equal(csrfHeader(sent[2]), null);
  // ...and a GET is never touched at all.
  await sandbox.fetch("/dashboard/x", { method: "GET" });
  assert.equal(csrfHeader(sent[3]), null);
});

test("the Turbo hook applies the same same-origin rule", () => {
  const { sandbox, listeners } = page();
  const fire = (url, method = "POST") => {
    const headers = new Headers();
    const event = { detail: { fetchOptions: { method, url, headers } } };
    for (const fn of listeners.get("turbo:before-fetch-request") || []) fn(event);
    return headers.get("X-Crow-Csrf");
  };
  assert.equal(fire("/dashboard/perch-api/x"), TOKEN, "a same-origin form submission still carries it");
  assert.equal(fire(`${ORIGIN}/dashboard/perch-api/x`), TOKEN);
  assert.equal(fire("/\\evil.example/x"), null, "but never to another origin");
  assert.equal(fire("https://evil.example/x"), null);
  assert.equal(fire("/dashboard/x", "GET"), null, "GET/HEAD/OPTIONS are never given a token");
  assert.equal(sandbox.crowCsrf(), TOKEN);
});