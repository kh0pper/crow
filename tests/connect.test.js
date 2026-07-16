import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

// The full set of connect.* keys the wizard depends on. t() returns the key
// string unchanged when a key is missing, so "resolves" == "value present".
const CONNECT_KEYS = [
  "connect.title", "connect.intro",
  "connect.localStdioHeading", "connect.remoteHttpHeading",
  "connect.stdioNote", "connect.oauthNote",
  "connect.cc.stdioLead", "connect.cc.remoteLead",
  "connect.cursor.lead", "connect.cline.lead",
  "connect.gemini.lead", "connect.desktop.lead",
  "connect.cloud.warning",
  "connect.moreHeading", "connect.openConnections",
  "connect.openWizard", "connect.settingsPointer",
];

test("every connect.* key has a non-empty en AND es value", () => {
  for (const k of CONNECT_KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});

import connectPanel from "../servers/gateway/dashboard/panels/connect.js";

// Invoke the panel handler with a stubbed layout (returns content for assertions).
// connections.js-style base URL needs req.protocol + req.get("host").
// parseCookies reads req.headers.cookie, so headers must always be an object.
// Minimal stub db: getLocalTokenMeta reads mcp_local_token_hash; returning no
// rows yields the empty-token state, which is what these UI tests expect.
const noTokenDb = { execute: async () => ({ rows: [] }) };
function render(host = "crow.example.ts.net:8444", cookie = "") {
  const layout = ({ content }) => content;
  const res = { send() {}, setHeader() {} };
  const req = {
    method: "GET", query: {}, headers: cookie ? { cookie } : {},
    protocol: "https", csrfToken: "csrf-x",
    get(h) { return h.toLowerCase() === "host" ? host : ""; },
  };
  return connectPanel.handler(req, res, { layout, db: noTokenDb });
}

test("panel identity: id / route / hidden", () => {
  assert.equal(connectPanel.id, "connect");
  assert.equal(connectPanel.route, "/dashboard/connect");
  assert.equal(connectPanel.hidden, true);
});

test("renders a tab per local client", async () => {
  const html = await render();
  for (const label of ["Claude Code", "Cursor", "Cline", "Gemini CLI", "Claude Desktop"]) {
    assert.ok(html.includes(label), `renders a ${label} tab`);
  }
  assert.ok(html.includes("tab-trigger"), "uses the tabs component");
});

test("embeds the request host in the MCP endpoint, not localhost", async () => {
  const html = await render("crow.example.ts.net:8444");
  assert.ok(html.includes("https://crow.example.ts.net:8444/router/mcp"),
    "embeds the request-host /router/mcp endpoint");
  assert.ok(!html.includes("localhost"), "no hardcoded localhost in the page");
});

test("cloud web clients get an honest warning, not a config", async () => {
  const html = await render();
  assert.ok(html.includes("callout-warning"), "renders a warning callout");
  assert.ok(html.includes(i18n.t("connect.cloud.warning", "en")), "cloud warning text present");
});

test("empty-token state reveals no token and offers Generate", async () => {
  const html = await render();
  // In the no-token state the wizard shows a Generate control and reveals
  // nothing. A raw token only appears after an explicit generate/rotate POST.
  assert.ok(!/Bearer\s+[0-9a-f]{64}/.test(html), "no raw token revealed at rest");
  assert.ok(html.includes('value="generate_token"'), "offers a Generate control");
});

test("honors the crow_lang=es cookie for Spanish copy", async () => {
  const es = await render("h.example:8444", "crow_lang=es");
  const en = await render("h.example:8444", "crow_lang=en");
  assert.notEqual(es, en, "ES and EN render differently");
  assert.ok(es.includes(i18n.t("connect.intro", "es")), "ES intro present");
  assert.ok(en.includes(i18n.t("connect.intro", "en")), "EN intro present");
});

import helpSetupSection from "../servers/gateway/dashboard/settings/sections/help-setup.js";

test("Help & Setup points at the connect wizard and keeps context stats", async () => {
  const db = { execute: async () => ({ rows: [] }) }; // default English
  const req = { headers: {} };
  const html = await helpSetupSection.render({ req, db, lang: "en" });
  assert.ok(html.includes("/dashboard/connect"), "links to the connect wizard");
  assert.ok(html.includes("Context Usage"), "still shows the context-usage stats heading");
  assert.ok(!html.includes("maestro.press/software/crow/platforms"),
    "the old per-platform docs list is gone");
});

test("Help & Setup wizard pointer honors Spanish (DB language = es)", async () => {
  const db = { execute: async () => ({ rows: [{ value: "es" }] }) };
  const req = { headers: {} };
  const html = await helpSetupSection.render({ req, db, lang: "en" });
  assert.ok(html.includes("/dashboard/connect"), "links to the connect wizard in ES");
  assert.ok(html.includes("Uso de Contexto"), "ES context-usage heading present");
});

import connectionsSection from "../servers/gateway/dashboard/settings/sections/connections.js";

test("Connections section points at the connect wizard", async () => {
  const req = { protocol: "https", get: (h) => (h.toLowerCase() === "host" ? "crow.example.ts.net:8444" : ""), headers: {} };
  const html = await connectionsSection.render({ req, lang: "en" });
  assert.ok(html.includes("/dashboard/connect"), "links to the connect wizard");
  assert.ok(html.includes(i18n.t("connect.openWizard", "en")), "uses the wizard link label");
});

test("token forms opt out of Turbo (one-time reveal must not be dropped)", async () => {
  // Turbo 8 intercepts form submissions and silently discards a non-redirect
  // 200 response, so the POST "succeeded" (token rotated!) but the one-time
  // reveal never rendered. data-turbo="false" makes the browser do a full
  // navigation and show the response page.
  const html = await render();
  const forms = html.match(/<form\b[^>]*method="POST"[^>]*>/g) || [];
  assert.ok(forms.length > 0, "connect panel renders at least one POST form");
  for (const form of forms) {
    assert.match(form, /data-turbo="false"/, `form missing data-turbo="false": ${form}`);
  }
});
