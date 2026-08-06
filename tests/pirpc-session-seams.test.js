/**
 * Perch Hub P2, Task C-12 — PiRpc long-lived-session seams.
 *
 * The bridge's PiRpc has always been spawn-per-turn: one child, one prompt,
 * close. Perch's interactive engine (C-13) keeps ONE child alive across many
 * turns, which breaks two unstated assumptions baked into the original
 * class: (1) `events`/`responses` accumulate forever and every wait scans
 * them from the start, so a second turn's waiters can match the FIRST turn's
 * already-accumulated messages (the exact "stale-match" bug getSessionStats
 * already documents, but for the much hotter prompt/agent_end path); (2) env
 * assembly trusted `def.spawn_env` completely, so a bot def could set
 * PI_BOT_INTERACTIVE itself and flip a normal channel turn's ask_user into an
 * unanswerable hang.
 *
 * Everything here is ADDITIVE — new constructor opts (onEvent, extraEnv) and
 * new methods (promptTurn, waitForSince, trimLog, abortSince). prompt() /
 * getState() / abort() are byte-identical; the bot-world.test.js goldens are
 * the broader regression guard for that (spawn-per-turn callers never see
 * any of this).
 *
 * Uses the PiRpc nodeBin/cliPath test seam (pibot-bridge-exit-surface.test.js
 * idiom) with stub children that speak the line protocol directly — no real
 * pi is ever spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "crow-pirpc-seams-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

/** Write a stub "pi" child and return its path. `body` is raw JS source. */
function makeStub(dir, body) {
  const p = join(dir, "stub-pi.mjs");
  writeFileSync(p, body);
  return p;
}

/** A stub that reads stdin line-by-line and hands each parsed message to
 * `onMessage(msg, out)`, where `out(obj)` writes one NDJSON line to stdout.
 * `preamble` (raw JS source) runs before the stdin listener is wired, so
 * tests that need output before any input (test a/b) can just print lines. */
function protocolStub(dir, { preamble = "", onMessageBody = "" } = {}) {
  return makeStub(dir, [
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    preamble,
    'let buf = "";',
    'process.stdin.on("data", (chunk) => {',
    '  buf += chunk.toString("utf8");',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    let m; try { m = JSON.parse(line); } catch { continue; }',
    onMessageBody,
    '  }',
    '});',
    'process.stdin.resume();',
    '',
  ].join("\n"));
}

function mkPi(scratch, cliPath, extra) {
  return new PiRpc(Object.assign({
    def: {},
    sessionDir: scratch,
    resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath,
    cliPath,
  }, extra));
}

// ---------------------------------------------------------------------------
// (a) onEvent receives every parsed message in order
// ---------------------------------------------------------------------------

test("(a) onEvent fires for every parsed stdout message, in order, before waiter dispatch", async () => {
  const scratch = scratchDir();
  // Emission is send-triggered (not a preamble) so the test can register its
  // waiter FIRST, deterministically — which is what makes the before-waiter-
  // dispatch assertion below meaningful rather than racy.
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "go") {',
      '      out({ type: "event", n: 1 });',
      '      out({ type: "event", n: 2 });',
      '      out({ type: "response", command: "marker", n: 3 });',
      '    }',
    ].join("\n"),
  });
  const seen = [];
  let markerWaiterStillRegistered = null;
  const pi = mkPi(scratch, stub, {
    onEvent: (m) => {
      seen.push(m);
      // Fix round 1 (MINOR 3): prove the "before waiter dispatch" half of the
      // title. When onEvent runs for the marker message, the marker waiter
      // must STILL be registered in _w — dispatch (splice + resolve) happens
      // after onEvent in the parse loop. Deterministic because the waiter is
      // registered before the stub is told to emit anything.
      if (m.command === "marker") {
        markerWaiterStillRegistered = pi._w.some((w) => w.label === "marker");
      }
    },
  });
  try {
    const wait = pi.waitFor((m) => m.type === "response" && m.command === "marker", 5000, "marker");
    pi.send({ type: "go" });
    await wait;
    assert.deepEqual(seen.map((m) => m.n), [1, 2, 3], "onEvent must see all three, in order");
    assert.equal(seen[0].type, "event");
    assert.equal(seen[2].type, "response");
    assert.equal(seen[2].command, "marker", "onEvent sees responses too, not just events");
    assert.equal(markerWaiterStillRegistered, true,
      "onEvent must run BEFORE waiter dispatch — the marker waiter was still registered when onEvent saw the marker");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// (b) a throwing onEvent does not break waitFor/prompt
// ---------------------------------------------------------------------------

test("(b) a throwing onEvent is swallowed — prompt() still resolves normally", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      out({ type: "response", command: "prompt" });',
      '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });',
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub, {
    onEvent: () => { throw new Error("onEvent boom — must never kill a turn"); },
  });
  try {
    const end = await pi.prompt("hi", 5000);
    assert.equal(end.type, "agent_end");
    assert.equal(pi.assistantText(), "ok", "the turn must complete normally despite onEvent throwing on every message");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// (c) without new opts: events/responses populate identically (byte-identical
// smoke test — bot-world.test.js goldens are the broader guard)
// ---------------------------------------------------------------------------

test("(c) with no new opts, a plain prompt() turn populates events/responses exactly as before", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      out({ type: "response", command: "prompt" });',
      '      out({ type: "tool_execution_end", toolName: "read", isError: false });',
      '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "plain reply" }] }] });',
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub); // no onEvent, no extraEnv
  try {
    await pi.prompt("hi", 5000);
    assert.equal(pi.assistantText(), "plain reply");
    assert.deepEqual(pi.toolCalls(), [{ tool: "read", isError: false }]);
    assert.equal(pi.responses.length, 1);
    assert.equal(pi.events.length, 2, "tool_execution_end + agent_end");
    assert.equal(pi.onEvent, null, "onEvent defaults to null when absent");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// (d) sequential turns on ONE long-lived child: promptTurn must never return
// a PREVIOUS turn's reply. Per the task brief's methodology this was FIRST
// proven to fail against prompt() (see task-C12-report.md for that run's
// captured output) before being written against promptTurn() here.
//
// Structure is deliberate, not incidental: turn 1 -> turn 2 run with NOTHING
// cleared in between, so turn 1's ack+agent_end are still sitting in
// events/responses when turn 2's waits are set up — this is what makes the
// assertion mutation-sensitive to `waitForSince`'s `_seq` filter (a
// trimLog() placed between the compared turns would empty the arrays and
// make the comparison trivially pass even with the filter removed, since
// there would be nothing stale left to false-match against). trimLog() is
// then exercised AFTER turn 2, ahead of turn 3, to prove S7's promise
// separately: `since` monotonicity (and therefore correctness) survives a
// trim.
// ---------------------------------------------------------------------------

function multiTurnStub(dir) {
  return protocolStub(dir, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      turn = (turn || 0) + 1;',
      '      const id = m.id;',
      '      const ack = { type: "response", command: "prompt", success: true };',
      '      if (id) ack.id = id;',
      '      out(ack);',
      '      const end = { type: "agent_end", turn,',
      '        messages: [{ role: "assistant", content: [{ type: "text", text: "reply-" + turn }] }] };',
      '      if (id) end.id = id;',
      '      out(end);',
      '    }',
    ].join("\n"),
    preamble: "let turn = 0;",
  });
}

test("(d) promptTurn() on a long-lived child: each turn gets its OWN reply, never a stale one; trimLog() between turns 2 and 3 does not break `since` (S7)", async () => {
  const scratch = scratchDir();
  const stub = multiTurnStub(scratch);
  const pi = mkPi(scratch, stub);
  try {
    // Turns 1 -> 2, NO trim in between: proves the core fix (mutation kills
    // this leg if the `_seq` filter is stripped from waitForSince).
    const end1 = await pi.promptTurn("turn one", 5000);
    assert.equal(pi.assistantText(), "reply-1");
    assert.ok(pi.events.length >= 1, "turn 1's agent_end is still sitting in the array — nothing cleared it");

    const end2 = await pi.promptTurn("turn two", 5000);
    assert.equal(pi.assistantText(), "reply-2", "turn 2 must get turn 2's own reply, not turn 1's stale one");
    assert.notEqual(end1, end2);

    // S7: the engine trims the log between turns; `since` correlation must
    // survive it (trimLog must NOT reset _seq/_promptSeq).
    const seqBeforeTrim = pi._seq;
    pi.trimLog();
    assert.deepEqual(pi.events, []);
    assert.deepEqual(pi.responses, []);
    assert.equal(pi._seq, seqBeforeTrim, "trimLog must never reset _seq");

    const end3 = await pi.promptTurn("turn three", 5000);
    assert.equal(pi.assistantText(), "reply-3", "turn 3 must get its own reply post-trim");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// (d2, fix round 1 IMPORTANT) auto-retry: pi emits agent_end {willRetry:true}
// BEFORE an auto-retry (dist/core/agent-session.js; auto-retry defaults ON,
// maxRetries 3) and a second, final agent_end when the retry completes.
// promptTurn must skip the pre-retry one and return the real one — otherwise
// it returns the error turn while the child keeps working, and the retry's
// real agent_end (higher _seq) satisfies the NEXT turn's wait: the exact
// stale-match class this task exists to close.
// ---------------------------------------------------------------------------

test("(d2) promptTurn() skips agent_end {willRetry:true} and returns the post-retry final agent_end", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      const ack = { type: "response", command: "prompt", success: true };',
      '      if (m.id) ack.id = m.id;',
      '      out(ack);',
      // The pre-retry error turn: agent_end with willRetry:true, then the
      // retry finishes with a final agent_end (no willRetry).
      '      out({ type: "agent_end", willRetry: true, marker: "pre-retry",',
      '        messages: [{ role: "assistant", content: [{ type: "text", text: "transient error" }] }] });',
      '      out({ type: "agent_end", marker: "final",',
      '        messages: [{ role: "assistant", content: [{ type: "text", text: "real reply" }] }] });',
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    const end = await pi.promptTurn("hi", 5000);
    assert.notEqual(end.willRetry, true, "must never return the pre-retry agent_end");
    assert.equal(end.marker, "final", "promptTurn must return the post-retry final agent_end, not the willRetry:true one");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// (e) ms=0 never times out (fake long gap) AND rejects on child exit (no
// waiter leak)
// ---------------------------------------------------------------------------

test("(e) waitFor(ms=0) never times out, but still rejects (no leak) when the child exits", async () => {
  const scratch = scratchDir();
  const stub = makeStub(scratch, 'setTimeout(() => {}, 10000);\n'); // idles until killed
  const pi = mkPi(scratch, stub);
  try {
    const p = pi.waitFor((m) => m.type === "never-matches", 0, "ms0-wait");
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(settled, false, "an ms=0 waiter must not time out even after a long real-time gap");
    assert.equal(pi._w.length, 1, "the waiter is still registered, waiting on the child");

    pi.proc.kill("SIGTERM");
    await assert.rejects(() => p, /pi exited/, "the exit handler must reject the ms=0 waiter — no leak past the child");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// (f) spawn_env hygiene — reserved-looking keys never reach the child; other
// keys still do
// ---------------------------------------------------------------------------

function envDumpStub(dir, outPath) {
  return makeStub(dir, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(process.env));`,
    'console.error("env-dump stub exiting");',
    'process.exit(7);',
  ].join("\n"));
}

test("(f) spawn_env keys matching PI_BOT_*/PIBOT_* are stripped before merge; other keys pass through", async () => {
  const scratch = scratchDir();
  const outPath = join(scratch, "env.json");
  const stub = envDumpStub(scratch, outPath);
  const pi = mkPi(scratch, stub, {
    def: {
      spawn_env: {
        PI_BOT_INTERACTIVE: "1",
        PI_BOT_PERMISSION_POLICY: '{"bash":"allow"}', // must not clobber the computed policy either
        PIBOT_MAX_PI: "999",
        CROW_JOURNAL_MODE: "DELETE", // ordinary key — must still pass through
      },
    },
  });
  await pi.exited;
  await pi.close();
  const { readFileSync } = await import("node:fs");
  const env = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(env.PI_BOT_INTERACTIVE, undefined, "PI_BOT_INTERACTIVE from spawn_env must never reach the child");
  assert.equal(env.PIBOT_MAX_PI, undefined, "PIBOT_MAX_PI from spawn_env must never reach the child");
  assert.notEqual(env.PI_BOT_PERMISSION_POLICY, '{"bash":"allow"}', "spawn_env must not clobber the computed permission policy");
  assert.ok(JSON.parse(env.PI_BOT_PERMISSION_POLICY).bash === "deny" || JSON.parse(env.PI_BOT_PERMISSION_POLICY).bash === undefined,
    "the computed policy (bash:deny default) must win, not the def's spawn_env override");
  assert.equal(env.CROW_JOURNAL_MODE, "DELETE", "a non-reserved spawn_env key must still pass through unchanged");
});

// ---------------------------------------------------------------------------
// (g) extraEnv wins over spawn_env
// ---------------------------------------------------------------------------

test("(g) extraEnv is merged LAST — it wins over a colliding def.spawn_env key", async () => {
  const scratch = scratchDir();
  const outPath = join(scratch, "env.json");
  const stub = envDumpStub(scratch, outPath);
  const pi = mkPi(scratch, stub, {
    def: { spawn_env: { CROW_JOURNAL_MODE: "DELETE", SHARED_KEY: "from-spawn-env" } },
    extraEnv: { SHARED_KEY: "from-extra-env", PI_BOT_INTERACTIVE: "1" },
  });
  await pi.exited;
  await pi.close();
  const { readFileSync } = await import("node:fs");
  const env = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(env.SHARED_KEY, "from-extra-env", "extraEnv must win over a colliding spawn_env key");
  assert.equal(env.CROW_JOURNAL_MODE, "DELETE", "non-colliding spawn_env keys are untouched");
  assert.equal(env.PI_BOT_INTERACTIVE, "1", "extraEnv is how the engine legitimately sets PI_BOT_INTERACTIVE (unlike a bot def, which gets it stripped — see (f))");
});

// ---------------------------------------------------------------------------
// (h) ack {success:false, error} -> promptTurn REJECTS, never waits for
// agent_end
// ---------------------------------------------------------------------------

test("(h) a preflight-refused ack rejects promptTurn immediately — it never waits for an agent_end that will never come", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      const ack = { success: false, error: "boom", type: "response", command: "prompt" };',
      '      if (m.id) ack.id = m.id;',
      '      out(ack);',
      // Deliberately never send agent_end — a session with ms=0 must not wedge.
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => pi.promptTurn("hi", 0), // ms=0: if this waited for agent_end it would hang forever
      (e) => /prompt refused: boom/.test(e.message)
        // C-13 fix round 1 (M-3): the refusal is TYPED — the interactive
        // engine discriminates on err.code, not on the message string.
        && e.code === "prompt_refused"
    );
    assert.ok(Date.now() - t0 < 3000, "must reject immediately off the ack, not wait on agent_end");
  } finally {
    await pi.close();
  }
});

test("(h2) an ack MISSING the success field rejects promptTurn — fail-closed, never proceeds to the agent_end wait", async () => {
  // Fix round 1 (MINOR 1): pi 0.82.0 always sets `success` on prompt acks, so
  // a success-less ack is older/malformed protocol. The check must be
  // `success !== true` (fail-closed), not `success === false` (fail-open) —
  // with ms=0 there is no timeout backstop, so proceeding would wedge forever.
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      const ack = { type: "response", command: "prompt" };', // no success field at all
      '      if (m.id) ack.id = m.id;',
      '      out(ack);',
      // Deliberately never send agent_end — a session with ms=0 must not wedge.
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    // Hang-proof by construction: under the fail-open mutation
    // (`success === false`) promptTurn would proceed to an ms=0 agent_end
    // wait and pend FOREVER (no timeout backstop, child stays alive) — so
    // race it against a short timer instead of awaiting it bare, and fail
    // loudly on "still-pending" rather than wedging the whole test file.
    const p = pi.promptTurn("hi", 0); // ms=0: the ack check is the only defense
    const outcome = await Promise.race([
      p.then(() => "resolved", (e) => e),
      new Promise((r) => setTimeout(r, 1500, "still-pending")),
    ]);
    assert.ok(outcome instanceof Error,
      "promptTurn must reject a success-less ack immediately, not proceed to the agent_end wait (got: " + String(outcome) + ")");
    assert.match(outcome.message, /prompt refused: unknown/);
    assert.equal(outcome.code, "prompt_refused", "the fail-closed refusal carries the typed code too (M-3)");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// bonus (not separately lettered in the brief, item 6 of the interface list):
// engine-correlated aborts — a second abort in one awake window must not
// match the first's stale response.
// ---------------------------------------------------------------------------

test("abortSince(): a second abort in one awake window does not resolve off the first's stale response", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "abort") out({ type: "response", command: "abort" });',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    const r1 = await pi.abortSince();
    assert.equal(r1.type, "response");
    assert.equal(pi.responses.length, 1, "one abort response so far");

    // A second, uncorrelated abort() would resolve INSTANTLY off r1 (still
    // sitting in this.responses) without ever sending anything. abortSince
    // must not.
    const before = pi._seq;
    const p2 = pi.abortSince(2000);
    // Give the (uncorrelated) synchronous-scan failure mode a chance to
    // manifest: if abortSince degenerated to the old abort(), p2 would have
    // already resolved by the time this microtask runs, off r1.
    let settledEarly = false;
    p2.then(() => { settledEarly = (pi._seq === before); });
    await Promise.resolve(); // flush one microtask turn
    assert.equal(settledEarly, false, "must not resolve off the stale pre-existing response before its own send lands");
    const r2 = await p2;
    assert.equal(r2.type, "response");
    assert.ok(r2._seq > before, "the second abort's response must be a NEW message, not the first's");
  } finally {
    await pi.close();
  }
});
