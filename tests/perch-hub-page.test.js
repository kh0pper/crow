// The hub is a full document, not a dashboard panel: the panel shell is a
// large part of what made the drawer cramped on a phone. It still lives under
// /dashboard so it inherits dashboardAuth, CSRF and the Funnel rejection —
// dashboard/index.js applies those with router.use("/dashboard", ...), so a
// bare top-level /perch would inherit none of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

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
  // dashboard/index.js actually mounts this router. That wiring is pinned
  // separately by the source-level guard below, "dashboard/index.js source
  // mounts perchHubRouter and registers the /perch redirect" — see that
  // test's own comment for why it reads source instead of firing requests.
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

test("dashboard/index.js source mounts perchHubRouter and registers the /perch redirect", () => {
  // SOURCE-LEVEL guard, not a request-level one — and it has to be, not by
  // choice. dashboardAuth is a static import near the top of dashboard/index.js,
  // not the mcpAuthMiddleware parameter dashboardRouter() actually takes, so
  // there is no way to inject a pass-through auth and reach a handler at
  // runtime to prove presence/absence of either wiring. Worse: dashboardAuth
  // is applied to the WHOLE "/dashboard" prefix (router.use("/dashboard",
  // dashboardAuth), further down in the same file) and its isAllowedNetwork() check 403s an
  // unauthenticated off-network request BEFORE any route matching happens —
  // identically whether or not perchHubRouter is mounted underneath it. A
  // request-level test therefore cannot distinguish "mounted" from "not
  // mounted"; it was tried and proved not to (round 2 of this task's review
  // deleted only the mount line, left the /perch redirect, and the prior
  // version of this test stayed green). Reading the source and asserting on
  // it is the only thing that actually pins these two lines.
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/index.js"), "utf8");
  assert.match(
    src,
    /router\.use\(\s*"\/dashboard",\s*perchHubRouter\(dashboardAuth\)\s*\)/,
    "perchHubRouter must be mounted onto the /dashboard prefix"
  );
  assert.match(
    src,
    /router\.get\(\s*"\/perch",[\s\S]{0,120}?\/dashboard\/perch/,
    "the top-level /perch short link must redirect to /dashboard/perch"
  );
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
