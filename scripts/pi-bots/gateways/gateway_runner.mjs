#!/usr/bin/env node
/**
 * Crow Bot Builder — gateway host (Hermes-parity, A3).
 *
 * One long-lived process (pibot-gateways.service, Type=simple) that hosts every
 * REGISTRY host-managed gateway adapter (v1: telegram long-poll + slack socket-
 * mode — both dial OUT, so no inbound port and no Tailscale-Funnel exposure).
 *
 * It does NOT host Gmail (poll, pibot-bridge.timer) or Discord (its own
 * pibot-discord.service); those keep their existing process model in v1. The
 * runner scans pi_bot_defs once, and for each enabled bot's gateways[] entry of
 * a host-managed type, dispatches to the registry adapter's start().
 *
 * SAFETY (review C2): this host runs the OUT-OF-PROCESS reaper reapStalePi() on
 * its own interval, independent of the Gmail tick. Without it, a wedged/detached
 * pi spawned from a turn (or the post-turn skill_review pass) on a Telegram/Slack
 * deployment would have no reaper cadence — a regression vs the current posture.
 *
 * Hot-reload = restart the service (same as discord_gateway.mjs in v1).
 * crow.db opened with busy_timeout only, NO journal_mode pragma (established
 * pattern; pi is spawned by the bridge with CROW_JOURNAL_MODE=DELETE).
 */
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { hostAdapters, getAdapter, isHostManaged } from "./index.mjs";
import { reapStalePi } from "../pi_lifecycle.mjs";

const HOME = "/home/kh0pp";
const CROW_DB = process.env.CROW_DB_PATH || HOME + "/.crow-mpa/data/crow.db";
const REAP_INTERVAL_MS = Number(process.env.PIBOT_REAP_INTERVAL_MS || 60000);

function log(msg) { console.log("[gateways] " + msg); }
function db() { const d = new Database(CROW_DB); d.pragma("busy_timeout = 10000"); return d; }

// All enabled bots with at least one host-managed gateway, flattened to
// {bot_id, gw} jobs (a bot may declare more than one host gateway).
function loadGatewayJobs() {
  const d = db();
  let rows = [];
  try { rows = d.prepare("SELECT bot_id, definition FROM pi_bot_defs WHERE enabled=1").all(); }
  catch { d.close(); return []; }
  d.close();
  const jobs = [];
  for (const row of rows) {
    let def;
    try { def = JSON.parse(row.definition || "{}"); } catch { continue; }
    for (const gw of def.gateways || []) {
      if (gw && isHostManaged(gw.type)) jobs.push({ bot_id: row.bot_id, gw });
    }
  }
  return jobs;
}

const handles = [];   // { stop } for each started adapter
let reaper = null;

async function startAll() {
  const jobs = loadGatewayJobs();
  if (!jobs.length) {
    log("no enabled bots with a host-managed gateway (telegram/slack) — idle "
      + "(service stays up; restart after adding one)");
  }
  // Probe each host adapter's requirements once so a missing optional dep
  // disables only that gateway type, never the whole host.
  const ready = {};
  for (const a of hostAdapters()) {
    try { ready[a.type] = await a.checkRequirements(); }
    catch { ready[a.type] = false; }
    if (!ready[a.type]) log("adapter '" + a.type + "' unavailable (dep/probe failed) — its gateways are skipped");
  }
  for (const job of jobs) {
    const a = getAdapter(job.gw.type);
    if (!a || !ready[a.type]) continue;
    try {
      const h = await a.start({ bot_id: job.bot_id, gw: job.gw, log: (m) => log("[" + a.type + "] " + m) });
      if (h && typeof h.stop === "function") handles.push(h);
    } catch (e) {
      log("start failed type=" + job.gw.type + " bot=" + job.bot_id + ": " + ((e && e.message) || e));
    }
  }
  log("started " + handles.length + " gateway adapter(s) across " + jobs.length + " configured entr(y/ies)");
}

function startReaper() {
  const sweep = () => {
    try {
      const r = reapStalePi({ log: (m) => log("[reaper] " + m) });
      if (r.reaped && r.reaped.length) log("[reaper] reaped " + r.reaped.length + " stale pi (scanned " + r.scanned + ")");
    } catch (e) { log("[reaper] error (non-fatal): " + ((e && e.message) || e)); }
  };
  reaper = setInterval(sweep, REAP_INTERVAL_MS);
  if (reaper.unref) reaper.unref(); // don't keep the loop alive solely for the reaper
  log("out-of-process reaper armed (every " + Math.round(REAP_INTERVAL_MS / 1000) + "s)");
}

async function shutdown() {
  log("SIGTERM — stopping " + handles.length + " adapter(s)");
  if (reaper) { clearInterval(reaper); reaper = null; }
  for (const h of handles) { try { await h.stop(); } catch {} }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

(async function main() {
  startReaper();
  await startAll();
  // Stay alive even with zero adapters so systemd doesn't flap on Restart.
  setInterval(() => {}, 1 << 30);
})();
