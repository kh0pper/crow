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
    <a id="svgish" href="https://example.com/svg">svg</a>
    <a id="rel" href="/rel/path">rel</a>
    <a id="pad" href="  https://example.com/pad  ">pad</a>
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

test("anchor helper: resolves the trimmed href ATTRIBUTE, never a.href (an SVG <a>'s href is an SVGAnimatedString)", () => {
  const h = helperHarness();
  const svg = h.document.getElementById("svgish");
  // An SVG <a> exposes .href as an SVGAnimatedString; stringifying it gives
  // "[object SVGAnimatedString]", so only the attribute is usable.
  Object.defineProperty(svg, "href", { configurable: true, value: { baseVal: "", animVal: "" } });
  const ev = h.click("svgish");
  const link = h.posted.find((m) => m.kind === "open-link");
  assert.ok(link, "the link is still proposed from the attribute");
  assert.equal(link.url, "https://example.com/svg");
  assert.equal(ev.defaultPrevented, true);
  // A relative attribute resolves against the document's base.
  assert.equal(h.click("rel").defaultPrevented, true);
  assert.equal(h.posted.filter((m) => m.kind === "open-link").pop().url, "https://example.com/rel/path");
  // Surrounding whitespace is trimmed before resolution.
  h.click("pad");
  assert.equal(h.posted.filter((m) => m.kind === "open-link").pop().url, "https://example.com/pad");
});

// ── the trusted viewer ────────────────────────────────────────────────────

function viewerHarness() {
  const window = parseHTML(`<!doctype html><html><body>
    <div id="crow-artifact-viewer" data-strings='${JSON.stringify(STRINGS)}'><div class="cv-headtools"></div></div>
    <div id="cv-box"></div>
    <button type="button" class="cv-fs-open" id="cv-full-screen">Full screen</button>
    <button type="button" class="cv-exit-fullscreen" id="cv-exit-full-screen" hidden>Exit full screen</button>
  </body></html>`);
  const document = window.document;
  const listeners = { message: [] };
  // A controllable clock: the viewer's link sheet reads Date.now() for its
  // rate gap, its settle guard and its Cancel cooldown.
  const clock = { t: 1_700_000_000_000 };
  const sandbox = {
    document,
    window: null,
    URL,
    Date: { now: () => clock.t },
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
  return { document, sandbox, listeners, clock };
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
  assert.ok(go.classList.contains("cv-linksheet-wait"), "the way out is inert while the sheet settles");
  h.clock.t += 700;   // past the 600 ms settle guard
  const tap = new Event("click", { bubbles: true, cancelable: true });
  go.dispatchEvent(tap);
  assert.equal(tap.defaultPrevented, false, "after the guard the tap goes through");
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
  const raw = "https://example.com/<b>not-markup</b>";
  const parsed = new URL(raw).href;   // the sheet shows the parsed form, never the raw proposal
  assert.equal(parsed.includes("<"), false, "the parsed form carries no markup");
  send(h, frame, { kind: "open-link", url: raw });
  const s = sheet(h);
  assert.ok(s);
  assert.equal(s.querySelector(".cv-linksheet-url").textContent, parsed);
  assert.equal(s.querySelectorAll(".cv-linksheet-url b").length, 0, "no markup was parsed");
  assert.equal(s.querySelector(".cv-linksheet-host").textContent, "example.com");
  viewer.destroy();
});

test("viewer: an open link sheet is never replaced — a later proposal is dropped even past the rate gap", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  send(h, frame, { kind: "hello" });
  send(h, frame, { kind: "open-link", url: "https://a.example/one" });
  const first = sheet(h);
  assert.ok(first, "sheet A appeared");
  h.clock.t += 2000;   // well past LINK_GAP_MS: only "never replace" can drop this one
  send(h, frame, { kind: "open-link", url: "https://b.example/two" });
  assert.equal(h.document.querySelectorAll(".cv-linksheet").length, 1, "still exactly one sheet");
  assert.equal(sheet(h), first, "it is the same sheet, not a swap");
  assert.equal(first.querySelector(".cv-linksheet-host").textContent, "a.example");
  assert.equal(first.querySelector(".cv-linksheet-url").textContent, "https://a.example/one");
  assert.equal(first.querySelector(".cv-linksheet-go").getAttribute("href"), "https://a.example/one");
  viewer.destroy();
});

test("viewer: the sheet's way out is inert for its first 600 ms (tapjacking)", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  send(h, frame, { kind: "hello" });
  send(h, frame, { kind: "open-link", url: "https://example.com/tap" });
  const go = sheet(h).querySelector(".cv-linksheet-go");
  assert.ok(go.classList.contains("cv-linksheet-wait"), "pointer-events:none while it settles");
  h.clock.t += 100;
  let ev = new Event("click", { bubbles: true, cancelable: true });
  go.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, "a click at 100 ms is refused");
  assert.ok(sheet(h), "and the sheet stays open");
  h.clock.t += 600;   // 700 ms after the sheet appeared
  ev = new Event("click", { bubbles: true, cancelable: true });
  go.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, "a click at 700 ms is not");
  assert.equal(sheet(h), null, "and it closes the sheet");
  viewer.destroy();
});

test("viewer: a trip, and a freshly mounted grant/frame, close any open link sheet", async () => {
  const tripped = viewerHarness();
  const t1 = await start(tripped);
  send(tripped, t1.frame, { kind: "hello" });
  send(tripped, t1.frame, { kind: "open-link", url: "https://example.com/trip" });
  assert.ok(sheet(tripped), "a sheet is open");
  send(tripped, t1.frame, { kind: "open-link", url: "https://example.com/x", nonce: "WRONG_NONCE_12345678" });
  assert.equal(t1.viewer.state().tripped, true, "the wrong nonce tripped the wire");
  assert.equal(sheet(tripped), null, "the trip tore the sheet down with the frame");
  t1.viewer.destroy();

  const remount = viewerHarness();
  const t2 = await start(remount);
  send(remount, t2.frame, { kind: "hello" });
  send(remount, t2.frame, { kind: "open-link", url: "https://example.com/reload" });
  assert.ok(sheet(remount), "a sheet is open");
  await t2.viewer.reload();   // a fresh grant + frame replaces the old one
  assert.equal(sheet(remount), null, "mounting the new frame closed it");
  t2.viewer.destroy();
});

test("viewer: links to the artifact's own origin or to the viewer's origin are dropped", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  send(h, frame, { kind: "hello" });
  send(h, frame, { kind: "open-link", url: "https://art.example/other" });
  assert.equal(sheet(h), null, "the artifact origin is never a way out (a relative link resolves there)");
  send(h, frame, { kind: "open-link", url: "https://dash.example/nest" });
  assert.equal(sheet(h), null, "the viewer's own origin is never a way out either");
  send(h, frame, { kind: "open-link", url: "https://example.com/ok" });
  assert.ok(sheet(h), "another origin is fine");
  viewer.destroy();
});

test("viewer: the sheet shows and opens the PARSED href, never the raw proposal", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  send(h, frame, { kind: "hello" });
  const raw = "https://evil.example\\@good.example/";   // reads like good.example; the host is evil.example
  const parsed = new URL(raw).href;
  assert.equal(parsed, "https://evil.example/@good.example/");
  send(h, frame, { kind: "open-link", url: raw });
  const s = sheet(h);
  assert.ok(s);
  assert.equal(s.querySelector(".cv-linksheet-host").textContent, "evil.example");
  assert.equal(s.querySelector(".cv-linksheet-url").textContent, parsed);
  assert.equal(s.querySelector(".cv-linksheet-go").getAttribute("href"), parsed);
  viewer.destroy();
});

test("viewer: Escape with the link sheet open closes only the sheet, never full screen", async () => {
  const h = viewerHarness();
  const { viewer, frame } = await start(h);
  const open = h.document.getElementById("cv-full-screen");
  assert.ok(open, "the full-screen control is there");
  open.dispatchEvent(new Event("click", { bubbles: true }));
  assert.equal(h.document.body.classList.contains("cv-fullscreen"), true, "full screen on");
  send(h, frame, { kind: "hello" });
  send(h, frame, { kind: "open-link", url: "https://example.com/esc" });
  assert.ok(sheet(h), "the sheet is open over full screen");
  const esc = new Event("keydown", { bubbles: true });
  esc.key = "Escape";
  h.document.dispatchEvent(esc);
  assert.equal(sheet(h), null, "the sheet closed");
  assert.equal(h.document.body.classList.contains("cv-fullscreen"), true, "and full screen stayed on");
  const esc2 = new Event("keydown", { bubbles: true });
  esc2.key = "Escape";
  h.document.dispatchEvent(esc2);
  assert.equal(h.document.body.classList.contains("cv-fullscreen"), false, "a second Escape leaves full screen");
  viewer.destroy();
});

test("viewer.css: the trust warnings stay over the frame in full screen; the sheet's way out starts inert", () => {
  const css = readFileSync(new URL("../bundles/artifacts/panel/static/viewer.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /body\.cv-fullscreen[^{]*\.cv-banners\{display:none\}/, "the banners are never blanket-hidden in full screen");
  assert.match(css, /body\.cv-fullscreen \.cv-banners\{[^}]*position:fixed[^}]*z-index:55/, "the banner layer is pinned over the frame");
  assert.match(css, /body\.cv-fullscreen \.cv-banner:not\(\.cv-danger\):not\(\.cv-iso\)\{display:none\}/, "only the trust warnings survive");
  assert.match(css, /\.cv-linksheet-go\.cv-linksheet-wait\{pointer-events:none\}/, "the way out is inert via CSS too");
});