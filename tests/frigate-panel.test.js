/**
 * The Frigate bundle's panel page and its login rail (panel/frigate.js, panel/routes.js,
 * server/frigate-api.js).
 *
 * Why these assertions: on a phone the panel showed no picture (the stills were never
 * asked for) and the Web UI tab was an iframe on `localhost:8971`, which a phone resolves
 * to itself — the dashboard answered ERR_BLOCKED_BY_CSP. And every page view that fanned
 * out into several proxied reads started its own login; Frigate allows one login per
 * second, so the losers got 429s and the owner was told their password was wrong.
 *
 * Rendered pages are parsed with linkedom; the login tests drive the real route handlers
 * off the router the gateway mounts, with `fetch` stubbed, so no socket is opened.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "bundles", "frigate");
const MANIFEST = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));
const panel = (await import("../bundles/frigate/panel/frigate.js")).default;

const SCRATCH_HOME = mkdtempSync(join(tmpdir(), "crow-frigate-panel-"));
const ENV_KEYS = ["CROW_HOME", "FRIGATE_URL", "FRIGATE_UI_URL", "FRIGATE_USER", "FRIGATE_PASSWORD"];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// A CROW_HOME with no installed bundle: the panel then reads its own client from appRoot,
// so an old installed copy in the developer's home cannot answer for this checkout.
process.env.CROW_HOME = SCRATCH_HOME;
process.env.FRIGATE_URL = "http://frigate.invalid:8971";
delete process.env.FRIGATE_UI_URL;
delete process.env.FRIGATE_USER;
delete process.env.FRIGATE_PASSWORD;

after(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(SCRATCH_HOME, { recursive: true, force: true });
});

/** A response object shaped the way the code reads one. */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** Replace global fetch for one test; `handler` sees (url, init). */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

let importCounter = 0;
/** A fresh copy of a module, so its cached token does not leak into the next case. */
const freshImport = (path) => import(`${path}?frigate-panel-test=${++importCounter}`);

/** Drives the real panel handler and returns the page content the layout was handed. */
async function renderPanel(query = {}) {
  let content = null;
  const res = { send(value) { content = value; return this; } };
  await panel.handler({ query }, res, {
    appRoot: ROOT,
    layout: (opts) => opts.content,
  });
  assert.equal(typeof content, "string", "the panel sent a page");
  return content;
}

const page = (html) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;

/** The page's inline client script, exactly as the browser receives it. */
async function clientScript() {
  const stub = stubFetch((url) => {
    if (url.endsWith("/api/config")) return jsonResponse({ cameras: { front: {} } });
    throw new Error(`unexpected read: ${url}`);
  });
  let html;
  try {
    html = await renderPanel();
  } finally {
    stub.restore();
  }
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "the page carries its client script");
  return script[1];
}

/**
 * Just enough of a browser to run the panel's client script: a document that records its
 * listeners, a setInterval whose callbacks the test fires by hand, and an Image whose load
 * the test settles itself. `fetch` never resolves, so the script's three background reads
 * cannot touch the DOM mid-test.
 */
function stubBrowser(cameraNames = []) {
  const listeners = new Map(); // event type → handlers
  const liveIntervals = new Set();
  const loads = [];

  function element(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      style: {},
      attrs: {},
      children: [],
      className: "",
      textContent: "",
      setAttribute(name, value) { node.attrs[name] = String(value); },
      getAttribute(name) { return Object.hasOwn(node.attrs, name) ? node.attrs[name] : null; },
      appendChild(child) { node.children.push(child); return child; },
      removeChild(child) { node.children = node.children.filter((c) => c !== child); return child; },
      querySelectorAll() { return []; },
    };
    Object.defineProperty(node, "firstChild", { get: () => node.children[0] || null });
    return node;
  }

  const host = element("div");
  const stills = cameraNames.map((name) => {
    const img = element("img");
    img.setAttribute("data-cam", name);
    return img;
  });
  host.querySelectorAll = (selector) => (String(selector).includes("fg-cam-img") ? stills : []);

  const document = {
    hidden: false,
    getElementById: (id) => (id === "fg-cameras" ? host : null),
    createElement: (tag) => element(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      if (!list.includes(handler)) list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
  };

  const window = {};

  function Image() {
    const load = { src: "", onload: null, onerror: null };
    loads.push(load);
    return load;
  }

  return {
    window,
    document,
    stills,
    /** Run the page's client script, the way Turbo re-runs it on a visit. */
    run(src) {
      new Function("window", "document", "Image", "setInterval", "clearInterval", "fetch", src)(
        window,
        document,
        Image,
        (fn, ms) => { const handle = { fn, ms }; liveIntervals.add(handle); return handle; },
        (handle) => { liveIntervals.delete(handle); },
        () => new Promise(() => {}),
      );
    },
    /** Fire whatever the script installed with setInterval. */
    tick() { for (const handle of [...liveIntervals]) handle.fn(); },
    intervals: () => [...liveIntervals],
    images: () => loads,
    listenerCount: (type) => (listeners.get(type) || []).length,
    fire(type) { for (const handler of [...(listeners.get(type) || [])]) handler({ type }); },
  };
}

// ─── the Overview: a still on every camera card ───────────────────────────

// Order note: this bundle's client caches one successful /api/config for 30s, and the panel
// loads that same module copy for every render in this file. The unreadable-Frigate case
// therefore runs first, while nothing is cached yet (a failure is not cached).

test("the Overview still draws when Frigate cannot be read: the browser fills the grid", async () => {
  const stub = stubFetch(() => jsonResponse({ error: "boom" }, { status: 500 }));
  let html;
  try {
    html = await renderPanel();
  } finally {
    stub.restore();
  }
  const document = page(html);
  assert.match(document.getElementById("fg-cameras").textContent, /Loading cameras/,
    "the page keeps its loading line instead of failing to render");
  assert.equal(document.querySelectorAll("#fg-cameras img").length, 0);
});

test("the Overview carries a still for every camera, its name encoded and escaped", async () => {
  const cameras = {
    front: { detect: { width: 1920, height: 1080 }, objects: { track: ["person", "car"] } },
    "cam&<x>": { detect: { enabled: false } },
  };
  const stub = stubFetch((url) => {
    if (url.endsWith("/api/config")) return jsonResponse({ cameras });
    throw new Error(`unexpected read: ${url}`);
  });
  let html;
  try {
    html = await renderPanel();
  } finally {
    stub.restore();
  }

  const document = page(html);
  const imgs = [...document.querySelectorAll("#fg-cameras img")];
  assert.equal(imgs.length, 2, "one still per camera, in config order");
  assert.equal(imgs[0].getAttribute("src"), "/api/frigate/front/latest.jpg");
  assert.equal(imgs[1].getAttribute("src"), "/api/frigate/cam%26%3Cx%3E/latest.jpg",
    "a camera name is URL-encoded into the gateway's still route");
  assert.equal(imgs[0].getAttribute("loading"), "lazy");
  assert.equal(imgs[0].getAttribute("alt"), "front");
  assert.equal(imgs[1].getAttribute("alt"), "cam&<x>", "the attribute decodes back to the name");

  assert.ok(html.includes('data-cam="cam&amp;&lt;x&gt;"'), "the name is HTML-escaped in markup");
  assert.ok(!html.includes("cam<x>"), "no unescaped camera name reaches the page");
  assert.equal(document.querySelectorAll("#fg-cameras .fg-camera").length, 2);
  assert.match(document.querySelectorAll("#fg-cameras .fg-camera")[0].textContent, /1920×1080/);
  assert.match(document.querySelectorAll("#fg-cameras .fg-camera")[0].textContent, /tracking: person, car/);
  assert.match(document.querySelectorAll("#fg-cameras .fg-camera")[1].textContent, /detect off/);

  // The first paint has no cache-buster: the refresh adds one.
  assert.ok(imgs.every((img) => !img.getAttribute("src").includes("?")), "no query on the first paint");
});

test("the client keeps the stills fresh: two seconds, load-then-swap, paused while hidden", async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith("/api/config")) return jsonResponse({ cameras: { front: {} } });
    throw new Error(`unexpected read: ${url}`);
  });
  let html;
  try {
    html = await renderPanel();
  } finally {
    stub.restore();
  }

  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "the page carries its client script");
  const src = script[1];
  assert.doesNotThrow(() => new Function(src), "the client script parses (no backtick tore the template literal)");

  assert.match(src, /STILL_REFRESH_MS = 2000/, "the stills refresh every two seconds");
  assert.match(src, /setInterval\(refreshStills, STILL_REFRESH_MS\)/);
  assert.match(src, /"visibilitychange"/, "a hidden page stops asking");
  assert.match(src, /if \(document\.hidden\) stopStills\(\); else startStills\(true\);/);
  assert.match(src, /new Image\(\)/, "the next still is fetched off-screen");
  assert.match(src, /next\.onload = function \(\) \{\s*img\.style\.display = "";\s*img\.src = next\.src;/,
    "the visible image is swapped only once the new one has loaded, so it never flashes");
  assert.match(src, /"\/api\/frigate\/" \+ encodeURIComponent\(name\) \+ "\/latest\.jpg"/,
    "the browser builds the same gateway route");
  assert.match(src, /\?t=" \+ Date\.now\(\)/, "each refresh is cache-busted");
  assert.doesNotMatch(src, /`/, "no backtick inside the template literal");
});

test("the Overview never names the loopback address Frigate is reached on", async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith("/api/config")) return jsonResponse({ cameras: { front: {} } });
    throw new Error(`unexpected read: ${url}`);
  });
  let html;
  try {
    html = await renderPanel();
  } finally {
    stub.restore();
  }
  assert.ok(!html.includes("localhost:8971"), "FRIGATE_URL is the server's address, not the browser's");
  assert.ok(!html.includes("frigate.invalid"), "and not rendered in any other form either");
});

// ─── the client script: one instance per page, whatever Turbo does ─────────

// Turbo Drive re-runs the inline script on every visit, so a second visit used to leave a
// second interval running — n visits, n timers, all asking Frigate for stills.

test("two Turbo visits leave ONE interval and ONE listener", async () => {
  const src = await clientScript();
  const browser = stubBrowser(["front"]);

  browser.run(src);
  assert.equal(browser.intervals().length, 1, "the first visit starts one interval");
  assert.equal(browser.listenerCount("visibilitychange"), 1, "and one visibility handler");

  browser.run(src); // Turbo Drive re-runs the script for the new page
  assert.equal(browser.intervals().length, 1, "the previous visit's interval was cleared, not left running");
  assert.equal(browser.listenerCount("visibilitychange"), 1, "and its listener was removed");
  assert.equal(browser.listenerCount("turbo:before-cache"), 1, "the page-leave hooks are installed once too");
  assert.equal(browser.listenerCount("turbo:before-visit"), 1);

  browser.fire("visibilitychange");
  assert.equal(browser.images().length, 1, "only one handler ran: the page asked for one still, not two");

  browser.fire("turbo:before-cache");
  assert.equal(browser.intervals().length, 0, "Turbo caching the page stops the timer");

  browser.run(src);
  assert.equal(browser.intervals().length, 1, "the next visit starts again");
  browser.fire("turbo:before-visit");
  assert.equal(browser.intervals().length, 0, "and leaving the page stops it");
});

test("a still still in flight is not asked for again on the next tick", async () => {
  const src = await clientScript();
  const browser = stubBrowser(["front"]);
  browser.run(src);

  browser.tick();
  assert.equal(browser.images().length, 1, "the first tick refreshes the camera");

  browser.tick();
  assert.equal(browser.images().length, 1, "its load has not settled: no second request for that camera");

  browser.images()[0].onload();
  browser.tick();
  assert.equal(browser.images().length, 2, "once it has arrived the next tick refreshes again");

  browser.images()[1].onerror();
  browser.tick();
  assert.equal(browser.images().length, 3, "a failed still frees the camera too");
});

// ─── the Web UI tab: a link in a new tab, never a frame ────────────────────

test("Web UI with FRIGATE_UI_URL set: a new-tab link, and no frame at all", async () => {
  process.env.FRIGATE_UI_URL = "https://frigate.example.ts.net/";
  let html;
  try {
    html = await renderPanel({ tab: "webui" });
  } finally {
    delete process.env.FRIGATE_UI_URL;
  }

  const document = page(html);
  assert.equal(document.querySelectorAll("iframe").length, 0, "the tab embeds nothing");
  const link = document.querySelector(".fg-webui-link");
  assert.ok(link, "the tab offers a link");
  assert.equal(link.getAttribute("href"), "https://frigate.example.ts.net/");
  assert.equal(link.getAttribute("target"), "_blank", "it opens in a new tab");
  assert.equal(link.getAttribute("rel"), "noopener");
  assert.match(document.body.textContent, /FRIGATE_UI_URL|new tab/);
  assert.ok(!html.includes("localhost:8971"));
});

test("Web UI prints only the origin: credentials and a path never reach the page", async () => {
  process.env.FRIGATE_UI_URL = "https://user:s3cret@frigate.example.ts.net/recordings?cam=front";
  let html;
  try {
    html = await renderPanel({ tab: "webui" });
  } finally {
    delete process.env.FRIGATE_UI_URL;
  }

  const document = page(html);
  const link = document.querySelector(".fg-webui-link");
  assert.ok(link, "the tab still offers the link");
  assert.equal(link.getAttribute("href"), "https://user:s3cret@frigate.example.ts.net/recordings?cam=front",
    "the link keeps the full address the owner set");
  assert.equal(document.querySelector(".fg-camera-meta").textContent, "https://frigate.example.ts.net",
    "the printed text is the origin only");
  assert.ok(!document.body.textContent.includes("s3cret"), "no credential is echoed back");
  assert.ok(!document.body.textContent.includes("/recordings"), "and no path either");
});

test("Web UI without FRIGATE_UI_URL: no link, no frame, and it says how to set one", async () => {
  const html = await renderPanel({ tab: "webui" });
  const document = page(html);
  assert.equal(document.querySelectorAll("iframe").length, 0, "the tab embeds nothing");
  assert.equal(document.querySelectorAll(".fg-webui-link").length, 0, "no link to an address nobody gave");
  assert.equal(document.querySelectorAll("a[target=_blank]").length, 0);
  assert.ok(html.includes("FRIGATE_UI_URL"), "it names the setting to fill in");
  assert.ok(!html.includes("localhost:8971"), "never the loopback address");
});

test("Web UI ignores an address that is not http(s): no javascript: link on the page", async () => {
  process.env.FRIGATE_UI_URL = "javascript:alert(1)";
  let html;
  try {
    html = await renderPanel({ tab: "webui" });
  } finally {
    delete process.env.FRIGATE_UI_URL;
  }
  const document = page(html);
  assert.equal(document.querySelectorAll(".fg-webui-link").length, 0);
  assert.ok(!html.includes("javascript:"), "the value is dropped, not printed");
});

// ─── the login rail: one login, and a 429 is not a wrong password ──────────

/** One handler off the router the gateway mounts, by its route path. */
function routeHandler(router, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  assert.ok(layer, `the router serves ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** The handler behind GET /api/frigate/cameras, straight off the router the gateway mounts. */
function camerasHandler(router) {
  return routeHandler(router, "/api/frigate/cameras");
}

/** Calls a route handler with a recording res, and returns what it answered with. */
async function callRoute(handler, req = {}) {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = String(value); return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end(body) { this.body = body; return this; },
  };
  await handler({ query: {}, params: {}, headers: {}, ...req }, res);
  return res;
}

/** Login as Frigate answers it: a token in the JSON body. */
const TOKEN_OK = () => jsonResponse({ access_token: "test-token" }, { headers: { "set-cookie": "frigate_token=test-token; Path=/" } });
const CONFIG_OK = () => jsonResponse({ cameras: { front: { detect: { width: 640, height: 360 } } } });

test("five cold reads at once share ONE login (panel routes)", async () => {
  process.env.FRIGATE_USER = "user";
  process.env.FRIGATE_PASSWORD = "pw";
  const { default: frigateRouter } = await freshImport("../bundles/frigate/panel/routes.js");
  const handler = camerasHandler(frigateRouter((req, res, next) => next()));

  let logins = 0;
  const stub = stubFetch((url) => {
    if (url.endsWith("/api/login")) { logins++; return TOKEN_OK(); }
    if (url.endsWith("/api/config")) return CONFIG_OK();
    throw new Error(`unexpected read: ${url}`);
  });
  let bodies;
  try {
    const answers = await Promise.all(Array.from({ length: 5 }, () => callRoute(handler)));
    bodies = answers.map((r) => r.body);
  } finally {
    stub.restore();
    delete process.env.FRIGATE_USER;
    delete process.env.FRIGATE_PASSWORD;
  }

  assert.equal(logins, 1, "concurrent callers await the same in-flight login");
  for (const body of bodies) {
    assert.equal(body.error, undefined, `no proxied read failed: ${body.error}`);
    assert.equal(body.cameras[0].name, "front");
  }
  const configReads = bodies.length;
  assert.equal(configReads, 5, "all five reads still happened");
});

test("five cold reads at once share ONE login (server client)", async () => {
  process.env.FRIGATE_USER = "user";
  process.env.FRIGATE_PASSWORD = "pw";
  const api = await freshImport("../bundles/frigate/server/frigate-api.js");

  let logins = 0;
  const stub = stubFetch((url) => {
    if (url.endsWith("/api/login")) { logins++; return TOKEN_OK(); }
    if (url.endsWith("/api/stats")) return jsonResponse({ service: { version: "0.18" } });
    throw new Error(`unexpected read: ${url}`);
  });
  let answers;
  try {
    answers = await Promise.all(Array.from({ length: 5 }, () => api.frigateFetch("/api/stats")));
  } finally {
    stub.restore();
    delete process.env.FRIGATE_USER;
    delete process.env.FRIGATE_PASSWORD;
  }
  assert.equal(logins, 1, "the MCP client coalesces too");
  assert.equal(answers.length, 5);
  assert.equal(answers[0].service.version, "0.18");
});

test("a 429 then a 200: the retry logs in and the read succeeds", { timeout: 20_000 }, async () => {
  process.env.FRIGATE_USER = "user";
  process.env.FRIGATE_PASSWORD = "pw";
  const { default: frigateRouter } = await freshImport("../bundles/frigate/panel/routes.js");
  const handler = camerasHandler(frigateRouter((req, res, next) => next()));

  let logins = 0;
  const stub = stubFetch((url) => {
    if (url.endsWith("/api/login")) {
      logins++;
      return logins === 1 ? jsonResponse({ detail: "slow down" }, { status: 429 }) : TOKEN_OK();
    }
    if (url.endsWith("/api/config")) return CONFIG_OK();
    throw new Error(`unexpected read: ${url}`);
  });
  let res;
  try {
    res = await callRoute(handler);
  } finally {
    stub.restore();
    delete process.env.FRIGATE_USER;
    delete process.env.FRIGATE_PASSWORD;
  }
  assert.equal(logins, 2, "the 429 was retried once");
  assert.equal(res.body.error, undefined, `the retry succeeded: ${res.body.error}`);
  assert.equal(res.body.cameras[0].name, "front");
});

test("still rate-limited after every retry: the rate-limit message, not the credentials one", { timeout: 30_000 }, async () => {
  process.env.FRIGATE_USER = "user";
  process.env.FRIGATE_PASSWORD = "pw";

  const cases = [
    {
      name: "panel routes",
      load: async () => {
        const { default: frigateRouter } = await freshImport("../bundles/frigate/panel/routes.js");
        const handler = camerasHandler(frigateRouter((req, res, next) => next()));
        return () => callRoute(handler).then((r) => r.body);
      },
    },
    {
      name: "server client",
      load: async () => {
        const api = await freshImport("../bundles/frigate/server/frigate-api.js");
        return () => api.frigateFetch("/api/config").then(() => ({})).catch((err) => ({ error: err.message }));
      },
    },
  ];

  try {
    for (const c of cases) {
      const run = await c.load();
      let logins = 0;
      const stub = stubFetch((url) => {
        if (url.endsWith("/api/login")) { logins++; return jsonResponse({ detail: "slow down" }, { status: 429 }); }
        throw new Error(`unexpected read: ${url}`);
      });
      let body;
      try {
        body = await run();
      } finally {
        stub.restore();
      }
      assert.equal(logins, 4, `${c.name}: one login plus three retries`);
      assert.match(body.error, /Frigate is rate-limiting logins; try again in a moment/, c.name);
      assert.doesNotMatch(body.error, /FRIGATE_USER/, `${c.name}: the password is not blamed`);
    }
  } finally {
    delete process.env.FRIGATE_USER;
    delete process.env.FRIGATE_PASSWORD;
  }
});

test("401 and 403 are still reported as bad credentials", { timeout: 20_000 }, async () => {
  process.env.FRIGATE_USER = "user";
  process.env.FRIGATE_PASSWORD = "pw";
  try {
    for (const status of [401, 403]) {
      const { default: frigateRouter } = await freshImport("../bundles/frigate/panel/routes.js");
      const handler = camerasHandler(frigateRouter((req, res, next) => next()));
      const stub = stubFetch((url) => {
        if (url.endsWith("/api/login")) return jsonResponse({ detail: "no" }, { status });
        throw new Error(`unexpected read: ${url}`);
      });
      let body;
      try {
        body = (await callRoute(handler)).body;
      } finally {
        stub.restore();
      }
      assert.match(body.error, /check FRIGATE_USER \/ FRIGATE_PASSWORD/, `HTTP ${status}`);
      assert.doesNotMatch(body.error, /rate-limiting/);
    }
  } finally {
    delete process.env.FRIGATE_USER;
    delete process.env.FRIGATE_PASSWORD;
  }
});

// Every still on the page is refreshed every two seconds, so a cacheable one would freeze the
// picture. A thumbnail or snapshot of a finished event never changes, so those may be cached.
test("the still route says no-store; event thumbnails and snapshots keep max-age=300", async () => {
  process.env.FRIGATE_USER = "user";
  process.env.FRIGATE_PASSWORD = "pw";
  const { default: frigateRouter } = await freshImport("../bundles/frigate/panel/routes.js");
  const router = frigateRouter((req, res, next) => next());

  const stub = stubFetch((url) => {
    if (url.endsWith("/api/login")) return TOKEN_OK();
    return jsonResponse({}, { headers: { "content-type": "image/jpeg", "content-length": "0" } });
  });
  try {
    const still = await callRoute(routeHandler(router, "/api/frigate/:camera/latest.jpg"), { params: { camera: "front" } });
    assert.equal(still.statusCode, 200);
    assert.equal(still.headers["content-type"], "image/jpeg");
    assert.equal(still.headers["cache-control"], "no-store", "a still is replaced every two seconds");

    const thumb = await callRoute(routeHandler(router, "/api/frigate/events/:id/thumbnail.jpg"), { params: { id: "1700000000.1" } });
    assert.equal(thumb.headers["cache-control"], "private, max-age=300", "a thumbnail never changes");

    const snap = await callRoute(routeHandler(router, "/api/frigate/events/:id/snapshot.jpg"), { params: { id: "1700000000.1" } });
    assert.equal(snap.headers["cache-control"], "private, max-age=300", "and neither does a snapshot");
  } finally {
    stub.restore();
    delete process.env.FRIGATE_USER;
    delete process.env.FRIGATE_PASSWORD;
  }
});

// Wrong credentials used to mean one login attempt per card, event and still on the page.
// The failure is remembered for five seconds, so Frigate's login endpoint sees one request.
test("a failed login is replayed for five seconds, then tried again", { timeout: 20_000 }, async (t) => {
  process.env.FRIGATE_USER = "user";
  process.env.FRIGATE_PASSWORD = "pw";

  const cases = [
    {
      name: "panel routes",
      load: async () => {
        const { default: frigateRouter } = await freshImport("../bundles/frigate/panel/routes.js");
        const handler = routeHandler(frigateRouter((req, res, next) => next()), "/api/frigate/cameras");
        return () => callRoute(handler).then((r) => r.body);
      },
    },
    {
      name: "server client",
      load: async () => {
        const api = await freshImport("../bundles/frigate/server/frigate-api.js");
        return () => api.frigateFetch("/api/config").then(() => ({}), (err) => ({ error: err.message }));
      },
    },
  ];

  // Mocked Date so the five-second window passes without the suite waiting for it.
  t.mock.timers.enable({ apis: ["Date"] });

  try {
    for (const c of cases) {
      const T0 = 1_000_000;
      t.mock.timers.setTime(T0);
      const run = await c.load();

      let logins = 0;
      const stub = stubFetch((url) => {
        if (url.endsWith("/api/login")) { logins++; return jsonResponse({ detail: "no" }, { status: 401 }); }
        throw new Error(`unexpected read: ${url}`);
      });
      try {
        const first = await run();
        assert.equal(logins, 1, `${c.name}: the first call asks Frigate to log in`);
        assert.match(first.error, /check FRIGATE_USER \/ FRIGATE_PASSWORD/, c.name);

        const second = await run();
        assert.equal(logins, 1, `${c.name}: a call straight after replays the failure, no second login`);
        assert.equal(second.error, first.error, `${c.name}: the same error, word for word`);

        t.mock.timers.setTime(T0 + 4_999);
        const third = await run();
        assert.equal(logins, 1, `${c.name}: still inside the five seconds`);
        assert.equal(third.error, first.error, c.name);

        t.mock.timers.setTime(T0 + 5_001);
        const fourth = await run();
        assert.equal(logins, 2, `${c.name}: past the hold, the login is tried again`);
        assert.match(fourth.error, /check FRIGATE_USER \/ FRIGATE_PASSWORD/, c.name);
      } finally {
        stub.restore();
      }
    }
  } finally {
    delete process.env.FRIGATE_USER;
    delete process.env.FRIGATE_PASSWORD;
  }
});

// ─── manifest and example config ──────────────────────────────────────────

test("the panel file ends with exactly one newline", () => {
  const text = readFileSync(join(BUNDLE, "panel", "frigate.js"), "utf8");
  assert.ok(text.endsWith("\n"), "a trailing newline, as the rest of the repo has");
  assert.ok(!text.endsWith("\n\n"), "and only one");
});

test("the manifest is 1.2.4 and declares FRIGATE_UI_URL", () => {
  assert.equal(MANIFEST.version, "1.2.4");
  const ui = (MANIFEST.env_vars || []).find((v) => v && v.name === "FRIGATE_UI_URL");
  assert.ok(ui, "the browser-facing address is a declared env var, or the panel never sees it");
  assert.equal(ui.required, false, "blank means the Web UI link is hidden");
  assert.match(ui.description, /Address your browser uses to open Frigate's own web UI/);
  assert.match(ui.description, /Leave blank to hide the Web UI link/);
});

test("the example camera has detection switched on (Frigate 0.18 needs it)", () => {
  const yml = readFileSync(join(BUNDLE, "config.yml.example"), "utf8");
  const detect = /^\s{4}detect:\n([\s\S]*?)^\s{4}objects:/m.exec(yml);
  assert.ok(detect, "the example camera has a detect: block");
  assert.match(detect[1], /^\s{6}enabled: true$/m, "detect.enabled: true is what turns detection on");
});

test("an installed copy refreshes its compose file on a version change", () => {
  // The compose binds WebRTC 8555 to loopback; an install made before that change
  // kept publishing it on every interface because a docker bundle's compose is
  // only refreshed when the manifest opts in (manifest.refreshFiles).
  assert.ok(Array.isArray(MANIFEST.refreshFiles) && MANIFEST.refreshFiles.includes("docker-compose.yml"));
});
