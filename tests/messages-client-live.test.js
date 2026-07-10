/**
 * messages-client-live — Cluster A Task 6. Live updates (SSE nudge +
 * fallback poll share one incremental-fetch path), id reconciliation between
 * the optimistic send-time bubble and the server row, and Retry on failed
 * bubbles (F-UI-4/5/7).
 *
 * client.js is a big browser-executed template string; per
 * tests/message-delivery-render.test.js's pattern we assert on the BUILT
 * string (and extract individual functions via brace-matching) rather than
 * running the whole thing in a vm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { messagesClientJS } from "../servers/gateway/dashboard/panels/messages/client.js";
import { messagesCSS } from "../servers/gateway/dashboard/panels/messages/css.js";

const js = messagesClientJS({ aiConfigured: false, storageAvailable: false, lang: "en" });

// Raw (pre-build) source text — needed to check for an i18n KEY reference
// (e.g. "contacts.safetyNumber") because tJs(key, lang) is evaluated at
// build time: the BUILT `js` string above contains the resolved translation
// ("Safety number"), not the key name.
const clientSrc = readFileSync(
  new URL("../servers/gateway/dashboard/panels/messages/client.js", import.meta.url),
  "utf8",
);

// Grab a named `function name(...) { ... }` declaration out of the generated
// script text via balanced-brace matching (copied from
// tests/message-delivery-render.test.js's extractFunction).
function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in generated client script`);
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return src.slice(start, i);
}

test("client opens a messages EventSource with crow-msg + crow-receipt + session-expired handlers (F-UI-4)", () => {
  assert.match(js, /new EventSource\('\/dashboard\/streams\/messages'\)/);
  assert.match(js, /addEventListener\('crow-msg'/);
  assert.match(js, /addEventListener\('crow-receipt'/);
  assert.match(js, /addEventListener\('session-expired'/);
});

test("append paths dedupe by data-msg-id (F-UI-5)", () => {
  assert.match(js, /data-msg-id="' \+ /); // dedup querySelector present
});

test("optimistic bubble is stamped with the server row id (F-UI-5)", () => {
  assert.match(js, /sentBubble\.dataset\.msgId = body\.id/);
});

test("failed bubbles get a Retry control (F-UI-7)", () => {
  assert.match(js, /msg-retry-btn/);
  assert.match(js, /retry_of/);
});

test("empty-conversation live arrival APPENDS — it must NOT rebuild the chat UI (R2-C1 draft preservation)", () => {
  // fetchNewPeerMessages handles the empty case by fetching WITHOUT afterId
  // and appending; calling loadPeerConversation there would wipe the composer.
  const fn = extractFunction(js, "fetchNewPeerMessages");
  assert.ok(!/loadPeerConversation/.test(fn), "empty branch must not reload the whole conversation");
  assert.match(fn, /lastId \? '\?afterId=' \+ lastId : ''/);
});

test("startMessagesStream and flipBubbleDelivered are defined and wired into startPolling/stopPolling", () => {
  assert.match(js, /function startMessagesStream\(/);
  assert.match(js, /function flipBubbleDelivered\(/);
  assert.match(js, /function startPolling\(\)[\s\S]*?startMessagesStream\(\);[\s\S]*?\n  \}/);
  assert.match(js, /function stopPolling\(\)[\s\S]*?__crowMsgStream/);
});

test("retryFailedMessage sends retry_of as a string of digits and re-enters the send path", () => {
  const fn = extractFunction(js, "retryFailedMessage");
  assert.match(fn, /retry_of: failedId != null \? String\(failedId\) : undefined/);
  assert.match(fn, /\/api\/messages\/peer\/' \+ encodeURIComponent\(_activeItem\.id\) \+ '\/send'/);
});

test("a failed retry chains the NEXT Retry to the NEW failed row id (supersede-on-failure)", () => {
  // Server contract: a failed resend that wrote a new failed row returns 502
  // {ok:false, id: NEW row} and (with retry_of) deletes the OLD row. The
  // client must re-stamp the bubble and retarget the next Retry click, or a
  // second click would name an already-deleted row.
  const fn = extractFunction(js, "retryFailedMessage");
  assert.match(fn, /bubble\.dataset\.msgId = body\.id/, "failure branch re-stamps the bubble with the new row id");
  assert.match(fn, /failedId = body\.id/, "next retry targets the new failed row");
  // The Retry button reads its ctx at CLICK time from the bubble (el() binds
  // via addEventListener, so the handler itself can't be rebuilt in place).
  const mbf = extractFunction(js, "markBubbleFailed");
  assert.match(mbf, /_retryCtx/, "retry ctx is stored mutably on the bubble and read at click time");
});

test("Info panel renders the symmetric safety number, not the raw peer pubkey (F-UI-6)", () => {
  assert.match(js, /contact\.safety_number/);
  assert.ok(!/ed25519_pubkey\.substring\(0, 32\)/.test(js), "raw truncated peer pubkey must be gone");
  // i18n label reference: checked against the RAW SOURCE, not the built `js`
  // — tJs("contacts.safetyNumber", lang) is evaluated at build time, so the
  // built output holds the resolved translation text ("Safety number"), not
  // the literal key name.
  assert.match(clientSrc, /contacts\.safetyNumber/);
});

test("markBubbleFailed carries no inline styles — the F-UI-6 classes must win", () => {
  // An inline `css:` (el() sets style.cssText) on the failed note/retry
  // button would silently override the legible .msg-bubble-failed-note /
  // .msg-retry-btn class rules in css.js (inline style beats any selector).
  const fn = extractFunction(js, "markBubbleFailed");
  assert.ok(!/css:/.test(fn), "markBubbleFailed must not set inline css — styling lives on the classes");
});

test("delivery CSS is legible (F-UI-6)", () => {
  const css = messagesCSS();
  assert.match(css, /\.msg-delivery\s*\{[^}]*font-size:\s*0\.8rem/s);
  assert.match(css, /\.msg-delivery\.delivered\s*\{[^}]*var\(--crow-success/s);
  assert.match(css, /\.msg-bubble-failed-note/);
  assert.match(css, /\.msg-retry-btn/);
});

// Extra (folded from Task 6 review): the generated client script is a big
// browser-executed template string built per-request from lang/aiConfigured.
// A broken \${tJs(...)} interpolation that only fires for one lang/branch
// combo (e.g. an es-only key typo) would silently ship a syntax error to
// Spanish-language browsers while the en-only build stayed green. Parse
// (not execute) every lang x aiConfigured permutation via `new Function` so
// a syntax break in any combo reddens CI.
function stripScriptTags(html) {
  // messagesClientJS returns a full '<script>...<\/script>' block (see its
  // JSDoc); new Function() needs the bare JS body, not the HTML wrapper.
  const start = html.indexOf("<script>") + "<script>".length;
  const end = html.lastIndexOf("</script>");
  return html.slice(start, end);
}

test("generated client JS parses for every lang x aiConfigured permutation (F-UI-6 regression guard)", () => {
  for (const lang of ["en", "es"]) {
    for (const aiConfigured of [true, false]) {
      const built = messagesClientJS({ aiConfigured, storageAvailable: false, lang });
      assert.doesNotThrow(() => new Function(stripScriptTags(built)), `lang=${lang} aiConfigured=${aiConfigured} must parse`);
    }
  }
});
