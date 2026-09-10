/**
 * The Perch stylesheet, ported from the deleted perch-hub bundle
 * (42f39160^:bundles/perch-hub/payload/hub/server.mjs, PERCH_CSS), then
 * re-scoped under #perch-hub-root when Perch moved from its own standalone
 * document into the dashboard shell (dashboard/panels/perch-hub.js renders
 * it via layout() now, not perchHubDocument()).
 *
 * Every selector below is scoped under #perch-hub-root. The original,
 * standalone-page version used bare `body`, `*`, `header`, `h2`, `button`,
 * `input`, `textarea` and generic class names like `.title`/`.meta`/
 * `.state`/`.field` — safe when Perch owned the whole document, but the
 * dashboard shell has its OWN `<header class="content-header">`, its own
 * buttons (the hamburger, nav items), its own inputs, and other panels use
 * `.title`-shaped class names too. Left unscoped, Perch's own-palette rules
 * (var(--sky) etc., not crow's --crow-* tokens — that palette is the look
 * this page exists to restore) would leak onto the sidebar and every other
 * panel. Scoping is what makes "render through layout()" safe to do at all.
 *
 * ID selectors (#perch-list, #perch-chat, #perch-transcript, #perch-composer,
 * #perch-back) are left unprefixed — they're already unique in the page.
 */
export function perchHubCss() {
  return `
#perch-hub-root{--sky:#eef1f3;--card:#fff;--ink:#22303a;--dim:#6b7c88;--teal:#0e6b62;--teal-soft:#dcecea;
--wire:#94a4ae;--alive:#2fa36b;--attn:#d1633e;--line:#dde4e8}
@media (prefers-color-scheme:dark){#perch-hub-root{--sky:#131a1f;--card:#1b242b;--ink:#e4ebef;--dim:#8fa0ab;
--teal:#4fbdb0;--teal-soft:#16322f;--wire:#46565f;--line:#2a353d}}
#perch-hub-root,#perch-hub-root *{box-sizing:border-box;margin:0}
/* #perch-hub-root is the flex-column height owner for its two children
   (the small header block above, and .hub-split below) — this is what lets
   .hub-split hand a definite height down to #perch-chat, which is what lets
   #perch-transcript be the thing that scrolls instead of the page (see
   layout.js's "body:has(#perch-chat)" rules, which give .content-body the
   fixed height #perch-hub-root's 100% resolves against). No outer padding
   here — the shell's own .content-body already insets the panel. */
#perch-hub-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--sky);color:var(--ink);font:15px/1.5 Inter,"Public Sans",system-ui,sans-serif;max-width:640px;margin:0 auto}
/* The .brand block this header used to carry is gone: the dashboard
   shell's own .content-header already renders <h2>Perch</h2>, so the two
   titles stacked. What is left is the back-to-the-board link, so the padding no
   longer has to clear a 26px wordmark, and margin-left:auto keeps the link
   on the right now that space-between has only one child to distribute. */
#perch-hub-root header{padding:4px 0 16px;display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;flex-shrink:0}
#perch-hub-root .machines{display:flex;gap:6px;font-size:13px;margin-left:auto}
#perch-hub-root .machines a{text-decoration:none;color:var(--dim);padding:5px 12px;border-radius:999px;border:1px solid var(--line)}
#perch-hub-root a:focus-visible,#perch-hub-root button:focus-visible,#perch-hub-root input:focus-visible,#perch-hub-root textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
#perch-hub-root h2{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);font-weight:600;margin:30px 0 12px}
#perch-hub-root .perch-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
#perch-hub-root .title{font-weight:600;font-size:17px}
#perch-hub-root .meta{color:var(--dim);font-size:13px;margin-top:2px;word-break:break-all}
#perch-hub-root .state{font-size:13px;color:var(--alive);font-weight:500;white-space:nowrap}
#perch-hub-root button{font:500 14px/1 Inter,system-ui,sans-serif;cursor:pointer;border-radius:10px;padding:10px 16px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
#perch-hub-root button.primary{background:var(--teal);border-color:var(--teal);color:#fff}
#perch-hub-root button.quiet{color:var(--dim)}
#perch-hub-root input,#perch-hub-root textarea{font:14px Inter,system-ui,sans-serif;width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--sky);color:var(--ink)}
#perch-hub-root input::placeholder,#perch-hub-root textarea::placeholder{color:var(--dim)}
#perch-hub-root .roost-row{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
#perch-hub-root .roost-row:last-child{border-bottom:none}
#perch-hub-root .roost-dot{width:8px;height:8px;border-radius:50% 50% 50% 2px;background:var(--wire);flex-shrink:0;transform:rotate(-8deg)}
#perch-hub-root .roost-main{flex:1;min-width:180px}
#perch-hub-root .roost-cwd{font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#perch-hub-root .roost-when{color:var(--dim);font-size:12.5px;font-family:"JetBrains Mono",ui-monospace,monospace}
#perch-hub-root .roost-row button{padding:8px 12px;font-size:13px}
#perch-hub-root .empty{color:var(--dim);padding:16px;font-size:14px}
/* --- chat transcript + ask cards, ported from the deleted bundle's own
   equivalents (42f39160^:bundles/perch-hub/payload/hub/bots-page.mjs
   .entry/.entry .who/.entry .what/.ask-card/.ask-card .title/
   .ask-card .ask-message) and renamed onto the classes THIS script emits
   (entry/who/what/ask-card/ask-title/ask-message/ask-controls — the bundle's
   own ask card nested a bare .title and used .ask-opts for the button row). */
#perch-hub-root .entry{display:flex;gap:10px;font-size:14px}
#perch-hub-root .who{flex:0 0 64px;font:11px/1.6 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;color:var(--dim)}
#perch-hub-root .entry.user .who{color:var(--teal)}
#perch-hub-root .what{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
#perch-hub-root .note{color:var(--dim);font-size:12.5px;font-style:italic}
#perch-hub-root .ask-card{border:1px solid var(--line);border-radius:10px;padding:11px 12px;display:grid;gap:8px;background:var(--sky)}
#perch-hub-root .ask-title{font-weight:600}
#perch-hub-root .ask-message{white-space:pre-wrap}
#perch-hub-root .ask-controls{display:flex;flex-wrap:wrap;gap:6px}
/* --- hub layout ------------------------------------------------------- */
/* Two views, one at a time on a phone, side by side on a wide screen.
   List is the default (no attribute needed): the old standalone page
   hardcoded <body data-view="list">, but now client.js's setView() only
   ever WRITES the "chat"/"list" attribute onto the shared dashboard body —
   it never gets to choose that body's initial server-rendered value, so
   the CSS default (attribute absent) has to already mean "list". */
#perch-list{display:block;flex:1;min-height:0;overflow-y:auto}
#perch-chat{display:none}
body[data-view="chat"] #perch-list{display:none}
body[data-view="chat"] #perch-chat{display:flex;flex-direction:column;flex:1;min-height:0}
#perch-hub-root .hub-split{display:flex;flex-direction:column;flex:1;min-height:0}
#perch-transcript{flex:1;overflow:auto;min-height:0;display:grid;gap:9px;padding:12px 0}
/* Send must be reachable at ANY scroll position, not only at the bottom of a
   long transcript. That was the drawer's defining mobile failure — but this
   rule is the BACKSTOP for it, not the mechanism. In the shipped
   configuration sticky moves Send by zero pixels: the flex chain above
   (#perch-chat{flex:1;min-height:0} + #perch-transcript{min-height:0},
   resolving against the definite height layout.js's "body:has(#perch-chat)"
   rules give .content-body) already keeps .content-body from scrolling at
   all, so there is nothing for the composer to stick against. Measured at
   412x730 and 1280x900: sticky on vs position:static is pixel-identical
   here. Sticky earns its place only once that flex chain breaks — chain
   broken + sticky = Send still on screen; chain broken + static = Send
   ~3000px below the fold. Keep both rules; neither is dead. */
#perch-composer{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 0;display:grid;gap:8px}
#perch-composer .send-row{display:flex;gap:8px}
#perch-composer textarea{min-height:72px}
#perch-back{align-self:flex-start}
#perch-hub-root .field-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:10px 0}
#perch-hub-root .field{display:flex;flex-direction:column;gap:3px;flex:1 1 150px;min-width:0}
#perch-hub-root .field-label{font:11px/1 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
@media (min-width:900px){
  #perch-hub-root{max-width:1100px}
  body[data-view="chat"] #perch-list{display:block}
  #perch-hub-root .hub-split{display:grid;grid-template-columns:320px 1fr;gap:20px;align-items:stretch}
  #perch-back{display:none}
}
`;
}
