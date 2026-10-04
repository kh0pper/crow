/** Crow Workspace tool result envelope (spec §4.1): {success,data} | {success:false,code,error,data?}. */
export class WsError extends Error {
  constructor(code, message, data) { super(message); this.name = "WsError"; this.code = code; this.data = data; }
}
const block = (obj) => [{ type: "text", text: JSON.stringify(obj) }];
export const ok = (data) => ({ content: block({ success: true, data }) });
export const fail = (code, error, data) => ({ content: block({ success: false, code, error, ...(data !== undefined ? { data } : {}) }), isError: true });

/** Wrap a tool body. Unexpected errors never leak a secret: messages pass through redactWith()'s config. */
export function handler(fn, { redactWith } = {}) {
  return async (args) => {
    try { return ok(await fn(args ?? {})); }
    catch (e) {
      if (e instanceof WsError) return fail(e.code, e.message, e.data);
      let msg = String(e?.message ?? e);
      try { const { redact } = await import("./config.js"); msg = redact(msg, redactWith ? redactWith() : null); } catch { msg = "(details withheld)"; }
      return fail("internal", `Unexpected error: ${e?.name || "Error"}: ${msg}`);
    }
  };
}
