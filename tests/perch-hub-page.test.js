// The hub IS a registered dashboard panel (panels/perch-hub.js) — that's what
// gives it a nav entry and a launcher icon — but its handler renders its own
// standalone document (perchHubDocument) instead of calling the `layout()`
// the generic panel dispatcher hands it: the panel shell is a large part of
// what made the drawer cramped on a phone. It still lives under /dashboard,
// dispatched by dashboard/index.js's generic "/dashboard/:panelId" route, so
// it inherits dashboardAuth, CSRF and the Funnel rejection the same way every
// other panel does — a bare top-level /perch would inherit none of them.
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

test("the perch panel handler serves the standalone Perch document, not the dashboard shell (the /perch redirect below is this test's own stand-in route, not the dispatcher's)", async () => {
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { default: express } = await import("express");
  const app = express();
  // No auth stub needed here — the panel manifest's handler takes no auth
  // parameter at all; dashboardAuth is applied once, by the generic
  // "/dashboard/:panelId" dispatcher in dashboard/index.js, to every
  // registered panel alike. This test exercises only the handler itself: it
  // is called directly with a context carrying NO `layout` function, so if
  // the handler ever tried to call layout() (wrapping the page in the
  // dashboard shell — the thing that made the old drawer cramped on a
  // phone) this would throw instead of silently passing. The real wiring —
  // that dashboard/index.js actually registers this panel AND actually
  // registers the /perch redirect — is pinned separately by the
  // source-level guard below; see that test's own comment for why it reads
  // source instead of firing requests.
  app.get("/dashboard/perch", (req, res) => perchHubPanel.handler(req, res, { lang: "en" }));
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

test("the perch panel manifest has the shape the registry needs: id/route match, category drives the Agents nav group, handler never calls layout()", async () => {
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  assert.equal(perchHubPanel.id, "perch", "getPanel('perch') keys off this — must match the URL segment");
  assert.equal(perchHubPanel.route, "/dashboard/perch");
  // nav-registry.js's CATEGORY_TO_GROUP maps category "ai" -> the "agents"
  // nav group, and auto-assigns any panel missing from stored
  // nav_panel_assignments by this field — this is what puts Perch in the
  // nav on an existing install with no migration.
  assert.equal(perchHubPanel.category, "ai");
  assert.equal(typeof perchHubPanel.handler, "function");
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/panels/perch-hub.js"), "utf8");
  assert.match(src, /perchHubDocument\(/, "must render the standalone Perch document");
  // Comments (this file's own header explains the layout()-avoidance rule in
  // prose) are stripped first so a doc comment mentioning "layout(" can't
  // make this pass without the code itself actually avoiding the call.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/\blayout\(/.test(codeOnly), "must never wrap perchHubDocument in the dashboard shell");
});

test("dashboard/index.js registers the perch panel exactly once and keeps the /perch short link", () => {
  // SOURCE-LEVEL guard, not a request-level one — and it has to be, not by
  // choice. dashboardAuth is a static import near the top of dashboard/index.js,
  // not the mcpAuthMiddleware parameter dashboardRouter() actually takes, so
  // there is no way to inject a pass-through auth and reach a handler at
  // runtime to prove presence/absence of registration. Worse: dashboardAuth
  // is applied to the WHOLE "/dashboard" prefix (router.use("/dashboard",
  // dashboardAuth), further down in the same file) and its isAllowedNetwork()
  // check 403s an unauthenticated off-network request BEFORE any route
  // matching happens — identically whether or not the panel is registered. A
  // request-level test therefore cannot distinguish "registered" from "not
  // registered"; a predecessor of this test proved that the hard way (round
  // 2 of this feature's review deleted only the mount line, left the /perch
  // redirect, and the prior version of this test stayed green). Reading the
  // source and asserting on it is the only thing that actually pins this.
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/index.js"), "utf8");
  assert.match(
    src,
    /import\s+perchHubPanel\s+from\s+"\.\/panels\/perch-hub\.js"/,
    "the perch panel module must be imported"
  );
  assert.match(
    src,
    /registerPanel\(perchHubPanel\)/,
    "the perch panel must be registered like every other built-in panel"
  );
  assert.match(
    src,
    /router\.get\(\s*"\/perch",[\s\S]{0,120}?\/dashboard\/perch/,
    "the top-level /perch short link must redirect to /dashboard/perch"
  );
  // Exactly ONE handler must serve /dashboard/perch: the registered panel,
  // dispatched by the generic "/dashboard/:panelId" route. The old bespoke
  // router (routes/perch-hub.js, and its mount here) must be gone entirely —
  // a leftover mount would double-register the route and this file's own
  // import list would carry a router that duplicates what the panel already
  // does.
  assert.ok(!src.includes("perchHubRouter"), "the old bespoke router must not be mounted alongside the panel");
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

test("the chat column carries the rules the renderer cannot prove", async () => {
  // Headless Chrome under setDeviceMetricsOverride has no URL bar, so
  // 100dvh === 100vh there and this rule can't be proven by rendering it —
  // it is pinned here instead. The other three are pinned directly against
  // the stylesheet text for different reasons, checked by mutation against
  // the phone reachability render test in perch-hub-render.test.js:
  // dropping #perch-composer's position:sticky OR its bottom:0, each alone,
  // does turn that render test red (it is not "close to unfailable" on that
  // pair, as an earlier version of this comment claimed) — pinned here
  // anyway so the CSS rule is documented and the failure is legible without
  // a browser. Dropping the composer's own background, or the transcript's
  // min-height:0, leaves the render test green (background is a paint
  // property invisible to getBoundingClientRect; the seeded transcript
  // in this repo's render test isn't long enough to force the shrink
  // min-height:0 guards against) — for those two, this is the only test
  // that catches a regression.
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss().replace(/\s+/g, "");
  assert.ok(css.includes("height:100vh;height:100dvh"),
    "dvh must FOLLOW vh — vh alone hides the last strip behind the browser chrome");
  assert.ok(/#perch-composer\{[^}]*position:sticky/.test(css));
  assert.ok(/#perch-composer\{[^}]*bottom:0/.test(css));
  assert.ok(/#perch-composer\{[^}]*background:/.test(css), "or the transcript shows through it");
  assert.ok(/#perch-transcript\{[^}]*min-height:0/.test(css),
    "a flex child without min-height:0 refuses to shrink and pushes the composer off-screen");
});

test("the on-screen keyboard is accounted for", async () => {
  // Asserts that BOTH listeners are actually bound, not just that the word
  // "visualViewport" appears somewhere in the source — a bare .includes()
  // still passes against `if(window.visualViewport){ var vv=window.visualViewport; }`
  // with both addEventListener calls stripped out, a dead stub. No headless
  // harness raises a keyboard, so this proves the wiring only, never the
  // on-screen behaviour: iOS Safari does not shrink the layout viewport for
  // the keyboard, so 100dvh alone stays full-height and a bottom:0 sticky
  // composer sits behind it; visualViewport is the only API that reports the
  // genuinely visible area, and resize/scroll are the events it fires when
  // that area changes.
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  assert.match(js, /vv\.addEventListener\(\s*['"]resize['"]/,
    "the resize listener must be bound, not just the visualViewport token present");
  assert.match(js, /vv\.addEventListener\(\s*['"]scroll['"]/,
    "the scroll listener must be bound, not just the visualViewport token present");
});

test("every control in the chat header carries a visible label", async () => {
  const { perchHubDocument } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubDocument("en");
  for (const id of ["perch-model", "perch-thinking", "perch-permission"]) {
    assert.ok(html.includes(`id="${id}-label"`), `${id} needs a visible label`);
    assert.ok(new RegExp(`id="${id}"[^>]*aria-labelledby="${id}-label"`).test(html));
  }
});
