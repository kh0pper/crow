/**
 * In-process event bus for Turbo Streams and other intra-gateway
 * pub/sub. Each gateway process (crow-gateway on 3002,
 * crow-finance-gateway on 3003) runs its own Node instance and
 * therefore its own bus. Cross-process and cross-instance propagation
 * is NOT provided here — use InstanceSyncManager for cross-instance
 * events.
 *
 * ## Emit discipline
 *
 * `EventEmitter.emit` is SYNCHRONOUS and re-throws unhandled
 * subscriber errors. Every emit site MUST wrap in try/catch so a
 * misbehaving subscriber cannot break the primary DB write or tool
 * handler:
 *
 *   try { bus.emit("foo:changed", { ... }); } catch {}
 *
 * Every subscriber handler MUST defend against its own exceptions;
 * otherwise one slow/broken subscriber blocks (or crashes) siblings.
 *
 * ## Max listeners
 *
 * Node caps per-event-name listeners at 10 by default. With 5 stream
 * routes and N tabs, a given event name sees ≤ N listeners (one per
 * active SSE connection). 200 is comfortable headroom for any
 * realistic deployment.
 */

import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(200);

export default bus;
