/**
 * The browser MCP server honours the shared browser lease
 * (bundles/browser/server/lease-guard.js): every crow_browser_* tool call goes
 * through the lease, so bots take turns on the one page and wait for the
 * operator without ever acting late (a call that waited never acts).
 *
 * The guard is exercised with a fake McpServer (records each registered
 * handler), stub tool actions, a temp lease dir and an injected clock whose
 * sleep advances time, so the 20 s operator wait runs instantly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as leaseMod from "../servers/shared/browser-lease.js";
import { installLeaseGuard, TEXTS } from "../bundles/browser/server/lease-guard.js";
import { waitingForUserResult } from "../bundles/browser/server/wait-for-user.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { readLease, acquire, takeOperator, handBack } = leaseMod;

const BUSY = "The browser is busy: another bot is using it. Try again in a minute.";
const HELD = "The operator has the browser; call again to continue.";
const HANDED_BACK = "The operator handed the browser back; call again.";
const GEN_CHANGED = "The browser changed hands since your last step; check the page before relying on earlier state.";
const TAKEN = "The operator took the browser during this step; check the page.";
const PERCH_ENV = { PI_BOT_PERCH_SESSION_ID: "perch-1", PI_BOT_ID: "bot-a" };
const ME = { kind: "bot", sessionId: "perch-1", botId: "bot-a" };

function tmpLeaseDir() {
  const dir = join(mkdtempSync(join(tmpdir(), "browser-mcp-lease-")), "browser-lease");
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** A fake McpServer that records each registered tool's handler. */
function fakeServer() {
  return {
    handlers: {},
    tool(name, ...rest) { this.handlers[name] = rest.at(-1); return { name }; },
  };
}

/** An injected clock: sleep advances it, then runs onSleep(elapsed). */
function fakeClock() {
  const clock = { t: Date.now(), start: null, sleeps: 0, onSleep: null };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.sleeps++;
    clock.t += ms;
    if (clock.onSleep) await clock.onSleep(clock.t - clock.start);
  };
  return clock;
}

/** Install the guard on a fake server with one stub tool `name`; returns helpers. */
function setup({ name = "crow_browser_navigate", env = PERCH_ENV, action, lease = leaseMod, dir = tmpLeaseDir(), proc, exit } = {}) {
  const clock = fakeClock();
  const server = fakeServer();
  const guard = installLeaseGuard(server, {
    lease, dir, env, pid: process.pid, now: clock.now, sleep: clock.sleep,
    getTargetId: async () => "TARGET1", proc: proc || new EventEmitter(), exit: exit || (() => {}),
  });
  const calls = [];
  server.tool(name, "stub", {}, async (args) => {
    calls.push(args);
    if (action) return action(args);
    return { content: [{ type: "text", text: "acted" }] };
  });
  const call = async (args = {}) => { clock.start = clock.t; return server.handlers[name](args, {}); };
  return { server, guard, clock, calls, call, dir };
}

const text = (r) => r.content[0].text;

test("status and guide skip the lease", async () => {
  for (const name of ["crow_browser_status", "crow_browser_guide"]) {
    const { calls, call, dir, clock } = setup({ name });
    await takeOperator(dir, { now: clock.now() });
    const before = await readLease(dir);
    const r = await call();
    assert.equal(text(r), "acted", name);
    assert.equal(calls.length, 1, name);
    assert.equal(clock.sleeps, 0, `${name} never waits`);
    assert.deepEqual(await readLease(dir), before, `${name} leaves the lease alone`);
  }
});

test("a free lease: the tool runs and inCall is cleared after", async () => {
  let during = null;
  const ctx = setup({ action: async () => { during = await readLease(ctx.dir); return { content: [{ type: "text", text: "acted" }] }; } });
  const r = await ctx.call({ url: "x" });
  assert.equal(text(r), "acted");
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(during.holder, ME);
  assert.equal(during.inCall.length, 1);
  assert.equal(during.inCall[0].pid, process.pid);
  assert.equal(during.targetId, "TARGET1");
  const after = await readLease(ctx.dir);
  assert.deepEqual(after.holder, ME, "the session keeps the lease between steps");
  assert.deepEqual(after.inCall, []);
});

test("another bot holds it: the busy text, no action", async () => {
  const { calls, call, dir, clock } = setup();
  await acquire(dir, { kind: "bot", sessionId: "perch-2", botId: "bot-b" }, { now: clock.now() });
  const r = await call();
  assert.equal(text(r), BUSY);
  assert.equal(calls.length, 0);
  assert.equal(clock.sleeps, 0, "busy returns at once");
});

test("operator holds it for 20 s: returns the held text, no action", async () => {
  const { calls, call, dir, clock } = setup();
  await takeOperator(dir, { now: clock.now() });
  const r = await call();
  assert.equal(text(r), HELD);
  assert.equal(calls.length, 0);
  assert.equal(clock.t - clock.start, 20000, "waits exactly 20 s");
  assert.equal(clock.sleeps, 40, "polls every 500 ms");
  assert.equal((await readLease(dir)).holder.kind, "operator");
});

test("a call that waited never acts", async () => {
  const { calls, call, dir, clock } = setup();
  await takeOperator(dir, { now: clock.now() });
  clock.onSleep = async (elapsed) => { if (elapsed === 5000) await handBack(dir); };
  const r = await call();
  assert.equal(text(r), HANDED_BACK);
  assert.equal(calls.length, 0, "the stub action was not called");
  assert.equal(clock.t - clock.start, 5000, "returns as soon as the operator hands back");
  // The next call acts, and says the browser changed hands.
  clock.onSleep = null;
  const r2 = await call();
  assert.equal(calls.length, 1);
  assert.equal(text(r2), GEN_CHANGED + "\n\nacted");
});

test("gen changed since this session's last call → the prefix text", async () => {
  const { calls, call, dir, clock } = setup();
  const r1 = await call();
  assert.equal(text(r1), "acted", "no prefix when nobody else had it");
  const r2 = await call();
  assert.equal(text(r2), "acted", "no prefix on a renewal");
  // Someone else had it in between (the operator took it and handed it back).
  await takeOperator(dir, { now: clock.now() });
  await handBack(dir);
  const r3 = await call();
  assert.equal(text(r3), GEN_CHANGED + "\n\nacted");
  assert.equal(calls.length, 3);
});

test("the operator takes it mid-call → the taken prefix on that call's result", async () => {
  const ctx = setup({
    action: async () => { await takeOperator(ctx.dir, { now: ctx.clock.now() }); return { content: [{ type: "text", text: "acted" }] }; },
  });
  const r = await ctx.call();
  assert.equal(text(r), TAKEN + "\n\nacted");
  assert.equal((await readLease(ctx.dir)).holder.kind, "operator", "the operator keeps it");
});

test("a result without text content gets the prefix as its own first item", async () => {
  const ctx = setup({ action: async () => ({ content: [{ type: "image", data: "AA", mimeType: "image/png" }] }) });
  assert.equal((await ctx.call()).content[0].type, "image", "no prefix on the first call");
  await takeOperator(ctx.dir, { now: ctx.clock.now() });
  await handBack(ctx.dir);
  const r = await ctx.call();
  assert.deepEqual(r.content[0], { type: "text", text: GEN_CHANGED });
  assert.equal(r.content[1].type, "image");
});

test("launch holds the lease", async () => {
  let during = null;
  const ctx = setup({ name: "crow_browser_launch", action: async () => { during = await readLease(ctx.dir); return { content: [{ type: "text", text: "acted" }] }; } });
  await acquire(ctx.dir, { kind: "bot", sessionId: "perch-2", botId: "bot-b" }, { now: ctx.clock.now() });
  assert.equal(text(await ctx.call()), BUSY, "launch is refused while another bot holds it");
  assert.equal(ctx.calls.length, 0);
  await leaseMod.release(ctx.dir, "perch-2", { now: ctx.clock.now() });
  assert.equal(text(await ctx.call()), GEN_CHANGED + "\n\nacted", "another bot had it before: the prefix");
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(during.holder, ME);
  assert.equal(during.inCall.length, 1);
});

test("wait_for_user names the take-over sheet", () => {
  const r = waitingForUserResult("Solve the CAPTCHA");
  const t = text(r);
  assert.ok(t.includes("Take over in the chat"), t);
  assert.ok(t.includes("Solve the CAPTCHA"), t);
  assert.ok(!/localhost:6080|localhost:|vnc/i.test(t), t);
  // server.js uses it, and wraps every tool: the guard is installed before the first registration.
  const src = readFileSync(join(ROOT, "bundles/browser/server/server.js"), "utf8");
  assert.ok(src.includes("waitingForUserResult(message)"), "wait_for_user returns waitingForUserResult");
  const install = src.indexOf("installLeaseGuard(server");
  assert.ok(install > 0 && install < src.indexOf("server.tool("), "installLeaseGuard runs before the first server.tool(");
});

test("an external client releases on exit", async () => {
  for (const signal of ["SIGTERM", "SIGINT", "beforeExit"]) {
    const proc = new EventEmitter();
    const exits = [];
    const ctx = setup({ env: {}, proc, exit: (code) => exits.push(code) });
    assert.deepEqual(ctx.guard.holder, { kind: "bot", sessionId: "external:" + process.pid, botId: null });
    assert.equal(text(await ctx.call()), "acted");
    assert.equal((await readLease(ctx.dir)).holder.sessionId, "external:" + process.pid);
    proc.emit(signal);
    await ctx.guard.exiting;
    assert.equal((await readLease(ctx.dir)).holder, null, `${signal} releases the lease`);
    if (signal === "beforeExit") assert.deepEqual(exits, [], "beforeExit lets the process end on its own");
    else assert.deepEqual(exits, [signal === "SIGINT" ? 130 : 143]);
  }
  // A Perch identity does not register exit handlers (the gateway releases it).
  const proc = new EventEmitter();
  setup({ proc });
  assert.equal(proc.listenerCount("SIGTERM"), 0);
});

test("identity comes from env only; a malformed session id falls back to external", () => {
  const a = setup({ env: { PI_BOT_PERCH_SESSION_ID: "perch-9", PI_BOT_ID: "b9" } });
  assert.deepEqual(a.guard.holder, { kind: "bot", sessionId: "perch-9", botId: "b9" });
  const b = setup({ env: { PI_BOT_PERCH_SESSION_ID: "../etc", PI_BOT_ID: "b9" } });
  assert.equal(b.guard.holder.sessionId, "external:" + process.pid);
});

test("no lease module (an older core): the tools run as today", async () => {
  const { calls, call } = setup({ lease: null });
  assert.equal(text(await call()), "acted");
  assert.equal(calls.length, 1);
});

test("a locked or broken lease reads as busy: no action, no hang, no crash", async () => {
  for (const code of ["ELEASELOCKED", "EACCES", undefined]) {
    const broken = { ...leaseMod, acquire: async () => { const e = new Error("x"); e.code = code; throw e; } };
    const { calls, call, clock } = setup({ lease: broken });
    assert.equal(text(await call()), BUSY, String(code));
    assert.equal(calls.length, 0);
    assert.equal(clock.sleeps, 0);
  }
  // A lease read error while waiting on the operator ends the wait without acting.
  const flaky = { ...leaseMod, readLease: async () => { throw new Error("io"); } };
  const ctx = setup({ lease: flaky });
  await takeOperator(ctx.dir, { now: ctx.clock.now() });
  const r = await ctx.call();
  assert.ok([HELD, HANDED_BACK, BUSY].includes(text(r)));
  assert.equal(ctx.calls.length, 0);
  assert.ok(ctx.clock.t - ctx.clock.start <= 20000);
});

test("the guard's texts are the exact constraint texts", () => {
  assert.deepEqual(TEXTS, { busy: BUSY, held: HELD, handedBack: HANDED_BACK, genChanged: GEN_CHANGED, taken: TAKEN });
});

test("manifest is 1.3.9 and the registry is in sync", () => {
  const mf = JSON.parse(readFileSync(join(ROOT, "bundles/browser/manifest.json"), "utf8"));
  assert.equal(mf.version, "1.3.9");
  execFileSync(process.execPath, ["scripts/build-registry.mjs", "--check"], { cwd: ROOT, stdio: "pipe" });
});

test("the real server: page tools go through the lease, guide skips it, wait_for_user names the sheet", async () => {
  const home = mkdtempSync(join(tmpdir(), "browser-mcp-lease-home-"));
  const saved = { CROW_HOME: process.env.CROW_HOME, sid: process.env.PI_BOT_PERCH_SESSION_ID, bid: process.env.PI_BOT_ID };
  process.env.CROW_HOME = home;
  process.env.PI_BOT_PERCH_SESSION_ID = "perch-real";
  process.env.PI_BOT_ID = "bot-real";
  try {
    // playwright lives in the bundle's own node_modules (absent in CI and worktrees): stub it.
    const { registerHooks } = await import("node:module");
    registerHooks({
      resolve(specifier, context, next) {
        try { return next(specifier, context); } catch (err) {
          if (specifier !== "playwright" || err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
          return { url: "crow-test-stub:playwright", shortCircuit: true };
        }
      },
      load(url, context, next) {
        if (url !== "crow-test-stub:playwright") return next(url, context);
        return { format: "module", source: "export const chromium = { connectOverCDP: async () => { throw new Error('no browser in tests'); } };", shortCircuit: true };
      },
    });
    const { createBrowserServer } = await import("../bundles/browser/server/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createBrowserServer({ sessionDir: join(home, "sessions") });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("");
    const dir = join(home, "browser-lease");
    try {
      await acquire(dir, { kind: "bot", sessionId: "perch-other", botId: "bot-b" });
      assert.equal(await call("crow_browser_export", { data: [{ a: 1 }], format: "json", filename: "rows.json" }), BUSY);
      assert.match(await call("crow_browser_guide"), /crow_browser_/, "guide runs while another bot holds it");
      await leaseMod.release(dir, "perch-other");
      const t = await call("crow_browser_wait_for_user", { message: "Solve it" });
      assert.ok(t.startsWith(GEN_CHANGED), t);
      assert.ok(t.includes("Take over in the chat") && !t.includes("localhost:"), t);
      const after = await readLease(dir);
      assert.deepEqual(after.holder, { kind: "bot", sessionId: "perch-real", botId: "bot-real" });
      assert.deepEqual(after.inCall, []);
    } finally { await client.close(); }
  } finally {
    for (const [k, v] of [["CROW_HOME", saved.CROW_HOME], ["PI_BOT_PERCH_SESSION_ID", saved.sid], ["PI_BOT_ID", saved.bid]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("a pending take-over (pendingOperator): a new call waits like an operator holding and never acts", async () => {
  const { calls, call, dir, clock } = setup();
  await leaseMod.acquire(dir, ME, { now: clock.now() });
  await leaseMod.beginCall(dir, ME, { callId: "inflight", pid: process.pid, now: clock.now() });
  const r = await leaseMod.takeOperatorIfIdle(dir, { now: clock.now() });
  assert.equal(r.taken, false, "the take-over waits for the in-flight call");
  // the gateway keeps the request fresh while it waits; then it switches
  clock.onSleep = async (elapsed) => {
    if (elapsed < 15000) await leaseMod.takeOperatorIfIdle(dir, { now: clock.now() });
    else if (elapsed === 15000) await leaseMod.takeOperator(dir, { now: clock.now() });
  };
  const out = await call({ url: "x" });
  assert.equal(text(out), TEXTS.held, "still the operator's after 20 s");
  assert.equal(calls.length, 0, "never acted");
  // a request that ended without taking it (hand back while pending) frees the wait
  const b = setup();
  await leaseMod.acquire(b.dir, ME, { now: b.clock.now() });
  await leaseMod.beginCall(b.dir, ME, { callId: "inflight", pid: process.pid, now: b.clock.now() });
  await leaseMod.takeOperatorIfIdle(b.dir, { now: b.clock.now() });
  b.clock.onSleep = async (elapsed) => { if (elapsed === 2000) await leaseMod.clearPendingOperator(b.dir); };
  assert.equal(text(await b.call({})), TEXTS.handedBack);
  assert.equal(b.calls.length, 0, "a call that waited never acts");
});

test("a failed endCall (ELEASELOCKED) is retried once after 500 ms, so a finished call does not stay in inCall", async () => {
  let fails = 1, attempts = 0;
  const flaky = { ...leaseMod, endCall: async (...a) => { attempts++; if (fails-- > 0) throw Object.assign(new Error("locked"), { code: "ELEASELOCKED" }); return leaseMod.endCall(...a); } };
  const ctx = setup({ lease: flaky });
  const before = ctx.clock.t;
  const r = await ctx.call({});
  assert.equal(text(r), "acted");
  assert.equal(attempts, 2, "retried once");
  assert.equal(ctx.clock.t - before, 500, "after 500 ms");
  assert.deepEqual((await readLease(ctx.dir)).inCall, [], "the call left inCall");
  // two failures: still only one retry, and the result is unharmed
  let n = 0;
  const broken = { ...leaseMod, endCall: async () => { n++; throw Object.assign(new Error("locked"), { code: "ELEASELOCKED" }); } };
  const b = setup({ lease: broken });
  assert.equal(text(await b.call({})), "acted");
  assert.equal(n, 2);
});
