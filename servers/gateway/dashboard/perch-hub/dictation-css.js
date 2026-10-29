import { scaleFontSizes } from "./css.js";

/** Composer dictation (queue item 15): the mic button in the send row and
 *  the recording bar that replaces the textarea + send row while dictating.
 *
 *  Its own module, appended after perchSessionsCollapseCss() in html.js's
 *  <style>, so css.js does not change for it; passed through scaleFontSizes()
 *  so it follows the chat tab's text size like the rest of the composer.
 *
 *  States live on #perch-composer[data-dictation]: idle (or absent) →
 *  starting → recording → transcribing → idle | error. The bar's [hidden] is
 *  toggled by the client too; both are re-asserted here because the id rules
 *  below set a display (css.js's own warning: an author display beats the UA
 *  [hidden] rule).
 *
 *  Labels: icon + word at 600px and wider; icon-only below, each button
 *  keeping aria-label + title = the word. The mic keeps its visible
 *  "Dictate" at every width. */
export function perchDictationCss() {
  return scaleFontSizes(`
#perch-hub-root #perch-dictate{display:inline-flex;align-items:center;gap:6px;min-height:44px}
#perch-hub-root #perch-dictate[hidden]{display:none}
#perch-hub-root #perch-dictate svg{width:18px;height:18px;flex:none}
/* With the mic in the row, a phone at the largest text size with a turn in
   flight holds Attach image + Dictate + Steer + Stop: wrap to a second line
   rather than overflow, with Send/Steer and Stop on the trailing edge. Keyed
   on .has-dictate (set by the client when the mic shows) so the row is
   exactly today's wherever dictation is unavailable. */
#perch-composer.has-dictate .send-row{flex-wrap:wrap}
#perch-composer.has-dictate #perch-send{margin-inline-start:auto}
/* While dictating, the bar replaces the textarea and the send row. */
#perch-composer[data-dictation="starting"]>#perch-input,#perch-composer[data-dictation="starting"]>.send-row,
#perch-composer[data-dictation="recording"]>#perch-input,#perch-composer[data-dictation="recording"]>.send-row,
#perch-composer[data-dictation="transcribing"]>#perch-input,#perch-composer[data-dictation="transcribing"]>.send-row,
#perch-composer[data-dictation="error"]>#perch-input,#perch-composer[data-dictation="error"]>.send-row,
#perch-composer[data-dictation]:not([data-dictation="idle"])>.pill-row,#perch-composer[data-dictation]:not([data-dictation="idle"])>#perch-plus-menu{display:none}
#perch-dictation-bar{display:flex;align-items:center;gap:8px;min-width:0;min-height:52px}
#perch-dictation-bar[hidden]{display:none}
#perch-hub-root .dict-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;flex:none;padding:10px 14px}
#perch-hub-root .dict-btn svg{width:18px;height:18px;flex:none}
#perch-hub-root #perch-dict-retry[hidden],#perch-hub-root #perch-dict-done[hidden],#perch-hub-root #perch-dict-send[hidden]{display:none}
/* Done and Send exist only while recording. */
#perch-composer:not([data-dictation="recording"]) #perch-dict-done,
#perch-composer:not([data-dictation="recording"]) #perch-dict-send{display:none}
#perch-dictation-bar .dict-mid{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
#perch-dictation-bar .dict-status{min-width:0;color:var(--dim);font-size:14px;overflow-wrap:anywhere}
#perch-composer[data-dictation="error"] .dict-status{color:var(--err)}
/* Recording: the level line and the timer speak for themselves; the word
   stays for screen readers only (the live region announces it once). */
#perch-composer[data-dictation="recording"] .dict-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
#perch-dictation-bar .dict-level{flex:1;min-width:0;height:28px;display:flex;align-items:center;gap:3px;overflow:hidden}
#perch-dictation-bar .dict-level i{flex:0 0 4px;height:4px;border-radius:2px;background:var(--teal);transform-origin:center;opacity:.8}
#perch-dictation-bar .dict-time{flex:none;color:var(--dim);font-size:13px;font-variant-numeric:tabular-nums}
#perch-dictation-bar .dict-time.late{color:var(--err);font-weight:600}
#perch-composer:not([data-dictation="recording"]) .dict-level,
#perch-composer:not([data-dictation="recording"]) .dict-time{display:none}
#perch-dictation-bar .dict-spin{display:none;width:16px;height:16px;flex:none;border:2px solid var(--line);border-top-color:var(--teal);border-radius:50%;animation:perch-spin 1s linear infinite}
#perch-composer[data-dictation="transcribing"] .dict-spin{display:inline-block}
@media (prefers-reduced-motion:reduce){#perch-dictation-bar .dict-spin{animation-duration:4s}}
#perch-dictation-hint{color:var(--dim);font-size:12px;padding:0 2px}
#perch-dictation-hint[hidden]{display:none}
@media (max-width:599px){
  #perch-dictation-bar .dict-word{display:none}
  #perch-hub-root .dict-btn{padding:10px}
}
`);
}
