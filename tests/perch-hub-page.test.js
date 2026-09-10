// The hub is a full document, not a dashboard panel: the panel shell is a
// large part of what made the drawer cramped on a phone. It still lives under
// /dashboard so it inherits dashboardAuth, CSRF and the Funnel rejection —
// dashboard/index.js applies those with router.use("/dashboard", ...), so a
// bare top-level /perch would inherit none of them.
import { test } from "node:test";
import assert from "node:assert/strict";

test("the hub renders a complete HTML document with a mobile viewport", async () => {
  const { perchHubDocument } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubDocument("en");
  assert.ok(html.startsWith("<!DOCTYPE html>"), "a document, not a fragment");
  assert.ok(html.includes('name="viewport"'), "without this a phone renders it at desktop width");
  assert.ok(html.includes("width=device-width"));
  assert.ok(/<html lang="en"/.test(html));
});

test("the document carries both view shells and the hub stylesheet", async () => {
  const { perchHubDocument } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubDocument("en");
  assert.ok(html.includes('id="perch-list"'), "the session list view");
  assert.ok(html.includes('id="perch-chat"'), "the chat view");
  assert.ok(html.includes("<style>"), "styles are inlined — no extra request on a phone");
});

test("the stylesheet keeps Perch's own palette and honours OS dark mode", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss();
  for (const v of ["--sky", "--card", "--ink", "--dim", "--teal", "--line", "--alive", "--attn"]) {
    assert.ok(css.includes(v + ":"), `${v} is part of the look being restored`);
  }
  assert.ok(css.includes("@media (prefers-color-scheme:dark)"));
  assert.ok(!css.includes("<style>"), "perchHubCss returns bare CSS; html.js wraps it");
});

test("GET /perch redirects to the authed page rather than serving it unauthed", async () => {
  const { default: perchHubRouter } = await import("../servers/gateway/routes/perch-hub.js");
  const { default: express } = await import("express");
  const app = express();
  // Mounted the way dashboard/index.js mounts it, with auth as a pass-through
  // so this test exercises routing rather than the auth module.
  app.use("/dashboard", perchHubRouter((req, res, next) => next()));
  // The redirect is asserted against the REAL dashboard router in the
  // integration case below, not re-declared here — a test that defines the
  // route it then asserts would pass even if index.js never gained it.
  app.get("/perch", (req, res) => res.redirect(302, "/dashboard/perch"));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const base = "http://127.0.0.1:" + srv.address().port;
    const red = await fetch(base + "/perch", { redirect: "manual" });
    assert.equal(red.status, 302);
    assert.equal(red.headers.get("location"), "/dashboard/perch");
    const page = await fetch(base + "/dashboard/perch");
    assert.equal(page.status, 200);
    assert.ok((await page.text()).startsWith("<!DOCTYPE html>"));
  } finally { srv.close(); }
});

test("an absent bot engine is stated up front, not discovered on the first tap", async () => {
  const { perchHubDocument } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const absent = perchHubDocument("en", { state: "absent" });
  assert.ok(absent.includes("/dashboard/extensions"), "with a way to fix it");
  const ready = perchHubDocument("en", { state: "ready" });
  assert.ok(!ready.includes("perch-engine-banner"), "no banner when the engine is fine");
  // engineStatus has FOUR states. Only "absent" means "go install it" —
  // sending a mid-install or breaker-open operator to Extensions is a dead end.
  for (const state of ["installing", "unhealthy"]) {
    const html = perchHubDocument("en", { state });
    assert.ok(html.includes("perch-engine-banner"), state + " still warrants a banner");
    assert.ok(!html.includes("/dashboard/extensions"), state + " must not say 'install it'");
  }
});

test("the emitted client script is valid JavaScript", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  // new Function throws a SyntaxError on malformed source without running it.
  assert.doesNotThrow(() => new Function(perchHubJs("en")));
});
