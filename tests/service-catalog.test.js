import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serviceCatalog, serviceById, labelSlug, blockNameFor, cleanLabel,
  renderDerivedEnv, isServiceManifest, _resetServiceCatalogForTest,
} from "../servers/shared/service-catalog.js";
import { INTEGRATIONS } from "../servers/gateway/integrations.js";

test("catalog reads the registry bundles", () => {
  _resetServiceCatalogForTest();
  const cat = serviceCatalog();
  assert.equal(cat.length, 11);
  const names = cat.map((s) => s.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  const ha = serviceById("home-assistant");
  assert.equal(ha.group, "network");
  assert.equal(ha.server.command, "npx");
  assert.deepEqual(serviceById("zotero").requiresBins, ["uvx"]);
  assert.equal(serviceById("arxiv").crowWide, true);
  assert.equal(serviceById("github").crowWide, false);
  assert.equal(serviceById("funkwhale"), null);
});

test("isServiceManifest and injected registry", () => {
  assert.equal(isServiceManifest({ connect: {} }), true);
  assert.equal(isServiceManifest({}), false);
  const reg = { "add-ons": [{ id: "x", name: "X", connect: { method: "token", group: "paste" } }, { id: "y" }] };
  assert.deepEqual(serviceCatalog({ registry: reg }).map((s) => s.id), ["x"]);
});

test("labelSlug", () => {
  assert.equal(labelSlug("Work!"), "work");
  assert.equal(labelSlug("Señora Ü"), "senora-u");
  assert.equal(labelSlug("x".repeat(40)).length, 16);
  assert.equal(labelSlug("***"), "account");
  assert.equal(labelSlug(""), "account");
  assert.equal(labelSlug("aaaaaaaaaaaaaaa b"), "aaaaaaaaaaaaaaa");
});

test("blockNameFor and cleanLabel", () => {
  assert.equal(blockNameFor("google-workspace", "Personal"), "google-workspace-personal");
  assert.equal(cleanLabel("a‮b"), "ab");
  assert.equal(cleanLabel("  \u0000 "), null);
  assert.equal(cleanLabel("y".repeat(80)).length, 60);
});

test("renderDerivedEnv matches today's Notion envTransform and escapes", () => {
  const notion = serviceById("notion");
  const legacy = INTEGRATIONS.find((i) => i.id === "notion").envTransform({ NOTION_TOKEN: "ntn_abc123" });
  assert.deepEqual(renderDerivedEnv(notion, { NOTION_TOKEN: "ntn_abc123" }), legacy);
  const tricky = renderDerivedEnv(notion, { NOTION_TOKEN: 'a"b\\c' });
  assert.equal(JSON.parse(tricky.OPENAPI_MCP_HEADERS).Authorization, 'Bearer a"b\\c');
});

test("raw encoding strips CR/LF/NUL", () => {
  const svc = { derivedEnv: { H: { template: "Bearer ${T}", encoding: "raw" } } };
  assert.equal(renderDerivedEnv(svc, { T: "a\r\nb\0c" }).H, "Bearer abc");
});
