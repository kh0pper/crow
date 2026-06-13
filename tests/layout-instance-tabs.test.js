/**
 * Wave 1 Bug 2 regression guard: the instance-tabs strip must NOT be
 * data-turbo-permanent. Turbo Drive keeps the FIRST-rendered permanent
 * element across navigations; only the nest handler populates the strip,
 * so a permanent strip meant any other-panel -> nest navigation kept the
 * cached EMPTY strip and the operator saw no connected instances.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";

const base = {
  title: "T",
  content: "<p>x</p>",
  activePanel: "nest",
  panels: [{ id: "nest", name: "Nest", icon: "health", route: "/dashboard/nest", navOrder: 1 }],
  lang: "en",
};
const tabs = [
  { id: "local", name: "Crow", status: "online", isLocal: true },
  { id: "abc123def", name: "Grackle", status: "online", isLocal: false },
];

test("instance strip is NOT data-turbo-permanent", () => {
  const html = renderLayout({ ...base, instanceTabs: tabs });
  const strip = html.match(/<nav id="crow-instance-tabs"[^>]*>/);
  assert.ok(strip, "strip nav element must render");
  assert.ok(
    !strip[0].includes("data-turbo-permanent"),
    "strip must not be turbo-permanent (pins the first-rendered empty strip across navs)"
  );
});

test("strip populated + visible when instanceTabs passed", () => {
  const html = renderLayout({ ...base, instanceTabs: tabs });
  assert.ok(html.includes('data-instance-id="abc123def"'), "peer tab missing");
  assert.ok(html.includes("Grackle"), "peer name missing");
  const bodyTag = html.match(/<body[^>]*>/)[0];
  assert.ok(!bodyTag.includes("unified-off"), "strip must be visible with >1 tabs");
});

test("strip empty + hidden via unified-off when instanceTabs absent", () => {
  const html = renderLayout(base);
  assert.match(html, /<nav id="crow-instance-tabs"[^>]*><\/nav>/, "strip must render as empty shell");
  const bodyTag = html.match(/<body[^>]*>/)[0];
  assert.ok(bodyTag.includes("unified-off"), "strip must be hidden without tabs");
});
