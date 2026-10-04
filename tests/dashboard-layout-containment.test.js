// tests/dashboard-layout-containment.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(
  new URL("../servers/gateway/dashboard/shared/layout.js", import.meta.url),
  "utf8",
);

test(".main-content sets min-width:0 so a wide descendant cannot inflate the flex column", () => {
  // Grab the .main-content rule body (the desktop one, first occurrence).
  const m = CSS.match(/\.main-content\s*\{([^}]*)\}/);
  assert.ok(m, ".main-content rule not found in layout.js");
  const body = m[1].replace(/\s+/g, "");
  assert.ok(
    /min-width:0/.test(body),
    ".main-content must declare min-width:0 (flex automatic-minimum containment). " +
      "Without it a nowrap descendant propagates its min-content width to the whole page " +
      "(the Extensions 2555px-wide-document bug).",
  );
  assert.ok(/flex:1/.test(body), "guard: this is the flex-child rule we think it is");
});

test("on phones the drawer and its backdrop out-stack panel content (map libraries use z-index up to 1000)", () => {
  // The Ramble map (Leaflet panes 200-700, controls 800-1000) drew over the open
  // sidebar at z-index 100, hiding the navigation. Inside the mobile media query
  // the drawer must sit above 1000 and the backdrop just beneath the drawer.
  const mobile = CSS.slice(CSS.indexOf("@media (max-width: 768px)"));
  const drawer = mobile.match(/\.sidebar\s*\{([^}]*)\}/);
  assert.ok(drawer, "mobile .sidebar rule not found");
  const dz = Number((drawer[1].match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(dz > 1000, `mobile drawer z-index must exceed 1000 (got ${dz})`);
  const backdrop = mobile.match(/\.sidebar-overlay\s*\{([^}]*)\}/);
  assert.ok(backdrop, "mobile .sidebar-overlay rule not found");
  const bz = Number((backdrop[1].match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(bz > 1000 && bz < dz, `backdrop must sit above panel content and below the drawer (got ${bz} vs ${dz})`);
});
