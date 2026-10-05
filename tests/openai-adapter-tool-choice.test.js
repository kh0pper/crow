/**
 * tool_choice pass-through in the OpenAI-compatible chat adapter (the one both local
 * voice backends go through). The response shapes below are what the two servers in
 * use were observed to send for a forced call: a vLLM server answers a NAMED choice
 * with tool_call deltas and finish_reason "stop", and "required" with finish_reason
 * "tool_calls"; a llama.cpp server accepts a named choice and ignores it (plain text).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import createOpenAIAdapter from "../servers/gateway/ai/adapters/openai.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
const TOOLS = [{ name: "crow_wm", description: "show", inputSchema: { type: "object", properties: { command: { type: "string" } } } }, { name: "crow_projects", description: "notes", inputSchema: { type: "object" } }];
const MSGS = [{ role: "user", content: "show me a list" }];
async function run(options, respond, tools = TOOLS) {
  const sent = [];
  globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); sent.push(body); return respond(body); };
  const adapter = createOpenAIAdapter({ baseUrl: "http://127.0.0.1:9/v1", model: "m" });
  const events = [];
  for await (const ev of adapter.chatStream(MSGS, tools, options)) events.push(ev);
  return { body: sent[0], events };
}
const callChunks = (finish) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "crow_wm", arguments: "" } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"command\": \"display Fruits | apples\"}" } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
];

test("no toolChoice option → no tool_choice field (every existing caller is unchanged)", async () => {
  const { body } = await run({}, () => sse([{ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }]));
  assert.equal("tool_choice" in body, false);
  assert.equal(body.tools.length, 2);
});

test("toolChoice { name } → the OpenAI named-function form; a forced call that ends with finish_reason 'stop' is still emitted", async () => {
  const { body, events } = await run({ toolChoice: { name: "crow_wm" } }, () => sse(callChunks("stop")));
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "crow_wm" } });
  assert.deepEqual(events.filter((e) => e.type === "tool_call"), [{ type: "tool_call", id: "c1", name: "crow_wm", arguments: { command: "display Fruits | apples" } }]);
});

test("toolChoice 'required' / 'auto' / 'none' pass through as strings; finish_reason 'tool_calls' emits the call", async () => {
  const { body, events } = await run({ toolChoice: "required" }, () => sse(callChunks("tool_calls")));
  assert.equal(body.tool_choice, "required");
  assert.equal(events.filter((e) => e.type === "tool_call").length, 1);
  for (const c of ["auto", "none"]) assert.equal((await run({ toolChoice: c }, () => sse(callChunks("stop")))).body.tool_choice, c);
});

test("toolChoice is never sent without tools, and an unknown value is dropped", async () => {
  const none = await run({ toolChoice: { name: "crow_wm" } }, () => sse([{ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }]), []);
  assert.equal("tool_choice" in none.body, false);
  assert.equal("tools" in none.body, false);
  for (const bad of ["always", 7, { tool: "x" }, { name: "" }, null]) {
    const r = await run({ toolChoice: bad }, () => sse(callChunks("stop")));
    assert.equal("tool_choice" in r.body, false, JSON.stringify(bad));
  }
});

test("a backend that ignores the choice just answers in text (the caller's backstop decides what happens next)", async () => {
  const { events } = await run({ toolChoice: { name: "crow_wm" } }, () => sse([{ choices: [{ index: 0, delta: { content: "I've displayed it." } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]));
  assert.deepEqual(events.filter((e) => e.type !== "done"), [{ type: "content_delta", text: "I've displayed it." }]);
});

test("a rejected request carries the HTTP status, so a caller can tell 'this backend refuses tool_choice' from other failures", async () => {
  const bad = () => new Response(JSON.stringify({ error: { message: "tool_choice is not supported" } }), { status: 400 });
  await assert.rejects(run({ toolChoice: { name: "crow_wm" } }, bad), (err) => err.code === "provider_error" && err.status === 400 && /400/.test(err.message));
  await assert.rejects(run({}, () => new Response("x", { status: 503 })), (err) => err.code === "provider_error" && err.status === 503);
  await assert.rejects(run({}, () => new Response("x", { status: 429 })), (err) => err.code === "rate_limit" && err.status === 429);
});
