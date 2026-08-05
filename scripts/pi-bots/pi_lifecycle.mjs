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
 *
 * C-14 lease exemption: the reaper is host-global (listBridgePi() scans ALL
 * matching processes on the host) but `perch-interactive.js` sessions are
 * per-instance, so instance A's reaper must not kill instance B's leased
 * long-lived child. While >=1 interactive child is awake, the engine writes
 * `<crowHome>/perch-interactive-leases.json` (atomic tmp+rename, refreshed
 * every 60s, `{version:1, leases:{"<pid>":{sessionId, expiresAt}}}` —
 * see writeLeases() in servers/gateway/perch-interactive.js, the shape is
 * duplicated here as LEASE_FILENAME rather than imported to keep this
 * lightweight script free of gateway/db dependencies). A pid in the union
 * of fresh (unexpired) leases across every lease file is exempt from the
 * hardAgeSec rule ONLY — orphan and RSS rules still apply unchanged, so a
 * leased child that's actually wedged or ballooning still gets reaped.
 * Residual assumption: an instance homed entirely outside `~/.crow*` on a
 * shared host must set CROW_HOME in the reaper's own env for its lease file
 * to be found by default (true today for every fleet instance).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

// Must match LEASE_FILENAME in servers/gateway/perch-interactive.js.
const LEASE_FILENAME = "perch-interactive-leases.json";

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

/**
 * Default lease files to consult when the caller doesn't inject its own:
 * a `perch-interactive-leases.json` under every `<homedir()>/.crow*`
 * directory (covers the `~/.crow`, `~/.crow-mpa`, `~/.crow-r4` instances
 * that share this host)
 * plus `<CROW_HOME>/perch-interactive-leases.json` when CROW_HOME points
 * somewhere outside homedir() entirely (scratch/test homes). The two
 * sources fail INDEPENDENTLY (each in its own try/catch): a readdir throw
 * on a missing/unset HOME — exactly the scratch-harness shape the
 * CROW_HOME branch exists for — must not drop a valid CROW_HOME lease
 * file, and nothing here may ever throw into the bridge tick /
 * gateway_runner sweep. The "under homedir" test is boundary-safe
 * (`=== home || startsWith(home + sep)`) so a sibling path like
 * `/home/kh0pp2/.crow` next to `/home/kh0pp` is NOT mistaken for a
 * subpath of home.
 *
 * Seams (test-only, following the reapStalePi opts idiom): `_homedir`
 * (function replacing os.homedir) and `_env` (object replacing
 * process.env).
 */
function defaultLeaseFiles(opts = {}) {
  const files = [];
  let home = null;
  try {
    home = opts._homedir ? opts._homedir() : homedir();
  } catch {
    /* no resolvable home — CROW_HOME source below still applies */
  }
  if (home) {
    try {
      for (const entry of readdirSync(home)) {
        if (entry.startsWith(".crow")) {
          files.push(join(home, entry, LEASE_FILENAME));
        }
      }
    } catch {
      /* HOME unset/nonexistent — fall through to the CROW_HOME source */
    }
  }
  try {
    const env = opts._env || process.env;
    const crowHome = env.CROW_HOME;
    const underHome =
      home != null &&
      typeof crowHome === "string" &&
      (crowHome === home || crowHome.startsWith(home + sep));
    if (crowHome && !underHome) {
      files.push(join(crowHome, LEASE_FILENAME));
    }
  } catch {
    /* never throw into the sweep */
  }
  return files;
}

/**
 * Union the still-fresh (unexpired) leases across every given lease file
 * into a Set<pid>. Missing files, unreadable files, and malformed JSON are
 * all silently excluded — never throws, mirrors "no lease" == today's
 * behavior. A file that declares a version other than 1 is skipped
 * (absent version is tolerated). Shape consumed: `{version:1, leases:{"<pid>":{sessionId,
 * expiresAt}}}` (see writeLeases() in servers/gateway/perch-interactive.js).
 */
export function readFreshLeases(leaseFiles, now) {
  const t = typeof now === "number" ? now : Date.now();
  const fresh = new Set();
  for (const file of leaseFiles || []) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (data && data.version !== undefined && data.version !== 1) continue; // unknown future shape — skip, don't guess
    const leases = (data && data.leases) || {};
    for (const [pidStr, lease] of Object.entries(leases)) {
      if (!lease || typeof lease.expiresAt !== "number") continue;
      if (lease.expiresAt <= t) continue;
      const pid = Number(pidStr);
      if (Number.isInteger(pid)) fresh.add(pid);
    }
  }
  return fresh;
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
  const procs = opts._procs || listBridgePi();
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const leaseFiles = opts.leaseFiles || defaultLeaseFiles(opts);
  const freshLeases = readFreshLeases(leaseFiles, now);
  const kill = opts._kill || ((pid, signal) => process.kill(pid, signal));
  const victims = [];
  for (const p of procs) {
    let reason = null;
    if (p.ppid === 1 && p.etimes > cfg.orphanGraceSec) {
      reason = `orphan ppid=1 etime=${p.etimes}s>${cfg.orphanGraceSec}`;
    } else if (p.etimes > cfg.hardAgeSec && !freshLeases.has(p.pid)) {
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
      kill(p.pid, "SIGTERM");
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
          kill(v.pid, "SIGKILL");
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
