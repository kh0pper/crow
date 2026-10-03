/**
 * Extensions modal keychain behaviour, EXECUTED (Task 7): real markup (buildExtensionsHTML)
 * + real client (extensionsClientJS) in linkedom + node:vm, network stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto, randomInt } from "node:crypto";
import { parseHTML } from "linkedom";

import { buildExtensionsHTML } from "../servers/gateway/dashboard/panels/extensions/html.js";
import { extensionsClientJS } from "../servers/gateway/dashboard/panels/extensions/client.js";
import { generatePassword, PASSWORD_LENGTH } from "../servers/gateway/dashboard/shared/password-generator.js";

const CLIENT_HTML = extensionsClientJS("en");
const CLIENT_JS = CLIENT_HTML.slice(CLIENT_HTML.indexOf("<script>") + "<script>".length, CLIENT_HTML.lastIndexOf("</script>"));
const OVERLAY_HTML = CLIENT_HTML.slice(0, CLIENT_HTML.indexOf("<script>"));
const WIDE = "^[^\\x00-\\x1f\\x7f]{12,128}$";

const AVAILABLE = [
  { id: "demo", name: "Demo", description: "d", type: "bundle", category: "productivity", version: "1.0.0", author: "Crow", tags: [],
    env_vars: [
      { name: "DEMO_USER", description: "user", default: "admin" },
      { name: "DEMO_PASSWORD", description: "admin password", secret: true, generatable: true, propagate: false, pattern: WIDE },
      { name: "DEMO_API_KEY", description: "a third-party API key", secret: true },
      { name: "DEMO_TOKEN", description: "generated", secret: true, generate: "secret", keychain: true },
    ] },
  { id: "vaultwarden", name: "Vaultwarden", description: "vault", type: "bundle", category: "infrastructure", version: "1.1.0", author: "Crow", tags: [] },
];

function boot({ installed = {}, keychainPending = [], needsConfig = {}, vaultSecure = true, fetchImpl } = {}) {
  const { viewsHtml, addonRegistryScript, collectionsScript } = buildExtensionsHTML({
    installed, available: AVAILABLE, collections: [], needsConfig, keychainPending, vaultSecure,
    registrySource: "local", communityStores: [], bundleStatus: {}, lang: "en",
  });
  const { window, document } = parseHTML(`<html><body><div class="main-content">${viewsHtml}${addonRegistryScript}${collectionsScript}${OVERLAY_HTML}</div></body></html>`);
  const calls = [];
  const clipboard = [];
  const fetchStub = (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return Promise.resolve(fetchImpl ? fetchImpl(String(url), init) : { ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  const location = { hash: "", href: "https://crow.test/dashboard/extensions", reload() {} };
  const timers = [];
  const ctx = vm.createContext({
    window, document, location, console, AbortController,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchStub,
    crypto: webcrypto,
    navigator: { clipboard: { writeText: (s) => { clipboard.push(s); return Promise.resolve(); } } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
  });
  window.location = location;
  vm.runInContext(CLIENT_JS, ctx);
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { window, document, click, settle, calls, clipboard, timers };
}
const consentOk = (url) => (url.includes("/consent-challenge/")
  ? { ok: true, status: 200, json: () => Promise.resolve({ required: false, install_required: [] }) }
  : { ok: true, status: 200, json: () => Promise.resolve({ ok: true, job_id: "1" }) });

test("generatePassword: 24 chars, all four classes, honours a pattern, null when impossible", () => {
  const r = () => randomInt(0, 2 ** 32 - 1);
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword(PASSWORD_LENGTH, null, r);
    assert.equal(pw.length, 24);
    assert.match(pw, /[a-z]/); assert.match(pw, /[A-Z]/); assert.match(pw, /[2-9]/); assert.match(pw, /[!%*+,\-./:=?@^_]/);
    assert.doesNotMatch(pw, /[lIO01'"`$\\ #~]/, "no look-alikes, and only .env-bare-safe symbols (C2/C3)");
    assert.match(pw, /^[A-Za-z0-9_./:@%+,=^!?*-]+$/, "written to .env bare, byte-identical, never bash-expanded");
  }
  assert.match(generatePassword(24, "^[A-Za-z0-9]{24}$", r), /^[A-Za-z0-9]{24}$/, "falls back to alphanumerics");
  assert.equal(generatePassword(24, "^x$", r), null);
  assert.equal(generatePassword(24, "([", r), null, "an invalid pattern never throws");
  assert.ok(!generatePassword.toString().includes(String.fromCharCode(96)), "embeddable in the template-literal client");
});

test("C1/Q1 — Generate and the keychain box only on generatable fields; Show/Copy on every typed secret; generated fields stay hidden", async () => {
  const { document, click, settle } = boot({ fetchImpl: consentOk });
  click(document.querySelector('.bundle-install[data-id="demo"]'));
  await settle();
  assert.equal(document.querySelectorAll(".ext-secret-generate").length, 1);
  assert.ok(document.querySelector('.ext-secret-generate[data-key="DEMO_PASSWORD"]'));
  assert.equal(document.querySelector('.ext-secret-generate[data-key="DEMO_API_KEY"]'), null, "no Generate on a third-party API key");
  assert.equal(document.querySelector('.ext-keychain-save[data-key="DEMO_API_KEY"]'), null, "no keychain box on a third-party API key");
  assert.equal(document.querySelectorAll(".ext-secret-toggle").length, 2, "Show/Hide on both typed secrets");
  assert.equal(document.getElementById("env_DEMO_TOKEN"), null, "generate:secret fields are never shown");
  const box = document.querySelector('.ext-keychain-save[data-key="DEMO_PASSWORD"]');
  assert.equal(box.checked, true, "Save to Crow keychain defaults on");
  assert.equal(document.getElementById("ext-vault-save"), null, "no vault block without the vaultwarden bundle");
});

test("Generate fills a pattern-matching 24-char password and reveals it; Show/Hide toggles; Copy copies", async () => {
  const { document, click, settle, clipboard } = boot({ fetchImpl: consentOk });
  click(document.querySelector('.bundle-install[data-id="demo"]'));
  await settle();
  const input = document.getElementById("env_DEMO_PASSWORD");
  assert.equal(input.type, "password");
  click(document.querySelector(".ext-secret-generate"));
  assert.equal(input.value.length, 24);
  assert.match(input.value, new RegExp(WIDE));
  assert.equal(input.type, "text", "a generated password is shown so the user can see it");
  click(document.querySelector(".ext-secret-toggle"));
  assert.equal(input.type, "password");
  click(document.querySelector(".ext-secret-copy"));
  await settle();
  assert.deepEqual(clipboard, [input.value]);
});

test("Install sends keychain.save for checked fields; unchecking sends no keychain at all", async () => {
  let s = boot({ fetchImpl: consentOk });
  s.click(s.document.querySelector('.bundle-install[data-id="demo"]'));
  await s.settle();
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed pass with spaces & $ 1";
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  let install = s.calls.find((c) => c.url.endsWith("/bundles/api/install"));
  assert.deepEqual(install.body.keychain, { save: ["DEMO_PASSWORD"] });
  assert.equal(install.body.env_vars.DEMO_PASSWORD, "Typed pass with spaces & $ 1");

  s = boot({ fetchImpl: consentOk });
  s.click(s.document.querySelector('.bundle-install[data-id="demo"]'));
  await s.settle();
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed-Pass-123";
  s.document.querySelector('.ext-keychain-save[data-key="DEMO_PASSWORD"]').checked = false;
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  install = s.calls.find((c) => c.url.endsWith("/bundles/api/install"));
  assert.equal(install.body.keychain, undefined);
});

test("with Vaultwarden installed: the vault block appears, and only a ticked + filled block is sent", async () => {
  const s = boot({ installed: { vaultwarden: { version: "1.1.0" } }, fetchImpl: consentOk });
  s.click(s.document.querySelector('.bundle-install[data-id="demo"]'));
  await s.settle();
  const tick = s.document.getElementById("ext-vault-save");
  assert.ok(tick);
  const fields = s.document.getElementById("ext-vault-fields");
  assert.equal(fields.style.display, "none");
  tick.checked = true;
  tick.dispatchEvent(new s.window.Event("change", { bubbles: true }));
  assert.notEqual(fields.style.display, "none");
  assert.equal(s.document.getElementById("ext-vault-password").type, "password");
  assert.equal(s.document.getElementById("ext-vault-password").getAttribute("autocomplete"), "off");
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed-Pass-123";
  s.document.getElementById("ext-vault-email").value = "k@example.invalid";
  s.document.getElementById("ext-vault-password").value = "Master-PW";
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  const install = s.calls.find((c) => c.url.endsWith("/bundles/api/install"));
  assert.deepEqual(install.body.keychain, { save: ["DEMO_PASSWORD"], vault: { email: "k@example.invalid", password: "Master-PW" } });
});

test("first-view banner: Show once fetches the secret a single time and offers Copy; a spent grant explains", async () => {
  let n = 0;
  const s = boot({
    keychainPending: [{ id: 7, label: "Vaultwarden — admin token" }],
    fetchImpl: (url) => (url.endsWith("/dashboard/keychain/api/first-view")
      ? (++n === 1 ? { ok: true, status: 200, json: () => Promise.resolve({ secret: "tok-xyz" }) } : { ok: false, status: 410, json: () => Promise.resolve({ code: "first_view_spent", error: "Already shown." }) })
      : { ok: true, status: 200, json: () => Promise.resolve({}) }),
  });
  const banner = s.document.querySelector('.ext-firstview[data-entry-id="7"]');
  assert.match(banner.textContent, /Vaultwarden — admin token/);
  s.click(banner.querySelector(".ext-firstview-show"));
  await s.settle();
  assert.deepEqual(s.calls.filter((c) => c.url.endsWith("/first-view")).map((c) => c.body), [{ id: 7 }]);
  assert.equal(banner.querySelector(".ext-firstview__secret").textContent, "tok-xyz");
  assert.equal(banner.querySelector(".ext-firstview-show").hidden, true, "no second click");
  s.click(banner.querySelector(".ext-firstview-copy"));
  await s.settle();
  assert.deepEqual(s.clipboard, ["tok-xyz"]);
  s.timers.splice(0).forEach((fn) => fn());
  assert.equal(banner.querySelector(".ext-firstview__secret").textContent, "", "S2: the plaintext is wiped after 30 s");
  assert.equal(banner.querySelector(".ext-firstview__secret").hidden, true);
});

test("S4 — a Configure save shows the keychain / vault outcome before the modal moves on", async () => {
  const s = boot({
    installed: { demo: { version: "1.0.0" } },
    needsConfig: { demo: ["DEMO_PASSWORD"] },
    fetchImpl: (url) => (url.endsWith("/bundles/api/env")
      ? { ok: true, status: 200, json: () => Promise.resolve({ ok: true, needs_config: [], keychain: { saved: 1, vault: { ok: false, reason: "R" }, messages: ["Saved 1 password(s) to Crow keychain (Settings → Passwords)", "Vaultwarden save did not complete: R"] } }) }
      : { ok: true, status: 200, json: () => Promise.resolve({}) }),
  });
  s.click(s.document.querySelector('.bundle-configure[data-id="demo"]'));
  await s.settle();
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed-Pass-123";
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  const body = s.calls.find((c) => c.url.endsWith("/bundles/api/env")).body;
  assert.deepEqual(body.keychain, { save: ["DEMO_PASSWORD"] });
  assert.match(s.document.getElementById("install-status").textContent, /Vaultwarden save did not complete: R/);
});

test("R-B — Vaultwarden not on https: the vault box is disabled, no email/password fields, a note explains, and keychain.vault is never sent", async () => {
  const s = boot({ installed: { vaultwarden: { version: "1.1.0" } }, vaultSecure: false, fetchImpl: consentOk });
  assert.equal(s.document.getElementById("ext-keychain-config").getAttribute("data-vault-secure"), "0");
  s.click(s.document.querySelector('.bundle-install[data-id="demo"]'));
  await s.settle();
  const tick = s.document.getElementById("ext-vault-save");
  assert.ok(tick, "the vault block is still shown");
  assert.equal(tick.disabled, true);
  assert.equal(s.document.getElementById("ext-vault-email"), null);
  assert.equal(s.document.getElementById("ext-vault-password"), null);
  assert.match(s.document.getElementById("ext-vault-note").textContent, /Vault saving needs Vaultwarden on a secure https address/);
  s.document.getElementById("env_DEMO_PASSWORD").value = "Typed-Pass-123";
  s.click(s.document.querySelector("#modal-content .btn-primary"));
  await s.settle();
  const install = s.calls.find((c) => c.url.endsWith("/bundles/api/install"));
  assert.deepEqual(install.body.keychain, { save: ["DEMO_PASSWORD"] });
});

test("R-B — secure Vaultwarden renders data-vault-secure=1; no Vaultwarden renders 0", () => {
  const a = boot({ installed: { vaultwarden: { version: "1.1.0" } }, vaultSecure: true });
  assert.equal(a.document.getElementById("ext-keychain-config").getAttribute("data-vault-secure"), "1");
  const b = boot({ vaultSecure: true });
  assert.equal(b.document.getElementById("ext-keychain-config").getAttribute("data-vault-secure"), "0");
});
