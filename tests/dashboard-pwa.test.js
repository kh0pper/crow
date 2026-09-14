/**
 * PR-F — dashboard PWA shell integrity (perch parity audit item 22 polish,
 * 2026-09-13). The dashboard was already installable (bb1cb865 shipped the
 * manifest + SW + push); this file pins the parity gaps closed since:
 *
 *   1. manifest: scoped to /dashboard, id, real 192/512 PNG icons + a
 *      maskable variant, every referenced icon file actually ships;
 *   2. sw.js: the authenticated perch API and the SSE /events stream pass
 *      through with NO interception (never cache authed responses; never
 *      pipe an event stream through respondWith);
 *   3. the rendered dashboard head carries apple-mobile-web-app-title and a
 *      PNG apple-touch-icon (iOS renders an SVG touch icon as a blank tile).
 *
 * All static-asset assertions — no server, no DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PUB = join(REPO, "servers/gateway/public");
const manifest = JSON.parse(readFileSync(join(PUB, "manifest.json"), "utf8"));

test("manifest: standalone app scoped to the dashboard, start_url inside scope", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.scope, "/dashboard");
  assert.equal(manifest.start_url, "/dashboard/nest");
  assert.ok(manifest.start_url.startsWith(manifest.scope), "start_url must live inside scope");
  assert.equal(manifest.id, "/dashboard");
});

test("manifest: real PNG sizes plus a maskable variant (pi-lab parity)", () => {
  const pngs = manifest.icons.filter((i) => i.type === "image/png");
  assert.ok(pngs.some((i) => i.sizes === "192x192"), "a 192px PNG icon");
  assert.ok(pngs.some((i) => i.sizes === "512x512"), "a 512px PNG icon");
  const maskable = pngs.filter((i) => (i.purpose || "").split(/\s+/).includes("maskable"));
  assert.ok(maskable.some((i) => i.sizes === "512x512"), "a 512px maskable PNG icon");
});

test("manifest: every referenced icon file ships under public/", () => {
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(PUB, icon.src)), icon.src + " must exist under servers/gateway/public/");
  }
});

test("sw.js: perch-api and SSE routes pass through, unintercepted, before any dashboard branch", () => {
  const sw = readFileSync(join(PUB, "sw.js"), "utf8");
  const perch = sw.indexOf('"/dashboard/perch-api/"');
  assert.ok(perch > 0, "explicit /dashboard/perch-api/ bypass present");
  assert.ok(/destination === "eventsource"/.test(sw), "eventsource-destination bypass present");
  assert.ok(/text\/event-stream/.test(sw), "Accept: text/event-stream bypass present");
  // The perch routes live under the /dashboard/ substring too — a bypass
  // ordered AFTER that branch would never run.
  const dashBranch = sw.indexOf('includes("/dashboard/")');
  assert.ok(dashBranch > 0, "the dashboard network-only branch still exists");
  assert.ok(perch < dashBranch, "the bypasses precede the dashboard branch");
  // No respondWith may sit between a bypass return and the next branch —
  // guard the shape, not just the strings: every bypass line ends in return.
  for (const line of sw.slice(perch - 400, dashBranch).split("\n")) {
    if (/perch-api|eventsource|event-stream/.test(line) && !line.trim().startsWith("//")) {
      assert.match(line, /return;?\s*$/, "bypass must return without respondWith: " + line.trim());
    }
  }
});

test("rendered head: install metas — apple title + PNG apple-touch-icon", async () => {
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const html = renderLayout({ title: "PWA test", content: "<p>x</p>", activePanel: "nest", panels: [], scripts: "" });
  assert.ok(html.includes('<meta name="apple-mobile-web-app-title" content="Crow">'));
  assert.ok(html.includes('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"'));
  assert.ok(html.includes('rel="manifest" href="/manifest.json"'));
});
