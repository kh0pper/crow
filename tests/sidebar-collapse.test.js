/**
 * Universal sidebar collapse (operator feedback: the crow nav panel should
 * be hideable/revealable on desktop and mobile, and should never vanish
 * outright — see perch-hub-page.test.js / perch-hub-render.test.js for the
 * "vanished entirely on /dashboard/perch" half of that report).
 *
 * Mobile hide/reveal (the ≤768px .open/.sidebar-overlay/hamburger machinery)
 * already existed and is NOT under test here — this file covers only what's
 * new: a persisted desktop collapse, scoped to `not all and (max-width:768px)`
 * so it can never contend with the mobile rules, plus the hamburger's new job
 * as the reveal control for that collapsed state at any width.
 *
 * The scope is the NEGATION of the mobile query, deliberately, not
 * `min-width:769px`: those two agree at every integer width but not at a
 * fractional one, so `min-width:769px` leaves a dead band in (768, 769) --
 * reachable via zoom and some device pixel ratios -- where neither axis
 * matches, the click takes the desktop branch, the sidebar does not move, and
 * an unscoped rule reveals a redundant hamburger beside a still-visible
 * sidebar. The assertion "no rule may reintroduce the 769px floor" below
 * exists to stop exactly that being restored to match a stale comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderLayout } from "../servers/gateway/dashboard/shared/layout.js";

function stubLayout(overrides = {}) {
  return renderLayout({
    title: "Test",
    content: "<p>hi</p>",
    activePanel: "nest",
    panels: [{ id: "nest", name: "Nest", icon: "health", route: "/dashboard", navOrder: 1 }],
    lang: "en",
    ...overrides,
  });
}

// ─── markup ───────────────────────────────────────────────────────────────

test("the sidebar carries a collapse button with an accessible name routed through i18n", () => {
  // EN-vs-ES differential (board-i18n-literals.test.js's technique): a
  // hardcoded literal would show the same text in both renders. Also proves
  // the EN string doesn't leak into the ES page.
  const en = stubLayout({ lang: "en" });
  const es = stubLayout({ lang: "es" });
  assert.match(en, /id="sidebar-collapse-btn"[^>]*aria-label="Collapse sidebar"/);
  assert.match(es, /id="sidebar-collapse-btn"[^>]*aria-label="Contraer panel lateral"/);
  assert.ok(!es.includes('aria-label="Collapse sidebar"'), "EN label must not leak into the ES render");
});

test("the hamburger carries an accessible name routed through i18n", () => {
  const en = stubLayout({ lang: "en" });
  const es = stubLayout({ lang: "es" });
  assert.match(en, /id="sidebar-reveal-btn"[^>]*aria-label="Toggle menu"/);
  assert.match(es, /id="sidebar-reveal-btn"[^>]*aria-label="Alternar menú"/);
});

test("both toggle controls name the region they operate, and it has an id to name", () => {
  // Neither control had aria-controls and <aside class="sidebar"> had no id,
  // so "expanded" referred to nothing a screen reader could follow.
  const html = stubLayout();
  assert.match(html, /<aside class="sidebar" id="sidebar">/);
  assert.match(html, /id="sidebar-collapse-btn"[^>]*aria-controls="sidebar"/);
  assert.match(html, /id="sidebar-reveal-btn"[^>]*aria-controls="sidebar"/);
  // Exactly one element may own the id or the reference is ambiguous.
  assert.equal((html.match(/ id="sidebar"/g) || []).length, 1);
});

test("aria-expanded ships false and is corrected upward by the sync, never shipped as an unconditional true", () => {
  // The server cannot read the localStorage the collapse state lives in, and
  // on a phone the sidebar is genuinely closed at first paint — so a
  // hardcoded "true" was wrong on every phone load, and permanently wrong
  // with scripts blocked. "false" plus syncSidebarToggleAria() (which runs
  // in the same inline block, before .dashboard finishes parsing) is right
  // in the closed case immediately and in the open case a tick later.
  const html = stubLayout();
  assert.match(html, /id="sidebar-collapse-btn"[^>]*aria-expanded="false"/);
  assert.match(html, /id="sidebar-reveal-btn"[^>]*aria-expanded="false"/);
  assert.ok(!/id="sidebar-(collapse|reveal)-btn"[^>]*aria-expanded="true"/.test(html),
    "no control may server-render aria-expanded=\"true\" — nothing on the server knows that");
});

test("the collapse-restore script runs before .dashboard is parsed, and is try/catch-guarded", () => {
  const html = stubLayout();
  const bodyIdx = html.indexOf("<body");
  const scriptIdx = html.indexOf("crow-sidebar-collapsed");
  const dashboardIdx = html.indexOf('<div class="dashboard">');
  assert.ok(bodyIdx !== -1 && scriptIdx !== -1 && dashboardIdx !== -1, "expected markers not found");
  assert.ok(
    scriptIdx > bodyIdx && scriptIdx < dashboardIdx,
    "the restore must run before the sidebar/main-content markup or the class change flashes visibly"
  );
  const scriptStart = html.indexOf("<script>", bodyIdx);
  const scriptEnd = html.indexOf("</script>", scriptStart);
  const script = html.slice(scriptStart, scriptEnd);
  const tryIdx = script.search(/try\s*\{/);
  const readIdx = script.indexOf("localStorage.getItem('crow-sidebar-collapsed')");
  const catchIdx = script.search(/\}\s*catch\s*\(e\)\s*\{\s*\}/);
  assert.ok(tryIdx !== -1 && readIdx !== -1 && catchIdx !== -1, "try/read/catch not all found");
  assert.ok(tryIdx < readIdx && readIdx < catchIdx, "the localStorage read must be inside the try, before the catch");
});

// ─── CSS scoping (the two axes must never fight) ───────────────────────────

// dashboardCss() concatenates componentsCss()/notifications.js BEFORE the
// sidebar's own rules, and those also carry their own "@media (max-width:
// 768px)" blocks (header-dropdown, health-label, etc.) — so a plain
// first-match .match() against the whole page can silently grab the WRONG
// block. Collect every block at the given breakpoint and filter by content.
// `prelude` is the media query text verbatim, parens and all, because the
// desktop half is no longer a plain "(min-width: N)" — it is the NEGATION of
// the mobile query ("not all and (max-width: 768px)"), which is what makes
// the two ranges exact complements at fractional widths.
const MOBILE_Q = "(max-width: 768px)";
const DESKTOP_Q = "not all and (max-width: 768px)";
function mediaBlocksAt(html, prelude) {
  const esc = prelude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@media ${esc} \\{([\\s\\S]*?)\\n  \\}\\n`, "g");
  return [...html.matchAll(re)].map((m) => m[1]);
}
function mediaBlockContaining(html, prelude, mustContain) {
  const blocks = mediaBlocksAt(html, prelude);
  const found = blocks.find((b) => b.includes(mustContain));
  assert.ok(found, `no @media ${prelude} block containing "${mustContain}" found (checked ${blocks.length})`);
  return found;
}

test("the hamburger is visible whenever the sidebar is collapsed, at any width — a rule with no media-query gate", () => {
  const html = stubLayout();
  assert.match(html, /body\.sidebar-collapsed \.hamburger\s*\{\s*display:\s*block;\s*\}/);
  const mobileBlocks = mediaBlocksAt(html, MOBILE_Q);
  const desktopBlocks = mediaBlocksAt(html, DESKTOP_Q);
  assert.ok(mobileBlocks.length > 0 && desktopBlocks.length > 0, "expected media blocks not found");
  assert.ok(mobileBlocks.every((b) => !b.includes("body.sidebar-collapsed .hamburger")),
    "must not be trapped inside any mobile-only block");
  assert.ok(desktopBlocks.every((b) => !b.includes("body.sidebar-collapsed .hamburger")),
    "must not be trapped inside the desktop-only block either");
});

test("desktop collapse (off-canvas sidebar, .main-content margin-left:0) is scoped to the exact complement of the mobile query", () => {
  const html = stubLayout();
  const desktop = mediaBlockContaining(html, DESKTOP_Q, "body.sidebar-collapsed");
  assert.match(desktop, /body\.sidebar-collapsed \.sidebar\s*\{[^}]*transform:\s*translateX\(-100%\);/);
  assert.match(desktop, /body\.sidebar-collapsed \.main-content\s*\{\s*margin-left:\s*0;\s*\}/);
});

test("the two axes are complementary ranges, with no width that matches neither", () => {
  // "(min-width: 769px)" is NOT the complement of "(max-width: 768px)":
  // 768.5px (browser zoom, some device pixel ratios) matches neither, so the
  // whole collapse axis went dead there while isMobileWidth() — which
  // queries the mobile text — still routed the click down the desktop
  // branch. The sidebar would not move and the unscoped
  // "body.sidebar-collapsed .hamburger" rule would put a redundant hamburger
  // next to a still-visible sidebar. Negating the mobile query removes the
  // band by construction.
  const html = stubLayout();
  assert.ok(html.includes(`@media ${DESKTOP_Q} {`), "the desktop half must negate the mobile query");
  assert.ok(!html.includes("@media (min-width: 769px)"),
    "no rule may reintroduce the 769px floor — that is what opens the dead band");
  // Same query text on both sides of the JS/CSS boundary, so they can never
  // disagree about which axis a given width belongs to.
  assert.match(html, /matchMedia\('\(max-width: 768px\)'\)/);
});

test("desktop collapse rules never appear inside any ≤768px mobile block — disjoint breakpoints, no cascade fight", () => {
  const html = stubLayout();
  const mobileBlocks = mediaBlocksAt(html, MOBILE_Q);
  assert.ok(mobileBlocks.length > 0, "expected mobile media blocks not found");
  for (const mobile of mobileBlocks) {
    assert.ok(!mobile.includes("body.sidebar-collapsed .sidebar"));
    assert.ok(!mobile.includes("body.sidebar-collapsed .main-content"));
  }
});

test("the in-sidebar collapse button is hidden under the mobile breakpoint", () => {
  // Mobile keeps its existing hamburger + overlay + Escape close path;
  // adding a second, untested affordance there was explicitly out of scope.
  const html = stubLayout();
  const mobile = mediaBlockContaining(html, MOBILE_Q, ".sidebar-collapse-btn");
  assert.match(mobile, /\.sidebar-collapse-btn\s*\{\s*display:\s*none;\s*\}/);
});

test("an off-canvas sidebar leaves the tab order and the accessibility tree, not just the screen", () => {
  // translateX(-100%) hides pixels only: collapsed at 1280x900 the aside was
  // measured visibility:visible, tabIndex >= 0, every .nav-item still
  // exposed — a screen reader announcing a nav that is visually gone and a
  // keyboard user tabbing through invisible links. visibility:hidden fixes
  // both; the 0.2s delay makes it land AFTER the slide-out finishes so the
  // animation is not cut short, and the reveal path carries no delay.
  const html = stubLayout();
  const desktop = mediaBlockContaining(html, DESKTOP_Q, "body.sidebar-collapsed .sidebar");
  assert.match(desktop, /body\.sidebar-collapsed \.sidebar\s*\{[^}]*visibility:\s*hidden;/);
  assert.match(desktop, /body\.sidebar-collapsed \.sidebar\s*\{[^}]*transition:[^;]*visibility 0s linear 0\.2s;/);

  // The ≤768px closed state has always had the same defect. It is not a
  // regression of this feature, but it falls out of the same two lines.
  const mobile = mediaBlockContaining(html, MOBILE_Q, ".sidebar.open");
  assert.match(mobile, /\.sidebar\s*\{[^}]*visibility:\s*hidden;/);
  assert.match(mobile, /\.sidebar\.open\s*\{[^}]*visibility:\s*visible;/,
    "opening must restore visibility or the mobile sidebar is unreachable for everyone");
  assert.match(mobile, /\.sidebar\.open\s*\{[^}]*transition:[^;]*visibility 0s;/,
    "with a delay here the freshly-opened sidebar stays hidden for 0.2s");
});

// ─── behavior (extract the real emitted functions, run them against a
// hand-rolled DOM stub — the repo's convention for testing a big inline
// client script without a jsdom dependency; see message-delivery-render
// .test.js) ─────────────────────────────────────────────────────────────

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in renderLayout output`);
  const braceStart = src.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

function makeClassList() {
  const set = new Set();
  return {
    _set: set,
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

/** Pulls a top-level `if (…) { … }` block out of the emitted script by
 *  brace-matching from a literal marker — the breakpoint listener is
 *  installed at script top level, not inside a named function, so
 *  extractFunction() cannot reach it. */
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`block "${marker}" not found in renderLayout output`);
  const braceStart = src.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

/** `focused` is the shared activeElement stand-in: the browser's own focus
 *  bookkeeping is the thing under test in the focus-management cases. */
function makeButtonEl(id, focused) {
  const attrs = {};
  return {
    id,
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
    focus() { focused.id = id; },
    _attrs: attrs,
  };
}

/** Build a fresh, isolated set of the sidebar functions against a fake DOM.
 *  `mobile` controls what window.matchMedia('(max-width: 768px)') reports —
 *  the one thing toggleSidebar()/syncSidebarToggleAria() branch on. */
function buildSidebarHarness(mobile) {
  const html = stubLayout();
  const src = [
    "isMobileWidth", "syncSidebarToggleAria", "setSidebarCollapsed", "focusSidebarControl",
    "toggleSidebar", "closeSidebar",
  ].map((name) => extractFunction(html, name)).join("\n");
  // The breakpoint listener is top-level code; pull it in too so crossing
  // the boundary can be exercised for real rather than grepped for.
  const breakpointBlock = extractBlock(html, "if (!window.__crowSidebarBreakpointBound)");

  const body = { classList: makeClassList() };
  // The aside carries `inert` as well as classes: that attribute is how the
  // collapsed nav leaves the tab order synchronously, ahead of the CSS.
  const sidebarAttrs = {};
  const sidebarEl = {
    classList: makeClassList(),
    setAttribute: (k, v) => { sidebarAttrs[k] = v; },
    removeAttribute: (k) => { delete sidebarAttrs[k]; },
    hasAttribute: (k) => k in sidebarAttrs,
  };
  const focused = { id: null };
  const collapseBtn = makeButtonEl("sidebar-collapse-btn", focused);
  const revealBtn = makeButtonEl("sidebar-reveal-btn", focused);
  const storage = {};

  // Mutable so a test can cross the breakpoint mid-run; the emitted code
  // calls matchMedia() fresh on every isMobileWidth(), like a browser would.
  const media = { mobile };
  const changeListeners = [];

  const context = {
    document: {
      body,
      querySelector: (sel) => (sel === ".sidebar" ? sidebarEl : null),
      getElementById: (id) => (id === "sidebar-collapse-btn" ? collapseBtn : id === "sidebar-reveal-btn" ? revealBtn : null),
    },
    window: {
      matchMedia: () => ({
        get matches() { return media.mobile; },
        addEventListener: (ev, fn) => { if (ev === "change") changeListeners.push(fn); },
      }),
      scrollY: 42,
      scrollTo: () => {},
    },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = v; },
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(
    // The trailing syncSidebarToggleAria() mirrors the emitted script,
    // which calls it once at execution so the server-rendered
    // aria-expanded="false" is corrected before the user sees anything.
    `${src}\n${breakpointBlock}\nsyncSidebarToggleAria();\n` +
      "globalThis.__toggleSidebar = toggleSidebar;\nglobalThis.__closeSidebar = closeSidebar;",
    context
  );
  return {
    body, sidebarEl, collapseBtn, revealBtn, storage, focused,
    sidebarInert: () => sidebarEl.hasAttribute("inert"),
    changeListenerCount: () => changeListeners.length,
    /** Cross the breakpoint the way a rotation or a window resize would. */
    crossTo(nowMobile) {
      media.mobile = nowMobile;
      changeListeners.forEach((fn) => fn({ matches: nowMobile }));
    },
    toggleSidebar: context.__toggleSidebar,
    closeSidebar: context.__closeSidebar,
  };
}

test("desktop: toggleSidebar() collapses, persists, and flips aria-expanded on both buttons", () => {
  const h = buildSidebarHarness(false);
  assert.equal(h.body.classList.contains("sidebar-collapsed"), false, "starts expanded");

  h.toggleSidebar();
  assert.equal(h.body.classList.contains("sidebar-collapsed"), true, "first click collapses");
  assert.equal(h.storage["crow-sidebar-collapsed"], "1", "must persist the collapse");
  assert.equal(h.collapseBtn.getAttribute("aria-expanded"), "false");
  assert.equal(h.revealBtn.getAttribute("aria-expanded"), "false");
  assert.equal(h.sidebarEl.classList.contains("open"), false, "desktop collapse must not touch the mobile .open class");

  h.toggleSidebar();
  assert.equal(h.body.classList.contains("sidebar-collapsed"), false, "second click reveals");
  assert.equal(h.storage["crow-sidebar-collapsed"], "0");
  assert.equal(h.collapseBtn.getAttribute("aria-expanded"), "true");
  assert.equal(h.revealBtn.getAttribute("aria-expanded"), "true");
});

test("mobile: toggleSidebar() opens the overlay and never touches the desktop collapse class or localStorage", () => {
  const h = buildSidebarHarness(true);
  h.toggleSidebar();
  assert.equal(h.sidebarEl.classList.contains("open"), true, "mobile path opens the overlay");
  assert.equal(h.body.classList.contains("sidebar-open"), true);
  assert.equal(h.body.classList.contains("sidebar-collapsed"), false, "mobile toggling must never set the desktop class");
  assert.deepEqual(h.storage, {}, "mobile toggling must never write the desktop persisted preference");
  assert.equal(h.collapseBtn.getAttribute("aria-expanded"), "true");
  assert.equal(h.revealBtn.getAttribute("aria-expanded"), "true");

  h.closeSidebar();
  assert.equal(h.sidebarEl.classList.contains("open"), false);
  assert.equal(h.body.classList.contains("sidebar-open"), false);
  assert.equal(h.collapseBtn.getAttribute("aria-expanded"), "false");
  assert.equal(h.revealBtn.getAttribute("aria-expanded"), "false");
});

test("desktop: focus follows the sidebar instead of being stranded off-canvas", () => {
  // Measured at 1280x900 before this: activating collapse left
  // document.activeElement on #sidebar-collapse-btn at x = -49 — invisible,
  // inside a position:fixed container, unscrollable. Activating reveal set
  // the hamburger to display:none, so the browser blurred it and
  // activeElement fell back to <body>, restarting the next Tab from the top
  // of the document.
  const h = buildSidebarHarness(false);
  h.toggleSidebar();
  assert.equal(h.focused.id, "sidebar-reveal-btn",
    "collapsing must hand focus to the hamburger — the only control still on screen");
  h.toggleSidebar();
  assert.equal(h.focused.id, "sidebar-collapse-btn",
    "revealing must hand focus to the collapse button — the hamburger is display:none now");
});

test("mobile toggling does not move focus — both controls stay on screen there", () => {
  // The mobile axis has no stranding problem to solve: the hamburger is
  // display:block at every ≤768px state. Stealing focus there would be a
  // regression, not a fix.
  const h = buildSidebarHarness(true);
  h.toggleSidebar();
  assert.equal(h.focused.id, null);
  h.closeSidebar();
  assert.equal(h.focused.id, null);
});

test("crossing the breakpoint re-syncs aria, which nothing else recomputes", () => {
  // Phone, sidebar closed: both controls read "false". Rotate to landscape
  // and the sidebar is expanded again (the ≤768px off-canvas rule stops
  // applying) while both controls still announce "collapsed".
  const h = buildSidebarHarness(true);
  assert.equal(h.collapseBtn.getAttribute("aria-expanded"), "false");
  h.crossTo(false);
  assert.equal(h.collapseBtn.getAttribute("aria-expanded"), "true",
    "the sidebar is expanded at desktop width and the control must say so");
  assert.equal(h.revealBtn.getAttribute("aria-expanded"), "true");
});

test("crossing up out of the mobile range tears down the mobile-only open state", () => {
  // .sidebar.open persists across the boundary and its transform:
  // translateX(0) is inert at desktop, so nothing looks wrong — but
  // toggleSidebar() has switched to the desktop branch and will never clear
  // it. Narrow again and the user lands on a mobile page with the sidebar
  // already open and its overlay up.
  const h = buildSidebarHarness(true);
  h.toggleSidebar();
  assert.equal(h.sidebarEl.classList.contains("open"), true);
  assert.equal(h.body.classList.contains("sidebar-open"), true);

  h.crossTo(false);
  assert.equal(h.sidebarEl.classList.contains("open"), false, "the mobile .open class must not survive the boundary");
  assert.equal(h.body.classList.contains("sidebar-open"), false, "nor the body class that made it position:fixed");

  h.crossTo(true);
  assert.equal(h.sidebarEl.classList.contains("open"), false, "and coming back down must land on a closed sidebar");
  assert.equal(h.revealBtn.getAttribute("aria-expanded"), "false");
});

test("crossing down into the mobile range keeps the persisted desktop preference", () => {
  // The mirror of the case above, and deliberately NOT symmetric:
  // body.sidebar-collapsed is a saved per-viewer setting that is simply
  // inert below 769px. Clearing it on a rotation would silently discard it.
  const h = buildSidebarHarness(false);
  h.toggleSidebar();
  assert.equal(h.body.classList.contains("sidebar-collapsed"), true);

  h.crossTo(true);
  assert.equal(h.body.classList.contains("sidebar-collapsed"), true, "the saved preference must survive");
  assert.equal(h.storage["crow-sidebar-collapsed"], "1", "and must not be rewritten by a mere resize");
  assert.equal(h.revealBtn.getAttribute("aria-expanded"), "false",
    "but aria must describe the MOBILE state now — the sidebar is closed, not collapsed");

  h.crossTo(false);
  assert.equal(h.revealBtn.getAttribute("aria-expanded"), "false", "still collapsed on the way back up");
});

test("the breakpoint listener is bound exactly once per document, not once per Turbo navigation", () => {
  // renderLayout's script re-executes on every Turbo navigation while
  // `window` survives the body swap, so an unguarded addEventListener would
  // stack a fresh listener on every page view for the life of the tab.
  const h = buildSidebarHarness(false);
  assert.equal(h.changeListenerCount(), 1);
});

test("the hidden sidebar is inert on both axes, synchronously", () => {
  // visibility:hidden alone is not enough in practice. Measured in Chrome:
  // the rule is deliberately delayed 0.2s so the slide-out animation plays,
  // and the inherited value then takes a further ~200ms to reach the
  // .nav-item descendants — so for ~400ms after a collapse the links were
  // still focusable (t=100ms: aside visible, nav item focusable; t=403ms:
  // both hidden). inert applies on the same tick. Re-measured with it in
  // place: not focusable at t=100ms, in every state, on both axes.
  const desktop = buildSidebarHarness(false);
  assert.equal(desktop.sidebarInert(), false, "an expanded desktop sidebar must stay interactive");
  desktop.toggleSidebar();
  assert.equal(desktop.sidebarInert(), true, "collapsing must take the nav out of the tab order at once");
  desktop.toggleSidebar();
  assert.equal(desktop.sidebarInert(), false, "and revealing must put it back");

  const mobile = buildSidebarHarness(true);
  assert.equal(mobile.sidebarInert(), true, "the ≤768px sidebar starts closed, so it starts inert");
  mobile.toggleSidebar();
  assert.equal(mobile.sidebarInert(), false);
  mobile.closeSidebar();
  assert.equal(mobile.sidebarInert(), true);
});

test("crossing the breakpoint re-evaluates inert, not just aria", () => {
  // A sidebar left .open at ≤768px is expanded-and-interactive up at desktop
  // width, where .open means nothing; the teardown must leave it in a
  // consistent state rather than an inert-but-visible one.
  const h = buildSidebarHarness(true);
  h.toggleSidebar();
  assert.equal(h.sidebarInert(), false);
  h.crossTo(false);
  assert.equal(h.sidebarInert(), false, "at desktop width, not collapsed, the sidebar is visible and interactive");

  const c = buildSidebarHarness(false);
  c.toggleSidebar();
  assert.equal(c.sidebarInert(), true);
  c.crossTo(true);
  assert.equal(c.sidebarInert(), true, "and a mobile page whose sidebar is closed keeps it inert");
});
