/**
 * The local setup wizard (scripts/wizard-web.js) writes credentials to .env
 * and runs the config generators. It must answer only this machine, only the
 * terminal-printed session link, and only well-formed saves of its own keys.
 *
 * Runs the real script against a scratch .env with the generators and the
 * browser auto-open switched off.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import http from "node:http";
import net from "node:net";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "wizard-web.js");
const SECRET = "ntn_supersecretvalue_9f8e7d6c5b4a";
const ORIGINAL_ENV = [
  "# my own comment",
  "CROW_DB_PATH=./data/crow.db",
  `NOTION_TOKEN=${SECRET}`,
  "SOME_OTHER_SETTING=keep me",
  'CROW_GATEWAY_URL=https://x"><script>alert(1)</script>',
  "",
].join("\n");

let dir;
let envPath;
let child;
let port;
let token;
let boundAddress;

function request({ method = "GET", path = "/", headers = {}, body, host }) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function save(payload, extraHeaders = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return request({
    method: "POST",
    path: "/save",
    headers: {
      "Content-Type": "application/json",
      "X-Crow-Wizard-Token": token,
      "Content-Length": Buffer.byteLength(body),
      ...extraHeaders,
    },
    body,
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "crow-wizard-sec-"));
  envPath = join(dir, ".env");
  writeFileSync(envPath, ORIGINAL_ENV);
  child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      WIZARD_PORT: "0",
      CROW_WIZARD_ENV_PATH: envPath,
      CROW_WIZARD_SKIP_CONFIG: "1",
      CROW_WIZARD_NO_OPEN: "1",
    },
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolvePromise, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`wizard did not start: ${out}`)), 10000);
    child.stdout.on("data", (c) => {
      out += c;
      const m = out.match(/http:\/\/([\d.]+):(\d+)\/\?t=([A-Za-z0-9_-]+)/);
      if (m) {
        clearTimeout(timer);
        boundAddress = m[1];
        port = Number(m[2]);
        token = m[3];
        resolvePromise();
      }
    });
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => reject(new Error(`wizard exited ${code}: ${out}`)));
  });
});

after(() => {
  child?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("binds loopback only", async () => {
  assert.equal(boundAddress, "127.0.0.1");
  assert.ok(token.length >= 32, "token is a 24-byte base64url value");
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (!external) return; // no non-loopback address on this box; the reported address is the check
  await new Promise((resolvePromise, reject) => {
    const sock = net.connect({ host: external.address, port });
    sock.setTimeout(3000);
    sock.on("connect", () => { sock.destroy(); reject(new Error("wizard reachable on a non-loopback address")); });
    sock.on("error", () => resolvePromise());
    sock.on("timeout", () => { sock.destroy(); resolvePromise(); });
  });
});

test("GET without the token shows only the open-the-link page", async () => {
  for (const path of ["/", "/?t=wrong", `/?t=${token.slice(0, -1)}`]) {
    const res = await request({ path });
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes(SECRET));
    assert.ok(!res.body.includes("<form"));
    assert.ok(!res.body.includes(token));
    assert.match(res.body, /link printed in your terminal/);
  }
});

test("GET with the token never carries a saved secret", async () => {
  const res = await request({ path: `/?t=${token}` });
  assert.equal(res.status, 200);
  assert.ok(res.body.includes("<form"));
  assert.ok(!res.body.includes(SECRET));
  assert.ok(!res.body.includes(SECRET.slice(0, 6)), "no masked prefix either");
  assert.ok(!res.body.includes(SECRET.slice(-4)), "no masked suffix either");
  assert.match(res.body, /id="state-NOTION_TOKEN">Set</);
  assert.match(res.body, /id="state-SLACK_BOT_TOKEN">Not set</);
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.ok(!/<script[^>]+src=/i.test(res.body), "no external scripts");
  assert.ok(!res.body.includes("<script>alert(1)"), "a saved non-secret value is escaped");
  assert.ok(res.body.includes("&quot;&gt;&lt;script&gt;"), "and still shown");
});

test("a bad Host is refused (DNS rebinding)", async () => {
  for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, `10.0.0.5:${port}`]) {
    const get = await request({ path: `/?t=${token}`, host });
    assert.equal(get.status, 421, host);
    assert.ok(!get.body.includes("<form"));
  }
  const body = JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-host" });
  const post = await request({
    method: "POST", path: "/save", host: "evil.example",
    headers: { "Content-Type": "application/json", "X-Crow-Wizard-Token": token, "Content-Length": Buffer.byteLength(body) },
    body,
  });
  assert.equal(post.status, 421);
  assert.ok(!readFileSync(envPath, "utf8").includes("xoxb-host"));
});

test("POST without the token header is refused", async () => {
  const body = JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-notoken" });
  const res = await request({
    method: "POST", path: "/save",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    body,
  });
  assert.equal(res.status, 403);
  const wrong = await save({ SLACK_BOT_TOKEN: "xoxb-notoken" }, { "X-Crow-Wizard-Token": "x".repeat(token.length) });
  assert.equal(wrong.status, 403);
  assert.ok(!readFileSync(envPath, "utf8").includes("xoxb-notoken"));
});

test("a text/plain body is refused", async () => {
  const res = await save({ SLACK_BOT_TOKEN: "xoxb-plain" }, { "Content-Type": "text/plain" });
  assert.equal(res.status, 415);
  assert.ok(!readFileSync(envPath, "utf8").includes("xoxb-plain"));
});

test("a foreign Origin is refused", async () => {
  for (const origin of ["http://evil.example", `http://127.0.0.1:${port + 1}`, "null"]) {
    const res = await save({ SLACK_BOT_TOKEN: "xoxb-origin" }, { Origin: origin });
    assert.equal(res.status, 403, origin);
  }
  assert.ok(!readFileSync(envPath, "utf8").includes("xoxb-origin"));
});

test("an unknown key is refused, and nothing is written", async () => {
  const before = readFileSync(envPath, "utf8");
  for (const payload of [
    { NODE_OPTIONS: "--require /tmp/x.js" },
    { SLACK_BOT_TOKEN: "xoxb-ok", NODE_OPTIONS: "--require /tmp/x.js" },
    { "SLACK_BOT_TOKEN\nNODE_OPTIONS": "x" },
    '{"__proto__":{"SLACK_BOT_TOKEN":"x"}}',
    '["SLACK_BOT_TOKEN"]',
  ]) {
    const res = await save(payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
  }
  assert.equal(readFileSync(envPath, "utf8"), before);
});

test("a newline, NUL or oversized value is refused", async () => {
  const before = readFileSync(envPath, "utf8");
  for (const val of ["xoxb-a\nNODE_OPTIONS=--require /tmp/x.js", "xoxb-a\rB=1", "xoxb-a\0", "xoxb-a\x1b[2J", "xoxb-a\u2028b", "xoxb-a\x01", "a".repeat(4097), 42]) {
    const res = await save({ SLACK_BOT_TOKEN: val });
    assert.equal(res.status, 400);
  }
  assert.equal(readFileSync(envPath, "utf8"), before);
});

test("an oversized body is refused", async () => {
  const big = JSON.stringify({ SLACK_BOT_TOKEN: "x".repeat(70 * 1024) });
  const res = await save(big);
  assert.equal(res.status, 413);
});

test("a good save writes only that key, keeps other lines, and empty keeps the old value", async () => {
  const res = await save({ SLACK_BOT_TOKEN: "xoxb-good-123", NOTION_TOKEN: "", BRAVE_API_KEY: "   " }, {
    Origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(res.status, 200, res.body);
  const json = JSON.parse(res.body);
  assert.equal(json.ok, true);
  assert.deepEqual(json.saved, ["SLACK_BOT_TOKEN"]);
  assert.equal(readFileSync(envPath, "utf8"), ORIGINAL_ENV + "SLACK_BOT_TOKEN=xoxb-good-123\n");
  assert.equal(statSync(envPath).mode & 0o777, 0o600, ".env is owner-only after a save");

  // Replacing an existing key changes that line in place.
  const res2 = await save({ NOTION_TOKEN: "ntn_new" }, { Origin: `http://localhost:${port}` });
  assert.equal(res2.status, 200, res2.body);
  assert.equal(
    readFileSync(envPath, "utf8"),
    ORIGINAL_ENV.replace(`NOTION_TOKEN=${SECRET}`, "NOTION_TOKEN=ntn_new") + "SLACK_BOT_TOKEN=xoxb-good-123\n",
  );

  // The page still never carries the new values.
  const page = await request({ path: `/?t=${token}` });
  assert.ok(!page.body.includes("xoxb-good-123"));
  assert.ok(!page.body.includes("ntn_new"));
  assert.match(page.body, /id="state-SLACK_BOT_TOKEN">Set</);
});
