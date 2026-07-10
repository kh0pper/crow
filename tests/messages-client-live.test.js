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

import { messagesClientJS } from "../servers/gateway/dashboard/panels/messages/client.js";

const js = messagesClientJS({ aiConfigured: false, storageAvailable: false, lang: "en" });

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
