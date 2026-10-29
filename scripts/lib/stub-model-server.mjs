/**
 * Loopback OpenAI-compatible stub model server for driver tests.
 *
 * Replies come from a script (one entry per POST /v1/chat/completions):
 *   { text } | { toolCalls: [{ name | nameEndsWith, arguments }] } | { hang: true }
 *   | { error: { status, message } }  (an HTTP error body instead of a completion)
 * Past the end of the script the reply is "(stub: script exhausted)".
 * Streams standard chat.completion.chunk SSE when the request sets stream:true,
 * otherwise one chat.completion JSON body. No module-level state.
 */
import http from "node:http";

const MODEL = "stub-m1";
const EXHAUSTED = { text: "(stub: script exhausted)" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Resolve the reply's tool calls against the request's tool list; throws on no match.
function resolveToolCalls(calls, body) {
  const names = (body?.tools ?? []).map((t) => t?.function?.name).filter((n) => typeof n === "string");
  return calls.map((c, i) => {
    let name = c.name;
    if (name == null && c.nameEndsWith != null) {
      name = names.find((n) => n.endsWith(c.nameEndsWith));
      if (name == null) throw new Error(`no tool name in the request ends with "${c.nameEndsWith}"`);
    }
    const args = typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {});
    return { index: i, id: `call_stub_${i}`, type: "function", function: { name, arguments: args } };
  });
}

export async function startStubModel({ script = [], host = "127.0.0.1" } = {}) {
  const requests = [];
  const sockets = new Set();
  let next = 0;

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/models") {
      return sendJson(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "stub" }] });
    }
    if (req.method !== "POST" || path !== "/v1/chat/completions") {
      return sendJson(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
    }
    let body;
    try { body = JSON.parse((await readBody(req)) || "{}"); }
    catch { return sendJson(res, 400, { error: { message: "invalid JSON body" } }); }
    requests.push(body);
    const reply = script[next++] ?? EXHAUSTED;
    const stream = body?.stream === true;
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-stub-${next}`;

    if (reply.error) {
      return sendJson(res, reply.error.status ?? 400, { error: { message: String(reply.error.message ?? "stub error") } });
    }
    if (reply.hang) {
      res.writeHead(200, stream
        ? { "content-type": "text/event-stream", "cache-control": "no-cache" }
        : { "content-type": "application/json" });
      res.flushHeaders();
      return; // headers sent, then nothing; close() destroys the socket
    }

    let toolCalls = null;
    if (reply.toolCalls) {
      try { toolCalls = resolveToolCalls(reply.toolCalls, body); }
      catch (e) { return sendJson(res, 400, { error: { message: e.message } }); }
    }
    const finish = toolCalls ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

    if (!stream) {
      const message = toolCalls
        ? { role: "assistant", content: null, tool_calls: toolCalls.map(({ index, ...t }) => t) }
        : { role: "assistant", content: reply.text ?? "" };
      return sendJson(res, 200, {
        id, object: "chat.completion", created, model: MODEL,
        choices: [{ index: 0, message, finish_reason: finish }], usage,
      });
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish_reason = null, extra = {}) =>
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: MODEL,
        choices: [{ index: 0, delta, finish_reason }], ...extra,
      })}\n\n`);
    chunk({ role: "assistant", content: toolCalls ? null : "" });
    if (toolCalls) for (const tc of toolCalls) chunk({ tool_calls: [tc] });
    else if (reply.text) chunk({ content: reply.text });
    chunk({}, finish, { usage });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://${host}:${port}/v1`,
    requests,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
    },
  };
}
