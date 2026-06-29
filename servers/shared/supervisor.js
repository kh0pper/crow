/**
 * Process-supervision detection.
 *
 * Several "apply on change" flows (auto-update, integration add/remove, bundle
 * installs) restart the gateway by simply exiting the process and letting a
 * supervisor start it again. That is only safe when something is actually
 * watching the process.
 *
 * Historically this was gated on `INVOCATION_ID`, which only systemd sets — so
 * on other supervisors (macOS launchd with KeepAlive, Docker restart policies,
 * pm2, etc.) the process never restarted and the change silently failed to
 * apply. Such supervisors can opt in by setting `CROW_SUPERVISED=1`.
 *
 * @returns {boolean} true if exiting the process will trigger a restart.
 */
export function isSupervised() {
  if (process.env.INVOCATION_ID) return true; // systemd
  const v = process.env.CROW_SUPERVISED;
  return v === "1" || v === "true";
}
