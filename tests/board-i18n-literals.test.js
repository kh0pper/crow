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
 * TWO SURFACES, SAME TECHNIQUE, DIFFERENT MATCH SYNTAX: this file has two
 * parts. Part 1 scans the EMITTED CLIENT-SIDE SCRIPT — clientJs() (which
 * already has drawer.js spliced in, per client.js's own import of
 * birdDrawerJs) and birdDrawerJs() standalone. Part 2 (fix round 1,
 * 2026-08-16) scans the SSR MARKUP functions in html.js — roostStripHtml(),
 * roostDispatchDialogMarkup(), birdDrawerMarkup() — which is where MOST of
 * this track's user-facing strings actually live (botboard.bdHibernating
 * "asleep — sending will wake it", botboard.bdBindsAtWake "Applies at the
 * next wake.", botboard.bdAttachCard "Attach to card",
 * botboard.roostActionSendOut "Send out", botboard.roostActionRecall
 * "Recall" — the brief's own example strings, verified 2026-08-16 to be
 * SSR-only, never re-emitted into the client script, which is why Part 1
 * alone couldn't see them). Both parts use the SAME EN-vs-ES differential
 * idea (a hardcoded literal is lang-invariant; a real t()/tJs() call is
 * not) but the boundary syntax differs: Part 1 matches JS-string-literal
 * quoting (`'value'`); Part 2 matches HTML text-node/attribute boundaries
 * (`>value<`, `"value"`) since html.js's t() calls land in markup, not JS
 * string literals. "Accept" shipped as "Approve" — the existing
 * board.btnApproveResult key, reused by Task 14 for the card-face gate —
 * and "needs you" belongs to a different track-8 surface,
 * servers/gateway/perch-interactive.js's push-notification title, which is
 * server-side-only text with no client-script OR html.js-markup emission at
 * all (out of scope for both parts of this file).
 *
 * Both curated key lists (Part 1 and Part 2) are HAND-MAINTAINED ON
 * PURPOSE, not scraped from source at test time. A scraped list (e.g.
 * "every key passed to tJs(...) in this file") is blind to exactly the
 * regression this test exists to catch: delete the tJs()/t() call for one
 * key and replace it with a literal, and a scrape done AFTER that mutation
 * would simply stop looking for that key — a silent, self-defeating pass.
 * The lists are fixed at the moment they were verified against real output
 * (2026-08-16); adding a new track-3 user-facing string means manually
 * extending the relevant list here, not regenerating it.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clientJs } from "../servers/gateway/dashboard/panels/bot-board/client.js";
import { birdDrawerJs } from "../servers/gateway/dashboard/panels/bot-board/drawer.js";
import { translations, tJs } from "../servers/gateway/dashboard/shared/i18n.js";

// html.js (Part 2, below) pulls in data-queries.js's TASKS_DB — a path
// string computed at MODULE-IMPORT time from CROW_TASKS_DB_PATH. Harmless
// either way for the three pure render functions this file calls (none of
// them opens a DB connection) — verified empirically before writing this
// file — but pointed at a scratch dir first regardless, matching the
// fixture convention tests/roost-strip-ui.test.js and
// tests/bird-drawer-core.test.js use, so this file never has an opinion
// about — or any chance of touching — a real ~/.crow. Static `import`
// declarations are hoisted above ANY same-file statement (env vars included)
// regardless of source order, so the env vars are set here and html.js is
// imported dynamically inside before() — the only way to guarantee the env
// var actually lands before html.js's module body runs.
const dir = mkdtempSync(join(tmpdir(), "board-i18n-literals-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

let roostStripHtml, roostDispatchDialogMarkup, birdDrawerMarkup;
before(async () => {
  ({ roostStripHtml, roostDispatchDialogMarkup, birdDrawerMarkup } =
    await import("../servers/gateway/dashboard/panels/bot-board/html.js"));
});

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

// =============================================================================
// PART 1 — the emitted client-side script (clientJs()/birdDrawerJs())
// =============================================================================

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
// Part 1 tests
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

// =============================================================================
// PART 2 (fix round 1, 2026-08-16) — the SSR MARKUP functions in html.js
// =============================================================================
//
// roostStripHtml(), roostDispatchDialogMarkup() and birdDrawerMarkup() are
// where MOST of this track's user-facing strings actually render (see the
// file header) — they were entirely unguarded before this fix round.
//
// Match syntax differs from Part 1 because these are HTML strings, not JS
// source: t(key, lang) lands as either a text-node's content (bounded by the
// surrounding tags, `>value<`) or an HTML attribute's value (bounded by
// quotes, `"value"`), never inside a JS string literal. The same three-tier
// preference order applies (tightest bound first, bare substring last) for
// the same reason as Part 1: a bare substring search on a short word risks
// colliding with an HTML class/id/attribute name that happens to contain it.

/**
 * SSR analogue of reachesClientViaI18n() — same EN-vs-ES differential idea,
 * HTML-boundary match syntax instead of JS-string-literal syntax.
 */
function reachesSsrViaI18n(enHtml, esHtml, valEn, valEs) {
  const candidates = [
    [">" + valEn + "<", ">" + valEs + "<"],   // text-node content (preferred)
    ["\"" + valEn + "\"", "\"" + valEs + "\""], // HTML attribute value
    // (aria-label, placeholder — html.js escapeHtml()'s output for these
    // curated values is identical to the raw value; none of them contain
    // `&`, `<`, `>`, `"` or `'`)
    [valEn, valEs],                             // bare substring (last
    // resort; only used where punctuation/whitespace in the value already
    // rules out an identifier/class-name collision)
  ];
  for (const [enPat, esPat] of candidates) {
    if (enHtml.includes(enPat) && esHtml.includes(esPat) && !esHtml.includes(enPat)) {
      return true;
    }
  }
  return false;
}

/** SSR analogue of assertKeysReachClient(). */
function assertKeysReachSsr(enHtml, esHtml, keys, label) {
  for (const key of keys) {
    const entry = translations[key];
    assert.ok(entry, `${key} must exist in translations{} (${label})`);
    assert.ok(entry.en && entry.es, `${key} must carry both en and es (${label})`);
    assert.notEqual(entry.en, entry.es,
      `${key} en/es must differ, or the differential check below is meaningless (${label})`);
    const ok = reachesSsrViaI18n(enHtml, esHtml, entry.en, entry.es);
    assert.ok(ok,
      `${key} ("${entry.en}") must reach the ${label} markup through t(), not as a ` +
      `hardcoded literal — the EN text must NOT appear verbatim in the ES markup`);
  }
}

// Same fixture SHAPE as tests/roost-strip-ui.test.js (five bots, one per
// roost-fold state) — reused directly here since roostStripHtml(bots,
// engine, lang) is a pure function of its three arguments (computeRoostBirds
// only reads bird.definition + engine.list(), never the DB), so no
// renderKanbanBoard/DB round-trip is needed to reach every t() call inside
// roostBirdHtml().
const PERCH_DEF = { gateways: [{ type: "perch" }] };
const GMAIL_DEF = { gateways: [{ type: "gmail", address: "q@example.com", allowlist: ["a@example.com"] }] };
const SSR_BOTS = [
  { botId: "empty-bot", displayName: "Empty Bot", definition: PERCH_DEF }, // idle
  { botId: "chatty", displayName: "Chatty", definition: PERCH_DEF },       // working
  { botId: "asker", displayName: "Asker", definition: PERCH_DEF },         // waiting
  { botId: "sleepy", displayName: "Sleepy", definition: PERCH_DEF },       // hibernating
  { botId: "quiet", displayName: "Quiet", definition: GMAIL_DEF },         // observing (unattached)
];
const SSR_ENGINE_SESSIONS = [
  { sessionId: "chatty-1", botId: "chatty", state: "awake", pendingUi: null, cardId: null },
  { sessionId: "asker-a", botId: "asker", state: "awake", pendingUi: { kind: "ask" }, cardId: null },
  { sessionId: "sleepy-1", botId: "sleepy", state: "hibernating", pendingUi: null, cardId: null },
];
const ssrEngine = { list: async () => SSR_ENGINE_SESSIONS };

// ---------------------------------------------------------------------------
// Group C — keys sourced from html.js's roostStripHtml()/roostBirdHtml()
// (Task 12: the roost strip's state text, per-state primary action, and the
// overflow menu every bird carries)
// ---------------------------------------------------------------------------

const ROOST_SSR_KEYS = [
  "botboard.roostStateIdle", "botboard.roostStateWorking", "botboard.roostStateWaiting",
  "botboard.roostStateHibernating", "botboard.roostStateObserving",
  "botboard.roostActionSendOut", "botboard.roostActionAnswer", "botboard.roostActionOpen",
  "botboard.roostActionAttach", "botboard.roostActionRecall", "botboard.roostMoreAria",
  "botboard.roostActionTalk", "botboard.roostActionSessions", "botboard.roostActionSetup",
];

// ---------------------------------------------------------------------------
// Group D — keys sourced from html.js's roostDispatchDialogMarkup() (the
// Send-out card-picker dialog)
// ---------------------------------------------------------------------------

const DISPATCH_SSR_KEYS = [
  "botboard.roostDispatchTitle", "botboard.roostDispatchCardLabel",
  "botboard.roostDispatchNoteLabel", "botboard.roostDispatchConfirm",
];

// ---------------------------------------------------------------------------
// Group E — keys sourced from html.js's birdDrawerMarkup() (Task 13's static
// drawer shell, plus the Task 14 controls-row/attach affordances inside it)
// ---------------------------------------------------------------------------

const DRAWER_SSR_KEYS = [
  "botboard.bdMoreAria", "botboard.bdStop", "botboard.bdHibernating",
  "botboard.bdEnvelopeModelPrefix", "botboard.bdPermGuarded", "botboard.bdPermAsk",
  "botboard.bdPermBypass", "botboard.bdPlanModeLabel", "botboard.bdBindsAtWake",
  "botboard.bdApplyNow", "botboard.bdEnvelopeToggle", "botboard.bdAttachCard",
  "botboard.bdAttachFile", "botboard.bdComposerPlaceholder", "botboard.bdSend", "botboard.bdAbort",
];

// ---------------------------------------------------------------------------
// Part 2 tests
// ---------------------------------------------------------------------------

test("html.js's roost strip renders bird state/action/menu text through i18n, not as literals", async () => {
  const enHtml = await roostStripHtml(SSR_BOTS, ssrEngine, "en");
  const esHtml = await roostStripHtml(SSR_BOTS, ssrEngine, "es");
  assertKeysReachSsr(enHtml, esHtml, ROOST_SSR_KEYS, "roostStripHtml()");
});

test("html.js's roost strip empty state renders through i18n, not as a literal", async () => {
  const enHtml = await roostStripHtml([], ssrEngine, "en");
  const esHtml = await roostStripHtml([], ssrEngine, "es");
  assertKeysReachSsr(enHtml, esHtml, ["botboard.roostEmpty"], "roostStripHtml() [empty]");
});

test("html.js's send-out dispatch dialog renders through i18n, not as literals", () => {
  const enHtml = roostDispatchDialogMarkup("en");
  const esHtml = roostDispatchDialogMarkup("es");
  assertKeysReachSsr(enHtml, esHtml, DISPATCH_SSR_KEYS, "roostDispatchDialogMarkup()");
});

test("html.js's session drawer static shell renders through i18n, not as literals", () => {
  const enHtml = birdDrawerMarkup("en");
  const esHtml = birdDrawerMarkup("es");
  assertKeysReachSsr(enHtml, esHtml, DRAWER_SSR_KEYS, "birdDrawerMarkup()");
});

test("sanity: reachesSsrViaI18n actually distinguishes translated markup from hardcoded text", () => {
  // Positive control.
  assert.ok(reachesSsrViaI18n("<div>Send out</div>", "<div>Enviar</div>", "Send out", "Enviar"));
  // Negative control: a HARDCODED literal baked into both lang renders
  // (exactly what mutating `${t("botboard.roostActionSendOut", lang)}` to a
  // bare `Send out` in html.js produces) must NOT pass.
  assert.ok(!reachesSsrViaI18n("<div>Send out</div>", "<div>Send out</div>", "Send out", "Enviar"));
});
