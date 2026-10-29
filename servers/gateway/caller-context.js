/**
 * The per-request caller for loopback tool mounts (and later the owner paths).
 * The mount runs a tool call inside `callerContext.run(caller, ...)`; tool
 * handlers read it back with `currentCaller()` (null outside a request).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const callerContext = new AsyncLocalStorage();

export function currentCaller() { return callerContext.getStore() || null; }
