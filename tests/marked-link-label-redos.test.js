// marked's LINK / REFERENCE-LABEL regex backtracked EXPONENTIALLY on a `[`
// opener followed by backtick runs. In marked 17.0.4 a ~160-character model
// reply could therefore stall the gateway's event loop (both renderers run
// synchronously on it) for minutes; it was fixed upstream in marked 17.0.5
// (markedjs/marked#3918, a CVE-style ReDoS).
//
// This pins the fix so neither a dependency downgrade nor a marked regression
// can freeze CI instead of failing it:
//
//   1. Every upstream PoC shape — plus image and reference-link variants — is
//      rendered through BOTH public renderers (renderBotMarkdown and
//      renderMarkdown) inside a node:worker_threads Worker. An exponential
//      lexer never answers: a worker that has not replied within 5 s
//      wall-clock is terminated and the test FAILS. Every render must also
//      stay under 200 ms of CPU.
//   2. The installed marked must be >= 17.0.5.
//
// The worker is an inline `eval: true` script (no fixture file): it imports
// servers/blog/renderer.js by absolute file URL, measures CPU time around each
// render only (module load is not counted), and posts the timings back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/** Absolute URL of the renderer under test, resolved from this test file. */
const RENDERER_URL = pathToFileURL(
  join(import.meta.dirname, "..", "servers", "blog", "renderer.js"),
).href;

/** Wall-clock budget for one worker: start-up + import + BOTH renders. */
const WORKER_TIMEOUT_MS = 5_000;
/** CPU budget for each render (see the header: a healthy render is ~1 ms, and the
 *  worst of three measured runs on the dev box was 10.9 ms — so this is ~18x the
 *  measurement and far under the cliff, which is minutes: the exponential
 *  backtracking never returns). The 5 s WORKER_TIMEOUT_MS stays: it is the
 *  hang guard for that cliff, not a timing assertion. */
const RENDER_CPU_BUDGET_MS = 200;

const WORKER_SRC = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

// CPU of THIS thread when Node offers it (process.cpuUsage is process-wide and
// would also count the idle main thread's neighbours); fall back harmlessly.
function cpuMs() {
  const usage = typeof process.threadCpuUsage === "function"
    ? process.threadCpuUsage()
    : process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

(async () => {
  const { renderBotMarkdown, renderMarkdown } = await import(workerData.rendererUrl);
  const timings = {};
  for (const [name, render] of [
    ["renderBotMarkdown", renderBotMarkdown],
    ["renderMarkdown", renderMarkdown],
  ]) {
    if (typeof render !== "function") throw new Error(name + " is not exported");
    const started = cpuMs();
    const html = render(workerData.input);
    timings[name] = cpuMs() - started;
    if (typeof html !== "string") throw new Error(name + " did not return a string");
  }
  parentPort.postMessage({ timings });
})().catch((error) => {
  parentPort.postMessage({ error: String((error && error.stack) || error) });
});
`;

/**
 * Render `input` through both renderers in a throwaway worker thread.
 * Rejects — after terminating the worker — when it has not answered within
 * WORKER_TIMEOUT_MS, or when the worker fails. Resolves with
 * `{ renderBotMarkdown, renderMarkdown }` CPU ms.
 */
function renderInWorker(name, input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { rendererUrl: RENDERER_URL, input },
    });
    let settled = false;

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      reject(new Error(`${name}: ${message}`));
    };

    // The ReDoS failure mode: marked never returns, so the render never
    // reports. Killing the worker keeps the rest of the suite running and
    // turns the hang into a failure.
    const timer = setTimeout(() => {
      fail(
        `no answer within ${WORKER_TIMEOUT_MS} ms wall-clock (worker terminated). ` +
        `The markdown renderer is still blocking — marked's link/reference-label ` +
        `regex is backtracking again (fixed in marked 17.0.5, markedjs/marked#3918).`,
      );
    }, WORKER_TIMEOUT_MS);

    worker.once("message", (message) => {
      if (settled) return;
      if (message && message.error) {
        fail(`worker failed: ${message.error}`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve((message && message.timings) || {});
    });
    worker.once("error", (error) => fail(`worker error: ${(error && error.message) || error}`));
    worker.once("exit", (code) => fail(`worker exited (code ${code}) before answering`));
  });
}

// The upstream PoC inputs (markedjs/marked#3918) verbatim, plus an image and a
// reference-link spelling of the same shape — every bracketed label path
// reaches the same regex.
const INPUTS = {
  orig_n40: "[" + "``a".repeat(40),
  orig3: "[" + "```a".repeat(34),
  long_runs: "[" + ("`".repeat(20) + "a").repeat(8),
  indented_lazy: "[x\n" + "    ``a``a\n".repeat(20),
  lazy_cont: "[``a\n    " + "``a".repeat(40),
  esc_bracket: "[" + "``a\\]".repeat(40),
  code_bracket: "[`]" + "``a".repeat(40),
  image_n40: "![" + "``a".repeat(40),
  reflink_n40: "[" + "``a".repeat(40) + "][y]",
};

test("marked link/reference-label ReDoS (#3918): every PoC renders fast in a worker", async (t) => {
  let worst = { ms: 0, what: "nothing yet" };
  for (const [name, input] of Object.entries(INPUTS)) {
    // A hang here rejects via the 5 s timer with the worker terminated.
    const timings = await renderInWorker(name, input);
    for (const renderer of ["renderBotMarkdown", "renderMarkdown"]) {
      const ms = timings[renderer];
      assert.equal(
        typeof ms, "number",
        `${name}: ${renderer} reported no CPU time (worker answered without a timing)`,
      );
      if (ms > worst.ms) worst = { ms, what: `${name} / ${renderer}` };
      assert.ok(
        ms < RENDER_CPU_BUDGET_MS,
        `${name}: ${renderer} took ${ms.toFixed(1)} ms of CPU on a ${input.length}-character ` +
        `input (budget ${RENDER_CPU_BUDGET_MS} ms). That is the marked link/reference-label ` +
        `backtracking fixed in 17.0.5 (markedjs/marked#3918) coming back.`,
      );
    }
  }
  t.diagnostic(`worst render: ${worst.ms.toFixed(2)} ms — ${worst.what}`);
});
/**
 * `a` is at least `b`, comparing the numeric x.y.z prefix (a prerelease or
 * build suffix is ignored: 17.0.5-rc.1 counts as 17.0.5).
 */
function atLeast(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return true;
}

test("installed marked includes the ReDoS fix (>= 17.0.5, markedjs/marked#3918)", () => {
  // Resolve through createRequire so this is the exact copy the renderer
  // imports (no hand-built node_modules path that can drift).
  const pkgPath = require.resolve("marked/package.json");
  const { version } = require(pkgPath);
  assert.equal(typeof version, "string", `cannot read a version out of ${pkgPath}`);
  assert.ok(
    atLeast(version, "17.0.5"),
    `installed marked is ${version}, but >= 17.0.5 is required: marked 17.0.4's ` +
    `link/reference-label regex backtracked exponentially (markedjs/marked#3918), ` +
    `so a crafted ~160-character reply can freeze the gateway's event loop. ` +
    `Restore marked >= 17.0.5 (and the lockfile entry) — a downgrade must not land.`,
  );
});