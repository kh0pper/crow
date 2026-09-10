// The hub IS a registered dashboard panel (panels/perch-hub.js) — that's what
// gives it a nav entry and a launcher icon — and it renders through the
// dashboard shell's layout(), exactly like every other panel. It used to
// render its own standalone document (perchHubDocument) instead, deliberately
// bypassing layout() — that's what made the crow sidebar vanish on this page
// (the operator regression this file now pins the fix for). It still lives
// under /dashboard, dispatched by dashboard/index.js's generic
// "/dashboard/:panelId" route, so it inherits dashboardAuth, CSRF and the
// Funnel rejection the same way every other panel does — a bare top-level
// /perch would inherit none of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

test("perchHubContent renders a shell-embeddable fragment, not a standalone document", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  // These are the exact properties the OLD perchHubDocument() had (doctype,
  // <html lang>, its own viewport meta) — asserting their ABSENCE pins that
  // the shell now supplies the document, not this function. A leftover
  // <!DOCTYPE>/<html> here would mean two documents nested inside one
  // response.
  assert.ok(!html.startsWith("<!DOCTYPE html>"), "the shell supplies the document now");
  assert.ok(!/<html[\s>]/.test(html), "must not open its own <html>");
  assert.ok(!/<head[\s>]/.test(html), "must not open its own <head>");
  assert.ok(!/name="viewport"/.test(html), "the shell's own viewport meta covers this now");
  assert.ok(html.includes('id="perch-hub-root"'), "everything Perch-specific is scoped under this root");
  assert.ok(html.includes("<style>"), "styles are still inlined — no extra request on a phone");
});

test("the content carries both view shells and the hub stylesheet", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
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

test("every Perch selector is scoped under #perch-hub-root, not leaking onto the shared shell", async () => {
  // The generic-sounding class names Perch reuses (.title/.meta/.state/
  // .field/button/input/textarea/h2/header) would otherwise restyle the
  // sidebar, the hamburger, and every other panel once this CSS ships
  // inside the shared dashboard document instead of its own standalone
  // page. A bare `button{` or `header{` rule anywhere in the sheet is
  // exactly that leak. Anchored on line-start (`(^|\n)\s*`): in this file
  // every SCOPED occurrence has "#perch-hub-root " (or similar) BEFORE the
  // tag name on the same line, so only a genuinely bare, line-leading
  // selector matches — a naive "preceding char isn't a hyphen" check would
  // false-positive on "#perch-hub-root button{" itself (preceded by a
  // space), which is exactly why this isn't written that way.
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss();
  const BARE_PATTERNS = [
    [/(^|\n)\s*button\s*\{/, "button{"],
    [/(^|\n)\s*button\.primary\s*\{/, "button.primary{"],
    [/(^|\n)\s*button\.quiet\s*\{/, "button.quiet{"],
    [/(^|\n)\s*header\s*\{/, "header{"],
    [/(^|\n)\s*h2\s*\{/, "h2{"],
    [/(^|\n)\s*input\s*[,{]/, "input (unscoped)"],
    [/(^|\n)\s*textarea\s*\{/, "textarea{"],
    [/(^|\n)\s*\*\s*\{/, "*{"],
    [/(^|\n)\s*a:focus-visible/, "a:focus-visible (unscoped)"],
    [/(^|\n)\s*\.hub-split\s*\{/, ".hub-split{ (unscoped)"],
  ];
  const offenders = BARE_PATTERNS.filter(([re]) => re.test(css)).map(([, label]) => label);
  assert.deepEqual(offenders, [], `unscoped selector(s) found: ${offenders.join(", ")}`);
});

test("the perch panel handler renders through the dashboard shell — the sidebar survives, unlike the old standalone document", async () => {
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { default: express } = await import("express");
  const app = express();
  // Minimal stand-in for dashboard/index.js's real panel dispatcher: enough
  // of a `layout` to prove the panel actually calls it and the resulting
  // page carries the shell's chrome, without pulling in the full
  // dispatcher's tamagotchi/companion/nav-group machinery this test doesn't
  // need. dashboard/index.js's own registration wiring is pinned separately,
  // below.
  app.get("/dashboard/perch", async (req, res) => {
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en" });
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) res.type("html").send(html);
  });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const base = "http://127.0.0.1:" + srv.address().port;
    const page = await fetch(base + "/dashboard/perch");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.startsWith("<!DOCTYPE html>"), "the shell supplies the document now");
    assert.ok(html.includes('class="sidebar'), "the crow nav sidebar must be present — this is the regression this feature fixes");
    assert.ok(html.includes('id="perch-hub-root"'), "and the panel's own content must still be there, inside the shell");
  } finally { srv.close(); }
});

test("the perch panel manifest has the shape the registry needs: id/route match, category drives the Agents nav group, handler renders through layout()", async () => {
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
  assert.match(src, /perchHubContent\(/, "must render Perch's content");
  // Comments (this file's own header explains the layout() rule in prose)
  // are stripped first so a doc comment mentioning "layout(" can't make
  // this pass without the code itself actually calling it.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(codeOnly, /\blayout\(/, "must render through the dashboard shell, like every other panel");
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
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const absent = perchHubContent("en", { state: "absent" });
  assert.ok(absent.includes("/dashboard/extensions"), "with a way to fix it");
  const ready = perchHubContent("en", { state: "ready" });
  assert.ok(!ready.includes("perch-engine-banner"), "no banner when the engine is fine");
  // engineStatus has FOUR states. Only "absent" means "go install it" —
  // sending a mid-install or breaker-open operator to Extensions is a dead end.
  for (const state of ["installing", "unhealthy"]) {
    const html = perchHubContent("en", { state });
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
  // ⚠ An earlier version of this comment had the relationship backwards —
  // it said sticky alone guarantees Send's reachability and that
  // #perch-chat's flex:1/min-height:0 are "about a DIFFERENT property".
  // That was inferred from a one-directional mutation (drop the flex rules,
  // watch the render test stay green) and it is wrong. Measured in BOTH
  // directions, 2026-09-10, through perch-hub-render.test.js's own CDP
  // harness with its 60-line seeded transcript:
  //
  //   config                              Send top-bottom     .content-body scroll
  //   412x730 / 1280x900 as shipped       668-704 / 854-890   0 / 0
  //   … + #perch-composer{position:static} 668-704 / 854-890   0 / 0   ← identical
  //   … flex chain removed from #perch-chat 668-704 / 854-890  3001 / 1431
  //   … flex chain removed AND static      3685 / 2285         3001 / 1431  ← UNREACHABLE
  //
  // Read the first two rows: sticky moves Send by ZERO pixels in the
  // shipped configuration, because nothing overflows .content-body for it
  // to stick against. The flex chain is what carries reachability — it
  // keeps #perch-chat inside the definite height .content-body hands down
  // (layout.js's "body:has(#perch-chat)" rules), so there is no scroll for
  // Send to be pushed below, and the TRANSCRIPT is what scrolls instead of
  // the panel. Read the last two rows: sticky is the backstop that engages
  // only once the flex chain has already broken, and then it is the only
  // thing keeping Send on screen.
  //
  // Both rules are real; neither is dead; and the flex chain is emphatically
  // not decorative. Delete it on the strength of the old comment and the
  // panel silently reverts to a page-scrolling .content-body with sticky
  // masking the regression. perch-hub-render.test.js now asserts both halves
  // live (".content-body does not scroll" and "with the flex chain broken,
  // sticky still holds Send"); the static checks below pin the exact
  // declarations those two measurements depend on.
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss().replace(/\s+/g, "");
  assert.ok(!/#perch-chat\{[^}]*height:100dvh/.test(css),
    "#perch-chat must not claim the viewport itself — it is no longer the viewport owner");
  assert.ok(/#perch-chat\{[^}]*flex:1/.test(css),
    "#perch-chat must fill whatever height its container hands it instead");
  assert.ok(/#perch-chat\{[^}]*min-height:0/.test(css),
    "without this the chat column refuses to shrink and overflows its container");
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
  // the keyboard, so #perch-chat's fixed height (handed down by the shell,
  // now — see the previous test) stays full-size and a bottom:0 sticky
  // composer sits behind the keyboard; visualViewport is the only API that
  // reports the genuinely visible area, and resize/scroll are the events it
  // fires when that area changes. This padding is still applied to
  // #perch-chat itself, not .content-body: the shell's own dvh-based height
  // has exactly the same "doesn't shrink for the keyboard" problem, so
  // moving the fix up a level would not have solved anything — it has to
  // stay where the flex column it's compensating for actually lives.
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  assert.match(js, /vv\.addEventListener\(\s*['"]resize['"]/,
    "the resize listener must be bound, not just the visualViewport token present");
  assert.match(js, /vv\.addEventListener\(\s*['"]scroll['"]/,
    "the scroll listener must be bound, not just the visualViewport token present");
  assert.match(js, /el\(\s*['"]perch-chat['"]\s*\)\.style\.paddingBottom/,
    "the keyboard-avoidance padding must land on #perch-chat, the flex column it's compensating for");
});

test("every control in the chat header carries a visible label", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  for (const id of ["perch-model", "perch-thinking", "perch-permission"]) {
    assert.ok(html.includes(`id="${id}-label"`), `${id} needs a visible label`);
    assert.ok(new RegExp(`id="${id}"[^>]*aria-labelledby="${id}-label"`).test(html));
  }
});

// ---------------------------------------------------------------------------
// Task C — structural properties the vm harness in perch-hub-client.test.js
// cannot see. That harness serves elements from a FLAT id->element map with no
// tree, so "the launcher is not inside the container that gets cleared" is
// trivially and meaninglessly true there. It is load-bearing in a real
// document: renderList() and showListNote() both clearEl(#perch-list-body) on
// every 10s poll and every note, and a launch control living inside that body
// would be wiped by both — which is a different flavour of the exact defect
// this task fixes (a launcher that disappears).
// ---------------------------------------------------------------------------

test("the launch control lives outside the list body that every poll clears", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  const launch = html.indexOf('id="perch-launch"');
  const listOpen = html.indexOf('id="perch-list"');
  const bodyOpen = html.indexOf('id="perch-list-body"');
  assert.ok(launch > -1, "there is no launch control in the markup at all");
  assert.ok(listOpen > -1 && bodyOpen > -1);
  assert.ok(launch > listOpen, "the launcher belongs to the list view");
  assert.ok(launch < bodyOpen,
    "it must precede #perch-list-body, whose contents renderList()/showListNote() clear");
  // And the launcher's own div must close before the body opens — "before it
  // in source" is not the same as "not nested inside it".
  const closeOfLaunch = html.indexOf("</div>", launch);
  assert.ok(closeOfLaunch > -1 && closeOfLaunch < bodyOpen,
    "#perch-launch must not wrap or contain #perch-list-body");
});

test("the launcher ships disabled, so the pre-data frame never claims there are no bots", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  assert.ok(/id="perch-new"[^>]*disabled/.test(html) || /disabled[^>]*id="perch-new"/.test(html),
    "renderLauncher() enables it once /roost answers; before that it must not invite a tap");
  assert.ok(/id="perch-new-bot"[^>]*hidden/.test(html), "and the picker starts hidden");
  assert.ok(/id="perch-launch-note"[^>]*hidden/.test(html), "as does its note");
});

test("the chat-view close control is in the header, not in the sticky composer", async () => {
  // #perch-composer{position:sticky;bottom:0} is the whole reason Send is
  // reachable at any scroll position (the drawer's defining mobile failure).
  // A control added INTO that box changes its height and puts that property
  // back in play; .perch-head is a non-scrolling flex child of #perch-chat and
  // is permanently on screen without touching the composer at all.
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  const close = html.indexOf('id="perch-close"');
  const head = html.indexOf('class="perch-head"');
  const composer = html.indexOf('id="perch-composer"');
  assert.ok(close > -1, "the open session needs a close control");
  assert.ok(head > -1 && composer > -1);
  assert.ok(close > head && close < composer, "close belongs to the header block");
  // The composer's own markup must be untouched by this task.
  const composerBlock = html.slice(composer, html.indexOf("</div>", html.indexOf("send-row")));
  assert.ok(!composerBlock.includes("perch-close"), "nothing new inside the sticky box");
});

test("the launcher and the row close button cannot overflow a 412px column", async () => {
  // Static counterpart to the live 412px CDP check: both new controls sit in
  // wrapping flex containers, so a long bot name cannot force a horizontal
  // scrollbar onto the list.
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss().replace(/\s+/g, "");
  assert.ok(/#perch-launch\{[^}]*display:flex/.test(css));
  assert.ok(/#perch-launch\{[^}]*flex-wrap:wrap/.test(css), "the launcher must wrap, not overflow");
  assert.ok(/#perch-launchselect\{[^}]*min-width:0/.test(css),
    "a flex item without min-width:0 refuses to shrink below its content width");
  assert.ok(/\.roost-row\{[^}]*flex-wrap:wrap/.test(css), "two buttons per row must be able to wrap");
  assert.ok(/\.perch-head\{[^}]*flex-wrap:wrap/.test(css),
    "the bot name, the state word and Close must wrap rather than overflow the chat column");
});
