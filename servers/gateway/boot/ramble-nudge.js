/**
 * boot/ramble-nudge.js — the Ramble evening walk nudge (spec
 * 2026-10-04-ramble-steps-design.md §9).
 *
 * Core, not bundle, because it needs a timer in the long-lived gateway and the
 * gateway's notification fan-out (createNotification -> web push + this
 * instance's ntfy topic). The DECISION lives in the installed bundle's
 * server/steps.js, imported by path so core never hard-depends on a bundle
 * that may be absent or older. Started only where Ramble is INSTALLED.
 *
 * At most one nudge per day per instance by construction: markNudged() writes
 * the replicated `nudge` row BEFORE the send and only the call that created it
 * sends. Nothing here may throw out of the timer.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const NUDGE_TICK_MS = 10 * 60 * 1000;

export function startRambleNudge({
  db,
  serverDir,
  notify,
  emit,
  readLang = async () => "en",
  intervalMs = NUDGE_TICK_MS,
  clock = () => Date.now(),
  load = (dir) => import(pathToFileURL(join(dir, "steps.js")).href),
  autoStart = true,
}) {
  let mod = null;
  let busy = false;
  let warnedLoad = false;
  let timer = null;

  async function tick() {
    if (busy) return { sent: false, reason: "busy" };
    busy = true;
    try {
      if (!mod) {
        try { mod = await load(serverDir); }
        catch (err) {
          // An installed bundle older than 0.14.0 has no steps.js: say so once.
          if (!warnedLoad) { warnedLoad = true; try { console.warn("[ramble] walk nudge: steps module unavailable:", err?.message ?? err); } catch {} }
          return { sent: false, reason: "no-module" };
        }
      }
      const now = clock();
      const d = await mod.nudgeDecision(db, { now });
      if (!d.send) return { sent: false, reason: d.reason };
      if (!(await mod.markNudged(db, d.day, { now, emit }))) return { sent: false, reason: "already" };
      let lang = "en";
      try { lang = (await readLang(db)) || "en"; } catch { lang = "en"; }
      const { title, body } = mod.nudgeText(lang, d.variant || "low");
      await notify(db, {
        title, body, type: "reminder", source: "ramble:steps", priority: "normal",
        action_url: "/dashboard/ramble", expires_in_minutes: 360,
      });
      return { sent: true, reason: "due" };
    } catch (err) {
      try { console.warn("[ramble] walk nudge tick failed:", err?.message ?? err); } catch {}
      return { sent: false, reason: "error" };
    } finally {
      busy = false;
    }
  }

  if (autoStart) {
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
  }
  return {
    tick,
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
