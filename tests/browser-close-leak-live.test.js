// LIVE (real Chromium + real Playwright): what a page can still send when it is
// CLOSED, and why the guard blanks every page before it closes it.
//
// What the spikes on Chromium 143 / Playwright 1.58.2 established (each point is
// what one of the cases below pins down):
//
//  1. The probe page has to be SERVED by a real node http server on 127.0.0.2. A
//     page whose document came from `page.route(...).fulfill()` counts, to
//     Chromium, as a non-loopback origin, so its requests to 127.0.0.1 are
//     dropped by Private/Local Network Access before ANY route of ours is
//     consulted — which is exactly how an earlier, route-fulfilled probe came to
//     see 0 hits in its control while proving nothing. Linux routes all of
//     127/0.0/8 to loopback, so 127.0.0.2 is a real, distinct loopback origin
//     that needs nothing but a listening socket.
//
//  2. With a real page, CLOSING it runs its pagehide/unload handlers and their
//     sendBeacon / keepalive fetch / Image requests DO reach a private server
//     even with the route guard live: a request issued while the target is being
//     torn down never passes through Playwright's interception, so the guard
//     cannot see it. (Case 1.)
//
//  3. Navigating the page to about:blank FIRST is not enough on its own: the
//     pagehide requests that navigation fires leak too, and neither the guard's
//     context route nor a plain abort-all `context.route` sees them. (Case 1b.)
//
//  4. What does stop them is a RAW per-page CDP deny-all: a page-scoped
//     `context.newCDPSession(page)`, `Fetch.enable` with a catch-all pattern, and
//     a `Fetch.failRequest { errorReason: "BlockedByClient" }` for every
//     `Fetch.requestPaused`. That held a nav-away at 0 hits, and closing the
//     blanked page afterwards leaked 0 too.
//
//  5. In HEADFUL Chromium closing the LAST page also exits the browser, so the one
//     page the cleanup leaves behind has to be a FRESH tab: a survivor created
//     with `context.newPage()` before anything else is touched. That is also the
//     only way to close the OLD page 0 — a survivor page whose history is empty
//     cannot be walked Back into the bot's document, while the old page 0 can
//     (its history and back-forward cache outlive a blank). (Case 3.)
//
// The exit contract these cases pin down (blankPagesOnExit): create the fresh
// about:blank survivor FIRST; then, for every OLD page including index 0, attach
// its own deny-all session, navigate it to about:blank, and close it ONLY once
// that commit was observed. FAIL CLOSED: a page whose blank fails, rejects or
// does not commit is NEVER closed (a close fires its pagehide beacons with
// nothing in front of them) — the cleanup crashes the browser instead, and never
// falls back to `Browser.close`, which would close those very pages (Case 5).
//
// Cases 2 and 5 are EXPECTED RED against the product code before that contract
// lands: their failure is the bug report, not a broken test. Case 1 is case 5's
// control (closing that page naively does reach the private server).
//
// Case 7 is the OOPIF half of that exit contract, and it is EXPECTED RED too: the
// deny-all Fetch session blankPagesOnExit attaches lives on each PAGE's CDP
// session, and a CROSS-SITE iframe under site isolation is an out-of-process
// iframe (OOPIF) in its OWN target with its own session, which a page-level
// session does not cover — so the frame's pagehide/unload beacons still reach a
// private server while the page is blanked and closed. The product fix is a
// deny-all session on every OOPIF frame as well. Its control is the same page
// closed NAIVELY (case 1's shape); a control that shows no hits makes the
// cleanup's 0 vacuous, and case 7 then FAILS saying the control did not
// reproduce.
//
// Case 8 checks the guard's page-world half on a real Chromium: `GUARD_MARKER` is
// not readable from a page (Playwright wraps the init script's source, and nothing
// in the product reads the marker back), so what a live test can honestly assert
// are the EFFECTS of that script in a real document — a refused service-worker
// registration and throwing WebRTC constructors — with the same page in an
// UNGUARDED context as the control, so a refusal is attributable to the guard.
//
// Case 2 asserts that a Back press on the page left behind stays on about:blank.
// That only says something about the SURVIVOR if Back would otherwise work, so
// case 2c is its control: a page that was REUSED (probe page A, then probe page
// B, then about:blank) has a real history and Back restores probe page B. The
// probe origin is the guard's one exception and nothing here touches a private
// address, so this is history, not the private-address rule, doing the work.
//
// Case 6 is the behavioural half of the relay's `--disable-features=BackForwardCache`:
// probe page A, probe page B, then Back — page A records its own `pageshow`
// event's `persisted` flag. With the flag a Back press must RELOAD page A
// (`persisted === false`); the control is the same sequence WITHOUT the flag, and
// only a `true` there makes the flagged `false` mean anything. On a Chromium that
// never restores from bfcache under automation the control is reported as a
// diagnostic and the case skips (the flag stays asserted in the relay argv tests).
//
// Opt-in by availability: needs playwright-core (the browser bundle's own copy,
// the repo's own bundles/browser/node_modules copy, or CROW_TEST_PLAYWRIGHT_DIR)
// and a Chromium/Chrome (tests/fixtures/
// headless-chrome.mjs for headless, a full chromium-*/chrome for the headful
// case, which also needs Xvfb). Missing either → the affected cases skip;
// CROW_REQUIRE_TEST_CHROME=1 turns those skips into failures, as elsewhere in
// the suite.
//
// Every browser here is THIS test's own: its own profile, its own process group
// (spawned detached), killed by its own pid in a finally. Nothing here greps for
// processes or touches a browser it did not start. One browser at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  blankPagesOnExit,
  blankPageSafely,
  installPrivateAddressGuard,
  parseExceptions,
} from "../bundles/browser/server/private-address.js";
import { createPageOwnership } from "../bundles/browser/server/page-ownership.js";
import { findChrome } from "./fixtures/headless-chrome.mjs";

const REQUIRE_CHROME = process.env.CROW_REQUIRE_TEST_CHROME === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Skip (or fail loudly, under CROW_REQUIRE_TEST_CHROME=1) — never both silently. */
function skipOrFail(t, why) {
  if (REQUIRE_CHROME) throw new Error(`CROW_REQUIRE_TEST_CHROME=1: ${why}`);
  t.skip(why);
}

// ---------------------------------------------------------------------------
// Playwright: the browser bundle's own copy, or CROW_TEST_PLAYWRIGHT_DIR
// ---------------------------------------------------------------------------

/**
 * Where playwright-core may live: an explicit dir first, then the installed
 * bundle's, then the repo's own bundles/browser/node_modules copy.
 */
function playwrightDirs() {
  return [
    process.env.CROW_TEST_PLAYWRIGHT_DIR,
    join(homedir(), ".crow", "bundles", "browser", "node_modules", "playwright-core"),
    fileURLToPath(
      new URL("../bundles/browser/node_modules/playwright-core", import.meta.url),
    ),
  ].filter((dir) => typeof dir === "string" && dir.length > 0);
}

/**
 * Load playwright-core's `chromium`: its index.mjs when it has one, else the
 * package main through createRequire (a CommonJS build). Never throws: the
 * caller decides between a skip and a failure.
 */
async function loadPlaywright() {
  const problems = [];
  for (const dir of playwrightDirs()) {
    if (!existsSync(dir)) {
      problems.push(`${dir}: not installed`);
      continue;
    }
    const esm = join(dir, "index.mjs");
    if (existsSync(esm)) {
      try {
        const mod = await import(pathToFileURL(esm).href);
        if (mod && mod.chromium) return { chromium: mod.chromium, from: esm };
        problems.push(`${esm}: no chromium export`);
        continue;
      } catch (err) {
        problems.push(`${esm}: ${err && err.message}`);
      }
    }
    try {
      const require = createRequire(join(dir, "package.json"));
      const mod = require(dir);
      if (mod && mod.chromium) return { chromium: mod.chromium, from: dir };
      problems.push(`${dir}: no chromium export`);
    } catch (err) {
      problems.push(`${dir}: ${err && err.message}`);
    }
  }
  return { chromium: null, problems };
}

// ---------------------------------------------------------------------------
// Chrome: headless from the suite's finder, full chromium for the headful case
// ---------------------------------------------------------------------------

/** A FULL chrome (not the headless shell) for the headful case: ~/.cache/ms-playwright/chromium-*. */
function findHeadfulChrome(env = process.env) {
  if (env.CROW_TEST_FULL_CHROME) return existsSync(env.CROW_TEST_FULL_CHROME) ? env.CROW_TEST_FULL_CHROME : null;
  const base = env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  let dirs = [];
  try {
    dirs = readdirSync(base)
      .filter((d) => d.startsWith("chromium-")) // NOT chromium_headless_shell-
      .sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)))
      .map((d) => join(base, d));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    for (const sub of ["chrome-linux", "chrome-linux64"]) {
      const bin = join(dir, sub, "chrome");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

function which(name) {
  try {
    const p = execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return p || null;
  } catch {
    return null;
  }
}

/**
 * The argv a launched Chromium gets. `extraFeatures` join the ONE
 * `--disable-features` switch: Chromium keeps only the last value of a repeated
 * switch, so a second flag would silently drop the list above. `extraArgs` are
 * plain switches appended as they are: an ENABLE flag such as `--site-per-process`
 * is not a feature, and putting it in `--disable-features` would turn it OFF.
 */
function chromeArgs({ profile, headless, extraFeatures = [], extraArgs = [] }) {
  const disabledFeatures = ["CalculateNativeWinOcclusion", "IntensiveWakeUpThrottling", ...extraFeatures];
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--disable-features=${disabledFeatures.join(",")}`,
    // A full chrome needs the flag; the headless shell is headless by nature.
    ...(headless ? ["--headless"] : []),
    // Plain switches (NOT features: see the note above `chromeArgs`).
    ...extraArgs,
    "about:blank",
  ];
}

/**
 * Start this test's own Chromium and attach Playwright over CDP, the way prod
 * does (a debugging port, a private profile).
 *
 * `extraFeatures` are disabled through the same single `--disable-features`
 * switch as the defaults (see `chromeArgs`). `extraArgs` are plain switches put
 * on the command line as they are — for an ENABLE flag such as
 * `--site-per-process`, which `extraFeatures` would invert.
 *
 * @returns {Promise<{error: string} | {browser: object, child: object, profile: string, port: number, close: () => Promise<void>}>}
 */
async function launchBrowser({ chromium, headful = false, display = null, timeoutMs = 20000, extraFeatures = [], extraArgs = [] }) {
  const bin = headful ? findHeadfulChrome() : findChrome();
  if (!bin) {
    return {
      error: headful
        ? "no full Chromium for a headful run (looked for ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome; CROW_TEST_FULL_CHROME overrides)"
        : "no Chrome binary (tests/fixtures/headless-chrome.mjs: CROW_TEST_CHROME, ~/.cache/ms-playwright, or a system chrome)",
    };
  }
  const profile = mkdtempSync(join(tmpdir(), "crow-leak-chrome-"));
  const headless = !headful && !/headless/i.test(bin);
  const child = spawn(bin, chromeArgs({ profile, headless, extraFeatures, extraArgs }), {
    env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true, // its own process group: kill(-pid) reaches its children, never ours
  });
  let log = "";
  child.stderr.on("data", (d) => { if (log.length < 8000) log += d.toString(); });
  child.on("error", (err) => { log += `\nspawn failed: ${err && err.message}`; });

  const close = async () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(3000)]);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  // The port Chromium picked, from the file it writes into its profile.
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let port = 0;
  while (Date.now() < deadline) {
    try {
      const first = readFileSync(portFile, "utf8").split("\n")[0].trim();
      const n = Number(first);
      if (Number.isInteger(n) && n > 0) { port = n; break; }
    } catch { /* not written yet */ }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (!port) {
    await close();
    return { error: `Chromium never wrote ${portFile}: ${log.trim().slice(0, 600)}` };
  }
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: timeoutMs });
    return { browser, child, profile, port, close };
  } catch (err) {
    await close();
    return { error: `connectOverCDP to 127.0.0.1:${port} failed: ${err && err.message}` };
  }
}

/** Poll `check` until it is true (or the deadline passes). */
async function waitUntil(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(150);
  }
  return false;
}

/** Await a browser call but never forever: a page.close() racing the browser's own exit can hang. */
const withTimeout = (promise, ms) => Promise.race([
  Promise.resolve(promise).catch((err) => ({ error: err })),
  sleep(ms).then(() => ({ timedOut: true })),
]);

/** Does this Chrome's DevTools endpoint still answer? (The belt for isConnected().) */
async function devtoolsAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// the private server, the probe page's own server, and the leak page
// ---------------------------------------------------------------------------

/** A loopback http server that records every GET/POST to /hit (the "private server"). */
async function startPrivateServer(t) {
  const hits = [];
  const server = createServer((req, res) => {
    const url = String(req.url || "");
    const pathname = url.split("?")[0];
    if (pathname === "/hit") hits.push({ method: req.method, url });
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  t.after(() => new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }));
  return { port, url: `http://127.0.0.1:${port}`, hits };
}

// The probe page's own origin: 127.0.0.2, a SECOND loopback address (Linux routes
// all of 127/0.0/8 to loopback). It has to be served by a real http server, not
// fulfilled by page.route(): Chromium counts a route-fulfilled document as a
// non-loopback origin and then drops its requests to 127.0.0.1 under
// Private/Local Network Access, before any route of ours sees them — a control
// that "proves" the gap with such a page proves nothing at all.
//
// This host is the ONE exception the guard gets below, so the probe page itself
// loads while 127.0.0.1 (the private server) stays refused.
const PROBE_HOST = "127.0.0.2";

/**
 * The private server's twin for the probe page: a real http server on
 * PROBE_HOST; the tag comes from the path, so one server serves every page.
 *
 * Binding 127.0.0.2 fails on a platform (or a kernel config) that does not route
 * all of 127/0.0/8 to loopback; the caller then skips with that reason rather
 * than pretending the control ran. It also fails if that address is somehow
 * already taken, which is equally a reason not to run.
 *
 * @returns {Promise<{error: string} | {port: number, url: string}>}
 */
async function startProbeServer(t, privateUrl) {
  const server = createServer((req, res) => {
    const pathname = (() => {
      try {
        return new URL(String(req.url || "/"), `http://${PROBE_HOST}`).pathname;
      } catch {
        return "";
      }
    })();
    const tag = (pathname.match(/^\/([a-z0-9-]{1,32})\/?$/i) || [])[1];
    if (!tag) {
      res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("not a probe page (ask for /<tag>)");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(leakPageHtml(privateUrl, tag));
  });
  const bound = await new Promise((resolve) => {
    server.once("error", (err) => resolve({ error: err }));
    server.listen(0, PROBE_HOST, () => resolve({ ok: true }));
  });
  if (bound.error) {
    const why = bound.error.code || bound.error.message;
    try { server.close(); } catch { /* never listening */ }
    return {
      error: `could not bind ${PROBE_HOST} (${why}): the probe page needs a real loopback ` +
        "http origin there (a route-fulfilled page counts as non-loopback to Chromium and its requests " +
        "to 127.0.0.1 are dropped by Private/Local Network Access before any route can judge them)",
    };
  }
  const { port } = server.address();
  t.after(() => new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }));
  return { port, url: `http://${PROBE_HOST}:${port}` };
}

/**
 * The probe page: on pagehide AND unload it fires all three transports a
 * closing page uses at a private address, tagged so a hit names its page.
 *
 * It also records what its own `pageshow` event said: `window.__pageshow` is the
 * event's `persisted` flag, `true` only when Chromium restored this document from
 * the back-forward cache instead of parsing it again (the bfcache case below).
 */
function leakPageHtml(privateUrl, tag) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>leak probe</title></head>
<body><h1>leak probe</h1>
<script>
(function () {
  var PRIVATE = ${JSON.stringify(privateUrl)};
  var TAG = ${JSON.stringify(tag)};
  window.addEventListener("pageshow", function (e) { window.__pageshow = e.persisted; });
  function hit(kind) {
    var url = PRIVATE + "/hit?t=" + kind + "&tag=" + TAG;
    try { navigator.sendBeacon(url); } catch (e) {}
    try { fetch(url, { keepalive: true, mode: "no-cors" }).catch(function () {}); } catch (e) {}
    try { new Image().src = url; } catch (e) {}
  }
  window.addEventListener("pagehide", function () { hit("pagehide"); });
  window.addEventListener("unload", function () { hit("unload"); });
  window.__leakProbeReady = TAG;
})();
</script></body></html>`;
}

/**
 * Load the probe page for `tag` from the probe server: a real document on a real
 * loopback origin, so its later requests to 127.0.0.1 are Crow's guard's to
 * judge (and not Chromium's Private/Local Network Access to drop unseen).
 */
async function loadLeakPage(page, { probe, privateUrl, tag }) {
  await page.goto(`${probe.url}/${tag}`, { waitUntil: "load", timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__leakProbeReady), tag, "the probe page's handlers are installed");
}

/**
 * The guard, live, with the probe page's origin excepted — and nothing else.
 *
 * `parseExceptions` returns `{hosts, cidrs, rejected}`; the probe page is a bare
 * address, so it lands in `hosts` (canonical, so exactly this address). The
 * private server on 127.0.0.1 is NOT excepted, which is what keeps this a test
 * of the rule rather than of an allow-all.
 */
async function installGuardAllowingProbe(context) {
  const exceptions = parseExceptions(PROBE_HOST);
  assert.deepEqual(exceptions.rejected, [], `${PROBE_HOST} is not a valid CROW_BROWSER_ALLOW_PRIVATE entry`);
  assert.ok(
    exceptions.hosts.has(PROBE_HOST),
    `the probe page's own origin (${PROBE_HOST}) has to be in the guard's exception list, ` +
      `else the guard refuses the page it is meant to load (parsed: ${JSON.stringify([...exceptions.hosts])})`,
  );
  return installPrivateAddressGuard(context, { exceptions });
}

/**
 * Does this refusal record name the private server? A refusal carries the URL it
 * was recorded for, the host it names, and the address it judged (`refusals.push`
 * in private-address.js); the server's own port is what tells it apart from the
 * probe page (which lives on loopback too).
 */
function refusalNamesServer(refusal, server) {
  let target = null;
  try {
    target = new URL(server.url);
  } catch {
    return false;
  }
  const url = String((refusal && refusal.url) || "");
  let asked = null;
  try {
    asked = new URL(url);
  } catch {
    asked = null;
  }
  // Same host AND port: the private server's origin, never the probe page's.
  if (asked) return asked.host === target.host;
  // A URL we cannot parse still usually spells its host:port; require the whole
  // authority (a port is a prefix of a longer one, so no bare substring match).
  const host = String((refusal && refusal.host) || "");
  return host === target.hostname && url.includes(`${target.host}/`);
}

/**
 * The sanity check: a plain fetch at the private server from the page never lands,
 * and the reason it never landed is the GUARD — not Chromium.
 *
 * The hit count alone cannot tell those apart. Chromium refuses a page's request
 * to a loopback address on its own in some configurations (PNA/LNA, an opaque
 * origin, a blocked scheme), and then the guard's route is never even consulted:
 * the probe would look "live" while proving nothing about Crow's rule. So the
 * guard object is required here, and a refusal recorded for the private server
 * (its host and port, in `url`/`host`) is the evidence that the route aborted it.
 *
 * @param {object} page
 * @param {{url: string, hits: Array}} server
 * @param {{refusals: Array}} guard - the object installPrivateAddressGuard returned
 * @returns {Promise<{outcome: string, refusals: Array}>} the fetch outcome and the
 *   refusals this check recorded
 */
async function assertGuardIsLive(page, server, guard) {
  const before = server.hits.length;
  const refusalsBefore = guard.refusals.length;
  const outcome = await page.evaluate(async (base) => {
    try {
      await fetch(`${base}/hit?t=plain&tag=sanity`, { cache: "no-store" });
      return "resolved";
    } catch (err) {
      return `refused: ${err && err.message}`;
    }
  }, server.url);
  await sleep(600);
  assert.equal(
    server.hits.length,
    before,
    `the private-address guard is not live: a plain fetch from the page reached the private server (${outcome})`,
  );

  const recorded = guard.refusals.slice(refusalsBefore);
  const named = recorded.filter((refusal) => refusalNamesServer(refusal, server));
  assert.ok(
    named.length > 0,
    "the sanity fetch never reached the private server, but the guard recorded no refusal for it " +
      `(fetch: ${outcome}; refusals recorded by the guard: ${JSON.stringify(recorded)}) — so Chromium ` +
      "(Private/Local Network Access, an opaque origin, a blocked scheme) dropped the request before " +
      "Crow's route saw it. The guard is not what stopped it, so this probe proves nothing; the probe " +
      `page has to be served from a real loopback origin (${PROBE_HOST}), not fulfilled by a route.`,
  );
  return { outcome, refusals: recorded };
}

/** A fake process (and its stdin) that no exit event can terminate: blankPagesOnExit's seam. */
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  return proc;
}

/** The tags a recorded hit names, for a readable "which page leaked" failure. */
const tagsOf = (hits) => hits.map((h) => (String(h.url).match(/tag=([^&]*)/) || [])[1] || "unTagged");

/** Hits a given probe page (by tag) produced. */
const hitsFrom = (hits, tag) => hits.filter((h) => String(h.url).includes(`tag=${tag}`));

// ---------------------------------------------------------------------------
// case 1: the control — a naive close DOES leak (if not, the probe is broken)
// ---------------------------------------------------------------------------

test("live: closing a guarded page straight away sends its pagehide keepalives to a private server (control)", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    const guard = await installGuardAllowingProbe(context);

    // Two probe pages: closing one must not be the browser's last page, so the
    // close-time requests have a live browser to leave through.
    const first = context.pages()[0] || await context.newPage();
    await loadLeakPage(first, { probe, privateUrl: server.url, tag: "control-0" });
    const second = await context.newPage();
    await loadLeakPage(second, { probe, privateUrl: server.url, tag: "control-1" });
    const sanity = await assertGuardIsLive(second, server, guard);

    // The naive close: no about:blank first.
    const refusalsBeforeClose = guard.refusals.length;
    await withTimeout(second.close(), 10000);
    await sleep(1500);
    const closeRefusals = guard.refusals.slice(refusalsBeforeClose);
    const closeHint = closeRefusals.length
      ? `the page DID send ${closeRefusals.length} close-time request(s) and the guard caught them at the route, ` +
        "so this Chromium does not reproduce the spike's teardown leak (the guard sees pagehide requests here)"
      : "nothing was sent at all on the close (Chromium dropped the requests, or pagehide never fired)";

    assert.ok(
      server.hits.length >= 1,
      "the probe/control did not reproduce: closing a guarded page sent nothing to the private server " +
        `(0 hits after 1.5 s, sanity fetch: ${sanity.outcome}, guard refusals recorded during the close: ` +
        `${closeRefusals.length}${closeRefusals.length ? ` ${JSON.stringify(closeRefusals)}` : ""}) — ` +
        `${closeHint}, so the blank-before-close probe proves nothing here`,
    );
  } finally {
    await chrome.close();
  }
});

// ---------------------------------------------------------------------------
// case 1b: the control the fix has to answer — a BARE guard does not stop
// pagehide on a navigation away, so blanking alone leaks
// ---------------------------------------------------------------------------

test("live: navigating a guarded page to about:blank still sends its pagehide keepalives (control)", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    // Today's guard and nothing else: no raw CDP Fetch session on the page. This
    // case documents that the Playwright route alone does not stop a pagehide
    // request riding a navigation.
    const guard = await installGuardAllowingProbe(context);

    const page = context.pages()[0] || await context.newPage();
    await loadLeakPage(page, { probe, privateUrl: server.url, tag: "navigate" });
    const sanity = await assertGuardIsLive(page, server, guard);

    const refusalsBefore = guard.refusals.length;
    const navigated = await withTimeout(page.goto("about:blank", { waitUntil: "load", timeout: 15000 }), 15000);
    await sleep(1500);
    const refusals = guard.refusals.slice(refusalsBefore);
    const landed = page.url();
    assert.equal(
      landed,
      "about:blank",
      `the page did not navigate away (${JSON.stringify(navigated)}; url: ${landed}), so this control ` +
        "says nothing about the pagehide requests a navigation fires",
    );

    assert.ok(
      server.hits.length >= 1,
      "the probe did not reproduce: blanking a guarded page with today's guard (a context route, no raw CDP " +
        `Fetch session) sent nothing to the private server (0 hits after 1.5 s, sanity fetch: ` +
        `${sanity.outcome}, guard refusals recorded: ` +
        `${refusals.length}${refusals.length ? ` ${JSON.stringify(refusals)}` : ""}) — something stopped ` +
        "the navigation's pagehide requests, and nothing here can tell the guard's route from Chromium " +
        "itself, so case 2's red would not mean what it says",
    );
  } finally {
    await chrome.close();
  }
});

// ---------------------------------------------------------------------------
// case 2: the fix path — a fresh survivor, then blank + close EVERY old page
// ---------------------------------------------------------------------------

// EXPECTED RED until blankPagesOnExit creates the survivor first and closes every
// old page (index 0 included) after its own about:blank commit: today's cleanup
// leaves the old page 0 open, so the page left behind is one of the two probe
// pages and its history can still be walked Back into the bot's document.
test("live: the exit cleanup leaves ONE fresh blank page with no history and leaks nothing", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    const guard = await installGuardAllowingProbe(context);

    // Two pages with the same pagehide/unload probe. Both are OLD pages: the
    // cleanup has to blank and CLOSE both of them, index 0 included.
    const first = context.pages()[0] || await context.newPage();
    await loadLeakPage(first, { probe, privateUrl: server.url, tag: "page-0" });
    const second = await context.newPage();
    await loadLeakPage(second, { probe, privateUrl: server.url, tag: "page-1" });
    assert.equal(context.pages()[0], first, "page creation order is context.pages() order");
    assert.equal(context.pages()[1], second);
    await assertGuardIsLive(second, server, guard);

    // The add-on's own cleanup, driven through its seam.
    const proc = fakeProc();
    const run = blankPagesOnExit(() => context, { proc });
    proc.stdin.emit("close");
    await run();
    await sleep(1500);

    assert.deepEqual(
      server.hits,
      [],
      `a request escaped the blank-then-close cleanup (tags: ${JSON.stringify(tagsOf(server.hits))}) — ` +
        "blanking the page under the context guard alone does not stop the pagehide requests a " +
        "navigation fires; a per-page deny-all raw CDP Fetch session has to be attached before it",
    );
    assert.equal(
      hitsFrom(server.hits, "page-0").length,
      0,
      "the old page at index 0 leaked nothing while it was blanked and closed",
    );
    assert.equal(
      hitsFrom(server.hits, "page-1").length,
      0,
      "the page that was blanked then closed (index 1) leaked nothing",
    );

    const single = await waitUntil(async () => context.pages().length === 1, 5000);
    assert.ok(single, `exactly one page is left (still ${context.pages().length} pages)`);
    const left = context.pages()[0];
    assert.notEqual(left, first, "the page left behind is NOT the old index-0 page: an old page survives only with its history");
    assert.notEqual(left, second, "the page left behind is NOT the old index-1 page either");
    assert.equal(
      left.url(),
      "about:blank",
      "the page left behind is the fresh survivor, which starts at about:blank and is never navigated again",
    );

    // The reason the survivor has to be fresh: a Back press must not be able to
    // restore the bot's page. The old page 0's history and back/forward cache
    // would have done exactly that — this page has no history at all.
    const wentBack = await withTimeout(left.goBack({ timeout: 3000 }), 8000);
    const wentBackUrl = wentBack && typeof wentBack.url === "function" ? wentBack.url() : null;
    assert.equal(
      left.url(),
      "about:blank",
      `a Back press restored something else (${left.url()}): the page left behind has a history entry, so it is not a fresh survivor`,
    );
    assert.ok(
      wentBackUrl === null || wentBackUrl === "about:blank",
      `the fresh survivor has no history to go back to (goBack landed on ${wentBackUrl})`,
    );
  } finally {
    await chrome.close();
  }
});

// ---------------------------------------------------------------------------
// case 2c: the control for case 2's Back assertion — a REUSED page's history is
// real, so "no Back into the bot's page" is about the fresh survivor
// ---------------------------------------------------------------------------

// Case 2 asserts that a Back press on the page the cleanup leaves behind stays on
// about:blank. On its own that could also mean Back never works on any page of
// this browser. This case rules that out on a page that was REUSED exactly like
// the bot's page 0: probe page A, then probe page B, then about:blank, then Back —
// and Back restores probe page B. The probe origin is the guard's one exception
// and no private address is involved, so what brings the document back here is
// the page's own history.
test("live: a reused page's Back really restores the earlier probe page (control)", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    await installGuardAllowingProbe(context);

    // ONE page, two documents in a row: exactly the shape of the bot's page after
    // it has been reused for a second navigation.
    const page = context.pages()[0] || await context.newPage();
    await loadLeakPage(page, { probe, privateUrl: server.url, tag: "history-a" });
    await loadLeakPage(page, { probe, privateUrl: server.url, tag: "history-b" });

    await blankPageSafely(page);
    assert.equal(page.url(), "about:blank", "the page committed the about:blank navigation");

    const back = await withTimeout(page.goBack({ timeout: 8000 }), 15000);
    const backUrl = back && typeof back.url === "function" ? back.url() : null;
    assert.equal(
      backUrl,
      `${probe.url}/history-b`,
      `Back on a REUSED page did not restore the earlier document (goBack returned ${backUrl}; the page is at ` +
        `${page.url()}) — if this browser has no history here, case 2's "a Back press stays on about:blank" ` +
        "proves nothing about the survivor: it has to be the FRESH page, not history being unavailable",
    );
    assert.equal(page.url(), `${probe.url}/history-b`, "the reused page is back on probe page B");
    assert.equal(
      await page.evaluate(() => window.__leakProbeReady),
      "history-b",
      "the document Back restored is really probe page B's (its own marker is there)",
    );
  } finally {
    await chrome.close();
  }
});

// ---------------------------------------------------------------------------
// case 2b: the mid-session blank — blankPageSafely leaks nothing, and the page
// stays usable afterwards (the session is detached)
// ---------------------------------------------------------------------------

// The control for this case is the case above ("navigating a guarded page to
// about:blank still sends its pagehide keepalives"): the SAME bare navigation,
// under the same guard, does leak. What differs here is blankPageSafely's deny-all
// raw CDP Fetch session attached before the navigation. The two mid-session sites
// that used to blank under the context guard alone (the onResponse blank for a
// private-address answer, and crow_browser_navigate's) now go through it.
test("live: blankPageSafely leaks nothing and leaves the page usable for a later navigation", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    const guard = await installGuardAllowingProbe(context);

    const page = context.pages()[0] || await context.newPage();
    await loadLeakPage(page, { probe, privateUrl: server.url, tag: "safe-blank" });
    const sanity = await assertGuardIsLive(page, server, guard);

    const refusalsBefore = guard.refusals.length;
    await blankPageSafely(page);
    assert.equal(page.url(), "about:blank", "the page committed the about:blank navigation");
    await sleep(1500);

    assert.deepEqual(
      server.hits,
      [],
      `a pagehide/unload request escaped blankPageSafely (tags: ${JSON.stringify(tagsOf(server.hits))}, sanity ` +
        `fetch: ${sanity.outcome}, guard refusals recorded: ${guard.refusals.length - refusalsBefore}) — without ` +
        "the deny-all raw CDP Fetch session, a bare about:blank navigation leaks exactly like the control case above",
    );

    // The session must be DETACHED once the blank is done, or every later
    // navigation of this page would be failed and the page would be dead.
    await page.goto(`${probe.url}/after-blank`, { waitUntil: "load", timeout: 15000 });
    assert.equal(page.url(), `${probe.url}/after-blank`, "a later navigation of the same page still works");
    assert.equal(
      await page.evaluate(() => window.__leakProbeReady),
      "after-blank",
      "the reloaded document really ran: the raw deny-all session did not survive the blank",
    );
  } finally {
    await chrome.close();
  }
});

// ---------------------------------------------------------------------------
// case 3: headful, the last page — closing it exits the browser, blanking it does not
// ---------------------------------------------------------------------------

/** A private Xvfb on a display number nothing else uses, killed by its own pid. */
async function startXvfb(t) {
  const bin = which("Xvfb");
  if (!bin) return { error: "Xvfb is not installed (no X display for a headful Chromium)" };
  for (let n = 90; n < 140; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const child = spawn(bin, [`:${n}`, "-screen", "0", "800x600x24"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    let log = "";
    child.stderr.on("data", (d) => { if (log.length < 4000) log += d.toString(); });
    let exited = false;
    child.on("exit", () => { exited = true; });
    const stop = async () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      await Promise.race([new Promise((r) => child.once("exit", r)), sleep(2000)]);
    };
    const up = await waitUntil(() => exited || existsSync(`/tmp/.X11-unix/X${n}`), 10000);
    if (up && !exited) {
      t.after(stop);
      return { display: `:${n}`, stop };
    }
    await stop();
    if (exited && log.trim()) t.diagnostic(`Xvfb :${n} exited: ${log.trim().slice(0, 300)}`);
  }
  return { error: "no free X display number between :90 and :139" };
}

// This case only ever loads about:blank pages, so it needs no probe server.
test("live headful: closing the last page exits Chromium; a fresh survivor keeps it alive and usable", async (t) => {
  if (!which("Xvfb")) {
    skipOrFail(t, "Xvfb is not installed (no X display for a headful Chromium)");
    return;
  }
  const headfulBin = findHeadfulChrome();
  if (!headfulBin) {
    if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
      t.skip("headful case needs a full Chromium; CI has only the headless shell (pending the operator's OK to add one to the job image)");
      return;
    }
    skipOrFail(t, "no full Chromium for a headful run (looked for ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome)");
    return;
  }
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const xvfb = await startXvfb(t);
  if (xvfb.error) {
    skipOrFail(t, xvfb.error);
    return;
  }

  // The control: close every page naively. Headful Chromium has no tabs left, so
  // it exits — and anything the pages were doing goes with it.
  const control = await launchBrowser({ chromium: pw.chromium, headful: true, display: xvfb.display });
  if (control.error) {
    skipOrFail(t, control.error);
    return;
  }
  try {
    const browser = control.browser;
    const context = browser.contexts()[0];
    assert.ok(context, "the headful browser has a default context");
    if (context.pages().length === 0) await context.newPage();
    assert.ok(context.pages().length >= 1, "the headful browser has a page");
    for (const page of [...context.pages()]) {
      await withTimeout(page.close(), 5000); // the browser may exit mid-loop
    }
    const gone = await waitUntil(async () => browser.isConnected() === false || !(await devtoolsAnswers(control.port)), 8000);
    assert.ok(gone, "headful Chromium stayed alive after its last page was closed, so the last-page rule is untestable here");
  } finally {
    await control.close();
  }

  // The fix path: two pages, then the cleanup. Every OLD page is blanked and
  // closed — in headful Chromium that would close the last tab and exit the
  // browser, so a FRESH survivor has to exist first.
  const fixed = await launchBrowser({ chromium: pw.chromium, headful: true, display: xvfb.display });
  if (fixed.error) {
    skipOrFail(t, fixed.error);
    return;
  }
  try {
    const browser = fixed.browser;
    const context = browser.contexts()[0];
    assert.ok(context, "the headful browser has a default context");
    if (context.pages().length === 0) await context.newPage();
    await context.newPage();
    assert.equal(context.pages().length, 2, "two pages before the cleanup");
    const originals = [...context.pages()];

    const proc = fakeProc();
    const run = blankPagesOnExit(() => context, { proc });
    proc.stdin.emit("close");
    await run();
    await sleep(1000);

    assert.equal(
      browser.isConnected(),
      true,
      "the browser survived: the cleanup closed every old page, and the fresh survivor is what kept it alive",
    );
    const settled = await waitUntil(async () => context.pages().length === 1, 5000);
    assert.ok(settled, `one about:blank page remains (got ${context.pages().length})`);
    const survivor = context.pages()[0];
    assert.ok(
      !originals.includes(survivor),
      "the page left behind is a FRESH survivor, not one of the two old pages (closing both old ones is what would exit the browser)",
    );
    assert.equal(survivor.url(), "about:blank", "and the survivor is the blank page the cleanup made first");
    const extra = await withTimeout(context.newPage(), 10000);
    assert.ok(extra && !extra.error && !extra.timedOut, "a new page can still be opened: the browser is alive and usable");
    assert.equal(context.pages().length, 2, "the new page joined the context");
  } finally {
    await fixed.close();
  }
});

// ---------------------------------------------------------------------------
// case 5: FAIL CLOSED — a page that will not blank is NEVER closed; the browser
// dies instead
// ---------------------------------------------------------------------------

// The control for this case is case 1 above ("closing a guarded page straight
// away sends its pagehide keepalives to a private server"): closing that page
// naively puts >= 1 request on the private server. So the cleanup must not close
// a page whose blank did not commit — the only safe end for that page is the
// death of the browser it lives in (Browser.crash; never Browser.close, whose
// page closes would fire exactly those beacons).
test("live: a page whose blank fails is never closed — the cleanup crashes the browser instead", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    const guard = await installGuardAllowingProbe(context);

    const first = context.pages()[0] || await context.newPage();
    await loadLeakPage(first, { probe, privateUrl: server.url, tag: "fail-0" });
    const stubborn = await context.newPage();
    await loadLeakPage(stubborn, { probe, privateUrl: server.url, tag: "fail-1" });
    await assertGuardIsLive(first, server, guard);
    const hitsBefore = server.hits.length;

    // The one page the cleanup cannot blank: its `goto` rejects, so the REAL page
    // is never navigated away and its pagehide handlers stay armed. Everything
    // else is forwarded to the real page, so the cleanup sees an ordinary page
    // right up to the blank.
    let closeCalls = 0;
    const stubbornView = {
      url: () => stubborn.url(),
      isClosed: () => stubborn.isClosed(),
      context: () => stubborn.context(),
      goto: async () => { throw new Error("this page will not blank"); },
      // Deliberately NOT closing the real page: if the cleanup closes it, the
      // counter says so and `stubborn.isClosed()` stays false — the leak is its.
      close: async () => { closeCalls += 1; },
    };
    // The same context, with the wrapper standing in for one page in pages().
    const view = new Proxy(context, {
      get(target, prop) {
        if (prop === "pages") return () => context.pages().map((p) => (p === stubborn ? stubbornView : p));
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const proc = fakeProc();
    const run = blankPagesOnExit(() => view, { proc });
    proc.stdin.emit("close");
    await run();

    // The hard evidence, checked on the tick the cleanup returns: it never asked
    // that page to close. (Closing it is the one thing that fires the pagehide
    // beacons this whole file is about.) `isClosed()` is only trustworthy while
    // the browser is still answering: the crash that fails closed takes the page
    // with it, so a closed page here must mean the cleanup closed it.
    assert.equal(
      closeCalls,
      0,
      "the cleanup called close() on a page whose blank failed: that close fires exactly the pagehide beacons it exists to stop",
    );
    if (await devtoolsAnswers(chrome.port)) {
      assert.equal(
        stubborn.isClosed(),
        false,
        "the page that would not blank is still open while its browser lives: the cleanup must not close it, it has to fail closed",
      );
    }

    const died = await waitUntil(async () => !(await devtoolsAnswers(chrome.port)), 5000);
    assert.ok(
      died,
      "the browser is still answering 5 s after a blank failed: a page that cannot be blanked must never be left " +
        "running unguarded — the cleanup has to Browser.crash it (never Browser.close: closing it would fire the " +
        "very pagehide beacons this case checks for)",
    );
    await sleep(1000);
    assert.deepEqual(
      server.hits.slice(hitsBefore),
      [],
      `a request escaped while the browser was killed (tags: ${JSON.stringify(tagsOf(server.hits.slice(hitsBefore)))}) — ` +
        "the page that would not blank was closed before the crash, which is the leak case 1 controls for",
    );
  } finally {
    await chrome.close();
  }
});

// ---------------------------------------------------------------------------
// case 6: the relay's --disable-features=BackForwardCache, behaviourally
// ---------------------------------------------------------------------------

// A "Back" on the page left behind must not be able to bring the bot's document
// back. The survivor the cleanup leaves has no history at all, which is case 2's
// argument; this case pins the OTHER half — the relay launches Chromium with
// `--disable-features=BackForwardCache`, so even the history that does exist (an
// old page that had to be left open, the VNC viewer's own Back) cannot restore a
// document from the back-forward cache: it is loaded again, from the network,
// under whatever guard is in front of it then.
//
// The probe page records its own `pageshow` event (`window.__pageshow` = the
// event's `persisted` flag), which is the only honest way to see a bfcache
// restore: `goBack()` resolves either way.
//
// The CONTROL is the same sequence WITHOUT the flag. If this Chromium does not
// restore from the cache even then (automation and a headless shell commonly
// disable bfcache outright), `persisted === false` would say nothing about the
// flag — so the control's result is reported as a diagnostic and this behavioural
// case skips, leaving the flag to the relay argv tests that assert it directly.

/**
 * Probe page A, navigate to probe page B, press Back, and report what page A's
 * own `pageshow` event said: `persisted === true` means Chromium restored it from
 * the back-forward cache instead of parsing the document again.
 *
 * Its own browser (as in every case above), its own servers, closed in a finally.
 *
 * @returns {Promise<{error: string} | {persisted: boolean}>}
 */
async function backFromCache(t, { chromium, extraFeatures = [] }) {
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) return { error: probe.error };
  const chrome = await launchBrowser({ chromium, extraFeatures });
  if (chrome.error) return { error: chrome.error };
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    await installGuardAllowingProbe(context);

    // ONE page, two documents: page A, then page B. Back has to return to A.
    const page = context.pages()[0] || await context.newPage();
    await loadLeakPage(page, { probe, privateUrl: server.url, tag: "bfcache-a" });
    assert.equal(await page.evaluate(() => window.__pageshow), false, "page A's first load is not a restore");
    await loadLeakPage(page, { probe, privateUrl: server.url, tag: "bfcache-b" });
    assert.equal(page.url(), `${probe.url}/bfcache-b`, "the page is on probe page B before Back");

    const back = await withTimeout(page.goBack({ timeout: 15000 }), 25000);
    // The URL, not goBack's return value: a bfcache restore makes no network
    // request, so the response goBack hands back may be null either way.
    const backUrl = back && typeof back.url === "function" ? back.url() : null;
    assert.equal(
      page.url(),
      `${probe.url}/bfcache-a`,
      `Back did not land on probe page A (the page is at ${page.url()}, goBack returned ${backUrl}) — ` +
        "nothing to say about bfcache",
    );
    assert.equal(
      await page.evaluate(() => window.__leakProbeReady),
      "bfcache-a",
      "the document on screen is probe page A's",
    );
    const persisted = await page.evaluate(() => window.__pageshow);
    assert.equal(
      typeof persisted,
      "boolean",
      `the probe's pageshow handler never ran on the way back (window.__pageshow === ${JSON.stringify(persisted)}), ` +
        "so there is no evidence either way",
    );
    return { persisted };
  } finally {
    await chrome.close();
  }
}

test("live: --disable-features=BackForwardCache makes a Back press reload the page instead of restoring it", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }

  // The control FIRST, without the flag: only a `true` here makes the flagged
  // run's `false` mean "the flag did it".
  const control = await backFromCache(t, { chromium: pw.chromium });
  if (control.error) {
    skipOrFail(t, control.error);
    return;
  }
  t.diagnostic(`bfcache control (no flag): pageshow.persisted === ${control.persisted}`);
  if (control.persisted !== true) {
    t.diagnostic(
      "the control never showed persisted === true: this Chromium does not restore pages from the back-forward " +
        "cache under automation, so the same sequence cannot tell the flag apart from an already-disabled cache",
    );
    t.skip("bfcache not observable on this Chromium; the flag is asserted in the relay argv tests only");
    return;
  }

  const flagged = await backFromCache(t, { chromium: pw.chromium, extraFeatures: ["BackForwardCache"] });
  if (flagged.error) {
    skipOrFail(t, flagged.error);
    return;
  }
  assert.equal(
    flagged.persisted,
    false,
    "with --disable-features=BackForwardCache the Back press STILL restored probe page A from the back-forward " +
      `cache (pageshow.persisted === ${flagged.persisted}) — the flag the relay passes is not doing what the exit ` +
      "path relies on; the control run without it restored from the cache (persisted === true)",
  );
});

// ---------------------------------------------------------------------------
// case 7: a CROSS-SITE iframe (OOPIF) at exit — the PAGE's deny-all session does
// not cover it
// ---------------------------------------------------------------------------

// blankPagesOnExit attaches its raw deny-all Fetch session to each PAGE's CDP
// session. A cross-site iframe with site isolation on is an out-of-process iframe
// (OOPIF): it lives in its OWN target with its own CDP session, and a page-level
// Fetch session does not cover it — so the frame's pagehide/unload beacons are not
// failed when the page is blanked and closed. EXPECTED RED until the cleanup also
// attaches a deny-all session to every OOPIF frame (`context.newCDPSession(frame)`
// succeeds for an OOPIF frame and throws for a same-process one).
//
// The CONTROL is the same page closed NAIVELY (`page.close()`, as in case 1), and
// it has to show the iframe's hits: if it does not, a 0 after the cleanup would be
// vacuous, so this case then FAILS saying the control did not reproduce.
//
// The iframe has to be a DIFFERENT site, not a different port on the same one: it
// is served from 127.0.0.3 (Linux routes all of 127/0.0/8 to loopback) by its own
// real http server, and Chromium is launched with `--site-per-process` so the
// isolation is not left to the platform's defaults.

/** The cross-site iframe's origin: a SECOND site, not just a second port. */
const CROSS_SITE_PROBE_HOST = "127.0.0.3";

/**
 * A probe server on ANY loopback address, serving `render(tag)` for `/<tag>`.
 *
 * `startProbeServer` serves the leak page on PROBE_HOST (127.0.0.2); the
 * cross-site case needs a second ADDRESS besides it (127.0.0.3), whose documents
 * are the FRAME's — so this is the same server with the host and the document as
 * parameters. Binding the address fails on a platform (or a kernel config) that
 * does not route all of 127/0.0/8 to loopback; the caller skips with that reason,
 * exactly as `startProbeServer` makes it skip for 127.0.0.2.
 *
 * @returns {Promise<{error: string} | {port: number, url: string}>}
 */
async function startProbeServerAt(t, host, render) {
  const server = createServer((req, res) => {
    const pathname = (() => {
      try {
        return new URL(String(req.url || "/"), `http://${host}`).pathname;
      } catch {
        return "";
      }
    })();
    const tag = (pathname.match(/^\/([a-z0-9-]{1,32})\/?$/i) || [])[1];
    if (!tag) {
      res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("not a probe page (ask for /<tag>)");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(render(tag));
  });
  const bound = await new Promise((resolve) => {
    server.once("error", (err) => resolve({ error: err }));
    server.listen(0, host, () => resolve({ ok: true }));
  });
  if (bound.error) {
    const why = bound.error.code || bound.error.message;
    try { server.close(); } catch { /* never listening */ }
    return {
      error: `could not bind ${host} (${why}): the cross-site probe needs a real loopback http origin there — ` +
        "an out-of-process iframe has to be a different SITE, and a route-fulfilled document counts as " +
        "non-loopback to Chromium (its requests to 127.0.0.1 would be dropped before any route judges them)",
    };
  }
  const { port } = server.address();
  t.after(() => new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }));
  return { port, url: `http://${host}:${port}` };
}

/**
 * The CROSS-SITE iframe's own document: the same three unload transports the
 * probe page uses (sendBeacon, `keepalive` fetch, Image), tagged so a hit names
 * the frame, plus a marker the case waits for before it trusts the beacons.
 */
function crossSiteFrameHtml(privateUrl, tag) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>cross-site frame probe</title></head>
<body><h1>cross-site frame probe</h1>
<script>
(function () {
  var PRIVATE = ${JSON.stringify(privateUrl)};
  var TAG = ${JSON.stringify(tag)};
  function hit(kind) {
    var url = PRIVATE + "/hit?t=" + kind + "&tag=" + TAG;
    try { navigator.sendBeacon(url); } catch (e) {}
    try { fetch(url, { keepalive: true, mode: "no-cors" }).catch(function () {}); } catch (e) {}
    try { new Image().src = url; } catch (e) {}
  }
  window.addEventListener("pagehide", function () { hit("frame-pagehide"); });
  window.addEventListener("unload", function () { hit("frame-unload"); });
  window.__frameProbeReady = TAG;
})();
</script></body></html>`;
}

/**
 * The top document, served from PROBE_HOST: it embeds the cross-site iframe and
 * sets `window.__leakProbeReady` only once that iframe's load event has fired, so
 * `loadLeakPage`'s marker check also means "the frame really loaded". Its own
 * pagehide/unload handlers are the same three transports, under its own tag, so a
 * cleanup that fails for the PAGE (not the frame) is visible in the failure.
 */
function crossSitePageHtml({ privateUrl, tag, frameSrc }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>cross-site probe page</title></head>
<body><h1>cross-site probe page</h1>
<iframe id="cross-site-frame" src="${frameSrc}" width="320" height="120"></iframe>
<script>
(function () {
  var PRIVATE = ${JSON.stringify(privateUrl)};
  var TAG = ${JSON.stringify(tag)};
  function hit(kind) {
    var url = PRIVATE + "/hit?t=" + kind + "&tag=" + TAG;
    try { navigator.sendBeacon(url); } catch (e) {}
    try { fetch(url, { keepalive: true, mode: "no-cors" }).catch(function () {}); } catch (e) {}
    try { new Image().src = url; } catch (e) {}
  }
  window.addEventListener("pagehide", function () { hit("pagehide"); });
  window.addEventListener("unload", function () { hit("unload"); });
  var frameEl = document.getElementById("cross-site-frame");
  frameEl.addEventListener("load", function () { window.__leakProbeReady = TAG; });
})();
</script></body></html>`;
}

/**
 * The guard, live, with the probe origins excepted — and nothing else.
 *
 * The same contract as `installGuardAllowingProbe`, for the case that needs TWO
 * probe origins: the top document's and the cross-site iframe's. The private
 * server on 127.0.0.1 is NOT excepted, which is what keeps this a test of the
 * rule rather than of an allow-all.
 */
async function installGuardAllowingProbes(context, hosts) {
  const exceptions = parseExceptions(hosts.join(","));
  assert.deepEqual(exceptions.rejected, [], `${hosts.join(",")} are not valid CROW_BROWSER_ALLOW_PRIVATE entries`);
  for (const host of hosts) {
    assert.ok(
      exceptions.hosts.has(host),
      `the probe origin ${host} has to be in the guard's exception list, else the guard refuses a document the ` +
        `probe needs (parsed: ${JSON.stringify([...exceptions.hosts])})`,
    );
  }
  return installPrivateAddressGuard(context, { exceptions });
}

/**
 * This case's browser: `--site-per-process`, the guard allowing BOTH probe origins
 * (and nothing else), the cross-site probe page loaded — and the iframe PROVEN
 * out-of-process before the caller asserts anything about its beacons.
 *
 * The proof is `context.newCDPSession(frame)`: Playwright offers a CDP session for
 * an out-of-process FRAME and throws for a same-process one, so a browser that
 * will not isolate this frame has nothing to say here and the caller skips on the
 * `{error}` ("iframe not out-of-process on this Chromium").
 *
 * @returns {Promise<{error: string} | {chrome: object, context: object, page: object, frame: object, frameTag: string, guard: object, close: () => Promise<void>}>}
 */
async function openCrossSiteProbe({ chromium, topProbe, frameProbe, tag }) {
  const chrome = await launchBrowser({ chromium, extraArgs: ["--site-per-process"] });
  if (chrome.error) return { error: chrome.error };
  const frameTag = `frame-${tag}`;
  const giveUp = async (why) => {
    await chrome.close();
    return { error: why };
  };
  try {
    const context = chrome.browser.contexts()[0];
    if (!context) return await giveUp("the launched browser has no default context");
    const guard = await installGuardAllowingProbes(context, [PROBE_HOST, CROSS_SITE_PROBE_HOST]);
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${topProbe.url}/${tag}`, { waitUntil: "load", timeout: 20000 });
    // The top document sets its marker only after the iframe's load event, so this
    // read also says the frame loaded at all.
    const ready = await page.evaluate(() => window.__leakProbeReady);
    const frame = page.frames().find(
      (candidate) => candidate !== page.mainFrame() && String(candidate.url()).startsWith(`${frameProbe.url}/${frameTag}`),
    );
    if (ready !== tag || !frame) {
      return await giveUp(
        `the cross-site probe page did not load its iframe (marker ${JSON.stringify(ready)}, expected ` +
          `${JSON.stringify(tag)}; frames: ${JSON.stringify(page.frames().map((f) => f.url()))}) — the iframe from ` +
          `${frameProbe.url} has to load at all for its beacons to exist (the guard excepts ${PROBE_HOST} and ` +
          `${CROSS_SITE_PROBE_HOST} and nothing else)`,
      );
    }
    const frameReady = await frame
      .waitForFunction((want) => window.__frameProbeReady === want, frameTag, { timeout: 10000 })
      .then(() => true, (err) => err);
    if (frameReady !== true) {
      return await giveUp(
        `the cross-site iframe never reported its own marker (${frameReady && frameReady.message}): it did not run ` +
          "the probe document, so its pagehide handlers are not armed and a 0-hit result would measure nothing",
      );
    }
    // THE OOPIF PROOF. A session on a FRAME is only offered for an out-of-process
    // one; a same-process frame throws here, and then the page-level session this
    // case is about covers the frame anyway.
    let frameSession = null;
    try {
      frameSession = await context.newCDPSession(frame);
    } catch (err) {
      return await giveUp(
        `iframe not out-of-process on this Chromium (context.newCDPSession(frame) threw: ${err && err.message}) — ` +
          "with the frame in the page's own process the page-level session covers it, so this case could not tell " +
          "an OOPIF gap from a fixed one",
      );
    }
    try { await frameSession.detach(); } catch { /* the proof is all it was for */ }
    return { chrome, context, page, frame, frameTag, guard, close: () => chrome.close() };
  } catch (err) {
    await chrome.close();
    throw err;
  }
}

// EXPECTED RED until blankPagesOnExit attaches a deny-all session to every OOPIF
// frame as well: the frame's pagehide/unload beacons are not covered by the PAGE's
// session and reach the private server during the blank-and-close.
test("live: the exit cleanup leaks nothing from a CROSS-SITE iframe", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  // The frame's server first: the top document's HTML has to name its iframe.
  const frameProbe = await startProbeServerAt(t, CROSS_SITE_PROBE_HOST, (tag) => crossSiteFrameHtml(server.url, tag));
  if (frameProbe.error) {
    skipOrFail(t, frameProbe.error);
    return;
  }
  const topProbe = await startProbeServerAt(t, PROBE_HOST, (tag) =>
    crossSitePageHtml({ privateUrl: server.url, tag, frameSrc: `${frameProbe.url}/frame-${tag}` }),
  );
  if (topProbe.error) {
    skipOrFail(t, topProbe.error);
    return;
  }

  // THE CONTROL FIRST, in its own browser (one browser at a time): closing this
  // page naively has to put the IFRAME's beacons on the private server, or the 0
  // asserted after the cleanup would prove nothing — and a red assertion below
  // must not hide that the control was never checked.
  const control = await openCrossSiteProbe({ chromium: pw.chromium, topProbe, frameProbe, tag: "oopif-control" });
  if (control.error) {
    skipOrFail(t, control.error);
    return;
  }
  try {
    // A second page, so closing the probe page is not the browser's last page and
    // the close-time requests have a live browser to leave through.
    await control.context.newPage();
    const before = server.hits.length;
    await withTimeout(control.page.close(), 10000);
    await sleep(1500);
    const controlHits = server.hits.slice(before);
    const fromFrame = hitsFrom(controlHits, control.frameTag);
    assert.ok(
      fromFrame.length >= 1,
      "the control did not reproduce: closing a page that embeds a CROSS-SITE iframe naively sent nothing from " +
        `the iframe (0 hits tagged ${control.frameTag} after 1.5 s; every tag seen: ` +
        `${JSON.stringify(tagsOf(controlHits))}) — a 0 after the cleanup would then say nothing about the ` +
        "exit path, so this case cannot report anything",
    );
  } finally {
    await control.close();
  }

  // THE CLEANUP, in a fresh browser with the same probe page.
  const run = await openCrossSiteProbe({ chromium: pw.chromium, topProbe, frameProbe, tag: "oopif-exit" });
  if (run.error) {
    skipOrFail(t, run.error);
    return;
  }
  try {
    const before = server.hits.length;
    const proc = fakeProc();
    const cleanup = blankPagesOnExit(() => run.context, { proc });
    proc.stdin.emit("close");
    await cleanup();
    await sleep(1500);

    // A crashed browser runs no pagehide handlers, so 0 hits from it would be an
    // artefact of the crash rather than evidence about the frame's session.
    assert.ok(
      await devtoolsAnswers(run.chrome.port),
      "the cleanup crashed the browser instead of blanking and closing the page: a crash runs no pagehide " +
        "handlers, so its 0 hits would not be evidence about the cross-site iframe",
    );
    const settled = await waitUntil(async () => run.context.pages().length === 1, 5000);
    assert.ok(settled, `the cleanup finished with exactly one page left (still ${run.context.pages().length})`);

    const escaped = server.hits.slice(before);
    // The page-level layer first: if the TOP document leaked too, this case cannot
    // attribute anything to the frame.
    const fromTop = hitsFrom(escaped, "oopif-exit");
    assert.equal(
      fromTop.length,
      0,
      `the PAGE's own pagehide/unload requests escaped the cleanup (${JSON.stringify(tagsOf(fromTop))}) — the ` +
        "page-level deny-all session did not hold, so this case says nothing about the iframe (case 2 is that " +
        "check)",
    );
    const fromFrame = hitsFrom(escaped, run.frameTag);
    assert.equal(
      fromFrame.length,
      0,
      `the CROSS-SITE iframe leaked ${fromFrame.length} pagehide/unload request(s) to the private server ` +
        `(${JSON.stringify(tagsOf(fromFrame))}): blankPagesOnExit attaches its deny-all Fetch session to each ` +
        "PAGE's CDP session, and an out-of-process iframe lives in its own target with its own session, which " +
        "a page-level session does not cover — so the frame's unload beacons ride the blank and the close out. " +
        "A deny-all session has to be attached to every OOPIF frame too (context.newCDPSession(frame)), or the " +
        "exit contract only holds for a page without one",
    );
  } finally {
    await run.close();
  }
});

// ---------------------------------------------------------------------------
// case 8: the guard's page-world effects hold in a real page
// ---------------------------------------------------------------------------

// The guard's init script is installed as source text whose first line is
// `GUARD_MARKER`, but Playwright wraps that text before Chromium evaluates it and
// nothing in the product reads the marker back — so the marker is NOT readable
// from a page and this case does not claim it is. What a real browser can show is
// the script's EFFECT: `navigator.serviceWorker.register` refuses with the guard's
// message, and the WebRTC constructors throw. The control is the same page in a
// context with NO guard installed, so a refusal is attributable to the init script
// rather than to Chromium.

/** The two refusals the guard's page-world half produces. */
const SW_REFUSAL = "service workers are disabled in Crow's browser";
const RTC_REFUSAL = "WebRTC is disabled by Crow's private-address rule";

/**
 * Ask ONE real document what the page world did: did the service-worker
 * registration resolve or reject (and with what message), and did
 * `new RTCPeerConnection()` throw (and with what message)?
 *
 * `page.evaluate` runs in the page's MAIN world, so it sees the globals the guard's
 * init script replaced.
 */
async function pageWorldGuardEffects(page) {
  return page.evaluate(async () => {
    const effects = { registerResolved: false, registerMessage: null, rtcThrew: false, rtcMessage: null };
    try {
      await navigator.serviceWorker.register("/sw.js");
      effects.registerResolved = true;
    } catch (err) {
      effects.registerMessage = String((err && err.message) || err);
    }
    try {
      const pc = new RTCPeerConnection();
      try { pc.close(); } catch { /* nothing to close */ }
    } catch (err) {
      effects.rtcThrew = true;
      effects.rtcMessage = String((err && err.message) || err);
    }
    return effects;
  });
}

/**
 * One browser (this case's own), one probe page from the probe server, and the
 * page-world effects that document reports. `guarded: false` is the control: the
 * same page with no init script installed at all.
 *
 * @returns {Promise<{error: string} | {effects: object}>}
 */
async function pageWorldEffectsRun({ chromium, probe, privateUrl, tag, guarded }) {
  const chrome = await launchBrowser({ chromium });
  if (chrome.error) return { error: chrome.error };
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    if (guarded) await installGuardAllowingProbe(context);
    const page = context.pages()[0] || await context.newPage();
    await loadLeakPage(page, { probe, privateUrl, tag });
    return { effects: await pageWorldGuardEffects(page) };
  } finally {
    await chrome.close();
  }
}

test("live: the guard's page-world effects hold in a real page", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }

  // THE CONTROL FIRST, with NO guard installed: the same page must not report the
  // guard's refusals, or the guarded run's refusal would say nothing about the
  // init script (it could be Chromium refusing in both runs).
  const control = await pageWorldEffectsRun({
    chromium: pw.chromium,
    probe,
    privateUrl: server.url,
    tag: "guard-effects-control",
    guarded: false,
  });
  if (control.error) {
    skipOrFail(t, control.error);
    return;
  }
  const unguarded = control.effects;
  t.diagnostic(
    `unguarded page: register ${
      unguarded.registerResolved ? "resolved" : `rejected (${unguarded.registerMessage})`
    }; new RTCPeerConnection() ${unguarded.rtcThrew ? `threw (${unguarded.rtcMessage})` : "did not throw"}`,
  );
  assert.ok(
    !String(unguarded.registerMessage || "").includes(SW_REFUSAL),
    "the control is broken, not the guard: an UNGUARDED page's navigator.serviceWorker.register() rejected " +
      `with the guard's own message (${unguarded.registerMessage}) — then a refusal in the guarded run could not ` +
      "be attributed to the init script",
  );
  assert.ok(
    !String(unguarded.rtcMessage || "").includes(RTC_REFUSAL),
    "the control is broken, not the guard: new RTCPeerConnection() in an UNGUARDED page threw the guard's own " +
      `refusal (${unguarded.rtcMessage})`,
  );

  // The guarded run: the guard installed BEFORE the document is loaded, so its
  // init script is the one this document runs.
  const guarded = await pageWorldEffectsRun({
    chromium: pw.chromium,
    probe,
    privateUrl: server.url,
    tag: "guard-effects-guarded",
    guarded: true,
  });
  if (guarded.error) {
    skipOrFail(t, guarded.error);
    return;
  }
  const effects = guarded.effects;
  assert.equal(
    effects.registerResolved,
    false,
    "the guard's init script did not refuse navigator.serviceWorker.register() in a real page: it resolved, so " +
      "the page-world half of the guard did not run in this document",
  );
  assert.ok(
    String(effects.registerMessage || "").includes(SW_REFUSAL),
    "the guarded page's navigator.serviceWorker.register() rejected, but not with the guard's refusal " +
      `(message: ${effects.registerMessage}) — the init script's replacement did not run in this document ` +
      "(GUARD_MARKER is not readable from a page: this effect is what a live test can check)",
  );
  assert.ok(
    effects.rtcThrew,
    "new RTCPeerConnection() did not throw in a guarded page — the init script's WebRTC replacement did not " +
      "reach this document's page world",
  );
  t.diagnostic(
    `guarded page: register rejected (${effects.registerMessage}); new RTCPeerConnection() threw ` +
      `(${effects.rtcMessage})`,
  );
});

// ---------------------------------------------------------------------------
// page ownership: the exit cleanup cleans up the BOT's tabs, never the operator's
//
// The cleanup above blanks and closes every page in the context — the operator's
// own VNC tabs included. The rule now is that it cleans up only the pages this MCP
// opened or drove (`page-ownership.js`), and that the operator's tabs are never
// navigated, closed, or even given a CDP session. The unit half is
// tests/browser-page-ownership.test.js; what only a real Chromium can say is here:
// a surviving tab keeps its url and its HISTORY, a tab another CDP client drives
// (lane A) is left alone, a mid-session tab nobody can claim is left alone and
// reported, and the cleanup still comes in well under its budget with 25 tabs open.
// ---------------------------------------------------------------------------

/**
 * The common opening of a page-ownership case: the two servers, this case's own
 * browser, the guard — and, unless the case is a legacy control, the ownership
 * attached to the context right after the guard (the order the MCP server uses).
 *
 * `options.operatorTabs(context, { server, probe })` runs BETWEEN the guard and
 * `attachContext`: a tab that stands for one the operator already had open has to
 * exist (created, navigated, loaded) BEFORE the ownership attaches, because a tab
 * that appears afterwards with no opener is — correctly — `uncertain`. Whatever
 * it returns comes back as `operatorTabs` on the result.
 *
 * `options.ownershipOptions` is handed to `createPageOwnership()` as it is (nothing
 * by default, so the product's own defaults apply). A case that wants an INDEPENDENT
 * tab to be `uncertain` after a bot action (another CDP client's `Target.createTarget`)
 * passes `{ botActionWindowMs: 300 }` here and waits past that window before making
 * the tab: an independent tab that arrives within `botActionWindowMs` of a bot action
 * is the bot's now, by contract (a ctrl-clicked or middle-clicked tab has that shape).
 */
async function openOwnershipRun(t, pw, options = {}) {
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) return { error: probe.error };
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) return { error: chrome.error };
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    await installGuardAllowingProbe(context);
    const operatorTabs = typeof options.operatorTabs === "function"
      ? await options.operatorTabs(context, { server, probe })
      : null;
    let ownership = null;
    if (options.withOwnership !== false) {
      ownership = createPageOwnership(options.ownershipOptions);
      await ownership.attachContext(context);
    }
    return { server, probe, chrome, context, ownership, operatorTabs, close: () => chrome.close() };
  } catch (err) {
    await chrome.close();
    throw err;
  }
}

/** The exit cleanup through its seam: a fake proc, its stdin close, awaited. */
async function runExitCleanup(context, options = {}) {
  const proc = fakeProc();
  const settings = { proc };
  if (Number.isFinite(options.budgetMs)) settings.budgetMs = options.budgetMs;
  if (options.ownership) settings.ownership = options.ownership;
  const run = blankPagesOnExit(() => context, settings);
  proc.stdin.emit("close");
  await run();
}

/** Collect every console.error line written while `work` runs. */
async function withConsoleErrorLines(work) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };
  try {
    await work();
  } finally {
    console.error = original;
  }
  return lines;
}

/** Node 24's global WebSocket, else the `ws` package; null when neither exists. */
async function loadWebSocketCtor() {
  if (typeof globalThis.WebSocket === "function") return { Ctor: globalThis.WebSocket, from: "Node's global WebSocket" };
  try {
    const mod = await import("ws");
    if (mod && mod.default) return { Ctor: mod.default, from: "the ws package" };
  } catch { /* not installed */ }
  return { Ctor: null, from: "" };
}

/**
 * One raw BROWSER-level CDP websocket: a SECOND DevTools client on this browser,
 * in the style of a lane's own tooling (`Target.createTarget`, then
 * `Target.attachToTarget { flatten: true }` for a session on that tab).
 *
 * @returns {Promise<{error: string} | {from: string, send: Function, close: Function}>}
 */
async function openRawBrowserCdp(port) {
  const wsModule = await loadWebSocketCtor();
  if (!wsModule.Ctor) {
    return { error: "no WebSocket implementation: Node's global WebSocket and the ws package are both unavailable" };
  }
  let version = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    version = await res.json();
  } catch (err) {
    return { error: `GET /json/version on port ${port} failed: ${err && err.message}` };
  }
  const url = version && version.webSocketDebuggerUrl;
  if (!url) return { error: "the DevTools endpoint offered no webSocketDebuggerUrl" };

  const ws = new wsModule.Ctor(url);
  const opened = await new Promise((resolve) => {
    const finish = (ok, why) => resolve(ok ? { ok: true } : { ok: false, why });
    const timer = setTimeout(() => finish(false, "the websocket never opened"), 8000);
    if (typeof timer.unref === "function") timer.unref();
    const onOpen = () => { clearTimeout(timer); finish(true); };
    const onError = (event) => {
      clearTimeout(timer);
      finish(false, `the websocket failed: ${(event && (event.message || event.type)) || "unknown"}`);
    };
    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    } else {
      ws.once("open", onOpen);
      ws.once("error", onError);
    }
  });
  if (!opened.ok) {
    try { ws.close(); } catch { /* it never opened */ }
    return { error: `${opened.why} (${url})` };
  }

  let nextId = 0;
  const waiting = new Map();
  const handle = (data) => {
    let text = data;
    if (typeof text !== "string") {
      try { text = Buffer.from(text).toString("utf8"); } catch { return; }
    }
    let message = null;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message.id !== "number") return;
    const waiter = waiting.get(message.id);
    if (!waiter) return;
    waiting.delete(message.id);
    if (message.error) waiter.reject(new Error(String(message.error.message || JSON.stringify(message.error))));
    else waiter.resolve(message.result || {});
  };
  if (typeof ws.addEventListener === "function") ws.addEventListener("message", (event) => handle(event.data));
  else ws.on("message", (data) => handle(String(data)));

  const send = (method, params = {}, sessionId = null) => new Promise((resolve, reject) => {
    nextId += 1;
    const id = nextId;
    waiting.set(id, { resolve, reject });
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const timer = setTimeout(() => {
      if (waiting.delete(id)) reject(new Error(`CDP ${method} never answered`));
    }, 10000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      clearTimeout(timer);
      waiting.delete(id);
      reject(err);
    }
  });

  return { from: wsModule.from, send, close: () => { try { ws.close(); } catch { /* already gone */ } } };
}

// L1: the operator's own tab survives — url, history and all — and the control
// (the same shape with no ownership) shows the legacy cleanup does close it.
test("live: page ownership — the operator's tab survives the exit cleanup, with its history", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }

  // THE OWNERSHIP RUN. The operator's tab is made, navigated and loaded BEFORE the
  // ownership attaches: it stands for a tab that was already open, and a tab made
  // afterwards with no opener would be `uncertain` by contract.
  const owned = await openOwnershipRun(t, pw, {
    operatorTabs: async (context, { server, probe }) => {
      const operatorPage = context.pages()[0] || await context.newPage();
      // The operator's own browsing, two pages deep: this tab has a history.
      await loadLeakPage(operatorPage, { probe, privateUrl: server.url, tag: "op-1" });
      await loadLeakPage(operatorPage, { probe, privateUrl: server.url, tag: "op-2" });
      return { operatorPage };
    },
  });
  if (owned.error) {
    skipOrFail(t, owned.error);
    return;
  }
  try {
    const { server, probe, context, ownership, operatorTabs } = owned;
    const operatorPage = operatorTabs.operatorPage;
    const botPage = await ownership.newPage(context);
    await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "bot-1" });
    assert.equal(ownership.classify(operatorPage), "operator", "the tab that was already open is the operator's");
    assert.equal(ownership.classify(botPage), "bot", "a tab the MCP opened through ownership.newPage is the bot's");

    // The TEST ITSELF navigated this tab from op-1 to op-2, and THAT navigation
    // fires op-1's pagehide/unload (the guard's routes do not stop a teardown
    // request — that is the leak the cleanup's deny-all session exists for). So the
    // baseline is taken once those navigations have settled, and the cleanup is
    // asserted to add NO NEW hits to it.
    await sleep(300);
    const baseline = { "op-1": hitsFrom(server.hits, "op-1").length, "op-2": hitsFrom(server.hits, "op-2").length };
    const lines = await withConsoleErrorLines(async () => {
      await runExitCleanup(context, { ownership });
      await sleep(1500);
    });

    assert.equal(hitsFrom(server.hits, "bot-1").length, 0, "the bot's tab leaked nothing while it was blanked and closed");
    assert.equal(
      hitsFrom(server.hits, "op-1").length,
      baseline["op-1"],
      "no NEW hits since the baseline for op-1: the operator's tab was never blanked, so its pagehide did not fire " +
        `again (baseline ${baseline["op-1"]}, now ${hitsFrom(server.hits, "op-1").length}; ` +
        `hits: ${JSON.stringify(tagsOf(server.hits))})`,
    );
    assert.equal(
      hitsFrom(server.hits, "op-2").length,
      baseline["op-2"],
      "no NEW hits since the baseline for op-2 either: nor did the page it was showing " +
        `(baseline ${baseline["op-2"]}, now ${hitsFrom(server.hits, "op-2").length})`,
    );
    assert.deepEqual(
      lines.filter((line) => /uncertain/i.test(line)),
      [],
      "the cleanup logged no \"uncertain\" line: every tab in this run is provably the operator's or the bot's " +
        `(lines: ${JSON.stringify(lines)})`,
    );

    assert.ok(botPage.isClosed(), "the bot's tab is gone");
    assert.equal(operatorPage.isClosed(), false, "the operator's tab is still open");
    assert.equal(operatorPage.url(), `${probe.url}/op-2`, "…on the page the operator was looking at");
    const pages = context.pages();
    assert.equal(pages.length, 1, `exactly one tab is left — the operator's, with no fresh survivor (got ${pages.length})`);
    assert.equal(pages[0], operatorPage, "and it is the operator's own tab, not a replacement for it");

    // Its HISTORY is intact: Back lands on the page before.
    const back = await withTimeout(operatorPage.goBack({ timeout: 5000 }), 8000);
    assert.ok(!back || back.timedOut !== true, "the operator's tab can still walk its own history");
    assert.equal(
      operatorPage.url(),
      `${probe.url}/op-1`,
      `a Back press on the operator's tab lands on the page before (it is on ${operatorPage.url()})`,
    );
  } finally {
    await owned.close();
  }

  // THE CONTROL, in its own browser (one at a time): the SAME shape with no
  // ownership. The operator's tab is blanked and closed and the only page left is
  // the fresh survivor — which is what makes the survival above attributable to
  // the ownership rather than to a cleanup that did nothing.
  const control = await openOwnershipRun(t, pw, { withOwnership: false });
  if (control.error) {
    skipOrFail(t, control.error);
    return;
  }
  try {
    const { server, probe, context } = control;
    const operatorPage = context.pages()[0] || await context.newPage();
    await loadLeakPage(operatorPage, { probe, privateUrl: server.url, tag: "legacy-op-1" });
    await loadLeakPage(operatorPage, { probe, privateUrl: server.url, tag: "legacy-op-2" });
    const botPage = await context.newPage();
    await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "legacy-bot-1" });

    await runExitCleanup(context);
    await sleep(1500);

    assert.ok(
      operatorPage.isClosed(),
      "CONTROL: without the ownership the same cleanup blanks and closes the operator's tab — so the survival " +
        "asserted above is the ownership's doing",
    );
    const left = context.pages();
    assert.equal(left.length, 1, `CONTROL: exactly one page is left (got ${left.length})`);
    assert.notEqual(left[0], operatorPage, "CONTROL: it is not the operator's tab");
    assert.notEqual(left[0], botPage, "CONTROL: nor the bot's");
    assert.equal(left[0].url(), "about:blank", "CONTROL: it is the fresh survivor the legacy cleanup creates");
  } finally {
    await control.close();
  }
});

// L2: a tab the BOT DROVE is the bot's, even though the operator opened it — blanked,
// then closed (never reused), while the operator's other tab next to it survives.
test("live: page ownership — a touched operator tab is cleaned up while its untouched sibling survives", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }

  // THE SIBLING RUN: one operator tab the bot drives, one it does not, plus the
  // bot's own tab. BOTH operator tabs are made, navigated and loaded BEFORE the
  // ownership attaches: they stand for tabs that were already open, and the one
  // this case does not touch has to be provably the operator's.
  const owned = await openOwnershipRun(t, pw, {
    operatorTabs: async (context, { server, probe }) => {
      const touched = context.pages()[0] || await context.newPage();
      await loadLeakPage(touched, { probe, privateUrl: server.url, tag: "touched-1" });
      await loadLeakPage(touched, { probe, privateUrl: server.url, tag: "touched-2" });
      const sibling = await context.newPage();
      await loadLeakPage(sibling, { probe, privateUrl: server.url, tag: "sibling-1" });
      return { touched, sibling };
    },
  });
  if (owned.error) {
    skipOrFail(t, owned.error);
    return;
  }
  try {
    const { server, probe, context, ownership, operatorTabs } = owned;
    const { touched, sibling } = operatorTabs;
    assert.equal(ownership.classify(touched), "operator", "a tab that existed before the ownership attached is the operator's");
    assert.equal(ownership.classify(sibling), "operator", "…and so is its untouched sibling");
    const botPage = await ownership.newPage(context);
    await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "bot-touched" });

    ownership.markTouched(touched);
    await ownership.settle();
    assert.equal(ownership.classify(touched), "bot", "the operator's tab the bot drove is the bot's now");
    assert.equal(ownership.classify(sibling), "operator", "the operator's other tab is untouched");

    // The TEST ITSELF navigated the touched tab from touched-1 to touched-2, and THAT
    // navigation fires touched-1's pagehide/unload (the guard's routes do not stop a
    // teardown request — that is the leak the cleanup's deny-all session exists for).
    // So the baseline is taken once those navigations have settled, and the cleanup is
    // asserted to add NO NEW hits to it: for touched-1/touched-2, the tab the cleanup
    // blanks and closes, that is the assertion that its own blank/close leaked nothing.
    await sleep(300);
    const baseline = {
      "touched-1": hitsFrom(server.hits, "touched-1").length,
      "touched-2": hitsFrom(server.hits, "touched-2").length,
      "sibling-1": hitsFrom(server.hits, "sibling-1").length,
    };
    await runExitCleanup(context, { ownership });
    await sleep(1500);

    assert.ok(touched.isClosed(), "the touched tab is closed (a blank alone keeps its history entries)");
    assert.equal(
      hitsFrom(server.hits, "touched-1").length,
      baseline["touched-1"],
      "no NEW hits since the baseline for touched-1: the touched tab's blank and close leaked nothing " +
        `(baseline ${baseline["touched-1"]}, now ${hitsFrom(server.hits, "touched-1").length}; ` +
        `hits: ${JSON.stringify(tagsOf(server.hits))})`,
    );
    assert.equal(
      hitsFrom(server.hits, "touched-2").length,
      baseline["touched-2"],
      "no NEW hits since the baseline for touched-2 either: the page the touched tab was showing did not leak " +
        `as it was blanked (baseline ${baseline["touched-2"]}, now ${hitsFrom(server.hits, "touched-2").length})`,
    );
    assert.equal(hitsFrom(server.hits, "bot-touched").length, 0, "the bot's own tab leaked nothing either");
    assert.equal(sibling.isClosed(), false, "CONTROL: the operator's untouched tab survives");
    assert.equal(sibling.url(), `${probe.url}/sibling-1`, "…on its own page");
    assert.equal(
      hitsFrom(server.hits, "sibling-1").length,
      baseline["sibling-1"],
      "no NEW hits since the baseline for sibling-1: the surviving tab was never blanked, so its pagehide did not " +
        `fire (baseline ${baseline["sibling-1"]}, now ${hitsFrom(server.hits, "sibling-1").length})`,
    );
    const left = context.pages();
    assert.equal(left.length, 1, `only the operator's surviving tab is left, no survivor next to it (got ${left.length})`);
    assert.equal(left[0], sibling);
  } finally {
    await owned.close();
  }

  // THE SURVIVOR RUN, its own browser: with no operator tab left behind the cleanup
  // has to leave a FRESH one, and a Back press on it must stay on about:blank (the
  // touched tab's history went away with the close, it is never reused).
  const solo = await openOwnershipRun(t, pw, {
    // Same order as the sibling run: the operator's tab exists before the ownership.
    operatorTabs: async (context, { server, probe }) => {
      const touched = context.pages()[0] || await context.newPage();
      await loadLeakPage(touched, { probe, privateUrl: server.url, tag: "solo-1" });
      await loadLeakPage(touched, { probe, privateUrl: server.url, tag: "solo-2" });
      return { touched };
    },
  });
  if (solo.error) {
    skipOrFail(t, solo.error);
    return;
  }
  try {
    const { server, probe, context, ownership, operatorTabs } = solo;
    const { touched } = operatorTabs;
    const botPage = await ownership.newPage(context);
    await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "bot-solo" });
    ownership.markTouched(touched);
    await ownership.settle();

    // Same baseline rule as the sibling run: the TEST navigated this tab from solo-1 to
    // solo-2, and that navigation fires solo-1's pagehide. The baseline is taken after
    // it settles; the cleanup must add NO NEW hits to it.
    await sleep(300);
    const baseline = { "solo-1": hitsFrom(server.hits, "solo-1").length, "solo-2": hitsFrom(server.hits, "solo-2").length };
    await runExitCleanup(context, { ownership });
    await sleep(1500);

    assert.equal(
      hitsFrom(server.hits, "solo-1").length,
      baseline["solo-1"],
      "no NEW hits since the baseline for solo-1: the touched tab's blank and close leaked nothing " +
        `(baseline ${baseline["solo-1"]}, now ${hitsFrom(server.hits, "solo-1").length}; ` +
        `hits: ${JSON.stringify(tagsOf(server.hits))})`,
    );
    assert.equal(
      hitsFrom(server.hits, "solo-2").length,
      baseline["solo-2"],
      "no NEW hits since the baseline for solo-2 either: the page it was showing did not leak " +
        `(baseline ${baseline["solo-2"]}, now ${hitsFrom(server.hits, "solo-2").length})`,
    );
    assert.equal(hitsFrom(server.hits, "bot-solo").length, 0, "and the bot's tab leaked nothing");
    const left = context.pages();
    assert.equal(left.length, 1, `a fresh survivor is left behind (got ${left.length} pages)`);
    assert.notEqual(left[0], touched, "it is NOT the touched tab (that one was closed, history and all)");
    assert.equal(left[0].url(), "about:blank", "it is a fresh about:blank survivor");
    const back = await withTimeout(left[0].goBack({ timeout: 3000 }), 8000);
    assert.ok(!back || back.timedOut !== true, "goBack on the survivor does not hang");
    assert.equal(left[0].url(), "about:blank", `the fresh survivor has no history to walk back into (it is on ${left[0].url()})`);
  } finally {
    await solo.close();
  }
});

// L3: many operator tabs: the cleanup walks the bot's pages, not every tab, and the
// browser stays healthy.
test("live: page ownership — 25 operator tabs and one bot tab: fast, and every operator tab is left alone", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  // All 25 operator tabs exist, are navigated and are loaded BEFORE the ownership
  // attaches: tabs made afterwards with no opener are `uncertain`, not operator's.
  const owned = await openOwnershipRun(t, pw, {
    operatorTabs: async (context, { server, probe }) => {
      const operatorPages = [];
      operatorPages.push(context.pages()[0] || await context.newPage());
      while (operatorPages.length < 25) operatorPages.push(await context.newPage());
      await Promise.all(
        operatorPages.map((page, index) => loadLeakPage(page, { probe, privateUrl: server.url, tag: `op-many-${index + 1}` })),
      );
      return { operatorPages };
    },
  });
  if (owned.error) {
    skipOrFail(t, owned.error);
    return;
  }
  try {
    const { server, probe, context, ownership, chrome, operatorTabs } = owned;
    const operatorPages = operatorTabs.operatorPages;
    for (const [index, page] of operatorPages.entries()) {
      assert.equal(
        ownership.classify(page),
        "operator",
        `operator tab op-many-${index + 1} was open before the ownership attached, so it is the operator's`,
      );
    }
    const botPage = await ownership.newPage(context);
    await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "bot-many" });

    const started = Date.now();
    const lines = await withConsoleErrorLines(() => runExitCleanup(context, { ownership }));
    const elapsed = Date.now() - started;
    await sleep(1200);

    assert.deepEqual(
      lines.filter((line) => /uncertain/i.test(line)),
      [],
      "the cleanup logged no \"uncertain\" line: all 25 operator tabs were open before the ownership attached " +
        `(lines: ${JSON.stringify(lines)})`,
    );

    assert.ok(elapsed < 1500, `the cleanup has to walk the bot's pages, not 26 tabs (took ${elapsed} ms)`);
    assert.ok(await devtoolsAnswers(chrome.port), "Chromium still answers after the cleanup");
    assert.equal(hitsFrom(server.hits, "bot-many").length, 0, "the bot's tab leaked nothing");
    assert.ok(botPage.isClosed(), "the bot's tab is gone");
    assert.equal(context.pages().length, 25, `all 25 operator tabs are still open (got ${context.pages().length})`);
    for (const [index, page] of operatorPages.entries()) {
      const tag = `op-many-${index + 1}`;
      assert.equal(page.isClosed(), false, `operator tab ${tag} is still open`);
      assert.equal(page.url(), `${probe.url}/${tag}`, `operator tab ${tag} keeps its url`);
      assert.equal(hitsFrom(server.hits, `op-many-${index + 1}`).length, 0, `operator tab ${tag} was never navigated away`);
    }
  } finally {
    await owned.close();
  }
});

// L4: a tab ANOTHER CDP client created mid-session is nobody provable — it is left
// alone and reported once — while a bot page's own popups (noopener included) are
// the bot's and are cleaned up.
test("live: page ownership — an uncertain tab is left alone; a bot page's popups are the bot's", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  // The bot-action window is 300 ms in this case, so the wait below steps over it: an
  // independent tab that arrives INSIDE that window is the bot's now (a ctrl-clicked or
  // middle-clicked tab has the very same shape), so the tab that has to be `uncertain`
  // must be made after the window has expired, counted from the last bot action above it.
  const owned = await openOwnershipRun(t, pw, { ownershipOptions: { botActionWindowMs: 300 } });
  if (owned.error) {
    skipOrFail(t, owned.error);
    return;
  }
  try {
    const { server, probe, context, ownership, chrome } = owned;
    const botPage = await ownership.newPage(context);
    await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "bot-parent" });

    // Past the 300 ms window, counted from the `ownership.newPage` above (the last bot
    // action before this point): the tab made next lands outside it, so it is nobody
    // provable rather than the bot's.
    await sleep(600);

    // ANOTHER DevTools client (lane A's kind) creates a tab mid-session: no opener,
    // not created through ownership.newPage, so nothing proves whose it is.
    const raw = await openRawBrowserCdp(chrome.port);
    if (raw.error) {
      skipOrFail(t, raw.error);
      return;
    }
    try {
      const created = await raw.send("Target.createTarget", { url: `${probe.url}/other` });
      let otherPage = null;
      const appeared = await waitUntil(async () => {
        otherPage = context.pages().find((page) => String(page.url()).endsWith("/other")) || null;
        return Boolean(otherPage);
      }, 10000);
      assert.ok(
        appeared,
        `the tab the other CDP client created appeared in this context (target ${created && created.targetId}; ` +
          `pages: ${context.pages().map((page) => page.url()).join(", ")})`,
      );
      const becameUncertain = await waitUntil(() => ownership.classify(otherPage) === "uncertain", 8000);
      assert.ok(
        becameUncertain,
        `a tab another CDP client created mid-session is "uncertain" (classified ${ownership.classify(otherPage)})`,
      );

      // CONTROL: a popup of a BOT page is the bot's — with and without `noopener`.
      await botPage.evaluate((urls) => {
        window.open(urls[0], "_blank");
        window.open(urls[1], "_blank", "noopener");
      }, [`${probe.url}/bot-popup`, `${probe.url}/bot-popup-noopener`]);
      const sawBoth = await waitUntil(() => {
        const urls = context.pages().map((page) => String(page.url()));
        return urls.some((url) => url.endsWith("/bot-popup")) && urls.some((url) => url.endsWith("/bot-popup-noopener"));
      }, 10000);
      assert.ok(
        sawBoth,
        `both popups opened (pages: ${context.pages().map((page) => page.url()).join(", ")})`,
      );
      await ownership.settle();
      const plainPopup = context.pages().find((page) => String(page.url()).endsWith("/bot-popup"));
      const noopenerPopup = context.pages().find((page) => String(page.url()).endsWith("/bot-popup-noopener"));
      assert.equal(ownership.classify(plainPopup), "bot", "window.open from a bot page is the bot's tab");
      assert.equal(
        ownership.classify(noopenerPopup),
        "bot",
        "a `noopener` popup of a bot page is the bot's too: the bot's page opened it, whatever opener the page world sees",
      );

      const lines = await withConsoleErrorLines(async () => {
        await runExitCleanup(context, { ownership });
        await sleep(1500);
      });

      assert.equal(otherPage.isClosed(), false, "the uncertain tab is left open");
      assert.ok(String(otherPage.url()).endsWith("/other"), `…on the page the other client put it on (${otherPage.url()})`);
      assert.equal(
        hitsFrom(server.hits, "other").length,
        0,
        `the uncertain tab was never navigated: its pagehide never fired (hits: ${JSON.stringify(tagsOf(server.hits))})`,
      );
      assert.equal(ownership.classify(otherPage), "uncertain", "and it is still nobody provable after the cleanup");
      assert.ok(plainPopup.isClosed(), "the bot page's window.open popup is closed");
      assert.ok(noopenerPopup.isClosed(), "…and so is its noopener popup");
      assert.ok(botPage.isClosed(), "…and the bot page that opened them");
      assert.equal(hitsFrom(server.hits, "bot-popup").length, 0, "the popups leaked nothing on the way out");
      assert.equal(hitsFrom(server.hits, "bot-popup-noopener").length, 0, "the noopener one included");
      assert.equal(hitsFrom(server.hits, "bot-parent").length, 0, "nor did the bot page");
      const mentioning = lines.filter((line) => /uncertain/i.test(line));
      assert.equal(
        mentioning.length,
        1,
        `exactly one console.error line names the uncertain tab (lines: ${JSON.stringify(lines)})`,
      );
    } finally {
      raw.close();
    }
  } finally {
    await owned.close();
  }
});

// L5: lane A's own tab, made and driven over a raw CDP session that stays OPEN
// through the cleanup, is the operator's (lane A's) and is left exactly as it is.
test("live: page ownership — lane A's CDP tab, open before the ownership attached, survives", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");

    // LANE A FIRST: its own browser-level websocket makes its own tab, drives it
    // with `Page.navigate`, and keeps the session OPEN — the tab is somebody
    // else's work in progress, not this MCP's.
    const raw = await openRawBrowserCdp(chrome.port);
    if (raw.error) {
      skipOrFail(t, raw.error);
      return;
    }
    try {
      const created = await raw.send("Target.createTarget", { url: "about:blank" });
      const targetId = created && created.targetId;
      assert.ok(targetId, "the raw CDP client created a target of its own");
      const attached = await raw.send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = attached && attached.sessionId;
      assert.ok(sessionId, "…and attached to it (flattened)");
      await raw.send("Page.enable", {}, sessionId);
      await raw.send("Page.navigate", { url: `${probe.url}/lane-a` }, sessionId);
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        const answer = await raw
          .send("Runtime.evaluate", { expression: "window.__leakProbeReady || ''", returnByValue: true }, sessionId)
          .catch(() => null);
        ready = Boolean(answer && answer.result && answer.result.value === "lane-a");
        if (!ready) await sleep(100);
      }
      assert.ok(ready, "lane A's tab loaded the probe page over its own CDP session");

      // NOW the MCP side: the guard, then the ownership, which therefore sees
      // lane A's tab as a page that was already there.
      await installGuardAllowingProbe(context);
      const ownership = createPageOwnership();
      await ownership.attachContext(context);
      const laneAPage = context.pages().find((page) => String(page.url()).endsWith("/lane-a"));
      assert.ok(
        laneAPage,
        `this context has a Page for lane A's tab (pages: ${context.pages().map((page) => page.url()).join(", ")})`,
      );
      await ownership.settle();
      assert.equal(
        ownership.classify(laneAPage),
        "operator",
        "a tab that existed before the ownership attached is the operator's, whoever drives it",
      );

      const botPage = await ownership.newPage(context);
      await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "bot-lane-a" });

      // The raw session is still open while the cleanup runs.
      await runExitCleanup(context, { ownership });
      await sleep(1500);

      assert.ok(botPage.isClosed(), "the bot's own tab is cleaned up");
      assert.equal(hitsFrom(server.hits, "bot-lane-a").length, 0, "…leaking nothing");
      assert.equal(laneAPage.isClosed(), false, "lane A's tab is still open");
      assert.ok(String(laneAPage.url()).endsWith("/lane-a"), `…on its own page (${laneAPage.url()})`);
      assert.equal(
        hitsFrom(server.hits, "lane-a").length,
        0,
        `it was never navigated away: its pagehide never fired (hits: ${JSON.stringify(tagsOf(server.hits))})`,
      );
      assert.equal(ownership.classify(laneAPage), "operator", "and it is still lane A's tab after the cleanup");
      assert.ok(context.pages().some((page) => page === laneAPage), "the tab is still in the context");
    } finally {
      raw.close();
    }
  } finally {
    await chrome.close();
  }
});

// L6: the fail-open case of a popup whose opener closes first. A bot page opens a
// popup and then closes ITSELF, so the popup's `opener()` has nothing to report and
// the tab has to be recognised from the bot page's own synchronous `popup` listener
// (or the CDP `openerId`), not from a lookup that no longer has an opener to read.
// It is the bot's, so the cleanup blanks and closes it: nothing the bot opened may
// be left running unguarded after the exit. The operator's tab beside it, and an
// independent tab another CDP client made mid-session, stay exactly as they are.
test("live: page ownership — a bot page that opens a popup and closes itself leaves nothing running", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }

  // Guard + ownership as in L4, with the operator's tab made BEFORE the ownership
  // attaches: a tab made afterwards with no opener is `uncertain`, not the operator's.
  const owned = await openOwnershipRun(t, pw, {
    // The bot-action window is 300 ms in this case too (see the wait before the other
    // CDP client's tab below): an independent tab inside it would be the bot's.
    ownershipOptions: { botActionWindowMs: 300 },
    operatorTabs: async (context, { server, probe }) => {
      const operatorPage = context.pages()[0] || await context.newPage();
      await loadLeakPage(operatorPage, { probe, privateUrl: server.url, tag: "self-op-1" });
      return { operatorPage };
    },
  });
  if (owned.error) {
    skipOrFail(t, owned.error);
    return;
  }

  let raw = null;
  try {
    const { server, probe, context, ownership, chrome, operatorTabs } = owned;
    const { operatorPage } = operatorTabs;

    // No bot action has happened yet (`ownership.newPage` below is the first), so the
    // window claims nothing here; the wait keeps the CONTROL tab outside it all the
    // same, so it is never the 300 ms window that leaves this tab `uncertain`.
    await sleep(600);

    // THE CONTROL TAB: another DevTools client (lane A's kind) creates it mid-session,
    // so it has no opener at all and nobody can prove it is the bot's.
    raw = await openRawBrowserCdp(chrome.port);
    if (raw.error) {
      skipOrFail(t, raw.error);
      return;
    }
    await raw.send("Target.createTarget", { url: `${probe.url}/other-self` });

    // THE CONTROL TAB HAS TO BE CLASSIFIED BEFORE ANY BOT ACTION. `Target.createTarget`
    // only says Chromium accepted it: the context's own "page" event can still be in
    // flight, and a tab whose arrival is snapshotted INSIDE the 300 ms bot-action window
    // is the bot's by contract. So wait for the tab and for its arrival-time class to
    // land as `uncertain`, and only THEN make the first bot action (`newPage` below).
    let otherPage = null;
    const otherAppeared = await waitUntil(() => {
      otherPage = context.pages().find((page) => String(page.url()).endsWith("/other-self")) || null;
      return Boolean(otherPage) && ownership.classify(otherPage) === "uncertain";
    }, 10000);
    assert.ok(
      otherAppeared,
      `a tab another CDP client created mid-session is "uncertain" BEFORE any bot action (pages: ` +
        `${context.pages().map((page) => page.url()).join(", ")}; it classified ` +
        `${otherPage ? ownership.classify(otherPage) : "not in this context"})`,
    );

    const botPage = await ownership.newPage(context);
    await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "bot-self" });

    // The bot page opens its own popup and then closes ITSELF: the opener tab is gone
    // before anything can look the popup's owner up.
    const popupUrl = `${probe.url}/popup-self`;
    await botPage
      .evaluate((url) => {
        window.open(url, "_blank");
        try {
          window.close();
        } catch {
          /* refused by Chromium: the test closes the page below */
        }
      }, popupUrl)
      .catch(() => {});

    let popupPage = null;
    const appeared = await waitUntil(() => {
      popupPage = context.pages().find((page) => page !== botPage && String(page.url()).endsWith("/popup-self")) || null;
      return Boolean(popupPage);
    }, 15000);
    assert.ok(appeared, `the popup appeared (pages: ${context.pages().map((page) => page.url()).join(", ")})`);

    // Chromium refuses `window.close()` for a tab it does not consider script-opened,
    // so close the opener from here instead — still BEFORE anything classifies the popup.
    if (!botPage.isClosed()) await withTimeout(botPage.close(), 8000);
    assert.ok(botPage.isClosed(), "the opener tab is closed first — that is the whole case");

    // The popup's own probe page: its pagehide/unload beacons are the hit this case counts.
    const probeReady = async () => {
      try {
        return (await popupPage.evaluate(() => window.__leakProbeReady)) === "popup-self";
      } catch {
        return false;
      }
    };
    let ready = await waitUntil(probeReady, 10000);
    if (!ready) {
      // The first navigation may have been cut short when the opener went away. One
      // navigation, BEFORE the baseline, so the probe's handlers are installed.
      await withTimeout(popupPage.goto(popupUrl, { waitUntil: "load", timeout: 15000 }), 20000);
      ready = await waitUntil(probeReady, 10000);
    }
    assert.ok(ready, `the popup loaded the probe page (it is on ${popupPage.url()})`);

    await ownership.settle();
    assert.equal(
      ownership.classify(popupPage),
      "bot",
      "a popup a bot page opened is the bot's even though its opener tab is gone by the time anything looks " +
        `(the popup classified ${ownership.classify(popupPage)})`,
    );
    assert.equal(ownership.classify(operatorPage), "operator", "the tab that was open before the ownership attached is the operator's");

    assert.ok(
      await waitUntil(() => ownership.classify(otherPage) === "uncertain", 8000),
      `a tab another CDP client created mid-session is "uncertain" (it classified ${ownership.classify(otherPage)})`,
    );

    // The baseline is taken once the loads above have settled: the cleanup is asserted
    // to add NO NEW hits to any of them.
    await sleep(300);
    const baseline = {
      "self-op-1": hitsFrom(server.hits, "self-op-1").length,
      "popup-self": hitsFrom(server.hits, "popup-self").length,
      "bot-self": hitsFrom(server.hits, "bot-self").length,
      "other-self": hitsFrom(server.hits, "other-self").length,
    };

    const lines = await withConsoleErrorLines(async () => {
      await runExitCleanup(context, { ownership });
      await sleep(1500);
    });

    assert.ok(
      popupPage.isClosed(),
      "the popup is closed by the cleanup: a page a bot page opened is never left running unguarded after the exit",
    );
    assert.equal(
      hitsFrom(server.hits, "popup-self").length,
      baseline["popup-self"],
      "no NEW hits since the baseline for popup-self: the popup was denied, blanked and closed, never sent to the private " +
        `server (baseline ${baseline["popup-self"]}, now ${hitsFrom(server.hits, "popup-self").length}; ` +
        `hits: ${JSON.stringify(tagsOf(server.hits))})`,
    );
    assert.equal(
      hitsFrom(server.hits, "bot-self").length,
      baseline["bot-self"],
      "and the bot page that opened it leaked nothing on its own way out",
    );

    assert.equal(operatorPage.isClosed(), false, "the operator's tab is untouched");
    assert.equal(operatorPage.url(), `${probe.url}/self-op-1`, `…on its own page (${operatorPage.url()})`);
    assert.equal(
      hitsFrom(server.hits, "self-op-1").length,
      baseline["self-op-1"],
      "no NEW hits since the baseline for self-op-1: the operator's tab was never blanked, so its pagehide did not fire " +
        `again (baseline ${baseline["self-op-1"]}, now ${hitsFrom(server.hits, "self-op-1").length})`,
    );

    // The popup is the BOT's, so the cleanup's uncertain count can never include it.
    // The independent tab above IS uncertain, so one line — counting at most that one
    // tab — is allowed here.
    const reportedUncertain = lines
      .filter((line) => /uncertain/i.test(line))
      .map((line) => Number((line.match(/left (\d+) page/) || [])[1]));
    assert.ok(
      reportedUncertain.every((count) => Number.isFinite(count) && count <= 1),
      `the popup is never part of the uncertain count — at most the one independent tab is (lines: ${JSON.stringify(lines)})`,
    );

    // CONTROL: the tab another CDP client made mid-session is nobody provable, so it
    // stays open, on its own page, and was never navigated.
    assert.equal(otherPage.isClosed(), false, "CONTROL: the independent tab is left open");
    assert.ok(String(otherPage.url()).endsWith("/other-self"), `CONTROL: …on the page the other client put it on (${otherPage.url()})`);
    assert.equal(
      hitsFrom(server.hits, "other-self").length,
      baseline["other-self"],
      "CONTROL: …and it was never navigated: its pagehide never fired",
    );
    assert.equal(ownership.classify(otherPage), "uncertain", "CONTROL: and it is still nobody provable after the cleanup");
  } finally {
    if (raw && typeof raw.close === "function") raw.close();
    await owned.close();
  }
});

// ---------------------------------------------------------------------------
// L7: popups opened from INSIDE AN IFRAME of a bot page
//
// `window.open` does not have to run in the bot page's own document: a script in one
// of its IFRAMES can open the window, and then the popup's opener (as the page world
// reports it) is the FRAME, not the bot page. This case builds exactly that shape: a
// bot page (created through `ownership.newPage`, so it is the bot's) holding a
// same-site iframe, and — when a second loopback address can be bound — a cross-site
// iframe as well (its own site, so under site isolation its own process). Each
// frame's script calls window.open on the probe origin.
//
// What must hold whatever the opener reports: those popups are the BOT's (a page the
// bot's browser opened from inside the bot's own page), so the exit cleanup blanks
// and closes them, and nothing leaks on the way out; the operator's tab, opened
// before the ownership attached, is untouched. If this is red because an iframe
// opener resolves to null, that IS the finding: a popup of a bot page must never be
// left at the operator default (an unclassified page is treated as the operator's).
// ---------------------------------------------------------------------------

/**
 * A server for the iframe shape, bound to `host`.
 *
 *   /parent?probe=<probe url>[&frame=<origin>]
 *       a page with a same-site iframe, plus (when `frame` is given) a CROSS-SITE
 *       iframe served from that other origin
 *   /frame?probe=<probe url>&popup=<tag>
 *       the iframe's own document: its script calls `window.open(<probe>/<tag>)`
 *
 * The probe URL travels in the query so one server serves every case, and the popup
 * is a probe page (tag `<tag>`) so its pagehide/unload beacons are the hits counted.
 *
 * @returns {Promise<{error: string} | {host: string, port: number, origin: string}>}
 */
async function startIframeServer(t, host) {
  const server = createServer((req, res) => {
    let parsed = null;
    try {
      parsed = new URL(String(req.url || "/"), `http://${host}`);
    } catch {
      parsed = null;
    }
    const type = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (!parsed) {
      res.writeHead(400, type);
      res.end("bad url");
      return;
    }
    const probe = parsed.searchParams.get("probe") || "";
    const popup = parsed.searchParams.get("popup") || "ifr-popup";
    const frame = parsed.searchParams.get("frame") || "";
    if (parsed.pathname === "/parent") {
      const sameSite = `/frame?probe=${encodeURIComponent(probe)}&popup=ifr-popup-same`;
      const crossSite = frame
        ? `${frame}/frame?probe=${encodeURIComponent(probe)}&popup=ifr-popup-cross`
        : null;
      res.writeHead(200, type);
      res.end(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>iframe parent</title></head><body>" +
          "<h1>iframe parent</h1>" +
          `<iframe id=\"same-site\" src=\"${sameSite}\" width=\"200\" height=\"80\"></iframe>` +
          (crossSite ? `<iframe id=\"cross-site\" src=\"${crossSite}\" width=\"200\" height=\"80\"></iframe>` : "") +
          "<script>window.__iframeParentReady = 1;</script></body></html>",
      );
      return;
    }
    if (parsed.pathname === "/frame") {
      res.writeHead(200, type);
      res.end(
        "<!doctype html><html><body><script>\n" +
          "(function () {\n" +
          `  var PROBE = ${JSON.stringify(probe)};\n` +
          `  var POPUP = ${JSON.stringify(popup)};\n` +
          "  window.__iframeFrameReady = 1;\n" +
          "  try { window.open(PROBE + '/' + POPUP, '_blank'); } catch (e) {}\n" +
          "})();\n" +
          "</script></body></html>",
      );
      return;
    }
    res.writeHead(404, type);
    res.end("not an iframe probe page (ask for /parent or /frame)");
  });
  const bound = await new Promise((resolve) => {
    server.once("error", (err) => resolve({ error: err }));
    server.listen(0, host, () => resolve({ ok: true }));
  });
  if (bound.error) {
    try { server.close(); } catch { /* never listening */ }
    return { error: `could not bind ${host} (${bound.error.code || bound.error.message})` };
  }
  const { port } = server.address();
  t.after(() => new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }));
  return { host, port, origin: `http://${host}:${port}` };
}

/** The loopback address the cross-site half uses, when it can be bound. */
const CROSS_SITE_HOST = "127.0.0.3";

test("live: page ownership — popups opened from inside an iframe of a bot page are the bot's", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  // The bot page and its same-site iframe come from this origin (PROBE_HOST, the
  // guard's one exception); the cross-site iframe gets a SECOND loopback address, so
  // it is another site and — under site isolation — another process.
  const sameSite = await startIframeServer(t, PROBE_HOST);
  if (sameSite.error) {
    skipOrFail(t, sameSite.error);
    return;
  }
  const crossSite = await startIframeServer(t, CROSS_SITE_HOST);
  if (crossSite.error) {
    t.diagnostic(
      `cross-site iframe not exercised: ${crossSite.error} — only the same-site iframe case ran ` +
        `(the harness has no second loopback address to serve it from)`,
    );
  }

  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    const exceptions = parseExceptions(crossSite.error ? PROBE_HOST : `${PROBE_HOST},${CROSS_SITE_HOST}`);
    assert.deepEqual(
      exceptions.rejected,
      [],
      `the iframe/probe hosts are valid CROW_BROWSER_ALLOW_PRIVATE entries (parsed: ${JSON.stringify([...exceptions.hosts])})`,
    );
    await installPrivateAddressGuard(context, { exceptions });

    // The operator's tab exists, and is loaded, BEFORE the ownership attaches: it has
    // to be provably the operator's, and it is the control that survives.
    const operatorPage = context.pages()[0] || await context.newPage();
    await loadLeakPage(operatorPage, { probe, privateUrl: server.url, tag: "ifr-op-1" });

    const ownership = createPageOwnership();
    await ownership.attachContext(context);
    assert.equal(ownership.classify(operatorPage), "operator", "the tab open before the ownership attached is the operator's");

    // The bot's page: created through the ownership (so it is marked opened), then
    // loaded with the iframe document from the probe origin.
    const botPage = await ownership.newPage(context);
    assert.equal(ownership.classify(botPage), "bot", "ownership.newPage's page is the bot's");
    const parentUrl = `${sameSite.origin}/parent?probe=${encodeURIComponent(probe.url)}` +
      (crossSite.error ? "" : `&frame=${encodeURIComponent(crossSite.origin)}`);
    await botPage.goto(parentUrl, { waitUntil: "load", timeout: 15000 });
    assert.equal(
      await botPage.evaluate(() => window.__iframeParentReady),
      1,
      `the bot page with the iframe loaded (it is on ${botPage.url()})`,
    );

    /** Wait until a page on `<probe>/<tag>` is in this context, then until it loaded. */
    const popupFor = async (tag, ms) => {
      let found = null;
      const appeared = await waitUntil(() => {
        found = context.pages().find((page) => String(page.url()).includes(`/${tag}`)) || null;
        return Boolean(found);
      }, ms);
      if (!appeared) return { page: null };
      await waitUntil(async () => {
        try {
          return (await found.evaluate(() => window.__leakProbeReady)) === tag;
        } catch {
          return false;
        }
      }, 10000);
      return { page: found };
    };

    // The popup the SAME-SITE iframe opened: `window.open` ran in the frame's page
    // world, so its opener is the frame, not the bot page.
    const samePopup = await popupFor("ifr-popup-same", 15000);
    assert.ok(
      samePopup.page,
      `the popup the same-site iframe opened appeared (pages: ${context.pages().map((page) => page.url()).join(", ")})`,
    );
    const crossPopup = crossSite.error ? { page: null } : await popupFor("ifr-popup-cross", 15000);
    if (!crossSite.error) {
      assert.ok(
        crossPopup.page,
        `the popup the CROSS-SITE iframe opened appeared too (pages: ${context.pages().map((page) => page.url()).join(", ")})`,
      );
    }

    await ownership.settle();
    assert.equal(
      ownership.classify(samePopup.page),
      "bot",
      "a popup opened from INSIDE AN IFRAME of a bot page is the bot's (its opener is the frame's page world, " +
        `which is not the bot page itself; it classified ${ownership.classify(samePopup.page)})`,
    );
    if (crossPopup.page) {
      assert.equal(
        ownership.classify(crossPopup.page),
        "bot",
        "…and so is the one a CROSS-SITE (out-of-process) iframe of the bot page opened " +
          `(it classified ${ownership.classify(crossPopup.page)})`,
      );
    }
    assert.equal(ownership.classify(operatorPage), "operator", "the operator's tab is the operator's");

    // The baseline is taken once the loads above have settled: the cleanup is asserted
    // to add NO NEW hits to any of them.
    await sleep(300);
    const baseline = {
      "ifr-op-1": hitsFrom(server.hits, "ifr-op-1").length,
      "ifr-popup-same": hitsFrom(server.hits, "ifr-popup-same").length,
      "ifr-popup-cross": hitsFrom(server.hits, "ifr-popup-cross").length,
    };

    await runExitCleanup(context, { ownership });
    await sleep(1500);

    assert.ok(samePopup.page.isClosed(), "the cleanup closes the iframe's popup (a page of the bot's is never left running unguarded)");
    assert.equal(
      hitsFrom(server.hits, "ifr-popup-same").length,
      baseline["ifr-popup-same"],
      "no NEW hits since the baseline for the same-site iframe's popup: it was denied, blanked and closed rather " +
        `than sent to the private server (baseline ${baseline["ifr-popup-same"]}, now ` +
        `${hitsFrom(server.hits, "ifr-popup-same").length}; hits: ${JSON.stringify(tagsOf(server.hits))})`,
    );
    if (crossPopup.page) {
      assert.ok(crossPopup.page.isClosed(), "…and the cross-site iframe's popup too");
      assert.equal(
        hitsFrom(server.hits, "ifr-popup-cross").length,
        baseline["ifr-popup-cross"],
        "no NEW hits since the baseline for the cross-site iframe's popup either " +
          `(baseline ${baseline["ifr-popup-cross"]}, now ${hitsFrom(server.hits, "ifr-popup-cross").length})`,
      );
    }
    assert.ok(botPage.isClosed(), "…and the bot page that held the iframes");

    assert.equal(operatorPage.isClosed(), false, "CONTROL: the operator's tab is untouched");
    assert.equal(operatorPage.url(), `${probe.url}/ifr-op-1`, `CONTROL: …on its own page (${operatorPage.url()})`);
    assert.equal(
      hitsFrom(server.hits, "ifr-op-1").length,
      baseline["ifr-op-1"],
      "CONTROL: no NEW hits since the baseline for the operator's tab — it was never blanked, so its pagehide did " +
        `not fire (baseline ${baseline["ifr-op-1"]}, now ${hitsFrom(server.hits, "ifr-op-1").length})`,
    );
    assert.ok(
      context.pages().some((page) => page === operatorPage),
      "CONTROL: the operator's tab is still in the context after the cleanup",
    );
  } finally {
    await chrome.close();
  }
});

// ---------------------------------------------------------------------------
// L8: FIX3 — an INDEPENDENT tab that arrives inside the bot-action window
//
// A real Chromium opens a ctrl-clicked or middle-clicked tab with NO `opener()` and NO
// CDP `openerId` (the probe's finding). That is the same shape as another CDP client's
// `Target.createTarget`, so what tells them apart is TIME: the tab the bot's own
// clicking produced arrives within `botActionWindowMs` of the bot's action, and the tab
// a foreign client makes later does not. This case checks both ends of that window in
// one browser (a re-touch right before each click restarts it, and a sleep past it
// before the foreign tab), and it also records the shapes that DO carry an
// opener/openerId — target=_blank, rel=noopener, window.open(noopener) and a popup from
// a COOP page — which are the bot's with no window at all.
// ---------------------------------------------------------------------------

/**
 * A page on the probe's origin served with `Cross-Origin-Opener-Policy: same-origin`
 * whose own script calls `window.open` on the probe origin: COOP puts the opener in a
 * different browsing-context group, so the popup is a case where the page world's
 * `opener()` is severed and only the browser's own bookkeeping (`openerId`) can say who
 * opened it.
 *
 * @returns {Promise<{error: string} | {url: string}>} the page's url (asked with `?tag=`)
 */
async function startCoopServer(t, probeUrl) {
  const server = createServer((req, res) => {
    let parsed = null;
    try {
      parsed = new URL(String(req.url || "/"), `http://${PROBE_HOST}`);
    } catch {
      parsed = null;
    }
    const type = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (!parsed || parsed.pathname !== "/coop") {
      res.writeHead(404, type);
      res.end("not the COOP page (ask for /coop?tag=<tag>)");
      return;
    }
    const tag = parsed.searchParams.get("tag") || "coop-popup";
    res.writeHead(200, { ...type, "cross-origin-opener-policy": "same-origin" });
    res.end(
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>coop opener</title></head><body>" +
        "<script>\n" +
        "(function () {\n" +
        `  var PROBE = ${JSON.stringify(probeUrl)};\n` +
        `  var TAG = ${JSON.stringify(tag)};\n` +
        "  window.__coopReady = 1;\n" +
        "  try { window.open(PROBE + '/' + TAG, '_blank'); } catch (e) {}\n" +
        "})();\n" +
        "</script></body></html>",
    );
  });
  const bound = await new Promise((resolve) => {
    server.once("error", (err) => resolve({ error: err }));
    server.listen(0, PROBE_HOST, () => resolve({ ok: true }));
  });
  if (bound.error) {
    try { server.close(); } catch { /* never listening */ }
    return { error: `could not bind ${PROBE_HOST} for the COOP page (${bound.error.code || bound.error.message})` };
  }
  const { port } = server.address();
  t.after(() => new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }));
  return { url: `http://${PROBE_HOST}:${port}/coop` };
}

test("live: page ownership — a ctrl-click or middle-click tab inside the bot-action window is the bot's; a tab made after it is uncertain", async (t) => {
  const pw = await loadPlaywright();
  if (!pw.chromium) {
    skipOrFail(t, `playwright-core is not available (${pw.problems.join("; ")})`);
    return;
  }
  const server = await startPrivateServer(t);
  const probe = await startProbeServer(t, server.url);
  if (probe.error) {
    skipOrFail(t, probe.error);
    return;
  }
  const coop = await startCoopServer(t, probe.url);
  if (coop.error) t.diagnostic(`the COOP half did not run: ${coop.error}`);
  const chrome = await launchBrowser({ chromium: pw.chromium });
  if (chrome.error) {
    skipOrFail(t, chrome.error);
    return;
  }

  let raw = null;
  try {
    const context = chrome.browser.contexts()[0];
    assert.ok(context, "the launched browser has a default context");
    await installGuardAllowingProbe(context);

    // The operator's tab is loaded BEFORE the ownership attaches (proof (i)): it is the
    // control that the window never reaches a PROVEN operator page.
    const operatorPage = context.pages()[0] || await context.newPage();
    await loadLeakPage(operatorPage, { probe, privateUrl: server.url, tag: "win-op" });

    // FIX3's window is 300 ms in this case: short enough to step over inside it, and a
    // re-touch before each click restarts it, so the tab the click opens arrives inside.
    const ownership = createPageOwnership({ botActionWindowMs: 300 });
    await ownership.attachContext(context);
    assert.equal(ownership.classify(operatorPage), "operator", "the tab open before the ownership attached is the operator's");

    const botPage = await ownership.newPage(context); // a bot action: the window starts here
    await loadLeakPage(botPage, { probe, privateUrl: server.url, tag: "win-bot" });

    // The links the clicks need. Every one of them opens a probe page, so the tab that
    // appears is recognisable by its url.
    await botPage.evaluate((targets) => {
      for (const item of targets) {
        const link = document.createElement("a");
        link.id = item.id;
        link.href = item.url;
        link.textContent = item.id;
        link.target = item.target || "_blank";
        if (item.rel) link.rel = item.rel;
        document.body.appendChild(link);
      }
    }, [
      { id: "ctrl-blank", url: `${probe.url}/win-ctrl` },
      { id: "middle-blank", url: `${probe.url}/win-middle` },
      { id: "blank-plain", url: `${probe.url}/win-targetblank` },
      { id: "blank-noopener", url: `${probe.url}/win-relnoopener`, rel: "noopener" },
    ]);

    /** Wait for the tab on `<probe>/<tag>` to appear, then for its classification to land. */
    const arrivalOn = async (tag, ms = 15000) => {
      let found = null;
      const appeared = await waitUntil(() => {
        found = context.pages().find((page) => String(page.url()).includes(`/${tag}`)) || null;
        return Boolean(found);
      }, ms);
      if (!appeared) return null;
      await sleep(200); // the context's own "page" event, then the classification around it
      await ownership.settle();
      return found;
    };
    const urlsOf = () => context.pages().map((page) => String(page.url())).join(", ");

    // (1) CTRL-CLICK on a target=_blank link. The probe's finding is that this tab has no
    // opener() and no openerId: only the bot-action window can claim it, and it is one the
    // bot's own clicking produced, so it must not be left running unguarded.
    ownership.markTouched(botPage); // the bot action, immediately before the click
    await botPage.click("#ctrl-blank", { modifiers: ["Control"] });
    const ctrlTab = await arrivalOn("win-ctrl");
    assert.ok(ctrlTab, `the ctrl-clicked tab appeared (pages: ${urlsOf()})`);
    assert.equal(
      ownership.classify(ctrlTab),
      "bot",
      "a ctrl-clicked tab (no opener(), no openerId — the probe's finding) that arrives inside the bot-action " +
        `window is the bot's (it classified ${ownership.classify(ctrlTab)})`,
    );

    // (2) MIDDLE-CLICK on a target=_blank link: the same shape, the same answer.
    ownership.markTouched(botPage); // restart the window
    await botPage.click("#middle-blank", { button: "middle" });
    const middleTab = await arrivalOn("win-middle");
    assert.ok(middleTab, `the middle-clicked tab appeared (pages: ${urlsOf()})`);
    assert.equal(
      ownership.classify(middleTab),
      "bot",
      `a middle-clicked tab that arrives inside the bot-action window is the bot's (it classified ${ownership.classify(middleTab)})`,
    );

    // (3) The shapes that DO carry an opener/openerId: the bot's with no window at all.
    await botPage.click("#blank-plain"); // target=_blank
    const blankTab = await arrivalOn("win-targetblank");
    assert.ok(blankTab, `the target=_blank link's tab appeared (pages: ${urlsOf()})`);
    assert.equal(ownership.classify(blankTab), "bot", "a target=_blank popup of a bot page is the bot's (it carries an opener)");

    await botPage.click("#blank-noopener"); // rel=noopener
    const noopenerTab = await arrivalOn("win-relnoopener");
    assert.ok(noopenerTab, `the rel=noopener link's tab appeared (pages: ${urlsOf()})`);
    assert.equal(
      ownership.classify(noopenerTab),
      "bot",
      "a rel=noopener popup of a bot page is the bot's: the page world's opener is gone but the browser still names the opener",
    );

    await botPage.evaluate((url) => { window.open(url, "_blank", "noopener"); }, `${probe.url}/win-open-noopener`);
    const openNoopenerTab = await arrivalOn("win-open-noopener");
    assert.ok(openNoopenerTab, `the window.open(noopener) tab appeared (pages: ${urlsOf()})`);
    assert.equal(
      ownership.classify(openNoopenerTab),
      "bot",
      `a window.open(url, "_blank", "noopener") popup of a bot page is the bot's (it classified ${ownership.classify(openNoopenerTab)})`,
    );

    if (coop.url) {
      // A popup opened from INSIDE a COOP page: the browsing-context group is cut, so the
      // page world reports no opener — the browser's openerId is what proves it.
      const coopPage = await ownership.newPage(context);
      await coopPage.goto(`${coop.url}?tag=win-coop`, { waitUntil: "load", timeout: 15000 });
      assert.equal(await coopPage.evaluate(() => window.__coopReady).catch(() => null), 1, "the COOP page loaded");
      const coopTab = await arrivalOn("win-coop");
      assert.ok(coopTab, `the COOP page's popup appeared (pages: ${urlsOf()})`);
      assert.equal(
        ownership.classify(coopTab),
        "bot",
        "a popup of a COOP page of the bot's is the bot's: COOP severs opener() but the browser still names the opener " +
          `(it classified ${ownership.classify(coopTab)})`,
      );
      assert.equal(ownership.classify(coopPage), "bot", "…and the COOP page itself is the bot's (ownership.newPage)");
    }

    // (4) THE CONTROL: the window has to EXPIRE. Another CDP client makes the same tab
    // SHAPE (no opener, no openerId) after it has, and that one is nobody provable.
    await sleep(600); // past the 300 ms window, measured from the last bot action above
    raw = await openRawBrowserCdp(chrome.port);
    if (raw.error) {
      skipOrFail(t, raw.error);
      return;
    }
    await raw.send("Target.createTarget", { url: `${probe.url}/win-other` });
    const otherTab = await arrivalOn("win-other");
    assert.ok(otherTab, `the other CDP client's tab appeared (pages: ${urlsOf()})`);
    assert.equal(
      ownership.classify(otherTab),
      "uncertain",
      "CONTROL: a tab of the SAME shape (no opener, no openerId) made by another CDP client AFTER the bot-action " +
        `window expired is 'uncertain' — the window is the whole difference, not the shape (it classified ${ownership.classify(otherTab)})`,
    );

    // …and the window never reached a PROVEN operator page.
    assert.equal(ownership.classify(operatorPage), "operator", "CONTROL: the operator's tab is still the operator's");
    assert.equal(operatorPage.isClosed(), false, "CONTROL: …and still open");
  } finally {
    if (raw && typeof raw.close === "function") raw.close();
    await chrome.close();
  }
});