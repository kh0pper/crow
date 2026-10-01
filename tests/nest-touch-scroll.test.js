/**
 * Regression: the Crow's Nest carousel wraps the whole icon grid, so a
 * `touch-action: pan-x` on it blocked every vertical touch-scroll that started
 * on the grid (phones could not scroll the Nest). Any touch-action in the Nest
 * CSS that allows horizontal panning must allow vertical panning too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nestCSS } from "../servers/gateway/dashboard/panels/nest/css.js";

test("nest CSS never declares a pan-x-only touch-action", () => {
  const css = nestCSS();
  const decls = [...css.matchAll(/touch-action\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
  for (const value of decls) {
    const tokens = value.split(/\s+/);
    if (tokens.includes("pan-x")) {
      assert.ok(tokens.includes("pan-y"), `touch-action "${value}" blocks vertical scroll — add pan-y`);
    }
  }
});

test("the carousel lets vertical touch-scroll through", () => {
  const css = nestCSS();
  const rule = css.match(/\.nest-instance-carousel\s*\{([^}]*)\}/);
  assert.ok(rule, "the carousel rule exists");
  const ta = rule[1].match(/touch-action\s*:\s*([^;]+)/);
  if (ta) assert.match(ta[1], /pan-y/);
});
