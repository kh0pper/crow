/**
 * Studio panel — the full load that keeps the wasm CSP.
 *
 * The gateway adds `'wasm-unsafe-eval'` to the Content-Security-Policy only for
 * responses under `/dashboard/studio` (the audio worklet compiles the SunVox
 * WASM engine). Turbo Drive navigates in place and the document keeps the CSP
 * of the FIRST page it loaded, so a Studio reached from another dashboard page
 * had no wasm and no audio. The fix is the response asking Turbo for a full
 * load, which is one meta tag in the head.
 *
 * This file pins the three places that tag has to be:
 *   - both of the panel's pages (the library and a song) hand it to the
 *     dashboard layout's extra-head option;
 *   - the panel's bare page — the fallback used when no layout is handed in —
 *     carries it in its own head;
 *   - and it says plainly (by reading the two files as text) that the gateway
 *     still scopes the wasm carve-out to Studio, and that the public songbook
 *     pages never load Turbo and so never inherit a dashboard document's CSP.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import studioPanel from "../bundles/studio/panel/studio.js";

/** The meta tag a full load is asked for with. */
const RELOAD_META = '<meta name="turbo-visit-control" content="reload">';

/**
 * Assert that an extra-head option asks Turbo for a full load.
 * @param {unknown} head the `head` option the page handed the layout
 * @param {string} where what the page is, for the message
 */
function assertReloadHead(head, where) {
  const text = String(head || "");
  assert.ok(text.includes('name="turbo-visit-control"'), `${where} names turbo-visit-control`);
  assert.ok(text.includes('content="reload"'), `${where} asks for a reload`);
}

// --- the page's server side -------------------------------------------------

/** A database fake: enough of `execute` for the project picker. */
function fakeDb(rows) {
  return {
    async execute() {
      return { rows };
    },
  };
}

/** A response fake with the two properties the handler uses. */
function fakeRes() {
  return {
    headersSent: false,
    html: "",
    send(body) {
      this.html = String(body);
      this.headersSent = true;
    },
    type() {
      return this;
    },
  };
}

/**
 * Run the panel handler with a layout that RECORDS the options it is given, so
 * a test can say what the page asked of the dashboard.
 * @param {{song?: string}} query
 * @returns {Promise<{html: string, layouts: object[]}>}
 */
async function renderWithLayout(query) {
  const layouts = [];
  const res = fakeRes();
  await studioPanel.handler(
    { method: "GET", query, headers: {}, csrfToken: "test-token" },
    res,
    {
      db: fakeDb([{ id: 3, name: "Kitchen songs" }]),
      layout(options) {
        layouts.push(options);
        return `<!doctype html><html><head><meta charset="utf-8"><title>${
          options.title
        }</title></head><body>MARKER${options.content}</body></html>`;
      },
    },
  );
  assert.equal(res.headersSent, true, "the handler should have sent a page");
  return { html: res.html, layouts };
}

/** Run the panel handler with no layout at all: the bare fallback page. */
async function renderBare(query) {
  const res = fakeRes();
  await studioPanel.handler({ method: "GET", query, headers: {} }, res, {
    db: fakeDb([]),
  });
  assert.equal(res.headersSent, true, "the handler should have sent a page");
  return res.html;
}

// --- the two pages ----------------------------------------------------------

test("the song library asks the dashboard for a full load", async () => {
  const { layouts } = await renderWithLayout({});

  assert.equal(layouts.length, 1, "the library page goes through the layout");
  assertReloadHead(layouts[0].head, "the library page");
});

test("a song page asks the dashboard for a full load", async () => {
  const { html, layouts } = await renderWithLayout({ song: "song-1" });

  assert.equal(layouts.length, 1, "the song page goes through the layout");
  assertReloadHead(layouts[0].head, "the song page");
  assert.ok(html.includes('data-studio-song="song-1"'), "and it is the song page that was rendered");
});

test("the head option does not displace the page's own content", async () => {
  const { html, layouts } = await renderWithLayout({ song: "song-1" });

  assert.ok(html.includes("MARKER"), "the layout still wraps the content");
  assert.ok(String(layouts[0].content).includes('data-role="grid"'), "the session grid is in the body");
  assert.equal(
    String(layouts[0].content).includes("turbo-visit-control"),
    false,
    "the meta is head-only: it is never written into the body",
  );
});

// --- the bare page ----------------------------------------------------------

test("a bare render carries the reload meta in its own head", async () => {
  const library = await renderBare({});
  const song = await renderBare({ song: "song-1" });

  for (const [name, html] of [
    ["the library", library],
    ["a song page", song],
  ]) {
    assert.ok(html.includes(RELOAD_META), `${name} carries the Turbo reload meta with no layout`);
    const headEnd = html.indexOf("</head>");
    assert.ok(headEnd > 0, `${name} has a head`);
    assert.ok(
      html.indexOf(RELOAD_META) < headEnd,
      `${name} puts the meta inside the head, where Turbo reads it`,
    );
  }

  assert.ok(song.includes('data-studio-song="song-1"'), "the bare song page is still the song page");
});

// --- the gateway's CSP, read as source --------------------------------------

test("the gateway scopes the wasm carve-out to Studio and its assets", () => {
  // A source assertion, on purpose: the CSP middleware is written inline in
  // servers/gateway/index.js, so there is no function to import and call. What
  // is pinned is the exact shape of the predicate and the script-src line that
  // interpolates it — the two places a change would silently take wasm away
  // from Studio (or hand it to every page).
  const gateway = readFileSync(
    new URL("../servers/gateway/index.js", import.meta.url),
    "utf8",
  );

  const predicate = /const wasmEval =[^;]*;/.exec(gateway);
  assert.ok(predicate, "the gateway declares the wasmEval predicate");
  assert.ok(
    predicate[0].includes('req.path === "/dashboard/studio"'),
    "the exact Studio path gets the carve-out",
  );
  assert.ok(
    predicate[0].includes('req.path.startsWith("/dashboard/studio/")'),
    "and so do the Studio assets under it (the engine, the worklet, the wasm)",
  );
  assert.ok(
    predicate[0].includes('" \'wasm-unsafe-eval\'"'),
    "the carve-out is 'wasm-unsafe-eval' and nothing wider",
  );

  assert.ok(
    gateway.includes("`script-src 'self' 'unsafe-inline'${wasmEval}`"),
    "the script-src directive interpolates the predicate, so the scope is the one above",
  );
});

// --- the public songbook ----------------------------------------------------

test("songbook pages load no Turbo, so no dashboard CSP can be inherited", () => {
  // The songbook pages carry the same 'wasm-unsafe-eval' carve-out under
  // /blog/songbook. They are public, plain documents: reading the renderer is
  // enough to say they never load Turbo Drive, so a visit between them and a
  // dashboard page cannot carry one document's CSP into the other.
  const renderer = readFileSync(
    new URL("../servers/blog/songbook-renderer.js", import.meta.url),
    "utf8",
  );

  assert.equal(
    /turbo/i.test(renderer),
    false,
    "the songbook renderer never loads or mentions Turbo",
  );
});