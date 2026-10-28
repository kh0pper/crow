// The @bot grammar moved to servers/shared/bot-mention.js; the move must change
// nothing. The fixture is the P6 capture of the original functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as s from "../servers/shared/bot-mention.js";
import * as a from "../bundles/artifacts/server/mentions.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/bot-mention-p6.json", import.meta.url), "utf8"));

test("P6 byte identity: regex source and function sources equal the P6 capture", () => {
  assert.equal(s.MENTION_RE.source, fx.re);
  assert.equal(s.parseMention.toString(), fx.parseMention);
  assert.equal(s.resolveMentionedBot.toString(), fx.resolveMentionedBot);
  assert.equal(s.mentionBotFor.toString(), fx.mentionBotFor);
});

test("artifacts re-exports the same function objects", () => {
  assert.equal(a.parseMention, s.parseMention);
  assert.equal(a.resolveMentionedBot, s.resolveMentionedBot);
  assert.equal(a.mentionBotFor, s.mentionBotFor);
  assert.equal(a.MENTION_RE, s.MENTION_RE);
});

test("parseMentions: all tokens, deduped; email is not a mention", () => {
  assert.deepEqual(s.parseMentions("@hank and @Ana, me@x.org @hank"), ["hank", "Ana"]);
  assert.deepEqual(s.parseMentions(null), []);
  assert.deepEqual(s.parseMentions("none here"), []);
});
