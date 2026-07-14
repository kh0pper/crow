/**
 * PiRpc exit-fast surface (Item 4-PR4, spec §2.1 item 7).
 *
 * When pi dies before responding (the canonical fresh-install case: the
 * resolver fell to LOCAL_FALLBACK and pi prints `Unknown provider "crow-local"`
 * and exits), the turn used to burn 2x15s swallowed get_state timeouts and
 * then reject with a cryptic "timeout:prompt-ack". PiRpc now rejects pending
 * (and future) waiters immediately with a message naming the resolved model
 * and pi's stderr — which handleInbound's catch relays to the user via
 * sendReply as "(bridge error: ...)".
 *
 * Uses the PiRpc nodeBin/cliPath test seam with a stub child so no real pi
 * (and none of its live MCP servers) is ever spawned.
 */
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000"; // read at module load — set BEFORE import

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");

function makeStub(dir, body) {
  const p = join(dir, "stub-pi.mjs");
  writeFileSync(p, body);
  return p;
}

test("pi exits before responding -> prompt rejects fast with model + stderr, no hang, no EPIPE crash", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "crow-pirpc-"));
  mkdirSync(join(scratch, "sessions"), { recursive: true });
  const stub = makeStub(
    scratch,
    'console.error(\'Error: Unknown provider "bogus-local". Use --list-models to see available providers/models.\');\nprocess.exit(1);\n'
  );
  const pi = new PiRpc({
    def: {},
    sessionDir: scratch,
    resolved: { provider: "bogus-local", model: "no-such-model", key: "bogus-local/no-such-model" },
    nodeBin: process.execPath,
    cliPath: stub,
  });
  const t0 = Date.now();
  // Same call shape as the turn: swallowed getState, then prompt.
  const st0 = await pi.getState().catch(() => null);
  assert.equal(st0, null, "getState on a dead pi resolves null via its catch");
  await assert.rejects(
    () => pi.prompt("hi", 8000),
    (e) => {
      assert.match(e.message, /pi exited/, "message must say pi exited");
      assert.match(e.message, /bogus-local\/no-such-model/, "message must name the resolved model");
      assert.match(e.message, /may not be available on this instance/, "message must explain the likely cause");
      assert.match(e.message, /Unknown provider/, "message must carry pi's stderr");
      return true;
    }
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 7000, `must fail fast via exit detection, not the ack timeout (took ${elapsed}ms)`);
  await pi.close();
});

test("waiters pending at exit time are rejected by the exit handler", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "crow-pirpc-"));
  mkdirSync(join(scratch, "sessions"), { recursive: true });
  // Stub lingers briefly so the waiter registers BEFORE exit.
  const stub = makeStub(
    scratch,
    'console.error("boom: provider misconfigured");\nsetTimeout(() => process.exit(3), 300);\n'
  );
  const pi = new PiRpc({
    def: {},
    sessionDir: scratch,
    resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath,
    cliPath: stub,
  });
  await assert.rejects(
    () => pi.waitFor((m) => m.type === "never", 8000, "prompt-ack"),
    (e) => /pi exited \(code 3\)/.test(e.message) && /boom: provider misconfigured/.test(e.message)
  );
  await pi.close();
});
