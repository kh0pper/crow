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
     emits it, hand-built tables wrap themselves, and
     tests/dashboard-table-scroll.test.js fails on any table outside it. The
     background layers are the scroll hint: the two "cover" gradients scroll
     WITH the content (local) and hide the two edge shadows (scroll) when that
     edge is reached, so a shadow shows only on a side that has more table.
     A panel whose table sits on a non-surface background can retint the
     covers with --table-scroll-bg. */
  .table-scroll {
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scrollbar-width: thin;
    background:
      linear-gradient(to right, var(--table-scroll-bg, var(--crow-bg-surface)) 30%, transparent) left center / 32px 100% no-repeat local,
      linear-gradient(to left, var(--table-scroll-bg, var(--crow-bg-surface)) 30%, transparent) right center / 32px 100% no-repeat local,
      radial-gradient(farthest-side at 0 50%, rgba(0,0,0,0.22), transparent) left center / 12px 100% no-repeat scroll,
      radial-gradient(farthest-side at 100% 50%, rgba(0,0,0,0.22), transparent) right center / 12px 100% no-repeat scroll;
  }
  .table-scroll > table { margin-top: 0; }

  /* Stacked variant (dataTable(..., { stack: true })): a list table whose
     container is narrower than 600px renders each row as a small card —
     label / value pairs, action links on one line. A CONTAINER query, not a
     viewport one: on a 915px landscape phone with the sidebar open the card
     is ~570px wide, which a viewport query cannot see. */
  .table-scroll.table-stack { container: crow-table / inline-size; }
  /* Selectors carry .table-stack so they outrank layout.js's .data-table
     th/td rules, which load after this sheet. */
  @container crow-table (max-width: 600px) {
    .table-stack .data-table--stack, .table-stack .data-table--stack tbody, .table-stack .data-table--stack tr, .table-stack .data-table--stack td { display: block; width: 100%; }
    .table-stack .data-table--stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .table-stack .data-table--stack tr { border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card);
      padding: var(--crow-space-2) var(--crow-space-3); margin-bottom: var(--crow-space-3); }
    .table-stack .data-table--stack tr:hover td { background: transparent; }
    /* Block + floated label (not flex): a cell's mixed inline content (a
       link plus text, a badge) stays one inline run, right-aligned. */
    .table-stack .data-table--stack td { padding: var(--crow-space-1) 0; border-bottom: none; text-align: right; overflow-wrap: anywhere; }
    .table-stack .data-table--stack td::after { content: ""; display: table; clear: both; }
    .table-stack .data-table--stack td::before { content: attr(data-label); float: left; margin-right: var(--crow-space-3); text-align: left;
      font-size: var(--crow-text-xs); color: var(--crow-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .table-stack .data-table--stack td:empty { display: none; }
    .table-stack .data-table--stack td.dt-action { display: inline-block; width: auto; margin-right: var(--crow-space-4); text-align: left; }
    .table-stack .data-table--stack td.dt-action::before, .table-stack .data-table--stack td.dt-action::after { content: none; }
  }

  /* Long unbreakable tokens (ids, model ids like crow-local/qwen3.6-35b-a3b,
     hashes, URLs). break-word (inherited) wraps only what would otherwise
     overflow and does NOT change min-content sizing, so tables and flex rows
     size exactly as before. .cell-break / .mono opt a cell into "anywhere",
     which also lets the column itself shrink. */
  .content-body { overflow-wrap: break-word; }
  .cell-break, .data-table .mono, .content-body :not(pre) > code { overflow-wrap: anywhere; }

  /* Zero-specificity safety net (:where) — any panel rule overrides it.
     Flex/grid items default to min-width:auto (= their min-content width),
     which is how one long id inflates a whole card. min-width:0 is a no-op
     for every other box. Block containers + form controls only: icons,
     buttons and badges keep their intrinsic size. */
  :where(.content-body) :where(div, section, article, aside, form, fieldset, details, li, label, select, input, textarea) { min-width: 0; }
  :where(.content-body) :where(select) { max-width: 100%; }
  :where(.content-body) :where(img, video, canvas, iframe, embed, object) { max-width: 100%; }
  :where(.content-body) :where(pre) { max-width: 100%; overflow-x: auto; }

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
  </script>`;
}
