/**
 * Wave 1 Bug 3 regression guard: section() escapes its whole title, so any
 * caller embedding badge() HTML in the title rendered it as literal text
 * (the operator saw `Edit bot: ... <span class="badge ...">enabled</span>`).
 * The fix is the opts.titleHtml escape hatch — default path stays escaped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { section, badge } from "../servers/gateway/dashboard/shared/components.js";

test("section() escapes the plain title (default path unchanged)", () => {
  const html = section('<b x="1">t</b>', "c");
  assert.ok(html.includes("&lt;b"), "title markup must be escaped");
  assert.ok(!html.includes('<b x="1">'), "raw title markup must not survive");
});

test("section() renders opts.titleHtml raw — badge markup survives", () => {
  const html = section("", "c", { titleHtml: `Edit bot: demo ${badge("enabled", "connected")}` });
  assert.ok(
    html.includes('<span class="badge badge-connected">enabled</span>'),
    "badge markup must render, not display as text"
  );
});

test("bot editor heading uses titleHtml (regression: badge rendered as text)", () => {
  const src = readFileSync(new URL("../servers/gateway/dashboard/panels/bot-builder/editor.js", import.meta.url), "utf8");
  assert.ok(src.includes("titleHtml"), "editor.js must pass the badge via opts.titleHtml, never via the escaped title arg");
});
