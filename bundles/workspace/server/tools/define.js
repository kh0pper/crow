import { handler } from "../result.js";
import { resolveActor } from "../actor.js";
/** Register tool defs; returns the names (the surface test compares them to spec §4). */
export function defineTools(server, ctx, defs) {
  for (const d of defs) {
    // __tool (non-enumerable) lets writeOptsOf find the queue descriptor for queueable tools (K5).
    // __actor (non-enumerable) is who is acting (env, then the request's _meta). Never from the arguments: an
    // enumerable __actor a client sent is dropped first.
    const run = (args, extra) => {
      const a = { ...args }; delete a.__actor;
      return d.run(Object.defineProperties(a, { __tool: { value: d.name }, __actor: { value: resolveActor(process.env, extra) } }), ctx);
    };
    server.tool(d.name, d.description, d.schema, handler(run, { redactWith: () => { try { return ctx.getConfig(); } catch { return null; } } }));
  }
  return defs.map((d) => d.name);
}
