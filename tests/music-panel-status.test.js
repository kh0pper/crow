/**
 * The Music panel's setup check (bundles/music/panel/music.js, CLIENT_SCRIPT).
 *
 * Why these assertions: the panel asked /api/funkwhale/status, a route that only
 * exists while the Funkwhale panel is registered, so an instance with the add-on
 * installed and configured still got "Music needs a library". The client now asks
 * the gateway's /api/music/status and tells three answers apart: no library, a
 * library that did not answer, and a library that is ready.
 *
 * The panel page is rendered through its real handler, its inline script is taken
 * out of the HTML exactly as a browser receives it, and that script is run against
 * a linkedom document with `fetch` stubbed — no socket is opened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const panel = (await import("../bundles/music/panel/music.js")).default;

const NEEDS_LIBRARY = "Music needs a library";
const NOT_REACHABLE = "Music library not reachable";

/** Drives the real panel handler and returns the page it sent. */
async function renderPage() {
  let content = null;
  const res = { send(value) { content = value; return this; } };
  await panel.handler({ query: {} }, res, { layout: (opts) => opts.content });
  assert.equal(typeof content, "string", "the panel sent a page");
  return content;
}

/** The page's inline client script, exactly as the browser receives it. */
async function clientScript() {
  const html = await renderPage();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "the page carries its client script");
  return { html, src: script[1] };
}

const jsonAnswer = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Lets the script's async init (and the render it starts) run to completion. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

/**
 * Renders the panel, runs its client script on a linkedom document and returns the
 * root the script filled. `answer(url)` decides what the stubbed fetch replies.
 */
async function runPanel(answer) {
  const { html, src } = await clientScript();
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(String(url));
  };
  // Only reached when a browse page reports more results; an empty library never
  // gets there, but the script must be free to construct one.
  class IntersectionObserverStub {
    observe() {}
    disconnect() {}
  }

  new Function("window", "document", "fetch", "IntersectionObserver", "location", src)(
    { crowPlayer: null },
    document,
    fetchStub,
    IntersectionObserverStub,
    { origin: "http://crow.invalid" },
  );
  await settle();

  const root = document.getElementById("music-root");
  assert.ok(root, "the panel has its root");
  return { calls, root, text: root.textContent };
}

test("the client asks the gateway status route and its script parses (no backtick tore the template literal)", async () => {
  const { src } = await clientScript();
  assert.doesNotThrow(() => new Function(src), "the client script parses");
  assert.match(src, /'\/api\/music\/status'/, "the check goes to the gateway's own route");
  assert.doesNotMatch(src, /`/, "no backtick inside the template literal");
  assert.doesNotMatch(src, /\$\{/, "no interpolation inside the template literal");
});

test("a ready library shows the panel, not a setup CTA", async () => {
  const { calls, text } = await runPanel((url) =>
    url === "/api/music/status" ? jsonAnswer({ state: "ready" }) : jsonAnswer({ results: [], count: 0 }));

  assert.equal(calls[0].url, "/api/music/status", "the setup check is the first read");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.equal(calls[1]?.url, "/api/funkwhale/browse/artists?page=1&page_size=50",
    "the panel went on to browse the library");
  assert.match(text, /Nothing to show\./, "the browse view took the root, not a CTA");
  assert.ok(!text.includes(NEEDS_LIBRARY), `a configured library is not a missing one: ${text}`);
  assert.ok(!text.includes(NOT_REACHABLE), `and not an unreachable one either: ${text}`);
});

test("no configured library still says Music needs a library", async () => {
  const { text } = await runPanel((url) =>
    url === "/api/music/status" ? jsonAnswer({ state: "not_configured" }) : jsonAnswer({ results: [] }));

  assert.ok(text.includes(NEEDS_LIBRARY), `the install CTA is what the owner sees: ${text}`);
  assert.ok(!text.includes(NOT_REACHABLE), "a missing library is not a broken one");
  assert.ok(text.includes("Open Extensions"), "the way out is still offered");
});

test("a library that did not answer says so, instead of asking for a library", async () => {
  const { text } = await runPanel((url) =>
    url === "/api/music/status" ? jsonAnswer({ state: "unreachable" }) : jsonAnswer({ results: [] }));

  assert.ok(text.includes(NOT_REACHABLE), `the owner is told the library did not answer: ${text}`);
  assert.ok(!text.includes(NEEDS_LIBRARY), "Funkwhale being configured is not denied");
  assert.ok(text.includes("Funkwhale is set up but did not answer."));
  assert.ok(text.includes("Open Extensions"));
});

test("a status route that is not there (404) is treated as unreachable", async () => {
  const { text } = await runPanel(() => jsonAnswer({ error: "not_found" }, 404));
  assert.ok(text.includes(NOT_REACHABLE), `an unusable answer is not a missing library: ${text}`);
  assert.ok(!text.includes(NEEDS_LIBRARY));
});

test("an answer that is not one of the three states is treated as unreachable", async () => {
  const { text } = await runPanel((url) =>
    url === "/api/music/status" ? jsonAnswer({ state: "something-new" }) : jsonAnswer({ results: [] }));
  assert.ok(text.includes(NOT_REACHABLE), `an unknown state fails closed: ${text}`);
  assert.ok(!text.includes(NEEDS_LIBRARY));
});

test("a status read that throws is treated as unreachable", async () => {
  const { text } = await runPanel(() => { throw new Error("network down"); });
  assert.ok(text.includes(NOT_REACHABLE), `a failed read is not a missing library: ${text}`);
  assert.ok(!text.includes(NEEDS_LIBRARY));
});

test("the panel file and this test file end with exactly one newline", () => {
  for (const path of [join(ROOT, "bundles/music/panel/music.js"), join(ROOT, "tests/music-panel-status.test.js")]) {
    const text = readFileSync(path, "utf8");
    assert.ok(text.endsWith("\n"), `${path} ends with a newline`);
    assert.ok(!text.endsWith("\n\n"), `${path} ends with only one`);
  }
});
