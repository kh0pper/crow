/**
 * Scheduler hooks: how an installed bundle takes part in the gateway's scheduler tick without
 * the gateway importing a bundle file. A bundle's panel-routes module registers once at load;
 * the scheduler calls what is registered. A gateway that never loaded the bundle runs nothing.
 *
 *   tick(db)                      every scheduler tick (keep it cheap; claim daily work in the database)
 *   reminder(db, { type, text })  a scheduled reminder fired; the bundle may also deliver it its own way
 */
const hooks = new Map();

/** Register (or replace) a bundle's hooks. `hook` = { tick?, reminder? }. */
export function registerSchedulerHook(id, hook) {
  if (typeof id !== "string" || !id || !hook || typeof hook !== "object") throw new Error("registerSchedulerHook: id and hook object required");
  hooks.set(id, hook);
}

export function unregisterSchedulerHook(id) { hooks.delete(id); }

/** Call one kind of hook on every registered bundle. A failing hook is logged and never stops the others. */
export async function runSchedulerHooks(kind, ...args) {
  for (const [id, hook] of hooks) {
    if (typeof hook[kind] !== "function") continue;
    try { await hook[kind](...args); }
    catch (err) { console.warn(`[scheduler] ${id} ${kind} hook failed: ${err?.message || err}`); }
  }
}
