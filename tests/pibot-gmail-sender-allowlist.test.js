/**
 * Gmail sender allowlist helper (Item 4-PR4, bridge_tick de-hardcode).
 *
 * bridge_tick used to carry a hardcoded personal SENDER_ALLOWLIST (the
 * maintainer's emails). The wall now derives from the bot def's per-gateway
 * allowlist (gw.allowlist) and FAILS CLOSED when it is empty/absent — unlike
 * passesAllowlist (Discord), where empty means allow-all, an unconfigured
 * Gmail allowlist must never let a third party trigger a bot reply.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gmailSenderAllowed } from "../scripts/pi-bots/gateways/base.mjs";

test("empty/absent allowlist fails closed", () => {
  assert.equal(gmailSenderAllowed([], "a@b.com"), false);
  assert.equal(gmailSenderAllowed(null, "a@b.com"), false);
  assert.equal(gmailSenderAllowed(undefined, "a@b.com"), false);
  assert.equal(gmailSenderAllowed("not-an-array", "a@b.com"), false);
});

test("listed sender allowed, case-insensitive", () => {
  assert.equal(gmailSenderAllowed(["User@Example.com"], "user@example.com"), true);
  assert.equal(gmailSenderAllowed(["user@example.com"], "User@Example.COM"), true);
});

test("unlisted sender rejected", () => {
  assert.equal(gmailSenderAllowed(["user@example.com"], "evil@example.com"), false);
});
