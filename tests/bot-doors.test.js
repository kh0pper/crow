/**
 * Containment PR 6, layer 1: the door allowlist a contained bot's requests to
 * its own gateway are judged against, and the relay mark the gateway
 * recognises (servers/shared/bot-doors.js).
 *
 * The spellings are the ones a bot can actually send: a second slash, a ".."
 * segment, a percent-escape, a backslash, an absolute-form URL, "OPTIONS *".
 * Each of them normalises into a forbidden route in some router, so none is
 * reasoned about — all are refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOT_DOOR_PREFIXES, RELAY_SOURCE_V4, isDoorPath, isRelayedSocket } from "../servers/shared/bot-doors.js";
import { classifyPeer } from "../servers/shared/peer-class.js";

test("path spellings", () => {
  for (const p of [
    "/llm/v1/chat/completions",
    "/llm/p/x/v1/models",
    "/llm/c/x/v1/messages",
    "/llm/v1/",
    "/board/mcp",
    "/board/mcp?x=1",
    "/board/mcp/",
    "/phone/mcp",
    "/artifacts/mcp",
    "/peer-relay/i/m/mcp",
    "/peer-relay/",
  ]) assert.equal(isDoorPath(p), true, p);

  for (const p of [
    "/internal/actor-sign",
    "//internal/actor-sign",
    "/llm/v1/../internal/actor-sign",
    "/llm/v1/%2e%2e/internal/actor-sign",
    "/llm/v1/%2E%2E/x",
    "/board/mcp/..%2f..%2finternal",
    "/board%2fmcp",
    "/llm\\v1",
    "http://127.0.0.1:1/internal/actor-sign",
    "*",
    "/llm/models",
    "/llm/acquire",
    "/LLM/v1/x",
    "/board/mcpx",
    "/memory/mcp",
    "/dashboard",
    // any percent-escape at all, not only the traversal ones
    "/llm/v1/x%41",
    "/internal/actor-sign",
  ]) assert.equal(isDoorPath(p), false, p);

  for (const p of ["", "/", "board/mcp", "/board/mcp x", "/llm/v1/\u0000", "/peer-relay"]) assert.equal(isDoorPath(p), false, JSON.stringify(p));
  assert.equal(isDoorPath(null), false);
  assert.equal(isDoorPath(undefined), false);
  assert.equal(isDoorPath(42), false);
});

test("the door list is exactly the doors the operator's ruling fixed, frozen", () => {
  assert.deepEqual([...BOT_DOOR_PREFIXES],
    ["/llm/v1/", "/llm/p/", "/llm/c/", "/board/mcp", "/phone/mcp", "/artifacts/mcp", "/peer-relay/"]);
  assert.equal(Object.isFrozen(BOT_DOOR_PREFIXES), true);
  assert.equal(RELAY_SOURCE_V4, "127.0.77.1");
});

test("the relay mark is recognised in every spelling the kernel reports", () => {
  for (const a of ["127.0.77.1", "::ffff:127.0.77.1", "::FFFF:127.0.77.1", "[::ffff:127.0.77.1]"]) {
    assert.equal(isRelayedSocket({ remoteAddress: a }), true, a);
  }
  for (const a of ["127.0.0.1", "::1", "127.0.77.2", "::ffff:10.0.0.1", "192.0.2.9", "", undefined]) {
    assert.equal(isRelayedSocket({ remoteAddress: a }), false, String(a));
  }
  assert.equal(isRelayedSocket(null), false);
  assert.equal(isRelayedSocket({}), false);
});

test("mark source is still a local peer", () => {
  const req = { socket: { remoteAddress: RELAY_SOURCE_V4 }, headers: {} };
  assert.equal(classifyPeer(req).via, "local");
  // A dual-stack listener reports the same connection v4-mapped.
  const mapped = { socket: { remoteAddress: "::ffff:" + RELAY_SOURCE_V4 }, headers: {} };
  assert.equal(classifyPeer(mapped).via, "local");
});