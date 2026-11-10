/**
 * The words and the two surfaces PR D adds (Task 7).
 *
 * The exact sentences are pinned here — they are what the install modal and an
 * add-on's page show — and the two delivery paths are driven for real: the
 * consent-challenge JSON through the bundles router, and the emitted panel
 * client source (which must survive the panel's template literal).
 *
 * Scratch CROW_HOME + CROW_DATA_DIR throughout; the probe and the owner check
 * are the shared modules' own seams, so no add-on is started and no bwrap runs.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-wall-words-home-"));
const TMP_DATA = join(TMP_HOME, "data");
mkdirSync(TMP_DATA, { recursive: true });
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.CROW_ADDON_WALLS;
delete process.env.CROW_ADDON_WALLS_DEFAULT;

const {
  sandboxLine, labelPhrase, NOTICE, RESIDUAL_LINE, SANDBOX_LINE, SUMMARY, WALL_WORDS,
} = await import("../scripts/addon-sandbox/words.mjs");
const { deriveProfile, pendingHostFields } = await import("../scripts/addon-sandbox/profile.mjs");
const { _setAddonWallProbeForTest, renderAddonWallStatus } = await import("../servers/gateway/dashboard/shared/addon-wall-status.js");
const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { extensionsClientJS } = await import("../servers/gateway/dashboard/panels/extensions/client.js");
const { addonWallDetails } = await import("../servers/gateway/dashboard/shared/addon-wall-details.js");
const { readAddonWalls } = await import("../servers/shared/addon-walls-file.js");
const B = await import("../servers/gateway/routes/bundles.js");

// The manifest-only profiles of the shipped add-ons (the registry's own file).
const REGISTRY_PROFILES = JSON.parse(readFileSync(join(REPO, "registry", "addon-profiles.json"), "utf8")).profiles;

const SANDBOXED = Object.freeze({ ok: true, pidns: true, bwrap: "/usr/bin/bwrap", setpriv: null, reason: null, pidReason: null });
// bubblewrap is not installed here, so nothing can run walled whatever the default.
const NO_BWRAP = Object.freeze({ ok: false, pidns: false, bwrap: null, setpriv: null, reason: "bubblewrap (bwrap) is not installed", pidnsReason: null });

// The repo bundles dir the router's profile reads for a fixture bundle.
const FIXTURES = mkdtempSync(join(tmpdir(), "crow-wall-words-app-"));
B._setAppBundlesForTest(FIXTURES);

after(() => {
  B._setAppBundlesForTest(null);
  B._setOwnerCheckForTest(null);
  B._setAddonWallReconnectForTest(null);
  _setAddonWallProbeForTest(null);
  for (const d of [TMP_HOME, FIXTURES]) rmScratch(d);
});

// ─── the sentence ──────────────────────────────────────────────────────────

test("the paperless profile's line is exactly the one the install modal shows", () => {
  const line = sandboxLine(REGISTRY_PROFILES.paperless, "en", { walled: true });
  assert.equal(line, "This add-on can: use the internet; reach Paperless-ngx on this computer; keep files in its own folder");
});

test("studio's line ends with Crow's database, and says storage before it when it carries that residual", () => {
  const line = sandboxLine(REGISTRY_PROFILES.studio, "en", { walled: true, residuals: [{ kind: "storage" }] });
  assert.ok(line.endsWith("; read Crow's stored keys and change its database"), line);
  const storageAt = line.indexOf("; use all of Crow's storage");
  assert.ok(storageAt > 0, line);
  assert.ok(storageAt < line.indexOf("; read Crow's stored keys"), line);
});

test("walls off here: the line says what the wall WOULD allow, never that a limit is in force", () => {
  assert.ok(sandboxLine(REGISTRY_PROFILES.paperless, "en", { walled: false }).startsWith("When walled, this add-on can: "));
  assert.ok(sandboxLine(REGISTRY_PROFILES.paperless, "es", { walled: false }).startsWith("Cuando esté aislado, este complemento puede: "));
});

test("every shipped profile has a Spanish line, and it is never the English one", () => {
  for (const [id, profile] of Object.entries(REGISTRY_PROFILES)) {
    const en = sandboxLine(profile, "en", { walled: true });
    const es = sandboxLine(profile, "es", { walled: true });
    assert.ok(en.length > 0, id);
    assert.ok(es.trim().length > 0, id);
    assert.notEqual(es, en, `${id}: the Spanish line is its own`);
    assert.ok(es.startsWith("Este complemento puede: "), `${id}: ${es}`);
    const unwalledEs = sandboxLine(profile, "es", { walled: false });
    assert.ok(unwalledEs.startsWith("Cuando esté aislado, este complemento puede: "), `${id}: ${unwalledEs}`);
    for (const english of ["use the internet", "on this computer", "its own folder"]) {
      assert.equal(es.includes(english), false, `${id}: the Spanish line never carries "${english}"`);
    }
  }
});

// ─── the field the owner has not filled in yet ─────────────────────────────

test("an undefaulted host field is pending: the modal says 'the address you enter below'", () => {
  const manifest = { id: "pending-demo", name: "Demo", env_vars: [{ name: "DEMO_URL" }, { name: "DEMO_API_TOKEN" }] };
  const profile = deriveProfile(manifest, {}, { source: "repo" });
  assert.deepEqual(pendingHostFields(manifest, profile), ["DEMO_URL"]);

  const line = sandboxLine(profile, "en", { walled: true, pendingHostFields: pendingHostFields(manifest, profile) });
  assert.ok(line.includes("reach the address you enter below"), line);
  assert.ok(!line.includes("DEMO_URL"), "a field name is not shown to the owner");
});

test("a field the owner set, a public https default, and an object network's listed names", () => {
  const manifest = { id: "pending-demo", env_vars: [{ name: "DEMO_URL" }] };
  const entry = { env: { DEMO_URL: "http://192.168.1.5:8080" }, ownerSet: ["DEMO_URL"] };
  const owned = deriveProfile(manifest, entry, { source: "repo" });
  assert.deepEqual(pendingHostFields(manifest, owned), [], "the owner's own address is not pending");

  const remote = { id: "pending-demo", env_vars: [{ name: "REMOTE_URL", default: "https://api.example.com/v1" }] };
  const covered = deriveProfile(remote, {}, { source: "repo" });
  assert.deepEqual(pendingHostFields(remote, covered), [], "an https default the internet reaches is covered");

  const listed = { id: "pending-demo", sandbox: { network: { internet: false, hosts: ["env:DEMO_HOST", "env:DEMO_BASE_URL"] } } };
  const objectNetwork = deriveProfile(listed, {}, { source: "repo" });
  assert.deepEqual(pendingHostFields(listed, objectNetwork), ["DEMO_HOST", "DEMO_BASE_URL"]);
});

// ─── the words themselves ──────────────────────────────────────────────────

test("no add-on string anywhere says 'contained' (or its Spanish stem)", () => {
  const strings = [];
  for (const group of [WALL_WORDS, SUMMARY, NOTICE, RESIDUAL_LINE, SANDBOX_LINE]) {
    for (const value of Object.values(group)) {
      if (value && typeof value === "object") strings.push(value.en, value.es);
      else if (typeof value === "string") strings.push(value);
    }
  }
  for (const part of [
    { kind: "internet" }, { kind: "local-host", label: "X" }, { kind: "network-host", host: "h", port: 1 },
    { kind: "door", id: "d" }, { kind: "own-folder" }, { kind: "oauth-dir" }, { kind: "crow-db" },
    { kind: "pending-host" }, { kind: "storage" },
  ]) strings.push(...labelPhrase(part));
  for (const profile of Object.values(REGISTRY_PROFILES)) {
    for (const lang of ["en", "es"]) {
      for (const walled of [true, false]) {
        for (const residuals of [[], [{ kind: "storage" }]]) {
          for (const pending of [[], ["DEMO_URL"]]) {
            strings.push(sandboxLine(profile, lang, { walled, residuals, pendingHostFields: pending }));
          }
        }
      }
    }
  }
  // The extensions page's own wall keys, both languages.
  for (const [key, value] of Object.entries(translations)) {
    if (!key.startsWith("extensions.wall")) continue;
    strings.push(value.en, value.es);
  }
  // The rendered status block for a mix of every word, both languages.
  const mix = [
    { id: "plain", kind: "addon", name: "plain", status: "connected", wall: { mode: "walled", source: "walled", profile: null, residuals: [] } },
    { id: "shared", kind: "addon", name: "shared", status: "connected", wall: { mode: "walled", source: "walled", profile: { crowDb: true }, residuals: [] } },
    { id: "mine", kind: "addon", name: "mine", status: "connected", wall: { mode: "unwalled", source: "owner" } },
    { id: "broken", kind: "addon", name: "broken", status: "connected", wall: { mode: "refused", source: "refused" } },
    { id: "backend-1", kind: "backend", name: "orders-db", status: "connected", wall: { mode: "unwalled", source: "owner" } },
  ];
  for (const lang of ["en", "es"]) {
    strings.push(renderAddonWallStatus({ entries: mix, env: { CROW_ADDON_WALLS_DEFAULT: "walled" }, probe: SANDBOXED, lang }));
  }
  for (const text of strings.filter((s) => typeof s === "string")) {
    assert.doesNotMatch(text, /contained/i, text);
    assert.doesNotMatch(text, /contenid/i, text);
  }
});

// ─── the install modal's data: the consent-challenge answer ────────────────

function fixture(id, manifest) {
  mkdirSync(join(FIXTURES, id), { recursive: true });
  writeFileSync(join(FIXTURES, id, "manifest.json"), JSON.stringify({ id, name: id, description: "d", type: "bundle", category: "productivity", version: "0.1.0", ...manifest }));
}

fixture("wall-demo-plain", {
  server: { command: "node", args: ["server/index.js"] },
  env_vars: [{ name: "DEMO_URL", description: "where it runs" }],
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const getJson = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json() };
};

test("consent-challenge: a non-consent bundle with a server still says required:false and carries both wall fields", async () => {
  _setAddonWallProbeForTest(() => SANDBOXED);
  await withServer(async (base) => {
    const r = await getJson(`${base}/bundles/api/consent-challenge/wall-demo-plain`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.required, false, "the wall line never turns a plain bundle into a consent one");
    assert.equal(typeof r.body.sandbox_line, "object");
    assert.equal(typeof r.body.sandbox_line.en, "string");
    assert.equal(typeof r.body.sandbox_line.es, "string");
    assert.match(r.body.sandbox_line.en, /^When walled, this add-on can: /);
    assert.ok(r.body.sandbox_line.en.includes("reach the address you enter below"), r.body.sandbox_line.en);
    // Walls are off here (the release default): the host sentence comes along.
    assert.deepEqual(r.body.sandbox_state, { en: SUMMARY.hostOff.en, es: SUMMARY.hostOff.es });
  });
});

test("consent-challenge: with walls on for this host the line claims its limit and the host sentence is dropped", async () => {
  _setAddonWallProbeForTest(() => SANDBOXED);
  process.env.CROW_ADDON_WALLS_DEFAULT = "walled";
  try {
    await withServer(async (base) => {
      const r = await getJson(`${base}/bundles/api/consent-challenge/wall-demo-plain`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.required, false);
      assert.match(r.body.sandbox_line.en, /^This add-on can: /);
      assert.equal(r.body.sandbox_state, null);
    });
  } finally {
    delete process.env.CROW_ADDON_WALLS_DEFAULT;
  }
});

test("consent-challenge: the kill switch is what the host sentence names, and a profile that cannot be built is null", async () => {
  _setAddonWallProbeForTest(() => SANDBOXED);
  process.env.CROW_ADDON_WALLS = "off";
  try {
    await withServer(async (base) => {
      const r = await getJson(`${base}/bundles/api/consent-challenge/wall-demo-plain`);
      assert.deepEqual(r.body.sandbox_state, { en: SUMMARY.killSwitch.en, es: SUMMARY.killSwitch.es });
      const missing = await getJson(`${base}/bundles/api/consent-challenge/wall-absent`);
      assert.equal(missing.status, 404);
    });
  } finally {
    delete process.env.CROW_ADDON_WALLS;
  }
});

test("consent-challenge: a walled host with no usable bwrap says 'When walled' and names the host sentence", async () => {
  _setAddonWallProbeForTest(() => NO_BWRAP);
  process.env.CROW_ADDON_WALLS_DEFAULT = "walled";
  try {
    await withServer(async (base) => {
      const r = await getJson(`${base}/bundles/api/consent-challenge/wall-demo-plain`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.sandbox_line.en, /^When walled, this add-on can: /);
      assert.deepEqual(r.body.sandbox_state, { en: SUMMARY.noBwrap.en, es: SUMMARY.noBwrap.es });
    });
  } finally {
    delete process.env.CROW_ADDON_WALLS_DEFAULT;
  }
});

test("the wall fields read the one probe: no bwrap, the kill switch, and a host that really walls", () => {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, "wall-demo-plain", "manifest.json"), "utf8"));
  const walled = { CROW_ADDON_WALLS_DEFAULT: "walled" };

  assert.equal(B.addonWallsOnHere(walled, { probe: NO_BWRAP }), false, "no bwrap here: nothing runs walled");
  const noBwrap = B.addonWallConsentFields("wall-demo-plain", manifest, walled, { probe: NO_BWRAP });
  assert.match(noBwrap.sandbox_line.en, /^When walled, this add-on can: /);
  assert.deepEqual(noBwrap.sandbox_state, { en: SUMMARY.noBwrap.en, es: SUMMARY.noBwrap.es });

  const killed = { CROW_ADDON_WALLS: "off", CROW_ADDON_WALLS_DEFAULT: "walled" };
  assert.equal(B.addonWallsOnHere(killed, { probe: SANDBOXED }), false);
  const off = B.addonWallConsentFields("wall-demo-plain", manifest, killed, { probe: SANDBOXED });
  assert.match(off.sandbox_line.en, /^When walled, this add-on can: /);
  assert.deepEqual(off.sandbox_state, { en: SUMMARY.killSwitch.en, es: SUMMARY.killSwitch.es });

  assert.equal(B.addonWallsOnHere(walled, { probe: SANDBOXED }), true);
  const on = B.addonWallConsentFields("wall-demo-plain", manifest, walled, { probe: SANDBOXED });
  assert.match(on.sandbox_line.en, /^This add-on can: /);
  assert.equal(on.sandbox_state, null);
});

// ─── "Wall it again" ───────────────────────────────────────────────────────

const fakeRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

test("POST addon-wall: a peer and a non-owner are refused, and only \"walled\" is ever accepted", async () => {
  const reconnected = [];
  B._setAddonWallReconnectForTest(async (id) => { reconnected.push(id); return { ok: true, status: "connected" }; });
  try {
    const peer = fakeRes();
    await B.handleAddonWallRequest({ params: { id: "wall-again-demo" }, body: { mode: "walled" }, crossHostAuth: { sourceInstanceId: "b".repeat(32) } }, peer);
    assert.equal(peer.code, 403);
    assert.equal(peer.body.code, "owner_only");

    B._setOwnerCheckForTest(() => false);
    const notOwner = fakeRes();
    await B.handleAddonWallRequest({ params: { id: "wall-again-demo" }, body: { mode: "walled" } }, notOwner);
    assert.equal(notOwner.code, 403);
    assert.equal(notOwner.body.code, "owner_only");

    B._setOwnerCheckForTest(() => true);
    for (const mode of ["unwalled", "off", undefined]) {
      const bad = fakeRes();
      await B.handleAddonWallRequest({ params: { id: "wall-again-demo" }, body: mode === undefined ? {} : { mode } }, bad);
      assert.equal(bad.code, 400, `mode ${String(mode)} must be refused`);
    }
    assert.deepEqual(reconnected, [], "a refused request never reaches the add-on");
    assert.equal(existsSync(join(TMP_HOME, "addon-walls.json")), false, "and writes nothing");
  } finally {
    B._setOwnerCheckForTest(null);
    B._setAddonWallReconnectForTest(null);
  }
});

test("POST addon-wall: the owner's click writes walled and reconnects that add-on", async () => {
  const reconnected = [];
  B._setOwnerCheckForTest(() => true);
  B._setAddonWallReconnectForTest(async (id) => { reconnected.push(id); return { ok: true, status: "connected" }; });
  try {
    await withServer(async (base) => {
      const r = await getJson(`${base}/bundles/api/addon-wall/wall-again-demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "walled" }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { ok: true, status: "connected" });
    });
    assert.deepEqual(reconnected, ["wall-again-demo"]);
    assert.equal(readAddonWalls(TMP_HOME).modes["wall-again-demo"], "walled");
  } finally {
    B._setOwnerCheckForTest(null);
    B._setAddonWallReconnectForTest(null);
  }
});

// ─── the panel client ──────────────────────────────────────────────────────

test("the emitted panel client survives its template literal: no backtick, and it parses", () => {
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/panels/extensions/client.js"), "utf8");
  const fnStart = src.indexOf("export function extensionsClientJS");
  assert.ok(fnStart > -1);
  const open = src.indexOf("<script>", fnStart);
  const close = src.lastIndexOf("<\\/script>");
  assert.ok(open > fnStart && close > open, "could not locate the client <script> block");
  const template = src.slice(open, close);
  assert.equal((template.match(/`/g) || []).length, 0, "a backtick inside the template would break the whole dashboard");

  for (const lang of ["en", "es"]) {
    const html = extensionsClientJS(lang);
    const body = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
    assert.doesNotThrow(() => new Function(body), `the client parses (${lang})`);
  }
});

test("the detail modal's data: the live line, the word, and who chose unwalled", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-wall-details-"));
  try {
    mkdirSync(join(home, "bundles"), { recursive: true });
    writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({ paperless: { command: "node", args: [] } }));
    const entries = [
      { id: "paperless", kind: "addon", name: "paperless", status: "connected", wall: { mode: "unwalled", source: "owner", profile: null, residuals: [] } },
      { id: "no-such-addon", kind: "addon", name: "no-such-addon", status: "connected", wall: null },
    ];
    const details = addonWallDetails({ crowHome: home, appRoot: REPO, entries });
    assert.equal(details.paperless.wordKey, "owner");
    assert.equal(details.paperless.word.en, WALL_WORDS.owner.en);
    assert.equal(details.paperless.ownerUnwalled, true);
    assert.match(details.paperless.line.en, /^When walled, this add-on can: /, "the line follows the wall's mode");
    assert.match(details.paperless.line.es, /^Cuando esté aislado, este complemento puede: /, "the Spanish line follows the wall's mode");
    assert.equal(details["no-such-addon"].line, null, "an add-on with no manifest gives no line, never a guess");
    assert.equal(details["no-such-addon"].ownerUnwalled, false);
  } finally {
    rmScratch(home);
  }
});

// ─── the two surfaces, executed ────────────────────────────────────────────

/**
 * Render the page, execute the real client against it, and return the DOM plus
 * the fetch spy. The fetch stub answers the consent-challenge with the wall
 * fields the router now sends.
 */
async function bootPanel({ addonWall = {}, consent = {}, installed = { paperless: { version: "1.0.0" } } } = {}) {
  const { parseHTML } = await import("linkedom");
  const vm = await import("node:vm");
  const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");
  const addon = { id: "paperless", name: "Paperless-ngx", description: "Documents", type: "bundle", category: "productivity", version: "1.0.0", author: "Crow", tags: [] };
  const clientHtml = extensionsClientJS("en");
  const clientJs = clientHtml.slice(clientHtml.indexOf("<script>") + "<script>".length, clientHtml.lastIndexOf("</script>"));
  const overlayHtml = clientHtml.slice(0, clientHtml.indexOf("<script>"));
  const { viewsHtml, addonRegistryScript } = buildExtensionsHTML({
    installed,
    available: [addon], collections: [], registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en",
    addonWall,
  });
  const { window, document } = parseHTML(`<html><body><div class="main-content">${viewsHtml}${addonRegistryScript}${overlayHtml}</div></body></html>`);

  const calls = [];
  const reloads = { count: 0 };
  const timers = [];
  const location = { hash: "", href: "https://crow.test/dashboard/extensions", reload() { reloads.count++; } };
  const sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const fetchStub = (url, init) => {
    calls.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    const body = String(url).includes("/consent-challenge/") ? { required: false, install_required: [], ...consent } : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const ctx = vm.createContext({
    window, document, location, sessionStorage, fetch: fetchStub, AbortController, console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  window.location = location;
  vm.runInContext(clientJs, ctx);

  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const flushTimers = () => { timers.splice(0).forEach((fn) => fn()); };
  return { document, window, calls, reloads, settle, click, flushTimers };
}

test("the install modal shows the wall line and the host sentence, as text", async () => {
  const { document, click, settle } = await bootPanel({
    installed: {},
    consent: { sandbox_line: { en: "This add-on can: use the internet", es: "Este complemento puede: usar internet" }, sandbox_state: { en: SUMMARY.hostOff.en, es: SUMMARY.hostOff.es } },
  });
  click(document.querySelector('.bundle-install[data-id="paperless"]'));
  await settle();

  const box = document.getElementById("ext-wall-lines");
  assert.ok(box, "the wall lines were inserted into the install modal");
  assert.equal(box.querySelector(".ext-wall-line").textContent, "This add-on can: use the internet");
  assert.equal(box.querySelector(".ext-wall-status-text").textContent, SUMMARY.hostOff.en);
  assert.equal(box.querySelector("script"), null, "text, never markup");
  assert.equal(document.querySelector("#modal-content .ext-install__required") !== null, true, "the rest of the form is untouched");
});

test("an installed add-on the owner set unwalled shows its line, its word, and Wall it again", async () => {
  const line = "When walled, this add-on can: use the internet; keep files in its own folder";
  const { document, click, settle, flushTimers, calls, reloads } = await bootPanel({
    addonWall: {
      paperless: { line: { en: line, es: "Cuando esté aislado, este complemento puede: usar internet" }, word: { en: WALL_WORDS.owner.en, es: WALL_WORDS.owner.es }, wordKey: "owner", ownerUnwalled: true },
    },
  });
  click(document.querySelector('.ext-installed__item[data-addon-id="paperless"]'));

  const modal = document.getElementById("modal-content");
  assert.match(modal.textContent, /What this add-on can do/);
  assert.equal(modal.querySelector(".ext-wall-line").textContent, line);
  const word = modal.querySelector(".ext-wall-word");
  assert.equal(word.textContent, WALL_WORDS.owner.en);
  assert.ok(word.classList.contains("ext-wall-word--warn"), "a word other than 'walled' is the warning style");

  const btn = modal.querySelector(".ext-wall-rearm");
  assert.ok(btn, "Wall it again is offered");
  assert.equal(btn.textContent, "Wall it again");
  click(btn);
  await settle();

  const post = calls.find((c) => c.url.includes("/bundles/api/addon-wall/"));
  assert.ok(post, "the click POSTed to the wall route");
  assert.equal(post.init.method, "POST");
  assert.deepEqual(post.body, { mode: "walled" });
  assert.ok(post.url.endsWith("/bundles/api/addon-wall/paperless"));
  flushTimers();
  assert.equal(reloads.count, 1, "the page reloads to show the add-on running walled");
});

test("an add-on whose word is 'walled' gets no warning style, and no button", async () => {
  const { document, click } = await bootPanel({
    addonWall: {
      paperless: { line: { en: "This add-on can: keep files in its own folder", es: "" }, word: { en: WALL_WORDS.walled.en, es: WALL_WORDS.walled.es }, wordKey: "walled", ownerUnwalled: false },
    },
  });
  click(document.querySelector('.ext-installed__item[data-addon-id="paperless"]'));
  const word = document.querySelector("#modal-content .ext-wall-word");
  assert.equal(word.textContent, WALL_WORDS.walled.en);
  assert.ok(!word.classList.contains("ext-wall-word--warn"));
  assert.equal(document.querySelector("#modal-content .ext-wall-rearm"), null);
});