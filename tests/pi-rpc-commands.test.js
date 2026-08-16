/**
 * Track 3 board×Perch merge, Task 3 — PiRpc correlated commands, ack-only
 * prompt, permission-mode/extra-write-paths policy options.
 *
 * `commandSince` and `promptAckOnly` extend the same waitForSince idiom
 * `getSessionStats`/`promptTurn` already use (see pirpc-session-seams.test.js)
 * to slash-command style RPCs (`set_model`, `set_thinking_level`,
 * `get_available_models`, `get_available_thinking_levels`) and to prompts
 * that a pi-lab extension handles WITHOUT starting an agent loop (a bare
 * ack, never an agent_end).
 *
 * `permissionMode` / `extraWritePaths` are new constructor options consumed
 * by later Track 3 engine tasks. Channel callers (bridge.mjs's handleInbound)
 * pass neither, so their spawn env/argv must stay byte-identical —
 * tests/bot-world.test.js's golden fixtures are the regression gate for that;
 * the permissionMode-omitted test here pins the SAME pre-task policy shape
 * directly against PiRpc.
 *
 * Uses the PiRpc nodeBin/cliPath test seam (pirpc-session-seams.test.js
 * idiom) with stub children that speak the line protocol directly — no real
 * pi is ever spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "crow-pirpc-cmds-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

function makeStub(dir, body) {
  const p = join(dir, "stub-pi.mjs");
  writeFileSync(p, body);
  return p;
}

/** A stub that reads stdin line-by-line and hands each parsed message to
 * `onMessageBody` (raw JS source, `m` is the parsed message, `out(obj)`
 * writes one NDJSON line to stdout). Mirrors pirpc-session-seams.test.js. */
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

function envDumpStub(dir, outPath) {
  return makeStub(dir, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(process.env));`,
    'process.exit(7);',
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
// commandSince
// ---------------------------------------------------------------------------

test("commandSince resolves on the id-matched response, NOT a stale same-command/same-id response seeded before the call (since-scoping)", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "set_model") {',
      '      out({ type: "response", command: "set_model", id: m.id, success: true, real: true });',
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    // Seed a response carrying the EXACT id the first commandSince() call
    // will generate ("cmd_1") and command "set_model", but never parsed off
    // stdout (so it never bumped _seq — it stays at _seq:0). id+command alone
    // would satisfy the predicate; only the `since` (`m._seq > since`) check
    // can tell this stale entry apart from the real response.
    pi.responses.push({ type: "response", command: "set_model", id: "cmd_1", success: true, stale: true, _seq: 0 });
    const res = await pi.commandSince({ type: "set_model", provider: "crow", modelId: "m" });
    assert.equal(res.real, true, "must resolve on the NEW response, not the seeded stale one");
    assert.notEqual(res.stale, true);
  } finally {
    await pi.close();
  }
});

test("commandSince rejects on success:false with err.code = 'command_failed'", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "set_model") {',
      '      out({ type: "response", command: "set_model", id: m.id, success: false, error: "unknown model" });',
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    await assert.rejects(
      () => pi.commandSince({ type: "set_model", provider: "crow", modelId: "bogus" }),
      (e) => e.code === "command_failed"
    );
  } finally {
    await pi.close();
  }
});

test("commandSince rejects with command_failed on a response MISSING the success field (fail-closed, Fix round 1 ruling — mirrors promptTurn's success!==true check)", async () => {
  // A malformed/old-protocol response missing `success` must never be
  // treated as a successful model/thinking change — this serves engine
  // control() for set_model/set_thinking_level.
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "set_model") {',
      '      out({ type: "response", command: "set_model", id: m.id });', // no success field at all
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    await assert.rejects(
      () => pi.commandSince({ type: "set_model", provider: "crow", modelId: "m" }),
      (e) => e.code === "command_failed" && /set_model failed: unknown/.test(e.message)
    );
  } finally {
    await pi.close();
  }
});

test("commandSince resolves normally for get_available_models/get_available_thinking_levels/set_thinking_level shapes", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "get_available_models" || m.type === "get_available_thinking_levels" || m.type === "set_thinking_level") {',
      '      out({ type: "response", command: m.type, id: m.id, success: true, echoType: m.type });',
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    const a = await pi.commandSince({ type: "get_available_models" });
    assert.equal(a.echoType, "get_available_models");
    const b = await pi.commandSince({ type: "get_available_thinking_levels" });
    assert.equal(b.echoType, "get_available_thinking_levels");
    const c = await pi.commandSince({ type: "set_thinking_level", level: "high" });
    assert.equal(c.echoType, "set_thinking_level");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// promptAckOnly
// ---------------------------------------------------------------------------

test("promptAckOnly resolves on the ack only and leaves NO pending waiter for agent_end", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      const ack = { type: "response", command: "prompt", success: true };',
      '      if (m.id) ack.id = m.id;',
      '      out(ack);',
      // Deliberately never sends agent_end — proves promptAckOnly never
      // registers a wait for it (a slash command pi-lab handles fully
      // without starting an agent loop, per spec §5.2).
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    const ack = await pi.promptAckOnly("/plan");
    assert.equal(ack.success, true);
    assert.equal(pi._w.length, 0, "no pending waiter left behind — never waits for agent_end");
  } finally {
    await pi.close();
  }
});

test("promptAckOnly throws prompt_refused on success !== true (fail-closed, mirrors promptTurn's ack half)", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      const ack = { type: "response", command: "prompt", success: false, error: "not a recognized command" };',
      '      if (m.id) ack.id = m.id;',
      '      out(ack);',
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    await assert.rejects(
      () => pi.promptAckOnly("/bogus"),
      (e) => /prompt refused: not a recognized command/.test(e.message) && e.code === "prompt_refused"
    );
    assert.equal(pi._w.length, 0, "no waiter left behind even on the refusal path");
  } finally {
    await pi.close();
  }
});

test("promptAckOnly correlates by id — does not resolve off a stale same-command ack seeded before the call", async () => {
  const scratch = scratchDir();
  const stub = protocolStub(scratch, {
    onMessageBody: [
      '    if (m.type === "prompt") {',
      '      const ack = { type: "response", command: "prompt", success: true, real: true };',
      '      if (m.id) ack.id = m.id;',
      '      out(ack);',
      '    }',
    ].join("\n"),
  });
  const pi = mkPi(scratch, stub);
  try {
    // Same collision technique as the commandSince test above: seed a stale
    // ack carrying the exact id the first promptAckOnly() call will mint.
    pi.responses.push({ type: "response", command: "prompt", id: "prompt_1", success: true, stale: true, _seq: 0 });
    const ack = await pi.promptAckOnly("/plan");
    assert.equal(ack.real, true, "must resolve on the NEW ack, not the seeded stale one");
  } finally {
    await pi.close();
  }
});

// ---------------------------------------------------------------------------
// permissionMode / extraWritePaths constructor options
// ---------------------------------------------------------------------------

function policyFromDump(env) {
  return JSON.parse(env.PI_BOT_PERMISSION_POLICY);
}

test("permissionMode omitted -> PI_BOT_PERMISSION_POLICY is byte-identical to the pre-task policy (golden guard)", async () => {
  const scratch = scratchDir();
  const outPath = join(scratch, "env.json");
  const stub = envDumpStub(scratch, outPath);
  const pi = mkPi(scratch, stub);
  await pi.exited;
  await pi.close();
  const env = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(
    env.PI_BOT_PERMISSION_POLICY,
    '{"bash":"deny","write_paths":[],"multi_agent":false,"model_capable":false}',
    "no permissionMode/extraWritePaths -> byte-identical to the pre-task policy shape"
  );
});

test("permissionMode:'bypass' -> write_paths:['/'] and external_send deleted (pi-lab's gate only blocks on ===\"draft_only\"; absence already means allow)", async () => {
  const scratch = scratchDir();
  const outPath = join(scratch, "env.json");
  const stub = envDumpStub(scratch, outPath);
  const pi = mkPi(scratch, stub, {
    def: {
      permission_policy: {
        bash: "allowlist",
        bash_allow: ["ls"],
        write_paths: ["/some/existing/path"],
        external_send: "draft_only",
      },
    },
    permissionMode: "bypass",
  });
  await pi.exited;
  await pi.close();
  const env = JSON.parse(readFileSync(outPath, "utf8"));
  const policy = policyFromDump(env);
  assert.deepEqual(policy.write_paths, ["/"]);
  assert.equal("external_send" in policy, false, "external_send must be deleted, not set to a made-up 'allow' value");
});

test("permissionMode:'ask' -> interactive_ask:true, rest of the policy unchanged", async () => {
  const scratch = scratchDir();
  const outPath = join(scratch, "env.json");
  const stub = envDumpStub(scratch, outPath);
  const pi = mkPi(scratch, stub, { permissionMode: "ask" });
  await pi.exited;
  await pi.close();
  const env = JSON.parse(readFileSync(outPath, "utf8"));
  const policy = policyFromDump(env);
  assert.equal(policy.interactive_ask, true);
  assert.deepEqual(policy.write_paths, [], "ask mode does not touch write_paths");
});

test("permissionMode:'guarded' (explicit) -> byte-identical to omitted", async () => {
  const scratch = scratchDir();
  const outPath = join(scratch, "env.json");
  const stub = envDumpStub(scratch, outPath);
  const pi = mkPi(scratch, stub, { permissionMode: "guarded" });
  await pi.exited;
  await pi.close();
  const env = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(
    env.PI_BOT_PERMISSION_POLICY,
    '{"bash":"deny","write_paths":[],"multi_agent":false,"model_capable":false}'
  );
});

test("extraWritePaths appended to write_paths exactly like selfAuthoringDir; omitted leaves write_paths untouched", async () => {
  const scratchWith = scratchDir();
  const outWith = join(scratchWith, "env.json");
  const stubWith = envDumpStub(scratchWith, outWith);
  const piWith = mkPi(scratchWith, stubWith, { extraWritePaths: ["/tmp/x"] });
  await piWith.exited;
  await piWith.close();
  const policyWith = policyFromDump(JSON.parse(readFileSync(outWith, "utf8")));
  assert.deepEqual(policyWith.write_paths, ["/tmp/x"]);

  const scratchWithout = scratchDir();
  const outWithout = join(scratchWithout, "env.json");
  const stubWithout = envDumpStub(scratchWithout, outWithout);
  const piWithout = mkPi(scratchWithout, stubWithout); // omitted
  await piWithout.exited;
  await piWithout.close();
  const policyWithout = policyFromDump(JSON.parse(readFileSync(outWithout, "utf8")));
  assert.deepEqual(policyWithout.write_paths, [], "extraWritePaths omitted -> write_paths absent/unchanged from default");
});

test("extraWritePaths combines with selfAuthoringDir (both appended)", async () => {
  const scratch = scratchDir();
  const outPath = join(scratch, "env.json");
  const stub = envDumpStub(scratch, outPath);
  const pi = mkPi(scratch, stub, {
    selfAuthoringDir: "/bots/self/proposed-skills",
    extraWritePaths: ["/tmp/x"],
  });
  await pi.exited;
  await pi.close();
  const env = JSON.parse(readFileSync(outPath, "utf8"));
  const policy = policyFromDump(env);
  assert.deepEqual(policy.write_paths, ["/bots/self/proposed-skills", "/tmp/x"]);
});
