/**
 * requesterTag — who asked for a model? (model-start attribution, log-only).
 *
 * /llm/v1 is unauthenticated by design (the companion is loopback), so the
 * only attribution available is what the request carries: peer ip, a
 * bounded user-agent, and the optional X-Crow-Client tag first-party
 * clients set. The tag is pure, never throws, and tolerates `{}`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { requesterTag } from "../servers/gateway/requester-tag.js";

test("requesterTag: ip + ua + client, bounded, dash for missing", () => {
  assert.equal(requesterTag({}), "- ua=- client=-");
  assert.equal(
    requesterTag({ ip: "::ffff:10.0.0.5", headers: { "user-agent": "x".repeat(60), "x-crow-client": "companion" } }),
    "10.0.0.5 ua=" + "x".repeat(40) + " client=companion"
  );
  assert.equal(requesterTag({ ip: "127.0.0.1", headers: { "x-crow-client": "a b\nc" } }), "127.0.0.1 ua=- client=a_b_c");
});

test("requesterTag: never throws on a null/undefined request or headers", () => {
  assert.equal(requesterTag(undefined), "- ua=- client=-");
  assert.equal(requesterTag(null), "- ua=- client=-");
  assert.equal(requesterTag({ ip: "10.0.0.9", headers: null }), "10.0.0.9 ua=- client=-");
});

test("requesterTag: user-agent whitespace is collapsed and the client tag is bounded to 40 chars", () => {
  const tag = requesterTag({
    ip: "10.0.0.7",
    headers: { "user-agent": "  Mozilla/5.0\n(X11;\tLinux)  ", "x-crow-client": "pibot-warm/" + "b".repeat(80) },
  });
  assert.equal(tag, "10.0.0.7 ua=Mozilla/5.0 (X11; Linux) client=pibot-warm/" + "b".repeat(29));
});
