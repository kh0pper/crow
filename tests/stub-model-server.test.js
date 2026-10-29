import { test } from "node:test";
import assert from "node:assert/strict";
import { startStubModel } from "../scripts/lib/stub-model-server.mjs";

async function post(baseUrl, body) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseSse(text) {
  return text.split("\n\n").filter(Boolean).map((b) => {
    assert.ok(b.startsWith("data: "), `bad frame: ${b}`);
    const d = b.slice(6);
    return d === "[DONE]" ? "[DONE]" : JSON.parse(d);
  });
}

test("streams a text reply as SSE", async () => {
  const s = await startStubModel({ script: [{ text: "hello there" }] });
  try {
    const r = await post(s.baseUrl, { model: "stub-m1", stream: true, messages: [] });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    const frames = parseSse(await r.text());
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames.slice(0, -1);
    for (const c of chunks) {
      assert.equal(c.object, "chat.completion.chunk");
      assert.ok(c.id && c.model);
    }
    const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    assert.equal(content, "hello there");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  } finally { await s.close(); }
});

test("streams a tool call", async () => {
  const s = await startStubModel({ script: [{ toolCalls: [{ name: "do_it", arguments: { a: 1 } }] }] });
  try {
    const r = await post(s.baseUrl, { stream: true, messages: [] });
    const chunks = parseSse(await r.text()).slice(0, -1);
    const tcs = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    assert.equal(tcs.length, 1);
    assert.equal(tcs[0].index, 0);
    assert.ok(tcs[0].id);
    assert.equal(tcs[0].type, "function");
    assert.equal(tcs[0].function.name, "do_it");
    assert.deepEqual(JSON.parse(tcs[0].function.arguments), { a: 1 });
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  } finally { await s.close(); }
});

test("nameEndsWith picks the tool from the request", async () => {
  const s = await startStubModel({ script: [{ toolCalls: [{ nameEndsWith: "crow_list_projects", arguments: {} }] }] });
  try {
    const r = await post(s.baseUrl, {
      stream: true,
      tools: [{ type: "function", function: { name: "other" } }, { type: "function", function: { name: "mcp__x__crow_list_projects" } }],
    });
    const chunks = parseSse(await r.text()).slice(0, -1);
    const tc = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? [])[0];
    assert.equal(tc.function.name, "mcp__x__crow_list_projects");
  } finally { await s.close(); }
});

test("nameEndsWith with no match is a loud 400", async () => {
  const s = await startStubModel({ script: [{ toolCalls: [{ nameEndsWith: "nope", arguments: {} }] }] });
  try {
    const r = await post(s.baseUrl, { stream: true, tools: [{ function: { name: "a" } }] });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /nope/);
  } finally { await s.close(); }
});

test("non-stream request gets one JSON body", async () => {
  const s = await startStubModel({ script: [{ text: "plain" }] });
  try {
    const r = await post(s.baseUrl, { messages: [] });
    const j = await r.json();
    assert.equal(j.object, "chat.completion");
    assert.equal(j.choices[0].message.content, "plain");
    assert.equal(j.choices[0].finish_reason, "stop");
  } finally { await s.close(); }
});

test("records each request body in order; exhausted script falls back", async () => {
  const s = await startStubModel({ script: [{ text: "one" }] });
  try {
    await (await post(s.baseUrl, { n: 1 })).text();
    const r2 = await post(s.baseUrl, { n: 2 });
    assert.equal((await r2.json()).choices[0].message.content, "(stub: script exhausted)");
    assert.deepEqual(s.requests.map((b) => b.n), [1, 2]);
  } finally { await s.close(); }
});

test("GET /models lists stub-m1", async () => {
  const s = await startStubModel({ script: [] });
  try {
    const j = await (await fetch(`${s.baseUrl}/models`)).json();
    assert.equal(j.data[0].id, "stub-m1");
  } finally { await s.close(); }
});

test("hang sends headers and no data", async () => {
  const s = await startStubModel({ script: [{ hang: true }] });
  try {
    const r = await post(s.baseUrl, { stream: true });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const got = await Promise.race([
      reader.read().then(() => "chunk"),
      new Promise((res) => setTimeout(() => res("quiet"), 500)),
    ]);
    assert.equal(got, "quiet");
  } finally { await s.close(); }
});

test("binds loopback only; two servers coexist", async () => {
  const a = await startStubModel({ script: [] });
  const b = await startStubModel({ script: [] });
  try {
    assert.equal(new URL(a.baseUrl).hostname, "127.0.0.1");
    assert.ok(a.baseUrl.endsWith("/v1"));
    assert.notEqual(a.baseUrl, b.baseUrl);
  } finally { await a.close(); await b.close(); }
});

test("an error reply is an HTTP error body, and the script moves on", async () => {
  const s = await startStubModel({ script: [{ error: { status: 400, message: "bad turn" } }, { text: "next" }] });
  try {
    const r = await post(s.baseUrl, { model: "stub-m1", stream: true, messages: [] });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: { message: "bad turn" } });
    const r2 = await post(s.baseUrl, { model: "stub-m1", stream: false, messages: [] });
    assert.equal((await r2.json()).choices[0].message.content, "next");
  } finally { await s.close(); }
});
