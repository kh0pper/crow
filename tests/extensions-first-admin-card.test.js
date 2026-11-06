/**
 * N3-4 phase 1 — the "Finish <app>'s setup now" card on the Extensions page,
 * EXECUTED: real markup (buildExtensionsHTML) + real client (extensionsClientJS)
 * in linkedom + node:vm, network stubbed.
 *
 * Fails on the code before this change: buildExtensionsHTML had no
 * `firstAdminPending` input, rendered no such card, and the client had no Done
 * button to press — an install of uptime-kuma told the operator nothing beyond
 * "Installed: Uptime Kuma".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { parseHTML } from "linkedom";

import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { extensionsClientJS } from "../servers/gateway/dashboard/panels/extensions/client.js";
import { pendingFirstAdminNotices } from "../servers/gateway/dashboard/shared/first-admin.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const CLIENT_HTML = extensionsClientJS("en", { servicesUi: false });
const CLIENT_JS = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + "<script>".length, CLIENT_HTML.lastIndexOf("</script>"));
const OVERLAY_HTML = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));

const INSTALL = "2026-11-01T10:00:00.000Z";
const AVAILABLE = [
  { id: "kuma", name: "Uptime Kuma", description: "d", type: "bundle", category: "infrastructure", version: "1.0.1", author: "Crow", tags: [] },
  { id: "eye", name: "motionEye", description: "d", type: "bundle", category: "cameras", version: "0.44.1", author: "Crow", tags: [] },
  { id: "flux", name: "Miniflux", description: "d", type: "bundle", category: "media", version: "1.0.7", author: "Crow", tags: [] },
  { id: "dx", name: "Dozzle", description: "d", type: "bundle", category: "infrastructure", version: "1.0.2", author: "Crow", tags: [] },
  { id: "stash", name: "Unsloth Studio", description: "d", type: "bundle", category: "ai", version: "1.0.2", author: "Crow", tags: [] },
];
const MANIFESTS = {
  kuma: { id: "kuma", name: "Uptime Kuma", webUI: { port: 3007, path: "/", label: "Uptime Kuma" }, firstAdmin: { mode: "finish-setup" } },
  eye: { id: "eye", name: "motionEye", webUI: { port: 8765, path: "/", label: "motionEye" }, firstAdmin: { mode: "default-login", user: "admin", note: "It starts with an empty password; set one now." } },
  flux: { id: "flux", name: "Miniflux", webUI: { port: 8085, path: "/", label: "Miniflux" }, firstAdmin: { mode: "crow" }, env_vars: [{ name: "X", generate: "secret", keychain: true, secret: true }] },
  dx: { id: "dx", name: "Dozzle", webUI: { port: 8095, path: "/", label: "Dozzle" }, firstAdmin: { mode: "none" } },
  stash: { id: "stash", name: "Unsloth Studio", webUI: { port: 3075, path: "/", label: "Unsloth Studio", proxyMode: "direct" }, firstAdmin: { mode: "finish-setup" } },
};

/** Render the page with these installed bundles; `live` = proxy routes this process mounted. */
function render({ ids = Object.keys(MANIFESTS), done = {}, live = ["kuma", "eye", "flux", "dx", "stash"], lang = "en" } = {}) {
  const installed = Object.fromEntries(ids.map((id) => [id, { version: "1.0.0", installedAt: INSTALL }]));
  const firstAdminPending = pendingFirstAdminNotices({
    installed,
    manifests: Object.fromEntries(ids.map((id) => [id, MANIFESTS[id]])),
    done,
    liveProxyIds: live,
  });
  return buildExtensionsHTML({
    installed, available: AVAILABLE, collections: [], needsConfig: {}, keychainPending: [],
    registrySource: "local", communityStores: [], bundleStatus: {}, firstAdminPending, lang,
  }).viewsHtml;
}

/** Boot the page's client JS over that markup (linkedom + vm), with a fetch stub. */
function boot(html, { fetchImpl } = {}) {
  const { window, document } = parseHTML(`<html><body><div class="main-content">${html}${OVERLAY_HTML}</div></body></html>`);
  const calls = [];
  const fetchStub = (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, method: init?.method });
    const answer = fetchImpl ? fetchImpl(String(url), init) : { ok: true, status: 200, json: () => Promise.resolve({}) };
    return Promise.resolve(answer);
  };
  const location = { hash: "", href: "https://crow.test/dashboard/extensions", reload() {} };
  const ctx = vm.createContext({
    window, document, location, console, AbortController,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchStub,
    crypto: webcrypto,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    setTimeout: () => 0, clearTimeout: () => {},
  });
  window.location = location;
  vm.runInContext(CLIENT_JS, ctx);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { window, document, calls, settle, click: (el) => el.dispatchEvent(new window.Event("click", { bubbles: true })) };
}

test("a finish-setup install shows the card: title, the claim warning, and a link to the app", () => {
  const html = render({ ids: ["kuma"] });
  const { document } = boot(html);
  const card = document.querySelector('.ext-firstadmin[data-addon-id="kuma"]');
  assert.ok(card, "the card is rendered");
  assert.match(card.textContent, /Finish Uptime Kuma's setup now/);
  assert.match(card.textContent, /Until you do, anyone or anything on this machine can claim Uptime Kuma's admin account\./);
  const open = card.querySelector(".ext-firstadmin-open");
  assert.equal(open.getAttribute("href"), "/proxy/kuma/", "the Nest tile's own link rule");
  assert.ok(card.querySelector(".ext-firstadmin-done"), "and the operator's Done button");
});

test("a default-login install names the default user and appends the note", () => {
  const { document } = boot(render({ ids: ["eye"] }));
  const card = document.querySelector('.ext-firstadmin[data-addon-id="eye"]');
  assert.ok(card);
  assert.match(card.textContent, /motionEye starts with a known login \(user admin\)\. Change the password now\./);
  assert.match(card.textContent, /It starts with an empty password; set one now\./);
});

test("no card for crow or none (nothing to claim, or Crow already made the account)", () => {
  const { document } = boot(render({ ids: ["flux", "dx"] }));
  assert.equal(document.querySelectorAll(".ext-firstadmin").length, 0);
});

test("the card appears beside the existing first-view banner, above the tabs", () => {
  const html = render({ ids: ["kuma"] });
  const at = html.indexOf('class="callout callout-warning ext-firstadmin"');
  const tabs = html.indexOf('class="ext-viewtabs"');
  assert.ok(at > -1 && tabs > at, "the card is rendered with the page-level notices");
});

test("restart-pending wording appears when the proxy route is not live yet, and no dead link is offered", () => {
  // kuma was installed into a RUNNING gateway: no /proxy/kuma route exists yet.
  const { document } = boot(render({ ids: ["kuma"], live: [] }));
  const card = document.querySelector('.ext-firstadmin[data-addon-id="kuma"]');
  assert.ok(card);
  assert.match(card.textContent, /Restart Crow first, then open it/);
  assert.equal(card.querySelector(".ext-firstadmin-open"), null, "never a link that cannot work yet");
});

test("a direct-mode app needs no proxy route, so it links out immediately", () => {
  const { document } = boot(render({ ids: ["stash"], live: [] }));
  const card = document.querySelector('.ext-firstadmin[data-addon-id="stash"]');
  assert.ok(card);
  assert.doesNotMatch(card.textContent, /Restart Crow first/);
  const open = card.querySelector(".ext-firstadmin-open");
  assert.equal(open.getAttribute("href"), "/dashboard/extensions", "no-JS fallback, as the Nest tile");
  assert.match(open.getAttribute("onclick") || "", /location\.hostname/, "the host is filled in by the browser");
  assert.match(open.getAttribute("onclick") || "", /3075/);
});

test("Done clears the card and records it for this bundle", async () => {
  const { document, calls, settle, click } = boot(render({ ids: ["kuma"] }), {
    fetchImpl: () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, bundle_id: "kuma", install: INSTALL }) }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="kuma"]');
  click(card.querySelector(".ext-firstadmin-done"));
  await settle();
  const posted = calls.find((c) => c.url.endsWith("/first-admin-done"));
  assert.ok(posted, "the Done press posts the operator's word");
  assert.equal(posted.method, "POST");
  assert.deepEqual(posted.body, { bundle_id: "kuma" });
  assert.equal(document.querySelectorAll(".ext-firstadmin").length, 0, "the card is gone");
});

test("a failed Done keeps the card and re-enables the button", async () => {
  const { document, settle, click } = boot(render({ ids: ["kuma"] }), {
    fetchImpl: () => ({ ok: false, status: 500, json: () => Promise.resolve({ error: "nope" }) }),
  });
  const card = document.querySelector('.ext-firstadmin[data-addon-id="kuma"]');
  const btn = card.querySelector(".ext-firstadmin-done");
  click(btn);
  await settle();
  assert.equal(btn.disabled, false);
  assert.equal(document.querySelectorAll(".ext-firstadmin").length, 1, "the card stays: nothing was recorded");
});

test("a Done already recorded for this install renders no card", () => {
  const { document } = boot(render({ ids: ["kuma"], done: { kuma: INSTALL } }));
  assert.equal(document.querySelectorAll(".ext-firstadmin").length, 0);
});

test("the card is escaped and translated (es)", () => {
  const html = render({ ids: ["kuma"], lang: "es" });
  assert.ok(html.includes(t("bundles.firstAdmin.title", "es").replace("{name}", "Uptime Kuma")));
  assert.ok(html.includes(t("bundles.firstAdmin.done", "es")));
  const hostile = buildExtensionsHTML({
    installed: { x: { installedAt: INSTALL } },
    available: [],
    collections: [],
    needsConfig: {},
    keychainPending: [],
    registrySource: "local",
    communityStores: [],
    bundleStatus: {},
    firstAdminPending: [{
      id: "x", name: "<img src=x onerror=alert(1)>", mode: "finish-setup", user: null,
      note: "<script>alert(2)</script>",
      link: { href: '/proxy/x/"><script>alert(3)</script>', onclick: "", proxyMode: "subpath", path: "/" },
      restartPending: false,
    }],
    lang: "en",
  }).viewsHtml;
  assert.ok(!/<img src=x/.test(hostile), "the app name is escaped");
  assert.ok(!/<script>alert\(2\)/.test(hostile), "the note is escaped");
  assert.ok(!hostile.includes('"><script>alert(3)'), "the link is escaped");
});