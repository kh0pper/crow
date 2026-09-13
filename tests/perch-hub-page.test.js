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
  // Both listeners now go through bindOnce() — the fix-round-1 Q3 guard that
  // stops a Turbo visit stacking another copy of each. Still a SOURCE check
  // (this file has no DOM harness), and still not a behavioural one: the
  // proof that applyVV is really bound to both events AND really moves the
  // padding lives in tests/perch-hub-client.test.js's "I2: applyVV is bound
  // to BOTH visualViewport events" against a fake visualViewport.
  assert.match(js, /bindOnce\(\s*vv\s*,\s*['"]resize['"]/,
    "the resize listener must be bound, not just the visualViewport token present");
  assert.match(js, /bindOnce\(\s*vv\s*,\s*['"]scroll['"]/,
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

test("the chat-view close control lives in the Session tab, not in the sticky composer", async () => {
  // Send stays reachable because #perch-chat{flex:1;min-height:0} and
  // #perch-transcript{flex:1;overflow:auto;min-height:0} make the TRANSCRIPT the
  // only scroller, so .content-body never scrolls and the composer never leaves
  // the viewport. #perch-composer{position:sticky;bottom:0} is the BACKSTOP, not
  // the mechanism: measured, killing sticky in the shipped config is
  // pixel-identical (Send 668-704 at 412x730), while removing the flex chain
  // scrolls .content-body ~2962px with sticky still holding Send. Both matter;
  // the order matters more, because a maintainer who believes sticky is the
  // mechanism will delete the flex chain and the pre-existing reachability tests
  // stay GREEN through that deletion.
  //
  // Phase D moved Close (with rename and the state pill) out of .perch-head
  // into the Session tab — the plan's D1/D2 shape, mirroring the original
  // pi-lab hub. What must NOT change: a control added INTO the composer
  // changes its box and puts the backstop in play, so the composer stays
  // message-only, and Close stays reachable via the Session tab AND every
  // list row's own Close button.
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  const close = html.indexOf('id="perch-close"');
  const sessionTab = html.indexOf('id="perch-tab-session"');
  const filesTab = html.indexOf('id="perch-tab-files"');
  assert.ok(close > -1, "the open session needs a close control");
  assert.ok(sessionTab > -1 && filesTab > -1);
  assert.ok(close > sessionTab && close < filesTab,
    "close belongs to the Session tab section, between its open and the next section");
  // The composer's own markup must stay untouched by this task.
  const composer = html.indexOf('id="perch-composer"');
  const composerBlock = html.slice(composer, html.indexOf("</div>", html.indexOf("send-row")));
  assert.ok(!composerBlock.includes("perch-close"), "nothing new inside the sticky box");
});

// ---------------------------------------------------------------------------
// Phase D1 — the tab surface, statically. The live measurements (Send
// reachable in EVERY tab at both breakpoints, bar never overlapping it) run
// in perch-hub-render.test.js over CDP.
// ---------------------------------------------------------------------------

test("the chat column is a tablist of four labelled tabs over four panels", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  assert.ok(/id="perch-tabs"[^>]*role="tablist"/.test(html));
  for (const name of ["chat", "session", "files", "activity"]) {
    // Attribute order inside the tag is the markup's business, not the
    // test's — match the tag, then assert each attribute on it.
    const tag = (html.match(new RegExp(`<button[^>]*id="perch-tab-btn-${name}"[^>]*>`)) || [null])[0];
    assert.ok(tag, `${name} tab button exists`);
    assert.ok(tag.includes('role="tab"'), `${name} carries role=tab`);
    assert.ok(tag.includes(`aria-controls="perch-tab-${name}"`), `${name} tab button wires to its panel`);
    assert.ok(html.includes(`id="perch-tab-${name}"`), `${name} panel exists`);
    // House rule: no unlabelled controls — each button carries text after its
    // aria-hidden glyph.
    const seg = html.slice(html.indexOf(`id="perch-tab-btn-${name}"`));
    assert.ok(/<\/svg>[^<]+$/.test(seg.slice(0, seg.indexOf("</button>"))),
      `${name} tab has a visible text label beside the glyph`);
  }
  // Exactly one selected at rest, and it is chat — the client's switchTab()
  // flips aria-selected from there.
  const chatTag = html.match(/<button[^>]*id="perch-tab-btn-chat"[^>]*>/)[0];
  assert.ok(chatTag.includes('aria-selected="true"'));
  for (const name of ["session", "files", "activity"]) {
    const tag = html.match(new RegExp(`<button[^>]*id="perch-tab-btn-${name}"[^>]*>`))[0];
    assert.ok(tag.includes('aria-selected="false"'));
    const sec = html.match(new RegExp(`<section[^>]*id="perch-tab-${name}"[^>]*>`))[0];
    assert.ok(/(^|\s)hidden(=|>|\s)/.test(sec) || sec.endsWith("hidden>"),
      `${name} panel ships hidden — only the active section is displayed`);
  }
});

test("the chat panel keeps the transcript, ask pane and composer — in that order", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  const chatTab = html.indexOf('id="perch-tab-chat"');
  const sessionTab = html.indexOf('id="perch-tab-session"');
  const tr = html.indexOf('id="perch-transcript"');
  const ask = html.indexOf('id="perch-ask"');
  const composer = html.indexOf('id="perch-composer"');
  assert.ok(chatTab < tr && tr < ask && ask < composer && composer < sessionTab,
    "the old column, wrapped — order is the flex chain's order");
});

test("the session panel carries the controls, the cwd readout and the head's old buttons", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  const s = html.indexOf('id="perch-tab-session"');
  const e = html.indexOf('id="perch-tab-files"');
  const seg = html.slice(s, e);
  for (const id of ["perch-model", "perch-thinking", "perch-permission", "perch-plan-mode",
                    "perch-session-cwd", "perch-change-cwd", "perch-state",
                    "perch-rename", "perch-close"]) {
    assert.ok(seg.includes(`id="${id}"`), `${id} lives in the Session tab`);
  }
  // Identity stays in the head — the tabs must not orphan it.
  const head = html.slice(html.indexOf('class="perch-head"'), html.indexOf('id="perch-tabs"'));
  for (const id of ["perch-bot-name", "perch-session-name", "perch-session-meta"]) {
    assert.ok(head.includes(`id="${id}"`), `${id} stays in the head`);
  }
});

test("the tab CSS keeps the flex chain intact and hides panels by attribute", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss().replace(/\s+/g, "");
  // The chat panel must BE the column the old #perch-chat rules describe,
  // or the reachability backstop comment becomes a lie again.
  assert.ok(/#perch-tab-chat\{[^}]*flex:1/.test(css));
  assert.ok(/#perch-tab-chat\{[^}]*min-height:0/.test(css));
  assert.ok(/#perch-tab-chat\{[^}]*display:flex/.test(css));
  // The bar is a non-shrinking sibling — if it can shrink, a long transcript
  // squeezes it and the phone loses its navigation.
  assert.ok(/#perch-tabs\{[^}]*flex-shrink:0/.test(css));
  // Phone: the bar is LAST (bottom); desktop media query puts it back on top.
  assert.ok(/#perch-tabs\{[^}]*order:10/.test(css));
  assert.ok(/#perch-tabs\{order:0/.test(css), "the desktop strip returns to natural order");
  // [hidden] outranks the panels' display rules, and does it by specificity
  // (id+type+attr), not by !important. NOTE: the whitespace strip above also
  // eats the descendant-selector space, hence the run-together pattern.
  assert.ok(/#perch-hub-rootsection\[hidden\]\{display:none\}/.test(css));
  assert.ok(!/!important/.test(css.match(/#perch-hub-rootsection\[hidden\]\{[^}]*\}/)[0]));
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

// ---------------------------------------------------------------------------
// Open-anywhere C2 — the launcher's directory field + picker, statically.
// The live walk (browse → choose → spawn carries cwd) is measured in
// perch-hub-render.test.js; these pin the markup/source properties a browser
// test cannot see.
// ---------------------------------------------------------------------------

test("the launcher carries a labelled directory field, a Browse button and the default note", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  assert.ok(html.includes('id="perch-new-cwd-label"'), "the field needs a visible label");
  assert.ok(/id="perch-new-cwd"[^>]*aria-labelledby="perch-new-cwd-label"/.test(html));
  assert.ok(html.includes('id="perch-browse-btn"'), "the picker's trigger");
  // House rule: no unlabelled controls — the Browse button carries its text.
  assert.ok(/id="perch-browse-btn">[^<]+</.test(html), "Browse must carry a visible label");
  assert.ok(html.includes('id="perch-cwd-note"'), "empty = the bot's default, stated on the page");
  // The field lives in the launch row (before #perch-new), never inside the
  // list body every poll clears — the same structural rule the launcher's
  // own controls are pinned under above.
  const cwd = html.indexOf('id="perch-new-cwd"');
  assert.ok(cwd > html.indexOf('id="perch-launch"') && cwd < html.indexOf('id="perch-list-body"'));
});

test("the picker dismiss never depends on one path: Escape via the registry AND a visible Cancel", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  // Review S5: both dismiss paths, and the keydown listener goes through the
  // generation-checked bindOnce registry so the Turbo-leak guard covers it.
  assert.match(js, /bindOnce\(\s*document\s*,\s*'keydown'\s*,\s*'browseEscape'/,
    "Escape must be bound through the hub's one-listener-per-realm registry");
  assert.match(js, /cancel\.id='perch-browse-cancel';\s*cancel\.textContent=ASK_CANCEL/,
    "a visible, labelled Cancel button");
  assert.match(js, /choose\.id='perch-browse-choose';\s*choose\.textContent=CHOOSE_LABEL/,
    "Choose is labelled too");
  // '..' navigates to the SERVER-resolved parent, never a client-side string
  // chop (a symlinked dir would ping-pong — the C1 endpoint's whole reason
  // for deriving parent from the realpath).
  assert.match(js, /loadBrowseDir\(r\.j\.parent\)/);
  // The modal is built with createElement/textContent only — the existing
  // "never assigns to an innerHTML-class sink" pin in
  // perch-hub-client.test.js already covers the whole emitted script, so
  // directory names cannot reach a sink without tripping that one.
});

// ---------------------------------------------------------------------------
// The working strip — the chat tab's "the bot is busy" signal (a turning
// gear + one word), driven by the same turnInFlight flag as the composer.
// ---------------------------------------------------------------------------

test("the working strip ships hidden, labelled, and polite — between ask pane and composer", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  const strip = html.match(/<div id="perch-working"[^>]*>/);
  assert.ok(strip, "the strip exists");
  assert.ok(strip[0].includes("hidden"), "ships hidden — an idle session must not claim to be working");
  assert.ok(strip[0].includes('aria-live="polite"'), "a screen reader announces the state change");
  const ask = html.indexOf('id="perch-ask"');
  const w = html.indexOf('id="perch-working"');
  const composer = html.indexOf('id="perch-composer"');
  assert.ok(ask < w && w < composer, "it sits between the ask pane and the composer, inside the chat tab");
  // House rule: visible label beside the glyph.
  const seg = html.slice(w, composer);
  assert.ok(/<\/svg>\s*<span>[^<]+<\/span>/.test(seg), "the gear carries a visible word");
});

test("the working strip CSS spins, hides by attribute, and calms under reduced motion", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss().replace(/\s+/g, "");
  assert.ok(/#perch-working\{[^}]*flex-shrink:0/.test(css),
    "a non-shrinking flex child — it must never squeeze the transcript or push Send off screen");
  assert.ok(/#perch-working\[hidden\]\{display:none\}/.test(css),
    "[hidden] must outrank the strip's own display:flex");
  assert.ok(/@keyframesperch-spin\{to\{transform:rotate\(360deg\)\}\}/.test(css));
  assert.ok(/animation:perch-spin/.test(css));
  assert.ok(/prefers-reduced-motion:reduce\)\{#perch-workingsvg\{animation-duration:6s\}/.test(css),
    "reduced motion slows the gear instead of freezing the signal");
});

// ---------------------------------------------------------------------------
// Wave 1 — the pi-lab parity quick wins, statically. Live measurements (copy
// buttons in seeded markdown, the auto-grow ceiling) run in
// perch-hub-render.test.js.
// ---------------------------------------------------------------------------

test("the attention banner ships hidden, inside the chat tab, above the transcript", async () => {
  const { perchHubContent } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const html = perchHubContent("en");
  const banner = html.match(/<div id="perch-attn"[^>]*>/);
  assert.ok(banner, "the banner exists");
  assert.ok(banner[0].includes("hidden"), "ships hidden — only a pending card raises it");
  const chatTab = html.indexOf('id="perch-tab-chat"');
  const attn = html.indexOf('id="perch-attn"');
  const tr = html.indexOf('id="perch-transcript"');
  assert.ok(chatTab < attn && attn < tr, "it sits above the transcript, inside the chat tab");
  assert.ok(/⚠ [^<]+</.test(html.slice(attn, tr)), "and it carries a visible sentence");
});

test("the Wave-1 CSS: grow ceiling, copy chrome, banner [hidden] discipline", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss().replace(/\s+/g, "");
  assert.ok(/#perch-composertextarea\{[^}]*max-height:120px/.test(css),
    "the auto-grow ceiling — a pasted essay must not push Send off screen");
  assert.ok(/#perch-composertextarea\{[^}]*overflow-y:auto/.test(css),
    "past the ceiling the textarea scrolls inside itself");
  assert.ok(/\.prewrap\{position:relative\}/.test(css), "the copy-pre button anchors to its fence");
  assert.ok(/\.copy-pre\{position:absolute/.test(css));
  assert.ok(/\.attn-banner\[hidden\]\{display:none\}/.test(css),
    "[hidden] must outrank the banner's own display:flex");
});

test("the Wave-1 client wiring: Enter/Shift rule, grow-on-input, watchdog, revive signals, resync", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  const js = perchHubJs("en");
  // Enter sends, Shift+Enter newlines — the rule itself, not the word "Enter".
  assert.match(js, /ev\.key==='Enter'&&!ev\.shiftKey/);
  // Auto-grow, pi-lab's exact ceiling.
  assert.match(js, /Math\.min\(this\.scrollHeight\|\|72,120\)/);
  // Watchdog: 15s tick, 75s silence threshold (two missed 30s server pings),
  // visibility-gated, and it re-opens WITH resync.
  assert.match(js, /setInterval\(function\(\)\{/, "the watchdog is an interval");
  assert.ok(js.includes("Date.now()-lastEventAt>75000"), "75s = two missed pings plus slack");
  assert.ok(js.includes("},15000);"), "15s tick");
  assert.match(js, /openStream\(current\.sid,true\)/, "the watchdog's re-open resyncs");
  // The server ping is what the watchdog measures silence against.
  assert.match(js, /addEventListener\('ping'/);
  // Revive on pageshow and online too, through the generation-checked registry.
  assert.match(js, /bindOnce\(window,'pageshow','pageshow',reviveStream\)/);
  assert.match(js, /bindOnce\(window,'online','online',reviveStream\)/);
  // Resync-on-reconnect: the retry slot carries it.
  assert.match(js, /openStream\(mySid,true\)/);
  // And the refetch REPLACES the transcript rather than appending to it.
  const resync = js.slice(js.indexOf("function resyncHistory"));
  const body = resync.slice(0, resync.indexOf("loadHistory(botId,sid)"));
  assert.ok(body.includes("clearEl(el('perch-transcript'))"),
    "resync clears before loadHistory refetches — an append would double every message");
});

test("the SSE heartbeat is a named ping frame, visible to client watchdogs", async () => {
  // Wave 1 item 20's server half: a `: keepalive` COMMENT is invisible to
  // EventSource, so a zombie socket on a foreground tab was undiscoverable.
  const src = readFileSync(join(REPO, "servers/gateway/streams/sse.js"), "utf8");
  assert.match(src, /event: ping\\ndata: \{\}\\n\\n/);
  assert.ok(!src.includes(': keepalive\\n\\n"'), "the comment-only heartbeat is gone");
});
