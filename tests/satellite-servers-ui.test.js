// Extensions › Servers UI (SAT-5, spec §4.1, §8): the real markup + the real client scripts run in
// linkedom: the Servers tab and view, satellite rows in Installed with no local actions, the
// host picker only for satellite-eligible bundles and active servers, the server install
// dialog posting to the satellite route, the cards filled from GET /api/satellites (owner text
// through textContent), and en + es strings for every key. No backticks in the client script.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";

import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { extensionsClientJS } from "../servers/gateway/dashboard/panels/extensions/client.js";
import { serversClientJS } from "../servers/gateway/dashboard/panels/extensions/servers-client.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";
import { readFileSync } from "node:fs";

const SAT = "sat_aaaaaaaaaaaaaaaaaaaa";
const AVAILABLE = [
  { id: "demo", name: "Demo", description: "d", type: "bundle", category: "infrastructure", version: "1.0.0", author: "Crow", tags: [], env_vars: [{ name: "DEMO_TOKEN", description: "Token", secret: true }] },
  { id: "plain", name: "Plain", description: "p", type: "bundle", category: "infrastructure", version: "1.0.0", author: "Crow", tags: [] },
  { id: "hosted", name: "Hosted", description: "h", type: "bundle", category: "infrastructure", version: "1.0.0", author: "Crow", tags: [] },
];
const SATS = [{ id: SAT, name: "<b>box</b>", status: "active" }, { id: "sat_bbbbbbbbbbbbbbbbbbbb", name: "down", status: "unreachable" }];
const scriptOf = (html) => html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
const before = (html) => html.slice(0, html.indexOf("<script>"));

function boot({ hash = "", fetchImpl } = {}) {
  const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
    installed: { hosted: { mode: "satellite", host: SAT, version: "1.0.0" } }, available: AVAILABLE, collections: [],
    registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en", satellites: SATS, satelliteEligibleIds: ["demo", "hosted"],
  });
  const ext = extensionsClientJS("en", { servicesUi: false });
  const srv = serversClientJS("en");
  const { window, document } = parseHTML(`<html><body><div>${viewsHtml}${addonRegistryScript}${collectionsScript}${before(srv)}${before(ext)}</div></body></html>`);
  const calls = [];
  const location = { hash, search: "", href: "https://crow.test/dashboard/extensions", reload() {} };
  const ctx = vm.createContext({
    window, document, location, console, AbortController, Promise, JSON,
    fetch: (url, init) => { calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null }); return Promise.resolve(fetchImpl ? fetchImpl(String(url), init) : { ok: true, status: 200, json: () => Promise.resolve({}) }); },
    setTimeout: () => 1, clearTimeout: () => {}, confirm: () => true, alert: () => {}, prompt: () => null,
  });
  window.location = location;
  vm.runInContext(scriptOf(srv), ctx);
  vm.runInContext(scriptOf(ext), ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  return { window, document, calls, click, flush: () => new Promise((r) => setImmediate(r)) };
}

test("markup: Servers tab + view, host blob lists active servers only, satellite row has no local actions", () => {
  const { document } = boot();
  assert.ok(document.querySelector(".ext-viewtab[data-view=servers]"));
  assert.ok(document.getElementById("ext-view-servers"));
  assert.deepEqual(JSON.parse(document.getElementById("satellite-hosts").textContent), [{ id: SAT, name: "<b>box</b>" }]);
  const row = document.querySelector(".ext-installed__item[data-addon-id=hosted]");
  assert.equal(row.getAttribute("data-satellite"), SAT);
  assert.equal(row.querySelector(".bundle-uninstall"), null);
  assert.equal(row.querySelector(".bundle-action"), null);
  assert.match(row.textContent, /On <b>box<\/b> \(server\)/);
  const reg = JSON.parse(document.getElementById("addon-registry").textContent);
  assert.equal(reg.demo._satellite, true);
  assert.equal(reg.plain._satellite, false);
});

test("host picker: offered for an eligible bundle; choosing the server opens the server install and posts to its route", async () => {
  const b = boot({ fetchImpl: () => ({ ok: false, status: 409, json: () => Promise.resolve({ error: "update_first" }) }) });
  const { document, click } = b;
  click(document.querySelector(".addon-card[data-addon-id=demo]"));
  const sel = document.querySelector("[data-testid=host-picker]");
  assert.ok(sel, "host picker shown");
  assert.deepEqual([...sel.querySelectorAll("option")].map((o) => o.value), ["", SAT]);
  sel.querySelectorAll("option")[0].removeAttribute("selected");
  sel.querySelectorAll("option")[1].setAttribute("selected", "");
  assert.equal(sel.value, SAT);
  const install = [...document.querySelectorAll("#modal-content button")].find((x) => x.textContent === "Install");
  click(install);
  const box = document.getElementById("sat-modal-box");
  assert.match(box.querySelector("h3").textContent, /Install Demo on <b>box<\/b>/);
  assert.equal(box.querySelector("#sat-env-DEMO_TOKEN").getAttribute("type"), "password");
  box.querySelector("#sat-env-DEMO_TOKEN").value = "tok";
  click([...box.querySelectorAll("button")].find((x) => x.textContent === "Install"));
  await b.flush();
  const post = b.calls.find((c) => c.url === `/api/satellites/${SAT}/bundles/install`);
  assert.deepEqual(post.body, { bundle: "demo", env: { DEMO_TOKEN: "tok" } });
  await b.flush(); await b.flush();
  assert.match(box.textContent, /Update first/);

  const plain = boot();
  plain.click(plain.document.querySelector(".addon-card[data-addon-id=plain]"));
  assert.equal(plain.document.querySelector("[data-testid=host-picker]"), null, "not for a bundle that cannot run on a server");
});

test("#servers shows the view and renders cards from GET /api/satellites with textContent", async () => {
  const list = {
    satellites: [{ id: SAT, name: "<img src=x onerror=alert(1)>", status: "active", fingerprint: "sat_aaaa-aaaa", card: {
      cert_days_left: 80, behind_by: 2, mem: { MemAvailable: 400 * 1048576, MemTotal: 1000 * 1048576, SwapFree: 0, SwapTotal: 0 },
      psi_memory_some_avg10: 1.5, disk_free_bytes: 2e10, skew_ms: 1200, polled_at: "2026-11-01T10:00:00Z",
      installed: [{ id: "hosted", version: "1.0.0", tools: { state: "unpinned" } }],
    } }],
    crow: { boot_sha: "d".repeat(40) },
  };
  const b = boot({ hash: "servers", fetchImpl: (url) => ({ ok: true, status: 200, json: () => Promise.resolve(url === "/api/satellites" ? list : {}) }) });
  assert.equal(b.document.getElementById("ext-view-servers").hidden, false);
  await b.flush(); await b.flush();
  const card = b.document.querySelector(`.sat-card[data-satellite=${SAT}]`);
  assert.ok(card, "card rendered");
  assert.equal(card.querySelector("img"), null, "owner text never becomes markup");
  assert.match(card.textContent, /2 behind this Crow/);
  assert.match(card.textContent, /80 days left/);
  assert.ok([...card.querySelectorAll("button")].some((x) => x.textContent === "Approve tools"));
  for (const label of ["Update now", "Refresh", "Rename", "Unpair", "Logs", "Restart", "Remove"]) {
    assert.ok([...card.querySelectorAll("button")].some((x) => x.textContent === label), label);
  }
});

test("client script has no backtick; every extensions.servers.* / signals.satellites.* key has en and es", () => {
  assert.equal(scriptOf(serversClientJS("en")).includes("`"), false);
  const src = readFileSync(new URL("../servers/gateway/dashboard/shared/i18n.js", import.meta.url), "utf8");
  const keys = [...new Set([...src.matchAll(/"((?:extensions\.servers|signals\.satellites)\.[A-Za-z]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 60);
  for (const k of keys) {
    assert.notEqual(t(k, "en"), k, k);
    assert.notEqual(t(k, "es"), t(k, "en"), `${k} has a Spanish string`);
  }
  const used = readFileSync(new URL("../servers/gateway/dashboard/panels/extensions/servers-client.js", import.meta.url), "utf8");
  for (const m of used.matchAll(/T\("([A-Za-z]+)"\)/g)) assert.ok(keys.includes(`extensions.servers.${m[1]}`), m[1]);
});
