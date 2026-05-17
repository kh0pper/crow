#!/usr/bin/env node
/**
 * Crow Bot Builder — pi process lifecycle hardening (Phase 2, plan §10 risk #4).
 *
 * The bridge is spawn-per-turn: handleInbound() spawns `pi --mode rpc`, runs
 * ONE turn, then PiRpc.close() (SIGTERM->SIGKILL) in finally. So in the happy
 * path pi never lingers. The residual risks this module closes:
 *
 *   - ORPHAN: if the bridge_tick node process is SIGKILLed / OOM-killed /
 *     hits systemd TimeoutStartSec mid-turn, finally never runs and the pi
 *     child is reparented to init (ppid 1) and keeps holding the model.
 *   - STUCK: a turn that wedges past every internal timeout.
 *   - RUNAWAY RSS: pi is only the agent-loop client (the model runs in the
 *     separate vllm/llama container) so it should never need multiple GB.
 *   - PILE-UP: overlapping ticks / a manual run while a tick is live could
 *     spawn more pi than crow's memory budget tolerates (crow has had hard
 *     freezes under memory pressure — see lab memory).
 *
 * Scope: ONLY processes whose argv contains the pinned pi cli.js path AND
 * `--mode rpc` (exactly what the bridge and the S2/S4 spikes spawn — never an
 * interactive user pi, which is TUI mode, not rpc). Never touches the MPA
 * gateway, the local model container, or anything production.
 *
 * Defaults are deliberately generous: a legitimate card turn is bounded by
 * PIBOT_TURN_TIMEOUT_MS (default 600s) in bridge.mjs, so a 30-min hard age
 * cap and a 90s parentless grace cannot kill a healthy in-progress turn.
 */
import { execFileSync, spawnSync } from "node:child_process";

const PI_CLI_MARK = "@mariozechner/pi-coding-agent/dist/cli.js";

export const LIFECYCLE_DEFAULTS = {
  maxPi: Number(process.env.PIBOT_MAX_PI || 2), // global concurrency cap
  orphanGraceSec: Number(process.env.PIBOT_ORPHAN_GRACE_SEC || 90),
  hardAgeSec: Number(process.env.PIBOT_HARD_AGE_SEC || 1800), // 30 min
  rssCeilingKb: Number(process.env.PIBOT_RSS_CEILING_KB || 4194304), // 4 GB
};

/**
 * One ps scan -> the bridge-spawned pi processes.
 * Returns [{ pid, ppid, etimes, rssKb, args }].
 */
export function listBridgePi() {
  let out = "";
  try {
    out = execFileSync(
      "ps",
      ["-eo", "pid=,ppid=,etimes=,rss=,args="],
      { encoding: "utf8", maxBuffer: 8e6 }
    );
  } catch {
    return [];
  }
  const procs = [];
  for (const line of out.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (!s.includes(PI_CLI_MARK)) continue;
    if (!/--mode\s+rpc\b/.test(s)) continue;
    const m = s.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      etimes: Number(m[3]),
      rssKb: Number(m[4]),
      args: m[5],
    });
  }
  return procs;
}

/** Live count of bridge-spawned pi (for the concurrency gate). */
export function countLivePi() {
  return listBridgePi().length;
}

function syslog(msg) {
  try {
    spawnSync("logger", ["-t", "pibot-reaper", msg], { timeout: 5000 });
  } catch {
    /* logger absence must never break the bridge */
  }
}

/**
 * Reap abandoned / stuck / runaway bridge pi.
 * @param {(m:string)=>void} log  optional sink (also goes to syslog)
 * @returns {{scanned:number, reaped:Array<{pid:number,reason:string}>}}
 */
export function reapStalePi(opts = {}) {
  const cfg = Object.assign({}, LIFECYCLE_DEFAULTS, opts);
  const log = opts.log || function () {};
  const procs = listBridgePi();
  const victims = [];
  for (const p of procs) {
    let reason = null;
    if (p.ppid === 1 && p.etimes > cfg.orphanGraceSec) {
      reason = `orphan ppid=1 etime=${p.etimes}s>${cfg.orphanGraceSec}`;
    } else if (p.etimes > cfg.hardAgeSec) {
      reason = `stuck etime=${p.etimes}s>${cfg.hardAgeSec}`;
    } else if (p.rssKb > cfg.rssCeilingKb) {
      reason = `runaway rss=${Math.round(p.rssKb / 1024)}MB>${Math.round(
        cfg.rssCeilingKb / 1024
      )}MB`;
    }
    if (!reason) continue;
    victims.push({ pid: p.pid, reason });
    const m = `REAP pi pid=${p.pid} (${reason})`;
    log(m);
    syslog(m);
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (victims.length) {
    // give SIGTERM a moment, then SIGKILL any survivor in the same sweep
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        execFileSync("sleep", ["0.2"]);
      } catch {
        break;
      }
      if (!victims.some((v) => isAlive(v.pid))) break;
    }
    for (const v of victims) {
      if (isAlive(v.pid)) {
        try {
          process.kill(v.pid, "SIGKILL");
          const m = `SIGKILL pi pid=${v.pid} (survived SIGTERM)`;
          log(m);
          syslog(m);
        } catch {
          /* gone between checks */
        }
      }
    }
  }
  return { scanned: procs.length, reaped: victims };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// CLI: `node pi_lifecycle.mjs reap` (manual sweep) | `node pi_lifecycle.mjs count`
if (import.meta.url === "file://" + process.argv[1]) {
  const cmd = process.argv[2] || "count";
  if (cmd === "reap") {
    const r = reapStalePi({ log: (m) => console.log("[pi-reaper] " + m) });
    console.log(
      `[pi-reaper] scanned=${r.scanned} reaped=${r.reaped.length} ` +
        JSON.stringify(r.reaped)
    );
  } else {
    console.log("LIVE_PI=" + countLivePi());
  }
  process.exit(0);
}
