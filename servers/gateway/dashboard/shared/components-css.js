/**
 * CSS + minimal client JS for the F6a shared primitives (button, codeBlock,
 * callout, stepper, tabs). Injected once by layout.js dashboardCss(). All
 * sizing uses the token scales from design-tokens.js (no hardcoded px).
 */

export function componentsCss() {
  return `
  /* Button */
  .btn { display:inline-flex; align-items:center; gap:var(--crow-space-2);
    font-family:inherit; font-size:var(--crow-text-base); font-weight:500;
    border-radius:var(--crow-radius-control); border:1px solid transparent;
    cursor:pointer; text-decoration:none; transition:background .15s,border-color .15s,color .15s; }
  .btn-md { padding:var(--crow-space-2) var(--crow-space-4); }
  .btn-sm { padding:var(--crow-space-1) var(--crow-space-3); font-size:var(--crow-text-sm); }
  .btn-primary { background:var(--crow-accent); color:var(--crow-accent-contrast); }
  .btn-primary:hover { background:var(--crow-accent-hover); }
  .btn-secondary { background:var(--crow-bg-elevated); color:var(--crow-text-primary); border-color:var(--crow-border); }
  .btn-secondary:hover { border-color:var(--crow-accent); }
  .btn-danger { background:var(--crow-error); color:var(--crow-accent-contrast); }
  .btn-danger:hover { filter:brightness(1.1); }
  .btn-ghost { background:transparent; color:var(--crow-text-secondary); }
  .btn-ghost:hover { color:var(--crow-text-primary); background:var(--crow-bg-elevated); }

  /* Code block */
  .code-block { border:1px solid var(--crow-border); border-radius:var(--crow-radius-card);
    overflow:hidden; margin:var(--crow-space-4) 0; background:var(--crow-bg-deep); }
  .code-block-bar { display:flex; align-items:center; justify-content:space-between;
    padding:var(--crow-space-2) var(--crow-space-3); background:var(--crow-bg-elevated);
    border-bottom:1px solid var(--crow-border); }
  .code-lang { font-size:var(--crow-text-xs); color:var(--crow-text-muted); text-transform:uppercase; letter-spacing:0.05em; }
  .code-copy { margin-left:auto; font-size:var(--crow-text-xs); color:var(--crow-text-secondary);
    background:transparent; border:1px solid var(--crow-border); border-radius:var(--crow-radius-control);
    padding:var(--crow-space-1) var(--crow-space-3); cursor:pointer; }
  .code-copy:hover { color:var(--crow-text-primary); border-color:var(--crow-accent); }
  .code-block pre { margin:0; padding:var(--crow-space-3); overflow:auto;
    font-family:'JetBrains Mono',monospace; font-size:var(--crow-text-sm); line-height:var(--crow-leading-normal); }

  /* Callout */
  .callout { border-left:3px solid var(--crow-info); border-radius:var(--crow-radius-control);
    background:var(--crow-bg-elevated); padding:var(--crow-space-3) var(--crow-space-4);
    margin:var(--crow-space-4) 0; font-size:var(--crow-text-base); line-height:var(--crow-leading-normal); }
  .callout-info { border-left-color:var(--crow-info); }
  .callout-success { border-left-color:var(--crow-success); }
  .callout-warning { border-left-color:var(--crow-warning); }
  .callout-error { border-left-color:var(--crow-error); }

  /* Stepper */
  .stepper { display:flex; gap:var(--crow-space-4); list-style:none; padding:0; margin:var(--crow-space-4) 0; flex-wrap:wrap; }
  .stepper .step { display:flex; align-items:center; gap:var(--crow-space-2); font-size:var(--crow-text-sm); color:var(--crow-text-tertiary); }
  .stepper .step-num { display:inline-flex; align-items:center; justify-content:center;
    width:24px; height:24px; border-radius:50%; border:1px solid var(--crow-border);
    font-size:var(--crow-text-xs); }
  .step-done { color:var(--crow-text-secondary); }
  .step-done .step-num { background:var(--crow-accent); color:var(--crow-accent-contrast); border-color:var(--crow-accent); }
  .step-active { color:var(--crow-text-primary); font-weight:500; }
  .step-active .step-num { border-color:var(--crow-accent); color:var(--crow-accent); }

  /* Tabs */
  .tab-list { display:flex; flex-wrap:wrap; gap:var(--crow-space-1); border-bottom:1px solid var(--crow-border); margin-bottom:var(--crow-space-4); }
  .tab-trigger { background:transparent; border:none; border-bottom:2px solid transparent;
    color:var(--crow-text-secondary); font-family:inherit; font-size:var(--crow-text-base);
    padding:var(--crow-space-2) var(--crow-space-4); cursor:pointer; }
  .tab-trigger:hover { color:var(--crow-text-primary); }
  .tab-trigger.tab-active { color:var(--crow-accent); border-bottom-color:var(--crow-accent); }
  .tab-panel { display:none; }
  .tab-panel.tab-active { display:block; }

  /* ─── Responsive overflow (mobile overflow fix, 2026-10) ───
     Wide content must scroll or wrap INSIDE its card, never push past it
     (Pixel 9a: 412px portrait, ~915px landscape with the sidebar open).

     .table-scroll is THE wrapper every dashboard table sits in — dataTable()
     emits it, hand-built tables wrap themselves, renderMarkdown() wraps
     markdown tables, and tests/dashboard-table-scroll.test.js fails on any
     table outside it.

     The scroll hint is drawn ONLY while the wrapper can actually scroll:
     componentsJs() measures each wrapper (ResizeObserver) and toggles
     .is-scrollable. The two "cover" gradients scroll WITH the content
     (local) and hide the edge shadows (scroll) once that edge is reached, so
     a shadow shows only on a side with more table. The covers must match
     what is behind the wrapper: --table-scroll-bg follows context (page
     background vs card) and the script refines it to the wrapper's actual
     backdrop, so no band ever shows. */
  .content-body { --table-scroll-bg: var(--crow-bg-deep); }
  .card, .stat-card { --table-scroll-bg: var(--crow-bg-surface); }
  .table-scroll {
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scrollbar-width: thin;
  }
  .table-scroll.is-scrollable {
    background:
      linear-gradient(to right, var(--table-scroll-bg, var(--crow-bg-surface)) 30%, transparent) left center / 32px 100% no-repeat local,
      linear-gradient(to left, var(--table-scroll-bg, var(--crow-bg-surface)) 30%, transparent) right center / 32px 100% no-repeat local,
      radial-gradient(farthest-side at 0 50%, rgba(0,0,0,0.22), transparent) left center / 12px 100% no-repeat scroll,
      radial-gradient(farthest-side at 100% 50%, rgba(0,0,0,0.22), transparent) right center / 12px 100% no-repeat scroll;
  }
  @media print {
    .table-scroll, .table-scroll.is-scrollable { overflow: visible; background: none; max-width: none; }
  }

  /* Stacked variant (dataTable(..., { stack: true })): when — and only when —
     the table genuinely does not fit a phone-sized container (<= 720px wide),
     componentsJs() adds .is-stacked and each row renders as a small card:
     label / value pairs, action links on one line. Measured, not a fixed
     breakpoint: Skills fits a landscape phone and stays a table; the bot
     list does not and stacks. min-width keeps a stacked list from
     collapsing inside a shrink-to-fit parent. Selectors carry .table-stack
     so they outrank layout.js's .data-table th/td rules (loaded later). */
  .table-stack.is-stacked { min-width: 14rem; }
  .table-stack.is-stacked .data-table--stack, .table-stack.is-stacked .data-table--stack tbody, .table-stack.is-stacked .data-table--stack tr, .table-stack.is-stacked .data-table--stack td { display: block; width: 100%; }
  .table-stack.is-stacked .data-table--stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .table-stack.is-stacked .data-table--stack tr { border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card);
    padding: var(--crow-space-2) var(--crow-space-3); margin-bottom: var(--crow-space-3); }
  .table-stack.is-stacked .data-table--stack tr:hover td { background: transparent; }
  /* Block + floated label (not flex): a cell's mixed inline content (a
     link plus text, a badge) stays one inline run, right-aligned. */
  .table-stack.is-stacked .data-table--stack td { padding: var(--crow-space-1) 0; border-bottom: none; text-align: right; overflow-wrap: anywhere; }
  .table-stack.is-stacked .data-table--stack td::after { content: ""; display: table; clear: both; }
  .table-stack.is-stacked .data-table--stack td::before { content: attr(data-label); float: left; margin-right: var(--crow-space-3); text-align: left;
    font-size: var(--crow-text-xs); color: var(--crow-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .table-stack.is-stacked .data-table--stack td:empty { display: none; }
  .table-stack.is-stacked .data-table--stack td.dt-action { display: inline-block; width: auto; margin-right: var(--crow-space-4); text-align: left; }
  .table-stack.is-stacked .data-table--stack td.dt-action::before, .table-stack.is-stacked .data-table--stack td.dt-action::after { content: none; }
  /* A wide free-text cell (dataTable opts.wide): label on its own line, text
     full width and left-aligned. Unstacked, the column claims a fair share
     of the table and wraps long tokens instead of widening the table. */
  .table-stack.is-stacked .data-table--stack td.dt-wide { text-align: left; }
  .table-stack.is-stacked .data-table--stack td.dt-wide::before { float: none; display: block; margin: 0 0 var(--crow-space-1); }
  .data-table td.dt-wide { width: 45%; overflow-wrap: anywhere; }

  /* Long unbreakable tokens (ids, model ids like crow-local/qwen3.6-35b-a3b,
     hashes, URLs). break-word (inherited) wraps only what would otherwise
     overflow and does NOT change min-content sizing, so tables and flex rows
     size exactly as before. .cell-break / .mono opt a cell into "anywhere",
     which also lets the column itself shrink. Inline code inside a table
     cell is left alone: a cell keeps its tokens intact and the table
     scrolls (Perch's markdown-table rule depends on this). */
  .content-body { overflow-wrap: break-word; }
  .cell-break, .data-table .mono, .content-body :not(pre, td, th) > code { overflow-wrap: anywhere; }

  /* Zero-specificity safety net (:where) — any panel rule overrides it.
     Flex/grid items default to min-width:auto (= their min-content width),
     which is how one long id inflates a whole card. min-width:0 is a no-op
     for every other box. Block containers + form controls only: icons,
     buttons and badges keep their intrinsic size. */
  :where(.content-body) :where(div, section, article, aside, form, fieldset, details, li, label, select, input, textarea) { min-width: 0; }
  :where(.content-body) :where(select) { max-width: 100%; }
  :where(.content-body) :where(img, video, canvas, iframe, embed, object) { max-width: 100%; }
  :where(.content-body) :where(pre) { max-width: 100%; overflow-x: auto; }
  /* Link cards in grids (2026-10): a 1fr track is minmax(auto, 1fr), and
     "auto" is the item's min-content — one long name in one Contacts card (an
     <a>, which the net above does not cover) widened every column to 1108px,
     at phone AND desktop widths. Block containers are already netted above;
     this adds only the <a> children of grid containers. Buttons, badges and
     icons stay excluded, as the net above intends: they keep their intrinsic
     size. A few "*-grid" classes are flex-wrap rows (.ag-grid, .cs-grid,
     .nd-grid); their children are divs, so this is a no-op there. */
  :where(.content-body) :where(.card-grid, .stat-grid, [class$="-grid"], [class*="-grid "], [style*="display:grid"], [style*="display: grid"]) > :where(a:not(.btn, .badge, [class*="btn-"], [class*="badge"])) { min-width: 0; }

  /* Phone rows (2026-10): a panel's own tab / filter / action row is wider
     than a phone once it holds a few items, and with no wrap it pans the whole
     panel sideways (Media's "Feed, For You, Playlists, Briefings…"). On phones
     such rows wrap, like the shared tabs() row (.tab-list) always does:
       - an inline-style flex row whose children include two adjacent
         links/buttons/forms;
       - a row class named *-tabs, *-tabbar, *-nav, *-chips, *-toolbar,
         *-filters or *-pills (the same list tests/dashboard-phone-rows.test.js
         holds the sources to).
     Zero specificity (:where): a row that declares its own flex-wrap keeps
     it, and an inline row that scrolls by itself (overflow-x:auto) is left
     alone. To keep a row on one line, set flex-wrap:nowrap AND
     overflow-x:auto, so it scrolls itself; the source scan rejects nowrap
     alone, which still pans the page. Known limits: a row of a title link
     and a button also matches (on a phone the button drops to a second line
     instead of the title truncating); and the class rule cannot see a
     direction set in a class, so a column flex named like a row (say a
     vertical *-toolbar) must declare flex-wrap:nowrap itself, or a bounded
     height reflows it into extra columns. */
  @media (max-width: 768px) {
    :where(.content-body) :where([style*="display:flex"], [style*="display: flex"], [style*="display:inline-flex"], [style*="display: inline-flex"]):where(:has(> a + a, > button + button, > a + button, > button + a, > form + form)):where(:not([style*="flex-direction:column"], [style*="flex-direction: column"], [style*="overflow-x:auto"], [style*="overflow-x: auto"], [style*="overflow-x:scroll"], [style*="overflow-x: scroll"])) { flex-wrap: wrap; }
    :where(.content-body) :where([class$="-tabs"], [class*="-tabs "], [class$="-tabbar"], [class*="-tabbar "], [class$="-nav"], [class*="-nav "], [class$="-chips"], [class*="-chips "], [class$="-toolbar"], [class*="-toolbar "], [class$="-filters"], [class*="-filters "], [class$="-pills"], [class*="-pills "]) { flex-wrap: wrap; }
  }

  /* ─── Focus-visible baseline (W3-5a) ─── */
  .btn:focus-visible, .btn-primary:focus-visible, .btn-secondary:focus-visible,
  .btn-danger:focus-visible, .btn-ghost:focus-visible, .btn-sm:focus-visible,
  .btn-md:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }
  .sidebar-nav a.nav-item:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }
  input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }
  `;
}

/**
 * Delegated client JS for copy buttons and tab switching. Injected once;
 * idempotent under Turbo Drive via a window flag. No inline onclick.
 */
export function componentsJs() {
  return `<script>
  if (!window.__crowComponentsBound) {
    window.__crowComponentsBound = true;
    document.addEventListener("click", function (e) {
      var copy = e.target.closest("[data-copy]");
      if (copy) {
        var text = copy.getAttribute("data-copy") || "";
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            var prev = copy.textContent; copy.textContent = "Copied"; setTimeout(function () { copy.textContent = prev; }, 1200);
          }).catch(function () {});
        }
        return;
      }
      var tab = e.target.closest("[data-tab]");
      if (tab) {
        var id = tab.getAttribute("data-tab");
        var root = tab.closest(".tabs");
        if (!root) return;
        root.querySelectorAll(".tab-trigger").forEach(function (t) { t.classList.toggle("tab-active", t.getAttribute("data-tab") === id); });
        root.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.toggle("tab-active", p.getAttribute("data-tab-panel") === id); });
      }
    });
  }
  // Table wrappers (.table-scroll): toggle .is-scrollable (draws the edge
  // hint only when there is something to scroll) and, for stacked list
  // tables, .is-stacked when the table genuinely does not fit a phone-sized
  // container. Runs once per document; a MutationObserver on <html> picks up
  // Turbo body swaps and client-built tables. Work is deferred to the next
  // frame so a class toggle never resizes an element mid-callback.
  if (!window.__crowTableScrollBound && "ResizeObserver" in window) {
    window.__crowTableScrollBound = true;
    (function () {
      var STACK_MAX = 720;
      var seen = new WeakSet();
      var pending = new Set();
      var queued = false;
      function backdrop(el) {
        for (var a = el.parentElement; a; a = a.parentElement) {
          var c = getComputedStyle(a).backgroundColor;
          if (c && c !== "transparent" && c.replace(/ /g, "").slice(-3) !== ",0)") return c;
        }
        return "";
      }
      function check(w) {
        if (!w.isConnected) return;
        var t = w.querySelector("table");
        if (w.classList.contains("table-stack") && t) {
          var was = w.classList.contains("is-stacked");
          if (was) w.classList.remove("is-stacked");
          var stack = w.clientWidth > 0 && w.clientWidth <= STACK_MAX && t.offsetWidth > w.clientWidth + 1;
          if (stack) w.classList.add("is-stacked");
        }
        var scrollable = w.scrollWidth > w.clientWidth + 1;
        w.classList.toggle("is-scrollable", scrollable);
        if (scrollable) {
          var bg = backdrop(w);
          if (bg) w.style.setProperty("--table-scroll-bg", bg);
        }
      }
      function flush() { queued = false; var list = Array.from(pending); pending.clear(); list.forEach(check); }
      function queue(w) { pending.add(w); if (!queued) { queued = true; requestAnimationFrame(flush); } }
      var ro = new ResizeObserver(function (entries) {
        entries.forEach(function (en) {
          var w = en.target.classList && en.target.classList.contains("table-scroll") ? en.target : en.target.closest(".table-scroll");
          if (w) queue(w);
        });
      });
      function watch(w) {
        if (seen.has(w)) { queue(w); return; }
        seen.add(w);
        ro.observe(w);
        var t = w.querySelector("table");
        if (t) ro.observe(t);
        queue(w);
      }
      function scan(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.matches(".table-scroll")) watch(root);
        root.querySelectorAll(".table-scroll").forEach(watch);
      }
      new MutationObserver(function (muts) {
        muts.forEach(function (m) { m.addedNodes.forEach(scan); });
      }).observe(document.documentElement, { childList: true, subtree: true });
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () { scan(document.body); });
      } else { scan(document.body); }
    })();
  }
  </script>`;
}
