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

test("perchHubRouter itself redirects /perch and serves /dashboard/perch when auth passes", async () => {
  const { default: perchHubRouter } = await import("../servers/gateway/routes/perch-hub.js");
  const { default: express } = await import("express");
  const app = express();
  // Auth is a pass-through stub here deliberately — this test exercises only
  // perchHubRouter's own routing (the /perch redirect it registers plus its
  // /dashboard/perch handler), not the dashboardAuth module and not whether
  // dashboard/index.js actually mounts this router. That wiring is proven
  // for real, against the real dashboardRouter, in the integration test
  // below ("dashboard/index.js really mounts...").
  app.use("/dashboard", perchHubRouter((req, res, next) => next()));
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

test("dashboard/index.js really mounts perchHubRouter and the /perch redirect — a real request against the real dashboardRouter proves it, not a stub", async () => {
  // Regression target: if someone later deleted the two lines added to
  // dashboard/index.js (the perchHubRouter mount and the /perch redirect),
  // this test must go red. Importing the REAL dashboardRouter default export
  // and firing real HTTP requests at it is what makes that true — a stub
  // route defined inline in the test would keep passing after that deletion.
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  // mcpAuthMiddleware (the constructor arg) is unrelated to dashboardAuth —
  // dashboardAuth is imported directly inside dashboard/index.js and applied
  // to the /dashboard mount regardless of what's passed here. null matches
  // how boot wires this when unified OAuth is off.
  app.use(dashboardRouter(null));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const base = "http://127.0.0.1:" + srv.address().port;
    const red = await fetch(base + "/perch", { redirect: "manual" });
    assert.equal(red.status, 302);
    assert.equal(red.headers.get("location"), "/dashboard/perch");
    // Off-network request (bare loopback fetch, no Tailscale/local-network
    // signal) — dashboardAuth's isAllowedNetwork check refuses it before the
    // session check even runs, same as the existing perch-interactive-api
    // precedent (tests/perch-interactive-routes.test.js, "an unauthenticated
    // request to a REAL perch-interactive route never reaches the handler").
    // The point isn't the exact status — it's that this is NOT a 404. A 404
    // would mean perchHubRouter was never mounted onto dashboardRouter at all.
    const page = await fetch(base + "/dashboard/perch", { redirect: "manual" });
    assert.notEqual(page.status, 404, "a 404 here means the mount in dashboard/index.js was removed");
    assert.equal(page.status, 403, "off-network, unauthenticated: dashboardAuth's network gate refuses before the handler runs");
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
