/**
 * Collection-install busy flag.
 *
 * A collection install runs N bundle installs against ONE shared job and ends
 * with ONE deferred gateway restart. Two things would kill it mid-flight:
 *   1. a concurrent single install/uninstall finishing with its own immediate
 *      restart (process exit), and
 *   2. the auto-update tick, which lives in this same process and exits to
 *      trigger a supervised restart.
 * Both consult this flag. It is in-process state (it cannot outlive the gateway,
 * and the set's own restart resets it), with a max-age backstop so a leaked flag
 * can never wedge installs permanently.
 *
 * Co-hosted gateways MUST use distinct CROW_HOME (crow's MPA unit already does):
 * this flag does not coordinate across processes, and two gateways sharing one
 * ~/.crow would race on installed.json regardless.
 */

const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h backstop

let state = null; // { collectionId, startedAt }

/** @throws {Error} if a set is already running */
export function beginInstallSet(collectionId, { startedAt = Date.now() } = {}) {
  if (isInstallSetRunning()) {
    throw new Error(`A collection install is already in progress (${state.collectionId})`);
  }
  state = { collectionId, startedAt };
}

export function endInstallSet() {
  state = null;
}

/** True while a collection install is running (and younger than the backstop). */
export function isInstallSetRunning() {
  if (!state) return false;
  if (Date.now() - state.startedAt > MAX_AGE_MS) {
    state = null;
    return false;
  }
  return true;
}

/** Test-only. */
export function _resetForTest() {
  state = null;
}
