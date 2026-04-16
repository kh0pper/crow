/**
 * Authenticated SSE wrapper.
 *
 * Combines `openStream()` with a periodic session re-check so a user
 * who logs out in another tab (or whose token is otherwise
 * invalidated) sees the open stream close cleanly. The stream emits
 * `event: session-expired` and then ends; the client-side
 * `<turbo-stream-source>` auto-reconnects, the reconnect fails auth,
 * and the Phase 6a auth-boundary interceptor in layout.js forwards
 * the user to /dashboard/login.
 *
 * Rate of re-check: once every 5 min per connection. A user with 5
 * tabs × 4 streams = 20 timers — acceptable. If this ever becomes
 * load-bearing, switch to a single "session health" singleton that
 * all streams subscribe to.
 *
 * Route usage:
 *   import { openAuthedStream } from "../streams/authed-stream.js";
 *   router.get("/dashboard/streams/foo", dashboardAuth, (req, res) => {
 *     const { sendRaw } = openAuthedStream(req, res);
 *     // ... bus.on("foo:changed", ...) etc.
 *   });
 *
 * The caller must have already passed through `dashboardAuth` so
 * `req.dashboardSession` is populated.
 */

import { verifySession } from "../dashboard/auth.js";
import { openStream } from "./sse.js";

const DEFAULT_RECHECK_MS = 5 * 60 * 1000;

export function openAuthedStream(req, res, opts = {}) {
  const token = req.dashboardSession;
  const stream = openStream(res, opts);
  const recheckMs = opts.recheckMs ?? DEFAULT_RECHECK_MS;

  const recheck = setInterval(async () => {
    try {
      const valid = await verifySession(token);
      if (!valid) {
        stream.send("session-expired", { reason: "invalidated" });
        stream.close();
        clearInterval(recheck);
      }
    } catch {
      // Transient DB/IO error — don't kill the stream. Next tick retries.
    }
  }, recheckMs);

  res.on("close", () => clearInterval(recheck));
  res.on("error", () => clearInterval(recheck));

  return stream;
}
