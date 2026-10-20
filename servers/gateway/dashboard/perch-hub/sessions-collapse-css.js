import { PERCH_SPLIT_MIN_WIDTH } from "./css.js";

/** Desktop "hide the Sessions column" (2026-10-20).
 *
 *  At and above the split breakpoint the session list is a 320px column
 *  beside the open chat. #perch-list-collapse (in the Sessions heading row)
 *  hides it; #perch-list-reveal (first in the chat head) brings it back. The
 *  client puts `.sessions-collapsed` on #perch-hub-root and keeps it in
 *  localStorage['crow-perch-sessions-collapsed'].
 *
 *  Its own module, appended AFTER perchHubCss() in html.js's <style>, so the
 *  main sheet does not have to change for it. Every rule that reads the
 *  collapsed class sits inside the min-width block AND is keyed on
 *  body[data-view="chat"]: with no session open the chat pane is
 *  display:none even on desktop, so the list must stay up whatever the stored
 *  preference says, and below the breakpoint the phone's one-view-at-a-time
 *  layout is untouched. No font sizes here, so nothing for scaleFontSizes(). */
export function perchSessionsCollapseCss() {
  return `
/* The heading and its collapse button share one row; the row carries the
   margin the bare h2 used to (css.js "#perch-hub-root h2"), so the heading
   sits where it always did. The button is NOT inside the h2: a heading's
   accessible name would otherwise include it. */
#perch-hub-root .perch-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:30px 0 12px}
#perch-hub-root .perch-list-head h2{margin:0}
#perch-hub-root .perch-sessions-toggle{align-items:center;gap:6px;padding:8px 10px}
#perch-hub-root .perch-sessions-toggle svg{width:16px;height:16px;flex:none}
/* Hidden by default: on the phone, and on desktop with no chat open. */
#perch-hub-root #perch-list-collapse,#perch-hub-root #perch-list-reveal{display:none}
@media (min-width:${PERCH_SPLIT_MIN_WIDTH}px){
  body[data-view="chat"] #perch-hub-root #perch-list-collapse{display:inline-flex}
  /* display:none also takes the list's controls out of the tab order. */
  body[data-view="chat"] #perch-hub-root.sessions-collapsed #perch-list{display:none}
  /* With the list gone #perch-chat is the grid's only item; without ONE
     track it would land in the 320px column. */
  body[data-view="chat"] #perch-hub-root.sessions-collapsed .hub-split{grid-template-columns:minmax(0,1fr)}
  body[data-view="chat"] #perch-hub-root.sessions-collapsed #perch-list-reveal{display:inline-flex}
  /* .perch-head is space-between; with the reveal button first that would
     strand the bot name at the far edge. Keep the two together. */
  body[data-view="chat"] #perch-hub-root.sessions-collapsed .perch-head{justify-content:flex-start}
}
`;
}
