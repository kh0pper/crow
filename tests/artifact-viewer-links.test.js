// Links out of an artifact (owner request 2026-10-30): the anchor helper
// proposes an http(s) link after a click, and the TRUSTED viewer turns that
// proposal into a confirm sheet. Nothing navigates by itself; malformed or
// unsafe proposals are dropped. Both sides are exercised here with linkedom
// (the same lightweight DOM the repo already depends on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML, Event } from "linkedom";
import { anchorHelperSource } from "../servers/gateway/artifact-origin/anchor-helper.js";

const VIEWER_SRC = readFileSync(new URL("../bundles/artifacts/panel/static/viewer.js", import.meta.url), "utf8");
const NONCE = "NONCE_1234567890123456";
const GRANT = {
  url: "https://art.example/v/" + "A".repeat(43) + "/",
  tokenId: "t".repeat(64),
  nonce: NONCE,
  sandbox: "allow-scripts",
  scripted: true,
  type: "page",
};
const STRINGS = { open_link: "Open this link?", open_link_go: "Open in your browser", cancel: "Cancel" };

// ── the anchor helper (same realm as untrusted content) ────────────────────

function helperHarness() {
  const window = parseHTML(`<!doctype html><html><body>
    <p id="p">some words</p>
    <a id="ok" href="https://example.com/x">ok</a>
    <a id="js" href="javascript:alert(1)">js</a>
    <a id="data" href="data:text/html,hi">data</a>
    <a id="frag" href="#p">frag</a>
    <a id="mail" href="mailto:a@example.com">mail</a>
  </body></html>`);
  const document = window.document;
  const posted = [];
  const listeners = { message: [] };
  const sandbox = {
    document,
    parent: { postMessage: (m) => posted.push(m) },
    addEventListener: (type, fn) => { if (type === "message") listeners.message.push(fn); },
    removeEventListener: () => {},
    getSelection: () => null,
    setTimeout, clearTimeout, console, URL,
    location: { href: "https://example.com/doc" },
  };
  vm.createContext(sandbox);
  vm.runInContext(anchorHelperSource(NONCE), sandbox);
  posted.length = 0;   // the helper's hello
  const commentMode = (on) => {
    for (const fn of listeners.message) fn({ source: sandbox.parent, data: { t: "crow-viewer", kind: "comment-mode", on: !!on } });
  };
  const click = (id) => {
    const ev = new Event("click", { bubbles: true, cancelable: true });
    document.getElementById(id).dispatchEvent(ev);
    return ev;
  };
  return { document, posted, commentMode, click };
}

test("anchor helper: a click on an http(s) link posts open-link with the resolved URL and prevents default", () => {
  const h = helperHarness();
  const ev = h.click("ok");
  const link = h.posted.find((m) => m.kind === "open-link");
  assert.ok(link, "an open-link proposal was posted");
  assert.equal(link.t, "crow-artifact");
  assert.equal(link.nonce, NONCE);
  assert.equal(link.url, "https://example.com/x");
  assert.equal(ev.defaultPrevented, true, "the artifact never navigates itself");
});

test("anchor helper: javascript:/data: links are prevented and not posted; #fragments and mailto: are left alone", () => {
  const h = helperHarness();
  for (const id of ["js", "data"]) {
    const ev = h.click(id);
    assert.equal(ev.defaultPrevented, true, `${id} is prevented`);
    assert.equal(h.posted.filter((m) => m.kind === "open-link").length, 0, `${id} is never proposed`);
  }
  for (const id of ["frag", "mail"]) {
    const ev = h.click(id);
    assert.equal(ev.defaultPrevented, false, `${id} keeps its own behaviour`);
    assert.equal(h.posted.filter((m) => m.kind === "open-link").length, 0, `${id} is never proposed`);
  }
});

test("anchor helper: in comment mode a click is a proposal, never a link interception", () => {
  const h = helperHarness();
  h.commentMode(true);
  h.click("ok");
  assert.equal(h.posted.filter((m) => m.kind === "open-link").length, 0, "no open-link while proposing anchors");
});

// ── the trusted viewer ────────────────────────────────────────────────────

function viewerHarness() {
  const window = parseHTML(`<!doctype html><html><body>
    <div id="crow-artifact-viewer" data-strings='${JSON.stringify(STRINGS)}'><div class="cv-headtools"></div></div>
    <div id="cv-box"></div>
  </body></html>`);
  const document = window.document;
  const listeners = { message: [] };
  const sandbox = {
    document,
    window: null,
    URL,
    location: { origin: "https://dash.example", hash: "" },
    setTimeout, clearTimeout, console,
    addEventListener: (type, fn) => { if (type === "message") listeners.message.push(fn); },
    removeEventListener: (type, fn) => { const a = listeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  };
  sandbox.window = sandbox;
  // linkedom has no browsing contexts: give every iframe a contentWindow so
  // the viewer's source check can be exercised.
  const create = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = create(tag);
    if (String(tag).toLowerCase() === "iframe") el.contentWindow = { frame: el, postMessage: () => {} };
    return el;
  };
  vm.createContext(sandbox);
  vm.runInContext(VIEWER_SRC, sandbox);
  return { document, sandbox, listeners };
}

async function start(h) {
  const viewer = h.sandbox.CrowArtifactViewer.mount({
    container: h.document.getElementById("cv-box"),
    mint: () => Promise.resolve(GRANT),
    revoke: () => Promise.resolve(),
    cspProofMs: 50,
  });
  const loading = viewer.load();
  // The CSP canary: prove the narrowed policy in force without a real browser.
  const proof = new Event("securitypolicyviolation");
  proof.blockedURI = "https://csp-canary.invalid/";
  proof.effectiveDirective = "frame-src";
  h.document.dispatchEvent(proof);
  await loading;
  const frame = h.document.querySelector("iframe.crow-artifact-frame");
  assert.ok(frame, "the frame mounted");
  return { viewer, frame };
}

function send(h, frame, data, source) {
  const msg = Object.assign({ t: "crow-artifact", nonce: NONCE }, data);
  for (const fn of h.listeners.message.slice()) fn({ source: source || frame.contentWindow, origin: "null", data: msg });
}
const sheet = (h) => h.document.querySelector(".cv-linksheet");

test("viewer: an open-link before hello, with a wrong nonce, or from another window shows no sheet", async () => {
  const before = viewerHarness();
  const b = await start(before);
  send(before, b.frame, { kind: "open-link", url: "https://example.com/early" });
  assert.equal(sheet(before), null, "ignored before hello");
  send(before, b.frame, { kind: "hello" });
  send(before, b.frame, { kind: "open-link", url: "https://example.com/ok" });
  assert.ok(sheet(before), "the same proposal is accepted after hello");
  b.viewer.destroy();

  const wrong = viewerHarness();
  const w = await start(wrong);
  send(wrong, w.frame, { kind: "hello" });
  send(wrong, w.frame, { kind: "open-link", url: "https://example.com/x", nonce: "WRONG_NONCE_12345678" });
  assert.equal(sheet(wrong), null, "wrong nonce: no sheet");
  assert.equal(w.viewer.state().tripped, true, "wrong nonce is a trip, exactly like every other kind");

  const other = viewerHarness();
  const o = await start(other);
  send(other, o.frame, { kind: "hello" });
  send(other, o.frame, { kind: "open-link", url: "https://example.com/x" }, { not: "our frame" });
  assert.equal(sheet(other), null, "only the live framed window can propose");
  o.viewer.destroy();
});

test("viewer: ftp:, javascript:, credential-bearing and over-long URLs are dropped", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  send(h, frame, { kind: "hello" });
  const bad = [
    "ftp://example.com/x",
    "javascript:alert(1)",
    "https://user:secret@example.com/x",
    "https://example.com/" + "a".repeat(2048),
  ];
  for (const url of bad) {
    send(h, frame, { kind: "open-link", url });
    assert.equal(sheet(h), null, `dropped: ${url.slice(0, 40)}`);
  }
  viewer.destroy();
});

test("viewer: a valid open-link shows the trusted sheet with the host, the full URL and a safe new-tab link", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  send(h, frame, { kind: "hello" });
  const url = "https://example.com/a/b?c=1#d";
  send(h, frame, { kind: "open-link", url });
  const s = sheet(h);
  assert.ok(s, "the sheet appeared");
  assert.equal(s.getAttribute("role"), "dialog");
  assert.equal(s.querySelector(".cv-linksheet-title").textContent, "Open this link?");
  assert.equal(s.querySelector(".cv-linksheet-host").textContent, "example.com");
  assert.equal(s.querySelector(".cv-linksheet-url").textContent, url);
  const go = s.querySelector(".cv-linksheet-go");
  assert.equal(go.textContent, "Open in your browser");
  assert.equal(go.getAttribute("href"), url);
  assert.equal(go.getAttribute("target"), "_blank");
  assert.equal(go.getAttribute("rel"), "noopener noreferrer");
  assert.ok(s.querySelector(".cv-linksheet-cancel"), "a Cancel control");
  go.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  assert.equal(sheet(h), null, "tapping the link closes the sheet (navigation is the browser's job)");
  viewer.destroy();
});

test("viewer: two link proposals within 1.5 s show one sheet", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  send(h, frame, { kind: "hello" });
  send(h, frame, { kind: "open-link", url: "https://example.com/first" });
  send(h, frame, { kind: "open-link", url: "https://example.com/second" });
  const all = h.document.querySelectorAll(".cv-linksheet");
  assert.equal(all.length, 1, "one sheet");
  assert.equal(all[0].querySelector(".cv-linksheet-url").textContent, "https://example.com/first", "the extra is dropped, not swapped in");
  viewer.destroy();
});

test("viewer: the URL is placed with textContent — a URL containing <b> renders literally", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  send(h, frame, { kind: "hello" });
  const url = "https://example.com/<b>not-markup</b>";
  send(h, frame, { kind: "open-link", url });
  const s = sheet(h);
  assert.ok(s);
  assert.equal(s.querySelector(".cv-linksheet-url").textContent, url);
  assert.equal(s.querySelectorAll(".cv-linksheet-url b").length, 0, "no markup was parsed");
  assert.equal(s.querySelector(".cv-linksheet-host").textContent, "example.com");
  viewer.destroy();
});