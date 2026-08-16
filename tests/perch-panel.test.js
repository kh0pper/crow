/**
 * Perch nav panel — three honest states (Perch Hub Phase 1, Task C-7).
 *
 * The panel is the ONE dashboard-native surface for Perch, so it owns the
 * two things the bots-lens page inside the iframe structurally cannot do
 * (PL-2 finding #2 — the lens is a different document served through the
 * proxy):
 *
 *   1. disappear from the nav entirely when the bundle is not installed
 *      (the fediverse #230 `hidden` predicate idiom), and
 *   2. offer the one-click bundle install (the C4 engine-gate modal's job
 *      client, re-pointed at bundle id "perch-hub").
 *
 * What this file proves, layer by layer:
 *   • pure state resolution (`perchPanelState`) over injected inputs —
 *     including the case the C-2 findings call out explicitly: disk truth
 *     and supervisor truth are SEPARATE, so "installed but down" can never
 *     collapse into "not installed" (or into a dead iframe);
 *   • the `hidden` predicate against a real scratch CROW_HOME, re-evaluated
 *     per getVisiblePanels() call (install → nav appears, no re-import);
 *   • the real `handler` output in each state, driven by the REAL
 *     perch-runtime module state (a fake superviseProcess handle stands in
 *     for the child) rather than a hand-made status object — so a panel
 *     that stopped reading perchRuntimeStatus() would go red here;
 *   • linkedom structure (an <iframe> element exists ONLY in the running
 *     state, and points at /proxy/perch-hub/bots);
 *   • the gate client executed for real (node:vm + linkedom): the install
 *     button POSTs the bundle-install job, polls it, and takes the
 *     restart path a webUI bundle always produces (C-3 needsRestart);
 *   • HTML escaping of `lastError` — operator-facing text that lands in the
 *     page — and the repo-wide client-JS invariants (zero literal
 *     backticks, no bare form.submit()).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import Database from "better-sqlite3";

const repoRoot = join(import.meta.dirname, "..");
const PANEL_SRC_PATH = join(repoRoot, "servers/gateway/dashboard/panels/perch.js");

// CROW_HOME must be scratch before the panel module is imported — the gate
// resolves it per call (proved below), but nothing in this file may ever
// touch the real ~/.crow (#217 class).
const scratchRoot = mkdtempSync(join(tmpdir(), "perch-panel-test-"));
process.env.CROW_HOME = join(scratchRoot, "home-initial");
mkdirSync(process.env.CROW_HOME, { recursive: true });

// CROW_DATA_DIR must ALSO be scratch before the panel module is imported —
// §5.1's unattached-callout data path reads pi_bot_defs via createDbClient(),
// which falls back to $HOME/.crow/data when CROW_DATA_DIR is unset (#217
// class again, this time for the db rather than the bundle payload).
const dataDir = join(scratchRoot, "data");
process.env.CROW_DATA_DIR = dataDir;
delete process.env.CROW_DB_PATH;
mkdirSync(dataDir, { recursive: true });
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dataDir },
  stdio: "pipe",
  cwd: repoRoot,
});
const DB_FILE = join(dataDir, "crow.db");

function rawDb() {
  return new Database(DB_FILE);
}

/** pi_bot_defs.enabled is INTEGER — callers must pass 1/0, never a boolean. */
function seedBot(botId, def, { name = botId, enabled = 1 } = {}) {
  const c = rawDb();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)")
    .run(botId, name, JSON.stringify(def), enabled);
  c.close();
}

function clearBots() {
  const c = rawDb();
  c.exec("DELETE FROM pi_bot_defs");
  c.close();
}

const { registerPanel, getVisiblePanels } = await import("../servers/gateway/dashboard/panel-registry.js");
const panelMod = await import("../servers/gateway/dashboard/panels/perch.js");
const perchPanel = panelMod.default;
const { perchInstalled, perchPanelState, perchGateClientJS, PERCH_LENS_PATH } = panelMod;
const { initPerchRuntime, perchRuntimeStatus, _resetPerchRuntimeForTest } =
  await import("../servers/gateway/perch-runtime.js");
const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");

registerPanel(perchPanel);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let scratch;

/** A CROW_HOME with (or without) the vendored payload entrypoint on disk. */
function makeCrowHome({ installed = false } = {}) {
  const home = mkdtempSync(join(scratch, "crowhome-"));
  if (installed) {
    const hubDir = join(home, "bundles", "perch-hub", "payload", "hub");
    mkdirSync(hubDir, { recursive: true });
    writeFileSync(join(hubDir, "server.mjs"), "// vendored hub stub\n");
  }
  return home;
}

/** superviseProcess double whose handle the test drives (same shape as the
 * real one: {live, state, lastError, stop}). */
function fakeSupervisor() {
  const handles = [];
  const fn = (opts) => {
    const h = {
      key: opts.key,
      live: true,
      state: "running",
      restartCount: 0,
      lastError: null,
      stop: async () => { h.live = false; h.state = "stopped"; },
      fireTerminal: (reason) => opts.onTerminal(reason),
    };
    handles.push(h);
    return h;
  };
  fn.handles = handles;
  return fn;
}

/**
 * Put the REAL perch-runtime module into one of its three real states and
 * point the panel's CROW_HOME at the matching scratch home.
 * @param {"not_installed"|"running"|"offline"} want
 */
async function arrangeRuntime(want, { lastError = null } = {}) {
  const home = makeCrowHome({ installed: want !== "not_installed" });
  process.env.CROW_HOME = home;
  if (want === "not_installed") return { home, handle: null };

  const supervise = fakeSupervisor();
  const res = await initPerchRuntime({ crowHome: home, env: {}, superviseProcess: supervise });
  assert.equal(res.started, true, "precondition: the runtime must actually have started");
  const handle = supervise.handles[0];
  if (want === "offline") {
    handle.live = false;
    handle.state = "unhealthy";
    handle.lastError = lastError;
    if (lastError) handle.fireTerminal(lastError);
  }
  return { home, handle };
}

const layout = ({ content }) => content;
const render = (lang = "en") => perchPanel.handler({ method: "GET", query: {} }, {}, { db: null, layout, lang });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "perch-panel-case-"));
});

afterEach(() => {
  _resetPerchRuntimeForTest();
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  // window.__* leak hygiene: linkedom mirrors unqualified window writes onto
  // the real globalThis, so a client-script run can otherwise poison the next
  // test in this file.
  for (const k of Object.keys(globalThis)) {
    if (k.startsWith("__perch")) delete globalThis[k];
  }
});

// ---------------------------------------------------------------------------
// 1. Pure state resolution
// ---------------------------------------------------------------------------

test("perchPanelState: nothing on disk and nothing supervised → not_installed", () => {
  const state = perchPanelState({
    status: { installed: false, running: false, state: "stopped", lastError: null, port: null },
    installed: false,
  });
  assert.equal(state, "not_installed");
});

test("perchPanelState: installed and the child is live → running", () => {
  const state = perchPanelState({
    status: { installed: true, running: true, state: "running", lastError: null, port: 4210 },
    installed: true,
  });
  assert.equal(state, "running");
});

test("perchPanelState: installed but the child is NOT live → offline, never running", () => {
  const state = perchPanelState({
    status: { installed: true, running: false, state: "unhealthy", lastError: "exited (code=1)", port: 4210 },
    installed: true,
  });
  assert.equal(state, "offline");
});

test("perchPanelState: disk truth outranks a stale supervisor that never saw the install", () => {
  // C-3 makes a webUI install set needsRestart, so between the install and
  // the restart the supervisor legitimately reports installed:false. The
  // panel must NOT offer to install an already-installed bundle.
  const state = perchPanelState({
    status: { installed: false, running: false, state: "stopped", lastError: null, port: null },
    installed: true,
  });
  assert.equal(state, "offline");
});

test("perchInstalled: reads the payload entrypoint under the given CROW_HOME", () => {
  const empty = makeCrowHome({ installed: false });
  const full = makeCrowHome({ installed: true });
  const stopped = { installed: false, running: false, state: "stopped", lastError: null, port: null };
  assert.equal(perchInstalled({ crowHome: empty, status: stopped }), false);
  assert.equal(perchInstalled({ crowHome: full, status: stopped }), true);
  // supervisor-reported install counts too (payload dir readable only by the
  // gateway user, or removed under a live child)
  assert.equal(
    perchInstalled({ crowHome: empty, status: { ...stopped, installed: true } }),
    true,
  );
});

// ---------------------------------------------------------------------------
// 2. The hidden predicate (nav visibility)
// ---------------------------------------------------------------------------

test("no perch-hub payload → the Perch nav entry is hidden", () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  assert.equal(perchPanel.hidden(), true);
  assert.ok(!getVisiblePanels().map((p) => p.id).includes("perch"),
    "the Perch panel leaked into the nav of an instance without the bundle");
});

test("installing the payload reveals the nav entry with no re-import (per-call predicate)", () => {
  const home = makeCrowHome({ installed: false });
  process.env.CROW_HOME = home;
  assert.equal(perchPanel.hidden(), true, "precondition: hidden before the payload lands");

  const hubDir = join(home, "bundles", "perch-hub", "payload", "hub");
  mkdirSync(hubDir, { recursive: true });
  writeFileSync(join(hubDir, "server.mjs"), "// vendored hub stub\n");

  assert.equal(perchPanel.hidden(), false);
  assert.ok(getVisiblePanels().map((p) => p.id).includes("perch"),
    "the panel must appear as soon as the bundle is installed");
});

// ---------------------------------------------------------------------------
// 3. The three rendered states
// ---------------------------------------------------------------------------

test("running → a full-height iframe of the bots lens, and no gate card", async () => {
  await arrangeRuntime("running");
  assert.equal(perchRuntimeStatus().running, true, "precondition: the runtime reports running");

  const html = await render("en");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const frames = [...document.querySelectorAll("iframe")];
  assert.equal(frames.length, 1, "the running state must embed the lens in exactly one iframe");
  assert.equal(frames[0].getAttribute("src"), "/proxy/perch-hub/bots");
  assert.equal(PERCH_LENS_PATH, "/proxy/perch-hub/bots");
  // NB: assert on a COUNT, never on the element itself — a failing
  // assert.equal(<linkedom element>, null) inspects the whole circular DOM
  // to build its diff and takes minutes.
  assert.equal(document.querySelectorAll("#perch-install-btn").length, 0,
    "an installed, running Perch must not offer to install itself");
  assert.ok(!html.includes(translations["perch.offlineTitle"].en),
    "a running Perch must not claim to be offline");
});

test("installed but down → offline copy + the supervisor's lastError + a retry hint, never an iframe", async () => {
  await arrangeRuntime("offline", { lastError: "exited (code=1, signal=null)" });
  const status = perchRuntimeStatus();
  assert.equal(status.installed, true);
  assert.equal(status.running, false, "precondition: the runtime reports the child is down");

  const html = await render("en");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("iframe").length, 0,
    "a dead hub must never be framed — that renders a proxy error page inside the dashboard");
  assert.ok(html.includes(translations["perch.offlineTitle"].en), "offline title missing");
  assert.ok(html.includes(translations["perch.offlineHint"].en), "retry hint missing");
  assert.ok(html.includes("exited (code=1, signal=null)"),
    "the operator must see the supervisor's actual lastError, not a generic message");
  assert.equal(document.querySelectorAll("#perch-install-btn").length, 0,
    "an installed-but-down Perch must not offer to install itself");
});

test("installed but down with NO recorded error → still honest, no blank error box", async () => {
  await arrangeRuntime("offline");
  const html = await render("en");
  assert.ok(html.includes(translations["perch.offlineTitle"].en));
  assert.ok(html.includes(translations["perch.offlineNoError"].en),
    "with no lastError the panel must say so rather than render an empty error block");
  assert.ok(!html.includes("<pre"), "no empty <pre> error box when there is no error to show");
});

test("not installed → the gate card with a one-click install button, and no iframe", async () => {
  await arrangeRuntime("not_installed");
  const html = await render("en");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("iframe").length, 0,
    "an uninstalled Perch must not frame a route that 404s");
  assert.equal(document.querySelectorAll("#perch-install-btn").length, 1,
    "the gate card must carry the one-click install button");
  assert.ok(html.includes(translations["perch.gateTitle"].en), "gate title missing");
  assert.ok(html.includes(translations["perch.gateBody"].en), "gate body missing");
});

test("lastError is HTML-escaped — it is operator-facing text that lands in the page", async () => {
  const payload = `<img src=x onerror="alert(1)"> & 'quoted'`;
  await arrangeRuntime("offline", { lastError: payload });

  const html = await render("en");
  assert.ok(!html.includes("<img src=x"), "raw markup from lastError reached the page unescaped");
  assert.ok(html.includes("&lt;img src=x"), "expected the escaped rendering of lastError");
  assert.ok(html.includes("&amp;"), "ampersand must be escaped");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("img").length, 0,
    "lastError must never be able to inject an element into the dashboard");
});

test("Spanish renders Spanish copy in every state (EN/ES parity is wired, not just declared)", async () => {
  await arrangeRuntime("not_installed");
  const gateEs = await render("es");
  assert.ok(gateEs.includes(translations["perch.gateTitle"].es), "gate card is not translated");

  _resetPerchRuntimeForTest();
  await arrangeRuntime("offline", { lastError: "boom" });
  const offlineEs = await render("es");
  assert.ok(offlineEs.includes(translations["perch.offlineTitle"].es), "offline card is not translated");

  _resetPerchRuntimeForTest();
  await arrangeRuntime("running");
  const runningEs = await render("es");
  assert.ok(runningEs.includes(translations["perch.frameLabel"].es), "iframe label is not translated");
});

test("no rendered state leaks a raw i18n key as visible text (en + es)", async () => {
  for (const want of ["not_installed", "offline", "running"]) {
    for (const lang of ["en", "es"]) {
      _resetPerchRuntimeForTest();
      await arrangeRuntime(want, { lastError: "boom" });
      const html = await render(lang);
      const leaks = html.match(/perch\.[A-Za-z0-9]+/g) || [];
      assert.deepEqual(leaks, [], `raw key leaked in ${want}/${lang}: ${leaks.join(", ")}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. The unattached-Perch callout (§5.1) — the running state stays honest
//    when no ENABLED bot has the perch gateway attached.
// ---------------------------------------------------------------------------

test("running with no enabled+attached bot → the unattached callout renders ABOVE the iframe, not instead of it", async () => {
  await arrangeRuntime("running");
  clearBots();
  seedBot("disabled-attached", { gateways: [{ type: "perch" }] }, { enabled: 0 });
  seedBot("enabled-unattached", {
    gateways: [{ type: "gmail", address: "a@example.com", allowlist: ["b@example.com"] }],
  }, { enabled: 1 });

  const html = await render("en");
  assert.ok(html.includes(translations["perch.unattachedTitle"].en),
    "the unattached callout is missing — a disabled-but-attached bot and an enabled-but-unattached bot both leave the perch inert");

  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("iframe").length, 1,
    "the callout must sit ABOVE the iframe — the sessions view still works, so the lens must not disappear");

  const calloutAt = html.indexOf(translations["perch.unattachedTitle"].en);
  const iframeAt = html.indexOf("<iframe");
  assert.ok(calloutAt > -1 && iframeAt > -1 && calloutAt < iframeAt,
    "the callout must render before the iframe in document order");
});

test("running with at least one enabled+attached bot → no unattached callout", async () => {
  await arrangeRuntime("running");
  clearBots();
  seedBot("disabled-attached", { gateways: [{ type: "perch" }] }, { enabled: 0 });
  seedBot("enabled-unattached", {
    gateways: [{ type: "gmail", address: "a@example.com", allowlist: ["b@example.com"] }],
  }, { enabled: 1 });
  seedBot("enabled-attached", { gateways: [{ type: "perch" }] }, { enabled: 1 });

  const html = await render("en");
  assert.ok(!html.includes(translations["perch.unattachedTitle"].en),
    "a real, enabled, attached bot exists — the callout must not render");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("iframe").length, 1);
});

test("the unattached callout is translated in Spanish too", async () => {
  await arrangeRuntime("running");
  clearBots();
  seedBot("enabled-unattached", { gateways: [] }, { enabled: 1 });

  const html = await render("es");
  assert.ok(html.includes(translations["perch.unattachedTitle"].es),
    "the unattached callout must be translated, not left in English for es readers");
});

test("the unattached callout links to the Bot Builder panel", async () => {
  await arrangeRuntime("running");
  clearBots();
  seedBot("enabled-unattached", { gateways: [] }, { enabled: 1 });

  const html = await render("en");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const link = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/dashboard/bot-builder");
  assert.ok(link, "the callout must link to the Bot Builder panel so the operator can act on it");
});

test("a db query error must HIDE the callout, not show it — 'unknown' must never render as 'confirmed zero'", async () => {
  // A query-level failure (bad connection, locked db, no pi_bot_defs table at
  // all) is genuinely different from "the table has zero attached rows": the
  // panel cannot tell whether a bot is attached, so showing the unattached
  // callout would be a specific, plausible, WRONG diagnosis that sends the
  // operator to redo working configuration. Point CROW_DATA_DIR at a fresh
  // directory with no init-db'd schema — better-sqlite3 happily creates the
  // empty file, so the SELECT itself is what fails (no such table).
  await arrangeRuntime("running");
  const brokenDir = mkdtempSync(join(scratch, "broken-db-"));
  const savedDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = brokenDir;
  try {
    const html = await render("en");
    assert.ok(!html.includes(translations["perch.unattachedTitle"].en),
      "a db read error rendered the unattached callout — 'unknown' must never render as 'confirmed zero'");
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    assert.equal(document.querySelectorAll("iframe").length, 1, "the lens must still render on a db error");
  } finally {
    process.env.CROW_DATA_DIR = savedDataDir;
  }
});

// ---------------------------------------------------------------------------
// 5. The gate client, executed
// ---------------------------------------------------------------------------

/** Mount the gate card's real HTML+script in linkedom and run the script. */
function bootGateClient() {
  const html = perchGateClientJS("en");
  const { window, document } = parseHTML(
    `<html><body><button id="perch-install-btn">Install</button>` +
    `<div id="perch-install-status"></div>${html}</body></html>`,
  );

  const calls = [];
  const timers = [];
  const location = { href: "https://crow.test/dashboard/perch", reloads: 0, reload() { location.reloads += 1; } };
  let fetchImpl = null;
  const fetchStub = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    const result = fetchImpl
      ? fetchImpl(String(url), init)
      : { ok: true, status: 200, json: () => Promise.resolve({}) };
    return Promise.resolve(result);
  };

  const ctx = vm.createContext({
    window, document, location, console, URL,
    fetch: fetchStub,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
  });

  const start = html.indexOf("<script>");
  const end = html.lastIndexOf("</script>");
  assert.ok(start > -1 && end > start, "could not locate the gate client <script> block");
  vm.runInContext(html.slice(start + "<script>".length, end), ctx);

  const btn = document.getElementById("perch-install-btn");
  const statusEl = document.getElementById("perch-install-status");
  const click = () => btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const flushTimers = () => { timers.splice(0).forEach((fn) => fn()); };
  const setFetchImpl = (fn) => { fetchImpl = fn; };

  return { window, document, btn, statusEl, click, settle, flushTimers, setFetchImpl, calls, location };
}

test("gate client: clicking install POSTs the perch-hub bundle-install job", async () => {
  const g = bootGateClient();
  g.setFetchImpl(() => ({ ok: true, status: 200, json: () => Promise.resolve({ job_id: "job-1" }) }));

  g.click();
  await g.settle();

  const install = g.calls.find((c) => c.url.endsWith("/dashboard/bundles/api/install"));
  assert.ok(install, "no install call was made — the gate card's whole point is one-click install");
  assert.equal(install.init.method, "POST");
  assert.deepEqual(install.body, { bundle_id: "perch-hub", env_vars: {} });
  assert.equal(g.btn.disabled, true, "the button must disarm while the job runs");
});

test("gate client: a webUI install ends in complete_restart → restart is requested and the page waits", async () => {
  const g = bootGateClient();
  g.setFetchImpl((url) => {
    if (url.endsWith("/install")) return { ok: true, status: 200, json: () => Promise.resolve({ job_id: "job-2" }) };
    if (url.includes("/jobs/")) {
      return { ok: true, status: 200, json: () => Promise.resolve({ status: "complete_restart", log: ["installed"] }) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  });

  g.click();
  await g.settle();

  const restart = g.calls.find((c) => c.url.endsWith("/dashboard/bundles/api/restart"));
  assert.ok(restart, "a webUI bundle needs a gateway restart (C-3) — the client must ask for one");
  assert.equal(restart.init.method, "POST");

  // the restart waiter polls /health and reloads once the gateway answers
  g.flushTimers();
  await g.settle();
  const health = g.calls.find((c) => c.url === "/health");
  assert.ok(health, "the client must wait for the gateway to come back before reloading");
  await g.settle();
  assert.ok(g.location.reloads >= 1, "the page must reload once the gateway is back");
});

test("gate client: a failed job re-arms the button and shows the failure", async () => {
  const g = bootGateClient();
  g.setFetchImpl((url) => {
    if (url.endsWith("/install")) return { ok: true, status: 200, json: () => Promise.resolve({ job_id: "job-3" }) };
    return { ok: true, status: 200, json: () => Promise.resolve({ status: "failed", log: ["no disk space"] }) };
  });

  g.click();
  await g.settle();

  assert.equal(g.btn.disabled, false, "a failed install must leave the operator able to retry");
  assert.ok(g.statusEl.textContent.includes("no disk space"),
    "the operator must see WHY the install failed: " + g.statusEl.textContent);
});

test("gate client: an install the server refuses outright is reported, not silently swallowed", async () => {
  const g = bootGateClient();
  g.setFetchImpl(() => ({ ok: false, status: 400, json: () => Promise.resolve({ error: "unknown bundle" }) }));

  g.click();
  await g.settle();

  assert.equal(g.btn.disabled, false);
  assert.ok(g.statusEl.textContent.includes("unknown bundle"), g.statusEl.textContent);
  assert.equal(g.calls.filter((c) => c.url.includes("/jobs/")).length, 0,
    "there is no job to poll when the install request itself was refused");
});

// ---------------------------------------------------------------------------
// 6. Repo-wide client-JS invariants + i18n coverage
// ---------------------------------------------------------------------------

test("the emitted client <script> block contains ZERO literal backtick characters", () => {
  const html = perchGateClientJS("en");
  const start = html.indexOf("<script>");
  const end = html.lastIndexOf("</script>");
  const body = html.slice(start + "<script>".length, end);
  assert.equal((body.match(/`/g) || []).length, 0,
    "a literal backtick inside the client <script> block would break the whole dashboard");
  assert.equal((html.match(/<\/script>/g) || []).length, 1,
    "exactly one closing script tag, or the browser sees a truncated script");
});

test("the panel source contains no bare native form.submit()", () => {
  const src = readFileSync(PANEL_SRC_PATH, "utf8");
  const offenders = src.split("\n")
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /\.submit\(\)/.test(line) && !line.includes("requestSubmit"));
  assert.deepEqual(offenders.map((o) => `${o.i + 1}: ${o.line.trim()}`), []);
});

test("every perch.* / nav.perch key the panel uses resolves to real en + es copy", () => {
  const src = readFileSync(PANEL_SRC_PATH, "utf8");
  const used = new Set((src.match(/"perch\.[A-Za-z0-9]+"/g) || []).map((s) => s.slice(1, -1)));
  assert.ok(used.size >= 10, `sanity check: expected the panel to use at least ten perch.* keys, saw ${used.size}`);
  for (const key of used) {
    assert.ok(translations[key], `missing i18n key: ${key}`);
    assert.ok(translations[key].en, `${key} has no en copy`);
    assert.ok(translations[key].es, `${key} has no es copy`);
  }
  assert.ok(translations["nav.perch"], "missing nav.perch i18n key (the sidebar label)");
  assert.ok(translations["nav.perch"].es, "nav.perch has no es entry");
});

test("dashboard/index.js actually registers the panel", () => {
  // A panel nobody registers is a file, not a feature — and every other
  // test in this file registers it itself, so nothing else would notice.
  // Source-text pin, the same idiom C-5 used for its mount site.
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/index.js"), "utf8");
  assert.match(src, /import perchPanel from "\.\/panels\/perch\.js";/,
    "dashboard/index.js does not import the Perch panel");
  assert.match(src, /registerPanel\(perchPanel\);/,
    "dashboard/index.js imports the Perch panel but never registers it");
});

test("panel manifest matches the panel-registry contract", () => {
  assert.equal(perchPanel.id, "perch");
  assert.equal(perchPanel.route, "/dashboard/perch");
  assert.equal(typeof perchPanel.hidden, "function", "the gate must be a PREDICATE, re-evaluated per nav render");
  assert.equal(typeof perchPanel.handler, "function");
  assert.equal(typeof perchPanel.navOrder, "number");
});

test.after(() => {
  try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
});
