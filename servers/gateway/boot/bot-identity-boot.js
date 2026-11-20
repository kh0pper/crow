/**
 * boot/bot-identity-boot.js — the ONE `[containment]` identity-check line every
 * gateway prints per boot (the identity-file containment check, item-70 channel
 * 3).
 *
 * Why this module exists: the wiring used to live inline in post-listen.js,
 * where `const { appRoot } = await import("../auto-update.js")` destructured the
 * checkout as a VALUE — but auto-update.js exports `appRoot()` as a FUNCTION.
 * The check was handed a function where it expected a path, the default tier's
 * hidden-file builder threw ("The \"path\" argument must be of type string.
 * Received function appRoot"), and because the hidden-file list came back empty
 * the check reported EVERY identity file as readable: a false FAIL and a
 * high-priority bell on every install. So:
 *
 *   - the caller passes `appRoot` as a STRING, and this module refuses to hand
 *     the check anything else (a non-string is a "check could not run", never a
 *     set of exposure findings);
 *   - `APP_ROOT` is the one checkout value this module and post-listen's
 *     migration/convergence passes share, computed from this file's own URL
 *     (`servers/gateway/boot/../../../`) instead of re-derived per call site.
 *
 * And the line itself: ONE verdict per gateway, whatever happens —
 * `… : pass`, `… : FAIL (…)`, or `… : check could not run (…)`.
 *
 *   - No sandbox-tier skip exists in this path, and none is added here: it runs
 *     on every gateway and every CROW_PI_SANDBOX value, `contain` included
 *     (tests/bot-identity-guard.test.js pins that the check itself is unchanged
 *     under `contain`). The old wiring could still end a boot with NO line at
 *     all in two ways: its `.catch` printed `[bot-identity] check not run: …` —
 *     a different line than the check's own, so a gateway whose chain rejected
 *     before the verdict (the database handle, crow-home resolution, a guard
 *     module that fails to import) showed no identity-check line — and a chain
 *     that never settled printed nothing, ever. Both are verdicts now: the
 *     failure is folded into the check's own line, and a bounded wait
 *     (IDENTITY_CHECK_TIMEOUT_MS) turns a hung check into the same line rather
 *     than into silence.
 *   - The bell follows the verdict: a FAIL rings the exposure wording, a check
 *     that could not run rings the check-failed wording (bot-identity-notice.js
 *     keys on `couldNotRun`), so a broken check is never announced as "bots can
 *     read Crow's identity file". No bots, no bell, as before.
 *
 * This module imports only node builtins and the wording — the guard AND the
 * bell are imported lazily inside the run, so a missing/broken check module
 * costs its own line and never the gateway's boot. It never throws and it never
 * rejects.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BOT_IDENTITY_TEXT, COULD_NOT_RUN_PREFIX } from "../../../scripts/pi-bots/bot-identity-text.mjs";

/** The repo checkout every boot pass runs against (post-listen reuses it). */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The `[containment]` prefix an operator greps for. */
export const CONTAINMENT_PREFIX = "[containment] ";

/**
 * How long the boot waits for the check before it says the check did not
 * answer. Generous on purpose: the check dry-builds one plan per enabled bot
 * per tier and probes bubblewrap once (the probe itself is bounded at 5 s per
 * invocation), so a real instance answers in seconds. It only exists so a hung
 * check cannot cost the boot its line.
 */
export const IDENTITY_CHECK_TIMEOUT_MS = 2 * 60 * 1000;

/** The reason a result carries, without its own "the check could not run:" prefix. */
function reasonOf(result) {
  const first = (result && Array.isArray(result.findings) ? result.findings : []).filter(Boolean)[0];
  if (!first) return "no reason given";
  const text = String(first);
  return text.startsWith(COULD_NOT_RUN_PREFIX) ? text.slice(COULD_NOT_RUN_PREFIX.length) : text;
}

/**
 * The guard's own could-not-run result when it is there, a local one shaped
 * exactly like it when the guard module could not be loaded at all (then the
 * wording comes from bot-identity-text.mjs, which has no imports of its own).
 */
function couldNotRun(guard, reason) {
  if (guard && typeof guard.couldNotRunResult === "function") return guard.couldNotRunResult(reason);
  const failed = COULD_NOT_RUN_PREFIX + reason;
  return {
    ok: false, couldNotRun: true, text: BOT_IDENTITY_TEXT,
    findings: [failed], tierFindings: [failed], notes: [], checked: 0,
  };
}

/** `promise`, or a rejection when it has not settled within `ms` (never unref'd away). */
function withTimeout(promise, ms) {
  if (!(ms > 0)) return Promise.resolve(promise);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("the check did not answer within " + Math.round(ms / 1000) + " s")),
      ms,
    );
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Run the boot check and print its one line. Never throws, never rejects.
 *
 * @param {object} [o]
 * @param {() => {execute: Function, close?: Function}} [o.dbFactory] the gateway's db client factory
 * @param {string|null} [o.crowHome] this instance's Crow home (the caller resolves it)
 * @param {string} [o.appRoot] the repo checkout, AS A STRING (default APP_ROOT)
 * @param {object} [o.env] the guard's environment (default: the process's own; a
 *   test sets CROW_PI_SANDBOX here)
 * @param {object} [o.log] console-shaped logger ({log, error, warn})
 * @param {Function} [o.guardImport] TEST SEAM: the guard module loader
 * @param {Function} [o.noticeImport] TEST SEAM: the bell module loader
 * @param {number} [o.timeoutMs] TEST SEAM: the bounded wait (default IDENTITY_CHECK_TIMEOUT_MS)
 * @returns {Promise<object>} the check's result (the could-not-run shape when it did not run)
 */
export async function runBotIdentityBootCheck({
  dbFactory = null,
  crowHome = null,
  appRoot = APP_ROOT,
  env = undefined,
  log = console,
  guardImport = () => import("../../../scripts/pi-bots/bot-identity-guard.mjs"),
  noticeImport = () => import("./bot-identity-notice.js"),
  timeoutMs = IDENTITY_CHECK_TIMEOUT_MS,
} = {}) {
  let guard = null;
  let db = null;
  let result = null;
  try {
    guard = await guardImport();
    if (typeof appRoot !== "string") {
      // The exact shape of the production bug this module exists for: a
      // function (auto-update's `appRoot()`) where a path belongs. Never a
      // measurement, never "readable" findings — a check that could not run.
      result = couldNotRun(guard, "appRoot must be a string (got " + typeof appRoot + ")");
    } else {
      if (typeof dbFactory === "function") db = dbFactory();
      result = await withTimeout(
        guard.runBotIdentityCheck({ db, crowHome, appRoot, env }),
        timeoutMs,
      );
      // A check that answers with nothing answered nothing: still a verdict
      // (never a silent boot, never an exposure that was not measured).
      if (!result || typeof result !== "object") result = couldNotRun(guard, "the check returned no result");
    }
  } catch (err) {
    const why = (err && err.message) ? err.message : String(err);
    result = couldNotRun(guard, why);
  }

  // ONE verdict line, whatever the answer was.
  let line = null;
  try {
    line = (guard && typeof guard.formatBotIdentityLine === "function")
      ? guard.formatBotIdentityLine(result)
      : null;
  } catch (err) {
    // A formatter that cannot format must not cost the boot its line.
    line = null;
    if (!result || result.ok !== false) result = couldNotRun(guard, (err && err.message) ? err.message : String(err));
  }
  if (!line) {
    line = CONTAINMENT_PREFIX + BOT_IDENTITY_TEXT + ": check could not run (" + reasonOf(result) + ")";
  }
  try {
    if (result && result.ok === true) log.log(line);
    else log.error(line);
    for (const note of (result && Array.isArray(result.notes) ? result.notes : [])) {
      log.log(CONTAINMENT_PREFIX + note);
    }
  } catch {
    /* a logger that throws must not fail the boot, and the line was already attempted */
  }

  // The bell: exposure wording for a FAIL, check-failed wording for a check that
  // could not run (the notice keys on `couldNotRun`). A pass and "no bots" ring
  // nothing (the notice decides that itself).
  if (result && result.ok !== true) {
    try {
      const { notifyBotIdentityFailure } = await noticeImport();
      await notifyBotIdentityFailure({ db, result });
    } catch (err) {
      try { log.warn("[bot-identity] notice skipped: " + ((err && err.message) ? err.message : String(err))); } catch {}
    }
  }

  try { db?.close?.(); } catch {}
  return result;
}