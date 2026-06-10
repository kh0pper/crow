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
    border-radius:var(--crow-radius-pill); border:1px solid transparent;
    cursor:pointer; text-decoration:none; transition:background .15s,border-color .15s,color .15s; }
  .btn-md { padding:var(--crow-space-2) var(--crow-space-4); }
  .btn-sm { padding:var(--crow-space-1) var(--crow-space-3); font-size:var(--crow-text-sm); }
  .btn-primary { background:var(--crow-accent); color:#fff; }
  .btn-primary:hover { background:var(--crow-accent-hover); }
  .btn-secondary { background:var(--crow-bg-elevated); color:var(--crow-text-primary); border-color:var(--crow-border); }
  .btn-secondary:hover { border-color:var(--crow-accent); }
  .btn-danger { background:var(--crow-error); color:#fff; }
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
    background:transparent; border:1px solid var(--crow-border); border-radius:var(--crow-radius-pill);
    padding:var(--crow-space-1) var(--crow-space-3); cursor:pointer; }
  .code-copy:hover { color:var(--crow-text-primary); border-color:var(--crow-accent); }
  .code-block pre { margin:0; padding:var(--crow-space-3); overflow:auto;
    font-family:'JetBrains Mono',monospace; font-size:var(--crow-text-sm); line-height:var(--crow-leading-normal); }

  /* Callout */
  .callout { border-left:3px solid var(--crow-info); border-radius:var(--crow-radius-pill);
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
  .step-done .step-num { background:var(--crow-accent); color:#fff; border-color:var(--crow-accent); }
  .step-active { color:var(--crow-text-primary); font-weight:500; }
  .step-active .step-num { border-color:var(--crow-accent); color:var(--crow-accent); }

  /* Tabs */
  .tab-list { display:flex; gap:var(--crow-space-1); border-bottom:1px solid var(--crow-border); margin-bottom:var(--crow-space-4); }
  .tab-trigger { background:transparent; border:none; border-bottom:2px solid transparent;
    color:var(--crow-text-secondary); font-family:inherit; font-size:var(--crow-text-base);
    padding:var(--crow-space-2) var(--crow-space-4); cursor:pointer; }
  .tab-trigger:hover { color:var(--crow-text-primary); }
  .tab-trigger.tab-active { color:var(--crow-accent); border-bottom-color:var(--crow-accent); }
  .tab-panel { display:none; }
  .tab-panel.tab-active { display:block; }
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
