// Crow Mail plan 3, Task 8a: the drafting turn's token (servers/gateway/mail/drafts/turn-token.js).
//
// A turn's token is minted in the gateway process's memory, bound to one (draft, turn) pair and to the
// head hash the turn started from, and revoked when the turn ends. It is a scope, not a secret cached
// anywhere: nothing survives a restart because nothing is on disk, and only the hash of the token is
// held as a key. These cases pin that shape without a database, an HTTP server or a clock.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mintTurnToken, revokeTurnToken, verifyTurnToken, turnTokenTtlMs, _resetTurnTokensForTests,
} from "../servers/gateway/mail/drafts/turn-token.js";

const DRAFT_A = "md-0123456789abcdef";
const DRAFT_B = "md-fedcba9876543210";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const BOT_A = "alex-bot";
const BOT_B = "sam-bot";
const MINUTE = 60_000;

const mintA = (over = {}) => mintTurnToken({
  draftId: DRAFT_A, turnId: "turn-a", startHash: HASH_A, botId: BOT_A, ...over,
});

beforeEach(() => { _resetTurnTokensForTests(); });

test("a token verifies to the draft, turn and head hash it was minted for", () => {
  const token = mintA({ ttlMs: 5 * MINUTE });
  assert.match(token, /^mdt_[0-9a-f]{64}$/, "mdt_ and 32 random bytes as hex");
  const claims = verifyTurnToken(token);
  assert.equal(claims.draftId, DRAFT_A);
  assert.equal(claims.turnId, "turn-a");
  assert.equal(claims.startHash, HASH_A);
  assert.equal(typeof claims.expiresAt, "number");
});

test("the token names the bot its turn runs as, and minting without one is refused", () => {
  const token = mintA({ ttlMs: 5 * MINUTE });
  assert.equal(verifyTurnToken(token).botId, BOT_A, "the mount checks the actor id against this");
  // A token with no bot id would admit any bot's signature for the tuple.
  assert.throws(
    () => mintTurnToken({ draftId: DRAFT_A, turnId: "turn-a", startHash: HASH_A }),
    TypeError,
  );
  assert.throws(
    () => mintTurnToken({ draftId: DRAFT_A, turnId: "turn-a", startHash: HASH_A, botId: "  " }),
    TypeError,
  );
});

test("a token minted with no ttlMs expires at turnTokenTtlMs(), the turn's timeout plus the margin", () => {
  const ttl = turnTokenTtlMs();
  const before = Date.now();
  const claims = verifyTurnToken(mintA());
  const after = Date.now();
  assert.ok(claims, "the default lifetime is still a live token");
  assert.ok(
    claims.expiresAt >= before + ttl && claims.expiresAt <= after + ttl,
    `expiresAt ${claims.expiresAt} is one default lifetime from the mint`,
  );
  assert.ok(ttl > MINUTE, "the default lifetime includes the margin, not a bare timeout");
});

test("two mints are two different tokens for the same turn", () => {
  const first = mintA();
  const second = mintA();
  assert.notEqual(first, second);
  assert.equal(verifyTurnToken(first).draftId, DRAFT_A);
  assert.equal(verifyTurnToken(second).draftId, DRAFT_A);
});

test("token for draft A cannot read thread B", () => {
  const a = mintA();
  const b = mintTurnToken({ draftId: DRAFT_B, turnId: "turn-b", startHash: HASH_B, botId: BOT_B });
  assert.equal(verifyTurnToken(a).draftId, DRAFT_A);
  assert.equal(verifyTurnToken(b).draftId, DRAFT_B);
  // A changed token is not a token: the map key is the hash of the exact string.
  const flipped = a.slice(0, -1) + (a.endsWith("0") ? "1" : "0");
  assert.equal(verifyTurnToken(flipped), null);
  assert.equal(verifyTurnToken(a + "0"), null);
  assert.equal(verifyTurnToken(a.slice(0, -1)), null);
});

test("an expired, revoked or unknown token is refused", () => {
  const expired = mintA({ ttlMs: 0 });
  assert.equal(verifyTurnToken(expired), null, "ttlMs 0 is already past");

  const revoked = mintA({ ttlMs: 5 * MINUTE });
  assert.equal(verifyTurnToken(revoked).draftId, DRAFT_A, "live before the revoke");
  assert.equal(revokeTurnToken(revoked), true);
  assert.equal(verifyTurnToken(revoked), null);

  assert.equal(verifyTurnToken("mdt_" + "0".repeat(64)), null, "never minted here");
  assert.equal(verifyTurnToken("not-a-token"), null);
  assert.equal(verifyTurnToken(undefined), null);
  assert.equal(verifyTurnToken(null), null);
});

test("revoking a token that was never minted answers false and leaves the live ones alone", () => {
  const live = mintA({ ttlMs: 5 * MINUTE });
  assert.equal(revokeTurnToken("mdt_" + "1".repeat(64)), false);
  assert.equal(revokeTurnToken(null), false);
  assert.equal(verifyTurnToken(live).draftId, DRAFT_A, "an unrelated revoke revokes nothing");
});

test("a token minted before a simulated restart is refused", async () => {
  const token = mintA({ ttlMs: 5 * MINUTE });
  assert.equal(verifyTurnToken(token).draftId, DRAFT_A);
  // A second module instance is a restarted gateway: the map is process memory, so it is empty there.
  const restarted = await import("../servers/gateway/mail/drafts/turn-token.js?restart=1");
  assert.notEqual(restarted.verifyTurnToken, verifyTurnToken, "a fresh instance");
  assert.equal(restarted.verifyTurnToken(token), null);
});

test("a token is refused after revokeTurnToken even before its expiry", () => {
  const token = mintA({ ttlMs: 30 * MINUTE });
  assert.equal(verifyTurnToken(token).draftId, DRAFT_A, "live before the revoke");
  revokeTurnToken(token);
  assert.equal(verifyTurnToken(token), null, "revoked at once, not at its expiry");
});

test("expiry follows PIBOT_TURN_TIMEOUT_MS plus the margin", () => {
  // The turn's own timeout (bridge.mjs: `Number(process.env.PIBOT_TURN_TIMEOUT_MS || 600000)`) and 60 s.
  assert.equal(turnTokenTtlMs({}), 600_000 + MINUTE);
  assert.equal(turnTokenTtlMs({ PIBOT_TURN_TIMEOUT_MS: "1000" }), 1_000 + MINUTE);
  assert.equal(turnTokenTtlMs({ PIBOT_TURN_TIMEOUT_MS: "1800000" }), 1_800_000 + MINUTE);
  assert.equal(turnTokenTtlMs({ PIBOT_TURN_TIMEOUT_MS: "soon" }), 600_000 + MINUTE, "unreadable falls back");
  // A token minted with that lifetime is live, and the margin never shortens a turn.
  const token = mintA({ ttlMs: turnTokenTtlMs({ PIBOT_TURN_TIMEOUT_MS: "1000" }) });
  const claims = verifyTurnToken(token);
  assert.equal(claims.turnId, "turn-a");
});