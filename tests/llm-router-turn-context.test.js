// tests/llm-router-turn-context.test.js
//
// The AI Companion (Open-LLM-VTuber) sends its turns to /llm/v1 with a static system prompt and no date. The router
// puts [Now] (every turn) and [Dates] (when the user names a relative day) plus the [Note] line on the LAST user
// message — only for the companion's dedicated model id, never for a bare/unknown id, a door or a provider path —
// and strips an echo of those lines from the reply.

process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter, { COMPANION_TURN_MODEL } from "../servers/gateway/routes/llm-router.js";
import { nowContext, relativeDatesContext } from "../servers/shared/relative-dates.js";
import { TURN_CONTEXT_NOTE } from "../servers/gateway/voice/context-echo.js";
import { ReservedError } from "../servers/gateway/box-reservation.js";

const THU = Date.UTC(2026, 9, 15, 21, 57);
const NOW = nowContext(THU, null);
const DATES = relativeDatesContext(THU, null);

let up, upUrl, seen, srv, appUrl, metered, mode, reserveEsc;

before(async () => {
  up = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
      if (mode === "sse-echo") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const h = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m" };
        const f = (o) => `data: ${JSON.stringify(o)}\n\n`;
        res.write(f({ ...h, choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] }));
        res.write(f({ ...h, choices: [{ index: 0, delta: { content: `${NOW}\n` }, finish_reason: null }] }));
        res.write(f({ ...h, choices: [{ index: 0, delta: { content: "Monday is the 19th." }, finish_reason: null }] }));
        res.write(f({ ...h, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        res.write(f({ ...h, choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } }));
        res.end("data: [DONE]\n\n");
        return;
      }
      if (mode === "hang") {
        // One frame, then the upstream never ends: only the client's disconnect can end the turn.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "Thinking" }, finish_reason: null }] })}\n\n`);
        return;
      }
      if (mode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `${NOW} upstream broke` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: `${NOW}\nIt is Thursday.` }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  const providers = {
    "crow-chat": { baseUrl: upUrl, doorUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: { runtime: "native", owner: "me", port: 1 } },
  };
  const router = llmRouterRouter({
    acquireFn: async (pid) => { if (reserveEsc && pid === "crow-chat") throw new ReservedError({ owner: "win", expires_at: "2026-10-15T23:00:00Z", allow: [] }, pid); return true; },
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers }),
    remoteAddressFn: () => "127.0.0.1",
    nowFn: () => THU,
    recordUsageFn: async (ev) => { metered.push(ev); },
  });
  const app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.closeAllConnections?.(); up?.closeAllConnections?.(); srv?.close(); up?.close(); });
beforeEach(() => { seen = []; metered = []; mode = "json"; reserveEsc = false; delete process.env.COMPANION_TURN_CONTEXT; });

const post = (body, path = "/llm/v1/chat/completions") => fetch(`${appUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const SYSTEM = { role: "system", content: "You are the companion." };
const lastUser = (msgs) => msgs.findLast((m) => m.role === "user");

test("the companion's model id is a dedicated one", () => {
  assert.equal(COMPANION_TURN_MODEL, "crow-companion");
});

test("a day named (array content) → [Now], [Dates], [Note] then the user's words; system and history untouched", async () => {
  const history = [SYSTEM, { role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", content: "Hi!" }];
  const msgs = [...history, { role: "user", content: [{ type: "text", text: "add a dentist appointment Monday" }] }];
  const r = await post({ model: "crow-companion", messages: msgs, stream: false });
  assert.equal(r.status, 200);
  const sent = seen[0].body.messages;
  assert.deepEqual(sent.slice(0, 3), history);
  assert.equal(sent[3].content[0].text, `${NOW}\n${DATES}\n${TURN_CONTEXT_NOTE}\n\nadd a dentist appointment Monday`);
});

test("no day named (string content) → [Now] only", async () => {
  await post({ model: "crow-companion", messages: [SYSTEM, { role: "user", content: "how are you" }] });
  assert.equal(seen[0].body.messages[1].content, `${NOW}\n${TURN_CONTEXT_NOTE}\n\nhow are you`);
});

test("an image-only user message gets a new leading text part", async () => {
  await post({ model: "crow-companion", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] });
  const c = seen[0].body.messages[0].content;
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { type: "text", text: `${NOW}\n${TURN_CONTEXT_NOTE}\n\n` });
  assert.equal(c[1].type, "image_url");
});

test("!escalate is still stripped and still escalates; the route decision reads the user's words", async () => {
  await post({ model: "crow-companion", messages: [{ role: "user", content: "!escalate plan Friday" }] });
  assert.equal(seen[0].body.model, "qwen3.6-35b-a3b");
  assert.equal(seen[0].body.messages[0].content, `${NOW}\n${DATES}\n${TURN_CONTEXT_NOTE}\n\nplan Friday`);
});

test("a tool-loop round puts the context on the user message, never on the tool result", async () => {
  const msgs = [SYSTEM, { role: "user", content: "add it Monday" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "cal_add", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "added" }];
  await post({ model: "crow-companion", messages: msgs, tools: [{ type: "function", function: { name: "cal_add", parameters: {} } }] });
  const sent = seen[0].body.messages;
  assert.equal(sent[1].content, `${NOW}\n${DATES}\n${TURN_CONTEXT_NOTE}\n\nadd it Monday`);
  assert.deepEqual(sent.slice(2), msgs.slice(2));
});

test("the degrade path's system note comes after the user message; the user message still carries the context", async () => {
  reserveEsc = true;
  await post({ model: "crow-companion", messages: [{ role: "user", content: "!escalate what about Monday" }] });
  const sent = seen[0].body.messages;
  assert.equal(sent.at(-1).role, "system");
  assert.equal(lastUser(sent).content, `${NOW}\n${DATES}\n${TURN_CONTEXT_NOTE}\n\nwhat about Monday`);
});

test("idempotent: a message already carrying [Now]/[Dates] or a 'Current date and time:' stamp is left alone", async () => {
  for (const content of [`${NOW}\n${TURN_CONTEXT_NOTE}\n\nhi`, `${DATES}\n\nmonday?`, "monday?\n\n[Current date and time: Thursday, October 15, 2026, 4:57 PM CDT]"]) {
    seen = [];
    await post({ model: "crow-companion", messages: [{ role: "user", content }] });
    assert.equal(seen[0].body.messages[0].content, content);
  }
});

test("COMPANION_TURN_CONTEXT=0 (read per request) → the body is forwarded unchanged", async () => {
  process.env.COMPANION_TURN_CONTEXT = "0";
  await post({ model: "crow-companion", messages: [{ role: "user", content: "monday?" }] });
  assert.equal(seen[0].body.messages[0].content, "monday?");
});

test("only the dedicated id: no model, a bare companion id or an unknown id is never touched", async () => {
  for (const model of [undefined, "qwen3.5-4b", "something-else"]) {
    seen = [];
    await post({ ...(model ? { model } : {}), messages: [{ role: "user", content: "monday?" }] });
    assert.equal(seen[0].body.messages[0].content, "monday?", String(model));
  }
});

test("a provider-door request is never touched", async () => {
  await post({ model: "qwen3.6-35b-a3b", messages: [{ role: "user", content: "monday?" }] }, "/llm/p/crow-chat/v1/chat/completions");
  assert.equal(seen[0].body.messages[0].content, "monday?");
});

test("SSE: an echoed context line is stripped before the client sees it; usage is still metered", async () => {
  mode = "sse-echo";
  const r = await post({ model: "crow-companion", messages: [{ role: "user", content: "monday?" }], stream: true });
  const text = await r.text();
  assert.ok(!text.includes("[Now]"), text);
  assert.match(text, /Monday is the 19th\./);
  assert.match(text, /data: \[DONE\]/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(metered.length, 1);
  assert.equal(metered[0].inputTokens, 50);
  assert.equal(metered[0].outputTokens, 7);
});

test("non-stream JSON: the echo is stripped from message.content", async () => {
  const r = await post({ model: "crow-companion", messages: [{ role: "user", content: "what day is it" }], stream: false });
  const body = await r.json();
  assert.equal(body.choices[0].message.content, "It is Thursday.");
});

test("an upstream error body passes through untouched", async () => {
  mode = "error";
  const r = await post({ model: "crow-companion", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error.message, `${NOW} upstream broke`);
});

test("a client disconnect mid-stream settles the turn (filtered and plain paths alike)", async () => {
  mode = "hang";
  for (const model of ["crow-companion", "crow-voice/qwen3.5-4b"]) {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(" ")); };
    try {
      const ac = new AbortController();
      const r = await fetch(`${appUrl}/llm/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "monday?" }], stream: true }), signal: ac.signal });
      const reader = r.body.getReader();
      await reader.read();
      ac.abort();
      for (let i = 0; i < 50 && !logs.some((l) => /\[llm-router\] done /.test(l)); i++) await new Promise((res) => setTimeout(res, 20));
    } finally { console.log = orig; }
    assert.ok(logs.some((l) => /\[llm-router\] done /.test(l)), `${model}: the handler never finished after the client left: ${logs.join(" | ")}`);
  }
});
