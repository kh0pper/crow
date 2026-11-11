/**
 * The API-key card's shape: the pure helpers (servers/gateway/dashboard/shared/
 * api-key-card.js), the card the Extensions page renders, and the field help the
 * Install/Configure form carries.
 *
 * What matters here is the boundary: `signup_url`, `explain` and `signup_label` come
 * from a manifest (third-party input), so the URL is re-checked at render time, the
 * texts are escaped, and a card only appears for a REQUIRED typed secret that is still
 * empty — never for an optional key, a satellite install, a generated value or a name
 * that controls how programs run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-apikey-shape-home-"));

const { safeSignupUrl, localizedText, pendingApiKeyCards, SIGNUP_URL_MAX_LENGTH } =
  await import("../servers/gateway/dashboard/shared/api-key-card.js");
const { buildExtensionsHTML } = await import("../servers/gateway/dashboard/panels/extensions/html.js");
const { formEnvVar, formEnvVars } = await import("../servers/gateway/bundle-env-form.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");

// ── safeSignupUrl ───────────────────────────────────────────────────────────────────

test("safeSignupUrl: an https address becomes a link plus the host shown beside it", () => {
  assert.deepEqual(safeSignupUrl("https://console.example.com/admin/settings/keys"), {
    href: "https://console.example.com/admin/settings/keys",
    host: "console.example.com",
  });
  assert.equal(safeSignupUrl("https://keys.example.com:8443/x").host, "keys.example.com:8443", "a port is part of the host");
  // Anything that is not a plain https address is no link at all.
  for (const bad of [
    "http://keys.example.com/",              // not https
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://user:pass@keys.example.com/",   // user info
    "https://user@keys.example.com/",
    " https://keys.example.com/",            // whitespace
    "https://keys.example.com/a b",
    "https://keys.example.com/\t",
    "https://keys.example.com/${X}",         // Compose interpolation
    `https://keys.example.com/${"a".repeat(SIGNUP_URL_MAX_LENGTH)}`,
    "",
    "keys.example.com",
    "//keys.example.com/",
    null,
    undefined,
    42,
  ]) {
    assert.equal(safeSignupUrl(bad), null, String(bad));
  }
});

// ── localizedText ───────────────────────────────────────────────────────────────────

test("localizedText: a string, { en, es }, and the fallback to en", () => {
  assert.equal(localizedText("plain"), "plain");
  assert.equal(localizedText({ en: "English", es: "Español" }, "es"), "Español");
  assert.equal(localizedText({ en: "English", es: "Español" }, "en"), "English");
  assert.equal(localizedText({ en: "English" }, "es"), "English", "a missing translation falls back to en");
  assert.equal(localizedText({ en: "English", es: "" }, "es"), "English", "an empty translation falls back too");
  for (const empty of [null, undefined, {}, { en: "" }, { es: "solo" }, "", "   ", 7]) {
    assert.equal(localizedText(empty), null, JSON.stringify(empty));
  }
});

// ── pendingApiKeyCards ──────────────────────────────────────────────────────────────

const MANIFEST = {
  id: "demo",
  name: "Demo App",
  env_vars: [
    { name: "DEMO_API_KEY", required: true, secret: true, explain: { en: "the demo key", es: "la clave demo" }, signup_url: "https://keys.example.com/" },
    { name: "DEMO_OPTIONAL_KEY", required: false, secret: true, explain: "an optional key" },
    { name: "DEMO_PLAIN", required: true, explain: "not a secret" },
    { name: "DEMO_GENERATED", required: true, secret: true, generate: "secret", explain: "minted by Crow" },
    { name: "NODE_OPTIONS", required: true, secret: true, explain: "controls how node runs" },
    { name: "DEMO_QUIET_KEY", required: true, secret: true },
  ],
};

const needsConfig = (id, keys) => ({ [id]: keys });

test("pendingApiKeyCards: a required, empty, explained typed secret gets a card", () => {
  const cards = pendingApiKeyCards({
    installed: { demo: { installedAt: "2026-11-01T00:00:00Z" } },
    manifests: { demo: MANIFEST },
    needsConfig: needsConfig("demo", ["DEMO_API_KEY", "DEMO_PLAIN", "NODE_OPTIONS", "DEMO_QUIET_KEY"]),
  });
  assert.equal(cards.length, 1, "only the one key that qualifies");
  assert.deepEqual(
    { id: cards[0].id, name: cards[0].name, envKey: cards[0].envKey, signup_url: cards[0].signup_url },
    { id: "demo", name: "Demo App", envKey: "DEMO_API_KEY", signup_url: "https://keys.example.com/" },
  );
  assert.deepEqual(cards[0].explain, { en: "the demo key", es: "la clave demo" });
});

test("pendingApiKeyCards: no card for an optional key, a still-set key, a satellite, a denied name or no manifest", () => {
  const installed = { demo: {} };
  const base = { installed, manifests: { demo: MANIFEST } };
  // Not in the page's needsConfig map: the key is not empty, so nothing to ask.
  assert.deepEqual(pendingApiKeyCards({ ...base, needsConfig: needsConfig("demo", ["DEMO_OPTIONAL_KEY", "DEMO_PLAIN"]) }), []);
  // An optional key never gets a card, even when it is empty.
  assert.deepEqual(pendingApiKeyCards({ ...base, needsConfig: needsConfig("demo", ["DEMO_OPTIONAL_KEY"]) }), []);
  // A generated one is Crow's; a denied name may never be set from a card.
  assert.deepEqual(pendingApiKeyCards({ ...base, needsConfig: needsConfig("demo", ["DEMO_GENERATED", "NODE_OPTIONS"]) }), []);
  // No `explain`: nothing to say, so Configure is where it belongs.
  assert.deepEqual(pendingApiKeyCards({ ...base, needsConfig: needsConfig("demo", ["DEMO_QUIET_KEY"]) }), []);
  // A satellite-hosted install is configured on its own box.
  assert.deepEqual(
    pendingApiKeyCards({ installed: { demo: { mode: "satellite" } }, manifests: { demo: MANIFEST }, needsConfig: needsConfig("demo", ["DEMO_API_KEY"]) }),
    [],
  );
  // No reviewed manifest: no card (and never the installed copy's word for it).
  assert.deepEqual(
    pendingApiKeyCards({ installed, manifests: { demo: null }, needsConfig: needsConfig("demo", ["DEMO_API_KEY"]) }),
    [],
  );
  assert.deepEqual(pendingApiKeyCards({ installed: {}, manifests: {}, needsConfig: {} }), []);
});

// ── the rendered card ───────────────────────────────────────────────────────────────

const CARD = {
  id: "demo",
  name: "Demo App",
  envKey: "DEMO_API_KEY",
  explain: { en: "The demo key, used for demo calls.", es: "La clave demo, usada para llamadas demo." },
  signup_url: "https://keys.example.com/get",
  signup_label: { en: "Get a demo key" },
};

function render(cards, lang = "en") {
  return buildExtensionsHTML({
    installed: Object.fromEntries(cards.map((c) => [c.id, {}])),
    available: [], collections: [], needsConfig: {}, keychainPending: [],
    registrySource: "local", communityStores: [], bundleStatus: {},
    apiKeyCards: cards, lang,
  }).viewsHtml;
}

test("the card renders a password field, a Save button and the explanation", () => {
  const html = render([CARD]);
  assert.match(html, /class="callout callout-warning ext-apikey" data-addon-id="demo" data-env-key="DEMO_API_KEY"/);
  const input = html.match(/<input class="ext-apikey-save-input"[^>]*>/);
  assert.ok(input, "the card has a key field");
  assert.match(input[0], /type="password"/);
  assert.match(input[0], /autocomplete="off"/);
  assert.match(input[0], /maxlength="1024"/);
  assert.match(html, /class="btn btn-sm btn-primary ext-apikey-save-btn">Save key</);
  assert.match(html, /The demo key, used for demo calls\./);
});

test("the signup link opens in a new tab, refuses tabnabbing, and shows its host", () => {
  const html = render([CARD]);
  const anchor = html.match(/<a class="btn btn-sm btn-secondary ext-apikey-signup"[^>]*>[^<]*<\/a>/);
  assert.ok(anchor, "the manifest's link is rendered");
  assert.match(anchor[0], /href="https:\/\/keys\.example\.com\/get"/);
  assert.match(anchor[0], /target="_blank"/);
  assert.match(anchor[0], /rel="noopener noreferrer"/);
  assert.match(anchor[0], />Get a demo key</, "the manifest's own label");
  assert.match(html, /class="ext-apikey-host"[^>]*>keys\.example\.com</, "the host is visible beside the button");
});

test("a card without a safe link still explains, and a bad URL renders no anchor", () => {
  const noLink = render([{ ...CARD, signup_url: null }]);
  assert.match(noLink, /The demo key/);
  assert.equal(noLink.includes("ext-apikey-signup"), false);
  for (const bad of ["javascript:alert(1)", "http://keys.example.com/", "https://u:p@keys.example.com/", "https://keys.example.com/${X}"]) {
    const html = render([{ ...CARD, signup_url: bad }]);
    assert.equal(html.includes("ext-apikey-signup"), false, bad);
    assert.equal(html.includes("javascript:alert"), false, bad);
  }
});

test("the manifest's text is escaped in the card, never innerHTML'd", () => {
  const html = render([{
    ...CARD,
    name: "<img src=x onerror=alert(1)>",
    explain: { en: '<script>alert("boom")</script>', es: "" },
    signup_label: { en: '"><script>alert(2)</script>' },
  }]);
  assert.equal(html.includes("<script>alert(\"boom\")</script>"), false, "the explanation is escaped");
  assert.match(html, /&lt;script&gt;alert\(&quot;boom&quot;\)&lt;\/script&gt;/);
  assert.equal(html.includes("<img src=x"), false, "the app name is escaped");
  assert.equal(html.includes('"><script>alert(2)'), false, "the label is escaped");
});

test("a card with no Spanish text shows the English one; one with Spanish shows it", () => {
  const es = render([CARD], "es");
  assert.match(es, /La clave demo, usada para llamadas demo\./);
  assert.equal(es.includes("The demo key, used for demo calls."), false);
  const fallback = render([{ ...CARD, explain: { en: "English only" } }], "es");
  assert.match(fallback, /English only/);
  // The button's default label when the manifest names none.
  const noLabel = render([{ ...CARD, signup_label: null }], "en");
  assert.match(noLabel, new RegExp(`>${t("bundles.apiKey.getKey", "en")}<`));
});

// ── the field help (Install + Configure) ────────────────────────────────────────────

test("formEnvVar carries explain, signup_url and signup_label through for the forms", () => {
  const shaped = formEnvVar({
    name: "DEMO_API_KEY",
    secret: true,
    required: true,
    explain: { en: "the demo key", es: "la clave demo" },
    signup_url: "https://keys.example.com/",
    signup_label: { en: "Get a key" },
  });
  assert.deepEqual(shaped.explain, { en: "the demo key", es: "la clave demo" });
  assert.equal(shaped.signup_url, "https://keys.example.com/");
  assert.deepEqual(shaped.signup_label, { en: "Get a key" });
  // An entry without help carries no help keys at all.
  const plain = formEnvVar({ name: "DEMO_PLAIN" });
  assert.equal(plain.explain, undefined);
  assert.equal(plain.signup_url, undefined);
  assert.equal(plain.signup_label, undefined);
});

// ── the card's save, executed (linkedom + vm, network stubbed) ──────────────────────

const CLIENT_HTML = (await import("../servers/gateway/dashboard/panels/extensions/client.js")).extensionsClientJS("en", { servicesUi: false });
const CLIENT_JS = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + "<script>".length, CLIENT_HTML.lastIndexOf("</script>"));
const OVERLAY_HTML = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));

/** Boot the page's own script over the rendered card, with a fetch stub. */
async function bootCard(html, { answer } = {}) {
  const { parseHTML } = await import("linkedom");
  const vm = (await import("node:vm")).default;
  const { window, document } = parseHTML(`<html><body><div class="main-content">${html}${OVERLAY_HTML}</div></body></html>`);
  const calls = [];
  const fetchStub = (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, method: init?.method });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer || { ok: true }) });
  };
  const ctx = vm.createContext({
    window, document, console, URL, AbortController,
    location: { hash: "", href: "https://crow.test/dashboard/extensions", reload() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: fetchStub,
    setTimeout: () => 0, clearTimeout: () => {},
  });
  window.location = ctx.location;
  vm.runInContext(CLIENT_JS, ctx);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { window, document, calls, settle };
}

function submitKey(document, window, card, value) {
  const form = card.querySelector(".ext-apikey-save");
  form.querySelector(".ext-apikey-save-input").value = value;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  return form;
}

test("the card posts the key to apikey-save, clears the field and says a restart applies it", async () => {
  const html = render([CARD]);
  const { window, document, calls, settle } = await bootCard(html, {
    answer: { ok: true, needs_restart: true, needs_config: [] },
  });
  const card = document.querySelector('.ext-apikey[data-addon-id="demo"]');
  const form = submitKey(document, window, card, "typed-by-the-operator-key");
  await settle();
  const posted = calls.find((c) => c.url.endsWith("/apikey-save"));
  assert.ok(posted, "the form posts the key");
  assert.equal(posted.method, "POST");
  assert.deepEqual(posted.body, { bundle_id: "demo", env_key: "DEMO_API_KEY", value: "typed-by-the-operator-key" });
  assert.equal(form.querySelector(".ext-apikey-save-input").value, "", "the field is cleared once saved");
  const note = card.querySelector(".ext-apikey__msg");
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, `${t("bundles.apiKey.saved", "en")} ${t("extensions.configureNeedsRestart", "en")}`);
});

test("the card shows the server's sentence on a refusal, and an empty field is not posted", async () => {
  const html = render([CARD]);
  const { window, document, calls, settle } = await bootCard(html, { answer: { ok: false, error: "This extension does not declare that setting." } });
  const card = document.querySelector('.ext-apikey[data-addon-id="demo"]');
  submitKey(document, window, card, "   ");
  await settle();
  assert.equal(calls.filter((c) => c.url.endsWith("/apikey-save")).length, 0, "a blank field never leaves the browser");
  assert.equal(card.querySelector(".ext-apikey__msg").textContent, t("bundles.apiKey.required", "en"));
  submitKey(document, window, card, "typed-by-the-operator-key");
  await settle();
  assert.equal(card.querySelector(".ext-apikey__msg").textContent, "This extension does not declare that setting.");
});

test("a service's own connect fields stay hidden from the install form", () => {
  const addon = {
    env_vars: [
      { name: "BRAVE_API_KEY", description: "Brave Search API key", required: false, secret: true, explain: "search key" },
      { name: "SERVICE_ADDRESS", description: "address" },
      { name: "SERVICE_TOKEN", description: "token", secret: true },
    ],
    connect: { method: "api-key", fields: [{ name: "SERVICE_ADDRESS", kind: "address" }, { name: "SERVICE_TOKEN", kind: "secret" }] },
  };
  assert.deepEqual(
    formEnvVars(addon, { servicesUi: true }).map((v) => v.name),
    ["BRAVE_API_KEY"],
    "the service's account fields are typed per project, in Services — not at install",
  );
  // Configure on a legacy Crow-wide install keeps them (keepAccountFields).
  assert.deepEqual(
    formEnvVars(addon, { servicesUi: true, keepAccountFields: true }).map((v) => v.name),
    ["BRAVE_API_KEY", "SERVICE_ADDRESS", "SERVICE_TOKEN"],
  );
  // With the Services UI off, the install form is exactly what it was.
  assert.deepEqual(
    formEnvVars(addon, { servicesUi: false }).map((v) => v.name),
    ["BRAVE_API_KEY", "SERVICE_ADDRESS", "SERVICE_TOKEN"],
  );
});