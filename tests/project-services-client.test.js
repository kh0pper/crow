/**
 * Project services Task 11: Add a service and the connect sheet, EXECUTED. The real page markup
 * (projectServicesHtml), the real data block (projectServicesDataScript) and the real client
 * (projectServicesClientJs) run in linkedom + node:vm with fetch stubbed. Nothing here touches a
 * DB or ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";

import { projectServicesHtml } from "../servers/gateway/dashboard/panels/project-services/html.js";
import {
  projectServicesClientJs, projectServicesData, projectServicesDataScript, ERROR_CODES,
} from "../servers/gateway/dashboard/panels/project-services/client.js";
import { serviceById } from "../servers/shared/service-catalog.js";
import { t, translations } from "../servers/gateway/dashboard/shared/i18n.js";

const CLIENT_HTML = projectServicesClientJs();
const CLIENT_JS = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + "<script>".length, CLIENT_HTML.lastIndexOf("</script>"));
const SECRET = "test-token-7f3a9";
const UUID = "00000000-0000-4000-8000-000000000001";

function card(id, installed) {
  const s = serviceById(id);
  return {
    serviceId: s.id, name: s.name, installed, labelFrom: s.labelFrom || null,
    fields: s.fields.map((f) => ({ name: f.name, kind: f.kind, labelKey: f.label_key || null, helpKey: f.help_key || null })),
    steps: [...s.steps], stepLinks: { ...s.stepLinks },
  };
}

function page({ botsLive = false, name = "Spring", connections = [] } = {}) {
  return {
    project: { slug: "spring", name },
    connections,
    hasMembers: false,
    alsoOnCrow: [{ serviceId: "trello", name: "Trello" }],
    groups: {
      network: [card("home-assistant", true)],
      signin: [],
      paste: [card("brave-search", false), card("canvas-lms", true), card("github", true)],
      builtin: [card("obsidian", true)],
    },
    botsLive,
  };
}

function boot({ pageData = page(), lang = "en", fetchImpl } = {}) {
  const html = projectServicesHtml(pageData, lang) + projectServicesDataScript(pageData, lang);
  const { window, document } = parseHTML(`<html><body class="shell"><main>${html}</main></body></html>`);
  const calls = [];
  let reloads = 0;
  const visits = [];
  const fetchStub = (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body: init.body ?? null });
    const r = fetchImpl ? fetchImpl(String(url), init) : { status: 201, body: { ok: true, connection: {} } };
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({
      status: r.status, ok: r.status >= 200 && r.status < 300,
      json: () => (r.body === undefined ? Promise.reject(new Error("no json")) : Promise.resolve(r.body)),
    });
  };
  const location = { href: "https://crow.example.ts.net/dashboard/project/spring/services", reload() { reloads++; } };
  document.cookie = "crow_csrf=csrf-abc";
  const logs = [];
  const consoleStub = { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  window.location = location;
  window.confirm = () => true;
  const ctx = vm.createContext({ window, document, location, fetch: fetchStub, URL, console: consoleStub });
  vm.runInContext(CLIENT_JS, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
  const submit = (form) => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const sheet = () => document.querySelector("[data-svc-sheet]");
  const isOpen = () => !!sheet() && (sheet().open === true || sheet().hasAttribute("open"));
  return { window, document, click, type, submit, settle, calls, logs, sheet, isOpen, visits, reloads: () => reloads };
}

function openConnect(s, id) {
  s.click(s.document.querySelector("[data-svc-add]"));
  s.click(s.sheet().querySelector(`[data-svc-connect="${id}"]`));
  return s.sheet().querySelector("form.svc-connect");
}

test("Add sheet: title, groups in order (network falls under Paste a key without a discovery hit), Connect vs Install, Browse everything", () => {
  const s = boot();
  assert.equal(s.sheet(), null, "no sheet until + Add");
  s.click(s.document.querySelector(".svc-add"));
  assert.ok(s.isOpen());
  assert.equal(s.sheet().querySelector(".svc-sheet-title").textContent, "Add to Spring");
  assert.equal(s.sheet().querySelector("label[for=svc-q]").textContent, "What do you want Crow to work with?");
  assert.equal(s.sheet().querySelector("#svc-q").getAttribute("placeholder"), "Search services and apps");
  const groups = [...s.sheet().querySelectorAll(".svc-group")].map((g) => g.getAttribute("data-group"));
  assert.deepEqual(groups, ["paste", "builtin"], "empty groups never render; no network heading before discovery");
  const text = s.sheet().textContent;
  assert.ok(!text.includes("Found on your network"));
  assert.ok(!text.includes("Claude Code"));
  assert.ok(!text.includes("Sign in"), "the empty signin group is absent");
  const paste = [...s.sheet().querySelectorAll('[data-group="paste"] [data-svc-pick]')].map((li) => li.getAttribute("data-service"));
  assert.deepEqual(paste, ["home-assistant", "brave-search", "canvas-lms", "github"]);
  assert.equal(s.sheet().querySelector('[data-svc-connect="github"]').textContent, "Connect");
  assert.equal(s.sheet().querySelector('[data-svc-install="brave-search"]').textContent, "Install");
  assert.equal(s.sheet().querySelector('[data-svc-connect="brave-search"]'), null);
  assert.equal(s.sheet().querySelector(".svc-browse").getAttribute("href"), "/dashboard/extensions");
  assert.equal(s.sheet().querySelector(".svc-browse").textContent, "Browse everything");
});

test("'Add one here' opens the same sheet; Spanish copy comes from the page's language", () => {
  const s = boot({ lang: "es" });
  s.click(s.document.querySelector(".svc-inline[data-svc-add]"));
  assert.ok(s.isOpen());
  assert.equal(s.sheet().querySelector(".svc-sheet-title").textContent, "Añadir a Spring");
  assert.equal(s.sheet().querySelector('[data-group="paste"] .svc-label').textContent, "Pegar una clave");
  assert.equal(s.sheet().querySelector('[data-group="builtin"] .svc-label').textContent, "En este Crow");
});

test("search filters by name, case-insensitively, and hides groups left empty", () => {
  const s = boot();
  s.click(s.document.querySelector(".svc-add"));
  const q = s.sheet().querySelector("#svc-q");
  s.type(q, "git");
  const shown = [...s.sheet().querySelectorAll("[data-svc-pick]")].filter((li) => !li.hasAttribute("hidden")).map((li) => li.getAttribute("data-service"));
  assert.deepEqual(shown, ["github"]);
  assert.ok(s.sheet().querySelector('[data-group="builtin"]').hasAttribute("hidden"));
  s.type(q, "OBSID");
  assert.ok(!s.sheet().querySelector('[data-group="builtin"]').hasAttribute("hidden"));
  assert.ok(s.sheet().querySelector('[data-group="paste"]').hasAttribute("hidden"));
  s.type(q, "");
  assert.equal(s.sheet().querySelectorAll("[data-svc-pick][hidden]").length, 0);
});

test("connect sheet: numbered steps, inputs by kind, the label pre-filled, the For line, no satellites line", () => {
  const s = boot();
  const form = openConnect(s, "github");
  assert.equal(s.sheet().querySelector(".svc-sheet-title").textContent, "GitHub");
  const steps = [...form.querySelectorAll("ol.svc-steps > li")].map((li) => li.textContent);
  assert.deepEqual(steps, [1, 2, 3].map((n) => t(`services.steps.github.${n}`, "en")));
  const tok = form.querySelector('input[data-field="GITHUB_PERSONAL_ACCESS_TOKEN"]');
  assert.equal(tok.type, "password");
  assert.equal(tok.getAttribute("autocomplete"), "new-password");
  assert.equal(tok.getAttribute("name"), null, "no name: a native submit can never serialise it");
  assert.equal(tok.getAttribute("value"), null);
  assert.equal(form.querySelector(`label[for="${tok.id}"]`).textContent, "Token");
  assert.equal(form.querySelector("[data-svc-label]").value, "main");
  assert.equal(form.querySelector(".svc-for").textContent, "For: Spring · Only your bots use it");
  assert.ok(!s.sheet().textContent.includes("satellite"));
  assert.equal(form.querySelector(".svc-submit").textContent, "Connect and test");
  assert.equal(form.getAttribute("method"), "post", "never a GET form");

  const ha = openConnect(s, "home-assistant");
  assert.equal(ha.querySelector('input[data-field="HA_URL"]').type, "url");
  assert.equal(ha.querySelector('input[data-field="HA_TOKEN"]').type, "password");
  const vault = openConnect(s, "obsidian");
  const v = vault.querySelector('input[data-field="OBSIDIAN_VAULT_PATH"]');
  assert.equal(v.type, "text");
  assert.equal(v.getAttribute("autocomplete"), "off");
});

test("HA: the account name follows the typed address (host, or this Crow :port on loopback) until edited", () => {
  const s = boot();
  const form = openConnect(s, "home-assistant");
  const url = form.querySelector('input[data-field="HA_URL"]');
  const label = form.querySelector("[data-svc-label]");
  assert.equal(label.value, "", "empty until an address: the server fills it the same way");
  s.type(url, "http://ha.example.lan:8123/");
  assert.equal(label.value, "ha.example.lan");
  s.type(url, "http://127.0.0.1:8123");
  assert.equal(label.value, "this Crow :8123");
  s.type(url, "http://localhost");
  assert.equal(label.value, "this Crow :80");
  s.type(label, "home");
  s.type(url, "http://ha.example.lan:8123");
  assert.equal(label.value, "home", "an edited name is kept");
});

test("step links come only from the typed address, http(s) only; javascript: never becomes an href", () => {
  const s = boot();
  const form = openConnect(s, "home-assistant");
  const url = form.querySelector('input[data-field="HA_URL"]');
  const step1 = form.querySelector('li[data-step="services.steps.home-assistant.1"]');
  assert.equal(step1.querySelector("a"), null, "no link before an address");
  assert.equal(step1.textContent, t("services.steps.home-assistant.1", "en"));
  s.type(url, "https://ha.example.lan:8123/");
  const a = step1.querySelector("a");
  assert.equal(a.getAttribute("href"), "https://ha.example.lan:8123/profile/security");
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");
  assert.equal(a.textContent, t("services.steps.home-assistant.1", "en"));
  for (const bad of ["javascript:alert(1)", "javascript://ha.example.lan/%0aalert(1)", "data:text/html,x", "http://user:pw@ha.example.lan", "ha.example.lan", "file:///etc"]) {
    s.type(url, bad);
    assert.equal(step1.querySelector("a"), null, `no link for ${bad}`);
    for (const a2 of s.sheet().querySelectorAll("[href]")) assert.doesNotMatch(a2.getAttribute("href"), /^(javascript|data|file):/i, "never an href");
  }
  // The secret is never substituted into a link, even if a template names it.
  s.type(form.querySelector('input[data-field="HA_TOKEN"]'), SECRET);
  s.type(url, "https://ha.example.lan");
  for (const a2 of form.querySelectorAll("a")) assert.ok(!a2.getAttribute("href").includes(SECRET));
});

test("Connect and test POSTs the body with X-Crow-Csrf; the secret never reaches the URL; disabled in flight; botsLive:false says Connected and tested.", async () => {
  const s = boot({ fetchImpl: () => ({ status: 201, body: { ok: true, connection: { uuid: UUID } } }) });
  const form = openConnect(s, "github");
  const tok = form.querySelector('input[data-field="GITHUB_PERSONAL_ACCESS_TOKEN"]');
  s.type(tok, SECRET);
  s.type(form.querySelector("[data-svc-label]"), "work");
  s.submit(form);
  assert.equal(form.querySelector(".svc-submit").disabled, true, "disabled in flight");
  s.submit(form);
  await s.settle();
  assert.equal(s.calls.length, 1, "one request even on a double submit");
  const c = s.calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/dashboard/services/api/project/spring/connect?lang=en");
  assert.equal(c.headers["X-Crow-Csrf"], "csrf-abc");
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(c.body), { serviceId: "github", accountLabel: "work", values: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET } });
  assert.ok(!c.url.includes(SECRET));
  assert.equal(tok.value, "", "the typed secret is cleared once the answer is in");
  assert.ok(!s.document.documentElement.outerHTML.includes(SECRET), "not in the DOM");
  assert.equal(form.querySelector("[data-svc-ok]").textContent, "Connected and tested.");
  assert.ok(s.isOpen(), "the sheet shows the result");
  assert.deepEqual(s.logs, [], "nothing logged");
  assert.equal(s.reloads(), 0);
  s.click(s.sheet().querySelector("[data-svc-close]"));
  assert.equal(s.isOpen(), false);
  assert.equal(s.reloads(), 1, "closing after a connection re-renders the page");
});

test("botsLive:true shows the live copy", async () => {
  const s = boot({ pageData: page({ botsLive: true }) });
  const form = openConnect(s, "github");
  s.type(form.querySelector('input[data-field="GITHUB_PERSONAL_ACCESS_TOKEN"]'), SECRET);
  s.submit(form);
  await s.settle();
  assert.equal(form.querySelector("[data-svc-ok]").textContent, "Connected. Your bots can use it on their next turn.");
});

test("auth_failed shows its copy and keeps the sheet open; a retry is possible", async () => {
  let answer = { status: 400, body: { error: "auth_failed" } };
  const s = boot({ fetchImpl: () => answer });
  const form = openConnect(s, "github");
  const tok = form.querySelector('input[data-field="GITHUB_PERSONAL_ACCESS_TOKEN"]');
  s.type(tok, SECRET);
  s.submit(form);
  await s.settle();
  assert.ok(s.isOpen());
  assert.equal(form.querySelector("[data-svc-error]").textContent, "The service refused the key. Check it and try again.");
  assert.equal(form.querySelector("[data-svc-ok]").textContent, "");
  assert.equal(form.querySelector(".svc-submit").disabled, false);
  assert.equal(tok.value, "", "a refused secret is cleared too");
  answer = { status: 201, body: { ok: true, connection: {} } };
  s.type(tok, "test-token-8");
  s.submit(form);
  await s.settle();
  assert.equal(form.querySelector("[data-svc-error]").textContent, "");
  assert.equal(form.querySelector("[data-svc-ok]").textContent, "Connected and tested.");
});

test("a typed secret is kept through failures other than auth_failed, so the address or label can be fixed", async () => {
  const keep = ["unreachable", "timeout", "bad_address", "redirect", "unexpected_response", "label_taken", null];
  for (const code of keep) {
    const s = boot({ fetchImpl: () => (code ? { status: 400, body: { error: code } } : { status: 500, body: { ok: false } }) });
    const form = openConnect(s, "home-assistant");
    s.type(form.querySelector('input[data-field="HA_URL"]'), "http://ha.example.lan:8123");
    const tok = form.querySelector('input[data-field="HA_TOKEN"]');
    s.type(tok, SECRET);
    s.submit(form);
    await s.settle();
    assert.equal(tok.value, SECRET, `kept after ${code || "a 500"}`);
    assert.ok(s.isOpen());
    s.click(s.sheet().querySelector("[data-svc-close]"));
    assert.equal(tok.value, "", `closing clears it (${code || "a 500"})`);
  }
});

test("error copy: {service} and {field} filled; a 500 with no class, or no network, gets the generic line", async () => {
  const cases = [
    [{ status: 400, body: { error: "unexpected_response" } }, "It answered, but not the way GitHub should."],
    [{ status: 400, body: { error: "label_taken" } }, "You already have a GitHub account with that name in this project."],
    [{ status: 400, body: { error: "missing_field", field: "GITHUB_PERSONAL_ACCESS_TOKEN" } }, "Fill in Token."],
    [{ status: 400, body: { error: "bad_value", field: "accountLabel" } }, "Account name has characters Crow can't use."],
    [{ status: 400, body: { error: "bad_value" } }, t("services.error.generic", "en")],
    [{ status: 500, body: { ok: false } }, t("services.error.generic", "en")],
    [{ status: 502 }, t("services.error.generic", "en")],
    [new Error("offline"), t("services.error.generic", "en")],
    [{ status: 400, body: { error: "<img src=x onerror=1>" } }, t("services.error.generic", "en")],
  ];
  for (const [answer, copy] of cases) {
    const s = boot({ fetchImpl: () => answer });
    const form = openConnect(s, "github");
    s.submit(form);
    await s.settle();
    assert.equal(form.querySelector("[data-svc-error]").textContent, copy);
    assert.ok(s.isOpen());
  }
  const s = boot({ fetchImpl: () => ({ status: 400, body: { error: "missing_field", field: "GITHUB_PERSONAL_ACCESS_TOKEN" } }) });
  const form = openConnect(s, "github");
  s.submit(form);
  await s.settle();
  assert.equal(form.querySelector('input[data-field="GITHUB_PERSONAL_ACCESS_TOKEN"]').getAttribute("aria-invalid"), "true");
});

test("Back returns to the list and wipes the typed secret; closing wipes it; Turbo's cache never keeps the sheet", () => {
  const s = boot();
  let form = openConnect(s, "github");
  let tok = form.querySelector('input[data-field="GITHUB_PERSONAL_ACCESS_TOKEN"]');
  s.type(tok, SECRET);
  s.click(s.sheet().querySelector("[data-svc-back]"));
  assert.equal(tok.value, "");
  assert.ok(s.sheet().querySelector("#svc-q"), "back on the Add list");
  form = openConnect(s, "github");
  tok = form.querySelector('input[data-field="GITHUB_PERSONAL_ACCESS_TOKEN"]');
  s.type(tok, SECRET);
  s.click(s.sheet().querySelector("[data-svc-close]"));
  assert.equal(tok.value, "");
  assert.equal(s.reloads(), 0, "nothing connected: no re-render");
  form = openConnect(s, "github");
  s.type(form.querySelector('input[data-field="GITHUB_PERSONAL_ACCESS_TOKEN"]'), SECRET);
  s.document.dispatchEvent(new s.window.Event("turbo:before-cache"));
  assert.equal(s.sheet(), null, "the sheet is gone before the snapshot");
  assert.ok(!s.document.documentElement.outerHTML.includes(SECRET));
});

test("Install leaves for the extensions page (the install-then-connect sheet is a later task)", () => {
  const s = boot();
  s.click(s.document.querySelector(".svc-add"));
  s.click(s.sheet().querySelector('[data-svc-install="brave-search"]'));
  assert.equal(s.window.location.href, "/dashboard/extensions");
  assert.equal(s.isOpen(), false);
});

test("a failed Test again shows the error class's copy on the row and the answered status; a passed one re-renders", async () => {
  const conn = { uuid: UUID, serviceId: "github", name: "GitHub", accountLabel: "work", status: "active", lastTestedAt: null };
  let answer = { status: 200, body: { ok: false, status: "error", error: "auth_failed" } };
  const s = boot({ pageData: page({ connections: [conn] }), fetchImpl: () => answer });
  const row = s.document.querySelector("[data-svc-row]");
  s.click(row.querySelector("[data-svc-retest]"));
  await s.settle();
  assert.equal(s.calls[0].url, `/dashboard/services/api/connection/${UUID}/test`);
  assert.equal(s.calls[0].headers["X-Crow-Csrf"], "csrf-abc");
  assert.equal(row.querySelector(".svc-row-error").textContent, "The service refused the key. Check it and try again.");
  assert.equal(row.querySelector(".svc-pill").textContent, "Not working");
  assert.ok(row.querySelector(".svc-pill").classList.contains("svc-pill--error"));
  assert.equal(s.reloads(), 0);
  answer = { status: 400, body: { error: "not_installed" } };
  s.click(row.querySelector("[data-svc-retest]"));
  await s.settle();
  assert.equal(row.querySelector(".svc-row-error").textContent, "Install the extension first.");
  assert.equal(row.querySelectorAll(".svc-row-error").length, 1, "one line, replaced");
  answer = { status: 500, body: { ok: false } };
  s.click(row.querySelector("[data-svc-retest]"));
  await s.settle();
  assert.equal(row.querySelector(".svc-row-error").textContent, t("services.error.generic", "en"));
  answer = { status: 200, body: { ok: true, status: "active" } };
  s.click(row.querySelector("[data-svc-retest]"));
  await s.settle();
  assert.equal(s.reloads(), 1);
});

test("the data block: no value, only catalog cards and copy; safe inside HTML", () => {
  const d = projectServicesData(page({ name: "</script><script>alert(1)</script>" }), "en");
  assert.equal(d.botsLive, false);
  assert.equal(d.strings["services.connect.okPending"], "Connected and tested.");
  assert.equal(d.strings["services.connect.ok"], undefined, "the page never carries the bots-live line before bots use connections");
  assert.equal(projectServicesData(page({ botsLive: true }), "en").strings["services.connect.okPending"], undefined);
  assert.equal(d.strings["services.field.HA_TOKEN"], "Token");
  assert.equal(d.groups.network[0].stepLinks["services.steps.home-assistant.1"], "${HA_URL}/profile/security");
  assert.ok(!projectServicesDataScript(page(), "en").includes("Found on your network"), "not even in the data block");
  const html = projectServicesDataScript(page({ name: "</script><script>alert(1)</script>" }), "en");
  assert.equal(html.match(/<\/script>/g).length, 1, "the name can't close the block");
  assert.equal(html.match(/<script/g).length, 1);
  const s = boot({ pageData: page({ name: "</script><b>x</b>" }) });
  s.click(s.document.querySelector(".svc-add"));
  assert.equal(s.sheet().querySelector(".svc-sheet-title").textContent, "Add to </script><b>x</b>", "text, never markup");
  assert.equal(s.sheet().querySelector("b"), null);
});

test("source: no backtick, no dollar-brace, no storage, no console, no innerHTML in the client", () => {
  assert.ok(!CLIENT_HTML.includes("`"));
  assert.ok(!CLIENT_JS.includes("${"));
  for (const bad of ["localStorage", "sessionStorage", "indexedDB", "console.", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.ok(!CLIENT_JS.includes(bad), `client never uses ${bad}`);
  }
  // A secret input never gets a data- attribute holding its value: data-field holds the field NAME.
  const src = readFileSync(new URL("../servers/gateway/dashboard/panels/project-services/client.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /setAttribute\('data-[a-z-]+',\s*[a-z]+\.value/);
  assert.doesNotMatch(src, /setAttribute\('value'/);
});

test("copy: every error class has en + es; the generic line exists; the Add/Connect copy is the plan's exact text", () => {
  for (const c of ERROR_CODES) {
    const e = translations[`services.error.${c}`];
    assert.ok(e && e.en && e.es, c);
  }
  assert.ok(translations["services.error.generic"].en && translations["services.error.generic"].es);
  assert.equal(t("services.connect.for", "es"), "Para: {project} · Solo tus bots lo usan");
  assert.equal(t("services.connect.okPending", "es"), "Conectado y probado.");
  assert.equal(t("services.add.searchPlaceholder", "es"), "Busca servicios y apps");
  assert.equal(t("services.error.not_a_vault", "en"), "That folder isn't an Obsidian vault (no .obsidian folder inside).");
  assert.equal(translations["services.connect.satellites"], undefined, "no satellites line in this PR");
});
