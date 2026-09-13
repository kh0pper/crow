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
/** The split-view breakpoint, in px. EXPORTED because the client script needs
 *  the same number: at and above this width `.hub-split` is a two-column grid
 *  and the session list stays on screen while a chat is open, so the list must
 *  keep polling there. A second hardcoded 900 in client.js would go stale the
 *  first time this one moved. */
export const PERCH_SPLIT_MIN_WIDTH = 900;

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
/* wrap: at 412px the bot name, the state word and Close must not force a
   horizontal scrollbar onto the chat column. */
#perch-hub-root .perch-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
/* TWO ids, deliberately. A bare "#perch-close" is (1,0,0) and LOSES to
   "#perch-hub-root button" at (1,0,1) further down this sheet — the first
   version of this rule was dead, and the irreversible control measured 36px
   live while the launch buttons it shipped alongside measured 44px. Verified
   by computed style at 412x730, not by reading the cascade. */
#perch-hub-root #perch-close{white-space:nowrap;padding:8px 12px;font-size:13px;min-height:44px}
/* Rename: same two-id rule and the same 44px floor, for the same reason. It is
   NOT destructive, so unlike Close it needs no confirmation — but a thumb has
   to be able to hit it. */
#perch-hub-root #perch-rename{white-space:nowrap;padding:8px 12px;font-size:13px;min-height:44px}
/* The operator's session name, in the chat header and on a list row. Clipped
   the same way .roost-cwd is: a name is free text and must not be able to give
   the 320px list column a horizontal scrollbar. */
#perch-hub-root .session-name{font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#perch-hub-root .roost-name{font-weight:500;font-size:14px;color:var(--teal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#perch-hub-root .perch-head [hidden],#perch-hub-root .roost-main [hidden]{display:none}
/* The unconditional launcher. Wraps rather than overflowing on a phone, and
   its select is capped so a long bot name cannot push the button off-screen. */
#perch-launch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 12px}
/* Same 44px floor as the row controls: this is the primary action on the page
   and it is tapped with a thumb. Two ids, matching #perch-close: one id ties
   with #perch-hub-root button on specificity and wins only on source order, and
   that near-miss is exactly how #perch-close shipped at 36px. Deliberately NOT
   the shared button rule, which also sizes #perch-send. */
#perch-hub-root #perch-new{min-height:44px}
#perch-launch select{font:14px Inter,system-ui,sans-serif;padding:9px 10px;border:1px solid var(--line);
border-radius:10px;background:var(--sky);color:var(--ink);flex:1 1 140px;min-width:0;max-width:100%}
/* The model picker. TWO ids (2,0,0), for the same reason #perch-new carries
   two: "#perch-launch select" above is (1,0,1) and a single-id override would
   only tie-and-win on source order — the near-miss that shipped #perch-close
   at 36px.
   min-height IS load-bearing: drop it and the picker measures under the 44px
   thumb floor at both viewports (measured; perch-hub-render.test.js's M1 goes
   red). The flex-basis is a LAYOUT choice, not a safety rule — a model name is
   long and reads better on its own row — and it is honest to say so: dropping
   it leaves every M1 measurement green, because the shared select rule's
   140px basis plus flex-wrap already keeps New session on screen at 412px. */
#perch-launch #perch-new-model{min-height:44px;flex:1 1 100%}
/* By id, for the same reason as #perch-close above: "#perch-launch .empty" is
   (1,1,0) and ties with "#perch-hub-root .empty" further down, which then wins
   on source order. Measured dead: computed padding stayed 16px. */
#perch-hub-root #perch-launch-note{padding:0;flex:1 1 100%}
/* Open-anywhere C2: the launch row's directory field + Browse button.
   TWO ids on the input, same reasoning as #perch-new-model above: the
   shared "#perch-hub-root input" rule (1,0,1) gives width:100%, which in
   this flex row would take the whole line and shove Browse onto the next
   one; width:auto + a flex basis lets the two share a row and wrap as a
   unit on a phone. 44px floor: thumb targets, same as every control here. */
#perch-launch #perch-new-cwd{flex:1 1 180px;min-width:0;width:auto;min-height:44px;
font:14px Inter,system-ui,sans-serif;padding:9px 10px;border:1px solid var(--line);
border-radius:10px;background:var(--sky);color:var(--ink)}
#perch-hub-root #perch-browse-btn{min-height:44px;white-space:nowrap;flex:0 0 auto}
/* The "Empty = the bot's own directory." explainer. Two ids for the same
   source-order reason as #perch-launch-note above. */
#perch-hub-root #perch-cwd-note{padding:0;flex:1 1 100%;font-size:12.5px}
#perch-launch [hidden]{display:none}
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
/* min-height, not more padding: the base button rule's 10px/14px line box
   comes out 36px tall and these rows carry TWO controls now (Open and Close).
   44px is the smallest reliable thumb target; measured live at 412x730 in
   perch-hub-render.test.js, which is what caught the 36px in the first place. */
#perch-hub-root .roost-row button{padding:8px 12px;font-size:13px;min-height:44px}
/* Close is destructive and must not compete with Open for a thumb. */
#perch-hub-root .roost-close{color:var(--dim)}
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
/* Rendered markdown. TWO ids' worth of weight is not needed here (nothing
   competes), but \`white-space:pre-wrap\` from .what above IS: markdown output
   is real block elements, and pre-wrap would double every blank line between
   them. */
/* #perch-transcript is a GRID (see its own rule below), so every row in it is
   a grid ITEM, and a grid item's automatic minimum size is its MIN-CONTENT.
   One unbreakable table cell therefore widened the whole row past the column
   and made the transcript scroll sideways instead of the table scrolling
   inside itself. Measured at 412x730: row 666px in a 380px column, table
   clipped by nothing; with this, row 380, table 306 wide scrolling its own
   475px of content. min-width:0 on the ITEM is the item-side half of the
   standard remedy (grid-template-columns:minmax(0,1fr) is the container-side
   half). Written as a child selector rather than as .entry so a future row type
   is covered too — NOT, as an earlier version of this comment claimed, because
   it reaches the ask card: #perch-ask is a SIBLING of #perch-transcript
   (html.js), never a child, and at 412px the card sits in its own pane
   untouched by this rule. */
#perch-transcript > *{min-width:0}
#perch-hub-root .what.md{white-space:normal}
#perch-hub-root .what.md > :first-child{margin-top:0}
#perch-hub-root .what.md > :last-child{margin-bottom:0}
#perch-hub-root .what.md p{margin:0 0 8px}
#perch-hub-root .what.md h1,#perch-hub-root .what.md h2,#perch-hub-root .what.md h3,
#perch-hub-root .what.md h4,#perch-hub-root .what.md h5,#perch-hub-root .what.md h6{
font-size:15px;font-weight:600;margin:10px 0 6px;text-transform:none;letter-spacing:0;color:var(--ink)}
#perch-hub-root .what.md ul,#perch-hub-root .what.md ol{margin:0 0 8px;padding-left:20px}
#perch-hub-root .what.md li{margin:2px 0}
#perch-hub-root .what.md a{color:var(--teal)}
#perch-hub-root .what.md code{font:12.5px/1.5 "JetBrains Mono",ui-monospace,monospace;
background:var(--sky);border:1px solid var(--line);border-radius:5px;padding:1px 4px;word-break:break-word}
#perch-hub-root .what.md blockquote{margin:0 0 8px;padding-left:10px;border-left:2px solid var(--line);color:var(--dim)}
#perch-hub-root .what.md hr{border:none;border-top:1px solid var(--line);margin:10px 0}
/* WIDE CONTENT SCROLLS INSIDE ITSELF. A table or a long code fence is the one
   thing in a bot answer that cannot be wrapped, and at 412px an unscoped one
   would give the whole page a horizontal scrollbar — .roost-when's own
   clipping rules exist for the same reason. max-width:100% needs the min-width:0
   already on .what to actually bind inside the flex row. */
#perch-hub-root .what.md pre{margin:0 0 8px;padding:9px 10px;background:var(--sky);
border:1px solid var(--line);border-radius:8px;max-width:100%;overflow-x:auto}
#perch-hub-root .what.md pre code{background:none;border:none;padding:0;white-space:pre;word-break:normal}
#perch-hub-root .what.md table{display:block;max-width:100%;overflow-x:auto;
border-collapse:collapse;margin:0 0 8px;font-size:13px}
/* word-break:normal UNDOES .what's break-word inside a table. A data table
   whose long tokens are shredded mid-character is unreadable; the honest
   behaviour is to keep the cell intact and let the table scroll inside its own
   box, which is what overflow-x above is for. Without this the table can never
   overflow, and that rule would be dead. */
#perch-hub-root .what.md th,#perch-hub-root .what.md td{border:1px solid var(--line);padding:5px 8px;text-align:left;word-break:normal}
#perch-hub-root .what.md th{background:var(--sky);font-weight:600}
#perch-hub-root .what.md img{max-width:100%;height:auto}
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
/* The working strip (html.js's #perch-working): a turning gear + one word,
   sitting between the ask pane and the composer as a non-shrinking flex
   child — it must never squeeze the transcript or push Send off screen, and
   [hidden] must outrank the display:flex on the same id (id+attr = (1,1,0)
   beats id = (1,0,0)). The spin slows instead of stopping under
   prefers-reduced-motion, matching pi-lab's own tool-spinner choice: motion
   is the signal here, so the honest reduction is "calmer", not "frozen". */
#perch-working{display:flex;align-items:center;gap:8px;padding:6px 2px 0;color:var(--dim);font-size:12.5px;flex-shrink:0}
#perch-working[hidden]{display:none}
#perch-working svg{width:15px;height:15px;color:var(--teal);flex-shrink:0;animation:perch-spin 1.4s linear infinite}
@keyframes perch-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#perch-working svg{animation-duration:6s}}
#perch-composer textarea{min-height:72px;max-height:120px;overflow-y:auto}
/* Wave 1: the composer auto-grows (client.js oninput, pi-lab's exact idiom)
   up to the 120px ceiling above, then scrolls inside itself — a pasted
   essay must not push Send off screen, the one sin this page's whole flex
   chain exists to prevent. */
/* Wave 1: copy buttons, ported from pi-lab (copy-msg floats in the message,
   copy-pre pins to its code fence's corner). Deliberately quiet: they are
   chrome on somebody's answer, not controls competing with the composer.
   The prewrap wrapper is minted client-side around each server-rendered
   <pre> (enhancePres) so the button is a SIBLING of the pre — inside it,
   the button's own glyph would pollute pre.textContent, the copy source. */
#perch-hub-root .copy-msg{align-self:flex-start;flex-shrink:0;margin:0 0 0 4px;background:none;border:none;color:inherit;opacity:.45;font-size:13px;cursor:pointer;padding:2px 6px;min-height:24px}
#perch-hub-root .prewrap{position:relative}
#perch-hub-root .copy-pre{position:absolute;top:6px;right:6px;z-index:1;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--dim);font-size:12px;padding:1px 7px;cursor:pointer;opacity:.75;min-height:24px}
#perch-hub-root .copy-msg.copied,#perch-hub-root .copy-pre.copied{opacity:1;color:var(--teal)}
/* Wave 1: the attention banner (html.js's #perch-attn). [hidden] on an id
   with its own display rule needs the attribute selector to outrank it —
   (1,1,0) over (1,0,0), same discipline as the tab sections. */
#perch-hub-root .attn-banner{display:flex;align-items:center;gap:8px;background:var(--teal-soft);border:1px solid var(--attn);color:var(--attn);border-radius:10px;padding:9px 12px;font-size:13px;font-weight:500;margin:8px 0 0;flex-shrink:0}
#perch-hub-root .attn-banner[hidden]{display:none}
#perch-back{align-self:flex-start}
/* --- Phase D1: the tab surface ------------------------------------------
   ONE strip, two placements. Desktop: a top strip in the right pane (natural
   DOM order). Phone: order:10 makes the SAME element the last flex child of
   #perch-chat — a bottom tab bar without position:fixed, so the flex chain
   that keeps Send reachable (#perch-chat{flex:1;min-height:0} + the
   transcript as the only scroller) is untouched and the composer sits above
   the bar inside the chat tab. The chain has killed a Send button before;
   the bar joins it as a NON-SHRINKING sibling and nothing else changes. */
#perch-tabs{display:flex;gap:4px;flex-shrink:0;order:10;border-top:1px solid var(--line);
padding:6px 0 calc(6px + env(safe-area-inset-bottom,0px))}
/* Two ids: the base "#perch-hub-root button" rule (1,0,1) would otherwise
   paint these with card background and ink border — the selected tab owns
   its own highlight. 44px floor: a bottom bar is thumb territory. */
#perch-hub-root #perch-tabs button{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;
min-height:44px;padding:6px 4px;font-size:11px;border-color:transparent;background:transparent;color:var(--dim)}
#perch-tabs svg{width:20px;height:20px;flex-shrink:0}
#perch-hub-root #perch-tabs button[aria-selected="true"]{color:var(--teal);background:var(--teal-soft)}
/* The four panels. Chat inherits the old column exactly: it IS the flex
   column the transcript and the sticky composer lived in before the tabs
   existed, so the reachability measurements carry over unchanged. The other
   three are plain scrollers — a long directory path or file list must never
   push the tab bar off screen. */
#perch-tab-chat{order:1;flex:1;min-height:0;display:flex;flex-direction:column}
#perch-tab-session,#perch-tab-files,#perch-tab-activity{order:1;flex:1;min-height:0;overflow-y:auto}
/* [hidden] must outrank the display rules above — id + type + attribute is
   (1,1,1) against their (1,0,0), so the client's pure-hidden-toggle works
   without an !important anywhere. */
#perch-hub-root section[hidden]{display:none}
/* Session tab: the state pill + rename + close row. Wraps at phone width;
   the two controls keep their own 44px two-id rules further up. */
#perch-hub-root .session-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 12px}
#perch-hub-root .session-row .state{flex:1;min-width:0}
/* Files tab rows: the whole row is the download link (thumb target), name
   breaks long, meta never does. */
#perch-hub-root .files-bar{display:flex;justify-content:flex-end;padding:6px 0}
#perch-hub-root .file-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
padding:11px 12px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink);min-height:44px}
#perch-hub-root .file-name{word-break:break-all;font-weight:500;font-size:14px}
#perch-hub-root .file-meta{color:var(--dim);font-size:12px;white-space:nowrap;
font-family:"JetBrains Mono",ui-monospace,monospace}
/* Activity tab: monospace log lines, dimmest text on the page — this is the
   rail you READ AFTER the conversation, never instead of it. */
#perch-activity-list{display:grid;gap:6px;padding:12px 0;align-content:start}
#perch-hub-root .activity-row{color:var(--dim);font-size:12.5px;word-break:break-word;
font-family:"JetBrains Mono",ui-monospace,monospace}
/* --- open-anywhere C2: the directory-picker modal ---------------------
   Built client-side (client.js buildBrowseModal) and appended INSIDE
   #perch-hub-root, so every class rule here stays scoped the way the
   sheet's header comment demands. position:fixed + inset:0 covers the
   whole viewport (the shell's own clamp gives .main-content no transform,
   verified live at both breakpoints — a transformed ancestor would make
   "fixed" resolve against it instead). The [hidden] rule must outrank the
   display:flex on the same id selector, hence the attribute on an id. */
#perch-browse-modal{position:fixed;inset:0;z-index:60;background:rgba(10,18,24,.45);
display:flex;align-items:center;justify-content:center;padding:16px}
#perch-browse-modal[hidden]{display:none}
#perch-hub-root .browse-box{background:var(--card);border:1px solid var(--line);border-radius:14px;
width:100%;max-width:min(560px,92vw);max-height:min(70vh,560px);display:flex;flex-direction:column;
min-height:0;box-shadow:0 12px 40px rgba(0,0,0,.28)}
#perch-hub-root .browse-head{padding:12px 14px;border-bottom:1px solid var(--line);flex-shrink:0}
#perch-hub-root .browse-path{font:12.5px/1.4 "JetBrains Mono",ui-monospace,monospace;color:var(--dim);word-break:break-all}
#perch-hub-root .browse-hint{padding:8px 14px 0;font-size:13px;color:var(--dim);flex-shrink:0}
#perch-hub-root .browse-list{overflow-y:auto;flex:1;min-height:0;padding:8px;display:grid;gap:4px;align-content:start}
/* Directory rows are buttons with the directory NAME as the visible label
   (house rule: no unlabelled controls). break-all: one long directory name
   must not give the modal a horizontal scrollbar at 320px. */
#perch-hub-root .browse-list button{display:block;text-align:left;min-height:44px;padding:10px 12px;word-break:break-all}
#perch-hub-root .browse-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;
border-top:1px solid var(--line);flex-shrink:0}
#perch-hub-root .browse-foot button{min-height:44px}
/* Full-bleed at phone width: a centered card with 8% gutters on a 360px
   screen is a keyhole; the picker is the whole screen there. */
@media (max-width:599px){
  #perch-browse-modal{padding:0}
  #perch-hub-root .browse-box{max-width:100%;height:100%;max-height:100%;border-radius:0}
}
#perch-hub-root .field-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:10px 0}
#perch-hub-root .field{display:flex;flex-direction:column;gap:3px;flex:1 1 150px;min-width:0}
#perch-hub-root .field-label{font:11px/1 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
@media (min-width:${PERCH_SPLIT_MIN_WIDTH}px){
  #perch-hub-root{max-width:1100px}
  body[data-view="chat"] #perch-list{display:block}
  #perch-hub-root .hub-split{display:grid;grid-template-columns:320px 1fr;gap:20px;align-items:stretch}
  #perch-back{display:none}
  /* Desktop: the strip returns to natural DOM order (top of the right pane)
     and reads as a horizontal tab row, not a phone bar. */
  #perch-tabs{order:0;border-top:none;border-bottom:1px solid var(--line);padding:6px 0}
  #perch-hub-root #perch-tabs button{flex:0 0 auto;flex-direction:row;gap:6px;font-size:13px;padding:8px 14px}
}
`;
}
