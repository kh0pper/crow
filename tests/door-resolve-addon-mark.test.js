/**
 * The door source check (servers/gateway/models/door-resolve.js
 * `isTrustedDoorSource`) and the walled add-on's relay mark.
 *
 * The add-on mark (127.0.78.1) is loopback by address, so the loopback rule
 * would trust it: every socket the add-on relay opened for an add-on would then
 * read as a local caller at the /llm door. It is refused before that rule, in
 * every spelling the kernel may report it. The bot mark and ordinary loopback
 * keep today's answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isTrustedDoorSource, isTrustedDoorRequest } from "../servers/gateway/models/door-resolve.js";
import { ADDON_RELAY_SOURCE_V4, RELAY_SOURCE_V4 } from "../servers/shared/bot-doors.js";

test("the add-on relay mark is not a trusted door source, in any spelling", () => {
  assert.equal(ADDON_RELAY_SOURCE_V4, "127.0.78.1");
  for (const a of [
    "127.0.78.1",
    "::ffff:127.0.78.1",
    "::FFFF:127.0.78.1",
    "[::ffff:127.0.78.1]",
    ADDON_RELAY_SOURCE_V4,
  ]) {
    assert.equal(isTrustedDoorSource(a), false, a);
  }
});

test("loopback and the tailnet are still trusted, the bot mark included", () => {
  for (const a of [
    "127.0.0.1", "127.0.77.1", "::ffff:127.0.77.1", "127.0.78.0", "127.0.78.2",
    "::1", "100.64.20.5", "fd7a:115c:a1e0::1", RELAY_SOURCE_V4,
  ]) {
    assert.equal(isTrustedDoorSource(a), true, a);
  }
  for (const a of ["10.0.0.50", "192.168.1.2", "100.128.0.1", "8.8.8.8", ""]) {
    assert.equal(isTrustedDoorSource(a), false, a);
  }
});

test("a forwarded add-on mark never borrows trust from a loopback peer", () => {
  assert.equal(isTrustedDoorRequest("127.0.0.1", {}), true);
  assert.equal(isTrustedDoorRequest("::ffff:127.0.78.1", {}), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": ADDON_RELAY_SOURCE_V4 }), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-real-ip": "::ffff:" + ADDON_RELAY_SOURCE_V4 }), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { forwarded: "for=" + ADDON_RELAY_SOURCE_V4 }), false);
});