/**
 * Universal sidebar collapse (operator feedback: the crow nav panel should
 * be hideable/revealable on desktop and mobile, and should never vanish
 * outright — see perch-hub-page.test.js / perch-hub-render.test.js for the
 * "vanished entirely on /dashboard/perch" half of that report).
 *
 * Mobile hide/reveal (the ≤768px .open/.sidebar-overlay/hamburger machinery)
 * already existed and is NOT under test here — this file covers only what's
 * new: a persisted desktop collapse, scoped to min-width:769px so it can
 * never contend with the mobile rules, plus the hamburger's new job as the
 * reveal control for that collapsed state at any width.
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

test("the hamburger carries an accessible name routed through i18n and starts aria-expanded", () => {
  const en = stubLayout({ lang: "en" });
  const es = stubLayout({ lang: "es" });
  assert.match(en, /id="sidebar-reveal-btn"[^>]*aria-expanded="true"[^>]*aria-label="Toggle menu"/);
  assert.match(es, /id="sidebar-reveal-btn"[^>]*aria-expanded="true"[^>]*aria-label="Alternar menú"/);
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
function mediaBlocksAt(html, query) {
  const re = new RegExp(`@media \\(${query}\\) \\{([\\s\\S]*?)\\n  \\}\\n`, "g");
  return [...html.matchAll(re)].map((m) => m[1]);
}
function mediaBlockContaining(html, query, mustContain) {
  const blocks = mediaBlocksAt(html, query);
  const found = blocks.find((b) => b.includes(mustContain));
  assert.ok(found, `no @media (${query}) block containing "${mustContain}" found (checked ${blocks.length})`);
  return found;
}

test("the hamburger is visible whenever the sidebar is collapsed, at any width — a rule with no media-query gate", () => {
  const html = stubLayout();
  assert.match(html, /body\.sidebar-collapsed \.hamburger\s*\{\s*display:\s*block;\s*\}/);
  const mobileBlocks = mediaBlocksAt(html, "max-width: 768px");
  const desktopBlocks = mediaBlocksAt(html, "min-width: 769px");
  assert.ok(mobileBlocks.length > 0 && desktopBlocks.length > 0, "expected media blocks not found");
  assert.ok(mobileBlocks.every((b) => !b.includes("body.sidebar-collapsed .hamburger")),
    "must not be trapped inside any mobile-only block");
  assert.ok(desktopBlocks.every((b) => !b.includes("body.sidebar-collapsed .hamburger")),
    "must not be trapped inside the desktop-only block either");
});

test("desktop collapse (off-canvas sidebar, .main-content margin-left:0) is scoped to min-width:769px", () => {
  const html = stubLayout();
  const desktop = mediaBlockContaining(html, "min-width: 769px", "body.sidebar-collapsed");
  assert.match(desktop, /body\.sidebar-collapsed \.sidebar\s*\{\s*transform:\s*translateX\(-100%\);\s*\}/);
  assert.match(desktop, /body\.sidebar-collapsed \.main-content\s*\{\s*margin-left:\s*0;\s*\}/);
});

test("desktop collapse rules never appear inside any ≤768px mobile block — disjoint breakpoints, no cascade fight", () => {
  const html = stubLayout();
  const mobileBlocks = mediaBlocksAt(html, "max-width: 768px");
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
  const mobile = mediaBlockContaining(html, "max-width: 768px", ".sidebar-collapse-btn");
  assert.match(mobile, /\.sidebar-collapse-btn\s*\{\s*display:\s*none;\s*\}/);
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

function makeButtonEl(id) {
  const attrs = {};
  return { id, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k], _attrs: attrs };
}

/** Build a fresh, isolated set of the sidebar functions against a fake DOM.
 *  `mobile` controls what window.matchMedia('(max-width: 768px)') reports —
 *  the one thing toggleSidebar()/syncSidebarToggleAria() branch on. */
function buildSidebarHarness(mobile) {
  const html = stubLayout();
  const src = [
    "isMobileWidth", "syncSidebarToggleAria", "setSidebarCollapsed", "toggleSidebar", "closeSidebar",
  ].map((name) => extractFunction(html, name)).join("\n");

  const body = { classList: makeClassList() };
  const sidebarEl = { classList: makeClassList() };
  const collapseBtn = makeButtonEl("sidebar-collapse-btn");
  const revealBtn = makeButtonEl("sidebar-reveal-btn");
  const storage = {};

  const context = {
    document: {
      body,
      querySelector: (sel) => (sel === ".sidebar" ? sidebarEl : null),
      getElementById: (id) => (id === "sidebar-collapse-btn" ? collapseBtn : id === "sidebar-reveal-btn" ? revealBtn : null),
    },
    window: { matchMedia: () => ({ matches: mobile }), scrollY: 42, scrollTo: () => {} },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = v; },
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(
    `${src}\nglobalThis.__toggleSidebar = toggleSidebar;\nglobalThis.__closeSidebar = closeSidebar;`,
    context
  );
  return {
    body, sidebarEl, collapseBtn, revealBtn, storage,
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
