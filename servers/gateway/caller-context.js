/**
 * The per-request caller for loopback tool mounts (and later the owner paths).
 * The mount runs a tool call inside `callerContext.run(caller, ...)`; tool
 * handlers read it back with `currentCaller()` (null outside a request).
 *
 * It is also where "who is calling" becomes "who is the author": the version
 * history's write context (servers/shared/history/write-context.js) is what the
 * DB layer stamps a version row with, and a verified bot caller is the one case on
 * this rail where the caller IS an author. `withCallerContext` opens both, so a
 * write a bot's tool call makes in this process is attributed to that bot rather
 * than to nobody.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { withWriteContext, jobIdFor } from "../shared/history/write-context.js";

export const callerContext = new AsyncLocalStorage();

export function currentCaller() { return callerContext.getStore() || null; }

/**
 * The write context a caller implies, or null.
 *
 *   - a caller with a verified `botId` writes as that bot, with the job its thread
 *     names (`turn:<threadId>`), else no job at all;
 *   - a peer's call has no author here: the peer's instance id is not part of the
 *     caller store, and the sync apply path
 *     (servers/sharing/instance-sync.js) already opens the peer's own context;
 *   - the owner's remote tool call, and a bare token with no identity, name no
 *     author — an anonymous write stays 'unattributed', never 'owner'.
 */
export function writeContextForCaller(caller) {
  if (!caller || typeof caller !== "object" || caller.peer === true) return null;
  const botId = typeof caller.botId === "string" ? caller.botId.trim() : "";
  if (!botId) return null;
  return { authorKind: "bot", authorId: botId, jobId: jobIdFor({ threadId: caller.threadId ?? null }) };
}

/** Run `fn` inside the caller context AND the write context it implies. */
export function withCallerContext(caller, fn) {
  return callerContext.run(caller, () => {
    const ctx = writeContextForCaller(caller);
    return ctx ? withWriteContext(ctx, fn) : fn();
  });
}