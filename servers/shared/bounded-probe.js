/**
 * Bounded, non-blocking child-process probe.
 *
 * A GPU driver in a wedged state leaves its child in uninterruptible sleep
 * (D-state): the process cannot be killed, so a synchronous spawn primitive
 * (`execFileSync`) blocks the caller — and therefore the whole event loop —
 * long past its own timeout. `runBoundedProbe` never blocks: the child runs
 * `detached` and is unref'd, the settle is driven by a hard deadline timer, and
 * a child that ignores SIGKILL is abandoned (its pipe destroyed) instead of
 * being waited on.
 *
 * The returned promise always resolves and never rejects:
 *   { ok, stdout, reason }
 * with reason "exit" (code 0), "nonzero" (non-zero exit), "spawn-error"
 * (the child could not be started, e.g. ENOENT) or "deadline" (the hard
 * deadline fired; stdout is always "" in that case).
 */

import { spawn } from "node:child_process";

/** Bytes of stdout collected before collection stops (output beyond it is dropped). */
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/**
 * Run `cmd args` and resolve within `deadlineMs`.
 *
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{deadlineMs?: number, spawnImpl?: Function, env?: Object}} [opts]
 * @returns {Promise<{ok: boolean, stdout: string, reason: "exit"|"nonzero"|"spawn-error"|"deadline"}>}
 */
export function runBoundedProbe(cmd, args = [], { deadlineMs = 5000, spawnImpl = spawn, env } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let collectedBytes = 0;
    let child = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };

    // The deadline settles the promise first and only then abandons the child:
    // a D-state child never exits, so nothing here may wait for it.
    timer = setTimeout(() => {
      finish({ ok: false, stdout: "", reason: "deadline" });
      try { child?.kill("SIGKILL"); } catch { /* already gone or not signalable */ }
      try { child?.stdout?.destroy(); } catch { /* pipe already torn down */ }
      try { child?.unref(); } catch { /* already detached */ }
    }, deadlineMs);

    try {
      child = spawnImpl(cmd, args, { stdio: ["ignore", "pipe", "ignore"], detached: true, env });
    } catch {
      finish({ ok: false, stdout: "", reason: "spawn-error" });
      return;
    }

    try { child.unref(); } catch { /* not detachable on this platform */ }

    try {
      child.stdout?.on("data", (chunk) => {
        if (collectedBytes >= MAX_STDOUT_BYTES) return;
        const text = typeof chunk === "string" ? chunk : String(chunk?.toString?.("utf8") ?? chunk);
        const room = MAX_STDOUT_BYTES - collectedBytes;
        const slice = text.length > room ? text.slice(0, room) : text;
        stdout += slice;
        collectedBytes += Buffer.byteLength(slice);
      });
    } catch { /* a child without a readable stdout simply yields no output */ }

    child.on?.("error", () => finish({ ok: false, stdout: "", reason: "spawn-error" }));
    child.on?.("close", (code) => finish({ ok: code === 0, stdout, reason: code === 0 ? "exit" : "nonzero" }));
  });
}