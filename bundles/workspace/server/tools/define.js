import { handler } from "../result.js";
/** Register tool defs; returns the names (the surface test compares them to spec §4). */
export function defineTools(server, ctx, defs) {
  for (const d of defs) {
    // __tool (non-enumerable) lets writeOptsOf find the queue descriptor for queueable tools (K5).
    server.tool(d.name, d.description, d.schema, handler((args) => d.run(Object.defineProperty({ ...args }, "__tool", { value: d.name }), ctx), { redactWith: () => { try { return ctx.getConfig(); } catch { return null; } } }));
  }
  return defs.map((d) => d.name);
}
