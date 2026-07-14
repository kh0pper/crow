// tests/login-password-toggle.test.js
//
// Item 4 PR2, F-ONBOARD-4 — show/hide-password toggle on the setup, login, and
// reset forms (shared/layout.js). These auth pages are outside the Turbo shell,
// so a tiny inline <script> is the accepted mechanism. Explicitly asserts NO
// paste blocking exists anywhere on these pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";
import { renderLogin, renderResetForm } from "../servers/gateway/dashboard/shared/layout.js";

const pages = {
  setup: renderLogin({ isSetup: true, lang: "en" }),
  login: renderLogin({ lang: "en" }),
  reset: renderResetForm({ token: "tok", lang: "en" }),
};

test("login.showPassword resolves in en AND es", () => {
  const entry = i18n.translations["login.showPassword"];
  assert.ok(entry, "missing translations entry for login.showPassword");
  assert.ok(entry.en && entry.en.trim(), "missing/empty en value");
  assert.ok(entry.es && entry.es.trim(), "missing/empty es value");
});

for (const [name, html] of Object.entries(pages)) {
  test(`${name} page: password fields carry a show/hide toggle`, () => {
    assert.match(html, /type="password"/, "page has a password field");
    assert.match(html, /class="pw-toggle"/, "toggle control present");
    assert.match(html, /data-pw/, "password inputs are tagged for the toggle script");
    assert.ok(html.includes(i18n.t("login.showPassword", "en")), "toggle uses the i18n label");
    assert.match(html, /<script>[\s\S]*pw-toggle[\s\S]*<\/script>/, "inline toggle script present");
  });

  test(`${name} page: no paste blocking anywhere`, () => {
    assert.doesNotMatch(html, /onpaste/i, "no onpaste attribute");
    assert.doesNotMatch(html, /preventDefault\(\)[^]*paste|paste[^]*preventDefault\(\)/i,
      "no paste suppression in scripts");
  });
}

test("toggle flips type between password and text (script wiring)", () => {
  // The script must set input type from the checkbox state — both directions.
  const html = pages.login;
  assert.match(html, /'text'\s*:\s*'password'|"text"\s*:\s*"password"/,
    "script switches between text and password");
});

test("Spanish pages use the Spanish toggle label", () => {
  const es = renderLogin({ lang: "es" });
  assert.ok(es.includes(i18n.t("login.showPassword", "es")), "ES label present");
});
