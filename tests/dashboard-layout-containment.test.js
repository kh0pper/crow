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
