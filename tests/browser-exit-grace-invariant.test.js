// TG1 gap 1 — the exit cleanup's worst case has to fit inside every
// SIGTERM->SIGKILL window that can kill the browser MCP.
//
// The exit cleanup (bundles/browser/server/private-address.js) spends, in the
// worst case, its budget, then a page's unload grace, then two crash graces:
// a supervised parent that SIGTERMs the browser MCP and SIGKILLs it a moment
// later cuts that cleanup off half way, and the pages it never blanked keep
// running with the routes that refused private addresses gone with the process.
// So every such gap in this repo has to stay above the cleanup's own worst case,
// and the worst case has to be a NUMBER the repo can compare against instead of
// a sum re-derived by hand in each place.
//
// These tests drive nothing: they read the declared numbers, and the four
// places that SIGTERM-then-SIGKILL a child are read from their own source (or,
// where the module exports it, from the module).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// NAMESPACE imports, deliberately: EXIT_CLEANUP_WORST_CASE_MS and
// REAP_KILL_GRACE_MS do not exist yet, and a named import of a missing export is
// a load-time SyntaxError that would take this whole file down — the controls
// below included. Read as a property, a missing export is `undefined`, and the
// assertion that names it is what fails.
import * as cleanup from "../bundles/browser/server/private-address.js";
import * as lifecycle from "../scripts/pi-bots/pi_lifecycle.mjs";

const CLEANUP_SOURCE = new URL("../bundles/browser/server/private-address.js", import.meta.url);
const LIFECYCLE_SOURCE = new URL("../scripts/pi-bots/pi_lifecycle.mjs", import.meta.url);
const BRIDGE_SOURCE = new URL("../scripts/pi-bots/bridge.mjs", import.meta.url);
const BUNDLE_LIFECYCLE_SOURCE = new URL("../servers/gateway/bundle-lifecycle.js", import.meta.url);
const SDK_STDIO_SOURCE = new URL(
  "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
  import.meta.url,
);

/** One `const NAME = 1234;` number out of a file's own text (underscores allowed). */
function constantFromSource(url, name) {
  const text = readFileSync(url, "utf8");
  const found = new RegExp(`const ${name} = ([\\d_]+);`).exec(text);
  assert.ok(found, `${name} has to stay declared as a plain number in ${url.pathname}`);
  return Number(found[1].replace(/_/g, ""));
}

const BUDGET_MS = constantFromSource(CLEANUP_SOURCE, "EXIT_CLEANUP_BUDGET_MS");
const UNLOAD_GRACE_MS = constantFromSource(CLEANUP_SOURCE, "UNLOAD_GRACE_MS");
const CRASH_GRACE_MS = constantFromSource(CLEANUP_SOURCE, "CRASH_GRACE_MS");

/**
 * The exit cleanup's worst case (budget + unload grace + two crash graces).
 *
 * The exported number when the module has it (that is what gap 1a asks for), else
 * the same sum built from the four constants its own source declares — so the
 * CONTROL tests below, which are about OTHER processes' kill graces, can be
 * judged against today's values even before the export exists. They are controls:
 * they describe bounds that already hold and have to keep holding.
 */
function worstCaseMs() {
  if (typeof cleanup.EXIT_CLEANUP_WORST_CASE_MS === "number") return cleanup.EXIT_CLEANUP_WORST_CASE_MS;
  return BUDGET_MS + UNLOAD_GRACE_MS + 2 * CRASH_GRACE_MS;
}

// ---------------------------------------------------------------------------
// (a) the worst case is a declared number, and it is the sum of the four graces
// ---------------------------------------------------------------------------

test("(gap 1a) private-address.js exports EXIT_CLEANUP_WORST_CASE_MS as budget + unload grace + two crash graces", () => {
  const worst = cleanup.EXIT_CLEANUP_WORST_CASE_MS;

  assert.equal(
    typeof worst,
    "number",
    "the exit cleanup's worst case is spelled out as 3350 ms in a comment and re-derived by hand in " +
      "every other process that has to outlast it: private-address.js has to export " +
      "EXIT_CLEANUP_WORST_CASE_MS so those bounds can be compared against the cleanup itself",
  );
  assert.ok(
    Number.isFinite(worst) && worst > 0,
    `EXIT_CLEANUP_WORST_CASE_MS has to be a finite, positive number of milliseconds (got ${worst})`,
  );
  assert.equal(
    worst,
    BUDGET_MS + UNLOAD_GRACE_MS + 2 * CRASH_GRACE_MS,
    `EXIT_CLEANUP_WORST_CASE_MS has to BE the cleanup's worst case — the budget (${BUDGET_MS} ms), then a ` +
      `page's unload grace (${UNLOAD_GRACE_MS} ms), then two crash graces (2 × ${CRASH_GRACE_MS} ms) — and not a ` +
      `hand-kept copy of it (got ${worst})`,
  );
  assert.ok(
    worst >= BUDGET_MS,
    `the worst case includes the whole budget, so it can never be below it (worst ${worst} ms, budget ${BUDGET_MS} ms)`,
  );
  assert.equal(
    worst,
    3350,
    `with today's four constants (${BUDGET_MS} + ${UNLOAD_GRACE_MS} + 2 × ${CRASH_GRACE_MS}) the worst case is ` +
      `3350 ms — the number the comment above blankPagesOnExit already names and the number every kill grace in ` +
      `this repo has to clear (got ${worst})`,
  );
});

// ---------------------------------------------------------------------------
// (b) the reaper's SIGKILL grace clears the worst case by a whole second
// ---------------------------------------------------------------------------

test("(gap 1b) pi_lifecycle.mjs exports REAP_KILL_GRACE_MS, at least a second above the cleanup's worst case", () => {
  const grace = lifecycle.REAP_KILL_GRACE_MS;
  const worst = cleanup.EXIT_CLEANUP_WORST_CASE_MS;

  assert.equal(
    typeof grace,
    "number",
    "the pi reaper SIGTERMs a stuck pi and SIGKILLs it once its own deadline passes. The browser MCP runs " +
      "under that pi, so the reaper's grace is one of the gaps that can cut the browser's exit cleanup off: " +
      "scripts/pi-bots/pi_lifecycle.mjs has to export REAP_KILL_GRACE_MS so that gap is a number and not a " +
      "3000 written into the deadline",
  );
  assert.equal(
    typeof worst,
    "number",
    "REAP_KILL_GRACE_MS is compared against private-address.js's EXIT_CLEANUP_WORST_CASE_MS, which does not " +
      "exist yet (gap 1a): the reaper's grace cannot be judged against a worst case nobody declares",
  );
  assert.ok(
    grace >= worst + 1000,
    `the reaper's SIGTERM->SIGKILL gap (${grace} ms) has to clear the browser exit cleanup's worst case ` +
      `(${worst} ms) by at least a full second, so the cleanup is never killed half way with pages left ` +
      `unblanked behind the routes that just died (short by ${worst + 1000 - grace} ms)`,
  );
});

// ---------------------------------------------------------------------------
// (c) the deadline the reaper's SIGKILL is decided on
//
// Driving this behaviourally would need a fake pid that stays ALIVE across the
// poll: every fixture pid in the nonexistent range answers "gone" on the first
// isAlive() probe, so the SIGKILL never fires and the deadline is never reached.
// The deadline is therefore read out of the reaper's own text.
// ---------------------------------------------------------------------------

test("(gap 1c) reapStalePi decides its SIGKILL deadline on REAP_KILL_GRACE_MS, never on a 3000 ms literal", () => {
  const text = readFileSync(LIFECYCLE_SOURCE, "utf8");

  assert.equal(
    /Date\.now\(\)\s*\+\s*3000/.test(text),
    false,
    "the reaper's SIGKILL deadline is a literal `Date.now() + 3000`: that is 350 ms BELOW the browser exit " +
      "cleanup's 3350 ms worst case, so the reaper kills the browser MCP while it is still blanking pages. The " +
      "deadline has to use the exported REAP_KILL_GRACE_MS instead",
  );
  assert.match(
    text,
    /const deadline\s*=\s*Date\.now\(\)\s*\+\s*REAP_KILL_GRACE_MS\b/,
    "reapStalePi's SIGKILL deadline has to be `Date.now() + REAP_KILL_GRACE_MS` — the exported grace, not a " +
      "number next to it that can drift from it",
  );
});

// ---------------------------------------------------------------------------
// (d) CONTROL: every other SIGTERM->SIGKILL gap in this repo already clears the
// worst case. These bounds hold today; they are here so a future cleanup that
// grows past one of them is caught by name, and so the four graces are all
// judged against the same number.
// ---------------------------------------------------------------------------

test("(gap 1d CONTROL) servers/satellite/mcp-host.js KILL_GRACE_MS is above the exit cleanup's worst case", async () => {
  const { KILL_GRACE_MS } = await import("../servers/satellite/mcp-host.js");
  const worst = worstCaseMs();

  assert.equal(
    typeof KILL_GRACE_MS,
    "number",
    "servers/satellite/mcp-host.js still exports the SIGTERM->SIGKILL grace it stops a child on",
  );
  assert.ok(
    KILL_GRACE_MS > worst,
    `servers/satellite/mcp-host.js KILL_GRACE_MS (${KILL_GRACE_MS} ms) is the gap a satellite's MCP child ` +
      `(a browser server among them) is killed on: it has to stay above the exit cleanup's worst case ` +
      `(${worst} ms)`,
  );
});

test("(gap 1d CONTROL) scripts/pi-bots/bridge.mjs PiRpc.close's 5000 ms SIGKILL bound is above the worst case", () => {
  const text = readFileSync(BRIDGE_SOURCE, "utf8");
  const worst = worstCaseMs();

  const closeAt = text.indexOf("async close() {");
  assert.notEqual(closeAt, -1, "PiRpc.close is still where this test can read it");
  const body = text.slice(closeAt, closeAt + 4000);
  const killAt = body.indexOf("SIGKILL");
  assert.notEqual(
    killAt,
    -1,
    "PiRpc.close still SIGKILLs the process group of a pi that ignored SIGTERM, so the bound before it is " +
      "still a gap the browser MCP is killed on",
  );

  const timer = /setTimeout\([\s\S]{0,300}?\},\s*([\d_]+)\);/.exec(body.slice(0, killAt + 200));
  assert.ok(timer, "the SIGKILL in PiRpc.close is still issued by a timer with a millisecond bound");
  const bound = Number(timer[1].replace(/_/g, ""));
  assert.equal(
    bound,
    5000,
    `scripts/pi-bots/bridge.mjs PiRpc.close gives a pi that ignored SIGTERM a 5000 ms bound before the ` +
      `group SIGKILL (got ${bound} ms)`,
  );
  assert.ok(
    bound > worst,
    `scripts/pi-bots/bridge.mjs PiRpc.close's SIGKILL bound (${bound} ms) is the gap the browser MCP (a child ` +
      `of that pi) is killed on: it has to stay above the exit cleanup's worst case (${worst} ms)`,
  );
});

test("(gap 1d CONTROL) servers/gateway/bundle-lifecycle.js's 10_000 ms SIGKILL bound is above the worst case", () => {
  const text = readFileSync(BUNDLE_LIFECYCLE_SOURCE, "utf8");
  const worst = worstCaseMs();

  const timer = /setTimeout\(\(\) => killGroup\("SIGKILL"\),\s*([\d_]+)\)/.exec(text);
  assert.ok(
    timer,
    "spawnGroup still SIGTERMs a timed-out hook group and SIGKILLs it on a later timer — that bound is a gap " +
      "the browser MCP can be killed on",
  );
  const bound = Number(timer[1].replace(/_/g, ""));
  assert.equal(
    bound,
    10000,
    `servers/gateway/bundle-lifecycle.js gives a timed-out process group 10_000 ms between SIGTERM and ` +
      `SIGKILL (got ${bound} ms)`,
  );
  assert.ok(
    bound > worst,
    `servers/gateway/bundle-lifecycle.js's SIGKILL bound (${bound} ms) has to stay above the exit cleanup's ` +
      `worst case (${worst} ms)`,
  );
});

test("(gap 1d CONTROL) the MCP SDK's own stdio close waits two 2000 ms stages, and their sum clears the worst case", () => {
  const text = readFileSync(SDK_STDIO_SOURCE, "utf8");
  const worst = worstCaseMs();

  const waits = [...text.matchAll(/setTimeout\(resolve,\s*([\d_]+)\)/g)].map((m) => Number(m[1].replace(/_/g, "")));
  assert.equal(
    waits.length,
    2,
    "the MCP SDK's StdioClientTransport.close() still bounds itself in two stages (stdin end, then SIGTERM) — " +
      `the two waits this test sums are the SDK's whole gap (found ${waits.length}: ${waits.join(", ")})`,
  );
  const total = waits[0] + waits[1];
  assert.ok(
    total > worst,
    `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js is the transport every MCP child here is ` +
      `closed through: its two stages (${waits[0]} ms after stdin end, ${waits[1]} ms after SIGTERM) sum to ` +
      `${total} ms, and that has to stay above the exit cleanup's worst case (${worst} ms)`,
  );
});