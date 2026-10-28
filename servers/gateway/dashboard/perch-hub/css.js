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

/** TEXT SIZE (2026-10-02). Every px font size in this sheet is emitted as
 *  calc(Npx * var(--pts,1)). --pts is 1 everywhere in the hub except inside
 *  the chat tab, where it follows --crow-text-scale — the DASHBOARD-WIDE text
 *  size (shared/text-size.js: one per-device preference, set from Settings ›
 *  Text size or from the Session tab's A− / A / A+, applied on the html element before
 *  first paint). So the chat tab — messages, tool/file/phone cards, the ask card, the
 *  banner, the composer — scales as one, and the list, tabs and Session tab
 *  keep their size. Done as one transform rather than hand-editing ~90 rules
 *  so a rule added later is covered without anyone remembering to. Only
 *  "font-size:" and the size inside a "font:" shorthand are touched; spacing
 *  stays fixed. Exported for tests/perch-phone-layout.test.js. */
export function scaleFontSizes(css) {
  return css
    .replace(/(font-size:\s*)(\d+(?:\.\d+)?)px/g, "$1calc($2px * var(--pts,1))")
    .replace(/(font:\s*(?:\d{3}\s+)?)(\d+(?:\.\d+)?)px/g, "$1calc($2px * var(--pts,1))");
}

export function perchHubCss() {
  return scaleFontSizes(`
#perch-hub-root{--sky:#eef1f3;--card:#fff;--ink:#22303a;--dim:#5d6d78;--teal:#0e6b62;--teal-soft:#dcecea;
--wire:#94a4ae;--alive:#2fa36b;--attn:#d1633e;--line:#dde4e8;
--ok:#1d6b43;--ok-soft:#e1f1e8;--warn:#8a5300;--warn-soft:#fbefd6;--err:#b42318;--err-soft:#fbe8e6}
@media (prefers-color-scheme:dark){#perch-hub-root{--sky:#131a1f;--card:#1b242b;--ink:#e4ebef;--dim:#8fa0ab;
--teal:#4fbdb0;--teal-soft:#16322f;--wire:#46565f;--line:#2a353d;
--ok:#6fd39b;--ok-soft:#173326;--warn:#f0b955;--warn-soft:#3a2d12;--err:#ff8f84;--err-soft:#3d1f1c}}
/* Status tokens (spec 2026-10-02). --attn (#d1633e) is 3.8:1 on --card in the
   light theme, under WCAG AA for text; these are AA in both themes (measured):
   each text colour on its own -soft tint 5.5:1+ light / 6.7:1+ dark, and on
   --card 6.3:1+ light / 7.1:1+ dark. --card on --teal / --err (a filled
   button's label) is 6.4:1+ in both. Error TEXT uses --err; --attn stays
   for borders and the attention banner.
   --dim (backlog P3): #6b7c88 was 4.32:1 on the light --card, under AA for
   the card's small text; #5d6d78 is 5.35:1 on --card and 4.72:1 on --sky.
   Dark --dim #8fa0ab is 5.84:1 / 6.51:1. tests/perch-phone-card.test.js
   measures both themes. */
#perch-hub-root,#perch-hub-root *{box-sizing:border-box;margin:0}
/* Text size: --pts is the multiplier scaleFontSizes() writes into every font
   size. 1 across the hub; the chat tab follows the dashboard-wide text size
   (--crow-text-scale, shared/text-size.js) — the rest of the dashboard is
   rem-based and follows it through the root font size instead. The
   chat tab also gets an explicit base size so the text that inherits (the ask
   card's question, plain notes) scales with the rest. */
#perch-hub-root{--pts:1}
#perch-tab-chat{--pts:var(--crow-text-scale,1);font-size:15px}
/* The control itself (Session tab). */
#perch-hub-root .text-size{display:flex;align-items:center;gap:6px}
#perch-hub-root .text-size button{min-width:44px;min-height:44px;padding:8px 10px}
#perch-hub-root .text-size button:disabled{opacity:.45;cursor:default}
#perch-hub-root .text-size-value{color:var(--dim);font-size:13px;margin-left:4px;font-variant-numeric:tabular-nums}
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
/* Shell P2: in the new shell the tabs replace the Board link, so html.js ships
   this header hidden; display:flex above would otherwise beat [hidden]. */
#perch-hub-root header[hidden]{display:none}
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
/* The "Show more (N)" toggle under each model picker: a thumb-sized
   text button, never wider than its label. */
#perch-hub-root .perch-model-more{min-height:44px;flex:0 0 auto;align-self:flex-start}
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
/* QW2: "More options" — model + directory fold away under one full-width
   disclosure. The summary is a thumb target like every launcher control; the
   body is its own flex row (a <details> is not a flex container itself), so
   the field/Browse pairing above keeps working inside it. */
#perch-hub-root #perch-launch-more{flex:1 1 100%;min-width:0}
#perch-hub-root #perch-launch-more>summary{min-height:44px;box-sizing:border-box;padding:12px 0;cursor:pointer;
color:var(--dim);font-size:13px;line-height:20px;overflow-wrap:anywhere}
#perch-hub-root #perch-launch-more-model{color:var(--ink)}
#perch-hub-root .launch-more-body{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 0 0}
/* Closed means NOT RENDERED. Current Chrome hides a closed <details> body
   with content-visibility, which still leaves the fields boxes (measured:
   getClientRects non-empty); display:none makes it unambiguous. */
#perch-hub-root #perch-launch-more:not([open]) .launch-more-body{display:none}
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
/* QW2: the row's one ⋯ trigger (a square thumb target) and its menu, opened
   INLINE below the row — the list body scrolls, so a floating popover would
   clip. [hidden] needs its own rule: the display:flex here would beat the
   UA's hidden. */
#perch-hub-root .roost-row .roost-more{min-width:44px;padding:8px 10px;font-size:18px;line-height:1;color:var(--dim)}
#perch-hub-root .roost-menu{flex:1 1 100%;display:flex;flex-direction:column;gap:2px;padding:4px;
border:1px solid var(--line);border-radius:10px;background:var(--card)}
#perch-hub-root .roost-menu[hidden]{display:none}
#perch-hub-root .roost-menu button{width:100%;text-align:left;border:0;background:none}
#perch-hub-root .roost-menu button:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
/* PR-C (audit item 14): the archive affordance. Archive is reversible (not
   destructive), so it sits quiet beside Rename. The Archived section is a
   full-width quiet toggle above a dimmed, collapsed list. */
#perch-hub-root .roost-archive{color:var(--dim)}
#perch-hub-root .archived-toggle{width:100%;text-align:left;color:var(--dim);font-size:12.5px;
text-transform:uppercase;letter-spacing:.06em;background:none;border:0;border-top:1px solid var(--line);
border-radius:0;padding:12px 16px;min-height:44px}
#perch-hub-root .archived-list{display:grid}
#perch-hub-root .archived-list[hidden]{display:none}
#perch-hub-root .archived-row{opacity:.72;background:var(--sky)}
#perch-hub-root .empty{color:var(--dim);padding:16px;font-size:14px}
/* --- chat transcript + ask cards, ported from the deleted bundle's own
   equivalents (42f39160^:bundles/perch-hub/payload/hub/bots-page.mjs
   .entry/.entry .who/.entry .what/.ask-card/.ask-card .title/
   .ask-card .ask-message) and renamed onto the classes THIS script emits
   (entry/who/what/ask-card/ask-title/ask-message/ask-controls — the bundle's
   own ask card nested a bare .title and used .ask-opts for the button row). */
/* Design quick win 1: one stacked row at EVERY width (the old 64px role
   gutter could not hold a bot's name). The label — the bot's display name in
   normal case — and a bot row's copy button share one short line; the
   message takes the next at the FULL width. Your own messages sit in a quiet
   card and carry no visible label (a visually hidden "You:" for screen
   readers, .who.vh below). Cards (tool chips, files, phone calls, artifacts)
   are column boxes already and keep their own layout. position:relative
   anchors that hidden label INSIDE the scrolling transcript: without it, the
   labels of rows scrolled out of view hang below the page and make it scroll.
   .perch-narrow (client.js, under 600px) stays as a class for other rules. */
#perch-hub-root .entry{display:flex;flex-wrap:wrap;column-gap:10px;row-gap:2px;font-size:14px;position:relative}
#perch-hub-root .who{flex:1 1 auto;min-width:0;font:600 13px/1.4 Inter,"Public Sans",system-ui,sans-serif;color:var(--ink);overflow-wrap:anywhere}
#perch-hub-root .what{flex:1 1 100%;order:2;min-width:0;white-space:pre-wrap;word-break:break-word}
#perch-hub-root .copy-msg{order:1}
#perch-hub-root .entry.user{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:7px 10px}
/* The ONE visually-hidden rule (the phone card's .ph-sr shares it). .who.vh
   outweighs .who above; user-select:none keeps "You:" out of a copied chat. */
#perch-hub-root .vh,#perch-hub-root .who.vh,#perch-hub-root .ph-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;
overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;user-select:none;-webkit-user-select:none}
/* Strand 1: a turn that ended in a model error. A plain BLOCK box at every
   width (the label is longer than the 64px role gutter, and a flex column let
   a long unbroken provider token push the row sideways at 412px); the error
   keeps the body ink on the soft tint, so it reads in both themes. */
#perch-hub-root .entry.turnerr{display:block;background:var(--err-soft);border:1px solid var(--err);border-radius:10px;padding:7px 10px}
#perch-hub-root .entry.turnerr .who{color:var(--err)}
#perch-hub-root .entry.turnerr .what{overflow-wrap:anywhere}
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
#perch-hub-root .ask-expired{font-size:.85rem;color:var(--dim);font-style:italic}
#perch-hub-root .ask-controls{display:flex;flex-wrap:wrap;gap:6px}
/* PR-A (audit item 5): the combined multi-question ask card. One card carries
   up to four questions, each with tappable options (bold label + dim
   description), an "Other…" free-text field, and ONE Send-answers action —
   pi-lab's AskCard layout, in the hub's palette. All selectors scoped to
   #perch-hub-root (the page test forbids bare ones). */
#perch-hub-root .ask-combined{gap:13px}
#perch-hub-root .ask-q{display:grid;gap:7px}
#perch-hub-root .ask-h{justify-self:start;font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:700;color:var(--teal);background:var(--teal-soft);border-radius:6px;padding:2px 8px}
#perch-hub-root .ask-t{font-weight:600;line-height:1.35}
#perch-hub-root .ask-multi{font-weight:400;color:var(--dim);font-size:12.5px}
#perch-hub-root .ask-opts{display:grid;gap:6px}
#perch-hub-root .ask-opt{display:grid;gap:2px;text-align:left;padding:9px 12px;min-height:44px}
#perch-hub-root .ask-opt b{font-weight:600}
#perch-hub-root .ask-opt span{color:var(--dim);font-size:12.5px;font-weight:400}
#perch-hub-root .ask-opt.sel{border-color:var(--teal);background:var(--teal-soft)}
#perch-hub-root .ask-opt.sel b{color:var(--teal)}
#perch-hub-root .ask-foot{display:flex;gap:8px;align-items:center}
#perch-hub-root .ask-send{flex:1}
#perch-hub-root .ask-send:disabled{opacity:.45;cursor:default}
/* THE ASK PANE FITS ITS SPACE (2026-10-02, Casey's Pixel 9a report). #perch-ask
   is a flex child of the #perch-tab-chat column, between the transcript and
   the composer. Before this it had no rule at all, so it kept the flex default
   min-height:auto (= its full content height): a five-option card at 412px
   was taller than the room left over, the column overflowed, the transcript
   was squeezed to its 24px of padding (the half-hidden tool chip under the
   banner), and the composer and the bottom tab bar were painted over the
   card's Send answer / Cancel. Pre-existing — identical on 6445b583, before
   #404's overflow safety net (measured, see the regression test).

   Decision: keep the card in its own pane above the composer (an unanswered
   ask_user blocks the turn, so it must not scroll away inside the
   transcript), but let the pane SHRINK. min-height:0 lets it give up height
   only when the column is out of room — on a desktop it fits and nothing
   moves — and inside it the questions scroll while the Send answer / Cancel
   foot stays put. The single-question cards (confirm/select/input) have no
   separate foot; the whole card scrolls inside the pane there. */
#perch-ask{flex:0 1 auto;min-height:0;display:flex;flex-direction:column}
/* ...but never below the foot plus a row of options: on a landscape phone
   (915x412) there is no room at all once the banner and composer are placed,
   and a pane shrunk to 0px hid Send answer outright. With this floor the
   column overflows instead and the page scrolls to it (the same backstop the
   composer's sticky rule is for). */
#perch-ask:not(:empty){min-height:min(120px,30vh)}
/* Short screens (a phone on its side): the banner takes one line and the
   composer starts at two lines, so the card keeps what room there is. */
@media (max-height:500px){
  #perch-hub-root .attn-banner{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;padding:6px 12px}
  #perch-hub-root #perch-composer textarea{min-height:44px}
}
#perch-hub-root #perch-ask > .ask-card{min-height:0;overflow-y:auto;overscroll-behavior:contain}
#perch-hub-root #perch-ask > .ask-combined{display:flex;flex-direction:column;overflow:hidden}
#perch-hub-root .ask-body{display:grid;gap:13px;flex:0 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
#perch-hub-root .ask-combined .ask-foot{flex-shrink:0}
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
/* Never squeezed to a sliver by the ask pane: the floor keeps the last row
   (the running ask_user chip) readable. min(): 56px is under the 63px the
   transcript has with a card open at 1280x900, so the desktop is unchanged,
   and a short landscape phone gives up the extra first. */
#perch-tab-chat > #perch-transcript{min-height:min(56px,10vh)}
/* A scrolled transcript shows a sliver of the row above in its 12px top
   padding, flush against the banner — which read as the banner covering the
   chat (Casey's screenshot). Fade exactly that padding band: at scrollTop 0 it
   is empty, so nothing at rest changes. */
#perch-transcript{-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 12px);mask-image:linear-gradient(to bottom,transparent 0,#000 12px)}
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
body.shell #perch-draft-note{font-size:12.5px;color:var(--dim)}
body.shell #perch-draft-note[hidden]{display:none}
/* The working strip (html.js's #perch-working): a turning gear + one word,
   sitting between the ask pane and the composer as a non-shrinking flex
   child — it must never squeeze the transcript or push Send off screen, and
   [hidden] must outrank the display:flex on the same id (id+attr = (1,1,0)
   beats id = (1,0,0)). The spin slows instead of stopping under
   prefers-reduced-motion, matching pi-lab's own tool-spinner choice: motion
   is the signal here, so the honest reduction is "calmer", not "frozen". */
#perch-working{display:flex;align-items:center;gap:8px;padding:6px 2px 0;color:var(--dim);font-size:12.5px;flex-shrink:0}
#perch-working[hidden]{display:none}
/* While a question card is up the bot is waiting on YOU (the banner says so):
   "Working…" would be wrong, and on a phone its row is height the card needs. */
#perch-ask:not(:empty) ~ #perch-working{display:none}
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
#perch-hub-root .perch-ident{min-width:0}
/* Queue item 13 (plan 2026-10-14 rev 2): on phones and tablets the CHAT view
   gives the reply room — no Board row (it stays on the sessions list), one
   head row (back + bot name), no raw session id (the Session tab shows it),
   and a trimmed title bar that keeps the safe-area inset. The list view and
   the split view (desktop) are untouched. */
@media (max-width:${PERCH_SPLIT_MIN_WIDTH - 1}px){
  body[data-view="chat"] #perch-hub-root > header{display:none}
  /* The new shell: an open chat takes the whole height; the back button
     returns to the list, where the tab bar is back. */
  body.shell[data-view="chat"] .shell-tabs{display:none}
  body.shell[data-view="chat"]{--shell-tabs-h:0px}
  /* The shell keeps its 16px side gutter in the compact chat header too. */
  body.shell[data-view="chat"]:has(#perch-chat) .content-header{padding-left:16px;padding-right:16px}
  body[data-view="chat"] #perch-hub-root .perch-head{flex-wrap:nowrap;justify-content:flex-start;gap:10px}
  body[data-view="chat"] #perch-hub-root #perch-back{flex:none;align-self:center;min-height:44px;padding:6px 12px;font-size:13px}
  body[data-view="chat"] #perch-hub-root #perch-session-meta{display:none}
  body[data-view="chat"] #perch-hub-root .perch-head .title{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  body[data-view="chat"]:has(#perch-chat) .content-header{padding:6px 12px;padding-top:calc(env(safe-area-inset-top, 0px) + 6px)}
  body[data-view="chat"]:has(#perch-chat) .content-header h2{font-size:1.05rem}
  body[data-view="chat"]:has(#perch-chat) .content-body{padding-top:6px}
}
/* --- Phase D1: the tab surface ------------------------------------------
   ONE strip, two placements. Desktop: a top strip in the right pane (natural
   DOM order). Phone: order:10 makes the SAME element the last flex child of
   #perch-chat — a bottom tab bar without position:fixed, so the flex chain
   that keeps Send reachable (#perch-chat{flex:1;min-height:0} + the
   transcript as the only scroller) is untouched and the composer sits above
   the bar inside the chat tab. The chain has killed a Send button before;
   the bar joins it as a NON-SHRINKING sibling and nothing else changes. */
#perch-tabs{display:flex;gap:4px;flex-shrink:0;order:10;border-top:1px solid var(--line);
padding:6px 0 calc(6px + max(0px, env(safe-area-inset-bottom, 0px) - var(--crow-player-h,0px)))}
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
/* PR-D (audit item 15): the envelope + per-session tool narrowing pane. A
   quiet full-width toggle above a collapsible body of tool checkboxes (an
   allowed tool, ticked = kept) and locked rows (denied by the envelope). All
   selectors scoped; the checkbox override beats the generic full-width input
   rule so ticks look like ticks. */
#perch-hub-root .narrow-pane{margin:6px 0 12px}
#perch-hub-root .narrow-toggle{width:100%;text-align:left;color:var(--dim);font-size:12.5px;
text-transform:uppercase;letter-spacing:.06em;background:none;border:0;border-top:1px solid var(--line);
border-radius:0;padding:12px 0;min-height:44px}
#perch-hub-root .narrow-body[hidden]{display:none}
#perch-hub-root .narrow-head{color:var(--dim);font-size:12.5px;margin:4px 0 8px;word-break:break-word;
font-family:"JetBrains Mono",ui-monospace,monospace}
#perch-hub-root .narrow-tools{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px}
#perch-hub-root .narrow-tool{display:flex;align-items:center;gap:7px;font-size:13.5px;padding:6px 4px;min-height:36px}
#perch-hub-root .narrow-tool input{width:auto;padding:0;min-height:0;flex-shrink:0}
#perch-hub-root .narrow-locked{color:var(--dim);font-size:13px;padding:6px 4px}
#perch-hub-root .narrow-note{color:var(--dim);font-size:12px;margin-top:8px;line-height:1.45}
#perch-hub-root .narrow-msg{font-size:12.5px;margin-top:6px}
#perch-hub-root .narrow-msg.err{color:var(--err)}
/* Files tab rows: the whole row is the download link (thumb target), name
   breaks long, meta never does. */
#perch-hub-root .files-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0}
#perch-hub-root .files-bar-label{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);font-weight:600}
#perch-hub-root .file-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
padding:11px 12px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink);min-height:44px}
#perch-hub-root .file-name{word-break:break-all;font-weight:500;font-size:14px}
#perch-hub-root .file-meta{color:var(--dim);font-size:12px;white-space:nowrap;
font-family:"JetBrains Mono",ui-monospace,monospace}
/* PR-B (audit item 18): the read-only cwd browser + in-app text viewer. Dirs
   are tinted/bold to distinguish from files (no icon glyphs — keeps the CSS
   escape-free). The viewer is an overlay covering the Files tab, so its
   section is the offset parent. */
#perch-hub-root .files-subhead{margin:18px 0 6px}
#perch-hub-root .cwd-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:4px 0 8px;font-size:13px}
#perch-hub-root .crumb{background:none;border:0;padding:2px 4px;color:var(--teal);cursor:pointer;font:inherit;border-radius:6px}
#perch-hub-root .crumb[aria-current]{color:var(--ink);font-weight:600;cursor:default}
#perch-hub-root .crumb-sep{color:var(--dim)}
#perch-hub-root .cwd-list{display:grid}
#perch-hub-root .cwd-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;text-align:left;
padding:10px 12px;border:0;border-bottom:1px solid var(--line);background:none;color:var(--ink);cursor:pointer;
min-height:44px;font:inherit;width:100%}
#perch-hub-root .cwd-dir .cwd-name{color:var(--teal);font-weight:600}
#perch-hub-root .cwd-name{word-break:break-all;font-weight:500;font-size:14px}
#perch-hub-root .cwd-meta{color:var(--dim);font-size:12px;white-space:nowrap;
font-family:"JetBrains Mono",ui-monospace,monospace}
#perch-tab-files{position:relative}
#perch-hub-root .file-viewer{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;
background:var(--card);border:1px solid var(--line);border-radius:10px}
#perch-hub-root .file-viewer[hidden]{display:none}
#perch-hub-root .fv-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;
padding:8px 12px;border-bottom:1px solid var(--line)}
#perch-hub-root .fv-name{font-weight:600;font-size:13.5px;word-break:break-all}
#perch-hub-root .fv-body{margin:0;padding:12px;overflow:auto;flex:1;min-height:0;color:var(--ink);
font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
/* Activity tab: monospace log lines, dimmest text on the page — this is the
   rail you READ AFTER the conversation, never instead of it. */
#perch-activity-list{display:grid;gap:6px;padding:12px 0;align-content:start}
#perch-hub-root .activity-row{color:var(--dim);font-size:12.5px;word-break:break-word;
font-family:"JetBrains Mono",ui-monospace,monospace}
/* --- Wave 2: Session-tab facts + plan progress -------------------------- */
#perch-hub-root .facts{margin:6px 0 10px}
#perch-hub-root .facts .kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;
border-bottom:1px solid var(--line);font-size:13.5px}
#perch-hub-root .facts .kv:last-child{border-bottom:0}
#perch-hub-root .facts .k{color:var(--dim);flex-shrink:0}
#perch-hub-root .facts .v{font:12.5px "JetBrains Mono",ui-monospace,monospace;text-align:right;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#perch-hub-root .ctxbar{height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin:2px 0 6px}
#perch-ctxbar-fill,#perch-planbar-fill{height:100%;background:var(--teal);width:0%;transition:width .4s}
/* One rule for every Wave-2/3 panel that ships hidden: [hidden] must outrank
   each panel's own display rule — attribute on class/id beats either alone. */
#perch-hub-root .ctxbar[hidden],#perch-hub-root .plan-card[hidden],
#perch-planbar[hidden],#perch-cmdmenu[hidden],#perch-hub-root .tool-details[hidden]{display:none}
#perch-planbar{height:3px;background:var(--line);border-radius:2px;overflow:hidden;margin:8px 0 0;flex-shrink:0}
#perch-hub-root .plan-card{border:1px solid var(--line);border-radius:10px;background:var(--sky);
padding:10px 12px;margin:6px 0 10px}
#perch-hub-root .plan-head{font:11px/1 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;
letter-spacing:.06em;color:var(--dim);margin-bottom:8px}
#perch-hub-root .plan-step{display:flex;gap:8px;padding:4px 0;font-size:13.5px;align-items:baseline}
#perch-hub-root .plan-step .sbox{font-family:"JetBrains Mono",ui-monospace,monospace;flex-shrink:0;color:var(--dim)}
#perch-hub-root .plan-step .stxt{word-break:break-word}
#perch-hub-root .plan-step.done{color:var(--dim)}
#perch-hub-root .plan-step.done .stxt{text-decoration:line-through}
#perch-hub-root .plan-step.done .sbox{color:var(--alive)}
#perch-hub-root .plan-step.cur{color:var(--teal);font-weight:600}
#perch-hub-root .plan-step.cur .sbox{color:var(--teal)}
/* --- Wave 3: inline tool chips + the slash menu --------------------------
   Chips are pi-lab's shape: a pill with a spinner while running, tap to
   expand args/result. The details <pre>s are textContent-only (tool args
   and results are child-controlled data) and cap at 240px scrolling inside
   themselves — a 2000-char result must not become a second transcript. */
#perch-hub-root .toolwrap{align-self:flex-start;max-width:90%;min-width:0}
#perch-hub-root .tool-chip{display:inline-flex;align-items:center;gap:7px;background:var(--sky);
border:1px solid var(--line);border-radius:999px;padding:5px 12px;min-height:32px;max-width:100%;
font:12px "JetBrains Mono",ui-monospace,monospace;color:var(--dim);cursor:pointer;text-align:left}
#perch-hub-root .tool-chip .tn{color:var(--teal);font-weight:600;word-break:break-all}
#perch-hub-root .tool-chip.err{border-color:var(--attn)}
#perch-hub-root .tool-chip.err .tn{color:var(--err)}
#perch-hub-root .tool-chip .spin{width:10px;height:10px;border:2px solid var(--line);
border-top-color:var(--teal);border-radius:50%;animation:perch-spin .8s linear infinite;flex-shrink:0}
#perch-hub-root .tool-details{background:var(--card);border:1px solid var(--line);border-radius:10px;
margin-top:5px;padding:8px 10px;font-size:12px}
#perch-hub-root .tool-details .td-h{font:600 10px "JetBrains Mono",ui-monospace,monospace;
text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:6px 0 3px}
#perch-hub-root .tool-details .td-h:first-child{margin-top:0}
#perch-hub-root .tool-details pre{background:var(--sky);padding:7px 9px;border-radius:6px;
overflow-x:auto;overflow-y:auto;max-height:240px;margin:0;white-space:pre-wrap;word-break:break-word;
font:11px/1.5 "JetBrains Mono",ui-monospace,monospace}
/* PR-E (audit item 12): inline sent-file cards in the chat. Column box on the
   .entry row (which is itself a flex row — flex-direction:column + width:100%
   own the line). Images inline capped to the card width; a not-jail-served
   file renders dim with a name and the honest note, never a dead link. */
#perch-hub-root .filecard{flex-direction:column;gap:3px;align-self:stretch;width:100%;min-width:0;
background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 11px;margin:2px 0}
#perch-hub-root .filecard.dim{opacity:.6}
#perch-hub-root .filecard .file-title{font-weight:600;font-size:13.5px;word-break:break-all;color:var(--ink)}
#perch-hub-root .filecard .file-cap{font-size:13px;color:var(--ink);white-space:pre-wrap;word-break:break-word}
#perch-hub-root .filecard .file-meta{white-space:normal}
#perch-hub-root .filecard .file-note{font-size:12px;color:var(--dim)}
#perch-hub-root .filecard .file-dl{display:inline-block;margin-top:4px;color:var(--teal);font-size:13px;text-decoration:none}
#perch-hub-root .filecard .file-img{max-width:100%;height:auto;border-radius:6px;margin-bottom:4px}
/* Live browser tile (spec 2026-10-27 §1): the same card box as a sent file,
   phone-first. min-width:0 + the clipped host: a long hostname never widens
   the column past 390 px. Targets are 44 px. Perch tokens only, so the dark
   theme comes with them. A not-holder frame dims (data-dim); a frozen tile's
   dot turns --dim. */
#perch-hub-root .ph-btile{flex-direction:column;gap:6px;align-self:stretch;width:100%;max-width:560px;min-width:0;
background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px;margin:2px 0}
#perch-hub-root .ph-btile [hidden]{display:none}
#perch-hub-root .ph-btile .bt-frame{display:block;width:100%;min-height:44px;padding:0;border:0;border-radius:8px;
background:var(--sky);overflow:hidden;cursor:pointer}
#perch-hub-root .ph-btile[data-phase="done"] .bt-frame{cursor:default}
#perch-hub-root .ph-btile .bt-img{display:block;width:100%;max-width:100%;height:auto}
#perch-hub-root .ph-btile[data-dim="1"] .bt-img,#perch-hub-root .ph-btile[data-operator="1"] .bt-img{opacity:.45}
#perch-hub-root .ph-btile .bt-bar{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;color:var(--dim)}
#perch-hub-root .ph-btile .bt-dot{width:9px;height:9px;border-radius:50%;background:var(--dim);flex-shrink:0}
#perch-hub-root .ph-btile[data-phase="live"] .bt-dot{background:var(--alive)}
#perch-hub-root .ph-btile .bt-state{font-weight:600;color:var(--ink);flex-shrink:0}
#perch-hub-root .ph-btile .bt-host{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
#perch-hub-root .ph-btile .bt-note{font-size:13px;color:var(--dim)}
#perch-hub-root .ph-btile .bt-actions{display:flex;flex-wrap:wrap;gap:8px}
#perch-hub-root .ph-btile .bt-actions button{min-height:44px;min-width:44px;padding:8px 14px}
#perch-hub-root .browser-status{font-size:12.5px;color:var(--teal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The Take over sheet (spec 2026-10-27 §4.4): full screen over the hub, the
   noVNC viewer filling what the bar leaves. Targets are 44 px; Perch tokens only. */
#perch-hub-root .browser-mine{display:block;width:100%;min-height:44px;margin:0 0 6px;padding:8px 14px;text-align:left;
background:var(--card);color:var(--teal);border:1px solid var(--line);border-radius:10px;font-weight:600;cursor:pointer}
#perch-hub-root .browser-mine[hidden]{display:none}
#perch-hub-root .ph-tosheet{position:fixed;inset:0;z-index:1300;display:flex;flex-direction:column;gap:6px;
background:var(--card);color:var(--ink);padding:8px;padding-top:max(8px,env(safe-area-inset-top));min-width:0}
#perch-hub-root .ph-tosheet [hidden]{display:none}
#perch-hub-root .ph-tosheet .to-head{display:flex;align-items:center;gap:8px;min-width:0}
#perch-hub-root .ph-tosheet .to-host{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
#perch-hub-root .ph-tosheet button{min-height:44px;min-width:44px;padding:8px 14px}
#perch-hub-root .ph-tosheet .to-status,#perch-hub-root .ph-tosheet .to-hint{font-size:13px;color:var(--dim)}
#perch-hub-root .ph-tosheet .to-pw-row,#perch-hub-root .ph-tosheet .to-reauth{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
#perch-hub-root .ph-tosheet .to-pw{font-size:15px;overflow-wrap:anywhere;user-select:all}
#perch-hub-root .ph-tosheet .to-reauth-input{min-height:44px;flex:1;min-width:0}
#perch-hub-root .ph-tosheet .to-reauth-error{font-size:13px;color:var(--ink);width:100%}
#perch-hub-root .ph-tosheet .to-view{flex:1;min-height:0;display:flex}
#perch-hub-root .ph-tosheet .to-vnc{flex:1;width:100%;min-height:0;border:1px solid var(--line);border-radius:8px;background:var(--sky)}
/* Spec 2026-10-01: the phone call card (same box as a file card), laid out
   for a phone by the 2026-10-02 polish. min-width:0 + overflow-wrap:anywhere:
   the card never grows past the transcript column, whatever a bot or a
   business typed. */
#perch-hub-root .phonecard{flex-direction:column;gap:8px;align-self:stretch;width:100%;min-width:0;max-width:100%;
background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:2px 0;overflow-wrap:anywhere}
#perch-hub-root .phonecard>*{min-width:0;max-width:100%}
#perch-hub-root .phonecard .ph-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
#perch-hub-root .phonecard .ph-title{font-weight:600;font-size:15px;color:var(--ink);min-width:0;word-break:break-word}
#perch-hub-root .phonecard .ph-meta{font-size:13px;color:var(--dim);margin-top:-6px}
/* The status pill: tinted background, AA text (tokens above). */
#perch-hub-root .phonecard .ph-pill{flex:none;display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;
font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap;font-variant-numeric:tabular-nums}
#perch-hub-root .phonecard .ph-pill-ok,#perch-hub-root .phonecard .ph-pill-live{background:var(--ok-soft);color:var(--ok)}
#perch-hub-root .phonecard .ph-pill-warn,#perch-hub-root .phonecard .ph-pill-wait{background:var(--warn-soft);color:var(--warn)}
#perch-hub-root .phonecard .ph-pill-err{background:var(--err-soft);color:var(--err)}
#perch-hub-root .phonecard .ph-pill-neutral{background:var(--sky);color:var(--ink);border:1px solid var(--line)}
#perch-hub-root .phonecard .ph-dot{width:8px;height:8px;border-radius:50%;background:currentColor;animation:perch-ph-pulse 1.4s ease-in-out infinite}
@keyframes perch-ph-pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){#perch-hub-root .phonecard .ph-dot{animation:none}}
/* Sections: a small-caps label (the .field-label look) over its value. */
#perch-hub-root .phonecard .ph-sec{display:flex;flex-direction:column;gap:3px}
#perch-hub-root .phonecard .ph-label{font:11px/1.2 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
#perch-hub-root .phonecard .ph-goal,#perch-hub-root .phonecard .ph-limits,#perch-hub-root .phonecard .ph-share{font-size:14px;color:var(--ink);white-space:pre-wrap;word-break:break-word}
#perch-hub-root .phonecard .ph-status,#perch-hub-root .phonecard .ph-note,#perch-hub-root .phonecard .ph-proposed,#perch-hub-root .phonecard .ph-hint{font-size:13px;color:var(--dim)}
#perch-hub-root .phonecard .ph-form{display:flex;flex-direction:column;gap:8px;min-width:0}
#perch-hub-root .phonecard details.ph-more>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;min-height:32px}
#perch-hub-root .phonecard details.ph-more>summary::-webkit-details-marker{display:none}
#perch-hub-root .phonecard details.ph-more>summary::after{content:"▸";font-size:12px;color:var(--dim)}
#perch-hub-root .phonecard details.ph-more[open]>summary::after{content:"▾"}
#perch-hub-root .phonecard .ph-field{display:flex;flex-direction:column;gap:3px;font-size:13px;margin:2px 0}
#perch-hub-root .phonecard .ph-fname{font-size:13px;color:var(--dim)}
#perch-hub-root .phonecard textarea,#perch-hub-root .phonecard input[type=text],#perch-hub-root .phonecard input[type=datetime-local]{width:100%;min-width:0;box-sizing:border-box}
/* Checkbox rows: box left, text right, the whole row is a 44px target. The
   shared "#perch-hub-root input" rule gives every input width:100% — undone
   here, or the box stretches onto its own line above its label. */
#perch-hub-root .phonecard label.ph-check{display:flex;align-items:center;gap:12px;min-height:44px;margin:0;padding:4px 0;cursor:pointer;font-size:14px}
#perch-hub-root .phonecard label.ph-check input[type=checkbox]{width:20px;height:20px;flex:none;margin:0;padding:0;accent-color:var(--teal)}
#perch-hub-root .phonecard .ph-check-text{display:flex;flex-direction:column;min-width:0}
#perch-hub-root .phonecard .ph-check-sub{font-size:12px;color:var(--dim);word-break:break-word}
/* One full-width primary action, then quiet secondary ones. */
#perch-hub-root .phonecard button{min-height:44px}
#perch-hub-root .phonecard button.ph-primary{width:100%;background:var(--teal);border-color:var(--teal);color:var(--card);font-weight:600;font-size:15px}
#perch-hub-root .phonecard .ph-secondary{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
#perch-hub-root .phonecard button.ph-link{background:none;border-color:transparent;color:var(--teal);padding:10px 4px}
#perch-hub-root .phonecard button.ph-reject{color:var(--ink)}
#perch-hub-root .phonecard .ph-sched{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#perch-hub-root .phonecard .ph-sched input{flex:1 1 180px}
#perch-hub-root .phonecard .ph-sched button{flex:none}
/* Live transcript as chat bubbles: the assistant left and neutral, the
   business right and tinted, line states and keys as small centred notes. */
#perch-hub-root .phonecard .ph-transcript{max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:2px 0;min-width:0}
#perch-hub-root .phonecard .ph-t-agent,#perch-hub-root .phonecard .ph-t-farend{max-width:85%;padding:7px 11px;font-size:14px;line-height:1.4;
white-space:pre-wrap;word-break:break-word;color:var(--ink)}
#perch-hub-root .phonecard .ph-t-agent{align-self:flex-start;background:var(--sky);border:1px solid var(--line);border-radius:14px 14px 14px 4px}
#perch-hub-root .phonecard .ph-t-farend{align-self:flex-end;background:var(--teal-soft);border-radius:14px 14px 4px 14px}
#perch-hub-root .phonecard .ph-t-state,#perch-hub-root .phonecard .ph-t-dtmf{align-self:center;font-size:12px;color:var(--dim);text-align:center}
#perch-hub-root .phonecard .ph-prompt{font-weight:600;color:var(--teal);font-size:13px}
/* The composer is the card's last row; it wraps to two lines at narrow widths
   (input on its own line, Send + Hang up below) instead of overflowing. */
#perch-hub-root .phonecard .ph-composer{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#perch-hub-root .phonecard .ph-composer input{flex:1 1 180px;min-width:0}
#perch-hub-root .phonecard .ph-composer button{flex:none}
#perch-hub-root .phonecard button.ph-hangup{background:var(--err);border-color:var(--err);color:var(--card);font-weight:600}
/* Terminal: the answer in large text, booking under it, transcript collapsed. */
#perch-hub-root .phonecard .ph-answer{font-size:17px;line-height:1.45;color:var(--ink);white-space:pre-wrap;word-break:break-word}
#perch-hub-root .phonecard .ph-booking{font-size:15px;font-weight:600;color:var(--ink)}
#perch-hub-root .phonecard .ph-toggle{font-size:13px;color:var(--teal)}
#perch-hub-root .phonecard .ph-txbox .ph-transcript{margin-top:6px}
#perch-hub-root .phonecard .ph-err{color:var(--err);font-size:13px}
#perch-hub-root .phonecard .ph-lost{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
#perch-hub-root .phonecard .ph-err:empty{display:none}
#perch-hub-root .phonecard .ph-open{color:var(--teal);font-size:12px;text-decoration:none;align-self:flex-start}
/* Last in the block: [hidden] must beat every display rule above (same
   specificity, later source order). */
#perch-hub-root .phonecard [hidden]{display:none}
/* --- Crow Artifacts chat card (spec v1.6, chat-first PR-1) ---------------
   One node per artifact, upserted in the transcript (the phone-card look:
   head with a status pill, text rows, actions last). Everything the bot
   authored lands through textContent; nothing here trusts the frame. */
#perch-hub-root .artcard{flex-direction:column;gap:6px;align-self:stretch;width:100%;min-width:0;max-width:100%;
background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:2px 0;overflow-wrap:anywhere}
#perch-hub-root .artcard>*{min-width:0;max-width:100%}
/* Card offer, system note and card chip (redesign P5). 44px touch targets. */
#perch-hub-root .perch-offer .art-actions{display:flex;flex-wrap:wrap;gap:8px}
#perch-hub-root .perch-offer button{min-height:44px;min-width:44px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:600 14px/1 Inter,"Public Sans",system-ui,sans-serif;cursor:pointer}
#perch-hub-root .perch-offer .offer-make{background:var(--accent,var(--ink));color:var(--accent-ink,var(--card));border-color:transparent}
#perch-hub-root .perch-offer button:disabled{opacity:.55;cursor:default}
#perch-hub-root .perch-offer .offer-msg{font-size:12px;color:var(--err)}
#perch-hub-root .perch-sysnote{align-self:center;text-align:center;font-size:12px;color:var(--dim);padding:4px 12px;margin:4px 0;max-width:100%;overflow-wrap:anywhere}
#perch-hub-root .perch-sysnote .sysnote-title{font-weight:600}
#perch-hub-root .perch-cardchip{display:flex;align-items:stretch;gap:8px;align-self:stretch;margin:4px 0}
#perch-hub-root .perch-cardchip a{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);text-decoration:none;font-size:13px}
#perch-hub-root .perch-cardchip .cardchip-link{flex:1;min-width:0;gap:6px}
#perch-hub-root .perch-cardchip .cardchip-ref{flex:none;font-weight:600}
#perch-hub-root .perch-cardchip .cardchip-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#perch-hub-root .perch-cardchip .cardchip-lane{flex:none;color:var(--dim)}
#perch-hub-root .perch-cardchip .cardchip-lane:before{content:"\\00b7\\0020"}
/* Review chips (redesign P5, Task 5.4): Accept, Ask for a change, a bot's questions. 44px targets. */
#perch-hub-root .perch-review{display:flex;flex-direction:column;gap:6px;align-self:stretch;margin:4px 0}
#perch-hub-root .perch-review .art-actions,#perch-hub-root .perch-review .review-options,#perch-hub-root .perch-review .review-confirm{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#perch-hub-root .perch-review .review-option{display:flex;flex-direction:column;gap:2px;min-width:0}
#perch-hub-root .perch-review button{min-height:44px;min-width:44px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:600 14px/1.2 Inter,"Public Sans",system-ui,sans-serif;cursor:pointer;overflow-wrap:anywhere;text-align:left}
#perch-hub-root .perch-review .review-accept,#perch-hub-root .perch-review .review-opt-rec,#perch-hub-root .perch-review .review-confirm-yes{background:var(--accent,var(--ink));color:var(--accent-ink,var(--card));border-color:transparent}
#perch-hub-root .perch-review button:disabled{opacity:.55;cursor:default}
#perch-hub-root .perch-review .review-notnow{align-self:flex-start;background:transparent}
#perch-hub-root .perch-review .review-summary,#perch-hub-root .perch-review .review-question{white-space:pre-wrap;overflow-wrap:anywhere}
#perch-hub-root .perch-review .review-question{font-weight:600}
#perch-hub-root .perch-review .review-consequence{font-size:12px;color:var(--dim)}
#perch-hub-root .perch-review .review-field{display:flex;flex-direction:column;gap:6px}
#perch-hub-root .perch-review .review-field[hidden],#perch-hub-root .perch-review .review-confirm[hidden]{display:none}
#perch-hub-root .perch-review .review-input{min-height:44px;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:14px/1.4 Inter,"Public Sans",system-ui,sans-serif;resize:vertical}
#perch-hub-root .perch-review .review-msg{font-size:12px;color:var(--err)}
#perch-hub-root .artcard .art-head{display:flex;align-items:center;gap:8px}
#perch-hub-root .artcard .art-eyebrow{font:600 13px/1.2 Inter,"Public Sans",system-ui,sans-serif;color:var(--dim)}
#perch-hub-root .artcard .art-type{font-size:12px;color:var(--dim)}
#perch-hub-root .artcard .art-pill{flex:none;margin-left:auto;display:inline-flex;align-items:center;border-radius:999px;padding:3px 10px;
font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap;font-variant-numeric:tabular-nums}
#perch-hub-root .artcard .art-pill-ok{background:var(--ok-soft);color:var(--ok)}
#perch-hub-root .artcard .art-pill-warn,#perch-hub-root .artcard .art-pill-wait{background:var(--warn-soft);color:var(--warn)}
#perch-hub-root .artcard .art-pill-err{background:var(--err-soft);color:var(--err)}
#perch-hub-root .artcard .art-title{font-weight:600;font-size:15px;color:var(--ink);word-break:break-word}
#perch-hub-root .artcard .art-meta{font-size:13px;color:var(--dim);font-variant-numeric:tabular-nums}
#perch-hub-root .artcard .art-badges{font-size:13px;color:var(--dim)}
#perch-hub-root .artcard .art-actions{display:flex;flex-wrap:wrap;gap:8px}
#perch-hub-root .artcard button{min-height:44px}
#perch-hub-root .artcard button.art-open{background:var(--teal);border-color:var(--teal);color:var(--card);font-weight:600;font-size:14px;padding:10px 16px}
#perch-hub-root .artcard button.art-run{background:none;border:1px solid var(--line);color:var(--teal);font-size:13.5px;padding:10px 14px}
#perch-hub-root .artcard .art-err{color:var(--err);font-size:13px}
#perch-hub-root .artcard .art-gone{font-size:13px;color:var(--dim)}
#perch-hub-root .artcard [hidden]{display:none}
#perch-hub-root .artcard a.art-window{display:inline-flex;align-items:center;min-height:44px;padding:10px 14px;border:1px solid var(--line);
border-radius:10px;color:var(--teal);font-size:13.5px;text-decoration:none}
/* PR-3: the ask-first link card and the feedback card share the artifact
   card's look (same tokens; text only, buttons 44px). */
#perch-hub-root .artask,#perch-hub-root .artfb{flex-direction:column;gap:6px;align-self:stretch;width:100%;min-width:0;max-width:100%;
background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:2px 0;overflow-wrap:anywhere}
#perch-hub-root :is(.artask,.artfb)>*{min-width:0;max-width:100%}
#perch-hub-root :is(.artask,.artfb) .art-eyebrow{font:600 13px/1.2 Inter,"Public Sans",system-ui,sans-serif;color:var(--dim)}
#perch-hub-root :is(.artask,.artfb) .art-title{font-weight:600;font-size:15px;color:var(--ink);word-break:break-word}
#perch-hub-root :is(.artask,.artfb) .art-meta{font-size:13px;color:var(--dim)}
#perch-hub-root :is(.artask,.artfb) .art-actions{display:flex;flex-wrap:wrap;gap:8px}
#perch-hub-root :is(.artask,.artfb) button{min-height:44px;padding:10px 14px;font-size:13.5px;border-radius:10px;border:1px solid var(--line);background:none;color:var(--teal)}
#perch-hub-root .artask button.art-link-yes{background:var(--teal);border-color:var(--teal);color:var(--card);font-weight:600}
#perch-hub-root :is(.artask,.artfb) .art-err{color:var(--err);font-size:13px}
#perch-hub-root .artfb .art-fb-anchor{font-size:12px;color:var(--dim);margin-top:4px}
#perch-hub-root .artfb .art-fb-comment{font-size:14px;color:var(--ink);padding-left:10px;border-left:2px solid var(--line)}
/* Item 4: the feedback card's live status line and its Show vN action. */
#perch-hub-root .artfb .art-fb-status{font-size:13px;color:var(--dim)}
#perch-hub-root .artfb .art-fb-status:empty{display:none}
#perch-hub-root .artfb button.art-fb-showv{background:var(--teal);border-color:var(--teal);color:var(--card);font-weight:600}
/* Q2: the viewer beside the chat (>=1024px: docked right, the hub narrows
   beside it) or as a full-screen sheet (phone). The pane hosts the SAME-ORIGIN
   viewer page; the hub itself never frames the artifact origin. */
#perch-hub-root .art-pane{position:fixed;z-index:60;background:var(--card);display:flex;flex-direction:column;
border-left:1px solid var(--line);box-shadow:-6px 0 24px rgba(0,0,0,.14)}
#perch-hub-root .art-pane-split{top:0;right:0;bottom:var(--crow-player-h,0px);width:min(48vw,760px)}
#perch-hub-root .art-pane-sheet{inset:0;bottom:var(--crow-player-h,0px);border-left:0}
#perch-hub-root .art-pane-bar{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--line)}
#perch-hub-root .art-pane-bar button,#perch-hub-root .art-pane-bar a{min-height:44px;display:inline-flex;align-items:center;padding:8px 14px;
border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font-size:14px;text-decoration:none}
#perch-hub-root .art-pane-window{margin-left:auto;color:var(--teal) !important}
#perch-hub-root .art-pane-frame{flex:1 1 auto;width:100%;border:0;min-height:0}
body.perch-art-split #perch-hub-root{margin-right:min(48vw,760px)}
/* S4: no pull-to-refresh from an overscroll while the viewer pane is open. */
html.art-pane-open,html.art-pane-open body{overscroll-behavior-y:contain}
#perch-hub-root .art-pane-frame{overscroll-behavior:contain}
/* The menu anchors to #perch-composer (position:sticky = its containing
   block) and grows UPWARD — bottom:100% — so it can never cover Send. */
#perch-cmdmenu{position:absolute;bottom:100%;left:0;right:0;margin-bottom:6px;background:var(--card);
border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);
max-height:40vh;overflow-y:auto;z-index:20}
#perch-hub-root #perch-cmdmenu button{display:block;width:100%;text-align:left;background:none;
border:0;border-bottom:1px solid var(--line);border-radius:0;padding:10px 14px;color:var(--ink);
font-size:13.5px;cursor:pointer;min-height:44px}
#perch-cmdmenu button:last-child{border-bottom:0}
#perch-cmdmenu .cmd-name{font-family:"JetBrains Mono",ui-monospace,monospace;color:var(--teal);font-weight:600}
#perch-cmdmenu .cmd-desc{color:var(--dim);font-size:12px;display:block;margin-top:1px}
#perch-cmdmenu .cmd-empty{padding:10px 14px;color:var(--dim);font-size:13px}
/* --- open-anywhere C2: the directory-picker modal ---------------------
   Built client-side (client.js buildBrowseModal) and appended INSIDE
   #perch-hub-root, so every class rule here stays scoped the way the
   sheet's header comment demands. position:fixed + inset:0 covers the
   whole viewport (the shell's own clamp gives .main-content no transform,
   verified live at both breakpoints — a transformed ancestor would make
   "fixed" resolve against it instead). The [hidden] rule must outrank the
   display:flex on the same id selector, hence the attribute on an id. */
#perch-browse-modal{position:fixed;inset:0;z-index:1200;background:rgba(10,18,24,.45);
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
/* --- R1.2 PR 2, new mode: the session sheet -------------------------------
   No tab bar: the bot name (#perch-ident-btn) opens a modal <dialog> holding
   the Session, Files and Activity sections, and the chat stays on screen
   behind it. Shaped like the shell's sheets (shell/css.js .shell-sheet): a
   bottom sheet on phones, centred from the split breakpoint up, an 85dvh
   cap, a 44px round close and a 16px gutter.
   Colours stay on Perch's own palette, which is what the sections inside
   are painted with. The [open] flex column makes .perch-sheet-inner, and in
   it the visible section (a flex:1 scroller, see the tab-panel rule), the
   only thing that scrolls. */
#perch-hub-root .perch-ident-btn{display:flex;align-items:center;gap:6px;max-width:100%;min-height:44px;padding:4px 8px;margin-left:-8px;border-color:transparent;background:transparent;color:var(--ink);text-align:left}
#perch-hub-root .perch-ident-btn:hover{background:var(--teal-soft)}
#perch-hub-root .perch-ident-btn .title{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#perch-hub-root .perch-ident-btn svg{width:16px;height:16px;flex-shrink:0;color:var(--dim)}
#perch-session-sheet{border:none;padding:0;margin:auto auto 0;width:100%;max-width:480px;max-height:85dvh;
border-radius:var(--crow-radius-card,16px) var(--crow-radius-card,16px) 0 0;background:var(--card);color:var(--ink);box-shadow:0 -8px 32px rgba(0,0,0,.18)}
#perch-session-sheet[open]{display:flex;flex-direction:column}
#perch-session-sheet::backdrop{background:rgba(0,0,0,.4)}
/* The no-showModal fallback (open attribute only): pin it on top. */
#perch-session-sheet[open]:not(:modal){position:fixed;inset:auto 0 0;z-index:1200}
#perch-hub-root .perch-sheet-inner{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;
padding:8px 16px calc(16px + env(safe-area-inset-bottom, 0px))}
#perch-hub-root .perch-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0}
#perch-hub-root .perch-sheet-title{font-size:15px;font-weight:600;min-width:0}
#perch-hub-root .perch-sheet-close{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;margin-right:-8px;border-radius:50%;border-color:transparent;background:transparent}
#perch-hub-root .perch-sheet-close:hover{background:var(--teal-soft)}
#perch-hub-root .perch-sheet-close svg{width:20px;height:20px}
#perch-sheet-tabs{display:flex;gap:4px;flex-shrink:0;border-bottom:1px solid var(--line);padding-bottom:6px}
/* Two ids, as for #perch-tabs: outrank the base "#perch-hub-root button". */
#perch-hub-root #perch-sheet-tabs button{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;
min-height:44px;padding:6px 8px;font-size:13px;border-color:transparent;background:transparent;color:var(--dim)}
#perch-sheet-tabs svg{width:18px;height:18px;flex-shrink:0}
#perch-hub-root #perch-sheet-tabs button[aria-selected="true"]{color:var(--teal);background:var(--teal-soft)}
/* The sheet is phone territory at every width: every control in it is a
   44px target (the Session section's selects, Change directory, the
   plan-mode checkbox, the narrowing rows and the Files crumbs were sized for a pointer). Two ids outrank the base
   "#perch-hub-root button"; the plan-mode checkbox keeps its native look, just larger. */
#perch-hub-root #perch-session-sheet button,#perch-hub-root #perch-session-sheet select{min-height:44px}
/* A one-letter crumb (the "/" root, a short folder) measured 13px wide. */
#perch-hub-root #perch-session-sheet button{min-width:44px}
#perch-hub-root #perch-session-sheet #perch-plan-mode{width:44px;height:44px;align-self:flex-start;accent-color:var(--teal)}
/* The tool-narrowing checkboxes stay native size: their <label> row is the
   target, so the row gets the 44px floor instead. */
#perch-hub-root #perch-session-sheet .narrow-tool{min-height:44px}
@media (min-width:${PERCH_SPLIT_MIN_WIDTH}px){
  #perch-session-sheet{margin:auto;max-width:560px;border-radius:var(--crow-radius-card,16px)}
}
`);
}
