/**
 * The mail-send scheduler hook: how Crow Mail's held and scheduled sends ride the gateway's existing
 * 60-second scheduler tick (`servers/gateway/scheduler-hooks.js`) instead of opening a timer of their
 * own.
 *
 * The hook is registered by the mail boot (`boot/mail-boot.js`) once the sync supervisor is running and
 * only when `mailEnabled()` — a gateway that never turned mail on registers nothing, so no tick ever
 * looks at a draft table that may not be there. The tick answers a promise, but a prompt one: the sweep
 * starts each due delivery as a detached promise of its own, so a slow SMTP call can never hold the
 * reminder scheduler.
 *
 * A sweep that throws is caught here, not left to the scheduler: a database client's error text can
 * quote a statement, a path or a bound value, and none of that belongs in a log. The line names the
 * event and a code only, and the next tick tries the sweep again.
 *
 * Unregistering is idempotent and is what shutdown does: the hook closure holds the db client a stop is
 * about to close.
 */
import { registerSchedulerHook, unregisterSchedulerHook } from "../../scheduler-hooks.js";
import { MailError } from "../errors.js";
import { sweepMailSends } from "./schedule-service.js";

/** The one id this hook registers under. */
export const MAIL_SEND_HOOK_ID = "mail-send";

/** The sweep's failure as a code: a MailError's own, or `unknown` for anything else. */
function codeOf(err) {
  return err instanceof MailError ? err.code : "unknown";
}

/**
 * Register the mail-send tick.
 *
 * @param {object} db the gateway's crow.db client
 * @param {object} deps the sweep's seam (the send supervisor's `withAdapter`, the claim wrapper, …)
 * @returns {{unregister: () => void}} the hook's own way out; idempotent
 */
export function registerMailSendHook(db, deps) {
  registerSchedulerHook(MAIL_SEND_HOOK_ID, {
    /** One sweep: its counts on success, null when it failed (the failure is only ever a code). */
    async tick() {
      try {
        return await sweepMailSends(db, deps);
      } catch (err) {
        console.warn(`[mail-schedule] sweep_failed ${codeOf(err)}`);
        return null;
      }
    },
  });
  return {
    unregister() {
      unregisterSchedulerHook(MAIL_SEND_HOOK_ID);
    },
  };
}