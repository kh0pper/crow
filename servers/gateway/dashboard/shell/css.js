/**
 * The new shell's CSS (redesign P2). Appended to the head after the classic
 * dashboardCss() on shell pages only, and every selector starts with
 * body.shell, so a classic page can never match one of these rules
 * (tests/shell-layout-render.test.js "every shell rule is scoped").
 *
 * Colors come from the --crow-* tokens (design-tokens.js), which already
 * follow the OS between light and dark. Phone first: at ≤1023px the tabs are
 * a fixed bottom bar whose height is published as --shell-tabs-h; at
 * ≥1024px they become a left rail that also lists the projects, and
 * --shell-tabs-h is 0. The Perch app-shell rule in layout.js subtracts
 * --shell-tabs-h from its height, so an open Perch chat ends on top of the
 * bar; only while an on-screen keyboard is up does Perch set it to 0 and
 * hide the bar (perch-hub/css.js, body[data-perch-kb]).
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */

export const SHELL_RAIL_WIDTH = 232;

export function shellCss() {
  return `<style>
  body.shell {
    --shell-tabs-h: calc(56px + env(safe-area-inset-bottom, 0px));
    --shell-rail-w: 0px;
    /* Project dots. Contrast against the drawer/rail background
       (--crow-bg-surface #ffffff): 5.52, 6.00, 5.04, 4.92, 5.63, 5.48. */
    --shell-project-c1: #b4442b;
    --shell-project-c2: #8f5606;
    --shell-project-c3: #2f7d4f;
    --shell-project-c4: #2b7a8c;
    --shell-project-c5: #4f5fc0;
    --shell-project-c6: #9a4a9c;
  }
  /* Dark (--crow-bg-surface #1b242b): 6.42, 6.94, 7.18, 7.17, 6.61, 7.24. */
  @media (prefers-color-scheme: dark) {
    body.shell {
      --shell-project-c1: #f08a6e;
      --shell-project-c2: #e0a03c;
      --shell-project-c3: #5fc28a;
      --shell-project-c4: #52bdd1;
      --shell-project-c5: #97a3f0;
      --shell-project-c6: #d79be0;
    }
  }
  /* The sidebar is not rendered: the column takes the whole width. */
  body.shell .main-content { margin-left: var(--shell-rail-w); }
  body.shell .content-body { padding-bottom: var(--shell-tabs-h,0px); }
  /* Perch's app shell already ends above the bar through its height rule
     (layout.js): reserving the bar again here would leave a gap. */
  body.shell:has(#perch-chat) .content-body { padding-bottom: 0; }
  /* Toasts float above the tab bar, not under it. */
  body.shell .crow-toasts { bottom: calc(1.5rem + var(--crow-player-h,0px) + var(--shell-tabs-h,0px)); }
  body.shell .content-header { gap: 0.5rem; padding-left: 16px; padding-right: 16px; }
  body.shell .content-header h2 {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ─── Header: project chip + avatar ─── */
  body.shell .shell-scope {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    max-width: 40vw;
    padding: 0 12px;
    border: 1px solid var(--crow-border);
    border-radius: var(--crow-radius-pill);
    background: var(--crow-bg-surface);
    color: var(--crow-text-primary);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 1;
    min-width: 0;
  }
  body.shell .shell-scope-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  body.shell .shell-scope svg { flex-shrink: 0; color: var(--crow-text-secondary); }
  body.shell .shell-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border: none;
    border-radius: 50%;
    background: var(--crow-accent-muted);
    color: var(--crow-accent);
    cursor: pointer;
  }
  /* The header bird (tap → tray, long-press → Talk to Crow) is 42px wide on
     its own; the shell's touch rule is 44 in both directions. */
  body.shell .crow-tama-btn { min-width: 44px; min-height: 44px; justify-content: center; }
  body.shell .shell-scope:focus-visible,
  body.shell .shell-avatar:focus-visible,
  body.shell .shell-tab:focus-visible,
  body.shell .shell-project:focus-visible,
  body.shell .shell-sheet-link:focus-visible,
  body.shell .shell-more-item:focus-visible {
    outline: 2px solid var(--crow-accent);
    outline-offset: 2px;
  }

  /* ─── Tabs: a bottom bar on phones and tablets ─── */
  body.shell .shell-tabs {
    position: fixed;
    left: 0;
    right: 0;
    bottom: var(--crow-player-h,0px);
    z-index: 900;
    height: var(--shell-tabs-h);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    box-sizing: border-box;
    background: var(--crow-bg-surface);
    border-top: 1px solid var(--crow-border);
  }
  /* Three flex:1 tabs of min-width 44px fit any phone; wrap only says so
     to the phone-row guard (tests/dashboard-phone-rows.test.js). */
  body.shell .shell-tab-list {
    display: flex;
    flex-wrap: wrap;
    height: 56px;
  }
  body.shell .shell-tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-width: 44px;
    min-height: 44px;
    color: var(--crow-text-secondary);
    font-size: 0.75rem;
    font-weight: 500;
    text-decoration: none;
  }
  body.shell .shell-tab:hover { color: var(--crow-text-primary); }
  body.shell .shell-tab[aria-current="page"] { color: var(--crow-accent); font-weight: 600; }
  body.shell .shell-rail-mark,
  body.shell .shell-rail-projects { display: none; }

  /* ─── Drawer + avatar sheet ─── */
  body.shell .shell-sheet {
    border: none;
    padding: 0;
    margin: auto auto 0;
    width: 100%;
    max-width: 480px;
    max-height: 85dvh;
    border-radius: var(--crow-radius-card) var(--crow-radius-card) 0 0;
    background: var(--crow-bg-surface);
    color: var(--crow-text-primary);
    box-shadow: 0 -8px 32px rgba(0,0,0,0.18);
  }
  body.shell .shell-sheet::backdrop { background: rgba(0,0,0,0.4); }
  body.shell .shell-sheet-inner {
    padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  body.shell .shell-sheet-close {
    align-self: flex-end;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin: -8px -8px 0 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--crow-text-secondary);
    cursor: pointer;
  }
  body.shell .shell-sheet-close:hover { background: var(--crow-bg-elevated); color: var(--crow-text-primary); }
  body.shell .shell-sheet-close:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  /* The "Notifications and settings" sheet holds the mascot's tray
     (notifications.js): shown in place, whatever the tray's own inline
     display says (its classic open/close toggles keep running), and drawn
     as part of the sheet rather than as a floating dropdown. */
  body.shell .shell-crow-tray .crow-dropdown,
  body.shell .shell-crow-tray .header-dropdown {
    display: block !important;
    position: static;
    min-width: 0;
    max-width: none;
    width: auto;
    border: none;
    border-radius: 0;
    box-shadow: none;
    background: transparent;
    animation: none;
  }
  body.shell .shell-crow-tray .dropdown-title { padding-left: 0; padding-right: 0; }
  body.shell .shell-crow-tray .crow-health-bar { padding-left: 0; padding-right: 0; }
  body.shell .shell-crow-tray .dropdown-body { padding-left: 0; padding-right: 0; max-height: 40dvh; }
  body.shell .shell-crow-tray .dropdown-title .btn { min-height: 44px; min-width: 44px; }
  body.shell .shell-crow-sep { width: 100%; margin: 8px 0 0; border: none; border-top: 1px solid var(--crow-border); }
  /* "Needs attention" (attention.js): a grid per row, the dot beside the text
     and the actions on their own line under it, aligned with the text. */
  body.shell .shell-attn-list { list-style: none; margin: 0; padding: 0; }
  body.shell .shell-attn-row {
    display: grid;
    grid-template-columns: 10px minmax(120px, 1fr);
    column-gap: 10px;
    align-items: start;
    padding: 10px 0;
    border-bottom: 1px solid var(--crow-border);
  }
  body.shell .shell-attn-row:last-child { border-bottom: 0; }
  body.shell .shell-attn-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; background: var(--crow-text-muted); }
  body.shell .shell-attn-dot--warn { background: var(--crow-warning, #d9a521); }
  body.shell .shell-attn-dot--info { background: var(--crow-accent); }
  body.shell .shell-attn-text { min-width: 120px; overflow-wrap: break-word; color: var(--crow-text-primary); line-height: 1.4; }
  body.shell .shell-attn-acts { grid-column: 2; display: flex; flex-wrap: wrap; gap: 4px 8px; }
  body.shell .shell-attn-form { margin: 0; }
  body.shell .shell-attn-action,
  body.shell .shell-attn-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    color: var(--crow-accent);
    text-decoration: underline;
    cursor: pointer;
  }
  body.shell .shell-attn-btn--quiet { color: var(--crow-text-secondary); }
  body.shell .shell-attn-heading { margin-top: 4px; }
  /* The no-showModal fallback (open attribute only): pin the sheet on top. */
  body.shell .shell-sheet[open]:not(:modal) { position: fixed; inset: auto 0 0; z-index: 1200; }
  body.shell .shell-heading {
    margin: 8px 0 0;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--crow-text-muted);
  }
  body.shell .shell-projects { display: flex; flex-direction: column; gap: 4px; }
  body.shell .shell-project,
  body.shell .shell-sheet-link {
    display: flex;
    align-items: center;
    min-height: 44px;
    width: 100%;
    padding: 0 12px;
    border: none;
    border-radius: var(--crow-radius-control);
    background: transparent;
    color: var(--crow-text-primary);
    font: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }
  body.shell .shell-project:hover,
  body.shell .shell-sheet-link:hover { background: var(--crow-bg-elevated); color: var(--crow-text-primary); }
  body.shell .shell-project.is-current { background: var(--crow-accent-muted); color: var(--crow-accent); font-weight: 600; }
  body.shell .shell-project-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-right: 10px; }
  body.shell .shell-project-text { display: flex; flex-direction: column; min-width: 0; }
  body.shell .shell-project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  body.shell .shell-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  body.shell .shell-project-sub { font-size: 0.75rem; font-weight: 400; color: var(--crow-text-secondary); }
  body.shell .shell-project--edge .shell-project-name { color: var(--crow-text-secondary); }
  body.shell .shell-more-row summary { list-style: none; }
  body.shell .shell-more-row summary::-webkit-details-marker { display: none; }
  body.shell .shell-more-row[open] .shell-more { margin: 4px 0 8px; }
  body.shell .shell-mode-form { margin: 0; }
  body.shell .shell-more {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  body.shell .shell-more-item {
    display: flex;
    align-items: center;
    min-height: 44px;
    padding: 8px 12px;
    border: 1px solid var(--crow-border);
    border-radius: var(--crow-radius-control);
    color: var(--crow-text-primary);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  body.shell .shell-more-item:hover { border-color: var(--crow-accent); color: var(--crow-accent); }

  /* ─── The drawer's Apps launcher (R1.2 PR 5), also the grid in a session's apps sheet ─── */
  body.shell .shell-apps { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 8px; }
  body.shell .shell-apps-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  body.shell .shell-apps-chip {
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--crow-border);
    border-radius: 999px;
    background: transparent;
    color: var(--crow-text-primary);
    font: inherit;
    cursor: pointer;
  }
  body.shell .shell-apps-chip[aria-pressed="true"] { background: var(--crow-accent-muted); border-color: var(--crow-accent); color: var(--crow-accent); font-weight: 600; }
  body.shell .shell-apps-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  body.shell .shell-apps-grid[hidden] { display: none; }
  body.shell .shell-app {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 0;
    min-height: 44px;
    padding: 6px 2px;
    border-radius: var(--crow-radius-control);
    color: var(--crow-text-primary);
    font-size: 0.75rem;
    line-height: 1.2;
    text-align: center;
    text-decoration: none;
  }
  body.shell .shell-app:hover { background: var(--crow-bg-elevated); color: var(--crow-text-primary); }
  body.shell .shell-app-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border: 1px solid var(--crow-border);
    border-radius: 12px;
    background: var(--crow-bg-elevated);
    color: var(--crow-accent);
  }
  body.shell .shell-app-icon svg { width: 24px; height: 24px; }
  body.shell .shell-app-label { max-width: 100%; overflow-wrap: anywhere; }
  body.shell .shell-apps-empty { grid-column: 1 / -1; margin: 0; color: var(--crow-text-secondary); font-size: 0.9rem; line-height: 44px; }
  body.shell .shell-apps-empty a,
  body.shell .shell-apps-goto {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 4px;
    border: none;
    background: none;
    color: var(--crow-accent);
    font: inherit;
    line-height: normal;
    text-decoration: underline;
    cursor: pointer;
  }
  body.shell .shell-apps-chip:focus-visible,
  body.shell .shell-app:focus-visible,
  body.shell .shell-apps-goto:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }

  /* ─── Phones: the header row is the chip and the mascot only ───
     (phone review 2026-10-29). The page title leaves the row: on a page
     with its own tab (Chat, Board, Make) the chip and the lit tab already
     say where you are, so it is for screen readers only; on any other page
     (Bot Builder, Models, Settings…) it is the page's own heading on a line
     of its own under the row. Either way the chip gets the room it needs.
     The same breakpoint as the bottom bar: below the desktop rail. */
  @media (max-width: 1023px) {
    body.shell .content-header { flex-wrap: wrap; row-gap: 6px; }
    body.shell .content-header h2 {
      order: 10;
      flex: 1 0 100%;
      white-space: normal;
      overflow-wrap: anywhere;
      overflow: visible;
    }
    body.shell .content-header.shell-header--tab h2 {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
    }
    /* Room for the header icons: the mascot, or the bell variant's two. */
    body.shell .shell-scope { max-width: calc(100vw - 32px - 2 * 44px - 1.5rem); flex: 0 1 auto; }
  }

  /* ─── Desktop: the tabs become a left rail with the project list ─── */
  @media (min-width: 1024px) {
    body.shell {
      --shell-tabs-h: 0px;
      --shell-rail-w: ${SHELL_RAIL_WIDTH}px;
    }
    body.shell .shell-tabs {
      top: 0;
      right: auto;
      bottom: var(--crow-player-h,0px);
      width: var(--shell-rail-w);
      height: auto;
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      overflow-y: auto;
      border-top: none;
      border-right: 1px solid var(--crow-border);
    }
    body.shell .shell-rail-mark {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 8px;
      font-weight: 600;
      font-size: 1.1rem;
    }
    body.shell .shell-tab-list { flex-direction: column; height: auto; gap: 2px; }
    body.shell .shell-tab {
      flex: none;
      flex-direction: row;
      justify-content: flex-start;
      gap: 12px;
      padding: 0 12px;
      border-radius: var(--crow-radius-control);
      font-size: 0.95rem;
    }
    body.shell .shell-tab[aria-current="page"] { background: var(--crow-accent-muted); }
    body.shell .shell-rail-projects { display: block; }
    body.shell .shell-sheet { margin: auto; border-radius: var(--crow-radius-card); }
  }
  </style>`;
}
