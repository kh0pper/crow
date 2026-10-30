/**
 * For You styles (For You v1). Every rule is scoped under .fy, so the page reads the same in the
 * new shell and in classic. Phone first (390 px): one column, every target at least 44 px; from
 * 1024 px the column is capped so lines stay readable. Colours and radii are the --crow-* tokens,
 * which follow the OS between light and dark.
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */
export function forYouCss() {
  return `<style>
  .fy { max-width: 44rem; min-width: 0; display: flex; flex-direction: column; gap: 16px; color: var(--crow-text-primary); }
  .fy-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .fy-custom .fy-head { justify-content: flex-start; }
  .fy-head-text { min-width: 0; }
  .fy-date { margin: 0; font-size: 0.85rem; color: var(--crow-text-secondary); }
  .fy-title { margin: 0; font-size: 1.5rem; font-weight: 700; line-height: 1.2; }
  .fy-title--sub { font-size: 1.25rem; }
  .fy-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .fy-chip {
    display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px; font-size: 0.85rem; white-space: nowrap;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-pill); background: var(--crow-bg-surface); color: var(--crow-text-secondary);
  }
  .fy-icon-btn {
    display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; flex-shrink: 0;
    border: 1px solid var(--crow-border); border-radius: 50%; background: var(--crow-bg-surface); color: var(--crow-text-primary); text-decoration: none;
  }
  .fy-wx { margin: -8px 0 0; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 0.85rem; color: var(--crow-text-secondary); }
  .fy-attrib { font-size: 0.75rem; color: var(--crow-text-tertiary, var(--crow-text-secondary)); }
  .fy-quiet { align-self: flex-start; display: inline-flex; align-items: center; min-height: 44px; margin-top: -8px; font-size: 0.85rem; color: var(--crow-text-secondary); }
  .fy-card {
    margin: 0; padding: 14px; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px);
    background: var(--crow-bg-surface); min-width: 0;
  }
  .fy-morning { background: var(--crow-accent-muted); border-color: var(--crow-accent); }
  .fy-kicker { margin: 0; padding: 0; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--crow-text-secondary); }
  .fy-sum { margin: 6px 0 0; font-size: 1rem; line-height: 1.5; }
  .fy-lines { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; }
  .fy-line { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 4px 0; color: var(--crow-text-primary); text-decoration: none; }
  .fy-line:hover .fy-line-title { text-decoration: underline; }
  .fy-line-text { display: flex; flex-direction: column; min-width: 0; }
  .fy-line-tag { font-size: 0.75rem; color: var(--crow-text-secondary); }
  .fy-line-title { font-size: 0.95rem; overflow-wrap: anywhere; }
  .fy-line-proj { color: var(--crow-text-secondary); }
  .fy-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .fy-dot--needs { background: var(--crow-warning); }
  .fy-dot--due { background: var(--crow-error); }
  .fy-dot--done { background: var(--crow-success); }
  .fy-dot--left { background: var(--crow-text-secondary); }
  .fy-more-link { display: inline-flex; align-items: center; min-height: 44px; font-size: 0.9rem; color: var(--crow-accent); }
  .fy-news { display: flex; flex-direction: column; gap: 12px; }
  .fy-news-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .fy-news-count { font-size: 0.8rem; color: var(--crow-text-secondary); }
  .fy-stories { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
  .fy-story-open {
    display: flex; flex-direction: column; gap: 6px; width: 100%; min-height: 44px; padding: 14px; text-align: left; font: inherit; cursor: pointer;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 16px); background: var(--crow-bg-surface); color: var(--crow-text-primary);
  }
  .fy-story-title { font-size: 1rem; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
  .fy-story-sum { font-size: 0.875rem; line-height: 1.45; color: var(--crow-text-secondary); overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .fy-story-meta { font-size: 0.8rem; color: var(--crow-text-secondary); overflow-wrap: anywhere; }
  .fy-note { margin: 0; font-size: 0.9rem; color: var(--crow-text-secondary); line-height: 1.45; }
  .fy-btn {
    display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; box-sizing: border-box;
    border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-pill); background: transparent;
    color: var(--crow-text-primary); font: inherit; font-size: 0.9rem; text-decoration: none; cursor: pointer; text-align: center;
  }
  .fy-btn--primary { background: var(--crow-accent); border-color: var(--crow-accent); color: var(--crow-accent-contrast); font-weight: 600; }
  .fy-btn[disabled] { opacity: 0.55; cursor: default; }
  .fy-sheet {
    margin: auto auto 0; width: 100%; max-width: 40rem; max-height: 90vh; padding: 0; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-bottom: 0; border-radius: 20px 20px 0 0;
    background: var(--crow-bg-surface); color: var(--crow-text-primary);
  }
  .fy-sheet::backdrop { background: rgba(0, 0, 0, 0.45); }
  .fy-sheet-inner { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 18px 16px calc(24px + env(safe-area-inset-bottom, 0px)); }
  .fy-sheet-close {
    position: absolute; top: 8px; right: 8px; width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: 50%; background: transparent; color: var(--crow-text-secondary); cursor: pointer;
  }
  .fy-sheet-title { margin: 0 44px 0 0; font-size: 1.1rem; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
  .fy-sheet-meta { margin: 0; font-size: 0.85rem; color: var(--crow-text-secondary); }
  .fy-why { padding: 12px; border: 1px solid var(--crow-border); border-radius: 12px; background: var(--crow-bg-deep, var(--crow-bg-surface)); }
  .fy-why p:last-child { margin: 4px 0 0; font-size: 0.9rem; line-height: 1.45; }
  .fy-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .fy-acts .fy-btn:last-child { grid-column: 1 / -1; }
  .fy-status { margin: 0; min-height: 1.2em; font-size: 0.9rem; color: var(--crow-text-secondary); }
  .fy-form { display: flex; flex-direction: column; gap: 12px; }
  .fy-hint { margin: 6px 0 0; font-size: 0.85rem; color: var(--crow-text-secondary); line-height: 1.45; }
  .fy-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; border-top: 1px solid var(--crow-border); cursor: pointer; }
  .fy-toggle:first-of-type { border-top: 0; }
  .fy-toggle input { width: 24px; height: 24px; margin: 10px; accent-color: var(--crow-accent); }
  .fy-input {
    display: block; width: 100%; box-sizing: border-box; min-height: 44px; margin-top: 8px; padding: 0 12px; font: inherit;
    border: 1px solid var(--crow-border-strong, var(--crow-border)); border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-bg-deep, var(--crow-bg-surface)); color: var(--crow-text-primary);
  }
  .fy-banner { margin: 0; padding: 10px 12px; border: 1px solid var(--crow-border); border-radius: 12px; background: var(--crow-accent-muted); overflow-wrap: anywhere; }
  .fy-hidden { list-style: none; margin: 8px 0 0; padding: 0; }
  .fy-hidden-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; border-top: 1px solid var(--crow-border); overflow-wrap: anywhere; }
  .fy-hidden-row:first-child { border-top: 0; }
  .fy a:focus-visible, .fy button:focus-visible, .fy input:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  /* The page's own heading names it: the shell header's title stays for screen readers only. */
  body.shell:has([data-fy]) .content-header h2 {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  @media (min-width: 1024px) { .fy-sheet { margin: auto; border-bottom: 1px solid var(--crow-border); border-radius: 20px; } }
</style>`;
}
