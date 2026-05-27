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

// Package was renamed from @mariozechner/pi-coding-agent to
// @earendil-works/pi-coding-agent. countLivePi() greps process command lines
// for this marker — getting it wrong means the concurrency gate always reads
// 0 live pi processes and could fan out unbounded.
const PI_CLI_MARK = "@earendil-works/pi-coding-agent/dist/cli.js";

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

// MCP child markers. Matches the per-bot servers the bridge config wires up.
// Path fragments are deliberately specific (full venv / bundle path) so this
// can never match someone's interactive Claude Code MCP, an unrelated
// google-workspace install, or a global npx mcp-server-* run.
const MCP_DESCENDANT_MARKERS = [
  "spring-2026/google-workspace-mcp/.venv/bin/google-workspace-mcp",
  "/.crow-mpa/bundles/bots-sql-mcp/server",
  "/.crow/bundles/bots-sql-mcp/server",
  "/.npm/_npx/be9bcbed6978f068/node_modules/.bin/mcp-server-brave-search",
  "/.npm/_npx/3dfbf5a9eea4a1b3/node_modules/.bin/mcp-server-github",
];

/**
 * Reap leaked MCP servers — children of a dead pi.
 *
 * Each bot pi spawns 4-5 MCP servers (brave-search, github, google-workspace,
 * crow-bots-sql). bridge.mjs::PiRpc.close() now SIGTERMs the whole pgroup so
 * these die cleanly on normal exit. This is the backstop: if pi gets
 * OOM-killed or systemd SIGKILLs it past TimeoutStartSec, MCPs orphan to
 * systemd's subreaper (PID 1 or a slice supervisor) and keep running, holding
 * ~80-100MB each. Over hours these accumulate into GBs of phantom RSS.
 *
 * Safe identification rule: process matches an MCP marker path AND its parent
 * is either (a) no longer alive or (b) not a live bridge pi. Live MCP children
 * of a healthy in-progress turn are never touched because their parent IS a
 * live pi (or a live npx/sh shim under one — we check ancestry one hop deep
 * for shims).
 */
export function reapLeakedMcp(opts = {}) {
  const cfg = Object.assign({}, LIFECYCLE_DEFAULTS, opts);
  const minAgeSec = Number(opts.minMcpAgeSec || cfg.orphanGraceSec);
  const log = opts.log || function () {};

  // Live pi pids are sacred — never reap an MCP child of one of these.
  const livePiPids = new Set(listBridgePi().map((p) => p.pid));

  // Scan all processes once.
  let out = "";
  try {
    out = execFileSync(
      "ps",
      ["-eo", "pid=,ppid=,etimes=,args="],
      { encoding: "utf8", maxBuffer: 8e6 }
    );
  } catch {
    return { scanned: 0, reaped: [] };
  }

  // Build pid -> ppid map for ancestor walk (cheap, one pass).
  const ppidOf = new Map();
  const argsOf = new Map();
  const etimeOf = new Map();
  for (const line of out.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    ppidOf.set(pid, Number(m[2]));
    etimeOf.set(pid, Number(m[3]));
    argsOf.set(pid, m[4]);
  }

  // Returns true if any ancestor (within 4 hops) is in livePiPids.
  function hasLivePiAncestor(pid) {
    let cur = ppidOf.get(pid);
    for (let i = 0; i < 4 && cur && cur !== 1; i++) {
      if (livePiPids.has(cur)) return true;
      cur = ppidOf.get(cur);
    }
    return false;
  }

  const candidates = [];
  for (const [pid, args] of argsOf) {
    if (!MCP_DESCENDANT_MARKERS.some((mark) => args.includes(mark))) continue;
    candidates.push({ pid, args, etimes: etimeOf.get(pid), ppid: ppidOf.get(pid) });
  }

  const victims = [];
  for (const c of candidates) {
    if (c.etimes < minAgeSec) continue;
    if (hasLivePiAncestor(c.pid)) continue;
    victims.push({
      pid: c.pid,
      reason: `mcp-leak ppid=${c.ppid} etime=${c.etimes}s>${minAgeSec}`,
    });
    const msg = `REAP mcp pid=${c.pid} (mcp-leak ppid=${c.ppid} etime=${c.etimes}s)`;
    log(msg);
    syslog(msg);
    try {
      process.kill(c.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (victims.length) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { execFileSync("sleep", ["0.2"]); } catch { break; }
      if (!victims.some((v) => isAlive(v.pid))) break;
    }
    for (const v of victims) {
      if (isAlive(v.pid)) {
        try {
          process.kill(v.pid, "SIGKILL");
          const m = `SIGKILL mcp pid=${v.pid} (survived SIGTERM)`;
          log(m);
          syslog(m);
        } catch {
          /* gone between checks */
        }
      }
    }
  }
  return { scanned: candidates.length, reaped: victims };
}

// CLI: `node pi_lifecycle.mjs reap` (manual sweep) | `node pi_lifecycle.mjs count` | `reap-mcp`
if (import.meta.url === "file://" + process.argv[1]) {
  const cmd = process.argv[2] || "count";
  if (cmd === "reap") {
    const r = reapStalePi({ log: (m) => console.log("[pi-reaper] " + m) });
    console.log(
      `[pi-reaper] scanned=${r.scanned} reaped=${r.reaped.length} ` +
        JSON.stringify(r.reaped)
    );
  } else if (cmd === "reap-mcp") {
    const r = reapLeakedMcp({ log: (m) => console.log("[mcp-reaper] " + m) });
    console.log(
      `[mcp-reaper] scanned=${r.scanned} reaped=${r.reaped.length} ` +
        JSON.stringify(r.reaped)
    );
  } else {
    console.log("LIVE_PI=" + countLivePi());
  }
  process.exit(0);
}
