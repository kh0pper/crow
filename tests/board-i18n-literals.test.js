/**
 * Track 3 Task 15 — source-scanning i18n literal check for the roost strip
 * and session drawer's EMITTED CLIENT SCRIPT (client.js/drawer.js).
 *
 * WHY THIS TEST EXISTS: tests/i18n-global-parity.test.js is DICTIONARY-ONLY —
 * it iterates translations{} keys and never looks at panel source, so a
 * handler that does `btn.textContent='Approve';` instead of
 * `btn.textContent='${tJs("board.btnApproveResult", lang)}';` passes every
 * existing gate. This test closes that hole for Track 3's two new client
 * surfaces (spec §8).
 *
 * TECHNIQUE (why a naive "string not present" assertion is WRONG here):
 * clientJs()/birdDrawerJs() are template-literal generators evaluated in
 * Node — tJs(key, lang) resolves and JS-escapes the translated value AT
 * EMIT TIME, so the EMITTED script legitimately CONTAINS plain English text
 * like 'Approve' when lang==='en'. There is no runtime i18n dictionary
 * object shipped to the browser to "scan outside of" — the string is baked
 * in either way, translated or not. So presence/absence of the raw string
 * can't distinguish a translated string from a hardcoded literal.
 *
 * What DOES distinguish them: emit the SAME source at BOTH lang='en' and
 * lang='es' and diff. A translated string (routed through tJs) produces
 * DIFFERENT text in the two emissions (the EN value only in the EN
 * emission, the ES value only in the ES emission). A hardcoded literal
 * ('Approve' typed directly into the handler) is lang-INVARIANT — it shows
 * up in BOTH emissions unchanged, because nothing in the source reads the
 * `lang` parameter for it. `reachesClientViaI18n()` below checks exactly
 * that: EN value present in the EN emission, ES value present in the ES
 * emission, and — the actual regression signal — the EN value NOT leaking
 * into the ES emission.
 *
 * Match boundaries: values are searched as JS-string-literal content,
 * preferring a `'value'`-bounded match, falling back to a `'value` leading-
 * quote match, falling back to a bare substring match — in that order, and
 * only accepted if the same tier holds for BOTH languages without the EN
 * pattern leaking into the ES body. This is not cosmetic: a plain substring
 * search on a short Title-Case word (e.g. "Answer") false-positives against
 * camelCase identifiers the emitter itself defines (`bdAnswerAsk`,
 * `answerFn`), and a bare leading-quote search false-positives against an
 * unrelated ES word that happens to share a prefix (`'Cancelada.'` starts
 * with `'Cancel`, colliding with the EN word "Cancel"). Both were caught
 * empirically while building this list (2026-08-16) and are why the tiered
 * fallback exists instead of a single fixed pattern.
 *
 * SCOPE: this test only scans the EMITTED CLIENT-SIDE SCRIPT — clientJs()
 * (which already has drawer.js spliced in, per client.js's own import of
 * birdDrawerJs) and birdDrawerJs() standalone — because that's the surface
 * with runtime `lang` branching to diff against. A handful of this track's
 * strings (botboard.bdHibernating "asleep — sending will wake it",
 * botboard.bdBindsAtWake "Applies at the next wake.", botboard.bdAttachCard
 * "Attach to card", botboard.roostActionSendOut "Send out",
 * botboard.roostActionRecall "Recall") are rendered ONLY in html.js's SSR
 * markup via t(lang) at render time — never re-emitted into the client
 * script — so they have no EN/ES DIFFERENTIAL to test here; the emitted
 * script never mentions them in either language, so this test's technique
 * literally cannot see them. (The brief's example list includes "Send out",
 * "Recall", "asleep" and "Attach to card" verbatim; verified against the
 * shipped source on 2026-08-16, all four are SSR-only strings, and "Accept"
 * shipped as "Approve" — the existing board.btnApproveResult key, reused by
 * Task 14 for the card-face gate — and "needs you" belongs to a different
 * track-8 surface, servers/gateway/perch-interactive.js's push-notification
 * title, which is server-side text with no client-script emission at all.)
 * The curated key list below is every botboard.roost* key, every
 * botboard.bd* key, and both board.btn*Result keys actually reached via a
 * tJs(...) call in client.js or drawer.js, hand-verified against the source
 * on 2026-08-16 — see the two KEY LIST groupings for which file(s) each is
 * sourced from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientJs } from "../servers/gateway/dashboard/panels/bot-board/client.js";
import { birdDrawerJs } from "../servers/gateway/dashboard/panels/bot-board/drawer.js";
import { translations, tJs } from "../servers/gateway/dashboard/shared/i18n.js";

// ---------------------------------------------------------------------------
// The differential-match helper
// ---------------------------------------------------------------------------

/**
 * True iff `valEn`/`valEs` reach their respective emission through i18n
 * (present, language-appropriate, and the EN value does not leak into the
 * ES body) rather than as an identical hardcoded literal in both.
 */
function reachesClientViaI18n(enBody, esBody, valEn, valEs) {
  const candidates = [
    ["'" + valEn + "'", "'" + valEs + "'"], // both-quote-bounded (preferred)
    ["'" + valEn, "'" + valEs],             // leading-quote only (covers
    // template concatenation where a trailing char sits before the closing
    // quote, e.g. "Answered:" emitted as `'Answered: '`)
    [valEn, valEs],                          // bare substring (last resort;
    // only ever needed for values whose punctuation/whitespace already
    // makes them un-collidable with a bare identifier, e.g. "skills ")
  ];
  for (const [enPat, esPat] of candidates) {
    if (enBody.includes(enPat) && esBody.includes(esPat) && !esBody.includes(enPat)) {
      return true;
    }
  }
  return false;
}

/** Runs the curated-key assertion loop against one EN/ES emission pair. */
function assertKeysReachClient(enBody, esBody, keys, label) {
  for (const key of keys) {
    const entry = translations[key];
    assert.ok(entry, `${key} must exist in translations{} (${label})`);
    assert.ok(entry.en && entry.es, `${key} must carry both en and es (${label})`);
    assert.notEqual(entry.en, entry.es,
      `${key} en/es must differ, or the differential check below is meaningless (${label})`);
    const ok = reachesClientViaI18n(enBody, esBody, tJs(key, "en"), tJs(key, "es"));
    assert.ok(ok,
      `${key} ("${entry.en}") must reach the ${label} emission through tJs(), not as a ` +
      `hardcoded literal — the EN text must NOT appear verbatim in the ES emission`);
  }
}

// ---------------------------------------------------------------------------
// Group A — keys sourced from client.js (the roost strip + the card-face
// Accept/Reject gate Task 14 added there)
// ---------------------------------------------------------------------------

const CLIENT_JS_KEYS = [
  "board.btnApproveResult", "board.btnRejectResult",
  "botboard.bdAttachSent",
  "botboard.roostActionAnswer", "botboard.roostActionFailed", "botboard.roostActionOpen",
  "botboard.roostConfirmRecall",
  "botboard.roostDispatchNoCards", "botboard.roostDispatchOccupied", "botboard.roostDispatchSent",
  "botboard.roostStateHibernating", "botboard.roostStateIdle", "botboard.roostStateObserving",
  "botboard.roostStateWaiting", "botboard.roostStateWorking",
];

// ---------------------------------------------------------------------------
// Group B — keys sourced from drawer.js (the session drawer core, Task 13,
// plus the controls row / envelope / narrowing / attach-file surfaces Task
// 14 added inside it)
// ---------------------------------------------------------------------------

const DRAWER_JS_KEYS = [
  "board.btnApproveResult", "board.btnRejectResult",
  "botboard.bdAbortFailed", "botboard.bdAnsweredPrefix", "botboard.bdAnswerFailed",
  "botboard.bdAskCancel", "botboard.bdCardLinkPrefix",
  "botboard.bdConfirmNo", "botboard.bdConfirmStop", "botboard.bdConfirmYes",
  "botboard.bdControlFailed", "botboard.bdCopied", "botboard.bdCopy", "botboard.bdCycleFailed",
  "botboard.bdEnvelopeModelPrefix", "botboard.bdEnvelopeModelUnset", "botboard.bdEnvelopeSkillsPrefix",
  "botboard.bdFilesQueuedPrefix", "botboard.bdFileUploaded", "botboard.bdFullEnvelopeRestored",
  "botboard.bdInterruptedNote",
  "botboard.bdNarrowedToMid", "botboard.bdNarrowedToPrefix", "botboard.bdNarrowedToSuffix",
  "botboard.bdNarrowFailed", "botboard.bdNarrowNoteEmpty", "botboard.bdNarrowNoteSaved",
  "botboard.bdNarrowNoteUnknown", "botboard.bdNarrowRejected",
  "botboard.bdNoSessions", "botboard.bdNoTranscript", "botboard.bdNoTurn",
  "botboard.bdReconnectFailed", "botboard.bdReconnecting", "botboard.bdResultDecideFailed",
  "botboard.bdSend", "botboard.bdSendFailed", "botboard.bdSessionsLoadFailed",
  "botboard.bdStateAwake", "botboard.bdStateStopped", "botboard.bdSteer", "botboard.bdStopFailed",
  "botboard.bdToolsNone", "botboard.bdTranscriptFailed", "botboard.bdUploadFailed",
  "botboard.roostActionOpen", "botboard.roostStateHibernating",
];

function emittedClientBody(lang) {
  const js = clientJs("scout", "kanban", 9, null, null, lang, false);
  return js.replace(/^<script>/, "").replace(/<\/script>$/, "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("client.js's roost-strip + card-face-gate strings reach the emitted script through i18n, not as literals", () => {
  const enBody = emittedClientBody("en");
  const esBody = emittedClientBody("es");
  assertKeysReachClient(enBody, esBody, CLIENT_JS_KEYS, "clientJs()");
});

test("drawer.js's session-drawer strings reach its emitted source through i18n, not as literals (standalone)", () => {
  const enBody = birdDrawerJs("en");
  const esBody = birdDrawerJs("es");
  assertKeysReachClient(enBody, esBody, DRAWER_JS_KEYS, "birdDrawerJs()");
});

test("drawer.js's strings also survive the SAME check once spliced into clientJs()'s full emission", () => {
  // clientJs() imports and splices birdDrawerJs() in (see client.js's own
  // header comment) — belt-and-suspenders: prove the splice doesn't drop or
  // re-literal-ize anything on the way in.
  const enBody = emittedClientBody("en");
  const esBody = emittedClientBody("es");
  assertKeysReachClient(enBody, esBody, DRAWER_JS_KEYS, "clientJs() [spliced drawer.js]");
});

test("sanity: reachesClientViaI18n actually distinguishes translated from hardcoded text", () => {
  // Positive control: a real i18n-routed pair passes.
  assert.ok(reachesClientViaI18n("x='Approve';", "x='Aprobar';", "Approve", "Aprobar"));
  // Negative control: a HARDCODED literal (same text baked into both lang
  // emissions, exactly what a mutation like `btn.textContent='Approve';`
  // produces regardless of `lang`) must NOT pass.
  assert.ok(!reachesClientViaI18n("x='Approve';", "x='Approve';", "Approve", "Aprobar"));
});
