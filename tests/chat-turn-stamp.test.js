/**
 * Dashboard chat's per-turn stamp (servers/gateway/routes/chat.js stampLatestUserTurn). The latest USER message gets
 * the "[Current date and time: …]" line in every tool round (not only while it is the last message), so the model
 * keeps the date after a tool call and the user message's bytes stay the same round to round; a [Dates] line follows
 * when the user's own words name a relative day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stampLatestUserTurn, chatEchoGate } from "../servers/gateway/routes/chat.js";
import { relativeDatesContext } from "../servers/shared/relative-dates.js";

const THU = new Date(Date.UTC(2026, 9, 15, 21, 57));
const stampOf = (now) => `[Current date and time: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}, ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}]`;
const DATES = relativeDatesContext(THU.getTime(), null);

const history = [
  { role: "user", content: "earlier question about Friday" },
  { role: "assistant", content: "earlier answer" },
];

test("round 1: the latest user message gets the unchanged date-time stamp; history is untouched", () => {
  const msgs = [...history, { role: "user", content: "how are you" }];
  const { messages, datesLine } = stampLatestUserTurn(msgs, { now: THU });
  assert.deepEqual(messages.slice(0, 2), history);
  assert.equal(messages[2].content, `how are you\n\n${stampOf(THU)}`);
  assert.equal(datesLine, null);
});

test("a relative day named → the [Dates] line after the stamp", () => {
  const { messages, datesLine } = stampLatestUserTurn([{ role: "user", content: "add the dentist Monday" }], { now: THU });
  assert.equal(messages[0].content, `add the dentist Monday\n\n${stampOf(THU)}\n\n${DATES}`);
  assert.equal(datesLine, DATES);
});

test("round 2 (user, assistant tool_calls, tool) gives the user message the same bytes as round 1", () => {
  const user = { role: "user", content: "add the dentist Monday" };
  const r1 = stampLatestUserTurn([user], { now: THU }).messages;
  const tc = { role: "assistant", content: null, tool_calls: "[]" };
  const tool = { role: "tool", content: "added", tool_call_id: "t1" };
  const r2 = stampLatestUserTurn([user, tc, tool], { now: THU }).messages;
  assert.equal(r2[0].content, r1[0].content);
  assert.deepEqual(r2.slice(1), [tc, tool]);
});

test("the slash command is stripped, and the [Dates] trigger reads the stripped words, never the stamp", () => {
  const { messages, datesLine } = stampLatestUserTurn([{ role: "user", content: "/code fix the parser" }], { now: THU, stripSlash: true });
  assert.equal(messages[0].content, `fix the parser\n\n${stampOf(THU)}`);
  assert.equal(datesLine, null, "the stamp names a weekday; it must not trigger [Dates]");
});

test("a non-string latest user message is left alone", () => {
  const m = { role: "user", content: null };
  const { messages, datesLine } = stampLatestUserTurn([m], { now: THU });
  assert.equal(messages[0], m);
  assert.equal(datesLine, null);
});

test("chatEchoGate: no [Dates] line → text passes as is; with one → an echo is removed", () => {
  const plain = chatEchoGate(null);
  assert.equal(plain.feed(DATES + " ok") + plain.flush(), DATES + " ok");
  const g = chatEchoGate(DATES);
  assert.equal(g.feed(DATES.slice(0, 30)) + g.feed(DATES.slice(30) + "\nSure, Monday.") + g.flush(), "Sure, Monday.");
});
