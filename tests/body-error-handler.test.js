/**
 * The gateway's last error handler (credential card Task 1, fix round 1): body-parser refusals
 * answer a fixed { error: "bad_body" } and one fixed line; every other error passes on unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bodyErrorHandler, isBodyParserError } from "../servers/gateway/body-error-handler.js";

function run(err, { headersSent = false } = {}) {
  const res = { headersSent, statusCode: null, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
  const passed = [];
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  try { bodyErrorHandler(err, {}, res, (e) => passed.push(e)); } finally { console.warn = orig; }
  return { res, passed, lines };
}

test("parse, size, encoding and charset refusals answer bad_body with the parser's status and one fixed line", () => {
  const secret = "Unexpected token 'h', \"hunter2sec\"... is not valid JSON";
  for (const [type, status] of [["entity.parse.failed", 400], ["entity.too.large", 413], ["encoding.unsupported", 415], ["charset.unsupported", 415]]) {
    const err = Object.assign(new SyntaxError(secret), { type, status, body: "hunter2secret" });
    const { res, passed, lines } = run(err);
    assert.equal(res.statusCode, status, type);
    assert.deepEqual(res.body, { error: "bad_body" });
    assert.deepEqual(lines, ["[gateway] bad body"]);
    assert.equal(passed.length, 0);
  }
  assert.equal(isBodyParserError(Object.assign(new Error("x"), { status: 400, body: "" })), true, "a 400 carrying a body");
});

test("every other error passes to next(err) unchanged, and nothing is answered", () => {
  for (const err of [new Error("boom"), Object.assign(new Error("nope"), { status: 400 }), Object.assign(new Error("gone"), { status: 404, body: "x" }), Object.assign(new Error("t"), { type: "other.thing" })]) {
    const { res, passed, lines } = run(err);
    assert.equal(passed[0], err);
    assert.equal(res.statusCode, null);
    assert.deepEqual(lines, []);
  }
  const parse = Object.assign(new SyntaxError("x"), { type: "entity.parse.failed", status: 400 });
  assert.equal(run(parse, { headersSent: true }).passed[0], parse, "headers already sent: pass on");
});

test("index.js registers it after every router, just before listen", () => {
  const src = readFileSync(new URL("../servers/gateway/index.js", import.meta.url), "utf8");
  const reg = src.indexOf("app.use(bodyErrorHandler)");
  assert.ok(reg > 0, "registered");
  assert.ok(reg > src.lastIndexOf("await mountLateRoutes("), "after the late mounts");
  assert.ok(reg < src.indexOf("app.listen("), "before listen");
  const after = src.slice(reg + 1);
  assert.equal(/\bapp\.(use|get|post|put|patch|delete|all)\(/.test(after), false, "no route or middleware is registered after it");
});
