/**
 * servers/gateway/voice/sse-echo.js — the companion's echo guard on the router's HTTP path. A small model sometimes
 * reads the injected [Now]/[Dates]/[Note] lines back as the start of its answer; the filter rewrites only the
 * string `choices[0].delta.content` of an OpenAI-style SSE stream and passes every other byte through unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseEchoFilter, stripJsonEcho } from "../servers/gateway/voice/sse-echo.js";
import { TURN_CONTEXT_NOTE } from "../servers/gateway/voice/context-echo.js";

const NOW = "[Now] Thursday, October 15, 2026, 4:57 PM (time zone America/Chicago)";
const DATES = "[Dates] To add or plan something, a day named without a date is the next one: Friday 2026-10-16 (tomorrow), Saturday 2026-10-17; Thursday is today 2026-10-15 or next week 2026-10-22. For something already past, it is the previous one. UTC offset -05:00.";
const CTX = `${NOW}\n${DATES}`;

const head = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1760000000, model: "crow-companion" };
const frame = (obj, nl = "\n") => `data: ${JSON.stringify(obj)}${nl}${nl}`;
const delta = (content, extra = {}) => frame({ ...head, choices: [{ index: 0, delta: { content }, finish_reason: null, ...extra }] });
const ROLE = frame({ ...head, choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] });
const TOOL = frame({ ...head, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "cal_add", arguments: "{\"day\":\"[Dates] x\"}" } }] }, finish_reason: null }] });
const FINISH = frame({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const USAGE = frame({ ...head, choices: [], usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 } });
const DONE = "data: [DONE]\n\n";

/** Run a whole stream through a fresh filter, split into pieces. */
function run(stream, { pieces = [stream], contexts = [CTX] } = {}) {
  const f = createSseEchoFilter(contexts);
  let out = "";
  for (const p of pieces) out += f.write(p);
  return out + f.end();
}
/** The text the client sees: every delta.content joined. */
function contentOf(out) {
  let s = "";
  for (const ev of out.split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    try { const c = JSON.parse(data).choices?.[0]?.delta?.content; if (typeof c === "string") s += c; } catch { /* malformed */ }
  }
  return s;
}

test("an echoed [Now]/[Dates]/[Note] prefix is removed from the streamed content", () => {
  const stream = ROLE + delta(NOW + "\n") + delta(DATES.slice(0, 40)) + delta(DATES.slice(40) + "\n" + TURN_CONTEXT_NOTE + "\n\n") + delta("Sure, Monday is the 19th.") + FINISH + USAGE + DONE;
  assert.equal(contentOf(run(stream)), "Sure, Monday is the 19th.");
});

test("an ordinary bracket ([1, 2]) is kept", () => {
  assert.equal(contentOf(run(ROLE + delta("The list is [1, 2].") + FINISH + DONE)), "The list is [1, 2].");
});

test("a stream with no echo comes out byte for byte", () => {
  const stream = ROLE + delta("Hello") + delta(" there.") + TOOL + FINISH + USAGE + DONE;
  assert.equal(run(stream), stream);
});

test("role / tool_call / finish / usage / [DONE] frames are byte-identical (tool args are not rewritten)", () => {
  const out = run(ROLE + delta(NOW + "\nOk.") + TOOL + FINISH + USAGE + DONE);
  for (const f of [ROLE, TOOL, FINISH, USAGE, DONE]) assert.ok(out.includes(f), f);
});

test("text held at the end of the content is flushed as a full chunk BEFORE the finish_reason frame", () => {
  const out = run(ROLE + delta("See you [No") + FINISH + DONE);
  assert.equal(contentOf(out), "See you [No");
  const flushAt = out.indexOf('"content":"[No"');
  assert.ok(flushAt > 0 && flushAt < out.indexOf('"finish_reason":"stop"'));
  const flushFrame = out.split("\n\n").map((e) => e.slice(6)).find((d) => d.includes('"[No"'));
  const obj = JSON.parse(flushFrame);
  assert.equal(obj.id, head.id); assert.equal(obj.object, head.object); assert.equal(obj.created, head.created); assert.equal(obj.model, head.model);
  assert.equal(obj.choices[0].index, 0);
});

test("held text is flushed before [DONE] when no finish_reason frame comes", () => {
  const out = run(ROLE + delta("x [Da") + DONE);
  assert.equal(contentOf(out), "x [Da");
  assert.ok(out.endsWith(DONE));
});

test("held text is flushed at stream end with neither finish_reason nor [DONE]", () => {
  assert.equal(contentOf(run(ROLE + delta("x [Da"))), "x [Da");
});

test("split at every byte boundary (Buffers, multi-byte UTF-8 too) gives the same content and the same pass-through frames", () => {
  const stream = ROLE + delta(NOW + "\n") + delta("Mañana — el lunes 19.") + TOOL + FINISH + USAGE + DONE;
  const whole = run(stream);
  const bytes = Buffer.from(stream);
  for (let i = 1; i < bytes.length; i += 1) {
    const out = run(null, { pieces: [bytes.subarray(0, i), bytes.subarray(i)] });
    assert.equal(out, whole, `split at ${i}`);
  }
  assert.equal(contentOf(whole), "Mañana — el lunes 19.");
});

test("\\r\\n line endings are handled", () => {
  const stream = frame({ ...head, choices: [{ index: 0, delta: { content: NOW + "\n" }, finish_reason: null }] }, "\r\n") + frame({ ...head, choices: [{ index: 0, delta: { content: "Hi." }, finish_reason: null }] }, "\r\n") + "data: [DONE]\r\n\r\n";
  const out = run(stream);
  assert.equal(contentOf(out), "Hi.");
  assert.ok(out.endsWith("data: [DONE]\r\n\r\n"));
});

test("a multi-line data: frame is read as one payload", () => {
  const json = JSON.stringify({ ...head, choices: [{ index: 0, delta: { content: NOW + "\nOk." }, finish_reason: null }] }, null, 1);
  const multi = json.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
  assert.equal(contentOf(run(multi + DONE)), "Ok.");
});

test("a malformed JSON frame and an SSE comment pass through untouched", () => {
  const bad = "data: {not json\n\n";
  const comment = ": keep-alive\n\n";
  const out = run(comment + bad + delta("Fine.") + DONE);
  assert.ok(out.startsWith(comment + bad));
  assert.equal(contentOf(out), "Fine.");
});

test("stripJsonEcho: a non-stream response has the echo removed from message.content; anything else is returned as is", () => {
  const body = JSON.stringify({ ...head, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: `${NOW}\nIt's Monday the 19th.` }, finish_reason: "stop" }], usage: { total_tokens: 3 } });
  const out = JSON.parse(stripJsonEcho(body, [CTX]));
  assert.equal(out.choices[0].message.content, "It's Monday the 19th.");
  assert.deepEqual(out.usage, { total_tokens: 3 });
  const clean = JSON.stringify({ choices: [{ message: { content: "Hello." } }] });
  assert.equal(stripJsonEcho(clean, [CTX]), clean);
  assert.equal(stripJsonEcho("{nope", [CTX]), "{nope");
});

test("held text is flushed BEFORE a tool_calls frame, so content never arrives after the tool-call deltas", () => {
  const out = run(ROLE + delta("Let me add that [No") + TOOL + FINISH + DONE);
  assert.equal(contentOf(out), "Let me add that [No");
  const flushAt = out.indexOf('"content":"[No"');
  assert.ok(flushAt > 0 && flushAt < out.indexOf(TOOL), "the held text comes before the tool_calls frame");
  assert.ok(out.includes(TOOL));
});
